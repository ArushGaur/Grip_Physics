"use strict";
/**
 * ════════════════════════════════════════════════════════════════════════
 * DOCX → PDF, from scratch, in-process.
 *
 * No LibreOffice. No iLovePDF. No network. No API keys.
 *
 * We read the *final* .docx (after template merge + LaTeX→OMML post-processing)
 * and re-draw it onto a PDF with pdfkit, honouring the same geometry Word uses:
 *   • A4/whatever page size + margins from <w:sectPr>
 *   • headers & footers (incl. PAGE / NUMPAGES fields)
 *   • paragraph alignment, indents, spacing, borders, shading, lists
 *   • runs: bold / italic / underline / strike / size / colour / font / super-
 *     & subscript / highlight
 *   • tables: grid widths, gridSpan, vMerge, per-cell borders, shading,
 *     cell margins, vertical alignment, header-row repeat
 *   • inline images from word/media (PNG + JPEG) at their Word extents
 *   • equations: full OMML layout engine (see docxPdfMath.js)
 *
 * Because the paper generator builds its DOCX with fixed twip geometry
 * (10466 DXA content width, Arial 11pt, borderless option tables, …) the PDF
 * comes out line-for-line the same as the Word file.
 *
 * Usage:  const pdfBuffer = await docxToPdf(docxBuffer);
 * ════════════════════════════════════════════════════════════════════════
 */

const JSZip = require("jszip");
const PDFDocument = require("pdfkit");
const { parseXml, ch, all, deep, attr, boolVal, numAttr, textOf } = require("./docxPdfXml");
const { pdfFont, segmentText, drawVectorGlyph, VECTOR_GLYPHS } = require("./docxPdfGlyphs");
const { MathLayout } = require("./docxPdfMath");

const TWIP = 1 / 20;      // twentieths of a point -> pt
const EMU = 1 / 12700;    // English Metric Units  -> pt
const EIGHTH = 1 / 8;     // border sizes are in eighths of a point

const A4 = { w: 595.28, h: 841.89 };

/* ══ helpers ════════════════════════════════════════════════════════════ */

function hexColor(v, fallback) {
	if (v == null) return fallback;
	const s = String(v).trim();
	if (!s || s.toLowerCase() === "auto") return fallback;
	if (/^[0-9a-fA-F]{6}$/.test(s)) return "#" + s;
	if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
	const named = {
		black: "#000000", white: "#FFFFFF", red: "#FF0000", blue: "#0000FF",
		green: "#008000", yellow: "#FFFF00", darkBlue: "#00008B", gray: "#808080",
		lightGray: "#D3D3D3", cyan: "#00FFFF", magenta: "#FF00FF",
	};
	return named[s] || fallback;
}

function isSupportedImage(buf) {
	if (!buf || buf.length < 4) return false;
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
	return false;
}

/** Resolve a relationship target against a part's folder. */
function resolveTarget(partPath, target) {
	if (!target) return null;
	if (/^https?:/i.test(target)) return null;
	let t = String(target).replace(/\\/g, "/");
	if (t.startsWith("/")) return t.slice(1);
	const dir = partPath.includes("/") ? partPath.slice(0, partPath.lastIndexOf("/")) : "";
	const segs = (dir ? dir.split("/") : []).concat(t.split("/"));
	const out = [];
	for (const s of segs) {
		if (!s || s === ".") continue;
		if (s === "..") out.pop();
		else out.push(s);
	}
	return out.join("/");
}

/* ══ package ════════════════════════════════════════════════════════════ */

async function loadPackage(buffer) {
	const zip = await JSZip.loadAsync(buffer);
	const text = async (p) => {
		const f = zip.file(p);
		return f ? await f.async("string") : null;
	};

	const pkg = {
		document: parseXml((await text("word/document.xml")) || ""),
		rels: {},          // partPath -> { rId: target }
		parts: {},         // partPath -> parsed xml (headers/footers)
		media: {},         // path -> Buffer
		styles: { byId: {}, defaults: { rPr: null, pPr: null } },
		numbering: { nums: {}, abstracts: {} },
	};

	// relationships for document + every header/footer
	const relFiles = Object.keys(zip.files).filter((p) => /_rels\/[^/]+\.rels$/.test(p));
	for (const rp of relFiles) {
		const owner = rp.replace(/_rels\/([^/]+)\.rels$/, "$1");
		const xml = await text(rp);
		const map = {};
		if (xml) {
			for (const r of all(ch(parseXml(xml), "Relationships"), "Relationship")) {
				const id = attr(r, "Id");
				if (!id) continue;
				map[id] = {
					target: resolveTarget(owner, attr(r, "Target")),
					type: attr(r, "Type") || "",
					external: attr(r, "TargetMode") === "External",
				};
			}
		}
		pkg.rels[owner] = map;
	}

	// headers / footers
	for (const p of Object.keys(zip.files)) {
		if (/^word\/(header|footer)\d*\.xml$/.test(p)) {
			pkg.parts[p] = parseXml((await text(p)) || "");
		}
	}

	// media
	for (const p of Object.keys(zip.files)) {
		if (/^word\/media\//.test(p) && !zip.files[p].dir) {
			try {
				pkg.media[p] = await zip.file(p).async("nodebuffer");
			} catch (_) {}
		}
	}

	// styles
	const stylesXml = await text("word/styles.xml");
	if (stylesXml) {
		const root = ch(parseXml(stylesXml), "w:styles");
		const defs = ch(root, "w:docDefaults");
		pkg.styles.defaults.rPr = deep(ch(defs, "w:rPrDefault"), "w:rPr");
		pkg.styles.defaults.pPr = deep(ch(defs, "w:pPrDefault"), "w:pPr");
		for (const s of all(root, "w:style")) {
			const id = attr(s, "w:styleId");
			if (!id) continue;
			pkg.styles.byId[id] = {
				type: attr(s, "w:type") || "paragraph",
				basedOn: attr(ch(s, "w:basedOn"), "w:val") || null,
				rPr: ch(s, "w:rPr"),
				pPr: ch(s, "w:pPr"),
				default: boolVal(s.attrs["w:default"] ? { attrs: { "w:val": s.attrs["w:default"] } } : null),
			};
		}
	}

	// numbering
	const numXml = await text("word/numbering.xml");
	if (numXml) {
		const root = ch(parseXml(numXml), "w:numbering");
		for (const an of all(root, "w:abstractNum")) {
			const id = attr(an, "w:abstractNumId");
			const levels = {};
			for (const lvl of all(an, "w:lvl")) {
				levels[attr(lvl, "w:ilvl") || "0"] = {
					numFmt: attr(ch(lvl, "w:numFmt"), "w:val") || "decimal",
					lvlText: attr(ch(lvl, "w:lvlText"), "w:val") || "%1.",
					start: numAttr(ch(lvl, "w:start"), "w:val") || 1,
					ind: ch(ch(lvl, "w:pPr"), "w:ind"),
					rPr: ch(lvl, "w:rPr"),
				};
			}
			pkg.numbering.abstracts[id] = levels;
		}
		for (const n of all(root, "w:num")) {
			pkg.numbering.nums[attr(n, "w:numId")] = attr(ch(n, "w:abstractNumId"), "w:val");
		}
	}

	return pkg;
}

