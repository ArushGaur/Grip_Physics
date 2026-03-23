const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "admin123";

app.use(cors({ origin: ["https://grip-physics.onrender.com", "https://grip-physics.vercel.app"], credentials: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "20mb" }));
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
    questions: [{
        question: String, options: [String],
        correctIndex: Number, correctIndexes: [Number], isMultiCorrect: Boolean,
        questionImage: String,  // base64 image embedded in question
        optionImages: [String]  // base64 images for options
    }],
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
    all.forEach(q => {
        const n = normalizeQuestion(q);
        if (!n._corrupted) questionCache[`${q.chapter || ""}::${q.lecture}`] = n;
    });
    console.log(`Cached ${all.length} questions`);
}
mongoose.connection.once("open", loadQuestions);

async function findQuestion(chapter, lecture) {
    const key = `${chapter || ""}::${lecture}`;
    const cached = questionCache[key];
    if (cached && !cached._corrupted && cached.questions && cached.questions.length > 0) return cached;
    let doc = null;
    if (chapter) {
        doc = await Question.findOne({ chapter, lecture }).lean();
    } else {
        doc = await Question.findOne({ lecture, $or: [{ chapter: null }, { chapter: { $exists: false } }] }).lean();
    }
    if (!doc) return null;
    const n = normalizeQuestion(doc);
    if (!n._corrupted) { questionCache[key] = n; return n; }
    return null;
}

// Auto reload cache helper — called after any question change
async function refreshCache(chapter, lecture) {
    const updated = await Question.findOne(chapter ? { chapter, lecture } : { lecture }).lean();
    if (updated) {
        const n = normalizeQuestion(updated);
        if (!n._corrupted) questionCache[`${chapter || ""}::${lecture}`] = n;
    } else {
        delete questionCache[`${chapter || ""}::${lecture}`];
    }
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
    await refreshCache(chapter, lecture); // auto reload cache
    res.json({ success: true });
});

app.delete("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
    const chapter = decodeURIComponent(req.params.chapter), lecture = decodeURIComponent(req.params.lecture);
    await Question.deleteMany({ lecture, $or: [{ chapter }, { chapter: null }, { chapter: { $exists: false } }] });
    delete questionCache[`${chapter}::${lecture}`];
    res.json({ success: true });
});

// Mass delete endpoint
app.post("/api/admin/mass-delete", requireAdmin, async (req, res) => {
    const { items } = req.body; // [{chapter, lecture}]
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "No items" });
    let deleted = 0;
    for (const { chapter, lecture } of items) {
        await Question.deleteMany({ lecture, $or: [{ chapter }, { chapter: null }, { chapter: { $exists: false } }] });
        delete questionCache[`${chapter || ""}::${lecture}`];
        deleted++;
    }
    res.json({ success: true, deleted });
});

app.get("/api/admin/students", requireAdmin, async (req, res) => { try { const all = await Student.find({}).lean(); res.json(all.map(normalizeStudent)); } catch { res.status(500).json({ error: "Failed" }); } });
app.get("/api/admin/questions", requireAdmin, async (req, res) => { try { const all = await Question.find({}).lean(); res.json(all.map(normalizeQuestion)); } catch { res.status(500).json({ error: "Failed" }); } });

