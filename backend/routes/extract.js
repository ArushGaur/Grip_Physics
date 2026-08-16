const express = require("express");
const router = express.Router();
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const { createCanvas } = require('@napi-rs/canvas');
const pdfjsLib = require('pdfjs-dist');
const mammoth = require("mammoth");
const JSZip = require("jszip");
const { db } = require("../config/db");
const helpers = require("../utils/helpers");
const { requireAdmin } = require("../middleware/auth");
const { uploadImageToCloudinary, uploadQuestionImages } = require("../services/cloudinary");
const { callGroq } = require("../services/ai");
const { loadQuestions, refreshCache, rebuildYearIndex, findQuestion } = require("../utils/questions");

const {
    clamp, getMime, toImgPart, cleanJson, tryParse, sanitizeLatexJson,
    normalizeSolutionText, repairSolutionLatex, parseManualAnswerKey,
    applyManualAnswerKey, parseJsonArray, looksLikeEquation, normalizeMath,
    isNoneCorrectQuestion, parseCorrectIndexesFromQuestion, validateImageRegion,
    isImageCell, normalizeCell, normalizeTables, normalizeSingleTable,
    normalizeOptionTables, normalizeQuestion, normalizeQuestionRow,
} = helpers;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const bulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

let latexToOMML = null;
try {
    ({ latexToOMML } = require("latex-to-omml"));
} catch (e) {}

function predictChapterBulk(subject, questionText) {
    return null;
}

function parseLLMJSON(raw) {
    if (!raw) return { questions: [], hadContent: false };
    const cleaned = cleanJson(raw);
    try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) return { questions: parsed, hadContent: true };
        if (parsed && Array.isArray(parsed.questions)) return { questions: parsed.questions, hadContent: true };
        return { questions: [], hadContent: false };
    } catch (e) {
        return { questions: [], hadContent: false };
    }
}

