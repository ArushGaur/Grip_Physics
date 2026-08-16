/**
 * migrate-to-v2.js — OBSOLETE, intentionally disabled.
 *
 * This was a one-off migration from the very old schema (one row per topic with
 * a `questions_json` array) into a single `questions_v2` table.
 *
 * That `questions_v2` table no longer exists in the app. Questions now live in
 * exactly TWO tables, and every route reads/writes them directly:
 *
 *   • questions      — the regular question bank (no year)
 *   • pyq_questions  — previous-year questions (year/month/day/shift/number)
 *
 * Running the old logic today would DELETE FROM questions_v2 and rebuild a
 * table nothing uses, so it is disabled rather than left as a footgun.
 *
 * What to run instead:
 *   • node drop-questions-v2.js        — remove a leftover questions_v2
 *                                        view/table (migrating any rows first)
 *   • node migrate-to-supabase.js      — one-time import from the legacy local
 *                                        SQLite file into Supabase
 */

console.log("");
console.log("migrate-to-v2.js is obsolete and does nothing.");
console.log("");
console.log("The schema is now: questions (regular bank) + pyq_questions (previous-year).");
console.log("There is no questions_v2 table to migrate into.");
console.log("");
console.log("  \u2022 To clean up a leftover questions_v2:  node drop-questions-v2.js");
console.log("  \u2022 To import the legacy SQLite data:     node migrate-to-supabase.js");
console.log("");

process.exit(0);