/* ══ text measuring ══════════════════════════════════════════════════════ */

class TextMeasurer {
	constructor(doc) {
		this.doc = doc;
		this._metrics = new Map();
	}
	width(text, font, size) {
		if (!text) return 0;
		try {
			this.doc.font(font).fontSize(size);
			return this.doc.widthOfString(text);
		} catch (_) {
			return text.length * size * 0.5;
		}
	}
	metrics(font, size) {
		const key = font;
		let m = this._metrics.get(key);
		if (!m) {
			let asc = 0.75;
			let dsc = 0.25;
			try {
				this.doc.font(font);
				const f = this.doc._font;
				if (f && Number.isFinite(f.ascender)) asc = f.ascender / 1000;
				if (f && Number.isFinite(f.descender)) dsc = Math.abs(f.descender) / 1000;
			} catch (_) {}
			m = { asc, dsc };
			this._metrics.set(key, m);
		}
		return { asc: m.asc * size, dsc: m.dsc * size };
	}
}

/* ══ style resolution ═══════════════════════════════════════════════════ */

const BASE_RUN = {
	font: "Arial",
	size: 11,
	bold: false,
	italic: false,
	underline: false,
	strike: false,
	color: "#000000",
	highlight: null,
	vertAlign: null,
	spacingPt: 0,
};

function applyRPr(style, rPr) {
	if (!rPr) return style;
	const out = { ...style };
	const fonts = ch(rPr, "w:rFonts");
	if (fonts) {
		const f = attr(fonts, "w:ascii") || attr(fonts, "w:hAnsi") || attr(fonts, "w:cs") || attr(fonts, "w:eastAsia");
		if (f) out.font = f;
	}
	const b = ch(rPr, "w:b");
	if (b) out.bold = boolVal(b);
	const i = ch(rPr, "w:i");
	if (i) out.italic = boolVal(i);
	const u = ch(rPr, "w:u");
	if (u) {
		const v = attr(u, "w:val");
		out.underline = !(v === "none");
	}
	const strike = ch(rPr, "w:strike");
	if (strike) out.strike = boolVal(strike);
	const sz = numAttr(ch(rPr, "w:sz"), "w:val");
	if (sz) out.size = sz / 2;
	const col = ch(rPr, "w:color");
	if (col) out.color = hexColor(attr(col, "w:val"), out.color);
	const hl = ch(rPr, "w:highlight");
	if (hl) out.highlight = hexColor(attr(hl, "w:val"), null);
	const shd = ch(rPr, "w:shd");
	if (shd) {
		const fill = hexColor(attr(shd, "w:fill"), null);
		if (fill && fill !== "#FFFFFF") out.highlight = fill;
	}
	const va = attr(ch(rPr, "w:vertAlign"), "w:val");
	if (va) out.vertAlign = va;
	const spacing = numAttr(ch(rPr, "w:spacing"), "w:val");
	if (spacing) out.spacingPt = spacing * TWIP;
	return out;
}

function styleChain(pkg, styleId, seen = new Set()) {
	const out = [];
	let id = styleId;
	while (id && !seen.has(id)) {
		seen.add(id);
		const s = pkg.styles.byId[id];
		if (!s) break;
		out.unshift(s);
		id = s.basedOn;
	}
	return out;
}

/* ══ renderer ═══════════════════════════════════════════════════════════ */

class DocxRenderer {
	constructor(pkg, doc, opts = {}) {
		this.pkg = pkg;
		this.doc = doc;
		this.measurer = new TextMeasurer(doc);
		this.math = new MathLayout(this.measurer);
		this.totalPages = opts.totalPages || null;
		this.sawNumPages = false;
		this.pageNo = 0;
		this.listCounters = {};
		this.body = ch(this.pkg.document, "w:document") ? ch(ch(this.pkg.document, "w:document"), "w:body") : null;
		this.readSection();
	}

	/* ── page geometry ────────────────────────────────────────────────── */
	readSection() {
		const sect = this.body ? ch(this.body, "w:sectPr") : null;
		this.sectPr = sect;
		const sz = ch(sect, "w:pgSz");
		let pw = numAttr(sz, "w:w");
		let ph = numAttr(sz, "w:h");
		this.pageW = pw ? pw * TWIP : A4.w;
		this.pageH = ph ? ph * TWIP : A4.h;
		if (String(attr(sz, "w:orient") || "").toLowerCase() === "landscape" && this.pageW < this.pageH) {
			const t = this.pageW;
			this.pageW = this.pageH;
			this.pageH = t;
		}
		const mar = ch(sect, "w:pgMar");
		const g = (n, d) => {
			const v = numAttr(mar, n);
			return (v == null ? d : v) * TWIP;
		};
		this.marTop = g("w:top", 1440);
		this.marBottom = Math.abs(g("w:bottom", 1440));
		this.marLeft = g("w:left", 1440);
		this.marRight = g("w:right", 1440);
		this.headerDist = g("w:header", 720);
		this.footerDist = g("w:footer", 720);
		this.contentWidth = Math.max(72, this.pageW - this.marLeft - this.marRight);

		// header / footer parts
		const refs = (name) => {
			const out = {};
			for (const r of all(sect, name)) {
				const type = attr(r, "w:type") || "default";
				const rel = (this.pkg.rels["word/document.xml"] || {})[attr(r, "r:id")];
				if (rel && rel.target && this.pkg.parts[rel.target]) out[type] = rel.target;
			}
			return out;
		};
		this.headerRefs = refs("w:headerReference");
		this.footerRefs = refs("w:footerReference");
		const titlePg = ch(sect, "w:titlePg");
		this.titlePg = titlePg ? boolVal(titlePg) : false;

        let defTabTwips = 720;
        const settingsRoot = this.pkg.parts["word/settings.xml"];
        if (settingsRoot) {
            const v = numAttr(deep(settingsRoot, "w:defaultTabStop"), "w:val");
            if (v) defTabTwips = v;
        }
        this.defaultTab = defTabTwips * TWIP;

        const pgb = ch(sect, "w:pgBorders");
        this.pageBorders = pgb
            ? {
                sides: this.readBorders(pgb),
                offsetFrom: String(attr(pgb, "w:offsetFrom") || "text"),
                space: {
                    top: numAttr(ch(pgb, "w:top"), "w:space"),
                    bottom: numAttr(ch(pgb, "w:bottom"), "w:space"),
                    left: numAttr(ch(pgb, "w:left") || ch(pgb, "w:start"), "w:space"),
                    right: numAttr(ch(pgb, "w:right") || ch(pgb, "w:end"), "w:space"),
                },
            }
            : null;
	}

