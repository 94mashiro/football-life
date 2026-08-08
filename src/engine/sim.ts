/**
 * Season simulation engine — pure functions, explicit RNG threading.
 *
 * The sim is deterministic: every function takes an RngState, mutates it by
 * drawing, and returns structured results. No hidden state, no Math.random.
 *
 * Pipeline per season (mirrors the target game's Ii):
 *   role → stats (goals/assists/clean sheets)
 *   → club trophies (league/cup/continental/CWC)
 *   → national team (WC/continental)
 *   → individual awards (Ballon d'Or/golden boot/glove)
 *   → growth/decline for next season
 */
import type { RngState } from "./rng";
import { chance, int, float, derive } from "./rng";
import {
  type League, type Position, type RoleGroup, type Club,
  SQUAD_BASE, LEAGUE_PROB, CUP_PROB, CONT_PRIMARY_PROB, CONT_SECONDARY_PROB,
  CWC_PROB, NAT_CONT_PROB, WC_WIN_PROB, WC_QUAL_PROB, WC_CARRY_THRESHOLDS,
  GOALS_PER_APP, ASSISTS_PER_APP, LEAGUE_SCORE_MULT, CONCEDE_MULT,
  DEV_TABLES, GK_DEV_TABLE, GK_DEV_FALLBACK, OUTFIELD_DEV_FALLBACK,
  STARTER_TRAIN_BONUS, CALLUP_THRESHOLD, ROLE_GROUP, LEAGUES,
  starDifficulty, scoringAbility,
  isCwcAge, isNatContAge, isWcAge, nationById,
} from "./data";
import type { SeasonStats, Trophy, Award, Player, Role } from "./types";
import { ZERO_STATS } from "./types";

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const EMPTY: readonly string[] = [];

// ───────────────────────────── market value & wage (P-A17) ─────────────────────────────
//
// A player's market value (€M) and weekly wage (€K) are driven by:
//   - OVR (the dominant factor: 90+ = €80M+, 80 = €30M, 70 = €8M, 60 = €1M)
//   - age curve (peak value at 24-26, falls off sharply after 30)
//   - league prestige (a 85 in the Premier League is worth more than in MLS)
//   - club rep (big clubs inflate the wage)
//   - role (a starter commands full value; a bench player is discounted)
//   - season performance (rating + trophies + honors modulate the base)
// Performance feeds BACK into value, so a great season raises the next
// transfer window's offers and a poor one lowers them — the butterfly effect
// the user wants: choose your league and perform, because it compounds.

/** Base market value (€M) from OVR alone — exponential, realistic curve.
 *  MODERATE re-anchor (coupling-aware): the growth trim (P-A161) moved avg peak
 *  86→82, collapsing peak-82 value across two cliffs. But a full 4pt threshold
 *  shift (peak-82 base 15→40, 2.67x) was found to SUPPRESS growth via the transfer
 *  market — higher value pushes players to bigger clubs where SQUAD_BASE 84/88
 *  benches them (bigClubBench min-of-3 penalty), dropping 90+ 15→11% and avg
 *  81.8→79.9. So the top 4 tiers (95/92/89/86) are PINNED (€100M stays gated to
 *  peak-86+/89+ at top clubs — the task's explicit ask is preserved WITHOUT any
 *  change), and only GENTLE value bumps (≤1.33x) are applied to the mid tiers so
 *  peak-82 wages/value feel rewarding (≈€28-47M, €215-447K/wk) without disrupting
 *  the transfer-driven growth path. The €50M milestone is reachable for peak-82
 *  only at a big club with great performance — football-authentic, not a giveaway. */
function baseValueFromOvr(overall: number): number {
  if (overall >= 95) return 130;   // PINNED — elite ceiling €130M
  if (overall >= 92) return 90;    // PINNED
  if (overall >= 89) return 60;    // PINNED — €100M for peak-89+ at top clubs
  if (overall >= 86) return 40;    // PINNED — €100M for peak-86+ at rep5
  if (overall >= 83) return 28;    // was 25 (+3)
  if (overall >= 80) return 20;    // was 15 (+5) — peak-82 wages feel rewarding
  if (overall >= 75) return 10;    // was 8 (+2)
  if (overall >= 70) return 4;     // was 3
  if (overall >= 65) return 1.5;   // was 1
  if (overall >= 60) return 0.4;   // was 0.3
  return 0.1;
}

