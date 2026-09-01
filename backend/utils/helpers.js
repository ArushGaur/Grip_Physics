// SVG diagrams produced by the extraction AI are folded into the existing
// image fields as data URIs — see backend/utils/svg.js for the why.
const { svgToDataUri, toImageSource, collectSvgDataUris, looksLikeSvgMarkup, isSvgDataUri } = require("./svg");

const crypto = require("crypto");

function clamp(n, min, max) {
	return Math.max(min, Math.min(max, n));
}

function getMime(b64) {
	if (String(b64 || "").startsWith("/9j/")) return "image/jpeg";
	if (String(b64 || "").startsWith("iVBORw")) return "image/png";
	if (String(b64 || "").startsWith("R0lGOD")) return "image/gif";
	if (String(b64 || "").startsWith("PHN2Zy")) return "image/svg+xml";
	return "image/jpeg";
}

function toImgPart(b64) {
	return {
		type: "image_url",
		image_url: { url: `data:${getMime(b64)};base64,${b64}` },
	};
}

function cleanJson(txt) {
	return String(txt || "")
		.replace(/```json\s*/gi, "")
		.replace(/```/g, "")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/\u00A0/g, " ")
		.replace(/\r\n?/g, "\n")
		.trim();
}

function tryParse(txt) {
	try {
		return JSON.parse(txt);
	} catch {
		try {
			return JSON.parse(String(txt).replace(/,(\s*[}\]])/g, "$1"));
		} catch {
			return null;
		}
	}
}

function sanitizeLatexJson(raw) {
	if (!raw) return raw;
	let s = raw.replace(/```json|```/g, "").trim();
	let result = "";
	let inString = false;
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (!inString) {
			if (ch === '"') inString = true;
			result += ch;
			i++;
		} else {
			if (ch === '\\') {
				const next = s[i + 1] || "";
				if ('"\\\\/bfnrtu'.includes(next)) {
					result += ch + next;
					i += 2;
				} else {
					result += "\\\\";
					i++;
				}
			} else if (ch === '"') {
				inString = false;
				result += ch;
				i++;
			} else {
				result += ch;
				i++;
			}
		}
	}
	result = result.replace(/,(\s*[}\]])/g, "$1");
	return result;
}

function normalizeSolutionText(text) {
	if (!text) return "";
	let t = text.replace(/\\n/g, "\n").trim();
	t = t.replace(/^\s*\${1,3}\s*:?\s*$/gm, "");
	t = t.replace(/\n{3,}/g, "\n\n");
	return t.trim();
}

