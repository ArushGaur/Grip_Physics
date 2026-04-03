const express = require("express");
const cors = require("cors");
const session = require("express-session");
const crypto = require("crypto");
const { createClient } = require("@libsql/client");
const cloudinary = require("cloudinary").v2;

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);

const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "dev-admin-passcode-please-change";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret-minimum-32-chars";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

if (ADMIN_PASSCODE === "dev-admin-passcode-please-change") {
	console.warn("[WARN] ADMIN_PASSCODE env var missing. Using development fallback.");
}
if (SESSION_SECRET === "dev-session-secret-minimum-32-chars") {
	console.warn("[WARN] SESSION_SECRET env var missing. Using development fallback.");
}

const db = createClient({
	url: process.env.TURSO_DATABASE_URL,
	authToken: process.env.TURSO_AUTH_TOKEN,
});

cloudinary.config({
	cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
	api_key: process.env.CLOUDINARY_API_KEY,
	api_secret: process.env.CLOUDINARY_API_SECRET,
});

let questionCache = {};

function clamp(n, min, max) {
	return Math.max(min, Math.min(max, n));
}

function getMime(b64) {
	if (String(b64 || "").startsWith("/9j/")) return "image/jpeg";
	if (String(b64 || "").startsWith("iVBORw")) return "image/png";
	if (String(b64 || "").startsWith("R0lGOD")) return "image/gif";
	return "image/jpeg";
}

function toImgPart(b64) {
	return {
		type: "image_url",
		image_url: { url: `data:${getMime(b64)};base64,${b64}` },
	};
}

function cleanJson(txt) {
	return String(txt || "")
		.replace(/```json\s*/gi, "")
		.replace(/```/g, "")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/\u00A0/g, " ")
		.replace(/\r\n?/g, "\n")
		.trim();
}

function tryParse(txt) {
	try {
		return JSON.parse(txt);
	} catch {
		try {
			return JSON.parse(String(txt).replace(/,(\s*[}\]])/g, "$1"));
		} catch {
			return null;
		}
	}
}

function parseJsonArray(raw) {
	const text = cleanJson(raw);
	const direct = tryParse(text);
	if (Array.isArray(direct)) return direct;
	if (direct && Array.isArray(direct.questions)) return direct.questions;

	const s = text.indexOf("[");
	const e = text.lastIndexOf("]");
	if (s !== -1 && e > s) {
		const sliced = tryParse(text.slice(s, e + 1));
		if (Array.isArray(sliced)) return sliced;
	}

	const objs = text.match(/\{[\s\S]*?\}/g) || [];
	const recovered = objs
		.map((x) => tryParse(x))
		.filter((x) => x && typeof x === "object" && !Array.isArray(x));
	return recovered.length ? recovered : null;
}

function normalizeMath(s) {
	let out = String(s || "").trim();
	if (!out) return out;
	out = out.replace(/\\\(([^]*?)\\\)/g, (_, m) => `$${m}$`);
	out = out.replace(/\\\[([^]*?)\\\]/g, (_, m) => `$$${m}$$`);
	const dollarCount = (out.match(/(?<!\\)\$/g) || []).length;
	if (dollarCount % 2 === 1) out += "$";
	// If text looks like an equation but isn't wrapped in $ delimiters, wrap it
	if (looksLikeEquation(out) && !out.includes("$")) {
		out = `$${out}$`;
	}
	return out;
}

function looksLikeEquation(s) {
	const t = String(s || "").trim();
	if (!t) return false;
	if (/\$[^$]+\$/.test(t)) return true;
	if (/\\(frac|sqrt|sum|int|pi|theta|alpha|beta|gamma|sin|cos|tan|log|ln)\b/i.test(t)) return true;
	if (/(^|\s)[a-zA-Z][a-zA-Z0-9]*\s*(=|>=|<=|>|<|\+|\-|\*|\/|\^|≈|∝)\s*[-+]?\d|\b\d+\s*(m\/s|m\/s\^2|kg|N|J|W|Hz|ohm|V|A)\b/i.test(t)) return true;
	if (/\b(sin|cos|tan|log|ln)\s*\(/i.test(t)) return true;
	return false;
}

function parseCorrectIndexesFromQuestion(q) {
	let ci = Array.isArray(q.correctIndexes) ? [...q.correctIndexes] : [];
	if (!ci.length && typeof q.correctIndex === "number") ci = [q.correctIndex];
	if (!ci.length) {
		const hint = String(q.correctAnswer || q.answer || q.correct || "").trim();
		const letters = hint.match(/\b([A-Da-d])\b/g) || [];
		ci = [...new Set(letters.map((l) => "abcd".indexOf(l.toLowerCase())))].filter((n) => n >= 0);
	}
	ci = [...new Set(ci.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n < 4))];
	if (!ci.length) ci = [0];
	return ci;
}

function validateImageRegion(r) {
	if (!r || typeof r.x !== "number" || typeof r.y !== "number" || typeof r.w !== "number" || typeof r.h !== "number") {
		return null;
	}
	if (r.w < 0.01 || r.h < 0.01) return null;
	const x = clamp(r.x, 0, 0.99);
	const y = clamp(r.y, 0, 0.99);
	const w = clamp(r.w, 0.01, 1 - x);
	const h = clamp(r.h, 0.01, 1 - y);
	return { x, y, w, h };
}

