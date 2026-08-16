/**
 * ─────────────────────────────────────────────────────────────────────────
 * SVG SUPPORT (AI-drawn diagrams)
 *
 * The extraction prompt now asks the AI to DRAW every diagram, graph, circuit,
 * ray diagram and molecular structure as inline SVG markup and ship it inside
 * the same JSON as the question. That removes the manual "paste the cropped
 * screenshot" step in the developer panel.
 *
 * Rather than introducing a new storage field everywhere (which would mean
 * touching every renderer, the DOCX builder, the student app, the paper
 * builder...), an SVG is converted ONCE at ingest time into a data URI:
 *
 *     data:image/svg+xml;base64,PHN2ZyB4bWxucz0i...
 *
 * Every existing image field already accepts a data URI, so SVG diagrams flow
 * through `questionImages`, `optionImages`, table image cells and solution
 * images with zero schema change.
 *
 * SECURITY: SVG is XML and can carry <script>, event handlers and external
 * references. We (a) sanitize the markup here, and (b) only ever render it via
 * <img src="data:..."> on the client, which is a sandboxed image context where
 * scripts never execute. Never inject raw SVG into innerHTML.
 * ─────────────────────────────────────────────────────────────────────────
 */

// Hard cap so one pathological question can't blow up a row / the DOM.
const MAX_SVG_CHARS = 120000;

function looksLikeSvgMarkup(value) {
	return typeof value === "string" && /<svg[\s>]/i.test(value);
}

function isSvgDataUri(value) {
	return typeof value === "string" && /^data:image\/svg\+xml/i.test(value.trim());
}

/**
 * Strip anything executable or externally-referencing out of SVG markup and
 * return clean `<svg>…</svg>` text. Returns null when the input isn't usable.
 */
