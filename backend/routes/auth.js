const express = require("express");
const router = express.Router();
const { db } = require("../config/db");
const helpers = require("../utils/helpers");
const { safeCompare, verifyPasscode, hashPasscode } = helpers;
const { loginRateLimit, recordLoginFailure, sessionInstituteId, getInstituteById, getDefaultInstituteId, loginFailMap } = require("../middleware/auth");
const { loadQuestions, refreshCache, rebuildYearIndex, findQuestion } = require("../utils/questions");
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "dev-admin-passcode-please-change";
const TEACHER_PASSCODE = process.env.TEACHER_PASSCODE || "dev-teacher-passcode-please-change";

router.post("/api/admin/login", loginRateLimit, (req, res) => {
	if (!safeCompare(req.body?.passcode || "", ADMIN_PASSCODE)) {
		recordLoginFailure(req.ip);
		return res.status(401).json({ error: "Invalid passcode" });
	}

	loginFailMap.delete(req.ip);
	req.session.regenerate((err) => {
		if (err) return res.status(500).json({ error: "Session error" });
		req.session.admin = true;
		req.session.loginTime = Date.now();
		req.session.save((saveErr) => {
			if (saveErr) return res.status(500).json({ error: "Session save error" });
			res.json({ success: true });
		});
	});
});

// ── ADMIN logout ──────────────────────────────────────────────────────────────
// Owner lives on a separate cookie (`grip.owner.sid`), so we can safely
// destroy the entire client session here without affecting the owner.
router.post("/api/admin/logout", (req, res) => {
	if (req.session) {
		return req.session.destroy(() => res.json({ success: true }));
	}
	res.json({ success: true });
});

// ── TEACHER login (legacy — thin wrapper that logs into the Default Institute) ─
// Kept for backward compatibility. The TEACHER_PASSCODE logs into the institute
// whose code is DEFAULT, binding req.session.institute_id to it.
router.post("/api/teacher/login", loginRateLimit, async (req, res) => {
	if (!safeCompare(req.body?.passcode || "", TEACHER_PASSCODE)) {
		recordLoginFailure(req.ip);
		return res.status(401).json({ error: "Invalid passcode" });
	}
	loginFailMap.delete(req.ip);

	// Resolve the Default Institute so the teacher session is institute-scoped.
	let inst = null;
	try {
		const r = await db.execute({ sql: "SELECT * FROM institutes WHERE code = ? LIMIT 1", args: ["DEFAULT"] });
		inst = r.rows[0] || null;
	} catch (_) { }

	let resolvedInstituteId = inst ? inst.id : null;
	if (!resolvedInstituteId) {
		try {
			resolvedInstituteId = await getDefaultInstituteId();
		} catch (_) {
			resolvedInstituteId = null;
		}
	}

	req.session.regenerate((err) => {
		if (err) return res.status(500).json({ error: "Session error" });
		req.session.admin = true;
		req.session.teacher = true;
		req.session.institute_id = resolvedInstituteId;
		req.session.loginTime = Date.now();
		req.session.save((saveErr) => {
			if (saveErr) return res.status(500).json({ error: "Session save error" });
			res.json({ success: true });
		});
	});
});

// ── TEACHER logout ────────────────────────────────────────────────────────────
// Owner lives on a separate cookie, so we can safely destroy the session.
router.post("/api/teacher/logout", (req, res) => {
	if (req.session) {
		return req.session.destroy(() => res.json({ success: true }));
	}
	res.json({ success: true });
});

