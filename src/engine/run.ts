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
  CLUBS, CALLUP_THRESHOLD, YOUTH_LOAN_MAX_AGE,
} from "./data";
import {
  resolveRole, simSeasonStats, clubTrophyCandidates, simulateNational,
  rollAwards, growthDelta, computeMarketValue, computeWage, computeSeasonRating,
  retentionProb, applyCeiling, RETENTION_START, MAX_AGE, FAME_BID_OVR, FAME_OFFER_OVR,
  type NationalContext,
} from "./sim";
import {
  rollRandomEvent, rollInjuryEvent, transferEvent, loanOfferEvent,
  postLoanEvent, blockbusterOfferEvent, doctorWarningEvent, medicalVerdictEvent,
  worldCupShowdown, worldCupQualifierShowdown, continentalCupShowdown,
  fireEventByKey, resolveEventOption,
  noOffersEvent, wageSqueezeEvent, fameLeagueBidEvent, retirementCeremonyEvent,
  POOL_CLUB_MOVE_KEYS,
  type EventContext, type FiredEvent,
} from "./events";
import type {
  GameState, Player, SeasonResult, Trophy, Award, Role, Choice, Modifiers,
  CareerEventPlan, CareerEvent, Challenge, CareerBeat, Milestone, ChoiceLogEntry, ResolveFn,
} from "./types";
import { trophyMult } from "./types";
import { rollDevProfile, scoreLegacy } from "../meta/legacy";

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
 *  slows the cadence to every 5. 阶段三起转会走独立 T 通道——黄金期到期即弹、
 *  不再被特殊事件挤兑（特殊事件走 S 通道与之并存排队），故不再需要顺延。 */
const TRANSFER_WINDOW_START_AGE = 19;
const TRANSFER_WINDOW_END_AGE = 31;
const transferWindowCadence = (ascension: number): number => (ascension >= 8 ? 5 : 2);
function isTransferWindowAge(seasonAges: readonly number[], ascension: number): boolean {
  const cadence = transferWindowCadence(ascension);
  return seasonAges.some(
    (a) => a >= TRANSFER_WINDOW_START_AGE && a <= TRANSFER_WINDOW_END_AGE && (a - TRANSFER_WINDOW_START_AGE) % cadence === 0,
  );
}

// 池事件中「转会类」的 key 见 events.ts 的 POOL_CLUB_MOVE_KEYS（已导出在此 import）。
// 抽到转会类故事 → 走 T 通道（替代/补充常规转会窗），避免与转会窗的 newClubId 冲突；
// 非转会类故事 → 走 S 通道（与转会并存，用户诉求：转会与故事共存不互斥）。

/** 合并两个 Modifiers（队列跨决策累积）：数值类相加，倍率类相乘，override/
 *  newClubId/roleOverride 等「后者为准」类取 b（b 是更晚 resolve 的决策），
 *  addTags 拼接，suspended 取或。转会通道(T)是队列中较晚 resolve 的决策，
 *  其 newClubId/loyalStay/loanOutTo 权威；特殊事件(S)的 forceTrophy/roleOverride
 *  在 T 未覆盖时保留。forceRetire 由 resolveChoice 的短路单独处理。 */
