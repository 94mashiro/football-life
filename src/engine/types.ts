/**
 * Domain types shared by the engine. Kept free of any RNG/React dependencies.
 */
import type { Position, DevProfile } from "./data";

/**
 * Transient orchestrator fields. Defined with minimal structural types so
 * types.ts doesn't need to import the rng/events modules (keeps the type
 * layer dependency-free). The run.ts orchestrator produces/consumes these.
 */
export interface Modifiers {
  immediateOverallDelta?: number;
  permanentOverallDelta?: number;
  deferredOverallDelta?: number;
  /** Stats multiplier (appearances/goals) for this period. Default 1. */
  statsMultiplier?: number;
  roleShift?: number;
  roleOverride?: Role;
  suspended?: boolean;
  /** Legacy 2-field form (still used by older events). */
  leagueTrophyMult?: number;
  continentalTrophyMult?: number;
  /** 母本 5-multiplier form (gr reads these; fall back to the legacy fields). */
  leagueTrophyProbabilityMultiplier?: number;
  domesticCupTrophyProbabilityMultiplier?: number;
  continentalPrimaryTrophyProbabilityMultiplier?: number;
  continentalSecondaryTrophyProbabilityMultiplier?: number;
  clubWorldCupTrophyProbabilityMultiplier?: number;
  /** Force a specific club trophy result (force=win, skip=lose). */
  clubTrophyOverride?: { trophy: string; result: "force" | "skip" };
  /** Force a specific national trophy result. */
  nationalTrophyOverride?: { trophy: string; result: "force" | "skip" };
  /** Override the World Cup result directly. */
  worldCupResultOverride?: string;
  /** Force/skip national tournament participation. */
  nationalTournamentParticipation?: "force" | "skip";
  /** Force participation in a specific national tournament. */
  nationalTournament?: string;
  forceTrophy?: { trophy: string; result: "force" | "skip" };
  /** Set by the transfer event when the player chose to stay (for loyal_club). */
  loyalStay?: boolean;
  /** Transfer to a new club next period (set by the transfer event). */
  newClubId?: string;
  /** Switch national allegiance (foreign_grandfather event). */
  newNationalityId?: string;
  /** Loan the player out to this club next period (母本 loan model). */
  loanOutTo?: string;
  /** Age at which the loan returns to the parent club. */
  loanReturnAge?: number;
  /** Status tags to add to the player this period (branching consequences). */
  addTags?: readonly string[];
  /** End the career immediately next period (medical retirement — 诊室的沉默,
   *  or 无人问津 from the soft-retention / wage-squeeze decisions). */
  forceRetire?: boolean;
  /** Retirement reason to finalize with when forceRetire fires (default "injury").
   *  "no_offers" — the 伤仲永/迟暮 economic exit; "voluntary" — player hung up. */
  forceRetireReason?: string;
  /** 体面退场: the player CHOSE to stop while he still could, rather than being
   *  stopped (无人问津 / 失败的复出豪赌 / 硬拖到 40 岁). Pays a career-end honors
   *  bonus in scoreLegacy — without it every "接受终结" option is strictly
   *  dominated, since legacy grows monotonically with seasons played. */
  dignifiedExit?: boolean;
}

/** Resolve a trophy multiplier from the 5-field form, falling back to the
 *  legacy 2-field form, then 1. Centralised so sim.ts stays backward-compatible. */
export function trophyMult(mods: Modifiers | undefined, trophy: string): number {
  if (!mods) return 1;
  switch (trophy) {
    case "league":
      return mods.leagueTrophyProbabilityMultiplier ?? mods.leagueTrophyMult ?? 1;
    case "cup":
      return mods.domesticCupTrophyProbabilityMultiplier ?? 1;
    case "continental_primary":
      return mods.continentalPrimaryTrophyProbabilityMultiplier
        ?? mods.continentalTrophyMult ?? 1;
    case "continental_secondary":
      return mods.continentalSecondaryTrophyProbabilityMultiplier
        ?? mods.continentalTrophyMult ?? 1;
    case "club_world_cup":
      return mods.clubWorldCupTrophyProbabilityMultiplier ?? 1;
    default:
      return 1;
  }
}

