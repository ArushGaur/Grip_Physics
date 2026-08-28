/* ══════════════════════════════════════════════════════════════════
           CHAPTERS
        ══════════════════════════════════════════════════════════════════ */
async function loadChaptersAdmin() {
    try {
        const r = await fetch(`${API_BASE}/api/chapters`, { credentials: "include" });
        if (!r.ok) { console.error("Failed to load chapters:", r.status); return; }
        const chs = await r.json();
        console.log("Chapters loaded:", chs.length);
        ["existingChapters", "existingChapters2"].forEach(id => {
            const dl = document.getElementById(id);
            if (dl) dl.innerHTML = chs.map(c => `<option value="${c}">`).join("");
        });
        const dc = document.getElementById("drillChapter");
        if (dc) dc.innerHTML = '<option value="">— All —</option>' + chs.map(c => `<option value="${c}">${c}</option>`).join("");
    } catch (e) { console.error("Error loading chapters:", e); }
}


/* ══════════════════════════════════════════════════════════════════
   MANUAL ADD QUESTION
══════════════════════════════════════════════════════════════════ */
function addManualQuestion(data) {
    const container = document.getElementById("aqQuestionsContainer");
    if (!container) return;
    manualQuestionCount++;
    const id = `mq_${manualQuestionCount}`;
    const div = document.createElement("div");
    div.className = "panel";
    div.id = id;
    div.style.cssText = "background:var(--bg-input);margin-bottom:12px;";
    const isMulti = data && data.isMultiCorrect;
    div.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
                <strong style="font-size:0.88rem">Question ${container.children.length + 1}</strong>
                <div style="display:flex;gap:8px;align-items:center">
                    <label style="font-size:0.8rem;color:var(--text-dim);display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input type="checkbox" class="mq-multi" ${isMulti ? "checked" : ""} style="width:auto;padding:0"> Multi-correct
                    </label>
                    <button class="btn btn-danger" style="padding:5px 10px;font-size:0.76rem" onclick="this.closest('.panel').remove()">Remove</button>
                </div>
            </div>
            <div class="field"><label>Question Text ($math$ for equations)</label><textarea class="mq-text" placeholder="Enter question..." rows="2">${data ? data.question : ""}</textarea></div>
            <div class="options-grid">
                ${LETTERS.map((l, i) => `<div class="field"><label>Option ${l}</label><input class="mq-opt" data-idx="${i}" placeholder="Option ${l}" value="${data && data.options ? data.options[i] || "" : ""}"></div>`).join("")}
            </div>
            <div class="field" id="${id}_cw">
                <label class="single-lbl">Correct Answer</label>
                <select class="mq-correct admin-select">
                    ${LETTERS.map((l, i) => `<option value="${i}" ${data && !isMulti && (data.correctIndexes ? data.correctIndexes[0] === i : data.correctIndex === i) ? "selected" : ""}>${l}</option>`).join("")}
                </select>
                <div class="multi-lbl" style="display:none">
                    <label style="font-size:0.78rem;color:var(--text-dim)">Correct Answers (check all):</label>
                    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px">
                        ${LETTERS.map((l, i) => `<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:0.85rem"><input type="checkbox" class="mq-multi-correct" value="${i}" ${data && isMulti && data.correctIndexes && data.correctIndexes.includes(i) ? "checked" : ""}> ${l}</label>`).join("")}
                    </div>
                </div>
            </div>`;
    container.appendChild(div);
    div.querySelector(".mq-multi").addEventListener("change", function () {
        const w = div.querySelector(`#${id}_cw`);
        w.querySelector(".single-lbl").style.display = this.checked ? "none" : "block";
        w.querySelector("select.mq-correct").style.display = this.checked ? "none" : "block";
        w.querySelector(".multi-lbl").style.display = this.checked ? "block" : "none";
    });
    if (isMulti) div.querySelector(".mq-multi").dispatchEvent(new Event("change"));
}
addManualQuestion();

async function saveManualQuestions() {
    const chapter = document.getElementById("aq-chapter").value.trim();
    const topic = document.getElementById("aq-topic")?.value.trim() || "";
    if (!chapter) { showErrorModal("Please enter chapter.", "Missing fields"); return; }
    const lecture = "";
    const questions = [];
    document.querySelectorAll("#aqQuestionsContainer .panel").forEach(b => {
        const text = b.querySelector(".mq-text").value.trim();
        const opts = [...b.querySelectorAll(".mq-opt")].map(i => i.value.trim());
        const isMulti = b.querySelector(".mq-multi").checked;
        let ci;
        if (isMulti) {
            ci = [...b.querySelectorAll(".mq-multi-correct:checked")].map(c => parseInt(c.value));
        } else {
            ci = [parseInt(b.querySelector(".mq-correct").value)];
        }
        if (text && opts.every(o => o) && ci.length) questions.push({ question: text, options: opts, correctIndexes: ci, isMultiCorrect: isMulti });
    });
    if (!questions.length) { showErrorModal("Please fill at least one complete question.", "Incomplete data"); return; }
    await submitQuestions(chapter, lecture, questions, false, topic);
}


/* ══════════════════════════════════════════════════════════════════
MANAGE QUESTIONS
══════════════════════════════════════════════════════════════════ */

// Cache of fully-loaded rows: _id -> full row with questions[]
const _loadedRowCache = {};
// In-flight promises to avoid duplicate fetches
const _loadingRowPromises = {};

// Fetch a single row's full data (with questions[]) on demand.
//
// CHANGED: this used to call GET /api/admin/question-row/${row._id} —
// but that endpoint expects a real numeric question row id (from the
// `questions` / `pyq_questions` tables) (used by
// showQuestionByRowId() for the paper-wise single-question flow). For a
// chapter+topic GROUP row (the normal topic/chapter view case), `row._id`
// is the composite string key (e.g. "Sets::Disjoint Sets"), which is NOT
// a number — the request 400'd, resolved to null, and silently left
// `q.questions` empty/undefined. saveInlineEdit() then built a sparse
// `fullQuestions` array from that empty data and overwrote the whole
// topic in the database with it, wiping out every sibling question.
//
// The correct lazy-load path for a group row is ensureChapterLoaded(),
// which already calls the right endpoint (/api/admin/questions-for-chapter)
// and fully populates every row for that chapter, including this one.
async function ensureRowLoaded(gi) {
    const row = allQuestions[gi];
    if (!row) return null;
    if (!row._metaOnly && Array.isArray(row.questions)) return row; // already full
    // Single-question rows created by showQuestionByRowId carry a real
    // numeric _rowId and are never _metaOnly, so they never reach here —
    // anything that does is a chapter+topic group row. Load the whole
    // chapter so this row (and its siblings) get their full questions[].
    await ensureChapterLoaded(row.chapter || null);
    return allQuestions[gi];
}

// Fetch all rows for a chapter and populate allQuestions entries
async function ensureChapterLoaded(chapter) {
    const chKey = chapter || "";
    const rowsForChapter = allQuestions.filter(r => (r.chapter || null) === (chapter || null));
    const anyUnloaded = rowsForChapter.some(r => r._metaOnly);
    if (!anyUnloaded) return; // already all loaded

    try {
        const enc = encodeURIComponent(chKey);
        const r = await fetch(`${API_BASE}/api/admin/questions-for-chapter/${enc}`, { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const fullRows = await r.json();
        if (!Array.isArray(fullRows)) throw new Error("Response is not an array");
        // Merge into allQuestions by _id
        const byId = {};
        for (const fr of fullRows) byId[fr._id] = fr;
        for (let i = 0; i < allQuestions.length; i++) {
            const row = allQuestions[i];
            if ((row.chapter || null) === (chapter || null) && byId[row._id]) {
                allQuestions[i] = byId[row._id];
                _loadedRowCache[row._id] = byId[row._id];
            }
        }
    } catch (e) {
        // CHANGED: the old fallback called ensureRowLoaded() per unloaded
        // row, which (before the fix above) hit the same broken endpoint
        // and silently produced empty data — and would now recurse back
        // into this very function. There is no valid per-row fallback for
        // a group-based schema: a single chapter+topic group either loads
        // as a whole or it doesn't. Retry the chapter fetch once; if that
        // also fails, surface the error so a save attempt can't proceed
        // against incomplete/empty data.
        console.error("ensureChapterLoaded failed:", e);
        try {
            const enc = encodeURIComponent(chKey);
            const r2 = await fetch(`${API_BASE}/api/admin/questions-for-chapter/${enc}`, { credentials: 'include' });
            if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
            const fullRows2 = await r2.json();
            if (!Array.isArray(fullRows2)) throw new Error("Response is not an array");
            const byId2 = {};
            for (const fr of fullRows2) byId2[fr._id] = fr;
            for (let i = 0; i < allQuestions.length; i++) {
                const row = allQuestions[i];
                if ((row.chapter || null) === (chapter || null) && byId2[row._id]) {
                    allQuestions[i] = byId2[row._id];
                    _loadedRowCache[row._id] = byId2[row._id];
                }
            }
        } catch (e2) {
            console.error("ensureChapterLoaded retry also failed:", e2);
            throw e2; // let callers (e.g. showQuestionView) know loading failed
        }
    }
}

async function loadQuestionsAdmin() {
    try {
        // Load metadata only — no questions_json blobs, instant even for 20k questions
        const r = await fetch(`${API_BASE}/api/admin/questions-meta`, { credentials: "include" });
        console.log("Questions meta API status:", r.status);
        if (r.status === 403) { console.log("Not authorized for questions"); return; }
        if (!r.ok) { console.error("Questions meta API error:", r.status); return; }
        allQuestions = await r.json();
        // Clear the row cache so re-opened rows fetch fresh data
        for (const key of Object.keys(_loadedRowCache)) delete _loadedRowCache[key];
        console.log("Question metadata loaded:", allQuestions.length, "rows (lazy, no blobs)");
        renderQuestionList(allQuestions);
    } catch (e) { console.error("Error loading questions:", e); }
}

function mqGetOptionImages(question) {
    if (!question) return [null, null, null, null];
    const raw = Array.isArray(question.optionImages)
        ? question.optionImages
        : Array.isArray(question.optImgs)
            ? question.optImgs
            : Array.isArray(question.optionsImages)
                ? question.optionsImages
                : question.optionImage ? [question.optionImage] : [];
    const images = [...raw, null, null, null].slice(0, 4);
    while (images.length < 4) images.push(null);
    return images;
}

function mqHasOptionImages(question) {
    return mqGetOptionImages(question).some(Boolean);
}

// Return a 4-slot array of per-option tables (index 0=A … 3=D). Each slot is
// either a normalized {headers, rows[, caption]} object or null. Falls back to
// extracting from a `tables` array carrying option_a..option_d positions.
function mqGetOptionTables(question) {
    if (!question) return [null, null, null, null];
    const out = [null, null, null, null];
    if (Array.isArray(question.optionTables)) {
        for (let i = 0; i < 4; i++) {
            const nt = _normalizeSingleTable(question.optionTables[i]);
            if (nt) out[i] = nt;
        }
    }
    // Also honor any option_x positioned tables left inside `tables`.
    const { optionTables } = _extractOptionTables(question);
    for (let i = 0; i < 4; i++) {
        if (!out[i] && optionTables[i]) out[i] = optionTables[i];
    }
    return out;
}

function mqHasOptionTables(question) {
    return _hasAnyOptionTable(mqGetOptionTables(question));
}

// Collect all solution images from a sub-question's first solution entry.
function mqGetSolutionImages(question) {
    if (!question || !Array.isArray(question.solutions) || !question.solutions.length) return [];
    const sol = question.solutions[0];
    if (!sol) return [];
    if (Array.isArray(sol.images) && sol.images.length) return sol.images.filter(Boolean);
    if (sol.image) return [sol.image];
    return [];
}

function handleViewModeChange() {
    // Lecture Wise view removed; always topic view
    if (mqCurrentChapter) showLectureViewForChapter(mqCurrentChapter);
}

function setQuestionSelectButtonVisible(visible) {
    const btn = document.getElementById("lecSelectModeQBtn");
    if (btn) btn.style.display = visible ? "" : "none";
}

function renderQuestionList(questions) { renderSubjectCards(questions); }

function filterLectureCards() {
    const topicQ = (document.getElementById("lecTopicFilter")?.value || "").toLowerCase().trim();
    document.querySelectorAll("#lectureCardsGrid .lecture-card").forEach(card => {
        const cTopic = card.dataset.topic || "";
        const matchTopic = !topicQ || cTopic.includes(topicQ);
        card.style.display = matchTopic ? "" : "none";
    });
}

async function renameTopic(encodedCh, encodedTopic) {
    const ch = decodeURIComponent(encodedCh);
    const oldTopic = decodeURIComponent(encodedTopic);
    const newTopic = await askPromptModalPromise({
        title: "Rename Topic",
        text: `Enter new topic name for "${oldTopic || "(No Topic)"}" inside Chapter "${ch}":`,
        defaultValue: oldTopic
    });
    if (newTopic === null || newTopic.trim() === oldTopic || !newTopic.trim()) return;
    const confirmed = await askConfirmModalPromise({ title: "Confirm Rename", text: `Rename topic to "${newTopic.trim()}"?`, confirmText: "Rename" });
    if (!confirmed) return;

    showDeleteProgress("Renaming topic...");
    try {
        const r = await fetch(`${API_BASE}/api/admin/rename-topic`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chapter: ch, oldName: oldTopic, newName: newTopic.trim() }) });
        const data = await r.json();
        hideDeleteProgress();
        if (r.ok && data.success) {
            showSuccessModal("Renamed!", "Topic renamed successfully.");
            await loadQuestionsAdmin();
            renderChapterCards(getScopedChapterRows());
            if (document.getElementById("mq-lecture-view").style.display === "block" && mqCurrentChapter) {
                showLectureViewForChapter(mqCurrentChapter);
            } else if (document.getElementById("mq-chapter-view").style.display === "none") {
                showChapterView();
            }
        }
        else { showErrorModal(data.error || "Failed to rename topic", "Error"); }
    } catch (e) {
        hideDeleteProgress();
        console.error("Rename Topic error:", e);
        showErrorModal(e.message, "Error");
    }
}

async function renameChapter(encodedName) {
    const oldName = decodeURIComponent(encodedName);
    const newName = await askPromptModalPromise({
        title: "Rename Chapter",
        text: `Enter new name for chapter: "${oldName}"\n\nThis will apply to all lectures in this chapter.`,
        defaultValue: oldName
    });
    if (!newName || !newName.trim() || newName.trim() === oldName) return;

    const confirmed = await askConfirmModalPromise({ title: "Confirm Rename", text: `Are you sure you want to rename "${oldName}" to "${newName.trim()}"?`, confirmText: "Rename" });
    if (!confirmed) return;

    showDeleteProgress("Renaming chapter...");
    try {
        const r = await fetch(`${API_BASE}/api/admin/rename-chapter`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ oldName, newName: newName.trim() })
        });
        const data = await r.json();
        hideDeleteProgress();
        if (r.ok && data.success) {
            showSuccessModal("Renamed!", `Chapter "${oldName}" was renamed to "${newName.trim()}" successfully.`);
            await loadQuestionsAdmin();
            renderChapterCards(getScopedChapterRows());
            if (document.getElementById("mq-chapter-view").style.display === "none") {
                showChapterView();
            }
        } else {
            showErrorModal(data.error || "Failed to rename chapter", "Error");
        }
    } catch (e) {
        hideDeleteProgress();
        console.error("Rename error:", e);
        showErrorModal(e.message, "Error");
    }
}

