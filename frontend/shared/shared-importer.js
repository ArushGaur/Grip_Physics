/* ══════════════════════════════════════════════════════════════════
   IMAGE UTILITIES — shared helpers
══════════════════════════════════════════════════════════════════ */

/** Convert a File object to a base64 string (no data: prefix) */

/* ══════════════════════════════════════════════════════════════════
   IMPORT FROM SCREENSHOT — v2
   ─────────────────────────────────────────────────────────────────
   Architecture:
     • 3-step wizard: Upload → Extract (live progress) → Review/Save
     • OpenCV.js for client-side diagram cropping + enhancement
     • Undo / Redo for the review stage
     • Per-question: inline edit, answer mode toggle, manual crop
══════════════════════════════════════════════════════════════════ */

/* ── Utilities ──────────────────────────────────────────────────── */
function impFileToB64(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = e => res(e.target.result.split(",")[1]);
        r.onerror = rej;
        r.readAsDataURL(file);
    });
}

function impB64ToDataUrl(b64) {
    if (!b64) return "";
    if (b64.startsWith("data:")) return b64;
    const mime = b64.startsWith("/9j/") ? "image/jpeg"
        : b64.startsWith("iVBORw") ? "image/png"
            : b64.startsWith("R0lGOD") ? "image/gif"
                : "image/jpeg";
    return `data:${mime};base64,${b64}`;
}

function impIsOpenCVReady() {
    return typeof cv !== "undefined" && cv && typeof cv.imread === "function";
}

/* ── OpenCV-enhanced region crop ─────────────────────────────────── */
async function impCropRegion(srcB64, region) {
    return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            try {
                const W = img.naturalWidth, H = img.naturalHeight;
                const PAD = 0.03;
                const rx = Math.max(0, region.x - PAD);
                const ry = Math.max(0, region.y - PAD);
                const rw = Math.min(1 - rx, region.w + PAD * 2);
                const rh = Math.min(1 - ry, region.h + PAD * 2);
                const x = Math.max(0, Math.round(rx * W));
                const y = Math.max(0, Math.round(ry * H));
                const w = Math.min(W - x, Math.round(rw * W));
                const h = Math.min(H - y, Math.round(rh * H));
                if (w < 8 || h < 8) { resolve(null); return; }

                const srcC = document.createElement("canvas");
                srcC.width = W; srcC.height = H;
                srcC.getContext("2d").drawImage(img, 0, 0);

                const cropC = document.createElement("canvas");
                cropC.width = w; cropC.height = h;
                cropC.getContext("2d").drawImage(srcC, x, y, w, h, 0, 0, w, h);

                if (impIsOpenCVReady()) {
                    try {
                        const src = cv.imread(cropC);
                        const gray = new cv.Mat();
                        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
                        const brightness = cv.mean(gray)[0];
                        const out = new cv.Mat();
                        if (brightness < 55 || brightness > 205) {
                            const clahe = new cv.CLAHE(2.5, new cv.Size(8, 8));
                            const eq = new cv.Mat();
                            clahe.apply(gray, eq);
                            cv.cvtColor(eq, out, cv.COLOR_GRAY2RGBA);
                            eq.delete(); clahe.delete();
                        } else {
                            const k = cv.matFromArray(3, 3, cv.CV_32F,
                                [0, -0.5, 0, -0.5, 3, -0.5, 0, -0.5, 0]);
                            cv.filter2D(src, out, cv.CV_8U, k,
                                new cv.Point(-1, -1), 0, cv.BORDER_DEFAULT);
                            k.delete();
                        }
                        cv.imshow(cropC, out);
                        src.delete(); gray.delete(); out.delete();
                    } catch (cvErr) { /* fall through to plain crop */ }
                }

                const dataUrl = cropC.toDataURL("image/jpeg", 0.93);
                resolve(dataUrl.split(",")[1] || null);
            } catch (e) { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = impB64ToDataUrl(srcB64);
    });
}

/* ── Process AI results: attach extracted image to each question ── */
async function impProcessImages(questions) {
    const total = questions.length;
    const qsPerScreen = Math.max(1, Math.ceil(total / (impQImages.length || 1)));
    for (let qi = 0; qi < questions.length; qi++) {
        const q = questions[qi];
        if (!q.hasImage) { q._imgB64 = null; continue; }
        const direct = q.questionImage || q.imageB64;
        if (direct && direct.length > 10) {
            q._imgB64 = direct.startsWith("data:") ? direct.split(",")[1] : direct;
            continue;
        }
        if (q.imageRegion && typeof q.imageRegion.x === "number" && impQImages.length) {
            const si = Number.isInteger(q.imageSourceIndex)
                ? Math.min(q.imageSourceIndex, impQImages.length - 1)
                : Math.min(Math.floor(qi / qsPerScreen), impQImages.length - 1);
            const cropped = await impCropRegion(impQImages[si], q.imageRegion);
            if (cropped) { q._imgB64 = cropped; continue; }
        }
        q._imgB64 = null;
    }
}

/* ── Wizard step management ──────────────────────────────────────── */
function impSetStep(n) {
    [1, 2, 3].forEach(i => {
        const el = document.getElementById(`impStep${i}`);
        el.classList.remove("active", "done");
        if (i < n) el.classList.add("done");
        if (i === n) el.classList.add("active");
    });
}

function impGoBackToUpload() {
    document.getElementById("impPanelReview").style.display = "none";
    document.getElementById("impPanelUpload").style.display = "block";
    impSetStep(1);
    setTimeout(() => {
        const up = document.getElementById("impPanelUpload");
        if (up) up.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
}

/* ── Preview grid helpers ────────────────────────────────────────── */
function impMakeThumb(b64, idx, type) {
    const div = document.createElement("div");
    div.className = "imp-thumb";
    const url = impB64ToDataUrl(b64);
    div.innerHTML = `<img src="${url}" alt=""><button class="imp-thumb-remove" onclick="impRemoveThumb('${type}',${idx})">✕</button><div class="imp-thumb-label">${type === "q" ? "Q" : "Ans"} ${idx + 1}</div>`;
    return div;
}

function impRefreshPreviews() {
    const qg = document.getElementById("impQPreviews");
    qg.innerHTML = "";
    impQImages.forEach((b, i) => qg.appendChild(impMakeThumb(b, i, "q")));
    const ag = document.getElementById("impAPreviews");
    ag.innerHTML = "";
    impAImages.forEach((b, i) => ag.appendChild(impMakeThumb(b, i, "a")));
    impCheckReady();
}

function impRemoveThumb(type, idx) {
    if (type === "q") impQImages.splice(idx, 1);
    else impAImages.splice(idx, 1);
    impRefreshPreviews();
}

async function impHandleQFiles(input) {
    for (const f of input.files) {
        if (f) impQImages.push(await impFileToB64(f));
    }
    impRefreshPreviews();
}

async function impHandleAFiles(input) {
    for (const f of input.files) {
        if (f) impAImages.push(await impFileToB64(f));
    }
    impRefreshPreviews();
}

function impCheckReady() {
    let ready = false;
    const isManual = document.getElementById('impAkTabManual')?.classList.contains('active');
    const hasManual = isManual && document.getElementById('impManualAnswerKey')?.value.trim().length > 0;
    const hasAnsImg = !isManual && impAImages.length > 0;
    ready = impQImages.length > 0 && (hasManual || hasAnsImg);
    document.getElementById('impExtractBtn').disabled = !ready;
}

function impSwitchAKTab(tab) {
    document.getElementById("impAkTabScreenshot").classList.toggle("active", tab === "screenshot");
    document.getElementById("impAkTabManual").classList.toggle("active", tab === "manual");
    document.getElementById("impAkScreenshotPanel").style.display = tab === "screenshot" ? "block" : "none";
    document.getElementById("impAkManualPanel").style.display = tab === "manual" ? "block" : "none";
    impCheckReady();
}

document.getElementById("impManualAnswerKey")?.addEventListener("input", impCheckReady);

/* Paste handler — paste into question zone, answer zone, or solution zone */
document.addEventListener("paste", async function (e) {
    if (!document.getElementById("section-importQuestion")?.classList.contains("active")) return;
    // If a crop-dropzone is focused, let per-question paste handler deal with it
    if (document.activeElement?.closest('[id^="impDiagZone_"]')) return;
    // If the solution zone is focused, paste goes there
    const solZoneFocused = document.activeElement?.id === 'impSolScreenshotZone'
        || document.activeElement?.closest('#impSolPanelScreenshot');
    if (solZoneFocused) return; // handled by zone's own paste listener
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
    if (!items) return;

    // Collect all image items first
    const imageItems = [...items].filter(item => item.type.startsWith("image/"));
    if (!imageItems.length) return;

    e.preventDefault();

    // Check if the solution section is focused — route all images there
    const solSection = document.getElementById('impSolutionSection');
    const solSectionFocused = solSection && (solSection.contains(document.activeElement) || document.activeElement?.id === 'impSolPasteBtn');

    if (solSectionFocused) {
        for (const item of imageItems) {
            const file = item.getAsFile();
            if (!file) continue;
            const dt = new DataTransfer(); dt.items.add(file);
            const inp = document.getElementById('impSolScreenshotInput');
            if (inp) { inp.files = dt.files; impHandleSolScreenshots(inp); }
        }
        return;
    }

    // Route all pasted images into question or answer zone
    impUndoPush(impSnap());
    const isManualTab = document.getElementById("impAkTabManual").classList.contains("active");
    for (const item of imageItems) {
        const file = item.getAsFile();
        if (!file) continue;
        const b64 = await impFileToB64(file);
        if (!isManualTab && document.getElementById("impAkTabScreenshot").classList.contains("active")
            && impQImages.length > 0 && impAImages.length === 0) {
            impAImages.push(b64);
        } else {
            impQImages.push(b64);
        }
    }
    impRefreshPreviews();
});

/* Paste into per-question diagram dropzone */
document.addEventListener("paste", async function (e) {
    if (!document.getElementById("section-importQuestion")?.classList.contains("active")) return;
    const focused = document.activeElement?.closest('[id^="impDiagZone_"]');
    if (!focused) return;
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
    if (!items) return;
    for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        e.preventDefault(); e.stopPropagation();
        const qi = parseInt(focused.id.replace("impDiagZone_", ""));
        if (!isNaN(qi)) impSetDiagramImage(qi, await impFileToB64(item.getAsFile()));
        break;
    }
});

/* Drag-drop on upload zones */
["impQZone", "impAZone"].forEach(zid => {
    const z = document.getElementById(zid);
    if (!z) return;
    z.addEventListener("dragover", e => { e.preventDefault(); z.classList.add("dragover"); });
    z.addEventListener("dragleave", () => z.classList.remove("dragover"));
    z.addEventListener("drop", async e => {
        e.preventDefault(); z.classList.remove("dragover");
        for (const f of e.dataTransfer.files) {
            if (f && f.type.startsWith("image/")) {
                const b64 = await impFileToB64(f);
                impUndoPush(impSnap());
                if (zid === "impQZone") impQImages.push(b64);
                else impAImages.push(b64);
            }
        }
        impRefreshPreviews();
    });
});

/* ── Live progress display ───────────────────────────────────────── */
const IMP_STEPS_META = [
    { key: "upload", label: "Uploading images to AI" },
    { key: "primary", label: "Parallel primary extraction" },
    { key: "count", label: "Verifying question count" },
    { key: "recovery", label: "Recovery pass for missed questions" },
    { key: "merge", label: "Cross-image boundary merge" },
    { key: "answer", label: "Answer key overlay" },
    { key: "dedup", label: "Deduplication & sorting" },
    { key: "images", label: "Extracting diagram regions" },
];

function impShowProgress(activeKey, doneKeys = []) {
    const st = document.getElementById("impStatus");
    st.className = "imp-status loading";
    st.style.display = "block";
    const rows = IMP_STEPS_META.map(s => {
        const isDone = doneKeys.includes(s.key);
        const isActive = s.key === activeKey;
        const cls = isDone ? "done" : isActive ? "active" : "";
        const icon = isDone ? "✓" : isActive ? "⋯" : "";
        return `<div class="imp-progress-step ${cls}"><div class="pstep-dot"></div>${icon ? `<span style="font-size:0.7rem;min-width:14px">${icon}</span>` : '<span style="min-width:14px"></span>'}<span>${s.label}</span></div>`;
    }).join("");
    st.innerHTML = `<div style="font-weight:600;margin-bottom:6px"><span class="spinner"></span>&nbsp; Extracting questions…</div><div class="imp-progress-steps">${rows}</div>`;
}

function impShowSuccess(msg) {
    const st = document.getElementById("impStatus");
    st.className = "imp-status success";
    st.style.display = "block";
    st.innerHTML = msg;
}

function impShowError(msg) {
    const st = document.getElementById("impStatus");
    st.className = "imp-status error";
    st.style.display = "block";
    st.innerHTML = `❌ ${msg}`;
}

/* ── Main extraction flow ────────────────────────────────────────── */
async function impExtractWithAI() {
    const chapter = document.getElementById("imp-chapter").value.trim();
    const startLec = parseInt(document.getElementById("imp-lecture").value);
    if (_impType === "star_quiz" && !chapter) { showErrorModal("Please enter a chapter name. Chapter is required for STAR Quiz.", "Missing fields"); return; }
    if (_impType === "star_quiz" && (!startLec || startLec < 1)) { showErrorModal("Please enter a starting lecture number.", "Invalid"); return; }

    /* ── Validate ───────────────────────────────────────────── */
    if (!impQImages.length) { showErrorModal("Please upload at least one question screenshot.", "Missing"); return; }
    const isManualAK = document.getElementById("impAkTabManual").classList.contains("active");
    const manualAKVal = document.getElementById("impManualAnswerKey").value.trim();
    if (!isManualAK && !impAImages.length) {
        showErrorModal("Please upload an answer key screenshot or switch to manual entry.", "Missing");
        return;
    }

    //JSON Upload mode — handled by its own upload flow
    if (_impType === "json_upload") {
        showErrorModal("For JSON Upload, use the upload panel above to select your JSON file.", "Use JSON Upload");
        return;
    }

    document.getElementById("impExtractBtn").disabled = true;
    impSetStep(2);
    impShowProgress("upload", []);
    await new Promise(r => setTimeout(r, 80));

    try {
        /* ── Screenshot extraction ───────────────────────────── */
        const isManual = document.getElementById("impAkTabManual").classList.contains("active");
        const manualAK = document.getElementById("impManualAnswerKey").value.trim();
        const payload = { questionImages: impQImages };
        if (isManual && manualAK) payload.manualAnswerKey = manualAK;
        else if (impAImages.length) payload.answerImages = impAImages;

        impShowProgress("primary", ["upload"]);
        const r = await fetch(`${API_BASE}/api/admin/extract`, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        impShowProgress("count", ["upload", "primary"]);
        await new Promise(rv => setTimeout(rv, 60));

        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.error || "Server error");
        }

        const data = await r.json();
        const parsed = data.questions;
        if (!Array.isArray(parsed) || !parsed.length) throw new Error("No questions found in the uploaded file.");

        impShowProgress("images", ["upload", "primary", "count", "recovery", "merge", "answer", "dedup"]);

        // Process AI-detected image regions (client-side OpenCV crop, screenshot-only)
        await impProcessImages(parsed);

        impQuestions = parsed.map((q, i) => {
            const existingSolutions = Array.isArray(q.solutions)
                ? q.solutions
                : (q.solution || q.explanation || q.sol)
                    ? [{ text: q.solution || q.explanation || q.sol || "" }]
                    : [];
            return {
                ...q,
                // Strip leading question-number prefix (e.g. "13. ", "13) ", "Q13. ") from question text
                question: String(q.question || "").replace(/^\s*(?:Q\.?\s*)?\d{1,3}\s*[\.\)\:\-–]\s*/i, ""),
                assignedLecture: _impType === "star_quiz" ? startLec : (startLec ? startLec + i : i + 1),
                _manualImgB64: null,
                solutions: existingSolutions,
                _pyqMeta: _impType === "pyq" ? {
                    year: document.getElementById("pyq-year").value.trim(),
                    month: document.getElementById("pyq-month").value,
                    date: document.getElementById("pyq-date").value.trim(),
                    shift: document.getElementById("pyq-shift").value
                } : null,
            };
        });

        // ── AI Chapter/Topic Tagging for PYQ ─────────────────────────
        if (_impType === "pyq" && impQuestions.length > 0) {
            try {
                const statusEl = document.getElementById("impStatus");
                if (statusEl) statusEl.innerHTML += `<div style="display:flex;align-items:center;gap:8px;color:var(--text-dim);font-size:0.85rem;margin-top:8px" id="pyqTagStatus"><span style="animation:spin 1s linear infinite;display:inline-block">🏷️</span> AI tagging chapters & topics from JEE syllabus…</div>`;

                const questionsForTagging = impQuestions.map(q => q.question);
                const tagResp = await fetch(`${API_BASE}/api/admin/pyq-tag-questions`, {
                    method: "POST", credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ questions: questionsForTagging })
                });

                if (tagResp.ok) {
                    const tagData = await tagResp.json();
                    if (Array.isArray(tagData.tags)) {
                        tagData.tags.forEach((tag, i) => {
                            if (impQuestions[i] && tag) {
                                impQuestions[i]._pyqUnit = tag.unit || "";
                                impQuestions[i]._pyqChapter = tag.chapter || "";
                                impQuestions[i]._pyqTopic = tag.topic || "";
                            }
                        });
                    }
                }
                const pyqTagEl = document.getElementById("pyqTagStatus");
                if (pyqTagEl) pyqTagEl.innerHTML = `<span style="color:var(--success)">✓</span> Questions tagged by chapter & topic.`;
            } catch (tagErr) {
                console.warn("PYQ tagging failed:", tagErr);
            }
        }

        // ── AI Solution Extraction (all import types when solution screenshots provided) ──
        {
            const hasSolImages = _impSolScreenshots.length > 0;

            if (hasSolImages) {
                try {
                    const statusEl = document.getElementById("impStatus");
                    if (statusEl) statusEl.innerHTML += `<div style="display:flex;align-items:center;gap:8px;color:var(--text-dim);font-size:0.85rem;margin-top:8px" id="solExtractStatus"><span style="animation:spin 1s linear infinite;display:inline-block">⚙️</span> Extracting &amp; mapping solutions with AI…</div>`;

                    const solResp = await fetch(`${API_BASE}/api/admin/extract-solutions`, {
                        method: "POST", credentials: "include",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ solutionImages: _impSolScreenshots, questionCount: impQuestions.length })
                    });

                    if (solResp && solResp.ok) {
                        const solData = await solResp.json();
                        // Build questionNumber -> array-index map
                        const qNumToArrIdx = new Map();
                        impQuestions.forEach((q, idx) => {
                            const qn = q.questionNumber || (idx + 1);
                            qNumToArrIdx.set(qn, idx);
                        });
                        // Also build text-prefix number map as fallback
                        const qTextNumMap = new Map();
                        impQuestions.forEach((q, idx) => {
                            const m = String(q.question || '').match(/^\s*(?:q\.?\s*)?(\d{1,3})\s*[\).:–\-]/i);
                            if (m) qTextNumMap.set(parseInt(m[1], 10), idx);
                        });

                        // solutionsByQNum: keys are the actual question numbers parsed from solution text
                        const sqKeys = solData.solutionsByQNum ? Object.keys(solData.solutionsByQNum) : [];
                        if (sqKeys.length > 0) {
                            const unmatchedSolutions = [];
                            sqKeys.forEach(qNumStr => {
                                const sol = solData.solutionsByQNum[qNumStr];
                                if (!sol) return;
                                const qNum = parseInt(qNumStr, 10);
                                if (!qNum) return;
                                // Match by actual question number first, then by position
                                const arrIdx = qNumToArrIdx.has(qNum) ? qNumToArrIdx.get(qNum)
                                    : qTextNumMap.has(qNum) ? qTextNumMap.get(qNum) : null;
                                if (arrIdx !== null && impQuestions[arrIdx]) {
                                    impQuestions[arrIdx].solutions = [sol];
                                } else {
                                    unmatchedSolutions.push(sol);
                                }
                            });

                            // Fallback: if numbering doesn't match (e.g., extracted Q#34 but imported set has 1 item),
                            // attach unmatched solutions to questions by order.
                            if (unmatchedSolutions.length) {
                                const freeIndexes = impQuestions
                                    .map((q, idx) => ({ q, idx }))
                                    .filter(({ q }) => !Array.isArray(q.solutions) || q.solutions.filter(Boolean).length === 0)
                                    .map(({ idx }) => idx);
                                unmatchedSolutions.forEach((sol, i) => {
                                    const idx = freeIndexes[i];
                                    if (idx !== undefined && impQuestions[idx]) impQuestions[idx].solutions = [sol];
                                });
                            }

                            // solutions dense array path (working_server.js / legacy)
                        } else if (Array.isArray(solData.solutions) && solData.solutions.length > 0) {
                            solData.solutions.forEach((sol, si) => {
                                if (!sol) return;
                                const qNum = sol.questionNumber || (si + 1);
                                const arrIdx = qNumToArrIdx.has(qNum) ? qNumToArrIdx.get(qNum)
                                    : qTextNumMap.has(qNum) ? qTextNumMap.get(qNum)
                                        : (si < impQuestions.length ? si : null);
                                if (arrIdx !== null && impQuestions[arrIdx]) {
                                    impQuestions[arrIdx].solutions = [sol];
                                }
                            });
                        } else {
                            console.warn('[sol-debug] No solutions in server response');
                        }

                        // Normalize solution objects and ensure at least one visible mapping when extraction returned data.
                        const normalizeSol = (sol) => {
                            if (!sol) return null;
                            if (typeof sol === 'string') {
                                const t = sol.trim();
                                return t ? { text: t } : null;
                            }
                            const text = String(sol.text || sol.content || sol.solution || sol.explanation || '').trim();
                            const image = sol.image || null;
                            const images = Array.isArray(sol.images) ? sol.images.filter(Boolean) : [];
                            if (!text && !image && images.length === 0) return null;
                            return { ...sol, text, image: image || (images[0] || null), images };
                        };

                        impQuestions.forEach((q) => {
                            q.solutions = Array.isArray(q.solutions)
                                ? q.solutions.map(normalizeSol).filter(Boolean)
                                : [];
                        });

                        const extractedSolutions = (
                            sqKeys.length > 0
                                ? Object.values(solData.solutionsByQNum || {})
                                : (Array.isArray(solData.solutions) ? solData.solutions : [])
                        ).map(normalizeSol).filter(Boolean);

                        if (extractedSolutions.length > 0 && impQuestions.length === 1 && (!Array.isArray(impQuestions[0].solutions) || impQuestions[0].solutions.length === 0)) {
                            impQuestions[0].solutions = [extractedSolutions[0]];
                        }
                    } else {
                        console.warn('[sol-debug] extract-solutions request failed:', solResp?.status);
                    }
                    const solStatusEl = document.getElementById("solExtractStatus");
                    if (solStatusEl) solStatusEl.remove();
                } catch (solErr) {
                    console.warn("Solution extraction failed (non-fatal):", solErr);
                    const solStatusEl = document.getElementById("solExtractStatus");
                    if (solStatusEl) solStatusEl.remove();
                }
            }
        }

        impUndoStack = []; impRedoStack = [];

        const imgCount = parsed.filter(q => q.hasImage).length;
        const imgDetected = parsed.filter(q => q.hasImage && q._imgB64).length;
        const eqCount = parsed.filter(q => q.hasEquation).length;
        const multiCount = parsed.filter(q => q.isMultiCorrect).length;
        const solCount = impQuestions.filter(q => q.solutions && q.solutions.length > 0).length;
        const cvStr = impIsOpenCVReady() ? " <span style='color:var(--accent-3);font-size:0.75rem'>(OpenCV ✓)</span>" : "";

        let summaryHTML = `✅ <strong>${parsed.length}</strong> question(s) extracted${cvStr}.`;
        if (multiCount) summaryHTML += ` &nbsp;✦ ${multiCount} multi-correct.`;
        if (eqCount) summaryHTML += ` &nbsp;🧮 ${eqCount} with equations.`;
        if (imgCount) summaryHTML += ` &nbsp;🖼 ${imgCount} with diagrams (${imgDetected} auto-cropped).`;
        if (solCount) summaryHTML += ` &nbsp;📖 <strong>${solCount}</strong> solution(s) extracted.`;

        impShowSuccess(summaryHTML);

        impSetStep(3);
        impRenderReview();
        document.getElementById("impPanelReview").style.display = "block";
        // Keep upload panel visible — scroll to review section
        setTimeout(() => {
            const rev = document.getElementById("impPanelReview");
            if (rev) rev.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 120);

    } catch (err) {
        impShowError(err.message || "Extraction failed.");
        impSetStep(1);
    }

    document.getElementById("impExtractBtn").disabled = false;
}