/** Age multiplier — value peaks at 24-26, collapses by 33+. */
function ageValueMult(age: number): number {
  if (age <= 18) return 0.85;     // potential premium but unproven
  if (age <= 21) return 0.95;
  if (age <= 26) return 1.0;       // peak value years
  if (age <= 28) return 0.92;
  if (age <= 30) return 0.78;
  if (age <= 32) return 0.55;
  if (age <= 34) return 0.35;
  if (age <= 36) return 0.18;
  return 0.08;
}

/** League prestige multiplier — a top-5 league inflates value ~1.6×, a
 *  minor league deflates it to ~0.4×. Drives the "go to a bigger league"
 *  financial pull. */
function leaguePrestigeMult(league: League): number {
  const rep = Math.max(league.domRep, league.contRep);
  return 0.4 + rep * 0.24;   // rep0=0.4, rep5=1.6
}

/** Role discount — a bench player's value is heavily discounted (no one pays
 *  full price for a player who can't get on the pitch). */
function roleValueMult(role: Role): number {
  switch (role) {
    case "starter": return 1.0;
    case "high_rotation": return 0.85;
    case "low_rotation": return 0.55;
    case "substitute": return 0.30;
    case "third_keeper": return 0.20;
    default: return 0.5;
  }
}

/** Performance multiplier — a great season (high rating, trophies, honors)
 *  inflates value up to ~1.4×; a poor season deflates to ~0.7×. This is the
 *  feedback loop: perform → value rises → better offers next window. */
function perfValueMult(rating: number | null, trophies: number, hasMvp: boolean): number {
  let m = 1.0;
  if (rating !== null) {
    if (rating >= 8.0) m += 0.25;
    else if (rating >= 7.3) m += 0.10;
    else if (rating < 6.3) m -= 0.20;
    else if (rating < 6.8) m -= 0.10;
  }
  m += Math.min(0.15, trophies * 0.04);
  if (hasMvp) m += 0.08;
  return Math.max(0.5, Math.min(1.4, m));
}

/** Compute market value (€M) for a season. Pure — no RNG. */
export function computeMarketValue(
  overall: number, age: number, league: League, club: Club, role: Role,
  rating: number | null, trophies: number, hasMvp: boolean,
): number {
  const base = baseValueFromOvr(overall);
  const v = base * ageValueMult(age) * leaguePrestigeMult(league) * roleValueMult(role) * perfValueMult(rating, trophies, hasMvp);
  // club rep nudges wage, not value much, but a tiny premium for being at a big club
  const clubNudge = 1 + club.rep * 0.02;
  return Math.round(v * clubNudge * 10) / 10;
}

/** Weekly wage (€K) — ~0.5% of market value per week, inflated by league rep
 *  (big leagues pay more relative to value). */
export function computeWage(marketValue: number, league: League, club: Club): number {
  const rep = Math.max(league.domRep, league.contRep);
  const wageMult = 0.4 + rep * 0.08;   // rep0=0.4%, rep5=0.8% of value per week
  const clubPremium = 1 + club.rep * 0.06;
  const wage = marketValue * 1000 * (wageMult / 100) * clubPremium;
  return Math.round(wage);
}

/** Relative-strength level 0..6 (0 = star on weak team, 6 = weak on strong team). */
function strengthLevel(diff: number): number {
  if (diff >= 8) return 0;
  if (diff >= 6) return 1;
  if (diff >= 2) return 2;
  if (diff >= -2) return 3;
  if (diff >= -5) return 4;
  if (diff >= -9) return 5;
  return 6;
}

/** Role from OVR gap vs the CLUB's squad base (club.rep, not league rep). */
export function resolveRole(overall: number, club: Club, isGK: boolean): Role {
  const base = SQUAD_BASE[club.rep]!;
  const diff = overall - base;
  if (isGK) {
    if (diff >= 0) return "starter";
    if (diff >= -6) return "substitute";
    return "third_keeper";
  }
  if (diff >= 0) return "starter";
  if (diff >= -4) return "high_rotation";
  if (diff >= -8) return "low_rotation";
  return "substitute";
}

