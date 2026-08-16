const { db } = require("../config/db");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE TWO REAL QUESTION TABLES
 *
 * There is NO `questions_v2` table (and no `questions_v2` view) any more.
 * The question bank physically lives in exactly two tables:
 *
 *   • questions      — the regular question bank (no year/month/day/shift)
 *   • pyq_questions  — previous-year questions (year/month/day/shift/
 *                      question_number are real columns)
 *
 * Everything the app needs is expressed in terms of those two tables:
 *
 *   READS  that span the whole bank use `ALL_Q` — a UNION ALL subquery with
 *          one uniform column list, so old single-table SQL keeps working by
 *          just swapping `FROM questions_v2` → `FROM ${ALL_Q}`.
 *   READS  that only concern PYQ (anything filtering on a real year) should
 *          hit `pyq_questions` directly — it's indexed on (subject, year).
 *   WRITES go through the helpers below, which route each row to the correct
 *          table based on whether it carries a year.
 *
 * Row identity: `questions.id` and `pyq_questions.id` both draw from the
 * shared `q_shared_id_seq` sequence (see config/db.js), so a question id is
 * unique across BOTH tables. That's what lets the by-id helpers look a row
 * up without the caller knowing which table it lives in.
 * ─────────────────────────────────────────────────────────────────────────
 */

const BANK_TABLE = "questions";
const PYQ_TABLE = "pyq_questions";

// Uniform column list across both tables. The regular bank has no year/
// month/day/shift/question_number columns, so they're projected as empty /
// NULL — exactly the shape every existing route already expects to read.
const QUESTIONS_UNION_SQL = `
	SELECT id, subject, unit, chapter, topic,
	       ''::text AS year, ''::text AS month, ''::text AS day, ''::text AS shift,
	       NULL::integer AS question_number,
	       question_type, raw_json, created_at, updated_at,
	       'bank'::text AS source
	  FROM ${BANK_TABLE}
	UNION ALL
	SELECT id, subject, unit, chapter, topic,
	       COALESCE(year,'') AS year, COALESCE(month,'') AS month,
	       COALESCE(day,'') AS day, COALESCE(shift,'') AS shift,
	       question_number,
	       question_type, raw_json, created_at, updated_at,
	       'pyq'::text AS source
	  FROM ${PYQ_TABLE}
`;

// Drop-in replacement for the old table name in read queries:
//   `SELECT ... FROM ${ALL_Q} WHERE chapter = ?`
// It contains no `?` placeholders, so the caller's argument order is unaffected.
const ALL_Q = `(${QUESTIONS_UNION_SQL}) AS q`;

// A question belongs to the PYQ table if (and only if) it carries a year.
function isPyq(year) {
	return String(year ?? "").trim() !== "";
}

function tableFor(year) {
	return isPyq(year) ? PYQ_TABLE : BANK_TABLE;
}

function str(v) {
	return v == null ? "" : String(v).trim();
}

// Normalize a caller-supplied row into the full column set, accepting either
// camelCase (questionNumber/rawJson/createdAt) or snake_case column names.
function normalizeInput(q = {}) {
	const qn = q.question_number ?? q.questionNumber;
	const now = Date.now();
	return {
		subject: str(q.subject),
		unit: str(q.unit),
		chapter: str(q.chapter),
		topic: str(q.topic),
		year: str(q.year),
		month: str(q.month),
		day: str(q.day),
		shift: str(q.shift),
		question_number: Number.isInteger(qn) ? qn : null,
		question_type: str(q.question_type ?? q.questionType) || "single_correct",
		raw_json: q.raw_json ?? q.rawJson ?? "{}",
		created_at: Number(q.created_at ?? q.createdAt ?? now) || now,
		updated_at: Number(q.updated_at ?? q.updatedAt ?? now) || now,
	};
}

/**
 * Insert ONE question into the correct table.
 * year present → pyq_questions, otherwise → questions.
 * Returns { id, table }.
 */
