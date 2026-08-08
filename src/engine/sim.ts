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
  STARTER_TRAIN_BONUS, DEV_CEILING_FLOOR, DEV_CEILING_RAMP, CALLUP_THRESHOLD, ROLE_GROUP, LEAGUES,
  starDifficulty, scoringAbility, starTier,
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

/** Weekly wage (€K) — base ~0.5% of market value per week, inflated by league
 *  reputation (big leagues pay more relative to value), then scaled by the
 *  league's 财力 wealth, plus a 招牌 fame premium for stars in fame leagues, and
 *  capped by an optional 工资帽 salaryCap. The financial axis the 母本 keeps
 *  separate from reputation: 财力 = what a league can PAY (wealth), 声望 = what a
 *  player is WORTH (market value, rep-driven). So a Saudi star earns a fame
 *  premium on a high-wealth base, yet his market value stays low (low rep) —
 *  overpaid-relative-to-value, the money-vs-prestige trade-off made real. */
export function computeWage(marketValue: number, overall: number, league: League, club: Club): number {
  const rep = Math.max(league.domRep, league.contRep);
  const wageMult = 0.4 + rep * 0.08;   // rep0=0.4%, rep5=0.8% of value per week
  const clubPremium = 1 + club.rep * 0.06;
  // fame premium: only fame leagues, scales with star tier (≥90 ×1.36 / ≥85
  // ×1.24 / ≥80 ×1.12 / else ×1) — the 招牌 signing premium (母本 ce()).
  const famePremium = league.fame ? 1 + 0.12 * starTier(overall) : 1;
  let wage = marketValue * 1000 * (wageMult / 100) * clubPremium * league.wealth * famePremium;
  if (league.salaryCap !== undefined) wage = Math.min(wage, league.salaryCap);
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
  const concedeMult = CONCEDE_MULT[clamp(club.rep, 0, 9)]!;
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
 *  + domestic-cup + tier-2 caps.
 *
 *  `captain`: when the player holds the captain armband at THIS club, his
 *  leadership lifts the domestic trophy odds (a captain raises his team — the
 *  football story of the armband). Applied to league + cup only: continental
 *  ties are squad-depth-driven, not captain-influenced. The bonus is small
 *  (+8%) but visible in the transfer "stay" odds and the live trophy bars, so
 *  accepting captaincy is a real build choice, not a label. */
const CAPTAIN_TROPHY_MULT = 1.08;
export function clubTrophyCandidates(
  overall: number,
  club: Club,
  league: League,
  age: number,
  toff = 0,
  captain = false,
): readonly TrophyRoll[] {
  const out: TrophyRoll[] = [];
  const rep = clamp(club.rep, 0, 9);          // CLUB strength drives trophy odds
  const base = SQUAD_BASE[rep]!;
  const domDiff = overall - base;             // player contribution vs club level
  const capMult = captain ? CAPTAIN_TROPHY_MULT : 1;

  // league title — indexed by club rep; a star can lift it a little
  let leagueProb = LEAGUE_PROB[rep]!;
  // a second-tier club in a country with a top flight rarely wins promotion-tier
  const hasTopTier = LEAGUES.some((l) => l.country === league.country && l.tier === 1);
  if (league.tier === 2 && hasTopTier) {
    leagueProb = Math.min(0.3, secondTierLeagueProb(overall));
  }
  out.push({ trophy: "league", prob: Math.min(1, leagueProb * starDifficulty(domDiff) * capMult) });

  // domestic cup
  if (league.hasDomesticCup) {
    out.push({ trophy: "cup", prob: Math.min(1, CUP_PROB[rep]! * starDifficulty(domDiff) * capMult) });
  }

  // continental primary — gate by club rep (only strong clubs compete continentally)
  if (rep >= 5) {
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
 *  median, now sits ABOVE it, zeroing ~75% of careers). The 82-89 majority
 *  (50% of careers) needs a small 'none' (trophyless) path — individual
 *  brilliance over team shortfall — gated to starters via the appearances>=35
 *  eligibility. The 82 tier is the UNGUIDED-random majority path and is kept
 *  low so a first-run player rarely wins (target ~5% career-ever); the elite
 *  90/94/97 tiers are trimmed (P-AWARD) because the multiplicative stack —
 *  base × goalFactor × (league+continental) — was letting a 94 ST winning the
 *  double with 45+ goals roll at ~0.18/season, bloating the prestige endgame
 *  ever-rate to 40% (target ~25-30%, "一代一遇"). The 94/97 tiers are reached
 *  only by skilled/endgame careers, so trimming them hits the over-rewarded
 *  top without crushing the random base. decay 0.5^priorMajorAwards makes a
 *  2nd/3rd Ballon d'Or rare and special (it does not move the ever-won rate,
 *  which is dominated by the first win at decay=1.0). */
function awardBaseProb(overall: number, wonLeague: boolean, wonContinental: boolean): number {
  // P-META 压基线: measured career-ever Ballon d'Or rate was 24% on a fresh
  // account's FIRST run (random choices) — the per-season rates compound over
  // ~15 eligible seasons far harder than they read. Halved across the board
  // (tier ORDERING preserved) targeting ~5% career-ever for an unguided run;
  // skilled play (holding 94+, winning doubles) still multiplies the odds.
  // P-AWARD: the elite tiers (90/94/97) were STILL over-rewarding after the
  // base-line halve because goalFactor (then 1.5x at 45+ goals) stacked on top
  // of the league+continental sub-tier. Trimmed ~25-30% across 90/94/97; the
  // 82 tier (the random majority path) is UNCHANGED so the unguided base is
  // preserved. The league+continental sub-tier is cut hardest — that is the
  // elite-double path only top-club careers reach.
  if (overall >= 97) return wonLeague && wonContinental ? 0.09 : wonContinental ? 0.068 : wonLeague ? 0.058 : 0.048;
  if (overall >= 94) return wonLeague && wonContinental ? 0.048 : wonContinental ? 0.038 : wonLeague ? 0.036 : 0.03;
  if (overall >= 90) return wonLeague && wonContinental ? 0.043 : wonContinental ? 0.036 : wonLeague ? 0.036 : 0.029;
  if (overall >= 82) {
    if (wonLeague && wonContinental) return 0.05;
    if (wonContinental) return 0.035;
    if (wonLeague) return 0.022;    // P-AWARD: was 0.03 — a league title alone (no
    // continental) is a fine season, not a Ballon d'Or season. Trimmed so it
    // doesn't compound over ~10 EPL seasons at 82-89 (a long-career league
    // winner) into a third of EPL ballon winners.
    return 0.010;                 // P-AWARD: was 0.015 — the individual-brilliance
    // path (no team silverware). A trophyless 82-89 season winning Ballon d'Or
    // should be a rare freak (Messi 2010 was already 90+, not 85), not ~28% of
    // EPL winners. Trimmed so the elite endgame stays ≤30% while an unguided
    // first run (median peak 77, rarely reaches this tier) keeps a ~3% rate
    // — rare-but-possible, matching "first run rarely wins".
  }
  return 0;
}

function goalFactor(goals: number): number {
  // P-AWARD: toned (was 1.5/1.25, then 1.3/1.12). A 45-goal season is elite
  // but the base prob already encodes "you are elite"; the old multiplicative
  // stack double-counted volume on top of the league+continental team-success
  // bonus, pushing a double-winning 94 ST to ~0.18/season. 1.22/1.07 keeps
  // goals meaningful (a 45-goal season still lifts you ~22% over a 20-goal
  // peer) without inflating the elite tier that already wins the double.
  if (goals >= 45) return 1.22;
  if (goals >= 35) return 1.07;
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
  league?: League,
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
  // P-AWARD: decay 0.6→0.5 — a 2nd Ballon d'Or/Golden Glove is now half as
  // likely, a 3rd a quarter. The ever-won rate is set by the first win
  // (decay=1.0) so this only makes REPEATS rarer and more special, matching
  // the football story (Messi's 8 are freakish, not the norm). It also keeps
  // a single peak season from sweeping every award in a 5-year window.
  const decay = Math.pow(0.5, priorMajorAwards);
  const majorProb = Math.min(1, base * posMod * goalFactor(stats.goals) * decay);
  const r = derive(seed, "awards", age);
  if (chance(r, majorProb)) out.push(isGK ? "golden_glove" : "ballon_dor");
  // golden boot: an ELITE top-scorer award, not a "good season" consolation.
  // Two gates (was only a low goal threshold, so ~20% of careers won it — a
  // median-peak ST farming a weak club hit 34 goals → 50% per peak season):
  //   1. LEAGUE QUALITY: only a top-tier league (tier 1, contRep≥4 — the
  //      European Golden Shoe tier) awards it. A star padding stats in a 2nd
  //      division or minor league wins THEIR scoring title, not this award.
  //   2. ELITE VOLUME: 40+ goals to be in the conversation, 50+ to guarantee —
  //      a 28-goal season is a fine year, not a Golden Boot year. Targets a
  //      ~8-12% career-ever rate (rare, between Ballon d'Or and the old 20%).
  if (!isGK && league && league.tier === 1 && league.contRep >= 4) {
    const bootProb = stats.goals >= 50 ? 1 : stats.goals >= 45 ? 0.5 : stats.goals >= 40 ? 0.2 : 0;
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

/** Development ceiling factor (P-CEIL): 1.0 while the player is within their
 *  club's full-growth band (SQUAD_BASE + DEV_CEILING_FLOOR), ramping linearly
 *  to ~0 over DEV_CEILING_RAMP[rep] above it (per-rep: gentle 15 at base-game
 *  clubs, steep 6 at elite clubs). Used by applyCeiling's delta-scaling path
 *  (rep ≤ 5); the elite (rep ≥ 6) path caps the RESULT instead (see applyCeiling).
 *  Decline (negative deltas) is never scaled — a star who transfers DOWN
 *  keeps their level. */
export function growthCeilingFactor(overall: number, club: Club): number {
  const rep = clamp(club.rep, 0, 9);
  const base = SQUAD_BASE[rep]!;
  const floor = DEV_CEILING_FLOOR[rep]!;
  const excess = Math.max(0, overall - (base + floor));
  return clamp(1 - excess / DEV_CEILING_RAMP[rep]!, 0, 1);
}

/** Apply the club development ceiling to a positive OVR delta. Negative or
 *  zero deltas pass through unchanged. Pure — no RNG.
 *
 *  Two cap models, split by club rep to preserve base-game dynamics while
 *  containing full-prestige endgame overshoot:
 *  - rep ≤ 5 (base-game clubs): DELTA-SCALING — scale the delta by the ceiling
 *    factor at the current OVR (the original soft cap). Identical to the
 *    pre-P-ENDGAME behavior, so base-game careers (random 77 / skilled 80
 *    medians) are unchanged.
 *  - rep ≥ 6 (elite clubs): RESULT-BASED — cap the RESULTING OVR. The delta-
 *    scaling cap can't contain the huge full-prestige deltas (wonderkid [0,9]
 *    × glass_cannon 1.5 = up to +13/season): factor is evaluated at the
 *    current OVR, so a big delta from below the ceiling jumps straight past
 *    the ramp to 99. Capping the result scales the portion of the delta that
 *    LANDS above the ceiling, so a +13 from OVR 88 at Real (ceiling 92) becomes
 *    ~+5, not +9-to-99. Peak ≈ ceiling + ramp/2, so the steep elite ramp (6)
 *    lands full-prestige peaks at ~94, not 97-99. Decline is never scaled. */
export function applyCeiling(delta: number, overall: number, club: Club): number {
  if (delta <= 0) return delta;
  const rep = clamp(club.rep, 0, 9);
  // base-game clubs: original delta-scaling soft cap (preserves base dynamics)
  if (rep <= 5) return Math.round(delta * growthCeilingFactor(overall, club));
  // elite clubs: result-based soft cap (contains huge full-prestige deltas)
  const ceiling = SQUAD_BASE[rep]! + DEV_CEILING_FLOOR[rep]!;
  const result = overall + delta;
  if (result <= ceiling) return delta; // result still within full-growth band
  const excess = result - ceiling;
  const factor = clamp(1 - excess / DEV_CEILING_RAMP[rep]!, 0, 1);
  const cappedResult = Math.max(overall, ceiling + Math.round(excess * factor));
  return cappedResult - overall;
}

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
  // Only shift bracket lookup once the career has REACHED decline (>=28):
  // shifting younger ages would displace the growth brackets and stunt the
  // whole development curve (the pre-fix behavior gutted careers).
  if (declineDelay > 0 && targetAge >= 28) {
    targetAge = Math.max(26, targetAge - declineDelay * 2);
  }
  const table = isGK ? GK_DEV_TABLE : DEV_TABLES[player.devProfile];
  const bracket = table[targetAge] ?? (isGK ? GK_DEV_FALLBACK : OUTFIELD_DEV_FALLBACK);
  let [min, max] = bracket;

  // 从严 (ascension 1): bias the delta toward the range floor (take the min of
  // two rolls) — growth is uniformly harder across the whole career. P-ASC:
  // previously applied min-of-two on EVERY bracket, collapsing skilled 90+
  // from 42% (asc 0) to 4% (asc 1) — a 9-OVR cliff at the very first rung,
  // killing the "mud→marble" fantasy the moment a player climbs. Now it only
  // bites the BIG-SWING brackets (range width ≥ 4, the youth-growth spikes
  // like wonderkid [0,9]/[0,8]) — the steady small brackets ([0,3]/[-1,2])
  // and all decline brackets pass through with a single roll, so the
  // accumulation that carries a career to 88-92 survives. The bench penalty
  // below still takes min-of-two/three unconditionally (it gates the RAW roll).
  const strict = ascension >= 1;
  const isLowRole = role === "low_rotation" || role === "substitute" || role === "third_keeper";
  // P-A16: butterfly effect — bench time at a BIG club is worse than at a small
  // club (you're further from the pitch, more competition). An extra growth
  // penalty when benched at a rep≥3 club makes the "move to a giant too early"
  // choice bite — the career fork the user wants.
  const bigClubBench = isLowRole && club.rep >= 6 && Math.floor((targetAge - 16) / 2) >= 1;
  const minRolls = (strict && min < max && (max - min) >= 4) || (Math.floor((targetAge - 16) / 2) >= 2 && isLowRole) || bigClubBench;
  let delta: number;
  if (minRolls) {
    const r2 = int(rng, min, max);
    const r1 = int(rng, min, max);
    // big-club bench takes the min of THREE rolls — growth really stalls
    delta = bigClubBench ? Math.min(r1, r2, int(rng, min, max)) : Math.min(r1, r2);
  } else {
    delta = int(rng, min, max);
  }

  // starter training bonus on positive growth (normal path only, as before —
  // the min-of-rolls penalty paths never got the bonus).
  let bonus = 0;
  if (!minRolls) {
    const isStarterish = role === "starter" || (targetAge === 18 && !isLowRole);
    if (isStarterish && delta > 0) {
      // bigger clubs have better training facilities — use club rep
      bonus = STARTER_TRAIN_BONUS[clamp(club.rep, 0, 9)]!;
    }
  }

  // Development ceiling (P-CEIL) is NOT applied here — growthDelta returns the
  // RAW club-rep-driven delta. The orchestrator (run.ts) applies `applyCeiling`
  // to the FINAL delta AFTER all growth multipliers (glass_cannon ×1.5,
  // late_bloomer, pp_scout, compromised_body) so the cap binds the actual OVR
  // gain, not just the pre-multiplier base. Applying it here let the post-
  // multiplier inflation bypass the cap — full-prestige endgames stacked
  // +1/+1/+1 past the ceiling and bloated to a 97-99 median. bigClubBench (the
  // bench penalty above) still lives here since it gates the RAW roll, not the
  // final gain. Aging decline (delta ≤ 0) is unaffected — a star who transfers
  // DOWN keeps their level but can't improve.
  return delta + bonus;
}

// ───────────────────────────── retirement horizon (P-RETIRE) ─────────────────────────────
//
// The career no longer ends at a fixed age 40. Past RETENTION_START the body
// must EARN each new period: a retention roll (run.ts) gates whether the
// player keeps getting picked. Modric/Casillas play to 40+ because a star
// above squad level passes easily; a 伤仲永 crashing out fails early; a
// player whose wage prices him out of the game is squeezed (events.ts). The
// hard MAX_AGE ceiling is the authored safety net — the growth-table decline
// at 44+ is so steep almost no one reaches it (the roll retires them first).
//
// projectedRetireAge is the LIVE horizon that replaces the old fixed "40 退役"
// label. It walks the dev-table decline forward and finds the first age where
// single-year retention odds flip against the player. No rng — just table
// midpoints + retentionProb. The horizon MOVES: an injury (compromised_body)
// pulls it in, a transfer to a bigger club pulls it in (higher squad base),
// a longevity blessing pushes it out. This is the Zeigarnik pull done
// honestly — the far edge is EARNED, not promised.

/** Age at which the soft retention roll begins. */
export const RETENTION_START = 33;
/** Hard ceiling — a run always terminates (the authored safety net). */
export const MAX_AGE = 46;
/** Single-year retention odds below which the horizon reports "cut soon". */
const RETIRE_HORIZON_THRESHOLD = 0.35;

/** Probability the player keeps getting picked for another period. Pure —
 *  no rng; the roll itself lives in run.ts as derive(seed,"retention",age,pi).
 *  Drivers: OVR cushion above club level (a star stays), age (harder each
 *  year), compromised_body (the body is broken), severe injuries, and
 *  longevity blessings/perks (comeback / late_bloomer / pp_longevity — the
 *  Modric/Casillas arc). The bands are tuned so a prime 33yo star retains
 *  ~97%, a 38yo fading to squad level ~35%, a 40yo well below ~10%. */
export function retentionProb(
  overall: number,
  age: number,
  club: Club,
  statusTags: readonly string[],
  severeInjuries: number,
  blessings: readonly string[],
  permPerks: readonly string[],
): number {
  const base = SQUAD_BASE[clamp(club.rep, 0, 9)]!;
  const cushion = overall - base;
  // baseline by age: 33→0.88, each year −0.10 (38→0.38, 40→0.18)
  let p = 0.98 - Math.max(0, age - 32) * 0.10;
  // cushion: each OVR above squad base +1.8%; below base −1.8% (a benched vet slips)
  p += cushion * 0.018;
  // compromised_body: playing through injuries wrecked the body
  if (statusTags.some((t) => t.split("@")[0] === "compromised_body")) p -= 0.20;
  // each severe injury past the first shortens the career
  p -= Math.max(0, severeInjuries - 1) * 0.06;
  // longevity: the Modric/Casillas arc
  if (blessings.includes("comeback")) p += 0.08;
  if (blessings.includes("late_bloomer")) p += 0.06;
  if (permPerks.includes("pp_longevity")) p += 0.12;
  // club standing — the club stands by its leaders and icons. A captain, a fan
  // darling, a club legend, a mentor is retained longer (Totti at Roma,
  // Casillas at Real, Zanetti the mentor-president): the club keeps a player who
  // MEANS something to it past the point a journeyman would be cut. This is the
  // compounding the persona-tag "build" was missing — earning captaincy /
  // fan status / legend status / mentorship pays off in CAREER LENGTH, not just
  // a summary label. The tags otherwise sit inert; here they become a real
  // build investment. Capped at +0.10 so a captain+legend+mentor doesn't
  // over-stack; bounded so decline still wins by ~42.
  let standing = 0;
  if (statusTags.some((t) => t.split("@")[0] === "club_legend")) standing += 0.07;
  if (statusTags.some((t) => t.split("@")[0] === "mentor_legend")) standing += 0.05;
  if (statusTags.some((t) => t.split("@")[0] === "captain")) standing += 0.04;
  if (statusTags.some((t) => t.split("@")[0] === "fan_darling")) standing += 0.03;
  p += Math.min(standing, 0.10);
  return clamp(p, 0.02, 0.97);
}

/** Projected retirement age — the LIVE horizon. Walks the dev-table decline
 *  forward from the player's current age and finds the first age where
 *  single-year retention odds flip against him. Recomputed by the UI each
 *  render so the horizon MOVES with the career — an injury pulls it in, a
 *  transfer up pulls it in, longevity pushes it out. Floored at age+1 so it
 *  never reports a past retirement. */
export function projectedRetireAge(
  player: Player,
  club: Club,
  statusTags: readonly string[],
  severeInjuries: number,
  blessings: readonly string[],
  permPerks: readonly string[],
): number {
  const isGK = player.position === "GK";
  const table = isGK ? GK_DEV_TABLE : DEV_TABLES[player.devProfile];
  const fallback = isGK ? GK_DEV_FALLBACK : OUTFIELD_DEV_FALLBACK;
  const compromised = statusTags.some((t) => t.split("@")[0] === "compromised_body");
  let ovr = player.overall;
  let age = player.age;
  while (age < MAX_AGE) {
    age += 1;
    // mirror growthDelta's even-age bracket selection so the decline curve
    // matches the real sim (odd ages look up the next even bracket).
    const targetAge = age % 2 === 0 ? age + 2 : age + 1;
    const bracket = table[targetAge] ?? fallback;
    const mid = Math.round((bracket[0] + bracket[1]) / 2);
    // compromised_body: −1 growth per season (mirrors simulatePeriod)
    const delta = compromised ? mid - 1 : mid;
    ovr = clamp(ovr + delta, 40, 99);
    if (age >= RETENTION_START) {
      const p = retentionProb(ovr, age, club, statusTags, severeInjuries, blessings, permPerks);
      if (p < RETIRE_HORIZON_THRESHOLD) return age;
    }
  }
  return MAX_AGE;
}
