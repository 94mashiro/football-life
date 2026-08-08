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
  type NationalContext,
} from "./sim";
import {
  rollRandomEvent, rollInjuryEvent, transferEvent, loanOfferEvent,
  postLoanEvent, blockbusterOfferEvent, doctorWarningEvent, medicalVerdictEvent,
  worldCupShowdown, worldCupQualifierShowdown, continentalCupShowdown, decisivePenalty,
  rivalShowdown,
  fireEventByKey, resolveEventOption,
  noOffersEvent, wageSqueezeEvent,
  type EventContext, type FiredEvent,
} from "./events";
import type {
  GameState, Player, SeasonResult, Trophy, Award, Role, Choice, Modifiers, SeasonStats,
  CareerEventPlan, Challenge, CareerBeat, Milestone, ChoiceLogEntry, ResolveFn, Rival,
} from "./types";
import { trophyMult } from "./types";
import { rollDevProfile, scoreLegacy } from "../meta/legacy";
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

/** Transfer-window cadence — the career spine. A window opens every
 *  `transferWindowCadence(ascension)` SEASONS of career age, from 19 through
 *  the prime years (capped at 31) — detected via the ages just simulated this
 *  period, so it's pace-independent (沉浸/标准/速通 all see the same ~7 prime
 *  windows). The late career (32+) is left to the decline/retirement arc
 *  (no_offers, blockbuster) + silent periods, so the spine is dense in the
 *  exciting transfer years and the denouement breathes. 飞升 8 转会冻结
 *  slows the cadence to every 5. See buildPeriodDecision's transfer block for
 *  the rollover (events defer a due window to next period, never cancel it). */
const TRANSFER_WINDOW_START_AGE = 19;
const TRANSFER_WINDOW_END_AGE = 31;
const transferWindowCadence = (ascension: number): number => (ascension >= 8 ? 5 : 2);
function isTransferWindowAge(seasonAges: readonly number[], ascension: number): boolean {
  const cadence = transferWindowCadence(ascension);
  return seasonAges.some(
    (a) => a >= TRANSFER_WINDOW_START_AGE && a <= TRANSFER_WINDOW_END_AGE && (a - TRANSFER_WINDOW_START_AGE) % cadence === 0,
  );
}

// ───────────────────────────── run creation ─────────────────────────────

/** 母本 pace modes: 沉浸(1 season/decision), 标准(2, default), 速通(3). */
export type PaceMode = "long" | "normal" | "express";
export const PACE_LENGTH: Record<PaceMode, number> = { long: 1, normal: 2, express: 3 };

/** 母本 personalEventCount per mode (E[mode].personalEventCount).
 *  P-VAR (event-variety pass): normal 3-4 → 5, express 2-3 → 3-4 — the
 *  career-plan slots are the player's guaranteed story spine; at the old
 *  counts the 176-event catalog got ~2.5 fires per career and the same
 *  handful of system events dominated every run. slotAgesForMode's first
 *  slot also moved from 22 → 16 so youth-phase events (≤19: 高中毕业/
 *  少年成名/青训死敌…) are reachable at the default pace instead of dead
 *  content. (max non-adjacent slots: normal 6, express 4, long 11 — the
 *  counts below respect those caps so combos always exist.) */
const PERSONAL_EVENT_COUNT: Record<PaceMode, readonly [number, number]> = {
  long: [6, 7], normal: [4, 4], express: [3, 3],
};