/* ── Client-side LaTeX repair (mirrors server repairSolutionLatex) ── */
function clientRepairLatex(text) {
    if (!text) return text;
    let t = text;

    // Only collapse 4+ consecutive backslashes down to 2 (\\).
    // 3 backslashes (\\\) = \\ (row separator) + \ (start of cmd like \omega)
    // — collapsing those would drop the cmd's leading backslash and render
    // \omega as literal "omega". Leave 3-backslash sequences untouched.
    try {
        t = t.replace(/\\{4,}/g, "\\\\");
    } catch (e) { /* ignore */ }

    // ── Normalize triple-dollar blocks ($$$...$$$) the AI sometimes outputs ──
    t = t.replace(/\$\$\$([\s\S]*?)\$\$\$/g, (_, inner) => '$$' + inner.trim() + '$$');
    // Strip ONLY lines that consist of just "$$$" or "$$$:" — pure artifact markers, not math lines
    t = t.replace(/^\s*\${3}\s*:?\s*$/gm, '');
    // Strip inline "$$$:" prefix but only when at line start and followed by a space/LaTeX command
    t = t.replace(/^\s*\${3}\s*:\s*/gm, '');
    // Strip lines that are ONLY a bare "$" or "$$" — AI separator artifacts
    t = t.replace(/^\s*\${1,2}\s*$/gm, '');

    // Fix \( \) → $ $  and \[ \] → $$ $$
    // NOTE: must NOT match the second backslash of a "\\" row-separator
    // (matrix/array rows) when it's immediately followed by "(" or ")",
    // e.g. "...x\\(1+a^2)x..." inside \begin{vmatrix}...\end{vmatrix}.
    // Without the negative lookbehind, /\\\(/g would eat the row's "\\"
    // plus the next cell's opening "(" and replace them with a stray "$",
    // corrupting the matrix (dropped row separator + missing paren).
    t = t.replace(/(?<!\\)\\\(/g, '$').replace(/(?<!\\)\\\)/g, '$');
    t = t.replace(/(?<!\\)\\\[/g, '$$').replace(/(?<!\\)\\\]/g, '$$');
    // Fix missing backslash on common LaTeX commands
    t = t.replace(/(?<!\\)\bfrac\{/g, '\\frac{');
    t = t.replace(/(?<!\\)\brac\{/g, '\\frac{');
    t = t.replace(/(?<!\\)\bsqrt\{/g, '\\sqrt{');
    t = t.replace(/(?<!\\)\bsqrt\b/g, '\\sqrt');
    t = t.replace(/(?<!\\)\bvec\{/g, '\\vec{');
    t = t.replace(/(?<!\\)\bhat\{/g, '\\hat{');
    t = t.replace(/(?<!\\)\btimes\b/g, '\\times');
    t = t.replace(/(?<!\\)\bcdot\b/g, '\\cdot');
    t = t.replace(/(?<!\\)\bpm\b/g, '\\pm');
    t = t.replace(/(?<!\\)\btheta\b/g, '\\theta');
    t = t.replace(/(?<!\\)\balpha\b/g, '\\alpha');
    t = t.replace(/(?<!\\)\bbeta\b/g, '\\beta');
    t = t.replace(/(?<!\\)\bepsilon\b/g, '\\epsilon');
    t = t.replace(/(?<!\\)\bmu\b/g, '\\mu');
    t = t.replace(/(?<!\\)\bomega\b/g, '\\omega');
    t = t.replace(/(?<!\\)\bpi\b(?![a-z])/g, '\\pi');
    t = t.replace(/(?<!\\)\blambda\b/g, '\\lambda');
    t = t.replace(/(?<!\\)\bsigma\b/g, '\\sigma');
    t = t.replace(/(?<!\\)\bgamma\b/g, '\\gamma');
    t = t.replace(/(?<!\\)\bdelta\b/g, '\\delta');
    t = t.replace(/(?<!\\)\binfty\b/g, '\\infty');
    t = t.replace(/(?<!\\)\btext\{/g, '\\text{');
    t = t.replace(/(?<!\\)\bsin\b/g, '\\sin');
    t = t.replace(/(?<!\\)\bcos\b/g, '\\cos');
    t = t.replace(/(?<!\\)\btan\b/g, '\\tan');
    t = t.replace(/(?<!\\)\blog\b/g, '\\log');
    t = t.replace(/(?<!\\)\bln\b/g, '\\ln');
    t = t.replace(/(?<!\\)\btherefore\b/g, '\\therefore');
    t = t.replace(/(?<!\\)\bRightarrow\b/g, '\\Rightarrow');
    t = t.replace(/(?<!\\)\brightarrow\b/g, '\\rightarrow');
    t = t.replace(/(?<!\\)\bimplies\b/g, '\\implies');
    // Not-equal: accept the literal Unicode "≠" and the ASCII "!=" the same
    // way we accept the word "neq", normalising them all to KaTeX's \neq.
    // (Guard "!=" so we never touch "<=" / ">=" / "==" comparisons.)
    t = t.replace(/\u2260/g, '\\neq');
    t = t.replace(/(?<![<>=!])!=(?!=)/g, '\\neq');
    t = t.replace(/(?<!\\)\bneq\b/g, '\\neq');
    // Bare "\ne" (KaTeX's short form) followed by a non-letter — make sure it
    // is treated as the not-equal command, not the start of "\neq"/"\nexists".
    t = t.replace(/\\ne(?![a-zA-Z])/g, '\\neq');
    t = t.replace(/\u2264/g, '\\leq').replace(/(?<![<>=!])<=(?!=)/g, '\\leq');
    t = t.replace(/\u2265/g, '\\geq').replace(/(?<![<>=!])>=(?!=)/g, '\\geq');
    t = t.replace(/(?<!\\)\bleq\b/g, '\\leq');
    t = t.replace(/(?<!\\)\bgeq\b/g, '\\geq');
    // Separate \cmd from immediately adjacent capital word: "\thereforeEnergy" → "\therefore Energy"
    t = t.replace(/\\(therefore|Rightarrow|rightarrow|implies)([A-Z])/g, '\\$1 $2');
    // Wrap bare LaTeX: if an entire non-math segment looks like a math expression,
    // wrap the whole thing; otherwise wrap individual \cmd tokens.
    t = t.split('\n').map(line => {
        const parts = line.split(/(\$\$[\s\S]*?\$\$|\$[^$]*?\$)/g);
        return parts.map((seg, i) => {
            if (i % 2 === 1) return seg; // inside $...$ already
            if (!seg.includes('\\')) return seg;
            const trimmed = seg.trim();
            // If the segment is dominated by LaTeX (starts with \cmd or = \cmd etc.)
            // wrap the whole segment as one $...$
            if (/^[\s=:,()*]*\\[a-zA-Z]/.test(trimmed) || /\\(?:frac|sqrt|therefore|Rightarrow|rightarrow|sum|int|begin|end|pmatrix|vmatrix|bmatrix|matrix|cases|align)/.test(trimmed)) {
                return '$' + trimmed + '$';
            }
            // Otherwise wrap individual \cmd{...} tokens only
            return seg.replace(/\\[a-zA-Z]+(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|\[[^\]]*\]|[_^]\{[^{}]*\}|[_^][\w])?/g, m => '$' + m + '$');
        }).join('');
    }).join('\n');
    // Collapse multiple adjacent $...$  with only spaces/operators between them into one
    // e.g. "$\frac{1}{2}$ = $\frac{C_1}{n}$" → "$\frac{1}{2} = \frac{C_1}{n}$"
    let prev = '';
    while (prev !== t) {
        prev = t;
        t = t.replace(/\$([^$\n]+)\$([\s=+\-*/,.:()]*?)\$([^$\n]+)\$/g, (_, a, mid, b) => '$' + a + (mid || ' ') + b + '$');
    }
    // Fix unmatched $ (odd count → add closing $)
    const dc = (t.match(/(?<!\\)\$/g) || []).length;
    if (dc % 2 === 1) t += '$';
    return t;
}

/* ── Safely convert solution plain-text to HTML (preserving LaTeX $) ─ */
function solTextToHtml(rawText) {
    // Pre-clean triple-dollar display blocks the AI sometimes emits (e.g. "$$$: \frac...")
    let cleaned = (rawText || '');
    // Only normalize $$$...$$$  blocks → $$...$$  (do NOT strip leading $$ from lines)
    cleaned = cleaned.replace(/\$\$\$([\s\S]*?)\$\$\$/g, (_, inner) => '$$' + inner.trim() + '$$');
    // Strip only lines that are PURELY "$$$" or "$$$:" with nothing else (artifact markers)
    cleaned = cleaned.replace(/^\s*\${3}\s*:?\s*$/gm, '');
    // Strip lines that are ONLY a bare "$" or "$$" — AI separator artifacts
    cleaned = cleaned.replace(/^\s*\${1,2}\s*$/gm, '');
    // Repair LaTeX
    const repaired = clientRepairLatex(cleaned);
    // Split by newline, escape each line's non-math content minimally,
    // but keep $ delimiters intact for KaTeX to render
    return repaired
        .split('\n')
        .map(line => {
            // If the line mixes text AND $$...$$ (display math), convert $$ → $ for inline rendering
            // A line is "mixed" if it has non-whitespace outside of the $$...$$ blocks
            const hasMixedDisplayMath = /\$\$[^$]/.test(line);
            if (hasMixedDisplayMath) {
                // Check if there's non-math text outside $$...$$ on this line
                const outside = line.replace(/\$\$[\s\S]*?\$\$/g, '').trim();
                if (outside.length > 0) {
                    // Downgrade $$...$$ to $...$ for inline rendering
                    line = line.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) => '$' + inner.trim() + '$');
                }
            }
            // Escape HTML special chars EXCEPT inside $...$ spans
            // We do a simple segment-based escape: split on $ boundaries
            const segments = line.split(/(\$\$[\s\S]*?\$\$|\$[^$]*?\$)/g);
            return segments.map((seg, i) => {
                if (i % 2 === 1) return seg; // math segment — leave as-is
                return seg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }).join('');
        })
        .join('<br>');
}

function solTextToRenderedHtml(rawText) {
    // Apply clientRepairLatex first to normalize the LaTeX (collapse double
    // backslashes, fix missing backslashes on commands, wrap bare LaTeX in
    // $ delimiters, etc.) — mirrors what solTextToHtml does.
    let cleaned = String(rawText || '');
    // Normalize $$$...$$$  blocks → $$...$$ 
    cleaned = cleaned.replace(/\$\$\$([\s\S]*?)\$\$\$/g, (_, inner) => '$$' + inner.trim() + '$$');
    // Strip lines that are PURELY "$$$ " or "$$$:" with nothing else
    cleaned = cleaned.replace(/^\s*\${3}\s*:?\s*$/gm, '');
    // Strip lines that are ONLY a bare "$" or "$$"
    cleaned = cleaned.replace(/^\s*\${1,2}\s*$/gm, '');
    // Repair LaTeX (collapse \\, fix missing backslashes, wrap bare LaTeX, etc.)
    cleaned = clientRepairLatex(cleaned);

    const source = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const escapeHtml = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const makeFrag = (tex, displayMode) => {
        const content = String(tex || '').trim();
        if (!content) return '';
        return `<span class="katex-frag" data-display="${displayMode ? '1' : '0'}" data-tex="${escapeHtml(content)}"></span>`;
    };

    return source.split('\n').map((line) => {
        // If a line mixes text AND $$...$$ (display math), downgrade to inline
        const hasMixedDisplayMath = /\$\$[^$]/.test(line);
        if (hasMixedDisplayMath) {
            const outside = line.replace(/\$\$[\s\S]*?\$\$/g, '').trim();
            if (outside.length > 0) {
                line = line.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) => '$' + inner.trim() + '$');
            }
        }

        const pieces = [];
        const re = /(\$\$[\s\S]*?\$\$|\$[^$]*?\$)/g;
        let lastIndex = 0;
        let match;
        while ((match = re.exec(line)) !== null) {
            if (match.index > lastIndex) pieces.push(escapeHtml(line.slice(lastIndex, match.index)));
            const seg = match[0];
            if (seg.startsWith('$$') && seg.endsWith('$$')) {
                pieces.push(makeFrag(seg.slice(2, -2), true));
            } else if (seg.startsWith('$') && seg.endsWith('$')) {
                pieces.push(makeFrag(seg.slice(1, -1), false));
            } else {
                pieces.push(escapeHtml(seg));
            }
            lastIndex = match.index + match[0].length;
        }
        if (lastIndex < line.length) pieces.push(escapeHtml(line.slice(lastIndex)));
        return pieces.join('');
    }).join('<br>');
}

/* ── Build solution HTML block for a question ────────────────────── */
function impBuildSolutionHTML(solutions, qi) {
    const normalizedSolutions = Array.isArray(solutions) ? solutions.map((sol) => {
        if (!sol) return null;
        if (typeof sol === 'string') return { text: sol };
        return {
            ...sol,
            text: String(sol.text || sol.content || sol.solution || sol.explanation || '')
        };
    }) : [];
    const hasSol = normalizedSolutions.length > 0 && normalizedSolutions.some(s => s && (
        (typeof s.text === 'string' && s.text.trim().length > 0) ||
        s.image ||
        (Array.isArray(s.images) && s.images.length > 0)
    ));
    const solId = 'impSolBody_' + qi;
    const editId = 'impSolEditArea_' + qi;

    // ── Header row ────────────────────────────────────────────────
    let html = '<div style="margin-top:14px;border:1px solid rgba(16,185,129,0.3);border-radius:var(--radius-sm);overflow:hidden">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:rgba(16,185,129,0.10);cursor:pointer" onclick="mqToggleSolBody(' + qi + ')">';
    html += '<div style="display:flex;align-items:center;gap:8px">';
    html += '<span style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:#10b981">📖 Solution</span>';
    html += hasSol
        ? '<span style="font-size:0.7rem;color:var(--text-muted)">(extracted)</span>'
        : '<span style="font-size:0.7rem;color:var(--text-muted)">(none yet)</span>';
    html += '</div>';
    html += '<div style="display:flex;gap:6px;align-items:center" onclick="event.stopPropagation()">';
    html += '<button onclick="impToggleSolEdit(' + qi + ')" id="impSolEditBtn_' + qi + '" style="padding:3px 10px;background:rgba(86,169,255,0.12);border:1px solid rgba(86,169,255,0.3);border-radius:4px;font-size:0.72rem;color:var(--accent);cursor:pointer;font-family:\'Outfit\',sans-serif;display:flex;align-items:center;gap:4px">✏ Edit</button>';
    html += '<input type="file" accept="image/*" multiple id="impSolInsertFile_' + qi + '" style="display:none" onchange="impInsertSolImages(' + qi + ',this)">';
    html += '<button onclick="document.getElementById(\'impSolInsertFile_' + qi + '\').click()" style="padding:3px 10px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);border-radius:4px;font-size:0.72rem;color:#10b981;cursor:pointer;font-family:\'Outfit\',sans-serif;display:flex;align-items:center;gap:4px" title="Insert image(s) into this solution">📎 Insert Image</button>';
    html += '</div>';
    html += '</div></div>';

    // ── Collapsible body ──────────────────────────────────────────
    const bodyDisplay = 'block';
    html += '<div id="' + solId + '" style="display:' + bodyDisplay + ';padding:12px 14px 14px;background:rgba(16,185,129,0.04)">';

    if (hasSol) {
        normalizedSolutions.forEach(function (sol, sIdx) {
            if (!sol) return;
            const solText = sol.text || '';
            // Collect all images for this solution entry
            const allImgs = [];
            if (Array.isArray(sol.images) && sol.images.length > 0) {
                sol.images.forEach(function (img) { if (img) allImgs.push(img); });
            } else if (sol.image) {
                allImgs.push(sol.image);
            }
            // Render images
            allImgs.forEach(function (imgData, imgIdx) {
                const imgSrc = (imgData.startsWith('http') || imgData.startsWith('data:')) ? imgData : 'data:image/jpeg;base64,' + imgData;
                html += '<div style="margin-bottom:10px;text-align:center" id="impSolImgSlot_' + qi + '_' + sIdx + '_' + imgIdx + '">';
                html += '<img src="' + imgSrc + '" alt="Solution diagram ' + (imgIdx + 1) + '" style="max-width:100%;max-height:220px;border-radius:6px;border:1px solid var(--border);object-fit:contain">';
                html += '<div style="margin-top:5px;display:flex;gap:6px;justify-content:center">';
                if (imgIdx === 0) {
                    html += '<button onclick="impOpenSolCropModal(' + qi + ',' + sIdx + ')" style="padding:3px 9px;background:rgba(86,169,255,0.1);border:1px solid rgba(86,169,255,0.3);border-radius:4px;font-size:0.72rem;color:var(--accent);cursor:pointer;font-family:\'Outfit\',sans-serif">✂ Crop</button>';
                }
                html += '<button onclick="impRemoveSolImage(' + qi + ',' + sIdx + ',' + imgIdx + ')" style="padding:3px 9px;background:rgba(242,92,92,0.08);border:1px solid rgba(242,92,92,0.25);border-radius:4px;font-size:0.72rem;color:var(--error);cursor:pointer;font-family:\'Outfit\',sans-serif">✕ Remove</button>';
                html += '</div>';
                html += '</div>';
            });
            html += '<div style="margin-bottom:8px">';
            html += '<label style="padding:3px 9px;background:rgba(86,169,255,0.06);border:1px dashed rgba(86,169,255,0.25);border-radius:4px;font-size:0.7rem;color:var(--accent);cursor:pointer;font-family:\'Outfit\',sans-serif;display:inline-flex;align-items:center;gap:3px" title="Add another image to this solution">+ Add image<input type="file" accept="image/*" multiple style="display:none" onchange="impAddSolImagesToEntry(' + qi + ',' + sIdx + ',this)"></label>';
            if (_impSolScreenshots && _impSolScreenshots.length > 0) {
                html += ' <button onclick="impOpenSolCropModal(' + qi + ',' + sIdx + ')" style="padding:3px 9px;background:rgba(86,169,255,0.06);border:1px dashed rgba(86,169,255,0.25);border-radius:4px;font-size:0.7rem;color:var(--accent);cursor:pointer;font-family:\'Outfit\',sans-serif">✂ Crop from screenshot</button>';
            }
            html += '</div>';
            // Solution text — use placeholder div; text will be set via textContent + renderMath post-render
            if (solText) {
                const solNumMatch = solText.match(/^\s*\d+\.?\s*(?:\([a-dA-D]\)\s*)?:?\s*/);
                const cleanedText = solNumMatch ? solText.slice(solNumMatch[0].length).trim() : solText;
                const escapedForAttr = cleanedText.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                html += '<div class="imp-sol-text" data-sol-raw="' + escapedForAttr + '" style="font-size:0.86rem;line-height:1.8;color:var(--text);white-space:pre-wrap;word-break:break-word"></div>';
            }
            // Divider between multiple solution entries
            if (sIdx < normalizedSolutions.length - 1) {
                html += '<hr style="border:none;border-top:1px dashed rgba(16,185,129,0.2);margin:10px 0">';
            }
        });
    } else {
        html += '<div style="font-size:0.8rem;color:var(--text-muted);text-align:center;padding:6px 0 4px">No solution extracted yet.</div>';
    }

    const existingText = (normalizedSolutions && normalizedSolutions[0] && normalizedSolutions[0].text) ? normalizedSolutions[0].text : '';
    html += '<div id="impSolEditPanel_' + qi + '" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid rgba(16,185,129,0.2)">';
    html += '<label style="font-size:0.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Edit Solution Text</label>';
    html += '<textarea id="' + editId + '" rows="5" style="width:100%;margin-top:6px;background:rgba(255,255,255,0.05);border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 11px;color:var(--text);font-family:\'Outfit\',sans-serif;font-size:0.84rem;line-height:1.6;resize:vertical;outline:none;box-sizing:border-box">' + existingText.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</textarea>';
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">';
    html += '<button onclick="impSaveSolEdit(' + qi + ')" style="padding:4px 12px;background:rgba(16,185,129,0.18);border:1px solid rgba(16,185,129,0.4);border-radius:4px;font-size:0.74rem;color:#10b981;cursor:pointer;font-family:\'Outfit\',sans-serif;font-weight:600">✓ Save</button>';
    html += '</div></div>';

    html += '</div></div>';
    return html;
}

function mqBuildSolutionReadOnlyHTML(solutions, qi) {
    const normalizedSolutions = Array.isArray(solutions) ? solutions.map((sol) => {
        if (!sol) return null;
        if (typeof sol === 'string') return { text: sol };
        return {
            ...sol,
            text: String(sol.text || sol.content || sol.solution || sol.explanation || '')
        };
    }) : [];
    const hasSol = normalizedSolutions.length > 0 && normalizedSolutions.some(s => s && (
        (typeof s.text === 'string' && s.text.trim().length > 0) ||
        s.image ||
        (Array.isArray(s.images) && s.images.length > 0)
    ));

    let html = '<div style="margin-top:14px;border:1px solid rgba(16,185,129,0.3);border-radius:var(--radius-sm);overflow:hidden">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:rgba(16,185,129,0.10);cursor:pointer" onclick="mqToggleSolBody(' + qi + ')">';
    html += '<div style="display:flex;align-items:center;gap:8px">';
    html += '<span style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:#10b981">📖 Solution</span>';
    html += hasSol
        ? '<span style="font-size:0.7rem;color:var(--text-muted)">(extracted)</span>'
        : '<span style="font-size:0.7rem;color:var(--text-muted)">(none yet)</span>';
    html += '</div></div></div>';

    html += '<div id="mqSolBody_' + qi + '" style="display:block;padding:12px 14px 14px;background:rgba(16,185,129,0.04)">';
    if (hasSol) {
        normalizedSolutions.forEach(function (sol, sIdx) {
            if (!sol) return;
            const solText = sol.text || '';
            const allImgs = [];
            if (Array.isArray(sol.images) && sol.images.length > 0) {
                sol.images.forEach(function (img) { if (img) allImgs.push(img); });
            } else if (sol.image) {
                allImgs.push(sol.image);
            }

            const hasImages = allImgs.length > 0;
            if (hasImages) {
                html += '<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">';

                // Left Column: Explanation Text
                html += '<div style="flex:1.3;min-width:280px">';
                if (solText) {
                    const solNumMatch = solText.match(/^\s*\d+\.?\s*(?:\([a-dA-D]\)\s*)?:?\s*/);
                    const cleanedText = solNumMatch ? solText.slice(solNumMatch[0].length).trim() : solText;
                    const escapedForAttr = cleanedText.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    html += '<div class="imp-sol-text" data-sol-raw="' + escapedForAttr + '" style="font-size:0.86rem;line-height:1.8;color:var(--text);white-space:pre-wrap;word-break:break-word"></div>';
                }
                html += '</div>';

                // Right Column: Images
                html += '<div style="flex:0.7;min-width:280px;max-width:440px;display:flex;flex-direction:column;gap:12px;justify-content:center">';
                allImgs.forEach(function (imgData, imgIdx) {
                    const imgSrc = (imgData.startsWith('http') || imgData.startsWith('data:')) ? imgData : 'data:image/jpeg;base64,' + imgData;
                    html += '<div style="text-align:center" id="mqSolImgSlot_' + qi + '_' + sIdx + '_' + imgIdx + '">';
                    html += '<img src="' + imgSrc + '" alt="Solution diagram ' + (imgIdx + 1) + '" style="max-width:100%;max-height:220px;border-radius:6px;border:none;object-fit:contain">';
                    html += '</div>';
                });
                html += '</div>';

                html += '</div>';
            } else {
                if (solText) {
                    const solNumMatch = solText.match(/^\s*\d+\.?\s*(?:\([a-dA-D]\)\s*)?:?\s*/);
                    const cleanedText = solNumMatch ? solText.slice(solNumMatch[0].length).trim() : solText;
                    const escapedForAttr = cleanedText.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    html += '<div class="imp-sol-text" data-sol-raw="' + escapedForAttr + '" style="font-size:0.86rem;line-height:1.8;color:var(--text);white-space:pre-wrap;word-break:break-word"></div>';
                }
            }

            if (sIdx < normalizedSolutions.length - 1) {
                html += '<hr style="border:none;border-top:1px dashed rgba(16,185,129,0.2);margin:10px 0">';
            }
        });
    } else {
        html += '<div style="font-size:0.8rem;color:var(--text-muted);text-align:center;padding:6px 0 4px">No solution extracted yet.</div>';
    }
    html += '</div>';
    return html;
}

function mqToggleSolBody(qi) {
    const body = document.getElementById('mqSolBody_' + qi) || document.getElementById('impSolBody_' + qi);
    if (!body) return;
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
    const texts = body.querySelectorAll('.imp-sol-text');
    texts.forEach(t => renderMath(t));
}

/* ── Toggle question edit panel (view ↔ edit) ────────────────────── */
function impToggleQEdit(qi) {
    const editPanel = document.getElementById('impQEditPanel_' + qi);
    const optsView = document.getElementById('impOptsView_' + qi);
    const optsEdit = document.getElementById('impOptsEdit_' + qi);
    const btn = document.getElementById('impQEditBtn_' + qi);
    if (!editPanel) return;
    const isOpen = editPanel.style.display !== 'none';
    if (isOpen) {
        // Close edit — save changes first
        impSaveQEdit(qi);
        editPanel.style.display = 'none';
        if (optsView) optsView.style.display = '';
        if (optsEdit) optsEdit.style.display = 'none';
        if (btn) { btn.innerHTML = '✏ Edit'; btn.style.background = 'rgba(86,169,255,0.12)'; }
    } else {
        // Open edit — sync edit inputs from hidden inputs
        const ta = document.getElementById('impQText_' + qi);
        if (ta) ta.value = (impQuestions[qi] && impQuestions[qi].question) || ta.value;
        // Sync option edit fields from hidden inputs
        for (let oi = 0; oi < 4; oi++) {
            const hidden = document.getElementById('impOpt_' + qi + '_' + oi);
            const edit = document.getElementById('impOptEdit_' + qi + '_' + oi);
            if (hidden && edit) edit.value = hidden.value;
        }
        editPanel.style.display = 'block';
        if (optsView) optsView.style.display = 'none';
        if (optsEdit) optsEdit.style.display = '';
        if (btn) { btn.innerHTML = '✕ Close'; btn.style.background = 'rgba(86,169,255,0.25)'; }
        if (ta) ta.focus();
    }
}

/* ── Save question + options edits, re-render preview ────────────── */
function impSaveQEdit(qi) {
    const q = impQuestions[qi];
    if (!q) return;
    const ta = document.getElementById('impQText_' + qi);
    if (ta) {
        q.question = ta.value;
        const preview = document.getElementById('impQPreview_' + qi);
        if (preview) {
            preview.textContent = ta.value;
            renderMath(preview);
        }
    }
    // Save option edits from the edit inputs → hidden inputs + update preview spans
    for (let oi = 0; oi < 4; oi++) {
        const editInp = document.getElementById('impOptEdit_' + qi + '_' + oi);
        const hiddenInp = document.getElementById('impOpt_' + qi + '_' + oi);
        const previewSpan = document.getElementById('impOptPreview_' + qi + '_' + oi);
        const val = editInp ? editInp.value : (hiddenInp ? hiddenInp.value : '');
        if (q.options) q.options[oi] = val;
        if (hiddenInp) hiddenInp.value = val;
        if (previewSpan) { previewSpan.textContent = val; renderMath(previewSpan); }
    }
}

/* ── Toggle solution body (collapse/expand) ──────────────────────── */
function impToggleSolBody(qi) {
    const body = document.getElementById('impSolBody_' + qi);
    if (!body) return;
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
    const texts = body.querySelectorAll('.imp-sol-text');
    texts.forEach(t => renderMath(t));
}

/* ── Toggle edit panel visibility ────────────────────────────────── */
function impToggleSolEdit(qi) {
    const panel = document.getElementById('impSolEditPanel_' + qi);
    const body = document.getElementById('impSolBody_' + qi);
    const btn = document.getElementById('impSolEditBtn_' + qi);
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    if (body) body.style.display = 'block'; // always expand body when editing
    if (btn) {
        btn.style.background = isOpen ? 'rgba(86,169,255,0.12)' : 'rgba(86,169,255,0.25)';
        btn.style.color = isOpen ? 'var(--accent)' : 'var(--accent)';
        btn.innerHTML = isOpen ? '✏ Edit' : '✕ Close Edit';
    }
}

/* ── Insert a new blank solution entry ───────────────────────────── */
function impAddSolEntry(qi) {
    const q = impQuestions[qi];
    if (!q) return;
    if (!Array.isArray(q.solutions)) q.solutions = [];
    q.solutions.push({ text: '', image: null });
    const solBlock = document.getElementById('impSolBlock_' + qi);
    if (solBlock) {
        solBlock.innerHTML = impBuildSolutionHTML(q.solutions, qi);
        // Open edit panel automatically after insert
        const panel = document.getElementById('impSolEditPanel_' + qi);
        if (panel) panel.style.display = 'block';
        const body = document.getElementById('impSolBody_' + qi);
        if (body) body.style.display = 'block';
        const btn = document.getElementById('impSolEditBtn_' + qi);
        if (btn) btn.innerHTML = '✕ Close Edit';
        const ta = document.getElementById('impSolEditArea_' + qi);
        if (ta) ta.focus();
        setTimeout(() => solBlock.querySelectorAll('.imp-sol-text').forEach(t => renderMath(t)), 0);
    }
}

/* ─�� Save edited solution text ───────────────────────────────────── */
function impSaveSolEdit(qi) {
    const q = impQuestions[qi];
    if (!q) return;
    const ta = document.getElementById('impSolEditArea_' + qi);
    if (!ta) return;
    const newText = ta.value.trim();
    if (!Array.isArray(q.solutions) || !q.solutions.length) {
        q.solutions = [{ text: newText, image: null }];
    } else {
        if (!q.solutions[0]) q.solutions[0] = {};
        q.solutions[0].text = newText;
    }
    const solBlock = document.getElementById('impSolBlock_' + qi);
    if (solBlock) {
        solBlock.innerHTML = impBuildSolutionHTML(q.solutions, qi);
        setTimeout(() => solBlock.querySelectorAll('.imp-sol-text').forEach(t => renderMath(t)), 0);
    }
}

/* ── Handle solution image upload via file input ─────────────────── */
function impHandleSolImageUpload(qi, input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        const b64 = e.target.result.split(',')[1];
        const q = impQuestions[qi];
        if (!q) return;
        if (!Array.isArray(q.solutions) || !q.solutions.length) q.solutions = [{}];
        if (!q.solutions[0]) q.solutions[0] = {};
        q.solutions[0].image = b64;
        if (!Array.isArray(q.solutions[0].images)) q.solutions[0].images = [];
        if (!q.solutions[0].images.includes(b64)) q.solutions[0].images.unshift(b64);
        const solBlock = document.getElementById('impSolBlock_' + qi);
        if (solBlock) {
            solBlock.innerHTML = impBuildSolutionHTML(q.solutions, qi);
            const panel = document.getElementById('impSolEditPanel_' + qi);
            if (panel) panel.style.display = 'block';
            const body = document.getElementById('impSolBody_' + qi);
            if (body) body.style.display = 'block';
            setTimeout(() => solBlock.querySelectorAll('.imp-sol-text').forEach(t => renderMath(t)), 0);
        }
    };
    reader.readAsDataURL(file);
}

