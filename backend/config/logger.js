"use strict";
/**
 * Structured, low-cost logging.
 *
 * The old code did `console.log` on EVERY request. When stdout is a pipe (which
 * it is in Docker/Sevalla) that write is synchronous and becomes one of the top
 * CPU costs at a few thousand rps. This module:
 *   - uses pino when installed (async, ~10x cheaper than console.log)
 *   - falls back to console when it isn't
 *   - samples access logs (LOG_SAMPLE_RATE, default 1%)
 *   - always logs slow requests and 5xx responses, whatever the sample rate
 */

let pino = null;
try {
	// eslint-disable-next-line global-require
	pino = require("pino");
} catch (_) {
	pino = null;
}

const LEVEL = process.env.LOG_LEVEL || "info";

const logger = pino
	? pino({
			level: LEVEL,
			base: { pid: process.pid },
			redact: {
				paths: [
					'req.headers.cookie',
					'req.headers.authorization',
					'password',
					'passcode',
					'code',
				],
				censor: "[redacted]",
			},
			timestamp: pino.stdTimeFunctions.isoTime,
		})
	: {
			info: (...a) => console.log(...a),
			warn: (...a) => console.warn(...a),
			error: (...a) => console.error(...a),
			debug: () => {},
			fatal: (...a) => console.error(...a),
		};

const SAMPLE = Number(process.env.LOG_SAMPLE_RATE || 0.01); // 1% of requests
const SLOW_MS = Number(process.env.LOG_SLOW_MS || 1000);

/**
 * Express access-log middleware. Replaces the old per-request console.log.
 * Cost at 1% sampling is negligible even at several thousand rps.
 */
function accessLog(req, res, next) {
	const start = process.hrtime.bigint();
	res.on("finish", () => {
		const ms = Number(process.hrtime.bigint() - start) / 1e6;
		const interesting = res.statusCode >= 500 || ms >= SLOW_MS;
		if (!interesting && Math.random() > SAMPLE) return;
		const rec = {
			method: req.method,
			path: req.path,
			status: res.statusCode,
			ms: Math.round(ms),
		};
		if (res.statusCode >= 500) logger.error(rec, "request failed");
		else if (ms >= SLOW_MS) logger.warn(rec, "slow request");
		else logger.info(rec, "request");
	});
	next();
}

module.exports = { logger, accessLog };