/** Generate slot ages for career events, evenly spaced. (Ur) */
function slotAgesForMode(periodLen: number): number[] {
  const start = 16;
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
  // golden_boy: 天才少年直接以主力级起步 (50 → 65, +15)；无传承溢价——
  //   起跑优势本身即是全部收益。俱乐部发展天花板会自然约束：弱旅青训营
  //   (rep 0/1 天花板 ~64-71) 会限速逼其转会爬升, 不会直接冲到 99。
  // pp_prodigy: +2 (与金童叠加 → 67)。
  let startOvr = START_OVR;
  if (blessings.includes("golden_boy")) startOvr += 15; // 50 → 65
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
    // 传承为生涯末评价，非事件奖励——医学/挂靴提前结束时由 finalizeRun 经
    // scoreLegacy 统一结算，此处不再加减任何事件传承。
    const reason = mods0.forceRetireReason ?? "injury";
    return finalizeRun(state, state.currentClubId, state.currentLeagueId, state.seasons, state.trophies, state.awards, state.maxOverall, state.player, reason);
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
  for (let i = 0; i < periodLength; i++) {
    if (player.age > MAX_AGE) break;
    // P-NAT: career-level national context for this season — prior call-up
    // count drives the debut / captain milestones. Seasons written before the
    // `national` field fall back to an OVR≥70 proxy for prior call-ups (the flat
    // call-up threshold). The track is additive — call-ups/trophies unchanged.
    const priorCalledUpCount = seasons.filter((s) => s.national?.calledUp ?? s.overall >= 70).length;
    const natCtx: NationalContext = { priorCalledUpCount };
    const season = simOneSeason(seed, player, club, league, mods, i, periodIndex, awards.filter(a => a === "ballon_dor" || a === "golden_glove").length, blessings, state.ascension, state.tournamentOffset ?? 0, statusTags.some((t) => tagName(t) === "captain"), natCtx);
    seasons.push(season);
    trophies = [...trophies, ...season.trophies];
    awards = [...awards, ...season.awards];
    maxOverall = Math.max(maxOverall, season.overall);
    // P-A4: streak tracking — +1 on a trophy season, reset on a dry one. The 🔥
    // 连冠 chip + best-streak readout (summary) consume this; legacy itself is a
    // career-end evaluation (scoreLegacy), no longer a per-season grant.
    if (season.trophies.length > 0) {
      trophyStreak += 1;
    } else {
      trophyStreak = 0;
    }
    bestStreak = Math.max(bestStreak, trophyStreak);
    // P-A1: capture narrative beats for the career story feed.
    beats = appendSeasonBeats(beats, season, seasons.length, player);
    // P-NAT: the parallel national storyline's milestones (debut / captain /
    // deep tournament run) — appended alongside the club beats so the career
    // feed carries BOTH careers, not just the club.
    beats = appendNationalBeat(beats, season, seasons[seasons.length - 2], seasons.length);
    // growth → next season's OVR
    const rng = derive(seed, "growth", player.age, periodIndex);
    const declineDelay = (state.permPerks?.includes("pp_longevity") ? 1 : 0)
      // 大器晚成: delay the age-28 decline onset by one cycle (2 yrs) so the
      // post-25 bloom has room to work before the decline curve pulls the
      // career back — without this the bloom amplified a base that was already
      // declining, so the blessing was an active trap.
      + (blessings.includes("late_bloomer") ? 1 : 0);
    let delta = growthDelta(rng, player, season.role, club, league, state.ascension, declineDelay);
    // pp_scout (青训球探): elite academy coaching — +1 growth per cycle before 20.
    if (state.permPerks?.includes("pp_scout") && player.age < 20) delta += 1;
    // 玻璃大炮: +50% growth (the payoff for ×3 injuries).
    if (blessings.includes("glass_cannon")) delta = Math.round(delta * 1.5);
    // 大器晚成: a survivable slow start (×0.9 before 25 — was ×0.5 then ×0.8,
    // both of which stalled the prime-years accumulation enough that even a
    // full OVR recovery left the career with fewer trophies/wages/awards from
    // the 16-24 window, netting −44 legacy vs base — an active trap at 105 cost).
    // ×0.9 keeps the "slow burn" identity (you ARE weaker early) while leaving
    // enough prime-years production that the post-25 bloom (×2.0, positive only)
    // + decline-delay turns it net-positive. The bloom multiplies POSITIVE growth
    // only — was `Math.round(delta * 1.5)` which also scaled NEGATIVE deltas, so
    // the "bloom" amplified the age-28+ decline and killed the career the moment
    // it started to flower. Combined with the decline-delay below, the bloom now
    // has a real window before decline — the slow-burn arc the blessing promises.
    if (blessings.includes("late_bloomer")) {
      delta = player.age < 25 ? Math.round(delta * 0.9) : delta > 0 ? Math.round(delta * 2.0) : delta;
    }
    // P-A22: butterfly-effect long-term growth drag — a "compromised_body" tag
    // (from playing through injuries, reckless challenges, etc.) subtracts 1
    // (铁人 ironman ignores this drag — the iron body doesn't degrade.)
    // from EVERY season's growth for as long as it persists. The wing that
    // flapped now blows for years — a career-defining fork, not a one-off bump.
    if (statusTags.includes("compromised_body") && !blessings.includes("ironman")) delta -= 1;
    // P-ENDGAME: apply the club development ceiling to the FINAL growth delta —
    // AFTER all multipliers (glass_cannon ×1.5, late_bloomer, pp_scout) so the
    // cap binds the actual OVR gain, not the pre-multiplier base. growthDelta
    // returns the raw club-rep delta; without this, glass_cannon re-inflated
    // the ceiling'd delta past the cap and full-prestige endgames bloated to a
    // 97-99 median. Decline (delta ≤ 0) passes through unchanged.
    if (delta > 0) delta = applyCeiling(delta, player.overall, club);
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
  // P-BLESS: proc 25%→30%→40% — a 150-legacy blessing that only fires after 30
  // was a low-ROI trap (probe +0.03). The Modric/Casillas arc it sells should
  // feel like it actually extends a prime. P-COMEBACK: the +1 is NO LONGER
  // club-ceiling-capped. The ceiling caps GROWTH (preventing 99-stacking via
  // youth spikes); comeback resists DECLINE — a 33yo star declining 90→89
  // regaining to 90 is staying at their level, not growing past a club's
  // potential. Capping it meant a peak-92 star at a rep-7 club (ceiling ~89)
  // got literally 0 from the blessing (already above ceiling) — the blessing
  // only helped stars at big clubs, the opposite of "extends any prime".
  // The +1 is bounded by the hard 99 cap; a star regaining 2-3 OVR over a
  // late career is the Modric arc, not a 99-stacking exploit (youth growth is
  // where that lives, and that's still capped).
  if (blessings.includes("comeback") && player.age >= 30) {
    const r = derive(seed, "comeback", player.age, periodIndex);
    if (chance(r, 0.40)) {
      const newOvr = clamp(player.overall + 1, 40, 99);
      player = { ...player, overall: newOvr };
      maxOverall = Math.max(maxOverall, newOvr);
    }
  }

  // check retirement triggers
  if (player.age >= 26 && player.overall < FORCE_RETIRE_OVR) {
    // a PRIME-AGE body wrecked by repeated severe injuries is an injury
    // retirement even before the 3rd-strike verdict — but a 34+ fade-out with
    // old scars is just ageing, not tragedy. Otherwise flavor by peak.
    const reason = (state.severeInjuries ?? 0) >= 2 && player.age <= 33 ? "injury"
      : maxOverall >= 85 ? "faded" : "no_offers";
    return finalizeRun(state, currentClubId, currentLeagueId, seasons, trophies, awards, maxOverall, player, reason);
  }
  if (player.age >= MAX_AGE) {
    // P-RETIRE: the hard ceiling is the authored safety net — the soft
    // retention roll (buildPeriodDecision) retires almost everyone first.
    // Reaching MAX_AGE means the player kept passing rolls deep into the
    // decline table; the growth-curve fallback at 44+ is so steep the roll
    // would fail next period anyway.
    return finalizeRun(state, currentClubId, currentLeagueId, seasons, trophies, awards, maxOverall, player, "age");
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
  // Transfer window is DUE this period if the age-based cadence landed on a
  // season just simulated, OR a previous window was eaten by a higher-priority
  // event and rolled over (transferWindowOwed). Either way buildPeriodDecision
  // fires the window unless a peak/medical/retention event outranks it — in
  // which case the window DEFERS to next period (we re-set the owed flag below),
  // never cancelled. This is "transfers independent of events": the cadence is
  // a hard schedule, events only delay it.
  const seasonAgesForWindow: number[] = [];
  for (let a = player.age - periodLength; a < player.age; a++) seasonAgesForWindow.push(a);
  const transferWindowDue = isTransferWindowAge(seasonAgesForWindow, state.ascension) || (state.transferWindowOwed ?? false);
  const underperformDue = shouldTriggerUnderperformance(seasons, player, club);
  const result = buildPeriodDecision(seed, player, club, league, periodIndex, rngState, state.blessings ?? EMPTY_BLESSINGS, state.injuriesTaken ?? 0, state.ascension, statusTags, lastSeasonRelegated, plan, periodLength, completedLoan, maxOverall, state.blockbusterOfferedTier, state.permPerks ?? EMPTY_PERKS, formerClubIds, recentMarketValue, state.severeInjuries ?? 0, !!state.injuryWarned, state.verdictSeenAt ?? 0, transferWindowDue, underperformDue, state.tournamentOffset ?? 0, state.careerEventsSeen ?? EMPTY_SEEN, state.rival);

  // 阶段二分流：决策（弹层） / 风味（自动结算，挂赛季卡） / 静默（无事件）。
  // flavor 的 mods 进 pendingMods，下一 period 生效（与 decision timing 一致）；
  // outcome 进 pendingFlavor 显示在赛季卡。plan/伤病计数在此更新（flavor
  // 不经 resolveChoice，必须自己结账）。
  let pendingChoice: GameState["pendingChoice"] = null;
  let pendingResolve: GameState["pendingResolve"] = undefined;
  let pendingMods: Modifiers = EMPTY_MODS;
  let pendingFlavor: string | undefined = undefined;
  let pendingFlavorKey: string | undefined = undefined;
  let planOut = plan;
  let injuriesTakenOut = state.injuriesTaken ?? 0;
  let severeInjuriesOut = state.severeInjuries ?? 0;
  let blockbusterTier = state.blockbusterOfferedTier;
  // P-VAR: per-career anti-repeat registry — every fired event key is recorded
  // (system keys included; only pool keys are matched, so the extra entries
  // are inert) and rolled forward so rollRandomEvent never repeats a story.
  let careerEventsSeenOut = state.careerEventsSeen ?? EMPTY_SEEN;
  if (isFlavor(result)) {
    pendingFlavor = result.outcome;
    pendingFlavorKey = result.eventKey;
    pendingMods = result.mods;
    if (result.eventKey) careerEventsSeenOut = [...careerEventsSeenOut, result.eventKey];
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

  // 转会窗欠账结算: a window was DUE this period. If a transfer/wage_squeeze
  // decision actually fired, the debt is cleared; if a higher-priority event ate
  // it (or it was a flavor/silent result), the window rolls over to next period.
  // transferEvent/wage_squeeze are always multi-choice decisions (never
  // single-option → never flavor), so a flavor/null result here means the due
  // window was overridden — defer it.
  const windowFired = result !== null && !isFlavor(result)
    && (result.event.key === "transfer" || result.event.key === "wage_squeeze");
  const transferWindowOwed = transferWindowDue && !windowFired;

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
    legacy: liveLegacy({ ...state, seasons, trophies, awards, maxOverall, player }),
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
    pendingFlavorKey,
    careerEventsSeen: careerEventsSeenOut,
    transferWindowOwed,
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

/** 豪门扫地出门 (你的数据配不上这家球队): a starter at a big club (rep≥6) whose
 *  last two STARTER seasons both trailed the club's standard — the 豪门无情
 *  pressure the engine was missing (bench players get 不再续约, 33+ bodies get
 *  无人问津, but a 主力 who stops producing at a big club had no forced exit).
 *  No full trophy exemption: the rating's own trophy bonus (capped +0.5) is
 *  the only credit a trophy grants, so being carried to a title doesn't save
 *  a poor campaign (the 皇马无情 read). Pure, no rng — the resolve roll lives
 *  in the event. Only counts seasons at THIS club where the player was
 *  actually a starter/high_rotation (the club judges you on minutes you
 *  played, not ones you sat), so a recent promotion to starter can't fire it
 *  until the club has watched two real starter seasons. */
const UNDERPERFORM_REP_MIN = 6;
// engineSeasonRating is an ABSOLUTE rating (5.5-9.5), blind to the shirt the
// player wears. "你的数据配不上这家球队" is RELATIVE, so the bar scales UP
// with club rep — a 7.0 starter season is fine at a rep6 minnow but an
// embarrassment at a rep9 giant. Sim output tracks OVR, so the event mostly
// catches a MARGINAL starter at a big club (OVR barely above squad base →
// modest output → below the club's high standard) sustained for 2 seasons —
// the "你爬上了豪门但不够格" exit. MC-calibrated against the rating
// distribution of big-club starters: rep9 p25≈7.1, so bar 7.45 catches the bottom
// ~10% of starter-season pairs (≈3% of big-club careers); rep6/7/8 starters
// rate higher (weaker opponents) so their lower bars rarely fire — only the
// biggest clubs are 豪门无情. No full trophy exemption: the rating's own trophy
// bonus (capped +0.5) is the only credit a trophy grants, so being carried to
// a title doesn't save a genuinely poor campaign (the 皇马无情 read).
const UNDERPERFORM_RATING_BY_REP: Record<number, number> = { 6: 6.9, 7: 7.1, 8: 7.25, 9: 7.45, 10: 7.6 };
function seasonMeetsClubStandard(s: SeasonResult, bar: number, position: Position): boolean {
  return engineSeasonRating(s.stats, s.role, position, s.trophies.length, s.seasonHonors?.includes("mvp") ?? false) >= bar;
}
function shouldTriggerUnderperformance(seasons: readonly SeasonResult[], player: Player, club: Club): boolean {
  if (club.rep < UNDERPERFORM_REP_MIN) return false;
  const bar = UNDERPERFORM_RATING_BY_REP[club.rep] ?? 7.45;
  // the current CONSECUTIVE starter run at THIS club: walk back from the latest
  // season, collecting starter/high_rotation seasons; stop at the first bench
  // season or the pre-transfer season (the club judges the run you're on, not
  // ancient history — a benched gap resets the slate). Need ≥2 seasons in the
  // run before the club has watched long enough to judge.
  const played: SeasonResult[] = [];
  for (let i = seasons.length - 1; i >= 0 && played.length < 2; i--) {
    const s = seasons[i]!;
    if (s.clubId !== club.id) break;
    if (s.role === "starter" || s.role === "high_rotation") played.unshift(s);
    else break;
  }
  if (played.length < 2) return false;
  return played.every((s) => !seasonMeetsClubStandard(s, bar, player.position));
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
  natCtx: NationalContext = { priorCalledUpCount: 0 },
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
  // P-NAT: the parallel national track (caps/goals/standing/tournament stage)
  // accumulates every season on top of the unchanged call-up/trophy logic.
  const nat = simulateNational(seed, player, player.age, {
    nationalTrophyOverride: mods.nationalTrophyOverride,
    worldCupResultOverride: mods.worldCupResultOverride,
    nationalTournamentParticipation: ascension >= 9 ? "skip" : mods.nationalTournamentParticipation,
    nationalTournament: mods.nationalTournament,
  }, toff, natCtx);
  const nationalTournaments = nat.trophies.map((t) => ({ trophy: t.trophy, stage: t.stage }));
  for (const t of nat.trophies) trophies.push(t.trophy);

  // awards
  const seasonAwards = rollAwards(seed, player.age, player.overall, player.position, stats, trophies, priorMajorAwards, league);

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
  const wage = computeWage(marketValue, player.overall, league, effClub);

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
    national: {
      calledUp: nat.calledUp,
      caps: nat.caps,
      goals: nat.goals,
      status: nat.status,
      tournament: nat.tournament,
    },
    relegated,
    seasonHonors,
    marketValue,
    wage,
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

/**
 * Compute the earn multiplier from marketable (×1.25) /
 *  pp_legacy_magnet (×1.1). Applied ONCE to the final score in scoreLegacy —
 *  NOT to in-run event legacy, which previously made both effects near-invisible
 *  (~2% of the real total). The shape blessings
 *  (loyal_club/sharpshooter/comeback/ironman) add a SEPARATE career-shape
 *  multiplier in blessingShapeMult, composed here in liveLegacy.
 *  (金童不再提供传承溢价——其全部价值已内化为 +15 起始 OVR 的起跑优势。)
 */
export function legacyEarnMult(blessings: readonly string[], permPerks: readonly string[]): number {
  let m = 1;
  if (blessings.includes("marketable")) m *= 1.25;
  if (permPerks.includes("pp_legacy_magnet")) m *= 1.1;
  return m;
}

/** Blessing career-end SHAPE multipliers — the visible "the blessing shaped
 *  this career" payoff as a PERCENTAGE (not absolute points: a career banks
 *  hundreds of legacy, so a flat +20 is invisible — a +15% multiplier scales
 *  with the career and is never鸡肋). Multiplied into earnMult, applied to the
 *  final score. Each rewards the career shape the blessing creates, capped so
 *  a full 3-blessing loadout can't runaway-stack:
 *  - loyal_club (忠诚之心): +1.5% per season of the longest single-club tenure
 *    beyond 8, capped +18% (a 20-season one-club man = +18%). The Totti/Maldini
 *    payoff, scaled to the career.
 *  - sharpshooter (神射手): +0.1% per career goal, capped +18% (180 goals).
 *    The attacker goal-legacy term is hard-capped, so the scoring VOLUME the
 *    blessing produces is priced here as a percentage.
 *  - comeback (浴火重生): +2% per season played past 33, capped +12% (retire
 *    at 39). The longevity itself is the payoff; comeback's retention boost
 *    makes deep careers more likely, so the bonus is higher with the blessing.
 *  - ironman (铁人): +1% per season played past 30, capped +8% (retire 38).
 *    Distinct from comeback's concentrated late-rebirth: ironman is the steady,
 *    broad durability arc, and its injury-rate reduction + OVR-loss halving
 *    make reaching those seasons more likely. */
export function blessingShapeMult(
  seasons: readonly SeasonResult[],
  careerGoals: number,
  retireAge: number,
  blessings: readonly string[],
): number {
  let m = 1;
  if (blessings.includes("loyal_club")) {
    let bestTenure = 0, cur = 0, curClub = "";
    for (const s of seasons) {
      if (s.clubId === curClub) cur++;
      else { curClub = s.clubId; cur = 1; }
      if (cur > bestTenure) bestTenure = cur;
    }
    m *= 1 + Math.min(0.18, 0.015 * Math.max(0, bestTenure - 8));
  }
  if (blessings.includes("sharpshooter")) m *= 1 + Math.min(0.18, 0.001 * careerGoals);
  if (blessings.includes("comeback")) m *= 1 + Math.min(0.12, 0.02 * Math.max(0, retireAge - 33));
  if (blessings.includes("ironman")) m *= 1 + Math.min(0.08, 0.01 * Math.max(0, retireAge - 30));
  return m;
}

/** The live career-end evaluation (scoreLegacy) of the run SO FAR — the SAME
 *  formula that settles the run at retirement, recomputed each period so the
 *  in-play 传承 number always matches the summary. Legacy is a career-end
 *  evaluation accumulated across runs; it is NEVER granted by events. */
export function liveLegacy(state: GameState): number {
  const seasons = state.seasons;
  const careerWageTotal = seasons.reduce((s, x) => s + (x.wage ?? 0), 0);
  const finalMarketValue = seasons.length > 0 ? (seasons[seasons.length - 1]!.marketValue ?? 0) : 0;
  const careerGoals = seasons.reduce((s, x) => s + x.stats.goals, 0);
  const careerAssists = seasons.reduce((s, x) => s + x.stats.assists, 0);
  const careerCleanSheets = seasons.reduce((s, x) => s + x.stats.cleanSheets, 0);
  const paceMult = state.pace === "express" ? 0.85 : 1;
  const blessings = state.blessings ?? EMPTY_BLESSINGS;
  const earnMult = legacyEarnMult(blessings, state.permPerks ?? EMPTY_PERKS)
    * blessingShapeMult(seasons, careerGoals, state.player?.age ?? 16, blessings);
  return scoreLegacy(
    state.maxOverall, seasons.length, state.trophies, state.awards,
    state.ascension, state.retirementReason, state.challenge,
    careerWageTotal, finalMarketValue, 0, earnMult, paceMult,
    state.player?.position, careerGoals, careerAssists, careerCleanSheets,
  );
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
 *  宿命时刻例外（research/single-option-events-design.md 方案 B）：单选且
 *  `fate` 的事件是 legendary 高光时刻（决赛绝杀/门将奇迹…），其
 *  resolve 内 roll(p) 是一笔大额 legacy 赌注。这类「那一刻只能冲」的瞬间
 *  是 ink 的 gather——结果有概率，但选择是宿命表达。保留抉择台让玩家看见
 *  这唯一选项自己的成功率（每个选项的 sub 只展示该选项的 %，没有事件级
 *  概率），单选+宿命标签让玩家与真二选一抉择台区分（“宿命时刻”而非
 *  “假抉择 bug”）。 */
function toDecisionOrFlavor(ev: FiredEvent | null, ctx: EventContext, seed: string): FiredEvent | FlavorResult | null {
  if (!ev) return null;
  // 单选且非宿命 → 静默 flavor（纯叙事/被动事件，ink fallback）
  // 单选但宿命 → 保留抉择台，选项自带成功率（ink gather）
  if (ev.event.choices.length === 1 && !ev.event.fate) {
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
  windowDue: boolean,
  underperformDue: boolean,
  stateTournamentOffset = 0,
  careerEventsSeen: readonly string[] = EMPTY_SEEN,
  rival?: Rival,
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
    // per-career anti-repeat: pool events already fired this run (P-VAR) —
    // rollRandomEvent excludes them so the same story event never repeats.
    seenEvents: careerEventsSeen,
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

  // relegation loyalty: if the player's club was just relegated. The
  // relegation_endured tag keeps a yo-yo club from asking every other season.
  // ONE-SHOT WINDOW (lastSeasonRelegated is true for exactly one period), so
  // it stays ABOVE the career plan — a plan slot must not swallow it.
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
  // Contextual 触发——球员够强被征召 + 主力 + 尚未退出会籍，每期 10%
  // 概率门（P-VAR: 15% → 10% —— 它是剧情入口，不该是每生涯 ~1 次的
  // 重复决策；降频把决策位让给事件池）。一个生涯期望触发 ~2 次。
  if (!ctx.statusTags.includes("intl_retired")
      && !ctx.statusTags.includes("naturalized")
      && (role === "starter" || role === "high_rotation")
      && player.overall >= (CALLUP_THRESHOLD[clamp(nationById(player.nationalityId).intlRep, 0, 5)] ?? 70)
      && chance(derive(seed, "nt-conflict", player.age, periodIndex), 0.1)) {
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
          // pp_boss_slayer (+10%) and 大赛型选手 big_game_player (+25%) boss good odds.
          if (permPerks.includes("pp_boss_slayer")) odds = clamp(odds + 0.1, 0.01, 0.95);
          if (blessings.includes("big_game_player")) odds = clamp(odds + 0.25, 0.01, 0.95);
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
          // pp_boss_slayer (+10%) and 大赛型选手 big_game_player (+25%) boss good odds.
          if (permPerks.includes("pp_boss_slayer")) qOdds = clamp(qOdds + 0.1, 0.05, 0.95);
          if (blessings.includes("big_game_player")) qOdds = clamp(qOdds + 0.25, 0.05, 0.95);
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
            // pp_boss_slayer (+10%) and 大赛型选手 big_game_player (+25%) boss good odds.
            if (permPerks.includes("pp_boss_slayer")) odds = clamp(odds + 0.1, 0.01, 0.95);
            if (blessings.includes("big_game_player")) odds = clamp(odds + 0.25, 0.01, 0.95);
            odds = clamp(odds, 0.01, 0.95);
            return worldCupShowdown(climaxAgeThisPeriod, odds, "世界杯冠军", "功亏一篑", blessings, nation.name);
          }
        }
      }
    }
  }
  // 宿敌决战: the career-long rival's head-to-head duel — a CLUB-level climax
  // that gives the passive rival measuring stick teeth. Fires once near the
  // peak (age 27-29, a 3-year window so a benched/injured 28-year-old can still
  // catch it at 29), when the player is actually on the pitch (starter/high
  // rotation) and decent (OVR≥70). The rival plateaus at 88 at 26-30, so the
  // odds are driven by the player's OVR vs 88 — a 92 star is the favorite, an
  // 80 player the underdog. Earned, not assured (no tag → never fired). A
  // national climax this period outranks it (WC > club), so it slots between
  // the national block and the decisive penalty.
  const bareTags2 = ctx.statusTags;
  if (rival && !bareTags2.includes("rival_duel_done")) {
    const duelAge = seasonAges.find((a) => a >= 27 && a <= 29);
    if (duelAge !== undefined && (role === "starter" || role === "high_rotation") && player.overall >= 70) {
      // odds from the player's OVR vs the rival's peak (88): 88→50%, 92→60%,
      // 84→40%, 80→30%, 76→20%, floored at 15%. A genuine duel, not a coin flip.
      let odds = clamp(0.50 + (player.overall - 88) * 0.025, 0.15, 0.62);
      // 诸神黄昏 (ascension 5): −30%; 天命难违 (ascension 6): −10%.
      if (ascension >= 5) odds *= 0.7;
      if (ascension >= 6) odds *= 0.9;
      // pp_boss_slayer (+10%) and 大赛型选手 big_game_player (+25%) boss good odds.
      if (permPerks.includes("pp_boss_slayer")) odds = clamp(odds + 0.1, 0.01, 0.95);
      if (blessings.includes("big_game_player")) odds = clamp(odds + 0.25, 0.01, 0.95);
      odds = clamp(odds, 0.05, 0.95);
      const rivalClubName = (() => { try { return clubById(rival.clubId).name; } catch { return "宿敌的球队"; } })();
      return rivalShowdown(duelAge, odds, rival.name, rivalClubName, blessings);
    }
  }
  // decisive penalty: a starter at a peak age that fell this period. Fires at
  // the FIRST eligible age (21 or 25) and never again — the decisive_done@99
  // tag (set on resolve) makes the penalty a once-per-career boss beat, not a
  // fixture at both ages (P-VAR: the player was meeting it ~every career).
  const dpAgeThisPeriod = seasonAges.find((a) => (a === 21 || a === 25));
  if (dpAgeThisPeriod !== undefined && role === "starter" && player.overall >= 75
      && !ctx.statusTags.includes("decisive_done")) {
    let odds = 0.55;
    if (ascension >= 6) odds *= 0.9;
    // pp_boss_slayer (+10%) and 大赛型选手 big_game_player (+25%) boss good odds.
    if (permPerks.includes("pp_boss_slayer")) odds = clamp(odds + 0.1, 0.01, 0.95);
    if (blessings.includes("big_game_player")) odds = clamp(odds + 0.25, 0.01, 0.95);
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
  // stream a replayer can't game from other rolls. The fresh_contract tag
  // (set on 降档续约) pauses the roll for its TTL — the body question waits
  // for the new contract to run down (P-VAR).
  if (player.age >= RETENTION_START && !ctx.statusTags.includes("fresh_contract")) {
    const r = derive(seed, "retention", player.age, periodIndex);
    const prob = retentionProb(player.overall, player.age, club, ctx.statusTags, severeInjuries, blessings, permPerks);
    if (!chance(r, prob)) {
      return noOffersEvent(ctx);
    }
  }

  // Transfers are the SPINE of the career (design: 转会独立于事件，作为核心催化
  // 剂). The reference game (Copero) makes the transfer window the most common
  // decision and a career naturally spans ~7 clubs — the流浪轨迹 itself is the
  // story. So the window is a hard, AGE-based cadence (the prior period-based
  // one opened ~4 windows at 标准 pace and 0 at 速通 — transfers felt rare and
  // the player couldn't climb). A window opens every 2 SEASONS of career age
  // through the prime years (19/21/23/25/27/29/31, capped — the late career is
  // left to the decline/retirement arc + silent periods), detected by whether
  // the period just simulated a window-age season — so it's pace-independent
  // (沉浸/标准/速通 all see the same ~7 prime windows). It still takes PRIORITY
  // over throne/blockbuster/loan/plan/random; only rare peaks (climax
  // WC/continental) and emergencies (medical/injury) outrank a due window, and
  // the rollover (below) defers an eaten window to next period so those
  // collisions never starve the flow. 飞升 8 转会冻结 slows the cadence to every
  // 5 seasons so the freeze still bites.
  // injury roll (P-B1, diverges from 母本 Qr's 2-injury cap): an ACL doesn't
  // wait for the transfer window. Hoisted above the transfer cadence so the
  // injury rate isn't silently eaten by higher-priority events (pre-hoist MC:
  // 0 medical retirements in 2000 runs). Climax/WC events above still outrank
  // it — injury_before_tournament covers that story with actual agency.
  const injuryEv = rollInjuryEvent(ctx);
  const injuryR = toDecisionOrFlavor(injuryEv, ctx, seed);
  if (injuryR) return injuryR;

  // 豪门扫地出门 (你的数据配不上这家球队): a starter/high-rotation player at a
  // big club (rep≥6) whose current consecutive starter run trailed the club's
  // standard (shouldTriggerUnderperformance, computed in simulatePeriod). The
  // engine had no way to push a 主力 out for poor form — only bench players got
  // 不再续约, only 33+ bodies got 无人问津. This is the missing 豪门无情 pressure
  // (参考: 皇马无情). The rep-scaled bar (no trophy exemption — being carried
  // to a title doesn't save a poor campaign) lives in the trigger. Placed
  // ABOVE the career plan and transfer window: a club-forced departure is more
  // urgent than a routine window or a scheduled story — the window rolls over
  // via transferWindowOwed, the plan slot defers to next period, neither is
  // lost. Role-disjoint with contract_nonrenewal (bench only); a failed
  // 证明自己 drops the role to low_rotation, feeding the contract_nonrenewal
  // cascade (bench → 不再续约) next period. underperformed@4 is the anti-repeat.
  if (underperformDue && player.age >= 21 && player.age <= 32
      && (role === "starter" || role === "high_rotation")
      && !ctx.statusTags.includes("underperformed")) {
    const ur = toDecisionOrFlavor(fireEventByKey(ctx, "underperform_release"), ctx, seed);
    if (ur) return ur;
  }

  // career event plan (母本 ma): if a slot age is due, fire a scheduled event.
  // P-VAR (event-variety pass): sits ABOVE the transfer window and BELOW
  // medical/post_loan/climax/relegation/retention/injury. The transfer-spine
  // cadence (19-31 every 2 seasons) ate ~3.5 decisions/career at the default
  // pace and starved the 176-event pool to ~1.3 beats/career (MC); hoisting
  // the plan here lets the story spine fire FIRST — a due window it displaces
  // DEFERS via transferWindowOwed (never cancels), so transfers stay a hard
  // cadence, just one period later. Slots start at 16 (was 22+) so the youth
  // phase (16-21) hosts the early slots and surfaces youth events that were
  // dead content at the default pace. A slot eaten by a higher priority
  // event carries over (findAvailableSlot matches s <= age); only the LAST
  // slot can starve if the career ends first.
  if (plan && player.age <= 37) {
    const slot = findAvailableSlot(plan, player.age);
    if (slot !== null) {
      ctx.slotAge = slot;
      const r = toDecisionOrFlavor(rollRandomEvent(ctx), ctx, seed);
      if (r) return r;
    }
  }

  // Transfer window fires when DUE this period — the age-based cadence landed
  // on a just-simulated season, OR a previous window was eaten by a higher-
  // priority event and rolled over (windowDue carries transferWindowOwed). The
  // wage-squeeze check + transferEvent below are unchanged; the orchestrator
  // (simulatePeriod) re-sets the owed flag if a peak/medical/retention event
  // ABOVE this block overrode the due window — so a colliding climax DEFERS the
  // window to next period, never cancels it. This is the "transfers independent
  // of events" guarantee: the cadence is a hard schedule.
  if (windowDue) {
    // P-RETIRE: wage squeeze — a 伤仲永 whose locked-in wage is far above his
    // current market value. No club will match his pay; offers become pay cuts
    // + a 挂靴 option. The 24yo-peak €2000万 → OVR-crash → 27-retires arc is
    // ECONOMIC, not random: his wage prices him out of the game. Pure
    // arithmetic trigger (no rng); offers reuse the transfer derive streams.
    // lastWage is reconstructed from last season's market value at the current
    // club/league (wage was computed from that season's MV) so the rebuild
    // after a refresh is deterministic.
    const lastMv = recentMarketValue;
    const lastWage = lastMv > 0 ? computeWage(lastMv, player.overall, league, club) : 0;
    const squeezeRole = resolveRole(player.overall, club, player.position === "GK");
    const fairMv = computeMarketValue(player.overall, player.age, league, club, squeezeRole, null, 0, false);
    const fairWage = computeWage(fairMv, player.overall, league, club);
    if (lastWage > 0 && fairWage > 0 && lastWage > fairWage * WAGE_SQUEEZE_RATIO) {
      return wageSqueezeEvent(ctx);
    }
    return transferEvent(ctx);
  }

  // 母本 contextual events: contract non-renewal (age 26+, bench role). The
  // contract_crisis tag (set on resolve, long TTL) is the anti-repeat guard —
  // without it a benched veteran refires this every period. Below the
  // retention roll (its original spot was even higher; P-VAR keeps it here so
  // the 33+ bench veteran still lands in no_offers when the body is gone).
  if (player.age >= 26 && (role === "substitute" || role === "low_rotation")
      && !ctx.statusTags.includes("contract_crisis")) {
    const nr = toDecisionOrFlavor(fireEventByKey(ctx, "contract_nonrenewal"), ctx, seed);
    if (nr) return nr;
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
  // the "moved to a giant too early" fork the user wants). Gated to big clubs
  // (rep≥5): a small club plays its bench, it doesn't loan them out
  // (inauthentic); only a deep-squad giant loans a youngster out for
  // development (Chelsea loan army, Castilla → loan). Higher gate than before
  // (0.85/0.55) because a big club WANTS to loan out a bench youngster — it's
  // the expected path, not a rare offer. Below transfer window (a permanent
  // move is a bigger career beat) and injury/climax (those outrank
  // everything); the career plan outranks it (P-VAR) — a guaranteed story
  // slot beats an optional development detour.
  if (!completedLoan && (role === "substitute" || role === "low_rotation" || role === "third_keeper")
      && player.age >= 18 && player.age <= 24 && club.rep >= 5) {
    const loanProb = role === "low_rotation" ? 0.55 : 0.85;
    if (chance(derive(seed, "loan-offer", player.age, periodIndex), loanProb)) {
      return loanOfferEvent(ctx);
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
  // 雇佣兵: the opposite of loyal_club — strip loyalStay so the stay-streak
  // never accrues (no club_legend tag, the journeyman identity). Legacy is no
  // longer an event reward, so there's no legacy to strip here.
  if (blessings.includes("mercenary") && finalMods.loyalStay) {
    finalMods = { ...finalMods, loyalStay: false };
  }
  // Mechanics review: loyalty streak — the 3rd consecutive stay marks the
  // player a club legend (club_legend@99, effectively permanent), the stay
  // option's counterweight to the transfer flow's trophy-tier upgrade. Legacy
  // is a career-end evaluation now, so the streak no longer grants legacy
  // points — only the club_legend identity tag. Runs THROUGH the mercenary
  // strip above, so mercenaries never accrue a loyalty track.
  const prevStay = state.stayStreak ?? 0;
  const stayStreak = (isPermanentMove || mods.loanOutTo) ? 0
    : finalMods.loyalStay ? prevStay + 1 : prevStay;
  if (finalMods.loyalStay && stayStreak === 3) {
    finalMods = { ...finalMods, addTags: [...(finalMods.addTags ?? []), ttlTag("club_legend", 99)] };
  }
  // P-A33: log the key choice for the summary "抉择回顾" — skip plain transfers
  // (they're already in the club timeline) but record every narrative event.
  const isNarrativeEvent = ev.key !== "transfer" && ev.key !== "loan_offer" && ev.key !== "post_loan" && ev.key !== "blockbuster_offer";
  const choiceLog = isNarrativeEvent && outcome
    ? [...(state.choiceLog ?? EMPTY_CHOICE_LOG), { age: state.age, title: ev.title, choice: choice.text, outcome, good: !!good }]
    : (state.choiceLog ?? EMPTY_CHOICE_LOG);
  // P-VAR: per-career anti-repeat — record every fired event key so
  // rollRandomEvent never shows the same pool story twice in one career.
  const careerEventsSeen = ev.eventKey
    ? [...(state.careerEventsSeen ?? EMPTY_SEEN), ev.eventKey]
    : (state.careerEventsSeen ?? EMPTY_SEEN);
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
    careerEventsSeen,
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
  // 传承 = 生涯末评价（scoreLegacy），不再由事件直接给出。liveLegacy 统一结算
  // （含 loyal_club 一人一城奖励），故 finalizeRun 不再在此加减任何传承分。
  return {
    ...state,
    currentClubId,
    currentLeagueId,
    seasons,
    trophies,
    awards,
    maxOverall,
    legacy: liveLegacy({ ...state, currentClubId, currentLeagueId, seasons, trophies, awards, maxOverall, player, retirementReason: finalReason }),
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
  const bossOdds = ev.bossOdds ?? 0.5;
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
    case "rival_showdown": {
      // 宿敌决战 — reconstruct from the stashed rival identity + age. The
      // rival object isn't on the EventContext (events.ts stays rival-free
      // except for this builder), so read it from the pending event payload.
      const rs = ev.rivalShowdown;
      return rivalShowdown(rs?.age ?? player.age, bossOdds, rs?.rivalName ?? "宿敌", rs?.rivalClubName ?? "宿敌的球队", blessings).resolve;
    }
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
  return finalizeRun(state, state.currentClubId, state.currentLeagueId, state.seasons, state.trophies, state.awards, state.maxOverall, state.player, "voluntary");
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
  "mentor_legend", "compromised_body", "intl_retired", "rival_slayer",
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
  else if (s.trophies.length === 1) {
    const t0 = s.trophies[0]!;
    // national trophies belong to the country, not the club — 「随国家队拿下」,
    // not「随[club]拿下」(a World Cup is not won with West Ham).
    text = (t0 === "world_cup" || t0 === "national_continental")
      ? `${s.age}岁随国家队拿下${BEAT_TROPHY_NAME[t0]}。`
      : `${s.age}岁随${s.clubName}拿下${BEAT_TROPHY_NAME[t0]}。`;
    tone = "good";
  }
  else if (s.relegated) { text = `${s.age}岁${s.clubName}惨遭降级，至暗时刻。`; tone = "bad"; }
  else if (s.role === "substitute" && ovr >= 75) { text = `${s.age}岁在${s.clubName}坐穿板凳，才华虚耗。`; tone = "bad"; }
  else if (s.stats.goals >= 25) { text = `${s.age}岁轰入${s.stats.goals}球，射手本能爆发。`; tone = "good"; }
  else if (ovr >= 90 && player.overall < ovr) { text = `${s.age}岁OVR突破${ovr}，跻身历史级。`; tone = "legendary"; }
  else if (s.role === "starter" && ovr >= 85 && player.overall < ovr) { text = `${s.age}岁在${s.clubName}坐稳主力，巅峰渐至。`; tone = "good"; }
  else return beats; // quiet season — no beat
  return [...beats, { age: s.age, season: seasonNum, text, tone }];
}

/** P-NAT: a national-team narrative beat — the parallel national storyline's
 *  milestones, appended alongside the club beats so the feed carries BOTH
 *  careers. At most one national beat per season (the most significant national
 *  event); a champion trophy is skipped (appendSeasonBeats already recorded
 *  the 「捧起世界杯」 moment). */
function appendNationalBeat(beats: readonly CareerBeat[], s: SeasonResult, prev: SeasonResult | undefined, seasonNum: number): readonly CareerBeat[] {
  const nat = s.national;
  if (!nat) return beats;
  if (nat.tournament?.trophy) return beats; // champion — already a club beat
  const prevStatus = prev?.national?.status;
  const prevCalledUp = prev?.national?.calledUp ?? false;
  if (nat.status === "captain" && prevStatus !== "captain") {
    return [...beats, { age: s.age, season: seasonNum, text: `${s.age}岁戴上国家队队长袖标，扛起祖国旗帜。`, tone: "legendary" }];
  }
  if (nat.tournament?.stage === "亚军") {
    return [...beats, { age: s.age, season: seasonNum, text: `${s.age}岁随国家队杀入决赛惜获亚军，虽败犹荣。`, tone: "good" }];
  }
  if (nat.status === "debut" && !prevCalledUp) {
    return [...beats, { age: s.age, season: seasonNum, text: `${s.age}岁首次入选国家队！身披祖国战袍。`, tone: "good" }];
  }
  if (nat.tournament?.stage === "四强") {
    return [...beats, { age: s.age, season: seasonNum, text: `${s.age}岁随国家队杀入四强，举国沸腾。`, tone: "good" }];
  }
  return beats;
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
