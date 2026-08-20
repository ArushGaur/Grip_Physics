const express = require("express");
const router = express.Router();
const fs = require("fs");
const { execFile, execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
const PDFDocument = require("pdfkit");
const JSZip = require("jszip");
const { db } = require("../config/db");
const helpers = require("../utils/helpers");
const { requireAdmin, sessionInstituteId } = require("../middleware/auth");
const { loadQuestions, refreshCache, findQuestion } = require("../utils/questions");
const { sanitizeSvg, dataUriToSvg, isSvgDataUri, rasterizeSvgToPng } = require("../utils/svg");
const { docxToPdf } = require("../utils/docxToPdf");
const { requireFeature } = require("../utils/permissions");

const {
	Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
	AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType,
	VerticalAlign, PageNumber, Header, Footer, PageBreak, LevelFormat, TabStopType
} = require("docx");

let latexToOMML = null;
try {
	({ latexToOMML } = require("latex-to-omml"));
} catch (e) { }

/**
 * DOCX cannot embed SVG reliably, so an AI-drawn SVG diagram is rasterized to a
 * PNG buffer here (via @napi-rs/canvas, already a dependency) at 2x scale for
 * crisp print output. Returns null if rasterization is unavailable.
 */

async function resolveImageBuffer(imgSrc) {
	if (!imgSrc) return null;
	try {
		// SVG (raw markup or svg data URI) → PNG for DOCX embedding.
		const svgMarkup = /^\s*<svg[\s>]/i.test(String(imgSrc))
			? String(imgSrc)
			: dataUriToSvg(imgSrc);
		if (svgMarkup) {
			const clean = sanitizeSvg(svgMarkup);
			return clean ? await rasterizeSvgToPng(clean) : null;
		}
		if (imgSrc.startsWith("http://") || imgSrc.startsWith("https://")) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
			try {
				const r = await fetch(imgSrc, { signal: controller.signal });
				clearTimeout(timeout);
				if (!r.ok) {
					console.warn(`[resolveImageBuffer] HTTP ${r.status} for: ${imgSrc}`);
					return null;
				}
				const ab = await r.arrayBuffer();
				return Buffer.from(ab);
			} catch (fetchErr) {
				clearTimeout(timeout);
				console.warn(`[resolveImageBuffer] fetch failed for: ${imgSrc} —`, fetchErr.message);
				return null;
			}
		}
		// strip data-uri prefix if present
		const b64 = imgSrc.replace(/^data:[^;]+;base64,/, "");
		return Buffer.from(b64, "base64");
	} catch (e) {
		console.warn(`[resolveImageBuffer] error:`, e.message);
		return null;
	}
}

// Read pixel dimensions from an image buffer without any external library.
// Supports PNG, JPEG, GIF, and WebP by parsing their binary headers.
// Returns { width, height } in pixels, or null if unrecognised.
async function getImageDimensions(buffer) {
	if (!buffer || buffer.length < 24) return null;
	try {
		// PNG: 8-byte signature, then IHDR chunk (4 len + 4 type + 4 width + 4 height)
		if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
			const width = buffer.readUInt32BE(16);
			const height = buffer.readUInt32BE(20);
			if (width > 0 && height > 0) return { width, height };
		}
		// JPEG: scan SOF markers (0xFF 0xC0 / 0xC1 / 0xC2)
		if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
			let i = 2;
			while (i < buffer.length - 8) {
				if (buffer[i] !== 0xFF) break;
				const marker = buffer[i + 1];
				if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
					const height = buffer.readUInt16BE(i + 5);
					const width = buffer.readUInt16BE(i + 7);
					if (width > 0 && height > 0) return { width, height };
				}
				if (i + 3 >= buffer.length) break;
				const segLen = buffer.readUInt16BE(i + 2);
				if (segLen < 2) break;
				i += 2 + segLen;
			}
		}
		// GIF: 6-byte header then width/height as little-endian uint16
		if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
			const width = buffer.readUInt16LE(6);
			const height = buffer.readUInt16LE(8);
			if (width > 0 && height > 0) return { width, height };
		}
		// WebP: RIFF????WEBP header
		if (
			buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
			buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
		) {
			const chunk = buffer.slice(12, 16).toString('ascii');
			if (chunk === 'VP8 ' && buffer.length >= 30) {
				const width = (buffer.readUInt16LE(26) & 0x3FFF) + 1;
				const height = (buffer.readUInt16LE(28) & 0x3FFF) + 1;
				if (width > 0 && height > 0) return { width, height };
			} else if (chunk === 'VP8L' && buffer.length >= 25) {
				const b = buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24);
				const width = (b & 0x3FFF) + 1;
				const height = ((b >> 14) & 0x3FFF) + 1;
				if (width > 0 && height > 0) return { width, height };
			} else if (chunk === 'VP8X' && buffer.length >= 30) {
				const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
				const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
				if (width > 0 && height > 0) return { width, height };
			}
		}
	} catch (_) { }
	return null;
}

function imgType(src) {
	if (!src) return "jpg";
	// SVG sources are rasterized to PNG by resolveImageBuffer().
	if (/^data:image\/svg\+xml/i.test(src) || /^\s*<svg[\s>]/i.test(src)) return "png";
	if (src.startsWith("data:image/png") || src.includes("iVBOR")) return "png";
	if (src.startsWith("data:image/gif") || src.includes("R0lGOD")) return "gif";
	if (src.startsWith("data:image/webp")) return "jpg"; // fallback
	// Handle URLs: detect extension from path
	try {
		const pathname = new URL(src).pathname.toLowerCase();
		if (pathname.endsWith(".png")) return "png";
		if (pathname.endsWith(".gif")) return "gif";
		if (pathname.endsWith(".webp")) return "jpg"; // fallback
	} catch { }
	return "jpg";
}

