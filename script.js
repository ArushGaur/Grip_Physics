// Replace this with your actual Web3Forms Access Key
const ACCESS_KEY = "YOUR_ACCESS_KEY_HERE";

// 1. Particle Configuration (Classic Grab Effect)
particlesJS('particles-js', {
    particles: {
        number: { value: 100, density: { enable: true, value_area: 800 } },
        color: { value: "#00f2fe" },
        shape: { type: "circle" },
        opacity: { value: 0.5, random: true },
        size: { value: 3, random: true },
        line_linked: { enable: true, distance: 150, color: "#00f2fe", opacity: 0.2, width: 1 },
        move: { enable: true, speed: 2, direction: "none", random: false, straight: false, out_mode: "out", bounce: false }
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

// 2. Loading Screen Logic (3 Seconds)
window.addEventListener('load', () => {
    setTimeout(() => {
        const loader = document.getElementById('loader');
        const main = document.getElementById('main-content');
        loader.style.opacity = '0';
        setTimeout(() => {
            loader.style.display = 'none';
            main.classList.remove('hidden');
        }, 800);
    }, 3000);
});

// 3. Form Submission
const loginForm = document.getElementById('loginForm');
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    document.getElementById('submitBtn').innerText = "Registering...";

    const formData = {
        access_key: ACCESS_KEY,
        name: document.getElementById('userName').value,
        mobile: document.getElementById('userMobile').value,
        place: document.getElementById('userPlace').value,
        class: document.getElementById('userClass').value,
        subject: "New Student Enrollment: Grip Physics"
    };

    try {
        await fetch('https://api.web3forms.com/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
        });
        document.getElementById('login-page').classList.add('hidden');
        document.getElementById('quiz-page').classList.remove('hidden');
    } catch (err) {
        alert("Submission failed. Check your internet.");
    }
});

// 4. Quiz Selection & Submit
let selectedOption = null;
let selectedIsCorrect = false;

function selectAnswer(element, isCorrect) {
    // Don't allow re-selection after submit
    if (document.getElementById('submitAnswerBtn').disabled === false && 
        document.querySelector('.correct, .incorrect')) return;

    const options = document.querySelectorAll('.option');
    options.forEach(opt => opt.classList.remove('selected'));

    element.classList.add('selected');
    selectedOption = element;
    selectedIsCorrect = isCorrect;

    document.getElementById('submitAnswerBtn').disabled = false;
    document.getElementById('feedback').innerHTML = '';
}

function submitAnswer() {
    if (!selectedOption) return;

    const options = document.querySelectorAll('.option');
    const feedback = document.getElementById('feedback');
    const submitBtn = document.getElementById('submitAnswerBtn');
    const syncText = document.getElementById('sync-text');

    // Lock all options
    options.forEach(opt => {
        opt.style.pointerEvents = 'none';
        opt.classList.remove('selected');
    });
    submitBtn.disabled = true;
    submitBtn.innerText = 'Submitted ✓';

    if (selectedIsCorrect) {
        selectedOption.classList.add('correct');
        feedback.innerHTML = "✨ Excellent! That's correct.";
        feedback.style.color = "var(--success)";
    } else {
        selectedOption.classList.add('incorrect');
        feedback.innerHTML = "❌ Incorrect. Keep studying!";
        feedback.style.color = "var(--error)";
        options[2].classList.add('correct'); // Highlight correct answer
    }

    syncText.style.display = 'block';

    // Send result to Web3Forms
    fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            access_key: ACCESS_KEY,
            student_name: document.getElementById('userName').value,
            answer: selectedOption.innerText,
            status: selectedIsCorrect ? "Passed" : "Failed"
        })
    });
}