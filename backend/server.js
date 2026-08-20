"use strict";
/**
 * API tier entry point.
 *
 * Scaling model (200k students / 1000 institutes):
 *   - This process is STATELESS. Anything shared lives in Redis or Postgres.
 *   - Cluster mode forks one worker per CPU so a 2-vCPU container uses both.
 *   - Heavy CPU work (DOCX/PDF/LibreOffice) is pushed to the worker tier.
 *   - Static frontend is served by Vercel/CDN, not by Node.
 *
 * Key env vars (all optional — the app boots with none of them):
 *   WEB_CONCURRENCY   number of cluster workers (default: CPU count, max 4)
 *   REDIS_URL         enables shared sessions / cache / rate limits / queue
 *   SERVE_STATIC      "1" to serve ../frontend from Node (default off in prod)
 *   RUN_MIGRATIONS    "0" to skip DDL on boot (recommended once stable)
 *   TRUST_PROXY       proxy hop count (default 1)
 */

const cluster = require("cluster");
const os = require("os");

const { logger } = require("./config/logger");

process.on("unhandledRejection", (err) => {
	logger.error({ err: err?.message || err }, "Unhandled Rejection");
});
process.on("uncaughtException", (err) => {
	logger.fatal({ err: err?.message || err, stack: err?.stack }, "Uncaught Exception");
	// Mark in-flight paper/PDF jobs as failed before we go down, so the browser
	// gets a real error instead of "Progress session not found or expired".
	try {
		const jobs = global.paperGenProgress;
		if (jobs) {
			for (const id of Object.keys(jobs)) {
				const job = jobs[id];
				if (job && job.status !== "completed" && job.status !== "failed") {
					job.status = "failed";
					job.error = "The server stopped while building this file: " + (err?.message || "unknown error");
				}
			}
		}
	} catch (_) {}
	// Let the orchestrator restart us rather than run in an unknown state.
	setTimeout(() => process.exit(1), 250).unref?.();
});

const DEFAULT_WORKERS = Math.min(os.cpus().length || 1, 4);
const WORKERS = Number(process.env.WEB_CONCURRENCY || DEFAULT_WORKERS);

/* ══════════════════════════════════════════════════════════════════════════
   CLUSTER PRIMARY
   Runs DB migrations exactly once, then forks stateless workers.
   Without this the whole container was using a single CPU core.
══════════════════════════════════════════════════════════════════════════ */
if (cluster.isPrimary && WORKERS > 1) {
	// The primary brokers paper-generation progress between workers, otherwise a
	// progress poll that lands on a sibling worker cannot see the running job.
	try {
		const progressStore = require("./utils/progressStore");
		progressStore.installClusterBroker?.();
	} catch (e) {
		logger.warn({ err: e?.message || e }, "progress broker unavailable in primary");
	}
	const { initDB } = require("./config/db");
	const { hashPasscode } = require("./utils/helpers");
	const TEACHER_PASSCODE =
		process.env.TEACHER_PASSCODE || "dev-teacher-passcode-please-change";

	const boot = async () => {
		if (process.env.RUN_MIGRATIONS !== "0") {
			try {
				await initDB(TEACHER_PASSCODE, hashPasscode);
			} catch (e) {
				logger.error({ err: e.message }, "initDB failed in primary");
			}
		}

		logger.info({ workers: WORKERS }, "primary: forking workers");
		for (let i = 0; i < WORKERS; i++) {
			// Workers must NOT re-run DDL, and exactly one of them owns periodic sweeps.
			cluster.fork({ RUN_MIGRATIONS: "0", IS_SWEEPER: i === 0 ? "1" : "0" });
		}

		let shuttingDown = false;
		cluster.on("exit", (worker, code, signal) => {
			if (shuttingDown) return;
			logger.warn({ pid: worker.process.pid, code, signal }, "worker died, respawning");
			cluster.fork({ RUN_MIGRATIONS: "0", IS_SWEEPER: "0" });
		});

		const stop = () => {
			shuttingDown = true;
			for (const id in cluster.workers) cluster.workers[id].process.kill("SIGTERM");
			setTimeout(() => process.exit(0), 15000).unref();
		};
		process.on("SIGTERM", stop);
		process.on("SIGINT", stop);
	};

	boot();
} else {
	startServer();
}

