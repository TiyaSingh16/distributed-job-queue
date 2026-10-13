import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    // index.js builds its Redis connection options at load time and fails
    // fast without REDIS_HOST. Tests replace bullmq, so nothing connects.
    env: { REDIS_HOST: 'redis.test.invalid' },
  },
});
