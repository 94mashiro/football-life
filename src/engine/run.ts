/**
 * Run orchestrator — turns a seed + starting setup into a full career by
 * chaining season simulations and pausing at period boundaries for the
 * player to make decisions.
 *
 * Pure state transitions: every function takes a GameState and returns a new
 * GameState (immutable). The UI reducer in store.ts drives these. No React
 * here, no side effects — fully unit-testable.
 *
 * Period model (mirrors target game): one "period" = periodLengthSeasons
 * consecutive seasons. The player makes ONE decision at the end of each
 * period (transfer / event / retire). The standard mode is 2 seasons/period.
 */
import type { RngState } from "./rng";
import { derive, chance } from "./rng";
import {
  type League, type Position, type Club, leagueById, nationById,
  clubById, weakestClubInLeague, strongerClubInLeague, generatePlayerName, generateSquadNumber,
} from "./data";
import {
  resolveRole, simSeasonStats, clubTrophyCandidates, simulateNational,
  rollAwards, growthDelta, computeMarketValue, computeWage,
} from "./sim";
import {
  rollRandomEvent, rollInjuryEvent, transferEvent, loanOfferEvent,
  postLoanEvent, blockbusterOfferEvent, doctorWarningEvent, medicalVerdictEvent,
  worldCupShowdown, worldCupQualifierShowdown, decisivePenalty,
  fireEventByKey,
  type EventContext, type FiredEvent,
} from "./events";
import type {
  GameState, Player, SeasonResult, Trophy, Award, Role, Choice, Modifiers, SeasonStats,
  CareerEventPlan, Challenge, CareerBeat, Milestone, ChoiceLogEntry,
} from "./types";
import { trophyMult } from "./types";
import { rollDevProfile } from "../meta/legacy";
import { generateRival } from "./rival";

const PERIOD_LENGTH = 1;        // seasons per period — one decision every season for decision density
const START_AGE = 16;
const START_OVR = 50;
const RETIRE_AGE = 40;
const FORCE_RETIRE_OVR = 50;
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

// ───────────────────────────── run creation ─────────────────────────────

/** 母本 pace modes: 沉浸(1 season/decision), 标准(2, default), 速通(3). */
export type PaceMode = "long" | "normal" | "express";
export const PACE_LENGTH: Record<PaceMode, number> = { long: 1, normal: 2, express: 3 };

/** 母本 personalEventCount per mode (E[mode].personalEventCount). */
const PERSONAL_EVENT_COUNT: Record<PaceMode, readonly [number, number]> = {
  long: [6, 7], normal: [3, 4], express: [2, 3],
};

/** Generate slot ages for career events, evenly spaced. (Ur) */
function slotAgesForMode(periodLen: number): number[] {
  const start = 16 + Math.ceil(6 / periodLen) * periodLen;
  const ages: number[] = [];
  for (let age = start; age <= 37; age += periodLen) ages.push(age);
  return ages;
}

/** All non-adjacent combinations of `count` slot ages. (Wr) */
function slotCombinations(ages: readonly number[], count: number): number[][] {
  const result: number[][] = [];
  const recurse = (start: number, current: number[]) => {
    if (current.length === count) { result.push(current); return; }
    for (let i = start; i < ages.length; i += 1) recurse(i + 2, [...current, ages[i]!]);
  };
  recurse(0, []);
  return result;
}

/** Initialize the career event plan. (Gr) Deterministic from seed + mode. */
export function initCareerPlan(seed: string, pace: PaceMode): CareerEventPlan {
  const periodLen = PACE_LENGTH[pace];
  const [lo, hi] = PERSONAL_EVENT_COUNT[pace];
  const countRng = derive(seed, "career-plan-count");
  // count = lo + value*(hi-lo) rounded
  const count = lo + Math.floor((countRng.s / 4294967296) * (hi - lo + 1));
  const combos = slotCombinations(slotAgesForMode(periodLen), count);
  if (combos.length === 0) {
    return { targetCount: 0, slotAges: [], completedEventKeys: [], completedSlotAges: [], completedEventAges: [], injuryCount: 0 };
  }
  const pickRng = derive(seed, "career-plan-slots");
  const idx = Math.floor((pickRng.s / 4294967296) * combos.length);
  return {
    targetCount: count,
    slotAges: combos[idx] ?? [],
    completedEventKeys: [], completedSlotAges: [], completedEventAges: [], injuryCount: 0,
  };
}

/** Update the plan after an event fires. (qr) */
function updatePlan(plan: CareerEventPlan, eventKey: string, slotAge: number, age: number): CareerEventPlan {
  if (eventKey === "injury") {
    return { ...plan, injuryCount: plan.injuryCount + 1 };
  }
  return {
    ...plan,
    completedEventKeys: [...plan.completedEventKeys, eventKey],
    completedSlotAges: [...plan.completedSlotAges, slotAge],
    completedEventAges: [...plan.completedEventAges, age],
  };
}

export interface RunSetup {
  seed: string;
  nationalityId: string;
  position: Position;
  leagueId: string;
  blessings: readonly string[];
  ascension: number;
  pace?: PaceMode;
  /** Custom player name — overrides the seed-generated one. Empty/omitted → generated. */
  playerName?: string;
  /** Custom squad number 1-99 — overrides the seed-generated one. Invalid → generated. */
  squadNumber?: number;
  /** Permanent prestige perks (earned via the Prestige loop, never lost). */
  permPerks?: readonly string[];
  /** A redemption goal carried from the prior run's near-miss (P3). */
  challenge?: Challenge;
}

/** Perks that duplicate a blessing's effect are folded into the blessing id so
 *  existing engine checks (`blessings.includes(...)`) pick them up for free. */
function foldPerksIntoBlessings(blessings: readonly string[], perks: readonly string[]): readonly string[] {
  const folded: string[] = [];
  if (perks.includes("pp_comeback_base")) folded.push("comeback");
  if (perks.includes("pp_oracle_base")) folded.push("oracle");
  const merged = [...blessings, ...folded];
  return [...new Set(merged)];
}

