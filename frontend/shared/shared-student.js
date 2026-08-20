/* ══════════════════════════════════════════════════════════════════
   STUDENTS
══════════════════════════════════════════════════════════════════ */
let studentViewMode = 'cards';

function setStudentView(mode) {
    studentViewMode = mode;
    document.getElementById('view-cards-btn').classList.toggle('active', mode === 'cards');
    document.getElementById('view-table-btn').classList.toggle('active', mode === 'table');
    document.getElementById('studentCardsContainer').style.display = mode === 'cards' ? '' : 'none';
    document.getElementById('studentTableContainer').style.display = mode === 'table' ? '' : 'none';
    filterStudents(document.getElementById('studentSearch').value);
}

function populateStudentChapterFilter() {
    const chapters = [...new Set(allStudents.map(s => s.chapter).filter(Boolean))].sort();
    const sel = document.getElementById('stu-chapter-filter');
    if (sel) {
        sel.innerHTML = '<option value="">All Chapters</option>' + chapters.map(c => `<option value="${c}">${c}</option>`).join('');
    }
}

function getStudentStats(data) {
    const wa = data.filter(s => (s.answers && s.answers.length > 0) || typeof s.correctCount === "number");
    const total = wa.length;
    let correct = 0, totalQuestions = 0, topScore = 0;
    wa.forEach(s => {
        if (typeof s.correctCount === "number") {
            correct += s.correctCount;
            totalQuestions += s.totalQuestions || 0;
            const pct = s.totalQuestions ? Math.round((s.correctCount / s.totalQuestions) * 100) : 0;
            if (pct > topScore) topScore = pct;
        } else {
            correct += s.correct ? 1 : 0;
            totalQuestions++;
            if (s.correct) topScore = 100;
        }
    });
    const avg = totalQuestions > 0 ? Math.round((correct / totalQuestions) * 100) : 0;
    return { total, attempts: total, avgScore: avg, topScore };
}

function updateStudentStats(data) {
    const stats = getStudentStats(data);
    const el = document.getElementById('stu-stat-total');
    if (el) el.textContent = stats.total;
    const avgEl = document.getElementById('stu-stat-avg');
    if (avgEl) avgEl.textContent = stats.avgScore + '%';
    const topEl = document.getElementById('stu-stat-top');
    if (topEl) topEl.textContent = stats.topScore + '%';
    const countEl = document.getElementById('filterCount');
    if (countEl) countEl.textContent = stats.total;
}

function getScoreClass(pct) {
    if (pct >= 80) return 'excellent';
    if (pct >= 60) return 'good';
    if (pct >= 40) return 'average';
    return 'poor';
}

function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(' ');
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
}

function renderStudentCards(data) {
    const container = document.getElementById('studentCardsContainer');
    if (!container) return;
    const wa = data.filter(s => (s.answers && s.answers.length > 0) || typeof s.correctCount === "number");

    if (!wa.length) {
        document.getElementById('studentEmptyState').style.display = 'block';
        container.innerHTML = '';
        return;
    }
    document.getElementById('studentEmptyState').style.display = 'none';

    container.innerHTML = wa.map(s => {
        let correct, total;
        if (typeof s.correctCount === "number") { correct = s.correctCount; total = s.totalQuestions || 1; }
        else { correct = s.correct ? 1 : 0; total = 1; }
        const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
        const scoreClass = getScoreClass(pct);
        const initials = getInitials(s.name);

        const cheatCardBadge = s.cheatFlag ? `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:50px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.45);color:#f87171;font-size:0.65rem;font-weight:700;margin-left:6px">⚠️ CHEATING</span>` : '';
        return `<div class="stu-card" onclick="showStudentDetail('${(s._id || s.mobile || '').toString().replace(/'/g, "\\'")}')" style="${s.cheatFlag ? 'border-color:rgba(239,68,68,0.45);background:linear-gradient(135deg,var(--bg-card),rgba(239,68,68,0.04))' : ''}">
                    <div class="stu-card-header">
                        <div class="stu-card-avatar" style="${s.cheatFlag ? 'background:linear-gradient(135deg,#ef4444,#b91c1c)' : ''}">${initials}</div>
                        <div class="stu-card-info">
                            <div class="stu-card-name">${s.name || 'Unknown'}${cheatCardBadge}</div>
                            <div class="stu-card-meta">📱 ${s.mobile || '—'} • ${s.place || '—'} • ${s.className || '—'}</div>
                        </div>
                    </div>
                    <div class="stu-card-tags">
                        <span class="stu-tag">${s.chapter || 'Unknown'}</span>
                        <span class="stu-tag">Lecture ${s.lecture || '—'}</span>
                    </div>
                    <div class="stu-card-footer">
                        <span class="stu-score-text">${correct}/${total}</span>
                        <div class="stu-score-circle ${scoreClass}"><span>${pct}%</span></div>
                    </div>
                </div>`;
    }).join('');
}

function renderStudentTable(data) {
    const tbody = document.getElementById("studentTableBody"); if (!tbody) return;
    tbody.innerHTML = "";
    const wa = data.filter(s => (s.answers && s.answers.length > 0) || typeof s.correctCount === "number");
    if (!wa.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;opacity:0.4;padding:30px"><div style="font-size:2rem;margin-bottom:8px">📭</div>No student records yet.</td></tr>'; return; }
    wa.forEach(s => {
        let correct, total;
        if (typeof s.correctCount === "number") { correct = s.correctCount; total = s.totalQuestions || 1; }
        else { correct = s.correct ? 1 : 0; total = 1; }
        const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
        const cheatTableBadge = s.cheatFlag ? `<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:50px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.45);color:#f87171;font-size:0.65rem;font-weight:700">⚠️ CHEATING</span>` : '';
        tbody.insertAdjacentHTML("beforeend", `<tr style="transition:var(--transition);${s.cheatFlag ? 'background:rgba(239,68,68,0.05)' : ''}" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='${s.cheatFlag ? 'rgba(239,68,68,0.05)' : ''}'"><td><div style="display:flex;align-items:center;gap:10px"><div style="width:32px;height:32px;border-radius:50%;background:${s.cheatFlag ? 'linear-gradient(135deg,#ef4444,#b91c1c)' : 'linear-gradient(135deg,var(--accent),var(--accent-2))'};display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:700;flex-shrink:0">${getInitials(s.name)}</div><span style="font-weight:600">${s.name || "—"}${cheatTableBadge}</span></div></td><td style="font-family:'JetBrains Mono',monospace;font-size:0.78rem">${s.mobile || "—"}</td><td>${s.place || "—"}</td><td>${s.className || "—"}</td><td><span class="student-tag" style="margin:0">${s.chapter || "—"}</span></td><td>L${s.lecture || "—"}</td><td><strong>${correct}/${total}</strong></td><td><span class="badge-pill ${pct >= 50 ? "ok" : "wrong"}" style="font-weight:700">${pct}%</span></td></tr>`);
    });
}

function filterStudents(q) {
    const f = q.toLowerCase();
    const chapterFilter = document.getElementById('stu-chapter-filter')?.value || '';
    const sortFilter = document.getElementById('stu-sort-filter')?.value || 'recent';
    const cheatFilter = document.getElementById('stu-cheat-filter')?.value || '';

    let filtered = allStudents.filter(s => {
        const matchSearch = !f || (s.name || "").toLowerCase().includes(f) || (s.mobile || "").includes(f) || String(s.lecture || "").includes(f) || (s.chapter || "").toLowerCase().includes(f) || (s.place || "").toLowerCase().includes(f);
        const matchChapter = !chapterFilter || s.chapter === chapterFilter;
        const matchCheat = !cheatFilter || (cheatFilter === 'cheating' && s.cheatFlag);
        return matchSearch && matchChapter && matchCheat;
    });

    filtered.sort((a, b) => {
        switch (sortFilter) {
            case 'name': return (a.name || '').localeCompare(b.name || '');
            case 'score-desc':
                const scoreA = a.totalQuestions ? Math.round((a.correctCount / a.totalQuestions) * 100) : (a.correct ? 100 : 0);
                const scoreB = b.totalQuestions ? Math.round((b.correctCount / b.totalQuestions) * 100) : (b.correct ? 100 : 0);
                return scoreB - scoreA;
            case 'score-asc':
                const scoreC = a.totalQuestions ? Math.round((a.correctCount / a.totalQuestions) * 100) : (a.correct ? 100 : 0);
                const scoreD = b.totalQuestions ? Math.round((b.correctCount / b.totalQuestions) * 100) : (b.correct ? 100 : 0);
                return scoreC - scoreD;
            default: return 0;
        }
    });

    updateStudentStats(filtered);
    if (studentViewMode === 'cards') {
        renderStudentCards(filtered);
    } else {
        renderStudentTable(filtered);
    }
}

function showStudentDetail(id) {
    const targetId = String(id ?? "");
    const student = allStudents.find(s => String(s._id ?? "") === targetId)
        || allStudents.find(s => String(s.mobile ?? "") === targetId);
    if (!student) {
        showErrorModal("Student not found in the records.", "Error");
        return;
    }
    let correct, total;
    if (typeof student.correctCount === "number") { correct = student.correctCount; total = student.totalQuestions || 1; }
    else { correct = student.correct ? 1 : 0; total = 1; }
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    const wrong = total - correct;
    const initials = getInitials(student.name || "U");
    document.getElementById("sdd-avatar").textContent = initials;
    document.getElementById("sdd-avatar").style.background = student.cheatFlag
        ? "linear-gradient(135deg,#ef4444,#b91c1c)"
        : "linear-gradient(135deg,var(--accent),var(--accent-2))";
    document.getElementById("sdd-name").textContent = student.name || "Unknown Student";
    document.getElementById("sdd-meta").textContent = `${student.chapter || 'Unknown'} • Lecture ${student.lecture || '?'}`;
    document.getElementById("sdd-cheat-badge").style.display = student.cheatFlag ? "block" : "none";
    document.getElementById("sdd-cheat-actions").style.display = student.cheatFlag ? "block" : "none";
    document.getElementById("sdd-correct").textContent = correct;
    document.getElementById("sdd-wrong").textContent = wrong;
    document.getElementById("sdd-total").textContent = total;
    document.getElementById("sdd-progress-bar").style.width = pct + '%';
    document.getElementById("sdd-score-pct").textContent = pct + '%';
    document.getElementById("sdd-place").textContent = student.place || '—';
    document.getElementById("sdd-class").textContent = student.className || '—';
    document.getElementById("sdd-mobile").textContent = student.mobile || '—';
    // Store current student id for the mark-incorrect action
    document.getElementById("studentDetailModal")._currentStudentId = student._id;
    openModal("studentDetailModal");
}
window.showStudentDetail = showStudentDetail;

async function markStudentAllIncorrect() {
    const modal = document.getElementById("studentDetailModal");
    const studentId = modal._currentStudentId;
    if (!studentId) return;
    const btn = document.getElementById("sdd-mark-incorrect-btn");
    btn.disabled = true;
    btn.textContent = "Processing...";
    try {
        const res = await fetch(`/api/admin/student/${studentId}/mark-cheater`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include"
        });
        const data = await res.json();
        if (data.success) {
            // Update in-memory student record
            const idx = allStudents.findIndex(s => String(s._id) === String(studentId));
            if (idx !== -1) {
                allStudents[idx].correctCount = 0;
                allStudents[idx].answers = (allStudents[idx].answers || []).map(() => -1);
            }
            closeModal("studentDetailModal");
            filterStudents(document.getElementById('studentSearch')?.value || '');
            showSuccessToast?.("All answers marked as incorrect.");
        } else {
            btn.disabled = false;
            btn.textContent = "🚫 Mark All Answers as Incorrect";
            alert("Error: " + (data.error || "Failed to update."));
        }
    } catch (e) {
        btn.disabled = false;
        btn.textContent = "🚫 Mark All Answers as Incorrect";
        alert("Network error. Please try again.");
    }
}
window.markStudentAllIncorrect = markStudentAllIncorrect;


