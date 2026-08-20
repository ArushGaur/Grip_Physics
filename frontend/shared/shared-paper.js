/* ═══════════════════════════════════════════════════════════════════
           IMPORT TYPE SWITCHER (Test Paper vs STAR Quiz)
        ═══════════════════════════════════════════════════════════════════ */
let _impType = "test_paper"; // "test_paper" | "star_quiz" | "pyq"

function impSwitchType(type) {
    _impType = type;
    const btnTP = document.getElementById("impTypeTestPaper");
    const btnSQ = document.getElementById("impTypeStarQuiz");
    const btnJsonUpload = document.getElementById("impTypeJsonUpload");
    const hint = document.getElementById("impTypeHint");
    const chReq = document.getElementById("impChapterRequired");
    const chHint = document.getElementById("impChapterHint");
    const lecField = document.getElementById("impLectureField");
    const solSection = document.getElementById("impSolutionSection");
    const jsonUploadMeta = document.getElementById("impJsonUploadMeta");
    const metadataRow = document.getElementById("impMetadataRow");

    // Reset all buttons
    [btnTP, btnSQ, btnJsonUpload].forEach(b => { if (b) { b.style.border = "2px solid var(--border)"; b.style.background = "var(--bg-input)"; b.style.color = "var(--text)"; } });

    // Restore screenshot-related UI (hidden by json_upload mode)
    const _srcTabs = document.getElementById("impSourceTabs");
    if (_srcTabs && _srcTabs.parentElement) _srcTabs.parentElement.style.display = "";
    const _srcPanel = document.getElementById("impSrcPanelScreenshot");
    if (_srcPanel) _srcPanel.style.display = "";
    const _extractBtn = document.getElementById("impExtractBtn");
    if (_extractBtn) _extractBtn.style.display = "";

    if (type === "star_quiz") {
        btnSQ.style.border = "2px solid var(--accent)";
        btnSQ.style.background = "var(--accent)";
        btnSQ.style.color = "#fff";
        hint.innerHTML = "⭐ <strong>STAR Quiz:</strong> Questions saved to the STAR Quiz section, organised chapter & lecture wise.";
        if (chReq) chReq.style.display = "inline";
        if (chHint) chHint.style.display = "block";
        if (lecField) lecField.style.display = "block";
        if (solSection) solSection.style.display = "none";
        const codeField = document.getElementById("impLectureCodeField");
        if (codeField) codeField.style.display = "block";
        if (jsonUploadMeta) jsonUploadMeta.style.display = "none";
        if (metadataRow) metadataRow.style.display = "";
    } else if (type === "json_upload") {
        btnJsonUpload.style.border = "2px solid var(--accent)";
        btnJsonUpload.style.background = "var(--accent)";
        btnJsonUpload.style.color = "#fff";
        hint.innerHTML = "📋 <strong>JSON Upload:</strong> Upload Gemini-extracted JSON file with questions, options, answer keys &amp; solutions. Questions are auto-grouped by chapter.";
        if (chReq) chReq.style.display = "none";
        if (chHint) chHint.style.display = "none";
        if (lecField) lecField.style.display = "none";
        if (solSection) solSection.style.display = "none";
        const codeField = document.getElementById("impLectureCodeField");
        if (codeField) codeField.style.display = "none";
        if (jsonUploadMeta) jsonUploadMeta.style.display = "block";
        if (metadataRow) metadataRow.style.display = "none";
        jsonUploadSetExamType(_jsonUploadExamType);
        // Hide screenshot source tabs and extract button for JSON upload
        const srcTabs = document.getElementById("impSourceTabs");
        if (srcTabs) srcTabs.parentElement.style.display = "none";
        const srcPanel = document.getElementById("impSrcPanelScreenshot");
        if (srcPanel) srcPanel.style.display = "none";
        const extractBtn = document.getElementById("impExtractBtn");
        if (extractBtn) extractBtn.style.display = "none";
    } else {
        // test_paper
        btnTP.style.border = "2px solid var(--accent)";
        btnTP.style.background = "var(--accent)";
        btnTP.style.color = "#fff";
        hint.innerHTML = "📄 <strong>Test Paper:</strong> Questions saved to the main question bank (accessible in Manage section).";
        if (chReq) chReq.style.display = "none";
        if (chHint) chHint.style.display = "none";
        if (lecField) lecField.style.display = "none";
        if (solSection) solSection.style.display = "block";
        const codeField = document.getElementById("impLectureCodeField");
        if (codeField) codeField.style.display = "none";
        const codeInput = document.getElementById("imp-lecture-code");
        if (codeInput) codeInput.value = "";
        if (jsonUploadMeta) jsonUploadMeta.style.display = "none";
        if (metadataRow) metadataRow.style.display = "";
    }
}

/* Patch impSaveAll to route to the right API endpoint */
const _origImpSaveAll = window.impSaveAll;
async function impSaveAll() {
    if (_impType === "star_quiz") {
        await _impSaveAllStarQuiz();
    } else if (_impType === "json_upload") {
        await jsonUploadSaveAll();
    } else {
        await _origImpSaveAll_inner();
    }
}

