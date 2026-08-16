const { db } = require("../config/db");
const { normalizeQuestion } = require("./helpers");
const { ALL_Q, PYQ_TABLE } = require("./questionTables");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * SCHEMA MODEL (questions + pyq_questions): one row per QUESTION, not per
 * topic. Regular-bank questions live in `questions`, previous-year questions
 * in `pyq_questions`; reads that span both go through the ALL_Q union.
 *
 * Because of that, the old "cache every question set in memory" approach
 * (questionCache keyed by chapter::lecture, holding entire question arrays)
 * doesn't make sense at 300k rows. Instead we cache ONLY metadata:
 *   - the list of distinct chapters
 *   - the list of distinct topics per chapter, with question counts
 *
 * Actual question content is always fetched from the DB on demand — the
 * new indexes (chapter+topic, subject+year) make those fetches fast even
 * at 300k rows, so there's no need to hold question bodies in memory.
 *
 * `lecture` no longer exists as a column. Anywhere old code expects a
 * `.lecture` field on a row, we return `.topic` aliased as `.lecture` so
 * old endpoints/frontend code that read `row.lecture` keep working without
 * being rewritten. This is intentional backward-compat shimming — see
 * admin.js for where old routes are kept alive on top of this file.
 * ─────────────────────────────────────────────────────────────────────────
 */

// metaCache shape: { [chapter]: { [topic]: count } }
let metaCache = {};
let chapterListCache = [];

async function loadQuestions() {
	const result = await db.execute(
		`SELECT chapter, topic, COUNT(*) as cnt FROM ${ALL_Q} GROUP BY chapter, topic`
	);
	const next = {};
	for (const row of result.rows) {
		const chapter = row.chapter || "";
		const topic = row.topic || "";
		if (!next[chapter]) next[chapter] = {};
		next[chapter][topic] = Number(row.cnt) || 0;
	}
	metaCache = next;
	chapterListCache = Object.keys(metaCache).filter(Boolean).sort();
	console.log(`[questions] Metadata cache loaded: ${chapterListCache.length} chapters.`);
}

// Refresh just one chapter/topic's cached count — call after any write
// that touches that chapter+topic, instead of reloading everything.
async function refreshCache(chapter, topic) {
	const ch = chapter || "";
	const tp = topic || "";
	const result = await db.execute({
		sql: `SELECT COUNT(*) as cnt FROM ${ALL_Q} WHERE chapter = ? AND topic = ?`,
		args: [ch, tp],
	});
	const cnt = Number(result.rows[0]?.cnt) || 0;
	if (cnt === 0) {
		if (metaCache[ch]) delete metaCache[ch][tp];
		if (metaCache[ch] && !Object.keys(metaCache[ch]).length) delete metaCache[ch];
	} else {
		if (!metaCache[ch]) metaCache[ch] = {};
		metaCache[ch][tp] = cnt;
	}
	chapterListCache = Object.keys(metaCache).filter(Boolean).sort();
}

function getChapterList() {
	return chapterListCache;
}

function getTopicsForChapter(chapter) {
	const ch = metaCache[chapter || ""] || {};
	return Object.keys(ch).sort();
}

function getQuestionCount(chapter, topic) {
	return metaCache[chapter || ""]?.[topic || ""] || 0;
}

/**
 * Fetch every question row for a given chapter+topic, normalized and
 * shaped like the OLD findQuestion() return value:
 *   { _id, chapter, lecture, topic, updatedAt, questions: [...] }
 * (lecture === topic, kept for backward compatibility with old callers —
 * see note at top of file.)
 *
 * `_id` here is no longer meaningful as a single row id (there are many
 * rows, one per question) — old single-row-id-based code (rebuildYearIndex,
 * single question_row/:id lookups) doesn't apply to the new schema and is
 * intentionally NOT carried over below. See admin.js for the new
 * per-question-id routes that replace it.
 */
async function findQuestion(chapter, topic) {
	const ch = chapter || "";
	const tp = topic || "";
	const result = await db.execute({
		sql: `SELECT id, subject, year, month, day, shift, raw_json, updated_at FROM ${ALL_Q} WHERE chapter = ? AND topic = ? ORDER BY question_number, id`,
		args: [ch, tp],
	});
	if (!result.rows.length) return null;

	const questions = result.rows.map((row) => {
		let raw = {};
		try { raw = JSON.parse(row.raw_json || "{}"); } catch { raw = {}; }
		const normalized = normalizeQuestion(raw, { preserveRaw: true });
		normalized._rowId = row.id; // needed for per-question edit/delete
		
		// Backfill metadata fields from DB columns if not set
		if (row.subject && !normalized.subject) normalized.subject = String(row.subject);
		if (row.year && !normalized.year) normalized.year = String(row.year);
		if (row.month && !normalized.month) normalized.month = String(row.month);
		if (row.day && !normalized.day) normalized.day = String(row.day);
		if (row.shift && !normalized.shift) normalized.shift = String(row.shift);
		
		return normalized;
	});

	const updatedAt = result.rows.reduce((max, r) => Math.max(max, r.updated_at || 0), 0);

	return {
		_id: null, // no single id any more — see _rowId on each question instead
		chapter: chapter || null,
		lecture: tp, // backward-compat alias, see file header
		topic: tp,
		updatedAt,
		questions,
	};
}

