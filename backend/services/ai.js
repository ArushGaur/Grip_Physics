const { sleep, extractRetrySeconds } = require("../utils/helpers");

async function callGroq(parts, systemPrompt, userPrompt, maxTokens = 2600, temperature = 0.1) {
	const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
	if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set on server");
	const maxAttempts = 4;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${GROQ_API_KEY}`,
			},
			body: JSON.stringify({
				model: "meta-llama/llama-4-scout-17b-16e-instruct",
				max_tokens: maxTokens,
				temperature,
				messages: [
					{ role: "system", content: systemPrompt },
					{
						role: "user",
						content: [...(Array.isArray(parts) ? parts : []), { type: "text", text: userPrompt }],
					},
				],
			}),
		});

		if (r.ok) {
			const data = await r.json();
			return String(data?.choices?.[0]?.message?.content || "").trim();
		}

		const err = await r.json().catch(() => ({}));
		const msg = err?.error?.message || `Groq HTTP ${r.status}`;
		const retryAfterHeader = Number(r.headers.get("retry-after"));
		const retryAfterMsg = extractRetrySeconds(msg);
		const isRateLimit = r.status === 429 || /rate limit|TPM|try again/i.test(msg);

		if (isRateLimit && attempt < maxAttempts) {
			const waitSec = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
				? retryAfterHeader
				: (retryAfterMsg || Math.min(2 * attempt, 8));
			const waitMs = Math.ceil(waitSec * 1000 + 250);
			console.warn(`[groq] rate-limited, retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
			await sleep(waitMs);
			continue;
		}

		throw new Error(msg);
	}

	throw new Error("Groq request failed after retries");
}

module.exports = {
	callGroq,
};
