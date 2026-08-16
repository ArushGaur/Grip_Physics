/* ══════════════════════════════════════════════════════════════════
           GLOBALS
        ══════════════════════════════════════════════════════════════════ */
const API_BASE = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? `http://${window.location.host}`
    : (window.location.hostname.endsWith(".github.io") ? "https://vyorra-krrsh.sevalla.app" : "");
console.log("API_BASE set to:", API_BASE);
console.log("Location:", window.location.href);
const LETTERS = ["A", "B", "C", "D"];
const CHAPTER_ICONS = ["⚡", "🔥", "🌊", "🔭", "⚗️", "🧲", "🔬", "🌡️", "🌍", "💡", "🪐", "☄️", "🔋", "💻", "🎯", "🔌", "🌌", "⚛️", "⚙️", "🪫", "🔩", "📡"];

function encodeQuestionPathPart(value) {
    return encodeURIComponent(value == null || value === "" ? "_none_" : String(value));
}

function jsString(value) {
    return JSON.stringify(String(value ?? ""));
}

function formatChapterLabel(chapter) {
    return String(chapter || "")
        .replace(/^\s*(?:chapter\s*)?\d+\s*[:\-.)]\s*/i, "")
        .replace(/^\s*\d+\s*[-–]\s*/i, "")
        .trim() || String(chapter || "");
}

function getChapterEmoji(chapter) {
    const name = formatChapterLabel(chapter).toLowerCase();
    const rules = [
        [/units?\s*,?\s*dimensions|measurement|significant figures|errors?/, "📏"],
        [/motion in one dimension|distance and displacement|speed and velocity|acceleration|free fall/, "🛣️"],
        [/motion in two dimensions|vectors?|projectile|relative velocity/, "🎯"],
        [/laws of motion|friction|pseudo force|pulley|circular motion/, "🧲"],
        [/work power and energy|energy|power/, "⚡"],
        [/center of mass|collision|momentum|impulse/, "💥"],
        [/rotational motion|torque|angular momentum|moment of inertia|rolling/, "🌀"],
        [/gravitation|satellites?|escape velocity|kepler/, "🪐"],
        [/solids?|stress|strain|elasticity|young modulus/, "🧱"],
        [/fluids?|pressure|surface tension|viscosity|bernoulli/, "🌊"],
        [/thermal properties|heat transfer|calorimetry|thermal expansion/, "🌡️"],
        [/kinetic theory|rms speed|degrees of freedom|ideal gas/, "💨"],
        [/thermodynamics|carnot|adiabatic|isothermal|entropy|enthalpy/, "🔥"],
        [/simple harmonic motion|pendulum|spring|oscillation/, "🎵"],
        [/waves?|doppler|standing waves?|resonance/, "〰️"],
        [/electric charges and fields|coulomb|electric field|gauss/, "⚡"],
        [/electrostatic potential|capacitance|capacitor/, "🔋"],
        [/current electricity|ohm|kirchhoff|wheatstone|potentiometer|drift velocity/, "🔌"],
        [/moving charges and magnetism|biot[- ]savart|ampere|cyclotron/, "🧲"],
        [/magnetism and matter|earth magnetism|para|dia|ferro/, "🧭"],
        [/electromagnetic induction|faraday|lenz|eddy currents?|self inductance/, "🧲"],
        [/alternating current|rms|lcr|transformers?/, "🔁"],
        [/electromagnetic waves?|maxwell|em spectrum/, "📡"],
        [/ray optics|reflection|refraction|mirrors?|lenses?|optical instruments/, "🔭"],
        [/wave optics|interference|diffraction|polarisation|ydse/, "🌈"],
        [/dual nature of radiation and matter|photoelectric|de broglie/, "🧪"],
        [/atoms?|rutherford|bohr|hydrogen spectrum/, "⚛️"],
        [/nuclei|radioactivity|binding energy|nuclear reactions/, "☢️"],
        [/semiconductor electronics|pn junction|diode|transistor|logic gates|zener/, "💡"],
        [/some basic concepts|mole concept|stoichiometry|concentration/, "⚗️"],
        [/atomic structure|quantum numbers|electronic configuration/, "⚛️"],
        [/states of matter|gas laws|kinetic theory/, "💨"],
        [/chemical equilibrium|ionic equilibrium|buffer/, "⚖️"],
        [/redox/, "🔄"],
        [/solutions?|raoult|colligative/, "💧"],
        [/electrochemistry|nernst|conductance|electrolysis/, "🔋"],
        [/chemical kinetics|rate law|arrhenius|order of reaction/, "⏱️"],
        [/surface chemistry|adsorption|catalysis|colloids/, "🫧"],
        [/periodicity|periodic trends|periodic table/, "📊"],
        [/chemical bonding|vsepr|mot|hybridization|ionic bond|covalent bond/, "🔗"],
        [/hydrogen|hydrides|water|hydrogen peroxide/, "💧"],
        [/s-block/, "🧂"],
        [/p-block/, "🧪"],
        [/d and f block|transition elements|lanthanides|actinides/, "🧲"],
        [/coordination compounds|ligands|werner|isomerism/, "🧷"],
        [/metallurgy|extraction|refining/, "⛏️"],
        [/environmental chemistry|pollution/, "🌍"],
        [/general organic chemistry|electronic effects|acidity|basicity|intermediates/, "🧬"],
        [/hydrocarbons|alkanes|alkenes|alkynes|aromatic/, "🛢️"],
        [/haloalkanes|haloarenes/, "🧪"],
        [/alcohols|phenols|ethers/, "🍶"],
        [/aldehydes|ketones/, "🧫"],
        [/carboxylic acids/, "🧴"],
        [/amines/, "🧪"],
        [/biomolecules/, "🧬"],
        [/polymers/, "🧵"],
        [/chemistry in everyday life/, "🧴"],
        [/sets?\b|relations?\b|functions?\b/, "∪"],
        [/inverse trigonometric/, "∠"],
        [/complex numbers|quadratic equations/, "🔢"],
        [/matrices?/, "🧮"],
        [/determinants?/, "📐"],
        [/permutations?|combinations?/, "🎲"],
        [/binomial theorem|sequence and series/, "➗"],
        [/probability/, "🎯"],
        [/statistics/, "📈"],
        [/mathematical reasoning/, "💭"],
        [/trigonometric ratios and identities|trigonometric equations/, "📐"],
        [/straight lines|pair of straight lines/, "📏"],
        [/circle/, "◯"],
        [/parabola/, "∪"],
        [/ellipse/, "⬭"],
        [/hyperbola/, "∞"],
        [/limits?|continuity|differentiability|derivatives?|integrals?|differential equations?/, "∫"],
        [/vector algebra|3d geometry/, "📦"],
        [/linear programming/, "📉"],
    ];
    for (const [re, emoji] of rules) {
        if (re.test(name)) return emoji;
    }
    const pool = ["📚", "🧩", "✨", "🛰️", "🔬", "🧭"];
    let hash = 0;
    for (const ch of name) hash = ((hash << 5) - hash) + ch.charCodeAt(0);
    return pool[Math.abs(hash) % pool.length];
}

