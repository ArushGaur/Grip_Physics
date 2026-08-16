        /* ══════════════════════════════════════════════════════════════════
           OWNER-SPECIFIC CODE
           (Globals, utilities, and shared state are loaded from shared-utils.js)
        ══════════════════════════════════════════════════════════════════ */

        /* ── Owner session isolation ──────────────────────────────────────
           The owner has its own cookie (`grip.owner.sid`), separate from the
           client cookie. We override fetch() so every request from this page
           includes the `X-Session-Type: owner` header, telling the server to
           use the owner session middleware for ALL endpoints — including the
           shared /api/admin/* routes.
        ──────────────────────────────────────────────────────────────────── */
        (function () {
            // Override fetch()
            const _origFetch = window.fetch;
            window.fetch = function (input, init) {
                init = init || {};
                if (!init.headers) {
                    init.headers = { "X-Session-Type": "owner" };
                } else if (init.headers instanceof Headers) {
                    if (!init.headers.has("X-Session-Type")) {
                        init.headers.set("X-Session-Type", "owner");
                    }
                } else if (Array.isArray(init.headers)) {
                    if (!init.headers.some(([k]) => k.toLowerCase() === "x-session-type")) {
                        init.headers.push(["X-Session-Type", "owner"]);
                    }
                } else {
                    if (!init.headers["X-Session-Type"]) {
                        init.headers["X-Session-Type"] = "owner";
                    }
                }
                return _origFetch.call(this, input, init);
            };

            // Override XMLHttpRequest.send() to inject the header for XHR calls too
            const _origXhrSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function () {
                this.setRequestHeader("X-Session-Type", "owner");
                return _origXhrSend.apply(this, arguments);
            };
        })();

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






        /* ══════════════════════════════════════════════════════════════════
           SESSION / AUTH
        ══════════════════════════════════════════════════════════════════ */
        (async function checkSession() {
            try {
                console.log("Checking session at:", `${API_BASE}/api/owner/me`);
                const r = await fetch(`${API_BASE}/api/owner/me`, { credentials: "include", cache: "no-store" });
                console.log("Session check status:", r.status);
                if (r.ok) {
                    const data = await r.json();
                    if (data.loggedIn) {
                        console.log("Owner session valid - entering dashboard");
                        enterDashboard(false);
                    } else {
                        document.getElementById("loginOverlay").style.display = "flex";
                    }
                } else {
                    document.getElementById("loginOverlay").style.display = "flex";
                }
            } catch (e) {
                console.log("Session check failed:", e.message, "- showing login screen");
                document.getElementById("loginOverlay").style.display = "flex";
            }
        })();

        async function enterDashboard(skipStudents = false) {
            // Hide login, show dashboard (idempotent — safe to call even if already visible)
            const overlay = document.getElementById("loginOverlay");
            if (overlay) overlay.style.display = "none";
            document.getElementById("sidebar").classList.remove("hidden");
            document.getElementById("mainContent").classList.remove("hidden");

            // Load all data — each call is independently guarded so one failure
            // cannot prevent the rest of the dashboard from loading.
            try { await loadDashboard(); } catch(e) { console.warn("loadDashboard error:", e); }
            try { if (typeof loadChaptersAdmin === "function") await loadChaptersAdmin(); } catch(e) { console.warn("loadChaptersAdmin error:", e); }
            try { if (typeof loadQuestionsAdmin === "function") await loadQuestionsAdmin(); } catch(e) { console.warn("loadQuestionsAdmin error:", e); }

            // The initial page-load template fetch can run before the session is
            // authenticated (→ 401 → empty list). Re-fetch now that we're logged in
            // so the autogenerate / paper-generate template choosers are populated.
            if (typeof refreshTemplates === "function") { refreshTemplates().catch(() => {}); }

            history.replaceState({ type: "section", name: "dashboard" }, "", "");
        }

        function renderDashboardData() {
            const wa = allStudents.filter(s => (s.answers && s.answers.length > 0) || typeof s.correctCount === "number");
            const tc = wa.reduce((sum, x) => sum + (x.correctCount || 0), 0);
            const tw = wa.reduce((sum, x) => sum + ((x.totalQuestions || 0) - (x.correctCount || 0)), 0);
            const lecs = new Set(allStudents.map(s => `${s.chapter}::${s.lecture}`));

            document.getElementById("stat-total").textContent = allStudents.length;
            document.getElementById("stat-correct").textContent = tc;
            document.getElementById("stat-wrong").textContent = tw;
            document.getElementById("stat-lectures").textContent = lecs.size;

            const totalQ = tc + tw;
            const accuracy = totalQ > 0 ? Math.round((tc / totalQ) * 100) : 0;
            const accEl = document.getElementById("accuracyPercent");
            const accBar = document.getElementById("accuracyBar");
            if (accEl) accEl.textContent = accuracy + '%';
            if (accBar) accBar.style.width = accuracy + '%';
            document.getElementById("sidebar-correct").textContent = tc;
            document.getElementById("sidebar-wrong").textContent = tw;

            renderRecentActivity(wa.slice(-5).reverse());
            renderChapterBreakdown();
            _chartData = wa;
            buildChart(wa);

            console.log("Dashboard data rendered successfully!");
        }

        function togglePasscodeVisibility(btn) {
            const input = document.getElementById("passcode");
            const showIcon = btn.querySelector('.eye-show');
            const hideIcon = btn.querySelector('.eye-hide');
            const isMasked = input.style.webkitTextSecurity === 'disc' || input.style.textSecurity === 'disc' || input.type === 'password';
            if (isMasked) {
                input.type = 'text';
                input.style.webkitTextSecurity = 'none';
                input.style.textSecurity = 'none';
                if (showIcon) showIcon.style.display = 'none';
                if (hideIcon) hideIcon.style.display = '';
            } else {
                input.type = 'text';
                input.style.webkitTextSecurity = 'disc';
                input.style.textSecurity = 'disc';
                if (showIcon) showIcon.style.display = '';
                if (hideIcon) hideIcon.style.display = 'none';
            }
        }

        async function login() {
            const p = document.getElementById("passcode").value.trim();
            const e = document.getElementById("loginError");
            const btn = document.getElementById("loginSubmitBtn");
            const fieldWrap = document.getElementById("loginFieldWrap");
            e.style.display = "none";
            if (!p) {
                e.textContent = "Please enter a passcode.";
                e.style.display = "block";
                fieldWrap.classList.add("login-field-error");
                setTimeout(() => fieldWrap.classList.remove("login-field-error"), 400);
                return;
            }

            // Show spinner immediately
            if (btn) {
                btn.querySelector('.login-btn-text').style.display = 'none';
                btn.querySelector('.login-btn-spinner').style.display = '';
                btn.disabled = true;
            }

            try {
                const url = `${API_BASE}/api/owner/login`;
                const r = await fetch(url, {
                    method: "POST",
                    credentials: "include",
                    cache: "no-store",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ passcode: p })
                });
                const data = await r.json().catch(() => null);

                if (!r.ok) {
                    if (btn) {
                        btn.querySelector('.login-btn-text').style.display = '';
                        btn.querySelector('.login-btn-spinner').style.display = 'none';
                        btn.disabled = false;
                    }
                    e.textContent = data?.error || `Login failed (${r.status}).`;
                    e.style.display = "block";
                    fieldWrap.classList.add("login-field-error");
                    setTimeout(() => fieldWrap.classList.remove("login-field-error"), 400);
                    return;
                }

                // ✅ Auth OK — hide login immediately, load data in background
                document.getElementById("passcode").value = "";
                document.getElementById("loginOverlay").style.display = "none";
                document.getElementById("sidebar").classList.remove("hidden");
                document.getElementById("mainContent").classList.remove("hidden");

                // Load dashboard data asynchronously
                enterDashboard();

            } catch (err) {
                console.error("Login error:", err);
                if (btn) {
                    btn.querySelector('.login-btn-text').style.display = '';
                    btn.querySelector('.login-btn-spinner').style.display = 'none';
                    btn.disabled = false;
                }
                e.textContent = "Connection error. Is the server running?";
                e.style.display = "block";
            }
        }

        function confirmLogout() { closeMobileDrawer(); openModal('logoutModal'); }

        async function doLogout() {
            closeModal('logoutModal');
            await fetch(`${API_BASE}/api/owner/logout`, { method: "POST", credentials: "include", cache: "no-store" });
            document.getElementById("passcode").value = "";
            location.reload();
        }


        /* ══════════════════════════════════════════════════════════════════
           NAVIGATION
        ══════════════════════════════════════════════════════════════════ */
        function showSection(name, push = true) {
            // Guard: section element must exist
            const sectionEl = document.getElementById(`section-${name}`);
            const navEl     = document.getElementById(`nav-${name}`);
            if (!sectionEl) { console.warn("showSection: unknown section", name); return; }

            document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
            document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
            sectionEl.classList.add("active");
            if (navEl) navEl.classList.add("active");

            // Also sync mobile drawer
            document.querySelectorAll('.drawer-item[id^="drawer-"]').forEach(el => el.classList.remove('active'));
            const drawerEl = document.getElementById(`drawer-${name}`);
            if (drawerEl) drawerEl.classList.add('active');

            try {
                if (name === "dashboard") {
                    if (typeof refreshDemoRequestsBadge === "function") refreshDemoRequestsBadge();
                }
                if (name === "students") {
                    if (typeof loadRegisteredStudents === "function") loadRegisteredStudents();
                    fetch(`${API_BASE}/api/admin/student-requests`, { credentials: 'include', cache: 'no-store' })
                        .then(r => r.json()).then(data => { if (typeof updateRequestsBadge === "function") updateRequestsBadge(data.length); }).catch(() => { });
                }
                if (name === "applications") {
                    if (typeof populateStudentChapterFilter === "function") populateStudentChapterFilter();
                    if (typeof filterStudents === "function") filterStudents('');
                    if (typeof setStudentView === "function") setStudentView(studentViewMode);
                }
                if (name === "manageQuestions") {
                    if (typeof showSubjectView === "function") showSubjectView();
                    if (typeof renderSubjectCards === "function") renderSubjectCards(allQuestions);
                }
                if (name === "starQuiz") {
                    if (typeof loadStarQuizData === "function") {
                        if (push && typeof sqShowChapterView === "function") sqShowChapterView(false);
                        loadStarQuizData().then(() => {
                            if (typeof sqRenderChapters === "function") {
                                const cv = document.getElementById("sq-chapter-view");
                                if (!cv || cv.style.display !== "none") sqRenderChapters(_sqAllQuestions);
                            }
                        }).catch(() => {});
                    }
                }
                if (name === "demoRequests") {
                    if (typeof loadDemoRequests === "function") loadDemoRequests();
                }
                if (name === "clients") { loadInstitutes(); }
                if (name === "addQuestion") {
                    // Populate chapter datalists if available
                    if (typeof loadChaptersAdmin === "function") loadChaptersAdmin().catch(() => {});
                }
            } catch(err) {
                console.warn("showSection handler error for", name, err);
            }

            if (push) history.pushState({ type: "section", name }, "", "");
        }

        function showChapterViewH() { showChapterView(); history.pushState({ type: "mqChapter" }, "", ""); }
        function showLectureViewH(ch) { showLectureViewForChapter(ch); history.pushState({ type: "mqLecture", chapter: ch }, "", ""); }
        function showQuestionViewH(idx, sqIdx) { showQuestionView(idx, sqIdx); history.pushState({ type: "mqQuestion", idx, sqIdx }, "", ""); }

        window.addEventListener("popstate", e => {
            const s = e.state;
            if (!s) return;
            if (s.type === "section") { showSection(s.name, false); return; }
            if (s.type === "mqChapter") { showChapterView(); return; }
            if (s.type === "mqPaper") { if (s.paper) showPaperQuestions(s.paper, false); else showChapterView(); return; }
            if (s.type === "mqLecture") { if (s.chapter) showLectureViewForChapter(s.chapter); else showChapterView(); return; }
            if (s.type === "mqQuestion") { if (typeof s.idx === "number") showQuestionView(s.idx, s.sqIdx); else showLectureView(); return; }
            // Star Quiz sub-navigation
            if (s.type === "sqChapter") { sqShowChapterView(false); return; }
            if (s.type === "sqLecture") { if (s.chapter) { _sqCurrentChapter = s.chapter; sqShowLectureView(false); } else { sqShowChapterView(false); } return; }
            if (s.type === "sqQuestionCards") { if (s.chapter && s.lecture) { sqShowQuestionCards(s.chapter, s.lecture, false); } else { sqShowLectureView(false); } return; }
        });


        /* ══════════════════════════════════════════════════════════════════
           DASHBOARD
        ══════════════════════════════════════════════════════════════════ */
        async function loadDashboard() {
            console.log("=== LOAD DASHBOARD ===");
            try {
                const url = `${API_BASE}/api/admin/students`;
                console.log("Fetching:", url);
                const r = await fetch(url, { credentials: "include" });
                console.log("Dashboard API status:", r.status);
                if (r.status === 403) {
                    console.log("Not authorized - session issue - trying renderDashboardData");
                    return;
                }
                if (!r.ok) { console.log("API error:", r.status); return; }
                const data = await r.json();
                console.log("Raw API response:", data);
                allStudents = data;
                console.log("Students loaded:", allStudents.length);
                renderDashboardData();
            } catch (e) { console.error("Dashboard error:", e); }
        }

        async function refreshDashboard() {
            const btn = document.getElementById('dashRefreshBtn');
            const icon = document.getElementById('refreshIcon');
            btn.disabled = true;
            btn.style.opacity = '0.7';
            icon.style.animation = 'spin 0.6s linear infinite';
            try {
                await Promise.all([loadDashboard(), loadChaptersAdmin(), loadQuestionsAdmin()]);
            } finally {
                icon.style.animation = '';
                btn.disabled = false;
                btn.style.opacity = '1';
                // Brief success flash
                btn.style.borderColor = 'var(--success)';
                btn.style.color = 'var(--success)';
                setTimeout(() => { btn.style.borderColor = ''; btn.style.color = ''; }, 1200);
            }
        }

        function renderRecentActivity(activities) {
            const container = document.getElementById("recentActivityList");
            if (!container) return;
            if (!activities.length) {
                container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted)">No recent activity</div>';
                return;
            }
            container.innerHTML = activities.map(s => {
                const pct = s.totalQuestions ? Math.round((s.correctCount / s.totalQuestions) * 100) : 0;
                const initials = getInitials(s.name);
                const scoreClass = pct >= 70 ? 'high' : pct >= 40 ? 'med' : 'low';
                const cheatTag = s.cheatFlag ? `<span style="margin-left:5px;padding:1px 7px;border-radius:50px;background:rgba(239,68,68,0.18);border:1px solid rgba(239,68,68,0.5);color:#f87171;font-size:0.68rem;font-weight:700">⚠️ CHEATING</span>` : "";
                return `<div class="recent-item" style="${s.cheatFlag ? 'border-left:3px solid #f87171;padding-left:10px' : ''}">
                    <div class="recent-avatar" style="${s.cheatFlag ? 'background:rgba(239,68,68,0.3)' : ''}">${initials}</div>
                    <div class="recent-info">
                        <div class="recent-name">${s.name || 'Unknown'}${cheatTag}</div>
                        <div class="recent-meta">${s.chapter || 'Unknown'} • Lecture ${s.lecture || '?'}</div>
                    </div>
                    <div class="recent-score ${scoreClass}">${pct}%</div>
                </div>`;
            }).join('');
        }

        function renderChapterBreakdown() {
            const container = document.getElementById("chapterBreakdownList");
            if (!container) return;
            const chapters = {};
            allStudents.forEach(s => {
                if (!chapters[s.chapter]) chapters[s.chapter] = { count: 0, students: new Set() };
                chapters[s.chapter].count++;
                chapters[s.chapter].students.add(s.mobile);
            });
            const sorted = Object.entries(chapters).sort((a, b) => b[1].count - a[1].count);
            const icons = ["⚡", "🔥", "🌊", "🔭", "⚗️", "🧲", "🔬", "🌡️", "🌍", "💡", "🪐"];
            container.innerHTML = sorted.slice(0, 6).map(([name, data], i) => `
                <div class="chapter-item">
                    <span class="chapter-item-icon">${icons[i % icons.length]}</span>
                    <span class="chapter-item-name">${name}</span>
                    <span class="chapter-item-count">${data.students.size}</span>
                    </div>
                </div>
            `).join('') || '<div style="text-align:center;padding:20px;color:var(--text-muted)">No chapters yet</div>';
        }

        function buildChart(data) {
            const m = {};
            data.forEach(s => {
                const k = `${s.chapter || "?"}/L${s.lecture}`;
                if (!m[k]) m[k] = { c: 0, w: 0 };
                m[k].c += s.correctCount || 0;
                m[k].w += ((s.totalQuestions || 0) - (s.correctCount || 0));
            });
            const labels = Object.keys(m).sort(), cs = labels.map(k => m[k].c), ws = labels.map(k => m[k].w);
            const ctx = document.getElementById("lectureChart");
            if (window._chart) window._chart.destroy();
            const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
            const tc = isDark ? "#e4e8ff" : "#374151";
            const gc = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.07)";
            window._chart = new Chart(ctx, {
                type: "bar",
                data: { labels, datasets: [{ label: "Correct", data: cs, backgroundColor: "rgba(6,214,160,0.72)", borderRadius: 5 }, { label: "Wrong", data: ws, backgroundColor: "rgba(242,92,92,0.72)", borderRadius: 5 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: tc, font: { family: "Outfit" } } } }, scales: { x: { ticks: { color: tc, font: { family: "Outfit", size: 10 } }, grid: { color: gc } }, y: { beginAtZero: true, ticks: { color: tc, font: { family: "Outfit" } }, grid: { color: gc } } } }
            });
        }

        function populateDrillChapters() {
            const chs = [...new Set(allStudents.map(s => s.chapter).filter(Boolean))].sort();
            const sel = document.getElementById("drillChapter");
            if (sel) sel.innerHTML = '<option value="">— All —</option>' + chs.map(c => `<option value="${c}">${c}</option>`).join("");
        }

        function loadDrillLectures() {
            const ch = document.getElementById("drillChapter")?.value || '';
            const lecs = [...new Set(allStudents.filter(s => !ch || s.chapter === ch).map(s => s.lecture).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
            const sel = document.getElementById("drillLecture");
            if (sel) sel.innerHTML = '<option value="">— Select —</option>' + lecs.map(l => `<option value="${l}">Lecture ${l}</option>`).join("");
            const results = document.getElementById("drillResults");
            if (results) results.style.display = "none";
        }

        function loadDrillData() {
            const ch = document.getElementById("drillChapter")?.value || '';
            const lec = document.getElementById("drillLecture")?.value || '';
            const results = document.getElementById("drillResults");
            if (!results) return;
            if (!lec) { results.style.display = "none"; return; }
            const f = allStudents.filter(s => ((s.answers && s.answers.length > 0) || typeof s.correctCount === "number") && s.lecture === lec && (!ch || s.chapter === ch));
            const tc = f.reduce((sum, x) => sum + (x.correctCount || 0), 0);
            const tw = f.reduce((sum, x) => sum + ((x.totalQuestions || 0) - (x.correctCount || 0)), 0);
            document.getElementById("drillStats").innerHTML = `<div class="stat-card"><div class="stat-icon">👥</div><div class="stat-num">${f.length}</div><div class="stat-label">Attempted</div></div><div class="stat-card"><div class="stat-icon">✅</div><div class="stat-num">${tc}</div><div class="stat-label">Correct</div></div><div class="stat-card"><div class="stat-icon">❌</div><div class="stat-num">${tw}</div><div class="stat-label">Wrong</div></div>`;
            const tbody = document.querySelector("#drillTable tbody");
            if (tbody) {
                tbody.innerHTML = "";
                f.forEach(student => {
                    const pct = student.totalQuestions ? Math.round((student.correctCount / student.totalQuestions) * 100) : 0;
                    const cheatBadge = student.cheatFlag ? `<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:50px;background:rgba(239,68,68,0.18);border:1px solid rgba(239,68,68,0.5);color:#f87171;font-size:0.7rem;font-weight:700;letter-spacing:0.03em">⚠️ CHEATING</span>` : "";
                    tbody.insertAdjacentHTML("beforeend", `<tr style="${student.cheatFlag ? 'background:rgba(239,68,68,0.07)' : ''}"><td>${student.name || "—"}${cheatBadge}</td><td style="font-family:'JetBrains Mono',monospace;font-size:0.78rem">${student.mobile}</td><td>${student.correctCount || 0}</td><td>${student.totalQuestions || 0}</td><td><span class="badge-pill ${pct >= 50 ? "ok" : "wrong"}">${pct}%</span></td></tr>`);
                });
            }
            results.style.display = "block";
        }


        /* ══════════════════════════════════════════════════════════════
           INSTITUTE / CLIENTS MANAGEMENT
        ══════════════════════════════════════════════════════════════ */
        let _instDeleteId = null;

        async function loadInstitutes() {
            const grid = document.getElementById("institutesGrid");
            if (!grid) return;
            grid.innerHTML = `<div style="color:var(--text-muted);font-size:0.9rem;padding:20px 0">Loading institutes…</div>`;
            try {
                const r = await fetch(`${API_BASE}/api/owner/institutes`, { credentials: "include", cache: "no-store" });
                if (!r.ok) { grid.innerHTML = `<div style="color:var(--error)">Failed to load institutes (${r.status})</div>`; return; }
                const institutes = await r.json();
                renderInstitutesGrid(institutes);
            } catch (e) {
                grid.innerHTML = `<div style="color:var(--error)">Error: ${e.message}</div>`;
            }
        }

        function renderInstitutesGrid(institutes) {
            const grid = document.getElementById("institutesGrid");
            if (!institutes.length) {
                grid.innerHTML = `<div style="color:var(--text-muted);font-size:0.9rem;padding:20px 0;grid-column:1/-1">No institutes yet. Click <b>Add Institute</b> to create one.</div>`;
                return;
            }
            grid.innerHTML = institutes.map(inst => {
                const isDefault = inst.code === "DEFAULT";
                const statusBadge = `<span class="inst-badge ${inst.status}">${inst.status}</span>`;
                const expiry = inst.plan_expires_at && inst.plan_expires_at > 0
                    ? `<div class="inst-stat">Expires: <span>${new Date(inst.plan_expires_at).toLocaleDateString()}</span></div>`
                    : `<div class="inst-stat">Expiry: <span>No limit</span></div>`;
                const logoHtml = inst.logo_url
                    ? `<div class="inst-logo"><img src="${inst.logo_url}" alt="${inst.name} logo" onerror="this.parentElement.innerHTML='🏫'"></div>`
                    : `<div class="inst-logo">🏫</div>`;
                const perms = inst.permissions || {};
                const permsList = [
                    perms.onlineTests !== false ? '✅ Online Tests' : '❌ Online Tests',
                    perms.starQuiz !== false ? '✅ STAR Quiz' : '❌ STAR Quiz',
                    perms.paperGenerator !== false ? '✅ Paper Gen' : '❌ Paper Gen',
                    perms.questionBank !== false ? '✅ Q Bank' : '❌ Q Bank',
                ].join(' &nbsp;|&nbsp; ');
                return `<div class="inst-card">
                    <div class="inst-card-header">
                        ${logoHtml}
                        <div class="inst-info">
                            <h4>${escHtml(inst.name)}</h4>
                            <span class="inst-code">${escHtml(inst.code)}</span>
                            &nbsp;${statusBadge}
                        </div>
                    </div>
                    <div class="inst-stats">
                        <div class="inst-stat">Students: <span>${inst.student_count}</span></div>
                        ${expiry}
                    </div>
                    <div style="font-size:0.72rem;color:var(--text-muted);line-height:1.8">${permsList}</div>
                    <div class="inst-actions">
                        <button class="btn btn-ghost" onclick="openEditInstituteModal(${inst.id})">✏️ Edit</button>
                        ${!isDefault ? `<button class="btn btn-ghost" style="color:var(--warn)" onclick="toggleSuspendInstitute(${inst.id}, '${inst.status}')">${inst.status === 'suspended' ? '▶️ Activate' : '⏸ Suspend'}</button>` : ''}
                        ${!isDefault ? `<button class="btn btn-ghost" style="color:var(--error)" onclick="promptDeleteInstitute(${inst.id}, '${escHtml(inst.name).replace(/'/g, "\\'")}')">🗑 Delete</button>` : ''}
                    </div>
                </div>`;
            }).join("");
        }

        function escHtml(str) {
            return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
        }

        function openAddInstituteModal() {
            document.getElementById("instModalTitle").textContent = "Add Institute";
            document.getElementById("instModalId").value = "";
            document.getElementById("instModalName").value = "";
            document.getElementById("instModalCode").value = "";
            document.getElementById("instModalCode").disabled = false;
            document.getElementById("instModalPasscode").value = "";
            document.getElementById("instModalPasscodeLabel").innerHTML = `Passcode * <span style="font-size:0.72rem;color:var(--text-muted)">Password used by teachers to login</span>`;
            document.getElementById("instModalTeacherPasscode").value = "";
            document.getElementById("instModalTeacherPasscodeLabel").innerHTML = `Teacher Passcode <span style="font-size:0.72rem;color:var(--text-muted)">Optional. Defaults to main passcode if left blank</span>`;
            document.getElementById("instModalExpiry").value = "";
            document.getElementById("instModalStatus").value = "active";
            document.getElementById("instModalLogo").value = "";
            document.getElementById("instModalLogoPreview").style.display = "none";
            document.getElementById("permOnlineTests").checked = true;
            document.getElementById("permStarQuiz").checked = true;
            document.getElementById("permPaperGen").checked = true;
            document.getElementById("permQuestionBank").checked = true;
            document.getElementById("instModalError").style.display = "none";
            openModal("instituteModal");
        }

        async function openEditInstituteModal(id) {
            try {
                const r = await fetch(`${API_BASE}/api/owner/institutes`, { credentials: "include", cache: "no-store" });
                const institutes = await r.json();
                const inst = institutes.find(i => i.id === id);
                if (!inst) { alert("Institute not found"); return; }

                document.getElementById("instModalTitle").textContent = "Edit Institute";
                document.getElementById("instModalId").value = id;
                document.getElementById("instModalName").value = inst.name;
                document.getElementById("instModalCode").value = inst.code;
                document.getElementById("instModalCode").disabled = true; // code cannot be changed after creation
                document.getElementById("instModalPasscode").value = "";
                document.getElementById("instModalPasscodeLabel").innerHTML = `New Passcode <span style="font-size:0.72rem;color:var(--text-muted)">Leave blank to keep current</span>`;
                document.getElementById("instModalTeacherPasscode").value = "";
                document.getElementById("instModalTeacherPasscodeLabel").innerHTML = `New Teacher Passcode <span style="font-size:0.72rem;color:var(--text-muted)">Leave blank to keep current</span>`;
                if (inst.plan_expires_at && inst.plan_expires_at > 0) {
                    const d = new Date(inst.plan_expires_at);
                    document.getElementById("instModalExpiry").value = d.toISOString().slice(0, 10);
                } else {
                    document.getElementById("instModalExpiry").value = "";
                }
                document.getElementById("instModalStatus").value = inst.status;
                document.getElementById("instModalLogo").value = "";
                const logoPreview = document.getElementById("instModalLogoPreview");
                if (inst.logo_url) { logoPreview.src = inst.logo_url; logoPreview.style.display = "block"; }
                else { logoPreview.style.display = "none"; }
                const perms = inst.permissions || {};
                document.getElementById("permOnlineTests").checked = perms.onlineTests !== false;
                document.getElementById("permStarQuiz").checked = perms.starQuiz !== false;
                document.getElementById("permPaperGen").checked = perms.paperGenerator !== false;
                document.getElementById("permQuestionBank").checked = perms.questionBank !== false;
                document.getElementById("instModalError").style.display = "none";
                openModal("instituteModal");
            } catch (e) { alert("Error: " + e.message); }
        }

        function previewInstLogo(input) {
            const preview = document.getElementById("instModalLogoPreview");
            if (input.files && input.files[0]) {
                const reader = new FileReader();
                reader.onload = e => { preview.src = e.target.result; preview.style.display = "block"; };
                reader.readAsDataURL(input.files[0]);
            }
        }

        async function saveInstitute() {
            const id = document.getElementById("instModalId").value;
            const isEdit = !!id;
            const errEl = document.getElementById("instModalError");
            errEl.style.display = "none";

            const name = document.getElementById("instModalName").value.trim();
            const code = document.getElementById("instModalCode").value.trim().toUpperCase();
            const passcode = document.getElementById("instModalPasscode").value;
            const teacherPasscode = document.getElementById("instModalTeacherPasscode").value;
            const expiryVal = document.getElementById("instModalExpiry").value;
            const status = document.getElementById("instModalStatus").value;
            const logoFile = document.getElementById("instModalLogo").files[0];

            if (!name) { errEl.textContent = "Institute name is required."; errEl.style.display = "block"; return; }
            if (!isEdit && !code) { errEl.textContent = "Institute code is required."; errEl.style.display = "block"; return; }
            if (!isEdit && !passcode) { errEl.textContent = "Passcode is required."; errEl.style.display = "block"; return; }

            const perms = {
                onlineTests: document.getElementById("permOnlineTests").checked,
                starQuiz: document.getElementById("permStarQuiz").checked,
                paperGenerator: document.getElementById("permPaperGen").checked,
                questionBank: document.getElementById("permQuestionBank").checked,
            };

            let plan_expires_at = 0;
            if (expiryVal) { plan_expires_at = new Date(expiryVal + "T23:59:59").getTime(); }

            const saveBtn = document.getElementById("instModalSaveBtn");
            saveBtn.querySelector(".inst-save-txt").style.display = "none";
            saveBtn.querySelector(".inst-save-spin").style.display = "";
            saveBtn.disabled = true;

            try {
                const fd = new FormData();
                fd.append("name", name);
                if (!isEdit) fd.append("code", code);
                if (passcode) fd.append("passcode", passcode);
                if (teacherPasscode) fd.append("teacherPasscode", teacherPasscode);
                fd.append("permissions", JSON.stringify(perms));
                fd.append("plan_expires_at", String(plan_expires_at));
                fd.append("status", status);
                if (logoFile) fd.append("logo", logoFile);

                const url = isEdit ? `${API_BASE}/api/owner/institutes/${id}` : `${API_BASE}/api/owner/institutes`;
                const method = isEdit ? "PUT" : "POST";
                const r = await fetch(url, { method, credentials: "include", body: fd });
                const data = await r.json().catch(() => ({}));

                if (!r.ok) {
                    errEl.textContent = data?.error || `Save failed (${r.status})`;
                    errEl.style.display = "block";
                    return;
                }

                closeModal("instituteModal");
                showSuccessModal(isEdit ? "Institute Updated!" : "Institute Created!", isEdit
                    ? `${name} has been updated successfully.`
                    : `${name} (${code}) has been created. Teachers can now log in with the institute code and passcode.`
                );
                await loadInstitutes();
            } catch (e) {
                errEl.textContent = "Error: " + e.message;
                errEl.style.display = "block";
            } finally {
                saveBtn.querySelector(".inst-save-txt").style.display = "";
                saveBtn.querySelector(".inst-save-spin").style.display = "none";
                saveBtn.disabled = false;
            }
        }

        async function toggleSuspendInstitute(id, currentStatus) {
            try {
                const r = await fetch(`${API_BASE}/api/owner/institutes/${id}/suspend`, {
                    method: "POST", credentials: "include",
                    headers: { "Content-Type": "application/json" }
                });
                const data = await r.json();
                if (!r.ok) { alert(data?.error || "Failed"); return; }
                await loadInstitutes();
            } catch (e) { alert("Error: " + e.message); }
        }

        function promptDeleteInstitute(id, name) {
            _instDeleteId = id;
            document.getElementById("instDeleteModalText").textContent =
                `Delete "${name}"? This will mark the institute as deleted. Student data is kept intact but the institute won't be able to log in.`;
            openModal("instDeleteModal");
        }

        async function confirmDeleteInstitute() {
            if (!_instDeleteId) return;
            closeModal("instDeleteModal");
            try {
                const r = await fetch(`${API_BASE}/api/owner/institutes/${_instDeleteId}`, {
                    method: "DELETE", credentials: "include"
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) { alert(data?.error || "Failed"); return; }
                _instDeleteId = null;
                await loadInstitutes();
            } catch (e) { alert("Error: " + e.message); }
        }

    



        /* ══════════════════════════════════════════════════════════════════
           DEMO REQUESTS
           Enquiries submitted from the public website form (index.html
           #demoForm → POST /api/demo-requests). Reviewed here by the owner.
        ══════════════════════════════════════════════════════════════════ */
        let _demoRequests = [];

        const DEMO_STATUS_META = {
            new:       { label: "New",            icon: "🆕", color: "#2563eb" },
            contacted: { label: "Contacted",      icon: "📞", color: "#d97706" },
            scheduled: { label: "Demo scheduled", icon: "📅", color: "#7c3aed" },
            won:       { label: "Converted",      icon: "✅", color: "#059669" },
            lost:      { label: "Lost",           icon: "❌", color: "#dc2626" }
        };

        function demoEsc(s) {
            return String(s == null ? "" : s)
                .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        }

        function demoTime(ms) {
            const n = Number(ms || 0);
            if (!n) return "—";
            const d = new Date(n);
            const diff = Date.now() - n;
            const mins = Math.floor(diff / 60000);
            let rel = "";
            if (mins < 1) rel = "just now";
            else if (mins < 60) rel = `${mins}m ago`;
            else if (mins < 1440) rel = `${Math.floor(mins / 60)}h ago`;
            else rel = `${Math.floor(mins / 1440)}d ago`;
            return `${d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} · ${rel}`;
        }

        function updateDemoRequestsBadge(count) {
            const el = document.getElementById("demoReqBadge");
            if (!el) return;
            const n = Number(count || 0);
            el.textContent = String(n);
            el.style.display = n > 0 ? "inline-block" : "none";
        }

        // Cheap badge refresh (used from the dashboard) without rendering cards.
        async function refreshDemoRequestsBadge() {
            try {
                const r = await fetch(`${API_BASE}/api/owner/demo-requests?status=new`, { credentials: "include", cache: "no-store" });
                if (!r.ok) return;
                const data = await r.json();
                updateDemoRequestsBadge(Array.isArray(data) ? data.length : 0);
            } catch (_) { /* non-fatal */ }
        }

        async function loadDemoRequests() {
            const list = document.getElementById("demoReqList");
            const empty = document.getElementById("demoReqEmpty");
            if (list) list.innerHTML = `<p style="color:var(--text-muted);padding:12px">Loading requests…</p>`;
            if (empty) empty.style.display = "none";

            try {
                const r = await fetch(`${API_BASE}/api/owner/demo-requests`, { credentials: "include", cache: "no-store" });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const data = await r.json();
                _demoRequests = Array.isArray(data) ? data : [];
            } catch (e) {
                _demoRequests = [];
                if (list) list.innerHTML = `<p style="color:var(--error);padding:12px">Could not load demo requests. ${demoEsc(e.message)}</p>`;
                return;
            }
            renderDemoRequests();
        }

        function renderDemoRequests() {
            const list = document.getElementById("demoReqList");
            const empty = document.getElementById("demoReqEmpty");
            if (!list) return;

            const q = (document.getElementById("demoReqSearch")?.value || "").trim().toLowerCase();
            const statusFilter = document.getElementById("demoReqStatusFilter")?.value || "";
            const sizeFilter = document.getElementById("demoReqSizeFilter")?.value || "";

            // Stats always reflect the full set, not the filtered view.
            const total = _demoRequests.length;
            const byStatus = (s) => _demoRequests.filter(r => (r.status || "new") === s).length;
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
            set("demoStatTotal", total);
            set("demoStatNew", byStatus("new"));
            set("demoStatContacted", byStatus("contacted"));
            set("demoStatWon", byStatus("won"));
            updateDemoRequestsBadge(byStatus("new"));

            const rows = _demoRequests.filter(r => {
                if (statusFilter && (r.status || "new") !== statusFilter) return false;
                if (sizeFilter && String(r.students || "") !== sizeFilter) return false;
                if (!q) return true;
                return [r.name, r.institute, r.phone, r.email, r.message, r.students]
                    .some(v => String(v || "").toLowerCase().includes(q));
            });

            if (!rows.length) {
                list.innerHTML = "";
                if (empty) {
                    empty.style.display = "block";
                    const h3 = empty.querySelector("h3");
                    const p = empty.querySelector("p");
                    if (total === 0) {
                        if (h3) h3.textContent = "No demo requests yet";
                        if (p) p.textContent = "Requests from the website form will appear here automatically";
                    } else {
                        if (h3) h3.textContent = "No matching requests";
                        if (p) p.textContent = "Try adjusting your search or filters";
                    }
                }
                return;
            }
            if (empty) empty.style.display = "none";

            list.innerHTML = rows.map(r => {
                const meta = DEMO_STATUS_META[r.status] || DEMO_STATUS_META.new;
                const phoneDigits = String(r.phone || "").replace(/\D/g, "");
                const waNumber = phoneDigits.length === 10 ? `91${phoneDigits}` : phoneDigits;
                const options = Object.keys(DEMO_STATUS_META).map(k =>
                    `<option value="${k}" ${((r.status || "new") === k) ? "selected" : ""}>${DEMO_STATUS_META[k].icon} ${DEMO_STATUS_META[k].label}</option>`
                ).join("");

                return `
                <div class="req-card" id="demoreq-${r.id}">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
                        <div>
                            <div class="req-card-roll">🏫 ${demoEsc(r.institute) || "—"}</div>
                            <div class="req-card-name">${demoEsc(r.name) || "—"}</div>
                        </div>
                        <span class="badge-pill" style="background:${meta.color}1a;color:${meta.color};white-space:nowrap">
                            ${meta.icon} ${meta.label}
                        </span>
                    </div>

                    <div class="req-card-meta">
                        <span>📞 ${demoEsc(r.phone) || "—"}</span>
                        <span>👥 ${demoEsc(r.students) || "Not specified"}</span>
                        ${r.email ? `<span>✉️ ${demoEsc(r.email)}</span>` : ""}
                    </div>

                    ${r.message ? `<div style="margin:8px 0;padding:9px 11px;border-radius:9px;background:var(--bg-soft,rgba(127,127,127,.08));font-size:.82rem;line-height:1.5">
                        <b style="opacity:.7">Wants to fix:</b> ${demoEsc(r.message)}
                    </div>` : ""}

                    <div class="req-card-time">Received: ${demoEsc(demoTime(r.created_at))}</div>

                    <div class="req-card-actions" style="flex-wrap:wrap;gap:8px">
                        <select onchange="setDemoRequestStatus(${r.id}, this.value)"
                            style="padding:7px 10px;border-radius:9px;font-size:.8rem">${options}</select>
                        ${phoneDigits ? `<a class="btn btn-ghost" href="tel:${demoEsc(phoneDigits)}">📞 Call</a>` : ""}
                        ${phoneDigits ? `<a class="btn btn-ghost" target="_blank" rel="noopener"
                            href="https://wa.me/${demoEsc(waNumber)}">💬 WhatsApp</a>` : ""}
                        <button class="btn btn-danger" onclick="deleteDemoRequest(${r.id})">🗑 Delete</button>
                    </div>
                </div>`;
            }).join("");
        }

        async function setDemoRequestStatus(id, status) {
            try {
                const r = await fetch(`${API_BASE}/api/owner/demo-requests/${id}`, {
                    method: "PUT",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ status })
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

                const idx = _demoRequests.findIndex(x => x.id === id);
                if (idx > -1 && data.request) _demoRequests[idx] = data.request;
                renderDemoRequests();
                if (typeof showToast === "function") showToast(`Marked as ${(DEMO_STATUS_META[status] || {}).label || status}`);
            } catch (e) {
                if (typeof showToast === "function") showToast(`Could not update: ${e.message}`);
                else alert(`Could not update: ${e.message}`);
            }
        }

        async function deleteDemoRequest(id) {
            if (!confirm("Delete this demo request permanently?")) return;
            try {
                const r = await fetch(`${API_BASE}/api/owner/demo-requests/${id}`, {
                    method: "DELETE",
                    credentials: "include"
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

                _demoRequests = _demoRequests.filter(x => x.id !== id);
                renderDemoRequests();
                if (typeof showToast === "function") showToast("Request deleted");
            } catch (e) {
                if (typeof showToast === "function") showToast(`Could not delete: ${e.message}`);
                else alert(`Could not delete: ${e.message}`);
            }
        }

        function exportDemoRequestsCSV() {
            if (!_demoRequests.length) {
                if (typeof showToast === "function") showToast("Nothing to export");
                return;
            }
            const cell = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
            const header = ["Received", "Name", "Institute", "Phone", "Email", "Students", "Status", "Message"];
            const lines = [header.join(",")].concat(_demoRequests.map(r => [
                cell(r.created_at ? new Date(Number(r.created_at)).toLocaleString("en-IN") : ""),
                cell(r.name), cell(r.institute), cell(r.phone), cell(r.email),
                cell(r.students), cell((DEMO_STATUS_META[r.status] || {}).label || r.status), cell(r.message)
            ].join(",")));

            const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `demo-requests-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(a.href);
        }

        // Expose for inline handlers in developer.html
        window.loadDemoRequests = loadDemoRequests;
        window.renderDemoRequests = renderDemoRequests;
        window.setDemoRequestStatus = setDemoRequestStatus;
        window.deleteDemoRequest = deleteDemoRequest;
        window.exportDemoRequestsCSV = exportDemoRequestsCSV;
        window.refreshDemoRequestsBadge = refreshDemoRequestsBadge;