function repairSolutionLatex(text) {
	if (!text) return text;
	let t = text;
	// Only collapse 4+ consecutive backslashes down to 2 (\\).
	// 3 backslashes (\\\) = \\ (row separator) + \ (start of cmd like \omega)
	// — collapsing those drops the cmd's leading backslash.
	try {
		t = t.replace(/\\{4,}/g, "\\\\");
	} catch (e) { /* ignore */ }

	t = t.replace(/\\\(/g, "$").replace(/\\\)/g, "$");
	t = t.replace(/\\\[/g, "$$").replace(/\\\]/g, "$$");
	t = t.replace(/\\\\\s+(frac|sqrt|vec|hat|int|sum|pi|sin|cos|tan|log|ln|alpha|beta|theta|gamma|delta|epsilon|mu|omega|lambda|sigma)\b/g, "\\$1");
	t = t.replace(/\\\s+(frac|sqrt|vec|hat)\{/g, "\\$1{");

	t = t.replace(/(?<!\\)\bfrac\{/g, "\\frac{");
	t = t.replace(/(?<!\\)\brac\{/g, "\\frac{");
	t = t.replace(/(?<!\\)\bsqrt\{/g, "\\sqrt{");
	t = t.replace(/(?<!\\)\bsqrt\b/g, "\\sqrt");
	t = t.replace(/(?<!\\)\bvec\{/g, "\\vec{");
	t = t.replace(/(?<!\\)\bhat\{/g, "\\hat{");
	t = t.replace(/(?<!\\)\btimes\b/g, "\\times");
	t = t.replace(/(?<!\\)\bcdot\b/g, "\\cdot");
	t = t.replace(/(?<!\\)\bpm\b/g, "\\pm");
	t = t.replace(/(?<!\\)\btheta\b/g, "\\theta");
	t = t.replace(/(?<!\\)\balpha\b/g, "\\alpha");
	t = t.replace(/(?<!\\)\bbeta\b/g, "\\beta");
	t = t.replace(/(?<!\\)\bepsilon\b/g, "\\epsilon");
	t = t.replace(/(?<!\\)\bmu\b/g, "\\mu");
	t = t.replace(/(?<!\\)\bomega\b/g, "\\omega");
	t = t.replace(/(?<!\\)\bpi\b(?!['a-z])/g, "\\pi");
	t = t.replace(/(?<!\\)\blambda\b/g, "\\lambda");
	t = t.replace(/(?<!\\)\bsigma\b/g, "\\sigma");
	t = t.replace(/(?<!\\)\bgamma\b/g, "\\gamma");
	t = t.replace(/(?<!\\)\bdelta\b/g, "\\delta");
	t = t.replace(/(?<!\\)\binfty\b/g, "\\infty");
	t = t.replace(/(?<!\\)\btext\{/g, "\\text{");
	t = t.replace(/(?<!\\)\bsin\b/g, "\\sin");
	t = t.replace(/(?<!\\)\bcos\b/g, "\\cos");
	t = t.replace(/(?<!\\)\btan\b/g, "\\tan");
	t = t.replace(/(?<!\\)\blog\b/g, "\\log");
	t = t.replace(/(?<!\\)\bln\b/g, "\\ln");

	t = t.replace(/^\s*\d+\.?\s*(?:\([a-dA-D]\)\s*)?:?\s*/, '');
	t = t.replace(/(?<!\\)\btherefore\b/g, '\\therefore');
	t = t.replace(/(?<!\\)\bRightarrow\b/g, '\\Rightarrow');
	t = t.replace(/(?<!\\)\brightarrow\b/g, '\\rightarrow');
	t = t.replace(/(?<!\\)\bLeftarrow\b/g, '\\Leftarrow');
	t = t.replace(/(?<!\\)\bimplies\b/g, '\\implies');
	t = t.replace(/(?<!\\)\bneq\b/g, '\\neq');
	t = t.replace(/(?<!\\)\bleq\b/g, '\\leq');
	t = t.replace(/(?<!\\)\bgeq\b/g, '\\geq');
	t = t.replace(/(?<!\\)\bcdots\b/g, '\\cdots');

	t = t.replace(/\\(therefore|Rightarrow|rightarrow|implies|Leftarrow)([A-Z])/g, '\\$1 $2');
	t = t.split("\n").map(line => {
		const parts = line.split(/(\$\$[\s\S]*?\$\$|\$[^$]*?\$)/g);
		return parts.map((seg, i) => {
			if (i % 2 === 1) return seg;
			if (!seg.includes("\\")) return seg;
			const trimmed = seg.trim();
			if (/^[\s=:,()*]*\\[a-zA-Z]/.test(trimmed) || /\\(frac|sqrt|therefore|Rightarrow|rightarrow|sum|int)/.test(trimmed)) {
				return "$" + trimmed + "$";
			}
			return seg.replace(/\\[a-zA-Z]+(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|\[[^\]]*\]|[_^]\{[^{}]*\}|[_^][\w])?/g, m => "$" + m + "$");
		}).join("");
	}).join("\n");

	let _prev = "";
	while (_prev !== t) {
		_prev = t;
		t = t.replace(/\$([^$\n]+)\$([\s=+\-*/,.:()]*?)\$([^$\n]+)\$/g, (_, a, mid, b) => "$" + a + (mid || " ") + b + "$");
	}

	const dollarCount = (t.match(/(?<!\\)\$/g) || []).length;
	if (dollarCount % 2 === 1) t += "$";

	return t;
}

function parseManualAnswerKey(text) {
	const map = new Map();
	if (!text || !text.trim()) return map;
	const letterToIdx = { a: 0, b: 1, c: 2, d: 3 };
	for (const line of text.split(/[\n;\r]+/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const m = trimmed.match(/^(\d{1,3})\s*[-.):\s]\s*([A-Da-d](?:\s*,\s*[A-Da-d])*)\s*$/);
		if (!m) continue;
		const num = parseInt(m[1], 10);
		const letters = m[2].match(/[A-Da-d]/gi) || [];
		const idxs = [...new Set(letters.map(l => letterToIdx[l.toLowerCase()]).filter(n => n >= 0 && n < 4))];
		if (idxs.length && Number.isInteger(num)) map.set(num, idxs);
	}
	return map;
}

function applyManualAnswerKey(questions, akMap) {
	if (!akMap || !akMap.size) return;
	questions.forEach((q, i) => {
		const byPos = akMap.get(i + 1);
		const textMatch = String(q.question || "").match(/^\s*(?:q\.?\s*)?(\d{1,3})\s*[).\-:\s]/i);
		const byText = textMatch ? akMap.get(parseInt(textMatch[1], 10)) : undefined;
		const idxs = byPos ?? byText;
		if (idxs && idxs.length) {
			q.correctIndexes = idxs;
			q.isMultiCorrect = idxs.length > 1;
		}
	});
}

function parseJsonArray(raw) {
	const text = cleanJson(raw);
	const direct = tryParse(text);
	if (Array.isArray(direct)) return direct;
	if (direct && Array.isArray(direct.questions)) return direct.questions;

	const s = text.indexOf("[");
	const e = text.lastIndexOf("]");
	if (s !== -1 && e > s) {
		const sliced = tryParse(text.slice(s, e + 1));
		if (Array.isArray(sliced)) return sliced;
	}

	const objs = text.match(/\{[\s\S]*?\}/g) || [];
	const recovered = objs
		.map((x) => tryParse(x))
		.filter((x) => x && typeof x === "object" && !Array.isArray(x));
	return recovered.length ? recovered : null;
}

function looksLikeEquation(s) {
	const t = String(s || "").trim();
	if (!t) return false;
	if (/\$[^$]+\$/.test(t)) return true;
	if (/\\(frac|sqrt|sum|int|pi|theta|alpha|beta|gamma|sin|cos|tan|log|ln)\b/i.test(t)) return true;
	if (/(^|\s)[a-zA-Z][a-zA-Z0-9]*\s*(=|>=|<=|>|<|\+|\-|\*|\/|\^|≈|∝)\s*[-+]?\d|\b\d+\s*(m\/s|m\/s\^2|kg|N|J|W|Hz|ohm|V|A)\b/i.test(t)) return true;
	if (/\b(sin|cos|tan|log|ln)\s*\(/i.test(t)) return true;
	return false;
}

function normalizeMath(s, opts) {
	const preserveRaw = opts && opts.preserveRaw;
	let out = String(s || "").trim();
	if (!out) return out;

	// Some extraction models wrap math as $`x^2`$ (dollar + backtick) instead of
	// $x^2$. The backticks would render literally and KaTeX would not fire, so
	// strip them. Also handles the ``$…$`` and `$…$` variants.
	out = out.replace(/\$`([^`]*?)`\$/g, (_, m) => `$${m}$`);
	out = out.replace(/`+\s*(\$[^$]*?\$)\s*`+/g, (_, m) => m);

	out = out.replace(/\\\(([^]*?)\\\)/g, (_, m) => `$${m}$`);
	out = out.replace(/\\\[([^]*?)\\\]/g, (_, m) => `$$${m}$$`);
	const dollarCount = (out.match(/(?<!\\)\$/g) || []).length;
	if (dollarCount % 2 === 1) out += "$";
	if (!preserveRaw && looksLikeEquation(out) && !out.includes("$")) {
		out = `$${out}$`;
	}
	return out;
}

function isNoneCorrectQuestion(q) {
	if (!q || typeof q !== "object") return false;
	if (q.isNoneCorrect === true || q.none_correct === true) return true;
	const type = String(q.questionType || q.question_type || "").toUpperCase();
	if (type === "INTEGER") return false;
	const raw = (q.correct_answer ?? q.correctAnswer ?? q.answer ?? q.correct);
	const txt = (raw === null || raw === undefined) ? "" : String(raw).trim();
	const up = txt.toUpperCase();
	const noneTokens = ["NONE", "NONE OF THE ABOVE", "NONE OF THESE", "NOTA", "N/A", "NA", "-", "—", "NULL"];
	if (noneTokens.includes(up)) return true;
	return false;
}

function parseCorrectIndexesFromQuestion(q) {
	if (isNoneCorrectQuestion(q)) return [];
	let ci = Array.isArray(q.correctIndexes) ? [...q.correctIndexes] : [];
	if (!ci.length && typeof q.correctIndex === "number") ci = [q.correctIndex];
	if (!ci.length) {
		const hint = String(q.correctAnswer || q.answer || q.correct || "").trim();
		const letters = hint.match(/\b([A-Da-d])\b/g) || [];
		ci = [...new Set(letters.map((l) => "abcd".indexOf(l.toLowerCase())))].filter((n) => n >= 0);
	}
	ci = [...new Set(ci.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n < 4))];
	if (!ci.length && String(q.questionType || q.question_type || "").toUpperCase() !== "INTEGER") ci = [0];
	return ci;
}

function validateImageRegion(r) {
	if (!r || typeof r.x !== "number" || typeof r.y !== "number" || typeof r.w !== "number" || typeof r.h !== "number") {
		return null;
	}
	if (r.w < 0.01 || r.h < 0.01) return null;
	const x = clamp(r.x, 0, 0.99);
	const y = clamp(r.y, 0, 0.99);
	const w = clamp(r.w, 0.01, 1 - x);
	const h = clamp(r.h, 0.01, 1 - y);
	return { x, y, w, h };
}

function isImageCell(c) {
	return c && typeof c === "object" && !Array.isArray(c) &&
		("image" in c || "svg" in c || "cell_svg" in c || "cellSvg" in c ||
			c.imageNeeded === true || c.image_needed === true);
}

// A cell may be a plain string, an image cell { text, image }, an AI-drawn cell
// { text, svg } or a legacy manual-upload placeholder { text, imageNeeded }.
// An `svg` cell is converted to an svg data URI and stored in `image`, so the
// renderers/DOCX builder need no cell-level changes and no manual paste box is
// requested for it.
function normalizeCell(cell, mathOpts) {
	if (isImageCell(cell)) {
		const svg = svgToDataUri(cell.svg ?? cell.cell_svg ?? cell.cellSvg ?? null);
		const img = svg || (cell.image != null ? toImageSource(String(cell.image)) : null);
		const needed = (cell.imageNeeded === true || cell.image_needed === true) && !img;
		const obj = { text: normalizeMath(String(cell.text ?? cell.caption ?? ""), mathOpts), image: img };
		if (needed) obj.imageNeeded = true;
		return obj;
	}
	return normalizeMath(String(cell ?? ""), mathOpts);
}

function normalizeTables(tables, mathOpts) {
	if (!tables) return [];
	const arr = Array.isArray(tables) ? tables : [tables];
	const out = [];
	for (const t of arr) {
		if (!t || typeof t !== "object") continue;
		const headers = Array.isArray(t.headers)
			? t.headers.map((h) => normalizeCell(h, mathOpts))
			: [];
		const rawRows = Array.isArray(t.rows) ? t.rows : [];
		const rows = rawRows
			.filter((r) => Array.isArray(r))
			.map((r) => r.map((cell) => normalizeCell(cell, mathOpts)));
		if (!headers.length && !rows.length) continue;
		const table = {
			position: typeof t.position === "string" && t.position.trim() ? t.position.trim() : "after_intro",
			headers,
			rows,
		};
		if (t.caption && String(t.caption).trim()) table.caption = normalizeMath(String(t.caption).trim(), mathOpts);
		out.push(table);
	}
	return out;
}

function normalizeSingleTable(t, mathOpts) {
	if (!t || typeof t !== "object") return null;
	const headers = Array.isArray(t.headers) ? t.headers.map((h) => normalizeCell(h, mathOpts)) : [];
	const rows = Array.isArray(t.rows)
		? t.rows.filter((r) => Array.isArray(r)).map((r) => r.map((c) => normalizeCell(c, mathOpts)))
		: [];
	if (!headers.length && !rows.length) return null;
	const obj = { headers, rows };
	if (t.caption && String(t.caption).trim()) obj.caption = normalizeMath(String(t.caption).trim(), mathOpts);
	return obj;
}

function normalizeOptionTables(optionTables, mathOpts) {
	if (!Array.isArray(optionTables)) return null;
	const out = [null, null, null, null];
	let any = false;
	for (let i = 0; i < 4; i++) {
		const nt = normalizeSingleTable(optionTables[i], mathOpts);
		if (nt) { out[i] = nt; any = true; }
	}
	return any ? out : null;
}

function normalizeQuestion(q, opts) {
	const mathOpts = opts && opts.preserveRaw ? { preserveRaw: true } : undefined;
	const rawQuestion = String(q?.question || "");
	const normQuestion = normalizeMath(rawQuestion.replace(/^\s*(?:Q\.?\s*)?\d{1,3}\s*[\.\)\:\-–]\s*/i, ""), mathOpts);
	const normOptions = [...(Array.isArray(q?.options) ? q.options : []), "", "", ""].slice(0, 4).map((x) => normalizeMath(String(x || ""), mathOpts));
	const hasEquation = looksLikeEquation(normQuestion) || normOptions.some((o) => looksLikeEquation(o));
	const questionImages = Array.isArray(q?.questionImages)
		? q.questionImages
		: q?.questionImage
			? [q.questionImage]
			: Array.isArray(q?.questionImageUrls)
				? q.questionImageUrls
				: [];
	const optionImagesRaw = Array.isArray(q?.optionImages)
		? q.optionImages
		: Array.isArray(q?.optImgs)
			? q.optImgs
			: Array.isArray(q?.optionsImages)
				? q.optionsImages
				: q?.optionImage ? [q.optionImage] : [];

	// ── AI-drawn SVG diagrams ────────────────────────────────────────────
	// The extractor now returns vector markup instead of leaving a hole for a
	// manual screenshot upload. SVGs are sanitized + converted to data URIs and
	// merged into the SAME image fields, so storage/render/DOCX stay unchanged.
	const questionSvgs = collectSvgDataUris(q, [
		"question_svg", "questionSvg", "question_svgs", "questionSvgs",
		"svg", "svgs", "diagram_svg", "diagramSvg",
	]);
	const optionSvgSource = ["option_svgs", "optionSvgs", "options_svg", "optionsSvg"]
		.map((k) => q?.[k])
		.find((v) => Array.isArray(v))
		|| [q?.option_a_svg, q?.option_b_svg, q?.option_c_svg, q?.option_d_svg];

	const imagesWithSvg = [...questionImages.map(toImageSource).filter(Boolean)];
	for (const uri of questionSvgs) if (!imagesWithSvg.includes(uri)) imagesWithSvg.push(uri);

	const optionImages = [...optionImagesRaw, null, null, null, null].slice(0, 4)
		.map((img, i) => toImageSource(img) || svgToDataUri(optionSvgSource?.[i]) || null);
	const hasSvg = questionSvgs.length > 0
		|| optionImages.some((x) => isSvgDataUri(x))
		|| imagesWithSvg.some((x) => isSvgDataUri(x));

	const out = {
		question: normQuestion,
		options: normOptions,
		questionImages: imagesWithSvg.filter(Boolean),
		questionImage: toImageSource(q?.questionImage) || imagesWithSvg[0] || null,
		optionImages: [...optionImages, null, null, null].slice(0, 4),
		hasImage: !!(q?.hasImage || imagesWithSvg.length),
		hasOptionImages: !!(q?.hasOptionImages || optionImages.some(Boolean)),
		hasEquation,
		imageRegion: validateImageRegion(q?.imageRegion),
	};

	if (hasSvg) out.hasSvg = true;

	// Solution-level diagrams ("solution_svg") land in solutions[0].images so the
	// existing solution renderer picks them up untouched.
	const solutionSvgs = collectSvgDataUris(q, ["solution_svg", "solutionSvg", "solution_svgs", "solutionSvgs"]);
	if (solutionSvgs.length) {
		const sols = Array.isArray(q?.solutions) && q.solutions.length
			? q.solutions.map((s) => ({ ...s }))
			: [{ text: String(q?.solution || ""), image: null, images: [] }];
		const first = sols[0];
		first.images = Array.isArray(first.images) ? [...first.images] : (first.image ? [first.image] : []);
		for (const uri of solutionSvgs) if (!first.images.includes(uri)) first.images.push(uri);
		if (!first.image) first.image = first.images[0] || null;
		q = { ...q, solutions: sols };
		out.hasSvg = true;
	}

	const noneCorrect = isNoneCorrectQuestion(q || {});
	const ci = parseCorrectIndexesFromQuestion(q || {});
	out.correctIndexes = ci;
	out.isMultiCorrect = noneCorrect ? false : ci.length > 1;
	if (noneCorrect) out.isNoneCorrect = true;

	if (Number.isInteger(q?.questionNumber) && q.questionNumber > 0) {
		out.questionNumber = q.questionNumber;
	}
	if (Number.isInteger(q?.imageSourceIndex)) {
		out.imageSourceIndex = q.imageSourceIndex;
	}
	if (Array.isArray(q?.solutions) && q.solutions.length > 0) {
		out.solutions = q.solutions;
	}
	if (q?.numericalAnswer !== undefined && q?.numericalAnswer !== null) {
		out.numericalAnswer = q.numericalAnswer;
	}
	if (q?.subject) out.subject = q.subject;
	if (q?.unit) out.unit = q.unit;
	if (q?.year !== undefined && q?.year !== null && String(q.year).trim()) {
		out.year = String(q.year).trim();
	}
	if (q?.month !== undefined && q?.month !== null && String(q.month).trim()) {
		out.month = String(q.month).trim();
	}
	if (q?.day !== undefined && q?.day !== null && String(q.day).trim()) {
		out.day = String(q.day).trim();
	}
	if (q?.date !== undefined && q?.date !== null && String(q.date).trim()) {
		out.date = String(q.date).trim();
	}
	if (q?.shift !== undefined && q?.shift !== null && String(q.shift).trim()) {
		out.shift = String(q.shift).trim();
	}
	if (q?.exam !== undefined && q?.exam !== null && String(q.exam).trim()) {
		out.exam = String(q.exam).trim();
	}
	if (q?.examName !== undefined && q?.examName !== null && String(q.examName).trim()) {
		out.examName = String(q.examName).trim();
	}
	if (q?.exam_name !== undefined && q?.exam_name !== null && String(q.exam_name).trim()) {
		out.exam_name = String(q.exam_name).trim();
	}

	const normTables = normalizeTables(q?.tables, mathOpts);
	if (normTables.length) out.tables = normTables;

	const normOptionTables = normalizeOptionTables(q?.optionTables, mathOpts);
	if (normOptionTables) {
		out.optionTables = normOptionTables;
		out.hasOptionTables = true;
	}

	return out;
}

function normalizeQuestionRow(row) {
	if (!row) return null;
	let parsed = [];
	try {
		parsed = JSON.parse(row.questions_json || "[]");
	} catch {
		parsed = [];
	}
	return {
		_id: row.id,
		chapter: row.chapter || null,
		lecture: row.lecture,
		topic: row.topic || "",
		updatedAt: row.updated_at || 0,
		accessCode: row.access_code || null,
		questions: Array.isArray(parsed) ? parsed.map((q) => normalizeQuestion(q, { preserveRaw: true })) : [],
	};
}

function normalizeStudentRow(row) {
	let answers = [];
	try {
		answers = JSON.parse(row.answers_json || "[]");
	} catch {
		answers = [];
	}
	return {
		_id: row.id,
		mobile: row.mobile,
		lecture: row.lecture,
		name: row.name,
		place: row.place,
		className: row.class_name,
		chapter: row.chapter || null,
		answers,
		correctCount: row.correct_count || 0,
		totalQuestions: row.total_questions || 0,
		time: row.time || 0,
		cheatFlag: row.cheat_flag ? true : false,
	};
}

function isCorrect(qItem, ans) {
	if (!qItem) return false;
	if (qItem.isNoneCorrect === true) return true;
	const cor = Array.isArray(qItem.correctIndexes) && qItem.correctIndexes.length ? qItem.correctIndexes : [0];
	if (qItem.isMultiCorrect || cor.length > 1) {
		const selected = Array.isArray(ans) ? [...ans].sort((a, b) => a - b) : [ans];
		const expected = [...cor].sort((a, b) => a - b);
		return JSON.stringify(selected) === JSON.stringify(expected);
	}
	return ans === cor[0];
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRetrySeconds(msg) {
	const m = String(msg || "").match(/try again in\s*([0-9.]+)s/i);
	if (!m) return null;
	const n = parseFloat(m[1]);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function safeCompare(a, b) {
	try {
		const ba = Buffer.from(String(a));
		const bb = Buffer.from(String(b));
		if (ba.length !== bb.length) {
			crypto.timingSafeEqual(ba, ba);
			return false;
		}
		return crypto.timingSafeEqual(ba, bb);
	} catch {
		return false;
	}
}

function hashPasscode(passcode) {
	const salt = crypto.randomBytes(16);
	const derived = crypto.scryptSync(String(passcode || ""), salt, 64);
	return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function verifyPasscode(passcode, stored) {
	try {
		if (!stored) return false;
		const parts = String(stored).split("$");
		if (parts.length !== 3 || parts[0] !== "scrypt") {
			return safeCompare(passcode, stored);
		}
		const salt = Buffer.from(parts[1], "hex");
		const expected = Buffer.from(parts[2], "hex");
		const derived = crypto.scryptSync(String(passcode || ""), salt, 64);
		if (derived.length !== expected.length) return false;
		return crypto.timingSafeEqual(derived, expected);
	} catch {
		return false;
	}
}

function validatePasswordComplexity(password) {
	if (!password || password.length < 6) return false;
	const hasLetter = /[a-zA-Z]/.test(password);
	const hasDigit = /\d/.test(password);
	const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);
	return hasLetter && hasDigit && hasSpecial;
}

/* ══════════════════════════════════════════════════════════════════════════
   PER-STUDENT QUESTION SHUFFLE (anti-cheating)

   Every student assigned to an online test gets the SAME questions but in a
   DIFFERENT order, so two students sitting next to each other never see the
   same question at the same position.

   The order is derived deterministically from (testId + rollNumber), so:
     • the same student always gets the same order (safe resume after unlock)
     • no extra DB write is needed to *generate* it
   The order actually used is still stored on the attempt row
   (test_history.question_order_json) so analysis keeps working even if the
   teacher later edits the test's question list, and so attempts saved before
   this feature existed keep their original (unshuffled) order.
══════════════════════════════════════════════════════════════════════════ */

// Small, fast, deterministic 32-bit string hash (FNV-1a).
function _seedFromString(str) {
	let h = 2166136261 >>> 0;
	const s = String(str == null ? "" : str);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h >>> 0;
}

// mulberry32 PRNG — tiny, seedable, good enough for shuffling a question paper.
function _mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Build the question order for one student.
 *
 * @param {string|number} testId  online_tests.id
 * @param {string}        roll    the student's roll number
 * @param {number}        count   how many questions the test has
 * @returns {number[]} array of ORIGINAL indexes, in the order this student
 *                     should see them. e.g. [3, 0, 2, 1] means the student's
 *                     Q1 is the test's original question #4.
 */
function questionOrderForStudent(testId, roll, count, subjects) {
	const n = Math.max(0, Math.floor(Number(count) || 0));
	const order = Array.from({ length: n }, (_, i) => i);
	if (n < 2) return order;
	const rand = _mulberry32(_seedFromString(`${testId}::${roll}`));
	// Fisher-Yates, driven by the seeded PRNG.
	const shuffle = (arr) => {
		for (let i = arr.length - 1; i > 0; i--) {
			const j = Math.floor(rand() * (i + 1));
			[arr[i], arr[j]] = [arr[j], arr[i]];
		}
		return arr;
	};

	/* Keep each subject in one contiguous block.
	   Shuffling all indexes together interleaved the subjects, so a student
	   jumped Chemistry -> Biology -> Chemistry question by question. Only the
	   order WITHIN a subject and the order OF the subject blocks vary per
	   student, which preserves the anti-cheating property. Falls back to the
	   flat shuffle when subjects are unknown or there is only one. */
	const labels = Array.isArray(subjects) ? subjects : null;
	if (!labels || labels.length !== n) return shuffle(order);

	const blocks = new Map();
	for (let i = 0; i < n; i++) {
		const key = String(labels[i] == null ? "" : labels[i]).trim() || "General";
		if (!blocks.has(key)) blocks.set(key, []);
		blocks.get(key).push(i);
	}
	if (blocks.size < 2) return shuffle(order);

	const out = [];
	for (const key of shuffle([...blocks.keys()])) {
		out.push(...shuffle(blocks.get(key)));
	}
	return out;
}

/**
 * Is `order` a usable permutation for a list of `count` items?
 * Guards against a teacher adding/removing questions after students submitted.
 */
function isValidQuestionOrder(order, count) {
	if (!Array.isArray(order) || order.length !== count) return false;
	const seen = new Set();
	for (const v of order) {
		const n = Number(v);
		if (!Number.isInteger(n) || n < 0 || n >= count || seen.has(n)) return false;
		seen.add(n);
	}
	return true;
}

/**
 * Reorder a question list into the order a student actually saw.
 * Returns the list untouched when the order is missing or doesn't fit —
 * that is exactly the legacy / pre-shuffle case.
 */
function applyQuestionOrder(questions, order) {
	if (!Array.isArray(questions) || !questions.length) return questions || [];
	if (!isValidQuestionOrder(order, questions.length)) return questions;
	return order.map((originalIdx) => questions[Number(originalIdx)]);
}

/** Safely parse a stored question_order_json value into an array. */
function parseQuestionOrder(raw) {
	if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
	try {
		const parsed = JSON.parse(raw || "[]");
		return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
	} catch {
		return [];
	}
}

module.exports = {
	clamp,
	questionOrderForStudent,
	isValidQuestionOrder,
	applyQuestionOrder,
	parseQuestionOrder,
	getMime,
	toImgPart,
	cleanJson,
	tryParse,
	sanitizeLatexJson,
	normalizeSolutionText,
	repairSolutionLatex,
	parseManualAnswerKey,
	applyManualAnswerKey,
	parseJsonArray,
	looksLikeEquation,
	normalizeMath,
	isNoneCorrectQuestion,
	parseCorrectIndexesFromQuestion,
	validateImageRegion,
	isImageCell,
	normalizeCell,
	normalizeTables,
	normalizeSingleTable,
	normalizeOptionTables,
	normalizeQuestion,
	normalizeQuestionRow,
	normalizeStudentRow,
	isCorrect,
	sleep,
	extractRetrySeconds,
	safeCompare,
	hashPasscode,
	verifyPasscode,
	validatePasswordComplexity,
};
