/* ============================================================
   GRIP PHYSICS — Student Portal Script
   ============================================================ */

const API_BASE = "https://grip-physics.onrender.com";

const QUOTES = [
    '"The important thing is not to stop questioning." — Einstein',
    '"Physics is the poetry of the universe." — Unknown',
    '"Science is not only a disciple of reason but also one of romance and passion." — Hawking',
    '"The universe is under no obligation to make sense to you." — Tyson',
    '"Nothing in life is to be feared, only to be understood." — Curie'
];

/* ---------------- STATE ---------------- */
let currentQuestionSet = null;
let currentLecture = null;
let currentChapter = null;
let currentQuestionIndex = 0;
let selectedAnswers = [];
let timerInterval = null;
let timeLeft = 120; // seconds

/* ---------------- RANDOM QUOTE ---------------- */
document.getElementById("quote").innerText = QUOTES[Math.floor(Math.random() * QUOTES.length)];

/* ---------------- PARTICLES ---------------- */
particlesJS("particles-js", {
    particles: {
        number: { value: 70 },
        color: { value: ["#00f2fe", "#4facfe", "#a78bfa"] },
        shape: { type: "circle" },
        opacity: { value: 0.4, random: true },
        size: { value: 2.5, random: true },
        line_linked: { enable: true, distance: 130, color: "#4facfe", opacity: 0.15, width: 1 },
        move: { enable: true, speed: 1.5 }
    },
    interactivity: {
        detect_on: "canvas",
        events: {
            onhover: { enable: true, mode: "grab" },
            onclick: { enable: true, mode: "push" }
        },
        modes: { grab: { distance: 180, line_linked: { opacity: 0.4 } } }
    },
    retina_detect: true
});

/* ---------------- LOADER ---------------- */
window.addEventListener("load", () => {
    setTimeout(() => {
        const loader = document.getElementById("loader");
        const main = document.getElementById("main-content");
        loader.style.opacity = "0";
        setTimeout(() => {
            loader.style.display = "none";
            main.classList.remove("hidden");
        }, 800);
    }, 3000);

    loadChapters();
});

/* ---------------- LOAD CHAPTERS ---------------- */
async function loadChapters() {
    try {
        const res = await fetch(`${API_BASE}/api/chapters`);
        const chapters = await res.json();
        const select = document.getElementById("chapterSelect");
        select.innerHTML = '<option value="">Select Chapter</option>';

        chapters.forEach(ch => {
            const opt = document.createElement("option");
            opt.value = ch;
            opt.textContent = ch;
            select.appendChild(opt);
        });
    } catch (err) {
        console.error("Failed to load chapters", err);
    }
}

