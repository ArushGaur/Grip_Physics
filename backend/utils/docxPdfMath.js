"use strict";
/**
 * OMML (Office Math Markup Language) -> PDF layout engine.
 *
 * Word stores every equation in the generated papers as OMML (`m:oMath`).
 * LibreOffice/iLovePDF used to lay that out for us; now we do it ourselves.
 *
 * Everything is expressed as a "box":
 *   { w, asc, dsc, draw(x, baseline) }
 * `asc`/`dsc` are measured from the baseline, exactly like a font, so boxes
 * compose horizontally (a row) or vertically (fractions, limits) with correct
 * alignment.
 */

const { ch, all, attr, textOf } = require("./docxPdfXml");
const { pdfFont, segmentText, drawVectorGlyph, VECTOR_GLYPHS } = require("./docxPdfGlyphs");

const PROP_TAGS = new Set([
	"m:argPr", "m:ctrlPr", "m:fPr", "m:naryPr", "m:radPr", "m:dPr", "m:sSupPr",
	"m:sSubPr", "m:sSubSupPr", "m:sPrePr", "m:funcPr", "m:limLowPr", "m:limUppPr",
	"m:accPr", "m:barPr", "m:groupChrPr", "m:mPr", "m:mcPr", "m:mcs", "m:mc",
	"m:boxPr", "m:eqArrPr", "m:phantPr", "m:borderBoxPr", "m:rPr", "w:rPr",
	"m:mrPr", "m:count", "m:mcJc",
]);

class MathLayout {
	/** @param measurer  the shared TextMeasurer (see docxToPdf.js) */
	constructor(measurer) {
		this.m = measurer;
	}

	/* ── primitives ─────────────────────────────────────────────────── */

	emptyBox(st) {
		return { w: 0, asc: st.size * 0.7, dsc: st.size * 0.2, draw() {} };
	}

	/** A styled text box that understands Greek + vector glyphs. */
	textBox(text, st) {
		const m = this.m;
		const pieces = segmentText(text);
		const parts = [];
		let w = 0;
		let asc = st.size * 0.72;
		let dsc = st.size * 0.22;
		for (const p of pieces) {
			if (p.kind === "glyph") {
				const g = VECTOR_GLYPHS[p.chr];
				const gw = g.w * st.size;
				parts.push({ glyph: p.chr, x: w, w: gw });
				w += gw;
				asc = Math.max(asc, st.size * 0.75);
				continue;
			}
			const font = p.symbol ? "Symbol" : pdfFont(st.font, st.bold, st.italic);
			const tw = m.width(p.text, font, st.size);
			const met = m.metrics(font, st.size);
			asc = Math.max(asc, met.asc);
			dsc = Math.max(dsc, met.dsc);
			parts.push({ text: p.text, font, x: w, w: tw });
			w += tw;
		}
		const doc = m.doc;
		return {
			w,
			asc,
			dsc,
			draw: (x, baseline) => {
				for (const part of parts) {
					if (part.glyph) {
						drawVectorGlyph(doc, part.glyph, x + part.x, baseline, st.size, st.color);
						continue;
					}
					doc.save();
					doc.fillColor(st.color || "#000000");
					doc.font(part.font).fontSize(st.size);
					doc.text(part.text, x + part.x, baseline, {
						lineBreak: false,
						baseline: "alphabetic",
					});
					doc.restore();
				}
			},
		};
	}

	hbox(boxes, st, gap = 0) {
		const list = boxes.filter(Boolean);
		if (!list.length) return this.emptyBox(st);
		let w = 0;
		let asc = 0;
		let dsc = 0;
		for (let i = 0; i < list.length; i++) {
			w += list[i].w + (i ? gap : 0);
			asc = Math.max(asc, list[i].asc);
			dsc = Math.max(dsc, list[i].dsc);
		}
		return {
			w,
			asc,
			dsc,
			draw: (x, baseline) => {
				let cx = x;
				for (let i = 0; i < list.length; i++) {
					if (i) cx += gap;
					list[i].draw(cx, baseline);
					cx += list[i].w;
				}
			},
		};
	}

	sub(st, factor = 0.72) {
		return { ...st, size: Math.max(5, st.size * factor) };
	}

	/* ── dispatcher ─────────────────────────────────────────────────── */