router.post("/api/admin/extract", requireAdmin, async (req, res) => {
	try {
		const { questionImages, answerImages, manualAnswerKey } = req.body || {};
		if (!Array.isArray(questionImages) || !questionImages.length) {
			return res.status(400).json({ error: "At least one question image required" });
		}
		if (!GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not set on server" });

		// ── SYSTEM PROMPTS ─────────────────────────────────────────────────────────
		const answerContext = manualAnswerKey?.trim()
			? `MANUAL ANSWER KEY PROVIDED:\n${manualAnswerKey.trim()}\nUse ONLY this to set correctIndexes. Map A=0,B=1,C=2,D=3.`
			: Array.isArray(answerImages) && answerImages.length
				? "Answer-key image(s) are appended after the question image. Read each question number and its correct letter(s) from the answer key image, then set correctIndexes accordingly. A=0,B=1,C=2,D=3. Do NOT default to [0] — use the actual correct answer from the key."
				: "No answer key — set correctIndexes:[0] as placeholder.";

		const EXTRACT_SYSTEM = `You are a physics MCQ extractor. Extract EVERY numbered question.
OUTPUT: ONLY a valid JSON array. Each element:
{"questionNumber":13,"question":"13. If potential...","options":["A text","B text","C text","D text"],"correctIndexes":[0],"isMultiCorrect":false,"hasImage":false,"hasOptionImages":false,"imageRegion":null}
RULES:
1. COMPLETENESS — output array length must equal visible question count.
2. LAYOUT — two-column: left top→bottom, then right top→bottom.
3. QUESTION NUMBER — always set "questionNumber" to the integer shown before the question text (e.g. 13, 14, 15…). Also PRESERVE the number prefix at the start of the "question" string (e.g. "13. If potential…").
4. OPTIONS — exactly 4 per question; fill missing with "".
   - Extract the FULL option text verbatim (e.g. "25% loss", "50% loss", or a LaTeX equation).
   - If an option is ONLY a bare label like "(a)", "(b)", "(c)", "(d)" with NO readable text because it IS a circuit diagram or figure, set that option to "[Diagram — see figure]" and set hasOptionImages:true.
   - NEVER return just "(a)", "(b)", "(c)", "(d)" as a complete option value; always include the actual content if any text is visible alongside the label.
5. MATH — all equations in $...$; preserve units, Greek symbols, fractions.
6. SPLITS — include partial questions, leave cut-off options as "".
7. IMAGES — hasImage:true if question references figure/graph. imageRegion:{x,y,w,h} in 0-1 fractions; else null.
8. MULTI — isMultiCorrect:true when multiple answers correct.
${answerContext}`;

		const COUNT_SYSTEM = `Count numbered MCQ questions in a physics screenshot. Return ONLY JSON: {"count":N,"numbers":[1,2,3,...]}`;

		const RECOVERY_SYSTEM = `Recover MISSED physics MCQ questions. Return ONLY JSON array of questions NOT already in the prior list. Return [] if nothing missed.`;

		const MERGE_SYSTEM = `Decide if a question is split across two consecutive screenshots. Return ONLY JSON.`;

		const ANSWER_OVERLAY_SYSTEM = `You are a highly accurate answer key reader for physics MCQ tests. Your ONLY job is to extract the correct answer letter(s) for EVERY question number visible.

ANSWER KEY FORMATS you may encounter:
- Grid/Table: numbers in rows, letter answers beside or below (most common JEE format)
- Compact list: "1-C  2-A  3-B  4-D" or "1.C  2.A  3.B" 
- Numbered list: "1. C", "1) C", "1: C", "1 → C", "1. (C)"
- Highlighted/circled/boxed: the marked option letter is correct
- Multi-correct: "A,C" or "A and C" or "(A)(C)" or "AB"
- Roman/regional formats: numbers may use regional script

CRITICAL RULES:
1. Map letters STRICTLY: A=0, B=1, C=2, D=3 (case-insensitive)
2. For multi-correct: include ALL correct letter indexes e.g. A,C → [0,2]
3. Extract EVERY question number — do not skip any
4. Scan the ENTIRE image top-to-bottom, left-to-right — answers may be in multiple columns
5. Return ONLY valid JSON array — no explanation, no markdown, no text outside JSON

OUTPUT FORMAT:
[{"num":1,"correctIndexes":[2]},{"num":2,"correctIndexes":[0,3]},{"num":3,"correctIndexes":[1]}]

Example multi-correct: question 5 has answers A,C → {"num":5,"correctIndexes":[0,2]}`;

		const answerPartsForGroq = Array.isArray(answerImages) ? answerImages.slice(0, 2).map(toImgPart) : [];

		// ── HELPERS ──────────────────────────────────────────────────────────────────
		function keyOf(q) {
			const stem = String(q?.question || "").toLowerCase().replace(/\s+/g, " ").slice(0, 200);
			const opts = (Array.isArray(q?.options) ? q.options : []).map(x => String(x || "").toLowerCase().trim()).slice(0, 4).join("|");
			return `${stem}||${opts}`;
		}
		function getNum(q) {
			// Prefer explicit questionNumber field set during extraction
			if (q && Number.isInteger(q.questionNumber) && q.questionNumber > 0) return q.questionNumber;
			// Fallback: parse leading number from question text
			const m = String(q?.question || "").match(/^\s*(?:q\.?\s*)?(\d{1,3})\s*[\).:\u2013\-\s]/i);
			if (!m) return null;
			const n = parseInt(m[1], 10);
			return Number.isInteger(n) ? n : null;
		}
		function richness(q) {
			return String(q?.question || "").trim().length +
				(Array.isArray(q?.options) ? q.options : []).filter(o => String(o || "").trim()).length * 50;
		}
		function stemSig(q) {
			return String(q?.question || "").toLowerCase()
				.replace(/^\s*(?:q\.?\s*)?\d{1,3}\s*[\).:\u2013\-]?\s*/i, "")
				.replace(/\s+/g, " ").replace(/[^a-z0-9$\\\-+*/=() ]/g, "").trim();
		}
		function optionSet(q) {
			return new Set((Array.isArray(q?.options) ? q.options : [])
				.map(o => String(o || "").toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean));
		}
		function areNearDup(a, b) {
			const na = getNum(a), nb = getNum(b);
			if (na !== null && nb !== null && na !== nb) return false;
			const sa = stemSig(a), sb = stemSig(b);
			if (!sa || !sb || sa !== sb) return false;
			const oa = optionSet(a), ob = optionSet(b);
			if (!oa.size || !ob.size) return true;
			let overlap = 0;
			oa.forEach(x => { if (ob.has(x)) overlap++; });
			return overlap >= 3;
		}

		// ── STEP 1: PARALLEL PRIMARY EXTRACTION ─────────────────────────────────────
		console.log(`[extract-v2] Parallel extraction: ${questionImages.length} image(s)`);
		const primaryResults = await Promise.all(
			questionImages.map(async (imgB64, i) => {
				const parts = [toImgPart(imgB64), ...answerPartsForGroq];
				const raw = await callGroq(parts, EXTRACT_SYSTEM,
					"Extract every numbered MCQ. Return ONLY JSON array.", 3000, 0.05);
				const arr = parseJsonArray(raw) || [];
				console.log(`[extract-v2] Image ${i}: primary=${arr.length}`);
				return { imgB64, idx: i, arr };
			})
		);

		// ── STEP 2: PARALLEL COUNT VERIFICATION ─────────────────────────────────────
		const countResults = await Promise.all(
			questionImages.map(async (imgB64, i) => {
				const raw = await callGroq([toImgPart(imgB64)], COUNT_SYSTEM,
					'Count visible questions. Return JSON: {"count":N,"numbers":[...]}', 300, 0.0);
				const parsed = tryParse(cleanJson(raw)) || {};
				const count = parseInt(parsed.count) || 0;
				const numbers = Array.isArray(parsed.numbers)
					? parsed.numbers.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
				console.log(`[extract-v2] Image ${i}: visible=${count}`);
				return { idx: i, count, numbers };
			})
		);

		// ── STEP 3: COLLECT + TARGETED RECOVERY ─────────────────────────────────────
		const allExtracted = [];
		const seen = new Set();
		function pushUnique(q, sourceIdx) {
			const normalized = normalizeQuestion({ ...q, imageSourceIndex: sourceIdx });
			const k = keyOf(normalized);
			if (seen.has(k)) return false;
			seen.add(k);
			allExtracted.push(normalized);
			return true;
		}
		for (const { arr, idx } of primaryResults) {
			for (const q of arr) pushUnique(q, idx);
		}

		// Recovery pass — only for images where we extracted < 85% of expected
		await Promise.all(
			questionImages.map(async (imgB64, i) => {
				const primary = primaryResults[i].arr;
				const expected = countResults[i].count;
				if (expected <= 0 || primary.length >= expected * 0.85) return;
				const missed = Math.max(1, expected - primary.length);
				console.log(`[extract-v2] Image ${i}: recovery needed (${primary.length}/${expected})`);
				const prompt = `You extracted ${primary.length} but ${expected} are visible. Find the ${missed} MISSING question(s).
PRIOR LIST (do NOT re-extract):
${JSON.stringify(primary.map(q => String(q.question || "").slice(0, 80))).slice(0, 3000)}
Return ONLY JSON array of MISSING questions. Return [] if nothing missed.`;
				const parts = [toImgPart(imgB64), ...answerPartsForGroq];
				const raw = await callGroq(parts, RECOVERY_SYSTEM, prompt, 2000, 0.0);
				const arr = parseJsonArray(raw) || [];
				let added = 0;
				for (const q of arr) { if (pushUnique(q, i)) added++; }
				if (added) console.log(`[extract-v2] Image ${i}: recovery added ${added}`);
			})
		);

		// ── STEP 4: CROSS-IMAGE BOUNDARY MERGE ──────────────────────────────────────
		for (let i = 1; i < questionImages.length; i++) {
			const leftCands = allExtracted.filter(q => q.imageSourceIndex === i - 1);
			const rightCands = allExtracted.filter(q => q.imageSourceIndex === i);
			if (!leftCands.length || !rightCands.length) continue;
			const left = leftCands[leftCands.length - 1];
			const right = rightCands[0];

			const leftNum = getNum(left) || null;
			const rightNum = getNum(right) || null;
			const rightText = String(right.question || "").trim();

			// Signal 1: right fragment has no leading question-number in its text
			const rightTextHasNumber = /^\s*(?:Q\.?\s*)?\d{1,3}\s*[\.\)\:\-–]/.test(rightText);

			// Signal 2: right's questionNumber == left's questionNumber (same Q split across images)
			const sameQNumber = leftNum !== null && rightNum !== null && leftNum === rightNum;

			// Signal 3: left question has incomplete options (some blank)
			const leftMissingOpts = (left.options || []).filter(o => !String(o || "").trim()).length;

			// A continuation is detected when:
			//   - The right fragment text does NOT start with a question number, OR
			//   - Both sides share the same question number, OR
			//   - The left has missing options AND right question number is adjacent/same
			const isContinuation = !rightTextHasNumber || sameQNumber ||
				(leftMissingOpts > 0 && rightNum !== null && leftNum !== null && rightNum === leftNum);

			if (isContinuation) {
				// Direct merge: append right text + options to left, no AI call needed
				const leftText = String(left.question || "").trimEnd();
				// Only append right text if it's not a repeat of the number prefix
				const rightAppend = rightText.replace(/^\s*(?:Q\.?\s*)?\d{1,3}\s*[\.\)\:\-–]\s*/i, "").trim();
				const mergedQuestion = rightAppend ? leftText + " " + rightAppend : leftText;

				const mergedOptions = (left.options || ["", "", "", ""]).map((lOpt, oi) => {
					const rOpt = String((right.options || [])[oi] || "").trim();
					const lO = String(lOpt || "").trim();
					if (lO && rOpt && lO !== rOpt) return lO + " " + rOpt;
					return lO || rOpt;
				});

				const mergedQ = normalizeQuestion({
					...left,
					question: mergedQuestion,
					options: mergedOptions,
					hasImage: left.hasImage || right.hasImage,
					hasOptionImages: left.hasOptionImages || right.hasOptionImages,
					imageRegion: left.imageRegion || right.imageRegion,
					imageSourceIndex: i - 1,
				});
				const li = allExtracted.findIndex(q => q === left);
				const ri = allExtracted.findIndex(q => q === right);
				if (li !== -1) allExtracted[li] = mergedQ;
				if (ri !== -1) allExtracted.splice(ri, 1);
				console.log(`[extract-v2] Direct boundary merge img${i - 1}→${i} (Q${leftNum ?? '?'})`);
				continue;
			}

			// Fall back to AI merge check if left has missing options and right looks new
			if (leftMissingOpts === 0) continue;

			const prompt = `Last question of image 1:
"${String(left.question || "").slice(0, 300)}" opts=${JSON.stringify(left.options)}
First fragment of image 2:
"${String(right.question || "").slice(0, 300)}" opts=${JSON.stringify(right.options)}
Is image-2 fragment a continuation of image-1's question?
Return ONLY: {"split":true,"merged":{"question":"...","options":["","","",""],"correctIndexes":[0],"isMultiCorrect":false,"hasImage":false,"imageRegion":null}} OR {"split":false}`;
			const mergeRaw = await callGroq(
				[toImgPart(questionImages[i - 1]), toImgPart(questionImages[i])],
				MERGE_SYSTEM, prompt, 600, 0.0
			);
			const mt = cleanJson(mergeRaw);
			const merged = tryParse(mt.slice(mt.indexOf("{"), mt.lastIndexOf("}") + 1));
			if (merged?.split === true && merged?.merged) {
				const mergedQ = normalizeQuestion({ ...merged.merged, imageSourceIndex: i - 1 });
				const li = allExtracted.findIndex(q => q === left);
				const ri = allExtracted.findIndex(q => q === right);
				if (li !== -1) allExtracted[li] = mergedQ;
				if (ri !== -1) allExtracted.splice(ri, 1);
				console.log(`[extract-v2] Boundary merged image ${i - 1}→${i}`);
			}
		}

		// ── STEP 5: ANSWER KEY OVERLAY (from image key) ─────────────────────────────
		if (Array.isArray(answerImages) && answerImages.length && !manualAnswerKey?.trim()) {
			try {
				// Use up to 3 answer images; first do a dedicated pass with high token budget
				const akImages = answerImages.slice(0, 3).map(toImgPart);
				const highestQNum = allExtracted.length > 0
					? Math.max(...allExtracted.map(q => getNum(q) || 0), allExtracted.length)
					: 30;
				const akRaw = await callGroq(akImages, ANSWER_OVERLAY_SYSTEM,
					`Read EVERY question number and its correct answer letter(s) from this answer key. The paper has approximately ${highestQNum} questions. IMPORTANT: extract ALL of them — do not stop early. Look for question numbers 1 through ${highestQNum}. Return ONLY JSON array [{"num":N,"correctIndexes":[...]},...].`, 3500, 0.0);
				const akArr = parseJsonArray(akRaw);
				if (Array.isArray(akArr)) {
					const akMap = new Map();
					// Also build a sorted array of [num, correctIndexes] for position-based fallback
					const akSorted = [];
					for (const e of akArr) {
						const num = parseInt(e.num);
						if (Number.isInteger(num) && Array.isArray(e.correctIndexes)) {
							const idxs = e.correctIndexes.map(Number).filter(n => n >= 0 && n < 4);
							if (idxs.length) {
								akMap.set(num, idxs);
								akSorted.push({ num, idxs });
							}
						}
					}
					akSorted.sort((a, b) => a.num - b.num);
					let overlaid = 0;
					for (const q of allExtracted) {
						const n = getNum(q);
						if (n !== null && akMap.has(n)) {
							q.correctIndexes = akMap.get(n);
							q.isMultiCorrect = q.correctIndexes.length > 1;
							overlaid++;
						}
					}
					// Position-based fallback: for questions where getNum() failed or number wasn't in akMap,
					// try matching by position order if akSorted covers them
					if (overlaid < allExtracted.length && akSorted.length > 0) {
						const unmatched = allExtracted.filter(q => {
							const n = getNum(q);
							return n === null || !akMap.has(n);
						});
						// If the number of unmatched questions equals remaining ak entries, map positionally
						const usedNums = new Set(allExtracted.filter(q => getNum(q) !== null && akMap.has(getNum(q))).map(q => getNum(q)));
						const unusedAk = akSorted.filter(e => !usedNums.has(e.num));
						if (unmatched.length > 0 && unusedAk.length > 0) {
							// Sort unmatched by their position in allExtracted
							const count = Math.min(unmatched.length, unusedAk.length);
							for (let pi = 0; pi < count; pi++) {
								const q = unmatched[pi];
								const ak = unusedAk[pi];
								if (ak.idxs.length) {
									q.correctIndexes = ak.idxs;
									q.isMultiCorrect = q.correctIndexes.length > 1;
									overlaid++;
								}
							}
						}
					}
					console.log(`[extract-v2] Answer overlay: ${overlaid} question(s)`);
				}
			} catch (akErr) {
				console.warn("[extract-v2] Answer overlay failed:", akErr.message);
			}
		}

		// ── STEP 6: DEDUP + SORT + FINAL NORMALISE ──────────────────────────────────
		const bestByNum = new Map();
		for (const q of allExtracted) {
			const n = getNum(q);
			if (n === null) continue;
			const prev = bestByNum.get(n);
			if (!prev || richness(q) > richness(prev)) bestByNum.set(n, q);
		}
		const ordered = [];
		const seenNums = new Set();
		for (const q of allExtracted) {
			const n = getNum(q);
			if (n === null) { ordered.push(q); continue; }
			if (seenNums.has(n)) continue;
			seenNums.add(n);
			ordered.push(bestByNum.get(n) || q);
		}
		ordered.sort((a, b) => (getNum(a) ?? 9999) - (getNum(b) ?? 9999));

		const deduped = [];
		for (const q of ordered) {
			const idx = deduped.findIndex(x => areNearDup(x, q));
			if (idx === -1) { deduped.push(q); continue; }
			if (richness(q) > richness(deduped[idx])) deduped[idx] = q;
		}

		if (!deduped.length) {
			return res.status(500).json({ error: "No questions could be extracted. Please upload a clearer screenshot." });
		}

		const questions = deduped.map(q => {
			const next = normalizeQuestion(q);
			if (next.hasImage && !Number.isInteger(next.imageSourceIndex)) next.imageSourceIndex = 0;
			if (Number.isInteger(next.imageSourceIndex))
				next.imageSourceIndex = clamp(next.imageSourceIndex, 0, questionImages.length - 1);
			return next;
		});

		// ── STEP 7: APPLY MANUAL ANSWER KEY (authoritative override) ─────────────
		if (manualAnswerKey?.trim()) {
			const akMap = parseManualAnswerKey(manualAnswerKey);
			applyManualAnswerKey(questions, akMap);
			console.log(`[extract-v2] Manual AK applied: ${akMap.size} entries for ${questions.length} questions`);
		}

		console.log(`[extract-v2] Done: ${questions.length} questions`);
		res.json({ questions });
	} catch (e) {
		console.error("/api/admin/extract error:", e);
		res.status(500).json({ error: e.message || "Extraction failed" });
	}
});

