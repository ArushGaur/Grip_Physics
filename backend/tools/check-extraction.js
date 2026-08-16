#!/usr/bin/env node
/**
 * check-extraction.js — audit an AI-extracted question JSON file BEFORE importing it.
 *
 * Usage:
 *   node backend/tools/check-extraction.js path/to/extracted.txt
 *   node backend/tools/check-extraction.js path/to/extracted.txt --verbose
 *
 * Two-pass extraction (questions in one file, every SVG in a tagged second
 * file) — audit the pair exactly as the developer panel will merge them:
 *   node backend/tools/check-extraction.js questions.json --figures figures.json
 *
 * Tells you, per field, how many diagrams the AI actually drew, which questions
 * claim a figure but supplied none, and which SVGs the importer sanitizer would
 * reject (and why). Exit code 1 if there are questions with a missing figure.
 */

const fs = require("fs");
const path = require("path");
const { sanitizeSvg, svgToDataUri, looksLikeSvgMarkup, MAX_SVG_CHARS } = require("../utils/svg");

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--figures");
const file = positional[0];
const VERBOSE = args.includes("--verbose");
// --figures <file>: the pass-2 file holding the tagged SVGs.
const figIdx = args.indexOf("--figures");
const figFile = figIdx !== -1 ? args[figIdx + 1] : null;
if (figIdx !== -1 && (!figFile || figFile.startsWith("--"))) {
	console.error("--figures needs a file path, e.g. --figures figures.json");
	process.exit(2);
}

if (!file) {
	console.error("usage: node backend/tools/check-extraction.js <extracted.json|.txt> [--verbose]");
	process.exit(2);
}

let raw = fs.readFileSync(path.resolve(file), "utf8").trim();

// Tolerate markdown fences and a {"questions":[...]} wrapper, since AIs add both.
raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

let data;
try {
	data = JSON.parse(raw);
} catch (e) {
	console.error("\n❌ JSON DID NOT PARSE — the importer would reject this file outright.");
	console.error("   " + e.message);
	const m = /position (\d+)/.exec(e.message);
	if (m) {
		const pos = Number(m[1]);
		console.error("   context: …" + raw.slice(Math.max(0, pos - 120), pos + 120).replace(/\n/g, "\\n") + "…");
	}
	process.exit(2);
}
if (!Array.isArray(data)) {
	if (Array.isArray(data?.questions)) {
		console.log("⚠️  file is wrapped as {\"questions\":[…]} — prompt asks for a top-level array");
		data = data.questions;
	} else {
		console.error("❌ top-level value is not an array");
		process.exit(2);
	}
}

// ───── two-pass extraction: merge the tagged figures file before auditing ─────
// This runs the SAME merge the developer panel runs, so what you see here is
// what the import would produce.
const figureGaps = [];
let figReport = null;