function showToast(msg, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span class="toast-icon">${type === 'success' ? '✅' : '⚠️'}</span><span>${msg}</span>`;
    container.appendChild(t);
    setTimeout(() => {
        t.classList.add('fade-out');
        setTimeout(() => t.remove(), 300);
    }, 3000);
}

let lastSelectedChapterIdx = -1;

// Strip LaTeX math delimiters for plain-text card previews
function stripMath(text) {
    if (!text) return '';
    return text.replace(/\$\$[\s\S]*?\$\$/g, '[equation]').replace(/\$[^$]+\$/g, '[eq]');
}

// ═══════ SUBJECT-LEVEL VIEW (new top-level) ═══════
const SUBJECT_COLORS_MQ = { Physics: '#56a9ff', Chemistry: '#2ed2b4', Mathematics: '#f5a623' };
const SUBJECT_ICONS_MQ = { Physics: '⚛️', Chemistry: '🧪', Mathematics: '📐' };
let mqCurrentSubject = null;
let mqCurrentPaper = null;
let mqBrowseMode = 'chapter';

function inferSubjectFromText(text) {
    const value = String(text || '').toLowerCase().trim();
    if (!value) return '';
    if (/physics|mechanics|motion|kinematics|laws of motion|work\s*(?:,|and)?\s*energy|power|center of mass|system of particles|rotational motion|gravitation|units and measurements|measurement|dimensions|errors?|vectors?|projectile|friction|elasticity|fluid|thermodynamics|thermal|kinetic theory|oscillation|waves?|sound|electrostatics|current electricity|magnetism|electromagnetic induction|alternating current|ray optics|wave optics|modern physics|dual nature|atomic|nuclear|semiconductor|communication/i.test(value)) return 'Physics';
    if (/chemistry|organic|inorganic|physical chemistry|chemical bonding|acid|base|redox|periodic|hydrocarbon|polymer|biomolecule|environment|electrochem|kinetics|equilibr|solution|surface chemistry|thermodynamics/i.test(value)) return 'Chemistry';
    if (/math|mathematics|algebra|calculus|geometry|trigon|vector|matrix|determinant|probability|statistic|complex|sequence|series|binomial|straight line|circle|parabola|ellipse|hyperbola|limit|integral|differential|linear/i.test(value)) return 'Mathematics';
    return '';
}

function getSubjectForRow(qRow) {
    if (!qRow) return 'Other';
    if (qRow.subject && qRow.subject !== 'Other' && qRow.subject !== 'Unknown') return qRow.subject;
    // When questions are fully loaded, use the subject field directly.
    if (Array.isArray(qRow.questions) && qRow.questions.length > 0) {
        const s = qRow.questions[0].subject;
        if (s && s !== 'Other' && s !== 'Unknown') return s;
    }
    // Metadata-only rows from questions-meta need a broader chapter/topic inference.
    const inferred = inferSubjectFromText([qRow.chapter, qRow.topic, qRow.lecture].filter(Boolean).join(' '));
    if (inferred) return inferred;
    return 'Other';
}

function getPaperLabel(row) {
    // Extract unique years from individual question objects inside this row
    const years = new Set();
    (row?.questions || []).forEach(q => { if (q?.year) years.add(String(q.year).trim()); });
    if (years.size === 1) return [...years][0];
    if (years.size > 1) return [...years].sort((a, b) => parseInt(b) - parseInt(a))[0]; // use most recent
    return 'Unknown Year';
}

// Returns flat array of {year, question, row, sqIdx} across all questions
function getAllQuestionsWithYear() {
    const out = [];
    allQuestions.forEach((row, gi) => {
        (row.questions || []).forEach((q, sqIdx) => {
            const year = q?.year ? String(q.year).trim() : 'Unknown Year';
            out.push({ year, question: q, row, gi, sqIdx });
        });
    });
    return out;
}

function getQuestionImages(qItem) {
    if (!qItem) return [];
    if (Array.isArray(qItem.questionImages)) return qItem.questionImages.filter(Boolean);
    return qItem.questionImage ? [qItem.questionImage].filter(Boolean) : [];
}

function renderQuestionImages(question, targetId) {
    const target = document.getElementById(targetId);
    if (!target) return;
    const imgs = getQuestionImages(question);
    if (!imgs.length) {
        target.innerHTML = '';
        return;
    }
    target.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:8px">
                    ${imgs.map((img, idx) => `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg-card)"><img src="${img.startsWith('http') ? img : `data:${img.startsWith('/9j/') ? 'image/jpeg' : img.startsWith('iVBOR') ? 'image/png' : 'image/jpeg'};base64,${img}`}" alt="Question image ${idx + 1}" style="width:100%;max-height:240px;object-fit:contain;display:block;background:#000"></div>`).join('')}
                </div>`;
}

function setManageBrowseMode(mode) {
    mqBrowseMode = mode === 'paper' ? 'paper' : 'chapter';
    mqCurrentPaper = null;
    mqCurrentSubject = null;
    const title = document.getElementById('mqBrowseTitle');
    const subtitle = document.getElementById('mqBrowseSubtitle');
    const chapterBtn = document.getElementById('mqModeChapterBtn');
    const paperBtn = document.getElementById('mqModePaperBtn');
    if (title) title.textContent = mqBrowseMode === 'paper' ? '📄 Papers' : '📚 Subjects';
    if (subtitle) subtitle.textContent = mqBrowseMode === 'paper'
        ? 'Browse by paper → all questions from the same paper are shown together'
        : 'Browse by subject → chapter → topic → question';
    if (chapterBtn) {
        chapterBtn.style.borderColor = mqBrowseMode === 'chapter' ? 'var(--accent)' : 'var(--border)';
        chapterBtn.style.color = mqBrowseMode === 'chapter' ? 'var(--accent)' : 'var(--text-mid)';
    }
    if (paperBtn) {
        paperBtn.style.borderColor = mqBrowseMode === 'paper' ? 'var(--accent)' : 'var(--border)';
        paperBtn.style.color = mqBrowseMode === 'paper' ? 'var(--accent)' : 'var(--text-mid)';
    }
    showSubjectView();
}

function renderSubjectCards(questions) {
    const grid = document.getElementById('subjectCardsGrid'); if (!grid) return;
    const rows = Array.isArray(questions) ? questions : [];
    if (mqBrowseMode === 'paper') {
        renderPapersView(grid);
        return;
        // ── legacy year-based view below (no longer reached) ──
        // Use the year-counts index API — fast, no JSON scanning
        grid.innerHTML = '<p style="color:var(--text-dim);padding:20px;grid-column:1/-1">Loading years…</p>';
        fetch('/api/admin/year-counts', { credentials: 'include' })
            .then(r => r.json())
            .then(yearCounts => {
                if (!Array.isArray(yearCounts) || !yearCounts.length) {
                    grid.innerHTML = '<p style="color:var(--text-dim);padding:20px;grid-column:1/-1">No papers found.</p>';
                    return;
                }
                grid.innerHTML = yearCounts.map(({ year, count }) => {
                    return `<div class="chapter-card" style="border-left:4px solid var(--accent);cursor:pointer" onclick="showPaperQuestions('${year.replace(/'/g, "\\'")}')">
                                <div class="chapter-card-icon" style="font-size:2rem">📄</div>
                                <div class="chapter-card-title" style="color:var(--accent)">${year}</div>
                                <div class="chapter-card-count">${count} Question${count !== 1 ? 's' : ''}</div>
                            </div>`;
                }).join('');
            })
            .catch(() => {
                // Fallback to in-memory scan if API fails
                const byYear = {};
                getAllQuestionsWithYear().forEach(({ year, row }) => {
                    if (!byYear[year]) byYear[year] = { qCount: 0, chapters: new Set() };
                    byYear[year].qCount++;
                    byYear[year].chapters.add(row.chapter || '(No Chapter)');
                });
                const years = Object.keys(byYear).sort((a, b) => (parseInt(b) || 0) - (parseInt(a) || 0));
                if (!years.length) { grid.innerHTML = '<p style="color:var(--text-dim);padding:20px;grid-column:1/-1">No papers found.</p>'; return; }
                grid.innerHTML = years.map(year => {
                    const { qCount, chapters } = byYear[year];
                    const chapCount = chapters.size;
                    return `<div class="chapter-card" style="border-left:4px solid var(--accent);cursor:pointer" onclick="showPaperQuestions('${year.replace(/'/g, "\\'")}')">
                                <div class="chapter-card-icon" style="font-size:2rem">📄</div>
                                <div class="chapter-card-title" style="color:var(--accent)">${year}</div>
                                <div class="chapter-card-count">${qCount} Question${qCount !== 1 ? 's' : ''} · ${chapCount} Chapter${chapCount !== 1 ? 's' : ''}</div>
                            </div>`;
                }).join('');
            });
        return;
    }

    const bySubject = {};
    rows.forEach(q => {
        const subj = getSubjectForRow(q);
        if (!bySubject[subj]) bySubject[subj] = [];
        bySubject[subj].push(q);
    });
    const order = ['Physics', 'Chemistry', 'Mathematics'];
    const subjects = Object.keys(bySubject).sort((a, b) => {
        const ai = order.indexOf(a), bi = order.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    if (!subjects.length) { grid.innerHTML = '<p style="color:var(--text-dim);padding:20px;grid-column:1/-1">No questions found.</p>'; return; }
    grid.innerHTML = subjects.map(subj => {
        const rowsForSubject = bySubject[subj];
        // Use questionCount from metadata if questions[] not yet loaded
        const totalQ = rowsForSubject.reduce((s, r) => s + (Array.isArray(r.questions) ? r.questions.length : (r.questionCount || 0)), 0);
        const chapCount = new Set(rowsForSubject.map(r => r.chapter || '(No Chapter)')).size;
        const color = SUBJECT_COLORS_MQ[subj] || '#b7c8e8';
        const icon = SUBJECT_ICONS_MQ[subj] || '📚';
        return `<div class="chapter-card" style="border-left:4px solid ${color};cursor:pointer" onclick="showChaptersForSubject('${subj.replace(/'/g, "\\'")}')">
                    <div class="chapter-card-icon" style="font-size:2rem">${icon}</div>
                    <div class="chapter-card-title" style="color:${color}">${subj}</div>
                    <div class="chapter-card-count">${totalQ} Question${totalQ !== 1 ? 's' : ''} · ${chapCount} Chapter${chapCount !== 1 ? 's' : ''}</div>
                </div>`;
    }).join('');
}

function showChaptersForSubject(subj) {
    mqBrowseMode = 'chapter';
    mqCurrentSubject = subj;
    mqCurrentPaper = null;
    const filtered = allQuestions.filter(q => getSubjectForRow(q) === subj);
    selectModeOn = false;
    selectedLectures.clear();
    lastSelectedChapterIdx = -1;
    document.getElementById('mq-subject-view').style.display = 'none';
    document.getElementById('mq-chapter-view').style.display = 'block';
    document.getElementById('mq-lecture-view').style.display = 'none';
    document.getElementById('mq-question-view').style.display = 'none';
    renderChapterCards(filtered);
}

function showPaperQuestions(paper, push = true) {
    mqBrowseMode = 'paper';
    mqCurrentPaper = paper;
    mqCurrentSubject = null;
    mqPrevView = 'paper';
    selectModeOn = false;
    selectedLectures.clear();
    lastSelectedChapterIdx = -1;
    document.getElementById('mq-subject-view').style.display = 'none';
    document.getElementById('mq-chapter-view').style.display = 'none';
    document.getElementById('mq-lecture-view').style.display = 'block';
    document.getElementById('mq-question-view').style.display = 'none';
    setQuestionSelectButtonVisible(true);
    if (push) history.pushState({ type: 'mqPaper', paper }, '', '');
    renderQuestionsForPaper(paper);
}

function renderQuestionsForPaper(paper) {
    const grid = document.getElementById('lectureCardsGrid'); if (!grid) return;
    grid.className = "questions-view-grid";
    document.getElementById('mq-chapter-title').textContent = `${paper}`;
    document.getElementById('mq-lecture-count').textContent = `Loading…`;
    grid.innerHTML = '<p style="color:var(--text-dim);padding:20px">Loading questions…</p>';

    fetch(`/api/admin/questions-by-year/${encodeURIComponent(paper)}`, { credentials: 'include' })
        .then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(data => {
            // data = { year, count, questions: [{rowId, chapter, lecture, topic, questionIndex, question}] }
            const items = Array.isArray(data.questions) ? data.questions : [];
            // If the server returned an error object (no questions array) treat as failure
            // so the in-memory fallback can run instead of silently showing 0 questions.
            if (!Array.isArray(data.questions)) throw new Error(data.error || 'Malformed response');
            document.getElementById('mq-lecture-count').textContent = `${items.length} Question${items.length !== 1 ? 's' : ''} · Paper-wise view`;

            // CHANGED: the old code tried to map each item's database `rowId`
            // (a per-QUESTION numeric id) to an index `gi` inside `allQuestions`
            // (which holds per chapter+topic GROUPS, not individual questions).
            // Those two ids are never compatible — gi was always -1 and the
            // question view never opened. Paper-wise cards now carry the real
            // rowId directly and open via showQuestionByRowId(), which fetches
            // the question straight from /api/admin/question-row/:id — no
            // dependency on allQuestions being loaded/indexed at all.
            _mqQuestionList = items.map(({ rowId }) => ({ rowId }));

            let qIndex = 1;
            grid.innerHTML = items.map(({ rowId, chapter, topic, question: sq }) => {
                const isMulti = sq.isMultiCorrect || (sq.correctIndexes || [sq.correctIndex || 0]).length > 1;
                const previewText = stripMath((sq.question || '').substring(0, 60));
                const qKey = `row:${rowId}`;
                const isChecked = selectedQuestions.has(qKey) ? 'checked' : '';
                const checkboxHtml = qSelectModeOn ? `<input type="checkbox" class="lec-checkbox" ${isChecked} onclick="event.stopPropagation(); toggleQuestionSelectByRowId(event, ${rowId})" style="position:absolute;top:8px;right:8px;width:18px;height:18px;cursor:pointer;accent-color:var(--accent);z-index:10">` : '';
                const clickHandler = qSelectModeOn ? `onclick="event.stopPropagation(); toggleQuestionSelectByRowId(event, ${rowId})"` : `onclick="showQuestionByRowId(${rowId})"`;
                const tags = `<div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:4px">${_jsonEscHtml(formatChapterLabel(chapter || '(No Chapter)'))}${topic ? ` · ${_jsonEscHtml(topic)}` : ''}</div>`;
                return `<div class="lecture-card ${isMulti ? 'has-multi' : ''}" data-ch="${(chapter || '(No Chapter)').replace(/"/g, '&quot;')}" data-lec="${paper.replace(/"/g, '&quot;')}" data-rowid="${rowId}" style="position:relative" ${clickHandler}>
                            ${checkboxHtml}
                            <div class="lecture-card-num">Q${qIndex++}</div>
                            ${tags}
                            <div class="lecture-card-title">${previewText || 'Empty question'}</div>
                        </div>`;
            }).join('');
        })
        .catch(() => {
            // Fallback to in-memory scan if API fails
            const yearItems = getAllQuestionsWithYear().filter(item => item.year === paper);
            document.getElementById('mq-lecture-count').textContent = `${yearItems.length} Question${yearItems.length !== 1 ? 's' : ''} · Paper-wise view`;
            _mqQuestionList = [];
            let qIndex = 1;
            grid.innerHTML = yearItems.map(({ question: sq, row, gi, sqIdx }) => {
                _mqQuestionList.push({ gi, sqIdx });
                const isMulti = sq.isMultiCorrect || (sq.correctIndexes || [sq.correctIndex || 0]).length > 1;
                const previewText = stripMath((sq.question || '').substring(0, 60));
                const qKey = `${gi}:${sqIdx}`;
                const isChecked = selectedQuestions.has(qKey) ? 'checked' : '';
                const checkboxHtml = qSelectModeOn ? `<input type="checkbox" class="lec-checkbox" ${isChecked} onclick="event.stopPropagation(); toggleQuestionSelect(event, ${gi}, ${sqIdx})" style="position:absolute;top:8px;right:8px;width:18px;height:18px;cursor:pointer;accent-color:var(--accent);z-index:10">` : '';
                const clickHandler = qSelectModeOn ? `onclick="event.stopPropagation(); toggleQuestionSelect(event, ${gi}, ${sqIdx})"` : `onclick="showQuestionViewH(${gi}, ${sqIdx})"`;
                const tags = `<div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:4px">${_jsonEscHtml(formatChapterLabel(row.chapter || '(No Chapter)'))}${row.topic ? ` · ${_jsonEscHtml(row.topic)}` : ''}</div>`;
                return `<div class="lecture-card ${isMulti ? 'has-multi' : ''}" data-ch="${(row.chapter || '(No Chapter)').replace(/"/g, '&quot;')}" data-lec="${paper.replace(/"/g, '&quot;')}" data-qidx="${sqIdx}" data-gi="${gi}" data-sqidx="${sqIdx}" style="position:relative" ${clickHandler}>
                            ${checkboxHtml}
                            <div class="lecture-card-num">Q${qIndex++}</div>
                            ${tags}
                            <div class="lecture-card-title">${previewText || 'Empty question'}</div>
                        </div>`;
            }).join('');
        });
}

// ═══════════════════════════════════════════════════════════════════════
// PAPER-WISE VIEW (papers table: exam + year, with JEE/NEET + type filters)
// Shared by the owner and institute "Paper wise" section.
// ═══════════════════════════════════════════════════════════════════════
var _paperFilterExam = '';
var _paperFilterType = '';
var _paperViewCache = { id: null, questions: [] };

const _PAPER_TYPE_OPTS = [
    ['', 'All Types'], ['MCQ', 'MCQ'], ['MSQ', 'MSQ'], ['INTEGER', 'Numerical'],
    ['COMPREHENSION', 'Linked Comprehension'], ['ASSERTION_REASON', 'Assertion & Reason'],
    ['MATRIX_MATCH', 'Matrix Matching']
];
const _PAPER_EXAM_OPTS = [
    ['', 'All Exams'], ['JEE Mains', 'JEE Mains'], ['JEE Advanced', 'JEE Advanced'], ['NEET', 'NEET']
];

function _paperFilterBarHtml() {
    const sel = (id, opts, val) => `<select id="${id}" onchange="_paperSetFilter('${id === 'paperExamFilter' ? 'exam' : 'type'}', this.value)" style="padding:8px 12px;border-radius:10px;background:var(--bg-input,var(--bg-card));border:1px solid var(--border);color:var(--text);font-size:0.85rem;cursor:pointer">${opts.map(([v, l]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    return `<div style="grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:6px">
        <span style="font-size:0.78rem;color:var(--text-muted);font-weight:600">🎯 Filters:</span>
        ${sel('paperExamFilter', _PAPER_EXAM_OPTS, _paperFilterExam)}
        ${sel('paperTypeFilter', _PAPER_TYPE_OPTS, _paperFilterType)}
    </div>`;
}

function _paperSetFilter(which, val) {
    if (which === 'exam') _paperFilterExam = val;
    else _paperFilterType = val;
    const grid = document.getElementById('subjectCardsGrid');
    if (grid) renderPapersView(grid);
}
window._paperSetFilter = _paperSetFilter;

// Render the list of papers (grouped by exam) with the exam + type filters.
function renderPapersView(grid) {
    const bar = _paperFilterBarHtml();
    grid.innerHTML = bar + '<p style="color:var(--text-dim);padding:20px;grid-column:1/-1">Loading papers…</p>';
    let url = '/api/admin/papers';
    const params = [];
    if (_paperFilterExam) params.push('exam=' + encodeURIComponent(_paperFilterExam));
    if (_paperFilterType) params.push('question_type=' + encodeURIComponent(_paperFilterType));
    if (params.length) url += '?' + params.join('&');
    fetch(url, { credentials: 'include' })
        .then(r => r.json())
        .then(data => {
            const papers = Array.isArray(data.papers) ? data.papers : [];
            const byExam = {};
            // Only show papers that actually have questions (exclude empty Regular rows)
            papers.filter(p => p.count > 0 || p.year === 'Regular').forEach(p => { (byExam[p.exam] = byExam[p.exam] || []).push(p); });
            const order = ['JEE Mains', 'JEE Advanced', 'NEET'];
            const exams = order.filter(e => byExam[e]).concat(Object.keys(byExam).filter(e => !order.includes(e)));
            if (!exams.length) {
                grid.innerHTML = bar +
                    '<div style="grid-column:1/-1;padding:24px;text-align:center">' +
                    '<p style="color:var(--text-dim);margin-bottom:14px">No PYQ papers found. Click below to rebuild from your question database.</p>' +
                    '<button onclick="_rebuildPapersNow(this)" style="padding:10px 22px;border-radius:10px;background:var(--accent);color:#fff;border:none;font-weight:700;font-size:0.9rem;cursor:pointer">🔄 Rebuild PYQ Papers</button>' +
                    '</div>';
                return;
            }
            let html = bar;
            exams.forEach(ex => {
                html += `<div style="grid-column:1/-1;font-weight:800;font-size:1rem;color:var(--accent);margin:10px 0 2px;padding-bottom:6px;border-bottom:1px solid var(--border)">${_jsonEscHtml(ex)}</div>`;
                byExam[ex].forEach(p => {
                    const safeLabel = (p.label || '').replace(/'/g, "\\'");
                    html += `<div class="chapter-card" style="border-left:4px solid var(--accent);cursor:pointer" onclick="showPaperById(${p.id}, '${safeLabel}')">
                        <div class="chapter-card-icon" style="font-size:2rem">📄</div>
                        <div class="chapter-card-title" style="color:var(--accent)">${_jsonEscHtml(p.label || '')}</div>
                        <div class="chapter-card-count">${p.count} Question${p.count !== 1 ? 's' : ''}</div>
                    </div>`;
                });
            });
            grid.innerHTML = html;
        })
        .catch(() => { grid.innerHTML = bar + '<p style="color:var(--error,#e5484d);padding:20px;grid-column:1/-1">Failed to load papers.</p>'; });
}

// Manual rebuild trigger — called from the "Rebuild PYQ Papers" button.
window._rebuildPapersNow = function (btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Rebuilding…'; }
    fetch('/api/admin/papers/rebuild', { method: 'POST', credentials: 'include' })
        .then(r => r.json())
        .then(d => {
            if (d.success) {
                showToast && showToast(`✅ Rebuilt ${d.papers} paper(s) with ${d.questions} question(s)`);
                const grid = document.getElementById('subjectCardsGrid');
                if (grid) renderPapersView(grid);
            } else {
                if (btn) { btn.disabled = false; btn.textContent = '🔄 Rebuild PYQ Papers'; }
                showToast && showToast('Rebuild failed: ' + (d.error || 'Unknown error'));
            }
        })
        .catch(() => {
            if (btn) { btn.disabled = false; btn.textContent = '🔄 Rebuild PYQ Papers'; }
            showToast && showToast('Rebuild request failed.');
        });
};
window.renderPapersView = renderPapersView;

// Open one paper (by papers-table id) and show its questions.
function showPaperById(id, label, push = true) {
    mqBrowseMode = 'paper';
    mqCurrentPaper = id;
    mqCurrentSubject = null;
    mqPrevView = 'paper';
    selectModeOn = false;
    selectedLectures.clear();
    lastSelectedChapterIdx = -1;
    document.getElementById('mq-subject-view').style.display = 'none';
    document.getElementById('mq-chapter-view').style.display = 'none';
    document.getElementById('mq-lecture-view').style.display = 'block';
    document.getElementById('mq-question-view').style.display = 'none';
    setQuestionSelectButtonVisible(true);
    if (push) history.pushState({ type: 'mqPaperId', id, label }, '', '');
    renderQuestionsForPaperById(id, label);
}
window.showPaperById = showPaperById;

// Render questions for a single paper id (respects the active type filter).
function renderQuestionsForPaperById(id, label) {
    const grid = document.getElementById('lectureCardsGrid'); if (!grid) return;
    grid.className = "questions-view-grid";
    document.getElementById('mq-chapter-title').textContent = label || 'Paper';
    document.getElementById('mq-lecture-count').textContent = `Loading…`;
    grid.innerHTML = '<p style="color:var(--text-dim);padding:20px">Loading questions…</p>';
    let url = `/api/admin/papers/${id}`;
    if (_paperFilterType) url += `?question_type=${encodeURIComponent(_paperFilterType)}`;
    fetch(url, { credentials: 'include' })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(data => {
            const items = Array.isArray(data.questions) ? data.questions : [];
            _paperViewCache = { id: data.id, questions: items };
            document.getElementById('mq-lecture-count').textContent = `${items.length} Question${items.length !== 1 ? 's' : ''} · ${_jsonEscHtml(data.label || 'Paper')}`;
            let qIndex = 1;
            grid.innerHTML = items.map((item, idx) => {
                const sq = item.question || {};
                const isMulti = sq.isMultiCorrect || (sq.correctIndexes || [sq.correctIndex || 0]).length > 1;
                const previewText = stripMath((sq.question || '').substring(0, 60));
                const qtype = String(sq.question_type || sq.questionType || 'MCQ').toUpperCase();
                // Build shift badge for JEE Mains questions that carry month/day/shift metadata.
                const month = sq._month || sq.month || '';
                const day = sq._day || sq.day || '';
                const shift = sq._shift || sq.shift || '';
                const shiftBadge = (month || day || shift)
                    ? `<span style="font-size:0.7rem;background:rgba(91,95,239,0.15);color:var(--accent);border-radius:6px;padding:1px 6px;margin-left:4px;font-weight:600">${[month, day, shift].filter(Boolean).join(' · ')}</span>`
                    : '';
                const tags = `<div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:4px">${_jsonEscHtml(formatChapterLabel(sq.chapter || '(No Chapter)'))}${sq.topic ? ` · ${_jsonEscHtml(sq.topic)}` : ''} · ${_jsonEscHtml(qtype)}${shiftBadge}</div>`;
                return `<div class="lecture-card ${isMulti ? 'has-multi' : ''}" style="position:relative" onclick="showPaperQuestionByIndex(${idx})">
                    <div class="lecture-card-num">Q${qIndex++}</div>
                    ${tags}
                    <div class="lecture-card-title">${previewText || 'Empty question'}</div>
                </div>`;
            }).join('');
            if (!items.length) grid.innerHTML = '<p style="color:var(--text-dim);padding:20px">No questions in this paper for the selected filter.</p>';
        })
        .catch(() => { grid.innerHTML = '<p style="color:var(--error,#e5484d);padding:20px">Failed to load paper questions.</p>'; });
}
window.renderQuestionsForPaperById = renderQuestionsForPaperById;

// Open a single question from the currently-loaded paper (read-only view).
function showPaperQuestionByIndex(idx) {
    const item = (_paperViewCache.questions || [])[idx];
    if (!item) return;
    const sq = item.question || item;
    const _id = `paper:${_paperViewCache.id}:${item.paperIndex}`;
    let gi = allQuestions.findIndex(q => q._id === _id);
    const wrapped = {
        _id,
        chapter: sq.chapter || null,
        lecture: sq.topic || "",
        topic: sq.topic || "",
        updatedAt: 0,
        questions: [sq],
        _readonlyPaper: true,
    };
    if (gi === -1) { allQuestions.push(wrapped); gi = allQuestions.length - 1; }
    else { allQuestions[gi] = wrapped; }
    mqPrevView = 'paper';
    showQuestionView(gi, 0);
}
window.showPaperQuestionByIndex = showPaperQuestionByIndex;