/* ── Remove a solution image by index ────────────────────────────── */
function impRemoveSolImage(qi, sIdx, imgIdx) {
    const q = impQuestions[qi];
    if (!q || !q.solutions || !q.solutions[sIdx]) return;
    const sol = q.solutions[sIdx];
    // Remove from images array
    if (Array.isArray(sol.images) && imgIdx !== undefined) {
        sol.images.splice(imgIdx, 1);
        sol.image = sol.images.length > 0 ? sol.images[0] : null;
    } else {
        // Legacy: just delete the single image
        delete sol.image;
        sol.images = [];
    }
    const solBlock = document.getElementById(`impSolBlock_${qi}`);
    if (solBlock) {
        solBlock.innerHTML = impBuildSolutionHTML(q.solutions, qi);
        setTimeout(() => solBlock.querySelectorAll('.imp-sol-text').forEach(t => renderMath(t)), 0);
    }
}

/* ── Insert images via the header "Insert Image" button ──────────── */
function impInsertSolImages(qi, input) {
    const files = input.files;
    if (!files || !files.length) return;
    const q = impQuestions[qi];
    if (!q) return;
    if (!Array.isArray(q.solutions) || !q.solutions.length) q.solutions = [{ text: '', image: null, images: [] }];
    const sol = q.solutions[0];
    if (!Array.isArray(sol.images)) sol.images = sol.image ? [sol.image] : [];
    let loaded = 0;
    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = function (e) {
            const b64 = e.target.result.split(',')[1];
            sol.images.push(b64);
            sol.image = sol.images[0];
            loaded++;
            if (loaded === files.length) {
                const solBlock = document.getElementById('impSolBlock_' + qi);
                if (solBlock) {
                    solBlock.innerHTML = impBuildSolutionHTML(q.solutions, qi);
                    const body = document.getElementById('impSolBody_' + qi);
                    if (body) body.style.display = 'block';
                    setTimeout(() => solBlock.querySelectorAll('.imp-sol-text').forEach(t => renderMath(t)), 0);
                }
            }
        };
        reader.readAsDataURL(file);
    });
    // Reset file input so same file can be re-selected
    input.value = '';
}

