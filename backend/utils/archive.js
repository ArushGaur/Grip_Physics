"use strict";
/**
 * test_history archiving.
 *
 * Why: at 500 institutes x 200 students x ~50 tests/year the table grows by
 * millions of rows a year, each carrying answers_json. Every index on it gets
 * bigger, autovacuum takes longer, and the institute dashboards that scan by
 * (institute_id, timestamp) slow down for everyone.
 *
 * What this does: moves attempts older than ARCHIVE_AFTER_DAYS into
 * test_history_archive (same shape) in small batches. Nothing is deleted - the
 * rows stay queryable for reports, just out of the hot table.
 *
 * Safety:
 *   - Disabled unless ARCHIVE_ENABLED=1, so it can never surprise you.
 *   - Runs on the sweeper worker ONLY (server.js sets IS_SWEEPER=1 on exactly
 *     one worker), otherwise N workers race on the same rows.
 *   - Batched + capped per cycle so it never holds a long transaction during
 *     an exam window.
 */

const { db } = require("../config/db");

const ENABLED = process.env.ARCHIVE_ENABLED === "1";
const AFTER_DAYS = Number(process.env.ARCHIVE_AFTER_DAYS || 365);
const BATCH = Number(process.env.ARCHIVE_BATCH || 500);
const MAX_PER_CYCLE = Number(process.env.ARCHIVE_MAX_PER_CYCLE || 20000);
const INTERVAL_MS = Number(process.env.ARCHIVE_INTERVAL_HOURS || 24) * 3600 * 1000;

async function ensureArchiveTable() {
	await db.execute(
		"CREATE TABLE IF NOT EXISTS test_history_archive (LIKE test_history INCLUDING DEFAULTS)"
	);
	await db.execute(
		"CREATE INDEX IF NOT EXISTS idx_tha_inst_ts ON test_history_archive(institute_id, timestamp DESC)"
	);
}

/** Move one batch. Returns how many rows were moved. */
async function archiveBatch(cutoff) {
	// Single statement: the DELETE ... RETURNING feeds the INSERT, so a row can
	// never be deleted without being written to the archive.
	const res = await db.execute({
		sql: "WITH doomed AS (SELECT id FROM test_history WHERE timestamp < ? ORDER BY id LIMIT ?), moved AS (DELETE FROM test_history WHERE id IN (SELECT id FROM doomed) RETURNING *) INSERT INTO test_history_archive SELECT * FROM moved",
		args: [cutoff, BATCH],
	});
	return res.rowsAffected || 0;
}

async function runArchiveCycle() {
	const cutoff = Date.now() - AFTER_DAYS * 24 * 3600 * 1000;
	let total = 0;
	try {
		await ensureArchiveTable();
		while (total < MAX_PER_CYCLE) {
			const moved = await archiveBatch(cutoff);
			if (!moved) break;
			total += moved;
			// Breathe between batches so we never monopolise the pool.
			await new Promise((r) => setTimeout(r, 250));
		}
		if (total) console.log("[archive] moved " + total + " test_history rows older than " + AFTER_DAYS + "d");
	} catch (e) {
		console.error("[archive] cycle failed:", e.message);
	}
	return total;
}

function startArchiveJob() {
	if (!ENABLED) return false;
	if (process.env.IS_SWEEPER === "0") return false;
	console.log("[archive] enabled - rows older than " + AFTER_DAYS + "d every " + (INTERVAL_MS / 3600000) + "h");
	// Delay the first run so it never collides with boot/migrations.
	setTimeout(runArchiveCycle, 60 * 1000).unref?.();
	setInterval(runArchiveCycle, INTERVAL_MS).unref?.();
	return true;
}

module.exports = { startArchiveJob, runArchiveCycle, ensureArchiveTable };
