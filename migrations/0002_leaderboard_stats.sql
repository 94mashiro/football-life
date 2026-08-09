-- v2: per-career totals + the two missing personal honors, so the leaderboard
-- can show the numbers a career is actually remembered by (出场/进球/助攻/零封)
-- and the full set of headline honors (金靴/金手套 alongside 世界杯/金球).
--
-- Additive ALTERs with DEFAULT 0 — existing rows stay valid and read as zero,
-- which is correct for careers uploaded before these fields existed (they
-- simply have no totals; the board degrades to counts-only for them).
-- `wrangler d1 execute football-life --file=migrations/0002_leaderboard_stats.sql --remote`

ALTER TABLE careers ADD COLUMN goals INTEGER NOT NULL DEFAULT 0;
ALTER TABLE careers ADD COLUMN assists INTEGER NOT NULL DEFAULT 0;
ALTER TABLE careers ADD COLUMN appearances INTEGER NOT NULL DEFAULT 0;
ALTER TABLE careers ADD COLUMN clean_sheets INTEGER NOT NULL DEFAULT 0;
ALTER TABLE careers ADD COLUMN goals_conceded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE careers ADD COLUMN won_golden_boot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE careers ADD COLUMN won_golden_glove INTEGER NOT NULL DEFAULT 0;