export interface ResolveResult {
  mods: Modifiers;
  outcome: string;
  good: boolean;
  /** Set when this outcome injured the player (drives talisman + injuriesTaken). */
  injury?: boolean;
  /** Set when the injury was severe (重伤) — drives the medical-retirement arc. */
  severe?: boolean;
  /** Display valence — separates "won/lost the gamble" (good) from how the
   *  outcome should READ. Deterministic tradeoff options (a benefit AND a cost)
   *  are "mixed" (⇄), not failures; absent falls back to good ? good : bad. */
  tone?: OutcomeTone;
  /** True when this resolution actually rolled the dice (drives the momentum
   *  fail-streak counter — deterministic options never move the streak). */
  rolled?: boolean;
}

/** Valence of a resolved outcome: won gamble / tradeoff / loss. */
export type OutcomeTone = "good" | "mixed" | "bad";

/** Minimal RNG handle (structural — matches engine/rng's RngState). */
export interface RngLike {
  s: number;
}

export type ResolveFn = (choice: Choice, rng: RngLike, seed: string) => ResolveResult;

export type Phase = "create" | "playing" | "summary";

export type Role = "starter" | "high_rotation" | "low_rotation" | "substitute" | "third_keeper";

/** A self-set redemption goal carried from one run's near-miss into the next.
 *  Earned by selecting a "定义性时刻" at the prior run's summary screen. If the
 *  player achieves the challenge, scoreLegacy grants a bonus (×mult on legacy). */
export interface Challenge {
  readonly id: string;
  readonly label: string;
  /** Multiplier applied to run legacy on success (e.g. 1.3 = +30%). */
  readonly legacyMult: number;
}

export type Trophy =
  | "league"
  | "cup"
  | "continental_primary"
  | "continental_secondary"
  | "club_world_cup"
  | "national_continental"
  | "world_cup";

export type Award = "ballon_dor" | "golden_boot" | "golden_glove";

export interface SeasonStats {
  appearances: number;
  goals: number;
  assists: number;
  cleanSheets: number;
  goalsConceded: number;
}

export const ZERO_STATS: SeasonStats = {
  appearances: 0, goals: 0, assists: 0, cleanSheets: 0, goalsConceded: 0,
};

/** Parallel national-team track (P-NAT): per-season national-team activity that
 *  accumulates EVERY season the player is called up, plus the tournament
 *  stage reached in tournament years. The national line grows alongside the
 *  club line (visible in a pinned, always-on national column + a top national
 *  strip), not just a trophy badge every four years — so a fan feels the career
 *  of playing for their country, the caps piling up, the deep tournament runs,
 *  not only the rare trophy.
 *
 *  `status` is the standing this season (squad/starter/star are OVR-driven;
 *  debut/captain are career milestones). `tournament` is present only
 *  in tournament years when called up & the nation took part, and carries the
 *  stage reached — including non-champion stages (亚军/四强/八强/小组赛) so the
 *  「征战」runs that fell short are still part of the story. `trophy` is set iff
 *  the stage is the champion (that is what feeds the trophies array + awards). */
export type NationalStatus =
  | "none"      // not called up this season (OVR below the bar, ascension 9, or sat out)
  | "debut"     // first ever call-up
  | "squad"     // called up, a squad member
  | "starter"   // national-team starter
  | "star"      // the team's star (OVR ≥ 86)
  | "captain";   // national-team captain (a tenure milestone)

export interface NationalSeason {
  readonly calledUp: boolean;
  readonly caps: number;
  readonly goals: number;
  readonly status: NationalStatus;
  readonly tournament?: { readonly trophy?: Trophy; readonly stage: string };
}

export interface Player {
  readonly position: Position;
  readonly nationalityId: string;
  /** 出身国 (P-NATION) — 青训烙印的来源,createRun 时冻结。归化/改籍只改
   *  nationalityId (国家队线);青训档位的终身摩擦与传承补偿始终按此结算。
   *  Optional for pre-P-NATION saves; readers fall back to nationalityId. */
  readonly originNationalityId?: string;
  readonly overall: number;
  readonly age: number;
  readonly devProfile: DevProfile;
  readonly name: string;
  readonly squadNumber: number;
}

