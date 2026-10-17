#!/usr/bin/env node
// Load test: throughput and latency of the job pipeline with 1, 2 and 4
// worker processes. See bench/README section in the main README for how to
// run it and what is real vs stubbed (also documented in bench-worker.js).
//
//   node bench/run.js --workers 1,2,4 --jobs 200 --runs 3 --io-ms 0 --concurrency 1
//
// Needs a Redis server. By default it starts its own throwaway redis-server
// on port 6390 (must be on PATH); set BENCH_REDIS_HOST/BENCH_REDIS_PORT to use
// an existing one. The Redis database is FLUSHED between runs, so never point
// this at a Redis that holds real data.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, [])
);
const WORKER_COUNTS = (args.workers || '1,2,4').split(',').map(Number);
const JOBS = Number(args.jobs || 200);
const RUNS = Number(args.runs || 3);
const IO_MS = Number(args['io-ms'] || 0);
const CONCURRENCY = Number(args.concurrency || 1);
const WARMUP_JOBS = Number(args.warmup || 10);
const OUT = args.out;

const REDIS_HOST = process.env.BENCH_REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.BENCH_REDIS_PORT || 6390);
const FIXTURE = path.join(__dirname, '.fixture.jpg');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deterministic 2400x1600 photo-like test image (smooth gradients plus seeded
// noise), so every run and every machine resizes exactly the same bytes.
async function makeFixture() {
  const width = 2400;
  const height = 1600;
  const raw = Buffer.alloc(width * height * 3);
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const n = (rand() - 0.5) * 40;
      raw[i] = Math.max(0, Math.min(255, (x / width) * 255 + n));
      raw[i + 1] = Math.max(0, Math.min(255, (y / height) * 255 + n));
      raw[i + 2] = Math.max(0, Math.min(255, 128 + 100 * Math.sin(x / 90) * Math.cos(y / 70) + n));
    }
  }
  await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toFile(FIXTURE);
  return { width, height, bytes: fs.statSync(FIXTURE).size };
}

function startRedis() {
  if (process.env.BENCH_REDIS_HOST) return null;
  const proc = spawn('redis-server', ['--port', String(REDIS_PORT), '--save', '', '--appendonly', 'no'], {
    stdio: 'ignore',
  });
  return proc;
}

// CPU seconds (user+system) and peak RSS for a process, from /proc (Linux).
function procStats(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const ticks = os.constants ? 100 : 100; // USER_HZ is 100 on Linux
    const cpuSeconds = (Number(stat[11]) + Number(stat[12])) / ticks;
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const hwm = Number((status.match(/VmHWM:\s+(\d+)/) || [])[1] || 0) / 1024;
    return { cpuSeconds, peakRssMb: hwm };
  } catch {
    return { cpuSeconds: NaN, peakRssMb: NaN };
  }
}