/* ══════════════════════════════════════════════════════════════════
   CSV EXPORT
══════════════════════════════════════════════════════════════════ */
function exportCSV() {
    const q = (document.getElementById('studentSearch')?.value || "").toLowerCase().trim();
    const chapterFilter = document.getElementById('stu-chapter-filter')?.value || '';
    const sortFilter = document.getElementById('stu-sort-filter')?.value || 'recent';

    const toPct = (s) => {
        const total = Number(s.totalQuestions || 0);
        const correct = Number(s.correctCount || 0);
        return total > 0 ? Math.round((correct / total) * 100) : (s.correct ? 100 : 0);
    };

    const performanceBand = (pct) => {
        if (pct >= 80) return "Excellent";
        if (pct >= 60) return "Good";
        if (pct >= 40) return "Average";
        return "Needs Improvement";
    };

    const safeCell = (value) => {
        const raw = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
        // Prevent spreadsheet formula injection while keeping values human-readable.
        const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
        return `"${guarded.replace(/"/g, '""')}"`;
    };

    const addRow = (lines, cells) => {
        lines.push(cells.map(safeCell).join(','));
    };

    let rows = allStudents
        .filter(s => (s.answers && s.answers.length > 0) || typeof s.correctCount === "number")
        .filter(s => {
            const searchMatch = !q
                || (s.name || "").toLowerCase().includes(q)
                || (s.mobile || "").includes(q)
                || (s.chapter || "").toLowerCase().includes(q)
                || String(s.lecture || "").includes(q)
                || (s.place || "").toLowerCase().includes(q)
                || (s.className || "").toLowerCase().includes(q);
            const chapterMatch = !chapterFilter || s.chapter === chapterFilter;
            return searchMatch && chapterMatch;
        });

    rows.sort((a, b) => {
        switch (sortFilter) {
            case 'name': return (a.name || '').localeCompare(b.name || '');
            case 'score-desc': return toPct(b) - toPct(a);
            case 'score-asc': return toPct(a) - toPct(b);
            default: return Number(b.time || 0) - Number(a.time || 0);
        }
    });

    const stats = getStudentStats(rows);
    const chapters = new Set(rows.map(r => r.chapter).filter(Boolean));
    const now = new Date();
    const sortLabelMap = {
        recent: 'Most Recent',
        name: 'Name (A-Z)',
        'score-desc': 'Score (High to Low)',
        'score-asc': 'Score (Low to High)'
    };

    const bandBuckets = { Excellent: 0, Good: 0, Average: 0, 'Needs Improvement': 0 };
    rows.forEach((s) => {
        const band = performanceBand(toPct(s));
        bandBuckets[band] = (bandBuckets[band] || 0) + 1;
    });

    const topRows = [...rows].sort((a, b) => {
        const scoreDelta = toPct(b) - toPct(a);
        if (scoreDelta !== 0) return scoreDelta;
        return Number(b.correctCount || 0) - Number(a.correctCount || 0);
    }).slice(0, 10);

    const lines = [];
    // Excel-friendly delimiter hint.
    lines.push('sep=,');
    const _csvInstituteName = (typeof __activeInstitute !== 'undefined' && __activeInstitute && __activeInstitute.name)
        ? __activeInstitute.name
        : 'Student Performance';
    addRow(lines, [_csvInstituteName.toUpperCase() + ' - STUDENT PERFORMANCE REPORT']);
    lines.push('');

    addRow(lines, ['Report Info', 'Value']);
    addRow(lines, ['Generated At', now.toLocaleString()]);
    addRow(lines, ['Records Included', rows.length]);
    addRow(lines, ['Unique Chapters', chapters.size]);
    addRow(lines, ['Chapter Filter', chapterFilter || 'All Chapters']);
    addRow(lines, ['Sort Mode', sortLabelMap[sortFilter] || sortFilter]);
    lines.push('');

    addRow(lines, ['Score Summary', 'Value']);
    addRow(lines, ['Average Score (%)', stats.avgScore]);
    addRow(lines, ['Top Score (%)', stats.topScore]);
    addRow(lines, ['Total Attempts', stats.attempts || rows.length]);
    lines.push('');

    addRow(lines, ['Performance Bands', 'Students']);
    addRow(lines, ['Excellent (80-100%)', bandBuckets.Excellent]);
    addRow(lines, ['Good (60-79%)', bandBuckets.Good]);
    addRow(lines, ['Average (40-59%)', bandBuckets.Average]);
    addRow(lines, ['Needs Improvement (<40%)', bandBuckets['Needs Improvement']]);
    lines.push('');

    addRow(lines, ['Top 10 Students', 'Score (%)', 'Correct', 'Total', 'Chapter', 'Lecture']);
    if (!topRows.length) {
        addRow(lines, ['No student data available']);
    } else {
        topRows.forEach((s) => {
            const total = Number(s.totalQuestions || 0);
            const correct = Number(s.correctCount || 0);
            addRow(lines, [s.name || 'Unknown', toPct(s), correct, total, s.chapter || '', s.lecture || '']);
        });
    }
    lines.push('');

    addRow(lines, ['Detailed Student Records']);
    addRow(lines, ['Rank', 'Name', 'Mobile', 'Class', 'Place', 'Chapter', 'Lecture', 'Correct', 'Wrong', 'Total', 'Score (%)', 'Performance', 'Attempt Time']);

    rows.forEach((s, idx) => {
        const total = Number(s.totalQuestions || 0);
        const correct = Number(s.correctCount || 0);
        const wrong = Math.max(0, total - correct);
        const pct = toPct(s);
        const timeStr = s.time ? new Date(s.time).toLocaleString() : '';
        const mobileText = s.mobile ? `'${String(s.mobile)}` : '';

        addRow(lines, [
            idx + 1,
            s.name || '',
            mobileText,
            s.className || '',
            s.place || '',
            s.chapter || '',
            s.lecture || '',
            correct,
            wrong,
            total,
            pct,
            performanceBand(pct),
            timeStr,
        ]);
    });

    const csv = "\uFEFF" + lines.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `Vyorra_Student_Report_${now.toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}


/* ══════════════════════════════════════════════════════════════════
   REGISTERED STUDENTS — Roll number management
══════════════════════════════════════════════════════════════════ */
let _allRegisteredStudents = [];
let _filteredRegisteredStudents = [];
let _selectedRegClass = "";
let _selectedRegSection = "";

async function loadRegisteredStudents() {
    try {
        const r = await fetch(`${API_BASE}/api/admin/registered-students`, { credentials: "include", cache: "no-store" });
        if (!r.ok) throw new Error("Failed to fetch");
        _allRegisteredStudents = await r.json();
        filterRegisteredStudents(document.getElementById("regStuSearch")?.value || "");
        updateRegStats(_allRegisteredStudents);
    } catch (e) {
        console.error("loadRegisteredStudents:", e);
    }
}

function updateRegStats(data) {
    const complete = data.filter(s => s.profileComplete).length;
    document.getElementById("reg-stat-total").textContent = data.length;
    document.getElementById("reg-stat-complete").textContent = complete;
    document.getElementById("reg-stat-pending").textContent = data.length - complete;
}

function filterRegisteredStudents(q) {
    const query = (q || "").toLowerCase().trim();
    const filter = document.getElementById("regStuFilter")?.value || "";
    let data = _allRegisteredStudents.filter(s => {
        const matchQ = !query
            || s.rollNumber.toLowerCase().includes(query)
            || (s.name || "").toLowerCase().includes(query)
            || (s.className || "").toLowerCase().includes(query);
        const matchFilter = !filter
            || (filter === "complete" && s.profileComplete)
            || (filter === "incomplete" && !s.profileComplete);
        return matchQ && matchFilter;
    });
    _filteredRegisteredStudents = data;

    const drill = buildRegisteredStudentDrillData(data);
    if (_selectedRegClass && !drill.classMap.has(_selectedRegClass)) {
        _selectedRegClass = "";
        _selectedRegSection = "";
    }
    if (_selectedRegClass && _selectedRegSection) {
        const selectedClassEntry = drill.classMap.get(_selectedRegClass);
        if (!selectedClassEntry || !selectedClassEntry.sections.has(_selectedRegSection)) {
            _selectedRegSection = "";
        }
    }

    renderRegisteredStudentsTable(data);
    document.getElementById("reg-stat-showing").textContent = data.length;
}

function parseClassSectionFromClassName(classNameRaw) {
    const raw = String(classNameRaw || "").trim();
    if (!raw) {
        return {
            classLabel: "Class Unspecified",
            sectionLabel: "Section General",
            classSortNum: Number.POSITIVE_INFINITY,
            classSortText: "UNSPECIFIED",
            sectionSort: "ZZZ"
        };
    }

    const cleaned = raw.replace(/\s+/g, " ");
    let classPart = cleaned;
    let sectionPart = "";

    const splitByDivider = cleaned.match(/^(.*?)\s*(?:-|\/|\||,|\bsec(?:tion)?\b|\bdivision\b)\s*([A-Za-z0-9]+)$/i);
    if (splitByDivider) {
        classPart = splitByDivider[1].trim();
        sectionPart = splitByDivider[2].trim().toUpperCase();
    } else {
        const parts = cleaned.split(" ");
        const last = parts[parts.length - 1] || "";
        if (parts.length > 1 && /^[A-Za-z]$/.test(last)) {
            classPart = parts.slice(0, -1).join(" ").trim();
            sectionPart = last.toUpperCase();
        }
    }

    classPart = classPart.replace(/^class\s*/i, "").trim();
    if (!classPart) classPart = "Unspecified";

    const classMatch = classPart.match(/\d+/);
    return {
        classLabel: `Class ${classPart}`,
        sectionLabel: `Section ${sectionPart || "General"}`,
        classSortNum: classMatch ? Number(classMatch[0]) : Number.POSITIVE_INFINITY,
        classSortText: classPart.toUpperCase(),
        sectionSort: sectionPart || "ZZZ"
    };
}

function escapeForOnclickString(v) {
    return String(v || "").replace(/'/g, "\\'");
}

// Global HTML escaper — restored after the STAR Quiz feature (which
// previously held the global definition) was removed/commented out.
// Many render functions (registered students table, student picker,
// solution editor, etc.) depend on this being globally available.
function escapeHtml(str) {
    return String(str == null ? "" : str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function openRegClassView(encodedClassLabel) {
    _selectedRegClass = decodeURIComponent(encodedClassLabel || "");
    _selectedRegSection = "";
    renderRegisteredStudentsTable(_filteredRegisteredStudents);
}

function openRegSectionView(encodedSectionLabel) {
    _selectedRegSection = decodeURIComponent(encodedSectionLabel || "");
    renderRegisteredStudentsTable(_filteredRegisteredStudents);
}

function backToRegClasses() {
    _selectedRegClass = "";
    _selectedRegSection = "";
    renderRegisteredStudentsTable(_filteredRegisteredStudents);
}

function backToRegSections() {
    _selectedRegSection = "";
    renderRegisteredStudentsTable(_filteredRegisteredStudents);
}

function buildRegisteredStudentDrillData(data) {
    const classMap = new Map();
    data.forEach(student => {
        const parsed = parseClassSectionFromClassName(student.className);
        if (!classMap.has(parsed.classLabel)) {
            classMap.set(parsed.classLabel, {
                ...parsed,
                sections: new Map(),
                total: 0
            });
        }

        const classEntry = classMap.get(parsed.classLabel);
        classEntry.total += 1;

        if (!classEntry.sections.has(parsed.sectionLabel)) {
            classEntry.sections.set(parsed.sectionLabel, {
                label: parsed.sectionLabel,
                sortKey: parsed.sectionSort,
                students: []
            });
        }
        classEntry.sections.get(parsed.sectionLabel).students.push(student);
    });

    const classes = [...classMap.values()].sort((a, b) => {
        if (a.classSortNum !== b.classSortNum) return a.classSortNum - b.classSortNum;
        return a.classSortText.localeCompare(b.classSortText);
    });

    classes.forEach(classEntry => {
        classEntry.sortedSections = [...classEntry.sections.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    });

    return { classMap, classes };
}

function renderRegisteredStudentsTable(data) {
    const tbody = document.getElementById("regStuTableBody");
    const empty = document.getElementById("regStuEmpty");
    const wrap = document.getElementById("regStuTableWrap");
    const groupedWrap = document.getElementById("regStuGroupedWrap");
    if (!data.length) {
        tbody.innerHTML = "";
        wrap.style.display = "none";
        groupedWrap.style.display = "none";
        groupedWrap.innerHTML = "";
        empty.style.display = "block";
        return;
    }

    const drill = buildRegisteredStudentDrillData(data);

    // Keep legacy table hidden and render card drill-down.
    wrap.style.display = "none";
    groupedWrap.style.display = "grid";
    empty.style.display = "none";

    if (!_selectedRegClass) {
        groupedWrap.innerHTML = `
                    <div class="reg-drill-path">Class Cards</div>
                    <div class="reg-drill-grid">
                        ${drill.classes.map(classEntry => `
                            <div class="reg-pick-card" onclick="openRegClassView('${encodeURIComponent(classEntry.classLabel)}')" role="button" tabindex="0">
                                <div class="reg-pick-icon">🎓</div>
                                <div class="reg-pick-title">${escapeHtml(classEntry.classLabel)}</div>
                                <div class="reg-pick-sub">${classEntry.total} Student${classEntry.total !== 1 ? "s" : ""}</div>
                            </div>
                        `).join("")}
                    </div>`;
        return;
    }

    const classEntry = drill.classMap.get(_selectedRegClass);
    if (!classEntry) {
        backToRegClasses();
        return;
    }

    if (!_selectedRegSection) {
        groupedWrap.innerHTML = `
                    <div class="reg-drill-head">
                        <button class="reg-drill-btn" onclick="backToRegClasses()">← Back To Classes</button>
                        <span class="reg-drill-path">${escapeHtml(_selectedRegClass)} · Section Cards</span>
                    </div>
                    <div class="reg-drill-grid">
                        ${classEntry.sortedSections.map(sectionInfo => `
                            <div class="reg-pick-card" onclick="openRegSectionView('${encodeURIComponent(sectionInfo.label)}')" role="button" tabindex="0">
                                <div class="reg-pick-icon">📁</div>
                                <div class="reg-pick-title">${escapeHtml(sectionInfo.label)}</div>
                                <div class="reg-pick-sub">${sectionInfo.students.length} Student${sectionInfo.students.length !== 1 ? "s" : ""}</div>
                            </div>
                        `).join("")}
                    </div>`;
        return;
    }

    const sectionInfo = classEntry.sections.get(_selectedRegSection);
    if (!sectionInfo) {
        backToRegSections();
        return;
    }

    const students = [...sectionInfo.students].sort((a, b) => String(a.rollNumber || "").localeCompare(String(b.rollNumber || "")));
    groupedWrap.innerHTML = `
                <div class="reg-drill-head">
                    <button class="reg-drill-btn" onclick="backToRegSections()">← Back To Sections</button>
                    <button class="reg-drill-btn" onclick="backToRegClasses()">↺ Class Cards</button>
                    <span class="reg-drill-path">${escapeHtml(_selectedRegClass)} · ${escapeHtml(_selectedRegSection)} · Student List</span>
                </div>
                <div class="reg-list-wrap">
                    <div class="reg-list-head">
                        <span class="reg-list-title">Students In ${escapeHtml(_selectedRegSection)}</span>
                        <span class="reg-list-count">Total: ${students.length}</span>
                    </div>
                    <div class="reg-list-body">
                        ${students.map((s, idx) => {
        const safeRoll = escapeHtml(s.rollNumber || "-");
        const safeName = escapeHtml(s.name || "Unnamed");
        const safePhone = escapeHtml(s.phone || "—");
        const safeEmail = escapeHtml(s.email || "— no email —");
        const statusHtml = s.profileComplete
            ? '<span class="reg-status-chip" style="background:rgba(46,204,113,0.15);color:#2ecc71;border-color:rgba(46,204,113,0.3)">Registered</span>'
            : '<span class="reg-status-chip" style="background:rgba(243,156,18,0.12);color:#f39c12;border-color:rgba(243,156,18,0.3)">Pending</span>';
        return `
                                <div class="reg-list-item">
                                    <div class="reg-list-left">
                                        <span class="reg-list-index">${idx + 1}</span>
                                        <div style="min-width:0">
                                            <div class="reg-list-name">${safeName}</div>
                                            <div class="reg-list-meta">${safeEmail} · Roll: ${safeRoll} · Phone: ${safePhone}</div>
                                        </div>
                                    </div>
                                    <div class="reg-list-right">
                                        ${statusHtml}
                                        <button class="reg-remove-mini" title="Remove ${safeRoll}"
                                            onclick="deleteRegisteredStudent(${s.id}, '${escapeForOnclickString(s.rollNumber)}')">✕</button>
                                    </div>
                                </div>`;
    }).join("")}
                    </div>
                </div>`;
}

/* ── Access Requests Panel ──────────────────────────── */
let _studentRequests = [];

function openRequestsPanel() {
    const backdrop = document.getElementById('req-panel-backdrop');
    backdrop.style.display = 'flex';
    // Trigger reflow for animation
    void backdrop.offsetWidth;
    loadStudentRequests();
}

function closeRequestsPanel() {
    const panel = document.getElementById('req-panel');
    panel.style.animation = 'reqPopOut 0.18s ease forwards';
    setTimeout(() => {
        document.getElementById('req-panel-backdrop').style.display = 'none';
        panel.style.animation = '';
    }, 170);
}

async function loadStudentRequests() {
    document.getElementById('req-count-label').textContent = 'Loading…';
    document.getElementById('req-list').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.85rem"><span class="spinner"></span></div>';
    try {
        const r = await fetch(`${API_BASE}/api/admin/student-requests`, { credentials: 'include', cache: 'no-store' });
        _studentRequests = await r.json();
        renderRequestsList();
        updateRequestsBadge(_studentRequests.length);
    } catch (e) {
        document.getElementById('req-list').innerHTML = `<div style="text-align:center;padding:40px;color:var(--error);font-size:0.84rem">Failed to load: ${e.message}</div>`;
    }
}

function updateRequestsBadge(count) {
    const badge = document.getElementById('requestsBadge');
    if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-flex';
    } else {
        badge.style.display = 'none';
    }
}

function renderRequestsList() {
    const list = document.getElementById('req-list');
    const countLabel = document.getElementById('req-count-label');
    const approveAllBtn = document.getElementById('req-approve-all-btn');

    if (!_studentRequests.length) {
        list.innerHTML = `
                    <div style="text-align:center;padding:60px 20px;color:var(--text-muted)">
                        <div style="font-size:2.5rem;margin-bottom:12px">🎉</div>
                        <div style="font-size:0.92rem;font-weight:700;color:var(--text);margin-bottom:6px">No Pending Requests</div>
                        <div style="font-size:0.8rem">All caught up! New requests from students will appear here.</div>
                    </div>`;
        countLabel.textContent = '0 pending requests';
        approveAllBtn.style.display = 'none';
        return;
    }

    countLabel.textContent = `${_studentRequests.length} pending request${_studentRequests.length !== 1 ? 's' : ''}`;
    approveAllBtn.style.display = '';

    list.innerHTML = _studentRequests.map(req => {
        const time = req.requestedAt ? new Date(req.requestedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
        return `
                <div class="req-card" id="reqcard-${req.id}">
                    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
                        <div>
                            <div class="req-card-roll">📋 ${req.rollNumber}</div>
                            <div class="req-card-name">${req.name || '—'}</div>
                        </div>
                        <div style="background:rgba(243,185,111,0.12);border:1px solid rgba(243,185,111,0.28);border-radius:20px;padding:3px 10px;font-size:0.7rem;font-weight:700;color:var(--warn);white-space:nowrap;flex-shrink:0">⏳ Pending</div>
                    </div>
                    <div class="req-card-meta">
                        ${req.className ? `<span>🎓 ${req.className}</span>` : ''}
                        ${req.phone ? `<span>📞 ${req.phone}</span>` : ''}
                        ${req.age ? `<span>🎂 Age ${req.age}</span>` : ''}
                        ${req.dateOfBirth ? `<span>📅 ${req.dateOfBirth}</span>` : ''}
                    </div>
                    <div class="req-card-time">Requested: ${time}</div>
                    <div class="req-card-actions">
                        <button onclick="approveRequest(${req.id},'${req.rollNumber.replace(/'/g, "\\'")}','reqcard-${req.id}')"
                            style="flex:1;padding:8px;background:rgba(46,210,180,0.1);border:1.5px solid rgba(46,210,180,0.3);border-radius:9px;color:var(--success);cursor:pointer;font-size:0.82rem;font-weight:700;font-family:inherit;transition:all 0.15s;display:flex;align-items:center;justify-content:center;gap:5px"
                            onmouseover="this.style.background='rgba(46,210,180,0.2)'" onmouseout="this.style.background='rgba(46,210,180,0.1)'">
                            ✓ Approve
                        </button>
                        <button onclick="rejectRequest(${req.id},'${req.rollNumber.replace(/'/g, "\\'")}','reqcard-${req.id}')"
                            style="flex:1;padding:8px;background:rgba(239,68,68,0.08);border:1.5px solid rgba(239,68,68,0.25);border-radius:9px;color:var(--error);cursor:pointer;font-size:0.82rem;font-weight:700;font-family:inherit;transition:all 0.15s;display:flex;align-items:center;justify-content:center;gap:5px"
                            onmouseover="this.style.background='rgba(239,68,68,0.16)'" onmouseout="this.style.background='rgba(239,68,68,0.08)'">
                            ✕ Reject
                        </button>
                    </div>
                </div>`;
    }).join('');
}

async function approveRequest(id, roll, cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const password = await showPasswordPromptModal("Assign Password", "Set credentials for request approval", roll);
    if (password === null) return;
    if (!validatePasswordComplexity(password)) {
        if (typeof showToast === 'function') {
            showToast("Password must contain at least 6 characters, including a letter, a number, and a special character.", "error");
        } else {
            alert("Password must contain at least 6 characters, including a letter, a number, and a special character.");
        }
        return;
    }
    const actionsEl = card.querySelector('.req-card-actions');
    actionsEl.innerHTML = `<div style="flex:1;text-align:center;padding:8px;font-size:0.82rem;color:var(--text-muted);display:flex;align-items:center;justify-content:center;gap:6px"><span class="spinner" style="width:13px;height:13px;border-width:2px"></span> Approving…</div>`;
    try {
        const r = await fetch(`${API_BASE}/api/admin/student-requests/${id}/approve`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        if (!r.ok) throw new Error('Failed');
        // Animate card out
        card.style.background = 'rgba(46,210,180,0.08)';
        card.style.borderColor = 'rgba(46,210,180,0.4)';
        actionsEl.innerHTML = `<div style="flex:1;text-align:center;padding:8px;font-size:0.82rem;color:var(--success);font-weight:700">✓ Approved — ${roll} added!</div>`;
        setTimeout(() => {
            card.style.transition = 'all 0.25s ease';
            card.style.opacity = '0'; card.style.transform = 'scale(0.95)';
            setTimeout(() => { card.remove(); _studentRequests = _studentRequests.filter(r => r.id !== id); updateRequestsBadge(_studentRequests.length); renderRequestsList(); }, 260);
        }, 900);
        loadRegisteredStudents();
    } catch (e) {
        actionsEl.innerHTML = `<div style="flex:1;text-align:center;padding:8px;font-size:0.8rem;color:var(--error)">✗ Failed — retry</div>`;
        setTimeout(() => renderRequestsList(), 2000);
    }
}

async function rejectRequest(id, roll, cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const actionsEl = card.querySelector('.req-card-actions');
    actionsEl.innerHTML = `<div style="flex:1;text-align:center;padding:8px;font-size:0.82rem;color:var(--text-muted);display:flex;align-items:center;justify-content:center;gap:6px"><span class="spinner" style="width:13px;height:13px;border-width:2px"></span> Rejecting…</div>`;
    try {
        const r = await fetch(`${API_BASE}/api/admin/student-requests/${id}`, { method: 'DELETE', credentials: 'include' });
        if (!r.ok) throw new Error('Failed');
        card.style.background = 'rgba(239,68,68,0.06)';
        card.style.borderColor = 'rgba(239,68,68,0.3)';
        actionsEl.innerHTML = `<div style="flex:1;text-align:center;padding:8px;font-size:0.82rem;color:var(--error);font-weight:700">✕ Rejected & removed</div>`;
        setTimeout(() => {
            card.style.transition = 'all 0.25s ease';
            card.style.opacity = '0'; card.style.transform = 'scale(0.95)';
            setTimeout(() => { card.remove(); _studentRequests = _studentRequests.filter(r => r.id !== id); updateRequestsBadge(_studentRequests.length); renderRequestsList(); }, 260);
        }, 900);
    } catch (e) {
        actionsEl.innerHTML = `<div style="flex:1;text-align:center;padding:8px;font-size:0.8rem;color:var(--error)">✗ Failed — retry</div>`;
        setTimeout(() => renderRequestsList(), 2000);
    }
}

async function approveAllRequests() {
    if (!_studentRequests.length) return;
    if (!confirm(`Approve all ${_studentRequests.length} pending request(s)?`)) return;
    document.getElementById('req-approve-all-btn').disabled = true;
    document.getElementById('req-approve-all-btn').textContent = 'Approving…';
    for (const req of [..._studentRequests]) {
        try {
            await fetch(`${API_BASE}/api/admin/student-requests/${req.id}/approve`, { method: 'POST', credentials: 'include' });
        } catch (_) { }
    }
    await loadStudentRequests();
    loadRegisteredStudents();
    document.getElementById('req-approve-all-btn').disabled = false;
}

// Poll for new requests every 60s when students section is active
setInterval(() => {
    if (document.getElementById('section-students')?.classList.contains('active') ||
        document.getElementById('req-panel')?.classList.contains('open')) {
        fetch(`${API_BASE}/api/admin/student-requests`, { credentials: 'include', cache: 'no-store' })
            .then(r => r.json()).then(data => updateRequestsBadge(data.length)).catch(() => { });
    }
}, 60000);

/* ── Add Students Popup ─────────────────────────────── */
function injectAddStuStyles() {
    if (document.getElementById('addstu-responsive-styles')) return;
    const style = document.createElement('style');
    style.id = 'addstu-responsive-styles';
    style.textContent = `
        .addstu-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            animation: addstuRowIn 0.18s ease;
        }
        .addstu-row-idx {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background: var(--bg-input);
            border: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.7rem;
            font-weight: 700;
            color: var(--text-muted);
            flex-shrink: 0;
        }
        .addstu-row-inputs {
            display: flex;
            flex-wrap: wrap;
            flex: 1;
            gap: 8px;
            min-width: 0;
        }
        .addstu-row-inputs input {
            flex: 1 1 130px;
            min-width: 110px;
            background: var(--bg-input);
            border: 1.5px solid var(--border);
            border-radius: 9px;
            padding: 10px 13px;
            color: var(--text);
            font-size: 0.88rem;
            font-family: inherit;
            outline: none;
            transition: border-color 0.15s, box-shadow 0.15s;
        }
        .addstu-row-remove {
            width: 30px;
            height: 30px;
            border-radius: 8px;
            border: 1.5px solid rgba(239, 68, 68, 0.35);
            background: rgba(239, 68, 68, 0.08);
            color: #ef4444;
            cursor: pointer;
            font-size: 1rem;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            transition: all 0.15s;
        }
        
        @media (max-width: 480px) {
            .addstu-row {
                align-items: stretch;
            }
            .addstu-row-inputs {
                flex-direction: column;
                gap: 6px;
            }
            .addstu-row-idx {
                align-self: flex-start;
                margin-top: 8px;
            }
            .addstu-row-remove {
                align-self: flex-start;
                margin-top: 8px;
            }
        }

        /* Custom Password Prompt Modal Styles */
        #custom-pwd-prompt-overlay {
            display: flex;
            position: fixed;
            inset: 0;
            z-index: 99999;
            background: rgba(0, 0, 0, 0.55);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            align-items: center;
            justify-content: center;
            padding: 20px;
            animation: pwdFadeIn 0.2s ease-out;
        }

        .pwd-prompt-card {
            background: var(--bg-card);
            border: 1.5px solid var(--border);
            border-radius: 20px;
            width: 100%;
            max-width: 380px;
            box-shadow: var(--shadow-modal);
            animation: pwdPopIn 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
            overflow: hidden;
        }

        @keyframes pwdFadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        @keyframes pwdPopIn {
            from { transform: scale(0.9) translateY(10px); opacity: 0; }
            to { transform: scale(1) translateY(0); opacity: 1; }
        }
    `;
    document.head.appendChild(style);
}

function openAddStudentsPopup() {
    injectAddStuStyles();
    // Reset rows
    const container = document.getElementById('addstu-rows');
    container.innerHTML = '';
    _addStuRowCount = 0;
    addStuRow();
    document.getElementById('addstu-overlay').style.display = 'flex';
    // focus first input
    setTimeout(() => container.querySelector('input')?.focus(), 80);
}

function closeAddStudentsPopup() {
    document.getElementById('addstu-overlay').style.display = 'none';
}

let _addStuRowCount = 0;

function validatePasswordComplexity(password) {
    if (!password || password.length < 6) return false;
    const hasLetter = /[a-zA-Z]/.test(password);
    const hasDigit = /\d/.test(password);
    const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);
    return hasLetter && hasDigit && hasSpecial;
}

function showPasswordPromptModal(title, subtitle, roll) {
    return new Promise((resolve) => {
        injectAddStuStyles(); // ensures animations are loaded
        
        let existing = document.getElementById('custom-pwd-prompt-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'custom-pwd-prompt-overlay';

        overlay.innerHTML = `
            <div class="pwd-prompt-card">
                <!-- Header -->
                <div style="padding:22px 24px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">
                    <div style="width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 4px 14px var(--accent-glow)">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                        </svg>
                    </div>
                    <div style="flex:1">
                        <div style="font-size:1rem;font-weight:800;color:var(--text)">${title}</div>
                        <div style="font-size:0.75rem;color:var(--text-muted);margin-top:1px">${subtitle}</div>
                    </div>
                    <button id="pwd-prompt-close" style="width:30px;height:30px;border-radius:8px;border:1px solid var(--border);background:var(--bg-input);color:var(--text-muted);cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center;transition:all 0.15s">✕</button>
                </div>
                <!-- Body -->
                <div style="padding:20px 24px">
                    <div style="margin-bottom:10px;font-size:0.85rem;color:var(--text);font-weight:600">Assign password for student: <span style="font-family:var(--font-mono, monospace);color:var(--accent);font-weight:700">${roll}</span></div>
                    <div style="position:relative;display:flex;align-items:center">
                        <input type="password" id="pwd-prompt-input" placeholder="Enter password" autocomplete="new-password"
                            style="width:100%;background:var(--bg-input);border:1.5px solid var(--border);border-radius:10px;padding:11px 40px 11px 13px;color:var(--text);font-size:0.9rem;font-family:inherit;outline:none;transition:border-color 0.15s,box-shadow 0.15s">
                        <button id="pwd-prompt-toggle" type="button" style="position:absolute;right:10px;background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1.1rem;display:flex;align-items:center;justify-content:center;padding:4px;outline:none">👁️</button>
                    </div>
                    
                    <!-- Live rules checklist -->
                    <div style="margin-top:14px;background:rgba(0,0,0,0.02);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:0.76rem;color:var(--text-muted)">
                        <div style="font-weight:700;margin-bottom:6px;color:var(--text)">Password Requirements:</div>
                        <div id="rule-len" style="display:flex;align-items:center;gap:6px;margin-bottom:4px;transition:color 0.15s">❌ Min 6 characters</div>
                        <div id="rule-let" style="display:flex;align-items:center;gap:6px;margin-bottom:4px;transition:color 0.15s">❌ At least 1 letter (a-z, A-Z)</div>
                        <div id="rule-num" style="display:flex;align-items:center;gap:6px;margin-bottom:4px;transition:color 0.15s">❌ At least 1 number (0-9)</div>
                        <div id="rule-spe" style="display:flex;align-items:center;gap:6px;transition:color 0.15s">❌ At least 1 special character</div>
                    </div>
                </div>
                <!-- Footer -->
                <div style="padding:14px 24px 20px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid var(--border)">
                    <button id="pwd-prompt-cancel" style="padding:10px 20px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:10px;color:var(--text);cursor:pointer;font-size:0.85rem;font-weight:600;font-family:inherit;transition:all 0.15s">Cancel</button>
                    <button id="pwd-prompt-submit" disabled style="padding:10px 22px;background:linear-gradient(135deg,var(--accent),var(--accent-2));border:none;border-radius:10px;color:#fff;cursor:pointer;font-size:0.85rem;font-weight:700;font-family:inherit;opacity:0.5;cursor:not-allowed;box-shadow:0 2px 14px var(--accent-glow);display:flex;align-items:center;gap:6px;transition:all 0.15s">Confirm</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const input = overlay.querySelector('#pwd-prompt-input');
        const submitBtn = overlay.querySelector('#pwd-prompt-submit');
        const cancelBtn = overlay.querySelector('#pwd-prompt-cancel');
        const closeBtn = overlay.querySelector('#pwd-prompt-close');
        const toggleBtn = overlay.querySelector('#pwd-prompt-toggle');

        const ruleLen = overlay.querySelector('#rule-len');
        const ruleLet = overlay.querySelector('#rule-let');
        const ruleNum = overlay.querySelector('#rule-num');
        const ruleSpe = overlay.querySelector('#rule-spe');

        cancelBtn.addEventListener('mouseover', () => cancelBtn.style.borderColor = 'var(--border-focus)');
        cancelBtn.addEventListener('mouseout', () => cancelBtn.style.borderColor = 'var(--border)');
        closeBtn.addEventListener('mouseover', () => closeBtn.style.color = 'var(--text)');
        closeBtn.addEventListener('mouseout', () => closeBtn.style.color = 'var(--text-muted)');

        toggleBtn.addEventListener('click', () => {
            if (input.type === 'password') {
                input.type = 'text';
                toggleBtn.textContent = '🙈';
            } else {
                input.type = 'password';
                toggleBtn.textContent = '👁️';
            }
        });

        input.addEventListener('focus', () => {
            input.style.borderColor = 'var(--border-focus)';
            input.style.boxShadow = '0 0 0 3px var(--accent-glow)';
        });
        input.addEventListener('blur', () => {
            input.style.borderColor = 'var(--border)';
            input.style.boxShadow = 'none';
        });

        function updateValidation() {
            const val = input.value;
            const meetsLen = val.length >= 6;
            const meetsLet = /[a-zA-Z]/.test(val);
            const meetsNum = /\d/.test(val);
            const meetsSpe = /[!@#$%^&*(),.?":{}|<>]/.test(val);

            function setRuleState(el, passed, text) {
                if (passed) {
                    el.innerHTML = `✓ ${text}`;
                    el.style.color = 'var(--success)';
                } else {
                    el.innerHTML = `❌ ${text}`;
                    el.style.color = 'var(--text-muted)';
                }
            }

            setRuleState(ruleLen, meetsLen, 'Min 6 characters');
            setRuleState(ruleLet, meetsLet, 'At least 1 letter (a-z, A-Z)');
            setRuleState(ruleNum, meetsNum, 'At least 1 number (0-9)');
            setRuleState(ruleSpe, meetsSpe, 'At least 1 special character');

            const allPassed = meetsLen && meetsLet && meetsNum && meetsSpe;
            submitBtn.disabled = !allPassed;
            if (allPassed) {
                submitBtn.style.opacity = '1';
                submitBtn.style.cursor = 'pointer';
            } else {
                submitBtn.style.opacity = '0.5';
                submitBtn.style.cursor = 'not-allowed';
            }
        }

        input.addEventListener('input', updateValidation);

        function doSubmit() {
            if (submitBtn.disabled) return;
            const password = input.value;
            cleanup();
            resolve(password);
        }

        function doCancel() {
            cleanup();
            resolve(null);
        }

        function cleanup() {
            overlay.remove();
        }

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                doSubmit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                doCancel();
            }
        });

        submitBtn.addEventListener('click', doSubmit);
        cancelBtn.addEventListener('click', doCancel);
        closeBtn.addEventListener('click', doCancel);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) doCancel();
        });

        setTimeout(() => input.focus(), 100);
    });
}

