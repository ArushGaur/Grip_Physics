# Vyorra — Scaling Guide

Target: **1,000 institutes × 200 students = 200,000 students.**

Realistic peak load for that user base:

| Scenario | Concurrent students | Requests/sec |
|---|---|---|
| Normal weekday evening | ~10,000 | ~400 |
| Big exam morning | ~40,000 | ~1,600 |
| Everyone at once (won't happen) | 200,000 | ~8,000 |

The target we build for is **~1,500 rps sustained, ~3,000 rps burst**. That is
achievable on roughly **$300–600/month**, not the $5k+/month a literal
"10,000 rps" architecture would need.

**Nothing in this release is required.** Every new piece is optional and falls
back to the old behaviour if the corresponding env var is missing, so you can
deploy today and turn things on one at a time.

---

## 1. The one change that matters most

Set **`REDIS_URL`**.

Before: every single request ran `SELECT ... FROM sessions` against Postgres to
validate the session. At 1,500 rps that's 1,500 database round-trips per second
spent purely on authentication — the database dies long before Node does.

After: sessions live in Redis (~0.2ms, no Postgres involved), which also makes
every API instance **stateless**. That's what makes running more than one
instance possible at all.

Setting `REDIS_URL` switches on four things at once:

- shared session store
- shared rate limiting (without it, N instances = N× the allowance per user)
- test-question caching
- the background job queue for paper generation

Without it, the app runs exactly as it does today. Nothing breaks.

---

## 2. Environment variables

All optional. Defaults shown.

### Redis
| Var | Default | Purpose |
|---|---|---|
| `REDIS_URL` | *(none)* | Enables sessions, cache, rate limits, queue. `rediss://` = TLS |

### Postgres pool
| Var | Default | Notes |
|---|---|---|
| `PG_POOL_MAX` | `5` | **Per process.** See the pool-math warning below |
| `PG_CONNECT_TIMEOUT_MS` | `5000` | Was 30s — far too long to make a user wait |
| `PG_STATEMENT_TIMEOUT_MS` | `10000` | Kills runaway queries instead of piling them up |
| `PG_QUERY_TIMEOUT_MS` | `12000` | Client-side backstop |
| `PG_RETRIES` | `2` | Retries on transient errors, with full jitter |
| `PG_BREAKER_THRESHOLD` | `20` | Failures before the circuit breaker opens |
| `PG_BREAKER_COOLDOWN_MS` | `3000` | How long it stays open |

### Process / HTTP
| Var | Default | Notes |
|---|---|---|
| `WEB_CONCURRENCY` | CPU count (max 4) | Cluster workers. `1` disables clustering |
| `RUN_MIGRATIONS` | `1` | Set `0` once schema is stable — faster, safer boots |
| `SERVE_STATIC` | off in prod | Let Vercel/Hostinger serve the frontend, not Node |
| `MAX_BODY` | `1mb` | Default JSON body limit |
| `MAX_UPLOAD_BODY` | `25mb` | Only for import/extract/paper routes |
| `TRUST_PROXY` | `1` | Proxy hop count |
| `KEEPALIVE_TIMEOUT_MS` | `65000` | Keep above your load balancer's idle timeout |

### Cache / logging / queue
| Var | Default | Notes |
|---|---|---|
| `TEST_QUESTIONS_TTL` | `120` | Seconds to cache a resolved test's questions |
| `CACHE_LOCAL_TTL` | `10` | In-process LRU tier in front of Redis |
| `CACHE_MAX_ENTRIES` | `500` | LRU size |
| `LOG_SAMPLE_RATE` | `0.01` | Log 1% of requests (5xx and slow ones always logged) |
| `LOG_SLOW_MS` | `1000` | Always log requests slower than this |
| `WORKER_CONCURRENCY` | `2` | Paper jobs per worker process |
| `DISABLE_QUEUE` | *(unset)* | `1` forces inline generation |

### ⚠️ Connection-pool math (the #1 way to take the DB down)

```
total connections = instances × cluster workers × PG_POOL_MAX
```

3 instances × 2 workers × 5 = **30 connections**. Fine.
The old value of 10 with 4 workers across 5 instances = **200 connections** —
that exceeds most managed Postgres limits and everything starts erroring.

**Always put a pooler (Supavisor on Supabase, or PgBouncer) in transaction mode
between the app and Postgres**, and point `SUPABASE_DATABASE_URL` at the pooler
port (`6543` on Supabase), not the direct port (`5432`).

---

## 3. What changed in the code

### New files
| File | What it does |
|---|---|
| `config/redis.js` | Optional ioredis client, throttled error logs, TLS support |
| `config/cache.js` | Two-tier cache: in-process LRU → Redis |
| `config/logger.js` | Sampled structured logging (pino, with console fallback) |
| `utils/progressStore.js` | Paper-gen progress shared across instances via Redis |
| `utils/queue.js` | Optional BullMQ queue; returns `false` so callers run inline |
| `worker.js` | Worker-tier entry point (`npm run worker`) |
| `migrations/001-scaling.sql` | Indexes, autovacuum tuning, retention, partitioning notes |
| `Dockerfile.worker` | Heavy image with LibreOffice, for the worker tier |

### Modified
- **`config/db.js`** — pool sized for multi-instance, real timeouts, jittered
  retries, and a circuit breaker so a struggling database gets a chance to
  recover instead of being hammered by retries.
- **`middleware/auth.js`** — Redis session store (Postgres store kept as
  fallback), Redis-backed rate limiting, session TTL capped at 30 days instead
  of **10 years**, and DB session sweeping restricted to one process.
- **`server.js`** — cluster mode, sampled access logs (the old per-request
  `console.log` is itself a bottleneck at high rps), gzip, per-path body limits,
  `/healthz` + `/readyz`, and graceful shutdown so deploys stop killing
  in-flight student submissions.
- **`routes/student.js`** — the resolved question set for a test is now cached.
  Every student in an institute gets the *same* questions, so 200 students
  starting a test collapses from 200 database resolutions to **one**. Only the
  shared content is cached; per-student attempt state is still read live.
- **`routes/paper.js`** — progress is shared across instances; generation is
  handed to the worker tier when available.
- **`routes/owner.js`** — the three unbounded `SELECT *` routes are paginated.
  At 200k students, `SELECT * FROM registered_students` alone would return
  ~100MB and stall a whole instance.
- **`frontend/shared/shared-pool.js`** — polling is jittered (25–40s) and pauses
  on hidden tabs, converting a synchronised traffic spike into a flat line.

---

## 4. Deploy order (nothing breaks at any step)

1. **Deploy the code as-is.** No Redis, no new env vars. Behaviour is unchanged;
   you get the timeouts, pagination, gzip, health checks, and graceful shutdown.
2. **Run the migration**: `psql "$SUPABASE_DATABASE_URL" -f backend/migrations/001-scaling.sql`
   (uses `CONCURRENTLY`, so no table locks — safe on a live database).
3. **Add Redis** and set `REDIS_URL`. Sessions, caching, and rate limits go
   distributed. Everyone gets logged out once, when the store switches.
4. **Point the DB at the pooler** (Supabase port `6543`) and set `PG_POOL_MAX=5`.
5. **Scale out** to 3+ instances. Confirm the load balancer is using `/healthz`.
6. **Add the worker tier** — build `Dockerfile.worker`, run `npm run worker`.
   Paper generation stops competing with students for CPU.
7. **Set `RUN_MIGRATIONS=0`** once the schema is settled.

---

## 5. Your setup: Vercel + Sevalla + GitHub → Hostinger

### Today
- **Frontend (Vercel)** — no change needed. Add your API origin to `FRONTEND_URL`
  on the backend (it accepts a comma-separated list, and `*.vercel.app` is
  already allowed, so preview deploys work).
- **Backend (Sevalla)** — set the env vars above. Sevalla scales containers, so
  keep `WEB_CONCURRENCY` at 2 and add instances rather than making one huge.
  Point the health check at `/healthz`.
- **Redis** — Upstash is the easiest option and works from anywhere
  (Sevalla now, Hostinger later). Use the `rediss://` URL.

### In ~2 months, moving to Hostinger

Everything here is deliberately **provider-agnostic** — plain Docker, standard
env vars, no Sevalla-specific APIs. The move is a redeploy, not a rewrite.

On a Hostinger VPS (get **4 vCPU / 8GB minimum**; shared hosting cannot run this):

1. Install Docker + Docker Compose, or Coolify/Dokploy for a Sevalla-like UI.
2. Deploy from the same GitHub repo. Build `backend/Dockerfile` for the API and
   `backend/Dockerfile.worker` for the worker.
3. Run 2–4 API containers behind **Nginx** or **Caddy** as the load balancer,
   with TLS via Let's Encrypt.
4. Set `WEB_CONCURRENCY=2` per container and keep `PG_POOL_MAX=5`.
5. Point Nginx health checks at `/healthz`.
6. Frontend: either keep it on Vercel (recommended — it's a free global CDN and
   costs you nothing to leave in place) or serve the static files from Nginx.
   If you move it, **put Cloudflare in front**, otherwise a single VPS is
   serving every image to every student.
7. Keep the database managed (Supabase). Self-hosting Postgres for 200k students
   on the same VPS as the app is the fastest way to lose data.
8. Update `FRONTEND_URL` with the Hostinger domain, redeploy, then switch DNS.

**Do not run Postgres, Redis, the API, and the worker on one small VPS.** The
whole point of the split above is that a teacher generating a PDF can't slow
down a student taking a test.

---

## 6. What to watch

| Metric | Healthy | Act when |
|---|---|---|
| p95 API latency | < 300ms | > 1s |
| DB CPU | < 60% | > 80% sustained |
| Pool waiting count | 0 | consistently > 0 → add a pooler, not a bigger pool |
| Redis memory | < 70% | > 85% |
| `/readyz` failures | 0 | any sustained failure |

`/readyz` returns cache stats and Redis status, which is the quickest way to
confirm a new instance actually joined the cluster correctly.

---

## 7. Deliberately NOT done

These are real techniques that are simply wrong at your current size — they add
cost and operational complexity for load you don't have:

- **Read replicas** — needed past ~5,000 rps of reads. Caching gets you there first.
- **Sharding by institute** — a nightmare to reverse; consider past ~10M students.
- **Multi-region** — only if you expand outside India.
- **Kubernetes** — 3 containers do not need an orchestrator.

Revisit when the monitoring table above says so, not before.
