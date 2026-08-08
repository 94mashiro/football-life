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
  clubById, weakestClubInLeague, generatePlayerName, generateSquadNumber,
  tournamentOffset as tournamentOffsetForSeed,
  CLUBS, CALLUP_THRESHOLD,
} from "./data";
import {
  resolveRole, simSeasonStats, clubTrophyCandidates, simulateNational,
  rollAwards, growthDelta, computeMarketValue, computeWage,
  retentionProb, applyCeiling, RETENTION_START, MAX_AGE,
} from "./sim";
import {
  rollRandomEvent, rollInjuryEvent, transferEvent, loanOfferEvent,
  postLoanEvent, blockbusterOfferEvent, doctorWarningEvent, medicalVerdictEvent,
  worldCupShowdown, worldCupQualifierShowdown, continentalCupShowdown, decisivePenalty,
  fireEventByKey, resolveEventOption,
  noOffersEvent, wageSqueezeEvent,
  type EventContext, type FiredEvent,
} from "./events";
import type {
  GameState, Player, SeasonResult, Trophy, Award, Role, Choice, Modifiers, SeasonStats,
  CareerEventPlan, Challenge, CareerBeat, Milestone, ChoiceLogEntry, ResolveFn,
} from "./types";
import { trophyMult } from "./types";
import { rollDevProfile } from "../meta/legacy";
import { generateRival } from "./rival";

const PERIOD_LENGTH = 1;        // seasons per period — one decision every season for decision density
const START_AGE = 16;
const START_OVR = 50;
// RETIRE_AGE 40 was a hard wall: every career ended at 40 regardless of
// choices/ability — the game promised a fixed horizon and never surprised.
// Replaced (P-RETIRE) by the soft retention roll (RETENTION_START, sim.ts)
// + a generous MAX_AGE safety net. See retentionProb / projectedRetireAge.
const FORCE_RETIRE_OVR = 50;
/** A locked-in wage this far above the current market wage triggers the wage-
 *  squeeze window (the 伤仲永 economic-retirement arc). 2.0 = only a clear
 *  squeeze (a crashed star or steep decline), not gentle aging. */