	/** Layout a list of OMML nodes as one horizontal row. */
	row(nodes, st) {
		const boxes = [];
		for (const n of nodes || []) {
			if (!n || n.name === "#text") {
				if (n && n.text) boxes.push(this.textBox(n.text, st));
				continue;
			}
			if (PROP_TAGS.has(n.name)) continue;
			const b = this.box(n, st);
			if (b) boxes.push(b);
		}
		if (!boxes.length) return this.emptyBox(st);
		return this.hbox(boxes, st);
	}

	box(node, st) {
		if (!node) return null;
		switch (node.name) {
			case "m:oMathPara":
			case "m:oMath":
			case "m:e":
			case "m:num":
			case "m:den":
			case "m:box":
			case "m:sup":
			case "m:sub":
			case "m:lim":
			case "m:fName":
			case "m:deg":
			case "m:phant":
			case "m:borderBox":
				return this.row(node.children, st);
			case "m:r":
				return this.runBox(node, st);
			case "m:t":
				return this.textBox(textOf(node), st);
			case "m:f":
				return this.fraction(node, st);
			case "m:sSup":
				return this.script(node, st, true, false);
			case "m:sSub":
				return this.script(node, st, false, true);
			case "m:sSubSup":
				return this.script(node, st, true, true);
			case "m:sPre":
				return this.preScript(node, st);
			case "m:rad":
				return this.radical(node, st);
			case "m:d":
				return this.delimited(node, st);
			case "m:nary":
				return this.nary(node, st);
			case "m:func":
				return this.hbox([this.box(ch(node, "m:fName"), st), this.box(ch(node, "m:e"), st)], st, st.size * 0.12);
			case "m:limLow":
				return this.limit(node, st, false);
			case "m:limUpp":
				return this.limit(node, st, true);
			case "m:acc":
				return this.accent(node, st);
			case "m:bar":
				return this.bar(node, st);
			case "m:groupChr":
				return this.groupChr(node, st);
			case "m:m":
				return this.matrix(node, st);
			case "m:eqArr":
				return this.stack(all(node, "m:e").map((e) => this.box(e, st)), st);
			default:
				if (PROP_TAGS.has(node.name)) return null;
				if (node.children && node.children.length) return this.row(node.children, st);
				return null;
		}
	}

	/** m:r — a math run. Letters are italic (Word does the same). */
	runBox(node, st) {
		const rPr = ch(node, "m:rPr");
		const sty = rPr ? attr(ch(rPr, "m:sty"), "m:val") : undefined;
		const nor = rPr ? !!ch(rPr, "m:nor") : false;
		let text = "";
		for (const c of node.children || []) {
			if (c.name === "m:t") text += textOf(c);
			else if (c.name === "w:t") text += textOf(c);
		}
		if (!text) return null;
		let bold = st.bold;
		let forceUpright = nor;
		if (sty === "b") bold = true;
		else if (sty === "bi") bold = true;
		else if (sty === "p") forceUpright = true;

		// Split so that variables slant but digits / operators stay upright.
		const boxes = [];
		const re = /([A-Za-z]+)|([^A-Za-z]+)/g;
		let m;
		while ((m = re.exec(text))) {
			const chunk = m[0];
			const isAlpha = !!m[1];
			boxes.push(
				this.textBox(chunk, {
					...st,
					bold,
					italic: forceUpright ? false : isAlpha && chunk.length <= 3,
					font: "Times New Roman",
				})
			);
		}
		return this.hbox(boxes, st);
	}

	stack(boxes, st, gap = null) {
		const list = boxes.filter(Boolean);
		if (!list.length) return this.emptyBox(st);
		const g = gap == null ? st.size * 0.18 : gap;
		const w = Math.max(...list.map((b) => b.w));
		let total = 0;
		for (let i = 0; i < list.length; i++) total += list[i].asc + list[i].dsc + (i ? g : 0);
		const axis = st.size * 0.26;
		const asc = total / 2 + axis;
		return {
			w,
			asc,
			dsc: total - asc,
			draw: (x, baseline) => {
				let top = baseline - asc;
				for (let i = 0; i < list.length; i++) {
					if (i) top += g;
					const b = list[i];
					b.draw(x + (w - b.w) / 2, top + b.asc);
					top += b.asc + b.dsc;
				}
			},
		};
	}