function getQuestionNumber(q, fallback) {
    const n = Number(q?.question_number ?? q?.questionNumber ?? q?.qNum ?? q?.num);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

let allStudents = [], allQuestions = [], pendingReplaceData = null;
let pendingDeleteChapter = null, pendingDeleteLecture = null, pendingDeleteQuestionIndex = undefined, pendingDeleteRowId = null;
let impQImages = [], impAImages = [], impQuestions = [];
let impCurrentSource = 'screenshot'; // 'screenshot' | 'pdf' | 'docx'
let impPdfQFile = null, impPdfAFile = null;
let impDocxQFile = null, impDocxAFile = null;
let impDocPageImages = []; // page screenshots uploaded alongside PDF/DOCX for vision extraction + cropping

/* ── Page screenshot handler (for PDF/DOCX panels) ─── */
async function impHandleDocPageFiles(input) {
    const files = Array.from(input.files || []);
    const src = impCurrentSource || 'pdf';
    const thumbsId = src === 'pdf' ? 'impPdfPageThumbs' : 'impDocxPageThumbs';
    const labelId = src === 'pdf' ? 'impPdfPageLabel' : 'impDocxPageLabel';
    for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        const b64 = await impFileToB64(f);
        impDocPageImages.push(b64);
        impQImages.push(b64); // also feed into the crop modal pool
        const thumbs = document.getElementById(thumbsId);
        if (thumbs) {
            const img = document.createElement('img');
            img.src = `data:${f.type};base64,${b64}`;
            img.style.cssText = 'height:52px;border-radius:4px;border:1px solid var(--border);object-fit:cover';
            thumbs.appendChild(img);
        }
    }
    const label = document.getElementById(labelId);
    if (label) label.innerHTML = `<strong>${impDocPageImages.length} page screenshot(s) loaded</strong><br>Click to add more`;
}
function impHandleDocPageDrop(e) {
    e.preventDefault();
    const src = impCurrentSource || 'pdf';
    const zoneId = src === 'pdf' ? 'impPdfPageZone' : 'impDocxPageZone';
    document.getElementById(zoneId)?.classList.remove('dragover');
    const fakeInput = { files: e.dataTransfer.files };
    impHandleDocPageFiles(fakeInput);
}
let manualQuestionCount = 0;

/* ── Source type switcher ──────────────────────────────────────── */
function impSwitchSource(src) {
    impCurrentSource = src;
    ['screenshot', 'pdf', 'docx'].forEach(s => {
        const tabId = 'impSrcTab' + s.charAt(0).toUpperCase() + s.slice(1);
        const panId = 'impSrcPanel' + s.charAt(0).toUpperCase() + s.slice(1);
        document.getElementById(tabId)?.classList.toggle('active', s === src);
        const pan = document.getElementById(panId);
        if (pan) pan.style.display = s === src ? 'block' : 'none';
    });
    impCheckReady();
}

