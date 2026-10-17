import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';

// Same approach as enqueueJob.test.js: seed the require cache with fakes so
// worker.js picks them up. bullmq is NOT faked, so UnrecoverableError is the
// real class BullMQ checks for.
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');
const { UnrecoverableError } = require('bullmq');

function stubModule(id, exports) {
  const key = require.resolve(id);
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
}

const fakes = {
  axiosGet: vi.fn(),
  sharpToBuffer: vi.fn(),
  sharpOptions: undefined, // options passed to sharp(input, options)
  uploadResult: null, // { error, result } for cloudinary.upload_stream
  updates: [], // calls to Job.findOneAndUpdate
};

// sharp(buf, opts).resize(...).jpeg(...).toBuffer()
function fakeSharp(input, opts) {
  fakes.sharpOptions = opts;
  const chain = { resize: () => chain, jpeg: () => chain, toBuffer: () => fakes.sharpToBuffer() };
  return chain;
}

const fakeCloudinary = {
  v2: {
    config: () => {},
    uploader: {
      upload_stream: (opts, cb) => ({
        end: () => cb(fakes.uploadResult.error, fakes.uploadResult.result),
      }),
    },
  },
};

const fakeJobModel = {
  async findOneAndUpdate(filter, update) {
    fakes.updates.push({ filter, update });
    return {};
  },
};

let worker;

beforeAll(() => {
  stubModule('axios', { get: (...args) => fakes.axiosGet(...args) });
  stubModule('sharp', fakeSharp);
  stubModule('cloudinary', fakeCloudinary);
  stubModule('mongoose', { connect: () => Promise.resolve() });
  stubModule(path.join(root, 'models.js'), fakeJobModel);
  worker = require(path.join(root, 'worker.js'));
});

