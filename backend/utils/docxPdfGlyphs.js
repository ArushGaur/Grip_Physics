"use strict";
/**
 * Font + glyph layer for the DOCX -> PDF renderer.
 *
 * We only have the PDF base-14 fonts available (no TTF shipping, no fontconfig
 * on the server), so this module is what makes a Word document with Greek
 * letters and maths operators still come out looking right:
 *
 *   1. Latin / WinAnsi text  -> Helvetica / Times / Courier directly.
 *   2. Greek + a few symbols -> the base-14 `Symbol` font, addressed through
 *      its own ASCII slots (Symbol "a" IS alpha), which is encoding-safe.
 *   3. Everything else that matters in a physics/maths paper
 *      (<=, >=, !=, ->, sum, integral, set operators, ...) -> hand-drawn
 *      vector glyphs so they are always pixel-present, never a missing box.
 *   4. Anything left over falls back to a sane ASCII spelling.
 */

/* ── base-14 font picking ─────────────────────────────────────────────── */
function pdfFont(family, bold, italic) {
	const f = String(family || "").toLowerCase();
	let base = "helv";
	if (
		f.includes("times") ||
		f.includes("serif") ||
		f.includes("cambria") ||
		f.includes("georgia") ||
		f.includes("garamond") ||
		f.includes("book") ||
		f.includes("minion") ||
		f.includes("palatino")
	) {
		base = "times";
	} else if (f.includes("courier") || f.includes("mono") || f.includes("consol")) {
		base = "cour";
	}
	if (base === "times") {
		if (bold && italic) return "Times-BoldItalic";
		if (bold) return "Times-Bold";
		if (italic) return "Times-Italic";
		return "Times-Roman";
	}
	if (base === "cour") {
		if (bold && italic) return "Courier-BoldOblique";
		if (bold) return "Courier-Bold";
		if (italic) return "Courier-Oblique";
		return "Courier";
	}
	if (bold && italic) return "Helvetica-BoldOblique";
	if (bold) return "Helvetica-Bold";
	if (italic) return "Helvetica-Oblique";
	return "Helvetica";
}

/* ── Symbol-font slots ───────────────────────────────────────────────────
 * Only ASCII slots are used — 高 codes would go through WinAnsi re-encoding
 * and break. Lower-case Greek lives at a..z, capitals at A..Z. */
const GREEK_LOWER = "\u03b1\u03b2\u03c7\u03b4\u03b5\u03c6\u03b3\u03b7\u03b9\u03d5\u03ba\u03bb\u03bc\u03bd\u03bf\u03c0\u03b8\u03c1\u03c3\u03c4\u03c5\u03d6\u03c9\u03be\u03c8\u03b6";
const GREEK_UPPER = "\u0391\u0392\u03a7\u0394\u0395\u03a6\u0393\u0397\u0399\u03d1\u039a\u039b\u039c\u039d\u039f\u03a0\u0398\u03a1\u03a3\u03a4\u03a5\u03c2\u03a9\u039e\u03a8\u0396";

const SYMBOL_MAP = Object.create(null);
for (let i = 0; i < 26; i++) {
	SYMBOL_MAP[GREEK_LOWER[i]] = String.fromCharCode(97 + i);
	SYMBOL_MAP[GREEK_UPPER[i]] = String.fromCharCode(65 + i);
}
// A few extras that also live in Symbol's ASCII range.
Object.assign(SYMBOL_MAP, {
	"\u2200": '"',      // for all
	"\u2203": "$",      // there exists
	"\u220b": "'",      // contains as member
	"\u2217": "*",      // asterisk operator
	"\u2234": "\\",     // therefore
	"\u22a5": "^",      // perpendicular
	"\u223c": "~",      // tilde operator
	"\u2245": "@",      // congruent
	"\u03d1": "J",      // theta symbol
	"\u2032": "\u00a2", // prime (rendered via fallback below if unsafe)
});
delete SYMBOL_MAP["\u2032"]; // prime: use ASCII apostrophe instead (safer)

