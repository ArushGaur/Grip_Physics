"use strict";
/**
 * migrate-institute-indexes.js
 *
 * Multi-institute performance + integrity migration. Safe to re-run any number
 * of times — every step is idempotent and non-fatal steps are logged and skipped.
 *
 * What it does, in order:
 *
 *   1. Adds the new student columns: `email` and `section` on registered_students
 *      and student_requests, plus the `student_otps` table for email OTP login.
 *   2. Creates COMPOSITE indexes that actually match the app's queries
 *      (institute_id FIRST, then the filter column, then the sort column).
 *   3. Drops the now-redundant single-column institute_id indexes.
 *   4. Replaces the two GLOBAL unique constraints with per-institute ones.
 *      (attendance UNIQUE(roll_number, date) currently stops two institutes
 *       from marking the same roll number present on the same day.)
 *   5. Backfills NULL institute_id rows, then applies NOT NULL + FOREIGN KEY.
 *   6. Enables pg_trgm and adds trigram indexes so partial name/email search
 *      can use an index instead of scanning.
 *
 * USAGE:
 *   cd backend
 *   node migrate-institute-indexes.js           # dry run — prints the plan
 *   node migrate-institute-indexes.js --yes     # apply
 *   node migrate-institute-indexes.js --yes --skip-constraints
 *                                               # indexes only, no NOT NULL/FK
 *
 * Indexes are created with CONCURRENTLY so the tables are never locked. That
 * means each CREATE INDEX runs outside a transaction — if one fails it leaves
 * an INVALID index behind, which this script detects and drops on the next run.
 */

const { db } = require("./config/db");

const APPLY = process.argv.includes("--yes") || process.argv.includes("-y");
const SKIP_CONSTRAINTS = process.argv.includes("--skip-constraints");

let ok = 0, skipped = 0, failed = 0;

function head(t) { console.log(`\n\u2500\u2500 ${t} ${"\u2500".repeat(Math.max(0, 66 - t.length))}`); }

/** Run one statement. Non-fatal: logs and continues. */
async function step(label, sql) {
	if (!APPLY) { console.log(`  [plan] ${label}`); return; }
	try {
		await db.raw(sql);
		console.log(`  \u2705 ${label}`);
		ok++;
	} catch (e) {
		const msg = e.message || String(e);
		// Things that mean "already done" rather than "broken".
		if (/already exists|does not exist|duplicate/i.test(msg)) {
			console.log(`  \u2013 ${label} (already done)`);
			skipped++;
		} else {
			console.log(`  \u26a0 ${label}\n      ${msg}`);
			failed++;
		}
	}
}

/** Tables that carry institute_id and should get NOT NULL + FK. */
const TENANT_TABLES = [
	"students", "attempts", "test_history", "registered_students",
	"student_requests", "student_sessions", "online_tests", "classes",
	"batches", "attendance", "notifications", "paper_templates",
];

