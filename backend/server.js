const express = require("express");
const session = require("express-session");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@libsql/client");
const cloudinary = require("cloudinary").v2;

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);

// ── SECURITY: Required env vars
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

// ── CLOUDINARY HELPER: upload base64 image, return secure URL
async function uploadImageToCloudinary(base64String) {
    if (!base64String) return null;
    if (base64String.startsWith("http")) return base64String; // already a URL
    try {
        // Detect mime type from base64 header
        let dataUri = base64String;
        if (!base64String.startsWith("data:")) {
            const mime = base64String.startsWith("/9j/") ? "image/jpeg" : "image/png";
            dataUri = `data:${mime};base64,${base64String}`;
        }
        const result = await cloudinary.uploader.upload(dataUri, {
            folder: "grip_physics",
        });
        return result.secure_url;
    } catch (e) {
        console.error("Cloudinary upload error:", e.message);
        return base64String; // fallback: keep original if upload fails
    }
}

// Upload all images in a question array to Cloudinary
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

// ── DB INIT: Create tables if they don't exist
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

// ── CUSTOM SESSION STORE backed by Turso
class TursoSessionStore extends session.Store {
    async get(sid, cb) {
        try {
            const row = await db.execute({
                sql: "SELECT data, expires FROM sessions WHERE sid = ?",
                args: [sid],
            });
            if (!row.rows.length) return cb(null, null);
            const { data, expires } = row.rows[0];
            if (Date.now() > expires) {
                await db.execute({ sql: "DELETE FROM sessions WHERE sid = ?", args: [sid] });
                return cb(null, null);
            }
            cb(null, JSON.parse(data));
        } catch (e) {
            cb(e);
        }
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

// ── MIDDLEWARE
app.use(cors({
    origin: ["https://grip-physics.onrender.com", "https://grip-physics.vercel.app", "http://localhost:3000", "http://localhost:8080", "http://127.0.0.1:3000", "http://127.0.0.1:8080"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["set-cookie"],
    maxAge: 86400,
}));
app.use(express.json({ limit: "60mb" }));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    name: "grip.sid",
    store: new TursoSessionStore(),
    cookie: {
        secure: true,
        sameSite: "none",
        httpOnly: true,
        maxAge: 8 * 60 * 60 * 1000,
    },
}));