export function createRun(setup: RunSetup): GameState {
  const isGK = setup.position === "GK";
  const allowWonderkid = true; // gated by unlock in UI before reaching here
  const devProfile = rollDevProfile(setup.seed, isGK, allowWonderkid);
  const permPerks = setup.permPerks ?? EMPTY_PERKS;
  // fold perk effects that mirror blessings into the active blessing set so the
  // engine's existing `blessings.includes(...)` checks get them automatically.
  const blessings = foldPerksIntoBlessings(setup.blessings, permPerks);
  // golden_boy: start OVR 53; pp_prodigy: +2 (stacks).
  let startOvr = START_OVR;
  if (blessings.includes("golden_boy")) startOvr += 3;
  if (permPerks.includes("pp_prodigy")) startOvr += 2;
  // Custom name/number are cosmetic (never feed any derive) — determinism of
  // career outcomes is untouched; only the identity printed on the shirt changes.
  const customName = setup.playerName?.trim() ?? "";
  const customNumber = setup.squadNumber;
  const player: Player = {
    position: setup.position,
    nationalityId: setup.nationalityId,
    overall: startOvr,
    age: START_AGE,
    devProfile,
    name: customName ? customName.slice(0, 16) : generatePlayerName(setup.seed, setup.nationalityId),
    squadNumber: customNumber !== undefined && Number.isInteger(customNumber) && customNumber >= 1 && customNumber <= 99
      ? customNumber
      : generateSquadNumber(setup.seed, setup.position),
  };
  // start at the weakest club in the chosen league — the underdog beginning.
  // pp_scout (青训球探): start one club-rep tier stronger (cap at top division).
  let startClub = weakestClubInLeague(setup.leagueId, setup.seed);
  if (permPerks.includes("pp_scout")) {
    startClub = strongerClubInLeague(setup.leagueId, startClub, setup.seed);
  }
  const pace: PaceMode = setup.pace ?? "normal";
  // P5: generate the career-long rival — same age, same position, contrasting
  // nationality/club. Deterministic from the seed so a seed is reproducible.
  const rival = generateRival(setup.seed, setup.position, setup.nationalityId);
  return {
    phase: "playing",
    seed: setup.seed,
    player,
    currentClubId: startClub.id,
    currentLeagueId: startClub.leagueId,
    seasons: [],
    maxOverall: startOvr,
    trophies: [],
    awards: [],
    pendingChoice: null,
    legacy: 0,
    ascension: setup.ascension,
    pace,
    periodLength: PACE_LENGTH[pace],
    retired: false,
    retirementReason: null,
    age: START_AGE,
    blessings,
    permPerks,
    challenge: setup.challenge,
    rival,
    injuriesTaken: 0,
    statusTags: [],
  };
}

// ───────────────────────────── period simulation ─────────────────────────────

/**
 * Simulate one period (PERIOD_LENGTH seasons) deterministically, then build
 * the decision the player faces at its end. Returns the updated GameState
 * with pendingChoice set (player must resolve it to continue).
 *
 * If the player retires mid-period (forced by age/OVR), returns the summary
 * phase directly.
 */
