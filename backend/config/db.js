const { Pool, types } = require("pg");
const path = require("path");

// Load local environment variables from .env file if it exists
try {
	process.loadEnvFile(path.join(__dirname, "../.env"));
} catch (e) {
	// .env file is optional (e.g. in production env variables are set directly)
}

// ── Type parsers ─────────────────────────────────────────────────────────────
// Postgres returns BIGINT (int8, oid 20) and NUMERIC (oid 1700) as STRINGS by
// default. The whole app treats ids, epoch timestamps and marks as JS numbers,
// so parse them here once instead of sprinkling Number() everywhere.
try {
	types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // int8 / bigint / BIGSERIAL / COUNT(*)
	types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric
} catch (_) { /* non-fatal */ }

// ── Connection pool ──────────────────────────────────────────────────────────
const connectionString =
	process.env.SUPABASE_DATABASE_URL ||
	process.env.DATABASE_URL ||
	process.env.POSTGRES_URL ||
	"";

if (!connectionString) {
	console.warn(
		"[db] SUPABASE_DATABASE_URL is not set — set it to your Supabase Postgres connection string."
	);
}

// ── Pool sizing ──────────────────────────────────────────────────────────────
// IMPORTANT: this is PER PROCESS. With cluster mode (WEB_CONCURRENCY) and N
// containers the real connection count is  PG_POOL_MAX x workers x containers.
// Postgres falls over somewhere around 200-400 connections, so keep this SMALL
// and put Supavisor/PgBouncer (transaction mode) in front to multiplex.
//   e.g. 5 pool x 2 workers x 5 pods = 50 server-side connections. Fine.
const POOL_MAX = Number(process.env.PG_POOL_MAX || 5);

const pool = new Pool({
	connectionString,
	// Supabase requires SSL; it uses a managed cert so we don't verify the chain.
	ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
		? false
		: { rejectUnauthorized: false },
	max: POOL_MAX,
	idleTimeoutMillis: 30000,
	// Fail fast when the pool is exhausted rather than piling up a queue of
	// requests that will time out at the load balancer anyway.
	connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 5000),
	// Noisy-neighbour guard: with 1000 institutes on one database, a single
	// unbounded owner/admin query must never be able to pin a core forever.
	statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 10000),
	query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 12000),
	idle_in_transaction_session_timeout: 15000,
	keepAlive: true,
});

pool.on("error", (err) => {
	console.error("[db] idle client error:", err.message);
});

// ── retry wrapper + circuit breaker ──────────────────────────────────────────
// The old version retried 3x with a fixed 500ms/1000ms backoff. During a real
// incident that TRIPLES the load on an already-struggling database, and because
// every client backs off by the same amount they all return together in a
// synchronized wave. Two changes:
//   1. 2 attempts max, with jitter so retries spread out.
//   2. A circuit breaker: after N consecutive failures we fail fast for a few
//      seconds instead of queueing thousands of doomed queries.
const BREAKER = {
	failures: 0,
	openUntil: 0,
	THRESHOLD: Number(process.env.PG_BREAKER_THRESHOLD || 20),
	COOLDOWN_MS: Number(process.env.PG_BREAKER_COOLDOWN_MS || 3000),
};

function isTransient(err) {
	const code = err?.code;
	const msg = err?.message || "";
	return (
		code === "ECONNRESET" ||
		code === "ETIMEDOUT" ||
		code === "57P01" || // admin_shutdown
		code === "08006" || // connection_failure
		code === "08003" || // connection_does_not_exist
		msg.includes("Connection terminated") ||
		msg.includes("socket hang up") ||
		msg.includes("timeout")
	);
}

async function _retry(fn, retries = Number(process.env.PG_RETRIES || 2)) {
	if (Date.now() < BREAKER.openUntil) {
		const e = new Error("Database temporarily unavailable (circuit open)");
		e.code = "EBREAKER";
		throw e;
	}

	for (let i = 0; i < retries; i++) {
		try {
			const out = await fn();
			BREAKER.failures = 0;
			return out;
		} catch (err) {
			if (isTransient(err)) {
				BREAKER.failures++;
				if (BREAKER.failures >= BREAKER.THRESHOLD) {
					BREAKER.openUntil = Date.now() + BREAKER.COOLDOWN_MS;
					BREAKER.failures = 0;
					console.error("[db] circuit breaker OPEN for", BREAKER.COOLDOWN_MS, "ms");
				}
			}
			if (isTransient(err) && i < retries - 1) {
				// full jitter: spreads the retry wave instead of synchronizing it
				const base = 200 * Math.pow(2, i);
				await new Promise((r) => setTimeout(r, Math.random() * base));
				continue;
			}
			throw err;
		}
	}
}