/* ── PDF file handlers ─────────────────────────────────────────── */
function impHandlePdfDrop(e, type) {
    e.preventDefault();
    const zid = type === 'q' ? 'impPdfQZone' : 'impPdfAZone';
    document.getElementById(zid)?.classList.remove('dragover');
    const f = [...e.dataTransfer.files].find(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    if (f) impSetPdfFile(f, type);
}
function impHandlePdfFile(input, type) {
    const f = input.files[0];
    if (f) impSetPdfFile(f, type);
}
function impSetPdfFile(f, type) {
    const isQ = type === 'q';
    if (isQ) impPdfQFile = f; else impPdfAFile = f;
    const zone = document.getElementById(isQ ? 'impPdfQZone' : 'impPdfAZone');
    const lbl = document.getElementById(isQ ? 'impPdfQLabel' : 'impPdfALabel');
    if (zone) zone.classList.add('has-file');
    if (lbl) lbl.innerHTML = `<strong>✅ ${f.name}</strong><br><span style="font-size:0.72rem;color:var(--success,#4ade80)">${(f.size / 1024).toFixed(0)} KB — click to replace</span>`;
    impCheckReady();
}

/* ── DOCX file handlers ────────────────────────────────────────── */
function impHandleDocxDrop(e, type) {
    e.preventDefault();
    const zid = type === 'q' ? 'impDocxQZone' : 'impDocxAZone';
    document.getElementById(zid)?.classList.remove('dragover');
    const f = [...e.dataTransfer.files].find(f => f.name.endsWith('.docx'));
    if (f) impSetDocxFile(f, type);
}
function impHandleDocxFile(input, type) {
    const f = input.files[0];
    if (f) impSetDocxFile(f, type);
}
function impSetDocxFile(f, type) {
    const isQ = type === 'q';
    if (isQ) impDocxQFile = f; else impDocxAFile = f;
    const zone = document.getElementById(isQ ? 'impDocxQZone' : 'impDocxAZone');
    const lbl = document.getElementById(isQ ? 'impDocxQLabel' : 'impDocxALabel');
    if (zone) zone.classList.add('has-file');
    if (lbl) lbl.innerHTML = `<strong>✅ ${f.name}</strong><br><span style="font-size:0.72rem;color:var(--success,#4ade80)">${(f.size / 1024).toFixed(0)} KB — click to replace</span>`;
    impCheckReady();
}

/* ── Solution upload handlers (Test Paper) ─────────────────────── */
let _impSolSource = 'screenshot';
let _impSolScreenshots = []; // base64 strings
let _impSolPdfFile = null;
let _impSolDocxFile = null;

function impSwitchSolSource(src) {
    _impSolSource = src;
}

// Screenshot solution
function impHandleSolScreenshots(input) {
    const files = [...input.files].filter(f => f.type.startsWith('image/'));
    const grid = document.getElementById('impSolScreenshotPreviews');
    files.forEach(f => {
        const r = new FileReader();
        r.onload = ev => {
            _impSolScreenshots.push(ev.target.result.split(',')[1]);
            const wrap = document.createElement('div');
            wrap.style.cssText = 'position:relative;display:inline-block';
            const img = document.createElement('img');
            img.src = ev.target.result;
            img.style.cssText = 'height:60px;width:auto;border-radius:4px;border:1px solid var(--border);object-fit:cover;cursor:pointer';
            img.title = f.name;
            const removeBtn = document.createElement('button');
            removeBtn.innerHTML = '×';
            removeBtn.style.cssText = 'position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;background:var(--danger,#f87171);color:#fff;border:none;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0';
            removeBtn.onclick = () => {
                const idx = _impSolScreenshots.indexOf(ev.target.result.split(',')[1]);
                if (idx !== -1) _impSolScreenshots.splice(idx, 1);
                wrap.remove();
            };
            wrap.appendChild(img);
            wrap.appendChild(removeBtn);
            if (grid) grid.appendChild(wrap);
        };
        r.readAsDataURL(f);
    });
}

// Paste solution screenshot from clipboard (button click)
async function impPasteSolutionFromClipboard() {
    try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
            const imgType = item.types.find(t => t.startsWith('image/'));
            if (imgType) {
                const blob = await item.getType(imgType);
                const file = new File([blob], 'pasted-solution.png', { type: imgType });
                const dt = new DataTransfer();
                dt.items.add(file);
                const inp = document.getElementById('impSolScreenshotInput');
                if (inp) { inp.files = dt.files; impHandleSolScreenshots(inp); }
                return;
            }
        }
        // Fallback: show a visual hint on the zone
        const zone = document.getElementById('impSolScreenshotZone');
        if (zone) { zone.style.borderColor = 'var(--accent)'; zone.focus(); setTimeout(() => zone.style.borderColor = '', 1500); }
        alert('No image in clipboard. Copy a screenshot first, then click Paste.');
    } catch (e) {
        // Permission denied or no clipboard API — focus zone so Ctrl+V works
        const zone = document.getElementById('impSolScreenshotZone');
        if (zone) { zone.focus(); zone.style.borderColor = 'var(--accent)'; setTimeout(() => zone.style.borderColor = '', 1500); }
    }
}