export function simulatePeriod(state: GameState): GameState {
  if (!state.player || state.pendingChoice) return state;
  const seed = state.seed;

  const mods0 = state.pendingMods ?? EMPTY_MODS;
  // 医学退役 (P-B1): the verdict's retire choice (or a failed comeback gamble)
  // ends the career before any further seasons are simulated.
  if (mods0.forceRetire) {
    // the dignified-exit legacy bonus still counts (normal mods flow is skipped).
    const bonus = legacyFromMods(mods0, state.blessings ?? EMPTY_BLESSINGS, state.permPerks ?? EMPTY_PERKS);
    return finalizeRun(state, state.currentClubId, state.currentLeagueId, state.seasons, state.trophies, state.awards, state.maxOverall, state.legacy + bonus, state.player, "injury");
  }
  // 母本 loan model: a loan-out resolves into loanOutTo; the player plays at the
  // loan club until returnAge, then auto-returns to the parent club.
  let activeLoan = state.activeLoan;
  let currentClubId = state.currentClubId;
  let completedLoan = state.completedLoan;
  if (mods0.loanOutTo) {
    activeLoan = { parentClubId: state.currentClubId, loanClubId: mods0.loanOutTo, returnAge: mods0.loanReturnAge ?? state.player.age + 2 };
    currentClubId = mods0.loanOutTo;
    completedLoan = undefined; // a new loan supersedes the post-loan window
  } else if (mods0.newClubId) {
    // a permanent transfer clears any active loan and moves clubs.
    activeLoan = undefined;
    currentClubId = mods0.newClubId;
  } else if (activeLoan && state.player.age >= activeLoan.returnAge) {
    // loan expired → return to parent club, mark completed for the post-loan
    // resolution window (母本 ca).
    completedLoan = { parentClubId: activeLoan.parentClubId, loanClubId: activeLoan.loanClubId };
    currentClubId = activeLoan.parentClubId;
    activeLoan = undefined;
  }
  const club = clubById(currentClubId);
  const league = leagueById(club.leagueId);
  const currentLeagueId = league.id;

  let seasons = [...state.seasons];
  let trophies = [...state.trophies];
  let awards = [...state.awards];
  let player = state.player;
  // foreign_grandfather: national-allegiance switch takes effect this period.
  if (mods0.newNationalityId) player = { ...player, nationalityId: mods0.newNationalityId };
  // P-A1: career story beats — captured per-season for the narrative feed.
  let beats: readonly CareerBeat[] = [...(state.careerBeats ?? EMPTY_BEATS)];
  let maxOverall = state.maxOverall;
  let legacy = state.legacy;
  let periodIndex = state.seasons.length > 0 ? Math.floor(state.seasons.length / PERIOD_LENGTH) : 0;

  // effective modifiers from a previously-resolved event apply this period.
  // OVR deltas are split by timing so an event that says "+3" actually moves
  // the player +3 — previously these were dropped, and deferredOverallDelta
  // was mis-applied once per season (×2 per period).
  //   immediate   → applied before the period's first season (now)
  //   permanent   → applied before the period's first season (now, lasting)
  //   deferred    → applied after the period's last season (the "payoff")
  const mods = state.pendingMods ?? EMPTY_MODS;
  const blessings = state.blessings ?? EMPTY_BLESSINGS;
  // branching consequences: new tags from the previous choice are added, and
  // existing tags decay by one period (tags carry a TTL, e.g. "fan_darling@2").
  const prevTags = (state.statusTags ?? EMPTY_TAGS).map(decayTag).filter((t): t is string => t !== null);
  const newTags = mods.addTags ?? EMPTY_TAGS;
  const statusTags = dedupeTags([...newTags, ...prevTags]);
  // event-choice legacy bonus (e.g. training +5, world cup +100) — was dropped.
  const eventLegacy = legacyFromMods(mods, blessings, state.permPerks ?? EMPTY_PERKS);
  if (eventLegacy) legacy += eventLegacy;
  // ride the run-total of event legacy on state so finalize/retire can feed it
  // into scoreLegacy — previously event legacy never reached the meta score.
  if (eventLegacy) state = { ...state, eventLegacy: (state.eventLegacy ?? 0) + eventLegacy };
  const upfrontShift = (mods.immediateOverallDelta ?? 0) + (mods.permanentOverallDelta ?? 0);
  if (upfrontShift !== 0) {
    const newOvr = clamp(player.overall + upfrontShift, 40, 99);
    player = { ...player, overall: newOvr };
    maxOverall = Math.max(maxOverall, newOvr);
  }

  const periodLength = state.periodLength ?? PERIOD_LENGTH;
  // P-A4: trophy streak — consecutive trophy seasons. Resets on a dry season.
  let trophyStreak = state.trophyStreak ?? 0;
  let bestStreak = state.bestStreak ?? 0;
  let streakBonus = 0;
  for (let i = 0; i < periodLength; i++) {
    if (player.age > RETIRE_AGE) break;
    const season = simOneSeason(seed, player, club, league, mods, i, periodIndex, awards.filter(a => a === "ballon_dor" || a === "golden_glove").length, blessings, state.ascension);
    seasons.push(season);
    trophies = [...trophies, ...season.trophies];
    awards = [...awards, ...season.awards];
    maxOverall = Math.max(maxOverall, season.overall);
    legacy += scaledLegacy(season.legacy, legacyMult(blessings, state.permPerks ?? EMPTY_PERKS));
    // P-A4: streak tracking — +1 on a trophy season, reset on a dry one. Every
    // 3rd consecutive trophy season grants a legacy bonus (the dynasty reward).
    if (season.trophies.length > 0) {
      trophyStreak += 1;
      if (trophyStreak >= 3 && trophyStreak % 3 === 0) streakBonus += 8;
    } else {
      trophyStreak = 0;
    }
    bestStreak = Math.max(bestStreak, trophyStreak);
    // P-A1: capture narrative beats for the career story feed.
    beats = appendSeasonBeats(beats, season, seasons.length, player);
    // growth → next season's OVR
    const rng = derive(seed, "growth", player.age, periodIndex);
    const declineDelay = state.permPerks?.includes("pp_longevity") ? 1 : 0;
    let delta = growthDelta(rng, player, season.role, club, league, state.ascension, declineDelay);
    // 玻璃大炮: +50% growth (the payoff for ×3 injuries).
    if (blessings.includes("glass_cannon")) delta = Math.round(delta * 1.5);
    // 大器晚成: half growth before 25, +50% after 25 (the slow-burn arc).
    if (blessings.includes("late_bloomer")) {
      delta = player.age < 25 ? Math.round(delta * 0.5) : Math.round(delta * 1.5);
    }
    // P-A22: butterfly-effect long-term growth drag — a "compromised_body" tag
    // (from playing through injuries, reckless challenges, etc.) subtracts 1
    // from EVERY season's growth for as long as it persists. The wing that
    // flapped now blows for years — a career-defining fork, not a one-off bump.
    if (statusTags.includes("compromised_body")) delta -= 1;
    const newOvr = clamp(player.overall + delta, 40, 99);
    player = { ...player, age: player.age + 1, overall: newOvr };
  }

  // deferred payoff lands after the period's seasons
  if (mods.deferredOverallDelta) {
    const newOvr = clamp(player.overall + mods.deferredOverallDelta, 40, 99);
    player = { ...player, overall: newOvr };
    maxOverall = Math.max(maxOverall, newOvr);
  }

  // comeback: a chance to regain +1 OVR after 30 (tuned per season at 1-season periods).
  if (blessings.includes("comeback") && player.age >= 30) {
    const r = derive(seed, "comeback", player.age, periodIndex);
    if (chance(r, 0.25)) {
      const newOvr = clamp(player.overall + 1, 40, 99);
      player = { ...player, overall: newOvr };
      maxOverall = Math.max(maxOverall, newOvr);
    }
  }

  // P-A4: apply streak bonus to legacy.
  if (streakBonus > 0) legacy += streakBonus;

  // check retirement triggers
  if (player.age >= 26 && player.overall < FORCE_RETIRE_OVR) {
    // a PRIME-AGE body wrecked by repeated severe injuries is an injury
    // retirement even before the 3rd-strike verdict — but a 34+ fade-out with
    // old scars is just ageing, not tragedy. Otherwise flavor by peak.
    const reason = (state.severeInjuries ?? 0) >= 2 && player.age <= 33 ? "injury"
      : maxOverall >= 85 ? "faded" : "no_offers";
    return finalizeRun(state, currentClubId, currentLeagueId, seasons, trophies, awards, maxOverall, legacy, player, reason);
  }
  if (player.age >= RETIRE_AGE) {
    return finalizeRun(state, currentClubId, currentLeagueId, seasons, trophies, awards, maxOverall, legacy, player, "age");
  }

  // build the decision at period end
  const rngState = derive(seed, "period-decision", periodIndex);
  // use the JUST-SIMULATED seasons (local), not state.seasons — the stale read
  // made relegation_loyalty react one full period late (and thus never).
  const lastSeasonRelegated = seasons.length > 0 && seasons[seasons.length - 1]!.relegated;
  const plan = state.careerEventPlan ?? initCareerPlan(seed, (state.pace ?? "normal") as PaceMode);
  // P-A8: clubs the player has formerly played at (for "曾效力" transfer tags).
  const formerClubIds = [...new Set(seasons.map((s) => s.clubId))];
  const recentMarketValue = seasons.length > 0 ? (seasons[seasons.length - 1]!.marketValue ?? 0) : 0;
  const event = buildPeriodDecision(seed, player, club, league, periodIndex, rngState, state.blessings ?? EMPTY_BLESSINGS, state.injuriesTaken ?? 0, state.ascension, statusTags, lastSeasonRelegated, plan, periodLength, completedLoan, maxOverall, state.blockbusterOfferedTier, state.permPerks ?? EMPTY_PERKS, formerClubIds, recentMarketValue, state.severeInjuries ?? 0, !!state.injuryWarned, state.verdictSeenAt ?? 0);
  // record the blockbuster tier offered (母本 anti-repeat) when it fires.
  const blockbusterTier = event.event.key === "blockbuster_offer"
    ? (maxOverall >= 90 ? 3 : maxOverall >= 85 ? 2 : 2)
    : state.blockbusterOfferedTier;

  // P-A4: milestone detection — a first-time career peak/trophy crossing earns
  // a full-screen celebration popup (once per run, via milestonesSeen).
  // P-A17: peak market value this run (for the €50M/€100M milestone).
  const peakMv = seasons.length > 0 ? Math.max(...seasons.map((s) => s.marketValue ?? 0)) : 0;
  const milestone = detectMilestone(state, maxOverall, trophies, awards, player.age, peakMv)
    ?? detectCareerRecap(seasons, state.milestonesSeen ?? EMPTY_SEEN);
  const milestonesSeen = milestone ? [...(state.milestonesSeen ?? EMPTY_SEEN), milestone.id] : (state.milestonesSeen ?? EMPTY_SEEN);

  return {
    ...state,
    player,
    currentClubId,
    currentLeagueId,
    activeLoan,
    completedLoan,
    seasons,
    trophies,
    awards,
    maxOverall,
    legacy,
    age: player.age,
    statusTags,
    trophyStreak,
    bestStreak,
    careerBeats: beats,
    careerEventPlan: plan,
    blockbusterOfferedTier: blockbusterTier,
    pendingMilestone: milestone,
    milestonesSeen,
    pendingMods: EMPTY_MODS,
    pendingChoice: event.event,
    pendingResolve: event.resolve,
  };
}

/** P-A17: a lightweight engine-side season rating (5.5-9.5) for the market
 *  value performance multiplier. Mirrors the UI's seasonRating without the
 *  RoleGroup dependency (the engine doesn't import data's ROLE_GROUP). */
