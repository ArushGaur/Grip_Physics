"use strict";
/**
 * Shared paper-generation progress store.
 *
 * Problem this fixes: paper.js kept progress in `global.paperGenProgress`.
 * With more than one instance behind a load balancer, the browser's polling
 * GET /generate-paper/progress/:id lands on a DIFFERENT instance than the one
 * doing the work, so the user gets a permanent 404 and the UI hangs.
 *
 * Approach: keep the exact same synchronous object API that paper.js already
 * uses (`store[id] = {...}` and `store[id].pct = 40`), but mirror every write
 * to Redis via a Proxy. Reads that miss locally fall back to Redis through the
 * async `getProgress()` helper. No call sites in paper.js have to change.
 */

const { redis } = require("../config/redis");

const TTL_SEC = Number(process.env.PAPER_PROGRESS_TTL || 3600);
const KEY = (id) => `pgp:${id}`;

const local = Object.create(null);

function mirror(id) {
	if (!redis) return;
	const v = local[id];
	try {
		if (v === undefined) redis.del(KEY(id)).catch(() => {});
		else redis.set(KEY(id), JSON.stringify(v), "EX", TTL_SEC).catch(() => {});
	} catch (_) {}
}

// Wraps the per-job object so nested writes (`progress[id].pct = 50`) mirror too.
function wrapInner(id, obj) {
	return new Proxy(obj, {
		set(target, prop, value) {
			target[prop] = value;
			mirror(id);
			return true;
		},
		deleteProperty(target, prop) {
			delete target[prop];
			mirror(id);
			return true;
		},
	});
}

const progress = new Proxy(local, {
	get(target, prop) {
		const v = target[prop];
		if (v && typeof v === "object" && typeof prop === "string") return wrapInner(prop, v);
		return v;
	},
	set(target, prop, value) {
		target[prop] = value;
		if (typeof prop === "string") mirror(prop);
		return true;
	},
	deleteProperty(target, prop) {
		delete target[prop];
		if (typeof prop === "string" && redis) redis.del(KEY(prop)).catch(() => {});
		return true;
	},
});

/**
 * Read progress from this instance, else from Redis (job ran on another pod).
 * @returns {Promise<object|null>}
 */
async function getProgress(id) {
	if (local[id]) return local[id];
	if (!redis) return null;
	try {
		const raw = await redis.get(KEY(id));
		return raw ? JSON.parse(raw) : null;
	} catch (_) {
		return null;
	}
}

async function clearProgress(id) {
	delete local[id];
	if (redis) {
		try { await redis.del(KEY(id)); } catch (_) {}
	}
}

// Local entries are only a cache of Redis (or the whole truth without Redis).
// Sweep finished/stale jobs so a long-lived pod doesn't leak memory.
setInterval(() => {
	const cutoff = Date.now() - TTL_SEC * 1000;
	for (const id of Object.keys(local)) {
		const job = local[id];
		if (!job) { delete local[id]; continue; }
		if (!job.createdAt) job.createdAt = Date.now();
		if (job.createdAt < cutoff) delete local[id];
	}
}, 10 * 60 * 1000).unref?.();

module.exports = { progress, getProgress, clearProgress };
