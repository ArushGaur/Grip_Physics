const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);

// ── SECURITY: No hardcoded fallback password
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE;
if (!ADMIN_PASSCODE || ADMIN_PASSCODE.length < 12) {
    console.error("FATAL: ADMIN_PASSCODE env var is missing or too short (min 12 chars). Set it in Render environment variables.");
    process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    console.error("FATAL: SESSION_SECRET env var is missing or too short (min 32 chars). Set it in Render environment variables.");
    process.exit(1);
}

app.use(cors({ 
    origin: ["https://grip-physics.onrender.com", "https://grip-physics.vercel.app", "http://localhost:3000", "http://localhost:8080", "http://127.0.0.1:3000", "http://127.0.0.1:8080"],
    credentials: true, 
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], 
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["set-cookie"],
    maxAge: 86400
}));
app.use(express.json({ limit: "20mb" }));
app.use(session({ 
    secret: SESSION_SECRET, 
    resave: false, 
    saveUninitialized: false, 
    proxy: true, 
    name: 'grip.sid',
    store: MongoStore.create({
        mongoUrl: process.env.MONGO_URI || "mongodb://127.0.0.1:27017/grip_physics",
        dbName: "grip_physics",
        ttl: 8 * 60 * 60,
        autoRemove: 'native'
    }),
    cookie: { 
        secure: true, 
        sameSite: "none", 
        httpOnly: true, 
        maxAge: 8 * 60 * 60 * 1000
    } 
}));

// ── SECURITY: Security headers on every response
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Origin: ${req.headers.origin}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    next();
});

// ── SECURITY: Rate limiter
const rateLimitMap = new Map();
const loginFailMap = new Map();

function rateLimit(windowMs, max) {
    return (req, res, next) => {
        const key = req.ip + req.path, now = Date.now();
        if (!rateLimitMap.has(key)) rateLimitMap.set(key, []);
        const reqs = rateLimitMap.get(key).filter(t => t > now - windowMs);
        reqs.push(now); rateLimitMap.set(key, reqs);
        if (reqs.length > max) return res.status(429).json({ error: "Too many requests. Try again later." });
        next();
    };
}