function mergeMods(a: Modifiers, b: Modifiers): Modifiers {
  if (!a) return { ...b };
  if (!b) return { ...a };
  const sum = (x?: number, y?: number) => (x ?? 0) + (y ?? 0);
  const prod = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 1) * (y ?? 1));
  const either = (x?: boolean, y?: boolean) => (x ?? false) || (y ?? false);
  const last = <T>(x: T | undefined, y: T | undefined): T | undefined => y ?? x;
  return {
    immediateOverallDelta: sum(a.immediateOverallDelta, b.immediateOverallDelta) || undefined,
    permanentOverallDelta: sum(a.permanentOverallDelta, b.permanentOverallDelta) || undefined,
    deferredOverallDelta: sum(a.deferredOverallDelta, b.deferredOverallDelta) || undefined,
    statsMultiplier: prod(a.statsMultiplier, b.statsMultiplier),
    roleShift: sum(a.roleShift, b.roleShift) || undefined,
    roleOverride: last(a.roleOverride, b.roleOverride),
    suspended: either(a.suspended, b.suspended) || undefined,
    leagueTrophyMult: prod(a.leagueTrophyMult, b.leagueTrophyMult),
    continentalTrophyMult: prod(a.continentalTrophyMult, b.continentalTrophyMult),
    leagueTrophyProbabilityMultiplier: prod(a.leagueTrophyProbabilityMultiplier, b.leagueTrophyProbabilityMultiplier),
    domesticCupTrophyProbabilityMultiplier: prod(a.domesticCupTrophyProbabilityMultiplier, b.domesticCupTrophyProbabilityMultiplier),
    continentalPrimaryTrophyProbabilityMultiplier: prod(a.continentalPrimaryTrophyProbabilityMultiplier, b.continentalPrimaryTrophyProbabilityMultiplier),
    continentalSecondaryTrophyProbabilityMultiplier: prod(a.continentalSecondaryTrophyProbabilityMultiplier, b.continentalSecondaryTrophyProbabilityMultiplier),
    clubWorldCupTrophyProbabilityMultiplier: prod(a.clubWorldCupTrophyProbabilityMultiplier, b.clubWorldCupTrophyProbabilityMultiplier),
    clubTrophyOverride: last(a.clubTrophyOverride, b.clubTrophyOverride),
    nationalTrophyOverride: last(a.nationalTrophyOverride, b.nationalTrophyOverride),
    worldCupResultOverride: last(a.worldCupResultOverride, b.worldCupResultOverride),
    nationalTournamentParticipation: last(a.nationalTournamentParticipation, b.nationalTournamentParticipation),
    nationalTournament: last(a.nationalTournament, b.nationalTournament),
    forceTrophy: last(a.forceTrophy, b.forceTrophy),
    loyalStay: last(a.loyalStay, b.loyalStay),
    newClubId: last(a.newClubId, b.newClubId),
    newNationalityId: last(a.newNationalityId, b.newNationalityId),
    loanOutTo: last(a.loanOutTo, b.loanOutTo),
    loanReturnAge: last(a.loanReturnAge, b.loanReturnAge),
    addTags: [...(a.addTags ?? []), ...(b.addTags ?? [])],
    forceRetire: either(a.forceRetire, b.forceRetire) || undefined,
    forceRetireReason: last(a.forceRetireReason, b.forceRetireReason),
  };
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
  // golden_boy: 天才少年直接以主力级起步 (50 → 58, +8)；无传承溢价——
  //   起跑优势本身即是全部收益。俱乐部发展天花板会自然约束：弱旅青训营
  //   (rep 0/1 天花板 ~64-71) 会限速逼其转会爬升, 不会直接冲到 99。
  // pp_prodigy: +8 (与金童取高, 不叠加 → 最高 58)。BAL-GROWTH: 旧值 +12 叠加
  //   到 70, 20 OVR 在 16 岁 baked-in、成长兜底再 +24 即到 94——95 聚集的起跑
  //   通胀元凶。perk 的价值在「跨生涯永久常驻」(祝福每局重购), 不在单局更大;
  //   与金童同量级 + 不叠加, 起始最高 58, 把 12 OVR 的免费 headroom 还给事件选择。
  let startOvr = START_OVR;
  if (blessings.includes("golden_boy")) startOvr += 8; // 50 → 58
  if (permPerks.includes("pp_prodigy")) startOvr = Math.max(startOvr, START_OVR + 8);
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
    // 告别仪式: a forced retirement that fired the farewell event stamps a
    // farewell_* tag onto its mods; thread the chosen style into finalizeRun
    // so the summary shows the player's own way to say goodbye (the soft 挂靴
    // / medical / narrative retirements carry no such tag → undefined).
    const farewellStyle = farewellStyleFromTags(mods0.addTags);
    return finalizeRun(state, state.currentClubId, state.currentLeagueId, state.seasons, state.trophies, state.awards, state.maxOverall, state.player, reason, farewellStyle);
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
  // P-ENDGAME split: immediate vs permanent OVR deltas now have DIFFERENT
  // semantics — demanded by the two hero metrics (巅峰总评 + 荣誉). The club
  // development ceiling represents the CLUB's training capacity:
  //  - immediateOverallDelta: club-environment fluctuation → ceiling-BOUND.
  //    A transient bump a club can (or can't) support; respects potential.
  //  - permanentOverallDelta: career-defining BET — the player transcends the
  //    club (Maradona at Napoli, a coach gamble that pays off, the WC final
  //    decided on your own boot). Ceiling-EXEMPT: this is the lever an
  //    aggressive + lucky career uses to reach 99. Growth + immediate keep
  //    the median ~85 and ≥95 rare; permanent events are the path past the
  //    cap to 99 (hero metric #1: 巅峰总评). Negatives pass through unchanged
  //    (decline is never scaled — a star who transfers down keeps his level).
  const imm = mods.immediateOverallDelta ?? 0;
  const perm = mods.permanentOverallDelta ?? 0;
  if (imm !== 0 || perm !== 0) {
    const cappedImm = imm > 0 ? applyCeiling(imm, player.overall, club) : imm;
    let newOvr = clamp(player.overall + cappedImm, 40, 99);
    maxOverall = Math.max(maxOverall, newOvr);
    // permanent: ceiling-EXEMPT — can push the career peak (maxOverall) to 99.
    newOvr = clamp(newOvr + perm, 40, 99);
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
      // 大器晚成: delay the age-30 decline onset by one cycle (2 yrs) so the
      // post-25 bloom has room to work before the decline curve pulls the
      // career back — without this the bloom amplified a base that was already
      // declining, so the blessing was an active trap.
      + (blessings.includes("late_bloomer") ? 1 : 0);
    let delta = growthDelta(rng, player, season.role, club, league, state.ascension, declineDelay);
    // pp_scout (青训球探): elite academy coaching — +1 growth per cycle before 20.
    //   BAL-SHAPE: 旧值每个周期 +1, 4 个青训周期叠加 ≈ +4, 是 meta 玩家把 90+ 做成
    //   「近必然」(74%) 的复利之一。改为 +0.5→Math.round 抹平偶期增益, 收窄优化玩法
    //   顶端而不动地板(perk 仅 meta 玩家有)。perk「永久常驻」价值仍在, 但不再独交 4 OVR。
    if (state.permPerks?.includes("pp_scout") && player.age < 20) delta += 0.5;
    // 玻璃大炮: +40% growth (the payoff for ×3 injuries). BAL-SHAPE: ×1.5→×1.4——
    //   +50% 在优化玩法下复利堆顶, +40% 仍保留「高风险高回报成长流」身份但顶端收窄。
    if (blessings.includes("glass_cannon")) delta = Math.round(delta * 1.4);
    // 大器晚成: a survivable slow start (×0.9 before 25 — was ×0.5 then ×0.8,
    // both of which stalled the prime-years accumulation enough that even a
    // full OVR recovery left the career with fewer trophies/wages/awards from
    // the 16-24 window, netting −44 legacy vs base — an active trap at 105 cost).
    // ×0.9 keeps the "slow burn" identity (you ARE weaker early) while leaving
    // enough prime-years production that the post-25 bloom (×2.0, positive only)
    // + decline-delay turns it net-positive. The bloom multiplies POSITIVE growth
    // only — was `Math.round(delta * 1.5)` which also scaled NEGATIVE deltas, so
    // the "bloom" amplified the age-30+ decline and killed the career the moment
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
    // 评分↔成长闭环: this season's rating modulates NEXT season's growth —
    // 踢得好(≥8.0)→+1 (信心足、机会多), 踢不出来(<6.3)→-1 (挣扎中停滞). Only on
    // GROWTH (delta>0): a decline-season's low rating is age, not stagnation —
    // don't double-punish a fading veteran. 0-app/injured seasons (rating null)
    // are skipped — grace, same as the forced-exit run. ±1 is a modest modulation
    // beside the starter training bonus; the ceiling below still binds, so
    // "stay at a weak club farming 8.0" can't climb past the club's potential —
    // transferring up stays the real growth path. This closes the loop the
    // forced-exit trigger needed: 评分低→不涨→继续低→被送走→降到弱队→重新高于
    // 基准→评分回血→恢复上涨 (self-correcting, not a death spiral).
    const sr = season.rating;
    if (delta > 0 && sr != null) {
      if (sr >= 8.0) delta += 1;
      else if (sr < 6.3) delta -= 1;
    }
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
  // BAL-GROWTH: 但回血现封顶 maxOverall（球员自己的生涯巅峰），非俱乐部天花板——
  //   抗衰退（回到巅峰）而非堆顶（越过巅峰）。旧值不封顶让 95→99 堆成众数（实测
  //   meta 玩家 96-99 占 25%）；封 maxOverall 后回血只补回已下滑的 OVR、永不创新
  //   高，95→99 堆积封死，巅峰仍由成长+事件决定。主题「浴火重生」= 守住巅峰。
  //
  // 永久 perk > 祝福: pp_comeback_base (涅槃基线) 被 foldPerksIntoBlessings
  //   折叠成 comeback id, 故 blessings.includes("comeback") 同时命中祝福与 perk.
  //   这里按来源分流: 有 perk → 50% 回血 +2 (强于祝福); 仅有祝福 → 25% 回血 +1 (原
  //   40% 回血 +1, 削弱). 互斥取高 (perk 接管), 不双 roll → 叠加仅 perk 值, 不更变态.
  //   perk 的 retention (+0.10) / shape (+12%) 副作用仍由折叠的 comeback id 在 sim.ts
  //   供给, 这里只调回血 roll 本体.
  if (blessings.includes("comeback") && player.age >= 30) {
    const hasComebackPerk = (state.permPerks ?? EMPTY_PERKS).includes("pp_comeback_base");
    const procProb = hasComebackPerk ? 0.40 : 0.25;
    const regen = hasComebackPerk ? 1 : 1;  // perk/祝福 都回血 +1 (旧 perk 50%×+2, 期望 +1/决策, 是 meta 堆顶主因)
    const r = derive(seed, "comeback", player.age, periodIndex);
    if (chance(r, procProb)) {
      // BAL-GROWTH: 回血封顶 maxOverall——只「回到」生涯巅峰、不超越。抗衰退而非
      //   堆顶: 50%×+2×~8 衰退季 ≈ 期望 +8, 旧值不封顶把 95→99 堆成众数; 封顶后回血
      //   仅在已从巅峰下滑时补回, 永不越过既有巅峰, 95→99 堆积封死。
      const newOvr = Math.min(clamp(player.overall + regen, 40, 99), maxOverall);
      player = { ...player, overall: newOvr };
      maxOverall = Math.max(maxOverall, newOvr);
    }
  }

  // check retirement triggers — a forced retirement (OVR floor / age
  // ceiling) no longer ends the run abruptly. It fires the 告别仪式 farewell
  // event as THIS period's decision: the just-simulated season (the one where
  // the body finally gave / age caught up) plays out, the prior event's verdict
  // shows, then the player chooses how to announce their retirement. The
  // farewell choice sets forceRetire → the next simulatePeriod finalizes, and
  // the store shows the farewell verdict before the summary. Player-requested:
  // 退役也是一个事件，不能按完正常事件就戛然而止、看不到选择的后续。
  let forcedRetireReason: string | null = null;
  if (player.age >= 26 && player.overall < FORCE_RETIRE_OVR) {
    // a PRIME-AGE body wrecked by repeated severe injuries is an injury
    // retirement even before the 3rd-strike verdict — but a 34+ fade-out with
    // old scars is just ageing, not tragedy. Otherwise flavor by peak.
    forcedRetireReason = (state.severeInjuries ?? 0) >= 2 && player.age <= 33 ? "injury"
      : maxOverall >= 85 ? "faded" : "no_offers";
  } else if (player.age >= MAX_AGE) {
    // P-RETIRE: the hard ceiling is the authored safety net — the soft
    // retention roll (buildPeriodDecisions' T channel) retires almost everyone
    // first. Reaching MAX_AGE means the player kept passing rolls deep into
    // the decline table; the growth-curve fallback at 44+ is so steep the roll
    // would fail next period anyway.
    forcedRetireReason = "age";
  }

  // build the decision at period end
  let pendingMods: Modifiers = EMPTY_MODS;
  const blockbusterTier = state.blockbusterOfferedTier;
  let pendingChoice: GameState["pendingChoice"] = null;
  let pendingResolve: GameState["pendingResolve"] = undefined;
  let pendingChoices: readonly CareerEvent[] = [];
  // P-A8: clubs the player has formerly played at (for "曾效力" transfer tags).
  const formerClubIds = [...new Set(seasons.map((s) => s.clubId))];
  const plan = state.careerEventPlan ?? initCareerPlan(seed, (state.pace ?? "normal") as PaceMode);
  if (forcedRetireReason !== null) {
    // the body's done — the farewell ceremony IS this period's decision. The
    // season where the line was crossed was already simulated above, so the
    // player sees it (and the prior event's verdict) before choosing how to
    // retire. No new season is simulated for the farewell period — the player
    // already retired; this decision is the capstone, not another campaign.
    const farewellCtx: EventContext = {
      player, club, league, seed, age: player.age,
      role: resolveRole(player.overall, club, player.position === "GK"),
      periodIndex, rngState: derive(seed, "farewell", periodIndex),
      blessings, injuriesTaken: state.injuriesTaken ?? 0, ascension: state.ascension,
      statusTags: statusTags.map(tagName), permPerks: state.permPerks ?? EMPTY_PERKS,
      formerClubIds, tournamentOffset: state.tournamentOffset ?? 0,
    };
    const farewell = retirementCeremonyEvent(farewellCtx, forcedRetireReason);
    pendingChoice = farewell.event;
    pendingResolve = farewell.resolve;
    pendingChoices = [];
  } else {
    // 阶段三：双通道决策——转会通道(T)与特殊事件通道(S)独立、可并存。转会
    // 在黄金期按 cadence 固定弹（不再被特殊事件挤兑，故不再有 transferWindowOwed
    // 顺延）；S 与 T 并存排队，队首 resolve 后出队，队列空才推进赛季。
    const rngState = derive(seed, "period-decision", periodIndex);
    // use the JUST-SIMULATED seasons (local), not state.seasons — the stale read
    // made relegation_loyalty react one full period late (and thus never).
    const lastSeasonRelegated = seasons.length > 0 && seasons[seasons.length - 1]!.relegated;
    const recentMarketValue = seasons.length > 0 ? (seasons[seasons.length - 1]!.marketValue ?? 0) : 0;
    // P-RATING: most recent PLAYED season's rating (skip 0-app/injured seasons) —
    // the form signal that steers the voluntary transfer window's offer tier.
    const recentRating = recentPlayedRating(seasons);
    // P-RATING: the SINGLE forced-exit arbiter. A player whose rating stays
    // below the club's standard for ≥2 consecutive played seasons is moved on
    // — 管理层看球员的依据. Computed pure here so buildPeriodDecisions can route
    // the player out of a club where he can't perform. A club change or one
    // good season resets the run.
    const forcedExitDue = shouldTriggerForcedExit(seasons, club);
    const { special, transfer } = buildPeriodDecisions(seed, player, club, league, periodIndex, rngState, state.blessings ?? EMPTY_BLESSINGS, state.injuriesTaken ?? 0, state.ascension, statusTags, lastSeasonRelegated, plan, periodLength, completedLoan, maxOverall, state.blockbusterOfferedTier, state.permPerks ?? EMPTY_PERKS, formerClubIds, recentMarketValue, recentRating, state.severeInjuries ?? 0, !!state.injuryWarned, state.verdictSeenAt ?? 0, forcedExitDue, state.tournamentOffset ?? 0, state.careerEventsSeen ?? EMPTY_SEEN);

    // 阶段三：处理双通道结果。S/T 的 FiredEvent 排队：S 先、T 后。
    // pendingChoice=队首，pendingChoices=队尾，resolve 函数经 rebuildResolve
    // 在出队时重建。单选事件不再自动结算为 flavor——一律走决策台：玩家读
    // 事件背景（desc）、点选项后，outcome 在决策位「结果亮相」一拍展示（与
    // 多选事件同一节奏）。plan/伤病/seen 计数改由 resolveChoice 结账（玩家手
    // 选时），不再在此自动结。
    // 决策队列：S 通道的 FiredEvent（若有）在前，T 通道的 FiredEvent 在后。
    const queue: FiredEvent[] = [];
    if (special !== null) queue.push(special);
    if (transfer !== null) queue.push(transfer);
    if (queue.length > 0) {
      const head = queue[0]!;
      pendingChoice = head.event;
      pendingResolve = head.resolve;
      pendingChoices = queue.slice(1).map((e) => e.event);
    }
    // 队列空 → 静默 period（无决策，自动推进）
    // blockbusterOfferedTier 不在此更新——大片邀约可能排在队尾，build 时即升档会
    // 让 rebuildResolve（出队重建）时 blockbusterOfferEvent 因 offeredTier 已升而返
    // 回 null → 重建出 undefined → 死循环。改为 resolveChoice 中 resolve 时升档。
  }

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
    careerEventPlan: plan,
    blockbusterOfferedTier: blockbusterTier,
    pendingMilestone: milestone,
    milestonesSeen,
    pendingMods,
    pendingChoice,
    pendingResolve,
    pendingChoices,
    careerEventsSeen: state.careerEventsSeen ?? EMPTY_SEEN,
    injuriesTaken: state.injuriesTaken ?? 0,
    severeInjuries: state.severeInjuries ?? 0,
  };
}

