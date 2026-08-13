# Distributed Job Queue System

A distributed job processing system that decouples job submission from execution using a Redis-backed queue and concurrent workers. Built to handle asynchronous image processing at scale, with a fully deployed, multi-service cloud architecture.

**Live demo:** https://distributed-job-queue-rho.vercel.app

---

## Overview

Image resizing is CPU-bound and can be slow at scale. Processing it inline within a request/response cycle blocks the API server and limits throughput to one job at a time per instance. This system decouples job **submission** (fast — just writes to a queue) from job **execution** (slow — handled by dedicated worker processes), so the API stays responsive under load, and processing capacity scales independently by simply adding more workers.

---

## Architecture

```
┌────────────┐        ┌──────────────┐        ┌─────────────────┐
│  Frontend  │──POST──▶│  API Server  │──push──▶│  Redis Queue     │
│  (React)   │  /jobs  │  (Express)   │        │  (Upstash/BullMQ)│
└────────────┘        └──────┬───────┘        └────────┬─────────┘
      ▲                      │                          │
      │                 write initial            workers pull jobs
      │                 job record                       │
      │                      ▼                          ▼
      │               ┌──────────────┐          ┌──────────────┐
      │               │   MongoDB    │◀─update──│   Worker(s)   │
      │               │   (Atlas)    │  status  │  (BullMQ)     │
      │               └──────────────┘          └──────┬───────┘
      │                      ▲                          │
      │                      │                   download image,
      │                 read status              resize (sharp),
      └────GET /jobs/:id─────┘                   upload result
                                                          │
                                                          ▼
                                                  ┌──────────────┐
                                                  │  Cloudinary  │
                                                  │  (storage)   │
                                                  └──────────────┘
```

## How It Works

1. **Submission** — the client submits a job (image URL + target dimensions) via `POST /jobs`.
2. **Queueing** — the API server pushes the job onto a BullMQ queue backed by Redis, and writes an initial `queued` record to MongoDB. The response returns immediately with a job ID — the client is never blocked waiting for processing.
3. **Processing** — one or more independent worker processes continuously watch the queue. Whichever worker is free picks up the next available job. This is what enables horizontal scaling: adding more workers increases throughput with zero changes to the API or queue logic.
4. **Execution** — the worker downloads the source image, resizes it in-memory using `sharp`, and uploads the result to Cloudinary.
5. **Status tracking** — job status (`queued` → `processing` → `completed` / `failed`) and the final result URL are persisted to MongoDB throughout the job's lifecycle.
6. **Polling** — the client polls `GET /jobs/:id` to track progress and renders the final image with a download link once complete.

---

## Horizontal Scaling — Verified

This system's core claim — that it scales horizontally — was tested, not assumed. Two worker processes were run concurrently against the same queue:

| Job ID | Picked up by |
|--------|-------------|
| 5      | Worker B    |
| 6      | Worker A    |
| 7      | Worker B    |
| 8      | Worker A    |

Jobs were automatically distributed between the two workers with neither sitting idle while jobs were pending — confirming the queue correctly load-balances work across independent consumers without any coordination logic in the workers themselves.

---

## Tech Stack

| Layer              | Technology                          |
|---------------------|--------------------------------------|
| Backend             | Node.js, Express                    |
| Queue               | BullMQ + Redis (Upstash)            |
| Database            | MongoDB (Atlas) via Mongoose        |
| Image processing    | Sharp                               |
| Object storage      | Cloudinary                          |
| Frontend            | React (Vite)                        |
| Deployment           | Railway (API + worker services), Vercel (frontend) |

---

## Project Structure

```
distributed-job-queue/
├── index.js          # Express API server — job submission & status endpoints
├── worker.js          # Worker process — consumes queue, processes jobs
├── models.js          # Mongoose schema for job records
├── frontend/           # React (Vite) client
│   └── src/App.jsx
├── .env               # Environment variables (not committed)
└── README.md
```

---

## API Endpoints

### `POST /jobs`
Submit a new image resize job.

**Request body:**
```json
{
  "type": "resize-image",
  "payload": {
    "imageUrl": "https://example.com/image.jpg",
    "width": 300,
    "height": 300
  }
}
```

**Response:**
```json
{
  "message": "Job submitted",
  "jobId": "12",
  "mongoId": "6a7c6413b07ec8a5b526a7d7"
}
```

### `GET /jobs/:bullJobId`
Check the status and result of a job.

**Response:**
```json
{
  "bullJobId": "12",
  "status": "completed",
  "result": {
    "imageUrl": "https://res.cloudinary.com/.../resized-12.jpg",
    "sizeKB": 24
  }
}
```

---

## Running Locally

**Backend:**
```bash
npm install
node index.js       # starts the API server on :3000
node worker.js       # starts a worker — run multiple instances in separate terminals to test scaling
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

**Environment variables** (`.env` in the project root):
```
MONGO_URI=<your MongoDB Atlas connection string>
REDIS_PASSWORD=<your Upstash Redis password>
CLOUDINARY_CLOUD_NAME=<your Cloudinary cloud name>
CLOUDINARY_API_KEY=<your Cloudinary API key>
CLOUDINARY_API_SECRET=<your Cloudinary API secret>
```

---

## Deployment

- **API server & worker** — deployed as two independent services on Railway, sharing the same codebase but running different start commands (`node index.js` vs `node worker.js`), allowing each to scale independently.
- **Redis** — Upstash (managed, TLS-enabled).
- **MongoDB** — Atlas (managed, cloud-hosted).
- **Image storage** — Cloudinary (handles storage, delivery, and download links via `fl_attachment`).
- **Frontend** — Vercel, auto-deployed on push to `main`.

---

## Possible Extensions

- Job priority levels and delayed/scheduled jobs (BullMQ supports both natively)
- Retry with exponential backoff for transient failures (partially supported by BullMQ, not yet configured)
- A `GET /jobs` endpoint to list job history
- WebSocket-based status updates instead of polling