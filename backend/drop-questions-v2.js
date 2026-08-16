/**
 * drop-questions-v2.js — remove the leftover `questions_v2` object for good.
 *
 * The app now stores every question in exactly TWO tables:
 *   • questions      — the regular question bank (no year)
 *   • pyq_questions  — previous-year questions (year/month/day/shift/number)
 *
 * Nothing reads `questions_v2` any more. This script cleans it up safely:
 *
 *   • If `questions_v2` is a VIEW  → dropped immediately (views hold no data),
 *     along with its INSTEAD OF trigger functions.
 *   • If `questions_v2` is a TABLE → every row is first copied into the correct
 *     real table (year present → pyq_questions, otherwise → questions), keeping
 *     the original id. Rows whose id already exists are skipped, so re-running
 *     is safe. The table is only dropped after the copy succeeds.
 *
 * USAGE:
 *   cd backend
 *   node drop-questions-v2.js            # dry run — reports what it would do
 *   node drop-questions-v2.js --yes      # actually migrate rows + drop it
 */

const { db } = require("./config/db");

const APPLY = process.argv.includes("--yes") || process.argv.includes("-y");

function log(...a) {
	console.log("[drop-v2]", ...a);
}

async function relKind() {
	const res = await db.raw(
		`SELECT relkind FROM pg_class WHERE relname = 'questions_v2' AND relnamespace = 'public'::regnamespace`
	);
	return res.rows.length ? res.rows[0].relkind : null;
}

async function dropTriggerFunctions() {
	for (const fn of ["questions_v2_insert", "questions_v2_update", "questions_v2_delete"]) {
		await db.raw(`DROP FUNCTION IF EXISTS ${fn}() CASCADE`);
		log(`dropped function ${fn}() (if it existed)`);
	}
}

async function main() {
	const kind = await relKind();

	if (!kind) {
		log("Nothing to do \u2014 `questions_v2` does not exist. " +
			"The app already runs entirely on `questions` + `pyq_questions`.");
		await dropTriggerFunctions();
		return;
	}

	// ── Case 1: it's a view — safe to drop unconditionally ──────────────────
	if (kind === "v") {
		log("`questions_v2` is a VIEW (no data of its own).");
		if (!APPLY) {
			log("DRY RUN \u2014 re-run with --yes to drop it.");
			return;
		}
		await db.raw(`DROP VIEW IF EXISTS questions_v2 CASCADE`);
		await dropTriggerFunctions();
		log("\u2705 Dropped the questions_v2 view.");
		return;
	}

	if (kind !== "r" && kind !== "p") {
		log(`\`questions_v2\` exists with unexpected relkind "${kind}" \u2014 stopping. Inspect it manually.`);
		return;
	}

	// ── Case 2: it's a real table — rescue rows, then drop ─────────────────
	log("`questions_v2` is a real TABLE. Checking its contents\u2026");

	const cols = await db.raw(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = 'public' AND table_name = 'questions_v2'`
	);
	const names = cols.rows.map((r) => r.column_name);
	const has = (c) => names.includes(c);
	if (!has("raw_json")) {
		log("\u26a0 This table has no `raw_json` column, so it isn't the question table this script expects.");
		log("   Columns:", names.join(", "));
		log("   Stopping \u2014 inspect and drop it manually.");
		return;
	}

	const yearExpr = has("year") ? "COALESCE(year, '')" : "''";
	const totals = await db.raw(
		`SELECT COUNT(*) AS total,
		        COUNT(*) FILTER (WHERE ${yearExpr} <> '') AS pyq,
		        COUNT(*) FILTER (WHERE ${yearExpr} =  '') AS bank
		   FROM questions_v2`
	);
	const { total, pyq, bank } = totals.rows[0];
	log(`rows: ${total} total \u2192 ${bank} regular + ${pyq} PYQ`);

	if (!APPLY) {
		log("DRY RUN \u2014 re-run with --yes to copy these rows into " +
			"`questions` / `pyq_questions` and drop the table.");
		return;
	}

	const col = (c, fallback) => (has(c) ? c : fallback);

	// Regular bank rows (no year).
	const movedBank = await db.raw(
		`INSERT INTO questions (id, subject, unit, chapter, topic, question_type, raw_json, created_at, updated_at)
		 SELECT id,
		        COALESCE(${col("subject", "''")}, ''),
		        COALESCE(${col("unit", "''")}, ''),
		        COALESCE(${col("chapter", "''")}, ''),
		        COALESCE(${col("topic", "''")}, ''),
		        COALESCE(${col("question_type", "'single_correct'")}, 'single_correct'),
		        COALESCE(raw_json, '{}'),
		        COALESCE(${col("created_at", "0")}, 0),
		        COALESCE(${col("updated_at", "0")}, 0)
		   FROM questions_v2
		  WHERE ${yearExpr} = ''
		 ON CONFLICT (id) DO NOTHING`
	);
	log(`copied ${movedBank.rowCount} row(s) into questions`);

	// PYQ rows (year present).
	let movedPyq = { rowCount: 0 };
	if (has("year")) {
		movedPyq = await db.raw(
			`INSERT INTO pyq_questions (id, subject, unit, chapter, topic, year, month, day, shift,
			                            question_number, question_type, raw_json, created_at, updated_at)
			 SELECT id,
			        COALESCE(${col("subject", "''")}, ''),
			        COALESCE(${col("unit", "''")}, ''),
			        COALESCE(${col("chapter", "''")}, ''),
			        COALESCE(${col("topic", "''")}, ''),
			        COALESCE(year, ''),
			        COALESCE(${col("month", "''")}, ''),
			        COALESCE(${col("day", "''")}, ''),
			        COALESCE(${col("shift", "''")}, ''),
			        ${col("question_number", "NULL")},
			        COALESCE(${col("question_type", "'single_correct'")}, 'single_correct'),
			        COALESCE(raw_json, '{}'),
			        COALESCE(${col("created_at", "0")}, 0),
			        COALESCE(${col("updated_at", "0")}, 0)
			   FROM questions_v2
			  WHERE COALESCE(year, '') <> ''
			 ON CONFLICT (id) DO NOTHING`
		);
		log(`copied ${movedPyq.rowCount} row(s) into pyq_questions`);
	}

	// Verify nothing would be lost before dropping.
	const leftover = await db.raw(
		`SELECT COUNT(*) AS missing FROM questions_v2 v
		  WHERE NOT EXISTS (SELECT 1 FROM questions q WHERE q.id = v.id)
		    AND NOT EXISTS (SELECT 1 FROM pyq_questions p WHERE p.id = v.id)`
	);
	const missing = Number(leftover.rows[0].missing) || 0;
	if (missing > 0) {
		log(`\u274c ${missing} row(s) are still not present in questions/pyq_questions \u2014 NOT dropping the table.`);
		log("   Investigate those rows first, then re-run.");
		return;
	}

	await db.raw(`DROP TABLE IF EXISTS questions_v2 CASCADE`);
	await dropTriggerFunctions();

	// Keep the shared id sequence ahead of both tables after the copy.
	await db.raw(
		`SELECT setval('q_shared_id_seq',
		        GREATEST((SELECT COALESCE(MAX(id),0) FROM questions),
		                 (SELECT COALESCE(MAX(id),0) FROM pyq_questions)) + 1, false)`
	);

	log("\u2705 questions_v2 is gone. All questions now live in `questions` + `pyq_questions`.");
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error("[drop-v2] failed:", e.message);
		process.exit(1);
	});
