const express = require("express");
const router = express.Router();
const { db } = require("../config/db");
const helpers = require("../utils/helpers");
const { rateLimit, resolveStudentInstituteId, sessionInstituteId, getDefaultInstituteId } = require("../middleware/auth");
const { loadQuestions, refreshCache, rebuildYearIndex, findQuestion, resolveQuestionKeys } = require("../utils/questions");
// Redis-backed (with in-process LRU in front) cache for shared, read-heavy data.
const cache = require("../config/cache");
const {
	isCorrect, normalizeQuestionRow,
	// Per-student question shuffle + analysis ordering (see utils/helpers.js)
	questionOrderForStudent, applyQuestionOrder, isValidQuestionOrder, parseQuestionOrder,
} = helpers;
const crypto = require("crypto");
const { sendOtpEmail, activeProvider } = require("../utils/mailer");
// Per-institute feature flags (set from the developer panel). An institute that
// only bought the offline question library has onlineTests / studentManagement
// switched off, so the student portal must refuse those routes too — not just
// hide the buttons.
const { getInstitutePermissions, hasFeature } = require("../utils/permissions");

/**
 * Is `feature` enabled for this student's institute?
 * Unknown institute ⇒ allowed (keeps legacy/no-institute flows working).
 */
async function studentFeatureAllowed(instituteId, feature) {
	if (!instituteId) return true;
	try {
		const perms = await getInstitutePermissions(instituteId);
		return hasFeature(perms, feature);
	} catch (_) {
		return true;
	}
}

function featureBlocked(res, message) {
	return res.status(403).json({ error: message, blocked: true });
}

/* ══════════════════════════════════════════════════════════════════════════
   WHEN MAY A STUDENT SEE THE FULL QUESTION-BY-QUESTION ANALYSIS?

   An institute test is a shared exam window. A student who finishes early (or
   whose attempt got locked by strict mode) must NOT be able to see the correct
   answers and solutions while classmates are still writing the paper —
   otherwise the answer key leaks within minutes.

   Rule:
     • before online_tests.ends_at  → score only (marks, accuracy, counts)
     • from  online_tests.ends_at   → full analysis for EVERYONE, including
                                      students whose attempt is locked
     • self-practice / star-quiz tests (no online_test_id) → always available
══════════════════════════════════════════════════════════════════════════ */
function computeAnalysisGate(onlineTestId, endsAt, isLocked, now = Date.now()) {
	const testId = Number(onlineTestId);
	if (!Number.isFinite(testId) || testId <= 0) {
		return { analysisAvailable: true, analysisAvailableAt: null, analysisLockedReason: null };
	}
	const end = Number(endsAt) || 0;
	const locked = Number(isLocked) || 0;
	// Test window is over → everybody gets their analysis.
	if (end && now >= end) {
		return { analysisAvailable: true, analysisAvailableAt: end, analysisLockedReason: null };
	}
	// Legacy rows whose test has been deleted: nothing to protect any more.
	if (!end && locked === 0) {
		return { analysisAvailable: true, analysisAvailableAt: null, analysisLockedReason: null };
	}
	return {
		analysisAvailable: false,
		analysisAvailableAt: end || null,
		// The student sees a different message for a locked attempt.
		analysisLockedReason: locked !== 0 ? "attempt_locked" : "test_in_progress",
	};
}

/**
 * Strip everything that would reveal the paper, keeping the score intact.
 * Mutates and returns the attempt payload.
 */
function hideAttemptAnalysis(payload, gate) {
	payload.questions = [];
	payload.answers = [];
	payload.timeSpentJson = [];
	payload.analysisAvailable = false;
	payload.analysisAvailableAt = gate.analysisAvailableAt;
	payload.analysisLockedReason = gate.analysisLockedReason;
	return payload;
}
function genToken() {
    return crypto.randomBytes(32).toString("hex");
}