// ── INSTITUTE login (used by institute.html for every institute/client) ───────
// Login with a unique institute code (id) + that institute's own passcode.
// This ONLY sets institute_id on the session — admin/teacher privileges are NOT
// granted here. The separate teacher-passcode step (/api/institute/teacher-login)
// elevates the session. This prevents students (who pick "Student" at step 2)
// from accidentally inheriting teacher privileges via the shared cookie.
router.post("/api/institute/login", loginRateLimit, async (req, res) => {
	try {
		const code = String(req.body?.code || req.body?.instituteId || "").trim().toUpperCase();
		const passcode = String(req.body?.passcode || "");
		if (!code || !passcode) {
			recordLoginFailure(req.ip);
			return res.status(400).json({ error: "Institute ID and passcode are required" });
		}

		const r = await db.execute({ sql: "SELECT * FROM institutes WHERE code = ? LIMIT 1", args: [code] });
		const inst = r.rows[0] || null;
		if (!inst || !verifyPasscode(passcode, inst.passcode_hash)) {
			recordLoginFailure(req.ip);
			return res.status(401).json({ error: "Invalid institute ID or passcode" });
		}

		// Enforce status + plan expiry at login time.
		if (inst.status && inst.status !== "active") {
			return res.status(403).json({ error: "This institute account is suspended. Please contact support." });
		}
		if (inst.plan_expires_at && Number(inst.plan_expires_at) > 0 && Date.now() > Number(inst.plan_expires_at)) {
			return res.status(403).json({ error: "This institute's plan has expired. Please renew to continue." });
		}

		loginFailMap.delete(req.ip);
		req.session.regenerate((err) => {
			if (err) return res.status(500).json({ error: "Session error" });
			// Only bind institute_id — do NOT set admin/teacher yet.
			// Those are granted by /api/institute/teacher-login.
			req.session.institute_id = inst.id;
			req.session.loginTime = Date.now();
			req.session.save((saveErr) => {
				if (saveErr) return res.status(500).json({ error: "Session save error" });
				res.json({ success: true });
			});
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Login failed" });
	}
});

// ── INSTITUTE logout ──────────────────────────────────────────────────────────
// Owner lives on a separate cookie, so we can safely destroy the session.
router.post("/api/institute/logout", (req, res) => {
	if (req.session) {
		return req.session.destroy(() => res.json({ success: true }));
	}
	res.json({ success: true });
});

// ── INSTITUTE branding + permissions (for client.html) ───────────────────────
// Returns the logged-in institute's branding so the client can swap logo/name,
// and its permissions so restricted sections can be hidden client-side.
router.get("/api/institute/me", async (req, res) => {
	try {
		const id = sessionInstituteId(req);
		if (!id) return res.status(401).json({ error: "Not authenticated" });
		const inst = await getInstituteById(id);
		if (!inst) return res.status(404).json({ error: "Institute not found" });
		let permissions = {};
		try { permissions = JSON.parse(inst.permissions_json || "{}"); } catch { permissions = {}; }
		res.json({
			code: inst.code,
			name: inst.name,
			logoUrl: inst.logo_url || "",
			permissions,
			status: inst.status || "active",
			planExpiresAt: inst.plan_expires_at || 0,
			isAdmin: !!(req.session?.admin && req.session?.teacher),
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── TEACHER PASSCODE VERIFICATION (for client.html) ─────────────────────────
// Elevates the active institute session by verifying the unique teacher passcode.
router.post("/api/institute/teacher-login", loginRateLimit, async (req, res) => {
	try {
		const id = sessionInstituteId(req);
		if (!id) {
			return res.status(401).json({ error: "No active institute session. Please sign in first." });
		}

		const passcode = String(req.body?.passcode || "");
		if (!passcode) {
			recordLoginFailure(req.ip);
			return res.status(400).json({ error: "Passcode is required" });
		}

		const inst = await getInstituteById(id);
		if (!inst) {
			return res.status(404).json({ error: "Institute not found" });
		}

		// Enforce status + plan expiry.
		if (inst.status && inst.status !== "active") {
			return res.status(403).json({ error: "This institute account is suspended." });
		}
		if (inst.plan_expires_at && Number(inst.plan_expires_at) > 0 && Date.now() > Number(inst.plan_expires_at)) {
			return res.status(403).json({ error: "This institute's plan has expired." });
		}

		const teacherHash = inst.teacher_passcode_hash || inst.passcode_hash;
		if (!verifyPasscode(passcode, teacherHash)) {
			recordLoginFailure(req.ip);
			return res.status(401).json({ error: "Invalid teacher passcode" });
		}

		loginFailMap.delete(req.ip);
		req.session.admin = true;
		req.session.teacher = true;
		req.session.save((saveErr) => {
			if (saveErr) return res.status(500).json({ error: "Session save error" });
			res.json({ success: true });
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Teacher verification failed" });
	}
});

// ── Public institute lookup (by query param) ─────────────────────────────────
// Frontend calls GET /api/institute/info?code=TRIUMPH
router.get("/api/institute/info", async (req, res) => {
	try {
		const code = String(req.query.code || "").trim().toUpperCase();
		if (!code) return res.status(400).json({ error: "Institute code required" });
		const r = await db.execute({
			sql: "SELECT code, name, logo_url, status, plan_expires_at FROM institutes WHERE code = ? LIMIT 1",
			args: [code],
		});
		if (!r.rows.length) return res.status(404).json({ error: "Institute not found" });
		const inst = r.rows[0];
		if (inst.status && inst.status !== "active") {
			return res.status(403).json({ error: "This institute account is suspended." });
		}
		if (inst.plan_expires_at && Number(inst.plan_expires_at) > 0 && Date.now() > Number(inst.plan_expires_at)) {
			return res.status(403).json({ error: "This institute's plan has expired." });
		}
		res.json({ code: inst.code, name: inst.name, logoUrl: inst.logo_url || "" });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── Public institute lookup (by param) ──────────────────────────────────────
// Returns minimal public info (code + name + logo) for an institute by code.
// Used by the embedded student portal to display the right branding without
// requiring an admin/teacher session. Does NOT expose passcode or permissions.
router.get("/api/institute/public/:code", async (req, res) => {
	try {
		const code = String(req.params.code || "").trim().toUpperCase();
		if (!code) return res.status(400).json({ error: "Institute code required" });
		const r = await db.execute({
			sql: "SELECT code, name, logo_url, status, plan_expires_at FROM institutes WHERE code = ? LIMIT 1",
			args: [code],
		});
		if (!r.rows.length) return res.status(404).json({ error: "Institute not found" });
		const inst = r.rows[0];
		if (inst.status && inst.status !== "active") {
			return res.status(403).json({ error: "This institute account is suspended." });
		}
		if (inst.plan_expires_at && Number(inst.plan_expires_at) > 0 && Date.now() > Number(inst.plan_expires_at)) {
			return res.status(403).json({ error: "This institute's plan has expired." });
		}
		res.json({ code: inst.code, name: inst.name, logoUrl: inst.logo_url || "" });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── Active institute (for embedded student portal) ──────────────────────────
// The student portal iframe inherits the parent's client.html cookie. This
// endpoint lets the iframe learn which institute it's running inside without
// requiring full admin privileges — it only returns code/name/logo.
router.get("/api/institute/active", async (req, res) => {
	try {
		const id = sessionInstituteId(req);
		if (!id) return res.status(401).json({ error: "No active institute" });
		const inst = await getInstituteById(id);
		if (!inst) return res.status(404).json({ error: "Institute not found" });
		res.json({ code: inst.code, name: inst.name, logoUrl: inst.logo_url || "" });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


module.exports = router;