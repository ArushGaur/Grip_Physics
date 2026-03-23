const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "admin123";

app.use(cors({ origin: ["https://grip-physics.onrender.com", "https://grip-physics.vercel.app"], credentials: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "10mb" }));
app.use(session({ secret: process.env.SESSION_SECRET || "grip_secret_key", resave: false, saveUninitialized: false, proxy: true, cookie: { secure: true, sameSite: "none", httpOnly: true, maxAge: 24 * 60 * 60 * 1000 } }));

const rateLimitMap = new Map();
function rateLimit(windowMs, max) {
    return (req, res, next) => {
        const key = req.ip + req.path, now = Date.now();
        if (!rateLimitMap.has(key)) rateLimitMap.set(key, []);
        const reqs = rateLimitMap.get(key).filter(t => t > now - windowMs);
        reqs.push(now); rateLimitMap.set(key, reqs);
        if (reqs.length > max) return res.status(429).json({ error: "Too many requests." });
        next();
    };
}
setInterval(() => { const c = Date.now() - 15 * 60 * 1000; for (const [k, v] of rateLimitMap.entries()) { const f = v.filter(t => t > c); if (!f.length) rateLimitMap.delete(k); else rateLimitMap.set(k, f); } }, 5 * 60 * 1000);

mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/grip_physics", { dbName: "grip_physics" })
    .then(() => console.log("MongoDB connected")).catch(err => console.error("MongoDB error:", err));

const QuestionSchema = new mongoose.Schema({
    chapter: { type: String, index: true }, lecture: { type: String, index: true },
    questions: [{ question: String, options: [String], correctIndex: Number, correctIndexes: [Number], isMultiCorrect: Boolean }],
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
    all.forEach(q => { const n = normalizeQuestion(q); if (!n._corrupted) { questionCache[`${q.chapter || ""}::${q.lecture}`] = n; if (!questionCache[`::${q.lecture}`]) questionCache[`::${q.lecture}`] = n; } });
    console.log(`Cached ${all.length} questions`);
}
mongoose.connection.once("open", loadQuestions);

async function findQuestion(chapter, lecture) {
    const key = `${chapter || ""}::${lecture}`;
    const cached = questionCache[key];
    if (cached && !cached._corrupted && cached.questions && cached.questions.length > 0) return cached;
    let doc = chapter ? await Question.findOne({ chapter, lecture }).lean() : null;
    if (!doc) doc = await Question.findOne({ lecture }).lean();
    if (!doc) return null;
    const n = normalizeQuestion(doc);
    if (!n._corrupted) { questionCache[key] = n; questionCache[`::${lecture}`] = n; return n; }
    return null;
}

function requireAdmin(req, res, next) { if (!req.session.admin) return res.status(403).json({ error: "Unauthorized" }); next(); }

app.post("/api/admin/login", rateLimit(15 * 60 * 1000, 10), (req, res) => { if (req.body.passcode !== ADMIN_PASSCODE) return res.status(401).json({ error: "Invalid passcode" }); req.session.admin = true; res.json({ success: true }); });
app.post("/api/admin/logout", (req, res) => req.session.destroy(() => res.json({ message: "Logged out" })));

app.get("/api/chapters", async (req, res) => { try { const c = await Question.distinct("chapter"); res.json(c.filter(Boolean).sort()); } catch { res.status(500).json({ error: "Failed" }); } });
app.get("/api/lectures/:chapter", async (req, res) => { try { const d = await Question.find({ chapter: req.params.chapter }, { lecture: 1 }).lean(); res.json(d.map(x => x.lecture).filter(Boolean).sort((a, b) => Number(a) - Number(b))); } catch { res.status(500).json({ error: "Failed" }); } });

app.get("/api/question/:chapter/:lecture", async (req, res) => { try { const q = await findQuestion(req.params.chapter, req.params.lecture); if (!q) return res.status(404).json({ error: "Lecture not found" }); res.json(q); } catch (e) { console.error(e); res.status(500).json({ error: "Failed" }); } });

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

app.post("/api/admin/add-question", requireAdmin, async (req, res) => {
    const { chapter, lecture, questions, replace } = req.body;
    if (!lecture || !Array.isArray(questions) || !questions.length) return res.status(400).json({ error: "Missing" });
    let existing = await Question.findOne({ chapter: chapter || null, lecture });
    if (!existing && !chapter) existing = await Question.findOne({ lecture, $or: [{ chapter: null }, { chapter: { $exists: false } }] });
    if (existing && !replace) return res.status(409).json({ warning: "Lecture already exists" });
    const data = { chapter: chapter || null, lecture, questions, updatedAt: Date.now() };
    if (existing) { await Question.updateOne({ _id: existing._id }, { $set: data, $unset: { question: "", options: "", correctIndex: "" } }); }
    else { await Question.create(data); }
    const updated = await Question.findOne(existing ? { _id: existing._id } : { lecture }).lean();
    const n = normalizeQuestion(updated);
    questionCache[`${chapter || ""}::${lecture}`] = n; questionCache[`::${lecture}`] = n;
    res.json({ success: true });
});

app.delete("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
    const chapter = decodeURIComponent(req.params.chapter), lecture = decodeURIComponent(req.params.lecture);
    await Question.deleteMany({ lecture, $or: [{ chapter }, { chapter: null }, { chapter: { $exists: false } }] });
    delete questionCache[`${chapter}::${lecture}`]; delete questionCache[`::${lecture}`];
    res.json({ success: true });
});

