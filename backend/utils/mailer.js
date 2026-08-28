"use strict";
/**
 * mailer.js — zero-dependency transactional email for student OTP login.
 *
 * Supports three providers, picked automatically from env vars (first match wins):
 *
 *   1. RESEND_API_KEY   → Resend HTTP API   (recommended — free tier, 1 env var)
 *   2. BREVO_API_KEY    → Brevo HTTP API    (good free tier in India)
 *   3. SMTP_HOST + SMTP_USER + SMTP_PASS → SMTP via nodemailer
 *      (nodemailer is lazy-required, so it's only needed if you use SMTP)
 *
 * If none are configured, the mail is NOT sent — instead the OTP is printed to
 * the server console so local development still works. The API response never
 * reveals the code.
 *
 * Required in all cases:
 *   MAIL_FROM        e.g. "Vyorra <login@yourdomain.com>"
 *                    (Resend/Brevo need this domain verified)
 */

/**
 * Dashboards such as Sevalla/Render often store env values with the quotes the
 * user typed, so MAIL_FROM arrives as `"Grip Physics <login@x.com>"` (quotes
 * included) and Resend answers 422 "Invalid `from` field". Strip wrapping
 * quotes/whitespace and validate; fall back to the sandbox sender rather than
 * failing every login.
 */
