# Load test results: 1, 2 and 4 worker processes

**Environment: local benchmark** (a 2-vCPU cloud Linux VM), **not production**. The numbers describe this
machine and this harness. They are not a prediction of what the Render deployment does.

Raw data for every run: `bench/results/*.json`. Harness: `bench/run.js` and `bench/bench-worker.js`.
Date: 17 Oct 2026.

## Setup

| | |
|---|---|
| CPU / RAM | 2 vCPU (Intel Xeon @ 2.10GHz), 7.8 GB; the load generator and Redis run on the same machine |
| Software | Node v22.22.0, Redis 7.0.15 (local, no persistence), BullMQ 6.1.0, sharp 0.35.5 (libvips 8.18.7) |
| What is varied | Number of **worker processes** (`node bench/bench-worker.js`), each with `WORKER_CONCURRENCY=1`, so N processes = N jobs in flight. The API is not part of the test: jobs are added to the queue directly. |
| Workload | A burst of **200 jobs added at once** (`addBulk`), 3 runs per configuration, 10 warm-up jobs per run (discarded). Each job resizes the same deterministic 2400×1600 JPEG (1.15 MB) to fit 300×300. |
| Real | Redis, BullMQ (locking, retries, completion), `worker.js` `processJob()` (payload validation and the sharp resize) |
| Stubbed | Image download (returns the fixture), Cloudinary upload (no-op), Mongo status writes (no-op). No MongoDB server was available, and the SSRF guard correctly refuses local URLs. |
| Two workloads | **CPU-bound:** no artificial delay, so the job is the resize. **I/O-heavy:** a 250 ms delay on the stubbed download *and* on the upload, a synthetic stand-in for network time. |
| Metrics | Throughput = completed jobs ÷ wall time from first add to last completion. Latency = BullMQ `finishedOn − timestamp` per job, which includes **queue waiting time**, so it mostly measures how long the burst takes to drain. Processing = `finishedOn − processedOn`. CPU from `/proc` (user+sys) of the worker processes. |

Reported values are the **median of 3 runs** (range in brackets).

## CPU-bound (resize only)

| Workers | Throughput (jobs/s) | Speed-up | p50 / p95 / p99 latency (ms) | Processing p50 (ms) | Cores busy | Peak RSS / worker | Errors |
|---|---|---|---|---|---|---|---|
| 1 | **43.7** [43.2–43.9] | 1.00× | 2296 / 4348 / 4523 | 22 | 0.96 | 163 MB | 0 |
| 2 | **81.4** [77.9–83.7] | 1.86× | 1239 / 2334 / 2415 | 23 | 1.72 | 164 MB | 0 |
| 4 | **82.6** [79.8–88.0] | 1.89× | 1153 / 2317 / 2401 | **47** | 1.88 | 159 MB | 0 |

## I/O-heavy (250 ms simulated download + 250 ms simulated upload)

| Workers | Throughput (jobs/s) | Speed-up | p50 / p95 / p99 latency (ms) | Processing p50 (ms) | Cores busy | Peak RSS / worker | Errors |
|---|---|---|---|---|---|---|---|
| 1 | **1.91** [1.91–1.91] | 1.00× | 52428 / 99648 / 103842 | 523 | 0.05 | 140 MB | 0 |
| 2 | **3.80** [3.79–3.80] | 1.99× | 26361 / 49976 / 52080 | 524 | 0.10 | 140 MB | 0 |
| 4 | **7.54** [7.50–7.57] | 3.95× | 13273 / 25371 / 26425 | 526 | 0.21 | 159 MB | 0 |

## Same work in one process: `WORKER_CONCURRENCY` instead of more processes

| Configuration | Workload | Throughput (jobs/s) | Peak RSS (total) |
|---|---|---|---|
| 4 processes × concurrency 1 | I/O-heavy | 7.54 | ~4 × 159 MB |
| **1 process × concurrency 4** | I/O-heavy | **7.56** [7.55–7.57] | **175 MB** |
| 2 processes × concurrency 1 | CPU-bound | 81.4 | ~2 × 164 MB |
| **1 process × concurrency 2** | CPU-bound | **78.9** [73.9–84.1] | **172 MB** |

## What the numbers show

1. **CPU-bound work stops scaling at the core count.** 1 → 2 workers gives 1.86×, but 2 → 4 adds almost nothing (81 → 83 jobs/s, within run-to-run noise), because two workers already keep both cores ~90% busy.
   The extra workers show up as **contention**: per-job processing time doubles from 23 ms to 47 ms, because four processes are time-sharing two cores. They also cost ~160 MB of memory each and slower startup.
2. **I/O-bound work scales almost linearly** (1.99×, then 3.95×), with the CPU nearly idle (≤ 0.21 cores). A worker waiting on the network isn't using the CPU, so more jobs in flight means more throughput until something else (CPU, Redis, the remote services) saturates. 4 workers did not reach that point here.
3. **In one process, concurrency matches extra processes** for both workloads, at roughly a quarter of the memory in the I/O case. Node overlaps I/O waits inside one process, and sharp runs resizes on libvips' own thread pool, so one process can use both cores.
   Extra processes are worth it mainly to spread work across **machines**, or to isolate failures (a crash takes down one process's jobs, not all of them).
4. **Latency here is dominated by queueing**, not processing (2.3 s median vs 22 ms of actual work with 1 worker). With a burst of 200, latency halves when throughput doubles. That's what you'd expect, and it's why p50/p95 track throughput.
5. **Zero failed jobs** in all 24 measured runs (4,800 jobs).

**Recommendation for this environment:** for the CPU-bound resize, run about one job in flight per core (2 here). In production each job also downloads and uploads over the network, so real jobs sit between the two workloads. The deployed default (1 worker process, `WORKER_CONCURRENCY=2`) is reasonable for a 1–2-core instance, and raising concurrency is the cheaper first lever before adding processes. Measuring the real mix needs a staging environment with real network calls.

## Limitations (read before quoting these numbers)

- Local benchmark on a shared 2-vCPU VM. The load generator and Redis compete for the same cores as the workers, so the CPU-bound ceiling is slightly lower than with dedicated hardware.
- Redis is local (sub-millisecond round trips). Upstash adds network latency on every queue operation.
- Mongo writes, Cloudinary and the real download are stubbed. The I/O delay is a fixed synthetic 250 ms, while real network time varies.
- One image size, and one burst size (200). Steady-state arrival rates were not tested.

## Reproduce

```bash
npm ci
# needs redis-server on PATH (the script starts a throwaway instance on port 6390 and FLUSHES it)
node bench/run.js --workers 1,2,4 --jobs 200 --runs 3 --io-ms 0   --concurrency 1 --out bench/results/cpu-bound.json
node bench/run.js --workers 1,2,4 --jobs 200 --runs 3 --io-ms 250 --concurrency 1 --out bench/results/io-heavy.json
node bench/run.js --workers 1     --jobs 200 --runs 3 --io-ms 250 --concurrency 4 --out bench/results/io-heavy-1proc-concurrency4.json
node bench/run.js --workers 1     --jobs 200 --runs 3 --io-ms 0   --concurrency 2 --out bench/results/cpu-bound-1proc-concurrency2.json
```
