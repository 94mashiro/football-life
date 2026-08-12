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
  CLUBS, CALLUP_THRESHOLD, YOUTH_LOAN_MAX_AGE, youthTierOf, NATION_LEGACY_MULT, RATING_GROWTH_BANDS, forcedExitBar,
  SQUAD_BASE, isOlympicAge, SIGNATURE_ELITE,
} from "./data";
import {
  resolveRole, resolveYouthRole, simSeasonStats, clubTrophyCandidates, simulateNational,
  simulateYouthNational, simulateOlympic,
  rollAwards, growthDelta, computeMarketValue, computeWage, computeSeasonRating,
  retentionProb, applyCeiling, RETENTION_START, MAX_AGE, FAME_BID_OVR, FAME_OFFER_OVR,
  FAME_PEAK_OVR, DIGNITY_RETIRE_OVR, wageSqueeze, type NationalContext,
} from "./sim";
import {
  rollRandomEvent, rollInjuryEvent, transferEvent, loanOfferEvent,
  postLoanEvent, blockbusterOfferEvent, doctorWarningEvent, medicalVerdictEvent,
  worldCupShowdown, worldCupQualifierShowdown, continentalCupShowdown,
  academyChoiceEvent, fireEventByKey, resolveEventOption, previewLabel,
  noOffersEvent, wageSqueezeEvent, fameLeagueBidEvent, retirementCeremonyEvent,
  dignifiedRetireEvent,
  POOL_CLUB_MOVE_KEYS,
  type EventContext, type FiredEvent,
} from "./events";
import type {
  GameState, Player, SeasonResult, Trophy, Award, Role, Choice, Modifiers,
  CareerEventPlan, CareerEvent, CareerBeat, Milestone, ChoiceLogEntry, ResolveFn,
  YouthNationalSeason,
} from "./types";
import { seniorCareerSeasonCount, seniorCareerStats, seniorClubCount, trophyMult } from "./types";
import { rollDevProfile, scoreLegacy } from "../meta/legacy";
import { appendSeasonBeats, appendNationalBeat, appendDeclineBeat, retirementNarrative } from "./narrative";

const PERIOD_LENGTH = 1;        // seasons per period — one decision every season for decision density
const START_AGE = 16;
const START_OVR = 50;
// RETIRE_AGE 40 was a hard wall: every career ended at 40 regardless of
// choices/ability — the game promised a fixed horizon and never surprised.
// Replaced (P-RETIRE) by the soft retention roll (RETENTION_START, sim.ts)
// + a generous MAX_AGE safety net. See retentionProb / projectedRetireAge.
const FORCE_RETIRE_OVR = 50;
/** 无人问津 (ascension 7): the market's patience runs out earlier — the
 *  no-offers floor rises 50 → 55, so a declining player is forced out seasons
 *  sooner (fewer late-career wage rolls, a shorter stats tail). Chosen over
 *  the medical-arc alternative (判决从严) after measuring: 队医警告/判决 events
 *  fire in ~1% of careers — a dead rung; this floor touches every fading one. */
const forceRetireFloor = (ascension: number): number => (ascension >= 7 ? 55 : FORCE_RETIRE_OVR);
/** 「一人一城」生涯词条的最短成年生涯长度（赛季）——见 finalizeRun。 */
const ONE_CLUB_MIN_SEASONS = 8;
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
// ADR-0005: 飞升 8「转会冻结」不再冻结窗的 cadence（旧实现 2→5 让超越俱乐部
//   的球员无 diegetic 反馈地卡死）。窗照常每 2 季开；L8 的难改由 generateClubOffers
//   的升级报价门控承担（asc>=8 升级一档需上季统治级解冻）。
const TRANSFER_WINDOW_CADENCE = 2;
/** 飞升 9「国家队弃子」入选门槛加价。基础门槛按国家 80–83，+8 后为 88–91：
 *  在「从严」取三次最低 + 全联赛降档的复合难度下这是极罕见但真实存在的白鲸，
 *  而不是一道关掉的门。数值由 tools/ascension-probe 标定后与曲线锚点同步。 */
const ASC9_CALLUP_SURCHARGE = 8;
function isTransferWindowAge(seasonAges: readonly number[]): boolean {
  return seasonAges.some(
    (a) => a >= TRANSFER_WINDOW_START_AGE && a <= TRANSFER_WINDOW_END_AGE && (a - TRANSFER_WINDOW_START_AGE) % TRANSFER_WINDOW_CADENCE === 0,
  );
}

// 池事件中「转会类」的 key 见 events.ts 的 POOL_CLUB_MOVE_KEYS（已导出在此 import）。
// P-GATE 国家队/大赛门槛 (climax boss floors)。国家队入选 (CALLUP_THRESHOLD,
// data.ts) 只是「进大名单」; 大赛 climax 是「犴起国家打到决赛」——后者门槛远高
// 于入选: 一个入选名单的替补不会出现在世界杯决赛。两道门共同实现「弱球员
// 不触发国家队/世界杯/洲际杯事件」。
//   WC_FINAL_FLOOR: 世界杯决赛 (capstone boss)——必须是真·球星 (≥82, 强队俱乐部
//     主力级)。≈40% 生涯够格, 再经 reach roll 筛选 → 稀有且 earned。
//   WC_QUAL_STARTER_FLOOR: 世预赛决战 (rising star 犴队出线)——国家队主力
//     (≥76)。路径入口取 max(入选门槛, 76): 巴西 (入选 80) → 80, 中等强国
//     (入选 74) → 76。决赛 floor (82) 之下的球员走预选赛, 之上的走决赛。
//   CONT_FINAL_FLOOR: 弱国洲际杯决赛 (亚洲杯/美洲杯)——弱国的英雄 (≥78,
//     略低于强国入选线: 弱国神锋犴起亚洲杯的 underdog 弧)。
const WC_FINAL_FLOOR = 82;
const WC_QUAL_STARTER_FLOOR = 76;
const CONT_FINAL_FLOOR = 78;
// national-team-redesign: 世界杯决赛 reach odds (career-stable 一生一战)。曾是
//   fifaRep>=4 ? 0.30 : fifaRep>=2 ? 0.20 : 0.08 的阶跃 + 弱国硬墙——
//   fifaRep<=1 && contRep<=2 的足球荒漠(中国/泰国/越南/印尼/玻利维亚/斐济…)
//   的世界杯决战事件永不触发,「带中国摸到世界杯」从设计上被判死刑。
// 现改为「国家基线 + 球星 carry」连续曲线,荒漠球星也有小而非零的奇迹缝
//   (George Weah/萨拉赫式):carry 只抬 fifaRep≤3 的非传统强国——巴西靠阵容
//   厚度夺冠、不靠单星 carry,故 fifaRep 4-5 保持固定 0.30,~10% 生涯夺冠
//   目标(balance-check)逐位不回退。carry 必须延伸到 fifaRep 2-3,否则被
//   carry 抬过的弱国会反超中坚国、破坏梯度。winOdds 分档沿用旧值不变
//   (reach 给希望,win 守稀缺)。设计稿见 research/national-team-redesign.md。
const WC_REACH_BASE = [0.04, 0.08, 0.20, 0.20, 0.30, 0.30] as const; // fifaRep 0..5
const WC_REACH_CAP = 0.40;
/** 球星 carry:OVR≥82 后每点 +1.5%,封顶 +13%(≈90.7 OVR 达顶)。只抬
 *  fifaRep≤3 的国家(见 WC_REACH_BASE 注释)。Pure。 */
function wcReachCarry(overall: number, fifaRep: number): number {
  if (fifaRep > 3) return 0;
  return Math.min(0.13, Math.max(0, (overall - WC_FINAL_FLOOR) * 0.015));
}
/** 世界杯决赛 reach odds(一生一战,career-stable 单掷)。国家基线 + 球星 carry
 *  (只抬 fifaRep≤3),封顶 WC_REACH_CAP。导出供探针验证(research/
 *  national-team-redesign.md 验收标准)。Pure。 */