/** Appearance count range by role (club path uses these, not minute fractions). */
function appearanceRange(role: Role, isGK: boolean): readonly [number, number] {
  if (isGK) {
    switch (role) {
      case "starter": return [42, 50];
      case "substitute": return [2, 12];
      case "third_keeper": return [0, 4];
      default: return [2, 12];
    }
  }
  switch (role) {
    case "starter": return [40, 50];
    case "high_rotation": return [25, 39];
    case "low_rotation": return [15, 24];
    case "substitute": return [5, 14];
    default: return [5, 14];
  }
}

/** Appearance multiplier: big clubs (higher domestic rep) play more matches. */
function appearanceMult(league: League): number {
  if (league.domRep === 0) return 0.7;
  if (league.domRep === 1) return 0.8;
  if (league.contRep === 0) return 0.9;
  return 1;
}

/** Simulate one season's stats. Mutates `rng`. */
export function simSeasonStats(
  rng: RngState,
  overall: number,
  position: Position,
  league: League,
  club: Club,
  role: Role,
  suspended: boolean,
  blessings: readonly string[] = EMPTY,
): SeasonStats {
  if (suspended) return { ...ZERO_STATS };
  const isGK = position === "GK";
  const roleGroup: RoleGroup = ROLE_GROUP[position];
  const [lo, hi] = appearanceRange(role, isGK);
  const rawApps = int(rng, lo, hi);
  const appearances = Math.round(rawApps * appearanceMult(league));
  if (appearances === 0) return { ...ZERO_STATS, appearances: 0 };

  // strength is relative to the CLUB's squad base (a star at a weak club dominates)
  const base = SQUAD_BASE[club.rep]!;
  const diff = overall - base;
  const level = strengthLevel(diff);

  if (isGK) {
    // a strong club concedes less (better defenders); use club rep for concede factor
    const concedeMult = CONCEDE_MULT[clamp(club.rep, 0, 5)]!;
    const concededBase = Math.max(0, Math.round(appearances * concedeMult * concedeLevelFactor(diff)));
    const form = float(rng, 0.9, 1.1);
    const conceded = Math.max(0, Math.round(concededBase * form));
    const csProb = clamp(0.42 - (appearances === 0 ? 0 : (conceded / appearances) * 0.12), 0.05, 0.5);
    const cleanSheets = Math.max(0, Math.round(appearances * csProb));
    return { appearances, goals: 0, assists: 0, cleanSheets, goalsConceded: conceded };
  }

  const leagueScore = LEAGUE_SCORE_MULT[clamp(league.domRep, 0, 5)]!;
  const scoringAbi = scoringAbility(overall);
  const form = float(rng, 0.9, 1.1);
  const h = form * leagueScore * scoringAbi;
  // sharpshooter: +20% goal rate.
  const goalMult = blessings.includes("sharpshooter") ? 1.2 : 1;
  const gpa = (GOALS_PER_APP[roleGroup][level] ?? 0) * goalMult;
  const apa = ASSISTS_PER_APP[roleGroup][level] ?? 0;
  return {
    appearances,
    goals: Math.max(0, Math.round(appearances * gpa * h)),
    assists: Math.max(0, Math.round(appearances * apa * h)),
    cleanSheets: 0,
    goalsConceded: 0,
  };
}

function concedeLevelFactor(diff: number): number {
  if (diff >= 10) return 0.5;
  if (diff >= 6) return 0.75;
  if (diff >= 3) return 0.9;
  if (diff >= -2) return 1;
  if (diff >= -5) return 1.1;
  if (diff >= -9) return 1.2;
  return 1.35;
}

// ───────────────────────────── club trophies ─────────────────────────────

export interface TrophyRoll {
  trophy: Trophy;
  prob: number;   // final probability shown to player
}

/** Compute the season's trophy candidates with their visible probabilities.
 *  Club-driven: a club's rep decides its trophy odds (realistic — one player
 *  can't carry a minnow to a title; you must transfer up). The player's OVR vs
 *  the club's squad base adds a small star bonus. League supplies confederation
 *  + domestic-cup + tier-2 caps. */
