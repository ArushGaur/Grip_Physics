"use strict";
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * INSTITUTE FEATURE PERMISSIONS + SUBJECT SCOPING
 *
 * Every institute row carries a `permissions_json` blob. It used to hold only
 * four booleans. It now holds:
 *
 *   {
 *     questionBank:      true,      // question library / browse+edit questions
 *     paperGenerator:    true,      // offline paper (DOCX / PDF) generation
 *     onlineTests:       true,      // create + run online tests, star quiz feed
 *     starQuiz:          true,      // star quiz
 *     studentManagement: true,      // adding / registering / managing students
 *     allowedSubjects:   []         // [] or absent  ==>  ALL subjects allowed
 *   }
 *
 * An institute that only bought the offline question library gets
 * `onlineTests:false, studentManagement:false` and (optionally)
 * `allowedSubjects:["Physics","Mathematics"]`.
 *
 * Nothing here trusts the client: the browser hides the UI, but every backend
 * route that touches a gated feature runs through `requireFeature()` and every
 * question read runs through `subjectSqlFilter()` / `filterRowsBySubject()`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { db } = require("../config/db");
const { sessionInstituteId } = require("../middleware/auth");

// Feature flags (booleans). Anything not listed here is ignored on save.
const FEATURE_KEYS = [
	"questionBank",
	"paperGenerator",
	"onlineTests",
	"starQuiz",
	"studentManagement",
];

// Legacy rows only had the first four keys. Missing key ==> allowed (true),
// which keeps every existing institute working exactly as before.
const DEFAULT_PERMISSIONS = Object.freeze({
	questionBank: true,
	paperGenerator: true,
	onlineTests: true,
	starQuiz: true,
	studentManagement: true,
	allowedSubjects: [],
});

const FEATURE_LABELS = Object.freeze({
	questionBank: "Question Bank",
	paperGenerator: "Paper Generator",
	onlineTests: "Online Tests",
	starQuiz: "Star Quiz",
	studentManagement: "Student Management",
});

/* ── subject canonicalisation ──────────────────────────────────────────────
 * The DB is not consistent about subject spelling ("Maths", "Mathematics",
 * "MATHS", "math"). The developer picks a subject once; we must still match
 * every spelling of it that exists in the bank. So every subject collapses to
 * a canonical token, and comparisons happen on that token.
 */
const SUBJECT_ALIASES = {
	math: "mathematics",
	maths: "mathematics",
	mathematic: "mathematics",
	mathematics: "mathematics",
	mths: "mathematics",
	phy: "physics",
	physic: "physics",
	physics: "physics",
	chem: "chemistry",
	chemistry: "chemistry",
	bio: "biology",
	biology: "biology",
	botany: "botany",
	zoology: "zoology",
};