async function insertQuestion(input) {
	const r = normalizeInput(input);
	if (isPyq(r.year)) {
		const res = await db.execute({
			sql: `INSERT INTO ${PYQ_TABLE}
				(subject, unit, chapter, topic, year, month, day, shift,
				 question_number, question_type, raw_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				r.subject, r.unit, r.chapter, r.topic, r.year, r.month, r.day, r.shift,
				r.question_number, r.question_type, r.raw_json, r.created_at, r.updated_at,
			],
		});
		return { id: res.lastInsertRowid, table: PYQ_TABLE };
	}
	const res = await db.execute({
		sql: `INSERT INTO ${BANK_TABLE}
			(subject, unit, chapter, topic, question_type, raw_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			r.subject, r.unit, r.chapter, r.topic,
			r.question_type, r.raw_json, r.created_at, r.updated_at,
		],
	});
	return { id: res.lastInsertRowid, table: BANK_TABLE };
}

/**
 * Look a question up by id without the caller knowing which table holds it.
 * Returns the row padded to the uniform column set, plus `source`
 * ("bank" | "pyq"), or null when the id doesn't exist in either table.
 */
async function findQuestionRowById(id) {
	const pyq = await db.execute({
		sql: `SELECT * FROM ${PYQ_TABLE} WHERE id = ? LIMIT 1`,
		args: [id],
	});
	if (pyq.rows.length) {
		const row = pyq.rows[0];
		return {
			...row,
			year: row.year || "",
			month: row.month || "",
			day: row.day || "",
			shift: row.shift || "",
			source: "pyq",
		};
	}
	const bank = await db.execute({
		sql: `SELECT * FROM ${BANK_TABLE} WHERE id = ? LIMIT 1`,
		args: [id],
	});
	if (bank.rows.length) {
		return {
			...bank.rows[0],
			year: "",
			month: "",
			day: "",
			shift: "",
			question_number: null,
			source: "bank",
		};
	}
	return null;
}

/**
 * Update ONE question by id, merging `patch` over the stored row.
 *
 * If the patch changes whether the question has a year, the row is MOVED
 * between the two tables while keeping its id (regular ↔ PYQ), so ids stay
 * stable for the frontend. Returns { id, table, moved, previousTable } or
 * null when the id doesn't exist.
 */
async function updateQuestionRowById(id, patch = {}) {
	const existing = await findQuestionRowById(id);
	if (!existing) return null;

	const pick = (key, camel) => {
		if (patch[key] !== undefined) return patch[key];
		if (camel && patch[camel] !== undefined) return patch[camel];
		return existing[key];
	};

	const merged = normalizeInput({
		subject: pick("subject"),
		unit: pick("unit"),
		chapter: pick("chapter"),
		topic: pick("topic"),
		year: pick("year"),
		month: pick("month"),
		day: pick("day"),
		shift: pick("shift"),
		question_number: pick("question_number", "questionNumber"),
		question_type: pick("question_type", "questionType"),
		raw_json: pick("raw_json", "rawJson"),
		created_at: existing.created_at || 0,
		updated_at: patch.updated_at ?? patch.updatedAt ?? Date.now(),
	});

	const from = existing.source === "pyq" ? PYQ_TABLE : BANK_TABLE;
	const to = tableFor(merged.year);

	// ── same table: plain in-place UPDATE ────────────────────────────────
	if (from === to) {
		if (to === PYQ_TABLE) {
			await db.execute({
				sql: `UPDATE ${PYQ_TABLE}
					SET subject = ?, unit = ?, chapter = ?, topic = ?, year = ?, month = ?, day = ?,
					    shift = ?, question_number = ?, question_type = ?, raw_json = ?, updated_at = ?
					WHERE id = ?`,
				args: [
					merged.subject, merged.unit, merged.chapter, merged.topic, merged.year,
					merged.month, merged.day, merged.shift, merged.question_number,
					merged.question_type, merged.raw_json, merged.updated_at, id,
				],
			});
		} else {
			await db.execute({
				sql: `UPDATE ${BANK_TABLE}
					SET subject = ?, unit = ?, chapter = ?, topic = ?,
					    question_type = ?, raw_json = ?, updated_at = ?
					WHERE id = ?`,
				args: [
					merged.subject, merged.unit, merged.chapter, merged.topic,
					merged.question_type, merged.raw_json, merged.updated_at, id,
				],
			});
		}
		return { id, table: to, moved: false, previousTable: from };
	}

	// ── year crossed the bank/PYQ boundary: move the row, keeping its id ──
	if (to === PYQ_TABLE) {
		await db.execute({
			sql: `INSERT INTO ${PYQ_TABLE}
				(id, subject, unit, chapter, topic, year, month, day, shift,
				 question_number, question_type, raw_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				id, merged.subject, merged.unit, merged.chapter, merged.topic, merged.year,
				merged.month, merged.day, merged.shift, merged.question_number,
				merged.question_type, merged.raw_json, merged.created_at, merged.updated_at,
			],
		});
	} else {
		await db.execute({
			sql: `INSERT INTO ${BANK_TABLE}
				(id, subject, unit, chapter, topic, question_type, raw_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				id, merged.subject, merged.unit, merged.chapter, merged.topic,
				merged.question_type, merged.raw_json, merged.created_at, merged.updated_at,
			],
		});
	}
	await db.execute({ sql: `DELETE FROM ${from} WHERE id = ?`, args: [id] });
	return { id, table: to, moved: true, previousTable: from };
}

/** Delete ONE question by id from whichever table holds it. */
async function deleteQuestionRowById(id) {
	const a = await db.execute({ sql: `DELETE FROM ${PYQ_TABLE} WHERE id = ?`, args: [id] });
	const b = await db.execute({ sql: `DELETE FROM ${BANK_TABLE} WHERE id = ?`, args: [id] });
	return (a.rowsAffected || 0) + (b.rowsAffected || 0);
}

/**
 * Run the same DELETE ... WHERE <clause> against BOTH tables.
 * Use for chapter/topic-scoped deletes, which are agnostic of the split.
 * `whereSql` must only reference columns common to both tables
 * (id, subject, unit, chapter, topic, question_type, raw_json, timestamps).
 */
async function deleteQuestionsWhere(whereSql, args = []) {
	let deleted = 0;
	for (const table of [BANK_TABLE, PYQ_TABLE]) {
		const res = await db.execute({
			sql: `DELETE FROM ${table} WHERE ${whereSql}`,
			args: [...args],
		});
		deleted += res.rowsAffected || 0;
	}
	return deleted;
}

/**
 * Run the same UPDATE ... SET <setSql> WHERE <whereSql> against BOTH tables
 * (used by chapter/topic renames). Both clauses must only reference columns
 * common to both tables — never `year`, `month`, `day`, `shift` or
 * `question_number`, which exist on pyq_questions only.
 * `setArgs` are bound before `whereArgs`, matching the SQL text order.
 */
async function updateQuestionsWhere(setSql, setArgs = [], whereSql = "TRUE", whereArgs = []) {
	let updated = 0;
	for (const table of [BANK_TABLE, PYQ_TABLE]) {
		const res = await db.execute({
			sql: `UPDATE ${table} SET ${setSql} WHERE ${whereSql}`,
			args: [...setArgs, ...whereArgs],
		});
		updated += res.rowsAffected || 0;
	}
	return updated;
}

module.exports = {
	BANK_TABLE,
	PYQ_TABLE,
	QUESTIONS_UNION_SQL,
	ALL_Q,
	isPyq,
	tableFor,
	insertQuestion,
	findQuestionRowById,
	updateQuestionRowById,
	deleteQuestionRowById,
	deleteQuestionsWhere,
	updateQuestionsWhere,
};