	partBlocks(partPath) {
		const root = this.pkg.parts[partPath];
		if (!root) return [];
		const el = root.children.find((c) => /^w:(hdr|ftr)$/.test(c.name));
		return el ? this.blocksOf(el) : [];
	}

	blocksOf(node) {
		const out = [];
		const walk = (n) => {
			for (const c of n.children || []) {
				if (c.name === "w:p" || c.name === "w:tbl") out.push(c);
				else if (c.name === "w:sdt") {
					const content = ch(c, "w:sdtContent");
					if (content) walk(content);
				} else if (c.name === "w:sectPr" || c.name === "#text") {
					/* skip */
				}
			}
		};
		walk(node);
		return out;
	}

	/* ── main ───────────────────────────────────────────────────────── */
	render() {
		if (!this.body) {
			this.newPage();
			return;
		}
		const blocks = this.blocksOf(this.body);
		this.newPage();
		this.drawBlocks(blocks, this.marLeft, this.contentWidth, BASE_RUN);
	}

	get contentTop() {
		return Math.max(this.marTop, this._headerBottom || 0);
	}
	get contentBottom() {
		return Math.min(this.pageH - this.marBottom, this._footerTop || this.pageH - this.marBottom);
	}

	newPage() {
		this.pageNo += 1;
		if (this.pageNo === 1) {
			this.doc.addPage({ size: [this.pageW, this.pageH], margins: { top: 0, left: 0, right: 0, bottom: 0 } });
		} else {
			this.doc.addPage({ size: [this.pageW, this.pageH], margins: { top: 0, left: 0, right: 0, bottom: 0 } });
		}
		this._headerBottom = 0;
		this._footerTop = this.pageH - this.marBottom;
        this.drawPageBorders();
		this.drawHeader();
		this.drawFooter();
		this.y = this.contentTop;
	}

    drawPageBorders() {
        const pb = this.pageBorders;
        if (!pb) return;
        const s = pb.sides;
        if (!s.top && !s.bottom && !s.left && !s.right) return;
        const sp = (v, d) => (v == null ? d : v);
        let x1;
        let y1;
        let x2;
        let y2;
        if (pb.offsetFrom === "page") {
            x1 = sp(pb.space.left, 24);
            y1 = sp(pb.space.top, 24);
            x2 = this.pageW - sp(pb.space.right, 24);
            y2 = this.pageH - sp(pb.space.bottom, 24);
        } else {
            x1 = this.marLeft - sp(pb.space.left, 24);
            y1 = this.marTop - sp(pb.space.top, 24);
            x2 = this.pageW - this.marRight + sp(pb.space.right, 24);
            y2 = this.pageH - this.marBottom + sp(pb.space.bottom, 24);
        }
        x1 = Math.max(2, x1);
        y1 = Math.max(2, y1);
        x2 = Math.min(this.pageW - 2, x2);
        y2 = Math.min(this.pageH - 2, y2);
        const dbl = new Set(["double", "thickThinSmallGap", "thinThickSmallGap", "thickThinMediumGap", "thinThickMediumGap"]);
        const line = (ax, ay, bx, by, side) => {
            if (!side) return;
            try {
                this.doc.save().strokeColor(side.color || "#000000").lineWidth(side.width);
                if (side.style === "dotted") this.doc.dash(1, { space: 2 });
                else if (side.style === "dashed" || side.style === "dashSmallGap") this.doc.dash(3, { space: 2 });
                this.doc.moveTo(ax, ay).lineTo(bx, by).stroke().undash().restore();
            } catch (_) {}
        };
        const rect = (a, b, c, d) => {
            line(a, b, c, b, s.top);
            line(a, d, c, d, s.bottom);
            line(a, b, a, d, s.left);
            line(c, b, c, d, s.right);
        };
        rect(x1, y1, x2, y2);
        const anySide = s.top || s.bottom || s.left || s.right;
        if (anySide && dbl.has(anySide.style)) {
            const g = Math.max(1.2, anySide.width * 1.8);
            rect(x1 + g, y1 + g, x2 - g, y2 - g);
        }
    }

	pickRef(map) {
		if (!map) return null;
		if (this.pageNo === 1 && this.titlePg && map.first) return map.first;
		if (this.pageNo % 2 === 0 && map.even) return map.even;
		return map.default || map.first || map.even || null;
	}

	drawHeader() {
		const ref = this.pickRef(this.headerRefs);
		if (!ref) return;
		const blocks = this.partBlocks(ref);
		if (!blocks.length) return;
		const layouts = this.layoutBlocks(blocks, this.contentWidth, BASE_RUN);
		const h = layouts.reduce((a, l) => a + l.height, 0);
		this.drawLayouts(layouts, this.marLeft, this.headerDist, { noPaging: true });
		this._headerBottom = this.headerDist + h + 4;
	}

	drawFooter() {
		const ref = this.pickRef(this.footerRefs);
		if (!ref) return;
		const blocks = this.partBlocks(ref);
		if (!blocks.length) return;
		const layouts = this.layoutBlocks(blocks, this.contentWidth, BASE_RUN);
		const h = layouts.reduce((a, l) => a + l.height, 0);
		const top = this.pageH - Math.max(this.footerDist, this.marBottom * 0.5) - h;
		this.drawLayouts(layouts, this.marLeft, top, { noPaging: true });
		this._footerTop = Math.min(this.pageH - this.marBottom, top - 4);
	}

	/* ══ layout: blocks ═════════════════════════════════════════════════ */
	layoutBlocks(blocks, width, baseStyle) {
		const out = [];
		for (const b of blocks) {
			try {
				if (b.name === "w:p") out.push(this.layoutParagraph(b, width, baseStyle));
				else if (b.name === "w:tbl") out.push(this.layoutTable(b, width, baseStyle));
			} catch (e) {
				// A single broken block must never kill the whole PDF.
				out.push({ kind: "skip", height: 0 });
			}
		}
		return out;
	}

	drawBlocks(blocks, x, width, baseStyle) {
		for (const b of blocks) {
			try {
				if (b.name === "w:p") {
					const l = this.layoutParagraph(b, width, baseStyle);
					this.drawParagraph(l, x, null);
				} else if (b.name === "w:tbl") {
					const l = this.layoutTable(b, width, baseStyle);
					this.drawTable(l, x, null);
				}
			} catch (e) {
				console.warn("[docxToPdf] block skipped:", e && e.message);
			}
		}
	}

