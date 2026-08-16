"use strict";
/**
 * Two-tier cache: Redis (shared, when configured) -> in-process LRU (always).
 *
 * Why two tiers:
 *  - Without Redis you still get the single-instance win (a 40k-request burst
 *    for the same test payload collapses into one DB read per instance).
 *  - With Redis it collapses to one DB read across the whole fleet.
 *
 * Values are stored as PRE-SERIALIZED JSON strings. At burst time we can then
 * `res.type("json").send(str)` and skip JSON.stringify entirely, which is a real
 * cost once payloads are ~200KB and thousands of students start at 9:00 sharp.
 */

const { redis } = require("./redis");

const MAX_LOCAL_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 500);
const local = new Map(); // key -> { v: string, exp: number }

function localGet(key) {
	const hit = local.get(key);
	if (!hit) return null;
	if (Date.now() > hit.exp) {
		local.delete(key);
		return null;
	}
	// refresh recency (Map preserves insertion order -> cheap LRU)
	local.delete(key);
	local.set(key, hit);
	return hit.v;
}

function localSet(key, value, ttlSec) {
	if (local.size >= MAX_LOCAL_ENTRIES) {
		const oldest = local.keys().next().value;
		if (oldest !== undefined) local.delete(oldest);
	}
	local.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
}

/** Get a raw cached JSON string, or null. Never throws. */
async function getRaw(key) {
	const l = localGet(key);
	if (l !== null) return l;
	if (!redis) return null;
	try {
		const v = await redis.get(key);
		if (v != null) {
			// Keep a short local copy so the hottest keys don't even hit Redis.
			localSet(key, v, Number(process.env.CACHE_LOCAL_TTL || 10));
			return v;
		}
	} catch (_) {}
	return null;
}

/** Store a raw JSON string. Never throws. */
async function setRaw(key, value, ttlSec) {
	localSet(key, value, Math.min(ttlSec, Number(process.env.CACHE_LOCAL_TTL || 10)));
	if (!redis) return;
	try {
		await redis.set(key, value, "EX", ttlSec);
	} catch (_) {}
}

async function del(key) {
	local.delete(key);
	if (!redis) return;
	try {
		await redis.del(key);
	} catch (_) {}
}

/**
 * Cache-aside helper returning a parsed object.
 *
 * @param {string} key
 * @param {number} ttlSec
 * @param {() => Promise<any>} producer  called only on miss
 */
async function getOrSet(key, ttlSec, producer) {
	const cached = await getRaw(key);
	if (cached !== null) {
		try {
			return JSON.parse(cached);
		} catch (_) {
			await del(key);
		}
	}
	const fresh = await producer();
	try {
		await setRaw(key, JSON.stringify(fresh), ttlSec);
	} catch (_) {}
	return fresh;
}

/** Drop every cached entry for one online test (call after a teacher edits it). */
async function invalidateTest(testId) {
	await del(`tq:v1:${testId}`);
}

function stats() {
	return { localEntries: local.size, redis: !!redis };
}

module.exports = { getRaw, setRaw, del, getOrSet, invalidateTest, stats };