/* ══════════════════════════════════════════════════════════════════════════
   WORKER / SINGLE-PROCESS MODE
══════════════════════════════════════════════════════════════════════════ */
function startServer() {
	const express = require("express");
	const cors = require("cors");
	const path = require("path");

	const { db, initDB } = require("./config/db");
	const { loadQuestions } = require("./utils/questions");
	const helpers = require("./utils/helpers");
	const { hashPasscode } = helpers;
	const { accessLog } = require("./config/logger");
	const { redis, redisReady, closeRedis } = require("./config/redis");
	const cache = require("./config/cache");

	const {
		clientSession,
		ownerSession,
		ensureDeviceToken,
		setDefaultInstituteId,
	} = require("./middleware/auth");

	const app = express();
	const PORT = process.env.PORT || 3000;
	app.set("trust proxy", Number(process.env.TRUST_PROXY || 1));
	// Saves a few bytes and a tiny bit of CPU on every single response.
	app.disable("x-powered-by");
	app.set("etag", "strong");

	const TEACHER_PASSCODE =
		process.env.TEACHER_PASSCODE || "dev-teacher-passcode-please-change";
	const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

	/* ── CORS ──────────────────────────────────────────────────────────────── */
	const allowedOrigins = [
		"https://vyorra-krrsh.sevalla.app",
		"https://triumph-educator.vercel.app",
		"http://localhost:3000",
		"http://localhost:8080",
		"http://127.0.0.1:3000",
		"http://127.0.0.1:8080",
	];
	// Comma-separated list so the Hostinger domain can be added without a redeploy.
	if (process.env.FRONTEND_URL) {
		for (const o of process.env.FRONTEND_URL.split(",")) {
			const t = o.trim();
			if (t) allowedOrigins.push(t);
		}
	}

	app.use(
		cors({
			origin: (origin, cb) => {
				if (
					!origin ||
					allowedOrigins.includes(origin) ||
					origin.endsWith(".github.io") ||
					origin.endsWith(".vercel.app")
				)
					return cb(null, true);
				return cb(null, false);
			},
			credentials: true,
			methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
			allowedHeaders: ["Content-Type", "Authorization", "X-Session-Type"],
			exposedHeaders: ["set-cookie"],
			maxAge: 86400,
		})
	);

	/* ── Compression ───────────────────────────────────────────────────────── */
	// Question payloads are large JSON. gzip cuts them ~80%, which matters a lot
	// when 40,000 students download a test within the same minute.
	try {
		const compression = require("compression");
		app.use(
			compression({
				threshold: 1024,
				filter: (req, res) =>
					req.headers["x-no-compression"] ? false : compression.filter(req, res),
			})
		);
	} catch (_) {
		logger.warn("`compression` not installed — run `npm install compression`");
	}

	/* ── Body parsing: small by default, large only where needed ───────────── */
	// Previously EVERY route accepted 25MB. That is a memory-exhaustion vector and
	// forces Express to allocate big buffers on hot student endpoints. Only the
	// import/extract/paper routes actually need large bodies.
	const bigJson = express.json({ limit: process.env.MAX_UPLOAD_BODY || "25mb" });
	const normalJson = express.json({ limit: process.env.MAX_BODY || "1mb" });
	const BIG_BODY_PATHS = [
		/^\/api\/admin\/extract/,
		/^\/api\/extract/,
		/^\/api\/admin\/generate-paper/,
		/^\/api\/admin\/paper-templates/,
		/^\/api\/admin\/import/,
		/^\/api\/admin\/bulk/,
		/^\/api\/admin\/questions/,
		/^\/api\/admin\/pyq/,
		/^\/api\/admin\/papers/,
		/^\/api\/admin\/star-quiz/,
		/^\/api\/admin\/online-tests/,
		/^\/api\/pool/,
	];
	app.use((req, res, next) => {
		const useBig = BIG_BODY_PATHS.some((re) => re.test(req.path));
		return (useBig ? bigJson : normalJson)(req, res, next);
	});

	/* ── Health checks (must be before auth/session middleware) ────────────── */
	// /healthz  — liveness: is the process up? Must never touch the DB.
	app.get("/healthz", (req, res) => res.status(200).json({ ok: true, pid: process.pid }));
	// /readyz   — readiness: should the load balancer send traffic here?
	app.get("/readyz", async (req, res) => {
		try {
			await db.raw("SELECT 1");
			res.json({ ok: true, redis: redisReady(), cache: cache.stats() });
		} catch (e) {
			res.status(503).json({ ok: false, error: e.message });
		}
	});

	/* ── Static files ──────────────────────────────────────────────────────── */
	// In production the frontend is on Vercel (and later Hostinger) behind a CDN.
	// Node should never burn CPU and sockets serving 5MB of PNG/WebP assets.
	if (process.env.SERVE_STATIC === "1" || process.env.NODE_ENV !== "production") {
		app.use(
			express.static(path.join(__dirname, "../frontend"), {
				maxAge: "7d",
				etag: true,
			})
		);
	}

	/* ── Device token + sessions ───────────────────────────────────────────── */
	app.use(ensureDeviceToken);

	app.use((req, res, next) => {
		const isOwner =
			(req.path && req.path.startsWith("/api/owner")) ||
			req.headers["x-session-type"] === "owner";
		if (isOwner) return ownerSession(req, res, next);
		return clientSession(req, res, next);
	});

	/* ── Security headers + sampled access log ─────────────────────────────── */
	app.use((req, res, next) => {
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("X-XSS-Protection", "1; mode=block");
		res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
		next();
	});
	app.use(accessLog); // replaces the old per-request console.log

	/* ── Routers ───────────────────────────────────────────────────────────── */
	const authRouter = require("./routes/auth");
	const ownerRouter = require("./routes/owner");
	const studentRouter = require("./routes/student");
	const extractRouter = require("./routes/extract");
	const paperRouter = require("./routes/paper");
	const adminRouter = require("./routes/admin");
	const poolRouter = require("./routes/pool");

	app.use(authRouter);
	app.use(ownerRouter);
	app.use(studentRouter);
	app.use(extractRouter);
	app.use(paperRouter);
	app.use(adminRouter);
	app.use(poolRouter);

	app.get("/api/mail-status", (req, res) => {
		try {
			res.json({ success: true, ...require("./utils/mailer").mailDiagnostics() });
		} catch (e) {
			res.status(500).json({ error: e.message });
		}
	});

	app.use((req, res) => res.status(404).json({ error: "Not found" }));

	app.use((err, req, res, next) => {
		// Body too large -> give a clear message instead of a generic 500.
		if (err && err.type === "entity.too.large") {
			return res.status(413).json({ error: "Payload too large" });
		}
		logger.error({ err: err?.message, stack: err?.stack, path: req.path }, "Unhandled error");
		res.status(500).json({ error: "Internal server error" });
	});

	/* ── Boot ──────────────────────────────────────────────────────────────── */
	async function boot() {
		// In cluster mode the primary already ran DDL, so workers skip it.
		if (process.env.RUN_MIGRATIONS !== "0") {
			const defInstId = await initDB(TEACHER_PASSCODE, hashPasscode);
			setDefaultInstituteId(defInstId);
		}

		await loadQuestions();

		// Papers auto-rebuild is a one-off maintenance task, not per-worker work.
		if (process.env.IS_SWEEPER !== "0") {
			await autoRebuildPapersIfEmpty(adminRouter);
		}

		const server = app.listen(PORT, () => {
			logger.info(
				{
					port: PORT,
					pid: process.pid,
					redis: !!redis,
					groq: !!GROQ_API_KEY,
					db: !!process.env.SUPABASE_DATABASE_URL,
				},
				"server listening"
			);
		});

		// Keep sockets alive slightly longer than a typical ALB idle timeout to
		// avoid 502s from races on connection reuse.
		server.keepAliveTimeout = Number(process.env.KEEPALIVE_TIMEOUT_MS || 65000);
		server.headersTimeout = server.keepAliveTimeout + 5000;

		/* ── Graceful shutdown ──────────────────────────────────────────────
		   Without this, every deploy/autoscale event kills in-flight student
		   submissions. With it, we stop accepting new connections, let running
		   requests finish, then close the pool cleanly. */
		let closing = false;
		const shutdown = async (signal) => {
			if (closing) return;
			closing = true;
			logger.warn({ signal }, "shutting down");
			server.close(async () => {
				try { await db.pool.end(); } catch (_) {}
				await closeRedis();
				process.exit(0);
			});
			// Hard cap so a hung request can't block a deploy forever.
			setTimeout(() => process.exit(0), 20000).unref();
		};
		process.on("SIGTERM", () => shutdown("SIGTERM"));
		process.on("SIGINT", () => shutdown("SIGINT"));
	}

	boot().catch((e) => {
		logger.fatal({ err: e.message, stack: e.stack }, "FATAL: boot failed");
		process.exit(1);
	});

	/** Rebuilds the papers table on startup if PYQ data exists but papers are empty. */
	async function autoRebuildPapersIfEmpty(adminRouterRef) {
		try {
			const pyqCount = await db.execute("SELECT COUNT(*) AS c FROM pyq_questions");
			const pyqTotal = Number((pyqCount.rows[0] || {}).c || 0);
			if (pyqTotal === 0) return;

			const paperCount = await db.execute(
				"SELECT COUNT(*) AS c FROM papers WHERE year != 'Regular'"
			);
			if (Number((paperCount.rows[0] || {}).c || 0) > 0) return;

			logger.info({ pyqTotal }, "papers: auto-rebuilding");
			const rebuildFn = adminRouterRef.rebuildPapersFromPyq;
			if (typeof rebuildFn !== "function")
				throw new Error("rebuildPapersFromPyq not exported from admin router");
			const { papers, questions } = await rebuildFn();
			logger.info({ papers, questions }, "papers: auto-rebuild complete");
		} catch (e) {
			logger.warn({ err: e.message }, "papers: auto-rebuild failed (non-fatal)");
		}
	}
}
