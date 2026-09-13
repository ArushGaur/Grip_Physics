"use strict";
/**
 * Optional BullMQ job queue for CPU-heavy work (DOCX/PDF generation, extraction).
 *
 * Why: paper generation uses `docx`, `pdfkit`, `@napi-rs/canvas`, `mammoth` and
 * LibreOffice. Each run blocks the event loop for SECONDS. On a shared API pod
 * that stalls every concurrent student request. Moving it to a worker tier is
 * what lets the API pods stay latency-flat during exam windows.
 *
 * Degradation ladder (all automatic):
 *   1. REDIS_URL + bullmq installed + WORKER tier running -> queued, off-box.
 *   2. Anything missing -> `enqueue()` returns false and the caller runs the job
 *      in-process exactly like it does today. Nothing breaks.
 */

const { REDIS_URL } = require("../config/redis");

const QUEUE_NAME = process.env.PAPER_QUEUE_NAME || "paper-jobs";
const ENABLED = !!REDIS_URL && process.env.DISABLE_QUEUE !== "1";

let Queue = null;
let Worker = null;
let queue = null;

if (ENABLED) {
	try {
		// eslint-disable-next-line global-require
		const bull = require("bullmq");
		Queue = bull.Queue;
		Worker = bull.Worker;
	} catch (_) {
		console.warn("[queue] REDIS_URL set but `bullmq` not installed — running jobs inline.");
	}
}

function connectionOpts() {
	return {
		connection: { url: REDIS_URL },
	};
}

function getQueue() {
	if (!Queue) return null;
	if (!queue) {
		try {
			queue = new Queue(QUEUE_NAME, {
				...connectionOpts(),
				defaultJobOptions: {
					attempts: 2,
					backoff: { type: "exponential", delay: 2000 },
					removeOnComplete: { age: 3600, count: 1000 },
					removeOnFail: { age: 24 * 3600 },
				},
			});
		} catch (e) {
			console.warn("[queue] init failed, running inline:", e.message);
			queue = null;
			Queue = null;
		}
	}
	return queue;
}

/* ── Is anybody actually consuming the queue? ───────────────────────────────
   THIS is what broke paper generation after the Sevalla deploy. `REDIS_URL` is
   set and `bullmq` is installed, so `enqueue()` used to return true and the API
   happily handed the job off... to a worker tier that was never deployed. The
   job sat in Redis forever and the browser polled a job stuck at 0% until it
   gave up.

   Now we only hand off work when a live worker is registered on the queue, and
   otherwise run the job in-process exactly like the pre-refactor code. Deploy a
   worker container later and it starts being used automatically - no code
   change, no env flag.

   Escape hatches:
     PAPER_QUEUE_MODE=inline  never queue (always render on the API pod)
     PAPER_QUEUE_MODE=force   queue even if no worker is visible yet
─────────────────────────────────────────────────────────────────────────── */
const MODE = (process.env.PAPER_QUEUE_MODE || "auto").toLowerCase();
const WORKER_CHECK_TTL_MS = Number(process.env.QUEUE_WORKER_CHECK_TTL_MS || 15000);
let workerCheck = { at: 0, alive: false };

async function hasLiveWorker(q) {
	if (MODE === "force") return true;
	const now = Date.now();
	// Cache: this runs on every generate request and hits Redis otherwise.
	if (now - workerCheck.at < WORKER_CHECK_TTL_MS) return workerCheck.alive;

	let alive = false;
	try {
		if (typeof q.getWorkersCount === "function") {
			alive = (await q.getWorkersCount()) > 0;
		} else if (typeof q.getWorkers === "function") {
			const workers = await q.getWorkers();
			alive = Array.isArray(workers) && workers.length > 0;
		}
	} catch (e) {
		// If we cannot tell, assume there is no worker: rendering inline is slower
		// for the teacher but always produces a file. Queuing blindly produces
		// nothing at all.
		console.warn("[queue] worker probe failed, running inline:", e.message);
		alive = false;
	}

	workerCheck = { at: now, alive };
	if (!alive) {
		console.warn(
			"[queue] no worker tier is consuming `" +
				QUEUE_NAME +
				"` - running paper jobs inline. Deploy Dockerfile.worker (`npm run worker`) to offload them."
		);
	}
	return alive;
}

/**
 * Try to enqueue a job.
 * @returns {Promise<boolean>} true if queued, false if the caller must run inline.
 */
async function enqueue(name, payload) {
	if (MODE === "inline") return false;
	const q = getQueue();
	if (!q) return false;
	if (!(await hasLiveWorker(q))) return false;
	try {
		await q.add(name, payload);
		return true;
	} catch (e) {
		console.warn("[queue] enqueue failed, running inline:", e.message);
		return false;
	}
}

/** Used by worker.js only. */
function createWorker(processor) {
	if (!Worker) {
		throw new Error(
			"bullmq + REDIS_URL are required to run the worker tier. Run `npm install bullmq` and set REDIS_URL."
		);
	}
	return new Worker(QUEUE_NAME, processor, {
		...connectionOpts(),
		// Heavy CPU jobs: keep this at 1-2 per worker container, never more.
		concurrency: Number(process.env.WORKER_CONCURRENCY || 2),
	});
}

async function closeQueue() {
	if (queue) {
		try { await queue.close(); } catch (_) {}
	}
}

module.exports = {
	enqueue,
	createWorker,
	closeQueue,
	QUEUE_NAME,
	queueEnabled: () => !!getQueue(),
	hasLiveWorker: async () => {
		const q = getQueue();
		return q ? hasLiveWorker(q) : false;
	},
};
