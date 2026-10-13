import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

// Drives the real Express app over HTTP, with Mongo, BullMQ and Cloudinary
// replaced in the require cache (see enqueueJob.test.js for the technique).
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');

function stubModule(id, exports) {
  const key = require.resolve(id);
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
}

let nextId = 1;
class ObjectId {
  constructor() {
    this.hex = (nextId++).toString(16).padStart(24, 'a');
  }
  toString() {
    return this.hex;
  }
}

const state = { docs: [], added: [], cloudinaryUploads: 0 };

const fakeJobModel = {
  async create(fields) {
    state.docs.push(fields);
    return fields;
  },
};

class FakeQueue {
  async add(name, data, opts) {
    state.added.push({ name, data, opts });
  }
}

const fakeCloudinary = {
  v2: {
    config: () => {},
    uploader: {
      upload_stream: (opts, cb) => ({
        end: () => {
          state.cloudinaryUploads++;
          cb(null, { secure_url: 'https://res.cloudinary.com/demo/original.jpg' });
        },
      }),
    },
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
  state.docs = [];
  state.added = [];
  state.cloudinaryUploads = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function postJson(body) {
  return fetch(`${baseUrl}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postUpload(fields, withFile = true) {
  const form = new FormData();
  if (withFile) form.append('image', new Blob([Buffer.from('fake')], { type: 'image/jpeg' }), 'a.jpg');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return fetch(`${baseUrl}/jobs/upload`, { method: 'POST', body: form });
}

const validPayload = { imageUrl: 'https://img.example/a.jpg', width: 200, height: 150 };

describe('POST /jobs validation', () => {
  it('accepts a valid job and stores exactly the validated payload', async () => {
    const res = await postJson({ type: 'resize-image', payload: { ...validPayload, extra: 'dropped' } });

    expect(res.status).toBe(202);
    expect(state.docs[0].payload).toEqual(validPayload);
    expect(state.added[0].data).toEqual(validPayload);
  });

  it('defaults type to resize-image and width/height to 300', async () => {
    const res = await postJson({ payload: { imageUrl: 'http://img.example/a.jpg' } });

    expect(res.status).toBe(202);
    expect(state.docs[0].type).toBe('resize-image');
    expect(state.docs[0].payload).toEqual({ imageUrl: 'http://img.example/a.jpg', width: 300, height: 300 });
  });

  it.each([
    ['no payload', {}],
    ['missing imageUrl', { payload: { width: 10 } }],
    ['a file: URL', { payload: { imageUrl: 'file:///etc/passwd' } }],
    ['an ftp: URL', { payload: { imageUrl: 'ftp://img.example/a.jpg' } }],
    ['a javascript: URL', { payload: { imageUrl: 'javascript:alert(1)' } }],
    ['a non-URL', { payload: { imageUrl: 'not a url' } }],
    ['width 0', { payload: { ...validPayload, width: 0 } }],
    ['width 4001', { payload: { ...validPayload, width: 4001 } }],
    ['fractional height', { payload: { ...validPayload, height: 10.5 } }],
    ['width as a string', { payload: { ...validPayload, width: '200' } }],
    ['an unknown type', { type: 'delete-everything', payload: validPayload }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const res = await postJson(body);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.message).toBe('Invalid job');
    expect(json.errors.length).toBeGreaterThan(0);
    expect(state.docs).toHaveLength(0);
    expect(state.added).toHaveLength(0);
  });
});

describe('POST /jobs/upload validation', () => {
  it('accepts numeric form fields and stores them as integers', async () => {
    const res = await postUpload({ width: '200', height: '4000' });

    expect(res.status).toBe(202);
    expect(state.docs[0].payload).toEqual({
      imageUrl: 'https://res.cloudinary.com/demo/original.jpg',
      width: 200,
      height: 4000,
    });
  });

  it('defaults missing width/height to 300', async () => {
    const res = await postUpload({});

    expect(res.status).toBe(202);
    expect(state.docs[0].payload).toMatchObject({ width: 300, height: 300 });
  });

  it.each([
    ['non-numeric width', { width: 'abc', height: '100' }],
    ['width 0', { width: '0', height: '100' }],
    ['height 4001', { width: '100', height: '4001' }],
    ['hex width', { width: '0x10', height: '100' }],
    ['exponent width', { width: '1e3', height: '100' }],
    ['empty width', { width: '', height: '100' }],
  ])('rejects %s with 400 before uploading to Cloudinary', async (_label, fields) => {
    const res = await postUpload(fields);

    expect(res.status).toBe(400);
    expect(state.cloudinaryUploads).toBe(0);
    expect(state.docs).toHaveLength(0);
  });

  it('still rejects a request with no file', async () => {
    const res = await postUpload({ width: '100', height: '100' }, false);
    expect(res.status).toBe(400);
  });
});
