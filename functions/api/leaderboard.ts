/**
 * /api/leaderboard — the global career board + the tuning-data intake.
 *
 *   POST /api/leaderboard            → upload one finished career (summary row +
 *                                      its decision log), return its global rank
 *   GET  /api/leaderboard?nat=&limit=&deviceId= → top entries (+ the caller's rank)
 *
 * No anti-cheat: the server trusts the payload, only clamping to sane ranges so
 * a malformed/abusive request can't blow up a row or a query. The decision log
 * (career_events) is the engine-tuning sample — analysed offline via
 * `wrangler d1 execute`, never exposed through this API.
 *
 * Writes are two steps (careers row first to grab its id, then a batch of
 * event rows). They are not one atomic transaction; a failure between them
 * leaves an orphan career (no events) which analytics tolerates via LEFT JOIN.
 */
import type { Env, EventContext } from "../_types";

// ── wire shapes (camelCase JSON; DB columns are snake_case, mapped via AS) ──

interface EventWire {
  age: number;
  title: string;
  choice: string;
  outcome: string;
  good: boolean;
}

interface SubmitBody {
  deviceId: string;
  seed: string;
  name: string;
  position: string;
  nationalityId: string;
  leagueId?: string;
  pace?: string;
  ascension?: number;
  legacy: number;
  maxOverall: number;
  seasons: number;
  finalAge: number;
  trophies: number;
  awards: number;
  injuriesTaken?: number;
  severeInjuries?: number;
  clubCount?: number;
  wonWorldCup?: boolean;
  wonBallonDor?: boolean;
  rankName: string;
  retireReason?: string;
  events?: EventWire[];
}

interface LeaderboardRow {
  seed: string;
  name: string;
  position: string;
  nationalityId: string;
  leagueId: string;
  pace: string;
  ascension: number;
  legacy: number;
  maxOverall: number;
  seasons: number;
  finalAge: number;
  trophies: number;
  awards: number;
  injuriesTaken: number;
  severeInjuries: number;
  clubCount: number;
  wonWorldCup: number;
  wonBallonDor: number;
  rankName: string;
  retireReason: string | null;
  createdAt: string;
}

interface SubmitResponse {
  ok: boolean;
  id?: number;
  rank?: number;
  error?: string;
}

interface BoardResponse {
  entries: LeaderboardRow[];
  total: number;
  myRank: number | null;
}

// device_id is intentionally NOT in the public SELECT — it is collected for
// backend device filtering/attribution (analysed via `wrangler d1 execute`) and
// used server-side to compute the viewer's own rank, but never returned in the
// board entries (privacy: one viewer must not see another's device id).
const COLS =
  "seed, name, position, nationality_id AS nationalityId, " +
  "league_id AS leagueId, pace, ascension, legacy, max_overall AS maxOverall, " +
  "seasons, final_age AS finalAge, trophies, awards, injuries_taken AS injuriesTaken, " +
  "severe_injuries AS severeInjuries, club_count AS clubCount, won_world_cup AS wonWorldCup, " +
  "won_ballon_dor AS wonBallonDor, rank_name AS rankName, retire_reason AS retireReason, " +
  "created_at AS createdAt";

// ── input sanitising (range-clamp, not validation — store what we get) ──

