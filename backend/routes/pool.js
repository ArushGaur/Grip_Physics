// ═════════════════════════════════════════════════════════════════════════════
//  SHARED QUESTION POOL  (cross-subject test building)
// ─────────────────────────────────────────────────────────────────────────────
//  Problem this solves: a paper used to be built in ONE sitting, so whoever was
//  generating the test had to pick the questions for every subject. A physics
//  teacher cannot pick chemistry/biology questions.
//
//  Now each teacher pushes their own picks into a shared, server-side pool
//  (`question_pool`) for their institute, TAGGED with the test they are meant
//  for: class, section, shift (morning/evening), test date and mode
//  (online/offline). Later, one person opens "Combine & Create Test", drills
//  Class → Section → Test date → Shift → Mode, and every teacher's questions
//  for that exact test are already sitting together.
//
//  STORAGE: a pooled row is a *pointer*, not a copy. We keep only the question
//  key (source / chapter / lecture / questionIndex) plus a short text preview
//  for the list UI. The full question is resolved from the question bank on
//  demand (see POST /question-pool/resolve).
//
//  RETENTION: pooled rows self-destruct after 15 days (POOL_TTL_DAYS).
//  ACTIVITY: every push writes a row to `question_pool_events` so the panels
//  can raise a "3 new questions pooled by …" notification.
// ═════════════════════════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const { db } = require("../config/db");
const { requireAdmin, sessionInstituteId, getDefaultInstituteId } = require("../middleware/auth");
const { resolveQuestionKeys } = require("../utils/questions");

const POOL_TTL_DAYS = 15;
const POOL_TTL_MS = POOL_TTL_DAYS * 24 * 60 * 60 * 1000;

let poolTableReady = false;
let lastPurge = 0;