export function clubTrophyCandidates(
  overall: number,
  club: Club,
  league: League,
  age: number,
  toff = 0,
): readonly TrophyRoll[] {
  const out: TrophyRoll[] = [];
  const rep = clamp(club.rep, 0, 5);          // CLUB strength drives trophy odds
  const base = SQUAD_BASE[rep]!;
  const domDiff = overall - base;             // player contribution vs club level

  // league title — indexed by club rep; a star can lift it a little
  let leagueProb = LEAGUE_PROB[rep]!;
  // a second-tier club in a country with a top flight rarely wins promotion-tier
  const hasTopTier = LEAGUES.some((l) => l.country === league.country && l.tier === 1);
  if (league.tier === 2 && hasTopTier) {
    leagueProb = Math.min(0.3, secondTierLeagueProb(overall));
  }
  out.push({ trophy: "league", prob: Math.min(1, leagueProb * starDifficulty(domDiff)) });

  // domestic cup
  if (league.hasDomesticCup) {
    out.push({ trophy: "cup", prob: Math.min(1, CUP_PROB[rep]! * starDifficulty(domDiff)) });
  }

  // continental primary — gate by club rep (only strong clubs compete continentally)
  if (rep >= 3) {
    const conf = league.confederation;
    const baseProb = conf === "UEFA" ? CWC_PROB.UEFA[rep]! : CONT_PRIMARY_PROB[rep]!;
    out.push({ trophy: "continental_primary", prob: Math.min(1, baseProb * starDifficulty(domDiff)) });
  }
  // continental secondary
  out.push({ trophy: "continental_secondary", prob: Math.min(1, CONT_SECONDARY_PROB[rep]! * starDifficulty(domDiff)) });
  // club world cup — per-confederation base prob (母本 values)
  if (isCwcAge(age, toff)) {
    const conf = league.confederation;
    const table = CWC_PROB[conf] ?? CWC_PROB.UEFA;
    const baseProb = table[rep] ?? 0;
    out.push({ trophy: "club_world_cup", prob: Math.min(1, baseProb * starDifficulty(domDiff)) });
  }
  return out;
}

function secondTierLeagueProb(overall: number): number {
  const table: ReadonlyArray<readonly [number, number]> = [
    [64, 0.03], [69, 0.04], [74, 0.06], [79, 0.09], [84, 0.13], [87, 0.18], [89, 0.25], [99, 0.3],
  ];
  for (const [thr, p] of table) if (overall <= thr) return p;
  return 0.3;
}

// ───────────────────────────── national team ─────────────────────────────

export interface NationalRoll {
  calledUp: boolean;
  trophies: { trophy: Trophy; stage: string }[];
}

/** Optional overrides from climax events (world_cup_showdown / decisive_penalty /
 *  injury_before_tournament / club_national_team_conflict). When set, the
 *  corresponding national roll is forced/skipped instead of rolled. */
export interface NationalOverrides {
  /** Force/skip a specific national trophy. */
  nationalTrophyOverride?: { trophy: string; result: "force" | "skip" };
  /** Override the World Cup result stage directly (champion/final/sf/...). */
  worldCupResultOverride?: string;
  /** "force" → play even if not qualified; "skip" → sit out. */
  nationalTournamentParticipation?: "force" | "skip";
  /** Force participation in a specific national tournament. */
  nationalTournament?: string;
}

