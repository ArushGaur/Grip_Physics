/* ══ Bootstrap: declare shared globals FIRST so all subsequent scripts can use them ══ */
const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://' + location.host
    : (location.hostname.endsWith('.github.io') ? 'https://vyorra-krrsh.sevalla.app' : '');
let _token = localStorage.getItem('gp_student_token') || '';
let _student = null;
let _pendingRoll = localStorage.getItem('gp_pending_roll') || '';
// Retained only so older cached code paths don't throw; self-signup is retired.
let _isRequestMode = false;
let _instituteCode = new URLSearchParams(window.location.search).get('institute') || localStorage.getItem('gp_institute_code') || 'DEFAULT';
if (_instituteCode && _instituteCode !== 'DEFAULT') {
    try { localStorage.setItem('gp_institute_code', _instituteCode); } catch (_) { }
}

/* ── Institute Branding Helpers ── */
// Neutral fallback tab icon. NOTE: never fall back to triumph-192.png here —
// that is one specific institute's artwork and made other institutes' portals
// look like Triumph's.
const DEFAULT_BRAND_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230f172a'/%3E%3Cpath d='M36 6 18 38h11l-3 20 19-32H33l3-20z' fill='%2360c8ff'/%3E%3C/svg%3E";

// Branding cache is scoped to the institute code so one institute's logo/name
// can never leak into another institute's portal on the same browser.
const BRAND_CACHE_KEY = 'gp_institute_brand';

function _brandCache() {
    try {
        const d = JSON.parse(localStorage.getItem(BRAND_CACHE_KEY) || 'null');
        if (!d || typeof d !== 'object') return null;
        if (String(d.code || '') !== String(_instituteCode || '')) return null; // different institute
        return d;
    } catch (_) { return null; }
}

function _saveBrandCache(name, logoUrl) {
    try {
        localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify({
            code: String(_instituteCode || ''),
            name: name || '',
            logo: logoUrl || ''
        }));
        if (name) localStorage.setItem('gp_institute_name', name);
        localStorage.setItem('gp_institute_logo', logoUrl || '');
    } catch (_) { }
}

function _clearBrandCache() {
    try {
        localStorage.removeItem(BRAND_CACHE_KEY);
        localStorage.removeItem('gp_institute_name');
        localStorage.removeItem('gp_institute_logo');
    } catch (_) { }
}

function _savedInstituteLogo() {
    const c = _brandCache();
    return (c && c.logo) || '';
}

function _savedInstituteName() {
    const c = _brandCache();
    return (c && c.name) || '';
}

// Swaps the browser tab icon (the "logo in the page title") to the institute's
// own logo. Falls back to the bundled app icon when the institute has none.
function applyInstituteFavicon(logoUrl) {
    const href = logoUrl || DEFAULT_BRAND_ICON;
    [['instituteFavicon', 'icon'], ['instituteAppleIcon', 'apple-touch-icon']].forEach(([id, rel]) => {
        let link = document.getElementById(id);
        if (!link) {
            link = document.createElement('link');
            link.id = id;
            link.rel = rel;
            document.head.appendChild(link);
        }
        link.rel = rel;
        link.href = href;
    });
}

// Replaces every ⚡ brand mark (sidebar, sign-in panel, test top bar) with the
// institute's logo image, and restores the bolt when there is no logo.
function applyInstituteLogoMarks(logoUrl, name) {
    document.querySelectorAll('.sidebar-brand-mark, .auth-left-logo, .auth-mobile-mark, .jee-brand-mark').forEach(el => {
        if (logoUrl) {
            el.classList.add('has-logo');
            const alt = (name || 'Institute') + ' logo';
            el.innerHTML = '<img src="' + logoUrl + '" alt="' + alt.replace(/"/g, '&quot;') + '" onerror="this.parentNode.classList.remove(\'has-logo\');this.parentNode.textContent=\'⚡\'">';
        } else {
            el.classList.remove('has-logo');
            el.textContent = '⚡';
        }
    });
}

function applyInstituteBranding(name, logoUrl) {
    if (logoUrl === undefined || logoUrl === null) logoUrl = _savedInstituteLogo();
    if (!name) name = _savedInstituteName();
    if (name) {
        document.title = `${name} | Student Portal`;
        // Sidebar brand: show the institute's own name instead of "Student Portal"
        const brandNameEl = document.getElementById('sidebarBrandName') || document.querySelector('.sidebar-brand-name');
        if (brandNameEl) brandNameEl.textContent = name;
        const brandSubEl = document.querySelector('.sidebar-brand-sub');
        if (brandSubEl) brandSubEl.textContent = 'Student Portal';
        // Mobile sign-in header (shown where the left brand panel is hidden)
        const mobBrandNameEl = document.getElementById('authMobileBrandName');
        if (mobBrandNameEl) mobBrandNameEl.textContent = name;
        const footerSpanEl = document.getElementById('footerBrandSpan') || document.querySelector('.main-footer span');
        if (footerSpanEl) footerSpanEl.textContent = `${name} Student Portal v2`;
        const jeeTextEl = document.getElementById('jeeTopBarBrandText');
        if (jeeTextEl) jeeTextEl.textContent = name.toUpperCase();
    }
    applyInstituteFavicon(logoUrl);
    applyInstituteLogoMarks(logoUrl, name);
}

// Resolve the branding of the institute this portal actually belongs to, in
// priority order, and apply it to the tab icon, brand marks and brand name.
async function resolveInstituteBranding() {
    // 0) Instant paint from the cache (only if it belongs to this institute).
    const cached = _brandCache();
    if (cached && (cached.name || cached.logo)) applyInstituteBranding(cached.name, cached.logo);

    // 1) Authoritative: the institute the signed-in student actually belongs to.
    if (_token) {
        try {
            const r = await fetch(`${API_BASE}/api/student/me`, {
                headers: { Authorization: `Bearer ${_token}` }, cache: 'no-store'
            });
            if (r.ok) {
                const d = await r.json();
                if (d && (d.instituteName || d.instituteLogo)) {
                    _saveBrandCache(d.instituteName || '', d.instituteLogo || '');
                    applyInstituteBranding(d.instituteName || '', d.instituteLogo || '');
                    if (d.instituteLogo) return;
                }
            }
        } catch (_) { }
    }

    // 2) The institute code carried by the portal link (works before sign-in).
    if (_instituteCode && _instituteCode !== 'DEFAULT') {
        try {
            const r = await fetch(`${API_BASE}/api/institute/info?code=${encodeURIComponent(_instituteCode)}`, { cache: 'no-store' });
            if (r.ok) {
                const d = await r.json();
                if (d && (d.name || d.logoUrl)) {
                    _saveBrandCache(d.name || '', d.logoUrl || '');
                    applyInstituteBranding(d.name || '', d.logoUrl || '');
                    if (d.logoUrl) return;
                }
            }
        } catch (_) { }
    }

    // 3) Embedded inside the institute panel: the session cookie knows the institute.
    try {
        const r = await fetch(`${API_BASE}/api/institute/active`, { credentials: 'include', cache: 'no-store' });
        if (r.ok) {
            const d = await r.json();
            if (d && (d.name || d.logoUrl)) {
                _saveBrandCache(d.name || '', d.logoUrl || '');
                applyInstituteBranding(d.name || '', d.logoUrl || '');
            }
        }
    } catch (_) { /* silent — branding refreshes again after sign-in */ }
}
resolveInstituteBranding();



/* ══ Globals shared across both script blocks ══ */
/* API_BASE, _token, _student are declared in the main block below,
   but JS hoisting means function bodies only read them at call time — fine. */

/* ══════════════════════════════════
   JEE TEST PORTAL ENGINE  —  COMPLETE
══════════════════════════════════ */
let _jeeQuestions = [];
let _jeeCurrentIdx = 0;
let _jeeAnswers = [];       // null=not visited, -1=visited unanswered, >=0=answered, array=multi
let _jeeMarked = [];        // boolean: marked for review
let _jeeTimerSec = 0;
let _jeeTimerInt = null;
let _jeeTestMeta = null;
let _jeeStartTime = 0;
let _jeeElapsedSec = 0;
// Time already burned in earlier sessions of this same attempt (set when a
// teacher-unlocked attempt is resumed). Keeps the total cumulative, so a
// resumed test can never hand back time the student already used.
let _jeePriorElapsedSec = 0;
let _jeeScheme = true;      // true = +4/-1, false = +1/0
let _jeeOnlineScheme = false; // true when online test has custom scheme
// Per-student question shuffle: the server serves an online test's questions in
// a different order to every student. We keep that order (array of the test's
// ORIGINAL question indexes) and send it back on submit, so the analysis screen
// can later line the saved answers up with the questions this student saw.
let _jeeQuestionOrder = [];
let _jeeTestEndsAt = 0; // online_tests.ends_at (ms) — detailed analysis unlocks then
let _jeeOnlineMarksCorrect = 4;
let _jeeOnlineMarksWrong = -1;
let _jeeReviewItems = [];   // cached for filter

/* ══ Live draft autosave ════════════════════════════════════════
   Nothing used to be written anywhere until the test was submitted, so a crash,
   a dead battery or an accidental close mid-test threw away every answer. Now
   each answer, edit, visit, mark and navigation is written to localStorage the
   moment it happens, and the attempt resumes exactly where it left off. */
const JEE_DRAFT_PREFIX = 'gp_test_draft:';
const JEE_DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
let _jeeDraftKey = '';
let _jeeDraftLastWrite = 0;

function _jeeDraftKeyFor(meta, chapter, lecture) {
    const roll = (_student && _student.rollNumber) ? String(_student.rollNumber) : 'anon';
    const testId = (meta && meta.id) ? `ot${meta.id}` : `sq${chapter || ''}|${lecture || ''}`;
    return `${JEE_DRAFT_PREFIX}${roll}:${testId}`;
}

function _saveJeeDraft(force) {
    if (!_jeeDraftKey || !Array.isArray(_jeeQuestions) || !_jeeQuestions.length) return;
    const now = Date.now();
    // Throttle so rapid taps / typing don't hit storage on every keystroke.
    if (!force && now - _jeeDraftLastWrite < 600) return;
    _jeeDraftLastWrite = now;
    try {
        localStorage.setItem(_jeeDraftKey, JSON.stringify({
            v: 1,
            savedAt: now,
            roll: _student ? _student.rollNumber : null,
            total: _jeeQuestions.length,
            answers: _jeeAnswers,
            marked: _jeeMarked,
            currentIdx: _jeeCurrentIdx,
            timerSec: _jeeTimerSec,
            elapsedSec: _jeePriorElapsedSec + Math.floor((now - _jeeStartTime) / 1000),
            meta: _jeeTestMeta
        }));
    } catch (_) { /* quota / private mode - never break a live test over this */ }
}

function _clearJeeDraft() {
    try { if (_jeeDraftKey) localStorage.removeItem(_jeeDraftKey); } catch (_) { }
    _jeeDraftKey = '';
}

function _loadJeeDraft(key, expectedTotal) {
    try {
        const d = JSON.parse(localStorage.getItem(key) || 'null');
        if (!d || d.v !== 1) return null;
        // A draft for a different paper length can't be trusted.
        if (!Array.isArray(d.answers) || Number(d.total) !== Number(expectedTotal)) return null;
        if (Date.now() - (Number(d.savedAt) || 0) > JEE_DRAFT_MAX_AGE_MS) {
            localStorage.removeItem(key);
            return null;
        }
        return d;
    } catch (_) { return null; }
}

// A draft is worthless if it isn't on disk when the tab dies.
window.addEventListener('pagehide', function () { try { _saveJeeDraft(true); } catch (_) { } });
document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { try { _saveJeeDraft(true); } catch (_) { } }
});

/* ── Numerical question detection (no text/images/tables in options) ── */
function _isNumericalQ(q) {
    if (!q) return false;
    var opts = q.options || [];
    var imgs = q.optionImages || [];
    var tbls = _twGetOptionTables(q);
    return opts.every(function (o) { return !o || String(o).trim() === ''; })
        && imgs.every(function (i) { return !i; })
        && tbls.every(function (t) { return !t; });
}

/* ── Marking scheme toggle ── */
function jeeToggleScheme() {
    _jeeScheme = !_jeeScheme;
    const lbl = _jeeScheme ? '+4 / -1' : '+1 / 0';
    const txt = _jeeScheme ? '+4 Correct · −1 Wrong · 0 Skip' : '+1 Correct · 0 Wrong · 0 Skip';
    document.getElementById('jeeSchemeLbl').textContent = lbl;
    document.getElementById('jeeSchemeText').textContent = txt;
}

/* ── Mobile palette toggle ── */
function jeeTogglePalette() {
    const panel = document.getElementById('jeeRightPanel');
    const bd = document.getElementById('jeePaletteBackdrop');
    panel.classList.toggle('open');
    bd.classList.toggle('active');
}

/* ── Open portal ── */
async function openJeePortal(chapter, lecture, meta) {
    const token = _token;
    if (!token) return;

    // Online tests pass questions directly in meta.questions
    // Star-quiz tests fetch from server
    let questions = null;
    let topicStr = '';
    let qData = null;

    if (meta && meta.id && meta._isOnline) {
        // Online test: fetch questions on-demand from dedicated endpoint (fast list + lazy load)
        showStartLoader(meta);
        setStartLoaderProgress(30, 'Loading questions…');
        qData = null; // reset for this attempt
        try {
            const qRes = await fetch(`${API_BASE}/api/student/online-tests/${meta.id}/questions`, {
                headers: { Authorization: `Bearer ${_token}` }
            });
            if (!qRes.ok) {
                const errData = await qRes.json().catch(() => ({}));
                if (qRes.status === 403 && errData.attemptsExhausted) {
                    hideStartLoader(0, 'Blocked');
                    alert('🔒 You have used all available attempts for this test. No more attempts permitted.');
                    return;
                }
                throw new Error(errData.error || 'Failed to load questions');
            }
            qData = await qRes.json();
            questions = qData.questions || [];
            // Order is already applied to `questions` by the server; store it so
            // the submitted attempt records which sequence was shown.
            _jeeQuestionOrder = Array.isArray(qData.questionOrder) ? qData.questionOrder : [];
            _jeeTestEndsAt = Number(qData.endsAt) || 0;
            topicStr = qData.testName || meta.testName || meta.topic || '';
            // Use marks from the fetched data (authoritative)
            // Postgres NUMERIC can arrive as a string ("4", "0"), so coerce
            // instead of testing typeof - and keep a 0 penalty as 0.
            const _mc = Number(qData.marksCorrect);
            if (qData.marksCorrect != null && Number.isFinite(_mc)) {
                _jeeOnlineMarksCorrect = _mc;
                const _mw = Number(qData.marksWrong);
                _jeeOnlineMarksWrong = qData.marksWrong != null && Number.isFinite(_mw) ? _mw : 0;
                _jeeOnlineScheme = true;
            } else {
                _jeeOnlineScheme = false;
            }
        } catch (e) {
            hideStartLoader(0, 'Failed');
            alert('Could not load test questions. Please try again.');
            return;
        }
        // Server-side lock check: if a locked attempt exists, block re-entry
        if (qData && qData.existingAttempt && Number(qData.existingAttempt.isLocked) === 1) {
            hideStartLoader(0, 'Locked');
            alert('🔒 Your test attempt is locked due to tab-switching violations. Please contact your teacher to unlock it.');
            return;
        }
        if (!questions.length) {
            hideStartLoader(0, 'No questions');
            alert('No questions found in this test.');
            return;
        }
        setStartLoaderProgress(100, 'Starting test…');
        await new Promise(r => setTimeout(r, 300));

    } else {
        // Star-quiz test: fetch from server
        _jeeOnlineScheme = false;
        // Self-practice tests are not shuffled and have no shared end time.
        _jeeQuestionOrder = [];
        _jeeTestEndsAt = 0;
        let res;
        try {
            showStartLoader(meta || { chapter, lecture, topic: '' });
            if (Array.isArray(meta?.questions) && meta.questions.length) {
                questions = meta.questions;
                topicStr = meta.topic || meta.testName || '';
            } else {
                res = await fetch(`${API_BASE}/api/star-quiz/question/${encodeURIComponent(chapter)}/${encodeURIComponent(lecture)}`);
                if (!res.ok) throw new Error('Not found');
                const data = await res.json();
                if (!data.questions || !data.questions.length) {
                    hideStartLoader(0, 'No questions');
                    alert('No questions in this test.');
                    return;
                }
                questions = data.questions;
                topicStr = data.topic || '';
            }
        } catch (e) {
            hideStartLoader(0, 'Failed');
            alert('Could not load test. Please try again.');
            return;
        }
        setStartLoaderProgress(100, 'Starting test…');
        await new Promise(resolve => setTimeout(resolve, 320));
    }

    hideStartLoader(100, 'Ready!');

    _jeeQuestions = questions;
    _jeeCurrentIdx = 0;
    _jeeAnswers = new Array(_jeeQuestions.length).fill(null);
    _jeeMarked = new Array(_jeeQuestions.length).fill(false);
    _jeeTestMeta = { chapter: chapter || (meta?.testName || 'Test'), lecture: lecture || '', topic: topicStr, onlineTestId: meta?.id || null };
    // Strict mode
    window._jeeIsStrict = !!(meta?.isStrict);
    window._jeeStrictWarnings = 0;
    window._jeeStrictLocked = false;
    if (window._jeeIsStrict) startStrictMonitor();
    else stopStrictMonitor();
    // Use teacher-set duration for online tests, else 90s/question default
    if (meta && meta.durationMinutes) {
        _jeeTimerSec = meta.durationMinutes * 60;
    } else {
        _jeeTimerSec = _jeeQuestions.length * 90;
    }
    _jeeStartTime = Date.now();
    _jeeElapsedSec = 0;
    _jeePriorElapsedSec = 0;

    // ── Restore progress for teacher-unlocked attempts ──
    let _progressRestored = false;
    if (qData && qData.existingAttempt && Number(qData.existingAttempt.isLocked) === -1) {
        const prev = qData.existingAttempt;
        // Restore answers
        if (Array.isArray(prev.answers)) {
            prev.answers.forEach(item => {
                const idx = Number(item.idx);
                if (!Number.isFinite(idx) || idx < 0 || idx >= _jeeAnswers.length) return;
                const raw = item.studentAnswer;
                if (raw === null || raw === undefined || raw === '') {
                    _jeeAnswers[idx] = null;
                } else if (String(raw).includes(',')) {
                    // Multi-select: "0,2" → [0, 2]
                    _jeeAnswers[idx] = String(raw).split(',').map(Number).filter(n => Number.isFinite(n));
                } else {
                    const n = Number(raw);
                    _jeeAnswers[idx] = Number.isFinite(n) ? n : raw;
                }
            });
        }
        // Restore time — the student only gets the REMAINDER of the original duration.
        // Trust the server's figures first, then fall back to the per-question timings.
        let timeAlreadySpent = Number(prev.elapsedSec);
        if (!Number.isFinite(timeAlreadySpent) || timeAlreadySpent < 0) {
            timeAlreadySpent = Array.isArray(prev.timeSpentJson)
                ? prev.timeSpentJson.reduce((s, t) => s + (Number(t) || 0), 0)
                : 0;
        }
        if (timeAlreadySpent > 0) {
            _jeePriorElapsedSec = timeAlreadySpent;
            _jeeElapsedSec = timeAlreadySpent;
            const serverRemaining = Number(prev.remainingSec);
            _jeeTimerSec = (Number.isFinite(serverRemaining) && serverRemaining > 0)
                ? Math.max(30, serverRemaining)
                : Math.max(30, _jeeTimerSec - timeAlreadySpent);
        }
        _progressRestored = true;
    }

    /* ── Restore an in-progress draft saved on this device ──
       Only used when the server didn't already hand us a resumable attempt;
       the server's copy always wins. */
    _jeeDraftKey = _jeeDraftKeyFor(meta, chapter, lecture);
    if (!_progressRestored) {
        const draft = _loadJeeDraft(_jeeDraftKey, _jeeQuestions.length);
        if (draft) {
            if (Array.isArray(draft.answers)) {
                _jeeAnswers = draft.answers.slice(0, _jeeQuestions.length);
            }
            if (Array.isArray(draft.marked)) {
                _jeeMarked = draft.marked.slice(0, _jeeQuestions.length);
            }
            const di = Number(draft.currentIdx);
            if (Number.isFinite(di) && di >= 0 && di < _jeeQuestions.length) _jeeCurrentIdx = di;
            // Carry the clock over so a resume can't hand out extra time.
            const dt = Number(draft.timerSec);
            if (Number.isFinite(dt) && dt > 0) _jeeTimerSec = dt;
            const de = Number(draft.elapsedSec);
            if (Number.isFinite(de) && de > 0) {
                _jeePriorElapsedSec = de;
                _jeeElapsedSec = de;
            }
            _progressRestored = true;
        }
    }
    _saveJeeDraft(true);

    document.getElementById('jee-portal').style.display = 'flex';
    const infoLabel = meta && meta.id
        ? `${meta.testName || 'Online Test'}`
        : `${chapter} · L${lecture}${topicStr ? ' · ' + topicStr : ''}`;
    document.getElementById('jeeTestInfo').textContent = infoLabel;

    // Resume on the question the student was last looking at.
    jeeRenderQ(_jeeCurrentIdx || 0);
    jeeRenderPalette();
    jeeUpdateLiveTally();
    jeeStartTimer();
    // Block accidental refresh while test is active
    if (typeof enableRefreshBlock === 'function') enableRefreshBlock();

    // Show progress-restored toast after a short delay
    if (_progressRestored) {
        setTimeout(() => {
            const toast = document.createElement('div');
            toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(34,197,94,0.15);border:1.5px solid rgba(34,197,94,0.4);color:#22c55e;font-size:0.85rem;font-weight:600;padding:10px 20px;border-radius:12px;z-index:99999;backdrop-filter:blur(10px);box-shadow:0 4px 20px rgba(0,0,0,0.3);text-align:center;max-width:320px;';
            toast.innerHTML = '✅ Your previous progress has been restored.<br><span style="font-weight:400;font-size:0.78rem;opacity:0.8">Answers & remaining time carried over.</span>';
            document.body.appendChild(toast);
            setTimeout(() => { toast.style.transition = 'opacity 0.5s'; toast.style.opacity = '0'; setTimeout(() => toast.remove(), 500); }, 4000);
        }, 800);
    }
}

/* ── Strict Mode Monitor ── */
let _strictVisHandler = null;
let _strictBlurHandler = null;
let _strictFocusHandler = null;
// Tracks whether the window has focus. Used to distinguish a screen lock
// (page hides WITHOUT a preceding blur → _strictHadFocus stays true → no violation)
// from a tab/app switch (blur fires first → _strictHadFocus becomes false → violation on visibilitychange).
let _strictHadFocus = true;
let _strictBlurFired = false; // set by blur, consumed by visibilitychange to avoid double-counting

function startStrictMonitor() {
    stopStrictMonitor(); // clean up any previous
    _strictHadFocus = document.hasFocus();
    _strictBlurFired = false;

    // visibilitychange: only fire if blur already happened (tab/app switch).
    // Screen lock makes the page hidden WITHOUT a prior blur, so _strictBlurFired stays false → skip.
    _strictVisHandler = function () {
        if (document.hidden && window._jeeIsStrict && !window._jeeStrictLocked) {
            if (_strictBlurFired) {
                // blur already fired → this is a genuine tab/app switch, not a screen lock
                _strictBlurFired = false;
                handleStrictViolation();
            }
            // else: screen turned off / device locked → ignore
        }
    };

    // blur: user switched to another tab or another app window.
    // Mark that blur fired so visibilitychange can confirm it's a real switch.
    // We do NOT call handleStrictViolation here directly to avoid double-counting
    // (blur + visibilitychange would both fire for a tab switch).
    _strictBlurHandler = function () {
        if (window._jeeIsStrict && !window._jeeStrictLocked) {
            _strictHadFocus = false;
            _strictBlurFired = true;
            // Some switches only trigger blur without visibilitychange (e.g. a popup/devtools).
            // Fire the violation after a short delay; cancel if visibilitychange already handled it.
            setTimeout(() => {
                if (_strictBlurFired && window._jeeIsStrict && !window._jeeStrictLocked) {
                    _strictBlurFired = false;
                    handleStrictViolation();
                }
            }, 200);
        }
    };

    _strictFocusHandler = function () {
        _strictHadFocus = true;
        _strictBlurFired = false;
    };

    document.addEventListener('visibilitychange', _strictVisHandler);
    window.addEventListener('blur', _strictBlurHandler);
    window.addEventListener('focus', _strictFocusHandler);
}

function stopStrictMonitor() {
    if (_strictVisHandler) { document.removeEventListener('visibilitychange', _strictVisHandler); _strictVisHandler = null; }
    if (_strictBlurHandler) { window.removeEventListener('blur', _strictBlurHandler); _strictBlurHandler = null; }
    if (_strictFocusHandler) { window.removeEventListener('focus', _strictFocusHandler); _strictFocusHandler = null; }
}

let _strictViolationCooldown = false;
function handleStrictViolation() {
    if (_strictViolationCooldown || window._jeeStrictLocked) return;
    _strictViolationCooldown = true;
    window._jeeStrictWarnings++;

    const overlay = document.getElementById('strict-warning-overlay');
    const icon = document.getElementById('strict-warn-icon');
    const title = document.getElementById('strict-warn-title');
    const body = document.getElementById('strict-warn-body');
    const btn = document.getElementById('strict-warn-btn');

    if (window._jeeStrictWarnings >= 3) {
        // Lock the test
        window._jeeStrictLocked = true;
        stopStrictMonitor();
        icon.textContent = '🔒';
        title.textContent = 'Test Locked!';
        title.style.color = '#ef4444';
        body.innerHTML = 'You have been caught switching tabs or leaving this window <strong>3 times</strong>. Your test has been <strong style="color:#ef4444">locked and auto-submitted</strong> as per the strict test policy.';
        btn.style.display = 'none';
        overlay.style.display = 'flex';
        document.getElementById('strict-warning-overlay').style.borderColor = '#ef4444';
        document.getElementById('strict-warning-box').style.borderColor = '#ef4444';
        document.getElementById('strict-warning-box').style.boxShadow = '0 0 60px rgba(239,68,68,0.35),0 24px 60px rgba(0,0,0,0.8)';
        // Auto-submit after 3 seconds
        setTimeout(() => { jeeDoSubmit(); }, 3000);
    } else {
        // Warning
        const remaining = 3 - window._jeeStrictWarnings;
        icon.textContent = '⚠️';
        title.textContent = `Warning ${window._jeeStrictWarnings} of 2`;
        title.style.color = '#fbbf24';
        body.innerHTML = `You left the test window or switched to another tab.<br><br>
                            <strong style="color:#fbbf24">This is warning ${window._jeeStrictWarnings} of 2.</strong>
                            ${remaining === 1 ? '<br><span style="color:#ef4444;font-weight:700">⚠️ One more violation will permanently lock your test!</span>' : ''}`;
        btn.style.display = 'inline-block';
        btn.textContent = 'I Understand';
        document.getElementById('strict-warning-box').style.borderColor = '#fbbf24';
        document.getElementById('strict-warning-box').style.boxShadow = '0 0 60px rgba(251,191,36,0.3),0 24px 60px rgba(0,0,0,0.8)';
        overlay.style.display = 'flex';
    }
    setTimeout(() => { _strictViolationCooldown = false; }, 2000);
}

function dismissStrictWarning() {
    document.getElementById('strict-warning-overlay').style.display = 'none';
}

/* ── Timer ── */
function jeeStartTimer() {
    clearInterval(_jeeTimerInt);
    jeeUpdateTimer();
    _jeeTimerInt = setInterval(() => {
        _jeeTimerSec--;
        _jeeElapsedSec++;
        if (_jeeTimerSec <= 0) { clearInterval(_jeeTimerInt); jeeDoSubmit(); return; }
        jeeUpdateTimer();
        // Keep the clock fresh in the draft even if the student sits idle.
        if (_jeeElapsedSec % 5 === 0) _saveJeeDraft(true);
    }, 1000);
}