beforeEach(() => {
  fakes.axiosGet.mockReset();
  fakes.sharpToBuffer.mockReset();
  fakes.updates = [];
  fakes.uploadResult = { error: null, result: { secure_url: 'https://cdn/r.jpg', bytes: 2048 } };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function bullJob(data = {}, extra = {}) {
  return {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    data: { imageUrl: 'https://img.example/a.jpg', width: 100, height: 100, ...data },
    opts: { attempts: 3 },
    attemptsMade: 0,
    ...extra,
  };
}

function imageResponse(contentType = 'image/jpeg') {
  return { status: 200, headers: { 'content-type': contentType }, data: Buffer.from('fake') };
}

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

describe('handleFailed: Mongo is marked failed only on the final attempt', () => {
  it('does not touch Mongo when BullMQ will retry', async () => {
    // attemptsMade is already incremented when BullMQ emits 'failed'.
    await worker.handleFailed(bullJob({}, { attemptsMade: 1 }), new Error('ECONNRESET'));
    expect(fakes.updates).toHaveLength(0);
  });

  it('marks failed after the last attempt', async () => {
    await worker.handleFailed(bullJob({}, { attemptsMade: 3 }), new Error('ECONNRESET'));
    expect(fakes.updates).toEqual([
      { filter: { bullJobId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, update: { status: 'failed', error: 'ECONNRESET' } },
    ]);
  });

  it('marks failed on the first attempt for an UnrecoverableError', async () => {
    await worker.handleFailed(bullJob({}, { attemptsMade: 1 }), new UnrecoverableError('not an image'));
    expect(fakes.updates[0].update).toEqual({ status: 'failed', error: 'not an image' });
  });

  it('treats a job without an attempts option as single-attempt', async () => {
    await worker.handleFailed(bullJob({}, { opts: {}, attemptsMade: 1 }), new Error('boom'));
    expect(fakes.updates).toHaveLength(1);
  });

  it('ignores a failed event that carries no job', async () => {
    await expect(worker.handleFailed(undefined, new Error('stalled'))).resolves.toBeUndefined();
    expect(fakes.updates).toHaveLength(0);
  });
});

describe('processJob: permanent errors are unrecoverable, transient ones are retried', () => {
  it('completes, writes the result to Mongo and returns it for BullMQ', async () => {
    fakes.axiosGet.mockResolvedValue(imageResponse());
    fakes.sharpToBuffer.mockResolvedValue(Buffer.from('small'));

    const result = await worker.processJob(bullJob());

    expect(result).toEqual({ imageUrl: 'https://cdn/r.jpg', sizeKB: 2 });
    expect(fakes.updates.map((u) => u.update.status)).toEqual(['processing', 'completed']);
    expect(fakes.updates[1].update.result).toEqual(result);
  });

  it('rejects a missing imageUrl as unrecoverable', async () => {
    await expect(worker.processJob(bullJob({ imageUrl: undefined }))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fakes.axiosGet).not.toHaveBeenCalled();
  });

  it('rejects a non-image response as unrecoverable', async () => {
    fakes.axiosGet.mockResolvedValue(imageResponse('text/html'));
    await expect(worker.processJob(bullJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('rejects a corrupt image as unrecoverable', async () => {
    fakes.axiosGet.mockResolvedValue(imageResponse());
    fakes.sharpToBuffer.mockRejectedValue(new Error('Input buffer contains unsupported image format'));
    await expect(worker.processJob(bullJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it.each([400, 403, 404, 410])('rejects HTTP %i from the image host as unrecoverable', async (status) => {
    fakes.axiosGet.mockRejectedValue(httpError(status));
    await expect(worker.processJob(bullJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it.each([
    ['HTTP 503', httpError(503)],
    ['HTTP 429', httpError(429)],
    ['HTTP 408', httpError(408)],
    ['a network error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ])('retries after %s', async (_label, err) => {
    fakes.axiosGet.mockRejectedValue(err);
    const rejection = worker.processJob(bullJob());
    await expect(rejection).rejects.toThrow(/Could not download/);
    await expect(rejection).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it('retries when the Cloudinary upload fails', async () => {
    fakes.axiosGet.mockResolvedValue(imageResponse());
    fakes.sharpToBuffer.mockResolvedValue(Buffer.from('small'));
    fakes.uploadResult = { error: new Error('Cloudinary 500'), result: null };

    const rejection = worker.processJob(bullJob());
    // Retried (not unrecoverable), but the stored message is the generic one:
    // a raw library error is not something to show the user.
    await expect(rejection).rejects.toThrow(worker.GENERIC_FAILURE);
    await expect(rejection).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it('never exposes an unexpected error message, but logs it', async () => {
    fakes.axiosGet.mockResolvedValue(imageResponse());
    fakes.sharpToBuffer.mockResolvedValue(Buffer.from('small'));
    fakes.uploadResult = { error: new Error('connect ECONNREFUSED 10.0.3.7:443 (internal)'), result: null };

    const err = await worker.processJob(bullJob()).catch((e) => e);
    expect(err.message).toBe(worker.GENERIC_FAILURE);
    expect(err.message).not.toMatch(/10\.0\.3\.7|ECONNREFUSED/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unexpected error'), expect.any(Error));
  });

  it('keeps the specific message for a retryable download failure', async () => {
    fakes.axiosGet.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const err = await worker.processJob(bullJob()).catch((e) => e);
    expect(err).toBeInstanceOf(worker.UserFacingError);
    expect(err.message).toMatch(/Could not download the image \(ECONNRESET\)/);
  });
});

describe('processJob: input safety', () => {
  it.each([
    ['width 0', { width: 0 }],
    ['width 4001', { width: 4001 }],
    ['a file: URL', { imageUrl: 'file:///etc/passwd' }],
  ])('rejects job data with %s as unrecoverable', async (_label, data) => {
    await expect(worker.processJob(bullJob(data))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fakes.axiosGet).not.toHaveBeenCalled();
  });

  it('refuses an internal address without downloading it', async () => {
    const rejection = worker.processJob(bullJob({ imageUrl: 'http://169.254.169.254/latest/meta-data/' }));
    await expect(rejection).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(rejection).rejects.toThrow(/private or internal network address/);
    // The resolved/internal address must not be echoed back to the user.
    await expect(rejection).rejects.not.toThrow(/169\.254/);
    expect(fakes.axiosGet).not.toHaveBeenCalled();
  });

  it('downloads through the guarded fetch (size cap, manual redirects)', async () => {
    fakes.axiosGet.mockResolvedValue(imageResponse());
    fakes.sharpToBuffer.mockResolvedValue(Buffer.from('small'));

    await worker.processJob(bullJob());

    expect(fakes.axiosGet.mock.calls[0][1]).toMatchObject({ maxContentLength: 15 * 1024 * 1024, maxRedirects: 0 });
  });

  it('treats an image over the size cap as unrecoverable', async () => {
    fakes.axiosGet.mockRejectedValue(
      Object.assign(new Error('maxContentLength size of 15728640 exceeded'), { code: 'ERR_BAD_RESPONSE' })
    );
    const rejection = worker.processJob(bullJob());
    await expect(rejection).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(rejection).rejects.toThrow(/15MB/);
  });

  it('decodes with a pixel limit (decompression-bomb guard)', async () => {
    fakes.axiosGet.mockResolvedValue(imageResponse());
    fakes.sharpToBuffer.mockResolvedValue(Buffer.from('small'));

    await worker.processJob(bullJob());

    expect(fakes.sharpOptions).toEqual({ limitInputPixels: worker.MAX_INPUT_PIXELS });
    expect(worker.MAX_INPUT_PIXELS).toBeLessThan(268402689); // tighter than sharp's default
  });
});

describe('registerShutdown', () => {
  function setup({ closeError } = {}) {
    const proc = new EventEmitter();
    const order = [];
    let finishClose;
    const fakeWorker = {
      close: vi.fn(
        () =>
          new Promise((resolve, reject) => {
            order.push('close-started');
            finishClose = () => {
              order.push('close-finished');
              closeError ? reject(closeError) : resolve();
            };
          })
      ),
    };
    const exit = vi.fn((code) => order.push(`exit(${code})`));
    worker.registerShutdown(fakeWorker, { proc, exit });
    return { proc, fakeWorker, exit, order, finish: () => finishClose() };
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it.each(['SIGTERM', 'SIGINT'])('on %s, waits for worker.close() before exiting 0', async (signal) => {
    const { proc, exit, order, finish } = setup();

    proc.emit(signal);
    await flush();
    expect(exit).not.toHaveBeenCalled(); // active jobs are still finishing

    finish();
    await flush();
    expect(order).toEqual(['close-started', 'close-finished', 'exit(0)']);
  });

  it('closes only once when signals repeat', async () => {
    const { proc, fakeWorker, finish } = setup();

    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    finish();
    await flush();

    expect(fakeWorker.close).toHaveBeenCalledTimes(1);
  });

  it('exits 1 if close fails', async () => {
    const { proc, exit, finish } = setup({ closeError: new Error('redis gone') });

    proc.emit('SIGTERM');
    finish();
    await flush();

    expect(exit).toHaveBeenCalledWith(1);
  });
});
