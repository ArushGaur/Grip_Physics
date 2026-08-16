const cloudinary = require("cloudinary").v2;
const { getMime } = require("../utils/helpers");
const {
	sanitizeSvg,
	looksLikeSvgMarkup,
	isSvgDataUri,
	dataUriToSvg,
	rasterizeSvgToPng,
	stripSvgSource,
} = require("../utils/svg");

cloudinary.config({
	cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
	api_key: process.env.CLOUDINARY_API_KEY,
	api_secret: process.env.CLOUDINARY_API_SECRET,
});

const FOLDER = "grip_physics";

function hasCloudinaryConfig() {
	return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

// AI-drawn diagrams arrive as SVG. We deliberately convert them to PNG on
// upload (format: "png") instead of storing the .svg: Cloudinary blocks public
// SVG delivery on many account tiers, so an .svg secure_url can come back 401
// for students even though the upload succeeded. PNG is also what the DOCX
// paper export and the offline test window can consume without extra work.
async function uploadSvgToCloudinary(svgMarkup, fallback) {
	const clean = sanitizeSvg(svgMarkup);
	if (!clean) return fallback ?? null;

	const svgDataUri = `data:image/svg+xml;base64,${Buffer.from(clean, "utf8").toString("base64")}`;

	// Preferred path: let Cloudinary rasterise it.
	try {
		const uploaded = await cloudinary.uploader.upload(svgDataUri, {
			folder: FOLDER,
			resource_type: "image",
			format: "png",
			transformation: [{ width: 900, crop: "limit", background: "white", flags: "lossy" }],
		});
		return uploaded.secure_url;
	} catch (e) {
		console.warn("[cloudinary] SVG->PNG upload failed, rasterising locally:", e.message);
	}

	// Fallback: rasterise here, then upload a plain PNG.
	try {
		const png = await rasterizeSvgToPng(clean);
		if (png) {
			const uploaded = await cloudinary.uploader.upload(
				`data:image/png;base64,${png.toString("base64")}`,
				{ folder: FOLDER, resource_type: "image" }
			);
			return uploaded.secure_url;
		}
	} catch (e) {
		console.warn("[cloudinary] local PNG upload failed:", e.message);
	}

	// Last resort: keep the inline data URI so the figure is not lost.
	console.warn("[cloudinary] storing SVG inline in the DB row — figure kept, row is larger");
	return fallback ?? svgDataUri;
}

async function uploadImageToCloudinary(base64String) {
	if (!base64String) return null;
	const str = String(base64String);
	if (str.startsWith("http://") || str.startsWith("https://")) return str;
	if (!hasCloudinaryConfig()) return str;

	// SVG can reach us either as a data URI (normal ingest) or as raw markup.
	const svgMarkup = isSvgDataUri(str) ? dataUriToSvg(str) : (looksLikeSvgMarkup(str) ? str : null);
	if (svgMarkup) return uploadSvgToCloudinary(svgMarkup, str);

	try {
		const dataUri = str.startsWith("data:") ? str : `data:${getMime(str)};base64,${str}`;
		const uploaded = await cloudinary.uploader.upload(dataUri, { folder: FOLDER });
		return uploaded.secure_url;
	} catch (e) {
		console.warn("Cloudinary upload failed, storing base64 instead:", e.message);
		return str;
	}
}

// Table cells can themselves be figures: { text, image, imageNeeded? }.
// These were previously never uploaded, so drawn table cells stayed inline.
async function uploadCell(cell) {
	if (!cell || typeof cell !== "object" || Array.isArray(cell)) return cell;
	if (!cell.image) return cell;
	return { ...cell, image: await uploadImageToCloudinary(cell.image) };
}

async function uploadTableImages(table) {
	if (!table || typeof table !== "object" || Array.isArray(table)) return table;
	const next = { ...table };
	if (Array.isArray(next.headers)) {
		next.headers = await Promise.all(next.headers.map(uploadCell));
	}
	if (Array.isArray(next.rows)) {
		next.rows = await Promise.all(
			next.rows.map(async (row) => (Array.isArray(row) ? Promise.all(row.map(uploadCell)) : row))
		);
	}
	return next;
}

async function uploadQuestionImages(questions) {
	return Promise.all(
		(Array.isArray(questions) ? questions : []).map(async (q) => {
			const next = { ...q };
			if (Array.isArray(next.questionImages)) {
				next.questionImages = await Promise.all(next.questionImages.map((img) => uploadImageToCloudinary(img)));
				next.questionImage = next.questionImages[0] || next.questionImage || null;
			} else if (next.questionImage) {
				next.questionImage = await uploadImageToCloudinary(next.questionImage);
				next.questionImages = next.questionImage ? [next.questionImage] : [];
			}
			if (Array.isArray(next.optionImages)) {
				next.optionImages = await Promise.all(next.optionImages.map((img) => uploadImageToCloudinary(img)));
			}
			if (Array.isArray(next.solutions)) {
				next.solutions = await Promise.all(next.solutions.map(async (sol) => {
					if (!sol || typeof sol !== "object") return sol;
					const nextSol = { ...sol };
					if (Array.isArray(nextSol.images)) {
						nextSol.images = await Promise.all(nextSol.images.map((img) => uploadImageToCloudinary(img)));
						nextSol.image = nextSol.images[0] || nextSol.image || null;
					} else if (nextSol.image) {
						nextSol.image = await uploadImageToCloudinary(nextSol.image);
						nextSol.images = nextSol.image ? [nextSol.image] : [];
					}
					return nextSol;
				}));
			}
			if (Array.isArray(next.tables)) {
				next.tables = await Promise.all(next.tables.map(uploadTableImages));
			}
			if (Array.isArray(next.optionTables)) {
				next.optionTables = await Promise.all(next.optionTables.map((t) => (t ? uploadTableImages(t) : t)));
			}
			// Figures are hosted now, so discard the SVG source before this object
			// is stringified into raw_json. Anything that failed to upload is still
			// an inline data URI and is deliberately kept — losing a figure is worse
			// than a large row.
			return stripSvgSource(next);
		})
	);
}

module.exports = {
	cloudinary,
	uploadImageToCloudinary,
	uploadSvgToCloudinary,
	uploadQuestionImages,
};