export interface SeasonResult {
  readonly age: number;
  readonly clubId: string;
  readonly clubName: string;
  readonly leagueId: string;
  readonly leagueName: string;
  readonly tier: 1 | 2;
  readonly role: Role;
  readonly overall: number;
  readonly stats: SeasonStats;
  readonly trophies: readonly Trophy[];
  readonly awards: readonly Award[];
  readonly nationalTournaments: readonly { trophy: Trophy; stage: string }[];
  /** P-NAT: the parallel national-team track for this season (caps/goals/standing
   *  + the tournament stage reached). Undefined on seasons written before this
   *  field existed — callers fall back to the trophy badges / OVR proxy. */
  readonly national?: NationalSeason;
  readonly relegated: boolean;
  /** 停赛季——本期因伤/禁赛/丧亲等原因整季未登场（mods.suspended 或 asc2 的
   *  nag-injury）。纯展示字段：账本以「停赛」状态章替代误导性的 0/0/0 数据格。
   *  undefined 于本字段入库前的旧赛季——回退为原 0/0/0 渲染（无法事后推断）。 */
  readonly suspended?: boolean;
  /** P-A5: season honors — "mvp" (联赛最佳球员) or "toty" (最佳阵容入选). */
  readonly seasonHonors?: readonly ("mvp" | "toty")[];
  /** P-A17: market value (€M) this season — driven by OVR, age, league, role. */
  readonly marketValue?: number;
  /** P-A17: weekly wage (€K) this season — driven by market value + league. */
  readonly wage?: number;
  /** P-RATING: 综合表现评分 (5.5–9.5, SofaScore-style). Position-fair — the
   *  formula centers a 合格主力 (squad-base starter) at ≈7.0 across EVERY
   *  position by subtracting a per-group, club-aware baseline, so one bar
   *  judges a CB and a ST equally. Comprehensive: stats + role + position +
   *  trophies + national stage + awards + relegation. The canonical career
   *  number that drives the forced-exit trigger (管理层看球员的依据) and feeds
   *  market value, and the hero stat surfaced beyond 出场/进球/助攻/零封.
   *  null = the player didn't appear (suspended/farewell) — you can't rate a
   *  season you didn't play; undefined on seasons written before the field
   *  existed (fall back to computeSeasonRating). */
  readonly rating?: number | null;
}

/** A decision the player faces at the end of a period. */
export interface Choice {
  readonly id: string;
  readonly kind: ChoiceKind;
  readonly text: string;
  readonly sub?: string;
  /** Per-club trophy odds surfaced on transfer-style choices (方向 A — honor as
   *  a decision axis). Each entry is one trophy the offered club is chasing
   *  THIS period, with the probability computed by `clubTrophyCandidates`.
   *  Kept structural (not folded into `sub`) so the UI can render the odds as a
   *  color-coded bar/pill — the “Odds are the hero” differentiator extended to
   *  the trophy dimension, the thing competitors hide. Empty for non-transfer
   *  choices. */
  readonly trophyOdds?: readonly TrophyOddsEntry[];
  /** The destination club for a transfer/loan/stay choice — set when the
   *  choice moves the player to a known club at build time (transferEvent,
   *  loanOfferEvent, postLoanEvent, noOffersEvent, wageSqueezeEvent). Lets the
   *  UI show the real club crest next to the choice text — the football-first,
   *  mud-to-marble read on the decision deck. Absent on narrative events whose
   *  destination is only decided at resolve time. */
  readonly clubId?: string;
  /** An option's previewed effects, split into two regimes so the decision card
   *  never mixes a guaranteed effect into a gamble's branches:
   *  - `certain`: effects that happen regardless of any roll (a deterministic
   *    option's whole outcome, or the pills common to both branches of a roll).
   *    Surfaced in a dedicated 必定 zone with no percentage.
   *  - `roll`: the probabilistic fork — `win`/`lose` carry only the effects that
   *    DIFFER between the two branches, and `winProb` scopes the whole win
   *    cluster (the percentage lives on the cluster label, not on a single
   *    pill), so a co-effect like 坐稳主力 reads unambiguously as part of the
   *    win branch rather than as a standalone no-% item.
   *  Derived mechanically in `buildEvent` by resolving the option under forced
   *  outcomes; a branch whose magnitude is itself random (two throwaway RNG
   *  streams disagree) is never previewed as fact. */
  readonly certain?: readonly ChoicePreview[];
  readonly roll?: ChoiceRollPreview;
}