function jeeUpdateTimer() {
    const h = Math.floor(_jeeTimerSec / 3600);
    const m = Math.floor((_jeeTimerSec % 3600) / 60);
    const s = _jeeTimerSec % 60;
    const str = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    const el = document.getElementById('jeeTimer');
    if (el) {
        el.textContent = str;
        el.style.color = _jeeTimerSec < 300 ? '#ef4444' : _jeeTimerSec < 600 ? '#fbbf24' : '#fbbf24';
    }
}

/* ── Render question ── */
function jeeRenderQ(idx) {
    _jeeCurrentIdx = idx;

    const q = _jeeQuestions[idx];
    const isNumerical = _isNumericalQ(q);

    // For numerical, don't auto-set -1; keep null until answered.
    // For regular, keep existing behaviour.
    if (!isNumerical && _jeeAnswers[idx] === null) _jeeAnswers[idx] = -1;

    /* Every visit, answer, clear, mark and navigation lands here, so this one
       call covers the whole "save it the moment it changes" requirement. */
    _saveJeeDraft();

    const ci = q.correctIndexes || [q.correctIndex || 0];
    const ans = _jeeAnswers[idx];
    const isMulti = q.isMultiCorrect || ci.length > 1;
    const markedArr = Array.isArray(ans) ? ans : (ans >= 0 ? [ans] : []);

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const optBg = (sel) => sel
        ? (isLight ? 'rgba(29,111,216,0.14)' : 'rgba(96,200,255,0.1)')
        : (isLight ? 'rgba(30,60,140,0.03)' : 'rgba(255,255,255,0.03)');
    const optBorder = (sel) => sel
        ? (isLight ? '#1d6fd8' : 'rgba(96,200,255,0.6)')
        : (isLight ? 'rgba(30,60,140,0.15)' : 'rgba(255,255,255,0.1)');
    const optColor = (sel) => sel
        ? (isLight ? 'rgba(15,23,41,1)' : 'rgba(241,245,255,1)')
        : (isLight ? 'rgba(15,23,41,0.85)' : 'rgba(241,245,255,0.85)');
    const lblBg = (sel) => sel
        ? (isLight ? '#1d6fd8' : '#60c8ff')
        : (isLight ? 'rgba(30,60,140,0.07)' : 'rgba(255,255,255,0.06)');
    const lblColor = (sel) => sel
        ? (isLight ? '#ffffff' : '#0a0c14')
        : (isLight ? 'rgba(15,23,41,0.5)' : 'rgba(255,255,255,0.5)');
    const qTextColor = isLight ? '#0f1729' : '#f1f5ff';
    const subLblColor = isLight ? 'rgba(15,23,41,0.35)' : 'rgba(255,255,255,0.3)';

    // ── Build input / options area ──
    var answerAreaHtml = '';
    if (isNumerical) {
        var numVal = (ans !== null && ans !== -1) ? String(ans).replace(/,/g, '') : '';
        var numAnswered = numVal !== '';
        answerAreaHtml = `<div style="margin-bottom:16px">
                        <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:1px;color:${subLblColor};margin-bottom:11px;font-weight:700">Enter your answer:</div>
                        <div style="position:relative">
                            <input id="jee-num-input" type="text" inputmode="decimal" value="${escHtml(numVal)}"
                                placeholder="Type your answer…"
                                style="width:100%;background:${isLight ? '#fff' : 'rgba(255,255,255,0.05)'};border:2px solid ${numAnswered ? 'var(--success)' : 'var(--border)'};border-radius:12px;padding:14px 18px;color:${qTextColor};font-size:1.2rem;font-weight:600;outline:none;font-family:'IBM Plex Mono', monospace;text-align:center;transition:border .15s;box-sizing:border-box"
                                onfocus="this.style.borderColor='var(--success)'"
                                onblur="this.style.borderColor=this.value.trim()?'var(--success)':'var(--border)'"
                                oninput="jeeHandleNumInput(this.value)">
                            <div style="margin-top:8px;font-size:0.78rem;color:${subLblColor}">Enter the numeric value (decimals allowed)</div>
                        </div>
                    </div>`;
    } else {
        const LTRS = ['A', 'B', 'C', 'D'];
        const optImgs = Array.isArray(q.optionImages) ? q.optionImages : [];
        const optTables = _twGetOptionTables(q);
        const _optList = (q.options && q.options.length) ? q.options : (optTables.some(Boolean) ? [null, null, null, null] : (q.options || []));
        var optsHtml = _optList.map((opt, oi) => {
            const selected = markedArr.includes(oi);
            const optImg = optImgs[oi] || null;
            const optTbl = optTables[oi] || null;
            const optImgHtml = optImg
                ? `<img src="${optImg.startsWith('http') || optImg.startsWith('data:') ? optImg : 'data:image/' + (typeof getMimeType === 'function' ? getMimeType(optImg) : (optImg.startsWith('iVBORw') ? 'png' : 'jpeg')) + ';base64,' + optImg}" style="display:block;max-width:100%;max-height:120px;object-fit:contain;border-radius:7px;margin-top:2px">`
                : '';
            const optTblHtml = optTbl ? _twRenderSingleTable(optTbl) : '';
            const optBody = optTblHtml || (optImg ? optImgHtml : mdTablesToHtml(opt || ''));
            return `<div onclick="jeeSelectOpt(${oi})" data-oi="${oi}" style="
                        padding:13px 16px;margin-bottom:9px;border-radius:11px;cursor:pointer;
                        border:${selected ? '2px' : '1.5px'} solid ${optBorder(selected)};
                        background:${optBg(selected)};
                        box-shadow:${selected ? (isLight ? '0 4px 14px rgba(29,111,216,0.18)' : '0 4px 14px rgba(96,200,255,0.15)') : 'none'};
                        display:flex;align-items:flex-start;gap:11px;transition:all .15s;
                        color:${optColor(selected)}
                    ">
                        <span style="width:27px;height:27px;border-radius:7px;background:${lblBg(selected)};display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:0.8rem;color:${lblColor(selected)};flex-shrink:0">${LTRS[oi]}</span>
                        <span style="font-size:0.88rem;line-height:1.6;padding-top:3px;flex:1;min-width:0">${optBody}</span>
                    </div>`;
        }).join('');
        answerAreaHtml = `<div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:1px;color:${subLblColor};margin-bottom:11px;font-weight:700">${isMulti ? 'Select ALL correct options:' : 'Select the correct option:'}</div>
                    ${optsHtml}`;
    }

    const qImgs = Array.isArray(q.questionImages) ? q.questionImages.filter(Boolean) : (q.questionImage ? [q.questionImage] : []);
    const imgHtml = qImgs.length
        ? `<div style="margin-bottom:16px;display:flex;flex-direction:column;gap:10px;align-items:center">` +
        qImgs.map(img => {
            const mime = typeof getMimeType === 'function' ? getMimeType(img) : (img.startsWith('iVBORw') ? 'png' : 'jpeg');
            const src = img.startsWith('http') || img.startsWith('data:') ? img : `data:image/${mime};base64,${img}`;
            return `<div style="border-radius:11px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);text-align:center;width:100%"><img src="${src}" style="max-width:100%;max-height:260px;object-fit:contain;display:block;margin:0 auto"></div>`;
        }).join('') +
        `</div>`
        : '';

    // Tables / matrices attached to this question
    const _allTables = _normalizeTablesField(q.tables);
    const _tablesAfterIntro = _allTables.filter(t => (t.position || 'after_intro') !== 'after_options');
    const _tablesAfterOptions = _allTables.filter(t => (t.position || 'after_intro') === 'after_options');
    const tablesIntroHtml = _tablesAfterIntro.length ? renderTablesHtml(_tablesAfterIntro) : '';
    const tablesOptionsHtml = _tablesAfterOptions.length ? renderTablesHtml(_tablesAfterOptions) : '';

    // Marks info badge
    const schemeStr = _jeeOnlineScheme ? `+${_jeeOnlineMarksCorrect} / ${_jeeOnlineMarksWrong}` : (_jeeScheme ? '+4 / -1' : '+1 / 0');
    const marksBadge = `<div style="background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.2);border-radius:8px;padding:4px 10px;font-size:0.72rem;color:#34d399;font-weight:700">${schemeStr}</div>`;

    document.getElementById('jeeQArea').innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap">
                    <div style="background:linear-gradient(135deg,rgba(96,200,255,0.15),rgba(167,139,250,0.15));border:1px solid rgba(96,200,255,0.2);border-radius:9px;padding:5px 13px;font-family:'IBM Plex Mono', monospace;font-size:0.8rem;color:#60c8ff;font-weight:700">Q${idx + 1}</div>
                    ${q.subject ? `<div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.2);border-radius:9px;padding:4px 10px;font-size:0.72rem;color:#fbbf24;font-weight:600">${escHtml(q.subject)}</div>` : ''}
                    ${_jeeMarked[idx] ? '<div style="background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25);border-radius:9px;padding:4px 10px;font-size:0.72rem;color:#a78bfa;font-weight:600">🔖 Marked</div>' : ''}
                    ${isMulti && !isNumerical ? '<div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.2);border-radius:9px;padding:4px 10px;font-size:0.72rem;color:#fbbf24;font-weight:600">Multi-Select</div>' : ''}
                    ${isNumerical ? '<div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.2);border-radius:9px;padding:4px 10px;font-size:0.72rem;color:#fbbf24;font-weight:600">Numerical</div>' : ''}
                    <div style="margin-left:auto">${marksBadge}</div>
                </div>
                <div style="font-size:0.97rem;line-height:1.8;color:${qTextColor};margin-bottom:22px;font-weight:500">${mdTablesToHtml(q.question || '')}</div>
                ${tablesIntroHtml}
                ${imgHtml}
                ${answerAreaHtml}
                ${tablesOptionsHtml}
            `;
    // Render LaTeX in the question area
    if (window.MathJax && window.MathJax.typesetPromise) {
        window.MathJax.typesetPromise([document.getElementById('jeeQArea')]).catch(e => console.warn('MathJax error:', e));
    }

    document.getElementById('jeeQPos').textContent = `Q${idx + 1} of ${_jeeQuestions.length}`;
    document.getElementById('jeePrevBtn').style.opacity = idx === 0 ? '0.4' : '1';
    const nextLabel = idx === _jeeQuestions.length - 1 ? 'Save & Submit →' : 'Save & Next →';
    document.getElementById('jeeNextBtn').textContent = nextLabel;
    const mobileBtn = document.getElementById('jeeNextBtnMobile');
    if (mobileBtn) mobileBtn.textContent = nextLabel;
    const markBtn = document.getElementById('jeeMarkBtn');
    if (markBtn) {
        markBtn.style.background = _jeeMarked[idx] ? 'rgba(167,139,250,0.22)' : 'rgba(167,139,250,0.1)';
        markBtn.style.color = _jeeMarked[idx] ? '#c4b5fd' : '#a78bfa';
    }

    jeeRenderPalette();
    jeeUpdateLiveTally();
}

function jeeHandleNumInput(val) {
    var idx = _jeeCurrentIdx;
    var trimmed = val.replace(/[^0-9.\-]/g, '');
    if (trimmed === '' || trimmed === '-' || trimmed === '.') {
        _jeeAnswers[idx] = null;
    } else {
        _jeeAnswers[idx] = trimmed;
    }
    // Numerical input doesn't re-render the question, so save explicitly.
    _saveJeeDraft();
    jeeRenderPalette();
    jeeUpdateLiveTally();
}

function jeeSelectOpt(oi) {
    const q = _jeeQuestions[_jeeCurrentIdx];
    const ci = q.correctIndexes || [q.correctIndex || 0];
    const isMulti = q.isMultiCorrect || ci.length > 1;
    const cur = _jeeAnswers[_jeeCurrentIdx];
    if (isMulti) {
        let arr = Array.isArray(cur) ? [...cur] : [];
        if (arr.includes(oi)) arr = arr.filter(x => x !== oi);
        else arr.push(oi);
        _jeeAnswers[_jeeCurrentIdx] = arr.length ? arr : -1;
    } else {
        _jeeAnswers[_jeeCurrentIdx] = cur === oi ? -1 : oi;
    }
    jeeRenderQ(_jeeCurrentIdx);
}

function jeeNav(dir) {
    const next = _jeeCurrentIdx + dir;
    if (next < 0 || next >= _jeeQuestions.length) {
        if (dir > 0 && next >= _jeeQuestions.length) { jeeSubmitConfirm(); }
        return;
    }
    jeeRenderQ(next);
}

function jeeMarkForReview() {
    _jeeMarked[_jeeCurrentIdx] = !_jeeMarked[_jeeCurrentIdx];
    jeeRenderQ(_jeeCurrentIdx);
}

function jeeClearResponse() {
    var q = _jeeQuestions[_jeeCurrentIdx];
    if (q && _isNumericalQ(q)) {
        _jeeAnswers[_jeeCurrentIdx] = null;
    } else {
        _jeeAnswers[_jeeCurrentIdx] = -1;
    }
    jeeRenderQ(_jeeCurrentIdx);
}

function jeeRenderPalette() {
    // Also update legacy flat palette (hidden, for compat)
    const pal = document.getElementById('jeeQPalette');
    if (pal) {
        pal.innerHTML = _jeeQuestions.map((q, i) => {
            const ans = _jeeAnswers[i];
            const marked = _jeeMarked[i];
            const isAnswered = Array.isArray(ans) ? ans.length > 0 : ans !== null && ans !== -1;
            const isCurrent = i === _jeeCurrentIdx;
            let bg = '#374151';
            if (marked && isAnswered) bg = '#f59e0b';
            else if (marked) bg = '#3b82f6';
            else if (isAnswered) bg = '#c026d3';
            else if (ans !== null) bg = '#14b8a6';
            return `<div onclick="jeeGoTo(${i})" style="width:100%;aspect-ratio:1;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:700;cursor:pointer;color:#fff;transition:all .15s;outline:${isCurrent ? '2.5px solid #60c8ff' : 'none'};outline-offset:2px;">${i + 1}</div>`;
        }).join('');
    }

    // Build subject-wise sections
    const container = document.getElementById('jeeSubjectSections');
    if (!container) return;

    // Group questions by subject
    const subjectMap = {};
    const subjectOrder = [];
    _jeeQuestions.forEach((q, i) => {
        const subj = (q.subject || 'General').trim();
        if (!subjectMap[subj]) { subjectMap[subj] = []; subjectOrder.push(subj); }
        subjectMap[subj].push(i);
    });

    container.innerHTML = subjectOrder.map(subj => {
        const indices = subjectMap[subj];
        let attempted = 0, marked = 0, attMarked = 0, seen = 0, notSeen = 0;
        indices.forEach(i => {
            const ans = _jeeAnswers[i];
            const isAnswered = Array.isArray(ans) ? ans.length > 0 : (ans !== null && ans !== -1);
            const isMarked = !!_jeeMarked[i];
            const isVisited = ans !== null;
            if (isAnswered && isMarked) attMarked++;
            else if (isMarked) marked++;
            else if (isAnswered) attempted++;
            else if (isVisited) seen++;
            else notSeen++;
        });

        const pills = indices.map(i => {
            const ans = _jeeAnswers[i];
            const isAnswered = Array.isArray(ans) ? ans.length > 0 : (ans !== null && ans !== -1);
            const isMarked = !!_jeeMarked[i];
            const isVisited = ans !== null;
            const isCurrent = i === _jeeCurrentIdx;
            let cls = 'q-not-seen';
            if (isAnswered && isMarked) cls = 'q-att-marked';
            else if (isMarked) cls = 'q-marked';
            else if (isAnswered) cls = 'q-attempted';
            else if (isVisited) cls = 'q-seen';
            const currentCls = isCurrent ? ' q-current' : '';
            return `<div class="jee-q-pill ${cls}${currentCls}" onclick="jeeGoTo(${i})">${i + 1}</div>`;
        }).join('');

        const countBadges = [
            attempted > 0 ? `<span style="color:#c026d3;font-weight:700">${attempted}</span>` : '',
            marked > 0 ? `<span style="color:#3b82f6;font-weight:700">${marked}</span>` : '',
            attMarked > 0 ? `<span style="color:#f59e0b;font-weight:700">${attMarked}</span>` : '',
            seen > 0 ? `<span style="color:#14b8a6">${seen}</span>` : '',
            `<span style="color:#6b7280">${notSeen}</span>`,
        ].filter(Boolean).join(' · ');

        return `<div class="jee-subject-section" id="jee-subj-${CSS.escape(subj)}">
            <div class="jee-subject-header" onclick="jeeToggleSubject('${subj.replace(/'/g, "\\'")}')">
                <span class="jee-subject-name">${escHtml(subj)}</span>
                <span class="jee-subject-counts">${countBadges}</span>
                <span class="jee-subject-chevron">▼</span>
            </div>
            <div class="jee-subject-grid">${pills}</div>
        </div>`;
    }).join('');
}

function jeeToggleSubject(subj) {
    const el = document.getElementById('jee-subj-' + CSS.escape(subj));
    if (el) el.classList.toggle('collapsed');
}

function jeeGoTo(i) {
    // Close mobile palette if open
    document.getElementById('jeeRightPanel').classList.remove('open');
    document.getElementById('jeePaletteBackdrop').classList.remove('active');
    jeeRenderQ(i);
}

function jeeUpdateLiveTally() {
    const ans = document.getElementById('jeeLiveAns');
    const skip = document.getElementById('jeeLiveSkip');
    if (!ans) return;
    const answered = _jeeAnswers.filter(a => Array.isArray(a) ? a.length > 0 : a !== null && a >= 0).length;
    const skipped = _jeeAnswers.filter(a => a === -1).length;
    ans.textContent = answered;
    skip.textContent = _jeeAnswers.length - answered;
    // Live wrong count is unknown without knowing correct answers; keep as —
}

function jeeSubmitConfirm() {
    const answered = _jeeAnswers.filter(a => Array.isArray(a) ? a.length > 0 : a !== null && a >= 0).length;
    const notAns = _jeeAnswers.filter(a => a === -1).length;
    const notVis = _jeeAnswers.filter(a => a === null).length;
    const marked = _jeeMarked.filter(Boolean).length;
    const schemeNote = _jeeScheme ? `Marking: +4 correct, −1 wrong, 0 skipped` : `Marking: +1 correct, 0 wrong/skipped`;
    document.getElementById('jeeSubmitInfo').innerHTML =
        `<strong style="color:#f1f5ff">Answered:</strong> ${answered} &nbsp;
                 <strong style="color:#ef4444">Not Answered:</strong> ${notAns}<br>
                 <strong style="color:rgba(255,255,255,0.5)">Not Visited:</strong> ${notVis} &nbsp;
                 <strong style="color:#8b5cf6">Marked:</strong> ${marked}<br><br>
                 <span style="font-size:0.78rem;color:rgba(255,255,255,0.4)">${schemeNote}</span><br><br>
                 Are you sure you want to submit?`;
    document.getElementById('jeeSubmitDlg').style.display = 'flex';
}

function jeeCloseDlg() {
    document.getElementById('jeeSubmitDlg').style.display = 'none';
}

/* ── Grade helper ── */
function jeeGrade(pct) {
    if (pct >= 90) return { emoji: '🏆', label: 'Excellent!', color: '#22c55e' };
    if (pct >= 75) return { emoji: '⭐', label: 'Great Job!', color: '#34d399' };
    if (pct >= 60) return { emoji: '👍', label: 'Good Work', color: '#60c8ff' };
    if (pct >= 40) return { emoji: '📚', label: 'Keep Practising', color: '#fbbf24' };
    return { emoji: '💪', label: 'Keep Going!', color: '#ef4444' };
}

/* ── Format seconds to Xm Ys ── */
function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/* ── Review filter state ── */
let _resFilter = 'all';
function jeeFilterReview(f) {
    _resFilter = f;
    ['all', 'correct', 'wrong', 'skipped'].forEach(k => {
        const btn = document.getElementById('rf' + k.charAt(0).toUpperCase() + k.slice(1));
        if (btn) btn.style.opacity = k === f ? '1' : '0.5';
    });
    jeeRenderReviewList();
}

function jeeRenderReviewList() {
    const LTRS = ['A', 'B', 'C', 'D'];
    const filtered = _resFilter === 'all' ? _jeeReviewItems : _jeeReviewItems.filter(r => r.status === _resFilter);
    const list = document.getElementById('res-review-list');
    const empty = document.getElementById('res-review-empty');
    if (!filtered.length) {
        list.innerHTML = '';
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';
    list.innerHTML = filtered.map(({ q, ans, status, idx, ci }) => {
        const ansArr = Array.isArray(ans) ? ans : (ans !== null && ans >= 0 ? [ans] : []);
        const statusColor = status === 'correct' ? '#22c55e' : status === 'wrong' ? 'var(--error)' : 'var(--text-faint)';
        const statusIcon = status === 'correct' ? '✓' : status === 'wrong' ? '✗' : '—';
        const marksEarned = _jeeOnlineScheme
            ? (status === 'correct' ? `+${_jeeOnlineMarksCorrect}` : status === 'wrong' ? `${_jeeOnlineMarksWrong}` : '0')
            : (_jeeScheme
                ? (status === 'correct' ? '+4' : status === 'wrong' ? '−1' : '0')
                : (status === 'correct' ? '+1' : '0'));
        const marksColor = status === 'correct' ? '#22c55e' : status === 'wrong' ? '#ef4444' : 'var(--text-faint)';
        let solImgs = [];
        if (Array.isArray(q.solutions) && q.solutions.length) {
            q.solutions.forEach(s => {
                if (s) {
                    if (Array.isArray(s.images)) {
                        solImgs = solImgs.concat(s.images.filter(Boolean));
                    } else if (s.image) {
                        solImgs.push(s.image);
                    }
                }
            });
        } else if (Array.isArray(q.solutionImages)) {
            solImgs = q.solutionImages.filter(Boolean);
        } else if (q.solutionImage) {
            solImgs.push(q.solutionImage);
        }

        const solImgsHtml = solImgs.length
            ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:8px">` +
            solImgs.map(img => {
                const mime = (typeof getMimeType === 'function' ? getMimeType(img) : (img.startsWith('iVBORw') ? 'png' : 'jpeg'));
                const src = img.startsWith('http') || img.startsWith('data:') ? img : `data:image/${mime};base64,${img}`;
                return `<img src="${src}" style="max-width:100%;border-radius:8px;display:block" onerror="this.style.display='none'">`;
            }).join('') + `</div>`
            : '';

        const solnHtml = (q.solution || solImgs.length)
            ? `<div style="margin-top:6px;padding:8px 10px;border-radius:8px;background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.15);font-size:0.75rem;color:var(--text-dim);line-height:1.6">
                                <span style="color:#34d399;font-weight:700">💡 </span>
                                ${mdTablesToHtml(q.solution || '')}
                                ${solImgsHtml}
                               </div>`
            : '';

        // ── Tables / matrices belonging to this question ──
        // 1) Structured tables array (q.tables) rendered as HTML.
        // 2) Markdown pipe-tables embedded inside the question text.
        // When either is present we show the FULL question text (not the
        // 120-char preview) so the table isn't sliced off.
        const qFull = q.question || '';
        const structuredTablesHtml = (Array.isArray(q.tables) && q.tables.length)
            ? renderTablesHtml(q.tables) : '';
        const hasMdTable = qFull.indexOf('|') !== -1 && /\n\s*\|?[\s:-]*-[\s:|-]*\n/.test('\n' + qFull + '\n');
        const showFullQuestion = !!structuredTablesHtml || hasMdTable;
        const qPreview = showFullQuestion
            ? mdTablesToHtml(qFull)
            : (qFull.substring(0, 120) + (qFull.length > 120 ? '…' : ''));
        return `<div style="border-bottom:1px solid var(--border);padding:13px 8px;display:flex;gap:12px;align-items:flex-start">
                    <div style="background:${statusColor};width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:800;color:#fff;flex-shrink:0;margin-top:2px">${statusIcon}</div>
                    <div style="flex:1;min-width:0">
                        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px">
                            <div style="font-size:0.83rem;color:var(--text-mid);font-weight:600;line-height:1.5">Q${idx + 1}: ${qPreview}</div>
                            <span style="font-size:0.78rem;font-weight:800;color:${marksColor};font-family:'IBM Plex Mono', monospace;white-space:nowrap;flex-shrink:0">${marksEarned}</span>
                        </div>
                        ${structuredTablesHtml}
                        <div style="font-size:0.75rem;color:var(--text-faint);display:flex;flex-wrap:wrap;gap:12px">
                            <span>Your answer: <span style="color:${status === 'correct' ? '#22c55e' : status === 'wrong' ? '#ef4444' : 'var(--text-faint)'};font-weight:700">${_isNumericalQ(q) ? (ans !== null && ans !== -1 && String(ans).trim() !== '' ? escHtml(String(ans)) : 'Not attempted') : (ansArr.length ? ansArr.map(a => LTRS[a]).join(', ') : 'Not attempted')}</span></span>
                            <span>Correct: <span style="color:#22c55e;font-weight:700">${_isNumericalQ(q) ? escHtml(String(q.numericalAnswer ?? q.correct_answer ?? 'N/A')) : (q.isNoneCorrect ? 'None is correct' : ci.map(a => LTRS[a]).join(', '))}</span></span>
                        </div>
                        ${solnHtml}
                    </div>
                </div>`;
    }).join('');
    // Render LaTeX in review list
    if (window.MathJax && window.MathJax.typesetPromise) {
        window.MathJax.typesetPromise([list]).catch(e => console.warn('MathJax error:', e));
    }
}

