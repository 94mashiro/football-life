/**
 * Narrative context — the player's OWN facts, for scripted story events.
 *
 * The story events in events.ts are each modelled on a real footballer, and
 * they used to carry that footballer's biography verbatim: born in Spain,
 * heart in Morocco; 115 goals for Juventus; Premier League record fee. Fired
 * for a Chinese striker at Salzburg, that reads as somebody else's life.
 *
 * This module derives the equivalent facts from THIS career — nationality,
 * continent, continental cup, club, league, former club, shirt number — so a
 * script can say "整个亚洲在等你" / "你在萨尔茨堡进了115个球" and stay true.
 *
 * Everything here is pure and deterministic: picks are hashed off the run seed
 * (via rng.derive on a fresh state) so they never disturb the career's RNG
 * stream and re-render identically on reload.
 */
import type { Club, Confederation, League, Position } from "./data";
import { CLUBS, LEAGUES, NATIONS, clubById, nationById } from "./data";
import { derive, int } from "./rng";
import { seniorCareerSeasonCount, seniorCareerStats, type SeasonResult } from "./types";

/** Structural input — EventContext satisfies this without importing events.ts
 *  (which imports this module; a named interface keeps the cycle broken). */
export interface NarrativeInput {
  player: { readonly nationalityId: string; readonly name: string; readonly position: Position; readonly squadNumber: number };
  club: Club;
  league: League;
  seed: string;
  age: number;
  formerClubIds?: readonly string[];
  /** The career's season log so far. Absent on call sites that predate it
   *  (the career-total fields then read 0 and the copy degrades gracefully). */
  seasons?: readonly SeasonResult[];
}

/** Confederation → the continent a script would name, and its national cup. */
const CONTINENT: Record<Confederation, string> = {
  UEFA: "欧洲", CONMEBOL: "南美", CONCACAF: "中北美", AFC: "亚洲", CAF: "非洲", OFC: "大洋洲",
};
const CONTINENTAL_CUP: Record<Confederation, string> = {
  UEFA: "欧洲杯", CONMEBOL: "美洲杯", CONCACAF: "金杯赛", AFC: "亚洲杯", CAF: "非洲杯", OFC: "大洋洲国家杯",
};
/** Confederation → its top club competition, as a script would name it. */
const CONTINENTAL_CLUB_CUP: Record<Confederation, string> = {
  UEFA: "欧冠", CONMEBOL: "解放者杯", CONCACAF: "中北美冠军杯", AFC: "亚冠", CAF: "非洲冠军联赛", OFC: "大洋洲冠军联赛",
};

/** Chinese numeral for 1..99 — the prose style writes ages out ("你十九岁"). */
const CN_DIGIT = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
export function cnNum(n: number): string {
  if (n < 0 || n > 99 || !Number.isInteger(n)) return String(n);
  if (n < 10) return CN_DIGIT[n]!;
  if (n < 20) return n === 10 ? "十" : `十${CN_DIGIT[n % 10]}`;
  const tens = `${CN_DIGIT[Math.floor(n / 10)]}十`;
  return n % 10 === 0 ? tens : `${tens}${CN_DIGIT[n % 10]}`;
}

export interface Narrative {
  /** 中国 */ nation: string;
  /** chn */ nationId: string;
  confederation: Confederation;
  /** 亚洲 */ continent: string;
  /** 亚洲杯 */ continentalCup: string;
  /** 亚冠 */ continentalClubCup: string;
  /** A traditional powerhouse (fifaRep >= 3) — a deep run is history repeating,
   *  not a first. Scripts must not tell Brazil it has never been here. */
  isPowerhouse: boolean;
  /** Never been anywhere (fifaRep === 0) — the pioneer scripts are true here. */
  isMinnow: boolean;
  /** 萨尔茨堡 */ club: string;
  /** 奥甲 */ league: string;
  /** Top flight of the player's own country (中超), or 国内联赛 if it has none. */
  homeLeague: string;
  /** The club the player left most recently, or "" if this is still club one. */
  formerClub: string;
  /** formerClub, or a neutral stand-in so a script never renders an empty slot. */
  formerClubOr: string;
  /** The club's iconic rival, else the strongest other club in the league. */
  derbyClub: string;
  /** Strongest club in the league that isn't the player's — the marquee scalp. */
  bigClub: string;
  /** A deterministic opponent nation from the same confederation. */
  rivalNation: string;
  /** A deterministic heavyweight opponent nation (fifaRep >= 3). */
  worldRivalNation: string;
  /** A big league that isn't this one — where the scouts come from. */
  scoutLeague: string;
  /** 9 — the player's actual shirt number. */
  squadNumber: number;
  /** 十九 — the player's actual age, written out. */
  ageCn: string;
  age: number;
  name: string;