function addStuRow(focusNew = false) {
    _addStuRowCount++;
    const id = `addstu-row-${_addStuRowCount}`;
    const rowId = _addStuRowCount;
    const container = document.getElementById('addstu-rows');
    const row = document.createElement('div');
    row.id = id;
    row.className = 'addstu-row';
    // Five details per student. No password field: students sign in with a
    // one-time code emailed to them, so the email address is the login identity.
    const _fx = "onfocus=\"this.style.borderColor='var(--border-focus)';this.style.boxShadow='0 0 0 3px var(--accent-glow)'\" onblur=\"this.style.borderColor='var(--border)';this.style.boxShadow='none'\" onkeydown=\"addStuInputKeydown(event, this)\"";
    row.innerHTML = `
                <div class="addstu-row-idx">${rowId}</div>
                <div class="addstu-row-inputs">
                    <input type="text" placeholder="Full Name" autocomplete="off" class="addstu-name" ${_fx}>
                    <input type="text" placeholder="Class" autocomplete="off" class="addstu-class" ${_fx}>
                    <input type="text" placeholder="Section" autocomplete="off" class="addstu-section" ${_fx}>
                    <input type="tel" placeholder="Mobile (10 digits)" autocomplete="off" class="addstu-mobile" maxlength="14" ${_fx}>
                    <input type="email" placeholder="Email (used to log in)" autocomplete="off" spellcheck="false" class="addstu-email" ${_fx}>
                </div>
                <button class="addstu-row-remove" onclick="removeStuRow('${id}')" title="Remove">×</button>
            `;
    container.appendChild(row);
    if (focusNew) {
        setTimeout(() => row.querySelector('input')?.focus(), 60);
    }
}

function removeStuRow(rowId) {
    const el = document.getElementById(rowId);
    if (!el) return;
    const rows = document.querySelectorAll('#addstu-rows > div');
    if (rows.length <= 1) {
        // Never remove the only row — just blank it out.
        el.querySelectorAll('input').forEach(i => { i.value = ''; i.style.borderColor = 'var(--border)'; });
        el.querySelector('input')?.focus();
        return;
    }
    el.style.animation = 'addstuRowOut 0.15s ease forwards';
    setTimeout(() => el.remove(), 140);
}

function addStuInputKeydown(e, input) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const allInputs = [...document.querySelectorAll('#addstu-rows input')];
        const idx = allInputs.indexOf(input);
        if (idx === allInputs.length - 1) {
            addStuRow(true);
        } else {
            allInputs[idx + 1]?.focus();
        }
    }
}

async function submitAddStudents() {
    const rows = [...document.querySelectorAll('#addstu-rows > div')];
    const students = [];
    const problems = [];

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    const seenEmails = new Set();

    rows.forEach((row, i) => {
        const get = cls => row.querySelector(cls);
        const fields = {
            name: get('.addstu-name'),
            className: get('.addstu-class'),
            section: get('.addstu-section'),
            mobile: get('.addstu-mobile'),
            email: get('.addstu-email'),
        };
        if (!fields.name) return;

        const vals = {
            name: (fields.name.value || '').trim(),
            className: (fields.className.value || '').trim(),
            section: (fields.section.value || '').trim().toUpperCase(),
            mobile: (fields.mobile.value || '').replace(/\D/g, ''),
            email: (fields.email.value || '').trim().toLowerCase(),
        };

        // Completely blank rows are ignored, not reported as errors.
        const touched = Object.values(vals).some(v => v);
        Object.values(fields).forEach(f => { f.style.borderColor = 'var(--border)'; });
        if (!touched) return;

        let bad = false;
        const flag = key => { fields[key].style.borderColor = 'var(--error)'; bad = true; };

        ['name', 'className', 'section', 'mobile', 'email'].forEach(k => { if (!vals[k]) flag(k); });
        if (bad) { problems.push(`Row ${i + 1}: all five details are required`); return; }

        if (!EMAIL_RE.test(vals.email)) { flag('email'); problems.push(`Row ${i + 1}: "${vals.email}" is not a valid email`); return; }
        if (vals.mobile.length !== 10) { flag('mobile'); problems.push(`Row ${i + 1}: mobile must be 10 digits`); return; }
        if (seenEmails.has(vals.email)) { flag('email'); problems.push(`Row ${i + 1}: ${vals.email} is repeated`); return; }

        seenEmails.add(vals.email);
        students.push(vals);
    });

    if (problems.length) {
        alert("Please fix these rows:\n\n• " + problems.join("\n• "));
        return;
    }

    if (!students.length) {
        alert("Please enter at least one student's name, class, section, mobile and email.");
        return;
    }

    closeAddStudentsPopup();
    showAddStuProgress(students);
}

async function showAddStuProgress(students) {
    const overlay = document.getElementById('addstu-progress-overlay');
    const bar = document.getElementById('addstu-progress-bar');
    const label = document.getElementById('addstu-progress-label');
    const countEl = document.getElementById('addstu-progress-count');
    overlay.style.display = 'flex';
    bar.style.width = '0%';
    label.textContent = 'Preparing…';
    countEl.textContent = `0 / ${students.length}`;

    let fakeProgress = 0;
    const fakeInterval = setInterval(() => {
        if (fakeProgress < 60) { fakeProgress += 4; bar.style.width = fakeProgress + '%'; }
    }, 120);

    try {
        label.textContent = 'Sending to server…';
        const r = await fetch(`${API_BASE}/api/admin/registered-students/add`, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ students }),
        });
        const data = await r.json();
        clearInterval(fakeInterval);
        if (!r.ok) throw new Error(data.error || "Failed");

        label.textContent = 'Saving records…';
        bar.style.transition = 'width 0.4s ease';
        bar.style.width = '90%';
        await new Promise(res => setTimeout(res, 350));
        bar.style.width = '100%';
        countEl.textContent = `${data.added} / ${students.length}`;
        label.textContent = `✓ Done! Added ${data.added}${data.skipped ? `, ${data.skipped} skipped` : ''}${data.invalid ? `, ${data.invalid} invalid` : ''}`;
        bar.style.background = 'linear-gradient(90deg, var(--success), #63f5c8)';

        await new Promise(res => setTimeout(res, 1100));
        overlay.style.display = 'none';
        bar.style.background = '';
        bar.style.transition = '';
        loadRegisteredStudents();
    } catch (e) {
        clearInterval(fakeInterval);
        bar.style.width = '100%';
        bar.style.background = 'linear-gradient(90deg,#ef4444,#f87171)';
        label.textContent = '✗ Error: ' + (e.message || 'Failed');
        await new Promise(res => setTimeout(res, 2000));
        overlay.style.display = 'none';
        bar.style.background = '';
    }
}

/* ── Delete Student (custom popup) ──────────────────── */
let _pendingDeleteStuId = null, _pendingDeleteStuRoll = '';

function deleteRegisteredStudent(id, roll) {
    _pendingDeleteStuId = id;
    _pendingDeleteStuRoll = roll;
    document.getElementById('del-stu-roll-name').textContent = roll;
    document.getElementById('del-stu-progress-wrap').style.display = 'none';
    document.getElementById('del-stu-progress-bar').style.width = '0%';
    document.getElementById('del-stu-actions').style.display = 'flex';
    document.getElementById('del-stu-overlay').style.display = 'flex';
}

function closeDelStuPopup() {
    document.getElementById('del-stu-overlay').style.display = 'none';
    _pendingDeleteStuId = null;
}

async function resetStudentPassword(id, roll) {
    const password = await showPasswordPromptModal("Reset Password", "Change student credentials", roll);
    if (password === null) return;
    if (!validatePasswordComplexity(password)) {
        if (typeof showToast === 'function') {
            showToast("Password must contain at least 6 characters, including a letter, a number, and a special character.", "error");
        } else {
            alert("Password must contain at least 6 characters, including a letter, a number, and a special character.");
        }
        return;
    }
    try {
        const r = await fetch(`${API_BASE}/api/admin/registered-students/${id}/reset-password`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Failed to reset password");
        if (typeof showToast === 'function') {
            showToast("Password reset successfully for student: " + roll, "success");
        } else {
            alert("Password reset successfully for student: " + roll);
        }
    } catch (e) {
        if (typeof showToast === 'function') {
            showToast("Error resetting password: " + e.message, "error");
        } else {
            alert("Error resetting password: " + e.message);
        }
    }
}

async function confirmDeleteStudent() {
    if (!_pendingDeleteStuId) return;
    const bar = document.getElementById('del-stu-progress-bar');
    const wrap = document.getElementById('del-stu-progress-wrap');
    const label = document.getElementById('del-stu-progress-label');
    const actions = document.getElementById('del-stu-actions');
    actions.style.display = 'none';
    wrap.style.display = 'block';
    bar.style.width = '0%';
    label.textContent = 'Deleting…';

    // fake progress
    let p = 0;
    const iv = setInterval(() => { if (p < 75) { p += 8; bar.style.width = p + '%'; } }, 80);

    try {
        await fetch(`${API_BASE}/api/admin/registered-students/${_pendingDeleteStuId}`, { method: "DELETE", credentials: "include" });
        clearInterval(iv);
        bar.style.width = '100%';
        label.textContent = '✓ Removed';
        bar.style.background = 'linear-gradient(90deg,#ef4444,#f87171)';
        await new Promise(r => setTimeout(r, 700));
        closeDelStuPopup();
        bar.style.background = '';
        loadRegisteredStudents();
    } catch (e) {
        clearInterval(iv);
        label.textContent = '✗ Failed: ' + e.message;
        bar.style.width = '100%';
        bar.style.background = 'linear-gradient(90deg,#ef4444,#f87171)';
        await new Promise(r => setTimeout(r, 1800));
        wrap.style.display = 'none';
        actions.style.display = 'flex';
    }
}

async function addRegisteredStudents() {
    // legacy stub — now handled by popup
    submitAddStudents();
}

function exportRegisteredStudentsCSV() {
    const safeCell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["Roll Number", "Name", "Class", "Section", "Email", "Phone", "Age", "Date of Birth", "Status"].map(safeCell).join(",")];
    _allRegisteredStudents.forEach(s => {
        lines.push([s.rollNumber, s.name, s.className, s.section, s.email, s.phone, s.age, s.dateOfBirth, s.profileComplete ? "Registered" : "Pending"].map(safeCell).join(","));
    });
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "registered_students.csv"; a.click();
}


/* ══════════════════════════════════════════════════════════════════
   FIX DB
══════════════════════════════════════════════════════════════════ */
async function reloadCache() {
    const st = document.getElementById("cacheStatus");
    st.innerHTML = '<span class="spinner"></span>&nbsp; Reloading...';
    try {
        const r = await fetch(`${API_BASE}/api/admin/reload-cache`, { method: "POST", credentials: "include" });
        const d = await r.json();
        st.innerHTML = `<div style="padding:12px 14px;background:rgba(6,214,160,0.08);border:1px solid rgba(6,214,160,0.2);border-radius:var(--radius-sm);color:var(--success);font-size:0.82rem;margin-top:4px">✅ Cache reloaded — ${d.cached} question(s) cached.</div>`;
    } catch (e) { st.innerHTML = `<div style="color:var(--error)">Error: ${e.message}</div>`; }
}

async function scanCorrupted() {
    const st = document.getElementById("migrateStatus"), res = document.getElementById("migrateResults");
    st.innerHTML = '<span class="spinner"></span>&nbsp; Scanning...'; res.innerHTML = "";
    try {
        const r = await fetch(`${API_BASE}/api/admin/migrate`, { credentials: "include" });
        const data = await r.json();
        st.innerHTML = "";
        if (data.corrupted === 0) {
            res.innerHTML = `<div style="padding:12px;background:rgba(6,214,160,0.08);border:1px solid rgba(6,214,160,0.2);border-radius:var(--radius-sm);color:var(--success);font-size:0.82rem">✅ No corrupted records.</div>`;
            document.getElementById("deleteCorruptedBtn").classList.add("hidden");
        } else {
            const rows = data.corruptedLectures.map(l => `<tr><td>${l.chapter || "none"}</td><td>L${l.lecture}</td><td style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;opacity:0.5">${l._id}</td></tr>`).join("");
            res.innerHTML = `<div style="padding:12px;background:rgba(242,92,92,0.08);border:1px solid rgba(242,92,92,0.2);border-radius:var(--radius-sm);color:var(--error);margin-bottom:12px;font-size:0.82rem">⚠️ Found <strong>${data.corrupted}</strong> corrupted record(s).</div><div class="table-wrap"><table><thead><tr><th>Chapter</th><th>Lecture</th><th>ID</th></tr></thead><tbody>${rows}</tbody></table></div>`;
            document.getElementById("deleteCorruptedBtn").classList.remove("hidden");
        }
    } catch (e) { st.innerHTML = `<div style="color:var(--error)">Error: ${e.message}</div>`; }
}

async function deleteCorrupted() {
    askConfirmModal({
        title: "Delete corrupted records?",
        text: "Permanently delete corrupted records? This cannot be undone.",
        confirmText: "Delete",
        onConfirm: async () => {
            const st = document.getElementById("migrateStatus");
            st.innerHTML = '<span class="spinner"></span>&nbsp; Deleting...';
            try {
                const r = await fetch(`${API_BASE}/api/admin/migrate`, { method: "POST", credentials: "include" });
                const data = await r.json();
                st.innerHTML = "";
                document.getElementById("migrateResults").innerHTML = `<div style="padding:12px;background:rgba(6,214,160,0.08);border:1px solid rgba(6,214,160,0.2);border-radius:var(--radius-sm);color:#057a55;font-size:0.82rem">✅ ${data.message}</div>`;
                document.getElementById("deleteCorruptedBtn").classList.add("hidden");
                await loadQuestionsAdmin();
            } catch (e) { st.innerHTML = `<div style="color:var(--error)">Error: ${e.message}</div>`; }
        }
    });
}


/* ══════════════════════════════════════════════════════════════════
   DRAG TO SELECT
══════════════════════════════════════════════════════════════════ */
// Drag-selection lasso removed per request
/* ══════════════════════════════════════════════════════════════════
   PWA
══════════════════════════════════════════════════════════════════ */
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        const isInstitute = window.location.pathname.includes("institute.html") || window.location.pathname.includes("institute");
        const swUrl = isInstitute ? "institute-sw.js" : "developer-sw.js";
        navigator.serviceWorker.register(swUrl)
            .then(r => console.log("SW:", r.scope))
            .catch(e => console.warn("SW failed:", e));
    });
}


let _dip = null;
window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault(); _dip = e;
    const isInstitute = window.location.pathname.includes("institute.html") || window.location.pathname.includes("institute");
    const appName = isInstitute ? "Triumph Educator" : "Vyorra Developer";
    const b = document.createElement("div");
    b.id = "installBanner";
    b.style.cssText = "position:fixed;bottom:76px;left:50%;transform:translateX(-50%);background:var(--bg-card);border:1px solid rgba(91,95,239,0.3);border-radius:14px;padding:14px 18px;display:flex;align-items:center;gap:12px;z-index:9000;box-shadow:0 8px 32px rgba(0,0,0,0.5);max-width:340px;width:calc(100% - 32px);animation:slideUp 0.3s ease";
    b.innerHTML = `<img src="triumph.png" style="width:28px;height:28px;object-fit:contain;border-radius:6px"><div style="flex:1"><div style="font-weight:700;font-size:0.88rem">Install ${appName}</div><div style="font-size:0.74rem;color:var(--text-dim);margin-top:2px">Add to Home Screen</div></div><div style="display:flex;gap:6px"><button onclick="installApp()" class="btn btn-primary" style="padding:7px 12px;font-size:0.8rem">Install</button><button onclick="dismissInstall()" class="btn btn-ghost" style="padding:7px 10px;font-size:0.8rem">✕</button></div>`;
    document.body.appendChild(b);
});
async function installApp() { if (!_dip) return; _dip.prompt(); await _dip.userChoice; _dip = null; dismissInstall(); }
function dismissInstall() { document.getElementById("installBanner")?.remove(); }
window.addEventListener("appinstalled", () => { dismissInstall(); _dip = null; });


/* ═══════════════════════════════════════════════════════════════════
   STAR QUIZ SECTION — Data & Rendering
═══════════════════════════════════════════════════════════════════ */
let _sqAllQuestions = [];   // all star_quiz question sets from API
let _sqCurrentChapter = null;
let _sqCurrentLecture = null;
let _sqNavList = [];        // [{chapter, lecture}] for prev/next
let _sqNavIdx = -1;

// ── Select-mode state ──
let _sqSelectModeOn = false;
let _sqSelectedChapters = new Set();   // chapter names
let _sqLecSelectModeOn = false;
let _sqSelectedLectures = new Set();   // "chapter::lecture" keys
let _sqQSelectModeOn = false;
let _sqSelectedQuestions = new Set();  // question indices (strings)

function escapeHtml(str) {
    return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function loadStarQuizData() {
    try {
        const r = await fetch(`${API_BASE}/api/admin/star-quiz/questions`, { credentials: "include" });
        if (!r.ok) return;
        _sqAllQuestions = await r.json();
    } catch (e) { console.error("STAR Quiz load error:", e); }
}

function sqShowChapterView(pushHistory = true) {
    document.getElementById("sq-chapter-view").style.display = "";
    document.getElementById("sq-lecture-view").style.display = "none";
    document.getElementById("sq-question-cards-view").style.display = "none";
    document.getElementById("sq-question-view").style.display = "none";
    sqRenderChapters(_sqAllQuestions);
    if (pushHistory) history.pushState({ type: "sqChapter" }, "", "");
}

function sqShowLectureView(pushHistory = true) {
    document.getElementById("sq-chapter-view").style.display = "none";
    document.getElementById("sq-lecture-view").style.display = "";
    document.getElementById("sq-question-cards-view").style.display = "none";
    document.getElementById("sq-question-view").style.display = "none";
    sqRenderLectures(_sqCurrentChapter);
    if (pushHistory) history.pushState({ type: "sqLecture", chapter: _sqCurrentChapter }, "", "");
}

function sqShowQuestionCards(chapter, lecture, pushHistory = true) {
    _sqCurrentChapter = chapter;
    _sqCurrentLecture = lecture;
    // Reset select mode on navigation (entering a new lecture)
    _sqQSelectModeOn = false;
    _sqSelectedQuestions.clear();
    const btn = document.getElementById("sq-select-q-btn");
    if (btn) btn.textContent = "☐ Select Questions";
    const bar = document.getElementById("sq-q-mass-delete-bar");
    if (bar) bar.classList.remove("visible");
    // Show the cards view panels
    document.getElementById("sq-chapter-view").style.display = "none";
    document.getElementById("sq-lecture-view").style.display = "none";
    document.getElementById("sq-question-cards-view").style.display = "";
    document.getElementById("sq-question-view").style.display = "none";
    sqRenderQuestionCards();
    if (pushHistory) history.pushState({ type: "sqQuestionCards", chapter, lecture }, "", "");
}

function sqRenderQuestionCards() {
    const chapter = _sqCurrentChapter;
    const lecture = _sqCurrentLecture;
    const set = _sqAllQuestions.find(q => q.chapter === chapter && String(q.lecture) === String(lecture));
    if (!set) return;
    document.getElementById("sq-cards-title").textContent = `${chapter} — Lecture ${lecture}`;
    document.getElementById("sq-cards-subtitle").textContent = `${(set.questions || []).length} Question${(set.questions || []).length !== 1 ? "s" : ""}`;
    const grid = document.getElementById("sq-question-cards-grid");
    grid.innerHTML = "";
    (set.questions || []).forEach((q, i) => {
        const card = document.createElement("div");
        card.className = "lecture-card" + (_sqQSelectModeOn && _sqSelectedQuestions.has(String(i)) ? " selected-card" : "");
        card.style.cursor = "pointer";
        card.dataset.qidx = i;
        const hasImg = q.questionImage && q.questionImage.length > 0;
        const hasMulti = q.isMultiCorrect || (q.correctIndexes || []).length > 1;
        const cardIsNumerical = (q.numericalAnswer !== undefined && q.numericalAnswer !== null) || (Array.isArray(q.options) && q.options.every(function (o) { return !o || String(o).trim() === ''; }) && (!Array.isArray(q.optionImages) || q.optionImages.every(function (im) { return !im; })));
        card.innerHTML = `
                    ${_sqQSelectModeOn ? `<input type="checkbox" class="lec-checkbox" onclick="event.stopPropagation();sqToggleQuestionSelect(event,${i})" ${_sqSelectedQuestions.has(String(i)) ? "checked" : ""}>` : ""}
                    <div class="lecture-card-num" style="font-size:0.8rem;letter-spacing:0.3px">Q${i + 1}</div>
                    <div class="lecture-card-title">${(q.question || "").substring(0, 60)}${(q.question || "").length > 60 ? "…" : ""}</div>
                    <div class="lecture-card-count" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px">
                        ${cardIsNumerical
                ? `<span style="color:#a78bfa">🔢 ${escapeHtml(String(q.numericalAnswer ?? q.correct_answer ?? 'N/A'))}</span>`
                : `<span>${["A", "B", "C", "D"][(q.correctIndexes || [q.correctIndex || 0])[0]]} correct</span>`}
                    </div>`;
        card.onclick = (e) => {
            if (e.target.closest("input")) return;
            if (_sqQSelectModeOn) { sqToggleQuestionSelect(e, i); return; }
            sqOpenQuestionView(chapter, lecture, i);
        };
        grid.appendChild(card);
    });
}

async function sqDeleteCurrentLectureFromCards() {
    const confirmed = await askConfirmModalPromise({ title: "Delete Lecture", text: `Delete all questions in Lecture ${_sqCurrentLecture} of "${_sqCurrentChapter}"? This cannot be undone.`, confirmText: "Delete" });
    if (!confirmed) return;
    showDeleteProgress("Deleting...");
    const r = await fetch(`${API_BASE}/api/admin/star-quiz/question/${encodeURIComponent(_sqCurrentChapter || "")}/${encodeURIComponent(_sqCurrentLecture)}`, { method: "DELETE", credentials: "include" });
    hideDeleteProgress();
    if (r.ok) { await loadStarQuizData(); sqShowLectureView(); showSuccessModal("Deleted!", "Lecture deleted."); }
    else { showErrorModal("Delete failed. Please try again."); }
}

function sqRenderChapters(questions) {
    const grid = document.getElementById("sq-chapter-grid");
    const noQ = document.getElementById("sq-no-chapters");
    const chapMap = {};
    questions.forEach(q => {
        const ch = q.chapter || "(No Chapter)";
        if (!chapMap[ch]) chapMap[ch] = { qCount: 0, lecCount: 0 };
        chapMap[ch].qCount += (q.questions || []).length;
        chapMap[ch].lecCount += 1;
    });
    const chapters = Object.keys(chapMap).sort();
    grid.innerHTML = "";
    if (!chapters.length) { noQ.style.display = ""; grid.style.display = "none"; return; }
    noQ.style.display = "none"; grid.style.display = "";
    chapters.forEach((ch, i) => {
        const card = document.createElement("div");
        const isSelected = _sqSelectModeOn && _sqSelectedChapters.has(ch);
        card.className = "chapter-card" + (isSelected ? " selected-card" : "");
        card.style.cursor = "pointer";
        const { qCount, lecCount } = chapMap[ch];
        card.innerHTML = `
                    ${_sqSelectModeOn ? `<input type="checkbox" class="card-checkbox" onclick="event.stopPropagation();sqToggleChapterSelect(event,'${encodeURIComponent(ch)}')" ${isSelected ? "checked" : ""}>` : ""}
                    <div class="chapter-card-icon">${getChapterEmoji(ch)}</div>
                    <div style="display:flex;justify-content:space-between;align-items:center;width:100%">
                        <div class="chapter-card-title" style="margin:0">${formatChapterLabel(ch)}</div>
                        <button class="btn btn-ghost" style="padding:4px;margin-left:8px;font-size:1.1rem;min-width:unset;align-self:flex-start" title="Rename Chapter" onclick="event.stopPropagation();sqRenameChapter(event,'${encodeURIComponent(ch)}')">✏️</button>
                    </div>
                    <div class="chapter-card-count">${lecCount} Lecture${lecCount !== 1 ? "s" : ""} · ${qCount} Question${qCount !== 1 ? "s" : ""}</div>`;
        card.onclick = (e) => {
            if (_sqSelectModeOn) { sqToggleChapterSelectByName(ch); return; }
            if (e.target.closest("button") || e.target.closest("input")) return;
            _sqCurrentChapter = ch; sqShowLectureView();
        };
        grid.appendChild(card);
    });
}

function sqRenderLectures(chapter) {
    const sets = _sqAllQuestions.filter(q => (q.chapter || "(No Chapter)") === chapter);
    sets.sort((a, b) => (parseInt(a.lecture) || 0) - (parseInt(b.lecture) || 0));
    _sqNavList = sets.map(s => ({ chapter: s.chapter, lecture: s.lecture }));

    document.getElementById("sq-chapter-title").textContent = chapter;
    document.getElementById("sq-lecture-count").textContent = `${sets.length} lecture set${sets.length !== 1 ? "s" : ""}`;

    const grid = document.getElementById("sq-lecture-grid");
    grid.innerHTML = "";
    sets.forEach((s, idx) => {
        const card = document.createElement("div");
        const hasMulti = (s.questions || []).some(q => q.isMultiCorrect);
        const isSelected = _sqLecSelectModeOn && _sqSelectedLectures.has(`${s.chapter}::${s.lecture}`);
        card.className = "lecture-card" + (hasMulti ? " has-multi" : "") + (isSelected ? " selected-card" : "");
        card.style.cursor = "pointer";
        card.dataset.lec = String(s.lecture);
        card.dataset.topic = s.topic || "";
        const qCount = (s.questions || []).length;
        card.innerHTML = `
                    ${_sqLecSelectModeOn ? `<input type="checkbox" class="lec-checkbox" onclick="event.stopPropagation();sqToggleLectureSelect(event,'${encodeURIComponent(s.chapter)}','${encodeURIComponent(s.lecture)}')" ${isSelected ? "checked" : ""}>` : ""}
                    <div class="lecture-card-num">L${s.lecture}</div>
                    <div style="display:flex;justify-content:flex-end;align-items:flex-start;width:100%;gap:4px">
                        <button class="btn btn-ghost" style="padding:2px 4px;font-size:0.85rem;min-width:unset;flex-shrink:0" title="Edit Lecture" onclick="sqEditLecture(event,'${encodeURIComponent(s.chapter)}','${encodeURIComponent(s.lecture)}')">✏️</button>
                    </div>
                    <div class="lecture-card-count">${qCount} Question${qCount !== 1 ? "s" : ""}</div>`;
        card.onclick = (e) => {
            if (e.target.closest("input")) return;
            if (e.target.closest("button")) return;
            if (_sqLecSelectModeOn) {
                const fakeEvt = { stopPropagation: () => { } };
                sqToggleLectureSelect(fakeEvt, encodeURIComponent(s.chapter), encodeURIComponent(s.lecture));
                return;
            }
            _sqNavIdx = idx; sqShowQuestionCards(s.chapter, s.lecture);
        };
        grid.appendChild(card);
    });
}

// Track unsaved edits in star quiz
let _sqHasUnsavedEdits = false;
let _sqOriginalSnapshot = "";
let _sqCurrentQCardIdx = undefined;

// Track solution images during edit — keyed by question original index
// { [origIdx]: string[] }  each string is a data-URL or http URL
let _sqEditSolImages = {};

function _sqSolImgSrc(imgData) {
    if (!imgData) return "";
    if (imgData.startsWith('http://') || imgData.startsWith('https://') || imgData.startsWith('data:')) return imgData;
    return 'data:image/jpeg;base64,' + imgData;
}

// Build editable solution-image zone HTML for question index `qi`
function sqBuildSolImgEditZone(qi) {
    const imgs = _sqEditSolImages[qi] || [];
    const thumbs = imgs.map((img, ii) => `
                <div style="position:relative;display:inline-block;border-radius:var(--radius-sm);overflow:hidden;border:1px solid var(--border);background:rgba(0,0,0,0.1)">
                    <img src="${_sqSolImgSrc(img)}" alt="Solution image ${ii + 1}" style="max-width:160px;max-height:140px;display:block;object-fit:contain">
                    <button type="button" onclick="sqEditRemoveSolImage(${qi},${ii})" title="Remove image" style="position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;border:none;background:rgba(242,92,92,0.92);color:#fff;font-size:0.8rem;line-height:1;cursor:pointer">✕</button>
                </div>`).join('');
    return `
                <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px">${thumbs}</div>
                <label style="display:inline-flex;align-items:center;gap:6px;padding:7px 13px;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.3);border-radius:var(--radius-sm);font-size:0.78rem;color:#10b981;cursor:pointer;font-weight:600">
                    🖼️ ${imgs.length ? 'Add another image' : 'Add solution image'}
                    <input type="file" accept="image/*" style="display:none" onchange="sqEditAddSolImage(${qi}, this)">
                </label>`;
}

async function sqEditAddSolImage(qi, input) {
    const f = input.files && input.files[0];
    if (!f) return;
    const b64 = await impFileToB64(f);
    if (!_sqEditSolImages[qi]) _sqEditSolImages[qi] = [];
    _sqEditSolImages[qi].push(b64);
    input.value = "";
    const zone = document.getElementById(`sqSolImgZone_${qi}`);
    if (zone) zone.innerHTML = sqBuildSolImgEditZone(qi);
    _sqHasUnsavedEdits = true;
}

function sqEditRemoveSolImage(qi, ii) {
    if (Array.isArray(_sqEditSolImages[qi])) {
        _sqEditSolImages[qi].splice(ii, 1);
    }
    const zone = document.getElementById(`sqSolImgZone_${qi}`);
    if (zone) zone.innerHTML = sqBuildSolImgEditZone(qi);
    _sqHasUnsavedEdits = true;
}

function _sqGetEditSnapshot() {
    const ch = document.getElementById("sq-edit-chapter")?.value || "";
    const lec = document.getElementById("sq-edit-lecture")?.value || "";
    const containers = document.querySelectorAll("#sq-edit-questions-container > div");
    const parts = [ch, lec];
    containers.forEach((c, si) => {
        parts.push(document.getElementById(`sq_iqe_qt_${si}`)?.value || "");
        ["A", "B", "C", "D"].forEach((_, oi) => parts.push(document.getElementById(`sq_iqe_opt_${si}_${oi}`)?.value || ""));
        parts.push(document.getElementById(`sqSolEditArea_${si}`)?.value || "");
    });
    return parts.join("|");
}

// ── SQ Unsaved-changes modal helpers ──
let _sqPendingAction = null;

function sqShowUnsavedModal(message, onSave, onDiscard) {
    document.getElementById("sqUnsavedModalText").textContent = message || "You have unsaved changes. What would you like to do?";
    _sqPendingAction = { onSave, onDiscard };
    openModal("sqUnsavedModal");
}

async function sqUnsavedSave() {
    closeModal("sqUnsavedModal");
    if (!_sqPendingAction) return;
    const { onSave } = _sqPendingAction;
    _sqPendingAction = null;
    await sqSaveEdit();
    if (onSave) onSave();
}

function sqUnsavedDiscard() {
    closeModal("sqUnsavedModal");
    if (!_sqPendingAction) return;
    const { onDiscard } = _sqPendingAction;
    _sqPendingAction = null;
    _sqHasUnsavedEdits = false;
    if (onDiscard) onDiscard();
}

function sqCancelEditWithCheck() {
    const snapshotChanged = _sqOriginalSnapshot !== _sqGetEditSnapshot();
    if (_sqHasUnsavedEdits || snapshotChanged) {
        sqShowUnsavedModal(
            "You have unsaved changes. What would you like to do?",
            () => sqShowQuestionCards(_sqCurrentChapter, _sqCurrentLecture),
            () => sqShowQuestionCards(_sqCurrentChapter, _sqCurrentLecture)
        );
    } else {
        sqShowQuestionCards(_sqCurrentChapter, _sqCurrentLecture);
    }
}

function sqNavigate(dir) {
    const set = _sqAllQuestions.find(q => q.chapter === _sqCurrentChapter && String(q.lecture) === String(_sqCurrentLecture));
    if (!set) return;
    const total = (set.questions || []).length;
    const newIdx = Math.max(0, Math.min(total - 1, (_sqCurrentQCardIdx ?? 0) + dir));
    if (newIdx === (_sqCurrentQCardIdx ?? 0)) return;
    const snapshotChanged = _sqOriginalSnapshot !== _sqGetEditSnapshot();
    if (_sqIsEditMode && (_sqHasUnsavedEdits || snapshotChanged)) {
        const direction = dir > 0 ? "next" : "previous";
        sqShowUnsavedModal(
            `You have unsaved changes. Save before going to the ${direction} question?`,
            () => sqOpenQuestionView(_sqCurrentChapter, _sqCurrentLecture, newIdx),
            () => sqOpenQuestionView(_sqCurrentChapter, _sqCurrentLecture, newIdx)
        );
    } else {
        sqOpenQuestionView(_sqCurrentChapter, _sqCurrentLecture, newIdx);
    }
}

// Arrow-key navigation for SQ question view
document.addEventListener("keydown", function (e) {
    const qView = document.getElementById("sq-question-view");
    if (!qView || qView.style.display === "none") return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "ArrowRight") { e.preventDefault(); sqNavigate(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); sqNavigate(-1); }
});

