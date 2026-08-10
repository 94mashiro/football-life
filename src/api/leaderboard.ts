/**
 * Cloud leaderboard client — the SPA side of the Pages Functions + D1 backend.
 *
 * Two responsibilities:
 *  1. Intake: on every career settle (silently, no opt-in — per product
 *     decision), upload the finished career summary + its decision log so the
 *     backend's tuning analysis has a real-player sample.
 *  2. Board: fetch the global leaderboard, filtered by nationality.
 *
 * Fault tolerance is the rule: a cloud failure must NEVER block the local
 * settle flow or render the menu unusable. Uploads swallow errors; the board
 * surfaces a "暂无数据" state instead of throwing. `customSeed` runs
 * (reproducible hand-picked seeds) never upload — they don't settle meta and
 * would pollute both the board and the tuning sample.
 */
import { seniorCareerSeasonCount, seniorCareerStats, type GameState } from "../engine/types";
import { legacyRank } from "../meta/legacy";

const DEVICE_KEY = "pitch-reincarnation:device:v1";
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// NOTE: deviceId is collected on upload + stored server-side for backend
// attribution, but is NOT included in the board response (never shown to other
// viewers). The viewer's own id is sent only as a query param for my-rank.
export interface LeaderboardEntry {
  seed: string;
  name: string;
  position: string;
  nationalityId: string;
  leagueId: string;
  pace: string;
  ascension: number;
  /** Equipped blessing ids as a CSV (e.g. "golden_boy,iron_lungs,oracle").
   *  Empty for careers uploaded before this field / custom-daily runs. */
  loadout: string;
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
  wonGoldenBoot: number;
  wonGoldenGlove: number;
  goals: number;
  assists: number;
  appearances: number;
  cleanSheets: number;
  goalsConceded: number;
  rankName: string;
  retireReason: string | null;
  createdAt: string;
  /** 1 if this row belongs to the requesting viewer's device, else 0 (derived
   *  server-side from device_id — the raw id is never returned). The board
   *  uses it to mark the viewer's own uploaded careers with a prestige wash. */
  mine: number;
}

export interface BoardResponse {
  entries: LeaderboardEntry[];
  total: number;
  myRank: number | null;
  /** Lifetime careers across all players — unfiltered, shown as the game's
   *  "已开局 N 段生涯" total in the board header. */
  lifetimeRuns: number;
}

/** Anonymous, stable device id — generated once, stored in localStorage. Used
 *  only to compute the viewer's own rank on the board. No login, no PII. */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = uuid();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // storage unavailable (private mode) — return an ephemeral id; the board's
    // "my rank" just won't resolve this session, which is fine.
    return uuid();
  }
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // v4-ish fallback for non-secure contexts. Anonymous + collision-tolerant,
  // not a security token.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Silently upload a finished career. Never rejects — a cloud failure is
 *  logged and swallowed so the local settle flow is untouched. */
export function submitCareer(game: GameState): Promise<void> {
  if (game.customSeed) return Promise.resolve();
  const body = buildPayload(game);
  return fetch(`${API_BASE}/api/leaderboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  })
    .then((r) => {
      if (!r.ok) throw new Error(`upload ${r.status}`);
    })
    .catch((e) => {
      console.warn("[leaderboard] upload failed", e);
    });
}

function buildPayload(game: GameState): Record<string, unknown> {
  const rankName = legacyRank(game.legacy).name;
  const clubCount = new Set(game.seasons.map((s) => s.clubId)).size;
  // career totals — the numbers a career is remembered by, summed across every
  // season's stats (appearances/goals/assists for outfielders, clean sheets /
  // goals conceded for goalkeepers — both lines uploaded so the board can show
  // a keeper or an outfielder without knowing the position ahead of time).
  const totals = seniorCareerStats(game.seasons);
  return {
    deviceId: getDeviceId(),
    seed: game.seed,
    name: game.player?.name ?? "?",
    position: game.player?.position ?? "ST",
    nationalityId: game.player?.nationalityId ?? "chn",
    leagueId: game.startLeagueId ?? game.seasons[0]?.leagueId ?? "",
    pace: game.pace ?? "normal",
    ascension: game.ascension,
    loadout: (game.loadout ?? []).join(","),
    legacy: game.legacy,
    maxOverall: game.maxOverall,
    seasons: seniorCareerSeasonCount(game.seasons),
    finalAge: game.age,
    trophies: game.trophies.length,
    awards: game.awards.length,
    injuriesTaken: game.injuriesTaken ?? 0,
    severeInjuries: game.severeInjuries ?? 0,
    clubCount,
    wonWorldCup: game.trophies.includes("world_cup"),
    wonBallonDor: game.awards.includes("ballon_dor"),
    wonGoldenBoot: game.awards.includes("golden_boot"),
    wonGoldenGlove: game.awards.includes("golden_glove"),
    goals: totals.goals,
    assists: totals.assists,
    appearances: totals.appearances,
    cleanSheets: totals.cleanSheets,
    goalsConceded: totals.goalsConceded,
    rankName,
    retireReason: game.retirementReason,
    // the engine-tuning sample: which decisions the player faced and how they
    // resolved, so the backend can measure event trigger frequency, option
    // mix, and per-option good-rate offline.
    events: (game.choiceLog ?? []).map((e) => ({
      age: e.age,
      title: e.title,
      choice: e.choice,
      outcome: e.outcome,
      good: e.good,
    })),
  };
}

/** Fetch the global board, optionally filtered. All axes AND-compose on the
 *  server, and the scope (total / myRank) follows the same filter so a view
 *  ranks you within that slice.
 *    nat  — nationality id (e.g. "bra")
 *    pos  — position code (e.g. "ST", "GK")
 *    seed — exact seed; the 今日 dimension sends dailySeed(today) so the board
 *           shows that day's daily-challenge race (every daily run on a date
 *           shares the same seed — fair, same-hand race).
 *  Throws on network/server error — the caller shows a fallback state. */
export async function fetchLeaderboard(opts: { nat?: string; pos?: string; seed?: string; limit?: number } = {}): Promise<BoardResponse> {
  const params = new URLSearchParams();
  if (opts.nat) params.set("nat", opts.nat);
  if (opts.pos) params.set("pos", opts.pos);
  if (opts.seed) params.set("seed", opts.seed);
  if (opts.limit) params.set("limit", String(opts.limit));
  params.set("deviceId", getDeviceId());
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/api/leaderboard${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`board ${res.status}`);
  return (await res.json()) as BoardResponse;
}