	/** Draw already-computed layouts at a fixed position (headers/footers/cells). */
	drawLayouts(layouts, x, y, opts = {}) {
		let cy = y;
		for (const l of layouts) {
			if (l.kind === "paragraph") this.drawParagraph(l, x, cy, opts);
			else if (l.kind === "table") this.drawTable(l, x, cy, opts);
			cy += l.height;
		}
		return cy - y;
	}

	/* ══ layout: paragraph ═════════════════════════════════════════════ */
	layoutParagraph(p, width, baseStyle) {
		const pPr = ch(p, "w:pPr");
		const pStyleId = attr(ch(pPr, "w:pStyle"), "w:val");

		// resolve style chain -> run defaults + paragraph props
		let runStyle = applyRPr({ ...BASE_RUN, ...baseStyle }, this.pkg.styles.defaults.rPr);
		const pPrStack = [];
		if (this.pkg.styles.defaults.pPr) pPrStack.push(this.pkg.styles.defaults.pPr);
		for (const s of styleChain(this.pkg, pStyleId)) {
			runStyle = applyRPr(runStyle, s.rPr);
			if (s.pPr) pPrStack.push(s.pPr);
		}
		if (pPr) pPrStack.push(pPr);
		const paraRunStyle = applyRPr(runStyle, ch(pPr, "w:rPr"));

		const pget = (tag) => {
			for (let i = pPrStack.length - 1; i >= 0; i--) {
				const n = ch(pPrStack[i], tag);
				if (n) return n;
			}
			return null;
		};

		const align = attr(pget("w:jc"), "w:val") || "left";
		const indNode = pget("w:ind");
		let indLeft = (numAttr(indNode, "w:left") ?? numAttr(indNode, "w:start") ?? 0) * TWIP;
		const indRight = (numAttr(indNode, "w:right") ?? numAttr(indNode, "w:end") ?? 0) * TWIP;
		let firstLine = (numAttr(indNode, "w:firstLine") || 0) * TWIP;
		const hanging = (numAttr(indNode, "w:hanging") || 0) * TWIP;
		if (hanging) firstLine = -hanging;

		const spacing = pget("w:spacing");
		const before = (numAttr(spacing, "w:before") || 0) * TWIP;
		const after = (numAttr(spacing, "w:after") || 0) * TWIP;
		const lineVal = numAttr(spacing, "w:line");
		const lineRule = attr(spacing, "w:lineRule") || "auto";
		const shd = pget("w:shd");
		const shading = shd ? hexColor(attr(shd, "w:fill"), null) : null;
		const borders = this.readBorders(pget("w:pBdr"));
		const keepNext = !!pget("w:keepNext");
		const tabs = all(pget("w:tabs"), "w:tab").map((t) => ({
			pos: (numAttr(t, "w:pos") || 0) * TWIP,
			val: attr(t, "w:val") || "left",
		}));

		// list bullet / number
		const numPr = pget("w:numPr");
		let listPrefix = null;
		if (numPr) {
			const numId = attr(ch(numPr, "w:numId"), "w:val");
			const ilvl = attr(ch(numPr, "w:ilvl"), "w:val") || "0";
			const absId = this.pkg.numbering.nums[numId];
			const lvl = absId != null ? (this.pkg.numbering.abstracts[absId] || {})[ilvl] : null;
			if (lvl) {
				const key = `${numId}:${ilvl}`;
				this.listCounters[key] = (this.listCounters[key] || lvl.start - 1) + 1;
				listPrefix = this.formatListLabel(lvl, this.listCounters[key]);
				if (lvl.ind) {
					const li = numAttr(lvl.ind, "w:left");
					if (li != null && !indNode) indLeft = li * TWIP;
				}
			} else {
				listPrefix = "\u2022";
			}
		}

		const availWidth = Math.max(18, width - indLeft - indRight);
		const items = this.paragraphItems(p, paraRunStyle, availWidth);
		if (listPrefix) {
			const atoms = this.textAtoms(listPrefix + "\u00a0", paraRunStyle);
			items.unshift({ k: "word", ...atoms });
		}

		const lines = this.wrapItems(items, availWidth, firstLine, tabs);
		const emptyH = this.measurer.metrics(pdfFont(paraRunStyle.font, paraRunStyle.bold, paraRunStyle.italic), paraRunStyle.size);
		if (!lines.length) {
			lines.push({ items: [], width: 0, asc: emptyH.asc, dsc: emptyH.dsc, h: emptyH.asc + emptyH.dsc, indent: firstLine });
		}

		// line spacing
		let extraFirst = 0;
		for (const ln of lines) {
			let h = ln.asc + ln.dsc;
			if (lineVal) {
				if (lineRule === "exact" || lineRule === "atLeast") {
					const exact = lineVal * TWIP;
					h = lineRule === "exact" ? exact : Math.max(h, exact);
				} else {
					h = h * (lineVal / 240);
				}
			} else {
				h = h * 1.06;
			}
			ln.h = h;
		}
		const borderPad = (borders.top ? 2 : 0) + (borders.bottom ? 2 : 0);
		const height = before + after + borderPad + lines.reduce((a, l) => a + l.h, 0) + extraFirst;

		return {
			kind: "paragraph",
			lines,
			height,
			before,
			after,
			align,
			indLeft,
			indRight,
			width,
			availWidth,
			shading,
			borders,
			keepNext,
			pageBreakBefore: !!pget("w:pageBreakBefore"),
		};
	}

	formatListLabel(lvl, n) {
		const fmt = lvl.numFmt;
		let val;
		switch (fmt) {
			case "bullet":
				return "\u2022";
			case "lowerLetter":
				val = String.fromCharCode(96 + ((n - 1) % 26) + 1);
				break;
			case "upperLetter":
				val = String.fromCharCode(64 + ((n - 1) % 26) + 1);
				break;
			case "lowerRoman":
				val = toRoman(n).toLowerCase();
				break;
			case "upperRoman":
				val = toRoman(n);
				break;
			case "none":
				return "";
			default:
				val = String(n);
		}
		return String(lvl.lvlText || "%1.").replace(/%\d/g, val);
	}

	/* ── inline items ─────────────────────────────────────────────────── */
	paragraphItems(p, baseStyle, availWidth) {
		const items = [];
		const fieldState = { instr: "", inField: 0, afterSeparate: false, suppress: false };

		const walk = (node, style) => {
			for (const c of node.children || []) {
				switch (c.name) {
					case "w:pPr":
					case "w:bookmarkStart":
					case "w:bookmarkEnd":
					case "w:proofErr":
					case "w:commentRangeStart":
					case "w:commentRangeEnd":
					case "w:del":
					case "#text":
						break;
					case "w:r":
						this.runItems(c, style, items, availWidth, fieldState);
						break;
					case "w:hyperlink": {
						const linkStyle = { ...style };
						walk(c, linkStyle);
						break;
					}
					case "w:ins":
					case "w:smartTag":
					case "w:sdt":
					case "w:sdtContent":
					case "m:oMathPara":
						if (c.name === "m:oMathPara") {
							for (const m of all(c, "m:oMath")) this.pushMath(m, style, items);
						} else {
							walk(c, style);
						}
						break;
					case "m:oMath":
						this.pushMath(c, style, items);
						break;
					case "w:fldSimple": {
						const instr = String(attr(c, "w:instr") || "");
						const txt = this.fieldText(instr);
						if (txt != null) {
							const rPr = deep(c, "w:rPr");
							this.pushText(txt, applyRPr(style, rPr), items);
						} else {
							walk(c, style);
						}
						break;
					}
					default:
						if (c.children && c.children.length) walk(c, style);
				}
			}
		};
		walk(p, baseStyle);
		return items;
	}