let _sqIsEditMode = false;

function sqOpenQuestionView(chapter, lecture, qCardIdx) {
    _sqCurrentLecture = lecture;
    _sqCurrentQCardIdx = qCardIdx;
    _sqIsEditMode = false;
    const set = _sqAllQuestions.find(q => q.chapter === chapter && q.lecture === lecture);
    if (!set) return;

    document.getElementById("sq-chapter-view").style.display = "none";
    document.getElementById("sq-lecture-view").style.display = "none";
    document.getElementById("sq-question-cards-view").style.display = "none";
    document.getElementById("sq-question-view").style.display = "";

    const qTotal = (set.questions || []).length;
    const qLabel = qCardIdx !== undefined ? `Question ${qCardIdx + 1} of ${qTotal}` : `${qTotal} Question${qTotal !== 1 ? "s" : ""}`;
    document.getElementById("sq-question-title").textContent = `${chapter} — Lecture ${lecture}`;
    document.getElementById("sq-question-subtitle").textContent = qLabel;

    const prevBtn = document.getElementById("sq-prev-btn");
    const nextBtn = document.getElementById("sq-next-btn");
    prevBtn.style.display = (qCardIdx !== undefined && qCardIdx > 0) ? "" : "none";
    nextBtn.style.display = (qCardIdx !== undefined && qCardIdx < qTotal - 1) ? "" : "none";

    _sqSetViewModeButtons(true);

    const content = document.getElementById("sq-question-content");
    content.innerHTML = "";

    const questionsToRender = qCardIdx !== undefined
        ? [[set.questions[qCardIdx], qCardIdx]]
        : (set.questions || []).map((q, i) => [q, i]);

    const questionsDiv = document.createElement("div");
    questionsDiv.id = "sq-edit-questions-container";
    questionsToRender.forEach(([q, i]) => {
        const ci = q.correctIndexes || [q.correctIndex || 0];
        const isMulti = q.isMultiCorrect || ci.length > 1;
        const isNumerical = (q.numericalAnswer !== undefined && q.numericalAnswer !== null) || (Array.isArray(q.options) && q.options.every(function (o) { return !o || String(o).trim() === ''; }) && (!Array.isArray(q.optionImages) || q.optionImages.every(function (im) { return !im; })));
        const hasImg = q.questionImage && q.questionImage.length > 0;
        const imgSrc = hasImg ? ((q.questionImage.startsWith('http') || q.questionImage.startsWith('data:')) ? q.questionImage : `data:image/jpeg;base64,${q.questionImage}`) : "";
        const imgHtml = hasImg ? `<div style="margin-bottom:14px;text-align:center;display:flex;justify-content:center;align-items:center;"><img src="${imgSrc}" alt="Question diagram" style="max-width:100%;max-height:280px;display:block;object-fit:contain;cursor:pointer;border-radius:var(--radius-sm)" onclick="this.style.maxHeight=this.style.maxHeight=='none'?'280px':'none'"></div>` : "";
        const LTRS = ["A", "B", "C", "D"];
        const qDiv = document.createElement("div");
        qDiv.style.cssText = "background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-bottom:14px";
        qDiv.dataset.origIdx = i;
        const layoutContent = hasImg
            ? `<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
                   <div style="flex:1.3;min-width:280px">
                       <div class="q-render-preview" id="sq_iqe_preview_${i}"></div>
                       <div style="margin-bottom:14px">
                           <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:8px">${isNumerical ? 'Answer' : 'Options'}</div>
                           ${isNumerical
                ? `<div style="padding:8px 12px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);border-radius:6px;font-size:0.82rem">
                                   <span style="font-weight:700;color:#a78bfa">Numerical Answer: </span>
                                   <span style="color:var(--text);font-weight:600;font-size:1rem">${escapeHtml(String(q.numericalAnswer ?? q.correct_answer ?? 'N/A'))}</span>
                                  </div>`
                : LTRS.map((l, oi) => `<div class="opt-render-row ${ci.includes(oi) ? "is-correct" : ""}"><span class="opt-letter">${l}</span><div id="sq_iqe_opt_render_${i}_${oi}"></div>${ci.includes(oi) ? '<span style="margin-left:auto;font-size:0.7rem;color:var(--success);font-weight:700">✓ Correct</span>' : ""}</div>`).join("")}
                       </div>
                   </div>
                   <div style="flex:0.7;min-width:280px;max-width:440px;margin-bottom:14px;align-self:stretch;display:flex;flex-direction:column;justify-content:center">
                       ${imgHtml}
                   </div>
               </div>`
            : `<div class="q-render-preview" id="sq_iqe_preview_${i}"></div>
               <div style="margin-bottom:14px">
                   <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:8px">${isNumerical ? 'Answer' : 'Options'}</div>
                   ${isNumerical
                ? `<div style="padding:8px 12px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);border-radius:6px;font-size:0.82rem">
                           <span style="font-weight:700;color:#a78bfa">Numerical Answer: </span>
                           <span style="color:var(--text);font-weight:600;font-size:1rem">${escapeHtml(String(q.numericalAnswer ?? q.correct_answer ?? 'N/A'))}</span>
                          </div>`
                : LTRS.map((l, oi) => `<div class="opt-render-row ${ci.includes(oi) ? "is-correct" : ""}"><span class="opt-letter">${l}</span><div id="sq_iqe_opt_render_${i}_${oi}"></div>${ci.includes(oi) ? '<span style="margin-left:auto;font-size:0.7rem;color:var(--success);font-weight:700">✓ Correct</span>' : ""}</div>`).join("")}
               </div>`;

        qDiv.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
                        <div style="font-size:0.7rem;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:0.6px">Question ${i + 1}${q.year && String(q.year).trim() ? ` <span style="font-size:0.68rem;background:rgba(91,95,239,0.12);color:var(--accent-2);padding:2px 7px;border-radius:20px;font-weight:700;text-transform:none;letter-spacing:normal;display:inline-flex;align-items:center;gap:3px">🏛️ ${q.exam || q.examName || q.exam_name || q.exam_label || (String(q.subject || '').toLowerCase().includes('bio') ? 'NEET' : 'JEE Main')} ${q.year}${q.month ? ' ' + q.month : ''}${(q.date || q.day) ? ' ' + (q.date || q.day) : ''}${q.shift ? ' (' + q.shift + ')' : ''}</span>` : ''}${isMulti ? ' <span style="color:var(--accent-4)">✦ Multi-correct</span>' : ""}${isNumerical ? ' <span style="color:#a78bfa">🔢 Numerical</span>' : ""}</div>
                    </div>
                    ${layoutContent}
                    <div id="sqSolBlock_${i}"></div>`;
        questionsDiv.appendChild(qDiv);
    });
    content.appendChild(questionsDiv);

    _sqHasUnsavedEdits = false;
    _sqOriginalSnapshot = null;

    setTimeout(() => {
        questionsToRender.forEach(([q, i]) => {
            const isNumerical = (q.numericalAnswer !== undefined && q.numericalAnswer !== null) || (Array.isArray(q.options) && q.options.every(function (o) { return !o || String(o).trim() === ''; }) && (!Array.isArray(q.optionImages) || q.optionImages.every(function (im) { return !im; })));
            const prev = document.getElementById(`sq_iqe_preview_${i}`);
            if (prev) { prev.textContent = q.question; if (typeof renderMath === "function") renderMath(prev); }
            if (!isNumerical) {
                ["A", "B", "C", "D"].forEach((l, oi) => {
                    const optRender = document.getElementById(`sq_iqe_opt_render_${i}_${oi}`);
                    if (optRender) {
                        const optImg = Array.isArray(q.optionImages) ? (q.optionImages[oi] || null) : null;
                        if (optImg) {
                            const imgSrc = (optImg.startsWith('http') || optImg.startsWith('data:')) ? optImg : `data:image/jpeg;base64,${optImg}`;
                            optRender.innerHTML = `<img src="${imgSrc}" alt="Option ${l}" style="max-height:80px;max-width:100%;border-radius:4px;border:1px solid var(--border);object-fit:contain;display:block;margin-top:2px">`;
                        } else {
                            optRender.textContent = (q.options && q.options[oi]) || "";
                            if (typeof renderMath === "function") renderMath(optRender);
                        }
                    }
                });
            }
            // Inject solution for this sub-question
            const solBlock = document.getElementById(`sqSolBlock_${i}`);
            if (solBlock && q.solutions && q.solutions.length > 0) {
                solBlock.innerHTML = mqBuildSolutionReadOnlyHTML(q.solutions, i);
                if (typeof ensureRenderMath === "function") ensureRenderMath(solBlock);
            }
        });
    }, 0);
}

function _sqSetViewModeButtons(isViewMode) {
    const editBtn = document.getElementById('sq-edit-btn');
    const deleteViewBtn = document.getElementById('sq-delete-view-btn');
    const saveBtn = document.getElementById('sq-save-btn');
    const cancelBtn = document.getElementById('sq-cancel-btn');
    if (editBtn) editBtn.style.display = isViewMode ? '' : 'none';
    if (deleteViewBtn) deleteViewBtn.style.display = isViewMode ? '' : 'none';
    if (saveBtn) saveBtn.style.display = isViewMode ? 'none' : '';
    if (cancelBtn) cancelBtn.style.display = isViewMode ? 'none' : '';
}

function sqEnterEditMode() {
    _sqIsEditMode = true;
    const chapter = _sqCurrentChapter;
    const lecture = _sqCurrentLecture;
    const qCardIdx = _sqCurrentQCardIdx;
    const set = _sqAllQuestions.find(q => q.chapter === chapter && q.lecture === lecture);
    if (!set) return;

    _sqEditSolImages = {};
    _sqSetViewModeButtons(false);

    const content = document.getElementById("sq-question-content");
    content.innerHTML = "";

    const headerDiv = document.createElement("div");
    headerDiv.className = "form-row";
    headerDiv.style.marginBottom = "16px";
    headerDiv.innerHTML = `
                <div class="field"><label>Chapter</label><input id="sq-edit-chapter" value="${escapeHtml(chapter)}" list="existingChapters" style="background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 13px;color:var(--text);font-size:0.87rem;outline:none;width:100%;font-family:'Outfit',sans-serif"></div>
                <div class="field"><label>Lecture</label><input id="sq-edit-lecture" type="number" min="1" value="${escapeHtml(String(lecture))}" style="background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 13px;color:var(--text);font-size:0.87rem;outline:none;width:100%;font-family:'Outfit',sans-serif"></div>`;
    content.appendChild(headerDiv);

    const questionsToRender = qCardIdx !== undefined
        ? [[set.questions[qCardIdx], qCardIdx]]
        : (set.questions || []).map((q, i) => [q, i]);

    const questionsDiv = document.createElement("div");
    questionsDiv.id = "sq-edit-questions-container";
    questionsToRender.forEach(([q, i]) => {
        const ci = q.correctIndexes || [q.correctIndex || 0];
        const isMulti = q.isMultiCorrect || ci.length > 1;
        const isNumerical = (q.numericalAnswer !== undefined && q.numericalAnswer !== null) || (Array.isArray(q.options) && q.options.every(function (o) { return !o || String(o).trim() === ''; }) && (!Array.isArray(q.optionImages) || q.optionImages.every(function (im) { return !im; })));
        const hasImg = q.questionImage && q.questionImage.length > 0;
        const imgSrc = hasImg ? ((q.questionImage.startsWith('http') || q.questionImage.startsWith('data:')) ? q.questionImage : `data:image/jpeg;base64,${q.questionImage}`) : "";
        const imgHtml = hasImg ? `<div style="margin-bottom:14px;text-align:center;display:flex;justify-content:center;align-items:center;"><img src="${imgSrc}" alt="Question diagram" style="max-width:100%;max-height:280px;display:block;object-fit:contain;cursor:pointer;border-radius:var(--radius-sm)" onclick="this.style.maxHeight=this.style.maxHeight=='none'?'280px':'none'"></div>` : "";
        const LTRS = ["A", "B", "C", "D"];
        const qDiv = document.createElement("div");
        qDiv.style.cssText = "background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-bottom:14px";
        qDiv.dataset.origIdx = i;
        const existingText = Array.isArray(q.solutions) && q.solutions.length > 0
            ? String(q.solutions[0]?.text || q.solutions[0]?.content || q.solutions[0]?.solution || q.solutions[0]?.explanation || '')
            : '';
        // Initialize solution images from existing data
        const existingSolImgs = [];
        if (Array.isArray(q.solutions) && q.solutions.length > 0) {
            const sol0 = q.solutions[0];
            if (sol0) {
                if (Array.isArray(sol0.images)) {
                    sol0.images.forEach(img => { if (img) existingSolImgs.push(img); });
                } else if (sol0.image) {
                    existingSolImgs.push(sol0.image);
                }
            }
        }
        _sqEditSolImages[i] = existingSolImgs;
        qDiv.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
                        <div style="font-size:0.7rem;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:0.6px">Question ${i + 1}${q.year && String(q.year).trim() ? ` <span style="font-size:0.68rem;background:rgba(91,95,239,0.12);color:var(--accent-2);padding:2px 7px;border-radius:20px;font-weight:700;text-transform:none;letter-spacing:normal;display:inline-flex;align-items:center;gap:3px">🏛️ ${q.exam || q.examName || q.exam_name || q.exam_label || (String(q.subject || '').toLowerCase().includes('bio') ? 'NEET' : 'JEE Main')} ${q.year}${q.month ? ' ' + q.month : ''}${(q.date || q.day) ? ' ' + (q.date || q.day) : ''}${q.shift ? ' (' + q.shift + ')' : ''}</span>` : ''}${isNumerical ? ' <span style="color:#a78bfa">🔢 Numerical</span>' : ""}</div>
                        ${isNumerical ? '' : `<label class="multi-toggle-label">
                            <input type="checkbox" id="sq_iqe_multi_${i}" ${isMulti ? "checked" : ""} onchange="sqToggleMultiCorrect(${i})">
                            <span class="multi-toggle-text">${isMulti ? "✦ Multi-correct" : "○ Single-correct"}</span>
                        </label>`}
                    </div>
                    ${imgHtml}
                    <div class="q-render-preview" id="sq_iqe_preview_${i}"></div>
                    <div class="field"><label>Edit Raw Text ($math$ for equations)</label>
                        <textarea id="sq_iqe_qt_${i}" rows="2" oninput="sqUpdatePreview(${i});_sqHasUnsavedEdits=true;" style="width:100%;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;color:var(--text);font-family:'JetBrains Mono',monospace;font-size:0.85rem;resize:vertical;outline:none">${escapeHtml(q.question || "")}</textarea>
                    </div>
                    ${isNumerical
                ? `<div style="padding:8px 12px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);border-radius:6px;font-size:0.82rem">
                            <span style="font-weight:700;color:#a78bfa">Numerical Answer: </span>
                            <span style="color:var(--text);font-weight:600;font-size:1rem">${escapeHtml(String(q.numericalAnswer ?? q.correct_answer ?? 'N/A'))}</span>
                           </div>`
                : `<div style="margin-bottom:14px">
                        <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:8px">Options (rendered)</div>
                        ${LTRS.map((l, oi) => `<div class="opt-render-row ${ci.includes(oi) ? "is-correct" : ""}"><span class="opt-letter">${l}</span><div id="sq_iqe_opt_render_${i}_${oi}"></div></div>`).join("")}
                    </div>
                    <div class="options-grid">
                        ${LTRS.map((l, oi) => `<div class="field"><label>Edit Option ${l}</label><input id="sq_iqe_opt_${i}_${oi}" value="${escapeHtml((q.options && q.options[oi]) || "")}" oninput="sqUpdateOptRender(${i},${oi});_sqHasUnsavedEdits=true;" style="background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 12px;color:var(--text);font-size:0.85rem;outline:none;width:100%;font-family:'Outfit',sans-serif"></div>`).join("")}
                    </div>
                    <div style="margin-top:10px" id="sq_iqe_correct_wrap_${i}"><label style="font-size:0.75rem;color:var(--text-dim);display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.4px">Correct Answer(s):</label>
                        <div style="display:flex;gap:10px;flex-wrap:wrap">
                            ${LTRS.map((l, oi) => `<button type="button" class="correct-btn ${ci.includes(oi) ? "selected" : ""}" data-si="${i}" data-oi="${oi}" data-multi="${isMulti}" onclick="sqToggleCorrectAnswer(${i},${oi});_sqHasUnsavedEdits=true;">${l}</button>`).join("")}
                        </div>
                    </div>`}
                    <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(16,185,129,0.2)">
                        <label style="font-size:0.75rem;color:var(--text-dim);display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.4px">Edit Solution</label>
                        <textarea id="sqSolEditArea_${i}" rows="5" placeholder="Type the solution here..." style="width:100%;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;color:var(--text);font-family:'JetBrains Mono',monospace;font-size:0.85rem;resize:vertical;outline:none;line-height:1.6;box-sizing:border-box">${escapeHtml(existingText)}</textarea>
                        <div style="margin-top:10px">
                            <label style="font-size:0.72rem;color:var(--text-dim);display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.4px">Solution Images</label>
                            <div id="sqSolImgZone_${i}"></div>
                        </div>
                    </div>`;
        questionsDiv.appendChild(qDiv);
    });
    content.appendChild(questionsDiv);

    _sqHasUnsavedEdits = false;
    requestAnimationFrame(() => {
        setTimeout(() => {
            _sqOriginalSnapshot = _sqGetEditSnapshot();
            document.querySelectorAll("#sq-edit-questions-container textarea, #sq-edit-questions-container input, #sq-edit-chapter, #sq-edit-lecture").forEach(el => {
                el.addEventListener("input", () => { _sqHasUnsavedEdits = true; });
            });
        }, 120);
    });

    setTimeout(() => {
        questionsToRender.forEach(([q, i]) => {
            const isNumerical = (q.numericalAnswer !== undefined && q.numericalAnswer !== null) || (Array.isArray(q.options) && q.options.every(function (o) { return !o || String(o).trim() === ''; }) && (!Array.isArray(q.optionImages) || q.optionImages.every(function (im) { return !im; })));
            const prev = document.getElementById(`sq_iqe_preview_${i}`);
            if (prev) { prev.textContent = q.question; if (typeof renderMath === "function") renderMath(prev); }
            if (!isNumerical) {
                ["A", "B", "C", "D"].forEach((l, oi) => {
                    const optRender = document.getElementById(`sq_iqe_opt_render_${i}_${oi}`);
                    if (optRender) {
                        const optImg = Array.isArray(q.optionImages) ? (q.optionImages[oi] || null) : null;
                        if (optImg) {
                            const imgSrc = (optImg.startsWith('http') || optImg.startsWith('data:')) ? optImg : `data:image/jpeg;base64,${optImg}`;
                            optRender.innerHTML = `<img src="${imgSrc}" alt="Option ${l}" style="max-height:80px;max-width:100%;border-radius:4px;border:1px solid var(--border);object-fit:contain;display:block;margin-top:2px">`;
                        } else {
                            optRender.textContent = (q.options && q.options[oi]) || "";
                            if (typeof renderMath === "function") renderMath(optRender);
                        }
                    }
                });
            }
            // Render solution image edit zone
            const solImgZone = document.getElementById(`sqSolImgZone_${i}`);
            if (solImgZone) solImgZone.innerHTML = sqBuildSolImgEditZone(i);
        });
    }, 0);
}