// NEW: open a single question directly by its question row id.
// Used by paper-wise cards, which only ever have a rowId (no gi/sqIdx —
// see the comment in renderQuestionsForPaper for why those don't apply
// here). Fetches the question fresh from the server every time, so it
// works correctly whether or not the owning chapter has been lazy-loaded
// into allQuestions.
async function showQuestionByRowId(rowId) {
    try {
        const r = await fetch(`${API_BASE}/api/admin/question-row/${rowId}`, { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json(); // { _id, chapter, topic, subject, year, updatedAt, question }
        if (!data || !data.question) throw new Error('Question not found');

        // Build (or reuse) a single-row entry in allQuestions so the existing
        // view/edit/delete/save machinery (which all key off gi+sqIdx) keeps working
        // unchanged for this question.
        let gi = allQuestions.findIndex(q => q._id === `rowid:${rowId}`);
        const wrapped = {
            _id: `rowid:${rowId}`,
            _rowId: rowId,
            chapter: data.chapter || null,
            lecture: data.topic || "",
            topic: data.topic || "",
            updatedAt: data.updatedAt || 0,
            questions: [data.question],
        };
        if (gi === -1) {
            allQuestions.push(wrapped);
            gi = allQuestions.length - 1;
        } else {
            allQuestions[gi] = wrapped;
        }

        mqPrevView = 'paper';
        showQuestionView(gi, 0);
    } catch (e) {
        console.error('showQuestionByRowId failed:', e);
        showErrorModal('Could not open this question. Please try again.', 'Error');
    }
}
window.showQuestionByRowId = showQuestionByRowId;

// Paper-wise select-mode checkbox toggle (keyed by rowId, not gi:sqIdx,
// since paper-wise cards only have a rowId — see showQuestionByRowId).
function toggleQuestionSelectByRowId(e, rowId) {
    const key = `row:${rowId}`;
    if (selectedQuestions.has(key)) {
        selectedQuestions.delete(key);
    } else {
        selectedQuestions.add(key);
    }
    updateQuestionMassDeleteBar();
    const checkbox = document.querySelector(`.lecture-card[data-rowid="${rowId}"] .lec-checkbox`);
    if (checkbox) checkbox.checked = selectedQuestions.has(key);
}
window.toggleQuestionSelectByRowId = toggleQuestionSelectByRowId;

function getScopedChapterRows() {
    const rows = mqCurrentSubject
        ? allQuestions.filter(q => getSubjectForRow(q) === mqCurrentSubject)
        : allQuestions;
    return rows;
}

function showSubjectView() {
    mqCurrentSubject = null;
    mqCurrentPaper = null;
    const title = document.getElementById('mqBrowseTitle');
    const subtitle = document.getElementById('mqBrowseSubtitle');
    const chapterBtn = document.getElementById('mqModeChapterBtn');
    const paperBtn = document.getElementById('mqModePaperBtn');
    if (title) title.textContent = mqBrowseMode === 'paper' ? '📄 Papers' : '📚 Subjects';
    if (subtitle) subtitle.textContent = mqBrowseMode === 'paper'
        ? 'Browse by paper → all questions from the same paper are shown together'
        : 'Browse by subject → chapter �� topic → question';
    if (chapterBtn) {
        chapterBtn.style.borderColor = mqBrowseMode === 'chapter' ? 'var(--accent)' : 'var(--border)';
        chapterBtn.style.color = mqBrowseMode === 'chapter' ? 'var(--accent)' : 'var(--text-mid)';
    }
    if (paperBtn) {
        paperBtn.style.borderColor = mqBrowseMode === 'paper' ? 'var(--accent)' : 'var(--border)';
        paperBtn.style.color = mqBrowseMode === 'paper' ? 'var(--accent)' : 'var(--text-mid)';
    }
    document.getElementById('mq-subject-view').style.display = 'block';
    document.getElementById('mq-chapter-view').style.display = 'none';
    document.getElementById('mq-lecture-view').style.display = 'none';
    document.getElementById('mq-question-view').style.display = 'none';
    const filter = document.getElementById('lecTopicFilter');
    if (filter) filter.value = '';
    renderSubjectCards(allQuestions);
}

function renderChapterCards(questions) {
    const grid = document.getElementById("chapterCardsGrid"); if (!grid) return;
    const chapters = {};
    (questions || []).forEach(q => { const ch = q.chapter || "(No Chapter)"; if (!chapters[ch]) chapters[ch] = []; chapters[ch].push(q); });
    const names = Object.keys(chapters).sort();
    if (!names.length) { grid.innerHTML = '<p style="color:var(--text-dim);padding:20px;grid-column:1/-1">No questions found.</p>'; return; }
    grid.innerHTML = names.map((ch, i) => {
        const qs = chapters[ch];
        // Use questionCount from metadata if questions[] not yet loaded
        const qc = qs.reduce((s, q) => s + (Array.isArray(q.questions) ? q.questions.length : (q.questionCount || 0)), 0);
        const hasMulti = qs.some(q => Array.isArray(q.questions) && q.questions.some(x => x.isMultiCorrect));
        const isSelected = selectModeOn && [...selectedLectures].some(k => k.startsWith(ch + "::"));
        const displayChapter = formatChapterLabel(ch);
        return `<div class="chapter-card ${isSelected ? "selected-card" : ""}" data-ch="${encodeURIComponent(ch)}" data-idx="${i}" onclick="chapterCardClick(event, decodeURIComponent(this.dataset.ch), Number(this.dataset.idx))">
                    ${selectModeOn ? `<input type="checkbox" class="card-checkbox" onclick="event.stopPropagation();toggleChapterSelect(event, '${encodeURIComponent(ch)}', ${i})" ${isSelected ? "checked" : ""}>` : ""}
                    <div class="chapter-card-icon">${getChapterEmoji(ch)}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center; width:100%">
                        <div class="chapter-card-title" style="margin:0">${displayChapter}</div>
                        <button class="btn btn-ghost" style="padding:4px; margin-left:8px; font-size:1.1rem; min-width:unset; align-self:flex-start" title="Rename Chapter" onclick="event.stopPropagation(); renameChapter('${encodeURIComponent(ch)}')">✏️</button>
                    </div>
                    <div class="chapter-card-count">${qc} Question${qc !== 1 ? 's' : ''}${hasMulti ? ' <span style="color:var(--warn)">&#10022;</span>' : ''}</div>
                </div>`;
    }).join("");
}

function chapterCardClick(e, ch, idx) {
    if (selectModeOn) {
        toggleChapterSelect(e, encodeURIComponent(ch), Number.isFinite(idx) ? idx : 0);
        return;
    }
    showLectureViewH(ch);
}

function toggleSelectMode() {
    selectModeOn = !selectModeOn; selectedLectures.clear(); lastSelectedChapterIdx = -1;
    document.getElementById("selectModeBtn").textContent = selectModeOn ? "✓ Done" : "☐ Select";
    document.getElementById("mass-delete-bar").classList.toggle("visible", false);
    renderChapterCards(getScopedChapterRows());
}
function toggleChapterSelect(e, encCh, idx) {
    const ch = decodeURIComponent(encCh);
    const scopedRows = getScopedChapterRows();

    // Collect all unique chapter names exactly as rendered
    const chaptersObj = {};
    scopedRows.forEach(q => { const cName = q.chapter || "(No Chapter)"; chaptersObj[cName] = true; });
    const allChapterNames = Object.keys(chaptersObj).sort();

    let targetIndices = [idx];

    if (e && e.shiftKey && lastSelectedChapterIdx !== -1) {
        targetIndices = [];
        const start = Math.min(lastSelectedChapterIdx, idx);
        const end = Math.max(lastSelectedChapterIdx, idx);
        for (let i = start; i <= end; i++) targetIndices.push(i);
    }

    // Decide if we are selecting or deselecting based on target item
    const lecturesForTargetCh = scopedRows.filter(q => (q.chapter || "(No Chapter)") === ch);
    const isCurrentlySelected = lecturesForTargetCh.every(q => selectedLectures.has(`${ch}::${q.lecture}`));
    const willSelect = !isCurrentlySelected;

    targetIndices.forEach(i => {
        const loopCh = allChapterNames[i];
        if (!loopCh) return;
        const lecs = scopedRows.filter(q => (q.chapter || "(No Chapter)") === loopCh);
        if (willSelect) {
            lecs.forEach(q => selectedLectures.add(`${loopCh}::${q.lecture}`));
        } else {
            lecs.forEach(q => selectedLectures.delete(`${loopCh}::${q.lecture}`));
        }
    });

    lastSelectedChapterIdx = idx;
    updateMassDeleteBar(); renderChapterCards(scopedRows);
}
function clearSelection() {
    selectModeOn = false; selectedLectures.clear();
    document.getElementById("selectModeBtn").textContent = "☐ Select";
    document.getElementById("mass-delete-bar").classList.remove("visible");
    renderChapterCards(getScopedChapterRows());
}
function updateMassDeleteBar() {
    const bar = document.getElementById("mass-delete-bar");
    const count = document.getElementById("mass-delete-count");
    bar.classList.toggle("visible", selectedLectures.size > 0);
    count.textContent = `${selectedLectures.size} set(s) selected`;
}
function massDelete() {
    if (!selectedLectures.size) return;
    document.getElementById("massDeleteModalText").textContent = `Delete ${selectedLectures.size} selected set(s)? This cannot be undone.`;
    openModal("massDeleteModal");
}
function showDeleteProgress(msg) {
    const ov = document.createElement("div");
    ov.id = "deleteProgressOverlay";
    ov.style.cssText = "position:fixed;bottom:24px;right:24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 20px;display:flex;align-items:center;gap:12px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.3)";
    ov.innerHTML = `<div class="saving-spinner"></div><div><div class="saving-text">${msg}</div></div>`;
    document.body.appendChild(ov);
}
function hideDeleteProgress() {
    document.getElementById("deleteProgressOverlay")?.remove();
}
async function confirmMassDelete() {
    closeModal("massDeleteModal");
    showDeleteProgress("Removing items...");
    const items = [...selectedLectures].map(k => {
        const [ch, ...rest] = k.split("::");
        const chapter = (ch === "(No Chapter)" || ch === "_none_") ? null : ch;
        return { chapter, lecture: rest.join("::") };
    });

    try {
        const r = await fetch(`${API_BASE}/api/admin/mass-delete`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items })
        });

        if (r.ok) {
            const d = await r.json();
            hideDeleteProgress();
            showSuccessModal("Deleted!", `${d.deleted || items.length} item(s) deleted successfully.`);
            clearSelection();
            await loadQuestionsAdmin();
            return;
        }

        // Primary mass-delete failed — get error and attempt per-item fallback
        const primaryErr = await extractErrorMessage(r, "Mass delete failed.");
        showDeleteProgress("Attempting item-by-item delete...");
        let successCount = 0;
        const failures = [];

        for (const it of items) {
            const chapterParam = it.chapter ?? "";
            const lectureParam = it.lecture;
            if (!lectureParam) {
                failures.push({ item: it, error: "Missing lecture id" });
                continue;
            }
            try {
                const dr = await fetch(`${API_BASE}/api/admin/question/${encodeURIComponent(chapterParam)}/${encodeURIComponent(lectureParam)}`, { method: "DELETE", credentials: "include" });
                if (dr.ok) {
                    successCount++;
                } else {
                    const txt = await extractErrorMessage(dr, "Delete failed");
                    failures.push({ item: it, error: txt });
                }
            } catch (e) {
                failures.push({ item: it, error: e.message || String(e) });
            }
        }

        hideDeleteProgress();

        if (successCount > 0) {
            showSuccessModal("Deleted!", `${successCount} item(s) deleted successfully (partial).`);
            clearSelection();
            await loadQuestionsAdmin();
        }

        if (failures.length) {
            const details = failures.map(f => `${f.item.chapter || '(No Chapter)'}/${f.item.lecture}: ${f.error}`).join("\n");
            showErrorModal(`${primaryErr}\n\nPartial failures:\n${details}`, "Delete failed");
        }
    } catch (e) {
        hideDeleteProgress();
        showErrorModal(e.message || String(e), "Delete failed");
    }
}
function filterChapterCards(q) {
    const f = q.toLowerCase();
    const scopedRows = getScopedChapterRows();
    renderChapterCards(scopedRows.filter(x => (x.chapter || "").toLowerCase().includes(f) || String(x.lecture).includes(f)));
}

/* ── Question-level select/delete ── */
function toggleQuestionSelectMode() {
    qSelectModeOn = !qSelectModeOn; selectedQuestions.clear();
    const btn = document.getElementById("lecSelectModeQBtn");
    btn.textContent = qSelectModeOn ? "✓ Done" : "☐ Select Questions";
    document.getElementById("lec-mass-delete-q-bar").classList.remove("visible");
    const grid = document.getElementById("lectureCardsGrid");
    if (qSelectModeOn) grid.classList.add("lec-select-mode");
    else grid.classList.remove("lec-select-mode");

    // Refresh to show checkboxes
    if (mqCurrentChapter && mqCurrentLectureNum !== null) {
        handleLectureNumClick(null, null, mqCurrentChapter, mqCurrentLectureNum);
    } else if (mqCurrentChapter && mqCurrentTopic) {
        handleTopicCardClick(null, null, mqCurrentChapter, encodeURIComponent(mqCurrentTopic));
    }
}

function toggleQuestionSelect(e, gi, sqIdx) {
    const key = `${gi}:${sqIdx}`;
    if (selectedQuestions.has(key)) {
        selectedQuestions.delete(key);
    } else {
        selectedQuestions.add(key);
    }
    updateQuestionMassDeleteBar();

    // Update checkbox visual
    const checkbox = document.querySelector(`.lecture-card[data-gi="${gi}"][data-sqidx="${sqIdx}"] .lec-checkbox`);
    if (checkbox) checkbox.checked = selectedQuestions.has(key);
}

function updateQuestionMassDeleteBar() {
    const bar = document.getElementById("lec-mass-delete-q-bar");
    const countSpan = document.getElementById("lec-mass-delete-q-count");
    if (selectedQuestions.size > 0) {
        countSpan.textContent = `${selectedQuestions.size} question(s) selected`;
        bar.classList.add("visible");
    } else {
        bar.classList.remove("visible");
    }
}

function clearQuestionSelection(skipRefresh = false) {
    qSelectModeOn = false; selectedQuestions.clear();
    document.getElementById("lecSelectModeQBtn").textContent = "☐ Select Questions";
    document.getElementById("lec-mass-delete-q-bar").classList.remove("visible");
    const grid = document.getElementById("lectureCardsGrid");
    if (grid) grid.classList.remove("lec-select-mode");

    if (skipRefresh) return;

    // Refresh to hide checkboxes
    if (mqCurrentChapter && mqCurrentLectureNum !== null) {
        handleLectureNumClick(null, null, mqCurrentChapter, mqCurrentLectureNum);
    } else if (mqCurrentChapter && mqCurrentTopic) {
        handleTopicCardClick(null, null, mqCurrentChapter, encodeURIComponent(mqCurrentTopic));
    }
}
window.clearQuestionSelection = clearQuestionSelection;

async function massDeleteQuestions() {
    if (!selectedQuestions.size) return;

    // Get the lecture from the first selected question
    const firstKey = [...selectedQuestions][0];
    const [gi, sqIdx] = firstKey.split(':').map(Number);
    const lecture = allQuestions[gi];

    if (!lecture) {
        showErrorModal("Cannot find the lecture to delete questions from.");
        return;
    }

    // Update current context for proper refresh
    mqCurrentChapter = lecture.chapter;
    mqCurrentLectureNum = Number(lecture.lecture);

    const qIndices = [...selectedQuestions].map(k => parseInt(k.split(':')[1])).sort((a, b) => b - a);

    document.getElementById("lecMassDeleteModalText").textContent = `Delete ${selectedQuestions.size} selected question(s) from "${lecture.chapter || "No chapter"} / ${lecture.topic || lecture.lecture}"? This cannot be undone.`;
    openModal("lecMassDeleteModal");
}
window.massDeleteQuestions = massDeleteQuestions;

async function confirmQuestionMassDelete() {
    closeModal("lecMassDeleteModal");

    // Get the lecture from the first selected question
    const firstKey = [...selectedQuestions][0];
    const [gi, sqIdx] = firstKey.split(':').map(Number);
    const lecture = allQuestions[gi];

    if (!lecture) {
        showErrorModal("Cannot find the lecture.");
        return;
    }

    const qIndices = [...selectedQuestions].map(k => parseInt(k.split(':')[1])).sort((a, b) => b - a);

    showDeleteProgress("Deleting questions...");

    // Remove questions in reverse order to maintain correct indices
    qIndices.forEach(idx => {
        if (lecture.questions && lecture.questions[idx]) {
            lecture.questions.splice(idx, 1);
        }
    });

    try {
        const r = await fetch(`${API_BASE}/api/admin/question/${encodeQuestionPathPart(lecture.chapter)}/${encodeQuestionPathPart(lecture.lecture)}`, {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chapter: lecture.chapter,
                lecture: lecture.lecture,
                topic: lecture.topic || "",
                questions: lecture.questions
            })
        });

        if (r.ok) {
            hideDeleteProgress();
            showSuccessModal("Deleted!", `${qIndices.length} question(s) deleted successfully.`);
            clearQuestionSelection(true);
            await loadQuestionsAdmin();

            // Refresh the view
            if (mqCurrentTopic) {
                handleTopicCardClick(null, null, mqCurrentChapter, encodeURIComponent(mqCurrentTopic));
            } else if (mqCurrentLectureNum !== null) {
                handleLectureNumClick(null, null, mqCurrentChapter, mqCurrentLectureNum);
            } else if (mqCurrentChapter) {
                showLectureViewForChapter(mqCurrentChapter);
            }
        } else {
            throw new Error("Delete failed");
        }
    } catch (e) {
        hideDeleteProgress();
        showErrorModal(e.message || "Delete failed.", "Delete failed");
    }
}

async function handleMassDeleteConfirm() {
    await confirmQuestionMassDelete();
}
window.handleMassDeleteConfirm = handleMassDeleteConfirm;

/* ── View switching ── */
function showChapterView() {
    document.getElementById("mq-subject-view").style.display = "none";
    document.getElementById("mq-chapter-view").style.display = "block";
    document.getElementById("mq-lecture-view").style.display = "none";
    document.getElementById("mq-question-view").style.display = "none";
    setQuestionSelectButtonVisible(false);
    mqCurrentChapter = null; mqCurrentLectureIdx = null; mqCurrentTopic = null; mqCurrentLectureNum = null; mqPrevView = null;
}

function goBackMQ() {
    if (mqPrevView === 'paper') {
        showSubjectView();
    } else
        if (mqPrevView === 'topic' && mqCurrentChapter) {
            showLectureViewForChapter(mqCurrentChapter);
        } else if (mqPrevView === 'lecture' && mqCurrentChapter) {
            showLectureViewForChapter(mqCurrentChapter);
        } else {
            showChapterView();
        }
    mqPrevView = null;
}

async function showLectureViewForChapter(ch) {
    mqCurrentChapter = ch;
    mqCurrentTopic = null;
    mqCurrentLectureNum = null;
    mqPrevView = 'chapter';
    document.getElementById("mq-chapter-view").style.display = "none";
    document.getElementById("mq-lecture-view").style.display = "block";
    document.getElementById("mq-question-view").style.display = "none";
    setQuestionSelectButtonVisible(false);
    clearQuestionSelection(true);
    document.getElementById("mq-chapter-title").textContent = ch;
    document.getElementById("mq-lecture-count").textContent = "Loading…";
    document.getElementById("lectureCardsGrid").innerHTML = '<p style="color:var(--text-dim);padding:20px">Loading…</p>';

    // Lazy-load all rows for this chapter before rendering
    await ensureChapterLoaded(ch === "(No Chapter)" ? null : ch);

    const lecs = allQuestions.filter(q => (q.chapter || "(No Chapter)") === ch).sort((a, b) => Number(a.lecture) - Number(b.lecture));
    const viewMode = "topic"; // Always topic view (lecture view removed)
    const topicCount = [...new Set(lecs.map(q => q.topic || "(No Topic)"))].length;
    document.getElementById("mq-lecture-count").textContent = topicCount + " topic(s)";
    const grid = document.getElementById("lectureCardsGrid");
    grid.className = "topics-view-grid";

    if (viewMode === "topic") {
        const topics = {};
        lecs.forEach(q => {
            const topic = q.topic || "(No Topic)";
            if (!topics[topic]) topics[topic] = [];
            topics[topic].push(q);
        });
        const sortedTopics = Object.keys(topics).sort();
        grid.innerHTML = sortedTopics.map(topic => {
            const qs = topics[topic];
            const totalQ = qs.reduce((sum, x) => sum + (Array.isArray(x.questions) ? x.questions.length : (x.questionCount || 0)), 0);
            const hasMulti = qs.some(x => Array.isArray(x.questions) && x.questions.some(y => y.isMultiCorrect));
            return `<div class="lecture-card ${hasMulti ? "has-multi" : ""}" data-ch-enc="${encodeURIComponent(ch)}" data-topic-enc="${encodeURIComponent(topic)}" onclick="handleTopicCardClick(event, this, decodeURIComponent(this.dataset.chEnc), decodeURIComponent(this.dataset.topicEnc))">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                            <div class="lecture-card-num">📚</div>
                            <button class="btn btn-ghost" style="padding:2px; font-size:0.9rem; min-width:unset; opacity:0.7" onclick="event.stopPropagation(); renameTopic(this.closest('.lecture-card').dataset.chEnc, this.closest('.lecture-card').dataset.topicEnc)" title="Rename Topic">✏️</button>
                        </div>
                        <div class="lecture-card-title">${topic}</div>
                        <div class="lecture-card-count">${totalQ} Question${totalQ !== 1 ? 's' : ''}</div>
                    </div>`;
        }).join("");
    } else {
        const uniqueLectures = [...new Set(lecs.map(q => q.lecture))].sort((a, b) => Number(a) - Number(b));
        grid.innerHTML = uniqueLectures.map(lecNum => {
            const lecData = lecs.filter(q => Number(q.lecture) === Number(lecNum));
            const totalQ = lecData.reduce((sum, x) => sum + (Array.isArray(x.questions) ? x.questions.length : (x.questionCount || 0)), 0);
            const hasMulti = lecData.some(x => Array.isArray(x.questions) && x.questions.some(y => y.isMultiCorrect));
            const firstLec = lecData[0];
            return `<div class="lecture-card ${hasMulti ? "has-multi" : ""}" data-ch="${ch.replace(/"/g, '&quot;')}" data-lec="${lecNum}" onclick="handleLectureNumClick(event, this, '${ch.replace(/'/g, "\\'")}', ${lecNum})">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                            <div class="lecture-card-num">L${lecNum}</div>
                            <button class="btn btn-ghost" style="padding:2px; font-size:0.9rem; min-width:unset; opacity:0.7" onclick='event.stopPropagation(); renameTopic(${jsString(encodeURIComponent(ch))}, ${jsString(encodeURIComponent(firstLec.topic || ""))})' title="Rename Topic">✏️</button>
                        </div>
                        <div class="lecture-card-title">${firstLec.topic || "<i style='opacity:0.5'>No Topic</i>"}</div>
                        <div class="lecture-card-count">${totalQ} Question${totalQ !== 1 ? 's' : ''}</div>
                        <div class="lecture-card-meta">${firstLec.updatedAt ? new Date(firstLec.updatedAt).toLocaleDateString() : "—"}</div>
                    </div>`;
        }).join("");
    }
}

async function handleLectureNumClick(e, el, ch, lecNum) {
    await ensureChapterLoaded(ch === "(No Chapter)" ? null : ch);
    const qs = allQuestions.filter(q => (q.chapter || "(No Chapter)") === ch && Number(q.lecture) === Number(lecNum));
    const allQs = qs.flatMap(q => q.questions || []);
    const totalQ = allQs.length;

    if (totalQ > 0) {
        mqCurrentChapter = ch;
        mqCurrentLectureNum = lecNum;
        mqCurrentTopic = null;
        mqPrevView = 'lecture';
        document.getElementById("mq-chapter-view").style.display = "none";
        document.getElementById("mq-lecture-view").style.display = "block";
        document.getElementById("mq-question-view").style.display = "none";
        setQuestionSelectButtonVisible(true);
        document.getElementById("mq-chapter-title").textContent = `${ch} - Lecture ${lecNum}`;
        document.getElementById("mq-lecture-count").textContent = `${totalQ} Question${totalQ !== 1 ? 's' : ''}`;
        const grid = document.getElementById("lectureCardsGrid");
        grid.className = "questions-view-grid";
        // Build navigation list for Prev/Next buttons
        _mqQuestionList = [];
        grid.innerHTML = allQs.map((sq, idx) => {
            const gi = allQuestions.findIndex(q => (q.chapter || "(No Chapter)") === ch && Number(q.lecture) === Number(lecNum) && q.questions?.includes(sq));
            const sqIdx = allQuestions[gi]?.questions?.indexOf(sq) ?? idx;
            _mqQuestionList.push({ gi, sqIdx });
            const isMulti = sq.isMultiCorrect || (sq.correctIndexes || [sq.correctIndex || 0]).length > 1;
            const previewText = stripMath((sq.question || "").substring(0, 60));
            const qKey = `${gi}:${sqIdx}`;
            const isChecked = selectedQuestions.has(qKey) ? 'checked' : '';
            const checkboxHtml = qSelectModeOn ? `<input type="checkbox" class="lec-checkbox" ${isChecked} onclick="event.stopPropagation(); toggleQuestionSelect(event, ${gi}, ${sqIdx})" style="position:absolute;top:8px;right:8px;width:18px;height:18px;cursor:pointer;accent-color:var(--accent);z-index:10">` : '';
            const clickHandler = qSelectModeOn ? `onclick="event.stopPropagation(); toggleQuestionSelect(event, ${gi}, ${sqIdx})"` : `onclick="showQuestionViewH(${gi}, ${sqIdx})"`;
            return `<div class="lecture-card ${isMulti ? "has-multi" : ""}" data-ch="${ch.replace(/"/g, '&quot;')}" data-lec="${lecNum}" data-qidx="${idx}" data-gi="${gi}" data-sqidx="${sqIdx}" style="position:relative" ${clickHandler}>
                        ${checkboxHtml}
                        <div class="lecture-card-num">Q${idx + 1}</div>
                        <div class="lecture-card-title">${previewText || 'Empty question'}</div>
                        <div class="lecture-card-count">${(sq.options || []).length} options</div>
                    </div>`;
        }).join("");
    }
}

async function handleTopicCardClick(e, el, ch, encodedTopic) {
    const topic = decodeURIComponent(encodedTopic);
    // Ensure chapter rows are fully loaded before accessing questions[]
    await ensureChapterLoaded(ch === "(No Chapter)" ? null : ch);
    const qs = allQuestions.filter(q => (q.chapter || "(No Chapter)") === ch && (q.topic || "(No Topic)") === topic);
    const totalQ = qs.reduce((sum, x) => sum + (x.questions?.length || 0), 0);
    if (qs.length > 0) {
        mqCurrentChapter = ch;
        mqCurrentTopic = topic;
        mqCurrentLectureNum = null;
        mqPrevView = 'topic';
        document.getElementById("mq-chapter-view").style.display = "none";
        document.getElementById("mq-lecture-view").style.display = "block";
        document.getElementById("mq-question-view").style.display = "none";
        setQuestionSelectButtonVisible(true);
        document.getElementById("mq-chapter-title").textContent = `${ch} - ${topic}`;
        document.getElementById("mq-lecture-count").textContent = `${totalQ} Question${totalQ !== 1 ? 's' : ''}`;
        renderTopicQuestionCards(ch, topic, qs);
    }
}