// Decode HTML entities that may be stored in question text from AI extraction.
function decodeHtmlEntities(s) {
	return String(s || "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function splitTextIntoTwoLines(s) {
	if (!s || s.length <= 25) return s;

	// Try to split around ' & ' first, if it exists
	const ampIndex = s.indexOf(' & ');
	if (ampIndex !== -1) {
		const part1 = s.substring(0, ampIndex + 2).trim(); // includes '&'
		const part2 = s.substring(ampIndex + 2).trim();
		return part1 + '\n' + part2;
	}

	// Try to split around ' and ' (case-insensitive)
	const andIndex = s.toLowerCase().indexOf(' and ');
	if (andIndex !== -1) {
		const part1 = s.substring(0, andIndex + 4).trim(); // includes 'and'
		const part2 = s.substring(andIndex + 4).trim();
		return part1 + '\n' + part2;
	}

	// Otherwise, find the space closest to the middle of the string
	const mid = Math.floor(s.length / 2);
	let bestSpace = -1;
	let minDiff = Infinity;

	for (let i = 0; i < s.length; i++) {
		if (s[i] === ' ') {
			const diff = Math.abs(i - mid);
			if (diff < minDiff) {
				minDiff = diff;
				bestSpace = i;
			}
		}
	}

	if (bestSpace !== -1) {
		return s.substring(0, bestSpace).trim() + '\n' + s.substring(bestSpace + 1).trim();
	}

	return s;
}

function normalizePaperQuestions(selectedQuestions) {
	return (Array.isArray(selectedQuestions) ? selectedQuestions : []).map((item, index) => {
		const source = item && typeof item === "object" ? item : {};
		const questionSource = source.q && typeof source.q === "object" ? source.q : source;
		const isInteger = String(questionSource.questionType || questionSource.question_type || "").toUpperCase() === "INTEGER"
			|| (questionSource.numericalAnswer !== undefined && questionSource.numericalAnswer !== null);
		const options = Array.isArray(questionSource.options)
			? questionSource.options
			: (isInteger ? [] : [questionSource.option_a, questionSource.option_b, questionSource.option_c, questionSource.option_d]);
		const normalizedOptions = options.map((opt) => decodeHtmlEntities(String(opt ?? "")));
		const correctIndexes = Array.isArray(questionSource.correctIndexes) && questionSource.correctIndexes.length
			? questionSource.correctIndexes
			: (isInteger ? [] : [typeof questionSource.correctIndex === "number" ? questionSource.correctIndex : 0]);

		return {
			chapter: String(source.chapter ?? questionSource.chapter ?? "").trim(),
			topic: String(source.topic ?? questionSource.topic ?? "").trim(),
			lecture: String(source.lecture ?? questionSource.lecture ?? "").trim(),
			qNum: Number.isInteger(source.qNum) ? source.qNum : (index + 1),
			questionIndex: source.questionIndex,
			q: {
				...questionSource,
				question: decodeHtmlEntities(String(questionSource.question ?? "")),
				options: normalizedOptions,
				correctIndexes: correctIndexes
					.map((n) => parseInt(n, 10))
					.filter((n) => Number.isInteger(n) && n >= 0 && n < 4),
				questionImage: questionSource.questionImage ?? null,
				optionImages: Array.isArray(questionSource.optionImages) ? questionSource.optionImages.slice(0, 4) : [],
				solutions: Array.isArray(questionSource.solutions) ? questionSource.solutions.map(sol => ({
					...sol,
					text: decodeHtmlEntities(String(sol.text || "")),
					content: decodeHtmlEntities(String(sol.content || "")),
				})) : [],
			},
		};
	});
}

/**
 * Decode common HTML entities and trim. Shared by table + question builders.
 */
function docxStripMath(s) {
	return String(s || "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.trim();
}

// Detect an image-cell object { text, image, imageNeeded } inside a table cell.
function isDocxImageCell(c) {
	return c && typeof c === "object" && !Array.isArray(c) &&
		("image" in c || c.imageNeeded === true || c.image_needed === true);
}

/**
 * Build the children (Paragraphs) for a single table cell. A cell may be a
 * plain string OR an image-cell object { text, image }. When the cell carries
 * an image, the image is embedded (resolved via resolveImageBuffer) with an
 * optional caption underneath. Returns an array of Paragraph elements.
 */
async function buildTableCellChildren(cell, isHeader, fontSize) {
	if (isDocxImageCell(cell)) {
		const children = [];
		const buf = cell.image ? await resolveImageBuffer(
			String(cell.image).startsWith("data:") || String(cell.image).startsWith("http")
				? String(cell.image) : `data:image/jpeg;base64,${cell.image}`
		) : null;
		if (buf) {
			const bufSize = await calcImgSize(buf, 90, 80);
			children.push(new Paragraph({
				alignment: AlignmentType.CENTER,
				spacing: { before: 20, after: cell.text ? 0 : 20 },
				children: [new ImageRun({ data: buf, transformation: bufSize, type: imgType(String(cell.image)) })],
			}));
		}
		const capText = docxStripMath(cell.text || "");
		if (capText || !buf) {
			children.push(new Paragraph({
				alignment: AlignmentType.CENTER,
				spacing: { before: buf ? 0 : 20, after: 20 },
				children: [new TextRun({ text: capText || (buf ? "" : "[image]"), bold: !!isHeader, font: "Arial", size: fontSize })],
			}));
		}
		return children.length ? children : [new Paragraph({ children: [] })];
	}
	return [new Paragraph({
		alignment: AlignmentType.CENTER,
		spacing: { before: 20, after: 20 },
		children: [new TextRun({ text: docxStripMath(cell || ""), bold: !!isHeader, font: "Arial", size: fontSize })],
	})];
}

/**
 * Build a docx Table element from a { headers, rows, caption } table object.
 * Inline $...$ math inside cells is preserved as text so the OMML post-processor
 * can convert it. Cells may be image-cell objects (embedded as pictures).
 * Returns an array of docx elements (optional caption + table + spacer).
 * `opts.compact` renders a tighter table for use inside an answer option.
 */
async function buildTableElement(tbl, opts = {}) {
	const elements = [];
	if (!tbl || typeof tbl !== "object") return elements;
	const compact = !!opts.compact;
	const fontSize = compact ? 18 : 20;
	const headers = Array.isArray(tbl.headers) ? tbl.headers : [];
	const rows = Array.isArray(tbl.rows) ? tbl.rows.filter((r) => Array.isArray(r)) : [];
	if (!headers.length && !rows.length) return elements;

	// Determine column count from the widest row / header.
	let colCount = headers.length;
	for (const r of rows) colCount = Math.max(colCount, r.length);
	if (colCount === 0) return elements;

	const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: "888888" };
	const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

	// ── Auto-size columns to fit content, not always full page width ─────────
	// Estimate each column's natural width from its longest cell text.
	// Arial ~10pt (size=20 half-points): ~110 DXA per char. Cell pad = 80+80 = 160 DXA.
	// opts.maxWidth caps the table when it lives inside a narrower container cell
	// (e.g. the left column of the options+image layout when a question image is present).
	const MAX_TABLE_DXA = opts.maxWidth != null ? opts.maxWidth : (compact ? 10047 : 10466);
	const CHAR_WIDTH_DXA = 110;
	const CELL_PAD_DXA = 160;
	const MIN_COL_DXA = 600;
	const IMG_COL_DXA = 1800;

	const naturalColWidths = Array.from({ length: colCount }, (_, c) => {
		let maxChars = 0;
		if (headers[c] !== undefined) {
			if (isDocxImageCell(headers[c])) return IMG_COL_DXA;
			maxChars = Math.max(maxChars, docxStripMath(headers[c] || "").length);
		}
		for (const r of rows) {
			const cell = r[c];
			if (cell === undefined || cell === null) continue;
			if (isDocxImageCell(cell)) return IMG_COL_DXA;
			maxChars = Math.max(maxChars, docxStripMath(cell || "").length);
		}
		return Math.max(MIN_COL_DXA, maxChars * CHAR_WIDTH_DXA + CELL_PAD_DXA);
	});

	const naturalTotalDxa = naturalColWidths.reduce((s, w) => s + w, 0);

	let colWidthsArr;
	if (naturalTotalDxa <= MAX_TABLE_DXA) {
		// Table fits within page — use natural widths (table narrower than page)
		colWidthsArr = naturalColWidths;
	} else {
		// Scale columns proportionally to fit within page width
		const scale = MAX_TABLE_DXA / naturalTotalDxa;
		colWidthsArr = naturalColWidths.map(w => Math.max(MIN_COL_DXA, Math.floor(w * scale)));
		// Absorb rounding error into last column
		const scaledTotal = colWidthsArr.reduce((s, w) => s + w, 0);
		colWidthsArr[colCount - 1] += MAX_TABLE_DXA - scaledTotal;
	}

	const tableWidthDxa = colWidthsArr.reduce((s, w) => s + w, 0);

	const makeCell = async (content, isHeader, colIdx) => new TableCell({
		borders: cellBorders,
		verticalAlign: VerticalAlign.CENTER,
		width: { size: colWidthsArr[colIdx] ?? MIN_COL_DXA, type: WidthType.DXA },
		shading: isHeader ? { fill: "E8E8F0", type: ShadingType.CLEAR, color: "auto" } : undefined,
		margins: { top: 40, bottom: 40, left: 80, right: 80 },
		children: await buildTableCellChildren(content, isHeader, fontSize),
	});

	const docxRows = [];
	if (headers.length) {
		const cells = [];
		for (let c = 0; c < colCount; c++) cells.push(await makeCell(headers[c] ?? "", true, c));
		docxRows.push(new TableRow({ tableHeader: true, children: cells }));
	}
	for (const r of rows) {
		const cells = [];
		for (let c = 0; c < colCount; c++) cells.push(await makeCell(r[c] ?? "", false, c));
		docxRows.push(new TableRow({ children: cells }));
	}

	if (tbl.caption) {
		elements.push(new Paragraph({
			spacing: { before: 80, after: 40 },
			children: [new TextRun({ text: docxStripMath(tbl.caption), italics: true, font: "Arial", size: fontSize, color: "555555" })],
		}));
	}

	elements.push(new Table({
		width: { size: tableWidthDxa, type: WidthType.DXA },
		columnWidths: colWidthsArr,
		borders: {
			top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder,
			insideH: cellBorder, insideV: cellBorder,
		},
		rows: docxRows,
	}));
	// Trailing spacer so following content isn't glued to the table.
	elements.push(new Paragraph({ spacing: { before: 0, after: compact ? 40 : 80 }, children: [] }));
	return elements;
}

/**
 * Compute aspect-ratio-correct rendered dimensions for an image buffer.
 * targetWidth — desired width in points (default 120).
 * maxHeight   — cap on rendered height in points (default 110).
 * Returns { width, height } in points.
 */
async function calcImgSize(buf, targetWidth = 120, maxHeight = 110) {
	const dims = await getImageDimensions(buf);
	if (!dims || dims.width <= 0 || dims.height <= 0) {
		return { width: targetWidth, height: Math.min(targetWidth, maxHeight) };
	}
	const aspect = dims.width / dims.height;
	let w = targetWidth;
	let h = Math.round(w / aspect);
	if (h > maxHeight) {
		h = maxHeight;
		w = Math.round(h * aspect);
	}
	return { width: w, height: h };
}

/**
 * Build a list of docx Paragraph / ImageRun elements from a question object.
 * Returns an array of Paragraph objects.
 */
async function buildQuestionParagraphs(q, qNum, mode, opts = {}) {
	// mode: 'question' | 'answerkey' | 'solution'
	const LETTERS = ["A", "B", "C", "D"];
	const paragraphs = [];
	const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
	const borders = { top: border, bottom: border, left: border, right: border };

	// Decode HTML entities that may be stored in the database, then pass text through.
	// $...$ LaTeX is converted to OMML by the post-processor.
	function stripMath(s) {
		return String(s || "")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, "\"")
			.replace(/&apos;/g, "'")
			.replace(/&#39;/g, "'")
			.replace(/&nbsp;/g, " ")
			.trim();
	}

	const questionText = stripMath(q.question || "");
	const isNoneCorrect = q.isNoneCorrect === true;
	const isInteger = String(q.questionType || q.question_type || "").toUpperCase() === "INTEGER"
		|| (q.numericalAnswer !== undefined && q.numericalAnswer !== null);
	const correctIndexes = Array.isArray(q.correctIndexes) && q.correctIndexes.length
		? q.correctIndexes : (isNoneCorrect || isInteger ? [] : [typeof q.correctIndex === "number" ? q.correctIndex : 0]);
	// Human-readable answer label: "None" for none-correct, numeric for INTEGER,
	// otherwise the comma-separated option letters.
	const answerLabel = isNoneCorrect
		? "None (no correct option)"
		: isInteger
			? String(q.numericalAnswer ?? q.correct_answer ?? "")
			: correctIndexes.map(i => LETTERS[i] || "?").join(", ");

	if (mode === "answerkey") {
		// Just one line: Q1. A
		paragraphs.push(new Paragraph({
			spacing: { before: 60, after: 60 },
			children: [
				new TextRun({ text: `Q${qNum}.  `, bold: true, font: "Arial", size: 22 }),
				new TextRun({ text: answerLabel, bold: true, color: isNoneCorrect ? "b06a00" : "1a6b1a", font: "Arial", size: 22 }),
			]
		}));
		return paragraphs;
	}

	if (mode === "solution") {
		// Only show question number and answer key — no question text or image
		const correctLetters = answerLabel;
		paragraphs.push(new Paragraph({
			spacing: { before: 180, after: 40 },
			children: [
				new TextRun({ text: `Q${qNum}.  `, bold: true, font: "Arial", size: 22 }),
				new TextRun({ text: "Answer: ", bold: true, font: "Arial", size: 22 }),
				new TextRun({ text: correctLetters, bold: true, color: "1a6b1a", font: "Arial", size: 22 }),
			]
		}));

		// Solution steps if available
		if (Array.isArray(q.solutions) && q.solutions.length > 0) {
			paragraphs.push(new Paragraph({
				spacing: { before: 40, after: 20 },
				children: [new TextRun({ text: "Solution:", bold: true, underline: {}, font: "Arial", size: 22 })]
			}));
			for (const sol of q.solutions) {
				// Render solution text (supports both sol.text and sol.content)
				const solText = stripMath(sol.content || sol.text || "");
				if (solText) {
					paragraphs.push(new Paragraph({
						spacing: { before: 20, after: 20 },
						indent: { left: 360 },
						children: [new TextRun({ text: solText, font: "Arial", size: 22 })]
					}));
				}
				// Render solution image — supports sol.src (legacy) and sol.image (API response field)
				const imgSrc = sol.src || sol.image || null;
				if (imgSrc) {
					const buf = await resolveImageBuffer(
						imgSrc.startsWith("data:") || imgSrc.startsWith("http") ? imgSrc
							: `data:image/jpeg;base64,${imgSrc}`
					);
					if (buf) {
						const bufSize = await calcImgSize(buf, 280, 200);
						paragraphs.push(new Paragraph({
							spacing: { before: 40, after: 40 },
							alignment: AlignmentType.CENTER,
							children: [new ImageRun({ data: buf, transformation: bufSize, type: imgType(imgSrc) })]
						}));
					}
				}
			}
		}

		// Divider
		paragraphs.push(new Paragraph({
			spacing: { before: 120, after: 0 },
			border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD", space: 1 } },
			children: []
		}));
		return paragraphs;
	}

	// mode === 'question'
	// Layout:
	//  1. Question text  → full-width paragraph, ALWAYS outside any table
	//  2. Options + image → invisible borderless 2-col table:
	//       Left cell (68%)  — option rows only
	//       Right cell (32%) — question image, centred, ~130×100 pt
	//  3. No image → option paragraphs pushed directly (full width, no table)

	// ── Resolve question image buffer ─────────────────────────────────────────
	const options = Array.isArray(q.options) ? q.options : [];
	const optionImages = Array.isArray(q.optionImages) ? q.optionImages : [];
	// Per-option tables (e.g. NEET "match the following" options). When present,
	// each option is rendered as its own mini-table instead of a text run.
	const optionTables = Array.isArray(q.optionTables) ? q.optionTables : [];
	const hasOptionTables = !!q.hasOptionTables && optionTables.some(t => t && typeof t === "object" && ((Array.isArray(t.headers) && t.headers.length) || (Array.isArray(t.rows) && t.rows.length)));
	const hasAnyOptImg = optionImages.some(img => !!img);
	const allOptsShort = !hasOptionTables && !hasAnyOptImg && options.every(o => stripMath(o || "").length <= 35);

	let qImgBuf = null;
	let qImgType = "jpg";
	// Rendered size in points. Height is fixed at 100pt; width is computed from
	// the actual pixel aspect ratio so the image is never stretched or squished.
	const TARGET_HEIGHT_PT = 100;
	const MAX_WIDTH_PT = 200; // cap for very wide/panoramic images
	let qImgWidth = 130;         // default fallback (roughly square)
	let qImgHeight = TARGET_HEIGHT_PT;

	if (q.questionImage) {
		qImgBuf = await resolveImageBuffer(q.questionImage);
		qImgType = imgType(q.questionImage);
		if (qImgBuf) {
			const dims = await getImageDimensions(qImgBuf);
			if (dims && dims.width > 0 && dims.height > 0) {
				const aspect = dims.width / dims.height;
				qImgWidth = Math.round(TARGET_HEIGHT_PT * aspect);
				qImgHeight = TARGET_HEIGHT_PT;
				// If the image is very wide, cap width and scale height down instead
				if (qImgWidth > MAX_WIDTH_PT) {
					qImgWidth = MAX_WIDTH_PT;
					qImgHeight = Math.round(MAX_WIDTH_PT / aspect);
				}
			}
		}
	}

	// ── 1. Question text — always full-width, outside any table ──────────────
	paragraphs.push(new Paragraph({
		spacing: { before: 200, after: 80 },
		children: [
			new TextRun({ text: `Q${qNum}. `, bold: true, font: "Arial", size: 22 }),
			new TextRun({ text: questionText, font: "Arial", size: 22 }),
		],
	}));

	// ── 1b. Render data tables/matrices that belong after the intro text ─────
	const qTables = Array.isArray(q.tables) ? q.tables : [];
	const tablesAfterIntro = qTables.filter(t => (t?.position || "after_intro") !== "after_options");
	const tablesAfterOptions = qTables.filter(t => (t?.position || "after_intro") === "after_options");
	for (const tbl of tablesAfterIntro) {
		paragraphs.push(...(await buildTableElement(tbl)));
	}

	// ── 2. Pre-compute layout column widths ─────────────────────────────────
	// Must be done BEFORE building optionParas so that option tables inside
	// hasOptionTables are correctly width-constrained to the available left column.
	// A4 content = 10466 DXA. Right col = image rendered width (1pt = 20 DXA) +
	// 240 DXA padding, clamped [2400, 4400]. Left col = everything else.
	const noBorder = { style: BorderStyle.NIL, size: 0, color: "auto" };
	const noBorders = {
		top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
		insideH: noBorder, insideV: noBorder,
	};
	const rightColDxa = qImgBuf
		? Math.min(Math.max(Math.round(qImgWidth * 20) + 240, 2400), 4400)
		: 0;
	const leftColDxa = 10466 - rightColDxa;
	// Usable width for options content (subtract right-margin padding on left cell).
	const optAvailDxa = qImgBuf ? leftColDxa - 100 : leftColDxa;
	// Tab stop midpoint for two-column text-option layout.
	const tabPos = Math.round(optAvailDxa / 2);
	const optionParas = [];

	// For integer/numerical questions: show answer field instead of blank A/B/C/D options
	if (isInteger) {
		optionParas.push(new Paragraph({
			spacing: { before: 120, after: 120 },
			children: [
				new TextRun({ text: 'Answer: ____________________', font: "Arial", size: 22, italics: true }),
			],
		}));
	} else if (hasOptionTables) {
		// ── Two-per-row layout for option tables ──────────────────────────────
		// Each pair (A+B, then C+D) goes into a borderless 2-column outer table.
		// halfDxa = width of each column (tight gap of 120 DXA between them).
		const GAP_DXA = 120;
		const halfDxa = Math.floor((optAvailDxa - GAP_DXA) / 2);

		// Estimate natural width of an option table (same heuristic as buildTableElement).
		function estimateOptTblWidth(tbl) {
			if (!tbl || typeof tbl !== "object") return 0;
			const headers = Array.isArray(tbl.headers) ? tbl.headers : [];
			const rows = Array.isArray(tbl.rows) ? tbl.rows.filter(r => Array.isArray(r)) : [];
			let colCount = headers.length;
			for (const r of rows) colCount = Math.max(colCount, r.length);
			if (colCount === 0) return 0;
			let total = 0;
			for (let c = 0; c < colCount; c++) {
				let maxChars = 0;
				if (headers[c] !== undefined) {
					if (isDocxImageCell(headers[c])) { total += 1800; continue; }
					maxChars = Math.max(maxChars, docxStripMath(headers[c] || "").length);
				}
				for (const r of rows) {
					const cell = r[c];
					if (cell === undefined || cell === null) continue;
					if (isDocxImageCell(cell)) { total += 1800; maxChars = -Infinity; break; }
					maxChars = Math.max(maxChars, docxStripMath(cell || "").length);
				}
				if (maxChars !== -Infinity) total += Math.max(600, maxChars * 110 + 160);
			}
			return total;
		}

		// Check if every option table fits within halfDxa (i.e. can share a row).
		const allFitHalf = optionTables.every(tbl => {
			const hasTbl = tbl && typeof tbl === "object" &&
				((Array.isArray(tbl.headers) && tbl.headers.length) ||
					(Array.isArray(tbl.rows) && tbl.rows.length));
			return !hasTbl || estimateOptTblWidth(tbl) <= halfDxa;
		});

		// Build children for one option slot: label paragraph + table/image/text.
		async function buildOptCellChildren(oi, maxWidth) {
			const tbl = optionTables[oi];
			const hasTbl = tbl && typeof tbl === "object" &&
				((Array.isArray(tbl.headers) && tbl.headers.length) ||
					(Array.isArray(tbl.rows) && tbl.rows.length));
			const children = [];
			children.push(new Paragraph({
				spacing: { before: 40, after: 16 },
				children: [new TextRun({ text: `  (${LETTERS[oi]})`, bold: true, font: "Arial", size: 22 })],
			}));
			if (hasTbl) {
				children.push(...(await buildTableElement(tbl, { compact: true, maxWidth })));
			} else if (optionImages[oi]) {
				const ob = await resolveImageBuffer(optionImages[oi]);
				if (ob) {
					const obSize = await calcImgSize(ob, 120, 110);
					children.push(new Paragraph({
						spacing: { before: 0, after: 40 },
						children: [new ImageRun({ data: ob, transformation: obSize, type: imgType(optionImages[oi]) })],
					}));
				}
			} else {
				children.push(new Paragraph({
					spacing: { before: 0, after: 40 },
					children: [new TextRun({ text: stripMath(options[oi] || ""), font: "Arial", size: 22 })],
				}));
			}
			return children;
		}

		if (allFitHalf) {
			// Two-per-row: (A)+(B) on row 1, (C)+(D) on row 2
			for (let oi = 0; oi < 4; oi += 2) {
				const leftChildren = await buildOptCellChildren(oi, halfDxa);
				const rightChildren = await buildOptCellChildren(oi + 1, halfDxa);
				optionParas.push(new Table({
					width: { size: optAvailDxa, type: WidthType.DXA },
					columnWidths: [halfDxa, GAP_DXA, halfDxa],
					borders: noBorders,
					rows: [
						new TableRow({
							children: [
								new TableCell({
									width: { size: halfDxa, type: WidthType.DXA },
									borders: noBorders,
									verticalAlign: VerticalAlign.TOP,
									margins: { top: 0, bottom: 0, left: 0, right: 0 },
									children: leftChildren,
								}),
								// Narrow spacer cell for the gap
								new TableCell({
									width: { size: GAP_DXA, type: WidthType.DXA },
									borders: noBorders,
									children: [new Paragraph({ children: [] })],
								}),
								new TableCell({
									width: { size: halfDxa, type: WidthType.DXA },
									borders: noBorders,
									verticalAlign: VerticalAlign.TOP,
									margins: { top: 0, bottom: 0, left: 0, right: 0 },
									children: rightChildren,
								}),
							],
						}),
					],
				}));
			}
		} else {
			// Fallback: one per row (tables too wide to share a row)
			for (let oi = 0; oi < 4; oi++) {
				const children = await buildOptCellChildren(oi, optAvailDxa);
				optionParas.push(...children);
			}
		}
	} else if (allOptsShort) {
		// A + B on row 1, C + D on row 2 (short text options)
		for (let oi = 0; oi < 4; oi += 2) {
			const textA = stripMath(options[oi] || "");
			const textB = stripMath(options[oi + 1] || "");
			optionParas.push(new Paragraph({
				spacing: { before: 40, after: 40 },
				tabStops: [{ type: TabStopType.LEFT, position: tabPos }],
				children: [
					new TextRun({ text: `  (${LETTERS[oi]})  `, bold: true, font: "Arial", size: 22 }),
					new TextRun({ text: textA, font: "Arial", size: 22 }),
					new TextRun({ text: `\t  (${LETTERS[oi + 1]})  `, bold: true, font: "Arial", size: 22 }),
					new TextRun({ text: textB, font: "Arial", size: 22 }),
				],
			}));
		}
	} else if (hasAnyOptImg) {
		// Option images → 2 per row (A & B on row 1, C & D on row 2)
		const optImgBufs = [];
		for (let oi = 0; oi < 4; oi++) {
			const optImg = optionImages[oi] || null;
			if (optImg) {
				const buf = await resolveImageBuffer(optImg);
				const size = buf ? await calcImgSize(buf, 120, 110) : { width: 120, height: 80 };
				optImgBufs[oi] = { buf, type: imgType(optImg), size };
			} else {
				optImgBufs[oi] = null;
			}
		}
		for (let oi = 0; oi < 4; oi += 2) {
			const rowChildren = [];
			rowChildren.push(new TextRun({ text: `  (${LETTERS[oi]})  `, bold: true, font: "Arial", size: 22 }));
			if (optImgBufs[oi] && optImgBufs[oi].buf) {
				rowChildren.push(new ImageRun({ data: optImgBufs[oi].buf, transformation: optImgBufs[oi].size, type: optImgBufs[oi].type }));
			} else {
				rowChildren.push(new TextRun({ text: stripMath(options[oi] || ""), font: "Arial", size: 22 }));
			}
			rowChildren.push(new TextRun({ text: `\t  (${LETTERS[oi + 1]})  `, bold: true, font: "Arial", size: 22 }));
			if (optImgBufs[oi + 1] && optImgBufs[oi + 1].buf) {
				rowChildren.push(new ImageRun({ data: optImgBufs[oi + 1].buf, transformation: optImgBufs[oi + 1].size, type: optImgBufs[oi + 1].type }));
			} else {
				rowChildren.push(new TextRun({ text: stripMath(options[oi + 1] || ""), font: "Arial", size: 22 }));
			}
			optionParas.push(new Paragraph({
				spacing: { before: 40, after: 40 },
				tabStops: [{ type: TabStopType.LEFT, position: tabPos }],
				children: rowChildren,
			}));
		}
	} else {
		// One option per line (long text)
		for (let oi = 0; oi < 4; oi++) {
			const optText = stripMath(options[oi] || "");
			optionParas.push(new Paragraph({
				spacing: { before: 40, after: 40 },
				children: [
					new TextRun({ text: `  (${LETTERS[oi]})  `, bold: true, font: "Arial", size: 22 }),
					new TextRun({ text: optText, font: "Arial", size: 22 }),
				],
			}));
		}
	}

	// ── 3. Combine options + image ────────────────────────────────────────────
	if (qImgBuf) {
		paragraphs.push(new Table({
			width: { size: 10466, type: WidthType.DXA },
			columnWidths: [leftColDxa, rightColDxa],
			borders: noBorders,
			rows: [
				new TableRow({
					children: [
						// Left cell — options
						new TableCell({
							width: { size: leftColDxa, type: WidthType.DXA },
							borders: noBorders,
							verticalAlign: VerticalAlign.TOP,
							margins: { top: 0, bottom: 0, left: 0, right: 100 },
							children: optionParas,
						}),
						// Right cell — question image, aspect-ratio preserved
						new TableCell({
							width: { size: rightColDxa, type: WidthType.DXA },
							borders: noBorders,
							verticalAlign: VerticalAlign.CENTER,
							margins: { top: 40, bottom: 0, left: 60, right: 0 },
							children: [
								new Paragraph({
									spacing: { before: 0, after: 0 },
									alignment: AlignmentType.CENTER,
									children: [
										new ImageRun({
											data: qImgBuf,
											type: qImgType,
											transformation: { width: qImgWidth, height: qImgHeight },
										}),
									],
								}),
							],
						}),
					],
				}),
			],
		}));
	} else {
		// No image — full-width option paragraphs / tables
		paragraphs.push(...optionParas);
	}

	// ── 4. Render any tables explicitly positioned after the options ─────────
	for (const tbl of tablesAfterOptions) {
		paragraphs.push(...(await buildTableElement(tbl)));
	}

	return paragraphs;
}

/**
 * Build a full DOCX document for the given mode.
 * questions: array of { chapter, topic, lecture, qNum, q }
 * headerMeta: { subject, chapter, testType, class: className } — user-provided header fields
 */
async function buildPaperDoc(selectedQuestions, mode, title, headerMeta = {}) {
	const allParas = [];
	const subject = decodeHtmlEntities(String(headerMeta.subject || '').trim());
	const chapter = decodeHtmlEntities(String(headerMeta.chapter || '').trim());
	const testType = decodeHtmlEntities(String(headerMeta.testType || '').trim());
	const className = decodeHtmlEntities(String(headerMeta.class || '').trim());

	const noBorders = {
		top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
		bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
		left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
		right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
	};

	if (subject || chapter || testType) {
		// Rich header using a two-column table:
		//   Left column  → CLASS X (top-left)
		//   Right column → Subject / [Chapter] / Test Type (centered)
		// Build centre-column paragraphs
		const centreParas = [];
		if (subject) {
			centreParas.push(new Paragraph({
				spacing: { before: 0, after: 40 },
				alignment: AlignmentType.CENTER,
				children: [new TextRun({ text: subject.toUpperCase(), bold: true, font: "Arial", size: 30, color: "1a1a2e" })]
			}));
		}
		if (chapter) {
			const splitLines = splitTextIntoTwoLines(chapter.toUpperCase()).split('\n');
			const children = [];
			for (let i = 0; i < splitLines.length; i++) {
				const lineText = splitLines.length > 1
					? (i === 0 ? `[ ${splitLines[i]}` : `${splitLines[i]} ]`)
					: `[ ${splitLines[i]} ]`;
				children.push(new TextRun({
					text: lineText,
					bold: true,
					font: "Arial",
					size: 28,
					color: "1a1a2e",
					underline: {},
					break: i > 0 ? 1 : undefined
				}));
			}
			centreParas.push(new Paragraph({
				spacing: { before: 0, after: 40 },
				alignment: AlignmentType.CENTER,
				children: children
			}));
		}
		if (testType) {
			centreParas.push(new Paragraph({
				spacing: { before: 0, after: 0 },
				alignment: AlignmentType.CENTER,
				children: [new TextRun({ text: testType.toUpperCase(), bold: true, font: "Arial", size: 32, color: "1a1a2e" })]
			}));
		}
		if (!centreParas.length) {
			centreParas.push(new Paragraph({ children: [] }));
		}

		// Left column: CLASS label (only if provided)
		const leftParas = className
			? [
				new Paragraph({
					spacing: { before: 0, after: 0 },
					alignment: AlignmentType.LEFT,
					children: [new TextRun({ text: `CLASS ${className.toUpperCase()}`, bold: true, font: "Arial", size: 26, color: "1a1a2e" })]
				})
			]
			: [new Paragraph({ children: [] })];

		// Render as a borderless 3-column table so CLASS sits top-left while title is centred.
		// A4 content width = 10466 DXA; 20% = 2093, 60% = 6280, 20% = 2093.
		allParas.push(new Table({
			width: { size: 10466, type: WidthType.DXA },
			columnWidths: [2093, 6280, 2093],
			borders: {
				top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
				bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
				left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
				right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
				insideH: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
				insideV: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
			},
			rows: [
				new TableRow({
					children: [
						// Left cell — CLASS label (20%)
						new TableCell({
							width: { size: 2093, type: WidthType.DXA },
							borders: noBorders,
							verticalAlign: VerticalAlign.CENTER,
							margins: { top: 80, bottom: 80, left: 0, right: 0 },
							children: leftParas,
						}),
						// Centre cell — subject / chapter / test-type (60%)
						new TableCell({
							width: { size: 6280, type: WidthType.DXA },
							borders: noBorders,
							verticalAlign: VerticalAlign.CENTER,
							margins: { top: 80, bottom: 80, left: 0, right: 0 },
							children: centreParas,
						}),
						// Right cell — empty placeholder (20%)
						new TableCell({
							width: { size: 2093, type: WidthType.DXA },
							borders: noBorders,
							children: [new Paragraph({ children: [] })],
						}),
					],
				}),
			],
		}));
		// small gap after the header table
		allParas.push(new Paragraph({ spacing: { before: 0, after: 60 }, children: [] }));
	} else {
		// Fallback: plain title (original behaviour)
		allParas.push(new Paragraph({
			spacing: { before: 0, after: 360 },
			alignment: AlignmentType.CENTER,
			children: [new TextRun({ text: title, bold: true, font: "Arial", size: 36, color: "1a1a2e" })]
		}));
	}

	// Date line + student name line
	allParas.push(new Paragraph({
		spacing: { before: 0, after: (subject || chapter || testType) && mode === "question" ? 120 : 360 },
		alignment: AlignmentType.CENTER,
		children: [new TextRun({ text: `Date: _______________   Total Questions: ${selectedQuestions.length}`, font: "Arial", size: 22, color: "555555" })]
	}));
	if ((subject || chapter || testType) && mode === "question") {
		allParas.push(new Paragraph({
			spacing: { before: 0, after: 360 },
			children: [new TextRun({ text: "NAME OF STUDENT ________________________________", font: "Arial", size: 22, bold: true, color: "1a1a2e" })]
		}));
	}

	// Insert invisible marker before questions so mergeWithTemplate can find
	// the split point reliably (instead of fragile paragraph counting).
	const qsMarker = "§§QS_MARKER§§";
	allParas.push(new Paragraph({
		spacing: { before: 0, after: 0 },
		children: [new TextRun({ text: qsMarker, font: "Arial", size: 1, color: "FFFFFF" })]
	}));

	if (mode === "answerkey") {
		// Two-column layout for answer key
		allParas.push(new Paragraph({
			spacing: { before: 0, after: 240 },
			children: [new TextRun({ text: "Answer Key", bold: true, font: "Arial", size: 28, underline: {} })]
		}));
		for (const item of selectedQuestions) {
			const paras = await buildQuestionParagraphs(item.q, item.qNum, "answerkey");
			allParas.push(...paras);
		}
	} else {
		// No topic headings — questions are listed directly without any topic name.
		for (const item of selectedQuestions) {
			const paras = await buildQuestionParagraphs(item.q, item.qNum, mode);
			allParas.push(...paras);
		}
	}

	const doc = new Document({
		sections: [{
			properties: {
				page: {
					size: { width: 11906, height: 16838 }, // A4 in twips (matches LibreOffice PDF output)
					margin: { top: 720, right: 720, bottom: 720, left: 720 }
				}
			},
			children: allParas
		}]
	});

	return Packer.toBuffer(doc);
}

/**
 * Post-process a generated DOCX:
 *  1. Convert all $...$ LaTeX in text to proper OMML Word equations
 *  2. Optionally merge a template DOCX (headers, footers, styles)
 *
 * This implementation stays entirely in Node so it works in the container
 * and on Windows without relying on a local Python runtime.
 */
function extractTextFromRun(runXml) {
	const texts = [...String(runXml || "").matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gs)].map((m) => decodeXml(m[1]));
	return texts.join("");
}