export function simulateNational(
  seed: string,
  player: Player,
  age: number,
  overrides: NationalOverrides = {},
  toff = 0,
): NationalRoll {
  const nation = nationById(player.nationalityId);
  const threshold = CALLUP_THRESHOLD[clamp(nation.intlRep, 0, 5)]!;
  // "force" participation bypasses the threshold (e.g. decisive_penalty on the
  // national stage, injury_before_tournament "play_through").
  if (overrides.nationalTournamentParticipation !== "force" && player.overall < threshold) {
    return { calledUp: false, trophies: [] };
  }
  if (overrides.nationalTournamentParticipation === "skip") {
    return { calledUp: false, trophies: [] };
  }
  const trophies: { trophy: Trophy; stage: string }[] = [];

  if (isNatContAge(age, toff)) {
    const contRep = clamp(nation.contRep, 0, 6);
    const forced = overrides.nationalTrophyOverride?.trophy === "national_continental"
      ? overrides.nationalTrophyOverride.result : undefined;
    if (forced === "force") {
      trophies.push({ trophy: "national_continental", stage: "champion" });
    } else if (forced !== "skip") {
      const winProb = NAT_CONT_PROB[contRep]!;
      const r = derive(seed, "nat-cont", age);
      if (chance(r, winProb)) trophies.push({ trophy: "national_continental", stage: "champion" });
    }
  }
  if (isWcAge(age, toff)) {
    const fifaRep = clamp(nation.fifaRep, 0, 5);
    const wcForced = overrides.nationalTrophyOverride?.trophy === "world_cup"
      ? overrides.nationalTrophyOverride.result : undefined;
    // Direct result override (world_cup_showdown / continental_cup_showdown):
    // skip qualification entirely. "national_continental" routes a minnow's
    // continental-cup climax through this same override path so the showdown
    // builder and the sim share one mechanism.
    if (overrides.worldCupResultOverride) {
      if (overrides.worldCupResultOverride === "champion") {
        trophies.push({ trophy: "world_cup", stage: "champion" });
      } else if (overrides.worldCupResultOverride === "national_continental") {
        trophies.push({ trophy: "national_continental", stage: "champion" });
      }
      return { calledUp: true, trophies };
    }
    if (wcForced === "force") {
      trophies.push({ trophy: "world_cup", stage: "champion" });
      return { calledUp: true, trophies };
    }
    if (wcForced === "skip") {
      return { calledUp: true, trophies };
    }
    // qualification, boosted by player carry tiers
    let carry = 0;
    for (const t of WC_CARRY_THRESHOLDS) if (player.overall >= t) carry++;
    const qualIdx = clamp(nation.contRep + carry, 0, WC_QUAL_PROB.length - 1);
    const r1 = derive(seed, "wc-qual", age);
    if (!chance(r1, WC_QUAL_PROB[qualIdx]!)) return { calledUp: true, trophies };
    const r2 = derive(seed, "wc-fate", age);
    const winProb = WC_WIN_PROB[fifaRep]!;
    if (chance(r2, winProb)) trophies.push({ trophy: "world_cup", stage: "champion" });
  }
  return { calledUp: true, trophies };
}

// ───────────────────────────── awards ─────────────────────────────

/** Ballon d'Or/Golden Glove base probability by OVR + which trophies won.
 *  DECOUPLED from peak OVR: the entry gate shifts 85→82 to match the new avg
 *  peak (the growth trim moved avg 86→82; the old 85 gate sat just below the old
 *  median, now sits ABOVE it, zeroing ~75% of careers). Top tiers 94/97 are
 *  PINNED (unchanged) to preserve tier ordering and the elite ceiling. The 90
 *  tier is raised ~60% (the 14% peak-90+ group still can't carry 12% alone).
 *  The 82-89 majority (50% of careers) needs a small 'none' (trophyless) path —
 *  individual brilliance over team shortfall — gated to starters via the
 *  appearances>=35 eligibility. decay 0.7^priorMajorAwards is kept (it only
 *  affects 2nd+ wins; the 12% target is an ever-won career rate). */
function awardBaseProb(overall: number, wonLeague: boolean, wonContinental: boolean): number {
  if (overall >= 97) return wonLeague && wonContinental ? 0.30 : wonContinental ? 0.20 : wonLeague ? 0.15 : 0.12;
  if (overall >= 94) return wonLeague && wonContinental ? 0.20 : wonContinental ? 0.14 : wonLeague ? 0.11 : 0.09;
  if (overall >= 90) return wonLeague && wonContinental ? 0.18 : wonContinental ? 0.13 : wonLeague ? 0.10 : 0.08;
  if (overall >= 82) {
    if (wonLeague && wonContinental) return 0.13;
    if (wonContinental) return 0.09;
    if (wonLeague) return 0.08;
    return 0.06;   // individual-brilliance path; starter-only via eligibility; dominant 82-89 source, kept just under league
  }
  return 0;
}

function goalFactor(goals: number): number {
  if (goals >= 45) return 1.5;
  if (goals >= 35) return 1.25;
  return 1;
}