function renderTopicQuestionCards(ch, topic, qs) {
    const grid = document.getElementById("lectureCardsGrid");
    grid.className = "questions-view-grid";
    // Build navigation list for Prev/Next buttons
    _mqQuestionList = [];
    let qIndex = 1;
    grid.innerHTML = qs.flatMap(q => {
        return (q.questions || []).map((sq, sqIdx) => {
            const gi = allQuestions.indexOf(q);
            _mqQuestionList.push({ gi, sqIdx });
            const isMulti = sq.isMultiCorrect || (sq.correctIndexes || [sq.correctIndex || 0]).length > 1;
            const previewText = stripMath((sq.question || "").substring(0, 60));
            const qKey = `${gi}:${sqIdx}`;
            const isChecked = selectedQuestions.has(qKey) ? 'checked' : '';
            const checkboxHtml = qSelectModeOn ? `<input type="checkbox" class="lec-checkbox" ${isChecked} onclick="event.stopPropagation(); toggleQuestionSelect(event, ${gi}, ${sqIdx})" style="position:absolute;top:8px;right:8px;width:18px;height:18px;cursor:pointer;accent-color:var(--accent);z-index:10">` : '';
            const clickHandler = qSelectModeOn ? `onclick="event.stopPropagation(); toggleQuestionSelect(event, ${gi}, ${sqIdx})"` : `onclick="showQuestionViewH(${gi}, ${sqIdx})"`;
            return `<div class="lecture-card ${isMulti ? "has-multi" : ""}" data-ch="${ch.replace(/"/g, '&quot;')}" data-lec="${q.lecture}" data-qidx="${sqIdx}" data-gi="${gi}" data-sqidx="${sqIdx}" style="position:relative" ${clickHandler}>
                        ${checkboxHtml}
                        <div class="lecture-card-num">Q${qIndex++}</div>
                        <div class="lecture-card-title">${previewText || 'Empty question'}</div>
                        <div class="lecture-card-count">${sq.year ? "Year: " + sq.year : (q.topic || "")}</div>
                    </div>`;
        });
    }).join("");
}
function _openUnsavedModalForNav(delta) {
    const direction = delta > 0 ? "next" : "previous";
    const txt = document.getElementById("unsavedModalText");
    const saveBtn = document.getElementById("unsavedModalSaveBtn");
    const discardBtn = document.getElementById("unsavedModalDiscardBtn");
    if (txt) txt.textContent = `You have unsaved edits. Save before going to the ${direction} question?`;
    if (saveBtn) { saveBtn.innerHTML = "💾 Save & Continue"; }
    if (discardBtn) { discardBtn.textContent = "Discard & Continue"; }
}
function _openUnsavedModalForBack() {
    const txt = document.getElementById("unsavedModalText");
    const saveBtn = document.getElementById("unsavedModalSaveBtn");
    const discardBtn = document.getElementById("unsavedModalDiscardBtn");
    if (txt) txt.textContent = "You have unsaved edits. What would you like to do?";
    if (saveBtn) { saveBtn.innerHTML = "💾 Save & Go Back"; }
    if (discardBtn) { discardBtn.textContent = "Discard"; }
}
function navigateQuestion(delta) {
    // Only check for unsaved changes when the user is actively in edit mode
    if (_mqIsEditMode && (_hasUnsavedEdits || _originalEditSnapshot !== _getEditSnapshot())) {
        // Store intent and show unsaved modal with direction-aware text
        _pendingNavDelta = delta;
        _openUnsavedModalForNav(delta);
        openModal('unsavedModal');
        return;
    }
    _doNavigateQuestion(delta);
}
let _pendingNavDelta = 0;
function _doNavigateQuestion(delta) {
    const newIdx = mqCurrentSqIdx + delta;
    if (newIdx < 0 || newIdx >= _mqQuestionList.length) return;
    const entry = _mqQuestionList[newIdx];
    _hasUnsavedEdits = false;
    // Paper-wise entries only carry a rowId (see renderQuestionsForPaper);
    // chapter/topic/lecture entries carry gi+sqIdx as before.
    if (entry.rowId != null) {
        showQuestionByRowId(entry.rowId);
        history.pushState({ type: "mqQuestion", rowId: entry.rowId }, "", "");
    } else {
        const { gi, sqIdx } = entry;
        showQuestionView(gi, sqIdx);
        history.pushState({ type: "mqQuestion", idx: gi, sqIdx }, "", "");
    }
}
function handleLecCardClick(e, el) {
    const ch = el.dataset.ch;
    const lec = el.dataset.lec;
    const gi = parseInt(el.dataset.gi);
    const idx = parseInt(el.dataset.idx);
    showQuestionViewH(gi);
}
function showLectureView() {
    document.getElementById("mq-chapter-view").style.display = "none";
    document.getElementById("mq-lecture-view").style.display = "block";
    document.getElementById("mq-question-view").style.display = "none";
    if (mqCurrentChapter) showLectureViewForChapter(mqCurrentChapter);
}

let _mqIsEditMode = false;
let _mqCurrentViewGi = null;
let _mqCurrentViewSqIdx = undefined;

/* ── Manage edit-mode image staging ──────────────────────────────────
   Holds in-progress image edits keyed by sub-question index (si):
     { [si]: { questionImages: string[], optionImages: (string|null)[] } }
   Populated when entering edit mode and consumed by saveInlineEdit().  */
let _mqEditImages = {};

function _mqImgSrc(imgData) {
    if (!imgData) return "";
    if (imgData.startsWith('http://') || imgData.startsWith('https://') || imgData.startsWith('data:')) return imgData;
    return impB64ToDataUrl(imgData);
}

// Build the editable question-image zone HTML for sub-question `si`.
function mqBuildQImgEditZone(si) {
    const imgs = (_mqEditImages[si] && _mqEditImages[si].questionImages) || [];
    const thumbs = imgs.map((img, ii) => `
                <div style="position:relative;display:inline-block;border-radius:var(--radius-sm);overflow:hidden;border:1px solid var(--border);background:rgba(0,0,0,0.1)">
                    <img src="${_mqImgSrc(img)}" alt="Question image ${ii + 1}" style="max-width:160px;max-height:140px;display:block;object-fit:contain">
                    <button type="button" onclick="mqEditRemoveQuestionImage(${si},${ii})" title="Remove image" style="position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;border:none;background:rgba(242,92,92,0.92);color:#fff;font-size:0.8rem;line-height:1;cursor:pointer">✕</button>
                </div>`).join('');
    return `
                <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px">${thumbs}</div>
                <label class="mq-img-upload-btn" style="display:inline-flex;align-items:center;gap:6px;padding:7px 13px;background:rgba(86,169,255,0.12);border:1px solid rgba(86,169,255,0.3);border-radius:var(--radius-sm);font-size:0.78rem;color:var(--accent);cursor:pointer;font-weight:600">
                    📷 ${imgs.length ? 'Add another image' : 'Upload question image'}
                    <input type="file" accept="image/*" style="display:none" onchange="mqEditAddQuestionImage(${si}, this)">
                </label>`;
}

async function mqEditAddQuestionImage(si, input) {
    const f = input.files && input.files[0];
    if (!f) return;
    const b64 = await impFileToB64(f);
    if (!_mqEditImages[si]) _mqEditImages[si] = { questionImages: [], optionImages: [null, null, null, null] };
    if (!Array.isArray(_mqEditImages[si].questionImages)) _mqEditImages[si].questionImages = [];
    _mqEditImages[si].questionImages.push(b64);
    input.value = "";
    const zone = document.getElementById(`mqQImgZone_${si}`);
    if (zone) zone.innerHTML = mqBuildQImgEditZone(si);
    _hasUnsavedEdits = true;
}

function mqEditRemoveQuestionImage(si, ii) {
    if (_mqEditImages[si] && Array.isArray(_mqEditImages[si].questionImages)) {
        _mqEditImages[si].questionImages.splice(ii, 1);
    }
    const zone = document.getElementById(`mqQImgZone_${si}`);
    if (zone) zone.innerHTML = mqBuildQImgEditZone(si);
    _hasUnsavedEdits = true;
}

// Build the editable option-image control HTML for option `oi` of sub-question `si`.
function mqBuildOptImgEditZone(si, oi) {
    const img = (_mqEditImages[si] && _mqEditImages[si].optionImages && _mqEditImages[si].optionImages[oi]) || null;
    const preview = img ? `
                <div style="position:relative;display:inline-block;margin-top:6px;border-radius:4px;overflow:hidden;border:1px solid var(--border)">
                    <img src="${_mqImgSrc(img)}" alt="Option image" style="max-width:120px;max-height:90px;display:block;object-fit:contain">
                    <button type="button" onclick="mqEditRemoveOptImage(${si},${oi})" title="Remove image" style="position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;border:none;background:rgba(242,92,92,0.92);color:#fff;font-size:0.72rem;line-height:1;cursor:pointer">✕</button>
                </div>` : '';
    return `
                <label style="display:inline-flex;align-items:center;gap:5px;margin-top:5px;padding:4px 9px;background:rgba(86,169,255,0.1);border:1px solid rgba(86,169,255,0.25);border-radius:4px;font-size:0.7rem;color:var(--accent);cursor:pointer;font-weight:600">
                    📷 ${img ? 'Replace image' : 'Add image'}
                    <input type="file" accept="image/*" style="display:none" onchange="mqEditSetOptImage(${si},${oi}, this)">
                </label>
                <div id="mqOptImgPreview_${si}_${oi}">${preview}</div>`;
}

async function mqEditSetOptImage(si, oi, input) {
    const f = input.files && input.files[0];
    if (!f) return;
    const b64 = await impFileToB64(f);
    if (!_mqEditImages[si]) _mqEditImages[si] = { questionImages: [], optionImages: [null, null, null, null] };
    if (!Array.isArray(_mqEditImages[si].optionImages)) _mqEditImages[si].optionImages = [null, null, null, null];
    _mqEditImages[si].optionImages[oi] = b64;
    input.value = "";
    const zone = document.getElementById(`mqOptImgZone_${si}_${oi}`);
    if (zone) zone.innerHTML = mqBuildOptImgEditZone(si, oi);
    _hasUnsavedEdits = true;
}

function mqEditRemoveOptImage(si, oi) {
    if (_mqEditImages[si] && Array.isArray(_mqEditImages[si].optionImages)) {
        _mqEditImages[si].optionImages[oi] = null;
    }
    const zone = document.getElementById(`mqOptImgZone_${si}_${oi}`);
    if (zone) zone.innerHTML = mqBuildOptImgEditZone(si, oi);
    _hasUnsavedEdits = true;
}

// Build the editable solution-image zone HTML for sub-question `si`.
function mqBuildSolImgEditZone(si) {
    const imgs = (_mqEditImages[si] && _mqEditImages[si].solutionImages) || [];
    const thumbs = imgs.map((img, ii) => `
                <div style="position:relative;display:inline-block;border-radius:var(--radius-sm);overflow:hidden;border:1px solid var(--border);background:rgba(0,0,0,0.1)">
                    <img src="${_mqImgSrc(img)}" alt="Solution image ${ii + 1}" style="max-width:160px;max-height:140px;display:block;object-fit:contain">
                    <button type="button" onclick="mqEditRemoveSolutionImage(${si},${ii})" title="Remove image" style="position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;border:none;background:rgba(242,92,92,0.92);color:#fff;font-size:0.8rem;line-height:1;cursor:pointer">✕</button>
                </div>`).join('');
    return `
                <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px">${thumbs}</div>
                <label style="display:inline-flex;align-items:center;gap:6px;padding:7px 13px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);border-radius:var(--radius-sm);font-size:0.78rem;color:#10b981;cursor:pointer;font-weight:600">
                    🖼 ${imgs.length ? 'Add another solution image' : 'Add solution image'}
                    <input type="file" accept="image/*" style="display:none" onchange="mqEditAddSolutionImage(${si}, this)">
                </label>`;
}

async function mqEditAddSolutionImage(si, input) {
    const f = input.files && input.files[0];
    if (!f) return;
    const b64 = await impFileToB64(f);
    if (!_mqEditImages[si]) _mqEditImages[si] = { questionImages: [], optionImages: [null, null, null, null], solutionImages: [] };
    if (!Array.isArray(_mqEditImages[si].solutionImages)) _mqEditImages[si].solutionImages = [];
    _mqEditImages[si].solutionImages.push(b64);
    input.value = "";
    const zone = document.getElementById(`mqSolImgZone_${si}`);
    if (zone) zone.innerHTML = mqBuildSolImgEditZone(si);
    _hasUnsavedEdits = true;
}

function mqEditRemoveSolutionImage(si, ii) {
    if (_mqEditImages[si] && Array.isArray(_mqEditImages[si].solutionImages)) {
        _mqEditImages[si].solutionImages.splice(ii, 1);
    }
    const zone = document.getElementById(`mqSolImgZone_${si}`);
    if (zone) zone.innerHTML = mqBuildSolImgEditZone(si);
    _hasUnsavedEdits = true;
}

async function showQuestionView(gi, sqIdx) {
    mqCurrentLectureIdx = gi;
    _mqCurrentViewGi = gi;
    _mqCurrentViewSqIdx = sqIdx;
    _mqIsEditMode = false;
    // Lazy-load the row if needed before accessing its questions
    const q = await ensureRowLoaded(gi);
    if (!q) return;
    // If sqIdx provided, only show that specific sub-question
    const filterSingle = typeof sqIdx === "number";
    const subsToRender = filterSingle ? [[q.questions[sqIdx], sqIdx]] : (q.questions || []).map((s, i) => [s, i]);
    document.getElementById("mq-lecture-view").style.display = "none";
    document.getElementById("mq-question-view").style.display = "block";
    document.getElementById("mq-question-title").textContent = `${formatChapterLabel(q.chapter)} — Set ${q.lecture}`;

    // Show PYQ badge if this is a PYQ lecture
    const existingPyqBadge = document.getElementById("mq-pyq-badge");
    if (existingPyqBadge) existingPyqBadge.remove();
    if (q.lecture && String(q.lecture).startsWith("PYQ-")) {
        // Parse: PYQ-{year}-{month}-{date}-{shift}
        const parts = String(q.lecture).replace(/^PYQ-/, "").split("-");
        const pyqYear = parts[0] || "";
        const pyqMonth = parts[1] || "";
        const pyqDate = parts[2] || "";
        const pyqShift = parts.slice(3).join(" ") || "";
        const badge = document.createElement("div");
        badge.id = "mq-pyq-badge";
        badge.style.cssText = "position:absolute;top:0;right:0;background:linear-gradient(135deg,rgba(91,95,239,0.18),rgba(91,95,239,0.08));border:1px solid rgba(91,95,239,0.35);border-radius:10px;padding:6px 14px;display:flex;flex-direction:column;align-items:flex-end;gap:1px;z-index:2";
        badge.innerHTML = `<span style="font-size:0.62rem;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:0.5px">🏛️ PYQ</span><span style="font-size:0.82rem;font-weight:800;color:var(--text)">${pyqYear} ${pyqMonth} ${pyqDate}</span><span style="font-size:0.72rem;color:var(--text-dim)">${pyqShift} Shift</span>`;
        // Attach to the qview-top-row
        const titleBlock = document.querySelector(".qview-title-block");
        if (titleBlock) { titleBlock.style.position = "relative"; titleBlock.appendChild(badge); }
    }

    // Hide toolbar and select buttons in question view
    const toolbar = document.getElementById("lec-toolbar");
    if (toolbar) toolbar.style.display = "none";
    document.getElementById("lecSelectModeQBtn").style.display = "none";

    // Find position in the navigation list. Paper-wise entries are keyed
    // by rowId (no gi/sqIdx — see renderQuestionsForPaper), so match on
    // the wrapped row's _rowId in that case instead.
    const listIdx = (q._rowId != null)
        ? _mqQuestionList.findIndex(e => e.rowId === q._rowId)
        : _mqQuestionList.findIndex(e => e.gi === gi && (sqIdx === undefined || e.sqIdx === sqIdx));
    mqCurrentSqIdx = listIdx;
    const inList = _mqQuestionList.length > 1;
    const posLabel = inList && listIdx >= 0 ? ` · ${listIdx + 1} / ${_mqQuestionList.length}` : '';
    document.getElementById("mq-question-subtitle").textContent = filterSingle
        ? `Question ${sqIdx + 1} of ${(q.questions || []).length}${posLabel}`
        : `${(q.questions || []).length} question(s) · ${q.updatedAt ? new Date(q.updatedAt).toLocaleDateString() : "—"}${q.lecture && String(q.lecture).startsWith("PYQ-") ? " · 🏛️ Previous Year Question" : ""}`;

    // Show/hide & enable/disable prev/next buttons
    const prevBtn = document.getElementById('mq-prev-btn');
    const nextBtn = document.getElementById('mq-next-btn');
    if (prevBtn) { prevBtn.style.display = inList ? '' : 'none'; prevBtn.disabled = listIdx <= 0; }
    if (nextBtn) { nextBtn.style.display = inList ? '' : 'none'; nextBtn.disabled = listIdx < 0 || listIdx >= _mqQuestionList.length - 1; }

    // Show view-mode buttons, hide edit-mode buttons
    _mqSetViewModeButtons(true);

    // ── RENDER VIEW-ONLY MODE ──
    const el = document.getElementById("mq-question-content");
    // Store hidden data for edit mode
    el.innerHTML = `<input type="hidden" id="iqe-chapter" value="${q.chapter || ""}">
            <input type="hidden" id="iqe-lecture" value="${q.lecture}">
            <div id="iqe-questions-container">
                ${subsToRender.map(([sub, si]) => {
        const isNoneCorrect = !!sub.isNoneCorrect;
        const isNumerical = (sub.question_type || "").toUpperCase() === "INTEGER" || (sub.numericalAnswer !== undefined && sub.numericalAnswer !== null) || (Array.isArray(sub.options) && sub.options.every(function (o) { return !o || String(o).trim() === ''; }) && (!Array.isArray(sub.optionImages) || sub.optionImages.every(function (im) { return !im; })) && !_hasAnyOptionTable(mqGetOptionTables(sub)));
        const ci = isNoneCorrect ? [] : (sub.correctIndexes || [sub.correctIndex || 0]);
        const questionImages = getQuestionImages(sub);
        const imgHtml = questionImages.length ? `<div style="margin-bottom:14px;display:flex;flex-direction:column;gap:10px">${questionImages.map((imgData, imgIdx) => {
            const isUrl = imgData.startsWith('http://') || imgData.startsWith('https://');
            const imgSrc = isUrl ? imgData : `data:${imgData.startsWith('/9j/') ? 'image/jpeg' : imgData.startsWith('iVBOR') ? 'image/png' : 'image/jpeg'};base64,${imgData}`;
            return `<div style="text-align:center;display:flex;justify-content:center;align-items:center;"><img src="${imgSrc}" alt="Question diagram ${imgIdx + 1}" style="max-width:100%;max-height:280px;display:block;object-fit:contain;cursor:pointer;border-radius:var(--radius-sm)" onclick="this.style.maxHeight=this.style.maxHeight=='none'?'280px':'none'" onerror="this.parentElement.innerHTML='<div style=\\'padding:12px;color:var(--error);font-size:0.82rem\\'>⚠️ Image failed to load</div>'"></div>`;
        }).join('')}</div>` : '';
        const isMulti = sub.isMultiCorrect || ci.length > 1;
        const hasImg = questionImages.length > 0;
        const layoutContent = hasImg
            ? `<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
                   <div style="flex:1.3;min-width:280px">
                       <div class="q-render-preview" id="iqe_preview_${si}"></div>
                       <div id="iqe_tables_intro_${si}"></div>
                       ${isNumerical
                ? `<div style="padding:8px 12px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);border-radius:6px;font-size:0.82rem">
                                    <span style="font-weight:700;color:#a78bfa">Numerical Answer: </span>
                                    <span style="color:var(--text);font-weight:600;font-size:1rem">${String(sub.numericalAnswer ?? sub.correct_answer ?? 'N/A')}</span>
                               </div>`
                : `<div style="margin-bottom:14px">
                                    ${LETTERS.map((l, oi) => `<div class="opt-render-row ${ci.includes(oi) ? "is-correct" : ""}"><span class="opt-letter">${l}</span><div id="iqe_opt_render_${si}_${oi}"></div>${ci.includes(oi) ? '<span style="margin-left:auto;font-size:0.7rem;color:var(--success);font-weight:700">✓ Correct</span>' : ""}</div>`).join("")}
                                    ${isNoneCorrect ? '<div style="margin-top:10px;padding:8px 12px;background:rgba(245,158,11,0.1);border:1px dashed rgba(245,158,11,0.45);border-radius:6px;font-size:0.76rem;color:#f59e0b;font-weight:600">⊘ None of the options is correct — every student gets full marks for this question.</div>' : ""}
                               </div>`}
                       <div id="iqe_tables_options_${si}"></div>
                   </div>
                   <div style="flex:0.7;min-width:280px;max-width:440px;margin-bottom:14px;align-self:stretch;display:flex;flex-direction:column;justify-content:center">
                       ${imgHtml}
                   </div>
               </div>`
            : `<div class="q-render-preview" id="iqe_preview_${si}"></div>
               <div id="iqe_tables_intro_${si}"></div>
               ${isNumerical
                ? `<div style="padding:8px 12px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);border-radius:6px;font-size:0.82rem">
                            <span style="font-weight:700;color:#a78bfa">Numerical Answer: </span>
                            <span style="color:var(--text);font-weight:600;font-size:1rem">${String(sub.numericalAnswer ?? sub.correct_answer ?? 'N/A')}</span>
                       </div>`
                : `<div style="margin-bottom:14px">
                            ${LETTERS.map((l, oi) => `<div class="opt-render-row ${ci.includes(oi) ? "is-correct" : ""}"><span class="opt-letter">${l}</span><div id="iqe_opt_render_${si}_${oi}"></div>${ci.includes(oi) ? '<span style="margin-left:auto;font-size:0.7rem;color:var(--success);font-weight:700">✓ Correct</span>' : ""}</div>`).join("")}
                            ${isNoneCorrect ? '<div style="margin-top:10px;padding:8px 12px;background:rgba(245,158,11,0.1);border:1px dashed rgba(245,158,11,0.45);border-radius:6px;font-size:0.76rem;color:#f59e0b;font-weight:600">⊘ None of the options is correct — every student gets full marks for this question.</div>' : ""}
                       </div>`}
               <div id="iqe_tables_options_${si}"></div>`;

        return `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-bottom:14px">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
                            <div style="font-size:0.7rem;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:0.6px">Question ${si + 1}${sub.year && String(sub.year).trim() ? ` <span style="font-size:0.68rem;background:rgba(91,95,239,0.12);color:var(--accent-2);padding:2px 7px;border-radius:20px;font-weight:700;text-transform:none;letter-spacing:normal;display:inline-flex;align-items:center;gap:3px">🏛️ ${sub.exam || sub.examName || sub.exam_name || sub.exam_label || (String(sub.subject || '').toLowerCase().includes('bio') ? 'NEET' : 'JEE Main')} ${sub.year}${sub.month ? ' ' + sub.month : ''}${(sub.date || sub.day) ? ' ' + (sub.date || sub.day) : ''}${sub.shift ? ' (' + sub.shift + ')' : ''}</span>` : ''}${isMulti && !isNumerical ? ' <span style="color:var(--accent-4)">✦ Multi-correct</span>' : ""}${isNoneCorrect ? ' <span style="color:#f59e0b">⊘ None correct</span>' : ""}${isNumerical ? ' <span style="color:#a78bfa">🔢 Numerical</span>' : ""}</div>
                        </div>
                        ${layoutContent}
                        <div id="mqSolBlock_${si}"></div>
                    </div>`;
    }).join("")}
            </div>`;

    // Render math after DOM is fully inserted
    setTimeout(() => {
        subsToRender.forEach(([sub, si]) => {
            const isNumerical = (sub.question_type || "").toUpperCase() === "INTEGER" || (sub.numericalAnswer !== undefined && sub.numericalAnswer !== null) || (Array.isArray(sub.options) && sub.options.every(function (o) { return !o || String(o).trim() === ''; }) && (!Array.isArray(sub.optionImages) || sub.optionImages.every(function (im) { return !im; })) && !_hasAnyOptionTable(mqGetOptionTables(sub)));
            const prev = document.getElementById(`iqe_preview_${si}`);
            // Render any tables/matrices attached to this question.
            const _subTables = _normalizeTablesField(sub.tables);
            if (_subTables.length) {
                const introWrap = document.getElementById(`iqe_tables_intro_${si}`);
                const optWrap = document.getElementById(`iqe_tables_options_${si}`);
                const introTbls = _subTables.filter(t => (t.position || "after_intro") !== "after_options");
                const optTbls = _subTables.filter(t => (t.position || "after_intro") === "after_options");
                if (introWrap && introTbls.length) { introWrap.innerHTML = renderTablesHtml(introTbls); renderMath(introWrap); }
                if (optWrap && optTbls.length) { optWrap.innerHTML = renderTablesHtml(optTbls); renderMath(optWrap); }
            }
            // FIX: run through clientRepairLatex first so bare math tokens
            // (e.g. \neq, neq, !=, \le, \ge) get wrapped in $...$ and rendered
            // by KaTeX. Without this, the "not equal" sign (and similar) showed
            // up as literal text in the Manage section.
            if (prev) { prev.textContent = clientRepairLatex(sub.question || ""); renderMath(prev); }
            if (!isNumerical) {
                const optionImages = mqGetOptionImages(sub);
                const optionTables = mqGetOptionTables(sub);
                LETTERS.forEach((l, oi) => {
                    const optRender = document.getElementById(`iqe_opt_render_${si}_${oi}`);
                    if (optRender) {
                        const optImg = optionImages[oi];
                        const optTbl = optionTables[oi];
                        if (optTbl) {
                            // Option is itself a table (e.g. NEET match-the-following rows).
                            optRender.innerHTML = renderSingleTableHtml(optTbl);
                            renderMath(optRender);
                        } else if (optImg) {
                            const optMime = optImg.startsWith('http') ? null : (optImg.startsWith('/9j/') ? 'image/jpeg' : optImg.startsWith('iVBOR') ? 'image/png' : optImg.startsWith('R0lGOD') ? 'image/gif' : 'image/jpeg');
                            const imgSrc = optImg.startsWith('http') ? optImg : `data:${optMime};base64,${optImg}`;
                            optRender.innerHTML = `<img src="${imgSrc}" alt="Option ${l}" style="max-height:90px;max-width:100%;border-radius:4px;border:1px solid var(--border);object-fit:contain;display:block;margin-top:2px">`;
                        } else {
                            optRender.textContent = clientRepairLatex((sub.options && sub.options[oi]) || "");
                            renderMath(optRender);
                        }
                    }
                });
            }
            // Inject solution for this sub-question
            const solBlock = document.getElementById(`mqSolBlock_${si}`);
            if (solBlock && sub.solutions && sub.solutions.length > 0) {
                solBlock.innerHTML = mqBuildSolutionReadOnlyHTML(sub.solutions, si);
                ensureRenderMath(solBlock);
            }
        });
    }, 0);

    // Reset unsaved state
    _hasUnsavedEdits = false;
    _originalEditSnapshot = null;
}

