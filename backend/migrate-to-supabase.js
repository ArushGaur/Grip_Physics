/**
 * migrate-to-supabase.js
 *
 * One-shot migration: reads from local.db (SQLite) → writes to Supabase (PostgreSQL).
 *
 * Usage:
 *   node migrate-to-supabase.js
 *
 * Requires:
 *   - SUPABASE_DATABASE_URL in .env (or environment)
 *   - better-sqlite3: npm install better-sqlite3 (already in package.json)
 *   - local.db in the same directory as this script
 *
 * What it does (in dependency order):
 *   1. institutes
 *   2. questions (bank, year='')  →  questions table
 *   3. pyq_questions (year≠'')   →  pyq_questions table
 *   4. students
 *   5. attempts
 *   6. registered_students
 *   7. student_requests
 *   8. student_sessions
 *   9. sessions
 *  10. test_history
 *  11. student_stats
 *  12. online_tests
 *  13. star_quiz_questions
 *  14. paper_templates
 *  15. classes, batches, attendance, notifications
 */

"use strict";
const path = require("path");
const { Pool } = require("pg");

// ── Load .env ─────────────────────────────────────────────────────────────────
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch (_) { }

// ── Helpers ───────────────────────────────────────────────────────────────────
function j(x) { try { return JSON.parse(x || "{}"); } catch { return {}; } }
function jArr(x) { try { const r = JSON.parse(x || "[]"); return Array.isArray(r) ? r : []; } catch { return []; } }

/** Map old SQLite question_type to new canonical values */
function normalizeQType(raw) {
	const t = String(raw || "").toUpperCase().trim();
	if (t === "MCQ" || t === "SINGLE_CORRECT" || t === "SINGLE") return "single_correct";
	if (t === "MULTI_CORRECT" || t === "MULTIPLE_CORRECT" || t === "MULTIPLE") return "multi_correct";
	if (t === "INTEGER" || t === "NUMERICAL" || t === "NUMERIC") return "numerical";
	if (t === "ASSERTION_REASON" || t === "ASSERTION REASON") return "assertion_reason";
	if (t === "COMPREHENSION" || t === "PASSAGE") return "comprehension";
	if (t === "FILL_BLANK" || t === "FILL THE BLANK") return "fill_blank";
	if (t === "SUBJECTIVE" || t === "LONG ANSWER") return "subjective";
	return "single_correct";
}

// ── PostgreSQL pool ───────────────────────────────────────────────────────────
const pool = new Pool({
	connectionString: process.env.SUPABASE_DATABASE_URL,
	ssl: { rejectUnauthorized: false },
	max: 3,
	connectionTimeoutMillis: 60_000,
	idleTimeoutMillis: 120_000,
	statement_timeout: 120_000,
});

// ── Convert ? placeholders → $1 $2 … ────────────────────────────────────────
function ph(sql) {
	let i = 0; return sql.replace(/\?/g, () => `$${++i}`);
}

async function pgRun(sql, args = []) {
	return pool.query(ph(sql), args.length ? args : undefined);
}

async function pgInsert(sql, args = []) {
	const finalSql = ph(sql) + (!/RETURNING/i.test(sql) ? " RETURNING id" : "");
	const res = await pool.query(finalSql, args.length ? args : undefined);
	return res.rows[0]?.id;
}

// ── SQLite source (better-sqlite3 — synchronous, no async WASM needed) ────────
const fs = require("fs");
const DB_PATH = path.join(__dirname, "local.db");
let sqlite;
try {
	const Database = require("better-sqlite3");
	sqlite = new Database(DB_PATH, { readonly: true });
	console.log("✓ Opened local.db");
} catch (e) {
	console.error("✗ Cannot open local.db:", e.message);
	process.exit(1);
}