/* ──────────────────────────────────────────────────────────────────────────
   /api/admin/extract-doc  — extract MCQs from uploaded PDF or DOCX file
   ────────────────────────────────────────────────────────────────────── */
router.post("/api/admin/extract-doc", requireAdmin,
	upload.fields([
		{ name: "questionFile", maxCount: 1 },
		{ name: "answerFile", maxCount: 1 },
	]),
	async (req, res) => {
		try {
			const questionFile = req.files?.questionFile?.[0];
			const answerFile = req.files?.answerFile?.[0];
			const manualAK = (req.body?.manualAnswerKey || "").trim();

			if (!questionFile) return res.status(400).json({ error: "No question file uploaded" });

			const isPdf = questionFile.mimetype === "application/pdf" || questionFile.originalname.endsWith(".pdf");
			const isDocx = questionFile.originalname.endsWith(".docx");
			if (!isPdf && !isDocx) return res.status(400).json({ error: "Only PDF and .docx files are supported" });

			/* ── Build answer context ─────────────────────────────── */
			let aText = "";
			if (answerFile) {
				try {
					if (answerFile.mimetype === "application/pdf" || answerFile.originalname.endsWith(".pdf")) {
						const parsed = await pdfParse(answerFile.buffer);
						aText = parsed.text;
					} else if (answerFile.originalname.endsWith(".docx")) {
						const r2 = await mammoth.extractRawText({ buffer: answerFile.buffer });
						aText = r2.value;
					}
				} catch (e) { console.warn("[extract-doc] answer file parse failed:", e.message); }
			}
			const answerContext = manualAK
				? `MANUAL ANSWER KEY:\n${manualAK}\nUse ONLY this to set correctIndexes.`
				: aText.trim()
					? `ANSWER KEY TEXT:\n${aText.slice(0, 3000)}\nUse this to set correctIndexes precisely.`
					: "No answer key — set correctIndexes:[0] as placeholder.";

			const DOC_SYSTEM_PROMPT = `You are an expert physics MCQ extractor.
The document may contain text questions, LaTeX/typed equations, and embedded diagram images.

OUTPUT: ONLY a raw JSON array — no markdown, no prose. Each element:
{"question":"...","options":["A text","B text","C text","D text"],"correctIndexes":[0],"isMultiCorrect":false,"hasEquation":false,"hasImage":false,"imageNote":""}

STRICT RULES:
1. COMPLETENESS — extract EVERY numbered question. Do NOT skip any.
2. OPTIONS — extract all 4 option texts verbatim.
3. EQUATIONS — output all math in LaTeX $...$ delimiters. Reconstruct garbled equations (e.g. "1 2mv2"→"$\\frac{1}{2}mv^2$"). Set hasEquation:true.
4. IMAGES — if the question contains or references a figure/diagram/graph/circuit:
   - Set hasImage:true
   - Set imageNote to a description of what the diagram shows (e.g. "Circuit with R1 and R2 in parallel")
5. MULTI-CORRECT — isMultiCorrect:true, correctIndexes lists all correct 0-based indices (A=0,B=1,C=2,D=3).
6. Return ONLY the JSON array.`;

			let questions = [];

			/* ══════════════════════════════════════════════════════════
			   PATH A: Gemini API (preferred — reads PDFs natively)
			══════════════════════════════════════════════════════════ */
			if (GEMINI_API_KEY) {
				console.log(`[extract-doc] Using Gemini for ${questionFile.originalname}`);

				// Build parts array for Gemini
				const parts = [];

				if (isPdf) {
					// Send PDF directly — Gemini reads all pages natively
					parts.push({
						inlineData: {
							mimeType: "application/pdf",
							data: questionFile.buffer.toString("base64")
						}
					});
				} else {
					// DOCX: extract text + embedded images via mammoth
					// Also extract ALL images directly from the zip (some editors orphan images
					// in word/media/ without placing them in the document XML flow — mammoth
					// misses those entirely, but they still belong to hasImage questions)
					const docxImages = [];

					// 1. Images mammoth finds in the document XML flow (inline/anchored)
					const mammothResult = await mammoth.convertToHtml(
						{ buffer: questionFile.buffer },
						{
							convertImage: mammoth.images.imgElement(async (image) => {
								const imgBuffer = await image.read();
								const b64 = imgBuffer.toString("base64");
								const mime = image.contentType || "image/png";
								docxImages.push({ b64, mime, source: "inline" });
								return { src: `data:${mime};base64,${b64}` };
							})
						}
					);

					// 2. Also extract ALL images directly from the DOCX zip (catches orphaned images)
					// Uses Python (already available on server) to avoid adding a new npm dep
					try {
						const { execFileSync } = require("child_process");
						const fs = require("fs");
						const path = require("path");
						const os = require("os");
						const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grip-docx-img-"));
						const tmpDocx = path.join(tmpDir, "q.docx");
						fs.writeFileSync(tmpDocx, questionFile.buffer);

						const pyScript = `
import sys, zipfile, json, os, base64
docx_path = sys.argv[1]
results = []
with zipfile.ZipFile(docx_path) as z:
    # Find which images are referenced in document.xml (inline)
    try:
        doc_xml = z.read('word/document.xml').decode('utf-8', 'replace')
    except: doc_xml = ''
    try:
        rels_xml = z.read('word/_rels/document.xml.rels').decode('utf-8', 'replace')
    except: rels_xml = ''
    # Build rId -> filename map
    import re
    rel_map = {}
    for m in re.finditer(r'Id="(rId\\d+)"[^>]*Target="([^"]+)"', rels_xml):
        rel_map[m.group(1)] = m.group(2)
    # Find rIds used in document body
    used_rids = set(re.findall(r'r:embed="(rId\\d+)"', doc_xml))
    for name in z.namelist():
        if not name.startswith('word/media/'): continue
        if not re.search(r'\\.(jpe?g|png|gif|webp)$', name, re.I): continue
        data = z.read(name)
        size = len(data)
        if size < 2048 or size > 2*1024*1024: continue  # skip tiny/huge
        fname = os.path.basename(name)
        ext = fname.rsplit('.',1)[-1].lower()
        mime = 'image/png' if ext=='png' else 'image/gif' if ext=='gif' else 'image/jpeg'
        # Determine if this image is referenced inline in the document
        is_inline = any(rel_map.get(rid,'').endswith(fname) or 
                       rel_map.get(rid,'') == 'media/'+fname 
                       for rid in used_rids)
        results.append({'b64': base64.b64encode(data).decode(), 'mime': mime, 
                        'inline': is_inline, 'size': size, 'name': fname})
print(json.dumps(results))
`;
						const py = getPythonRunner();
						const pyOut = execFileSync(py.command, [...py.args, "-c", pyScript, tmpDocx], {
							timeout: 15000, encoding: "utf8", maxBuffer: 50 * 1024 * 1024
						});
						try { require("fs").rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }

						const zipImages = JSON.parse(pyOut.trim() || "[]");
						// Collect sizes of images already found by mammoth (inline)
						const inlineSizes = new Set(docxImages.map(i => Buffer.from(i.b64, "base64").length));
						for (const zi of zipImages) {
							const bufLen = Buffer.from(zi.b64, "base64").length;
							if (inlineSizes.has(bufLen)) continue; // already captured by mammoth
							docxImages.push({ b64: zi.b64, mime: zi.mime, source: "orphaned", size: zi.size });
						}
						// Sort: inline first, then orphaned by size desc (largest = most content-rich)
						docxImages.sort((a, b) => {
							if (a.source !== "orphaned" && b.source === "orphaned") return -1;
							if (a.source === "orphaned" && b.source !== "orphaned") return 1;
							return (b.size || 0) - (a.size || 0);
						});
						const orphanCount = docxImages.filter(i => i.source === "orphaned").length;
						if (orphanCount > 0) {
							console.log(`[extract-doc] DOCX: found ${orphanCount} orphaned image(s) not in document flow`);
						}
					} catch (zipErr) {
						console.warn("[extract-doc] Could not extract orphaned images from DOCX:", zipErr.message);
					}

					const docxText = mammothResult.value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
					if (docxText) parts.push({ text: `--- DOCX TEXT ---\n${docxText.slice(0, 20000)}` });
					for (const img of docxImages.slice(0, 20)) {
						parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
					}
					if (!docxText && docxImages.length === 0) {
						return res.status(400).json({ error: "Could not extract content from DOCX file." });
					}
				}

				// Fold system prompt + answer context into the user message (broadest compatibility)
				parts.push({ text: `${DOC_SYSTEM_PROMPT}\n\n${answerContext}\n\nExtract all MCQs from the document above. Return ONLY the JSON array.` });

				// Dynamically discover which models are available for this API key
				// Tries both v1beta and v1 endpoints, picks best available model
				let chosenModel = null;
				let chosenApi = null;

				for (const apiVer of ["v1beta", "v1"]) {
					try {
						const listResp = await fetch(
							`https://generativelanguage.googleapis.com/${apiVer}/models?key=${GEMINI_API_KEY}`
						);
						if (!listResp.ok) continue;
						const listData = await listResp.json();
						const available = (listData.models || [])
							.filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
							.map(m => m.name.replace("models/", ""));

						console.log(`[extract-doc] Available Gemini models (${apiVer}):`, available);

						// Prefer in order: 2.0-flash > 1.5-flash > 1.5-flash-8b > any flash > any model
						const PREFERRED = [
							"gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.0-flash-exp",
							"gemini-1.5-flash", "gemini-1.5-flash-latest", "gemini-1.5-flash-8b",
							"gemini-1.5-pro", "gemini-1.5-pro-latest",
						];
						for (const pref of PREFERRED) {
							if (available.find(m => m === pref || m.startsWith(pref))) {
								chosenModel = available.find(m => m === pref || m.startsWith(pref));
								chosenApi = apiVer;
								break;
							}
						}
						// If none of the preferred matched, just use the first available model
						if (!chosenModel && available.length > 0) {
							chosenModel = available[0];
							chosenApi = apiVer;
						}
						if (chosenModel) break;
					} catch (e) {
						console.warn(`[extract-doc] ListModels (${apiVer}) failed:`, e.message);
					}
				}

				if (!chosenModel) {
					throw new Error(
						"Could not find any available Gemini model. Please check: " +
						"(1) GEMINI_API_KEY is set correctly on Render, " +
						"(2) The Generative Language API is enabled at console.cloud.google.com, " +
						"(3) Your API key was created at aistudio.google.com/apikey"
					);
				}

				console.log(`[extract-doc] Using Gemini model: ${chosenModel} (${chosenApi})`);
				const geminiResp = await fetch(
					`https://generativelanguage.googleapis.com/${chosenApi}/models/${chosenModel}:generateContent?key=${GEMINI_API_KEY}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							contents: [{ role: "user", parts }],
							generationConfig: { temperature: 0.05, maxOutputTokens: 16384 }
						})
					}
				);

				if (!geminiResp.ok) {
					const errBody = await geminiResp.json().catch(() => ({}));
					throw new Error(errBody?.error?.message || `Gemini error ${geminiResp.status}`);
				}

				const geminiData = await geminiResp.json();
				const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
				const parsed = parseJsonArray(raw);
				if (Array.isArray(parsed)) questions = parsed;
				console.log(`[extract-doc] Gemini extracted ${questions.length} questions`);

				/* ══════════════════════════════════════════════════════════
				   PATH B: Groq fallback (text-only, chunked)
				══════════════════════════════════════════════════════════ */
			} else if (GROQ_API_KEY) {
				console.log(`[extract-doc] GEMINI_API_KEY not set, falling back to Groq for ${questionFile.originalname}`);

				let qText = "";
				if (isPdf) {
					const parsed = await pdfParse(questionFile.buffer);
					qText = parsed.text;
				} else {
					const result = await mammoth.extractRawText({ buffer: questionFile.buffer });
					qText = result.value;
				}
				if (!qText.trim()) return res.status(400).json({ error: "Could not extract text from file. Is it scanned-only?" });

				const DOC_SYSTEM = `You are a physics MCQ extractor. Text is from a PDF/DOCX — equations may be garbled.
OUTPUT: ONLY a raw JSON array, no markdown. Each element:
{"question":"...","options":["A","B","C","D"],"correctIndexes":[0],"isMultiCorrect":false,"hasEquation":false,"hasImage":false,"imageNote":""}
RULES: Extract EVERY numbered question. Reconstruct equations as LaTeX $...$. Set hasImage:true for diagram references. Return [] if no questions.`;

				async function callGroqDoc(chunkText) {
					const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
						method: "POST",
						headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
						body: JSON.stringify({
							model: "llama-3.3-70b-versatile", max_tokens: 3500, temperature: 0.05,
							messages: [
								{ role: "system", content: DOC_SYSTEM },
								{ role: "user", content: `${answerContext}\n\n--- CHUNK ---\n${chunkText}` },
							],
						}),
					});
					if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || `Groq ${resp.status}`); }
					const d = await resp.json();
					return d.choices?.[0]?.message?.content || "";
				}

				const CHUNK_SIZE = 3500;
				const fullText = qText.slice(0, 40000);
				const chunks = [];
				for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
					let end = Math.min(i + CHUNK_SIZE, fullText.length);
					if (end < fullText.length) { const nl = fullText.indexOf("\n", end); if (nl !== -1 && nl - end < 300) end = nl + 1; }
					chunks.push(fullText.slice(i, end));
				}
				for (let ci = 0; ci < chunks.length; ci++) {
					const raw = await callGroqDoc(chunks[ci]);
					const parsed = parseJsonArray(raw);
					if (Array.isArray(parsed)) questions.push(...parsed);
					if (ci < chunks.length - 1) await new Promise(r => setTimeout(r, 1100));
				}
			} else {
				return res.status(500).json({ error: "No AI API key configured. Set GEMINI_API_KEY or GROQ_API_KEY on the server." });
			}

			if (!questions.length) throw new Error("AI could not extract questions from the file. Please check the file content.");

			/* ── Normalise ────────────────────────────────────────── */
			let normalised = questions.map(q => ({
				question: q.question || "",
				options: Array.isArray(q.options) && q.options.length >= 4 ? q.options.slice(0, 4) : [...(q.options || []), "", "", "", ""].slice(0, 4),
				correctIndexes: Array.isArray(q.correctIndexes) ? q.correctIndexes : [typeof q.correctIndex === "number" ? q.correctIndex : 0],
				isMultiCorrect: !!q.isMultiCorrect || (Array.isArray(q.correctIndexes) && q.correctIndexes.length > 1),
				hasImage: !!q.hasImage,
				...(q.hasImage && q.imageNote ? { question: (q.question || "") + `\n\n[📷 Diagram: ${q.imageNote}]` } : {}),
				hasEquation: !!q.hasEquation,
				_imgB64: null,
			}));

			// Deduplicate
			const seen = new Set();
			normalised = normalised.filter(q => {
				const key = String(q.question || "").slice(0, 80).toLowerCase().replace(/\s+/g, " ").trim();
				if (!key || seen.has(key)) return false;
				seen.add(key); return true;
			});

			// Apply manual answer key override
			if (manualAK) {
				const akMap = parseManualAnswerKey(manualAK);
				applyManualAnswerKey(normalised, akMap);
				console.log(`[extract-doc] Manual AK applied: ${akMap.size} entries`);
			}

			console.log(`[extract-doc] Done: ${normalised.length} questions from ${questionFile.originalname}`);
			res.json({ questions: normalised });

		} catch (e) {
			console.error("/api/admin/extract-doc error:", e);
			res.status(500).json({ error: e.message || "Document extraction failed" });
		}
	});

/* ──────────────────────────────────────────────────────────────────────────
   SOLUTION EXTRACTION ENDPOINTS
   ────────────────────────────────────────────────────────────────────── */

const SOLUTION_SYSTEM = `You are a physics solutions extractor. Given solution screenshot images, extract the solution for EVERY numbered question visible across ALL images.

CRITICAL: A single screenshot may contain solutions for MULTIPLE questions. Extract ALL of them SEPARATELY — one entry per question number. NEVER merge Q51, Q52, Q53 into a single entry.

LATEX RULES — STRICTLY FOLLOW:
- Every mathematical expression MUST be wrapped in $ ... $ delimiters: inline use $expr$, display use $$expr$$
- Use proper LaTeX commands: \\frac{a}{b}  NOT "a/b" for fractions
- Use \\frac, \\sqrt, \\vec, \\hat, \\int, \\sum, \\pi, \\alpha, \\beta, \\theta, \\epsilon, \\mu, \\omega, \\times, \\cdot, \\pm etc.
- NEVER write bare fractions like "1/2 mv^2" — always $\\frac{1}{2}mv^2$
- Units in equations: $F = ma$ where F is in $\\text{N}$, m in $\\text{kg}$
- Subscripts: $Q_1$, $C_1$, $V_2$ etc. — always use _ inside $
- Superscripts: $V^2$, $r^3$, $10^{-3}$ — always use ^ inside $
- Square roots: $\\sqrt{2}$, $\\sqrt{\\frac{a}{b}}$
- Check: if you write \\frac it must appear as \\frac{...}{...} with curly braces on both numerator and denominator
- NEVER output raw "rac{" or "frac{" without the leading backslash \\
- ALWAYS wrap ALL math expressions in $...$. Do NOT output bare math without delimiters.

SOLUTION NUMBER PREFIX:
- Start each solution's text with the question number and answer letter: e.g. "51. (b) : " before the explanation
- This makes it clear which question the solution belongs to

FORMATTING RULES:
- Use \\n to separate each step — DO NOT collapse into a single line
- Example: "51. (b) : As the capacitors are connected in parallel...\\n$Q_1 = CV$\\n$Q_2 = \\frac{C}{2}V$\\nAlso, $Q = Q_1 + Q_2 = \\frac{3}{2}CV$"
- DO NOT put multiple question solutions in one text block — each question gets its OWN separate array entry

OUTPUT FORMAT — JSON array indexed 1-based by question number (index 0 = null):
[null, {"text":"1. (a) : solution for Q1...","sourceImageIndex":0,"hasDiagram":false}, null, null, ..., {"text":"51. (b) : solution...","sourceImageIndex":0,"hasDiagram":false}, {"text":"52. (a) : solution...","sourceImageIndex":0,"hasDiagram":false}, {"text":"53. (b) : solution...","sourceImageIndex":0,"hasDiagram":false}]

RULES:
1. Scan EVERY image carefully — don't miss any question number
2. EACH question number gets its OWN separate array entry at its exact index (Q51 → index 51, Q52 → index 52)
3. Do NOT merge multiple questions into one entry — Q51, Q52, Q53 are THREE separate entries
4. If a question has no solution visible, use null for that index
5. Return ONLY valid JSON — no markdown, no explanation
6. The array must be long enough to cover the highest question number found (may be sparse with nulls)
7. Every math expression MUST use $...$ LaTeX delimiters — bare math without $ is wrong`;

// Extract solutions from screenshots
router.post("/api/admin/extract-solutions", requireAdmin, async (req, res) => {
	try {
		const { solutionImages, questionCount, questionNumbers } = req.body || {};
		if (!Array.isArray(solutionImages) || !solutionImages.length) {
			return res.status(400).json({ error: "No solution images provided" });
		}

		const qCount = parseInt(questionCount) || 500;
		// Process up to 6 images; batch into groups of 3 if more
		const BATCH = 3;
		const batches = [];
		for (let i = 0; i < Math.min(solutionImages.length, 6); i += BATCH) {
			batches.push(solutionImages.slice(i, i + BATCH).map((b64, bi) => ({
				b64,
				globalIdx: i + bi
			})));
		}

		// solMap: question_number -> {text, sourceImageIndex, hasDiagram, imageIndexes[]}
		const solMap = new Map();

		for (const batch of batches) {
			const imgParts = batch.map(({ b64 }) => ({
				type: "image_url",
				image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" }
			}));
			const batchSize = batch.length;
			const startIdx = batch[0].globalIdx;
			const imageLabels = batch.map((_, i) => `Image ${i} (global index ${startIdx + i})`).join(", ");

			const raw = await callGroq(
				imgParts,
				SOLUTION_SYSTEM,
				`There are ${batchSize} solution screenshot(s): ${imageLabels}.\nCRITICAL RULES:\n1. Extract EACH question number as a SEPARATE array entry at its EXACT index. Q51→index 51, Q52→index 52, Q53→index 53. THREE separate entries, NOT merged.\n2. Do NOT put Q52 or Q53 content inside Q51's text. Each question is its own JSON object.\n3. Wrap ALL math in $...$. Use proper LaTeX (\\\\frac{a}{b} not a/b, \\\\sqrt{x} not sqrt{x}).\n4. NEVER output bare LaTeX commands without $ delimiters.\n5. Return JSON array (index 0 = null, index N = solution for question N). Sparse with nulls for missing questions.`,
				6000, 0.05
			);

			try {
				const sanitized = sanitizeLatexJson(raw);
				const parsed = JSON.parse(sanitized);
				if (Array.isArray(parsed)) {
					parsed.forEach((s, idx) => {
						if (!s) return; // skip null entries
						// Derive question number: prefer parsing from solution text (e.g. "50. (d) :")
						// because the AI often returns a compact array [null,sol1,sol2] instead of
						// a sparse array [null,...49 nulls...,sol50,sol51], making idx unreliable.
						const textQNum = (() => {
							const m = String(s.text || "").match(/^\s*(\d{1,3})\s*[.):]/);
							return m ? parseInt(m[1], 10) : null;
						})();
						const qNum = (textQNum && textQNum > 0) ? textQNum : (idx > 0 ? idx : null);
						if (!qNum) return;
						const localSrcIdx = typeof s.sourceImageIndex === "number"
							? Math.min(Math.max(0, s.sourceImageIndex), batchSize - 1)
							: 0;
						const globalSrcIdx = batch[localSrcIdx]?.globalIdx ?? startIdx;
						// Collect all image indexes
						const rawImgIdxs = Array.isArray(s.imageIndexes) ? s.imageIndexes : [localSrcIdx];
						const globalImgIdxs = [...new Set(rawImgIdxs.map(li => {
							const li2 = Math.min(Math.max(0, li), batchSize - 1);
							return batch[li2]?.globalIdx ?? startIdx;
						}))];
						const repairedText = repairSolutionLatex(normalizeSolutionText(s.text || ""));
						if (!solMap.has(qNum) || repairedText.length > (solMap.get(qNum).text || "").length) {
							solMap.set(qNum, {
								text: repairedText,
								sourceImageIndex: globalSrcIdx,
								imageIndexes: globalImgIdxs,
								hasDiagram: !!s.hasDiagram
							});
						}
					});
				}
			} catch (e) {
				console.warn("[extract-solutions] JSON parse failed for batch:", e.message);
			}
		}

		// Return solutionsByQNum: actual question number -> solution object
		// This allows the frontend to match by question number regardless of position
		const solutionsByQNum = {};
		for (const [qNum, s] of solMap.entries()) {
			const sol = {
				questionNumber: qNum,
				text: s.text,
				sourceImageIndex: s.sourceImageIndex,
				hasDiagram: s.hasDiagram,
				images: []
			};
			// Attach diagram images
			const imgIdxs = (Array.isArray(s.imageIndexes) && s.imageIndexes.length > 0)
				? s.imageIndexes : (s.hasDiagram ? [s.sourceImageIndex] : []);
			if (s.hasDiagram) {
				for (const imgIdx of imgIdxs) {
					const safeIdx = Math.min(imgIdx, solutionImages.length - 1);
					if (solutionImages[safeIdx]) sol.images.push(solutionImages[safeIdx]);
				}
				if (sol.images.length > 0) sol.image = sol.images[0]; // legacy compat
			}
			solutionsByQNum[qNum] = sol;
		}

		// Also build legacy dense array (Q1=index0) for backward compat
		const solutions = [];
		for (let qi = 1; qi <= qCount; qi++) {
			solutions.push(solMap.has(qi) ? solutionsByQNum[qi] : null);
		}
		while (solutions.length > 0 && solutions[solutions.length - 1] === null) solutions.pop();

		console.log(`[extract-solutions] Done: ${solMap.size} solutions. Q#s: [${[...solMap.keys()].sort((a, b) => a - b).join(",")}]`);
		res.json({ solutions, solutionsByQNum });
	} catch (e) {
		console.error("/api/admin/extract-solutions error:", e);
		res.status(500).json({ error: e.message || "Solution extraction failed" });
	}
});

