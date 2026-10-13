import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');
const { redisConnection, workerConcurrency } = require(path.join(root, 'config.js'));

describe('redisConnection', () => {
  it('reads host, port and password from the environment, with TLS on', () => {
    const env = { REDIS_HOST: 'example.upstash.io', REDIS_PORT: '6380', REDIS_PASSWORD: 'pw' };
    expect(redisConnection(env)).toEqual({ host: 'example.upstash.io', port: 6380, password: 'pw', tls: {} });
  });

  it('defaults the port to 6379', () => {
    expect(redisConnection({ REDIS_HOST: 'h' }).port).toBe(6379);
  });

  it('fails fast when REDIS_HOST is missing instead of silently using localhost', () => {
    expect(() => redisConnection({})).toThrow(/REDIS_HOST/);
  });

  it.each(['abc', '0', '70000', '63.5'])('rejects REDIS_PORT=%s', (port) => {
    expect(() => redisConnection({ REDIS_HOST: 'h', REDIS_PORT: port })).toThrow(/REDIS_PORT/);
  });
});

describe('workerConcurrency', () => {
  it('defaults to 2', () => {
    expect(workerConcurrency({})).toBe(2);
  });

  it('reads WORKER_CONCURRENCY', () => {
    expect(workerConcurrency({ WORKER_CONCURRENCY: '8' })).toBe(8);
  });

  it.each(['0', '-1', 'two', '1.5'])('rejects WORKER_CONCURRENCY=%s', (value) => {
    expect(() => workerConcurrency({ WORKER_CONCURRENCY: value })).toThrow(/WORKER_CONCURRENCY/);
  });
});