/* ---------------- CHAPTER CHANGE → LOAD LECTURES ---------------- */
document.getElementById("chapterSelect").addEventListener("change", async function () {
    const chapter = this.value;
    const lectureWrap = document.getElementById("lectureWrap");
    const lectureSelect = document.getElementById("lectureSelect");

    lectureSelect.innerHTML = '<option value="">Select Lecture</option>';

    if (!chapter) {
        lectureWrap.style.opacity = "0.4";
        lectureWrap.style.pointerEvents = "none";
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/lectures/${encodeURIComponent(chapter)}`);
        const lectures = await res.json();

        lectures.forEach(lec => {
            const opt = document.createElement("option");
            opt.value = lec;
            opt.textContent = `Lecture ${lec}`;
            lectureSelect.appendChild(opt);
        });

        lectureWrap.style.opacity = "1";
        lectureWrap.style.pointerEvents = "all";
        lectureWrap.style.transition = "opacity 0.3s ease";
    } catch (err) {
        console.error("Failed to load lectures", err);
    }
});

/* ---------------- LOGIN FORM SUBMIT ---------------- */
const loginForm = document.getElementById("loginForm");
loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const name = document.getElementById("userName").value.trim();
    const mobile = document.getElementById("userMobile").value.trim();
    const place = document.getElementById("userPlace").value.trim();
    const className = document.getElementById("userClass").value.trim();
    const chapter = document.getElementById("chapterSelect").value;
    const lecture = document.getElementById("lectureSelect").value;
    const btnText = document.getElementById("submitBtnText");

    if (!/^[0-9]{10}$/.test(mobile)) {
        shakeForm();
        showFormError("Please enter a valid 10-digit mobile number.");
        return;
    }

    if (!chapter) { shakeForm(); showFormError("Please select a chapter."); return; }
    if (!lecture) { shakeForm(); showFormError("Please select a lecture."); return; }

    btnText.textContent = "Checking...";

    try {
        /* 1. Fetch question */
        const qRes = await fetch(`${API_BASE}/api/question/${encodeURIComponent(chapter)}/${encodeURIComponent(lecture)}`);
        if (qRes.status === 404) {
            btnText.textContent = "Unlock Question";
            shakeForm();
            showFormError("This lecture does not exist yet.");
            return;
        }
        const questionData = await qRes.json();

        /* 2. Check attempt */
        const attemptRes = await fetch(`${API_BASE}/api/check-attempt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mobile, chapter, lecture })
        });
        const attemptData = await attemptRes.json();

        if (!attemptData.allowed) {
            showAlreadyAttempted();
            btnText.textContent = "Unlock Question";
            return;
        }

        /* 3. Register student */
        await fetch(`${API_BASE}/api/student-register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, mobile, place, className, chapter, lecture })
        });

        /* 4. Go to quiz */
        currentChapter = chapter;
        currentLecture = lecture;
        currentQuestionSet = questionData.questions;
        currentQuestionIndex = 0;
        selectedAnswers = new Array(currentQuestionSet.length).fill(null);

        setStep(2);
        document.getElementById("login-page").classList.add("hidden");
        document.getElementById("quiz-page").classList.remove("hidden");
        document.getElementById("quiz-page").classList.add("slide-in");

        document.getElementById("quiz-chapter-label").textContent = chapter;
        document.getElementById("quiz-lecture-label").textContent = `Lecture ${lecture}`;
        document.getElementById("q-total").textContent = currentQuestionSet.length;

        if (currentQuestionSet.length > 1) {
            document.getElementById("quiz-nav").classList.remove("hidden");
        }

        renderQuestion(currentQuestionIndex);
        startTimer(currentQuestionSet.length * 60); // 1 min per question

    } catch (err) {
        console.error(err);
        shakeForm();
        showFormError("Connection error. Please try again.");
        btnText.textContent = "Unlock Question";
    }
});

/* ---------------- RENDER QUESTION ---------------- */
function renderQuestion(index) {
    const q = currentQuestionSet[index];
    document.getElementById("q-current").textContent = index + 1;
    document.getElementById("question-text").textContent = q.question;

    const container = document.getElementById("options-container");
    container.innerHTML = "";

    const letters = ["A", "B", "C", "D"];

    q.options.forEach((opt, i) => {
        const div = document.createElement("div");
        div.className = "option";
        if (selectedAnswers[index] === i) div.classList.add("selected");

        div.innerHTML = `<span class="option-letter">${letters[i]}</span><span>${opt}</span>`;
        div.onclick = () => selectAnswer(div, i, index);
        container.appendChild(div);
    });

    // Update nav buttons
    document.getElementById("prevBtn").disabled = index === 0;
    document.getElementById("nextBtn").disabled = index === currentQuestionSet.length - 1;

    // Show submit if all answered
    checkSubmitReady();
}

/* ---------------- SELECT ANSWER ---------------- */
function selectAnswer(element, optionIndex, questionIndex) {
    // Don't allow re-selection after submission
    if (document.querySelector(".option.correct, .option.incorrect")) return;

    selectedAnswers[questionIndex] = optionIndex;

    const options = document.querySelectorAll(".option");
    options.forEach(opt => opt.classList.remove("selected"));
    element.classList.add("selected");

    checkSubmitReady();
}

function checkSubmitReady() {
    const allAnswered = selectedAnswers.every(a => a !== null);
    document.getElementById("submitAnswerBtn").disabled = !allAnswered;
}

/* ---------------- NAVIGATION ---------------- */
function nextQuestion() {
    if (currentQuestionIndex < currentQuestionSet.length - 1) {
        currentQuestionIndex++;
        renderQuestion(currentQuestionIndex);
    }
}

function prevQuestion() {
    if (currentQuestionIndex > 0) {
        currentQuestionIndex--;
        renderQuestion(currentQuestionIndex);
    }
}

/* ---------------- TIMER ---------------- */
function startTimer(seconds) {
    timeLeft = seconds;
    const display = document.getElementById("timer-display");
    const timerEl = document.getElementById("quiz-timer");

    function updateDisplay() {
        const m = Math.floor(timeLeft / 60);
        const s = timeLeft % 60;
        display.textContent = `${m}:${s.toString().padStart(2, "0")}`;

        timerEl.classList.remove("warning", "danger");
        if (timeLeft <= 30) timerEl.classList.add("danger");
        else if (timeLeft <= 60) timerEl.classList.add("warning");
    }

    updateDisplay();

    timerInterval = setInterval(() => {
        timeLeft--;
        updateDisplay();
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            // Auto-fill unanswered with -1 and submit
            selectedAnswers = selectedAnswers.map(a => a === null ? -1 : a);
            submitAnswer(true);
        }
    }, 1000);
}

/* ---------------- SUBMIT ---------------- */
async function submitAnswer(timedOut = false) {
    clearInterval(timerInterval);

    const btn = document.getElementById("submitAnswerBtn");
    const syncText = document.getElementById("sync-text");
    const mobile = document.getElementById("userMobile").value.trim();
    const name = document.getElementById("userName").value.trim();
    const place = document.getElementById("userPlace").value.trim();
    const className = document.getElementById("userClass").value.trim();

    btn.disabled = true;
    btn.textContent = "Submitting...";
    if (syncText) syncText.style.display = "block";

    // Lock all options
    document.querySelectorAll(".option").forEach(o => o.style.pointerEvents = "none");

    try {
        const res = await fetch(`${API_BASE}/api/submit-attempt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mobile, chapter: currentChapter, lecture: currentLecture,
                selectedAnswers, name, place, className
            })
        });

        const data = await res.json();

        if (res.ok && data.success) {
            setTimeout(() => showResults(data.correctCount, data.totalQuestions), 600);
        } else if (!data.allowed) {
            showAlreadyAttempted();
        } else {
            throw new Error("Server error");
        }

    } catch (err) {
        console.error("Submit failed:", err);
        btn.disabled = false;
        btn.textContent = "Retry Submit";
        if (syncText) syncText.textContent = "Sync failed. Please try again.";
    }
}

