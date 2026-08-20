"use strict";
/**
 * Shared paper-generation progress store.
 *
 * Problem this fixes: paper.js kept progress in `global.paperGenProgress`, a
 * plain per-process object. server.js runs a CLUSTER of web workers, so the
 * browser polling GET /generate-paper/progress/:id very often lands on a
 * different worker than the POST that started the job. That worker knows
 * nothing about the id and answered 404 -> "Progress session not found or
 * expired", even though the render was going fine.
 *
 * Approach: keep the exact same synchronous object API that paper.js already
 * uses (store[id] = {...} and store[id].pct = 40), but mirror every write to:
 *   1. the cluster primary, over Node's built-in IPC channel (no external
 *      service needed - this is what fixes the 404), and
 *   2. Redis, when configured (several containers behind a load balancer).
 * Reads that miss locally fall back to the primary, then Redis, through the
 * async getProgress() helper. No call sites in paper.js have to change.
 */

const cluster = require("cluster");
const { redis } = require("../config/redis");

const TTL_SEC = Number(process.env.PAPER_PROGRESS_TTL || 3600);
const KEY = (id) => `pgp:${id}`;
const TAG = "__paperProgress__";

const local = Object.create(null);

/* ----------------------------- cluster primary ---------------------------- */

const primaryStore = new Map();
let brokerInstalled = false;

/**
 * Install the IPC broker in the cluster primary. Safe to call repeatedly and a
 * no-op inside worker processes.
 */
function installClusterBroker() {
	if (brokerInstalled || !cluster.isPrimary) return;
	brokerInstalled = true;

	cluster.on("message", (worker, msg) => {
		if (!msg || msg.tag !== TAG) return;
		if (msg.op === "set") {
			if (msg.value === undefined || msg.value === null) primaryStore.delete(msg.id);
			else primaryStore.set(msg.id, msg.value);
		} else if (msg.op === "del") {
			primaryStore.delete(msg.id);
		} else if (msg.op === "get") {
			const value = primaryStore.has(msg.id) ? primaryStore.get(msg.id) : null;
			try { worker.send({ tag: TAG, op: "res", rid: msg.rid, value }); } catch (_) {}
		}
	});

	const sweeper = setInterval(() => {
		const cutoff = Date.now() - TTL_SEC * 1000;
		for (const [id, job] of primaryStore) {
			if (!job || !job.createdAt || job.createdAt < cutoff) primaryStore.delete(id);
		}
	}, 10 * 60 * 1000);
	if (sweeper.unref) sweeper.unref();
}

if (cluster.isPrimary) installClusterBroker();

/* ------------------------------ cluster worker ---------------------------- */

const isClusterWorker = !cluster.isPrimary && typeof process.send === "function";
const pendingGets = new Map();
let ridSeq = 0;

if (isClusterWorker) {
	process.on("message", (msg) => {
		if (!msg || msg.tag !== TAG || msg.op !== "res") return;
		const resolve = pendingGets.get(msg.rid);
		if (resolve) { pendingGets.delete(msg.rid); resolve(msg.value || null); }
	});
}

function tellPrimary(op, id, value) {
	if (!isClusterWorker) return;
	try { process.send({ tag: TAG, op, id, value }); } catch (_) {}
}

function askPrimary(id) {
	if (!isClusterWorker) return Promise.resolve(null);
	return new Promise((resolve) => {
		const rid = ++ridSeq;
		pendingGets.set(rid, resolve);
		const timer = setTimeout(() => {
			if (pendingGets.delete(rid)) resolve(null);
		}, 5000);
		if (timer.unref) timer.unref();
		try {
			process.send({ tag: TAG, op: "get", id, rid });
		} catch (_) {
			pendingGets.delete(rid);
			resolve(null);
		}
	});
}

/* ---------------------------------- writes -------------------------------- */

function mirror(id) {
	const v = local[id];

	// 1. cluster primary (always available, needs no configuration)
	tellPrimary(v === undefined ? "del" : "set", id, v === undefined ? null : v);

	// 2. Redis, for multi-container deployments
	if (!redis) return;
	try {
		if (v === undefined) {
			redis.del(KEY(id)).catch(() => {});
			return;
		}
		// Finished jobs carry base64 documents that can run to tens of megabytes.
		// Mirroring those would stall (or be rejected by) Redis, so only the status
		// travels; the files stay reachable through this container.
		let payload = JSON.stringify(v);
		if (payload.length > 512 * 1024) {
			const slim = { ...v };
			delete slim.files;
			slim.filesLocalOnly = true;
			payload = JSON.stringify(slim);
		}
		redis.set(KEY(id), payload, "EX", TTL_SEC).catch(() => {});
	} catch (_) {}
}

// Wraps the per-job object so nested writes (progress[id].pct = 50) mirror too.
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
		if (typeof prop === "string") {
			tellPrimary("del", prop, null);
			if (redis) redis.del(KEY(prop)).catch(() => {});
		}
		return true;
	},
});

/* ---------------------------------- reads --------------------------------- */

/**
 * Read progress from this process, else from the cluster primary (a sibling
 * worker is rendering it), else from Redis (another container).
 * @returns {Promise<object|null>}
 */
async function getProgress(id) {
	if (local[id]) return local[id];
	if (cluster.isPrimary && primaryStore.has(id)) return primaryStore.get(id);

	const fromPrimary = await askPrimary(id);
	if (fromPrimary) return fromPrimary;

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
	tellPrimary("del", id, null);
	if (cluster.isPrimary) primaryStore.delete(id);
	if (redis) {
		try { await redis.del(KEY(id)); } catch (_) {}
	}
}

// Local entries are only a cache. Sweep finished/stale jobs so a long-lived
// process does not leak memory.
const localSweeper = setInterval(() => {
	const cutoff = Date.now() - TTL_SEC * 1000;
	for (const id of Object.keys(local)) {
		const job = local[id];
		if (!job) { delete local[id]; continue; }
		if (!job.createdAt) job.createdAt = Date.now();
		if (job.createdAt < cutoff) delete local[id];
	}
}, 10 * 60 * 1000);
if (localSweeper.unref) localSweeper.unref();

module.exports = { progress, getProgress, clearProgress, installClusterBroker };