function engineSeasonRating(stats: SeasonStats, role: Role, position: Position, trophyCount: number, mvp: boolean): number {
  const { appearances: app, goals, assists, cleanSheets: cs, goalsConceded: gc } = stats;
  if (app === 0) return 6.0;
  const gpa = goals / app, apa = assists / app, cpa = cs / app, gcpa = gc / app;
  let r = 6.4;
  r += role === "starter" ? 0.25 : role === "high_rotation" ? 0.10 : role === "low_rotation" ? -0.05 : -0.15;
  const isAtt = position === "ST" || position === "LW" || position === "RW" || position === "CAM";
  const isDef = position === "CB" || position === "LB" || position === "RB" || position === "CDM";
  if (position === "GK") r += cpa * 2.2 - gcpa * 0.35;
  else if (isAtt) r += gpa * 2.4 + apa * 1.0;
  else if (isDef) r += cpa * 1.5 + gpa * 0.8 + apa * 0.4;
  else r += apa * 1.4 + gpa * 0.9;
  r += Math.min(0.5, trophyCount * 0.12);
  if (mvp) r += 0.5;
  return Math.max(5.5, Math.min(9.5, Math.round(r * 10) / 10));
}

function simOneSeason(
  seed: string,
  player: Player,
  club: Club,
  league: League,
  mods: Modifiers,
  seasonInPeriod: number,
  periodIndex: number,
  priorMajorAwards: number,
  blessings: readonly string[],
  ascension: number,
): SeasonResult {
  const isGK = player.position === "GK";
  const role = mods.roleOverride ?? resolveRoleWithShift(player.overall, club, isGK, mods.roleShift);
  // 伤病潮 (ascension 2): each season a small chance of a nagging injury that
  // benches the player (suspended) for that season. Base 2% → 3% at asc 2.
  // 玻璃大炮 (glass_cannon blessing): injury rate ×3 — the cost of +50% growth.
  let injuryProne = ascension >= 2 ? 0.03 : 0.02;
  if (blessings.includes("glass_cannon")) injuryProne *= 3;
  const nagRng = derive(seed, "nag-injury", player.age, periodIndex, seasonInPeriod);
  const nagInjury = chance(nagRng, injuryProne);
  const suspended = !!mods.suspended || nagInjury;

  // stats
  const statsRng = derive(seed, "stats", player.age, periodIndex, seasonInPeriod);
  const stats = simSeasonStats(statsRng, player.overall, player.position, league, club, role, suspended, blessings);

  // club trophies — driven by CLUB strength (realistic: one player can't carry a
  // minnow to a title; you must transfer up). Indexed by club.rep, not league rep.
  // 飞升 10 全面降级: every club is treated one rep tier weaker (弱旅地狱).
  const effClub = ascension >= 10 ? { ...club, rep: Math.max(0, club.rep - 1) } : club;
  const candidates = clubTrophyCandidates(player.overall, effClub, league, player.age);
  const trophies: Trophy[] = [];
  for (const c of candidates) {
    const prob = c.prob * trophyMult(mods, c.trophy);
    const r = derive(seed, "trophy", c.trophy, player.age, periodIndex, seasonInPeriod);
    const override = mods.clubTrophyOverride?.trophy === c.trophy
      ? mods.clubTrophyOverride.result
      : mods.forceTrophy?.trophy === c.trophy ? mods.forceTrophy.result : undefined;
    if (override === "force") {
      trophies.push(c.trophy);
    } else if (override === "skip") {
      // forced loss — skip
    } else if (chance(r, clamp(prob, 0, 1))) {
      trophies.push(c.trophy);
    }
  }

  // national team — climax events can force/skip/override the result
  // 飞升 9 国家队退役: no national call-ups at all — the path is closed.
  const nat = simulateNational(seed, player, player.age, {
    nationalTrophyOverride: mods.nationalTrophyOverride,
    worldCupResultOverride: mods.worldCupResultOverride,
    nationalTournamentParticipation: ascension >= 9 ? "skip" : mods.nationalTournamentParticipation,
    nationalTournament: mods.nationalTournament,
  });
  const nationalTournaments = nat.trophies.map((t) => ({ trophy: t.trophy, stage: t.stage }));
  for (const t of nat.trophies) trophies.push(t.trophy);

  // awards
  const seasonAwards = rollAwards(seed, player.age, player.overall, player.position, stats, trophies, priorMajorAwards);

  // P-A5: season honors — league best XI (toty) and season MVP. A starter with
  // high OVR relative to the league + strong stats has a chance. MVP is rare.
  const seasonHonors: ("mvp" | "toty")[] = [];
  if (role === "starter" && !suspended) {
    const totyRng = derive(seed, "toty", player.age, periodIndex, seasonInPeriod);
    // TOTY: base ~15% for an 80+ starter, scaling down. Lowered from 22% so a
    // TOTY appearance feels earned, not routine.
    const totyBase = clamp(0.04 + (player.overall - 70) * 0.010, 0.02, 0.15);
    if (chance(totyRng, totyBase)) {
      seasonHonors.push("toty");
      // MVP: only if in TOTY, requires exceptional stats. Lowered so a career
      // gets ~0-2 MVPs, not one every season — the rare honor it should be.
      const mvpRng = derive(seed, "mvp", player.age, periodIndex, seasonInPeriod);
      const statGreat = player.position === "GK" ? stats.cleanSheets >= 22
        : (player.position === "ST" || player.position === "LW" || player.position === "RW") ? stats.goals >= 28
        : stats.goals + stats.assists >= 25;
      const mvpChance = statGreat ? 0.14 : 0.03;
      if (chance(mvpRng, mvpChance)) seasonHonors.push("mvp");
    }
  }

  // relegation: a weak club in a top flight risks the drop.
  const relegated = checkRelegation(seed, player, club, league, seasonInPeriod, periodIndex);

  // P-A17: market value & wage — driven by OVR, age, league prestige, role,
  // and this season's performance. Performance feeds back so a great season
  // raises value (→ better transfer offers) and a poor one lowers it.
  const perfRating = engineSeasonRating(stats, role, player.position, trophies.length, seasonHonors.includes("mvp"));
  const marketValue = computeMarketValue(player.overall, player.age, league, effClub, role, perfRating, trophies.length, seasonHonors.includes("mvp"));
  const wage = computeWage(marketValue, league, effClub);

  return {
    age: player.age,
    clubId: club.id,
    clubName: club.name,
    leagueId: league.id,
    leagueName: league.name,
    tier: league.tier,
    role,
    overall: player.overall,
    stats,
    trophies,
    awards: seasonAwards,
    nationalTournaments,
    relegated,
    seasonHonors,
    marketValue,
    wage,
    legacy: seasonLegacy(trophies, stats, role) + (seasonHonors.includes("mvp") ? 6 : seasonHonors.includes("toty") ? 2 : 0),
  };
}

function resolveRoleWithShift(overall: number, club: Club, isGK: boolean, shift: number | undefined): Role {
  const base = resolveRole(overall, club, isGK);
  if (!shift) return base;
  const ladder: Role[] = isGK
    ? ["third_keeper", "substitute", "starter"]
    : ["substitute", "low_rotation", "high_rotation", "starter"];
  const idx = ladder.indexOf(base);
  if (idx < 0) return base;
  return ladder[clamp(idx + shift, 0, ladder.length - 1)]!;
}

