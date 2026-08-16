const Database = require('better-sqlite3');
const db = new Database('local.db', {readonly:true});
// Old schema: each row has questions_json (array of questions)
const chapters = db.prepare(`SELECT chapter, lecture, LENGTH(questions_json) as len FROM questions WHERE year = '' OR year IS NULL ORDER BY chapter`).all();
console.log(`Total rows (bank, no year): ${chapters.length}`);
// Show unique chapters with question counts
const chapterMap = {};
for (const r of chapters) {
	if (!chapterMap[r.chapter]) chapterMap[r.chapter] = 0;
	try {
		const qs = JSON.parse(db.prepare('SELECT questions_json FROM questions WHERE chapter=? AND lecture=? LIMIT 1').get(r.chapter, r.lecture)?.questions_json || '[]');
		chapterMap[r.chapter] += qs.length;
	} catch {}
}
const entries = Object.entries(chapterMap).sort((a,b) => b[1]-a[1]).slice(0, 20);
console.log('\nTop 20 chapters by question count:');
for (const [ch, cnt] of entries) console.log(`  ${ch}: ${cnt}`);
// Also check what subjects the question keys reference
const tests = db.prepare(`SELECT id, question_keys_json FROM online_tests WHERE id IN (41,42,43,44,51)`).all();
for (const t of tests) {
	const keys = JSON.parse(t.question_keys_json || '[]');
	const chapters = [...new Set(keys.map(k => k.chapter))];
	console.log(`\nTest #${t.id} chapters:`, chapters.join(', '));
}
db.close();