/**
 * Resolves a list of {chapter, lecture, questionIndex} keys (the OLD
 * paper-builder key format) into actual question objects.
 *
 * Kept for backward compatibility with any frontend code still sending
 * old-style keys. Internally it now just calls findQuestion per distinct
 * chapter+topic group (same grouping strategy as before) and indexes into
 * the returned array — behaviourally identical to the old version, just
 * backed by the new per-question table instead of a JSON blob.
 */
async function resolveQuestionKeys(keys) {
	if (!Array.isArray(keys) || !keys.length) return [];
	const groups = {};
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i];
		const topic = k.lecture ?? k.topic; // accept either old or new field name
		const gk = `${k.chapter || ""}::${topic}`;
		if (!groups[gk]) groups[gk] = [];
		groups[gk].push(i);
	}
	const result = new Array(keys.length);
	for (const gk of Object.keys(groups)) {
		const sep = gk.indexOf("::");
		const chapter = sep > 0 ? gk.slice(0, sep) : "";
		const topic = gk.slice(sep + 2);
		const qSet = await findQuestion(chapter, topic);
		if (!qSet || !Array.isArray(qSet.questions)) continue;
		for (const idx of groups[gk]) {
			const qIdx = keys[idx].questionIndex;
			if (Number.isInteger(qIdx) && qIdx >= 0 && qIdx < qSet.questions.length) {
				result[idx] = qSet.questions[qIdx];
			}
		}
	}
	return result.filter(Boolean);
}

/**
 * NEW: the fast paper-wise lookup that replaces questions-by-year +
 * question_years entirely. Straight indexed query on real columns —
 * no JSON parsing of unrelated questions, no self-healing index needed
 * because there's no separate index to drift out of sync.
 */
async function findQuestionsByPaper({ subject, year, chapter, month, day, shift } = {}) {
	const conditions = [];
	const args = [];
	if (subject) { conditions.push("subject = ?"); args.push(subject); }
	if (year) { conditions.push("year = ?"); args.push(String(year)); }
	if (chapter) { conditions.push("chapter = ?"); args.push(chapter); }
	if (month) { conditions.push("month = ?"); args.push(String(month)); }
	if (day) { conditions.push("day = ?"); args.push(String(day)); }
	if (shift) { conditions.push("shift = ?"); args.push(String(shift)); }

	const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
	// A real year only ever exists in `pyq_questions`, so when the caller filters
	// by year we query that table directly and let its (subject, year) index do
	// the work. Otherwise we scan the union of both question tables.
	const from = year ? PYQ_TABLE : ALL_Q;
	const result = await db.execute({
		sql: `SELECT id, subject, year, month, day, shift, chapter, topic, raw_json FROM ${from} ${where} ORDER BY chapter, topic, question_number, id`,
		args,
	});

	return result.rows.map((row) => {
		let raw = {};
		try { raw = JSON.parse(row.raw_json || "{}"); } catch { raw = {}; }
		const normalized = normalizeQuestion(raw, { preserveRaw: true });
		
		// Backfill metadata fields from DB columns if not set
		if (row.subject && !normalized.subject) normalized.subject = String(row.subject);
		if (row.year && !normalized.year) normalized.year = String(row.year);
		if (row.month && !normalized.month) normalized.month = String(row.month);
		if (row.day && !normalized.day) normalized.day = String(row.day);
		if (row.shift && !normalized.shift) normalized.shift = String(row.shift);
		
		return {
			rowId: row.id,
			chapter: row.chapter || null,
			topic: row.topic || "",
			question: normalized,
		};
	});
}

module.exports = {
	loadQuestions,
	refreshCache,
	getChapterList,
	getTopicsForChapter,
	getQuestionCount,
	findQuestion,
	resolveQuestionKeys,
	findQuestionsByPaper,
	getQuestionCache: () => metaCache, // kept for admin.js's reload-cache route shape
};