function _mqSetViewModeButtons(isViewMode) {
    const editBtn = document.getElementById('mq-edit-btn');
    const deleteBtn = document.getElementById('mq-delete-btn');
    const saveBtn = document.getElementById('mq-save-btn');
    const cancelBtn = document.getElementById('mq-cancel-edit-btn');
    const addToPaperBtn = document.getElementById('mq-add-to-paper-btn');
    const solutionBtn = document.getElementById('mq-solution-btn');
    if (editBtn) editBtn.style.display = isViewMode ? '' : 'none';
    if (deleteBtn) deleteBtn.style.display = isViewMode ? '' : 'none';
    if (saveBtn) saveBtn.style.display = isViewMode ? 'none' : '';
    if (cancelBtn) cancelBtn.style.display = isViewMode ? 'none' : '';
    // Add to Paper only visible in view mode
    if (addToPaperBtn) addToPaperBtn.style.display = isViewMode ? '' : 'none';
    if (solutionBtn) solutionBtn.style.display = '';
    if (isViewMode && addToPaperBtn) _updateAddToPaperBtn();
}

function _mqSetSolutionEditorsVisible(isVisible) {
    const content = document.getElementById('mq-question-content');
    if (!content) return;

    content.querySelectorAll('[id^="impSolEditPanel_"]').forEach(panel => {
        panel.style.display = isVisible ? 'block' : 'none';
    });
    content.querySelectorAll('[id^="impSolBody_"]').forEach(body => {
        body.style.display = 'block';
    });
    content.querySelectorAll('[id^="impSolEditBtn_"]').forEach(btn => {
        btn.innerHTML = isVisible ? '✕ Close Edit' : '✏ Edit';
        btn.style.background = isVisible ? 'rgba(86,169,255,0.25)' : 'rgba(86,169,255,0.12)';
    });
}

function mqEditCurrentSolution() {
    const gi = _mqCurrentViewGi;
    const q = allQuestions[gi];
    if (!q || !Array.isArray(q.questions) || !q.questions.length) return;
    const sqIdx = Number.isInteger(_mqCurrentViewSqIdx) ? _mqCurrentViewSqIdx : 0;
    const targetIdx = Math.max(0, Math.min(sqIdx, q.questions.length - 1));
    const solutionBtn = document.getElementById(`impSolEditBtn_${targetIdx}`);
    const solutionBody = document.getElementById(`impSolBody_${targetIdx}`);

    if (solutionBody) {
        solutionBody.style.display = 'block';
        solutionBody.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    if (solutionBtn) {
        solutionBtn.click();
        return;
    }

    // If the solution block is not in the DOM yet, re-render the current question view
    // and try again once the solution HTML has been inserted.
    if (_mqIsEditMode) {
        showQuestionView(gi, _mqCurrentViewSqIdx);
        mqEnterEditMode();
    } else {
        showQuestionView(gi, _mqCurrentViewSqIdx);
    }

    setTimeout(() => {
        const retryBtn = document.getElementById(`impSolEditBtn_${targetIdx}`);
        const retryBody = document.getElementById(`impSolBody_${targetIdx}`);
        if (retryBody) retryBody.style.display = 'block';
        if (retryBtn) retryBtn.click();
    }, 0);
}

function mqEnterEditMode() {
    _mqIsEditMode = true;
    const gi = _mqCurrentViewGi;
    const sqIdx = _mqCurrentViewSqIdx;
    const q = allQuestions[gi]; if (!q) return;
    const filterSingle = typeof sqIdx === "number";
    const subsToRender = filterSingle ? [[q.questions[sqIdx], sqIdx]] : (q.questions || []).map((s, i) => [s, i]);

    // Seed the image-staging store from the current question data so the
    // upload/preview/remove controls reflect existing images.
    _mqEditImages = {};
    subsToRender.forEach(([sub, si]) => {
        _mqEditImages[si] = {
            questionImages: (getQuestionImages(sub) || []).filter(Boolean),
            optionImages: mqGetOptionImages(sub),
            solutionImages: mqGetSolutionImages(sub)
        };
    });

    _mqSetViewModeButtons(false);

    const el = document.getElementById("mq-question-content");
    el.innerHTML = `<div class="form-row" style="margin-bottom:16px">
                <div class="field"><label>Chapter</label><input id="iqe-chapter" value="${q.chapter || ""}" list="existingChapters" style="background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 13px;color:var(--text);font-size:0.87rem;outline:none;width:100%;font-family:'Outfit',sans-serif"></div>
                <input type="hidden" id="iqe-lecture" value="${q.lecture}">
            </div>
            <div id="iqe-questions-container">
                ${subsToRender.map(([sub, si]) => {
        const ci = sub.correctIndexes || [sub.correctIndex || 0];
        const questionImages = getQuestionImages(sub);
        const isMulti = sub.isMultiCorrect || ci.length > 1;
        const isNoneCorrect = !!sub.isNoneCorrect;
        const isNumerical = (sub.question_type || "").toUpperCase() === "INTEGER" || (sub.numericalAnswer !== undefined && sub.numericalAnswer !== null) || (Array.isArray(sub.options) && sub.options.every(function (o) { return !o || String(o).trim() === ''; }) && (!Array.isArray(sub.optionImages) || sub.optionImages.every(function (im) { return !im; })) && !_hasAnyOptionTable(mqGetOptionTables(sub)));
        return `<div data-orig-idx="${si}" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-bottom:14px">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
                            <div style="font-size:0.7rem;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:0.6px">Question ${si + 1}${sub.year && String(sub.year).trim() ? ` <span style="font-size:0.68rem;background:rgba(91,95,239,0.12);color:var(--accent-2);padding:2px 7px;border-radius:20px;font-weight:700;text-transform:none;letter-spacing:normal;display:inline-flex;align-items:center;gap:3px">🏛️ ${sub.exam || sub.examName || sub.exam_name || sub.exam_label || (String(sub.subject || '').toLowerCase().includes('bio') ? 'NEET' : 'JEE Main')} ${sub.year}${sub.month ? ' ' + sub.month : ''}${(sub.date || sub.day) ? ' ' + (sub.date || sub.day) : ''}${sub.shift ? ' (' + sub.shift + ')' : ''}</span>` : ''}${isNumerical ? ' <span style="color:#a78bfa">🔢 Numerical</span>' : ""}</div>
                            ${isNumerical ? '' : `<label class="multi-toggle-label">
                                <input type="checkbox" id="iqe_multi_${si}" ${isMulti ? "checked" : ""} onchange="toggleMultiCorrect(${si})">
                                <span class="multi-toggle-text">${isMulti ? "✦ Multi-correct" : "○ Single-correct"}</span>
                            </label>`}
                        </div>
                        ${isNumerical ? '' : `<div style="margin-bottom:14px">
                            <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:8px">Question Image(s)</div>
                            <div id="mqQImgZone_${si}">${mqBuildQImgEditZone(si)}</div>
                        </div>`}
                        <div class="q-render-preview" id="iqe_preview_${si}"></div>
                        <div class="field"><label>Edit Raw Text ($math$ for equations)</label>
                            <textarea id="iqe_qt_${si}" rows="2" oninput="updatePreview(${si})" style="width:100%;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;color:var(--text);font-family:'JetBrains Mono',monospace;font-size:0.85rem;resize:vertical;outline:none">${sub.question}</textarea>
                        </div>
                        ${isNumerical
                ? `<div style="padding:8px 12px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);border-radius:6px;font-size:0.82rem">
                                <span style="font-weight:700;color:#a78bfa">Numerical Answer: </span>
                                <span style="color:var(--text);font-weight:600;font-size:1rem">${String(sub.numericalAnswer ?? sub.correct_answer ?? 'N/A')}</span>
                               </div>`
                : `<div style="margin-bottom:14px">
                            ${LETTERS.map((l, oi) => `<div class="opt-render-row ${ci.includes(oi) ? "is-correct" : ""}"><span class="opt-letter">${l}</span><div id="iqe_opt_render_${si}_${oi}"></div></div>`).join("")}
                        </div>
                        <div class="options-grid">
                            ${LETTERS.map((l, oi) => `<div class="field"><label>Edit Option ${l}</label><input id="iqe_opt_${si}_${oi}" value="${(sub.options && sub.options[oi] || "").replace(/"/g, "&quot;")}" oninput="updateOptRender(${si},${oi})" style="background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 12px;color:var(--text);font-size:0.85rem;outline:none;width:100%;font-family:'Outfit',sans-serif"><div id="mqOptImgZone_${si}_${oi}">${mqBuildOptImgEditZone(si, oi)}</div></div>`).join("")}
                        </div>
                        <div style="margin-top:10px" id="iqe_correct_wrap_${si}" data-none="${isNoneCorrect ? '1' : '0'}"><label style="font-size:0.75rem;color:var(--text-dim);display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.4px">Correct Answer(s):</label>
                            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
                                ${LETTERS.map((l, oi) => `<button type="button" class="correct-btn ${(!isNoneCorrect && ci.includes(oi)) ? "selected" : ""}" data-si="${si}" data-oi="${oi}" data-multi="${isMulti}" ${isNoneCorrect ? "disabled style=\"opacity:0.4;cursor:not-allowed\"" : ""} onclick="toggleCorrectAnswer(${si}, ${oi})">${l}</button>`).join("")}
                                <button type="button" class="correct-btn correct-btn-none ${isNoneCorrect ? "selected" : ""}" id="iqe_none_btn_${si}" data-si="${si}" title="No option is correct — students get full marks" onclick="toggleNoneCorrect(${si})" style="${isNoneCorrect ? "background:rgba(245,158,11,0.18);border-color:#f59e0b;color:#f59e0b" : ""}">⊘ None</button>
                            </div>
                            <div id="iqe_none_note_${si}" style="display:${isNoneCorrect ? 'block' : 'none'};margin-top:6px;font-size:0.72rem;color:#f59e0b;font-weight:600">⊘ "None correct" — every student gets full marks for this question.</div>
                        </div>`}
                        <div id="mqSolBlock_${si}"></div>
                    </div>`;
    }).join("")}
            </div>`;

    // Render math after DOM is fully inserted
    setTimeout(() => {
        subsToRender.forEach(([sub, si]) => {
            const isNumerical = (sub.question_type || "").toUpperCase() === "INTEGER" || (sub.numericalAnswer !== undefined && sub.numericalAnswer !== null) || (Array.isArray(sub.options) && sub.options.every(function (o) { return !o || String(o).trim() === ''; }) && (!Array.isArray(sub.optionImages) || sub.optionImages.every(function (im) { return !im; })) && !_hasAnyOptionTable(mqGetOptionTables(sub)));
            const prev = document.getElementById(`iqe_preview_${si}`);
            // FIX: repair LaTeX (wrap bare \neq, neq, !=, \le, \ge … in $...$)
            // before rendering so the "not equal" sign renders in edit mode too.
            if (prev) { prev.textContent = clientRepairLatex(sub.question || ""); renderMath(prev); }
            if (!isNumerical) {
                const _editOptTables = mqGetOptionTables(sub);
                LETTERS.forEach((l, oi) => {
                    const optRender = document.getElementById(`iqe_opt_render_${si}_${oi}`);
                    if (optRender) {
                        const optImg = Array.isArray(sub.optionImages) ? (sub.optionImages[oi] || null) : null;
                        const optTbl = _editOptTables[oi];
                        if (optTbl) {
                            optRender.innerHTML = renderSingleTableHtml(optTbl);
                            renderMath(optRender);
                            // The plain-text input cannot represent a table — disable it so
                            // the table data isn't accidentally overwritten on save.
                            const inp = document.getElementById(`iqe_opt_${si}_${oi}`);
                            if (inp) {
                                inp.disabled = true;
                                inp.placeholder = '📊 Table option (edit table data in JSON / re-upload)';
                                inp.style.opacity = '0.55';
                            }
                        } else if (optImg) {
                            const optMime = optImg.startsWith('http') ? null : (optImg.startsWith('/9j/') ? 'image/jpeg' : optImg.startsWith('iVBOR') ? 'image/png' : optImg.startsWith('R0lGOD') ? 'image/gif' : 'image/jpeg');
                            const imgSrc = optImg.startsWith('http') ? optImg : `data:${optMime};base64,${optImg}`;
                            optRender.innerHTML = `<img src="${imgSrc}" alt="Option ${l}" style="max-height:90px;max-width:100%;border-radius:4px;border:1px solid var(--border);object-fit:contain;display:block;margin-top:2px">`;
                        } else {
                            optRender.textContent = clientRepairLatex((sub.options && sub.options[oi]) || "");
                            renderMath(optRender);
                        }
                    }
                });
            } // !isNumerical
            // Inject solution for this sub-question
            const solBlock = document.getElementById(`mqSolBlock_${si}`);
            if (solBlock && sub.solutions && sub.solutions.length > 0) {
                solBlock.innerHTML = mqBuildSolutionReadOnlyHTML(sub.solutions, si);
                ensureRenderMath(solBlock);
            }

            const editHost = document.querySelector(`#iqe-questions-container [data-orig-idx="${si}"]`);
            if (editHost && !document.getElementById(`mqSolEditArea_${si}`)) {
                const existingText = Array.isArray(sub.solutions) && sub.solutions.length > 0
                    ? String(sub.solutions[0]?.text || sub.solutions[0]?.content || sub.solutions[0]?.solution || sub.solutions[0]?.explanation || '')
                    : '';
                const editor = document.createElement('div');
                editor.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px solid rgba(16,185,129,0.2)';
                editor.innerHTML = `
                            <label style="font-size:0.75rem;color:var(--text-dim);display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.4px">Edit Solution</label>
                            <textarea id="mqSolEditArea_${si}" rows="5" placeholder="Type the solution here..." style="width:100%;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;color:var(--text);font-family:'JetBrains Mono',monospace;font-size:0.85rem;resize:vertical;outline:none;line-height:1.6;box-sizing:border-box">${escapeHtml(existingText)}</textarea>
                            <div style="margin-top:10px">
                                <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:8px">Solution Image(s)</div>
                                <div id="mqSolImgZone_${si}">${mqBuildSolImgEditZone(si)}</div>
                            </div>
                        `;
                editHost.appendChild(editor);
            }
        });
    }, 0);

    // Track unsaved edits
    _hasUnsavedEdits = false;
    requestAnimationFrame(() => {
        setTimeout(() => {
            _originalEditSnapshot = _getEditSnapshot();
            // Attach oninput listeners to mark edits
            document.querySelectorAll('#mq-question-content textarea, #mq-question-content input:not([type="hidden"]), #mq-question-content select').forEach(el => {
                el.addEventListener('input', () => { _hasUnsavedEdits = true; });
            });
        }, 120);
    });
}

function mqExitEditMode() {
    const snapshotChanged = _originalEditSnapshot && _originalEditSnapshot !== _getEditSnapshot();
    if (_hasUnsavedEdits || snapshotChanged) {
        _openUnsavedModalForBack();
        _pendingNavDelta = 0;
        // Override the modal actions to exit edit mode instead of going back
        const saveAndGoBackFn = window.saveAndGoBack;
        const discardAndGoBackFn = window.discardAndGoBack;
        window.saveAndGoBack = async function () {
            closeModal('unsavedModal');
            await saveInlineEdit();
            _hasUnsavedEdits = false;
            // After save, reload view mode
            showQuestionView(_mqCurrentViewGi, _mqCurrentViewSqIdx);
            // Restore original functions
            window.saveAndGoBack = saveAndGoBackFn;
            window.discardAndGoBack = discardAndGoBackFn;
        };
        window.discardAndGoBack = function () {
            closeModal('unsavedModal');
            _hasUnsavedEdits = false;
            showQuestionView(_mqCurrentViewGi, _mqCurrentViewSqIdx);
            // Restore original functions
            window.saveAndGoBack = saveAndGoBackFn;
            window.discardAndGoBack = discardAndGoBackFn;
        };
        openModal('unsavedModal');
    } else {
        _hasUnsavedEdits = false;
        showQuestionView(_mqCurrentViewGi, _mqCurrentViewSqIdx);
    }
}

function _getEditSnapshot() {
    const ch = document.getElementById('iqe-chapter')?.value || '';
    const lec = document.getElementById('iqe-lecture')?.value || '';
    const containers = document.querySelectorAll('#iqe-questions-container > div');
    let snap = ch + '::' + lec + '::';
    containers.forEach((c, si) => {
        const origIdx = c.dataset.origIdx !== undefined ? parseInt(c.dataset.origIdx) : si;
        snap += (document.getElementById(`iqe_qt_${origIdx}`)?.value || '') + '|';
        LETTERS.forEach((_, oi) => { snap += (document.getElementById(`iqe_opt_${origIdx}_${oi}`)?.value || '') + '|'; });
        const wrap = document.getElementById(`iqe_correct_wrap_${origIdx}`);
        const isNone = wrap && wrap.dataset.none === '1';
        const selectedBtns = wrap ? wrap.querySelectorAll('.correct-btn:not(.correct-btn-none).selected') : [];
        snap += 'none:' + (isNone ? '1' : '0') + '|';
        snap += 'ans:' + Array.from(selectedBtns).map(b => b.dataset.oi).join(',') + '|';
        snap += 'sol:' + (document.getElementById(`mqSolEditArea_${origIdx}`)?.value || '') + '|';
        // Include staged image edits so add/remove image counts as an unsaved change.
        const staged = _mqEditImages[origIdx] || {};
        snap += 'qimg:' + ((staged.questionImages || []).length) + '|';
        snap += 'oimg:' + ((staged.optionImages || []).map(x => x ? '1' : '0').join('')) + '|';
        snap += 'simg:' + ((staged.solutionImages || []).length) + '|';
    });
    return snap;
}

function handleQuestionViewBack() {
    _pendingNavDelta = 0;
    // In view mode, just go back directly (no unsaved changes possible)
    if (!_mqIsEditMode) {
        _hasUnsavedEdits = false;
        goBackFromQuestion();
        return;
    }
    // In edit mode, check for unsaved changes
    const snapshotChanged = _originalEditSnapshot && _originalEditSnapshot !== _getEditSnapshot();
    if (_hasUnsavedEdits || snapshotChanged) {
        _openUnsavedModalForBack();
        openModal('unsavedModal');
    } else {
        _hasUnsavedEdits = false;
        goBackFromQuestion();
    }
}