/* ── Add images to a specific solution entry ─────────────────────── */
function impAddSolImagesToEntry(qi, sIdx, input) {
    const files = input.files;
    if (!files || !files.length) return;
    const q = impQuestions[qi];
    if (!q || !q.solutions || !q.solutions[sIdx]) return;
    const sol = q.solutions[sIdx];
    if (!Array.isArray(sol.images)) sol.images = sol.image ? [sol.image] : [];
    let loaded = 0;
    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = function (e) {
            const b64 = e.target.result.split(',')[1];
            sol.images.push(b64);
            if (!sol.image) sol.image = b64;
            loaded++;
            if (loaded === files.length) {
                const solBlock = document.getElementById('impSolBlock_' + qi);
                if (solBlock) {
                    solBlock.innerHTML = impBuildSolutionHTML(q.solutions, qi);
                    setTimeout(() => solBlock.querySelectorAll('.imp-sol-text').forEach(t => renderMath(t)), 0);
                }
            }
        };
        reader.readAsDataURL(file);
    });
    input.value = '';
}

/* ── Render review panel ─────────────────────────────────────────── */
function impRenderReview() {
    const container = document.getElementById("impQContainer");
    container.innerHTML = "";
    _impCellRefs = {};

    // Summary banner
    const banner = document.getElementById("impSummaryBanner");
    const total = impQuestions.length;
    if (total > 0) {
        const imgs = impQuestions.filter(q => q.hasImage).length;
        const eqs = impQuestions.filter(q => q.hasEquation).length;
        const chapter = document.getElementById("imp-chapter")?.value.trim() || "";
        const lecNum = document.getElementById("imp-lecture")?.value.trim() || "";
        const topic = document.getElementById("imp-topic")?.value.trim() || "";
        const isStarQuiz = _impType === "star_quiz";
        const isPYQ = _impType === "pyq";

        // Build uploaded image previews for star quiz mode
        let sqImgPreviews = "";
        if (isStarQuiz) {
            const qImgCount = impQImages.length;
            const aImgCount = impAImages.length;
            if (qImgCount > 0) {
                sqImgPreviews += `<div class="imp-summary-stat" style="flex-direction:column;align-items:flex-start;gap:4px"><span style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px">📷 Question Images (${qImgCount})</span><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px">${impQImages.slice(0, 4).map((b, i) => `<img src="data:image/jpeg;base64,${b}" style="height:48px;width:auto;border-radius:4px;border:1px solid var(--border);object-fit:cover" title="Q-image ${i + 1}">`).join("")}${qImgCount > 4 ? `<span style="font-size:0.78rem;color:var(--text-muted);align-self:center">+${qImgCount - 4} more</span>` : ""}</div></div>`;
            }
            if (aImgCount > 0) {
                sqImgPreviews += `<div class="imp-summary-stat" style="flex-direction:column;align-items:flex-start;gap:4px"><span style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px">🔑 Answer Key Images (${aImgCount})</span><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px">${impAImages.slice(0, 4).map((b, i) => `<img src="data:image/jpeg;base64,${b}" style="height:48px;width:auto;border-radius:4px;border:1px solid var(--border);object-fit:cover" title="AK-image ${i + 1}">`).join("")}${aImgCount > 4 ? `<span style="font-size:0.78rem;color:var(--text-muted);align-self:center">+${aImgCount - 4} more</span>` : ""}</div></div>`;
            }
        }

        // PYQ banner info
        let pyqBannerHTML = "";
        if (isPYQ) {
            const pyqY = document.getElementById("pyq-year").value.trim();
            const pyqM = document.getElementById("pyq-month").value;
            const pyqD = document.getElementById("pyq-date").value.trim();
            const pyqS = document.getElementById("pyq-shift").value;
            pyqBannerHTML = `<div class="imp-summary-stat" style="flex-direction:column;align-items:flex-start;gap:2px"><span style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px">🏛️ PYQ</span><strong style="color:var(--accent)">${pyqY} ${pyqM} ${pyqD} — ${pyqS}</strong></div><div class="imp-summary-stat" style="flex-direction:column;align-items:flex-start;gap:2px;background:rgba(91,95,239,0.07);padding:6px 10px;border-radius:8px"><span style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px">🤖 Auto-Tagged</span><span style="font-size:0.78rem;color:var(--text-dim)">Unit → Chapter → Topic</span></div>`;
        }

        banner.innerHTML = `
                    ${isStarQuiz && chapter ? `<div class="imp-summary-stat" style="flex-direction:column;align-items:flex-start;gap:2px"><span style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px">Chapter</span><strong style="color:var(--accent)">${chapter}</strong></div>` : ""}
                    ${isStarQuiz && lecNum ? `<div class="imp-summary-stat" style="flex-direction:column;align-items:flex-start;gap:2px"><span style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px">Lecture</span><strong style="color:var(--accent-2)">L${lecNum}</strong></div>` : ""}
                    ${isStarQuiz && topic ? `<div class="imp-summary-stat" style="flex-direction:column;align-items:flex-start;gap:2px"><span style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px">Topic</span><span>${topic}</span></div>` : ""}
                    ${pyqBannerHTML}
                    <div class="imp-summary-stat"><strong>${total}</strong> Question${total !== 1 ? "s" : ""}</div>
                    ${imgs ? `<div class="imp-summary-stat">🖼 <strong>${imgs}</strong> with diagrams</div>` : ""}
                    ${eqs ? `<div class="imp-summary-stat">🧮 <strong>${eqs}</strong> with equations</div>` : ""}
                    ${sqImgPreviews}
                    <div class="imp-summary-stat" style="margin-left:auto;font-size:0.75rem;color:var(--text-muted)">${isStarQuiz ? "All questions will be saved as one lecture set. Adjust lecture# if needed, then Save All." : isPYQ ? "Review each question. AI has auto-tagged chapter & topic. Save All when ready." : "Review each question below, adjust lecture numbers, then Save All."}</div>`;
        banner.style.display = "flex";
    }

    impQuestions.forEach((q, qi) => {
        const ci = q.correctIndexes || (typeof q.correctIndex === "number" ? [q.correctIndex] : [0]);
        const hasEq = q.hasEquation || /\$[^$]+\$/.test(q.question + (q.options || []).join(""));

        // Diagram HTML
        let diagHTML = "";
        if (q.hasImage) {
            if (q._imgB64) {
                const imgSrc = impB64ToDataUrl(q._imgB64);
                diagHTML = `<div id="impDiagWrap_${qi}" style="margin-bottom:12px">
                            <div class="imp-diagram-preview" id="impDiagPreviewAuto_${qi}">
                                <img src="${imgSrc}" alt="Diagram" style="max-width:100%;border-radius:4px;object-fit:contain">
                                <div style="font-size:0.7rem;color:var(--accent);margin-top:6px;text-align:center">
                                    🤖 Auto-detected &nbsp;
                                    <button onclick="impRejectAutoImg(${qi})" style="background:none;border:none;color:var(--error);cursor:pointer;font-size:0.72rem;text-decoration:underline;font-family:inherit">✕ Replace</button>
                                    &nbsp;<button onclick="impOpenCropModal(${qi})" style="background:none;border:none;color:var(--accent-2);cursor:pointer;font-size:0.72rem;text-decoration:underline;font-family:inherit">✂ Re-crop</button>
                                </div>
                            </div>
                            <div id="impDiagManualZone_${qi}" style="display:none">${impBuildDiagZone(qi)}</div>
                        </div>`;
            } else {
                diagHTML = `<div id="impDiagWrap_${qi}" style="margin-bottom:12px">
                            <div id="impDiagPreviewAuto_${qi}" style="display:none"></div>
                            <div id="impDiagManualZone_${qi}">${impBuildDiagZone(qi)}</div>
                        </div>`;
            }
        }

        const div = document.createElement("div");
        div.className = "imp-q-card";
        div.id = `impQ_${qi}`;
        div.innerHTML = `
                <div class="imp-q-header">
                    <div class="imp-q-badges">
                        <strong style="font-size:0.88rem">Q${qi + 1}</strong>
                        ${q.isMultiCorrect ? '<span class="imp-badge multi">�� Multi</span>' : ""}
                        ${q.hasImage ? '<span class="imp-badge img">🖼 Diagram</span>' : ""}
                        ${hasEq ? '<span class="imp-badge eq">🧮 Equation</span>' : ""}
                        ${q.hasOptionImages ? '<span class="imp-badge" style="background:rgba(251,146,60,0.15);color:#fb923c;border:1px solid rgba(251,146,60,0.35)">⚠ Option diagrams — crop manually</span>' : ""}
                        ${_impType === 'pyq' ? `<span class="imp-badge" style="background:rgba(91,95,239,0.15);color:var(--accent);border:1px solid rgba(91,95,239,0.3)">🏛️ PYQ</span>` : ""}
                        ${_impType !== 'test_paper' && _impType !== 'pyq' ? `<div class="imp-lec-input-wrap"><span>Lec #</span><input type="number" min="1" class="imp-lec-input" id="impLec_${qi}" value="${q.assignedLecture}" ${_impType === 'star_quiz' ? "title='All questions share the same lecture in STAR Quiz'" : ""}></div>` : `<input type="hidden" id="impLec_${qi}" value="${q.assignedLecture}">`}
                        <div class="imp-answer-mode-pill">
                            <button type="button" onclick="impToggleMulti(${qi},false)" style="${!q.isMultiCorrect ? "background:var(--accent);color:#fff" : "background:transparent;color:var(--text-dim)"}">Single</button>
                            <button type="button" onclick="impToggleMulti(${qi},true)"  style="${q.isMultiCorrect ? "background:var(--accent-4);color:#1f1300" : "background:transparent;color:var(--text-dim)"}">Multi</button>
                        </div>
                    </div>
                    <button class="btn btn-danger" style="padding:4px 10px;font-size:0.74rem" onclick="impRemoveQ(${qi})">✕</button>
                </div>
                ${_impType === 'pyq' ? `
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;padding:10px 12px;background:rgba(91,95,239,0.06);border-radius:var(--radius-sm);border:1px solid rgba(91,95,239,0.15)">
                    <div style="display:flex;align-items:center;gap:4px;font-size:0.72rem;color:var(--accent);font-weight:700;margin-bottom:4px;width:100%">🤖 Auto-tagged — edit if needed</div>
                    <div style="flex:2;min-width:120px">
                        <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:3px">Unit</div>
                        <input id="pyqCardUnit_${qi}" value="${(q._pyqUnit || '').replace(/"/g, '&quot;')}" placeholder="e.g. UNIT 5 — ELECTROSTATICS" style="width:100%;padding:5px 8px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:0.78rem;outline:none">
                    </div>
                    <div style="flex:2;min-width:120px">
                        <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:3px">Chapter <span style="color:var(--accent)">*</span></div>
                        <input id="pyqCardChapter_${qi}" value="${(q._pyqChapter || '').replace(/"/g, '&quot;')}" placeholder="e.g. Electric Charges and Fields" style="width:100%;padding:5px 8px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:0.78rem;outline:none">
                    </div>
                    <div style="flex:2;min-width:120px">
                        <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:3px">Topic</div>
                        <input id="pyqCardTopic_${qi}" value="${(q._pyqTopic || '').replace(/"/g, '&quot;')}" placeholder="e.g. Coulomb law" style="width:100%;padding:5px 8px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:0.78rem;outline:none">
                    </div>
                </div>` : ""}
                <div class="field" id="impQViewMode_${qi}">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                        <label style="font-size:0.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Question${hasEq ? ' <span style="font-size:0.68rem;color:var(--accent-3)">— rendered LaTeX</span>' : ''}</label>
                        <button onclick="impToggleQEdit(${qi})" id="impQEditBtn_${qi}" style="padding:3px 10px;background:rgba(86,169,255,0.12);border:1px solid rgba(86,169,255,0.3);border-radius:4px;font-size:0.72rem;color:var(--accent);cursor:pointer;font-family:'Outfit',sans-serif;display:flex;align-items:center;gap:4px">✏ Edit</button>
                    </div>
                    <div id="impQPreview_${qi}" class="imp-q-preview" style="padding:10px 12px;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:0.87rem;line-height:1.7;color:var(--text);min-height:38px">${q.question.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                    <!-- Edit panel (hidden by default) -->
                    <div id="impQEditPanel_${qi}" style="display:none;margin-top:8px">
                        <textarea id="impQText_${qi}" rows="3" style="width:100%;background:rgba(255,255,255,0.06);border:1px solid rgba(86,169,255,0.4);border-radius:var(--radius-sm);padding:10px;color:var(--text);font-family:'Outfit',sans-serif;font-size:0.87rem;resize:vertical;outline:none;box-sizing:border-box">${q.question}</textarea>
                        <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
                            <button onclick="impSaveQEdit(${qi})" style="padding:4px 12px;background:rgba(16,185,129,0.18);border:1px solid rgba(16,185,129,0.4);border-radius:4px;font-size:0.74rem;color:#10b981;cursor:pointer;font-family:'Outfit',sans-serif;font-weight:600">✓ Save</button>
                            <span style="font-size:0.7rem;color:var(--text-muted)">Use $…$ for LaTeX equations</span>
                        </div>
                    </div>
                </div>
                ${diagHTML}
                <!-- Options: view mode (rendered) + edit mode (inputs) -->
                <div id="impOptsView_${qi}" class="imp-opts-grid">
                    ${(q.options || ["", "", "", ""]).map((opt, oi) => {
            // Show crop zone for this option if:
            // - hasOptionImages flag is set (AI detected diagram options), OR
            // - this specific option text signals a diagram
            const isDiagramOpt = q.hasOptionImages || !!(Array.isArray(q.optionImages) && q.optionImages[oi]) || (opt || "").trim() === "[Diagram \u2014 see figure]";
            const existingOptImg = Array.isArray(q.optionImages) ? (q.optionImages[oi] || null) : null;
            return `
                    <div class="imp-opt ${ci.includes(oi) ? "correct" : ""}" id="impOptBox_${qi}_${oi}" style="flex-direction:column;align-items:flex-start;gap:4px">
                        <div style="display:flex;align-items:center;gap:7px;width:100%">
                            <span class="imp-opt-letter">${LETTERS[oi]}</span>
                            <span id="impOptPreview_${qi}_${oi}" class="imp-opt-rendered" style="flex:1;font-size:0.82rem;line-height:1.6">${(opt || "").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
                        </div>
                        <div style="margin-left:26px;margin-top:3px;display:flex;flex-direction:column;gap:4px">
                            <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap">
                                <button id="impOptCropBtn_${qi}_${oi}" onclick="impOpenOptCropModal(${qi},${oi})" style="padding:3px 9px;background:rgba(46,210,180,0.12);border:1px solid rgba(46,210,180,0.35);border-radius:4px;font-size:0.7rem;color:var(--accent-2);cursor:pointer;font-family:'Outfit',sans-serif;display:inline-flex;align-items:center;gap:4px;width:fit-content">${existingOptImg ? '��� Re-crop' : '✂ Crop from Screenshot'}</button>
                                <label style="padding:3px 9px;background:rgba(86,169,255,0.08);border:1px solid rgba(86,169,255,0.25);border-radius:4px;font-size:0.7rem;color:var(--accent);cursor:pointer;font-family:'Outfit',sans-serif;display:inline-flex;align-items:center;gap:3px" title="Upload image for this option">🖼 Upload<input type="file" accept="image/*" style="display:none" onchange="impSetOptImgFromFile(${qi},${oi},this)"></label>
                                ${existingOptImg ? `<button onclick="impRemoveOptImg(${qi},${oi})" style="padding:3px 7px;background:rgba(242,92,92,0.08);border:1px solid rgba(242,92,92,0.22);border-radius:4px;font-size:0.7rem;color:var(--error);cursor:pointer;font-family:'Outfit',sans-serif">✕ Remove</button>` : ''}
                            </div>
                            <div id="impOptImgPreview_${qi}_${oi}" style="${existingOptImg ? 'display:block' : 'display:none'}">
                                ${existingOptImg ? `<img src="${impB64ToDataUrl(existingOptImg)}" style="max-width:100%;max-height:100px;border-radius:4px;object-fit:contain;border:1px solid var(--border)" alt="Option ${LETTERS[oi]} diagram">` : ''}
                            </div>
                        </div>
                        <!-- hidden input for save compatibility -->
                        <input value="${(opt || "").replace(/"/g, "&quot;")}" id="impOpt_${qi}_${oi}" style="display:none">
                    </div>`;
        }).join("")}
                </div>
                <!-- Options edit grid (hidden) -->
                <div id="impOptsEdit_${qi}" class="imp-opts-grid" style="display:none">
                    ${(q.options || ["", "", "", ""]).map((opt, oi) => `
                    <div class="imp-opt ${ci.includes(oi) ? "correct" : ""}" id="impOptEditBox_${qi}_${oi}">
                        <span class="imp-opt-letter">${LETTERS[oi]}</span>
                        <input value="${(opt || "").replace(/"/g, "&quot;")}" id="impOptEdit_${qi}_${oi}"
                            style="flex:1;background:transparent;border:none;color:var(--text);font-size:0.82rem;outline:none;font-family:'Outfit',sans-serif"
                            oninput="document.getElementById('impOpt_${qi}_${oi}').value=this.value">
                    </div>`).join("")}
                </div>
                <div id="impTablesBlock_${qi}"></div>
                <div id="impAnswerCtrl_${qi}" style="margin-top:10px">${impBuildAnswerCtrl(q, qi, ci)}</div>
                <div id="impSolBlock_${qi}"></div>`;
        container.appendChild(div);

        // Inject solution block after card is in DOM — always render for all types
        const solBlock = document.getElementById(`impSolBlock_${qi}`);
        if (solBlock) {
            solBlock.innerHTML = impBuildSolutionHTML(q.solutions || [], qi);
            // ensureRenderMath will retry until KaTeX auto-render is available
            setTimeout(() => ensureRenderMath(solBlock), 0);
        }
        const tblBlock = document.getElementById(`impTablesBlock_${qi}`);
        if (tblBlock) {
            tblBlock.innerHTML = impBuildTablesSection(q, qi);
            setTimeout(() => { if (window.renderMath) renderMath(tblBlock); }, 0);
        }
    });

    renderMath(container);
    impUpdateUndoBtns();
}

function impBuildAnswerCtrl(q, qi, ci) {
    if (q.isMultiCorrect) {
        return `<label style="font-size:0.75rem;color:var(--text-dim)">Correct Answers:</label>
                    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:5px">
                        ${LETTERS.map((l, i) => `<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:0.85rem"><input type="checkbox" class="impMultiChk_${qi}" value="${i}" ${ci.includes(i) ? "checked" : ""} onchange="impHighlightMulti(${qi})"> ${l}</label>`).join("")}
                    </div>`;
    }
    return `<label style="font-size:0.75rem;color:var(--text-dim)">Correct Answer:</label>
                <select id="impCorrectSel_${qi}" class="admin-select" style="border-radius:var(--radius-sm);padding:6px 12px;font-size:0.85rem;outline:none;margin-top:5px" onchange="impHighlightSingle(${qi})">
                    ${LETTERS.map((l, i) => `<option value="${i}" ${ci[0] === i ? "selected" : ""}>${l} — ${(q.options || [])[i] || ""}</option>`).join("")}
                </select>`;
}

function impBuildDiagZone(qi) {
    return `<div class="imp-diagram-zone" id="impDiagZone_${qi}" tabindex="0"
                ondragover="event.preventDefault();this.classList.add('dragover')"
                ondragleave="this.classList.remove('dragover')"
                ondrop="impHandleDiagDrop(event,${qi})"
                onkeydown="if(event.key==='Enter'||event.key===' ')document.getElementById('impDiagFile_${qi}').click()">
                <input type="file" accept="image/*" id="impDiagFile_${qi}" style="display:none" onchange="impHandleDiagFile(this,${qi})">
                <div style="font-size:1.3rem">🖼</div>
                <div style="font-size:0.8rem;color:var(--text-dim);margin-top:4px">Drop, paste or <label onclick="document.getElementById('impDiagFile_${qi}').click()" style="cursor:pointer;color:var(--accent);text-decoration:underline">browse</label> diagram image</div>
                <button onclick="impOpenCropModal(${qi})" style="margin-top:8px;padding:5px 12px;background:rgba(86,169,255,0.1);border:1px solid rgba(86,169,255,0.3);border-radius:var(--radius-sm);font-size:0.78rem;color:var(--accent);cursor:pointer;font-family:'Outfit',sans-serif">✂ Crop from Screenshot</button>
                <div id="impDiagImgPreview_${qi}" style="display:none;margin-top:10px">
                    <img id="impDiagImgEl_${qi}" src="" alt="" style="max-width:100%;max-height:180px;border-radius:4px;object-fit:contain">
                    <div style="margin-top:4px;font-size:0.72rem;color:var(--success)">✅ Image set</div>
                    <button onclick="impRemoveDiagImg(${qi})" style="margin-top:4px;padding:4px 10px;background:rgba(242,92,92,0.08);border:1px solid rgba(242,92,92,0.25);border-radius:var(--radius-sm);font-size:0.74rem;color:var(--error);cursor:pointer;font-family:'Outfit',sans-serif">✕ Remove</button>
                </div>
            </div>`;
}

/* ── Table rendering + table-cell images (screenshot importer) ───── */
// Renders any extracted body/option tables for a question, plus paste
// boxes for cells flagged { imageNeeded:true } by the extractor.
function impBuildTablesSection(q, qi) {
    let html = "";
    try {
        let optionTables = [null, null, null, null];
        let otherTables = Array.isArray(q.tables) ? q.tables : [];
        if (typeof _extractOptionTables === "function") {
            const ex = _extractOptionTables(q);
            optionTables = ex.optionTables;
            otherTables = ex.otherTables;
        }
        const bodyTables = (typeof _normalizeTablesField === "function") ? _normalizeTablesField(otherTables) : [];
        if (bodyTables.length && typeof renderTablesHtml === "function") {
            html += `<div style="margin-top:10px"><div style="font-size:0.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Table(s)</div>${renderTablesHtml(bodyTables)}</div>`;
        }
        if (Array.isArray(optionTables) && optionTables.some(Boolean) && typeof renderSingleTableHtml === "function") {
            html += `<div style="margin-top:10px"><div style="font-size:0.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Option tables</div>`;
            ["A", "B", "C", "D"].forEach((L, i) => {
                if (optionTables[i]) html += `<div style="margin-bottom:6px"><span style="font-weight:700;color:var(--accent);font-size:0.78rem">(${L})</span> ${renderSingleTableHtml(optionTables[i])}</div>`;
            });
            html += `</div>`;
        }
    } catch (e) { /* rendering helpers unavailable — skip */ }
    html += impBuildCellImageSection(q, qi);
    return html;
}