// ── SQL translation: SQLite (libSQL) dialect → Postgres ──────────────────────
// The routes were written for libSQL and use `?` positional placeholders plus a
// couple of SQLite-only idioms. This adapter keeps that call-site contract
// (`db.execute("sql")` / `db.execute({ sql, args })` returning
// `{ rows, rowsAffected, lastInsertRowid }`) so no route code has to change.

// Convert `?` placeholders → `$1, $2, ...`, skipping any `?` inside string
// literals or quoted identifiers.
function toPg(sql) {
	let out = "";
	let n = 1;
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i];
		if (inSingle) {
			out += c;
			if (c === "'") {
				if (sql[i + 1] === "'") { out += "'"; i++; continue; } // escaped ''
				inSingle = false;
			}
			continue;
		}
		if (inDouble) {
			out += c;
			if (c === '"') inDouble = false;
			continue;
		}
		if (c === "'") { inSingle = true; out += c; continue; }
		if (c === '"') { inDouble = true; out += c; continue; }
		if (c === "?") { out += "$" + n++; continue; }
		out += c;
	}
	return out;
}

// Tables whose primary key is NOT a serial column named `id` — we must not
// append `RETURNING id` to inserts targeting them.
const NO_ID_TABLES = new Set(["sessions", "student_stats", "student_sessions"]);

function insertTarget(sql) {
	const m = /^\s*INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i.exec(sql);
	return m ? m[1].toLowerCase() : null;
}

async function execute(arg) {
	let sql;
	let args;
	if (typeof arg === "string") {
		sql = arg;
		args = [];
	} else if (arg && typeof arg === "object") {
		sql = arg.sql;
		args = arg.args || [];
	} else {
		throw new Error("db.execute: invalid argument");
	}

	let text = String(sql);

	// INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
	let addConflict = false;
	if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(text)) {
		text = text.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO");
		if (!/ON\s+CONFLICT/i.test(text)) addConflict = true;
	}

	// Append RETURNING id for inserts so `lastInsertRowid` keeps working.
	const target = insertTarget(text);
	const wantsId =
		!!target && !NO_ID_TABLES.has(target) && !/RETURNING/i.test(text);

	if (addConflict) text += " ON CONFLICT DO NOTHING";
	if (wantsId) text += " RETURNING id";

	const res = await _retry(() => pool.query(toPg(text), args));
	const rows = res.rows || [];
	return {
		rows,
		rowsAffected: res.rowCount || 0,
		// libSQL compatibility: expose the new row id for INSERTs.
		lastInsertRowid:
			wantsId && rows.length && rows[0].id != null ? rows[0].id : undefined,
	};
}

// Run several `;`-separated statements (no params). Used for simple DDL only.
async function executeMultiple(sqlText) {
	const parts = String(sqlText)
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const p of parts) {
		await _retry(() => pool.query(toPg(p)));
	}
}

// Raw passthrough for multi-line statements that contain `;`/`$$` (functions).
async function raw(sqlText, params) {
	return _retry(() => pool.query(sqlText, params));
}

const db = {
	execute,
	executeMultiple,
	raw,
	query: (text, params) => _retry(() => pool.query(text, params)),
	pool,
};