	fieldText(instr) {
		const s = String(instr || "").toUpperCase();
		if (/\bNUMPAGES\b/.test(s)) {
			this.sawNumPages = true;
			return String(this.totalPages || this.pageNo || 1);
		}
		if (/\bPAGE\b/.test(s)) return String(this.pageNo || 1);
		return null;
	}

	runItems(r, baseStyle, items, availWidth, fieldState) {
		const style = applyRPr(baseStyle, ch(r, "w:rPr"));
		for (const c of r.children || []) {
			switch (c.name) {
				case "w:rPr":
					break;
				case "w:t":
					if (fieldState.suppress) break;
					this.pushText(textOf(c), style, items, attr(c, "xml:space") === "preserve");
					break;
				case "w:delText":
					break;
				case "w:instrText":
					fieldState.instr += textOf(c);
					break;
				case "w:fldChar": {
					const t = attr(c, "w:fldCharType");
					if (t === "begin") {
						fieldState.inField += 1;
						fieldState.instr = "";
						fieldState.afterSeparate = false;
					} else if (t === "separate") {
						fieldState.afterSeparate = true;
						const txt = this.fieldText(fieldState.instr);
						if (txt != null) {
							this.pushText(txt, style, items);
							fieldState.suppress = true; // ignore Word's cached value
						}
					} else if (t === "end") {
						fieldState.inField = Math.max(0, fieldState.inField - 1);
						fieldState.suppress = false;
						fieldState.instr = "";
					}
					break;
				}
				case "w:tab":
					items.push({ k: "tab" });
					break;
				case "w:br": {
					const t = attr(c, "w:type");
					items.push(t === "page" ? { k: "pagebreak" } : { k: "break" });
					break;
				}
				case "w:cr":
					items.push({ k: "break" });
					break;
				case "w:noBreakHyphen":
					this.pushText("-", style, items);
					break;
				case "w:sym": {
					const code = attr(c, "w:char");
					if (code) {
						const n = parseInt(code, 16);
						if (Number.isFinite(n)) {
							const cp = n >= 0xf000 ? n - 0xf000 : n;
							this.pushText(String.fromCharCode(cp), style, items);
						}
					}
					break;
				}
				case "w:drawing":
				case "w:pict":
				case "w:object":
					this.pushImage(c, items, availWidth);
					break;
				case "m:oMath":
					this.pushMath(c, style, items);
					break;
				case "m:oMathPara":
					for (const m of all(c, "m:oMath")) this.pushMath(m, style, items);
					break;
				default:
					break;
			}
		}
	}

	/** Convert a string into measured word/space items. */
	pushText(text, style, items, preserve = true) {
		if (text == null || text === "") return;
		const str = String(text);
		if (str.indexOf("\t") >= 0) {
            const chunks = str.split(/(\t)/);
            for (const chunk of chunks) {
                if (chunk === "") continue;
                if (chunk === "\t") items.push({ k: "tab" });
                else this.pushText(chunk, style, items, preserve);
            }
            return;
        }
        const parts = str.split(/([^\S\t\u00a0]+)/);
		for (const part of parts) {
			if (!part) continue;
			if (/^[^\S\t\u00a0]+$/.test(part)) {
				const w = this.measurer.width(" ", pdfFont(style.font, style.bold, style.italic), this.effSize(style)) * part.length;
				const met = this.measurer.metrics(pdfFont(style.font, style.bold, style.italic), this.effSize(style));
				items.push({ k: "space", w, asc: met.asc, dsc: met.dsc, font: pdfFont(style.font, style.bold, style.italic), size: this.effSize(style), color: style.color, count: part.length });
				continue;
			}
			items.push({ k: "word", ...this.textAtoms(part, style) });
		}
	}

	effSize(style) {
		return style.vertAlign === "superscript" || style.vertAlign === "subscript"
			? Math.max(5, style.size * 0.62)
			: style.size;
	}

	/** Measure one word into drawable atoms. */
	textAtoms(word, style) {
		const size = this.effSize(style);
		const rise =
			style.vertAlign === "superscript" ? -style.size * 0.34 : style.vertAlign === "subscript" ? style.size * 0.16 : 0;
		const pieces = segmentText(word);
		const atoms = [];
		let w = 0;
		let asc = 0;
		let dsc = 0;
		for (const p of pieces) {
			if (p.kind === "glyph") {
				const g = VECTOR_GLYPHS[p.chr];
				const gw = g.w * size;
				atoms.push({ type: "glyph", chr: p.chr, x: w, w: gw, size, color: style.color, rise });
				w += gw;
				asc = Math.max(asc, size * 0.78 - rise);
				dsc = Math.max(dsc, size * 0.24 + rise);
				continue;
			}
			const font = p.symbol ? "Symbol" : pdfFont(style.font, style.bold, style.italic);
			let tw = this.measurer.width(p.text, font, size);
			if (style.spacingPt) tw += style.spacingPt * p.text.length;
			const met = this.measurer.metrics(font, size);
			atoms.push({
				type: "text",
				text: p.text,
				font,
				size,
				x: w,
				w: tw,
				color: style.color,
				underline: style.underline,
				strike: style.strike,
				highlight: style.highlight,
				charSpacing: style.spacingPt || 0,
				rise,
			});
			w += tw;
			asc = Math.max(asc, met.asc - rise);
			dsc = Math.max(dsc, met.dsc + rise);
		}
		return { atoms, w, asc, dsc };
	}

	pushMath(node, style, items) {
		try {
			const st = {
				size: style.size,
				bold: style.bold,
				italic: false,
				color: style.color,
				font: "Times New Roman",
			};
			const box = this.math.box(node, st);
			if (!box || !box.w) return;
			items.push({ k: "math", box, w: box.w, asc: box.asc, dsc: box.dsc });
		} catch (e) {
			const fallback = textOf(node);
			if (fallback) this.pushText(fallback, style, items);
		}
	}