function sqExitEditMode() {
    const snapshotChanged = _sqOriginalSnapshot && _sqOriginalSnapshot !== _sqGetEditSnapshot();
    if (_sqHasUnsavedEdits || snapshotChanged) {
        sqShowUnsavedModal(
            "You have unsaved changes. What would you like to do?",
            () => sqOpenQuestionView(_sqCurrentChapter, _sqCurrentLecture, _sqCurrentQCardIdx),
            () => sqOpenQuestionView(_sqCurrentChapter, _sqCurrentLecture, _sqCurrentQCardIdx)
        );
    } else {
        _sqHasUnsavedEdits = false;
        sqOpenQuestionView(_sqCurrentChapter, _sqCurrentLecture, _sqCurrentQCardIdx);
    }
}

function sqHandleQuestionViewBack() {
    if (!_sqIsEditMode) {
        sqShowQuestionCards(_sqCurrentChapter, _sqCurrentLecture);
        return;
    }
    sqCancelEditWithCheck();
}
function sqUpdatePreview(si) {
    const ta = document.getElementById(`sq_iqe_qt_${si}`);
    const prev = document.getElementById(`sq_iqe_preview_${si}`);
    if (ta && prev) { prev.textContent = ta.value; if (typeof renderMath === "function") renderMath(prev); }
}

function sqUpdateOptRender(si, oi) {
    const el = document.getElementById(`sq_iqe_opt_${si}_${oi}`);
    const rd = document.getElementById(`sq_iqe_opt_render_${si}_${oi}`);
    if (el && rd) { rd.textContent = el.value; if (typeof renderMath === "function") renderMath(rd); }
}

function sqToggleMultiCorrect(si) {
    const cb = document.getElementById(`sq_iqe_multi_${si}`);
    const isMulti = cb.checked;
    const wrap = document.getElementById(`sq_iqe_correct_wrap_${si}`);
    if (!wrap) return;
    const LTRS = ["A", "B", "C", "D"];
    // Get currently selected answers
    const selected = [];
    LTRS.forEach((l, oi) => {
        const btn = wrap.querySelector(`[data-si="${si}"][data-oi="${oi}"]`);
        if (btn && btn.classList.contains("selected")) selected.push(oi);
    });
    // Update toggle label
    const span = cb.nextElementSibling;
    if (span) span.textContent = isMulti ? "✦ Multi-correct" : "○ Single-correct";
    // Re-render buttons with updated multi state
    wrap.querySelector("div").innerHTML = LTRS.map((l, oi) => `<button type="button" class="correct-btn ${selected.includes(oi) ? "selected" : ""}" data-si="${si}" data-oi="${oi}" data-multi="${isMulti}" onclick="sqToggleCorrectAnswer(${si},${oi})">${l}</button>`).join("");
    // If switching to single, keep only first selected
    if (!isMulti && selected.length > 1) {
        LTRS.forEach((l, oi) => {
            const btn = wrap.querySelector(`[data-si="${si}"][data-oi="${oi}"]`);
            if (btn) btn.classList.toggle("selected", oi === selected[0]);
        });
    }
}

function sqToggleCorrectAnswer(si, oi) {
    const cb = document.getElementById(`sq_iqe_multi_${si}`);
    const isMulti = cb && cb.checked;
    const wrap = document.getElementById(`sq_iqe_correct_wrap_${si}`);
    if (!wrap) return;
    const LTRS = ["A", "B", "C", "D"];
    if (!isMulti) {
        LTRS.forEach((_, i) => {
            const btn = wrap.querySelector(`[data-si="${si}"][data-oi="${i}"]`);
            if (btn) btn.classList.toggle("selected", i === oi);
        });
    } else {
        const btn = wrap.querySelector(`[data-si="${si}"][data-oi="${oi}"]`);
        if (btn) btn.classList.toggle("selected");
    }
}

async function sqSaveEdit() {
    const newChapter = document.getElementById("sq-edit-chapter")?.value.trim();
    const newLecture = document.getElementById("sq-edit-lecture")?.value.trim();
    const newTopic = "";
    if (!newChapter) { showErrorModal("Chapter name is required.", "Missing Field"); return; }
    if (!newLecture || parseInt(newLecture) < 1) { showErrorModal("A valid lecture number is required.", "Missing Field"); return; }

    const LTRS = ["A", "B", "C", "D"];
    const origSet = _sqAllQuestions.find(q => q.chapter === _sqCurrentChapter && q.lecture === _sqCurrentLecture);
    // Start with a full copy of ALL existing questions
    const newQuestions = (origSet?.questions || []).map(q => ({ ...q }));

    const containers = document.querySelectorAll("#sq-edit-questions-container > div");
    containers.forEach((c, si) => {
        // Use the original index stored in data-orig-idx (for single-question mode)
        const origIdx = c.dataset.origIdx !== undefined ? parseInt(c.dataset.origIdx) : si;
        const qtEl = document.getElementById(`sq_iqe_qt_${origIdx}`);
        const multiCb = document.getElementById(`sq_iqe_multi_${origIdx}`);
        const isMulti = multiCb && multiCb.checked;
        const opts = LTRS.map((_, oi) => document.getElementById(`sq_iqe_opt_${origIdx}_${oi}`)?.value || "");
        const wrap = document.getElementById(`sq_iqe_correct_wrap_${origIdx}`);
        const selectedOpts = [];
        if (wrap) {
            LTRS.forEach((_, oi) => {
                const btn = wrap.querySelector(`[data-si="${origIdx}"][data-oi="${oi}"]`);
                if (btn && btn.classList.contains("selected")) selectedOpts.push(oi);
            });
        }
        const origQ = origSet && origSet.questions ? origSet.questions[origIdx] : null;
        const solutionText = document.getElementById(`sqSolEditArea_${origIdx}`)?.value.trim() || "";
        const solImages = Array.isArray(_sqEditSolImages[origIdx]) ? _sqEditSolImages[origIdx].filter(Boolean) : [];
        const existingSolutions = Array.isArray(origQ?.solutions) ? origQ.solutions.map(sol => ({ ...sol })) : [];
        if (solutionText || solImages.length || existingSolutions.length) {
            if (!existingSolutions.length) {
                existingSolutions.push({ text: solutionText, image: solImages[0] || null, images: solImages.length ? solImages : [] });
            } else {
                if (!existingSolutions[0]) existingSolutions[0] = {};
                existingSolutions[0].text = solutionText;
                existingSolutions[0].image = solImages[0] || null;
                existingSolutions[0].images = solImages.length ? solImages : [];
            }
        }
        const optionImages = Array.isArray(origQ?.optionImages) ? origQ.optionImages : [null, null, null, null];

        newQuestions[origIdx] = {
            ...origQ,
            question: qtEl?.value || "",
            options: opts,
            correctIndexes: selectedOpts.length ? selectedOpts : [0],
            isMultiCorrect: isMulti,
            questionImage: origQ?.questionImage || null,
            solutions: existingSolutions,
            optionImages: optionImages,
            hasOptionImages: !!(origQ?.hasOptionImages || optionImages.some(Boolean))
        };
    });

    try {
        showDeleteProgress("Saving changes...");
        const chapterChanged = newChapter !== _sqCurrentChapter;
        const lectureChanged = newLecture !== String(_sqCurrentLecture);

        if (chapterChanged || lectureChanged) {
            // Chapter/lecture changed: delete old entry and insert as new
            await fetch(`${API_BASE}/api/admin/star-quiz/question/${encodeURIComponent(_sqCurrentChapter || "")}/${encodeURIComponent(_sqCurrentLecture)}`, { method: "DELETE", credentials: "include" });
            const resp = await fetch(`${API_BASE}/api/admin/star-quiz/add-question`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chapter: newChapter, lecture: newLecture, topic: newTopic, questions: newQuestions, replace: true })
            });
            if (!resp.ok) throw new Error("Save failed");
        } else {
            // Same chapter/lecture: use PUT to update all questions in place
            const resp = await fetch(
                `${API_BASE}/api/admin/star-quiz/question/${encodeURIComponent(_sqCurrentChapter || "")}/${encodeURIComponent(_sqCurrentLecture)}`,
                {
                    method: "PUT", credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ topic: newTopic, questions: newQuestions })
                }
            );
            if (!resp.ok) throw new Error("Save failed");
        }

        hideDeleteProgress();
        _sqHasUnsavedEdits = false;
        showSuccessModal("Saved!", `Lecture ${newLecture} updated successfully.`);
        await loadStarQuizData();
        _sqCurrentChapter = newChapter;
        _sqCurrentLecture = newLecture;
        // Update nav list
        const sets = _sqAllQuestions.filter(q => (q.chapter || "(No Chapter)") === newChapter);
        sets.sort((a, b) => (parseInt(a.lecture) || 0) - (parseInt(b.lecture) || 0));
        _sqNavList = sets.map(s => ({ chapter: s.chapter, lecture: s.lecture }));
        _sqNavIdx = _sqNavList.findIndex(e => e.chapter === newChapter && String(e.lecture) === String(newLecture));
        sqOpenQuestionView(newChapter, newLecture);
        document.getElementById("sq-question-title").textContent = `${newChapter} — Lecture ${newLecture}`;
    } catch (e) {
        hideDeleteProgress();
        showErrorModal("Save failed: " + e.message, "Save Failed");
    }
}

function sqCancelEdit() {
    sqCancelEditWithCheck();
}

function sqFilterChapters(val) {
    const q = val.toLowerCase();
    const filtered = q ? _sqAllQuestions.filter(s => (s.chapter || "").toLowerCase().includes(q)) : _sqAllQuestions;
    sqRenderChapters(filtered);
}

async function sqDeleteCurrentLecture() {
    const confirmed = await askConfirmModalPromise({ title: "Delete Lecture", text: `Delete all questions in Lecture ${_sqCurrentLecture} of "${_sqCurrentChapter}"? This cannot be undone.`, confirmText: "Delete" });
    if (!confirmed) return;
    showDeleteProgress("Deleting...");
    const r = await fetch(`${API_BASE}/api/admin/star-quiz/question/${encodeURIComponent(_sqCurrentChapter || "")}/${encodeURIComponent(_sqCurrentLecture)}`, { method: "DELETE", credentials: "include" });
    hideDeleteProgress();
    if (r.ok) {
        await loadStarQuizData();
        sqShowLectureView();
        showSuccessModal("Deleted!", "Lecture deleted.");
    } else { showErrorModal("Delete failed. Please try again."); }
}

async function sqDeleteChapter() {
    const sets = _sqAllQuestions.filter(q => (q.chapter || "(No Chapter)") === _sqCurrentChapter);
    const confirmed = await askConfirmModalPromise({ title: "Delete Chapter", text: `Delete ALL ${sets.length} lecture sets in chapter "${_sqCurrentChapter}"? This cannot be undone.`, confirmText: "Delete" });
    if (!confirmed) return;
    showDeleteProgress("Deleting chapter...");
    for (const s of sets) {
        await fetch(`${API_BASE}/api/admin/star-quiz/question/${encodeURIComponent(s.chapter || "")}/${encodeURIComponent(s.lecture)}`, { method: "DELETE", credentials: "include" });
    }
    hideDeleteProgress();
    await loadStarQuizData();
    sqShowChapterView();
    showSuccessModal("Deleted!", `Chapter "${_sqCurrentChapter}" was deleted.`);
}

// ═══════════════════════════════════════════════
//  CHAPTER SELECT MODE
// ═══════════════════════════════════════════════
function sqToggleSelectMode() {
    _sqSelectModeOn = !_sqSelectModeOn;
    _sqSelectedChapters.clear();
    const btn = document.getElementById("sq-select-mode-btn");
    btn.textContent = _sqSelectModeOn ? "✓ Done" : "☐ Select";
    document.getElementById("sq-mass-delete-bar").classList.remove("visible");
    sqRenderChapters(_sqAllQuestions);
}

function sqToggleChapterSelect(e, encodedCh) {
    e.stopPropagation();
    const ch = decodeURIComponent(encodedCh);
    if (_sqSelectedChapters.has(ch)) _sqSelectedChapters.delete(ch);
    else _sqSelectedChapters.add(ch);
    sqUpdateChapterMassDeleteBar();
    sqRenderChapters(_sqAllQuestions);
}

function sqToggleChapterSelectByName(ch) {
    if (_sqSelectedChapters.has(ch)) _sqSelectedChapters.delete(ch);
    else _sqSelectedChapters.add(ch);
    sqUpdateChapterMassDeleteBar();
    sqRenderChapters(_sqAllQuestions);
}

function sqUpdateChapterMassDeleteBar() {
    const bar = document.getElementById("sq-mass-delete-bar");
    const count = document.getElementById("sq-mass-delete-count");
    bar.classList.toggle("visible", _sqSelectedChapters.size > 0);
    count.textContent = `${_sqSelectedChapters.size} chapter(s) selected`;
}

function sqClearChapterSelection() {
    _sqSelectModeOn = false;
    _sqSelectedChapters.clear();
    document.getElementById("sq-select-mode-btn").textContent = "☐ Select";
    document.getElementById("sq-mass-delete-bar").classList.remove("visible");
    sqRenderChapters(_sqAllQuestions);
}

async function sqMassDeleteChapters() {
    if (!_sqSelectedChapters.size) return;
    const confirmed = await askConfirmModalPromise({ title: "Delete Selected", text: `Delete ${_sqSelectedChapters.size} chapter(s) and all their questions? This cannot be undone.`, confirmText: "Delete All" });
    if (!confirmed) return;
    showDeleteProgress("Deleting chapters...");
    for (const ch of _sqSelectedChapters) {
        const sets = _sqAllQuestions.filter(q => (q.chapter || "(No Chapter)") === ch);
        for (const s of sets) {
            await fetch(`${API_BASE}/api/admin/star-quiz/question/${encodeURIComponent(s.chapter || "")}/${encodeURIComponent(s.lecture)}`, { method: "DELETE", credentials: "include" });
        }
    }
    hideDeleteProgress();
    showSuccessModal("Deleted!", `${_sqSelectedChapters.size} chapter(s) deleted.`);
    _sqSelectModeOn = false;
    _sqSelectedChapters.clear();
    await loadStarQuizData();
    sqShowChapterView();
}

// ═══════════════════════════════════════════════
//  RENAME CHAPTER (Star Quiz)
// ════════════���══════════════════════════════════
async function sqRenameChapter(e, encodedCh) {
    e.stopPropagation();
    const ch = decodeURIComponent(encodedCh);
    const newName = await askPromptModalPromise({ title: "Rename Chapter", text: `Enter new name for chapter: "${ch}"`, defaultValue: ch });
    if (!newName || !newName.trim() || newName.trim() === ch) return;
    const confirmed = await askConfirmModalPromise({ title: "Confirm Rename", text: `Rename "${ch}" to "${newName.trim()}"?`, confirmText: "Rename" });
    if (!confirmed) return;
    showDeleteProgress("Renaming chapter...");
    // Update each lecture set in this chapter
    const sets = _sqAllQuestions.filter(q => (q.chapter || "(No Chapter)") === ch);
    for (const s of sets) {
        // Delete old
        await fetch(`${API_BASE}/api/admin/star-quiz/question/${encodeURIComponent(s.chapter || "")}/${encodeURIComponent(s.lecture)}`, { method: "DELETE", credentials: "include" });
        // Re-add with new chapter name
        await fetch(`${API_BASE}/api/admin/star-quiz/add-question`, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chapter: newName.trim(), lecture: s.lecture, topic: s.topic || "", questions: s.questions || [], replace: true })
        });
    }
    hideDeleteProgress();
    await loadStarQuizData();
    sqRenderChapters(_sqAllQuestions);
    showSuccessModal("Renamed!", `Chapter renamed to "${newName.trim()}".`);
}

// ═══════════════════════════════════════════════
//  LECTURE SELECT MODE
// ═══════════════════════════════════════════════
function sqToggleLectureSelectMode() {
    _sqLecSelectModeOn = !_sqLecSelectModeOn;
    _sqSelectedLectures.clear();
    const btn = document.getElementById("sq-select-lec-btn");
    btn.textContent = _sqLecSelectModeOn ? "✓ Done" : "☐ Select Lectures";
    document.getElementById("sq-lec-mass-delete-bar").classList.remove("visible");
    sqRenderLectures(_sqCurrentChapter);
}

function sqToggleLectureSelect(e, encodedChapter, encodedLecture) {
    e.stopPropagation();
    const chapter = decodeURIComponent(encodedChapter);
    const lecture = decodeURIComponent(encodedLecture);
    const key = `${chapter}::${lecture}`;
    if (_sqSelectedLectures.has(key)) _sqSelectedLectures.delete(key);
    else _sqSelectedLectures.add(key);
    sqUpdateLectureMassDeleteBar();
    sqRenderLectures(_sqCurrentChapter);
}

function sqUpdateLectureMassDeleteBar() {
    const bar = document.getElementById("sq-lec-mass-delete-bar");
    const count = document.getElementById("sq-lec-mass-delete-count");
    bar.classList.toggle("visible", _sqSelectedLectures.size > 0);
    count.textContent = `${_sqSelectedLectures.size} lecture(s) selected`;
}

function sqClearLectureSelection() {
    _sqLecSelectModeOn = false;
    _sqSelectedLectures.clear();
    document.getElementById("sq-select-lec-btn").textContent = "☐ Select Lectures";
    document.getElementById("sq-lec-mass-delete-bar").classList.remove("visible");
    sqRenderLectures(_sqCurrentChapter);
}

async function sqMassDeleteLectures() {
    if (!_sqSelectedLectures.size) return;
    const confirmed = await askConfirmModalPromise({ title: "Delete Lectures", text: `Delete ${_sqSelectedLectures.size} lecture(s) and all their questions? This cannot be undone.`, confirmText: "Delete All" });
    if (!confirmed) return;
    showDeleteProgress("Deleting lectures...");
    for (const key of _sqSelectedLectures) {
        const [ch, ...rest] = key.split("::");
        const lec = rest.join("::");
        const chapterForUrl = (ch === "(No Chapter)" || ch === "_none_") ? "" : ch;
        await fetch(`${API_BASE}/api/admin/star-quiz/question/${encodeURIComponent(chapterForUrl)}/${encodeURIComponent(lec)}`, { method: "DELETE", credentials: "include" });
    }
    hideDeleteProgress();
    showSuccessModal("Deleted!", `${_sqSelectedLectures.size} lecture(s) deleted.`);
    _sqLecSelectModeOn = false;
    _sqSelectedLectures.clear();
    await loadStarQuizData();
    sqShowLectureView();
}

// Filter lecture cards
function sqFilterLectureCards() {
    const lecQ = (document.getElementById("sq-lec-num-filter")?.value || "").trim();
    document.querySelectorAll("#sq-lecture-grid .lecture-card").forEach(card => {
        const cLec = card.dataset.lec || "";
        const matchLec = !lecQ || cLec === lecQ || cLec.includes(lecQ);
        card.style.display = matchLec ? "" : "none";
    });
}

// Rename topic on a lecture
// State for the edit-lecture modal
let _sqEditLecCtx = null; // { chapter, lecture }

function sqEditLecture(e, encodedChapter, encodedLecture) {
    e.stopPropagation();
    const chapter = decodeURIComponent(encodedChapter);
    const lecture = decodeURIComponent(encodedLecture);
    const set = _sqAllQuestions.find(q => q.chapter === chapter && String(q.lecture) === String(lecture));
    _sqEditLecCtx = { chapter, lecture };
    document.getElementById("sqEditLecNumInput").value = lecture;
    document.getElementById("sqEditLecCodeInput").value = set?.accessCode || "";
    openModal("sqEditLectureModal");
}

async function sqEditLectureSave() {
    if (!_sqEditLecCtx) return;
    const { chapter, lecture: oldLecture } = _sqEditLecCtx;
    const newLecture = document.getElementById("sqEditLecNumInput").value.trim();
    const newCode = document.getElementById("sqEditLecCodeInput").value.trim();
    if (!newLecture || parseInt(newLecture) < 1) {
        showErrorModal("Please enter a valid lecture number.", "Invalid");
        return;
    }
    if (newCode && !/^[0-9]{4}$/.test(newCode)) {
        showErrorModal("Lecture code must be exactly 4 digits (numbers only).", "Invalid Code");
        return;
    }
    const set = _sqAllQuestions.find(q => q.chapter === chapter && String(q.lecture) === String(oldLecture));
    const lectureChanged = newLecture !== String(oldLecture);
    const codeChanged = newCode !== (set?.accessCode || "");
    // Check for collision if lecture number changed
    if (lectureChanged) {
        const collision = _sqAllQuestions.find(q => q.chapter === chapter && String(q.lecture) === String(newLecture));
        if (collision) {
            const ok = await askConfirmModalPromise({ title: "Lecture Exists", text: `Lecture ${newLecture} already exists in this chapter. Merge into it?`, confirmText: "Merge" });
            if (!ok) return;
        }
    }
    closeModal("sqEditLectureModal");
    showDeleteProgress("Saving...");
    try {
        if (lectureChanged) {
            // Delete old entry, re-add under new lecture number
            await fetch(`${API_BASE}/api/admin/star-quiz/question/${encodeURIComponent(chapter || "")}/${encodeURIComponent(oldLecture)}`, { method: "DELETE", credentials: "include" });
            await fetch(`${API_BASE}/api/admin/star-quiz/add-question`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chapter, lecture: newLecture, topic: set?.topic || "", questions: set?.questions || [], replace: false })
            });
        } else {
            // Just update topic
            await fetch(`${API_BASE}/api/admin/star-quiz/add-question`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chapter, lecture: oldLecture, topic: set?.topic || "", questions: set?.questions || [], replace: true })
            });
        }
        // Update lecture code if changed
        const targetLecture = lectureChanged ? newLecture : oldLecture;
        if (codeChanged) {
            if (newCode) {
                // Set or update the code
                await fetch(`${API_BASE}/api/admin/star-quiz/set-code/${encodeURIComponent(chapter)}/${encodeURIComponent(targetLecture)}`, {
                    method: "POST", credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ accessCode: newCode })
                });
            } else {
                // Remove the code (send empty/null)
                await fetch(`${API_BASE}/api/admin/star-quiz/set-code/${encodeURIComponent(chapter)}/${encodeURIComponent(targetLecture)}`, {
                    method: "POST", credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ accessCode: null })
                });
            }
        }
        hideDeleteProgress();
        await loadStarQuizData();
        _sqCurrentChapter = chapter;
        sqRenderLectures(chapter);
        const codeNote = codeChanged ? (newCode ? ` Code set to ${newCode}.` : " Code removed.") : "";
        showSuccessModal("Saved!", (lectureChanged ? `Lecture renamed to ${newLecture}.` : "Topic updated.") + codeNote);
    } catch (err) {
        hideDeleteProgress();
        showErrorModal("Save failed: " + err.message);
    }
    _sqEditLecCtx = null;
}