app.get("/api/admin/students", requireAdmin, async (req, res) => { try { const all = await Student.find({}).lean(); res.json(all.map(normalizeStudent)); } catch { res.status(500).json({ error: "Failed" }); } });
app.get("/api/admin/questions", requireAdmin, async (req, res) => { try { const all = await Question.find({}).lean(); res.json(all.map(normalizeQuestion)); } catch { res.status(500).json({ error: "Failed" }); } });

app.get("/api/admin/migrate", requireAdmin, async (req, res) => { try { const all = await Question.find({}).lean(); const c = all.filter(q => !(q.questions && q.questions.length && q.questions[0].question) && !(q.question && q.question.trim())); res.json({ total: all.length, corrupted: c.length, corruptedLectures: c.map(q => ({ lecture: q.lecture, chapter: q.chapter || null, _id: q._id })) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/admin/migrate", requireAdmin, async (req, res) => { try { const all = await Question.find({}).lean(); const ids = all.filter(q => !(q.questions && q.questions.length && q.questions[0].question) && !(q.question && q.question.trim())).map(q => q._id); if (!ids.length) return res.json({ success: true, deleted: 0, message: "No corrupted records found." }); await Question.deleteMany({ _id: { $in: ids } }); questionCache = {}; await loadQuestions(); res.json({ success: true, deleted: ids.length, message: `Deleted ${ids.length} corrupted record(s).` }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post("/api/admin/extract", requireAdmin, async (req, res) => {
    const { questionImageBase64, answerImageBase64 } = req.body;
    if (!questionImageBase64 || !answerImageBase64) return res.status(400).json({ error: "Both images required" });
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not set on server" });

    function getMime(b64) {
        if (b64.startsWith("/9j/")) return "image/jpeg";
        if (b64.startsWith("iVBORw")) return "image/png";
        return "image/jpeg";
    }

    const qMime = getMime(questionImageBase64), aMime = getMime(answerImageBase64);

    // Simple, clear prompt — complex LaTeX instructions cause parse failures
    const prompt = [
        "Look at these two images carefully.",
        "Image 1 contains multiple-choice physics questions.",
        "Image 2 contains the answer key.",
        "",
        "Your task: extract every question from Image 1 and match each with its answer from Image 2.",
        "",
        "Output format: a JSON array. Each element must have these exact fields:",
        '  "question": the full question text',
        '  "options": array of exactly 4 strings [option A, option B, option C, option D]',
        '  "correctIndexes": array of correct answer indices (0=A, 1=B, 2=C, 3=D)',
        '  "isMultiCorrect": true if more than one answer is correct, otherwise false',
        "",
        "Rules:",
        "- If the answer key shows a single letter like A, correctIndexes is [0]",
        "- If answer key shows multiple like A,C then correctIndexes is [0,2] and isMultiCorrect is true",
        "- For math, write it naturally using ^ for powers and _ for subscripts, e.g. T^3, v_0, pi, omega",
        "- Output ONLY the JSON array. No explanation, no markdown, no code blocks.",
        "",
        "Example output:",
        '[{"question":"A body moves with velocity v. Its kinetic energy is","options":["mv","(1/2)mv^2","mv^2","2mv^2"],"correctIndexes":[1],"isMultiCorrect":false}]'
    ].join("\n");

    try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.GROQ_API_KEY },
            body: JSON.stringify({
                model: "meta-llama/llama-4-scout-17b-16e-instruct",
                max_tokens: 4000,
                temperature: 0.1,
                messages: [{
                    role: "user",
                    content: [
                        { type: "image_url", image_url: { url: "data:" + qMime + ";base64," + questionImageBase64 } },
                        { type: "image_url", image_url: { url: "data:" + aMime + ";base64," + answerImageBase64 } },
                        { type: "text", text: prompt }
                    ]
                }]
            })
        });

        if (!r.ok) {
            const e = await r.json();
            console.error("Groq HTTP error:", r.status, e);
            return res.status(502).json({ error: (e.error && e.error.message) || "Groq API error" });
        }

        const data = await r.json();
        let raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
        console.log("Groq raw response (first 500 chars):", raw.slice(0, 500));

        // Aggressive cleanup
        let text = raw.trim();
        // Remove markdown code fences
        text = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
        // If response has text before the JSON array, strip it
        const arrStart = text.indexOf("[");
        const arrEnd = text.lastIndexOf("]");
        if (arrStart === -1 || arrEnd === -1) {
            console.error("No JSON array found in response:", text.slice(0, 300));
            return res.status(500).json({ error: "AI did not return a JSON array. Try clearer images or simpler questions." });
        }
        text = text.slice(arrStart, arrEnd + 1);

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (parseErr) {
            console.error("JSON parse error:", parseErr.message);
            console.error("Text that failed to parse:", text.slice(0, 400));
            return res.status(500).json({ error: "AI response could not be parsed. The image may be too complex — try a clearer screenshot." });
        }

        if (!Array.isArray(parsed) || !parsed.length) {
            return res.status(500).json({ error: "No questions found in the images." });
        }

        // Normalize correctIndexes
        parsed = parsed.map(q => {
            if (!q.correctIndexes || !Array.isArray(q.correctIndexes) || !q.correctIndexes.length) {
                q.correctIndexes = [typeof q.correctIndex === "number" ? q.correctIndex : 0];
            }
            q.isMultiCorrect = q.correctIndexes.length > 1;
            // Convert math notation: wrap expressions with ^ or _ in $ signs for KaTeX
            function wrapMath(text) {
                if (!text) return text;
                // Already has $ signs — don't double-wrap
                if (text.includes("$")) return text;
                // If it contains math symbols, wrap the whole thing
                if (/[\^_]|\b(pi|omega|alpha|beta|gamma|theta|epsilon|varepsilon|sigma|mu|lambda|delta)\b/.test(text)) {
                    return "$" + text + "$";
                }
                return text;
            }
            q.question = wrapMath(q.question);
            q.options = (q.options || []).map(wrapMath);
            return q;
        });

        console.log("Extracted " + parsed.length + " questions via Groq");
        res.json({ questions: parsed });

    } catch (e) {
        console.error("Extract error:", e);
        res.status(500).json({ error: "Server error during extraction: " + e.message });
    }
});


app.listen(PORT, () => { console.log("Server on port " + PORT); console.log("GROQ_API_KEY:", process.env.GROQ_API_KEY ? "set" : "MISSING"); });
