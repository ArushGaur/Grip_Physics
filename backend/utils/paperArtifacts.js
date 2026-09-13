"use strict";
/**
 * Shared store for FINISHED paper-generation artifacts (base64 DOCX/PDF).
 *
 * Why this file exists
 * -------------------------------------------------------------------------
 * progressStore mirrors job *status* between cluster workers / containers, but
 * it deliberately refuses to mirror the `files` payload: three base64 DOCX or
 * PDF documents are routinely 5-40 MB, which is far too big for Node's IPC
 * channel and for a single Redis string write on a hot path.
 *
 * The result after the scaling refactor was: the job completed, the poll landed
 * on a different cluster worker (or the job ran on the worker tier), and the
 * browser received `status: "completed"` with `files: undefined` -> the download
 * buttons never appeared, or "Cannot read properties of undefined".
 *
 * This module stores each document under its own key so it can be fetched by
 * ANY process:
 *   1. Redis, one key per document (questionPaper / answerKey / solutions),
 *      chunked so no single write is huge. Works across containers and is what
 *      makes the worker tier usable.
 *   2. Cluster primary over IPC, one message per chunk. Works with zero config
 *      (single Sevalla container running N cluster workers).
 *   3. Plain in-process memory (single process, no Redis).
 *
 * All three are transparent to callers: saveArtifacts / loadArtifacts.
 */

const cluster = require("cluster");
const { redis } = require("../config/redis");

const TTL_SEC = Number(process.env.PAPER_ARTIFACT_TTL || 3600);
// 4 MB per Redis value keeps each write well inside normal proto-max-bulk-len
// and avoids multi-second blocking writes on the Redis single thread.
const CHUNK = Number(process.env.PAPER_ARTIFACT_CHUNK || 4 * 1024 * 1024);
const TAG = "__paperArtifacts__";

const metaKey = (id) => `pga:${id}:meta`;
const partKey = (id, name, i) => `pga:${id}:${name}:${i}`;

/* ------------------------------- local store ------------------------------ */

const local = new Map(); // id -> { files: {name: base64}, savedAt }

function sweepLocal() {
	const cutoff = Date.now() - TTL_SEC * 1000;
	for (const [id, v] of local) if (!v || v.savedAt < cutoff) local.delete(id);
}
const localSweeper = setInterval(sweepLocal, 10 * 60 * 1000);
if (localSweeper.unref) localSweeper.unref();

/* ----------------------------- cluster primary ---------------------------- */

const primaryStore = new Map(); // id -> { files, savedAt }
let brokerInstalled = false;

/**
 * Install the artifact broker in the cluster primary. The primary holds the
 * finished documents so a poll that lands on any sibling worker can serve them.
 * Safe to call repeatedly; no-op inside workers.
 */
function installArtifactBroker() {
	if (brokerInstalled || !cluster.isPrimary) return;
	brokerInstalled = true;

	cluster.on("message", (worker, msg) => {
		if (!msg || msg.tag !== TAG) return;

		if (msg.op === "put") {
			// Chunked upload: { id, name, i, total, data }
			let entry = primaryStore.get(msg.id);
			if (!entry) {
				entry = { files: {}, parts: {}, savedAt: Date.now() };
				primaryStore.set(msg.id, entry);
			}
			entry.savedAt = Date.now();
			const bucket = (entry.parts[msg.name] = entry.parts[msg.name] || []);
			bucket[msg.i] = msg.data;
			if (bucket.filter((x) => typeof x === "string").length === msg.total) {
				entry.files[msg.name] = bucket.join("");
				delete entry.parts[msg.name];
			}
			return;
		}

		if (msg.op === "del") {
			primaryStore.delete(msg.id);
			return;
		}

		if (msg.op === "get") {
			const entry = primaryStore.get(msg.id);
			const files = entry && entry.files ? entry.files : null;
			// Reply in chunks too - a single 30 MB IPC message is what silently
			// failed before and left the browser waiting forever.
			if (!files) {
				trySend(worker, { tag: TAG, op: "res", rid: msg.rid, done: true, files: null });
				return;
			}
			for (const name of Object.keys(files)) {
				const s = files[name];
				const total = Math.max(1, Math.ceil(s.length / CHUNK));
				for (let i = 0; i < total; i++) {
					trySend(worker, {
						tag: TAG,
						op: "res",
						rid: msg.rid,
						name,
						i,
						total,
						data: s.slice(i * CHUNK, (i + 1) * CHUNK),
					});
				}
			}
			trySend(worker, { tag: TAG, op: "res", rid: msg.rid, done: true });
		}
	});

	const sweeper = setInterval(() => {
		const cutoff = Date.now() - TTL_SEC * 1000;
		for (const [id, v] of primaryStore) if (!v || v.savedAt < cutoff) primaryStore.delete(id);
	}, 10 * 60 * 1000);
	if (sweeper.unref) sweeper.unref();
}

function trySend(target, msg) {
	try {
		target.send(msg);
	} catch (_) {}
}

if (cluster.isPrimary) installArtifactBroker();

/* ------------------------------ cluster worker ---------------------------- */

const isClusterWorker = !cluster.isPrimary && typeof process.send === "function";
const pendingGets = new Map(); // rid -> { files, resolve, timer }
let ridSeq = 0;