function goBackFromQuestion() {
    document.getElementById("mq-question-view").style.display = "none";
    document.getElementById("mq-lecture-view").style.display = "block";
    document.getElementById("mq-chapter-view").style.display = "none";

    // Show toolbar and select buttons
    const toolbar = document.getElementById("lec-toolbar");
    if (toolbar) toolbar.style.display = "";
    document.getElementById("lecSelectModeQBtn").style.display = "";

    if (mqPrevView === 'paper' && mqCurrentPaper) {
        history.back();
        return;
    } else if (mqPrevView === 'topic' && mqCurrentChapter && mqCurrentTopic) {
        // Re-render the topic question list
        const ch = mqCurrentChapter;
        const topic = mqCurrentTopic;
        const qs = allQuestions.filter(q => (q.chapter || "(No Chapter)") === ch && (q.topic || "(No Topic)") === topic);
        const totalQ = qs.reduce((sum, x) => sum + (x.questions?.length || 0), 0);
        document.getElementById("mq-chapter-title").textContent = `${ch} - ${topic}`;
        document.getElementById("mq-lecture-count").textContent = `${totalQ} Question${totalQ !== 1 ? 's' : ''}`;
        renderTopicQuestionCards(ch, topic, qs);
    } else if (mqPrevView === 'lecture' && mqCurrentChapter && mqCurrentLectureNum !== null) {
        // Re-render the lecture question list
        const ch = mqCurrentChapter;
        const lecNum = mqCurrentLectureNum;
        const qs = allQuestions.filter(q => (q.chapter || "(No Chapter)") === ch && Number(q.lecture) === Number(lecNum));
        const allQs = qs.flatMap(q => q.questions || []);
        const totalQ = allQs.length;
        document.getElementById("mq-chapter-title").textContent = `${ch} - Lecture ${lecNum}`;
        document.getElementById("mq-lecture-count").textContent = `${totalQ} Question${totalQ !== 1 ? 's' : ''}`;
        const grid = document.getElementById("lectureCardsGrid");
        grid.className = "questions-view-grid";
        grid.innerHTML = allQs.map((sq, idx) => {
            const gi = allQuestions.findIndex(q => (q.chapter || "(No Chapter)") === ch && Number(q.lecture) === Number(lecNum) && q.questions?.includes(sq));
            const sqIdx = allQuestions[gi]?.questions?.indexOf(sq) ?? idx;
            const isMulti = sq.isMultiCorrect || (sq.correctIndexes || [sq.correctIndex || 0]).length > 1;
            const previewText = stripMath((sq.question || "").substring(0, 60));
            const qKey = `${gi}:${sqIdx}`;
            const isChecked = selectedQuestions.has(qKey) ? 'checked' : '';
            const checkboxHtml = qSelectModeOn ? `<input type="checkbox" class="lec-checkbox" ${isChecked} onclick="event.stopPropagation(); toggleQuestionSelect(event, ${gi}, ${sqIdx})" style="position:absolute;top:8px;right:8px;width:18px;height:18px;cursor:pointer;accent-color:var(--accent);z-index:10">` : '';
            const clickHandler = qSelectModeOn ? `onclick="event.stopPropagation(); toggleQuestionSelect(event, ${gi}, ${sqIdx})"` : `onclick="showQuestionViewH(${gi}, ${sqIdx})"`;
            return `<div class="lecture-card ${isMulti ? "has-multi" : ""}" data-ch="${ch.replace(/"/g, '&quot;')}" data-lec="${lecNum}" data-qidx="${idx}" data-gi="${gi}" data-sqidx="${sqIdx}" style="position:relative" ${clickHandler}>
                        ${checkboxHtml}
                        <div class="lecture-card-num">Q${idx + 1}</div>
                        <div class="lecture-card-title">${previewText || 'Empty question'}</div>
                        <div class="lecture-card-count">${(sq.options || []).length} options</div>
                    </div>`;
        }).join("");
    } else if (mqCurrentChapter) {
        showLectureViewForChapter(mqCurrentChapter);
    } else {
        showChapterView();
    }
}

function cancelInlineEdit() {
    _pendingNavDelta = 0;
    const snapshotChanged = _originalEditSnapshot !== _getEditSnapshot();
    if (_hasUnsavedEdits || snapshotChanged) {
        _openUnsavedModalForBack();
        openModal('unsavedModal');
    } else {
        _hasUnsavedEdits = false;
        goBackFromQuestion();
    }
}

async function saveAndGoBack() {
    closeModal('unsavedModal');
    await saveInlineEdit();
    _hasUnsavedEdits = false;
    if (_pendingNavDelta !== 0) {
        const delta = _pendingNavDelta; _pendingNavDelta = 0;
        _doNavigateQuestion(delta);
    } else {
        goBackFromQuestion();
    }
}

function discardAndGoBack() {
    closeModal('unsavedModal');
    _hasUnsavedEdits = false;
    if (_pendingNavDelta !== 0) {
        const delta = _pendingNavDelta; _pendingNavDelta = 0;
        _doNavigateQuestion(delta);
    } else {
        _pendingNavDelta = 0;
        goBackFromQuestion();
    }
}

function updatePreview(si) {
    const ta = document.getElementById(`iqe_qt_${si}`);
    const prev = document.getElementById(`iqe_preview_${si}`);
    if (ta && prev) { prev.textContent = ta.value; renderMath(prev); }
}
function updateOptRender(si, oi) {
    const inp = document.getElementById(`iqe_opt_${si}_${oi}`);
    const rend = document.getElementById(`iqe_opt_render_${si}_${oi}`);
    if (!inp || !rend) return;
    // Don't overwrite an option image cell with typed text
    if (rend.querySelector('img')) return;
    rend.textContent = inp.value;
    renderMath(rend);
}

function toggleCorrectAnswer(si, oi, isMulti) {
    _hasUnsavedEdits = true;
    // Always read live multi state from the checkbox, not the stale baked-in param
    const multiCheckbox = document.getElementById(`iqe_multi_${si}`);
    const actualIsMulti = multiCheckbox ? multiCheckbox.checked : isMulti;

    const wrap = document.getElementById(`iqe_correct_wrap_${si}`);
    if (!wrap) return;
    // If "none correct" is active, the letter buttons are disabled — ignore clicks.
    if (wrap.dataset.none === '1') return;

    const buttons = wrap.querySelectorAll('.correct-btn:not(.correct-btn-none)');
    const clickedBtn = wrap.querySelector(`.correct-btn[data-si="${si}"][data-oi="${oi}"]`);
    const wasSelected = clickedBtn?.classList.contains('selected');

    if (actualIsMulti) {
        // Multi-correct: toggle the clicked option (but always keep at least one)
        if (wasSelected) {
            const currentSelected = [...buttons].filter(b => b.classList.contains('selected'));
            if (currentSelected.length > 1) {
                clickedBtn?.classList.remove('selected');
            }
        } else {
            clickedBtn?.classList.add('selected');
        }
    } else {
        // Single-correct: deselect all, select only clicked
        buttons.forEach(btn => btn.classList.remove('selected'));
        clickedBtn?.classList.add('selected');
    }

    // Update data-multi attributes on all buttons
    buttons.forEach(btn => btn.dataset.multi = actualIsMulti);

    // Sync the opt-render-row highlight (the coloured correct-answer highlight in preview)
    _syncOptRenderRows(si);
}

// Toggle the "None of the options is correct" state for sub-question `si`.
// When active: the A/B/C/D buttons are disabled & cleared, a note is shown,
// and on save the question is stored with correctIndexes:[] + isNoneCorrect:true.
function toggleNoneCorrect(si) {
    _hasUnsavedEdits = true;
    const wrap = document.getElementById(`iqe_correct_wrap_${si}`);
    if (!wrap) return;
    const noneBtn = document.getElementById(`iqe_none_btn_${si}`);
    const note = document.getElementById(`iqe_none_note_${si}`);
    const isNowNone = wrap.dataset.none !== '1';   // toggle
    wrap.dataset.none = isNowNone ? '1' : '0';

    const optionBtns = wrap.querySelectorAll('.correct-btn:not(.correct-btn-none)');
    if (isNowNone) {
        // Turn ON "none correct": clear & disable letter buttons.
        optionBtns.forEach(b => {
            b.classList.remove('selected');
            b.disabled = true;
            b.style.opacity = '0.4';
            b.style.cursor = 'not-allowed';
        });
        if (noneBtn) {
            noneBtn.classList.add('selected');
            noneBtn.style.background = 'rgba(245,158,11,0.18)';
            noneBtn.style.borderColor = '#f59e0b';
            noneBtn.style.color = '#f59e0b';
        }
        if (note) note.style.display = 'block';
    } else {
        // Turn OFF: re-enable letter buttons and default-select the first.
        optionBtns.forEach(b => {
            b.disabled = false;
            b.style.opacity = '';
            b.style.cursor = '';
        });
        const first = wrap.querySelector('.correct-btn:not(.correct-btn-none)');
        if (first) first.classList.add('selected');
        if (noneBtn) {
            noneBtn.classList.remove('selected');
            noneBtn.style.background = '';
            noneBtn.style.borderColor = '';
            noneBtn.style.color = '';
        }
        if (note) note.style.display = 'none';
    }
    _syncOptRenderRows(si);
}

function _syncOptRenderRows(si) {
    const wrap = document.getElementById(`iqe_correct_wrap_${si}`);
    if (!wrap) return;
    // When "none correct" is active, no option row should be highlighted.
    const isNone = wrap.dataset.none === '1';
    const selectedOis = isNone ? [] : [...wrap.querySelectorAll('.correct-btn:not(.correct-btn-none).selected')].map(b => parseInt(b.dataset.oi));
    // There are 4 option rows per question: iqe_opt_render_${si}_0 .. _3
    for (let oi = 0; oi < 4; oi++) {
        const renderEl = document.getElementById(`iqe_opt_render_${si}_${oi}`);
        if (!renderEl) continue;
        const row = renderEl.closest('.opt-render-row');
        if (!row) continue;
        if (selectedOis.includes(oi)) {
            row.classList.add('is-correct');
        } else {
            row.classList.remove('is-correct');
        }
    }
}

function updateCorrectBtnStyles(si, selectedIndexes) {
    const wrap = document.getElementById(`iqe_correct_wrap_${si}`);
    if (!wrap) return;

    const buttons = wrap.querySelectorAll('.correct-btn:not(.correct-btn-none)');
    buttons.forEach((btn, idx) => {
        if (selectedIndexes.includes(idx)) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });
}

function toggleMultiCorrect(si) {
    const isMulti = document.getElementById(`iqe_multi_${si}`)?.checked || false;
    const wrap = document.getElementById(`iqe_correct_wrap_${si}`);
    if (!wrap) return;

    // Update the toggle text
    const toggleText = document.getElementById(`iqe_multi_${si}`)?.closest('label')?.querySelector('.multi-toggle-text')
        || document.querySelector(`#iqe_multi_${si} ~ .multi-toggle-text`)
        || (() => {
            // fallback: search nearest sibling span
            const cb = document.getElementById(`iqe_multi_${si}`);
            return cb?.parentElement?.querySelector('.multi-toggle-text');
        })();
    if (toggleText) {
        toggleText.textContent = isMulti ? "✦ Multi-correct" : "○ Single-correct";
    }

    const buttons = wrap.querySelectorAll('.correct-btn:not(.correct-btn-none)');
    const selected = [];
    buttons.forEach((btn, idx) => {
        if (btn.classList.contains('selected')) selected.push(idx);
    });

    // If switching to single and multiple selected, keep only the first
    if (!isMulti && selected.length > 1) {
        const firstSelected = selected[0];
        buttons.forEach((btn, idx) => {
            if (idx !== firstSelected) btn.classList.remove('selected');
        });
    }

    // Update data-multi on all buttons
    buttons.forEach(btn => btn.dataset.multi = isMulti);

    // Sync row highlight colours
    _syncOptRenderRows(si);
}

function showSavingOverlay(text = "Saving...", subtext = "Please wait") {
    const txt = document.getElementById("savingText");
    const sub = document.getElementById("savingSubtext");
    const ov = document.getElementById("savingOverlay");
    if (txt) txt.textContent = text;
    if (sub) sub.textContent = subtext;
    if (ov) ov.style.display = "flex";
}

function hideSavingOverlay() {
    const ov = document.getElementById("savingOverlay");
    if (ov) ov.style.display = "none";
}

async function saveInlineEdit() {
    const chapter = document.getElementById("iqe-chapter")?.value.trim();
    const lecture = document.getElementById("iqe-lecture")?.value.trim();
    if (!chapter || !lecture) { showErrorModal("Chapter and lecture are required.", "Missing fields"); return; }

    const gi = mqCurrentLectureIdx;
    const q = allQuestions[gi];
    if (!q) { showErrorModal("Question set not found.", "Error"); return; }

    // SINGLE-ROW MODE: this question was opened via showQuestionByRowId
    // (paper-wise view) and `q.questions` therefore holds ONLY this one
    // question, not its topic siblings. Saving through the normal
    // "replace whole chapter+topic" path below would wipe every sibling
    // row in the database. Patch and PUT just this one row instead via
    // /api/admin/question-row/:id, then return early.
    if (q._rowId != null) {
        const origIdx = 0;
        const text = document.getElementById(`iqe_qt_${origIdx}`)?.value.trim();
        const opts = LETTERS.map((_, oi) => document.getElementById(`iqe_opt_${origIdx}_${oi}`)?.value.trim() || "");
        const isMulti = document.getElementById(`iqe_multi_${origIdx}`)?.checked || false;
        const wrap = document.getElementById(`iqe_correct_wrap_${origIdx}`);
        const isNoneCorrect = wrap?.dataset.none === '1';
        const selectedBtns = wrap?.querySelectorAll('.correct-btn:not(.correct-btn-none).selected') || [];
        const checked = Array.from(selectedBtns).map(btn => parseInt(btn.dataset.oi));
        const ci = isNoneCorrect ? [] : (checked.length ? checked : [0]);

        const existingSub = (q.questions && q.questions[0]) || {};
        const staged = _mqEditImages[origIdx] || {};
        const optionImages = Array.isArray(staged.optionImages)
            ? [...staged.optionImages, null, null, null, null].slice(0, 4)
            : mqGetOptionImages(existingSub);
        const solutionText = document.getElementById(`mqSolEditArea_${origIdx}`)?.value.trim() || "";
        const existingSolutions = Array.isArray(existingSub.solutions) ? existingSub.solutions.map(sol => ({ ...sol })) : [];
        const questionImages = Array.isArray(staged.questionImages)
            ? staged.questionImages.filter(Boolean)
            : (Array.isArray(existingSub.questionImages) ? existingSub.questionImages.filter(Boolean) : (existingSub.questionImage ? [existingSub.questionImage] : []));
        const solutionImages = Array.isArray(staged.solutionImages)
            ? staged.solutionImages.filter(Boolean)
            : mqGetSolutionImages(existingSub);
        if (solutionText || solutionImages.length || existingSolutions.length) {
            if (!existingSolutions.length) {
                existingSolutions.push({ text: solutionText, image: solutionImages[0] || null, images: solutionImages });
            } else {
                if (!existingSolutions[0]) existingSolutions[0] = {};
                existingSolutions[0].text = solutionText;
                existingSolutions[0].images = solutionImages;
                existingSolutions[0].image = solutionImages[0] || null;
            }
        }
        const { otherTables: _keepTables } = _extractOptionTables(existingSub);
        const _normKeepTables = Array.isArray(_keepTables)
            ? _keepTables.filter(t => t && ((Array.isArray(t.headers) && t.headers.length) || (Array.isArray(t.rows) && t.rows.length)))
            : [];
        const _existingOptTables = mqGetOptionTables(existingSub);
        const _optTablesSave = _existingOptTables.map(t => t || null);
        const _hasOptTablesSave = _hasAnyOptionTable(_optTablesSave);

        const patchedQuestion = {
            question: text,
            options: opts,
            correctIndexes: ci,
            isMultiCorrect: isNoneCorrect ? false : isMulti,
            ...(isNoneCorrect ? { isNoneCorrect: true } : {}),
            ...(existingSub.year ? { year: String(existingSub.year) } : {}),
            ...(existingSub.subject ? { subject: existingSub.subject } : {}),
            ...(existingSub.unit ? { unit: existingSub.unit } : {}),
            ...(_normKeepTables.length ? { tables: _normKeepTables } : {}),
            ...(_hasOptTablesSave ? { optionTables: _optTablesSave, hasOptionTables: true } : {}),
            ...(existingSub.numericalAnswer !== undefined && existingSub.numericalAnswer !== null ? { numericalAnswer: existingSub.numericalAnswer } : {}),
            questionImage: questionImages[0] || null,
            questionImages,
            hasImage: questionImages.length > 0,
            solutions: existingSolutions,
            optionImages,
            hasOptionImages: optionImages.some(Boolean)
        };

        if (!text || !opts.every((o, oi) => o || optionImages[oi] || _optTablesSave[oi])) {
            showErrorModal("Please fill in the question text and all options.", "Incomplete data");
            return;
        }

        showSavingOverlay("Saving question...", "Updating this question only");
        try {
            const r = await fetch(`${API_BASE}/api/admin/question-row/${q._rowId}`, {
                method: "PUT",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chapter, lecture, topic: lecture, question: patchedQuestion })
            });
            const data = await r.json().catch(() => null);
            if (!r.ok || (data && data.error)) {
                hideSavingOverlay();
                showErrorModal(data?.error || await extractErrorMessage(r, "Save failed."), "Save failed");
                return;
            }
            // Update the in-memory wrapped row so the view reflects the edit immediately.
            q.questions = [patchedQuestion];
            q.chapter = chapter || q.chapter;
            q.lecture = lecture || q.lecture;
            q.topic = lecture || q.topic;
            hideSavingOverlay();
            showSuccessModal("Saved!", "Question updated.");
            showQuestionView(gi, 0);
        } catch (e) {
            hideSavingOverlay();
            showErrorModal("An error occurred while saving. Please try again.", "Error");
        }
        return;
    }

    // SAFETY CHECK: this path replaces the ENTIRE chapter+topic group in
    // the database with whatever is in `fullQuestions` below. If the
    // group's full question list never loaded (e.g. a lazy-load failed),
    // q.questions would be empty/undefined and saving would silently
    // wipe every sibling question in this topic. Refuse to proceed rather
    // than risk that — this is exactly the failure mode that previously
    // corrupted topics with 8-9 questions down to a handful of blanks.
    if (!Array.isArray(q.questions) || !q.questions.length) {
        showErrorModal(
            "This topic's questions didn't fully load, so saving was blocked to avoid losing data. Please close this question, reopen the topic, and try again.",
            "Save blocked — data not loaded"
        );
        return;
    }

    // Start with a full copy of ALL existing questions for this lecture
    const fullQuestions = (q.questions || []).map(sub => ({ ...sub }));

    // Patch only the edited sub-question(s) from the DOM form
    const containers = document.querySelectorAll("#iqe-questions-container > div");
    containers.forEach((c, si) => {
        // The container stores the original sub-question index in data-orig-idx
        const origIdx = c.dataset.origIdx !== undefined ? parseInt(c.dataset.origIdx) : si;
        const text = document.getElementById(`iqe_qt_${origIdx}`)?.value.trim();
        const opts = LETTERS.map((_, oi) => document.getElementById(`iqe_opt_${origIdx}_${oi}`)?.value.trim() || "");
        const isMulti = document.getElementById(`iqe_multi_${origIdx}`)?.checked || false;

        const wrap = document.getElementById(`iqe_correct_wrap_${origIdx}`);
        const isNoneCorrect = wrap?.dataset.none === '1';
        const selectedBtns = wrap?.querySelectorAll('.correct-btn:not(.correct-btn-none).selected') || [];
        const checked = Array.from(selectedBtns).map(btn => parseInt(btn.dataset.oi));
        // "None correct" ⇒ no option indices; otherwise keep selection (default A).
        const ci = isNoneCorrect ? [] : (checked.length ? checked : [0]);

        // An option is valid if it has text OR a staged image OR a table.
        const _stagedOptImgs = (_mqEditImages[origIdx] && _mqEditImages[origIdx].optionImages) || [];
        const _existingOptTables = mqGetOptionTables(fullQuestions[origIdx] || {});
        const optsFilled = opts.every((o, oi) => o || _stagedOptImgs[oi] || _existingOptTables[oi]);

        if (text && optsFilled) {
            const existingSub = fullQuestions[origIdx] || {};
            // Pull edited images from the staging store (falls back to existing data).
            const staged = _mqEditImages[origIdx] || {};
            const optionImages = Array.isArray(staged.optionImages)
                ? [...staged.optionImages, null, null, null, null].slice(0, 4)
                : mqGetOptionImages(existingSub);
            const solutionText = document.getElementById(`mqSolEditArea_${origIdx}`)?.value.trim() || "";
            const existingSolutions = Array.isArray(existingSub.solutions) ? existingSub.solutions.map(sol => ({ ...sol })) : [];
            const questionImages = Array.isArray(staged.questionImages)
                ? staged.questionImages.filter(Boolean)
                : (Array.isArray(existingSub.questionImages) ? existingSub.questionImages.filter(Boolean) : (existingSub.questionImage ? [existingSub.questionImage] : []));
            // Staged solution images (added/removed in the solution editor's image zone).
            const solutionImages = Array.isArray(staged.solutionImages)
                ? staged.solutionImages.filter(Boolean)
                : mqGetSolutionImages(existingSub);
            if (solutionText || solutionImages.length || existingSolutions.length) {
                if (!existingSolutions.length) {
                    existingSolutions.push({ text: solutionText, image: solutionImages[0] || null, images: solutionImages });
                } else {
                    if (!existingSolutions[0]) existingSolutions[0] = {};
                    existingSolutions[0].text = solutionText;
                    existingSolutions[0].images = solutionImages;
                    existingSolutions[0].image = solutionImages[0] || null;
                }
            }
            // Preserve per-option tables. Keep only the question-level tables
            // (option_x positioned tables are stored in optionTables instead).
            const { otherTables: _keepTables } = _extractOptionTables(existingSub);
            const _normKeepTables = Array.isArray(_keepTables)
                ? _keepTables.filter(t => t && ((Array.isArray(t.headers) && t.headers.length) || (Array.isArray(t.rows) && t.rows.length)))
                : [];
            const _optTablesSave = _existingOptTables.map(t => t || null);
            const _hasOptTablesSave = _hasAnyOptionTable(_optTablesSave);
            fullQuestions[origIdx] = {
                question: text,
                options: opts,
                correctIndexes: ci,
                isMultiCorrect: isNoneCorrect ? false : isMulti,
                ...(isNoneCorrect ? { isNoneCorrect: true } : {}),
                ...(existingSub.year ? { year: String(existingSub.year) } : {}),
                ...(existingSub.subject ? { subject: existingSub.subject } : {}),
                ...(existingSub.unit ? { unit: existingSub.unit } : {}),
                ...(_normKeepTables.length ? { tables: _normKeepTables } : {}),
                ...(_hasOptTablesSave ? { optionTables: _optTablesSave, hasOptionTables: true } : {}),
                ...(existingSub.numericalAnswer !== undefined && existingSub.numericalAnswer !== null ? { numericalAnswer: existingSub.numericalAnswer } : {}),
                questionImage: questionImages[0] || null,
                questionImages,
                hasImage: questionImages.length > 0,
                solutions: existingSolutions,
                optionImages,
                hasOptionImages: optionImages.some(Boolean)
            };
        }
    });

    if (!fullQuestions.length) { showErrorModal("No complete questions found to save.", "Incomplete data"); return; }
    showSavingOverlay("Saving questions...", `Saving ${fullQuestions.length} question(s)`);

    const oldCh = q?.chapter || "";
    const oldLec = q?.lecture;
    try {
        // Use PUT to replace the full questions array without touching other lectures
        const r = await fetch(
            `${API_BASE}/api/admin/question/${encodeQuestionPathPart(oldCh)}/${encodeQuestionPathPart(oldLec)}`,
            {
                method: "PUT",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chapter, lecture, questions: fullQuestions })
            }
        );
        const data = await r.json().catch(() => null);

        if (!r.ok || (data && data.error)) {
            hideSavingOverlay();
            const errorMsg = data?.error || await extractErrorMessage(r, "Save failed for this lecture.");
            showErrorModal(errorMsg, "Save failed");
            return;
        }

        // If chapter or lecture changed, we need to delete the old entry and re-insert
        if (oldCh !== chapter || String(oldLec) !== String(lecture)) {
            await fetch(`${API_BASE}/api/admin/question/${encodeQuestionPathPart(oldCh)}/${encodeQuestionPathPart(oldLec)}`, { method: "DELETE", credentials: "include" });
            // Re-insert under new chapter/lecture
            await fetch(`${API_BASE}/api/admin/add-question`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chapter, lecture, questions: fullQuestions, replace: true })
            });
        }

        hideSavingOverlay();
        showSuccessModal("Saved!", `Topic "${lecture}" updated.`);
        await loadQuestionsAdmin(); loadChaptersAdmin();

        if (mqBrowseMode === 'paper' && mqCurrentPaper) {
            showPaperQuestions(mqCurrentPaper, false);
            return;
        }

        const ni = allQuestions.findIndex(x => x.chapter === chapter && String(x.lecture) === String(lecture));
        if (ni !== -1) showQuestionView(ni, _mqCurrentViewSqIdx); else showLectureView();
    } catch (e) {
        hideSavingOverlay();
        showErrorModal("An error occurred while saving. Please try again.", "Error");
    }
}