/** One previewed effect. `good` is the effect's valence (drives the pill color
 *  + up/down icon); the probability that scopes it lives on the cluster label
 *  (`ChoiceRollPreview.winProb`), not on the pill — one roll decides a whole
 *  branch, not each pill. */
export interface ChoicePreview {
  readonly good: boolean;
  readonly label: string;
}

/** The two-sided fork of a rolled option. `win`/`lose` hold ONLY the effects
 *  unique to that branch (effects present in both are pulled into `certain` so
 *  a guaranteed consequence is never shown as if it were one of the dice's
 *  possible outcomes). `winProb` is the success probability; the failure
 *  probability is `1 - winProb`. */
export interface ChoiceRollPreview {
  readonly winProb: number;
  readonly win: readonly ChoicePreview[];
  readonly lose: readonly ChoicePreview[];
}

/** One surfaced trophy probability for a transfer-style choice. */
export interface TrophyOddsEntry {
  readonly label: string;   // short UI label, e.g. "联赛" / "欧冠"
  readonly prob: number;   // 0..1
  /** Hint tier so the UI can order/prioritize — "gold" = league/continental
   *  primary, "silver" = cup/continental secondary. */
  readonly tier: "gold" | "silver";
}

export type ChoiceKind =
  | "new_club"
  | "stay"
  | "retire"
  | "event_option"
  | "begin_career"
  | "join_loan"
  | "permanent_transfer"
  | "farewell"
  | "goodbye"
  | "walkaway";

export interface CareerEvent {
  readonly key: string;
  readonly title: string;
  readonly desc: string;
  readonly choices: readonly Choice[];
  /** 母本 event metadata carried for climax/resolve hooks. */
  readonly eventKey?: string;
  readonly variantKey?: string;
  readonly injuryType?: string;
  /** Scheduled slot age this event was drawn from (careerEventPlan). */
  readonly slotAge?: number;
  readonly rivalTeamId?: string;
  readonly targetClubTrophy?: string;
  readonly nationalTournament?: string;
  readonly alternativeNationalityFifaCode?: string;
  readonly worldCupShowdown?: { age: number; better: string; worse: string };
  readonly worldCupQualifier?: { age: number; boosted: boolean; carryTiers: number };
  /** Boss 事件的真实胜率（resolve 用）。刷新后重建
   *  pendingResolve 必须读它——boss builder 把 odds 只存在 ctxStub 闭包里，
   *  不存 event 会丢。显示层不再有事件级概率，只有选项自己的 %。 */
  readonly bossOdds?: number;
  /** P7: event rarity — rare/legendary events get a special UI frame. */
  readonly rarity?: "common" | "rare" | "legendary";
  /** 告别仪式 (retirement_ceremony): the retirement reason threaded onto the
   *  farewell event so rebuildResolve can reconstruct the resolve closure
   *  after a refresh (the closure captures the reason). */
  readonly retireReason?: string;
}

/** A narrative beat for the career story feed (P-A1) — a single memorable
 *  moment captured as the career unfolds, so the summary can render a
 *  shareable "story of this career" and the play screen can show a running
 *  log. Kept tiny (age + one line) so the whole career is cheap to store. */
export interface CareerBeat {
  readonly age: number;
  readonly season: number;     // 1-indexed season number
  readonly text: string;       // one-line narrative
  readonly tone: "good" | "bad" | "neutral" | "legendary";
}

/** 母本 career event plan (qr/Gr): N personal events scheduled at fixed slot ages. */
export interface CareerEventPlan {
  readonly targetCount: number;
  readonly slotAges: readonly number[];
  readonly completedEventKeys: readonly string[];
  readonly completedSlotAges: readonly number[];
  readonly completedEventAges: readonly number[];
  readonly injuryCount: number;
}

