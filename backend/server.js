const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);

/* ---------------- CONFIG ---------------- */

const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "admin123";

app.use(cors({
    origin: [
        "https://grip-physics.onrender.com",
        "https://grip-physics.vercel.app"
    ],
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
    cookie: {
        secure: true,
        sameSite: "none",
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

/* ---------------- SIMPLE RATE LIMITING ---------------- */

const rateLimitMap = new Map();

function rateLimit(windowMs, maxRequests) {
    return (req, res, next) => {
        const key = req.ip + req.path;
        const now = Date.now();
        const windowStart = now - windowMs;

        if (!rateLimitMap.has(key)) {
            rateLimitMap.set(key, []);
        }

        const requests = rateLimitMap.get(key).filter(t => t > windowStart);
        requests.push(now);
        rateLimitMap.set(key, requests);

        if (requests.length > maxRequests) {
            return res.status(429).json({ error: "Too many requests. Please slow down." });
        }
        next();
    };
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [key, times] of rateLimitMap.entries()) {
        const filtered = times.filter(t => t > cutoff);
        if (filtered.length === 0) rateLimitMap.delete(key);
        else rateLimitMap.set(key, filtered);
    }
}, 5 * 60 * 1000);

/* ---------------- MONGODB ---------------- */

console.log("MONGO_URI:", process.env.MONGO_URI ? "present" : "missing");

mongoose.connect(
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017/grip_physics",
    { dbName: "grip_physics" }
)
    .then(() => console.log("MongoDB connected to grip_physics"))
    .catch(err => console.error("MongoDB connection error:", err));

/* ---------------- SCHEMAS ---------------- */

const QuestionSchema = new mongoose.Schema({
    chapter: { type: String, index: true },
    lecture: { type: String, index: true },
    questions: [{
        question: String,
        options: [String],
        correctIndex: Number
    }],
    updatedAt: { type: Number, default: Date.now }
});
QuestionSchema.index({ chapter: 1, lecture: 1 }, { unique: true });

const StudentSchema = new mongoose.Schema({
    name: String,
    mobile: { type: String, index: true },
    place: String,
    className: String,
    chapter: String,
    lecture: { type: String, index: true },
    answers: [Number],
    correctCount: Number,
    totalQuestions: Number,
    time: Number
});
StudentSchema.index({ mobile: 1, lecture: 1, chapter: 1 });

const AttemptSchema = new mongoose.Schema({
    mobile: { type: String, index: true },
    chapter: { type: String, index: true },
    lecture: { type: String, index: true },
    time: Number
});
AttemptSchema.index({ mobile: 1, lecture: 1, chapter: 1 });

const Question = mongoose.model("Question", QuestionSchema);
const Student = mongoose.model("Student", StudentSchema);
const Attempt = mongoose.model("Attempt", AttemptSchema);

/* ---------------- QUESTION CACHE ---------------- */

let questionCache = {};

async function loadQuestions() {
    const questions = await Question.find().lean();
    questions.forEach(q => {
        const key = `${q.chapter}::${q.lecture}`;
        questionCache[key] = q;
    });
    console.log(`Loaded ${questions.length} questions into cache`);
}

mongoose.connection.once("open", loadQuestions);

/* ---------------- ADMIN AUTH ---------------- */

function requireAdmin(req, res, next) {
    if (!req.session.admin) {
        return res.status(403).json({ error: "Unauthorized" });
    }
    next();
}

/* ---------------- ADMIN LOGIN ---------------- */

app.post("/api/admin/login", rateLimit(15 * 60 * 1000, 10), (req, res) => {
    const { passcode } = req.body;
    if (!passcode || passcode !== ADMIN_PASSCODE) {
        return res.status(401).json({ error: "Invalid passcode" });
    }
    req.session.admin = true;
    res.json({ success: true });
});

/* ---------------- LOGOUT ---------------- */

app.post("/api/admin/logout", (req, res) => {
    req.session.destroy(() => res.json({ message: "Logged out" }));
});

/* ---------------- GET CHAPTERS ---------------- */

app.get("/api/chapters", async (req, res) => {
    try {
        const chapters = await Question.distinct("chapter");
        res.json(chapters.sort());
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch chapters" });
    }
});

/* ---------------- GET LECTURES FOR CHAPTER ---------------- */

app.get("/api/lectures/:chapter", async (req, res) => {
    try {
        const { chapter } = req.params;
        const lectures = await Question.find({ chapter }, { lecture: 1, _id: 0 }).lean();
        res.json(lectures.map(l => l.lecture).sort((a, b) => Number(a) - Number(b)));
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch lectures" });
    }
});

/* ---------------- GET QUESTION ---------------- */

app.get("/api/question/:chapter/:lecture", async (req, res) => {
    try {
        const { chapter, lecture } = req.params;
        const key = `${chapter}::${lecture}`;
        const question = questionCache[key] || await Question.findOne({ chapter, lecture }).lean();

        if (!question) {
            return res.status(404).json({ error: "Lecture not found" });
        }

        res.json(question);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch question" });
    }
});

/* ---------------- CHECK ATTEMPT ---------------- */

app.post("/api/check-attempt", async (req, res) => {
    const { mobile, chapter, lecture } = req.body;

    if (!mobile || !chapter || !lecture) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const key = `${chapter}::${lecture}`;
    const question = questionCache[key] || await Question.findOne({ chapter, lecture }).lean();

    if (!question) return res.json({ allowed: false, time: 0 });

    const lastAttempt = await Attempt.findOne({ mobile, chapter, lecture }).sort({ time: -1 }).lean();

    if (!lastAttempt) return res.json({ allowed: true, time: 0 });

    const attemptTime = lastAttempt.time || 0;
    const questionTime = question.updatedAt || 0;

    if (attemptTime >= questionTime) {
        return res.json({ allowed: false, time: attemptTime });
    }

    return res.json({ allowed: true, time: attemptTime });
});

/* ---------------- SUBMIT ATTEMPT ---------------- */

app.post("/api/submit-attempt", rateLimit(60 * 1000, 5), async (req, res) => {
    const { mobile, chapter, lecture, selectedAnswers, name, place, className } = req.body;

    if (!mobile || !chapter || !lecture || !Array.isArray(selectedAnswers)) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const key = `${chapter}::${lecture}`;
    const question = questionCache[key] || await Question.findOne({ chapter, lecture }).lean();

    if (!question) return res.status(404).json({ error: "Lecture not found" });

    const lastAttempt = await Attempt.findOne({ mobile, chapter, lecture }).sort({ time: -1 }).lean();
    if (lastAttempt && lastAttempt.time >= (question.updatedAt || 0)) {
        return res.json({ allowed: false });
    }

    const now = Date.now();
    let correctCount = 0;

    selectedAnswers.forEach((ans, i) => {
        if (question.questions[i] && ans === question.questions[i].correctIndex) correctCount++;
    });

    await Attempt.create({ mobile, chapter, lecture, time: now });

    // Upsert student record
    await Student.findOneAndUpdate(
        { mobile, chapter, lecture },
        {
            name, mobile, place, className, chapter, lecture,
            answers: selectedAnswers,
            correctCount,
            totalQuestions: question.questions.length,
            time: now
        },
        { upsert: true, new: true }
    );

    res.json({ success: true, correctCount, totalQuestions: question.questions.length });
});

/* ---------------- STUDENT REGISTER (kept for compatibility) ---------------- */

app.post("/api/student-register", async (req, res) => {
    const { name, mobile, place, className, chapter, lecture } = req.body;

    if (!name || !mobile || !chapter || !lecture) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    await Student.findOneAndUpdate(
        { mobile, chapter, lecture },
        { name, mobile, place, className, chapter, lecture, time: Date.now() },
        { upsert: true, new: true }
    );

    res.json({ success: true });
});

/* ---------------- ADD / UPDATE QUESTION ---------------- */

app.post("/api/admin/add-question", requireAdmin, async (req, res) => {
    const { chapter, lecture, questions, replace } = req.body;

    if (!chapter || !lecture || !Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const existing = await Question.findOne({ chapter, lecture });

    if (existing && !replace) {
        return res.status(409).json({ warning: "Lecture already exists" });
    }

    const updateData = { questions, updatedAt: Date.now() };

    if (existing) {
        await Question.updateOne({ chapter, lecture }, { $set: updateData });
    } else {
        await Question.create({ chapter, lecture, ...updateData });
    }

    const updatedQ = await Question.findOne({ chapter, lecture }).lean();
    const key = `${chapter}::${lecture}`;
    questionCache[key] = updatedQ;

    res.json({ success: true });
});

/* ---------------- DELETE QUESTION ---------------- */

app.delete("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
    const { chapter, lecture } = req.params;
    await Question.deleteOne({ chapter, lecture });
    const key = `${chapter}::${lecture}`;
    delete questionCache[key];
    res.json({ success: true });
});

/* ---------------- ADMIN STATS ---------------- */

app.get("/api/admin/students", requireAdmin, async (req, res) => {
    try {
        const students = await Student.find({}).lean();
        res.json(students);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch students" });
    }
});

/* ---------------- ADMIN: LIST ALL QUESTIONS ---------------- */

app.get("/api/admin/questions", requireAdmin, async (req, res) => {
    try {
        const questions = await Question.find({}, { chapter: 1, lecture: 1, updatedAt: 1, "questions": 1 }).lean();
        res.json(questions);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch questions" });
    }
});

/* ---------------- START SERVER ---------------- */

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