	pushImage(node, items, availWidth) {
		try {
			let cx = 0;
			let cy = 0;
			let relId = null;

			const ext = deep(node, "wp:extent");
			if (ext) {
				cx = (numAttr(ext, "cx") || 0) * EMU;
				cy = (numAttr(ext, "cy") || 0) * EMU;
			}
			const blip = deep(node, "a:blip");
			if (blip) relId = attr(blip, "r:embed") || attr(blip, "r:link");

			if (!relId) {
				// VML fallback (<v:imagedata r:id=".."/> inside <w:pict>)
				const vml = deep(node, "v:imagedata");
				if (vml) relId = attr(vml, "r:id");
				const shape = deep(node, "v:shape");
				const styleStr = shape ? String(attr(shape, "style") || "") : "";
				const mw = /width:\s*([\d.]+)pt/i.exec(styleStr);
				const mh = /height:\s*([\d.]+)pt/i.exec(styleStr);
				if (mw) cx = parseFloat(mw[1]);
				if (mh) cy = parseFloat(mh[1]);
			}
			if (!relId) return;

			const rels = this.pkg.rels[this.currentPart || "word/document.xml"] || this.pkg.rels["word/document.xml"] || {};
			let rel = rels[relId];
			if (!rel) {
				for (const map of Object.values(this.pkg.rels)) {
					if (map[relId]) {
						rel = map[relId];
						break;
					}
				}
			}
			if (!rel || !rel.target) return;
			const buf = this.pkg.media[rel.target];
			if (!isSupportedImage(buf)) return;

			if (!cx || !cy) {
				cx = cx || 120;
				cy = cy || 90;
			}
			if (cx > availWidth) {
				const k = availWidth / cx;
				cx *= k;
				cy *= k;
			}
			items.push({ k: "image", buf, w: cx, h: cy, asc: cy, dsc: 0 });
		} catch (e) {
			/* ignore broken image */
		}
	}

	/* ── line breaking ────────────────────────────────────────────────── */
	wrapItems(items, maxWidth, firstLineIndent, tabs) {
		const lines = [];
		let cur = [];
		let curW = 0;
		let indent = firstLineIndent || 0;
		let pendingSpace = null;
		let pageBreak = false;

		const flush = (hard) => {
			const asc = cur.length ? Math.max(...cur.map((i) => i.asc || 0)) : 0;
			const dsc = cur.length ? Math.max(...cur.map((i) => i.dsc || 0)) : 0;
			lines.push({
				items: cur,
				width: curW,
				asc,
				dsc,
				h: asc + dsc,
				indent,
				hard: !!hard,
				pageBreakAfter: pageBreak,
			});
			pageBreak = false;
			cur = [];
			curW = 0;
			indent = 0;
			pendingSpace = null;
		};

		for (let ii = 0; ii < items.length; ii++) {
            const it = items[ii];
			if (it.k === "break") {
				flush(true);
				continue;
			}
			if (it.k === "pagebreak") {
				pageBreak = true;
				flush(true);
				continue;
			}
			if (it.k === "space") {
				if (!cur.length) continue;
				pendingSpace = it;
				continue;
			}
			if (it.k === "tab") {
                const from = indent + curW;
                const defTab = this.defaultTab || 36;
                let stop = null;
                for (const t of tabs || []) {
                    if (t.val === "clear") continue;
                    if (t.pos > from + 0.5) { stop = t; break; }
                }
                if (!stop) stop = { pos: (Math.floor(from / defTab) + 1) * defTab, val: "left" };
                let target = Math.min(stop.pos, Math.max(0, maxWidth));
                if (stop.val === "right" || stop.val === "center" || stop.val === "decimal") {
                    let seg = 0;
                    for (let j = ii + 1; j < items.length; j++) {
                        const nx = items[j];
                        if (nx.k === "tab" || nx.k === "break" || nx.k === "pagebreak") break;
                        seg += nx.w || 0;
                    }
                    target -= stop.val === "center" ? seg / 2 : seg;
                }
                const adv = target - from > 0.25 ? target - from : Math.max(2, defTab * 0.1);
                cur.push({ k: "gap", w: adv, asc: 0, dsc: 0 });
                curW += adv;
                pendingSpace = null;
                continue;
            }

			const spaceW = pendingSpace ? pendingSpace.w : 0;
			const needed = curW + spaceW + it.w;
			if (cur.length && needed > maxWidth - indent + 0.25) {
				flush(false);
			}
			if (cur.length && pendingSpace) {
				cur.push({ ...pendingSpace, k: "space" });
				curW += pendingSpace.w;
			}
			pendingSpace = null;

			// A single item wider than the line: let it overflow (Word clips too),
			// but split long unbreakable words so nothing disappears.
			if (it.k === "word" && it.w > maxWidth - indent && it.atoms.length > 1) {
				for (const atom of it.atoms) {
					const piece = { k: "word", atoms: [{ ...atom, x: 0 }], w: atom.w, asc: it.asc, dsc: it.dsc };
					if (cur.length && curW + piece.w > maxWidth - indent) flush(false);
					cur.push(piece);
					curW += piece.w;
				}
				continue;
			}

			cur.push(it);
			curW += it.w;
		}
		if (cur.length || pageBreak) flush(true);
		return lines;
	}

	/* ══ drawing: paragraph ════════════════════════════════════════════ */
	drawParagraph(layout, x, fixedY, opts = {}) {
		const flowing = fixedY == null;
		if (flowing && layout.pageBreakBefore && this.y > this.contentTop + 0.5) this.newPage();

		let y = flowing ? this.y : fixedY;
		y += layout.before;
		const startY = y;
		const boxX = x + layout.indLeft;
		const boxW = layout.availWidth;

		for (let li = 0; li < layout.lines.length; li++) {
			const line = layout.lines[li];
			if (flowing && !opts.noPaging && y + line.h > this.contentBottom && (li > 0 || this.y > this.contentTop + 0.5)) {
				this.drawParagraphDecoration(layout, boxX, startY, y, boxW, li === 0);
				this.newPage();
				y = this.y;
			}
			const baseline = y + line.asc;
			let lx = boxX + (line.indent || 0);
			const free = Math.max(0, boxW - (line.indent || 0) - line.width);
			let extraPerSpace = 0;
			if (layout.align === "center") lx += free / 2;
			else if (layout.align === "right" || layout.align === "end") lx += free;
			else if ((layout.align === "both" || layout.align === "justify") && !line.hard) {
				const spaces = line.items.filter((i) => i.k === "space").length;
				if (spaces) extraPerSpace = free / spaces;
			}

			for (const item of line.items) {
				if (item.k === "space") {
                        if (item.font) {
                            try {
                                this.doc.save();
                                this.doc.fillColor(item.color || "#000000");
                                this.doc.font(item.font).fontSize(item.size || 10);
                                this.doc.text(" ".repeat(Math.max(1, item.count || 1)), lx, baseline, { lineBreak: false, baseline: "alphabetic" });
                                this.doc.restore();
                            } catch (_) {}
                        }
                        lx += item.w + extraPerSpace;
                        continue;
                    }
				if (item.k === "gap") {
					lx += item.w;
					continue;
				}
				if (item.k === "word") {
					this.drawAtoms(item.atoms, lx, baseline);
					lx += item.w;
					continue;
				}
				if (item.k === "math") {
					try {
						item.box.draw(lx, baseline);
					} catch (_) {}
					lx += item.w;
					continue;
				}
				if (item.k === "image") {
					try {
						this.doc.image(item.buf, lx, baseline - item.h, { width: item.w, height: item.h });
					} catch (_) {}
					lx += item.w;
					continue;
				}
			}
			y += line.h;
			if (flowing && line.pageBreakAfter && !opts.noPaging) {
				this.drawParagraphDecoration(layout, boxX, startY, y, boxW, false);
				this.newPage();
				y = this.y;
			}
		}

		this.drawParagraphDecoration(layout, boxX, startY, y, boxW, true);
		y += layout.after;
		if (flowing) this.y = y;
		return y - (flowing ? startY - layout.before : fixedY);
	}