function normalizeQuestion(q) {
	const normQuestion = normalizeMath(String(q?.question || ""));
	const normOptions = [...(Array.isArray(q?.options) ? q.options : []), "", "", ""].slice(0, 4).map((x) => normalizeMath(String(x || "")));
	const hasEquation = looksLikeEquation(normQuestion) || normOptions.some((o) => looksLikeEquation(o));

	const out = {
		question: normQuestion,
		options: normOptions,
		questionImage: q?.questionImage || null,
		optionImages: Array.isArray(q?.optionImages) ? q.optionImages : [],
		hasImage: !!q?.hasImage,
		hasEquation,
		imageRegion: validateImageRegion(q?.imageRegion),
	};

	const ci = parseCorrectIndexesFromQuestion(q || {});
	out.correctIndexes = ci;
	out.isMultiCorrect = ci.length > 1;

	if (Number.isInteger(q?.imageSourceIndex)) {
		out.imageSourceIndex = q.imageSourceIndex;
	}

	return out;
}

function normalizeQuestionRow(row) {
	if (!row) return null;
	let parsed = [];
	try {
		parsed = JSON.parse(row.questions_json || "[]");
	} catch {
		parsed = [];
	}

	return {
		_id: row.id,
		chapter: row.chapter || null,
		lecture: row.lecture,
		topic: row.topic || "",
		updatedAt: row.updated_at || 0,
		questions: Array.isArray(parsed) ? parsed.map(normalizeQuestion) : [],
	};
}

function normalizeStudentRow(row) {
	let answers = [];
	try {
		answers = JSON.parse(row.answers_json || "[]");
	} catch {
		answers = [];
	}
	return {
		_id: row.id,
		mobile: row.mobile,
		lecture: row.lecture,
		name: row.name,
		place: row.place,
		className: row.class_name,
		chapter: row.chapter || null,
		answers,
		correctCount: row.correct_count || 0,
		totalQuestions: row.total_questions || 0,
		time: row.time || 0,
	};
}

function isCorrect(qItem, ans) {
	if (!qItem) return false;
	const cor = Array.isArray(qItem.correctIndexes) && qItem.correctIndexes.length ? qItem.correctIndexes : [0];
	if (qItem.isMultiCorrect || cor.length > 1) {
		const selected = Array.isArray(ans) ? [...ans].sort((a, b) => a - b) : [ans];
		const expected = [...cor].sort((a, b) => a - b);
		return JSON.stringify(selected) === JSON.stringify(expected);
	}
	return ans === cor[0];
}

async function uploadImageToCloudinary(base64String) {
	if (!base64String) return null;
	if (String(base64String).startsWith("http://") || String(base64String).startsWith("https://")) return base64String;
	if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
		return base64String;
	}

	try {
		const dataUri = String(base64String).startsWith("data:")
			? base64String
			: `data:${getMime(base64String)};base64,${base64String}`;
		const uploaded = await cloudinary.uploader.upload(dataUri, { folder: "grip_physics" });
		return uploaded.secure_url;
	} catch (e) {
		console.warn("Cloudinary upload failed, storing base64 instead:", e.message);
		return base64String;
	}
}

async function uploadQuestionImages(questions) {
	return Promise.all(
		questions.map(async (q) => {
			const next = { ...q };
			if (next.questionImage) next.questionImage = await uploadImageToCloudinary(next.questionImage);
			if (Array.isArray(next.optionImages)) {
				next.optionImages = await Promise.all(next.optionImages.map((img) => uploadImageToCloudinary(img)));
			}
			return next;
		})
	);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRetrySeconds(msg) {
	const m = String(msg || "").match(/try again in\s*([0-9.]+)s/i);
	if (!m) return null;
	const n = parseFloat(m[1]);
	return Number.isFinite(n) && n > 0 ? n : null;
}

async function callGroq(parts, systemPrompt, userPrompt, maxTokens = 2600, temperature = 0.1) {
	if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set on server");
	const maxAttempts = 4;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${GROQ_API_KEY}`,
			},
			body: JSON.stringify({
				model: "meta-llama/llama-4-scout-17b-16e-instruct",
				max_tokens: maxTokens,
				temperature,
				messages: [
					{ role: "system", content: systemPrompt },
					{
						role: "user",
						content: [...(Array.isArray(parts) ? parts : []), { type: "text", text: userPrompt }],
					},
				],
			}),
		});

		if (r.ok) {
			const data = await r.json();
			return String(data?.choices?.[0]?.message?.content || "").trim();
		}

		const err = await r.json().catch(() => ({}));
		const msg = err?.error?.message || `Groq HTTP ${r.status}`;
		const retryAfterHeader = Number(r.headers.get("retry-after"));
		const retryAfterMsg = extractRetrySeconds(msg);
		const isRateLimit = r.status === 429 || /rate limit|TPM|try again/i.test(msg);

		if (isRateLimit && attempt < maxAttempts) {
			const waitSec = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
				? retryAfterHeader
				: (retryAfterMsg || Math.min(2 * attempt, 8));
			const waitMs = Math.ceil(waitSec * 1000 + 250);
			console.warn(`[groq] rate-limited, retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
			await sleep(waitMs);
			continue;
		}

		throw new Error(msg);
	}

	throw new Error("Groq request failed after retries");
}

