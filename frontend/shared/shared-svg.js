/* ═══════════════════════════════════════════════════════════════════════
   SHARED SVG SUPPORT  (AI-drawn diagrams)
   ───────────────────────────────────────────────────────────────────────
   The extraction prompt asks the AI to DRAW each diagram / graph / circuit /
   molecular structure as inline SVG and ship it inside the same JSON as the
   question. Instead of adding a new field to every renderer, an SVG is
   converted once (at JSON-parse time) into a data URI:

       data:image/svg+xml;base64,PHN2ZyB4bWxucz0i…

   …and stored in the EXISTING image fields (questionImages, optionImages,
   table image cells, solution images). Every renderer already accepts a data
   URI, so nothing else has to change.

   SECURITY: SVG is XML and may carry <script> / event handlers. We sanitize
   here and only ever render through <img src="data:…">, which is a sandboxed
   image context where scripts cannot run. Never inject raw SVG via innerHTML.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
    var MAX_SVG_CHARS = 120000;

    function vyLooksLikeSvg(value) {
        return typeof value === 'string' && /<svg[\s>]/i.test(value);
    }

    function vyIsSvgDataUri(value) {
        return typeof value === 'string' && /^data:image\/svg\+xml/i.test(String(value).trim());
    }

    /* Strip everything executable / externally-referencing out of SVG markup. */
    function vySanitizeSvg(raw) {
        var s = String(raw == null ? '' : raw).trim();
        if (!s) return null;

        s = s.replace(/^```(?:svg|xml|html)?\s*/i, '').replace(/```\s*$/, '').trim();
        s = s.replace(/<\?xml[\s\S]*?\?>/gi, '')
            .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '');

        if (!vyLooksLikeSvg(s)) return null;

        var start = s.search(/<svg[\s>]/i);
        if (start > 0) s = s.slice(start);
        var end = s.toLowerCase().lastIndexOf('</svg>');
        if (end !== -1) s = s.slice(0, end + 6);

        s = s.replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
            .replace(/<(script|foreignObject|iframe|object|embed|audio|video|handler|set|animate|animateMotion|animateTransform)\b[^>]*\/?>/gi, '')
            .replace(/<image\b[^>]*>/gi, '')
            .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
            .replace(/(?:xlink:)?href\s*=\s*("|')\s*(?:javascript|data|file):[^"']*\1/gi, '')
            .replace(/url\(\s*("|')?\s*(?:https?|javascript|data|file):[^)]*\)/gi, 'none');

        if (!/<svg[\s>]/i.test(s)) return null;
        if (s.length > MAX_SVG_CHARS) return null;

        if (!/viewBox\s*=/i.test(s)) {
            var w = /(?:^|\s)width\s*=\s*"?([\d.]+)/i.exec(s);
            var h = /(?:^|\s)height\s*=\s*"?([\d.]+)/i.exec(s);
            if (w && h) s = s.replace(/<svg/i, '<svg viewBox="0 0 ' + w[1] + ' ' + h[1] + '"');
        }
        if (!/xmlns\s*=/i.test(s)) {
            s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
        }
        return s;
    }

    function vySvgToDataUri(raw) {
        if (vyIsSvgDataUri(raw)) return String(raw).trim();
        var clean = vySanitizeSvg(raw);
        if (!clean) return null;
        try {
            return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(clean)));
        } catch (e) {
            return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(clean);
        }
    }

    /* Universal <img src> builder: http URL / data URI / raw SVG / bare base64. */
    function vyImgSrc(value) {
        if (!value) return '';
        var s = String(value).trim();
        if (!s) return '';
        if (vyLooksLikeSvg(s)) return vySvgToDataUri(s) || '';
        if (s.indexOf('http://') === 0 || s.indexOf('https://') === 0 || s.indexOf('data:') === 0) return s;
        var mime = s.indexOf('/9j/') === 0 ? 'image/jpeg'
            : s.indexOf('iVBOR') === 0 ? 'image/png'
                : s.indexOf('R0lGOD') === 0 ? 'image/gif'
                    : s.indexOf('PHN2Zy') === 0 ? 'image/svg+xml'
                        : 'image/jpeg';
        return 'data:' + mime + ';base64,' + s;
    }

    function vyToImageSource(value) {
        if (value == null) return null;
        var s = String(value).trim();
        if (!s) return null;
        if (vyLooksLikeSvg(s)) return vySvgToDataUri(s);
        return s;
    }

    function vyCollectSvgs(source, keys) {
        var out = [];
        if (!source || typeof source !== 'object') return out;
        keys.forEach(function (key) {
            var value = source[key];
            if (!value) return;
            var list = Array.isArray(value) ? value : [value];
            list.forEach(function (item) {
                if (typeof item !== 'string') return;
                var uri = vyToImageSource(item);
                if (uri && out.indexOf(uri) === -1) out.push(uri);
            });
        });
        return out;
    }

    var Q_SVG_KEYS = ['question_svg', 'questionSvg', 'question_svgs', 'questionSvgs', 'svg', 'svgs', 'diagram_svg', 'diagramSvg'];
    var OPT_SVG_KEYS = ['option_svgs', 'optionSvgs', 'options_svg', 'optionsSvg'];
    var SOL_SVG_KEYS = ['solution_svg', 'solutionSvg', 'solution_svgs', 'solutionSvgs', 'svg', 'svgs'];

    function vyCellSvg(cell) {
        if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return null;
        return vyToImageSource(cell.svg || cell.cell_svg || cell.cellSvg || null);
    }

    function vyNormalizeTableSvgs(table) {
        if (!table || typeof table !== 'object') return table;
        var fix = function (cell) {
            var uri = vyCellSvg(cell);
            if (!uri) return cell;
            var next = { text: String(cell.text != null ? cell.text : (cell.caption || '')), image: uri };
            return next;
        };
        if (Array.isArray(table.headers)) table.headers = table.headers.map(fix);
        if (Array.isArray(table.rows)) {
            table.rows = table.rows.map(function (row) {
                return Array.isArray(row) ? row.map(fix) : row;
            });
        }
        return table;
    }

    /**
     * Fold every SVG the extractor produced into the existing image fields of a
     * single raw question object (mutates + returns it). Safe to run twice.
     */
    function vyNormalizeQuestionSvg(q) {
        if (!q || typeof q !== 'object') return q;

        /* ── question-level diagrams ── */
        var qSvgs = vyCollectSvgs(q, Q_SVG_KEYS);
        if (qSvgs.length) {
            var existing = Array.isArray(q.questionImages)
                ? q.questionImages.filter(Boolean)
                : (q.questionImage ? [q.questionImage] : []);
            qSvgs.forEach(function (uri) { if (existing.indexOf(uri) === -1) existing.push(uri); });
            q.questionImages = existing;
            if (!q.questionImage) q.questionImage = existing[0] || null;
            q.hasImage = true;
            q.has_image = true;
            q.hasSvg = true;
        }

        /* ── option diagrams (structural formulae, circuits, graphs) ── */
        var optSvgRaw = null;
        for (var i = 0; i < OPT_SVG_KEYS.length; i++) {
            if (Array.isArray(q[OPT_SVG_KEYS[i]])) { optSvgRaw = q[OPT_SVG_KEYS[i]]; break; }
        }
        if (!optSvgRaw) {
            var perOption = [q.option_a_svg, q.option_b_svg, q.option_c_svg, q.option_d_svg];
            if (perOption.some(Boolean)) optSvgRaw = perOption;
        }
        if (optSvgRaw) {
            var optImgs = Array.isArray(q.optionImages) ? q.optionImages.slice(0, 4) : [];
            while (optImgs.length < 4) optImgs.push(null);
            for (var oi = 0; oi < 4; oi++) {
                var uri = vyToImageSource(optSvgRaw[oi]);
                if (uri && !optImgs[oi]) optImgs[oi] = uri;
            }
            if (optImgs.some(Boolean)) {
                q.optionImages = optImgs;
                q.hasOptionImages = true;
                q.hasImage = true;
                q.has_image = true;
                q.hasSvg = true;
            }
        }

        /* ── solution diagrams ── */
        var solSvgs = vyCollectSvgs(q, ['solution_svg', 'solutionSvg', 'solution_svgs', 'solutionSvgs']);
        if (solSvgs.length) {
            if (!Array.isArray(q.solutions) || !q.solutions.length) {
                q.solutions = [{ text: String(q.solution || ''), image: null, images: [] }];
            }
            var sol = q.solutions[0];
            if (!Array.isArray(sol.images)) sol.images = sol.image ? [sol.image] : [];
            solSvgs.forEach(function (uri) { if (sol.images.indexOf(uri) === -1) sol.images.push(uri); });
            if (!sol.image) sol.image = sol.images[0] || null;
            q.hasSvg = true;
        }
        if (Array.isArray(q.solutions)) {
            q.solutions.forEach(function (s) {
                if (!s || typeof s !== 'object') return;
                var inline = vyCollectSvgs(s, SOL_SVG_KEYS);
                if (!inline.length) return;
                if (!Array.isArray(s.images)) s.images = s.image ? [s.image] : [];
                inline.forEach(function (uri) { if (s.images.indexOf(uri) === -1) s.images.push(uri); });
                if (!s.image) s.image = s.images[0] || null;
                q.hasSvg = true;
            });
        }

        /* ── SVG inside table cells (body tables + option tables) ── */
        if (Array.isArray(q.tables)) q.tables.forEach(vyNormalizeTableSvgs);
        else if (q.tables && typeof q.tables === 'object') vyNormalizeTableSvgs(q.tables);
        if (Array.isArray(q.optionTables)) q.optionTables.forEach(vyNormalizeTableSvgs);
        if (Array.isArray(q.option_tables)) q.option_tables.forEach(vyNormalizeTableSvgs);

        return q;
    }

    /** Count how many SVG diagrams a (normalized) question carries. */
    function vyCountSvgs(q) {
        var n = 0;
        if (!q || typeof q !== 'object') return 0;
        var bump = function (v) { if (vyIsSvgDataUri(v)) n++; };
        (Array.isArray(q.questionImages) ? q.questionImages : [q.questionImage]).forEach(bump);
        (Array.isArray(q.optionImages) ? q.optionImages : []).forEach(bump);
        (Array.isArray(q.solutions) ? q.solutions : []).forEach(function (s) {
            if (!s) return;
            bump(s.image);
            (Array.isArray(s.images) ? s.images : []).forEach(bump);
        });
        var scanTable = function (t) {
            if (!t) return;
            [].concat(Array.isArray(t.headers) ? t.headers : [], ...(Array.isArray(t.rows) ? t.rows : []))
                .forEach(function (c) { if (c && typeof c === 'object') bump(c.image); });
        };
        (Array.isArray(q.tables) ? q.tables : []).forEach(scanTable);
        (Array.isArray(q.optionTables) ? q.optionTables : []).forEach(scanTable);
        return n;
    }

    /* ═══════════════════════════════════════════════════════════════════
       SEPARATE FIGURE FILE
       Questions come in one JSON file, every SVG in a second "figures"
       file that tags each drawing with the question number and the slot
       it belongs to. This merges file 2 into file 1 before import.
    ═══════════════════════════════════════════════════════════════════ */

    var FIG_NUM_KEYS = ['question_number', 'questionNumber', 'question_no', 'questionNo',
        'q_no', 'qno', 'q', 'number', 'num', 'n', 'question'];
    var FIG_SVG_KEYS = ['svg', 'svg_code', 'svgCode', 'svg_markup', 'markup', 'code',
        'figure', 'drawing', 'image', 'content', 'data', 'value'];
    var FIG_SLOT_KEYS = ['target', 'slot', 'type', 'for', 'kind', 'place', 'field',
        'position', 'belongs_to', 'belongsTo', 'where'];

    function vyFigNum(entry) {
        for (var i = 0; i < FIG_NUM_KEYS.length; i++) {
            var v = entry[FIG_NUM_KEYS[i]];
            if (v === 0 || v) {
                var m = String(v).match(/-?\d+/);
                if (m) return parseInt(m[0], 10);
            }
        }
        return null;
    }

    function vyFigSvg(entry) {
        if (typeof entry === 'string') return (vyLooksLikeSvg(entry) || vyIsSvgDataUri(entry)) ? entry : null;
        for (var i = 0; i < FIG_SVG_KEYS.length; i++) {
            var v = entry[FIG_SVG_KEYS[i]];
            if (typeof v === 'string' && (vyLooksLikeSvg(v) || vyIsSvgDataUri(v))) return v;
        }
        return null;
    }

    function vyOptLetter(raw) {
        var s = String(raw == null ? '' : raw).toLowerCase();
        var m = s.match(/[abcd]/);
        if (m) return 'abcd'.indexOf(m[0]);
        var d = s.match(/[1-4]/);
        if (d) return parseInt(d[0], 10) - 1;
        return -1;
    }

    function vyInt(entry, keys, dflt) {
        for (var i = 0; i < keys.length; i++) {
            var v = entry[keys[i]];
            if (v === 0 || v) {
                var n = parseInt(String(v).match(/-?\d+/) ? String(v).match(/-?\d+/)[0] : NaN, 10);
                if (!isNaN(n)) return n;
            }
        }
        return dflt;
    }

    /** Work out which slot a figure entry is tagged for. */
    function vyFigSlot(entry) {
        var raw = '';
        for (var i = 0; i < FIG_SLOT_KEYS.length; i++) {
            if (typeof entry[FIG_SLOT_KEYS[i]] === 'string' && entry[FIG_SLOT_KEYS[i]]) {
                raw = entry[FIG_SLOT_KEYS[i]];
                break;
            }
        }
        var s = String(raw).toLowerCase().replace(/[\s\-]+/g, '_');
        var out = { slot: null, optionIndex: -1, assumed: false };

        out.tableIndex = vyInt(entry, ['table_index', 'tableIndex', 'table', 'table_no'], 0);
        out.row = vyInt(entry, ['row', 'row_index', 'rowIndex', 'r'], -1);
        out.col = vyInt(entry, ['col', 'column', 'col_index', 'colIndex', 'c'], -1);

        var optField = entry.option != null ? entry.option
            : (entry.option_letter != null ? entry.option_letter
                : (entry.option_index != null ? entry.option_index
                    : (entry.optionIndex != null ? entry.optionIndex : null)));

        if (/option_?table|opt_?table/.test(s)) {
            out.slot = 'option_table';
            out.optionIndex = vyOptLetter(optField != null ? optField : s);
        } else if (/^table|table$|matrix|column_?match/.test(s)) {
            out.slot = 'table';
        } else if (/option|choice|opt_/.test(s)) {
            out.slot = 'option';
            out.optionIndex = vyOptLetter(optField != null ? optField : s);
        } else if (/solution|answer|explanation|working|sol/.test(s)) {
            out.slot = 'solution';
        } else if (/question|stem|problem|body|main/.test(s)) {
            out.slot = 'question';
        }

        // No usable tag: infer from the other fields rather than dropping the figure.
        if (!out.slot) {
            if (optField != null && vyOptLetter(optField) >= 0) {
                out.slot = 'option';
                out.optionIndex = vyOptLetter(optField);
            } else if (out.row >= 0 && out.col >= 0) {
                out.slot = 'table';
            } else {
                out.slot = 'question';
                out.assumed = true;
            }
        }
        if (out.slot === 'option' && out.optionIndex < 0) out.optionIndex = 0;
        return out;
    }

    function vyEnsureCell(table, row, col) {
        if (!table || !Array.isArray(table.rows)) return null;
        if (row < 0 || col < 0) return null;
        if (!Array.isArray(table.rows[row])) return null;
        var cell = table.rows[row][col];
        if (cell == null) { cell = { text: '' }; table.rows[row][col] = cell; }
        else if (typeof cell !== 'object') { cell = { text: String(cell) }; table.rows[row][col] = cell; }
        return cell;
    }

    /** Write one figure onto a raw (pre-normalize) question object. */
    function vyApplyFigure(q, svg, tag) {
        if (tag.slot === 'question') {
            if (q.question_svg && q.question_svg !== svg) {
                if (!Array.isArray(q.question_svgs)) q.question_svgs = [q.question_svg];
                q.question_svgs.push(svg);
            } else {
                q.question_svg = svg;
            }
            return true;
        }
        if (tag.slot === 'solution') {
            if (q.solution_svg && q.solution_svg !== svg) {
                if (!Array.isArray(q.solution_svgs)) q.solution_svgs = [q.solution_svg];
                q.solution_svgs.push(svg);
            } else {
                q.solution_svg = svg;
            }
            return true;
        }
        if (tag.slot === 'option') {
            if (!Array.isArray(q.option_svgs)) q.option_svgs = [null, null, null, null];
            while (q.option_svgs.length < 4) q.option_svgs.push(null);
            q.option_svgs[tag.optionIndex] = svg;
            return true;
        }
        if (tag.slot === 'table') {
            var tables = Array.isArray(q.tables) ? q.tables : (q.tables ? [q.tables] : []);
            var t = tables[tag.tableIndex] || tables[0];
            var cell = vyEnsureCell(t, tag.row, tag.col);
            if (!cell) return false;
            cell.svg = svg;
            return true;
        }
        if (tag.slot === 'option_table') {
            var ot = Array.isArray(q.optionTables) ? q.optionTables
                : (Array.isArray(q.option_tables) ? q.option_tables : null);
            if (!ot || tag.optionIndex < 0) return false;
            var cell2 = vyEnsureCell(ot[tag.optionIndex], tag.row, tag.col);
            if (!cell2) return false;
            cell2.svg = svg;
            return true;
        }
        return false;
    }

    /** Accepts an array, { figures: [...] }, or an object keyed by question number. */
    function vyParseFigureFile(doc) {
        var entries = [];
        if (!doc) return entries;
        var list = null;
        if (Array.isArray(doc)) list = doc;
        else if (typeof doc === 'object') {
            var wrappers = ['figures', 'svgs', 'images', 'diagrams', 'data', 'items', 'results'];
            for (var w = 0; w < wrappers.length; w++) {
                if (Array.isArray(doc[wrappers[w]])) { list = doc[wrappers[w]]; break; }
            }
        }
        if (list) {
            list.forEach(function (e) {
                if (!e || typeof e !== 'object') return;
                // One entry may itself carry several slots at once.
                var direct = vyFigSvg(e);
                var fanned = false;
                var pairs = [
                    ['question_svg', 'question'], ['questionSvg', 'question'],
                    ['solution_svg', 'solution'], ['solutionSvg', 'solution']
                ];
                pairs.forEach(function (p) {
                    var v = e[p[0]];
                    if (typeof v === 'string' && (vyLooksLikeSvg(v) || vyIsSvgDataUri(v))) {
                        entries.push({ number: vyFigNum(e), svg: v, tag: { slot: p[1], optionIndex: -1 } });
                        fanned = true;
                    }
                });
                var optArr = Array.isArray(e.option_svgs) ? e.option_svgs
                    : (Array.isArray(e.optionSvgs) ? e.optionSvgs : null);
                if (optArr) {
                    optArr.forEach(function (v, i) {
                        if (typeof v === 'string' && (vyLooksLikeSvg(v) || vyIsSvgDataUri(v))) {
                            entries.push({ number: vyFigNum(e), svg: v, tag: { slot: 'option', optionIndex: i } });
                            fanned = true;
                        }
                    });
                }
                if (direct) entries.push({ number: vyFigNum(e), svg: direct, tag: vyFigSlot(e) });
                else if (!fanned) entries.push({ number: vyFigNum(e), svg: null, tag: vyFigSlot(e), empty: true });
            });
            return entries;
        }
        // Object keyed by question number: { "102": { solution_svg: "..." }, ... }
        Object.keys(doc).forEach(function (k) {
            var m = String(k).match(/-?\d+/);
            var num = m ? parseInt(m[0], 10) : null;
            var val = doc[k];
            if (typeof val === 'string') {
                if (vyLooksLikeSvg(val) || vyIsSvgDataUri(val)) {
                    entries.push({ number: num, svg: val, tag: { slot: 'question', optionIndex: -1, assumed: true } });
                }
                return;
            }
            if (Array.isArray(val)) {
                val.forEach(function (e) {
                    if (!e) return;
                    var svg = vyFigSvg(e);
                    if (svg) entries.push({ number: num, svg: svg, tag: vyFigSlot(typeof e === 'object' ? e : {}) });
                });
                return;
            }
            if (val && typeof val === 'object') {
                Object.keys(val).forEach(function (slotKey) {
                    var v = val[slotKey];
                    if (Array.isArray(v)) {
                        v.forEach(function (sv, i) {
                            if (typeof sv === 'string' && (vyLooksLikeSvg(sv) || vyIsSvgDataUri(sv))) {
                                var t = vyFigSlot({ target: slotKey });
                                if (t.slot === 'option') t.optionIndex = i;
                                entries.push({ number: num, svg: sv, tag: t });
                            }
                        });
                    } else if (typeof v === 'string' && (vyLooksLikeSvg(v) || vyIsSvgDataUri(v))) {
                        entries.push({ number: num, svg: v, tag: vyFigSlot({ target: slotKey }) });
                    }
                });
            }
        });
        return entries;
    }

    /**
     * Merge a figures file into a questions array.
     * Mutates + returns the questions, plus a report of what matched.
     */
    function vyMergeFigureFile(questions, doc) {
        var report = {
            total: 0, applied: 0, assumed: 0,
            counts: { question: 0, option: 0, solution: 0, table: 0, option_table: 0 },
            unmatched: [], empty: 0, matchedBy: 'question_number', expectedMissing: []
        };
        if (!Array.isArray(questions) || !questions.length) return { questions: questions, report: report };

        var entries = vyParseFigureFile(doc);
        report.total = entries.length;

        // Index questions by their printed number; fall back to position.
        var byNum = {}, dupes = {};
        questions.forEach(function (q, i) {
            var n = q ? vyFigNum(q) : null;
            if (n == null) return;
            if (byNum[n] === undefined) byNum[n] = i;
            else dupes[n] = true;
        });
        var haveNumbers = Object.keys(byNum).length > 0;
        if (!haveNumbers) report.matchedBy = 'file order';

        entries.forEach(function (e, i) {
            if (e.empty || !e.svg) { report.empty++; return; }
            var qi = -1;
            if (haveNumbers && e.number != null && byNum[e.number] !== undefined) qi = byNum[e.number];
            else if (!haveNumbers && e.number != null && e.number >= 1 && e.number <= questions.length) qi = e.number - 1;
            if (qi < 0) {
                report.unmatched.push({
                    number: e.number, slot: e.tag.slot,
                    reason: e.number == null ? 'figure has no question number' : 'no question numbered ' + e.number
                });
                return;
            }
            var ok = vyApplyFigure(questions[qi], e.svg, e.tag);
            if (!ok) {
                report.unmatched.push({
                    number: e.number, slot: e.tag.slot,
                    reason: 'target cell does not exist on that question'
                });
                return;
            }
            report.applied++;
            if (e.tag.assumed) report.assumed++;
            report.counts[e.tag.slot] = (report.counts[e.tag.slot] || 0) + 1;
        });

        // Questions that said they need a figure but received none.
        questions.forEach(function (q) {
            if (!q || typeof q !== 'object') return;
            var wants = q.image_needed === true || q.imageNeeded === true || q.has_image === true || q.hasImage === true;
            var got = !!(q.question_svg || q.solution_svg ||
                (Array.isArray(q.question_svgs) && q.question_svgs.length) ||
                (Array.isArray(q.solution_svgs) && q.solution_svgs.length) ||
                (Array.isArray(q.option_svgs) && q.option_svgs.some(Boolean)));
            if (wants && !got) report.expectedMissing.push(vyFigNum(q));
        });

        questions.forEach(function (q) { try { vyNormalizeQuestionSvg(q); } catch (err) { } });
        return { questions: questions, report: report };
    }

    /** Human-readable one-liner set for the developer panel. */
    function vyFigureReportText(report) {
        if (!report) return '';
        var c = report.counts || {};
        var lines = [];
        lines.push(report.applied + ' of ' + report.total + ' figures placed (matched by ' + report.matchedBy + ')');
        lines.push('question ' + (c.question || 0) + ' · options ' + (c.option || 0) +
            ' · solution ' + (c.solution || 0) + ' · table ' + ((c.table || 0) + (c.option_table || 0)));
        if (report.assumed) lines.push('⚠ ' + report.assumed + ' had no slot tag — placed on the question');
        if (report.empty) lines.push('⚠ ' + report.empty + ' entries carried no SVG markup');
        if (report.unmatched.length) {
            lines.push('⚠ ' + report.unmatched.length + ' could not be placed:');
            report.unmatched.slice(0, 8).forEach(function (u) {
                lines.push('   Q' + (u.number == null ? '?' : u.number) + ' ' + u.slot + ' — ' + u.reason);
            });
            if (report.unmatched.length > 8) lines.push('   …and ' + (report.unmatched.length - 8) + ' more');
        }
        if (report.expectedMissing.length) {
            lines.push('⚠ needs a figure but none arrived: Q' + report.expectedMissing.slice(0, 12).join(', Q'));
        }
        return lines.join('\n');
    }

    window.vyLooksLikeSvg = vyLooksLikeSvg;
    window.vyIsSvgDataUri = vyIsSvgDataUri;
    window.vySanitizeSvg = vySanitizeSvg;
    window.vySvgToDataUri = vySvgToDataUri;
    window.vyImgSrc = vyImgSrc;
    window.vyToImageSource = vyToImageSource;
    window.vyNormalizeQuestionSvg = vyNormalizeQuestionSvg;
    window.vyCountSvgs = vyCountSvgs;
    window.vyParseFigureFile = vyParseFigureFile;
    window.vyMergeFigureFile = vyMergeFigureFile;
    window.vyFigureReportText = vyFigureReportText;
})();
