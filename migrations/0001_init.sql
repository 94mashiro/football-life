-- v1 schema: the cloud career store. Two tables — one row per finished career
-- (drives the leaderboard AND the macro balance analysis), one row per in-career
-- decision (drives event-tuning analysis: trigger frequency, option mix, good-rate).
--
-- No anti-cheat (per product decision). The server stores + queries what the
-- client reports, clamping to sane ranges so a malformed request can't blow up
-- a row or a query. Analytics is read via `wrangler d1 execute` SQL, not an API.
-- `customSeed` runs (reproducible hand-picked seeds) are NEVER uploaded — they
-- don't settle meta and would pollute both the board and the tuning sample.

CREATE TABLE IF NOT EXISTS careers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id       TEXT    NOT NULL,         -- anonymous client UUID
  seed            TEXT    NOT NULL,
  name            TEXT    NOT NULL,         -- generated player name
  position        TEXT    NOT NULL,
  nationality_id TEXT    NOT NULL,
  league_id       TEXT    NOT NULL DEFAULT '',   -- start league
  pace            TEXT    NOT NULL DEFAULT 'normal',  -- long/normal/express
  ascension       INTEGER NOT NULL DEFAULT 0,
  legacy          INTEGER NOT NULL,         -- 传承分, the ranked score
  max_overall     INTEGER NOT NULL,
  seasons         INTEGER NOT NULL,
  final_age       INTEGER NOT NULL,
  trophies        INTEGER NOT NULL,         -- count
  awards          INTEGER NOT NULL,         -- count
  injuries_taken INTEGER NOT NULL DEFAULT 0,
  severe_injuries INTEGER NOT NULL DEFAULT 0,
  club_count     INTEGER NOT NULL DEFAULT 0, -- distinct clubs played for
  won_world_cup   INTEGER NOT NULL DEFAULT 0,-- 0/1
  won_ballon_dor  INTEGER NOT NULL DEFAULT 0,-- 0/1
  rank_name       TEXT    NOT NULL,          -- 球员/明星/巨星/传奇/球神
  retire_reason   TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Leaderboard reads.
CREATE INDEX IF NOT EXISTS idx_careers_legacy  ON careers (legacy DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_careers_nat     ON careers (nationality_id, legacy DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_careers_device  ON careers (device_id, legacy DESC);
-- Balance-analysis reads (legacy distribution by difficulty axis).
CREATE INDEX IF NOT EXISTS idx_careers_ascension ON careers (ascension, legacy);
CREATE INDEX IF NOT EXISTS idx_careers_nat_avg   ON careers (nationality_id, legacy);
CREATE INDEX IF NOT EXISTS idx_careers_position  ON careers (position, legacy);

CREATE TABLE IF NOT EXISTS career_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  career_id   INTEGER NOT NULL REFERENCES careers(id) ON DELETE CASCADE,
  age         INTEGER NOT NULL,
  title       TEXT    NOT NULL,   -- event title (the decision the player faced)
  choice      TEXT    NOT NULL,   -- chosen option text
  outcome     TEXT    NOT NULL,  -- resolve outcome prose
  good        INTEGER NOT NULL,   -- 0/1 — did this branch help the career
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_career ON career_events (career_id);
CREATE INDEX IF NOT EXISTS idx_events_title  ON career_events (title, choice);
