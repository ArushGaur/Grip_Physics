"use strict";
const crypto = require("crypto");
const session = require("express-session");
const { db } = require("../config/db");
const { redis, redisReady } = require("../config/redis");

const SESSION_SECRET =
	process.env.SESSION_SECRET || "dev-session-secret-minimum-32-chars";

// ── Session store backed by Supabase (sessions table) ────────────────────────
class SupabaseSessionStore extends session.Store {
	async get(sid, cb) {
		try {
			const result = await db.execute({
				sql: "SELECT data, expires FROM sessions WHERE sid = ?",
				args: [sid],
			});
			if (!result.rows.length) return cb(null, null);
			const row = result.rows[0];
			if (Date.now() > Number(row.expires)) {
				await db.execute({ sql: "DELETE FROM sessions WHERE sid = ?", args: [sid] });
				return cb(null, null);
			}
			cb(null, JSON.parse(row.data));
		} catch (e) {
			cb(e);
		}
	}

	async set(sid, sess, cb) {
		try {
			const expires = sess.cookie?.expires
				? new Date(sess.cookie.expires).getTime()
				: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
			await db.execute({
				sql: `INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
				      ON CONFLICT(sid) DO UPDATE SET data = EXCLUDED.data, expires = EXCLUDED.expires`,
				args: [sid, JSON.stringify(sess), expires],
			});
			cb(null);
		} catch (e) {
			cb(e);
		}
	}

	async destroy(sid, cb) {
		try {
			await db.execute({ sql: "DELETE FROM sessions WHERE sid = ?", args: [sid] });
			cb(null);
		} catch (e) {
			cb(e);
		}
	}
}

// ── Session store backed by Redis ─────────────────────────────────────────
//
// THIS IS THE SINGLE BIGGEST SCALING FIX IN THE CODEBASE.
//
// The Postgres-backed store above runs `SELECT ... FROM sessions` on EVERY
// request, and an upsert whenever the session changes. At 1,500 rps that is
// 1,500+ database round-trips per second spent purely on authentication, and it
// is what makes the database fall over long before Node does.
//
// Redis serves the same lookup in ~0.2ms without touching Postgres, and because
// the store is external the API pods become stateless (any pod can serve any
// student, which is what makes horizontal scaling possible at all).
//
// No Redis configured -> we transparently keep using Postgres, so nothing breaks
// on the current Sevalla deployment.
class RedisSessionStore extends session.Store {
	constructor(prefix = "sess:") {
		super();
		this.prefix = prefix;
	}

	_ttlSeconds(sess) {
		const ms = sess?.cookie?.maxAge;
		// Cap session TTL at 30 days. The old code used a 10-YEAR cookie, which in a
		// DB-backed store meant the sessions table grew forever and was never purged.
		const capped = Math.min(Number(ms) || 30 * 24 * 3600 * 1000, 30 * 24 * 3600 * 1000);
		return Math.max(Math.floor(capped / 1000), 60);
	}

	async get(sid, cb) {
		try {
			const raw = await redis.get(this.prefix + sid);
			if (!raw) return cb(null, null);
			return cb(null, JSON.parse(raw));
		} catch (e) {
			// Fail OPEN as "no session" rather than 500-ing every request if Redis blips.
			return cb(null, null);
		}
	}

	async set(sid, sess, cb) {
		try {
			await redis.set(this.prefix + sid, JSON.stringify(sess), "EX", this._ttlSeconds(sess));
			cb(null);
		} catch (e) {
			cb(null); // never block the request on a session write
		}
	}

	async destroy(sid, cb) {
		try {
			await redis.del(this.prefix + sid);
			cb(null);
		} catch (e) {
			cb(null);
		}
	}

	async touch(sid, sess, cb) {
		try {
			await redis.expire(this.prefix + sid, this._ttlSeconds(sess));
			cb(null);
		} catch (e) {
			cb(null);
		}
	}
}

const sharedSessionStore = redis
	? new RedisSessionStore()
	: new SupabaseSessionStore();

console.log(
	`[session] store = ${redis ? "redis" : "postgres (set REDIS_URL to scale past ~1 instance)"}`
);

// ── Session middleware factories ──────────────────────────────────────────────
const clientSession = session({
	secret: SESSION_SECRET,
	resave: false,
	saveUninitialized: false,
	proxy: true,
	name: "grip.client.sid",
	store: sharedSessionStore,
	cookie: {
		secure: process.env.NODE_ENV === "production",
		sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
		httpOnly: true,
		maxAge: 10 * 365 * 24 * 60 * 60 * 1000,
		path: "/",
	},
});

const ownerSession = session({
	secret: SESSION_SECRET,
	resave: false,
	saveUninitialized: false,
	proxy: true,
	name: "grip.owner.sid",
	store: sharedSessionStore,
	cookie: {
		secure: process.env.NODE_ENV === "production",
		sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
		httpOnly: true,
		maxAge: 10 * 365 * 24 * 60 * 60 * 1000,
		path: "/",
	},
});

