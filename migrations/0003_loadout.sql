-- v3: the equipped blessing loadout per career, so the leaderboard can show
-- the BUILD a record was played with (which blessings the player equipped) —
-- the "learn from top runs" social hook the build-centric direction needs.
-- Stored as a CSV of blessing ids (≤ MAX_LOADOUT=3, each id ≤ ~14 chars, so
-- ≤ ~60 chars total).
--
-- Additive ALTER with DEFAULT '' — existing rows stay valid and read as empty
-- (no build info for careers uploaded before this column; the board degrades
-- to "no build row" for them, same as a custom/daily run that equips nothing).
-- `wrangler d1 execute football-life --file=migrations/0003_loadout.sql --remote`

ALTER TABLE careers ADD COLUMN loadout TEXT NOT NULL DEFAULT '';