async function _origImpSaveAll_inner() {
    const chapter = document.getElementById("imp-chapter").value.trim();
    const topic = document.getElementById("imp-topic")?.value.trim() || "";
    if (!chapter) { showErrorModal("Please enter a chapter.", "Missing fields"); return; }

    document.querySelectorAll(".imp-q-card").forEach((card, localIdx) => {
        const qiStr = card.id.replace("impQ_", "");
        const qi = parseInt(qiStr);
        if (!isNaN(qi)) impSyncQFromDOM(qi); else impSyncQFromDOM(localIdx);
    });

    // For test paper: collect all questions into a single group (no lecture required)
    const allQArr = [];
    let hasError = false;
    document.querySelectorAll(".imp-q-card").forEach((card, localIdx) => {
        const qiStr = card.id.replace("impQ_", "");
        const qi = isNaN(parseInt(qiStr)) ? localIdx : parseInt(qiStr);
        const txt = document.getElementById(`impQText_${qi}`)?.value?.trim();
        const opts = LETTERS.map((_, oi) => document.getElementById(`impOpt_${qi}_${oi}`)?.value?.trim() || "");
        const mc = [...document.querySelectorAll(`.impMultiChk_${qi}:checked`)].map(c => parseInt(c.value));
        let ci = mc.length > 0 ? mc : [parseInt(document.getElementById(`impCorrectSel_${qi}`)?.value || 0)];
        if (!txt) { hasError = true; return; }
        const origQ = impQuestions[qi] || {};
        const questionImage = origQ._manualImgB64 || origQ._imgB64 || null;
        const solutions = origQ.solutions || [];
        const optionImages_save = Array.isArray(origQ.optionImages) ? origQ.optionImages : [null, null, null, null];
        const hasOptionImages_save = !!(origQ.hasOptionImages || optionImages_save.some(Boolean));
        allQArr.push({ question: txt, options: opts, correctIndexes: ci, isMultiCorrect: ci.length > 1, questionImage, optionImages: optionImages_save, hasOptionImages: hasOptionImages_save, solutions });
    });

    if (hasError) { showErrorModal("Some questions are missing text.", "Incomplete data"); return; }
    if (!allQArr.length) { showErrorModal("No questions to save.", "Nothing to save"); return; }

    // Group by a single pseudo-lecture "0" so the API call is compatible
    const groups = { "0": allQArr };
    const lectures = ["0"];

    const ov = document.createElement("div");
    ov.id = "saveProgressOverlay";
    ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);z-index:99999;display:flex;align-items:center;justify-content:center";
    const totalQs = Object.values(groups).reduce((s, arr) => s + arr.length, 0);
    ov.innerHTML = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:18px;padding:36px 44px;display:flex;flex-direction:column;align-items:center;gap:14px;min-width:340px;box-shadow:0 12px 48px rgba(0,0,0,0.45)">
                <div style="font-size:3rem;line-height:1">💾</div>
                <div style="font-size:1.1rem;font-weight:700;color:var(--text)">Saving Questions…</div>
                <div style="width:300px;height:9px;background:rgba(255,255,255,0.06);border-radius:8px;overflow:hidden">
                    <div id="impProgBar" style="height:100%;background:linear-gradient(90deg,var(--accent),var(--accent-2));border-radius:8px;transition:width 0.3s;width:0%"></div>
                </div>
                <span id="impProgText" style="font-size:0.82rem;color:var(--text-dim)">Preparing…</span>
            </div>`;
    document.body.appendChild(ov);

    let savedQ = 0, saved = 0, failed = [];
    for (const lec of lectures) {
        const lecArr = groups[lec];
        document.getElementById("impProgText").textContent = `Saving lecture ${lec}…`;
        const resp = await fetch(`${API_BASE}/api/admin/add-question`, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chapter, lecture: lec, topic, questions: lecArr })
        });
        if (resp.ok) {
            for (let i = 0; i < lecArr.length; i++) {
                savedQ++;
                const pct = Math.round((savedQ / totalQs) * 100);
                document.getElementById("impProgBar").style.width = pct + "%";
                document.getElementById("impProgText").textContent = `${savedQ}/${totalQs} questions saved`;
                if (i < lecArr.length - 1) await new Promise(r => setTimeout(r, 55));
            }
            saved++;
        } else { failed.push(lec); }
    }

    document.getElementById("saveProgressOverlay")?.remove();
    document.getElementById("successModalTitle").textContent = saved > 0 ? "Saved!" : "Failed";
    document.getElementById("successModalText").textContent = failed.length === 0
        ? `${savedQ} question(s) saved to "${chapter}".`
        : `Saved: ${savedQ}. Failed lectures: ${failed.join(", ")}.`;
    openModal("successModal");
    await loadQuestionsAdmin();
    if (typeof loadChaptersAdmin === "function") loadChaptersAdmin();
}

async function _impSaveAllStarQuiz() {
    const chapter = document.getElementById("imp-chapter").value.trim();
    const topic = document.getElementById("imp-topic")?.value.trim() || "";
    const lectureCode = document.getElementById("imp-lecture-code")?.value.trim() || "";
    if (!chapter) { showErrorModal("Please enter a chapter name. Chapter is required for STAR Quiz.", "Missing Chapter"); return; }
    if (lectureCode && !/^[0-9]{4}$/.test(lectureCode)) { showErrorModal("Lecture code must be exactly 4 digits (numbers only).", "Invalid Code"); return; }

    document.querySelectorAll(".imp-q-card").forEach((card, localIdx) => {
        const qiStr = card.id.replace("impQ_", "");
        const qi = parseInt(qiStr);
        if (!isNaN(qi)) impSyncQFromDOM(qi); else impSyncQFromDOM(localIdx);
    });

    const groups = {};
    let hasError = false;
    document.querySelectorAll(".imp-q-card").forEach((card, localIdx) => {
        const qiStr = card.id.replace("impQ_", "");
        const qi = isNaN(parseInt(qiStr)) ? localIdx : parseInt(qiStr);
        const lec = document.getElementById(`impLec_${qi}`)?.value?.trim();
        const txt = document.getElementById(`impQText_${qi}`)?.value?.trim();
        const opts = LETTERS.map((_, oi) => document.getElementById(`impOpt_${qi}_${oi}`)?.value?.trim() || "");
        const mc = [...document.querySelectorAll(`.impMultiChk_${qi}:checked`)].map(c => parseInt(c.value));
        let ci = mc.length > 0 ? mc : [parseInt(document.getElementById(`impCorrectSel_${qi}`)?.value || 0)];
        if (!lec || !txt) { hasError = true; return; }
        const origQ = impQuestions[qi] || {};
        const questionImage = origQ._manualImgB64 || origQ._imgB64 || null;
        const optionImages_save = Array.isArray(origQ.optionImages) ? origQ.optionImages : [null, null, null, null];
        const hasOptionImages_save = !!(origQ.hasOptionImages || optionImages_save.some(Boolean));
        const solutions = origQ.solutions || [];
        if (!groups[lec]) groups[lec] = [];
        groups[lec].push({ question: txt, options: opts, correctIndexes: ci, isMultiCorrect: ci.length > 1, questionImage, optionImages: optionImages_save, hasOptionImages: hasOptionImages_save, solutions });
    });

    if (hasError) { showErrorModal("Some questions are missing text or lecture number.", "Incomplete data"); return; }
    const lectures = Object.keys(groups);
    if (!lectures.length) { showErrorModal("No questions to save.", "Nothing to save"); return; }

    const ov = document.createElement("div");
    ov.id = "saveProgressOverlay";
    ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);z-index:99999;display:flex;align-items:center;justify-content:center";
    const totalQs = Object.values(groups).reduce((s, arr) => s + arr.length, 0);
    ov.innerHTML = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:18px;padding:36px 44px;display:flex;flex-direction:column;align-items:center;gap:14px;min-width:340px;box-shadow:0 12px 48px rgba(0,0,0,0.45)">
                <div style="font-size:3rem;line-height:1">⭐</div>
                <div style="font-size:1.1rem;font-weight:700;color:var(--text)">Saving to STAR Quiz…</div>
                <div style="width:300px;height:9px;background:rgba(255,255,255,0.06);border-radius:8px;overflow:hidden">
                    <div id="impProgBar" style="height:100%;background:linear-gradient(90deg,#f5a623,#f76b1c);border-radius:8px;transition:width 0.3s;width:0%"></div>
                </div>
                <span id="impProgText" style="font-size:0.82rem;color:var(--text-dim)">Preparing…</span>
            </div>`;
    document.body.appendChild(ov);

    let savedQ = 0, saved = 0, failed = [];
    for (const lec of lectures) {
        const lecArr = groups[lec];
        document.getElementById("impProgText").textContent = `Saving lecture ${lec} to STAR Quiz…`;
        const resp = await fetch(`${API_BASE}/api/admin/star-quiz/add-question`, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chapter, lecture: lec, topic, questions: lecArr })
        });
        if (resp.ok) {
            for (let i = 0; i < lecArr.length; i++) {
                savedQ++;
                const pct = Math.round((savedQ / totalQs) * 100);
                document.getElementById("impProgBar").style.width = pct + "%";
                document.getElementById("impProgText").textContent = `${savedQ}/${totalQs} questions saved to STAR Quiz`;
                if (i < lecArr.length - 1) await new Promise(r => setTimeout(r, 55));
            }
            // Apply lecture code if provided
            if (lectureCode) {
                try {
                    document.getElementById("impProgText").textContent = `Setting access code for lecture ${lec}…`;
                    await fetch(`${API_BASE}/api/admin/star-quiz/set-code/${encodeURIComponent(chapter)}/${encodeURIComponent(lec)}`, {
                        method: "POST", credentials: "include",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ accessCode: lectureCode })
                    });
                } catch (codeErr) { console.warn("Failed to set lecture code:", codeErr); }
            }
            saved++;
        } else { failed.push(lec); }
    }

    document.getElementById("saveProgressOverlay")?.remove();
    const codeNote = lectureCode ? ` Access code: ${lectureCode}.` : "";
    document.getElementById("successModalTitle").textContent = saved > 0 ? "⭐ STAR Quiz Saved!" : "Failed";
    document.getElementById("successModalText").textContent = failed.length === 0
        ? `${savedQ} question(s) saved to STAR Quiz under "${chapter}".${codeNote}`
        : `Saved: ${savedQ}. Failed lectures: ${failed.join(", ")}.`;
    openModal("successModal");
    await loadStarQuizData();
}