function extractRprFromRun(runXml) {
	const match = String(runXml || "").match(/<w:rPr>(.*?)<\/w:rPr>/s);
	return match ? match[0] : "";
}

function splitMath(text) {
	const parts = [];
	const source = String(text || "");
	let i = 0;
	while (i < source.length) {
		if (source.slice(i, i + 2) === "$$") {
			const end = source.indexOf("$$", i + 2);
			if (end !== -1) {
				parts.push({ isMath: true, content: source.slice(i + 2, end), display: true });
				i = end + 2;
				continue;
			}
		}
		if (source[i] === "$") {
			const end = source.indexOf("$", i + 1);
			if (end !== -1 && end > i + 1) {
				parts.push({ isMath: true, content: source.slice(i + 1, end), display: false });
				i = end + 1;
				continue;
			}
		}
		let j = i;
		while (j < source.length && source[j] !== "$") j++;
		if (j > i) parts.push({ isMath: false, content: source.slice(i, j), display: false });
		i = j;
	}
	return parts.length ? parts : [{ isMath: false, content: source, display: false }];
}

// Convert LaTeX to safe plain-text XML run when OMML conversion fails.
function latexFallbackRun(src) {
	// Normalise to raw text first so we never double-encode (&amp; -> &amp;amp; etc.)
	const normalized = fullyDecodeXml(String(src || ""));

	// If this looks like matrix content (has \\\\ row separators and & col separators),
	// render it in a readable [row1; row2] style instead of garbled & characters.
	function matrixFallback(s) {
		if (!s.includes("\\\\") && !(/(?<!\\)&/.test(s))) return null;
		// Strip any \begin{...} ... \end{...} wrappers first
		const inner = s.replace(/\\begin\{[^}]*\}/g, "").replace(/\\end\{[^}]*\}/g, "").trim();
		const rows = inner.split("\\\\").map(row =>
			row.split(/(?<!\\)&/).map(cell =>
				cell
					.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)")
					.replace(/\\sqrt\{([^{}]*)\}/g, "\u221a($1)")
					.replace(/\\text\{([^{}]*)\}/g, "$1")
					.replace(/\\([a-zA-Z]+)\{([^{}]*)\}/g, "$1($2)")
					.replace(/\\([a-zA-Z]+)/g, "$1")
					.replace(/[\\&{}]/g, "")
					.trim()
			).join("  ")
		).filter(r => r.trim());
		if (!rows.length) return null;
		return "[" + rows.join(" ; ") + "]";
	}

	const matrixText = matrixFallback(normalized);
	const readable = (matrixText || normalized
		.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
		.replace(/\\sqrt\{([^{}]*)\}/g, '\u221a($1)')
		.replace(/\\left\(/g, '(').replace(/\\right\)/g, ')')
		.replace(/\\left\[/g, '[').replace(/\\right\]/g, ']')
		.replace(/\\text\{([^{}]*)\}/g, '$1')
		// ── Reaction / extensible arrows → readable Unicode arrows
		.replace(/\\xrightarrow\s*\[([^\][]*)\]\s*\{([^{}]*)\}/g, ' —($2, $1)→ ')
		.replace(/\\xrightarrow\s*\{([^{}]*)\}/g, ' —($1)→ ')
		.replace(/\\xleftarrow\s*\{([^{}]*)\}/g, ' ←($1)— ')
		.replace(/\\xrightleftharpoons\s*\{([^{}]*)\}/g, ' ⇌($1) ')
		.replace(/\\(?:longrightarrow|rightarrow|to)\b/g, '→')
		.replace(/\\(?:longleftarrow|leftarrow|gets)\b/g, '←')
		.replace(/\\(?:longleftrightarrow|leftrightarrow)\b/g, '↔')
		.replace(/\\rightleftharpoons\b/g, '⇌')
		.replace(/\\Delta\b/g, 'Δ')
		// ── Accent commands: render as Unicode combining chars so text is readable
		//    (these are the fallback path — OMML conversion already failed)
		.replace(/\\overline\{([^{}]*)\}/g, '$1\u0305')   // x̄
		.replace(/\\bar\{([^{}]*)\}/g, '$1\u0305')         // x̄
		.replace(/\\hat\{([^{}]*)\}/g, '$1\u0302')         // x̂
		.replace(/\\tilde\{([^{}]*)\}/g, '$1\u0303')       // x̃
		.replace(/\\vec\{([^{}]*)\}/g, '$1\u20d7')         // x⃗
		.replace(/\\dot\{([^{}]*)\}/g, '$1\u0307')         // ẋ
		.replace(/\\ddot\{([^{}]*)\}/g, '$1\u0308')        // ẍ
		.replace(/\\([a-zA-Z]+)\{([^{}]*)\}/g, '$1($2)')
		.replace(/\\([a-zA-Z]+)/g, '$1')
		.replace(/[\{\}]/g, ''))
		// XML-encode AFTER all transforms — & must come first to avoid double-encoding
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.trim();
	const spaceAttr = readable.startsWith(" ") || readable.endsWith(" ") ? ' xml:space="preserve"' : "";
	return `<w:r><w:t${spaceAttr}>${readable}</w:t></w:r>`;
}