/* ───────────────────────────── forced exit (P-RATING) ─────────────────────────────
 *
 * The rating is the SINGLE arbiter of a forced exit — 管理层看球员的依据: a
 * player whose rating stays low season after season doesn't belong at this
 * club, so the club moves him on. ONE trigger replaces the three broken ones
 * the engine had (underperform_release's starter/rep≥6 gate, stuck_release's
 * trophy-exemption bug, contract_nonrenewal's 26+ age gate) — none of which
 * could catch the user's case: a Man Utd academy ST who sat the bench for 16
 * seasons, 0 goals/0 assists, and was NEVER forced out (a carried trophy raised
 * his rating from 6.3 to 6.4, breaking the consecutive-barren run every 2-3
 * seasons — the washout was EXEMPTED by his teammates' titles).
 *
 * The rating (computeSeasonRating) is position-fair (a 合格主力 centers at
 * ≈7.0 across every position via a club-aware baseline), so ONE bar judges a CB
 * and a ST equally, and a carried trophy can lift a season at most +0.5 — a
 * genuinely barren 0G/0A season (≈6.3) stays below the bar even with a trophy,
 * so lying flat on a big club's bench no longer shelters you. Injured/
 * suspended seasons (rating null) are SKIPPED, not counted as poor form — the
 * club gives you grace coming back from injury. A transfer away resets the
 * run (the new club starts a fresh slate). Age 18+ keeps a youth grace window
 * (no 16/17yo is forced out — the academy is for developing). */