function canonicalSubject(value) {
	const raw = String(value == null ? "" : value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
	if (!raw) return "";
	return SUBJECT_ALIASES[raw] || raw;
}

/** Every DB spelling we should accept for a chosen subject. */
function subjectVariants(value) {
	const canon = canonicalSubject(value);
	if (!canon) return [];
	const out = new Set([String(value || "").trim().toLowerCase(), canon]);
	for (const [alias, target] of Object.entries(SUBJECT_ALIASES)) {
		if (target === canon) out.add(alias);
	}
	out.delete("");
	return [...out];
}

/* ── normalise / serialise ────────────────────────────────────────────────── */

function normalizePermissions(raw) {
	let obj = raw;
	if (typeof obj === "string") {
		try {
			obj = JSON.parse(obj);
		} catch (_) {
			obj = null;
		}
	}
	if (!obj || typeof obj !== "object") obj = {};

	const out = {};
	for (const key of FEATURE_KEYS) out[key] = obj[key] !== false; // absent ==> true

	let subs = obj.allowedSubjects;
	if (typeof subs === "string") {
		subs = subs.split(",");
	}
	if (!Array.isArray(subs)) subs = [];
	const seen = new Set();
	out.allowedSubjects = [];
	for (const s of subs) {
		const name = String(s == null ? "" : s).trim();
		if (!name) continue;
		const canon = canonicalSubject(name);
		if (seen.has(canon)) continue;
		seen.add(canon);
		out.allowedSubjects.push(name);
	}

	// A locked-down institute cannot run online tests without students, and
	// star quiz is an online-test surface — keep the blob internally consistent
	// so the UI can never present a half-enabled state.
	if (!out.onlineTests) out.starQuiz = false;
	return out;
}

function hasFeature(perms, key) {
	return normalizePermissions(perms)[key] !== false;
}

/** true when this institute is restricted to a subject subset. */
function hasSubjectLimit(perms) {
	const p = normalizePermissions(perms);
	return Array.isArray(p.allowedSubjects) && p.allowedSubjects.length > 0;
}

function isSubjectAllowed(perms, subject) {
	const p = normalizePermissions(perms);
	if (!p.allowedSubjects.length) return true; // no limit configured
	const canon = canonicalSubject(subject);
	if (!canon) return true; // rows with no subject stay visible
	return p.allowedSubjects.some((s) => canonicalSubject(s) === canon);
}

/* ── permission lookup (cached) ───────────────────────────────────────────── */

const CACHE_TTL_MS = 30 * 1000;
const permCache = new Map(); // instituteId -> { at, perms }

function invalidatePermissions(instituteId) {
	if (instituteId == null) permCache.clear();
	else permCache.delete(Number(instituteId));
}

async function getInstitutePermissions(instituteId) {
	if (!instituteId) return { ...DEFAULT_PERMISSIONS, allowedSubjects: [] };
	const id = Number(instituteId);
	const hit = permCache.get(id);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.perms;
	let perms = { ...DEFAULT_PERMISSIONS, allowedSubjects: [] };
	try {
		const r = await db.execute({
			sql: "SELECT permissions_json FROM institutes WHERE id = ? LIMIT 1",
			args: [id],
		});
		if (r.rows.length) perms = normalizePermissions(r.rows[0].permissions_json);
	} catch (e) {
		console.warn("[permissions] lookup failed:", e.message);
	}
	permCache.set(id, { at: Date.now(), perms });
	return perms;
}

/** Permissions for whoever is behind this request (institute admin/teacher). */
async function permissionsForRequest(req) {
	if (req && req.__institutePerms) return req.__institutePerms;
	// The owner/developer panel is never restricted.
	if (req?.session?.ownerAdmin && !sessionInstituteId(req)) {
		const all = { ...DEFAULT_PERMISSIONS, allowedSubjects: [] };
		if (req) req.__institutePerms = all;
		return all;
	}
	const perms = await getInstitutePermissions(sessionInstituteId(req));
	if (req) req.__institutePerms = perms;
	return perms;
}

/** Subjects this request may see. `[]` means "everything". */
async function allowedSubjectsFor(req) {
	const perms = await permissionsForRequest(req);
	return perms.allowedSubjects || [];
}

/* ── express guard ───────────────────────────────────────────────────────── */

/**
 * requireFeature("onlineTests") — 403s when the institute doesn't own the
 * feature. Use it AFTER requireAdmin so we already know who is asking.
 */
function requireFeature(key) {
	return async function featureGuard(req, res, next) {
		try {
			const perms = await permissionsForRequest(req);
			if (perms[key] === false) {
				return res.status(403).json({
					error: `${FEATURE_LABELS[key] || key} is not enabled for your institute.`,
					feature: key,
					blocked: true,
				});
			}
			next();
		} catch (e) {
			console.error("[permissions] guard error:", e.message);
			res.status(500).json({ error: "Permission check failed" });
		}
	};
}

/* ── SQL / row helpers for subject scoping ────────────────────────────────── */

/**
 * Build a SQL fragment restricting `column` to the allowed subjects.
 * Always returns an object. `clause` is an empty string and `args` is an
 * empty array when there is no restriction, so callers can safely read
 * `.clause` / `.args` without a null check.
 *
 *   const f = subjectSqlFilter(perms);
 *   if (f) { sql += ` AND ${f.clause}`; args.push(...f.args); }
 */
function subjectSqlFilter(perms, column = "subject") {
	const p = normalizePermissions(perms);
	if (!p.allowedSubjects.length) return { clause: "", args: [] };
	const variants = new Set();
	for (const s of p.allowedSubjects) {
		for (const v of subjectVariants(s)) variants.add(v);
	}
	const list = [...variants];
	if (!list.length) return { clause: "", args: [] };
	const col = `LOWER(TRIM(${column}))`;
	// Match plain spelling OR the alias-collapsed spelling ("maths" vs "math").
	const clause = `(${col} IN (${list.map(() => "?").join(",")}) OR REPLACE(REPLACE(${col},' ',''),'.','') IN (${list.map(() => "?").join(",")}))`;
	return { clause, args: [...list, ...list] };
}

/** Same thing, but for rows already in memory. */
function filterRowsBySubject(perms, rows, pick = (r) => r?.subject) {
	const p = normalizePermissions(perms);
	if (!p.allowedSubjects.length) return rows;
	if (!Array.isArray(rows)) return rows;
	return rows.filter((r) => isSubjectAllowed(p, pick(r)));
}

module.exports = {
	FEATURE_KEYS,
	FEATURE_LABELS,
	DEFAULT_PERMISSIONS,
	normalizePermissions,
	hasFeature,
	hasSubjectLimit,
	isSubjectAllowed,
	canonicalSubject,
	subjectVariants,
	getInstitutePermissions,
	permissionsForRequest,
	allowedSubjectsFor,
	invalidatePermissions,
	requireFeature,
	subjectSqlFilter,
	filterRowsBySubject,
};
