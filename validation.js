const { z } = require('zod');

// Shared by the API (reject bad requests with 400) and the worker (reject
// bad job data, e.g. records created before validation existed).

const dimension = z.number().int().min(1).max(4000);

// Only http/https: blocks file:, ftp:, gopher:, javascript: and friends.
// Whether the host is safe to contact is decided later by the worker's SSRF
// guard, because DNS can change between submission and download.
const resizePayload = z.object({
  imageUrl: z.url({ protocol: /^https?$/ }),
  width: dimension.default(300),
  height: dimension.default(300),
});

// POST /jobs (JSON). The worker only knows how to resize, so that is the only
// accepted type. Unknown keys are stripped from the stored payload.
const createJobBody = z.object({
  type: z.literal('resize-image').default('resize-image'),
  payload: resizePayload,
});

// Multipart form fields arrive as strings. Accept plain digits only: zod's
// z.coerce.number() would also accept "0x10", "1e3" and " 12 ".
const dimensionField = z
  .string()
  .regex(/^\d+$/, 'must be a whole number')
  .transform(Number)
  .pipe(dimension);

// POST /jobs/upload form fields (the file itself is checked by multer).
const uploadFields = z.object({
  width: dimensionField.default(300),
  height: dimensionField.default(300),
});

// Turn a zod error into a small JSON-friendly list for 400 responses.
function formatIssues(error) {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

module.exports = { resizePayload, createJobBody, uploadFields, formatIssues };