function clampStr(s: unknown, max: number): string {
  return String(s ?? "").slice(0, max);
}
function clampInt(n: unknown, min: number, max: number, dflt: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : dflt;
  return Math.max(min, Math.min(max, v));
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ── POST: upload a finished career + its decision log ──

export async function onRequestPost(ctx: EventContext<Env>): Promise<Response> {
  let body: SubmitBody;
  try {
    body = (await ctx.request.json()) as SubmitBody;
  } catch {
    return json<SubmitResponse>({ ok: false, error: "invalid json" }, 400);
  }

  const deviceId = clampStr(body.deviceId, 64);
  const seed = clampStr(body.seed, 64);
  if (!deviceId || !seed) {
    return json<SubmitResponse>({ ok: false, error: "missing deviceId/seed" }, 400);
  }

  const row = {
    device_id: deviceId,
    seed,
    name: clampStr(body.name, 40) || "?",
    position: clampStr(body.position, 4) || "ST",
    nationality_id: clampStr(body.nationalityId, 8) || "chn",
    league_id: clampStr(body.leagueId, 32),
    pace: clampStr(body.pace, 8) || "normal",
    ascension: clampInt(body.ascension, 0, 10, 0),
    legacy: clampInt(body.legacy, 0, 100000, 0),
    max_overall: clampInt(body.maxOverall, 0, 99, 50),
    seasons: clampInt(body.seasons, 0, 40, 0),
    final_age: clampInt(body.finalAge, 16, 45, 30),
    trophies: clampInt(body.trophies, 0, 999, 0),
    awards: clampInt(body.awards, 0, 999, 0),
    injuries_taken: clampInt(body.injuriesTaken, 0, 999, 0),
    severe_injuries: clampInt(body.severeInjuries, 0, 999, 0),
    club_count: clampInt(body.clubCount, 0, 99, 0),
    won_world_cup: body.wonWorldCup ? 1 : 0,
    won_ballon_dor: body.wonBallonDor ? 1 : 0,
    rank_name: clampStr(body.rankName, 10) || "球员",
    retire_reason: body.retireReason ? clampStr(body.retireReason, 32) : null,
  };

  const insert = await ctx.env.DB.prepare(
    "INSERT INTO careers " +
      "(device_id, seed, name, position, nationality_id, league_id, pace, ascension, " +
      "legacy, max_overall, seasons, final_age, trophies, awards, injuries_taken, " +
      "severe_injuries, club_count, won_world_cup, won_ballon_dor, rank_name, retire_reason) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(...Object.values(row)).run();

  if (!insert.success) {
    return json<SubmitResponse>({ ok: false, error: "insert failed" }, 500);
  }

  const careerId = insert.meta.last_row_id ?? 0;
  const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
  if (careerId && events.length > 0) {
    const stmt = ctx.env.DB.prepare(
      "INSERT INTO career_events (career_id, age, title, choice, outcome, good) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    );
    const batch = events.map((e) =>
      stmt.bind(
        careerId,
        clampInt(e.age, 16, 45, 30),
        clampStr(e.title, 80),
        clampStr(e.choice, 80),
        clampStr(e.outcome, 200),
        e.good ? 1 : 0,
      ),
    );
    await ctx.env.DB.batch(batch);
  }

  // rank = 1 + rows strictly above this legacy (ties share the lower spot)
  const rankRow = await ctx.env.DB.prepare(
    "SELECT COUNT(*) AS c FROM careers WHERE legacy > ?",
  ).bind(row.legacy).first<{ c: number }>();

  return json<SubmitResponse>({
    ok: true,
    id: careerId,
    rank: (rankRow?.c ?? 0) + 1,
  });
}

// ── GET: top entries + the caller's own rank ──

export async function onRequestGet(ctx: EventContext<Env>): Promise<Response> {
  const url = new URL(ctx.request.url);
  const nat = url.searchParams.get("nat");
  const limit = clampInt(Number(url.searchParams.get("limit")), 1, 200, 100);
  const deviceId = clampStr(url.searchParams.get("deviceId"), 64);

  const where = nat ? "WHERE nationality_id = ?" : "";
  const whereBinds: unknown[] = nat ? [nat] : [];

  const top = await ctx.env.DB.prepare(
    `SELECT ${COLS} FROM careers ${where} ORDER BY legacy DESC, created_at ASC LIMIT ?`,
  ).bind(...whereBinds, limit).all<LeaderboardRow>();

  const totalRow = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM careers ${where}`,
  ).bind(...whereBinds).first<{ c: number }>();
  const total = totalRow?.c ?? 0;

  let myRank: number | null = null;
  if (deviceId) {
    // the caller's best legacy within the current filter scope
    const maxRow = await ctx.env.DB.prepare(
      nat
        ? "SELECT MAX(legacy) AS m FROM careers WHERE device_id = ? AND nationality_id = ?"
        : "SELECT MAX(legacy) AS m FROM careers WHERE device_id = ?",
    ).bind(deviceId, ...whereBinds).first<{ m: number | null }>();

    if (maxRow && maxRow.m !== null && maxRow.m !== undefined) {
      const rankRow = await ctx.env.DB.prepare(
        nat
          ? "SELECT COUNT(*) + 1 AS rank FROM careers WHERE legacy > ? AND nationality_id = ?"
          : "SELECT COUNT(*) + 1 AS rank FROM careers WHERE legacy > ?",
      ).bind(maxRow.m, ...whereBinds).first<{ rank: number }>();
      myRank = rankRow?.rank ?? null;
    }
  }

  return json<BoardResponse>({
    entries: top.results ?? [],
    total,
    myRank,
  });
}