async function latexToOmmlWrapped(latex, displayMode = false) {
	const src = String(latex || "");
	if (typeof latexToOMML !== "function") {
		return latexFallbackRun(src);
	}

	// ── Pre-process: detect bare matrix content (rows separated by \\\\ and columns
	// by & or \\&) that has no \begin{...} wrapper and wrap it so the library
	// can convert it properly. This covers patterns like:
	//   p_1(x) & p_1'(x) \\\\ p_2(x) & p_2'(x)
	// which the DB stores without an explicit matrix environment.
	//
	// IMPORTANT — determinants: if the bare matrix content is wrapped in a literal
	// "|" ... "|" pair (the plain-text way determinants get typed/stored, e.g.
	//   |a & a+1 & a-1 \\ -b & b+1 & b-1 \\ c & c-1 & c+1|
	// ), those pipe characters must NOT be left in place — they were previously
	// rendered as ordinary fixed-height text glyphs (tiny bars that don't span the
	// matrix height) instead of a proper stretching determinant delimiter. We strip
	// the literal "|" and use \begin{vmatrix}...\end{vmatrix} instead, which the
	// OMML converter renders as a single delimiter pair (<m:d>) that auto-grows to
	// match the full height of the matrix — exactly like a real determinant.
	//
	// A single bare-matrix block can itself contain several "|...|" determinants
	// joined by +, -, or = (see Q2's "|...| + |...|" pattern), each must be wrapped
	// independently so every determinant gets its own pair of stretching bars.
	function wrapBareMatrix(s) {
		// Already has an environment — leave alone
		if (/\\begin\{/.test(s)) return s;
		// Must have at least one \\\\ row separator AND at least one & column separator
		if (!s.includes("\\\\") || !(/(?<!\\)&/.test(s))) return s;

		// Split on top-level "|" characters (not \left|, \right|, \| etc — those are
		// already-escaped pipes and shouldn't be treated as bare delimiters).
		const segments = s.split(/(?<!\\)\|/);

		if (segments.length > 1) {
			// We have at least one literal "|...|" pair. Rebuild the string, replacing
			// each piece that sits between a pair of bare pipes with a vmatrix block,
			// and leaving everything outside the pipes (e.g. " + ", "= 0") untouched.
			let rebuilt = "";
			for (let i = 0; i < segments.length; i++) {
				const seg = segments[i];
				const isInsideBars = i % 2 === 1; // odd segments were between a pair of |
				if (isInsideBars && seg.includes("\\\\") && /(?<!\\)&/.test(seg)) {
					rebuilt += `\\begin{vmatrix}${seg}\\end{vmatrix}`;
				} else if (isInsideBars) {
					// Content between bars that isn't actually matrix rows (shouldn't
					// normally happen here) — restore the literal bars rather than lose them.
					rebuilt += `|${seg}|`;
				} else {
					rebuilt += seg;
				}
			}
			return rebuilt;
		}

		// No literal "|" delimiters — fall back to round-bracket pmatrix, the
		// standard default for a bare matrix with no other delimiter specified.
		return `\\begin{pmatrix}${s}\\end{pmatrix}`;
	}

	// ── Pre-process LaTeX before OMML conversion ─────────────────────────────
	// Fixes two classes of □ boxes Word renders:
	//
	//   1. Combination/permutation notation: `^{20}C_{r-1}` or `^nC_r`
	//      The `^` before C/P has NO explicit base character.
	//      Even `{}^{n}C_r` (empty base) still produces an empty <m:e> in OMML
	//      that Word renders as □.
	//      ROOT FIX: Swap scripts to the right of C/P so C/P becomes the base:
	//        ^{20}C_{i-1}  →  C_{i-1}^{20}
	//        ^nC_r         →  C_r^{n}
	//      Word renders C with right-side super/subscripts perfectly (no box).
	//
	//   2. Raw Unicode combining overline U+0305 embedded in LaTeX text:
	//      MathJax rejects it → conversion fails → Word shows □.
	//      Fix: convert `x\u0305` → `\overline{x}` before conversion.
	// Find the index of the delimiter that closes the one at `start`.
	function matchDelimIndex(s, start, open, close) {
		let depth = 0;
		for (let i = start; i < s.length; i++) {
			if (s[i] === "\\") { i++; continue; }
			if (s[i] === open) depth++;
			else if (s[i] === close) { depth--; if (depth === 0) return i; }
		}
		return -1;
	}

	// ── Extensible (labelled) arrows + mhchem ────────────────────────────────
	// MathJax-core / latex-to-omml does not implement \xrightarrow, \xleftarrow,
	// \xrightleftharpoons or \ce{...}. A single unknown macro makes the WHOLE
	// equation fail to convert, so the paragraph silently degrades to italic
	// plain text — exactly the "reaction arrow with a condition written above it"
	// case in chemistry papers (e.g. $A \xrightarrow{H^+/heat} B$).
	//
	// Rewrite them into \overset / \underset over a plain arrow, which OMML
	// renders natively as a proper arrow with text above/below it.
	function rewriteExtensibleArrows(input) {
		let out = String(input || "");

		// mhchem: \ce{H2SO4} → \mathrm{H_{2}SO_{4}}
		let guard = 0;
		while (out.includes("\\ce{") && guard++ < 40) {
			const at = out.indexOf("\\ce{");
			const open = out.indexOf("{", at);
			const close = matchDelimIndex(out, open, "{", "}");
			if (close === -1) break;
			const body = out.slice(open + 1, close).replace(/([A-Za-z)\]])(\d+)/g, "$1_{$2}");
			out = out.slice(0, at) + "\\mathrm{" + body + "}" + out.slice(close + 1);
		}

		const ARROWS = [
			["xrightleftharpoons", "\\rightleftharpoons"],
			["xleftrightarrow", "\\longleftrightarrow"],
			["xrightarrow", "\\longrightarrow"],
			["xleftarrow", "\\longleftarrow"],
			["xrightharpoonup", "\\rightharpoonup"],
			["xleftharpoondown", "\\leftharpoondown"],
		];
		for (const [macro, arrow] of ARROWS) {
			let loops = 0;
			for (;;) {
				if (loops++ > 40) break;
				const at = out.indexOf("\\" + macro);
				if (at === -1) break;
				let i = at + macro.length + 1;
				while (out[i] === " ") i++;
				let below = "";
				if (out[i] === "[") {
					const close = matchDelimIndex(out, i, "[", "]");
					if (close === -1) break;
					below = out.slice(i + 1, close);
					i = close + 1;
					while (out[i] === " ") i++;
				}
				let above = "";
				if (out[i] === "{") {
					const close = matchDelimIndex(out, i, "{", "}");
					if (close === -1) break;
					above = out.slice(i + 1, close);
					i = close + 1;
				}
				// Labels are usually words/conditions ("heat", "dark", "in absence of
				// peroxide") — keep them upright unless they clearly contain math.
				const dress = (label) => {
					const t = String(label || "").trim();
					if (!t) return "";
					if (/[\\^_{}$]/.test(t)) return t;
					return "\\text{" + t + "}";
				};
				let rebuilt = arrow;
				const top = dress(above);
				const bottom = dress(below);
				if (top) rebuilt = "\\overset{" + top + "}{" + rebuilt + "}";
				if (bottom) rebuilt = "\\underset{" + bottom + "}{" + rebuilt + "}";
				out = out.slice(0, at) + rebuilt + out.slice(i);
			}
		}

		// \limits after a plain arrow is meaningless in OMML and breaks conversion.
		out = out.replace(/\\limits(?=\s*[_^])/g, "");
		return out;
	}

	function fixLatexBeforeOmml(s) {
		return rewriteExtensibleArrows(String(s || ""))
			// ── Unicode combining overline (U+0305) → \overline{x}
			.replace(/([a-zA-Z0-9])\u0305/g, '\\overline{$1}')
			// ── ^{n}C_{r} or ^nC_r: swap pre-scripts to RIGHT side of C/P
			//    so C/P becomes the base element (no empty <m:e> → no □ box).
			//    e.g. ^{20}C_{i-1} → C_{i-1}^{20}  |  ^nC_r → C_r^{n}
			.replace(
				/(?<![}\])\w])\^(\{[^{}]*\}|[a-zA-Z0-9])(C|P)(_{[^{}]*}|_[a-zA-Z0-9])?/g,
				(_, sup, letter, sub) => {
					const supBraced = sup.startsWith('{') ? sup : `{${sup}}`;
					return `${letter}${sub || ''}^${supBraced}`;
				}
			);
	}

	const preprocessed = wrapBareMatrix(fixLatexBeforeOmml(src));
	const hasAlignmentEnv = /\\begin\{(?:aligned|array|matrix|pmatrix|bmatrix|vmatrix|cases|align|alignedat)\}/i.test(preprocessed);
	const primarySrc = !hasAlignmentEnv && preprocessed.includes("&")
		? preprocessed.replace(/(?<!\\)&/g, "\\&")
		: preprocessed;
	// Sanitize OMML output: fix bare & characters inside <m:t> tags that break Word's XML parser
	function sanitizeOmml(omml) {
		// 1. Normalise <m:oMath> — ensure xmlns:m is present, injecting it when missing.
		//    Keep all other attributes (e.g. xml:space, m:defJc) intact.
		//    Word's XML parser is strict: if xmlns:m is absent both here and on <w:document>
		//    the file is rejected as invalid XML and cannot be opened at all.
		let clean = String(omml || "").replace(/<m:oMath\b([^>]*)>/g, (match, attrs) => {
			if (/\bxmlns:m\s*=\s*"/.test(attrs)) return `<m:oMath${attrs}>`;
			return `<m:oMath${attrs} xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">`;
		});

		// 1b. Wrap "bracket-run + matrix + bracket-run" into a proper <m:d> delimiter.
		//     ROOT CAUSE of tiny/non-stretching matrix & determinant brackets:
		//     the latex-to-omml library renders \begin{vmatrix}/\begin{pmatrix}/
		//     \begin{bmatrix} etc. as a plain text run for the opening character,
		//     then the <m:m> matrix, then a plain text run for the closing character —
		//     e.g. <m:r><m:t>|</m:t></m:r><m:m>...</m:m><m:r><m:t>|</m:t></m:r>
		//     A plain <m:t> glyph is a fixed-height character, so it never grows to
		//     match the height of a multi-row matrix next to it — this is exactly the
		//     "tiny bars" bug. The correct OMML object is <m:d> (delimiter), which Word
		//     stretches automatically to fully enclose its content. We detect this exact
		//     adjacent run+matrix+run pattern for every matching bracket pair Word
		//     supports and rebuild it as <m:d><m:dPr><m:begChr/><m:endChr/></m:dPr>
		//     <m:e>...</m:e></m:d>, which is what makes the brackets auto-grow.
		const DELIM_PAIRS = [
			['|', '|'], ['(', ')'], ['[', ']'], ['{', '}'],
			['‖', '‖'], ['⟨', '⟩'],
		];
		for (const [openCh, closeCh] of DELIM_PAIRS) {
			const openChEsc = openCh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const closeChEsc = closeCh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const pattern = new RegExp(
				`<m:r>(?:<m:rPr>[\\s\\S]*?<\\/m:rPr>)?<m:t[^>]*>${openChEsc}<\\/m:t><\\/m:r>` +
				`(<m:m\\b[\\s\\S]*?<\\/m:m>)` +
				`<m:r>(?:<m:rPr>[\\s\\S]*?<\\/m:rPr>)?<m:t[^>]*>${closeChEsc}<\\/m:t><\\/m:r>`,
				'g'
			);
			clean = clean.replace(pattern, (match, matrixXml) => {
				return `<m:d><m:dPr><m:begChr m:val="${openCh}"/><m:endChr m:val="${closeCh}"/></m:dPr><m:e>${matrixXml}</m:e></m:d>`;
			});
		}

		// 2. Strip any attributes (like xml:space) from <m:t> elements which violate Word's strict math schema
		clean = clean.replace(/<m:t\b[^>]*>/g, '<m:t>');

		// 2b. Fix `<m:sty m:val="..."/>` values that aren't in the OMML whitelist
		//     (p | b | i | bi). Any other value (e.g. "undefined", "normal", "bold-italic")
		//     makes Word reject the file. Map all invalid values to "p" (plain/upright).
		clean = clean.replace(/<m:sty\b[^>]*m:val="([^"]*)"[^>]*\/>/g, (match, val) => {
			if (val === 'p' || val === 'b' || val === 'i' || val === 'bi') return match;
			return match.replace(`m:val="${val}"`, 'm:val="p"');
		});
		// Also drop any <m:sty/> that has NO m:val at all (also schema-invalid).
		clean = clean.replace(/<m:sty\s*\/>/g, '');

		// 2c. Fix element order inside <m:r>. Per OMML schema CT_R the order is:
		//     <m:rPr>?, <w:rPr>?, ...content...
		//     mathml2omml emits them in the WRONG order (w:rPr first, then m:rPr),
		//     which Word rejects as schema-invalid. We swap them so m:rPr comes
		//     first. Also drop empty <w:rPr/> which adds nothing and only hurts.
		clean = clean.replace(
			/(<m:r\b[^>]*>)\s*<w:rPr\s*\/>\s*(<m:rPr\b[^>]*>[\s\S]*?<\/m:rPr>)/g,
			'$1$2'
		);
		clean = clean.replace(
			/(<m:r\b[^>]*>)\s*(<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>)\s*(<m:rPr\b[^>]*>[\s\S]*?<\/m:rPr>)/g,
			'$1$3$2'
		);

		// 2d. Ensure <m:bar> always has <m:barPr> with a pos element.
		//     Word renders □ when <m:barPr> is absent or empty because it cannot
		//     determine if the bar goes on top (overline) or below (underline).
		//     MathJax-node sometimes emits bare <m:bar> without the property child.
		clean = clean.replace(
			/<m:bar>(?!\s*<m:barPr)/g,
			'<m:bar><m:barPr><m:pos m:val="top"/></m:barPr>'
		);
		// Also fix <m:barPr> that is present but missing the required <m:pos> child.
		clean = clean.replace(
			/<m:barPr>(?!\s*<m:pos)(?!\s*<\/m:barPr)/g,
			'<m:barPr><m:pos m:val="top"/>'
		);

		// 2e. Ensure <m:acc> always has <m:accPr> (accent elements like hat, tilde).
		//     Same issue — Word shows □ when the property child is missing.
		clean = clean.replace(
			/<m:acc>(?!\s*<m:accPr)/g,
			'<m:acc><m:accPr><m:chr m:val="&#x305;"/></m:accPr>'
		);

		// 3. Fix unescaped &, <, and > inside text content of m:t and w:t elements.
		// The latex-to-omml library sometimes emits raw XML structure tags inside
		// <m:t> elements (e.g. <m:t></m:fPr><m:num>...</m:t>). We must NOT encode
		// those structural < > or we permanently destroy the OMML structure.
		// However, literal math symbols like < (less-than) and > (greater-than)
		// MUST be encoded or the XML is invalid and Word refuses to open the file.
		//
		// Strategy: split the <m:t> content by XML tag patterns and only escape
		// the TEXT NODE portions (non-tag parts). XML tags (substrings matching
		// /<[^>]*>/) are left verbatim; only plain text between/around tags is
		// entity-encoded. This handles both "a < b" math text and embedded XML.
		return clean.replace(/(<(?:m|w):t[^>]*>)([\s\S]*?)(<\/(?:m|w):t>)/g, (match, open, content, close) => {
			// Split content into alternating [text, tag, text, tag, ...] chunks.
			const parts = content.split(/(<[^>]*>)/);
			const fixed = parts.map((part, i) => {
				if (i % 2 === 1) return part; // odd indices are XML tags — leave intact
				// Even indices are text nodes — escape &, <, > in order
				return part
					.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9a-fA-F]+;)/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;');
			}).join('');
			return open + fixed + close;
		});
	}

	try {
		const omml = await latexToOMML(primarySrc, { displayMode });
		return sanitizeOmml(omml);
	} catch (err) {
		const hasAmp = preprocessed.includes("&");
		const msg = String(err && err.message ? err.message : err).toLowerCase();

		if (hasAmp || msg.includes('misplaced &')) {
			try {
				const wrapped = `\\begin{aligned}${preprocessed}\\end{aligned}`;
				return sanitizeOmml(await latexToOMML(wrapped, { displayMode }));
			} catch (e2) { }

			try {
				const escaped = preprocessed.replace(/&/g, '\\&');
				return sanitizeOmml(await latexToOMML(escaped, { displayMode }));
			} catch (e3) { }

			// If the content has literal "|" delimiters still present at this point
			// (e.g. wrapBareMatrix didn't catch it), try vmatrix first so a
			// determinant gets proper stretching bars instead of plain pipe glyphs.
			if (/(?<!\\)\|/.test(preprocessed)) {
				try {
					const stripped = preprocessed.replace(/(?<!\\)\|/g, '');
					const vmatrixed = `\\begin{vmatrix}${stripped}\\end{vmatrix}`;
					return sanitizeOmml(await latexToOMML(vmatrixed, { displayMode }));
				} catch (e4v) { }
			}

			try {
				const matrixed = `\\begin{pmatrix}${preprocessed}\\end{pmatrix}`;
				return sanitizeOmml(await latexToOMML(matrixed, { displayMode }));
			} catch (e4) {
				console.warn('[latexToOmmlWrapped] fallbacks failed:', e4 && e4.message ? e4.message : e4);
			}
		}

		return latexFallbackRun(preprocessed);
	}
}

