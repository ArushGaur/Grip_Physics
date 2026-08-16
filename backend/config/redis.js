"use strict";
/**
 * Optional Redis client.
 *
 * Design goal: the app MUST boot and run correctly with no Redis at all.
 * - If `ioredis` is not installed, or REDIS_URL is not set, `redis` is null and
 *   every caller silently falls back to in-process behaviour (single instance).
 * - As soon as REDIS_URL is set, sessions / rate limits / caches / paper-gen
 *   progress become shared across every instance, which is what makes the API
 *   tier horizontally scalable.
 *
 * Sevalla today:   leave REDIS_URL unset -> works exactly like before.
 * Hostinger later: set REDIS_URL=redis://default:pass@host:6379 -> multi-instance.
 */

let redis = null;
let lastErrLog = 0;

const REDIS_URL =
	process.env.REDIS_URL ||
	process.env.REDIS_URI ||
	process.env.REDIS_CONNECTION_STRING ||
	"";

if (REDIS_URL) {
	try {
		// eslint-disable-next-line global-require
		const IORedis = require("ioredis");
		redis = new IORedis(REDIS_URL, {
			maxRetriesPerRequest: 2,
			// Never queue commands while disconnected: we would rather fail fast and
			// fall back to the DB than build an unbounded backlog during an incident.
			enableOfflineQueue: false,
			connectTimeout: 5000,
			keepAlive: 15000,
			retryStrategy: (times) => Math.min(times * 200, 5000),
			tls: REDIS_URL.startsWith("rediss://") ? {} : undefined,
		});
		redis.on("error", (e) => {
			// Throttle: a down Redis would otherwise flood stdout at request rate.
			const now = Date.now();
			if (now - lastErrLog > 30000) {
				lastErrLog = now;
				console.warn("[redis] error:", e.message);
			}
		});
		redis.on("connect", () => console.log("[redis] connected"));
	} catch (e) {
		console.warn(
			"[redis] REDIS_URL is set but `ioredis` is not installed — run `npm install ioredis`. Falling back to in-memory."
		);
		redis = null;
	}
} else {
	console.log("[redis] REDIS_URL not set — running in single-instance in-memory mode.");
}

/** True when a shared Redis is usable right now. */
function redisReady() {
	return !!redis && redis.status === "ready";
}

async function closeRedis() {
	if (!redis) return;
	try {
		await redis.quit();
	} catch (_) {
		try { redis.disconnect(); } catch (_e) {}
	}
}

module.exports = { redis, redisReady, closeRedis, REDIS_URL };