/* ---------------- SHOW RESULTS ---------------- */
function showResults(correctCount, totalQuestions) {
    setStep(3);
    document.getElementById("quiz-page").classList.add("hidden");
    const resultPage = document.getElementById("result-page");
    resultPage.classList.remove("hidden");
    resultPage.classList.add("slide-in");

    const pct = totalQuestions > 0 ? correctCount / totalQuestions : 0;
    const name = document.getElementById("userName").value.trim();

    // Icon & message
    let icon, title, subtitle;
    if (pct === 1) {
        icon = "🏆"; title = "Perfect Score!"; subtitle = "Absolutely brilliant work!";
        fireConfetti();
    } else if (pct >= 0.7) {
        icon = "🎉"; title = "Great Job!"; subtitle = "You have a solid understanding!";
        fireConfetti(0.5);
    } else if (pct >= 0.5) {
        icon = "💪"; title = "Good Effort!"; subtitle = "Keep practicing — you're getting there!";
    } else {
        icon = "📚"; title = "Keep Studying!"; subtitle = "Revisit the lecture and try again next time.";
    }

    document.getElementById("result-icon").textContent = icon;
    document.getElementById("result-title").textContent = title;
    document.getElementById("result-correct").textContent = correctCount;
    document.getElementById("result-total").textContent = totalQuestions;
    document.getElementById("result-subtitle").textContent = subtitle;
    document.getElementById("result-name").textContent = `👤 ${name}`;
    document.getElementById("result-chapter").textContent = `📚 ${currentChapter}`;
    document.getElementById("result-lecture-meta").textContent = `🎬 Lecture ${currentLecture}`;

    // Breakdown
    const breakdown = document.getElementById("result-breakdown");
    breakdown.innerHTML = "";

    currentQuestionSet.forEach((q, i) => {
        const userAns = selectedAnswers[i];
        const correct = userAns === q.correctIndex;
        const letters = ["A", "B", "C", "D"];
        const item = document.createElement("div");
        item.className = `breakdown-item ${correct ? "ok" : "wrong"}`;
        item.innerHTML = `
            <span>${correct ? "✅" : "❌"}</span>
            <span style="flex:1;opacity:0.9">Q${i + 1}: ${q.question.length > 60 ? q.question.slice(0, 60) + "…" : q.question}</span>
            <span style="font-family:'Space Mono',monospace;font-size:0.75rem;opacity:0.7">${correct ? "Correct" : `Ans: ${letters[q.correctIndex]}`}</span>
        `;
        breakdown.appendChild(item);
    });
}

/* ---------------- CONFETTI ---------------- */
function fireConfetti(intensity = 1) {
    const count = Math.floor(150 * intensity);
    confetti({ particleCount: count, spread: 80, origin: { y: 0.6 }, colors: ["#00f2fe", "#4facfe", "#a78bfa", "#2ecc71"] });
}

/* ---------------- STEP TRACKER ---------------- */
function setStep(n) {
    document.querySelectorAll(".step").forEach((el, i) => {
        el.classList.remove("active", "done");
        if (i + 1 < n) el.classList.add("done");
        if (i + 1 === n) el.classList.add("active");
    });
}

/* ---------------- ALREADY ATTEMPTED ---------------- */
function showAlreadyAttempted() {
    shakeForm();
    const existing = document.getElementById("already-msg");
    if (existing) existing.remove();

    const msg = document.createElement("div");
    msg.id = "already-msg";
    msg.className = "already-msg";
    msg.innerHTML = `🚫 <strong>Already Attempted</strong><br>This number has already answered this lecture's questions.`;
    loginForm.appendChild(msg);
}

/* ---------------- FORM HELPERS ---------------- */
function shakeForm() {
    loginForm.style.animation = "shake 0.4s";
    setTimeout(() => loginForm.style.animation = "", 400);
}

function showFormError(msg) {
    const existing = document.getElementById("form-error");
    if (existing) existing.remove();

    const el = document.createElement("div");
    el.id = "form-error";
    el.className = "already-msg";
    el.textContent = msg;
    loginForm.appendChild(el);

    setTimeout(() => el.remove(), 4000);
}