export interface GameState {
  readonly phase: Phase;
  readonly seed: string;
  readonly player: Player | null;
  readonly currentClubId: string;
  readonly currentLeagueId: string;
  /** The league the career STARTED in. currentLeagueId moves with every
   *  transfer, so it must never be used to reproduce a run — share links and
   *  replays need this one. Optional: saves written before it existed fall
   *  back to seasons[0].leagueId. */
  readonly startLeagueId?: string;
  /** The club the career STARTED at — parallels startLeagueId (currentClubId
   *  moves with every transfer). Stamped at createRun; used by share links so a
   *  hand-picked academy reproduces the exact start, not the weakest-club fallback. */
  readonly startClubId?: string;
  /** 青训抉择 (academy choice): true until the player picks their youth-academy
   *  club via the FIRST in-game event (no season is simulated before it).
   *  createRun sets it true with a placeholder currentClubId (weakest club in
   *  startLeagueId — never simulated, only there so rebuildResolve's clubById is
   *  safe); the academy event's resolve sets newClubId, and the next
   *  simulatePeriod consumes it, stamps startClubId/startLeagueId, and clears
   *  this flag before simulating season 1. Optional: saves written before this
   *  field existed had no academy phase — undefined reads as "already chosen". */
  readonly academyPending?: boolean;
  /** Set (YYYY-MM-DD) only when this run was started as that day's daily
   *  challenge, so the result is recorded against the day it was actually
   *  played for rather than inferred from a seed collision. */
  readonly dailyDate?: string;
  /** True when the player hand-specified the seed in the debut console (custom
   *  mode). A specified seed is reproducible/shareable, so the run settles NO
   *  meta rewards — no legacy banked, no best-run update, no ascension-unlock
   *  progress, no trophy/achievement collection. The summary still scores &
   *  shows the run for the player's reference; meta is left untouched. */
  readonly customSeed?: boolean;
  readonly seasons: readonly SeasonResult[];
  readonly maxOverall: number;
  readonly trophies: readonly Trophy[];
  readonly awards: readonly Award[];
  readonly pendingChoice: CareerEvent | null;
  /** 决策队列的尾部：本 period 末同时触发的「转会通道」与「特殊事件通道」
   *  决策按顺序排队（特殊事件先、转会在后）。`pendingChoice` 始终是队首；
   *  队首 resolve 后出队，`pendingChoices[0]` 升为新的 `pendingChoice`，
   *  resolve 函数经 rebuildResolve 重建。队列空才推进赛季——一个节奏点可
   *  依次弹出多个决策（转会 + 特殊事件并存，互不挤兑）。空数组/undefined
   *  表示队首即是最后一个决策。CareerEvent 是纯数据可序列化。 */
  readonly pendingChoices?: readonly CareerEvent[];
  /** Live career-end evaluation (scoreLegacy) of the run so far — the SAME
   *  formula that settles the run at retirement, recomputed each period so the
   *  in-play number always matches the summary. Legacy is a career-end
   *  evaluation accumulated across runs, never granted by events. */
  readonly legacy: number;
  readonly ascension: number;        // 0 = base difficulty
  readonly pace?: string;            // 母本 pace mode: long/normal/express
  readonly periodLength?: number;    // seasons per decision (from pace)
  /** Tournament-cycle phase offset (0..3) for this career — shifts the WC /
   *  continental-cup / club-WC year rhythm so the World Cup is no longer
   *  nailed to 19/23/27/31 for every career. Pure function of the seed. */
  readonly tournamentOffset?: number;
  readonly retired: boolean;
  readonly retirementReason: string | null;
  /** 告别仪式 (retirement_ceremony): the farewell style the player chose when
   *  a FORCED retirement (OVR floor / age ceiling) fired the farewell event —
   *  private (打电话告诉家人) / public (发社媒) / grand (退役发布会). Null for
   *  retirements that carry their own farewell beat (soft-retention 挂靴, medical
   *  verdict, narrative pool events) or a voluntary 挂靴. Set by finalizeRun
   *  from the farewell_* tag; the summary shows a capstone marker. */
  readonly farewellStyle?: "private" | "public" | "grand";
  readonly age: number;
  // transient orchestrator fields (kept on state so reducer transitions are pure)
  readonly pendingMods?: Modifiers;
  readonly pendingResolve?: ResolveFn;
  readonly lastOutcome?: string;
  /** Which branch the last resolve actually landed on — the UI's结算跑马灯 uses
   *  it to stop the highlight on the right preview pill (the prose alone can't
   *  be trusted to say which branch fired), 判决牌也用它定好坏。 */
  readonly lastOutcomeGood?: boolean;
  /** Three-state valence of the last resolve (判决牌: 如你所愿/有得有失/事与愿违). */
  readonly lastOutcomeTone?: OutcomeTone;
  /** Consecutive ROLLED failures across the career — feeds the momentum (势头)
   *  odds bonus. Derived purely from resolve history, so determinism holds. */
  readonly failStreak?: number;
  /** failStreak frozen when this period's decisions were BUILT — the resolve
   *  roll uses this (not the live counter) so displayed odds == rolled odds
   *  even when an earlier decision in the same queue moved the streak. */
  readonly resolveFailStreak?: number;
  /** 结果判决牌的素材：事件名、所选选项、这次决策带来的 OVR 净变化与伤病标记。 */
  readonly lastVerdict?: {
    readonly title: string;
    readonly choice: string;
    readonly ovrDelta: number;
    readonly injury: boolean;
    readonly severe: boolean;
    /** 命中分支的真实效果列表（resolve 时跑一次 previewLabel 存档）——判决牌照搬
     *  选项卡药丸渲染、同一套口径，不再压成净 OVR + 伤病两字段（那会丢角色/标签/
     *  乘数，与卡片对不上）。缺省（旧存档）时回退 ovrDelta+injury 两 tag。 */
    readonly effects?: readonly ChoicePreview[];
  };
  readonly blessings?: readonly string[];
  /** Equipped blessing loadout for THIS run — the RAW ≤3 ids the player chose
   *  to equip (before foldPerksIntoBlessings merges prestige-perk mirrors into
   *  `blessings`). Distinct from `blessings` (the folded, sim-active set): the
   *  leaderboard/archive surface `loadout` so a viewer learns the BUILD the
   *  player equipped, not the perk-mirrored id set that would mislabel a
   *  perk-only run as owning a blessing it never bought. Empty for custom/
   *  daily/legend runs (no loadout equipped). */
  readonly loadout?: readonly string[];
  readonly currentLeagueName?: string;
  /** Count of injury outcomes suffered this run (drives talisman: first is halved). */
  readonly injuriesTaken?: number;
  /** Count of SEVERE injuries (重伤) this run — drives injury-rate snowball and
   *  the medical-retirement arc (2nd → doctor's warning, 3rd → the verdict). */
  readonly severeInjuries?: number;
  /** The doctor's warning (队医的警告) has fired this run. */
  readonly injuryWarned?: boolean;
  /** severeInjuries count when the medical verdict (诊室的沉默) last resolved —
   *  a further severe injury re-triggers the verdict. */
  readonly verdictSeenAt?: number;
  /** Active status tags this period (branching consequences, e.g. fan_darling). */
  readonly statusTags?: readonly string[];
  /** P1: every IDENTITY (persona) tag ever held this career — the union of
   *  statusTags' persona subset across all periods, so the summary can show
   *  "what kind of player this career became" even after a tag's TTL decayed.
   *  Bare tag names (no TTL). The in-play card shows currently-active tags
   *  (statusTags); the summary shows this accumulated set. */
  readonly personaTagsEver?: readonly string[];
  /** Active loan: {parentClubId, loanClubId, returnAge}. Set when loaned out; auto-returns. */
  readonly activeLoan?: { parentClubId: string; loanClubId: string; returnAge: number };
  /** Just-returned loan (post-loan resolution window). */
  readonly completedLoan?: { parentClubId: string; loanClubId: string };
  /** 母本 career event plan (scheduled personal events at fixed slot ages). */
  readonly careerEventPlan?: CareerEventPlan;
  /** Per-career anti-repeat registry (P-VAR): event keys already fired this
   *  run. rollRandomEvent excludes them so a pool story never repeats. */
  readonly careerEventsSeen?: readonly string[];
  /** Blockbuster-offer bookkeeping (don't re-offer at a tier already offered). */
  readonly blockbusterOfferedTier?: number;
  /** Deferred event modifiers awaiting the next transfer window (chain events). */
  readonly pendingEventModifiers?: Modifiers;
  /** Contract club id (母本 distinguishes contractTeam from currentTeam on loan). */
  readonly contractClubId?: string;
  /** Permanent prestige perks — earned via the Prestige loop, never lost, stack
   *  across runs. Distinct from blessings (which are re-purchased and can be
   *  sacrificed on prestige). Engine reads these for run-power effects. */
  readonly permPerks?: readonly string[];
  /** A redemption goal carried from the prior run's near-miss. Achieving it
   *  grants a legacy bonus at the summary screen. */
  readonly challenge?: Challenge;
  /** P6: trophies newly added to the collection THIS run (for summary "NEW!"). */
  readonly newCollectedTrophies?: readonly Trophy[];
  /** P6: achievement ids newly earned THIS run (for summary "NEW!"). */
  readonly newCollectedAchievements?: readonly string[];
  /** P-A1: the career story feed — memorable beats captured as the career
   *  unfolds, for a shareable narrative summary. */
  readonly careerBeats?: readonly CareerBeat[];
  /** P-A4: a milestone just hit this period — the UI shows a full-screen
   *  celebration popup before the next decision. Cleared on dismiss. */
  readonly pendingMilestone?: Milestone;
  /** P-A4: milestone ids already celebrated this run (prevents re-trigger). */
  readonly milestonesSeen?: readonly string[];
  /** P-A4: current trophy streak (consecutive seasons with ≥1 trophy).
   *  Resets to 0 on a trophyless season. Drives streak bonuses + the 🔥 chip. */
  readonly trophyStreak?: number;
  /** P-A4: best trophy streak this run (for summary display). */
  readonly bestStreak?: number;
  /** Mechanics review: consecutive stay-at-club choices. Escalates the stay
   *  legacy bonus (3→5→8); the 3rd consecutive stay grants club_legend@99.
   *  Reset by a permanent transfer or a loan-out. */
  readonly stayStreak?: number;
  /** P-A33: a log of the player's key career choices for the summary
   *  "抉择回顾" — the butterfly effect made visible. Each entry records the
   *  event title, the chosen option, and the outcome text. */
  readonly choiceLog?: readonly ChoiceLogEntry[];
}

