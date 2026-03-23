const API_BASE = "https://grip-physics.onrender.com";
const QUOTES = [
    '"The important thing is not to stop questioning." — Einstein',
    '"Physics is the poetry of the universe." — Unknown',
    '"In physics, you do not have to go around making trouble for yourself. Nature does it for you." — Hawking',
    '"The universe is under no obligation to make sense to you." — Tyson',
    '"Nothing in life is to be feared, only to be understood." — Curie'
];

let currentQuestionSet = null, currentLecture = null, currentChapter = null;
let currentQuestionIndex = 0, selectedAnswers = [], timerInterval = null, timeLeft = 120;

document.getElementById("quote").innerText = QUOTES[Math.floor(Math.random() * QUOTES.length)];

/* ---- KATEX RENDER ---- */
function renderMath(el) {
    if (window.renderMathInElement) {
        renderMathInElement(el, {
            delimiters: [
                { left: "$$", right: "$$", display: true },
                { left: "$", right: "$", display: false }
            ],
            throwOnError: false
        });
    }
}

function setMathText(el, text) {
    // Use textContent to safely insert the text (preserves $ signs)
    // then run KaTeX auto-render to process $...$ delimiters
    el.textContent = text;
    renderMath(el);
    // If KaTeX didn't render (no $ found), textContent is fine as-is
}

/* ---- PARTICLES ---- */
particlesJS("particles-js", {
    particles: { number: { value: 70 }, color: { value: ["#00f2fe", "#4facfe", "#a78bfa"] }, shape: { type: "circle" }, opacity: { value: 0.4, random: true }, size: { value: 2.5, random: true }, line_linked: { enable: true, distance: 130, color: "#4facfe", opacity: 0.15, width: 1 }, move: { enable: true, speed: 1.5 } },
    interactivity: { detect_on: "canvas", events: { onhover: { enable: true, mode: "grab" }, onclick: { enable: true, mode: "push" } }, modes: { grab: { distance: 180, line_linked: { opacity: 0.4 } } } },
    retina_detect: true
});

/* ---- LOADER ---- */
window.addEventListener("load", () => {
    setTimeout(() => {
        const loader = document.getElementById("loader"), main = document.getElementById("main-content");
        loader.style.opacity = "0";
        setTimeout(() => { loader.style.display = "none"; main.classList.remove("hidden"); }, 800);
    }, 3000);
    loadChapters();
});

/* ---- LOAD CHAPTERS ---- */
async function loadChapters() {
    try {
        const res = await fetch(`${API_BASE}/api/chapters`);
        const chapters = await res.json();
        const sel = document.getElementById("chapterSelect");
        sel.innerHTML = '<option value="">Select Chapter</option>';
        chapters.forEach(ch => { const o = document.createElement("option"); o.value = ch; o.textContent = ch; sel.appendChild(o); });
    } catch (e) { console.error("chapters:", e); }
}

document.getElementById("chapterSelect").addEventListener("change", async function () {
    const chapter = this.value, wrap = document.getElementById("lectureWrap"), sel = document.getElementById("lectureSelect");
    sel.innerHTML = '<option value="">Select Lecture</option>';
    if (!chapter) { wrap.style.opacity = "0.4"; wrap.style.pointerEvents = "none"; return; }
    try {
        const res = await fetch(`${API_BASE}/api/lectures/${encodeURIComponent(chapter)}`);
        const lectures = await res.json();
        lectures.forEach(l => { const o = document.createElement("option"); o.value = l; o.textContent = `Lecture ${l}`; sel.appendChild(o); });
        wrap.style.opacity = "1"; wrap.style.pointerEvents = "all"; wrap.style.transition = "opacity 0.3s";
    } catch (e) { console.error("lectures:", e); }
});