/* ═══════════════════════════════════════════════════════════════
   PAPER BASKET — Add to Paper / Generate Paper
   ═══════════════════════════════════════════════════════════════ */

// paperBasket: Map<key, item>  persists for the whole admin session
const paperBasket = new Map();
// Top-level `const` is a lexical global, not a window property, so expose it
// explicitly for shared-pool.js (Combine & Create).
window.paperBasket = paperBasket;

/* Returns the unique key for the currently viewed question */
function _mqPaperKey() {
    if (_mqCurrentViewGi === null || _mqCurrentViewSqIdx === undefined) return null;
    return `${_mqCurrentViewGi}:${_mqCurrentViewSqIdx}`;
}

/* Toggle the current question in/out of the paper basket */
function toggleAddToPaper() {
    const key = _mqPaperKey();
    if (!key) return;
    if (paperBasket.has(key)) {
        paperBasket.delete(key);
    } else {
        const gi = _mqCurrentViewGi;
        const si = _mqCurrentViewSqIdx;
        const qSet = allQuestions[gi];
        if (!qSet) return;
        const q = qSet.questions[si];
        if (!q) return;
        // Preserve image: inject _imgB64 / _manualImgB64 into q.questionImage
        // so it survives the round-trip to the backend paper generator
        const qWithImg = { ...q };
        if (!qWithImg.questionImage) {
            const imgB64 = q._manualImgB64 || q._imgB64 || null;
            if (imgB64) {
                qWithImg.questionImage = imgB64.startsWith("data:") ? imgB64 : `data:image/jpeg;base64,${imgB64}`;
            }
        }
        paperBasket.set(key, {
            chapter: qSet.chapter || "(No Chapter)",
            topic: qSet.topic || "",
            lecture: qSet.lecture,
            questionIndex: si,  // index of this question within its lecture set
            source: qWithImg._source || 'bank',
            q: qWithImg,
            _key: key,
            _label: `${qSet.topic || qSet.chapter || "Ch?"} / Q${si + 1}`
        });
    }
    _updateAddToPaperBtn();
    _updatePaperBasketUI();
}

/* Sync the button colour/label to reflect current selection state */
function _updateAddToPaperBtn() {
    const btn = document.getElementById('mq-add-to-paper-btn');
    if (!btn) return;
    const key = _mqPaperKey();
    const inPaper = key && paperBasket.has(key);
    btn.style.background = inPaper ? 'var(--success)' : 'var(--accent-4)';
    btn.textContent = inPaper ? '\u2705 Selected' : '\u2714\ufe0f Select Question';
}

/* Rebuild the floating basket widget */
function _updatePaperBasketUI() {
    const basket = document.getElementById('paper-basket');
    const countEl = document.getElementById('paper-basket-count');
    const pillCount = document.getElementById('paper-basket-pill-count');
    const listEl = document.getElementById('paper-basket-list');
    if (!basket) return;
    const n = paperBasket.size;
    if (n === 0) {
        basket.style.display = 'none';
        _closeBasketPanel();
        return;
    }
    basket.style.display = 'block';
    const label = `${n} question${n !== 1 ? 's' : ''} selected`;
    if (countEl) countEl.textContent = label;
    if (pillCount) pillCount.textContent = label;

    const entries = [...paperBasket.values()];
    const chapters = [...new Set(entries.map(e => e.chapter))];
    let html = '';
    for (const ch of chapters) {
        html += `<div style="font-weight:700;color:var(--accent);margin-top:4px">${ch}</div>`;
        for (const e of entries.filter(e => e.chapter === ch)) {
            const topicLabel = e.topic || e.chapter || 'Q';
            const qIdx = e._label.split('/Q')[1] || (String(entries.indexOf(e) + 1));
            html += `<div style="padding-left:10px;display:flex;align-items:center;gap:6px">
                    <span style="flex:1">${topicLabel} / Q${qIdx}</span>
                    <button onclick="removePaperItem('${e._key}')"
                        style="background:none;border:none;cursor:pointer;color:var(--error);font-size:0.75rem">&#10005;</button>
                </div>`;
        }
    }
    if (listEl) listEl.innerHTML = html;
}

/* Basket expand/collapse */
let _basketOpen = false;

