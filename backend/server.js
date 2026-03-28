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

    // ── UTILITIES ───────────────────────────────────────────────────────────

    function getMime(b64) {
        if (b64.startsWith("/9j/")) return "image/jpeg";
        if (b64.startsWith("iVBORw")) return "image/png";
        return "image/jpeg";
    }

    function toImgPart(b64) {
        return { type: "image_url", image_url: { url: `data:${getMime(b64)};base64,${b64}` } };
    }

    function cleanJson(txt) {
        return String(txt || "")
            .replace(/```json\s*/gi, "").replace(/```/g, "")
            .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
            .replace(/\u00A0/g, " ").replace(/\r\n?/g, "\n")
            .trim();
    }

    function tryParse(txt) {
        try { return JSON.parse(txt); } catch {
            try { return JSON.parse(txt.replace(/,(\s*[}\]])/g, "$1")); } catch { return null; }
        }
    }

    // Robustly extract a JSON array from raw AI text
    function parseJsonArray(raw) {
        const text = cleanJson(raw);
        const direct = tryParse(text);
        if (Array.isArray(direct) && direct.length) return direct;
        if (direct && Array.isArray(direct.questions) && direct.questions.length) return direct.questions;
        const s = text.indexOf("["), e = text.lastIndexOf("]");
        if (s !== -1 && e > s) {
            const sliced = tryParse(text.slice(s, e + 1));
            if (Array.isArray(sliced) && sliced.length) return sliced;
        }
        // Salvage individual {...} objects as last resort
        const frags = text.match(/\{[^{}]*\}/g) || [];
        const recovered = frags.map(f => tryParse(f)).filter(p => p && typeof p === "object" && !Array.isArray(p) && (p.question || p.options));
        return recovered.length ? recovered : null;
    }

    // Normalize LaTeX delimiters: \(...\) → $...$  and  \[...\] → $$...$$
    // Also fix unclosed $ (odd count → append closing $)
    function normalizeMath(val) {
        let s = String(val || "").trim();
        if (!s) return s;
        s = s.replace(/\\\(([^]*?)\\\)/g, (_, m) => `$${m}$`);
        s = s.replace(/\\\[([^]*?)\\\]/g, (_, m) => `$$${m}$$`);
        const dollarCount = (s.match(/(?<!\\)\$/g) || []).length;
        if (dollarCount % 2 === 1) s += "$";
        return s;
    }

    // Normalize a single extracted question: options, correctIndexes, math fields
    function normalizeQuestion(q) {
        if (q.question) q.question = normalizeMath(q.question);

        const opts = Array.isArray(q.options) ? q.options : [];
        q.options = [...opts, "", "", ""].slice(0, 4).map(o => normalizeMath(String(o || "")));

        // Collect correctIndexes from whatever field name the AI used
        let ci = Array.isArray(q.correctIndexes) ? [...q.correctIndexes] : [];
        if (!ci.length && typeof q.correctIndex === "number") ci = [q.correctIndex];

        if (!ci.length) {
            // Parse letter-based hints like "A", "A,C", "A and C"
            const hint = String(q.correctAnswer || q.answer || q.correct || "").trim();
            const letters = hint.match(/\b([A-Da-d])\b/g) || [];
            ci = [...new Set(letters.map(l => "abcd".indexOf(l.toLowerCase())))].filter(n => n >= 0);
        }

        ci = [...new Set(ci.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n >= 0 && n < 4))];

        // Guard: if all 4 selected but no "all of the above" option exists, reset to A
        const hasAllOfAbove = q.options.some(o => /all\s+of\s+(the\s+)?above|all\s+of\s+these|all\s+are\s+correct/i.test(o));
        if (ci.length === 4 && !hasAllOfAbove) ci = [0];
        if (!ci.length) ci = [0];

        q.correctIndexes = ci;
        q.isMultiCorrect = ci.length > 1;
        // Remove redundant fields
        delete q.correctIndex; delete q.correctAnswer; delete q.answer; delete q.correct;
        return q;
    }

    // Validate and clamp fractional imageRegion coords to [0,1]
    function validateImageRegion(r) {
        if (!r || typeof r.x !== "number" || typeof r.y !== "number"
            || typeof r.w !== "number" || typeof r.h !== "number") return null;
        if (r.w < 0.01 || r.h < 0.01) return null;
        const x = Math.max(0, Math.min(0.99, r.x));
        const y = Math.max(0, Math.min(0.99, r.y));
        const w = Math.min(1 - x, r.w);
        const h = Math.min(1 - y, r.h);
        if (w < 0.01 || h < 0.01) return null;
        return { x, y, w, h };
    }

    // ── GROQ API WRAPPER ────────────────────────────────────────────────────

    async function callGroq(parts, systemPrompt, userText, maxTokens = 8000) {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.GROQ_API_KEY },
            body: JSON.stringify({
                model: "meta-llama/llama-4-scout-17b-16e-instruct",
                max_tokens: maxTokens,
                temperature: 0.1,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: [...parts, { type: "text", text: userText }] }
                ]
            })
        });
        if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            throw new Error(e.error?.message || `Groq HTTP ${r.status}`);
        }
        const data = await r.json();
        return String(data.choices?.[0]?.message?.content || "").trim();
    }

    // ── SYSTEM PROMPTS ──────────────────────────────────────────────────────

    const answerKeyContext = manualAnswerKey?.trim()
        ? `ANSWER KEY PROVIDED:\n${manualAnswerKey.trim()}\nParse each entry as "question number → answer letter(s)" and fill correctIndexes accordingly.`
        : (answerImages || []).length
            ? `Answer key image(s) are provided alongside the question image. Use them to fill correctIndexes.`
            : `No answer key provided. Set correctIndexes to [0] as a placeholder.`;

    const EXTRACTION_SYSTEM = `You are a precise physics MCQ extractor.
Extract multiple-choice questions from the exam screenshot into a JSON array.
Return ONLY a raw JSON array — no markdown, no explanation, no extra text whatsoever.

Each element must follow this exact schema:
{
  "question": "<full question text with all math in LaTeX>",
  "options": ["<option A>", "<option B>", "<option C>", "<option D>"],
  "correctIndexes": [<0-based index: 0=A 1=B 2=C 3=D>],
  "isMultiCorrect": false,
  "hasImage": false,
  "imageRegion": null
}

EXTRACTION RULES:
1. Extract EVERY visible question — do not skip any.
2. Always provide exactly 4 options. If fewer are visible, fill remaining with "".
3. If options are embedded inline in the stem like (a)...(b)...(c)...(d)..., split them into the options array and remove them from the question text.
4. correctIndexes: 0-based array. Multi-correct e.g. A and C → [0,2], isMultiCorrect: true.
5. hasImage: set to true ONLY if the question references or contains a drawn figure, diagram, graph, or circuit in the screenshot.
6. imageRegion: when hasImage is true, provide the fractional bounding box {x, y, w, h} (all values 0.0–1.0) of the diagram region within this screenshot image. x,y is top-left corner, w,h is width/height as fractions of total image size. Set to null if you cannot locate it precisely.

EQUATION FORMATTING (mandatory — preserve ALL mathematical content):
- Inline math: $expression$  e.g. $v = u + at$, $\frac{1}{2}mv^2$
- Display/block math: $$expression$$
- Greek letters: π→$\pi$, ω→$\omega$, θ→$\theta$, α→$\alpha$, β→$\beta$, γ→$\gamma$, μ→$\mu$, λ→$\lambda$, Δ→$\Delta$, Σ→$\Sigma$, ε→$\varepsilon$, ρ→$\rho$, φ→$\phi$
- Infinity: ∞→$\infty$
- Powers: T⁴→$T^4$, v²→$v^2$, x^n stays as $x^n$
- Subscripts: v₀→$v_0$, a_x stays as $a_x$, H₂O→$H_2O$
- Fractions: always use $\frac{numerator}{denominator}$, never a/b for math fractions
- Square roots: $\sqrt{x}$, $\sqrt[3]{x}$
- Trig: $\sin\theta$, $\cos\theta$, $\tan\theta$
- Vectors: $\vec{F}$, $\hat{n}$
- Units in text: keep as plain text unless they contain math (e.g. m/s² → m/s² is fine in text, $ms^{-2}$ in equations)
- Do NOT omit or approximate any symbol or formula.

${answerKeyContext}`;

    const COUNT_SYSTEM = `You are a question counter. Your only job is to count how many distinct MCQ (multiple-choice) questions are visible in the image.
Reply with a SINGLE INTEGER and absolutely nothing else. No words, no punctuation.`;

    // ── PHASE 1: COUNT questions per image in parallel (establishes hard cap) ─

    const perImageParts = questionImages.map(img => [toImgPart(img)]);
    const answerImgParts = (answerImages || []).map(toImgPart);

    const perImageCounts = await Promise.all(
        perImageParts.map(async (parts, i) => {
            try {
                const raw = await callGroq(parts, COUNT_SYSTEM,
                    "How many MCQ questions are in this image? Reply with a single integer only.", 10);
                const n = parseInt(raw.trim(), 10);
                const count = Number.isInteger(n) && n > 0 && n <= 200 ? n : null;
                console.log(`[extract] Image ${i + 1} count: ${count ?? "unknown"}`);
                return count;
            } catch (e) {
                console.warn(`[extract] Count failed for image ${i + 1}:`, e.message);
                return null;
            }
        })
    );

    const totalExpected = perImageCounts.every(c => c === null)
        ? null
        : perImageCounts.reduce((s, c) => s + (c || 0), 0);

    console.log(`[extract] Per-image counts: [${perImageCounts}] → totalExpected: ${totalExpected ?? "unknown"}`);

    // ── PHASE 2: EXTRACT questions from each image independently ─────────────

    const extracted = [];
    const seenKeys = new Set();

    function questionKey(q) {
        const stem = String(q?.question || "").trim().toLowerCase().slice(0, 120);
        const opts = (q?.options || []).map(o => String(o || "").trim().toLowerCase().slice(0, 40)).join("|");
        return `${stem}||${opts}`;
    }

    function mergeUnique(arr, cap) {
        if (!Array.isArray(arr)) return 0;
        let added = 0;
        for (const q of arr) {
            if (cap !== null && extracted.length >= cap) break;
            const key = questionKey(q);
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                extracted.push(q);
                added++;
            }
        }
        return added;
    }

    for (let i = 0; i < questionImages.length; i++) {
        const imgCap    = perImageCounts[i];   // exact count for this image (or null)
        const imgParts  = [...perImageParts[i], ...answerImgParts];

        // Main extraction call
        const mainPrompt = imgCap !== null
            ? `This image contains exactly ${imgCap} MCQ questions. Extract all ${imgCap} of them — do not stop early and do not add extras.`
            : `Extract ALL MCQ questions visible in this image.`;

        let added = 0;
        try {
            const raw = await callGroq(imgParts, EXTRACTION_SYSTEM, mainPrompt);
            const result = parseJsonArray(raw);
            if (result) {
                added = mergeUnique(result, totalExpected);
                console.log(`[extract] Image ${i + 1}: got ${result.length} from AI, added ${added} unique`);
            } else {
                console.warn(`[extract] Image ${i + 1}: could not parse AI response`);
            }
        } catch (e) {
            console.warn(`[extract] Image ${i + 1} main extraction failed:`, e.message);
        }

        // Retry pass: if we know the count and came up short, ask for only the missing ones
        if (imgCap !== null && added < imgCap && extracted.length < (totalExpected ?? Infinity)) {
            const missing = imgCap - added;
            const recentStems = extracted.slice(-added || -imgCap).map(q =>
                `- ${String(q.question || "").replace(/\s+/g, " ").slice(0, 80)}`
            ).join("\n");
            const retryPrompt = [
                `You returned ${added} questions but this screenshot contains ${imgCap}.`,
                `The ${missing} missing question(s) were not extracted. Find and return ONLY them.`,
                recentStems ? `Questions already extracted (do NOT repeat these):\n${recentStems}` : "",
                `Return a JSON array of only the missing questions.`
            ].filter(Boolean).join("\n\n");

            try {
                const retryRaw = await callGroq(imgParts, EXTRACTION_SYSTEM, retryPrompt);
                const retryResult = parseJsonArray(retryRaw);
                if (retryResult) {
                    const retryAdded = mergeUnique(retryResult, totalExpected);
                    console.log(`[extract] Image ${i + 1} retry: recovered ${retryAdded} more`);
                }
            } catch (e) {
                console.warn(`[extract] Image ${i + 1} retry failed:`, e.message);
            }
        }
    }

    if (!extracted.length)
        return res.status(500).json({ error: "Could not extract any questions. Please try again with a cleaner screenshot." });

    // ── PHASE 3: HARD CAP — never return more than what was counted ──────────

    let questions = extracted;
    if (totalExpected !== null && questions.length > totalExpected) {
        console.warn(`[extract] Trimming ${questions.length} → ${totalExpected} (hard cap)`);
        questions = questions.slice(0, totalExpected);
    }

    // ── PHASE 4: NORMALIZE — equations, options length, correctIndexes ───────

    questions = questions.map(normalizeQuestion);

    // ── PHASE 5: DIAGRAM REGIONS — validate AI-provided coords for OpenCV ────
    // The frontend uses imageRegion for Tier-1 (precise AI crop).
    // Invalid coords → null → frontend falls back to OpenCV Tier-2 / pixel Tier-3.

    let offset = 0;
    questions = questions.map((q, qi) => {
        if (!q.hasImage) { q.imageRegion = null; return q; }

        q.imageRegion = validateImageRegion(q.imageRegion);

        // Assign which source screenshot index this question's diagram is on.
        // We track a running offset across images using the per-image counts.
        if (questionImages.length > 1) {
            let srcIdx = 0, cum = 0;
            for (let i = 0; i < perImageCounts.length; i++) {
                cum += perImageCounts[i] || Math.ceil(questions.length / questionImages.length);
                if (qi < cum) { srcIdx = i; break; }
                srcIdx = i;
            }
            q.imageSourceIndex = srcIdx;
        } else {
            q.imageSourceIndex = 0;
        }

        return q;
    });

    const withImg    = questions.filter(q => q.hasImage).length;
    const withRegion = questions.filter(q => q.imageRegion).length;
    console.log(`[extract] Returning ${questions.length} questions. hasImage: ${withImg}, AI imageRegion: ${withRegion}`);

    res.json({ questions });
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