/* ── ASCII fall-backs ───────────────────────────────────────────────── */
const ASCII_FALLBACK = {
	"\u2212": "-",
	"\u2010": "-",
	"\u2011": "-",
	"\u00ad": "-",
	"\u2044": "/",
	"\u2215": "/",
	"\u2062": "",
	"\u2061": "",
	"\u2063": "",
	"\u200b": "",
	"\ufeff": "",
	"\u2032": "'",
	"\u2033": "''",
	"\u2213": "-/+",
	"\u22c5": "\u00b7",
	"\u2219": "\u00b7",
	"\u2022": "\u2022",
	"\u2026": "...",
	"\u22ef": "...",
	"\u2261": "=",
	"\u2248": "~",
	"\u221d": "\u00a4",
	"\u2205": "0",
	"\u2260": "!=",
	"\u2264": "<=",
	"\u2265": ">=",
	"\u226a": "<<",
	"\u226b": ">>",
	"\u2192": "->",
	"\u2190": "<-",
	"\u2194": "<->",
	"\u21d2": "=>",
	"\u21d0": "<=",
	"\u21d4": "<=>",
	"\u21cc": "<=>",
	"\u221e": "inf",
	"\u2208": " in ",
	"\u2209": " not in ",
	"\u2282": " sub ",
	"\u2286": " sub ",
	"\u222a": " U ",
	"\u2229": " n ",
	"\u2220": "angle ",
	"\u2207": "grad ",
	"\u2202": "d",
	"\u221a": "sqrt",
	"\u2211": "sum",
	"\u220f": "prod",
	"\u222b": "int",
	"\u00b0": "\u00b0",
};

// Characters above U+00FF that WinAnsi can still represent.
const WINANSI_EXTRA = new Set(
	"\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178".split("")
);

function isDirectlyRenderable(cp) {
	if (cp === 9 || cp === 10 || cp === 13) return true;
	if (cp < 0x20) return false;
	if (cp <= 0xff) return true;
	return WINANSI_EXTRA.has(String.fromCodePoint(cp));
}

/* ── hand-drawn vector glyphs ──────────────────────────────────────────
 * Coordinates are in em units: x grows right from the glyph origin, y grows
 * UP from the text baseline. `w` is the advance width in em. */
const V = (w, segs) => ({ w, segs });
const L = (...pts) => ({ poly: pts });
const E = (cx, cy, rx, ry) => ({ ellipse: [cx, cy, rx, ry] });
const B = (...pts) => ({ bez: pts }); // [x0,y0, c1x,c1y,c2x,c2y, x,y, ...]