async function sqRenameTopic(e, encodedChapter, encodedLecture) {
    e.stopPropagation();
    const chapter = decodeURIComponent(encodedChapter);
    const lecture = decodeURIComponent(encodedLecture);
    const set = _sqAllQuestions.find(q => q.chapter === chapter && String(q.lecture) === String(lecture));
    const oldTopic = set?.topic || "";
    const newTopic = await askPromptModalPromise({ title: "Rename Topic", text: `Enter new topic name:`, defaultValue: oldTopic });
    if (newTopic === null || newTopic.trim() === oldTopic) return;
    const confirmed = await askConfirmModalPromise({ title: "Confirm Rename", text: `Set topic to "${newTopic.trim()}"?`, confirmText: "Rename" });
    if (!confirmed) return;
    showDeleteProgress("Saving...");
    await fetch(`${API_BASE}/api/admin/star-quiz/add-question`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chapter, lecture, topic: newTopic.trim(), questions: set?.questions || [], replace: true })
    });
    hideDeleteProgress();
    await loadStarQuizData();
    sqRenderLectures(_sqCurrentChapter);
    showSuccessModal("Renamed!", "Topic updated.");
}

// ═══════════════════════════════════════════════
//  QUESTION SELECT MODE (in question cards view)
// ═══════════════════════════════════════════════
function sqToggleQuestionSelectMode() {
    _sqQSelectModeOn = !_sqQSelectModeOn;
    _sqSelectedQuestions.clear();
    const btn = document.getElementById("sq-select-q-btn");
    btn.textContent = _sqQSelectModeOn ? "✓ Done" : "☐ Select Questions";
    document.getElementById("sq-q-mass-delete-bar").classList.remove("visible");
    // Re-render cards in-place without resetting select mode state
    sqRenderQuestionCards();
}

function sqToggleQuestionSelect(e, qIdx) {
    e.stopPropagation();
    const key = String(qIdx);
    if (_sqSelectedQuestions.has(key)) _sqSelectedQuestions.delete(key);
    else _sqSelectedQuestions.add(key);
    sqUpdateQuestionMassDeleteBar();
    const card = document.querySelector(`#sq-question-cards-grid .lecture-card[data-qidx="${qIdx}"]`);
    if (card) {
        const cb = card.querySelector(".lec-checkbox");
        if (cb) cb.checked = _sqSelectedQuestions.has(key);
        card.classList.toggle("selected-card", _sqSelectedQuestions.has(key));
    }
}

function sqUpdateQuestionMassDeleteBar() {
    const bar = document.getElementById("sq-q-mass-delete-bar");
    const count = document.getElementById("sq-q-mass-delete-count");
    bar.classList.toggle("visible", _sqSelectedQuestions.size > 0);
    count.textContent = `${_sqSelectedQuestions.size} question(s) selected`;
}

function sqClearQuestionSelection() {
    _sqQSelectModeOn = false;
    _sqSelectedQuestions.clear();
    const btn = document.getElementById("sq-select-q-btn");
    if (btn) btn.textContent = "☐ Select Questions";
    const bar = document.getElementById("sq-q-mass-delete-bar");
    if (bar) bar.classList.remove("visible");
    sqRenderQuestionCards();
}

async function sqMassDeleteQuestions() {
    if (!_sqSelectedQuestions.size) return;
    const set = _sqAllQuestions.find(q => q.chapter === _sqCurrentChapter && String(q.lecture) === String(_sqCurrentLecture));
    if (!set) return;
    const confirmed = await askConfirmModalPromise({ title: "Delete Questions", text: `Delete ${_sqSelectedQuestions.size} selected question(s) from Lecture ${_sqCurrentLecture}? This cannot be undone.`, confirmText: "Delete" });
    if (!confirmed) return;
    showDeleteProgress("Deleting questions...");
    const indices = [..._sqSelectedQuestions].map(Number).sort((a, b) => b - a);
    const newQuestions = [...(set.questions || [])];
    indices.forEach(i => newQuestions.splice(i, 1));
    if (newQuestions.length === 0) {
        // Delete entire lecture set
        await fetch(`${API_BASE}/api/admin/star-quiz/question/${encodeURIComponent(_sqCurrentChapter || "")}/${encodeURIComponent(_sqCurrentLecture)}`, { method: "DELETE", credentials: "include" });
        hideDeleteProgress();
        showSuccessModal("Deleted!", "All questions removed, lecture deleted.");
        await loadStarQuizData();
        sqShowLectureView();
    } else {
        await fetch(`${API_BASE}/api/admin/star-quiz/add-question`, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chapter: _sqCurrentChapter, lecture: _sqCurrentLecture, topic: set.topic || "", questions: newQuestions, replace: true })
        });
        hideDeleteProgress();
        showSuccessModal("Deleted!", `${indices.length} question(s) deleted.`);
        _sqQSelectModeOn = false;
        _sqSelectedQuestions.clear();
        await loadStarQuizData();
        sqShowQuestionCards(_sqCurrentChapter, _sqCurrentLecture);
    }
}

// Delete a SINGLE question from question view
async function sqDeleteSingleQuestion() {
    if (_sqCurrentQCardIdx === undefined) return;
    const set = _sqAllQuestions.find(q => q.chapter === _sqCurrentChapter && String(q.lecture) === String(_sqCurrentLecture));
    if (!set) return;
    const confirmed = await askConfirmModalPromise({ title: "Delete Question", text: `Delete Question ${_sqCurrentQCardIdx + 1} from Lecture ${_sqCurrentLecture}? This cannot be undone.`, confirmText: "Delete" });
    if (!confirmed) return;
    showDeleteProgress("Deleting question...");
    const newQuestions = [...(set.questions || [])];
    newQuestions.splice(_sqCurrentQCardIdx, 1);
    if (newQuestions.length === 0) {
        await fetch(`${API_BASE}/api/admin/star-quiz/question/${encodeURIComponent(_sqCurrentChapter || "")}/${encodeURIComponent(_sqCurrentLecture)}`, { method: "DELETE", credentials: "include" });
        hideDeleteProgress();
        showSuccessModal("Deleted!", "Question deleted. Lecture had no more questions and was removed.");
        await loadStarQuizData();
        sqShowLectureView();
    } else {
        await fetch(`${API_BASE}/api/admin/star-quiz/add-question`, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chapter: _sqCurrentChapter, lecture: _sqCurrentLecture, topic: set.topic || "", questions: newQuestions, replace: true })
        });
        hideDeleteProgress();
        showSuccessModal("Deleted!", "Question deleted successfully.");
        await loadStarQuizData();
        sqShowQuestionCards(_sqCurrentChapter, _sqCurrentLecture);
    }
}


function _spGetDrillData() {
    const classMap = new Map();
    for (const s of _spAllStudents) {




        const cn = s.className || 'No Class';
        const parts = cn.split('-');
        const classLabel = parts[0]?.trim() || cn;
        const sectionLabel = parts.slice(1).join('-').trim() || 'General';
        if (!classMap.has(classLabel)) classMap.set(classLabel, { classLabel, sections: new Map() });
        const cls = classMap.get(classLabel);
        if (!cls.sections.has(sectionLabel)) cls.sections.set(sectionLabel, { label: sectionLabel, students: [] });
        cls.sections.get(sectionLabel).students.push(s);
    }
    return classMap;
}

function _spRender() {
    const content = document.getElementById('sp-content');
    const nav = document.getElementById('sp-nav');
    const countEl = document.getElementById('sp-count');
    const n = _spSelectedRolls.size;
    countEl.textContent = `${n} student${n !== 1 ? 's' : ''} selected`;

    const classMap = _spGetDrillData();
    const classes = [...classMap.values()];

    if (!_spDrillClass) {
        // Show class cards
        nav.innerHTML = '<span style="font-weight:700;color:var(--text)">Class Cards</span>';
        if (!classes.length) {
            content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.85rem">No registered students found.</div>';
            return;
        }
        content.innerHTML = `<div class="reg-drill-grid">
                ${classes.map(cls => {
            const total = [...cls.sections.values()].reduce((s, sec) => s + sec.students.length, 0);
            return `<div class="reg-pick-card" onclick="spOpenClass('${encodeURIComponent(cls.classLabel)}')" role="button" tabindex="0">
                        <div class="reg-pick-icon">🎓</div>
                        <div class="reg-pick-title">${escapeHtml(cls.classLabel)}</div>
                        <div class="reg-pick-sub">${total} Student${total !== 1 ? 's' : ''}</div>
                    </div>`;
        }).join('')}
            </div>`;
        return;
    }

    const classEntry = classMap.get(_spDrillClass);
    if (!classEntry) { _spDrillClass = null; _spRender(); return; }

    if (!_spDrillSection) {
        // Show section cards
        nav.innerHTML = `<button onclick="spBackToClasses()" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:0.78rem;font-weight:700;padding:0">← Classes</button>
                <span style="color:var(--border)">›</span>
                <span style="font-weight:700;color:var(--text)">${escapeHtml(_spDrillClass)}</span>`;
        const sections = [...classEntry.sections.values()];
        content.innerHTML = `<div class="reg-drill-grid">
                ${sections.map(sec => {
            const selCount = sec.students.filter(s => _spSelectedRolls.has(s.rollNumber)).length;
            return `<div class="reg-pick-card" onclick="spOpenSection('${encodeURIComponent(sec.label)}')" role="button" tabindex="0" style="${selCount ? 'border-color:rgba(86,169,255,0.4)' : ''}">
                        <div class="reg-pick-icon">📁</div>
                        <div class="reg-pick-title">${escapeHtml(sec.label)}</div>
                        <div class="reg-pick-sub">${sec.students.length} Student${sec.students.length !== 1 ? 's' : ''}${selCount ? `<br><span style="color:var(--accent);font-size:0.7rem">${selCount} selected</span>` : ''}</div>
                    </div>`;
        }).join('')}
            </div>`;
        return;
    }

    const sectionInfo = classEntry.sections.get(_spDrillSection);
    if (!sectionInfo) { _spDrillSection = null; _spRender(); return; }

    // Show student list with checkboxes
    nav.innerHTML = `<button onclick="spBackToClasses()" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:0.78rem;font-weight:700;padding:0">← Classes</button>
            <span style="color:var(--border)">›</span>
            <button onclick="spBackToSections()" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:0.78rem;font-weight:700;padding:0">${escapeHtml(_spDrillClass)}</button>
            <span style="color:var(--border)">›</span>
            <span style="font-weight:700;color:var(--text)">${escapeHtml(_spDrillSection)}</span>`;

    const students = [...sectionInfo.students].sort((a, b) => String(a.rollNumber || '').localeCompare(String(b.rollNumber || '')));
    const allSelected = students.every(s => _spSelectedRolls.has(s.rollNumber));

    content.innerHTML = `<div style="margin-bottom:10px;display:flex;align-items:center;gap:10px">
            <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:0.83rem;font-weight:700;color:var(--text-dim)">
                <input type="checkbox" id="sp-select-all-cb" ${allSelected ? 'checked' : ''} onchange="spToggleAll(this.checked)" style="width:16px;height:16px;cursor:pointer;accent-color:var(--accent)">
                Select All (${students.length})
            </label>
        </div>
        <div class="reg-list-wrap">
            <div class="reg-list-body">
                ${students.map((s, idx) => {
        const checked = _spSelectedRolls.has(s.rollNumber);
        return `<div class="reg-list-item" style="${checked ? 'background:rgba(86,169,255,0.06);border-radius:8px' : ''}">
                        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;flex:1;padding:2px 0">
                            <input type="checkbox" ${checked ? 'checked' : ''} data-roll="${escapeHtml(s.rollNumber)}" onchange="spToggleStudent('${escapeForOnclickString(s.rollNumber)}', this.checked)" style="width:16px;height:16px;cursor:pointer;flex-shrink:0;accent-color:var(--accent)">
                            <div style="min-width:0">
                                <div class="reg-list-name">${escapeHtml(s.name || 'Unnamed')}</div>
                                <div class="reg-list-meta">Roll: ${escapeHtml(s.rollNumber || '—')} · ${s.profileComplete ? '<span style="color:var(--success)">Registered</span>' : '<span style="color:var(--warn)">Pending</span>'}</div>
                            </div>
                        </label>
                    </div>`;
    }).join('')}
            </div>
        </div>`;
}

function spOpenClass(encoded) {
    _spDrillClass = decodeURIComponent(encoded);
    _spDrillSection = null;
    _spRender();
}

function spOpenSection(encoded) {
    _spDrillSection = decodeURIComponent(encoded);
    _spRender();
}

function spBackToClasses() {
    _spDrillClass = null;
    _spDrillSection = null;
    _spRender();
}

function spBackToSections() {
    _spDrillSection = null;
    _spRender();
}

function spToggleStudent(roll, checked) {
    if (checked) _spSelectedRolls.add(roll);
    else _spSelectedRolls.delete(roll);
    const countEl = document.getElementById('sp-count');
    if (countEl) countEl.textContent = `${_spSelectedRolls.size} student${_spSelectedRolls.size !== 1 ? 's' : ''} selected`;
    // Sync select-all checkbox state
    const classMap = _spGetDrillData();
    const classEntry = classMap.get(_spDrillClass);
    if (classEntry && _spDrillSection) {
        const sec = classEntry.sections.get(_spDrillSection);
        if (sec) {
            const allSel = sec.students.every(s => _spSelectedRolls.has(s.rollNumber));
            const cb = document.getElementById('sp-select-all-cb');
            if (cb) cb.checked = allSel;
        }
    }
    // Re-color row
    const rows = document.querySelectorAll('#sp-content .reg-list-item');
    rows.forEach(row => {
        const cb = row.querySelector('input[type=checkbox]');
        if (cb) row.style.background = cb.checked ? 'rgba(86,169,255,0.06)' : '';
    });
}

function spToggleAll(checked) {
    const classMap = _spGetDrillData();
    const classEntry = classMap.get(_spDrillClass);
    if (!classEntry || !_spDrillSection) return;
    const sec = classEntry.sections.get(_spDrillSection);
    if (!sec) return;
    sec.students.forEach(s => {
        if (checked) _spSelectedRolls.add(s.rollNumber);
        else _spSelectedRolls.delete(s.rollNumber);
    });
    _spRender();
}

function spSelectAll() {
    if (_spDrillSection) {
        spToggleAll(true);
    } else {
        _spAllStudents.forEach(s => _spSelectedRolls.add(s.rollNumber));
        _spRender();
    }
}

function spClearAll() {
    _spSelectedRolls.clear();
    _spRender();
}




/* ═══════════════════════════════════════════════════════════
   AUTO GENERATE — State & Logic
   ═══════════════════════════════════════════════════════════ */

// ag = auto generate namespace
const _ag = {
    step: 'subjects',   // subjects | chapters | topics | config
    subject: null,      // currently browsed subject
    chapter: null,      // currently browsed chapter (in topics step)
    subStep: 'choose',  // choose | offline | online | loading | online-loading
    delivery: null,     // offline | online
    // selection: Map<"subject::chapter::topic", {subject,chapter,topic,count}>
    // topic = null means entire chapter selected
    selection: new Map(),
};

// Step names in order for footer info
const _AG_STEPS = ['subjects', 'chapters', 'topics', 'config'];

async function openAutoGenerateModal() {
    _ag.step = 'subjects';
    _ag.subject = null;
    _ag.chapter = null;
    _ag.subStep = 'choose';
    _ag.delivery = null;
    // Don't clear selection — let user keep from previous session
    _agShowStep('subjects');
    _agRenderSubjects();
    _agRenderTemplateList();
    _agUpdateFooter();
    document.getElementById('ag-overlay').classList.add('open');
    // Templates may not have been loaded yet (initial page-load fetch can run
    // before login → 401 → empty list). Refresh them now that we're authenticated
    // so the template chooser inside the modal shows the uploaded templates.
    if (typeof _templates === 'undefined' || !_templates.length) {
        try { await refreshTemplates(); } catch (e) { /* ignore */ }
        _agRenderTemplateList();
    }
}

function closeAutoGenerateModal() {
    _agClearLoaderTimers();
    document.getElementById('ag-overlay').classList.remove('open');
}

function agOverlayClick(e) {
    if (e.target === document.getElementById('ag-overlay')) closeAutoGenerateModal();
}

/* ── Step navigation ─── */
function _agShowStep(name) {
    _ag.step = name;
    _AG_STEPS.forEach(s => {
        const el = document.getElementById(`ag-step-${s}`);
        if (el) el.classList.toggle('active', s === name);
    });
    _agUpdateFooter();
}

function agStepNext() {
    if (_ag.step === 'subjects') {
        // must pick a subject first — done by clicking
        _agShowMessage('Click a subject card to browse its chapters.', 'info');
    } else if (_ag.step === 'chapters') {
        // move to config if something is selected
        if (_ag.selection.size === 0) { _agShowMessage('Select at least one chapter or topic first.', 'warn'); return; }
        _ag.subStep = 'choose'; // reset to chooser view
        _ag.delivery = null;
        _agShowStep('config');
        _agRenderSelectionPills();
        _agShowConfigSub('choose');
    } else if (_ag.step === 'topics') {
        // go back to chapters
        _agShowStep('chapters');
        _agRenderChapters(_ag.subject);
    } else if (_ag.step === 'config') {
        if (_ag.subStep === 'offline') {
            _agGeneratePaper();
        } else if (_ag.subStep === 'online') {
            agAssignOnlineTest();
        }
    }
}

function agStepBack() {
    if (_ag.step === 'chapters') { agGoToSubjects(); }
    else if (_ag.step === 'topics') { agGoToChapters(); }
    else if (_ag.step === 'config') {
        if (_ag.subStep === 'choose') {
            _agShowStep('chapters');
            _agRenderChapters(_ag.subject);
        } else {
            _ag.delivery = null;
            _agShowConfigSub('choose');
        }
    }
}

function agGoToSubjects() {
    _ag.subject = null;
    _ag.chapter = null;
    _ag.subStep = 'choose';
    _ag.delivery = null;
    _agShowStep('subjects');
    _agRenderSubjects();
}

function agGoToChapters() {
    _ag.chapter = null;
    _ag.subStep = 'choose';
    _ag.delivery = null;
    _agShowStep('chapters');
    _agRenderChapters(_ag.subject);
}

function _agShowConfigSub(sub) {
    _ag.subStep = sub;
    ['choose', 'offline', 'online', 'loading', 'online-loading'].forEach(name => {
        const el = document.getElementById(`ag-sub-${name}`);
        if (el) el.style.display = 'none';
    });

    const target = document.getElementById(`ag-sub-${sub}`);
    if (target) target.style.display = 'block';

    if (sub === 'offline') {
        const countInput = document.getElementById('ag-qcount');
        if (countInput && (!countInput.value || Number(countInput.value) < 1)) {
            const suggested = Math.max(1, Math.min(_agCountTotalAvailable() || 30, 30));
            countInput.value = String(suggested);
        }

        // Auto-populate header fields from selection
        const subjects = [...new Set([..._ag.selection.values()].map(s => s.subject).filter(Boolean))];
        const chapters = [...new Set([..._ag.selection.values()].map(s => s.chapter).filter(Boolean))];
        const subjectInput = document.getElementById('ag-subject-input');
        const chapterInput = document.getElementById('ag-chapter-input');
        const testTypeInput = document.getElementById('ag-test-type-input');
        if (subjectInput) subjectInput.value = subjects.join(' & ');
        if (chapterInput) chapterInput.value = chapters.join(' & ');
        if (testTypeInput) testTypeInput.value = 'Chapter Test';

        _agRenderTemplateList();
    } else if (sub === 'online') {
        agOtUpdateDurPreview();
        _agUpdateAgAssignedSummary();
    } else if (sub === 'choose') {
        _ag.delivery = null;
    }

    _agUpdateFooter();
}

function agChooseDelivery(kind) {
    if (!kind) {
        _ag.delivery = null;
        _agShowConfigSub('choose');
        return;
    }

    _ag.delivery = kind;
    if (kind === 'offline') {
        _agShowConfigSub('offline');
        _agInjectFilters('offline');
    } else if (kind === 'online') {
        _agShowConfigSub('online');
        _agInjectFilters('online');

        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const toLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const oneWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const titleInput = document.getElementById('ag-ot-name');
        if (titleInput) titleInput.value = (document.getElementById('ag-paper-title')?.value || 'Online Test').trim();

        const correctInput = document.getElementById('ag-ot-marks-correct');
        const wrongInput = document.getElementById('ag-ot-marks-wrong');
        const liveInput = document.getElementById('ag-ot-live-at');
        const endsInput = document.getElementById('ag-ot-ends-at');
        const durationInput = document.getElementById('ag-ot-duration');
        const attemptsInput = document.getElementById('ag-ot-max-attempts');

        if (correctInput) correctInput.value = 4;
        if (wrongInput) wrongInput.value = -1;
        if (liveInput) liveInput.value = toLocal(now);
        if (endsInput) endsInput.value = toLocal(oneWeek);
        const qcountInput = document.getElementById('ag-ot-qcount');
        if (qcountInput) qcountInput.value = String(Math.max(1, Math.min(_agCountTotalAvailable() || 30, 30)));
        if (durationInput) durationInput.value = String(Math.max(30, Math.min(180, Math.ceil((_agCountTotalAvailable() || 30) * 1.5))));
        if (attemptsInput) attemptsInput.value = '1';

        _agOtAssignedRolls = _agOtAssignedRolls || [];
        _agOtStrictEnabled = false;
        _agUpdateStrictLabel();
        _agUpdateAgAssignedSummary();
        agOtUpdateDurPreview();
        agOtUpdateScheduleGap();
    }
}