let _impCellRefs = {};
function _impIsImgCell(c) {
    return c && typeof c === "object" && !Array.isArray(c) && ("image" in c || "svg" in c || c.imageNeeded === true || c.image_needed === true);
}
function _impCellTables(q) {
    const out = [];
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
    if (Array.isArray(q.optionTables)) {
        q.optionTables.forEach((t, ti) => {
            if (t && typeof t === "object") out.push({ scope: "optionTables", ti, table: t, label: `Option ${["A", "B", "C", "D"][ti] || ti + 1}` });
        });
    }
    return out;
}
function impBuildCellImageSection(q, qi) {
    const tables = _impCellTables(q);
    // Surface EVERY cell so a user can attach an image to any table cell, not
    // just the ones flagged by the extractor. Keep a container+index reference
    // so a plain-text cell can be upgraded to a { text, image } object.
    const cellsList = [];
    tables.forEach((entry) => {
        const t = entry.table;
        const scan = (container, kind, ri) => {
            if (!Array.isArray(container)) return;
            container.forEach((c, ci) => {
                if (c && typeof c === "object" && !Array.isArray(c) && c.image == null && (c.imageNeeded || c.image_needed)) c.image = null;
                cellsList.push({ entry, kind, ri, ci, container });
            });
        };
        scan(t.headers, "header", -1);
        (t.rows || []).forEach((r, ri) => scan(r, "row", ri));
    });
    if (!cellsList.length) return "";
    const _esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const _txtOf = (c) => (c == null) ? "" : (typeof c === "object" ? (c.text != null ? String(c.text) : "") : String(c));
    const _imgOf = (c) => (c && typeof c === "object" && c.image) ? String(c.image) : "";
    let html = `<div style="margin-top:10px;padding:10px 12px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.25);border-radius:8px">
                <div style="font-size:0.72rem;font-weight:700;color:#f59e0b;margin-bottom:8px">🖼 Table cell images — paste an image for any cell (e.g. a diagram inside the cell)</div>
                <div style="display:flex;flex-direction:column;gap:8px">`;
    cellsList.forEach((p) => {
        const key = `impcell_${qi}_${p.entry.scope}_${p.entry.ti}_${p.kind}_${p.ri}_${p.ci}`;
        const where = p.kind === "header" ? `header col ${p.ci + 1}` : `row ${p.ri + 1}, col ${p.ci + 1}`;
        const cur = p.container[p.ci];
        const txt = _txtOf(cur);
        const imgSrc = _imgOf(cur);
        const hasImg = !!imgSrc;
        const label = _esc(p.entry.label);
        const prev = txt ? ` · “${_esc(txt.length > 18 ? txt.slice(0, 18) + "…" : txt)}”` : "";
        html += `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <span style="font-size:0.72rem;color:var(--text-dim);min-width:150px">${label} · ${where}${prev}</span>
                    <div id="${key}_preview" style="display:${hasImg ? "flex" : "none"};align-items:center;gap:8px">
                        <img id="${key}_img" src="${hasImg ? imgSrc : ""}" style="max-width:120px;max-height:80px;border-radius:5px;border:1px solid var(--border);object-fit:contain">
                        <button onclick="impRemoveCellImage('${key}')" style="background:none;border:none;color:var(--error);cursor:pointer;font-size:0.72rem">✕ Remove</button>
                    </div>
                    <div id="${key}_paste" tabindex="0" style="display:${hasImg ? "none" : "block"};flex:1;min-width:160px;padding:6px 8px;border:2px dashed rgba(245,158,11,0.4);border-radius:6px;text-align:center;cursor:pointer;font-size:0.68rem;color:var(--text-muted);background:rgba(245,158,11,0.04);outline:none"
                        onpaste="impHandleCellPaste(event,'${key}')"
                        onfocus="this.style.borderColor='#f59e0b'"
                        onblur="this.style.borderColor='rgba(245,158,11,0.4)'">
                        📋 Click here & Ctrl+V to paste this cell's image
                    </div>
                </div>`;
        _impCellRefs[key] = { container: p.container, ci: p.ci };
    });
    html += `</div></div>`;
    return html;
}
function impHandleCellPaste(event, key) {
    event.preventDefault();
    event.stopPropagation();
    const items = (event.clipboardData || event.originalEvent.clipboardData).items;
    for (const item of items) {
        if (item.type.indexOf("image") !== -1) {
            const blob = item.getAsFile();
            const reader = new FileReader();
            reader.onload = function (e) {
                const base64 = e.target.result;
                const ref = _impCellRefs[key];
                if (ref && ref.container) {
                    const cur = ref.container[ref.ci];
                    const txt = (cur && typeof cur === "object") ? (cur.text != null ? cur.text : "") : (cur == null ? "" : String(cur));
                    ref.container[ref.ci] = { text: txt, image: base64 };
                }
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
function impRemoveCellImage(key) {
    const ref = _impCellRefs[key];
    if (ref && ref.container) {
        const cur = ref.container[ref.ci];
        const txt = (cur && typeof cur === "object") ? (cur.text != null ? cur.text : "") : (cur == null ? "" : String(cur));
        ref.container[ref.ci] = txt;
    }
    const preview = document.getElementById(`${key}_preview`);
    const paste = document.getElementById(`${key}_paste`);
    if (preview) preview.style.display = "none";
    if (paste) paste.style.display = "block";
}
if (typeof window !== "undefined") {
    window.impHandleCellPaste = impHandleCellPaste;
    window.impRemoveCellImage = impRemoveCellImage;
}

/* ── Answer highlight helpers ────────────────────────────────────── */
function impHighlightSingle(qi) {
    const sel = parseInt(document.getElementById(`impCorrectSel_${qi}`)?.value ?? -1);
    document.querySelectorAll(`[id^="impOptBox_${qi}_"]`).forEach((el, oi) =>
        el.classList.toggle("correct", oi === sel));
}
function impHighlightMulti(qi) {
    const checked = [...document.querySelectorAll(`.impMultiChk_${qi}:checked`)].map(c => parseInt(c.value));
    document.querySelectorAll(`[id^="impOptBox_${qi}_"]`).forEach((el, oi) =>
        el.classList.toggle("correct", checked.includes(oi)));
}

/* ── Toggle single/multi ─────────────────────────────────────────── */
function impSyncQFromDOM(qi) {
    const q = impQuestions[qi];
    if (!q) return;
    const qEl = document.getElementById(`impQText_${qi}`);
    const lecEl = document.getElementById(`impLec_${qi}`);
    if (qEl) q.question = qEl.value;
    if (lecEl) q.assignedLecture = parseInt(lecEl.value) || q.assignedLecture;
    q.options = LETTERS.map((_, oi) => document.getElementById(`impOpt_${qi}_${oi}`)?.value || "");
    const multiChks = [...document.querySelectorAll(`.impMultiChk_${qi}:checked`)].map(c => parseInt(c.value));
    const singleSel = parseInt(document.getElementById(`impCorrectSel_${qi}`)?.value);
    let ci = multiChks.length ? multiChks : Number.isInteger(singleSel) ? [singleSel] : (q.correctIndexes || [0]);
    q.correctIndexes = [...new Set(ci.filter(i => Number.isInteger(i) && i >= 0 && i < 4))];
    if (!q.correctIndexes.length) q.correctIndexes = [0];
}

function impToggleMulti(qi, makeMulti) {
    impSyncQFromDOM(qi);
    const q = impQuestions[qi];
    if (!q) return;
    q.isMultiCorrect = makeMulti;
    if (!makeMulti && q.correctIndexes.length > 1) q.correctIndexes = [q.correctIndexes[0]];
    const wrap = document.getElementById(`impAnswerCtrl_${qi}`);
    if (wrap) {
        wrap.innerHTML = impBuildAnswerCtrl(q, qi, q.correctIndexes);
        if (makeMulti) impHighlightMulti(qi);
        else impHighlightSingle(qi);
    }
    // Update pill buttons
    const card = document.getElementById(`impQ_${qi}`);
    const btns = card?.querySelectorAll(".imp-answer-mode-pill button");
    if (btns && btns.length === 2) {
        btns[0].style.cssText = !makeMulti ? "background:var(--accent);color:#fff" : "background:transparent;color:var(--text-dim)";
        btns[1].style.cssText = makeMulti ? "background:var(--accent-4);color:#1f1300" : "background:transparent;color:var(--text-dim)";
    }
}

/* ── Diagram image management ─────────────────────────────────────── */
function impSetDiagramImage(qi, b64) {
    const q = impQuestions[qi];
    if (q) { q._manualImgB64 = b64; q.hasImage = true; }
    const preview = document.getElementById(`impDiagImgPreview_${qi}`);
    const imgEl = document.getElementById(`impDiagImgEl_${qi}`);
    if (preview && imgEl) {
        imgEl.src = impB64ToDataUrl(b64);
        preview.style.display = "block";
    }
    // Switch to manual zone if currently showing auto
    const autoDiv = document.getElementById(`impDiagPreviewAuto_${qi}`);
    const manualDiv = document.getElementById(`impDiagManualZone_${qi}`);
    if (autoDiv) autoDiv.style.display = "none";
    if (manualDiv) manualDiv.style.display = "block";
}

function impRejectAutoImg(qi) {
    const q = impQuestions[qi];
    if (q) { q._imgB64 = null; q._detectMethod = null; }
    const autoDiv = document.getElementById(`impDiagPreviewAuto_${qi}`);
    const manualDiv = document.getElementById(`impDiagManualZone_${qi}`);
    if (autoDiv) autoDiv.style.display = "none";
    if (manualDiv) {
        manualDiv.style.display = "block";
        if (!manualDiv.innerHTML.trim()) manualDiv.innerHTML = impBuildDiagZone(qi);
    }
}

async function impHandleDiagFile(input, qi) {
    const f = input.files[0];
    if (f) impSetDiagramImage(qi, await impFileToB64(f));
}

async function impHandleDiagDrop(e, qi) {
    e.preventDefault();
    document.getElementById(`impDiagZone_${qi}`)?.classList.remove("dragover");
    const f = [...e.dataTransfer.files].find(f => f.type.startsWith("image/"));
    if (f) impSetDiagramImage(qi, await impFileToB64(f));
}

function impRemoveDiagImg(qi) {
    const q = impQuestions[qi];
    if (q) q._manualImgB64 = null;
    const preview = document.getElementById(`impDiagImgPreview_${qi}`);
    if (preview) preview.style.display = "none";
}

function impRemoveOptImg(qi, oi) {
    const q = impQuestions[qi];
    if (q && Array.isArray(q.optionImages)) q.optionImages[oi] = null;
    const previewEl = document.getElementById(`impOptImgPreview_${qi}_${oi}`);
    if (previewEl) { previewEl.innerHTML = ''; previewEl.style.display = 'none'; }
    const cropBtn = document.getElementById(`impOptCropBtn_${qi}_${oi}`);
    if (cropBtn) cropBtn.textContent = '\u2702 Crop from Screenshot';
    // If no option images remain, clear the flag
    if (q && Array.isArray(q.optionImages) && !q.optionImages.some(Boolean)) q.hasOptionImages = false;
}

/* ── Upload image directly for an option ───────────────────────────── */
function impSetOptImgFromFile(qi, oi, input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        const b64 = e.target.result.split(',')[1];
        const q = impQuestions[qi];
        if (!q) return;
        if (!Array.isArray(q.optionImages)) q.optionImages = [null, null, null, null];
        q.optionImages[oi] = b64;
        q.hasOptionImages = true;
        // Update preview
        const previewEl = document.getElementById(`impOptImgPreview_${qi}_${oi}`);
        if (previewEl) {
            previewEl.innerHTML = `<img src="${e.target.result}" style="max-width:100%;max-height:100px;border-radius:4px;object-fit:contain;border:1px solid var(--border)" alt="Option image">
                        <button onclick="impRemoveOptImg(${qi},${oi})" style="padding:3px 7px;background:rgba(242,92,92,0.08);border:1px solid rgba(242,92,92,0.22);border-radius:4px;font-size:0.7rem;color:var(--error);cursor:pointer;font-family:'Outfit',sans-serif;margin-top:4px">✕ Remove</button>`;
            previewEl.style.display = 'block';
        }
        const cropBtn = document.getElementById(`impOptCropBtn_${qi}_${oi}`);
        if (cropBtn) cropBtn.textContent = '✂ Re-crop';
    };
    reader.readAsDataURL(file);
}

/* ── Add / remove questions ──────────────────────────────────────── */
function impRemoveQ(qi) {
    impUndoPush(impSnap());
    impSyncQFromDOM(qi);
    document.getElementById(`impQ_${qi}`)?.remove();
    const sl = parseInt(document.getElementById("imp-lecture").value) || 1;
    document.querySelectorAll(".imp-q-card").forEach((el, idx) => {
        const lbl = el.querySelector("strong"); if (lbl) lbl.textContent = `Q${idx + 1}`;
    });
    impUpdateUndoBtns();
}

function impAddBlankQ() {
    const sl = parseInt(document.getElementById("imp-lecture").value) || 1;
    const lastLec = impQuestions.length
        ? (impQuestions[impQuestions.length - 1].assignedLecture || sl)
        : sl - 1;
    // For star quiz, all questions share the same lecture number
    const newLec = _impType === "star_quiz" ? sl : lastLec + 1;
    impQuestions.push({
        question: "", options: ["", "", "", ""],
        correctIndexes: [0], isMultiCorrect: false,
        assignedLecture: newLec, hasImage: false,
        _imgB64: null, _manualImgB64: null
    });
    impRenderReview();
}

/* ── Save all to database ────────────────────────────────────────── */
async function impSaveAll() {
    const chapter = document.getElementById("imp-chapter").value.trim();
    const topic = document.getElementById("imp-topic")?.value.trim() || "";
    if (!chapter) { showErrorModal("Please enter a chapter.", "Missing fields"); return; }

    // Sync current DOM values into impQuestions
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
        const questionImage = origQ._manualImgB64 || origQ._imgB64 || origQ.questionImage || null;
        const subject = String(origQ.subject || origQ._pyqSubject || "").trim() || "Unknown";
        const unit = String(origQ.unit || origQ._pyqUnit || "").trim();
        const topicKey = String(origQ.topic || topic || "").trim();
        const groupKey = `${subject}|||${chapter}|||${topicKey || "(No Topic)"}|||${lec}`;
        if (!groups[groupKey]) groups[groupKey] = { subject, unit, chapter, topic: topicKey, lecture: lec, questions: [] };
        const optionImages_save = Array.isArray(origQ.optionImages) ? origQ.optionImages : [null, null, null, null];
        const hasOptionImages_save = !!(origQ.hasOptionImages && optionImages_save.some(Boolean));
        const tables_save = Array.isArray(origQ.tables) && origQ.tables.length ? origQ.tables : null;
        const optionTables_save = Array.isArray(origQ.optionTables) && origQ.optionTables.some(Boolean) ? origQ.optionTables : null;
        const solutions = Array.isArray(origQ.solutions)
            ? origQ.solutions.map(sol => sol ? {
                ...sol,
                text: String(sol.text || sol.content || sol.solution || sol.explanation || ""),
                image: sol.image || null,
                images: Array.isArray(sol.images) ? sol.images.filter(Boolean) : (sol.image ? [sol.image] : [])
            } : null).filter(Boolean)
            : [];
        groups[groupKey].questions.push({
            question: txt,
            options: opts,
            correctIndexes: ci,
            isMultiCorrect: ci.length > 1,
            questionImage,
            optionImages: optionImages_save,
            hasOptionImages: hasOptionImages_save,
            ...(tables_save ? { tables: tables_save } : {}),
            ...(optionTables_save ? { optionTables: optionTables_save } : {}),
            solutions,
            hasImage: !!(origQ.hasImage || questionImage),
            numericalAnswer: origQ.numericalAnswer,
            subject,
            unit,
            topic: topicKey || topic,
            year: origQ.year || origQ._pyqMeta?.year || null,
            month: origQ.month || origQ._pyqMeta?.month || null,
            day: origQ.day || origQ.date || origQ._pyqMeta?.date || null,
            date: origQ.date || origQ.day || origQ._pyqMeta?.date || null,
            shift: origQ.shift || origQ._pyqMeta?.shift || null,
            exam: origQ.exam || origQ.examName || origQ.exam_name || origQ.exam_label || null,
        });
    });

    if (hasError) { showErrorModal("Some questions are missing text or lecture number.", "Incomplete data"); return; }
    const groupEntries = Object.values(groups);
    if (!groupEntries.length) { showErrorModal("No questions to save.", "Nothing to save"); return; }

    // Progress overlay
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
    for (const group of groupEntries) {
        const { subject, chapter: groupChapter, topic: groupTopic, lecture: lec, questions: lecArr } = group;
        document.getElementById("impProgText").textContent = `Saving ${subject} › ${groupChapter} › ${groupTopic || "(No Topic)"}…`;
        const resp = await fetch(`${API_BASE}/api/admin/add-question`, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chapter: groupChapter, lecture: lec, topic: groupTopic || topic, questions: lecArr })
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
        ? `${savedQ} question(s) saved across ${groupEntries.length} subject/chapter/topic group(s).`
        : `Saved: ${savedQ}. Failed lectures: ${failed.join(", ")}.`;
    openModal("successModal");
    await loadQuestionsAdmin();
    if (typeof loadChaptersAdmin === "function") loadChaptersAdmin();
}

/* ── Undo / Redo ─────────────────────────────────────────────────── */
let impUndoStack = [], impRedoStack = [];

function impSnap() {
    return {
        questions: JSON.parse(JSON.stringify(impQuestions)),
        qImgs: [...impQImages], aImgs: [...impAImages],
    };
}
function impUndoPush(snap) { impUndoStack.push(snap); impRedoStack = []; impUpdateUndoBtns(); }
function impUpdateUndoBtns() {
    const u = document.getElementById("impUndoBtn"), r = document.getElementById("impRedoBtn");
    if (u) u.disabled = !impUndoStack.length;
    if (r) r.disabled = !impRedoStack.length;
}
function impRestoreSnap(snap) {
    impQuestions = JSON.parse(JSON.stringify(snap.questions));
    impQImages = [...snap.qImgs];
    impAImages = [...snap.aImgs];
    impRefreshPreviews();
    if (impQuestions.length) impRenderReview();
    impUpdateUndoBtns();
}
function impUndoAction() {
    if (!impUndoStack.length) return;
    impRedoStack.push(impSnap());
    impRestoreSnap(impUndoStack.pop());
}
function impRedoAction() {
    if (!impRedoStack.length) return;
    impUndoStack.push(impSnap());
    impRestoreSnap(impRedoStack.pop());
}

document.addEventListener("keydown", e => {
    if (!document.getElementById("section-importQuestion")?.classList.contains("active")) return;
    if (e.ctrlKey || e.metaKey) {
        if (e.key === "z" || e.key === "Z") { e.preventDefault(); impUndoAction(); }
        if (e.key === "y" || e.key === "Y") { e.preventDefault(); impRedoAction(); }
    }
});

// Keyboard arrow navigation for Manage Questions view
document.addEventListener("keydown", e => {
    // Only active when the manage questions section is open and question view is visible
    if (!document.getElementById("section-manageQuestions")?.classList.contains("active")) return;
    const qView = document.getElementById("mq-question-view");
    if (!qView || qView.style.display === "none") return;
    // Don't intercept when user is typing in an input/textarea
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    // Don't intercept if a modal is open
    if (document.querySelector(".modal-overlay.open, .modal-overlay[style*='flex']")) return;
    if (e.key === "ArrowRight") {
        const nextBtn = document.getElementById("mq-next-btn");
        if (nextBtn && !nextBtn.disabled && nextBtn.style.display !== "none") {
            e.preventDefault();
            navigateQuestion(1);
        }
    } else if (e.key === "ArrowLeft") {
        const prevBtn = document.getElementById("mq-prev-btn");
        if (prevBtn && !prevBtn.disabled && prevBtn.style.display !== "none") {
            e.preventDefault();
            navigateQuestion(-1);
        }
    }
});

/* ── Manual Crop Modal ──────────────────────────��────────────────── */

/* ═══════════════════════════════════════════════════════════════════
   JSON UPLOAD — State & Helpers
═══════════════════════════════════════════════════════════════════ */
let _jsonUploadQuestions = [];
let _jsonUploadFile = null;
let _jsonUploadImages = {}; // { "q_0": ["base64..."], "sol_0": ["base64..."], "opt_0_1": "base64..." }
// Two-file import: the questions file is kept here exactly as parsed, so the
// figures file can be merged in (or re-merged) without re-reading the questions.
let _jsonUploadRawQuestions = [];
let _figureUploadFile = null;
let _figureUploadDoc = null;   // parsed figures file, order-independent
let _figureUploadReport = null;
let _jsonUploadExamType = "jee_mains"; // "jee_mains" | "neet"
let _jsonUploadNeetMode = "chapterwise"; // "chapterwise" | "paper"
let _jsonUploadJeeMode = "paper"; // "chapterwise" | "paper"

function jsonUploadSetExamType(type) {
    const selected = type === 'neet' ? 'neet' : 'jee_mains';
    _jsonUploadExamType = selected;

    const jeeBtn = document.getElementById("jsonUploadExamJee");
    const neetBtn = document.getElementById("jsonUploadExamNeet");
    const details = document.getElementById("jsonUploadPaperDetails");
    const infoNote = document.getElementById("jsonUploadInfoNote");
    const neetMode = document.getElementById("jsonUploadNeetModeBlock");
    const jeeMode = document.getElementById("jsonUploadJeeModeBlock");

    if (jeeBtn) {
        jeeBtn.style.border = selected === 'jee_mains' ? "1px solid var(--accent)" : "1px solid var(--border)";
        jeeBtn.style.background = selected === 'jee_mains' ? "rgba(86,169,255,0.12)" : "var(--bg-card)";
        jeeBtn.style.color = selected === 'jee_mains' ? "#56a9ff" : "var(--text)";
    }
    if (neetBtn) {
        neetBtn.style.border = selected === 'neet' ? "1px solid var(--accent)" : "1px solid var(--border)";
        neetBtn.style.background = selected === 'neet' ? "rgba(86,169,255,0.12)" : "var(--bg-card)";
        neetBtn.style.color = selected === 'neet' ? "#56a9ff" : "var(--text)";
    }

    // Show/hide sub-mode blocks
    if (jeeMode) jeeMode.style.display = selected === 'jee_mains' ? 'block' : 'none';
    if (neetMode) neetMode.style.display = selected === 'neet' ? 'block' : 'none';

    // Paper Details: only visible for JEE paper mode
    if (details) details.style.display = (selected === 'jee_mains' && _jsonUploadJeeMode === 'paper') ? 'block' : 'none';

    if (infoNote) {
        if (selected === 'jee_mains') {
            if (_jsonUploadJeeMode === 'paper') {
                infoNote.style.display = 'block';
                infoNote.innerHTML = `<strong style="color:var(--accent-2)">How it works:</strong>
                                Fill in the paper details (Year, Month, Date, Shift) and upload the JSON file extracted by
                                Gemini.
                                All questions will be previewed with their tags (Subject, Chapter, Topic) and you can attach
                                multiple images to each question and solution.
                                Questions are stored according to their Subject, Chapter, and Topic tagging and will appear
                                in the Manage section grouped by Subject → Chapter → Topic → Question.
                                Supports MCQ, MSQ (multi-correct), and Integer type questions.`;
            } else {
                infoNote.style.display = 'block';
                infoNote.innerHTML = `<strong style="color:var(--accent-2)">Chapterwise Upload:</strong>
                                Upload a JSON file with JEE questions tagged by chapter and topic.
                                Questions are stored grouped by Chapter → Topic — no paper date needed.
                                Ideal for uploading chapter-wise JEE practice question sets.`;
            }
        } else {
            infoNote.style.display = 'none';
            // initialize NEET sub-mode UI
            try { jsonUploadSetNeetMode(_jsonUploadNeetMode); } catch (e) { /* ignore if not yet defined */ }
        }
    }
}

function jsonUploadSetJeeMode(mode) {
    const m = mode === 'chapterwise' ? 'chapterwise' : 'paper';
    _jsonUploadJeeMode = m;
    const chBtn = document.getElementById('jsonJeeChapterBtn');
    const pBtn = document.getElementById('jsonJeePaperBtn');
    const details = document.getElementById('jsonUploadPaperDetails');
    const infoNote = document.getElementById('jsonUploadInfoNote');
    if (chBtn) {
        chBtn.style.border = m === 'chapterwise' ? '1px solid var(--accent)' : '1px solid var(--border)';
        chBtn.style.background = m === 'chapterwise' ? 'rgba(86,169,255,0.08)' : 'var(--bg-card)';
        chBtn.style.color = m === 'chapterwise' ? '#56a9ff' : 'var(--text)';
    }
    if (pBtn) {
        pBtn.style.border = m === 'paper' ? '1px solid var(--accent)' : '1px solid var(--border)';
        pBtn.style.background = m === 'paper' ? 'rgba(86,169,255,0.08)' : 'var(--bg-card)';
        pBtn.style.color = m === 'paper' ? '#56a9ff' : 'var(--text)';
    }
    // Show Paper Details only for paper mode
    if (details) details.style.display = m === 'paper' ? 'block' : 'none';
    // Update info note
    if (infoNote && _jsonUploadExamType === 'jee_mains') {
        infoNote.style.display = 'block';
        if (m === 'paper') {
            infoNote.innerHTML = `<strong style="color:var(--accent-2)">How it works:</strong>
                        Fill in the paper details (Year, Month, Date, Shift) and upload the JSON file extracted by
                        Gemini.
                        All questions will be previewed with their tags (Subject, Chapter, Topic) and you can attach
                        multiple images to each question and solution.
                        Questions are stored according to their Subject, Chapter, and Topic tagging and will appear
                        in the Manage section grouped by Subject → Chapter → Topic → Question.
                        Supports MCQ, MSQ (multi-correct), and Integer type questions.`;
        } else {
            infoNote.innerHTML = `<strong style="color:var(--accent-2)">Chapterwise Upload:</strong>
                        Upload a JSON file with JEE questions tagged by chapter and topic.
                        Questions are stored grouped by Chapter → Topic — no paper date needed.
                        Ideal for uploading chapter-wise JEE practice question sets.`;
        }
    }
}

function jsonUploadSetNeetMode(mode) {
    const m = mode === 'paper' ? 'paper' : 'chapterwise';
    _jsonUploadNeetMode = m;
    const chBtn = document.getElementById('jsonNeetChapterBtn');
    const pBtn = document.getElementById('jsonNeetPaperBtn');
    const yearBlock = document.getElementById('jsonNeetPaperYearBlock');
    if (chBtn) {
        chBtn.style.border = m === 'chapterwise' ? '1px solid var(--accent)' : '1px solid var(--border)';
        chBtn.style.background = m === 'chapterwise' ? 'rgba(86,169,255,0.08)' : 'var(--bg-card)';
        chBtn.style.color = m === 'chapterwise' ? '#56a9ff' : 'var(--text)';
    }
    if (pBtn) {
        pBtn.style.border = m === 'paper' ? '1px solid var(--accent)' : '1px solid var(--border)';
        pBtn.style.background = m === 'paper' ? 'rgba(86,169,255,0.08)' : 'var(--bg-card)';
        pBtn.style.color = m === 'paper' ? '#56a9ff' : 'var(--text)';
    }
    if (yearBlock) yearBlock.style.display = m === 'paper' ? 'block' : 'none';
}

function _jsonUploadInferNeetLecture(q) {
    const direct = [
        q?.lecture,
        q?.paper,
        q?.paper_name,
        q?.paperName,
        q?.test_name,
        q?.session,
        q?.exam_label
    ].find(v => String(v || '').trim());
    if (direct) return String(direct).trim();

    const examName = String(q?.exam || q?.exam_name || 'NEET').trim();
    const parts = [examName, q?.year, q?.month, q?.date, q?.shift]
        .map(v => String(v || '').trim())
        .filter(Boolean);
    return parts.length ? parts.join(' ') : 'NEET JSON Upload';
}

function _jsonUploadNormalizeImageList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    return [value].filter(Boolean);
}