export function rollAwards(
  seed: string,
  age: number,
  overall: number,
  position: Position,
  stats: SeasonStats,
  trophies: readonly Trophy[],
  priorMajorAwards: number,
): Award[] {
  const out: Award[] = [];
  const wonLeague = trophies.includes("league");
  const wonContinental = trophies.includes("continental_primary") || trophies.includes("world_cup") || trophies.includes("national_continental");
  const isGK = position === "GK";
  // GK needs 14 clean sheets + 35 appearances to be eligible
  if (isGK && (stats.appearances < 35 || stats.cleanSheets < 14)) return out;
  if (!isGK && stats.appearances < 35) return out;

  const base = awardBaseProb(overall, wonLeague, wonContinental);
  if (base <= 0) return out;
  const posMod = isGK ? 1 : awardPosModInternal(position);
  const decay = Math.pow(0.7, priorMajorAwards);
  const majorProb = Math.min(1, base * posMod * goalFactor(stats.goals) * decay);
  const r = derive(seed, "awards", age);
  if (chance(r, majorProb)) out.push(isGK ? "golden_glove" : "ballon_dor");
  // golden boot: needs goals threshold + top league (approximated by appearances)
  if (!isGK) {
    const bootProb = stats.goals >= 46 ? 1 : stats.goals >= 36 ? 0.5 : stats.goals >= 28 ? 0.2 : 0;
    if (bootProb > 0 && chance(r, bootProb)) out.push("golden_boot");
  }
  return out;
}

function awardPosModInternal(pos: Position): number {
  if (pos === "CB" || pos === "LB" || pos === "RB") return 0.25;
  if (pos === "CM" || pos === "CDM") return 0.5;
  return 1;
}

// ───────────────────────────── growth ─────────────────────────────

/** 2-year development cycle delta for the player's current target age. */
export function growthDelta(
  rng: RngState,
  player: Player,
  role: Role,
  club: Club,
  league: League,
  ascension = 0,
  declineDelay = 0,
): number {
  void league;
  const isGK = player.position === "GK";
  let targetAge = player.age % 2 === 0 ? player.age + 2 : player.age + 1;
  // 岁月催人 (ascension 4): decline starts at 26 instead of 28 — pull forward the
  // age used for the development bracket so the negative-delta brackets kick in early.
  // pp_longevity (常青树): push the decline onset back by one cycle (declineDelay).
  if (ascension >= 4 && targetAge >= 26) {
    targetAge = Math.max(26, targetAge + 2);
  }
  if (declineDelay > 0) {
    targetAge = Math.max(16, targetAge - declineDelay * 2);
  }
  const table = isGK ? GK_DEV_TABLE : DEV_TABLES[player.devProfile];
  const bracket = table[targetAge] ?? (isGK ? GK_DEV_FALLBACK : OUTFIELD_DEV_FALLBACK);
  let [min, max] = bracket;

  // 从严 (ascension 1): bias the delta toward the range floor (take the min of
  // two rolls) — growth is uniformly harder across the whole career.
  const strict = ascension >= 1;
  // bench penalty: targetAge>=20 and low role → take min of two rolls (stunts growth)
  const isLowRole = role === "low_rotation" || role === "substitute" || role === "third_keeper";
  // P-A16: butterfly effect — bench time at a BIG club is worse than at a small
  // club (you're further from the pitch, more competition). An extra growth
  // penalty when benched at a rep≥3 club makes the "move to a giant too early"
  // choice bite — the career fork the user wants.
  const bigClubBench = isLowRole && club.rep >= 3 && Math.floor((targetAge - 16) / 2) >= 1;
  if ((strict && min < max) || (Math.floor((targetAge - 16) / 2) >= 2 && isLowRole) || bigClubBench) {
    const r2 = int(rng, min, max);
    const r1 = int(rng, min, max);
    // big-club bench takes the min of THREE rolls — growth really stalls
    if (bigClubBench) return Math.min(r1, r2, int(rng, min, max));
    return Math.min(r1, r2);
  }
  const delta = int(rng, min, max);
  // starter training bonus on positive growth
  const isStarterish = role === "starter" || (targetAge === 18 && !isLowRole);
  let bonus = 0;
  if (isStarterish && delta > 0) {
    // bigger clubs have better training facilities — use club rep
    bonus = STARTER_TRAIN_BONUS[clamp(club.rep, 0, 5)]!;
  }
  return delta + bonus;
}