function all(sql, params = []) {
	try { return sqlite.prepare(sql).all(...params); } catch (e) {
		console.warn(`  [warn] SQLite query failed: ${e.message}`);
		return [];
	}
}
function tableExists(name) {
	return !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

// ── Progress helpers ──────────────────────────────────────────────────────────
let totalInserted = 0;
function log(msg) { console.log(msg); }
function progress(table, done, total) {
	process.stdout.write(`\r  ${table}: ${done}/${total}`);
}

// ── Chunked batch insert ──────────────────────────────────────────────────────
async function batchInsert(table, rows, buildFn, { size = 20 } = {}) {
	if (!rows.length) { log(`  ${table}: 0 rows (source empty)`); return; }
	let done = 0;
	for (let i = 0; i < rows.length; i += size) {
		const chunk = rows.slice(i, i + size);
		for (const row of chunk) {
			const [sql, args] = buildFn(row);
			try { await pgRun(sql, args); } catch (e) {
				if (!e.message.includes("duplicate") && !e.message.includes("unique"))
					console.warn(`\n  [warn] ${table}: ${e.message}`);
			}
			done++;
		}
		progress(table, done, rows.length);
	}
	totalInserted += done;
	process.stdout.write(`\r  ✓ ${table}: ${done} rows migrated\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
async function createSchema() {
	console.log("  Creating schema in Supabase...");
	const safe = async (sql) => { try { await pool.query(sql); } catch (_) {} };

	await safe(`CREATE TABLE IF NOT EXISTS questions (id BIGSERIAL PRIMARY KEY, subject TEXT NOT NULL DEFAULT '', unit TEXT DEFAULT '', chapter TEXT DEFAULT '', topic TEXT DEFAULT '', question_type TEXT NOT NULL DEFAULT 'single_correct', raw_json TEXT NOT NULL DEFAULT '{}', created_at BIGINT DEFAULT 0, updated_at BIGINT DEFAULT 0)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_q_subject   ON questions(subject)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_q_chapter   ON questions(chapter)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_q_topic     ON questions(chapter, topic)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_q_type      ON questions(question_type)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_q_subj_type ON questions(subject, question_type)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_q_chap_type ON questions(chapter, question_type)`);

	await safe(`CREATE TABLE IF NOT EXISTS pyq_questions (id BIGSERIAL PRIMARY KEY, subject TEXT NOT NULL DEFAULT '', unit TEXT DEFAULT '', chapter TEXT DEFAULT '', topic TEXT DEFAULT '', question_type TEXT NOT NULL DEFAULT 'single_correct', year TEXT DEFAULT '', month TEXT DEFAULT '', day TEXT DEFAULT '', shift TEXT DEFAULT '', question_number INTEGER, raw_json TEXT NOT NULL DEFAULT '{}', created_at BIGINT DEFAULT 0, updated_at BIGINT DEFAULT 0)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_pyq_paper     ON pyq_questions(subject, year, month, day, shift)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_pyq_chapter   ON pyq_questions(chapter)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_pyq_topic     ON pyq_questions(chapter, topic)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_pyq_type      ON pyq_questions(question_type)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_pyq_year      ON pyq_questions(year)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_pyq_subj_year ON pyq_questions(subject, year)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_pyq_subj_type ON pyq_questions(subject, question_type)`);

	await safe(`CREATE TABLE IF NOT EXISTS students (id BIGSERIAL PRIMARY KEY, mobile TEXT NOT NULL, lecture TEXT NOT NULL, name TEXT, place TEXT, class_name TEXT, chapter TEXT, answers_json TEXT DEFAULT '[]', correct_count INTEGER DEFAULT 0, total_questions INTEGER DEFAULT 0, time BIGINT DEFAULT 0, cheat_flag INTEGER DEFAULT 0, institute_id BIGINT DEFAULT NULL, UNIQUE(mobile, lecture))`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_students_inst   ON students(institute_id)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_students_mobile ON students(mobile, lecture)`);

	await safe(`CREATE TABLE IF NOT EXISTS attempts (id BIGSERIAL PRIMARY KEY, mobile TEXT NOT NULL, chapter TEXT, lecture TEXT NOT NULL, time BIGINT DEFAULT 0, institute_id BIGINT DEFAULT NULL)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_attempts_inst   ON attempts(institute_id)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_attempts_mobile ON attempts(mobile, lecture)`);

	await safe(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires BIGINT NOT NULL)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)`);

	await safe(`CREATE TABLE IF NOT EXISTS star_quiz_questions (id BIGSERIAL PRIMARY KEY, chapter TEXT NOT NULL, lecture TEXT NOT NULL, topic TEXT DEFAULT '', questions_json TEXT NOT NULL DEFAULT '[]', updated_at BIGINT DEFAULT 0, access_code TEXT DEFAULT NULL)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_sqq_chapter_lecture ON star_quiz_questions(chapter, lecture)`);

	await safe(`CREATE TABLE IF NOT EXISTS test_history (id BIGSERIAL PRIMARY KEY, mobile TEXT NOT NULL DEFAULT '', chapter TEXT, lecture TEXT NOT NULL DEFAULT '', topic TEXT DEFAULT '', correct_count INTEGER DEFAULT 0, wrong_count INTEGER DEFAULT 0, skipped_count INTEGER DEFAULT 0, total_questions INTEGER DEFAULT 0, marks_score INTEGER DEFAULT 0, max_marks INTEGER DEFAULT 0, accuracy_pct INTEGER DEFAULT 0, grade TEXT DEFAULT '', time_taken INTEGER DEFAULT 0, scheme TEXT DEFAULT '+1/0', timestamp BIGINT DEFAULT 0, student_name TEXT DEFAULT '', student_class TEXT DEFAULT '', answers_json TEXT DEFAULT '[]', questions_json TEXT DEFAULT '[]', online_test_id BIGINT DEFAULT NULL, is_locked INTEGER DEFAULT 0, institute_id BIGINT DEFAULT NULL, time_spent_json TEXT DEFAULT '[]')`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_th_inst    ON test_history(institute_id)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_th_mobile  ON test_history(mobile)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_th_inst_ts ON test_history(institute_id, timestamp DESC)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_th_test_id ON test_history(online_test_id)`);

	await safe(`CREATE TABLE IF NOT EXISTS student_stats (mobile TEXT PRIMARY KEY, tests_completed INTEGER DEFAULT 0, avg_pct INTEGER DEFAULT 0, day_streak INTEGER DEFAULT 0, last_test BIGINT DEFAULT 0, updated_at BIGINT DEFAULT 0)`);

	await safe(`CREATE TABLE IF NOT EXISTS paper_templates (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, docx_base64 TEXT NOT NULL, created_at BIGINT DEFAULT 0, institute_id BIGINT DEFAULT NULL)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_pt_inst ON paper_templates(institute_id)`);

	await safe(`CREATE TABLE IF NOT EXISTS registered_students (id BIGSERIAL PRIMARY KEY, roll_number TEXT NOT NULL, name TEXT DEFAULT '', class_name TEXT DEFAULT '', phone TEXT DEFAULT '', age TEXT DEFAULT '', date_of_birth TEXT DEFAULT '', profile_complete INTEGER DEFAULT 0, created_at BIGINT DEFAULT 0, updated_at BIGINT DEFAULT 0, password_hash TEXT DEFAULT NULL, institute_id BIGINT DEFAULT NULL, batch_id BIGINT DEFAULT NULL)`);
	await safe(`CREATE UNIQUE INDEX IF NOT EXISTS ux_reg_roll_inst ON registered_students(roll_number, institute_id)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_reg_inst ON registered_students(institute_id)`);

	await safe(`CREATE TABLE IF NOT EXISTS student_sessions (token TEXT PRIMARY KEY, roll_number TEXT NOT NULL, institute_id BIGINT DEFAULT NULL, expires BIGINT NOT NULL)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_ss_roll ON student_sessions(roll_number, institute_id)`);

	await safe(`CREATE TABLE IF NOT EXISTS student_requests (id BIGSERIAL PRIMARY KEY, roll_number TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', class_name TEXT DEFAULT '', phone TEXT DEFAULT '', age TEXT DEFAULT '', date_of_birth TEXT DEFAULT '', requested_at BIGINT DEFAULT 0, institute_id BIGINT DEFAULT NULL)`);
	await safe(`CREATE UNIQUE INDEX IF NOT EXISTS ux_sr_roll_inst ON student_requests(roll_number, institute_id)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_sr_inst ON student_requests(institute_id)`);

	await safe(`CREATE TABLE IF NOT EXISTS online_tests (id BIGSERIAL PRIMARY KEY, test_name TEXT NOT NULL DEFAULT 'Online Test', questions_json TEXT NOT NULL DEFAULT '[]', question_keys_json TEXT NOT NULL DEFAULT '[]', marks_correct NUMERIC NOT NULL DEFAULT 4, marks_wrong NUMERIC NOT NULL DEFAULT -1, live_at BIGINT DEFAULT 0, ends_at BIGINT DEFAULT 0, assigned_rolls TEXT NOT NULL DEFAULT '[]', created_at BIGINT DEFAULT 0, duration_minutes INTEGER DEFAULT 90, question_count INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 1, is_strict INTEGER DEFAULT 0, include_pyq BOOLEAN DEFAULT TRUE, institute_id BIGINT DEFAULT NULL)`);
	// If the table already exists with INTEGER, alter it to NUMERIC so floats like 4.35 work
	await safe(`ALTER TABLE online_tests ALTER COLUMN marks_correct TYPE NUMERIC USING marks_correct::NUMERIC`);
	await safe(`ALTER TABLE online_tests ALTER COLUMN marks_wrong TYPE NUMERIC USING marks_wrong::NUMERIC`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_ot_inst ON online_tests(institute_id)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_ot_live ON online_tests(institute_id, live_at, ends_at)`);

	await safe(`CREATE TABLE IF NOT EXISTS institutes (id BIGSERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, logo_url TEXT DEFAULT '', passcode_hash TEXT NOT NULL DEFAULT '', teacher_passcode_hash TEXT DEFAULT '', permissions_json TEXT NOT NULL DEFAULT '{}', plan_expires_at BIGINT DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', created_at BIGINT DEFAULT 0)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_institutes_code ON institutes(code)`);

	await safe(`CREATE TABLE IF NOT EXISTS classes (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, institute_id BIGINT DEFAULT NULL, created_at BIGINT DEFAULT 0)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_classes_inst ON classes(institute_id)`);
	await safe(`CREATE TABLE IF NOT EXISTS batches (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, class_id BIGINT NOT NULL, institute_id BIGINT DEFAULT NULL, created_at BIGINT DEFAULT 0)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_batches_inst ON batches(institute_id)`);
	await safe(`CREATE TABLE IF NOT EXISTS attendance (id BIGSERIAL PRIMARY KEY, class_id BIGINT NOT NULL, batch_id BIGINT DEFAULT NULL, roll_number TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'present', institute_id BIGINT DEFAULT NULL, marked_by TEXT DEFAULT '', marked_at BIGINT DEFAULT 0, UNIQUE(roll_number, date))`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_att_inst ON attendance(institute_id)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date)`);
	await safe(`CREATE TABLE IF NOT EXISTS notifications (id BIGSERIAL PRIMARY KEY, roll_number TEXT NOT NULL, message TEXT NOT NULL, type TEXT DEFAULT 'attendance', is_read INTEGER DEFAULT 0, institute_id BIGINT DEFAULT NULL, created_at BIGINT DEFAULT 0)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_notif_inst ON notifications(institute_id)`);
	await safe(`CREATE INDEX IF NOT EXISTS idx_notif_roll ON notifications(roll_number, is_read)`);

	console.log("  ✓ Schema ready\n");
}

async function migrate() {
	console.log("\n🚀 Starting migration: local.db → Supabase\n");
	console.log(`   DB: ${process.env.SUPABASE_DATABASE_URL?.replace(/:([^:@]+)@/, ":[HIDDEN]@")}\n`);

	// Create all tables first
	await createSchema();

	// ── 1. institutes ─────────────────────────────────────────────────────────
	if (tableExists("institutes")) {
		const rows = all("SELECT * FROM institutes");
		await batchInsert("institutes", rows, (r) => [
			`INSERT INTO institutes (id,code,name,logo_url,passcode_hash,teacher_passcode_hash,permissions_json,plan_expires_at,status,created_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING`,
			[r.id, r.code, r.name, r.logo_url || "", r.passcode_hash || "", r.teacher_passcode_hash || "",
			r.permissions_json || "{}", r.plan_expires_at || 0, r.status || "active", r.created_at || 0],
		]);
		// Reset sequence
		await pgRun("SELECT setval('institutes_id_seq', COALESCE((SELECT MAX(id) FROM institutes), 1))");
	}

	// ── 2. questions_v2 → split into questions + pyq_questions ───────────────
	if (tableExists("questions_v2")) {
		const rows = all("SELECT * FROM questions_v2");
		const bankRows = rows.filter((r) => !String(r.year || "").trim());
		const pyqRows = rows.filter((r) => !!String(r.year || "").trim());

		log(`  Splitting questions_v2: ${bankRows.length} bank + ${pyqRows.length} PYQ`);

		await batchInsert("questions (bank)", bankRows, (r) => [
			`INSERT INTO questions (id,subject,unit,chapter,topic,question_type,raw_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
			[r.id, r.subject || "", r.unit || "", r.chapter || "", r.topic || "", normalizeQType(r.question_type),
			r.raw_json || "{}", r.created_at || 0, r.updated_at || 0],
		]);
		await pgRun("SELECT setval('questions_id_seq', COALESCE((SELECT MAX(id) FROM questions), 1))");

		await batchInsert("pyq_questions", pyqRows, (r) => [
			`INSERT INTO pyq_questions (id,subject,unit,chapter,topic,question_type,year,month,day,shift,question_number,raw_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
			[r.id, r.subject || "", r.unit || "", r.chapter || "", r.topic || "", normalizeQType(r.question_type),
			String(r.year || ""), String(r.month || ""), String(r.day || ""), String(r.shift || ""),
			r.question_number || null, r.raw_json || "{}", r.created_at || 0, r.updated_at || 0],
		]);
		await pgRun("SELECT setval('pyq_questions_id_seq', COALESCE((SELECT MAX(id) FROM pyq_questions), 1))");
	}

	// ── 3. students ───────────────────────────────────────────────────────────
	if (tableExists("students")) {
		const rows = all("SELECT * FROM students");
		await batchInsert("students", rows, (r) => [
			`INSERT INTO students (id,mobile,lecture,name,place,class_name,chapter,answers_json,correct_count,total_questions,time,cheat_flag,institute_id)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mobile,lecture) DO NOTHING`,
			[r.id, r.mobile, r.lecture, r.name || "", r.place || "", r.class_name || "", r.chapter || null,
			r.answers_json || "[]", r.correct_count || 0, r.total_questions || 0, r.time || 0, r.cheat_flag || 0, r.institute_id || null],
		]);
		await pgRun("SELECT setval('students_id_seq', COALESCE((SELECT MAX(id) FROM students), 1))");
	}

	// ── 4. attempts ───────────────────────────────────────────────────────────
	if (tableExists("attempts")) {
		const rows = all("SELECT * FROM attempts");
		await batchInsert("attempts", rows, (r) => [
			`INSERT INTO attempts (id,mobile,chapter,lecture,time,institute_id) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
			[r.id, r.mobile, r.chapter || null, r.lecture, r.time || 0, r.institute_id || null],
		]);
		await pgRun("SELECT setval('attempts_id_seq', COALESCE((SELECT MAX(id) FROM attempts), 1))");
	}

	// ── 5. registered_students ────────────────────────────────────────────────
	if (tableExists("registered_students")) {
		const rows = all("SELECT * FROM registered_students");
		await batchInsert("registered_students", rows, (r) => [
			`INSERT INTO registered_students (id,roll_number,name,class_name,phone,age,date_of_birth,profile_complete,created_at,updated_at,password_hash,institute_id,batch_id)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(roll_number,institute_id) DO NOTHING`,
			[r.id, r.roll_number, r.name || "", r.class_name || "", r.phone || "", r.age || "",
			r.date_of_birth || "", r.profile_complete || 0, r.created_at || 0, r.updated_at || 0,
			r.password_hash || null, r.institute_id || null, r.batch_id || null],
		]);
		await pgRun("SELECT setval('registered_students_id_seq', COALESCE((SELECT MAX(id) FROM registered_students), 1))");
	}

	// ── 6. student_requests ───────────────────────────────────────────────────
	if (tableExists("student_requests")) {
		const rows = all("SELECT * FROM student_requests");
		await batchInsert("student_requests", rows, (r) => [
			`INSERT INTO student_requests (id,roll_number,name,class_name,phone,age,date_of_birth,requested_at,institute_id)
			 VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(roll_number,institute_id) DO NOTHING`,
			[r.id, r.roll_number, r.name || "", r.class_name || "", r.phone || "",
			r.age || "", r.date_of_birth || "", r.requested_at || 0, r.institute_id || null],
		]);
		await pgRun("SELECT setval('student_requests_id_seq', COALESCE((SELECT MAX(id) FROM student_requests), 1))");
	}

	// ── 7. student_sessions ───────────────────────────────────────────────────
	if (tableExists("student_sessions")) {
		const rows = all("SELECT * FROM student_sessions");
		await batchInsert("student_sessions", rows, (r) => [
			`INSERT INTO student_sessions (token,roll_number,institute_id,expires) VALUES (?,?,?,?) ON CONFLICT(token) DO NOTHING`,
			[r.token, r.roll_number, r.institute_id || null, r.expires || 0],
		]);
	}

	// ── 8. sessions ───────────────────────────────────────────────────────────
	if (tableExists("sessions")) {
		const rows = all("SELECT * FROM sessions WHERE expires > ?", [Date.now()]);
		await batchInsert("sessions", rows, (r) => [
			`INSERT INTO sessions (sid,data,expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET data=EXCLUDED.data,expires=EXCLUDED.expires`,
			[r.sid, r.data || "{}", r.expires || 0],
		]);
	}

	// ── 9. test_history ───────────────────────────────────────────────────────
	if (tableExists("test_history")) {
		const rows = all("SELECT * FROM test_history ORDER BY id");
		await batchInsert("test_history", rows, (r) => [
			`INSERT INTO test_history (id,mobile,chapter,lecture,topic,correct_count,wrong_count,skipped_count,total_questions,marks_score,max_marks,accuracy_pct,grade,time_taken,scheme,timestamp,student_name,student_class,answers_json,questions_json,online_test_id,is_locked,institute_id,time_spent_json)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
			[r.id, r.mobile || "", r.chapter || null, r.lecture || "", r.topic || "",
			r.correct_count || 0, r.wrong_count || 0, r.skipped_count || 0, r.total_questions || 0,
			r.marks_score || 0, r.max_marks || 0, r.accuracy_pct || 0, r.grade || "",
			r.time_taken || 0, r.scheme || "+1/0", r.timestamp || 0, r.student_name || "",
			r.student_class || "", r.answers_json || "[]", r.questions_json || "[]",
			r.online_test_id || null, r.is_locked || 0, r.institute_id || null,
			r.time_spent_json || "[]"],
		]);
		await pgRun("SELECT setval('test_history_id_seq', COALESCE((SELECT MAX(id) FROM test_history), 1))");
	}

	// ── 10. student_stats ─────────────────────────────────────────────────────
	if (tableExists("student_stats")) {
		const rows = all("SELECT * FROM student_stats");
		await batchInsert("student_stats", rows, (r) => [
			`INSERT INTO student_stats (mobile,tests_completed,avg_pct,day_streak,last_test,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(mobile) DO UPDATE SET tests_completed=EXCLUDED.tests_completed,avg_pct=EXCLUDED.avg_pct,day_streak=EXCLUDED.day_streak,last_test=EXCLUDED.last_test,updated_at=EXCLUDED.updated_at`,
			[r.mobile, r.tests_completed || 0, r.avg_pct || 0, r.day_streak || 0, r.last_test || 0, r.updated_at || 0],
		]);
	}

	// ── 11. online_tests ──────────────────────────────────────────────────────
	if (tableExists("online_tests")) {
		const rows = all("SELECT * FROM online_tests ORDER BY id");
		await batchInsert("online_tests", rows, (r) => [
			`INSERT INTO online_tests (id,test_name,questions_json,question_keys_json,marks_correct,marks_wrong,live_at,ends_at,assigned_rolls,created_at,duration_minutes,question_count,max_attempts,is_strict,include_pyq,institute_id)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
			[r.id, r.test_name || "Online Test", r.questions_json || "[]", r.question_keys_json || "[]",
			r.marks_correct || 4, r.marks_wrong || (-1), r.live_at || 0, r.ends_at || 0,
			r.assigned_rolls || "[]", r.created_at || 0, r.duration_minutes || 90,
			r.question_count || 0, r.max_attempts || 1, r.is_strict || 0, true, r.institute_id || null],
		]);
		await pgRun("SELECT setval('online_tests_id_seq', COALESCE((SELECT MAX(id) FROM online_tests), 1))");
	}

	// ── 12. star_quiz_questions ───────────────────────────────────────────────
	if (tableExists("star_quiz_questions")) {
		const rows = all("SELECT * FROM star_quiz_questions ORDER BY id");
		await batchInsert("star_quiz_questions", rows, (r) => [
			`INSERT INTO star_quiz_questions (id,chapter,lecture,topic,questions_json,updated_at,access_code) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
			[r.id, r.chapter || "", r.lecture || "", r.topic || "", r.questions_json || "[]", r.updated_at || 0, r.access_code || null],
		]);
		await pgRun("SELECT setval('star_quiz_questions_id_seq', COALESCE((SELECT MAX(id) FROM star_quiz_questions), 1))");
	}

	// ── 13. paper_templates ───────────────────────────────────────────────────
	if (tableExists("paper_templates")) {
		const rows = all("SELECT * FROM paper_templates ORDER BY id");
		await batchInsert("paper_templates", rows, (r) => [
			`INSERT INTO paper_templates (id,name,docx_base64,created_at,institute_id) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`,
			[r.id, r.name || "", r.docx_base64 || "", r.created_at || 0, r.institute_id || null],
		]);
		await pgRun("SELECT setval('paper_templates_id_seq', COALESCE((SELECT MAX(id) FROM paper_templates), 1))");
	}

	// ── 14. classes ───────────────────────────────────────────────────────────
	if (tableExists("classes")) {
		const rows = all("SELECT * FROM classes ORDER BY id");
		await batchInsert("classes", rows, (r) => [
			`INSERT INTO classes (id,name,institute_id,created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`,
			[r.id, r.name || "", r.institute_id || null, r.created_at || 0],
		]);
		await pgRun("SELECT setval('classes_id_seq', COALESCE((SELECT MAX(id) FROM classes), 1))");
	}

	// ── 15. batches ───────────────────────────────────────────────────────────
	if (tableExists("batches")) {
		const rows = all("SELECT * FROM batches ORDER BY id");
		await batchInsert("batches", rows, (r) => [
			`INSERT INTO batches (id,name,class_id,institute_id,created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`,
			[r.id, r.name || "", r.class_id || 0, r.institute_id || null, r.created_at || 0],
		]);
		await pgRun("SELECT setval('batches_id_seq', COALESCE((SELECT MAX(id) FROM batches), 1))");
	}

	// ── 16. attendance ────────────────────────────────────────────────────────
	if (tableExists("attendance")) {
		const rows = all("SELECT * FROM attendance ORDER BY id");
		await batchInsert("attendance", rows, (r) => [
			`INSERT INTO attendance (id,class_id,batch_id,roll_number,date,status,institute_id,marked_by,marked_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
			[r.id, r.class_id || 0, r.batch_id || null, r.roll_number || "", r.date || "",
			r.status || "present", r.institute_id || null, r.marked_by || "", r.marked_at || 0],
		]);
		await pgRun("SELECT setval('attendance_id_seq', COALESCE((SELECT MAX(id) FROM attendance), 1))");
	}

	// ── 17. notifications ─────────────────────────────────────────────────────
	if (tableExists("notifications")) {
		const rows = all("SELECT * FROM notifications ORDER BY id");
		await batchInsert("notifications", rows, (r) => [
			`INSERT INTO notifications (id,roll_number,message,type,is_read,institute_id,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
			[r.id, r.roll_number || "", r.message || "", r.type || "attendance", r.is_read || 0, r.institute_id || null, r.created_at || 0],
		]);
		await pgRun("SELECT setval('notifications_id_seq', COALESCE((SELECT MAX(id) FROM notifications), 1))");
	}

	// ─────────────────────────────────────────────────────────────────────────
	console.log(`\n\n✅ Migration complete! Total rows inserted: ${totalInserted}`);
	console.log("   Run: node server.js   to start the server on Supabase.\n");
}

migrate().catch((err) => {
	console.error("\n\n❌ Migration failed:", err.message, err.stack);
	process.exit(1);
}).finally(() => {
	if (sqlite) sqlite.close();
	pool.end();
});