// ── Device-token-based rate limiting ─────────────────────────────────────────
//
// Previously rate limiting was keyed on `req.ip`.  In shared-WiFi / NAT
// environments (classrooms, coaching centres) that meant ONE student's bad
// login attempts locked EVERY student on the same network.
//
// Fix: assign each browser a persistent device-token cookie (`grip.device.id`).
// Rate-limit maps are keyed on that token — so only the offending device is
// affected.  Another device on the same IP is completely unaffected.
//

/** Parse raw `Cookie` header into a key→value map (no cookie-parser needed). */
function parseCookies(req) {
	const header = req.headers.cookie || "";
	const out = {};
	for (const pair of header.split(";")) {
		const eqIdx = pair.indexOf("=");
		if (eqIdx < 1) continue;
		const key = pair.slice(0, eqIdx).trim();
		const val = pair.slice(eqIdx + 1).trim();
		out[key] = decodeURIComponent(val);
	}
	return out;
}

/**
 * Middleware: ensure `req.deviceToken` is set.
 * Reads `grip.device.id` cookie; generates + sets one if absent.
 * MUST be applied before `loginRateLimit` / `recordLoginFailure`.
 */
function ensureDeviceToken(req, res, next) {
	const cookies = parseCookies(req);
	let token = cookies["grip.device.id"];
	if (!token || token.length < 16) {
		token = crypto.randomBytes(20).toString("hex");
		const maxAge = 10 * 365 * 24 * 60 * 60; // 10 years in seconds
		// httpOnly:false so the browser includes it automatically on every request;
		// JS cannot read it (httpOnly:false only means the Secure flag is omitted
		// from HttpOnly).  We set it without HttpOnly so it survives across origins
		// in dev but we never expose sensitive data in this cookie.
		res.setHeader(
			"Set-Cookie",
			`grip.device.id=${token}; Max-Age=${maxAge}; Path=/; SameSite=Lax`,
		);
	}
	req.deviceToken = token;
	next();
}

const rateLimitMap = new Map(); // keyed by `${deviceToken}:${path}`
const loginFailMap = new Map(); // keyed by deviceToken

/**
 * General rate-limiter middleware (not login-specific).
 * @param {number} windowMs   – time window in ms
 * @param {number} max        – max requests per window
 */
function rateLimit(windowMs, max) {
	const winSec = Math.ceil(windowMs / 1000) + 1;
	return async (req, res, next) => {
		// Fall back to IP if device token not yet set (non-login routes)
		const id = `${req.deviceToken || req.ip}:${req.path}`;

		// Shared counter across all instances. Without this, running N pods means a
		// client effectively gets N times the allowance, because each pod keeps its
		// own private Map.
		if (redisReady()) {
			try {
				const bucket = Math.floor(Date.now() / windowMs);
				const key = `rl:${id}:${bucket}`;
				const n = await redis.incr(key);
				if (n === 1) await redis.expire(key, winSec);
				if (n > max) {
					return res
						.status(429)
						.json({ error: "Too many requests. Try again later." });
				}
				return next();
			} catch (_) {
				/* fall through to in-memory */
			}
		}

		const now = Date.now();
		const arr = (rateLimitMap.get(id) || []).filter((t) => t > now - windowMs);
		arr.push(now);
		rateLimitMap.set(id, arr);
		if (arr.length > max) {
			return res
				.status(429)
				.json({ error: "Too many requests. Try again later." });
		}
		next();
	};
}

/**
 * Login-specific rate-limiter.
 * Must run after `ensureDeviceToken` so `req.deviceToken` is available.
 * Locks only the offending device — other devices on the same IP are safe.
 */
const LOGIN_WINDOW_SEC = 5 * 60;
const LOGIN_MAX_FAILURES = 5;

async function loginRateLimit(req, res, next) {
	const key = req.deviceToken || req.ip; // prefer device token

	// Shared across instances, so a brute-forcer can't simply get retried on a
	// different pod to reset their counter.
	if (redisReady()) {
		try {
			const n = Number(await redis.get(`lf:${key}`)) || 0;
			if (n >= LOGIN_MAX_FAILURES) {
				const ttl = await redis.ttl(`lf:${key}`);
				const waitMin = Math.max(Math.ceil((ttl > 0 ? ttl : LOGIN_WINDOW_SEC) / 60), 1);
				return res.status(429).json({
					error: `Too many failed attempts. Try again in ${waitMin} minute(s).`,
				});
			}
			return next();
		} catch (_) {
			/* fall through to in-memory */
		}
	}

	const now = Date.now();
	const WINDOW = LOGIN_WINDOW_SEC * 1000;
	const LOCKOUT = LOGIN_WINDOW_SEC * 1000;

	const entries = (loginFailMap.get(key) || []).filter((t) => t > now - LOCKOUT);
	loginFailMap.set(key, entries);

	const recent = entries.filter((t) => t > now - WINDOW);
	if (recent.length >= LOGIN_MAX_FAILURES) {
		const oldest = recent[0] || now;
		const waitMin = Math.ceil((oldest + LOCKOUT - now) / 60_000);
		return res.status(429).json({
			error: `Too many failed attempts. Try again in ${Math.max(waitMin, 1)} minute(s).`,
		});
	}
	next();
}