// Extract solutions from PDF/DOCX
router.post("/api/admin/extract-solutions-doc", requireAdmin,
	multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } }).single("solutionFile"),
	async (req, res) => {
		try {
			const file = req.file;
			const questionCount = parseInt(req.body?.questionCount) || 500;
			if (!file) return res.status(400).json({ error: "No solution file uploaded" });

			let textContent = "";
			const isPdf = file.mimetype === "application/pdf" || file.originalname.endsWith(".pdf");

			if (isPdf) {
				// Extract text from PDF using pdftotext
				const { execSync } = require("child_process");
				const tmpIn = `/tmp/sol_${Date.now()}.pdf`;
				require("fs").writeFileSync(tmpIn, file.buffer);
				try {
					textContent = execSync(`pdftotext -layout "${tmpIn}" -`, { maxBuffer: 8 * 1024 * 1024 }).toString();
				} catch (e) {
					textContent = file.buffer.toString("utf8").replace(/[^\x20-\x7E\n]/g, " ");
				}
				try { require("fs").unlinkSync(tmpIn); } catch (e) { }
			} else {
				// DOCX: extract text using mammoth-style approach
				try {
					const mammoth = require("mammoth");
					const result = await mammoth.extractRawText({ buffer: file.buffer });
					textContent = result.value || "";
				} catch (e) {
					textContent = file.buffer.toString("utf8").replace(/[^\x20-\x7E\n]/g, " ");
				}
			}

			if (!textContent.trim()) {
				return res.json({ solutions: [] });
			}

			// Truncate to avoid token limits
			const truncated = textContent.slice(0, 8000);

			const raw = await callGroq(
				[{ type: "text", text: `SOLUTION DOCUMENT CONTENT:\n\n${truncated}` }],
				SOLUTION_SYSTEM,
				`Extract solutions for all ${questionCount} questions from the above document. IMPORTANT: preserve each step on a separate line using \\n in the text field — do NOT collapse multi-line solutions into one line. Return JSON array (index 0 = null, index 1 = Q1 solution, etc.)`,
				4000, 0.1
			);

			let solutions = [];
			try {
				const cleaned = sanitizeLatexJson(raw);
				const parsed = JSON.parse(cleaned);
				if (Array.isArray(parsed)) {
					solutions = parsed.slice(1).map(s => {
						if (!s) return null;
						return { text: repairSolutionLatex(normalizeSolutionText(s.text || "")), image: s.image || null };
					});
				}
			} catch (e) {
				console.warn("[extract-solutions-doc] JSON parse failed:", e.message);
			}

			res.json({ solutions });
		} catch (e) {
			console.error("/api/admin/extract-solutions-doc error:", e);
			res.status(500).json({ error: e.message || "Solution extraction failed" });
		}
	});