async function initDB() {
	await db.executeMultiple(`
		CREATE TABLE IF NOT EXISTS questions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			chapter TEXT,
			lecture TEXT NOT NULL,
			topic TEXT DEFAULT '',
			questions_json TEXT NOT NULL DEFAULT '[]',
			updated_at INTEGER DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_questions_chapter_lecture ON questions(chapter, lecture);
		CREATE INDEX IF NOT EXISTS idx_questions_lecture ON questions(lecture);

		CREATE TABLE IF NOT EXISTS students (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			mobile TEXT NOT NULL,
			lecture TEXT NOT NULL,
			name TEXT,
			place TEXT,
			class_name TEXT,
			chapter TEXT,
			answers_json TEXT DEFAULT '[]',
			correct_count INTEGER DEFAULT 0,
			total_questions INTEGER DEFAULT 0,
			time INTEGER DEFAULT 0,
			UNIQUE(mobile, lecture)
		);
		CREATE INDEX IF NOT EXISTS idx_students_mobile_lecture ON students(mobile, lecture);

		CREATE TABLE IF NOT EXISTS attempts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			mobile TEXT NOT NULL,
			chapter TEXT,
			lecture TEXT NOT NULL,
			time INTEGER DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_attempts_mobile_lecture ON attempts(mobile, lecture);

		CREATE TABLE IF NOT EXISTS sessions (
			sid TEXT PRIMARY KEY,
			data TEXT NOT NULL,
			expires INTEGER NOT NULL
		);
	`);
	console.log("Turso DB initialized");
}

class TursoSessionStore extends session.Store {
	async get(sid, cb) {
		try {
			const result = await db.execute({ sql: "SELECT data, expires FROM sessions WHERE sid = ?", args: [sid] });
			if (!result.rows.length) return cb(null, null);
			const row = result.rows[0];
			if (Date.now() > row.expires) {
				await db.execute({ sql: "DELETE FROM sessions WHERE sid = ?", args: [sid] });
				return cb(null, null);
			}
			cb(null, JSON.parse(row.data));
		} catch (e) {
			cb(e);
		}
	}

	async set(sid, sess, cb) {
		try {
			const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 8 * 60 * 60 * 1000;
			await db.execute({
				sql: `INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
					  ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`,
				args: [sid, JSON.stringify(sess), expires],
			});
			cb(null);
		} catch (e) {
			cb(e);
		}
	}

	async destroy(sid, cb) {
		try {
			await db.execute({ sql: "DELETE FROM sessions WHERE sid = ?", args: [sid] });
			cb(null);
		} catch (e) {
			cb(e);
		}
	}
}

const allowedOrigins = [
	"https://grip-physics.onrender.com",
	"https://grip-physics.vercel.app",
	"http://localhost:3000",
	"http://localhost:8080",
	"http://127.0.0.1:3000",
	"http://127.0.0.1:8080",
];

app.use(cors({
	origin: (origin, cb) => {
		if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
		return cb(null, false);
	},
	credentials: true,
	methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
	allowedHeaders: ["Content-Type", "Authorization"],
	exposedHeaders: ["set-cookie"],
	maxAge: 86400,
}));

app.use(express.json({ limit: "25mb" }));

app.use(session({
	secret: SESSION_SECRET,
	resave: false,
	saveUninitialized: false,
	proxy: true,
	name: "grip.sid",
	store: new TursoSessionStore(),
	cookie: {
		secure: process.env.NODE_ENV === "production",
		sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
		httpOnly: true,
		maxAge: 8 * 60 * 60 * 1000,
	},
}));

app.use((req, res, next) => {
	console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("X-XSS-Protection", "1; mode=block");
	res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
	next();
});

const rateLimitMap = new Map();
const loginFailMap = new Map();

function rateLimit(windowMs, max) {
	return (req, res, next) => {
		const key = `${req.ip}:${req.path}`;
		const now = Date.now();
		const arr = (rateLimitMap.get(key) || []).filter((t) => t > now - windowMs);
		arr.push(now);
		rateLimitMap.set(key, arr);
		if (arr.length > max) {
			return res.status(429).json({ error: "Too many requests. Try again later." });
		}
		next();
	};
}

