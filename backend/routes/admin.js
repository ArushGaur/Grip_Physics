const express = require("express");
const router = express.Router();
const multer = require("multer");
const { db } = require("../config/db");
const helpers = require("../utils/helpers");
const { requireAdmin, sessionInstituteId, getDefaultInstituteId } = require("../middleware/auth");
const {
	loadQuestions, refreshCache, findQuestion, findQuestionsByPaper,
	getChapterList, getTopicsForChapter, getQuestionCount, getQuestionCache, resolveQuestionKeys,
} = require("../utils/questions");
// The question bank is TWO tables: `questions` (regular) + `pyq_questions`
// (previous-year). ALL_Q reads across both; the helpers route writes to the
// right one. There is no `questions_v2` table/view any more.
const {
	ALL_Q, PYQ_TABLE, insertQuestion, findQuestionRowById, updateQuestionRowById,
	deleteQuestionRowById, deleteQuestionsWhere, updateQuestionsWhere,
} = require("../utils/questionTables");
const {
	normalizeQuestionRow, normalizeQuestion, normalizeStudentRow,
	parseCorrectIndexesFromQuestion, validateImageRegion,
	// Online tests are shuffled per student, so a teacher reviewing an attempt
	// must see the paper in the order that student saw it.
	applyQuestionOrder, parseQuestionOrder,
} = helpers;
const { uploadQuestionImages } = require("../services/cloudinary");
// Per-institute feature flags + subject whitelist (set from the developer panel).
const {
	requireFeature, permissionsForRequest, allowedSubjectsFor, hasSubjectLimit,
	subjectSqlFilter, filterRowsBySubject, isSubjectAllowed,
} = require("../utils/permissions");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";


const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

/**
 * Does this chapter contain any question from a subject the institute is
 * allowed to see? Used to hide whole chapters of blocked subjects.
 */
async function chapterAllowed(perms, chapter) {
	try {
		const subjFilter = subjectSqlFilter(perms, "q.subject");
		if (!subjFilter.clause) return true;
		const ch = decodeURIComponent(chapter || "");
		const isNone = ch === "_none_" || ch === "";
		const r = await db.execute({
			sql: `SELECT 1 FROM ${ALL_Q} WHERE ${isNone ? "(chapter IS NULL OR chapter = '')" : "chapter = ?"}
			      AND (${subjFilter.clause}) LIMIT 1`,
			args: isNone ? subjFilter.args : [ch, ...subjFilter.args],
		});
		return r.rows.length > 0;
	} catch (_) {
		return true;
	}
}

function extractYearFromQuestions(questions) {
	for (const q of (questions || [])) {
		const y = q?.year ? String(q.year).trim() : null;
		if (y) return y;
	}
	return null;
}