// ─────────────────────────────────────────────────────────────────────────────
// initDB — Supabase (Postgres) schema bootstrap.
//
// The question bank lives in exactly TWO tables:
//   • questions       — the regular bank (no year)
//   • pyq_questions   — previous-year questions (has year/month/day/shift/…)
//
// There is NO `questions_v2` table and NO `questions_v2` view. Every route now
// reads/writes these two tables directly (reads that span the whole bank go
// through the UNION helper in utils/questionTables.js). Any leftover
// `questions_v2` VIEW from an earlier version is dropped below.
// All statements are idempotent, so running this repeatedly is safe.
// ─────────────────────────────────────────────────────────────────────────────
async function initDB(TEACHER_PASSCODE, hashPasscode) {
	const ddl = [
		// ── Split question bank (matches migrate-to-supabase.js) ──────────────
		`CREATE TABLE IF NOT EXISTS questions (id BIGSERIAL PRIMARY KEY, subject TEXT NOT NULL DEFAULT '', unit TEXT DEFAULT '', chapter TEXT DEFAULT '', topic TEXT DEFAULT '', question_type TEXT NOT NULL DEFAULT 'single_correct', raw_json TEXT NOT NULL DEFAULT '{}', created_at BIGINT DEFAULT 0, updated_at BIGINT DEFAULT 0)`,
		`CREATE INDEX IF NOT EXISTS idx_q_chapter_topic ON questions(chapter, topic)`,
		`CREATE INDEX IF NOT EXISTS idx_q_subject ON questions(subject)`,
		`CREATE TABLE IF NOT EXISTS pyq_questions (id BIGSERIAL PRIMARY KEY, subject TEXT NOT NULL DEFAULT '', unit TEXT DEFAULT '', chapter TEXT DEFAULT '', topic TEXT DEFAULT '', question_type TEXT NOT NULL DEFAULT 'single_correct', year TEXT DEFAULT '', month TEXT DEFAULT '', day TEXT DEFAULT '', shift TEXT DEFAULT '', question_number INTEGER, raw_json TEXT NOT NULL DEFAULT '{}', created_at BIGINT DEFAULT 0, updated_at BIGINT DEFAULT 0)`,
		`CREATE INDEX IF NOT EXISTS idx_pyq_chapter_topic ON pyq_questions(chapter, topic)`,
		`CREATE INDEX IF NOT EXISTS idx_pyq_subject_year ON pyq_questions(subject, year)`,
		`CREATE INDEX IF NOT EXISTS idx_pyq_year ON pyq_questions(year)`,

		// ── Student / test / institute tables ─────────────────────────────────
		`CREATE TABLE IF NOT EXISTS students (id BIGSERIAL PRIMARY KEY, mobile TEXT NOT NULL, lecture TEXT NOT NULL, name TEXT, place TEXT, class_name TEXT, chapter TEXT, answers_json TEXT DEFAULT '[]', correct_count INTEGER DEFAULT 0, total_questions INTEGER DEFAULT 0, time BIGINT DEFAULT 0, cheat_flag INTEGER DEFAULT 0, institute_id BIGINT DEFAULT NULL, UNIQUE(mobile, lecture))`,
		`CREATE TABLE IF NOT EXISTS attempts (id BIGSERIAL PRIMARY KEY, mobile TEXT NOT NULL, chapter TEXT, lecture TEXT NOT NULL, time BIGINT DEFAULT 0, institute_id BIGINT DEFAULT NULL)`,
		`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires BIGINT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS star_quiz_questions (id BIGSERIAL PRIMARY KEY, chapter TEXT NOT NULL, lecture TEXT NOT NULL, topic TEXT DEFAULT '', questions_json TEXT NOT NULL DEFAULT '[]', updated_at BIGINT DEFAULT 0, access_code TEXT DEFAULT NULL)`,
		`CREATE TABLE IF NOT EXISTS test_history (id BIGSERIAL PRIMARY KEY, mobile TEXT NOT NULL DEFAULT '', chapter TEXT, lecture TEXT NOT NULL DEFAULT '', topic TEXT DEFAULT '', correct_count INTEGER DEFAULT 0, wrong_count INTEGER DEFAULT 0, skipped_count INTEGER DEFAULT 0, total_questions INTEGER DEFAULT 0, marks_score INTEGER DEFAULT 0, max_marks INTEGER DEFAULT 0, accuracy_pct INTEGER DEFAULT 0, grade TEXT DEFAULT '', time_taken INTEGER DEFAULT 0, scheme TEXT DEFAULT '+1/0', timestamp BIGINT DEFAULT 0, student_name TEXT DEFAULT '', student_class TEXT DEFAULT '', answers_json TEXT DEFAULT '[]', questions_json TEXT DEFAULT '[]', online_test_id BIGINT DEFAULT NULL, is_locked INTEGER DEFAULT 0, institute_id BIGINT DEFAULT NULL, time_spent_json TEXT DEFAULT '[]')`,
		`CREATE INDEX IF NOT EXISTS idx_test_history_mobile ON test_history(mobile)`,
		`CREATE INDEX IF NOT EXISTS idx_test_history_mobile_timestamp ON test_history(mobile, timestamp DESC)`,
		`CREATE TABLE IF NOT EXISTS student_stats (mobile TEXT PRIMARY KEY, tests_completed INTEGER DEFAULT 0, avg_pct INTEGER DEFAULT 0, day_streak INTEGER DEFAULT 0, last_test BIGINT DEFAULT 0, updated_at BIGINT DEFAULT 0)`,
		`CREATE TABLE IF NOT EXISTS paper_templates (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, docx_base64 TEXT NOT NULL, created_at BIGINT DEFAULT 0, institute_id BIGINT DEFAULT NULL)`,
		// `email` is the student's login identity (unique per institute) and
		// `section` is the division within a class. Both are entered by the
		// institute/owner when the student is added — students never type them.
		`CREATE TABLE IF NOT EXISTS registered_students (id BIGSERIAL PRIMARY KEY, roll_number TEXT NOT NULL, name TEXT DEFAULT '', class_name TEXT DEFAULT '', section TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', age TEXT DEFAULT '', date_of_birth TEXT DEFAULT '', profile_complete INTEGER DEFAULT 0, created_at BIGINT DEFAULT 0, updated_at BIGINT DEFAULT 0, password_hash TEXT DEFAULT NULL, institute_id BIGINT DEFAULT NULL, batch_id BIGINT DEFAULT NULL)`,
		`CREATE TABLE IF NOT EXISTS student_sessions (token TEXT PRIMARY KEY, roll_number TEXT NOT NULL, institute_id BIGINT DEFAULT NULL, expires BIGINT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS student_requests (id BIGSERIAL PRIMARY KEY, roll_number TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', class_name TEXT DEFAULT '', section TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', age TEXT DEFAULT '', date_of_birth TEXT DEFAULT '', requested_at BIGINT DEFAULT 0, institute_id BIGINT DEFAULT NULL)`,
		// One-time passcodes for student email login. Only a HMAC of the code is
		// stored, so a database leak cannot be replayed into a login.
		`CREATE TABLE IF NOT EXISTS student_otps (id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL, institute_id BIGINT DEFAULT NULL, code_hash TEXT NOT NULL, attempts INTEGER DEFAULT 0, consumed INTEGER DEFAULT 0, created_at BIGINT DEFAULT 0, expires_at BIGINT DEFAULT 0)`,
		`CREATE TABLE IF NOT EXISTS online_tests (id BIGSERIAL PRIMARY KEY, test_name TEXT NOT NULL DEFAULT 'Online Test', questions_json TEXT NOT NULL DEFAULT '[]', question_keys_json TEXT NOT NULL DEFAULT '[]', marks_correct NUMERIC NOT NULL DEFAULT 4, marks_wrong NUMERIC NOT NULL DEFAULT -1, live_at BIGINT DEFAULT 0, ends_at BIGINT DEFAULT 0, assigned_rolls TEXT NOT NULL DEFAULT '[]', created_at BIGINT DEFAULT 0, duration_minutes INTEGER DEFAULT 90, question_count INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 1, is_strict INTEGER DEFAULT 0, include_pyq BOOLEAN DEFAULT TRUE, institute_id BIGINT DEFAULT NULL)`,
		`CREATE TABLE IF NOT EXISTS institutes (id BIGSERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, logo_url TEXT DEFAULT '', passcode_hash TEXT NOT NULL DEFAULT '', teacher_passcode_hash TEXT DEFAULT '', permissions_json TEXT NOT NULL DEFAULT '{}', plan_expires_at BIGINT DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', created_at BIGINT DEFAULT 0)`,
		`CREATE INDEX IF NOT EXISTS idx_institutes_code ON institutes(code)`,
		`CREATE TABLE IF NOT EXISTS classes (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, institute_id BIGINT DEFAULT NULL, created_at BIGINT DEFAULT 0)`,
		`CREATE TABLE IF NOT EXISTS batches (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, class_id BIGINT NOT NULL, institute_id BIGINT DEFAULT NULL, created_at BIGINT DEFAULT 0)`,
		`CREATE TABLE IF NOT EXISTS attendance (id BIGSERIAL PRIMARY KEY, class_id BIGINT NOT NULL, batch_id BIGINT DEFAULT NULL, roll_number TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'present', institute_id BIGINT DEFAULT NULL, marked_by TEXT DEFAULT '', marked_at BIGINT DEFAULT 0, UNIQUE(roll_number, date))`,
		`CREATE TABLE IF NOT EXISTS notifications (id BIGSERIAL PRIMARY KEY, roll_number TEXT NOT NULL, message TEXT NOT NULL, type TEXT DEFAULT 'attendance', is_read INTEGER DEFAULT 0, institute_id BIGINT DEFAULT NULL, created_at BIGINT DEFAULT 0)`,

		// ── Demo / sales requests coming from the public marketing site form ──
		// Filled by POST /api/demo-requests (index.html "Request a demo" form)
		// and read by the owner panel's "Demo Requests" section.
		`CREATE TABLE IF NOT EXISTS demo_requests (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL DEFAULT '', institute TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', students TEXT DEFAULT '', message TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'new', notes TEXT DEFAULT '', source TEXT DEFAULT 'website', created_at BIGINT DEFAULT 0, updated_at BIGINT DEFAULT 0)`,
		`CREATE INDEX IF NOT EXISTS idx_demo_requests_created ON demo_requests(created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_demo_requests_status ON demo_requests(status)`,

		// ── papers: denormalized paper-wise store (one row per exam+year) ─────
		`CREATE TABLE IF NOT EXISTS papers (id BIGSERIAL PRIMARY KEY, exam TEXT NOT NULL DEFAULT '', year TEXT NOT NULL DEFAULT '', label TEXT DEFAULT '', questions_json TEXT NOT NULL DEFAULT '[]', question_count INTEGER DEFAULT 0, created_at BIGINT DEFAULT 0, updated_at BIGINT DEFAULT 0, UNIQUE(exam, year))`,
		`CREATE INDEX IF NOT EXISTS idx_papers_exam ON papers(exam)`,

		// Composite per-institute roll uniqueness (replaces SQLite table rebuild).
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_registered_students_roll_inst ON registered_students(roll_number, institute_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_student_requests_roll_inst ON student_requests(roll_number, institute_id)`,

		// ── Multi-institute columns on older deployments ─────────────────────
		// CREATE TABLE IF NOT EXISTS is a no-op once the table exists, so the two
		// new columns have to be added explicitly for databases created earlier.
		`ALTER TABLE registered_students ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`,
		`ALTER TABLE registered_students ADD COLUMN IF NOT EXISTS section TEXT DEFAULT ''`,
		`ALTER TABLE student_requests ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`,
		`ALTER TABLE student_requests ADD COLUMN IF NOT EXISTS section TEXT DEFAULT ''`,

		// ── Email login identity ────────────────────────────────────
		// Case-insensitive and scoped to the institute: the same address can exist
		// in two different institutes, but never twice inside one. Blank emails are
		// excluded so legacy rows don't collide with each other.
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_rs_inst_email ON registered_students(institute_id, lower(email)) WHERE email IS NOT NULL AND email <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_rs_email_lower ON registered_students(lower(email)) WHERE email IS NOT NULL AND email <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_otp_email_inst ON student_otps(lower(email), institute_id, expires_at DESC)`,

		// ── Composite tenant indexes ────────────────────────────────
		// Every one of these leads with institute_id, because every tenant query
		// filters on it first. A single-column institute_id index still forces the
		// planner to sort/filter the whole institute in memory afterwards.
		// `migrate-institute-indexes.js` builds the same set CONCURRENTLY on a live
		// database and drops the redundant single-column ones.
		`CREATE INDEX IF NOT EXISTS idx_th_inst_ts ON test_history(institute_id, timestamp DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_th_inst_mobile_ts ON test_history(institute_id, mobile, timestamp DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_th_inst_test ON test_history(institute_id, online_test_id)`,
		`CREATE INDEX IF NOT EXISTS idx_rs_inst_class ON registered_students(institute_id, class_name)`,
		`CREATE INDEX IF NOT EXISTS idx_rs_inst_batch ON registered_students(institute_id, batch_id)`,
		`CREATE INDEX IF NOT EXISTS idx_rs_inst_created ON registered_students(institute_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_att_inst_class_date ON attendance(institute_id, class_id, date)`,
		`CREATE INDEX IF NOT EXISTS idx_att_inst_roll_date ON attendance(institute_id, roll_number, date DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_notif_inst_roll_read ON notifications(institute_id, roll_number, is_read)`,
		`CREATE INDEX IF NOT EXISTS idx_students_inst_mobile ON students(institute_id, mobile)`,
		`CREATE INDEX IF NOT EXISTS idx_attempts_inst_mobile ON attempts(institute_id, mobile)`,
		`CREATE INDEX IF NOT EXISTS idx_ot_inst_live ON online_tests(institute_id, live_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_sreq_inst_requested ON student_requests(institute_id, requested_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_batches_inst_class ON batches(institute_id, class_id)`,

		// ── Per-institute uniqueness ────────────────────────────────
		// The original UNIQUE(roll_number, date) on attendance and
		// UNIQUE(mobile, lecture) on students are GLOBAL, so two institutes that
		// happen to share a roll number or phone number block each other. These
		// replacements add institute_id; the migration script drops the old ones.
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_att_inst_roll_date ON attendance(institute_id, roll_number, date)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_students_inst_mobile_lecture ON students(institute_id, mobile, lecture)`,

		// Institute-scoped indexes.
		`CREATE INDEX IF NOT EXISTS idx_students_institute ON students(institute_id)`,
		`CREATE INDEX IF NOT EXISTS idx_attempts_institute ON attempts(institute_id)`,
		`CREATE INDEX IF NOT EXISTS idx_test_history_institute ON test_history(institute_id)`,
		`CREATE INDEX IF NOT EXISTS idx_online_tests_institute ON online_tests(institute_id)`,
		`CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date)`,
		`CREATE INDEX IF NOT EXISTS idx_notifications_roll ON notifications(roll_number, is_read)`,
	];

	// ── Connection health check before running DDL ─────────────────────────
	try {
		const testResult = await Promise.race([
			raw('SELECT 1 AS ok'),
			new Promise((_, reject) => setTimeout(() => reject(new Error('Connection test timed out after 10s')), 10000))
		]);
		console.log('[db] Connection test passed.');
	} catch (e) {
		console.error('[db] ❌ Cannot reach database:', e.message);
		console.error('[db] Check that your Supabase project is active and SUPABASE_DATABASE_URL is correct.');
		return; // Skip all DDL — DB is unreachable
	}

	// Helper: run a statement with a timeout so a hung query doesn't block startup forever.
	async function ddlWithTimeout(stmt, label, timeoutMs = 15000) {
		return Promise.race([
			raw(stmt),
			new Promise((_, reject) => setTimeout(() => reject(new Error(`DDL timed out after ${timeoutMs/1000}s: ${label}`)), timeoutMs))
		]);
	}

	let ddlOk = 0, ddlSkip = 0;
	for (let i = 0; i < ddl.length; i++) {
		const label = ddl[i].substring(0, 60).replace(/\s+/g, ' ');
		try {
			await ddlWithTimeout(ddl[i], label);
			ddlOk++;
		} catch (e) {
			ddlSkip++;
			console.warn(`[db] DDL ${i+1}/${ddl.length} skipped (${label}...): ${e.message || e}`);
		}
	}
	console.log(`[db] DDL complete: ${ddlOk} OK, ${ddlSkip} skipped.`);

	// ── Shared id sequence so questions & pyq_questions never collide ─────────
	// (Both tables already hold rows with globally-unique ids. A single shared
	// sequence keeps future inserts unique too, so a question id identifies
	// exactly one row across BOTH tables — that's what lets the by-id helpers in
	// utils/questionTables.js find a row without knowing which table holds it.)
	try {
		await ddlWithTimeout(`CREATE SEQUENCE IF NOT EXISTS q_shared_id_seq`, 'create sequence');
		await ddlWithTimeout(
			`SELECT setval('q_shared_id_seq', GREATEST((SELECT COALESCE(MAX(id),0) FROM questions),(SELECT COALESCE(MAX(id),0) FROM pyq_questions)) + 1, false)`,
			'setval sequence', 20000
		);
		await ddlWithTimeout(`ALTER TABLE questions ALTER COLUMN id SET DEFAULT nextval('q_shared_id_seq')`, 'alter questions default');
		await ddlWithTimeout(`ALTER TABLE pyq_questions ALTER COLUMN id SET DEFAULT nextval('q_shared_id_seq')`, 'alter pyq default');
		console.log('[db] Shared id sequence OK.');
	} catch (e) {
		console.warn("[db] shared id sequence setup failed:", e.message);
	}

	// ── Drop the legacy `questions_v2` object if it's still there ────────────
	// Nothing in the app reads `questions_v2` any more — all routes talk to
	// `questions` and `pyq_questions` directly. A leftover compatibility VIEW is
	// dead weight, so it is dropped automatically (dropping a view never touches
	// data). A leftover real TABLE is deliberately NOT dropped here in case it
	// still holds rows: run `node drop-questions-v2.js` to move its rows into the
	// two real tables and then drop it.
	try {
		const legacy = await raw(
			`SELECT relkind FROM pg_class WHERE relname = 'questions_v2' AND relnamespace = 'public'::regnamespace`
		);
		const kind = legacy.rows && legacy.rows[0] ? legacy.rows[0].relkind : null;
		if (kind === "v") {
			await ddlWithTimeout(`DROP VIEW IF EXISTS questions_v2 CASCADE`, 'drop legacy questions_v2 view');
			for (const fn of ["questions_v2_insert", "questions_v2_update", "questions_v2_delete"]) {
				await ddlWithTimeout(`DROP FUNCTION IF EXISTS ${fn}() CASCADE`, `drop legacy fn ${fn}`);
			}
			console.log("[db] Removed legacy questions_v2 view + trigger functions.");
		} else if (kind === "r" || kind === "p") {
			console.warn(
				"[db] ⚠ A real `questions_v2` TABLE still exists but nothing uses it. " +
				"Run `node drop-questions-v2.js` to move any rows into questions/pyq_questions and drop it."
			);
		}
	} catch (e) {
		console.warn("[db] legacy questions_v2 cleanup skipped:", e.message);
	}

	// ── Seed the three exams' rolling "Regular" paper rows ───────────────────
	try {
		const pnow = Date.now();
		for (const [ex, yr, lbl] of [
			["JEE Mains", "Regular", "JEE Regular Ques"],
			["NEET", "Regular", "NEET Regular Ques"],
			["JEE Advanced", "Regular", "JEE Advanced Regular Ques"],
		]) {
			await execute({
				sql: "INSERT INTO papers (exam, year, label, questions_json, question_count, created_at, updated_at) VALUES (?, ?, ?, '[]', 0, ?, ?) ON CONFLICT (exam, year) DO NOTHING",
				args: [ex, yr, lbl, pnow, pnow],
			});
		}
	} catch (e) {
		console.warn("[db] paper seed failed:", e.message);
	}

	// ── Ensure the Default Institute exists (code DEFAULT) ───────────────────
	let defaultInstituteId = null;
	try {
		const existing = await execute({
			sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1",
			args: ["DEFAULT"],
		});
		if (existing.rows.length) {
			defaultInstituteId = existing.rows[0].id;
		} else {
			const now = Date.now();
			const defPerms = JSON.stringify({ onlineTests: true, starQuiz: true, paperGenerator: true, questionBank: true });
			const ins = await execute({
				sql: `INSERT INTO institutes (code, name, logo_url, passcode_hash, teacher_passcode_hash, permissions_json, plan_expires_at, status, created_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: ["DEFAULT", "Vyorra", "", hashPasscode(TEACHER_PASSCODE), hashPasscode(TEACHER_PASSCODE), defPerms, 0, "active", now],
			});
			defaultInstituteId = Number(ins.lastInsertRowid);
		}
	} catch (e) {
		console.warn("[institutes] default institute setup failed:", e.message);
	}

	// Backfill any NULL/0 institute_id rows to the Default Institute.
	if (defaultInstituteId) {
		const instituteScopedTables = [
			"students", "attempts", "test_history", "student_stats",
			"registered_students", "student_requests", "student_sessions", "online_tests",
		];
		for (const tbl of instituteScopedTables) {
			try {
				await execute({
					sql: `UPDATE ${tbl} SET institute_id = ? WHERE institute_id IS NULL OR institute_id = 0`,
					args: [defaultInstituteId],
				});
			} catch (e) {
				console.warn(`[institutes] backfill ${tbl} failed:`, e.message);
			}
		}
		// Repair student institute_id maps using registered_students.
		try {
			for (const tbl of ["students", "attempts", "test_history", "student_stats", "student_sessions"]) {
				const mobileCol = tbl === "student_sessions" ? "roll_number" : "mobile";
				await raw(`
					UPDATE ${tbl} AS t
					SET institute_id = rs.institute_id
					FROM registered_students AS rs
					WHERE rs.roll_number = t.${mobileCol}
					  AND rs.institute_id IS NOT NULL
				`);
			}
			console.log("[db] Student tables institute_id mapping repaired.");
		} catch (e) {
			console.warn("[db] Repair student institute mapping failed:", e.message);
		}
	}

	console.log("Supabase (Postgres) DB initialized");
	return defaultInstituteId;
}

module.exports = {
	db,
	initDB,
};