/** P-A33: one entry in the career choice log — a key decision + its outcome. */
export interface ChoiceLogEntry {
  readonly age: number;
  readonly title: string;
  readonly choice: string;
  readonly outcome: string;
  readonly good: boolean;
  /** Three-state valence (▲/⇄/▼). Absent on legacy entries → derive from good. */
  readonly tone?: OutcomeTone;
}

/** P-A4: a career milestone — a rare, first-time achievement that earns a
 *  full-screen celebration popup (the TikTok "holy shit" moment). */
export interface Milestone {
  readonly id: string;
  readonly title: string;
  readonly desc: string;
  readonly tone: "legendary" | "good";
  readonly age: number;
  /** Apex 演出:巅峰时刻的专属艺术方向。缺省 = 通用里程碑卡。 */
  readonly moment?: "world_cup" | "ballon_dor" | "ovr95" | "mv100" | "combo";
  /** 解说词(Layer B)— 引用本局真实生涯事实的一句收束。 */
  readonly commentary?: string;
  /** 数字滚动的大数字(from 缺省 0;纯展示,不参与模拟)。 */
  readonly stat?: { readonly label: string; readonly value: number; readonly from?: number; readonly prefix?: string; readonly suffix?: string };
  /** 词条成型专用:两个来源词条 label + 效果标签(Layer A)。 */
  readonly combo?: { readonly from: readonly [string, string]; readonly effect: string };
}

/** Loan offer modifiers (母本 loan model): loan out to a club, or stay. */
export interface LoanMods {
  /** Loan the player out to this club next period; returns at returnAge. */
  loanOutTo?: string;
  /** Loan return age. */
  loanReturnAge?: number;
}