function toggleBasketPanel(e) {
    e.stopPropagation();
    _basketOpen ? _closeBasketPanel() : _openBasketPanel();
}

function _openBasketPanel() {
    const panel = document.getElementById('paper-basket-panel');
    const chevron = document.getElementById('paper-basket-pill-chevron');
    if (panel) panel.style.display = 'block';
    if (chevron) chevron.style.transform = 'rotate(180deg)';
    _basketOpen = true;
}

function _closeBasketPanel() {
    const panel = document.getElementById('paper-basket-panel');
    const chevron = document.getElementById('paper-basket-pill-chevron');
    if (panel) panel.style.display = 'none';
    if (chevron) chevron.style.transform = 'rotate(0deg)';
    _basketOpen = false;
}

/* Close basket panel when clicking outside */
document.addEventListener('click', function (e) {
    if (!_basketOpen) return;
    const basket = document.getElementById('paper-basket');
    if (basket && !basket.contains(e.target)) {
        _closeBasketPanel();
    }
});

function removePaperItem(key) {
    paperBasket.delete(key);
    _updateAddToPaperBtn();
    _updatePaperBasketUI();
}

function clearPaperBasket() {
    paperBasket.clear();
    _updateAddToPaperBtn();
    _updatePaperBasketUI();
}

/* Spacebar shortcut — add/remove current question in view mode */
document.addEventListener('keydown', function (e) {
    if (!document.getElementById('section-manageQuestions')?.classList.contains('active')) return;
    const qView = document.getElementById('mq-question-view');
    if (!qView || qView.style.display === 'none') return;
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (document.querySelector('.modal-overlay.open, .modal-overlay[style*="flex"]')) return;
    if (_mqIsEditMode) return;
    if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        toggleAddToPaper();
    }
});

/* ── Generate Paper Modal helpers ─────────────────────────── */

function _ensurePaperHeaderFields() {
    // Fields are now baked directly into the HTML modal — nothing to inject.
}

function openGeneratePaperModal() {
    const modal = document.getElementById('generate-paper-modal');
    if (!modal) return;

    // Restore title, header fields, title field, and info for next manual run
    const titleEl = modal.querySelector('.modal-title');
    if (titleEl) { titleEl.style.display = ''; titleEl.textContent = '📄 Generate Question Paper'; }
    const headerFields = document.getElementById('paper-header-fields');
    if (headerFields) headerFields.style.display = '';
    const titleField = document.getElementById('paper-title-field');
    if (titleField) titleField.style.display = '';
    const genInfo = document.getElementById('paper-generate-info');
    if (genInfo) genInfo.style.display = '';

    // Ensure subject/chapter/test-type fields are injected (if not in HTML already)
    _ensurePaperHeaderFields();

    // ── Full state reset (fixes generate-button glitch after previous generation) ──
    document.getElementById('paper-generate-progress').style.display = 'none';
    document.getElementById('paper-download-links').style.display = 'none';
    document.getElementById('paper-download-links').innerHTML = '';
    document.getElementById('paper-modal-actions').style.display = 'flex';
    document.getElementById('paper-modal-close-actions').style.display = 'none';
    document.getElementById('paper-generate-info').style.display = '';
    document.getElementById('paper-generate-info').innerHTML =
        '3 DOCX files will be created: <strong>Question Paper</strong>, <strong>Answer Key</strong>, and <strong>Solutions</strong>.';
    document.getElementById('paper-template-status').style.display = '';

    // Re-enable generate button unconditionally
    const genBtn = document.getElementById('paper-generate-btn');
    if (genBtn) { genBtn.disabled = false; genBtn.style.opacity = ''; }

    const titleInput = document.getElementById('paper-title-input');
    if (titleInput) titleInput.value = 'Question Paper';
    const subjectInput = document.getElementById('paper-subject-input');
    if (subjectInput) subjectInput.value = '';
    const chapterInput = document.getElementById('paper-chapter-input');
    if (chapterInput) chapterInput.value = '';
    const testTypeInput = document.getElementById('paper-test-type-input');
    if (testTypeInput) testTypeInput.value = 'Chapter Test';
    const classInput = document.getElementById('paper-class-input');
    if (classInput) classInput.value = '';
    modal.style.display = 'flex';
    modal.classList.add('open');
    refreshTemplates();
    if (classInput) setTimeout(() => { classInput.focus(); }, 80);
    else if (subjectInput) setTimeout(() => { subjectInput.focus(); }, 80);
    else if (titleInput) setTimeout(() => { titleInput.focus(); titleInput.select(); }, 80);
}

function closeGeneratePaperModal() {
    const modal = document.getElementById('generate-paper-modal');
    if (modal) { modal.style.display = 'none'; modal.classList.remove('open'); }
}

/* Close modal when clicking the dark overlay */
document.addEventListener('click', function (e) {
    const modal = document.getElementById('generate-paper-modal');
    if (modal && e.target === modal) closeGeneratePaperModal();
    // Close template panel when clicking outside
    const panel = document.getElementById('templateManagerPanel');
    const btn = document.getElementById('templateManagerBtn');
    if (panel && panel.style.display !== 'none' && !panel.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
        panel.style.display = 'none';
    }
});

/* ── Template Management (multi-template, DB-backed) ────────────── */

let _templates = [];
let _selectedTemplateId = null;

function toggleTemplateManager() {
    const panel = document.getElementById('templateManagerPanel');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
        loadTplInstitutes();
        refreshTemplates();
    }
}

async function loadTplInstitutes() {
    const sel = document.getElementById('tplInstituteFilter');
    if (!sel) return;
    try {
        const resp = await fetch(`${API_BASE}/api/owner/institutes`, { credentials: 'include' });
        const data = await resp.json();
        const institutes = Array.isArray(data) ? data : (data.institutes || []);
        sel.innerHTML = '<option value="">All Institutes</option>';
        institutes.forEach(inst => {
            const opt = document.createElement('option');
            opt.value = inst.id;
            opt.textContent = inst.name + ' (' + inst.code + ')';
            sel.appendChild(opt);
        });
    } catch (e) { /* owner may not be loaded yet */ }
}

function onTplInstituteChange() {
    refreshTemplates();
}

async function refreshTemplates() {
    try {
        let url = `${API_BASE}/api/admin/paper-templates`;
        const filterEl = document.getElementById('tplInstituteFilter');
        if (filterEl && filterEl.value) {
            url += '?instituteId=' + encodeURIComponent(filterEl.value);
        }
        const resp = await fetch(url, { credentials: 'include' });
        // Silently bail on auth errors — session may not be established yet
        if (resp.status === 401 || resp.status === 403) return;
        if (!resp.ok) return;
        _templates = await resp.json();
        _renderTemplateList();
        _renderModalTemplateList();
        _agRenderTemplateList();
        _updateTemplateBadge();
    } catch (e) { /* ignore */ }
}