async function ensurePoolTable() {
	if (poolTableReady) return;
	await db.execute(`CREATE TABLE IF NOT EXISTS question_pool (
		id BIGSERIAL PRIMARY KEY,
		institute_id BIGINT,
		subject TEXT DEFAULT '',
		chapter TEXT DEFAULT '',
		topic TEXT DEFAULT '',
		lecture TEXT DEFAULT '',
		question_index INTEGER DEFAULT 0,
		source TEXT DEFAULT 'bank',
		added_by TEXT DEFAULT '',
		label TEXT DEFAULT '',
		dedupe_key TEXT DEFAULT '',
		class_name TEXT DEFAULT '',
		section TEXT DEFAULT '',
		shift TEXT DEFAULT '',
		test_date TEXT DEFAULT '',
		mode TEXT DEFAULT '',
		created_at BIGINT DEFAULT 0
	)`);
	// Legacy: older builds stored a full question snapshot here (very large).
	// Pointers are enough, so reclaim the space. Idempotent + instant.
	try { await db.execute(`ALTER TABLE question_pool DROP COLUMN IF EXISTS question_json`); } catch (_) { }
	// Older deployments predate the test-grouping columns.
	for (const col of ["class_name", "section", "shift", "test_date", "mode"]) {
		try { await db.execute(`ALTER TABLE question_pool ADD COLUMN IF NOT EXISTS ${col} TEXT DEFAULT ''`); } catch (_) { }
	}
	await db.execute(`CREATE INDEX IF NOT EXISTS idx_qpool_inst_subject ON question_pool (institute_id, subject)`);
	await db.execute(`CREATE INDEX IF NOT EXISTS idx_qpool_inst_created ON question_pool (institute_id, created_at DESC)`);
	await db.execute(`CREATE INDEX IF NOT EXISTS idx_qpool_group ON question_pool (institute_id, class_name, section, test_date, shift, mode)`);
	await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_qpool_inst_dedupe ON question_pool (institute_id, dedupe_key)`);

	// Activity feed — what got pooled, by whom, for which test.
	await db.execute(`CREATE TABLE IF NOT EXISTS question_pool_events (
		id BIGSERIAL PRIMARY KEY,
		institute_id BIGINT,
		added_by TEXT DEFAULT '',
		subject TEXT DEFAULT '',
		class_name TEXT DEFAULT '',
		section TEXT DEFAULT '',
		shift TEXT DEFAULT '',
		test_date TEXT DEFAULT '',
		mode TEXT DEFAULT '',
		qty INTEGER DEFAULT 0,
		message TEXT DEFAULT '',
		created_at BIGINT DEFAULT 0
	)`);
	await db.execute(`CREATE INDEX IF NOT EXISTS idx_qpool_ev_inst ON question_pool_events (institute_id, created_at DESC)`);
	poolTableReady = true;
}

// Pooled questions are throwaway working state — bin anything older than the
// retention window. Cheap, indexed, and rate-limited to once every 5 minutes.
async function purgeExpired() {
	if (Date.now() - lastPurge < 5 * 60 * 1000) return 0;
	lastPurge = Date.now();
	const cutoff = Date.now() - POOL_TTL_MS;
	try {
		const r = await db.execute({
			sql: "DELETE FROM question_pool WHERE created_at > 0 AND created_at < ?",
			args: [cutoff],
		});
		await db.execute({
			sql: "DELETE FROM question_pool_events WHERE created_at > 0 AND created_at < ?",
			args: [cutoff],
		});
		return Number(r && r.rowsAffected) || 0;
	} catch (_) { return 0; }
}

function str(v) { return String(v == null ? "" : v).trim(); }

function keyOfRow(r) {
	return {
		chapter: r.chapter || "",
		lecture: r.lecture || r.topic || "",
		topic: r.topic || r.lecture || "",
		questionIndex: Number(r.question_index),
		source: r.source || "bank",
	};
}

// The context a teacher chose in the "Send to Combine" popup.
function ctxOf(raw) {
	const c = raw && typeof raw === "object" ? raw : {};
	const shift = str(c.shift).toLowerCase();
	const mode = str(c.mode).toLowerCase();
	return {
		className: str(c.className || c.class_name),
		section: str(c.section),
		shift: shift === "evening" ? "evening" : shift === "morning" ? "morning" : "",
		testDate: str(c.testDate || c.test_date).slice(0, 10),
		mode: mode === "online" ? "online" : mode === "offline" ? "offline" : "",
	};
}

// The same question can legitimately be pooled for two different tests, so the
// test context is part of the uniqueness key.
function dedupeKeyOf(item, ctx) {
	return [
		str(item.source) || "bank",
		str(item.chapter),
		str(item.lecture || item.topic),
		Number.isFinite(Number(item.questionIndex)) ? Number(item.questionIndex) : -1,
		ctx.className, ctx.section, ctx.testDate, ctx.shift, ctx.mode,
	].join("::");
}

// A short, plain-text preview so the pool list is readable without loading the
// full question. LaTeX is preserved verbatim (the panels render it with KaTeX)
// and we never cut in the middle of a $…$ span, which would break rendering.
function previewOf(item, snapshot) {
	let raw = str(item && item.label);
	if (!raw && snapshot) raw = str(snapshot.question || snapshot.text);
	const clean = raw
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (clean.length <= 220) return clean;
	let inMath = false, safe = 0;
	for (let i = 0; i < clean.length && i < 220; i++) {
		if (clean[i] === "$" && clean[i - 1] !== "\\") inMath = !inMath;
		if (!inMath) safe = i;
	}
	if (safe < 40) safe = Math.min(clean.length - 1, 219);
	return clean.slice(0, safe + 1).trim() + "…";
}

function rowToItem(r) {
	return {
		id: Number(r.id),
		subject: r.subject || "Unsorted",
		chapter: r.chapter || "",
		topic: r.topic || "",
		lecture: r.lecture || "",
		questionIndex: Number(r.question_index),
		source: r.source || "bank",
		addedBy: r.added_by || "",
		label: r.label || "",
		className: r.class_name || "",
		section: r.section || "",
		shift: r.shift || "",
		testDate: r.test_date || "",
		mode: r.mode || "",
		createdAt: Number(r.created_at) || 0,
		expiresAt: (Number(r.created_at) || 0) + POOL_TTL_MS,
	};
}

const SELECT_COLS = `id, subject, chapter, topic, lecture, question_index, source,
	              added_by, label, class_name, section, shift, test_date, mode, created_at`;

// ── POOL: list every pooled question for this institute ──────────────────────
router.get("/api/admin/question-pool", requireAdmin, async (req, res) => {
	try {
		await ensurePoolTable();
		const purged = await purgeExpired();
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({
			sql: `SELECT ${SELECT_COLS}
			        FROM question_pool
			       WHERE institute_id = ?
			       ORDER BY test_date ASC, class_name ASC, section ASC, subject ASC, created_at ASC`,
			args: [instId],
		});
		const items = result.rows.map(rowToItem);
		const subjects = {};
		for (const it of items) subjects[it.subject] = (subjects[it.subject] || 0) + 1;
		res.json({ success: true, items, subjects, total: items.length, purged, ttlDays: POOL_TTL_DAYS });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to load question pool" });
	}
});

// ── POOL: recent activity (drives the "new questions pooled" notification) ───
// GET /api/admin/question-pool/events?since=<epoch ms>
router.get("/api/admin/question-pool/events", requireAdmin, async (req, res) => {
	try {
		await ensurePoolTable();
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const since = Number(req.query.since) || 0;
		const r = await db.execute({
			sql: `SELECT id, added_by, subject, class_name, section, shift, test_date, mode, qty, message, created_at
			        FROM question_pool_events
			       WHERE institute_id = ? AND created_at > ?
			       ORDER BY created_at DESC LIMIT 25`,
			args: [instId, since],
		});
		res.json({
			success: true,
			now: Date.now(),
			events: r.rows.map((x) => ({
				id: Number(x.id),
				addedBy: x.added_by || "",
				subject: x.subject || "",
				className: x.class_name || "",
				section: x.section || "",
				shift: x.shift || "",
				testDate: x.test_date || "",
				mode: x.mode || "",
				qty: Number(x.qty) || 0,
				message: x.message || "",
				createdAt: Number(x.created_at) || 0,
			})),
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to load pool activity" });
	}
});

// Shared insert used by /add and by /restore (undo).
async function insertPooled(instId, item, ctx, addedBy, createdAt) {
	const snapshot = item.question && typeof item.question === "object" ? item.question : null;
	const qIdx = Number(item.questionIndex);
	const chapter = str(item.chapter) || str(snapshot && snapshot.chapter);
	const topic = str(item.topic) || str(snapshot && snapshot.topic);
	const lecture = str(item.lecture || item.topic) || str(snapshot && (snapshot.lecture || snapshot.topic));
	// A pointer is only useful if it can be resolved again later.
	if (!Number.isFinite(qIdx) || (!chapter && !lecture)) return "invalid";

	let subject = str(item.subject) || str(snapshot && (snapshot.subject || snapshot.Subject));
	let label = previewOf(item, snapshot);
	// No subject/preview from the client? Resolve once just to fill them in.
	if (!subject || !label) {
		try {
			const one = await resolveQuestionKeys([{ chapter, lecture: lecture || topic, questionIndex: qIdx }]);
			const q = one && one[0];
			if (q) {
				if (!subject) subject = str(q.subject);
				if (!label) label = previewOf({ label: "" }, q);
			}
		} catch (_) { /* preview is cosmetic */ }
	}

	const r = await db.execute({
		sql: `INSERT INTO question_pool
		        (institute_id, subject, chapter, topic, lecture, question_index, source,
		         added_by, label, dedupe_key, class_name, section, shift, test_date, mode, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (institute_id, dedupe_key) DO NOTHING`,
		args: [
			instId,
			subject || "Unsorted",
			chapter,
			topic,
			lecture,
			qIdx,
			str(item.source) || "bank",
			addedBy,
			label,
			dedupeKeyOf({ source: item.source, chapter, lecture: lecture || topic, questionIndex: qIdx }, ctx),
			ctx.className, ctx.section, ctx.shift, ctx.testDate, ctx.mode,
			createdAt,
		],
	});
	if (r && r.rows && r.rows.length) return "added";
	if (r && Number(r.rowsAffected) > 0) return "added";
	return "duplicate";
}

function describeCtx(ctx) {
	const bits = [];
	if (ctx.className) bits.push(ctx.className + (ctx.section ? " " + ctx.section : ""));
	if (ctx.testDate) bits.push(ctx.testDate);
	if (ctx.shift) bits.push(ctx.shift);
	if (ctx.mode) bits.push(ctx.mode);
	return bits.join(" · ");
}

// ── POOL: add questions (a teacher pushing their own subject's picks) ────────
// Body: { items: [{ subject, chapter, topic, lecture, questionIndex, source,
//                   label, question? }],
//         addedBy,
//         context: { className, section, shift, testDate, mode } }
// `question` (if sent) is used ONLY to derive the subject + preview text; it is
// never persisted.
router.post("/api/admin/question-pool/add", requireAdmin, async (req, res) => {
	try {
		await ensurePoolTable();
		await purgeExpired();
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const incoming = Array.isArray(req.body && req.body.items) ? req.body.items : [];
		if (!incoming.length) return res.status(400).json({ error: "items array required" });
		const ctx = ctxOf(req.body && req.body.context);
		if (!ctx.className || !ctx.testDate || !ctx.shift || !ctx.mode) {
			return res.status(400).json({ error: "class, test date, shift and mode are required" });
		}
		const addedBy = str(req.body.addedBy) || "Teacher";
		const now = Date.now();

		let added = 0, duplicate = 0, invalid = 0;
		const subjects = new Set();
		for (const item of incoming) {
			if (!item || typeof item !== "object") { invalid++; continue; }
			const outcome = await insertPooled(instId, item, ctx, addedBy, now);
			if (outcome === "added") { added++; if (item.subject) subjects.add(str(item.subject)); }
			else if (outcome === "duplicate") duplicate++;
			else invalid++;
		}

		if (added > 0) {
			const subjectLabel = [...subjects].filter(Boolean).join(", ");
			const message = `${addedBy} pooled ${added} ${subjectLabel ? subjectLabel + " " : ""}question${added !== 1 ? "s" : ""} for ${describeCtx(ctx)}`;
			try {
				await db.execute({
					sql: `INSERT INTO question_pool_events
					        (institute_id, added_by, subject, class_name, section, shift, test_date, mode, qty, message, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					args: [instId, addedBy, subjectLabel, ctx.className, ctx.section, ctx.shift, ctx.testDate, ctx.mode, added, message, now],
				});
			} catch (_) { /* the notification is a nicety, never fail the push */ }
		}

		res.json({ success: true, added, duplicate, invalid, context: ctx });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to add to question pool" });
	}
});