/* ──────────────────────────────────────────────────────────────────────────
   PYQ AUTO-TAGGER
   ────────────────────────────────────────────────────────────────────────── */

const JEE_SYLLABUS_CONTEXT = `PHYSICS: UNIT 1 MECHANICS: Units/Dimensions; Motion 1D; Motion 2D (Projectile,Vectors); Laws of Motion (Newton,Friction,Circular,Pulley); Work Power Energy; Center of Mass and Collision; Rotational Motion (Torque,Angular Momentum,Moment of Inertia); Gravitation (Kepler,Satellites,Escape Velocity). UNIT 2 PROPERTIES OF MATTER: Mechanical Properties of Solids (Stress,Strain,Elasticity,Young Modulus); Mechanical Properties of Fluids (Pressure,Surface Tension,Viscosity,Bernoulli). UNIT 3 THERMAL PHYSICS: Thermal Properties of Matter (Heat,Thermal Expansion,Calorimetry,Heat Transfer); Kinetic Theory of Gases (Ideal Gas,RMS Speed,Degrees of Freedom); Thermodynamics (Laws,Carnot,Isothermal,Adiabatic). UNIT 4 OSCILLATIONS AND WAVES: Simple Harmonic Motion (SHM,Spring,Pendulum,Energy); Waves (Sound,Doppler,Standing Waves,Resonance). UNIT 5 ELECTROSTATICS: Electric Charges and Fields (Coulomb Law,Electric Field,Gauss Law,Electric Flux); Electrostatic Potential and Capacitance (Electric Potential,Capacitors,Energy in Capacitor). UNIT 6 CURRENT ELECTRICITY: Current Electricity (Electric Current,Drift Velocity,Ohm Law,Kirchhoff Laws,Wheatstone Bridge,Potentiometer). UNIT 7 MAGNETISM: Moving Charges and Magnetism (Lorentz Force,Biot-Savart Law,Ampere Law,Cyclotron); Magnetism and Matter (Magnetic Dipole,Earth Magnetism,Para/Dia/Ferromagnetism). UNIT 8 ELECTROMAGNETIC INDUCTION AND AC: Electromagnetic Induction (Faraday Law,Lenz Law,Eddy Currents,Self Inductance); Alternating Current (RMS,LCR Circuits,Resonance,Transformers). UNIT 9 ELECTROMAGNETIC WAVES: Electromagnetic Waves (Maxwell Theory,EM Spectrum,Properties). UNIT 10 OPTICS: Ray Optics (Reflection,Refraction,Mirrors,Lenses,Optical Instruments); Wave Optics (Interference,Diffraction,Polarisation,YDSE). UNIT 11 MODERN PHYSICS: Dual Nature of Radiation and Matter (Photoelectric Effect,de Broglie Wavelength); Atoms (Rutherford,Bohr Model,Hydrogen Spectrum); Nuclei (Radioactivity,Binding Energy,Nuclear Reactions). UNIT 12 ELECTRONIC DEVICES: Semiconductor Electronics (PN Junction,Diode,Transistor,Logic Gates,Zener Diode). CHEMISTRY: UNIT 1 PHYSICAL CHEMISTRY: Some Basic Concepts (Mole Concept,Stoichiometry); Atomic Structure (Bohr Model,Quantum Numbers,Electronic Configuration); States of Matter (Gas Laws,Kinetic Theory); Thermodynamics (Enthalpy,Entropy,Gibbs Energy); Equilibrium (Chemical Equilibrium,Ionic Equilibrium,Buffer); Redox Reactions; Solutions (Colligative Properties,Raoult Law); Electrochemistry (Electrolysis,Nernst Equation,Conductance); Chemical Kinetics (Rate Law,Order,Arrhenius); Surface Chemistry (Adsorption,Catalysis,Colloids). UNIT 2 INORGANIC CHEMISTRY: Classification of Elements and Periodicity; Chemical Bonding (Ionic,Covalent,Hybridization,VSEPR,MOT); Hydrogen; s-Block Elements; p-Block Elements; d and f Block Elements; Coordination Compounds; Metallurgy; Environmental Chemistry. UNIT 3 ORGANIC CHEMISTRY: General Organic Chemistry (Electronic Effects,Reaction Intermediates); Hydrocarbons (Alkanes,Alkenes,Alkynes,Aromatic); Haloalkanes and Haloarenes; Alcohols Phenols Ethers; Aldehydes and Ketones; Carboxylic Acids; Amines; Biomolecules; Polymers; Chemistry in Everyday Life. MATHEMATICS: UNIT 1 SETS RELATIONS FUNCTIONS: Sets Relations Functions; Inverse Trigonometric Functions. UNIT 2 ALGEBRA: Complex Numbers and Quadratic Equations; Matrices; Determinants; Permutations and Combinations; Binomial Theorem; Sequence and Series; Probability; Statistics; Mathematical Reasoning. UNIT 3 TRIGONOMETRY: Trigonometric Ratios and Identities; Trigonometric Equations. UNIT 4 COORDINATE GEOMETRY: Straight Lines; Pair of Straight Lines; Circle; Parabola; Ellipse; Hyperbola. UNIT 5 CALCULUS: Limits; Continuity and Differentiability; Methods of Differentiation; Applications of Derivatives; Indefinite Integrals; Definite Integrals; Differential Equations. UNIT 6 VECTOR AND 3D GEOMETRY: Vector Algebra; Three Dimensional Geometry. UNIT 7 LINEAR PROGRAMMING: Linear Programming.`;