if (figFile) {
	const svgJs = path.resolve(__dirname, "../../frontend/shared/shared-svg.js");
	let win = null;
	try {
		global.window = {};
		global.document = { createElement: () => ({}) };
		new Function(fs.readFileSync(svgJs, "utf8"))();
		win = global.window;
	} catch (e) {
		console.error("❌ could not load frontend/shared/shared-svg.js: " + e.message);
		process.exit(2);
	}
	if (typeof win.vyMergeFigureFile !== "function") {
		console.error("❌ shared-svg.js did not expose vyMergeFigureFile — is the frontend up to date?");
		process.exit(2);
	}

	let figRaw;
	try {
		figRaw = fs.readFileSync(path.resolve(figFile), "utf8").trim()
			.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	} catch (e) {
		console.error("❌ could not read the figures file: " + e.message);
		process.exit(2);
	}
	let figDoc;
	try {
		figDoc = JSON.parse(figRaw);
	} catch (e) {
		console.error("\n❌ THE FIGURES FILE DID NOT PARSE — the panel would reject it outright.");
		console.error("   " + e.message);
		const fm = /position (\d+)/.exec(e.message);
		if (fm) {
			const p = Number(fm[1]);
			console.error("   context: …" + figRaw.slice(Math.max(0, p - 120), p + 120).replace(/\n/g, "\\n") + "…");
		}
		process.exit(2);
	}

	const mergedOut = win.vyMergeFigureFile(data, figDoc);
	data = mergedOut.questions;
	figReport = mergedOut.report;

	console.log("\n── figures file ──");
	console.log(win.vyFigureReportText(figReport).split("\n").map((l) => "  " + l).join("\n"));

	// Cross-check pass 1's figures_needed against what pass 2 actually delivered.
	const slotPresent = (q, slot) => {
		if (slot === "question") return !!(q.question_svg || (Array.isArray(q.question_svgs) && q.question_svgs.length));
		if (slot === "solution") return !!(q.solution_svg || (Array.isArray(q.solution_svgs) && q.solution_svgs.length));
		const om = /^option_([abcd])$/.exec(slot);
		if (om) {
			const i = "abcd".indexOf(om[1]);
			return !!(Array.isArray(q.option_svgs) && q.option_svgs[i]);
		}
		const tm = /^table:(\d+):(\d+)$/.exec(slot);
		if (tm) {
			const t = (Array.isArray(q.tables) ? q.tables : [])[0];
			const cell = t && t.rows && t.rows[Number(tm[1])] && t.rows[Number(tm[1])][Number(tm[2])];
			return !!cellFigure(cell);
		}
		const otm = /^option_table:([abcd]):(\d+):(\d+)$/.exec(slot);
		if (otm) {
			const ot = (Array.isArray(q.optionTables) ? q.optionTables : [])["abcd".indexOf(otm[1])];
			const cell = ot && ot.rows && ot.rows[Number(otm[2])] && ot.rows[Number(otm[2])][Number(otm[3])];
			return !!cellFigure(cell);
		}
		return false;
	};
	for (const q of data) {
		const needed = Array.isArray(q?.figures_needed) ? q.figures_needed
			: (Array.isArray(q?.figuresNeeded) ? q.figuresNeeded : []);
		const gaps = needed.filter((s) => typeof s === "string" && s && !slotPresent(q, s));
		if (gaps.length) figureGaps.push({ num: q.question_number ?? "?", gaps });
	}
}

const SVG_KEYS = {
	question: ["question_svg", "questionSvg", "question_svgs", "questionSvgs", "svg", "svgs"],
	option: ["option_svgs", "optionSvgs", "options_svg", "optionsSvg"],
	solution: ["solution_svg", "solutionSvg", "solution_svgs", "solutionSvgs"],
};

function flatten(v) {
	if (v == null) return [];
	if (Array.isArray(v)) return v.flatMap(flatten);
	return typeof v === "string" && v.trim() ? [v] : [];
}
function pick(q, keys) {
	return keys.flatMap((k) => flatten(q?.[k]));
}
// Turn an SVG data URI back into markup so the checks below still apply after
// a --figures merge. Raw markup is returned unchanged.
function decodeSvgSource(value) {
	const s = String(value || "");
	if (!/^data:image\/svg\+xml/i.test(s)) return s;
	const comma = s.indexOf(",");
	if (comma === -1) return s;
	const meta = s.slice(0, comma);
	const body = s.slice(comma + 1);
	try {
		return /;base64/i.test(meta)
			? Buffer.from(body, "base64").toString("utf8")
			: decodeURIComponent(body);
	} catch (e) {
		return s;
	}
}

// A table cell holds raw SVG before the merge, and a data URI after it —
// vyNormalizeTableSvgs rewrites the cell to { text, image }. Both count.
function cellFigure(cell) {
	if (!cell || typeof cell !== "object") return null;
	if (typeof cell.svg === "string" && cell.svg.trim()) return cell.svg;
	if (typeof cell.image === "string" && /^data:image\/svg\+xml/i.test(cell.image)) return cell.image;
	return null;
}

function cellSvgs(q) {
	const out = [];
	const scanTable = (t) => {
		for (const row of (t?.rows || [])) {
			for (const cell of (row || [])) {
				if (cell && typeof cell === "object") {
					const fig = cellFigure(cell);
					if (fig) out.push(fig);
					else if (cell.imageNeeded === true || cell.image_needed === true) out.push("__NEEDED__");
				}
			}
		}
	};
	for (const t of (Array.isArray(q?.tables) ? q.tables : [])) scanTable(t);
	for (const t of (Array.isArray(q?.optionTables) ? q.optionTables : [])) if (t) scanTable(t);
	return out;
}