/** The club's standard, scaled UP with rep — a big club demands more. A 合格主力
 *  centers at 7.0 everywhere, so the bar sits at 6.7–7.1 (below 7.0 starter) so a
 *  合格主力 passes comfortably while a below-squad starter / bench washout
 *  (≈6.0–6.5) fails. A carried trophy (+0.5 cap) can rescue a borderline 6.6
 *  season but NOT a 6.3 washout — lying flat is no longer sheltered. */
const FORCED_EXIT_BAR_BY_REP: readonly number[] = [6.5, 6.5, 6.6, 6.7, 6.7, 6.8, 6.9, 6.9, 6.9, 6.9, 6.9];
function forcedExitBar(club: Club): number {
  return FORCED_EXIT_BAR_BY_REP[Math.min(club.rep, 10)] ?? 6.7;
}
/** Consecutive below-standard PLAYED seasons at `club`, walking back from the
 *  latest season. Stops at the first passing season, a 0-app/injured season
 *  (skipped, not a break — injury grace), or a club change (transfer resets). */
function belowStandardRun(seasons: readonly SeasonResult[], club: Club): SeasonResult[] {
  const bar = forcedExitBar(club);
  const run: SeasonResult[] = [];
  for (let i = seasons.length - 1; i >= 0; i--) {
    const s = seasons[i]!;
    if (s.clubId !== club.id) break;
    const r = s.rating;
    if (r === null) continue;        // 0-app / injured / farewell — skip (grace)
    if (r === undefined) continue;   // back-compat: season pre-rating — unjudgeable
    if (r < bar) run.unshift(s);
    else break;
  }
  return run;
}
/** The single forced-exit trigger: ≥2 consecutive below-standard played seasons
 *  at this club. Pure, no rng — the resolve roll lives in the event. */