	fraction(node, st) {
		const type = attr(ch(ch(node, "m:fPr"), "m:type"), "m:val");
		const numSt = st.size > 9 ? this.sub(st, 0.94) : st;
		const num = this.box(ch(node, "m:num"), numSt) || this.emptyBox(numSt);
		const den = this.box(ch(node, "m:den"), numSt) || this.emptyBox(numSt);
		if (type === "lin") {
			return this.hbox([num, this.textBox("/", st), den], st);
		}
		if (type === "skw") {
			return this.hbox([num, this.textBox("\u2044", st), den], st);
		}
		const noBar = type === "noBar";
		const pad = st.size * 0.28;
		const gap = st.size * 0.16;
		const axis = st.size * 0.28;
		const w = Math.max(num.w, den.w) + pad;
		const asc = axis + gap + num.dsc + num.asc;
		const dsc = -axis + gap + den.asc + den.dsc;
		const doc = this.m.doc;
		return {
			w,
			asc,
			dsc,
			draw: (x, baseline) => {
				const barY = baseline - axis;
				num.draw(x + (w - num.w) / 2, barY - gap - num.dsc);
				den.draw(x + (w - den.w) / 2, barY + gap + den.asc);
				if (!noBar) {
					doc.save();
					doc.strokeColor(st.color || "#000000");
					doc.lineWidth(Math.max(0.5, st.size * 0.05));
					doc.moveTo(x + pad * 0.2, barY).lineTo(x + w - pad * 0.2, barY).stroke();
					doc.restore();
				}
			},
		};
	}

	script(node, st, hasSup, hasSub) {
		const base = this.box(ch(node, "m:e"), st) || this.emptyBox(st);
		const small = this.sub(st);
		const sup = hasSup ? this.box(ch(node, "m:sup"), small) : null;
		const subB = hasSub ? this.box(ch(node, "m:sub"), small) : null;
		const supRise = st.size * 0.46;
		const subDrop = st.size * 0.22;
		const scriptW = Math.max(sup ? sup.w : 0, subB ? subB.w : 0);
		const w = base.w + scriptW + st.size * 0.05;
		const asc = Math.max(base.asc, sup ? supRise + sup.asc : 0);
		const dsc = Math.max(base.dsc, subB ? subDrop + subB.dsc : 0);
		return {
			w,
			asc,
			dsc,
			draw: (x, baseline) => {
				base.draw(x, baseline);
				const sx = x + base.w + st.size * 0.05;
				if (sup) sup.draw(sx, baseline - supRise);
				if (subB) subB.draw(sx, baseline + subDrop);
			},
		};
	}

	preScript(node, st) {
		const base = this.box(ch(node, "m:e"), st) || this.emptyBox(st);
		const small = this.sub(st);
		const sup = this.box(ch(node, "m:sup"), small);
		const subB = this.box(ch(node, "m:sub"), small);
		const supRise = st.size * 0.46;
		const subDrop = st.size * 0.22;
		const scriptW = Math.max(sup ? sup.w : 0, subB ? subB.w : 0);
		return {
			w: base.w + scriptW,
			asc: Math.max(base.asc, sup ? supRise + sup.asc : 0),
			dsc: Math.max(base.dsc, subB ? subDrop + subB.dsc : 0),
			draw: (x, baseline) => {
				if (sup) sup.draw(x + (scriptW - sup.w), baseline - supRise);
				if (subB) subB.draw(x + (scriptW - subB.w), baseline + subDrop);
				base.draw(x + scriptW, baseline);
			},
		};
	}

	radical(node, st) {
		const inner = this.box(ch(node, "m:e"), st) || this.emptyBox(st);
		const hideDeg = attr(ch(ch(node, "m:radPr"), "m:degHide"), "m:val");
		const degNode = ch(node, "m:deg");
		const degText = textOf(degNode).trim();
		const deg =
			hideDeg === "1" || hideDeg === "on" || !degText ? null : this.box(degNode, this.sub(st, 0.6));
		const hookW = st.size * 0.52;
		const degW = deg ? deg.w + st.size * 0.06 : 0;
		const padTop = st.size * 0.16;
		const padRight = st.size * 0.12;
		const w = degW + hookW + inner.w + padRight;
		const asc = inner.asc + padTop + Math.max(0, deg ? deg.asc * 0.2 : 0);
		const dsc = inner.dsc;
		const doc = this.m.doc;
		return {
			w,
			asc,
			dsc,
			draw: (x, baseline) => {
				const top = baseline - asc;
				const bottom = baseline + dsc;
				const hookX = x + degW;
				if (deg) deg.draw(x, top + deg.asc + st.size * 0.1);
				doc.save();
				doc.strokeColor(st.color || "#000000");
				doc.lineWidth(Math.max(0.5, st.size * 0.055));
				doc.lineJoin("round");
				doc
					.moveTo(hookX, bottom - (bottom - top) * 0.42)
					.lineTo(hookX + hookW * 0.28, bottom - (bottom - top) * 0.28)
					.lineTo(hookX + hookW * 0.62, bottom)
					.lineTo(hookX + hookW, top)
					.lineTo(x + w, top)
					.stroke();
				doc.restore();
				inner.draw(hookX + hookW + st.size * 0.06, baseline);
			},
		};
	}