function checkRelegation(seed: string, player: Player, club: Club, league: League, sip: number, pi: number): boolean {
  // only a weak club (rep <= 1) in a top flight risks the drop
  if (league.tier !== 1 || club.rep > 1) return false;
  const r = derive(seed, "relegation", player.age, pi, sip);
  const prob = clamp(0.05 + 0.1 * ((1.1 - scoringAbilitySafe(player.overall)) / 0.5), 0.05, 0.15);
  return chance(r, prob);
}
function scoringAbilitySafe(o: number): number {
  return o <= 65 ? 0.6 : o <= 80 ? 0.6 + ((o - 65) / 15) * 0.25 : o <= 85 ? 0.85 + ((o - 80) / 5) * 0.15 : 1 + ((o - 85) / 14) * 0.42;
}

function seasonLegacy(trophies: readonly Trophy[], stats: SeasonStats, role: Role): number {
  let l = 0;
  for (const t of trophies) {
    l += t === "world_cup" ? 50 : t === "club_world_cup" ? 20 : t === "continental_primary" ? 15 : t === "national_continental" ? 18 : t === "league" ? 6 : t === "continental_secondary" ? 8 : 3;
  }
  l += Math.floor(stats.goals / 5);
  if (role === "starter") l += 2;
  return l;
}

/**
 * Compute the legacy multiplier from all legacy-affecting sources:
 *   marketable (blessing) → ×1.2
 *   pp_legacy_magnet (prestige perk) → ×1.1 (stacks)
 * Callers apply loyal_club themselves (it only triggers on "stay" choices).
 */
function legacyMult(blessings: readonly string[], permPerks: readonly string[]): number {
  let m = 1;
  if (blessings.includes("marketable")) m *= 1.2;
  if (permPerks.includes("pp_legacy_magnet")) m *= 1.1;
  return m;
}

function scaledLegacy(amount: number, mult: number): number {
  if (mult === 1) return amount;
  return Math.round(amount * mult);
}

/**
 * Resolve an event's mods.legacy bonus, applying the legacy multiplier plus
 * loyal_club (×1.5 on stay/transfer "stay" outcomes). The event signals "stay"
 * via mods.loyalStay. Returns the (rounded) legacy to add to the run total.
 */
function legacyFromMods(mods: Modifiers, blessings: readonly string[], permPerks: readonly string[]): number {
  const base = mods.legacy ?? 0;
  if (base === 0) return 0;
  let amount = base;
  amount *= legacyMult(blessings, permPerks);
  // loyal_club: the transfer event tags stay-choices with a negative sentinel
  // (the absolute value is the real bonus) so we can detect them here.
  if (blessings.includes("loyal_club") && mods.loyalStay) {
    amount = amount * 1.5;
  }
  return Math.round(amount);
}

// ───────────────────────────── period decision builder ─────────────────────────────