function _agUpdateFooter() {
    const backBtn = document.getElementById('ag-btn-back');
    const nextBtn = document.getElementById('ag-btn-next');
    const info = document.getElementById('ag-footer-info');
    const headerSub = document.getElementById('ag-header-sub');

    backBtn.style.display = ['chapters', 'topics', 'config'].includes(_ag.step) ? '' : 'none';

    if (_ag.step === 'subjects') {
        nextBtn.textContent = 'Next →';
        nextBtn.style.display = 'none';
        nextBtn.style.background = 'linear-gradient(135deg,var(--accent),var(--accent-2))';
        nextBtn.style.color = 'var(--ag-btn-text)';
        if (headerSub) headerSub.textContent = 'Select subjects, chapters & topics';
    } else if (_ag.step === 'chapters') {
        nextBtn.textContent = `Review Selection →`;
        nextBtn.style.display = '';
        nextBtn.style.background = 'linear-gradient(135deg,var(--accent),var(--accent-2))';
        nextBtn.style.color = 'var(--ag-btn-text)';
        if (headerSub) headerSub.textContent = `${_ag.subject || ''} — Select chapters`;
    } else if (_ag.step === 'topics') {
        nextBtn.textContent = '← Back to Chapters';
        nextBtn.style.display = '';
        nextBtn.style.background = 'linear-gradient(135deg,var(--accent),var(--accent-3))';
        nextBtn.style.color = 'var(--ag-btn-text)';
        if (headerSub) headerSub.textContent = `${_ag.chapter || ''} — Select topics`;
    } else if (_ag.step === 'config') {
        const sub = _ag.subStep || 'choose';
        if (sub === 'choose') {
            nextBtn.style.display = 'none';
            backBtn.style.display = '';
            if (headerSub) headerSub.textContent = 'Choose how to deliver this paper';
        } else if (sub === 'offline') {
            nextBtn.textContent = '✨ Generate Paper';
            nextBtn.style.display = '';
            agOtUpdateScheduleGap();
            nextBtn.style.background = 'linear-gradient(135deg,var(--accent),var(--accent-3))';
            nextBtn.style.color = 'var(--ag-btn-text)';
            if (headerSub) headerSub.textContent = 'Configure & generate offline paper';
        } else if (sub === 'online') {
            nextBtn.textContent = '🚀 Assign Online Test';
            nextBtn.style.display = '';
            nextBtn.style.background = 'linear-gradient(135deg,var(--accent),var(--accent-2))';
            nextBtn.style.color = 'var(--ag-btn-text)';
            if (headerSub) headerSub.textContent = 'Configure & assign online test';
        } else if (sub === 'loading') {
            nextBtn.style.display = 'none';
            backBtn.style.display = 'none';
        } else if (sub === 'online-loading') {
            nextBtn.style.display = 'none';
            backBtn.style.display = 'none';
            if (headerSub) headerSub.textContent = 'Publishing the online test…';
        }
    }

    const selCount = _ag.selection.size;
    if (selCount > 0) {
        info.textContent = `${selCount} selection${selCount !== 1 ? 's' : ''} · ${_agCountTotalAvailable()} questions available`;
    } else {
        info.textContent = '';
    }
}