	delimited(node, st) {
		const dPr = ch(node, "m:dPr");
		const beg = attr(ch(dPr, "m:begChr"), "m:val");
		const end = attr(ch(dPr, "m:endChr"), "m:val");
		const sep = attr(ch(dPr, "m:sepChr"), "m:val") || ",";
		const begChr = beg === undefined ? "(" : beg;
		const endChr = end === undefined ? ")" : end;
		const parts = all(node, "m:e").map((e) => this.box(e, st) || this.emptyBox(st));
		const inner = [];
		parts.forEach((p, i) => {
			if (i) inner.push(this.textBox(sep, st));
			inner.push(p);
		});
		const body = this.hbox(inner, st);
		const asc = Math.max(body.asc, st.size * 0.72) + st.size * 0.06;
		const dsc = Math.max(body.dsc, st.size * 0.22) + st.size * 0.06;
		const dw = (chr) => (chr ? st.size * 0.32 : 0);
		const wL = dw(begChr);
		const wR = dw(endChr);
		const doc = this.m.doc;
		const drawFence = (chr, x, baseline, left) => {
			if (!chr) return;
			const top = baseline - asc;
			const bottom = baseline + dsc;
			const mid = (top + bottom) / 2;
			const bulge = st.size * 0.2;
			doc.save();
			doc.strokeColor(st.color || "#000000");
			doc.lineWidth(Math.max(0.5, st.size * 0.055));
			const inset = st.size * 0.08;
			if (chr === "(" || chr === ")") {
				const dir = chr === "(" ? 1 : -1;
				const ax = left ? x + wL - inset : x + inset;
				doc
					.moveTo(ax, top)
					.bezierCurveTo(ax - dir * bulge, top + (bottom - top) * 0.2, ax - dir * bulge, bottom - (bottom - top) * 0.2, ax, bottom)
					.stroke();
			} else if (chr === "[" || chr === "]") {
				const dir = chr === "[" ? 1 : -1;
				const ax = left ? x + inset : x + wR - inset;
				doc.moveTo(ax + dir * st.size * 0.16, top).lineTo(ax, top).lineTo(ax, bottom).lineTo(ax + dir * st.size * 0.16, bottom).stroke();
			} else if (chr === "{" || chr === "}") {
				const dir = chr === "{" ? 1 : -1;
				const ax = left ? x + wL * 0.6 : x + wR * 0.4;
				doc
					.moveTo(ax + dir * st.size * 0.14, top)
					.bezierCurveTo(ax, top + st.size * 0.1, ax, mid - st.size * 0.1, ax - dir * st.size * 0.08, mid)
					.bezierCurveTo(ax, mid + st.size * 0.1, ax, bottom - st.size * 0.1, ax + dir * st.size * 0.14, bottom)
					.stroke();
			} else if (chr === "|" || chr === "\u2016") {
				const ax = left ? x + wL / 2 : x + wR / 2;
				doc.moveTo(ax, top).lineTo(ax, bottom).stroke();
				if (chr === "\u2016") doc.moveTo(ax + st.size * 0.1, top).lineTo(ax + st.size * 0.1, bottom).stroke();
			} else if (chr === "\u27e8" || chr === "\u27e9") {
				const ax = left ? x + wL : x;
				const dir = chr === "\u27e8" ? 1 : -1;
				doc.moveTo(ax, top).lineTo(ax - dir * wL * 0.8, mid).lineTo(ax, bottom).stroke();
			} else {
				doc.restore();
				const tb = this.textBox(chr, st);
				tb.draw(x, baseline);
				return;
			}
			doc.restore();
		};
		return {
			w: wL + body.w + wR,
			asc,
			dsc,
			draw: (x, baseline) => {
				drawFence(begChr, x, baseline, true);
				body.draw(x + wL, baseline);
				drawFence(endChr, x + wL + body.w, baseline, false);
			},
		};
	}