async function processParagraph(paraXml) {
	const paraStr = String(paraXml || "");
	if (!paraStr.includes("$")) return paraXml;
	// Skip paragraphs that already contain OMML equations (<m:oMath).
	// These were already processed by latexToOmmlWrapped/sanitizeOmml and their
	// m:t / w:t content may legitimately contain $ chars inside math text nodes.
	// Running extractRunTextFull + splitMath on them would corrupt the
	// interleaved OMML+text structure irreversibly.
	if (paraStr.includes('<m:oMath')) return paraXml;

	const pOpen = String(paraXml).match(/<w:p\b[^>]*>/);
	const pOpenTag = pOpen ? pOpen[0] : "<w:p>";
	const inner = String(paraXml).slice(pOpenTag.length, -6);
	const runs = [...inner.matchAll(/<w:r\b[^>]*>.*?<\/w:r>/gs)];
	if (!runs.length) return paraXml;

	// Use fullyDecodeXml so &#39; &#34; and other numeric char refs are decoded
	// before splitMath, and then correctly re-encoded by encodeRunText.
	// The old extractTextFromRun used decodeXml which missed &#NNN; refs, causing
	// encodeRunText to encode the & in &#39; -> &amp;#39; (corrupt XML).
	function extractRunTextFull(runXml) {
		const texts = [...String(runXml || "").matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gs)]
			.map((m) => fullyDecodeXml(m[1]));
		return texts.join("");
	}

	const allText = runs.map((r) => extractRunTextFull(r[0])).join("");
	if (!allText.includes("$")) return paraXml;

	// Build a character-position → run-rPr map so each non-math text fragment
	// keeps the formatting of the ORIGINAL run it came from. Previously the very
	// first run's rPr (e.g. the bold "Q1." label) was forced onto every fragment,
	// which made entire questions appear bold whenever they contained $math$.
	const runTexts = [];
	const rprByPos = []; // rprByPos[i] = rPr string that applies to character i of mergedText
	let firstRpr = "";
	for (const r of runs) {
		const t = extractRunTextFull(r[0]);
		const rpr = extractRprFromRun(r[0]);
		if (!firstRpr) firstRpr = rpr;
		runTexts.push(t);
		for (let k = 0; k < t.length; k++) rprByPos.push(rpr);
	}

	const mergedText = runTexts.join("");
	const parts = splitMath(mergedText);
	if (!parts.some((part) => part.isMath)) return paraXml;

	// Encode raw XML text-node content safely.
	// Use &#39; for apostrophe (numeric ref) — safer than &apos; which some
	// older Word versions reject in text nodes.
	function encodeRunText(s) {
		return String(s)
			.replace(/&/g, "&amp;")   // MUST be first
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	let newRunsXml = "";
	let cursor = 0; // position within mergedText
	for (const part of parts) {
		const partContent = String(part.content || "");
		const partLen = partContent.length;
		if (!partContent) { cursor += partLen; continue; }
		if (part.isMath) {
			const innerOmml = await latexToOmmlWrapped(part.content, part.display);
			newRunsXml += innerOmml;
		} else {
			// A non-math fragment can span several original runs with DIFFERENT formatting
			// (e.g. the bold "Q1." run immediately followed by the normal question-text run).
			// Walk the fragment character-by-character and start a new <w:r> whenever the
			// underlying run's rPr changes, so each piece keeps its original formatting.
			let segStart = 0;
			for (let k = 1; k <= partLen; k++) {
				const prevRpr = rprByPos[cursor + k - 1] !== undefined ? rprByPos[cursor + k - 1] : firstRpr;
				const curRpr = k < partLen && rprByPos[cursor + k] !== undefined ? rprByPos[cursor + k] : null;
				if (k === partLen || curRpr !== prevRpr) {
					const segText = partContent.slice(segStart, k);
					const spaceAttr = segText.startsWith(" ") || segText.endsWith(" ") ? ' xml:space="preserve"' : "";
					newRunsXml += `<w:r>${prevRpr}<w:t${spaceAttr}>${encodeRunText(segText)}</w:t></w:r>`;
					segStart = k;
				}
			}
		}
		cursor += partLen;
	}

	const firstRunStart = runs[0].index;
	const lastRunEnd = runs[runs.length - 1].index + runs[runs.length - 1][0].length;
	return pOpenTag + inner.slice(0, firstRunStart) + newRunsXml + inner.slice(lastRunEnd) + "</w:p>";
}