function buildPeriodDecision(
  seed: string,
  player: Player,
  club: Club,
  league: League,
  periodIndex: number,
  rngState: RngState,
  blessings: readonly string[],
  injuriesTaken: number,
  ascension: number,
  statusTags: readonly string[],
  lastSeasonRelegated: boolean,
  plan: CareerEventPlan | undefined,
  periodLength: number,
  completedLoan: GameState["completedLoan"],
  maxOverall: number,
  blockbusterOfferedTier: number | undefined,
  permPerks: readonly string[],
  formerClubIds: readonly string[],
  recentMarketValue: number,
  severeInjuries: number,
  injuryWarned: boolean,
  verdictSeenAt: number,
): FiredEvent {
  const role = resolveRole(player.overall, club, player.position === "GK");
  const ctx: EventContext = {
    player, club, league, seed, age: player.age, role, periodIndex, rngState, blessings,
    injuriesTaken, ascension,
    severeInjuries,
    plan, periodLength,
    permPerks,
    formerClubIds,
    recentMarketValue,
    // expose bare tag names so events match without knowing the TTL encoding
    statusTags: statusTags.map(tagName),
  };

  // 医学退役 (P-B1): the body outranks everything. 3rd severe injury (and each
  // further one past a survived verdict) → the verdict; 2nd → the warning.
  if (severeInjuries >= 3 && verdictSeenAt < severeInjuries) {
    return medicalVerdictEvent(ctx);
  }
  if (severeInjuries >= 2 && !injuryWarned) {
    return doctorWarningEvent(ctx);
  }

  // post-loan resolution (母本 ca): highest priority — a loan just returned.
  if (completedLoan) {
    return postLoanEvent(ctx, completedLoan);
  }

  // 母本 contextual events: contract non-renewal (age 26+, bench role) takes
  // priority. The contract_crisis tag (set on resolve, long TTL) is the
  // anti-repeat guard — without it a benched veteran refires this every period.
  if (player.age >= 26 && (role === "substitute" || role === "low_rotation")
      && !ctx.statusTags.includes("contract_crisis")) {
    const nr = fireEventByKey(ctx, "contract_nonrenewal");
    if (nr) return nr;
  }
  // relegation loyalty: if the player's club was just relegated. The
  // relegation_endured tag keeps a yo-yo club from asking every other season.
  if (lastSeasonRelegated && !ctx.statusTags.includes("relegation_endured")) {
    const rl = fireEventByKey(ctx, "relegation_loyalty");
    if (rl) return rl;
  }

  // climax events: fire if a World Cup year fell within the just-simulated
  // period's season ages (the period may span a WC age even in multi-season
  // pace modes, since simulateNational rolls per-season). WC ages are odd
  // (19/23/27/31/35/39) but period steps are 1-3, so we check the period's span.
  const seasonAges: number[] = [];
  for (let a = player.age - periodLength; a < player.age; a++) seasonAges.push(a);
  // Pre-emptive WC detection: the showdown's worldCupResultOverride /
  // nationalTournamentParticipation mods land on NEXT period's season(s) (they
  // flow through pendingMods, consumed one period later). To actually reach
  // simulateNational's isWcAge branch, the showdown must fire the period BEFORE
  // the WC age — so detect the UPCOMING WC age, not the one just simmed (whose
  // override would land on a non-WC-age season and be silently dropped).
  let wcAgeThisPeriod: number | undefined;
  for (let a = player.age; a < player.age + periodLength; a++) {
    if (a >= 19 && (a - 19) % 4 === 0) { wcAgeThisPeriod = a; break; }
  }
  // 飞升 9 国家队退役: no WC showdown — the national door is closed.
  //
  // Boss weight restored (P-audit): previously EVERY 70+ player of EVERY nation
  // hit the final showdown at EVERY WC cycle — ~3 finals per career even for
  // minnow nations (27.6% of all decisions at normal pace), and losing had no
  // consequence at all. Now:
  //   - borderline stars (OVR 70-73) get the QUALIFIER boss instead — the
  //     fight is getting there at all (once per career, wc_quali_done);
  //   - established stars must have their nation actually REACH the final —
  //     a fifaRep-scaled roll, so minnows almost never do (the miracle run);
  //   - the final showdown fires at most once per career (wc_boss_done), and
  //     losing it now records a runner-up finish (no contradictory re-roll);
  //   - a minnow that DID reach the final gets a real shot (0.35, was 0.04 —
  //     "reach 3 finals, lose 96% of them" was backwards drama).
  if (wcAgeThisPeriod !== undefined && ascension < 9) {
    const nation = nationById(player.nationalityId);
    const fifaRep = clamp(nation.fifaRep, 0, 5);
    if (player.overall >= 70) {
      const bareTags = ctx.statusTags;
      if (player.overall < 74 && !bareTags.includes("wc_quali_done")) {
        // 诸神黄昏 (ascension 5): −30%; 天命难违 (ascension 6): −10%.
        let qOdds = 0.5;
        if (ascension >= 5) qOdds *= 0.7;
        if (ascension >= 6) qOdds *= 0.9;
        // pp_boss_slayer (+10%) and 大赛型选手 big_game_player (+20%) boss good odds.
        if (permPerks.includes("pp_boss_slayer")) qOdds = clamp(qOdds + 0.1, 0.05, 0.95);
        if (blessings.includes("big_game_player")) qOdds = clamp(qOdds + 0.2, 0.05, 0.95);
        return worldCupQualifierShowdown(wcAgeThisPeriod, clamp(qOdds, 0.05, 0.95), true, 0, blessings, nation.name);
      }
      if (player.overall >= 74 && !bareTags.includes("wc_boss_done")) {
        const reachOdds = fifaRep >= 4 ? 0.55 : fifaRep >= 2 ? 0.35 : 0.12;
        if (chance(derive(seed, "wc-reach", wcAgeThisPeriod), reachOdds)) {
          let odds = fifaRep >= 4 ? 0.50 : fifaRep >= 2 ? 0.45 : 0.35;
          // 诸神黄昏 (ascension 5): −30%; 天命难违 (ascension 6): −10%.
          if (ascension >= 5) odds *= 0.7;
          if (ascension >= 6) odds *= 0.9;
          // pp_boss_slayer (+10%) and 大赛型选手 big_game_player (+20%) boss good odds.
          if (permPerks.includes("pp_boss_slayer")) odds = clamp(odds + 0.1, 0.01, 0.95);
          if (blessings.includes("big_game_player")) odds = clamp(odds + 0.2, 0.01, 0.95);
          odds = clamp(odds, 0.01, 0.95);
          return worldCupShowdown(wcAgeThisPeriod, odds, "世界杯冠军", "功亏一篑", blessings, nation.name);
        }
      }
    }
  }
  // decisive penalty: a starter at a peak age that fell this period.
  const dpAgeThisPeriod = seasonAges.find((a) => (a === 21 || a === 25));
  if (dpAgeThisPeriod !== undefined && role === "starter" && player.overall >= 75) {
    let odds = 0.55;
    if (ascension >= 6) odds *= 0.9;
    // pp_boss_slayer (+10%) and 大赛型选手 big_game_player (+20%) boss good odds.
    if (permPerks.includes("pp_boss_slayer")) odds = clamp(odds + 0.1, 0.01, 0.95);
    if (blessings.includes("big_game_player")) odds = clamp(odds + 0.2, 0.01, 0.95);
    return decisivePenalty(odds, "league", blessings);
  }

  // Transfers on a contract-cycle cadence (P-A15): a player's contract runs ~4-5
  // years, so transfer speculation surfaces roughly every 3 seasons — and it
  // takes PRIORITY over random career events AND blockbuster/injury/plan so the
  // player is never stuck at a club forever. 飞升 8 转会冻结: window opens every 5th.
  // P-A163: this was BELOW blockbuster/injury/plan/loan, so those higher-priority
  // events starved it — a 40-career MC fired 0 transfer events (vs 17 blockbuster).
  // Hoisted up so the contract window is a hard cadence, not a fallback. The
  // user's explicit ask: "转会选择要慎重", "表现好坏影响后续转会" — transfers must
  // actually be offered to be a strategic lever.
  // injury roll (P-B1, diverges from 母本 Qr's 2-injury cap): an ACL doesn't
  // wait for the transfer window. Hoisted above the transfer cadence so the
  // injury rate isn't silently eaten by higher-priority events (pre-hoist MC:
  // 0 medical retirements in 2000 runs). Climax/WC events above still outrank
  // it — injury_before_tournament covers that story with actual agency.
  const injuryEv = rollInjuryEvent(ctx);
  if (injuryEv) return injuryEv;

  const windowCadence = ascension >= 8 ? 5 : 3;
  const isTransferWindow = periodIndex > 0 && periodIndex % windowCadence === windowCadence - 1;
  if (isTransferWindow) {
    return transferEvent(ctx);
  }

  // blockbuster offer (母本 aa): a fame club courts a star (age 28-34, peak≥80).
  const bb = blockbusterOfferEvent(ctx, maxOverall, blockbusterOfferedTier);
  if (bb) return bb;

  // career event plan (母本 ma): if a slot age is due, fire a scheduled event.
  if (plan && player.age <= 37) {
    const slot = findAvailableSlot(plan, player.age);
    if (slot !== null) {
      ctx.slotAge = slot;
      const ev = rollRandomEvent(ctx);
      if (ev) return ev;
    }
  }

  // loan offer (母本 oa/sa): young bench players at a big club can be loaned out.
  // 母本 isSubstitute = substitute OR third_keeper; low_rotation gets 30%, bench 70%.
  if (!completedLoan && (role === "substitute" || role === "low_rotation" || role === "third_keeper")
      && player.age >= 18 && player.age <= 24) {
    const loanProb = role === "low_rotation" ? 0.3 : 0.7;
    if (chance(derive(seed, "loan-offer", player.age, periodIndex), loanProb)) {
      return loanOfferEvent(ctx);
    }
  }

  // else: random career event, else a plain transfer window
  const ev = rollRandomEvent(ctx);
  if (ev) return ev;
  return transferEvent(ctx);
}

/** Find the next available career-event slot at/below the age. (Kr) */
function findAvailableSlot(plan: CareerEventPlan, age: number): number | null {
  if (plan.completedEventKeys.length >= plan.targetCount) return null;
  return plan.slotAges.find((s) => s <= age && !plan.completedSlotAges.includes(s)) ?? null;
}

// ───────────────────────────── choice resolution ─────────────────────────────

