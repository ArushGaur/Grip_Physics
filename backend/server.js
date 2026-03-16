const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const path = require("path");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- CONFIG ---------------- */

const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE;

app.use(cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST"]
}));
app.use(express.json());

app.use(session({
    secret: "grip_secret_key",
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,
        sameSite: "none"
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
    correctIndex: Number
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

const AttemptSchema = new mongoose.Schema({
    mobile: { type: String, index: true },
    lecture: { type: String, index: true }
});

const Question = mongoose.model("Question", QuestionSchema);
const Student = mongoose.model("Student", StudentSchema);
const Attempt = mongoose.model("Attempt", AttemptSchema);

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
    const lecture = req.params.lecture;
    const question = questionCache[lecture] || await Question.findOne({ lecture }).lean();

    if (!question) {
        return res.status(404).json({ error: "Lecture not found" });
    }

    res.json(question);
});

/* ---------------- CHECK ATTEMPT ---------------- */

app.post("/api/check-attempt", async (req, res) => {

    const { mobile, lecture } = req.body;

    const attempt = await Attempt.findOne({ mobile, lecture }).lean();

    if (attempt) {
        return res.json({ allowed: false });
    }

    res.json({ allowed: true });
});

/* ---------------- SUBMIT ATTEMPT ---------------- */

app.post("/api/submit-attempt", async (req, res) => {

    const { mobile, lecture, selectedIndex } = req.body;

    const question = await Question.findOne({ lecture }).lean();

    if (!question) {
        return res.status(404).json({ error: "Lecture not found" });
    }

    const existing = await Attempt.findOne({ mobile, lecture });

    if (existing) {
        return res.json({ allowed: false });
    }

    await Attempt.create({
        mobile,
        lecture
    });

    await Student.create({
        mobile,
        lecture,
        answer: selectedIndex,
        correct: selectedIndex === question.correctIndex,
        time: Date.now()
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
        return res.status(409).json({
            warning: "Lecture already exists"
        });
    }

    if (existing) {

        existing.question = question;
        existing.options = options;
        existing.correctIndex = correctIndex;

        await existing.save();

    } else {

        await Question.create({
            lecture,
            question,
            options,
            correctIndex
        });

    }

    res.json({ success: true });
});

/* ---------------- ADMIN STATS ---------------- */

app.get("/api/admin/students", requireAdmin, async (req, res) => {

    const students = await Student.find();

    const login = students.filter(s => s.name);
    const answers = students.filter(s => s.answer !== undefined);

    res.json({
        login,
        answers
    });

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
