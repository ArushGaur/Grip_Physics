-- ============================================================================
-- SCALING MIGRATION 001
--
-- Safe to run on a live database. Every statement is idempotent and every
-- index is created CONCURRENTLY so it does NOT lock the table.
--
--   psql "$SUPABASE_DATABASE_URL" -f migrations/001-scaling.sql
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so run
-- this file directly with psql (not wrapped in BEGIN/COMMIT).
-- ============================================================================


-- 1. INDEXES FOR THE HOT STUDENT PATHS
-- At 200k students, a missing index turns a 2ms lookup into a 2s sequential
-- scan across millions of rows. These cover the queries on the exam-day
-- critical path: login, fetching a test, and resuming an attempt.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rs_inst_roll
  ON registered_students (institute_id, roll_number);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ss_token_expires
  ON student_sessions (token, expires);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ss_expires
  ON student_sessions (expires);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_th_inst_roll_test
  ON test_history (institute_id, roll_number, test_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ot_inst_livedate
  ON online_tests (institute_id, live_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attendance_inst_date
  ON attendance (institute_id, date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_students_inst_time
  ON students (institute_id, time DESC);

-- Sessions table (only used when REDIS_URL is not configured).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_expires
  ON sessions (expires);


-- 2. AUTOVACUUM TUNING FOR HIGH-CHURN TABLES
-- Postgres defaults only vacuum after 20% of a table changes. On a 50M-row
-- table that means 10M dead rows accumulate before cleanup, and queries slow
-- down badly in between. These settings vacuum far more often, in smaller bites.

ALTER TABLE attendance    SET (autovacuum_vacuum_scale_factor = 0.02,
                               autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE notifications SET (autovacuum_vacuum_scale_factor = 0.02,
                               autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE test_history  SET (autovacuum_vacuum_scale_factor = 0.05,
                               autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE sessions      SET (autovacuum_vacuum_scale_factor = 0.01,
                               autovacuum_analyze_scale_factor = 0.01);


-- 3. RETENTION: STOP UNBOUNDED GROWTH
-- 200k students generating notifications produces roughly 50 MILLION rows a
-- year. Nobody reads a 4-month-old "test is live" notification, but every one
-- of them slows every query on the table and inflates your storage bill.
-- Run this weekly (cron, or Supabase pg_cron).

-- Delete read notifications older than 30 days, unread older than 90:
-- DELETE FROM notifications
--  WHERE (is_read = true  AND created_at < NOW() - INTERVAL '30 days')
--     OR (is_read = false AND created_at < NOW() - INTERVAL '90 days');

-- Expired student sessions and OTPs:
-- DELETE FROM student_sessions WHERE expires < (EXTRACT(EPOCH FROM NOW()) * 1000);
-- DELETE FROM student_otps     WHERE created_at < NOW() - INTERVAL '1 day';


-- 4. PARTITIONING ATTENDANCE (do this when it passes ~20M rows)
-- 1000 institutes x 200 students x ~250 school days = ~50M rows PER YEAR.
-- Beyond ~20M rows a single table becomes painful: index bloat, slow vacuum,
-- and "delete last year's data" takes hours.
--
-- Monthly range partitions fix all three: queries touch one small partition,
-- and dropping an old month is instant (DROP TABLE) instead of a huge DELETE.
--
-- This is a table rewrite, so run it in a maintenance window. Left commented
-- deliberately: you do NOT need it on day one.
--
-- CREATE TABLE attendance_new (LIKE attendance INCLUDING ALL) PARTITION BY RANGE (date);
-- CREATE TABLE attendance_2026_01 PARTITION OF attendance_new
--   FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
-- CREATE TABLE attendance_2026_02 PARTITION OF attendance_new
--   FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
-- ... create 12 months ahead, then:
-- INSERT INTO attendance_new SELECT * FROM attendance;
-- ALTER TABLE attendance RENAME TO attendance_old;
-- ALTER TABLE attendance_new RENAME TO attendance;
-- verify, then: DROP TABLE attendance_old;


-- 5. VERIFY
-- Largest tables:
--   SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size
--     FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 15;
--
-- Slowest queries (needs pg_stat_statements):
--   SELECT calls, round(mean_exec_time::numeric,2) AS avg_ms, left(query,90)
--     FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 20;
--
-- Unused indexes (dead weight on every write):
--   SELECT relname, indexrelname, idx_scan FROM pg_stat_user_indexes
--    WHERE idx_scan = 0 ORDER BY relname;