  // ── career-to-date facts ────────────────────────────────────────────────
  // The story events used to quote the real footballer's numbers (115 goals,
  // 607 games, 三次金球奖). Fired for a 22-year-old with 40 caps that reads as
  // somebody else's CV, so every number a script states now comes from here.
  /** Career league appearances so far. */
  careerApps: number;
  /** Career goals so far. */
  careerGoals: number;
  /** Career assists so far. */
  careerAssists: number;
  /** Career clean sheets so far (the GK equivalent of goals). */
  careerCleanSheets: number;
  /** The player's headline output — goals for outfielders, clean sheets for GKs. */
  careerOutput: number;
  /** 进球 / 零封 — the label that goes with careerOutput. */
  outputLabel: string;
  /** Seasons played so far (the season log's length). */
  careerSeasons: number;
  /** Consecutive seasons at the CURRENT club (0 on the debut period). */
  seasonsAtClub: number;
  /** 十 — seasonsAtClub written out (at least 一, so prose never reads "你踢了零年"). */
  seasonsAtClubCn: string;
  /** How many clubs the career has passed through, current one included. */
  clubCount: number;
  /** National-team caps / goals so far. */
  caps: number;
  capGoals: number;
  /** Ballon d'Or count so far — a script may only crown the player if this > 0. */
  ballonDors: number;
  /** Club + national trophies won so far. */
  trophyCount: number;
  /** Most recent market value, as prose money ("€6000万" / "€1.2亿"). */
  fee: string;
  /** The career's own starting age, written out (十六) — 生涯起点, not a guess. */
  startAgeCn: string;
}

/** START_AGE, mirrored here so narrative.ts stays free of a run.ts import
 *  (run.ts imports events.ts imports narrative.ts — the reverse would cycle). */
const CAREER_START_AGE = 16;

/** €M → the way a Chinese match report writes a fee. */
export function feeCn(m: number): string {
  if (!(m > 0)) return "一笔不算大的转会费";
  if (m >= 100) return `€${(m / 100).toFixed(m % 100 === 0 ? 0 : 1)}亿`;
  return `€${Math.round(m * 100)}万`;
}

function pickFrom<T>(arr: readonly T[], seed: string, salt: string): T | undefined {
  if (arr.length === 0) return undefined;
  const r = derive(seed, "narr", salt);
  return arr[int(r, 0, arr.length - 1)];
}

/** The boss/climax builders (world_cup_showdown & friends) resolve against a
 *  ctx stub that carries only blessings + odds — they narrate a tournament, not
 *  the player's biography, so they never read these facts. Fill the stub in
 *  rather than crash: narrative() is a display-fact provider, not a gate. */
const STUB_PLAYER = { nationalityId: "bra", name: "你", position: "ST" as Position, squadNumber: 10 };

/** Per-context memo. `narrative()` is pure in its input and rescans CLUBS /
 *  LEAGUES on every call, but the callers hammer it with the SAME context
 *  object: resolveEventOption starts with narrative(ctx), and optionPreview
 *  dry-runs that resolver 8× per event (2 options × 2 branches × 2 salts) just
 *  to render the pills. Keying the cache on the context identity is exact —
 *  a context object is built fresh per period in run.ts and never mutated, so
 *  a hit can only ever return what a recompute would. Profile: narrative() was
 *  ~25% of headless sim CPU before this. */
const NARRATIVE_MEMO = new WeakMap<NarrativeInput, Narrative>();

export function narrative(ctx: NarrativeInput): Narrative {
  const memo = NARRATIVE_MEMO.get(ctx);
  if (memo) return memo;
  const built = buildNarrative(ctx);
  NARRATIVE_MEMO.set(ctx, built);
  return built;
}