export function resolveChoice(state: GameState, choice: Choice): GameState {
  if (!state.pendingChoice || !state.pendingResolve) return state;
  const rng = derive(state.seed, "resolve", state.age);
  const { mods, outcome, good, injury, severe } = state.pendingResolve(choice, rng, state.seed);
  void good;
  // update the career event plan when a scheduled career/injury event resolves.
  const ev = state.pendingChoice;
  let plan = state.careerEventPlan;
  if (plan && ev.eventKey && (ev.slotAge !== undefined || ev.key === "injury")) {
    plan = updatePlan(plan, ev.key === "injury" ? "injury" : (ev.eventKey ?? ev.key), ev.slotAge ?? 0, state.age);
  }
  // loan lifecycle: accepting a new loan or moving clubs consumes/clears the
  // post-loan window. (The loan-return → completedLoan transition happens in
  // simulatePeriod when the loan expires mid-period.)
  let completedLoan = state.completedLoan;
  if (mods.loanOutTo || mods.newClubId || choice.kind === "new_club"
      || choice.kind === "permanent_transfer" || choice.kind === "join_loan") {
    completedLoan = undefined;
  }
  // pp_transfer_savvy (转会嗅觉 prestige perk): each PERMANENT transfer (new
  // club, not a loan) grants +1 OVR. Folded into pendingMods.immediateOverallDelta
  // so the next period's upfront-shift applies it. Loans don't trigger it.
  let finalMods = mods;
  const isPermanentMove = !!mods.newClubId || choice.kind === "new_club" || choice.kind === "permanent_transfer";
  // pp_transfer_savvy (+1) and 雇佣兵 mercenary (+2) both grant OVR on permanent transfer.
  const blessings = state.blessings ?? EMPTY_BLESSINGS;
  let transferOvr = 0;
  if (isPermanentMove && (state.permPerks ?? EMPTY_PERKS).includes("pp_transfer_savvy")) transferOvr += 1;
  if (isPermanentMove && blessings.includes("mercenary")) transferOvr += 2;
  if (transferOvr > 0) {
    finalMods = { ...mods, immediateOverallDelta: (mods.immediateOverallDelta ?? 0) + transferOvr };
  }
  // 雇佣兵: staying grants no legacy bonus (the opposite of loyal_club). Strip
  // the loyalStay flag so legacyFromMods won't apply the ×1.5.
  if (blessings.includes("mercenary") && finalMods.loyalStay) {
    finalMods = { ...finalMods, loyalStay: false, legacy: 0 };
  }
  // P-A33: log the key choice for the summary "抉择回顾" — skip plain transfers
  // (they're already in the club timeline) but record every narrative event.
  const isNarrativeEvent = ev.key !== "transfer" && ev.key !== "loan_offer" && ev.key !== "post_loan" && ev.key !== "blockbuster_offer";
  const choiceLog = isNarrativeEvent && outcome
    ? [...(state.choiceLog ?? EMPTY_CHOICE_LOG), { age: state.age, title: ev.title, choice: choice.text, outcome, good: !!good }]
    : (state.choiceLog ?? EMPTY_CHOICE_LOG);
  return {
    ...state,
    pendingChoice: null,
    pendingResolve: undefined,
    pendingMods: finalMods,
    pendingMilestone: undefined,   // milestone celebrated before this choice; clear it
    lastOutcome: outcome,
    careerEventPlan: plan,
    completedLoan,
    choiceLog,
    activeLoan: state.activeLoan,
    injuriesTaken: (state.injuriesTaken ?? 0) + (injury ? 1 : 0),
    severeInjuries: (state.severeInjuries ?? 0) + (severe ? 1 : 0),
    injuryWarned: state.injuryWarned || ev.key === "doctor_warning",
    // record the count the verdict resolved at — a FURTHER severe injury re-fires it.
    verdictSeenAt: ev.key === "medical_verdict" ? (state.severeInjuries ?? 0) : state.verdictSeenAt,
  };
}

// ───────────────────────────── finalize ─────────────────────────────

function finalizeRun(
  state: GameState,
  currentClubId: string,
  currentLeagueId: string,
  seasons: readonly SeasonResult[],
  trophies: readonly Trophy[],
  awards: readonly Award[],
  maxOverall: number,
  legacy: number,
  player: Player,
  reason: string,
): GameState {
  // P-A1: cap the career story with a retirement beat + P-A20: post-career path.
  const finalBeats = [...(state.careerBeats ?? EMPTY_BEATS)];
  if (seasons.length > 0) {
    const reasonText = reason === "age" ? "年迈挂靴，传奇落幕。"
      : reason === "faded" ? "英雄迟暮，带着荣光离场。"
      : reason === "no_offers" ? "无人问津，黯然离场。"
      : reason === "injury" ? "身体先于梦想倒下——医学退役。"
      : "主动挂靴，功成身退。";
    finalBeats.push({ age: player.age, season: seasons.length, text: reasonText, tone: reason === "no_offers" || reason === "injury" ? "bad" : "neutral" });
    // P-A20: post-career path — determined by peak + trophies + final value.
    const finalMv = seasons.length > 0 ? (seasons[seasons.length - 1]!.marketValue ?? 0) : 0;
    let postCareer = "回归平民生活，远离聚光灯。";
    if (reason === "injury") {
      postCareer = maxOverall >= 85
        ? "天妒英才——全世界都在问「如果他没受伤」。你成了足球史上永远的假设。"
        : "伤病带走了生涯。你转型康复师，帮年轻球员避开你走过的坑。";
    }
    else if (maxOverall >= 90 && trophies.includes("world_cup")) postCareer = "以世界杯英雄之姿退役，举国铭记。";
    else if (maxOverall >= 90 && awards.includes("ballon_dor")) postCareer = "金球先生退役，执教邀约如雪片飞来。";
    else if (maxOverall >= 90) postCareer = "传奇挂靴，转型名帅，执教邀约不断。";
    else if (maxOverall >= 85 && trophies.length >= 5) postCareer = "功勋老将退役，受邀担任俱乐部形象大使。";
    else if (finalMv >= 20) postCareer = "身价不菲，转型足球评论员，活跃于荧屏。";
    else if (maxOverall >= 80) postCareer = "体面退役，回到母国青训执教。";
    else if (reason === "no_offers") postCareer = "无人接手，黯然告别职业足坛。";
    finalBeats.push({ age: player.age, season: seasons.length, text: `退役去向：${postCareer}`, tone: maxOverall >= 90 ? "legendary" : "neutral" });
  }
  return {
    ...state,
    currentClubId,
    currentLeagueId,
    seasons,
    trophies,
    awards,
    maxOverall,
    legacy,
    player,
    age: player.age,
    careerBeats: finalBeats,
    phase: "summary",
    retired: true,
    retirementReason: reason,
    pendingChoice: null,
    pendingResolve: undefined,
  };
}

export function retireNow(state: GameState): GameState {
  if (!state.player || state.retired) return state;
  return finalizeRun(state, state.currentClubId, state.currentLeagueId, state.seasons, state.trophies, state.awards, state.maxOverall, state.legacy, state.player, "voluntary");
}

const EMPTY_MODS: Modifiers = {};
const EMPTY_BLESSINGS: readonly string[] = [];
const EMPTY_TAGS: readonly string[] = [];
const EMPTY_PERKS: readonly string[] = [];
const EMPTY_BEATS: readonly CareerBeat[] = [];
const EMPTY_SEEN: readonly string[] = [];
const EMPTY_CHOICE_LOG: readonly ChoiceLogEntry[] = [];

// ───────────────────────────── status-tag helpers ─────────────────────────────
// Tags carry a TTL so branching consequences fade after 1-2 periods. Encoded
// as "name@ttl"; a bare "name" defaults to ttl 2. Events match on the bare name.

/** Wrap a tag with a TTL (default 2 periods). Exported for events.ts. */
export function ttlTag(name: string, ttl = 2): string {
  return `${name}@${ttl}`;
}
/** The bare tag name, ignoring TTL. */
function tagName(tag: string): string {
  return tag.split("@")[0]!;
}
/** Decrement a tag's TTL; returns null when it expires. */
function decayTag(tag: string): string | null {
  const name = tagName(tag);
  const ttl = Number(tag.split("@")[1] ?? 2) - 1;
  return ttl > 0 ? `${name}@${ttl}` : null;
}
/** Merge tags by name, keeping the longest TTL. */
function dedupeTags(tags: readonly string[]): readonly string[] {
  const best = new Map<string, number>();
  for (const t of tags) {
    const name = tagName(t);
    const ttl = Number(t.split("@")[1] ?? 2);
    if (ttl > (best.get(name) ?? 0)) best.set(name, ttl);
  }
  return [...best.entries()].map(([name, ttl]) => `${name}@${ttl}`);
}