const VECTOR_GLYPHS = {
	"\u2264": V(0.84, [L([0.70, 0.60], [0.10, 0.33], [0.70, 0.06]), L([0.10, -0.14], [0.70, -0.14])]),
	"\u2265": V(0.84, [L([0.14, 0.60], [0.74, 0.33], [0.14, 0.06]), L([0.14, -0.14], [0.74, -0.14])]),
	"\u2260": V(0.80, [L([0.10, 0.40], [0.70, 0.40]), L([0.10, 0.16], [0.70, 0.16]), L([0.28, -0.08], [0.52, 0.64])]),
	"\u2261": V(0.80, [L([0.10, 0.46], [0.70, 0.46]), L([0.10, 0.28], [0.70, 0.28]), L([0.10, 0.10], [0.70, 0.10])]),
	"\u2248": V(0.80, [
		B([0.10, 0.40], [0.24, 0.54], [0.34, 0.24], [0.46, 0.36], [0.56, 0.46], [0.62, 0.46], [0.70, 0.40]),
		B([0.10, 0.16], [0.24, 0.30], [0.34, 0.00], [0.46, 0.12], [0.56, 0.22], [0.62, 0.22], [0.70, 0.16]),
	]),
	"\u221e": V(0.92, [E(0.28, 0.28, 0.18, 0.16), E(0.64, 0.28, 0.18, 0.16)]),
	"\u2192": V(0.96, [L([0.06, 0.28], [0.86, 0.28]), L([0.66, 0.46], [0.86, 0.28], [0.66, 0.10])]),
	"\u2190": V(0.96, [L([0.10, 0.28], [0.90, 0.28]), L([0.30, 0.46], [0.10, 0.28], [0.30, 0.10])]),
	"\u2194": V(1.0, [L([0.12, 0.28], [0.88, 0.28]), L([0.30, 0.44], [0.12, 0.28], [0.30, 0.12]), L([0.70, 0.44], [0.88, 0.28], [0.70, 0.12])]),
	"\u21d2": V(1.0, [L([0.06, 0.38], [0.72, 0.38]), L([0.06, 0.20], [0.72, 0.20]), L([0.60, 0.54], [0.90, 0.29], [0.60, 0.04])]),
	"\u21d0": V(1.0, [L([0.28, 0.38], [0.94, 0.38]), L([0.28, 0.20], [0.94, 0.20]), L([0.40, 0.54], [0.10, 0.29], [0.40, 0.04])]),
	"\u21d4": V(1.1, [L([0.24, 0.38], [0.86, 0.38]), L([0.24, 0.20], [0.86, 0.20]), L([0.36, 0.52], [0.08, 0.29], [0.36, 0.06]), L([0.74, 0.52], [1.02, 0.29], [0.74, 0.06])]),
	"\u21cc": V(1.1, [L([0.16, 0.40], [0.92, 0.40]), L([0.74, 0.54], [0.92, 0.40]), L([0.16, 0.16], [0.92, 0.16]), L([0.34, 0.02], [0.16, 0.16])]),
	"\u2208": V(0.72, [
		B([0.60, 0.60], [0.20, 0.60], [0.06, 0.44], [0.06, 0.28], [0.06, 0.12], [0.20, -0.04], [0.60, -0.04]),
		L([0.14, 0.28], [0.54, 0.28]),
	]),
	"\u2209": V(0.72, [
		B([0.60, 0.60], [0.20, 0.60], [0.06, 0.44], [0.06, 0.28], [0.06, 0.12], [0.20, -0.04], [0.60, -0.04]),
		L([0.14, 0.28], [0.54, 0.28]),
		L([0.20, -0.14], [0.50, 0.68]),
	]),
	"\u2282": V(0.80, [B([0.68, 0.58], [0.14, 0.58], [0.06, 0.34], [0.06, 0.26], [0.06, 0.18], [0.14, -0.06], [0.68, -0.06])]),
	"\u2286": V(0.80, [B([0.68, 0.60], [0.14, 0.60], [0.06, 0.36], [0.06, 0.28], [0.06, 0.20], [0.14, -0.02], [0.68, -0.02]), L([0.10, -0.16], [0.70, -0.16])]),
	"\u2283": V(0.80, [B([0.12, 0.58], [0.66, 0.58], [0.74, 0.34], [0.74, 0.26], [0.74, 0.18], [0.66, -0.06], [0.12, -0.06])]),
	"\u2287": V(0.80, [B([0.12, 0.60], [0.66, 0.60], [0.74, 0.36], [0.74, 0.28], [0.74, 0.20], [0.66, -0.02], [0.12, -0.02]), L([0.10, -0.16], [0.70, -0.16])]),
	"\u222a": V(0.82, [{ poly: [[0.12, 0.58], [0.12, 0.16]] }, B([0.12, 0.16], [0.12, -0.06], [0.28, -0.10], [0.44, -0.10], [0.60, -0.10], [0.72, -0.06], [0.72, 0.16]), { poly: [[0.72, 0.16], [0.72, 0.58]] }]),
	"\u2229": V(0.82, [{ poly: [[0.12, -0.06], [0.12, 0.36]] }, B([0.12, 0.36], [0.12, 0.58], [0.28, 0.62], [0.44, 0.62], [0.60, 0.62], [0.72, 0.58], [0.72, 0.36]), { poly: [[0.72, 0.36], [0.72, -0.06]] }]),
	"\u2205": V(0.72, [E(0.36, 0.28, 0.24, 0.30), L([0.10, -0.06], [0.62, 0.62])]),
	"\u2220": V(0.86, [L([0.08, 0.0], [0.80, 0.0]), L([0.08, 0.0], [0.74, 0.58])]),
	"\u2207": V(0.88, [L([0.06, 0.66], [0.82, 0.66], [0.44, -0.04], [0.06, 0.66])]),
	"\u2202": V(0.62, [
		B([0.52, 0.66], [0.28, 0.72], [0.10, 0.60], [0.16, 0.44], [0.24, 0.26], [0.52, 0.40], [0.50, 0.20]),
		B([0.50, 0.20], [0.48, 0.02], [0.30, -0.06], [0.20, 0.02], [0.10, 0.10], [0.12, 0.28], [0.28, 0.30]),
	]),
	"\u221d": V(0.90, [
		B([0.10, 0.10], [0.10, 0.44], [0.44, 0.44], [0.44, 0.27], [0.44, 0.10], [0.10, 0.10], [0.10, 0.27]),
		B([0.44, 0.27], [0.52, 0.44], [0.84, 0.44], [0.84, 0.27], [0.84, 0.10], [0.52, 0.10], [0.44, 0.27]),
	]),
	// Big operators — drawn at the size handed in, so n-ary scaling just works.
	"\u2211": V(0.92, [L([0.82, 0.70], [0.10, 0.70], [0.48, 0.24], [0.10, -0.24], [0.82, -0.24]), L([0.82, 0.70], [0.82, 0.52]), L([0.82, -0.24], [0.82, -0.06])]),
	"\u220f": V(0.92, [L([0.06, 0.68], [0.86, 0.68]), L([0.24, 0.68], [0.24, -0.24]), L([0.68, 0.68], [0.68, -0.24])]),
	"\u222b": V(0.56, [
		B([0.42, 0.72], [0.30, 0.82], [0.20, 0.74], [0.22, 0.52], [0.26, 0.16], [0.30, -0.10], [0.20, -0.22]),
		B([0.20, -0.22], [0.12, -0.30], [0.04, -0.22], [0.08, -0.12]),
	]),
	"\u221a": V(0.72, [L([0.04, 0.26], [0.18, 0.20], [0.34, 0.64], [0.68, 0.64])]),
};

