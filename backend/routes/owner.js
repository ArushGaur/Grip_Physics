const express = require("express");
const router = express.Router();
const multer = require("multer");
const { db } = require("../config/db");
// Reads across BOTH question tables (`questions` + `pyq_questions`).
const { ALL_Q } = require("../utils/questionTables");
const helpers = require("../utils/helpers");
const { requireOwner, loginRateLimit, recordLoginFailure, loginFailMap } = require("../middleware/auth");
const { safeCompare, verifyPasscode, hashPasscode, normalizeStudentRow, normalizeQuestionRow } = helpers;
const { cloudinary } = require("../services/cloudinary");
const {
	normalizePermissions, invalidatePermissions, FEATURE_KEYS, FEATURE_LABELS,
	canonicalSubject,
} = require("../utils/permissions");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "dev-admin-passcode-please-change";

// GET  /api/owner/institutes          — list all institutes with student counts
router.get("/api/owner/institutes", requireOwner, async (req, res) => {
	try {
		const rows = await db.execute(`SELECT * FROM institutes ORDER BY created_at DESC`);
		// Attach per-institute student counts
		const results = await Promise.all(rows.rows.map(async (inst) => {
			let studentCount = 0;
			try {
				const sc = await db.execute({ sql: "SELECT COUNT(*) AS cnt FROM registered_students WHERE institute_id = ?", args: [inst.id] });
				studentCount = Number(sc.rows[0]?.cnt || 0);
			} catch (_) { }
			let perms = {};
			try { perms = JSON.parse(inst.permissions_json || "{}"); } catch (_) { }
			return {
				id: inst.id,
				code: inst.code,
				name: inst.name,
				logo_url: inst.logo_url || "",
				permissions: perms,
				plan_expires_at: inst.plan_expires_at,
				status: inst.status,
				created_at: inst.created_at,
				student_count: studentCount,
			};
		}));
		res.json(results);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to list institutes" });
	}
});

