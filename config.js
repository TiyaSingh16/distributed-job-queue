// Environment parsing shared by the API (index.js) and the worker. Each
// function takes `env` so tests can pass a plain object.

function parsePositiveInt(name, raw, { max = Infinity } = {}) {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > max) {
    throw new Error(`${name} must be a whole number between 1 and ${max}, got "${raw}"`);
  }
  return value;
}

// BullMQ/ioredis connection options. Fails fast if REDIS_HOST is missing:
// otherwise ioredis would quietly try localhost:6379 and retry forever.
// TLS is always on because Upstash requires it.
function redisConnection(env = process.env) {
  if (!env.REDIS_HOST) {
    throw new Error('REDIS_HOST is not set (see .env.example)');
  }
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT === undefined ? 6379 : parsePositiveInt('REDIS_PORT', env.REDIS_PORT, { max: 65535 }),
    password: env.REDIS_PASSWORD,
    tls: {},
  };
}

// How many jobs one worker process runs at the same time.
function workerConcurrency(env = process.env) {
  if (env.WORKER_CONCURRENCY === undefined) return 2;
  return parsePositiveInt('WORKER_CONCURRENCY', env.WORKER_CONCURRENCY);
}

module.exports = { redisConnection, workerConcurrency };