function deleteCurrentQuestion() {
    const gi = mqCurrentLectureIdx;
    const q = allQuestions[gi];
    if (!q) return;

    // Get the question index from URL or default to 0
    const urlParams = new URLSearchParams(window.location.search);
    const sqIdx = mqCurrentSqIdx >= 0 && _mqQuestionList[mqCurrentSqIdx]
        ? _mqQuestionList[mqCurrentSqIdx].sqIdx
        : 0;

    pendingDeleteChapter = q.chapter || "";
    pendingDeleteLecture = q.lecture;
    pendingDeleteQuestionIndex = sqIdx;
    // Legacy fallback only — confirmDelete() prefers the per-question
    // `_rowId` set on the actual question object. q._id is a chapter+topic
    // GROUP key, not a real row id, so it's not usable as a delete target.
    pendingDeleteRowId = null;

    document.getElementById("deleteModalText").textContent = `Delete question ${sqIdx + 1} from "${q.chapter || "No chapter"} / ${q.topic || q.lecture}"? This will remove only this question.`;
    window._deleteFromInline = true;
    openModal("deleteModal");
}
window.deleteCurrentQuestion = deleteCurrentQuestion;

async function confirmDelete() {
    closeModal("deleteModal");

    // Check if it's a single question delete (from inline edit)
    if (window._deleteFromInline && pendingDeleteQuestionIndex !== undefined) {
        showDeleteProgress("Deleting question...");
        try {
            const gi = allQuestions.findIndex(q => (q.chapter || "") === (pendingDeleteChapter || "") && String(q.lecture) === String(pendingDeleteLecture));
            if (gi === -1) throw new Error("Question not found");

            // Ensure the row is fully loaded (not meta-only) before accessing .questions
            const lecture = await ensureRowLoaded(gi);
            if (!lecture || !Array.isArray(lecture.questions)) throw new Error("Invalid question data");

            // CHANGED: each individual question carries its own real database
            // row id in `_rowId` (set by the server — see findQuestion /
            // questions-for-chapter in the backend). The previous code used
            // `lecture._id`, which is a chapter+topic GROUP key (e.g.
            // "Current Electricity::Wheatstone Bridge"), not a real row id —
            // it then PUT a shortened `questions` array against a route that
            // expects exactly one question, silently corrupting the topic.
            // We now delete the exact row by its real numeric id instead.
            const targetQuestion = lecture.questions[pendingDeleteQuestionIndex];
            const rowId = (targetQuestion && targetQuestion._rowId != null) ? targetQuestion._rowId : pendingDeleteRowId;
            if (rowId == null) throw new Error("Missing row id for this question");

            const r = await fetch(`${API_BASE}/api/admin/question-row/${encodeURIComponent(String(rowId))}`, {
                method: "DELETE",
                credentials: "include",
            });

            if (r.ok) {
                // Reflect the deletion locally so the view updates immediately.
                lecture.questions.splice(pendingDeleteQuestionIndex, 1);

                hideDeleteProgress();
                showSuccessModal("Deleted!", "Question deleted successfully.");
                await loadQuestionsAdmin();

                if (mqBrowseMode === 'paper' && mqCurrentPaper) {
                    showPaperQuestions(mqCurrentPaper, false);
                    return;
                }

                // Refresh the view
                if (window._deleteFromInline) {
                    window._deleteFromInline = false;
                    // Go back to lecture view if no more questions
                    if (lecture.questions.length === 0) {
                        goBackFromQuestion();
                    } else {
                        // Show updated question view
                        const newSqIdx = Math.min(pendingDeleteQuestionIndex, lecture.questions.length - 1);
                        showQuestionView(gi, newSqIdx);
                    }
                }
            } else {
                const errData = await r.json().catch(() => ({}));
                throw new Error(errData.error || "Delete failed on server");
            }
        } catch (e) {
            hideDeleteProgress();
            showErrorModal(e.message || "Delete failed.", "Delete failed");
        }
        return;
    }

    // Original behavior for deleting entire lecture
    showDeleteProgress("Deleting question...");
    const r = await fetch(`${API_BASE}/api/admin/question/${encodeQuestionPathPart(pendingDeleteChapter)}/${encodeQuestionPathPart(pendingDeleteLecture)}`, { method: "DELETE", credentials: "include" });
    if (r.ok) {
        hideDeleteProgress();
        showSuccessModal("Deleted!", "Question deleted successfully.");
        await loadQuestionsAdmin();
        if (mqBrowseMode === 'paper' && mqCurrentPaper) {
            showPaperQuestions(mqCurrentPaper, false);
            return;
        }
        if (window._deleteFromInline) { window._deleteFromInline = false; showLectureView(); }
    } else {
        hideDeleteProgress();
        showErrorModal(await extractErrorMessage(r, "Delete failed."), "Delete failed");
    }
}


/* ══════════════════════════════════════════════════════════════════
   TABLE / MATRIX RENDERING
   Questions may carry a `tables` array. Each table:
     { position, headers: string[], rows: string[][], caption? }
   Cell text can contain inline $...$ LaTeX — we put it through
   clientRepairLatex (when available) and escape it, then KaTeX renders
   it when renderMath() runs on the enclosing container.
══════════════════════════════════════════════════════════════════ */
function _normalizeTablesField(tables) {
    if (!tables) return [];
    const arr = Array.isArray(tables) ? tables : [tables];
    const out = [];
    arr.forEach(t => {
        if (!t || typeof t !== "object") return;
        const headers = Array.isArray(t.headers) ? t.headers.map(h => _normalizeCell(h)) : [];
        const rows = Array.isArray(t.rows)
            ? t.rows.filter(r => Array.isArray(r)).map(r => r.map(c => _normalizeCell(c)))
            : [];
        if (!headers.length && !rows.length) return;
        const obj = {
            position: (typeof t.position === "string" && t.position.trim()) ? t.position.trim() : "after_intro",
            headers, rows
        };
        if (t.caption && String(t.caption).trim()) obj.caption = String(t.caption).trim();
        out.push(obj);
    });
    return out;
}

function _cellImgSrc(img) {
    if (!img) return "";
    if (img.startsWith("http") || img.startsWith("data:")) return img;
    const mime = img.startsWith("/9j/") ? "image/jpeg" : img.startsWith("iVBOR") ? "image/png" : img.startsWith("R0lGOD") ? "image/gif" : "image/jpeg";
    return `data:${mime};base64,${img}`;
}
function _renderCellText(raw) {
    // Image cell: render the image (and optional caption text).
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        if (raw.image) {
            const cap = raw.text ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px">${_jsonEscHtml(clientRepairLatex(String(raw.text)))}</div>` : "";
            return `<img src="${_cellImgSrc(String(raw.image))}" alt="cell image" style="max-width:120px;max-height:90px;object-fit:contain;display:block;margin:0 auto;border-radius:3px">${cap}`;
        }
        if (raw.imageNeeded) {
            return `<span style="font-size:0.68rem;color:#f59e0b;font-style:italic">🖼 image pending</span>`;
        }
        return _jsonEscHtml(clientRepairLatex(String(raw.text || "")));
    }
    const txt = (typeof clientRepairLatex === "function") ? clientRepairLatex(String(raw || "")) : String(raw || "");
    // Escape HTML; KaTeX auto-render later converts $...$ left in the text.
    return _jsonEscHtml(txt);
}

// Returns an HTML string for one or more tables. Call renderMath() on the
// container afterwards so inline math inside cells gets typeset.
// Render ONE normalized table object to HTML. Used by renderTablesHtml and
// by the per-option table renderer.
function renderSingleTableHtml(tbl) {
    if (!tbl || typeof tbl !== "object") return "";
    let colCount = (tbl.headers || []).length;
    (tbl.rows || []).forEach(r => { colCount = Math.max(colCount, r.length); });
    if (!colCount) return "";
    let html = `<div class="q-data-table-wrap"><table class="q-data-table">`;
    if (tbl.headers && tbl.headers.length) {
        html += `<thead><tr>`;
        for (let c = 0; c < colCount; c++) {
            html += `<th>${_renderCellText(tbl.headers[c] ?? "")}</th>`;
        }
        html += `</tr></thead>`;
    }
    html += `<tbody>`;
    (tbl.rows || []).forEach(r => {
        html += `<tr>`;
        for (let c = 0; c < colCount; c++) {
            html += `<td>${_renderCellText(r[c] ?? "")}</td>`;
        }
        html += `</tr>`;
    });
    html += `</tbody></table>`;
    if (tbl.caption) html += `<div class="q-data-table-caption">${_renderCellText(tbl.caption)}</div>`;
    html += `</div>`;
    return html;
}

function renderTablesHtml(tables) {
    const list = _normalizeTablesField(tables);
    if (!list.length) return "";
    return list.map(tbl => renderSingleTableHtml(tbl)).join("");
}


/* ══════════════════════════════════════════════════════════════════
   OPTION TABLES
   A question option (A/B/C/D) may itself be a small table (e.g. NEET
   "match the following" rows). We store these in a parallel array
   `optionTables` (index 0=A … 3=D, null when the option has no table).
   The AI/JSON supplies them either as:
     • a top-level `optionTables` array, OR
     • entries in the `tables` array whose `position` is
       "option_a" / "option_b" / "option_c" / "option_d" (or
       "option_1".."option_4").
   _extractOptionTables() normalizes any of these into a 4-slot array
   and ALSO returns the remaining non-option tables.
══════════════════════════════════════════════════════════════════ */
const _OPTION_TABLE_POS = { option_a: 0, option_b: 1, option_c: 2, option_d: 3, option_1: 0, option_2: 1, option_3: 2, option_4: 3 };

// A table cell may be a plain string OR an object describing an image:
//   { text: "caption", image: "<base64|url|null>", imageNeeded: true }
// _normalizeCell preserves image-cell objects (instead of String()-ing
// them away) so images embedded inside option/body table cells survive
// through normalization, rendering, the DOCX export and the test window.
function _isImageCell(c) {
    return c && typeof c === "object" && !Array.isArray(c) &&
        ("image" in c || c.imageNeeded === true || c.image_needed === true);
}
function _normalizeCell(c) {
    if (_isImageCell(c)) {
        const img = c.image != null ? String(c.image) : null;
        const needed = (c.imageNeeded === true || c.image_needed === true) && !img;
        const obj = { text: String(c.text ?? c.caption ?? ""), image: img };
        if (needed) obj.imageNeeded = true;
        return obj;
    }
    return String(c ?? "");
}
function _normalizeSingleTable(t) {
    if (!t || typeof t !== "object") return null;
    const headers = Array.isArray(t.headers) ? t.headers.map(h => _normalizeCell(h)) : [];
    const rows = Array.isArray(t.rows)
        ? t.rows.filter(r => Array.isArray(r)).map(r => r.map(c => _normalizeCell(c)))
        : [];
    if (!headers.length && !rows.length) return null;
    const obj = { headers, rows };
    if (t.caption && String(t.caption).trim()) obj.caption = String(t.caption).trim();
    return obj;
}

// Returns { optionTables: (table|null)[4], otherTables: rawTable[] }
function _extractOptionTables(q) {
    const optionTables = [null, null, null, null];
    const otherTables = [];

    // 1. Explicit top-level optionTables array.
    if (Array.isArray(q && q.optionTables)) {
        for (let i = 0; i < 4; i++) {
            const nt = _normalizeSingleTable(q.optionTables[i]);
            if (nt) optionTables[i] = nt;
        }
    }

    // 2. Tables array entries with position "option_x".
    const rawTables = (q && q.tables) ? (Array.isArray(q.tables) ? q.tables : [q.tables]) : [];
    rawTables.forEach(t => {
        if (!t || typeof t !== "object") return;
        const pos = String(t.position || "").trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(_OPTION_TABLE_POS, pos)) {
            const slot = _OPTION_TABLE_POS[pos];
            const nt = _normalizeSingleTable(t);
            if (nt && !optionTables[slot]) optionTables[slot] = nt;
        } else {
            otherTables.push(t);
        }
    });

    return { optionTables, otherTables };
}

function _hasAnyOptionTable(arr) {
    return Array.isArray(arr) && arr.some(t => t && typeof t === "object" && ((t.headers && t.headers.length) || (t.rows && t.rows.length)));
}

// Shared detector for "none of the options is correct" questions used by
// both the JSON-upload preview and the save routine, so the badge shown to
// the admin matches exactly what gets stored.
function _jsonUploadIsNoneCorrect(q) {
    const isInteger = (q.question_type || "").toUpperCase() === "INTEGER";
    if (isInteger) return false;
    const isMSQ = (q.question_type || "").toUpperCase() === "MSQ";
    const raw = (q.correct_answer === null || q.correct_answer === undefined) ? "" : String(q.correct_answer).trim();
    const up = raw.toUpperCase();
    const noneTokens = ["NONE", "NONE OF THE ABOVE", "NONE OF THESE", "NOTA", "N/A", "NA", "-", "—", "NULL"];
    return q.none_correct === true || q.isNoneCorrect === true ||
        noneTokens.includes(up) || (!isMSQ && raw === "");
}

function _jsonUploadRenderPreview(questions) {
    const previewEl = document.getElementById("jsonUploadPreview");
    previewEl.style.display = "block";

    // Summary cards by subject
    const bySubject = {};
    const byType = { MCQ: 0, MSQ: 0, INTEGER: 0 };
    questions.forEach(q => {
        const s = q.subject || "Unknown";
        bySubject[s] = (bySubject[s] || 0) + 1;
        const t = (q.question_type || "MCQ").toUpperCase();
        if (byType[t] !== undefined) byType[t]++;
    });

    const subjectColors = { Physics: "#56a9ff", Chemistry: "#2ed2b4", Mathematics: "#f5a623", Unknown: "#b7c8e8" };
    const subjectIcons = { Physics: "⚛️", Chemistry: "🧪", Mathematics: "📐", Unknown: "❓" };

    const summaryEl = document.getElementById("jsonUploadSummaryCards");
    summaryEl.innerHTML = Object.entries(bySubject).map(([s, cnt]) =>
        `<div style="flex:1;min-width:110px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);text-align:center">
                    <div style="font-size:1.4rem">${subjectIcons[s] || "❓"}</div>
                    <div style="font-size:1.1rem;font-weight:800;color:${subjectColors[s] || 'var(--text)'}">${cnt}</div>
                    <div style="font-size:0.72rem;color:var(--text-muted)">${s}</div>
                </div>`
    ).join("") +
        `<div style="flex:1;min-width:110px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);text-align:center">
                <div style="font-size:1.4rem">📋</div>
                <div style="font-size:1.1rem;font-weight:800;color:var(--accent)">${questions.length}</div>
                <div style="font-size:0.72rem;color:var(--text-muted)">Total</div>
            </div>` +
        (byType.INTEGER > 0 ? `<div style="flex:1;min-width:110px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);text-align:center">
                <div style="font-size:1.4rem">🔢</div>
                <div style="font-size:1.1rem;font-weight:800;color:#a78bfa">${byType.INTEGER}</div>
                <div style="font-size:0.72rem;color:var(--text-muted)">Integer Type</div>
            </div>` : "");

    // Question list grouped by subject, then ordered by question number
    const listEl = document.getElementById("jsonUploadQuestionList");
    listEl.innerHTML = "";
    const subjOrder = ["Physics", "Chemistry", "Mathematics"];
    const grouped = {};
    questions.forEach((q, idx) => {
        const subj = q.subject || "Unknown";
        if (!grouped[subj]) grouped[subj] = [];
        grouped[subj].push({ ...q, _idx: idx, _qNum: getQuestionNumber(q, idx + 1) });
    });

    const allSubjects = [...subjOrder.filter(s => grouped[s]), ...Object.keys(grouped).filter(s => !subjOrder.includes(s))];
    allSubjects.forEach((subj) => {
        const subjectQuestions = [...(grouped[subj] || [])].sort((a, b) => (a._qNum - b._qNum) || (a._idx - b._idx));
        const subjectCount = subjectQuestions.length;
        const subjectPanel = document.createElement("div");
        subjectPanel.style.cssText = "margin-bottom:12px";

        const subjectHeader = document.createElement("div");
        subjectHeader.style.cssText = "padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);font-weight:700;font-size:0.85rem;color:var(--text-dim);cursor:pointer;display:flex;align-items:center;justify-content:space-between;user-select:none";
        subjectHeader.innerHTML = `<span>${subjectIcons[subj] || "❓"} ${subj} — ${subjectCount} questions</span><span style="color:var(--text-muted);font-size:0.72rem">▼ click to expand</span>`;

        const subjectBody = document.createElement("div");
        subjectBody.style.cssText = "display:none;padding-left:4px;margin-top:6px";
        subjectHeader.onclick = () => {
            const open = subjectBody.style.display !== "none";
            subjectBody.style.display = open ? "none" : "block";
            subjectHeader.querySelector("span:last-child").textContent = (open ? "▼" : "▲") + " click to " + (open ? "expand" : "collapse");
            if (!open && window.renderMath) setTimeout(() => renderMath(subjectBody), 50);
        };

        subjectQuestions.forEach((q) => {
            const idx = q._idx;
            const isInteger = (q.question_type || "").toUpperCase() === "INTEGER";
            const isMSQ = (q.question_type || "").toUpperCase() === "MSQ";
            const LETTERS = ["A", "B", "C", "D"];

            const card = document.createElement("div");
            card.style.cssText = "margin:4px 0;padding:14px 16px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);transition:all 0.2s";
            card.id = `jsonQ_${idx}`;

            let headerHTML = `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px">
                        <span style="font-size:0.72rem;font-weight:700;background:var(--accent);color:#fff;padding:3px 10px;border-radius:20px">Q${q._qNum}</span>
                        <span style="font-size:0.68rem;background:rgba(91,95,239,0.12);color:#7c80f0;padding:2px 7px;border-radius:20px">${_jsonEscHtml(formatChapterLabel(q.chapter || "No Chapter"))}</span>
                        <span style="font-size:0.68rem;background:rgba(245,166,35,0.12);color:#f5a623;padding:2px 7px;border-radius:20px">${_jsonEscHtml(q.topic || "")}</span>`;

            const isNoneCorrect = _jsonUploadIsNoneCorrect(q);

            if (isInteger) {
                headerHTML += `<span style="font-size:0.68rem;background:rgba(167,139,250,0.15);color:#a78bfa;padding:2px 7px;border-radius:20px;font-weight:600">INTEGER</span>`;
            } else if (isMSQ) {
                headerHTML += `<span style="font-size:0.68rem;background:rgba(236,72,153,0.15);color:#ec4899;padding:2px 7px;border-radius:20px;font-weight:600">MSQ</span>`;
            } else {
                headerHTML += `<span style="font-size:0.68rem;background:rgba(46,210,180,0.12);color:#2ed2b4;padding:2px 7px;border-radius:20px">MCQ</span>`;
            }

            if (isNoneCorrect) {
                headerHTML += `<span style="font-size:0.68rem;background:rgba(245,158,11,0.16);color:#f59e0b;padding:2px 7px;border-radius:20px;font-weight:700">⊘ NONE CORRECT</span>`;
            }

            if (q.has_image) {
                headerHTML += `<span style="font-size:0.68rem;color:#f5a623">🖼 has image</span>`;
            }
            headerHTML += `</div>`;

            let questionHTML = `<div style="font-size:0.85rem;color:var(--text);line-height:1.7;margin-bottom:10px;white-space:pre-wrap;word-break:break-word">${_jsonEscHtml(q.question_text || "")}</div>`;
            // Split out per-option tables (position option_a..option_d) from the rest.
            const { optionTables: _optTables, otherTables: _otherTables } = _extractOptionTables(q);
            // Render tables/matrices positioned after the intro text (default).
            const _allTables = _normalizeTablesField(_otherTables);
            const _tablesAfterIntro = _allTables.filter(t => (t.position || "after_intro") !== "after_options");
            const _tablesAfterOptions = _allTables.filter(t => (t.position || "after_intro") === "after_options");
            if (_tablesAfterIntro.length) questionHTML += renderTablesHtml(_tablesAfterIntro);
            questionHTML += _jsonUploadRenderImageStack(idx, 'question', _jsonUploadGetQuestionImages(q, idx));

            let optionsHTML = "";
            if (!isInteger) {
                const options = [q.option_a, q.option_b, q.option_c, q.option_d];
                const correctLetter = isNoneCorrect ? "" : String(q.correct_answer || "").toUpperCase();
                optionsHTML = `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">`;
                if (isNoneCorrect) {
                    optionsHTML += `<div style="padding:6px 10px;background:rgba(245,158,11,0.1);border:1px dashed rgba(245,158,11,0.4);border-radius:6px;font-size:0.74rem;color:#f59e0b;font-weight:600">⊘ None of the options is correct — students get full marks for this question.</div>`;
                }
                options.forEach((opt, oi) => {
                    const optTable = _optTables[oi];
                    // Skip only when the option has neither text nor a table.
                    if ((opt === null || opt === undefined || String(opt).trim() === "") && !optTable) return;
                    const letter = LETTERS[oi];
                    const isCorrect = !isNoneCorrect && correctLetter.includes(letter);
                    const optBodyHTML = optTable
                        ? `<div style="flex:1;min-width:0">${renderSingleTableHtml(optTable)}</div>`
                        : `<span style="flex:1;word-break:break-word">${_jsonEscHtml(String(opt || ""))}</span>`;
                    optionsHTML += `<div style="padding:6px 10px;background:${isCorrect ? "rgba(46,210,180,0.1)" : "var(--bg-card)"};border:1px solid ${isCorrect ? "rgba(46,210,180,0.3)" : "var(--border)"};border-radius:6px;font-size:0.8rem;color:var(--text)">
                                <div style="display:flex;align-items:flex-start;gap:6px">
                                    <span style="font-weight:700;color:${isCorrect ? "#2ed2b4" : "var(--text-muted)"};min-width:18px">(${letter})</span>
                                    ${optBodyHTML}
                                    ${isCorrect ? '<span style="color:#2ed2b4;font-size:0.72rem;white-space:nowrap">✓ correct</span>' : ""}
                                </div>
                                ${q.has_image ? `<div id="jsonOptImgPreview_${idx}_${oi}" style="display:none;margin-top:6px;align-items:center;gap:8px">
                                    <img id="jsonOptImgTag_${idx}_${oi}" style="max-width:100%;max-height:150px;border-radius:6px;border:1px solid var(--border)">
                                    <button onclick="jsonUploadRemoveImage(${idx},'option',${oi})" style="background:none;border:none;color:var(--error);cursor:pointer;font-size:0.75rem;white-space:nowrap">✕ Remove</button>
                                </div>
                                <div id="jsonOptImgPaste_${idx}_${oi}" tabindex="0"
                                    style="margin-top:4px;padding:6px;border:2px dashed rgba(86,169,255,0.2);border-radius:6px;text-align:center;cursor:pointer;font-size:0.68rem;color:var(--text-muted);background:rgba(86,169,255,0.03);outline:none"
                                    onpaste="jsonUploadHandlePaste(event,${idx},'option',${oi})"
                                    onfocus="this.style.borderColor='var(--accent)'"
                                    onblur="this.style.borderColor='rgba(86,169,255,0.2)'">
                                    📋 Ctrl+V to paste option ${letter} image
                                </div>` : ''}
                            </div>`;
                });
                optionsHTML += `</div>`;
            } else {
                optionsHTML = `<div style="padding:8px 12px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);border-radius:6px;font-size:0.82rem;margin-bottom:8px">
                            <span style="font-weight:700;color:#a78bfa">Numerical Answer: </span>
                            <span style="color:var(--text);font-weight:600;font-size:1rem">${_jsonEscHtml(String(q.correct_answer ?? ""))}</span>
                        </div>`;
            }

            const solText = q.solution || "";
            const solId = `jsonSol_${idx}`;
            const solutionHTML = `<div style="margin-top:8px">
                        <div onclick="var s=document.getElementById('${solId}');var open=s.style.display!=='none';s.style.display=open?'none':'block';this.querySelector('.sol-toggle').textContent=open?'▶ Show':'▼ Hide';if(!open&&window.renderMath)setTimeout(function(){renderMath(s)},50)" style="font-size:0.72rem;font-weight:700;color:#56a9ff;cursor:pointer;display:flex;align-items:center;gap:4px;user-select:none">
                            📖 Solution <span class="sol-toggle" style="font-size:0.68rem;color:var(--text-muted)">▶ Show</span>
                        </div>
                        <div id="${solId}" style="display:none;margin-top:6px;padding:10px 12px;background:rgba(86,169,255,0.06);border:1px solid rgba(86,169,255,0.15);border-radius:6px">
                            ${solText ? `<div style="font-size:0.78rem;color:var(--text-dim);line-height:1.7;white-space:pre-wrap;word-break:break-word">${_jsonEscHtml(solText)}</div>` : `<div style="font-size:0.75rem;color:var(--text-muted);font-style:italic">No text solution provided</div>`}
                            ${_jsonUploadRenderImageStack(idx, 'solution', _jsonUploadGetSolutionImages(q, idx))}
                        </div>
                    </div>`;

            const afterOptionsTablesHTML = _tablesAfterOptions.length ? renderTablesHtml(_tablesAfterOptions) : "";
            const cellImagesHTML = _jsonUploadBuildCellImageSection(q, idx);
            card.innerHTML = headerHTML + questionHTML + optionsHTML + afterOptionsTablesHTML + cellImagesHTML + solutionHTML;
            subjectBody.appendChild(card);
        });

        subjectPanel.appendChild(subjectHeader);
        subjectPanel.appendChild(subjectBody);
        listEl.appendChild(subjectPanel);
    });

    if (window.renderMath) setTimeout(() => renderMath(listEl), 100);
}