// ── SECURITY HEADERS
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Origin: ${req.headers.origin}`);
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

setInterval(() => {
    const c = Date.now() - 60 * 60 * 1000;
    for (const [k, v] of rateLimitMap.entries()) { const f = v.filter((t) => t > c); if (!f.length) rateLimitMap.delete(k); else rateLimitMap.set(k, f); }
    for (const [k, v] of loginFailMap.entries()) { const f = v.filter((t) => t > c); if (!f.length) loginFailMap.delete(k); else loginFailMap.set(k, f); }
    // Clean expired sessions
    db.execute({ sql: "DELETE FROM sessions WHERE expires < ?", args: [Date.now()] }).catch(() => { });
}, 10 * 60 * 1000);

// ── QUESTION CACHE (same logic as before)
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
    try {
        d.questions = JSON.parse(row.questions_json || "[]");
    } catch { d.questions = []; }

    if (d.questions && d.questions.length > 0) {
        d.questions = d.questions.map((q) => {
            if (!q.correctIndexes || !q.correctIndexes.length)
                q.correctIndexes = [typeof q.correctIndex === "number" ? q.correctIndex : 0];
            // Preserve explicit isMultiCorrect flag; fallback to checking array length
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
    console.log("requireAdmin check - sessionID:", req.sessionID, "admin:", req.session?.admin);
    if (!req.session) return res.status(403).json({ error: "No session" });
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

// ── LOGIN
app.post("/api/admin/login", loginRateLimit, (req, res) => {
    console.log("Login attempt from origin:", req.headers.origin);
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
            console.log("Login successful, session ID:", req.sessionID);
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
    answers.forEach((ans, i) => {
        if (isCorrect(questionsForScoring[i], ans)) correctCount++;
    });
    const totalQuestions = questionsForScoring.length;
    const now = Date.now();

    await db.execute({ sql: "INSERT INTO attempts (mobile, chapter, lecture, time) VALUES (?, ?, ?, ?)", args: [mobile, chapter || null, lecture, now] });
    await db.execute({
        sql: `INSERT INTO students (mobile, lecture, name, place, class_name, chapter, answers_json, correct_count, total_questions, time)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(mobile, lecture) DO UPDATE SET
                name=excluded.name, place=excluded.place, class_name=excluded.class_name,
                chapter=excluded.chapter, answers_json=excluded.answers_json,
                correct_count=excluded.correct_count, total_questions=excluded.total_questions, time=excluded.time`,
        args: [mobile, lecture, name, place, className, chapter || null, JSON.stringify(answers), correctCount, totalQuestions, now],
    });
    res.json({ success: true, correctCount, totalQuestions });
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
    let { chapter, lecture, topic, questions } = req.body;
    if (!lecture || !Array.isArray(questions) || !questions.length) return res.status(400).json({ error: "Missing" });

    // Upload images to Cloudinary
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
        const existingQs = JSON.parse(existing.questions_json || "[]");
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
});

app.delete("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
    const chapter = decodeURIComponent(req.params.chapter), lecture = decodeURIComponent(req.params.lecture);
    await db.execute({ sql: "DELETE FROM questions WHERE lecture = ? AND (chapter = ? OR chapter IS NULL OR chapter = '')", args: [lecture, chapter] });
    delete questionCache[`${chapter}::${lecture}`];
    res.json({ success: true });
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
            const r = await db.execute({
                sql: "SELECT * FROM questions WHERE chapter = ? AND lecture = ? LIMIT 1",
                args: [chapterForMatch, lecture]
            });
            existing = r.rows[0] || null;
        } else {
            const r = await db.execute({
                sql: "SELECT * FROM questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1",
                args: [lecture]
            });
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
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/admin/mass-delete", requireAdmin, async (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "No items" });
    let deleted = 0;
    for (const { chapter, lecture } of items) {
        await db.execute({ sql: "DELETE FROM questions WHERE lecture = ? AND (chapter = ? OR chapter IS NULL OR chapter = '')", args: [lecture, chapter || null] });
        delete questionCache[`${chapter || ""}::${lecture}`];
        deleted++;
    }
    res.json({ success: true, deleted });
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

        const questionsResult = await db.execute({
            sql: "UPDATE questions SET chapter = ? WHERE chapter = ?",
            args: [newName, oldName]
        });
        const studentsResult = await db.execute({
            sql: "UPDATE students SET chapter = ? WHERE chapter = ?",
            args: [newName, oldName]
        });
        const attemptsResult = await db.execute({
            sql: "UPDATE attempts SET chapter = ? WHERE chapter = ?",
            args: [newName, oldName]
        });

        const questionsUpdated = questionsResult.rowsAffected || 0;
        const studentsUpdated = studentsResult.rowsAffected || 0;
        const attemptsUpdated = attemptsResult.rowsAffected || 0;
        const totalUpdated = questionsUpdated + studentsUpdated + attemptsUpdated;

        if (!totalUpdated) return res.status(404).json({ error: "Chapter not found in questions, students, or attempts." });

        await loadQuestions();

        res.json({
            success: true,
            updated: {
                questions: questionsUpdated,
                students: studentsUpdated,
                attempts: attemptsUpdated,
                total: totalUpdated,
            },
        });
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

app.post("/api/admin/extract", requireAdmin, async (req, res) => {
    const { questionImages, answerImages, manualAnswerKey } = req.body;
    if (!questionImages || !Array.isArray(questionImages) || !questionImages.length) return res.status(400).json({ error: "At least one question image required" });
    if (questionImages.length > 10) return res.status(400).json({ error: "You can upload up to 10 question screenshots." });
    if (Array.isArray(answerImages) && answerImages.length > 10) return res.status(400).json({ error: "You can upload up to 10 answer key screenshots." });
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not set on server" });
    function getMime(b64) { if (b64.startsWith("/9j/")) return "image/jpeg"; if (b64.startsWith("iVBORw")) return "image/png"; return "image/jpeg"; }
    let answerKeyDesc = manualAnswerKey?.trim() ? `The answer key is: ${manualAnswerKey.trim()}. Parse it as question number → answer letter(s).` : answerImages?.length ? `The last ${answerImages.length} image(s) are the answer key.` : "No answer key provided — do your best to identify correct answers from context.";
    const prompt = `You are a physics teacher extracting MCQ questions from Indian exam papers (JEE/NEET/HC Verma style).\n\n${answerKeyDesc}\n\nTASK: Extract EVERY question from ALL question images and match each to its answer.\nOutput ONLY a raw JSON array. No markdown, no explanation.\n\nMOST CRITICAL RULE — SEPARATING QUESTION FROM OPTIONS:\nIndian exam papers have TWO styles of writing options:\n\nSTYLE 1 — Options listed BELOW the question separately:\n  Q: "Which law states F=ma?"\n  (A) Newton's 1st  (B) Newton's 2nd  (C) Newton's 3rd  (D) Kepler's\n  → question = "Which law states F=ma?"\n  → options = ["Newton's 1st", "Newton's 2nd", "Newton's 3rd", "Kepler's"]\n\nSTYLE 2 — Options EMBEDDED inside question text as (a)(b)(c)(d):\n  "In a semiconductor (a) no free electrons at 0K (b) more electrons than conductor (c) free electrons increase with temp (d) it is an insulator"\n  → question = "In a semiconductor"  [STEM ONLY — stop before the first (a)]\n  → options = ["no free electrons at 0K", "more electrons than conductor", "free electrons increase with temp", "it is an insulator"]\n\n  "Match the following: (a) A (b) B (c) C (d) D"\n  → question = "Match the following:"\n  → options = ["A", "B", "C", "D"]\n\nCRITICAL ENFORCEMENT ON OPTIONS:\n1. IF the option text is JUST A SINGLE LETTER (e.g., "(a) A", "(b) B"), you MUST extract that exact letter (e.g. "A"). Do NOT leave the option blank.\n2. Do NOT mistake single-character options as part of the "(a)" prefix. The letter after the "(a)" is the answer text.\n3. Identify all 4 options exactly as written. The options array MUST always have exactly 4 strings.\n\nJSON format per question:\n{"question":"stem only","options":["A text","B text","C text","D text"],"correctIndexes":[0],"isMultiCorrect":false,"hasImage":false}\n\nLaTeX math (KaTeX in $...$):\n- pi→$\\pi$, omega→$\\omega$, epsilon→$\\varepsilon$, T^4→$T^4$, T_1→$T_1$\n- cos→$\\cos$, sin→$\\sin$, 1/2 mv^2→$\\frac{1}{2}mv^2$\n- s^{-1}→$s^{-1}$, E_0 cos(100 pi t)→$E_0\\cos(100\\pi t)$\n- Do NOT add trailing $ at end of plain text sentences\n\nOTHER RULES:\n- hasImage:true if question has a diagram/figure/graph\n- correctIndexes: 0=A,1=B,2=C,3=D. Numbers 1/2/3/4 → 0/1/2/3\n- A,C in answer key → correctIndexes:[0,2], isMultiCorrect:true\n- Extract all questions in the order they appear`;
    try {
        const contentParts = [];
        for (const img of questionImages) contentParts.push({ type: "image_url", image_url: { url: `data:${getMime(img)};base64,${img}` } });
        for (const img of (answerImages || [])) contentParts.push({ type: "image_url", image_url: { url: `data:${getMime(img)};base64,${img}` } });
        contentParts.push({ type: "text", text: prompt });
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.GROQ_API_KEY }, body: JSON.stringify({ model: "meta-llama/llama-4-scout-17b-16e-instruct", max_tokens: 6000, temperature: 0.1, messages: [{ role: "user", content: contentParts }] }) });
        if (!r.ok) { const e = await r.json(); const msg = (e.error && e.error.message) || "Groq error"; console.error("Groq API error:", msg); return res.status(502).json({ error: msg }); }
        const data = await r.json();
        const raw = String((data.choices?.[0]?.message?.content) || "").trim();

        const cleanJsonText = (txt) => String(txt || "")
            .replace(/```json/gi, "```")
            .replace(/```/g, "")
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/\u00A0/g, " ")
            .replace(/\r\n?/g, "\n")
            .replace(/\s*\$\\\$\s*"/g, '"')
            .replace(/\s*\$\\s\$\s*"/g, '"')
            .trim();

        const tryParseJson = (txt) => {
            try {
                return JSON.parse(txt);
            } catch {
                try {
                    const fixed = txt.replace(/,\s*]/g, "]").replace(/,\s*}/g, "}");
                    return JSON.parse(fixed);
                } catch {
                    return null;
                }
            }
        };

        const parseAiQuestions = (inputText) => {
            const text = cleanJsonText(inputText);
            const candidates = [];

            candidates.push(text);

            const arrStart = text.indexOf("[");
            const arrEnd = text.lastIndexOf("]");
            if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
                candidates.push(text.slice(arrStart, arrEnd + 1));
            }

            const codeBlockMatch = text.match(/\[[\s\S]*\]/m);
            if (codeBlockMatch?.[0]) candidates.push(codeBlockMatch[0]);

            for (const cand of candidates) {
                const parsed = tryParseJson(cand);
                if (Array.isArray(parsed) && parsed.length) return parsed;
                if (parsed && Array.isArray(parsed.questions) && parsed.questions.length) return parsed.questions;
            }

            // Last resort: salvage individual JSON objects from mixed text.
            const fragments = text.match(/\{[\s\S]*?\}/g) || [];
            const recovered = [];
            for (const frag of fragments) {
                const parsedFrag = tryParseJson(frag);
                if (parsedFrag && typeof parsedFrag === "object" && !Array.isArray(parsedFrag) && (parsedFrag.question || parsedFrag.options)) {
                    recovered.push(parsedFrag);
                }
            }
            return recovered.length ? recovered : null;
        };

        let parsed = parseAiQuestions(raw);
        if (!parsed) {
            console.error("Extract parse failed. Raw AI output sample:", raw.slice(0, 500));
            return res.status(500).json({ error: "Could not parse AI response. Please try again once; if it still fails, use manual answer key or cleaner screenshots." });
        }
        if (!Array.isArray(parsed) || !parsed.length) return res.status(500).json({ error: "No questions found." });
        parsed = parsed.map((q) => {
            if (q.question) q.question = q.question.replace(/\s*\$\\\$\s*$/, "").trim();

            const options = Array.isArray(q.options) ? q.options : [];
            q.options = [...options, "", "", ""].slice(0, 4).map((o) => (o || "").replace(/\s*\$\\\$\s*$/, "").trim());

            let ci = Array.isArray(q.correctIndexes) ? q.correctIndexes : [];
            if (!ci.length && typeof q.correctIndex === "number") ci = [q.correctIndex];

            const answerHint = String(q.correctAnswer || q.answer || q.correct || "").trim().toLowerCase();
            if (!ci.length) {
                const m = answerHint.match(/\b([abcd])\b/i);
                if (m) ci = ["abcd".indexOf(m[1].toLowerCase())];
            }

            ci = [...new Set(ci.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n < 4))];

            const hasAllOfAboveOption = q.options.some((opt) => /all\s+of\s+the\s+above|all\s+of\s+these|all\s+are\s+correct/i.test(opt));
            const explicitAllOptions = /all\s+of\s+the\s+above|all\s+options|all\s+are\s+correct|\ba\s*,\s*b\s*,\s*c\s*,\s*d\b|\b1\s*,\s*2\s*,\s*3\s*,\s*4\b/.test(answerHint);

            // OCR often reads answer "A" as "all"; unless it's explicitly "all of the above", treat it as A.
            if ((answerHint === "all" || ci.length === 4) && !hasAllOfAboveOption && !explicitAllOptions) {
                ci = [0];
            }

            if (!ci.length) ci = [0];

            q.correctIndexes = ci;
            q.isMultiCorrect = ci.length > 1;
            return q;
        });
        res.json({ questions: parsed });
    } catch (e) { console.error("Extract error:", e); res.status(500).json({ error: "Server error: " + e.message }); }
});

// ── Catch-all
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
    if (err?.type === "entity.too.large") {
        return res.status(413).json({ error: "Uploaded images are too large. Use fewer/smaller images (max 10)." });
    }
    next(err);
});
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
            console.log("Security: lockout, timing-safe login, security headers active");
        });
    })
    .catch((err) => {
        console.error("FATAL: Failed to initialize DB:", err);
        process.exit(1);
    });