function pkgVersion(name) {
  const file = path.join(__dirname, '..', 'node_modules', name, 'package.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).version;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

async function startWorkers(n) {
  const env = {
    ...process.env,
    REDIS_HOST,
    REDIS_PORT: String(REDIS_PORT),
    REDIS_TLS: 'false',
    WORKER_CONCURRENCY: String(CONCURRENCY),
    BENCH_IO_MS: String(IO_MS),
    BENCH_FIXTURE: FIXTURE,
  };
  const started = Date.now();
  const workers = await Promise.all(
    Array.from({ length: n }, () => {
      const child = spawn(process.execPath, [path.join(__dirname, 'bench-worker.js')], {
        env,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker did not become ready in 30s')), 30000);
        child.on('message', (m) => {
          if (m && m.type === 'ready') {
            clearTimeout(timer);
            resolve(child);
          }
        });
        child.on('exit', (code) => reject(new Error(`worker exited early with code ${code}`)));
      });
    })
  );
  return { workers, startupMs: Date.now() - started };
}

async function stopWorkers(workers) {
  await Promise.all(
    workers.map(
      (w) =>
        new Promise((resolve) => {
          w.removeAllListeners('exit');
          w.once('exit', resolve);
          w.kill('SIGTERM');
        })
    )
  );
}

async function waitForJobs(queue, ids, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const counts = await queue.getJobCounts('completed', 'failed');
    if (counts.completed + counts.failed >= ids) return counts;
    if (Date.now() > deadline) throw new Error(`timed out with ${JSON.stringify(counts)}`);
    await sleep(20);
  }
}

async function oneRun(queue, redis, nWorkers, runIndex) {
  await redis.flushdb();
  const { workers, startupMs } = await startWorkers(nWorkers);
  try {
    const payload = { imageUrl: 'https://bench.invalid/fixture.jpg', width: 300, height: 300 };
    // Warm-up: first jobs pay for JIT compilation and sharp/libvips init.
    if (WARMUP_JOBS > 0) {
      await queue.addBulk(
        Array.from({ length: WARMUP_JOBS }, (_, i) => ({
          name: 'resize-image',
          data: payload,
          opts: { jobId: `warm-${runIndex}-${i}` },
        }))
      );
      await waitForJobs(queue, WARMUP_JOBS);
      await redis.flushdb();
    }

    const before = workers.map((w) => procStats(w.pid));
    const t0 = Date.now();
    await queue.addBulk(
      Array.from({ length: JOBS }, (_, i) => ({
        name: 'resize-image',
        data: payload,
        opts: { jobId: `bench-${runIndex}-${i}`, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
      }))
    );
    const counts = await waitForJobs(queue, JOBS);
    const elapsedS = (Date.now() - t0) / 1000;
    const after = workers.map((w) => procStats(w.pid));

    const jobs = await queue.getJobs(['completed', 'failed'], 0, JOBS - 1);
    const latency = jobs.map((j) => j.finishedOn - j.timestamp).sort((a, b) => a - b);
    const processing = jobs.map((j) => j.finishedOn - j.processedOn).sort((a, b) => a - b);
    const workerCpuS = after.reduce((sum, a, i) => sum + (a.cpuSeconds - before[i].cpuSeconds), 0);

    return {
      workers: nWorkers,
      run: runIndex,
      jobs: JOBS,
      completed: counts.completed,
      failed: counts.failed,
      errorRatePct: (100 * counts.failed) / JOBS,
      elapsedS,
      throughputJobsPerS: counts.completed / elapsedS,
      latencyMs: { p50: percentile(latency, 50), p95: percentile(latency, 95), p99: percentile(latency, 99) },
      processingMs: { p50: percentile(processing, 50), p95: percentile(processing, 95) },
      workerCpuSeconds: workerCpuS,
      // CPU-seconds used per wall-clock second: 2.0 means two cores fully busy.
      avgCoresBusy: workerCpuS / elapsedS,
      peakRssMbPerWorker: Math.max(...after.map((a) => a.peakRssMb)),
      startupMs,
    };
  } finally {
    await stopWorkers(workers);
  }
}

async function main() {
  const fixture = await makeFixture();
  const redisProc = startRedis();
  const connection = { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null };
  // Wait until the throwaway redis-server accepts connections.
  for (let i = 0; ; i++) {
    const probe = new IORedis({ ...connection, lazyConnect: true, retryStrategy: null });
    probe.on('error', () => {});
    try {
      await probe.connect();
      await probe.quit();
      break;
    } catch {
      probe.disconnect();
      if (i > 50) throw new Error(`Redis not reachable at ${REDIS_HOST}:${REDIS_PORT}`);
      await sleep(100);
    }
  }
  const redis = new IORedis(connection);
  const queue = new Queue('jobs', { connection });

  const env = {
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model,
    totalMemGb: +(os.totalmem() / 1024 ** 3).toFixed(1),
    node: process.version,
    redis: execFileSync('redis-server', ['--version']).toString().trim().split(' ')[2] || 'external',
    bullmq: pkgVersion('bullmq'),
    sharp: pkgVersion('sharp'),
    libvips: sharp.versions.vips,
    platform: `${os.platform()} ${os.release()}`,
  };
  const config = { workerCounts: WORKER_COUNTS, jobsPerRun: JOBS, runs: RUNS, ioMsEachWay: IO_MS, concurrencyPerWorker: CONCURRENCY, warmupJobs: WARMUP_JOBS, fixture, resizeTo: '300x300' };
  console.error(`env ${JSON.stringify(env)}\nconfig ${JSON.stringify(config)}`);

  const results = [];
  try {
    for (const n of WORKER_COUNTS) {
      for (let r = 1; r <= RUNS; r++) {
        const res = await oneRun(queue, redis, n, r);
        results.push(res);
        console.error(
          `workers=${n} run=${r}: ${res.throughputJobsPerS.toFixed(2)} jobs/s, p50 ${res.latencyMs.p50}ms, p95 ${res.latencyMs.p95}ms, failed ${res.failed}, cores busy ${res.avgCoresBusy.toFixed(2)}`
        );
      }
    }
  } finally {
    await queue.close();
    await redis.quit();
    if (redisProc) redisProc.kill();
  }

  const summary = WORKER_COUNTS.map((n) => {
    const rs = results.filter((r) => r.workers === n);
    return {
      workers: n,
      throughputJobsPerS: median(rs.map((r) => r.throughputJobsPerS)),
      throughputRange: [Math.min(...rs.map((r) => r.throughputJobsPerS)), Math.max(...rs.map((r) => r.throughputJobsPerS))],
      p50Ms: median(rs.map((r) => r.latencyMs.p50)),
      p95Ms: median(rs.map((r) => r.latencyMs.p95)),
      p99Ms: median(rs.map((r) => r.latencyMs.p99)),
      processingP50Ms: median(rs.map((r) => r.processingMs.p50)),
      errorRatePct: Math.max(...rs.map((r) => r.errorRatePct)),
      avgCoresBusy: median(rs.map((r) => r.avgCoresBusy)),
      peakRssMbPerWorker: Math.max(...rs.map((r) => r.peakRssMbPerWorker)),
      startupMs: median(rs.map((r) => r.startupMs)),
    };
  });
  const base = summary[0].throughputJobsPerS;
  for (const s of summary) s.speedupVsFirst = s.throughputJobsPerS / base;

  const output = { date: new Date().toISOString(), env, config, summary, runs: results };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
