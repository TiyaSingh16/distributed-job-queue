import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';

// Uses the real axios and a real local HTTP server, so these tests prove the
// guard is wired into the actual connection, not just into our own checks.
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');
const dns = require('node:dns');
const {
  isPublicAddress,
  assertPublicUrl,
  guardedLookup,
  fetchImage,
  isRejectedUrl,
  RejectedUrlError,
  MAX_DOWNLOAD_BYTES,
} = require(path.join(root, 'safe-fetch.js'));

afterEach(() => vi.restoreAllMocks());

describe('isPublicAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['100.100.100.200', 'carrier-grade NAT / Alibaba metadata'],
    ['0.0.0.0', 'unspecified'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd00:ec2::254', 'IPv6 unique-local / AWS metadata'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['not-an-ip', 'not an address'],
  ])('rejects %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700::1111'])('allows public %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  it.each([
    'http://127.0.0.1/a.jpg',
    'http://[::1]/a.jpg',
    'http://[::ffff:127.0.0.1]/a.jpg',
    'http://2130706433/a.jpg', // decimal form of 127.0.0.1
    'http://0x7f.1/a.jpg', // hex/short form of 127.0.0.1
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    'gopher://img.example/',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => assertPublicUrl(url)).toThrow(RejectedUrlError);
  });

  it('allows a public hostname (DNS is checked at connect time)', () => {
    expect(assertPublicUrl('https://img.example/a.jpg').hostname).toBe('img.example');
  });
});

describe('guardedLookup', () => {
  function stubDns(addresses) {
    vi.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) => cb(null, addresses));
  }
  const lookup = (host) =>
    new Promise((resolve, reject) =>
      guardedLookup(host, {}, (err, addrs) => (err ? reject(err) : resolve(addrs)))
    );

  it('passes through public addresses', async () => {
    stubDns([{ address: '93.184.216.34', family: 4 }]);
    await expect(lookup('img.example')).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects a hostname that resolves to a private address', async () => {
    stubDns([{ address: '10.0.0.5', family: 4 }]);
    await expect(lookup('internal.example')).rejects.toBeInstanceOf(RejectedUrlError);
  });

  it('rejects when ANY resolved address is private', async () => {
    // Otherwise the OS could pick the private one when connecting.
    stubDns([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(lookup('mixed.example')).rejects.toBeInstanceOf(RejectedUrlError);
  });

  it('passes DNS errors through unchanged', async () => {
    const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    vi.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) => cb(notFound));
    await expect(lookup('nope.example')).rejects.toBe(notFound);
  });
});

describe('fetchImage against a real local server', () => {
  let server;
  let port;
  const routes = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const handler = routes[req.url];
      if (handler) return handler(req, res);
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end('secret internal data');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('refuses http://localhost (hostname resolved by DNS to loopback)', async () => {
    const err = await fetchImage(`http://localhost:${port}/a.jpg`).catch((e) => e);
    expect(isRejectedUrl(err)).toBe(true);
  });

  it('refuses a redirect from a public URL to an internal address', async () => {
    // A public host answering with a redirect to the metadata service is
    // simulated with the axios call stubbed for the first hop only.
    const axios = require('axios');
    vi.spyOn(axios, 'get').mockImplementationOnce(async () => ({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      data: Buffer.alloc(0),
    }));

    const err = await fetchImage('https://public.example/a.jpg').catch((e) => e);

    expect(isRejectedUrl(err)).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a hostname that resolves to loopback', async () => {
    const axios = require('axios');
    vi.spyOn(axios, 'get').mockImplementationOnce(async () => ({
      status: 301,
      headers: { location: `http://localhost:${port}/a.jpg` },
      data: Buffer.alloc(0),
    }));

    const err = await fetchImage('https://public.example/a.jpg').catch((e) => e);

    expect(isRejectedUrl(err)).toBe(true);
  });

  it('follows a relative redirect to a public URL', async () => {
    const axios = require('axios');
    const get = vi
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ status: 302, headers: { location: '/b.jpg' }, data: Buffer.alloc(0) })
      .mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'image/jpeg' }, data: Buffer.from('x') });

    const res = await fetchImage('https://public.example/a.jpg');

    expect(res.status).toBe(200);
    expect(get.mock.calls[1][0]).toBe('https://public.example/b.jpg');
  });

  it('gives up after too many redirects', async () => {
    const axios = require('axios');
    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 302,
      headers: { location: 'https://public.example/loop.jpg' },
      data: Buffer.alloc(0),
    });

    const err = await fetchImage('https://public.example/a.jpg').catch((e) => e);

    expect(isRejectedUrl(err)).toBe(true);
    expect(err.message).toMatch(/redirects/);
  });

  it('passes the size cap, no proxy, no auto-redirects and the guarded lookup to axios', async () => {
    const axios = require('axios');
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, headers: {}, data: Buffer.alloc(0) });

    await fetchImage('https://public.example/a.jpg');

    expect(get.mock.calls[0][1]).toMatchObject({
      maxContentLength: 15 * 1024 * 1024,
      maxRedirects: 0,
      proxy: false,
      lookup: guardedLookup,
    });
    expect(MAX_DOWNLOAD_BYTES).toBe(15 * 1024 * 1024);
  });
});