function _jsonUploadToSrc(img) {
    if (!img) return '';
    const value = String(img);
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:')) return value;
    const mime = value.startsWith('/9j/') ? 'image/jpeg' : value.startsWith('iVBOR') ? 'image/png' : value.startsWith('R0lGOD') ? 'image/gif' : 'image/jpeg';
    return `data:${mime};base64,${value}`;
}

function _jsonUploadGetQuestionImages(q, idx) {
    const stored = _jsonUploadImages[`q_${idx}`];
    if (Array.isArray(stored)) return stored.filter(Boolean);
    if (stored) return [stored].filter(Boolean);
    return _jsonUploadNormalizeImageList(q?.questionImages || q?.questionImage || q?.image || null);
}

function _jsonUploadGetSolutionImages(q, idx) {
    const stored = _jsonUploadImages[`sol_${idx}`];
    if (Array.isArray(stored)) return stored.filter(Boolean);
    if (stored) return [stored].filter(Boolean);
    if (Array.isArray(q?.solutionImages)) return q.solutionImages.filter(Boolean);
    if (Array.isArray(q?.solutions) && q.solutions.length) {
        const firstSol = q.solutions[0] || {};
        return _jsonUploadNormalizeImageList(firstSol.images || firstSol.image || null);
    }
    return _jsonUploadNormalizeImageList(q?.solutionImage || null);
}