/* ---- LOGIN ---- */
document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("userName").value.trim();
    const mobile = document.getElementById("userMobile").value.trim();
    const place = document.getElementById("userPlace").value.trim();
    const className = document.getElementById("userClass").value.trim();
    const chapter = document.getElementById("chapterSelect").value;
    const lecture = document.getElementById("lectureSelect").value;
    const btnText = document.getElementById("submitBtnText");

    if (!/^[0-9]{10}$/.test(mobile)) { shakeForm(); showFormError("Please enter a valid 10-digit mobile number."); return; }
    if (!chapter) { shakeForm(); showFormError("Please select a chapter."); return; }
    if (!lecture) { shakeForm(); showFormError("Please select a lecture."); return; }

    btnText.textContent = "Checking...";
    try {
        const qRes = await fetch(`${API_BASE}/api/question/${encodeURIComponent(chapter)}/${encodeURIComponent(lecture)}`);
        if (qRes.status === 404) { btnText.textContent = "Unlock Question"; shakeForm(); showFormError("This lecture does not exist yet."); return; }
        const questionData = await qRes.json();

        const attemptRes = await fetch(`${API_BASE}/api/check-attempt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mobile, chapter, lecture }) });
        const attemptData = await attemptRes.json();
        if (!attemptData.allowed) { showAlreadyAttempted(); btnText.textContent = "Unlock Question"; return; }

        await fetch(`${API_BASE}/api/student-register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mobile, place, className, chapter, lecture }) });

        currentChapter = chapter; currentLecture = lecture;
        currentQuestionSet = questionData.questions;
        currentQuestionIndex = 0;
        // selectedAnswers: for multi-correct, each element is an array; for single, a number|null
        selectedAnswers = currentQuestionSet.map(q => q.isMultiCorrect ? [] : null);

        setStep(2);
        document.getElementById("login-page").classList.add("hidden");
        document.getElementById("quiz-page").classList.remove("hidden");
        document.getElementById("quiz-page").classList.add("slide-in");
        document.getElementById("quiz-chapter-label").textContent = chapter;
        document.getElementById("quiz-lecture-label").textContent = `Lecture ${lecture}`;
        document.getElementById("q-total").textContent = currentQuestionSet.length;
        if (currentQuestionSet.length > 1) document.getElementById("quiz-nav").classList.remove("hidden");
        renderQuestion(0);
    } catch (err) {
        console.error(err); shakeForm(); showFormError("Connection error. Please try again.");
        btnText.textContent = "Unlock Question";
    }
});

/* ---- RENDER QUESTION ---- */
function renderQuestion(index) {
    const q = currentQuestionSet[index];
    document.getElementById("q-current").textContent = index + 1;
    const letters = ["A", "B", "C", "D"];

    // Multi-correct notice
    const notice = document.getElementById("multi-correct-notice");
    notice.classList.toggle("hidden", !q.isMultiCorrect);

    // Question text with KaTeX
    const qTextEl = document.getElementById("question-text");
    setMathText(qTextEl, q.question);

    // Options
    const container = document.getElementById("options-container");
    container.innerHTML = "";

    q.options.forEach((opt, i) => {
        const div = document.createElement("div");
        div.className = "option";

        // Highlight already-selected answers
        if (q.isMultiCorrect) {
            const sel = selectedAnswers[index] || [];
            if (sel.includes(i)) div.classList.add("selected");
        } else {
            if (selectedAnswers[index] === i) div.classList.add("selected");
        }

        const letterSpan = document.createElement("span");
        letterSpan.className = "option-letter";
        letterSpan.textContent = letters[i];

        const textSpan = document.createElement("span");
        textSpan.style.flex = "1";
        textSpan.textContent = opt;

        div.appendChild(letterSpan);
        div.appendChild(textSpan);
        div.onclick = () => selectAnswer(div, i, index);
        container.appendChild(div);
    });

    // Render math in question and all options after DOM is fully built
    renderMath(container);

    document.getElementById("prevBtn").disabled = index === 0;
    document.getElementById("nextBtn").disabled = index === currentQuestionSet.length - 1;
    checkSubmitReady();
}

/* ---- SELECT ANSWER ---- */
function selectAnswer(element, optionIndex, questionIndex) {
    if (document.querySelector(".option.correct, .option.incorrect")) return;
    const q = currentQuestionSet[questionIndex];

    if (q.isMultiCorrect) {
        // Toggle selection for multi-correct
        if (!Array.isArray(selectedAnswers[questionIndex])) selectedAnswers[questionIndex] = [];
        const arr = selectedAnswers[questionIndex];
        const pos = arr.indexOf(optionIndex);
        if (pos === -1) arr.push(optionIndex); else arr.splice(pos, 1);
        // Re-render to update highlights
        renderQuestion(questionIndex);
    } else {
        selectedAnswers[questionIndex] = optionIndex;
        document.querySelectorAll(".option").forEach(o => o.classList.remove("selected"));
        element.classList.add("selected");
    }
    checkSubmitReady();
}

function checkSubmitReady() {
    const allAnswered = selectedAnswers.every((a, i) => {
        const q = currentQuestionSet[i];
        if (q.isMultiCorrect) return Array.isArray(a) && a.length > 0;
        return a !== null;
    });
    document.getElementById("submitAnswerBtn").disabled = !allAnswered;
}

function nextQuestion() { if (currentQuestionIndex < currentQuestionSet.length - 1) { currentQuestionIndex++; renderQuestion(currentQuestionIndex); } }
function prevQuestion() { if (currentQuestionIndex > 0) { currentQuestionIndex--; renderQuestion(currentQuestionIndex); } }

/* ---- TIMER ---- */
function startTimer(seconds) {
    // Timer removed — students answer at their own pace
}