function _updateTemplateBadge() {
    const badge = document.getElementById('templateCountBadge');
    if (!badge) return;
    if (_templates.length > 0) { badge.textContent = _templates.length; badge.style.display = ''; }
    else badge.style.display = 'none';
}

function _renderTemplateList() {
    const container = document.getElementById('templateListContainer');
    if (!container) return;
    const showInstitute = _templates.some(t => t.instituteName);
    if (_templates.length === 0) {
        container.innerHTML = '<div style="padding:12px 16px;font-size:0.8rem;color:var(--text-muted)">No templates uploaded yet</div>';
    } else {
        container.innerHTML = _templates.map(t => {
            const date = new Date(t.createdAt).toLocaleDateString();
            const instBadge = t.instituteName
                ? `<span style="font-size:0.65rem;background:rgba(99,102,241,0.12);color:#818cf8;padding:1px 6px;border-radius:4px;font-weight:500">${escapeHtml(t.instituteName)}</span>`
                : '';
            return `<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;transition:background 0.12s"
                    onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background=''">
                    <span style="font-size:0.88rem">📄</span>
                    <div style="flex:1;min-width:0">
                        <div style="font-size:0.83rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(t.name)} ${instBadge}</div>
                        <div style="font-size:0.72rem;color:var(--text-muted)">${date}</div>
                    </div>
                    <button onclick="deleteTemplate(${t.id}, event)" title="Delete"
                        style="background:none;border:none;cursor:pointer;color:var(--error);font-size:0.85rem;padding:2px 5px;border-radius:5px;flex-shrink:0"
                        onmouseover="this.style.background='rgba(239,68,68,0.1)'" onmouseout="this.style.background='none'">🗑</button>
                </div>`;
        }).join('');
    }
}

function _renderModalTemplateList() {
    const container = document.getElementById('modal-template-list');
    if (!container) return;
    if (_templates.length === 0) {
        container.innerHTML = '<div style="font-size:0.8rem;color:var(--text-muted)">No templates — default styling will be used</div>';
        _selectedTemplateId = null;
        return;
    }
    if (!_selectedTemplateId || !_templates.find(t => t.id === _selectedTemplateId)) {
        _selectedTemplateId = _templates[0].id;
    }
    container.innerHTML = _templates.map(t => {
        const isSelected = _selectedTemplateId === t.id;
        const date = new Date(t.createdAt).toLocaleDateString();
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;background:${isSelected ? 'var(--accent-4)' : 'var(--bg-card)'};cursor:pointer;transition:background 0.15s;border:1.5px solid ${isSelected ? 'var(--accent-4)' : 'var(--border)'}"
                onclick="selectModalTemplate(${t.id})">
                <span style="font-size:0.9rem">${isSelected ? '✅' : '📄'}</span>
                <span style="flex:1;font-size:0.82rem;font-weight:${isSelected ? '700' : '500'};color:${isSelected ? '#fff' : 'var(--text)'}">${escapeHtml(t.name)}</span>
                <span style="font-size:0.72rem;color:${isSelected ? 'rgba(255,255,255,0.65)' : 'var(--text-muted)'}">${date}</span>
            </div>`;
    }).join('');
}

function selectModalTemplate(id) {
    _selectedTemplateId = id;
    _renderModalTemplateList();
    _agRenderTemplateList();
}

function uploadPaperTemplate(input, source) {
    const file = input?.files?.[0];
    if (!file) return;

    // Determine which progress elements to use
    const isModal = source === 'modal';
    const wrapId = isModal ? 'modal-tpl-upload-progress-wrap' : 'tpl-upload-progress-wrap';
    const barId = isModal ? 'modal-tpl-upload-bar' : 'tpl-upload-progress-bar';
    const pctId = isModal ? 'modal-tpl-upload-pct' : 'tpl-upload-progress-pct';
    const lblId = isModal ? 'modal-tpl-upload-label' : 'tpl-upload-progress-label';

    const wrap = document.getElementById(wrapId);
    const bar = document.getElementById(barId);
    const pct = document.getElementById(pctId);
    const lbl = document.getElementById(lblId);

    // Show progress bar
    if (wrap) wrap.style.display = 'block';
    if (bar) { bar.style.width = '0%'; bar.style.background = 'linear-gradient(90deg,var(--accent-4),#818cf8)'; }
    if (pct) pct.textContent = '0%';
    if (lbl) lbl.textContent = 'Uploading…';

    const fd = new FormData();
    fd.append('template', file);
    const filterEl = document.getElementById('tplInstituteFilter');
    if (filterEl && filterEl.value) {
        fd.append('instituteId', filterEl.value);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/admin/paper-templates`);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const percent = Math.round((e.loaded / e.total) * 90); // cap at 90% until server responds
        if (bar) bar.style.width = percent + '%';
        if (pct) pct.textContent = percent + '%';
    };

    xhr.onload = async () => {
        if (bar) bar.style.width = '100%';
        if (pct) pct.textContent = '100%';
        if (lbl) lbl.textContent = 'Processing…';
        try {
            const data = JSON.parse(xhr.responseText);
            if (data.id) {
                if (lbl) lbl.textContent = '✓ Uploaded!';
                if (bar) bar.style.background = 'linear-gradient(90deg,#22c55e,#4ade80)';
                await refreshTemplates();
                setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 1200);
            } else {
                if (lbl) lbl.textContent = '✗ Failed: ' + (data.error || 'Unknown error');
                if (bar) bar.style.background = '#ef4444';
                setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 2500);
            }
        } catch (e) {
            if (lbl) lbl.textContent = '✗ Upload error';
            if (bar) bar.style.background = '#ef4444';
            setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 2500);
        }
        input.value = '';
    };

    xhr.onerror = () => {
        if (lbl) lbl.textContent = '✗ Network error';
        if (bar) { bar.style.width = '100%'; bar.style.background = '#ef4444'; }
        setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 2500);
        input.value = '';
    };

    xhr.send(fd);
}

let _pendingDeleteId = null;