async function jeeDoSubmit() {
    clearInterval(_jeeTimerInt);
    jeeCloseDlg();
    // Cumulative across resumes: earlier sessions + this session.
    _jeeElapsedSec = _jeePriorElapsedSec + Math.floor((Date.now() - _jeeStartTime) / 1000);

    const chapter = _jeeTestMeta.chapter;
    const lecture = _jeeTestMeta.lecture;

    let correct = 0, wrong = 0, skipped = 0;
    let marksScore = 0;
    _jeeReviewItems = [];

    _jeeQuestions.forEach((q, i) => {
        const ans = _jeeAnswers[i];
        const isNoneCorrect = q.isNoneCorrect === true;
        const ci = isNoneCorrect ? [] : (q.correctIndexes || [q.correctIndex || 0]);
        const isNumerical = _isNumericalQ(q);
        const ansArr = Array.isArray(ans) ? ans : (ans !== null && ans >= 0 ? [ans] : []);

        let status = 'skipped';
        if (q.isNoneCorrect === true) {
            status = 'correct';
        } else if (isNumerical) {
            if (ans !== null && ans !== -1 && String(ans).trim() !== '') {
                var numAnswer = parseFloat(String(ans).replace(/,/g, ''));
                var numCorrect = parseFloat(q.numericalAnswer);
                if (!isNaN(numAnswer) && !isNaN(numCorrect)) {
                    status = Math.abs(numAnswer - numCorrect) < 0.001 ? 'correct' : 'wrong';
                } else {
                    status = 'wrong';
                }
            }
        } else if (ansArr.length > 0) {
            const ansSort = [...ansArr].sort().join(',');
            const ciSort = [...ci].sort().join(',');
            status = ansSort === ciSort ? 'correct' : 'wrong';
        }

        if (status === 'correct') { correct++; marksScore += _jeeOnlineScheme ? _jeeOnlineMarksCorrect : (_jeeScheme ? 4 : 1); }
        else if (status === 'wrong') { wrong++; marksScore += _jeeOnlineScheme ? _jeeOnlineMarksWrong : (_jeeScheme ? -1 : 0); }
        else skipped++;

        _jeeReviewItems.push({ q, ans, status, idx: i, ci });
    });

    const total = _jeeQuestions.length;
    const maxMarks = total * (_jeeOnlineScheme ? _jeeOnlineMarksCorrect : (_jeeScheme ? 4 : 1));
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    const grade = jeeGrade(pct);

    /* ══ Persist the attempt BEFORE the result screen appears ═════════════
       The save used to run *after* all the result rendering below, so a student
       who closed the browser the moment the result appeared killed a request
       that was still in flight - and the attempt was lost for good. With a full
       class submitting together the server is slower, which widened that window
       to seconds. Now the row is queued to a local outbox synchronously and
       POSTed (with retries) before anything is revealed. */
    const _attemptSaved = _student
        ? await _persistAttempt({ chapter, lecture, correct, wrong, skipped, total, marksScore, maxMarks, pct, grade })
        : false;
    // The attempt is queued/saved now, so the in-progress draft is obsolete.
    _clearJeeDraft();

    // Hide portal, show result
    // Disable refresh block once test is fully submitted
    if (typeof disableRefreshBlock === 'function') disableRefreshBlock();
    document.getElementById('jee-portal').style.display = 'none';
    document.getElementById('jee-result').style.display = 'block';
    document.getElementById('jee-result').scrollTop = 0;

    // Header
    document.getElementById('resultStudentName').textContent = _student ? (_student.className ? `${_student.name} · ${_student.className}` : _student.name) : '';
    document.getElementById('resultTestMeta').textContent = `${chapter}${_jeeTestMeta.topic ? ' · ' + _jeeTestMeta.topic : ''}`;

    // Grade badge
    document.getElementById('resultGradeBadge').innerHTML = `<span style="color:${grade.color};display:inline-block;max-width:100%;white-space:normal;word-break:break-word;overflow-wrap:anywhere">${grade.emoji} ${grade.label}</span>`;

    // Score — show marks obtained / max marks
    document.getElementById('resultScore').textContent = `${marksScore} / ${maxMarks}`;
    document.getElementById('resultPct').textContent = `${pct}% Accuracy`;
    const schemeLabel = _jeeOnlineScheme ? `+${_jeeOnlineMarksCorrect}/${_jeeOnlineMarksWrong}` : (_jeeScheme ? '+4/−1' : '+1/0');
    document.getElementById('resultMarksScore').textContent = `Questions: ${correct}/${total}  ·  Scheme: ${schemeLabel}`;
    document.getElementById('resultTimeSpent').textContent = `⏱ Time spent: ${fmtTime(_jeeElapsedSec)}`;

    // Stats
    document.getElementById('res-correct').textContent = correct;
    document.getElementById('res-wrong').textContent = wrong;
    document.getElementById('res-skipped').textContent = skipped;
    document.getElementById('res-total').textContent = total;

    // Percentages
    document.getElementById('res-pct-c').textContent = total ? Math.round(correct / total * 100) : 0;
    document.getElementById('res-pct-w').textContent = total ? Math.round(wrong / total * 100) : 0;
    document.getElementById('res-pct-s').textContent = total ? Math.round(skipped / total * 100) : 0;

    // Performance bars
    setTimeout(() => {
        document.getElementById('res-bar-correct').style.width = `${total ? (correct / total * 100) : 0}%`;
        document.getElementById('res-bar-wrong').style.width = `${total ? (wrong / total * 100) : 0}%`;
        document.getElementById('res-bar-skip').style.width = `${total ? (skipped / total * 100) : 0}%`;
    }, 100);

    // Subject-wise breakdown
    const subjects = {};
    _jeeQuestions.forEach((q, i) => {
        const subj = q.subject || 'General';
        if (!subjects[subj]) subjects[subj] = { correct: 0, wrong: 0, skipped: 0, total: 0 };
        subjects[subj].total++;
        subjects[subj][_jeeReviewItems[i].status]++;
    });
    const subjectKeys = Object.keys(subjects);
    if (subjectKeys.length > 1) {
        document.getElementById('res-section-wrap').style.display = 'block';
        const subjectColors = ['#60c8ff', '#a78bfa', '#34d399', '#fbbf24', '#f87171'];
        document.getElementById('res-section-grid').innerHTML = subjectKeys.map((s, si) => {
            const d = subjects[s];
            const spct = d.total ? Math.round(d.correct / d.total * 100) : 0;
            return `<div style="background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:14px;border-left:3px solid ${subjectColors[si % subjectColors.length]}">
                        <div style="font-size:0.82rem;font-weight:700;color:var(--text);margin-bottom:8px">${escHtml(s)}</div>
                        <div style="font-size:1.3rem;font-weight:800;color:${subjectColors[si % subjectColors.length]};font-family:'Inter', sans-serif">${spct}%</div>
                        <div style="font-size:0.72rem;color:var(--text-faint);margin-top:4px">${d.correct}✓  ${d.wrong}✗  ${d.skipped}—</div>
                    </div>`;
        }).join('');
    }


    // NOTE: loadDashboard/loadTests is called AFTER save-test-result below, so the
    // refreshed test list includes this attempt and correctly shows it as completed.
    // Review list
    document.getElementById('res-review-count').textContent = `${total} Questions`;
    _resFilter = 'all';
    ['All', 'Correct', 'Wrong', 'Skipped'].forEach(k => {
        const btn = document.getElementById('rf' + k);
        if (btn) btn.style.opacity = k === 'All' ? '1' : '0.5';
    });
    jeeRenderReviewList();

    // Submit to legacy star-quiz endpoint (NOT for online tests — they use save-test-result only)
    if (_student && _token && !_jeeTestMeta.onlineTestId) {
        try {
            const selectedAnswers = _jeeQuestions.map((q, i) => {
                const a = _jeeAnswers[i];
                return Array.isArray(a) ? a : (a !== null && a >= 0 ? a : null);
            });
            await fetch(`${API_BASE}/api/submit-attempt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mobile: _student.rollNumber,
                    chapter, lecture: lecture || 'online',
                    name: _student.name,
                    className: _student.className,
                    selectedAnswers,
                    askedQuestionIndexes: _jeeQuestions.map((_, i) => i),
                    score: correct,
                    total,
                    marksScore,
                    timeTaken: _jeeElapsedSec
                })
            });
        } catch (e) { console.warn('Submit error:', e); }
    }

    // ── Dashboard stats refresh (the attempt itself was saved further up) ──
    if (_student) {
        try {
            if (_attemptSaved) {
                // refresh dashboard stats from server
                try {
                    const st = await fetch(`${API_BASE}/api/student/stats/${encodeURIComponent(_student.rollNumber)}`);
                    if (st.ok) {
                        const stats = await st.json();
                        const completedEl = document.getElementById('statCompleted');
                        const avgEl = document.getElementById('statAvg');
                        const streakTile = document.querySelectorAll('.stat-tile .stat-num')[3];
                        if (completedEl) completedEl.textContent = stats.tests_completed || 0;
                        if (avgEl) avgEl.textContent = (typeof stats.avg_pct === 'number') ? `${stats.avg_pct}%` : '—';
                        if (streakTile) streakTile.textContent = stats.day_streak || 0;
                    }
                } catch (_) { }
            }
        } catch (e) { console.warn('Database save error:', e); }
    }

    // Refresh dashboard AFTER the result is saved so the test list reflects the new attempt
    if (typeof loadDashboard === 'function') {
        try { loadDashboard(); } catch (_) { }
    }

    // ── Save to local history ──
    const historyKey = 'gp_test_history';
    let history = [];
    try { history = JSON.parse(localStorage.getItem(historyKey) || '[]'); } catch (_) { }
    const attemptRecord = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        student: _student ? { name: _student.name, roll: _student.rollNumber, class: _student.className } : null,
        test: { chapter, lecture, topic: _jeeTestMeta.topic || '' },
        result: { correct, wrong, skipped, total, marksScore, maxMarks, pct, grade: grade.label, timeTaken: _jeeElapsedSec },
        scheme: _jeeOnlineScheme ? `+${_jeeOnlineMarksCorrect}/${_jeeOnlineMarksWrong}` : (_jeeScheme ? '+4/-1' : '+1/0'),
        answers: _jeeQuestions.map((q, i) => ([
            i,
            Array.isArray(_jeeAnswers[i]) ? _jeeAnswers[i].join(',') : (_jeeAnswers[i] === null || _jeeAnswers[i] === undefined ? '' : String(_jeeAnswers[i])),
            (_jeeReviewItems[i]?.status || 'skipped').charAt(0)
        ])),
        // Store questions for analysis view (especially for online/assigned tests)
        questions: _jeeQuestions.map(q => ({
            question: q.question || '',
            options: q.options || [],
            correctIndexes: q.correctIndexes || (typeof q.correctIndex === 'number' ? [q.correctIndex] : [0]),
            solution: q.solution || q.explanation || '',
            ...(Array.isArray(q.tables) && q.tables.length ? { tables: q.tables } : {}),
            questionImage: null // omit large images to keep localStorage small
        }))
    };

    /* ══ Don't cache the paper locally while the test window is still open ══
       The server already withholds the analysis until online_tests.ends_at, so
       keeping the questions + answers in localStorage would be a way around it
       for a student who submits early or gets locked out by strict mode. Store
       the score only; the full analysis is fetched from the server afterwards. */
    const _isOnlineAttempt = !!(_jeeTestMeta && _jeeTestMeta.onlineTestId);
    const _analysisStillLocked = _isOnlineAttempt && (
        window._jeeStrictLocked ? true : (_jeeTestEndsAt ? Date.now() < _jeeTestEndsAt : false)
    );
    // Always stamp the end time, locked or not: if this cached record is opened
    // later, _taAnalysisLock() can re-check the clock on its own.
    if (_isOnlineAttempt) attemptRecord.testEndsAt = _jeeTestEndsAt || null;
    if (_analysisStillLocked) {
        attemptRecord.questions = [];
        attemptRecord.answers = [];
        attemptRecord.analysisAvailable = false;
        attemptRecord.analysisAvailableAt = _jeeTestEndsAt || null;
        attemptRecord.analysisLockedReason = window._jeeStrictLocked ? 'attempt_locked' : 'test_in_progress';
    }

    history.unshift(attemptRecord);
    if (history.length > 50) history = history.slice(0, 50); // keep last 50
    localStorage.setItem(historyKey, JSON.stringify(history));

    // ── Update dashboard stats ──
    await updateDashboardStats();

    // ── Render history panel ──
    await renderResultHistory();
}

function jeeReturnToDashboard() {
    if (typeof disableRefreshBlock === 'function') disableRefreshBlock();
    document.getElementById('jee-result').style.display = 'none';
    showScreen('dashboard');
    loadDashboard();
}

/* ── Update dashboard stats from database ── */
/* ══ Distinct completed tests (added fix) ════════════════════════════════
   Unlocking a strict-mode test lets the student resume and submit again, so one
   test can own several test_history rows. Counting rows made 3 tests read as 7.
   Keep the newest genuinely finished attempt per test instead. */
function _testKeyOf(h) {
    const otId = Number(h && h.online_test_id);
    if (Number.isFinite(otId) && otId > 0) return 'ot_' + otId;
    const t = (h && h.test) || {};
    return 'sq_' + String(t.chapter || '') + '|' + String(t.lecture || '');
}
function uniqueCompletedTests(history) {
    const byTest = new Map();
    (Array.isArray(history) ? history : []).forEach(h => {
        if ((Number(h && h.is_locked) || 0) !== 0) return; // locked / resumable = not completed
        const k = _testKeyOf(h);
        const prev = byTest.get(k);
        if (!prev || Number(h.timestamp) > Number(prev.timestamp)) byTest.set(k, h);
    });
    return [...byTest.values()];
}

async function updateDashboardStats() {
    let history = [];
    if (_student) {
        try {
            const res = await fetch(`${API_BASE}/api/test-history/${_student.rollNumber}`);
            if (res.ok) history = await res.json();
        } catch (e) { console.warn('Failed to fetch stats:', e); }
    }

    // One entry per distinct test, newest finished attempt only.
    const unique = uniqueCompletedTests(history);
    const completed = unique.length;
    const avgScore = completed > 0
        ? Math.round(unique.reduce((sum, h) => sum + ((h.result && h.result.pct) || 0), 0) / completed)
        : null;

    // compute day streak (consecutive days with attempts)
    let streak = 0;
    if (unique.length) {
        const dates = [...new Set(unique.map(h => {
            const d = new Date(h.timestamp);
            return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
        }).filter(Boolean))].sort().reverse();
        if (dates.length) {
            let cur = new Date(dates[0] + 'T00:00:00');
            for (let d of dates) {
                const dt = new Date(d + 'T00:00:00');
                if (Math.abs((cur - dt) / (24 * 3600 * 1000)) <= 0.1) { streak++; cur.setDate(cur.getDate() - 1); }
                else break;
            }
        }
    }

    // Update completed stat tile
    const statTiles = document.querySelectorAll('.stat-tile');
    statTiles.forEach(tile => {
        const lbl = tile.querySelector('.stat-label');
        const num = tile.querySelector('.stat-num');
        if (!lbl || !num) return;
        if (lbl.textContent === 'Completed') num.textContent = completed;
        if (lbl.textContent === 'Avg Score' && avgScore !== null) num.textContent = `${avgScore}%`;
    });

    // Also update via IDs if they exist
    const completedEl = document.getElementById('statCompleted');
    if (completedEl) completedEl.textContent = completed;
    const avgEl = document.getElementById('statAvg');
    if (avgEl && avgScore !== null) avgEl.textContent = `${avgScore}%`;
    const streakTile = document.querySelectorAll('.stat-tile .stat-num')[3];
    if (streakTile) streakTile.textContent = streak;
}

/* ══ Recovery of attempts that never reached the server ══════════════════
   Builds before the crash-safe submit revealed the score before saving it, so
   a result could be missing from the institute's records while this device
   still has the local copy. Detect that and offer a one-tap re-upload. */
let _recoverableAttempts = [];

/* Marks local records as confirmed-present on the server so they are never
   offered for recovery again, on this or any future visit. */
function _markLocalAttemptsSynced(records) {
    try {
        const list = records || [];
        const ids = new Set(list.map(r => r && r.id).filter(v => v !== undefined && v !== null).map(String));
        const stamps = new Set(list.map(r => r && r.timestamp).filter(Boolean).map(String));
        if (!ids.size && !stamps.size) return;
        const all = getTestHistory();
        let changed = false;
        all.forEach(r => {
            if (!r || r.syncedToServer) return;
            const hit = (r.id !== undefined && r.id !== null && ids.has(String(r.id)))
                || (r.timestamp && stamps.has(String(r.timestamp)));
            if (hit) { r.syncedToServer = true; changed = true; }
        });
        if (changed) localStorage.setItem('gp_test_history', JSON.stringify(all));
    } catch (_) { }
}

function _recKeyFor(rec) {
    /* Accepts BOTH shapes: the local localStorage record (onlineTestId) and a
       row from GET /api/test-history, which returns online_test_id in snake
       case. Reading only the camelCase form made every server row collapse to
       the same bogus key, so a saved attempt never matched its server row and
       the card appeared even though the result was safely in the database. */
    const t = (rec && rec.test) || {};
    let ot = null;
    if (rec) {
        if (rec.onlineTestId !== undefined && rec.onlineTestId !== null) ot = rec.onlineTestId;
        else if (rec.online_test_id !== undefined && rec.online_test_id !== null) ot = rec.online_test_id;
    }
    if (ot === null && t.onlineTestId !== undefined && t.onlineTestId !== null) ot = t.onlineTestId;
    if (ot === null && t.online_test_id !== undefined && t.online_test_id !== null) ot = t.online_test_id;
    if (ot !== null && Number(ot) > 0) return `ot:${Number(ot)}`;
    return `sq:${t.chapter || ''}|${t.lecture || ''}`;
}

async function _checkRecoverableAttempts() {
    const card = document.getElementById('recoverCard');
    if (!card || !_student) return;

    let local = [];
    try { local = getTestHistory(); } catch (_) { local = []; }
    // Only this student's own completed attempts are candidates.
    local = local.filter(r => r && r.result && Number(r.result.total) > 0
        && !r.syncedToServer
        && (!r.student || !r.student.roll || String(r.student.roll) === String(_student.rollNumber)));
    if (!local.length) { card.style.display = 'none'; return; }

    let server = null;
    try {
        const resp = await fetch(`${API_BASE}/api/test-history/${encodeURIComponent(_student.rollNumber)}?light=1&limit=50`);
        if (resp.ok) {
            const d = await resp.json();
            server = Array.isArray(d) ? d : (Array.isArray(d && d.history) ? d.history : []);
        }
    } catch (_) { server = null; }

    /* Could not reach the server: stay silent. Treating that as "missing"
       raised a false alarm about results that were in fact already saved. */
    if (!Array.isArray(server)) { card.style.display = 'none'; return; }

    const serverKeys = new Set(server.map(_recKeyFor));
    const serverTimes = server.map(r => Date.parse(r && r.timestamp) || 0).filter(Boolean);

    // On the server = a matching test, or an attempt saved at roughly the same
    // moment (covers practice tests with reused names).
    const isOnServer = (r) => {
        if (serverKeys.has(_recKeyFor(r))) return true;
        const lt = Date.parse(r.timestamp) || 0;
        if (!lt) return false;
        return serverTimes.some(st => Math.abs(st - lt) < 15 * 60 * 1000);
    };

    const present = local.filter(isOnServer);
    const missing = local.filter(r => !isOnServer(r));

    // Remember what is confirmed saved so later visits skip the check entirely.
    if (present.length) _markLocalAttemptsSynced(present);

    _recoverableAttempts = missing;
    if (!missing.length) { card.style.display = 'none'; return; }

    const n = missing.length;
    const label = document.getElementById('recoverText');
    if (label) {
        label.textContent = `${n} completed test${n > 1 ? 's' : ''} on this device ${n > 1 ? 'were' : 'was'} never saved to your institute's records. Upload ${n > 1 ? 'them' : 'it'} so your teacher can see your ${n > 1 ? 'scores' : 'score'}.`;
    }
    card.style.display = 'flex';
}

async function recoverLocalAttempts() {
    const btn = document.getElementById('recoverBtn');
    const label = document.getElementById('recoverText');
    if (!_student || !_recoverableAttempts.length) return;

    if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
    try {
        const resp = await fetch(`${API_BASE}/api/student/recover-attempts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mobile: _student.rollNumber,
                instituteCode: _instituteCode,
                attempts: _recoverableAttempts
            })
        });
        const data = resp.ok ? await resp.json() : null;
        if (data && data.success) {
            const n = Number(data.imported) || 0;
            /* Whether they were imported just now or were already there, these
               records must never prompt again - not clearing them is why the
               card kept coming back on every refresh. */
            _markLocalAttemptsSynced(_recoverableAttempts);
            _recoverableAttempts = [];

            const title = document.getElementById('recoverTitle');
            if (title) title.textContent = n ? 'Results uploaded' : 'Already saved';
            if (label) {
                label.textContent = n
                    ? `${n} result${n > 1 ? 's' : ''} uploaded successfully. Your teacher can see ${n > 1 ? 'them' : 'it'} now.`
                    : 'These results were already in your institute records - nothing needed uploading.';
            }
            if (btn) btn.style.display = 'none';

            const _card = document.getElementById('recoverCard');
            if (_card) {
                _card.style.borderColor = 'rgba(16,185,129,.4)';
                _card.style.background = 'linear-gradient(135deg,rgba(16,185,129,.14),rgba(16,185,129,.05))';
                const _ico = _card.querySelector('span');
                if (_ico) _ico.textContent = '✅';
                setTimeout(() => { _card.style.display = 'none'; }, 6000);
            }
            try { if (typeof loadDashboard === 'function') loadDashboard(); } catch (_) { }
        } else {
            if (label) label.textContent = '⚠️ Upload failed. Check your connection and try again.';
            if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
        }
    } catch (_) {
        if (label) label.textContent = '⚠️ Upload failed. Check your connection and try again.';
        if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
    }
}

function getTestHistory() {
    try { return JSON.parse(localStorage.getItem('gp_test_history') || '[]'); } catch (_) { return []; }
}

async function fetchTestHistoryFromDatabase() {
    if (!_student) return [];
    try {
        const response = await fetch(`${API_BASE}/api/test-history/${_student.rollNumber}`);
        if (!response.ok) return [];
        return await response.json();
    } catch (e) {
        console.warn('Failed to fetch test history from database:', e);
        return [];
    }
}

async function renderResultHistory() {
    const el = document.getElementById('res-history-list');
    if (!el) return;
    let history = [];
    if (_student) {
        try {
            const res = await fetch(`${API_BASE}/api/test-history/${_student.rollNumber}`);
            if (res.ok) history = await res.json();
        } catch (e) { console.warn('Failed to fetch history:', e); }
    }
    if (!history.length) {
        el.innerHTML = '<div style="color:var(--text-faint);font-size:0.82rem;padding:8px 0">No attempts recorded yet.</div>';
        return;
    }
    const gradeColor = (pct) => pct >= 75 ? '#22c55e' : pct >= 50 ? '#fbbf24' : '#ef4444';
    el.innerHTML = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.82rem">
                <thead>
                    <tr style="border-bottom:1px solid var(--border);color:var(--text-faint);text-transform:uppercase;font-size:0.68rem;letter-spacing:0.8px">
                        <th style="padding:8px 12px;text-align:left;font-weight:700">#</th>
                        <th style="padding:8px 12px;text-align:left;font-weight:700">Date & Time</th>
                        <th style="padding:8px 12px;text-align:left;font-weight:700">Test</th>
                        <th style="padding:8px 12px;text-align:center;font-weight:700">Score</th>
                        <th style="padding:8px 12px;text-align:center;font-weight:700">Marks</th>
                        <th style="padding:8px 12px;text-align:center;font-weight:700">Accuracy</th>
                        <th style="padding:8px 12px;text-align:center;font-weight:700">C / W / S</th>
                        <th style="padding:8px 12px;text-align:center;font-weight:700">Time</th>
                        <th style="padding:8px 12px;text-align:center;font-weight:700">Scheme</th>
                    </tr>
                </thead>
                <tbody>
                ${history.map((h, i) => {
        const dt = new Date(h.timestamp);
        const dateStr = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        const r = h.result;
        const gc = gradeColor(r.pct);
        return `<tr style="border-bottom:1px solid var(--border);${i === 0 ? 'background:var(--cyan-dim);' : ''}">
                        <td style="padding:10px 12px;color:var(--text-faint);font-family:'IBM Plex Mono', monospace">${history.length - i}</td>
                        <td style="padding:10px 12px;color:var(--text-mid);white-space:nowrap">
                            <div style="font-weight:600">${dateStr}</div>
                            <div style="font-size:0.72rem;color:var(--text-faint)">${timeStr}</div>
                        </td>
                        <td style="padding:10px 12px;color:var(--text)">
                            <div style="font-weight:600">${escHtml(h.test.chapter)}</div>
                            <div style="font-size:0.72rem;color:var(--text-faint)">${h.test.topic ? escHtml(h.test.topic) : ''}</div>
                        </td>
                        <td style="padding:10px 12px;text-align:center;font-family:'IBM Plex Mono', monospace;font-weight:700;color:var(--text)">${r.correct}/${r.total}</td>
                        <td style="padding:10px 12px;text-align:center;font-family:'IBM Plex Mono', monospace;font-weight:700;color:${gc}">${r.marksScore >= 0 ? '+' : ''}${r.marksScore}</td>
                        <td style="padding:10px 12px;text-align:center">
                            <span style="font-weight:800;font-size:0.9rem;color:${gc}">${r.pct}%</span>
                        </td>
                        <td style="padding:10px 12px;text-align:center;font-size:0.78rem;font-family:'IBM Plex Mono', monospace">
                            <span style="color:#22c55e">${r.correct}</span> / <span style="color:#ef4444">${r.wrong}</span> / <span style="color:var(--text-faint)">${r.skipped}</span>
                        </td>
                        <td style="padding:10px 12px;text-align:center;font-size:0.78rem;color:var(--text-faint)">${fmtTime(r.timeTaken || 0)}</td>
                        <td style="padding:10px 12px;text-align:center;font-size:0.72rem;color:var(--text-faint);font-family:'IBM Plex Mono', monospace">${h.scheme}</td>
                    </tr>`;
    }).join('')}
                </tbody>
            </table></div>`;
}

// Store tests globally so click handlers can safely reference them by index
window._cachedTests = [];
let _pendingStartTest = null;
let _startLoaderTimer = null;
let _startLoaderProgress = 0;

// Override renderTests to open JEE portal on card/button click
window.renderTests = function (tests) {
    window._cachedTests = tests;
    document.getElementById('testsLoading').style.display = 'none';
    document.getElementById('statTests').textContent = tests.length || '0';
    document.getElementById('testPanelBadge').textContent = `${tests.length} Test${tests.length !== 1 ? 's' : ''}`;
    const attemptedCount = tests.filter(t => t.isAttempted).length;
    const nb = document.getElementById('navTestsBadge');
    nb.textContent = attemptedCount;
    nb.style.display = attemptedCount ? '' : 'none';
    const grid = document.getElementById('testGrid');
    if (!tests.length) { document.getElementById('testsEmpty').classList.remove('hidden'); return; }
    grid.style.display = 'flex';
    grid.innerHTML = tests.map((t, i) => {
        const isOnline = !!t._isOnline;
        const isUpcoming = isOnline && !!t.isUpcoming;
        const isAttempted = !!t.isAttempted;
        const attemptsExhausted = isOnline && !!t.attemptsExhausted;
        const hasLockedAttempt = isOnline && !!t.hasLockedAttempt;
        const isBlocked = attemptsExhausted || hasLockedAttempt;
        const attemptsUsed = t.attemptsUsed || 0;
        const maxAttempts = t.maxAttempts || 1;
        let subtitle = '';
        if (isOnline) {
            const _endsD = t.endsAt ? new Date(t.endsAt) : null;
            const endsDate = (_endsD && !isNaN(_endsD.getTime())) ? _endsD.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
            const schemeStr = `+${t.marksCorrect || 4}/${t.marksWrong != null ? t.marksWrong : -1}`;
            if (isUpcoming) {
                const _liveD = t.liveAt ? new Date(t.liveAt) : null;
                const liveTime = (_liveD && !isNaN(_liveD.getTime())) ? _liveD.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
                const liveDate = (_liveD && !isNaN(_liveD.getTime())) ? _liveD.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
                subtitle = `${t.questionCount || 0} Qs  ·  ${schemeStr}  ·  Goes live: ${liveDate} at ${liveTime}`;
            } else {
                subtitle = `${t.questionCount || 0} Qs  ·  ${schemeStr}${endsDate ? '  ·  Ends: ' + endsDate : ''}`;
            }
        } else {
            const _updD = t.updatedAt ? new Date(t.updatedAt) : null;
            const date = (_updD && !isNaN(_updD.getTime())) ? _updD.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
            const qCount = t.questionCount ? `${t.questionCount} Qs` : '';
            const timeLbl = t.questionCount ? `~${Math.ceil(t.questionCount * 1.5)}min` : '';
            subtitle = `${t.topic ? escHtml(t.topic) + '  ·  ' : ''}${qCount ? qCount + '  ·  ' : ''}${timeLbl ? timeLbl + '  ·  ' : ''}${date}`;
        }

        const badgeText = isUpcoming ? '⏰ Upcoming' : (hasLockedAttempt ? '🔒 Locked' : (attemptsExhausted ? '✅ Submitted' : (isAttempted ? `✓ ${attemptsUsed}/${maxAttempts} Done` : isOnline ? '🌐 Live' : 'Open')));
        const badgeClass = isUpcoming ? 'badge-upcoming' : (isBlocked ? 'badge-attempted' : (isAttempted ? 'badge-attempted' : isOnline ? 'badge-open' : 'badge-open'));
        const title = isOnline ? escHtml(t.testName || 'Online Test') : `${escHtml(t.chapter)}${t.topic ? ' — ' + escHtml(t.topic) : ''}`;
        const icon = isUpcoming ? '⏳' : (hasLockedAttempt ? '🔒' : (isAttempted || attemptsExhausted ? '✅' : isOnline ? '🌐' : '📖'));
        const onlineBorder = isUpcoming ? 'border-left:3px solid var(--amber);' : (hasLockedAttempt ? 'border-left:3px solid #ef4444;' : (isAttempted || attemptsExhausted ? 'border-left:3px solid var(--green);' : isOnline ? 'border-left:3px solid var(--cyan);' : ''));
        const strictTag = (t.isStrict && !isAttempted && !isBlocked) ? `<span style="font-size:0.65rem;background:rgba(251,191,36,0.15);border:1px solid rgba(251,191,36,0.35);border-radius:20px;padding:2px 7px;color:var(--amber);font-weight:700;margin-left:4px">🛡 Strict</span>` : '';
        return `<div class="test-card" data-tidx="${i}" style="cursor:${isBlocked ? 'not-allowed' : 'pointer'};animation-delay:${i * 0.05}s;${(isAttempted || isBlocked) ? 'opacity:0.75;' : ''}${onlineBorder}">
                    <span class="test-card-num">${String(i + 1).padStart(2, '0')}</span>
                    <div class="test-card-icon">${icon}</div>
                    <div class="test-card-body">
                        <div class="test-card-title" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${title}${strictTag}</div>
                        <div class="test-card-sub">${subtitle}</div>
                    </div>
                    <span class="badge ${badgeClass}" data-tidx="${i}" style="cursor:pointer">${badgeText}</span>
                </div>`;
    }).join('');
    // Attach event listeners after rendering
    grid.querySelectorAll('[data-tidx]').forEach(el => {
        el.addEventListener('click', function (e) {
            e.stopPropagation();
            const t = window._cachedTests[parseInt(this.dataset.tidx, 10)];
            if (t) openStartTestPopup(t);
        });
    });
};




// API_BASE, _token, _student, _pendingRoll, _isRequestMode
// are declared in the bootstrap script block above — do not redeclare here

/* ══ LOADER ══ */
const statusMsgs = ['Connecting…', 'Authenticating…', 'Loading portal…', 'Almost ready…'];
let sIdx = 0;
const sEl = document.getElementById('loaderStatus');
let sTimer = null;
if (sEl) {
    sTimer = setInterval(() => {
        sEl.textContent = statusMsgs[Math.min(sIdx++, statusMsgs.length - 1)];
        if (sIdx >= statusMsgs.length) { clearInterval(sTimer); sTimer = null; }
    }, 380);
}

// Detect whether this portal is running embedded inside institute.html.
// When embedded we skip the long cosmetic loader animation so the
// student portal opens (almost) instantly.
const _isEmbedded = (window.parent && window.parent !== window);

// Hide loader and boot the app — extracted so both paths call it once
let _bootFired = false;
async function _hideLoaderAndBoot() {
    if (_bootFired) return;
    _bootFired = true;
    if (sTimer) { clearInterval(sTimer); sTimer = null; }
    if (sEl) sEl.textContent = 'Ready ✓';
    await new Promise(r => setTimeout(r, _isEmbedded ? 0 : 180));
    const l = document.getElementById('loader');
    if (l) { l.style.opacity = '0'; setTimeout(() => l.style.display = 'none', _isEmbedded ? 200 : 600); }
    await bootApp();
}

// Boot as soon as the DOM is interactive instead of waiting for the full
// `window load` event (which is delayed by the async MathJax/CDN scripts).
// MathJax is only needed lazily when questions are rendered, so there is
// no reason to block the whole portal on it.
const _bootDelay = _isEmbedded ? 0 : 250; // tiny delay keeps the standalone loader visible briefly
function _scheduleBoot() { setTimeout(_hideLoaderAndBoot, _bootDelay); }
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    _scheduleBoot();
} else {
    document.addEventListener('DOMContentLoaded', _scheduleBoot, { once: true });
}

// Safety net: also fire on full load, and a hard fallback in case
// DOMContentLoaded already passed before this script ran.
window.addEventListener('load', () => _hideLoaderAndBoot());
// Fallback: if nothing else fires (CDN hang), force-boot.
setTimeout(_hideLoaderAndBoot, _isEmbedded ? 1500 : 3000);

async function bootApp() {
    if (_token) {
        try {
            const r = await fetch(`${API_BASE}/api/student/me`, { headers: { Authorization: `Bearer ${_token}` } });
            if (r.ok) { _student = await r.json(); showScreen('dashboard'); loadDashboard(); return; }
        } catch (_) { }
        _token = ''; localStorage.removeItem('gp_student_token');
    }
    // Self-signup and teacher approval no longer exist: a student either has a
    // registered email (and gets a code) or they don't. Clear any leftover state
    // from the old flow so an upgraded browser doesn't get stuck.
    if (_pendingRoll) {
        _pendingRoll = '';
        localStorage.removeItem('gp_pending_roll');
    }
    showScreen('login');
}

// ── History / back-button support ──────────────────────────────────────
// Push a state entry every time we navigate so the browser back button
// navigates within the SPA instead of leaving it.
let _historyNavBlocked = false;

let _attCalendarMonth = new Date().getMonth();
let _attCalendarYear = new Date().getFullYear();
let _attRecords = [];

function navAttendance() {
    if (!_student) return;
    showScreen('attendance');
    setActiveNav('attendance');
    _attCalendarMonth = new Date().getMonth();
    _attCalendarYear = new Date().getFullYear();
    attRenderCalendar();
}

function showScreen(name, pushHistory = true) {
    ['login', 'profile', 'dashboard', 'attendance', 'test-analysis', 'test-summary', 'test-detail', 'edit', 'pending'].forEach(s => {
        const el = document.getElementById(`screen-${s}`);
        if (el) el.classList.add('hidden');
    });
    const el = document.getElementById(`screen-${name}`);
    if (!el) return;
    el.classList.remove('hidden');
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';

    // update topbar title + sidebar state
    const titles = { login: 'Sign In', profile: 'Create Profile', dashboard: 'Dashboard', attendance: 'Attendance', 'test-analysis': 'Test Analysis', 'test-summary': 'Test Analysis', 'test-detail': 'Test Details', edit: 'Profile', pending: 'Request Sent' };
    document.getElementById('topbarTitle').textContent = titles[name] || 'Portal';

    const isLoggedIn = (name === 'dashboard' || name === 'attendance' || name === 'test-analysis' || name === 'test-summary' || name === 'test-detail' || name === 'edit');
    document.getElementById('sidebarUser').classList.toggle('visible', isLoggedIn);
    document.getElementById('navEdit').style.display = isLoggedIn ? '' : 'none';
    document.getElementById('logoutSidebarBtn').style.display = isLoggedIn ? '' : 'none';

    // On auth screens (login / profile / pending) there is no menu to open,
    // so hide the topbar menu bar entirely on mobile. The <body> class is
    // used by CSS to drop the hamburger button (and topbar) on small screens.
    document.body.classList.toggle('auth-mode', !isLoggedIn);
    // Make sure the drawer can never be left open when entering an auth screen.
    if (!isLoggedIn) closeSidebar();

    // Disable Android pull-to-refresh on all logged-in screens (scrollable content).
    // Re-enable only on login/profile/pending where there is nothing to scroll.
    if (window.Android) {
        if (isLoggedIn) {
            if (typeof window.Android.disablePullToRefresh === 'function') window.Android.disablePullToRefresh();
        } else {
            if (typeof window.Android.enablePullToRefresh === 'function') window.Android.enablePullToRefresh();
        }
    }

    closeSidebar();

    // Surface any locally-stranded results as soon as the dashboard is shown.
    if (name === 'dashboard') {
        try { _checkRecoverableAttempts(); } catch (_) { }
    }

    // Push state so back button works within SPA
    if (pushHistory && !_historyNavBlocked) {
        const state = { screen: name };
        if (name === 'login' || name === 'pending' || name === 'profile') {
            history.replaceState(state, '', window.location.pathname);
        } else {
            history.pushState(state, '', window.location.pathname);
        }
    }
}

// Handle browser back / forward
window.addEventListener('popstate', function (e) {
    const state = e.state;
    _historyNavBlocked = true;
    if (!state || !state.screen) {
        if (_student) { showScreen('dashboard', false); loadDashboard(); }
        else { showScreen('login', false); }
        _historyNavBlocked = false;
        return;
    }
    const screen = state.screen;
    if (screen === 'dashboard' && _student) {
        showScreen('dashboard', false); loadDashboard();
    } else if (screen === 'test-analysis' && _student) {
        showScreen('test-analysis', false);
        document.getElementById('topbarTitle').textContent = 'Test Analysis';
        setActiveNav('tests');
        if (window._testAnalysisData && window._testAnalysisData.length) {
            _taRenderExisting();
        } else {
            showTestAnalysisList(false);
        }
    } else if (screen === 'test-summary' && _student) {
        if (window._tdCurrentTestIdx != null && window._testAnalysisData) {
            openTestDetail(window._tdCurrentTestIdx, false);
        } else {
            showTestAnalysisList(false);
        }
    } else if (screen === 'edit' && _student) {
        showEditProfile();
    } else if (screen === 'login') {
        showScreen('login', false);
    } else {
        if (_student) { showScreen('dashboard', false); loadDashboard(); }
        else { showScreen('login', false); }
    }
    _historyNavBlocked = false;
});

// ── Refresh Guard — active test portal only ─────────────────────────
let _blockRefresh = false;
let _refreshLeaveCallback = null; // called if user chooses "Leave anyway"

function enableRefreshBlock() {
    _blockRefresh = true;
    document.documentElement.classList.add('refresh-blocked');
    // Tell Android WebView to disable SwipeRefreshLayout during a test
    if (window.Android && typeof window.Android.disablePullToRefresh === 'function') {
        window.Android.disablePullToRefresh();
    }
}

function disableRefreshBlock() {
    _blockRefresh = false;
    document.documentElement.classList.remove('refresh-blocked');
    // Re-enable Android SwipeRefreshLayout once test is over
    if (window.Android && typeof window.Android.enablePullToRefresh === 'function') {
        window.Android.enablePullToRefresh();
    }
}

// ── Desktop: block F5 / Ctrl+R / Cmd+R ───────────────────────────────
document.addEventListener('keydown', function (e) {
    if (!_blockRefresh) return;
    const isRefreshKey = e.key === 'F5' ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r');
    if (isRefreshKey) {
        e.preventDefault();
        e.stopPropagation();
        _showRefreshWarningPopup();
        return false;
    }
}, true);

// ── Desktop: beforeunload — replaced by custom popup where possible ───
// beforeunload fires AFTER our keydown handler swallows F5/Ctrl+R,
// so it only fires for true tab closes / address-bar navigations.
window.addEventListener('beforeunload', function (e) {
    if (!_blockRefresh) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
});

// ── Mobile: pull-to-refresh intercept ────────────────────────────────
let _mobileRefreshTouchStartY = 0;
let _mobileRefreshTouchStartX = 0;
let _mobileRefreshPopupShown = false; // prevent re-triggering within same swipe gesture

document.addEventListener('touchstart', function (e) {
    if (!_blockRefresh) return;
    if (e.touches.length === 1) {
        _mobileRefreshTouchStartY = e.touches[0].clientY;
        _mobileRefreshTouchStartX = e.touches[0].clientX;
        _mobileRefreshPopupShown = false; // reset per gesture
    }
}, { passive: true });

document.addEventListener('touchmove', function (e) {
    if (!_blockRefresh) return;
    if (e.touches.length !== 1) return;
    if (_mobileRefreshPopupShown) return; // already warned this gesture
    const dy = e.touches[0].clientY - _mobileRefreshTouchStartY;
    const dx = e.touches[0].clientX - _mobileRefreshTouchStartX;
    const portalEl = document.getElementById('jee-portal');
    const scrollTop = portalEl ? portalEl.scrollTop : window.scrollY;
    // Require a deliberate 60 px downward pull (was 10 px) before warning,
    // and only when already at the very top of the scroll container.
    if (dy > 250 && Math.abs(dy) > Math.abs(dx) * 1.5 && scrollTop <= 0) {
        e.preventDefault();
        _mobileRefreshPopupShown = true;
        _showRefreshWarningPopup();
    }
}, { passive: false });

// ── pagehide fallback (iOS Safari) ��─���─────────────────────────────────
window.addEventListener('pagehide', function () {
    if (_blockRefresh) {
        try { sessionStorage.setItem('_gpRefreshInterrupted', '1'); } catch (_) { }
    }
});
try { sessionStorage.removeItem('_gpRefreshInterrupted'); } catch (_) { }

// ── Custom refresh warning popup ──────────────────────────────────────
/* ══ Crash-safe result submission ═════════════════════════════════
   An attempt is written to a localStorage outbox *synchronously* before any
   network call, then POSTed with keepalive + retries. If the browser dies
   mid-flight the attempt is still queued and gets flushed on the next visit or
   via sendBeacon on the way out. The client attempt id makes those replays
   impossible to duplicate server-side. */
const RESULT_OUTBOX_KEY = 'gp_result_outbox';

function _newAttemptId() {
    try {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (_) { }
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function _readResultOutbox() {
    try {
        const v = JSON.parse(localStorage.getItem(RESULT_OUTBOX_KEY) || '[]');
        return Array.isArray(v) ? v : [];
    } catch (_) { return []; }
}

function _writeResultOutbox(list) {
    // Cap the queue so a long-running device can never blow the storage quota.
    try { localStorage.setItem(RESULT_OUTBOX_KEY, JSON.stringify(list.slice(-20))); } catch (_) { }
}

function _queueResult(payload) {
    const list = _readResultOutbox().filter(p => p && p.clientAttemptId !== payload.clientAttemptId);
    list.push(payload);
    _writeResultOutbox(list);
}

function _unqueueResult(id) {
    _writeResultOutbox(_readResultOutbox().filter(p => p && p.clientAttemptId !== id));
}

/* keepalive lets the request outlive the page that started it, which is exactly
   the case we are protecting against. */
async function _postResult(payload) {
    const resp = await fetch(`${API_BASE}/api/save-test-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
    });
    return !!(resp && resp.ok);
}

/* A whole class submitting at once can make the server slow enough for the
   first POST to time out, so transient failures are retried with backoff. */
async function _postResultWithRetry(payload, attempts) {
    const tries = attempts || 4;
    for (let i = 0; i < tries; i++) {
        try {
            if (await _postResult(payload)) return true;
        } catch (_) { }
        if (i < tries - 1) {
            await new Promise(r => setTimeout(r, 600 * Math.pow(2, i) + Math.random() * 400));
        }
    }
    return false;
}

function _buildResultPayload(v) {
    const compactAnswers = _jeeQuestions.map((q, i) => {
        const studentAnswer = _jeeAnswers[i];
        return [
            i,
            Array.isArray(studentAnswer) ? studentAnswer.join(',') : (studentAnswer === null || studentAnswer === undefined ? '' : String(studentAnswer)),
            (_jeeReviewItems[i]?.status || 'skipped').charAt(0)
        ];
    });
    return {
        clientAttemptId: _newAttemptId(),
        mobile: _student.rollNumber,
        chapter: v.chapter,
        lecture: v.lecture || _jeeTestMeta.onlineTestId || 'online',
        topic: _jeeTestMeta.topic || '',
        correct: v.correct,
        wrong: v.wrong,
        skipped: v.skipped,
        total: v.total,
        marksScore: v.marksScore,
        maxMarks: v.maxMarks,
        pct: v.pct,
        grade: v.grade && v.grade.label ? v.grade.label : '',
        timeTaken: _jeeElapsedSec,
        scheme: _jeeOnlineScheme ? `+${_jeeOnlineMarksCorrect}/${_jeeOnlineMarksWrong}` : (_jeeScheme ? '+4/-1' : '+1/0'),
        studentName: _student.name,
        studentClass: _student.className,
        answers: compactAnswers,
        online_test_id: _jeeTestMeta.onlineTestId || null,
        is_locked: window._jeeStrictLocked ? 1 : 0,
        // Store total elapsed seconds so unlock can restore remaining time
        timeSpentJson: [_jeeElapsedSec],
        // The shuffled order this student was served (empty for practice tests)
        questionOrder: Array.isArray(_jeeQuestionOrder) ? _jeeQuestionOrder : []
    };
}

async function _persistAttempt(v) {
    let payload;
    try { payload = _buildResultPayload(v); }
    catch (e) { console.warn('Result payload build failed:', e); return false; }

    _queueResult(payload);  // synchronous - survives an immediate browser close
    let ok = false;
    try { ok = await _postResultWithRetry(payload); } catch (_) { ok = false; }
    if (ok) _unqueueResult(payload.clientAttemptId);
    return ok;
}

/* Anything still queued (browser closed mid-save, offline, server down) is
   re-sent when the portal is opened again. */
async function flushResultOutbox() {
    const list = _readResultOutbox();
    if (!list.length) return;
    for (const payload of list) {
        if (!payload || !payload.mobile) { _unqueueResult(payload && payload.clientAttemptId); continue; }
        try {
            if (await _postResultWithRetry(payload, 2)) _unqueueResult(payload.clientAttemptId);
        } catch (_) { }
    }
}

/* Last-ditch delivery as the page goes away: sendBeacon is the only request
   type the browser guarantees to finish after unload. */
window.addEventListener('pagehide', function () {
    const list = _readResultOutbox();
    if (!list.length || !navigator.sendBeacon) return;
    for (const payload of list) {
        try {
            const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
            navigator.sendBeacon(`${API_BASE}/api/save-test-result`, blob);
        } catch (_) { }
    }
});

document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { try { flushResultOutbox(); } catch (_) { } }
});

try { setTimeout(function () { try { flushResultOutbox(); } catch (_) { } }, 2500); } catch (_) { }

function _showRefreshWarningPopup() {
    const popup = document.getElementById('refreshWarningPopup');
    if (popup) {
        popup.classList.add('active');
        // Animate in
        const box = popup.querySelector('.rwp-box');
        if (box) { box.style.transform = 'scale(0.92)'; box.style.opacity = '0'; requestAnimationFrame(() => { box.style.transition = 'transform 0.22s cubic-bezier(.34,1.56,.64,1), opacity 0.18s ease'; box.style.transform = 'scale(1)'; box.style.opacity = '1'; }); }
    }
}

function _hideRefreshWarningPopup() {
    const popup = document.getElementById('refreshWarningPopup');
    if (popup) popup.classList.remove('active');
}

function _refreshWarningStay() {
    _hideRefreshWarningPopup();
}

function _refreshWarningLeave() {
    _hideRefreshWarningPopup();
    disableRefreshBlock();
    // Small delay so CSS transition finishes, then actually reload
    setTimeout(() => { window.location.reload(); }, 120);
}

/* ══ SIDEBAR MOBILE ══ */
function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    const bd = document.getElementById('sidebarBackdrop');
    sb.classList.toggle('open');
    bd.classList.toggle('active');
}
function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarBackdrop').classList.remove('active');
}

/* ══ THEME ══ */
function toggleTheme() {
    const html = document.documentElement;
    const isLight = html.getAttribute('data-theme') === 'light';
    html.setAttribute('data-theme', isLight ? 'dark' : 'light');
    const icon = isLight ? '🌙' : '☀️';
    document.getElementById('themeBtn').textContent = icon + ' Toggle Theme';
    document.getElementById('topbarThemeBtn').textContent = icon;
    localStorage.setItem('gp-theme', isLight ? 'dark' : 'light');
}
(function () {
    // Default to dark mode; only go light if user explicitly chose light
    const t = localStorage.getItem('gp-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', t);
    const icon = t === 'light' ? '☀️' : '🌙';
    const b = document.getElementById('themeBtn');
    if (b) b.textContent = icon + ' Toggle Theme';
    const tb = document.getElementById('topbarThemeBtn');
    if (tb) tb.textContent = icon;
})();

function attCalendarPrevMonth() {
    _attCalendarMonth--;
    if (_attCalendarMonth < 0) { _attCalendarMonth = 11; _attCalendarYear--; }
    attRenderCalendar();
}
function attCalendarNextMonth() {
    _attCalendarMonth++;
    if (_attCalendarMonth > 11) { _attCalendarMonth = 0; _attCalendarYear++; }
    attRenderCalendar();
}

async function attRenderCalendar() {
    const grid = document.getElementById('attCalendarGrid');
    const label = document.getElementById('attCalendarLabel');
    const loading = document.getElementById('attCalendarLoading');
    const empty = document.getElementById('attCalendarEmpty');
    if (!grid || !label) return;

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    label.textContent = `${monthNames[_attCalendarMonth]} ${_attCalendarYear}`;

    loading.style.display = 'block';
    grid.innerHTML = '';
    empty.style.display = 'none';

    const roll = _student?.rollNumber;
    if (!roll) { loading.style.display = 'none'; return; }

    try {
        const r = await fetch(`${API_BASE}/api/admin/attendance/student/${encodeURIComponent(roll)}?month=${_attCalendarMonth + 1}&year=${_attCalendarYear}`);
        if (!r.ok) { loading.style.display = 'none'; return; }
        _attRecords = await r.json();
    } catch (_) { _attRecords = []; }
    loading.style.display = 'none';

    // Build status map: { "2026-01-15": "present", ... }
    const statusMap = {};
    _attRecords.forEach(rec => { statusMap[rec.date] = rec.status; });

    // Count summary
    let counts = { present: 0, absent: 0 };
    _attRecords.forEach(rec => { if (counts[rec.status] !== undefined) counts[rec.status]++; });
    document.getElementById('attSumPresent').textContent = counts.present;
    document.getElementById('attSumAbsent').textContent = counts.absent;

    // Build calendar days
    const year = _attCalendarYear;
    const month = _attCalendarMonth;
    const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let html = '<div class="att-cal-row att-cal-header">' + dayNames.map(d => `<div class="att-cal-cell att-cal-day-name">${d}</div>`).join('') + '</div>';

    let dayCells = '';
    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
        dayCells += '<div class="att-cal-cell att-cal-empty"></div>';
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const status = statusMap[dateStr] || '';
        const isToday = dateStr === todayStr ? ' att-cal-today' : '';
        let statusClass = '';
        let statusIcon = '';
        if (status === 'present') { statusClass = ' att-cal-present'; statusIcon = '✅'; }
        else if (status === 'absent') { statusClass = ' att-cal-absent'; statusIcon = '❌'; }
        dayCells += `<div class="att-cal-cell${statusClass}${isToday}">
                    <span class="att-cal-day-num">${d}</span>
                    ${statusIcon ? `<span class="att-cal-status-icon">${statusIcon}</span>` : ''}
                </div>`;
    }
    html += '<div class="att-cal-row">' + dayCells + '</div>';

    grid.innerHTML = html;

    // Check if any records
    if (!_attRecords.length) {
        empty.style.display = 'block';
    } else {
        empty.style.display = 'none';
    }
}

function navDash() { if (_student) { showScreen('dashboard'); loadDashboard(); setActiveNav('dashboard'); } }

function setActiveNav(key) {
    // keys: 'dashboard', 'tests', 'attendance', 'edit'
    document.querySelectorAll('.sidebar-nav-item').forEach(el => el.classList.remove('active'));
    if (key === 'dashboard') document.querySelector('.sidebar-nav-item')?.classList.add('active');
    if (key === 'tests') document.getElementById('navTests')?.classList.add('active');
    if (key === 'attendance') document.getElementById('navAttendance')?.classList.add('active');
    if (key === 'edit') document.getElementById('navEdit')?.classList.add('active');
}

/* ══ LOGOUT POPUP ══ */
function openLogoutPopup() { document.getElementById('logoutPopup').classList.add('active'); }
function closeLogoutPopup() { document.getElementById('logoutPopup').classList.remove('active'); }
document.getElementById('logoutPopup').addEventListener('click', function (e) { if (e.target === this) closeLogoutPopup(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLogoutPopup(); });

function formatDuration(sec) {
    const total = Math.max(0, Number(sec) || 0);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function setStartLoaderProgress(pct, statusText) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct || 0)));
    const fill = document.getElementById('startTestLoaderFill');
    const status = document.getElementById('startTestLoaderStatus');
    const pctEl = document.getElementById('startTestLoaderPct');
    if (fill) fill.style.width = `${clamped}%`;
    if (statusText && status) status.textContent = statusText;
    if (pctEl) pctEl.textContent = `${clamped}%`;
}

function openStartTestPopup(test) {
    // Block upcoming tests — show a "not live yet" popup instead
    if (test._isOnline && test.isUpcoming) {
        const liveAt = test.liveAt ? new Date(test.liveAt) : null;
        const liveValid = liveAt && !isNaN(liveAt.getTime());
        const liveTimeStr = liveValid ? liveAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
        const liveDateStr = liveValid ? liveAt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
        const title = document.getElementById('startTestPopupTitle');
        const body = document.getElementById('startTestPopupBody');
        const marks = document.getElementById('startTestMaxMarks');
        const time = document.getElementById('startTestMaxTime');
        const questions = document.getElementById('startTestQuestions');
        const scheme = document.getElementById('startTestScheme');
        if (title) title.textContent = test.testName || 'Upcoming Test';
        if (body) body.textContent = `This test is not live yet. It will be available on ${liveDateStr} at ${liveTimeStr}.`;
        if (marks) marks.textContent = test.questionCount ? `${test.questionCount * (test.marksCorrect || 4)}` : '—';
        const upcomingDurMin = test.durationMinutes || (test.questionCount ? Math.ceil(test.questionCount * 1.5) : 90);
        if (time) time.textContent = formatDuration(upcomingDurMin * 60);
        if (questions) questions.textContent = test.questionCount ? `${test.questionCount}` : '—';
        if (scheme) scheme.textContent = `+${test.marksCorrect || 4} / ${test.marksWrong != null ? test.marksWrong : -1}`;
        // Swap the "Start Test" button to disabled state
        const startBtn = document.querySelector('#startTestPopup .btn-danger-solid');
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.textContent = '⏰ Not Live Yet';
            startBtn.style.opacity = '0.5';
            startBtn.style.cursor = 'not-allowed';
        }
        document.getElementById('startTestPopup').classList.add('active');
        return;
    }
    // Re-enable the button in case it was disabled from a previous upcoming test click
    const startBtn = document.querySelector('#startTestPopup .btn-danger-solid');
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Start Test'; startBtn.style.opacity = ''; startBtn.style.cursor = ''; }

    // Locked takes priority — show locked message even if attempts are exhausted
    if (test._isOnline && test.hasLockedAttempt) {
        const title = document.getElementById('startTestPopupTitle');
        const body = document.getElementById('startTestPopupBody');
        const marks = document.getElementById('startTestMaxMarks');
        const time = document.getElementById('startTestMaxTime');
        const questions = document.getElementById('startTestQuestions');
        const scheme = document.getElementById('startTestScheme');
        if (title) title.textContent = test.testName || 'Online Test';
        if (body) body.innerHTML = `<div style="background:rgba(239,68,68,0.10);border:1.5px solid rgba(239,68,68,0.35);border-radius:10px;padding:10px 14px;margin-top:4px;font-size:0.85rem;color:#ef4444;font-weight:600">🔒 Your test attempt has been <strong>locked</strong> due to tab-switching violations.<br><span style="font-weight:400;color:rgba(239,68,68,0.8)">Please contact your teacher to unlock it.</span></div>`;
        if (marks) marks.textContent = test.questionCount ? `${test.questionCount * (test.marksCorrect || 4)}` : '—';
        const durMin = test.durationMinutes || (test.questionCount ? Math.ceil(test.questionCount * 1.5) : 90);
        if (time) time.textContent = formatDuration(durMin * 60);
        if (questions) questions.textContent = test.questionCount ? `${test.questionCount}` : '—';
        if (scheme) scheme.textContent = `+${test.marksCorrect || 4} / ${test.marksWrong != null ? test.marksWrong : -1}`;
        const lockedBtn = document.querySelector('#startTestPopup .btn-danger-solid');
        if (lockedBtn) {
            lockedBtn.disabled = true;
            lockedBtn.textContent = '🔒 Attempt Locked';
            lockedBtn.style.opacity = '0.5';
            lockedBtn.style.cursor = 'not-allowed';
        }
        document.getElementById('startTestPopup').classList.add('active');
        return;
    }

    // Block tests where max attempts have been exhausted
    if (test._isOnline && test.attemptsExhausted) {
        const title = document.getElementById('startTestPopupTitle');
        const body = document.getElementById('startTestPopupBody');
        const marks = document.getElementById('startTestMaxMarks');
        const time = document.getElementById('startTestMaxTime');
        const questions = document.getElementById('startTestQuestions');
        const scheme = document.getElementById('startTestScheme');
        if (title) title.textContent = test.testName || 'Online Test';
        if (body) body.innerHTML = `<div style="background:rgba(239,68,68,0.10);border:1.5px solid rgba(239,68,68,0.35);border-radius:10px;padding:10px 14px;margin-top:4px;font-size:0.85rem;color:#ef4444;font-weight:600">🔒 You have used all <strong>${test.maxAttempts}</strong> attempt${test.maxAttempts !== 1 ? 's' : ''} allowed for this test.<br><span style="font-weight:400;color:rgba(239,68,68,0.8)">No more attempts are permitted.</span></div>`;
        if (marks) marks.textContent = test.questionCount ? `${test.questionCount * (test.marksCorrect || 4)}` : '—';
        const durMin = test.durationMinutes || (test.questionCount ? Math.ceil(test.questionCount * 1.5) : 90);
        if (time) time.textContent = formatDuration(durMin * 60);
        if (questions) questions.textContent = test.questionCount ? `${test.questionCount}` : '—';
        if (scheme) scheme.textContent = `+${test.marksCorrect || 4} / ${test.marksWrong != null ? test.marksWrong : -1}`;
        const exhaustedBtn = document.querySelector('#startTestPopup .btn-danger-solid');
        if (exhaustedBtn) {
            exhaustedBtn.disabled = true;
            exhaustedBtn.textContent = '🔒 No Attempts Left';
            exhaustedBtn.style.opacity = '0.5';
            exhaustedBtn.style.cursor = 'not-allowed';
        }
        document.getElementById('startTestPopup').classList.add('active');
        return;
    }

    _pendingStartTest = test;
    const title = document.getElementById('startTestPopupTitle');
    const body = document.getElementById('startTestPopupBody');
    const marks = document.getElementById('startTestMaxMarks');
    const time = document.getElementById('startTestMaxTime');
    const questions = document.getElementById('startTestQuestions');
    const scheme = document.getElementById('startTestScheme');
    if (test._isOnline) {
        if (title) title.textContent = test.testName || 'Online Test';
        const strictNote = test.isStrict
            ? `<div style="background:rgba(251,191,36,0.12);border:1.5px solid rgba(251,191,36,0.35);border-radius:10px;padding:10px 14px;margin-top:8px;font-size:0.82rem;color:#fbbf24;font-weight:600">
                        🛡️ <strong>STRICT TEST MODE ENABLED</strong><br>
                        <span style="font-weight:400;color:rgba(251,191,36,0.8)">Tab switching or opening other apps is monitored. You will get 2 warnings before your test is locked.</span>
                       </div>`
            : '';
        if (body) body.innerHTML = 'Read all instructions and start when ready.' + strictNote;
        if (marks) marks.textContent = test.questionCount ? `${test.questionCount * (test.marksCorrect || 4)}` : '—';
        const durMin = test.durationMinutes || (test.questionCount ? test.questionCount * 1.5 : 90);
        if (time) time.textContent = formatDuration(Math.round(durMin) * 60);
        if (questions) questions.textContent = test.questionCount ? `${test.questionCount}` : '—';
        if (scheme) scheme.textContent = `+${test.marksCorrect || 4} / ${test.marksWrong != null ? test.marksWrong : -1}`;
    } else {
        if (title) title.textContent = `${test.chapter || 'Test'}`;
        if (body) body.textContent = test.topic ? test.topic : 'Review the test details and start when ready.';
        if (marks) marks.textContent = test.maxMarks ? `${test.maxMarks}` : '—';
        if (time) time.textContent = test.maxTimeSec ? formatDuration(test.maxTimeSec) : '—';
        if (questions) questions.textContent = test.questionCount ? `${test.questionCount}` : '—';
        if (scheme) scheme.textContent = '+4 / -1';
    }
    document.getElementById('startTestPopup').classList.add('active');
}

function closeStartTestPopup() {
    document.getElementById('startTestPopup').classList.remove('active');
}

document.getElementById('startTestPopup').addEventListener('click', function (e) {
    if (e.target === this) closeStartTestPopup();
});

async function confirmStartSelectedTest() {
    const test = _pendingStartTest;
    if (!test) return;
    // Safety guard: block if attempts exhausted or if student has a locked attempt
    if (test._isOnline && (test.attemptsExhausted || test.hasLockedAttempt)) return;
    closeStartTestPopup();
    if (test._isOnline) {
        // Online test: pass the test object directly (has .questions array)
        await openJeePortal(null, null, test);
    } else {
        await openJeePortal(test.chapter, test.lecture, test);
    }
}

function showStartLoader(test, statusText = 'Loading question set…') {
    const overlay = document.getElementById('startTestLoader');
    if (!overlay) return;
    overlay.classList.add('active');
    setStartLoaderProgress(8, statusText);
    const body = document.getElementById('startTestLoaderBody');
    if (body && test) {
        body.textContent = `${test.chapter || 'Test'}${test.topic ? ' · ' + test.topic : ''}`;
    }
    if (_startLoaderTimer) clearInterval(_startLoaderTimer);
    _startLoaderProgress = 8;
    _startLoaderTimer = setInterval(() => {
        _startLoaderProgress = Math.min(92, _startLoaderProgress + (Math.random() * 7 + 3));
        setStartLoaderProgress(_startLoaderProgress, 'Loading question set…');
    }, 160);
}

function hideStartLoader(finalPct = 100, doneText = 'Ready!') {
    if (_startLoaderTimer) { clearInterval(_startLoaderTimer); _startLoaderTimer = null; }
    setStartLoaderProgress(finalPct, doneText);
    const overlay = document.getElementById('startTestLoader');
    if (overlay) overlay.classList.remove('active');
}

/* ══ AUTH — EMAIL + ONE-TIME CODE ══

   Two steps, one screen:
     1. requestLoginOtp()  — student types their registered email, we email a code
     2. verifyLoginOtp()   — correct code → token → dashboard

   There is deliberately no profile step. Names, classes, sections and mobile
   numbers are entered by the institute when the student is added, so once the
   code checks out the student goes straight to their dashboard.
*/
let _loginEmail = '';
let _resendCooldown = 0;
let _resendTimer = null;

function _emailLooksValid(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

function _startResendCooldown(seconds = 30) {
    const btn = document.getElementById('resendOtpBtn');
    if (!btn) return;
    _resendCooldown = seconds;
    if (_resendTimer) clearInterval(_resendTimer);
    const tick = () => {
        if (_resendCooldown <= 0) {
            clearInterval(_resendTimer); _resendTimer = null;
            btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Resend code';
            return;
        }
        btn.disabled = true; btn.style.opacity = '.55';
        btn.textContent = `Resend in ${_resendCooldown}s`;
        _resendCooldown--;
    };
    tick();
    _resendTimer = setInterval(tick, 1000);
}

/* Step 1 — ask the server to email a code. */
async function requestLoginOtp(email, btnId) {
    email = (email || _loginEmail || '').trim().toLowerCase();
    const inputId = (_authMode === 'signup' && !_resetMode) ? 'signupEmailInput' : 'loginEmailInput';
    const btn = document.getElementById(btnId || (_authMode === 'signup' ? 'signupBtn' : 'loginSubmitBtn'));
    const btnLabel = btn ? btn.textContent : '';

    const msg = document.getElementById('loginMsg');
    if (msg) { msg.className = 'msg'; msg.style.display = 'none'; }

    if (!email) { showMsg('loginMsg', 'err', 'Please enter your email address.'); shake(inputId); return; }
    if (!_emailLooksValid(email)) { showMsg('loginMsg', 'err', 'That doesn\'t look like a valid email address.'); shake(inputId); return; }

    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Sending code…'; }
    try {
        const r = await fetch(`${API_BASE}/api/student/request-otp`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, instituteCode: _instituteCode })
        });
        const data = await r.json();

        if (!r.ok) {
            showMsg('loginMsg', 'err', data.error || 'Could not send the code. Please try again.');
            shake(inputId);
            return;
        }

        _loginEmail = email;
        const sentTo = document.getElementById('otpSentTo');
        if (sentTo) sentTo.textContent = data.maskedEmail || email;
        _showLoginStep('otp');

        if (data.devCode) {
            // The server has no email provider configured, so it handed the code
            // back instead of pretending it was delivered.
            const otp = document.getElementById('otpInput');
            if (otp) otp.value = data.devCode;
            showMsg('loginMsg', 'err',
                'Email is not set up on the server yet, so nothing was sent. Your code is ' +
                data.devCode + ' (already filled in). Ask your admin to set RESEND_API_KEY.');
        } else {
            showMsg('loginMsg', 'ok', 'Code sent! Check your inbox (and spam folder).');
        }
        _startResendCooldown(30);
        setTimeout(() => document.getElementById('otpInput')?.focus(), 80);
    } catch (e) {
        showMsg('loginMsg', 'err', 'Connection error. Please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
    }
}

/* ══ PASSWORD FLOW ══
   First visit  : email ��� code → create a password → dashboard
   Later visits : email → password → dashboard
   Forgot it    : email → "Forgot password?" → code → new password        */

let _resetMode = false;   // true while the code is being used to reset a password
let _loginHasPw = false;
let _authMode = 'login';  // 'login' = returning student, 'signup' = first-time student

function _showLoginStep(step) {
    const map = { login: 'loginStep', signup: 'signupStep', otp: 'otpStep', setpw: 'setPwStep' };
    Object.keys(map).forEach(k => {
        const el = document.getElementById(map[k]);
        if (el) el.style.display = (k === step) ? 'block' : 'none';
    });
    // The Log In / Sign Up switch only belongs on the two entry forms.
    const tabs = document.getElementById('authTabs');
    if (tabs) tabs.style.display = (step === 'login' || step === 'signup') ? 'flex' : 'none';
}

/* Swap between the Log In and Sign Up forms. */
function setAuthMode(mode, opts) {
    _authMode = (mode === 'signup') ? 'signup' : 'login';
    _resetMode = false;
    if (_resendTimer) { clearInterval(_resendTimer); _resendTimer = null; }
    _resendCooldown = 0;

    const tabL = document.getElementById('tabLogin');
    const tabS = document.getElementById('tabSignup');
    if (tabL) tabL.classList.toggle('active', _authMode === 'login');
    if (tabS) tabS.classList.toggle('active', _authMode === 'signup');

    const eyebrow = document.getElementById('authEyebrow');
    const heading = document.getElementById('authHeading');
    const sub = document.getElementById('authSub');
    if (_authMode === 'login') {
        if (eyebrow) eyebrow.textContent = '🔐 Sign In';
        if (heading) heading.textContent = 'Welcome back';
        if (sub) sub.textContent = 'Enter your email and the password you created.';
    } else {
        if (eyebrow) eyebrow.textContent = '✨ New Student';
        if (heading) heading.textContent = 'Create your account';
        if (sub) sub.textContent = 'Enter your registered email — we\'ll email you a code, then you pick a password.';
    }

    // Carry a typed email across the switch so nobody has to retype it.
    const le = document.getElementById('loginEmailInput');
    const se = document.getElementById('signupEmailInput');
    const carry = (opts && opts.email) || _loginEmail ||
        (_authMode === 'login' ? (se ? se.value : '') : (le ? le.value : ''));
    if (carry) { if (le) le.value = carry; if (se) se.value = carry; }

    const pw = document.getElementById('loginPwInput');
    if (pw) pw.value = '';
    const otp = document.getElementById('otpInput');
    if (otp) otp.value = '';

    if (!(opts && opts.keepMsg)) {
        const msg = document.getElementById('loginMsg');
        if (msg) { msg.className = 'msg'; msg.style.display = 'none'; }
    }

    _showLoginStep(_authMode);
    setTimeout(() => {
        const focusId = _authMode === 'login'
            ? (carry ? 'loginPwInput' : 'loginEmailInput')
            : 'signupEmailInput';
        document.getElementById(focusId)?.focus();
    }, 60);
}

function toggleLoginPwVisible(on) {
    const el = document.getElementById('loginPwInput');
    if (el) el.type = on ? 'text' : 'password';
}

function toggleNewPwVisible(on) {
    ['newPwInput', 'newPw2Input'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.type = on ? 'text' : 'password';
    });
}

/* LOG IN — returning student signs in with email + password. */
async function doLogin() {
    const email = (document.getElementById('loginEmailInput')?.value || '').trim().toLowerCase();
    const pw = document.getElementById('loginPwInput')?.value || '';
    const btn = document.getElementById('loginSubmitBtn');
    const msg = document.getElementById('loginMsg');
    if (msg) { msg.className = 'msg'; msg.style.display = 'none'; }

    if (!email) { showMsg('loginMsg', 'err', 'Please enter your email address.'); shake('loginEmailInput'); return; }
    if (!_emailLooksValid(email)) { showMsg('loginMsg', 'err', 'That doesn\'t look like a valid email address.'); shake('loginEmailInput'); return; }
    if (!pw) { showMsg('loginMsg', 'err', 'Please enter your password.'); shake('loginPwInput'); return; }

    _loginEmail = email;
    _resetMode = false;

    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Signing in…'; }
    try {
        const r = await fetch(`${API_BASE}/api/student/login-password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: pw, instituteCode: _instituteCode })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            // Registered, but has never picked a password — walk them through Sign Up instead.
            if (data.needsPassword) {
                setAuthMode('signup', { email, keepMsg: true });
                showMsg('loginMsg', 'err', 'You haven\'t created a password yet — sending you a code so you can set one.');
                await requestLoginOtp(email, 'signupBtn');
                return;
            }
            showMsg('loginMsg', 'err', data.error || 'That email or password is incorrect.');
            shake('loginPwInput');
            return;
        }
        _token = data.token;
        _student = data.student;
        localStorage.setItem('gp_student_token', _token);
        showScreen('dashboard');
        loadDashboard();
    } catch (e) {
        showMsg('loginMsg', 'err', 'Connection error. Please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Log In →'; }
    }
}

/* The one place that turns an already-registered student back to Log In. */
function _alreadyRegistered(email) {
    setAuthMode('login', { email: email || _loginEmail, keepMsg: true });
    showMsg('loginMsg', 'err',
        'You\'re already registered. Please log in with your password below — or tap "Forgot password?" if you don\'t remember it.');
    setTimeout(() => document.getElementById('loginPwInput')?.focus(), 80);
}

/* SIGN UP — first-time student. Known emails are turned away before a code is sent. */
async function doSignup() {
    const email = (document.getElementById('signupEmailInput')?.value || '').trim().toLowerCase();
    const btn = document.getElementById('signupBtn');
    const msg = document.getElementById('loginMsg');
    if (msg) { msg.className = 'msg'; msg.style.display = 'none'; }

    if (!email) { showMsg('loginMsg', 'err', 'Please enter your email address.'); shake('signupEmailInput'); return; }
    if (!_emailLooksValid(email)) { showMsg('loginMsg', 'err', 'That doesn\'t look like a valid email address.'); shake('signupEmailInput'); return; }

    _loginEmail = email;
    _resetMode = false;
    _loginHasPw = false;

    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Checking…'; }
    try {
        const r = await fetch(`${API_BASE}/api/student/login-check`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, instituteCode: _instituteCode })
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) _loginHasPw = !!data.hasPassword;
    } catch (_) { /* offline — fall through to the code flow */ }
    finally { if (btn) { btn.disabled = false; btn.textContent = 'Send Me a Code →'; } }

    if (_loginHasPw) { _alreadyRegistered(email); return; }
    await requestLoginOtp(email, 'signupBtn');
}

