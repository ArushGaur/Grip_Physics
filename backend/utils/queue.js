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

/**
 * Try to enqueue a job.
 * @returns {Promise<boolean>} true if queued, false if the caller must run inline.
 */
async function enqueue(name, payload) {
	const q = getQueue();
	if (!q) return false;
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

module.exports = { enqueue, createWorker, closeQueue, QUEUE_NAME, queueEnabled: () => !!getQueue() };
