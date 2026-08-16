process.loadEnvFile('.env');
const { Pool } = require('pg');
const p = new Pool({
	connectionString: process.env.SUPABASE_DATABASE_URL,
	ssl: { rejectUnauthorized: false },
	family: 4
});
async function run() {
	const r1 = await p.query("SELECT subject, chapter, COUNT(*) as cnt FROM questions GROUP BY subject, chapter ORDER BY subject, chapter LIMIT 20");
	console.log("=== questions (bank) subject+chapter ===");
	console.log(JSON.stringify(r1.rows, null, 2));
	const r2 = await p.query("SELECT subject, year, COUNT(*) as cnt FROM pyq_questions GROUP BY subject, year ORDER BY subject, year DESC LIMIT 20");
	console.log("\n=== pyq_questions subject+year ===");
	console.log(JSON.stringify(r2.rows, null, 2));
	await p.end();
}
run().catch(e => { console.error(e.message); p.end(); });