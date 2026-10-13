import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    // index.js builds its Redis connection options at load time and fails
    // fast without REDIS_HOST. Tests replace bullmq, so nothing connects.
    env: { REDIS_HOST: 'redis.test.invalid' },
    // beforeEach/beforeAll hooks require index.js/worker.js, which load
    // express, cloudinary, bullmq etc. On a cold disk cache (fresh CI runner)
    // that once took >10s, vitest's default hook timeout.
    hookTimeout: 30000,
  },
});