// POST /api/owner/institutes          — create a new institute
router.post("/api/owner/institutes", requireOwner, upload.single("logo"), async (req, res) => {
	try {
		const { name, code, passcode, teacherPasscode, permissions, plan_expires_at } = req.body || {};
		if (!name || !code || !passcode) return res.status(400).json({ error: "name, code, and passcode are required" });

		const upperCode = String(code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
		if (!upperCode) return res.status(400).json({ error: "Invalid institute code" });

		// Check uniqueness
		const exists = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ?", args: [upperCode] });
		if (exists.rows.length) return res.status(409).json({ error: "Institute code already exists" });

		// Upload logo if provided
		let logo_url = "";
		if (req.file) {
			try {
				const b64 = req.file.buffer.toString("base64");
				const dataURI = `data:${req.file.mimetype};base64,${b64}`;
				const uploaded = await cloudinary.uploader.upload(dataURI, {
					folder: "institute_logos",
					public_id: `inst_${upperCode}`,
					overwrite: true,
				});
				logo_url = uploaded.secure_url;
			} catch (e) { console.warn("[institute logo upload]", e.message); }
		}

		let permsObj = { onlineTests: true, starQuiz: true, paperGenerator: true, questionBank: true };
		if (permissions) { try { permsObj = { ...permsObj, ...JSON.parse(permissions) }; } catch (_) { } }

		const expiry = plan_expires_at ? Number(plan_expires_at) : 0;
		const now = Date.now();
		const hash = hashPasscode(passcode);
		const teacherHash = teacherPasscode ? hashPasscode(teacherPasscode) : hash;

		const ins = await db.execute({
			sql: `INSERT INTO institutes (code, name, logo_url, passcode_hash, teacher_passcode_hash, permissions_json, plan_expires_at, status, created_at)
			      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
			args: [upperCode, String(name).trim(), logo_url, hash, teacherHash, JSON.stringify(permsObj), expiry, now],
		});

		res.json({ ok: true, id: Number(ins.lastInsertRowid), code: upperCode, name: String(name).trim(), logo_url });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to create institute" });
	}
});

// PUT /api/owner/institutes/:id       — update an institute (name, logo, permissions, status, expiry, passcode)
router.put("/api/owner/institutes/:id", requireOwner, upload.single("logo"), async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!id) return res.status(400).json({ error: "Invalid id" });

		const existing = await db.execute({ sql: "SELECT * FROM institutes WHERE id = ?", args: [id] });
		if (!existing.rows.length) return res.status(404).json({ error: "Institute not found" });
		const inst = existing.rows[0];

		const { name, passcode, teacherPasscode, permissions, plan_expires_at, status } = req.body || {};

		let logo_url = inst.logo_url || "";
		if (req.file) {
			try {
				const b64 = req.file.buffer.toString("base64");
				const dataURI = `data:${req.file.mimetype};base64,${b64}`;
				const uploaded = await cloudinary.uploader.upload(dataURI, {
					folder: "institute_logos",
					public_id: `inst_${inst.code}`,
					overwrite: true,
				});
				logo_url = uploaded.secure_url;
			} catch (e) { console.warn("[institute logo upload]", e.message); }
		}

		let permsObj = {};
		try { permsObj = JSON.parse(inst.permissions_json || "{}"); } catch (_) { }
		if (permissions) { try { permsObj = { ...permsObj, ...JSON.parse(permissions) }; } catch (_) { } }

		const newName = name ? String(name).trim() : inst.name;
		const newStatus = status || inst.status;
		const newExpiry = plan_expires_at !== undefined ? Number(plan_expires_at) : inst.plan_expires_at;
		const newHash = passcode ? hashPasscode(passcode) : inst.passcode_hash;
		const newTeacherHash = teacherPasscode ? hashPasscode(teacherPasscode) : (inst.teacher_passcode_hash || inst.passcode_hash);

		await db.execute({
			sql: `UPDATE institutes SET name=?, logo_url=?, passcode_hash=?, teacher_passcode_hash=?, permissions_json=?, plan_expires_at=?, status=? WHERE id=?`,
			args: [newName, logo_url, newHash, newTeacherHash, JSON.stringify(permsObj), newExpiry, newStatus, id],
		});

		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to update institute" });
	}
});

// DELETE /api/owner/institutes/:id    — delete an institute (does NOT delete student data; sets status=deleted)
router.delete("/api/owner/institutes/:id", requireOwner, async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!id) return res.status(400).json({ error: "Invalid id" });

		const existing = await db.execute({ sql: "SELECT code FROM institutes WHERE id = ?", args: [id] });
		if (!existing.rows.length) return res.status(404).json({ error: "Institute not found" });
		if (existing.rows[0].code === "DEFAULT") return res.status(400).json({ error: "Cannot delete the Default Institute" });

		// Soft-delete: mark as deleted so student data remains intact
		await db.execute({ sql: "UPDATE institutes SET status = 'deleted' WHERE id = ?", args: [id] });
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to delete institute" });
	}
});

// POST /api/owner/institutes/:id/suspend  — toggle suspend/active
router.post("/api/owner/institutes/:id/suspend", requireOwner, async (req, res) => {
	try {
		const id = Number(req.params.id);
		const existing = await db.execute({ sql: "SELECT status, code FROM institutes WHERE id = ?", args: [id] });
		if (!existing.rows.length) return res.status(404).json({ error: "Institute not found" });
		const { status, code } = existing.rows[0];
		if (code === "DEFAULT") return res.status(400).json({ error: "Cannot suspend the Default Institute" });
		const newStatus = status === "suspended" ? "active" : "suspended";
		await db.execute({ sql: "UPDATE institutes SET status = ? WHERE id = ?", args: [newStatus, id] });
		res.json({ ok: true, status: newStatus });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/features — the feature flags the developer panel can toggle
router.get("/api/owner/features", requireOwner, (req, res) => {
	res.json({
		features: FEATURE_KEYS.map((key) => ({ key, label: FEATURE_LABELS[key] || key })),
	});
});

// GET /api/owner/subjects — every subject present in the question library, so
// the developer can tick exactly which ones an institute is allowed to see.
router.get("/api/owner/subjects", requireOwner, async (req, res) => {
	try {
		const r = await db.execute(
			`SELECT q.subject AS subject, COUNT(*) AS cnt FROM ${ALL_Q}
			  WHERE q.subject IS NOT NULL AND TRIM(q.subject) <> ''
			  GROUP BY q.subject ORDER BY cnt DESC`
		);
		const seen = new Map();
		for (const row of r.rows) {
			const name = String(row.subject || "").trim();
			if (!name) continue;
			const key = canonicalSubject(name);
			if (!seen.has(key)) seen.set(key, { subject: name, canonical: key, count: 0 });
			seen.get(key).count += Number(row.cnt || 0);
		}
		res.json([...seen.values()]);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to list subjects" });
	}
});

// ── Owner login / logout (separate from admin login) ─────────────────────────
// The owner uses the same ADMIN_PASSCODE but gets req.session.ownerAdmin=true
// instead of req.session.admin, so teacher sessions cannot access owner routes.
router.post("/api/owner/login", loginRateLimit, (req, res) => {
	if (!safeCompare(req.body?.passcode || "", ADMIN_PASSCODE)) {
		recordLoginFailure(req.ip);
		return res.status(401).json({ error: "Invalid passcode" });
	}
	loginFailMap.delete(req.ip);
	req.session.regenerate((err) => {
		if (err) return res.status(500).json({ error: "Session error" });
		req.session.ownerAdmin = true;
		req.session.admin = true; // also set admin flag so existing admin routes work for owner
		req.session.loginTime = Date.now();
		req.session.save((saveErr) => {
			if (saveErr) return res.status(500).json({ error: "Session save error" });
			res.json({ ok: true });
		});
	});
});

// ── OWNER logout ──────────────────────────────────────────────────────────────
// Owner has its own cookie (`grip.owner.sid`), completely separate from the
// client session. We can safely destroy it without affecting the client.
router.post("/api/owner/logout", (req, res) => {
	if (req.session) {
		return req.session.destroy(() => res.json({ ok: true }));
	}
	res.json({ ok: true });
});

router.get("/api/owner/me", (req, res) => {
	if (req.session?.ownerAdmin) return res.json({ loggedIn: true });
	res.json({ loggedIn: false });
});

// ══════════════════════════════════════════════════════════════════════════════
// OWNER — PER-INSTITUTE DATA VIEWS
// These mirror the /api/admin/* data endpoints but accept an explicit
// ?instituteId=<id> query param instead of relying on sessionInstituteId().
// This lets the owner dashboard view any institute's data without needing to
// be logged into that institute's client session.
// All routes require requireOwner (ownerAdmin session flag).
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/owner/institutes/:id/students
router.get("/api/owner/institutes/:id/students", requireOwner, async (req, res) => {
	try {
		const instId = Number(req.params.id);
		if (!instId) return res.status(400).json({ error: "Invalid institute id" });
		const result = await db.execute({
			sql: "SELECT * FROM students WHERE institute_id = ? ORDER BY time DESC",
			args: [instId],
		});
		res.json(result.rows.map(normalizeStudentRow));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/institutes/:id/registered-students
router.get("/api/owner/institutes/:id/registered-students", requireOwner, async (req, res) => {
	try {
		const instId = Number(req.params.id);
		if (!instId) return res.status(400).json({ error: "Invalid institute id" });
		// Explicit columns instead of SELECT *: uses the
		// idx_rs_inst_created composite index and keeps the payload lean.
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

// POST /api/owner/institutes/:id/registered-students/add
// Owner-side "Add Students", for any institute. It reuses the exact same
// validation helper as the institute panel (name, class, section, mobile,
// email — no passwords), so the two panels can never drift apart.
router.post("/api/owner/institutes/:id/registered-students/add", requireOwner, async (req, res) => {
	try {
		const instId = Number(req.params.id);
		if (!instId) return res.status(400).json({ error: "Invalid institute id" });

		const { students } = req.body || {};
		if (!Array.isArray(students) || !students.length) {
			return res.status(400).json({ error: "No student records provided" });
		}

		// Confirm the institute exists before writing rows against its id.
		const inst = await db.execute({ sql: "SELECT id FROM institutes WHERE id = ? LIMIT 1", args: [instId] });
		if (!inst.rows.length) return res.status(404).json({ error: "Institute not found" });

		// Lazy require keeps the module graph acyclic at load time.
		const { addStudentsToInstitute } = require("./admin");
		const outcome = await addStudentsToInstitute(students, instId);
		res.json({ success: true, ...outcome });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/institutes/:id/online-tests
router.get("/api/owner/institutes/:id/online-tests", requireOwner, async (req, res) => {
	try {
		const instId = Number(req.params.id);
		if (!instId) return res.status(400).json({ error: "Invalid institute id" });
		const result = await db.execute({
			sql: "SELECT id, test_name, marks_correct, marks_wrong, live_at, ends_at, assigned_rolls, created_at, question_count FROM online_tests WHERE institute_id = ? ORDER BY created_at DESC",
			args: [instId],
		});
		res.json(result.rows.map(r => ({
			id: r.id,
			testName: r.test_name,
			marksCorrect: Number(r.marks_correct),
			marksWrong: Number(r.marks_wrong),
			liveAt: r.live_at,
			endsAt: r.ends_at,
			questionCount: r.question_count || 0,
			assignedRolls: (() => { try { return JSON.parse(r.assigned_rolls || "[]"); } catch { return []; } })(),
			createdAt: r.created_at,
		})));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/institutes/:id/test-history
router.get("/api/owner/institutes/:id/test-history", requireOwner, async (req, res) => {
	try {
		const instId = Number(req.params.id);
		if (!instId) return res.status(400).json({ error: "Invalid institute id" });
		// Never SELECT * here: answers_json, questions_json and time_spent_json
		// are large blobs that this list view never renders. Fetching only the
		// summary columns lets Postgres answer straight from idx_th_inst_ts.
		const result = await db.execute({
			sql: `SELECT id, mobile, student_name, student_class, chapter, lecture, topic,
			             correct_count, wrong_count, skipped_count, total_questions,
			             marks_score, max_marks, accuracy_pct, grade, time_taken,
			             scheme, timestamp, online_test_id
			        FROM test_history
			       WHERE institute_id = ?
			       ORDER BY timestamp DESC
			       LIMIT 500`,
			args: [instId],
		});
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ══════════════════════════════════════════════════════════════════════════════
// OWNER — GLOBAL (cross-institute) DATA VIEWS
// These power the owner dashboard's Applications panel + KPI cards. Unlike the
// /api/admin/* counterparts (which are scoped to a single institute), these
// return data across EVERY institute so the owner has a global picture.
// All routes require requireOwner (ownerAdmin session flag).
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/owner/students  — every student attempt across all institutes
router.get("/api/owner/students", requireOwner, async (req, res) => {
	try {
		// PAGINATED. With 200k students this table holds millions of attempt rows;
		// an unbounded SELECT * would load the entire table into Node's heap and
		// OOM the pod. Callers pass ?limit= & ?offset= (defaults keep old screens working).
		const limit = Math.min(Number(req.query.limit) || 500, 2000);
		const offset = Math.max(Number(req.query.offset) || 0, 0);
		const result = await db.execute({
			sql: "SELECT * FROM students ORDER BY time DESC LIMIT ? OFFSET ?",
			args: [limit, offset],
		});
		const rows = result.rows.map(r => {
			const n = (typeof normalizeStudentRow === "function") ? normalizeStudentRow(r) : r;
			// Attach institute_id so the UI can group/filter by institute if desired.
			if (n && r.institute_id != null) n.institute_id = r.institute_id;
			return n;
		}).filter(Boolean);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to list students" });
	}
});

// GET /api/owner/registered-students  — every registered student across all institutes
router.get("/api/owner/registered-students", requireOwner, async (req, res) => {
	try {
		// PAGINATED + explicit columns. 200,000 registered students is ~100MB of
		// JSON if returned in one response — that request alone would stall an
		// entire API pod for seconds.
		const limit = Math.min(Number(req.query.limit) || 500, 2000);
		const offset = Math.max(Number(req.query.offset) || 0, 0);
		const result = await db.execute({
			sql: `SELECT id, roll_number, name, class_name, phone, age, date_of_birth,
				         profile_complete, institute_id, created_at, updated_at
				    FROM registered_students
				   ORDER BY created_at DESC
				   LIMIT ? OFFSET ?`,
			args: [limit, offset],
		});
		res.json(result.rows.map(r => ({
			id: r.id,
			rollNumber: r.roll_number,
			name: r.name || "",
			className: r.class_name || "",
			phone: r.phone || "",
			age: r.age || "",
			dateOfBirth: r.date_of_birth || "",
			profileComplete: !!r.profile_complete,
			instituteId: r.institute_id,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		})));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/chapters  — every distinct chapter across all institutes
// (the question tables are global, shared by every institute)
router.get("/api/owner/chapters", requireOwner, async (req, res) => {
	try {
		const result = await db.execute(`SELECT DISTINCT chapter FROM ${ALL_Q} WHERE chapter IS NOT NULL AND chapter != ''`);
		const chapters = result.rows.map(r => r.chapter).filter(Boolean).sort();
		res.json(chapters);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/questions  — every question from both tables (global, no institute scoping needed)
router.get("/api/owner/questions", requireOwner, async (req, res) => {
	try {
		// PAGINATED. The full question bank is the single largest table in the
		// system (images + LaTeX). Never stream all of it in one response.
		const limit = Math.min(Number(req.query.limit) || 1000, 5000);
		const offset = Math.max(Number(req.query.offset) || 0, 0);
		const result = await db.execute({
			sql: `SELECT * FROM ${ALL_Q} LIMIT ? OFFSET ?`,
			args: [limit, offset],
		});
		const rows = result.rows.map(r => (typeof normalizeQuestionRow === "function") ? normalizeQuestionRow(r) : r).filter(Boolean);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/student-requests  — every pending student-account request across all institutes
router.get("/api/owner/student-requests", requireOwner, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM student_requests WHERE COALESCE(status, 'pending') = 'pending' ORDER BY created_at DESC");
		res.json(result.rows);
	} catch (e) {
		// Table may not exist on older deployments — degrade gracefully so the
		// owner dashboard's badge query never breaks the UI.
		res.json([]);
	}
});

/* ═══════════════════════════════════════════════════════════════════════════
   DEMO REQUESTS  —  "Request a demo" form on the public marketing site
   (frontend/index.html #demoForm) lands here and is reviewed by the owner in
   the panel's "Demo Requests" section.
   ═══════════════════════════════════════════════════════════════════════════ */

const DEMO_STATUSES = ["new", "contacted", "scheduled", "won", "lost"];

function shapeDemoRequest(r) {
	return {
		id: r.id,
		name: r.name || "",
		institute: r.institute || "",
		phone: r.phone || "",
		email: r.email || "",
		students: r.students || "",
		message: r.message || "",
		status: r.status || "new",
		notes: r.notes || "",
		source: r.source || "website",
		created_at: Number(r.created_at || 0),
		updated_at: Number(r.updated_at || 0),
	};
}

// Very light in-memory throttle so the public endpoint cannot be spammed
// from a single IP. Keyed by IP, allows 5 submissions per 10 minutes.
const demoSubmitMap = new Map();
function demoRateLimited(ip) {
	const now = Date.now();
	const windowMs = 10 * 60 * 1000;
	const hits = (demoSubmitMap.get(ip) || []).filter((t) => now - t < windowMs);
	if (hits.length >= 5) {
		demoSubmitMap.set(ip, hits);
		return true;
	}
	hits.push(now);
	demoSubmitMap.set(ip, hits);
	return false;
}

// POST /api/demo-requests  — PUBLIC (no session): marketing site form submit
router.post("/api/demo-requests", async (req, res) => {
	try {
		const ip = req.ip || req.connection?.remoteAddress || "unknown";
		if (demoRateLimited(ip)) {
			return res.status(429).json({ error: "Too many requests. Please try again later." });
		}

		const clip = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
		const name = clip(req.body?.name, 120);
		const institute = clip(req.body?.institute, 160);
		const phone = clip(req.body?.phone, 30);
		const email = clip(req.body?.email, 160);
		const students = clip(req.body?.students, 40);
		const message = clip(req.body?.message, 2000);

		if (!name || !institute) return res.status(400).json({ error: "Name and institute are required" });
		if (phone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "A valid phone number is required" });

		const now = Date.now();
		const r = await db.execute({
			sql: `INSERT INTO demo_requests (name, institute, phone, email, students, message, status, source, created_at, updated_at)
			      VALUES (?, ?, ?, ?, ?, ?, 'new', 'website', ?, ?)`,
			args: [name, institute, phone, email, students, message, now, now],
		});
		res.json({ success: true, id: r.lastInsertRowid });
	} catch (e) {
		console.error("[demo-requests] insert failed:", e.message);
		res.status(500).json({ error: "Could not save your request. Please try again." });
	}
});

// GET /api/owner/demo-requests  — list every request (newest first)
router.get("/api/owner/demo-requests", requireOwner, async (req, res) => {
	try {
		const status = String(req.query.status || "").trim();
		const q = DEMO_STATUSES.includes(status)
			? { sql: "SELECT * FROM demo_requests WHERE status = ? ORDER BY created_at DESC", args: [status] }
			: "SELECT * FROM demo_requests ORDER BY created_at DESC";
		const result = await db.execute(q);
		res.json(result.rows.map(shapeDemoRequest));
	} catch (e) {
		// Table may be missing on an older deployment — never break the panel.
		res.json([]);
	}
});

// PUT /api/owner/demo-requests/:id  — update status and/or internal notes
router.put("/api/owner/demo-requests/:id", requireOwner, async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!id) return res.status(400).json({ error: "Invalid id" });

		const sets = [];
		const args = [];
		if (req.body?.status !== undefined) {
			const status = String(req.body.status || "").trim();
			if (!DEMO_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status" });
			sets.push("status = ?");
			args.push(status);
		}
		if (req.body?.notes !== undefined) {
			sets.push("notes = ?");
			args.push(String(req.body.notes || "").slice(0, 2000));
		}
		if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

		sets.push("updated_at = ?");
		args.push(Date.now(), id);
		await db.execute({ sql: `UPDATE demo_requests SET ${sets.join(", ")} WHERE id = ?`, args });

		const out = await db.execute({ sql: "SELECT * FROM demo_requests WHERE id = ?", args: [id] });
		if (!out.rows.length) return res.status(404).json({ error: "Request not found" });
		res.json({ success: true, request: shapeDemoRequest(out.rows[0]) });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to update request" });
	}
});

// DELETE /api/owner/demo-requests/:id
router.delete("/api/owner/demo-requests/:id", requireOwner, async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!id) return res.status(400).json({ error: "Invalid id" });
		await db.execute({ sql: "DELETE FROM demo_requests WHERE id = ?", args: [id] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to delete request" });
	}
});

module.exports = router;