// Set up paste & drag for solution screenshot zone
(function () {
    function _setupSolZone() {
        const zone = document.getElementById('impSolScreenshotZone');
        if (!zone) return;
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', e => {
            e.preventDefault(); zone.classList.remove('dragover');
            const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
            if (files.length) { const inp = document.getElementById('impSolScreenshotInput'); if (inp) { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); inp.files = dt.files; impHandleSolScreenshots(inp); } }
        });
        zone.addEventListener('click', () => document.getElementById('impSolScreenshotInput')?.click());
        // Paste directly on the zone when focused
        zone.addEventListener('paste', async e => {
            const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
            if (!items) return;
            for (const item of items) {
                if (!item.type.startsWith('image/')) continue;
                e.preventDefault();
                const file = item.getAsFile();
                if (!file) continue;
                const dt = new DataTransfer(); dt.items.add(file);
                const inp = document.getElementById('impSolScreenshotInput');
                if (inp) { inp.files = dt.files; impHandleSolScreenshots(inp); }
                break;
            }
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _setupSolZone);
    else _setupSolZone();
})();

// Get solution payload for saving (called from _origImpSaveAll_inner)
function _getSolutionPayload() {
    if (_impType !== 'test_paper') return null;
    if (_impSolSource === 'screenshot' && _impSolScreenshots.length > 0) {
        return { type: 'screenshot', images: _impSolScreenshots };
    }
    return null;
}

/* Helper: read File as base64 string (no data: prefix) */
function impReadFileAsB64(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(',')[1]);
        r.onerror = rej;
        r.readAsDataURL(file);
    });
}
let mqCurrentChapter = null, mqCurrentLectureIdx = null, mqCurrentTopic = null, mqCurrentLectureNum = null;
let mqPrevView = null; // 'chapter', 'topic', 'lecture'
let selectModeOn = false, selectedLectures = new Set();
let qSelectModeOn = false, selectedQuestions = new Set();
let _chartData = null;
let _pendingConfirmAction = null, _pendingCancelAction = null;
let _hasUnsavedEdits = false;
let _originalEditSnapshot = null;
let mqCurrentSqIdx = -1;          // index in _mqQuestionList of current question
let _mqQuestionList = [];         // [{gi, sqIdx}] — flat ordered list for prev/next nav

function askConfirmModalPromise({ title, text, confirmText }) {
    return new Promise(resolve => {
        document.getElementById("confirmModalTitle").textContent = title || "Confirm";
        document.getElementById("confirmModalText").textContent = text || "Are you sure?";
        document.getElementById("confirmModalOkBtn").textContent = confirmText || "Confirm";

        const cleanup = () => { _pendingConfirmAction = null; _pendingCancelAction = null; };
        _pendingConfirmAction = () => { cleanup(); resolve(true); closeModal('confirmModal'); };
        _pendingCancelAction = () => { cleanup(); resolve(false); closeModal('confirmModal'); };
        openModal('confirmModal');
    });
}

function askPromptModalPromise({ title, text, defaultValue = "" }) {
    return new Promise(resolve => {
        document.getElementById("promptModalTitle").textContent = title || "Enter Value";
        document.getElementById("promptModalText").textContent = text || "Please enter a value:";
        document.getElementById("promptModalInput").value = defaultValue;

        const cleanup = () => {
            _pendingConfirmAction = null;
            _pendingCancelAction = null;
            document.getElementById("promptModalInput").removeEventListener("keydown", handlePromptKeydown);
        };
        const handlePromptKeydown = (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                cleanup();
                resolve(document.getElementById("promptModalInput").value);
                closeModal('promptModal');
            } else if (e.key === "Escape") {
                e.preventDefault();
                cleanup();
                resolve(null);
                closeModal('promptModal');
            }
        };
        _pendingConfirmAction = () => { cleanup(); resolve(document.getElementById("promptModalInput").value); closeModal('promptModal'); };
        _pendingCancelAction = () => { cleanup(); resolve(null); closeModal('promptModal'); };
        openModal('promptModal');
        document.getElementById("promptModalInput").focus();
        document.getElementById("promptModalInput").addEventListener("keydown", handlePromptKeydown);
    });
}
function confirmPromptAction() { if (_pendingConfirmAction) _pendingConfirmAction(); }
function cancelPromptAction() {
    if (_pendingCancelAction) _pendingCancelAction();
    else { closeModal('confirmModal'); closeModal('promptModal'); }
}



(function () {
    const debugInfo = document.getElementById("apiDebugInfo");
    if (debugInfo) {
        debugInfo.textContent = `API: ${API_BASE}`;
    }
})();


/* ══════════════════════════════════════════════════════════════════
   THEME
══════════════════════════════════════════════════════════════════ */
function initTheme() {
    const isInstitute = window.location.pathname.includes("institute.html") || window.location.pathname.includes("institute") || !window.location.pathname.includes("owner");
    const defaultTheme = isInstitute ? 'light' : 'dark';
    const saved = localStorage.getItem('gpTheme') || defaultTheme;
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeUI(saved);
}
function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('gpTheme', next);
    updateThemeUI(next);
    if (_chartData) buildChart(_chartData);
}
function updateThemeUI(t) {
    const icon = document.getElementById('themeIcon');
    const lbl = document.getElementById('themeLabel');
    const iconM = document.getElementById('themeIconMobile');
    const iconD = document.getElementById('drawerThemeIcon');
    const lblD = document.getElementById('drawerThemeLabel');
    const toggleInput = document.getElementById('drawerThemeToggleInput');
    if (icon) icon.textContent = t === 'dark' ? '☀️' : '🌙';
    if (lbl) lbl.textContent = t === 'dark' ? 'Light Mode' : 'Dark Mode';
    if (iconM) iconM.textContent = t === 'dark' ? '☀️' : '🌙';
    if (iconD) iconD.textContent = t === 'dark' ? '☀️' : '🌙';
    if (lblD) lblD.textContent = t === 'dark' ? 'Light Mode' : 'Dark Mode';
    if (toggleInput) toggleInput.checked = (t === 'dark');
    const mc = document.getElementById('themeColorMeta');
    if (mc) mc.setAttribute('content', t === 'dark' ? '#0b0d18' : '#f0f2fc');
}
initTheme();


