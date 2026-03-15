const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- MIDDLEWARE ---------------- */

app.use(express.json());

app.use(session({
    secret: "grip_secret_key",
    resave: false,
    saveUninitialized: false
}));

app.use(express.static('public'));


/* ---------------- CONFIG ---------------- */

const DATA_PATH = path.join(__dirname, 'data', 'questions.json');
const ADMIN_PASSCODE = "GRIP_ADMIN_2026";


/* ---------------- INIT DATA ---------------- */

if (!fs.existsSync(DATA_PATH)) {

    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

    const initialData = {
        questions: [
            {
                id: Date.now(),
                question: "Which law states that for every action there is an equal and opposite reaction?",
                options: [
                    "Newton's 1st Law",
                    "Newton's 2nd Law",
                    "Newton's 3rd Law",
                    "Universal Gravitation"
                ],
                correctIndex: 2
            }
        ],
        attempts: {},
        students: []
    };

    fs.writeFileSync(DATA_PATH, JSON.stringify(initialData, null, 2));
}


/* ---------------- ADMIN PAGE ---------------- */

app.get("/admin", (req, res) => {

    res.sendFile(path.join(__dirname, "private", "owner.html"));

});


/* ---------------- GET CURRENT QUESTION ---------------- */

app.get("/api/question/:lecture", (req, res) => {

    const lecture = String(req.params.lecture);

    const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

    const question = data.questions.find(q => String(q.lecture) === lecture);

    if (!question) {
        return res.status(404).json({
            error: "Lecture does not exist"
        });
    }

    res.json(question);

});


/* ---------------- CHECK ATTEMPT ---------------- */

app.post("/api/check-attempt", (req, res) => {

    const { mobile, lecture } = req.body;

    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

    const question = data.questions.find(q => q.lecture == lecture);

    if (!question) {
        return res.json({ allowed: true });
    }

    const attempts = data.attempts[question.id] || [];

    if (attempts.includes(mobile)) {
        return res.json({ allowed: false });
    }

    res.json({ allowed: true });

});


/* ---------------- SUBMIT ATTEMPT ---------------- */

app.post("/api/submit-attempt", (req, res) => {

    const { mobile, lecture, selectedIndex } = req.body;

    const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

    const question = data.questions.find(q => q.lecture == lecture);

    if (!question) {
        return res.status(404).json({ error: "Lecture not found" });
    }

    if (!data.attempts[question.id]) {
        data.attempts[question.id] = [];
    }

    if (data.attempts[question.id].includes(mobile)) {
        return res.json({ allowed: false });
    }

    data.attempts[question.id].push(mobile);

    const student = data.students.find(s => s.mobile === mobile && s.name);

    data.students.push({
        name: student ? student.name : "",
        mobile: mobile,
        lecture: lecture,
        answer: selectedIndex,
        correct: selectedIndex == question.correctIndex,
        time: Date.now()
    });

    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));

    res.json({ success: true });

});

app.get("/api/admin/students", requireAdmin, (req, res) => {

    const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

    const login = data.students.filter(s => s.name);
    const answers = data.students.filter(s => s.answer !== undefined);

    res.json({
        login,
        answers
    });

});


/* ---------------- ADMIN LOGIN ---------------- */

app.post("/api/admin/login", (req, res) => {

    const { passcode } = req.body;

    if (passcode !== ADMIN_PASSCODE) {

        return res.status(401).json({ error: "Invalid passcode" });

    }

    req.session.admin = true;

    res.json({ message: "Login successful" });

});


/* ---------------- ADMIN AUTH ---------------- */

function requireAdmin(req, res, next) {

    if (!req.session.admin) {

        return res.status(403).json({ error: "Unauthorized" });

    }

    next();

}

/* ---------------- STUDENT REGISTER ---------------- */

app.post("/api/student-register", (req, res) => {

    const { name, mobile, place, className, lecture } = req.body;

    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

    data.students.push({
        name,
        mobile,
        place,
        className,
        lecture,
        time: Date.now()
    });

    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));

    res.json({ success: true });

});


/* ---------------- ADD QUESTION ---------------- */

app.post('/api/admin/add-question', requireAdmin, (req, res) => {

    const { lecture, question, options, correctIndex, replace } = req.body;

    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

    const existingIndex = data.questions.findIndex(
        q => String(q.lecture) === String(lecture)
    );

    if (existingIndex !== -1 && !replace) {

        return res.status(409).json({
            warning: "Lecture already exists"
        });

    }

    const newQuestion = {
        id: Date.now(),
        lecture: String(lecture),
        question,
        options,
        correctIndex
    };

    if (existingIndex !== -1) {

        data.questions[existingIndex] = newQuestion;

    } else {

        data.questions.push(newQuestion);

    }

    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));

    res.json({ success: true });

});


/* ---------------- LOGOUT ---------------- */

app.post("/api/admin/logout", (req, res) => {

    req.session.destroy(() => {

        res.json({ message: "Logged out" });

    });

});


/* ---------------- START SERVER ---------------- */

app.listen(PORT, () => {

    console.log("Server running on port " + PORT);

});