// ── SECURITY: Login lockout — 5 attempts per 15 min, then 1 hour block
function loginRateLimit(req, res, next) {
    const ip = req.ip, now = Date.now();
    const WINDOW = 15 * 60 * 1000, LOCKOUT = 60 * 60 * 1000, MAX = 5;
    if (!loginFailMap.has(ip)) loginFailMap.set(ip, []);
    const attempts = loginFailMap.get(ip).filter(t => t > now - LOCKOUT);
    loginFailMap.set(ip, attempts);
    if (attempts.filter(t => t > now - WINDOW).length >= MAX) {
        const wait = Math.ceil((attempts[0] + LOCKOUT - now) / 60000);
        return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait} minute(s).` });
    }
    next();
}
function recordLoginFailure(ip) { if (!loginFailMap.has(ip)) loginFailMap.set(ip, []); loginFailMap.get(ip).push(Date.now()); }

setInterval(() => {
    const c = Date.now() - 60 * 60 * 1000;
    for (const [k, v] of rateLimitMap.entries()) { const f = v.filter(t => t > c); if (!f.length) rateLimitMap.delete(k); else rateLimitMap.set(k, f); }
    for (const [k, v] of loginFailMap.entries()) { const f = v.filter(t => t > c); if (!f.length) loginFailMap.delete(k); else loginFailMap.set(k, f); }
}, 10 * 60 * 1000);

mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/grip_physics", { dbName: "grip_physics" })
    .then(() => console.log("MongoDB connected")).catch(err => console.error("MongoDB error:", err));

const QuestionSchema = new mongoose.Schema({
    chapter: { type: String, index: true }, lecture: { type: String, index: true },
    questions: [{ question: String, options: [String], correctIndex: Number, correctIndexes: [Number], isMultiCorrect: Boolean, questionImage: String, optionImages: [String] }],
    question: String, options: [String], correctIndex: Number, updatedAt: { type: Number, default: Date.now }
}, { strict: false });

const StudentSchema = new mongoose.Schema({
    name: String, mobile: { type: String, index: true }, place: String, className: String,
    chapter: String, lecture: { type: String, index: true },
    answers: [mongoose.Schema.Types.Mixed], correctCount: Number, totalQuestions: Number,
    answer: Number, correct: Boolean, time: Number
}, { strict: false });
StudentSchema.index({ mobile: 1, lecture: 1 });

const AttemptSchema = new mongoose.Schema({ mobile: { type: String, index: true }, chapter: String, lecture: { type: String, index: true }, time: Number }, { strict: false });
AttemptSchema.index({ mobile: 1, lecture: 1 });

const Question = mongoose.model("Question", QuestionSchema);
const Student = mongoose.model("Student", StudentSchema);
const Attempt = mongoose.model("Attempt", AttemptSchema);

function normalizeQuestion(doc) {
    if (!doc) return null;
    const d = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
    if (d.questions && d.questions.length > 0) {
        d.questions = d.questions.map(q => {
            if (!q.correctIndexes || !q.correctIndexes.length) q.correctIndexes = [typeof q.correctIndex === "number" ? q.correctIndex : 0];
            q.isMultiCorrect = q.correctIndexes.length > 1;
            return q;
        });
        return d;
    }
    if (d.question && typeof d.question === "string" && d.question.trim()) {
        d.questions = [{ question: d.question, options: Array.isArray(d.options) && d.options.length ? d.options : [], correctIndex: typeof d.correctIndex === "number" ? d.correctIndex : 0, correctIndexes: [typeof d.correctIndex === "number" ? d.correctIndex : 0], isMultiCorrect: false }];
        return d;
    }
    d.questions = []; d._corrupted = true; return d;
}

function normalizeStudent(doc) {
    const s = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
    if (typeof s.correctCount === "number") return s;
    if (typeof s.answer === "number") { s.answers = [s.answer]; s.correctCount = s.correct === true ? 1 : 0; s.totalQuestions = 1; }
    return s;
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

let questionCache = {};
async function loadQuestions() {
    const all = await Question.find().lean();
    questionCache = {};
    all.forEach(q => { const n = normalizeQuestion(q); if (!n._corrupted) questionCache[`${q.chapter || ""}::${q.lecture}`] = n; });
    console.log(`Cached ${all.length} questions`);
}
mongoose.connection.once("open", loadQuestions);

async function findQuestion(chapter, lecture) {
    const key = `${chapter || ""}::${lecture}`;
    const cached = questionCache[key];
    if (cached && !cached._corrupted && cached.questions && cached.questions.length > 0) return cached;
    let doc = chapter ? await Question.findOne({ chapter, lecture }).lean() : await Question.findOne({ lecture, $or: [{ chapter: null }, { chapter: { $exists: false } }] }).lean();
    if (!doc) return null;
    const n = normalizeQuestion(doc);
    if (!n._corrupted) { questionCache[key] = n; return n; }
    return null;
}

async function refreshCache(chapter, lecture) {
    const updated = await Question.findOne(chapter ? { chapter, lecture } : { lecture }).lean();
    if (updated) { const n = normalizeQuestion(updated); if (!n._corrupted) questionCache[`${chapter || ""}::${lecture}`] = n; }
    else { delete questionCache[`${chapter || ""}::${lecture}`]; }
}

function requireAdmin(req, res, next) { 
    console.log("requireAdmin check - sessionID:", req.sessionID, "session:", req.session, "admin:", req.session?.admin);
    if (!req.session) {
        console.log("No session found!");
        return res.status(403).json({ error: "No session" });
    }
    if (!req.session?.admin) return res.status(403).json({ error: "Unauthorized" }); 
    next(); 
}

// ── SECURITY: Constant-time password comparison (prevents timing attacks)
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
app.get("/api/chapters", async (req, res) => { try { const c = await Question.distinct("chapter"); res.json(c.filter(Boolean).sort()); } catch { res.status(500).json({ error: "Failed" }); } });
app.get("/api/lectures/:chapter", async (req, res) => { try { const d = await Question.find({ chapter: req.params.chapter }, { lecture: 1 }).lean(); res.json(d.map(x => x.lecture).filter(Boolean).sort((a, b) => Number(a) - Number(b))); } catch { res.status(500).json({ error: "Failed" }); } });
app.get("/api/question/:chapter/:lecture", async (req, res) => { try { const q = await findQuestion(req.params.chapter, req.params.lecture); if (!q) return res.status(404).json({ error: "Lecture not found" }); res.json(q); } catch (e) { res.status(500).json({ error: "Failed" }); } });
app.post("/api/check-attempt", async (req, res) => { const { mobile, chapter, lecture } = req.body; if (!mobile || !lecture) return res.status(400).json({ error: "Missing" }); const q = await findQuestion(chapter, lecture); if (!q) return res.json({ allowed: false, time: 0 }); const a = await Attempt.findOne({ mobile, lecture }).sort({ time: -1 }).lean(); if (!a) return res.json({ allowed: true, time: 0 }); res.json(a.time >= (q.updatedAt || 0) ? { allowed: false, time: a.time } : { allowed: true, time: a.time }); });
app.post("/api/submit-attempt", rateLimit(60 * 1000, 5), async (req, res) => {
    const { mobile, chapter, lecture, selectedAnswers, name, place, className } = req.body;
    if (!mobile || !lecture) return res.status(400).json({ error: "Missing" });
    const q = await findQuestion(chapter, lecture); if (!q) return res.status(404).json({ error: "Not found" });
    const last = await Attempt.findOne({ mobile, lecture }).sort({ time: -1 }).lean();
    if (last && last.time >= (q.updatedAt || 0)) return res.json({ allowed: false });
    const answers = Array.isArray(selectedAnswers) ? selectedAnswers : [];
    let correctCount = 0;
    answers.forEach((ans, i) => { if (isCorrect(q.questions[i], ans)) correctCount++; });
    const now = Date.now();
    await Attempt.create({ mobile, chapter: chapter || null, lecture, time: now });
    await Student.findOneAndUpdate({ mobile, lecture }, { $set: { name, mobile, place, className, chapter: chapter || null, lecture, answers, correctCount, totalQuestions: q.questions.length, time: now } }, { upsert: true, new: true });
    res.json({ success: true, correctCount, totalQuestions: q.questions.length });
});
app.post("/api/student-register", async (req, res) => { const { name, mobile, place, className, chapter, lecture } = req.body; if (!name || !mobile || !lecture) return res.status(400).json({ error: "Missing" }); await Student.findOneAndUpdate({ mobile, lecture }, { $set: { name, mobile, place, className, chapter: chapter || null, lecture, time: Date.now() } }, { upsert: true, new: true }); res.json({ success: true }); });

// ── ADMIN ROUTES
app.post("/api/admin/add-question", requireAdmin, async (req, res) => {
    const { chapter, lecture, questions, replace } = req.body;
    if (!lecture || !Array.isArray(questions) || !questions.length) return res.status(400).json({ error: "Missing" });
    let existing = await Question.findOne({ chapter: chapter || null, lecture });
    if (!existing && !chapter) existing = await Question.findOne({ lecture, $or: [{ chapter: null }, { chapter: { $exists: false } }] });
    if (existing && !replace) return res.status(409).json({ warning: "Lecture already exists" });
    const data = { chapter: chapter || null, lecture, questions, updatedAt: Date.now() };
    if (existing) { await Question.updateOne({ _id: existing._id }, { $set: data, $unset: { question: "", options: "", correctIndex: "" } }); }
    else { await Question.create(data); }
    await refreshCache(chapter, lecture);
    res.json({ success: true });
});
app.delete("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
    const chapter = decodeURIComponent(req.params.chapter), lecture = decodeURIComponent(req.params.lecture);
    await Question.deleteMany({ lecture, $or: [{ chapter }, { chapter: null }, { chapter: { $exists: false } }] });
    delete questionCache[`${chapter}::${lecture}`];
    res.json({ success: true });
});
app.post("/api/admin/mass-delete", requireAdmin, async (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "No items" });
    let deleted = 0;
    for (const { chapter, lecture } of items) { await Question.deleteMany({ lecture, $or: [{ chapter }, { chapter: null }, { chapter: { $exists: false } }] }); delete questionCache[`${chapter || ""}::${lecture}`]; deleted++; }
    res.json({ success: true, deleted });
});
app.get("/api/admin/students", requireAdmin, async (req, res) => { try { const all = await Student.find({}).lean(); res.json(all.map(normalizeStudent)); } catch { res.status(500).json({ error: "Failed" }); } });
app.get("/api/admin/questions", requireAdmin, async (req, res) => { try { const all = await Question.find({}).lean(); res.json(all.map(normalizeQuestion)); } catch { res.status(500).json({ error: "Failed" }); } });

app.post("/api/admin/reload-cache", requireAdmin, async (req, res) => { try { await loadQuestions(); res.json({ success: true, cached: Object.keys(questionCache).length }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/admin/migrate", requireAdmin, async (req, res) => { try { const all = await Question.find({}).lean(); const c = all.filter(q => !(q.questions && q.questions.length && q.questions[0].question) && !(q.question && q.question.trim())); res.json({ total: all.length, corrupted: c.length, corruptedLectures: c.map(q => ({ lecture: q.lecture, chapter: q.chapter || null, _id: q._id })) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/admin/migrate", requireAdmin, async (req, res) => { try { const all = await Question.find({}).lean(); const ids = all.filter(q => !(q.questions && q.questions.length && q.questions[0].question) && !(q.question && q.question.trim())).map(q => q._id); if (!ids.length) return res.json({ success: true, deleted: 0, message: "No corrupted records found." }); await Question.deleteMany({ _id: { $in: ids } }); await loadQuestions(); res.json({ success: true, deleted: ids.length, message: `Deleted ${ids.length} corrupted record(s).` }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/admin/extract", requireAdmin, async (req, res) => {
    const { questionImages, answerImages, manualAnswerKey } = req.body;
    if (!questionImages || !Array.isArray(questionImages) || !questionImages.length) return res.status(400).json({ error: "At least one question image required" });
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not set on server" });
    function getMime(b64) { if (b64.startsWith("/9j/")) return "image/jpeg"; if (b64.startsWith("iVBORw")) return "image/png"; return "image/jpeg"; }
    let answerKeyDesc = manualAnswerKey?.trim() ? `The answer key is: ${manualAnswerKey.trim()}. Parse it as question number → answer letter(s).` : answerImages?.length ? `The last ${answerImages.length} image(s) are the answer key.` : "No answer key provided — do your best to identify correct answers from context.";
    const prompt = `You are a physics teacher extracting MCQ questions from Indian exam papers (JEE/NEET/HC Verma style).\n\n${answerKeyDesc}\n\nTASK: Extract EVERY question from ALL question images and match each to its answer.\nOutput ONLY a raw JSON array. No markdown, no explanation.\n\nMOST CRITICAL RULE — SEPARATING QUESTION FROM OPTIONS:\nIndian exam papers have TWO styles of writing options:\n\nSTYLE 1 — Options listed BELOW the question separately:\n  Q: "Which law states F=ma?"\n  (A) Newton's 1st  (B) Newton's 2nd  (C) Newton's 3rd  (D) Kepler's\n  → question = "Which law states F=ma?"\n  → options = ["Newton's 1st", "Newton's 2nd", "Newton's 3rd", "Kepler's"]\n\nSTYLE 2 — Options EMBEDDED inside question text as (a)(b)(c)(d):\n  "In a semiconductor (a) no free electrons at 0K (b) more electrons than conductor (c) free electrons increase with temp (d) it is an insulator"\n  → question = "In a semiconductor"  [STEM ONLY — stop before the first (a)]\n  → options = ["no free electrons at 0K", "more electrons than conductor", "free electrons increase with temp", "it is an insulator"]\n\nRULE: The "question" field must ONLY contain the question stem. Strip out ALL (a)(b)(c)(d) or (A)(B)(C)(D) sub-items and put them into the "options" array WITHOUT the letter prefix.\n\nJSON format per question:\n{"question":"stem only","options":["A text","B text","C text","D text"],"correctIndexes":[0],"isMultiCorrect":false,"hasImage":false}\n\nLaTeX math (KaTeX in $...$):\n- pi→$\\\\pi$, omega→$\\\\omega$, epsilon→$\\\\varepsilon$, T^4→$T^4$, T_1→$T_1$\n- cos→$\\\\cos$, sin→$\\\\sin$, 1/2 mv^2→$\\\\frac{1}{2}mv^2$\n- s^{-1}→$s^{-1}$, E_0 cos(100 pi t)→$E_0\\\\cos(100\\\\pi t)$\n- Do NOT add trailing $ at end of plain text sentences\n\nOTHER RULES:\n- hasImage:true if question has a diagram/figure/graph\n- correctIndexes: 0=A,1=B,2=C,3=D. Numbers 1/2/3/4 → 0/1/2/3\n- A,C in answer key → correctIndexes:[0,2], isMultiCorrect:true\n- Extract all questions in the order they appear`;
    try {
        const contentParts = [];
        for (const img of questionImages) contentParts.push({ type: "image_url", image_url: { url: `data:${getMime(img)};base64,${img}` } });
        for (const img of (answerImages || [])) contentParts.push({ type: "image_url", image_url: { url: `data:${getMime(img)};base64,${img}` } });
        contentParts.push({ type: "text", text: prompt });
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.GROQ_API_KEY }, body: JSON.stringify({ model: "meta-llama/llama-4-scout-17b-16e-instruct", max_tokens: 6000, temperature: 0.1, messages: [{ role: "user", content: contentParts }] }) });
        if (!r.ok) { const e = await r.json(); const msg = (e.error && e.error.message) || "Groq error"; console.error("Groq API error:", msg); return res.status(502).json({ error: msg }); }
        const data = await r.json();
        let text = ((data.choices?.[0]?.message?.content) || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
        text = text.replace(/\s*\$\\\$\s*"/g, '"').replace(/\s*\$\\s\$\s*"/g, '"');
        const arrStart = text.indexOf("["), arrEnd = text.lastIndexOf("]");
        if (arrStart === -1 || arrEnd === -1) return res.status(500).json({ error: "AI did not return valid JSON." });
        text = text.slice(arrStart, arrEnd + 1);
        let parsed;
        try { parsed = JSON.parse(text); } catch { text = text.replace(/,\s*]/g, "]").replace(/,\s*}/g, "}"); try { parsed = JSON.parse(text); } catch { return res.status(500).json({ error: "Could not parse AI response. Try clearer images." }); } }
        if (!Array.isArray(parsed) || !parsed.length) return res.status(500).json({ error: "No questions found." });
        parsed = parsed.map(q => { if (!q.correctIndexes?.length) q.correctIndexes = [typeof q.correctIndex === "number" ? q.correctIndex : 0]; q.isMultiCorrect = q.correctIndexes.length > 1; if (q.question) q.question = q.question.replace(/\s*\$\\\$\s*$/, "").trim(); q.options = (q.options || []).map(o => (o || "").replace(/\s*\$\\\$\s*$/, "").trim()); return q; });
        res.json({ questions: parsed });
    } catch (e) { console.error("Extract error:", e); res.status(500).json({ error: "Server error: " + e.message }); }
});

app.post("/api/admin/extract-diagram", requireAdmin, async (req, res) => {
    const { image, questionText } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not set" });

    function getMime(b64) {
        if (b64.startsWith("/9j/")) return "image/jpeg";
        if (b64.startsWith("iVBORw")) return "image/png";
        return "image/jpeg";
    }

    try {
        const prompt = `This is a physics exam screenshot. The question "${questionText || "shown"}" has a diagram/figure in it.

Your job: identify the bounding box of ONLY the diagram/figure (not the question text, not option text, not captions like "Figure 13-Q2").

The diagram is the actual drawing — shapes, graphs, circuits, ray diagrams, vessel drawings, etc.

Reply with ONLY a JSON object, no markdown:
{"x": 0.12, "y": 0.35, "w": 0.76, "h": 0.28}

Where x, y, w, h are fractions of the full image dimensions (0.0 to 1.0).
x = left edge, y = top edge, w = width, h = height.

Be tight — do not include text rows above or below the drawing.`;

        const mime = getMime(image);
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + process.env.GROQ_API_KEY
            },
            body: JSON.stringify({
                model: "meta-llama/llama-4-scout-17b-16e-instruct",
                max_tokens: 100,
                temperature: 0.0,
                messages: [{
                    role: "user",
                    content: [
                        { type: "image_url", image_url: { url: `data:${mime};base64,${image}` } },
                        { type: "text", text: prompt }
                    ]
                }]
            })
        });

        if (!r.ok) {
            const e = await r.json();
            const msg = e.error?.message || "Groq error";
            console.error("Groq extract-diagram error:", msg);
            return res.status(502).json({ error: msg });
        }

        const data = await r.json();
        let text = (data.choices?.[0]?.message?.content || "").trim();
        text = text.replace(/```json|```/g, "").trim();

        // Extract JSON object from response
        const start = text.indexOf("{"), end = text.lastIndexOf("}");
        if (start === -1 || end === -1) return res.status(500).json({ error: "AI did not return coords" });

        const coords = JSON.parse(text.slice(start, end + 1));
        if (typeof coords.x !== "number") return res.status(500).json({ error: "Invalid coords" });

        // Clamp values to valid range
        coords.x = Math.max(0, Math.min(1, coords.x));
        coords.y = Math.max(0, Math.min(1, coords.y));
        coords.w = Math.max(0.05, Math.min(1 - coords.x, coords.w));
        coords.h = Math.max(0.05, Math.min(1 - coords.y, coords.h));

        // Add 10% padding to prevent tight crops
        const padX = coords.w * 0.10;
        const padY = coords.h * 0.10;
        coords.x = Math.max(0, coords.x - padX);
        coords.y = Math.max(0, coords.y - padY);
        coords.w = Math.min(1 - coords.x, coords.w + padX * 2);
        coords.h = Math.min(1 - coords.y, coords.h + padY * 2);

        res.json({ coords });
    } catch (e) {
        console.error("Extract diagram error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ── Catch-all: no stack traces leaked to clients
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => { console.error("Unhandled:", err); res.status(500).json({ error: "Internal server error" }); });

app.listen(PORT, () => {
    console.log(`Server on port ${PORT}`);
    console.log("GROQ_API_KEY:", process.env.GROQ_API_KEY ? "set" : "MISSING");
    console.log("Security: lockout, timing-safe login, security headers active");
});
