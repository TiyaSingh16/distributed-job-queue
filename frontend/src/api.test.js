import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  requestJson,
  describeHttpError,
  describeValidationErrors,
  validateSubmission,
  ApiError,
} from './api.js';

function response(status, body, { json = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: json ? async () => body : async () => { throw new SyntaxError('Unexpected token <'); },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('requestJson', () => {
  it('returns the parsed body on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(202, { jobId: 'abc' }));
    await expect(requestJson('/jobs', {}, { fetchImpl })).resolves.toEqual({ jobId: 'abc' });
  });

  it('turns a network failure into a readable message, keeping the cause for debugging', async () => {
    const cause = new TypeError('Failed to fetch');
    const fetchImpl = vi.fn().mockRejectedValue(cause);
    const err = await requestJson('/jobs', {}, { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.userMessage).toMatch(/Could not reach the server/);
    expect(err.userMessage).not.toMatch(/Failed to fetch/);
    expect(err.cause).toBe(cause);
  });

  it('handles an HTML error page from the hosting proxy (non-JSON 502)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(502, null, { json: false }));
    const err = await requestJson('/jobs', {}, { fetchImpl }).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.userMessage).toMatch(/temporarily unavailable/);
  });

  it('words validation errors per field instead of showing zod messages', async () => {
    const body = {
      message: 'Invalid job',
      errors: [{ path: 'payload.width', message: 'Too big: expected number to be <=4000' }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(response(400, body));
    const err = await requestJson('/jobs', {}, { fetchImpl }).catch((e) => e);
    expect(err.userMessage).toBe('Width must be a whole number between 1 and 4000.');
  });

  it('rejects a 2xx response without a JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, null, { json: false }));
    const err = await requestJson('/jobs', {}, { fetchImpl, fallback: 'Could not load.' }).catch((e) => e);
    expect(err.userMessage).toBe('Could not load.');
  });
});

describe('describeHttpError', () => {
  it.each([
    [413, { message: 'The image is larger than the 10 MB upload limit.' }, /10 MB/],
    [429, null, /Too many requests/],
    [503, null, /temporarily unavailable/],
    [500, { message: 'TypeError: cannot read properties of undefined' }, /went wrong on the server/],
    [404, { message: 'Job not found' }, /Job not found/],
  ])('status %i', (status, body, expected) => {
    expect(describeHttpError(status, body, 'fallback')).toMatch(expected);
  });

  it('never passes through a 5xx body message, which may be technical', () => {
    expect(describeHttpError(500, { message: 'ECONNREFUSED 10.0.0.1' }, 'x')).not.toMatch(/ECONNREFUSED/);
  });
});

describe('describeValidationErrors', () => {
  it('deduplicates and combines field messages', () => {
    const msg = describeValidationErrors([
      { path: 'payload.imageUrl', message: 'Invalid URL' },
      { path: 'payload.imageUrl', message: 'Invalid URL' },
      { path: 'height', message: 'x' },
    ]);
    expect(msg).toBe(
      'Enter a valid image URL that starts with http:// or https://. Height must be a whole number between 1 and 4000.'
    );
  });

  it('returns null for an empty list', () => {
    expect(describeValidationErrors([])).toBeNull();
  });
});

describe('validateSubmission', () => {
  const ok = { mode: 'url', imageUrl: 'https://example.com/a.jpg', width: 300, height: 200 };

  it('accepts a valid URL submission', () => {
    expect(validateSubmission(ok)).toBeNull();
  });

  it.each([
    [{ imageUrl: '' }, /Enter an image URL/],
    [{ imageUrl: 'not a url' }, /valid image URL/],
    [{ imageUrl: 'ftp://example.com/a.jpg' }, /valid image URL/],
    [{ width: '' }, /Width/],
    [{ width: 0 }, /Width/],
    [{ height: 4001 }, /Height/],
    [{ height: 12.5 }, /Height/],
  ])('rejects %o', (override, expected) => {
    expect(validateSubmission({ ...ok, ...override })).toMatch(expected);
  });

  it('requires an image file in upload mode', () => {
    expect(validateSubmission({ ...ok, mode: 'file', imageFile: null })).toMatch(/Choose an image/);
    expect(validateSubmission({ ...ok, mode: 'file', imageFile: { type: 'application/pdf' } })).toMatch(/not an image/);
    expect(validateSubmission({ ...ok, mode: 'file', imageFile: { type: 'image/png' } })).toBeNull();
  });
});