app.post("/api/admin/reload-cache", requireAdmin, async (req, res) => {
    try { await loadQuestions(); res.json({ success: true, cached: Object.keys(questionCache).length }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/migrate", requireAdmin, async (req, res) => { try { const all = await Question.find({}).lean(); const c = all.filter(q => !(q.questions && q.questions.length && q.questions[0].question) && !(q.question && q.question.trim())); res.json({ total: all.length, corrupted: c.length, corruptedLectures: c.map(q => ({ lecture: q.lecture, chapter: q.chapter || null, _id: q._id })) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/admin/migrate", requireAdmin, async (req, res) => { try { const all = await Question.find({}).lean(); const ids = all.filter(q => !(q.questions && q.questions.length && q.questions[0].question) && !(q.question && q.question.trim())).map(q => q._id); if (!ids.length) return res.json({ success: true, deleted: 0, message: "No corrupted records found." }); await Question.deleteMany({ _id: { $in: ids } }); await loadQuestions(); res.json({ success: true, deleted: ids.length, message: `Deleted ${ids.length} corrupted record(s).` }); } catch (e) { res.status(500).json({ error: e.message }); } });

// Multi-screenshot extract endpoint
app.post("/api/admin/extract", requireAdmin, async (req, res) => {
    const { questionImages, answerImages, manualAnswerKey } = req.body;
    // questionImages: array of base64 strings
    // answerImages: array of base64 strings (optional if manualAnswerKey provided)
    // manualAnswerKey: string like "1-C, 2-A, 3-B,D" (optional)
    if (!questionImages || !Array.isArray(questionImages) || !questionImages.length)
        return res.status(400).json({ error: "At least one question image required" });
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not set on server" });

    function getMime(b64) { if (b64.startsWith("/9j/")) return "image/jpeg"; if (b64.startsWith("iVBORw")) return "image/png"; return "image/jpeg"; }

    // Build answer key description
    let answerKeyDesc = "";
    if (manualAnswerKey && manualAnswerKey.trim()) {
        answerKeyDesc = `The answer key is: ${manualAnswerKey.trim()}. Parse it as question number → answer letter(s).`;
    } else if (answerImages && answerImages.length > 0) {
        answerKeyDesc = `The last ${answerImages.length} image(s) are the answer key.`;
    } else {
        answerKeyDesc = "No answer key provided — do your best to identify correct answers from context.";
    }

    const prompt = `You are a physics teacher extracting MCQ questions from Indian exam papers (JEE/NEET/HC Verma style).

${answerKeyDesc}

TASK: Extract EVERY question from ALL question images and match each to its answer.
Output ONLY a raw JSON array. No markdown, no explanation.

MOST CRITICAL RULE — SEPARATING QUESTION FROM OPTIONS:
Indian exam papers have TWO styles of writing options:

STYLE 1 — Options listed BELOW the question separately:
  Q: "Which law states F=ma?"
  (A) Newton's 1st  (B) Newton's 2nd  (C) Newton's 3rd  (D) Kepler's
  → question = "Which law states F=ma?"
  → options = ["Newton's 1st", "Newton's 2nd", "Newton's 3rd", "Kepler's"]

STYLE 2 — Options EMBEDDED inside question text as (a)(b)(c)(d):
  "In a semiconductor (a) no free electrons at 0K (b) more electrons than conductor (c) free electrons increase with temp (d) it is an insulator"
  → question = "In a semiconductor"  [STEM ONLY — stop before the first (a)]
  → options = ["no free electrons at 0K", "more electrons than conductor", "free electrons increase with temp", "it is an insulator"]

RULE: The "question" field must ONLY contain the question stem. Strip out ALL (a)(b)(c)(d) or (A)(B)(C)(D) sub-items and put them into the "options" array WITHOUT the letter prefix.

JSON format per question:
{"question":"stem only","options":["A text","B text","C text","D text"],"correctIndexes":[0],"isMultiCorrect":false,"hasImage":false}

LaTeX math (KaTeX in $...$):
- pi→$\\pi$, omega→$\\omega$, epsilon→$\\varepsilon$, T^4→$T^4$, T_1→$T_1$
- cos→$\\cos$, sin→$\\sin$, 1/2 mv^2→$\\frac{1}{2}mv^2$
- s^{-1}→$s^{-1}$, E_0 cos(100 pi t)→$E_0\\cos(100\\pi t)$
- Do NOT add trailing $ at end of plain text sentences

OTHER RULES:
- hasImage:true if question has a diagram/figure/graph
- correctIndexes: 0=A,1=B,2=C,3=D. Numbers 1/2/3/4 → 0/1/2/3
- A,C in answer key → correctIndexes:[0,2], isMultiCorrect:true
- Extract all questions in the order they appear`;

    try {
        // Build content array — all question images first, then answer key images
        const contentParts = [];
        for (const img of questionImages) {
            contentParts.push({ type: "image_url", image_url: { url: `data:${getMime(img)};base64,${img}` } });
        }
        for (const img of (answerImages || [])) {
            contentParts.push({ type: "image_url", image_url: { url: `data:${getMime(img)};base64,${img}` } });
        }
        contentParts.push({ type: "text", text: prompt });

        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.GROQ_API_KEY },
            body: JSON.stringify({
                model: "meta-llama/llama-4-scout-17b-16e-instruct",
                max_tokens: 6000, temperature: 0.1,
                messages: [{ role: "user", content: contentParts }]
            })
        });
        if (!r.ok) { const e = await r.json(); return res.status(502).json({ error: (e.error && e.error.message) || "Groq error" }); }
        const data = await r.json();
        let raw = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
        console.log("Groq response (first 400):", raw.slice(0, 400));
        let text = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();

        // Fix common trailing $\$ issue — remove lone $ at end of question text
        text = text.replace(/\s*\$\\\$\s*"/g, '"').replace(/\s*\$\\s\$\s*"/g, '"');

        const arrStart = text.indexOf("["), arrEnd = text.lastIndexOf("]");
        if (arrStart === -1 || arrEnd === -1) return res.status(500).json({ error: "AI did not return valid JSON." });
        text = text.slice(arrStart, arrEnd + 1);

        let parsed;
        try { parsed = JSON.parse(text); }
        catch (e) {
            // Try to fix common JSON issues
            text = text.replace(/,\s*]/g, "]").replace(/,\s*}/g, "}");
            try { parsed = JSON.parse(text); }
            catch { return res.status(500).json({ error: "Could not parse AI response. Try clearer images." }); }
        }
        if (!Array.isArray(parsed) || !parsed.length) return res.status(500).json({ error: "No questions found." });

        parsed = parsed.map(q => {
            if (!q.correctIndexes || !Array.isArray(q.correctIndexes) || !q.correctIndexes.length)
                q.correctIndexes = [typeof q.correctIndex === "number" ? q.correctIndex : 0];
            q.isMultiCorrect = q.correctIndexes.length > 1;
            // Clean up trailing $\$ artifacts
            if (q.question) q.question = q.question.replace(/\s*\$\\\$\s*$/, "").replace(/\s*\$\\s\$\s*$/, "").trim();
            q.options = (q.options || []).map(o => (o || "").replace(/\s*\$\\\$\s*$/, "").replace(/\s*\$\\s\$\s*$/, "").trim());
            return q;
        });

        res.json({ questions: parsed });
    } catch (e) { console.error("Extract error:", e); res.status(500).json({ error: "Server error: " + e.message }); }
});

app.listen(PORT, () => { console.log("Server on port " + PORT); console.log("GROQ_API_KEY:", process.env.GROQ_API_KEY ? "set" : "MISSING"); });