router.get("/api/chapters", async (req, res) => {
	try {
		// Chapters of blocked subjects must not even be listed.
		const perms = await permissionsForRequest(req);
		if (hasSubjectLimit(perms)) {
			const subjFilter = subjectSqlFilter(perms, "q.subject");
			const r = await db.execute({
				sql: `SELECT DISTINCT chapter FROM ${ALL_Q} WHERE ${subjFilter.clause} ORDER BY chapter`,
				args: subjFilter.args,
			});
			const allowed = new Set(r.rows.map((x) => x.chapter || ""));
			return res.json(getChapterList().filter((c) => allowed.has(c === null ? "" : c)));
		}
		res.json(getChapterList());
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/lectures/:chapter", async (req, res) => {
	try {
		const chapter = req.params.chapter;
		const perms = await permissionsForRequest(req);
		if (hasSubjectLimit(perms) && !(await chapterAllowed(perms, chapter))) return res.json([]);
		const topics = getTopicsForChapter(chapter);
		res.json(topics);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Same data under its real name — prefer this in any new frontend code.
router.get("/api/topics/:chapter", async (req, res) => {
	try {
		const perms = await permissionsForRequest(req);
		if (hasSubjectLimit(perms) && !(await chapterAllowed(perms, req.params.chapter))) return res.json([]);
		res.json(getTopicsForChapter(req.params.chapter));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Distinct subjects present in the question bank (Physics/Chemistry/Maths/Biology).
router.get("/api/subjects", requireAdmin, async (req, res) => {
	try {
		const result = await db.execute(
			`SELECT DISTINCT subject FROM ${ALL_Q} WHERE subject IS NOT NULL AND subject != '' ORDER BY subject`
		);
		// If the developer panel limited this institute to e.g. Physics + Maths,
		// every other subject disappears from the whole institute panel.
		const perms = await permissionsForRequest(req);
		const visible = filterRowsBySubject(perms, result.rows, (r) => r.subject);
		res.json(visible.map((r) => r.subject));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/question/:chapter/:lecture", async (req, res) => {
	try {
		const rawChapter = decodeURIComponent(req.params.chapter || "");
		const topic = decodeURIComponent(req.params.lecture || "");
		const chapter = (rawChapter === "_none_" || rawChapter === "") ? null : rawChapter;
		const q = await findQuestion(chapter, topic);
		if (!q) return res.status(404).json({ error: "Topic not found" });
		res.json(q);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


router.post("/api/admin/add-question", requireAdmin, async (req, res) => {
	try {
		let { chapter, lecture, topic, questions } = req.body || {};
		topic = topic ?? lecture; // accept either old (`lecture`) or new (`topic`) field name
		if (!topic || !Array.isArray(questions) || !questions.length) {
			return res.status(400).json({ error: "Missing" });
		}

		questions = questions.map(normalizeQuestion);
		questions = await uploadQuestionImages(questions);

		const now = Date.now();
		let inserted = 0;
		for (const q of questions) {
			const subject = String(q.subject || "").trim();
			const unit = String(q.unit || "").trim();
			const year = q.year != null ? String(q.year).trim() : "";
			const month = q.month != null ? String(q.month).trim() : "";
			const day = q.day != null ? String(q.day).trim() : "";
			const shift = q.shift != null ? String(q.shift).trim() : "";
			const questionNumber = Number.isInteger(q.questionNumber) ? q.questionNumber : null;
			const questionType = String(q.questionType || "MCQ").trim() || "MCQ";

			// Goes to `pyq_questions` when the question carries a year,
			// otherwise to the regular `questions` bank.
			await insertQuestion({
				subject, unit, chapter: chapter || "", topic,
				year, month, day, shift,
				questionNumber, questionType,
				rawJson: JSON.stringify(q),
				createdAt: now, updatedAt: now,
			});
			inserted++;
		}

		await refreshCache(chapter || null, topic);
		res.json({ success: true, added: inserted, total: inserted });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/admin/students", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({
			sql: "SELECT * FROM students WHERE institute_id = ? ORDER BY time DESC",
			args: [instId],
		});
		res.json(result.rows.map(normalizeStudentRow));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Mark all answers as incorrect for a student flagged for cheating
router.post("/api/admin/student/:id/mark-cheater", requireAdmin, async (req, res) => {
	try {
		const id = req.params.id;
		if (!id) return res.status(400).json({ error: "Student ID required." });

		// Fetch the student row — scoped to this institute so an institute can't
		// modify another institute's student records.
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({ sql: "SELECT * FROM students WHERE id = ? AND institute_id = ?", args: [id, instId] });
		const row = result.rows[0];
		if (!row) return res.status(404).json({ error: "Student not found." });

		// Parse answers and set all to an invalid value so none match correct answers
		let answers = [];
		try { answers = JSON.parse(row.answers_json || "[]"); } catch { answers = []; }
		// Replace every answer with -1 (guaranteed wrong for any question)
		const nullifiedAnswers = answers.map(() => -1);

		await db.execute({
			sql: "UPDATE students SET correct_count = 0, answers_json = ?, cheat_flag = 1 WHERE id = ? AND institute_id = ?",
			args: [JSON.stringify(nullifiedAnswers), id, instId],
		});

		res.json({ success: true, message: "All answers marked as incorrect and cheating flag set." });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/admin/questions", requireAdmin, async (req, res) => {
	try {
		const perms = await permissionsForRequest(req);
		const subjFilter = subjectSqlFilter(perms, "q.subject");
		const result = await db.execute({
			sql: `SELECT id, chapter, topic, raw_json, updated_at FROM ${ALL_Q}
			      ${subjFilter.clause ? "WHERE " + subjFilter.clause : ""}
			      ORDER BY chapter, topic, question_number, id`,
			args: subjFilter.args,
		});
		const groups = {}; // key: chapter::topic
		for (const row of result.rows) {
			const key = `${row.chapter || ""}::${row.topic || ""}`;
			if (!groups[key]) {
				groups[key] = {
					_id: null,
					chapter: row.chapter || null,
					lecture: row.topic || "", // backward-compat alias
					topic: row.topic || "",
					updatedAt: row.updated_at || 0,
					questions: [],
				};
			}
			let raw = {};
			try { raw = JSON.parse(row.raw_json || "{}"); } catch { raw = {}; }
			groups[key].questions.push(normalizeQuestion(raw, { preserveRaw: true }));
			groups[key].updatedAt = Math.max(groups[key].updatedAt, row.updated_at || 0);
		}
		res.json(Object.values(groups));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Lightweight metadata-only endpoint — no raw_json, fast even at 300k+ questions.
// Just a GROUP BY on real indexed columns now: no LEFT JOIN through a separate
// year-index table, no json_extract guesswork to find subject.
router.get("/api/admin/questions-meta", requireAdmin, async (req, res) => {
	try {
		const perms = await permissionsForRequest(req);
		const subjFilter = subjectSqlFilter(perms, "q.subject");
		const result = await db.execute({
			sql: `SELECT chapter, topic, MAX(subject) as subject, MAX(updated_at) as updated_at, COUNT(*) as qcount
			 FROM ${ALL_Q}
			 ${subjFilter.clause ? "WHERE " + subjFilter.clause : ""}
			 GROUP BY chapter, topic
			 ORDER BY chapter, topic`,
			args: subjFilter.args,
		});
		const rows = result.rows.map((row) => ({
			// CHANGED: was `_id: null` for every row. Since all metadata rows shared
			// the same null id, the frontend's ensureChapterLoaded() merge (which
			// looks up full rows by _id) collided every topic onto whichever full
			// row happened to load last — showing only 1 topic with a wrong count.
			// A composite chapter::topic key is unique per group, so each metadata
			// row now matches its own full row correctly.
			_id: `${row.chapter || ""}::${row.topic || ""}`,
			chapter: row.chapter || null,
			lecture: row.topic || "", // backward-compat alias
			topic: row.topic || "",
			subject: row.subject || null,
			updatedAt: row.updated_at || 0,
			questionCount: Number(row.qcount) || 0,
			questions: null,     // not loaded — signals lazy-loadable
			_metaOnly: true,
		}));
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Fetch a single QUESTION by its row id (looked up in `questions`, then in
// `pyq_questions` — ids are unique across both) (was: a whole topic's
// array by row id — that concept doesn't exist any more, since each row IS
// one question now). If you need a whole topic's questions, use
// /api/question/:chapter/:lecture instead — same URL/shape as before.
router.get("/api/admin/question-row/:id", requireAdmin, async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
		const row = await findQuestionRowById(id);
		if (!row) return res.status(404).json({ error: "Not found" });
		let raw = {};
		try { raw = JSON.parse(row.raw_json || "{}"); } catch { raw = {}; }
		res.json({
			_id: row.id,
			chapter: row.chapter || null,
			topic: row.topic || "",
			subject: row.subject || null,
			year: row.year || null,
			updatedAt: row.updated_at || 0,
			question: normalizeQuestion(raw, { preserveRaw: true }),
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Update ONE question row in place (by its id). Unlike
// PUT /api/admin/question/:chapter/:lecture (which replaces an entire
// chapter+topic group), this touches exactly one row — siblings in the
// same topic are never deleted. Accepts either:
//   { question: {...} }            — preferred: the single edited question
//   { questions: [questionObj] }   — also accepted for backward-compat with
//                                     callers that still send a 1-item array
// chapter/lecture/topic in the body let the row move to a different
// chapter/topic, same as the multi-row route does.
router.put("/api/admin/question-row/:id", requireAdmin, async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

		const existingRow = await findQuestionRowById(id);
		if (!existingRow) return res.status(404).json({ error: "Not found" });

		const body = req.body || {};
		let questionObj = body.question;
		if (!questionObj && Array.isArray(body.questions) && body.questions.length) {
			questionObj = body.questions[0]; // backward-compat: take the first (only) item
		}
		if (!questionObj || typeof questionObj !== "object") {
			return res.status(400).json({ error: "question object is required" });
		}

		let normalized = normalizeQuestion(questionObj, { preserveRaw: true });
		// This path previously persisted inline base64/SVG straight into raw_json.
		// Push figures to Cloudinary so the DB row stores URLs instead.
		[normalized] = await uploadQuestionImages([normalized]);
		const chapter = body.chapter !== undefined ? String(body.chapter || "").trim() : (existingRow.chapter || "");
		const topic = (body.topic ?? body.lecture) !== undefined ? String(body.topic ?? body.lecture ?? "").trim() : (existingRow.topic || "");
		const subject = String(normalized.subject ?? existingRow.subject ?? "").trim();
		const unit = String(normalized.unit ?? existingRow.unit ?? "").trim();
		const year = normalized.year != null ? String(normalized.year).trim() : (existingRow.year || "");

		// Updates the row in place, or moves it between `questions` and
		// `pyq_questions` (keeping the same id) when a year is added or removed.
		await updateQuestionRowById(id, {
			subject, unit, chapter, topic, year,
			raw_json: JSON.stringify(normalized),
			updated_at: Date.now(),
		});

		await refreshCache(existingRow.chapter || "", existingRow.topic || "");
		if (chapter !== (existingRow.chapter || "") || topic !== (existingRow.topic || "")) {
			await refreshCache(chapter, topic);
		}
		res.json({ success: true, id });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Delete ONE question row by its id �� siblings in the
// same chapter+topic are untouched.
router.delete("/api/admin/question-row/:id", requireAdmin, async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

		const existingRow = await findQuestionRowById(id);
		if (!existingRow) return res.status(404).json({ error: "Not found" });
		const { chapter, topic } = existingRow;

		await deleteQuestionRowById(id);
		await refreshCache(chapter || "", topic || "");
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Fetch all rows for a chapter — used when user opens a chapter (lazy load)
router.get("/api/admin/questions-for-chapter/:chapter", requireAdmin, async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		const perms = await permissionsForRequest(req);
		const subjFilter = subjectSqlFilter(perms, "q.subject");
		const extra = subjFilter.clause ? ` AND (${subjFilter.clause})` : "";
		let result;
		if (chapter === "_none_" || chapter === "") {
			result = await db.execute({
				sql: `SELECT id, chapter, topic, raw_json, updated_at FROM ${ALL_Q} WHERE (chapter IS NULL OR chapter = '')${extra} ORDER BY topic, question_number, id`,
				args: subjFilter.args,
			});
		} else {
			result = await db.execute({
				sql: `SELECT id, chapter, topic, raw_json, updated_at FROM ${ALL_Q} WHERE chapter = ?${extra} ORDER BY topic, question_number, id`,
				args: [chapter, ...subjFilter.args],
			});
		}
		const groups = {};
		for (const row of result.rows) {
			const key = row.topic || "";
			if (!groups[key]) {
				groups[key] = {
					// CHANGED: was `_id: null`. Must match the same composite key
					// scheme used in /api/admin/questions-meta so the frontend's
					// byId[row._id] lookup in ensureChapterLoaded() correctly pairs
					// each metadata row with its corresponding full row here.
					_id: `${row.chapter || ""}::${row.topic || ""}`,
					chapter: row.chapter || null,
					lecture: row.topic || "",
					topic: row.topic || "",
					updatedAt: row.updated_at || 0,
					questions: [],
				};
			}
			let raw = {};
			try { raw = JSON.parse(row.raw_json || "{}"); } catch { raw = {}; }
			const normalized = normalizeQuestion(raw, { preserveRaw: true });
			normalized._rowId = row.id; // needed so paper-wise view can map a DB row id -> exact question
			groups[key].questions.push(normalized);
			groups[key].updatedAt = Math.max(groups[key].updatedAt, row.updated_at || 0);
		}
		res.json(Object.values(groups));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.delete("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		const rawLecture = decodeURIComponent(req.params.lecture || "");
		const topic = rawLecture === "_none_" ? "" : rawLecture;

		if (chapter && chapter !== "_none_") {
			await deleteQuestionsWhere("topic = ? AND chapter = ?", [topic, chapter]);
		} else {
			await deleteQuestionsWhere("topic = ? AND (chapter IS NULL OR chapter = '')", [topic]);
		}
		await refreshCache(chapter === "_none_" ? "" : chapter, topic);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.put("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
	try {
		const rawChapter = decodeURIComponent(req.params.chapter || "");
		const rawLecture = decodeURIComponent(req.params.lecture || "");
		const oldTopic = rawLecture === "_none_" ? "" : rawLecture;
		const { chapter, topic, questions } = req.body || {};

		if (!Array.isArray(questions)) return res.status(400).json({ error: "Questions array is required." });

		const chapterForMatch = (rawChapter === "_none_" || rawChapter === "") ? "" : rawChapter;
		const chapterForSave = (chapter === "_none_" || chapter === "" || chapter === undefined) ? chapterForMatch : chapter;
		const topicForSave = topic || oldTopic;

		// Manual edit: preserve raw text so removing $ delimiters is honoured.
		let normalizedQuestions = questions.map((q) => normalizeQuestion(q, { preserveRaw: true }));
		normalizedQuestions = await uploadQuestionImages(normalizedQuestions);

		await deleteQuestionsWhere("chapter = ? AND topic = ?", [chapterForMatch, oldTopic]);

		const now = Date.now();
		for (const q of normalizedQuestions) {
			await insertQuestion({
				subject: q.subject,
				unit: q.unit,
				chapter: chapterForSave,
				topic: topicForSave,
				year: q.year,
				month: q.month,
				day: q.day,
				shift: q.shift,
				questionNumber: q.questionNumber,
				questionType: String(q.questionType || "MCQ").trim() || "MCQ",
				rawJson: JSON.stringify(q),
				createdAt: now,
				updatedAt: now,
			});
		}

		await refreshCache(chapterForMatch, oldTopic);
		if (chapterForSave !== chapterForMatch || topicForSave !== oldTopic) {
			await refreshCache(chapterForSave, topicForSave);
		}
		res.json({ success: true, updated: normalizedQuestions.length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/mass-delete", requireAdmin, async (req, res) => {
	try {
		const items = Array.isArray(req.body?.items) ? req.body.items : [];
		console.log("[admin] mass-delete request - items:", items.length, JSON.stringify(items).slice(0, 2000));
		if (!items.length) return res.status(400).json({ error: "No items" });
		let deleted = 0;
		for (const it of items) {
			const chapter = it?.chapter || null;
			const topic = it?.topic ?? it?.lecture;
			if (topic == null) continue;
			if (chapter) {
				await deleteQuestionsWhere("topic = ? AND chapter = ?", [topic, chapter]);
			} else {
				await deleteQuestionsWhere("topic = ? AND (chapter IS NULL OR chapter = '')", [topic]);
			}
			await refreshCache(chapter || "", topic);
			deleted++;
		}
		res.json({ success: true, deleted });
	} catch (e) {
		console.error("[admin] mass-delete error:", e && e.stack ? e.stack : e);
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/rename-chapter", requireAdmin, async (req, res) => {
	try {
		const { oldName, newName } = req.body || {};
		if (!oldName || !newName) return res.status(400).json({ error: "Missing old or new chapter name." });

		// Renames the chapter in BOTH question tables.
		const questionsUpdated = await updateQuestionsWhere("chapter = ?", [newName], "chapter = ?", [oldName]);
		const sr = await db.execute({ sql: "UPDATE students SET chapter = ? WHERE chapter = ?", args: [newName, oldName] });
		const ar = await db.execute({ sql: "UPDATE attempts SET chapter = ? WHERE chapter = ?", args: [newName, oldName] });
		const total = questionsUpdated + (sr.rowsAffected || 0) + (ar.rowsAffected || 0);
		if (!total) return res.status(404).json({ error: "Chapter not found." });

		await loadQuestions();
		res.json({
			success: true,
			updated: {
				questions: questionsUpdated,
				students: sr.rowsAffected || 0,
				attempts: ar.rowsAffected || 0,
				total,
			},
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/rename-topic", requireAdmin, async (req, res) => {
	try {
		const { chapter, oldName, newName } = req.body || {};
		if (!oldName || !newName) return res.status(400).json({ error: "Missing old or new topic name." });
		// Renames the topic in BOTH question tables.
		let updated;
		if (chapter) {
			updated = await updateQuestionsWhere("topic = ?", [newName], "topic = ? AND chapter = ?", [oldName, chapter]);
		} else {
			updated = await updateQuestionsWhere("topic = ?", [newName], "topic = ?", [oldName]);
		}
		if (!updated) return res.status(404).json({ error: "Topic not found." });
		await loadQuestions();
		res.json({ success: true, updated });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


// ── Year index endpoints ────────────────────────────────────────────────────
// `year` is a real column on `pyq_questions` (the regular `questions` bank has
// no year at all), so this is a plain GROUP BY on the PYQ table — no separate
// question_years table to keep in sync.
router.get("/api/admin/year-counts", requireAdmin, async (req, res) => {
	try {
		const perms = await permissionsForRequest(req);
		const subjFilter = subjectSqlFilter(perms, "subject");
		const result = await db.execute({
			sql: `SELECT year, COUNT(*) as count FROM ${PYQ_TABLE}
			      WHERE year IS NOT NULL AND year != ''${subjFilter.clause ? " AND (" + subjFilter.clause + ")" : ""}
			      GROUP BY year ORDER BY year DESC`,
			args: subjFilter.args,
		});
		res.json(result.rows.map(r => ({ year: r.year, count: Number(r.count) })));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// THE ACTUAL SPEED FIX: `year` is a real indexed column on `pyq_questions`,
// so this is a plain WHERE — no JOIN, no parsing/looping through every
// question in unrelated topics, no separate index table that can drift
// out of sync. This is what used to be slow; now it's exactly as fast as
// the chapter/topic browsing queries.
router.get("/api/admin/questions-by-year/:year", requireAdmin, async (req, res) => {
	try {
		const year = decodeURIComponent(req.params.year || "").trim();
		if (!year) return res.status(400).json({ error: "Year required" });

		const perms = await permissionsForRequest(req);
		const subjFilter = subjectSqlFilter(perms, "subject");
		const result = await db.execute({
			sql: `SELECT id, chapter, topic, raw_json
			      FROM ${PYQ_TABLE}
			      WHERE year = ?${subjFilter.clause ? " AND (" + subjFilter.clause + ")" : ""}
			      ORDER BY chapter, topic, question_number, id`,
			args: [year, ...subjFilter.args],
		});

		const questions = result.rows.map((row) => {
			let raw = {};
			try { raw = JSON.parse(row.raw_json || "{}"); } catch { raw = {}; }
			return {
				rowId: row.id,
				chapter: row.chapter || null,
				lecture: row.topic || "", // backward-compat alias
				topic: row.topic || "",
				questionIndex: 0, // no longer meaningful — one question per row now
				question: normalizeQuestion(raw, { preserveRaw: true }),
			};
		});

		res.json({ year, count: questions.length, questions });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// NEW: general paper-wise search — subject + year (+ optionally chapter/
// month/day/shift). Prefer this in new frontend code over the year-only
// route above, since real papers are identified by subject AND year.
router.get("/api/admin/questions-by-paper", requireAdmin, async (req, res) => {
	try {
		const { subject, year, chapter, month, day, shift } = req.query;
		const perms = await permissionsForRequest(req);
		if (subject && !isSubjectAllowed(perms, subject)) {
			return res.json({ count: 0, questions: [] });
		}
		const results = await findQuestionsByPaper({ subject, year, chapter, month, day, shift });
		const visible = filterRowsBySubject(perms, results, (q) => q.subject || (q.question && q.question.subject));
		res.json({ count: visible.length, questions: visible });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// PAPER-WISE (exam + year) DENORMALIZED STORE
// One row per exam+year in the `papers` table, all that paper's questions in a
// single cell. Powers the "Paper wise" section (owner + institute) and the new
// JEE/NEET + question-type filters.
// ═══════════════════════════════════════════════════════════════════════════
const PAPER_EXAMS = ["JEE Mains", "JEE Advanced", "NEET"];

// PYQ data mapping: Maths → JEE Mains, all other subjects → NEET.
// An optional examHint (from raw_json.exam) is trusted if present.
function examForSubject(subject, examHint) {
	if (examHint) return normalizeExam(examHint);
	const s = String(subject || "").trim().toLowerCase();
	if (s === "maths" || s === "math" || s === "mathematics") return "JEE Mains";
	return "NEET";
}

// Normalize any incoming exam string to one of PAPER_EXAMS.
function normalizeExam(e) {
	const s = String(e || "").trim().toLowerCase();
	if (s.includes("advanced") || s === "jee_advanced") return "JEE Advanced";
	if (s.includes("neet")) return "NEET";
	if (s.includes("jee") || s.includes("main")) return "JEE Mains";
	return "NEET";
}

// Append a batch of (already-normalized) question objects into the papers row
// for (exam, year), creating the row if needed.
async function appendQuestionsToPaper(exam, year, label, questions) {
	const ex = normalizeExam(exam);
	const yr = String(year || "Regular").trim() || "Regular";
	const lbl = String(label || `${ex} ${yr}`).trim();
	const now = Date.now();
	const existing = await db.execute({
		sql: "SELECT id, questions_json FROM papers WHERE exam = ? AND year = ? LIMIT 1",
		args: [ex, yr],
	});
	let arr = [];
	let id = null;
	if (existing.rows.length) {
		id = existing.rows[0].id;
		try { arr = JSON.parse(existing.rows[0].questions_json || "[]"); } catch { arr = []; }
		if (!Array.isArray(arr)) arr = [];
	}
	for (const q of questions) arr.push(q);
	if (id) {
		await db.execute({
			sql: "UPDATE papers SET questions_json = ?, question_count = ?, label = ?, updated_at = ? WHERE id = ?",
			args: [JSON.stringify(arr), arr.length, lbl, now, id],
		});
	} else {
		await db.execute({
			sql: "INSERT INTO papers (exam, year, label, questions_json, question_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			args: [ex, yr, lbl, JSON.stringify(arr), arr.length, now, now],
		});
	}
}

// ─── Core rebuild logic (also called from server.js on startup) ────────────
// Reads ALL rows of `pyq_questions`, groups by (exam, year),
// and rewrites the papers table. Month / day / shift are embedded into each
// question object so the UI can display shift-level labels for JEE Mains.
async function rebuildPapersFromPyq() {
	const result = await db.execute(
		`SELECT subject, year, month, day, shift, raw_json FROM ${PYQ_TABLE} WHERE year IS NOT NULL AND year != ''`
	);
	const grouped = {};
	for (const row of result.rows) {
		const year = String(row.year || "").trim();
		if (!year) continue;
		let q = {};
		try { q = JSON.parse(row.raw_json || "{}"); } catch { q = {}; }
		// Trust embedded exam tag first, otherwise infer from subject.
		const examHint = q.exam || q.examName || "";
		const exam = examForSubject(row.subject, examHint);
		// Attach month / day / shift so the UI can label JEE Mains shifts.
		if (row.month) q._month = String(row.month).trim();
		if (row.day) q._day = String(row.day).trim();
		if (row.shift) q._shift = String(row.shift).trim();
		q._exam = exam;
		const key = `${exam}|||${year}`;
		if (!grouped[key]) grouped[key] = { exam, year, questions: [] };
		grouped[key].questions.push(q);
	}
	// Wipe existing non-Regular rows and rewrite them from scratch.
	await db.execute("DELETE FROM papers WHERE year != 'Regular'");
	let papers = 0, total = 0;
	for (const key of Object.keys(grouped)) {
		const g = grouped[key];
		await appendQuestionsToPaper(g.exam, g.year, `${g.exam} ${g.year}`, g.questions);
		papers++;
		total += g.questions.length;
	}
	// Re-seed the three rolling "Regular" rows so they always exist.
	const now = Date.now();
	for (const [ex, yr, lbl] of [
		["JEE Mains", "Regular", "JEE Regular Ques"],
		["NEET", "Regular", "NEET Regular Ques"],
		["JEE Advanced", "Regular", "JEE Advanced Regular Ques"],
	]) {
		try {
			await db.execute({
				sql: "INSERT OR IGNORE INTO papers (exam, year, label, questions_json, question_count, created_at, updated_at) VALUES (?, ?, ?, '[]', 0, ?, ?)",
				args: [ex, yr, lbl, now, now],
			});
		} catch (_) { }
	}
	return { papers, questions: total };
}

// List papers, optionally filtered by exam and/or question_type. Returns light
// rows (no question blobs) plus the canonical exam list for the filter UI.
router.get("/api/admin/papers", requireAdmin, async (req, res) => {
	try {
		const { exam, question_type } = req.query;
		let sql = "SELECT id, exam, year, label, question_count, questions_json FROM papers";
		const args = [];
		if (exam && String(exam).trim()) { sql += " WHERE exam = ?"; args.push(normalizeExam(exam)); }
		sql += " ORDER BY exam, CASE WHEN year = 'Regular' THEN 1 ELSE 0 END, year DESC";
		const result = await db.execute({ sql, args });
		const qt = question_type ? String(question_type).trim().toUpperCase() : "";
		const papers = result.rows.map((r) => {
			let count = Number(r.question_count) || 0;
			if (qt) {
				let arr = [];
				try { arr = JSON.parse(r.questions_json || "[]"); } catch { arr = []; }
				count = (Array.isArray(arr) ? arr : []).filter(
					(q) => String(q.question_type || q.questionType || "MCQ").toUpperCase() === qt
				).length;
			}
			return { id: r.id, exam: r.exam, year: r.year, label: r.label || `${r.exam} ${r.year}`, count };
		});
		res.json({ exams: PAPER_EXAMS, papers });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Fetch one paper's questions (optionally filtered by question_type).
router.get("/api/admin/papers/:id", requireAdmin, async (req, res) => {
	try {
		const id = parseInt(req.params.id, 10);
		const { question_type } = req.query;
		const result = await db.execute({
			sql: "SELECT id, exam, year, label, questions_json FROM papers WHERE id = ? LIMIT 1",
			args: [id],
		});
		if (!result.rows.length) return res.status(404).json({ error: "Not found" });
		const row = result.rows[0];
		let arr = [];
		try { arr = JSON.parse(row.questions_json || "[]"); } catch { arr = []; }
		if (!Array.isArray(arr)) arr = [];
		const qt = question_type ? String(question_type).trim().toUpperCase() : "";
		let questions = arr.map((q, i) => ({ paperIndex: i, question: normalizeQuestion(q, { preserveRaw: true }) }));
		if (qt) {
			questions = questions.filter(
				(x) => String(x.question.question_type || x.question.questionType || "MCQ").toUpperCase() === qt
			);
		}
		res.json({ id: row.id, exam: row.exam, year: row.year, label: row.label || `${row.exam} ${row.year}`, count: questions.length, questions });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Append imported questions into paper rows. Body: { buckets: [{exam, year, label, questions}] }.
// Used by the JSON-import flow to route JEE/NEET uploads into the right paper
// (PYQ → its year row; non-PYQ → the exam's "Regular Ques" row).
router.post("/api/admin/papers/append", requireAdmin, async (req, res) => {
	try {
		const buckets = Array.isArray(req.body?.buckets) ? req.body.buckets : [];
		if (!buckets.length) return res.status(400).json({ error: "No buckets provided" });
		let total = 0;
		for (const b of buckets) {
			const qs = Array.isArray(b.questions) ? b.questions.map(normalizeQuestion) : [];
			if (!qs.length) continue;
			await appendQuestionsToPaper(b.exam, b.year, b.label, qs);
			total += qs.length;
		}
		res.json({ success: true, added: total });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Rebuild papers table from existing pyq_questions via the rebuildPapersFromPyq() helper.
// Exposed as a POST endpoint so the admin UI can trigger it manually.
router.post("/api/admin/papers/rebuild", requireAdmin, async (req, res) => {
	try {
		const { papers, questions } = await rebuildPapersFromPyq();
		res.json({ success: true, papers, questions });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// rebuild-year-index — NO LONGER NEEDED. There is no separate index table
// to rebuild now that `year` is a real column. Kept as a no-op so any old
// frontend "rebuild index" button doesn't 404 — safe to delete once you've
// updated the frontend to stop calling it.
router.post("/api/admin/rebuild-year-index", requireAdmin, async (req, res) => {
	res.json({ success: true, indexed: 0, rows: 0, note: "No-op: year is a real column on pyq_questions — there is no separate year index to rebuild." });
});

router.post("/api/admin/reload-cache", requireAdmin, async (req, res) => {
	try {
		await loadQuestions();
		res.json({ success: true, chapters: getChapterList().length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// /api/admin/migrate (GET+POST) — these detected corrupted questions_json
// arrays in the OLD table (a row whose array failed to parse). That failure
// mode doesn't exist in the current schema: each row is already one normalized
// question object, not a JSON array that can desync internally. Kept as
// harmless no-ops so old frontend "check for corruption" buttons don't 404;
// safe to delete both routes once you've updated the frontend.
router.get("/api/admin/migrate", requireAdmin, async (req, res) => {
	res.json({ total: 0, corrupted: 0, corruptedLectures: [], note: "No-op: questions / pyq_questions rows can't desync the way old JSON-array rows could." });
});

router.post("/api/admin/migrate", requireAdmin, async (req, res) => {
	res.json({ success: true, deleted: 0, message: "No-op: questions / pyq_questions rows can't desync the way old JSON-array rows could." });
});



/* ─────────────────────────────────────────────────────────────────────────────
   NEW POWERFUL EXTRACT ROUTE  v2
   ──────────────────────────────────────────────────────────────────────��──────
   Architecture:
   1. PARALLEL primary extraction  – every image sent to Groq simultaneously
   2. COUNT VERIFICATION           – AI counts visible question numbers per image
   3. TARGETED RECOVERY            – only re-query images where count < expected
   4. CROSS-IMAGE BOUNDARY MERGE   – detect & stitch split questions at page edges
   5. ANSWER-KEY MERGE             – overlay correct answers from key image/text
   6. RICH DEDUP + NUMBER SORT     – eliminate duplicates, sort by question number
   7. FINAL NORMALISATION          – normalise math, fill empty options, validate
───────────────────────────────────────────────────────────────────────────── */

router.post("/api/admin/pyq-tag-questions", requireAdmin, async (req, res) => {
	try {
		const { questions } = req.body || {};
		if (!Array.isArray(questions) || !questions.length) return res.status(400).json({ error: "questions array required" });
		if (!GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not set" });

		const TAG_SYSTEM = `You are a JEE Main syllabus expert. Tag each numbered MCQ question with the best matching unit, chapter and topic from this syllabus:

${JEE_SYLLABUS_CONTEXT}

OUTPUT: ONLY a valid JSON array — no markdown, no explanation. Each element: {"unit":"UNIT N — NAME","chapter":"Exact Chapter Name","topic":"Specific Topic"}. Array length MUST equal input count exactly. Use \General\ if truly unsure.`;

		const BATCH_SIZE = 10;
		const allTags = [];
		for (let i = 0; i < questions.length; i += BATCH_SIZE) {
			const batch = questions.slice(i, i + BATCH_SIZE);
			const prompt = batch.map((q, idx) => (idx + 1) + ". " + String(q).slice(0, 350)).join("\n");
			try {
				const raw = await callGroq([], TAG_SYSTEM, prompt, 2000, 0.0);
				const clean = raw.replace(/```json|```/g, "").trim();
				const parsed = JSON.parse(clean);
				if (Array.isArray(parsed)) allTags.push(...parsed);
				else batch.forEach(() => allTags.push({ unit: "", chapter: "General", topic: "" }));
			} catch (bErr) {
				console.warn("[pyq-tag] batch failed:", bErr.message);
				batch.forEach(() => allTags.push({ unit: "", chapter: "General", topic: "" }));
			}
		}
		res.json({ tags: allTags });
	} catch (e) {
		console.error("/api/admin/pyq-tag-questions error:", e);
		res.status(500).json({ error: e.message || "Tagging failed" });
	}
});

/* ──────────────────────────────────────────────────────────────────────────
   BULK PDF EXTRACT — NVIDIA NIM (Llama 3.2 Vision) reads every page, streams NDJSON back
   ────────────────────────────────────────────────────────────────────────── */

const JEE_CHAPTER_MAP = {
	Physics: {
		"Units, Dimensions and Measurements": ["dimension", "dimensional formula", "significant figures", "error propagation", "SI unit", "fundamental unit", "derived unit", "dimensional analysis"],
		"Motion in One Dimension": ["equations of motion", "free fall", "displacement", "speed", "velocity", "acceleration", "graph of motion", "kinematics"],
		"Motion in Two Dimensions": ["projectile", "relative velocity", "vector resolution", "two dimension"],
		"Laws of Motion": ["newton", "friction", "circular motion dynamics", "pulley", "pseudo force", "inertia"],
		"Work, Power and Energy": ["work done", "kinetic energy", "potential energy", "conservation of energy", "power", "work-energy"],
		"Center of Mass and Collision": ["center of mass", "momentum", "impulse", "elastic collision", "inelastic collision"],
		"Rotational Motion": ["torque", "angular momentum", "moment of inertia", "rolling", "rotational"],
		"Gravitation": ["gravitation", "escape velocity", "satellite", "kepler", "orbital"],
		"Mechanical Properties of Solids": ["stress", "strain", "elasticity", "young modulus", "young's modulus"],
		"Mechanical Properties of Fluids": ["surface tension", "viscosity", "bernoulli", "fluid pressure", "streamline"],
		"Thermal Properties of Matter": ["thermal expansion", "calorimetry", "heat transfer", "specific heat", "latent heat"],
		"Kinetic Theory of Gases": ["ideal gas", "degrees of freedom", "rms speed", "kinetic theory", "mean free path"],
		"Thermodynamics": ["carnot", "isothermal", "adiabatic", "first law", "second law", "entropy", "thermodynamics"],
		"Simple Harmonic Motion (SHM)": ["simple harmonic", "shm", "spring constant", "pendulum", "time period", "oscillation"],
		"Waves": ["sound wave", "doppler", "standing wave", "resonance", "wave speed", "superposition"],
		"Electric Charges and Fields": ["coulomb", "electric field", "electric flux", "gauss law", "charge distribution"],
		"Electrostatic Potential and Capacitance": ["electric potential", "capacitor", "capacitance", "energy stored", "dielectric"],
		"Current Electricity": ["drift velocity", "ohm", "kirchhoff", "wheatstone", "potentiometer", "resistance", "resistivity"],
		"Moving Charges and Magnetism": ["lorentz", "biot-savart", "ampere", "cyclotron", "magnetic field", "solenoid"],
		"Magnetism and Matter": ["magnetic dipole", "earth magnetism", "paramagnetic", "diamagnetic", "ferromagnetic"],
		"Electromagnetic Induction": ["faraday", "lenz", "eddy current", "self inductance", "mutual inductance", "flux"],
		"Alternating Current": ["rms value", "lcr", "resonance", "transformer", "alternating current", "impedance", "reactance"],
		"Electromagnetic Waves": ["maxwell", "em spectrum", "electromagnetic wave", "speed of light"],
		"Ray Optics": ["reflection", "refraction", "mirror formula", "lens formula", "prism", "optical instrument", "snell"],
		"Wave Optics": ["interference", "diffraction", "polarisation", "ydse", "young", "fringe width", "coherent"],
		"Dual Nature of Radiation and Matter": ["photoelectric", "de broglie", "photon", "work function", "stopping potential"],
		"Atoms": ["rutherford", "bohr", "hydrogen spectrum", "atomic model", "energy level", "orbit"],
		"Nuclei": ["radioactivity", "binding energy", "nuclear reaction", "half life", "decay constant"],
		"Semiconductor Electronics": ["pn junction", "diode", "transistor", "logic gate", "zener", "semiconductor", "truth table"],
	},
	Chemistry: {
		"Some Basic Concepts of Chemistry": ["mole concept", "stoichiometry", "molarity", "molality", "normality", "equivalent"],
		"Atomic Structure": ["bohr model", "quantum number", "electronic configuration", "orbital", "aufbau", "hund"],
		"States of Matter": ["gas law", "ideal gas", "van der waals", "kinetic theory of gas", "compressibility"],
		"Thermodynamics": ["enthalpy", "entropy", "gibbs", "hess", "thermodynamics", "spontaneity", "bond enthalpy"],
		"Equilibrium": ["equilibrium constant", "kp", "kc", "ionic equilibrium", "buffer", "henderson"],
		"Redox Reactions": ["oxidation number", "redox", "balancing", "half reaction", "oxidation state"],
		"Solutions": ["colligative", "raoult", "depression in freezing", "elevation in boiling", "osmotic pressure"],
		"Electrochemistry": ["electrolysis", "nernst", "conductance", "cell potential", "electrode", "faraday"],
		"Chemical Kinetics": ["rate law", "order of reaction", "arrhenius", "rate constant", "half life kinetics"],
		"Surface Chemistry": ["adsorption", "catalysis", "colloid", "micelle", "emulsion", "tyndall"],
		"Classification of Elements and Periodicity": ["periodic table", "periodic trend", "ionisation energy", "electron affinity", "electronegativity"],
		"Chemical Bonding and Molecular Structure": ["ionic bond", "covalent bond", "hybridization", "vsepr", "mot", "sigma bond", "pi bond", "bond order"],
		"Hydrogen": ["hydride", "water", "hydrogen peroxide", "heavy water"],
		"s-Block Elements": ["alkali metal", "alkaline earth", "sodium", "potassium", "calcium", "magnesium", "lithium"],
		"p-Block Elements": ["group 13", "group 14", "group 15", "group 16", "group 17", "group 18", "halogen", "noble gas", "phosphorus", "sulphur", "nitrogen", "boron", "silicon"],
		"d and f Block Elements": ["transition element", "lanthanide", "actinide", "d-block", "f-block", "chromium", "iron", "copper", "zinc"],
		"Coordination Compounds": ["ligand", "werner", "coordination", "complex", "cfse", "spectrochemical"],
		"Metallurgy": ["extraction", "refining", "ore", "smelting", "roasting", "calcination"],
		"Environmental Chemistry": ["pollution", "smog", "ozone", "greenhouse", "acid rain"],
		"General Organic Chemistry (GOC)": ["inductive effect", "resonance effect", "hyperconjugation", "carbocation", "carbanion", "free radical"],
		"Hydrocarbons": ["alkane", "alkene", "alkyne", "benzene", "aromatic", "markovnikov"],
		"Haloalkanes and Haloarenes": ["haloalkane", "haloarene", "sn1", "sn2", "e1", "e2", "elimination"],
		"Alcohols, Phenols and Ethers": ["alcohol", "phenol", "ether", "dehydration", "lucas", "victor meyer"],
		"Aldehydes and Ketones": ["aldehyde", "ketone", "nucleophilic addition", "cannizzaro", "aldol", "fehling", "tollens"],
		"Carboxylic Acids": ["carboxylic acid", "ester", "amide", "acylation", "esterification", "saponification"],
		"Amines": ["amine", "basicity of amine", "diazotisation", "coupling reaction", "gabriel", "hofmann"],
		"Biomolecules": ["carbohydrate", "protein", "dna", "rna", "amino acid", "enzyme", "glucose"],
		"Polymers": ["polymerisation", "polymer", "monomer", "nylon", "teflon", "rubber", "bakelite"],
		"Chemistry in Everyday Life": ["drug", "antibiotic", "analgesic", "disinfectant", "detergent"],
		"Practical Chemistry": ["salt analysis", "titration", "functional group test", "iodoform", "lassaigne"],
	},
	Mathematics: {
		"Sets, Relations and Functions": ["set", "relation", "function", "inverse function", "domain", "range", "bijection"],
		"Inverse Trigonometric Functions": ["arcsin", "arccos", "arctan", "principal value", "inverse trig"],
		"Complex Numbers and Quadratic Equations": ["complex number", "quadratic", "argand", "modulus", "argument", "conjugate", "roots of unity"],
		"Matrices": ["matrix", "matrices", "transpose", "symmetric matrix", "skew symmetric", "orthogonal"],
		"Determinants": ["determinant", "adjugate", "adjoint", "cramer", "singular matrix"],
		"Permutations and Combinations": ["permutation", "combination", "factorial", "derangement", "circular arrangement"],
		"Binomial Theorem": ["binomial theorem", "binomial expansion", "general term", "middle term", "binomial coefficient"],
		"Sequence and Series": ["arithmetic progression", "geometric progression", "harmonic progression", "ap", "gp", "hp", "arithmetico-geometric"],
		"Mathematical Induction": ["mathematical induction", "principle of induction"],
		"Probability": ["probability", "conditional probability", "bayes theorem", "binomial distribution", "random variable"],
		"Statistics": ["mean", "variance", "standard deviation", "median", "mode", "coefficient of variation"],
		"Mathematical Reasoning": ["truth table", "tautology", "contradiction", "converse", "contrapositive", "biconditional"],
		"Trigonometric Ratios and Identities": ["compound angle", "product to sum", "sum to product", "multiple angle", "submultiple", "trigonometric identit"],
		"Trigonometric Equations": ["trigonometric equation", "general solution", "principal solution"],
		"Straight Lines": ["slope", "intercept", "angle between lines", "distance from point", "equation of line"],
		"Pair of Straight Lines": ["pair of lines", "homogeneous equation", "combined equation"],
		"Circle": ["circle", "tangent to circle", "chord of contact", "radical axis", "director circle"],
		"Parabola": ["parabola", "focus", "directrix", "latus rectum", "tangent to parabola", "normal to parabola"],
		"Ellipse": ["ellipse", "eccentricity", "semi-major", "semi-minor", "tangent to ellipse"],
		"Hyperbola": ["hyperbola", "asymptote", "rectangular hyperbola", "conjugate hyperbola"],
		"Limits": ["limit", "l'hopital", "standard limit", "sandwich theorem", "infinite limit"],
		"Continuity and Differentiability": ["continuity", "differentiability", "continuous function", "intermediate value"],
		"Methods of Differentiation": ["chain rule", "implicit differentiation", "logarithmic differentiation", "parametric"],
		"Applications of Derivatives": ["maxima", "minima", "tangent", "normal", "rate of change", "increasing", "decreasing", "rolle", "lagrange", "mean value theorem"],
		"Indefinite Integrals": ["indefinite integral", "antiderivative", "substitution", "partial fraction", "integration by parts"],
		"Definite Integrals": ["definite integral", "area under curve", "properties of definite integral", "newton-leibniz"],
		"Differential Equations": ["differential equation", "variable separable", "linear differential", "homogeneous differential", "bernoulli"],
		"Vector Algebra": ["dot product", "cross product", "scalar triple", "vector triple", "collinear vector", "coplanar"],
		"Three Dimensional Geometry": ["direction cosine", "direction ratio", "skew lines", "shortest distance", "equation of plane", "equation of line in 3d"],
		"Linear Programming": ["linear programming", "constraint", "objective function", "feasible region", "corner point"],
	},
};

function predictChapterBulk(subject, questionText) {
	const text = (questionText || "").toLowerCase();
	const map = JEE_CHAPTER_MAP[subject] || {};
	let best = "General", bestScore = 0;
	for (const [chapter, keywords] of Object.entries(map)) {
		let score = 0;
		for (const kw of keywords) { if (text.includes(kw.toLowerCase())) score++; }
		if (score > bestScore) { bestScore = score; best = chapter; }
	}
	return best;
}

const BULK_PAGE_PROMPT = `You are extracting questions from a JEE Main exam PDF page image.

PAPER FORMAT:
- Two-column layout. Left: question number, question text, options (1)(2)(3)(4), "Ans.(X)". Right: "Sol." + solution.
- Three subjects in order: MATHEMATICS → PHYSICS → CHEMISTRY (each marked by bold section header).
- Section A: MCQ (4 options, one correct). Section B: Numerical/integer answer (no options).
- Question numbers are continuous across subjects (e.g. Math Q1-25, Physics Q26-50, Chem Q51-75).

EXTRACT every question visible. Return ONLY a JSON array (no markdown, no explanation):
[{"questionNumber":1,"subject":"Mathematics","section":"A","questionText":"full question with math in $...$","options":["(1) text","(2) text","(3) text","(4) text"],"correctAnswer":"3","correctIndexes":[2],"solutionText":"full step-by-step solution with LaTeX math","hasQuestionImage":false}]

RULES:
1. Wrap ALL math in $...$. E.g. $\\frac{a}{b}$, $\\sqrt{x^2+1}$, $x^2+y^2=r^2$
2. Chemical formulas: H$_2$O, Fe$_3$O$_4$, CO$_2$ etc.
3. Section B (no options): options:[], correctIndexes:[], correctAnswer: the integer shown.
4. correctIndexes: option (1)->[0], (2)->[1], (3)->[2], (4)->[3].
5. Subject header (MATHEMATICS/PHYSICS/CHEMISTRY) applies to all questions below it on that page.
6. Tables in options: render as markdown table inside the option string.
7. Include cut-off questions with what is visible.
8. DO NOT skip any question. If page has no questions (title/instructions page), return [].
9. ALWAYS include solutionText — extract the full solution shown next to each question. Preserve all steps.
10. correctAnswer must be the option number (1-4) for Section A, or the numerical value for Section B.`;

const bulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Canvas factory for pdfjs-dist Node.js rendering ──
const nodeCanvasFactory = {
	create(width, height) {
		const canvas = createCanvas(width, height);
		return { canvas, context: canvas.getContext('2d') };
	},
	reset(canvasAndContext, width, height) {
		canvasAndContext.canvas.width = width;
		canvasAndContext.canvas.height = height;
	},
	destroy(canvasAndContext) {
		canvasAndContext.canvas = null;
		canvasAndContext.context = null;
	}
};

// ── Parse JSON array from LLM response text ──
function parseLLMJSON(raw) {
	if (!raw) return { questions: [], hadContent: false };
	let s = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
	const hadContent = s.length > 0;
	const start = s.indexOf("[");
	const end = s.lastIndexOf("]");
	if (start === -1 || end === -1 || end < start) return { questions: [], hadContent };
	s = s.slice(start, end + 1);
	try { return { questions: JSON.parse(s), hadContent }; }
	catch {
		// Try fixing trailing commas
		s = s.replace(/,(\s*[}\]])/g, "$1");
		try { return { questions: JSON.parse(s), hadContent }; }
		catch (e2) {
			console.error("[bulk-pdf-extract] LLM JSON parse failed:", e2.message, "| Sample:", s.slice(0, 300));
			return { questions: [], hadContent };
		}
	}
}


router.get("/api/admin/paper-templates", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req);
		const queryInstId = req.query.instituteId ? Number(req.query.instituteId) : null;
		let rows;
		if (queryInstId) {
			const result = await db.execute({
				sql: "SELECT pt.id, pt.name, pt.created_at, pt.institute_id, i.name AS institute_name FROM paper_templates pt LEFT JOIN institutes i ON pt.institute_id = i.id WHERE pt.institute_id = ? ORDER BY pt.created_at DESC",
				args: [queryInstId]
			});
			rows = result.rows;
		} else if (instId) {
			const result = await db.execute({
				sql: "SELECT pt.id, pt.name, pt.created_at, pt.institute_id, i.name AS institute_name FROM paper_templates pt LEFT JOIN institutes i ON pt.institute_id = i.id WHERE pt.institute_id = ? ORDER BY pt.created_at DESC",
				args: [instId]
			});
			rows = result.rows;
		} else {
			const result = await db.execute("SELECT pt.id, pt.name, pt.created_at, pt.institute_id, i.name AS institute_name FROM paper_templates pt LEFT JOIN institutes i ON pt.institute_id = i.id ORDER BY pt.created_at DESC");
			rows = result.rows;
		}
		res.json(rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, instituteId: r.institute_id, instituteName: r.institute_name || null })));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// POST upload a new template
router.post("/api/admin/paper-templates", requireAdmin, upload.single("template"), async (req, res) => {
	try {
		if (!req.file) return res.status(400).json({ error: "No file uploaded" });
		if (!req.file.originalname.endsWith(".docx")) return res.status(400).json({ error: "Only .docx templates are supported" });
		const name = req.body.name || req.file.originalname.replace(/\.docx$/i, "");
		const base64 = req.file.buffer.toString("base64");
		const sessionInstId = sessionInstituteId(req);
		const instId = req.body.instituteId ? Number(req.body.instituteId) : (sessionInstId || null);
		const result = await db.execute({
			sql: "INSERT INTO paper_templates (name, docx_base64, created_at, institute_id) VALUES (?, ?, ?, ?)",
			args: [name, base64, Date.now(), instId]
		});
		res.json({ success: true, id: Number(result.lastInsertRowid), name, instituteId: instId });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to upload template" });
	}
});

// DELETE a template by id

router.delete("/api/admin/paper-templates/:id", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req);
		if (instId) {
			await db.execute({ sql: "DELETE FROM paper_templates WHERE id = ? AND institute_id = ?", args: [Number(req.params.id), instId] });
		} else {
			await db.execute({ sql: "DELETE FROM paper_templates WHERE id = ?", args: [Number(req.params.id)] });
		}
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// PATCH rename a template
router.patch("/api/admin/paper-templates/:id", requireAdmin, async (req, res) => {
	try {
		const { name } = req.body || {};
		if (!name) return res.status(400).json({ error: "name required" });
		const instId = sessionInstituteId(req);
		if (instId) {
			await db.execute({ sql: "UPDATE paper_templates SET name = ? WHERE id = ? AND institute_id = ?", args: [name, Number(req.params.id), instId] });
		} else {
			await db.execute({ sql: "UPDATE paper_templates SET name = ? WHERE id = ?", args: [name, Number(req.params.id)] });
		}
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


router.get("/api/admin/star-quiz/questions", requireAdmin, requireFeature("starQuiz"), async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM star_quiz_questions ORDER BY chapter, CAST(lecture AS INTEGER)");
		res.json(result.rows.map(normalizeQuestionRow));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET chapters for STAR Quiz
router.get("/api/admin/star-quiz/chapters", requireAdmin, requireFeature("starQuiz"), async (req, res) => {
	try {
		const result = await db.execute("SELECT DISTINCT chapter FROM star_quiz_questions WHERE chapter IS NOT NULL AND chapter != '' ORDER BY chapter");
		res.json(result.rows.map(r => r.chapter));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// POST add STAR Quiz questions
router.post("/api/admin/star-quiz/add-question", requireAdmin, requireFeature("starQuiz"), async (req, res) => {
	try {
		let { chapter, lecture, topic, questions, replace } = req.body || {};
		if (!chapter || !lecture || !Array.isArray(questions) || !questions.length) {
			return res.status(400).json({ error: "Missing chapter, lecture, or questions" });
		}
		// When replace=true this request originates from a manual edit (the editor
		// deletes the old lecture and re-inserts it after changing chapter/lecture),
		// so preserve raw text and do not re-wrap deliberately un-wrapped equations.
		const _nq = (q) => normalizeQuestion(q, replace ? { preserveRaw: true } : undefined);
		questions = questions.map(_nq);
		questions = await uploadQuestionImages(questions);

		const r = await db.execute({ sql: "SELECT * FROM star_quiz_questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
		const existing = r.rows[0] || null;

		if (existing) {
			const oldQs = replace ? [] : (() => { try { return JSON.parse(existing.questions_json || "[]"); } catch { return []; } })();
			const merged = [...oldQs, ...questions];
			await db.execute({ sql: "UPDATE star_quiz_questions SET questions_json = ?, topic = ?, updated_at = ? WHERE id = ?", args: [JSON.stringify(merged), topic || existing.topic || "", Date.now(), existing.id] });
			return res.json({ success: true, added: questions.length, total: merged.length });
		}

		await db.execute({ sql: "INSERT INTO star_quiz_questions (chapter, lecture, topic, questions_json, updated_at, access_code) VALUES (?, ?, ?, ?, ?, ?)", args: [chapter, lecture, topic || "", JSON.stringify(questions), Date.now(), null] });
		res.json({ success: true, added: questions.length, total: questions.length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// DELETE a STAR Quiz question set
router.delete("/api/admin/star-quiz/question/:chapter/:lecture", requireAdmin, requireFeature("starQuiz"), async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		const lecture = decodeURIComponent(req.params.lecture || "");
		await db.execute({ sql: "DELETE FROM star_quiz_questions WHERE chapter = ? AND lecture = ?", args: [chapter, lecture] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// PUT update a STAR Quiz question set
router.put("/api/admin/star-quiz/question/:chapter/:lecture", requireAdmin, requireFeature("starQuiz"), async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		const lecture = decodeURIComponent(req.params.lecture || "");
		const { topic, questions } = req.body || {};
		if (!Array.isArray(questions)) return res.status(400).json({ error: "Questions array required" });

		// Manual edit: preserve raw text so removing $ delimiters is honoured.
		let normalized = questions.map((q) => normalizeQuestion(q, { preserveRaw: true }));
		normalized = await uploadQuestionImages(normalized);
		await db.execute({ sql: "UPDATE star_quiz_questions SET questions_json = ?, topic = ?, updated_at = ? WHERE chapter = ? AND lecture = ?", args: [JSON.stringify(normalized), topic || "", Date.now(), chapter, lecture] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: Set access code for a star quiz lecture ───────────────────────────
router.post("/api/admin/star-quiz/set-code/:chapter/:lecture", requireAdmin, requireFeature("starQuiz"), async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		const lecture = decodeURIComponent(req.params.lecture || "");
		const { accessCode } = req.body || {};
		// Allow null/empty to clear the code
		if (accessCode === null || accessCode === "" || accessCode === undefined) {
			await db.execute({ sql: "UPDATE star_quiz_questions SET access_code = NULL WHERE chapter = ? AND lecture = ?", args: [chapter, lecture] });
			return res.json({ success: true, accessCode: null });
		}
		if (!/^[0-9]{4}$/.test(String(accessCode))) {
			return res.status(400).json({ error: "Access code must be exactly 4 digits" });
		}
		// Check uniqueness across other lectures
		const existing = await db.execute({ sql: "SELECT chapter, lecture FROM star_quiz_questions WHERE access_code = ? AND NOT (chapter = ? AND lecture = ?)", args: [accessCode, chapter, lecture] });
		if (existing.rows.length) {
			return res.status(409).json({ error: "This code is already used by another lecture" });
		}
		await db.execute({ sql: "UPDATE star_quiz_questions SET access_code = ? WHERE chapter = ? AND lecture = ?", args: [accessCode, chapter, lecture] });
		res.json({ success: true, accessCode });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


// ── ADMIN: create / assign an online test ────────────────────────────────────
/**
 * Number(x) || fallback silently turns a deliberate 0 into the fallback, which
 * is why choosing "0 marks for a wrong answer" kept saving as -1. Only fall
 * back when the value is genuinely missing or not a number.
 */
function numOr(value, fallback) {
	if (value === null || value === undefined || value === "") return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

router.post("/api/admin/online-tests", requireAdmin, requireFeature("onlineTests"), async (req, res) => {
	try {
		const { testName, questionKeys, questions, marksCorrect, marksWrong, liveAt, endsAt, durationMinutes, assignedRolls, maxAttempts, isStrict } = req.body || {};

		// Accept either questionKeys (new format) or questions (legacy full objects)
		const keys = Array.isArray(questionKeys) && questionKeys.length ? questionKeys : null;
		const legacyQuestions = Array.isArray(questions) && questions.length ? questions : null;

		if (!keys && !legacyQuestions)
			return res.status(400).json({ error: "questionKeys array required" });

		const qCount = keys ? keys.length : legacyQuestions.length;
		const now = Date.now();
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());

		const result = await db.execute({
			sql: `INSERT INTO online_tests (test_name, institute_id, question_keys_json, questions_json, marks_correct, marks_wrong, live_at, ends_at, assigned_rolls, created_at, duration_minutes, question_count, max_attempts, is_strict)
			      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				String(testName || "Online Test").trim(),
				instId,
				JSON.stringify(keys || []),
				// questions_json kept for backward-compat — empty if keys provided, else legacy data
				keys ? "[]" : JSON.stringify(legacyQuestions),
				numOr(marksCorrect, 4),
				numOr(marksWrong, -1),
				Number(liveAt) || now,
				Number(endsAt) || (now + 7 * 24 * 60 * 60 * 1000),
				JSON.stringify(Array.isArray(assignedRolls) ? assignedRolls : []),
				now,
				Number(durationMinutes) || 90,
				qCount,
				Number(maxAttempts) || 1,
				isStrict ? 1 : 0,
			],
		});
		res.json({ success: true, id: Number(result.lastInsertRowid) });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: list all online tests ─────────────────────────────────────────────
router.get("/api/admin/online-tests", requireAdmin, requireFeature("onlineTests"), async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({
			sql: "SELECT id, test_name, marks_correct, marks_wrong, live_at, ends_at, assigned_rolls, created_at, duration_minutes, max_attempts, is_strict FROM online_tests WHERE institute_id = ? ORDER BY created_at DESC",
			args: [instId],
		});
		res.json(result.rows.map(r => ({
			id: r.id,
			testName: r.test_name,
			marksCorrect: numOr(r.marks_correct, 4),
			marksWrong: numOr(r.marks_wrong, -1),
			liveAt: r.live_at,
			endsAt: r.ends_at,
			assignedRolls: (() => { try { return JSON.parse(r.assigned_rolls || "[]"); } catch { return []; } })(),
			createdAt: r.created_at,
			durationMinutes: r.duration_minutes || 90,
			maxAttempts: r.max_attempts || 1,
			isStrict: r.is_strict === 1,
		})));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: update an online test ─────────────────────────────────────────────
router.put("/api/admin/online-tests/:id", requireAdmin, requireFeature("onlineTests"), async (req, res) => {
	try {
		const testId = Number(req.params.id);
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const { testName, questionKeys, questions, marksCorrect, marksWrong, liveAt, endsAt, durationMinutes, assignedRolls, maxAttempts, isStrict } = req.body || {};

		const keys = Array.isArray(questionKeys) && questionKeys.length ? questionKeys : null;
		const legacyQuestions = Array.isArray(questions) && questions.length ? questions : null;

		let sql = `UPDATE online_tests 
		           SET test_name = ?, 
		               marks_correct = ?, 
		               marks_wrong = ?, 
		               live_at = ?, 
		               ends_at = ?, 
		               assigned_rolls = ?, 
		               duration_minutes = ?, 
		               max_attempts = ?, 
		               is_strict = ?`;
		const args = [
			String(testName || "Online Test").trim(),
			numOr(marksCorrect, 4),
			numOr(marksWrong, -1),
			Number(liveAt) || Date.now(),
			Number(endsAt) || (Date.now() + 7 * 24 * 60 * 60 * 1000),
			JSON.stringify(Array.isArray(assignedRolls) ? assignedRolls : []),
			Number(durationMinutes) || 90,
			Number(maxAttempts) || 1,
			isStrict ? 1 : 0
		];

		if (keys || legacyQuestions) {
			sql += `, question_keys_json = ?, questions_json = ?, question_count = ?`;
			args.push(
				JSON.stringify(keys || []),
				keys ? "[]" : JSON.stringify(legacyQuestions),
				keys ? keys.length : legacyQuestions.length
			);
		}

		sql += ` WHERE id = ? AND institute_id = ?`;
		args.push(testId, instId);

		const result = await db.execute({ sql, args });
		if (result.rowsAffected === 0) {
			return res.status(404).json({ error: "Test not found or unauthorized" });
		}
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to update online test" });
	}
});

// ── ADMIN: delete an online test ─────────────────────────────────────────────
router.delete("/api/admin/online-tests/:id", requireAdmin, requireFeature("onlineTests"), async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		await db.execute({ sql: "DELETE FROM online_tests WHERE id = ? AND institute_id = ?", args: [Number(req.params.id), instId] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


// ── ADMIN: fetch questions for a specific online test ─────────────────────────
router.get("/api/admin/online-tests/:id/questions", requireAdmin, requireFeature("onlineTests"), async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const testId = Number(req.params.id);
		if (!Number.isFinite(testId)) return res.status(400).json({ error: "Invalid test id" });

		const result = await db.execute({
			sql: "SELECT question_keys_json, questions_json FROM online_tests WHERE id = ? AND institute_id = ? LIMIT 1",
			args: [testId, instId],
		});
		if (!result.rows.length) return res.status(404).json({ error: "Test not found" });

		const r = result.rows[0];
		let keys = [];
		let questions = [];
		try {
			keys = JSON.parse(r.question_keys_json || "[]");
			if (Array.isArray(keys) && keys.length) {
				questions = await resolveQuestionKeys(keys);
			} else {
				questions = JSON.parse(r.questions_json || "[]");
			}
		} catch { questions = []; }

		res.json({ success: true, keys, questions });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to load questions" });
	}
});



// ── Shared student-creation logic ──────────────────────────────────────
// Exported so the owner panel (routes/owner.js) can add students to any
// institute using exactly the same validation and de-duplication rules.
//
// Each input row is { name, className, section, mobile, email }.
// rollNumber is optional — if omitted we mint "R<id>" after insert, because
// attendance / notifications / student_sessions still join on roll_number.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function addStudentsToInstitute(students, instId, now = Date.now()) {
	let added = 0, skipped = 0, invalid = 0;
	const errors = [];

	for (const s of students || []) {
		const name = String(s.name || "").trim();
		const className = String(s.className || s.class_name || "").trim();
		const section = String(s.section || "").trim().toUpperCase();
		const mobile = String(s.mobile || s.phone || "").trim();
		const email = String(s.email || "").trim().toLowerCase();
		const label = name || email || "(blank row)";

		// Mobile is optional: the student logs in with a one-time code sent to
		// their email, so a phone number is only nice-to-have contact detail.
		if (!name || !className || !section || !email) {
			invalid++;
			errors.push({ student: label, reason: "Name, class, section and email are all required" });
			continue;
		}
		if (!EMAIL_RE.test(email)) {
			invalid++;
			errors.push({ student: label, reason: `"${email}" is not a valid email address` });
			continue;
		}
		// Only validate the number when one was actually supplied.
		if (mobile && !/^\d{10}$/.test(mobile)) {
			invalid++;
			errors.push({ student: label, reason: "Mobile number must be exactly 10 digits" });
			continue;
		}

		// The email is the login identity, so it must be unique inside the
		// institute. Checked up front so we can report a friendly reason instead
		// of relying on a unique-index violation.
		const dupe = await db.execute({
			sql: "SELECT id FROM registered_students WHERE institute_id = ? AND lower(email) = ? LIMIT 1",
			args: [instId, email],
		});
		if (dupe.rows.length) {
			skipped++;
			errors.push({ student: label, reason: "This email is already registered in this institute" });
			continue;
		}

		const explicitRoll = String(s.rollNumber || "").trim();
		const provisionalRoll = explicitRoll || `tmp-${now}-${Math.random().toString(36).slice(2, 10)}`;

		try {
			// profile_complete = 1 immediately: the institute supplies every detail,
			// so students never see a profile-setup step. password_hash stays NULL
			// because login is email + one-time code only.
			const ins = await db.execute({
				sql: `INSERT INTO registered_students (roll_number, institute_id, name, class_name, section, phone, email, profile_complete, password_hash, created_at, updated_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
				args: [provisionalRoll, instId, name, className, section, mobile, email, now, now],
			});
			const newId = ins.lastInsertRowid;
			if (!explicitRoll && newId) {
				await db.execute({
					sql: "UPDATE registered_students SET roll_number = ? WHERE id = ?",
					args: [`R${newId}`, newId],
				});
			}
			added++;
		} catch (e) {
			skipped++;
			const msg = String(e && e.message || "");
			errors.push({
				student: label,
				reason: /unique|duplicate/i.test(msg) ? "Already registered in this institute" : (msg || "Could not save this student"),
			});
		}
	}

	return { added, skipped, invalid, errors };
}

// ── ADMIN: add one or multiple students ──────────────────────────────
// The institute enters name, class, section, mobile and email. There are no
// passwords any more — students sign in with an emailed one-time code, so the
// email address IS the login identity and must be unique inside the institute.
// roll_number is still minted automatically because attendance, notifications
// and sessions all join on it.
router.post("/api/admin/registered-students/add", requireAdmin, requireFeature("studentManagement"), async (req, res) => {
	try {
		const { students } = req.body || {};
		if (!Array.isArray(students) || !students.length) {
			return res.status(400).json({ error: "No student records provided" });
		}
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const now = Date.now();
		const outcome = await addStudentsToInstitute(students, instId, now);
		res.json({ success: true, ...outcome });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: list all registered students ─────────────────────────────────────
router.get("/api/admin/registered-students", requireAdmin, requireFeature("studentManagement"), async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		// Explicit column list, not SELECT * — keeps the payload small and stops
		// future wide columns from being shipped to the browser by accident.
		const result = await db.execute({
			sql: `SELECT id, roll_number, name, class_name, section, phone, email, age,
			             date_of_birth, profile_complete, batch_id, created_at, updated_at
			        FROM registered_students
			       WHERE institute_id = ?
			       ORDER BY created_at DESC`,
			args: [instId],
		});
		res.json(result.rows.map(r => ({
			id: r.id,
			rollNumber: r.roll_number,
			name: r.name || "",
			className: r.class_name || "",
			section: r.section || "",
			email: r.email || "",
			phone: r.phone || "",
			age: r.age || "",
			dateOfBirth: r.date_of_birth || "",
			batchId: r.batch_id || null,
			profileComplete: !!r.profile_complete,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		})));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: list all student test history ─────────────────────────────────────
router.get("/api/admin/test-history", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({
			sql: "SELECT id, mobile, chapter, lecture, topic, correct_count, wrong_count, skipped_count, total_questions, marks_score, max_marks, accuracy_pct, time_taken, timestamp, student_name, student_class, online_test_id, is_locked FROM test_history WHERE institute_id = ? ORDER BY timestamp DESC",
			args: [instId],
		});
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to load test history" });
	}
});

// ── ADMIN: get detailed student test attempt ────────────────────────────────
router.get("/api/admin/test-attempt-details/:attemptId", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const attemptId = Number(req.params.attemptId);
		if (!Number.isFinite(attemptId)) return res.status(400).json({ error: "Invalid attempt id" });

		// Fetch test attempt
		const attemptResult = await db.execute({
			sql: "SELECT id, mobile, chapter, lecture, topic, correct_count, wrong_count, skipped_count, total_questions, marks_score, max_marks, accuracy_pct, grade, time_taken, scheme, timestamp, student_name, student_class, answers_json, online_test_id, is_locked, question_order_json FROM test_history WHERE id = ? AND institute_id = ? LIMIT 1",
			args: [attemptId, instId],
		});

		if (!attemptResult.rows.length) {
			return res.status(404).json({ error: "Attempt not found" });
		}

		const attempt = attemptResult.rows[0];

		// Fetch questions
		let questions = [];
		if (attempt.online_test_id) {
			const testResult = await db.execute({
				sql: "SELECT question_keys_json, questions_json FROM online_tests WHERE id = ? AND institute_id = ? LIMIT 1",
				args: [attempt.online_test_id, instId]
			});
			if (testResult.rows.length) {
				const r = testResult.rows[0];
				try {
					const keys = JSON.parse(r.question_keys_json || "[]");
					if (Array.isArray(keys) && keys.length) {
						questions = await resolveQuestionKeys(keys);
					} else {
						questions = JSON.parse(r.questions_json || "[]");
					}
					// Re-order into the sequence this particular student was served, so
					// the stored answer indexes point at the right questions.
					questions = applyQuestionOrder(questions, parseQuestionOrder(attempt.question_order_json));
				} catch (_) { }
			}
		} else {
			// Star quiz / Chapter test
			const result = await db.execute({
				sql: "SELECT questions_json FROM star_quiz_questions WHERE chapter = ? AND lecture = ? LIMIT 1",
				args: [attempt.chapter, attempt.lecture]
			});
			if (result.rows.length) {
				try {
					questions = JSON.parse(result.rows[0].questions_json || "[]");
				} catch (_) { }
			}
		}

		res.json({
			attempt: {
				id: attempt.id,
				mobile: attempt.mobile,
				studentName: attempt.student_name,
				studentClass: attempt.student_class,
				correctCount: attempt.correct_count,
				wrongCount: attempt.wrong_count,
				skippedCount: attempt.skipped_count,
				totalQuestions: attempt.total_questions,
				marksScore: attempt.marks_score,
				maxMarks: attempt.max_marks,
				accuracyPct: attempt.accuracy_pct,
				timeTaken: attempt.time_taken,
				scheme: attempt.scheme,
				timestamp: attempt.timestamp,
				isLocked: attempt.is_locked,
				answers: (() => { try { return JSON.parse(attempt.answers_json || "[]"); } catch { return []; } })()
			},
			questions
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to load attempt details" });
	}
});

// ── ADMIN: delete a registered student by id ────────────────────────────────
/* ── ADMIN: unlock (or re-lock) a student\'s locked test attempt ──────
   is_locked =  1  locked by strict mode, student is blocked
   is_locked = -1  teacher unlocked it, the student may resume
   is_locked =  0  ordinary completed attempt                        */
router.post("/api/admin/test-history/:id/unlock", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const id = Number(req.params.id);
		if (!id) return res.status(400).json({ error: "Attempt id is required" });
		const relock = !!(req.body && req.body.relock);
		const next = relock ? 1 : -1;

		const cur = await db.execute({
			sql: "SELECT id, student_name, mobile, is_locked FROM test_history WHERE id = ? AND institute_id = ? LIMIT 1",
			args: [id, instId],
		});
		if (!cur.rows.length) return res.status(404).json({ error: "Attempt not found" });

		await db.execute({
			sql: "UPDATE test_history SET is_locked = ? WHERE id = ? AND institute_id = ?",
			args: [next, id, instId],
		});

		res.json({
			success: true,
			id,
			isLocked: next,
			studentName: cur.rows[0].student_name || cur.rows[0].mobile || "Student",
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to unlock the attempt" });
	}
});

// ── ADMIN: remove a student ──────────────────────────────────────────────────
// The :id segment may be either the numeric primary key OR the roll number
// (the students list in the portal identifies rows by roll number). Passing a
// roll number like "STU001" through Number() used to produce NaN, which
// Postgres rejected with: invalid input syntax for type bigint: "NaN".
// So branch on the shape of the parameter and match the right column.
router.delete("/api/admin/registered-students/:id", requireAdmin, requireFeature("studentManagement"), async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const raw = String(req.params.id || "").trim();
		if (!raw) return res.status(400).json({ error: "Missing student id" });

		const numericId = /^\d+$/.test(raw) ? Number(raw) : null;
		const result = numericId !== null
			? await db.execute({
				sql: "DELETE FROM registered_students WHERE id = ? AND institute_id = ?",
				args: [numericId, instId],
			})
			: await db.execute({
				sql: "DELETE FROM registered_students WHERE roll_number = ? AND institute_id = ?",
				args: [raw, instId],
			});

		const removed = Number(result?.rowsAffected ?? result?.rowCount ?? 0);
		if (!removed) return res.status(404).json({ error: "Student not found in this institute" });
		res.json({ success: true, removed });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: edit a student's details ──────────────────────────────────────────
// Accepts a numeric id or a roll number, same as DELETE above. Only the fields
// present in the body are written, so a partial edit never blanks the rest.
// Email is the login identity, so it must stay unique within the institute.
router.put("/api/admin/registered-students/:id", requireAdmin, requireFeature("studentManagement"), async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const raw = String(req.params.id || "").trim();
		if (!raw) return res.status(400).json({ error: "Missing student id" });

		const numericId = /^\d+$/.test(raw) ? Number(raw) : null;
		const findSql = numericId !== null
			? "SELECT id, roll_number, email FROM registered_students WHERE id = ? AND institute_id = ? LIMIT 1"
			: "SELECT id, roll_number, email FROM registered_students WHERE roll_number = ? AND institute_id = ? LIMIT 1";
		const found = await db.execute({ sql: findSql, args: [numericId !== null ? numericId : raw, instId] });
		const student = found.rows[0];
		if (!student) return res.status(404).json({ error: "Student not found in this institute" });

		const body = req.body || {};
		const sets = [];
		const args = [];
		const pushIfGiven = (column, value) => { sets.push(`${column} = ?`); args.push(value); };

		if (body.name !== undefined) {
			const name = String(body.name).trim();
			if (!name) return res.status(400).json({ error: "Name cannot be empty" });
			pushIfGiven("name", name);
		}
		if (body.className !== undefined) pushIfGiven("class_name", String(body.className).trim().replace(/\s+/g, " "));
		if (body.section !== undefined) pushIfGiven("section", String(body.section).trim());
		if (body.mobile !== undefined || body.phone !== undefined) {
			const digits = String(body.mobile ?? body.phone).replace(/\D/g, "");
			if (digits && digits.length !== 10) return res.status(400).json({ error: "Mobile number must be 10 digits" });
			pushIfGiven("phone", digits);
		}
		if (body.age !== undefined) pushIfGiven("age", body.age === "" || body.age === null ? null : Number(body.age) || null);
		if (body.dateOfBirth !== undefined) pushIfGiven("date_of_birth", String(body.dateOfBirth || ""));
		if (body.email !== undefined) {
			const email = String(body.email).trim().toLowerCase();
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
				return res.status(400).json({ error: "Please enter a valid email address" });
			}
			if (email !== String(student.email || "").toLowerCase()) {
				const clash = await db.execute({
					sql: "SELECT id FROM registered_students WHERE LOWER(email) = ? AND institute_id = ? AND id <> ? LIMIT 1",
					args: [email, instId, student.id],
				});
				if (clash.rows.length) return res.status(409).json({ error: "Another student already uses this email" });
			}
			pushIfGiven("email", email);
		}

		if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

		sets.push("updated_at = ?");
		args.push(Date.now());
		args.push(student.id, instId);

		await db.execute({
			sql: `UPDATE registered_students SET ${sets.join(", ")} WHERE id = ? AND institute_id = ?`,
			args,
		});

		const after = await db.execute({
			sql: `SELECT id, roll_number, name, class_name, section, phone, email, age,
			             date_of_birth, profile_complete, batch_id, updated_at
			        FROM registered_students WHERE id = ? LIMIT 1`,
			args: [student.id],
		});
		const r = after.rows[0] || {};
		res.json({
			success: true,
			student: {
				id: r.id,
				rollNumber: r.roll_number,
				name: r.name || "",
				className: r.class_name || "",
				section: r.section || "",
				phone: r.phone || "",
				email: r.email || "",
				age: r.age || "",
				dateOfBirth: r.date_of_birth || "",
				batchId: r.batch_id || null,
				profileComplete: !!r.profile_complete,
				updatedAt: r.updated_at,
			},
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to update the student" });
	}
});


// ── ADMIN: list all pending student requests ─────────────────────────────────
router.get("/api/admin/student-requests", requireAdmin, requireFeature("studentManagement"), async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({
			sql: "SELECT * FROM student_requests WHERE institute_id = ? ORDER BY requested_at DESC",
			args: [instId],
		});
		res.json(result.rows.map(r => ({
			id: r.id,
			rollNumber: r.roll_number,
			name: r.name || "",
			className: r.class_name || "",
			phone: r.phone || "",
			age: r.age || "",
			dateOfBirth: r.date_of_birth || "",
			requestedAt: r.requested_at,
		})));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: approve a student request (move to registered_students) ───────────
router.post("/api/admin/student-requests/:id/approve", requireAdmin, requireFeature("studentManagement"), async (req, res) => {
	try {
		const id = Number(req.params.id);
		// Passwords were removed in favour of email OTP login, so approval no
		// longer needs (or accepts) one.
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({ sql: "SELECT * FROM student_requests WHERE id = ? AND institute_id = ?", args: [id, instId] });
		if (!result.rows.length) return res.status(404).json({ error: "Request not found" });
		const r = result.rows[0];
		const now = Date.now();
		// Insert into registered_students with profile already complete, carrying
		// the institute_id forward so the approved student belongs to this institute.
		try {
			await db.execute({
				sql: `INSERT INTO registered_students (roll_number, institute_id, name, class_name, section, phone, email, age, date_of_birth, profile_complete, created_at, updated_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				args: [r.roll_number, instId, r.name, r.class_name, r.section || "", r.phone, (r.email || "").toLowerCase(), r.age, r.date_of_birth, now, now],
			});
		} catch (_) {
			// Already exists — update with profile details
			await db.execute({
				sql: `UPDATE registered_students SET institute_id=?, name=?, class_name=?, section=?, phone=?, email=?, age=?, date_of_birth=?, profile_complete=1, updated_at=? WHERE roll_number=? AND institute_id=?`,
				args: [instId, r.name, r.class_name, r.section || "", r.phone, (r.email || "").toLowerCase(), r.age, r.date_of_birth, now, r.roll_number, instId],
			});
		}
		// Remove from requests
		await db.execute({ sql: "DELETE FROM student_requests WHERE id = ?", args: [id] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: reject a student request (delete from requests) ───────────────────
router.delete("/api/admin/student-requests/:id", requireAdmin, requireFeature("studentManagement"), async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		await db.execute({ sql: "DELETE FROM student_requests WHERE id = ? AND institute_id = ?", args: [Number(req.params.id), instId] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


// ── ADMIN: reset student password ─────────────────────────────────────────
router.post("/api/admin/registered-students/:id/reset-password", requireAdmin, requireFeature("studentManagement"), async (req, res) => {
	try {
		const id = Number(req.params.id);
		const { password } = req.body || {};
		if (!password) return res.status(400).json({ error: "Password is required" });
		if (!helpers.validatePasswordComplexity(password)) {
			return res.status(400).json({ error: "Password does not meet complexity requirements" });
		}
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const passwordHash = helpers.hashPasscode(password);
		await db.execute({
			sql: "UPDATE registered_students SET password_hash = ? WHERE id = ? AND institute_id = ?",
			args: [passwordHash, id, instId],
		});
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to reset password" });
	}
});


// ── Debug: list available Gemini models for the configured API key ──
router.get("/api/admin/gemini-models", requireAdmin, async (req, res) => {
	if (!GEMINI_API_KEY) return res.status(400).json({ error: "GEMINI_API_KEY not set" });
	try {
		const results = {};
		for (const apiVer of ["v1", "v1beta"]) {
			const r = await fetch(
				`https://generativelanguage.googleapis.com/${apiVer}/models?key=${GEMINI_API_KEY}`
			);
			const data = await r.json().catch(() => ({}));
			results[apiVer] = r.ok
				? (data.models || []).map(m => m.name)
				: data?.error?.message || `HTTP ${r.status}`;
		}
		res.json(results);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

// ── ATTENDANCE: Classes ──────────────────────────────────────────────
router.get("/api/admin/classes", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({
			sql: "SELECT * FROM classes WHERE institute_id = ? ORDER BY name",
			args: [instId],
		});
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/classes", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const { name } = req.body || {};
		if (!name || !name.trim()) return res.status(400).json({ error: "Class name required" });
		const result = await db.execute({
			sql: "INSERT INTO classes (name, institute_id, created_at) VALUES (?, ?, ?)",
			args: [name.trim(), instId, Date.now()],
		});
		res.json({ success: true, id: Number(result.lastInsertRowid) });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.delete("/api/admin/classes/:id", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const classId = Number(req.params.id);
		await db.execute({ sql: "DELETE FROM batches WHERE class_id = ? AND institute_id = ?", args: [classId, instId] });
		await db.execute({ sql: "DELETE FROM classes WHERE id = ? AND institute_id = ?", args: [classId, instId] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ATTENDANCE: Batches ──────────────────────────────────────────────
router.get("/api/admin/classes/:id/batches", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const classId = Number(req.params.id);
		const result = await db.execute({
			sql: "SELECT * FROM batches WHERE class_id = ? AND institute_id = ? ORDER BY name",
			args: [classId, instId],
		});
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/classes/:id/batches", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const classId = Number(req.params.id);
		const { name } = req.body || {};
		if (!name || !name.trim()) return res.status(400).json({ error: "Batch name required" });
		const result = await db.execute({
			sql: "INSERT INTO batches (name, class_id, institute_id, created_at) VALUES (?, ?, ?, ?)",
			args: [name.trim(), classId, instId, Date.now()],
		});
		res.json({ success: true, id: Number(result.lastInsertRowid) });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.delete("/api/admin/batches/:id", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		await db.execute({
			sql: "DELETE FROM batches WHERE id = ? AND institute_id = ?",
			args: [Number(req.params.id), instId],
		});
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ATTENDANCE: Students by class/batch ──────────────────────────────
router.get("/api/admin/attendance/students", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const { class_id, batch_id } = req.query;
		let sql = "SELECT roll_number, name, class_name, batch_id FROM registered_students WHERE institute_id = ? AND profile_complete = 1";
		const args = [instId];
		if (class_id) {
			sql += " AND class_name = (SELECT name FROM classes WHERE id = ?)";
			args.push(Number(class_id));
		}
		if (batch_id) {
			sql += " AND batch_id = ?";
			args.push(Number(batch_id));
		}
		sql += " ORDER BY name";
		const result = await db.execute({ sql, args });
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ATTENDANCE: Mark attendance ──────────────────────────────────────
router.post("/api/admin/attendance/mark", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const { class_id, batch_id, date, roll_numbers, status } = req.body || {};
		if (class_id === undefined || class_id === null || !date || !Array.isArray(roll_numbers) || !roll_numbers.length) {
			return res.status(400).json({ error: "class_id, date, and roll_numbers required" });
		}
		const attStatus = status || "present";
		const now = Date.now();
		let marked = 0;
		for (const roll of roll_numbers) {
			await db.execute({
				sql: `INSERT INTO attendance (class_id, batch_id, roll_number, date, status, institute_id, marked_by, marked_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				      ON CONFLICT(roll_number, date) DO UPDATE SET status = ?, marked_at = ?`,
				args: [Number(class_id), batch_id ? Number(batch_id) : null, roll, date, attStatus, instId, "", now, attStatus, now],
			});
			// Create in-app notification for each student
			await db.execute({
				sql: "INSERT INTO notifications (roll_number, message, type, institute_id, created_at) VALUES (?, ?, ?, ?, ?)",
				args: [roll, `Your attendance has been marked as ${attStatus} for ${date}.`, "attendance", instId, now],
			});
			marked++;
		}
		res.json({ success: true, marked });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ATTENDANCE: Get records for a date ───────────────────────────────
router.get("/api/admin/attendance/records", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const { class_id, batch_id, date } = req.query;
		let sql = "SELECT a.*, rs.name as student_name FROM attendance a LEFT JOIN registered_students rs ON a.roll_number = rs.roll_number AND rs.institute_id = ? WHERE a.institute_id = ?";
		const args = [instId, instId];
		if (class_id) {
			sql += " AND a.class_id = ?";
			args.push(Number(class_id));
		}
		if (batch_id) {
			sql += " AND a.batch_id = ?";
			args.push(Number(batch_id));
		}
		if (date) {
			sql += " AND a.date = ?";
			args.push(date);
		}
		sql += " ORDER BY a.roll_number";
		const result = await db.execute({ sql, args });
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ATTENDANCE: Get records for a student (for calendar view) ────────
router.get("/api/admin/attendance/student/:roll", async (req, res) => {
	try {
		const roll = req.params.roll;
		const { month, year } = req.query;
		let sql = "SELECT date, status FROM attendance WHERE roll_number = ?";
		const args = [roll];
		if (month && year) {
			const m = String(month).padStart(2, "0");
			sql += " AND date LIKE ?";
			args.push(`${year}-${m}-%`);
		} else if (year) {
			sql += " AND date LIKE ?";
			args.push(`${year}-%`);
		}
		sql += " ORDER BY date DESC";
		const result = await db.execute({ sql, args });
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ATTENDANCE: All-time summary stats for a student ─────────────────
router.get("/api/admin/attendance/student/:roll/summary", async (req, res) => {
	try {
		const roll = req.params.roll;
		const result = await db.execute({
			sql: "SELECT status, COUNT(*) as count FROM attendance WHERE roll_number = ? GROUP BY status",
			args: [roll],
		});
		let present = 0, absent = 0;
		result.rows.forEach(row => {
			if (row.status === "present") present = Number(row.count);
			else if (row.status === "absent") absent = Number(row.count);
		});
		const total = present + absent;
		const percent = total > 0 ? Math.round((present / total) * 100) : 0;
		res.json({ total, present, absent, percent });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── NOTIFICATIONS: Get unread for a student ──────────────────────────
router.get("/api/admin/notifications/:roll", async (req, res) => {
	try {
		const roll = req.params.roll;
		const result = await db.execute({
			sql: "SELECT * FROM notifications WHERE roll_number = ? AND is_read = 0 ORDER BY created_at DESC LIMIT 50",
			args: [roll],
		});
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/notifications/read", async (req, res) => {
	try {
		const { ids } = req.body || {};
		if (!Array.isArray(ids) || !ids.length) return res.json({ success: true });
		await db.execute({
			sql: `UPDATE notifications SET is_read = 1 WHERE id IN (${ids.map(() => "?").join(",")})`,
			args: ids,
		});
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

module.exports = router;
module.exports.rebuildPapersFromPyq = rebuildPapersFromPyq;
module.exports.addStudentsToInstitute = addStudentsToInstitute;
