const dns = require('node:dns');
const ipaddr = require('ipaddr.js');
const axios = require('axios');

const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// We refuse to fetch this URL: bad scheme, internal address, or a redirect
// chain that goes somewhere we refuse to go.
class RejectedUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RejectedUrlError';
  }
}

// axios wraps errors from the connection (including our lookup's) in an
// AxiosError, keeping the original as `cause`.
function isRejectedUrl(err) {
  return err instanceof RejectedUrlError || err?.cause instanceof RejectedUrlError;
}

// Allow-list: only globally routable unicast addresses. ipaddr.js classifies
// everything else (loopback, private, linkLocal = 169.254.x.x metadata,
// uniqueLocal, carrierGradeNat, multicast, ...) as a different range.
// process() unwraps IPv4-mapped IPv6 (::ffff:127.0.0.1) to plain IPv4 first.
function isPublicAddress(address) {
  if (!ipaddr.isValid(address)) return false;
  return ipaddr.process(address).range() === 'unicast';
}

// Checks what can be checked without DNS. Node does not call `lookup` when the
// host is already an IP literal, so literals must be checked here. The URL
// parser normalizes tricks like http://2130706433/ to 127.0.0.1 first.
// `base` resolves a relative redirect Location against the current URL.
function assertPublicUrl(rawUrl, base) {
  let url;
  try {
    url = new URL(rawUrl, base);
  } catch {
    throw new RejectedUrlError(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RejectedUrlError(`Only http and https URLs are allowed, got ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // IPv6 literals come bracketed
  if (ipaddr.isValid(host) && !isPublicAddress(host)) {
    throw new RejectedUrlError(`Refusing to connect to internal address ${host}`);
  }
  return url;
}

// Replacement for dns.lookup used for every connection axios opens. Checking
// here, rather than resolving once up front, means the address we check is
// the address we connect to, so a DNS answer that changes between check and
// connect (DNS rebinding) cannot slip through.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    // Reject if ANY address is internal, since the OS may connect to any.
    const blocked = addresses.find((a) => !isPublicAddress(a.address));
    if (blocked) {
      return callback(new RejectedUrlError(`Refusing to connect to ${hostname} (${blocked.address})`));
    }
    callback(null, addresses);
  });
}

// GET an image with the SSRF guard on every hop. Redirects are followed here,
// not by axios, so each Location is checked before we connect to it.
async function fetchImage(rawUrl) {
  let url = assertPublicUrl(rawUrl);
  for (let redirects = 0; ; redirects++) {
    const response = await axios.get(url.href, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
      timeout: 10000,
      maxContentLength: MAX_DOWNLOAD_BYTES,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      proxy: false, // an HTTP(S)_PROXY env var would bypass guardedLookup
      lookup: guardedLookup,
    });

    const location = response.headers.location;
    if (response.status < 300 || response.status >= 400 || !location) return response;

    if (redirects >= MAX_REDIRECTS) {
      throw new RejectedUrlError(`Too many redirects (more than ${MAX_REDIRECTS})`);
    }
    url = assertPublicUrl(location, url);
  }
}

module.exports = {
  fetchImage,
  assertPublicUrl,
  guardedLookup,
  isPublicAddress,
  isRejectedUrl,
  RejectedUrlError,
  MAX_DOWNLOAD_BYTES,
};