	drawParagraphDecoration(layout, x, top, bottom, width, withBottom) {
		if (layout.shading) {
			try {
				this.doc.save().rect(x, top, width, Math.max(0, bottom - top)).fill(layout.shading).restore();
			} catch (_) {}
		}
		const b = layout.borders;
		if (!b) return;
		const line = (x1, y1, x2, y2, spec) => {
			if (!spec) return;
			this.doc.save();
			this.doc.strokeColor(spec.color).lineWidth(spec.width);
			this.doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
			this.doc.restore();
		};
		line(x, top, x + width, top, b.top);
		if (withBottom) line(x, bottom, x + width, bottom, b.bottom);
		line(x, top, x, bottom, b.left);
		line(x + width, top, x + width, bottom, b.right);
	}

	drawAtoms(atoms, x, baseline) {
		for (const a of atoms) {
			const ax = x + a.x;
			const by = baseline + (a.rise || 0);
			if (a.type === "glyph") {
				drawVectorGlyph(this.doc, a.chr, ax, by, a.size, a.color);
				continue;
			}
			try {
				if (a.highlight) {
					const met = this.measurer.metrics(a.font, a.size);
					this.doc.save().rect(ax, by - met.asc, a.w, met.asc + met.dsc).fill(a.highlight).restore();
				}
				this.doc.save();
				this.doc.fillColor(a.color || "#000000");
				this.doc.font(a.font).fontSize(a.size);
				const tOpts = { lineBreak: false, baseline: "alphabetic" };
				if (a.charSpacing) tOpts.characterSpacing = a.charSpacing;
				this.doc.text(a.text, ax, by, tOpts);
				this.doc.restore();
				if (a.underline) {
					const uy = by + a.size * 0.12;
					this.doc.save().strokeColor(a.color || "#000000").lineWidth(Math.max(0.4, a.size * 0.05))
						.moveTo(ax, uy).lineTo(ax + a.w, uy).stroke().restore();
				}
				if (a.strike) {
					const sy = by - a.size * 0.26;
					this.doc.save().strokeColor(a.color || "#000000").lineWidth(Math.max(0.4, a.size * 0.045))
						.moveTo(ax, sy).lineTo(ax + a.w, sy).stroke().restore();
				}
			} catch (_) {}
		}
	}

	/* ══ borders ═══════════════════════════════════════════════════════ */
	readBorderSide(node) {
		if (!node) return null;
		const val = String(attr(node, "w:val") || "single");
		if (val === "none" || val === "nil") return null;
		const sz = numAttr(node, "w:sz");
		return {
			width: Math.max(0.4, (sz == null ? 4 : sz) * EIGHTH),
			color: hexColor(attr(node, "w:color"), "#000000"),
			style: val,
		};
	}

	readBorders(node) {
		if (!node) return { top: null, bottom: null, left: null, right: null, insideH: null, insideV: null };
		return {
			top: this.readBorderSide(ch(node, "w:top")),
			bottom: this.readBorderSide(ch(node, "w:bottom")),
			left: this.readBorderSide(ch(node, "w:left") || ch(node, "w:start")),
			right: this.readBorderSide(ch(node, "w:right") || ch(node, "w:end")),
			insideH: this.readBorderSide(ch(node, "w:insideH")),
			insideV: this.readBorderSide(ch(node, "w:insideV")),
		};
	}

	/* ══ layout: table ═════════════════════════════════════════════════ */
	layoutTable(tbl, availWidth, baseStyle) {
		const tblPr = ch(tbl, "w:tblPr");
		const tblBorders = this.readBorders(ch(tblPr, "w:tblBorders"));
		const cellMar = ch(tblPr, "w:tblCellMar");
		const marOf = (tag, def) => {
			const n = ch(cellMar, tag);
			const v = numAttr(n, "w:w");
			return (v == null ? def : v) * TWIP;
		};
		const defMar = { top: marOf("w:top", 0), bottom: marOf("w:bottom", 0), left: marOf("w:left", 108), right: marOf("w:right", 108) };
		const jc = attr(ch(tblPr, "w:jc"), "w:val") || "left";
		const tblIndNode = ch(tblPr, "w:tblInd");
		const tblInd = (numAttr(tblIndNode, "w:w") || 0) * TWIP;

		// grid
		let grid = all(ch(tbl, "w:tblGrid"), "w:gridCol").map((g) => (numAttr(g, "w:w") || 0) * TWIP);
		const rowsXml = all(tbl, "w:tr");
		if (!grid.length && rowsXml.length) {
			const n = Math.max(1, all(rowsXml[0], "w:tc").length);
			grid = new Array(n).fill(availWidth / n);
		}
		let total = grid.reduce((a, b) => a + b, 0);
		if (!total) {
			grid = grid.map(() => availWidth / Math.max(1, grid.length));
			total = availWidth;
		}
		if (total > availWidth + 0.5) {
			const k = availWidth / total;
			grid = grid.map((w) => w * k);
			total = availWidth;
		}
		let offsetX = tblInd;
		if (jc === "center") offsetX = Math.max(0, (availWidth - total) / 2);
		else if (jc === "right" || jc === "end") offsetX = Math.max(0, availWidth - total);

		const rows = [];
		for (const tr of rowsXml) {
			const trPr = ch(tr, "w:trPr");
			const heightNode = ch(trPr, "w:trHeight");
			const minH = (numAttr(heightNode, "w:val") || 0) * TWIP;
			const hRule = attr(heightNode, "w:hRule") || "atLeast";
			const isHeader = !!ch(trPr, "w:tblHeader");
			const cantSplit = !!ch(trPr, "w:cantSplit");
			const cells = [];
			let colIdx = 0;
			for (const tc of all(tr, "w:tc")) {
				const tcPr = ch(tc, "w:tcPr");
				const span = numAttr(ch(tcPr, "w:gridSpan"), "w:val") || 1;
				let w = 0;
				for (let i = 0; i < span; i++) w += grid[colIdx + i] || 0;
				if (!w) w = grid[colIdx] || total / Math.max(1, grid.length);
				const vMergeNode = ch(tcPr, "w:vMerge");
				const vMerge = vMergeNode ? attr(vMergeNode, "w:val") || "continue" : null;
				const tcMarNode = ch(tcPr, "w:tcMar");
				const m = { ...defMar };
				if (tcMarNode) {
					for (const side of ["top", "bottom", "left", "right"]) {
						const v = numAttr(ch(tcMarNode, "w:" + side), "w:w");
						if (v != null) m[side] = v * TWIP;
					}
				}
				const shdNode = ch(tcPr, "w:shd");
				const fill = shdNode ? hexColor(attr(shdNode, "w:fill"), null) : null;
				const vAlign = attr(ch(tcPr, "w:vAlign"), "w:val") || "top";
				const innerW = Math.max(8, w - m.left - m.right);
				const blocks = vMerge === "continue" ? [] : this.blocksOf(tc);
				const layouts = this.layoutBlocks(blocks, innerW, baseStyle);
				const contentH = layouts.reduce((a, l) => a + l.height, 0);
				cells.push({
					w,
					colIdx,
					span,
					layouts,
					contentH,
					margins: m,
					fill,
					vAlign,
					vMerge,
					borders: this.readBorders(ch(tcPr, "w:tcBorders")),
				});
				colIdx += span;
			}
			let h = 0;
			for (const c of cells) h = Math.max(h, c.contentH + c.margins.top + c.margins.bottom);
			if (minH) h = hRule === "exact" ? minH : Math.max(h, minH);
			rows.push({ cells, height: Math.max(h, 6), isHeader, cantSplit });
		}

		return {
			kind: "table",
			rows,
			grid,
			offsetX,
			width: total,
			borders: tblBorders,
			height: rows.reduce((a, r) => a + r.height, 0),
		};
	}