function shouldTriggerForcedExit(seasons: readonly SeasonResult[], club: Club): boolean {
  return belowStandardRun(seasons, club).length >= 2;
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
  // P-RATING: the canonical 综合表现 score is computed from the full season
  // (national stage + awards + relegation feed it too) and persisted as a
  // first-class stat; the SAME number drives market value — one rating, one
  // meaning, no drift between the displayed grade and the economy. Build the
  // season sans market value/wage first (the rating ignores those), rate it,
  // then value it.
  const seasonSansFinance: SeasonResult = {
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
  };
  const rating = computeSeasonRating(seasonSansFinance, player.position, club, league);
  // a 0-app (suspended/farewell) season can't be rated → fall back to 6.0 so
  // the market-value perf multiplier still docks a season you didn't play
  // (matches the pre-rating behavior).
  const perfRating = rating ?? 6.0;
  const marketValue = computeMarketValue(player.overall, player.age, league, effClub, role, perfRating, trophies.length, seasonHonors.includes("mvp"), seasonHonors.includes("toty"));
  const wage = computeWage(marketValue, player.overall, league, effClub);

  return { ...seasonSansFinance, rating, marketValue, wage };
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
  // marketable (商业价值 blessing): +10% (was +25%). Weakened so the same-function
  //   prestige perk (传承磁体) can be the STRONGER of the two — 轮回 (perk) is the
  //   permanent core, 祝福 a temp loadout; 叠加 ×1.375 ≈ 原状 (×1.25 ×1.10), 不更变态.
  if (blessings.includes("marketable")) m *= 1.10;
  // pp_legacy_magnet (传承磁体 perk): +25% (was +10%). Now > 商业价值 (+10%),
  //   ~2.5× the weakened blessing, satisfying perk > blessing.
  if (permPerks.includes("pp_legacy_magnet")) m *= 1.25;
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

// 每个事件都是真抉择（≥2 选项、每选项≥2 结果）——buildEvent 已断言
// options.length>=2,故不再有单选项事件需要 flavor 分流;决策台一律弹多选项
// 事件。resolve 路径不变（derive(seed,"resolve",age,choice.id)），确定性一致;
// plan/伤病/seen 计数在 resolveChoice 结账。

function buildPeriodDecisions(
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
  recentRating: number | null,
  severeInjuries: number,
  injuryWarned: boolean,
  verdictSeenAt: number,
  forcedExitDue: boolean,
  stateTournamentOffset = 0,
  careerEventsSeen: readonly string[] = EMPTY_SEEN,
): { special: FiredEvent | null; transfer: FiredEvent | null } {
  const role = resolveRole(player.overall, club, player.position === "GK");
  const ctx: EventContext = {
    player, club, league, seed, age: player.age, role, periodIndex, rngState, blessings,
    injuriesTaken, ascension,
    severeInjuries,
    plan, periodLength,
    permPerks,
    formerClubIds,
    recentMarketValue,
    recentRating,
    // expose bare tag names so events match without knowing the TTL encoding
    statusTags: statusTags.map(tagName),
    tournamentOffset: stateTournamentOffset,
    // per-career anti-repeat: pool events already fired this run (P-VAR) —
    // rollRandomEvent excludes them so the same story event never repeats.
    seenEvents: careerEventsSeen,
  };
  // 阶段三双通道：转会通道(T)与特殊事件通道(S)独立、可并存于同一节奏点。
  // T = 本期「俱乐部处境」决策（转会/租借/强制离队/续约/金元/无人问津…），
  //     黄金期(19-31)按 cadence 固定弹一次（不再被特殊事件挤兑）；
  // S = 本期「特殊事件」（boss/伤病/国家队/叙事…），0 或 1 个，与 T 并存排队。
  // 队列顺序：S 先、T 后（boss 张力优先，转会作为节奏收尾）。同 period 全部
  // 决策选完才推进赛季；医学退役等 forceRetire 短路——选了退役即丢弃后续队列。
  let special: FiredEvent | null = null;
  let transfer: FiredEvent | null = null;
  let sDone = false;
  let tDone = false;

  // 医学退役 (P-B1): the body outranks everything. 3rd severe injury (and each
  // further one past a survived verdict) → the verdict; 2nd → the warning.
  // 走 S 通道：可与其后的 T（转会）并存——玩家选退役即 forceRetire 短路丢弃
  // 转会；赌一把成功则转会照常弹（伤后重新出发）。verdict 不设 newClubId，
  // 故与转会无 mods 冲突。
  if (severeInjuries >= 3 && verdictSeenAt < severeInjuries) {
    special = medicalVerdictEvent(ctx);
    sDone = true;
  }
  if (!sDone && severeInjuries >= 2 && !injuryWarned) {
    special = doctorWarningEvent(ctx);
    sDone = true;
  }

  // post-loan resolution (母本 ca): highest priority — a loan just returned.
  // 走 T 通道：租借归来即本期「俱乐部处境」决策（留/再租/永久转会），
  // 替代常规转会窗。T 始终是 FiredEvent（多选决策；罕见单选时为一次确认）。
  if (!tDone && completedLoan) {
    transfer = postLoanEvent(ctx, completedLoan);
    tDone = true;
  }

  // relegation loyalty: if the player's club was just relegated. The
  // relegation_endured tag keeps a yo-yo club from asking every other season.
  // ONE-SHOT WINDOW (lastSeasonRelegated is true for exactly one period), so
  // it stays ABOVE the career plan — a plan slot must not swallow it.
  // 走 T 通道：降级去留即本期俱乐部决策（留队征战 / 转投争冠队）。
  if (!tDone && lastSeasonRelegated && !ctx.statusTags.includes("relegation_endured")) {
    const rl = fireEventByKey(ctx, "relegation_loyalty");
    if (rl) { transfer = rl; tDone = true; }
  }

  // 归化邀约：已退出国家队会籍（intl_retired tag 在身）的球员，被一个更强的
  // 他国足协看中。概率门（每期 35%）——保留「不一定来」的张力，但 8 个 period
  // 的 tag 生命周期内基本会等到。accept 切 FIFA 会籍并打上永久 naturalized
  // 防 reopen（intl_retired 本身靠自然 decay 消失）。归化设 newNationalityId（非
  //  newClubId），走 S 通道可与其后 T 转会并存（换会籍 + 换俱乐部）。
  // 先于 climax：归化改变了 nationality，直接影响 WC climax 的国家判定。
  if (!sDone && ctx.statusTags.includes("intl_retired")
      && !ctx.statusTags.includes("naturalized")
      && player.age >= 20 && player.age <= 32
      && player.overall >= 72
      && nationById(player.nationalityId).fifaRep <= 3
      && chance(derive(seed, "nat-offer", player.age, periodIndex), 0.35)) {
    const no = fireEventByKey(ctx, "naturalization_offer");
    if (no) { special = no; sDone = true; }
  }
  // 俱乐部与国家队冲突：国家队剧情线的入口（拒绝征召 → 归化邀约）。
  // Contextual 触发——球员够强被征召 + 主力 + 尚未退出会籍，每期 5%
  // 概率门。它是剧情入口，不应是几乎人人会遇到的重复决策；5% 把期望
  // 触发压到 ~0.8 次/生涯（少数生涯才会遇到的剧情岔路），降频让出的 S
  // 通道决策位回流到 142 种池事件，避免“来来回回就那几个”的体感
  // （probe: 10% → 58% 生涯中招，5% → ~35%）。走 S 通道。
  if (!sDone && !ctx.statusTags.includes("intl_retired")
      && !ctx.statusTags.includes("naturalized")
      && (role === "starter" || role === "high_rotation")
      && player.overall >= (CALLUP_THRESHOLD[clamp(nationById(player.nationalityId).intlRep, 0, 5)] ?? 70)
      && chance(derive(seed, "nt-conflict", player.age, periodIndex), 0.05)) {
    const cne = fireEventByKey(ctx, "club_national_team_conflict");
    if (cne) { special = cne; sDone = true; }
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
  if (!sDone && climaxAgeThisPeriod !== undefined && ascension < 9) {
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
          // pp_boss_slayer (+20% perk) and 大赛型选手 big_game_player (+10% blessing) boss good odds.
          //   perk 优先 (轮回是永久核心): 有 perk 时祝福不再叠加 → 叠加=perk 单值, 不更变态.
          odds = clamp(odds + (permPerks.includes("pp_boss_slayer") ? 0.20 : blessings.includes("big_game_player") ? 0.10 : 0), 0.01, 0.95);
          special = continentalCupShowdown(climaxAgeThisPeriod, odds, nation.confederation, blessings, nation.name);
          sDone = true;
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
          // pp_boss_slayer (+20% perk) and 大赛型选手 big_game_player (+10% blessing) boss good odds (perk 优先).
          qOdds = clamp(qOdds + (permPerks.includes("pp_boss_slayer") ? 0.20 : blessings.includes("big_game_player") ? 0.10 : 0), 0.05, 0.95);
          special = worldCupQualifierShowdown(climaxAgeThisPeriod, clamp(qOdds, 0.05, 0.95), true, 0, blessings, nation.name);
          sDone = true;
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
            // pp_boss_slayer (+20% perk) and 大赛型选手 big_game_player (+10% blessing) boss good odds (perk 优先).
            odds = clamp(odds + (permPerks.includes("pp_boss_slayer") ? 0.20 : blessings.includes("big_game_player") ? 0.10 : 0), 0.01, 0.95);
            special = worldCupShowdown(climaxAgeThisPeriod, odds, "世界杯冠军", "功亏一篑", blessings, nation.name);
            sDone = true;
          }
        }
      }
    }
  }
  // P-RETIRE: soft retention. Past RETENTION_START the body must earn another
  // period — a retention roll gates whether the club keeps picking the
  // player. A failed roll fires the no_offers decision (降档续约 or 挂靴) for a
  // faded non-star, or — for a still-elite star (OVR ≥ FAME_BID_OVR) — the
  // 金元邀约 fame-league bid (沙特 money move / 高水平续踢 / 体面挂靴).
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
  if (!tDone && player.age >= RETENTION_START && !ctx.statusTags.includes("fresh_contract")) {
    const r = derive(seed, "retention", player.age, periodIndex);
    const prob = retentionProb(player.overall, player.age, club, ctx.statusTags, severeInjuries, blessings, permPerks);
    if (!chance(r, prob)) {
      // Elite aging star (OVR ≥ FAME_BID_OVR): the club won't renew, but the
      // name still draws fame-league money (沙特联) — a league-driven transfer
      // (金元邀约), NOT 无人问津. The Modric/Casemiro/Ronaldo arc: a still-elite
      // star pushed out of a giant lands Saudi money for his 召唤力, or keeps
      // playing at a high European level for less, or retires with dignity.
      // A genuinely faded non-star (OVR < FAME_BID_OVR) still routes to the
      // 无人问津 pay-cut exit — that arc is realistic for a 伤仲永, not a star.
      // 走 T 通道：留队失败即本期俱乐部决策（降档续约 / 金元 / 挂靴）。
      transfer = player.overall >= FAME_BID_OVR ? fameLeagueBidEvent(ctx) : noOffersEvent(ctx);
      tDone = true;
    }
  }

  // 转会是生涯脊柱（design: 转会独立于事件，作为核心催化剂；参照 Copero
  // 转会窗为最常见决策、生涯 ~7 家俱乐部）。现在转会走 T 通道——黄金期
  // (19-31)按 cadence(每 2 季；飞升 8 冻结每 5 季)固定弹一次，不再被 S 事件
  // 挤兑。S 与 T 并存排队，互不抢位（详见下文 T 通道块与池事件路由）。
  // injury roll (P-B1, diverges from 母本 Qr's 2-injury cap): an ACL doesn't
  // wait for the transfer window. 走 S 通道（伤病不设 newClubId，与 T 并存）；
  // 罕见的单选伤病会自动转 flavor（挂赛季行），多数伤病是多选决策。Climax/WC
  // 事件在其之上（boss 优先），injury_before_tournament 覆盖带伤上陈那条线。
  if (!sDone) {
    const injuryR = rollInjuryEvent(ctx);
    if (injuryR) { special = injuryR; sDone = true; }
  }

  // 强制离队 (评分机制驱动): the SINGLE forced-exit layer. A player whose
  // rating stayed below the club's standard for ≥2 consecutive played seasons
  // (shouldTriggerForcedExit) is moved on — 管理层看评分，连续不达标 = 不适合
  // 待在这支球队. This replaces the three broken triggers the engine had
  // (underperform_release's starter/rep≥6 gate, stuck_release's trophy-exemption
  // bug, contract_nonrenewal's 26+ age gate) — none of which caught a bench
  // washout lying flat on a big club's bench for years. 走 T 通道：强制离队即
  // 本期俱乐部决策（替代常规转会窗），优先于 cadence 转会；生涯计划槽若同期
  // 到期则顺延（findAvailableSlot 下期仍命中）。Two routes by context:
  //   • 豪门青训 (rep≥5, age ≤ YOUTH_LOAN_MAX_AGE, bench role) → LOAN out. A
  //     youngster who can't get minutes at a deep-squad giant is loaned to a
  //     smaller club for starter minutes + development — the EXPECTED path
  //     (Chelsea loan army, Castilla → loan), not a permanent exit.
  //   • everyone else → underperform_release (rep≥6 starter, 豪门无情) or
  //     stuck_release (踢不出来) — FORCED transfer: the event lists clubs to
  //     move to, NO 留队 / 证明自己 escape hatch — data barren to the trigger
  //     line = you must go.
  //   stuck@4 / underperformed@4 are the anti-repeat on each route (loan has
  //   its own !completedLoan guard). Age 18+ keeps a youth grace window.
  //   评分↔事件治理: a YOUNG player (≤ FORCED_EXIT_YOUTH_AGE) forced out is NOT
  //   read as a 踢不出来 washout — an 18yo below a senior squad's standard is a
  //   DEVELOPMENT move, not a failure. forcedExitFiredEvent frames the desc +
  //   outcome for young players as the club sending him out for first-team
  //   minutes (the academy/feeder path), reserving the harsh 扫地出门/踢不出来
  //   read for a 24+ veteran who genuinely stopped performing. The mechanism
  //   (forced transfer to a 降档 starter club) is unchanged — the rating→exit
  //   coupling still fires at the same line; only the event's framing matches
  //   the player's age, so a debut academy kid reads as a development move, not
  //   a career-ending washout. (The drop is developmentally correct — the kid
  //   grows at a starter club and ~93% climb back — so the timing is kept; the
  //   harsh TEXT for an 18yo was the imperfection.)
  if (!tDone && forcedExitDue && player.age >= 18 && player.age <= 38
      && !ctx.statusTags.includes("stuck")
      && !ctx.statusTags.includes("underperformed")) {
    const isLoanPath = club.rep >= 5 && player.age <= YOUTH_LOAN_MAX_AGE
      && !completedLoan
      && (role === "substitute" || role === "low_rotation" || role === "third_keeper");
    if (isLoanPath) {
      transfer = loanOfferEvent(ctx);
      tDone = true;
    } else {
      // rep≥6 starter (豪门无情 — your data doesn't match this club's standard)
      // vs everyone else (踢不出来 — find a level where you can play).
      const evKey = club.rep >= 6 && (role === "starter" || role === "high_rotation")
        ? "underperform_release" : "stuck_release";
      const fe = fireEventByKey(ctx, evKey);
      if (fe) { transfer = fe; tDone = true; }
    }
  }


  // T 通道 · 转会窗 cadence：黄金期(19-31)每 2 季（飞升 8 冻结每 5 季）
  // 到期即弹一次常规转会（或工资挤压变体）。走 T 通道——不再被 S 事件挤兑
  // （S 与之并存排队）。非_due_期则让位给后续 situational T（续约/大片/金元/
  // 租借）。
  if (!tDone) {
    const cadenceDue = isTransferWindowAge(seasonAges, ascension);
    if (cadenceDue) {
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
        transfer = wageSqueezeEvent(ctx);
      } else {
        transfer = transferEvent(ctx);
      }
      tDone = true;
    }
  }

  // （生涯计划槽与随机兜底统一到下文「池事件路由」——抽一次按是否转会类分流到
  // S/T，不再在此处单独 return。）

  // 母本 contextual events: contract non-renewal (age 26+, bench role). The
  // contract_crisis tag (set on resolve, long TTL) is the anti-repeat guard —
  // without it a benched veteran refires this every period. Below the
  // retention roll (its original spot was even higher; P-VAR keeps it here so
  // the 33+ bench veteran still lands in no_offers when the body is gone).
  // 走 T 通道：不续约即本期俱乐部决策（降档 / 留队拼）。非 cadence 期才轮到。
  if (!tDone && player.age >= 26 && (role === "substitute" || role === "low_rotation")
      && !ctx.statusTags.includes("contract_crisis")) {
    const nr = fireEventByKey(ctx, "contract_nonrenewal");
    if (nr) { transfer = nr; tDone = true; }
  }

  // Mechanics review: 王座之战 — the late-career "legend maintenance" boss. An
  // 85+ starter aged 29+ at a big club (rep≥4) faces a rising heir at his own
  // position; the decision-tension curve used to go flat exactly when the
  // career peaked (rep5 starter = autopilot trophy farming). throne_done@6
  // prevents back-to-back refires; the ~60% arm rate keeps it an event, not a
  // fixture. 走 S 通道（不设 newClubId，可与 T 并存）。
  if (!sDone && player.age >= 29 && player.overall >= 85 && role === "starter" && club.rep >= 7
      && !ctx.statusTags.includes("throne_done")
      && chance(derive(seed, "throne", player.age), 0.6)) {
    const tc = fireEventByKey(ctx, "throne_challenge");
    if (tc) { special = tc; sDone = true; }
  }

  // blockbuster offer (母本 aa): a fame club courts a star (age 28-34, peak≥80).
  // 走 T 通道。非 cadence 期才轮到（cadence 期常规转会优先）。
  if (!tDone) {
    const bb = blockbusterOfferEvent(ctx, maxOverall, blockbusterOfferedTier);
    if (bb) { transfer = bb; tDone = true; }
  }

  // 金元邀约 (offer 版): a still-elite aging star (33+, OVR≥FAME_OFFER_OVR)
  // who RETAINED this period is nonetheless courted by the fame leagues (沙特联)
  // for his 召唤力 — the Modric "该不该接沙特钱" decision. The club still wants
  // him (retention passed), so this is a TEMPTATION, not a forced exit: stay
  // (loyal) / take the Saudi money (fresh_contract) / hang up with dignity.
  // Sits below the climax/retention/injury/forced-exit/plan/transfer-window/
  // throne/blockbuster ladder — those outrank a merely-optional temptation;
  // a due window it would eat already returned above (so it never starves the
  // cadence). 33-34 overlaps blockbuster (28-34): a fame CLUB courts first
  // (blockbuster above returns), and only if it didn't fire does the fame
  // LEAGUE bid get a roll — so the冲冠邀约 and the金元诱惑 never collide in
  // one period. EXCLUDED if the player is already in a fame league (沙特联):
  // the "Saudi tempts you away from Europe" beat makes no sense when you're
  // already there — a star who took the money earlier doesn't get re-tempted.
  // Anti-repeat via fame_offer_seen (4 periods). 30%/period gate — a surviving
  // aging star (OVR≥80 into the 33+ window) sees it ~1-2×/career, the user's
  // "莫德里奇式金元诱惑" beat without it becoming a fixture.
  if (!tDone && player.age >= RETENTION_START && player.overall >= FAME_OFFER_OVR
      && !ctx.statusTags.includes("fame_offer_seen")
      && !league.fame
      && chance(derive(seed, "fame-offer-roll", player.age, periodIndex), 0.30)) {
    transfer = fameLeagueBidEvent(ctx, "offer");
    tDone = true;
  }

  // loan offer (母本 oa/sa): young bench players at a BIG club get loaned out
  // for minutes — the relief valve for the bigClubBench growth penalty (P-A16,
  // the "moved to a giant too early" fork the user wants). Gated to big clubs
  // (rep≥5): a small club plays its bench, it doesn't loan them out
  // (inauthentic); only a deep-squad giant loans a youngster out for
  // development (Chelsea loan army, Castilla → loan). 走 T 通道。非 cadence 期
  // 才轮到。
  if (!tDone && !completedLoan && (role === "substitute" || role === "low_rotation" || role === "third_keeper")
      && player.age >= 18 && player.age <= 24 && club.rep >= 5) {
    const loanProb = role === "low_rotation" ? 0.55 : 0.85;
    if (chance(derive(seed, "loan-offer", player.age, periodIndex), loanProb)) {
      transfer = loanOfferEvent(ctx);
      tDone = true;
    }
  }

  // ── 池事件路由（生涯计划槽 / S 通道故事保证）。
  // 阶段四（用户诉求）：每个节奏点保证「一个转会事件 + 一个非转会故事事件」
  // 共存——转会(T)与故事(S)不再二选一。S 通道在未被高优先级系统事件
  // （boss/伤病/归化/国家队冲突/强制离队/retention…）占住时，必抽一个
  // 非转会故事塞入（独立 derive 流，排除转会类，只要池子还有没见过的）。
  // T 通道保持 cadence 转会 + 情境转会（loan/强制离队/retention/no_offers/
  // 续约/blockbuster/fame）——这些本身就是「转会类决策」，满足「一个转会」。
  // 16-18 青训期 / 晚期衰退役 T 通道可能空（不强行伪造转会），但 S 通道仍尽力
  // 弹故事。队列 pendingChoices 本就支持多个 FiredEvent 共存，未来可扩为「一期
  // 多故事」。用独立 derive 流抽取，与 T 转会报价流互不干扰（报价仍用原
  // period-decision 流，跨版本身份与重建确定性不受影响）。
  const poolRng = derive(seed, "pdec", periodIndex, "pool");
  let poolDrawn: FiredEvent | null = null;
  if (plan && player.age <= 37) {
    const slot = findAvailableSlot(plan, player.age);
    if (slot !== null) {
      poolDrawn = rollRandomEvent({ ...ctx, rngState: poolRng, slotAge: slot });
    }
  }
  if (poolDrawn) {
    const isClubMove = POOL_CLUB_MOVE_KEYS.has(poolDrawn.event.key);
    if (isClubMove && transfer === null) {
      transfer = poolDrawn;           // 转会类故事 → T 通道（替代/补充 cadence 转会）
    } else if (!isClubMove && special === null) {
      special = poolDrawn;  // 非转会 → S 通道
    }
    // 目标通道已满 → 丢弃（不双塞同一通道；槽不消费，下期重抽）
  }
  // S 通道故事保证：计划槽未填进非转会故事时，独立流再抽一个非转会故事。
  // 不再要求 T 空——转会与故事共存（用户诉求）。transfer 已占位照弹故事。
  if (special === null) {
    const storyRng = derive(seed, "pdec", periodIndex, "story");
    const story = rollRandomEvent({ ...ctx, rngState: storyRng }, { excludeClubMove: true });
    if (story) special = story;
  }
  return { special, transfer };
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
  // club, not a loan) grants +2 OVR. Folded into pendingMods.immediateOverallDelta
  // so the next period's upfront-shift applies it. Loans don't trigger it.
  // 永久 perk > 同功能祝福: 转会嗅觉 +2 (perk) > 雇佣兵 +1 (祝福). perk 优先制
  //   (轮回是永久核心): 有 perk 时雇佣兵祝福不再叠加 → 叠加=perk 单值 (+2),
  //   避免转会 OVR 连锁放大 (多涨的 OVR 加速爬大俱乐部, 叠加会远超单点之和).
  let finalMods = mods;
  const isPermanentMove = !!mods.newClubId || choice.kind === "new_club" || choice.kind === "permanent_transfer";
  // pp_transfer_savvy (+2 perk, 优先) and 雇佣兵 mercenary (+1 blessing, perk 缺席时才叠加).
  const blessings = state.blessings ?? EMPTY_BLESSINGS;
  const hasTransferPerk = (state.permPerks ?? EMPTY_PERKS).includes("pp_transfer_savvy");
  let transferOvr = 0;
  if (isPermanentMove && hasTransferPerk) transferOvr += 2;
  else if (isPermanentMove && blessings.includes("mercenary")) transferOvr += 1;
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
  // 阶段三：累积 mods（队列跨决策）+ 出队。forceRetire 短路：选了退役即丢弃
  // 后续队列（pendingChoice 清空），store 下一步 simulatePeriod 即 finalizeRun
  // 结束生涯。否则队尾升为队首、rebuildResolve 重建其 resolve 函数；队列空则
  // pendingChoice 清空，store 推进下一 period。
  const baseMods = state.pendingMods ?? EMPTY_MODS;
  const mergedMods = mergeMods(baseMods, finalMods);
  const tail = state.pendingChoices ?? [];
  const forceRetire = !!mergedMods.forceRetire;
  let nextPendingChoice: GameState["pendingChoice"] = null;
  let nextPendingResolve: GameState["pendingResolve"] = undefined;
  let nextPendingChoices: readonly CareerEvent[] = [];
  if (!forceRetire && tail.length > 0) {
    nextPendingChoice = tail[0]!;
    nextPendingChoices = tail.slice(1);
    nextPendingResolve = rebuildResolve({ ...state, pendingChoice: nextPendingChoice, pendingChoices: nextPendingChoices });
  }
  return {
    ...state,
    pendingChoice: nextPendingChoice,
    pendingResolve: nextPendingResolve,
    pendingChoices: nextPendingChoices,
    pendingMods: mergedMods,
    pendingMilestone: undefined,   // milestone celebrated before this choice; clear it
    lastOutcome: outcome,
    lastOutcomeGood: !!good,
    // 判决牌素材：OVR 净变化把三种时机（即时/永久/延后）加总成一个玩家看得懂的数。
    lastVerdict: {
      title: ev.title,
      choice: choice.text,
      ovrDelta: (finalMods.immediateOverallDelta ?? 0) + (finalMods.permanentOverallDelta ?? 0) + (finalMods.deferredOverallDelta ?? 0),
      injury: !!injury,
      severe: !!severe,
    },
    careerEventPlan: plan,
    completedLoan,
    // blockbusterOfferedTier 在大片邀约 resolve 时升档（不在 build 时升，避免队尾
    // 重建时 offeredTier 已升导致死循环）。无论接受/拒绝，邀约已发生即不重弹同档。
    blockbusterOfferedTier: ev.key === "blockbuster_offer"
      ? (state.maxOverall >= 90 ? 3 : state.maxOverall >= 85 ? 2 : 2)
      : state.blockbusterOfferedTier,
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
  farewellStyle?: "private" | "public" | "grand",
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
    farewellStyle,
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
    recentRating: recentPlayedRating(game.seasons),
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
    case "transfer":
      return transferEvent(ctx).resolve;
    case "wage_squeeze":
      return wageSqueezeEvent(ctx).resolve;
    case "fame_league_bid":
      return fameLeagueBidEvent(ctx, "exit").resolve;
    case "fame_league_offer":
      return fameLeagueBidEvent(ctx, "offer").resolve;
    case "loan_offer":
      return loanOfferEvent(ctx).resolve;
    case "post_loan":
      return game.completedLoan ? postLoanEvent(ctx, game.completedLoan).resolve : undefined;
    case "blockbuster_offer": {
      const bb = blockbusterOfferEvent(ctx, game.maxOverall, game.blockbusterOfferedTier);
      return bb ? bb.resolve : undefined;
    }
    case "retirement_ceremony":
      // 告别仪式: rebuild the resolve closure from the reason threaded onto the
      // event (retireReason) so a refresh mid-farewell re-creates the exact
      // same forceRetire/forceRetireReason/farewell-tag outcome.
      return retirementCeremonyEvent(ctx, ev.retireReason ?? "age").resolve;
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

/** P-RATING: most recent PLAYED season's 综合表现 rating, walking back from
 *  the latest season. Skips 0-app / injured / farewell seasons (rating null —
 *  grace, same as the forced-exit run) and stops at the first rated season.
 *  Returns null if no season was ever played (debut, or a long injury spell).
 *  Pure — reads only the persisted seasons. */
function recentPlayedRating(seasons: readonly SeasonResult[]): number | null {
  for (let i = seasons.length - 1; i >= 0; i--) {
    const r = seasons[i]!.rating;
    if (r !== undefined && r !== null) return r;
  }
  return null;
}

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

/** 告别仪式: read the farewell style the player chose from a resolve's
 *  addTags (farewell_private / farewell_public / farewell_grand). The
 *  retirement_ceremony options stamp one of these; soft 挂靴 / medical /
 *  narrative retirements carry none → undefined (no farewell capstone). */
function farewellStyleFromTags(tags: readonly string[] | undefined): "private" | "public" | "grand" | undefined {
  if (!tags) return undefined;
  for (const t of tags) {
    const name = tagName(t);
    if (name === "farewell_private") return "private";
    if (name === "farewell_public") return "public";
    if (name === "farewell_grand") return "grand";
  }
  return undefined;
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
