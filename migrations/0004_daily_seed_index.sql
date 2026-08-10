-- v4: an index on seed so the 今日 (today's daily race) board is cheap as the
-- careers table grows. The 今日 dimension filters `WHERE seed = ?` then ranks
-- by legacy — every daily-challenge run on a given date shares dailySeed(date),
-- so the seed alone recovers that day's race (no date column needed). Without
-- this index the daily board would full-scan careers on every load.
--
-- Additive (CREATE INDEX IF NOT EXISTS) — no row changes, safe to re-run.
-- `wrangler d1 execute football-life --file=migrations/0004_daily_seed_index.sql --remote`

CREATE INDEX IF NOT EXISTS idx_careers_seed ON careers (seed, legacy DESC, created_at ASC);