function _jsonUploadSetImageList(idx, type, images) {
    const key = type === 'question' ? `q_${idx}` : `sol_${idx}`;
    _jsonUploadImages[key] = _jsonUploadNormalizeImageList(images);
}

function _jsonUploadRenderImageStack(idx, type, images) {
    const sectionId = type === 'question' ? `jsonQImageSection_${idx}` : `jsonSolImageSection_${idx}`;
    const clearLabel = type === 'question' ? 'Question' : 'Solution';
    const uploadLabel = type === 'question' ? 'Upload question images' : 'Upload solution images';
    const pasteLabel = type === 'question' ? 'Paste question image' : 'Paste solution image';
    const accent = type === 'question' ? 'rgba(86,169,255,0.22)' : 'rgba(46,210,180,0.22)';
    const accentSoft = type === 'question' ? 'rgba(86,169,255,0.08)' : 'rgba(46,210,180,0.08)';
    const thumbHtml = (images || []).map((img, imgIdx) => `
                <div style="position:relative;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg-card)">
                    <img src="${_jsonUploadToSrc(img)}" alt="${clearLabel} image ${imgIdx + 1}" style="display:block;width:100%;max-height:180px;object-fit:contain;background:#000">
                    <button type="button" onclick="jsonUploadRemoveImage(${idx},'${type}',${imgIdx})" style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.18);border-radius:999px;color:#fff;cursor:pointer;font-size:0.72rem;padding:4px 7px">✕</button>
                </div>
            `).join('');
    const emptyHtml = `<div style="font-size:0.72rem;color:var(--text-muted);padding:6px 0">No ${clearLabel.toLowerCase()} images added yet.</div>`;
    return `<div id="${sectionId}" style="margin-top:8px;padding:10px 12px;background:${accentSoft};border:1px solid ${accent};border-radius:var(--radius-sm)">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px">
                    <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${type === 'question' ? '#56a9ff' : '#2ed2b4'}">${clearLabel} Images (${(images || []).length})</div>
                    <label style="padding:4px 10px;background:var(--bg-card);border:1px solid var(--border);border-radius:999px;font-size:0.72rem;color:var(--text);cursor:pointer;display:inline-flex;align-items:center;gap:5px">
                        ${uploadLabel}
                        <input type="file" accept="image/*" multiple style="display:none" onchange="jsonUploadHandleImages(this, ${idx}, '${type}')">
                    </label>
                </div>
                <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:8px">${pasteLabel} or upload multiple files at once.</div>
                <div id="${type === 'question' ? `jsonQImageList_${idx}` : `jsonSolImageList_${idx}`}" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px">
                    ${thumbHtml || emptyHtml}
                </div>
                <div id="${type === 'question' ? `jsonQImagePaste_${idx}` : `jsonSolImagePaste_${idx}`}" tabindex="0"
                    style="margin-top:8px;padding:8px;border:1px dashed var(--border);border-radius:8px;text-align:center;cursor:pointer;font-size:0.7rem;color:var(--text-muted);background:var(--bg-card);outline:none"
                    onpaste="jsonUploadHandlePaste(event,${idx},'${type}')"
                    onfocus="this.style.borderColor='var(--accent)';this.style.color='var(--text)'"
                    onblur="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
                    📋 ${pasteLabel}
                </div>
            </div>`;
}