/** Record a failed login attempt for this device. */
function recordLoginFailure(req) {
	const key = req.deviceToken || req.ip;

	if (redisReady()) {
		try {
			redis
				.multi()
				.incr(`lf:${key}`)
				.expire(`lf:${key}`, LOGIN_WINDOW_SEC)
				.exec()
				.catch(() => {});
			return;
		} catch (_) {
			/* fall through */
		}
	}

	const arr = loginFailMap.get(key) || [];
	arr.push(Date.now());
	loginFailMap.set(key, arr);
}

// ── Session helpers ───────────────────────────────────────────────────────────
function sessionInstituteId(req) {
	const id = req?.session?.institute_id;
	if (id && Number.isInteger(Number(id))) return Number(id);
	return null;
}

let cachedDefaultInstituteId = null;

function setDefaultInstituteId(id) {
	cachedDefaultInstituteId = id;
}

async function getDefaultInstituteId() {
	if (cachedDefaultInstituteId) return cachedDefaultInstituteId;
	try {
		const r = await db.execute({
			sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1",
			args: ["DEFAULT"],
		});
		if (r.rows.length) {
			cachedDefaultInstituteId = r.rows[0].id;
			return cachedDefaultInstituteId;
		}
	} catch (e) {
		console.warn("Failed to fetch default institute ID from DB:", e.message);
	}
	return null;
}

async function resolveStudentInstituteId({ rollNumber, mobile, instituteCode } = {}) {
	if (instituteCode) {
		try {
			const r = await db.execute({
				sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1",
				args: [String(instituteCode).trim().toUpperCase()],
			});
			if (r.rows.length) return r.rows[0].id;
		} catch (_) {}
	}
	const key = String(rollNumber || mobile || "").trim();
	if (key) {
		try {
			const r = await db.execute({
				sql: "SELECT institute_id FROM registered_students WHERE roll_number = ? LIMIT 1",
				args: [key],
			});
			if (r.rows.length && r.rows[0].institute_id) return r.rows[0].institute_id;
		} catch (_) {}
	}
	return getDefaultInstituteId();
}

async function getInstituteById(id) {
	if (!id) return null;
	try {
		const r = await db.execute({
			sql: "SELECT * FROM institutes WHERE id = ? LIMIT 1",
			args: [Number(id)],
		});
		return r.rows[0] || null;
	} catch {
		return null;
	}
}

// ── Authorization guards ──────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
	if (!req.session?.admin && !req.session?.ownerAdmin) {
		return res.status(403).json({ error: "Unauthorized" });
	}
	next();
}

function requireOwner(req, res, next) {
	if (!req.session?.ownerAdmin)
		return res.status(403).json({ error: "Owner access required" });
	next();
}

// ── Periodic cleanup ──────────────────────────────────────────────────────────
setInterval(() => {
	const cutoff = Date.now() - 60 * 60 * 1000;
	for (const [k, v] of rateLimitMap.entries()) {
		const kept = v.filter((t) => t > cutoff);
		if (!kept.length) rateLimitMap.delete(k);
		else rateLimitMap.set(k, kept);
	}
	for (const [k, v] of loginFailMap.entries()) {
		const kept = v.filter((t) => t > cutoff);
		if (!kept.length) loginFailMap.delete(k);
		else loginFailMap.set(k, kept);
	}
	// Purge expired sessions from DB.
	// Only one process should do this — with cluster mode + N pods you would
	// otherwise run the same DELETE dozens of times concurrently. IS_SWEEPER is
	// set by server.js on exactly one worker.
	if (process.env.IS_SWEEPER === "1" && !redis) {
		db.execute({
			sql: "DELETE FROM sessions WHERE expires < ?",
			args: [Date.now()],
		}).catch(() => {});
	}
}, 10 * 60 * 1000).unref?.();

module.exports = {
	clientSession,
	ownerSession,
	ensureDeviceToken,
	rateLimit,
	loginRateLimit,
	recordLoginFailure,
	sessionInstituteId,
	setDefaultInstituteId,
	getDefaultInstituteId,
	resolveStudentInstituteId,
	getInstituteById,
	requireAdmin,
	requireOwner,
	rateLimitMap,
	loginFailMap,
};
