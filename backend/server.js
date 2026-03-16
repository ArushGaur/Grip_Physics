const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const path = require("path");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);

/* ---------------- CONFIG ---------------- */

const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE;

app.use(cors({
    origin: [
        "https://grip-physics.onrender.com",
        "https://grip-physics.vercel.app"
    ],
    credentials: true
}));
app.use(express.json());

// Find your app.use(session(...)) block and update it to this:
app.use(session({
    secret: "grip_secret_key",
    resave: false,
    saveUninitialized: false,
    proxy: true, // Required for Render/Heroku
    cookie: {
        secure: true,      // Must be true for SameSite: 'none'
        sameSite: "none",  // Allows the cookie to be sent from Vercel to Render
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

let questionCache = {};

async function loadQuestions() {
    const questions = await Question.find().lean();
    questions.forEach(q => {
        questionCache[q.lecture] = q;
    });
}

mongoose.connection.once("open", loadQuestions);

/* ---------------- MONGODB ---------------- */

console.log("MONGO_URI:", process.env.MONGO_URI ? "present" : "missing");

mongoose.connect(
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017/grip_physics",
    {
        dbName: "grip_physics"
    }
)
    .then(() => {
        console.log("MongoDB connected to grip_physics");
    })
    .catch(err => {
        console.error("MongoDB connection error:", err);
    });

/* ---------------- SCHEMAS ---------------- */

const QuestionSchema = new mongoose.Schema({
    lecture: { type: String, index: true },
    question: String,
    options: [String],
    correctIndex: Number,
    updatedAt: { type: Number, default: Date.now }
});

const StudentSchema = new mongoose.Schema({
    name: String,
    mobile: { type: String, index: true },
    place: String,
    className: String,
    lecture: { type: String, index: true },
    answer: Number,
    correct: Boolean,
    time: Number
});

StudentSchema.index({ mobile: 1, lecture: 1 });

const Question = mongoose.model("Question", QuestionSchema);
const Student = mongoose.model("Student", StudentSchema);

/* ---------------- ADMIN PAGE ---------------- */

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "private", "owner.html"));
});

/* ---------------- ADMIN AUTH ---------------- */

function requireAdmin(req, res, next) {
    if (!req.session.admin) {
        return res.status(403).json({ error: "Unauthorized" });
    }
    next();
}

/* ---------------- ADMIN LOGIN ---------------- */

app.post("/api/admin/login", (req, res) => {

    const { passcode } = req.body;

    if (passcode !== ADMIN_PASSCODE) {
        return res.status(401).json({ error: "Invalid passcode" });
    }

    req.session.admin = true;

    res.json({ success: true });
});

/* ---------------- GET QUESTION ---------------- */

app.get("/api/question/:lecture", async (req, res) => {
    const lecture = req.params.lecture.trim(); // Trim spaces
    const q = questionCache[lecture];
    const question = questionCache[lecture] || await Question.findOne({ lecture }).lean();

    if (!question) {
        return res.status(404).json({ error: "Lecture not found" });
    }

    res.json(question);
});

/* ---------------- CHECK ATTEMPT ---------------- */

app.post("/api/check-attempt", async (req, res) => {

    const { mobile, lecture } = req.body;

    const question = await Question.findOne({ lecture }).lean();
    if (!question) {
        return res.json({ allowed: false, time: 0 });
    }

    const lastAttempt = await Attempt.findOne({ mobile, lecture })
        .sort({ time: -1 })
        .lean();

    if (!lastAttempt) {
        return res.json({ allowed: true, time: 0 });
    }

    const attemptTime = lastAttempt.time || 0;
    const questionTime = question.updatedAt || 0;

    if (attemptTime >= questionTime) {
        return res.json({ allowed: false, time: attemptTime });
    }

    return res.json({ allowed: true, time: attemptTime });
});

/* ---------------- SUBMIT ATTEMPT ---------------- */

app.post("/api/submit-attempt", async (req, res) => {

    const { mobile, lecture, selectedIndex } = req.body;

    const question = await Question.findOne({ lecture }).lean();
    if (!question) {
        return res.status(404).json({ error: "Lecture not found" });
    }

    const lastAttempt = await Attempt.findOne({ mobile, lecture })
        .sort({ time: -1 })
        .lean();

    if (lastAttempt) {
        const attemptTime = lastAttempt.time || 0;
        const questionTime = question.updatedAt || 0;

        if (attemptTime >= questionTime) {
            return res.json({ allowed: false });
        }
    }

    const now = Date.now();

    // Save attempt record
    await Attempt.create({
        mobile,
        lecture,
        time: now
    });

    // Save answer
    await Student.create({
        mobile,
        lecture,
        answer: selectedIndex,
        correct: selectedIndex === question.correctIndex,
        time: now
    });

    res.json({ success: true });
});

/* ---------------- STUDENT REGISTER ---------------- */

app.post("/api/student-register", async (req, res) => {

    const { name, mobile, place, className, lecture } = req.body;

    await Student.create({
        name,
        mobile,
        place,
        className,
        lecture,
        time: Date.now()
    });

    res.json({ success: true });
});

/* ---------------- ADD QUESTION ---------------- */

app.post("/api/admin/add-question", requireAdmin, async (req, res) => {
    const { lecture, question, options, correctIndex, replace } = req.body;
    const existing = await Question.findOne({ lecture });

    if (existing && !replace) {
        return res.status(409).json({ warning: "Lecture already exists" });
    }

    const updateData = {
        question,
        options,
        correctIndex,
        updatedAt: Date.now() // Critical for re-attempt logic
    };

    if (existing) {
        await Question.updateOne({ lecture }, { $set: updateData });
    } else {
        await Question.create({ lecture, ...updateData });
    }

    // Refresh cache
    const updatedQ = await Question.findOne({ lecture }).lean();
    questionCache[lecture] = updatedQ;

    res.json({ success: true });
});
/* ---------------- ADMIN STATS ---------------- */

app.get("/api/admin/students", requireAdmin, async (req, res) => {

    const login = await Student.find(
        { name: { $exists: true, $ne: null } },
        { name: 1, mobile: 1, place: 1, className: 1, lecture: 1, _id: 0 }
    ).lean();

    const answers = await Student.find(
        { answer: { $exists: true } },
        { mobile: 1, lecture: 1, answer: 1, correct: 1, _id: 0 }
    ).lean();

    res.json({ login, answers });
});

/* ---------------- LOGOUT ---------------- */

app.post("/api/admin/logout", (req, res) => {
    req.session.destroy(() => {
        res.json({ message: "Logged out" });
    });
});

/* ---------------- START SERVER ---------------- */

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