function sanitizeMailFrom(raw) {
	let v = String(raw == null ? "" : raw).trim();
	// Peel repeated wrapping quotes: "\"Name <a@b.com>\"" -> Name <a@b.com>
	for (let i = 0; i < 3; i++) {
		const m = /^(["'])([\s\S]*)\1$/.exec(v);
		if (!m) break;
		v = m[2].trim();
	}
	v = v.replace(/[\r\n]+/g, " ").trim();
	if (!v) return { from: DEFAULT_MAIL_FROM, problem: "" };
	const addr = /<([^>]+)>\s*$/.exec(v);
	const email = (addr ? addr[1] : v).trim();
	if (!/^[^\s@"<>,;]+@[^\s@"<>,;.]+\.[^\s@"<>,;]+$/.test(email)) {
		return { from: DEFAULT_MAIL_FROM, problem: v };
	}
	return { from: v, problem: "" };
}

const DEFAULT_MAIL_FROM = "Vyorra <onboarding@resend.dev>";
const _mailFrom = sanitizeMailFrom(process.env.MAIL_FROM);
if (_mailFrom.problem) {
	console.error(
		`[mailer] \u26a0 MAIL_FROM is not a valid sender: ${JSON.stringify(_mailFrom.problem)}. ` +
		'Expected "Name <you@yourdomain.com>" or "you@yourdomain.com" (no surrounding quotes). ' +
		`Falling back to ${DEFAULT_MAIL_FROM} so login codes still go out.`
	);
}
const MAIL_FROM = _mailFrom.from;

function parseFrom(from) {
	const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
	if (m) return { name: m[1] || "Vyorra", email: m[2] };
	return { name: "Vyorra", email: String(from).trim() };
}

/**
 * Builds the From header, swapping the display name for the institute's own
 * name so the inbox row reads e.g. "Triumph Academy" instead of one hard-coded
 * brand. The ADDRESS stays exactly as MAIL_FROM defines it, because it has to
 * remain on a domain verified with the provider.
 */
function buildFrom(fromName) {
	const base = parseFrom(MAIL_FROM);
	const clean = String(fromName == null ? "" : fromName)
		.replace(/[\r\n<>"]/g, " ")   // never let a name break the header
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 78);
	const name = clean || base.name;
	const needsQuotes = /[,;:@()\[\]\\.]/.test(name);
	return `${needsQuotes ? `"${name}"` : name} <${base.email}>`;
}

/** Which provider is active. Exposed so /api/health can report it. */
function activeProvider() {
	if (process.env.RESEND_API_KEY) return "resend";
	if (process.env.BREVO_API_KEY) return "brevo";
	if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return "smtp";
	return "console";
}

async function sendViaResend({ to, subject, html, text, fromName }) {
	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ from: buildFrom(fromName), to: [to], subject, html, text }),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
	}
	return { provider: "resend" };
}

async function sendViaBrevo({ to, subject, html, text, fromName }) {
	const from = parseFrom(buildFrom(fromName));
	const res = await fetch("https://api.brevo.com/v3/smtp/email", {
		method: "POST",
		headers: {
			"api-key": process.env.BREVO_API_KEY,
			"Content-Type": "application/json",
			accept: "application/json",
		},
		body: JSON.stringify({
			sender: { name: from.name, email: from.email },
			to: [{ email: to }],
			subject,
			htmlContent: html,
			textContent: text,
		}),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Brevo ${res.status}: ${body.slice(0, 300)}`);
	}
	return { provider: "brevo" };
}

let _transport = null;
async function sendViaSmtp({ to, subject, html, text, fromName }) {
	if (!_transport) {
		let nodemailer;
		try {
			nodemailer = require("nodemailer");
		} catch (_) {
			throw new Error(
				"SMTP_HOST is set but nodemailer is not installed. Run `npm i nodemailer` " +
				"or switch to RESEND_API_KEY / BREVO_API_KEY instead."
			);
		}
		_transport = nodemailer.createTransport({
			host: process.env.SMTP_HOST,
			port: Number(process.env.SMTP_PORT || 587),
			secure: String(process.env.SMTP_SECURE || "") === "true" || Number(process.env.SMTP_PORT) === 465,
			auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
		});
	}
	await _transport.sendMail({ from: buildFrom(fromName), to, subject, html, text });
	return { provider: "smtp" };
}

/**
 * Send an email. Throws on provider failure so callers can decide whether to
 * surface an error to the user.
 */
async function sendMail({ to, subject, html, text, fromName }) {
	const provider = activeProvider();
	const payload = { to, subject, html, text: text || "", fromName };
	if (provider === "resend") return sendViaResend(payload);
	if (provider === "brevo") return sendViaBrevo(payload);
	if (provider === "smtp") return sendViaSmtp(payload);

	// No provider configured — dev fallback.
	console.warn(
		"\n[mailer] ⚠ No email provider configured (set RESEND_API_KEY, BREVO_API_KEY or SMTP_*)."
	);
	console.warn(`[mailer] Would have emailed ${to}: ${subject}`);
	console.warn(`[mailer] ${text || html}\n`);
	return { provider: "console" };
}

/** Branded OTP email. `code` is a 6-digit string. */
async function sendOtpEmail({ to, code, studentName, instituteName, logoUrl, minutes = 10 }) {
	const who = studentName ? `Hi ${studentName},` : "Hi,";
	const brand = instituteName || "Vyorra";
	const logo = normalizeLogoUrl(logoUrl);
	const subject = `${code} is your ${brand} login code`;

	const text =
		`${who}\n\nYour login code for ${brand} is: ${code}\n\n` +
		`It expires in ${minutes} minutes and can be used once.\n\n` +
		`If you didn't try to sign in, you can ignore this email.\n`;

	const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#0b0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
  <div style="max-width:480px;margin:0 auto;padding:32px 24px">
    <div style="background:#121821;border:1px solid #1f2a37;border-radius:16px;padding:32px">
      ${logo
			? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px"><tr>
        <td style="vertical-align:middle;padding-right:12px">
          <img src="${escapeHtml(logo)}" alt="${escapeHtml(brand)}" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:12px;object-fit:contain;background:#0b0f14;border:1px solid #1f2a37">
        </td>
        <td style="vertical-align:middle;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5eead4;font-weight:700">${escapeHtml(brand)}</td>
      </tr></table>`
			: `<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5eead4;font-weight:700">${escapeHtml(brand)}</div>`}
      <h1 style="margin:12px 0 8px;font-size:22px;color:#f1f5f9;font-weight:800">Your login code</h1>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#94a3b8">${escapeHtml(who)} use this code to sign in to your student portal.</p>
      <div style="background:#0b0f14;border:1px solid #1f2a37;border-radius:12px;padding:20px;text-align:center">
        <div style="font-size:34px;letter-spacing:.32em;font-weight:800;color:#5eead4;font-family:'SFMono-Regular',Consolas,monospace">${escapeHtml(code)}</div>
      </div>
      <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#94a3b8">This code expires in <strong style="color:#f1f5f9">${minutes} minutes</strong> and can only be used once.</p>
      <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#64748b">Didn't try to sign in? You can safely ignore this email — nobody can access your account without this code.</p>
    </div>
    <p style="margin:16px 0 0;text-align:center;font-size:11px;color:#475569">Sent automatically by ${escapeHtml(brand)}. Please do not reply.</p>
  </div>
</body></html>`;

	// fromName makes the sender line in the student's inbox show the institute.
	return sendMail({ to, subject, html, text, fromName: brand });
}

/**
 * Only absolute http(s) URLs can render inside an email client, so anything
 * else (a local path, a data: URI, junk) is dropped and we fall back to the
 * text wordmark. Protocol-relative URLs are upgraded to https.
 */
function normalizeLogoUrl(url) {
	const s = String(url == null ? "" : url).trim();
	if (!s) return "";
	if (/^\/\//.test(s)) return `https:${s}`;
	if (/^https?:\/\//i.test(s)) return s;
	return "";
}

function escapeHtml(s) {
	return String(s == null ? "" : s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * What /api/mail-status reports. Never includes keys or secrets.
 */
function mailDiagnostics() {
	const provider = activeProvider();
	const from = parseFrom(MAIL_FROM);
	return {
		provider,
		configured: provider !== "console",
		from: from.email,
		fromName: from.name,
		usingResendSandboxSender: /@resend\.dev$/i.test(from.email),
		mailFromInvalid: Boolean(_mailFrom.problem),
		hint:
			provider === "console"
				? "No email provider configured. Set RESEND_API_KEY (or BREVO_API_KEY, or SMTP_HOST + SMTP_USER + SMTP_PASS) and MAIL_FROM, then restart. See EMAIL_SETUP.md."
				: /@resend\.dev$/i.test(from.email)
					? "MAIL_FROM still uses onboarding@resend.dev. Resend only delivers from that address to the email you signed up with \u2014 add and verify your own domain, then set MAIL_FROM to it."
					: "Email looks configured.",
	};
}

module.exports = { sendMail, sendOtpEmail, activeProvider, mailDiagnostics, buildFrom, MAIL_FROM };