// ───────────────────────────── career story beats (P-A1) ─────────────────────────────
//
// Capture the memorable moments of a season as one-line narrative beats so the
// summary can render a shareable "story of this career" feed. Only noteworthy
// seasons produce a beat (a quiet season is skipped) so the feed stays punchy.

const BEAT_TROPHY_NAME: Record<Trophy, string> = {
  league: "联赛冠军", cup: "杯赛冠军", continental_primary: "洲际冠军",
  continental_secondary: "洲际次杯", club_world_cup: "世俱杯",
  national_continental: "洲际国家队冠军", world_cup: "世界杯冠军",
};
const BEAT_AWARD_NAME: Record<Award, string> = {
  ballon_dor: "金球奖", golden_boot: "金靴", golden_glove: "金手套",
};

/** Append a beat for a noteworthy season. A season yields at most one beat
 *  (the most significant event), so the feed never double-counts. */
function appendSeasonBeats(beats: readonly CareerBeat[], s: SeasonResult, seasonNum: number, player: Player): readonly CareerBeat[] {
  // pick the most significant beat for this season (priority order)
  let text = "";
  let tone: CareerBeat["tone"] = "neutral";
  const ovr = s.overall;
  if (s.awards.includes("ballon_dor")) { text = `${s.age}岁加冕金球奖！`; tone = "legendary"; }
  else if (s.trophies.includes("world_cup")) { text = `${s.age}岁捧起世界杯！封王之夜。`; tone = "legendary"; }
  else if (s.awards.length > 0) { text = `${s.age}岁夺得${s.awards.map(a => BEAT_AWARD_NAME[a]).join("、")}。`; tone = "good"; }
  else if (s.trophies.length >= 2) { text = `${s.age}岁${s.trophies.map(t => BEAT_TROPHY_NAME[t]).join("+")}，${s.clubName}的丰收季。`; tone = "good"; }
  else if (s.trophies.includes("continental_primary")) { text = `${s.age}岁赢下洲际冠军！${s.clubName}登顶。`; tone = "good"; }
  else if (s.trophies.length === 1) { text = `${s.age}岁随${s.clubName}拿下${BEAT_TROPHY_NAME[s.trophies[0]!]}。`; tone = "good"; }
  else if (s.relegated) { text = `${s.age}岁${s.clubName}惨遭降级，至暗时刻。`; tone = "bad"; }
  else if (s.role === "substitute" && ovr >= 75) { text = `${s.age}岁在${s.clubName}坐穿板凳，才华虚耗。`; tone = "bad"; }
  else if (s.stats.goals >= 25) { text = `${s.age}岁轰入${s.stats.goals}球，射手本能爆发。`; tone = "good"; }
  else if (ovr >= 90 && player.overall < ovr) { text = `${s.age}岁OVR突破${ovr}，跻身历史级。`; tone = "legendary"; }
  else if (s.role === "starter" && ovr >= 85 && player.overall < ovr) { text = `${s.age}岁在${s.clubName}坐稳主力，巅峰渐至。`; tone = "good"; }
  else return beats; // quiet season — no beat
  return [...beats, { age: s.age, season: seasonNum, text, tone }];
}

// ───────────────────────────── milestone detection (P-A4) ─────────────────────────────
//
// Detect a FIRST-TIME career milestone this period (peak OVR crossing, first
// trophy, Ballon d'Or, World Cup). Each fires once per run (milestonesSeen
// dedupes). Returns the milestone to celebrate, or undefined.

function detectMilestone(
  state: GameState,
  maxOverall: number,
  trophies: readonly Trophy[],
  awards: readonly Award[],
  age: number,
  peakMarketValue = 0,
): Milestone | undefined {
  const seen = new Set(state.milestonesSeen ?? EMPTY_SEEN);
  const prevMax = state.maxOverall;
  // P-A17: market value crossings — €50M / €100M are the "world-class price tag"
  // moments that football fans recognize (the €100M man is a media event).
  if (peakMarketValue >= 100 && !seen.has("mv100")) return { id: "mv100", title: "身价破亿！", desc: "€1亿先生！全球媒体瞩目，你已是现象级。", tone: "legendary", age };
  if (peakMarketValue >= 50 && !seen.has("mv50")) return { id: "mv50", title: "身价破€5000万！", desc: "跻身世界最贵球员之列。", tone: "good", age };
  // OVR crossings — only when the peak CROSSED the threshold this period.
  if (maxOverall >= 95 && prevMax < 95 && !seen.has("ovr95")) return { id: "ovr95", title: "巅峰 95！", desc: "你已是历史级巨星，名垂青史。", tone: "legendary", age };
  if (maxOverall >= 90 && prevMax < 90 && !seen.has("ovr90")) return { id: "ovr90", title: "突破 90！", desc: "跻身世界最佳之列。", tone: "legendary", age };
  if (maxOverall >= 85 && prevMax < 85 && !seen.has("ovr85")) return { id: "ovr85", title: "巅峰 85！", desc: "你已是顶级球星。", tone: "good", age };
  // first trophy
  if (trophies.length > 0 && (state.trophies.length === 0) && !seen.has("first_trophy")) return { id: "first_trophy", title: "生涯首冠！", desc: "从零到一，冠军滋味。", tone: "good", age };
  // Ballon d'Or
  if (awards.includes("ballon_dor") && !state.awards.includes("ballon_dor") && !seen.has("ballon_dor")) return { id: "ballon_dor", title: "加冕金球奖！", desc: "世界最佳，当之无愧。", tone: "legendary", age };
  // World Cup
  if (trophies.includes("world_cup") && !state.trophies.includes("world_cup") && !seen.has("world_cup")) return { id: "world_cup", title: "世界杯冠军！", desc: "足球的终极荣耀，永恒之夜。", tone: "legendary", age };
  return undefined;
}

// P-A123: career midpoint recap — every 10 seasons, show a "你走了多远" recap
// milestone. Not a boss or a crisis — just a moment to look back.
function detectCareerRecap(seasons: readonly SeasonResult[], seen: readonly string[]): Milestone | undefined {
  const count = seasons.length;
  if (count > 0 && count % 10 === 0 && !seen.includes(`recap${count}`)) {
    const goals = seasons.reduce((s, x) => s + x.stats.goals, 0);
    const trophies = seasons.reduce((s, x) => s + x.trophies.length, 0);
    const clubs = new Set(seasons.map((s) => s.clubName)).size;
    return {
      id: `recap${count}`,
      title: `${count}赛季回顾`,
      desc: `你已经踢了${count}个赛季。${goals}个进球，${trophies}座奖杯，${clubs}家俱乐部。你走了多远。`,
      tone: "good",
      age: seasons[seasons.length - 1]?.age ?? 0,
    };
  }
  return undefined;
}