const WAGE_SQUEEZE_RATIO = 2.0;
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
  /** The academy club to debut at. When set (and a real club id) it overrides
   *  the underdog default (weakest club in the league) so the player can pick
   *  their 母队. Daily/quick starts leave this unset → weakest-club fallback. */
  clubId?: string;
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
  /** Set (YYYY-MM-DD) when this run IS that day's daily challenge. Carried onto
   *  the state so the result is recorded against the right day. */
  dailyDate?: string;
  /** True when the player hand-specified the seed (debut console custom mode).
   *  Stamped onto state so settleRun can skip ALL meta rewards — a reproducible
   *  seed must not farm legacy/best/ascension/achievements. */
  customSeed?: boolean;
  /** Whether the wonderkid dev profile is in the roll pool. Callers pass
   *  isUnlocked(meta, "profile:wonderkid"); defaults to false so the 100-legacy
   *  gate is real (it was previously hardcoded open). */
  allowWonderkid?: boolean;
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
  const devProfile = rollDevProfile(setup.seed, isGK, setup.allowWonderkid ?? false);
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
  // Start club: an explicit academy choice (青训队伍) wins — the player picked
  // their 母队, so honour it exactly. Otherwise the underdog default: weakest
  // club in the chosen league. (pp_scout no longer bumps the starting club: a
  // 50-OVR kid at a stronger club sat the bench for years — measured −166 p50
  // legacy, a perk-shaped trap. It boosts youth growth instead; see the
  // growth loop.)
  const pickedClub = setup.clubId !== undefined
    ? CLUBS.find((c) => c.id === setup.clubId)
    : undefined;
  const startClub: Club = pickedClub ?? weakestClubInLeague(setup.leagueId, setup.seed);
  const pace: PaceMode = setup.pace ?? "normal";
  const tournamentOffset = tournamentOffsetForSeed(setup.seed);
  // P5: generate the career-long rival — same age, same position, contrasting
  // nationality/club. Deterministic from the seed so a seed is reproducible.
  const rival = generateRival(setup.seed, setup.position, setup.nationalityId);
  return {
    phase: "playing",
    seed: setup.seed,
    player,
    currentClubId: startClub.id,
    currentLeagueId: startClub.leagueId,
    startLeagueId: startClub.leagueId,
    startClubId: startClub.id,
    dailyDate: setup.dailyDate,
    customSeed: setup.customSeed,
    seasons: [],
    maxOverall: startOvr,
    trophies: [],
    awards: [],
    pendingChoice: null,
    legacy: 0,
    ascension: setup.ascension,
    pace,
    periodLength: PACE_LENGTH[pace],
    tournamentOffset,
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
  // ends the career before any further seasons are simulated. P-RETIRE: the
  // soft-retention / wage-squeeze 挂靴 choices also route here, carrying
  // forceRetireReason so the summary shows 无人问津 instead of 伤病退役.
  if (mods0.forceRetire) {
    // the dignified-exit legacy bonus still counts (normal mods flow is skipped).
    const bonus = legacyFromMods(mods0, state.blessings ?? EMPTY_BLESSINGS, state.permPerks ?? EMPTY_PERKS);
    const reason = mods0.forceRetireReason ?? "injury";
    return finalizeRun(state, state.currentClubId, state.currentLeagueId, state.seasons, state.trophies, state.awards, state.maxOverall, state.legacy + bonus, state.player, reason);
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
  // P1: accumulate identity tags ever held — the career-long "build". Bare
  //  names (TTL is irrelevant to identity). Unioned each period so a tag earned
  //  once stays in the career's identity record after its TTL decays.
  const personaTagsEver = [
    ...new Set([
      ...(state.personaTagsEver ?? EMPTY_TAGS),
      ...statusTags.filter((t) => PERSONA_TAG_KEYS.has(tagName(t))).map(tagName),
    ]),
  ];
  // event-choice legacy bonus (e.g. training +5, world cup +100) — was dropped.
  const eventLegacy = legacyFromMods(mods, blessings, state.permPerks ?? EMPTY_PERKS);
  if (eventLegacy) legacy += eventLegacy;
  // ride the run-total of event legacy on state so finalize/retire can feed it
  // into scoreLegacy — previously event legacy never reached the meta score.
  if (eventLegacy) state = { ...state, eventLegacy: (state.eventLegacy ?? 0) + eventLegacy };
  const upfrontShift = (mods.immediateOverallDelta ?? 0) + (mods.permanentOverallDelta ?? 0);
  if (upfrontShift !== 0) {
    // P-ENDGAME: the club development ceiling caps ALL positive OVR gains,
    // not just growth — so a full-prestige loadout stacking event deltas +
    // transfer-savvy + comeback can't bypass the cap to a 99 median. Event
    // negatives (a bad coach gamble) pass through; only positive gains scale.
    const capped = upfrontShift > 0 ? applyCeiling(upfrontShift, player.overall, club) : upfrontShift;
    const newOvr = clamp(player.overall + capped, 40, 99);
    player = { ...player, overall: newOvr };
    maxOverall = Math.max(maxOverall, newOvr);
  }

  const periodLength = state.periodLength ?? PERIOD_LENGTH;
  // P-A4: trophy streak — consecutive trophy seasons. Resets on a dry season.
  let trophyStreak = state.trophyStreak ?? 0;
  let bestStreak = state.bestStreak ?? 0;
  let streakBonus = 0;
  for (let i = 0; i < periodLength; i++) {
    if (player.age > MAX_AGE) break;
    const season = simOneSeason(seed, player, club, league, mods, i, periodIndex, awards.filter(a => a === "ballon_dor" || a === "golden_glove").length, blessings, state.ascension, state.tournamentOffset ?? 0, statusTags.some((t) => tagName(t) === "captain"));
    seasons.push(season);
    trophies = [...trophies, ...season.trophies];
    awards = [...awards, ...season.awards];
    maxOverall = Math.max(maxOverall, season.overall);
    legacy += season.legacy;
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
    // pp_scout (青训球探): elite academy coaching — +1 growth per cycle before 20.
    if (state.permPerks?.includes("pp_scout") && player.age < 20) delta += 1;
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
    const deferred = mods.deferredOverallDelta > 0 ? applyCeiling(mods.deferredOverallDelta, player.overall, club) : mods.deferredOverallDelta;
    const newOvr = clamp(player.overall + deferred, 40, 99);
    player = { ...player, overall: newOvr };
    maxOverall = Math.max(maxOverall, newOvr);
  }

  // comeback: a chance to regain +1 OVR after 30 (tuned per season at 1-season periods).
  if (blessings.includes("comeback") && player.age >= 30) {
    const r = derive(seed, "comeback", player.age, periodIndex);
    if (chance(r, 0.25)) {
      // P-ENDGAME: comeback is also subject to the club ceiling — a 33yo at a
      // minnow can't comeback his way to 99; the cap applies to perk/blessing
      // gains just like event/growth gains.
      const bump = applyCeiling(1, player.overall, club);
      if (bump > 0) {
        const newOvr = clamp(player.overall + bump, 40, 99);
        player = { ...player, overall: newOvr };
        maxOverall = Math.max(maxOverall, newOvr);
      }
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
  if (player.age >= MAX_AGE) {
    // P-RETIRE: the hard ceiling is the authored safety net — the soft
    // retention roll (buildPeriodDecision) retires almost everyone first.
    // Reaching MAX_AGE means the player kept passing rolls deep into the
    // decline table; the growth-curve fallback at 44+ is so steep the roll
    // would fail next period anyway.
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
  const result = buildPeriodDecision(seed, player, club, league, periodIndex, rngState, state.blessings ?? EMPTY_BLESSINGS, state.injuriesTaken ?? 0, state.ascension, statusTags, lastSeasonRelegated, plan, periodLength, completedLoan, maxOverall, state.blockbusterOfferedTier, state.permPerks ?? EMPTY_PERKS, formerClubIds, recentMarketValue, state.severeInjuries ?? 0, !!state.injuryWarned, state.verdictSeenAt ?? 0, state.tournamentOffset ?? 0);

  // 阶段二分流：决策（弹层） / 风味（自动结算，挂赛季卡） / 静默（无事件）。
  // flavor 的 mods 进 pendingMods，下一 period 生效（与 decision timing 一致）；
  // outcome 进 pendingFlavor 显示在赛季卡。plan/伤病计数在此更新（flavor
  // 不经 resolveChoice，必须自己结账）。
  let pendingChoice: GameState["pendingChoice"] = null;
  let pendingResolve: GameState["pendingResolve"] = undefined;
  let pendingMods: Modifiers = EMPTY_MODS;
  let pendingFlavor: string | undefined = undefined;
  let planOut = plan;
  let injuriesTakenOut = state.injuriesTaken ?? 0;
  let severeInjuriesOut = state.severeInjuries ?? 0;
  let blockbusterTier = state.blockbusterOfferedTier;
  if (isFlavor(result)) {
    pendingFlavor = result.outcome;
    pendingMods = result.mods;
    if (result.eventKey === "injury") {
      planOut = updatePlan(planOut, "injury", 0, player.age);
    } else if (result.eventKey && result.slotAge !== undefined) {
      planOut = updatePlan(planOut, result.eventKey, result.slotAge, player.age);
    }
    if (result.injury) injuriesTakenOut += 1;
    if (result.severe) severeInjuriesOut += 1;
  } else if (result) {
    pendingChoice = result.event;
    pendingResolve = result.resolve;
    blockbusterTier = result.event.key === "blockbuster_offer"
      ? (maxOverall >= 90 ? 3 : maxOverall >= 85 ? 2 : 2)
      : state.blockbusterOfferedTier;
  }
  // result === null → 静默 period（无事件，不弹决策）

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
    personaTagsEver,
    trophyStreak,
    bestStreak,
    careerBeats: beats,
    careerEventPlan: planOut,
    blockbusterOfferedTier: blockbusterTier,
    pendingMilestone: milestone,
    milestonesSeen,
    pendingMods,
    pendingChoice,
    pendingResolve,
    pendingFlavor,
    injuriesTaken: injuriesTakenOut,
    severeInjuries: severeInjuriesOut,
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
  toff = 0,
  captain = false,
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
  const candidates = clubTrophyCandidates(player.overall, effClub, league, player.age, toff, captain);
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
  }, toff);
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
  // only a weak club (rep <= 2) in a top flight risks the drop
  if (league.tier !== 1 || club.rep > 2) return false;
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
 * Compute the earn multiplier from marketable (×1.2) / pp_legacy_magnet (×1.1).
 * Applied ONCE to the final score in scoreLegacy — NOT to in-run event legacy,
 * which previously made both effects near-invisible (~2% of the real total).
 */
export function legacyEarnMult(blessings: readonly string[], permPerks: readonly string[]): number {
  let m = 1;
  if (blessings.includes("marketable")) m *= 1.2;
  if (permPerks.includes("pp_legacy_magnet")) m *= 1.1;
  return m;
}

/**
 * Resolve an event's mods.legacy bonus, applying loyal_club (×1.5 on
 * stay/transfer "stay" outcomes; the event signals "stay" via mods.loyalStay).
 * Returns the (rounded) legacy to add to the run total.
 */
function legacyFromMods(mods: Modifiers, blessings: readonly string[], permPerks: readonly string[]): number {
  void permPerks;
  const base = mods.legacy ?? 0;
  if (base === 0) return 0;
  let amount = base;
  if (blessings.includes("loyal_club") && mods.loyalStay) {
    amount = amount * 1.5;
  }
  return Math.round(amount);
}

// ───────────────────────────── period decision builder ─────────────────────────────

/** 阶段二：单选/被动事件自动结算的结果。不弹决策，mods 进 pendingMods，
 *  outcome 进 pendingFlavor 显示在赛季卡上。复用与玩家手选完全相同的
 *  resolve 路径（derive(seed,"resolve",age,optionKey)），确定性一致。 */
export interface FlavorResult {
  readonly kind: "flavor";
  readonly mods: Modifiers;
  readonly outcome: string;
  readonly eventKey?: string;
  readonly slotAge?: number;
  readonly injury?: boolean;
  readonly severe?: boolean;
}

/** 把 rollRandomEvent 的结果按“真决策 vs 伪决策”分流：单选事件（只有“知道
 *  选项”一个按钮）自动 resolve 成 flavor，不再弹决策台；双选事件保留为决策。
 *  直接回应反馈#3“好多时候没选择，只有知道选项”。
 *
 *  宿命时刻例外（research/single-option-events-design.md 方案 B）：单选但
 *  eventOdds 有值的事件是 legendary 高光时刻（决赛绝杀/门将奇迹…），其
 *  resolve 内 roll(p) 是一笔大额 legacy 赌注。这类「那一刻只能冲」的瞬间
 *  是 ink 的 gather——结果有概率，但选择是宿命表达。保留抉择台让 odds 显形
 *  （PRODUCT 铁律：odds are the hero 在最高光时刻最该闪耀），单选+odds 标签
 *  让玩家与真二选一抉择台区分（“宿命时刻”而非“假抉择 bug”）。 */
function toDecisionOrFlavor(ev: FiredEvent | null, ctx: EventContext, seed: string): FiredEvent | FlavorResult | null {
  if (!ev) return null;
  // 单选且无 odds → 静默 flavor（纯叙事/被动事件，ink fallback）
  // 单选但有 odds → 宿命时刻，保留抉择台显形 odds（ink gather）
  if (ev.event.choices.length === 1 && ev.event.odds === undefined) {
    const choice = ev.event.choices[0]!;
    const rng = derive(seed, "resolve", ctx.age, choice.id);
    const r = ev.resolve(choice, rng, seed);
    return { kind: "flavor", mods: r.mods, outcome: r.outcome, eventKey: ev.event.eventKey, slotAge: ev.event.slotAge, injury: r.injury, severe: r.severe };
  }
  return ev;
}

/** 类型守卫：区分 flavor（自动结算）与 FiredEvent（决策菜单）。 */
function isFlavor(r: FiredEvent | FlavorResult | null): r is FlavorResult {
  return r !== null && (r as FlavorResult).kind === "flavor";
}

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
  stateTournamentOffset = 0,
): FiredEvent | FlavorResult | null {
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
    tournamentOffset: stateTournamentOffset,
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
  // 统一过 toDecisionOrFlavor：单选事件自动转 flavor（挂赛季行），
  // 双选保留抉择台。ink fallback philosophy：无备选项不以抉择形式呈现。
  if (completedLoan) {
    return toDecisionOrFlavor(postLoanEvent(ctx, completedLoan), ctx, seed);
  }

  // 母本 contextual events: contract non-renewal (age 26+, bench role) takes
  // priority. The contract_crisis tag (set on resolve, long TTL) is the
  // anti-repeat guard — without it a benched veteran refires this every period.
  if (player.age >= 26 && (role === "substitute" || role === "low_rotation")
      && !ctx.statusTags.includes("contract_crisis")) {
    const nr = toDecisionOrFlavor(fireEventByKey(ctx, "contract_nonrenewal"), ctx, seed);
    if (nr) return nr;
  }
  // relegation loyalty: if the player's club was just relegated. The
  // relegation_endured tag keeps a yo-yo club from asking every other season.
  if (lastSeasonRelegated && !ctx.statusTags.includes("relegation_endured")) {
    // 降级去留：单选事件（只有「留队征战」），过多分流后自动转 flavor，
    // 不再以单按钮抉择台弹给玩家。修复「降级去留只有一个选项」的呈现 bug。
    // （内容补全见 research/single-option-events-design.md 步骤 2。）
    const rl = toDecisionOrFlavor(fireEventByKey(ctx, "relegation_loyalty"), ctx, seed);
    if (rl) return rl;
  }

  // 归化邀约：已退出国家队会籍（intl_retired tag 在身）的球员，被一个更强的
  // 他国足协看中。概率门（每期 35%）——保留「不一定来」的张力，但 8 个 period
  // 的 tag 生命周期内基本会等到。accept 切 FIFA 会籍并打上永久 naturalized
  // 防 reopen（intl_retired 本身靠自然 decay 消失）。
  // 先于 climax：归化改变了 nationality，直接影响 WC climax 的国家判定。
  if (ctx.statusTags.includes("intl_retired")
      && !ctx.statusTags.includes("naturalized")
      && player.age >= 20 && player.age <= 32
      && player.overall >= 72
      && nationById(player.nationalityId).fifaRep <= 3
      && chance(derive(seed, "nat-offer", player.age, periodIndex), 0.35)) {
    const no = toDecisionOrFlavor(fireEventByKey(ctx, "naturalization_offer"), ctx, seed);
    if (no) return no;
  }
  // 俱乐部与国家队冲突：国家队剧情线的入口（拒绝征召 → 归化邀约）。
  // Contextual 触发——球员够强被征召 + 主力 + 尚未退出会籍，每期 15%
  // 概率门。一个生涯期望触发 ~3 次，让「拒绝征召」这条因果链可靠可走。
  if (!ctx.statusTags.includes("intl_retired")
      && !ctx.statusTags.includes("naturalized")
      && (role === "starter" || role === "high_rotation")
      && player.overall >= (CALLUP_THRESHOLD[clamp(nationById(player.nationalityId).intlRep, 0, 5)] ?? 70)
      && chance(derive(seed, "nt-conflict", player.age, periodIndex), 0.15)) {
    const cne = toDecisionOrFlavor(fireEventByKey(ctx, "club_national_team_conflict"), ctx, seed);
    if (cne) return cne;
  }

  // climax events: fire if a national-team tournament year falls within the
  // upcoming period's season ages. The World Cup is no longer nailed to
  // 19/23/27/31 — each career's tournament cycle is phase-shifted by
  // `tournamentOffset` (a pure function of the seed), so the WC lands at
  // (19+toff, +4, +4, ...). Continental cups lead the WC by 1 year.
  //
  // TRIGGER IS EARNED, NOT ASSURED: even in a tournament year the climax only
  // fires when the player is good enough (OVR) AND his nation has a real shot
  // (a seeded "reach the final" roll). A player who hasn't peaked yet, or whose
  // nation didn't draw a deep run, simply has no national climax that cycle —
  // "踢不踢世界杯看球员实际情况，不是命中注定的叙事点".
  //
  // STRONG vs MINNOW NATIONS: fifaRep≥2 nations chase the World Cup (qualifier
  // for rising stars, final for established stars). fifaRep≤1 && contRep≤2
  // minnows (中国/泰国/越南/印尼/玻利维亚/斐济…) can't realistically reach
  // a WC final, so their national climax is the CONTINENTAL CUP final instead —
  // 亚洲杯/非洲杯/美洲杯 is the realistic dream for a fan of those nations,
  // not「中国杀入世界杯决赛」.
  const seasonAges: number[] = [];
  for (let a = player.age - periodLength; a < player.age; a++) seasonAges.push(a);
  const toff = stateTournamentOffset;
  const wcBase = 19 + toff;
  const contBase = wcBase - 1;
  // Pre-emptive detection: the showdown's result-override mods land on NEXT
  // period's season(s) (flow through pendingMods, consumed one period later).
  // To reach simulateNational's isWcAge/isNatContAge branch, the showdown fires
  // the period BEFORE the tournament year — detect the UPCOMING year.
  // Strong nations: detect the WC year (override lands on WC age → isWcAge).
  // Minnow nations: detect the continental-cup year (override lands on cont
  // age → isNatContAge).
  const nation = nationById(player.nationalityId);
  const fifaRep = clamp(nation.fifaRep, 0, 5);
  const contRep = clamp(nation.contRep, 0, 6);
  const isMinnow = fifaRep <= 1 && contRep <= 2;
  let climaxAgeThisPeriod: number | undefined;
  for (let a = player.age; a < player.age + periodLength; a++) {
    const targetBase = isMinnow ? contBase : wcBase;
    if (a >= targetBase && (a - targetBase) % 4 === 0) { climaxAgeThisPeriod = a; break; }
  }
  // 飞升 9 国家队退役: no national climax — the national door is closed.
  if (climaxAgeThisPeriod !== undefined && ascension < 9) {
    const bareTags = ctx.statusTags;
    if (isMinnow) {
      // minnow nation: the realistic national dream is the continental cup.
      if (player.overall >= 74 && !bareTags.includes("cont_boss_done")) {
        // a minnow actually reaching the continental final is itself a story —
        // contRep-scaled, so a contRep-1 minnow rarely does (the miracle run),
        // but when it does it gets a real shot (the underdog arc).
        const reachOdds = contRep >= 2 ? 0.40 : 0.20;
        if (chance(derive(seed, "cont-reach", climaxAgeThisPeriod), reachOdds)) {
          let odds = contRep >= 4 ? 0.50 : contRep >= 2 ? 0.40 : 0.30;
          // 诸神黄昏 (ascension 5): −30%; 天命难违 (ascension 6): −10%.
          if (ascension >= 5) odds *= 0.7;
          if (ascension >= 6) odds *= 0.9;
          // pp_boss_slayer (+10%) and 大赛型选手 big_game_player (+20%) boss good odds.
          if (permPerks.includes("pp_boss_slayer")) odds = clamp(odds + 0.1, 0.01, 0.95);
          if (blessings.includes("big_game_player")) odds = clamp(odds + 0.2, 0.01, 0.95);
          odds = clamp(odds, 0.01, 0.95);
          return continentalCupShowdown(climaxAgeThisPeriod, odds, nation.confederation, blessings, nation.name);
        }
      }
    } else {
      // strong nation: the World Cup path — qualifier for rising stars,
      // final for established stars. One reach roll per WC cycle.
      if (player.overall >= 70) {
        if (player.overall < 74 && !bareTags.includes("wc_quali_done")) {
          // 诸神黄昏 (ascension 5): −30%; 天命难违 (ascension 6): −10%.
          let qOdds = 0.5;
          if (ascension >= 5) qOdds *= 0.7;
          if (ascension >= 6) qOdds *= 0.9;
          // pp_boss_slayer (+10%) and 大赛型选手 big_game_player (+20%) boss good odds.
          if (permPerks.includes("pp_boss_slayer")) qOdds = clamp(qOdds + 0.1, 0.05, 0.95);
          if (blessings.includes("big_game_player")) qOdds = clamp(qOdds + 0.2, 0.05, 0.95);
          return worldCupQualifierShowdown(climaxAgeThisPeriod, clamp(qOdds, 0.05, 0.95), true, 0, blessings, nation.name);
        }
        if (player.overall >= 74 && !bareTags.includes("wc_boss_done")) {
          // P-META 压基线: reach 0.55 × win 0.50 made the once-per-career final
          // a near-coin-flip — plus the passive rolls, 68% of first careers
          // lifted the WC. Reached by a minority of stars, won by fewer (OVR,
          // big_game_player, pp_boss_slayer still move these odds).
          const reachOdds = fifaRep >= 4 ? 0.30 : fifaRep >= 2 ? 0.20 : 0.08;
          // Career-stable derive key: the reach roll resolves the SAME way at
          // every retry — a generation that misses the final misses it for
          // good. 一生一战 covers reaching it, not just playing it.
          if (chance(derive(seed, "wc-reach", "career"), reachOdds)) {
            let odds = fifaRep >= 4 ? 0.30 : fifaRep >= 2 ? 0.27 : 0.30;
            // 诸神黄昏 (ascension 5): −30%; 天命难违 (ascension 6): −10%.
            if (ascension >= 5) odds *= 0.7;
            if (ascension >= 6) odds *= 0.9;
            // pp_boss_slayer (+10%) and 大赛型选手 big_game_player (+20%) boss good odds.
            if (permPerks.includes("pp_boss_slayer")) odds = clamp(odds + 0.1, 0.01, 0.95);
            if (blessings.includes("big_game_player")) odds = clamp(odds + 0.2, 0.01, 0.95);
            odds = clamp(odds, 0.01, 0.95);
            return worldCupShowdown(climaxAgeThisPeriod, odds, "世界杯冠军", "功亏一篑", blessings, nation.name);
          }
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

  // P-RETIRE: soft retention. Past RETENTION_START the body must earn another
  // period — a retention roll gates whether the club keeps picking the
  // player. A failed roll fires the no_offers decision (降档续约 or 挂靴).
  // This is the EMERGENT career length the user asked for: Modric/Casillas
  // pass rolls to 40+, a 伤仲永 crashing out fails early. Placed after the
  // climax events (a WC year outranks the age gate) but before the injury /
  // transfer window (if the body can't continue, no point offering transfers).
  // Bench players 26+ are already caught by contract_nonrenewal above, so this
  // catches the STARTER whose legs are going — the fall-from-peak arc. The
  // derive key is per (age, periodIndex) so it's an independent, reproducible
  // stream a replayer can't game from other rolls.
  if (player.age >= RETENTION_START) {
    const r = derive(seed, "retention", player.age, periodIndex);
    const prob = retentionProb(player.overall, player.age, club, ctx.statusTags, severeInjuries, blessings, permPerks);
    if (!chance(r, prob)) {
      return noOffersEvent(ctx);
    }
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
  const injuryR = toDecisionOrFlavor(injuryEv, ctx, seed);
  if (injuryR) return injuryR;

  const windowCadence = ascension >= 8 ? 5 : 3;
  // Event-variety fix: `periodIndex` is a SEASON count (PERIOD_LENGTH=1 in its
  // calc), so `periodIndex % windowCadence` only matched the period rhythm at
  // long pace (1 season/period). At express (3 seasons/period) the window
  // NEVER opened — a 300-career MC saw 0 transfers. Cadence on a true PERIOD
  // count (`floor(periodIndex/periodLength)`) with the remainder shifted to
  // W-2 so the window still opens at periods 2/5/8 (the original normal & long
  // rhythm that early club-climbing depends on for OVR growth) — express
  // careers finally get to climb too. (W-1 would shift every transfer one
  // period later and quietly drop peak OVR by delaying the move to a bigger
  // club.)
  const periodCount = Math.floor(periodIndex / periodLength);
  const isTransferWindow = periodCount > 0 && periodCount % windowCadence === windowCadence - 2;
  if (isTransferWindow) {
    // P-RETIRE: wage squeeze — a 伤仲永 whose locked-in wage is far above his
    // current market value. No club will match his pay; offers become pay cuts
    // + a 挂靴 option. The 24yo-peak €2000万 → OVR-crash → 27-retires arc is
    // ECONOMIC, not random: his wage prices him out of the game. Pure
    // arithmetic trigger (no rng); offers reuse the transfer derive streams.
    // lastWage is reconstructed from last season's market value at the current
    // club/league (wage was computed from that season's MV) so the rebuild
    // after a refresh is deterministic.
    const lastMv = recentMarketValue;
    const lastWage = lastMv > 0 ? computeWage(lastMv, league, club) : 0;
    const squeezeRole = resolveRole(player.overall, club, player.position === "GK");
    const fairMv = computeMarketValue(player.overall, player.age, league, club, squeezeRole, null, 0, false);
    const fairWage = computeWage(fairMv, league, club);
    if (lastWage > 0 && fairWage > 0 && lastWage > fairWage * WAGE_SQUEEZE_RATIO) {
      return wageSqueezeEvent(ctx);
    }
    return transferEvent(ctx);
  }

  // Mechanics review: 王座之战 — the late-career "legend maintenance" boss. An
  // 85+ starter aged 29+ at a big club (rep≥4) faces a rising heir at his own
  // position; the decision-tension curve used to go flat exactly when the
  // career peaked (rep5 starter = autopilot trophy farming). throne_done@6
  // prevents back-to-back refires; the ~60% arm rate keeps it an event, not a
  // fixture. Below the transfer cadence so it never eats a contract window.
  if (player.age >= 29 && player.overall >= 85 && role === "starter" && club.rep >= 7
      && !ctx.statusTags.includes("throne_done")
      && chance(derive(seed, "throne", player.age), 0.6)) {
    const tc = toDecisionOrFlavor(fireEventByKey(ctx, "throne_challenge"), ctx, seed);
    if (tc) return tc;
  }

  // blockbuster offer (母本 aa): a fame club courts a star (age 28-34, peak≥80).
  const bb = blockbusterOfferEvent(ctx, maxOverall, blockbusterOfferedTier);
  if (bb) return bb;

  // loan offer (母本 oa/sa): young bench players at a BIG club get loaned out
  // for minutes — the relief valve for the bigClubBench growth penalty (P-A16,
  // the "moved to a giant too early" fork the user wants). Hoisted ABOVE the
  // career plan + random fallback so it actually fires for the benched
  // youngster it exists for — previously 2% of careers ever saw a loan because
  // lower-priority random events ate it. Gated to big clubs (rep≥5): a small
  // club plays its bench, it doesn't loan them out (inauthentic); only a deep-
  // squad giant loans a youngster out for development (Chelsea loan army,
  // Castilla → loan). Higher gate than before (0.85/0.55) because a big club
  // WANTS to loan out a bench youngster — it's the expected path, not a rare
  // offer. Below transfer window (a permanent move is a bigger career beat)
  // and injury/climax (those outrank everything).
  if (!completedLoan && (role === "substitute" || role === "low_rotation" || role === "third_keeper")
      && player.age >= 18 && player.age <= 24 && club.rep >= 5) {
    const loanProb = role === "low_rotation" ? 0.55 : 0.85;
    if (chance(derive(seed, "loan-offer", player.age, periodIndex), loanProb)) {
      return loanOfferEvent(ctx);
    }
  }

  // career event plan (母本 ma): if a slot age is due, fire a scheduled event.
  if (plan && player.age <= 37) {
    const slot = findAvailableSlot(plan, player.age);
    if (slot !== null) {
      ctx.slotAge = slot;
      const r = toDecisionOrFlavor(rollRandomEvent(ctx), ctx, seed);
      if (r) return r;
    }
  }

  // else: random career event (单选→自动 flavor，双选→决策)，都没有则静默推进。
  // 阶段二：砍掉 fallback transferEvent（“无事件也塞个转会”是碎决策源），
  // 让 period 末可以“无决策”——玩家连续看几季数据涨跌，到真分叉才停下。
  const r = toDecisionOrFlavor(rollRandomEvent(ctx), ctx, seed);
  if (r) return r;
  return null;
}

/** Find the next available career-event slot at/below the age. (Kr) */
function findAvailableSlot(plan: CareerEventPlan, age: number): number | null {
  if (plan.completedEventKeys.length >= plan.targetCount) return null;
  return plan.slotAges.find((s) => s <= age && !plan.completedSlotAges.includes(s)) ?? null;
}

// ───────────────────────────── choice resolution ─────────────────────────────

export function resolveChoice(state: GameState, choice: Choice): GameState {
  if (!state.pendingChoice || !state.pendingResolve) return state;
  // Mechanics review: the resolve stream is derived per (age, CHOICE) — not per
  // age alone. With age-only derivation every option at a given age shared the
  // same underlying draw, so a replayer who learned "the age-24 roll is low"
  // knew ANY gamble there would succeed — daily-challenge runs became solvable
  // lookup tables. Mixing in choice.id makes each option an independent stream.
  const rng = derive(state.seed, "resolve", state.age, choice.id);
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
  // Mechanics review: loyalty streak — consecutive stays earn escalating legacy
  // (3 → 5 → 8, before loyal_club's ×1.5) and the 3rd consecutive stay marks
  // the player a club legend (club_legend@99, effectively permanent). This
  // gives the stay option a real counterweight to the transfer flow's stacked
  // rewards (6 legacy + OVR perks + trophy-tier upgrade). Runs THROUGH the
  // mercenary strip above, so mercenaries never accrue a loyalty track.
  const prevStay = state.stayStreak ?? 0;
  const stayStreak = (isPermanentMove || mods.loanOutTo) ? 0
    : finalMods.loyalStay ? prevStay + 1 : prevStay;
  if (finalMods.loyalStay && stayStreak >= 2) {
    finalMods = {
      ...finalMods,
      legacy: (finalMods.legacy ?? 0) + (stayStreak >= 3 ? 5 : 2),  // base 3 → 5 / 8
      ...(stayStreak === 3 ? { addTags: [...(finalMods.addTags ?? []), ttlTag("club_legend", 99)] } : {}),
    };
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
    stayStreak,
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
  // 结局分档: a "no_offers" trigger (soft-retention roll failed, or the
  // FORCE_RETIRE_OVR floor) does NOT mean the CAREER was forgettable. A solid
  // career that simply aged out — peaked ≥80, or won ≥3 trophies — gets the
  // dignified "英雄迟暮" ending, not "无人问津，黯然离场". This surfaces the
  // authored ending variety beyond the elite (peak≥85) and stops most careers
  // reading the same harsh label: measured on the fresh-account baseline, 94%
  // ended "no_offers" and 63% of THOSE had peaked ≥80 or won 3+ trophies.
  let finalReason = reason;
  if (reason === "no_offers" && (maxOverall >= 80 || trophies.length >= 3)) {
    finalReason = "faded";
  } else if (reason === "no_offers" && maxOverall >= 75 && seasons.length >= 18) {
    // 结局分档: between "英雄迟暮" (hero's twilight, peak≥80) and the harsh
    // "无人问津" sits the JOURNEYMAN — a long, solid career that never reached
    // stardom but was a real career (peaked 75-79, 18+ seasons). Measured on
    // the fresh-account baseline, 31% of careers ended "no_offers" and 97%
    // of THOSE played 18+ seasons, 56% peaked ≥75 — a 22-year pro does not
    // retire "sadly unnoticed". The genuine washout (short OR low-peak) still
    // reads "无人问津"; this rescues the respectable journeyman from the
    // harshest label, so a third of runs no longer end on a downer.
    finalReason = "journeyman";
  }
  // P-A1: cap the career story with a retirement beat + P-A20: post-career path.
  const finalBeats = [...(state.careerBeats ?? EMPTY_BEATS)];
  if (seasons.length > 0) {
    const reasonText = finalReason === "age" ? "年迈挂靴，传奇落幕。"
      : finalReason === "faded" ? "英雄迟暮，带着荣光离场。"
      : finalReason === "journeyman" ? "坚守多年，体面挂靴。"
      : finalReason === "no_offers" ? "无人问津，黯然离场。"
      : finalReason === "injury" ? "身体先于梦想倒下——医学退役。"
      : "主动挂靴，功成身退。";
    finalBeats.push({ age: player.age, season: seasons.length, text: reasonText, tone: finalReason === "no_offers" || finalReason === "injury" ? "bad" : "neutral" });
    // P-A20: post-career path — determined by peak + trophies + final value.
    const finalMv = seasons.length > 0 ? (seasons[seasons.length - 1]!.marketValue ?? 0) : 0;
    let postCareer = "回归平民生活，远离聚光灯。";
    if (finalReason === "injury") {
      postCareer = maxOverall >= 85
        ? "天妒英才——全世界都在问「如果他没受伤」。你成了足球史上永远的假设。"
        : "伤病带走了生涯。你转型康复师，帮年轻球员避开你走过的坑。";
    }
    else if (maxOverall >= 90 && trophies.includes("world_cup")) postCareer = "以世界杯英雄之姿退役，举国铭记。";
    else if (maxOverall >= 90 && awards.includes("ballon_dor")) postCareer = "金球先生退役，执教邀约如雪片飞来。";
    else if (maxOverall >= 90) postCareer = "传奇挂靴，转型名帅，执教邀约不断。";
    else if (maxOverall >= 85 && trophies.length >= 5) postCareer = "功勋老将退役，受邀担任俱乐部形象大使。";
    else if (finalMv >= 20) postCareer = "身价不菲，转型足球评论员，活跃于荧屏。";
    else if (maxOverall >= 80 || finalReason === "faded") postCareer = "体面退役，回到母国青训执教。";
    else if (finalReason === "journeyman") postCareer = "多年坚守，回到低级别联赛执教青训。";
    else if (finalReason === "no_offers") postCareer = "无人接手，黯然告别职业足坛。";
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
    retirementReason: finalReason,
    pendingChoice: null,
    pendingResolve: undefined,
  };
}

/** 刷新后重建 pendingResolve（函数不可序列化，JSON 存/读后丢失）。从 game +
 *  pendingChoice 精确重建 EventContext——periodIndex 反推为 seasons.length −
 *  periodLength（即进入本 period 时的 season 数），使 derive(seed,"period-decision",
 *  periodIndex) 与原 rngState 一致 → transfer 的 offers 重新 derive 结果一致，
 *  确定性不破。再按事件类型复现 resolve：boss / transfer / loan / blockbuster
 *  有独立 builder（带后处理 forceTrophy / worldCupResultOverride / addTags 等，
 *  闭包里），调对应 builder 拿回带后处理的 resolve；其余直接 resolveEventOption。 */
export function rebuildResolve(game: GameState): ResolveFn | undefined {
  const ev = game.pendingChoice;
  if (!ev || !game.player) return undefined;
  // 注意：transfer/loan/post_loan/blockbuster 的 event 不带 eventKey（它们的
  // resolve 自己处理，不走 resolveEventOption），所以这里不拦 eventKey——
  // 只在 default 分支（普通/contextual 事件用 resolveEventOption）才需要。
  const player = game.player;
  const club = clubById(game.currentClubId);
  const league = leagueById(club.leagueId);
  const periodLength = game.periodLength ?? PERIOD_LENGTH;
  const periodIndex = Math.max(0, game.seasons.length - periodLength);
  const ctx: EventContext = {
    player, club, league,
    seed: game.seed,
    age: player.age,
    role: resolveRole(player.overall, club, player.position === "GK"),
    periodIndex,
    rngState: derive(game.seed, "period-decision", periodIndex),
    blessings: game.blessings ?? EMPTY_BLESSINGS,
    injuriesTaken: game.injuriesTaken ?? 0,
    severeInjuries: game.severeInjuries ?? 0,
    ascension: game.ascension,
    statusTags: (game.statusTags ?? EMPTY_TAGS).map(tagName),
    plan: game.careerEventPlan,
    periodLength,
    permPerks: game.permPerks ?? EMPTY_PERKS,
    formerClubIds: [...new Set(game.seasons.map((s) => s.clubId))],
    recentMarketValue: game.seasons.length > 0 ? (game.seasons[game.seasons.length - 1]!.marketValue ?? 0) : 0,
    slotAge: ev.slotAge,
    variantKey: ev.variantKey,
    injuryType: ev.injuryType,
    bossOdds: ev.bossOdds,
    tournamentOffset: game.tournamentOffset ?? 0,
  };
  const blessings = ctx.blessings;
  const bossOdds = ev.bossOdds ?? ev.odds ?? 0.5;
  switch (ev.key) {
    case "world_cup_showdown":
      return worldCupShowdown(ev.worldCupShowdown?.age ?? player.age, bossOdds, "冠军", "功亏一篑", blessings).resolve;
    case "world_cup_qualifier_showdown": {
      const q = ev.worldCupQualifier;
      return worldCupQualifierShowdown(q?.age ?? player.age, bossOdds, q?.boosted ?? false, q?.carryTiers ?? 0, blessings).resolve;
    }
    case "continental_cup_showdown": {
      const conf = nationById(player.nationalityId).confederation;
      return continentalCupShowdown(player.age, bossOdds, conf, blessings).resolve;
    }
    case "decisive_penalty":
      return decisivePenalty(bossOdds, ev.targetTrophy ?? "league", blessings).resolve;
    case "transfer":
      return transferEvent(ctx).resolve;
    case "wage_squeeze":
      return wageSqueezeEvent(ctx).resolve;
    case "loan_offer":
      return loanOfferEvent(ctx).resolve;
    case "post_loan":
      return game.completedLoan ? postLoanEvent(ctx, game.completedLoan).resolve : undefined;
    case "blockbuster_offer": {
      const bb = blockbusterOfferEvent(ctx, game.maxOverall, game.blockbusterOfferedTier);
      return bb ? bb.resolve : undefined;
    }
    default: {
      if (!ev.eventKey) return undefined;
      const key = ev.eventKey;
      return (choice, rng) => resolveEventOption(rng, key, choice.id, ctx);
    }
  }
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

/** P1: status tags that represent player IDENTITY (the roguelike "build") —
 *  not transient mechanical state (anti-repeat gates, *_done flags, talisman,
 *  nagging_injury, doped, cautious_play…). These are accumulated across the
 *  whole career into `personaTagsEver` so the summary can show what kind of
 *  player this career became, even after a tag's TTL decayed. The UI's label
 *  map (App.tsx PERSONA_TAG) MUST stay in sync with this set. */
const PERSONA_TAG_KEYS = new Set([
  "club_legend", "naturalized", "captain", "fan_darling",
  "mentor_legend", "compromised_body", "intl_retired",
]);

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
      desc: `你已经踢了${count}个赛季。${goals}个进球，${trophies}座奖杯，${clubs}家俱乐部。`,
      tone: "good",
      age: seasons[seasons.length - 1]?.age ?? 0,
    };
  }
  return undefined;
}