/* Retired — replaced by doLogin() / doSignup(). Kept so older call sites still work. */
async function startLogin() {
    const email = (document.getElementById('loginEmailInput')?.value || '').trim().toLowerCase();
    const btn = document.getElementById('loginSubmitBtn');
    const msg = document.getElementById('loginMsg');
    if (msg) { msg.className = 'msg'; msg.style.display = 'none'; }

    if (!email) { showMsg('loginMsg', 'err', 'Please enter your email address.'); shake('loginEmailInput'); return; }
    if (!_emailLooksValid(email)) { showMsg('loginMsg', 'err', 'That doesn\'t look like a valid email address.'); shake('loginEmailInput'); return; }

    _loginEmail = email;
    _resetMode = false;
    _loginHasPw = false;

    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Checking…';
    try {
        const r = await fetch(`${API_BASE}/api/student/login-check`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, instituteCode: _instituteCode })
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) _loginHasPw = !!data.hasPassword;
    } catch (_) { /* offline — fall through to the code flow */ }
    finally { btn.disabled = false; btn.textContent = 'Continue →'; }

    if (_loginHasPw) { _alreadyRegistered(_loginEmail); return; }
    await requestLoginOtp(_loginEmail, 'signupBtn');
}

/* Retired — replaced by doLogin(). */
async function signInWithPassword() {
    const pw = document.getElementById('loginPwInput')?.value || '';
    const btn = document.getElementById('loginSubmitBtn');
    const msg = document.getElementById('loginMsg');
    if (msg) { msg.className = 'msg'; msg.style.display = 'none'; }
    if (!pw) { showMsg('loginMsg', 'err', 'Please enter your password.'); shake('loginPwInput'); return; }

    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Signing in…';
    try {
        const r = await fetch(`${API_BASE}/api/student/login-password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: _loginEmail, password: pw, instituteCode: _instituteCode })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            showMsg('loginMsg', 'err', data.error || 'That email or password is incorrect.');
            shake('loginPwInput');
            // Account exists but has no password yet — send them down the code path.
            if (data.needsPassword) await requestLoginOtp(_loginEmail, 'signupBtn');
            return;
        }
        _token = data.token;
        _student = data.student;
        localStorage.setItem('gp_student_token', _token);
        showScreen('dashboard');
        loadDashboard();
    } catch (e) {
        showMsg('loginMsg', 'err', 'Connection error. Please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Log In →'; }
    }
}

/* Forgot password — same email code, but it ends on "create a password". */
async function forgotPassword() {
    const typed = (document.getElementById('loginEmailInput')?.value || '').trim().toLowerCase();
    const email = typed || _loginEmail;
    if (!email || !_emailLooksValid(email)) {
        setAuthMode('login');
        showMsg('loginMsg', 'err', 'Enter your email address first, then tap "Forgot password?".');
        shake('loginEmailInput');
        return;
    }
    _loginEmail = email;
    _resetMode = true;
    const intro = document.getElementById('setPwIntro');
    if (intro) intro.innerHTML = '🔑 Identity confirmed. Choose a new password — you\'ll use it to sign in from now on.';
    await requestLoginOtp(email, 'loginSubmitBtn');
}

/* Save the freshly chosen password and go to the dashboard. */
async function submitNewPassword() {
    const p1 = document.getElementById('newPwInput')?.value || '';
    const p2 = document.getElementById('newPw2Input')?.value || '';
    const btn = document.getElementById('setPwBtn');
    const msg = document.getElementById('loginMsg');
    if (msg) { msg.className = 'msg'; msg.style.display = 'none'; }

    if (p1.length < 6) { showMsg('loginMsg', 'err', 'Password must be at least 6 characters.'); shake('newPwInput'); return; }
    if (p1 !== p2) { showMsg('loginMsg', 'err', 'Both passwords must match.'); shake('newPw2Input'); return; }

    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Saving…';
    try {
        const r = await fetch(`${API_BASE}/api/student/set-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token}` },
            body: JSON.stringify({ password: p1 })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { showMsg('loginMsg', 'err', data.error || 'Could not save your password.'); return; }

        _resetMode = false;
        if (_student) _student.hasPassword = true;
        document.getElementById('newPwInput').value = '';
        document.getElementById('newPw2Input').value = '';
        showScreen('dashboard');
        loadDashboard();
    } catch (e) {
        showMsg('loginMsg', 'err', 'Connection error. Please try again.');
    } finally {
        btn.disabled = false; btn.textContent = 'Save Password & Continue →';
    }
}

/* Step 2 — verify the code and land on the dashboard. */
async function verifyLoginOtp() {
    const code = (document.getElementById('otpInput')?.value || '').replace(/\D/g, '');
    const btn = document.getElementById('verifyOtpBtn');

    const msg = document.getElementById('loginMsg');
    if (msg) { msg.className = 'msg'; msg.style.display = 'none'; }

    if (code.length !== 6) { showMsg('loginMsg', 'err', 'Please enter the full 6-digit code.'); shake('otpInput'); return; }

    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Signing in…';
    try {
        const r = await fetch(`${API_BASE}/api/student/verify-otp`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: _loginEmail, code, instituteCode: _instituteCode })
        });
        const data = await r.json();

        if (!r.ok) {
            showMsg('loginMsg', 'err', data.error || 'That code is incorrect.');
            shake('otpInput');
            // A dead code means starting over with a fresh one.
            if (data.expired) {
                document.getElementById('otpInput').value = '';
                _startResendCooldown(0);
            }
            return;
        }

        _token = data.token;
        _student = data.student;
        localStorage.setItem('gp_student_token', _token);
        if (_resendTimer) { clearInterval(_resendTimer); _resendTimer = null; }

        // Signed up with an email that already has a password — send them to Log In instead.
        if (_authMode === 'signup' && !_resetMode && !data.needsPassword && data.hasPassword) {
            _token = '';
            _student = null;
            localStorage.removeItem('gp_student_token');
            _alreadyRegistered(_loginEmail);
            return;
        }

        // No password on file yet (or they are resetting one) — make them pick one.
        if (data.needsPassword || _resetMode) {
            const intro = document.getElementById('setPwIntro');
            if (intro && !_resetMode) {
                intro.innerHTML = '🎉 Email verified! Create a password now — next time you can sign in with just your email and password.';
            }
            const a = document.getElementById('newPwInput'); if (a) a.value = '';
            const b = document.getElementById('newPw2Input'); if (b) b.value = '';
            _showLoginStep('setpw');
            const msgEl = document.getElementById('loginMsg');
            if (msgEl) { msgEl.className = 'msg'; msgEl.style.display = 'none'; }
            setTimeout(() => document.getElementById('newPwInput')?.focus(), 60);
            return;
        }

        showScreen('dashboard');
        loadDashboard();
    } catch (e) {
        showMsg('loginMsg', 'err', 'Connection error. Please try again.');
    } finally {
        btn.disabled = false; btn.textContent = 'Verify & Sign In →';
    }
}

async function resendLoginOtp() {
    if (_resendCooldown > 0 || !_loginEmail) return;
    await requestLoginOtp(_loginEmail);
}

/* Back to whichever form the student started from (Log In or Sign Up). */
function backToStart() {
    if (_resendTimer) { clearInterval(_resendTimer); _resendTimer = null; }
    _resendCooldown = 0;
    const otp = document.getElementById('otpInput');
    if (otp) otp.value = '';
    setAuthMode(_authMode);
}

/* Older name, kept so existing call sites keep working. */
function backToEmailStep() { backToStart(); }

/* Kept for the rest of the app, which calls this to return to a clean login. */
function goBackToLogin() {
    _loginEmail = '';
    _pendingRoll = '';
    localStorage.removeItem('gp_pending_roll');
    ['loginEmailInput', 'signupEmailInput', 'loginPwInput'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    setAuthMode('login');
    showScreen('login');
}


function loadDashboard() {
    if (!_student) return;
    const initials = (_student.name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

    // Dynamically update Branding based on the institute the student belongs to
    if (_student.instituteName || _student.instituteLogo) {
        _saveBrandCache(_student.instituteName || '', _student.instituteLogo || '');
        applyInstituteBranding(_student.instituteName || '', _student.instituteLogo || '');
    } else {
        // Older/cached API responses may omit branding — fetch it explicitly.
        resolveInstituteBranding();
    }

    // sidebar
    document.getElementById('sidebarAvatar').textContent = initials;
    document.getElementById('sidebarName').textContent = _student.name || '—';
    document.getElementById('sidebarRoll').textContent = _student.className || _student.email || '';

    // dash header
    const first = (_student.name || 'Student').split(' ')[0];
    document.getElementById('dashName').textContent = `Hello, ${first}! 🎯`;
    document.getElementById('dashRoll').textContent = _student.className || '';

    // info
    document.getElementById('infoClass').textContent = _student.className || '—';
    document.getElementById('infoPhone').textContent = _student.phone || '—';
    document.getElementById('infoDate').textContent = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

    // footer
    document.getElementById('footerRoll').textContent = `Logged in as ${_student.name || 'Student'}`;

    loadTests();
    loadTestHistoryDashboard();
    // Prefer server-side stats when available, fallback to local
    (async function () {
        let stats = null;
        if (_student) {
            try {
                const r = await fetch(`${API_BASE}/api/student/stats/${encodeURIComponent(_student.rollNumber)}`);
                if (r.ok) stats = await r.json();
            } catch (e) { /* ignore */ }
        }
        if (stats) {
            const completedEl = document.getElementById('statCompleted');
            const avgEl = document.getElementById('statAvg');
            const streakEl = document.querySelectorAll('.stat-tile .stat-num')[3];
            if (completedEl) completedEl.textContent = stats.tests_completed || 0;
            if (avgEl) avgEl.textContent = (typeof stats.avg_pct === 'number') ? `${stats.avg_pct}%` : '—';
            if (streakEl) streakEl.textContent = stats.day_streak || 0;
        } else if (typeof updateDashboardStats === 'function') await updateDashboardStats();
    })();
    // Fetch and display notifications
    loadStudentNotifications();
}

async function loadStudentNotifications() {
    if (!_student || !_student.rollNumber) return;
    try {
        const r = await fetch(`${API_BASE}/api/admin/notifications/${encodeURIComponent(_student.rollNumber)}`);
        if (!r.ok) return;
        const notifications = await r.json();
        if (!notifications.length) return;
        const ids = notifications.map(n => n.id);
        // Show notifications in a banner
        const container = document.getElementById('notificationBanner');
        if (!container) return;
        container.innerHTML = notifications.map(n => `
                    <div class="att-notification" data-id="${n.id}" style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(86,169,255,0.1);border:1px solid rgba(86,169,255,0.25);border-radius:var(--radius-sm);margin-bottom:8px">
                        <span style="font-size:1.2rem">📢</span>
                        <div style="flex:1;font-size:0.84rem">${n.message}</div>
                        <button onclick="dismissNotification(${n.id})" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.8rem;padding:4px">✕</button>
                    </div>
                `).join('');
        container.style.display = 'block';
        // Mark as read after showing
        setTimeout(() => {
            fetch(`${API_BASE}/api/admin/notifications/read`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids }),
            }).catch(() => { });
        }, 3000);
    } catch (_) { }
}

function dismissNotification(id) {
    const el = document.querySelector(`.att-notification[data-id="${id}"]`);
    if (el) el.style.display = 'none';
    fetch(`${API_BASE}/api/admin/notifications/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
    }).then(() => {
        if (Array.isArray(_trHistory)) {
            const rec = _trHistory.find(h => String(h.id) === String(id));
            if (rec) rec.is_locked = -1; // -1 = teacher-unlocked
        }
    }).catch(() => { });
}

