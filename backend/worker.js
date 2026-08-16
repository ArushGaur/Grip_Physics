"use strict";
/**
 * Worker tier entry point.  Run with:  node worker.js   (npm run worker)
 *
 * This is the SAME codebase as the API, started in a different mode. It consumes
 * the BullMQ queue and does the CPU-heavy work (DOCX build, LibreOffice PDF
 * conversion, image/canvas work) so the API pods never block their event loop.
 *
 * Deploy: 1-2 small containers using Dockerfile.worker (that image is the only
 * one that needs LibreOffice installed).
 *
 * Requires REDIS_URL and `npm install bullmq ioredis`.
 */

const { createWorker, QUEUE_NAME } = require("./utils/queue");
const { logger } = require("./config/logger");
const { closeRedis } = require("./config/redis");
const { db } = require("./config/db");

// Paper generation functions are exported by the paper router module.
const paper = require("./routes/paper");

async function processor(job) {
	const { name, data } = job;
	logger.info({ job: name, id: job.id }, "worker: job start");

	switch (name) {
		case "paper-docx": {
			const { progressId, body, instId } = data;
			await paper.generatePaperDocxBackground(progressId, body, instId);
			return { ok: true };
		}
		case "paper-pdf": {
			const { progressId, body, instId } = data;
			await paper.generatePaperPdfBackground(progressId, body, instId);
			return { ok: true };
		}
		default:
			throw new Error(`Unknown job type: ${name}`);
	}
}

const worker = createWorker(processor);

worker.on("completed", (job) => logger.info({ id: job.id, name: job.name }, "worker: job done"));
worker.on("failed", (job, err) =>
	logger.error({ id: job?.id, name: job?.name, err: err?.message }, "worker: job failed")
);

logger.info({ queue: QUEUE_NAME }, "worker tier started");

async function shutdown(signal) {
	logger.warn({ signal }, "worker shutting down");
	try { await worker.close(); } catch (_) {}
	try { await db.pool.end(); } catch (_) {}
	await closeRedis();
	process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => logger.error({ err }, "worker unhandledRejection"));