/* ── Step 1: Subjects ─── */
function _agRenderSubjects() {
    const grid = document.getElementById('ag-subject-grid');
    if (!grid) return;

    // Build subjects list from allQuestions
    const subjects = {};
    (typeof allQuestions !== 'undefined' ? allQuestions : []).forEach(row => {
        const s = (typeof getSubjectForRow === 'function' ? getSubjectForRow(row) : null) || 'General';
        if (!subjects[s]) subjects[s] = { count: 0, chapters: new Set() };
        subjects[s].count += Array.isArray(row.questions) ? row.questions.length : (row.questionCount || 0);
        subjects[s].chapters.add(row.chapter || '(No Chapter)');
    });

    const order = ['Physics', 'Chemistry', 'Mathematics'];
    const ICONS = { Physics: '⚛️', Chemistry: '🧪', Mathematics: '📐', General: '📚' };
    const COLOR_VARS = { Physics: 'var(--accent)', Chemistry: 'var(--accent-2)', Mathematics: 'var(--accent-4)', General: 'var(--accent-3)' };

    const sorted = Object.keys(subjects).sort((a, b) => {
        const ai = order.indexOf(a), bi = order.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    if (!sorted.length) {
        grid.innerHTML = '<div style="color:var(--text-muted);grid-column:1/-1;padding:20px;text-align:center">No questions in the database yet.</div>';
        return;
    }

    grid.innerHTML = sorted.map(subj => {
        const { count, chapters } = subjects[subj];
        const icon = ICONS[subj] || '📚';
        const colorVar = COLOR_VARS[subj] || 'var(--accent-3)';
        return `<div class="ag-subject-card" onclick="agSelectSubject('${_agEsc(subj)}')" style="--card-tint:color-mix(in srgb, ${colorVar} 16%, transparent)">
            <div class="ag-subject-card-icon">${icon}</div>
            <div class="ag-subject-card-title">${_agEsc(subj)}</div>
            <div class="ag-subject-card-meta">${count} Q · ${chapters.size} Chapters</div>
        </div>`;
    }).join('');
}

function agSelectSubject(subj) {
    _ag.subject = subj;
    document.getElementById('ag-bc-subject').textContent = subj;
    document.getElementById('ag-bc-subject2').textContent = subj;
    _agShowStep('chapters');
    _agRenderChapters(subj);
}

/* ── Step 2: Chapters ─── */
function _agRenderChapters(subject) {
    const grid = document.getElementById('ag-chapter-grid');
    if (!grid) return;

    const rows = (typeof allQuestions !== 'undefined' ? allQuestions : [])
        .filter(r => ((typeof getSubjectForRow === 'function' ? getSubjectForRow(r) : null) || 'General') === subject);

    const chapters = {};
    rows.forEach(row => {
        const ch = row.chapter || '(No Chapter)';
        if (!chapters[ch]) chapters[ch] = { qCount: 0, topics: new Set(), rows: [] };
        chapters[ch].qCount += Array.isArray(row.questions) ? row.questions.length : (row.questionCount || 0);
        if (row.topic) chapters[ch].topics.add(row.topic);
        chapters[ch].rows.push(row);
    });

    const names = Object.keys(chapters).sort();
    if (!names.length) {
        grid.innerHTML = '<div style="color:var(--text-muted);grid-column:1/-1;padding:20px">No chapters found.</div>';
        return;
    }

    grid.innerHTML = names.map(ch => {
        const { qCount, topics } = chapters[ch];
        const fullKey = subject + '::' + ch + '::__all__';
        const isFullySelected = _ag.selection.has(fullKey);
        // Partial: any topic-level selections for this chapter
        const topicKeys = [..._ag.selection.keys()].filter(k => k.startsWith(subject + '::' + ch + '::') && !k.endsWith('::__all__'));
        const hasTopicSelections = topicKeys.length > 0;
        const selectedTopicCount = topicKeys.length;
        const totalTopics = topics.size;

        let statusBadge = '';
        let cardClass = '';
        let chkId = 'ag-chk-' + _agEscId(subject) + '-' + _agEscId(ch);
        if (isFullySelected) {
            cardClass = 'chapter-selected';
            statusBadge = '<span style="color:var(--success);margin-left:6px;font-weight:700">✓ All selected</span>';
        } else if (hasTopicSelections) {
            cardClass = 'chapter-selected';
            statusBadge = '<span style="color:var(--accent-4);margin-left:6px;font-weight:700">◑ ' + selectedTopicCount + '/' + (totalTopics || selectedTopicCount) + ' topic' + (selectedTopicCount !== 1 ? 's' : '') + ' selected</span>';
        }

        return '<div class="ag-chapter-card ' + cardClass + '" id="ag-ch-card-' + _agEscId(ch) + '"\n' +
            '    onclick="agChapterCardClick(event,\'' + _agEscArg(subject) + '\',\'' + _agEscArg(ch) + '\')">\n' +
            '    <input type="checkbox" class="ag-ch-checkbox" ' + (isFullySelected ? 'checked' : '') + ' id="' + chkId + '"\n' +
            '        onclick="event.stopPropagation();agToggleChapter(\'' + _agEscArg(subject) + '\',\'' + _agEscArg(ch) + '\',this.checked)"\n' +
            '        title="Select entire chapter">\n' +
            '    <div style="font-size:1.4rem;margin-bottom:6px">' + (typeof getChapterEmoji === 'function' ? getChapterEmoji(ch) : '\uD83D\uDCDA') + '</div>\n' +
            '    <div style="font-weight:700;font-size:0.88rem;color:var(--text);word-break:break-word;padding-right:24px">' + _agEsc(typeof formatChapterLabel === 'function' ? formatChapterLabel(ch) : ch) + '</div>\n' +
            '    <div style="font-size:0.72rem;color:var(--text-dim);margin-top:5px">' + qCount + ' Q' + (topics.size > 0 ? ' \u00b7 ' + topics.size + ' topic' + (topics.size !== 1 ? 's' : '') : '') + statusBadge + '</div>\n' +
            '</div>';
    }).join('');

    // Apply indeterminate state via JS for partial selections
    names.forEach(ch => {
        const fullKey = subject + '::' + ch + '::__all__';
        const isFullySelected = _ag.selection.has(fullKey);
        const hasPartial = [..._ag.selection.keys()].some(k => k.startsWith(subject + '::' + ch + '::') && !k.endsWith('::__all__'));
        if (hasPartial && !isFullySelected) {
            const cb = document.getElementById('ag-chk-' + _agEscId(subject) + '-' + _agEscId(ch));
            if (cb) cb.indeterminate = true;
        }
    });
}
function agChapterCardClick(e, subject, ch) {
    // If clicking the card body (not the checkbox), drill into topics
    if (e.target.type === 'checkbox') return;
    _ag.chapter = ch;
    document.getElementById('ag-bc-chapter').textContent = typeof formatChapterLabel === 'function' ? formatChapterLabel(ch) : ch;
    _agShowStep('topics');
    _agRenderTopics(subject, ch);
}

function agToggleChapter(subject, ch, checked) {
    const key = `${subject}::${ch}::__all__`;
    if (checked) {
        // Remove any individual topic selections for this chapter
        for (const k of [..._ag.selection.keys()]) {
            if (k.startsWith(`${subject}::${ch}::`)) _ag.selection.delete(k);
        }
        const rows = (typeof allQuestions !== 'undefined' ? allQuestions : [])
            .filter(r => ((typeof getSubjectForRow === 'function' ? getSubjectForRow(r) : null) || 'General') === subject && (r.chapter || '(No Chapter)') === ch);
        const qCount = rows.reduce((s, r) => s + (Array.isArray(r.questions) ? r.questions.length : (r.questionCount || 0)), 0);
        _ag.selection.set(key, { subject, chapter: ch, topic: null, qCount });
    } else {
        _ag.selection.delete(key);
    }
    _agRenderChapters(subject);
    _agUpdateFooter();
}

/* ── Step 3: Topics ─── */
function _agRenderTopics(subject, ch) {
    const grid = document.getElementById('ag-topic-grid');
    if (!grid) return;

    const rows = (typeof allQuestions !== 'undefined' ? allQuestions : [])
        .filter(r => ((typeof getSubjectForRow === 'function' ? getSubjectForRow(r) : null) || 'General') === subject && (r.chapter || '(No Chapter)') === ch);

    // Group by topic
    const topics = {};
    rows.forEach(row => {
        const t = row.topic || '(General)';
        if (!topics[t]) topics[t] = 0;
        topics[t] += Array.isArray(row.questions) ? row.questions.length : (row.questionCount || 0);
    });

    const names = Object.keys(topics).sort();
    if (!names.length) {
        grid.innerHTML = '<div style="color:var(--text-muted);grid-column:1/-1;padding:20px">No topics found. Use the checkbox on the chapter card to select the whole chapter.</div>';
        return;
    }

    grid.innerHTML = names.map(t => {
        const key = `${subject}::${ch}::${t}`;
        const isSelected = _ag.selection.has(key);
        return `<div class="ag-topic-card ${isSelected ? 'topic-selected' : ''}"
            onclick="agToggleTopic('${_agEscArg(subject)}','${_agEscArg(ch)}','${_agEscArg(t)}')">
            <div style="font-weight:700;font-size:0.85rem;color:var(--text);word-break:break-word">${_agEsc(t)}</div>
            <div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px">${topics[t]} question${topics[t] !== 1 ? 's' : ''}</div>
            ${isSelected ? '<div style="font-size:0.7rem;color:var(--accent-2);font-weight:700;margin-top:6px">✓ Selected</div>' : ''}
        </div>`;
    }).join('');
}

function agToggleTopic(subject, ch, topic) {
    const key = `${subject}::${ch}::${topic}`;
    // Remove whole-chapter selection if present
    const chapterKey = `${subject}::${ch}::__all__`;
    _ag.selection.delete(chapterKey);

    if (_ag.selection.has(key)) {
        _ag.selection.delete(key);
    } else {
        const rows = (typeof allQuestions !== 'undefined' ? allQuestions : [])
            .filter(r => ((typeof getSubjectForRow === 'function' ? getSubjectForRow(r) : null) || 'General') === subject && (r.chapter || '(No Chapter)') === ch && (r.topic || '(General)') === topic);
        const qCount = rows.reduce((s, r) => s + (Array.isArray(r.questions) ? r.questions.length : (r.questionCount || 0)), 0);
        _ag.selection.set(key, { subject, chapter: ch, topic, qCount });
    }
    _agRenderTopics(subject, ch);
    _agUpdateFooter();
}

/* ── Step 4: Config ─── */
function _agRenderSelectionPills() {
    const container = document.getElementById('ag-selection-pills');
    if (!container) return;
    if (_ag.selection.size === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem">No selections yet. Go back to choose chapters/topics.</div>';
        return;
    }
    container.innerHTML = [..._ag.selection.entries()].map(([key, { subject, chapter, topic, qCount }]) => {
        const label = topic && topic !== '__all__' ? `${typeof formatChapterLabel === 'function' ? formatChapterLabel(chapter) : chapter} › ${topic}` : (typeof formatChapterLabel === 'function' ? formatChapterLabel(chapter) : chapter);
        return `<span class="ag-selection-pill" onclick="agRemoveSelection('${_agEscArg(key)}')">
            <span>${subject} · ${label}</span>
            <span style="font-size:0.7rem;color:var(--text-muted)">(${qCount}Q)</span>
            <span class="ag-pill-remove">✕</span>
        </span>`;
    }).join('');
}

function agRemoveSelection(key) {
    _ag.selection.delete(key);
    _agRenderSelectionPills();
    _agUpdateFooter();
    if (_ag.selection.size === 0) {
        _agShowStep('chapters');
        _agRenderChapters(_ag.subject);
    }
}

function _agCountTotalAvailable() {
    return [..._ag.selection.values()].reduce((s, v) => s + (v.qCount || 0), 0);
}

function _agRenderTemplateList() {
    const container = document.getElementById('ag-template-list');
    if (!container) return;

    if (typeof _templates === 'undefined' || !_templates.length) {
        container.innerHTML = '<div style="font-size:0.8rem;color:var(--text-muted);padding:10px 12px;background:var(--bg-input);border-radius:9px">No templates uploaded yet. Default styling will be used.</div>';
        return;
    }

    if (typeof _selectedTemplateId === 'undefined' || !_selectedTemplateId || !_templates.find(t => t.id === _selectedTemplateId)) {
        _selectedTemplateId = _templates[0].id;
    }

    container.innerHTML = _templates.map(t => {
        const isSelected = _selectedTemplateId === t.id;
        const date = new Date(t.createdAt).toLocaleDateString();
        return `<div class="ag-tpl-row ${isSelected ? 'ag-tpl-selected' : ''}" onclick="selectModalTemplate(${t.id})">
            <span style="font-size:0.95rem">${isSelected ? '✅' : '📄'}</span>
            <span style="flex:1;font-size:0.83rem;font-weight:${isSelected ? '700' : '500'};color:var(--text)">${_agEsc(t.name)}</span>
            <span style="font-size:0.72rem;color:var(--text-muted)">${date}</span>
        </div>`;
    }).join('');
}

let _agOtAssignedRolls = [];
let _agOtLoadingTimer = null;
let _agOtLoadingTipTimer = null;
let _agOtStrictEnabled = false;

function _agUpdateStrictLabel() {
    const toggle = document.getElementById('ag-ot-strict-toggle');
    const thumb = document.getElementById('ag-ot-strict-thumb');
    const text = document.getElementById('ag-ot-strict-text');
    if (toggle) {
        toggle.style.background = _agOtStrictEnabled ? 'var(--success)' : 'var(--border)';
        toggle.style.borderColor = _agOtStrictEnabled ? 'var(--success)' : 'var(--border)';
    }
    if (thumb) thumb.style.transform = _agOtStrictEnabled ? 'translateX(16px)' : 'translateX(0)';
    if (text) text.textContent = _agOtStrictEnabled ? 'Strict Mode On' : 'Strict Mode';
}

function agToggleStrictMode() {
    _agOtStrictEnabled = !_agOtStrictEnabled;
    _agUpdateStrictLabel();
}

function agOtUpdateDurPreview() {
    const durationInput = document.getElementById('ag-ot-duration');
    const preview = document.getElementById('ag-ot-dur-preview');
    if (!durationInput || !preview) return;
    const minutes = Math.max(5, parseInt(durationInput.value || '0', 10) || 0);
    preview.textContent = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60 ? `${minutes % 60}m` : ''} duration` : `${minutes} minute${minutes === 1 ? '' : 's'} duration`;
}

function agOpenDatePicker(field) {
    const input = document.getElementById(`ag-ot-${field}-at`);
    if (!input) return;
    if (typeof input.showPicker === 'function') input.showPicker();
    input.focus();
}

function _agFmtDt(val) {
    if (!val) return '';
    const d = new Date(val);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' +
        d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function agOtUpdateScheduleGap() {
    const lv = document.getElementById('ag-ot-live-at')?.value;
    const ev = document.getElementById('ag-ot-ends-at')?.value;
    const gap = document.getElementById('ag-ot-schedule-gap');
    const lp = document.getElementById('ag-ot-live-preview');
    const ep = document.getElementById('ag-ot-ends-preview');
    const lText = document.getElementById('ag-ot-live-display-text');
    const eText = document.getElementById('ag-ot-ends-display-text');

    if (lText) lText.textContent = lv ? _agFmtDt(lv) : 'Select date & time';
    if (eText) eText.textContent = ev ? _agFmtDt(ev) : 'Select date & time';
    if (lp) lp.textContent = _agFmtDt(lv);
    if (ep) ep.textContent = _agFmtDt(ev);
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

document.addEventListener('change', function (e) {
    if (e.target.id === 'ag-ot-live-at' || e.target.id === 'ag-ot-ends-at') agOtUpdateScheduleGap();
    if (e.target.id === 'ag-ot-duration') agOtUpdateDurPreview();
});

document.addEventListener('input', function (e) {
    if (e.target.id === 'ag-ot-live-at' || e.target.id === 'ag-ot-ends-at') agOtUpdateScheduleGap();
    if (e.target.id === 'ag-ot-duration') agOtUpdateDurPreview();
});

function _agUpdateAgAssignedSummary() {
    const el = document.getElementById('ag-ot-assigned-summary');
    if (!el) return;
    if (!_agOtAssignedRolls.length) {
        el.innerHTML = 'No students selected yet.';
        return;
    }
    el.innerHTML = `<span style="color:var(--success);font-weight:700">${_agOtAssignedRolls.length} student${_agOtAssignedRolls.length !== 1 ? 's' : ''} selected</span>
    <span style="color:var(--text-muted);margin-left:6px;font-size:0.78rem">${_agOtAssignedRolls.slice(0, 8).join(', ')}${_agOtAssignedRolls.length > 8 ? ` …+${_agOtAssignedRolls.length - 8} more` : ''}</span>`;
}

function agOpenStudentPicker() {
    if (typeof openStudentPicker !== 'function') return;
    _spOnConfirm = function (rolls) {
        _agOtAssignedRolls = rolls;
        _agUpdateAgAssignedSummary();
    };
    openStudentPicker(_agOtAssignedRolls || []);
}

function _agShowAgLoading(subStep) {
    _agShowConfigSub(subStep);
}

function _agUpdateProgress(kind, pct, serverStep) {
    const isOnline = kind === 'online';
    const bar = document.getElementById(isOnline ? 'ag-ol-bar' : 'ag-loader-bar');
    const headline = document.getElementById(isOnline ? 'ag-ol-headline' : 'ag-loader-headline');
    const sub = document.getElementById(isOnline ? 'ag-ol-sub' : 'ag-loader-sub');
    const tip = document.getElementById(isOnline ? 'ag-ol-tip' : 'ag-loader-tip');

    if (bar) {
        bar.style.width = `${pct}%`;
        bar.title = `${pct}%`;
    }
    if (headline) headline.textContent = isOnline ? 'Preparing online test…' : 'Generating your paper…';

    const steps = isOnline ? ['pick', 'build', 'students', 'portal'] : ['pick', 'build', 'latex', 'template', 'pack'];
    const tips = isOnline ? [
        'Tip: you can reopen this later to change the schedule.',
        'Tip: strict mode helps keep live tests locked down.',
        'Tip: student selection uses the shared picker.'
    ] : [
        'Tip: templates make the paper feel more polished.',
        'Tip: you can keep this open while files are prepared.',
        'Tip: offline generation still uses your selected chapters and topics.'
    ];

    let activeId = 'pick';
    if (!isOnline) {
        if (serverStep === 'build') activeId = 'build';
        else if (serverStep === 'latex') activeId = 'latex';
        else if (serverStep === 'template') activeId = 'template';
        else if (serverStep === 'finalise') activeId = 'pack';
    }

    const labels = isOnline ? {
        pick: 'Picking questions from your selection…',
        build: 'Building the online test structure…',
        students: 'Assigning the test to students…',
        portal: 'Publishing to the student portal…'
    } : {
        pick: 'Picking questions from pool…',
        build: 'Building document structure…',
        latex: 'Rendering equations (LaTeX)…',
        template: 'Applying template styling…',
        pack: 'Packaging download files…'
    };

    if (sub && labels[activeId]) {
        sub.textContent = labels[activeId];
    }

    if (tip) {
        const tipIdx = Math.floor(pct / 30) % tips.length;
        tip.textContent = tips[tipIdx];
    }

    const activeIndex = steps.indexOf(activeId);
    steps.forEach((id, sIndex) => {
        const stepEl = document.getElementById(`${isOnline ? 'ag-ol' : 'ag-l'}s-${id}`);
        if (!stepEl) return;
        const dataLabel = stepEl.dataset.label || id;
        const emoji = stepEl.dataset.emoji || '';
        if (sIndex < activeIndex) {
            stepEl.className = 'ag-lstep ls-done';
            stepEl.innerHTML = `<span class="ag-ls-status">✓</span><span>${emoji ? emoji + ' ' : ''}${dataLabel}</span>`;
        } else if (id === activeId) {
            stepEl.className = 'ag-lstep ls-active';
            stepEl.innerHTML = `<span class="ag-ls-status">⚙</span><span>${emoji ? emoji + ' ' : ''}${dataLabel}…</span>`;
        } else {
            stepEl.className = 'ag-lstep';
            stepEl.innerHTML = `<span class="ag-ls-status">⏳</span><span>${dataLabel}</span>`;
        }
    });
}

function _agClearLoaderTimers() {
    clearTimeout(_agOtLoadingTimer);
    clearInterval(_agOtLoadingTipTimer);
    _agOtLoadingTimer = null;
    _agOtLoadingTipTimer = null;
}

async function agAssignOnlineTest() {
    const testName = (document.getElementById('ag-paper-title')?.value || 'Online Test').trim();
    const requestedCount = parseInt(document.getElementById('ag-ot-qcount')?.value || '0', 10);
    const marksCorrect = parseFloat(document.getElementById('ag-ot-marks-correct')?.value || '4') || 4;
    const marksWrong = parseFloat(document.getElementById('ag-ot-marks-wrong')?.value || '-1');
    const liveAtVal = document.getElementById('ag-ot-live-at')?.value;
    const endsAtVal = document.getElementById('ag-ot-ends-at')?.value;
    const durationMinutes = parseInt(document.getElementById('ag-ot-duration')?.value || '90', 10) || 90;
    const maxAttempts = parseInt(document.getElementById('ag-ot-max-attempts')?.value || '1', 10) || 1;
    const errEl = document.getElementById('ag-config-error');

    const showErr = msg => {
        if (!errEl) return;
        errEl.textContent = msg;
        errEl.style.display = 'block';
    };

    if (!testName) return showErr('Please enter a test name.');
    if (!requestedCount || requestedCount < 1) return showErr('Please enter a valid question count (≥ 1).');
    if (!liveAtVal || !endsAtVal) return showErr('Please set both live and end times.');
    const liveAt = new Date(liveAtVal).getTime();
    const endsAt = new Date(endsAtVal).getTime();
    if (endsAt <= liveAt) return showErr('End time must be after start time.');
    if (!_agOtAssignedRolls.length) return showErr('Please select at least one student.');
    if (!_ag.selection.size) return showErr('No questions in your selection.');

    // Ensure question data is loaded so the exam/type filters can inspect real
    // question objects, then build candidate keys honouring those filters.
    await _agEnsureSelectionLoaded();
    const _otCandidates = [];
    for (const item of _ag.selection.values()) {
        const rows = (typeof allQuestions !== 'undefined' ? allQuestions : []).filter(r => {
            const rs = (typeof getSubjectForRow === 'function' ? getSubjectForRow(r) : null) || 'General';
            if (rs !== item.subject) return false;
            if ((r.chapter || '(No Chapter)') !== item.chapter) return false;
            if (item.topic && item.topic !== '__all__' && item.topic !== '(General)') {
                if ((r.topic || '(General)') !== item.topic) return false;
            }
            if (item.topic === '(General)' && (r.topic || '(General)') !== '(General)') return false;
            return true;
        });
        rows.forEach(row => {
            if (!Array.isArray(row.questions)) return;
            row.questions.forEach((q, questionIndex) => {
                if (!_agPassExamType(q, 'online')) return;
                _otCandidates.push({
                    chapter: row.chapter === '(No Chapter)' ? '' : (row.chapter || ''),
                    lecture: row.lecture,
                    questionIndex,
                });
            });
        });
    }
    const questionKeys = _otCandidates.sort(() => Math.random() - 0.5).slice(0, requestedCount);

    if (!questionKeys.length) return showErr('No questions could be loaded for this selection.');

    const nextBtn = document.getElementById('ag-btn-next');
    if (nextBtn) {
        nextBtn.disabled = true;
        nextBtn.textContent = '⏳ Assigning…';
    }

    if (errEl) errEl.style.display = 'none';
    _agShowAgLoading('online-loading');
    _agAnimateLoader('online');

    try {
        const resp = await fetch(`${API_BASE}/api/admin/online-tests`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                testName,
                questionKeys,
                marksCorrect,
                marksWrong,
                liveAt,
                endsAt,
                durationMinutes,
                assignedRolls: _agOtAssignedRolls,
                maxAttempts,
                isStrict: !!_agOtStrictEnabled,
            })
        });
        const data = await resp.json();
        if (!resp.ok || !data.success) throw new Error(data.error || 'Failed to assign online test');

        _agClearLoaderTimers();
        if (nextBtn) {
            nextBtn.textContent = '🚀 Assign Online Test';
            nextBtn.disabled = false;
        }
        closeAutoGenerateModal();
        if (typeof showOtSuccessToast === 'function') {
            showOtSuccessToast(`Online test assigned to ${_agOtAssignedRolls.length} student${_agOtAssignedRolls.length !== 1 ? 's' : ''}!`);
        }
    } catch (err) {
        _agClearLoaderTimers();
        _agShowConfigSub('online');
        if (errEl) {
            errEl.textContent = '❌ Error: ' + (err.message || 'Failed to assign online test');
            errEl.style.display = 'block';
        }
        if (nextBtn) {
            nextBtn.disabled = false;
            nextBtn.textContent = '🚀 Assign Online Test';
        }
    }
}

/* ── Auto-generate exam + question-type filters (offline & online) ── */
// Derive exam for a question object: explicit exam field wins, else subject
// (Maths → JEE Mains, everything else → NEET) — mirrors the backend rule.
function _agExamOf(q) {
    const e = q && (q.exam || q.examName || q.exam_name);
    if (e) {
        const s = String(e).toLowerCase();
        if (s.includes('advanced')) return 'JEE Advanced';
        if (s.includes('neet')) return 'NEET';
        if (s.includes('jee') || s.includes('main')) return 'JEE Mains';
    }
    const subj = String((q && q.subject) || '').toLowerCase();
    if (subj.includes('math')) return 'JEE Mains';
    return 'NEET';
}

// True if question q passes the exam + type filters for the given panel.
function _agPassExamType(q, kind) {
    const pre = kind === 'online' ? 'ag-ot-filter-' : 'ag-filter-';
    const exVal = document.getElementById(pre + 'exam')?.value || '';
    const tyVal = document.getElementById(pre + 'type')?.value || '';
    if (exVal && _agExamOf(q) !== exVal) return false;
    if (tyVal) {
        const t = String(q.question_type || q.questionType || 'MCQ').toUpperCase();
        if (t !== tyVal) return false;
    }
    return true;
}

// Inject the exam + question-type filter selects into the offline/online panel
// (once). ids: offline ag-filter-exam/ag-filter-type, online ag-ot-filter-*.
function _agInjectFilters(kind) {
    const pre = kind === 'online' ? 'ag-ot-filter-' : 'ag-filter-';
    if (document.getElementById(pre + 'exam')) return;
    const host = document.getElementById(kind === 'online' ? 'ag-sub-online' : 'ag-sub-offline');
    if (!host) return;
    const examOpts = [['', 'All Exams'], ['JEE Mains', 'JEE Mains'], ['JEE Advanced', 'JEE Advanced'], ['NEET', 'NEET']];
    const typeOpts = [['', 'All Types'], ['MCQ', 'MCQ'], ['MSQ', 'MSQ'], ['INTEGER', 'Numerical'], ['COMPREHENSION', 'Linked Comprehension'], ['ASSERTION_REASON', 'Assertion & Reason'], ['MATRIX_MATCH', 'Matrix Matching']];
    const sel = (id, opts) => `<select id="${id}" class="ag-input" style="max-width:230px">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`;
    const div = document.createElement('div');
    div.className = 'ag-config-panel';
    div.innerHTML = `<div style="font-size:0.72rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:10px">🎯 Filter by Exam & Question Type</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">${sel(pre + 'exam', examOpts)}${sel(pre + 'type', typeOpts)}</div>`;
    host.insertBefore(div, host.firstChild);
}

// Ensure every row matched by the current selection has its questions loaded,
// so the online exam/type filters can inspect real question objects.
async function _agEnsureSelectionLoaded() {
    const rowsAll = typeof allQuestions !== 'undefined' ? allQuestions : [];
    const matched = [];
    for (const item of _ag.selection.values()) {
        rowsAll.forEach(r => {
            const rs = (typeof getSubjectForRow === 'function' ? getSubjectForRow(r) : null) || 'General';
            if (rs !== item.subject) return;
            if ((r.chapter || '(No Chapter)') !== item.chapter) return;
            if (item.topic && item.topic !== '__all__' && item.topic !== '(General)') {
                if ((r.topic || '(General)') !== item.topic) return;
            }
            if (item.topic === '(General)' && (r.topic || '(General)') !== '(General)') return;
            if (!matched.includes(r)) matched.push(r);
        });
    }
    const need = [...new Set(matched.filter(r => r._metaOnly || !Array.isArray(r.questions) || r.questions.length === 0).map(r => r.chapter || null))];
    if (need.length && typeof ensureChapterLoaded === 'function') {
        await Promise.all(need.map(ch => ensureChapterLoaded(ch)));
    }
}

/* ── Generate Paper ─── */
async function _agGeneratePaper() {
    const countInput = document.getElementById('ag-qcount');
    const titleInput = document.getElementById('ag-paper-title');
    const errEl = document.getElementById('ag-config-error');
    const nextBtn = document.getElementById('ag-btn-next');

    const requestedCount = parseInt(countInput?.value || '0', 10);
    if (!requestedCount || requestedCount < 1) {
        errEl.textContent = 'Please enter a valid question count (≥ 1).';
        errEl.style.display = 'block'; return;
    }

    const totalAvailable = _agCountTotalAvailable();
    if (totalAvailable === 0) {
        errEl.textContent = 'No questions match your selection.';
        errEl.style.display = 'block'; return;
    }

    errEl.style.display = 'none';
    const paperTitle = (titleInput?.value || 'Question Paper').trim();
    const paperClass = (document.getElementById('ag-class-input')?.value || '').trim();
    const paperSubject = (document.getElementById('ag-subject-input')?.value || '').trim();
    const paperChapter = (document.getElementById('ag-chapter-input')?.value || '').trim();
    const paperTestType = (document.getElementById('ag-test-type-input')?.value || '').trim();

    // Show loading while we fetch questions
    nextBtn.disabled = true;
    nextBtn.textContent = '⏳ Loading questions…';
    _agShowAgLoading('loading');
    _agUpdateProgress('offline', 5, 'pick');

    try {
        // Collect all rows that match the selection
        const rowsAll = typeof allQuestions !== 'undefined' ? allQuestions : [];
        const matchedRows = [];

        for (const [key, sel] of _ag.selection.entries()) {
            const { subject, chapter, topic } = sel;
            const rows = rowsAll.filter(r => {
                const rs = (typeof getSubjectForRow === 'function' ? getSubjectForRow(r) : null) || 'General';
                if (rs !== subject) return false;
                if ((r.chapter || '(No Chapter)') !== chapter) return false;
                if (topic && topic !== '__all__' && topic !== '(General)') {
                    if ((r.topic || '(General)') !== topic) return false;
                }
                if (topic === '(General)' && (r.topic || '(General)') !== '(General)') return false;
                return true;
            });
            rows.forEach(r => { if (!matchedRows.includes(r)) matchedRows.push(r); });
        }

        // Identify which chapters still need full question data fetched (lazy-loaded rows have _metaOnly:true)
        const chaptersNeedingLoad = [...new Set(
            matchedRows.filter(r => r._metaOnly || !Array.isArray(r.questions) || r.questions.length === 0)
                .map(r => r.chapter || null)
        )];

        if (chaptersNeedingLoad.length > 0) {
            // ensureChapterLoaded batch-fetches all rows for a chapter at once (most efficient)
            if (typeof ensureChapterLoaded === 'function') {
                await Promise.all(chaptersNeedingLoad.map(ch => ensureChapterLoaded(ch)));
            } else if (typeof ensureRowLoaded === 'function') {
                // Fallback: load row by row
                const unloaded = matchedRows.filter(r => r._metaOnly || !Array.isArray(r.questions) || r.questions.length === 0);
                await Promise.all(unloaded.map(row => {
                    const gi = rowsAll.indexOf(row);
                    return gi !== -1 ? ensureRowLoaded(gi) : Promise.resolve();
                }));
            } else {
                // Last resort: fetch via REST API
                await Promise.all(matchedRows
                    .filter(r => !Array.isArray(r.questions) || r.questions.length === 0)
                    .map(async (row) => {
                        try {
                            const ch = encodeURIComponent(row.chapter || '_none_');
                            const lec = encodeURIComponent(row.lecture || '');
                            const resp = await fetch(API_BASE + '/api/question/' + ch + '/' + lec, { credentials: 'include' });
                            if (resp.ok) {
                                const data = await resp.json();
                                if (Array.isArray(data.questions)) row.questions = data.questions;
                            }
                        } catch (e) { /* skip */ }
                    })
                );
            }
        }

        // Read PYQ filter checkboxes
        const filterPyq = document.getElementById('ag-filter-pyq')?.checked;
        const filterOther = document.getElementById('ag-filter-other')?.checked;

        // Build pool from all matched rows
        const pool = [];
        for (const [key, sel] of _ag.selection.entries()) {
            const { subject, chapter, topic } = sel;
            const rows = rowsAll.filter(r => {
                const rs = (typeof getSubjectForRow === 'function' ? getSubjectForRow(r) : null) || 'General';
                if (rs !== subject) return false;
                if ((r.chapter || '(No Chapter)') !== chapter) return false;
                if (topic && topic !== '__all__' && topic !== '(General)') {
                    if ((r.topic || '(General)') !== topic) return false;
                }
                if (topic === '(General)' && (r.topic || '(General)') !== '(General)') return false;
                return true;
            });
            rows.forEach(row => {
                if (Array.isArray(row.questions)) {
                    row.questions.forEach((q, qi) => {
                        // PYQ = has a year value, Regular = no year value
                        const hasYear = q.year && String(q.year).trim() !== '';
                        const isPyq = hasYear;
                        const isOther = !hasYear;
                        let include = true;
                        if (filterPyq && filterOther) {
                            include = true;
                        } else if (filterPyq) {
                            include = isPyq;
                        } else if (filterOther) {
                            include = isOther;
                        } else {
                            include = false;
                        }
                        if (!include) return;
                        if (!_agPassExamType(q, 'offline')) return;
                        pool.push({ row, qi, q, chapter: row.chapter || '(No Chapter)', topic: row.topic || '', lecture: row.lecture });
                    });
                }
            });
        }

        if (pool.length === 0) {
            errEl.textContent = '❌ No questions could be loaded. Please check your server connection.';
            errEl.style.display = 'block';
            nextBtn.disabled = false;
            nextBtn.textContent = '✨ Generate Paper';
            return;
        }

        // Random sample
        nextBtn.textContent = '⏳ Generating…';
        const actualCount = Math.min(requestedCount, pool.length);
        const shuffled = [...pool].sort(() => Math.random() - 0.5);
        const picked = shuffled.slice(0, actualCount);

        // Sort: MCQs first, numerical questions at the end
        const _agIsNumerical = function (q) {
            if (!q) return false;
            if ((q.question_type || '').toUpperCase() === 'INTEGER' || (q.questionType || '').toUpperCase() === 'INTEGER') return true;
            if (q.numericalAnswer !== undefined && q.numericalAnswer !== null) return true;
            if (Array.isArray(q.options) && q.options.every(function (o) { return !o || String(o).trim() === ''; }) && (!Array.isArray(q.optionImages) || q.optionImages.every(function (im) { return !im; }))) return true;
            return false;
        };
        picked.sort(function (a, b) {
            return (_agIsNumerical(a.q) ? 1 : 0) - (_agIsNumerical(b.q) ? 1 : 0);
        });

        // Build question objects
        let qNum = 1;
        const questions = picked.map(({ q, qi, row, chapter, topic, lecture }) => ({
            chapter: chapter,
            topic: topic,
            lecture: lecture,
            questionIndex: qi,
            qNum: qNum++,
            q: q,
            _key: 'auto_' + qNum + '_' + Math.random(),
            _label: (topic || chapter) + ' / Q' + (qi + 1),
        }));

        let pollInterval = null;
        let files;

        // Stop the shimmer animation so the bar shows real server progress.
        const _agBar = document.getElementById('ag-loader-bar');
        if (_agBar) _agBar.style.animation = 'none';

        // Try the async progress-based route first; fall back to the
        // legacy synchronous route if the server doesn't support it yet.
        const startResp = await fetch(API_BASE + '/api/admin/generate-paper/start', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ questions, paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId: (typeof _selectedTemplateId !== 'undefined' ? _selectedTemplateId : null) })
        });

        if (startResp.status === 404) {
            // ── Fallback: old synchronous route ──────────────────────────
            _agUpdateProgress('offline', 10, 'build');
            const syncResp = await fetch(API_BASE + '/api/admin/generate-paper', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ questions, paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId: (typeof _selectedTemplateId !== 'undefined' ? _selectedTemplateId : null) })
            });
            const syncData = await syncResp.json();
            if (!syncResp.ok || !syncData.success) throw new Error(syncData.error || 'Generation failed');
            _agUpdateProgress('offline', 100, 'finalise');
            files = syncData.files;
        } else {
            // ── Async progress-polling route ──────────────────────────────
            const startData = await startResp.json();
            if (!startResp.ok || !startData.success) throw new Error(startData.error || 'Generation failed to start');

            const progressId = startData.progressId;

            files = await new Promise((resolve, reject) => {
                pollInterval = setInterval(async () => {
                    try {
                        const pResp = await fetch(API_BASE + '/api/admin/generate-paper/progress/' + progressId, {
                            credentials: 'include'
                        });
                        const pData = await pResp.json();
                        if (!pResp.ok || !pData.success) {
                            clearInterval(pollInterval);
                            reject(new Error(pData.error || 'Failed to fetch generation progress'));
                            return;
                        }

                        const progress = pData.progress;
                        // Drive bar directly from server percentage (no fake animation)
                        _agUpdateProgress('offline', progress.pct, progress.currentStep);

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

        const safeTitle = paperTitle.replace(/[^a-z0-9_\-]/gi, '_');
        window._lastPaperGenData = { files, safeTitle, paperTitle, paperSubject, paperChapter, paperTestType, paperClass, questions, pdfFiles: null };

        _agClearLoaderTimers();
        if (pollInterval) clearInterval(pollInterval);
        closeAutoGenerateModal();
        _agShowDownloadModal(files, safeTitle, paperTitle, questions);

    } catch (err) {
        _agClearLoaderTimers();
        _agShowConfigSub('offline');
        errEl.textContent = '❌ Error: ' + err.message;
        errEl.style.display = 'block';
    } finally {
        nextBtn.disabled = false;
        nextBtn.textContent = '✨ Generate Paper';
    }
}
function _agShowDownloadModal(files, safeTitle, paperTitle, questions) {
    // Open the existing generate-paper-modal (correct ID) and inject result state
    const modal = document.getElementById('generate-paper-modal');
    if (!modal) { alert('Download ready but modal not found. Please refresh.'); return; }

    window._lastPaperGenData = {
        files,
        safeTitle,
        paperTitle,
        questions,
        pdfFiles: null,
        paperSubject: window._lastPaperGenData?.paperSubject || '',
        paperChapter: window._lastPaperGenData?.paperChapter || '',
        paperTestType: window._lastPaperGenData?.paperTestType || 'Chapter Test',
        paperClass: window._lastPaperGenData?.paperClass || ''
    };

    // Hide/show the right sections — guard every lookup with a null check
    const progressEl = document.getElementById('paper-generate-progress');
    const infoEl = document.getElementById('paper-generate-info');
    const tplStatusEl = document.getElementById('paper-template-status');
    const actionsEl = document.getElementById('paper-modal-actions');
    const closeActEl = document.getElementById('paper-modal-close-actions');
    const dlLinksEl = document.getElementById('paper-download-links');
    const titleInput = document.getElementById('paper-title-input');
    const genBtn = document.getElementById('paper-generate-btn');

    if (progressEl) progressEl.style.display = 'none';
    if (tplStatusEl) tplStatusEl.style.display = 'none';
    if (actionsEl) actionsEl.style.display = 'none';
    if (closeActEl) closeActEl.style.display = 'flex';
    if (infoEl) infoEl.style.display = 'none';

    // Hide title, header fields, and title field for auto-generate success screen
    if (modal) {
        const titleEl = modal.querySelector('.modal-title');
        if (titleEl) titleEl.style.display = 'none';
    }
    const headerFields = document.getElementById('paper-header-fields');
    if (headerFields) headerFields.style.display = 'none';
    const titleField = document.getElementById('paper-title-field');
    if (titleField) titleField.style.display = 'none';
    if (titleInput) titleInput.value = paperTitle;
    if (genBtn) { genBtn.disabled = false; genBtn.style.opacity = ''; }

    // Build format-chooser HTML
    const formatHtml = '<div style="font-size:0.85rem;font-weight:700;color:var(--success);margin-bottom:14px;display:flex;align-items:center;gap:8px">' +
        '<span style="font-size:1.1rem">&#10004;</span> ' + questions.length + ' questions generated — Word documents:</div>' +
        '<div style="display:grid;grid-template-columns:1fr;gap:12px;margin-bottom:14px">' +
        '<button id="fmt-docx-btn" onclick="selectDownloadFormat(\'docx\')" style="padding:16px 12px;background:var(--bg-card);border:2px solid var(--border);border-radius:12px;cursor:pointer;color:var(--text);font-family:inherit;text-align:center;transition:all .2s;display:flex;flex-direction:column;align-items:center;gap:6px">' +
        '<div style="font-size:1.8rem">&#128212;</div><div style="font-weight:800;font-size:0.9rem">Word (DOCX)</div><div style="font-size:0.7rem;color:var(--text-muted)">Editable document</div></button>' +
        '</div>' +
        '<div id="fmt-download-status" style="display:none;font-size:0.82rem;padding:10px 14px;border-radius:10px;margin-bottom:12px"></div>' +
        '<div id="fmt-download-links" style="display:none"></div>';

    if (dlLinksEl) { dlLinksEl.innerHTML = formatHtml; dlLinksEl.style.display = 'block'; }

    // Open modal via the correct function (resets nothing, we already set state above)
    modal.style.display = 'flex';
    modal.classList.add('open');

    // Auto-select Word format
    selectDownloadFormat('docx');
}

/* ── Helpers ─── */
function _agEsc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _agEscArg(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function _agEscId(s) { return String(s || '').replace(/[^a-zA-Z0-9]/g, '_'); }
function _agShowMessage(msg, type) {
    const errEl = document.getElementById('ag-config-error');
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.style.display = 'block';
    errEl.style.color = type === 'warn' ? 'var(--warn)' : 'var(--error)';
    setTimeout(() => { errEl.style.display = 'none'; }, 2500);
}



(function () {
    "use strict";

    /* ── Owner panel: this guard must not run — all sections are allowed ── */
    if (window.__IS_OWNER_PANEL) return;

    /* ── Allowed sections in institute mode ── */
    var ALLOWED_SECTIONS = ["manageQuestions", "students", "testResults"];

    /* Small toast helper (falls back to console if no toast util) */
    function clientBlockNotice(msg) {
        msg = msg || "This action is not available on the institute panel.";
        try {
            if (typeof showToast === "function") { showToast(msg); return; }
            if (typeof toast === "function") { toast(msg); return; }
        } catch (e) { /* ignore */ }
        console.warn("[institute-mode]", msg);
    }
    window.clientBlockNotice = clientBlockNotice;

    /* ── Block destructive / edit functions (run after page scripts load) ── */
    function blockFn(name, msg) {
        try {
            window[name] = function () { clientBlockNotice(msg); };
        } catch (e) { /* ignore */ }
    }

    function installClientGuards() {
        /* Chapter / topic renaming */
        blockFn("renameChapter", "Renaming chapters is disabled on the institute panel.");
        blockFn("renameTopic", "Renaming topics is disabled on the institute panel.");

        /* Question editing */
        blockFn("mqEnterEditMode", "Editing questions is disabled on the institute panel.");
        blockFn("saveInlineEdit", "Editing questions is disabled on the institute panel.");
        blockFn("cancelInlineEdit", "");

        /* Deleting questions / bulk deletes within Manage Questions */
        blockFn("deleteCurrentQuestion", "Deleting questions is disabled on the institute panel.");
        blockFn("massDelete", "Deleting is disabled on the institute panel.");
        blockFn("massDeleteQuestions", "Deleting is disabled on the institute panel.");
        blockFn("toggleSelectMode", "Bulk selection / delete is disabled on the institute panel.");
        blockFn("toggleQuestionSelectMode", "Bulk selection / delete is disabled on the institute panel.");

        /* Template deletion (upload still allowed) */
        blockFn("deleteTemplate", "Deleting templates is disabled on the institute panel.");
        blockFn("confirmDeleteTemplate", "Deleting templates is disabled on the institute panel.");
    }

    /* ── Force the page to only ever open allowed sections ── */
    function installSectionGuard() {
        if (typeof window.showSection !== "function") return false;
        if (window.__clientShowSectionWrapped) return true;
        var _origShowSection = window.showSection;
        window.showSection = function (name, push) {
            if (ALLOWED_SECTIONS.indexOf(name) === -1) {
                // Redirect any disallowed section to Manage Questions
                name = "manageQuestions";
            }
            return _origShowSection.call(this, name, push);
        };
        window.__clientShowSectionWrapped = true;
        return true;
    }

    /* ── Land on Manage Questions after login instead of Dashboard ── */
    function installEnterDashboardGuard() {
        if (typeof window.enterDashboard !== "function") return false;
        if (window.__clientEnterDashboardWrapped) return true;
        var _origEnter = window.enterDashboard;
        window.enterDashboard = async function () {
            var r = await _origEnter.apply(this, arguments);
            try {
                if (typeof window.showSection === "function") {
                    window.showSection("manageQuestions");
                    history.replaceState({ type: "section", name: "manageQuestions" }, "", "");
                }
            } catch (e) { /* ignore */ }
            return r;
        };
        window.__clientEnterDashboardWrapped = true;
        return true;
    }

    /* The original page scripts define their functions inline (same scope),
       so they may not be on window yet at parse time. Retry a few times
       until all of them are available, then install the guards. */
    var tries = 0;
    (function waitAndInstall() {
        var okSection = installSectionGuard();
        var okEnter = installEnterDashboardGuard();
        installClientGuards();
        tries++;
        if ((!okSection || !okEnter) && tries < 60) {
            setTimeout(waitAndInstall, 100);
        } else {
            // If we're already inside the dashboard (session restored before
            // our guard wrapped enterDashboard), make sure we're on a valid
            // section now.
            try {
                var active = document.querySelector(".section.active");
                if (active && ALLOWED_SECTIONS.indexOf(active.id.replace("section-", "")) === -1) {
                    if (typeof window.showSection === "function") window.showSection("manageQuestions");
                }
            } catch (e) { /* ignore */ }
        }
    })();

    /* Re-install destructive-fn guards periodically for the first few
       seconds in case the page reassigns window.deleteCurrentQuestion
       (it does: `window.deleteCurrentQuestion = deleteCurrentQuestion;`). */
    var guardTicks = 0;
    var guardTimer = setInterval(function () {
        installClientGuards();
        if (++guardTicks > 30) clearInterval(guardTimer);
    }, 200);

})();