async function loadTests() {
    document.getElementById('testsLoading').style.display = 'block';
    document.getElementById('testGrid').style.display = 'none';
    document.getElementById('testsEmpty').classList.add('hidden');
    try {
        const headers = { Authorization: `Bearer ${_token}` };
        // ONE request. The server now aggregates attempt counts and lock state per
        // test, so we no longer download the student's entire test history (which
        // carried every answer payload) just to count attempts.
        const onlineResp = await fetch(`${API_BASE}/api/student/online-tests`, { headers });
        const onlineTests = onlineResp.ok ? await onlineResp.json() : [];
        const markedOnline = onlineTests.map(t => {
            const maxAttempts = Number(t.maxAttempts) || 1;
            const attemptsUsed = Number(t.attemptsUsed) || 0;
            return {
                ...t,
                _isOnline: true,
                attemptsUsed,
                maxAttempts,
                attemptsExhausted: (typeof t.attemptsExhausted === 'boolean')
                    ? t.attemptsExhausted
                    : attemptsUsed >= maxAttempts,
                hasLockedAttempt: !!t.hasLockedAttempt,
                isAttempted: attemptsUsed > 0
            };
        });
        window.renderTests(markedOnline);
    } catch (e) { document.getElementById('testsLoading').innerHTML = '⚠ Failed to load tests.'; }
}