function deleteTemplate(id, event) {
    if (event) event.stopPropagation();
    // Find template name for display
    const tpl = (_templates || []).find(t => t.id === id);
    const name = tpl ? tpl.name : `Template #${id}`;
    _pendingDeleteId = id;
    // Show custom confirm popup
    const overlay = document.getElementById('delete-confirm-overlay');
    const nameEl = document.getElementById('delete-confirm-name');
    const progressWrap = document.getElementById('delete-progress-wrap');
    const actions = document.getElementById('delete-confirm-actions');
    const confirmBtn = document.getElementById('delete-confirm-btn');
    if (nameEl) nameEl.textContent = name;
    if (progressWrap) progressWrap.style.display = 'none';
    if (actions) actions.style.display = 'flex';
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '🗑️ Delete'; }
    if (overlay) { overlay.style.display = 'flex'; }
}

function closeDeleteConfirm() {
    const overlay = document.getElementById('delete-confirm-overlay');
    if (overlay) overlay.style.display = 'none';
    _pendingDeleteId = null;
}

async function confirmDeleteTemplate() {
    if (!_pendingDeleteId) return;
    const id = _pendingDeleteId;
    const progressWrap = document.getElementById('delete-progress-wrap');
    const bar = document.getElementById('delete-progress-bar');
    const label = document.getElementById('delete-progress-label');
    const actions = document.getElementById('delete-confirm-actions');
    const confirmBtn = document.getElementById('delete-confirm-btn');

    // Show progress, hide buttons
    if (actions) actions.style.display = 'none';
    if (progressWrap) progressWrap.style.display = 'block';
    if (bar) { bar.style.width = '0%'; bar.style.background = 'linear-gradient(90deg,#ef4444,#f87171)'; }
    if (label) label.textContent = 'Deleting…';

    // Animate bar to 70% while waiting
    let animPct = 0;
    const animInterval = setInterval(() => {
        animPct = Math.min(animPct + 8, 70);
        if (bar) bar.style.width = animPct + '%';
    }, 80);

    try {
        await fetch(`${API_BASE}/api/admin/paper-templates/${id}`, { method: 'DELETE', credentials: 'include' });
        clearInterval(animInterval);
        if (bar) bar.style.width = '100%';
        if (label) label.textContent = '✓ Deleted!';
        if (bar) bar.style.background = 'linear-gradient(90deg,#22c55e,#4ade80)';
        if (_selectedTemplateId === id) _selectedTemplateId = null;
        await refreshTemplates();
        setTimeout(() => closeDeleteConfirm(), 700);
    } catch (e) {
        clearInterval(animInterval);
        if (bar) { bar.style.width = '100%'; bar.style.background = '#ef4444'; }
        if (label) label.textContent = '✗ Failed: ' + e.message;
        if (actions) actions.style.display = 'flex';
        setTimeout(() => { if (progressWrap) progressWrap.style.display = 'none'; }, 2500);
    }
}

// Load on page init
refreshTemplates();

// ── Progress bar helpers for paper generation ──────────────────────────
const _pgenSteps = ['build', 'latex', 'template', 'finalise'];
const _pgenLabels = {
    build: 'Building documents…',
    latex: 'Converting equations…',
    template: 'Applying template…',
    finalise: 'Finalising files…',
};
const _pgenPct = { build: 15, latex: 45, template: 72, finalise: 90 };

function _pgenSet(activeKey, doneKeys = [], pct = null) {
    const bar = document.getElementById('paper-progress-bar');
    const label = document.getElementById('paper-progress-label');
    if (bar) bar.style.width = (pct !== null ? pct : (_pgenPct[activeKey] || 0)) + '%';
    if (label) label.textContent = _pgenLabels[activeKey] || '';
    for (const k of _pgenSteps) {
        const el = document.getElementById(`pstep-${k}`);
        if (!el) continue;
        if (doneKeys.includes(k)) {
            el.className = 'pgen-step done';
            el.textContent = `✅ ${el.dataset.label}`;
        } else if (k === activeKey) {
            el.className = 'pgen-step active';
            el.textContent = `⚙️ ${el.dataset.label}…`;
        } else {
            el.className = 'pgen-step';
            el.textContent = `⏳ ${el.dataset.label}`;
        }
    }
}

function _pgenReset() {
    const bar = document.getElementById('paper-progress-bar');
    if (bar) bar.style.width = '0%';
    for (const k of _pgenSteps) {
        const el = document.getElementById(`pstep-${k}`);
        if (el) { el.className = 'pgen-step'; el.textContent = `⏳ ${el.dataset.label}`; }
    }
}