if (isClusterWorker) {
	process.on("message", (msg) => {
		if (!msg || msg.tag !== TAG || msg.op !== "res") return;
		const pending = pendingGets.get(msg.rid);
		if (!pending) return;

		if (msg.done) {
			pendingGets.delete(msg.rid);
			clearTimeout(pending.timer);
			const names = Object.keys(pending.parts);
			if (!names.length) return pending.resolve(null);
			const files = {};
			for (const name of names) files[name] = pending.parts[name].join("");
			return pending.resolve(files);
		}

		if (typeof msg.name === "string") {
			const bucket = (pending.parts[msg.name] = pending.parts[msg.name] || []);
			bucket[msg.i] = msg.data;
			// A big transfer legitimately takes a while; keep extending the deadline
			// while data is still arriving instead of timing out mid-download.
			clearTimeout(pending.timer);
			pending.timer = setTimeout(() => {
				if (pendingGets.delete(msg.rid)) pending.resolve(null);
			}, 15000);
			if (pending.timer.unref) pending.timer.unref();
		}
	});
}

function putToPrimary(id, files) {
	if (!isClusterWorker) return;
	for (const name of Object.keys(files)) {
		const s = files[name];
		if (typeof s !== "string" || !s.length) continue;
		const total = Math.max(1, Math.ceil(s.length / CHUNK));
		for (let i = 0; i < total; i++) {
			trySend(process, {
				tag: TAG,
				op: "put",
				id,
				name,
				i,
				total,
				data: s.slice(i * CHUNK, (i + 1) * CHUNK),
			});
		}
	}
}

function getFromPrimary(id) {
	if (!isClusterWorker) return Promise.resolve(null);
	return new Promise((resolve) => {
		const rid = ++ridSeq;
		const timer = setTimeout(() => {
			if (pendingGets.delete(rid)) resolve(null);
		}, 15000);
		if (timer.unref) timer.unref();
		pendingGets.set(rid, { parts: {}, resolve, timer });
		try {
			process.send({ tag: TAG, op: "get", id, rid });
		} catch (_) {
			pendingGets.delete(rid);
			clearTimeout(timer);
			resolve(null);
		}
	});
}

/* ---------------------------------- Redis --------------------------------- */

async function saveToRedis(id, files) {
	if (!redis) return false;
	const meta = {};
	try {
		for (const name of Object.keys(files)) {
			const s = files[name];
			if (typeof s !== "string" || !s.length) continue;
			const total = Math.max(1, Math.ceil(s.length / CHUNK));
			for (let i = 0; i < total; i++) {
				await redis.set(partKey(id, name, i), s.slice(i * CHUNK, (i + 1) * CHUNK), "EX", TTL_SEC);
			}
			meta[name] = total;
		}
		if (!Object.keys(meta).length) return false;
		await redis.set(metaKey(id), JSON.stringify(meta), "EX", TTL_SEC);
		return true;
	} catch (e) {
		console.warn("[paperArtifacts] redis save failed:", e.message);
		return false;
	}
}

async function loadFromRedis(id) {
	if (!redis) return null;
	try {
		const raw = await redis.get(metaKey(id));
		if (!raw) return null;
		const meta = JSON.parse(raw);
		const files = {};
		for (const name of Object.keys(meta)) {
			const total = Number(meta[name]) || 0;
			const parts = [];
			for (let i = 0; i < total; i++) {
				const part = await redis.get(partKey(id, name, i));
				// A missing chunk means a partial expiry: treat the whole artifact as
				// gone rather than handing the browser a corrupt file.
				if (part == null) return null;
				parts.push(part);
			}
			files[name] = parts.join("");
		}
		return Object.keys(files).length ? files : null;
	} catch (e) {
		console.warn("[paperArtifacts] redis load failed:", e.message);
		return null;
	}
}

async function deleteFromRedis(id) {
	if (!redis) return;
	try {
		const raw = await redis.get(metaKey(id));
		if (raw) {
			const meta = JSON.parse(raw);
			const keys = [metaKey(id)];
			for (const name of Object.keys(meta)) {
				for (let i = 0; i < (Number(meta[name]) || 0); i++) keys.push(partKey(id, name, i));
			}
			await redis.del(...keys);
		}
	} catch (_) {}
}

/* ------------------------------- public API ------------------------------- */

/**
 * Persist the finished documents for a job so any process can serve them.
 * @param {string} id progressId
 * @param {{[name:string]: string}} files base64 documents
 */
async function saveArtifacts(id, files) {
	if (!id || !files || typeof files !== "object") return;

	local.set(id, { files, savedAt: Date.now() });
	putToPrimary(id, files);
	if (cluster.isPrimary) primaryStore.set(id, { files, parts: {}, savedAt: Date.now() });
	await saveToRedis(id, files);
}

/**
 * Fetch the finished documents for a job: this process, then the cluster
 * primary, then Redis.
 * @returns {Promise<object|null>}
 */
async function loadArtifacts(id) {
	if (!id) return null;

	const mine = local.get(id);
	if (mine && mine.files) return mine.files;

	if (cluster.isPrimary) {
		const entry = primaryStore.get(id);
		if (entry && entry.files && Object.keys(entry.files).length) return entry.files;
	}

	const fromPrimary = await getFromPrimary(id);
	if (fromPrimary && Object.keys(fromPrimary).length) {
		local.set(id, { files: fromPrimary, savedAt: Date.now() });
		return fromPrimary;
	}

	const fromRedis = await loadFromRedis(id);
	if (fromRedis) {
		local.set(id, { files: fromRedis, savedAt: Date.now() });
		return fromRedis;
	}

	return null;
}

async function clearArtifacts(id) {
	if (!id) return;
	local.delete(id);
	if (cluster.isPrimary) primaryStore.delete(id);
	if (isClusterWorker) trySend(process, { tag: TAG, op: "del", id });
	await deleteFromRedis(id);
}

module.exports = { saveArtifacts, loadArtifacts, clearArtifacts, installArtifactBroker };
