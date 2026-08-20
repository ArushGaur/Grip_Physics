"use strict";
/**
 * Minimal, dependency-free XML reader used by the DOCX -> PDF renderer.
 * It is deliberately tiny: WordprocessingML is well-formed XML produced by
 * `docx`/Word, so we only need tags, attributes, text and CDATA.
 */

const ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
};

function decodeEntities(s) {
	if (!s || s.indexOf("&") === -1) return s;
	return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
		if (body[0] === "#") {
			const code =
				body[1] === "x" || body[1] === "X"
					? parseInt(body.slice(2), 16)
					: parseInt(body.slice(1), 10);
			if (!Number.isFinite(code) || code < 0) return m;
			try {
				return String.fromCodePoint(code);
			} catch (_) {
				return m;
			}
		}
		const v = ENTITIES[body.toLowerCase()];
		return v == null ? m : v;
	});
}

function findTagEnd(xml, from) {
	let quote = null;
	for (let i = from + 1; i < xml.length; i++) {
		const c = xml[i];
		if (quote) {
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		if (c === ">") return i;
	}
	return xml.length - 1;
}

function parseAttrs(str) {
	const attrs = {};
	if (!str) return attrs;
	const re = /([^\s="'<>\/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
	let m;
	while ((m = re.exec(str))) {
		attrs[m[1]] = decodeEntities(m[3] != null ? m[3] : m[4] || "");
	}
	return attrs;
}

/** Parse an XML string into a lightweight tree. */
function parseXml(xml) {
	const root = { name: "#root", attrs: {}, children: [] };
	if (!xml) return root;
	const stack = [root];
	const push = (node) => stack[stack.length - 1].children.push(node);
	let i = 0;
	while (i < xml.length) {
		const lt = xml.indexOf("<", i);
		if (lt < 0) {
			const t = xml.slice(i);
			if (t) push({ name: "#text", attrs: {}, children: [], text: decodeEntities(t) });
			break;
		}
		if (lt > i) {
			const t = xml.slice(i, lt);
			if (t) push({ name: "#text", attrs: {}, children: [], text: decodeEntities(t) });
		}
		if (xml.startsWith("<!--", lt)) {
			const e = xml.indexOf("-->", lt);
			i = e < 0 ? xml.length : e + 3;
			continue;
		}
		if (xml.startsWith("<![CDATA[", lt)) {
			const e = xml.indexOf("]]>", lt);
			const t = xml.slice(lt + 9, e < 0 ? xml.length : e);
			if (t) push({ name: "#text", attrs: {}, children: [], text: t });
			i = e < 0 ? xml.length : e + 3;
			continue;
		}
		if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
			const e = xml.indexOf(">", lt);
			i = e < 0 ? xml.length : e + 1;
			continue;
		}
		const gt = findTagEnd(xml, lt);
		const raw = xml.slice(lt + 1, gt);
		i = gt + 1;
		if (!raw) continue;
		if (raw[0] === "/") {
			const name = raw.slice(1).trim();
			// Close the nearest matching open element (tolerates stray tags).
			for (let s = stack.length - 1; s > 0; s--) {
				if (stack[s].name === name) {
					stack.length = s;
					break;
				}
			}
			continue;
		}
		const selfClose = raw.endsWith("/");
		const body = selfClose ? raw.slice(0, -1) : raw;
		const sp = body.search(/[\s]/);
		const name = sp === -1 ? body : body.slice(0, sp);
		const node = {
			name,
			attrs: sp === -1 ? {} : parseAttrs(body.slice(sp + 1)),
			children: [],
		};
		push(node);
		if (!selfClose) stack.push(node);
	}
	return root;
}

/** First direct child with this tag name (namespace prefix included). */
function ch(node, name) {
	if (!node || !node.children) return null;
	for (const c of node.children) if (c.name === name) return c;
	return null;
}

/** All direct children with this tag name. */
function all(node, name) {
	if (!node || !node.children) return [];
	return node.children.filter((c) => c.name === name);
}

/** First descendant (depth-first) with this tag name. */
function deep(node, name) {
	if (!node || !node.children) return null;
	for (const c of node.children) {
		if (c.name === name) return c;
		const r = deep(c, name);
		if (r) return r;
	}
	return null;
}

function attr(node, name) {
	return node && node.attrs ? node.attrs[name] : undefined;
}

/** <w:b/> style boolean: present => true unless w:val says otherwise. */
function boolVal(node) {
	if (!node) return undefined;
	const v = attr(node, "w:val");
	if (v == null) return true;
	const s = String(v).toLowerCase();
	return !(s === "0" || s === "false" || s === "off" || s === "none");
}

function numAttr(node, name) {
	const v = attr(node, name);
	if (v == null) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

/** Concatenated text of every #text descendant. */
function textOf(node) {
	if (!node) return "";
	if (node.name === "#text") return node.text || "";
	let out = "";
	for (const c of node.children || []) out += textOf(c);
	return out;
}

module.exports = { parseXml, ch, all, deep, attr, boolVal, numAttr, textOf, decodeEntities };