function _renderTestsBase(tests) {
    document.getElementById('testsLoading').style.display = 'none';
    document.getElementById('statTests').textContent = tests.length || '0';
    document.getElementById('testPanelBadge').textContent = `${tests.length} Test${tests.length !== 1 ? 's' : ''}`;
    const nb = document.getElementById('navTestsBadge');
    nb.textContent = tests.length; nb.style.display = tests.length ? '' : 'none';
    const grid = document.getElementById('testGrid');
    if (!tests.length) { document.getElementById('testsEmpty').classList.remove('hidden'); return; }
    grid.style.display = 'flex';
    grid.innerHTML = tests.map((t, i) => {
        const date = t.updatedAt ? new Date(t.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        return `<div class="test-card" style="animation-delay:${i * 0.05}s">
            <span class="test-card-num">${String(i + 1).padStart(2, '0')}</span>
            <div class="test-card-icon">📖</div>
            <div class="test-card-body">
                <div class="test-card-title">${escHtml(t.chapter)}</div>
                <div class="test-card-sub">${t.topic ? escHtml(t.topic) + '  ·  ' : ''}${date}</div>
            </div>
            <span class="badge badge-open">Open</span>
        </div>`;
    }).join('');
}

/* ══ Load Test History for Dashboard ══ */
async function loadTestHistoryDashboard() {
    // History panel removed from dashboard; only update sidebar badge
    try {
        let history = [];
        if (_student) {
            try {
                const res = await fetch(`${API_BASE}/api/test-history/${_student.rollNumber}`);
                if (res.ok) history = await res.json();
            } catch (e) { /* ignore */ }
        }
        if (!history.length) history = getTestHistory();

        // Sidebar badge shows distinct completed tests, not raw attempt rows.
        const attempted = uniqueCompletedTests(history).length;
        const nb = document.getElementById('navTestsBadge');
        nb.textContent = attempted;
        nb.style.display = attempted ? '' : 'none';
    } catch (e) {
        console.error('Error loading test history:', e);
    }
}

/* ══ TEST ANALYSIS: Show List of All Attempted Tests ══ */
// ── Paginated Test Analysis (infinite scroll, 7 per page) ────────────
// State variables for pagination
let _taPage = 0;           // last loaded page (0 = nothing loaded yet)
let _taTotal = 0;          // total tests on server
let _taHasMore = false;    // whether more pages exist
let _taLoading = false;    // guard against concurrent fetches
// Larger page = fewer round-trips. Safe now that the list request is
// "light" (no question banks in the payload).
const TA_PAGE_SIZE = 25;

// Render a helper that re-shows already-loaded data without a fetch
function _taRenderExisting() {
    setActiveNav('tests');
    document.getElementById('topbarTitle').textContent = 'Test Analysis';
    // cards already in DOM — just make sure sentinel is correct
    const sentinel = document.getElementById('taScrollSentinel');
    if (sentinel) sentinel.style.display = _taHasMore ? '' : 'none';
}

// Stable identity for one attempt, used to avoid re-rendering existing cards.
function _taKeyFor(test) {
    if (test && test.id != null) return 'id_' + test.id;
    if (test && test.online_test_id) return 'ot_' + test.online_test_id + '_' + (test.timestamp || 0);
    return 'sq_' + (test?.test?.chapter || '') + '_' + (test?.test?.lecture || '') + '_' + (test?.timestamp || 0);
}

// The list is loaded in light mode (no questions/answers). Before opening the
// detail view for one attempt, pull its full record once and cache it.
async function _taEnsureFullTest(idx) {
    const test = window._testAnalysisData?.[idx];
    if (!test) return null;
    if (!test.light || test._hydrated) return test;
    if (test.id == null || !_student?.rollNumber) return test;

    if (test._hydrating) { try { await test._hydrating; } catch (_) { } return window._testAnalysisData?.[idx] || test; }

    test._hydrating = (async () => {
        const url = `${API_BASE}/api/test-history/${encodeURIComponent(_student.rollNumber)}/attempt/${encodeURIComponent(test.id)}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${_token}` } });
        if (!res.ok) throw new Error('attempt fetch failed');
        const full = await res.json();
        Object.assign(test, full, { light: false, _hydrated: true });
        return test;
    })();

    try { await test._hydrating; }
    catch (err) { console.error('_taEnsureFullTest error:', err); }
    finally { delete test._hydrating; }

    return test;
}

// Build one card HTML for a test at absolute index `idx` in _testAnalysisData
function _taCardHtml(test, idx) {
    const ts = test.timestamp;
    const dt = new Date(ts > 1e12 ? ts : ts * 1000);
    const dateStr = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const pct = test.result?.pct || 0;
    const accentColor = pct >= 75 ? '#22c55e' : pct >= 50 ? '#fbbf24' : '#ef4444';
    const pctColor = pct >= 75 ? '#22c55e' : pct >= 50 ? '#fbbf24' : '#ef4444';
    const correct = test.result?.correct || 0;
    const wrong = test.result?.wrong || 0;
    const skipped = test.result?.skipped || 0;
    const isOnlineTest = !test.test?.lecture || test.test?.lecture === 'online' || (test.test?.lecture && /^\d+$/.test(String(test.test.lecture)) && String(test.test.lecture).length > 10);
    const testTitle = isOnlineTest
        ? escHtml(test.test?.chapter || test.test?.topic || 'Online Test')
        : escHtml(test.test?.chapter || 'Test');
    return `<div class="ta-test-card" onclick="openTestDetail(${idx})" style="animation:fadeUp .3s var(--ease) both">
                        <div class="ta-test-accent" style="background:${accentColor}"></div>
                        <div class="ta-test-card-inner">
                            <div class="ta-test-top">
                                <div style="flex:1;min-width:0">
                                    <div class="ta-test-title">${testTitle}</div>
                                    <div class="ta-test-date">🕐 ${dateStr} at ${timeStr}${test.result?.timeTaken ? ' · ⏱ ' + formatTime(test.result.timeTaken) : ''}</div>
                                </div>
                                <div>
                                    <div class="ta-pct-badge" style="color:${pctColor}">${pct}%</div>
                                    <div class="ta-pct-label">ACCURACY</div>
                                </div>
                            </div>
                            <div class="ta-stats-row">
                                <div class="ta-stat-chip" style="background:rgba(34,197,94,0.1)">
                                    <div class="ta-stat-chip-lbl">Correct</div>
                                    <div class="ta-stat-chip-val" style="color:#22c55e">${correct}</div>
                                </div>
                                <div class="ta-stat-chip" style="background:rgba(239,68,68,0.1)">
                                    <div class="ta-stat-chip-lbl">Wrong</div>
                                    <div class="ta-stat-chip-val" style="color:#ef4444">${wrong}</div>
                                </div>
                                <div class="ta-stat-chip" style="background:rgba(107,114,128,0.1)">
                                    <div class="ta-stat-chip-lbl">Skipped</div>
                                    <div class="ta-stat-chip-val" style="color:var(--text-faint)">${skipped}</div>
                                </div>
                                <div class="ta-stat-chip" style="background:rgba(167,139,250,0.1)">
                                    <div class="ta-stat-chip-lbl">Marks</div>
                                    <div class="ta-stat-chip-val" style="color:#a78bfa">${test.result?.marksScore ?? test.result?.marks ?? 0}</div>
                                </div>
                            </div>
                        </div>
                    </div>`;
}

// Append the next page of cards to the container (without clearing it)
async function _taLoadNextPage() {
    if (_taLoading || (!_taHasMore && _taPage > 0)) return;
    _taLoading = true;
    const container = document.getElementById('testAnalysisListContainer');
    const sentinel = document.getElementById('taScrollSentinel');
    if (sentinel) sentinel.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-faint)"><span class="spin"></span> Loading more…</div>';

    try {
        const nextPage = _taPage + 1;
        // light=1 tells the server to skip resolving every test's question bank.
        // Questions are fetched on demand when one attempt is opened.
        const url = `${API_BASE}/api/test-history/${encodeURIComponent(_student.rollNumber)}`
            + `?page=${nextPage}&limit=${TA_PAGE_SIZE}&light=1`
            + (_taTotal ? `&total=${_taTotal}` : '');
        const res = await fetch(url, { headers: { Authorization: `Bearer ${_token}` } });
        if (!res.ok) throw new Error('fetch failed');
        const json = await res.json();

        const newTests = json.data || [];
        _taTotal = json.total || _taTotal;
        _taHasMore = json.hasMore || false;
        _taPage = nextPage;

        // Append to the global cache
        if (!window._testAnalysisData) window._testAnalysisData = [];
        const beforeLen = window._testAnalysisData.length;
        window._testAnalysisData.push(...newTests);

        // Deduplicate: for each unique test (by online_test_id or chapter+lecture),
        // keep only the best attempt per student.
        // Priority: is_locked=0 (normal) > is_locked=-1 (unlocked) > is_locked=1 (locked)
        {
            const bestPerTest = new Map();
            window._testAnalysisData.forEach(t => {
                const key = t.online_test_id
                    ? `ot_${t.online_test_id}`
                    : `sq_${t.test?.chapter || ''}_${t.test?.lecture || ''}`;
                const existing = bestPerTest.get(key);
                const pCur = t.is_locked === 0 ? 2 : t.is_locked === -1 ? 1 : t.is_locked === 1 ? 0 : 2;
                const pExist = existing ? (existing.is_locked === 0 ? 2 : existing.is_locked === -1 ? 1 : existing.is_locked === 1 ? 0 : 2) : -1;
                if (!existing || pCur > pExist || (pCur === pExist && (t.timestamp || 0) > (existing.timestamp || 0))) {
                    bestPerTest.set(key, t);
                }
            });
            window._testAnalysisData = [...bestPerTest.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        }

        // Update summary stats based on deduped data
        const allLoaded = window._testAnalysisData;
        const totalTime = allLoaded.reduce((s, t) => s + (t.result?.timeTaken || 0), 0);
        const avgAcc = allLoaded.length ? Math.round(allLoaded.reduce((s, t) => s + (t.result?.pct || 0), 0) / allLoaded.length) : 0;
        const bestAcc = allLoaded.length ? Math.max(...allLoaded.map(t => t.result?.pct || 0)) : 0;
        const sumTests = document.getElementById('taSumTests');
        const sumAvg = document.getElementById('taSumAvg');
        const sumBest = document.getElementById('taSumBest');
        const sumTime = document.getElementById('taSumTime');
        if (sumTests) sumTests.textContent = allLoaded.length;
        if (sumAvg) sumAvg.textContent = avgAcc + '%';
        if (sumBest) sumBest.textContent = bestAcc + '%';
        if (sumTime) sumTime.textContent = formatTime(totalTime) || '—';

        // Render incrementally. Previously every page rebuilt EVERY card from
        // scratch (O(n²) DOM work + a full MathJax/layout thrash), which is why the
        // screen crawled once a student had a few pages of history. Now we only
        // append the cards that are genuinely new, and just re-sync the indices
        // that the dedup pass may have shifted.
        const existing = new Map();
        container.querySelectorAll('.ta-test-card[data-ta-key]').forEach(el => {
            existing.set(el.getAttribute('data-ta-key'), el);
        });

        const fragment = document.createDocumentFragment();
        allLoaded.forEach((test, idx) => {
            const key = _taKeyFor(test);
            const el = existing.get(key);
            if (el) {
                // Already on screen — just make sure its click index is current.
                el.setAttribute('onclick', `openTestDetail(${idx})`);
                existing.delete(key);
            } else {
                const div = document.createElement('div');
                div.innerHTML = _taCardHtml(test, idx);
                const card = div.firstElementChild;
                if (card) {
                    card.setAttribute('data-ta-key', key);
                    fragment.appendChild(card);
                }
            }
        });
        // Any card whose record was superseded by a better attempt is removed.
        existing.forEach(el => el.remove());

        let sentinelEl = document.getElementById('taScrollSentinel');
        if (!sentinelEl) {
            sentinelEl = document.createElement('div');
            sentinelEl.id = 'taScrollSentinel';
        }
        sentinelEl.innerHTML = _taHasMore
            ? '<div style="text-align:center;padding:16px;color:var(--text-faint);font-size:0.8rem">Scroll down to load more…</div>'
            : '<div style="text-align:center;padding:16px;color:var(--text-faint);font-size:0.75rem">— All loaded —</div>';

        container.appendChild(fragment);
        container.appendChild(sentinelEl); // keep sentinel last

        if (!_taHasMore && _taObserver) {
            _taObserver.disconnect();
            _taObserver = null;
        }
    } catch (err) {
        console.error('_taLoadNextPage error:', err);
        const container2 = document.getElementById('testAnalysisListContainer');
        const sentinel2 = document.getElementById('taScrollSentinel');
        if (sentinel2) sentinel2.innerHTML = '<div style="text-align:center;padding:16px;color:var(--error)">⚠ Failed to load. <button onclick="_taLoadNextPage()" style="background:none;border:none;color:var(--cyan);cursor:pointer;text-decoration:underline">Retry</button></div>';
    } finally {
        _taLoading = false;
    }
}

// IntersectionObserver that fires _taLoadNextPage when sentinel is visible
let _taObserver = null;
function _taSetupObserver() {
    if (_taObserver) _taObserver.disconnect();
    const sentinel = document.getElementById('taScrollSentinel');
    if (!sentinel) return;
    _taObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && _taHasMore && !_taLoading) {
            _taLoadNextPage();
        }
    }, { threshold: 0.1 });
    _taObserver.observe(sentinel);
}

async function showTestAnalysisList(doPushHistory = true) {
    showScreen('test-analysis', doPushHistory);
    document.getElementById('topbarTitle').textContent = 'Test Analysis';
    setActiveNav('tests');
    const container = document.getElementById('testAnalysisListContainer');

    if (!_student || !_student.rollNumber) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-faint)">⚠ Please log in to view your test history.</div>';
        return;
    }

    // Reset pagination state for a fresh load
    _taPage = 0;
    _taTotal = 0;
    _taHasMore = true;  // assume there's at least something to load
    _taLoading = false;
    window._testAnalysisData = [];

    // Clear container and add sentinel
    container.innerHTML = '<div id="taScrollSentinel"></div>';

    // Kick off first page load
    await _taLoadNextPage();

    // If nothing came back show empty state
    if (!window._testAnalysisData.length) {
        container.innerHTML = `<div style="text-align:center;padding:60px 20px">
                    <div style="font-size:3rem;margin-bottom:16px">📋</div>
                    <div style="font-family:var(--font-head);font-size:1.1rem;font-weight:700;color:var(--text);margin-bottom:8px">No tests attempted yet</div>
                    <div style="color:var(--text-faint);font-size:0.875rem">Start your first test from the Tests section!</div>
                </div>`;
        ['taSumTests', 'taSumAvg', 'taSumBest', 'taSumTime'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '0'; });
        return;
    }

    // Set up the observer after first paint
    requestAnimationFrame(_taSetupObserver);
}

/* ══ TEST ANALYSIS: Open Test Summary (new intermediate screen) ══ */
async function openTestDetail(idx, doPushHistory = true) {
    let test = window._testAnalysisData?.[idx];
    if (!test) return;
    // Pull the heavy data for just this attempt (no-op if already loaded).
    test = (await _taEnsureFullTest(idx)) || test;
    window._tdCurrentTestIdx = idx; // store for "View Questions" btn
    showScreen('test-summary', doPushHistory);
    setActiveNav('tests');
    document.getElementById('topbarTitle').textContent = 'Test Details';

    // Title & date
    const ts = test.timestamp;
    const dt = new Date(ts > 1e12 ? ts : ts * 1000);
    const dateStr = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const lectureStr = String(test.test?.lecture || '');
    const isOnlineHistoryTest = !test.test?.lecture || test.test?.lecture === 'online' || /^\d+$/.test(lectureStr) || (test.questions && test.questions.length > 0);
    const testTitle = isOnlineHistoryTest
        ? (test.test?.chapter || test.test?.topic || 'Online Test')
        : (test.test?.chapter || 'Test');

    document.getElementById('tsSummaryTitle').textContent = testTitle;
    document.getElementById('tsSummaryDate').textContent = `Attempted on ${dateStr} at ${timeStr}`;

    // Basic stats
    const correct = test.result?.correct || 0;
    const wrong = test.result?.wrong || 0;
    const skipped = test.result?.skipped || 0;
    const total = test.result?.total || 1;
    const marks = test.result?.marksScore ?? 0;
    const maxMarks = test.result?.maxMarks || (total * 4);
    const pct = test.result?.pct || 0;
    const timeTaken = test.result?.timeTaken || 0;

    // Pie chart
    renderTsPie(correct, wrong, skipped, total, pct);

    /* ══ "View Questions & Solutions" button state ══════════════════════════
       While the test window is open (or the attempt is locked) the detailed
       analysis is withheld, so the button says so up front instead of opening
       an empty question viewer. */
    {
        const viewBtn = document.getElementById('tsViewQuestionsBtn');
        if (viewBtn) {
            const lock = _taAnalysisLock(test);
            const when = _taUnlockLabel(lock.unlockAt);
            if (lock.locked) {
                viewBtn.innerHTML = when
                    ? `🔒 Analysis unlocks on ${escHtml(when)}`
                    : '🔒 Analysis unlocks when the test time is over';
                viewBtn.style.opacity = '0.65';
                viewBtn.style.cursor = 'not-allowed';
                viewBtn.title = lock.reason === 'attempt_locked'
                    ? 'This attempt was locked, so only your marks are shown for now.'
                    : 'You submitted before the test window closed, so only your marks are shown for now.';
            } else {
                viewBtn.innerHTML = 'View Questions &amp; Solutions';
                viewBtn.style.opacity = '';
                viewBtn.style.cursor = '';
                viewBtn.title = '';
            }
        }
    }

    // Legend values
    const safeDiv = (a, b) => b > 0 ? Math.round(a / b * 100) : 0;
    document.getElementById('tsLegCorrect').textContent = correct;
    document.getElementById('tsLegCorrectPct').textContent = safeDiv(correct, total) + '%';
    document.getElementById('tsLegWrong').textContent = wrong;
    document.getElementById('tsLegWrongPct').textContent = safeDiv(wrong, total) + '%';
    document.getElementById('tsLegSkipped').textContent = skipped;
    document.getElementById('tsLegSkippedPct').textContent = safeDiv(skipped, total) + '%';

    // Stat cards
    document.getElementById('tsMarks').textContent = marks >= 0 ? '+' + marks : marks;
    document.getElementById('tsMarksMax').textContent = `out of ${maxMarks}`;
    document.getElementById('tsTime').textContent = timeTaken ? formatTime(timeTaken) : '—';
    document.getElementById('tsTopper').textContent = '…';
    document.getElementById('tsAvg').textContent = '…';
    document.getElementById('tsAvgAttempts').textContent = 'Loading…';

    // Bars — your score vs max
    const maxPossible = maxMarks || 1;
    setTimeout(() => {
        const youPct = Math.max(0, Math.min(100, (marks / maxPossible) * 100));
        document.getElementById('tsBarYou').style.width = youPct + '%';
        document.getElementById('tsBarYouNum').textContent = marks;
    }, 80);

    // Fetch leaderboard stats
    try {
        let url = `${API_BASE}/api/test-leaderboard?`;
        if (test.online_test_id) {
            url += `online_test_id=${encodeURIComponent(test.online_test_id)}`;
        } else {
            url += `chapter=${encodeURIComponent(test.test?.chapter || '')}&lecture=${encodeURIComponent(test.test?.lecture || '')}`;
        }
        const r = await fetch(url);
        if (r.ok) {
            const lb = await r.json();
            const topper = lb.topper ?? null;
            const avg = lb.avg ?? null;
            document.getElementById('tsTopper').textContent = topper !== null ? topper : '—';
            document.getElementById('tsAvg').textContent = avg !== null ? avg : '—';
            document.getElementById('tsAvgAttempts').textContent = lb.attempts ? `${lb.attempts} attempt${lb.attempts !== 1 ? 's' : ''}` : '—';
            const ref = Math.max(maxMarks, topper || 0, 1);
            setTimeout(() => {
                document.getElementById('tsBarTopper').style.width = (Math.min(100, ((topper || 0) / ref) * 100)) + '%';
                document.getElementById('tsBarTopperNum').textContent = topper !== null ? topper : '—';
                document.getElementById('tsBarAvg').style.width = (Math.min(100, ((avg || 0) / ref) * 100)) + '%';
                document.getElementById('tsBarAvgNum').textContent = avg !== null ? avg : '—';
                document.getElementById('tsBarYou').style.width = (Math.min(100, (marks / ref) * 100)) + '%';
            }, 200);
        }
    } catch (e) {
        document.getElementById('tsTopper').textContent = '—';
        document.getElementById('tsAvg').textContent = '—';
        document.getElementById('tsAvgAttempts').textContent = 'Unavailable';
    }
}

function renderTsPie(correct, wrong, skipped, total, pct) {
    const svg = document.getElementById('tsPieChart');
    // Remove old segments
    svg.querySelectorAll('.ts-seg').forEach(el => el.remove());
    const cx = 80, cy = 80, r = 60, strokeW = 22;
    const circumference = 2 * Math.PI * r;
    const data = [
        { val: correct, color: '#22c55e' },
        { val: wrong, color: '#ef4444' },
        { val: skipped, color: '#6b7280' },
    ];
    const sum = data.reduce((s, d) => s + d.val, 0) || 1;
    let offset = 0;
    const gap = circumference * 0.012; // small gap between segments

    // Insert before the text elements
    const textEls = svg.querySelectorAll('text');
    data.forEach(({ val, color }) => {
        const fraction = val / sum;
        const dash = Math.max(0, fraction * circumference - gap);
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('class', 'ts-seg');
        circle.setAttribute('cx', cx);
        circle.setAttribute('cy', cy);
        circle.setAttribute('r', r);
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', color);
        circle.setAttribute('stroke-width', strokeW);
        circle.setAttribute('stroke-dasharray', `${dash} ${circumference}`);
        circle.setAttribute('stroke-dashoffset', -offset * circumference);
        circle.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
        circle.style.transition = 'stroke-dasharray 0.8s cubic-bezier(.4,0,.2,1)';
        svg.insertBefore(circle, textEls[0]);
        offset += fraction;
    });

    // Center text
    const pctEl = document.getElementById('tsPiePct');
    const accentColor = pct >= 75 ? '#22c55e' : pct >= 50 ? '#fbbf24' : '#ef4444';
    pctEl.textContent = pct + '%';
    pctEl.setAttribute('fill', accentColor);
}

/* ══ ANALYSIS LOCK ══════════════════════════════════════════════════════════
   Single source of truth for "may this student see the question-by-question
   analysis yet?". The server decides (it owns online_tests.ends_at and sends
   analysisAvailable / analysisAvailableAt / testEndsAt), but we re-check the
   end time here too, because:
     • the student may sit on the screen until the test ends (or opened it from a
       cached/locally-stored record that predates the flags), and
     • an attempt with no questions must never fall through to the empty
       question viewer — it has to show the "unlocks at …" notice instead.
   Returns { locked, unlockAt, reason }.                                      */
function _taAnalysisLock(test) {
    if (!test) return { locked: false, unlockAt: 0, reason: null };
    // Self-practice / star-quiz attempts are never gated.
    const isOnline = !!(test.online_test_id && Number.isFinite(Number(test.online_test_id)));
    if (!isOnline) return { locked: false, unlockAt: 0, reason: null };

    const unlockAt = Number(test.analysisAvailableAt) || Number(test.testEndsAt) || 0;
    const stillRunning = unlockAt ? Date.now() < unlockAt : false;
    const attemptLocked = (Number(test.is_locked) || 0) !== 0;

    // Explicit server verdict wins, but only while the end time is still ahead:
    // once it passes, a stale "false" must not keep the analysis hidden.
    if (test.analysisAvailable === false && (stillRunning || attemptLocked || !unlockAt)) {
        return {
            locked: true,
            unlockAt,
            reason: test.analysisLockedReason || (attemptLocked ? 'attempt_locked' : 'test_in_progress'),
        };
    }
    // No verdict (light row, cached record) — fall back to the clock.
    if (stillRunning) {
        return { locked: true, unlockAt, reason: attemptLocked ? 'attempt_locked' : 'test_in_progress' };
    }
    return { locked: false, unlockAt, reason: null };
}

