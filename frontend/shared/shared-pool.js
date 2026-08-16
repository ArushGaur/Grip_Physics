/* ════════════════════════════════════════════════════════════════════════
   COMBINE & CREATE TEST  —  shared cross-subject question pool (front-end)
   ────────────────────────────────────────────────────────────────────────
   A teacher picks questions for THEIR subject, presses "Send to Combine
   Pool" and tags them with the test they are meant for:

        class → section → test date → shift (morning/evening) → mode

   The Combine & Create section then walks exactly that hierarchy with cards,
   so whoever builds the paper opens one test bucket and finds every
   teacher's questions for it already sitting together.

   Extras
     • Ctrl+Z / Cmd+Z restores an accidentally removed question.
     • Pooled questions self-destruct after 15 days (server side).
     • A background poll raises a notification when someone pools questions.
     • Previews keep their LaTeX and are typeset with KaTeX.

   Two render modes:
     • INLINE  — if the page has <div id="qpool-host"> (institute panel's
                 "Combine & Create" section) the whole UI lives in that section.
     • FLOATING — otherwise a small launcher button opens the UI in a modal.

   The pool stores only question POINTERS. Full questions are resolved from the
   bank right before a paper is generated (question-pool/resolve).
   ════════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var QP = {
        items: [],
        selected: new Set(),
        students: [],
        pickedRolls: new Set(),
        drill: { cls: null, sec: null, date: null, shift: null, mode: null },
        stuClass: null,
        stuSection: null,
        query: '',
        loaded: false,
        undo: [],            // stack of removed items, for Ctrl+Z
        lastEventTs: 0,
        seenEvents: false,
        news: []             // recent "x pooled y questions" events
    };

    function host() { return document.getElementById('qpool-host'); }
    function inline() { return !!host(); }
    function base() { return (typeof window.API_BASE === 'string' ? window.API_BASE : ''); }

    async function api(path, opts) {
        opts = opts || {};
        var init = {
            credentials: 'include',
            cache: 'no-store',
            method: opts.method || 'GET',
            headers: { 'Content-Type': 'application/json' }
        };
        if (opts.body) init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        var r = await fetch(base() + path, init);
        var data = null;
        try { data = await r.json(); } catch (e) { data = null; }
        if (!r.ok) throw new Error((data && (data.error || data.message)) || ('HTTP ' + r.status));
        return data;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /* Question previews keep their $…$ LaTeX; typeset whatever we just wrote. */
    function typeset(el) {
        if (!el) return;
        try {
            if (typeof window.renderMath === 'function') { window.renderMath(el); return; }
            if (typeof window.renderMathInElement === 'function') {
                window.renderMathInElement(el, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '\\[', right: '\\]', display: true },
                        { left: '$', right: '$', display: false },
                        { left: '\\(', right: '\\)', display: false }
                    ],
                    throwOnError: false
                });
            }
        } catch (e) { }
    }

    function toast(msg) {
        if (typeof window.showToast === 'function') { try { window.showToast(msg); return; } catch (e) { } }
        if (typeof window.toast === 'function') { try { window.toast(msg); return; } catch (e) { } }
        var t = document.createElement('div');
        t.textContent = msg;
        t.style.cssText = 'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);background:#111827;color:#fff;' +
            'padding:11px 18px;border-radius:11px;font:600 .85rem/1.3 inherit;z-index:100000;box-shadow:0 10px 30px rgba(0,0,0,.28)';
        document.body.appendChild(t);
        setTimeout(function () { t.remove(); }, 2600);
    }

    function prettyDate(d) {
        if (!d) return 'No date';
        var p = String(d).split('-');
        if (p.length !== 3) return d;
        var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
        if (isNaN(dt.getTime())) return d;
        return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }
    function cap(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
    /* Class/section names may already carry their own "Class "/"Section "
       prefix. Strip it so a label never reads "Section SECTION C". */
    function secBare(v) {
        var t = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
        if (!t || /^no\s*section$/i.test(t)) return '';
        return t.replace(/^sec(tion)?\b[\s._:#-]*/i, '').trim() || t;
    }
    function clsBare(v) {
        var t = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
        if (!t) return '';
        return t.replace(/^class\b[\s._:#-]*/i, '').trim() || t;
    }

    function todayStr() {
        var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    /* ── Styles (injected once) ────────────────────────────────────────── */
    function injectCss() {
        if (document.getElementById('qpool-css')) return;
        var s = document.createElement('style');
        s.id = 'qpool-css';
        s.textContent = [
            /* The section now borrows the institute panel's own design language:
               mint canvas, white cards with a coloured left accent bar, deep-teal
               gradient primary buttons, 14-20px radii and the same soft shadows.
               Every colour is a var() onto the host page's tokens, so this file
               still looks right inside developer.html too. */
            '.qp-wrap{--qp-teal:var(--teal-deep,#0e7e65);--qp-deep:#094f3e;--qp-line:var(--line,#dceae4);--qp-ink:var(--ink,#12312a);--qp-dim:var(--ink-dim,#5d7a72);--qp-muted:var(--ink-muted,#9db3ac);--qp-card:var(--card,#fff);--qp-soft:var(--soft,#eef4f1);--qp-input:var(--input-bg,#f2f9f6);--qp-shadow:var(--shadow,0 10px 30px rgba(13,76,62,.08));--qp-lift:var(--shadow-lift,0 16px 40px rgba(13,76,62,.14));font-family:inherit;color:var(--qp-ink)}',

            /* hero / banner */
            '.qp-hero{display:flex;align-items:center;gap:13px;flex-wrap:wrap;padding:16px 18px;border-radius:var(--radius,20px);margin-bottom:16px;background:var(--qp-card);border:1px solid var(--qp-line);box-shadow:var(--qp-shadow);position:relative;overflow:hidden}',
            '.qp-hero::before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:5px;background:linear-gradient(180deg,var(--qp-teal),var(--teal,#00d2b4))}',
            '.qp-hero .ic{width:46px;height:46px;flex:none;border-radius:15px;background:var(--qp-soft);display:flex;align-items:center;justify-content:center;font-size:1.25rem;margin-left:4px}',
            '.qp-hero h4{margin:0;font:700 1.05rem/1.25 inherit;color:var(--qp-ink);letter-spacing:-.01em}',
            '.qp-hero p{margin:4px 0 0;font:500 .78rem/1.45 inherit;color:var(--qp-dim)}',
            '.qp-hero .n{margin-left:auto;font:700 .74rem/1 inherit;color:var(--qp-teal);background:var(--qp-soft);border-radius:99px;padding:8px 14px;border:1px solid var(--qp-line);white-space:nowrap}',

            /* news strip */
            '.qp-news{display:flex;gap:11px;align-items:center;padding:12px 15px;border-radius:15px;margin-bottom:13px;background:var(--qp-soft);border:1px solid var(--qp-line);font:600 .79rem/1.45 inherit;color:var(--qp-ink)}',
            '.qp-news button{margin-left:auto;background:none;border:none;color:var(--qp-teal);cursor:pointer;font:700 .74rem/1 inherit;flex:none}',

            /* breadcrumb — mirrors .crumb-bar / .crumb-trail */
            '.qp-crumb{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px;padding:9px 14px;border-radius:14px;background:var(--qp-card);border:1px solid var(--qp-line);font:600 .78rem/1.5 inherit;color:var(--qp-dim)}',
            '.qp-crumb button{background:none;border:none;padding:0;cursor:pointer;font:700 .78rem/1.5 inherit;color:var(--qp-teal)}',
            '.qp-crumb button:hover{text-decoration:underline}',
            '.qp-crumb .cur{color:var(--qp-ink);font-weight:700}',

            /* drill cards — mirrors .ecard-grid / .ecard */
            '.qp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:13px}',
            '.qp-card{position:relative;cursor:pointer;text-align:left;width:100%;display:flex;align-items:center;gap:12px;padding:15px 16px 15px 19px;border-radius:18px;border:1px solid var(--qp-line);background:var(--qp-card);box-shadow:var(--qp-shadow);transition:transform .2s,box-shadow .2s,border-color .2s;overflow:hidden;min-width:0}',
            '.qp-card::before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--qp-teal);opacity:.85}',
            '.qp-card:hover{transform:translateY(-3px);box-shadow:var(--qp-lift);border-color:var(--qp-teal)}',
            '.qp-card .ic{width:40px;height:40px;flex:none;border-radius:13px;background:var(--qp-soft);display:flex;align-items:center;justify-content:center;font-size:1.05rem}',
            '.qp-card .tt{display:block;font:700 .92rem/1.25 inherit;color:var(--qp-ink);overflow-wrap:anywhere}',
            '.qp-card .sb{display:block;margin-top:4px;font:500 .74rem/1.4 inherit;color:var(--qp-dim);overflow-wrap:anywhere}',
            '.qp-card .ar{color:var(--qp-muted);font-size:1.05rem;flex:none}',
            '.qp-card.on{border-color:var(--qp-teal);background:var(--qp-soft)}',

            /* toolbar + search */
            '.qp-bar{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-bottom:14px}',
            '.qp-search{flex:1;min-width:min(200px,100%);position:relative}',
            '.qp-search input{width:100%;box-sizing:border-box;padding:11px 13px 11px 34px;border-radius:13px;border:1.5px solid var(--qp-line);background:var(--qp-input);color:var(--qp-ink);font:500 .84rem/1.2 inherit}',
            '.qp-search input:focus{outline:none;border-color:var(--qp-teal);background:var(--qp-card)}',
            '.qp-search i{position:absolute;left:12px;top:50%;transform:translateY(-50%);font-style:normal;opacity:.55;font-size:.85rem}',
            '.qp-link{background:none;border:none;padding:0;font:700 .77rem/1 inherit;color:var(--qp-teal);cursor:pointer}',
            '.qp-link:hover{text-decoration:underline}',
            '.qp-link.red{color:var(--rose,#d95f5f)}',

            /* question groups */
            '.qp-group{border:1px solid var(--qp-line);border-radius:18px;margin-bottom:13px;overflow:hidden;background:var(--qp-card);box-shadow:var(--qp-shadow)}',
            '.qp-ghead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:13px 16px;background:var(--qp-soft);border-bottom:1px solid var(--qp-line)}',
            '.qp-ghead b{font:700 .89rem/1 inherit;color:var(--qp-ink)}',
            '.qp-gcount{font:600 .72rem/1 inherit;color:var(--qp-dim)}',
            '.qp-row{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;border-top:1px solid var(--qp-line);min-width:0}',
            '.qp-row:first-child{border-top:none}',
            '.qp-row.on{background:var(--qp-soft)}',
            '.qp-row input[type=checkbox]{margin-top:2px;width:17px;height:17px;accent-color:var(--qp-teal);cursor:pointer;flex:none}',
            '.qp-qtext{font:500 .85rem/1.6 inherit;overflow-wrap:anywhere;min-width:0}',
            '.qp-qtext .katex{font-size:1em}',
            '.qp-meta{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;font:600 .68rem/1.4 inherit;color:var(--qp-dim)}',
            '.qp-tag{padding:3px 9px;border-radius:99px;background:var(--qp-soft);border:1px solid var(--qp-line)}',
            '.qp-x{background:none;border:none;color:var(--qp-muted);cursor:pointer;font-size:.9rem;flex:none;padding:3px 6px;border-radius:8px}',
            '.qp-x:hover{color:var(--rose,#d95f5f);background:rgba(217,95,95,.10)}',

            /* sticky action bar + buttons — mirrors .primary-btn / .ghost-btn */
            '.qp-foot{position:sticky;bottom:0;margin-top:16px;padding:13px 2px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:linear-gradient(to top,var(--canvas,#e6f2ee) 60%,transparent)}',
            '.qp-btn{padding:11px 20px;border-radius:13px;font:600 .83rem/1 inherit;font-family:inherit;cursor:pointer;border:1.5px solid var(--qp-line);background:var(--qp-card);color:var(--qp-ink);transition:all .2s;white-space:nowrap}',
            '.qp-btn:hover{border-color:var(--qp-teal);color:var(--qp-teal)}',
            '.qp-btn.primary{border:none;background:linear-gradient(135deg,var(--qp-teal),var(--qp-deep));color:#fff;font-weight:700;box-shadow:0 8px 20px rgba(14,126,101,.35)}',
            '.qp-btn.primary:hover{transform:translateY(-2px);color:#fff}',
            '.qp-btn.danger{color:var(--rose,#d95f5f);border-color:rgba(217,95,95,.32)}',
            '.qp-btn.danger:hover{border-color:var(--rose,#d95f5f);color:var(--rose,#d95f5f)}',
            '.qp-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}',

            /* empty state — mirrors .empty-state */
            '.qp-empty{text-align:center;padding:52px 16px;color:var(--qp-dim);background:var(--qp-card);border:1px solid var(--qp-line);border-radius:var(--radius,20px);box-shadow:var(--qp-shadow)}',

            /* form sections */
            '.qp-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr));gap:14px}',
            '.qp-sec{border:1px solid var(--qp-line);border-radius:18px;padding:15px 16px 16px;background:var(--qp-card);margin-bottom:13px;box-shadow:var(--qp-shadow)}',
            '.qp-sec-t{font:700 .74rem/1 inherit;margin-bottom:13px;display:flex;align-items:center;gap:8px;color:var(--qp-dim);text-transform:uppercase;letter-spacing:.06em}',
            '.qp-ohead{display:flex;align-items:center;gap:13px;margin-bottom:16px;flex-wrap:wrap}',
            '.qp-obadge{width:46px;height:46px;flex:none;border-radius:15px;background:linear-gradient(135deg,var(--qp-teal),var(--qp-deep));display:flex;align-items:center;justify-content:center;font-size:1.2rem;box-shadow:0 8px 20px rgba(14,126,101,.28)}',
            '.qp-ot{font:700 1.02rem/1.25 inherit;color:var(--qp-ink);letter-spacing:-.01em}',
            '.qp-os{font:500 .77rem/1.45 inherit;color:var(--qp-dim);margin-top:3px}',

            /* date + time picker */
            '.qp-dt{display:flex;align-items:stretch;border:1.5px solid var(--qp-line);border-radius:13px;background:var(--qp-input);overflow:hidden;min-width:0}',
            '.qp-dt:focus-within{border-color:var(--qp-teal);box-shadow:0 0 0 3px rgba(14,126,101,.12);background:var(--qp-card)}',
            '.qp-dt input[type=date]{flex:1 1 auto;min-width:0;width:100%;border:0;background:transparent;color:var(--qp-ink);padding:11px 4px 11px 12px;font:600 .83rem/1.2 inherit;font-family:inherit;border-radius:0}',
            '.qp-dt input[type=date]:focus{outline:none}',
            '.qp-dt input[type=date]::-webkit-calendar-picker-indicator{opacity:.5;cursor:pointer}',
            '.qp-dt .tm{display:flex;align-items:center;flex:0 0 auto;padding:0 8px 0 6px;border-left:1px solid var(--qp-line);background:var(--qp-soft)}',
            '.qp-dt select{border:0;background:transparent;color:var(--qp-ink);font:700 .83rem/1.2 inherit;font-family:inherit;padding:11px 2px;cursor:pointer;text-align:center;text-align-last:center;-webkit-appearance:none;-moz-appearance:none;appearance:none}',
            '.qp-dt select:focus{outline:none}',
            '.qp-dt select.ap{margin-left:5px;font-size:.72rem;letter-spacing:.04em;color:var(--qp-teal)}',
            '.qp-dt .cl{font-weight:700;opacity:.35;padding:0 1px}',

            /* toggle row */
            '.qp-strict{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;padding:11px 13px;border-radius:13px;border:1.5px solid var(--qp-line);background:var(--qp-card);cursor:pointer;font-family:inherit;text-align:left}',
            '.qp-strict .sw{width:42px;height:23px;flex:none;border-radius:20px;background:var(--track,#d7e4de);position:relative;transition:background .2s}',
            '.qp-strict .sw i{position:absolute;top:2px;left:2px;width:19px;height:19px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.22)}',
            '.qp-strict.on{border-color:var(--qp-teal);background:var(--qp-soft)}',
            '.qp-strict.on .sw{background:var(--qp-teal)}',
            '.qp-strict.on .sw i{transform:translateX(19px)}',
            '.qp-strict b{display:block;font:700 .82rem/1.25 inherit;color:var(--qp-ink)}',
            '.qp-strict small{display:block;margin-top:3px;font:500 .7rem/1.35 inherit;color:var(--qp-dim)}',
            '.qp-sum{border:1px dashed var(--qp-line);border-radius:13px;padding:11px 13px;font:500 .79rem/1.45 inherit;color:var(--qp-dim);background:var(--qp-soft)}',

            /* inputs + segmented control */
            '.qp-fields label span{display:block;font:700 .68rem/1 inherit;text-transform:uppercase;letter-spacing:.07em;color:var(--qp-dim);margin-bottom:7px}',
            '.qp-fields input,.qp-fields select{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:13px;border:1.5px solid var(--qp-line);background:var(--qp-input);color:var(--qp-ink);font:500 .84rem/1.2 inherit;font-family:inherit}',
            '.qp-fields input:focus,.qp-fields select:focus{outline:none;border-color:var(--qp-teal);background:var(--qp-card)}',
            '.qp-seg{display:flex;gap:9px;flex-wrap:wrap}',
            '.qp-seg button{flex:1 1 120px;padding:11px 9px;border-radius:13px;border:1.5px solid var(--qp-line);background:var(--qp-card);color:var(--qp-dim);font:600 .8rem/1.15 inherit;font-family:inherit;cursor:pointer;transition:all .2s}',
            '.qp-seg button.on{border-color:var(--qp-teal);background:var(--qp-soft);color:var(--qp-teal);font-weight:700}',

            /* progress */
            '.qp-prog{max-width:460px;margin:44px auto;text-align:center}',
            '.qp-prog-track{height:10px;border-radius:99px;background:var(--track,#d7e4de);overflow:hidden}',
            '.qp-prog-fill{height:100%;width:0%;border-radius:99px;background:linear-gradient(90deg,var(--qp-teal),var(--teal,#00d2b4));transition:width .3s ease}',
            '.qp-prog-row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px;font:700 .83rem/1.35 inherit;color:var(--qp-ink)}',
            '.qp-prog-pct{font:700 1.05rem/1 inherit;color:var(--qp-teal)}',

            /* student picker rows */
            '.qp-pick{cursor:pointer;display:flex;align-items:center;gap:12px;padding:13px 14px;border-radius:16px;border:1px solid var(--qp-line);background:var(--qp-card);box-shadow:var(--qp-shadow);transition:all .2s;min-width:0}',
            '.qp-pick:hover{border-color:var(--qp-teal);transform:translateY(-2px)}',
            '.qp-pick.on{border-color:var(--qp-teal);background:var(--qp-soft)}',
            '.qp-pick .ic{width:36px;height:36px;flex:none;border-radius:12px;background:var(--qp-soft);display:flex;align-items:center;justify-content:center;font-size:.95rem}',
            '.qp-pick .tt{display:block;font:700 .87rem/1.25 inherit;color:var(--qp-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.qp-pick .sb{display:block;margin-top:3px;font:500 .73rem/1.35 inherit;color:var(--qp-dim)}',

            /* context dialog — mirrors .modal-overlay / .modal */
            '.qp-ctx{position:fixed;inset:0;z-index:100001;background:rgba(8,47,38,.52);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:18px;font-family:inherit}',
            '.qp-ctx-card{background:var(--card,#fff);color:var(--ink,#12312a);width:min(520px,100%);border-radius:var(--radius,20px);overflow:hidden;box-shadow:var(--shadow-lift,0 16px 40px rgba(13,76,62,.14)),0 30px 80px rgba(8,47,38,.28)}',
            '.qp-ctx-head{padding:19px 22px;border-bottom:1px solid var(--line,#dceae4);background:var(--soft,#eef4f1)}',
            '.qp-ctx-head b{font:700 1.03rem/1.25 inherit;letter-spacing:-.01em}',
            '.qp-ctx-head p{margin:5px 0 0;font:500 .77rem/1.45 inherit;color:var(--ink-dim,#5d7a72)}',
            '.qp-ctx-body{padding:19px 22px;display:grid;gap:14px}',
            '.qp-ctx-foot{padding:15px 22px;border-top:1px solid var(--line,#dceae4);display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}',

            /* phones */
            '@media (max-width:640px){',
            '  .qp-hero{padding:14px 15px;border-radius:16px}',
            '  .qp-hero .n{margin-left:0}',
            '  .qp-grid{grid-template-columns:1fr;gap:11px}',
            '  .qp-card{padding:13px 14px 13px 17px}',
            '  .qp-btn{padding:10px 15px;font-size:.8rem}',
            '  .qp-foot{padding:11px 2px}',
            '  .qp-sec,.qp-group{border-radius:16px}',
            '  .qp-ctx-head,.qp-ctx-body,.qp-ctx-foot{padding-left:16px;padding-right:16px}',
            '  .qp-ctx-foot .qp-btn{flex:1 1 100%}',
            '}',
            '@keyframes qpoolspin{to{transform:rotate(360deg)}}'
        ].join('\n');
        document.head.appendChild(s);
    }

    /* ── Bridge to whichever local basket this page uses ───────────────────────
       institute.html → InstPaper.items   |   developer.html → paperBasket        */
    function localBasketItems() {
        var out = [];
        try {
            if (window.InstPaper && window.InstPaper.items && window.InstPaper.items.size) {
                window.InstPaper.items.forEach(function (it) {
                    var q = it.q || {};
                    out.push({
                        subject: q.subject || '',
                        chapter: it.chapter || q.chapter || '',
                        topic: it.topic || q.topic || '',
                        lecture: it.topic || q.lecture || q.topic || '',
                        questionIndex: it.questionIndex,
                        source: 'bank',
                        label: (q.question || it.label || ''),
                        question: q
                    });
                });
                return out;
            }
        } catch (e) { }
        try {
            if (window.paperBasket && window.paperBasket.size) {
                window.paperBasket.forEach(function (it) {
                    var q = it.q || it.question || null;
                    out.push({
                        subject: it.subject || (q && q.subject) || '',
                        chapter: it.chapter || '',
                        topic: it.lecture || it.topic || '',
                        lecture: it.lecture || it.topic || '',
                        questionIndex: it.questionIndex,
                        source: it.source || 'bank',
                        label: ((q && q.question) || it.label || ''),
                        question: q
                    });
                });
            }
        } catch (e) { }
        return out;
    }

    /* ── Shell: inline section (preferred) or floating modal ──────────────── */
    function shellHtml() {
        return '<div class="qp-wrap"><div id="qpool-body"></div><div id="qpool-foot" class="qp-foot"></div></div>';
    }

    function ensureShell() {
        injectCss();
        var h = host();
        if (h) {
            if (!document.getElementById('qpool-body')) h.innerHTML = shellHtml();
            return;
        }
        var m = document.getElementById('qpool-overlay');
        if (m) { m.style.display = 'flex'; return; }
        m = document.createElement('div');
        m.id = 'qpool-overlay';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(8,47,38,.52);backdrop-filter:blur(4px);z-index:99990;display:flex;align-items:center;justify-content:center;padding:20px;font-family:inherit';
        m.innerHTML =
            '<div style="background:var(--card,#fff);width:min(980px,100%);max-height:92vh;border-radius:var(--radius,20px);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 30px 80px rgba(8,47,38,.30)">' +
            '  <div style="padding:18px 22px;border-bottom:1px solid var(--line,#dceae4);background:var(--soft,#eef4f1);display:flex;align-items:center;gap:12px">' +
            '    <div style="width:44px;height:44px;border-radius:15px;background:linear-gradient(135deg,var(--teal-deep,#0e7e65),#094f3e);display:flex;align-items:center;justify-content:center;font-size:1.2rem;box-shadow:0 8px 20px rgba(14,126,101,.28)">\uD83E\uDDE9</div>' +
            '    <div style="flex:1"><div style="font:800 1.02rem/1.2 inherit">Combine &amp; Create Test</div>' +
            '      <div style="font:500 .76rem/1.4 inherit;color:var(--ink-dim,#5d7a72);margin-top:3px">Questions pooled by every teacher, across every subject</div></div>' +
            '    <button id="qpool-close" style="width:36px;height:36px;border-radius:12px;border:1.5px solid var(--line,#dceae4);background:var(--card,#fff);color:var(--ink-dim,#5d7a72);cursor:pointer;font-size:1rem;font-family:inherit">\u2715</button>' +
            '  </div>' +
            '  <div style="padding:18px 22px;overflow:auto;flex:1">' + shellHtml() + '</div>' +
            '</div>';
        document.body.appendChild(m);
        m.addEventListener('click', function (e) { if (e.target === m) QPool.close(); });
        m.querySelector('#qpool-close').addEventListener('click', function () { QPool.close(); });
    }

    function bodyEl() { return document.getElementById('qpool-body'); }
    function footEl() { return document.getElementById('qpool-foot'); }

    /* ── Floating launcher (only when there is no inline section) ──────── */
    function launcher() {
        if (inline()) return null;
        var el = document.getElementById('qpool-launcher');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'qpool-launcher';
        el.style.cssText = 'position:fixed;left:18px;bottom:18px;z-index:9998;display:flex;flex-direction:column;gap:8px;align-items:flex-start;font-family:inherit';
        el.innerHTML =
            '<button id="qpool-send-btn" style="display:none;padding:11px 16px;border-radius:13px;border:1.5px solid var(--line,#dceae4);background:var(--card,#fff);color:var(--teal-deep,#0e7e65);font:600 .8rem/1 inherit;font-family:inherit;cursor:pointer;box-shadow:var(--shadow,0 10px 30px rgba(13,76,62,.08))">\uD83D\uDCE4 Send <span id="qpool-send-n">0</span> to Combine Pool</button>' +
            '<button id="qpool-open-btn" style="padding:12px 18px;border-radius:13px;border:none;background:linear-gradient(135deg,var(--teal-deep,#0e7e65),#094f3e);color:#fff;font:700 .82rem/1 inherit;font-family:inherit;cursor:pointer;box-shadow:0 8px 20px rgba(14,126,101,.35);display:flex;align-items:center;gap:8px">\uD83E\uDDE9 Combine &amp; Create Test<span id="qpool-badge" style="display:none;min-width:20px;padding:2px 6px;border-radius:99px;background:rgba(255,255,255,.24);font-size:.7rem">0</span></button>';
        document.body.appendChild(el);
        el.querySelector('#qpool-open-btn').addEventListener('click', function () { QPool.open(); });
        el.querySelector('#qpool-send-btn').addEventListener('click', function () { QPool.sendBasket(); });
        return el;
    }

    function refreshLauncher() {
        var el = launcher();
        if (!el) return;
        var n = localBasketItems().length;
        var sb = el.querySelector('#qpool-send-btn');
        var sn = el.querySelector('#qpool-send-n');
        if (sb) sb.style.display = n ? 'block' : 'none';
        if (sn) sn.textContent = String(n);
        var badge = el.querySelector('#qpool-badge');
        if (badge) {
            if (QP.items.length) { badge.style.display = 'inline-block'; badge.textContent = String(QP.items.length); }
            else badge.style.display = 'none';
        }
    }

    function btn(label, onclick, kind, extra) {
        return '<button class="qp-btn' + (kind ? ' ' + kind : '') + '" onclick="' + onclick + '" ' + (extra || '') + '>' + label + '</button>';
    }

    function field(label, id, value, type, extra) {
        return '<label><span>' + label + '</span><input id="' + id + '" type="' + (type || 'text') + '" value="' +
            esc(value == null ? '' : value) + '" ' + (extra || '') + '></label>';
    }

    function val(id) { var el = document.getElementById(id); return el ? String(el.value).trim() : ''; }

    function sec(title, inner) {
        return '<div class="qp-sec"><div class="qp-sec-t">' + title + '</div>' + inner + '</div>';
    }

    /* Custom day + time picker: a date box plus hour / minute / AM-PM drop
       downs, so it looks and behaves the same in every browser instead of the
       native datetime-local widget. */
    function dtPicker(id, dt) {
        var p2 = function (n) { return String(n).padStart(2, '0'); };
        var h24 = dt.getHours();
        var ap = h24 >= 12 ? 'PM' : 'AM';
        var h12 = h24 % 12 || 12;
        var mm = Math.round(dt.getMinutes() / 5) * 5; if (mm > 55) mm = 55;
        var hrs = '', mins = '', h, m;
        for (h = 1; h <= 12; h++) hrs += '<option value="' + h + '"' + (h === h12 ? ' selected' : '') + '>' + p2(h) + '</option>';
        for (m = 0; m < 60; m += 5) mins += '<option value="' + m + '"' + (m === mm ? ' selected' : '') + '>' + p2(m) + '</option>';
        var ds = dt.getFullYear() + '-' + p2(dt.getMonth() + 1) + '-' + p2(dt.getDate());
        return '<div class="qp-dt">' +
            '<input type="date" id="' + id + '-d" value="' + ds + '">' +
            '<span class="tm">' +
            '<select id="' + id + '-h">' + hrs + '</select>' +
            '<span class="cl">:</span>' +
            '<select id="' + id + '-m">' + mins + '</select>' +
            '<select class="ap" id="' + id + '-a">' +
            '<option' + (ap === 'AM' ? ' selected' : '') + '>AM</option>' +
            '<option' + (ap === 'PM' ? ' selected' : '') + '>PM</option></select>' +
            '</span></div>';
    }

    function readDT(id) {
        var d = val(id + '-d');
        if (!d) return 0;
        var h = Number(val(id + '-h')) || 12;
        var m = Number(val(id + '-m')) || 0;
        if (val(id + '-a') === 'PM' && h < 12) h += 12;
        if (val(id + '-a') === 'AM' && h === 12) h = 0;
        var p = String(d).split('-');
        return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), h, m, 0).getTime();
    }

    function setDT(id, dt) {
        var p2 = function (n) { return String(n).padStart(2, '0'); };
        var d = document.getElementById(id + '-d');
        if (d) d.value = dt.getFullYear() + '-' + p2(dt.getMonth() + 1) + '-' + p2(dt.getDate());
        var h24 = dt.getHours();
        var hh = document.getElementById(id + '-h'); if (hh) hh.value = String(h24 % 12 || 12);
        var mm = document.getElementById(id + '-m'); if (mm) mm.value = String(Math.round(dt.getMinutes() / 5) * 5 % 60);
        var aa = document.getElementById(id + '-a'); if (aa) aa.value = h24 >= 12 ? 'PM' : 'AM';
    }

    function windowGap() {
        var el = document.getElementById('qpool-ot-gap');
        if (!el) return;
        var a = readDT('qpool-ot-live'), b = readDT('qpool-ot-ends');
        if (!a || !b) { el.textContent = ''; return; }
        var diff = b - a;
        if (diff <= 0) { el.textContent = '\u26A0 The closing time must be after the start time'; el.style.color = 'var(--rose,#d95f5f)'; return; }
        var days = Math.floor(diff / 86400000), hrs = Math.floor((diff % 86400000) / 3600000), mins = Math.floor((diff % 3600000) / 60000);
        var s = '\uD83D\uDDD3 Open for '; if (days) s += days + 'd '; if (hrs) s += hrs + 'h '; if (mins) s += mins + 'm';
        el.textContent = s.trim(); el.style.color = '';
    }

    function subjectOf(it) { return it.subject || 'Unsorted'; }

    /* ══════════════════════════════════════════════════════════════════════
       SEND TO COMBINE  →  ask which test these questions belong to
       ══════════════════════════════════════════════════════════════════ */
    var CTX = { className: '', section: '', shift: 'morning', testDate: todayStr(), mode: 'offline' };

    function rememberCtx() {
        try { localStorage.setItem('qpool_ctx', JSON.stringify(CTX)); } catch (e) { }
    }
    function recallCtx() {
        try {
            var raw = localStorage.getItem('qpool_ctx');
            if (raw) { var o = JSON.parse(raw); if (o && typeof o === 'object') Object.assign(CTX, o); }
        } catch (e) { }
        if (!CTX.testDate) CTX.testDate = todayStr();
    }

    function closeCtx() {
        var m = document.getElementById('qpool-ctx');
        if (m) m.remove();
    }

    function openCtxPopup(count) {
        injectCss();
        recallCtx();
        closeCtx();
        var m = document.createElement('div');
        m.className = 'qp-ctx';
        m.id = 'qpool-ctx';
        m.innerHTML =
            '<div class="qp-ctx-card">' +
            '<div class="qp-ctx-head"><b>\uD83E\uDDE9 Send ' + count + ' question' + (count !== 1 ? 's' : '') + ' to the pool</b>' +
            '<p>Tag them with the test they are for \u2014 everyone else\u2019s questions for the same test land in the same bucket.</p></div>' +
            '<div class="qp-ctx-body qp-fields" style="display:grid">' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
            field('Class', 'qpc-class', CTX.className, 'text', 'placeholder="e.g. 11"') +
            field('Section', 'qpc-section', CTX.section, 'text', 'placeholder="e.g. A"') +
            '</div>' +
            field('Test date', 'qpc-date', CTX.testDate || todayStr(), 'date') +
            '<label><span>Shift</span><div class="qp-seg" id="qpc-shift">' +
            '<button type="button" data-v="morning" class="' + (CTX.shift !== 'evening' ? 'on' : '') + '">\uD83C\uDF05 Morning</button>' +
            '<button type="button" data-v="evening" class="' + (CTX.shift === 'evening' ? 'on' : '') + '">\uD83C\uDF07 Evening</button>' +
            '</div></label>' +
            '<label><span>Mode of test</span><div class="qp-seg" id="qpc-mode">' +
            '<button type="button" data-v="offline" class="' + (CTX.mode !== 'online' ? 'on' : '') + '">\uD83D\uDCC4 Offline</button>' +
            '<button type="button" data-v="online" class="' + (CTX.mode === 'online' ? 'on' : '') + '">\uD83C\uDF10 Online</button>' +
            '</div></label>' +
            '</div>' +
            '<div class="qp-ctx-foot">' +
            '<button class="qp-btn" id="qpc-cancel">Cancel</button>' +
            '<button class="qp-btn primary" id="qpc-ok">Send to pool</button>' +
            '</div></div>';
        document.body.appendChild(m);

        var seg = function (id) {
            var box = m.querySelector('#' + id);
            box.addEventListener('click', function (e) {
                var b = e.target.closest('button[data-v]');
                if (!b) return;
                box.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
                b.classList.add('on');
            });
            return function () { var on = box.querySelector('button.on'); return on ? on.getAttribute('data-v') : ''; };
        };
        var getShift = seg('qpc-shift');
        var getMode = seg('qpc-mode');

        return new Promise(function (resolve) {
            m.addEventListener('click', function (e) { if (e.target === m) { closeCtx(); resolve(null); } });
            m.querySelector('#qpc-cancel').addEventListener('click', function () { closeCtx(); resolve(null); });
            m.querySelector('#qpc-ok').addEventListener('click', function () {
                var ctx = {
                    className: val('qpc-class'),
                    section: val('qpc-section'),
                    testDate: val('qpc-date'),
                    shift: getShift(),
                    mode: getMode()
                };
                if (!ctx.className) { toast('Please enter the class'); return; }
                if (!ctx.testDate) { toast('Please pick the test date'); return; }
                Object.assign(CTX, ctx);
                rememberCtx();
                closeCtx();
                resolve(ctx);
            });
        });
    }

    /* ══════════════════════════════════════════════════════════════════════
       BROWSE  —  class ▸ section ▸ test date ▸ shift ▸ mode ▸ questions
       ══════════════════════════════════════════════════════════════════ */
    function level() {
        var d = QP.drill;
        if (!d.cls) return 0;
        if (d.sec === null) return 1;
        if (!d.date) return 2;
        if (!d.shift) return 3;
        if (!d.mode) return 4;
        return 5;
    }

    function fieldOf(it, lv) {
        if (lv === 0) return it.className || 'Unassigned';
        if (lv === 1) return it.section || '—';
        if (lv === 2) return it.testDate || '';
        if (lv === 3) return it.shift || 'morning';
        return it.mode || 'offline';
    }

    // Items still in scope for the current drill position.
    function scopedItems(upto) {
        var d = QP.drill;
        var lv = upto == null ? level() : upto;
        return QP.items.filter(function (it) {
            if (lv > 0 && fieldOf(it, 0) !== d.cls) return false;
            if (lv > 1 && fieldOf(it, 1) !== d.sec) return false;
            if (lv > 2 && fieldOf(it, 2) !== d.date) return false;
            if (lv > 3 && fieldOf(it, 3) !== d.shift) return false;
            if (lv > 4 && fieldOf(it, 4) !== d.mode) return false;
            return true;
        });
    }

    function groupBy(list, lv) {
        var m = new Map();
        list.forEach(function (it) {
            var k = fieldOf(it, lv);
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(it);
        });
        return m;
    }

    function selectedItems() {
        return QP.items.filter(function (i) { return QP.selected.has(i.id); });
    }

    function hero() {
        return '<div class="qp-hero"><div class="ic">\uD83E\uDDE9</div>' +
            '<div><h4>Combine &amp; Create Test</h4>' +
            '<p>Teachers pool their subject\u2019s questions \u2192 open a test bucket \u2192 build the paper. Pooled questions are kept for 15 days.</p></div>' +
            '<span class="n">' + QP.items.length + ' pooled</span></div>' + newsHtml();
    }

    function newsHtml() {
        if (!QP.news.length) return '';
        var e = QP.news[0];
        var more = QP.news.length > 1 ? ' \u00B7 +' + (QP.news.length - 1) + ' more' : '';
        return '<div class="qp-news"><span>\uD83D\uDD14</span><span>' + esc(e.message || 'New questions were added to the pool') + more +
            '</span><button onclick="QPool.dismissNews()">Dismiss</button></div>';
    }

    function crumb() {
        var d = QP.drill, out = [];
        out.push('<button onclick="QPool.up(0)">All classes</button>');
        if (d.cls) out.push('<button onclick="QPool.up(1)">' + esc(clsBare(d.cls)) + '</button>');
        if (d.sec !== null && d.sec !== undefined) out.push('<button onclick="QPool.up(2)">Sec ' + esc(secBare(d.sec)) + '</button>');
        if (d.date) out.push('<button onclick="QPool.up(3)">' + esc(prettyDate(d.date)) + '</button>');
        if (d.shift) out.push('<button onclick="QPool.up(4)">' + esc(cap(d.shift)) + '</button>');
        if (d.mode) out.push('<span class="cur">' + esc(cap(d.mode)) + '</span>');
        return '<div class="qp-crumb">' + out.join('<span>\u203A</span>') + '</div>';
    }

    function card(icon, title, sub, onclick) {
        return '<button class="qp-card" onclick="' + onclick + '">' +
            '<span class="ic">' + icon + '</span>' +
            '<span style="flex:1;min-width:0"><span class="tt">' + title + '</span><span class="sb">' + sub + '</span></span>' +
            '<span class="ar">\u203A</span></button>';
    }

    function subjectSummary(list) {
        var m = new Map();
        list.forEach(function (i) { var s = subjectOf(i); m.set(s, (m.get(s) || 0) + 1); });
        return [...m.keys()].sort().map(function (s) { return esc(s) + ' ' + m.get(s); }).join(' \u00B7 ');
    }

    function renderBrowse() {
        ensureShell();
        var body = bodyEl(), foot = footEl();
        if (!body || !foot) return;

        if (!QP.items.length) {
            body.innerHTML = hero() +
                '<div class="qp-empty">' +
                '<div style="font-size:2.1rem">\uD83D\uDCE5</div>' +
                '<div style="font:800 .98rem/1.4 inherit;color:var(--ink,#12312a);margin-top:10px">The pool is empty</div>' +
                '<div style="font:600 .82rem/1.6 inherit;margin:8px auto 0;max-width:480px">Open the <b>Question Library</b>, pick questions with \u201cAdd to Paper\u201d, then press \u201c\uD83E\uDDE9 Send to Combine Pool\u201d and tell us the class, section, date, shift and mode of the test.</div></div>';
            foot.innerHTML = btn('\u21BB Refresh', 'QPool.refreshPool()');
            return;
        }

        var lv = level();
        if (lv === 5) { renderBucket(); return; }

        var list = scopedItems(lv);
        var groups = groupBy(list, lv);
        var keys = [...groups.keys()].sort(function (a, b) {
            if (lv === 2) return String(b).localeCompare(String(a)); // newest test first
            return String(a).localeCompare(String(b), undefined, { numeric: true });
        });

        var meta = [
            { icon: '\uD83C\uDFEB', label: 'Class ', title: 'Pick a class' },
            { icon: '\uD83D\uDCC1', label: 'Section ', title: 'Pick a section' },
            { icon: '\uD83D\uDCC5', label: '', title: 'Pick the test date' },
            { icon: '\u23F0', label: '', title: 'Pick the shift' },
            { icon: '\uD83D\uDCDD', label: '', title: 'Offline paper or online test?' }
        ][lv];

        body.innerHTML = hero() + crumb() +
            '<div style="font:800 .9rem/1 inherit;margin:2px 0 11px">' + meta.title + '</div>' +
            '<div class="qp-grid">' + keys.map(function (k) {
                var arr = groups.get(k);
                var title, icon = meta.icon;
                if (lv === 2) title = esc(prettyDate(k));
                else if (lv === 3) { title = cap(k); icon = k === 'evening' ? '\uD83C\uDF07' : '\uD83C\uDF05'; }
                else if (lv === 4) { title = cap(k) + ' test'; icon = k === 'online' ? '\uD83C\uDF10' : '\uD83D\uDCC4'; }
                else title = meta.label + esc(lv === 1 ? secBare(k) : clsBare(k));
                var sub = arr.length + ' question' + (arr.length !== 1 ? 's' : '');
                var subj = subjectSummary(arr);
                if (subj) sub += ' \u00B7 ' + subj;
                return card(icon, title, sub, 'QPool.drillTo(' + lv + ',\'' + encodeURIComponent(k) + '\')');
            }).join('') + '</div>';

        foot.innerHTML =
            (lv > 0 ? btn('\u2190 Back', 'QPool.up(' + (lv - 1) + ')') : '') +
            btn('\u21BB Refresh', 'QPool.refreshPool()') +
            '<span style="flex:1"></span>' +
            (QP.undo.length ? btn('\u21A9 Undo remove', 'QPool.undoRemove()') : '');
    }

    /* ── The bucket: every teacher's questions for ONE test ───────────── */
    function bucketItems() {
        var q = QP.query.toLowerCase();
        return scopedItems(5).filter(function (it) {
            if (!q) return true;
            return (it.label + ' ' + it.chapter + ' ' + (it.lecture || it.topic) + ' ' + subjectOf(it)).toLowerCase().indexOf(q) >= 0;
        });
    }

    function renderBucket() {
        ensureShell();
        var d = QP.drill;
        var all = scopedItems(5);
        // Default to everything in this bucket being selected.
        all.forEach(function (i) { if (!QP.touchedSel) QP.selected.add(i.id); });
        QP.touchedSel = true;

        bodyEl().innerHTML = hero() + crumb() +
            '<div class="qp-hero" style="background:var(--card,#fff);border-color:var(--line,#dceae4)">' +
            '<div class="ic" style="background:var(--soft,#eef4f1)">' + (d.mode === 'online' ? '\uD83C\uDF10' : '\uD83D\uDCC4') + '</div>' +
            '<div><h4>Class ' + esc(clsBare(d.cls)) + (d.sec && d.sec !== '—' ? ' \u00B7 Section ' + esc(secBare(d.sec)) : '') + '</h4>' +
            '<p>' + esc(prettyDate(d.date)) + ' \u00B7 ' + esc(cap(d.shift)) + ' shift \u00B7 ' + esc(cap(d.mode)) + ' test</p></div>' +
            '<span class="n">' + all.length + ' question' + (all.length !== 1 ? 's' : '') + '</span></div>' +
            '<div class="qp-bar">' +
            '<div class="qp-search"><i>\uD83D\uDD0D</i><input id="qpool-q" placeholder="Search these questions\u2026" value="' + esc(QP.query) + '" oninput="QPool.search(this.value)"></div>' +
            btn('Select all', 'QPool.selectAllVisible(true)') +
            btn('Clear selection', 'QPool.selectAllVisible(false)') +
            btn('\u21BB', 'QPool.refreshPool()', '', 'title="Refresh"') +
            '</div>' +
            '<div id="qpool-list"></div>';
        renderList();
        renderFoot();
    }

    function renderList() {
        var el = document.getElementById('qpool-list');
        if (!el) return;
        var rows = bucketItems();
        if (!rows.length) {
            el.innerHTML = '<div class="qp-empty" style="padding:28px 10px;font:600 .84rem/1.5 inherit">Nothing matches this search.</div>';
            return;
        }
        var groups = new Map();
        rows.forEach(function (it) {
            var s = subjectOf(it);
            if (!groups.has(s)) groups.set(s, []);
            groups.get(s).push(it);
        });
        el.innerHTML = [...groups.keys()].sort().map(function (s) {
            var list = groups.get(s);
            var allSel = list.every(function (i) { return QP.selected.has(i.id); });
            return '<div class="qp-group">' +
                '<div class="qp-ghead"><b>' + esc(s) + '</b><span class="qp-gcount">' + list.length + ' question' + (list.length !== 1 ? 's' : '') + '</span>' +
                '<span style="flex:1"></span>' +
                '<button class="qp-link" onclick="QPool.toggleSubject(\'' + encodeURIComponent(s) + '\')">' + (allSel ? 'Unselect all' : 'Select all') + '</button></div>' +
                list.map(function (it) {
                    var on = QP.selected.has(it.id);
                    var tags = [];
                    if (it.chapter) tags.push('<span class="qp-tag">' + esc(it.chapter) + '</span>');
                    if (it.lecture || it.topic) tags.push('<span class="qp-tag">' + esc(it.lecture || it.topic) + '</span>');
                    tags.push('<span class="qp-tag">Q' + ((Number(it.questionIndex) || 0) + 1) + '</span>');
                    if (it.addedBy) tags.push('<span>added by ' + esc(it.addedBy) + '</span>');
                    return '<label class="qp-row' + (on ? ' on' : '') + '">' +
                        '<input type="checkbox" ' + (on ? 'checked' : '') + ' onchange="QPool.toggle(' + it.id + ',this.checked)">' +
                        '<span style="flex:1;min-width:0">' +
                        '<span class="qp-qtext">' + esc(it.label || '(no preview available)') + '</span>' +
                        '<span class="qp-meta">' + tags.join('') + '</span></span>' +
                        '<button class="qp-x" title="Remove from pool (Ctrl+Z to undo)" onclick="event.preventDefault();QPool.remove(' + it.id + ')">\u2715</button>' +
                        '</label>';
                }).join('') +
                '</div>';
        }).join('');
        typeset(el);
    }

    function renderFoot() {
        var foot = footEl();
        if (!foot) return;
        if (level() !== 5) { renderBrowse(); return; }
        var n = scopedItems(5).filter(function (i) { return QP.selected.has(i.id); }).length;
        var dis = n ? '' : 'disabled';
        var online = QP.drill.mode === 'online';
        foot.innerHTML =
            btn('\u2190 Back', 'QPool.up(4)') +
            '<span style="font:800 .82rem/1 inherit;color:var(--teal-deep,#0e7e65)">' + n + ' selected</span>' +
            (QP.undo.length ? btn('\u21A9 Undo remove', 'QPool.undoRemove()') : '') +
            btn('Clear this test', 'QPool.clearBucket()', 'danger') +
            '<span style="flex:1"></span>' +
            (online
                ? btn('\uD83D\uDCC4 Offline paper', 'QPool.goOffline()', '', dis) + btn('\uD83C\uDF10 Create online test', 'QPool.goOnline()', 'primary', dis)
                : btn('\uD83C\uDF10 Online test', 'QPool.goOnline()', '', dis) + btn('\uD83D\uDCC4 Generate paper', 'QPool.goOffline()', 'primary', dis));
    }

    /* ── Offline Word paper ──────────────────────────────────────────── */
    function renderOffline() {
        ensureShell();
        var picked = selectedInBucket();
        var subjects = [];
        picked.forEach(function (i) { var s = subjectOf(i); if (subjects.indexOf(s) < 0) subjects.push(s); });
        var d = QP.drill;
        var title = 'Class ' + (clsBare(d.cls) || '') + ' ' + cap(d.shift || '') + ' Test \u2014 ' + prettyDate(d.date);
        bodyEl().innerHTML =
            '<div style="font:700 .8rem/1.4 inherit;color:var(--ink-dim,#5d7a72);margin-bottom:14px">' + picked.length + ' question' +
            (picked.length !== 1 ? 's' : '') + ' from ' + subjects.length + ' subject' + (subjects.length !== 1 ? 's' : '') +
            ' (' + esc(subjects.join(', ')) + ')</div>' +
            '<div class="qp-fields">' +
            field('Paper title', 'qpool-title', title.trim()) +
            field('Subject line', 'qpool-subject', subjects.join(' / ')) +
            field('Class', 'qpool-class', d.cls || '') +
            field('Chapter / syllabus', 'qpool-chapter', '') +
            field('Test type', 'qpool-testtype', cap(d.shift || '') + ' Combined Test') +
            '</div>' +
            '<div style="margin-top:14px;font:600 .78rem/1.6 inherit;color:var(--ink-dim,#5d7a72)">You will get three Word files: question paper, answer key and solutions.</div>';
        footEl().innerHTML =
            btn('\u2190 Back', 'QPool.goBucket()') + '<span style="flex:1"></span>' +
            btn('\u2728 Generate Word files', 'QPool.generateOffline()', 'primary');
    }

    function selectedInBucket() {
        return scopedItems(5).filter(function (i) { return QP.selected.has(i.id); });
    }

    /* ── Progress screen with a real bar ──────────────────────────────── */
    function renderProgress(title, step) {
        ensureShell();
        bodyEl().innerHTML =
            '<div class="qp-prog">' +
            '<div style="font:800 1rem/1.3 inherit;margin-bottom:14px">' + esc(title) + '</div>' +
            '<div class="qp-prog-row"><span id="qpool-step">' + esc(step || 'Starting\u2026') + '</span><span class="qp-prog-pct" id="qpool-pct">0%</span></div>' +
            '<div class="qp-prog-track"><div class="qp-prog-fill" id="qpool-bar"></div></div>' +
            '<div style="margin-top:12px;font:600 .74rem/1.5 inherit;color:var(--ink-dim,#5d7a72)">Equations and images take a little while \u2014 please keep this page open.</div>' +
            '</div>';
        footEl().innerHTML = '';
    }

    function setProgress(pct, step) {
        var p = Math.max(0, Math.min(100, Math.round(pct || 0)));
        var bar = document.getElementById('qpool-bar'); if (bar) bar.style.width = p + '%';
        var pc = document.getElementById('qpool-pct'); if (pc) pc.textContent = p + '%';
        var st = document.getElementById('qpool-step'); if (st && step) st.textContent = step;
    }

    var STEP_TEXT = {
        build: 'Building document structure\u2026',
        latex: 'Converting equations\u2026',
        template: 'Applying institute template\u2026',
        finalise: 'Packaging Word files\u2026',
        pdf_questions: 'Rendering question paper\u2026',
        pdf_solutions: 'Rendering solutions\u2026'
    };

    function download(b64, name) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    }

    /* The progress endpoint answers { success, progress: { pct, status, … } },
       so the payload MUST be unwrapped — reading pct/status off the envelope is
       what used to leave the bar stuck at 0%. */
    async function pollProgress(progressId, onStep) {
        for (var i = 0; i < 1800; i++) {
            await new Promise(function (r) { setTimeout(r, 400); });
            var d;
            try { d = await api('/api/admin/generate-paper/progress/' + progressId); }
            catch (e) {
                if (i > 6) throw e;   // a brief hiccup shouldn't kill a long run
                continue;
            }
            var p = (d && d.progress) || d || {};
            if (onStep) onStep(Number(p.pct) || 0, STEP_TEXT[p.currentStep] || p.currentStep || '');
            if (p.status === 'completed') return p.files || {};
            if (p.status === 'failed') throw new Error(p.error || 'Generation failed');
        }
        throw new Error('Generation timed out');
    }

    /* ── Online test + class/section student picker ───────────────────── */
    function strictHtml() {
        var on = !!QP.strict;
        return '<button type="button" class="qp-strict' + (on ? ' on' : '') + '" id="qpool-ot-strict" onclick="QPool.toggleStrict()">' +
            '<span class="sw"><i></i></span>' +
            '<span style="flex:1;min-width:0"><b>' + (on ? 'Strict mode is on' : 'Strict mode is off') + '</b>' +
            '<small>' + (on ? 'Tab switches are counted and the test auto-submits' : 'Students can leave the test window freely') + '</small></span>' +
            '</button>';
    }

    function renderOnline() {
        ensureShell();
        var picked = selectedInBucket();
        var d = QP.drill;
        var pad = function (n) { return String(n).padStart(2, '0'); };
        var local = function (dt) {
            return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + 'T' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
        };
        // Default the window to the pooled test date + shift.
        var startH = d.shift === 'evening' ? 16 : 9;
        var live = new Date();
        if (d.date) {
            var parts = String(d.date).split('-');
            live = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), startH, 0, 0);
        }
        var ends = new Date(live.getTime() + 6 * 3600 * 1000);

        bodyEl().innerHTML =
            '<div class="qp-ohead"><div class="qp-obadge">\uD83C\uDF10</div><div>' +
            '<div class="qp-ot">Set up the online test</div>' +
            '<div class="qp-os">' + picked.length + ' question' + (picked.length !== 1 ? 's' : '') + ' \u00B7 Class ' + esc(clsBare(d.cls) || '') +
            (d.sec && d.sec !== '—' ? ' \u00B7 Section ' + esc(secBare(d.sec)) : '') + ' \u00B7 ' + esc(prettyDate(d.date)) +
            ' \u00B7 ' + esc(cap(d.shift)) + '</div></div></div>' +

            sec('\uD83D\uDCDD Test name',
                '<div class="qp-fields">' +
                field('What students will see', 'qpool-ot-name', 'Class ' + (clsBare(d.cls) || '') + ' ' + cap(d.shift || '') + ' Test') +
                '</div>') +

            sec('\uD83C\uDFAF Marking &amp; duration',
                '<div class="qp-fields">' +
                field('Marks for correct', 'qpool-ot-mc', '4', 'number') +
                field('Deduction for wrong', 'qpool-ot-mw', '-1', 'number') +
                field('Duration (minutes)', 'qpool-ot-dur', '60', 'number', 'min="5"') +
                '</div>') +

            sec('\uD83D\uDCC5 Schedule',
                '<div class="qp-fields">' +
                '<label><span>Goes live at</span>' + dtPicker('qpool-ot-live', live) + '</label>' +
                '<label><span>Last attempt by</span>' + dtPicker('qpool-ot-ends', ends) + '</label>' +
                '</div>') +

            sec('\u2699\uFE0F Restrictions',
                '<div class="qp-fields">' +
                field('Max attempts', 'qpool-ot-max', '1', 'number', 'min="1"') +
                '<label><span>Strict mode</span>' + strictHtml() + '</label>' +
                '</div>') +

            sec('\uD83D\uDC65 Assign students',
                '<div class="qp-sum" id="qpool-stu-sum">No students selected yet.</div>' +
                '<div id="qpool-stu" style="margin-top:11px"></div>');
        footEl().innerHTML =
            btn('\u2190 Back', 'QPool.goBucket()') + '<span style="flex:1"></span>' +
            btn('\uD83C\uDF10 Create online test', 'QPool.createOnline()', 'primary');
        renderStudents();
        windowGap();
    }

    function studentTree() {
        var tree = new Map();
        QP.students.forEach(function (s) {
            var cn = String(s.className || s.class_name || '').trim() || 'Unassigned';
            var sec = String(s.section || s.batch_name || '').trim() || 'General';
            if (!tree.has(cn)) tree.set(cn, new Map());
            var secs = tree.get(cn);
            if (!secs.has(sec)) secs.set(sec, []);
            secs.get(sec).push(s);
        });
        return tree;
    }

    function rollOf(s) { return String(s.rollNumber || s.roll_number || ''); }

    function stuSummary() {
        var el = document.getElementById('qpool-stu-sum');
        if (!el) return;
        var n = QP.pickedRolls.size;
        if (!n) { el.innerHTML = 'No students selected yet \u2014 pick a class below.'; return; }
        var names = QP.students.filter(function (s) { return QP.pickedRolls.has(rollOf(s)); })
            .map(function (s) { return s.name || rollOf(s); });
        el.innerHTML = '<b style="color:var(--teal-deep,#0e7e65)">' + n + ' student' + (n !== 1 ? 's' : '') + ' will get this test</b> \u00B7 ' +
            esc(names.slice(0, 6).join(', ')) + (names.length > 6 ? ' \u2026 +' + (names.length - 6) + ' more' : '');
    }

    function renderStudents() {
        var el = document.getElementById('qpool-stu');
        if (!el) return;
        if (!QP.students.length) {
            el.innerHTML = '<div style="font:600 .8rem/1.4 inherit;color:var(--ink-dim,#5d7a72)">No registered students found.</div>';
            return;
        }
        var tree = studentTree();
        var keys = function (m) { return [...m.keys()].sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); }); };

        var pick = function (icon, title, sub, onclick, active) {
            return '<div class="qp-pick' + (active ? ' on' : '') + '" role="button" tabindex="0" onclick="' + onclick + '">' +
                '<span class="ic">' + icon + '</span>' +
                '<span style="flex:1;min-width:0"><span class="tt">' + title + '</span><span class="sb">' + sub + '</span></span>' +
                '<span style="color:var(--ink-muted,#9db3ac);font-size:.95rem">\u203A</span></div>';
        };
        var counter = '<span style="margin-left:auto;display:inline-flex;align-items:center;gap:9px">' +
            '<b style="color:var(--teal-deep,#0e7e65)">' + QP.pickedRolls.size + ' selected</b>' +
            (QP.pickedRolls.size ? '<button class="qp-link red" onclick="QPool.clearStudents()">Clear all</button>' : '') + '</span>';
        stuSummary();
        var link = function (label, fn) { return '<button class="qp-link" onclick="' + fn + '">' + label + '</button>'; };
        var sep = '<span style="color:var(--ink-muted,#9db3ac)">\u203A</span>';

        // LEVEL 1 · class cards
        if (!QP.stuClass || !tree.has(QP.stuClass)) {
            QP.stuClass = null; QP.stuSection = null;
            el.innerHTML = '<div class="qp-crumb"><span class="cur">All classes</span>' + counter + '</div>' +
                '<div class="qp-grid">' + keys(tree).map(function (c) {
                    var secs = tree.get(c);
                    var all = [].concat.apply([], [...secs.values()]);
                    var sel = all.filter(function (s) { return QP.pickedRolls.has(rollOf(s)); }).length;
                    var sub = all.length + ' students \u00B7 ' + secs.size + ' section' + (secs.size !== 1 ? 's' : '') +
                        (sel ? ' \u00B7 <b style="color:var(--teal-deep,#0e7e65)">' + sel + ' selected</b>' : '');
                    return pick('\uD83C\uDF93', esc(c), sub, 'QPool.openClass(\'' + encodeURIComponent(c) + '\')', sel > 0);
                }).join('') + '</div>';
            return;
        }

        // LEVEL 2 · section cards
        var secs = tree.get(QP.stuClass);
        if (!QP.stuSection || !secs.has(QP.stuSection)) {
            QP.stuSection = null;
            el.innerHTML = '<div class="qp-crumb">' + link('All classes', 'QPool.backClasses()') + sep +
                '<span class="cur">' + esc(QP.stuClass) + '</span>' + counter + '</div>' +
                '<div class="qp-grid">' + keys(secs).map(function (sec) {
                    var arr = secs.get(sec);
                    var sel = arr.filter(function (s) { return QP.pickedRolls.has(rollOf(s)); }).length;
                    var sub = arr.length + ' student' + (arr.length !== 1 ? 's' : '') +
                        (sel ? ' \u00B7 <b style="color:var(--teal-deep,#0e7e65)">' + sel + ' selected</b>' : '');
                    return pick('\uD83D\uDCC1', 'Section ' + esc(secBare(sec)), sub, 'QPool.openSection(\'' + encodeURIComponent(sec) + '\')', sel > 0);
                }).join('') + '</div>';
            return;
        }

        // LEVEL 3 · the students of one section
        var arr = secs.get(QP.stuSection);
        var allSel = arr.length > 0 && arr.every(function (s) { return QP.pickedRolls.has(rollOf(s)); });
        el.innerHTML = '<div class="qp-crumb">' +
            link('All classes', 'QPool.backClasses()') + sep +
            link(esc(QP.stuClass), 'QPool.backSections()') + sep +
            '<span class="cur">Section ' + esc(secBare(QP.stuSection)) + '</span>' + counter + '</div>' +
            '<button class="qp-btn" style="margin-bottom:9px;padding:7px 12px" onclick="QPool.toggleSection()">' +
            (allSel ? 'Clear this section' : 'Select whole section') + '</button>' +
            '<div style="border:1px solid var(--line,#dceae4);border-radius:13px;overflow:hidden;background:var(--card,#fff)">' +
            arr.map(function (s) {
                var roll = rollOf(s);
                var on = QP.pickedRolls.has(roll);
                return '<label class="qp-row' + (on ? ' on' : '') + '" style="align-items:center">' +
                    '<input type="checkbox" ' + (on ? 'checked' : '') + ' onchange="QPool.toggleStudent(\'' + encodeURIComponent(roll) + '\',this.checked)">' +
                    '<span style="font:700 .84rem/1.2 inherit;flex:1">' + esc(s.name || 'Student') + '</span>' +
                    '<span style="font:600 .72rem/1.2 inherit;color:var(--ink-dim,#5d7a72)">' + esc(roll) + '</span></label>';
            }).join('') + '</div>';
    }

    async function loadPool() {
        try {
            var data = await api('/api/admin/question-pool');
            QP.items = (data && data.items) || [];
            QP.loaded = true;
            // Keep selections that still exist.
            var live = new Set(QP.items.map(function (i) { return i.id; }));
            QP.selected.forEach(function (id) { if (!live.has(id)) QP.selected.delete(id); });
            QP.touchedSel = false;
        } catch (e) {
            QP.items = []; QP.selected = new Set();
            toast(e.message || 'Could not load the pool');
        }
        refreshLauncher();
    }

    // Pull the full question content for the selected pointers, on demand.
    async function resolveSelected() {
        var ids = selectedInBucket().map(function (i) { return i.id; });
        var r = await api('/api/admin/question-pool/resolve', { method: 'POST', body: { ids: ids } });
        return r || { questions: [], missing: [] };
    }

    /* ── "Somebody pooled new questions" notifications ─────────────────── */
    async function pollEvents(firstRun) {
        try {
            var d = await api('/api/admin/question-pool/events?since=' + (QP.lastEventTs || 0));
            if (!d || !d.success) return;
            if (firstRun || !QP.seenEvents) { QP.lastEventTs = d.now || Date.now(); QP.seenEvents = true; return; }
            var fresh = (d.events || []);
            if (!fresh.length) return;
            QP.lastEventTs = d.now || Date.now();
            QP.news = fresh.concat(QP.news).slice(0, 6);
            toast('\uD83D\uDD14 ' + fresh[0].message);
            if (document.getElementById('qpool-body') && level() < 5) { await loadPool(); renderBrowse(); }
            else refreshLauncher();
        } catch (e) { /* silent */ }
    }

    /* ── Ctrl+Z undo of an accidental removal ─────────────────────────── */
    function installUndoKey() {
        if (window.__qpoolUndoKey) return;
        window.__qpoolUndoKey = true;
        document.addEventListener('keydown', function (e) {
            var z = (e.key === 'z' || e.key === 'Z');
            if (!z || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
            var tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
            if (!QP.undo.length) return;
            e.preventDefault();
            QPool.undoRemove();
        });
    }

    /* ── Public API ─────────────────────────────────────────────── */
    var QPool = {
        // Render into the in-page "Combine & Create" section.
        async mount() {
            ensureShell();
            renderProgress('Combine & Create Test', 'Loading pooled questions\u2026');
            setProgress(35, 'Loading pooled questions\u2026');
            await loadPool();
            renderBrowse();
            pollEvents(true);
        },
        async open() { await QPool.mount(); },
        async refreshPool() {
            await loadPool();
            if (level() === 5) renderBucket(); else renderBrowse();
        },
        close() {
            if (inline()) return;
            var m = document.getElementById('qpool-overlay');
            if (m) m.style.display = 'none';
        },

        /* drill navigation */
        drillTo(lv, enc) {
            var v = decodeURIComponent(enc);
            var d = QP.drill;
            if (lv === 0) { d.cls = v; d.sec = null; d.date = null; d.shift = null; d.mode = null; }
            else if (lv === 1) { d.sec = v; d.date = null; d.shift = null; d.mode = null; }
            else if (lv === 2) { d.date = v; d.shift = null; d.mode = null; }
            else if (lv === 3) { d.shift = v; d.mode = null; }
            else { d.mode = v; }
            QP.query = '';
            QP.touchedSel = false;
            renderBrowse();
        },
        up(lv) {
            var d = QP.drill;
            if (lv <= 0) { d.cls = null; d.sec = null; d.date = null; d.shift = null; d.mode = null; }
            else if (lv === 1) { d.sec = null; d.date = null; d.shift = null; d.mode = null; }
            else if (lv === 2) { d.date = null; d.shift = null; d.mode = null; }
            else if (lv === 3) { d.shift = null; d.mode = null; }
            else { d.mode = null; }
            QP.query = '';
            renderBrowse();
        },
        goBucket() { renderBucket(); },
        dismissNews() { QP.news = []; renderBrowse(); },

        search(v) { QP.query = String(v || ''); renderList(); },
        toggle(id, on) { if (on) QP.selected.add(id); else QP.selected.delete(id); renderFoot(); },
        selectAllVisible(on) {
            bucketItems().forEach(function (i) { if (on) QP.selected.add(i.id); else QP.selected.delete(i.id); });
            renderList(); renderFoot();
        },
        toggleSubject(enc) {
            var s = decodeURIComponent(enc);
            var rows = scopedItems(5).filter(function (i) { return subjectOf(i) === s; });
            var allSel = rows.every(function (i) { return QP.selected.has(i.id); });
            rows.forEach(function (i) { if (allSel) QP.selected.delete(i.id); else QP.selected.add(i.id); });
            renderList(); renderFoot();
        },

        /* removal + undo */
        async remove(id) {
            var snapshot = QP.items.filter(function (i) { return i.id === id; })[0] || null;
            var r;
            try { r = await api('/api/admin/question-pool/' + id, { method: 'DELETE' }); }
            catch (e) { toast(e.message || 'Failed'); return; }
            var removed = (r && r.removed) || snapshot;
            if (removed) QP.undo.push([removed]);
            QP.items = QP.items.filter(function (i) { return i.id !== id; });
            QP.selected.delete(id);
            refreshLauncher();
            toast('Removed \u2014 press Ctrl+Z to undo');
            if (level() === 5 && scopedItems(5).length) { renderList(); renderFoot(); }
            else renderBrowse();
        },
        async undoRemove() {
            if (!QP.undo.length) { toast('Nothing to undo'); return; }
            var batch = QP.undo.pop();
            try {
                var r = await api('/api/admin/question-pool/restore', { method: 'POST', body: { items: batch } });
                toast('Restored ' + ((r && r.restored) || batch.length) + ' question(s)');
            } catch (e) { toast(e.message || 'Could not undo'); QP.undo.push(batch); return; }
            await loadPool();
            if (level() === 5) renderBucket(); else renderBrowse();
        },
        async clearBucket() {
            var d = QP.drill;
            if (!confirm('Remove every pooled question for this test?')) return;
            try {
                var r = await api('/api/admin/question-pool/clear', {
                    method: 'POST',
                    body: { context: { className: d.cls, section: d.sec === '—' ? '' : d.sec, testDate: d.date, shift: d.shift, mode: d.mode } }
                });
                if (r && r.removed && r.removed.length) QP.undo.push(r.removed);
                toast('Cleared \u2014 press Ctrl+Z to undo');
            } catch (e) { toast(e.message || 'Failed'); return; }
            await loadPool();
            QPool.up(4);
        },

        // Push whatever is in the page's local selection basket into the pool,
        // after asking which test it belongs to.
        async sendBasket() {
            var items = localBasketItems();
            if (!items.length) { toast('Select some questions first'); return; }
            var ctx = await openCtxPopup(items.length);
            if (!ctx) return;
            try {
                var r = await api('/api/admin/question-pool/add', {
                    method: 'POST',
                    body: { items: items, context: ctx }
                });
                toast('Added ' + (r.added || 0) + ' to Class ' + clsBare(ctx.className) + ' \u00B7 ' + prettyDate(ctx.testDate) + ' \u00B7 ' + cap(ctx.shift) +
                    (r.duplicate ? ' \u00B7 ' + r.duplicate + ' already there' : '') +
                    (r.invalid ? ' \u00B7 ' + r.invalid + ' skipped' : ''));
                try {
                    if (typeof window.instClearBasket === 'function') window.instClearBasket();
                    else if (typeof window.clearPaperBasket === 'function') window.clearPaperBasket();
                } catch (e) { }
                refreshLauncher();
                if (document.getElementById('qpool-body')) { await loadPool(); renderBrowse(); }
            } catch (e) { toast(e.message || 'Could not send to the pool'); }
        },

        goOffline() {
            if (!selectedInBucket().length) { toast('Select at least one question'); return; }
            renderOffline();
        },
        async generateOffline() {
            var meta = {
                paperTitle: val('qpool-title') || 'Combined Test',
                paperSubject: val('qpool-subject'),
                paperClass: val('qpool-class'),
                paperChapter: val('qpool-chapter'),
                paperTestType: val('qpool-testtype') || 'Combined Test'
            };
            renderProgress('Generating \u201C' + meta.paperTitle + '\u201D', 'Fetching questions\u2026');
            setProgress(4, 'Fetching questions\u2026');
            try {
                var res = await resolveSelected();
                var questions = (res.questions || []).filter(Boolean);
                if (!questions.length) throw new Error('None of the selected questions could be found in the question bank');
                if ((res.missing || []).length) toast((res.missing.length) + ' pooled question(s) could not be found and were skipped');
                setProgress(10, 'Preparing template\u2026');

                var tplId = null;
                try {
                    var tpls = await api('/api/admin/paper-templates');
                    var rows = Array.isArray(tpls) ? tpls : (tpls && tpls.rows) || [];
                    if (rows.length) tplId = rows[0].id;
                } catch (e) { }

                var start = await api('/api/admin/generate-paper/start', {
                    method: 'POST',
                    body: Object.assign({ questions: questions, templateId: tplId }, meta)
                });
                setProgress(12, 'Building document structure\u2026');
                var files = await pollProgress(start.progressId, function (pct, step) {
                    setProgress(Math.max(12, pct), step);
                });
                setProgress(100, 'Done \u2014 downloading\u2026');

                var stem = meta.paperTitle.replace(/[^\w\s-]/g, '').trim() || 'Combined Test';
                if (files.questionPaper) download(files.questionPaper, stem + '.docx');
                if (files.answerKey) download(files.answerKey, stem + ' - Answer Key.docx');
                if (files.solutions) download(files.solutions, stem + ' - Solutions.docx');
                toast('Word files downloaded');
                setTimeout(function () { renderBucket(); }, 900);
            } catch (e) {
                toast(e.message || 'Generation failed');
                renderOffline();
            }
        },

        async goOnline() {
            if (!selectedInBucket().length) { toast('Select at least one question'); return; }
            renderProgress('Configure online test', 'Loading students\u2026');
            setProgress(45, 'Loading students\u2026');
            try {
                var rows = await api('/api/admin/registered-students');
                var list = Array.isArray(rows) ? rows : (rows && rows.students) || [];
                QP.students = list.filter(function (s) { return s && (s.rollNumber || s.roll_number); });
            } catch (e) { QP.students = []; }
            // Jump straight into the class/section the pooled test is for.
            QP.stuClass = null; QP.stuSection = null;
            var wantC = String(QP.drill.cls || '').trim();
            var wantS = String(QP.drill.sec || '').trim();
            var tree = studentTree();
            if (wantC && tree.has(wantC)) {
                QP.stuClass = wantC;
                if (wantS && wantS !== '—' && tree.get(wantC).has(wantS)) QP.stuSection = wantS;
            }
            renderOnline();
        },
        gap() { windowGap(); },
        toggleStrict() {
            QP.strict = !QP.strict;
            var b = document.getElementById('qpool-ot-strict');
            if (b && b.parentNode) {
                var w = document.createElement('div');
                w.innerHTML = strictHtml();
                b.parentNode.replaceChild(w.firstChild, b);
            }
        },
        quick(which) {
            var d = QP.drill;
            var start = new Date();
            if (which === 'shift' && d.date) {
                var p = String(d.date).split('-');
                start = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), d.shift === 'evening' ? 16 : 9, 0, 0);
            } else if (which === 'tomorrow') {
                start = new Date();
                start.setDate(start.getDate() + 1);
                start.setHours(9, 0, 0, 0);
            }
            if (which === '2h') {
                var live = readDT('qpool-ot-live') || Date.now();
                setDT('qpool-ot-ends', new Date(live + 2 * 3600 * 1000));
            } else {
                setDT('qpool-ot-live', start);
                setDT('qpool-ot-ends', new Date(start.getTime() + 6 * 3600 * 1000));
            }
            windowGap();
        },
        clearStudents() { QP.pickedRolls = new Set(); renderStudents(); },
        openClass(enc) { QP.stuClass = decodeURIComponent(enc); QP.stuSection = null; renderStudents(); },
        openSection(enc) { QP.stuSection = decodeURIComponent(enc); renderStudents(); },
        backClasses() { QP.stuClass = null; QP.stuSection = null; renderStudents(); },
        backSections() { QP.stuSection = null; renderStudents(); },
        toggleStudent(enc, on) {
            var roll = decodeURIComponent(enc);
            if (on) QP.pickedRolls.add(roll); else QP.pickedRolls.delete(roll);
            renderStudents();
        },
        toggleSection() {
            var tree = studentTree();
            var arr = ((tree.get(QP.stuClass) || new Map()).get(QP.stuSection)) || [];
            var allSel = arr.every(function (s) { return QP.pickedRolls.has(rollOf(s)); });
            arr.forEach(function (s) {
                if (allSel) QP.pickedRolls.delete(rollOf(s)); else QP.pickedRolls.add(rollOf(s));
            });
            renderStudents();
        },
        async createOnline() {
            var picked = selectedInBucket();
            if (!QP.pickedRolls.size) { toast('Select the students who should get this test'); return; }
            var keys = picked.map(function (i) {
                return { chapter: i.chapter, lecture: i.lecture || i.topic, questionIndex: i.questionIndex, source: i.source || 'bank' };
            });
            var liveAt = readDT('qpool-ot-live') || Date.now();
            var endsAt = readDT('qpool-ot-ends') || (liveAt + 6 * 3600 * 1000);
            if (endsAt <= liveAt) { toast('The closing time must be after the start time'); return; }
            var body = {
                testName: val('qpool-ot-name') || 'Combined Online Test',
                marksCorrect: Number(val('qpool-ot-mc')) || 4,
                marksWrong: Number(val('qpool-ot-mw')) || -1,
                durationMinutes: Number(val('qpool-ot-dur')) || 60,
                liveAt: liveAt,
                endsAt: endsAt,
                maxAttempts: Number(val('qpool-ot-max')) || 1,
                isStrict: QP.strict ? 1 : 0,
                assignedRolls: [...QP.pickedRolls],
                questionKeys: keys
            };
            renderProgress('Creating the online test', 'Saving\u2026');
            setProgress(55, 'Saving\u2026');
            try {
                await api('/api/admin/online-tests', { method: 'POST', body: body });
                setProgress(100, 'Created');
                toast('Online test created for ' + QP.pickedRolls.size + ' student(s)');
                QP.pickedRolls = new Set();
                try { if (typeof window.loadOnlineTests === 'function') await window.loadOnlineTests(); } catch (e) { }
                setTimeout(function () { renderBucket(); }, 700);
            } catch (e) {
                toast(e.message || 'Could not create the online test');
                renderOnline();
            }
        },
        refresh: refreshLauncher
    };

    window.QPool = QPool;

    function boot() {
        injectCss();
        recallCtx();
        installUndoKey();
        // Watch for other teachers pooling questions.
        pollEvents(true);
        // JITTERED POLLING.
        // A fixed 25s interval makes every open browser tab in every institute
        // fire at the same instant, producing a spiky "thundering herd" of
        // requests. Spreading each client randomly over a 25-40s window turns
        // that spike into a flat, predictable load the servers can absorb.
        (function scheduleNextPoll() {
            var delay = 25000 + Math.floor(Math.random() * 15000);
            setTimeout(function () {
                // Don't poll at all while the tab is in the background — saves
                // a large share of total traffic for free.
                if (!document.hidden) { pollEvents(false); }
                scheduleNextPoll();
            }, delay);
        })();
        if (inline()) {
            var stray = document.getElementById('qpool-launcher');
            if (stray) stray.remove();
            return;
        }
        launcher();
        refreshLauncher();
        setInterval(refreshLauncher, 1200);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
