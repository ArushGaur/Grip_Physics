// Replace with your Web3Forms key
const ACCESS_KEY = "YOUR_ACCESS_KEY_HERE";

/* ---------------- API CONFIG ---------------- */

const API_BASE = "https://grip-physics.onrender.com";

/* ---------------- GLOBAL VARIABLES ---------------- */

let currentCorrectIndex = null;
let currentLecture = null;

let selectedOption = null;
let selectedIndex = null;


/* ---------------- LOAD QUESTION ---------------- */

function renderQuestion(data) {

    currentCorrectIndex = data.correctIndex;

    document.getElementById("question-text").innerText = data.question;

    const container = document.querySelector(".options-container");
    container.innerHTML = "";

    data.options.forEach((opt, index) => {

        const div = document.createElement("div");

        div.className = "option";
        div.innerText = opt;

        div.onclick = function () {
            selectAnswer(this, index);
        };

        container.appendChild(div);

    });

}


/* ---------------- FETCH QUESTION ---------------- */

async function fetchLectureQuestion(lecture) {

    try {

        const res = await fetch(`${API_BASE}/api/question/${lecture}`);

        if (res.status === 404) {

            alert("Lecture does not exist");
            return null;

        }

        const data = await res.json();

        return data;

    } catch (err) {

        alert("Failed to load lecture question");
        return null;

    }

}


/* ---------------- PARTICLES ---------------- */

particlesJS("particles-js", {

    particles: {
        number: { value: 100 },
        color: { value: "#00f2fe" },
        shape: { type: "circle" },
        opacity: { value: 0.5, random: true },
        size: { value: 3, random: true },
        line_linked: {
            enable: true,
            distance: 150,
            color: "#00f2fe",
            opacity: 0.2,
            width: 1
        },
        move: { enable: true, speed: 2 }
    },

    interactivity: {
        detect_on: "canvas",
        events: {
            onhover: { enable: true, mode: "grab" },
            onclick: { enable: true, mode: "push" }
        },
        modes: {
            grab: { distance: 200, line_linked: { opacity: 0.5 } }
        }
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

});


/* ---------------- LOGIN FORM ---------------- */

const loginForm = document.getElementById("loginForm");

loginForm.addEventListener("submit", async (e) => {

    e.preventDefault();

    const name = document.getElementById("userName").value;
    const mobile = document.getElementById("userMobile").value.trim();
    const place = document.getElementById("userPlace").value;
    const className = document.getElementById("userClass").value;
    const lecture = document.getElementById("lectureNumber").value;

    document.getElementById("submitBtn").innerText = "Checking...";


    /* -------- CHECK LECTURE FIRST -------- */

    const questionData = await fetchLectureQuestion(lecture);

    if (!questionData) {

        document.getElementById("submitBtn").innerText = "Unlock Question";
        return;

    }


    /* -------- CHECK ATTEMPT -------- */

    const attemptCheck = await fetch(`${API_BASE}/api/check-attempt`, {

        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile, lecture })

    });

    const attemptData = await attemptCheck.json();

    if (!attemptData.allowed) {

        showAlreadyAttempted();
        document.getElementById("submitBtn").innerText = "Unlock Question";
        return;

    }


    /* -------- REGISTER STUDENT -------- */

    await fetch(`${API_BASE}/api/student-register`, {

        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            mobile,
            place,
            className,
            lecture
        })

    });


    /* -------- OPTIONAL EMAIL -------- */

    await fetch("https://api.web3forms.com/submit", {

        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({

            access_key: ACCESS_KEY,
            name: name,
            mobile: mobile,
            place: place,
            class: className,
            lecture: lecture,
            subject: "New Student Enrollment: Grip Physics"

        })

    });


    /* -------- SHOW QUIZ PAGE -------- */

    currentLecture = lecture;

    document.getElementById("login-page").classList.add("hidden");
    document.getElementById("quiz-page").classList.remove("hidden");

    renderQuestion(questionData);

});


/* ---------------- ALREADY ATTEMPTED ---------------- */

function showAlreadyAttempted() {

    const form = document.getElementById("loginForm");

    form.style.animation = "shake 0.4s";

    setTimeout(() => {
        form.style.animation = "";
    }, 400);

    const existing = document.getElementById("already-msg");
    if (existing) existing.remove();

    const msg = document.createElement("div");

    msg.id = "already-msg";

    msg.innerHTML = `
<div style="
margin-top:18px;
padding:14px 18px;
border-radius:12px;
background:rgba(231,76,60,0.18);
border:1px solid rgba(231,76,60,0.5);
color:#ff6b6b;
font-size:0.85rem;
text-align:center;">
🚫 <strong>Already Attempted</strong><br>
This number already answered this question.
</div>
`;

    form.appendChild(msg);

}


/* ---------------- QUIZ LOGIC ---------------- */

function selectAnswer(element, index) {

    if (document.querySelector(".correct,.incorrect")) return;

    const options = document.querySelectorAll(".option");

    options.forEach(opt => opt.classList.remove("selected"));

    element.classList.add("selected");

    selectedOption = element;
    selectedIndex = index;

    document.getElementById("submitAnswerBtn").disabled = false;

}


async function submitAnswer() {

    if (selectedOption === null) return;

    const options = document.querySelectorAll(".option");
    const feedback = document.getElementById("feedback");
    const mobile = document.getElementById("userMobile").value.trim();

    options.forEach(opt => {

        opt.style.pointerEvents = "none";
        opt.classList.remove("selected");

    });


    /* -------- SHOW RESULT -------- */

    if (selectedIndex === currentCorrectIndex) {

        selectedOption.classList.add("correct");

        feedback.innerHTML = "✨ Excellent! That's correct.";
        feedback.style.color = "var(--success)";

    } else {

        selectedOption.classList.add("incorrect");

        feedback.innerHTML = "❌ Incorrect. Keep studying!";
        feedback.style.color = "var(--error)";

        options[currentCorrectIndex].classList.add("correct");

    }


    /* -------- SAVE ATTEMPT -------- */

    await fetch(`${API_BASE}/api/submit-attempt`, {

        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            mobile: mobile,
            lecture: currentLecture,
            selectedIndex: selectedIndex
        })

    });

}