function loginRateLimit(req, res, next) {
	const ip = req.ip;
	const now = Date.now();
	const WINDOW = 15 * 60 * 1000;
	const LOCKOUT = 60 * 60 * 1000;
	const MAX = 5;

	const entries = (loginFailMap.get(ip) || []).filter((t) => t > now - LOCKOUT);
	loginFailMap.set(ip, entries);

	const recent = entries.filter((t) => t > now - WINDOW);
	if (recent.length >= MAX) {
		const oldest = recent[0] || now;
		const waitMin = Math.ceil((oldest + LOCKOUT - now) / 60000);
		return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.max(waitMin, 1)} minute(s).` });
	}
	next();
}

function recordLoginFailure(ip) {
	const arr = loginFailMap.get(ip) || [];
	arr.push(Date.now());
	loginFailMap.set(ip, arr);
}

function safeCompare(a, b) {
	try {
		const ba = Buffer.from(String(a));
		const bb = Buffer.from(String(b));
		if (ba.length !== bb.length) {
			crypto.timingSafeEqual(ba, ba);
			return false;
		}
		return crypto.timingSafeEqual(ba, bb);
	} catch {
		return false;
	}
}

function requireAdmin(req, res, next) {
	if (!req.session?.admin) return res.status(403).json({ error: "Unauthorized" });
	next();
}

async function loadQuestions() {
	const result = await db.execute("SELECT * FROM questions");
	questionCache = {};
	for (const row of result.rows) {
		const n = normalizeQuestionRow(row);
		if (n && Array.isArray(n.questions)) {
			questionCache[`${n.chapter || ""}::${n.lecture}`] = n;
		}
	}
	console.log(`Loaded ${Object.keys(questionCache).length} question sets into cache`);
}

async function refreshCache(chapter, lecture) {
	let result;
	if (chapter) {
		result = await db.execute({ sql: "SELECT * FROM questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
	} else {
		result = await db.execute({ sql: "SELECT * FROM questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1", args: [lecture] });
	}

	if (!result.rows.length) {
		delete questionCache[`${chapter || ""}::${lecture}`];
		return;
	}

	const n = normalizeQuestionRow(result.rows[0]);
	questionCache[`${chapter || ""}::${lecture}`] = n;
}

async function findQuestion(chapter, lecture) {
	const key = `${chapter || ""}::${lecture}`;
	if (questionCache[key]) return questionCache[key];

	let result;
	if (chapter) {
		result = await db.execute({ sql: "SELECT * FROM questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
	} else {
		result = await db.execute({ sql: "SELECT * FROM questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1", args: [lecture] });
	}

	if (!result.rows.length) return null;
	const n = normalizeQuestionRow(result.rows[0]);
	questionCache[key] = n;
	return n;
}

setInterval(() => {
	const cutoff = Date.now() - 60 * 60 * 1000;
	for (const [k, v] of rateLimitMap.entries()) {
		const kept = v.filter((t) => t > cutoff);
		if (!kept.length) rateLimitMap.delete(k);
		else rateLimitMap.set(k, kept);
	}
	for (const [k, v] of loginFailMap.entries()) {
		const kept = v.filter((t) => t > cutoff);
		if (!kept.length) loginFailMap.delete(k);
		else loginFailMap.set(k, kept);
	}
	db.execute({ sql: "DELETE FROM sessions WHERE expires < ?", args: [Date.now()] }).catch(() => {});
}, 10 * 60 * 1000);

app.post("/api/admin/login", loginRateLimit, (req, res) => {
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

app.post("/api/admin/logout", (req, res) => {
	req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/chapters", async (req, res) => {
	try {
		const result = await db.execute("SELECT DISTINCT chapter FROM questions WHERE chapter IS NOT NULL AND chapter != ''");
		const chapters = result.rows.map((r) => r.chapter).filter(Boolean).sort();
		res.json(chapters);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.get("/api/lectures/:chapter", async (req, res) => {
	try {
		const chapter = req.params.chapter;
		const result = await db.execute({ sql: "SELECT lecture FROM questions WHERE chapter = ?", args: [chapter] });
		const lectures = result.rows.map((r) => r.lecture).filter(Boolean).sort((a, b) => Number(a) - Number(b));
		res.json(lectures);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.get("/api/question/:chapter/:lecture", async (req, res) => {
	try {
		const q = await findQuestion(req.params.chapter, req.params.lecture);
		if (!q) return res.status(404).json({ error: "Lecture not found" });
		res.json(q);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.post("/api/check-attempt", async (req, res) => {
	try {
		const { mobile, chapter, lecture } = req.body || {};
		if (!mobile || !lecture) return res.status(400).json({ error: "Missing" });

		const q = await findQuestion(chapter, lecture);
		if (!q) return res.json({ allowed: false, time: 0 });

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

app.post("/api/student-register", async (req, res) => {
	try {
		const { name, mobile, place, className, chapter, lecture } = req.body || {};
		if (!name || !mobile || !lecture) return res.status(400).json({ error: "Missing" });

		await db.execute({
			sql: `INSERT INTO students (mobile, lecture, name, place, class_name, chapter, time)
				  VALUES (?, ?, ?, ?, ?, ?, ?)
				  ON CONFLICT(mobile, lecture) DO UPDATE SET
					name=excluded.name, place=excluded.place, class_name=excluded.class_name,
					chapter=excluded.chapter, time=excluded.time`,
			args: [mobile, lecture, name, place || "", className || "", chapter || null, Date.now()],
		});

		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.post("/api/submit-attempt", rateLimit(60 * 1000, 5), async (req, res) => {
	try {
		const { mobile, chapter, lecture, selectedAnswers, askedQuestionIndexes, name, place, className } = req.body || {};
		if (!mobile || !lecture) return res.status(400).json({ error: "Missing" });

		const q = await findQuestion(chapter, lecture);
		if (!q) return res.status(404).json({ error: "Not found" });

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
		await db.execute({
			sql: "INSERT INTO attempts (mobile, chapter, lecture, time) VALUES (?, ?, ?, ?)",
			args: [mobile, chapter || null, lecture, now],
		});

		await db.execute({
			sql: `INSERT INTO students (mobile, lecture, name, place, class_name, chapter, answers_json, correct_count, total_questions, time)
				  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				  ON CONFLICT(mobile, lecture) DO UPDATE SET
					name=excluded.name, place=excluded.place, class_name=excluded.class_name,
					chapter=excluded.chapter, answers_json=excluded.answers_json,
					correct_count=excluded.correct_count, total_questions=excluded.total_questions, time=excluded.time`,
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
			],
		});

		res.json({ success: true, correctCount, totalQuestions: questionsForScoring.length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.post("/api/admin/add-question", requireAdmin, async (req, res) => {
	try {
		let { chapter, lecture, topic, questions, replace } = req.body || {};
		if (!lecture || !Array.isArray(questions) || !questions.length) {
			return res.status(400).json({ error: "Missing" });
		}

		questions = questions.map(normalizeQuestion);
		questions = await uploadQuestionImages(questions);

		let existing;
		if (chapter) {
			const r = await db.execute({ sql: "SELECT * FROM questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
			existing = r.rows[0] || null;
		} else {
			const r = await db.execute({ sql: "SELECT * FROM questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1", args: [lecture] });
			existing = r.rows[0] || null;
		}

		if (existing) {
			const oldQs = replace ? [] : (() => {
				try { return JSON.parse(existing.questions_json || "[]"); } catch { return []; }
			})();
			const merged = [...oldQs, ...questions];
			await db.execute({
				sql: "UPDATE questions SET questions_json = ?, topic = ?, updated_at = ? WHERE id = ?",
				args: [JSON.stringify(merged), topic || existing.topic || "", Date.now(), existing.id],
			});
			await refreshCache(chapter || null, lecture);
			return res.json({ success: true, added: questions.length, total: merged.length });
		}

		await db.execute({
			sql: "INSERT INTO questions (chapter, lecture, topic, questions_json, updated_at) VALUES (?, ?, ?, ?, ?)",
			args: [chapter || null, lecture, topic || "", JSON.stringify(questions), Date.now()],
		});
		await refreshCache(chapter || null, lecture);
		res.json({ success: true, added: questions.length, total: questions.length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.get("/api/admin/students", requireAdmin, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM students ORDER BY time DESC");
		res.json(result.rows.map(normalizeStudentRow));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.get("/api/admin/questions", requireAdmin, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM questions");
		res.json(result.rows.map(normalizeQuestionRow));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.delete("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		const lecture = decodeURIComponent(req.params.lecture || "");
		await db.execute({
			sql: "DELETE FROM questions WHERE lecture = ? AND (chapter = ? OR chapter IS NULL OR chapter = '')",
			args: [lecture, chapter === "_none_" ? null : chapter],
		});
		delete questionCache[`${chapter === "_none_" ? "" : chapter}::${lecture}`];
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.put("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
	try {
		const rawChapter = decodeURIComponent(req.params.chapter || "");
		const lecture = decodeURIComponent(req.params.lecture || "");
		const { chapter, topic, questions } = req.body || {};

		if (!lecture) return res.status(400).json({ error: "Lecture is required." });
		if (!Array.isArray(questions)) return res.status(400).json({ error: "Questions array is required." });

		const chapterForMatch = (rawChapter === "_none_" || rawChapter === "") ? null : rawChapter;
		const chapterForSave = (chapter === "_none_" || chapter === "") ? null : (chapter ?? chapterForMatch);

		let existing;
		if (chapterForMatch) {
			const r = await db.execute({ sql: "SELECT * FROM questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapterForMatch, lecture] });
			existing = r.rows[0] || null;
		} else {
			const r = await db.execute({ sql: "SELECT * FROM questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1", args: [lecture] });
			existing = r.rows[0] || null;
		}

		if (!existing) return res.status(404).json({ error: "Lecture not found." });

		const normalizedQuestions = questions.map(normalizeQuestion);
		await db.execute({
			sql: "UPDATE questions SET chapter = ?, topic = ?, questions_json = ?, updated_at = ? WHERE id = ?",
			args: [chapterForSave, topic || existing.topic || "", JSON.stringify(normalizedQuestions), Date.now(), existing.id],
		});

		await refreshCache(chapterForSave, lecture);
		res.json({ success: true, updated: normalizedQuestions.length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.post("/api/admin/mass-delete", requireAdmin, async (req, res) => {
	try {
		const items = Array.isArray(req.body?.items) ? req.body.items : [];
		if (!items.length) return res.status(400).json({ error: "No items" });
		let deleted = 0;
		for (const it of items) {
			const chapter = it?.chapter || null;
			const lecture = it?.lecture;
			if (!lecture) continue;
			await db.execute({
				sql: "DELETE FROM questions WHERE lecture = ? AND (chapter = ? OR chapter IS NULL OR chapter = '')",
				args: [lecture, chapter],
			});
			delete questionCache[`${chapter || ""}::${lecture}`];
			deleted++;
		}
		res.json({ success: true, deleted });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.post("/api/admin/rename-chapter", requireAdmin, async (req, res) => {
	try {
		const { oldName, newName } = req.body || {};
		if (!oldName || !newName) return res.status(400).json({ error: "Missing old or new chapter name." });

		const qr = await db.execute({ sql: "UPDATE questions SET chapter = ? WHERE chapter = ?", args: [newName, oldName] });
		const sr = await db.execute({ sql: "UPDATE students SET chapter = ? WHERE chapter = ?", args: [newName, oldName] });
		const ar = await db.execute({ sql: "UPDATE attempts SET chapter = ? WHERE chapter = ?", args: [newName, oldName] });
		const total = (qr.rowsAffected || 0) + (sr.rowsAffected || 0) + (ar.rowsAffected || 0);
		if (!total) return res.status(404).json({ error: "Chapter not found." });

		await loadQuestions();
		res.json({
			success: true,
			updated: {
				questions: qr.rowsAffected || 0,
				students: sr.rowsAffected || 0,
				attempts: ar.rowsAffected || 0,
				total,
			},
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.post("/api/admin/rename-topic", requireAdmin, async (req, res) => {
	try {
		const { chapter, oldName, newName } = req.body || {};
		if (!oldName || !newName) return res.status(400).json({ error: "Missing old or new topic name." });
		let result;
		if (chapter) {
			result = await db.execute({ sql: "UPDATE questions SET topic = ? WHERE topic = ? AND chapter = ?", args: [newName, oldName, chapter] });
		} else {
			result = await db.execute({ sql: "UPDATE questions SET topic = ? WHERE topic = ?", args: [newName, oldName] });
		}
		if (!result.rowsAffected) return res.status(404).json({ error: "Topic not found." });
		await loadQuestions();
		res.json({ success: true, updated: result.rowsAffected });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.post("/api/admin/reload-cache", requireAdmin, async (req, res) => {
	try {
		await loadQuestions();
		res.json({ success: true, cached: Object.keys(questionCache).length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.get("/api/admin/migrate", requireAdmin, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM questions");
		const all = result.rows.map(normalizeQuestionRow);
		const corrupted = all.filter((x) => !Array.isArray(x.questions));
		res.json({
			total: all.length,
			corrupted: corrupted.length,
			corruptedLectures: corrupted.map((q) => ({ lecture: q.lecture, chapter: q.chapter, _id: q._id })),
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

app.post("/api/admin/migrate", requireAdmin, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM questions");
		const corruptedIds = result.rows
			.filter((row) => {
				try {
					const q = JSON.parse(row.questions_json || "[]");
					return !Array.isArray(q);
				} catch {
					return true;
				}
			})
			.map((row) => row.id);

		for (const id of corruptedIds) {
			await db.execute({ sql: "DELETE FROM questions WHERE id = ?", args: [id] });
		}

		await loadQuestions();
		res.json({
			success: true,
			deleted: corruptedIds.length,
			message: corruptedIds.length ? `Deleted ${corruptedIds.length} corrupted record(s).` : "No corrupted records found.",
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


/* ─────────────────────────────────────────────────────────────────────────────
   NEW POWERFUL EXTRACT ROUTE  v2
   ─────────────────────────────────────────────────────────────────────────────
   Architecture:
   1. PARALLEL primary extraction  – every image sent to Groq simultaneously
   2. COUNT VERIFICATION           – AI counts visible question numbers per image
   3. TARGETED RECOVERY            – only re-query images where count < expected
   4. CROSS-IMAGE BOUNDARY MERGE   – detect & stitch split questions at page edges
   5. ANSWER-KEY MERGE             – overlay correct answers from key image/text
   6. RICH DEDUP + NUMBER SORT     – eliminate duplicates, sort by question number
   7. FINAL NORMALISATION          – normalise math, fill empty options, validate
───────────────────────────────────────────────────────────────────────────── */
app.post("/api/admin/extract", requireAdmin, async (req, res) => {
	try {
		const { questionImages, answerImages, manualAnswerKey } = req.body || {};
		if (!Array.isArray(questionImages) || !questionImages.length) {
			return res.status(400).json({ error: "At least one question image required" });
		}
		if (!GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not set on server" });

		// ── SYSTEM PROMPTS ─────────────────────────────────────────────────────────
		const answerContext = manualAnswerKey?.trim()
			? `MANUAL ANSWER KEY PROVIDED:\n${manualAnswerKey.trim()}\nUse ONLY this to set correctIndexes.`
			: Array.isArray(answerImages) && answerImages.length
				? "Answer-key image(s) are appended. Use them to set correctIndexes precisely."
				: "No answer key — set correctIndexes:[0] as placeholder.";

		const EXTRACT_SYSTEM = `You are a physics MCQ extractor. Extract EVERY numbered question.
OUTPUT: ONLY a valid JSON array. Each element:
{"question":"...","options":["A","B","C","D"],"correctIndexes":[0],"isMultiCorrect":false,"hasImage":false,"imageRegion":null}
RULES:
1. COMPLETENESS — output array length must equal visible question count.
2. LAYOUT — two-column: left top→bottom, then right top→bottom.
3. OPTIONS — exactly 4 per question; fill missing with "".
4. MATH — all equations in $...$; preserve units, Greek symbols, fractions.
5. SPLITS — include partial questions, leave cut-off options as "".
6. IMAGES — hasImage:true if question references figure/graph. imageRegion:{x,y,w,h} in 0-1 fractions; else null.
7. MULTI — isMultiCorrect:true when multiple answers correct.
${answerContext}`;

		const COUNT_SYSTEM = `Count numbered MCQ questions in a physics screenshot. Return ONLY JSON: {"count":N,"numbers":[1,2,3,...]}`;

		const RECOVERY_SYSTEM = `Recover MISSED physics MCQ questions. Return ONLY JSON array of questions NOT already in the prior list. Return [] if nothing missed.`;

		const MERGE_SYSTEM = `Decide if a question is split across two consecutive screenshots. Return ONLY JSON.`;

		const ANSWER_OVERLAY_SYSTEM = `Read an answer key image. Return ONLY JSON array: [{"num":1,"correctIndexes":[2]},{"num":2,"correctIndexes":[0,3]},...]. A=0,B=1,C=2,D=3.`;

		const answerPartsForGroq = Array.isArray(answerImages) ? answerImages.slice(0, 2).map(toImgPart) : [];

		// ── HELPERS ──────────────────────────────────────────────────────────────────
		function keyOf(q) {
			const stem = String(q?.question || "").toLowerCase().replace(/\s+/g, " ").slice(0, 200);
			const opts = (Array.isArray(q?.options) ? q.options : []).map(x => String(x || "").toLowerCase().trim()).slice(0, 4).join("|");
			return `${stem}||${opts}`;
		}
		function getNum(q) {
			const m = String(q?.question || "").match(/^\s*(?:q\.?\s*)?(\d{1,3})\s*[\).:\u2013\-]/i);
			if (!m) return null;
			const n = parseInt(m[1], 10);
			return Number.isInteger(n) ? n : null;
		}
		function richness(q) {
			return String(q?.question || "").trim().length +
				(Array.isArray(q?.options) ? q.options : []).filter(o => String(o || "").trim()).length * 50;
		}
		function stemSig(q) {
			return String(q?.question || "").toLowerCase()
				.replace(/^\s*(?:q\.?\s*)?\d{1,3}\s*[\).:\u2013\-]?\s*/i, "")
				.replace(/\s+/g, " ").replace(/[^a-z0-9$\\\-+*/=() ]/g, "").trim();
		}
		function optionSet(q) {
			return new Set((Array.isArray(q?.options) ? q.options : [])
				.map(o => String(o || "").toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean));
		}
		function areNearDup(a, b) {
			const na = getNum(a), nb = getNum(b);
			if (na !== null && nb !== null && na !== nb) return false;
			const sa = stemSig(a), sb = stemSig(b);
			if (!sa || !sb || sa !== sb) return false;
			const oa = optionSet(a), ob = optionSet(b);
			if (!oa.size || !ob.size) return true;
			let overlap = 0;
			oa.forEach(x => { if (ob.has(x)) overlap++; });
			return overlap >= 3;
		}

		// ── STEP 1: PARALLEL PRIMARY EXTRACTION ─────────────────────────────────────
		console.log(`[extract-v2] Parallel extraction: ${questionImages.length} image(s)`);
		const primaryResults = await Promise.all(
			questionImages.map(async (imgB64, i) => {
				const parts = [toImgPart(imgB64), ...answerPartsForGroq];
				const raw = await callGroq(parts, EXTRACT_SYSTEM,
					"Extract every numbered MCQ. Return ONLY JSON array.", 3000, 0.05);
				const arr = parseJsonArray(raw) || [];
				console.log(`[extract-v2] Image ${i}: primary=${arr.length}`);
				return { imgB64, idx: i, arr };
			})
		);

		// ── STEP 2: PARALLEL COUNT VERIFICATION ─────────────────────────────────────
		const countResults = await Promise.all(
			questionImages.map(async (imgB64, i) => {
				const raw = await callGroq([toImgPart(imgB64)], COUNT_SYSTEM,
					'Count visible questions. Return JSON: {"count":N,"numbers":[...]}', 300, 0.0);
				const parsed = tryParse(cleanJson(raw)) || {};
				const count = parseInt(parsed.count) || 0;
				const numbers = Array.isArray(parsed.numbers)
					? parsed.numbers.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
				console.log(`[extract-v2] Image ${i}: visible=${count}`);
				return { idx: i, count, numbers };
			})
		);

		// ── STEP 3: COLLECT + TARGETED RECOVERY ─────────────────────────────────────
		const allExtracted = [];
		const seen = new Set();
		function pushUnique(q, sourceIdx) {
			const normalized = normalizeQuestion({ ...q, imageSourceIndex: sourceIdx });
			const k = keyOf(normalized);
			if (seen.has(k)) return false;
			seen.add(k);
			allExtracted.push(normalized);
			return true;
		}
		for (const { arr, idx } of primaryResults) {
			for (const q of arr) pushUnique(q, idx);
		}

		// Recovery pass — only for images where we extracted < 85% of expected
		await Promise.all(
			questionImages.map(async (imgB64, i) => {
				const primary = primaryResults[i].arr;
				const expected = countResults[i].count;
				if (expected <= 0 || primary.length >= expected * 0.85) return;
				const missed = Math.max(1, expected - primary.length);
				console.log(`[extract-v2] Image ${i}: recovery needed (${primary.length}/${expected})`);
				const prompt = `You extracted ${primary.length} but ${expected} are visible. Find the ${missed} MISSING question(s).
PRIOR LIST (do NOT re-extract):
${JSON.stringify(primary.map(q => String(q.question || "").slice(0, 80))).slice(0, 3000)}
Return ONLY JSON array of MISSING questions. Return [] if nothing missed.`;
				const parts = [toImgPart(imgB64), ...answerPartsForGroq];
				const raw = await callGroq(parts, RECOVERY_SYSTEM, prompt, 2000, 0.0);
				const arr = parseJsonArray(raw) || [];
				let added = 0;
				for (const q of arr) { if (pushUnique(q, i)) added++; }
				if (added) console.log(`[extract-v2] Image ${i}: recovery added ${added}`);
			})
		);

		// ── STEP 4: CROSS-IMAGE BOUNDARY MERGE ──────────────────────────────────────
		for (let i = 1; i < questionImages.length; i++) {
			const leftCands = allExtracted.filter(q => q.imageSourceIndex === i - 1);
			const rightCands = allExtracted.filter(q => q.imageSourceIndex === i);
			if (!leftCands.length || !rightCands.length) continue;
			const left = leftCands[leftCands.length - 1];
			const right = rightCands[0];
			// Skip if left has all 4 options filled
			const leftMissing = (left.options || []).filter(o => !String(o || "").trim()).length;
			if (leftMissing === 0) continue;
			const prompt = `Last question of image 1:
"${String(left.question || "").slice(0, 300)}" opts=${JSON.stringify(left.options)}
First fragment of image 2:
"${String(right.question || "").slice(0, 300)}" opts=${JSON.stringify(right.options)}
Is image-2 fragment a continuation of image-1's question?
Return ONLY: {"split":true,"merged":{"question":"...","options":["","","",""],"correctIndexes":[0],"isMultiCorrect":false,"hasImage":false,"imageRegion":null}} OR {"split":false}`;
			const mergeRaw = await callGroq(
				[toImgPart(questionImages[i - 1]), toImgPart(questionImages[i])],
				MERGE_SYSTEM, prompt, 600, 0.0
			);
			const mt = cleanJson(mergeRaw);
			const merged = tryParse(mt.slice(mt.indexOf("{"), mt.lastIndexOf("}") + 1));
			if (merged?.split === true && merged?.merged) {
				const mergedQ = normalizeQuestion({ ...merged.merged, imageSourceIndex: i - 1 });
				const li = allExtracted.findIndex(q => q === left);
				const ri = allExtracted.findIndex(q => q === right);
				if (li !== -1) allExtracted[li] = mergedQ;
				if (ri !== -1) allExtracted.splice(ri, 1);
				console.log(`[extract-v2] Boundary merged image ${i - 1}→${i}`);
			}
		}

		// ── STEP 5: ANSWER KEY OVERLAY (from image key) ─────────────────────────────
		if (Array.isArray(answerImages) && answerImages.length && !manualAnswerKey?.trim()) {
			try {
				const akRaw = await callGroq(answerImages.slice(0, 2).map(toImgPart), ANSWER_OVERLAY_SYSTEM,
					"Extract correct answers from this answer key. Return ONLY JSON array.", 1500, 0.0);
				const akArr = parseJsonArray(akRaw);
				if (Array.isArray(akArr)) {
					const akMap = new Map();
					for (const e of akArr) {
						const num = parseInt(e.num);
						if (Number.isInteger(num) && Array.isArray(e.correctIndexes)) {
							akMap.set(num, e.correctIndexes.map(Number).filter(n => n >= 0 && n < 4));
						}
					}
					let overlaid = 0;
					for (const q of allExtracted) {
						const n = getNum(q);
						if (n !== null && akMap.has(n)) {
							q.correctIndexes = akMap.get(n);
							q.isMultiCorrect = q.correctIndexes.length > 1;
							overlaid++;
						}
					}
					console.log(`[extract-v2] Answer overlay: ${overlaid} question(s)`);
				}
			} catch (akErr) {
				console.warn("[extract-v2] Answer overlay failed:", akErr.message);
			}
		}

		// ── STEP 6: DEDUP + SORT + FINAL NORMALISE ──────────────────────────────────
		const bestByNum = new Map();
		for (const q of allExtracted) {
			const n = getNum(q);
			if (n === null) continue;
			const prev = bestByNum.get(n);
			if (!prev || richness(q) > richness(prev)) bestByNum.set(n, q);
		}
		const ordered = [];
		const seenNums = new Set();
		for (const q of allExtracted) {
			const n = getNum(q);
			if (n === null) { ordered.push(q); continue; }
			if (seenNums.has(n)) continue;
			seenNums.add(n);
			ordered.push(bestByNum.get(n) || q);
		}
		ordered.sort((a, b) => (getNum(a) ?? 9999) - (getNum(b) ?? 9999));

		const deduped = [];
		for (const q of ordered) {
			const idx = deduped.findIndex(x => areNearDup(x, q));
			if (idx === -1) { deduped.push(q); continue; }
			if (richness(q) > richness(deduped[idx])) deduped[idx] = q;
		}

		if (!deduped.length) {
			return res.status(500).json({ error: "No questions could be extracted. Please upload a clearer screenshot." });
		}

		const questions = deduped.map(q => {
			const next = normalizeQuestion(q);
			if (next.hasImage && !Number.isInteger(next.imageSourceIndex)) next.imageSourceIndex = 0;
			if (Number.isInteger(next.imageSourceIndex))
				next.imageSourceIndex = clamp(next.imageSourceIndex, 0, questionImages.length - 1);
			return next;
		});

		console.log(`[extract-v2] Done: ${questions.length} questions`);
		res.json({ questions });
	} catch (e) {
		console.error("/api/admin/extract error:", e);
		res.status(500).json({ error: e.message || "Extraction failed" });
	}
});

app.use((req, res) => {
	res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
	console.error("Unhandled:", err);
	res.status(500).json({ error: "Internal server error" });
});

initDB()
	.then(() => loadQuestions())
	.then(() => {
		app.listen(PORT, () => {
			console.log(`Server on port ${PORT}`);
			console.log("GROQ_API_KEY:", GROQ_API_KEY ? "set" : "MISSING");
			console.log("TURSO_DATABASE_URL:", process.env.TURSO_DATABASE_URL ? "set" : "MISSING");
			console.log("Cloudinary:", process.env.CLOUDINARY_CLOUD_NAME ? "configured" : "MISSING");
		});
	})
	.catch((e) => {
		console.error("FATAL: DB init failed:", e);
		process.exit(1);
	});