/* "29 Aug 2026, 01:50 am" — the moment the analysis opens up. */
function _taUnlockLabel(unlockAt) {
    const at = Number(unlockAt) || 0;
    if (!at) return '';
    return new Date(at).toLocaleString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

/* Opens the full question viewer from the summary screen */
async function openTestDetailFromSummary() {
    const idx = window._tdCurrentTestIdx;
    if (idx === undefined) return;
    // The button already says "locked" in this case; keep the student on the
    // summary screen and just remind them when it opens up.
    const test = window._testAnalysisData?.[idx];
    const lock = _taAnalysisLock(test);
    if (lock.locked) {
        const when = _taUnlockLabel(lock.unlockAt);
        showToast(lock.reason === 'attempt_locked'
            ? (when ? `🔒 This attempt was locked. Full analysis unlocks on ${when}.` : '🔒 This attempt was locked — only your marks are available.')
            : (when ? `🔒 Full analysis unlocks on ${when}, once the test time is over.` : '🔒 Full analysis unlocks once the test time is over.'));
        return;
    }
    await _openTestDetailInner(idx);
}

/* ══ TEST ANALYSIS: Open Test Detail (Question viewer) ══ */
async function _openTestDetailInner(idx) {
    let test = window._testAnalysisData?.[idx];
    if (!test) return;
    test = (await _taEnsureFullTest(idx)) || test;
    showScreen('test-detail');
    setActiveNav('tests');
    document.getElementById('topbarTitle').textContent = 'Test Details';

    // Robust timestamp: server stores Date.now() = ms; some older entries may be seconds
    const ts = test.timestamp;
    const dt = new Date(ts > 1e12 ? ts : ts * 1000);
    const dateStr = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

    // Online tests: have no lecture (or lecture='online'), OR have stored questions array in the record,
    // OR their lecture is a very large numeric ID (>10 digits = ms timestamp, not a lecture number 1-999).
    // Star-quiz tests use short lecture strings like "1", "2", "10", etc.
    const lectureStr = String(test.test?.lecture || '');
    // Online tests store their DB id or the string 'online' as the lecture value.
    // Star-quiz tests always use short lecture strings like "1", "3", "10".
    // Online tests: lecture is null/empty, 'online', OR a pure integer (online_tests.id, any length).
    // Also detect via questions array already populated by server.
    const isOnlineHistoryTest = !test.test?.lecture
        || test.test?.lecture === 'online'
        || /^\d+$/.test(lectureStr)
        || (test.questions && test.questions.length > 0);
    document.getElementById('testDetailTitle').textContent = isOnlineHistoryTest
        ? (test.test?.chapter || test.test?.topic || 'Online Test')
        : `${test.test?.chapter || 'Test'}`;
    document.getElementById('testDetailAttemptTime').textContent = `Attempted on ${dateStr} at ${timeStr}`;
    document.getElementById('testDetailScore').textContent = `${test.result?.correct || 0}/${test.result?.total || 0}`;
    document.getElementById('testDetailAccuracy').textContent = `${test.result?.pct || 0}%`;
    document.getElementById('testDetailMarks').textContent = test.result?.marksScore ?? test.result?.marks ?? 0;
    document.getElementById('testDetailTime').textContent = test.result?.timeTaken ? formatTime(test.result.timeTaken) : '—';

    // Performance bars
    const total = test.result?.total || 1;
    const c = test.result?.correct || 0, w = test.result?.wrong || 0, s = test.result?.skipped || 0;
    setTimeout(() => {
        const bc = document.getElementById('tdBarCorrect'), bw = document.getElementById('tdBarWrong'), bs = document.getElementById('tdBarSkip');
        if (bc) bc.style.width = (c / total * 100) + '%';
        if (bw) bw.style.width = (w / total * 100) + '%';
    }, 100);
    const lc = document.getElementById('tdLblCorrect'), lw = document.getElementById('tdLblWrong'), ls = document.getElementById('tdLblSkip');
    if (lc) lc.textContent = `Correct (${c})`;
    if (lw) lw.textContent = `Wrong (${w})`;
    if (ls) ls.textContent = `Skipped (${s})`;

    const questionsContainer = document.getElementById('testDetailQuestions');

    /* ══ ANALYSIS GATE ══════════════════════════════════════════════════════
       For institute (online) tests the server withholds the questions, the
       student's answers and the per-question timings until the test's end time
       has passed — so a student who submits early, or whose attempt got locked
       by strict mode, cannot leak the answer key to classmates who are still
       writing. The score above is always shown. */
    const _gateLock = _taAnalysisLock(test);
    if (_gateLock.locked) {
        const unlockAt = _gateLock.unlockAt;
        const unlockStr = _taUnlockLabel(unlockAt);
        const wasLocked = _gateLock.reason === 'attempt_locked';
        const heading = wasLocked ? 'Attempt locked' : 'Analysis not available yet';
        const detail = wasLocked
            ? 'This attempt was locked, so only your marks are shown for now.'
            : 'You submitted before the test window closed, so only your marks are shown for now.';
        const viewer = document.getElementById('tdQuestionViewer');
        if (viewer) viewer.innerHTML = '';
        if (questionsContainer) {
            questionsContainer.innerHTML = `
                <div style="text-align:center;padding:28px 18px;background:var(--bg-card);border:1px solid var(--border);border-radius:12px">
                    <div style="font-size:2rem;margin-bottom:8px">🔒</div>
                    <div style="font-weight:700;margin-bottom:6px">${heading}</div>
                    <div style="color:var(--text-faint);font-size:0.85rem;line-height:1.5">
                        ${detail}<br>
                        The full question-by-question analysis unlocks for everyone
                        ${unlockStr ? `on <b>${escHtml(unlockStr)}</b>` : 'once the test time is over'}.
                    </div>
                </div>`;
        }
        const qLabelLocked = document.getElementById('tdQuestionsLabel');
        if (qLabelLocked) qLabelLocked.textContent = 'RESULT ONLY';
        window._tdQuestions = [];
        return;
    }
    const qLabel = null; // Legacy — kept for fallback paths; primary UI uses split-panel now
    // Reset state
    window._tdQuestions = [];
    window._tdCurrentFilter = 'all';
    window._tdCurrentQIdx = 0;
    // Reset palette filter buttons
    ['tdrfAll', 'tdrfCorrect', 'tdrfWrong', 'tdrfSkipped'].forEach(id => {
        const b = document.getElementById(id);
        if (!b) return;
        b.classList.remove('active-all', 'active-correct', 'active-wrong', 'active-skipped');
    });
    ['tdrfAllL', 'tdrfCorrectL', 'tdrfWrongL', 'tdrfSkippedL'].forEach(id => {
        const b = document.getElementById(id);
        if (!b) return;
        b.classList.remove('active-all', 'active-correct', 'active-wrong', 'active-skipped');
    });
    const allRfBtn = document.getElementById('tdrfAll');
    if (allRfBtn) allRfBtn.classList.add('active-all');
    const allRfBtnL = document.getElementById('tdrfAllL');
    if (allRfBtnL) allRfBtnL.classList.add('active-all');
    // Clear viewer
    const viewer = document.getElementById('tdQuestionViewer');
    if (viewer) viewer.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--text-faint)"><span class="spin"></span> Loading questions…</div>';

    try {
        questionsContainer.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-faint)"><span class="spin"></span> Loading questions…</div>';

        // For online tests, questions aren't in star-quiz bank — use stored questions if available
        if (isOnlineHistoryTest) {
            const storedQuestions = test.questions || [];
            const rawAnswersList = test.answers || [];

            if (!storedQuestions.length) {
                // Old history records without stored questions — show answer summary
                if (!rawAnswersList.length) {
                    questionsContainer.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-faint)">📝 No answer details available for this test.</div>';
                } else {
                    const c = test.result?.correct || 0, w = test.result?.wrong || 0, sk = test.result?.skipped || 0, tot = test.result?.total || rawAnswersList.length;
                    questionsContainer.innerHTML = `
                                <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px">
                                    <div style="font-size:0.75rem;color:var(--text-faint);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;font-weight:700">Answer Summary (${tot} Questions)</div>
                                    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:8px">
                                        ${rawAnswersList.map((item, i) => {
                        const sc = Array.isArray(item) ? String(item[2] || 's').charAt(0) : 's';
                        const color = sc === 'c' ? '#22c55e' : sc === 'w' ? '#ef4444' : 'var(--text-faint)';
                        const bg = sc === 'c' ? 'rgba(34,197,94,0.1)' : sc === 'w' ? 'rgba(239,68,68,0.1)' : 'var(--bg-card)';
                        const label = sc === 'c' ? '✓' : sc === 'w' ? '✗' : '—';
                        const ans = Array.isArray(item) ? String(item[1] || '').trim() : '';
                        const ansLabel = ans && ans !== '' && ans !== '-1' ? ['A', 'B', 'C', 'D'][parseInt(ans)] || ans : '';
                        return `<div style="background:${bg};border:1px solid ${color};border-radius:8px;padding:8px 6px;text-align:center">
                                                <div style="font-size:0.7rem;color:var(--text-faint)">Q${i + 1}</div>
                                                <div style="font-size:1rem;color:${color};font-weight:700">${label}</div>
                                                ${ansLabel ? `<div style="font-size:0.72rem;color:${color}">${ansLabel}</div>` : ''}
                                            </div>`;
                    }).join('')}
                                    </div>
                                </div>
                                <div style="text-align:center;padding:16px;color:var(--text-faint);font-size:0.82rem">
                                    💡 Detailed question review is only available for tests taken after the latest update.
                                </div>`;
                }
                if (qLabel) qLabel.textContent = `${test.result?.total || rawAnswersList.length} Questions`;
                return;
            }

            // We have stored questions — render full analysis just like star-quiz tests
            // Build answersByIndex map from raw answers
            const answersByIndex = new Map();
            rawAnswersList.forEach((item, fallbackIdx) => {
                if (!item) return;
                let qIdx = fallbackIdx, rawAnswer, rawStatus;
                if (Array.isArray(item)) {
                    // Compact format: [idx, answer, statusChar]
                    qIdx = item[0] ?? fallbackIdx; rawAnswer = item[1]; rawStatus = item[2];
                } else if (item && typeof item === 'object') {
                    // Object format from server: {idx, studentAnswer, status}
                    qIdx = item.idx ?? item.index ?? fallbackIdx;
                    rawAnswer = item.studentAnswer ?? item.answer ?? item.a ?? null;
                    rawStatus = item.status ?? item.s ?? '';
                } else {
                    rawAnswer = item; rawStatus = '';
                }
                const sc = String(rawStatus || 's').charAt(0).toLowerCase();
                let answerIdxs = null;
                const raw = String(rawAnswer ?? '').trim();
                if (raw !== '' && raw !== '-1' && raw !== 'null' && raw !== 'undefined') {
                    if (raw.includes(',')) answerIdxs = raw.split(',').map(v => parseInt(v.trim(), 10)).filter(n => !isNaN(n) && n >= 0);
                    else { const n = parseInt(raw, 10); if (!isNaN(n) && n >= 0) answerIdxs = [n]; }
                }
                const status = sc === 'c' ? 'correct' : sc === 'w' ? 'wrong' : (answerIdxs?.length ? 'attempted' : 'skipped');
                answersByIndex.set(parseInt(String(qIdx), 10), { storedIdx: parseInt(String(qIdx), 10), fallbackIdx, answerIdxs, status, rawAnswer: raw });
            });

            if (qLabel) qLabel.textContent = `QUESTION REVIEW · ${storedQuestions.length} QUESTIONS`;

            window._tdQuestions = storedQuestions.map((q, qi) => {
                const ans = answersByIndex.get(qi) || { status: 'skipped', answerIdxs: null, rawAnswer: '' };
                const isNum = _isNumericalQ(q);
                const rawAnsIdxs = ans.answerIdxs || [];
                const correctIdxs = q.isNoneCorrect ? [] : (Array.isArray(q.correctIndexes) ? q.correctIndexes : (typeof q.correctIndex === 'number' ? [q.correctIndex] : [0]));
                let answerIdxs, status;
                if (isNum) {
                    const rawAns = ans.rawAnswer || '';
                    const numAns = parseFloat(rawAns);
                    if (rawAns !== '' && !isNaN(numAns)) {
                        answerIdxs = [rawAns];
                        const numCorrect = parseFloat(q.numericalAnswer);
                        status = (!isNaN(numCorrect) && Math.abs(numAns - numCorrect) < 0.001) ? 'correct' : 'wrong';
                    } else {
                        answerIdxs = []; status = 'skipped';
                    }
                    return { q, qidx: qi, answerIdxs, correctIdxs: [String(q.numericalAnswer ?? q.correct_answer ?? 'N/A')], status };
                }
                const normalizeList = arr => [...new Set((arr || []).map(v => parseInt(v, 10)).filter(v => !isNaN(v) && v >= 0))].sort((a, b) => a - b);
                const ansNorm = normalizeList(rawAnsIdxs);
                const corrNorm = normalizeList(correctIdxs);
                const hasAttempt = ansNorm.length > 0;
                status = ans.status;
                if (!hasAttempt) { status = 'skipped'; }
                else if (status !== 'correct' && status !== 'wrong') {
                    const same = ansNorm.length === corrNorm.length && ansNorm.every((v, i) => v === corrNorm[i]);
                    status = same ? 'correct' : 'wrong';
                }
                return { q, qidx: qi, answerIdxs: ansNorm, correctIdxs, status };
            });

            window._tdCurrentFilter = 'all';
            window._tdCurrentQIdx = 0;
            tdBuildPalette();
            tdShowQuestion(0);
            tdUpdateFilterCounts();
            return;
        }

        const chapterParam = test.test?.chapter ? encodeURIComponent(test.test.chapter) : '_none_';
        // Normalize lecture: SQLite may return 3.0 for integer 3; strip trailing .0
        const rawLec = String(test.test?.lecture || '');
        const normLec = rawLec.match(/^\d+\.0$/) ? String(parseInt(rawLec)) : rawLec;
        const lectureParam = encodeURIComponent(normLec);
        const response = await fetch(`${API_BASE}/api/star-quiz/question/${chapterParam}/${lectureParam}`);
        if (!response.ok) {
            if (response.status === 404) {
                // Question bank not available, but show answer summary if we have answers
                const rawAnswersList = test.answers || [];
                if (!rawAnswersList.length) {
                    questionsContainer.innerHTML = `<div style="text-align:center;padding:48px 24px">
                                <div style="font-size:2.5rem;margin-bottom:14px">📭</div>
                                <div style="font-family:var(--font-head);font-size:1rem;font-weight:700;color:var(--text);margin-bottom:8px">Question bank not available</div>
                                <div style="color:var(--text-faint);font-size:0.82rem">The question set for this test may have been updated or removed. Your score and answers are still saved.</div>
                            </div>`;
                } else {
                    // Show answer summary fallback
                    const c = test.result?.correct || 0, w = test.result?.wrong || 0, sk = test.result?.skipped || 0, tot = test.result?.total || rawAnswersList.length;
                    questionsContainer.innerHTML = `
                                <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px">
                                    <div style="font-size:0.75rem;color:var(--text-faint);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;font-weight:700">Answer Summary (${tot} Questions)</div>
                                    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:8px">
                                        ${rawAnswersList.map((item, i) => {
                        const sc = Array.isArray(item) ? String(item[2] || 's').charAt(0) : 's';
                        const color = sc === 'c' ? '#22c55e' : sc === 'w' ? '#ef4444' : 'var(--text-faint)';
                        const bg = sc === 'c' ? 'rgba(34,197,94,0.1)' : sc === 'w' ? 'rgba(239,68,68,0.1)' : 'var(--bg-card)';
                        const label = sc === 'c' ? '✓' : sc === 'w' ? '✗' : '—';
                        const ans = Array.isArray(item) ? String(item[1] || '').trim() : '';
                        const ansLabel = ans && ans !== '' && ans !== '-1' ? ['A', 'B', 'C', 'D'][parseInt(ans)] || ans : '';
                        return `<div style="background:${bg};border:1px solid ${color};border-radius:8px;padding:8px 6px;text-align:center">
                                                <div style="font-size:0.7rem;color:var(--text-faint)">Q${i + 1}</div>
                                                <div style="font-size:1rem;color:${color};font-weight:700">${label}</div>
                                                ${ansLabel ? `<div style="font-size:0.72rem;color:${color}">${ansLabel}</div>` : ''}
                                            </div>`;
                    }).join('')}
                                    </div>
                                </div>
                                <div style="text-align:center;padding:16px;color:var(--text-faint);font-size:0.82rem">
                                    💡 The question set for this test may have been updated or removed. Your score and answers are still saved above.
                                </div>`;
                }
                if (qLabel) qLabel.textContent = `${test.result?.total || rawAnswersList.length} Questions`;
                return;
            }
            throw new Error(`Server returned ${response.status} while fetching question bank`);
        }
        const questionPack = await response.json();
        const questions = Array.isArray(questionPack.questions) ? questionPack.questions : [];

        if (!questions.length) {
            questionsContainer.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-faint)">No question details available for this test.</div>';
            return;
        }

        // visible debug banner
        const debugBanner = document.createElement('div');
        debugBanner.id = 'td-debug-banner';
        debugBanner.style.cssText = 'background:#1a1a2e;border:1px solid #f59e0b;border-radius:8px;padding:12px 14px;margin-bottom:12px;font-family:monospace;font-size:0.72rem;color:#fbbf24;white-space:pre-wrap;word-break:break-all';
        questionsContainer.prepend(debugBanner);

        // build answer map
        // Answers are stored as compact arrays: [questionIndex, studentAnswer, statusChar]
        // Key insight: always map by POSITION (array index) as primary strategy,
        // since the questions are fetched in the same order they were presented.
        const answersByIndex = new Map();
        const rawAnswersList = test.answers || [];

        function parseOneAnswer(item, fallbackIdx) {
            if (item === null || item === undefined) return null;
            let qIdx, rawAnswer, rawStatus;
            if (Array.isArray(item)) {
                // Compact format: [idx, answer, statusChar]
                qIdx = item[0];
                rawAnswer = item[1];
                rawStatus = item[2];
            } else if (typeof item !== 'object') {
                // Legacy format: primitive answer value in array position order
                qIdx = fallbackIdx;
                rawAnswer = item;
                rawStatus = '';
            } else {
                qIdx = item.idx ?? item.index ?? fallbackIdx;
                rawAnswer = item.studentAnswer ?? item.answer ?? item.a ?? null;
                rawStatus = item.status ?? item.s ?? 's';
            }
            const sc = String(rawStatus || 's').charAt(0).toLowerCase();

            let answerIdxs = null;
            const raw = String(rawAnswer ?? '').trim();
            const rawForNum = raw;
            if (raw !== '' && raw !== '-1' && raw !== 'null' && raw !== 'undefined') {
                if (raw.includes(',')) {
                    answerIdxs = raw.split(',').map(v => parseInt(v.trim(), 10)).filter(n => !isNaN(n) && n >= 0);
                } else {
                    const n = parseInt(raw, 10);
                    if (!isNaN(n) && n >= 0) answerIdxs = [n];
                }
            }
            const status = sc === 'c'
                ? 'correct'
                : sc === 'w'
                    ? 'wrong'
                    : (Array.isArray(answerIdxs) && answerIdxs.length > 0 ? 'attempted' : 'skipped');
            // Coerce stored idx to integer (handles BigInt/string)
            const storedIdx = parseInt(String(qIdx), 10);
            return { storedIdx, fallbackIdx, answerIdxs, status, rawAnswer: rawForNum };
        }

        // PRIMARY: map by array position (fallbackIdx). This is always reliable
        // because answers are stored in question order.
        rawAnswersList.forEach((item, fallbackIdx) => {
            const parsed = parseOneAnswer(item, fallbackIdx);
            if (!parsed) return;
            answersByIndex.set(fallbackIdx, { answerIdxs: parsed.answerIdxs, status: parsed.status, rawAnswer: parsed.rawAnswer });
        });

        // SECONDARY: if stored idx differs from position, also register by storedIdx
        // so lookups work either way.
        rawAnswersList.forEach((item, fallbackIdx) => {
            const parsed = parseOneAnswer(item, fallbackIdx);
            if (!parsed) return;
            if (!isNaN(parsed.storedIdx) && parsed.storedIdx !== fallbackIdx) {
                if (!answersByIndex.has(parsed.storedIdx)) {
                    answersByIndex.set(parsed.storedIdx, { answerIdxs: parsed.answerIdxs, status: parsed.status, rawAnswer: parsed.rawAnswer });
                }
            }
        });

        // debug
        console.group('🔍 Answer Debug');
        console.log('raw test.answers[0..2]:', JSON.stringify(rawAnswersList.slice(0, 3)));
        console.log('map size:', answersByIndex.size, '/ questions:', questions.length);
        answersByIndex.forEach((v, k) => console.log(`  Q${k}:`, v.status, v.answerIdxs));
        console.groupEnd();

        // Update visible debug banner
        let dbgLines = 'RAW answers[0..4]: ' + JSON.stringify(rawAnswersList.slice(0, 5));
        dbgLines += '\nMap entries (' + answersByIndex.size + ' / ' + questions.length + ' questions):';
        answersByIndex.forEach((v, k) => { dbgLines += '\n  [' + k + '] status=' + v.status + ' ans=' + JSON.stringify(v.answerIdxs); });
        if (answersByIndex.size === 0) dbgLines += '\n⚠ MAP IS EMPTY — answers not parsed!';
        debugBanner.textContent = dbgLines;

        const LTRS = ['A', 'B', 'C', 'D', 'E'];

        // build question data array for split-panel viewer
        window._tdQuestions = questions.map((q, qidx) => {
            const stored = answersByIndex.get(qidx) || { answerIdxs: null, status: 'skipped', rawAnswer: '' };
            const isNum = _isNumericalQ(q);
            let answerIdxs = stored.answerIdxs || [];
            let correctIdxs = q.isNoneCorrect ? [] : (q.correctIndexes || (q.correctIndex !== undefined ? [q.correctIndex] : [0]));
            let status = stored.status;
            if (isNum) {
                // For numerical: answerIdxs holds the raw numeric string
                const rawAns = stored.rawAnswer || '';
                const numAns = parseFloat(rawAns);
                if (rawAns !== '' && !isNaN(numAns)) {
                    answerIdxs = [rawAns]; // store raw string for display
                    const numCorrect = parseFloat(q.numericalAnswer);
                    if (!isNaN(numCorrect) && Math.abs(numAns - numCorrect) < 0.001) {
                        status = 'correct';
                    } else {
                        status = 'wrong';
                    }
                } else {
                    answerIdxs = [];
                    if (status !== 'correct' && status !== 'wrong') status = 'skipped';
                }
                correctIdxs = [String(q.numericalAnswer ?? q.correct_answer ?? 'N/A')];
            } else {
                const normalizeIndexList = (arr) => [...new Set((arr || []).map(v => parseInt(v, 10)).filter(v => !isNaN(v) && v >= 0))].sort((a, b) => a - b);
                const ansNorm = normalizeIndexList(answerIdxs);
                const corrNorm = normalizeIndexList(correctIdxs);
                const hasAttempt = ansNorm.length > 0;
                if (!hasAttempt) { status = 'skipped'; }
                else if (status !== 'correct' && status !== 'wrong') {
                    const same = ansNorm.length === corrNorm.length && ansNorm.every((v, i) => v === corrNorm[i]);
                    status = same ? 'correct' : 'wrong';
                }
                answerIdxs = ansNorm;
                correctIdxs = corrNorm;
            }
            return { q, qidx, answerIdxs, correctIdxs, status };
        });

        // Build palette and show first question
        window._tdCurrentFilter = 'all';
        window._tdCurrentQIdx = 0;
        tdBuildPalette();
        tdShowQuestion(0);
        tdUpdateFilterCounts();

    } catch (e) {
        console.error('openTestDetail error:', e);
        questionsContainer.innerHTML = `<div style="text-align:center;padding:40px;color:var(--error)">⚠ Failed to load question details.<br><span style="font-size:0.8rem;color:var(--text-faint)">${e.message}</span></div>`;
    }
}

function toggleSolution(card) {
    const sol = card.querySelector('.td-solution');
    if (!sol) return;
    const hidden = sol.classList.toggle('td-solution-hidden');
    if (!hidden && window.MathJax?.typesetPromise) {
        window.MathJax.typesetPromise([sol]).catch(() => { });
    }
}

/* ══ SPLIT-PANEL: Palette + Navigation ══ */

function tdGetFilteredIndices() {
    const qs = window._tdQuestions || [];
    const filter = window._tdCurrentFilter || 'all';
    return qs.map((d, i) => filter === 'all' || d.status === filter ? i : -1).filter(i => i >= 0);
}

function tdBuildPalette() {
    const grid = document.getElementById('tdPaletteGrid');
    if (!grid) return;
    const qs = window._tdQuestions || [];
    const filter = window._tdCurrentFilter || 'all';
    grid.innerHTML = qs.map((d, i) => {
        const palCls = d.status === 'correct' ? 'pal-correct' : d.status === 'wrong' ? 'pal-wrong' : 'pal-skipped';
        const isActive = i === window._tdCurrentQIdx ? ' pal-active' : '';
        const hidden = (filter !== 'all' && d.status !== filter) ? ' pal-hidden' : '';
        const LTRS = ['A', 'B', 'C', 'D', 'E'];
        const ansLabel = d.answerIdxs?.length ? d.answerIdxs.map(x => LTRS[x] || x).join(',') : '';
        return `<button class="td-palette-btn ${palCls}${isActive}${hidden}" onclick="tdJumpTo(${i})" title="Q${i + 1} · ${d.status}">
                    ${i + 1}
                    ${ansLabel ? `<span class="td-palette-btn-ans">${ansLabel}</span>` : ''}
                </button>`;
    }).join('');
}