	nary(node, st) {
		const naryPr = ch(node, "m:naryPr");
		const chr = attr(ch(naryPr, "m:chr"), "m:val") || "\u2211";
		const limLoc = attr(ch(naryPr, "m:limLoc"), "m:val") || (chr === "\u222b" ? "subSup" : "undOvr");
		const subHide = attr(ch(naryPr, "m:subHide"), "m:val");
		const supHide = attr(ch(naryPr, "m:supHide"), "m:val");
		const small = this.sub(st, 0.62);
		const subB = subHide === "1" ? null : this.box(ch(node, "m:sub"), small);
		const supB = supHide === "1" ? null : this.box(ch(node, "m:sup"), small);
		const body = this.box(ch(node, "m:e"), st) || this.emptyBox(st);
		const opSize = st.size * 1.7;
		const glyph = VECTOR_GLYPHS[chr];
		const opBox = glyph
			? {
					w: glyph.w * opSize,
					asc: opSize * 0.72,
					dsc: opSize * 0.26,
					draw: (x, baseline) => drawVectorGlyph(this.m.doc, chr, x, baseline, opSize, st.color),
			  }
			: this.textBox(chr, { ...st, size: opSize });

		if (limLoc === "subSup") {
			const supRise = opBox.asc * 0.75;
			const subDrop = opBox.dsc * 0.85;
			const scriptW = Math.max(subB ? subB.w : 0, supB ? supB.w : 0);
			const w = opBox.w + scriptW + body.w + st.size * 0.14;
			return {
				w,
				asc: Math.max(opBox.asc, supB ? supRise + supB.asc : 0, body.asc),
				dsc: Math.max(opBox.dsc, subB ? subDrop + subB.dsc : 0, body.dsc),
				draw: (x, baseline) => {
					opBox.draw(x, baseline);
					const sx = x + opBox.w;
					if (supB) supB.draw(sx, baseline - supRise);
					if (subB) subB.draw(sx, baseline + subDrop);
					body.draw(sx + scriptW + st.size * 0.14, baseline);
				},
			};
		}
		// limits above / below the operator
		const opW = Math.max(opBox.w, subB ? subB.w : 0, supB ? supB.w : 0);
		const gap = st.size * 0.1;
		const asc = opBox.asc + (supB ? supB.asc + supB.dsc + gap : 0);
		const dsc = opBox.dsc + (subB ? subB.asc + subB.dsc + gap : 0);
		return {
			w: opW + body.w + st.size * 0.18,
			asc: Math.max(asc, body.asc),
			dsc: Math.max(dsc, body.dsc),
			draw: (x, baseline) => {
				opBox.draw(x + (opW - opBox.w) / 2, baseline);
				if (supB) supB.draw(x + (opW - supB.w) / 2, baseline - opBox.asc - gap - supB.dsc);
				if (subB) subB.draw(x + (opW - subB.w) / 2, baseline + opBox.dsc + gap + subB.asc);
				body.draw(x + opW + st.size * 0.18, baseline);
			},
		};
	}

	limit(node, st, upper) {
		const base = this.box(ch(node, "m:e"), st) || this.emptyBox(st);
		const lim = this.box(ch(node, "m:lim"), this.sub(st, 0.66)) || this.emptyBox(st);
		const gap = st.size * 0.08;
		const w = Math.max(base.w, lim.w);
		return {
			w,
			asc: base.asc + (upper ? lim.asc + lim.dsc + gap : 0),
			dsc: base.dsc + (upper ? 0 : lim.asc + lim.dsc + gap),
			draw: (x, baseline) => {
				base.draw(x + (w - base.w) / 2, baseline);
				if (upper) lim.draw(x + (w - lim.w) / 2, baseline - base.asc - gap - lim.dsc);
				else lim.draw(x + (w - lim.w) / 2, baseline + base.dsc + gap + lim.asc);
			},
		};
	}