async function processDocxXml(docXml) {
	const matches = [...String(docXml || "").matchAll(/<w:p\b[^>]*>.*?<\/w:p>/gs)];
	if (!matches.length) return docXml;

	let result = "";
	let lastIndex = 0;
	for (const match of matches) {
		result += docXml.slice(lastIndex, match.index);
		result += await processParagraph(match[0]);
		lastIndex = match.index + match[0].length;
	}
	result += docXml.slice(lastIndex);
	return result;
}

function decodeXml(text) {
	return String(text || "")
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

// Fully decode ALL XML/HTML entities including numeric char refs like &#39; &#34;
// The docx library emits &#39; for apostrophes; decodeXml misses those, causing
// encodeRunText to encode the & in &#39; -> &amp;#39; (corrupt XML).
// &amp; MUST be decoded last to avoid turning &amp;lt; into < prematurely.
function fullyDecodeXml(text) {
	return String(text || "")
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&#34;/g, '"')
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&amp;/g, "&");  // MUST be last
}

async function zipToEntries(buffer) {
	const zip = await JSZip.loadAsync(buffer);
	const entries = {};
	for (const [name, file] of Object.entries(zip.files)) {
		if (file.dir) continue;
		entries[name] = await file.async("nodebuffer");
	}
	return entries;
}

async function entriesToZipBuffer(entries) {
	const zip = new JSZip();
	for (const [name, data] of Object.entries(entries)) {
		zip.file(name, data);
	}
	return zip.generateAsync({
		type: "nodebuffer",
		compression: "DEFLATE",
		compressionOptions: { level: 6 },
	});
}

/**
 * Replace placeholder tokens in template XML with live headerMeta values.
 * Edit your Word template to contain these exact placeholder strings in the
 * relevant text boxes / paragraphs:
 *   {{SUBJECT}}   -> replaced with paperSubject  (e.g. "PHYSICS")
 *   {{CHAPTER}}   -> replaced with paperChapter  (e.g. "RAY OPTICS")
 *   {{TEST_TYPE}} -> replaced with paperTestType (e.g. "CHAPTER TEST")
 *   {{CLASS}}     -> replaced with paperClass    (e.g. "12")
 *   {{TITLE}}     -> replaced with paperTitle    (e.g. "Question Paper")
 * Works on body XML, headers, and footers.
 */
function applyHeaderMetaToXml(xml, headerMeta) {
	if (!headerMeta || typeof xml !== "string") return xml;
	console.log("[applyHeaderMetaToXml] headerMeta:", JSON.stringify(headerMeta));
	// Also encode ' and " to prevent attribute injection via headerMeta values
	const encode = (s) => String(s || "")
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;").replace(/'/g, "&#39;");

	const splitChapter = splitTextIntoTwoLines(headerMeta.chapter || '');
	const splitTitle = splitTextIntoTwoLines(headerMeta.title || '');

	// Word sometimes splits placeholder text like {{SUBJECT}} across multiple <w:r> runs,
	// e.g. <w:r>...<w:t>{{SUB</w:t></w:r><w:r>...<w:t>JECT}}</w:t></w:r>.
	// A simple replaceAll() won't find them. Fix: collapse adjacent <w:t> text nodes
	// within the same paragraph so placeholders survive the split.
	// Strategy: merge contiguous runs that share identical <w:rPr> (or both lack one)
	// and whose concatenated text contains a placeholder pattern.
	// Simpler reliable approach: extract all <w:t> text, merge within each <w:p>,
	// do replacement, then re-emit as a single run per paragraph segment.
	// Because this is template XML (not the generated questions), it's safe to do
	// a lightweight XML-text-level merge just for placeholder detection.

	// Step 1: within each paragraph, concatenate all <w:t> inner text and check for
	// placeholder patterns split across runs. If found, replace by rewriting the para
	// as a single merged run containing the full text with placeholders substituted.
	// We only touch paragraphs that actually contain a partial or complete placeholder.
	const placeholderRe = /\{\{(?:SUBJECT|CHAPTER|TEST_TYPE|CLASS|TITLE)\}\}/;
	const partialRe = /\{\{[A-Z_]*$|^[A-Z_]*\}\}/; // partial at run boundaries

	// Merge <w:t> text across runs within the same <w:p> to handle split placeholders.
	// Replace each <w:p>...</w:p> that contains a (possibly split) placeholder.
	xml = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paraXml) => {
		// Collect all run texts joined together
		const runTexts = [...paraXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m => m[1]);
		const joined = runTexts.join('');
		// Only process paragraphs that contain placeholder text (possibly split)
		if (!joined.includes('{{')) return paraXml;

		// Extract the first run's rPr to re-use for the merged run
		const rPrMatch = paraXml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
		let rPr = rPrMatch ? `<w:rPr>${rPrMatch[1]}</w:rPr>` : '';

		// Replace placeholder tokens in the joined text
		let replaced = joined
			.replaceAll('{{SUBJECT}}', encode(headerMeta.subject))
			.replaceAll('{{CHAPTER}}', encode(splitChapter))
			.replaceAll('{{TEST_TYPE}}', encode(headerMeta.testType))
			.replaceAll('{{CLASS}}', encode(headerMeta.class))
			.replaceAll('{{TITLE}}', encode(splitTitle));

		// Rebuild: keep <w:pPr> intact, replace all runs with merged run(s).
		const pPrMatch = paraXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
		const pPr = pPrMatch ? pPrMatch[0] : '';
		const pOpenMatch = paraXml.match(/^<w:p\b[^>]*>/);
		const pOpen = pOpenMatch ? pOpenMatch[0] : '<w:p>';

		let mergedRun = '';
		if (replaced.includes('\n')) {
			const lines = replaced.split('\n');
			mergedRun = `<w:r>${rPr}`;
			for (let i = 0; i < lines.length; i++) {
				if (i > 0) {
					mergedRun += '<w:br/>';
				}
				const spaceAttr = lines[i].startsWith(' ') || lines[i].endsWith(' ') ? ' xml:space="preserve"' : '';
				mergedRun += `<w:t${spaceAttr}>${lines[i]}</w:t>`;
			}
			mergedRun += `</w:r>`;
		} else {
			const spaceAttr = replaced.startsWith(' ') || replaced.endsWith(' ') ? ' xml:space="preserve"' : '';
			mergedRun = `<w:r>${rPr}<w:t${spaceAttr}>${replaced}</w:t></w:r>`;
		}

		return `${pOpen}${pPr}${mergedRun}</w:p>`;
	});

	const formatPlaceholderForXml = (text) => {
		const encoded = encode(text);
		if (encoded.includes('\n')) {
			return encoded.split('\n').join('</w:t><w:br/><w:t xml:space="preserve">');
		}
		return encoded;
	};

	// Step 2: also handle any remaining non-split placeholders (e.g. in non-paragraph nodes
	// like text boxes, or paragraphs that weren't merged above for some reason).
	// Guard each replacement with an includes() check: Step 1 already consumed all {{
	// in paragraphs it rebuilt, so these replaceAll calls only fire on genuine remaining
	// occurrences — preventing any risk of double-processing already-encoded XML.
	let result = xml;
	if (result.includes("{{SUBJECT}}")) result = result.replaceAll("{{SUBJECT}}", encode(headerMeta.subject));
	if (result.includes("{{CHAPTER}}")) result = result.replaceAll("{{CHAPTER}}", formatPlaceholderForXml(splitChapter));
	if (result.includes("{{TEST_TYPE}}")) result = result.replaceAll("{{TEST_TYPE}}", encode(headerMeta.testType));
	if (result.includes("{{CLASS}}")) result = result.replaceAll("{{CLASS}}", encode(headerMeta.class));
	if (result.includes("{{TITLE}}")) result = result.replaceAll("{{TITLE}}", formatPlaceholderForXml(splitTitle));

	if (headerMeta.mode && headerMeta.mode !== "question") {
		result = result.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paraXml) => {
			const runTexts = [...paraXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m => m[1]);
			const joinedText = runTexts.join('');
			if (/name\s+of\s+student|student\'?s?\s+name/i.test(joinedText)) {
				console.log(`[applyHeaderMetaToXml] Clearing student name paragraph runs (mode: ${headerMeta.mode})`);
				return paraXml.replace(/<w:t[^>]*>[\s\S]*?<\/w:t>/g, (tTag) => {
					const openTagMatch = tTag.match(/^<w:t\b[^>]*>/);
					const openTag = openTagMatch ? openTagMatch[0] : '<w:t>';
					return `${openTag}</w:t>`;
				});
			}
			return paraXml;
		});
	}

	return result;
}