export function wcReachOdds(fifaRep: number, overall: number): number {
  const f = Math.max(0, Math.min(5, Math.floor(fifaRep)));
  return Math.min(WC_REACH_CAP, WC_REACH_BASE[f]! + wcReachCarry(overall, f));
}

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
    overallDelta: sum(a.overallDelta, b.overallDelta) || undefined,
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
    forceNationalCaptain: either(a.forceNationalCaptain, b.forceNationalCaptain) || undefined,
    forceTrophy: last(a.forceTrophy, b.forceTrophy),
    loyalStay: last(a.loyalStay, b.loyalStay),
    newClubId: last(a.newClubId, b.newClubId),
    newNationalityId: last(a.newNationalityId, b.newNationalityId),
    loanOutTo: last(a.loanOutTo, b.loanOutTo),
    loanReturnAge: last(a.loanReturnAge, b.loanReturnAge),
    addTags: [...(a.addTags ?? []), ...(b.addTags ?? [])],
    forceRetire: either(a.forceRetire, b.forceRetire) || undefined,
    forceRetireReason: last(a.forceRetireReason, b.forceRetireReason),
    dignifiedExit: either(a.dignifiedExit, b.dignifiedExit) || undefined,
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
  const devProfile = rollDevProfile(setup.seed, isGK, setup.allowWonderkid ?? false, youthTierOf(setup.nationalityId));
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
    originNationalityId: setup.nationalityId,
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
  // 青训抉择 (academy choice): the debut console no longer picks a club — the
  //   player chooses their youth academy as the FIRST in-game event (see
  //   simulatePeriod's academy guard + events.ts academyChoiceEvent). So when
  //   setup.clubId is ABSENT, the start club is a PLACEHOLDER (the weakest club
  //   in setup.leagueId) that is NEVER simulated — it only exists so
  //   rebuildResolve's clubById(currentClubId) is safe before the choice; the
  //   academy event's resolve sets newClubId, and the next simulatePeriod stamps
  //   the real startClubId and runs season 1 (academyPending=true).
  //   setup.clubId, when PRESENT, is a PRE-PICKED academy bypass: the career
  //   starts directly at that club with academyPending=false. The menu never
  //   sets it (→ academy event, the player's first decision); dailies/tools/old
  //   share links set it to force a specific academy so a seed reproduces a
  //   comparable career (a daily where every player picked a different academy
  //   would diverge, breaking the leaderboard; a balance probe forcing
  //   man-city needs man-city, not a random offer).
  const pickedClub = setup.clubId !== undefined
    ? CLUBS.find((c) => c.id === setup.clubId)
    : undefined;
  const academyPending = !pickedClub;
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
    // 青训抉择: false when setup.clubId pre-picked an academy (bypass — daily/
    // tools/old links); true when the menu left it unset (the academy event is
    // the player's first decision).
    academyPending,
    dailyDate: setup.dailyDate,
    customSeed: setup.customSeed,
    seasons: [],
    maxOverall: startOvr,
    trophies: [],
    awards: [],
    pendingChoice: null,
    legacy: 0,
    rawLegacy: 0,
    ascension: setup.ascension,
    pace,
    periodLength: PACE_LENGTH[pace],
    tournamentOffset,
    retired: false,
    retirementReason: null,
    age: START_AGE,
    blessings,
    // raw equipped loadout (pre-fold) — surfaced on the leaderboard/archive so
    // a viewer learns the build, not the perk-mirrored blessing set.
    loadout: setup.blessings,
    permPerks,
    injuriesTaken: 0,
    statusTags: [],
    hasBeenClubCaptain: false,
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
    return finalizeRun(state, state.currentClubId, state.currentLeagueId, state.seasons, state.trophies, state.awards, state.maxOverall, state.player, reason, farewellStyle, mods0.dignifiedExit);
  }
  // 青训抉择 (academy choice) — the career's FIRST decision, before any season
  // is simulated. createRun set academyPending with a placeholder currentClubId
  // (weakest club in startLeagueId). On the first simulatePeriod there is no
  // pendingMods.newClubId yet → surface the academy event (2 clubs from all
  // represented home-country leagues + 1 confederation club) and STOP — no
  // season runs until the player picks.
  // After the pick, resolveChoice sets pendingMods.newClubId, so the next
  // simulatePeriod skips this guard, consumes the newClubId below, stamps the
  // real startClubId/startLeagueId, clears academyPending, and runs season 1.
  if (state.academyPending && state.seasons.length === 0 && !mods0.newClubId && !mods0.loanOutTo) {
    const academy = academyChoiceEvent(state.player, seed);
    return {
      ...state,
      pendingChoice: academy.event,
      pendingResolve: academy.resolve,
      pendingChoices: [],
      pendingMods: EMPTY_MODS,
      academyPending: true,
    };
  }
  // 母本 loan model: a loan-out resolves into loanOutTo; the player plays at the
  // loan club until returnAge, then auto-returns to the parent club.
  let activeLoan = state.activeLoan;
  let currentClubId = state.currentClubId;
  let completedLoan = state.completedLoan;
  if (mods0.loanOutTo) {
    activeLoan = { parentClubId: state.currentClubId, loanClubId: mods0.loanOutTo, returnAge: mods0.loanReturnAge ?? state.player.age + 1 };
    currentClubId = mods0.loanOutTo;
    completedLoan = undefined; // a new loan supersedes the post-loan window
  } else if (mods0.newClubId) {
    // a permanent transfer clears any active loan and moves clubs.
    activeLoan = undefined;
    currentClubId = mods0.newClubId;
  } else if (activeLoan && state.player.age >= activeLoan.returnAge) {
    // loan expired → return to parent club at the start of this period (the
    // return fell on a period boundary — e.g. long pace's per-season
    // granularity, where the loan season was its own period). The per-season
    // return check inside the loop below handles mid-period returns.
    completedLoan = { parentClubId: activeLoan.parentClubId, loanClubId: activeLoan.loanClubId };
    currentClubId = activeLoan.parentClubId;
    activeLoan = undefined;
  }
  // `let` — the season loop reassigns these per iteration: a mid-period loan
  // return changes currentClubId, and simOneSeason/growthDelta/applyCeiling must
  // use the CURRENT season's club, not the pre-loop one (loan-design §3.2).
  let club = clubById(currentClubId);
  let league = leagueById(club.leagueId);
  let currentLeagueId = league.id;

  // 青训抉择 stamp: the academy choice resolved with newClubId → consumed
  // above (currentClubId is now the chosen club). Stamp it as the career's real
  // start (startClubId/startLeagueId) and clear academyPending so season 1
  // runs at the chosen academy (not the placeholder). Skips cleanly for every
  // non-academy period (academyPending already false / no newClubId).
  let academyPending = state.academyPending ?? false;
  let startClubId = state.startClubId;
  let startLeagueId = state.startLeagueId;
  if (academyPending && mods0.newClubId) {
    academyPending = false;
    startClubId = currentClubId;
    startLeagueId = league.id;
  }

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
  // 能力变化 (overallDelta) 期初一次性应用——豁免俱乐部天花板（事件是球员自己的
  // 突破/折损，不是俱乐部训练能带到哪）；天花板只约束 growthDelta 的训练成长。
  const mods = state.pendingMods ?? EMPTY_MODS;
  const blessings = state.blessings ?? EMPTY_BLESSINGS;
  // branching consequences: new tags from the previous choice are added, and
  // existing tags decay by one period (tags carry a TTL, e.g. "fan_darling@2").
  // 边缘失位 (lost_spot): 永久转会(newClubId)清掉上家结下的 lost_spot——新俱乐部
  //   不背旧主队的状态债(与 belowStandardRun 转会即重置同口径: 新东家、新表现账)。
  //   租借另算(暂离学艺, 归队时旧账仍在)。
  const transferredOut = !!mods0.newClubId;
  const prevTags = (state.statusTags ?? EMPTY_TAGS)
    .map(decayTag).filter((t): t is string => t !== null)
    .filter((t) => !(transferredOut && tagName(t) === "lost_spot"));
  const newTags = mods.addTags ?? EMPTY_TAGS;
  let statusTags = dedupeTags([...newTags, ...prevTags]);
  // P1: accumulate identity tags ever held — the career-long "build". Bare
  //  names (TTL is irrelevant to identity). Unioned each period so a tag earned
  //  once stays in the career's identity record after its TTL decays.
  let personaTagsEver = [
    ...new Set([
      ...(state.personaTagsEver ?? EMPTY_TAGS),
      ...statusTags.filter((t) => PERSONA_TAG_KEYS.has(tagName(t))).map(tagName),
    ]),
  ];
  // 词条成型: both source tags ever held → the combo comes online NOW, before
  // this period's seasons, so its payoff applies to the very next campaign.
  // milestonesSeen is the once-per-run gate; ≤1 activation per period.
  const newCombo = COMBO_DEFS.find((c) => !(state.milestonesSeen ?? EMPTY_SEEN).includes(c.id)
    && c.needs.every((n) => personaTagsEver.includes(n)));
  if (newCombo) {
    statusTags = [...statusTags, ttlTag(newCombo.id, 99)];
    personaTagsEver = [...personaTagsEver, newCombo.id];
  }
  // P-ENDGAME: 事件能力变化豁免俱乐部天花板——事件是球员自己的突破/折损（一场决赛、
  //  一次重伤、一个认证里程碑），不是俱乐部训练能带到哪。天花板只约束 growthDelta
  //  的训练成长（防止青年期尖峰堆到 99）；事件 delta 是越过天花板冲 99 的杠杆（英雄
  //  指标 #1：巅峰总评）。负数（折损/衰退）原样穿过——球星转会降档不失水准。
  const ovr = mods.overallDelta ?? 0;
  if (ovr !== 0) {
    player = { ...player, overall: clamp(player.overall + ovr, 40, 99) };
  }

  const periodLength = state.periodLength ?? PERIOD_LENGTH;
  // P-A4: trophy streak — consecutive trophy seasons. Resets on a dry season.
  let trophyStreak = state.trophyStreak ?? 0;
  let bestStreak = state.bestStreak ?? 0;
  for (let i = 0; i < periodLength; i++) {
    if (player.age > MAX_AGE) break;
    // 租借赛季内归还 (loan-design §3.2): a 1-season loan returns the season the
    // player reaches returnAge (= acceptAge + 1) — for normal pace that's the
    // 2nd season of the loan period. Return BEFORE simming this season so it
    // plays at the parent club. The top-of-period check above only catches
    // period-boundary returns; this catches mid-period ones.
    if (activeLoan && player.age >= activeLoan.returnAge) {
      completedLoan = { parentClubId: activeLoan.parentClubId, loanClubId: activeLoan.loanClubId };
      currentClubId = activeLoan.parentClubId;
      activeLoan = undefined;
    }
    // recompute per season — a mid-period return swapped currentClubId
    club = clubById(currentClubId);
    league = leagueById(club.leagueId);
    currentLeagueId = league.id;
    // P-NAT: career-level national context for this season — prior call-up
    // count drives the debut / captain milestones. Seasons written before the
    // `national` field fall back to an OVR≥70 proxy for prior call-ups (the flat
    // call-up threshold). The track is additive — call-ups/trophies unchanged.
    const priorCalledUpCount = seasons.filter((s) => s.national?.calledUp ?? s.overall >= 70).length;
    // hasBeenClubCaptain 本期即生效: 本期持有袖标(含上期 resolve 刚加的 captain@TTL)
    // 当期就算"当过", 无 1 期滞后——接袖标当季即可竞争国家队队长。
    const natCtx: NationalContext = { priorCalledUpCount, hasBeenClubCaptain: (state.hasBeenClubCaptain ?? false) || statusTags.some((t) => tagName(t) === "captain") };
    // 边缘失位: lost_spot(上期低迷被拿下首发)折成 roleShift −1。不与事件 roleShift
    //   叠加(事件已降顺位时不再多降一档)、不抵消事件降档(事件 −2 仍生效)——
    //   仅当本期无事件降档(effShift >= 0)时 lost_spot 才下压一档。roleOverride 优先
    //   级最高(事件明确定位时不被动摇; 转会本就清掉 lost_spot)。
    const lostSpot = statusTags.some((t) => tagName(t) === "lost_spot");
    let effShift = mods.roleShift ?? 0;
    if (lostSpot && effShift >= 0) effShift = -1;
    const developmentRole = mods.roleOverride ?? resolveRoleWithShift(player.overall, club, player.position === "GK", effShift || undefined);
    const season = simOneSeason(seed, player, club, league, mods, developmentRole, i, periodIndex, awards.filter(a => a === "ballon_dor" || a === "golden_glove").length, blessings, state.ascension, state.tournamentOffset ?? 0, statusTags.some((t) => tagName(t) === "captain"), natCtx, statusTags.map(tagName).filter((t) => t.startsWith("combo_")));
    seasons.push(season);
    trophies = [...trophies, ...season.trophies];
    awards = [...awards, ...season.awards];
    // 巅峰唯一写入点: 只有「真正踢过一个赛季的能力」才算生涯巅峰。赛季间的瞬时
    // 值(期末成长/comeback 回血)一律不记——它们在任何界面上都没
    // 显示过(顶栏能力徽章读的是已揭示赛季的 overall), 而下期开局的负向 mods
    // (伤病/overallDelta) 会在首季开踢前就把它抹掉。旧实现每处都写一次
    // maxOverall, 于是这些「从未存在过的能力」被逐期累积成高于账本任意一行的
    // 假巅峰(实测可虚高 9 点)。单一写入点 = 巅峰恒等于账本里最高的那一行。
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
    // P-RATING/P-PERF: 评分先折成「相对这家俱乐部标准」的档位分, 再由 growthDelta
    // 与上场时间合并查预算表 GROWTH_PERF_BONUS。判定用相对值而非绝对评分——在
    // 云南玉昆拿 7.5 和在皇马拿 7.5 不是一回事, 后者难得多; 标准线复用
    // forcedExitBar(按声望 6.5→6.9), 它本来就是管理层的及格线。旧实现是绝对阈值
    // 的两端阶跃(≥8.0 +1 / <6.3 −1), 实测 68.5% 的赛季落在中间死区 —— 7.9 分和
    // 6.4 分的赛季长得一模一样, 而「表现」本该是玩家最能感知的成长杠杆。
    // 0 出场/伤病季(rating null)与青年队赛季(squadLevel === "youth")记 0 分 ——
    // 宽限, 与 forced-exit 的 grace / 青年队不参与评分闭环一致。
    const sr = season.rating;
    const ratingScore = sr == null || season.squadLevel === "youth" ? 0
      : (RATING_GROWTH_BANDS.find((b) => sr - forcedExitBar(club) >= b.minDiff)?.delta ?? 0);
    let delta = growthDelta(rng, player, developmentRole, club, state.ascension, declineDelay, ratingScore);
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
    // P-ENDGAME: apply the club development ceiling to the FINAL growth delta —
    // AFTER all multipliers (glass_cannon ×1.5, late_bloomer, pp_scout) so the
    // cap binds the actual OVR gain, not the pre-multiplier base. growthDelta
    // returns the raw club-rep delta; without this, glass_cannon re-inflated
    // the ceiling'd delta past the cap and full-prestige endgames bloated to a
    // 97-99 median. Decline (delta ≤ 0) passes through unchanged.
    if (delta > 0) delta = applyCeiling(delta, player.overall, club, state.ascension);
    // ADR-0004: 已删 ASC_DEV_DRAIN 隐藏暗扣——飞升对峰值的压制改由 applyCeiling
    //   内的 ASC_CEIL_DROP 天花板偏移承担（可见、经转会可对抗），不再每季隐藏扣分。
    let newOvr = clamp(player.overall + delta, 40, 99);
    // ADR-0005 L4 岁月催人 diegetic beat: 衰退首次咬到（growthDelta 返回负 = 衰退档
    //   激活）时的一次性身体叙事。player.age 此处仍是本赛季年龄（未 +1）。
    //   asc≥4 衰退 onset 提前到 ~28，故 age≤29 用「比同龄人更早」呼应（不点名机制）。
    if (delta < 0 && player.age >= 28) beats = appendDeclineBeat(beats, player.age);
    player = { ...player, age: player.age + 1, overall: newOvr };
  }

  // 边缘失位 (lost_spot) 的评估与盖印放在本期决策构建之后(见下文)——必须晚于
  //   forcedExitDue 的计算, 否则盖印当期就会压住 forced-exit(2 季不达标该卖却
  //   被豁免)。lost_spot 只作用于「下期」的降档, 不该影响「本期」的离队判定。

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
  if (player.age >= 26 && player.overall < forceRetireFloor(state.ascension)) {
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
      formerClubIds, seasons, tournamentOffset: state.tournamentOffset ?? 0,
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
    // 边缘失位 grace: lost_spot 活跃期(被降档那一期)豁免 forced-exit——降档本身
    //   已是「第 1 季低迷」的代价, 不该同期再卖(第 2 季仍在板凳上就被赶走, 等于
    //   降档即死刑, 违背「可逆不螺旋」)。给降档期 + 复位期两季喘息: 复位后仍
    //   连续不达标才被卖(3 季不达标, 而非 2)。lost_spot 在本期决策构建之后才盖
    //   印, 故「盖印当期」(N)这里 statusTags 还无 lost_spot → forced-exit 照常
    //   (2 季不达标该卖就卖); 「降档当期」(N+1) statusTags 有 lost_spot@1 → 豁免。
    const lostSpotActive = statusTags.some((t) => tagName(t) === "lost_spot");
    const forcedExitDue = shouldTriggerForcedExit(seasons, club) && !lostSpotActive;
    // onOngoingLoan: the player is still out at the loan club this period
    // (activeLoan survived the season loop — didn't return). While true the T
    // channel is fully suppressed — the contract belongs to the parent club,
    // you can't be transferred / forced out / retained mid-loan. Only S events
    // (injury, narrative, World Cup climax) and the post-loan return decision
    // (completedLoan, which fires once activeLoan cleared) can occur.
    const onOngoingLoan = !!activeLoan;
    const { special, transfer } = buildPeriodDecisions({
      seed, player, club, league, periodIndex, rngState,
      blessings: state.blessings ?? EMPTY_BLESSINGS,
      injuriesTaken: state.injuriesTaken ?? 0,
      ascension: state.ascension,
      statusTags,
      lastSeasonRelegated,
      plan,
      periodLength,
      completedLoan,
      maxOverall,
      blockbusterOfferedTier: state.blockbusterOfferedTier,
      permPerks: state.permPerks ?? EMPTY_PERKS,
      formerClubIds,
      recentMarketValue,
      recentRating,
      severeInjuries: state.severeInjuries ?? 0,
      injuryWarned: !!state.injuryWarned,
      verdictSeenAt: state.verdictSeenAt ?? 0,
      forcedExitDue,
      stateTournamentOffset: state.tournamentOffset ?? 0,
      careerEventsSeen: state.careerEventsSeen ?? EMPTY_SEEN,
      onOngoingLoan,
      failStreak: state.failStreak ?? 0,
      seasons,
    });
    // NOTE: completedLoan is NOT cleared here — it must persist while the
    // post-loan decision (post_loan, or the retained transferEvent) is pending
    // in the queue, because rebuildResolve needs it to reconstruct the
    // post_loan resolve after a refresh. It's consumed in resolveChoice when
    // the player actually resolves the post-loan decision (loan-design §3.3).

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

  // 边缘失位 (lost_spot): 在本期决策构建之后盖印——评估本期最后一季(最近状态)。
  //   一个边缘主力(能力勉强占住首发、OVR 缓冲 < +3)踢出低于俱乐部标准线的一季 →
  //   下期被拿下首发(lost_spot@2 → 下期衰减为 @1 → roleShift −1 一期 → 到期复位)。
  //   填补「1 季低迷无后果 ↔ 2 季不达标被卖」之间缺失的「先坐一季板凳」那一拍。
  //   放在决策构建之后是为了让 forcedExitDue(上文)在本期不受 lost_spot 影响——
  //   盖印当期(N)2 季不达标照常被卖; 降档当期(N+1)享 grace(见上文 forcedExitDue)
  //   给复位期喘息。真球星(diff≥3)豁免; 仅 senior; 永久转会已清旧 lost_spot。
  const lastSeason = seasons[seasons.length - 1];
  if (lastSeason && shouldLoseSpot(lastSeason, clubById(lastSeason.clubId))) {
    statusTags = dedupeTags([...statusTags, ttlTag("lost_spot", 2)]);
    beats = [...beats, { age: lastSeason.age, season: seasons.length, text: `${lastSeason.age}岁状态低迷，被主帅拿下首发——下赛季从替补席重新打起。`, tone: "bad" }];
  }

  // P-A4: milestone detection — a first-time career peak/trophy crossing earns
  // a full-screen celebration popup (once per run, via milestonesSeen).
  // P-A17: peak market value this run (for the €50M/€100M milestone).
  const peakMv = seasons.length > 0 ? Math.max(...seasons.map((s) => s.marketValue ?? 0)) : 0;
  // 词条成型 outranks the regular milestone this period — the regular one is
  // not consumed (milestonesSeen untouched for it) so it re-detects next period.
  const comboMilestone: Milestone | undefined = newCombo ? {
    id: newCombo.id, title: newCombo.name, desc: newCombo.commentary, tone: "legendary",
    age: player.age, moment: "combo", commentary: newCombo.commentary,
    combo: { from: newCombo.fromLabels, effect: newCombo.effect },
  } : undefined;
  const milestone = comboMilestone
    ?? detectMilestone(state, maxOverall, trophies, awards, player.age, peakMv, seasons)
    ?? detectCareerRecap(seasons, state.milestonesSeen ?? EMPTY_SEEN);
  const milestonesSeen = milestone ? [...(state.milestonesSeen ?? EMPTY_SEEN), milestone.id] : (state.milestonesSeen ?? EMPTY_SEEN);

  return {
    ...state,
    player,
    currentClubId,
    currentLeagueId,
    // 青训抉择 stamp (or unchanged for non-academy periods).
    academyPending,
    startClubId,
    startLeagueId,
    activeLoan,
    completedLoan,
    seasons,
    trophies,
    awards,
    maxOverall,
    ...(() => {
      const { raw, settled } = legacyPair({ ...state, seasons, trophies, awards, maxOverall, player });
      return { legacy: settled, rawLegacy: raw };
    })(),
    age: player.age,
    statusTags,
    // career-persistent: once the armband is worn it's worn forever (the TTL
    // tag decays but the fact doesn't) — gates the national-team captain gate.
    hasBeenClubCaptain: (state.hasBeenClubCaptain ?? false) || statusTags.some((t) => tagName(t) === "captain"),
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
    // Freeze the momentum streak the queue was BUILT with: every resolve in
    // this period (closure ctx AND rebuildResolve after a refresh) reads this
    // value, so an earlier decision in the queue moving the live counter can
    // never change a later decision's roll — refresh-determinism holds.
    resolveFailStreak: state.failStreak ?? 0,
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

/** Consecutive below-standard seasons at `club`, walking back from the
 *  latest season. A 0-app/suspended season (rating null) now COUNTS as
 *  below-standard (杠杆3): a season you couldn't play = a season you didn't
 *  meet the standard — null coerces to 0 < bar. The threshold of 2
 *  (shouldTriggerForcedExit) provides the single-absence grace: one injury/ban
 *  season alone can't force you out, but two consecutive absences (or an
 *  absence + a poor comeback) can. Stops at the first passing season or a
 *  club change (transfer resets). */
function belowStandardRun(seasons: readonly SeasonResult[], club: Club): SeasonResult[] {
  const bar = forcedExitBar(club);
  const run: SeasonResult[] = [];
  for (let i = seasons.length - 1; i >= 0; i--) {
    const s = seasons[i]!;
    if (s.clubId !== club.id) break;
    if (s.squadLevel === "youth") continue;
    const r = s.rating;
    if (r === undefined) continue;   // back-compat: season pre-rating — unjudgeable
    // r === null (0-app/suspended) counts as below-standard — long-term
    //  unavailability is itself 「不达标」, no longer invisible grace.
    if (r === null || r < bar) run.unshift(s);
    else break;
  }
  return run;
}
/** The single forced-exit trigger: ≥2 consecutive below-standard seasons
 *  at this club. Pure, no rng — the resolve roll lives in the event. */
function shouldTriggerForcedExit(seasons: readonly SeasonResult[], club: Club): boolean {
  return belowStandardRun(seasons, club).length >= 2;
}
/** 边缘失位 (lost_spot) 触发: 一个边缘主力本季被拿下首发吗？
 *  边缘主力 = 能力勉强占住首发(OVR vs 俱乐部梯队基线缓冲 < +3, 即 diff 0–2),
 *  本季以主力身份踢出低于俱乐部标准线的一季。这是「1 季低迷无后果」与
 *  「2 季不达标被卖」之间缺失的「先坐一季板凳」一拍——真实足球里边缘主力
 *  状态差先被拿下首发, 连续不达标才被卖。真球星(diff ≥ +3)豁免: 皇马不会
 *  因一个 6.5 分赛季把 92 扛下板凳, 给挽留余地。仅评 senior 季(青训是养成
 *  不评状态); rating null(0 出场/停赛)不触发(没踢不等于踢得差)。Pure, no rng。
 *  下期由 lost_spot@2(衰减为 @1)折成 roleShift −1 一期, 到期自动复位。 */
function shouldLoseSpot(season: SeasonResult, club: Club): boolean {
  if (season.squadLevel !== "senior") return false;
  if (season.role !== "starter") return false;
  const base = SQUAD_BASE[clamp(club.rep, 0, 9)]!;
  if (season.overall - base >= 3) return false;   // established star — benefit of the doubt
  const r = season.rating;
  if (r === undefined || r === null) return false;
  return r < forcedExitBar(club);
}
/** 杠杆3: 强制离队是否由「长期打不了球」(suspended 季)驱动, 而非「踢得差」。
 *  最近的不达标连续季里若含 suspended 季 → 「长期缺阵」走不续约出口 (合同到期
 *  不续), 不是 underperform/stuck (踢得差被赶)。调用方再以顺位门控: 主力球星
 *  长期伤停俱乐部会等 (高顺位不触发), 板凳球员长期打不了球则不续约 (低顺位触发)。 */
function suspensionDrivenExit(seasons: readonly SeasonResult[], club: Club): boolean {
  return belowStandardRun(seasons, club).some((s) => s.suspended);
}

function simOneSeason(
  seed: string,
  player: Player,
  club: Club,
  league: League,
  mods: Modifiers,
  developmentRole: Role,
  seasonInPeriod: number,
  periodIndex: number,
  priorMajorAwards: number,
  blessings: readonly string[],
  ascension: number,
  toff = 0,
  captain = false,
  natCtx: NationalContext = { priorCalledUpCount: 0, hasBeenClubCaptain: false },
  combos: readonly string[] = EMPTY_TAGS,
): SeasonResult {
  const isGK = player.position === "GK";
  // 青训赛季 = 3 年（16-18 岁）。原 2 年（<=17）在 normal/express 节奏下会让青训
  // 叙事事件的决策点错位到 senior 期（normal 18 岁 period 末、express 19 岁，
  // 最后 season 已是 senior → 青训事件 gate isYouth 读 age<=19 仍在 senior 期触发，
  // 叙事与「青训营」场景冲突）。扩到 3 年后，三种 pace 第一个决策点的最后 season
  // 都是 youth，青训事件能在青训赛季内触发（见 production/qa/playtests/
  // playtest-2026-08-12-scout-attention-role-gate.md「举一反三·age 路由」章节）。
  const isYouth = player.age <= 18;
  const squadLevel: SeasonResult["squadLevel"] = isYouth ? "youth" : "senior";
  const role = isYouth
    ? mods.roleOverride ?? resolveYouthRoleWithShift(player.overall, club, isGK, mods.roleShift)
    : developmentRole;
  // 伤病潮 (ascension 2): each season a small chance of a nagging injury that
  // costs the player part of the season (a 轻伤, not a season-ender). Base 2% → 5% at asc 2
  // (the old 3% was a dead rung — measured zero median impact; see
  // tools/ascension-probe). Event injuries also cut 1 OVR deeper (events.ts).
  // 玻璃大炮 (glass_cannon blessing): injury rate ×3 — the cost of +50% growth.
  let injuryProne = ascension >= 2 ? 0.05 : 0.02;
  if (blessings.includes("glass_cannon")) injuryProne *= 3;
  const nagRng = derive(seed, "nag-injury", player.age, periodIndex, seasonInPeriod);
  const nagInjury = chance(nagRng, injuryProne);
  // 停赛单季化(杠杆1): mods.suspended 只作用于本期第一季(seasonInPeriod===0)。
  //  一次禁赛最多停 1 季, 不再随 periodLength 放大成整期 N 季——真实足球里禁赛/
  //  伤停几乎一律只影响 1 季, 连续两季 0 出场=生涯终结而非「坐满再踢」。long 节奏
  //  (plen=1) 每季都是 season 0, 行为不变; normal/express 只停第一季, 第二/三季照踢。
  const suspended = !!mods.suspended && seasonInPeriod === 0;
  // 少踢单季化(杠杆1 的同胞): mods.statsMultiplier 与 suspended 同样只作用于本期
  //  第一季。这个字段的语义就是单季的——types.ts 写明它模型化「本期因轻度伤停/
  //  禁赛/恐惧缺席等**只损失部分赛季**的情况」, 而事件文案讲的也是单季的事
  //  (毁灭性伤病:「恢复期一年」)。把「你缺了大半个赛季」按整期 N 季重放, 既不是
  //  这个字段的意思, 也和卡面对不上。
  //  之前没有这道门, 于是同一张卡在三种节奏下代价差 3 倍, 而卡面三种节奏都只画
  //  一个「出场减少」(实测 statsMultiplier=0.1: long 报销 1 季 / normal 2 季 /
  //  express 3 季)。全表 21 处取值 0.1–0.8, 无一 >1——这是个纯罚项, 所以放大的是
  //  单向难度, 不是双向权衡: pace 本是「几季一次决策」的节奏偏好, 却成了没写在
  //  任何地方的难度旋钮 (OVR 增减是每期一次性应用, 不随节奏放大, 于是 express
  //  拿同样的上行、吃 3 倍的下行)。玩家上报的 25 岁毁灭性伤病正是 express。
  //  跨期的持续后果有自己的通道 (addTags 带 TTL), 不该借这个字段实现。
  //  long 节奏(plen=1) 每季都是 season 0, 行为不变。
  const eventStatsMult = seasonInPeriod === 0 ? (mods.statsMultiplier ?? 1) : 1;
  // nag 轻伤与事件 statsMultiplier 纯乘性叠加（禁赛 + 同季小伤 = 错过更多）；
  //  被停赛的那一季(season 0)倍率无意义（直接归零）; 后续季 suspended=false。
  //  nag 不再整季停赛——一个小伤不该读成「停赛」整季报销，只该少踢。nag 是每季
  //  各自掷的(derive 带 seasonInPeriod), 本就是单季事件, 不受上面那道门影响。
  const statsMultiplier = eventStatsMult * (nagInjury ? 0.6 : 1);

  // stats
  const statsRng = derive(seed, "stats", player.age, periodIndex, seasonInPeriod);
  const stats = simSeasonStats(statsRng, player.overall, player.position, league, club, role, suspended, blessings, statsMultiplier, squadLevel);

  // club trophies — driven by CLUB strength (realistic: one player can't carry a
  // minnow to a title; you must transfer up). Indexed by club.rep, not league rep.
  // 飞升 10 全面降级: every club is treated one rep tier weaker (弱旅地狱).
  const effClub = ascension >= 10 ? { ...club, rep: Math.max(0, club.rep - 1) } : club;
  // 洲际主豁免于全面降级：传真实 club.rep 给 continental-primary gate+odds，
  // effClub（已降档）仍用于 league/cup/洲际副/CWC。见 clubTrophyCandidates primaryRep。
  const candidates = isYouth ? [] : clubTrophyCandidates(player.overall, effClub, league, player.age, toff, captain, combos, club.rep);
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
  // 飞升 9「国家队弃子」: the call-up bar rises by ASC9_CALLUP_SURCHARGE instead
  // of the path being closed outright. See NationalOverrides.callupThresholdSurcharge.
  // P-NAT: the parallel national track (caps/goals/standing/tournament stage)
  // accumulates every season on top of the unchanged call-up/trophy logic.
  const nat = simulateNational(seed, player, player.age, {
    nationalTrophyOverride: mods.nationalTrophyOverride,
    worldCupResultOverride: mods.worldCupResultOverride,
    nationalTournamentParticipation: mods.nationalTournamentParticipation,
    callupThresholdSurcharge: ascension >= 9 ? ASC9_CALLUP_SURCHARGE : 0,
    nationalTournament: mods.nationalTournament,
    forceNationalCaptain: mods.forceNationalCaptain,
  }, toff, natCtx);
  const nationalTournaments = nat.trophies.map((t) => ({ trophy: t.trophy, stage: t.stage }));
  for (const t of nat.trophies) trophies.push(t.trophy);

  // national-track-youth-olympic: youth team + Olympics, mutual-exclusive with
  // the senior side (§C0.1: senior > olympic > youth). Only when the senior
  // team did NOT call the player up — a senior-cap-eligible star plays the
  // senior side, not youth/Olympics. 飞升 9 closes the WHOLE national line
  // (senior already skip'd above; youth/olympic follow the same gate).
  // Olympics: the 'first big tournament' — gated ≤24 + the U21 youth bar; wins
  // gold (exposure-tier, into the cabinet — honour bloat is welcome). No
  // climax, no pendingChoice (the WC stays the sole boss tournament).
  let youthNational: YouthNationalSeason | undefined;
  if (!nat.calledUp && ascension < 9) {
    if (isOlympicAge(player.age, toff)) {
      const gold = simulateOlympic(seed, player, player.age, toff);
      if (gold) { trophies.push(gold.trophy); nationalTournaments.push({ trophy: gold.trophy, stage: gold.stage }); }
      // Olympic-eligible seasons are NOT also a youth-team season (Olympic >
      // youth in the priority chain) — a young player in an Olympic year plays
      // the Olympics, not the U21 youth side that year.
    } else {
      youthNational = simulateYouthNational(seed, player, player.age);
    }
  }

  // awards
  const seasonAwards = isYouth ? [] : rollAwards(seed, player.age, player.overall, player.position, stats, trophies, priorMajorAwards, league, nationById(player.nationalityId)?.confederation);

  // P-A5: season honors — league best XI (toty) and season MVP. A starter with
  // high OVR relative to the league + strong stats has a chance. MVP is rare.
  const seasonHonors: ("mvp" | "toty")[] = [];
  if (!isYouth && role === "starter" && !suspended) {
    const totyRng = derive(seed, "toty", player.age, periodIndex, seasonInPeriod);
    // TOTY (P-GATE): league Best XI is for genuine starters ABOVE the league's
    // general level — a 70-OVR squad player is not in the conversation. Floor
    // raised 70→76 (a clear starter at a mid club / a star at a small club);
    // below 76 there is NO chance (a hard bar). Rate ramps 4%→18% from 76→88+
    // so a star grades higher, but weak players no longer farm Best XI (was
    // 4% at 70 → 13-16% of sub-78 careers got a Best XI appearance).
    const totyBase = player.overall >= 76 ? clamp(0.04 + (player.overall - 76) * 0.012, 0.04, 0.18) : 0;
    if (chance(totyRng, totyBase)) {
      seasonHonors.push("toty");
      // MVP: only if in TOTY, requires exceptional stats. Lowered so a career
      // gets ~0-2 MVPs, not one every season — the rare honor it should be.
      const mvpRng = derive(seed, "mvp", player.age, periodIndex, seasonInPeriod);
      // P-POS: position-aware `statGreat`. Was a 3-way split — GK(零封≥22) /
      //   前锋(进球≥28) / 其余(进球+助攻≥25) — that lumped defenders (CB/LB/RB/
      //   CDM) in with creators on goals+assists≥25, a bar a defender almost
      //   never clears, so a great CB season (VVD 式) had NO path to league MVP
      //   while a 25-G+A creator season did. Defenders now gate on clean sheets
      //   like GK — a shutout is the counting stat the sim gives the defensive
      //   group (defensiveCleanSheets), so a 17-shutout season reads as the same
      //   "elite campaign" a 28-goal season does for a striker.
      //   阈值≥17（数据，非手填）：实测首发季零封 p50=14、p90=17、max≈21
      //   （csProb 上限 0.5 × ~38 场 ≈ 16，结构上限在此）。`cs≥17` 对应 DEF 14.2%、
      //   GK 17.7% 的首发季占比，与前锋 `goals≥28` 的 15.2% 几乎同率——三档
      //   精英门槛统一在「约 15% 首发季可达」，内一贯。
      //   附带修一个潜在 bug：原 GK `cleanSheets ≥ 22` 实测 0% 可达（max 21），
      //   GK 的「精英赛季 14% MVP 路径」长期失效、只剩 3% 底线。≥22 是未对照
      //   分布定的校准错误；改 ≥17 后伟大门神几季一个 MVP（不离谱，金球/
      //   金手套 GK 本就能拿）。GK 与 DEF 共用同一零封门槛，二者一致。
      //   余下「组织」(CM/CAM/LM/RM) 沿用进球+助攻≥25 —— 创作者的招牌产出。
      const isDefensive = player.position === "GK"
        || player.position === "CB" || player.position === "LB" || player.position === "RB"
        || player.position === "CDM";
      const isAttacker = player.position === "ST" || player.position === "LW" || player.position === "RW";
      // goals≥28 / cleanSheets≥17 走 SIGNATURE_ELITE（与赛季精英 chip 同源, 零漂移);
      // creator/support 的 MVP 资格用 ga+as≥25（chip 的助攻签名阈值 18 另走, 见 data.ts）。
      const statGreat = isDefensive
        ? stats.cleanSheets >= SIGNATURE_ELITE.cleanSheets
        : isAttacker
          ? stats.goals >= SIGNATURE_ELITE.goals
          : stats.goals + stats.assists >= 25;
      const mvpChance = statGreat ? 0.14 : 0.03;
      if (chance(mvpRng, mvpChance)) seasonHonors.push("mvp");
    }
  }

  // relegation: a weak club in a top flight risks the drop.
  const relegated = isYouth ? false : checkRelegation(seed, player, club, league, seasonInPeriod, periodIndex);

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
    squadLevel,
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
      assists: nat.assists,
      status: nat.status,
      tournament: nat.tournament,
    },
    youthNational,
    relegated,
    suspended,
    seasonHonors,
  };
  const rating = computeSeasonRating(seasonSansFinance, player.position, club, league);
  // a 0-app (suspended/farewell) season can't be rated → fall back to 6.0 so
  // the market-value perf multiplier still docks a season you didn't play
  // (matches the pre-rating behavior).
  const perfRating = rating ?? 6.0;
  const marketValue = computeMarketValue(player.overall, player.age, league, effClub, role, perfRating, trophies.length, seasonHonors.includes("mvp"), seasonHonors.includes("toty"));
  const wage = isYouth ? 0 : computeWage(marketValue, player.overall, league, effClub);

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

function resolveYouthRoleWithShift(overall: number, club: Club, isGK: boolean, shift: number | undefined): Role {
  const base = resolveYouthRole(overall, club, isGK);
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
      if (s.squadLevel === "youth") continue;
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
export function liveLegacy(state: GameState, dignifiedExit?: boolean): number {
  return legacyPair(state, dignifiedExit).settled;
}

/** Both settlements of one career, from a single pass over the seasons.
 *
 *  `raw` (实绩) — the career scored at ascension 0. This is the difficulty-
 *  INDEPENDENT measure of what was actually achieved, and the only honest
 *  input to a rating or a title.
 *  `settled` (传承分) — `raw` put through the per-level compensation curve.
 *  This is the meta CURRENCY: it is deliberately inflated by difficulty
 *  ("生涯表现 × 难度加成"), so it is only comparable INSIDE one ascension level.
 *
 *  The board can still rank on `settled` because it sorts ascension-first and
 *  the curve is monotone in raw, so within a level the two orders coincide. But
 *  a RATING must read `raw` — reading `settled` is what printed 无名之辈 and
 *  球神 on the same summary card. */
export function legacyPair(state: GameState, dignifiedExit?: boolean): { raw: number; settled: number } {
  const seasons = state.seasons;
  const seniorSeasons = seniorCareerSeasonCount(seasons);
  const careerWageTotal = seasons.reduce((s, x) => s + (x.wage ?? 0), 0);
  const finalMarketValue = seasons.length > 0 ? (seasons[seasons.length - 1]!.marketValue ?? 0) : 0;
  const careerStats = seniorCareerStats(seasons);
  const careerGoals = careerStats.goals;
  const careerAssists = careerStats.assists;
  const careerCleanSheets = careerStats.cleanSheets;
  const paceMult = state.pace === "express" ? 0.85 : 1;
  const blessings = state.blessings ?? EMPTY_BLESSINGS;
  const earnMult = legacyEarnMult(blessings, state.permPerks ?? EMPTY_PERKS)
    * blessingShapeMult(seasons, careerGoals, state.player?.age ?? 16, blessings);
  // P-NATION: 弱国出身的传承补偿——按出身国青训档位 (终身烙印,归化不改)。
  const originId = state.player?.originNationalityId ?? state.player?.nationalityId;
  const nationMult = originId ? NATION_LEGACY_MULT[youthTierOf(originId)]! : 1;
  const score = (ascension: number) => scoreLegacy(
    state.maxOverall, seniorSeasons, state.trophies, state.awards,
    ascension, state.retirementReason,
    careerWageTotal, finalMarketValue, dignifiedExit, earnMult, paceMult,
    state.player?.position, careerGoals, careerAssists, careerCleanSheets,
    nationMult,
  );
  const raw = score(0);
  // asc 0 is the identity curve — skip the second pass rather than pay for it
  // on every period advance of every batch-sim career.
  return { raw, settled: state.ascension === 0 ? raw : score(state.ascension) };
}

// ───────────────────────────── period-decision routing ─────────────────────────────

/** A routing rule for one channel (S special / T transfer) of buildPeriodDecisions.
 *  gate is the original `if` condition WITHOUT the !sDone/!tDone guard — the runner
 *  owns "channel already fired → stop". fire returns the event, or null to fall
 *  through to the next rule (the original `if (ev) { ...; xDone=true }` "didn't
 *  fire → keep going" semantics). */
interface RoutingRule {
  gate: () => boolean;
  fire: () => FiredEvent | null;
}
/** A suppress rule: gate passing occupies the channel with NO event (the
 *  onOngoingLoan case — contract still at the parent club, no T decision this
 *  period). */
interface SuppressRule {
  gate: () => boolean;
  suppress: true;
}
/** Run a channel's rules in priority order: the first rule whose gate passes
 *  occupies the channel. A fired event (fire non-null) or a suppress rule stops
 *  the channel; a fire returning null falls through to the next rule.
 *  Replaces the hand-rolled !sDone/!tDone flags + the interleaved 537-line
 *  cascade. Behavior-preserving: every S/T gate draws from its own derive()
 *  namespace (no shared rng) and reads no cross-channel state, so running the
 *  two ordered lists independently reproduces the interleaved cascade exactly. */
function runChannel(rules: readonly (RoutingRule | SuppressRule)[]): FiredEvent | null {
  for (const r of rules) {
    if (!r.gate()) continue;
    if ("suppress" in r) return null;
    const ev = r.fire();
    if (ev) return ev;
  }
  return null;
}

// ───────────────────────────── period decision builder ─────────────────────────────

// 每个事件都是真抉择（≥2 选项、每选项≥2 结果）——buildEvent 已断言
// options.length>=2,故不再有单选项事件需要 flavor 分流;决策台一律弹多选项
// 事件。resolve 路径 derive(seed,"resolve",age,eventKey,choice.id)，确定性一致;
// plan/伤病/seen 计数在 resolveChoice 结账。

interface PeriodDecisionInput {
  seed: string;
  player: Player;
  club: Club;
  league: League;
  periodIndex: number;
  rngState: RngState;
  blessings: readonly string[];
  injuriesTaken: number;
  ascension: number;
  statusTags: readonly string[];
  lastSeasonRelegated: boolean;
  plan: CareerEventPlan | undefined;
  periodLength: number;
  completedLoan: GameState["completedLoan"];
  maxOverall: number;
  blockbusterOfferedTier: number | undefined;
  permPerks: readonly string[];
  formerClubIds: readonly string[];
  recentMarketValue: number;
  recentRating: number | null;
  severeInjuries: number;
  injuryWarned: boolean;
  verdictSeenAt: number;
  forcedExitDue: boolean;
  stateTournamentOffset?: number;
  careerEventsSeen?: readonly string[];
  onOngoingLoan?: boolean;
  failStreak?: number;
  seasons?: readonly SeasonResult[];
}

function buildPeriodDecisions(input: PeriodDecisionInput): { special: FiredEvent | null; transfer: FiredEvent | null } {
  const {
    seed, player, club, league, periodIndex, rngState, blessings,
    injuriesTaken, ascension, statusTags, lastSeasonRelegated, plan, periodLength,
    completedLoan, maxOverall, blockbusterOfferedTier, permPerks, formerClubIds,
    recentMarketValue, recentRating, severeInjuries, injuryWarned, verdictSeenAt,
    forcedExitDue,
    stateTournamentOffset = 0,
    careerEventsSeen = EMPTY_SEEN,
    onOngoingLoan = false,
    failStreak = 0,
    seasons = [],
  } = input;
  const role = resolveRole(player.overall, club, player.position === "GK");
  const ctx: EventContext = {
    player, club, league, seed, age: player.age, role, periodIndex, rngState, blessings,
    injuriesTaken, ascension,
    severeInjuries,
    failStreak,
    plan, periodLength,
    permPerks,
    formerClubIds,
    seasons,
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
  // ── 阶段三双通道：S（特殊事件）与 T（转会/俱乐部处境）各是一条有序路由规则表。
  // runChannel 按 priority 自上而下跑：首条 gate 通过的规则占住该通道——fire 返回事件即弹
  // 并停，返回 null 则继续下一条（原 `if (ev) { ...; xDone=true }` 「没弹就往下走」），
  // suppress 规则（租借进行中）gate 通过即占住不弹。两条通道独立、可并存，队S先T后
  // （见 simulatePeriod）。priority = 列表顺序，可 diff、可重排；「每通道至多一弹」是
  // runChannel 的结构不变量，不再靠手写 !sDone/!tDone 守卫。
  //
  // 行为不变依据：S/T 规则的 gate 只从各自的 derive() 命名空间抽随机（nat-offer /
  // nat-offer-active / cont-reach / wc-reach / retention / throne / fame-offer-roll /
  // loan-offer / injury / pdec:pool / story），互不消费共享 rng，且无任何规则读对方通道
  // 的状态（naturalization 写的 ctx.naturalizationActive 只在 resolve 阶段被读），
  // 故 S/T 拆成独立有序表与原交织级联逐掷骛一致——regress 行为指纹守。

  // S 通道（特殊事件）——优先级自上而下。
  const S_RULES: readonly RoutingRule[] = [
    // 医学退役 (P-B1): 3rd severe injury → 判决；2nd → 队医警告。走 S 通道：可与
    // T 转会并存——玩家选退役即 forceRetire 短路丢弃转会；赌一把成功则转会照常弹。
    { gate: () => severeInjuries >= 3 && verdictSeenAt < severeInjuries,
      fire: () => medicalVerdictEvent(ctx) },
    { gate: () => severeInjuries >= 2 && !injuryWarned,
      fire: () => doctorWarningEvent(ctx) },
    // 归化邀约·被动路径：已退出国家队会籍（intl_retired）被更强的他国足协看中。35% 门。
    // 归化设 newNationalityId（非 newClubId），可与 T 转会并存。先于 climax（改变 nationality
    // 直接影响 WC climax 国家判定）。
    { gate: () => ctx.statusTags.includes("intl_retired")
        && !ctx.statusTags.includes("naturalized")
        && player.age >= 20 && player.age <= 32
        && player.overall >= 72
        && nationById(player.nationalityId).fifaRep <= 3
        && chance(derive(seed, "nat-offer", player.age, periodIndex), 0.35),
      fire: () => { ctx.naturalizationActive = false; return fireEventByKey(ctx, "naturalization_offer"); } },
    // 归化邀约·主动路径：未被逼退、但够强且母国弱，被更强足协主动看中。8% 门。与被动
    // 互斥（本路径要求 !intl_retired）。走 S 通道，先于 climax。
    { gate: () => !ctx.statusTags.includes("intl_retired")
        && !ctx.statusTags.includes("naturalized")
        && player.age >= 20 && player.age <= 32
        && player.overall >= 72
        && nationById(player.nationalityId).fifaRep <= 3
        && chance(derive(seed, "nat-offer-active", player.age, periodIndex), 0.08),
      fire: () => { ctx.naturalizationActive = true; return fireEventByKey(ctx, "naturalization_offer"); } },
    // climax events: a national-team tournament year is upcoming. EARNED, not assured —
    // needs the player good enough (OVR) AND a reach roll. Strong nations → World Cup
    // (qualifier for rising stars / final for stars); minnow nations → continental cup.
    // Pre-emptive: the showdown's override mods land on NEXT period's seasons, so it
    // fires the period BEFORE the tournament year. (IIFE keeps the year/nation
    // precompute local to this rule — locality: a rule's inputs sit with its code.)
    (() => {
      const toff = stateTournamentOffset;
      const wcBase = 19 + toff, contBase = wcBase - 1;
      let contClimaxAge: number | undefined, wcClimaxAge: number | undefined;
      for (let a = player.age; a < player.age + periodLength; a++) {
        if (a >= contBase && (a - contBase) % 4 === 0) contClimaxAge = a;
        if (a >= wcBase && (a - wcBase) % 4 === 0) wcClimaxAge = a;
      }
      const nation = nationById(player.nationalityId);
      const fifaRep = clamp(nation.fifaRep, 0, 5);
      const contRep = clamp(nation.contRep, 0, 6);
      const isMinnow = fifaRep <= 1 && contRep <= 2;
      // 飞升9「国家队弃子」抬【常规】入选门槛 +8，但世界杯 showdown 奇迹入口豁免这 +8。
      const callupSurcharge = ascension >= 9 ? ASC9_CALLUP_SURCHARGE : 0;
      return {
        gate: () => contClimaxAge !== undefined || wcClimaxAge !== undefined,
        fire: (): FiredEvent | null => {
          const bareTags = ctx.statusTags;
          // (1) 洲际杯 climax —— 弱国专属：足球荒漠的现实梦是亚洲杯/美洲杯。reach 按
          //   contRep 分档每周期重掷，win 0.30–0.50。
          if (contClimaxAge !== undefined && isMinnow) {
            // P-GATE: floor 78 — a minnow's HERO carries them to a continental final.
            if (player.overall >= CONT_FINAL_FLOOR + callupSurcharge && !bareTags.includes("cont_boss_done")) {
              const reachOdds = contRep >= 2 ? 0.40 : 0.20;
              if (chance(derive(seed, "cont-reach", contClimaxAge), reachOdds)) {
                let odds = contRep >= 4 ? 0.50 : contRep >= 2 ? 0.40 : 0.30;
                if (ascension >= 5) odds *= 0.7;   // 诸神黄昏 −30%
                if (ascension >= 6) odds *= 0.9;   // 天命难违 −10%
                odds = clamp(odds + (permPerks.includes("pp_boss_slayer") ? 0.20 : blessings.includes("big_game_player") ? 0.10 : 0), 0.01, 0.95);
                if (bareTags.includes("combo_adopted")) odds = clamp(odds * 1.15, 0.01, 0.95);
                return continentalCupShowdown(contClimaxAge, odds, nation.confederation, blessings, nation.name);
              }
            }
          }
          // (2) 世界杯 climax —— 所有国家：强国预选/决赛、弱国奇迹缝(carry 抬 fifaRep≤3)。
          //   原代码 `if (!sDone && wcClimaxAge...)` 的 !sDone 在这里 = 洲际分支已 return。
          if (wcClimaxAge !== undefined) {
            // P-GATE: path entry = max(callup, 76) — squad call-up 不够扛起世界杯。
            const wcQualFloor = Math.max((CALLUP_THRESHOLD[clamp(nation.intlRep, 0, 5)] ?? 62), WC_QUAL_STARTER_FLOOR);
            if (player.overall >= wcQualFloor) {
              if (player.overall < WC_FINAL_FLOOR && !bareTags.includes("wc_quali_done")) {
                let qOdds = 0.5;
                if (ascension >= 5) qOdds *= 0.7;
                if (ascension >= 6) qOdds *= 0.9;
                qOdds = clamp(qOdds + (permPerks.includes("pp_boss_slayer") ? 0.20 : blessings.includes("big_game_player") ? 0.10 : 0), 0.05, 0.95);
                return worldCupQualifierShowdown(wcClimaxAge, clamp(qOdds, 0.05, 0.95), true, 0, blessings, nation.name);
              }
              if (player.overall >= WC_FINAL_FLOOR && !bareTags.includes("wc_boss_done")) {
                // reach = 国家基线 + 球星 carry(只抬 fifaRep≤3)。career-stable derive key。
                const reachOdds = wcReachOdds(fifaRep, player.overall);
                if (chance(derive(seed, "wc-reach", "career"), reachOdds)) {
                  let odds = fifaRep >= 4 ? 0.30 : fifaRep >= 2 ? 0.27 : 0.30;
                  if (ascension >= 5) odds *= 0.7;
                  if (ascension >= 6) odds *= 0.9;
                  odds = clamp(odds + (permPerks.includes("pp_boss_slayer") ? 0.20 : blessings.includes("big_game_player") ? 0.10 : 0), 0.01, 0.95);
                  if (bareTags.includes("combo_adopted")) odds = clamp(odds * 1.15, 0.01, 0.95);
                  return worldCupShowdown(wcClimaxAge, odds, "世界杯冠军", "功亏一篑", blessings, nation.name);
                }
              }
            }
          }
          return null;
        },
      } satisfies RoutingRule;
    })(),
    // injury roll (P-B1): an ACL doesn't wait for the transfer window. 走 S 通道
    // （不设 newClubId，与 T 并存）。Climax/WC 在其上（boss 优先）。
    { gate: () => true, fire: () => rollInjuryEvent(ctx) },
    // 王座之战: late-career "legend maintenance" boss。85+ starter aged 29+ at a
    // big club (rep≥7) faces a rising heir。throne_done@6 防连弹；~60% arm。
    { gate: () => player.age >= 29 && player.overall >= 85 && role === "starter" && club.rep >= 7
        && !ctx.statusTags.includes("throne_done")
        && chance(derive(seed, "throne", player.age), 0.6),
      fire: () => fireEventByKey(ctx, "throne_challenge") },
  ];

  // T 通道（转会/俱乐部处境）——优先级自上而下。
  const T_RULES: readonly (RoutingRule | SuppressRule)[] = [
    // post-loan resolution: highest priority — a loan just returned。走 T 通道
    // （留/再租/永久转会），替代常规转会窗。
    { gate: () => !!completedLoan, fire: () => postLoanEvent(ctx, completedLoan!) },
    // 租借进行中 → 抑制所有其他 T 决策（合同仍在母队、外租期间不可转会）。suppress：
    // gate 通过即占住 T 通道不弹事件，后续 T 规则全跳过。S 通道不受影响。
    { gate: () => onOngoingLoan, suppress: true },
    // relegation loyalty: 降级去留（留队征战 / 转投争冠队）。relegation_endured tag 防
    // yo-yo 俱乐部每季都问。ONE-SHOT WINDOW，故高于生涯计划槽。
    { gate: () => lastSeasonRelegated && !ctx.statusTags.includes("relegation_endured"),
      fire: () => fireEventByKey(ctx, "relegation_loyalty") },
    // P-RETIRE: soft retention. Past RETENTION_START the body must earn another
    // period。留队失败弹 no_offers（降档续约/挂靴）或 金元邀约（FAME_BID ≤ OVR < FAME_PEAK
    // 的过巅峰球星；飞升7 封金元）。留队成功（roll 过）返回 null → 落到后续 T 规则。
    { gate: () => player.age >= RETENTION_START && !ctx.statusTags.includes("fresh_contract"),
      fire: () => {
        const r = derive(seed, "retention", player.age, periodIndex);
        const prob = retentionProb(player.overall, player.age, club, ctx.statusTags, severeInjuries, blessings, permPerks, ascension);
        if (chance(r, prob)) return null;  // retained — fall through to later T rules
        return (ascension < 7 && player.overall >= FAME_BID_OVR && player.overall < FAME_PEAK_OVR)
          ? fameLeagueBidEvent(ctx) : noOffersEvent(ctx);
      } },
    // 强制离队 (评分机制驱动): 连续 ≥2 季不达标 → 被卖。三条路：禁赛/长期伤停板凳 →
    //   不续约；主力球星长期伤停 → 俱乐部等（返回 null 落到后续 cadence 转会）；豪门青训
    //   板凳 → 外租；其余 → underperform_release/stuck_release。Age 18+ 留青年 grace。
    { gate: () => forcedExitDue && player.age >= 18 && player.age <= 38
        && !ctx.statusTags.includes("stuck") && !ctx.statusTags.includes("underperformed"),
      fire: () => {
        const suspensionDriven = suspensionDrivenExit(seasons, club);
        const isBench = role === "substitute" || role === "low_rotation" || role === "third_keeper";
        if (suspensionDriven && isBench && !ctx.statusTags.includes("contract_crisis")) {
          return fireEventByKey(ctx, "contract_nonrenewal");
        } else if (suspensionDriven && !isBench) {
          return null;  // 主力球星长期伤停 → 俱乐部等。落到后续 cadence 转会等。
        } else {
          const isLoanPath = club.rep >= 5 && player.age <= YOUTH_LOAN_MAX_AGE
            && !completedLoan
            && (role === "substitute" || role === "low_rotation" || role === "third_keeper");
          if (isLoanPath) return loanOfferEvent(ctx);
          // rep≥6 starter (豪门无情) vs everyone else (踢不出来)。
          const evKey = club.rep >= 6 && (role === "starter" || role === "high_rotation")
            ? "underperform_release" : "stuck_release";
          return fireEventByKey(ctx, evKey);
        }
      } },
    // T 通道 · 转会窗 cadence：黄金期(19-31)每 2 季（飞升8 冻结每 5 季）到期即弹常规
    // 转会，或工资挤压变体（wageSqueeze 纯算术无 rng）。非 due 期返回 null → 让位给
    // 后续 situational T。seasonAges 本规则自算（原为函数级共享变量，现局部于此规则）。
    (() => {
      const seasonAges: number[] = [];
      for (let a = player.age - periodLength; a < player.age; a++) seasonAges.push(a);
      return {
        gate: () => isTransferWindowAge(seasonAges),
        fire: () => wageSqueeze(player, club, league, maxOverall).squeezed
          ? wageSqueezeEvent(ctx, maxOverall) : transferEvent(ctx),
      } satisfies RoutingRule;
    })(),
    // contract non-renewal (age 26+, bench role)。contract_crisis tag 防连弹。非 cadence 期才轮到。
    { gate: () => player.age >= 26 && (role === "substitute" || role === "low_rotation")
        && !ctx.statusTags.includes("contract_crisis"),
      fire: () => fireEventByKey(ctx, "contract_nonrenewal") },
    // blockbuster offer: a fame club courts a star (age 28-34, peak≥80)。非 cadence 期才轮到。
    { gate: () => true, fire: () => blockbusterOfferEvent(ctx, maxOverall, blockbusterOfferedTier) },
    // 金元邀约 (offer 版): still-elite aging star (33+, OVR≥FAME_OFFER) who RETAINED this
    // period is courted by fame leagues (沙特联) for his 召唤力 — Modric「该不该接沙特钱」。
    // 30%/period gate；fame_offer_seen(4) 防连弹；已效力 fame 联赛则不再被诱惑。
    { gate: () => ascension < 7 && player.age >= RETENTION_START && player.overall >= FAME_OFFER_OVR
        && player.overall < FAME_PEAK_OVR
        && !ctx.statusTags.includes("fame_offer_seen") && !league.fame
        && chance(derive(seed, "fame-offer-roll", player.age, periodIndex), 0.30),
      fire: () => fameLeagueBidEvent(ctx, "offer") },
    // 体面挂钩 (P-DIGNITY): 上升期已过、OVR 跌出金元区(≤DIGNITY_RETIRE)但未触硬地板的
    // 主力级球员体面挂靴（voluntary + dignifiedExit 荣誉 ×1.25）vs 再踢一季。位于金元之下。
    { gate: () => player.age >= RETENTION_START
        && player.overall <= DIGNITY_RETIRE_OVR && player.overall > forceRetireFloor(ascension)
        && !ctx.statusTags.includes("dignity_declined"),
      fire: () => dignifiedRetireEvent(ctx) },
    // loan offer: young bench players at a BIG club (rep≥5) get loaned out for minutes —
    // bigClubBench growth penalty 的泄压阀。非 cadence 期才轮到。
    { gate: () => !completedLoan && !ctx.statusTags.includes("loan_returned")
        && (role === "substitute" || role === "low_rotation" || role === "third_keeper")
        && player.age >= 18 && player.age <= 24 && club.rep >= 5,
      fire: () => {
        const loanProb = role === "low_rotation" ? 0.55 : 0.85;
        return chance(derive(seed, "loan-offer", player.age, periodIndex), loanProb)
          ? loanOfferEvent(ctx) : null;
      } },
  ];

  let special = runChannel(S_RULES);
  let transfer = runChannel(T_RULES);

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
    if (isClubMove && transfer === null && !onOngoingLoan) {
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
  // Mechanics review: the resolve stream is derived per (age, EVENT, CHOICE) —
  // not per age alone. With age-only derivation every option at a given age
  // shared the same underlying draw, so a replayer who learned "the age-24
  // roll is low" knew ANY gamble there would succeed — daily-challenge runs
  // became solvable lookup tables. Mixing in choice.id makes each option an
  // independent stream; mixing in the EVENT key fixes the residual collision
  // where the S and T decisions queued at the same age shared one draw when
  // their option ids happened to match (e.g. two events both offering "stay")
  // — correlated double-failures in a single period read as a rigged dice.
  const ev = state.pendingChoice;
  const rng = derive(state.seed, "resolve", state.age, ev.eventKey ?? ev.key, choice.id);
  const { mods, outcome, good, injury, severe, tone, rolled } = state.pendingResolve(choice, rng, state.seed);
  // update the career event plan when a scheduled career/injury event resolves.
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
  // post-loan one-shot (loan-design §3.3, fixes bug2): the post-loan decision —
  // the benched 租借归来 (key "post_loan") OR the retained-return transfer
  // window (key "transfer", which only fires in the return period while
  // completedLoan is set) — consumes the completedLoan window once resolved,
  // regardless of the chosen branch (the stay/loyalStay branch above doesn't
  // clear it, so without this 租借归来 would repeat every period). completedLoan
  // is set ONLY in the return period, where the post-loan decision is the sole
  // T channel event — so a "transfer" resolved while it's set is necessarily
  // the retained path, never a regular cadence window (those have it undefined).
  if (completedLoan && (ev.key === "post_loan" || ev.key === "transfer")) {
    completedLoan = undefined;
  }
  // pp_transfer_savvy (转会嗅觉 prestige perk): each PERMANENT transfer (new
  // club, not a loan) grants +2 OVR. Folded into pendingMods.overallDelta
  // so the next period's upfront-shift applies it. Loans don't trigger it.
  // 永久 perk > 同功能祝福: 转会嗅觉 +2 (perk) > 雇佣兵 +1 (祝福). perk 优先制
  //   (轮回是永久核心): 有 perk 时雇佣兵祝福不再叠加 → 叠加=perk 单值 (+2),
  //   避免转会 OVR 连锁放大 (多涨的 OVR 加速爬大俱乐部, 叠加会远超单点之和).
  let finalMods = mods;
  // 青训抉择 is the debut academy assignment, NOT a transfer — it must not
  // trigger the transfer-OVR perks (转会嗅觉 / 雇佣兵) that reward climbing
  // clubs. ev.key "academy_choice" is set by academyChoiceEvent.
  const isAcademy = ev.key === "academy_choice";
  const isPermanentMove = !isAcademy && (!!mods.newClubId || choice.kind === "new_club" || choice.kind === "permanent_transfer");
  // pp_transfer_savvy (+2 perk, 优先) and 雇佣兵 mercenary (+1 blessing, perk 缺席时才叠加).
  const blessings = state.blessings ?? EMPTY_BLESSINGS;
  const hasTransferPerk = (state.permPerks ?? EMPTY_PERKS).includes("pp_transfer_savvy");
  let transferOvr = 0;
  if (isPermanentMove && hasTransferPerk) transferOvr += 2;
  else if (isPermanentMove && blessings.includes("mercenary")) transferOvr += 1;
  if (transferOvr > 0) {
    finalMods = { ...mods, overallDelta: (mods.overallDelta ?? 0) + transferOvr };
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
  const outcomeTone = tone ?? (good ? "good" : "bad");
  const choiceLog = isNarrativeEvent && outcome
    ? [...(state.choiceLog ?? EMPTY_CHOICE_LOG), { age: state.age, title: ev.title, choice: choice.text, outcome, good: !!good, tone: outcomeTone }]
    : (state.choiceLog ?? EMPTY_CHOICE_LOG);
  // Momentum streak: only ROLLED resolutions move it — a lost gamble extends
  // it, a won gamble clears it, deterministic picks leave it untouched. Purely
  // history-derived, so same seed + same choices → same streak (determinism).
  const failStreak = rolled ? (good ? 0 : (state.failStreak ?? 0) + 1) : (state.failStreak ?? 0);
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
    nextPendingChoices = tail.slice(1);
    // 出队重建：把本期更早决策已累积的 mods（mergedMods）带进 ctx，重跑 builder
    // 生成带降档后定位标签的 choices + resolve。这样特殊事件(S) 先 resolve 降低了
    // 定位后，随后出队的转会窗(T) 各俱乐部定位会降档到 S 对应的定位，与本期
    // 模拟时实际分到的角色一致——不再误导玩家。
    const fe = rebuildFiredEvent({ ...state, pendingChoice: tail[0]!, pendingChoices: nextPendingChoices, pendingMods: mergedMods });
    nextPendingChoice = fe ? fe.event : tail[0]!;
    nextPendingResolve = fe ? fe.resolve : undefined;
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
    lastOutcomeTone: outcomeTone,
    failStreak,
    // 判决牌素材：OVR 净变化把三种时机（即时/永久/延后）加总成一个玩家看得懂的数。
    // 判决牌照搬选项卡药丸：resolve 时跑一次 previewLabel（与卡片预览同一函数、同一
    //  口径），存进 effects。用事件原始 mods（非 finalMods）——转会嗅觉/雇佣兵的
    //  +2、三人留守的一人一城是 run.ts 叠加的 meta 层（在英雄卡/特权菜单显示），不属
    //  「这次选择本身的后果」，不进判决牌；这样判决牌药丸 = 卡片预览药丸，完全一致。
    //  ovrDelta 也改用 mods（与 effects 同源），保证净摘要 = 药丸 OVR 之和。
    lastVerdict: {
      title: ev.title,
      choice: choice.text,
      effects: previewLabel({ mods, outcome, good, injury, severe, tone, rolled }),
      effectsLayout: choice.effectsLayout,
      ovrDelta: mods.overallDelta ?? 0,
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
  dignifiedExit?: boolean,
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
    const finalMv = seasons.length > 0 ? (seasons[seasons.length - 1]!.marketValue ?? 0) : 0;
    const { reasonText, reasonTone, postCareer, postCareerTone } = retirementNarrative(finalReason, maxOverall, trophies, awards, finalMv);
    finalBeats.push({ age: player.age, season: seasons.length, text: reasonText, tone: reasonTone });
    finalBeats.push({ age: player.age, season: seasons.length, text: `退役去向：${postCareer}`, tone: postCareerTone });
  }
  // 「一人一城」= 升上一线队之后从未转会（Totti/Maldini 弧线），只有生涯落幕
  //  才能判定——中途永远可能被一次转会推翻，所以它不是 statusTag（会被后来的
  //  转会证伪），而是退役时补记的生涯词条。8 个成年赛季的门槛把「20 岁伤退、
  //  只待过一家」挡在外面：一人一城说的是一整段生涯，不是一段短暂的开头。
  //  连拒转会（3 连留队）是另一回事，那是 club_legend「功勋球员」。
  const personaTagsEver = seniorClubCount(seasons) === 1 && seniorCareerSeasonCount(seasons) >= ONE_CLUB_MIN_SEASONS
    ? [...new Set([...(state.personaTagsEver ?? EMPTY_TAGS), "one_club"])]
    : state.personaTagsEver;
  // 传承 = 生涯末评价（scoreLegacy），不再由事件直接给出。liveLegacy 统一结算
  // （含 loyal_club 功勋球员奖励），故 finalizeRun 不再在此加减任何传承分。
  return {
    ...state,
    personaTagsEver,
    currentClubId,
    currentLeagueId,
    seasons,
    trophies,
    awards,
    maxOverall,
    ...(() => {
      const { raw, settled } = legacyPair({ ...state, currentClubId, currentLeagueId, seasons, trophies, awards, maxOverall, player, retirementReason: finalReason }, dignifiedExit);
      return { legacy: settled, rawLegacy: raw };
    })(),
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
export function rebuildFiredEvent(game: GameState): FiredEvent | undefined {
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
    seasons: game.seasons,
    recentMarketValue: game.seasons.length > 0 ? (game.seasons[game.seasons.length - 1]!.marketValue ?? 0) : 0,
    recentRating: recentPlayedRating(game.seasons),
    slotAge: ev.slotAge,
    variantKey: ev.variantKey,
    injuryType: ev.injuryType,
    bossOdds: ev.bossOdds,
    tournamentOffset: game.tournamentOffset ?? 0,
    // Momentum: the streak FROZEN at period build — matches the closure ctx so
    // a refresh mid-queue reproduces the identical roll (see simulatePeriod).
    failStreak: game.resolveFailStreak ?? 0,
    // 本期已 resolve 的更早决策累积的 mods（特殊事件(S) → 转会窗(T) 同期排队）。
    // 转会类 builder 据此把各俱乐部定位降档到前面特殊事件所对应的定位，而不是
    // 停在事件 build 时（pendingMods 仍空）的基础定位——玩家读到的「主力/替补」
    // 与该期模拟时实际分到的角色一致，不再误导。forced-exit/relegation 的
    // builder 不读它（其 resolve 强制 roleOverride 主力，覆盖更早 shift）。
    pendingMods: game.pendingMods,
  };
  const blessings = ctx.blessings;
  const bossOdds = ev.bossOdds ?? 0.5;
  switch (ev.key) {
    case "world_cup_showdown":
      return worldCupShowdown(ev.worldCupShowdown?.age ?? player.age, bossOdds, "冠军", "功亏一篑", blessings);
    case "world_cup_qualifier_showdown": {
      const q = ev.worldCupQualifier;
      return worldCupQualifierShowdown(q?.age ?? player.age, bossOdds, q?.boosted ?? false, q?.carryTiers ?? 0, blessings);
    }
    case "continental_cup_showdown": {
      const conf = nationById(player.nationalityId).confederation;
      return continentalCupShowdown(player.age, bossOdds, conf, blessings);
    }
    case "transfer":
      return transferEvent(ctx);
    case "academy_choice":
      // 青训抉择: the academy event is a pure function of (player nationality,
      // seed), so rebuilding after a refresh reproduces the same three offers.
      return academyChoiceEvent(player, game.seed);
    case "wage_squeeze":
      return wageSqueezeEvent(ctx, game.maxOverall);
    case "dignified_retire":
      return dignifiedRetireEvent(ctx);
    case "fame_league_bid":
      return fameLeagueBidEvent(ctx, "exit");
    case "fame_league_offer":
      return fameLeagueBidEvent(ctx, "offer");
    case "loan_offer":
      return loanOfferEvent(ctx);
    case "post_loan":
      return game.completedLoan ? postLoanEvent(ctx, game.completedLoan) : undefined;
    case "blockbuster_offer": {
      const bb = blockbusterOfferEvent(ctx, game.maxOverall, game.blockbusterOfferedTier);
      return bb ?? undefined;
    }
    case "no_offers":
      return noOffersEvent(ctx);
    case "retirement_ceremony":
      // 告别仪式: rebuild the resolve closure from the reason threaded onto the
      // event (retireReason) so a refresh mid-farewell re-creates the exact
      // same forceRetire/forceRetireReason/farewell-tag outcome.
      return retirementCeremonyEvent(ctx, ev.retireReason ?? "age");
    default: {
      if (!ev.eventKey) return undefined;
      // 普通/contextual 事件（forced-exit / relegation / narrative 等
      // EVENT_DEFS 条目）：重跑 builder 重建完整 FiredEvent（choices + resolve），
      // 让定位标签反映累积 pendingMods。forced-exit/relegation 的 predictRoleLabel
      // 不读 pendingMods（resolve 强制 roleOverride 主力），重建后标签不变；narrative
      // 事件无定位标签，重建亦无副作用——确定性由 derive(seed,"period-decision",
      // periodIndex) 的 offers 流保证，与原 build 一致。
      const fe = fireEventByKey(ctx, ev.eventKey);
      if (fe) return fe;
      // 防御回退：不在 EVENT_DEFS 的事件，沿用持久化 event + resolveEventOption。
      const key = ev.eventKey;
      return { event: ev, resolve: (choice, rng) => resolveEventOption(rng, key, choice.id, ctx) };
    }
  }
}

/** 刷新后重建 pendingResolve（函数不可序列化）。薄包装 rebuildFiredEvent，仅取
 *  resolve——保留给只关心 resolve 闭包的旧调用点。出队/刷新需同时刷新 choices
 *  （让转会定位降档）的调用点改用 rebuildFiredEvent。 */
export function rebuildResolve(game: GameState): ResolveFn | undefined {
  return rebuildFiredEvent(game)?.resolve;
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
    const season = seasons[i]!;
    if (season.squadLevel === "youth") continue;
    const r = season.rating;
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
 *  map (App.tsx PERSONA_TAG) MUST stay in sync with this set — plus "one_club"
 *  (一人一城), which is never a statusTag: finalizeRun 退役时才写进
 *  personaTagsEver（中途的「只待过一家」随时会被下一次转会证伪）。 */
const PERSONA_TAG_KEYS = new Set([
  "club_legend", "naturalized", "captain", "fan_darling",
  "mentor_legend", "compromised_body", "intl_retired",
  "combo_dynasty", "combo_talisman", "combo_adopted", "combo_iron",
]);

// ───────────────────────────── 词条成型 (build combos) ─────────────────────────────
//
// Two identity tags EVER held fuse into a permanent combo tag (combo_*@99) —
// the run's "build coming online" moment. The payoff is explicit and visible
// (unlike the hidden regulation layer): trophy multipliers live in
// clubTrophyCandidates, the climax-odds bump in buildPeriodDecisions, the
// injury shield in events.ts rollInjuryEvent/结算. At most ONE combo activates
// per period (the rest defer a period); milestonesSeen is the once-per-run gate.
interface ComboDef {
  readonly id: string;
  readonly name: string;
  readonly needs: readonly [string, string];
  readonly fromLabels: readonly [string, string];
  /** Layer A effect label — the concept only; live numbers stay on the odds chips. */
  readonly effect: string;
  /** Layer B 解说词 for the apex celebration. */
  readonly commentary: string;
}
const COMBO_DEFS: readonly ComboDef[] = [
  { id: "combo_dynasty", name: "王朝旗帜", needs: ["club_legend", "captain"], fromLabels: ["功勋球员", "队长"],
    effect: "联赛夺冠概率提升", commentary: "你拒绝过所有离开的理由，现在整座城市以你的名字筑墙。" },
  { id: "combo_talisman", name: "民心所向", needs: ["fan_darling", "captain"], fromLabels: ["球迷宠儿", "队长"],
    effect: "洲际赛事夺冠概率提升", commentary: "看台上万千人喊着你的名字。你举起手臂，他们就敢相信任何比分。" },
  { id: "combo_adopted", name: "第二故乡", needs: ["naturalized", "fan_darling"], fromLabels: ["归化球员", "球迷宠儿"],
    effect: "大赛决战成功概率提升", commentary: "这里曾不是你的国家。可当国歌响起，你听见看台把你唱进了歌里。" },
  { id: "combo_iron", name: "铁血队长", needs: ["compromised_body", "captain"], fromLabels: ["带伤硬扛", "队长"],
    effect: "伤病影响减轻", commentary: "伤疤没有让你退后半步，反而教会全队什么叫站着踢完。" },
];

// ───────────────────────────── career story beats (P-A1) ─────────────────────────────
//
// Capture the memorable moments of a season as one-line narrative beats so the
// summary can render a shareable "story of this career" feed. Only noteworthy
// seasons produce a beat (a quiet season is skipped) so the feed stays punchy.

// ───────────────────────────── career story beats (P-A1) ─────────────────────────────
//
// Beat generation lives in narrative.ts now (all career prose in one home).
// simulatePeriod calls appendSeasonBeats / appendNationalBeat from there.

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
  seasons: readonly SeasonResult[] = state.seasons,
): Milestone | undefined {
  const seen = new Set(state.milestonesSeen ?? EMPTY_SEEN);
  const prevMax = state.maxOverall;
  // Apex 演出素材 — 全部来自本局已发生的事实(零新随机性,确定性不变)。
  const isGK = state.player?.position === "GK";
  const firstClub = seasons[0]?.clubName ?? "青训营";
  const startOvr = seasons[0]?.overall ?? 50;
  const last = seasons[seasons.length - 1];
  const careerStats = seniorCareerStats(seasons);
  // P-A17: market value crossings — €50M / €100M are the "world-class price tag"
  // moments that football fans recognize (the €100M man is a media event).
  if (peakMarketValue >= 100 && !seen.has("mv100")) return {
    id: "mv100", title: "身价破亿！", desc: "€1亿先生！全球媒体瞩目，你已是现象级。", tone: "legendary", age,
    moment: "mv100", stat: { label: "身价", value: 100, prefix: "€", suffix: "M" },
    commentary: "当年青训营的注册表上，你的名字一文不值。今天，全世界为它标价。",
  };
  if (peakMarketValue >= 50 && !seen.has("mv50")) return { id: "mv50", title: "身价破€5000万！", desc: "跻身世界最贵球员之列。", tone: "good", age };
  // OVR crossings — only when the peak CROSSED the threshold this period.
  if (maxOverall >= 95 && prevMax < 95 && !seen.has("ovr95")) return {
    id: "ovr95", title: "巅峰 95！", desc: "你已是历史级巨星，名垂青史。", tone: "legendary", age,
    moment: "ovr95", stat: { label: "OVR", value: 95, from: startOvr },
    commentary: "没有人生来是传奇。你只是从未停下。",
  };
  if (maxOverall >= 90 && prevMax < 90 && !seen.has("ovr90")) return { id: "ovr90", title: "突破 90！", desc: "跻身世界最佳之列。", tone: "legendary", age };
  if (maxOverall >= 85 && prevMax < 85 && !seen.has("ovr85")) return { id: "ovr85", title: "巅峰 85！", desc: "你已是顶级球星。", tone: "good", age };
  // first trophy
  if (trophies.length > 0 && (state.trophies.length === 0) && !seen.has("first_trophy")) return { id: "first_trophy", title: "生涯首冠！", desc: "从零到一，冠军滋味。", tone: "good", age };
  // Ballon d'Or
  if (awards.includes("ballon_dor") && !state.awards.includes("ballon_dor") && !seen.has("ballon_dor")) return {
    id: "ballon_dor", title: "加冕金球奖！", desc: "世界最佳，当之无愧。", tone: "legendary", age,
    moment: "ballon_dor",
    stat: isGK
      ? { label: "本季零封", value: last?.stats.cleanSheets ?? 0 }
      : { label: "本季进球+助攻", value: (last?.stats.goals ?? 0) + (last?.stats.assists ?? 0) },
    commentary: "你穿过的每一件球衣，都指向今晚。世界最佳，从此是你的名字。",
  };
  // World Cup
  if (trophies.includes("world_cup") && !state.trophies.includes("world_cup") && !seen.has("world_cup")) return {
    id: "world_cup", title: "世界杯冠军！", desc: "足球的终极荣耀，永恒之夜。", tone: "legendary", age,
    moment: "world_cup",
    stat: isGK
      ? { label: "生涯零封", value: careerStats.cleanSheets }
      : { label: "生涯进球", value: careerStats.goals },
    commentary: `十六岁那年，你从${firstClub}的更衣室出发。今夜，整个国家在你肩上登顶。`,
  };
  return undefined;
}

// P-A123: career midpoint recap — every 10 seasons, show a "你走了多远" recap
// milestone. Not a boss or a crisis — just a moment to look back.
function detectCareerRecap(seasons: readonly SeasonResult[], seen: readonly string[]): Milestone | undefined {
  const count = seasons.length;
  if (count > 0 && count % 10 === 0 && !seen.includes(`recap${count}`)) {
    const goals = seniorCareerStats(seasons).goals;
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