/** Draw one vector glyph. */
function drawVectorGlyph(doc, chr, x, baseline, size, color) {
	const g = VECTOR_GLYPHS[chr];
	if (!g) return;
	const px = (v) => x + v * size;
	const py = (v) => baseline - v * size;
	doc.save();
	doc.strokeColor(color || "#000000");
	doc.lineWidth(Math.max(0.45, size * 0.055));
	doc.lineJoin("round");
	doc.lineCap("round");
	for (const seg of g.segs) {
		if (seg.poly) {
			const p = seg.poly;
			doc.moveTo(px(p[0][0]), py(p[0][1]));
			for (let i = 1; i < p.length; i++) doc.lineTo(px(p[i][0]), py(p[i][1]));
			doc.stroke();
		} else if (seg.ellipse) {
			const [cx, cy, rx, ry] = seg.ellipse;
			doc.ellipse(px(cx), py(cy), rx * size, ry * size).stroke();
		} else if (seg.bez) {
			const p = seg.bez;
			doc.moveTo(px(p[0][0]), py(p[0][1]));
			for (let i = 1; i + 2 < p.length; i += 3) {
				doc.bezierCurveTo(
					px(p[i][0]), py(p[i][1]),
					px(p[i + 1][0]), py(p[i + 1][1]),
					px(p[i + 2][0]), py(p[i + 2][1])
				);
			}
			doc.stroke();
		}
	}
	doc.restore();
}

/**
 * Break a string into drawable pieces.
 * Each piece: { kind: "text", text, symbol? } | { kind: "glyph", chr }
 */
function segmentText(input) {
	const out = [];
	const pushText = (t, symbol) => {
		if (!t) return;
		const last = out[out.length - 1];
		if (last && last.kind === "text" && !!last.symbol === !!symbol) last.text += t;
		else out.push({ kind: "text", text: t, symbol: !!symbol });
	};
	const str = String(input == null ? "" : input);
	for (const chr of str) {
		const cp = chr.codePointAt(0);
		if (isDirectlyRenderable(cp)) {
			pushText(chr, false);
			continue;
		}
		if (VECTOR_GLYPHS[chr]) {
			out.push({ kind: "glyph", chr });
			continue;
		}
		const sym = SYMBOL_MAP[chr];
		if (sym) {
			pushText(sym, true);
			continue;
		}
		const fb = ASCII_FALLBACK[chr];
		if (fb != null) {
			pushText(fb, false);
			continue;
		}
		// Last resort: drop it rather than emit a garbage box.
		pushText("", false);
	}
	return out;
}

module.exports = {
	pdfFont,
	segmentText,
	drawVectorGlyph,
	VECTOR_GLYPHS,
	SYMBOL_MAP,
	ASCII_FALLBACK,
};