async function mergeWithTemplate(genEntries, tplEntries, headerMeta) {
	const merged = { ...genEntries };

	for (const name of [
		"word/styles.xml",
		"word/settings.xml",
		"word/fontTable.xml",
		"word/theme/theme1.xml",
		"word/theme/theme2.xml",
		"word/webSettings.xml",
	]) {
		if (tplEntries[name]) merged[name] = tplEntries[name];
	}

	for (const [name, data] of Object.entries(tplEntries)) {
		if (name.startsWith("word/header") || name.startsWith("word/footer") || name.startsWith("word/media/")) {
			merged[name] = data;
		}
	}

	const relsKey = "word/_rels/document.xml.rels";
	let idRemap = {};
	if (tplEntries[relsKey] && merged[relsKey]) {
		let tplRelsXml = tplEntries[relsKey].toString("utf8");
		let genRelsXml = merged[relsKey].toString("utf8");
		const genUsedIds = new Set([...genRelsXml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])));
		let nextFree = Math.max(0, ...genUsedIds) + 1;
		const keepTypes = ["header", "footer", "image", "Image", "Header", "Footer"];
		const tplRels = tplRelsXml.match(/<Relationship\b[^>]*\/>/g) || [];
		const newRelTags = [];

		for (let relTag of tplRels) {
			const typeMatch = relTag.match(/Type="([^"]+)"/);
			const idMatch = relTag.match(/Id="([^"]+)"/);
			if (!typeMatch || !idMatch) continue;
			if (!keepTypes.some((k) => typeMatch[1].includes(k))) continue;

			const oldId = idMatch[1];
			const numMatch = oldId.match(/^rId(\d+)$/);
			if (numMatch && genUsedIds.has(Number(numMatch[1]))) {
				const newId = `rId${nextFree++}`;
				idRemap[oldId] = newId;
				relTag = relTag.replace(`Id="${oldId}"`, `Id="${newId}"`);
			} else if (numMatch) {
				genUsedIds.add(Number(numMatch[1]));
			}
			newRelTags.push(relTag);
		}

		if (newRelTags.length) {
			genRelsXml = genRelsXml.replace('</Relationships>', () => `\n${newRelTags.join('\n')}\n</Relationships>`);
			merged[relsKey] = Buffer.from(genRelsXml, 'utf8');
		}

		if (Object.keys(idRemap).length) {
			for (const name of Object.keys(merged)) {
				if (!name.startsWith("word/header") && !name.startsWith("word/footer")) continue;
				let xml = merged[name].toString('utf8');
				for (const [oldId, newId] of Object.entries(idRemap)) {
					xml = xml.replaceAll(`r:id="${oldId}"`, `r:id="${newId}"`);
					xml = xml.replaceAll(`r:embed="${oldId}"`, `r:embed="${newId}"`);
				}
				merged[name] = Buffer.from(xml, 'utf8');
			}
		}
	}

	// Apply {{SUBJECT}}, {{CHAPTER}}, {{TEST_TYPE}}, {{CLASS}}, {{TITLE}} placeholders
	// to ALL header and footer files (even those not remapped above).
	if (headerMeta) {
		for (const name of Object.keys(merged)) {
			if (!name.startsWith("word/header") && !name.startsWith("word/footer")) continue;
			const xml = merged[name].toString('utf8');
			merged[name] = Buffer.from(applyHeaderMetaToXml(xml, headerMeta), 'utf8');
		}
	}

	for (const [name, data] of Object.entries(tplEntries)) {
		if (/word\/_rels\/(header|footer)\d*\.xml\.rels$/.test(name)) merged[name] = data;
	}

	// Single-pass document.xml merge: apply template sectPr + optional template body
	// content in one operation so the document is only rewritten once and sectPr
	// cannot be injected twice (which produced corrupt XML that Word refused to open).
	if (tplEntries["word/document.xml"] && merged["word/document.xml"]) {
		const tplDoc = tplEntries["word/document.xml"].toString('utf8');
		// Read the current (already OMML-processed) generated document
		let genDoc = merged["word/document.xml"].toString('utf8');

		// ── Step A: transplant the template's <w:sectPr> (page size, margins,
		//   headers/footers references) into the generated document. ────────────
		const tplSecprMatch = tplDoc.match(/<w:sectPr\b.*?<\/w:sectPr>/s);
		if (tplSecprMatch) {
			let tplSecpr = tplSecprMatch[0];
			// Remap any relationship IDs that were renumbered to avoid collisions
			if (Object.keys(idRemap || {}).length) {
				for (const [oldId, newId] of Object.entries(idRemap)) {
					tplSecpr = tplSecpr.replaceAll(`r:id="${oldId}"`, `r:id="${newId}"`);
				}
			}
			if (/<w:sectPr\b/.test(genDoc)) {
				genDoc = genDoc.replace(/<w:sectPr\b.*?<\/w:sectPr>/s, () => tplSecpr);
			} else {
				genDoc = genDoc.replace('</w:body>', () => `${tplSecpr}\n</w:body>`);
			}
		}

		// ── Step B: if the template has real body content (e.g. a letterhead
		//   paragraph), insert it after the generated header but before the
		//   questions, so the user's subject / chapter / class fields remain
		//   visible instead of being replaced by the template. ─────────────
		const bodyMatch = tplDoc.match(/<w:body>(.*?)<\/w:body>/s);
		if (bodyMatch) {
			let tplBodyNoSecpr = bodyMatch[1].replace(/<w:sectPr\b.*?<\/w:sectPr>/gs, '').trim();
			const hasRealContent = /<w:t[^>]*>[^<]+<\/w:t>/.test(tplBodyNoSecpr);
			if (hasRealContent && tplBodyNoSecpr) {
				const genBodyMatch = genDoc.match(/<w:body>(.*?)<\/w:body>/s);
				if (genBodyMatch) {
					const genBodyContent = genBodyMatch[1];
					// Find the §§QS_MARKER§§ marker inserted by buildPaperDoc.
					// Split: header (everything before the marker para) | template body | questions (after the marker para)
					const qsMarkerPattern = /<w:t[^>]*>§§QS_MARKER§§<\/w:t>/;
					const markerMatch = genBodyContent.match(qsMarkerPattern);
					if (markerMatch) {
						const beforeMarker = genBodyContent.slice(0, markerMatch.index);
						// Use a regex to find the last <w:p> or <w:p ...> tag, but NOT <w:pPr> or other <w:p*> tags.
						// lastIndexOf('<w:p') is too broad — it also matches <w:pPr>, causing the marker
						// paragraph's opening <w:p> tag to be included in genBeforeMarker, which produces
						// invalid/uncorrupted XML (unclosed <w:p>) in the final merged document.
						const lastOpenPMatch = [...beforeMarker.matchAll(/<w:p[\s>]/g)].pop();
						const lastOpenP = lastOpenPMatch ? lastOpenPMatch.index : -1;
						const pClose = markerMatch.index + markerMatch[0].length;
						const restAfterMarker = genBodyContent.slice(pClose);
						const pEnd = restAfterMarker.indexOf('</w:p>');
						if (lastOpenP !== -1 && pEnd !== -1) {
							const markerPEnd = pClose + pEnd + 6; // +6 for '</w:p>'
							// genBeforeMarker (the generated title/class/date/name rows) is intentionally
							// DISCARDED when the template supplies its own body content. Keeping it caused
							// a duplicate header: the generated rows (with unresolved placeholder text)
							// appeared above the template rows (with the real subject/chapter/logo).
							// The template body with {{placeholders}} replaced is now the sole header.
							const genAfterMarker = genBodyContent.slice(markerPEnd);    // questions / answer key
							if (Object.keys(idRemap || {}).length) {
								for (const [oldId, newId] of Object.entries(idRemap)) {
									tplBodyNoSecpr = tplBodyNoSecpr.replaceAll(`r:embed="${oldId}"`, `r:embed="${newId}"`);
									tplBodyNoSecpr = tplBodyNoSecpr.replaceAll(`r:id="${oldId}"`, `r:id="${newId}"`);
								}
							}
							// Replace {{SUBJECT}}, {{CHAPTER}}, {{TEST_TYPE}}, {{CLASS}}, {{TITLE}}
							// placeholders in the template body with the user-supplied values.
							tplBodyNoSecpr = applyHeaderMetaToXml(tplBodyNoSecpr, headerMeta);
							// Template body is the sole header — generated header is not prepended.
							const newBody = `${tplBodyNoSecpr}\n${genAfterMarker}`;
							// Validate that genBodyMatch[0] exists in genDoc before replacing
							if (genDoc.includes(genBodyMatch[0])) {
								genDoc = genDoc.replace(genBodyMatch[0], () => `<w:body>${newBody}</w:body>`);
							} else {
								console.error("[mergeWithTemplate] BODY MISMATCH — genBodyMatch[0] not found in genDoc");
							}
						} else {
							console.error("[mergeWithTemplate] MARKER FAIL — lastOpenP:", lastOpenP, "pEnd:", pEnd);
						}
					} else {
						console.error("[mergeWithTemplate] MARKER NOT FOUND in body content");
					}
				}
			}
		}

		// Commit the single final rewrite
		if (!/<w:body>[\s\S]*<\/w:body>/.test(genDoc)) {
			console.error("[mergeWithTemplate] CORRUPTED body: missing <w:body> tags");
		}
		const bodyCount = (genDoc.match(/<\/w:body>/g) || []).length;
		if (bodyCount !== 1) {
			console.error("[mergeWithTemplate] CORRUPTED body: found", bodyCount, "</w:body> tags");
		}
		merged["word/document.xml"] = Buffer.from(genDoc, 'utf8');
	}

	const ctKey = "[Content_Types].xml";
	if (tplEntries[ctKey] && merged[ctKey]) {
		const tplCt = tplEntries[ctKey].toString('utf8');
		let genCt = merged[ctKey].toString('utf8');
		const genParts = new Set([...genCt.matchAll(/PartName="([^"]+)"/g)].map((m) => m[1]));
		const genExts = new Set([...genCt.matchAll(/Extension="([^"]+)"/g)].map((m) => m[1]));
		const newItems = [];
		for (const ov of tplCt.match(/<Override\b[^>]*\/>/g) || []) {
			const pnMatch = ov.match(/PartName="([^"]+)"/);
			if (pnMatch && !genParts.has(pnMatch[1])) {
				newItems.push(ov);
				genParts.add(pnMatch[1]);
			}
		}
		for (const dv of tplCt.match(/<Default\b[^>]*\/>/g) || []) {
			const extMatch = dv.match(/Extension="([^"]+)"/);
			if (extMatch && !genExts.has(extMatch[1])) {
				newItems.push(dv);
				genExts.add(extMatch[1]);
			}
		}
		if (newItems.length) {
			genCt = genCt.replace('</Types>', () => `\n${newItems.join('\n')}\n</Types>`);
			merged[ctKey] = Buffer.from(genCt, 'utf8');
		}
	}

	return merged;
}

async function postProcessDocx(generatedBuf, templateBase64, headerMeta) {
	console.log("[postProcessDocx] START — node converter");
	try {
		// Always run LaTeX→OMML conversion regardless of whether a template is used,
		// so equations render correctly in both the Word download and PDF export.
		let entries = await zipToEntries(generatedBuf);

		if (entries["word/document.xml"]) {
			let docXml = entries["word/document.xml"].toString("utf8");
			docXml = await processDocxXml(docXml);
			// Always ensure xmlns:m is declared on <w:document> so that any m: prefixed
			// OMML elements (injected by sanitizeOmml above) are always valid.
			// We must check specifically on the <w:document> tag — not elsewhere in the
			// document (e.g. on <m:oMath> elements) — because Word requires the namespace
			// declaration on the root element.
			const docTag = docXml.match(/<w:document\b[^>]*>/);
			if (docTag && !docTag[0].includes('xmlns:m=')) {
				docXml = docXml.replace('<w:document', '<w:document xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"');
			}
			entries["word/document.xml"] = Buffer.from(docXml, "utf8");
		}

		if (templateBase64) {
			const tplEntries = await zipToEntries(Buffer.from(templateBase64, "base64"));
			entries = await mergeWithTemplate(entries, tplEntries, headerMeta);
		}

		const output = await entriesToZipBuffer(entries);
		console.log(`[postProcessDocx] SUCCESS — output size: ${output.length} bytes`);
		return output;
	} catch (e) {
		console.error("postProcessDocx failed:", e.message);
		return generatedBuf;
	}
}

// ── Progress tracking for paper generation ─────────────────────────────────
// This used to be a plain `global.paperGenProgress` object. That silently breaks
// the moment you run more than one instance (or cluster worker): the browser
// polls /progress/:id, the load balancer sends it to a pod that never ran the
// job, and the UI hangs on a 404 forever.
//
// `progress` keeps the exact same synchronous object API but mirrors every write
// to Redis, so any pod can answer the poll. Falls back to pure in-memory when
// REDIS_URL isn't set (single-instance behaviour, identical to before).
const { progress, getProgress, clearProgress } = require("../utils/progressStore");
const { enqueue } = require("../utils/queue");

// Keep the old global name pointing at the shared store so existing call sites
// inside this file keep working unchanged.
global.paperGenProgress = progress;

// Asynchronous background generator for Word documents (DOCX)
async function generatePaperDocxBackground(progressId, body, instId) {
	const update = (pct, step, status = "running") => {
		if (global.paperGenProgress[progressId]) {
			global.paperGenProgress[progressId].pct = pct;
			global.paperGenProgress[progressId].currentStep = step;
			global.paperGenProgress[progressId].status = status;
		}
	};

	try {
		const { questions, paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId } = body || {};
		if (!Array.isArray(questions) || !questions.length) {
			throw new Error("No questions provided");
		}

		const title = String(paperTitle || "Question Paper").trim();
		const headerMeta = {
			subject: String(paperSubject || '').trim(),
			chapter: String(paperChapter || '').trim(),
			testType: String(paperTestType || '').trim(),
			class: String(paperClass || '').trim(),
		};
		const normalizedQuestions = normalizePaperQuestions(questions);

		// Yield to event loop to keep polling responsive
		await new Promise(resolve => setImmediate(resolve));

		// Step 1: Build question paper
		update(15, "build");
		const qBufRaw = await buildPaperDoc(normalizedQuestions, "question", title, headerMeta);
		await new Promise(resolve => setImmediate(resolve));

		// Step 2: Build answer key
		update(30, "build");
		const akBufRaw = await buildPaperDoc(normalizedQuestions, "answerkey", `${title} – Answer Key`, headerMeta);
		await new Promise(resolve => setImmediate(resolve));

		// Step 3: Build solutions
		update(45, "build");
		const solBufRaw = await buildPaperDoc(normalizedQuestions, "solution", `${title} – Solutions`, headerMeta);
		await new Promise(resolve => setImmediate(resolve));

		// Fetch template if requested
		let tplBase64 = null;
		if (templateId) {
			let tplSql, tplArgs;
			if (instId) {
				tplSql = "SELECT docx_base64 FROM paper_templates WHERE id = ? AND (institute_id = ? OR institute_id IS NULL)";
				tplArgs = [Number(templateId), instId];
			} else {
				tplSql = "SELECT docx_base64 FROM paper_templates WHERE id = ?";
				tplArgs = [Number(templateId)];
			}
			const tplRow = await db.execute({ sql: tplSql, args: tplArgs });
			if (tplRow.rows.length) tplBase64 = tplRow.rows[0].docx_base64;
		}
		await new Promise(resolve => setImmediate(resolve));

		headerMeta.title = title;

		// Step 4: LaTeX / Template process for Question Paper
		update(60, "latex");
		const qBuf = await postProcessDocx(qBufRaw, tplBase64, { ...headerMeta, mode: "question" });
		await new Promise(resolve => setImmediate(resolve));

		// Step 5: LaTeX / Template process for Answer Key
		update(75, "template");
		const akBuf = await postProcessDocx(akBufRaw, tplBase64, { ...headerMeta, mode: "answerkey" });
		await new Promise(resolve => setImmediate(resolve));

		// Step 6: LaTeX / Template process for Solutions
		update(90, "finalise");
		const solBuf = await postProcessDocx(solBufRaw, tplBase64, { ...headerMeta, mode: "solution" });
		await new Promise(resolve => setImmediate(resolve));

		update(100, "finalise");

		if (global.paperGenProgress[progressId]) {
			global.paperGenProgress[progressId].status = "completed";
			global.paperGenProgress[progressId].files = {
				questionPaper: qBuf.toString("base64"),
				answerKey: akBuf.toString("base64"),
				solutions: solBuf.toString("base64"),
			};
		}
	} catch (e) {
		console.error("generatePaperDocxBackground error:", e);
		if (global.paperGenProgress[progressId]) {
			global.paperGenProgress[progressId].status = "failed";
			global.paperGenProgress[progressId].error = e.message || "Failed to generate paper";
		}
	}
}

