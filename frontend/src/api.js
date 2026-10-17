// All HTTP calls from the UI go through this module, so that every failure
// reaches the user as one readable sentence and never as a raw status code,
// an HTML error page, or a JavaScript exception message. Technical details
// are kept for debugging in the browser console.

// The deployed API. Override at build time with VITE_API_URL (for local
// development: VITE_API_URL=http://localhost:3000).
export const API_BASE = (import.meta.env?.VITE_API_URL || 'https://api-server-tyjz.onrender.com').replace(/\/+$/, '');

export const MIN_DIMENSION = 1;
export const MAX_DIMENSION = 4000;

export class ApiError extends Error {
  constructor(userMessage, { status = null, cause } = {}) {
    super(userMessage);
    this.name = 'ApiError';
    this.userMessage = userMessage;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

const NETWORK_MESSAGE =
  'Could not reach the server. Check your internet connection. The server may also be starting up after being idle, which can take up to a minute. Please try again shortly.';

const UNAVAILABLE_MESSAGE =
  'The server is temporarily unavailable (it may be starting up after being idle). Please try again in about a minute.';

// Validation errors come back as { errors: [{ path: 'payload.width', message }] }.
// Zod's own messages ("Too big: expected number to be <=4000") are written for
// developers, so the UI words them per field instead.
const FIELD_MESSAGES = {
  imageUrl: 'Enter a valid image URL that starts with http:// or https://.',
  width: `Width must be a whole number between ${MIN_DIMENSION} and ${MAX_DIMENSION}.`,
  height: `Height must be a whole number between ${MIN_DIMENSION} and ${MAX_DIMENSION}.`,
  type: 'This job type is not supported.',
};

export function describeValidationErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const messages = errors.map((e) => {
    const field = String(e?.path ?? '').split('.').pop();
    return FIELD_MESSAGES[field] || 'Some of the submitted values are invalid.';
  });
  return [...new Set(messages)].join(' ');
}

// Turns a non-2xx response into a user-facing sentence. `body` is the parsed
// JSON body, or null when the server answered with something else (for
// example the HTML page a hosting proxy returns while the app is waking up).
export function describeHttpError(status, body, fallback) {
  if (status === 400) {
    return describeValidationErrors(body?.errors) || body?.message || fallback;
  }
  if (status === 404) return body?.message || 'Not found.';
  if (status === 413) return body?.message || 'The image is too large to upload.';
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status === 502 || status === 503 || status === 504) return UNAVAILABLE_MESSAGE;
  if (status >= 500) return 'Something went wrong on the server. Please try again.';
  return body?.message || fallback;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null; // empty or non-JSON body
  }
}

// fetch() that resolves with parsed JSON on success and throws ApiError, with a
// userMessage, on any failure: network error, non-2xx status, or a 2xx whose
// body is not the JSON the UI expects.
export async function requestJson(path, options = {}, { fallback = 'The request failed. Please try again.', fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${API_BASE}${path}`, options);
  } catch (err) {
    console.error(`Network error calling ${path}:`, err);
    throw new ApiError(NETWORK_MESSAGE, { cause: err });
  }
  const body = await readJson(res);
  if (!res.ok) {
    console.error(`API ${path} answered ${res.status}:`, body);
    throw new ApiError(describeHttpError(res.status, body, fallback), { status: res.status });
  }
  if (body === null) {
    console.error(`API ${path} answered ${res.status} with a non-JSON body`);
    throw new ApiError(fallback, { status: res.status });
  }
  return body;
}

// Checks the form before anything is sent, so obvious mistakes get an
// immediate, specific message. The server validates again regardless.
export function validateSubmission({ mode, imageUrl, imageFile, width, height }) {
  if (mode === 'url') {
    const value = String(imageUrl ?? '').trim();
    if (!value) return 'Enter an image URL.';
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return FIELD_MESSAGES.imageUrl;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return FIELD_MESSAGES.imageUrl;
  } else if (!imageFile) {
    return 'Choose an image to upload.';
  } else if (imageFile.type && !imageFile.type.startsWith('image/')) {
    return 'The selected file is not an image.';
  }
  for (const [name, value] of [['width', width], ['height', height]]) {
    const n = Number(value);
    if (String(value).trim() === '' || !Number.isInteger(n) || n < MIN_DIMENSION || n > MAX_DIMENSION) {
      return FIELD_MESSAGES[name];
    }
  }
  return null;
}

export const TERMINAL_STATUSES = ['completed', 'failed'];