const stats = {
	total: data.length,
	claimsImage: 0,
	qSvg: 0, optSvg: 0, solSvg: 0, cellSvg: 0,
	manualPlaceholders: 0,
	anySvg: 0,
	rejected: 0,
	bytes: [],
};
const missing = [];
const rejects = [];
const zwspIssues = [];
const backtickMath = [];   // $`x`$ instead of $x$
const badNamespace = [];   // xmlns mangled into a markdown link
const selfDoubt = [];      // "recompute: actual answer is…" left in the solution
const figureWords = [];     // solution mentions a figure but supplied none

data.forEach((q, i) => {
	const num = q?.question_number ?? q?.questionNumber ?? (i + 1);
	const qs = pick(q, SVG_KEYS.question);
	const os = pick(q, SVG_KEYS.option);
	const ss = pick(q, SVG_KEYS.solution);
	const cs = cellSvgs(q);
	const cellDrawn = cs.filter((x) => x !== "__NEEDED__");
	const needed = cs.filter((x) => x === "__NEEDED__");

	if (qs.length) stats.qSvg++;
	if (os.length) stats.optSvg++;
	if (ss.length) stats.solSvg++;
	if (cellDrawn.length) stats.cellSvg++;
	stats.manualPlaceholders += needed.length;

	const all = [...qs, ...os, ...ss, ...cellDrawn];
	if (all.length) stats.anySvg++;

	for (const rawFigure of all) {
		const svg = decodeSvgSource(rawFigure);
		stats.bytes.push(svg.length);
		const reasons = [];
		if (!looksLikeSvgMarkup(svg)) reasons.push("not recognizable <svg> markup");
		if (svg.length > MAX_SVG_CHARS) reasons.push(`too large (${svg.length} > ${MAX_SVG_CHARS})`);
		if (/<script|<foreignObject|<iframe|\son[a-z]+\s*=|xlink:href\s*=\s*["']https?:/i.test(svg)) reasons.push("contains a banned element/attribute (will be stripped)");
		if (!/viewBox\s*=/i.test(svg)) reasons.push("no viewBox (will be synthesised, may scale oddly)");
		if (!/xmlns\s*=/i.test(svg)) reasons.push("no xmlns (will be injected)");
		const clean = sanitizeSvg(svg);
		if (!clean || !svgToDataUri(svg)) {
			stats.rejected++;
			reasons.push("SANITIZER REJECTED — this figure will not render");
		}
		if (reasons.length) rejects.push({ num, reasons, preview: svg.slice(0, 90) });
	}

	// $`x`$ is the delimiter some models emit; the backtick renders literally.
	const textFields = [q?.question_text, q?.question, q?.solution,
		q?.option_a, q?.option_b, q?.option_c, q?.option_d]
		.filter((x) => typeof x === "string");
	if (textFields.some((t) => /\$`[^`]*`\$/.test(t))) backtickMath.push(num);

	// A namespace turned into "[http://…](http://…)" stops the SVG rendering.
	if (all.some((svg) => /xmlns\s*=\s*["'][^"']*[\[\]()][^"']*["']/.test(svg))) badNamespace.push(num);

	// Solutions that argue with themselves are not publishable.
	if (typeof q?.solution === "string" &&
		/recompute|actual answer is|wait,|let me redo|correction:/i.test(q.solution)) selfDoubt.push(num);

	// Solution text referring to a diagram that never arrived.
	if (typeof q?.solution === "string" &&
		/\b(as shown in the figure|from the figure|in the diagram|see figure)\b/i.test(q.solution) &&
		!all.length) figureWords.push(num);

	const claims = q?.has_image === true || q?.hasImage === true;
	if (claims) stats.claimsImage++;
	if (claims && !all.length && !needed.length) {
		missing.push(num);
	}

	// figure-only options must carry the zero-width space placeholder
	["option_a", "option_b", "option_c", "option_d"].forEach((k, oi) => {
		const hasOptDrawing = flatten(q?.option_svgs?.[oi] ?? q?.optionSvgs?.[oi]).length > 0;
		const t = q?.[k];
		if (hasOptDrawing && t !== "\u200b" && !String(t || "").trim()) {
			zwspIssues.push(`${num}${k.slice(-1).toUpperCase()}`);
		}
	});
});

const sum = stats.bytes.reduce((a, b) => a + b, 0);
const avg = stats.bytes.length ? Math.round(sum / stats.bytes.length) : 0;
const max = stats.bytes.length ? Math.max(...stats.bytes) : 0;

console.log(`\n══ ${path.basename(file)} ══`);
console.log(`questions parsed            : ${stats.total}`);
console.log(`questions claiming a figure : ${stats.claimsImage}   (has_image: true)`);
console.log(`questions WITH any drawing  : ${stats.anySvg}`);
console.log(``);
console.log(`  question_svg present      : ${stats.qSvg}`);
console.log(`  option_svgs  present      : ${stats.optSvg}`);
console.log(`  solution_svg present      : ${stats.solSvg}`);
console.log(`  table-cell svg present    : ${stats.cellSvg}`);
console.log(`  manual paste placeholders : ${stats.manualPlaceholders}   (imageNeeded — you'd upload these by hand)`);
console.log(``);
console.log(`svg payload: ${stats.bytes.length} figures, ${(sum / 1024).toFixed(1)} KB total, avg ${avg} B, largest ${max} B`);
console.log(`sanitizer rejections        : ${stats.rejected}`);

if (missing.length) {
	console.log(`\n❌ ${missing.length} question(s) say has_image:true but supplied NO figure:`);
	console.log(`   q${missing.join(", q")}`);
	console.log(`   → re-run those question numbers; the model skipped the drawing work.`);
} else if (stats.claimsImage) {
	console.log(`\n✅ every question claiming a figure supplied one.`);
}

console.log(`\nfigures by slot: question ${stats.qSvg} · options ${stats.optSvg} · solution ${stats.solSvg} · table ${stats.cellSvg}`);

if (!stats.solSvg && stats.qSvg) {
	console.log(`\n⚠️  solution_svg is empty on EVERY question, though question_svg worked (${stats.qSvg} drawn).`);
	console.log(`   Fine for a clean question paper (no solution diagrams to redraw).`);
	console.log(`   A RED FLAG if you fed a solutions booklet — there the figures sit beside the`);
	console.log(`   worked solution, so they belong in solution_svg. Spot-check two pages of the PDF:`);
	console.log(`   if figures are printed next to the solutions, the model put them in the wrong`);
	console.log(`   field (or skipped them) and those questions need re-running.`);
}

if (figureGaps.length) {
	console.log(`\n❌ ${figureGaps.length} question(s) asked for a figure in pass 1 that pass 2 never delivered:`);
	for (const g of (VERBOSE ? figureGaps : figureGaps.slice(0, 12))) {
		console.log(`   q${g.num}: missing ${g.gaps.join(", ")}`);
	}
	if (!VERBOSE && figureGaps.length > 12) console.log(`   …and ${figureGaps.length - 12} more (run with --verbose)`);
	console.log(`   → re-run pass 2 for just these numbers; the questions file is fine.`);
}

if (backtickMath.length) {
	console.log(`\n❌ ${backtickMath.length} question(s) use $\`x\`$ instead of $x$ for math:`);
	console.log(`   q${backtickMath.join(", q")}`);
	console.log(`   → the importer now strips these automatically, but ask the model for plain $ … $.`);
}

if (badNamespace.length) {
	console.log(`\n⚠️  ${badNamespace.length} question(s) have an xmlns mangled into a markdown link: q${badNamespace.join(", q")}`);
	console.log(`   → repaired automatically on import; usually caused by copy-pasting through chat.`);
}

if (selfDoubt.length) {
	console.log(`\n❌ ${selfDoubt.length} solution(s) contain the model second-guessing itself: q${selfDoubt.join(", q")}`);
	console.log(`   → review these by hand before publishing — the derivation may be wrong.`);
}

if (figureWords.length) {
	console.log(`\n⚠️  ${figureWords.length} solution(s) mention a figure but supplied none: q${figureWords.join(", q")}`);
}

if (zwspIssues.length) {
	console.log(`\n⚠️  figure-only options missing the \\u200b placeholder: ${zwspIssues.join(", ")}`);
	console.log(`   these option slots may collapse in the UI.`);
}

if (rejects.length) {
	console.log(`\n⚠️  ${rejects.length} figure warning(s):`);
	const show = VERBOSE ? rejects : rejects.slice(0, 12);
	for (const r of show) {
		console.log(`   q${r.num}: ${r.reasons.join("; ")}`);
		if (VERBOSE) console.log(`      ${r.preview}…`);
	}
	if (!VERBOSE && rejects.length > show.length) {
		console.log(`   …and ${rejects.length - show.length} more (run with --verbose)`);
	}
}

console.log("");
process.exit((missing.length || backtickMath.length || selfDoubt.length || figureGaps.length) ? 1 : 0);