// ── POOL: put a removed question back (Ctrl+Z undo) ──────────────────────────
// Body: { items: [ <the item objects returned by DELETE /:id> ] }
router.post("/api/admin/question-pool/restore", requireAdmin, async (req, res) => {
	try {
		await ensurePoolTable();
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
		if (!items.length) return res.status(400).json({ error: "items array required" });
		let restored = 0;
		for (const it of items) {
			if (!it || typeof it !== "object") continue;
			const ctx = ctxOf(it);
			const outcome = await insertPooled(instId, it, ctx, str(it.addedBy) || "Teacher", Number(it.createdAt) || Date.now());
			if (outcome === "added") restored++;
		}
		res.json({ success: true, restored });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to restore" });
	}
});

// ── POOL: resolve pooled pointers into full questions ────────────────────────
// Body: { ids: [poolId, …] }  (omit ids to resolve the whole pool)
// Returns: { success, questions: [...], resolved, missing: [{ id, label }] }
// Used right before generating an offline paper, so nothing heavy is stored.
router.post("/api/admin/question-pool/resolve", requireAdmin, async (req, res) => {
	try {
		await ensurePoolTable();
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const ids = Array.isArray(req.body && req.body.ids)
			? req.body.ids.map(Number).filter(Number.isFinite)
			: [];

		let rows;
		if (ids.length) {
			const r = await db.execute({
				sql: `SELECT id, subject, chapter, topic, lecture, question_index, source, label
				        FROM question_pool
				       WHERE institute_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
				args: [instId, ...ids],
			});
			// Preserve the order the client asked for.
			const byId = new Map(r.rows.map((x) => [Number(x.id), x]));
			rows = ids.map((id) => byId.get(id)).filter(Boolean);
		} else {
			const r = await db.execute({
				sql: `SELECT id, subject, chapter, topic, lecture, question_index, source, label
				        FROM question_pool
				       WHERE institute_id = ?
				       ORDER BY subject ASC, created_at ASC`,
				args: [instId],
			});
			rows = r.rows;
		}

		const questions = [];
		const missing = [];
		for (const row of rows) {
			let q = null;
			try {
				const one = await resolveQuestionKeys([keyOfRow(row)]);
				q = (one && one[0]) || null;
			} catch (_) { q = null; }
			if (!q) { missing.push({ id: Number(row.id), label: row.label || "" }); continue; }
			// Carry the pooled subject through so multi-subject papers group nicely.
			if (!q.subject && row.subject) q.subject = row.subject;
			questions.push(q);
		}

		res.json({ success: true, questions, resolved: questions.length, missing });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to resolve pooled questions" });
	}
});

// ── POOL: remove one pooled question (returns it so the client can undo) ─────
router.delete("/api/admin/question-pool/:id", requireAdmin, async (req, res) => {
	try {
		await ensurePoolTable();
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const id = Number(req.params.id);
		const before = await db.execute({
			sql: `SELECT ${SELECT_COLS} FROM question_pool WHERE id = ? AND institute_id = ?`,
			args: [id, instId],
		});
		await db.execute({
			sql: "DELETE FROM question_pool WHERE id = ? AND institute_id = ?",
			args: [id, instId],
		});
		const removed = before.rows.length ? rowToItem(before.rows[0]) : null;
		res.json({ success: true, removed });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── POOL: clear a set of ids / a subject / one test group / everything ───────
router.post("/api/admin/question-pool/clear", requireAdmin, async (req, res) => {
	try {
		await ensurePoolTable();
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const body = req.body || {};
		const subject = str(body.subject);
		const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
		const ctx = body.context ? ctxOf(body.context) : null;

		let removed = [];
		if (ids.length) {
			const before = await db.execute({
				sql: `SELECT ${SELECT_COLS} FROM question_pool WHERE institute_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
				args: [instId, ...ids],
			});
			removed = before.rows.map(rowToItem);
			await db.execute({
				sql: `DELETE FROM question_pool WHERE institute_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
				args: [instId, ...ids],
			});
		} else if (ctx && ctx.className) {
			const where = "institute_id = ? AND class_name = ? AND section = ? AND test_date = ? AND shift = ? AND mode = ?";
			const args = [instId, ctx.className, ctx.section, ctx.testDate, ctx.shift, ctx.mode];
			const before = await db.execute({ sql: `SELECT ${SELECT_COLS} FROM question_pool WHERE ${where}`, args });
			removed = before.rows.map(rowToItem);
			await db.execute({ sql: `DELETE FROM question_pool WHERE ${where}`, args });
		} else if (subject) {
			const before = await db.execute({
				sql: `SELECT ${SELECT_COLS} FROM question_pool WHERE institute_id = ? AND subject = ?`,
				args: [instId, subject],
			});
			removed = before.rows.map(rowToItem);
			await db.execute({
				sql: "DELETE FROM question_pool WHERE institute_id = ? AND subject = ?",
				args: [instId, subject],
			});
		} else {
			const before = await db.execute({
				sql: `SELECT ${SELECT_COLS} FROM question_pool WHERE institute_id = ?`,
				args: [instId],
			});
			removed = before.rows.map(rowToItem);
			await db.execute({ sql: "DELETE FROM question_pool WHERE institute_id = ?", args: [instId] });
		}
		res.json({ success: true, removed });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

module.exports = router;
module.exports.ensurePoolTable = ensurePoolTable;
module.exports.purgeExpired = purgeExpired;
module.exports.POOL_TTL_DAYS = POOL_TTL_DAYS;