async function generatePaper() {
    if (!paperBasket.size) { alert('No questions selected'); return; }
    const paperTitle = (document.getElementById('paper-title-input')?.value || 'Question Paper').trim();
    const paperSubject = (document.getElementById('paper-subject-input')?.value || '').trim();
    const paperChapter = (document.getElementById('paper-chapter-input')?.value || '').trim();
    const paperTestType = (document.getElementById('paper-test-type-input')?.value || 'Chapter Test').trim();
    const paperClass = (document.getElementById('paper-class-input')?.value || '').trim();

    if (!paperSubject && !paperChapter && !paperTestType) {
        if (!confirm('No subject, chapter or test type entered. The paper will use a plain title only. Continue?')) return;
    }

    // Assign sequential question numbers at generation time
    let qNum = 1;
    function _pbIsNumerical(q) {
        if (!q) return false;
        if ((q.question_type || '').toUpperCase() === 'INTEGER' || (q.questionType || '').toUpperCase() === 'INTEGER') return true;
        if (q.numericalAnswer !== undefined && q.numericalAnswer !== null) return true;
        if (Array.isArray(q.options) && q.options.every(function (o) { return !o || String(o).trim() === ''; }) && (!Array.isArray(q.optionImages) || q.optionImages.every(function (im) { return !im; }))) return true;
        return false;
    }
    const sortedItems = [...paperBasket.values()].sort(function (a, b) {
        return (_pbIsNumerical(a.q) ? 1 : 0) - (_pbIsNumerical(b.q) ? 1 : 0);
    });
    const questions = sortedItems.map(item => ({ ...item, qNum: qNum++ }));

    // Show progress, hide controls
    _pgenReset();
    _pgenSet('build', [], 0);
    document.getElementById('paper-generate-progress').style.display = 'block';
    document.getElementById('paper-generate-info').style.display = 'none';
    document.getElementById('paper-template-status').style.display = 'none';
    document.getElementById('paper-modal-actions').style.display = 'none';
    const genBtn = document.getElementById('paper-generate-btn');
    if (genBtn) genBtn.disabled = true;

    let pollInterval = null;
    let files;
    try {
        const resp = await fetch(`${API_BASE}/api/admin/generate-paper/start`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ questions, paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId: _selectedTemplateId || null })
        });

        if (resp.status === 404) {
            // ── Fallback: old synchronous route ──────────────────────────
            _pgenSet('build', [], 10);
            const syncResp = await fetch(`${API_BASE}/api/admin/generate-paper`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ questions, paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId: _selectedTemplateId || null })
            });
            const syncData = await syncResp.json();
            if (!syncResp.ok || !syncData.success) throw new Error(syncData.error || 'Generation failed');
            _pgenSet('finalise', ['build', 'latex', 'template'], 100);
            files = syncData.files;
        } else {
            // ── Async progress-polling route ──────────────────────────────
            const startData = await resp.json();
            if (!resp.ok || !startData.success) throw new Error(startData.error || 'Generation failed to start');

            const progressId = startData.progressId;

            files = await new Promise((resolve, reject) => {
                pollInterval = setInterval(async () => {
                    try {
                        const pResp = await fetch(`${API_BASE}/api/admin/generate-paper/progress/${progressId}`, {
                            credentials: 'include'
                        });
                        const pData = await pResp.json();
                        if (!pResp.ok || !pData.success) {
                            clearInterval(pollInterval);
                            reject(new Error(pData.error || 'Failed to fetch generation progress'));
                            return;
                        }

                        const progress = pData.progress;
                        const activeKey = progress.currentStep;
                        let doneKeys = [];
                        if (activeKey === 'latex') doneKeys = ['build'];
                        else if (activeKey === 'template') doneKeys = ['build', 'latex'];
                        else if (activeKey === 'finalise') doneKeys = ['build', 'latex', 'template'];

                        _pgenSet(activeKey, doneKeys, progress.pct);

                        if (progress.status === 'completed') {
                            clearInterval(pollInterval);
                            resolve(progress.files);
                        } else if (progress.status === 'failed') {
                            clearInterval(pollInterval);
                            reject(new Error(progress.error || 'Generation failed'));
                        }
                    } catch (pollErr) {
                        clearInterval(pollInterval);
                        reject(pollErr);
                    }
                }, 250);
            });
        }

        // Complete the bar
        _pgenSet('finalise', ['build', 'latex', 'template'], 100);
        const bar = document.getElementById('paper-progress-bar');
        if (bar) bar.style.width = '100%';
        const progressLabel = document.getElementById('paper-progress-label');
        if (progressLabel) progressLabel.textContent = 'Done! Files ready.';
        // Mark all done
        for (const k of _pgenSteps) {
            const el = document.getElementById(`pstep-${k}`);
            if (el) { el.className = 'pgen-step done'; el.textContent = `✅ ${el.dataset.label}`; }
        }

        await new Promise(r => setTimeout(r, 400)); // brief pause to show 100%

        // Store generated data for format chooser
        const safeTitle = paperTitle.replace(/[^a-z0-9_\-]/gi, '_');
        window._lastPaperGenData = {
            files: files,          // FIX: was incorrectly 'data.files'
            safeTitle: safeTitle,
            paperTitle: paperTitle,
            paperSubject: paperSubject,
            paperChapter: paperChapter,
            paperTestType: paperTestType,
            paperClass: paperClass,
            questions: questions,
            pdfFiles: null // will load lazily on click
        };

        // Build format chooser UI
        let formatHtml = `
                <div style="font-size:0.85rem;font-weight:700;color:var(--success);margin-bottom:14px;display:flex;align-items:center;gap:8px">
                    <span style="font-size:1.1rem">&#10004;</span> Files ready &mdash; choose download format:
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
                    <button id="fmt-docx-btn" onclick="selectDownloadFormat('docx')"
                        style="padding:16px 12px;background:var(--bg-card);border:2px solid var(--border);border-radius:12px;cursor:pointer;color:var(--text);font-family:inherit;text-align:center;transition:all .2s;display:flex;flex-direction:column;align-items:center;gap:6px">
                        <div style="font-size:1.8rem">&#128212;</div>
                        <div style="font-weight:800;font-size:0.9rem">Word (DOCX)</div>
                        <div style="font-size:0.7rem;color:var(--text-muted);line-height:1.3">Editable docx templates</div>
                    </button>
                    <button id="fmt-pdf-btn" onclick="selectDownloadFormat('pdf')"
                        style="padding:16px 12px;background:var(--bg-card);border:2px solid var(--border);border-radius:12px;cursor:pointer;color:var(--text);font-family:inherit;text-align:center;transition:all .2s;display:flex;flex-direction:column;align-items:center;gap:6px">
                        <div style="font-size:1.8rem">&#128213;</div>
                        <div style="font-weight:800;font-size:0.9rem">PDF Document</div>
                        <div style="font-size:0.7rem;color:var(--text-muted);line-height:1.3">Print-ready PDF layout</div>
                    </button>
                </div>
                <div id="fmt-download-status" style="display:none;font-size:0.82rem;padding:10px 14px;border-radius:10px;margin-bottom:12px"></div>
                <div id="fmt-download-links" style="display:none"></div>`;

        document.getElementById('paper-generate-progress').style.display = 'none';
        document.getElementById('paper-download-links').innerHTML = formatHtml;
        document.getElementById('paper-download-links').style.display = 'block';
        document.getElementById('paper-modal-close-actions').style.display = 'flex';

        // Hide title, header fields, and title field for manual success screen
        const modal = document.getElementById('generate-paper-modal');
        if (modal) {
            const titleEl = modal.querySelector('.modal-title');
            if (titleEl) titleEl.style.display = 'none';
        }
        const headerFields = document.getElementById('paper-header-fields');
        if (headerFields) headerFields.style.display = 'none';
        const titleField = document.getElementById('paper-title-field');
        if (titleField) titleField.style.display = 'none';

        // Automatically select Word format first (no auto-download)
        selectDownloadFormat('docx');

    } catch (err) {
        if (pollInterval) clearInterval(pollInterval); // FIX: was clearTimeout(_pgenTimer) — wrong fn + undeclared var
        document.getElementById('paper-generate-progress').style.display = 'none';
        document.getElementById('paper-template-status').style.display = '';
        document.getElementById('paper-generate-info').innerHTML =
            `<span style="color:var(--error)">&#10060; Error: ${err.message}</span>`;
        document.getElementById('paper-generate-info').style.display = '';
        document.getElementById('paper-modal-actions').style.display = 'flex';
        if (genBtn) genBtn.disabled = false;
    }
}

