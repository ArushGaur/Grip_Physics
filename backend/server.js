const express = require("express");
const session = require("express-session");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@libsql/client");
const cloudinary = require("cloudinary").v2;

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);

// ── REQUIRED ENV VARS
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE;
if (!ADMIN_PASSCODE || ADMIN_PASSCODE.length < 12) {
    console.error("FATAL: ADMIN_PASSCODE env var is missing or too short (min 12 chars).");
    process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    console.error("FATAL: SESSION_SECRET env var is missing or too short (min 32 chars).");
    process.exit(1);
}

// ── TURSO CLIENT
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

// ── CLOUDINARY CONFIG
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── CLOUDINARY HELPERS
async function uploadImageToCloudinary(base64String) {
    if (!base64String) return null;
    if (base64String.startsWith("http")) return base64String;
    try {
        let dataUri = base64String;
        if (!base64String.startsWith("data:")) {
            const mime = base64String.startsWith("/9j/") ? "image/jpeg" : "image/png";
            dataUri = `data:${mime};base64,${base64String}`;
        }
        const result = await cloudinary.uploader.upload(dataUri, { folder: "grip_physics" });
        return result.secure_url;
    } catch (e) {
        console.error("Cloudinary upload error:", e.message);
        return base64String;
    }
}

async function uploadQuestionImages(questions) {
    return Promise.all(
        questions.map(async (q) => {
            const updated = { ...q };
            if (updated.questionImage) {
                updated.questionImage = await uploadImageToCloudinary(updated.questionImage);
            }
            if (Array.isArray(updated.optionImages)) {
                updated.optionImages = await Promise.all(
                    updated.optionImages.map((img) => uploadImageToCloudinary(img))
                );
            }
            return updated;
        })
    );
}

// ── DB INIT
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

// ── CUSTOM SESSION STORE
class TursoSessionStore extends session.Store {
    async get(sid, cb) {
        try {
            const row = await db.execute({ sql: "SELECT data, expires FROM sessions WHERE sid = ?", args: [sid] });
            if (!row.rows.length) return cb(null, null);
            const { data, expires } = row.rows[0];
            if (Date.now() > expires) {
                await db.execute({ sql: "DELETE FROM sessions WHERE sid = ?", args: [sid] });
                return cb(null, null);
            }
            cb(null, JSON.parse(data));
        } catch (e) { cb(e); }
    }

    async set(sid, session, cb) {
        try {
            const expires = session.cookie?.expires
                ? new Date(session.cookie.expires).getTime()
                : Date.now() + 8 * 60 * 60 * 1000;
            const data = JSON.stringify(session);
            await db.execute({
                sql: `INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
                      ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`,
                args: [sid, data, expires],
            });
            cb(null);
        } catch (e) { cb(e); }
    }

    async destroy(sid, cb) {
        try {
            await db.execute({ sql: "DELETE FROM sessions WHERE sid = ?", args: [sid] });
            cb(null);
        } catch (e) { cb(e); }
    }
}

// ── MIDDLEWARE
app.use(cors({
    origin: ["https://grip-physics.onrender.com", "https://grip-physics.vercel.app", "http://localhost:3000", "http://localhost:8080", "http://127.0.0.1:3000", "http://127.0.0.1:8080"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["set-cookie"],
    maxAge: 86400,
}));
app.use(express.json({ limit: "20mb" }));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    name: "grip.sid",
    store: new TursoSessionStore(),
    cookie: { secure: true, sameSite: "none", httpOnly: true, maxAge: 8 * 60 * 60 * 1000 },
}));

// ── SECURITY HEADERS + LOGGING
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    next();
});

// ── RATE LIMITER
const rateLimitMap = new Map();
const loginFailMap = new Map();

function rateLimit(windowMs, max) {
    return (req, res, next) => {
        const key = req.ip + req.path, now = Date.now();
        if (!rateLimitMap.has(key)) rateLimitMap.set(key, []);
        const reqs = rateLimitMap.get(key).filter((t) => t > now - windowMs);
        reqs.push(now);
        rateLimitMap.set(key, reqs);
        if (reqs.length > max) return res.status(429).json({ error: "Too many requests. Try again later." });
        next();
    };
}

