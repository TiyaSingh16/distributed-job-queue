import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

// Every error the API returns must be JSON with a user-readable `message`,
// never Express's default HTML page (which includes a stack trace outside
// production). Same require-cache stubbing technique as api-validation.test.js.
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');

function stubModule(id, exports) {
  const key = require.resolve(id);
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
}

class ObjectId {
  toString() {
    return 'a'.repeat(24);
  }
}

const state = { findOne: async () => null };
const fakeJobModel = {
  create: async (fields) => fields,
  findOne: (...args) => state.findOne(...args),
};
class FakeQueue {
  async add() {}
}
const fakeCloudinary = {
  v2: {
    config: () => {},
    uploader: { upload_stream: (opts, cb) => ({ end: () => cb(null, { secure_url: 'https://x/y.jpg' }) }) },
  },
};

let server;
let baseUrl;

beforeAll(async () => {
  stubModule('mongoose', { connect: () => Promise.resolve(), Types: { ObjectId } });
  stubModule('bullmq', { Queue: FakeQueue });
  stubModule('cloudinary', fakeCloudinary);
  stubModule(path.join(root, 'models.js'), fakeJobModel);
  const { app } = require(path.join(root, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  state.findOne = async () => null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

async function expectJsonError(res, status, messagePattern) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toMatch(/application\/json/);
  const body = await res.json();
  expect(body.message).toMatch(messagePattern);
  expect(JSON.stringify(body)).not.toMatch(/at .+\.js:\d+/); // no stack frames
  return body;
}

describe('API error responses', () => {
  it('answers malformed JSON with a 400 JSON error, not an HTML page', async () => {
    const res = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"type": "resize-image", ',
    });
    await expectJsonError(res, 400, /valid JSON/);
  });

  it('answers an oversized upload with 413', async () => {
    const form = new FormData();
    form.append('image', new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)]), 'big.jpg');
    const res = await fetch(`${baseUrl}/jobs/upload`, { method: 'POST', body: form });
    await expectJsonError(res, 413, /10 MB/);
  });

  it('answers an unexpected upload field with 400', async () => {
    const form = new FormData();
    form.append('photo', new Blob([Buffer.from('x')]), 'a.jpg');
    const res = await fetch(`${baseUrl}/jobs/upload`, { method: 'POST', body: form });
    await expectJsonError(res, 400, /"image" field/);
  });

  it('answers a database failure on job lookup with a generic 500 and logs the cause', async () => {
    state.findOne = async () => {
      throw new Error('MongoNetworkError: connection to 10.1.2.3 closed');
    };
    const res = await fetch(`${baseUrl}/jobs/abc`);
    const body = await expectJsonError(res, 500, /Failed to fetch job status/);
    expect(body.message).not.toMatch(/Mongo|10\.1\.2\.3/);
    expect(console.error).toHaveBeenCalled();
  });

  it('answers an unknown route with a 404 JSON error', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    await expectJsonError(res, 404, /Not found/);
  });

  it('serves a dependency-free health check', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
