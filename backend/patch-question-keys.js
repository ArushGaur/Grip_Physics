/**
 * patch-question-keys.js
 * 
 * Syncs question_keys_json from local.db (SQLite) to Supabase
 * for online_tests rows where Supabase has empty question_keys_json
 * but SQLite has the real data.
 */
"use strict";

const path = require("path");
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch (_) {}

const Database = require("better-sqlite3");
const { Pool } = require("pg");

const sqlite = new Database(path.join(__dirname, "local.db"), { readonly: true });
const pg = new Pool({
	connectionString: process.env.SUPABASE_DATABASE_URL,
	ssl: { rejectUnauthorized: false },
	family: 4,
	max: 3,
});

async function run() {
	console.log("Fetching tests from SQLite that have non-empty question_keys_json...");
	const sqliteTests = sqlite.prepare(
		"SELECT id, question_keys_json, questions_json FROM online_tests WHERE LENGTH(question_keys_json) > 2"
	).all();
	console.log(`Found ${sqliteTests.length} tests with keys in SQLite.`);

	let updated = 0, skipped = 0;
	for (const row of sqliteTests) {
		// Check if Supabase row has empty keys
		const r = await pg.query(
			"SELECT LENGTH(question_keys_json) as qkj_len FROM online_tests WHERE id = $1",
			[row.id]
		);
		if (!r.rows.length) {
			console.log(`  Test #${row.id}: not in Supabase, skipping`);
			skipped++;
			continue;
		}
		const supaLen = Number(r.rows[0].qkj_len);
		if (supaLen > 2) {
			console.log(`  Test #${row.id}: already has keys (len=${supaLen}), skipping`);
			skipped++;
			continue;
		}

		// Update Supabase with the real question_keys_json from SQLite
		await pg.query(
			"UPDATE online_tests SET question_keys_json = $1 WHERE id = $2",
			[row.question_keys_json, row.id]
		);
		console.log(`  ✓ Test #${row.id}: restored question_keys_json (${row.question_keys_json.length} bytes)`);
		updated++;
	}

	console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}`);
	await pg.end();
	sqlite.close();
}

run().catch(e => {
	console.error("Error:", e.message);
	pg.end();
	sqlite.close();
	process.exit(1);
});
