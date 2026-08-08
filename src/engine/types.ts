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
  legacy?: number;
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
}

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

export interface Player {
  readonly position: Position;
  readonly nationalityId: string;
  readonly overall: number;
  readonly age: number;
  readonly devProfile: DevProfile;
  readonly name: string;
  readonly squadNumber: number;
}

/** A career-long rival (P5) — a same-age, same-position opponent generated
 *  deterministically from the seed. Simulated each season in simplified form
 *  (goals, trophies, awards) so the player always has someone to measure
 *  against, the Messi-to-their-Ronaldo narrative that drives "one more run". */
export interface Rival {
  readonly name: string;
  readonly nationalityId: string;
  readonly clubId: string;
  readonly position: Position;
  /** Per-season record of the rival's career, parallel to the player's. */
  readonly seasons: readonly RivalSeason[];
  /** Aggregate totals. */
  readonly totalGoals: number;
  readonly totalTrophies: number;
  readonly totalAwards: number;
  /** Peak OVR reached. */
  readonly peakOverall: number;
}

export interface RivalSeason {
  readonly age: number;
  readonly goals: number;
  readonly trophies: number;
  readonly wonBallonDor: boolean;
  readonly overall: number;
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
  readonly relegated: boolean;
  readonly legacy: number;
  /** P-A5: season honors — "mvp" (联赛最佳球员) or "toty" (最佳阵容入选). */
  readonly seasonHonors?: readonly ("mvp" | "toty")[];
  /** P-A17: market value (€M) this season — driven by OVR, age, league, role. */
  readonly marketValue?: number;
  /** P-A17: weekly wage (€K) this season — driven by market value + league. */
  readonly wage?: number;
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
  /** What each branch of this option does, surfaced on the decision card as
   *  color-coded pills (「+3 OVR 60%」/「-3 OVR 40%」). Derived mechanically in
   *  `buildEvent` by resolving the option with a forced outcome, and kept ONLY
   *  when the magnitude is identical across two throwaway RNG streams — a
   *  branch whose size is itself random is never previewed as fact. */
  readonly preview?: readonly ChoicePreview[];
}

/** One previewed branch of a choice. `prob` is present only when the branch is
 *  an actual dice roll; a deterministic option previews a single branch. */
export interface ChoicePreview {
  readonly good: boolean;
  readonly prob?: number;
  readonly label: string;
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
  readonly odds?: number;            // visible probability for the "good" outcome
  readonly choices: readonly Choice[];
  /** 母本 event metadata carried for climax/resolve hooks. */
  readonly eventKey?: string;
  readonly variantKey?: string;
  readonly injuryType?: string;
  /** Scheduled slot age this event was drawn from (careerEventPlan). */
  readonly slotAge?: number;
  readonly rivalTeamId?: string;
  readonly targetTrophy?: string;
  readonly targetClubTrophy?: string;
  readonly nationalTournament?: string;
  readonly alternativeNationalityFifaCode?: string;
  readonly worldCupShowdown?: { age: number; better: string; worse: string };
  readonly worldCupQualifier?: { age: number; boosted: boolean; carryTiers: number };
  /** 宿敌决战 (rival showdown) — the career-long rival's head-to-head duel.
   *  Stashes the rival's identity so rebuildResolve can reconstruct the
   *  resolve closure (the outcome prose names the rival). */
  readonly rivalShowdown?: { age: number; rivalName: string; rivalClubName: string };
  /** Boss 事件的真实胜率（resolve 用，非 event.odds 的显示值）。刷新后重建
   *  pendingResolve 必须读它——boss builder 把 odds 只存在 ctxStub 闭包里，
   *  不存 event 会丢。 */
  readonly bossOdds?: number;
  /** P7: event rarity — rare/legendary events get a special UI frame. */
  readonly rarity?: "common" | "rare" | "legendary";
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
  readonly legacy: number;           // accumulated legacy points this run
  /** Event-choice legacy only (subset of `legacy`) — fed into scoreLegacy at
   *  retirement so event rewards reach the meta economy, without
   *  double-counting the trophies/awards scoreLegacy prices itself. */
  readonly eventLegacy?: number;
  readonly ascension: number;        // 0 = base difficulty
  readonly pace?: string;            // 母本 pace mode: long/normal/express
  readonly periodLength?: number;    // seasons per decision (from pace)
  /** Tournament-cycle phase offset (0..3) for this career — shifts the WC /
   *  continental-cup / club-WC year rhythm so the World Cup is no longer
   *  nailed to 19/23/27/31 for every career. Pure function of the seed. */
  readonly tournamentOffset?: number;
  readonly retired: boolean;
  readonly retirementReason: string | null;
  readonly age: number;
  // transient orchestrator fields (kept on state so reducer transitions are pure)
  readonly pendingMods?: Modifiers;
  readonly pendingResolve?: ResolveFn;
  readonly lastOutcome?: string;
  /** 阶段二：本 period 末自动结算的「风味事件」描述（单选/被动事件，
   *  不弹决策）。显示在赛季卡上，mods 已进 pendingMods。 */
  readonly pendingFlavor?: string;
  readonly blessings?: readonly string[];
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
  /** The career-long rival (P5) — simulated alongside the player for narrative
   *  tension. Set at run creation; never changes identity, only accrues seasons. */
  readonly rival?: Rival;
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
}

/** P-A4: a career milestone — a rare, first-time achievement that earns a
 *  full-screen celebration popup (the TikTok "holy shit" moment). */
export interface Milestone {
  readonly id: string;
  readonly title: string;
  readonly desc: string;
  readonly tone: "legendary" | "good";
  readonly age: number;
}

/** Loan offer modifiers (母本 loan model): loan out to a club, or stay. */
export interface LoanMods {
  /** Loan the player out to this club next period; returns at returnAge. */
  loanOutTo?: string;
  /** Loan return age. */
  loanReturnAge?: number;
}