// Asynchronous background generator for PDF documents
async function generatePaperPdfBackground(progressId, body, instId) {
	const update = (pct, step, status = "running") => {
		if (global.paperGenProgress[progressId]) {
			global.paperGenProgress[progressId].pct = pct;
			global.paperGenProgress[progressId].currentStep = step;
			global.paperGenProgress[progressId].status = status;
		}
	};

	try {
		const { questions, paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId } = body || {};
		if (!Array.isArray(questions) || !questions.length) {
			throw new Error("No questions provided");
		}

		const title = String(paperTitle || "Question Paper").trim();
		const headerMeta = {
			subject: String(paperSubject || '').trim(),
			chapter: String(paperChapter || '').trim(),
			testType: String(paperTestType || '').trim(),
			class: String(paperClass || '').trim(),
		};
		const normalizedQuestions = normalizePaperQuestions(questions);

		await new Promise(resolve => setImmediate(resolve));

		// Step 1: Build question paper DOCX
		update(10, "build");
		const qBufRaw = await buildPaperDoc(normalizedQuestions, "question", title, headerMeta);
		await new Promise(resolve => setImmediate(resolve));

		// Step 2: Build answer key DOCX
		update(20, "build");
		const akBufRaw = await buildPaperDoc(normalizedQuestions, "answerkey", `${title} \u2013 Answer Key`, headerMeta);
		await new Promise(resolve => setImmediate(resolve));

		// Step 3: Build solutions DOCX
		update(30, "build");
		const solBufRaw = await buildPaperDoc(normalizedQuestions, "solution", `${title} \u2013 Solutions`, headerMeta);
		await new Promise(resolve => setImmediate(resolve));

		// Fetch template
		let tplBase64 = null;
		if (templateId) {
			let tplSql, tplArgs;
			if (instId) {
				tplSql = "SELECT docx_base64 FROM paper_templates WHERE id = ? AND (institute_id = ? OR institute_id IS NULL)";
				tplArgs = [Number(templateId), instId];
			} else {
				tplSql = "SELECT docx_base64 FROM paper_templates WHERE id = ?";
				tplArgs = [Number(templateId)];
			}
			const tplRow = await db.execute({ sql: tplSql, args: tplArgs });
			if (tplRow.rows.length) tplBase64 = tplRow.rows[0].docx_base64;
		}
		await new Promise(resolve => setImmediate(resolve));

		headerMeta.title = title;

		// Step 4: LaTeX / Template process for Question Paper
		update(35, "latex");
		const qBuf = await postProcessDocx(qBufRaw, tplBase64, { ...headerMeta, mode: "question" });
		await new Promise(resolve => setImmediate(resolve));

		// Step 5: LaTeX / Template process for Answer Key
		update(40, "template");
		const akBuf = await postProcessDocx(akBufRaw, tplBase64, { ...headerMeta, mode: "answerkey" });
		await new Promise(resolve => setImmediate(resolve));

		// Step 6: LaTeX / Template process for Solutions
		update(45, "finalise");
		const solBuf = await postProcessDocx(solBufRaw, tplBase64, { ...headerMeta, mode: "solution" });
		await new Promise(resolve => setImmediate(resolve));

		// Steps 7-8: render each DOCX to PDF one at a time. Each buffer is turned
		// into base64 and released immediately - holding three DOCX buffers plus
		// three PDF buffers plus their base64 copies at once is what used to push
		// the process over its heap limit (the job then vanished and the browser
		// saw "Progress session not found or expired").
		const renderOne = async (buf, label) => {
			try {
				const pdf = await docxToPdf(buf);
				if (!pdf || !pdf.length) throw new Error("empty PDF");
				const b64 = pdf.toString("base64");
				return b64;
			} catch (err) {
				throw new Error(`Could not render the ${label} PDF: ${err && err.message ? err.message : err}`);
			}
		};

		update(50, "pdf_questions");
		const qPdf64 = await renderOne(qBuf, "question paper");
		await new Promise(resolve => setImmediate(resolve));

		update(65, "pdf_questions");
		const akPdf64 = await renderOne(akBuf, "answer key");
		await new Promise(resolve => setImmediate(resolve));

		update(75, "pdf_solutions");
		const solPdf64 = await renderOne(solBuf, "solutions");
		await new Promise(resolve => setImmediate(resolve));

		update(100, "finalise");

		if (global.paperGenProgress[progressId]) {
			global.paperGenProgress[progressId].status = "completed";
			global.paperGenProgress[progressId].files = {
				questionPaper: qPdf64,
				answerKey: akPdf64,
				solutions: solPdf64,
			};
		}
	} catch (e) {
		console.error("generatePaperPdfBackground error:", e);
		if (global.paperGenProgress[progressId]) {
			global.paperGenProgress[progressId].status = "failed";
			global.paperGenProgress[progressId].error = e.message || "Failed to generate PDF";
		}
	}
}

// POST /api/admin/generate-paper/start
// Paper generation blocks the event loop for SECONDS (docx build + image work).
// If a worker tier is available we hand the job off so the API pod stays free to
// serve students; otherwise we run it in-process exactly as before.
router.post("/api/admin/generate-paper/start", requireAdmin, requireFeature("paperGenerator"), async (req, res) => {
	const progressId = "docx_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
	const instId = sessionInstituteId(req);
	global.paperGenProgress[progressId] = {
		pct: 0,
		status: "starting",
		currentStep: "build",
		createdAt: Date.now(),
	};

	const queued = await enqueue("paper-docx", { progressId, body: req.body, instId });
	if (!queued) generatePaperDocxBackground(progressId, req.body, instId);

	res.json({ success: true, progressId, queued });
});

// POST /api/admin/generate-paper-pdf/start
router.post("/api/admin/generate-paper-pdf/start", requireAdmin, requireFeature("paperGenerator"), async (req, res) => {
	const progressId = "pdf_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
	const instId = sessionInstituteId(req);
	global.paperGenProgress[progressId] = {
		pct: 0,
		status: "starting",
		currentStep: "build",
		createdAt: Date.now(),
	};

	const queued = await enqueue("paper-pdf", { progressId, body: req.body, instId });
	if (!queued) generatePaperPdfBackground(progressId, req.body, instId);

	res.json({ success: true, progressId, queued });
});

// GET /api/admin/generate-paper/progress/:progressId
// Reads local state first, then Redis — so the poll works even when the job is
// running on a different API pod or on the worker tier.
router.get("/api/admin/generate-paper/progress/:progressId", requireAdmin, async (req, res) => {
	const progressId = req.params.progressId;
	const job = await getProgress(progressId);
	if (!job) {
		return res.status(404).json({
			success: false,
			error: "Progress session not found or expired",
			hint: "The generation job is no longer on this server. It either finished more than an hour ago or the server restarted mid-render (usually memory pressure on a very large paper).",
		});
	}

	if (job.status === "completed" || job.status === "failed") {
		setTimeout(() => {
			clearProgress(progressId).catch(() => {});
		}, 60000).unref?.(); // Clean up after 1 minute
	}

	res.json({ success: true, progress: job });
});


// POST /api/admin/generate-paper
// Body: { questions: [...], paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId? }
// Returns: JSON with base64-encoded buffers for question, answerkey, solution docx
router.post("/api/admin/generate-paper", requireAdmin, requireFeature("paperGenerator"), async (req, res) => {
	try {
		const { questions, paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId } = req.body || {};
		if (!Array.isArray(questions) || !questions.length) {
			return res.status(400).json({ error: "No questions provided" });
		}

		const title = String(paperTitle || "Question Paper").trim();
		const headerMeta = {
			subject: String(paperSubject || '').trim(),
			chapter: String(paperChapter || '').trim(),
			testType: String(paperTestType || '').trim(),
			class: String(paperClass || '').trim(),
		};
		const normalizedQuestions = normalizePaperQuestions(questions);

		// Build raw DOCX buffers
		let [qBuf, akBuf, solBuf] = await Promise.all([
			buildPaperDoc(normalizedQuestions, "question", title, headerMeta),
			buildPaperDoc(normalizedQuestions, "answerkey", `${title} – Answer Key`, headerMeta),
			buildPaperDoc(normalizedQuestions, "solution", `${title} – Solutions`, headerMeta),
		]);

		// Fetch template if requested (scoped to institute)
		let tplBase64 = null;
		if (templateId) {
			const instId = sessionInstituteId(req);
			let tplSql, tplArgs;
			if (instId) {
				tplSql = "SELECT docx_base64 FROM paper_templates WHERE id = ? AND (institute_id = ? OR institute_id IS NULL)";
				tplArgs = [Number(templateId), instId];
			} else {
				tplSql = "SELECT docx_base64 FROM paper_templates WHERE id = ?";
				tplArgs = [Number(templateId)];
			}
			const tplRow = await db.execute({ sql: tplSql, args: tplArgs });
			if (tplRow.rows.length) tplBase64 = tplRow.rows[0].docx_base64;
		}

		// Post-process: convert $LaTeX$ → OMML Word equations + apply template
		// Always runs so equations are always rendered properly
		// Include title in headerMeta so {{TITLE}} placeholder is also replaced.
		headerMeta.title = title;
		[qBuf, akBuf, solBuf] = await Promise.all([
			postProcessDocx(qBuf, tplBase64, { ...headerMeta, mode: "question" }),
			postProcessDocx(akBuf, tplBase64, { ...headerMeta, mode: "answerkey" }),
			postProcessDocx(solBuf, tplBase64, { ...headerMeta, mode: "solution" }),
		]);

		res.json({
			success: true,
			files: {
				questionPaper: qBuf.toString("base64"),
				answerKey: akBuf.toString("base64"),
				solutions: solBuf.toString("base64"),
			}
		});
	} catch (e) {
		console.error("generate-paper error:", e);
		res.status(500).json({ error: e.message || "Failed to generate paper" });
	}
});

// ════════════════════════════════════════════════════════════════════════
//  PDF GENERATION — built from scratch, in-process (no LibreOffice, no iLovePDF)
// ════════════════════════════════════════════════════════════════════════
// The DOCX → PDF conversion now lives in utils/docxToPdf.js: it parses the
// generated .docx (page setup, headers/footers, paragraphs, runs, tables,
// images and OMML equations) and re-draws it with pdfkit, so the PDF matches
// the Word document without any external binary or third-party API key.

// Strategy: build the same high-quality DOCX files (with OMML equations and
// template applied) that the Word download uses, then convert each one to PDF
// with the built-in renderer — so the PDF looks identical to the Word document.
router.post("/api/admin/generate-paper-pdf", requireAdmin, requireFeature("paperGenerator"), async (req, res) => {
	try {
		const { questions, paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId } = req.body || {};
		console.log("[generate-paper-pdf] req.body:", {
			paperTitle,
			paperSubject,
			paperChapter,
			paperTestType,
			paperClass,
			templateId
		});
		if (!Array.isArray(questions) || !questions.length) {
			return res.status(400).json({ error: "No questions provided" });
		}

		const title = String(paperTitle || "Question Paper").trim();
		const headerMeta = {
			subject: String(paperSubject || '').trim(),
			chapter: String(paperChapter || '').trim(),
			testType: String(paperTestType || '').trim(),
			class: String(paperClass || '').trim(),
		};
		const normalizedQuestions = normalizePaperQuestions(questions);

		// Step 1: Build DOCX buffers (same as the Word download path)
		let [qBuf, akBuf, solBuf] = await Promise.all([
			buildPaperDoc(normalizedQuestions, "question", title, headerMeta),
			buildPaperDoc(normalizedQuestions, "answerkey", `${title} \u2013 Answer Key`, headerMeta),
			buildPaperDoc(normalizedQuestions, "solution", `${title} \u2013 Solutions`, headerMeta),
		]);

		// Step 2: Apply LaTeX→OMML conversion and template (same post-processing as Word)
		let tplBase64 = null;
		if (templateId) {
			const instId = sessionInstituteId(req);
			let tplSql, tplArgs;
			if (instId) {
				tplSql = "SELECT docx_base64 FROM paper_templates WHERE id = ? AND (institute_id = ? OR institute_id IS NULL)";
				tplArgs = [Number(templateId), instId];
			} else {
				tplSql = "SELECT docx_base64 FROM paper_templates WHERE id = ?";
				tplArgs = [Number(templateId)];
			}
			const tplRow = await db.execute({ sql: tplSql, args: tplArgs });
			if (tplRow.rows.length) tplBase64 = tplRow.rows[0].docx_base64;
		}
		// Include title in headerMeta so {{TITLE}} placeholder is also replaced.
		headerMeta.title = title;
		[qBuf, akBuf, solBuf] = await Promise.all([
			postProcessDocx(qBuf, tplBase64, { ...headerMeta, mode: "question" }),
			postProcessDocx(akBuf, tplBase64, { ...headerMeta, mode: "answerkey" }),
			postProcessDocx(solBuf, tplBase64, { ...headerMeta, mode: "solution" }),
		]);

		// Step 3: Convert each DOCX → PDF with the built-in renderer.
		// Sequential so a big paper never spikes memory on small pods.
		const qPdf = await docxToPdf(qBuf);
		const akPdf = await docxToPdf(akBuf);
		const solPdf = await docxToPdf(solBuf);

		res.json({
			success: true,
			files: {
				questionPaper: qPdf.toString("base64"),
				answerKey: akPdf.toString("base64"),
				solutions: solPdf.toString("base64"),
			}
		});
	} catch (e) {
		console.error("generate-paper-pdf error:", e);
		res.status(500).json({ error: e.message || "Failed to generate PDF" });
	}
});

/* ──────────────────────────────────────────────────────────────────────────
   STAR QUIZ API ROUTES
   ────────────────────────────────────────────────────────────────────── */

// GET all STAR Quiz questions

module.exports = router;

// Exported so the worker tier (worker.js) can run these jobs off the API pods.
module.exports.generatePaperDocxBackground = generatePaperDocxBackground;
module.exports.generatePaperPdfBackground = generatePaperPdfBackground;