/* ---- SUBMIT ---- */
async function submitAnswer(timedOut = false) {
    clearInterval(timerInterval);
    const btn = document.getElementById("submitAnswerBtn"), syncText = document.getElementById("sync-text");
    const mobile = document.getElementById("userMobile").value.trim();
    const name = document.getElementById("userName").value.trim();
    const place = document.getElementById("userPlace").value.trim();
    const className = document.getElementById("userClass").value.trim();
    btn.disabled = true; btn.textContent = "Submitting...";
    if (syncText) syncText.style.display = "block";
    document.querySelectorAll(".option").forEach(o => o.style.pointerEvents = "none");
    try {
        const res = await fetch(`${API_BASE}/api/submit-attempt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mobile, chapter: currentChapter, lecture: currentLecture, selectedAnswers, name, place, className }) });
        const data = await res.json();
        if (res.ok && data.success) { setTimeout(() => showResults(data.correctCount, data.totalQuestions), 600); }
        else if (!data.allowed) { showAlreadyAttempted(); }
        else throw new Error("Server error");
    } catch (err) { console.error(err); btn.disabled = false; btn.textContent = "Retry Submit"; if (syncText) syncText.textContent = "Sync failed. Please try again."; }
}

/* ---- RESULTS ---- */
function showResults(correctCount, totalQuestions) {
    setStep(3);
    document.getElementById("quiz-page").classList.add("hidden");
    const rp = document.getElementById("result-page");
    rp.classList.remove("hidden"); rp.classList.add("slide-in");
    const pct = totalQuestions > 0 ? correctCount / totalQuestions : 0;
    const name = document.getElementById("userName").value.trim();
    let icon, title, subtitle;
    if (pct === 1) { icon = "🏆"; title = "Perfect Score!"; subtitle = "Absolutely brilliant work!"; fireConfetti(); }
    else if (pct >= 0.7) { icon = "🎉"; title = "Great Job!"; subtitle = "You have a solid understanding!"; fireConfetti(0.5); }
    else if (pct >= 0.5) { icon = "💪"; title = "Good Effort!"; subtitle = "Keep practicing — you're getting there!"; }
    else { icon = "📚"; title = "Keep Studying!"; subtitle = "Revisit the lecture and try again next time."; }
    document.getElementById("result-icon").textContent = icon;
    document.getElementById("result-title").textContent = title;
    document.getElementById("result-correct").textContent = correctCount;
    document.getElementById("result-total").textContent = totalQuestions;
    document.getElementById("result-subtitle").textContent = subtitle;
    document.getElementById("result-name").textContent = `👤 ${name}`;
    document.getElementById("result-chapter").textContent = `📚 ${currentChapter}`;
    document.getElementById("result-lecture-meta").textContent = `🎬 Lecture ${currentLecture}`;
    const breakdown = document.getElementById("result-breakdown");
    breakdown.innerHTML = "";
    const letters = ["A", "B", "C", "D"];
    currentQuestionSet.forEach((q, i) => {
        const correctIdxs = q.correctIndexes || [q.correctIndex || 0];
        let isCorrectAns = false;
        if (q.isMultiCorrect) {
            const sel = Array.isArray(selectedAnswers[i]) ? [...selectedAnswers[i]].sort() : [];
            isCorrectAns = JSON.stringify(sel) === JSON.stringify([...correctIdxs].sort());
        } else {
            isCorrectAns = selectedAnswers[i] === correctIdxs[0];
        }
        const item = document.createElement("div");
        item.className = `breakdown-item ${isCorrectAns ? "ok" : "wrong"}`;
        const correctStr = correctIdxs.map(x => letters[x]).join(", ");
        item.innerHTML = `<span>${isCorrectAns ? "✅" : "❌"}</span><span style="flex:1">Q${i + 1}: ${q.question.length > 50 ? q.question.slice(0, 50) + "…" : q.question}</span><span style="font-size:0.75rem;opacity:0.7">${isCorrectAns ? "Correct" : `Ans: ${correctStr}`}</span>`;
        breakdown.appendChild(item);
    });
    renderMath(breakdown);
}

function fireConfetti(intensity = 1) { confetti({ particleCount: Math.floor(150 * intensity), spread: 80, origin: { y: 0.6 }, colors: ["#00f2fe", "#4facfe", "#a78bfa", "#2ecc71"] }); }
function setStep(n) { document.querySelectorAll(".step").forEach((el, i) => { el.classList.remove("active", "done"); if (i + 1 < n) el.classList.add("done"); if (i + 1 === n) el.classList.add("active"); }); }
function showAlreadyAttempted() { shakeForm(); const e = document.getElementById("already-msg"); if (e) e.remove(); const m = document.createElement("div"); m.id = "already-msg"; m.className = "already-msg"; m.innerHTML = "🚫 <strong>Already Attempted</strong><br>This number has already answered this lecture's questions."; document.getElementById("loginForm").appendChild(m); }
function shakeForm() { const f = document.getElementById("loginForm"); f.style.animation = "shake 0.4s"; setTimeout(() => f.style.animation = "", 400); }
function showFormError(msg) { const e = document.getElementById("form-error"); if (e) e.remove(); const el = document.createElement("div"); el.id = "form-error"; el.className = "already-msg"; el.textContent = msg; document.getElementById("loginForm").appendChild(el); setTimeout(() => el.remove(), 4000); }