function _jsonUploadRefreshImageSection(idx, type) {
    const q = _jsonUploadQuestions[idx] || {};
    const images = type === 'question' ? _jsonUploadGetQuestionImages(q, idx) : _jsonUploadGetSolutionImages(q, idx);
    const section = document.getElementById(type === 'question' ? `jsonQImageSection_${idx}` : `jsonSolImageSection_${idx}`);
    if (section) section.outerHTML = _jsonUploadRenderImageStack(idx, type, images);
}

function jsonUploadFileSelected(input) {
    const file = input.files[0];
    if (!file) return;
    _jsonUploadFile = file;
    const fileInfo = document.getElementById("jsonUploadFileInfo");
    if (fileInfo) fileInfo.style.display = "flex";
    const namEl = document.getElementById("jsonUploadFileName");
    const sizeEl = document.getElementById("jsonUploadFileSize");
    if (namEl) namEl.textContent = file.name;
    if (sizeEl) sizeEl.textContent = (file.size / 1024).toFixed(1) + " KB";
    const icon = document.getElementById("jsonUploadIcon");
    const label = document.getElementById("jsonUploadLabel");
    if (icon) icon.textContent = "✅";
    if (label) label.textContent = "File selected — " + file.name;
    const zone = document.getElementById("jsonUploadDropZone");
    if (zone) { zone.style.borderColor = "var(--accent)"; zone.style.background = "rgba(86,169,255,0.06)"; }

    // Read and parse the file
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            let text = e.target.result.trim();
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
            const questions = JSON.parse(text);
            if (!Array.isArray(questions) || !questions.length) {
                showErrorModal("The file does not contain a valid JSON array of questions.", "Invalid Format");
                jsonUploadClearFile();
                return;
            }
            // AI-drawn SVG diagrams (question_svg / option_svgs / solution_svg /
            // { svg } table cells) are converted to data URIs here, which fills the
            // normal image fields — so the preview shows the diagram and no manual
            // "paste image" box is requested for it. See shared/shared-svg.js.
            // Keep the questions file pristine; the pipeline below merges the
            // separate figures file (if one is loaded) and converts SVG to images.
            _jsonUploadRawQuestions = questions;
            _jsonUploadApplyPipeline();
        } catch (err) {
            showErrorModal("Failed to parse JSON: " + err.message, "Parse Error");
            jsonUploadClearFile();
        }
    };
    reader.readAsText(file);
}

/**
 * Rebuild the preview from the questions file + the figures file.
 * Safe to call repeatedly and in either upload order: it always starts from
 * the untouched parsed questions, so merging is never applied twice.
 */
function _jsonUploadApplyPipeline() {
    if (!Array.isArray(_jsonUploadRawQuestions) || !_jsonUploadRawQuestions.length) return;

    // Deep copy so a re-merge can never stack figures onto an earlier merge.
    let questions;
    try {
        questions = JSON.parse(JSON.stringify(_jsonUploadRawQuestions));
    } catch (e) {
        questions = _jsonUploadRawQuestions.slice();
    }

    _figureUploadReport = null;
    if (_figureUploadDoc && typeof vyMergeFigureFile === 'function') {
        try {
            const merged = vyMergeFigureFile(questions, _figureUploadDoc);
            questions = merged.questions;
            _figureUploadReport = merged.report;
        } catch (e) {
            showErrorModal("Could not merge the figures file: " + e.message, "Figure Merge Failed");
        }
    }

    // AI-drawn SVG (question_svg / option_svgs / solution_svg / { svg } table
    // cells) becomes a data URI here, which fills the normal image fields — so
    // the preview shows each diagram and no manual paste box is requested.
    _jsonUploadQuestions = (typeof vyNormalizeQuestionSvg === 'function')
        ? questions.map(function (q) { try { return vyNormalizeQuestionSvg(q); } catch (e) { return q; } })
        : questions;

    _jsonUploadImages = {};
    _jsonUploadRenderPreview(_jsonUploadQuestions);
    _figureUploadRenderReport();
}

function _figureUploadRenderReport() {
    const box = document.getElementById("figureUploadReport");
    if (!box) return;
    if (!_figureUploadReport) { box.style.display = "none"; box.textContent = ""; return; }
    const r = _figureUploadReport;
    const clean = !r.unmatched.length && !r.expectedMissing.length && !r.empty && !r.assumed;
    box.style.display = "block";
    box.style.whiteSpace = "pre-wrap";
    box.style.borderColor = clean ? "rgba(46,204,113,0.35)" : "rgba(245,166,35,0.45)";
    box.style.background = clean ? "rgba(46,204,113,0.08)" : "rgba(245,166,35,0.08)";
    box.style.color = "var(--text-dim)";
    box.textContent = (clean ? "✓ " : "") +
        (typeof vyFigureReportText === 'function' ? vyFigureReportText(r) : "");
}

function figureUploadFileSelected(input) {
    const file = input.files[0];
    if (!file) return;
    _figureUploadFile = file;

    const info = document.getElementById("figureUploadFileInfo");
    if (info) info.style.display = "flex";
    const nameEl = document.getElementById("figureUploadFileName");
    const sizeEl = document.getElementById("figureUploadFileSize");
    if (nameEl) nameEl.textContent = file.name;
    if (sizeEl) sizeEl.textContent = (file.size / 1024).toFixed(1) + " KB";
    const icon = document.getElementById("figureUploadIcon");
    const label = document.getElementById("figureUploadLabel");
    if (icon) icon.textContent = "✅";
    if (label) label.textContent = "Figures file selected — " + file.name;
    const zone = document.getElementById("figureUploadDropZone");
    if (zone) { zone.style.borderColor = "var(--accent)"; zone.style.background = "rgba(86,169,255,0.06)"; }

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            let text = e.target.result.trim();
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
            const doc = JSON.parse(text);

            // The merge lives in shared/shared-svg.js. If it is missing, the browser
            // is running a cached copy of that file from before this feature existed
            // — which is NOT a problem with the figures file, so say so plainly.
            if (typeof vyParseFigureFile !== 'function' || typeof vyMergeFigureFile !== 'function') {
                showErrorModal(
                    "This page is running an old cached copy of shared/shared-svg.js, which " +
                    "does not have the figure merge in it yet. Your file is probably fine.\n\n" +
                    "Hard-refresh the panel (Ctrl+Shift+R, or Cmd+Shift+R on a Mac) and try " +
                    "again. If it keeps happening, the service worker is serving the old file: " +
                    "open DevTools → Application → Service Workers → Unregister, then reload.",
                    "Panel Needs a Refresh");
                figureUploadClearFile();
                return;
            }

            const entries = vyParseFigureFile(doc);
            if (!entries.length) {
                // Parsed fine but nothing usable came out — report what we actually saw
                // instead of asserting the file has no figures.
                let detail = "";
                if (Array.isArray(doc)) {
                    const objs = doc.filter(function (e) { return e && typeof e === 'object'; });
                    const keys = objs.length ? Object.keys(objs[0]).join(", ") : "";
                    detail = "The file is an array of " + doc.length + " item(s)";
                    if (keys) detail += ", and the first one has these keys: " + keys + ".";
                    detail += "\n\nEvery figure needs an \"svg\" value containing markup that " +
                        "starts with <svg. Values that are a file name, a URL, an empty string " +
                        "or a placeholder are skipped.";
                } else if (doc && typeof doc === 'object') {
                    detail = "The file is an object with these top-level keys: " +
                        Object.keys(doc).slice(0, 12).join(", ") + ".";
                } else {
                    detail = "The file did not contain a JSON array or object.";
                }
                showErrorModal(
                    detail + "\n\nExpected shape:\n" +
                    '[{ "question_number": 102, "target": "solution", "svg": "<svg …</svg>" }]',
                    "No Figures Found In That File");
                figureUploadClearFile();
                return;
            }
            _figureUploadDoc = doc;
            if (Array.isArray(_jsonUploadRawQuestions) && _jsonUploadRawQuestions.length) {
                _jsonUploadApplyPipeline();
            } else {
                // Figures arrived first — hold them until the questions file loads.
                const box = document.getElementById("figureUploadReport");
                if (box) {
                    box.style.display = "block";
                    box.style.borderColor = "rgba(86,169,255,0.35)";
                    box.style.background = "rgba(86,169,255,0.08)";
                    box.style.color = "var(--text-dim)";
                    box.textContent = entries.length + " figures ready — they will be attached as soon as you upload the questions file.";
                }
            }
        } catch (err) {
            showErrorModal("Failed to parse the figures file: " + err.message, "Parse Error");
            figureUploadClearFile();
        }
    };
    reader.readAsText(file);
}

function figureUploadClearFile() {
    _figureUploadFile = null;
    _figureUploadDoc = null;
    _figureUploadReport = null;
    const input = document.getElementById("figureUploadFile");
    if (input) input.value = "";
    const info = document.getElementById("figureUploadFileInfo");
    if (info) info.style.display = "none";
    const icon = document.getElementById("figureUploadIcon");
    const label = document.getElementById("figureUploadLabel");
    if (icon) icon.textContent = "🎨";
    if (label) label.textContent = "Click to choose the figures (SVG) JSON file or drag & drop";
    const zone = document.getElementById("figureUploadDropZone");
    if (zone) { zone.style.borderColor = "var(--border)"; zone.style.background = "var(--bg-card)"; }
    const box = document.getElementById("figureUploadReport");
    if (box) { box.style.display = "none"; box.textContent = ""; }
    // Drop the merged diagrams but keep the questions themselves.
    if (Array.isArray(_jsonUploadRawQuestions) && _jsonUploadRawQuestions.length) _jsonUploadApplyPipeline();
}

window.figureUploadFileSelected = figureUploadFileSelected;
window.figureUploadClearFile = figureUploadClearFile;

function jsonUploadClearFile() {
    _jsonUploadFile = null;
    _jsonUploadQuestions = [];
    _jsonUploadRawQuestions = [];
    _jsonUploadImages = {};
    const input = document.getElementById("jsonUploadFile");
    if (input) input.value = "";
    const fileInfo = document.getElementById("jsonUploadFileInfo");
    if (fileInfo) fileInfo.style.display = "none";
    const icon = document.getElementById("jsonUploadIcon");
    const label = document.getElementById("jsonUploadLabel");
    if (icon) icon.textContent = "📋";
    if (label) label.textContent = "Click to choose JSON/TXT file or drag & drop";
    const zone = document.getElementById("jsonUploadDropZone");
    if (zone) { zone.style.borderColor = "var(--border)"; zone.style.background = "var(--bg-card)"; }
    const preview = document.getElementById("jsonUploadPreview");
    if (preview) preview.style.display = "none";
}

function _jsonEscHtml(str) {
    return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}