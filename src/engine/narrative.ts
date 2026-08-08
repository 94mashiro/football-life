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

/** Structural input — EventContext satisfies this without importing events.ts
 *  (which imports this module; a named interface keeps the cycle broken). */
export interface NarrativeInput {
  player: { readonly nationalityId: string; readonly name: string; readonly position: Position; readonly squadNumber: number };
  club: Club;
  league: League;
  seed: string;
  age: number;
  formerClubIds?: readonly string[];
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
}

function pickFrom<T>(arr: readonly T[], seed: string, salt: string): T | undefined {
  if (arr.length === 0) return undefined;
  const r = derive(seed, "narr", salt);
  return arr[int(r, 0, arr.length - 1)];
}

export function narrative(ctx: NarrativeInput): Narrative {
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
  };
}

function safeClubName(id: string): string {
  try { return clubById(id).name; } catch { return ""; }
}