	accent(node, st) {
		const base = this.box(ch(node, "m:e"), st) || this.emptyBox(st);
		const chr = attr(ch(ch(node, "m:accPr"), "m:chr"), "m:val") || "\u0302";
		const doc = this.m.doc;
		const lift = st.size * 0.08;
		return {
			w: base.w + st.size * 0.06,
			asc: base.asc + st.size * 0.22,
			dsc: base.dsc,
			draw: (x, baseline) => {
				base.draw(x, baseline);
				const y = baseline - base.asc - lift;
				const cx = x + base.w / 2;
				doc.save();
				doc.strokeColor(st.color || "#000000");
				doc.lineWidth(Math.max(0.45, st.size * 0.05));
				const half = Math.max(st.size * 0.18, base.w / 2 - st.size * 0.04);
				if (chr === "\u2192" || chr === "\u20d7") {
					doc.moveTo(cx - half, y).lineTo(cx + half, y).stroke();
					doc.moveTo(cx + half - st.size * 0.12, y - st.size * 0.09).lineTo(cx + half, y).lineTo(cx + half - st.size * 0.12, y + st.size * 0.09).stroke();
				} else if (chr === "\u0304" || chr === "\u00af" || chr === "\u2015") {
					doc.moveTo(cx - half, y).lineTo(cx + half, y).stroke();
				} else if (chr === "\u0307") {
					doc.circle(cx, y, Math.max(0.6, st.size * 0.055)).fill(st.color || "#000000");
				} else if (chr === "\u0303" || chr === "~") {
					doc.moveTo(cx - half, y).bezierCurveTo(cx - half / 2, y - st.size * 0.1, cx, y + st.size * 0.1, cx + half, y - st.size * 0.02).stroke();
				} else {
					// hat
					doc.moveTo(cx - half * 0.7, y).lineTo(cx, y - st.size * 0.13).lineTo(cx + half * 0.7, y).stroke();
				}
				doc.restore();
			},
		};
	}

	bar(node, st) {
		const base = this.box(ch(node, "m:e"), st) || this.emptyBox(st);
		const pos = attr(ch(ch(node, "m:barPr"), "m:pos"), "m:val") || "top";
		const doc = this.m.doc;
		const pad = st.size * 0.12;
		return {
			w: base.w + st.size * 0.06,
			asc: base.asc + (pos === "top" ? pad : 0),
			dsc: base.dsc + (pos === "top" ? 0 : pad),
			draw: (x, baseline) => {
				base.draw(x, baseline);
				const y = pos === "top" ? baseline - base.asc - pad * 0.6 : baseline + base.dsc + pad * 0.6;
				doc.save();
				doc.strokeColor(st.color || "#000000");
				doc.lineWidth(Math.max(0.45, st.size * 0.05));
				doc.moveTo(x, y).lineTo(x + base.w, y).stroke();
				doc.restore();
			},
		};
	}

	groupChr(node, st) {
		const base = this.box(ch(node, "m:e"), st) || this.emptyBox(st);
		const pr = ch(node, "m:groupChrPr");
		const chr = attr(ch(pr, "m:chr"), "m:val") || "\u23df";
		const pos = attr(ch(pr, "m:pos"), "m:val") || "bot";
		const glyphBox = this.textBox(chr, { ...st, size: st.size * 0.8 });
		return {
			w: Math.max(base.w, glyphBox.w),
			asc: base.asc + (pos === "top" ? st.size * 0.3 : 0),
			dsc: base.dsc + (pos === "top" ? 0 : st.size * 0.3),
			draw: (x, baseline) => {
				base.draw(x, baseline);
			},
		};
	}

	matrix(node, st) {
		const rows = all(node, "m:mr").map((mr) => all(mr, "m:e").map((e) => this.box(e, st) || this.emptyBox(st)));
		if (!rows.length) return this.emptyBox(st);
		const cols = Math.max(...rows.map((r) => r.length));
		const colW = [];
		for (let c = 0; c < cols; c++) colW[c] = Math.max(...rows.map((r) => (r[c] ? r[c].w : 0)));
		const colGap = st.size * 0.4;
		const rowGap = st.size * 0.2;
		const rowH = rows.map((r) => ({
			asc: Math.max(...r.map((b) => b.asc), st.size * 0.7),
			dsc: Math.max(...r.map((b) => b.dsc), st.size * 0.2),
		}));
		const totalH = rowH.reduce((a, r, i) => a + r.asc + r.dsc + (i ? rowGap : 0), 0);
		const axis = st.size * 0.26;
		const asc = totalH / 2 + axis;
		const w = colW.reduce((a, b) => a + b, 0) + colGap * (cols - 1);
		return {
			w,
			asc,
			dsc: totalH - asc,
			draw: (x, baseline) => {
				let top = baseline - asc;
				rows.forEach((r, ri) => {
					if (ri) top += rowGap;
					const bl = top + rowH[ri].asc;
					let cx = x;
					for (let c = 0; c < cols; c++) {
						const b = r[c];
						if (b) b.draw(cx + (colW[c] - b.w) / 2, bl);
						cx += colW[c] + colGap;
					}
					top += rowH[ri].asc + rowH[ri].dsc;
				});
			},
		};
	}
}

module.exports = { MathLayout };