/* ══════════════════════════════════════════════════════════════════
   MOBILE DRAWER
══════════════════════════════════════════════════════════════════ */
function toggleMobileDrawer() {
    const drawer = document.getElementById('mobileDrawer');
    const overlay = document.getElementById('mobileDrawerOverlay');
    const menuBtn = document.getElementById('mobileMenuBtn');
    if (drawer) drawer.classList.toggle('open');
    if (overlay) overlay.classList.toggle('open');
    if (menuBtn && drawer) {
        if (drawer.classList.contains('open')) {
            menuBtn.classList.add('drawer-open');
        } else {
            menuBtn.classList.remove('drawer-open');
        }
    }
}
function closeMobileDrawer() {
    const drawer = document.getElementById('mobileDrawer');
    const overlay = document.getElementById('mobileDrawerOverlay');
    const menuBtn = document.getElementById('mobileMenuBtn');
    if (drawer) drawer.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
    if (menuBtn) menuBtn.classList.remove('drawer-open');
}
function drawerNav(name) {
    showSection(name);
    document.querySelectorAll('.drawer-card-item[id^="drawer-"], .drawer-item[id^="drawer-"]').forEach(el => el.classList.remove('active'));
    const el = document.getElementById(`drawer-${name}`);
    if (el) el.classList.add('active');
    closeMobileDrawer();
}


/* ══════════════════════════════════════════════════════════════════
   MATH RENDERING
══════════════════════════════════════════════════════════════════ */
/* Convert Unicode math symbols KaTeX can't parse directly (e.g. ≠, ≤, ≥,
   ×, ÷, →, ⇒, …) into their KaTeX command equivalents. Only the content
   INSIDE $...$ / $$...$$ delimiters is rewritten so plain prose is left
   untouched. Used by renderMath so question/option text containing a raw
   "≠" renders correctly without going through clientRepairLatex. */
const _UNICODE_MATH_MAP = {
    '\u2260': '\\neq', '\u2264': '\\leq', '\u2265': '\\geq',
    '\u00d7': '\\times', '\u00f7': '\\div', '\u00b1': '\\pm', '\u2213': '\\mp',
    '\u2192': '\\rightarrow', '\u2190': '\\leftarrow', '\u2194': '\\leftrightarrow',
    '\u21d2': '\\Rightarrow', '\u21d0': '\\Leftarrow', '\u21d4': '\\Leftrightarrow',
    '\u2248': '\\approx', '\u221d': '\\propto', '\u2261': '\\equiv',
    '\u2245': '\\cong', '\u223c': '\\sim', '\u2229': '\\cap', '\u222a': '\\cup',
    '\u2208': '\\in', '\u2209': '\\notin', '\u2282': '\\subset', '\u2283': '\\supset',
    '\u2286': '\\subseteq', '\u2287': '\\supseteq', '\u2205': '\\emptyset',
    '\u221e': '\\infty', '\u2202': '\\partial', '\u2207': '\\nabla',
    '\u2211': '\\sum', '\u220f': '\\prod', '\u222b': '\\int', '\u221a': '\\sqrt',
    '\u22c5': '\\cdot', '\u2026': '\\ldots', '\u2234': '\\therefore', '\u2235': '\\because',
    '\u00b0': '^{\\circ}', '\u00b2': '^{2}', '\u00b3': '^{3}',
    '\u2032': "'", '\u2033': "''"
};
const _UNICODE_MATH_RE = new RegExp('[' + Object.keys(_UNICODE_MATH_MAP).join('') + ']', 'g');
function _replaceUnicodeMathInMath(text) {
    if (!text || (typeof text !== 'string')) return text;
    if (!_UNICODE_MATH_RE.test(text)) return text;
    _UNICODE_MATH_RE.lastIndex = 0;
    // Split on $$...$$ and $...$ segments, rewriting only the math segments.
    const parts = text.split(/(\$\$[\s\S]*?\$\$|\$[^$]*?\$)/g);
    return parts.map((seg, i) => {
        if (i % 2 === 1) {
            // math segment — convert unsupported unicode symbols
            return seg.replace(_UNICODE_MATH_RE, (ch) => ' ' + (_UNICODE_MATH_MAP[ch] || ch) + ' ');
        }
        return seg;
    }).join('');
}
/* Rewrite unicode math symbols in all text nodes of el, in place, BEFORE
   KaTeX auto-render runs over the element. */