function tdJumpTo(idx) {
    const qs = window._tdQuestions || [];
    if (idx < 0 || idx >= qs.length) return;
    window._tdCurrentQIdx = idx;
    tdShowQuestion(idx);
    tdBuildPalette();
    // Scroll palette btn into view
    const grid = document.getElementById('tdPaletteGrid');
    if (grid) {
        const btn = grid.children[idx];
        if (btn) btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function tdNavigate(dir) {
    const filtered = tdGetFilteredIndices();
    if (!filtered.length) return;
    const curPos = filtered.indexOf(window._tdCurrentQIdx);
    let nextPos;
    if (curPos === -1) {
        nextPos = dir > 0 ? 0 : filtered.length - 1;
    } else {
        nextPos = curPos + dir;
        if (nextPos < 0) nextPos = filtered.length - 1;
        if (nextPos >= filtered.length) nextPos = 0;
    }
    tdJumpTo(filtered[nextPos]);
}

function tdShowQuestion(idx) {
    const viewer = document.getElementById('tdQuestionViewer');
    if (!viewer) return;
    const qs = window._tdQuestions || [];
    const d = qs[idx];
    if (!d) { viewer.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-faint)">No question data.</div>'; return; }

    const { q, qidx, answerIdxs, correctIdxs, status } = d;
    const LTRS = ['A', 'B', 'C', 'D', 'E'];
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const isCorrect = status === 'correct';
    const isWrong = status === 'wrong';
    const isSkipped = status === 'skipped';
    const statusColor = isCorrect ? '#22c55e' : isWrong ? '#ef4444' : '#6b7280';
    const statusText = isCorrect ? '✓ Correct' : isWrong ? '✗ Wrong' : '— Not Attempted';
    const statusBg = isCorrect
        ? (isLight ? 'rgba(34,197,94,0.1)' : 'rgba(34,197,94,0.18)')
        : isWrong
            ? (isLight ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.16)')
            : (isLight ? 'rgba(107,114,128,0.08)' : 'rgba(107,114,128,0.1)');
    const statusBorder = isCorrect
        ? (isLight ? 'rgba(34,197,94,0.3)' : 'rgba(34,197,94,0.7)')
        : isWrong
            ? (isLight ? 'rgba(239,68,68,0.3)' : 'rgba(239,68,68,0.7)')
            : 'var(--border)';

    // Update pill in left header
    const pill = document.getElementById('tdCurrentStatusPill');
    if (pill) {
        pill.textContent = statusText;
        pill.style.background = statusBg;
        pill.style.color = statusColor;
        pill.style.borderColor = statusBorder;
    }

    // Counter
    const filtered = tdGetFilteredIndices();
    const posInFiltered = filtered.indexOf(idx) + 1;
    const counter = document.getElementById('tdNavCounter');
    if (counter) counter.textContent = `Q${idx + 1} · ${posInFiltered}/${filtered.length}`;

    // Prev/Next button state
    const btnPrev = document.getElementById('tdNavPrev'), btnNext = document.getElementById('tdNavNext');
    if (btnPrev) btnPrev.disabled = filtered.length <= 1;
    if (btnNext) btnNext.disabled = filtered.length <= 1;

    // Question image
    const qImg = q.questionImage || q.image || null;
    const qImgs = Array.isArray(q.questionImages) ? q.questionImages.filter(Boolean) : (qImg ? [qImg] : []);
    const qImgHtml = qImgs.length
        ? `<div class="td-q-images-wrapper" style="display:flex;flex-direction:column;gap:10px;align-items:center;margin-bottom:12px;width:100%">` +
        qImgs.map(img => {
            const mime = getMimeType(img);
            const src = img.startsWith('http') || img.startsWith('data:') ? img : `data:image/${mime};base64,${img}`;
            return `<div class="td-q-img" style="width:100%;margin:0"><img src="${src}" alt="" onerror="this.parentElement.style.display='none'"></div>`;
        }).join('') +
        `</div>`
        : '';

    // Tables / matrices attached to this question
    const _tdAllTables = _normalizeTablesField(q.tables);
    const _tdTablesIntro = _tdAllTables.filter(t => (t.position || 'after_intro') !== 'after_options');
    const _tdTablesOptions = _tdAllTables.filter(t => (t.position || 'after_intro') === 'after_options');
    const tdTablesIntroHtml = _tdTablesIntro.length ? renderTablesHtml(_tdTablesIntro) : '';
    const tdTablesOptionsHtml = _tdTablesOptions.length ? renderTablesHtml(_tdTablesOptions) : '';

    const isTdNumerical = _isNumericalQ(q);
    const _tdOptTables = _twGetOptionTables(q);
    const opts = (q.options && q.options.length) ? q.options : (_tdOptTables.some(Boolean) ? [null, null, null, null] : (q.options || []));
    const optsHtml = isTdNumerical ? '' : opts.map((opt, oi) => {
        const isPick = answerIdxs.includes(oi);
        const isRight = correctIdxs.includes(oi);
        let bg = 'var(--bg-input)', border = 'var(--border)', indicator = '', lblBg = 'var(--bg-input)', lblColor = 'var(--text-faint)';
        if (isRight) { bg = isLight ? 'rgba(34,197,94,0.1)' : 'rgba(34,197,94,0.18)'; border = isLight ? 'rgba(34,197,94,0.5)' : 'rgba(34,197,94,0.85)'; indicator = '✓'; lblBg = isLight ? 'rgba(34,197,94,0.2)' : 'rgba(34,197,94,0.3)'; lblColor = '#22c55e'; }
        if (isPick && !isRight) { bg = isLight ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.18)'; border = isLight ? 'rgba(239,68,68,0.5)' : 'rgba(239,68,68,0.85)'; indicator = '✗'; lblBg = isLight ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.3)'; lblColor = '#ef4444'; }
        if (isPick && isRight) { bg = isLight ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.24)'; border = isLight ? 'rgba(34,197,94,0.6)' : '#22c55e'; indicator = '✓'; lblBg = isLight ? 'rgba(34,197,94,0.28)' : 'rgba(34,197,94,0.38)'; lblColor = '#22c55e'; }
        const optImg = q.optionImages?.[oi];
        const optImgHtml = optImg ? `<img src="${optImg.startsWith('http') || optImg.startsWith('data:') ? optImg : 'data:image/' + getMimeType(optImg) + ';base64,' + optImg}" style="max-width:100%;max-height:100px;object-fit:contain;margin-top:6px;border-radius:5px;display:block" onerror="this.style.display='none'">` : '';
        const optTbl = _tdOptTables[oi] || null;
        const optBody = optTbl ? _twRenderSingleTable(optTbl) : (optImg ? optImgHtml : mdTablesToHtml(opt || ''));
        return `<div class="td-opt" style="background:${bg};border-color:${border}">
                    <span class="td-opt-lbl" style="background:${lblBg};color:${lblColor}">${LTRS[oi]}</span>
                    <span class="td-opt-text">${optBody}</span>
                    ${indicator ? `<span style="font-weight:700;color:${isRight ? '#22c55e' : '#ef4444'};flex-shrink:0;font-size:1rem">${indicator}</span>` : ''}
                </div>`;
    }).join('');

    const yourAnsText = isTdNumerical
        ? (answerIdxs.length ? escHtml(String(answerIdxs[0])) : 'Not Attempted')
        : (answerIdxs.length ? answerIdxs.map(i => LTRS[i] || i).join(', ') : 'Not Attempted');
    const correctAnsText = isTdNumerical
        ? escHtml(String(q.numericalAnswer ?? q.correct_answer ?? 'N/A'))
        : (q.isNoneCorrect ? 'None is correct' : correctIdxs.map(i => LTRS[i] || i).join(', '));
    const yourAnsColor = isSkipped ? 'var(--text-faint)' : isCorrect ? '#22c55e' : '#ef4444';

    // Solution — always visible (no tap needed)
    const solutionItems = Array.isArray(q.solutions) && q.solutions.length ? q.solutions
        : (q.solution ? [{ text: String(q.solution) }] : []);
    const hasSolution = solutionItems.some(s => s && (s.text || s.image || (Array.isArray(s.images) && s.images.length) || (Array.isArray(q.solutionImages) && q.solutionImages.length)));
    const solInnerHtml = hasSolution ? solutionItems.filter(Boolean).map(s => {
        const solText = s.text ? `<div class="td-solution-text">${escHtml(normalizeSolutionForDisplay(s.text))}</div>` : '';
        const solImgs = Array.isArray(s.images) ? s.images.filter(Boolean) : (s.image ? [s.image] : (Array.isArray(q.solutionImages) ? q.solutionImages.filter(Boolean) : []));
        const solImgHtml = solImgs.map(img => {
            const mime = getMimeType(img);
            const src = img.startsWith('http') || img.startsWith('data:') ? img : `data:image/${mime};base64,${img}`;
            return `<img src="${src}" style="max-width:100%;border-radius:8px;margin-top:8px;display:block" onerror="this.style.display='none'">`;
        }).join('');
        return solText + solImgHtml;
    }).join('') : '';
    const solutionBlock = hasSolution
        ? `<div class="td-solution-block">
                    <div class="td-solution-label">💡 SOLUTION</div>
                    ${solInnerHtml}
                   </div>`
        : '';

    // Subject chip
    const subjectChip = q.subject ? `<span class="td-q-subject-chip">${escHtml(q.subject)}</span>` : '';

    viewer.innerHTML = `
                <div class="td-q-number">
                    Q${qidx + 1} of ${qs.length}
                    ${subjectChip}
                </div>
                <div class="td-q-text">${mdTablesToHtml(q.question || 'N/A')}</div>
                ${tdTablesIntroHtml}
                ${qImgHtml}
                <div style="margin:16px 0">${optsHtml || (isTdNumerical ? '<div style="padding:20px;text-align:center;background:rgba(251,191,36,0.08);border:1.5px dashed rgba(251,191,36,0.3);border-radius:12px;color:var(--text-faint);font-size:0.9rem">🔢 Numerical answer question</div>' : '')}</div>
                ${tdTablesOptionsHtml}
                <div class="td-ans-grid">
                    <div class="td-ans-box" style="background:var(--bg-input);border:1px solid var(--border)">
                        <div class="td-ans-box-lbl">Your Answer</div>
                        <div class="td-ans-box-val" style="color:${yourAnsColor}">${yourAnsText}</div>
                    </div>
                    <div class="td-ans-box" style="background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.25);border-left:3px solid #22c55e">
                        <div class="td-ans-box-lbl">Correct Answer</div>
                        <div class="td-ans-box-val" style="color:#22c55e">${correctAnsText}</div>
                    </div>
                </div>
                ${solutionBlock}
            `;

    // MathJax typeset
    if (window.MathJax?.typesetPromise) {
        window.MathJax.typesetPromise([viewer]).catch(() => { });
    }
    // Scroll left panel to top
    viewer.scrollTop = 0;
}

function tdUpdateFilterCounts() {
    const qs = window._tdQuestions || [];
    const total = qs.length;
    const correct = qs.filter(d => d.status === 'correct').length;
    const wrong = qs.filter(d => d.status === 'wrong').length;
    const skipped = qs.filter(d => d.status === 'skipped').length;
    const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    // Right panel counts
    el('tdrfAllCount', total);
    el('tdrfCorrectCount', correct);
    el('tdrfWrongCount', wrong);
    el('tdrfSkippedCount', skipped);
    // Left panel filter bar counts
    el('tdrfAllCountL', total);
    el('tdrfCorrectCountL', correct);
    el('tdrfWrongCountL', wrong);
    el('tdrfSkippedCountL', skipped);
}

// Sync active state on left panel filter buttons
function syncFilterBtns(filter) {
    ['tdrfAllL', 'tdrfCorrectL', 'tdrfWrongL', 'tdrfSkippedL'].forEach(id => {
        const b = document.getElementById(id);
        if (!b) return;
        b.classList.remove('active-all', 'active-correct', 'active-wrong', 'active-skipped');
    });
    const classMap = { all: 'active-all', correct: 'active-correct', wrong: 'active-wrong', skipped: 'active-skipped' };
    const targetId = { all: 'tdrfAllL', correct: 'tdrfCorrectL', wrong: 'tdrfWrongL', skipped: 'tdrfSkippedL' };
    const btn = document.getElementById(targetId[filter]);
    if (btn) btn.classList.add(classMap[filter] || 'active-all');
}

function setTdPaletteFilter(filter, btn) {
    window._tdCurrentFilter = filter;
    // Update right panel button styles
    ['tdrfAll', 'tdrfCorrect', 'tdrfWrong', 'tdrfSkipped'].forEach(id => {
        const b = document.getElementById(id);
        if (!b) return;
        b.classList.remove('active-all', 'active-correct', 'active-wrong', 'active-skipped');
    });
    const classMap = { all: 'active-all', correct: 'active-correct', wrong: 'active-wrong', skipped: 'active-skipped' };
    // Only add class if btn is one of the right panel buttons
    const rightIds = ['tdrfAll', 'tdrfCorrect', 'tdrfWrong', 'tdrfSkipped'];
    if (btn && rightIds.includes(btn.id)) {
        btn.classList.add(classMap[filter] || 'active-all');
    } else {
        // btn is from left panel — still update right panel
        const rightMap = { all: 'tdrfAll', correct: 'tdrfCorrect', wrong: 'tdrfWrong', skipped: 'tdrfSkipped' };
        const rb = document.getElementById(rightMap[filter]);
        if (rb) rb.classList.add(classMap[filter] || 'active-all');
    }
    // Always sync left panel buttons
    syncFilterBtns(filter);

    // Re-build palette (palette buttons will show/hide based on filter)
    tdBuildPalette();

    // Navigate to first visible question in new filter
    const filtered = tdGetFilteredIndices();
    if (filtered.length > 0) {
        // If current q is in filter keep it, else jump to first
        if (!filtered.includes(window._tdCurrentQIdx)) {
            window._tdCurrentQIdx = filtered[0];
            tdShowQuestion(filtered[0]);
        }
        const counter = document.getElementById('tdNavCounter');
        if (counter) {
            const pos = filtered.indexOf(window._tdCurrentQIdx) + 1;
            counter.textContent = `Q${window._tdCurrentQIdx + 1} · ${pos}/${filtered.length}`;
        }
    }
}

// Keep legacy setTdFilter for any residual callers
function setTdFilter(filter, btn) { setTdPaletteFilter(filter, btn); }

function normalizeSolutionForDisplay(text) {
    // The solution text uses "\n" as an escaped-newline marker, but LaTeX
    // also has commands that start with a literal "\n" (\neq, \nabla, \nu,
    // \ne, \notin, \node, \newcommand, ...). A plain /\\n/g replace turns
    // "\neq" into a newline followed by the leftover letters "eq" — which
    // is exactly how "≠" became the stray "eq0" text seen in the UI.
    // Guard against that by skipping the replacement only when the "\n"
    // is actually the start of one of these known LaTeX macros.
    // "\nu_0" must survive: inside a math span a "\n" is always a LaTeX macro,
    // never an escaped newline. Only rewrite \n outside math spans.
    const latexNMacros = /^(?:u|i|eq|e\b|abla|otin|ot|ode|ewcommand|ewline|equiv|onumber|olimits|exists|subseteq|parallel|mid|cong|sim|rightarrow|leftarrow|Rightarrow|Leftarrow|leq|geq|prec|succ)/;
    const mathRe = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\r\n]*?\$)/g;
    const src = String(text || '');
    const plain = (t) => t.replace(/\\n([a-zA-Z]*)/g, (m, r) => latexNMacros.test(r) ? m : '\n' + r);
    let out = '', last = 0, mm;
    while ((mm = mathRe.exec(src)) !== null) {
        if (mm.index > last) out += plain(src.slice(last, mm.index));
        out += mm[0].replace(/[\r\n]+/g, ' ');
        last = mm.index + mm[0].length;
    }
    if (last < src.length) out += plain(src.slice(last));
    return out.trim();
}

function getMimeType(b64) {
    if (!b64) return 'jpeg';
    if (b64.startsWith('PHN2Zy')) return 'svg+xml'; // base64 "<svg "
    if (b64.startsWith('/9j/')) return 'jpeg';
    if (b64.startsWith('iVBORw')) return 'png';
    if (b64.startsWith('R0lGOD')) return 'gif';
    return 'jpeg';
}

/* Helper functions for test analysis */
function formatStudentAnswer(ans) {
    if (ans === null || ans === undefined) return 'Not Attempted';
    if (ans === -1) return 'Not Answered';
    if (Array.isArray(ans)) {
        return ans.length === 0 ? 'Not Answered' : ans.map(i => String.fromCharCode(65 + i)).join(', ');
    }
    if (typeof ans === 'string' && ans.includes(',')) {
        return ans.split(',').map(v => String.fromCharCode(65 + Number(v.trim()))).join(', ');
    }
    if (typeof ans === 'string' && ans.trim() === '') return 'Not Attempted';
    return String.fromCharCode(65 + ans);
}

function formatCorrectAnswer(indices) {
    if (!Array.isArray(indices)) return String.fromCharCode(65 + indices);
    return indices.map(i => String.fromCharCode(65 + i)).join(', ');
}

function formatTime(sec) {
    if (!sec) return '—';
    const hours = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = sec % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
}

/* ══ MY DETAILS (read-only) ══
   Students can look but not touch — the institute owns every field, and the
   password is deliberately never rendered. */
function showEditProfile() {
    if (!_student) return;

    // Section may be its own field, or baked into a className like "12 - A".
    let classVal = _student.className || '';
    let divVal = _student.section || _student.division || '';
    if (!divVal && classVal && classVal.includes('-')) {
        const parts = classVal.split('-').map(s => s.trim());
        if (parts.length > 1) {
            divVal = parts.pop();
            classVal = parts.join(' - ');
        }
    }

    const esc = v => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const dash = v => (v === 0 || v) && String(v).trim() !== '' ? String(v) : '—';
    const cell = (k, v, wide) =>
        '<div class="ro-item' + (wide ? ' wide' : '') + '"><div class="k">' + esc(k) + '</div>' +
        '<div class="v">' + esc(dash(v)) + '</div></div>';

    let dob = _student.dateOfBirth || '';
    if (dob && /^\d{4}-\d{2}-\d{2}/.test(dob)) {
        const d = new Date(dob);
        if (!isNaN(d)) dob = d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
    }

    const grid = document.getElementById('myDetailsGrid');
    if (grid) {
        grid.innerHTML =
            cell('Full Name', _student.name, true) +
            cell('Email', _student.email, true) +
            cell('Class', classVal) +
            cell('Section', divVal) +
            cell('Phone', _student.phone) +
            cell('Date of Birth', dob) +
            cell('Institute', _student.instituteName);
    }

    showScreen('edit');
    setActiveNav('edit');
}

async function updateProfile() {
    const name = document.getElementById('eName').value.trim();
    const btn = document.getElementById('editBtn');
    if (!name) { showMsg('editMsg', 'err', 'Name is required.'); shake('eName'); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Saving…';
    try {
        const rawClass = document.getElementById('eClass').value.trim();
        const division = (document.getElementById('eDivision')?.value || '').trim().toUpperCase();
        const classWithDiv = rawClass && division ? `${rawClass} - ${division}` : (rawClass || division || '');
        const r = await fetch(`${API_BASE}/api/student/update-profile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token}` },
            body: JSON.stringify({
                name,
                className: classWithDiv,
                division: division,
                phone: document.getElementById('ePhone').value.trim(),
                age: document.getElementById('eAge').value.trim(),
                dateOfBirth: document.getElementById('eDob').value.trim()
            })
        });
        const data = await r.json();
        if (!r.ok) { showMsg('editMsg', 'err', data.error || 'Failed to update.'); return; }
        _student.name = name;
        _student.className = classWithDiv;
        _student.division = division;
        _student.phone = document.getElementById('ePhone').value.trim();
        _student.age = document.getElementById('eAge').value.trim();
        _student.dateOfBirth = document.getElementById('eDob').value.trim();
        showMsg('editMsg', 'ok', 'Profile updated!');
        setTimeout(() => { showScreen('dashboard'); loadDashboard(); }, 900);
    } catch (e) { showMsg('editMsg', 'err', 'Connection error.'); }
    finally { btn.disabled = false; btn.textContent = 'Save Changes'; }
}

/* ══ BACK TO ROLE CHOOSER (student / teacher login selection) ══ */
// The login screen "← Back" button returns the user to the institute panel's
// role-chooser page (Student / Teacher).
// Returns the user to the institute panel (role chooser).
// The panel can reach this portal two ways:
//   1. embedded in an <iframe>  → tell the parent via postMessage
//   2. window.location.href = 'test_window.html' (what institute.html actually
//      does) → this is a normal page load, so we must navigate back ourselves.
// Returns true when a return path was taken.
function _returnToInstitutePanel() {
    let cameFromPanel = false;
    try { cameFromPanel = !!localStorage.getItem('inst_role'); } catch (_) { }
    try {
        localStorage.removeItem('inst_role');
        localStorage.removeItem('gp_active_role');
    } catch (_) { }

    // 1) Embedded inside institute.html
    if (window.parent && window.parent !== window) {
        try { window.parent.postMessage({ type: 'gp-student-logout' }, '*'); return true; }
        catch (_) { /* fall through to navigation */ }
    }

    // 2) Navigated here from the institute panel — go back to it.
    let ref = '';
    try { ref = document.referrer || ''; } catch (_) { }
    if (/institute\.html/i.test(ref)) {
        window.location.replace(ref.split('#')[0]);
        return true;
    }
    if (cameFromPanel) {
        const base = String(location.pathname || '').replace(/[^/]*$/, '');
        window.location.replace(base + 'institute.html');
        return true;
    }
    return false; // opened standalone (direct student link)
}

// Hide the "← Back" button when there is no institute panel to go back to
// (portal opened directly by a student rather than from the panel).
(function _syncLoginBackBtn() {
    const btn = document.getElementById('loginBackBtn');
    if (!btn) return;
    const embedded = !!(window.parent && window.parent !== window);
    let cameFromPanel = false;
    try { cameFromPanel = !!localStorage.getItem('inst_role'); } catch (_) { }
    let ref = '';
    try { ref = document.referrer || ''; } catch (_) { }
    if (!embedded && !cameFromPanel && !/institute\.html/i.test(ref)) {
        btn.style.display = 'none';
    }
})();

function backToRoleChooser() {
    // Clear any half-entered login state.
    _token = ''; _student = null;
    try {
        localStorage.removeItem('gp_student_token');
        localStorage.removeItem('gp_pending_roll');
        localStorage.removeItem('gp_active_role');
    } catch (_) { }
    ['loginEmailInput', 'signupEmailInput', 'loginPwInput'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    if (typeof setAuthMode === 'function') setAuthMode('login');

    if (_returnToInstitutePanel()) return;
    // Standalone fallback ��� just show the login screen.
    showScreen('login');
}

/* ══ LOGOUT ══ */
async function doLogout() {
    closeLogoutPopup();
    try { await fetch(`${API_BASE}/api/student/logout`, { method: 'POST', headers: { Authorization: `Bearer ${_token}` } }); } catch (_) { }
    _token = ''; _student = null;
    localStorage.removeItem('gp_student_token');
    localStorage.removeItem('gp_pending_roll');
    localStorage.removeItem('inst_role');
    // Drop the previous student's institute branding so the next person to sign
    // in on this browser never sees another institute's logo or name.
    _clearBrandCache();
    document.title = 'Student Portal';
    const brandNameEl = document.getElementById('sidebarBrandName') || document.querySelector('.sidebar-brand-name');
    if (brandNameEl) brandNameEl.textContent = 'Student Portal';
    const brandSubEl = document.querySelector('.sidebar-brand-sub');
    if (brandSubEl) brandSubEl.textContent = 'Student Portal v2';
    const mobBrandNameEl = document.getElementById('authMobileBrandName');
    if (mobBrandNameEl) mobBrandNameEl.textContent = 'Student Portal';
    const footerSpanEl = document.getElementById('footerBrandSpan') || document.querySelector('.main-footer span');
    if (footerSpanEl) footerSpanEl.textContent = 'Student Portal v2';
    applyInstituteFavicon('');
    applyInstituteLogoMarks('', '');
    // Re-resolve the portal-link institute so the sign-in screen still shows
    // the correct institute's logo (never the previous student's).
    resolveInstituteBranding();
    ['loginEmailInput', 'signupEmailInput', 'loginPwInput'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    if (typeof setAuthMode === 'function') setAuthMode('login');

    // If the user arrived from the institute panel (embedded or via a normal
    // navigation), logging out should return them to the panel's role chooser
    // — NOT to this portal's own student login screen.
    if (_returnToInstitutePanel()) return;
    showScreen('login');
}

/* ══ UTILS ══ */
function showMsg(id, type, text) { const el = document.getElementById(id); if (!el) return; el.className = `msg ${type}`; el.textContent = text; el.style.display = ''; }
function shake(id) { const el = document.getElementById(id); if (!el) return; el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 400); }
function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/* ══════════════════════════════════════════════════════════════════
   TABLE / MATRIX RENDERING
   Questions may carry a `tables` array. Each table:
     { position, headers: string[], rows: string[][], caption? }
   Cell text can contain inline $...$ LaTeX — escaped here and typeset
   by MathJax when typesetPromise() runs on the enclosing container.
════════════════════════════════��═════════════════════════════════ */
// A table cell may be a plain string OR an image-cell object
// { text, image, imageNeeded }. _twNormCell keeps image cells intact.
function _twIsImgCell(c) {
    return c && typeof c === 'object' && !Array.isArray(c) && ('image' in c || 'svg' in c || c.imageNeeded === true || c.image_needed === true);
}
function _twNormCell(c) {
    if (_twIsImgCell(c)) {
        // An AI-drawn cell carries `svg` markup instead of a pasted raster.
        const raw = c.svg != null ? String(c.svg) : (c.image != null ? String(c.image) : null);
        return { text: String(c.text ?? c.caption ?? ''), image: raw };
    }
    return String(c ?? '');
}
function _twCellImgSrc(img) {
    if (!img) return '';
    // Inline SVG markup → render through a sandboxed <img src="data:…"> so no
    // script inside the SVG can ever execute.
    if (/<svg[\s>]/i.test(img)) {
        return (typeof vySvgToDataUri === 'function' && vySvgToDataUri(img))
            || ('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(img));
    }
    if (img.startsWith('http') || img.startsWith('data:')) return img;
    const mime = img.startsWith('/9j/') ? 'image/jpeg' : img.startsWith('iVBOR') ? 'image/png' : img.startsWith('R0lGOD') ? 'image/gif' : 'image/jpeg';
    return `data:${mime};base64,${img}`;
}
function _twRenderCell(c) {
    if (c && typeof c === 'object' && !Array.isArray(c)) {
        if (c.image) {
            const cap = c.text ? `<div style="font-size:0.7rem;opacity:0.7;margin-top:2px">${escHtml(c.text)}</div>` : '';
            return `<img src="${_twCellImgSrc(String(c.image))}" style="max-width:130px;max-height:100px;object-fit:contain;display:block;margin:0 auto;border-radius:4px">${cap}`;
        }
        return escHtml(String(c.text || ''));
    }
    return escHtml(c ?? '');
}
function _normalizeTablesField(tables) {
    if (!tables) return [];
    const arr = Array.isArray(tables) ? tables : [tables];
    const out = [];
    arr.forEach(t => {
        if (!t || typeof t !== 'object') return;
        const headers = Array.isArray(t.headers) ? t.headers.map(h => _twNormCell(h)) : [];
        const rows = Array.isArray(t.rows)
            ? t.rows.filter(r => Array.isArray(r)).map(r => r.map(c => _twNormCell(c)))
            : [];
        if (!headers.length && !rows.length) return;
        const obj = {
            position: (typeof t.position === 'string' && t.position.trim()) ? t.position.trim() : 'after_intro',
            headers, rows
        };
        if (t.caption && String(t.caption).trim()) obj.caption = String(t.caption).trim();
        out.push(obj);
    });
    return out;
}

// Render ONE table object (used for per-option tables).
function _twRenderSingleTable(t) {
    const list = _normalizeTablesField([t]);
    if (!list.length) return '';
    return renderTablesHtml(list);
}
// Per-option tables: read q.optionTables[oi] or tables with position option_x.
const _TW_OPT_POS = { option_a: 0, option_b: 1, option_c: 2, option_d: 3, option_1: 0, option_2: 1, option_3: 2, option_4: 3 };
function _twGetOptionTables(q) {
    const out = [null, null, null, null];
    if (q && Array.isArray(q.optionTables)) {
        for (let i = 0; i < 4; i++) if (q.optionTables[i]) out[i] = q.optionTables[i];
    }
    const raw = q && q.tables ? (Array.isArray(q.tables) ? q.tables : [q.tables]) : [];
    raw.forEach(t => {
        if (!t || typeof t !== 'object') return;
        const pos = String(t.position || '').trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(_TW_OPT_POS, pos)) {
            const slot = _TW_OPT_POS[pos];
            if (!out[slot]) out[slot] = t;
        }
    });
    return out;
}

// Returns an HTML string for one or more tables. Call MathJax typeset on
// the container afterwards so inline math inside cells gets rendered.
function renderTablesHtml(tables) {
    const list = _normalizeTablesField(tables);
    if (!list.length) return '';
    return list.map(tbl => {
        let colCount = (tbl.headers || []).length;
        (tbl.rows || []).forEach(r => { colCount = Math.max(colCount, r.length); });
        if (!colCount) return '';
        let html = `<div class="q-data-table-wrap"><table class="q-data-table">`;
        if (tbl.headers && tbl.headers.length) {
            html += `<thead><tr>`;
            for (let c = 0; c < colCount; c++) {
                html += `<th>${_twRenderCell(tbl.headers[c] ?? '')}</th>`;
            }
            html += `</tr></thead>`;
        }
        html += `<tbody>`;
        (tbl.rows || []).forEach(r => {
            html += `<tr>`;
            for (let c = 0; c < colCount; c++) {
                html += `<td>${_twRenderCell(r[c] ?? '')}</td>`;
            }
            html += `</tr>`;
        });
        html += `</tbody></table>`;
        if (tbl.caption) html += `<div class="q-data-table-caption">${escHtml(tbl.caption)}</div>`;
        html += `</div>`;
        return html;
    }).join('');
}

/* ══════════════════════════════════════════════════════════════════
   MARKDOWN PIPE-TABLE RENDERING
   AI-extracted questions frequently embed tables/matrices directly in
   the question text, option text or solution text as GitHub-style
   markdown pipe tables, e.g.

       | List I | List II |
       | --- | --- |
       | A | 1 |
       | B | 2 |

   These were previously dumped verbatim via innerHTML and showed up as
   raw "| ... |" text. mdTablesToHtml() finds such blocks anywhere in a
   string and converts them into the same styled .q-data-table markup
   used for structured tables, leaving all surrounding text untouched.
   Inline $...$ LaTeX inside cells is preserved so MathJax can typeset
   it when typesetPromise() runs on the container.
══════════════════════════════════════════════════════════════════ */
function _looksLikeMdTableRow(line) {
    const t = line.trim();
    // Must contain at least one pipe and not be a code fence
    return t.indexOf('|') !== -1 && t.length > 0;
}
function _isMdSeparatorRow(line) {
    // e.g. | --- | :---: | --- |  (dashes, optional colons, pipes, spaces)
    const t = line.trim().replace(/^\||\|$/g, '');
    if (t.indexOf('-') === -1) return false;
    return /^[\s|:-]+$/.test(line.trim()) && /-/.test(line);
}
function _splitMdRow(line) {
    let t = line.trim();
    // Strip a single leading/trailing pipe (so we don't get empty edge cells)
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    // Split on pipes that are NOT escaped (\|)
    const cells = [];
    let cur = '';
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (ch === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
        if (ch === '|') { cells.push(cur); cur = ''; continue; }
        cur += ch;
    }
    cells.push(cur);
    return cells.map(c => c.trim());
}
// Build one HTML table from header cells + body rows (already split).
function _mdTableToHtml(headerCells, bodyRows) {
    let colCount = headerCells.length;
    bodyRows.forEach(r => { colCount = Math.max(colCount, r.length); });
    if (!colCount) return '';
    let html = `<div class="q-data-table-wrap"><table class="q-data-table">`;
    if (headerCells.length) {
        html += `<thead><tr>`;
        for (let c = 0; c < colCount; c++) html += `<th>${escHtml(headerCells[c] ?? '')}</th>`;
        html += `</tr></thead>`;
    }
    html += `<tbody>`;
    bodyRows.forEach(r => {
        html += `<tr>`;
        for (let c = 0; c < colCount; c++) html += `<td>${escHtml(r[c] ?? '')}</td>`;
        html += `</tr>`;
    });
    html += `</tbody></table></div>`;
    return html;
}
// Scan a block of text and replace every markdown table with HTML.
// Non-table text is returned unchanged (NOT escaped) so existing inline
// HTML / LaTeX in the surrounding content keeps working as before.
function mdTablesToHtml(text) {
    if (text == null) return '';
    const src = String(text);
    if (src.indexOf('|') === -1) return src; // fast path: no tables possible
    const lines = src.split(/\r?\n/);
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const next = lines[i + 1];
        // A markdown table = a header row, then a separator row, then >=1 body rows
        if (next !== undefined && _looksLikeMdTableRow(line) && line.indexOf('|') !== -1 && _isMdSeparatorRow(next)) {
            const headerCells = _splitMdRow(line);
            const bodyRows = [];
            let j = i + 2;
            while (j < lines.length && lines[j].trim().indexOf('|') !== -1 && lines[j].trim() !== '') {
                bodyRows.push(_splitMdRow(lines[j]));
                j++;
            }
            out.push(_mdTableToHtml(headerCells, bodyRows));
            i = j;
            continue;
        }
        out.push(line);
        i++;
    }
    return out.join('\n');
}