	drawTable(layout, x, fixedY, opts = {}) {
		const flowing = fixedY == null;
		let y = flowing ? this.y : fixedY;
		const rowCount = layout.rows.length;

		for (let ri = 0; ri < rowCount; ri++) {
			const row = layout.rows[ri];
			if (flowing && !opts.noPaging && y + row.height > this.contentBottom && y > this.contentTop + 0.5) {
				this.newPage();
				y = this.y;
			}
			const rowTop = y;
			const rowBottom = y + row.height;

			for (const cell of row.cells) {
				let cx = x + layout.offsetX;
				for (let i = 0; i < cell.colIdx; i++) cx += layout.grid[i] || 0;

				// shading
				if (cell.fill && cell.fill !== "#FFFFFF") {
					try {
						this.doc.save().rect(cx, rowTop, cell.w, row.height).fill(cell.fill).restore();
					} catch (_) {}
				}

				// borders (cell overrides table; table insideH/V for inner edges)
				const tb = layout.borders;
				const isFirstRow = ri === 0;
				const isLastRow = ri === rowCount - 1;
				const isFirstCol = cell.colIdx === 0;
				const isLastCol = cell.colIdx + cell.span >= layout.grid.length;
				const pick = (own, outer, inner, isEdge) => own || (isEdge ? outer : inner);
				const top = cell.vMerge === "continue" ? null : pick(cell.borders.top, tb.top, tb.insideH, isFirstRow);
				const bottom = pick(cell.borders.bottom, tb.bottom, tb.insideH, isLastRow);
				const left = pick(cell.borders.left, tb.left, tb.insideV, isFirstCol);
				const right = pick(cell.borders.right, tb.right, tb.insideV, isLastCol);
				const stroke = (x1, y1, x2, y2, spec) => {
					if (!spec) return;
					try {
						this.doc.save().strokeColor(spec.color).lineWidth(spec.width).moveTo(x1, y1).lineTo(x2, y2).stroke().restore();
					} catch (_) {}
				};
				stroke(cx, rowTop, cx + cell.w, rowTop, top);
				stroke(cx, rowBottom, cx + cell.w, rowBottom, bottom);
				stroke(cx, rowTop, cx, rowBottom, left);
				stroke(cx + cell.w, rowTop, cx + cell.w, rowBottom, right);

				if (!cell.layouts.length) continue;
				let cy = rowTop + cell.margins.top;
				const free = row.height - cell.margins.top - cell.margins.bottom - cell.contentH;
				if (free > 0) {
					if (cell.vAlign === "center") cy += free / 2;
					else if (cell.vAlign === "bottom") cy += free;
				}
				this.drawLayouts(cell.layouts, cx + cell.margins.left, cy, { noPaging: true });
			}
			y = rowBottom;
		}
		if (flowing) this.y = y;
		return y - (fixedY == null ? 0 : fixedY);
	}
}

function toRoman(num) {
	const map = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
	let n = Math.max(1, Math.floor(num));
	let out = "";
	for (const [v, s] of map) {
		while (n >= v) {
			out += s;
			n -= v;
		}
	}
	return out;
}

/* ══ public API ══════════════════════════════════════════════════════ */

function renderToBuffer(pkg, totalPages) {
	return new Promise((resolve, reject) => {
		let doc;
		try {
			doc = new PDFDocument({ autoFirstPage: false, compress: true, bufferPages: true });
		} catch (e) {
			return reject(e);
		}
		const chunks = [];
		doc.on("data", (c) => chunks.push(c));
		doc.on("error", reject);
		doc.on("end", () => {
			resolve({ buffer: Buffer.concat(chunks), pages: renderer.pageNo, sawNumPages: renderer.sawNumPages });
		});
		const renderer = new DocxRenderer(pkg, doc, { totalPages });
		try {
			renderer.render();
		} catch (e) {
			console.error("[docxToPdf] render error:", e && e.message);
		}
		doc.end();
	});
}

/**
 * Convert a .docx buffer into a PDF buffer.
 * Pure JS — no external binary, no HTTP call, no API key.
 */
async function docxToPdf(docxBuffer) {
	if (!docxBuffer || !docxBuffer.length) throw new Error("docxToPdf: empty input buffer");
	const pkg = await loadPackage(docxBuffer);

	// First pass. If the document asks for NUMPAGES we re-render once with the
	// real page count so "Page 1 of 7" style footers are correct.
	const first = await renderToBuffer(pkg, null);
	if (first.sawNumPages && first.pages > 0) {
		try {
			const second = await renderToBuffer(pkg, first.pages);
			return second.buffer;
		} catch (_) {
			return first.buffer;
		}
	}
	return first.buffer;
}

module.exports = { docxToPdf, loadPackage, DocxRenderer };