function loginRateLimit(req, res, next) {
    const ip = req.ip, now = Date.now();
    const WINDOW = 15 * 60 * 1000, LOCKOUT = 60 * 60 * 1000, MAX = 5;
    if (!loginFailMap.has(ip)) loginFailMap.set(ip, []);
    const attempts = loginFailMap.get(ip).filter((t) => t > now - LOCKOUT);
    loginFailMap.set(ip, attempts);
    if (attempts.filter((t) => t > now - WINDOW).length >= MAX) {
        const wait = Math.ceil((attempts[0] + LOCKOUT - now) / 60000);
        return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait} minute(s).` });
    }
    next();
}
function recordLoginFailure(ip) {
    if (!loginFailMap.has(ip)) loginFailMap.set(ip, []);
    loginFailMap.get(ip).push(Date.now());
}

// Cleanup stale rate limit entries and expired sessions every 10 min
setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, v] of rateLimitMap.entries()) { const f = v.filter((t) => t > cutoff); if (!f.length) rateLimitMap.delete(k); else rateLimitMap.set(k, f); }
    for (const [k, v] of loginFailMap.entries()) { const f = v.filter((t) => t > cutoff); if (!f.length) loginFailMap.delete(k); else loginFailMap.set(k, f); }
    db.execute({ sql: "DELETE FROM sessions WHERE expires < ?", args: [Date.now()] }).catch(() => {});
}, 10 * 60 * 1000);

// ── QUESTION CACHE
let questionCache = {};

function normalizeQuestion(row) {
    if (!row) return null;
    const d = {
        _id: row.id,
        chapter: row.chapter || null,
        lecture: row.lecture,
        topic: row.topic || "",
        updatedAt: row.updated_at || 0,
        questions: [],
    };
    try { d.questions = JSON.parse(row.questions_json || "[]"); } catch { d.questions = []; }
    if (d.questions && d.questions.length > 0) {
        d.questions = d.questions.map((q) => {
            if (!q.correctIndexes || !q.correctIndexes.length)
                q.correctIndexes = [typeof q.correctIndex === "number" ? q.correctIndex : 0];
            if (typeof q.isMultiCorrect !== "boolean") q.isMultiCorrect = q.correctIndexes.length > 1;
            return q;
        });
        return d;
    }
    d.questions = [];
    d._corrupted = true;
    return d;
}

function normalizeStudent(row) {
    return {
        _id: row.id,
        mobile: row.mobile,
        lecture: row.lecture,
        name: row.name,
        place: row.place,
        className: row.class_name,
        chapter: row.chapter || null,
        answers: JSON.parse(row.answers_json || "[]"),
        correctCount: row.correct_count,
        totalQuestions: row.total_questions,
        time: row.time,
    };
}

async function loadQuestions() {
    const result = await db.execute("SELECT * FROM questions");
    questionCache = {};
    result.rows.forEach((row) => {
        const n = normalizeQuestion(row);
        if (n && !n._corrupted) questionCache[`${row.chapter || ""}::${row.lecture}`] = n;
    });
    console.log(`Cached ${result.rows.length} questions`);
}

async function findQuestion(chapter, lecture) {
    const key = `${chapter || ""}::${lecture}`;
    const cached = questionCache[key];
    if (cached && !cached._corrupted && cached.questions && cached.questions.length > 0) return cached;
    let result;
    if (chapter) {
        result = await db.execute({ sql: "SELECT * FROM questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
    } else {
        result = await db.execute({ sql: "SELECT * FROM questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1", args: [lecture] });
    }
    if (!result.rows.length) return null;
    const n = normalizeQuestion(result.rows[0]);
    if (n && !n._corrupted) { questionCache[key] = n; return n; }
    return null;
}

async function refreshCache(chapter, lecture) {
    let result;
    if (chapter) {
        result = await db.execute({ sql: "SELECT * FROM questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
    } else {
        result = await db.execute({ sql: "SELECT * FROM questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1", args: [lecture] });
    }
    if (result.rows.length) {
        const n = normalizeQuestion(result.rows[0]);
        if (n && !n._corrupted) questionCache[`${chapter || ""}::${lecture}`] = n;
    } else {
        delete questionCache[`${chapter || ""}::${lecture}`];
    }
}

function isCorrect(qItem, ans) {
    if (!qItem) return false;
    const correctIdxs = qItem.correctIndexes && qItem.correctIndexes.length ? qItem.correctIndexes : [qItem.correctIndex || 0];
    if (qItem.isMultiCorrect || correctIdxs.length > 1) {
        const sel = Array.isArray(ans) ? [...ans].sort((a, b) => a - b) : [ans];
        const cor = [...correctIdxs].sort((a, b) => a - b);
        return JSON.stringify(sel) === JSON.stringify(cor);
    }
    return ans === correctIdxs[0];
}

function requireAdmin(req, res, next) {
    if (!req.session?.admin) return res.status(403).json({ error: "Unauthorized" });
    next();
}

function safeCompare(a, b) {
    try {
        const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
        if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
        return crypto.timingSafeEqual(ba, bb);
    } catch { return false; }
}

// ════════════════════════════════════════════
// ── ROUTES
// ════════════════════════════════════════════

// ── AUTH
app.post("/api/admin/login", loginRateLimit, (req, res) => {
    if (!safeCompare(req.body.passcode || "", ADMIN_PASSCODE)) {
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

app.post("/api/admin/logout", (req, res) => req.session.destroy(() => res.json({ message: "Logged out" })));

// ── PUBLIC ROUTES
app.get("/api/chapters", async (req, res) => {
    try {
        const result = await db.execute("SELECT DISTINCT chapter FROM questions WHERE chapter IS NOT NULL AND chapter != ''");
        res.json(result.rows.map((r) => r.chapter).filter(Boolean).sort());
    } catch { res.status(500).json({ error: "Failed" }); }
});

app.get("/api/lectures/:chapter", async (req, res) => {
    try {
        const result = await db.execute({ sql: "SELECT lecture FROM questions WHERE chapter = ?", args: [req.params.chapter] });
        res.json(result.rows.map((r) => r.lecture).filter(Boolean).sort((a, b) => Number(a) - Number(b)));
    } catch { res.status(500).json({ error: "Failed" }); }
});

app.get("/api/question/:chapter/:lecture", async (req, res) => {
    try {
        const q = await findQuestion(req.params.chapter, req.params.lecture);
        if (!q) return res.status(404).json({ error: "Lecture not found" });
        res.json(q);
    } catch { res.status(500).json({ error: "Failed" }); }
});

app.post("/api/check-attempt", async (req, res) => {
    const { mobile, chapter, lecture } = req.body;
    if (!mobile || !lecture) return res.status(400).json({ error: "Missing" });
    const q = await findQuestion(chapter, lecture);
    if (!q) return res.json({ allowed: false, time: 0 });
    const result = await db.execute({ sql: "SELECT time FROM attempts WHERE mobile = ? AND lecture = ? ORDER BY time DESC LIMIT 1", args: [mobile, lecture] });
    if (!result.rows.length) return res.json({ allowed: true, time: 0 });
    const lastTime = result.rows[0].time;
    res.json(lastTime >= (q.updatedAt || 0) ? { allowed: false, time: lastTime } : { allowed: true, time: lastTime });
});

app.post("/api/submit-attempt", rateLimit(60 * 1000, 5), async (req, res) => {
    const { mobile, chapter, lecture, selectedAnswers, askedQuestionIndexes, name, place, className } = req.body;
    if (!mobile || !lecture) return res.status(400).json({ error: "Missing" });
    const q = await findQuestion(chapter, lecture);
    if (!q) return res.status(404).json({ error: "Not found" });

    const lastResult = await db.execute({ sql: "SELECT time FROM attempts WHERE mobile = ? AND lecture = ? ORDER BY time DESC LIMIT 1", args: [mobile, lecture] });
    if (lastResult.rows.length && lastResult.rows[0].time >= (q.updatedAt || 0)) return res.json({ allowed: false });

    const answers = Array.isArray(selectedAnswers) ? selectedAnswers : [];
    const validSourceIndexes = Array.isArray(askedQuestionIndexes)
        ? askedQuestionIndexes.map((idx) => Number(idx)).filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < q.questions.length)
        : [];
    const questionsForScoring = validSourceIndexes.length
        ? validSourceIndexes.map((idx) => q.questions[idx]).filter(Boolean)
        : q.questions;

    let correctCount = 0;
    answers.forEach((ans, i) => { if (isCorrect(questionsForScoring[i], ans)) correctCount++; });
    const now = Date.now();

    await db.execute({ sql: "INSERT INTO attempts (mobile, chapter, lecture, time) VALUES (?, ?, ?, ?)", args: [mobile, chapter || null, lecture, now] });
    await db.execute({
        sql: `INSERT INTO students (mobile, lecture, name, place, class_name, chapter, answers_json, correct_count, total_questions, time)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(mobile, lecture) DO UPDATE SET
                name=excluded.name, place=excluded.place, class_name=excluded.class_name,
                chapter=excluded.chapter, answers_json=excluded.answers_json,
                correct_count=excluded.correct_count, total_questions=excluded.total_questions, time=excluded.time`,
        args: [mobile, lecture, name, place, className, chapter || null, JSON.stringify(answers), correctCount, questionsForScoring.length, now],
    });
    res.json({ success: true, correctCount, totalQuestions: questionsForScoring.length });
});

app.post("/api/student-register", async (req, res) => {
    const { name, mobile, place, className, chapter, lecture } = req.body;
    if (!name || !mobile || !lecture) return res.status(400).json({ error: "Missing" });
    await db.execute({
        sql: `INSERT INTO students (mobile, lecture, name, place, class_name, chapter, time)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(mobile, lecture) DO UPDATE SET
                name=excluded.name, place=excluded.place, class_name=excluded.class_name,
                chapter=excluded.chapter, time=excluded.time`,
        args: [mobile, lecture, name, place, className, chapter || null, Date.now()],
    });
    res.json({ success: true });
});

// ── ADMIN ROUTES
app.post("/api/admin/add-question", requireAdmin, async (req, res) => {
    try {
        let { chapter, lecture, topic, questions, replace } = req.body;
        if (!lecture || !Array.isArray(questions) || !questions.length) return res.status(400).json({ error: "Missing" });

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
            const existingQs = replace ? [] : JSON.parse(existing.questions_json || "[]");
            const updatedQs = [...existingQs, ...questions];
            await db.execute({
                sql: "UPDATE questions SET questions_json = ?, topic = ?, updated_at = ? WHERE id = ?",
                args: [JSON.stringify(updatedQs), topic || existing.topic || "", Date.now(), existing.id],
            });
            await refreshCache(chapter, lecture);
            return res.json({ success: true, added: questions.length, total: updatedQs.length });
        }

        await db.execute({
            sql: "INSERT INTO questions (chapter, lecture, topic, questions_json, updated_at) VALUES (?, ?, ?, ?, ?)",
            args: [chapter || null, lecture, topic || "", JSON.stringify(questions), Date.now()],
        });
        await refreshCache(chapter, lecture);
        res.json({ success: true, added: questions.length, total: questions.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
    try {
        const chapter = decodeURIComponent(req.params.chapter);
        const lecture = decodeURIComponent(req.params.lecture);
        await db.execute({ sql: "DELETE FROM questions WHERE lecture = ? AND (chapter = ? OR chapter IS NULL OR chapter = '')", args: [lecture, chapter] });
        delete questionCache[`${chapter}::${lecture}`];
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

        const normalizedQuestions = questions.map((q) => {
            const opts = Array.isArray(q?.options) ? q.options : [];
            const ciRaw = Array.isArray(q?.correctIndexes) ? q.correctIndexes : [typeof q?.correctIndex === "number" ? q.correctIndex : 0];
            const ci = [...new Set(ciRaw.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n < 4))];
            return {
                question: String(q?.question || "").trim(),
                options: [...opts, "", "", ""].slice(0, 4).map((o) => String(o || "")),
                correctIndexes: ci.length ? ci : [0],
                isMultiCorrect: ci.length > 1,
                questionImage: q?.questionImage || null,
            };
        });

        await db.execute({
            sql: "UPDATE questions SET chapter = ?, topic = ?, questions_json = ?, updated_at = ? WHERE id = ?",
            args: [chapterForSave, topic || existing.topic || "", JSON.stringify(normalizedQuestions), Date.now(), existing.id]
        });
        await refreshCache(chapterForSave, lecture);
        res.json({ success: true, updated: normalizedQuestions.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/mass-delete", requireAdmin, async (req, res) => {
    try {
        const { items } = req.body;
        if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "No items" });
        let deleted = 0;
        for (const { chapter, lecture } of items) {
            await db.execute({ sql: "DELETE FROM questions WHERE lecture = ? AND (chapter = ? OR chapter IS NULL OR chapter = '')", args: [lecture, chapter || null] });
            delete questionCache[`${chapter || ""}::${lecture}`];
            deleted++;
        }
        res.json({ success: true, deleted });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/students", requireAdmin, async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM students ORDER BY time DESC");
        res.json(result.rows.map(normalizeStudent));
    } catch { res.status(500).json({ error: "Failed" }); }
});

app.get("/api/admin/questions", requireAdmin, async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM questions");
        res.json(result.rows.map(normalizeQuestion));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/rename-chapter", requireAdmin, async (req, res) => {
    try {
        const { oldName, newName } = req.body;
        if (!oldName || !newName) return res.status(400).json({ error: "Missing old or new chapter name." });
        const qr = await db.execute({ sql: "UPDATE questions SET chapter = ? WHERE chapter = ?", args: [newName, oldName] });
        const sr = await db.execute({ sql: "UPDATE students SET chapter = ? WHERE chapter = ?", args: [newName, oldName] });
        const ar = await db.execute({ sql: "UPDATE attempts SET chapter = ? WHERE chapter = ?", args: [newName, oldName] });
        const total = (qr.rowsAffected || 0) + (sr.rowsAffected || 0) + (ar.rowsAffected || 0);
        if (!total) return res.status(404).json({ error: "Chapter not found." });
        await loadQuestions();
        res.json({ success: true, updated: { questions: qr.rowsAffected, students: sr.rowsAffected, attempts: ar.rowsAffected, total } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/rename-topic", requireAdmin, async (req, res) => {
    try {
        const { chapter, oldName, newName } = req.body;
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
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/reload-cache", requireAdmin, async (req, res) => {
    try {
        await loadQuestions();
        res.json({ success: true, cached: Object.keys(questionCache).length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/migrate", requireAdmin, async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM questions");
        const all = result.rows.map(normalizeQuestion);
        const corrupted = all.filter((q) => q._corrupted);
        res.json({ total: all.length, corrupted: corrupted.length, corruptedLectures: corrupted.map((q) => ({ lecture: q.lecture, chapter: q.chapter || null, _id: q._id })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/migrate", requireAdmin, async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM questions");
        const corruptedIds = result.rows.filter((row) => {
            try { const qs = JSON.parse(row.questions_json || "[]"); return !qs.length; } catch { return true; }
        }).map((r) => r.id);
        if (!corruptedIds.length) return res.json({ success: true, deleted: 0, message: "No corrupted records found." });
        for (const id of corruptedIds) await db.execute({ sql: "DELETE FROM questions WHERE id = ?", args: [id] });
        await loadQuestions();
        res.json({ success: true, deleted: corruptedIds.length, message: `Deleted ${corruptedIds.length} corrupted record(s).` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI EXTRACT QUESTIONS FROM IMAGE
app.post("/api/admin/extract", requireAdmin, async (req, res) => {
    const { questionImages, answerImages, manualAnswerKey } = req.body;
    if (!questionImages || !Array.isArray(questionImages) || !questionImages.length)
        return res.status(400).json({ error: "At least one question image required" });
    if (!process.env.GROQ_API_KEY)
        return res.status(500).json({ error: "GROQ_API_KEY not set on server" });

    function getMime(b64) {
        if (b64.startsWith("/9j/")) return "image/jpeg";
        if (b64.startsWith("iVBORw")) return "image/png";
        return "image/jpeg";
    }

    const answerKeyDesc = manualAnswerKey?.trim()
        ? `The answer key is: ${manualAnswerKey.trim()}. Parse it as question number → answer letter(s).`
        : answerImages?.length
            ? `The last ${answerImages.length} image(s) are the answer key.`
            : "No answer key provided — do your best to identify correct answers from context.";

    const prompt = `You are extracting physics MCQs from exam screenshots.\n\n${answerKeyDesc}\n\nReturn ONLY a raw JSON array (no markdown, no explanation).\nExtract EVERY SINGLE question visible in the image. Do NOT skip any question.\n\nPer item format:\n{"question":"...","options":["A","B","C","D"],"correctIndexes":[0],"isMultiCorrect":false,"hasImage":false}\n\nRules:\n- Always provide exactly 4 options.\n- If options are embedded in stem as (a)(b)(c)(d), split them correctly.\n- correctIndexes uses 0=A,1=B,2=C,3=D.\n- Multi-correct (e.g. A,C) => correctIndexes:[0,2], isMultiCorrect:true.\n- hasImage:true if question has a diagram/figure/graph.\n\nEquation formatting:\n- Use $...$ for inline LaTeX, $$...$$ for display.\n- Convert: pi->$\\pi$, omega->$\\omega$, sin->$\\sin$, cos->$\\cos$.\n- Preserve superscripts/subscripts: T^4 as $T^4$, T_1 as $T_1$.\n- Use \\frac for fractions e.g. $\\frac{1}{2}mv^2$.`;

    // Make one API call with given images
    async function callGroq(imgParts, instruction) {
        const contentParts = [
            ...imgParts,
            ...( answerImages || []).map(img => ({ type: "image_url", image_url: { url: `data:${getMime(img)};base64,${img}` } })),
            { type: "text", text: instruction ? `${prompt}\n\n${instruction}` : prompt }
        ];
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.GROQ_API_KEY },
            body: JSON.stringify({
                model: "meta-llama/llama-4-scout-17b-16e-instruct",
                max_tokens: 8000,
                temperature: 0.1,
                messages: [{ role: "user", content: contentParts }]
            })
        });
        if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            throw new Error((e.error && e.error.message) || "Groq error");
        }
        const data = await r.json();
        return String(data.choices?.[0]?.message?.content || "").trim();
    }

    function cleanJson(txt) {
        return String(txt || "")
            .replace(/```json/gi, "").replace(/```/g, "")
            .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
            .replace(/\u00A0/g, " ").replace(/\r\n?/g, "\n")
            .trim();
    }

    function tryParse(txt) {
        try { return JSON.parse(txt); } catch {
            try { return JSON.parse(txt.replace(/,\s*]/g, "]").replace(/,\s*}/g, "}")); } catch { return null; }
        }
    }

    function parseAiQuestions(raw) {
        const text = cleanJson(raw);
        const candidates = [text];
        const s = text.indexOf("["), e = text.lastIndexOf("]");
        if (s !== -1 && e > s) candidates.push(text.slice(s, e + 1));
        const m = text.match(/\[[\s\S]*\]/m);
        if (m?.[0]) candidates.push(m[0]);

        for (const c of candidates) {
            const p = tryParse(c);
            if (Array.isArray(p) && p.length) return p;
            if (p && Array.isArray(p.questions) && p.questions.length) return p.questions;
        }
        // Salvage individual objects
        const frags = text.match(/\{[\s\S]*?\}/g) || [];
        const recovered = frags.map(f => tryParse(f)).filter(p => p && !Array.isArray(p) && (p.question || p.options));
        return recovered.length ? recovered : null;
    }

    function extractQuestionNumber(q) {
        const txt = String(q?.question || "").trim();
        const m = txt.match(/^\s*(?:q\.?\s*)?(\d{1,3})\s*[\).:-]/i);
        if (!m) return null;
        const n = parseInt(m[1], 10);
        return Number.isInteger(n) ? n : null;
    }

    try {
        // ── STEP 1: Extract each image separately to avoid token truncation
        const allParts = questionImages.map(img => [{ type: "image_url", image_url: { url: `data:${getMime(img)};base64,${img}` } }]);
        let parsed = [];
        const seen = new Set();

        function mergeUnique(arr) {
            if (!Array.isArray(arr)) return 0;
            let added = 0;
            for (const q of arr) {
                const key = `${String(q?.question||"").trim().toLowerCase()}||${JSON.stringify((q?.options||[]).map(o=>String(o||"").trim().toLowerCase()))}`;
                if (!seen.has(key)) { seen.add(key); parsed.push(q); added++; }
            }
            return added;
        }

        if (questionImages.length === 1) {
            // Single image: one call with the full prompt
            const raw = await callGroq(allParts[0], "");
            const result = parseAiQuestions(raw);
            if (result) mergeUnique(result);
        } else {
            // Multiple images: one call per image so each gets the full token budget
            for (let i = 0; i < allParts.length; i++) {
                try {
                    const instruction = `This is question image ${i + 1} of ${questionImages.length}. Extract ALL questions from THIS image only.`;
                    const raw = await callGroq(allParts[i], instruction);
                    const result = parseAiQuestions(raw);
                    if (result) mergeUnique(result);
                } catch (imgErr) {
                    console.warn(`Image ${i + 1} extraction failed:`, imgErr.message);
                }
            }
        }

        if (!parsed.length) return res.status(500).json({ error: "Could not extract any questions. Please try again with cleaner screenshots." });

        // ── STEP 2: Continuation passes — recover any missed questions
        // Build combined image parts for continuation (all question images together)
        const allImgParts = questionImages.map(img => ({ type: "image_url", image_url: { url: `data:${getMime(img)};base64,${img}` } }));

        let consecutiveEmpty = 0;
        for (let pass = 1; pass <= 4; pass++) {
            try {
                const seenNums = parsed.map(q => extractQuestionNumber(q)).filter(n => Number.isInteger(n)).sort((a, b) => a - b);
                const lastStem = String(parsed[parsed.length - 1]?.question || "").replace(/\s+/g, " ").slice(0, 180);
                const recentStems = parsed.slice(-8).map(q => `- ${String(q?.question || "").replace(/\s+/g, " ").slice(0, 100)}`).join("\n");

                const instruction = [
                    `Continuation pass ${pass}: extract ONLY questions not yet extracted from these images.`,
                    seenNums.length ? `Already extracted question numbers: ${seenNums.join(", ")}.` : "",
                    lastStem ? `Last extracted stem: "${lastStem}".` : "",
                    recentStems ? `Recent extracted stems (do not repeat):\n${recentStems}` : "",
                    `Total extracted so far: ${parsed.length}.`,
                    `Return JSON array only. If nothing remains, return [].`
                ].filter(Boolean).join("\n\n");

                const raw = await callGroq(allImgParts, instruction);
                const result = parseAiQuestions(raw);
                if (!Array.isArray(result) || !result.length) {
                    if (++consecutiveEmpty >= 2) break;
                    continue;
                }
                const added = mergeUnique(result);
                if (added === 0) { if (++consecutiveEmpty >= 2) break; }
                else consecutiveEmpty = 0;
            } catch (err) {
                console.warn(`Continuation pass ${pass} failed:`, err.message);
                break;
            }
        }

        // ── STEP 3: For numbered questions, fill any gaps by range
        const numberedCount = parsed.filter(q => Number.isInteger(extractQuestionNumber(q))).length;
        if (parsed.length > 0 && (numberedCount / parsed.length) >= 0.5) {
            const maxNum = parsed.reduce((max, q) => { const n = extractQuestionNumber(q); return Number.isInteger(n) && n > max ? n : max; }, 0);
            const upperBound = Math.max(60, maxNum + 15);
            let emptyRanges = 0;

            for (let start = 1; start <= upperBound; start += 10) {
                if (emptyRanges >= 2) break;
                const end = start + 9;
                const seenInRange = [];
                for (let n = start; n <= end; n++) {
                    if (parsed.some(q => extractQuestionNumber(q) === n)) seenInRange.push(n);
                }
                if (seenInRange.length === 10) { emptyRanges++; continue; }
                const alreadySeen = seenInRange.length ? `Already have Q${seenInRange.join(", Q")} — skip these.` : "";

                try {
                    const instruction = [
                        `Extract ONLY questions numbered ${start} to ${end} from the images.`,
                        alreadySeen,
                        `Return JSON array only; return [] if none found in this range.`
                    ].filter(Boolean).join("\n");
                    const raw = await callGroq(allImgParts, instruction);
                    const result = parseAiQuestions(raw);
                    if (!result) { emptyRanges++; continue; }

                    let added = 0;
                    for (const q of result) {
                        const qn = extractQuestionNumber(q);
                        if (!Number.isInteger(qn) || qn < start || qn > end) continue;
                        const key = `${String(q?.question||"").trim().toLowerCase()}||${JSON.stringify((q?.options||[]).map(o=>String(o||"").trim().toLowerCase()))}`;
                        if (!seen.has(key)) { seen.add(key); parsed.push(q); added++; }
                    }
                    if (added === 0) emptyRanges++; else emptyRanges = 0;
                } catch (err) {
                    console.warn(`Range ${start}-${end} pass failed:`, err.message);
                    emptyRanges++;
                }
            }

            // Deduplicate: keep only first entry per question number
            const seenNums = new Set();
            parsed = parsed.filter(q => {
                const n = extractQuestionNumber(q);
                if (!Number.isInteger(n)) return true;
                if (seenNums.has(n)) return false;
                seenNums.add(n);
                return true;
            });
        }

        if (!parsed.length) return res.status(500).json({ error: "No questions found." });

        // ── STEP 4: Normalize math and answer fields
        function normalizeMath(val) {
            let s = String(val || "").trim();
            if (!s) return s;
            s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m}$`);
            s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `$$${m}$$`);
            s = s.replace(/\s*\$\\\$\s*$/, "").trim();
            const dollars = (s.match(/(^|[^\\])\$/g) || []).length;
            if (dollars % 2 === 1) s += "$";
            return s;
        }

        parsed = parsed.map((q) => {
            if (q.question) q.question = normalizeMath(q.question);
            const options = Array.isArray(q.options) ? q.options : [];
            q.options = [...options, "", "", ""].slice(0, 4).map(o => normalizeMath(o));

            let ci = Array.isArray(q.correctIndexes) ? q.correctIndexes : [];
            if (!ci.length && typeof q.correctIndex === "number") ci = [q.correctIndex];

            const answerHint = String(q.correctAnswer || q.answer || q.correct || "").trim().toLowerCase();
            if (!ci.length) {
                const m = answerHint.match(/\b([abcd])\b/i);
                if (m) ci = ["abcd".indexOf(m[1].toLowerCase())];
            }

            ci = [...new Set(ci.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n >= 0 && n < 4))];

            const hasAllOfAbove = q.options.some(o => /all\s+of\s+the\s+above|all\s+of\s+these|all\s+are\s+correct/i.test(o));
            const explicitAll = /all\s+of\s+the\s+above|all\s+options|\ba\s*,\s*b\s*,\s*c\s*,\s*d\b/.test(answerHint);
            if ((answerHint === "all" || ci.length === 4) && !hasAllOfAbove && !explicitAll) ci = [0];
            if (!ci.length) ci = [0];

            q.correctIndexes = ci;
            q.isMultiCorrect = ci.length > 1;
            return q;
        });

        res.json({ questions: parsed });
    } catch (e) {
        console.error("Extract error:", e);
        res.status(500).json({ error: "Server error: " + e.message });
    }
});

// ── CATCH-ALL
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => { console.error("Unhandled:", err); res.status(500).json({ error: "Internal server error" }); });

// ── START
initDB()
    .then(() => loadQuestions())
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server on port ${PORT}`);
            console.log("GROQ_API_KEY:", process.env.GROQ_API_KEY ? "set" : "MISSING");
            console.log("Turso DB:", process.env.TURSO_DATABASE_URL ? "connected" : "MISSING");
            console.log("Cloudinary:", process.env.CLOUDINARY_CLOUD_NAME ? "configured" : "MISSING");
        });
    })
    .catch((err) => { console.error("FATAL: DB init failed:", err); process.exit(1); });