function _fixUnicodeMathNodes(el) {
    if (!el || !el.nodeType) return;
    try {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        const toFix = [];
        let n;
        while ((n = walker.nextNode())) {
            if (n.nodeValue && n.nodeValue.indexOf('$') !== -1) toFix.push(n);
        }
        toFix.forEach((node) => {
            const fixed = _replaceUnicodeMathInMath(node.nodeValue);
            if (fixed !== node.nodeValue) node.nodeValue = fixed;
        });
        // Also handle the element's own direct text if it is itself a text-bearing node
        if (el.nodeType === 1 && el.childNodes.length === 0 && el.textContent && el.textContent.indexOf('$') !== -1) {
            const fixed = _replaceUnicodeMathInMath(el.textContent);
            if (fixed !== el.textContent) el.textContent = fixed;
        }
    } catch (e) { /* ignore */ }
}
function renderMath(el) {
    if (!el) return;
    // Normalise unicode math symbols (≠, ≤, ≥, →, …) inside $...$ so KaTeX
    // can render them — must run before auto-render / katex-frag handling.
    _fixUnicodeMathNodes(el);
    // Populate and repair any solution text placeholders inside or on el itself
    if (el.classList && el.classList.contains('imp-sol-text') && el.hasAttribute('data-sol-raw')) {
        const rawText = el.getAttribute('data-sol-raw') || '';
        const repaired = (typeof clientRepairLatex === 'function') ? clientRepairLatex(rawText) : rawText;
        el.textContent = repaired;
        el.removeAttribute('data-sol-raw');
    }
    if (el.querySelectorAll) {
        el.querySelectorAll('.imp-sol-text[data-sol-raw]').forEach(function (subEl) {
            const rawText = subEl.getAttribute('data-sol-raw') || '';
            const repaired = (typeof clientRepairLatex === 'function') ? clientRepairLatex(rawText) : rawText;
            subEl.textContent = repaired;
            subEl.removeAttribute('data-sol-raw');
        });
    }

    // First, process any katex-frag spans created by solTextToRenderedHtml
    if (window.katex && typeof window.katex.renderToString === 'function' && el && el.querySelectorAll) {
        el.querySelectorAll('.katex-frag[data-tex]').forEach((node) => {
            const tex = node.getAttribute('data-tex') || '';
            const displayMode = node.getAttribute('data-display') === '1';
            try {
                node.outerHTML = window.katex.renderToString(tex, {
                    displayMode,
                    throwOnError: false,
                    strict: 'ignore'
                });
            } catch (e) {
                node.textContent = tex;
            }
        });
    }
    // Then, render any remaining $...$ delimiters in text content
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

/**
 * Populate solution text placeholder divs (.imp-sol-text[data-sol-raw])
 * inside the given container. Uses the same proven textContent + renderMath
 * approach as question text and options.
 */
function renderSolTextElements(container) {
    if (!container || !container.querySelectorAll) return;
    container.querySelectorAll('.imp-sol-text[data-sol-raw]').forEach(function (el) {
        const rawText = el.getAttribute('data-sol-raw') || '';
        if (!rawText) return;
        // Apply clientRepairLatex to normalize backslashes, wrap bare LaTeX, etc.
        const repaired = (typeof clientRepairLatex === 'function') ? clientRepairLatex(rawText) : rawText;
        // Set as textContent so $...$ stay as literal text for renderMathInElement
        el.textContent = repaired;
        renderMath(el);
        // Remove the data attribute so it's not processed again
        el.removeAttribute('data-sol-raw');
    });
}

// Ensure math rendering is attempted even if KaTeX's auto-render hasn't loaded yet.
// Retries a few times before giving up so dynamically-inserted solution blocks get typeset.
function ensureRenderMath(el, attempts = 8, delay = 120) {
    if (!el) return;
    if (window.katex && typeof window.katex.renderToString === 'function' && el.querySelectorAll) {
        el.querySelectorAll('.katex-frag[data-tex]').forEach((node) => {
            const tex = node.getAttribute('data-tex') || '';
            const displayMode = node.getAttribute('data-display') === '1';
            try {
                node.outerHTML = window.katex.renderToString(tex, {
                    displayMode,
                    throwOnError: false,
                    strict: 'ignore'
                });
            } catch (e) {
                node.textContent = tex;
            }
        });
    }
    if (window.renderMathInElement) {
        try {
            // Prefer rendering only the solution text nodes if present
            if (el.querySelectorAll) {
                const texts = el.querySelectorAll('.imp-sol-text');
                if (texts && texts.length) {
                    texts.forEach(t => renderMath(t));
                    return;
                }
            }
            renderMath(el);
        } catch (e) {
            // swallow and allow retry below
        }
        return;
    }
    if (attempts <= 0) return;
    setTimeout(() => ensureRenderMath(el, attempts - 1, delay), delay);
}

// Safe base64 → Blob decoder that handles large files correctly
// atob() can silently truncate or corrupt large base64 strings in some browsers
function base64ToBlob(b64, mime) {
    const CHUNK = 8192;
    const raw = atob(b64);
    const len = raw.length;
    const chunks = [];
    for (let i = 0; i < len; i += CHUNK) {
        const slice = raw.slice(i, i + CHUNK);
        const bytes = new Uint8Array(slice.length);
        for (let j = 0; j < slice.length; j++) bytes[j] = slice.charCodeAt(j);
        chunks.push(bytes);
    }
    return new Blob(chunks, { type: mime });
}

function renderFormatLinks(format, files) {
    const linksEl = document.getElementById('fmt-download-links');
    if (!linksEl) return;

    const safeTitle = window._lastPaperGenData.safeTitle;
    const ext = format === 'pdf' ? '.pdf' : '.docx';
    const mime = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const labelPrefix = format === 'pdf' ? '📕' : '📄';

    let downloads = [
        { key: 'questionPaper', label: `${labelPrefix} Question Paper`, filename: `${safeTitle}_Questions${ext}` },
        { key: 'answerKey', label: `🔑 Answer Key`, filename: `${safeTitle}_AnswerKey${ext}` },
        { key: 'solutions', label: `💡 Solutions`, filename: `${safeTitle}_Solutions${ext}` }
    ];

    if (format === 'pdf') {
        downloads = downloads.filter(d => d.key !== 'answerKey');
    }

    let html = `
            <button onclick="downloadAllFiles('${format}')" 
                style="width:100%;padding:10px;background:var(--success);color:#fff;border:none;border-radius:8px;font-size:0.82rem;font-weight:700;cursor:pointer;margin-bottom:12px;transition:opacity 0.15s;display:flex;align-items:center;justify-content:center;gap:6px"
                onmouseover="this.style.opacity='0.88'" onmouseout="this.style.opacity='1'">
                ⚡ Download All (${downloads.length} Files)
            </button>`;

    for (const dl of downloads) {
        const b64 = files[dl.key];
        const blob = base64ToBlob(b64, mime);
        const url = URL.createObjectURL(blob);

        html += `
                <a href="${url}" download="${dl.filename}"
                    style="display:flex;align-items:center;gap:10px;padding:9px 12px;margin-bottom:8px;
                    background:var(--bg-input);border:1.5px solid var(--border);border-radius:8px;
                    color:var(--text);text-decoration:none;font-size:0.82rem;font-weight:600;transition:background 0.12s"
                    onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='var(--bg-input)'">
                    ${dl.label}
                    <span style="margin-left:auto;font-size:0.72rem;color:var(--text-muted)">${dl.filename}</span>
                </a>`;
    }

    linksEl.innerHTML = html;
    linksEl.style.display = 'block';
}

function downloadAllFiles(format) {
    const formatData = format === 'pdf' ? window._lastPaperGenData.pdfFiles : window._lastPaperGenData.files;
    if (!formatData) return;
    const safeTitle = window._lastPaperGenData.safeTitle;
    const ext = format === 'pdf' ? '.pdf' : '.docx';
    const mime = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    let downloads = [
        { key: 'questionPaper', filename: `${safeTitle}_Questions${ext}` },
        { key: 'answerKey', filename: `${safeTitle}_AnswerKey${ext}` },
        { key: 'solutions', filename: `${safeTitle}_Solutions${ext}` }
    ];

    if (format === 'pdf') {
        downloads = downloads.filter(d => d.key !== 'answerKey');
    }

    downloads.forEach((dl, index) => {
        setTimeout(() => {
            const b64 = formatData[dl.key];
            const blob = base64ToBlob(b64, mime);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = dl.filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        }, index * 250); // small delay to prevent browser blocking multiple concurrent downloads
    });
}





/* ── Online Test Details — live preview helpers ── */
function _otFmtDt(val) {
    if (!val) return '';
    const d = new Date(val);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' +
        d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}
function _otUpdateScheduleGap() {
    const lv = document.getElementById('ot-live-at')?.value;
    const ev = document.getElementById('ot-ends-at')?.value;
    const gap = document.getElementById('ot-schedule-gap');
    const lp = document.getElementById('ot-live-preview');
    const ep = document.getElementById('ot-ends-preview');
    if (lp) lp.textContent = _otFmtDt(lv);
    if (ep) ep.textContent = _otFmtDt(ev);
    if (!gap) return;
    if (!lv || !ev) { gap.style.display = 'none'; return; }
    const diff = new Date(ev) - new Date(lv);
    if (diff <= 0) { gap.style.display = 'block'; gap.textContent = '⚠ End time must be after start time'; gap.style.color = 'var(--error)'; return; }
    const days = Math.floor(diff / 86400000);
    const hrs = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    let s = '🗓 Window: ';
    if (days) s += `${days}d `;
    if (hrs) s += `${hrs}h `;
    if (mins) s += `${mins}m`;
    gap.textContent = s.trim() || '< 1 minute';
    gap.style.color = 'var(--accent)';
    gap.style.display = 'block';
}
function otUpdateDurPreview() {
    const v = parseInt(document.getElementById('ot-duration')?.value) || 0;
    const el = document.getElementById('ot-dur-preview');
    if (!el || !v) return;
    const h = Math.floor(v / 60), m = v % 60;
    el.textContent = h ? `${h} hr ${m} min` : `${m} min`;
}
document.addEventListener('change', function (e) {
    if (e.target.id === 'ot-live-at' || e.target.id === 'ot-ends-at') _otUpdateScheduleGap();
    if (e.target.id === 'ot-duration') otUpdateDurPreview();
});
document.addEventListener('input', function (e) {
    if (e.target.id === 'ot-live-at' || e.target.id === 'ot-ends-at') _otUpdateScheduleGap();
    if (e.target.id === 'ot-duration') otUpdateDurPreview();
});

/* ── Strict Mode Toggle ── */
let _otStrictEnabled = false;
function toggleStrictMode() {
    _otStrictEnabled = !_otStrictEnabled;
    _updateStrictLabel();
}
function _updateStrictLabel() {
    const toggle = document.getElementById('ot-strict-toggle');
    const thumb = document.getElementById('ot-strict-thumb');
    const text = document.getElementById('ot-strict-text');
    const label = document.getElementById('ot-strict-label');
    if (!toggle) return;
    if (_otStrictEnabled) {
        toggle.style.background = 'rgba(243,185,111,0.25)';
        toggle.style.borderColor = 'var(--warn)';
        thumb.style.background = 'var(--warn)';
        thumb.style.left = '19px';
        text.textContent = 'Enabled';
        text.style.color = 'var(--warn)';
        label.style.borderColor = 'rgba(243,185,111,0.4)';
        label.style.background = 'rgba(243,185,111,0.05)';
    } else {
        toggle.style.background = 'rgba(255,255,255,0.1)';
        toggle.style.borderColor = 'var(--border)';
        thumb.style.background = 'var(--text-muted)';
        thumb.style.left = '1px';
        text.textContent = 'Disabled';
        text.style.color = 'var(--text-muted)';
        label.style.borderColor = 'var(--border)';
        label.style.background = 'var(--bg)';
    }
}


/* ══════════════════════════════════════════════════════════════════
   MODALS
══════════════════════════════════════════════════════════════════ */
function openModal(id) { document.getElementById(id).style.display = "flex"; }
function closeModal(id) { document.getElementById(id).style.display = "none"; }
window.closeModal = closeModal;
function showSuccessModal(title, text) { document.getElementById("successModalTitle").textContent = title || "Success"; document.getElementById("successModalText").textContent = text || "Done."; openModal("successModal"); }
function showErrorModal(text, title = "Something went wrong") {
    const titleEl = document.getElementById("errorModalTitle");
    const textEl = document.getElementById("errorModalText");
    const modal = document.getElementById("errorModal");
    if (titleEl && textEl && modal) {
        titleEl.textContent = title || "Error";
        textEl.textContent = text || "Something went wrong.";
        openModal("errorModal");
        return;
    }
    alert(`${title || "Error"}: ${text || "Something went wrong."}`);
}

async function extractErrorMessage(res, fallback = "Request failed.") {
    try { const data = await res.json(); return data?.error || data?.message || fallback; } catch { return fallback; }
}

function askConfirmModal({ title = "Please Confirm", text = "Are you sure?", confirmText = "Confirm", onConfirm = null } = {}) {
    document.getElementById("confirmModalTitle").textContent = title;
    document.getElementById("confirmModalText").textContent = text;
    document.getElementById("confirmModalOkBtn").textContent = confirmText;
    _pendingConfirmAction = onConfirm;
    _pendingCancelAction = () => { _pendingConfirmAction = null; closeModal("confirmModal"); };
    openModal("confirmModal");
}
async function confirmConfirmModal() {
    if (typeof _pendingConfirmAction === "function") { const fn = _pendingConfirmAction; _pendingConfirmAction = null; _pendingCancelAction = null; fn(); }
    else if (typeof _pendingConfirmResolver === "function") { _pendingConfirmResolver(true); _pendingConfirmResolver = null; closeModal("confirmModal"); }
    else { closeModal("confirmModal"); }
}
function cancelConfirmModal() {
    if (typeof _pendingCancelAction === "function") { const fn = _pendingCancelAction; _pendingConfirmAction = null; _pendingCancelAction = null; fn(); }
    else if (typeof _pendingConfirmResolver === "function") { _pendingConfirmResolver(false); _pendingConfirmResolver = null; closeModal("confirmModal"); }
    else { _pendingConfirmAction = null; closeModal("confirmModal"); }
}

function showOtSuccessToast(msg) {
    var old = document.getElementById('ot-success-toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'ot-success-toast';
    el.innerHTML = '<div style="display:flex;align-items:center;gap:14px"><div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,rgba(46,210,180,0.2),rgba(46,210,180,0.05));display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0;border:2px solid rgba(46,210,180,0.3)">✅</div><div><div style="font-weight:800;font-size:0.95rem;color:var(--text);margin-bottom:2px">Online Test Created</div><div style="font-size:0.82rem;color:var(--text-muted);font-weight:500">' + msg + '</div></div></div>';
    document.body.appendChild(el);
    // Trigger show after append so the transition plays
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            el.classList.add('show');
        });
    });
    setTimeout(function () {
        el.classList.remove('show');
        el.classList.add('fade-out');
        setTimeout(function () { el.remove(); }, 500);
    }, 4000);
}
window.showOtSuccessToast = showOtSuccessToast;