router.post("/api/check-attempt", async (req, res) => {
	try {
		const { mobile, chapter, lecture } = req.body || {};
		if (!mobile || !lecture) return res.status(400).json({ error: "Missing" });

		// Use star_quiz_questions as the student portal source
		const sqRow = await db.execute({ sql: "SELECT updated_at FROM star_quiz_questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
		if (!sqRow.rows.length) return res.json({ allowed: false, time: 0 });
		const q = { updatedAt: sqRow.rows[0].updated_at || 0 };

		const result = await db.execute({
			sql: "SELECT time FROM attempts WHERE mobile = ? AND lecture = ? ORDER BY time DESC LIMIT 1",
			args: [mobile, lecture],
		});

		if (!result.rows.length) return res.json({ allowed: true, time: 0 });

		const lastTime = result.rows[0].time || 0;
		if (lastTime >= (q.updatedAt || 0)) return res.json({ allowed: false, time: lastTime });
		return res.json({ allowed: true, time: lastTime });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/student-register", async (req, res) => {
	try {
		const { name, mobile, place, className, chapter, lecture, instituteCode } = req.body || {};
		if (!name || !mobile || !lecture) return res.status(400).json({ error: "Missing" });

		const instId = await resolveStudentInstituteId({ mobile, instituteCode });
		await db.execute({
			sql: `INSERT INTO students (mobile, lecture, name, place, class_name, chapter, time, institute_id)
				  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				  ON CONFLICT(mobile, lecture) DO UPDATE SET
					name=excluded.name, place=excluded.place, class_name=excluded.class_name,
					chapter=excluded.chapter, time=excluded.time, institute_id=excluded.institute_id`,
			args: [mobile, lecture, name, place || "", className || "", chapter || null, Date.now(), instId],
		});

		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/submit-attempt", rateLimit(60 * 1000, 5), async (req, res) => {
	try {
		const { mobile, chapter, lecture, selectedAnswers, askedQuestionIndexes, name, place, className, cheatFlag } = req.body || {};
		if (!mobile || !lecture) return res.status(400).json({ error: "Missing" });

		// Use star_quiz_questions as the student portal source
		const sqRow = await db.execute({ sql: "SELECT * FROM star_quiz_questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
		if (!sqRow.rows.length) return res.status(404).json({ error: "Not found" });
		const q = normalizeQuestionRow(sqRow.rows[0]);

		const lastResult = await db.execute({
			sql: "SELECT time FROM attempts WHERE mobile = ? AND lecture = ? ORDER BY time DESC LIMIT 1",
			args: [mobile, lecture],
		});
		if (lastResult.rows.length && (lastResult.rows[0].time || 0) >= (q.updatedAt || 0)) {
			return res.json({ allowed: false });
		}

		const validSourceIndexes = Array.isArray(askedQuestionIndexes)
			? askedQuestionIndexes
				.map((idx) => Number(idx))
				.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < q.questions.length)
			: [];

		const questionsForScoring = validSourceIndexes.length
			? validSourceIndexes.map((idx) => q.questions[idx]).filter(Boolean)
			: q.questions;

		const answers = Array.isArray(selectedAnswers) ? selectedAnswers : [];
		let correctCount = 0;
		answers.forEach((ans, i) => {
			if (isCorrect(questionsForScoring[i], ans)) correctCount++;
		});

		const now = Date.now();
		const instId = await resolveStudentInstituteId({ mobile, instituteCode: req.body?.instituteCode });
		await db.execute({
			sql: "INSERT INTO attempts (mobile, chapter, lecture, time, institute_id) VALUES (?, ?, ?, ?, ?)",
			args: [mobile, chapter || null, lecture, now, instId],
		});

		await db.execute({
			sql: `INSERT INTO students (mobile, lecture, name, place, class_name, chapter, answers_json, correct_count, total_questions, time, cheat_flag, institute_id)
				  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				  ON CONFLICT(mobile, lecture) DO UPDATE SET
					name=excluded.name, place=excluded.place, class_name=excluded.class_name,
					chapter=excluded.chapter, answers_json=excluded.answers_json,
					correct_count=excluded.correct_count, total_questions=excluded.total_questions, time=excluded.time,
					institute_id=excluded.institute_id,
					cheat_flag=MAX(students.cheat_flag, excluded.cheat_flag)`,
			args: [
				mobile,
				lecture,
				name || "",
				place || "",
				className || "",
				chapter || null,
				JSON.stringify(answers),
				correctCount,
				questionsForScoring.length,
				now,
				cheatFlag ? 1 : 0,
				instId,
			],
		});

		res.json({ success: true, correctCount, totalQuestions: questionsForScoring.length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Save test result to database
router.post("/api/save-test-result", async (req, res) => {
	try {
		const {
			mobile,
			chapter,
			lecture,
			topic,
			correct,
			wrong,
			skipped,
			total,
			marksScore,
			maxMarks,
			pct,
			grade,
			timeTaken,
			scheme,
			studentName,
			studentClass,
			answers,
			online_test_id,
			is_locked,
			timeSpentJson,   // NEW: array of seconds per question, e.g. [12, 45, 8, …]
			questionOrder,   // NEW: the shuffled order this student actually saw
		} = req.body || {};

		const compactAnswers = Array.isArray(answers)
			? answers.map((item, index) => {
				let sourceIdx = index;
				let answerValue = null;
				let statusRaw = "";

				if (Array.isArray(item)) {
					// Preferred compact format from frontend: [idx, answer, statusChar]
					sourceIdx = Number.isFinite(Number(item[0])) ? Number(item[0]) : index;
					answerValue = item[1] ?? null;
					statusRaw = item[2] ?? "";
				} else if (item && typeof item === "object") {
					// Object format compatibility: { idx, studentAnswer, status }
					sourceIdx = Number.isFinite(Number(item.idx)) ? Number(item.idx) : index;
					answerValue = item.studentAnswer ?? item.a ?? item.answer ?? null;
					statusRaw = item.status ?? item.s ?? "";
				} else if (item !== null && item !== undefined) {
					// Primitive compatibility: [0,1,-1,...]
					answerValue = item;
				}

				const compactAnswer = Array.isArray(answerValue)
					? answerValue.join(",")
					: answerValue === null || answerValue === undefined || String(answerValue).trim() === ""
						? ""
						: String(answerValue);

				let statusValue = String(statusRaw || "").charAt(0).toLowerCase();
				if (!["c", "w", "s"].includes(statusValue)) {
					const low = compactAnswer.trim().toLowerCase();
					statusValue = (low === "" || low === "-1" || low === "null" || low === "undefined") ? "s" : "a";
				}

				return [sourceIdx, compactAnswer, statusValue];
			})
			: [];

		if (!mobile) {
			return res.status(400).json({ error: "Missing mobile" });
		}

		const timestamp = Date.now();
		// If marksScore missing or null, compute from scheme and correct/wrong
		let computedMarks = Number(marksScore);
		if (!Number.isFinite(computedMarks)) computedMarks = null;
		const schemeStr = String(scheme || '+1/0');
		if (computedMarks === null) {
			// parse scheme like '+4/-1' or '+1/0'
			let pos = 1, neg = 0;
			try {
				const m = schemeStr.match(/([+-]?\d+)\/?([+-]?\d+)?/);
				if (m) {
					pos = Number(m[1]) || 1;
					// negative penalty may be represented as -1 or 0
					neg = Number(m[2]) || 0;
				}
			} catch (_) { pos = 1; neg = 0; }
			computedMarks = (Number(correct) || 0) * pos - (Number(wrong) || 0) * Math.abs(neg);
		}

		// Parse online_test_id if provided — null means not an online test, 0 is NOT a valid ID
		const testId = (online_test_id !== null && online_test_id !== undefined && online_test_id !== '' && Number.isFinite(Number(online_test_id)) && Number(online_test_id) > 0)
			? Number(online_test_id)
			: null;

		const instId = await resolveStudentInstituteId({ mobile, instituteCode: req.body?.instituteCode });

		// Compact & validate timeSpentJson (array of non-negative integers)
		const compactTimeSpent = Array.isArray(timeSpentJson)
			? timeSpentJson.map((t) => Math.max(0, Math.round(Number(t) || 0)))
			: [];

		// The per-student question order is stored with the attempt. Without it the
		// analysis screen would line answer #1 up against the test's original
		// question #1 instead of the one this student actually saw first.
		const compactOrder = Array.isArray(questionOrder)
			? questionOrder.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0)
			: [];

		await db.execute({
			sql: `INSERT INTO test_history (
				mobile, chapter, lecture, topic, correct_count, wrong_count, skipped_count,
				total_questions, marks_score, max_marks, accuracy_pct, grade, time_taken,
				scheme, timestamp, student_name, student_class, answers_json, online_test_id,
				is_locked, institute_id, time_spent_json, question_order_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				mobile,
				chapter || null,
				lecture,
				topic || "",
				correct || 0,
				wrong || 0,
				skipped || 0,
				total || 0,
				computedMarks || 0,
				(total || 0) * (Number(schemeStr.match(/([+-]?\d+)/)?.[1]) || 1),
				pct || 0,
				grade || "",
				timeTaken || 0,
				schemeStr || "+1/0",
				timestamp,
				studentName || "",
				studentClass || "",
				JSON.stringify(compactAnswers),
				testId,
				Number(is_locked) || 0,
				instId,
				JSON.stringify(compactTimeSpent),
				JSON.stringify(compactOrder),
			]
		});

		// Update aggregated student stats: tests_completed, avg_pct, day_streak
		try {
			// Count DISTINCT tests, not attempt rows. When a teacher unlocks a
			// strict-mode attempt the student resumes and submits again, which adds
			// another test_history row - that is what made 3 real tests report as 7.
			// Rows still locked (1) or unlocked-but-unfinished (-1) are not completed.
			const attemptRows = await db.execute({
				sql: `SELECT online_test_id, chapter, lecture, accuracy_pct, timestamp, is_locked
				      FROM test_history WHERE mobile = ?`,
				args: [mobile]
			});
			const latestByTest = new Map();
			for (const r of attemptRows.rows) {
				if ((Number(r.is_locked) || 0) !== 0) continue;
				const otId = Number(r.online_test_id);
				const key = Number.isFinite(otId) && otId > 0
					? `ot_${otId}`
					: `sq_${String(r.chapter || "")}|${String(r.lecture || "")}`;
				const prev = latestByTest.get(key);
				if (!prev || Number(r.timestamp) > Number(prev.timestamp)) latestByTest.set(key, r);
			}
			const uniqueTests = [...latestByTest.values()];
			const cnt = uniqueTests.length;
			const avgpct = cnt
				? Math.round(uniqueTests.reduce((sum, r) => sum + (Number(r.accuracy_pct) || 0), 0) / cnt)
				: 0;

			// Streak counts the days those distinct tests were completed on.
			const dates = [...new Set(uniqueTests.map(r => {
				const d = new Date(Number(r.timestamp));
				return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
			}).filter(Boolean))].sort().reverse();
			let streak = 0;
			if (dates.length) {
				const today = new Date(dates[0] + 'T00:00:00');
				let cur = new Date(today);
				for (let i = 0; i < dates.length; i++) {
					const d = new Date(dates[i] + 'T00:00:00');
					if (Math.abs((cur - d) / (24 * 3600 * 1000)) <= 0.1) {
						streak++;
						cur.setDate(cur.getDate() - 1);
					} else break;
				}
			}

			await db.execute({
				sql: `INSERT INTO student_stats (mobile, tests_completed, avg_pct, day_streak, last_test, updated_at)
					  VALUES (?, ?, ?, ?, ?, ?)
					  ON CONFLICT(mobile) DO UPDATE SET
						tests_completed = excluded.tests_completed,
						avg_pct = excluded.avg_pct,
						day_streak = excluded.day_streak,
						last_test = excluded.last_test,
						updated_at = excluded.updated_at`,
				args: [mobile, cnt, avgpct, streak, timestamp, Date.now()]
			});
		} catch (e) {
			console.warn('Failed to update student_stats:', e.message || e);
		}

		res.json({ success: true, timestamp });
	} catch (e) {
		console.error("Save test result error:", e);
		res.status(500).json({ error: e.message || "Failed to save test result" });
	}
});

// Fetch test history for a student
router.get("/api/test-history/:mobile", async (req, res) => {
	try {
		const { mobile } = req.params || {};
		if (!mobile) {
			return res.status(400).json({ error: "Missing mobile" });
		}

		// Pagination support: ?page=1&limit=7  (defaults: page=1, limit=100 for backwards compat)
		const page = Math.max(1, parseInt(req.query.page || "1", 10));
		const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "100", 10)));
		const offset = (page - 1) * limit;

		// "light" mode: the Test Analysis LIST only needs scores/dates, never the
		// full question bank. Resolving questions for every attempt was the main
		// reason that screen took many seconds to appear.
		const lightRaw = String(req.query.light ?? "");
		const light = lightRaw === "1" || lightRaw.toLowerCase() === "true";

		// Also return total count so the client knows when to stop.
		// Only needed on the first page - skip the extra round-trip afterwards.
		let totalCount = Number(req.query.total || 0);
		if (page === 1 || !Number.isFinite(totalCount) || totalCount <= 0) {
			const countResult = await db.execute({
				sql: "SELECT COUNT(*) as cnt FROM test_history WHERE mobile = ?",
				args: [mobile]
			});
			totalCount = Number(countResult.rows[0]?.cnt || 0);
		}

		// In light mode avoid pulling the very large JSON blob columns
		// (answers_json / time_spent_json) over the wire at all.
		const LIGHT_COLUMNS = "id, timestamp, student_name, student_class, chapter, lecture, topic, "
			+ "correct_count, wrong_count, skipped_count, total_questions, marks_score, max_marks, "
			+ "accuracy_pct, grade, time_taken, scheme, online_test_id, is_locked";
		const result = await db.execute({
			sql: `SELECT ${light ? LIGHT_COLUMNS : "*"} FROM test_history WHERE mobile = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
			args: [mobile, limit, offset]
		});

		const history = result.rows.map(row => {
			let questions = [];

			// If this test was an online test, fetch questions from online_tests table
			if (row.online_test_id && Number.isFinite(Number(row.online_test_id))) {
				// Fetch from online_tests table (sync approach - we'll handle this with Promise.all below)
				// For now, mark that we need to fetch it
				questions = []; // Will be populated below
			}

			return {
				id: row.id,
				timestamp: row.timestamp,
				student: {
					name: row.student_name,
					roll: mobile,
					class: row.student_class
				},
				test: {
					chapter: row.chapter || "",
					lecture: row.lecture,
					topic: row.topic || ""
				},
				result: {
					correct: row.correct_count,
					wrong: row.wrong_count,
					skipped: row.skipped_count,
					total: row.total_questions,
					marksScore: row.marks_score,
					maxMarks: row.max_marks,
					pct: row.accuracy_pct,
					grade: row.grade,
					timeTaken: row.time_taken
				},
				scheme: row.scheme,
				online_test_id: row.online_test_id,
				is_locked: row.is_locked,
				// The order this student saw the paper in (empty = original order).
				questionOrder: parseQuestionOrder(row.question_order_json),
				timeSpentJson: (() => { try { return JSON.parse(row.time_spent_json || "[]"); } catch { return []; } })(),
				questions: questions,
				answers: (() => {
					try {
						const parsed = JSON.parse(row.answers_json || "[]");
						return Array.isArray(parsed)
							? parsed.map((item, idx) => {
								if (Array.isArray(item)) {
									const [qIndex, studentAnswer, status] = item;
									return {
										idx: Number.isFinite(Number(qIndex)) ? Number(qIndex) : idx,
										studentAnswer: studentAnswer === "" ? null : String(studentAnswer),
										status: status || "s"
									};
								}
								if (item !== null && item !== undefined && typeof item !== "object") {
									const raw = String(item).trim();
									const skipped = raw === "" || raw === "-1" || raw.toLowerCase() === "null" || raw.toLowerCase() === "undefined";
									return {
										idx,
										studentAnswer: skipped ? null : raw,
										status: skipped ? "s" : "a"
									};
								}
								return {
									idx: Number.isFinite(Number(item?.idx)) ? Number(item.idx) : idx,
									studentAnswer: item?.studentAnswer ?? item?.answer ?? item?.a ?? null,
									status: (() => {
										const explicit = item?.status || item?.s;
										if (explicit) return explicit;
										const ans = item?.studentAnswer ?? item?.answer ?? item?.a;
										if (ans === null || ans === undefined) return "s";
										const raw = String(ans).trim().toLowerCase();
										return raw === "" || raw === "-1" || raw === "null" || raw === "undefined" ? "s" : "a";
									})()
								};
							})
							: [];
					} catch { return []; }
				})(),
				_raw_row: row // Keep raw row for processing below
			};
		});

		// Light mode stops here: no online_tests lookup, no resolveQuestionKeys.
		if (light) {
			const lightList = history.map(item => {
				delete item._raw_row;
				delete item.questions;
				delete item.answers;
				delete item.timeSpentJson;
				item.light = true;
				return item;
			});
			return res.json({
				data: lightList,
				page,
				limit,
				total: totalCount,
				hasMore: offset + lightList.length < totalCount,
				light: true
			});
		}

		// Fetch questions for online tests — ONE batch query for all unique test IDs
		// (prevents N parallel DB connections that exceed Supabase session-mode pool_size:15)
		const uniqueTestIds = [...new Set(
			history.map(h => h.online_test_id).filter(id => id && Number.isFinite(Number(id)))
		)].map(Number);

		const testQuestionsCache = new Map(); // id → { question_keys_json, questions_json }
		if (uniqueTestIds.length) {
			try {
				const placeholders = uniqueTestIds.map(() => "?").join(", ");
				const batchResult = await db.execute({
					// ends_at decides whether the detailed analysis may be shown yet.
				sql: `SELECT id, question_keys_json, questions_json, ends_at FROM online_tests WHERE id IN (${placeholders})`,
					args: uniqueTestIds
				});
				for (const r of batchResult.rows) {
					testQuestionsCache.set(Number(r.id), r);
				}
			} catch (e) {
				console.warn("Batch fetch online_tests failed:", e.message);
			}
		}

		// Resolve question keys sequentially (avoids parallel resolveQuestionKeys DB calls)
		const historyWithQuestions = [];
		const resolvedCache = new Map();
		for (const item of history) {
			if (item.online_test_id && Number.isFinite(Number(item.online_test_id))) {
				const testId = Number(item.online_test_id);
				if (resolvedCache.has(testId)) {
					const cached = resolvedCache.get(testId);
					if (cached) item.questions = cached;
				} else {
					const testRow = testQuestionsCache.get(testId);
					if (testRow) {
						try {
							const keys = JSON.parse(testRow.question_keys_json || "[]");
							if (Array.isArray(keys) && keys.length) {
								const resolved = await resolveQuestionKeys(keys);
								if (resolved.length) {
									item.questions = resolved;
									resolvedCache.set(testId, resolved);
								}
							} else {
								const storedQs = JSON.parse(testRow.questions_json || "[]");
								if (Array.isArray(storedQs) && storedQs.length) {
									item.questions = storedQs.map(q => ({
										...q,
										question: q.question || "",
										options: Array.isArray(q.options) ? q.options : [],
										correctIndexes: Array.isArray(q.correctIndexes) ? q.correctIndexes : (typeof q.correctIndex === "number" ? [q.correctIndex] : [0]),
										solution: q.solution || q.explanation || q.sol || "",
										subject: q.subject || "",
										questionImage: q.questionImage || q.image || q.qImage || null,
										optionImages: q.optionImages || q.optImgs || null
									}));
									resolvedCache.set(testId, item.questions);
								}
							}
						} catch { /* ignore parse errors */ }
					}
					if (!resolvedCache.has(testId)) resolvedCache.set(testId, null);
				}
			}
			delete item._raw_row;
			historyWithQuestions.push(item);
		}

		// ── Re-order to what the student saw + gate the detailed analysis ─────
		const nowTs = Date.now();
		for (const item of historyWithQuestions) {
			const testRow = testQuestionsCache.get(Number(item.online_test_id));
			const gate = computeAnalysisGate(item.online_test_id, testRow?.ends_at, item.is_locked, nowTs);
			if (!gate.analysisAvailable) {
				hideAttemptAnalysis(item, gate);
				delete item.questionOrder;
				continue;
			}
			item.questions = applyQuestionOrder(item.questions, item.questionOrder);
			item.analysisAvailable = true;
			item.analysisAvailableAt = gate.analysisAvailableAt;
			item.analysisLockedReason = null;
			delete item.questionOrder;
		}

		// If paginated request (?page= or ?limit= provided), return wrapper object
		// Otherwise fall back to plain array for backward compatibility
		if (req.query.page || req.query.limit) {
			return res.json({
				data: historyWithQuestions,
				page,
				limit,
				total: totalCount,
				hasMore: offset + historyWithQuestions.length < totalCount
			});
		}
		return res.json(historyWithQuestions);
	} catch (e) {
		console.error("GET /api/test-history/:mobile error:", e.message);
		return res.status(500).json({ error: e.message });
	}
});

// ── STUDENT: one single attempt, WITH its resolved questions ────────────────
// The Test Analysis list is loaded in "light" mode (no questions) so it paints
// instantly. When the student actually opens one attempt, the heavy question
// data for THAT attempt only is fetched here.
router.get("/api/test-history/:mobile/attempt/:id", async (req, res) => {
	try {
		const { mobile, id } = req.params || {};
		if (!mobile || !id) return res.status(400).json({ error: "Missing mobile or id" });

		const result = await db.execute({
			sql: "SELECT * FROM test_history WHERE id = ? AND mobile = ? LIMIT 1",
			args: [id, mobile]
		});
		const row = result.rows[0];
		if (!row) return res.status(404).json({ error: "Attempt not found" });

		// Same answers normalisation as the list endpoint
		let answers = [];
		try {
			const parsed = JSON.parse(row.answers_json || "[]");
			if (Array.isArray(parsed)) {
				answers = parsed.map((item, idx) => {
					if (Array.isArray(item)) {
						const [qIndex, studentAnswer, status] = item;
						return {
							idx: Number.isFinite(Number(qIndex)) ? Number(qIndex) : idx,
							studentAnswer: studentAnswer === "" ? null : String(studentAnswer),
							status: status || "s"
						};
					}
					if (item !== null && item !== undefined && typeof item !== "object") {
						const raw = String(item).trim();
						const skipped = raw === "" || raw === "-1" || raw.toLowerCase() === "null" || raw.toLowerCase() === "undefined";
						return { idx, studentAnswer: skipped ? null : raw, status: skipped ? "s" : "a" };
					}
					const ans = item?.studentAnswer ?? item?.answer ?? item?.a ?? null;
					let status = item?.status || item?.s;
					if (!status) {
						const raw = String(ans ?? "").trim().toLowerCase();
						status = (raw === "" || raw === "-1" || raw === "null" || raw === "undefined") ? "s" : "a";
					}
					return {
						idx: Number.isFinite(Number(item?.idx)) ? Number(item.idx) : idx,
						studentAnswer: ans,
						status
					};
				});
			}
		} catch { answers = []; }

		// Resolve questions for online tests (single test id → at most one lookup)
		let questions = [];
		let testEndsAt = 0;
		if (row.online_test_id && Number.isFinite(Number(row.online_test_id))) {
			try {
				const testRes = await db.execute({
					sql: "SELECT id, question_keys_json, questions_json, ends_at FROM online_tests WHERE id = ? LIMIT 1",
					args: [Number(row.online_test_id)]
				});
				const testRow = testRes.rows[0];
				if (testRow) {
					testEndsAt = Number(testRow.ends_at) || 0;
					const keys = JSON.parse(testRow.question_keys_json || "[]");
					if (Array.isArray(keys) && keys.length) {
						const resolved = await resolveQuestionKeys(keys);
						if (resolved.length) questions = resolved;
					}
					if (!questions.length) {
						const storedQs = JSON.parse(testRow.questions_json || "[]");
						if (Array.isArray(storedQs) && storedQs.length) {
							questions = storedQs.map(q => ({
								...q,
								question: q.question || "",
								options: Array.isArray(q.options) ? q.options : [],
								correctIndexes: Array.isArray(q.correctIndexes) ? q.correctIndexes : (typeof q.correctIndex === "number" ? [q.correctIndex] : [0]),
								solution: q.solution || q.explanation || q.sol || "",
								subject: q.subject || "",
								questionImage: q.questionImage || q.image || q.qImage || null,
								optionImages: q.optionImages || q.optImgs || null
							}));
						}
					}
				}
			} catch (e) {
				console.warn("attempt question resolve failed:", e.message);
			}
		}

		let timeSpentJson = [];
		try { timeSpentJson = JSON.parse(row.time_spent_json || "[]"); } catch { timeSpentJson = []; }

		// ── Analysis gate ────────────────────────────────────────────────────
		// Score is always returned; the paper, the student's answers and the
		// per-question timings are withheld until the test window closes.
		const gate = computeAnalysisGate(row.online_test_id, testEndsAt, row.is_locked);
		if (!gate.analysisAvailable) {
			return res.json(hideAttemptAnalysis({
				id: row.id,
				timestamp: row.timestamp,
				student: { name: row.student_name, roll: mobile, class: row.student_class },
				test: { chapter: row.chapter || "", lecture: row.lecture, topic: row.topic || "" },
				result: {
					correct: row.correct_count,
					wrong: row.wrong_count,
					skipped: row.skipped_count,
					total: row.total_questions,
					marksScore: row.marks_score,
					maxMarks: row.max_marks,
					pct: row.accuracy_pct,
					grade: row.grade,
					timeTaken: row.time_taken
				},
				scheme: row.scheme,
				online_test_id: row.online_test_id,
				is_locked: row.is_locked,
			}, gate));
		}

		return res.json({
			id: row.id,
			timestamp: row.timestamp,
			student: { name: row.student_name, roll: mobile, class: row.student_class },
			test: { chapter: row.chapter || "", lecture: row.lecture, topic: row.topic || "" },
			result: {
				correct: row.correct_count,
				wrong: row.wrong_count,
				skipped: row.skipped_count,
				total: row.total_questions,
				marksScore: row.marks_score,
				maxMarks: row.max_marks,
				pct: row.accuracy_pct,
				grade: row.grade,
				timeTaken: row.time_taken
			},
			scheme: row.scheme,
			online_test_id: row.online_test_id,
			is_locked: row.is_locked,
			timeSpentJson,
			// Shown in the order this student actually attempted them.
			questions: applyQuestionOrder(questions, parseQuestionOrder(row.question_order_json)),
			answers,
			analysisAvailable: true,
			analysisAvailableAt: gate.analysisAvailableAt,
			analysisLockedReason: null,
		});
	} catch (e) {
		console.error("GET /api/test-history/:mobile/attempt/:id error:", e.message);
		return res.status(500).json({ error: e.message });
	}
});

// ── STUDENT: get aggregated stats (tests_completed, avg_pct, day_streak) ────
// ── Read dashboard stats ────────────────────────────────────────────────────────────
// This recomputes from test_history instead of trusting the stored
// student_stats row. The stored value was written by older code that counted
// every test_history row, so unlocking a test (which adds a resumed attempt)
// inflated the count — 3 real tests could read as 7. Recomputing here means the
// number is correct immediately rather than only after the next submission, and
// the stale row is repaired in passing.
router.get("/api/student/stats/:mobile", async (req, res) => {
	try {
		const { mobile } = req.params;
		if (!mobile) return res.status(400).json({ error: "Missing mobile" });

		const hist = await db.execute({
			sql: "SELECT online_test_id, chapter, lecture, accuracy_pct, timestamp, is_locked FROM test_history WHERE mobile = ?",
			args: [mobile],
		});

		// Keep only finished attempts: is_locked 1 = locked by strict mode,
		// -1 = teacher unlocked and resumable. Neither is a completed test.
		const latestByTest = new Map();
		for (const r of hist.rows) {
			if ((Number(r.is_locked) || 0) !== 0) continue;
			const otId = Number(r.online_test_id);
			const key = Number.isFinite(otId) && otId > 0
				? `ot_${otId}`
				: `sq_${r.chapter || ""}|${r.lecture || ""}`;
			const prev = latestByTest.get(key);
			if (!prev || (Number(r.timestamp) || 0) > (Number(prev.timestamp) || 0)) {
				latestByTest.set(key, r);
			}
		}
		const uniqueTests = [...latestByTest.values()];

		if (!uniqueTests.length) {
			return res.json({ tests_completed: 0, avg_pct: null, day_streak: 0, last_test: null });
		}

		const cnt = uniqueTests.length;
		const avgpct = Math.round(
			uniqueTests.reduce((sum, r) => sum + (Number(r.accuracy_pct) || 0), 0) / cnt
		);
		const lastTest = uniqueTests.reduce(
			(mx, r) => Math.max(mx, Number(r.timestamp) || 0), 0
		);

		// Day streak: consecutive days ending today (or yesterday) that have a test
		const dates = [...new Set(
			uniqueTests.map(r => new Date(Number(r.timestamp) || 0).toISOString().slice(0, 10))
		)].sort().reverse();
		let streak = 0;
		if (dates.length) {
			const DAY = 86400000;
			const today = new Date().toISOString().slice(0, 10);
			const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
			if (dates[0] === today || dates[0] === yesterday) {
				streak = 1;
				let cursor = new Date(dates[0] + "T00:00:00Z").getTime();
				for (let i = 1; i < dates.length; i++) {
					const expected = new Date(cursor - DAY).toISOString().slice(0, 10);
					if (dates[i] === expected) { streak++; cursor -= DAY; }
					else break;
				}
			}
		}

		// Repair the stored row so anything else reading it agrees.
		try {
			await db.execute({
				sql: `INSERT INTO student_stats (mobile, tests_completed, avg_pct, day_streak, last_test, updated_at)
				      VALUES (?, ?, ?, ?, ?, ?)
				      ON CONFLICT(mobile) DO UPDATE SET
				        tests_completed = excluded.tests_completed,
				        avg_pct = excluded.avg_pct,
				        day_streak = excluded.day_streak,
				        last_test = excluded.last_test,
				        updated_at = excluded.updated_at`,
				args: [mobile, cnt, avgpct, streak, lastTest, Date.now()],
			});
		} catch (e) {
			console.error("Failed to refresh student_stats:", e.message);
		}

		res.json({
			tests_completed: cnt,
			avg_pct: avgpct,
			day_streak: streak,
			last_test: lastTest || null,
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── PUBLIC: Get leaderboard stats for a test (topper + avg marks) ────────────
router.get('/api/test-leaderboard', async (req, res) => {
	try {
		const { chapter, lecture, online_test_id } = req.query;
		let rows;
		if (online_test_id && Number.isFinite(Number(online_test_id))) {
			rows = await db.execute({
				sql: 'SELECT marks_score, accuracy_pct FROM test_history WHERE online_test_id = ?',
				args: [Number(online_test_id)]
			});
		} else if (lecture) {
			rows = await db.execute({
				sql: 'SELECT marks_score, accuracy_pct FROM test_history WHERE chapter = ? AND lecture = ?',
				args: [chapter || null, String(lecture)]
			});
		} else {
			return res.status(400).json({ error: 'chapter+lecture or online_test_id required' });
		}
		if (!rows.rows.length) return res.json({ topper: null, avg: null, attempts: 0 });
		const scores = rows.rows.map(r => Number(r.marks_score) || 0);
		const topper = Math.max(...scores);
		const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
		const avgAcc = Math.round(rows.rows.reduce((s, r) => s + (Number(r.accuracy_pct) || 0), 0) / rows.rows.length);
		res.json({ topper, avg, avgAcc, attempts: rows.rows.length });
	} catch (e) {
		res.status(500).json({ error: e.message || 'Failed' });
	}
});


// Extract the year from the first question that has one
function extractYearFromQuestions(questions) {
	if (!Array.isArray(questions)) return null;
	for (const q of questions) {
		if (q?.year && String(q.year).trim()) return String(q.year).trim();
	}
	return null;
}


// ── PUBLIC STAR QUIZ ROUTES (Student Portal) ─────────────────────────────────

router.get("/api/star-quiz/chapters", async (req, res) => {
	try {
		const result = await db.execute("SELECT DISTINCT chapter FROM star_quiz_questions WHERE chapter IS NOT NULL AND chapter != '' ORDER BY chapter");
		res.json(result.rows.map(r => r.chapter));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/star-quiz/lectures/:chapter", async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		const result = await db.execute({ sql: "SELECT lecture FROM star_quiz_questions WHERE chapter = ? ORDER BY CAST(lecture AS INTEGER)", args: [chapter] });
		const lectures = result.rows.map(r => String(r.lecture)).filter(Boolean);
		res.json(lectures);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/star-quiz/question/:chapter/:lecture", async (req, res) => {
	try {
		const rawChapter = decodeURIComponent(req.params.chapter || "");
		const lecture = decodeURIComponent(req.params.lecture || "");
		// "_none_" or empty string means no chapter (stored as NULL or "" in DB)
		const chapter = (rawChapter === "_none_" || rawChapter === "") ? null : rawChapter;
		const result = chapter
			? await db.execute({ sql: "SELECT * FROM star_quiz_questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] })
			: await db.execute({ sql: "SELECT * FROM star_quiz_questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1", args: [lecture] });
		if (!result.rows.length) return res.status(404).json({ error: "Not found" });
		const normalized = normalizeQuestionRow(result.rows[0]);
		const { accessCode, ...safeData } = normalized; // never expose the code to client
		res.json(safeData);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Validate access code (student submits code, server checks)
router.post("/api/star-quiz/verify-code", async (req, res) => {
	try {
		const { chapter, lecture, code } = req.body || {};
		if (!chapter || !lecture || !code) return res.status(400).json({ error: "Missing fields" });
		const result = await db.execute({ sql: "SELECT access_code FROM star_quiz_questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
		if (!result.rows.length) return res.status(404).json({ error: "Lecture not found" });
		const stored = result.rows[0].access_code;
		if (!stored) return res.json({ valid: true }); // no code set = open
		res.json({ valid: String(stored) === String(code) });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

/* ══════════════════════════════════════════════════════════════════════════
   REGISTERED STUDENTS — Admin manages roll numbers; students self-register
══════════════════════════════════════════════════════════════════════════ */

// Helper: generate a simple random token

// ── STUDENT: get online tests assigned to me (fast — no questions_json in list) ──
router.get("/api/student/online-tests", async (req, res) => {
	try {
		const row = await getStudentFromToken(req);
		if (!row) return res.status(401).json({ error: "Not authenticated" });
		if (!(await studentFeatureAllowed(row.institute_id, "onlineTests"))) return res.json([]);
		const roll = row.roll_number;
		const now = Date.now();
		// Fetch metadata only — skip the heavy questions_json column for the list
		const result = await db.execute({
			sql: "SELECT id, test_name, marks_correct, marks_wrong, live_at, ends_at, assigned_rolls, created_at, duration_minutes, question_count, max_attempts, is_strict FROM online_tests WHERE ends_at >= ? ORDER BY created_at DESC",
			args: [now],
		});
		// Attempt state per test, aggregated in ONE query. The portal used to download
		// the student's whole test history just to count these, which was very slow.
		//   is_locked = 0 / NULL  → normal completed attempt, counts toward the limit
		//   is_locked = 1         → locked by strict mode, counts AND flags as locked
		//   is_locked = -1        → teacher unlocked it, does NOT count
		const attemptStats = {};
		try {
			const statsResult = await db.execute({
				sql: `SELECT online_test_id,
						SUM(CASE WHEN is_locked IS NULL OR is_locked <> -1 THEN 1 ELSE 0 END) AS used_cnt,
						SUM(CASE WHEN is_locked = 1 THEN 1 ELSE 0 END) AS locked_cnt
					 FROM test_history
					 WHERE mobile = ? AND online_test_id IS NOT NULL
					 GROUP BY online_test_id`,
				args: [roll],
			});
			statsResult.rows.forEach((s) => {
				attemptStats[Number(s.online_test_id)] = {
					used: Number(s.used_cnt) || 0,
					locked: (Number(s.locked_cnt) || 0) > 0,
				};
			});
		} catch (e) { /* non-fatal: fall back to zero attempts */ }

		const tests = result.rows
			.filter(r => {
				try {
					const rolls = JSON.parse(r.assigned_rolls || "[]");
					return rolls.includes(roll);
				} catch { return false; }
			})
			.map(r => {
				const maxAttempts = r.max_attempts || 1;
				const stat = attemptStats[Number(r.id)] || { used: 0, locked: false };
				return {
					id: r.id,
					testName: r.test_name,
					marksCorrect: Number(r.marks_correct),
					marksWrong: Number(r.marks_wrong),
					liveAt: r.live_at,
					endsAt: r.ends_at,
					isUpcoming: r.live_at > now,
					durationMinutes: r.duration_minutes || 90,
					questionCount: r.question_count || 0,
					maxAttempts,
					isStrict: !!(r.is_strict),
					attemptsUsed: stat.used,
					hasLockedAttempt: stat.locked,
					attemptsExhausted: stat.used >= maxAttempts,
					isAttempted: stat.used > 0,
					// questions are NOT sent here — fetched separately when student starts test
				};
			});
		res.json(tests);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: fetch questions for a specific online test (called at test start) ─
router.get("/api/student/online-tests/:id/questions", async (req, res) => {
	try {
		const row = await getStudentFromToken(req);
		if (!row) return res.status(401).json({ error: "Not authenticated" });
		if (!(await studentFeatureAllowed(row.institute_id, "onlineTests"))) {
			return featureBlocked(res, "Online tests are not enabled for your institute.");
		}
		const roll = row.roll_number;
		const testId = Number(req.params.id);
		if (!Number.isFinite(testId)) return res.status(400).json({ error: "Invalid test id" });
		const now = Date.now();
		const result = await db.execute({
			sql: "SELECT id, test_name, marks_correct, marks_wrong, live_at, ends_at, assigned_rolls, duration_minutes, question_keys_json, questions_json, max_attempts, is_strict FROM online_tests WHERE id = ? AND ends_at >= ? LIMIT 1",
			args: [testId, now],
		});
		if (!result.rows.length) return res.status(404).json({ error: "Test not found or expired" });
		const r = result.rows[0];
		// Verify this student is assigned
		try {
			const rolls = JSON.parse(r.assigned_rolls || "[]");
			if (!rolls.includes(roll)) return res.status(403).json({ error: "Not assigned to this test" });
		} catch { return res.status(403).json({ error: "Not assigned" }); }
		// Block questions if test hasn't started yet
		if (r.live_at > now) return res.status(403).json({ error: "Test not live yet" });

		// ── Resolve questions (CACHED) ───────────────────────────────────────
		// THIS IS THE HOTTEST PATH IN THE APP. Every student in an institute starts
		// the same test at the same minute and each one used to trigger a full
		// resolveQuestionKeys() fan-out against the question bank.
		//
		// The resolved question set is IDENTICAL for every student taking a given
		// test, so we cache it by test id. A 200-student institute (or a 40,000
		// student exam morning) now collapses to ONE database resolution per TTL
		// instead of one per student.
		//
		// Only the shared question content is cached — per-student state
		// (attempts, resume data) is still read live below, so nothing leaks
		// between students.
		let questions = [];
		try {
			questions = await cache.getOrSet(
				`tq:v1:${testId}`,
				Number(process.env.TEST_QUESTIONS_TTL || 120),
				async () => {
					const keys = JSON.parse(r.question_keys_json || "[]");
					if (Array.isArray(keys) && keys.length) {
						return await resolveQuestionKeys(keys);
					}
					// Legacy: full questions stored directly
					return JSON.parse(r.questions_json || "[]");
				}
			);
		} catch { questions = []; }

		// ── Per-student question order (anti-cheating) ────────────────────────
		// All 30 students of a batch get the SAME questions, but each one gets
		// them in a different sequence, derived from (testId + their roll number).
		// Deterministic, so a resumed attempt shows the same paper again.
		let questionOrder = questionOrderForStudent(testId, roll, questions.length);

		// Server-side maxAttempts enforcement — count only non-locked normal submissions
		const maxAttempts = Number(r.max_attempts) || 1;
		if (maxAttempts > 0) {
			try {
				const attemptCountResult = await db.execute({
					sql: "SELECT COUNT(*) as cnt FROM test_history WHERE mobile = ? AND online_test_id = ? AND (is_locked = 0 OR is_locked IS NULL)",
					args: [roll, testId],
				});
				const usedAttempts = Number(attemptCountResult.rows[0]?.cnt || 0);
				if (usedAttempts >= maxAttempts) {
					return res.status(403).json({ error: "Max attempts reached", attemptsExhausted: true });
				}
			} catch (e) { /* non-fatal: fall through */ }
		}

		// Check for existing attempt data (teacher-unlocked → resume)
		let existingAttempt = null;
		try {
			const prevResult = await db.execute({
				sql: "SELECT id, answers_json, time_spent_json, time_taken, is_locked, question_order_json FROM test_history WHERE mobile = ? AND online_test_id = ? ORDER BY timestamp DESC LIMIT 1",
				args: [roll, testId],
			});
			if (prevResult.rows.length) {
				const prev = prevResult.rows[0];
				// Only return resume data if unlocked by teacher (is_locked = -1) or locked (is_locked = 1)
				if (Number(prev.is_locked) === -1 || Number(prev.is_locked) === 1) {
					const rawAnswers = (() => { try { return JSON.parse(prev.answers_json || "[]"); } catch { return []; } })();
					const answers = Array.isArray(rawAnswers) ? rawAnswers.map((item, idx) => {
						if (Array.isArray(item)) {
							const [qIdx, studentAnswer, status] = item;
							return { idx: Number.isFinite(Number(qIdx)) ? Number(qIdx) : idx, studentAnswer: studentAnswer === "" ? null : String(studentAnswer), status: status || "s" };
						}
						if (item && typeof item === "object") {
							return { idx: Number.isFinite(Number(item.idx)) ? Number(item.idx) : idx, studentAnswer: item.studentAnswer ?? item.answer ?? item.a ?? null, status: item.status || item.s || "s" };
						}
						const raw = String(item ?? "").trim();
						const skipped = raw === "" || raw === "-1" || raw.toLowerCase() === "null";
						return { idx, studentAnswer: skipped ? null : raw, status: skipped ? "s" : "a" };
					}) : [];
					const timeSpentArr = (() => {
						try {
							const parsed = JSON.parse(prev.time_spent_json || "[]");
							return Array.isArray(parsed) ? parsed : [];
						} catch { return []; }
					})();
					const spentFromJson = timeSpentArr.reduce((s, t) => s + (Number(t) || 0), 0);
					// time_taken is the authoritative fallback for attempts saved before
					// per-question timings existed, so resumed tests never restart at full time.
					const elapsedSec = Math.max(0, Math.round(spentFromJson || Number(prev.time_taken) || 0));
					const totalSec = (Number(r.duration_minutes) || 90) * 60;
					// Resume with the EXACT order this student saw the first time, so the
					// answers saved earlier still point at the same questions.
					const savedOrder = parseQuestionOrder(prev.question_order_json);
					if (isValidQuestionOrder(savedOrder, questions.length)) questionOrder = savedOrder;
					existingAttempt = {
						attemptId: prev.id,
						isLocked: prev.is_locked,
						answers,
						timeSpentJson: timeSpentArr,
						elapsedSec,
						remainingSec: Math.max(30, totalSec - elapsedSec),
					};
				}
			}
		} catch (e) { /* ignore resume check errors */ }

		res.json({
			id: r.id,
			testName: r.test_name,
			marksCorrect: Number(r.marks_correct),
			marksWrong: Number(r.marks_wrong),
			durationMinutes: r.duration_minutes || 90,
			maxAttempts: r.max_attempts || 1,
			isStrict: !!(r.is_strict),
			liveAt: Number(r.live_at) || null,
			endsAt: Number(r.ends_at) || null,
			// Shuffled for this student. `applyQuestionOrder` returns a new array, so
			// the cached shared question list is never mutated.
			questions: applyQuestionOrder(questions, questionOrder),
			// The client sends this back on submit so the attempt records the order.
			questionOrder,
			existingAttempt,
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

function genToken() {
	return crypto.randomBytes(32).toString("hex");
}

// Helper: get student from token sent in Authorization header.
// Now also resolves the student's institute_id so callers can scope queries.
async function getStudentFromToken(req) {
	const auth = req.headers["authorization"] || "";
	const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
	if (!token) return null;
	const now = Date.now();
	const result = await db.execute({
		sql: "SELECT roll_number, institute_id FROM student_sessions WHERE token = ? AND expires > ?",
		args: [token, now],
	});
	if (!result.rows.length) return null;
	const roll = result.rows[0].roll_number;
	const sessionInstId = result.rows[0].institute_id || null;
	// Prefer institute-scoped lookup when the session has one bound; fall back
	// to a generic lookup only if the session predates the migration.
	let stu;
	if (sessionInstId) {
		stu = await db.execute({
			sql: "SELECT * FROM registered_students WHERE roll_number = ? AND institute_id = ? LIMIT 1",
			args: [roll, sessionInstId],
		});
	} else {
		stu = await db.execute({ sql: "SELECT * FROM registered_students WHERE roll_number = ? LIMIT 1", args: [roll] });
	}
	return stu.rows[0] || null;
}


// ── STUDENT: verify roll number (step 1 of login) ───────────────────────────
// Institute-scoped: the student app MUST pass instituteCode so we look the
// roll up only inside that institute. This lets two institutes reuse the
// same roll number without collisions.
router.post("/api/student/verify-roll", rateLimit(60 * 1000, 10), async (req, res) => {
	try {
		const roll = String(req.body?.rollNumber || "").trim();
		const instituteCode = String(req.body?.instituteCode || "").trim().toUpperCase();
		if (!roll) return res.status(400).json({ error: "Roll number required" });
		if (!instituteCode) return res.status(400).json({ error: "Institute is required" });

		// Resolve the institute id from the supplied code.
		const instR = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1", args: [instituteCode] });
		if (!instR.rows.length) return res.status(404).json({ error: "Institute not found" });
		const instId = instR.rows[0].id;

		// Check registered_students inside this institute only.
		const result = await db.execute({
			sql: "SELECT id, profile_complete FROM registered_students WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (result.rows.length) {
			return res.json({ valid: true, profileComplete: !!result.rows[0].profile_complete });
		}

		// Check if already in pending requests for this institute.
		const req2 = await db.execute({
			sql: "SELECT id FROM student_requests WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (req2.rows.length) {
			return res.json({ valid: false, pendingApproval: true });
		}

		// Not registered and no pending request — allow them to fill profile (will become a request)
		return res.json({ valid: false, notRegistered: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: submit access request (for unregistered students) ──────────────
router.post("/api/student/submit-request", rateLimit(60 * 1000, 5), async (req, res) => {
	try {
		const { rollNumber, name, className, phone, age, dateOfBirth, instituteCode } = req.body || {};
		if (!rollNumber || !name) return res.status(400).json({ error: "Roll number and name are required" });
		const roll = String(rollNumber).trim();

		// Institute is now REQUIRED — every student request must belong to one.
		const codeStr = String(instituteCode || "").trim().toUpperCase();
		if (!codeStr) return res.status(400).json({ error: "Institute is required" });
		const ir = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1", args: [codeStr] });
		if (!ir.rows.length) return res.status(404).json({ error: "Institute not found" });
		const instId = ir.rows[0].id;
		if (!(await studentFeatureAllowed(instId, "studentManagement"))) {
			return featureBlocked(res, "This institute is not accepting student registrations.");
		}

		// If already registered in this institute, reject (should use normal save-profile)
		const existing = await db.execute({
			sql: "SELECT id FROM registered_students WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (existing.rows.length) return res.status(409).json({ error: "This roll number is already registered. Please log in normally." });

		const now = Date.now();
		try {
			await db.execute({
				sql: `INSERT INTO student_requests (roll_number, institute_id, name, class_name, phone, age, date_of_birth, requested_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [roll, instId, String(name).trim(), String(className || "").trim(), String(phone || "").trim(),
					String(age || "").trim(), String(dateOfBirth || "").trim(), now],
			});
		} catch (_) {
			// UNIQUE constraint on (roll_number, institute_id) — update existing.
			await db.execute({
				sql: `UPDATE student_requests SET name=?, class_name=?, phone=?, age=?, date_of_birth=?, requested_at=? WHERE roll_number=? AND institute_id=?`,
				args: [String(name).trim(), String(className || "").trim(), String(phone || "").trim(),
					String(age || "").trim(), String(dateOfBirth || "").trim(), now, roll, instId],
			});
		}
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


// ── STUDENT: check request status (for pending approval screen) ──────────────
// Institute-scoped: same roll number can exist in two institutes, so we must
// know which one to check.
router.post("/api/student/check-request-status", rateLimit(60 * 1000, 20), async (req, res) => {
	try {
		const roll = String(req.body?.rollNumber || "").trim();
		const codeStr = String(req.body?.instituteCode || "").trim().toUpperCase();
		if (!roll) return res.status(400).json({ error: "Roll number required" });
		if (!codeStr) return res.status(400).json({ error: "Institute is required" });

		const ir = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1", args: [codeStr] });
		if (!ir.rows.length) return res.status(404).json({ error: "Institute not found" });
		const instId = ir.rows[0].id;

		// Check if now approved (in registered_students with profile_complete)
		const reg = await db.execute({
			sql: "SELECT id, profile_complete FROM registered_students WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (reg.rows.length && reg.rows[0].profile_complete) {
			return res.json({ approved: true });
		}

		// Check still pending
		const pending = await db.execute({
			sql: "SELECT id FROM student_requests WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (pending.rows.length) return res.json({ approved: false, pending: true });

		// Neither — was rejected
		return res.json({ approved: false, pending: false, rejected: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


router.post("/api/student/save-profile", rateLimit(60 * 1000, 10), async (req, res) => {
	try {
		const { rollNumber, name, className, phone, age, dateOfBirth, instituteCode, password } = req.body || {};
		if (!rollNumber || !name) return res.status(400).json({ error: "Roll number and name are required" });
		const codeStr = String(instituteCode || "").trim().toUpperCase();
		if (!codeStr) return res.status(400).json({ error: "Institute is required" });

		const ir = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1", args: [codeStr] });
		if (!ir.rows.length) return res.status(404).json({ error: "Institute not found" });
		const instId = ir.rows[0].id;

		const roll = String(rollNumber).trim();
		const check = await db.execute({
			sql: "SELECT id, password_hash FROM registered_students WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (!check.rows.length) return res.status(404).json({ error: "Roll number not registered in this institute" });
		
		const row = check.rows[0];
		if (!row.password_hash) {
			return res.status(403).json({ error: "Password not set for this account. Please contact your teacher." });
		}
		if (!helpers.verifyPasscode(password, row.password_hash)) {
			return res.status(401).json({ error: "Incorrect password" });
		}

		const now = Date.now();
		await db.execute({
			sql: `UPDATE registered_students SET name=?, class_name=?, phone=?, age=?, date_of_birth=?, profile_complete=1, updated_at=?
			      WHERE roll_number=? AND institute_id=?`,
			args: [String(name).trim(), String(className || "").trim(), String(phone || "").trim(),
			String(age || "").trim(), String(dateOfBirth || "").trim(), now, roll, instId],
		});
		// Create a session token valid for 30 days (bound to this institute)
		const token = genToken();
		const expires = now + 10 * 365 * 24 * 60 * 60 * 1000; // 10 years
		await db.execute({
			sql: "INSERT INTO student_sessions (token, roll_number, institute_id, expires) VALUES (?, ?, ?, ?)",
			args: [token, roll, instId, expires],
		});
		res.json({ success: true, token });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: login with existing profile (roll number + institute) ──────────
// Institute-scoped: the student app must pass instituteCode so two institutes
// can reuse the same roll number without ambiguity.
router.post("/api/student/login", rateLimit(60 * 1000, 10), async (req, res) => {
	try {
		const roll = String(req.body?.rollNumber || "").trim();
		const codeStr = String(req.body?.instituteCode || "").trim().toUpperCase();
		if (!roll) return res.status(400).json({ error: "Roll number required" });
		if (!codeStr) return res.status(400).json({ error: "Institute is required" });

		const ir = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1", args: [codeStr] });
		if (!ir.rows.length) return res.status(404).json({ error: "Institute not found" });
		const instId = ir.rows[0].id;

		const result = await db.execute({
			sql: "SELECT * FROM registered_students WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (!result.rows.length) return res.status(404).json({ error: "Roll number not found in this institute" });
		const row = result.rows[0];

		const password = String(req.body?.password || "").trim();
		if (!row.password_hash) {
			return res.status(403).json({ error: "Password not set for this account. Please contact your teacher." });
		}
		if (!helpers.verifyPasscode(password, row.password_hash)) {
			return res.status(401).json({ error: "Incorrect password" });
		}

		if (!row.profile_complete) return res.json({ needsProfile: true });
		const token = genToken();
		const expires = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000; // 10 years
		await db.execute({
			sql: "INSERT INTO student_sessions (token, roll_number, institute_id, expires) VALUES (?, ?, ?, ?)",
			args: [token, roll, instId, expires],
		});
		let instituteName = "Vyorra";
		if (instId) {
			const instR = await db.execute({ sql: "SELECT name FROM institutes WHERE id = ? LIMIT 1", args: [instId] });
			if (instR.rows.length) instituteName = instR.rows[0].name;
		}
		res.json({
			success: true, token,
			student: { rollNumber: row.roll_number, name: row.name, className: row.class_name, phone: row.phone, age: row.age, dateOfBirth: row.date_of_birth, instituteName },
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: get own profile ─────────────────────────────────────────────────
router.get("/api/student/me", async (req, res) => {
	try {
		const row = await getStudentFromToken(req);
		if (!row) return res.status(401).json({ error: "Not authenticated" });
		let instituteName = "Vyorra";
		if (row.institute_id) {
			const instR = await db.execute({ sql: "SELECT name FROM institutes WHERE id = ? LIMIT 1", args: [row.institute_id] });
			if (instR.rows.length) instituteName = instR.rows[0].name;
		}
		res.json({ rollNumber: row.roll_number, name: row.name, className: row.class_name, section: row.section || "", email: row.email || "", phone: row.phone, age: row.age, dateOfBirth: row.date_of_birth, instituteName, hasPassword: !!row.password_hash });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: update own profile ───────────────────────────────────────���──────
router.post("/api/student/update-profile", async (req, res) => {
	try {
		const row = await getStudentFromToken(req);
		if (!row) return res.status(401).json({ error: "Not authenticated" });
		// Students can no longer edit their own record. Names, classes, sections,
		// phone numbers and emails are owned by the institute that registered them.
		return res.status(403).json({
			error: "Your details are managed by your institute. Please ask your teacher to update them.",
			readOnly: true,
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: logout ───────────────────────────────────────────────────────────
router.post("/api/student/logout", async (req, res) => {
	try {
		const auth = req.headers["authorization"] || "";
		const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
		if (token) await db.execute({ sql: "DELETE FROM student_sessions WHERE token = ?", args: [token] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: get assigned tests (star quiz sets) ────────────────────────────
router.get("/api/student/assigned-tests", async (req, res) => {
	try {
		const row = await getStudentFromToken(req);
		if (!row) return res.status(401).json({ error: "Not authenticated" });
		if (!(await studentFeatureAllowed(row.institute_id, "starQuiz"))) return res.json([]);
		const attemptsResult = await db.execute({
			sql: "SELECT chapter, lecture FROM test_history WHERE mobile = ?",
			args: [row.roll_number]
		});
		const attemptedSet = new Set(attemptsResult.rows.map(r => `${r.chapter || ''}||${r.lecture || ''}`));
		// Return all available star quiz sets with light metadata for the start popup
		const result = await db.execute("SELECT chapter, lecture, topic, updated_at, questions_json FROM star_quiz_questions ORDER BY chapter, CAST(lecture AS INTEGER)");
		const tests = result.rows.map(r => ({
			chapter: r.chapter,
			lecture: r.lecture,
			topic: r.topic || "",
			updatedAt: r.updated_at,
			isAttempted: attemptedSet.has(`${r.chapter || ''}||${r.lecture || ''}`),
			questionCount: (() => {
				try {
					const q = JSON.parse(r.questions_json || '[]');
					return Array.isArray(q) ? q.length : 0;
				} catch {
					return 0;
				}
			})(),
			maxMarks: (() => {
				try {
					const q = JSON.parse(r.questions_json || '[]');
					return (Array.isArray(q) ? q.length : 0) * 4;
				} catch {
					return 0;
				}
			})(),
			maxTimeSec: (() => {
				try {
					const q = JSON.parse(r.questions_json || '[]');
					return (Array.isArray(q) ? q.length : 0) * 90;
				} catch {
					return 0;
				}
			})(),
		}));
		res.json(tests);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


/* ════════════════════════════════════════════════════════════════════════════════
   STUDENT LOGIN — EMAIL + ONE-TIME CODE

   This replaces the roll-number + password flow entirely.

     1. POST /api/student/request-otp  { email }
        → if the email is registered, a 6-digit code is emailed to it.
     2. POST /api/student/verify-otp   { email, code }
        → returns a session token and logs the student straight in.

   Students never type a name, class, section, mobile or date of birth. The
   institute (or the owner) enters all of that when adding the student, so a
   verified code is all that's needed to reach the dashboard.

   Security notes:
     • Only an HMAC of the code is stored, never the code itself.
     • Codes expire after 10 minutes and are single-use.
     • 5 wrong guesses burn the code, so it cannot be brute-forced.
     • request-otp always responds the same way whether or not the email
       exists, so the endpoint cannot be used to enumerate students.
   ═══════════════════════════════════════════════════════════════════════════════ */

const OTP_TTL_MS = 10 * 60 * 1000;   // code lifetime
const OTP_MAX_ATTEMPTS = 5;          // wrong guesses before the code dies
const STUDENT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(v) {
	return String(v || "").trim().toLowerCase();
}

/** Never store the raw code — bind the hash to the email so it can't be reused. */
function hashOtp(email, code) {
	return crypto
		.createHmac("sha256", process.env.SESSION_SECRET || "grip-otp-fallback-secret")
		.update(`${email}:${code}`)
		.digest("hex");
}

function genOtp() {
	return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

/** "arush@gmail.com" → "ar***@gmail.com" — safe to echo back to the browser. */
function maskEmail(email) {
	const [local, domain] = String(email).split("@");
	if (!domain) return "";
	const head = local.slice(0, 2);
	return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/**
 * Find the student row for an email. If instituteCode is supplied we scope to
 * it; otherwise we look across institutes and only accept an unambiguous match,
 * so the student normally just types their email and nothing else.
 */
async function findStudentByEmail(email, instituteCode) {
	if (instituteCode) {
		const ir = await db.execute({
			sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1",
			args: [String(instituteCode).trim().toUpperCase()],
		});
		if (!ir.rows.length) {
			console.warn(`[otp-debug] Institute code="${instituteCode}" not found in DB. Falling back to cross-institute search.`);
			// Fall through to the unscoped search below instead of returning an error.
		} else {
			const instId = ir.rows[0].id;
			console.log(`[otp-debug] Resolved institute code="${instituteCode}" → id=${instId}. Searching registered_students for email="${email}" with institute_id=${instId}`);
			const r = await db.execute({
				sql: `SELECT id, roll_number, institute_id, name, class_name, section, phone, email
				        FROM registered_students
				       WHERE institute_id = ? AND lower(email) = ? LIMIT 1`,
				args: [instId, email],
			});
			if (r.rows.length) {
				return { row: r.rows[0] };
			}
			// Scoped lookup found nothing — fall through to unscoped search so a
			// stale localStorage institute code doesn't silently block login.
			console.warn(`[otp-debug] No student found for email="${email}" in institute id=${instId} (code="${instituteCode}"). Falling back to cross-institute search.`);
		}
	}

	const r = await db.execute({
		sql: `SELECT id, roll_number, institute_id, name, class_name, section, phone, email
		        FROM registered_students
		       WHERE lower(email) = ? LIMIT 2`,
		args: [email],
	});
	if (r.rows.length > 1) return { ambiguous: true };
	if (!r.rows.length) {
		// Extra debug: check total registered students count to help diagnose
		try {
			const countR = await db.execute({ sql: "SELECT COUNT(*) AS c FROM registered_students", args: [] });
			const allR = await db.execute({
				sql: "SELECT id, email, institute_id FROM registered_students WHERE lower(email) = ? LIMIT 5",
				args: [email],
			});
			console.warn(`[otp-debug] Cross-institute search also found 0 results. Total registered_students rows: ${countR.rows[0]?.c || 0}. Direct email match rows: ${allR.rows.length}`);
		} catch (_) {}
	}
	return { row: r.rows[0] || null };
}


// ── STUDENT: request a login code ────────────────────────────────────
router.post("/api/student/request-otp", rateLimit(60 * 1000, 5), async (req, res) => {
	try {
		const email = normalizeEmail(req.body?.email);
		const instituteCode = String(req.body?.instituteCode || "").trim();
		if (!email) return res.status(400).json({ error: "Email is required" });
		if (!STUDENT_EMAIL_RE.test(email)) {
			return res.status(400).json({ error: "Please enter a valid email address" });
		}

		// Opportunistic housekeeping so the table can't grow forever.
		db.execute({ sql: "DELETE FROM student_otps WHERE expires_at < ?", args: [Date.now()] }).catch(() => {});

		const found = await findStudentByEmail(email, instituteCode);
		console.log(`[otp-debug] email="${email}" instituteCode="${instituteCode}" found=`, JSON.stringify(found.row ? { id: found.row.id, email: found.row.email, institute_id: found.row.institute_id } : { row: null, error: found.error || null, ambiguous: found.ambiguous || false }));
		if (found.error) return res.status(404).json({ error: found.error });
		if (found.ambiguous) {
			return res.status(409).json({
				error: "This email is registered with more than one institute. Please open your institute's portal link.",
				needsInstitute: true,
			});
		}

		const row = found.row;
		const masked = maskEmail(email);

		// Unknown email: respond exactly as if it worked. This is deliberate — it
		// stops anyone from discovering which addresses are enrolled. Nothing is
		// sent, so an outsider simply never receives a code.
		if (!row) {
			console.warn(`[otp-debug] ⚠ Student NOT found in DB for email="${email}". No OTP will be sent.`);
			return res.json({ success: true, sent: true, maskedEmail: masked, expiresInSec: OTP_TTL_MS / 1000 });
		}

		// Invalidate any earlier outstanding code for this email + institute.
		await db.execute({
			sql: "UPDATE student_otps SET consumed = 1 WHERE lower(email) = ? AND institute_id = ? AND consumed = 0",
			args: [email, row.institute_id],
		});

		const code = genOtp();
		const now = Date.now();
		await db.execute({
			sql: `INSERT INTO student_otps (email, institute_id, code_hash, attempts, consumed, created_at, expires_at)
			      VALUES (?, ?, ?, 0, 0, ?, ?)`,
			args: [email, row.institute_id, hashOtp(email, code), now, now + OTP_TTL_MS],
		});

		// Branding for the email: the institute's own name + logo, so the code
		// looks like it came from their academy and not from us.
		let instituteName = "Vyorra";
		let instituteLogoUrl = "";
		try {
			const ir = await db.execute({ sql: "SELECT name, logo_url FROM institutes WHERE id = ? LIMIT 1", args: [row.institute_id] });
			if (ir.rows.length) {
				instituteName = ir.rows[0].name;
				instituteLogoUrl = ir.rows[0].logo_url || "";
			}
		} catch (_) {}

		const provider = activeProvider();
		if (provider === "console") {
			// No email provider is configured, so nothing can actually be delivered.
			// Rather than silently pretending it was sent, hand the code back so the
			// portal keeps working, and say plainly that email is not set up.
			console.warn(
				`[otp] \u26a0 No email provider configured \u2014 code for ${email} is ${code}. ` +
				"Set RESEND_API_KEY (see EMAIL_SETUP.md) to email codes for real."
			);
			return res.json({
				success: true,
				sent: false,
				emailConfigured: false,
				provider,
				devCode: code,
				maskedEmail: masked,
				expiresInSec: OTP_TTL_MS / 1000,
			});
		}

		try {
			await sendOtpEmail({
				to: email,
				code,
				studentName: row.name || "",
				instituteName,
				logoUrl: instituteLogoUrl,
				minutes: OTP_TTL_MS / 60000,
			});
			console.log(`[otp] code emailed to ${masked} via ${provider}`);
		} catch (mailErr) {
			const raw = String(mailErr?.message || "");
			console.error(`[otp] send failed via ${provider}:`, raw);

			// Turn the provider's raw API error into something a student and an
			// institute owner can both act on, instead of a generic
			// "connection error" in the portal.
			let friendly = "Could not send the login code right now. Please try again in a minute.";
			let setupHint = "";
			if (/only send testing emails to your own email/i.test(raw)) {
				friendly = "Email login is not fully set up for this institute yet, so codes can only go to the account owner's address.";
				setupHint = "Resend is still in sandbox mode: verify your domain at resend.com/domains, then set MAIL_FROM to an address on that domain and redeploy.";
				console.error("[otp] \u26a0 " + setupHint);
			} else if (/Invalid `?from`? field|invalid sender/i.test(raw)) {
				friendly = "Email login is misconfigured for this institute, so the code could not be sent.";
				setupHint = 'MAIL_FROM must look like Name <you@yourdomain.com> with no surrounding quotes.';
				console.error("[otp] \u26a0 " + setupHint);
			} else if (/\b(401|403)\b|api[_ ]?key|unauthor/i.test(raw)) {
				friendly = "Email login is misconfigured for this institute, so the code could not be sent.";
				setupHint = "The email provider rejected the API key. Check RESEND_API_KEY / BREVO_API_KEY.";
				console.error("[otp] \u26a0 " + setupHint);
			}

			// Escape hatch while the email provider is still being set up (e.g.
			// Resend sandbox mode, which refuses every recipient except the account
			// owner). With OTP_ALLOW_UNSENT_CODE=1 the code is handed back to the
			// portal - exactly like the no-provider-configured path above - so real
			// students can still sign in instead of being hard-blocked.
			// TESTING ONLY: anyone who knows a student email can then log in as them,
			// so unset this the moment your sending domain is verified.
			if (String(process.env.OTP_ALLOW_UNSENT_CODE || "") === "1") {
				console.warn(
					`[otp] \u26a0 OTP_ALLOW_UNSENT_CODE=1 \u2014 delivery failed, returning the code to the portal for ${masked}. ` +
					"Disable this once email works."
				);
				return res.json({
					success: true,
					sent: false,
					emailConfigured: false,
					provider,
					devCode: code,
					maskedEmail: masked,
					expiresInSec: OTP_TTL_MS / 1000,
					deliveryError: friendly,
				});
			}

			return res.status(502).json({
				error: friendly,
				setupHint: setupHint || undefined,
				providerError: raw.slice(0, 200),
				provider,
			});
		}

		res.json({ success: true, sent: true, emailConfigured: true, provider, maskedEmail: masked, expiresInSec: OTP_TTL_MS / 1000 });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to send login code" });
	}
});

// ── STUDENT: verify the code and log in ────────���──────────────────────
router.post("/api/student/verify-otp", rateLimit(60 * 1000, 15), async (req, res) => {
	try {
		const email = normalizeEmail(req.body?.email);
		const code = String(req.body?.code || "").replace(/\D/g, "");
		const instituteCode = String(req.body?.instituteCode || "").trim();
		if (!email || !code) return res.status(400).json({ error: "Email and code are required" });

		const found = await findStudentByEmail(email, instituteCode);
		if (found.error) return res.status(404).json({ error: found.error });
		if (found.ambiguous) return res.status(409).json({ error: "Please open your institute's portal link and try again.", needsInstitute: true });
		const row = found.row;
		// Same generic message whether the email is unknown or the code is wrong.
		if (!row) return res.status(401).json({ error: "That code is incorrect or has expired." });

		const otpR = await db.execute({
			sql: `SELECT id, code_hash, attempts, expires_at
			        FROM student_otps
			       WHERE lower(email) = ? AND institute_id = ? AND consumed = 0
			       ORDER BY created_at DESC LIMIT 1`,
			args: [email, row.institute_id],
		});
		if (!otpR.rows.length) {
			return res.status(401).json({ error: "No active code. Please request a new one." });
		}
		const otp = otpR.rows[0];

		if (Number(otp.expires_at) < Date.now()) {
			await db.execute({ sql: "UPDATE student_otps SET consumed = 1 WHERE id = ?", args: [otp.id] });
			return res.status(401).json({ error: "That code has expired. Please request a new one.", expired: true });
		}
		if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) {
			await db.execute({ sql: "UPDATE student_otps SET consumed = 1 WHERE id = ?", args: [otp.id] });
			return res.status(429).json({ error: "Too many wrong attempts. Please request a new code.", expired: true });
		}

		// Constant-time compare so the hash can't be probed byte by byte.
		const expected = hashOtp(email, code);
		const match = helpers.safeCompare
			? helpers.safeCompare(expected, String(otp.code_hash))
			: expected === String(otp.code_hash);

		if (!match) {
			await db.execute({ sql: "UPDATE student_otps SET attempts = attempts + 1 WHERE id = ?", args: [otp.id] });
			const left = Math.max(0, OTP_MAX_ATTEMPTS - (Number(otp.attempts) + 1));
			return res.status(401).json({
				error: left ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Incorrect code. Please request a new one.",
				attemptsLeft: left,
			});
		}

		// Correct — burn the code and open a session.
		await db.execute({ sql: "UPDATE student_otps SET consumed = 1 WHERE id = ?", args: [otp.id] });

		const token = genToken();
		const expires = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000; // 10 years
		await db.execute({
			sql: "INSERT INTO student_sessions (token, roll_number, institute_id, expires) VALUES (?, ?, ?, ?)",
			args: [token, row.roll_number, row.institute_id, expires],
		});

		// The institute filled everything in already, so mark the profile complete
		// and go straight to the dashboard — there is no profile-setup step.
		await db.execute({
			sql: "UPDATE registered_students SET profile_complete = 1, updated_at = ? WHERE id = ?",
			args: [Date.now(), row.id],
		});

		let instituteName = "Vyorra";
		try {
			const ir = await db.execute({ sql: "SELECT name, code FROM institutes WHERE id = ? LIMIT 1", args: [row.institute_id] });
			if (ir.rows.length) instituteName = ir.rows[0].name;
		} catch (_) {}

		// First code they ever redeem -> the app makes them pick a password next.
		let hasPassword = false;
		try {
			const pr = await db.execute({
				sql: "SELECT password_hash FROM registered_students WHERE id = ? LIMIT 1",
				args: [row.id],
			});
			hasPassword = !!(pr.rows.length && pr.rows[0].password_hash);
		} catch (_) {}

		res.json({
			success: true,
			token,
			hasPassword,
			needsPassword: !hasPassword,
			student: {
				rollNumber: row.roll_number,
				name: row.name || "",
				className: row.class_name || "",
				section: row.section || "",
				email: row.email || email,
				phone: row.phone || "",
				instituteName,
				hasPassword,
			},
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Login failed" });
	}
});


/* ══════════════════════════════════════════════════════════════════════
   PASSWORD LOGIN

   First visit  : email -> code -> "create your password" -> dashboard
   Later visits : email -> password -> dashboard
   Forgot it    : email -> "Forgot password?" -> code -> new password

   login-check never says whether an email is registered; an unknown
   address simply reports hasPassword:false and falls through to the
   code flow, which is already worded generically.
   ══════════════════════════════════════════════════════════════════════ */

const MIN_PASSWORD_LEN = 6;

function passwordProblem(pw) {
	const s = String(pw || "");
	if (s.length < MIN_PASSWORD_LEN) return `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
	if (s.length > 128) return "Password is too long.";
	if (!s.trim()) return "Password cannot be blank.";
	return null;
}

/** Verify + burn a login code. Returns null on success, or {status, error}. */
async function consumeOtp(email, instituteId, code) {
	const otpR = await db.execute({
		sql: `SELECT id, code_hash, attempts, expires_at
		        FROM student_otps
		       WHERE lower(email) = ? AND institute_id = ? AND consumed = 0
		       ORDER BY created_at DESC LIMIT 1`,
		args: [email, instituteId],
	});
	if (!otpR.rows.length) return { status: 401, error: "No active code. Please request a new one." };
	const otp = otpR.rows[0];

	if (Number(otp.expires_at) < Date.now()) {
		await db.execute({ sql: "UPDATE student_otps SET consumed = 1 WHERE id = ?", args: [otp.id] });
		return { status: 401, error: "That code has expired. Please request a new one.", expired: true };
	}
	if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) {
		await db.execute({ sql: "UPDATE student_otps SET consumed = 1 WHERE id = ?", args: [otp.id] });
		return { status: 429, error: "Too many wrong attempts. Please request a new code.", expired: true };
	}

	const expected = hashOtp(email, code);
	const match = helpers.safeCompare
		? helpers.safeCompare(expected, String(otp.code_hash))
		: expected === String(otp.code_hash);

	if (!match) {
		await db.execute({ sql: "UPDATE student_otps SET attempts = attempts + 1 WHERE id = ?", args: [otp.id] });
		const left = Math.max(0, OTP_MAX_ATTEMPTS - (Number(otp.attempts) + 1));
		return {
			status: 401,
			error: left ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Incorrect code. Please request a new one.",
			attemptsLeft: left,
		};
	}

	await db.execute({ sql: "UPDATE student_otps SET consumed = 1 WHERE id = ?", args: [otp.id] });
	return null;
}

async function openStudentSession(row) {
	const token = genToken();
	const expires = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000; // 10 years
	await db.execute({
		sql: "INSERT INTO student_sessions (token, roll_number, institute_id, expires) VALUES (?, ?, ?, ?)",
		args: [token, row.roll_number, row.institute_id, expires],
	});
	let instituteName = "Vyorra";
	try {
		const ir = await db.execute({ sql: "SELECT name FROM institutes WHERE id = ? LIMIT 1", args: [row.institute_id] });
		if (ir.rows.length) instituteName = ir.rows[0].name;
	} catch (_) {}
	return { token, instituteName };
}

// ── STUDENT: does this email already have a password? ─────────────────
router.post("/api/student/login-check", rateLimit(60 * 1000, 20), async (req, res) => {
	try {
		const email = normalizeEmail(req.body?.email);
		const instituteCode = String(req.body?.instituteCode || "").trim();
		if (!email) return res.status(400).json({ error: "Email is required" });
		if (!STUDENT_EMAIL_RE.test(email)) return res.status(400).json({ error: "Please enter a valid email address" });

		const found = await findStudentByEmail(email, instituteCode);
		if (found.ambiguous) {
			return res.status(409).json({ error: "Please open your institute\'s portal link and try again.", needsInstitute: true });
		}
		if (!found.row) return res.json({ success: true, hasPassword: false });

		const pr = await db.execute({
			sql: "SELECT password_hash FROM registered_students WHERE id = ? LIMIT 1",
			args: [found.row.id],
		});
		const hasPassword = !!(pr.rows.length && pr.rows[0].password_hash);
		res.json({ success: true, hasPassword });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: sign in with email + password ────────────────────────────
router.post("/api/student/login-password", rateLimit(60 * 1000, 10), async (req, res) => {
	try {
		const email = normalizeEmail(req.body?.email);
		const password = String(req.body?.password || "");
		const instituteCode = String(req.body?.instituteCode || "").trim();
		if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

		const found = await findStudentByEmail(email, instituteCode);
		if (found.error) return res.status(404).json({ error: found.error });
		if (found.ambiguous) {
			return res.status(409).json({ error: "Please open your institute\'s portal link and try again.", needsInstitute: true });
		}
		const row = found.row;
		// Same message for an unknown email and a wrong password.
		const WRONG = "That email or password is incorrect.";
		if (!row) return res.status(401).json({ error: WRONG });

		const pr = await db.execute({
			sql: "SELECT password_hash FROM registered_students WHERE id = ? LIMIT 1",
			args: [row.id],
		});
		const stored = pr.rows.length ? pr.rows[0].password_hash : null;
		if (!stored) {
			return res.status(403).json({ error: "You have not set a password yet. Sign in with an email code first.", needsPassword: true });
		}
		if (!helpers.verifyPasscode(password, stored)) return res.status(401).json({ error: WRONG });

		const { token, instituteName } = await openStudentSession(row);
		res.json({
			success: true,
			token,
			hasPassword: true,
			student: {
				rollNumber: row.roll_number,
				name: row.name || "",
				className: row.class_name || "",
				section: row.section || "",
				email: row.email || email,
				phone: row.phone || "",
				instituteName,
				hasPassword: true,
			},
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Login failed" });
	}
});

// ── STUDENT: create / change own password (signed in) ─────────────────
router.post("/api/student/set-password", rateLimit(60 * 1000, 10), async (req, res) => {
	try {
		const row = await getStudentFromToken(req);
		if (!row) return res.status(401).json({ error: "Not authenticated" });

		const password = String(req.body?.password || "");
		const problem = passwordProblem(password);
		if (problem) return res.status(400).json({ error: problem });

		await db.execute({
			sql: "UPDATE registered_students SET password_hash = ?, updated_at = ? WHERE id = ?",
			args: [helpers.hashPasscode(password), Date.now(), row.id],
		});
		res.json({ success: true, hasPassword: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Could not save your password" });
	}
});

// ── STUDENT: forgot password — email code, then a brand new password ──
router.post("/api/student/reset-password", rateLimit(60 * 1000, 10), async (req, res) => {
	try {
		const email = normalizeEmail(req.body?.email);
		const code = String(req.body?.code || "").replace(/\D/g, "");
		const password = String(req.body?.password || "");
		const instituteCode = String(req.body?.instituteCode || "").trim();
		if (!email || !code) return res.status(400).json({ error: "Email and code are required" });

		const problem = passwordProblem(password);
		if (problem) return res.status(400).json({ error: problem });

		const found = await findStudentByEmail(email, instituteCode);
		if (found.error) return res.status(404).json({ error: found.error });
		if (found.ambiguous) {
			return res.status(409).json({ error: "Please open your institute\'s portal link and try again.", needsInstitute: true });
		}
		const row = found.row;
		if (!row) return res.status(401).json({ error: "That code is incorrect or has expired." });

		const bad = await consumeOtp(email, row.institute_id, code);
		if (bad) return res.status(bad.status).json(bad);

		await db.execute({
			sql: "UPDATE registered_students SET password_hash = ?, profile_complete = 1, updated_at = ? WHERE id = ?",
			args: [helpers.hashPasscode(password), Date.now(), row.id],
		});

		// Signing out everywhere else is the safe thing to do after a reset.
		try {
			await db.execute({
				sql: "DELETE FROM student_sessions WHERE roll_number = ? AND institute_id = ?",
				args: [row.roll_number, row.institute_id],
			});
		} catch (_) {}

		const { token, instituteName } = await openStudentSession(row);
		res.json({
			success: true,
			token,
			hasPassword: true,
			student: {
				rollNumber: row.roll_number,
				name: row.name || "",
				className: row.class_name || "",
				section: row.section || "",
				email: row.email || email,
				phone: row.phone || "",
				instituteName,
				hasPassword: true,
			},
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Could not reset your password" });
	}
});

module.exports = router;