function buildNarrative(ctx: NarrativeInput): Narrative {
  if (!ctx.player || !ctx.club || !ctx.league) {
    ctx = {
      ...ctx,
      player: ctx.player ?? STUB_PLAYER,
      club: ctx.club ?? CLUBS[0]!,
      league: ctx.league ?? LEAGUES[0]!,
      seed: ctx.seed ?? "",
      age: ctx.age ?? 16,
    };
  }
  const nation = nationById(ctx.player.nationalityId);
  const conf = nation.confederation;

  const home = LEAGUES.find((l) => l.tier === 1 && l.country.toLowerCase() === nation.id);

  // Former club = the most recent id in formerClubIds that isn't the current
  // club. run.ts builds that list from the season log in chronological order.
  const priorIds = (ctx.formerClubIds ?? []).filter((id) => id !== ctx.club.id);
  const formerId = priorIds[priorIds.length - 1];
  const formerClub = formerId ? safeClubName(formerId) : "";

  const leagueClubs = CLUBS.filter((c) => c.leagueId === ctx.club.leagueId && c.id !== ctx.club.id);
  const derby = ctx.club.rivalId ? safeClubName(ctx.club.rivalId) : "";
  const strongest = [...leagueClubs].sort((a, b) => b.rep - a.rep)[0];

  // Career totals — every number a script quotes about the player's past.
  const seasons = ctx.seasons ?? [];
  const careerStats = seniorCareerStats(seasons);
  let caps = 0, capGoals = 0;
  let ballonDors = 0, trophyCount = 0, marketValue = 0;
  for (const s of seasons) {
    caps += s.national?.caps ?? 0; capGoals += s.national?.goals ?? 0;
    ballonDors += s.awards.filter((a) => a === "ballon_dor").length;
    trophyCount += s.trophies.length;
    if (s.marketValue) marketValue = s.marketValue;
  }
  // Consecutive tail of seasons at the current club — "你在这里踢了N年".
  let seasonsAtClub = 0;
  for (let i = seasons.length - 1; i >= 0 && seasons[i]!.clubId === ctx.club.id; i--) seasonsAtClub++;
  const isGK = ctx.player.position === "GK";

  const sameConf = NATIONS.filter((n) => n.confederation === conf && n.id !== nation.id && n.fifaRep + n.contRep >= 3);
  const heavies = NATIONS.filter((n) => n.fifaRep >= 3 && n.id !== nation.id);
  const bigLeagues = LEAGUES.filter((l) => l.tier === 1 && l.domRep >= 4 && l.id !== ctx.league.id);

  return {
    nation: nation.name,
    nationId: nation.id,
    confederation: conf,
    continent: CONTINENT[conf],
    continentalCup: CONTINENTAL_CUP[conf],
    continentalClubCup: CONTINENTAL_CLUB_CUP[conf],
    isPowerhouse: nation.fifaRep >= 3,
    isMinnow: nation.fifaRep === 0,
    club: ctx.club.name,
    league: ctx.league.name,
    homeLeague: home?.name ?? "国内联赛",
    formerClub,
    formerClubOr: formerClub || "老东家",
    derbyClub: derby || strongest?.name || "同城对手",
    bigClub: strongest?.name ?? "榜首球队",
    rivalNation: pickFrom(sameConf, ctx.seed, "rival-nation")?.name ?? "东道主",
    worldRivalNation: pickFrom(heavies, ctx.seed, "world-rival")?.name ?? "卫冕冠军",
    scoutLeague: pickFrom(bigLeagues, ctx.seed, "scout-league")?.name ?? "欧洲豪门",
    squadNumber: ctx.player.squadNumber,
    ageCn: cnNum(ctx.age),
    age: ctx.age,
    name: ctx.player.name,
    careerApps: careerStats.appearances,
    careerGoals: careerStats.goals,
    careerAssists: careerStats.assists,
    careerCleanSheets: careerStats.cleanSheets,
    careerOutput: isGK ? careerStats.cleanSheets : careerStats.goals,
    outputLabel: isGK ? "零封" : "进球",
    careerSeasons: seniorCareerSeasonCount(seasons),
    seasonsAtClub,
    seasonsAtClubCn: cnNum(Math.max(1, seasonsAtClub)),
    clubCount: new Set([...seasons.map((s) => s.clubId), ctx.club.id]).size,
    caps,
    capGoals,
    ballonDors,
    trophyCount,
    fee: feeCn(marketValue),
    startAgeCn: cnNum(CAREER_START_AGE),
  };
}

function safeClubName(id: string): string {
  try { return clubById(id).name; } catch { return ""; }
}