router.post("/api/admin/bulk-pdf-extract", requireAdmin, bulkUpload.single("pdf"), async (req, res) => {
	try {
		if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });
		if (!GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not set on server" });

		// Streaming NDJSON response
		res.setHeader("Content-Type", "application/x-ndjson");
		res.setHeader("Transfer-Encoding", "chunked");
		res.setHeader("Cache-Control", "no-cache");
		res.flushHeaders();

		const send = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch { } };

		// ── Step 1: Load PDF and convert each page to a JPEG image ──
		const pdfData = new Uint8Array(req.file.buffer);
		let doc;
		try {
			doc = await pdfjsLib.getDocument({
				data: pdfData,
				useSystemFonts: true,
				disableFontFace: true,
				canvasFactory: nodeCanvasFactory
			}).promise;
		} catch (pdfErr) {
			send({ type: "error", error: `Failed to parse PDF: ${pdfErr.message}` });
			res.end();
			return;
		}

		const totalPages = doc.numPages;
		send({ type: "start", totalPages });

		console.log(`[bulk-pdf-extract] PDF loaded: ${totalPages} pages. Using Groq (Llama 4 Scout Vision).`);

		// Convert each page to a compressed JPEG base64 image
		const pageImages = [];
		for (let p = 1; p <= totalPages; p++) {
			try {
				const page = await doc.getPage(p);
				const baseVP = page.getViewport({ scale: 1.0 });

				// Target ~1200px width for readability, capped at 2x scale
				let scale = Math.min(1200 / baseVP.width, 2.0);
				scale = Math.max(scale, 1.0);
				const viewport = page.getViewport({ scale });

				const w = Math.max(Math.floor(viewport.width), 1);
				const h = Math.max(Math.floor(viewport.height), 1);
				const canvas = createCanvas(w, h);
				const ctx = canvas.getContext('2d');
				await page.render({ canvasContext: ctx, viewport, canvasFactory: nodeCanvasFactory }).promise;

				// Encode as JPEG quality 70
				let jpegBuf = await canvas.encode('jpeg', 70);
				let b64 = jpegBuf.toString('base64');

				// If base64 exceeds ~180KB (NVIDIA NIM inline limit), re-render smaller
				if (b64.length > 180000) {
					const smallScale = scale * 0.65;
					const smallVP = page.getViewport({ scale: smallScale });
					const sw = Math.max(Math.floor(smallVP.width), 1);
					const sh = Math.max(Math.floor(smallVP.height), 1);
					const smallCanvas = createCanvas(sw, sh);
					const smallCtx = smallCanvas.getContext('2d');
					await page.render({ canvasContext: smallCtx, viewport: smallVP, canvasFactory: nodeCanvasFactory }).promise;
					jpegBuf = await smallCanvas.encode('jpeg', 50);
					b64 = jpegBuf.toString('base64');
				}

				pageImages.push({ page: p, base64: b64 });
			} catch (imgErr) {
				console.warn(`[bulk-pdf-extract] Page ${p} image conversion failed:`, imgErr.message);
				pageImages.push({ page: p, base64: null, error: imgErr.message });
			}
		}

		try { doc.destroy(); } catch { }

		console.log(`[bulk-pdf-extract] All ${totalPages} pages converted to images. Starting extraction via Groq…`);

		// ── Step 2: Extract questions page-by-page via Groq (1 at a time) ──
		const CONCURRENCY = 1;
		const INTER_REQUEST_DELAY = 800; // ms between requests per worker
		let allQuestions = [];
		let donePages = 0;
		const failedPages = []; // track for potential retry

		async function extractOnePage(pageImg) {
			if (!pageImg.base64) {
				donePages++;
				failedPages.push(pageImg.page);
				send({ type: "page_error", page: pageImg.page, error: `Image conversion failed: ${pageImg.error || "unknown"}` });
				return;
			}

			const MAX_PAGE_RETRIES = 2;
			for (let attempt = 1; attempt <= MAX_PAGE_RETRIES; attempt++) {
				try {
					const raw = await callGroq(
						[toImgPart(pageImg.base64)],
						BULK_PAGE_PROMPT,
						"Extract all questions, options, correct answers, and solutions from this JEE exam page image. Return ONLY a JSON array.",
						4096,
						0.1
					);
					const { questions, hadContent } = parseLLMJSON(raw);

					// If LLM returned text but we couldn't parse any questions, it might be a parse failure
					if (hadContent && questions.length === 0 && attempt < MAX_PAGE_RETRIES) {
						console.warn(`[bulk-pdf-extract] Page ${pageImg.page}: LLM returned content but 0 questions parsed, retrying…`);
						await sleep(2000);
						continue;
					}

					// Enrich with chapter/topic tags immediately
					const enriched = questions.map(q => {
						const chapter = predictChapterBulk(q.subject || "Physics", q.questionText || "");
						return { ...q, chapter, topic: chapter };
					});

					donePages++;
					const count = enriched.length;

					if (hadContent && count === 0) {
						// LLM responded but couldn't parse — report as soft error
						failedPages.push(pageImg.page);
						send({ type: "page_error", page: pageImg.page, error: `Page ${pageImg.page}: AI returned text but no questions could be parsed` });
					} else {
						send({
							type: "page", page: pageImg.page, questions: enriched, subject: "",
							count, statusMsg: `Page ${pageImg.page}: ${count} question(s) extracted`
						});
					}

					if (count > 0) allQuestions.push(...enriched);
					return; // success — exit retry loop
				} catch (err) {
					if (attempt < MAX_PAGE_RETRIES) {
						console.warn(`[bulk-pdf-extract] Page ${pageImg.page} attempt ${attempt} failed: ${err.message}, retrying in 3s…`);
						await sleep(3000);
						continue;
					}
					donePages++;
					failedPages.push(pageImg.page);
					console.error(`[bulk-pdf-extract] Page ${pageImg.page} extraction failed after ${MAX_PAGE_RETRIES} attempts:`, err.message);
					send({ type: "page_error", page: pageImg.page, error: `Page ${pageImg.page}: ${err.message}` });
				}
			}
		}

		// Process pages with concurrency limit of 2 + delay between requests
		let pageIdx = 0;
		async function worker() {
			while (pageIdx < pageImages.length) {
				const i = pageIdx++;
				await extractOnePage(pageImages[i]);
				// Small delay between requests to avoid rate limiting
				if (pageIdx < pageImages.length) await sleep(INTER_REQUEST_DELAY);
			}
		}
		const workers = [];
		for (let w = 0; w < Math.min(CONCURRENCY, pageImages.length); w++) workers.push(worker());
		await Promise.all(workers);

		// ── Step 3: Final summary ──
		if (allQuestions.length === 0) {
			send({
				type: "page_error", page: 1,
				error: `0 questions extracted from ${totalPages} pages. Check PDF format or Groq API key.`
			});
		}

		console.log(`[bulk-pdf-extract] Done: ${allQuestions.length} questions from ${totalPages} pages. Failed pages: ${failedPages.length}`);
		send({ type: "done", failedPages, totalExtracted: allQuestions.length });
		res.end();

	} catch (e) {
		console.error("/api/admin/bulk-pdf-extract error:", e);
		try { res.write(JSON.stringify({ type: "error", error: e.message }) + "\n"); res.end(); } catch { }
	}
});


module.exports = router;