async function main() {
	console.log(
		APPLY
			? "Applying institute index + integrity migration\u2026"
			: "DRY RUN \u2014 nothing will be changed. Re-run with --yes to apply."
	);

	// ── 0. Clean up any INVALID indexes left by an interrupted earlier run ───
	if (APPLY) {
		try {
			const bad = await db.raw(
				`SELECT c.relname FROM pg_class c
				   JOIN pg_index i ON i.indexrelid = c.oid
				  WHERE i.indisvalid = false AND c.relnamespace = 'public'::regnamespace`
			);
			for (const r of bad.rows) {
				await step(`dropped invalid leftover index ${r.relname}`,
					`DROP INDEX IF EXISTS "${r.relname}"`);
			}
		} catch (_) { /* non-fatal */ }
	}

	// ── 1. New student columns + OTP table ────────────────────────────
	head("1. Student email + section columns, OTP table");

	await step("registered_students.email",
		`ALTER TABLE registered_students ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`);
	await step("registered_students.section",
		`ALTER TABLE registered_students ADD COLUMN IF NOT EXISTS section TEXT DEFAULT ''`);
	await step("student_requests.email",
		`ALTER TABLE student_requests ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`);
	await step("student_requests.section",
		`ALTER TABLE student_requests ADD COLUMN IF NOT EXISTS section TEXT DEFAULT ''`);

	// One student = one email per institute. Case-insensitive, ignores blanks so
	// legacy rows without an email don't collide with each other.
	await step("unique index on (institute_id, lower(email))",
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_rs_inst_email
		   ON registered_students(institute_id, lower(email))
		 WHERE email IS NOT NULL AND email <> ''`);

	await step("email lookup index",
		`CREATE INDEX IF NOT EXISTS idx_rs_email_lower
		   ON registered_students(lower(email))
		 WHERE email IS NOT NULL AND email <> ''`);

	await step("student_otps table",
		`CREATE TABLE IF NOT EXISTS student_otps (
			id            BIGSERIAL PRIMARY KEY,
			email         TEXT   NOT NULL,
			institute_id  BIGINT,
			code_hash     TEXT   NOT NULL,
			attempts      INTEGER NOT NULL DEFAULT 0,
			consumed      INTEGER NOT NULL DEFAULT 0,
			created_at    BIGINT NOT NULL DEFAULT 0,
			expires_at    BIGINT NOT NULL DEFAULT 0
		)`);
	await step("student_otps lookup index",
		`CREATE INDEX IF NOT EXISTS idx_otp_email_inst
		   ON student_otps(lower(email), institute_id, expires_at DESC)`);

	// ── 2. Composite indexes that match the real query shapes ─────────────
	head("2. Composite indexes (institute_id first, then filter, then sort)");

	const indexes = [
		// "latest results for this institute" — was: filter by institute, then sort in memory
		["idx_th_inst_ts", `test_history(institute_id, timestamp DESC)`],
		// "this student's history inside this institute"
		["idx_th_inst_mobile_ts", `test_history(institute_id, mobile, timestamp DESC)`],
		// "results for one online test"
		["idx_th_inst_test", `test_history(institute_id, online_test_id)`],
		// student lists filtered by class / batch
		["idx_rs_inst_class", `registered_students(institute_id, class_name)`],
		["idx_rs_inst_batch", `registered_students(institute_id, batch_id)`],
		["idx_rs_inst_created", `registered_students(institute_id, created_at DESC)`],
		// attendance: was indexed on date ALONE — a full-tenant scan every time
		["idx_att_inst_class_date", `attendance(institute_id, class_id, date)`],
		["idx_att_inst_roll_date", `attendance(institute_id, roll_number, date DESC)`],
		// notifications: previously no institute_id in the index at all
		["idx_notif_inst_roll_read", `notifications(institute_id, roll_number, is_read)`],
		// quiz attempt tables
		["idx_students_inst_mobile", `students(institute_id, mobile)`],
		["idx_attempts_inst_mobile", `attempts(institute_id, mobile)`],
		// "which tests are live for this institute"
		["idx_ot_inst_live", `online_tests(institute_id, live_at DESC)`],
		// pending join requests queue
		["idx_sreq_inst_requested", `student_requests(institute_id, requested_at DESC)`],
		// batches under a class
		["idx_batches_inst_class", `batches(institute_id, class_id)`],
	];

	for (const [name, target] of indexes) {
		await step(`${name} → ${target}`,
			`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${target}`);
	}

	// ── 3. Drop redundant single-column institute_id indexes ──────────────
	head("3. Drop redundant single-column institute_id indexes");
	console.log("   (a composite starting with institute_id already serves institute_id = ?)");

	for (const name of [
		"idx_students_institute", "idx_attempts_institute",
		"idx_test_history_institute", "idx_online_tests_institute",
		// superseded by idx_th_inst_mobile_ts / idx_att_inst_* / idx_notif_inst_*
		"idx_test_history_mobile", "idx_attendance_date", "idx_notifications_roll",
	]) {
		await step(`dropped ${name}`, `DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
	}

	// ── 4. Global unique constraints → per-institute ─────────────────────
	head("4. Fix the two GLOBAL unique constraints");

	// attendance: UNIQUE(roll_number, date) → UNIQUE(institute_id, roll_number, date)
	await step("created ux_att_inst_roll_date",
		`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_att_inst_roll_date
		   ON attendance(institute_id, roll_number, date)`);
	if (APPLY) {
		try {
			const c = await db.raw(
				`SELECT conname FROM pg_constraint
				  WHERE conrelid = 'attendance'::regclass AND contype = 'u'`
			);
			for (const r of c.rows) {
				await step(`dropped global constraint attendance.${r.conname}`,
					`ALTER TABLE attendance DROP CONSTRAINT "${r.conname}"`);
			}
		} catch (e) {
			console.log(`  \u26a0 could not inspect attendance constraints: ${e.message}`);
		}
	} else {
		console.log("  [plan] drop attendance's global UNIQUE(roll_number, date)");
	}

	// students: UNIQUE(mobile, lecture) → UNIQUE(institute_id, mobile, lecture)
	await step("created ux_students_inst_mobile_lecture",
		`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_students_inst_mobile_lecture
		   ON students(institute_id, mobile, lecture)`);
	if (APPLY) {
		try {
			const c = await db.raw(
				`SELECT conname FROM pg_constraint
				  WHERE conrelid = 'students'::regclass AND contype = 'u'`
			);
			for (const r of c.rows) {
				await step(`dropped global constraint students.${r.conname}`,
					`ALTER TABLE students DROP CONSTRAINT "${r.conname}"`);
			}
		} catch (e) {
			console.log(`  \u26a0 could not inspect students constraints: ${e.message}`);
		}
	} else {
		console.log("  [plan] drop students' global UNIQUE(mobile, lecture)");
	}

	// ── 5. Backfill + NOT NULL + FK ────────────────────────────────
	if (SKIP_CONSTRAINTS) {
		head("5. NOT NULL + FOREIGN KEY — SKIPPED (--skip-constraints)");
	} else {
		head("5. Backfill institute_id, then NOT NULL + FOREIGN KEY");

		let defaultId = null;
		if (APPLY) {
			try {
				const r = await db.raw(`SELECT id FROM institutes WHERE code = 'DEFAULT' LIMIT 1`);
				defaultId = r.rows[0]?.id || null;
			} catch (_) {}
			if (!defaultId) {
				console.log("  \u26a0 No DEFAULT institute found — skipping NOT NULL/FK so nothing breaks.");
				console.log("     Start the server once (initDB seeds it), then re-run.");
			}
		}

		if (!APPLY || defaultId) {
			for (const tbl of TENANT_TABLES) {
				await step(`backfilled ${tbl}.institute_id`,
					`UPDATE ${tbl} SET institute_id = ${defaultId || 0}
					  WHERE institute_id IS NULL OR institute_id = 0`);
				// Orphans (institute row deleted) would break the FK — re-home them.
				await step(`re-homed orphaned ${tbl} rows`,
					`UPDATE ${tbl} SET institute_id = ${defaultId || 0}
					  WHERE institute_id IS NOT NULL
					    AND NOT EXISTS (SELECT 1 FROM institutes i WHERE i.id = ${tbl}.institute_id)`);
				await step(`${tbl}.institute_id SET NOT NULL`,
					`ALTER TABLE ${tbl} ALTER COLUMN institute_id SET NOT NULL`);
				await step(`FK ${tbl}.institute_id → institutes(id)`,
					`ALTER TABLE ${tbl}
					   ADD CONSTRAINT fk_${tbl}_institute
					   FOREIGN KEY (institute_id) REFERENCES institutes(id) ON DELETE CASCADE`);
			}
		}
	}

	// ── 6. Trigram search ────────────────────────────────────────
	head("6. Trigram indexes for partial name / email search");
	await step("enabled pg_trgm", `CREATE EXTENSION IF NOT EXISTS pg_trgm`);
	await step("trigram index on registered_students.name",
		`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rs_name_trgm
		   ON registered_students USING gin (name gin_trgm_ops)`);
	await step("trigram index on registered_students.email",
		`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rs_email_trgm
		   ON registered_students USING gin (email gin_trgm_ops)`);
	await step("trigram index on test_history.student_name",
		`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_th_name_trgm
		   ON test_history USING gin (student_name gin_trgm_ops)`);

	// ── 7. Refresh planner statistics ──────────────────────────────
	head("7. Refresh planner statistics");
	for (const tbl of TENANT_TABLES) {
		await step(`analyzed ${tbl}`, `ANALYZE ${tbl}`);
	}

	// ── Summary ──────────────────────────────────────────────
	console.log("");
	if (!APPLY) {
		console.log("DRY RUN complete. Re-run with --yes to apply.");
	} else {
		console.log(`Done. ${ok} applied, ${skipped} already in place, ${failed} warning(s).`);
		if (failed) {
			console.log("Warnings are non-fatal — usually a NOT NULL/FK blocked by leftover data.");
			console.log("Re-run with --skip-constraints to apply just the indexes.");
		}
	}
}

main()
	.then(() => process.exit(failed && APPLY ? 0 : 0))
	.catch((e) => {
		console.error("[migrate] fatal:", e.message);
		process.exit(1);
	});