function sanitizeSvg(raw) {
	let s = String(raw == null ? "" : raw).trim();
	if (!s) return null;

	// Some models wrap the markup in a code fence — unwrap it.
	s = s.replace(/^```(?:svg|xml|html)?\s*/i, "").replace(/```\s*$/, "").trim();

	// XML prolog / doctype / comments are noise (doctype also enables XXE tricks).
	s = s
		.replace(/<\?xml[\s\S]*?\?>/gi, "")
		.replace(/<!DOCTYPE[\s\S]*?>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");

	if (!looksLikeSvgMarkup(s)) return null;

	// Trim to the outermost <svg> … </svg> pair.
	const start = s.search(/<svg[\s>]/i);
	if (start > 0) s = s.slice(start);
	const end = s.toLowerCase().lastIndexOf("</svg>");
	if (end !== -1) s = s.slice(0, end + 6);

	// Remove executable / external-fetching content.
	s = s
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
		.replace(/<(script|foreignObject|iframe|object|embed|audio|video|handler|set|animate|animateMotion|animateTransform)\b[^>]*\/?>/gi, "")
		.replace(/<image\b[^>]*>/gi, "")
		.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/(?:xlink:)?href\s*=\s*("|')\s*(?:javascript|data|file):[^"']*\1/gi, "")
		.replace(/url\(\s*("|')?\s*(?:https?|javascript|data|file):[^)]*\)/gi, "none");

	if (!/<svg[\s>]/i.test(s)) return null;
	if (s.length > MAX_SVG_CHARS) return null;

	// A viewBox is what makes the diagram scale inside the question card. If the
	// model omitted it but gave width/height, synthesise one.
	if (!/viewBox\s*=/i.test(s)) {
		const w = /(?:^|\s)width\s*=\s*"?([\d.]+)/i.exec(s);
		const h = /(?:^|\s)height\s*=\s*"?([\d.]+)/i.exec(s);
		if (w && h) {
			s = s.replace(/<svg/i, `<svg viewBox="0 0 ${w[1]} ${h[1]}"`);
		}
	}

	// Make sure the SVG namespace is present AND correct (required inside
	// <img src="data:…">). Copy-pasting through chat/markdown often mangles the
	// namespace URL into a link, e.g. xmlns="[http://…](http://…)", which makes
	// the whole document fail to render. Rewrite any wrong value to the real one.
	const SVG_NS = "http://www.w3.org/2000/svg";
	if (!/xmlns\s*=/i.test(s)) {
		s = s.replace(/<svg/i, `<svg xmlns="${SVG_NS}"`);
	} else {
		s = s.replace(/(<svg[^>]*?\sxmlns\s*=\s*)(["'])(.*?)\2/i, (m, pre, q, val) =>
			val.trim() === SVG_NS ? m : `${pre}${q}${SVG_NS}${q}`);
	}

	return s;
}

/** Sanitized SVG markup → `data:image/svg+xml;base64,…` (or null). */
function svgToDataUri(raw) {
	if (isSvgDataUri(raw)) return String(raw).trim();
	const clean = sanitizeSvg(raw);
	if (!clean) return null;
	return `data:image/svg+xml;base64,${Buffer.from(clean, "utf8").toString("base64")}`;
}

/** `data:image/svg+xml;…` → raw SVG markup (used by the DOCX rasterizer). */
function dataUriToSvg(value) {
	if (!isSvgDataUri(value)) return null;
	const src = String(value).trim();
	const comma = src.indexOf(",");
	if (comma === -1) return null;
	const meta = src.slice(0, comma).toLowerCase();
	const payload = src.slice(comma + 1);
	try {
		if (meta.includes(";base64")) return Buffer.from(payload, "base64").toString("utf8");
		return decodeURIComponent(payload);
	} catch {
		return null;
	}
}

/**
 * Accepts whatever the AI/importer gave us for one image slot (raw SVG markup,
 * an svg data URI, a base64 raster, or an http URL) and returns a value that is
 * safe to store in the existing image fields.
 */
function toImageSource(value) {
	if (value == null) return null;
	const s = String(value).trim();
	if (!s) return null;
	if (looksLikeSvgMarkup(s)) return svgToDataUri(s);
	return s;
}

/**
 * Pull every SVG the model may have attached under any of the accepted key
 * spellings and return them as data URIs.
 */
function collectSvgDataUris(source, keys) {
	const out = [];
	if (!source || typeof source !== "object") return out;
	for (const key of keys) {
		const value = source[key];
		if (!value) continue;
		const list = Array.isArray(value) ? value : [value];
		for (const item of list) {
			const uri = typeof item === "string" ? toImageSource(item) : null;
			if (uri && !out.includes(uri)) out.push(uri);
		}
	}
	return out;
}

// Rasterise an SVG to a PNG buffer. Used when uploading to Cloudinary (whose
// public SVG delivery is restricted on many tiers) and by the DOCX exporter,
// which cannot embed vector markup.
async function rasterizeSvgToPng(svgMarkup) {
	try {
		const { createCanvas, loadImage } = require("@napi-rs/canvas");
		const img = await loadImage(Buffer.from(svgMarkup, "utf8"));
		const scale = 2;
		const w = Math.max(1, Math.round((img.width || 300) * scale));
		const h = Math.max(1, Math.round((img.height || 200) * scale));
		const canvas = createCanvas(w, h);
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, w, h);
		ctx.drawImage(img, 0, 0, w, h);
		return canvas.toBuffer("image/png");
	} catch (e) {
		console.warn("[rasterizeSvgToPng] failed —", e.message);
		return null;
	}
}

// Once a figure is hosted on Cloudinary as PNG we have no further use for the
// SVG source, and keeping it would bloat every raw_json row (the markup is
// often larger than the PNG it produced). This removes SVG *payloads* only:
// string values that are SVG markup or an SVG data URI, plus the well-known
// source keys. Booleans such as hasSvg are left alone — they are metadata, not
// payload, and the UI uses them.
const SVG_SOURCE_KEYS = new Set([
	"question_svg", "questionSvg", "question_svgs", "questionSvgs",
	"option_svgs", "optionSvgs", "options_svg", "optionsSvg",
	"option_a_svg", "option_b_svg", "option_c_svg", "option_d_svg",
	"solution_svg", "solutionSvg", "solution_svgs", "solutionSvgs",
	"svg", "svgs", "cell_svg", "cellSvg", "diagram_svg", "diagramSvg",
]);

function isSvgPayload(value) {
	if (typeof value !== "string") return false;
	return looksLikeSvgMarkup(value) || isSvgDataUri(value);
}

function stripSvgSource(value) {
	if (Array.isArray(value)) {
		return value.map(stripSvgSource);
	}
	if (!value || typeof value !== "object") return value;

	const out = {};
	for (const [key, val] of Object.entries(value)) {
		if (SVG_SOURCE_KEYS.has(key)) {
			// Drop the key outright when it holds markup (or an array/null of it).
			const arr = Array.isArray(val) ? val : [val];
			if (arr.every((v) => v == null || isSvgPayload(v))) continue;
		}
		if (isSvgPayload(val)) continue; // stray markup under any other key
		out[key] = stripSvgSource(val);
	}
	return out;
}

module.exports = {
	MAX_SVG_CHARS,
	looksLikeSvgMarkup,
	isSvgDataUri,
	sanitizeSvg,
	svgToDataUri,
	dataUriToSvg,
	toImageSource,
	collectSvgDataUris,
	rasterizeSvgToPng,
	stripSvgSource,
};