async function selectDownloadFormat(format) {
    const docxBtn = document.getElementById('fmt-docx-btn');
    const pdfBtn = document.getElementById('fmt-pdf-btn');
    const statusEl = document.getElementById('fmt-download-status');
    const linksEl = document.getElementById('fmt-download-links');

    if (!docxBtn || !pdfBtn || !statusEl || !linksEl) return;

    // Reset styles
    docxBtn.style.borderColor = 'var(--border)';
    docxBtn.style.background = 'var(--bg-card)';
    pdfBtn.style.borderColor = 'var(--border)';
    pdfBtn.style.background = 'var(--bg-card)';

    if (format === 'docx') {
        docxBtn.style.borderColor = 'var(--accent-4)';
        docxBtn.style.background = 'rgba(86,169,255,0.05)';
        statusEl.style.display = 'none';
        renderFormatLinks('docx', window._lastPaperGenData.files);
        // No auto-download — user clicks individually or uses Download All button
    } else if (format === 'pdf') {
        pdfBtn.style.borderColor = '#ef4444';
        pdfBtn.style.background = 'rgba(239,68,68,0.05)';

        if (window._lastPaperGenData.pdfFiles) {
            statusEl.style.display = 'none';
            renderFormatLinks('pdf', window._lastPaperGenData.pdfFiles);
            // No auto-download — user clicks individually or uses Download All button
        } else {
            linksEl.style.display = 'none';
            statusEl.style.display = 'block';
            statusEl.style.background = 'var(--bg-input)';
            statusEl.style.border = '1px solid var(--border)';
            statusEl.style.color = 'var(--text-dim)';
            statusEl.style.padding = '14px 18px';
            statusEl.style.borderRadius = '10px';
            statusEl.innerHTML = `
                        <div style="display:flex;align-items:center;justify-content:between;gap:8px;font-size:0.8rem;font-weight:700;margin-bottom:6px">
                            <span id="pdf-progress-text" style="color:var(--text)">Preparing files for PDF conversion...</span>
                            <span id="pdf-progress-percent" style="margin-left:auto;color:var(--text-dim)">0%</span>
                        </div>
                        <div style="width:100%;height:6px;background:rgba(255,255,255,0.06);border-radius:6px;overflow:hidden">
                            <div id="pdf-progress-bar" style="width:0%;height:100%;background:linear-gradient(90deg,#ef4444,#f87171);transition:width 0.4s ease;border-radius:6px"></div>
                        </div>
                    `;

            const updateProgress = (pct, text) => {
                const bar = document.getElementById('pdf-progress-bar');
                const txt = document.getElementById('pdf-progress-text');
                const num = document.getElementById('pdf-progress-percent');
                if (bar) bar.style.width = pct + '%';
                if (txt && text) txt.textContent = text;
                if (num) num.textContent = pct + '%';
            };

            const getPdfStepText = (step) => {
                switch (step) {
                    case 'build': return 'Building document structure...';
                    case 'latex': return 'Converting equations (LaTeX)...';
                    case 'template': return 'Applying template styling...';
                    case 'finalise': return 'Packaging Word files...';
                    case 'pdf_questions': return 'Converting Question Paper to PDF...';
                    case 'pdf_solutions': return 'Converting Solutions to PDF...';
                    default: return 'Preparing files...';
                }
            };

            let pollInterval = null;
            try {
                const resp = await fetch(`${API_BASE}/api/admin/generate-paper-pdf/start`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        questions: window._lastPaperGenData.questions,
                        paperTitle: window._lastPaperGenData.paperTitle,
                        paperSubject: window._lastPaperGenData.paperSubject || '',
                        paperChapter: window._lastPaperGenData.paperChapter || '',
                        paperTestType: window._lastPaperGenData.paperTestType || 'Chapter Test',
                        paperClass: window._lastPaperGenData.paperClass || '',
                        templateId: typeof _selectedTemplateId !== 'undefined' ? _selectedTemplateId : null
                    })
                });
                const startData = await resp.json();
                if (!resp.ok || !startData.success) throw new Error(startData.error || 'Failed to start PDF conversion');

                const progressId = startData.progressId;

                const pdfFiles = await new Promise((resolve, reject) => {
                    pollInterval = setInterval(async () => {
                        try {
                            const pResp = await fetch(`${API_BASE}/api/admin/generate-paper/progress/${progressId}`, {
                                credentials: 'include'
                            });
                            const pData = await pResp.json();
                            if (!pResp.ok || !pData.success) {
                                clearInterval(pollInterval);
                                reject(new Error(pData.error || 'Failed to fetch conversion progress'));
                                return;
                            }

                            const progress = pData.progress;
                            updateProgress(progress.pct, getPdfStepText(progress.currentStep));

                            if (progress.status === 'completed') {
                                clearInterval(pollInterval);
                                resolve(progress.files);
                            } else if (progress.status === 'failed') {
                                clearInterval(pollInterval);
                                reject(new Error(progress.error || 'PDF conversion failed'));
                            }
                        } catch (pollErr) {
                            clearInterval(pollInterval);
                            reject(pollErr);
                        }
                    }, 300);
                });

                updateProgress(100, "Done!");
                await new Promise(r => setTimeout(r, 200));

                window._lastPaperGenData.pdfFiles = pdfFiles;
                statusEl.style.display = 'none';
                renderFormatLinks('pdf', pdfFiles);
                // No auto-download — user clicks individually or uses Download All button
            } catch (err) {
                if (pollInterval) clearInterval(pollInterval);
                statusEl.style.background = 'rgba(239,68,68,0.1)';
                statusEl.style.border = '1px solid rgba(239,68,68,0.2)';
                statusEl.style.color = 'var(--error)';
                const isLibreOfficeErr = err.message && (err.message.includes('LibreOffice is not installed') || err.message.includes('ENOENT'));
                statusEl.innerHTML = isLibreOfficeErr
                    ? `&#10060; PDF generation requires LibreOffice on the server.<br>
                               <span style="font-size:0.78rem;opacity:0.85">Add <code style="background:rgba(0,0,0,0.12);padding:1px 5px;border-radius:4px">apt-get install -y libreoffice</code> to your Dockerfile or server build script, then redeploy.</span>`
                    : `&#10060; Error: ${err.message}`;
            }
        }
    }
}

function openPaperTypeChooser() {
    const modal = document.getElementById("paper-type-chooser");
    if (modal) modal.style.display = "flex";
}

function closePaperTypeChooser() {
    const modal = document.getElementById("paper-type-chooser");
    if (modal) modal.style.display = "none";
}

function choosePaperType(type) {
    closePaperTypeChooser();
    if (type === "offline") {
        openGeneratePaperModal();
    } else if (type === "online") {
        const otModal = document.getElementById("online-test-details-modal");
        if (otModal) {
            otModal.style.display = "flex";
            if (typeof _otUpdateScheduleGap === "function") _otUpdateScheduleGap();
            if (typeof otUpdateDurPreview === "function") otUpdateDurPreview();
        }
    }
}
