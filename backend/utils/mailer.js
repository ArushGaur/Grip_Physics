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

const MAIL_FROM = process.env.MAIL_FROM || "Vyorra <onboarding@resend.dev>";
const FALLBACK_FROM_EMAIL = "onboarding@resend.dev";

/** A mailbox address strict enough for what Resend / Brevo will accept. */
const EMAIL_RE =
	/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * Display-name characters that need no quoting (RFC 5322 atext, plus space).
 * Everything else — including ".", "," and any non-ASCII letter — is dropped
 * rather than quoted or escaped, because Resend validates `from` against the
 * plain `Name <email@example.com>` shape and rejects a quoted display name
 * (or raw UTF-8) with a 422 validation_error.
 */
const NAME_STRIP_RE = /[^A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]/g;
const FROM_HEADER_RE = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+ <[^\s<>@]+@[^\s<>@]+>$/;

function parseFrom(from) {
	const raw = String(from == null ? "" : from).trim();
	const m = /^(.*?)<([^>]*)>\s*$/.exec(raw);
	const name = m ? m[1].trim().replace(/^"+|"+$/g, "").trim() : "";
	const email = (m ? m[2] : raw).trim();
	return { name: name || "Vyorra", email, valid: EMAIL_RE.test(email) };
}

let _warnedBadFrom = false;

/**
 * The verified sender address every message goes out from. A malformed
 * MAIL_FROM (blank, a bare name, a stray space inside the angle brackets)
 * used to be passed straight through to the provider, which answered 422 and
 * surfaced to the student as a generic connection error — so fall back to a
 * working address and say loudly what's wrong instead.
 */
function senderAddress() {
	const base = parseFrom(MAIL_FROM);
	if (base.valid) return base;
	if (!_warnedBadFrom) {
		_warnedBadFrom = true;
		console.error(
			`[mailer] \u26a0 MAIL_FROM is not a valid sender: ${JSON.stringify(MAIL_FROM)}. ` +
			`Expected "Name <you@yourdomain.com>" or "you@yourdomain.com". ` +
			`Falling back to ${FALLBACK_FROM_EMAIL} so login codes still go out.`
		);
	}
	return { name: base.name, email: FALLBACK_FROM_EMAIL, valid: true };
}

/** Strip a display name down to something safe to send unquoted. */
function cleanName(value) {
	return String(value == null ? "" : value)
		.replace(NAME_STRIP_RE, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 64)
		.trim();
}

/**
 * Builds the From header, swapping the display name for the institute's own
 * name so the inbox row reads e.g. "Triumph Academy" instead of one hard-coded
 * brand. The ADDRESS stays exactly as MAIL_FROM defines it, because it has to
 * remain on a domain verified with the provider.
 */
function buildFrom(fromName) {
	const base = senderAddress();
	const name = cleanName(fromName) || cleanName(base.name);
	// A bare address is a format Resend accepts, so it's the safe fallback
	// whenever the institute's name leaves nothing usable behind.
	if (!name) return base.email;
	const header = `${name} <${base.email}>`;
	return FROM_HEADER_RE.test(header) ? header : base.email;
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
	const configuredFrom = parseFrom(MAIL_FROM);
	const from = senderAddress();
	return {
		provider,
		configured: provider !== "console",
		from: from.email,
		fromName: from.name,
		mailFromValid: configuredFrom.valid,
		exampleFromHeader: buildFrom("Your Institute"),
		usingResendSandboxSender: /@resend\.dev$/i.test(from.email),
		hint: !configuredFrom.valid
			? `MAIL_FROM (${JSON.stringify(MAIL_FROM)}) is not a valid sender address. Set it to "Name <you@yourdomain.com>" (domain verified with your provider) and restart.`
			: provider === "console"
				? "No email provider configured. Set RESEND_API_KEY (or BREVO_API_KEY, or SMTP_HOST + SMTP_USER + SMTP_PASS) and MAIL_FROM, then restart. See EMAIL_SETUP.md."
				: /@resend\.dev$/i.test(from.email)
					? "MAIL_FROM still uses onboarding@resend.dev. Resend only delivers from that address to the email you signed up with \u2014 add and verify your own domain, then set MAIL_FROM to it."
					: "Email looks configured.",
	};
}

module.exports = { sendMail, sendOtpEmail, activeProvider, mailDiagnostics, buildFrom, MAIL_FROM };