/* ══════════════════════════════════════════════════════════════════
   TABLE CELL IMAGES (manual paste during JSON upload)
   A table cell may be flagged { imageNeeded: true } by the extractor
   when the original PDF cell contained an image/diagram. Here we scan
   every table on the question (body tables in q.tables and per-option
   tables in q.optionTables / position:"option_x") and surface a paste
   box for each pending cell. The pasted image is written directly into
   the cell object so the normal save path (which now preserves image
   cells) stores it. Cells that already have an image show a preview.
══════════════════════════════════════════════════════════════════ */
// Build the canonical list of {table, label} that may contain image cells
// for question `q`. Mutates q so a stable reference exists for paste writes.
function _jsonUploadCellTables(q) {
    const out = [];
    // Body / question tables
    if (Array.isArray(q.tables)) {
        q.tables.forEach((t, ti) => {
            if (t && typeof t === "object") {
                const pos = String(t.position || "").trim().toLowerCase();
                const optMap = { option_a: "A", option_b: "B", option_c: "C", option_d: "D", option_1: "A", option_2: "B", option_3: "C", option_4: "D" };
                const label = optMap[pos] ? `Option ${optMap[pos]}` : `Table ${ti + 1}`;
                out.push({ scope: "tables", ti, table: t, label });
            }
        });
    }
    // Explicit per-option tables
    if (Array.isArray(q.optionTables)) {
        q.optionTables.forEach((t, ti) => {
            if (t && typeof t === "object") {
                out.push({ scope: "optionTables", ti, table: t, label: `Option ${["A", "B", "C", "D"][ti] || ti + 1}` });
            }
        });
    }
    return out;
}
// Returns true if `cell` is an image-cell object.
function _jsonUploadIsImgCell(c) {
    return c && typeof c === "object" && !Array.isArray(c) && ("image" in c || c.imageNeeded === true || c.image_needed === true);
}
function _jsonUploadBuildCellImageSection(q, idx) {
    const tables = _jsonUploadCellTables(q);
    const pending = [];
    tables.forEach((entry) => {
        const t = entry.table;
        const scan = (cells, kind, ri) => {
            (cells || []).forEach((c, ci) => {
                if (_jsonUploadIsImgCell(c)) {
                    // Normalize into a consistent shape in-place.
                    if (typeof c !== "object" || Array.isArray(c)) return;
                    if (c.image == null && (c.imageNeeded || c.image_needed)) c.image = null;
                    pending.push({ entry, kind, ri, ci, cell: c });
                }
            });
        };
        scan(t.headers, "header", -1);
        (t.rows || []).forEach((r, ri) => scan(r, "row", ri));
    });
    if (!pending.length) return "";
    let html = `<div style="margin-top:10px;padding:10px 12px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.25);border-radius:8px">
                <div style="font-size:0.72rem;font-weight:700;color:#f59e0b;margin-bottom:8px">🖼 Table cell images — paste the image for each cell below</div>
                <div style="display:flex;flex-direction:column;gap:8px">`;
    pending.forEach((p) => {
        const key = `cell_${idx}_${p.entry.scope}_${p.entry.ti}_${p.kind}_${p.ri}_${p.ci}`;
        const where = p.kind === "header" ? `header col ${p.ci + 1}` : `row ${p.ri + 1}, col ${p.ci + 1}`;
        const hasImg = !!p.cell.image;
        const src = hasImg ? _cellImgSrc(String(p.cell.image)) : "";
        html += `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <span style="font-size:0.72rem;color:var(--text-dim);min-width:150px">${_jsonEscHtml(p.entry.label)} · ${where}</span>
                    <div id="${key}_preview" style="display:${hasImg ? "flex" : "none"};align-items:center;gap:8px">
                        <img id="${key}_img" src="${src}" style="max-width:120px;max-height:80px;border-radius:5px;border:1px solid var(--border);object-fit:contain">
                        <button onclick="jsonUploadRemoveCellImage('${key}')" style="background:none;border:none;color:var(--error);cursor:pointer;font-size:0.72rem">✕ Remove</button>
                    </div>
                    <div id="${key}_paste" tabindex="0" style="display:${hasImg ? "none" : "block"};flex:1;min-width:160px;padding:6px 8px;border:2px dashed rgba(245,158,11,0.4);border-radius:6px;text-align:center;cursor:pointer;font-size:0.68rem;color:var(--text-muted);background:rgba(245,158,11,0.04);outline:none"
                        onpaste="jsonUploadHandleCellPaste(event,'${key}')"
                        onfocus="this.style.borderColor='#f59e0b'"
                        onblur="this.style.borderColor='rgba(245,158,11,0.4)'">
                        📋 Click here & Ctrl+V to paste this cell's image
                    </div>
                </div>`;
        // Register the cell reference for later writes.
        _jsonUploadCellRefs[key] = p.cell;
    });
    html += `</div></div>`;
    return html;
}
// Map of cell-image key → live cell object reference (rebuilt each render).
let _jsonUploadCellRefs = {};
function jsonUploadHandleCellPaste(event, key) {
    event.preventDefault();
    event.stopPropagation();
    const items = (event.clipboardData || event.originalEvent.clipboardData).items;
    for (const item of items) {
        if (item.type.indexOf("image") !== -1) {
            const blob = item.getAsFile();
            const reader = new FileReader();
            reader.onload = function (e) {
                const base64 = e.target.result;
                const cell = _jsonUploadCellRefs[key];
                if (cell) { cell.image = base64; delete cell.imageNeeded; delete cell.image_needed; }
                const img = document.getElementById(`${key}_img`);
                const preview = document.getElementById(`${key}_preview`);
                const paste = document.getElementById(`${key}_paste`);
                if (img) img.src = base64;
                if (preview) preview.style.display = "flex";
                if (paste) paste.style.display = "none";
            };
            reader.readAsDataURL(blob);
            break;
        }
    }
}
function jsonUploadRemoveCellImage(key) {
    const cell = _jsonUploadCellRefs[key];
    if (cell) { cell.image = null; cell.imageNeeded = true; }
    const preview = document.getElementById(`${key}_preview`);
    const paste = document.getElementById(`${key}_paste`);
    if (preview) preview.style.display = "none";
    if (paste) paste.style.display = "block";
}
window.jsonUploadHandleCellPaste = jsonUploadHandleCellPaste;
window.jsonUploadRemoveCellImage = jsonUploadRemoveCellImage;

function jsonUploadHandlePaste(event, idx, type, optIdx) {
    event.preventDefault();
    event.stopPropagation();
    const items = (event.clipboardData || event.originalEvent.clipboardData).items;
    for (const item of items) {
        if (item.type.indexOf("image") !== -1) {
            const blob = item.getAsFile();
            const reader = new FileReader();
            reader.onload = function (e) {
                const base64 = e.target.result;
                if (type === 'question' || type === 'solution') {
                    const key = type === 'question' ? `q_${idx}` : `sol_${idx}`;
                    const current = Array.isArray(_jsonUploadImages[key]) ? _jsonUploadImages[key] : _jsonUploadNormalizeImageList(_jsonUploadImages[key]);
                    if (!current.includes(base64)) current.push(base64);
                    _jsonUploadImages[key] = current;
                    _jsonUploadRefreshImageSection(idx, type);
                } else {
                    const key = `opt_${idx}_${optIdx}`;
                    _jsonUploadImages[key] = base64;
                    const preview = document.getElementById(`jsonOptImgPreview_${idx}_${optIdx}`);
                    const img = document.getElementById(`jsonOptImgTag_${idx}_${optIdx}`);
                    const paste = document.getElementById(`jsonOptImgPaste_${idx}_${optIdx}`);
                    if (img) img.src = base64;
                    if (preview) preview.style.display = "flex";
                    if (paste) paste.style.display = "none";
                }
            };
            reader.readAsDataURL(blob);
            break;
        }
    }
}

function jsonUploadHandleImages(input, idx, type) {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const key = type === 'question' ? `q_${idx}` : `sol_${idx}`;
    const existing = Array.isArray(_jsonUploadImages[key]) ? _jsonUploadImages[key] : _jsonUploadNormalizeImageList(_jsonUploadImages[key]);
    let loaded = 0;
    files.forEach((file) => {
        const reader = new FileReader();
        reader.onload = function (e) {
            const base64 = e.target.result;
            if (!existing.includes(base64)) existing.push(base64);
            loaded++;
            if (loaded === files.length) {
                _jsonUploadImages[key] = existing;
                _jsonUploadRefreshImageSection(idx, type);
            }
        };
        reader.readAsDataURL(file);
    });
    input.value = '';
}

function jsonUploadRemoveImage(idx, type, optIdx) {
    if (type === 'question' || type === 'solution') {
        const key = type === 'question' ? `q_${idx}` : `sol_${idx}`;
        const current = Array.isArray(_jsonUploadImages[key]) ? _jsonUploadImages[key] : _jsonUploadNormalizeImageList(_jsonUploadImages[key]);
        current.splice(optIdx, 1);
        _jsonUploadImages[key] = current;
        _jsonUploadRefreshImageSection(idx, type);
    } else {
        const key = `opt_${idx}_${optIdx}`;
        delete _jsonUploadImages[key];
        const preview = document.getElementById(`jsonOptImgPreview_${idx}_${optIdx}`);
        const paste = document.getElementById(`jsonOptImgPaste_${idx}_${optIdx}`);
        if (preview) preview.style.display = "none";
        if (paste) paste.style.display = "block";
    }
}


/* Keep old function name working just in case */
// async function _impSaveAllPYQ() { await jsonUploadSaveAll(); }

async function jsonUploadSaveAll() {
    const isJeeMode = _jsonUploadExamType === 'jee_mains';
    const isJeePaper = isJeeMode && _jsonUploadJeeMode === 'paper';
    const isJeeChapterwise = isJeeMode && _jsonUploadJeeMode === 'chapterwise';
    const isNeetPaper = !isJeeMode && _jsonUploadNeetMode === 'paper';
    let lectureName = "";
    // Paper-level metadata stamped onto every question for badge display
    let _paperYear = "", _paperMonth = "", _paperDate = "", _paperShift = "";
    if (isJeePaper) {
        _paperYear = document.getElementById("jsonUploadYear")?.value || "";
        _paperMonth = document.getElementById("jsonUploadMonth")?.value || "";
        _paperDate = (document.getElementById("jsonUploadDate")?.value || "").trim();
        _paperShift = document.getElementById("jsonUploadShift")?.value || "";
        if (!_paperYear || !_paperMonth || !_paperDate || !_paperShift) {
            showErrorModal("Please fill in all paper details (Year, Month, Date, Shift) before saving.", "Missing Paper Details");
            return;
        }
        lectureName = `JEE ${_paperYear} ${_paperMonth} ${_paperDate} ${_paperShift}`;
    }
    if (isNeetPaper) {
        _paperYear = document.getElementById("jsonUploadNeetPaperYear")?.value || "";
        if (!_paperYear) { showErrorModal("Please enter the Year for NEET paper upload.", "Missing Year"); return; }
        lectureName = `NEET ${_paperYear}`;
    }

    if (!_jsonUploadQuestions.length) {
        showErrorModal("No questions to save. Please upload a JSON file first.", "Nothing to Save");
        return;
    }

    // Group questions by chapter + topic (each unique combo = one DB row).
    // In NEET chapterwise mode: lecture is set to the topic name (internal key only,
    // never shown in UI). Year is stored inside each question object.
    const byGroup = {};
    _jsonUploadQuestions.forEach((q, idx) => {
        const chapter = q.chapter || q.subject || "General";
        const topic = q.topic || "(No Topic)";
        // JEE paper / NEET paper: use the paper label as lecture.
        // JEE chapterwise / NEET chapterwise: silently use topic as the internal lecture key so each
        // topic becomes exactly one DB row. Year lives inside each question object.
        const lecture = (isJeePaper || isNeetPaper) ? lectureName : topic;
        const groupKey = `${chapter}|||${topic}`;
        if (!byGroup[groupKey]) byGroup[groupKey] = { chapter, topic, lecture, questions: [] };

        const isInteger = (q.question_type || "").toUpperCase() === "INTEGER";
        const isMSQ = (q.question_type || "").toUpperCase() === "MSQ";

        // Detect an explicit "none of the options is correct" question.
        // Accept several common spellings the JSON may carry, e.g.
        //   "correct_answer": "none" | "NONE" | "N" | "-" | "" | null
        // or an explicit boolean flag  "none_correct": true.
        const isNoneCorrect = _jsonUploadIsNoneCorrect(q);

        // Map correct_answer to correctIndexes
        let correctIndexes = [0];
        if (isInteger) {
            correctIndexes = []; // No option indices for integer type
        } else if (isNoneCorrect) {
            correctIndexes = []; // No option is the correct one
        } else {
            const ansStr = String(q.correct_answer || "").toUpperCase();
            const letterMap = { A: 0, B: 1, C: 2, D: 3 };
            if (isMSQ || ansStr.length > 1) {
                correctIndexes = [...ansStr].filter(c => letterMap[c] !== undefined).map(c => letterMap[c]);
                if (!correctIndexes.length) correctIndexes = [0];
            } else {
                correctIndexes = letterMap[ansStr] !== undefined ? [letterMap[ansStr]] : [0];
            }
        }

        // Build options
        const options = isInteger
            ? ["", "", "", ""]
            : [q.option_a || "", q.option_b || "", q.option_c || "", q.option_d || ""];

        // Build question and solution image payloads
        const questionImages = _jsonUploadGetQuestionImages(q, idx);
        const questionImage = questionImages[0] || null;
        const solutionImages = _jsonUploadGetSolutionImages(q, idx);
        const solutionImage = solutionImages[0] || null;
        const solutions = q.solution || solutionImages.length
            ? [{
                text: q.solution || '',
                image: solutionImage,
                images: solutionImages
            }]
            : [];

        const optionImages = [
            _jsonUploadImages[`opt_${idx}_0`] || null,
            _jsonUploadImages[`opt_${idx}_1`] || null,
            _jsonUploadImages[`opt_${idx}_2`] || null,
            _jsonUploadImages[`opt_${idx}_3`] || null,
        ];

        // Split per-option tables out of the tables array, then preserve
        // the remaining question-level tables/matrices.
        const { optionTables: optTablesRaw, otherTables: otherTablesRaw } = _extractOptionTables(q);
        const qTables = _normalizeTablesField(otherTablesRaw);
        const optionTables = optTablesRaw.map(t => t || null);
        const hasOptionTables = _hasAnyOptionTable(optionTables);

        byGroup[groupKey].questions.push({
            question: q.question_text || "",
            options,
            correctIndexes,
            isMultiCorrect: correctIndexes.length > 1,
            ...(isNoneCorrect ? { isNoneCorrect: true } : {}),
            questionImage,
            questionImages,
            optionImages,
            hasOptionImages: optionImages.some(Boolean),
            solutions,
            hasImage: !!(q.has_image || questionImages.length),
            numericalAnswer: isInteger ? q.correct_answer : undefined,
            subject: q.subject || "",
            unit: q.unit || "",
            // Prefer per-question year/month/date/shift; fall back to paper-level form values
            ...(String(q.year || _paperYear || "") ? { year: String(q.year || _paperYear) } : {}),
            ...(_paperMonth && !q.month ? { month: _paperMonth } : (q.month ? { month: String(q.month) } : {})),
            ...(_paperDate && !q.date && !q.day ? { date: _paperDate } : (q.date ? { date: String(q.date) } : (q.day ? { day: String(q.day) } : {}))),
            ...(_paperShift && !q.shift ? { shift: _paperShift } : (q.shift ? { shift: String(q.shift) } : {})),
            ...(qTables.length ? { tables: qTables } : {}),
            ...(hasOptionTables ? { optionTables, hasOptionTables: true } : {}),
        });
    });

    // Show saving overlay
    const groups = Object.values(byGroup);
    // ── Route imported questions into the paper-wise `papers` table ──
    // PYQ (has a year) → its "<Exam> <year>" paper row; non-PYQ → the exam's
    // rolling "Regular Ques" row. Exam comes from the JEE/NEET import selector.
    const _paperExam = isJeeMode ? 'JEE Mains' : 'NEET';
    const _paperBuckets = {};
    groups.forEach(g => {
        (g.questions || []).forEach(nq => {
            const yr = (nq.year && String(nq.year).trim()) ? String(nq.year).trim() : 'Regular';
            const isRegular = yr === 'Regular';
            const label = isRegular ? (isJeeMode ? 'JEE Regular Ques' : 'NEET Regular Ques') : `${_paperExam} ${yr}`;
            const bkey = `${_paperExam}|||${yr}`;
            if (!_paperBuckets[bkey]) _paperBuckets[bkey] = { exam: _paperExam, year: yr, label, questions: [] };
            _paperBuckets[bkey].questions.push(nq);
        });
    });
    const totalQs = _jsonUploadQuestions.length;
    const ov = document.createElement("div");
    ov.id = "saveProgressOverlay";
    ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);z-index:99999;display:flex;align-items:center;justify-content:center";
    ov.innerHTML = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:18px;padding:36px 44px;display:flex;flex-direction:column;align-items:center;gap:14px;min-width:340px;box-shadow:0 12px 48px rgba(0,0,0,0.45)">
                <div style="font-size:3rem;line-height:1">📋</div>
                <div style="font-size:1.1rem;font-weight:700;color:var(--text)">Saving Questions…</div>
                <div style="font-size:0.78rem;color:var(--text-muted)">${isJeeMode ? lectureName : 'NEET mode (using JSON metadata)'}</div>
                <div style="width:300px;height:9px;background:rgba(255,255,255,0.06);border-radius:8px;overflow:hidden">
                    <div id="jsonProgBar" style="height:100%;background:linear-gradient(90deg,var(--accent),var(--accent-2));border-radius:8px;transition:width 0.3s;width:0%"></div>
                </div>
                <span id="jsonProgText" style="font-size:0.82rem;color:var(--text-dim)">Preparing…</span>
            </div>`;
    document.body.appendChild(ov);

    let savedQ = 0, failedChs = [];

    for (const group of groups) {
        const { chapter, topic, lecture, questions } = group;
        const progText = document.getElementById("jsonProgText");
        if (progText) progText.textContent = `Saving ${chapter} › ${topic} › ${lecture} — ${questions.length} questions…`;

        try {
            // Find existing row: chapter + lecture (= topic) is the unique DB key.
            const norm = s => (s || "").toString().trim().toLowerCase();
            const existing = (Array.isArray(allQuestions)
                ? allQuestions.find(q =>
                    norm(q.chapter) === norm(chapter) &&
                    norm(q.lecture) === norm(lecture))
                : null);
            // Always append (POST add-question) — whether the chapter+topic already
            // exists or not — so previously saved questions are never deleted.
            const resp = await fetch(`${API_BASE}/api/admin/add-question`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chapter: chapter, lecture: lecture, topic: topic, questions: questions })
            });
            if (resp.ok) {
                savedQ += questions.length;
            }

            if (resp && resp.ok) {
                const pct = Math.round((savedQ / totalQs) * 100);
                const bar = document.getElementById("jsonProgBar");
                const txt = document.getElementById("jsonProgText");
                if (bar) bar.style.width = pct + "%";
                if (txt) txt.textContent = `${savedQ} / ${totalQs} questions saved`;
            } else {
                const errData = resp ? await resp.json().catch(() => ({})) : {};
                console.error(`Save failed for ${chapter}:`, errData);
                failedChs.push(chapter);
            }
        } catch (e) {
            console.error(`Save error for ${chapter}:`, e);
            failedChs.push(chapter);
        }
        await new Promise(r => setTimeout(r, 80));
    }

    document.getElementById("saveProgressOverlay")?.remove();

    // Mirror the saved questions into the paper-wise store (best-effort).
    try {
        const _buckets = Object.values(_paperBuckets).filter(b => b.questions.length);
        if (_buckets.length) {
            await fetch(`${API_BASE}/api/admin/papers/append`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ buckets: _buckets })
            });
        }
    } catch (e) { console.warn("paper-wise routing failed:", e); }

    document.getElementById("successModalTitle").textContent = failedChs.length === 0 ? "📋 Saved!" : "Partially Saved";
    document.getElementById("successModalText").textContent = failedChs.length === 0
        ? (isJeeMode
            ? `${savedQ} questions saved across ${groups.length} chapter-topic group(s) as "${lectureName}". Check Manage section.`
            : `${savedQ} questions saved across ${groups.length} chapter-topic-lecture group(s) in NEET mode. Check Manage section.`)
        : `Saved: ${savedQ}. Failed: ${failedChs.join(", ")}.`;
    openModal("successModal");
    await loadQuestionsAdmin();
    if (typeof loadChaptersAdmin === "function") loadChaptersAdmin();
}

// Drag-and-drop support for JSON upload zone
(function initJsonUploadDrop() {
    function setup() {
        const zone = document.getElementById("jsonUploadDropZone");
        if (!zone) return;
        zone.addEventListener("dragover", e => { e.preventDefault(); zone.style.borderColor = "var(--accent)"; });
        zone.addEventListener("dragleave", () => { if (!_jsonUploadFile) zone.style.borderColor = "var(--border)"; });
        zone.addEventListener("drop", e => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) {
                const input = document.getElementById("jsonUploadFile");
                const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
                jsonUploadFileSelected(input);
            }
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
    else setTimeout(setup, 600);
})();
