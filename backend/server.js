const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);

const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "admin123";

app.use(cors({
    origin: ["https://grip-physics.onrender.com", "https://grip-physics.vercel.app"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "10mb" }));
app.use(session({
    secret: process.env.SESSION_SECRET || "grip_secret_key_change_in_production",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: { secure: true, sameSite: "none", httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

/* ---- RATE LIMITING ---- */
const rateLimitMap = new Map();
function rateLimit(windowMs, maxRequests) {
    return (req, res, next) => {
        const key = req.ip + req.path;
        const now = Date.now();
        if (!rateLimitMap.has(key)) rateLimitMap.set(key, []);
        const requests = rateLimitMap.get(key).filter(t => t > now - windowMs);
        requests.push(now);
        rateLimitMap.set(key, requests);
        if (requests.length > maxRequests) return res.status(429).json({ error: "Too many requests." });
        next();
    };
}
setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [k, times] of rateLimitMap.entries()) {
        const f = times.filter(t => t > cutoff);
        if (!f.length) rateLimitMap.delete(k); else rateLimitMap.set(k, f);
    }
}, 5 * 60 * 1000);

/* ---- MONGODB ---- */
console.log("MONGO_URI:", process.env.MONGO_URI ? "present" : "missing");
mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/grip_physics", { dbName: "grip_physics" })
    .then(() => console.log("MongoDB connected"))
    .catch(err => console.error("MongoDB error:", err));

/* ---- SCHEMAS  (strict:false keeps old fields alive) ---- */
const QuestionSchema = new mongoose.Schema({
    chapter:      { type: String, index: true },
    lecture:      { type: String, index: true },
    questions:    [{ question: String, options: [String], correctIndex: Number }],
    // OLD single-question fields kept so old docs don't lose data
    question:     String,
    options:      [String],
    correctIndex: Number,
    updatedAt:    { type: Number, default: Date.now }
}, { strict: false });

const StudentSchema = new mongoose.Schema({
    name: String, mobile: { type: String, index: true },
    place: String, className: String,
    chapter: String, lecture: { type: String, index: true },
    // NEW
    answers: [Number], correctCount: Number, totalQuestions: Number,
    // OLD
    answer: Number, correct: Boolean,
    time: Number
}, { strict: false });
StudentSchema.index({ mobile: 1, lecture: 1 });

const AttemptSchema = new mongoose.Schema({
    mobile: { type: String, index: true },
    chapter: String,
    lecture: { type: String, index: true },
    time: Number
}, { strict: false });
AttemptSchema.index({ mobile: 1, lecture: 1 });

const Question = mongoose.model("Question", QuestionSchema);
const Student   = mongoose.model("Student",  StudentSchema);
const Attempt   = mongoose.model("Attempt",  AttemptSchema);

/* ---- NORMALIZE HELPERS ---- */

// Converts old single-question doc  →  new { questions:[...] } shape
function normalizeQuestion(doc) {
    if (!doc) return null;
    const d = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
    if (d.questions && d.questions.length > 0) return d;       // already new format
    if (d.question) {                                           // old format
        d.questions = [{ question: d.question, options: d.options || [], correctIndex: d.correctIndex ?? 0 }];
    }
    return d;
}

// Converts old { answer, correct }  →  new { answers[], correctCount, totalQuestions }
function normalizeStudent(doc) {
    const s = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
    if (typeof s.correctCount === "number") return s;           // already new format
    if (typeof s.answer === "number") {                         // old single-answer format
        s.answers       = [s.answer];
        s.correctCount  = s.correct === true ? 1 : 0;
        s.totalQuestions = 1;
    }
    return s;
}

/* ---- QUESTION CACHE ---- */
let questionCache = {};

async function loadQuestions() {
    const all = await Question.find().lean();
    all.forEach(q => {
        const n = normalizeQuestion(q);
        // store under both keys so lookup works regardless of whether chapter is set
        questionCache[`${q.chapter || ""}::${q.lecture}`] = n;
        if (!questionCache[`::${q.lecture}`]) questionCache[`::${q.lecture}`] = n;
    });
    console.log(`Cached ${all.length} questions`);
}
mongoose.connection.once("open", loadQuestions);

/* ---- HELPER: find question from cache or DB ---- */
async function findQuestion(chapter, lecture) {
    const key = `${chapter || ""}::${lecture}`;
    if (questionCache[key]) return questionCache[key];
    // Try DB with chapter first, then without
    let doc = chapter ? await Question.findOne({ chapter, lecture }).lean() : null;
    if (!doc) doc = await Question.findOne({ lecture }).lean();   // catches old docs with no chapter
    if (!doc) return null;
    const n = normalizeQuestion(doc);
    questionCache[key] = n;
    questionCache[`::${lecture}`] = n;
    return n;
}

/* ---- ADMIN AUTH ---- */
function requireAdmin(req, res, next) {
    if (!req.session.admin) return res.status(403).json({ error: "Unauthorized" });
    next();
}

/* ======================================================
   ROUTES
   ====================================================== */

/* -- Admin login -- */
app.post("/api/admin/login", rateLimit(15 * 60 * 1000, 10), (req, res) => {
    if (req.body.passcode !== ADMIN_PASSCODE) return res.status(401).json({ error: "Invalid passcode" });
    req.session.admin = true;
    res.json({ success: true });
});

app.post("/api/admin/logout", (req, res) => req.session.destroy(() => res.json({ message: "Logged out" })));

/* -- Chapters (only non-null) -- */
app.get("/api/chapters", async (req, res) => {
    try {
        const chapters = await Question.distinct("chapter");
        res.json(chapters.filter(Boolean).sort());
    } catch { res.status(500).json({ error: "Failed" }); }
});

/* -- Lectures for a chapter -- */
app.get("/api/lectures/:chapter", async (req, res) => {
    try {
        const docs = await Question.find({ chapter: req.params.chapter }, { lecture: 1 }).lean();
        res.json(docs.map(d => d.lecture).filter(Boolean).sort((a, b) => Number(a) - Number(b)));
    } catch { res.status(500).json({ error: "Failed" }); }
});

/* -- Get question (supports old + new) -- */
app.get("/api/question/:chapter/:lecture", async (req, res) => {
    try {
        const q = await findQuestion(req.params.chapter, req.params.lecture);
        if (!q) return res.status(404).json({ error: "Lecture not found" });
        res.json(q);
    } catch (e) { console.error(e); res.status(500).json({ error: "Failed" }); }
});

/* -- Check attempt -- */
app.post("/api/check-attempt", async (req, res) => {
    const { mobile, chapter, lecture } = req.body;
    if (!mobile || !lecture) return res.status(400).json({ error: "Missing fields" });

    const q = await findQuestion(chapter, lecture);
    if (!q) return res.json({ allowed: false, time: 0 });

    // Match on mobile+lecture; chapter may be absent in old attempt docs
    const lastAttempt = await Attempt.findOne({ mobile, lecture }).sort({ time: -1 }).lean();
    if (!lastAttempt) return res.json({ allowed: true, time: 0 });

    const attemptTime  = lastAttempt.time || 0;
    const questionTime = q.updatedAt || 0;

    res.json(attemptTime >= questionTime ? { allowed: false, time: attemptTime } : { allowed: true, time: attemptTime });
});

/* -- Submit attempt -- */
app.post("/api/submit-attempt", rateLimit(60 * 1000, 5), async (req, res) => {
    const { mobile, chapter, lecture, selectedAnswers, name, place, className } = req.body;
    if (!mobile || !lecture) return res.status(400).json({ error: "Missing fields" });

    const q = await findQuestion(chapter, lecture);
    if (!q) return res.status(404).json({ error: "Lecture not found" });

    const lastAttempt = await Attempt.findOne({ mobile, lecture }).sort({ time: -1 }).lean();
    if (lastAttempt && lastAttempt.time >= (q.updatedAt || 0)) return res.json({ allowed: false });

    const answers = Array.isArray(selectedAnswers) ? selectedAnswers : [];
    let correctCount = 0;
    answers.forEach((ans, i) => {
        if (q.questions[i] && ans === q.questions[i].correctIndex) correctCount++;
    });

    const now = Date.now();
    await Attempt.create({ mobile, chapter: chapter || null, lecture, time: now });
    await Student.findOneAndUpdate(
        { mobile, lecture },
        { $set: { name, mobile, place, className, chapter: chapter || null, lecture, answers, correctCount, totalQuestions: q.questions.length, time: now } },
        { upsert: true, new: true }
    );

    res.json({ success: true, correctCount, totalQuestions: q.questions.length });
});

/* -- Student register (upsert, keeps old data intact) -- */
app.post("/api/student-register", async (req, res) => {
    const { name, mobile, place, className, chapter, lecture } = req.body;
    if (!name || !mobile || !lecture) return res.status(400).json({ error: "Missing fields" });
    await Student.findOneAndUpdate(
        { mobile, lecture },
        { $set: { name, mobile, place, className, chapter: chapter || null, lecture, time: Date.now() } },
        { upsert: true, new: true }
    );
    res.json({ success: true });
});

/* -- Add / update question -- */
app.post("/api/admin/add-question", requireAdmin, async (req, res) => {
    const { chapter, lecture, questions, replace } = req.body;
    if (!lecture || !Array.isArray(questions) || !questions.length) {
        return res.status(400).json({ error: "Missing fields" });
    }

    // Find existing — first with chapter, then without (old docs have no chapter)
    let existing = chapter ? await Question.findOne({ chapter, lecture }) : null;
    if (!existing) existing = await Question.findOne({ lecture });   // catches old single-lecture docs

    if (existing && !replace) return res.status(409).json({ warning: "Lecture already exists" });

    const updateData = { chapter: chapter || null, lecture, questions, updatedAt: Date.now() };

    if (existing) {
        // $unset removes the old flat fields so they don't confuse normalizeQuestion
        await Question.updateOne({ _id: existing._id }, {
            $set: updateData,
            $unset: { question: "", options: "", correctIndex: "" }
        });
    } else {
        await Question.create(updateData);
    }

    // Refresh cache
    const updated = await Question.findOne(existing ? { _id: existing._id } : { lecture }).lean();
    const n = normalizeQuestion(updated);
    questionCache[`${chapter || ""}::${lecture}`] = n;
    questionCache[`::${lecture}`] = n;

    res.json({ success: true });
});

/* -- Delete question -- */
app.delete("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
    const chapter  = decodeURIComponent(req.params.chapter);
    const lecture  = decodeURIComponent(req.params.lecture);
    await Question.deleteMany({ lecture, $or: [{ chapter }, { chapter: null }, { chapter: { $exists: false } }] });
    delete questionCache[`${chapter}::${lecture}`];
    delete questionCache[`::${lecture}`];
    res.json({ success: true });
});

/* -- All students (normalized — shows old + new records) -- */
app.get("/api/admin/students", requireAdmin, async (req, res) => {
    try {
        const all = await Student.find({}).lean();
        res.json(all.map(normalizeStudent));
    } catch { res.status(500).json({ error: "Failed" }); }
});

/* -- All questions (normalized) -- */
app.get("/api/admin/questions", requireAdmin, async (req, res) => {
    try {
        const all = await Question.find({}).lean();
        res.json(all.map(normalizeQuestion));
    } catch { res.status(500).json({ error: "Failed" }); }
});

/* -- AI extract proxy -- */
app.post("/api/admin/extract", requireAdmin, async (req, res) => {
    const { questionImageBase64, answerImageBase64 } = req.body;
    if (!questionImageBase64 || !answerImageBase64) return res.status(400).json({ error: "Both images required" });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

    try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({
                model: "claude-opus-4-6", max_tokens: 4000,
                messages: [{ role: "user", content: [
                    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: questionImageBase64 } },
                    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: answerImageBase64 } },
                    { type: "text", text: `First image = questions, second image = answer key. Extract ALL questions and match answers. Return ONLY a raw JSON array, no markdown.\nFormat: [{"question":"...","options":["A text","B text","C text","D text"],"correctIndex":0}]\nRules: correctIndex 0=A,1=B,2=C,3=D. Write equations in plain text. All 4 options per question.` }
                ]}]
            })
        });
        if (!r.ok) { const e = await r.json(); return res.status(502).json({ error: e.error?.message || "Anthropic error" }); }
        const data = await r.json();
        const text = data.content.map(c => c.text || "").join("").trim();
        let parsed;
        try { parsed = JSON.parse(text); }
        catch { const m = text.match(/\[[\s\S]*\]/); if (m) parsed = JSON.parse(m[0]); else return res.status(500).json({ error: "Could not parse AI response" }); }
        res.json({ questions: parsed });
    } catch (e) { console.error(e); res.status(500).json({ error: "Server error" }); }
});

/* ---- START ---- */
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
