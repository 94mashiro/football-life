/**
 * Career events & decisions — the Roguelike decision layer.
 *
 * Event catalog + per-event-per-option resolver are faithful to the target
 * bundle (`.reverse/recon/strategy.ts`, original `$r`). The target's outcomes
 * (overallDelta / trophy multipliers / etc.)
 * are preserved exactly. Layered on top — the roguelike meta-layer:
 *   - `oracle` blessing shows odds to one decimal
 *   - `talisman` halves the first injury, `ironman` halves injury OVR penalties
 *   - `sharpshooter`/`marketable`/`loyal_club` apply via the orchestrator
 *   - 孤勇者 (ascension 7) forbids training/coach buff events
 *   - odds live on the OPTION that rolls, never on the event (the PRODUCT
 *     differentiator) — an event-level "成功概率" aggregates options that
 *     don't share one roll and lies about bosses (display 0.5 vs real
 *     bossOdds), so the UI only ever shows each option's own success %.
 *
 * Climax events (world_cup_showdown / qualifier_showdown)
 * are 50/50 coin flips in the target — the option choice is narrative flavor.
 * Each option still surfaces its own honest % (PRODUCT: odds are the hero)
 * and success still grants the trophy (which banks legacy at career end).
 */
import type { RngState } from "./rng";
import { chance, weighted, int, derive } from "./rng";
import type { Player, Choice, ChoicePreview, ChoiceRollPreview, CareerEvent, ResolveResult, Modifiers, OutcomeTone, Role, SeasonResult } from "./types";
import { PREVIEW_NO_CHANGE, PREVIEW_NO_EXTRA } from "./types";
import type { League, Club, Confederation } from "./data";
import { LEAGUES, CLUBS, NATIONS, nationById, homeLeagueOf, leagueById, clubById, clubStarRating, YOUTH_LOAN_MAX_AGE, youthTierOf, SPRINGBOARD_BLOCK_PCT } from "./data";
import { resolveYouthRole, wageSqueeze, RETENTION_START } from "./sim";
import { DIGNIFIED_EXIT_MULT } from "../meta/legacy";
import type { Narrative } from "./narrative";
import { narrative, cnNum } from "./narrative";

/** Tag with an explicit TTL (mirrors run.ts ttlTag; kept local to avoid a
 *  circular import). Format "name@ttl". */
function tag(name: string, ttl = 2): string { return `${name}@${ttl}`; }

/** 铁肺 (iron_lungs) training-family event keys — the events whose success
 *  odds the blessing boosts (+15%). Defined at module scope (hoisted before
 *  resolveEventOption's roll uses it) so there's no temporal-dead-zone use. */
const IRON_LUNGS_FAMILY = new Set(["training_extra", "personal_coach", "season_load", "new_coach", "fitness_failure", "position_competition"]);

/** boss/climax 两条线分离（owner 决策）：国家队大赛只结算「荣誉线」——奖杯拿不拿得到，
 *  绝不碰「能力线」(OVR)。一场决赛不该带崩一整个生涯的 build。
 *
 *  于是「挺身而出」不再是低胜率换 ±6 OVR 的陷阱选项，而是荣誉线内部的风险/回报：
 *  你是队里最好的球员，你上，国家队赢面更大（× SOLO_ODDS_MULT），代价是你把自己
 *  烧干了——输了这个赛季俱乐部颗粒无收（forceTrophy league skip）。「相信队友」则是
 *  基线胜率、无附带代价的稳妥路。两边都不动 OVR。
 *
 *  1.15 是按传承分算过的（tools/climax-check.ts 旁的那笔账）：世界杯 120 分 /
 *  洲际 55 分 / 联赛 20 分，胜率 ×1.15 换「失败则联赛陪葬」，恰好让豪门主力
 *  该信队友（有联赛可丢）、弱旅独苗该自己扛（本来也没冠军可丢）——选择随处境
 *  翻转，而不是有唯一正解。调高到 1.3 时 :a 在 10 种处境里 9 种占优，即反向陷阱。
 *
 *  单一旋钮，optionOdds 与 resolveEventOption 的掷骰共用，保证显示 % = 实际 %
 *  （文件铁律：不撒谎）。 */
const SOLO_ODDS_MULT = 1.15;

export interface FiredEvent {
  event: CareerEvent;
  /** resolve a chosen option → modifiers + outcome text */
  resolve: (choice: Choice, rng: RngState, seed: string) => ResolveResult;
}

const EMPTY_BLESS: readonly string[] = [];
const EMPTY_PERKS: readonly string[] = [];

// ───────────────────────────── event context ─────────────────────────────

export interface EventContext {
  player: Player;
  club: Club;
  league: League;
  seed: string;
  age: number;
  role: "starter" | "high_rotation" | "low_rotation" | "substitute" | "third_keeper";
  periodIndex: number;
  rngState: RngState;
  blessings: readonly string[];
  /** Injuries suffered so far this run (drives talisman). */
  injuriesTaken: number;
  /** SEVERE injuries so far this run (drives the injury-rate snowball). */
  severeInjuries?: number;
  /** Ascension level (drives 天命难违 / 孤勇者 / 伤病潮). */
  ascension: number;
  /** Active status tags this period (branching consequences). */
  statusTags: readonly string[];
  /** Career event plan (scheduled personal events at fixed slot ages). */
  plan?: import("./types").CareerEventPlan;
  /** Pool events already fired this career (P-VAR anti-repeat). */
  seenEvents?: readonly string[];
  /** Slot age this event was drawn from (for plan bookkeeping). */
  slotAge?: number;
  /** Variant key for variant events (e.g. training_extra preseason_camp). */
  variantKey?: string;
  /** Injury type for the `injury` event. */
  injuryType?: string;
  /** Seasons per period (loan return-age computation). */
  periodLength?: number;
  /** Consecutive rolled failures at the time this period's decisions were
   *  built (GameState.resolveFailStreak). Drives the HIDDEN momentum bonus on
   *  success rolls — by owner decision this is invisible to the UI: displayed
   *  odds stay at base value, the actual roll is nudged in the player's favor
   *  only. Deterministic (derived from resolve history), so seed replay holds. */
  failStreak?: number;
  /** Permanent prestige perks (drives pp_transfer_savvy / pp_iron_will / pp_boss_slayer). */
  permPerks?: readonly string[];
  /** P-A8: clubs the player has formerly played for (for "曾效力" tags on
   *  transfer offers — narrative continuity). */
  formerClubIds?: readonly string[];
  /** The career's season log so far. Feeds narrative()'s career-total facts so
   *  a story event quotes THIS player's goals/caps/trophies instead of the real
   *  footballer's. */
  seasons?: readonly SeasonResult[];
  /** P-A17: most recent season's market value (€M) — performance feedback into
   *  transfer offer tier (great season → bigger clubs come knocking). */
  recentMarketValue?: number;
  /** national-track-youth-olympic: when the naturalization_offer fires via the
   *  ACTIVE path (player not pushed out by a club conflict, a stronger FA
   *  proactively courts him), the copy drops the 「听说你已经退出了」 hook and
   *  reads as an ambition choice instead of a post-conflict fallback. */
  naturalizationActive?: boolean;
  /** P-RATING: most recent PLAYED season's 综合表现 rating (5.5–9.5), or null
   *  if no played season yet (debut) / recent seasons were all 0-app (injury).
   *  Drives the voluntary transfer window's offer tier directly: ≥8.0 (优秀)
   *  → +1 tier (豪门留意), <6.3 (低迷) → -1 tier (市场冷清). Same threshold
   *  lines as the rating→growth loop, so one rating has one meaning across the
   *  whole career. The forced-exit trigger already handles the extreme case
   *  (连续不达标 → must go); this lets FORM steer the voluntary window too —
   *  "经常拿 6 分 → 只有更低级别球队要你" without waiting to be forced out. */
  recentRating?: number | null;
  /** Boss-event win odds (world_cup_showdown): the real resolution probability,
   *  stashed by the showdown builder so resolveEventOption rolls against it
   *  instead of the hardcoded 50/50 coin (which made the displayed odds a lie). */
  bossOdds?: number;
  /** Tournament-cycle phase offset for this career (0..3) — shifts the WC /
   *  continental / club-WC year rhythm. Surfaced so transfer-style events can
   *  compute a club's trophy odds for the upcoming period (方向 A). */
  tournamentOffset?: number;
  /** Modifiers already accumulated this period from EARLIER resolved decisions
   *  in the same queue (special event → transfer window). Transfer-style event
   *  builders read this so a club offer's role label reflects a role change
   *  an earlier event already imposed (e.g. 「沦为替补」) — the label the
   *  player reads matches the role the sim will actually assign at the
   *  destination, instead of a stale base-role read that over-promises 主力.
   *  Undefined at the initial build (no earlier decision yet) and on events
   *  whose own resolve forces a role (forced-exit/relegation set roleOverride
   *  主力 — their labels stay base, since the override nullifies the shift). */
  pendingMods?: Modifiers;
}

// Baseline (events design): every event is a REAL choice — ≥2 options, each
//  rolling ≥2 outcomes. The old "宿命时刻" single-option dock (research/
//  single-option-events-design.md 方案 B) is retired: a one-button "dock" has
//  no alternative → no trade-off, so by Sid Meier's definition it isn't a
//  decision at all. The 宿命 badge / CareerEvent.fate field are removed; every
//  former fate event now carries a genuine second option. buildEvent enforces
//  options.length >= 2.

// ───────────────────────────── the faithful resolver ($r) ─────────────────────────────
//
// Ported from `.reverse/recon/strategy.ts` `resolveEvent`. Each case sets the
// target's exact modifiers. Meta-layer adjustments (talisman/ironman) are
// applied on top of injury events; per-option odds come from `optionOdds()` below.

/** Jt(gap) = clamp(0.25, 0.85, 0.5 + gap*0.05) — position_competition odds. */
function positionCompetitionOdds(gap: number): number {
  return Math.min(0.85, Math.max(0.25, 0.5 + gap * 0.05));
}

/** Injury type → OVR delta (target Mt table). P-INJ3: 普通伤再轻一档——腿后肌
 *  拉伤/小腿撕裂等中伤从 -2 降到 -1(配合 deferred 回血=净0,完全不伤生涯),
 *  重伤保持(重伤即时+永久已成立,降不动,降了医学弧就没牙了)。 */
const INJURY_DELTA: Record<string, number> = {
  hamstring: -1, meniscus: -2, acl: -4, ankle_sprain: -1, calf_tear: -1,
  tibia_fibula: -5, metatarsal_fracture: -3, achilles: -6,
  shoulder_dislocation: -2, disc_hernia: -4,
};
/** Injury type → realistic Chinese name + severity, for narrative outcomes. */
const INJURY_NAME: Record<string, { name: string; severity: "轻" | "中" | "重" }> = {
  hamstring: { name: "大腿后侧肌群拉伤", severity: "中" },
  meniscus: { name: "半月板损伤", severity: "中" },
  acl: { name: "前十字韧带撕裂", severity: "重" },
  ankle_sprain: { name: "脚踝扭伤", severity: "轻" },
  calf_tear: { name: "小腿肌肉撕裂", severity: "中" },
  tibia_fibula: { name: "胫腓骨骨折", severity: "重" },
  metatarsal_fracture: { name: "跖骨骨折", severity: "重" },
  achilles: { name: "跟腱断裂", severity: "重" },
  shoulder_dislocation: { name: "肩关节脱臼", severity: "中" },
  disc_hernia: { name: "椎间盘突出", severity: "重" },
};
const INJURY_DECISION_OPTIONS = [
  { key: "continue", text: "彻底休养，等身体养好" },
  { key: "play_through", text: "打封闭坚持上场" },
] as const;
function injuryDelta(type: string): number {
  return INJURY_DELTA[type] ?? -3;
}
function injuryLabel(type: string): { name: string; severity: "轻" | "中" | "重" } {
  return INJURY_NAME[type] ?? { name: type, severity: "中" as const };
}

/** Per-OPTION success probability: the chance of the POSITIVE outcome of
 *  the one option that rolls (surfaced as that option's `sub` % + a win/lose
 *  preview pill pair). undefined ⇒ the option is deterministic (no roll) and
 *  shows only its single outcome pill.
 *
 *  This is per-option, NOT per-event: the two options of one event often roll
 *  DIFFERENT probabilities (contract_saga 0.5/0.6, body_decline 0.65/0.35,
 *  injury_at_peak 0.8/0.3 …). A single event-level number cannot represent
 *  both — the old per-event table either lied about the second option or
 *  omitted it, and an option whose event was missing from the table rendered
 *  as deterministic-positive-ONLY, hiding its downside entirely (the bug:
 *  players picked the biggest shown reward because the risk was invisible).
 *
 *  The success probability is the chance of the GOOD branch. Most cases roll
 *  `roll(p, "positive")` so it's `p`; mysterious_substance:consume rolls
 *  `roll(0.35, "negative")` (caught), so the good outcome (not caught) is
 *  1 − 0.35 = 0.65.
 *
 *  MUST stay in sync with the inline `roll(...)` in resolveEventOption — a
 *  shown % that differs from the real roll is worse than hiding it. The case
 *  keys here are the SAME ``${key}:${optionKey}`` strings resolve switches on,
 *  so the two tables can be diffed line-for-line. ctx-dependent odds
 *  (position_competition / throne_challenge / new_coach / boss events) read
 *  the same ctx fields the resolve roll reads. */
export function optionOdds(key: string, optionKey: string, ctx: EventContext): number | undefined {
  switch (`${key}:${optionKey}`) {
    // training_extra / personal_coach / season_load / giant_tattoo
    case "training_extra:accept": return 0.6;
    case "personal_coach:accept": return 0.6;
    case "season_load:accept": return 0.7;
    case "giant_tattoo:accept": return 0.7;
    // mysterious_substance: consume rolls roll(0.35,"negative"); good = not-caught = 0.65
    case "mysterious_substance:consume": return 0.65;
    // position_competition: odds from the OVR gap vs the squad base
    case "position_competition:compete": {
      const base = SQUAD_BASE_BY_REP[ctx.club.rep] ?? 50;
      return positionCompetitionOdds(ctx.player.overall - base);
    }
    // throne_challenge: legend-above-squad holds the throne more easily
    case "throne_challenge:defend": return throneOdds(ctx);
    // unexpected_prospect
    case "unexpected_prospect:hold_ground": return 0.5;
    // new_coach: a picked faction (club_faction tag) makes winning him over harder
    case "new_coach:stay_and_fight": return hasTag(ctx, "club_faction") ? 0.35 : 0.5;
    // contract_nonrenewal
    case "contract_nonrenewal:stay_and_fight": return 0.4;
    // tax_trouble / controversial_statement
    case "tax_trouble:settle": return 0.6;
    case "controversial_statement:defy": return 0.45;
    // foreign_grandfather
    case "foreign_grandfather:keep_national_team": return 0.6;
    // injury family — play through vs recover (very different probabilities)
    case "injury_at_peak:play_injured": return 0.8;
    case "injury_at_peak:recover": return 0.55;
    case "injury_before_tournament:play_through": return 0.4;
    case "injury_relapse:push_through": return 0.35;
    case "medical_verdict:gamble": return 0.25;
    case "career_threatening_injury:rehab_war": return 0.45;
    case "pre_final_collapse:play_anyway": return 0.3;
    case "peak_destroyed:fight": return 0.35;
    // P-DEGEN: doctor_warning:defy is a 50/50 gamble (keep the aggressive edge vs
    // the body breaks) — mirrors the inline roll in resolveEventOption.
    case "doctor_warning:defy": return 0.5;
    // boss/climax events — 荣誉线内部的风险/回报，两边都不碰 OVR（见 SOLO_ODDS_MULT）。
    //   :a 自己扛起：胜率更高（基线 × SOLO_ODDS_MULT），代价是输了俱乐部赛季陪葬。
    //   :b 靠队友：基线胜率，无附带代价。
    // 基线（队友）odds 由 run.ts 算好塞进 ctx.bossOdds；solo 倍率是唯一旋钮，
    // 与 resolveEventOption 的掷骰共用，显示 % = 实际 %。
    case "world_cup_showdown:a":
    case "world_cup_qualifier_showdown:a":
    case "continental_cup_showdown:a":
      return clamp((ctx.bossOdds ?? 0.5) * SOLO_ODDS_MULT, 0.05, 0.95);
    case "world_cup_showdown:b":
    case "world_cup_qualifier_showdown:b":
    case "continental_cup_showdown:b":
      return ctx.bossOdds ?? 0.5;
    // academy / scout / captaincy / rally
    case "academy_rivalry:outwork": return 0.6;
    case "academy_rivalry:befriend": return 0.6;
    case "scout_attention:showcase": return 0.65;
    case "scout_attention:play_normal": return 0.65;
    case "captaincy_offer:accept": return 0.6;
    case "captain_rally:rally": return 0.65;
    // contract / wage forks (two rolling options, different probabilities)
    case "contract_saga:hold_out": return 0.5;
    case "contract_saga:settle": return 0.6;
    case "wage_demand:demand": return 0.45;
    case "wage_demand:team_friendly": return 0.6;
    case "contract_year:go_all_out": return 0.5;
    case "contract_year:stay_calm": return 0.6;
    // loyalty / veteran
    case "loyalty_test:stay_loyal": return 0.6;
    case "veteran_mentor:mentor": return 0.6;
    // body_decline / farewell / second_peak
    case "body_decline:adapt": return 0.65;
    case "body_decline:ignore": return 0.35;
    case "farewell_match:accept": return 0.55;
    case "farewell_match:postpone": return 0.45;
    case "second_peak:reinvent": return 0.5;
    // mystery_benefactor / prodigy_sibling / weather_odyssey
    case "mystery_benefactor:accept": return 0.7;
    case "prodigy_sibling:sponsor": return 0.6;
    case "weather_odyssey:accept": return 0.65;
    // fall_from_grace / family_strain / tabloid_spiral / reckless / fan
    case "fall_from_grace:reinvent": return 0.55;
    case "fall_from_grace:deny": return 0.3;
    case "dressing_room_split:mediate": return 0.5;
    case "family_strain:stay_focused": return 0.6;
    case "tabloid_spiral:embrace_fame": return 0.35;
    case "tabloid_spiral:step_back": return 0.6;
    case "reckless_challenge:own_it": return 0.5;
    case "reckless_challenge:dive": return 0.3;
    case "fan_idolatry:embrace": return 0.6;
    case "fan_confrontation:snap": return 0.2;
    case "fan_confrontation:walk_away": return 0.6;
    // price_tag / fatal_mistake / rock_bottom / joy_fades / wasted_talent
    case "price_tag_pressure:force_it": return 0.35;
    case "price_tag_pressure:simplify": return 0.65;
    case "fatal_mistake:own_it": return 0.45;
    case "fatal_mistake:hide": return 0.5;
    case "rock_bottom:keep_going": return 0.5;
    case "joy_fades:reignite": return 0.45;
    case "joy_fades:enjoy": return 0.55;
    case "wasted_talent:wake_up": return 0.5;
    case "wasted_talent:shrug": return 0.25;
    // legendary_shirt / coach_feud / frozen_out / mentor_coach / breaking_point
    case "legendary_shirt:embrace": return 0.4;
    case "legendary_shirt:change_number": return 0.6;
    case "coach_feud:escalate": return 0.3;
    case "coach_feud:back_down": return 0.55;
    case "frozen_out:force_move": return 0.5;
    case "frozen_out:dig_in": return 0.3;
    case "mentor_coach:trust_him": return 0.65;
    case "mentor_coach:insist": return 0.3;
    case "breaking_point:come_back": return 0.55;
    // 宿命时刻（single-option legendary highlights — research 方案 B）
    case "beyond_football:speak": return 0.6;
    case "war_childhood:channel_it": return 0.55;
    case "last_minute_hero:go_for_it": return 0.45;
    case "super_sub:change_game": return 0.45;
    case "history_kick:shoot": return 0.5;
    case "captain_save:dive": return 0.5;
    case "redemption_arc:one_more_time": return 0.5;
    case "panenka:chip": return 0.55;
    case "silent_fall:fight_for_life": return 0.3;
    case "the_pivot:accept_role": return 0.5;
    case "late_bloomer:seize_moment": return 0.5;
    case "penalty_burden:carry_and_lead": return 0.5;
    case "wonder_strike_moment:attempt": return 0.4;
    // 二选项 baseline: the genuine second path for every former single-option event.
    case "rags_to_riches:let_go": return 0.6;
    case "ironic_goal:celebrate": return 0.5;
    case "fan_backlash:stay_and_fight": return 0.5;
    case "fan_backlash:demand_exit": return 0.55;
    case "injury:continue": return 0.8;
    case "injury:play_through": return 0.45;
    case "beyond_football:let_football_talk": return 0.55;
    case "war_childhood:let_it_rest": return 0.5;
    case "last_minute_hero:track_back": return 0.6;
    case "super_sub:pass_torch": return 0.5;
    case "history_kick:lay_off": return 0.7;
    case "captain_save:stay_narrow": return 0.6;
    case "redemption_arc:pass_the_armband": return 0.55;
    case "panenka:power_corner": return 0.7;
    case "silent_fall:ask_off": return 0.85;
    case "the_pivot:refuse_pivot": return 0.4;
    case "late_bloomer:stay_steady": return 0.65;
    case "penalty_burden:step_away": return 0.55;
    case "wonder_strike_moment:lay_off": return 0.75;
    // transition_prep / super_agent / pre_match_calm / faith / brand / cardiac
    case "transition_prep:study_coaching": return 0.6;
    case "transition_prep:stay_present": return 0.45;
    case "super_agent:sign_with_him": return 0.55;
    case "super_agent:decline": return 0.6;
    case "pre_match_calm:stay_calm": return 0.55;
    case "faith_awakening:live_by_faith": return 0.6;
    case "brand_empire:build_brand": return 0.5;
    case "brand_empire:stay_football": return 0.6;
    case "cardiac_arrest:comeback": return 0.4;
    // representation / prodigy_burden / the_fire / quiet_excellence / giving_back
    case "representation:carry_it": return 0.5;
    case "representation:play_for_self": return 0.6;
    case "prodigy_burden:embrace_it": return 0.4;
    case "prodigy_burden:stay_grounded": return 0.6;
    case "the_fire:channel_anger": return 0.55;
    case "the_fire:let_go": return 0.5;
    case "quiet_excellence:master_precision": return 0.65;
    case "quiet_excellence:expand_game": return 0.4;
    case "giving_back:give_everything": return 0.55;
    case "giving_back:invest_in_self": return 0.5;
    // no_longer_fun / discarded / transfer_regret / goal_machine / broken_leader
    case "no_longer_fun:find_fire": return 0.4;
    case "discarded:prove_them_wrong": return 0.5;
    case "discarded:stay_and_fight": return 0.3;
    case "transfer_regret:give_it_time": return 0.35;
    case "transfer_regret:admit_mistake": return 0.3;
    case "goal_machine:pure_instinct": return 0.6;
    case "goal_machine:complete_player": return 0.4;
    case "broken_leader:keep_leading": return 0.45;
    case "broken_leader:protect_body": return 0.55;
    // the_machine / legend_bond / one_club / two_worlds / uncompromising
    case "the_machine:maintain_machine": return 0.65;
    case "the_machine:live_a_little": return 0.4;
    case "legend_bond:absorb": return 0.6;
    case "legend_bond:be_yourself": return 0.5;
    case "one_club:one_last_move": return 0.5;
    case "two_worlds:country_first": return 0.5;
    case "two_worlds:bridge_both": return 0.45;
    case "uncompromising:stay_true": return 0.4;
    case "uncompromising:adapt": return 0.55;
    // lost_instinct / quiet_exit / overshadowed / uncontrolled_genius / metabolic
    case "lost_instinct:find_it": return 0.25;
    case "lost_instinct:reinvent": return 0.4;
    case "quiet_exit:one_last_try": return 0.25;
    case "overshadowed:accept_role": return 0.5;
    case "overshadowed:demand_trade": return 0.45;
    case "uncontrolled_genius:try_control": return 0.3;
    case "uncontrolled_genius:accept_self": return 0.35;
    case "metabolic_illness:fight_illness": return 0.3;
    case "metabolic_illness:accept_reality": return 0.45;
    // signature_skill / cant_stop / underappreciated / patience_runs_out
    case "signature_skill:master_it": return 0.6;
    case "signature_skill:round_out": return 0.45;
    case "cant_stop:keep_diving": return 0.5;
    case "underappreciated:demand_respect": return 0.35;
    case "underappreciated:let_actions_speak": return 0.5;
    case "patience_runs_out:leave_for_title": return 0.55;
    case "patience_runs_out:stay_loyal": return 0.3;
    // forgotten_test / beautiful_football / hidden_wounds / the_bison
    case "forgotten_test:accept_ban": return 0.5;
    case "forgotten_test:fight_it": return 0.2;
    case "beautiful_football:insist_beauty": return 0.45;
    case "beautiful_football:pragmatic": return 0.6;
    case "hidden_wounds:seek_help": return 0.5;
    case "hidden_wounds:keep_hidden": return 0.25;
    case "the_bison:sacrifice_body": return 0.4;
    case "the_bison:save_yourself": return 0.55;
    // denied_honor / raumdeuter / integrity / common_goal / national_god
    case "denied_honor:let_it_go": return 0.6;
    case "denied_honor:speak_out": return 0.3;
    case "raumdeuter:master_space": return 0.65;
    case "raumdeuter:try_technique": return 0.4;
    case "integrity:tell_ref": return 0.55;
    case "integrity:stay_silent": return 0.6;
    case "common_goal:lead_movement": return 0.5;
    case "common_goal:just_donate": return 0.6;
    case "national_god:stay_retired": return 0.4;
    // the_scar / defensive_art / miracle_comeback / reinvention / dark_impulse
    case "the_scar:own_it": return 0.6;
    case "the_scar:hide_it": return 0.35;
    case "defensive_art:elegant_defense": return 0.6;
    case "defensive_art:tough_defender": return 0.45;
    case "miracle_comeback:fight_back": return 0.2;
    case "reinvention:change_position": return 0.55;
    case "reinvention:stay_winger": return 0.25;
    case "dark_impulse:seek_help": return 0.45;
    case "dark_impulse:accept_darkness": return 0.3;
    // predator / filial_duty / invisible_engine / horror_tackle / tunnel_war
    case "predator:trust_instinct": return 0.6;
    case "predator:learn_to_play": return 0.3;
    case "filial_duty:carry_all": return 0.5;
    case "filial_duty:just_play": return 0.55;
    case "invisible_engine:keep_invisible": return 0.6;
    case "invisible_engine:demand_recognition": return 0.35;
    case "horror_tackle:comeback": return 0.25;
    case "tunnel_war:stand_tall": return 0.5;
    case "tunnel_war:walk_away": return 0.55;
    // uncrowned / charm_striker / too_much_passion / the_wall
    case "uncrowned:keep_wandering": return 0.4;
    case "uncrowned:settle_down": return 0.55;
    case "charm_striker:keep_scoring_ugly": return 0.65;
    case "charm_striker:try_beautiful": return 0.25;
    case "too_much_passion:keep_caring": return 0.55;
    case "too_much_passion:calm_down": return 0.5;
    case "the_wall:organize": return 0.6;
    case "the_wall:tackle_more": return 0.4;
    // child_prodigy / conquering_arrival / acl_prodigy / puppet_master / overused
    case "child_prodigy:stay_grounded": return 0.6;
    case "child_prodigy:embrace_hype": return 0.4;
    case "conquering_arrival:fill_legend_boots": return 0.55;
    case "conquering_arrival:humble_start": return 0.5;
    case "acl_prodigy:comeback_stronger": return 0.45;
    case "acl_prodigy:fear_reinjury": return 0.55;
    case "puppet_master:find_space": return 0.65;
    case "puppet_master:add_goals": return 0.3;
    case "overused_prodigy:learn_to_say_no": return 0.5;
    case "overused_prodigy:play_everything": return 0.25;
    // penalty_redemption / flickering_star / two_brothers / dance_through_storm
    case "penalty_redemption:come_back_stronger": return 0.5;
    case "penalty_redemption:never_again": return 0.3;
    case "flickering_star:keep_fighting": return 0.4;
    case "flickering_star:accept_new_self": return 0.55;
    case "two_brothers:play_for_spain": return 0.6;
    case "two_brothers:play_for_parents_land": return 0.4;
    case "dance_through_storm:keep_dancing": return 0.5;
    case "dance_through_storm:stop_dancing": return 0.35;
    // the_bull_stayed / the_jewel / record_fee / georgian_pioneer / glass_genius
    case "the_bull_stayed:stay_captain": return 0.55;
    case "the_bull_stayed:chase_bigger": return 0.4;
    case "the_jewel:accept_good_not_great": return 0.5;
    case "the_jewel:chase_one_more": return 0.3;
    case "record_fee:prove_worthy": return 0.45;
    case "record_fee:drown_in_pressure": return 0.2;
    case "georgian_pioneer:carry_nation": return 0.5;
    case "georgian_pioneer:just_play": return 0.55;
    case "glass_genius:find_stability": return 0.35;
    case "glass_genius:accept_fragility": return 0.5;
    // favela_redemption / firecracker / the_godfather / fallen_prodigy
    case "favela_redemption:prove_them_wrong": return 0.5;
    case "favela_redemption:take_money": return 0.35;
    case "firecracker:come_back_burning": return 0.4;
    case "firecracker:dial_back": return 0.55;
    case "the_godfather:die_on_pitch": return 0.55;
    case "the_godfather:push_back": return 0.3;
    case "fallen_prodigy:go_small": return 0.45;
    case "fallen_prodigy:stay_fight": return 0.15;
    // restless_prince / the_matador / ironic_goal / boy_king / father_agent
    case "restless_prince:keep_moving": return 0.35;
    case "restless_prince:stop_running": return 0.5;
    case "the_matador:keep_running": return 0.5;
    case "the_matador:save_legs": return 0.55;
    case "ironic_goal:score_and_silence": return 0.5;
    case "boy_king:keep_rising": return 0.55;
    case "father_agent:assert_independence": return 0.5;
    case "rags_to_riches:embrace": return 0.55;
    case "rival_fan_revenge:face_them": return 0.55;
    // doping_whistleblower
    case "doping_whistleblower:pay_off": return 0.6;
    case "doping_whistleblower:come_clean": return 0.5;
    // sweeper_keeper / the_warrior / hand_of_god / total_footballer
    case "sweeper_keeper:leave_the_line": return 0.55;
    case "sweeper_keeper:stay_classical": return 0.7;
    case "the_warrior:throw_body": return 0.55;
    case "the_warrior:stay_calm": return 0.6;
    case "hand_of_god:be_the_god": return 0.45;
    case "hand_of_god:stay_human": return 0.5;
    case "total_footballer:invent_the_game": return 0.5;
    case "total_footballer:win_within_rules": return 0.65;
    // the_king / the_invincible / non_flying_dutchman / galloping_major
    case "the_king:carry_the_world": return 0.55;
    case "the_king:just_play": return 0.7;
    case "the_invincible:beautiful_or_nothing": return 0.5;
    case "the_invincible:win_ugly": return 0.6;
    case "non_flying_dutchman:the_turn": return 0.5;
    case "non_flying_dutchman:overcome_the_fear": return 0.4;
    case "galloping_major:restart_at_thirty": return 0.4;
    case "galloping_major:rest_on_legacy": return 0.7;
    // academy_homesick / conscience_stand / racist_abuse
    case "academy_homesick:push_through": return 0.6;
    case "academy_homesick:call_home": return 0.65;
    case "conscience_stand:speak_out": return 0.4;
    case "racist_abuse:speak_out": return 0.5;
    case "racist_abuse:play_through": return 0.5;
    // nt_shirt_locked: 主动要求竞争 —— 你能打赢那两个人吗。OVR≥78 的主力,
    // 六成拿下; 输了这一季国家队没你。
    case "nt_shirt_locked:earn_it": return 0.6;
    // fitness_failure
    case "fitness_failure:crash_diet": return 0.55;
    case "fitness_failure:own_it": return 0.35;
    case "unchanged:enjoy_success": return 0.45;
    default: return undefined;
  }
}
const SQUAD_BASE_BY_REP = [52, 58, 63, 68, 72, 76, 79, 82, 85, 88];
const ROLE_NAME: Record<Role, string> = {
  starter: "主力",
  high_rotation: "轮换",
  low_rotation: "边缘",
  substitute: "替补",
  third_keeper: "三门",
};

/** Predict the player's role at a club (rep-only), e.g. "主力" / "替补".
 *  Shared by transfer / wage-squeeze / loan events so the "go here → you'd be
 *  a bench player" positioning reads consistently across every club-choice
 *  decision — the "role are the hero" language that makes staying vs leaving
 *  a visible comparison, not a blind pick. The appearance range it implies
 *  ("约40-50场") is intentionally NOT surfaced: the bare role label is all the
 *  player sees, the minutes stay under the hood as a development nuance
 *  rather than a promise printed on the option line. Compact single-segment
 *  tag so option sub lines stay short and the decision dock fits a mobile
 *  viewport. */
function predictRoleLabel(player: Player, club: { rep: number }, mods?: Modifiers): string {
  const base = SQUAD_BASE_BY_REP[club.rep] ?? 50;
  const diff = player.overall - base;
  const isGK = player.position === "GK";
  let role: Role;
  if (isGK) role = diff >= 0 ? "starter" : diff >= -6 ? "substitute" : "third_keeper";
  else role = diff >= 0 ? "starter" : diff >= -4 ? "high_rotation" : diff >= -8 ? "low_rotation" : "substitute";
  // Reflect role-modifying mods already accumulated this period from an
  //  earlier resolved decision (a special event that lowered the player's
  //  standing, etc.). Mirrors run.ts resolveRoleWithShift + the sim's
  //  `roleOverride ?? resolveRoleWithShift(shift)` precedence, so the label
  //  on a transfer offer matches the role the sim will assign at the
  //  destination — not a stale base-role read that over-promises 主力 when
  //  the player is really heading for the bench. Callers that force their
  //  own role at resolve (forced-exit/relegation set roleOverride 主力) pass
  //  no mods, since their override nullifies any earlier shift.
  if (mods) {
    if (mods.roleOverride) role = mods.roleOverride;
    else if (mods.roleShift) {
      const ladder: Role[] = isGK
        ? ["third_keeper", "substitute", "starter"]
        : ["substitute", "low_rotation", "high_rotation", "starter"];
      const idx = ladder.indexOf(role);
      if (idx >= 0) role = ladder[Math.max(0, Math.min(ladder.length - 1, idx + mods.roleShift))]!;
    }
  }
  return ROLE_NAME[role];
}

/** 强制离队 选队权: up to 3 clubs the player would be a clear starter at, all
 *  BELOW the current club's rep (降档 — go where you can be the main man and
 *  play/grow, not sideways to a rival of equal stature). Gives the player the
 *  CHOICE of where to restart (the user's ask: 离队不该随机塞一支队) instead
 *  of the single deterministic destination. Prefers the same league, then the
 *  same confederation; spans a small rep RANGE (top-fit down a rung or two) so
 *  the offers feel distinct (a bigger-but-riskier club vs a smaller-but-safe
 *  club). Pure/deterministic (the spread is a rep-span, not a roll) —
 *  reproducible from the seed with no career-RNG leak. */
function forcedExitDestinations(ctx: EventContext, count = 3): Club[] {
  const { club: cur, league, player } = ctx;
  const base = (rep: number) => SQUAD_BASE_BY_REP[rep] ?? 50;
  // cushion ≥0 (a starter OR high_rotation fit — go where you'll actually
  // play, not necessarily a 3-OVR cushion). The strict ≥3 of the old single-
  // dest path sent a 60-OVR washout abroad (no English club cleared ≥3),
  // which felt wrong for a forced 降档. ≥0 keeps him in-league when possible.
  const lower = CLUBS.filter((c) => c.id !== cur.id && c.rep < cur.rep);
  const fit = lower.filter((c) => player.overall - base(c.rep) >= 0);
  // 防御 fallback：球员已在最低 rep 俱乐部时 lower 为空（无降档目的地），
  // 此时回退到任意其它俱乐部（换个环境），保证事件总有 ≥1 选项——否则
  // forcedExitFiredEvent 会生成 0 选项事件、resolveChoice(choice=undefined) 崩溃。
  const pool = fit.length > 0 ? fit : lower.length > 0 ? lower : CLUBS.filter((c) => c.id !== cur.id);
  const sameLeague = pool.filter((c) => c.leagueId === league.id);
  const sameConf = pool.filter((c) => leagueById(c.leagueId)?.confederation === league.confederation);
  const search = sameLeague.length > 0 ? sameLeague : sameConf.length > 0 ? sameConf : pool;
  return spreadByRep(search, count);
}

/** 选队权事件的共用挑队器: sort by rep desc, then pick a spread — top, middle,
 *  bottom of the pool so the offers feel distinct (bigger club / middling /
 *  safer) instead of three interchangeable buttons (game-design-core
 *  「有意义的选择」: 三个同档选项不是选择). Pure/deterministic (rep order +
 *  name tiebreak, no rng) so rebuildResolve reproduces the identical slate
 *  after a refresh. Dedupes — a small pool collapses top/mid/bot onto the
 *  same club. */
function spreadByRep(pool: readonly Club[], count = 3): Club[] {
  const sorted = [...pool].sort((a, b) => b.rep - a.rep || (a.name < b.name ? -1 : 1));
  if (sorted.length <= count) return sorted;
  const top = sorted[0]!;
  const mid = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 2))]!;
  const bot = sorted[sorted.length - 1]!;
  const seen = new Set<string>([top.id]);
  const out: Club[] = [top];
  if (!seen.has(mid.id)) { out.push(mid); seen.add(mid.id); }
  if (!seen.has(bot.id)) { out.push(bot); seen.add(bot.id); }
  return out.slice(0, count);
}

/** Build the forced-exit FiredEvent (扫地出门 / 踢不出来): a narrative desc +
 *  up to 3 降档 club options (the 选队权 the user asked for) + NO 留队 escape
 *  hatch. Each option shows the club, its league + star rating + the role the
 *  player would have there (主力 — all 3 are 降档-to-starter fits). Resolve
 *  routes to resolveEventOption; a deterministic offer rng (derived from the
 *  career seed) drives forcedExitDestinations so the offers are reproducible
 *  and independent of the per-choice resolve stream. title/desc live here so the
 *  EventDef entries stay tiny. */
/** A player at or below this age forced out is framed as a DEVELOPMENT move
 *  (the club sending him out for first-team minutes), not a 扫地出门/踢不出来
 *  washout — an 18-20yo below a senior squad's standard is a kid who needs to
 *  play, not a veteran who stopped performing. The rating→exit coupling still
 *  fires at the same line; only the event's framing matches the player's age.
 *  Aligns with the loan window (YOUTH_LOAN_MAX_AGE 19): a young player who
 *  can't get minutes is moved on to a starter club, developmentally. */
const FORCED_EXIT_YOUTH_AGE = 20;
/** 上一段在本队踢过的一线队赛季的账本（没有则 null）。文案据此说实话：触发条件
 *  是「评分连续低于球队标准」，那既可能是几乎没上场，也可能是上满一整季却踢不
 *  出东西——旧版无论哪种都写死「出场少得可怜，进球助攻一栏是空的」，于是一个
 *  上季 29 场的轮换球员会读到一段与自己账本直接矛盾的话（玩家实测上报）。
 *
 *  出场数那一半上一轮修掉了，可「进球助攻一栏是空的」留在了原地——它从来只看
 *  出场数，从不看进球助攻。语料库实测：这句话触发 523 次，其中 334 次
 *  (63.9%) 与账本直接矛盾（上季 14 场 4 球 1 助，照读「一栏是空的」）。玩家又
 *  一次上报了同一处。现在两半都按账本说话：出场看 appearances，产出看
 *  进球+助攻+零封（门将的账本写在零封那一栏，不在进球助攻）。 */
function lastSeasonLedger(ctx: EventContext): SeasonResult["stats"] | null {
  const seasons = ctx.seasons ?? [];
  for (let i = seasons.length - 1; i >= 0; i--) {
    const s = seasons[i]!;
    if (s.clubId !== ctx.club.id) break;
    if (s.squadLevel !== "senior") continue;
    return s.stats;
  }
  return null;
}
/** 出场少到「没位置」的线。一个赛季 30+ 场是主力/高轮换的量级，低于此才谈得上
 *  「出场时间碎成渣」。 */
const FORCED_EXIT_BARREN_APPS = 15;
function forcedExitFiredEvent(ctx: EventContext, key: "underperform_release" | "stuck_release"): FiredEvent {
  const isUnder = key === "underperform_release";
  const { player, club } = ctx;
  const isYouth = player.age <= FORCED_EXIT_YOUTH_AGE;
  // 暮年 (≥RETENTION_START)：同一套触发条件，但对一个 33+ 的老将，真实的读法是
  // 「岁月」而不是「你不适配这里」——而且他还有第三条路：挂靴（见下方 hang_up）。
  const isTwilight = !isYouth && player.age >= RETENTION_START;
  const ledger = lastSeasonLedger(ctx);
  const barren = (ledger?.appearances ?? 0) < FORCED_EXIT_BARREN_APPS;
  // 「进球助攻一栏是空的」只有在那一栏真是空的时候才能说。零封计入产出——门将的
  // 数据单写在那一栏，对他念「进球助攻是空的」永远为真，也永远没有意义。
  const silent = ledger == null || ledger.goals + ledger.assists + ledger.cleanSheets === 0;
  // young player → development-move framing (the club finds him first-team
  // minutes); veteran → the harsh 扫地出门/踢不出来 read; twilight → 岁月.
  const title = isYouth
    ? (isUnder ? "寻求出场" : "外出历练")
    : isTwilight ? "最后一份合同"
    : (isUnder ? "扫地出门" : "踢不出来");
  const desc = isYouth
    ? (isUnder
      ? "体育总监把你叫到办公室，不是训斥，是一次坦诚的谈话。「你在一线队的出场机会有限，继续坐板凳会耽误你。」他把几份资料推过来，「有几家俱乐部愿意给你主力位置——去那里踢上球，对你更好。这不是放弃，是为你找一条能上场的路。」"
      : "青训教练把你叫到一边。他没有责备——他把这两年你的出场时间摊开：少得可怜。「你需要的不是更努力的训练，是上场时间。」他说，「我们联系了几家愿意让你踢主力的俱乐部。出去踢两年，证明自己——你会是一个真正的球员。」")
    : isTwilight
      ? `体育总监把合同摊在桌上，翻到最后一页——没有续约的那一页。\n「不是你不努力。」他说这话的时候是看着你的，「是这两个赛季的数据摆在这儿。${club.name}要往前走，你懂的。」\n你懂。更衣室里最年轻的那个孩子出生那年，你已经在踢职业联赛了。膝盖每个冬天都提醒你一次，只是你一直装作没听见。\n经纪人在楼下的车里等你。他手上有几家愿意签你的俱乐部，也有一句他没敢先开口的话：也许，是时候了。`
    : (isUnder
      ? "体育总监没有让你坐下。他把这几轮的剪辑带推过来——停球失误、跑位慢半拍、该传的球没传。\n「你配得上这件球衣吗？」他没等你回答。「这家俱乐部的标准，不是靠过去的名字撑的。最近两个赛季，你的表现……」他顿了顿，「我们不会再等了。你走吧——挑一支愿意要你的球队。」"
      : barren
        ? silent
          ? "你坐在更衣柜前，本赛季的数据单攒在手里——出场少得可怜，进球助攻一栏是空的。\n已经第二个赛季了。你在这支球队找不到自己的位置：战术不适配、出场时间碎成渣、每次上场你都在证明自己，但每次证明都失败。\n经纪人打来电话：「换个环境吧。有俱乐部愿意让你踢主力——不是这里，但你能上场，能重新开始。」你看了一眼训练场的方向，那里已经没有你的位置了。"
          : "你坐在更衣柜前，本赛季的数据单攒在手里——出场少得可怜。那几次登场你不是没留下东西，可零零碎碎几个数字摊在这张纸上，撑不起一个位置。\n已经第二个赛季了。你在这支球队找不到自己的位置：战术不适配、出场时间碎成渣、每次上场你都得从头证明一遍自己，然后又坐回板凳上。\n经纪人打来电话：「换个环境吧。有俱乐部愿意让你踢主力——不是这里，但你能上场，能重新开始。」你看了一眼训练场的方向，那里已经没有你的位置了。"
        : "你坐在更衣柜前，本赛季的数据单攒在手里——场次不少，可这张纸上没有一行能替你说话。\n已经第二个赛季了。你上场，你跑动，你完成了教练要求的每一项跑位，然后什么也没发生。球队的标准写在墙上，你的名字一直在那条线下面。\n经纪人打来电话：「换个环境吧。有俱乐部愿意让你踢主力——不是这里，但在那儿你踢的球会算数。」你看了一眼训练场的方向，那里已经没有你的位置了。");
  const former = new Set(ctx.formerClubIds ?? []);
  const dests = forcedExitDestinations(ctx);
  const choices: Choice[] = dests.map((c, i) => {
    const lg = LEAGUES.find((l) => l.id === c.leagueId);
    return {
      id: `club-${i}`,
      kind: "new_club",
      text: c.name,
      sub: `${lg?.name ?? ""} · ${"★".repeat(clubStarRating(c.rep))}${former.has(c.id) ? " · 曾效力" : ""} · ${predictRoleLabel(player, c)}`,
      clubId: c.id,
    };
  });
  // 老将的第三条路：挂靴。强制离队对当打之年是「必须走」——三个降档目的地之间
  // 的取舍就是这张牌的全部张力；但对一个 33+ 的老将，把「继续降档踢」当成唯一
  // 出路既不真实（现实里被解约的老将相当一部分直接退役），也让这张牌退化成三个
  // 同档按钮（spreadByRep 的注释：三个同档选项不是选择）。玩家上报的那一局正是
  // 极端形态：38 岁、金球奖得主、俱乐部传奇，被告知「你在这支球队找不到自己的
  // 位置」，而全部出路是三支一星中甲队，连挂靴都不给。
  // 挂靴接上引擎里已有的体面退场杠杆（dignified_retire 同款 voluntary +
  // dignifiedExit 荣誉 ×1.25），于是最优解随处境翻转：荣誉满仓的传奇挂靴更值，
  // 空手的老将去低级别再攒赛季更值——正是 dignified-exit-probe 守的那条不变量。
  // 必须长在这张牌上：强制离队在 T 通道排在 dignified_retire 之前，评分掉下去的
  // 老将永远走不到那张「挂靴的念头」。
  if (isTwilight) {
    choices.push({ id: "hang_up", kind: "retire", text: "就此挂靴", sub: `功成身退 · 荣誉 ×${DIGNIFIED_EXIT_MULT}` });
  }
  return {
    event: { key, title, desc, choices, eventKey: key },
    resolve: (choice, rng) => resolveEventOption(rng, key, choice.id, ctx),
  };
}

/** 降级去留 的离队选项俱乐部: up to 3 争冠 clubs — same league, rep ≥ the
 *  relegated club (a contender, not a minnow), where the player would be a
 *  starter or high_rotation (so he goes to play and chase titles, the user's
 *  “去能争冠的地方” ask). Pure/deterministic spread (top/mid/bottom by rep). */
function relegationLeaveDestinations(ctx: EventContext, count = 3): Club[] {
  const { club: cur, league, player } = ctx;
  const base = (rep: number) => SQUAD_BASE_BY_REP[rep] ?? 50;
  // same league, rep ≥ current (a step UP or sideways to a contender — NOT a
  // relegation-mate), where the player fits as starter/high_rotation.
  const fit = CLUBS.filter((c) => c.id !== cur.id && c.leagueId === league.id && c.rep >= cur.rep && player.overall - base(c.rep) >= -4);
  const pool = fit.length > 0 ? fit : CLUBS.filter((c) => c.id !== cur.id && c.leagueId === league.id && c.rep >= cur.rep);
  return spreadByRep(pool, count);
}

/** 回国踢球 的目的地: clubs in the player's HOME nation's tier-1 league — the
 *  range the desc promises（母国的俱乐部）. A nation with no league of its own
 *  (克罗地亚/塞内加尔/…) falls back to the home CONFEDERATION, which is what
 *  that variant of the desc says (「同一片大陆上」) — never a random club on
 *  another continent. Prefers clubs the player would actually start at, so
 *  the event's「你是这里的英雄」promise holds at every offered club. Empty
 *  only for nations whose confederation has no league at all (OFC) — the
 *  event then falls back to its 挂靴归乡 option. Pure/deterministic. */
function homecomingDestinations(ctx: EventContext, count = 3): Club[] {
  const nation = nationById(ctx.player.nationalityId);
  const homeLeague = LEAGUES.find((l) => l.tier === 1 && l.country.toLowerCase() === nation.id);
  const pool = CLUBS.filter((c) => c.id !== ctx.club.id && (homeLeague
    ? c.leagueId === homeLeague.id
    : LEAGUES.find((l) => l.id === c.leagueId)?.confederation === nation.confederation));
  // 「待遇虽然不如外头」——回家是降档：只留比现东家小的球会，且他到队就能
  // 坐稳主力（事件承诺「你是这里的英雄」）。两级兜底，池子空不了。
  const starterFit = pool.filter((c) => ctx.player.overall - (SQUAD_BASE_BY_REP[c.rep] ?? 50) >= 0);
  const downward = starterFit.filter((c) => c.rep < ctx.club.rep);
  return spreadByRep(downward.length > 0 ? downward : starterFit.length > 0 ? starterFit : pool, count);
}

/** 位置竞争·主动让位 的目的地: same league, smaller club (降档 — 去能踢上球
 *  的地方, which is exactly what the option text promises), where the player
 *  is a starter fit. Pure/deterministic. */
function stepAsideDestinations(ctx: EventContext, count = 3): Club[] {
  const { club: cur, league, player } = ctx;
  const lower = CLUBS.filter((c) => c.id !== cur.id && c.leagueId === league.id && c.rep < cur.rep);
  const fit = lower.filter((c) => player.overall - (SQUAD_BASE_BY_REP[c.rep] ?? 50) >= 0);
  return spreadByRep(fit.length > 0 ? fit : lower, count);
}

/** 俱乐部危机·离队 的目的地: same league, a club that ISN'T sinking — rep at
 *  or above the crisis club (the「跳船去更稳的地方」the outcome narrates),
 *  where the player can still play. The old path took whatever club happened
 *  to sit first in the league array, which matched no promise at all. */
function crisisLeaveDestinations(ctx: EventContext, count = 3): Club[] {
  const { club: cur, league, player } = ctx;
  const others = CLUBS.filter((c) => c.id !== cur.id && c.leagueId === league.id);
  const fit = others.filter((c) => c.rep >= cur.rep && player.overall - (SQUAD_BASE_BY_REP[c.rep] ?? 50) >= -4);
  return spreadByRep(fit.length > 0 ? fit : others, count);
}

/** Build the 降级去留 FiredEvent: a stay option (the player's own choice) + up
 *  to 3 争冠 club options (the 选队权 the user asked for). Resolve routes to
 *  resolveEventOption; stay_and_fight stays, club-N leaves for that club. */
function relegationFiredEvent(ctx: EventContext): FiredEvent {
  const { player, club: currentClub } = ctx;
  const former = new Set(ctx.formerClubIds ?? []);
  const dests = relegationLeaveDestinations(ctx);
  const choices: Choice[] = [
    { id: "stay_and_fight", kind: "stay" as const, text: "留队征战低级别，带着他们回来", clubId: currentClub.id,
      ...optionPreview(ctx, "relegation_loyalty", "stay_and_fight", undefined) },
    ...dests.map((c, i) => {
      const lg = LEAGUES.find((l) => l.id === c.leagueId);
      return {
        id: `club-${i}`,
        kind: "new_club" as const,
        text: c.name,
        sub: `${lg?.name ?? ""} · ${"★".repeat(clubStarRating(c.rep))}${former.has(c.id) ? " · 曾效力" : ""} · ${predictRoleLabel(player, c)}`,
        clubId: c.id,
        ...optionPreview(ctx, "relegation_loyalty", `club-${i}`, undefined),
      };
    }),
  ];
  return {
    event: { key: "relegation_loyalty", title: "降级去留", desc: "终场哨响，记分牌上写着0-4。主场球迷哭成一片，有人翻过栅栏冲你吼——「你就这么走了？」\n更衣室里没有一个人说话。主帅收拾了东西走了，留下你一个人面对这个问题：降级了，走还是留？", choices, eventKey: "relegation_loyalty" },
    resolve: (choice, rng) => resolveEventOption(rng, "relegation_loyalty", choice.id, ctx),
  };
}

/** 王座之战 defend odds: a legend well above the squad base holds the throne
 *  more easily; a fading one is living on borrowed time. 0.3..0.8. */
function throneOdds(ctx: EventContext): number {
  const base = SQUAD_BASE_BY_REP[ctx.club.rep] ?? 50;
  return Math.min(0.8, Math.max(0.3, 0.5 + (ctx.player.overall - base) * 0.03));
}

/**
 * Resolve an event option. Faithful to target `$r`: rolls the RNG in place,
 * honors `forcedOutcome` (dev/ascension override). Returns target modifiers.
 * The `good`/`injury`/`outcome` fields drive the meta-layer (talisman tally,
 * UI outcome text). Trophies/overrides are consumed by run.ts.
 */
export function resolveEventOption(
  rng: RngState,
  key: string,
  optionKey: string,
  ctx: EventContext,
  forcedOutcome?: "positive" | "negative",
): ResolveResult {
  const mods: Modifiers = {};
  let outcome = "";
  let good = false;
  let injury = false;
  let severe = false;
  let rolled = false;
  let tone: OutcomeTone | undefined;
  // THIS career's facts — every outcome that states an age, a club, a nation or
  // a career total reads them from here, never from the real footballer the
  // story was modelled on (see narrative.ts).
  const n = narrative(ctx);

  /** probability check — forced overrides the dice. big_game_player penalizes
   *  non-boss event odds (−10%); boss events are buffed in run.ts instead.
   *  铁肺 (iron_lungs): +25% success on training-family events (季前特训/
   *  私人教练/赛季负荷/新帅/体能危机/位置竞争) — the documented effect that
   *  was previously never wired (a dead 75-legacy blessing). Applied to the
   *  success roll only (negative/failure outcomes are unaffected), capped at
   *  0.95 so it never guarantees success. Mirrors ironLungsOdds so the
   *  displayed odds match the actual roll.
   *  Momentum (势头, HIDDEN): consecutive rolled failures nudge the NEXT roll
   *  toward the good branch (+10%/streak, cap +30%) — positive-target rolls
   *  gain it, negative-target rolls (where failing IS the good branch) lose
   *  it. Deliberately NOT mirrored into displayed odds (owner decision: the
   *  regulation stays invisible; the deviation is always in the player's favor). */
  const roll = (p: number, target: "positive" | "negative"): boolean => {
    rolled = true;
    if (forcedOutcome) return forcedOutcome === target;
    let adj = bigGameOdds(key, p, ctx.blessings);
    if (target === "positive" && ctx.blessings.includes("iron_lungs") && IRON_LUNGS_FAMILY.has(key)) {
      adj = Math.min(0.95, adj + 0.25);
    }
    // 天命难违 (ascension 6): −10pp on every ordinary event's GOOD branch —
    // the desc always promised "所有事件"; it was only ever wired to the climax
    // odds in run.ts. Mirrored into the shown % by ascensionOdds in buildEvent
    // (shown % == rolled %). Boss/climax events are exempt here — run.ts
    // already taxes their authored odds (asc 5 ×0.7, asc 6 ×0.9).
    const ascTax = (ctx.ascension ?? 0) >= 6 && !BOSS_KEYS.has(key) ? 0.10 : 0;
    if (ascTax > 0) {
      adj = target === "positive" ? Math.max(0.05, adj - ascTax) : Math.min(0.95, adj + ascTax);
    }
    // 上升期 + 势头 share one hidden tilt: both only ever move the roll toward
    // the player's good branch, and neither is mirrored into the displayed %.
    const tilt = momentumBonus(ctx.failStreak) + (isRisingPhase(ctx) ? RISE_ODDS : 0);
    if (tilt > 0) {
      adj = target === "positive" ? Math.min(0.95, adj + tilt) : Math.max(0.05, adj - tilt);
    }
    return chance(rng, adj);
  };
  switch (`${key}:${optionKey}`) {
    case "training_extra:accept": {
      // (the "hard variant" branch keyed on ctx.variantKey was dead — nothing
      // in src/ ever assigned variantKey; removed rather than half-wired.)
      const success = roll(0.6, "positive");
      // Mechanics review (EV re-grade): the P-A14 tuning (+2/−4) made honest
      // effort EXPECTED-NEGATIVE (−0.4 EV) while the doping event sat at +3.75 —
      // the moral-hazard option was the math-optimal one. Effort is now modest
      // positive EV (+3/−3 at 60% → +0.6), still a real gamble on a bad roll.
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      good = success;
      outcome = success
        ? "一个月的汗水没白流。赛季首战你跑得比所有人都快，教练在场边点头。你的体能多撑了二十分钟——那二十分钟改变了你整个赛季。"
        : "身体在第三周崩溃了。你听到了「咔」的一声，然后是剧痛。队医说你至少休养两个月。你看着空荡荡的训练场，想起那天跑步机上的自己。";
      if (!success) injury = true;
      break;
    }
    case "training_extra:reject":
      // P-DEGEN: 「按计划来」曾是零回报陷阱（隔壁 accept 是 +3/−3 赌注）。
      // 安全路：稳涨 +1 perm（按计划训练）+ cautious_play 护体（省下一身伤），
      // 代价是没透支那股爆发力 → 出场顺位滑一档（roleShift −1）。收益与风险并进。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      mods.addTags = [tag("cautious_play", 3)];
      good = true;
      outcome = "你选择按计划来。体能教练看了你一眼，什么也没说。赛季里你没有那股透支出来的爆发力，出场顺位也滑了一档——但你的身体没坏，膝盖没响。你稳稳地涨了一截，比别人慢，也比别人全。"; break;

    case "personal_coach:accept": {
      const success = roll(0.6, "positive");
      // P-A14: +4 on success (a real boost), −4 on failure (was −2). The
      // coach gamble can make or break a career arc.
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 4 : -4);
      good = success;
      outcome = success
        ? "他的训练方法果然激进——你疼得每天起床都在骂他。但三个月后你第一次在对抗中过了那个你一直过不了的后卫。他站在场边笑了：「我说过你行。」"
        : "他的方法不适合你。你的身体在反抗，你的技术变形了，你的信心在崩塌。两个月后你解约了，但他留下的伤害需要更长时间恢复。你想起签合同时的笃定，现在只觉得天真。";
      break;
    }
    case "personal_coach:reject":
      // P-DEGEN: 「婉拒」曾是零回报陷阱。安全路：稳涨 +1 perm（自己的节奏），
      // 代价是错过脱胎换骨 → 聚光灯转向敢赌的人（roleShift −1）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      good = true;
      outcome = "你把合同退回去了。名帅耸耸肩走了，他说你会后悔的。也许他是对的——你错过了脱胎换骨的可能，聚光灯也转向了那个敢赌的人。但你按自己的节奏涨了一截，没把自己的生涯押在别人的激进上。"; break;

    case "mysterious_substance:consume": {
      const caught = roll(0.35, "negative");
      // Mechanics review (EV re-grade): was 75% × +7 → +3.75 EV, the dominant
      // option in the whole event pool — always-consume was a degenerate line.
      // Now 65% × +5 − 35% × (−6 + a suspended season) ≈ +0.5 net: still the
      // high-variance temptation (and the doped follow-up still looms), but no
      // longer strictly the best math in the game.
      if (caught) {
        mods.statsMultiplier = 0.4; mods.overallDelta = (mods.overallDelta ?? 0) + (-6); good = false; injury = true;
        outcome = "药检报告出来了——阳性。媒体头条写着你「涉嫌服用违禁物质」。俱乐部暂停了你的比赛资格。你坐在更衣室里看着手机弹出的消息，想起队医说的「技术上合法」。";
      } else {
        mods.overallDelta = (mods.overallDelta ?? 0) + (5); good = true; mods.addTags = [tag("doped", 4)];
        outcome = "那瓶东西的效果是真实的。你在下一场比赛中跑出了生涯最快的速度，进了两个球。赛后你坐在浴室里看着镜子里的自己，心里有个声音说：这不会是最后一次。";
      }
      break;
    }
    case "mysterious_substance:reject":
      // P-DEGEN: 「推回去」曾是零回报陷阱。安全路：稳涨 +1 perm（干净地练），
      // 代价是没吃下那记飙升 → 出场顺位滑一档（roleShift −1）。
      // 隐性收益：不挂 doped 标签（躲过后续药检/告密连锁）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      good = true;
      outcome = "你把瓶子推了回去。队医收起来，什么也没说。这一季你没有那记暗色液体带来的飙升，出场顺位也悄悄滑了一档——但你在镜子面前能直视自己，身体里没有悬着的刀。"; break;

    case "season_load:accept": {
      const success = roll(0.7, "positive");
      mods.roleOverride = success ? "starter" : "substitute";
      // P-A14: winning the load battle grants +2 (a real edge); losing it
      // drops you to substitute (bench penalty compounds in growth).
      if (success) mods.overallDelta = (mods.overallDelta ?? 0) + (2);
      good = success;
      outcome = success
        ? "三线作战你一场不落。赛季结束时你瘫在更衣室里，但金球名单上有你的名字。教练赛后搂着你说：「没有你这支球队撑不到今天。」"
        : "你的身体在第二个月就垮了。膝盖、脚踝、背部——三处伤同时发作。你坐在板凳上看队友踢完赛季，教练的失望比伤病更疼。";
      break;
    }
    case "season_load:stay_calm":
      // P-DEGEN: 曾是纯代价（只 roleShift −1，无收益）。补收益：稳涨 +1 perm +
      // cautious_play 护体（保住身体）；代价仍是顺位下滑。
      mods.roleShift = -1; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.addTags = [tag("cautious_play", 3)];
      good = true;
      outcome = "你选择了留力。主帅在新闻发布会上说「尊重球员的选择」，但你看得出他眼里的失望——你的出场时间少了，金球名单上也没有你。但你保住了身体，赛季末你比那些三线作战的人多剩一口气。"; break;

    case "position_change:accept":
      // P-A14: short pain −4 now, +3 deferred — a real gamble on the future.
      mods.roleOverride = "starter"; mods.overallDelta = (mods.overallDelta ?? 0) + (-4); mods.overallDelta = (mods.overallDelta ?? 0) + (3);
      outcome = "新位置让你无所适从。前五场比赛你踢得像个业余球员——传球失误、跑位混乱、球迷开始嘘你。但你咬着牙坚持，因为你看见了一个你自己都不敢相信的可能性。"; break;
    case "position_change:reject":
      // P-DEGEN: 曾是纯代价（只 roleShift −1）。补收益：稳涨 +1 perm
      //（老本行是地盘）；代价是顺位下滑、不再被当转型潜力股。
      mods.roleShift = -1; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      good = false;
      outcome = "你拒绝了。主帅冷冷地说：「那你在老位置上自己争吧。」你回到训练场，发现新的出场名单上你排在了第三档——但老本行是你的地盘，你稳稳地涨了一截，只是没人再把你当那个能转型的潜力股了。"; break;

    case "position_competition:compete": {
      const base = SQUAD_BASE_BY_REP[ctx.club.rep] ?? 50;
      const success = roll(positionCompetitionOdds(ctx.player.overall - base), "positive");
      // P-A14: winning the spot grants +2 (career-defining); losing drops to
      // low_rotation whose bench penalty compounds growth stagnation.
      mods.roleOverride = success ? "starter" : "low_rotation";
      if (success) mods.overallDelta = (mods.overallDelta ?? 0) + (2);
      good = success;
      outcome = success
        ? "你在训练中拼到了最后。赛前主帅把首发名单贴出来——你的名字在上面。新援看到后什么也没说，拍了拍你的肩。你赢了，但你知道这场战斗才刚刚开始。"
        : "你拼了，但他比你更强。首发名单出来那天你看了一遍又一遍，你的名字不在上面。你成了轮换球员，坐在板凳上看着他在你的位置上踢球。";
      break;
    }
    case "position_competition:step_aside":
    case "position_competition:club-0":
    case "position_competition:club-1":
    case "position_competition:club-2": {
      // 主动让位：不跟新援死磕，去能踢上球的地方（同联赛稍弱俱乐部）。
      // 去哪一家由玩家挑（club-N）；step_aside 是无降档目的地时的兜底。
      // 代价是离开母队的首发，收获是稳定出场和安静的成长。
      const dest = optionKey.startsWith("club-")
        ? stepAsideDestinations(ctx)[Number(optionKey.split("club-")[1])]
        : undefined;
      if (dest) mods.newClubId = dest.id;
      mods.roleOverride = "starter"; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      // P-DEGEN: 曾是纯收益（去小俱乐部主力 + 稳涨，无代价）。补代价：降档到
      // 小俱乐部，争冠力远不及母队 → 联赛夺冠 ×0.6。
      mods.leagueTrophyProbabilityMultiplier = 0.6;
      good = true;
      outcome = dest
        ? `你敲开主帅的门：「让他首发，我想走。」他看了你很久，最后点了头。三天后你签了${dest.name}——不是豪门，但合同上写着「主力」。你离开母队那天没有发布会，只有器械管理员和你握了握手。你少了聚光灯，也少了那座本可以在母队争的奖杯——但你多了九十分钟，那才是你长本事的地方。`
        : "你敲开主帅的门：「让他首发吧。」他看了你很久，最后说「我尊重你」。你留在队里成了轮换，但你心里已经决定：下一个窗口，你要去一个能踢上球的地方。有些位置不是抢回来的，是换一条路找回来的。";
      break;
    }

    // 王座之战 (mechanics review): the late-career legend-maintenance boss.
    // Defend the starting spot against the record-signing heir, or hand it
    // over with grace. Both routes stamp throne_done@6 (anti-refire).
    case "throne_challenge:defend": {
      const success = roll(throneOdds(ctx), "positive");
      mods.addTags = [tag("throne_done", 6)];
      good = success;
      if (success) {
        mods.roleOverride = "starter"; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
        outcome = "整个赛季你和他抢每一分钟——训练场上你第一个到，最后一个走。数据不会说谎：首发名单上你的名字始终在前。王座还是你的，而他在赛季末的采访里说：「我来错了时代。」";
      } else {
        mods.roleShift = -1; mods.overallDelta = (mods.overallDelta ?? 0) + (-1);
        outcome = "他更年轻，恢复得更快，跑得比你多两公里。赛季中段起，你的号码越来越多地出现在替补席。你第一次明白：王朝没有永恒，只有交接的方式可以选择。";
      }
      break;
    }
    case "throne_challenge:yield": {
      mods.roleShift = -1;
      mods.addTags = [tag("throne_done", 6), tag("mentor_legend", 4)];
      good = true;
      outcome = "发布会第二天，你主动敲开主帅的门：「让他首发，我来带他。」整个赛季你在训练场把二十年的东西倾囊相授。让位那天全场起立鼓掌——有些王座不是被夺走的，是被托付的。";
      break;
    }

    case "unexpected_prospect:mentor":
      mods.roleShift = -1;
      mods.leagueTrophyProbabilityMultiplier = 2;
      mods.domesticCupTrophyProbabilityMultiplier = 2;
      mods.continentalPrimaryTrophyProbabilityMultiplier = 2;
      mods.continentalSecondaryTrophyProbabilityMultiplier = 2;
      mods.clubWorldCupTrophyProbabilityMultiplier = 2;
      outcome = "你开始留下来陪那个孩子加练。你的出场时间少了——教练要给他机会。但赛季中段，你们俩第一次同时首发的那场，他进球后第一个抱住的人是你。球队更强了，你知道自己在其中的分量——哪怕数据不会记下来。"; break;
    case "unexpected_prospect:hold_ground": {
      // 死守位置：赌一把——守住则加固首发，守不住则被压上板凳+更衣室裂痕。
      const success = roll(0.5, "positive");
      if (success) { mods.roleShift = 1; mods.overallDelta = (mods.overallDelta ?? 0) + (1); good = true; }
      else { mods.roleShift = -2; mods.addTags = [tag("club_faction", 4)]; good = false; }
      outcome = success
        ? "你在训练里把他压了一整个季前赛。教练在首发名单上保留了你。年轻人坐在你旁边笑：「老哥你真狠。」你拍了拍他肩——他知道你赢了这一回，但他还有的是时间。你也是。"
        : "你死守了一个月，但教练在第三轮把首发给了他。你坐在板凳上看他踢，看他做你做了十年的动作——只是更快。更衣室里没人帮你说话，他们看见了谁才是未来。你成了那个不肯让位的老人，你自己最讨厌的样子。";
      break;
    }

    case "club_priority:prioritize_league":
      mods.leagueTrophyProbabilityMultiplier = 2;
      mods.continentalPrimaryTrophyProbabilityMultiplier = 0.5;
      good = true;
      outcome = "「联赛。」你说。主帅点了点头，把洲际赛程表从墙上取了下来。这个赛季的每个周末都是战役，轮换名单向联赛倾斜——洲际之夜你们派上了年轻人，被淘汰的那晚没人说话。但联赛积分榜上，你们一直在第一集团。"; break;
    case "club_priority:prioritize_continental":
      mods.leagueTrophyProbabilityMultiplier = 0.5;
      mods.continentalPrimaryTrophyProbabilityMultiplier = 2;
      good = true;
      outcome = "「洲际。」你说。主帅笑了：「我也是。」联赛的某些客场你坐在了看台上，积分被身后的球队一点点追近——但每个洲际比赛日，你们都是全主力。小组出线那晚，主帅在更衣室说：「我们押的是历史。」"; break;

    case "rival_offer:accept":
      mods.roleOverride = "high_rotation";
      mods.leagueTrophyProbabilityMultiplier = 2;
      mods.domesticCupTrophyProbabilityMultiplier = 2;
      mods.continentalPrimaryTrophyProbabilityMultiplier = 2;
      mods.continentalSecondaryTrophyProbabilityMultiplier = 2;
      mods.clubWorldCupTrophyProbabilityMultiplier = 2;
      mods.addTags = ["rival_betrayal"];
      good = true; outcome = "你签下了合同。消息传出的那一刻，旧主球迷论坛炸了。你的球衣被烧，你的名字被涂上了叉号。但当你第一次穿上新球衣走上球场——你知道你离奖杯更近了。"; break;
    case "rival_offer:reject":
      // P-DEGEN: 「拒绝」曾是零回报陷阱。安全路：稳涨 +1 perm + fan_darling
      //（旧主球迷把你当自己人），代价是母队争冠力不及死敌 → 联赛夺冠 ×0.8。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.leagueTrophyProbabilityMultiplier = 0.8;
      mods.addTags = [tag("fan_darling", 6)];
      good = true;
      outcome = "你关上了门。经纪人说你疯了。但你打开窗户的时候，能看见旧主球迷在看台上打出的横幅——你的名字，他们的爱。你留在母队，奖杯也许比死敌那边少几座，但看台上多了一群把你当自己人的球迷。你稳稳地涨了一截，是被爱着涨的。有些东西比奖杯重。"; break;

    case "club_crisis:stay_and_fight":
      // P-DEGEN: 曾是纯代价（只 ×0.1 五项，无收益）。补收益：稳涨 +1 perm +
      // captain 袖标（你成了沉船上最后的旗帜）；代价仍是五冠 ×0.1。
      mods.leagueTrophyProbabilityMultiplier = 0.1;
      mods.domesticCupTrophyProbabilityMultiplier = 0.1;
      mods.continentalPrimaryTrophyProbabilityMultiplier = 0.1;
      mods.continentalSecondaryTrophyProbabilityMultiplier = 0.1;
      mods.clubWorldCupTrophyProbabilityMultiplier = 0.1;
      mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.addTags = [tag("captain", 6)];
      good = true;
      outcome = "你留下了。工资到账的时候少了一半，但主席红着眼眶谢谢你——他把袖标递给了你。你知道这个赛季你什么都赢不了，但你成了这支球队最后的旗帜。你稳稳地涨了一截，是被信任着涨的。如果走了，这家俱乐部可能就真的没了。"; break;
    case "club_crisis:leave":
    case "club_crisis:club-0":
    case "club_crisis:club-1":
    case "club_crisis:club-2": {
      // 离队：去同联赛不沉的船（rep ≥ 当前、还踢得上的三家），由玩家挑一家；
      // leave 是理论兜底（联赛里没有别的俱乐部）。旧版取联赛数组里的第一家，
      // 既不是「更强」也不由玩家决定。
      // P-DEGEN: 曾是纯收益（newClubId + starter 无代价）。
      // 补代价：匆忙离队打乱节奏 → imm −1（「推落最后一根稻草」的叙事代价不再扣传承）。
      const dest = optionKey.startsWith("club-")
        ? crisisLeaveDestinations(ctx)[Number(optionKey.split("club-")[1])]
        : undefined;
      if (dest) mods.newClubId = dest.id;
      mods.roleOverride = "starter";
      mods.overallDelta = (mods.overallDelta ?? 0) + (-1);
      good = true;
      outcome = dest
        ? `你签了${dest.name}。走的那天主席没出来送你，器材管理员说「他不怪你，他只是没脸」。你坐进新车的时候手机响了——是更衣室群里老队友发的：「别回来看我们，看你自己。」你看着这条消息很久，没回。新东家的节奏你还没摸透，头几场踢得生涩——你保全了你的生涯，但你知道你抽走了最后那根稻草。`
        : "你离开了。没有下家接你，但你就是不能留了。你在机场给主席发了条消息，他没回。你起飞的时候想起他说过的「你是这支队最后的旗帜」——旗帜倒了，队也就散了。";
      break;
    }

    case "fan_backlash:stay_and_fight": {
      const success = roll(0.5, "positive");
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (2); mods.addTags = [tag("fan_darling", 4)]; }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-2); mods.roleShift = -1; }
      good = success;
      outcome = success
        ? "你走出去，嘘声铺天盖地。但你没有低头——你踢了九十分钟，最后一分钟你在边线救回一个球。嘘声停了，然后变成了掌声。你赢回的不是一场比赛，是他们。"
        : "你走出去，嘘声铺天盖地。你的腿在抖，脑子在嗡嗡响。你救不到那个球——它从你脚边滑过，对方进了。终场哨响，嘘声成了你专属的挽歌。你坐在更衣室里，没人看你。也许你该走的。";
      break;
    }
    case "fan_backlash:demand_exit": {
      const success = roll(0.55, "positive");
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1; }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-1); mods.roleShift = -2; }
      good = success;
      outcome = success
        ? "你敲开主席的门：「我要走。」他点了头——他也知道这里容不下你了。你收拾东西时心里轻了一截。你稳稳涨了一点，虽然顺位会滑，但你离开了那片嘘声。下个窗口，你会找到一个新的主场。"
        : "你敲开主席的门：「我要走。」他冷冷地说：「没人要你。」更衣室知道你想走后，再没人跟你说话。你被彻底孤立，顺位跌到底。这座城市你待不下去了，可你也走不了。";
      break;
    }

    case "new_coach:stay_and_fight": {
      // club_faction (from dressing_room_split:pick_side): a new coach purges
      // factions — having picked a side makes winning him over harder. This is
      // the tag's consequence; it was written but never read.
      const success = roll(hasTag(ctx, "club_faction") ? 0.35 : 0.5, "positive");
      mods.roleOverride = success ? "starter" : "substitute";
      good = success;
      outcome = success
        ? "一周的训练你拼出了血。新帅在最后一天把你叫到办公室：「你比我想象的要硬。首发是你的了。」你走出办公室的时候，发现自己在笑。"
        : "新帅在首发名单上划掉了你的名字。你在板凳上坐了三场，每场都看着他在你的位置上用人。他不需要你——他需要的是听话。";
      break;
    }
    case "new_coach:talk_it_out": {
      // 坦谈：不去硬拼首发，而是坐下问新帅要什么、自己怎么改。
      // 确定性路径——代价是交出首发位置，收获是摸清他的体系、安静地长进。
      mods.roleShift = -1;
      mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      good = true;
      outcome = "你敲开他的办公室，没谈首发，只问了一句：「你想让我做什么？」他愣了一下，然后讲了四十分钟他的体系。你听着，逐条点头。你没能赢回首发——但赛季中段你从板凳踢回了轮换，不是靠硬拼，是靠他后来说的那句「你是第一个来问我的人」。有些位置不是拼回来的，是问回来的。";
      break;
    }

    case "relegation_loyalty:stay_and_fight":
      // P-DEGEN: 曾是纯收益（联赛夺冠 ×2 + 降档无代价）。补代价：留在低级别联赛，
      // 发展停滞 → overallDelta −1（低级别联赛练不出东西）。
      mods.leagueTrophyProbabilityMultiplier = 2;
      mods.addTags = [tag("relegation_endured", 6)];
      mods.overallDelta = (mods.overallDelta ?? 0) + (-1);
      good = true; outcome = "你留下了。降级的那个夏天，转会窗里你的名字被问了十七次，你一次都没接。低级别的球场没有转播镜头，但每个客场都有你们的球迷——他们记得谁留了下来。这一年你是球队的旗帜，冲超的路上每一场都像决赛——只是低级别联赛练不出你在顶级联赛的那套东西，你停在原地等球队追上来。"; break;
    case "relegation_loyalty:club-0":
    case "relegation_loyalty:club-1":
    case "relegation_loyalty:club-2": {
      // 降级后离队：去同联赛更强的争冠球队，不陪沉沦。选队权——玩家从
      // 3 家争冠俱乐部里挑一家（去能争冠的地方，用户的诉求）。
      const dests = relegationLeaveDestinations(ctx);
      const idx = Number(optionKey.split("club-")[1]);
      const dest = dests[idx];
      if (dest) mods.newClubId = dest.id;
      mods.roleOverride = "starter";
      // P-DEGEN: 曾是纯收益（去争冠球队主力无代价）。补代价：匆忙离队打乱节奏
      // → imm −1（「你欠他们一个冲超，你没还」的叙事代价具象化）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (-1);
      good = true;
      outcome = dest
        ? `你收拾了更衣柜。降级的那个清晨你登上了飞往${dest.name}的航班——他们刚拿了联赛第三，正需要一个你这样的人。旧主球迷在论坛上写「他不欠我们」，但你知道那是客气话。你欠他们一个冲超，你没还——新东家的头几场你踢得生涩，心里那根刺还没拔出来。`
        : "你收拾了更衣柜，但下家还没定。降级的清晨你独自离开训练基地，没人送你——你知道他们不会原谅你，但你也知道，留在一支下沉的船上救不了任何人。";
      break;
    }

    // 豪门扫地出门 (contextual, fired by run.ts): a player at a big club
    // (rep≥6) whose rating stayed below the club's standard — the "你的数据
    // 配不上这家球队" pressure. FORCED transfer — no prove_yourself / 留队
    // escape hatch: the club has decided, you must go. The player picks WHICH
    // of up to 3 clubs to restart at (all 降档 to 主力), the 选队权 the user
    // asked for. underperformed@4 + fresh_contract are the anti-repeat /
    // contract-pause on every route.
    case "underperform_release:club-0":
    case "underperform_release:club-1":
    case "underperform_release:club-2": {
      const dests = forcedExitDestinations(ctx);
      const idx = Number(optionKey.split("club-")[1]);
      const dest = dests[idx];
      mods.addTags = [tag("underperformed", 4), tag("fresh_contract", 2)];
      if (dest) {
        mods.newClubId = dest.id;
        mods.roleOverride = "starter";
        good = true;
        outcome = `你敲开体育总监的门：「我自己走。」他看了你一眼，没说挽留的话。三天后你签了${dest.name}——不是豪门，但合同上写着两个字：主力。你收拾更衣柜的时候，墙上那张全家福里你的位置已经空了。`;
      } else {
        good = true;
        outcome = `你敲开体育总监的门：「我自己走。」但市场上没有一支愿意接你的球队。你收拾更衣柜，准备去更低级别联赛重新开始——你想起十六岁那年，也是什么都没有，只有场上的九十分钟。`;
      }
      break;
    }

    // 及时止损 (踢不出来): contextual, fired by run.ts when the last ≥2 seasons
    // at the current club were below the club's standard (the 豪门青训 bench
    // route is loaned before this, so this is the small-club / over-24 /
    // barren-starter fork). FORCED transfer — no 留队 / fight_for_spot escape
    // hatch: the rating stayed low, the club has decided, you must go. The
    // player picks WHICH of up to 3 clubs to restart at (all set up as 主力 —
    // 降档 to a level where he can play and grow), the 选队权 the user asked
    // for instead of a random single destination. stuck@4 + fresh_contract are
    // the anti-repeat / contract-pause on every route.
    case "stuck_release:club-0":
    case "stuck_release:club-1":
    case "stuck_release:club-2": {
      const dests = forcedExitDestinations(ctx);
      const idx = Number(optionKey.split("club-")[1]);
      const dest = dests[idx];
      mods.addTags = [tag("stuck", 4), tag("fresh_contract", 2)];
      if (dest) {
        mods.newClubId = dest.id;
        mods.roleOverride = "starter";
        good = true;
        outcome = `你点了头。三天后你登上了飞往${dest.name}的航班——不是豪门，但体检那天主帅对你说：「你是我们的核心。」第一轮你首发出场，触球的那一刻你松了口气——你已经很久没有这种感觉了：球到你脚下，全场在等你。`;
      } else {
        good = true;
        outcome = `你点了头，但市场上没有合适的下家。你收拾更衣柜，准备去更低级别联赛重新试一次——你想起十六岁那年，也是什么都没有，只有场上的九十分钟。`;
      }
      break;
    }

    // 老将挂靴 (forcedExitFiredEvent 仅在 age ≥ RETENTION_START 时给出这条路)：
    // 被解约的暮年球员的第三条路。与 dignified_retire:retire 同一套机械杠杆
    // （voluntary + dignifiedExit 荣誉 ×1.25），所以「体面退场」在引擎里只有一个
    // 概念、一个乘数；差别只在这次告别是被俱乐部推着走的——文案照实写。
    case "underperform_release:hang_up":
    case "stuck_release:hang_up": {
      mods.forceRetire = true;
      mods.forceRetireReason = "voluntary";
      mods.dignifiedExit = true;
      good = true;
      outcome = `你把那几份合同推了回去，一份都没翻开。「不用了。」\n更衣室的柜子你自己清的，护腿板、旧队长袖标、一双磨穿了的球鞋，一样样装进包里。走廊上遇见几个刚进一线队的孩子，他们叫你的名字，你笑着摆了摆手。\n你是被推着走出这扇门的——但走出去的姿势，是你自己挑的。`;
      break;
    }

    // contract non-renewal (contextual, fired by run.ts): a 26+ bench player
    // is told the club won't renew. Drop down to start again, or stay and
    // fight for the shirt. Anti-repeat via the contract_crisis tag.
    case "contract_nonrenewal:drop_down": {
      const dest = CLUBS.filter((c) => c.leagueId === ctx.league.id && c.id !== ctx.club.id)
        .sort((a, b) => a.rep - b.rep)[0];
      if (dest) mods.newClubId = dest.id;
      mods.addTags = [tag("contract_crisis", 8)];
      good = true;
      outcome = dest
        ? `你签了${dest.name}的合同。降薪，降档，但合同里写着两个字：主力。离开那天没有发布会，只有器材管理员和你握了握手。第一轮联赛你首发出场，跑动全场第一——你想起自己十六岁时也是这样，什么都没有，只有场上的九十分钟。`
        : "你收拾好更衣柜，把这些年的护腿板装进包里。没有下家，先回家练着——你还不想承认结束。";
      break;
    }
    case "contract_nonrenewal:stay_and_fight": {
      const success = roll(0.4, "positive");
      mods.addTags = [tag("contract_crisis", 8)];
      if (success) { mods.roleOverride = "high_rotation"; mods.overallDelta = (mods.overallDelta ?? 0) + (1); }
      else { mods.roleShift = -1; }
      good = success;
      outcome = success
        ? "你把经纪人的电话都推了。季前赛你每场都当决赛踢，第三场你进了个倒钩。主帅赛后在混采区说：「名单的事，再议。」新合同只有一年，数字难看——但更衣室里你的柜子还在原来的位置。"
        : "你留下来拼了三个月，出场时间没有变多，只有训练场上的你自己知道有多拼。冬窗那天，体育总监把你叫上楼——这次不是谈续约，是通知你可以自由离队了。板凳的最深处，比你想的更冷。";
      break;
    }

    // no_offers (P-RETIRE): the soft-retention failure fired by run.ts when the
    // body can't keep up at this level. Two choices — drop down to a weaker
    // club (the 踢低级别联赛养老 arc, self-balancing: weaker club → higher
    // cushion → easier next retention roll) or hang up the boots. No rng —
    // both are deterministic exits (the roll already happened in run.ts).
    case "no_offers:drop_down": {
      // weakest club in the same league that's at/below the current club's rep.
      const dest = CLUBS.filter((c) => c.leagueId === ctx.league.id && c.id !== ctx.club.id && c.rep <= ctx.club.rep)
        .sort((a, b) => a.rep - b.rep)[0];
      if (dest) {
        mods.newClubId = dest.id;
        good = true;
        // P-VAR: the fresh_contract tag (2 periods) pauses the retention roll
        // after 降档续约 — the player JUST re-signed; the body question returns
        // once the contract runs down. Before this, the no_offers fork chained
        // ~1.1×/career and re-absorbed the decision periods the variety pass
        // freed from other system events (MC).
        mods.addTags = [...(mods.addTags ?? []), tag("fresh_contract", 2)];
        outcome = `你签了${dest.name}。降薪，降档，但合同里写着两个字：主力。你想起十六岁那年，什么都没有，只有场上的九十分钟——现在你又回到了那种感觉。`;
      } else {
        // no weaker club in the league — the career has nowhere lower to go.
        mods.forceRetire = true;
        mods.forceRetireReason = "no_offers";
        outcome = `你找遍了联赛里每一家俱乐部，没有一家愿意签你。你把球靴收进包里，回家。`; break;
      }
      break;
    }
    case "no_offers:retire": {
      mods.forceRetire = true;
      mods.forceRetireReason = "no_offers";
      good = true;
      outcome = `你把球靴挂在更衣柜上。该走了——带着所有的荣耀和遗憾，带着那些你曾飞身扑出、轰入、传出去的球。你最后一个走出训练基地，灯一盏一盏熄在你身后。`;
      break;
    }

    case "return_home:stay_abroad":
      mods.overallDelta = (mods.overallDelta ?? 0) + (-5); mods.overallDelta = (mods.overallDelta ?? 0) + (5);
      good = false; outcome = "你选择留在海外，远离故土的代价。"; break;
    case "return_home:club-0":
    case "return_home:club-1":
    case "return_home:club-2": {
      // 接受回国：转会到母国俱乐部（若母国无顶级联赛则母洲同会籍俱乐部）。
      // 回哪一家由玩家在事件里挑（选队权）——这里按序号取回同一份纯函数候选，
      // 范围与事件描述一致（母国联赛 / 母洲）。
      // 衣锦还乡——确定但降档，归乡的叙事重量（传承不再由事件给出）。
      // 有母国联赛 → "回家"属实；无母国联赛 → 送到同洲他国俱乐部，叙事须
      // 诚实写成"回到家乡的大洲"而非"回家/母国"，否则描述与行为不符。
      const hasHome = nationHasHomeLeague(ctx.player.nationalityId);
      const dest = homecomingDestinations(ctx)[Number(optionKey.split("club-")[1])];
      if (dest) mods.newClubId = dest.id;
      mods.roleOverride = "starter"; good = true;
      // P-DEGEN: 曾是纯收益（newClubId + starter 无代价）。补代价：回家是降档，
      // 小俱乐部争冠力远不及海外 → 联赛夺冠 ×0.6。
      mods.leagueTrophyProbabilityMultiplier = 0.6;
      outcome = hasHome
        ? `你拨通了那个号码。电话那头沉默了两秒，然后是哭声——你母亲的声音。你坐上了回国的航班，舷窗外是你离开十几年的天空。${dest?.name ?? "老家球队"}的球场很小，但看台上每张脸你都似曾相识。你终于不用再向任何人解释你从哪里来——因为这里就是你来的地方。`
        : `你拨通了那个号码。母国没有接得住你的俱乐部，但同一片大陆上的${dest?.name ?? "那支球队"}接了你。你坐上了回家的航班——不完全是家，但舷窗外是说同一种语言的天空，看台上每张脸你都似曾相识。你不再需要向任何人解释你从哪里来——这片土地还记得你。`;
      break;
    }
    case "return_home:accept": {
      // 兜底：家乡那片大陆上一支职业俱乐部都没有（大洋洲）。没有球队可回——
      // 回去就是挂靴。旧版这里只给 roleOverride、人还留在原俱乐部，文案却写了
      // 挂靴仪式（描述与行为不符）；现在行为对上文案：真的退役。
      mods.forceRetire = true;
      mods.forceRetireReason = "voluntary";
      good = true;
      outcome = `你接过了那张机票。家乡没有一支接得住你的职业俱乐部了——你回来，是作为一个传奇回来的，不是作为一个球员。你办了挂靴仪式，在小的时候踢过球的那块土地上。你妈站在人群里，一直哭。你走过去抱她，说「我到家了」。`;
      break;
    }

    case "giant_tattoo:accept": {
      const success = roll(0.7, "positive");
      good = success;
      if (success) mods.overallDelta = (mods.overallDelta ?? 0) + (2);
      else mods.roleOverride = "substitute";
      outcome = success ? "巨型纹身激励你，能力提升。" : "纹身感染，缺席数场。";
      break;
    }
    case "giant_tattoo:reject":
      // P-DEGEN: 曾是零回报陷阱。安全路：稳涨 +1 perm（那股劲用在训练上），
      // 代价是没那记「带刺」的上限 → 出场顺位滑一档（roleShift −1）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      good = true;
      outcome = "你放弃了巨型纹身。你把那股想被记住的劲用在了训练上，稳稳地涨了一截——只是没人把你当那个带刺的坏男孩偶像，出场顺位也悄悄滑了一档。"; break;

    case "tax_trouble:stay_and_fight":
      mods.overallDelta = (mods.overallDelta ?? 0) + (-3); mods.overallDelta = (mods.overallDelta ?? 0) + (3);
      good = false; outcome = "律师说先扛着。但你每次上场前都要先看看记者席——他们在等你的回应。训练、庭审、训练、庭审。你的注意力被撕成了两半，场上表现也在滑落。但如果你不扛，你的名字会变成头条上的「逃税球员」。"; break;
    case "tax_trouble:settle": {
      // 认罪和解：赌轻判——认罪是息事，但刑期仍有变数。
      const light = roll(0.6, "positive");
      // 轻判 = 风波翻篇，赛季后半段反而更专注；重判 = 停摆 + 位置丢了。
      if (light) { mods.overallDelta = (mods.overallDelta ?? 0) + (2); good = true; }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-2); mods.roleShift = -1; good = false; }
      outcome = light
        ? "你认了。罚了一千五百万，缓刑。律师说你走运——认罪换来了轻判。记者会那天你念完声明就走，不回答任何问题。你的名字上了一个半月的头条，然后被下一个丑闻盖过去。你学会了低头——但你不知道这是成熟还是妥协。"
        : "你认了。但检察官要你做证——你不肯。法庭判了你实刑，你离开球场至少一个赛季。你坐在房间里看你的球队在电视上踢球，主持人提到你的名字时语气里全是遗憾。「本来是个伟大的球员」，他们说——你关了电视。你认了罪，但你也认了另一种刑。";
      break;
    }

    case "foreign_grandfather:switch_national_team": {
      // the switch is REAL now: pick a top nation (deterministic from the
      // resolve rng) and hand it to run.ts via newNationalityId — better WC
      // odds bought by staying loyal (the "keep" option).
      const pool = NATIONS.filter((n) => n.fifaRep >= 4 && n.id !== ctx.player.nationalityId);
      const target = pool[int(rng, 0, pool.length - 1)] ?? nationById(ctx.player.nationalityId);
      mods.newNationalityId = target.id;
      // P-DEGEN: 曾是纯收益（换会籍无代价）。补代价：稳涨 +1 perm + 为国出征
      //（更强的世界杯舞台）是收益；母国骂名 → rival_betrayal 标签（后续可能
      // 触发旧主球迷报复），且俱乐部顺位受扰（roleShift −1）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.nationalTournamentParticipation = "force";
      mods.roleShift = -1;
      mods.addTags = ["rival_betrayal"];
      good = true;
      outcome = `你拿起了那张泛黄的照片，拨通了${target.name}足协的电话。母国主帅在新闻发布会上说：「一个背弃母队球衣的球员，自动失去我们的尊重。」你母国的球迷在网上骂你忘本，说你「背弃了数百万人的梦想」。你换上了更强的世界杯舞台，但俱乐部那边被这场风波分了心，顺位也滑了一档。当你穿上${target.name}球衣走上球场的那天，你摸到了祖父的血脉在球衣里跳动。有些人说你叛徒，有些人说你勇敢——但你知道，你只是选了那个更像是家的地方。`; break;
    }
    case "foreign_grandfather:keep_national_team": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你把照片收了起来。那个足协的人再也没有打来电话。你继续为母国出战——也许它不如那支强，也许你永远碰不到那座奖杯，但那是你出生的地方。你摸了摸球衣上的国徽，它比奖杯更重。多年后有人问你后悔吗，你说：「有些东西比赢更重要。」"
        : "你留了下来。但母国的国家队十年没进过大赛正赛——你把最好的年纪留给了一支永远差一口气的球队。世界杯开幕那天你在家里看电视，屏幕上那个国家的球衣，本来可以是你的。";
      break;
    }

    case "naturalization_offer:accept": {
      // 归化：改换 FIFA 会籍到一个更强的国家队。代价是母国的骂名
      // 与「叛徒」标签（后续可能触发母国球迷仇视事件）。收获是更好的 WC 舞台。
      const pool = NATIONS.filter((n) => n.fifaRep >= 3 && n.id !== ctx.player.nationalityId);
      const target = pool[int(rng, 0, pool.length - 1)] ?? nationById(ctx.player.nationalityId);
      mods.newNationalityId = target.id;
      good = true;
      // 打上永久「已归化」防重——intl_retired tag 靠自然 decay 消失，期间
      // 被 naturalized 挡住归化重触发，且不读它（simulateNational 只看每期
      // 的 nationalTournamentParticipation override，与持续 tag 无关）。
      mods.addTags = [tag("naturalized", 99), "rival_betrayal"];
      outcome = `你签了那份文件。律师说「从今天起，你的国际会籍属于${target.name}。」\n你母国的足协发了声明：「一个拒绝为祖国出战的人，不配再穿这件球衣。」你的名字被从母国国家队荣誉墙撤了下来。但当你第一次穿上${target.name}球衣走进球场，你摸到了一种和从前完全不同的重量——不是血脉，是选择。有些人说你勇敢，有些人说你投机。但你知道：你只是不想在挂靴那天回忆时，说「如果当初我换了会籍」。`; break;
    }
    case "naturalization_offer:reject":
      // P-DEGEN: 「拒绝」曾是零回报陷阱。安全路：稳涨 +1 perm（全部心思放俱乐部），
      // 代价是明确退出世界杯舞台（natSkip）——那座奖杯也许永远够不到了。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.nationalTournamentParticipation = "skip";
      good = true;
      outcome = "你把那份文件推了回去。「谢谢，但我不需要别人给我一件球衣。」那个足协的人收起文件，什么也没说。你回到训练场，继续踢你的俱乐部比赛——没有世界杯，没有国旗，没有国歌。你把全部心思放在俱乐部，稳稳地涨了一截，但你心里清楚：那座你够不到的奖杯，也许永远够不到了。"; break;


    case "finish_high_school:accept":
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      outcome = "你开始在训练后补课。数学老师说你「底子差但悟性好」。你的出场时间少了——但你在补课时学到的东西让你在退役后有了第二条路。你不知道那有多重要。"; break;
    case "finish_high_school:reject":
      // P-DEGEN: 「全力足球」曾是零回报陷阱。押注型：位置上升 +1（全力足球换
      // 更多出场），代价是无后路 → overallDelta −1（破釜沉舟的风险）。
      // 与 accept（perm+1/roleShift−1 的留后路）互为镜像。
      mods.roleShift = 1; mods.overallDelta = (mods.overallDelta ?? 0) + (-1);
      good = true;
      outcome = "你把成绩单塞进了抽屉。你把全部押在足球上——出场时间多了，顺位也往上挪了一档。但多年以后你会偶尔想起那张满是红色的纸，想起老师说的「给自己留条后路」。你赌的是：足球这条路上没有后路，只有往前。"; break;

    case "controversial_statement:apologize":
      // P-DEGEN: 曾是纯代价（只 roleShift −1）。补收益：稳涨 +1 perm（保住了赞助、
      // 安稳的赛季）；代价仍是顺位下滑、在更衣室里变安静。
      mods.roleShift = -1; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      good = false;
      outcome = "你在镜头前念出了经纪人写好的道歉声明。每个字都对，但听起来不像你说的。赞助商留住了，你也保住了安稳的赛季——但你顺位滑了一档，在更衣室里变得很安静。队友看你的眼神变了，他们不确定哪一句话才是真正的你。"; break;
    case "controversial_statement:defy": {
      // 嘴硬到底：赌挺过——挺住则赢下死忠球迷，翻车则赞助流失+ 角色下滑。
      const stand = roll(0.45, "positive");
      if (stand) { mods.addTags = [tag("fan_darling", 6)]; good = true; }
      else { mods.roleShift = -1; good = false; }
      outcome = stand
        ? "你没退。你发了条动态，原话没删，还配了张你训练的照片。评论区先是骂，然后是你那些最老的球迷开始护你——「至少他敢说」。赞助商的电话确实少了几个，但看台上多了几百个为你唱歌的人。你输掉了代言，赢下了一种更难买到的东西。"
        : "你没退。但三天后那个被你「嘴硬」掉的视频又被翻出来，这次配上了你的名字和你家人的地址。赞助商一夜之间撤了三个。经纪人凌晨打来：「这不是倔强，这是自杀。」你看着手机里谩骂的私信，第一次怀疑「做自己」是不是真的值得这个价。";
      break;
    }

    case "triumphant_return:join_club": {
      // 重返旧主：desc 承诺回到「第一次效力的俱乐部」，resolve 必须真转会到
      // 那家俱乐部（formerClubIds[0]＝按赛季时序的出道俱乐部），而非只改角色
      // 却留在现队——否则描述与行为不符。触发已保证 formerClubIds[0] 存在且
      // 不等于现队（玩家确实离开过出道俱乐部）。
      const firstClub = (ctx.formerClubIds ?? [])[0];
      if (firstClub && firstClub !== ctx.club.id) mods.newClubId = firstClub;
      mods.roleOverride = "starter"; good = true;
      // P-DEGEN: 曾是纯收益（重返旧主无代价）。补代价：衣锦还乡是降档，母队
      // 争冠力不及现队 → 联赛夺冠 ×0.7。
      mods.leagueTrophyProbabilityMultiplier = 0.7;
      outcome = `你走进了那座你${n.startAgeCn}岁离开的球场。横幅还在——你的名字，你的${n.squadNumber}号，这些年没人穿。球迷起立鼓掌的时候，你看到了看台上一个白发苍苍的球童——你认出了他，他当年给你擦过球鞋。你弯下腰摸了摸草皮，这就是家——只是这里的奖杯橱窗，比你离开的那家要窄一些。`; break;
    }
    case "triumphant_return:stay":
      // P-DEGEN: 「留在现队」曾是零回报陷阱。安全路：留在更大的现队 → 联赛
      // 夺冠 ×1.2（争冠力强，可见收益）+ 稳涨，代价是错失衣锦还乡 →
      // overallDelta −1（那条回家的路一直梗在心里）。
      mods.leagueTrophyProbabilityMultiplier = 1.2;
      mods.overallDelta = (mods.overallDelta ?? 0) + (-1);
      good = true;
      outcome = "你谢绝了。主席上了飞机前回头看了你一眼，什么也没说。你回到现在的俱乐部训练场——这里是争冠军团，奖杯橱窗比你出生那家宽。但夜里你会想起那条回家的路，想起那个给你擦球球鞋的白发球童。你稳稳地涨了一截，只是那条路一直梗在心里。"; break;

    case "injury_at_peak:play_injured": {
      const positive = roll(0.8, "positive");
      good = positive;
      mods.overallDelta = (mods.overallDelta ?? 0) + (-1);
      // P-A16: butterfly effect — playing through pain always plants a delayed
      // cost ("这笔账迟早要还"), but the FAILURE branch must carry the heavier
      // one: being carried off ends the season (suspended) and compromises the
      // body longer. Previously failure carried nothing, making it strictly
      // better than success.
      if (positive) {
        mods.addTags = [tag("nagging_injury", 4), tag("compromised_body", 3)];
      } else {
        mods.statsMultiplier = 0.3;
        mods.addTags = [tag("compromised_body", 6)];
      }
      // clubTrophyOverride set by run.ts from event.targetClubTrophy + outcome
      outcome = positive
        ? "你打了封闭上场。每一次跑动膝盖都在尖叫，但你咬牙撑了九十分钟。终场哨响的时候你跪在草地上——赢了。但你摸着膝盖，知道这笔账迟早要还。"
        : "你打了封闭上场，但第三十分钟膝盖就撑不住了。你被人抬出场的时候，主场球迷起立鼓掌——但你知道这个赛季结束了，也许更多。";
      injury = true;
      break;
    }
    case "injury_at_peak:recover": {
      const positive = roll(0.55, "positive");
      good = positive;
      mods.overallDelta = (mods.overallDelta ?? 0) + (positive ? 2 : -2);
      outcome = positive
        ? "你停赛治伤了。坐在电视机前看队友争冠的感觉很煎熬，但八周后你回到了训练场——膝盖是新的，身体是新的。你用余生换回了此刻。"
        : "恢复比预期慢得多。队医说你的膝盖不会再和从前一样了。你看着训练场上的队友，第一次意识到：你的巅峰，可能已经过去了。";
      break;
    }

    case "injury_before_tournament:play_through": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? -3 : -6);
      mods.overallDelta = (mods.overallDelta ?? 0) + (3);
      mods.nationalTournamentParticipation = "force";
      if (!success) mods.roleOverride = "substitute";
      good = success; injury = true;
      outcome = success
        ? "你绑着护具站上了世界杯的赛场。每一次触球都是和自己的身体在搏斗。但你进球了——在全世界面前。你跪在角旗旁哭了，不是因为高兴，是因为疼。"
        : "你的身体在第二场比赛就背叛了你。你倒在地上，听见膝盖里那声脆响——你知道世界杯结束了。你的队友最终捧起了奖杯，你在更衣室里看着电视，一瘸一拐地鼓掌。";
      break;
    }
    case "injury_before_tournament:recover":
      mods.overallDelta = (mods.overallDelta ?? 0) + (-3); mods.overallDelta = (mods.overallDelta ?? 0) + (3);
      mods.nationalTournamentParticipation = "skip";
      outcome = "你选择了养伤。世界杯在你的电视屏幕上上演，你的祖国一路杀进了决赛。你看着队友捧杯，心里说不出是欣慰还是遗憾。队医说你的决定保住了你五年的职业生涯——但那五年里你会一直想那个如果。"; break;

    case "injury:continue": {
      const delta = injuryDelta(ctx.injuryType ?? "hamstring");
      const il = injuryLabel(ctx.injuryType ?? "hamstring");
      const clean = roll(0.8, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (delta);
      mods.roleOverride = "substitute";
      injury = true;
      // Valence fix: 彻底休养 is the SENSIBLE choice inside an adversity event.
      // It used to hard-code good=false — the most common event in a career
      // (伤病) marked the rational pick as a loss 100% of the time, the single
      // biggest driver of the "every choice lands negative" complaint. A clean
      // recovery on a non-severe injury now reads ⇄ (the injury hurt, the
      // handling was right); only a botched recovery or a severe injury is ▼.
      good = clean && il.severity !== "重";
      tone = good ? "mixed" : "bad";
      const tags: string[] = [];
      // P-INJ2: 普通伤(轻+中)只影响当前赛季——即时扣 delta,deferred 回血
      //   Math.ceil(-delta/2) 使净~0(伤好即回,生涯不受损);重伤则即时扣 + 少量
      //   永久扣减(Math.floor(delta/2))影响生涯,但不挂 compromised_body 连坐
      //   (即时+永久已足够重,叠加持续侵蚀会让一次重伤≈生涯折断,见 P-INJ)。
      //   severe 仍计入(医学弧不变),重伤挂 cautious_play@2(收着踢回归、顺位
      //   暂降但不侵蚀成长)。持续侵蚀只留给"主动加重"的 play_through 失败。
      if (il.severity === "重") {
        severe = true;
        mods.overallDelta = (mods.overallDelta ?? 0) + (delta);
        mods.overallDelta = (mods.overallDelta ?? 0) + (Math.floor(delta / 2));  // 重伤永久扣 ~半 delta,影响生涯
        tags.push(tag("cautious_play", 2));
      } else if (clean) {
        // 普通伤净~0:即时扣 delta + deferred 回血一半,伤好即回,生涯不受损
        mods.overallDelta = (mods.overallDelta ?? 0) + (Math.ceil(-delta / 2));
      }
      if (!clean) { tags.push(tag("cautious_play", 3)); }
      // roleShift −1 曾在此设，但本 case 顶部已 roleOverride="substitute"——roleOverride
      //  胜出时 roleShift 机械失效（run.ts: developmentRole = roleOverride ?? resolveRoleWithShift），
      //  只剩一条误导性「位置下滑」pill。删之：沦为替补已是这一伤的唯一角色信号。
      if (tags.length) mods.addTags = tags;
      const out = il.severity === "重" ? "重伤告别本赛季，漫长康复在前" : il.severity === "中" ? "缺阵数周，静养康复" : "轻伤不下火线，但需休整";
      outcome = `诊断为${il.name}（${il.severity}伤）${out}${clean ? "。" : "。但恢复比预期慢——你学会了收着踢，顺位也滑了一档。"}`;
      break;
    }
    case "injury:play_through": {
      const delta = injuryDelta(ctx.injuryType ?? "hamstring");
      const il = injuryLabel(ctx.injuryType ?? "hamstring");
      const success = roll(0.45, "positive");
      good = success; injury = true;
      // P-INJ2: 与 continue 同拍——普通伤只伤当季(成功即时扣减+deferred 回血=净~0,
      //   赌赢保顺位是回报);重伤成功即时扣减+少量永久(影响生涯但不连坐)。失败
      //   =把伤拖重(轻伤也计 severe),即时扣 + 少量永久 + compromised_body@3(主动
      //   加重才连坐持续侵蚀,与 continue 重伤不连坐形成对比——这是选择的代价)。
      if (success) {
        if (il.severity === "重") {
          mods.overallDelta = (mods.overallDelta ?? 0) + (Math.ceil(delta / 2));
          mods.overallDelta = (mods.overallDelta ?? 0) + (Math.floor(delta / 4));  // 重伤硬上赌赢仍有永久代价
        } else {
          mods.overallDelta = (mods.overallDelta ?? 0) + (Math.ceil(delta / 2));
          mods.overallDelta = (mods.overallDelta ?? 0) + (Math.ceil(-delta / 2));  // 普通伤净~0,只伤当季
        }
        mods.roleOverride = "starter";
        mods.addTags = [tag("cautious_play", 2)];
      } else {
        severe = true;
        mods.overallDelta = (mods.overallDelta ?? 0) + (delta);
        mods.overallDelta = (mods.overallDelta ?? 0) + (Math.floor(delta / 2));  // 拖成重伤的永久代价
        mods.roleOverride = "substitute";
        mods.addTags = [tag("compromised_body", 3)];
      }
      outcome = success
        ? `你打封闭上了场。麻药压住了痛，你踢完了比赛——你清楚这只脚没真好，但你保住了出场，也保住了顺位。诊断为${il.name}。`
        : `你打封闭上了场。但下半场你听到了那声脆响——你把${il.name}拖成了重伤。担架把你抬下去时，你想起队医说过的那句话。`;
      break;
    }

    // 医学退役 arc (P-B1): the doctor's warning after the 2nd severe injury.
    case "doctor_warning:cautious":
      // P-DEGEN: 曾是纯收益（只 cautious_play，无代价）。安全路：deferred +1
      //（护住身体、踢得更久）+ cautious_play 护体；代价是收脚后顺位下滑
      //（roleShift −1，那些球你放了）。
      mods.addTags = [tag("cautious_play", 4)];
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      good = true;
      outcome = "你听进去了。你不再每球必争，你学会了在错误的拼抢前收脚。有些球你放了——看台上有人骂你软，你的顺位也滑了一档。但你知道他们没见过你的核磁共振片子。你想踢得更久，就得先学会踢得更聪明——你少拼了几个球，换来了多踢的几年。"; break;
    case "doctor_warning:defy": {
      // P-DEGEN: 「硬刚」曾是零回报陷阱（只 good=true 无代价）。现为 50/50 赌注：
      // 挺住 → perm +2（你证明了医嘱是错的，保持踢法）；倒下 → imm −3 +
      // compromised_body@6（身体替你做了决定）。与 optionOdds 的 doctor_warning:defy=0.5 同步。
      const hold = roll(0.5, "positive");
      if (hold) { mods.overallDelta = (mods.overallDelta ?? 0) + (2); good = true; }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-3); mods.addTags = [tag("compromised_body", 6)]; good = false; }
      outcome = hold
        ? "你把报告塞回抽屉。「我的踢法就是我。」整个赛季你比谁都凶，你证明了那份片子是保守的——你还在拼，还在赢。改了踢法的你不再是你——你宁可燃烧，也不愿变暗。这一次，火没有灭。"
        : "你把报告塞回抽屉。「我的踢法就是我。」但第十一周的一次拼抢里你听到了那声脆响——你宁可燃烧，身体替你说了「不」。你被人抬下场，队医什么也没说，只是把片子放回灯箱。他见过你这样的人。他知道结局的两种写法——你写了疼的那一种。";
      break;
    }

    // 医学退役 arc (P-B1): the verdict after the 3rd severe injury — accept a
    // dignified exit, or gamble everything on one more comeback.
    case "medical_verdict:accept_retirement":
      mods.forceRetire = true; mods.dignifiedExit = true;
      good = true;
      outcome = "你听完了，点了点头，握了握医生的手。\n发布会上你说：「我的身体先到了终点，但我是跑完的。」全场起立鼓掌了很久——为你拼过的每一次。你的俱乐部为你办了告别赛，看台上挂着横幅：谢谢你把自己踢碎在这里。\n你走得早，但你走得完整。"; break;
    case "medical_verdict:gamble": {
      const success = roll(0.25, "positive");
      good = success;
      if (success) {
        mods.overallDelta = (mods.overallDelta ?? 0) + (-4);
        mods.addTags = [tag("compromised_body", 6)];
        outcome = "十四个月。器械房的灯每天最早为你亮，最晚为你灭。医生说的每一个「不可能」，你都用一次深蹲还了回去。\n复出那天你替补登场，全场用你的名字盖过了广播。你不再是从前的你——你的身体里全是钢钉和伤疤。但你站在草皮上。你又站在草皮上了。";
      } else {
        mods.forceRetire = true;
        outcome = "你试了。你把康复计划贴在床头，你把止痛药当维生素吃。八个月后的一次折返跑，你听见了那声熟悉的响。\n医生这次没有说话，只是把片子放在灯箱上。你看着它，忽然笑了——不是不甘，是释然。你已经把能给的都给了。\n你在病床上宣布退役。没有告别赛，没有横幅。但你知道你试过了。这就够了。";
      }
      break;
    }

    // P-A27: career-threatening injury — the Ronaldo redemption arc.
    case "career_threatening_injury:rehab_war": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (-8);
      mods.statsMultiplier = 0.1;
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (6); mods.addTags = [tag("compromised_body", 3)]; }
      else { mods.addTags = [tag("compromised_body", 8)]; }
      good = success;
      outcome = success
        ? "一年。你用了整整一年。每天在康复室里从天亮练到天黑，比任何训练都痛苦。你无数次想放弃——但你想起了那个奖杯，想起了你倒下时全场安静的那一秒。一年后你回到了球场。你不再是曾经最快的那个你，但你站在了那里。你站在了那里。"
        : "你拼了。但你的身体比你的意志更强。一年后你回到了训练场，但你发现——你已经不是你了。你的速度没了，你的爆发力没了，你的膝盖在每一个雨天都会疼。你输了。你输给了你的身体。但你知道你没有放弃——你只是被打败了。";
      injury = true; severe = true;
      break;
    }
    case "career_threatening_injury:accept_end":
      // P-DEGEN: 故事写「接受终结」却未 forceRetire——选了等于没选，下赛季还在踢。
      // 现为真正的体面退出（参照 medical_verdict:accept_retirement）：forceRetire
      // 是收益也是代价（及时止损，保住已赚的传承 vs 隔壁 rehab_war 的赌注）。
      mods.forceRetire = true; mods.forceRetireReason = "injury"; mods.dignifiedExit = true;
      good = true;
      outcome = "你接受了。你躺在病床上看着窗外，想起了你的第一次触球、第一个进球、第一座奖杯。这就是终点——不是你想要的终点，但也许这就是故事该停的地方。你把球鞋收进了柜子，闭上眼睛，听见远处球场的欢呼声。那不再属于你了——但那是你留给他们的。"; break;

    // P-A28: pre-final collapse — play through the shadow or step aside.
    case "pre_final_collapse:play_anyway": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.overallDelta = (mods.overallDelta ?? 0) + (-3);
      mods.nationalTournamentParticipation = "force";
      good = success;
      outcome = success
        ? "你上场了。你的腿在发抖，但哨声响起的瞬间你忘了一切。你踢出了你生命中最好的九十分钟——也许是因为你差点没有这九十分钟。终场哨响，你跪在草地上，想起六小时前的医院。你不知道自己是勇敢还是愚蠢——但你站在了决赛的赛场上。"
        : "你上场了，但你的身体不在那里。你跑不动、看不准、碰不到球。你在场上像一个影子——在场但不在。终场哨响的时候对手在庆祝，你站在中圈看着一切发生。你想起六小时前队医问你的那句话。也许你不该上场。但你永远不会知道。";
      break;
    }
    case "pre_final_collapse:step_aside":
      // P-DEGEN: 曾是纯代价（只 natSkip，无收益）。补收益：稳涨 +1 perm +
      // cautious_play 护体（你保住了身体、没在决赛复发）；代价是退出决赛（natSkip）。
      mods.nationalTournamentParticipation = "skip";
      mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.addTags = [tag("cautious_play", 3)];
      good = false;
      outcome = "你告诉教练你上不了。他什么也没说——他看得出来。你坐在替补席上看着队友踢决赛，你的腿还在抖。他们赢了——或者他们输了——但你不在场上。你保住了身体，多踢了几年，但你做了个明智而不是勇敢的决定。你会想一辈子如果上场了会怎样。"; break;

    // ── climax: 荣誉线 ONLY。国家队大赛不碰 OVR——一场决赛不该带崩一整个 build
    //   （owner 决策，见 SOLO_ODDS_MULT）。选择在荣誉线内部：
    //   :a 自己扛起——胜率更高（× SOLO_ODDS_MULT），代价是烧干自己，输了俱乐部
    //      本赛季陪葬（forceTrophy league skip）。
    //   :b 相信队友——基线胜率，无附带代价。
    //   奖杯归属（worldCupResultOverride / natPart）在此处就位，不放在 builder
    //   包装层：previewBranch 只跑 resolveEventOption，包装层设的 mods 它看不见，
    //   选项卡就画不出「夺冠 / 屈居亚军」那对预览药丸。
    case "world_cup_showdown:a": {
      const success = roll(clamp((ctx.bossOdds ?? 0.5) * SOLO_ODDS_MULT, 0.05, 0.95), "positive");
      mods.worldCupResultOverride = success ? "champion" : "final";
      if (!success) mods.forceTrophy = { trophy: "league", result: "skip" };
      good = success;
      outcome = success
        ? "终场哨响。你跪在草地上，双手捂着脸——是你，是你把他们扛起到了这里。队友在跳，全世界在喊你的名字，但你只感受到草地的触感。你十六岁光脚踢球时梦的就是这一刻，而这一刻是你一个人赢来的。"
        : "球偏了。是你踢的。你看着它从门柱旁飞过，像慢动作。终场哨响，你站在中圈看着对方捧杯——全场都在看一个人，就是你。你把自己烧干在了那九十分钟里，回到俱乐部整个赛季都没缓过来，一座奖杯也没剩下。腿还是那双腿——只是这一年，什么都没赢。";
      break;
    }
    case "world_cup_showdown:b": {
      const success = roll(ctx.bossOdds ?? 0.5, "positive");
      mods.worldCupResultOverride = success ? "champion" : "final";
      good = success;
      outcome = success
        ? "终场哨响。你们跪在一起、抱在一起。不是你一个人——是十一双捺过加时的腿，是门将那次神扑，是中卫带伤挡的那一脚。奖杯传到你手里时很沉，你知道它不属于你一个人。你赢了，作为这支球队的一部分。"
        : "终场哨响。没有人说话，也没有人怪你——这是大家一起输的。你走过那座奖杯，它就在那里，离你一臂之遥。你们一起看了它一眼，然后一起走了。四年很长，但至少这份痛，你们一起背。";
      break;
    }
    case "world_cup_qualifier_showdown:a": {
      const success = roll(clamp((ctx.bossOdds ?? 0.5) * SOLO_ODDS_MULT, 0.05, 0.95), "positive");
      mods.nationalTournamentParticipation = success ? "force" : "skip";
      if (!success) mods.forceTrophy = { trophy: "league", result: "skip" };
      good = success;
      outcome = success
        ? "你冲进队友的怀里——但你知道，是你把他们拽进世界杯的。加时赛你抽筋的那条腿、带伤踢完的那九十分钟，全为了这一刻。预选赛打完了，世界杯在等你，因为你没有倒下。"
        : "终场哨响，你跪在地上起不来。你把自己烧干了，但没烧出一条路。四年，你要再等四年。回到俱乐部你也空了——那个赛季一座奖杯都没有。你想：如果再给你十分钟……但没有了。";
      break;
    }
    case "world_cup_qualifier_showdown:b": {
      const success = roll(ctx.bossOdds ?? 0.5, "positive");
      mods.nationalTournamentParticipation = success ? "force" : "skip";
      good = success;
      outcome = success
        ? "预选赛打完了——你们活下来了。没有谁是救世主，是一整支球队捺过了那几个月：凌晨的航班、伤病的疼痛、媒体的质疑。更衣室里香槟开了，老将哭了。你靠在墙边，你是他们中的一个，这就够了。"
        : "终场哨响的时候你跪在地上。不是伤了——是腿软了。你们一个个倒在地上，没有人说话，因为没有人能怪谁。四年，梦从你们所有人手里滑走了。不是你一个人的错，但痛是真的。";
      break;
    }
    case "continental_cup_showdown:a": {
      const success = roll(clamp((ctx.bossOdds ?? 0.5) * SOLO_ODDS_MULT, 0.05, 0.95), "positive");
      mods.worldCupResultOverride = success ? "national_continental" : "final";
      if (!success) mods.forceTrophy = { trophy: "league", result: "skip" };
      good = success;
      outcome = success
        ? "终场哨响。你跪在草地上，双手捂着脸——是你，是你把这个国家扛起到了这里。队友在跳，整个大洲在喊你的名字，但你只感受到草地的触感。你十六岁光脚踢球时梦的就是这一刻，而这一刻是你一个人赢来的。"
        : "球偏了。是你踢的。你看着它从门柱旁飞过，像慢动作。终场哨响，你站在中圈看着对方捧杯——全场都在看一个人，就是你。你把自己烧干在了那九十分钟里，回到俱乐部整个赛季都没缓过来，一座奖杯也没剩下。腿还是那双腿——只是这一年，什么都没赢。";
      break;
    }
    case "continental_cup_showdown:b": {
      const success = roll(ctx.bossOdds ?? 0.5, "positive");
      mods.worldCupResultOverride = success ? "national_continental" : "final";
      good = success;
      outcome = success
        ? "终场哨响。你们跪在一起、抱在一起。不是你一个人——是十一双捺过加时的腿，是门将那次神扑，是中卫带伤挡的那一脚。奖杯传到你手里时很沉，你知道它不属于你一个人。你赢了，作为这支球队的一部分。"
        : "终场哨响。没有人说话，也没有人怪你——这是大家一起输的。你走过那座奖杯，它就在那里，离你一臂之遥。你们一起看了它一眼，然后一起走了。四年很长，但至少这份痛，你们一起背。";
      break;
    }

    // ── P7: career-phase / rare / legendary / trait-flag branch resolutions ──
    case "academy_rivalry:outwork": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      outcome = success
        ? "你每天早到晚走，在黑暗的训练场里加练。一个月后教练在对抗赛上把你排进首发，把新人排到了板凳。他看了你一眼，什么也没说——但他眼里的光灭了。你赢了，但你记得那种被追赶的感觉。"
        : "你拼了，但他比你还拼。三个月后教练把你叫到办公室：「你先在替补席坐坐。」你走出办公室的时候，看见他正在和教练说笑。你想起一个月前他看你的眼神——那不是怯懦，是在等你松懈。";
      break;
    }
    case "academy_rivalry:befriend": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (success) mods.addTags = [tag("captain", 6)];
      good = success;
      outcome = success
        ? "你走过去递给他一瓶水。他愣了一下，然后笑了。从那天起你们开始一起加练——他比你快，你比他稳，你们互相补上了对方的短板。教练在远处看着，点了点头。"
        : "你递过去的那瓶水他接了，但也仅此而已。他继续比你早到一小时，而你把时间花在了陪他聊天上。名单公布那天他的名字在你上面——你交到了一个朋友，也让出了一个位置。";
      break;
    }

    case "scout_attention:showcase": {
      // 豁命表现是赌一把：成了名字跳出这座城市，败了用力过猛砸了自己的位置。
      const success = roll(0.65, "positive");
      if (success) mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      else mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你在那场比赛里做了所有你能做的事——一次过人、一脚远射、一个助攻。终场后球探走到你面前，把笔记本翻到你那一页，上面写着两个字：「关注」。你的名字从今天起不再只属于你的城市。"
        : "你太想表现了。你做了不该做的动作，传了不该传的球。终场后球探合上笔记本走了。下一场首发名单上你的名字掉了一档——教练说你「想表现的欲望盖过了表现本身」。助理教练拍你肩：「别在意，以后还有机会。」但你知道——有些人只来一次。";
      break;
    }
    case "scout_attention:play_normal": {
      const success = roll(0.65, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你没有为那个穿西装的陌生人改变任何东西。你按自己的节奏踢了九十分钟——该传的传，该跑的跑，没多也没少。终场后球探合上笔记本走了，助理教练看了你一眼，什么也没说。你不知道他会不会再来，但你踢的是你自己的球——有些球员一辈子都在为别人表演，你不是。"
        : "你按自己的节奏踢完了九十分钟。球探合上笔记本走了，再也没有回来。后来你听说他那天记下了三个名字，没有一个是你——有些机会不敲第二次门，你把它当成了普通的一场球。";
      break;
    }

    case "captaincy_offer:accept": {

      const success = roll(0.6, "positive");

      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);

      if (success) mods.addTags = [tag("captain", 8)];

      good = success;

      outcome = success

        ? "你接过了袖标。它很轻，但在你臂上沉得像整个赛季的重量。第一个输球的夜晚，更衣室里所有人都在等你说话。你站起来说了句什么——后来队友告诉你，那是他们听过的最好的更衣室讲话。"

        : "你接过了袖标，然后发现它太重了。输球的夜晚所有人都看着你，赢球的夜晚没有人提你。你开始为更衣室的事失眠，你的球随之下滑——你成了队长，但你不再是那个球员。";

      break;

    }
    case "captaincy_offer:decline":
      // P-DEGEN: 「婉拒」曾是零回报陷阱。安全路：稳涨 +1 perm（不受袖标重压、专注踢球），
      // 代价是错过袖标的领导站位 → roleShift −1（你不是那个把更衣室拢起来的人）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      good = true;
      outcome = "你把袖标退回去了。主帅什么也没说，转手给了别人。你继续踢你的球，稳稳地涨了一截——但你顺位滑了一档，你不再是更衣室里那个把人拢起来的人。你偶尔会看见新队长讲话时队友们点头的样子，想：那本来可以是我。"; break;

    case "contract_saga:hold_out": {
      const success = roll(0.5, "positive");
      // P-A18: the wage tradeoff — holding out can win a big raise (legacy via
      // wage) but risks the club freezing you out (roleShift −1 = less pitch
      // time = slower growth). The financial-vs-development fork.
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      if (!success) { mods.roleShift = -1; }  // frozen out, bench time
      good = success;
      outcome = success
        ? "僵持了六周后，主席终于松口。新合同上的数字让你经纪人笑了——但你注意到，主帅把你从下一场的首发名单上划掉了。你拿到了钱，但失去了一些更重要的东西。"
        : "俱乐部没有退让。他们把你放上板凳，让全世界知道「没有你他们也能赢」。你在替补席上坐了两个月，看着自己的身价一点一点跌。你想起经纪人说的「强硬点」——现在你觉得他是在说风凉话。";
      break;
    }
    case "contract_saga:settle": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你爽快签了。主帅在训练中叫住你：「谢谢你没搞事。」下一场你首发了，踢了九十分钟。合同上的数字不大，但你的出场时间——那才是真正的身价。"
        : "你爽快签了，然后什么也没发生。承诺的出场时间成了替补席上的九十分钟，主帅换了人，新的合同不是他签的。经纪人在电话里说「我早跟你说过」——你没有回。";
      break;
    }

    // P-A18: wage demand — the explicit money-vs-growth fork.
    case "wage_demand:demand": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      // success: big raise (legacy via wages) but the club remembers (no growth
      // bonus). failure: frozen out, bench time, OVR stall.
      if (!success) { mods.overallDelta = (mods.overallDelta ?? 0) + (-3); mods.roleShift = -1; }
      good = success;
      outcome = success
        ? "俱乐部咬牙答应了。你成了队内第一高薪——但也成了更衣室里最孤立的一个人。队友看你的眼神变了，他们嘴上不说，但你知道他们在算你的工资和他们差了多少。"
        : "主席把你的要求书摔在桌上：「你以为你是谁？」从那天起你被放上了板凳。每场比赛你坐在那里看着别人踢你的位置，想起那份对比表——上面那些数据比你好的球员，没有一个被放上板凳。";
      break;
    }
    case "wage_demand:team_friendly": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你签了那份团队友好合同。经纪人说你傻。但下一场你首发了，踢满了九十分钟，赛后主帅搂着你说「你是这支球队的脊梁」。有些东西不在合同上，但比合同重。"
        : "你签了那份团队友好合同。半年后俱乐部用省下的钱买了一个和你同位置的人，工资是你的三倍。你在替补席上看着他踢你的位置——原来「团队友好」只是对俱乐部友好。";
      break;
    }

    case "loyalty_test:agitate":
      // agitating for a move tags betrayal (triggers rival_fan_revenge if at a big club later)
      mods.addTags = ["rival_betrayal"]; mods.roleShift = -1; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      good = false; outcome = "你回复了那条消息。从那天起你开始在场上的表现里「做文章」——不积极跑动、不全力拼抢。球迷开始嘘你，队友开始远离你。但你的身位被那家豪门拍了上去，手机里躺着一张机票——你用一整个更衣室的信任，换了一张去更大的地方的票。"; break;
    case "loyalty_test:stay_loyal": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你删除了那条消息。豪门的体育总监再也没有联系你。第二天训练你比任何人都卖力，队友问你怎么了，你说没什么。但你心里知道——你选了爱而不是奖杯。有些人会说这是忠诚，有些人会说这是愚蠢。"
        : "你删除了那条消息。半年后俱乐部把你挂牌了——他们从来没有回报过你的忠诚，因为他们根本不知道你拒绝过谁。忠诚是一件只有你自己知道的事，这就是它最贵的地方。";
      break;
    }

    case "veteran_mentor:mentor": {

      const success = roll(0.6, "positive");

      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);

      if (success) mods.addTags = [tag("captain", 6)];

      good = success;

      outcome = success

        ? "你花了整个下午教他那个过人。他学不会，但你没有急。你想起你刚出道那年也有人这样教你。临走前他抱了你一下，说「我永远不会忘记今天」。你拍了拍他的背，心里某个角落亮了一下。"

        : "你花了整个赛季教他。他学会了，然后顶掉了你的位置。教练在新闻发布会上夸你是「更衣室的榜样」——榜样是给要走的人的称号。";

      break;

    }
    case "veteran_mentor:stay_selfish":
      // P-DEGEN: 「拒绝带徒弟」曾是零回报陷阱。安全路：稳涨 +1 perm（专注自己），
      // 代价是错过队长袖标的领导站位 → roleShift −1（你不带人，就不被当领袖）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      good = true;
      outcome = "你委婉地拒绝了他。他低着头走了。训练场上你继续练自己的，稳稳地涨了一截——但你不带人，也就没人把你当领袖，顺位悄悄滑了一档。那天晚上你回家的时候，想起了自己十七岁时，那个教你过人的老球员。他要是也拒绝了，你会在哪里？"; break;

    case "body_decline:adapt": {

      const success = roll(0.65, "positive");

      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);

      good = success;

      outcome = success

        ? "你开始改变踢法。不再追着球跑，而是提前预判——用脑子跑。前几场你踢得很别扭，但一个月后你发现自己少跑了两千米，传球却更准了。队医说你多踢了三年，你说那三年是脑子给的。"

        : "你试着改踢法，但改不过来。十几年的肌肉记忆不听脑子的话——你既跑不动了，也没学会不跑。你踢得比原来更别扭，数据比原来更难看。";

      break;

    }
    case "body_decline:ignore": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      if (!success) mods.addTags = [tag("compromised_body", 5)];
      good = success; injury = !success;
      outcome = success
        ? "你硬扛着踢。每场比赛后膝盖都在肿，但你冰敷完第二天照常训练。你撑过了这个赛季——但队医说你的膝盖年龄比你实际年龄大十岁。"
        : "你的膝盖在第三场比赛里彻底爆发了。你倒在草地上的时候听见自己说「不应该的」。你被抬出场，队医的表情告诉你一切——你不服老，但老不会放过你。";
      break;
    }

    case "farewell_match:accept": {

      const success = roll(0.55, "positive");

      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -2);

      if (!success) mods.roleShift = -1;

      good = success;

      outcome = success

        ? "终场哨响的时候你没有立刻走。你站在球场中央，看着看台上一排排空了的座位，想起了十六岁第一次走进这里的那天。横幅还在，球迷还在，但你知道这是最后一次了。你弯腰抓了一把草皮放进口袋里——那比任何奖杯都重。你没有哭，没有演说，只是站在那里，听着最后的掌声慢慢散去。你选择在巅峰离开——足球里最稀有的东西，是完美的告别。"

        : "你选择在这一天结束。但那场告别赛下着雨，看台只坐了一半，俱乐部把仪式塞进了中场休息的十分钟。广播念你的名字时念错了一个字。你回到更衣室，发现没有人在等你——他们已经在准备下一场了。";

      break;

    }
    case "farewell_match:postpone": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你告诉球迷你明年再来。横幅被收起来了，球迷散了。你回到更衣室，队友说「你还想踢」。你想了想——是的，你还想。但你也知道，有些告别拖得越久越难开口。也许你会在明年找到那个完美的时刻——也许你会一直拖下去，直到身体替你做决定。那时候就不是告白了，是被迫。"
        : "你告诉球迷你明年再来。但明年你没能上场——身体先替你做了决定。没有横幅，没有掌声，没有一把草皮。你的最后一场比赛是哪一场，你自己都想不起来了。";
      break;
    }

    // rare
    case "mystery_benefactor:accept": {
      const success = roll(0.7, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      outcome = success
        ? "那笔钱让你请到了最好的体能团队。三个月后你的体测数据全部提升了一档。你再也没有见过那个戴墨镜的人，但每次上场前你都会想起他——不管他是谁，他改变了你的生涯。"
        : "一个月后那个陌生人上了新闻——涉嫌洗钱被通缉。你看着电视上的通缉令，想起那个信封。第二天足协的人来找你谈话了。";
      break;
    }
    case "mystery_benefactor:reject":
      // P-DEGEN: 「拒收」曾是零回报陷阱。安全路：稳涨 +1 perm（干净地练），
      // 代价是没请到顶级体能团队 → roleShift −1（错过一飞冲天的上限）。
      // 隐性收益：不卷入洗钱风波（躲过 accept 失败分支的足协谈话）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      good = true;
      outcome = "你把信封和名片放进了俱乐部的失物招领箱。那个陌生人再也没有出现过。你按自己的节奏稳稳地涨了一截，没请到那支顶级体能团队，顺位也悄悄滑了一档——但你每晚都睡得很好，足协的人永远不会来找你谈话。"; break;

    case "prodigy_sibling:sponsor": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你把弟弟带进了青训营。他比你当年还拼，三个月后教练说他天赋比你高。你笑了——你不嫉妒，你骄傲。母亲在电话里哭着说谢谢。"
        : "弟弟来了，但他不适应。他想家、想朋友、想在泥地里踢球的日子。他开始旷训，你的精力被牵扯进去，场上表现也开始下滑。你想起母亲说的「他可能会超过你」——现在你只希望他别被自己拖垮。";
      break;
    }
    case "prodigy_sibling:distance":
      // P-DEGEN: 「让弟弟自己走」曾是零回报陷阱。安全路：稳涨 +1 perm（专注自己），
      // 代价是被看作不肯带人 → roleShift −1（你不是那个拉人一把的人）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      good = true;
      outcome = "你打了电话给母亲，说弟弟得自己走。母亲沉默了很久，说「我懂」。你挂了电话，把全部心思放回自己身上，稳稳地涨了一截——只是你不肯拉人一把，也就没人把你当那个提携后辈的人，顺位悄悄滑了一档。你看着自己十六岁离开家时的那张旧照片——那时候也没有人帮你，但你自己走过来了。"; break;

    case "weather_odyssey:accept": {
      const success = roll(0.65, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你到了一个你从没听说过的小城。语言不通、食物不习惯、球迷的热情你听不懂。但你在那块破旧的球场上学会了一种全新的踢法。回国后队友说你变了——你踢球的方式里多了些他们说不上来的东西。"
        : "你到了那个国家，但一切都不对。教练的训练方法让你受伤，当地食物让你的体重暴涨，你坐了半年板凳。回国后你发现你的位置已经被别人占了——你去了世界的另一端，回来后自己的位置也没了。";
      break;
    }
    case "weather_odyssey:stay":
      // P-DEGEN: 「留在舒适区」曾是零回报陷阱。安全路：稳涨 +1 perm（主场安稳发展），
      // 代价是没去世界另一端长见识 → roleShift −1（你踢法没变宽，俱乐部眼光滑向那些出去过的人）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      good = true;
      outcome = "你把机票放进了抽屉。你在主场安稳地涨了一截，没去世界另一端冒那个险——只是你踢法没变宽，俱乐部的眼光也慢慢滑向了那些出去过的人，顺位悄悄落了一档。也许你会一直好奇那个国家——但舒适区至少让你没受伤、没丢位置以外的东西。"; break;

    // P-A21: the fall from grace — reinvention vs denial.
    case "fall_from_grace:reinvent": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你不再追那个追不上的球了。你开始提前两步想——用脑子跑而不是用腿跑。三个月后队友说你像换了一个人。你不会再像从前那样飞奔了，但你找到了一种新的统治比赛的方式。"
        : "你试图改变，但旧习惯太深了。你的脑子知道该怎么做，你的腿却跟不上。你处在两种踢法之间，两种都不是你。教练在新闻发布会上说「他在适应」——但你看得出他等不了太久。";
      break;
    }
    case "fall_from_grace:deny": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      good = success; injury = !success;
      outcome = success
        ? "你加倍训练。你比所有人都早到，比所有人都晚走。你的速度没有回来，但你的意志力让教练无法把你拿下。你用意志力证明了身体是骗人的——至少暂时。"
        : "你不服老，但你的身体不这么想。你在一次冲刺中拉伤了肌肉——那种年轻时候三天就能好的伤，现在要休养六周。你躺在治疗台上，终于明白了：有些东西，不是意志力能追回来的。";
      break;
    }

    // P-A21: dressing room politics — mediation vs picking sides.
    case "dressing_room_split:mediate": {
      const success = roll(0.5, "positive");
      mods.leagueTrophyProbabilityMultiplier = success ? 1.3 : 0.8;
      good = success;
      outcome = success
        ? "你在更衣室里把两拨人拉到了一起。你说了句什么，然后有人笑了。气氛松了一点。第二天训练场上所有人又开始一起热身了——不是因为问题解决了，而是因为你让他们想起他们是一支球队。"
        : "你试了，但裂痕太深了。你被两边同时疏远——他们觉得你在和稀泥。更衣室更冷了，训练场上没人说话。你站在中间，第一次觉得更衣室比球场更难踢。";
      break;
    }
    case "dressing_room_split:pick_side": {
      // P-DEGEN: 曾是纯代价（只 club_faction 标签，无收益）。补收益：稳涨 +1 perm +
      // 位置上升 +1（你选的那派多传给你、报你）；代价是更衣室裂痕 → club_faction
      // 标签（后续新帅更难讨好）+ 联赛夺冠 ×0.8（一支分裂的球队赢不了）。
      mods.addTags = [tag("club_faction", 3)];
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = 1;
      mods.leagueTrophyProbabilityMultiplier = 0.8;
      good = false;
      outcome = "你选了一边。从那天起更衣室里一半人对你点头，另一半人装作看不见你。训练场上的传球线路变了——你选的那边多传给你，没选的那边不传。你的顺位往上挪了一截，是被你那一派抬上去的——但你知道这支分裂的球队这个赛季赢不了什么，你在球队里也多了一群敌人。"; break;
    }

    // P-A21: family strain — the personal cost of football.
    case "family_strain:family_first":
      mods.roleShift = -1; mods.overallDelta = (mods.overallDelta ?? 0) + (1); good = true;
      outcome = "你开始多回家。你陪孩子去了家长会，你陪妻子吃了饭。你的出场时间少了——但你回家时孩子跑过来抱你的样子，让你觉得这比进球重要。你的队友说你变了，你说你只是终于清醒了。"; break;
    case "family_strain:stay_focused": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你选择了足球。赛季结束时你捧起了奖杯，但领奖台上没有人等你——你的妻子带着孩子回了娘家。你在更衣室里抱着奖杯，第一次觉得它比想象中轻。"
        : "你选择了足球。赛季结束后你回家，发现家里空了——衣柜少了一半，冰箱上孩子的画被取走了。你坐在沙发上，想起她说「你很久没陪孩子了」——你那时候说「赛季关键期」，现在赛季结束了，家也结束了。";
      break;
    }

    // P-A21: tabloid spiral — fame vs focus (the Gascoigne dimension).
    case "tabloid_spiral:embrace_fame": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      if (!success) mods.addTags = [tag("compromised_body", 4)];
      good = success;
      outcome = success
        ? "你成了这座城市的国王。你的赞助商翻倍了，你的名字出现在每本杂志上。你踢球的时候看台上有多了一倍的人——他们不全是来看足球的。但你的表现没有掉，至少暂时没有。你知道这条路危险——但你想着那句老话：天赋有时候带着毁灭的倾向。你选择相信你能控制它。"
        : "夜生活开始吞噬你。训练迟到、状态下滑、体重上升。你凌晨四点从夜店出来的时候被人拍了照——和你十六岁第一次走进训练场时的样子判若两人。主帅在新闻发布会上说「他需要做出选择」。你没有选择——或者说，你已经选了。你看着八卦头条上的自己，认不出那个人了。你想起那句老话：最大的天赋，有时候是最大的诅咒。";
      break;
    }
    case "tabloid_spiral:step_back": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你拒绝了所有派对邀约。经纪人骂你错失了曝光机会。但你回到了训练场，比任何人都早到。赛季结束时你的数据是生涯最佳——真正的头条应该是这个。你知道天才和自律不矛盾——你选择用自律保护你的天赋，而不是让天赋成为你毁灭的起点。"
        : "你拒绝了所有派对邀约，回到了训练场。但你练得越狠，状态反而越僵——你把自己关起来了，而足球是一件需要松弛的事。赛季结束时你的数据是三年来最差的，头条上换了别人的名字。";
      break;
    }

    // P-A21: the reckless challenge — like Gazza's 1991 final.
    case "reckless_challenge:own_it": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? -1 : -4);
      // 轻伤：5场停赛+6周伤停≈半个赛季——少踢而非整季停赛（红牌+受伤不是赛季报销）。
      if (!success) { injury = true; mods.statsMultiplier = 0.5; mods.addTags = [tag("compromised_body", 4)]; }
      good = success;
      outcome = success
        ? "红牌。你走进更衣室的时候没有找借口。主帅说「至少你没有装」。赛后对方球员发了条消息给你：「那个铲球很脏，但你是个男人。」你被停赛三场——但你心里那口气出了。"
        : "红牌。但你和对方都受伤了。你躺在治疗台上看着天花板，想起那个对视的瞬间——你们都做了不该做的事。停赛五场，伤停六周。你用一次冲动赌上了半个赛季。";
      break;
    }
    case "reckless_challenge:dive": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      // 轻罚：假摔败露=黄变红+追加两场停赛——少踢一截，不至于整季停赛。
      if (!success) mods.statsMultiplier = 0.8;
      good = success;
      outcome = success
        ? "裁判看了你一眼，没有出牌。你逃过了。但赛后回放把你送上了热搜——「演员」「骗子」。你看着评论区的骂声，知道你丢了比红牌更重要的东西。"
        : "裁判没有买账——黄牌变红牌，停赛追加两场。赛后媒体把你的假摔做成了集锦。你的队友在更衣室里什么也没说，但他们看你的眼神变了。";
      break;
    }

    // P-A21: fan idolatry — the weight of being someone's hero.
    case "fan_idolatry:embrace": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你开始认真对待那个小球迷的信任。你去儿童医院探访，你在训练里加倍努力——不是为了奖杯，是为了不辜负那双亮着的眼睛。你发现当你为别人踢球时，你比为自己踢球时更强。"
        : "你开始认真扮演那个孩子眼里的神。你去探访，你做活动，你的日程被塞满了。但赛季中段你在一场关键战里踢丢了——转播镜头扫到看台上那张脸。你那晚没睡着：你把力气花在了当英雄上，忘了英雄首先得会踢球。";
      break;
    }
    case "fan_idolatry:step_down":
      // P-DEGEN: 「拒绝当神」曾是零回报陷阱。安全路：稳涨 +1 perm + cautious_play
      //（不背英雄重压、身体护住），代价是错失形象建设的站位 → roleShift −1。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      mods.addTags = [tag("cautious_play", 2)];
      good = true;
      outcome = "你拒绝了公开活动。你的经纪人说你错失了建立形象的机会——顺位也悄悄滑了一档。但你觉得——让一个孩子把你当神，是不公平的。你只是一个会犯错的人。你稳稳地涨了一截，没背那顶神冠，身体也没被重压压垮。你继续踢你的球，但你让那个孩子知道：英雄也会失败。"; break;

    // P-A23: deadline day drama — three-way fork.
    case "deadline_day_drama:gamble_big":
      // P-DEGEN: 曾是纯收益（豪门轮换 + 夺冠 ×1.5 无代价）。补代价：最后一刻仓促转会
      // 打乱节奏 → imm −1（「十个人竞争你的位置」的代价具象化）。
      mods.roleOverride = "high_rotation"; mods.leagueTrophyProbabilityMultiplier = 1.5;
      mods.overallDelta = (mods.overallDelta ?? 0) + (-1);
      good = true; outcome = "你在最后三分钟签了豪门的合同。飞机在等你。你走进新更衣室的时候，看见十个人在竞争你的位置——欢迎来到食物链的顶端。头几场你还没摸透新体系，踢得生涩，但你离奖杯确实更近了。你的经纪人笑了，你不确定自己该不该笑。"; break;
    case "deadline_day_drama:secure_role":
      // P-DEGEN: 曾是纯收益（中游队主力 + 稳涨 无代价）且支配另两项。补代价：中游队
      // 争冠力远不及豪门 → 联赛夺冠 ×0.7。
      mods.roleOverride = "starter"; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.leagueTrophyProbabilityMultiplier = 0.7;
      good = true; outcome = "你去了中游队。签约那天主席说「你是我们的核心」。第二天训练你发现他说的是真的——所有战术都围绕你，你稳稳地涨了一截。你不是最大的鱼，但你是池塘里最重要的那条——只是这座池塘的奖杯橱窗，比豪门那座窄一些。"; break;
    case "deadline_day_drama:go_home":
      // P-DEGEN: 曾是纯收益（母国主力无代价）。补代价：回国是降档，老东家争冠力最弱
      // → 联赛夺冠 ×0.6；收益：衣锦还乡的安稳 → deferred +1（你踢得轻松、涨一截）。
      mods.roleOverride = "starter"; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.leagueTrophyProbabilityMultiplier = 0.6;
      good = true;
      outcome = "你回了母国的老东家。机场有人认出了你，举着手机拍照。你走进那座你十六岁离开的球场——草皮换了，看台新了，但空气里的味道你认得。你回家了，踢得轻松，涨了一截——只是这里的奖杯橱窗是三家里最窄的。有些人说你退步了，你说你只是走回了正确的方向。"; break;

    // P-A23: forced sale — the player as commodity.
    case "forced_sale:accept_fate": {
      // P-DEGEN: 故事写「你去了新俱乐部」却未 newClubId（描述与行为不符），且曾是纯收益。
      // 现为真正的转会：选一家同联赛更强的俱乐部（你被卖上去，但只是轮换），
      // 代价是仓促转会打乱节奏 → imm −1。选队权——玩家挑被卖到哪里。
      const buyers = CLUBS.filter((c) => c.id !== ctx.club.id && c.leagueId === ctx.league.id && c.rep > ctx.club.rep)
        .sort((a, b) => a.rep - b.rep);
      const dest = buyers[0];
      if (dest) mods.newClubId = dest.id;
      mods.roleOverride = "high_rotation"; mods.overallDelta = (mods.overallDelta ?? 0) + (-1);
      good = true;
      outcome = dest
        ? `你去了${dest.name}。第一天训练你比任何人都拼——因为你要让旧主席在电视前看到他卖掉了什么。你的新队友问你怎么了，你说没什么——只是头几场你还没摸透新体系，踢得生涩。你心里在数着下次客场对阵旧主的日子。`
        : "你去了新俱乐部。第一天训练你比任何人都拼——因为你要让旧主席在电视前看到他卖掉了什么。你的新队友问你怎么了，你说没什么。但你心里在数着下次客场对阵旧主的日子。";
      break;
    }
    case "forced_sale:refuse":
      // P-DEGEN: 曾是纯代价（roleShift −2，无收益）。补收益：稳涨 +1 perm +
      // cautious_play（你一个人在空场练、身体护住）；代价仍是顺位大滑、罢训恶名。
      mods.roleShift = -2; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.addTags = [tag("cautious_play", 2)];
      good = false;
      outcome = "你拒绝报到。俱乐部停了你的工资，媒体说你「罢训」。你一个人在空荡的训练场上跑步，稳稳地保住了身体，也涨了一截——只是顺位掉了两档，等待这堵墙裂开。也许你会赢——也许你会成为那个「和俱乐部对抗的球员」。但你至少没有让他们把你像家具一样搬走。"; break;

    // P-A24: homesickness at the academy — La Masia loneliness.
    case "academy_homesick:push_through": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      good = success;
      outcome = success
        ? "你擦干了眼泪。第二天你比任何人都早到训练场。教练什么也没问，只是在训练结束后拍了拍你的肩。你开始习惯了——不是因为不想家了，而是因为你找到了一个理由留下来。那个理由叫足球。"
        : "你忍住了眼泪，但你忍不住想家。训练里你心不在焉，传球失误，教练开始皱眉。你回到宿舍看着手机里妈妈的照片，想起你为什么来这里——但你想不起足球了。也许你需要回去看看。";
      break;
    }
    case "academy_homesick:call_home": {
      const success = roll(0.65, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你打了电话。妈妈在电话那头哭了，你也哭了。她说「不想踢就回来，没人怪你」。你说你要想想。第二天你回到训练场——不是因为不想家了，是因为你想给妈妈一个能让她在电视前看你踢球的理由。"
        : "你打了电话回家。听到母亲声音的那一刻你哭了，然后你哭了整整一周——那通电话没有治好你的想家，它只是把伤口重新划开了。你在训练里心不在焉，教练问你是不是不想踢了。";
      break;
    }

    // P-A25: conscience — speak out vs stay silent.
    case "conscience_stand:speak_out": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -2);
      good = success;
      outcome = success
        ? "你说了。你说了那些别人不敢说的话。第二天你的名字上了每一个头条——不是体育版，是头版。赞助商撤了两个，但你的国家队队友发来消息说「你做了我们都不敢做的事」。有些人说你是英雄，有些人说你多管闲事。但你知道——你只是做了一个人该做的事。"
        : "你说了。代价来了。赞助商撤了，俱乐部主席找你谈话，你的首发位置开始不保。媒体开始挖你的私生活——他们惩罚的不是你的观点，而是你敢说出来。你想起经纪人说的「别碰政治」。也许他是对的——但你现在不能收回那句话了。";
      break;
    }
    case "conscience_stand:stay_silent":
      // P-DEGEN: 曾是纯代价（只 good=false 无任何机制）。补收益：稳涨 +1 perm（你保住了赞助、
      // 安稳的赛季）；代价是顺位下滑（你成了那个不说话的人，不被当领袖）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      good = false;
      outcome = "你微笑着说「我只是一个球员」。话筒转向了下一个人。你的经纪人松了口气，赞助商也松了口气，你保住了安稳的赛季——只是顺位滑了一档，你成了那个不说话的人。那天晚上你躺在床上，想起那些等着有人替他们说话的人。你没有说话——没有人怪你，但你知道你错过了什么。"; break;

    // P-A30: racism — speak out or let football speak.
    case "racist_abuse:speak_out": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      good = success;
      outcome = success
        ? "你停下了比赛。你走到场边，指着那些发出猴子叫声的看台。裁判想让你继续，但你不动。全场开始沸腾——但你也看到了另一边：有人开始鼓掌。赛后你的祖国点亮了地标建筑声援你。你输了这场比赛，但你赢了一些比比赛更大的东西。"
        : "你停下了比赛，但联赛说「这只是个别球迷的行为」。你的俱乐部主席暗示你「不该把事情闹大」。赞助商开始犹豫——他们不想和「争议球员」绑定。你站在球场中央，发现对抗的不是几个球迷，是整个系统。但你不后悔——有些事情比足球大。";
      break;
    }
    case "racist_abuse:play_through": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你咬着牙继续踢。你进了球——你跑到角旗区跳了一支舞，面对着那些发出猴子叫声的看台。他们嘘你，但你笑着。赛后你说：「他们的恨，是我进球的动力。」你的进球上了头条，但你知道真正的胜利不在比分板上。"
        : "你选择用球回应。但那些声音没有停，它们钻进了你的耳朵，钻进了你的每一次触球。你那场踢丢了两个必进球，看台上的笑声更大了。回到更衣室你才发现自己的手一直在抖——沉默不是坚强，沉默只是把这一切留在了你自己身体里。";
      break;
    }

    // P-A91: walk off — the Eto'o dimension. Refusing to perform for those
    // who treat you as less than human. The loneliest walk in football.
    case "racist_abuse:walk_off": {
      // P-DEGEN: 曾是纯代价（只 suspended，无收益）。补收益：稳涨 +1 perm +
      // fan_darling（你走下场的勇气让全世界声援你，球迷宠儿）；代价是停赛罚单+少踢半季。
      mods.statsMultiplier = 0.5; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.addTags = [tag("fan_darling", 6)];
      good = true;
      outcome = "你走向边线。你没有看裁判，没有看教练，没有看队友。你只走向球员通道。\n你的队友追上来拦你——「回来，别给他们满足感」。你停下来，看着他们。你说：「我不为把我当动物的人表演。」\n他们说服了你回去——这一次。但你走在球场上的时候，你听到的不只是猴子的叫声。你听到你自己的声音说：够了。\n赛后你不带你的孩子来看球了。你走下场的勇气让全世界为你声援——你成了球迷宠儿，也吃了一张停赛罚单。有些人说你是「懦夫」。你知道你走下场的勇气比留在场上更大。";
      break;
    }

    // P-A31: fitness failure — crash diet vs own it.
    case "fitness_failure:crash_diet": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -3);
      if (!success) mods.addTags = [tag("compromised_body", 3)];
      good = success;
      outcome = success
        ? "你用一个月减掉了六公斤。你每天只吃鸡胸肉和西兰花，跑十公里，喝水喝到想吐。但赛季第一场比赛你跑了全场最多的距离，教练在赛后握手时什么也没说——他不需要说。你用行动回击了他的质疑。"
        : "你拼命减了，但减得太快。第三周你在训练中拉伤了大腿——身体在抗议你的暴虐。你坐在治疗台上想：也许该慢慢来的。但教练不会等你慢慢来。";
      break;
    }
    case "fitness_failure:own_it": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.roleShift = -1;
      if (!success) mods.overallDelta = (mods.overallDelta ?? 0) + (-2);
      good = success;
      outcome = success
        ? "你没有减肥。你用你的技术踢球——你过人、传球、创造机会。也许你跑得比别人少，但你做的每一件事都有价值。赛季结束后你的助攻数是全队第一。教练不再说你的体重了——他只说你的名字。"
        : "你拒绝减肥。但足球不是只有技术——你需要跑，你需要拼，你需要证明你配得上这身球衣。教练把你放上了板凳。你坐在那里看着比你差但比你努力的球员踢你的位置。你的天赋没有消失——但它需要一个身体来承载。";
      break;
    }

    // P-A32: fan confrontation — the Cantona kung-fu kick moment.
    case "fan_confrontation:snap": {
      const success = roll(0.2, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.statsMultiplier = 0.15; mods.overallDelta = (mods.overallDelta ?? 0) + (-2);
      good = success;
      outcome = success
        ? "你飞起一脚踹向那个球迷。全场炸了。你被禁赛八个月，被剥夺国家队队长袖标，上了全世界每一个头条。但在赛后，有些球迷说「他做了我们想做但不敢做的事」。多年后有人问起这件事，你说：「那是一种很棒的感觉。但这确实是个错误。」"
        : "你飞起一脚踹向那个球迷。全场炸了。你被禁赛八个月，俱乐部罚了你两个月的工资，你的国家队生涯结束了。你在社区服务时教小孩子踢球——他们不知道你做过什么，他们只觉得你踢得好。你看着他们的笑容，想起你第一次踢球时也是这样的。";
      break;
    }
    case "fan_confrontation:walk_away": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你转身走进了通道。你没有回头。那个球迷的声音在身后越来越远。第二天你的克制上了头条——「他证明了他比辱骂他的人更强大」。你没有接受采访。你只是回到了训练场，比任何人都早到。有些胜利不在比分板上。"
        : "你转身走开了。但那段视频还是传开了——被剪掉了他骂你的前半段，只剩下你阴着脸走开的背影。「傲慢」「不尊重球迷」，标题是别人替你写的。你什么也没做错，也什么都没能证明。";
      break;
    }

    // P-A34: price-tag pressure — force it vs simplify (Torres dimension).
    case "price_tag_pressure:force_it": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      outcome = success
        ? "你要了球。你带球过了两个人，起脚——球进了。你跑到角旗区没有庆祝，只是闭上了眼睛。八场的荒终于结束了。你听见看台在喊你的名字——不是在数钱，是在欢呼。你想起那个数字，此刻它不重要了。"
        : "你要了球，但你太急了。你射门偏了，传球丢了，带球被断了。你的队友开始绕开你——不是不信任你，是不想看你再失败一次。你回到更衣室看着手机上那个转会费数字，想起那些天价买来却一个赛季进不了球的名字。你正在变成那个故事。";
      break;
    }
    case "price_tag_pressure:simplify": {
      const success = roll(0.65, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你不再想着进球了。你开始为队友做墙、跑位、拉开空间。你成了一座桥——不是最耀眼的那个人，但没有你球过不去。三周后你在一次反击中不经意地进了球——你没有庆祝，只是笑了。进球回来了，不是因为你追它，是因为你放下了它。"
        : "你决定把球踢简单。但简单在天价面前叫平庸——你不丢球了，也不做任何事了。评论席说「他消失了」，你自己看回放的时候也找不到自己。";
      break;
    }

    // P-A35: fatal mistake — own it vs hide (Gerrard slip dimension).
    case "fatal_mistake:own_it": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? -1 : -3);
      if (success) mods.overallDelta = (mods.overallDelta ?? 0) + (3);
      good = success;
      outcome = success
        ? "你站起来了。赛后你走到媒体面前说：「这是我的错。我让球队失望了。」你没有找借口，没有怪草皮，没有怪天气。第二天训练你比任何人都早到。你的队友在更衣室拍了拍你的肩——他们知道一个敢于承担的人比一个从不犯错的人更可靠。"
        : "你站起来了，但那个滑倒在你脑子里反复回放。每一次训练你都在想那个球——如果你接住了，如果草皮没滑，如果你的鞋钉长一厘米。你的状态开始下滑——不是因为身体，是因为你的脑子被那个瞬间困住了。你想起Gerrard说的「最糟糕的三个月」。你正在经历你自己的。";
      break;
    }
    case "fatal_mistake:hide": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -2);
      good = success;
      outcome = success
        ? "你躲开了所有镜头，一句话也没说。三周后联赛来了新的头条，没有人再提那次滑倒。你安静地回到训练场，安静地踢回了首发——有时候沉默不是逃避，是不给火添柴。"
        : "你躲开了所有镜头。你没有接受采访，没有发声明，把自己关在家里看了那个滑倒一百遍。媒体说你在「逃避」。也许你确实在逃避——但你怎么面对一个你无法控制的瞬间？你回到训练场的时候，发现队友看你的眼神变了。不是责备——是同情。同情比责备更难承受。";
      break;
    }

    // P-A36: rock bottom — keep going vs walk away (Vardy dimension).
    case "rock_bottom:keep_going": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      outcome = success
        ? "你没有放弃。你继续在工厂做夹板，继续拿三十镑踢球，继续在空荡荡的球场里奔跑。但你的数据开始变了——你的速度更快了，你的射门更狠了，你的眼里有了一种从前没有的东西。那不是天赋，那是被生活磨出来的刀刃。两年后你被高级别联赛的球探发现了。你的电子脚镣摘掉了，但那个冰凉的感觉你永远记得。"
        : "你没有放弃，但日子没有立刻变好。你继续在低级别联赛踢着，继续在工厂做着夹板。但你知道你比昨天强了一点。也许有一天有人会看见你——也许不会。但你不再是为了被看见而踢球了，你是为了那个不放弃的自己。";
      break;
    }
    case "rock_bottom:walk_away":
      // P-DEGEN: 故事写「脱下球鞋、找份正经工作」却未 forceRetire——零回报且说谎。
      // 现为真正的退出（玩家「我认输了」按钮）：forceRetire 收尾本轮，及时止损
      // 保住已赚的传承 vs keep_going 的爬出赌注。这是用户举的「垃圾事件」原型。
      mods.forceRetire = true; mods.forceRetireReason = "voluntary"; mods.dignifiedExit = true;
      good = true;
      outcome = `你脱下了球鞋。你把它放在了更衣柜里，转身走出了球场。你在工厂里做了全职，拿到了比踢球更多的工资。你的脚踝不再有电子脚镣的冰凉，也没有了草地的温度。多年后你在电视上看一场${n.league}的比赛，看到一个从低级别联赛爬上来的前锋打破了进球纪录。你关掉了电视。那本来可以是你——但你选了不踢了，你的人生也继续了。`; break;

    // P-A37: beyond football — the Drogba moment. The rarest, most powerful event.
    case "beyond_football:speak": {
      const success = roll(0.6, "positive");
      // 对内战发声：成功则一句话促成停火、成国家象征（+1 perm + 球迷宠儿——发声赢下人心，
      //  与同伴 let_football_talk 的 +1 perm 对齐）；失败则战争未止、但聚光灯与政治压力
      //  分散了你踢球的注意力（-1 perm）。原两分支都空 mods → 预览空白、玩家盲选。
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      if (success) mods.addTags = [tag("fan_darling", 6)];
      good = success;
      outcome = success
        ? "你看着镜头说了一句话。你不知道该说什么——你只是说了心里的话：「放下武器。我们是一个国家。今天我们证明了当你们在一起时能做什么。」你不知道这句话能不能止住一场战争。但你后来在新闻里看到——停火了。你的名字不再只在体育版。你成了一个国家的象征。足球给了你声音，你用这个声音做了足球做不到的事。"
        : "你看着镜头说了一句话。战争没有因为你停下。但你的母国在那天晚上看到了一个他们认识的球员在为他们说话——不是政客，不是将军，是一个踢球的人。也许战争不会因为一句话结束，但绝望的人需要知道有人在为他们说话。你做了你能做的。有时候，那就是全部。";
      break;
    }

    // P-A38: joy fades — reignite vs enjoy (Ronaldinho dimension).
    case "joy_fades:reignite": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      good = success;
      outcome = success
        ? "你回去训练了。不是因为你必须——是因为你想起了你第一次踢球时的快乐。那种快乐不是来自赢，是来自踢。你比任何人都早到训练场，队友说你变了。你笑了——你没变，你只是想起了你是谁。你重新开始享受过程，而不是结果。"
        : "你试了。但那种饥饿感回不来了。你已经赢了一切，你知道巅峰是什么感觉——你不想再追了。你继续踢，但你踢得像一个已经满足的人。教练看出来了，球迷也看出来了。也许没关系——你已经给了他们足够的快乐。";
      break;
    }
    case "joy_fades:enjoy": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      if (!success) mods.overallDelta = (mods.overallDelta ?? 0) + (-2);
      good = success;
      outcome = success
        ? "你不再逼自己。你开始享受那些小事——一次漂亮的转身，一次和队友对上的眼神。数据没有立刻变好，但赛季末你发现自己踢得比前两年都轻松，身体也没那么疼了。原来松弛不是放弃，是另一种专业。"
        : "你选择了快乐。你继续笑，继续享受，继续在球场上做那些让全世界笑的事。你的体能下滑了，你的速度慢了，但你的笑容没有消失。多年后人们问起你的巅峰为什么那么短——有人说你不够努力，有人说你只是太快乐了。你不后悔。足球本来就是快乐。你给了他们快乐，你也快乐了。这还不够吗？";
      break;
    }

    // P-A39: contract year — go all out vs stay calm.
    case "contract_year:go_all_out": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (!success) mods.addTags = [tag("compromised_body", 2)];
      good = success;
      outcome = success
        ? "你踢出了生涯最佳赛季。每一场都像最后一场——因为你不知道还有没有下一场。你的数据爆了，媒体开始算你的身价，三家俱乐部同时联系了你的经纪人。赛季末你签了一份翻了三倍的合同。你笑了——有时候压力是最好的燃料。"
        : "你太想表现了。你每场都拼尽全力，但你的身体开始抗议——小腿拉伤、膝盖发炎、疲劳累积。你在赛季后半段伤了，坐在板凳上看别人踢你的合同年。经纪人说你太拼了。你说不拼还能怎么办？合同年不是给胆小的人准备的。";
      break;
    }
    case "contract_year:stay_calm": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你按自己的节奏踢。赛季结束时你的数据不是最好的——但很稳定。俱乐部看中的不是爆发，是持续性。你签了一份合理的新合同，没有翻三倍但也没有打折扣。经纪人说你太佛系了。你说合同年不是只有一年，职业生涯有十几年。"
        : "你太佛系了。赛季结束时你的数据平平——俱乐部觉得你不值得加薪，其他俱乐部也没有来敲门。你签了一份降薪续约合同。你想起经纪人说的「这是你最重要的赛季」。你点了点头——也许他是对的。";
      break;
    }

    // P-A40: the final-match provocation — headbutt vs walk away (Zidane dimension).
    case "final_provocation:headbutt": {
      // P-DEGEN: 曾是纯代价（只 suspended，无收益）。补收益：稳涨 +1 perm +
      // fan_darling（你为家人出头，国民在广场喊你的名字）；代价是红牌罚下+追加停赛、少踢大半季。
      mods.statsMultiplier = 0.6; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.addTags = [tag("fan_darling", 6)];
      good = false;
      outcome = "你一头撞向他的胸口。红牌。你站在球员通道口看着场内——你的最后一场比赛，就这样结束了。你走过那座世界杯奖杯的时候没有看它。赛后媒体问你怎么面对那些把你当榜样的孩子，你说：「我宁愿死也不会向他道歉。」但你也说：「如果我留上场帮球队赢了，我这辈子都过不去。」你的国家在你回家时在广场上喊你的名字——61%的人原谅了你，你成了球迷宠儿，也吃了一张红牌。你不确定你原谅了自己。";
      break;
    }
    case "final_provocation:walk_away":
      // P-DEGEN: 「忍住」曾是零回报陷阱。安全路：稳涨 +1 perm + fan_darling（克制赢得了尊重），
      // 代价是顺位下滑（你「软」了，没那种斗气）——与 headbutt 的 fan_darling@6 区别在@4。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      mods.addTags = [tag("fan_darling", 4)];
      good = true;
      outcome = "你忍住了。你转身跑开了。你没有看那个球员。你的最后一场比赛没有红牌——你稳稳地涨了一截，也赢得了「体面」的尊重。但你在终场后坐在更衣室里很久很久，想起他说的话。你忍住了，顺位也悄悄滑了一档——你用克制给生涯画了句号，但你不确定忍耐是不是正确的。至少你走下了球场，而不是被抬下去的。"; break;

    // P-A41: wasted talent — wake up vs shrug (Balotelli dimension).
    case "wasted_talent:wake_up": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      outcome = success
        ? "你第二天比任何人都早到了训练场。队友看你的眼神变了——不是惊讶，是松了口气。你开始认真对待你的天赋了。三个月后你的数据翻了一倍，媒体说「他终于醒了」。你不知道这能持续多久——但至少今天，你选择了成为那个你本该成为的人。"
        : "你试着认真了。但认真不是一天的事——你迟到了两次，又被罚了一场。不过你训练确实更拼了。教练看在眼里，什么也没说。也许你不会一夜之间变成另一个人，但至少你开始在乎了。在乎，是改变的第一步。";
      break;
    }
    case "wasted_talent:shrug": {
      const success = roll(0.25, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 4 : -3);
      mods.roleShift = -1;
      if (!success) mods.addTags = [tag("compromised_body", 3)];
      good = success;
      outcome = success
        ? "你耸了耸肩。你就是这样的人——也许不完美，但你进球了。你进了两个球，媒体又开始写你的天才。也许天赋真的不需要解释——至少今天不需要。但你心里知道，这句话你说过太多次了。"
        : "你耸了耸肩。但这次没有人笑了。你的第四张红牌来了——停赛五场。你在板凳上看着比你差但比你努力的球员踢你的位置。多年后人们会说你是「一个天才的浪费」。你不后悔吗？你不确定。你只是从来没认真想过这个问题。";
      break;
    }

    // P-A42: legendary shirt — embrace vs change number (Depay dimension).
    case "legendary_shirt:embrace": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      outcome = success
        ? "你穿上了7号。前几场你踢得像个背了石头的人——太想证明自己了。但第五场比赛你进了一个球，你看了一眼背后的号码，想起穿过它的那些人。你不再是活在他们的影子里——你开始写自己的故事。媒体说：「7号找到了它的主人。」"
        : "你穿上了7号。但它的重量压垮了你。每一场失误都被放大——「7号不配」「比前任差远了」。你开始害怕上场，害怕碰球，害怕那块布。整个赛季你只踢了二十分钟。不是伤了，不是停了——只是不需要了。你成了那个被传奇号码吞掉的人。";
      break;
    }
    case "legendary_shirt:change_number": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你换了一个没人穿过的号码。教练问你为什么，你说：「我不想活在别人的影子里。」你没有成为7号的传奇——但你成为了你自己的号码的传奇。多年后有人穿上你的号码，他们问他：你知道这个号码以前谁穿过吗？他说是你的名字。"
        : "你换了号码，躲开了那件球衣的重量。但你也躲开了它的光——球迷记住的是敢穿它的人，不是换掉它的人。多年后有人问起你的号码，没有人想得起来是几号。";
      break;
    }

    // P-A43: coach feud — escalate vs back down (Pogba/Mourinho dimension).
    case "coach_feud:escalate": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.roleShift = -2; mods.overallDelta = (mods.overallDelta ?? 0) + (-2);
      good = success;
      outcome = success
        ? "你上了社交媒体。球迷站在了你这边——他们讨厌那个保守的教练。主席不得不介入，教练被解雇了。新教练来了，你重新成为核心。你赢了这场战争——但你也知道，赢了教练不等于赢了尊重。更衣室里有些人不再看你的眼睛。"
        : "你上了社交媒体。但球迷分裂了——一半人支持你，一半人觉得你在「造反」。主席没有解雇教练，而是把你放上板凳。你坐在那里看着教练在场边指挥，想起你们拍桌子的那天。也许该忍的。但忍让从来不是你的风格。";
      break;
    }
    case "coach_feud:back_down": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你去了教练办公室。「我错了。」你说。他没有笑，但他点了点头。下周你重新首发了——不是因为你赢了，是因为你选择了球队比自己重要。赛季末你踢出了生涯最佳。教练在离任前对你说：「你成熟了。」这是你从他那里得到的最好的评价。"
        : "你去了教练办公室服了软。他接受了，但你看得出他不会忘记。你继续首发了，但战术没有变——你还是不能前插。你在场上踢得像一个被关在笼子里的人。你忍住了——但每次看那个教练，你心里都有一把火。也许你该走的。";
      break;
    }

    // P-A44: frozen out — force move vs dig in (Özil dimension).
    case "frozen_out:force_move": {
      const success = roll(0.5, "positive");
      mods.roleOverride = success ? "starter" : "substitute";
      if (success) mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      good = success;
      outcome = success
        ? "你要求了转会。俱乐部同意了——他们也不想养一个踢不了球的高薪球员。你去了新俱乐部，降了薪但回到了球场。第一次上场的时候你深吸了一口气——草地的味道还是一样的，但你觉得很久没闻到了。你不是在最高的地方了，但你在踢球。这就够了。"
        : "你要求了转会，但没有俱乐部愿意出你的工资。你回到了预备队继续跑步。你的经纪人在电话里说「再等等」。你看着窗外一线队的灯光，想起你说过的「我本可以免费来这里踢球」。他们不在乎你说过什么。他们只在乎你的工资单。";
      break;
    }
    case "frozen_out:dig_in": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.overallDelta = (mods.overallDelta ?? 0) + (-1);
      good = success;
      outcome = success
        ? "你留下了。你拿着顶薪在预备队训练。媒体骂你「吸血鬼」，球迷骂你「寄生者」。但你的合同是法律——他们不能逼你走。合同到期那天你收拾了更衣柜，最后一次走出训练基地。你没有回头。你拿走了你的钱，也拿走了两年被浪费的青春。你说你不后悔——但你心里知道，那两年你再也回不来了。"
        : "你留下了。你在预备队待了两年，一个人跑步，一个人训练，一个人吃饭。你的身体还在，但你的信心没了。合同到期后你去了低级别联赛——但你在那里也踢不动了。两年没踢过正式比赛的腿不是两天能找回来的。你想起教练说的「战术选择」——那不是战术，那是流放。";
      break;
    }

    // P-A45: mentor coach — trust vs insist (Ancelotti/Pirlo dimension).
    case "mentor_coach:trust_him": {
      const success = roll(0.65, "positive");
      mods.roleOverride = success ? "starter" : "high_rotation";
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你试了。前几场你踢得像个迷路的人——新位置的一切都不对。但第四场比赛你突然明白了：这个位置让所有人都绕着你转。你不需要跑得最快，你只需要看得最清楚。赛季末你入选了最佳阵容。教练在颁奖礼上说：「我只是把箭头画对了方向。」你笑了——他不知道那个箭头也改变了一切。"
        : "你试了。新位置不太对——你还没有完全适应，但教练没有放弃你。他说「再给我时间」。你给了他时间，他也给了你时间。你没有爆发，但你回到了首发——这已经比之前好了。有些改变需要一整个赛季。你愿意等。";
      break;
    }
    case "mentor_coach:insist": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你坚持了自己的位置。教练没有强求——他让你踢老位置。你在老位置上踢得不错，不是惊艳，是不错。教练在赛季末说：「如果你试了新位置，也许会更好。但这是你的选择。」你点了点头。也许他是对的——但你不想活在也许里。"
        : "你坚持了自己的位置。但教练的脸沉了。他又给了你几场，然后把你放回了板凳。你坐在那里看着新援踢你想踢的位置——踢得比你好。你想起他画的那个箭头。也许你应该信他。也许——但也许这个词现在太晚了。";
      break;
    }

    // P-A46: breaking point — retire from international vs come back (Messi 2016).
    case "breaking_point:retire_intl": {
      // P-DEGEN: 曾是纯代价（natSkip + intl_retired + imm −1，无收益）。补收益：
      // 稳涨 +1 perm + 位置上升 +1（俱乐部报你、给你更多出场）；代价是退出国家队。
      mods.nationalTournamentParticipation = "skip";
      // 打上「已退出国家队会籍」的持续状态——后续可触发他国归化邀约。
      mods.addTags = [tag("intl_retired", 8)];
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = 1;
      good = false;
      outcome = "你发出了那条消息。「我决定退出国家队。」社交媒体炸了。有人说理解，有人说你「逃避」。你的母亲打了电话来，哭着说「别走」。你挂了电话——俱乐部那边报了你，顺位往上挪了一档，你也稳稳地涨了一截。但你看着窗外，心里清楚：那件国旗颜色的球衣，这辈子不会再穿了。也许你确实累了——但你知道你心里还有一团火，只是你太疼了感受不到它。";
      break;
    }
    case "breaking_point:come_back": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你删掉了那行字。你把手机放在一边，闭上眼睛。你想起了你第一次穿上国家队球衣走进球场的那天——全场在唱你的名字。你还想再听一次。不是因为你能赢，是因为你还没试完。你站起来走回了训练场。你的队友看见你回来了，什么也没说——但他们眼里的光告诉你：他们需要你。也许这次会不同。也许。"
        : "你回来了。你以为回来能救你，但压垮你的东西一样也没变——更多的比赛，更多的期待，更多凌晨三点睁着眼的夜。这一次你没有崩溃，你只是慢慢地不在场上了。";
      break;
    }

    // P-A47: war childhood — channel the memory (Modrić dimension).
    case "war_childhood:channel_it": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      mods.leagueTrophyProbabilityMultiplier = success ? 1.3 : 1.1;
      good = success;
      outcome = success
        ? "你走出了球员通道。你听到了国歌——你想起了那个停车场，那个破球，那些炸弹。你从一个什么都失去了的孩子走到了这里。你踢出了你生命中最好的比赛——不是因为天赋，是因为你心里有一个别人没有的东西：你从废墟里走过来的腿，不会在草地上发抖。赛后你看着天，想起了祖父。他看不到这一刻，但你知道他在那里。"
        : "你走出了球员通道。记忆让你眼眶发红，但你说不清是疼还是力量。你没有踢出最好的比赛，但你站在了那里——一个从战火里走出来的孩子，站在了世界最高的球场上。这就够了。你的国家在看你。不管结果如何，你已经证明了废墟里也能长出草来。";
      break;
    }

    // P-A48: transition prep — study coaching vs stay present (Guardiola dimension).
    case "transition_prep:study_coaching": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你开始在训练后留下来看战术板。你买了教练教材，你和其他教练讨论阵型，你甚至在笔记本上画了你自己的战术体系。你的球员生涯还在继续，但你的教练生涯已经开始了。多年后你坐在教练席上，想起这个下午——你在球员时就开始的转型，让你比那些退役后才想的人早了五年。"
        : "你开始学了，但时间和精力不够——白天训练，晚上读书，你的身体在抗议。你没有完成教练课程，但你在笔记本上画满了战术图。也许你不会成为教练——但你知道足球不会离开你。你的笔记本会在某一天被打开的。";
      break;
    }
    case "transition_prep:stay_present": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      good = success;
      outcome = success
        ? "你不想以后的事。你还能踢——也许不是最好的你，但还能踢。你用每一场比赛证明你还不想走。赛季末你踢出了不错的数据，有人问你退役后做什么，你说：「踢球。」他们笑了。你没笑——你是认真的。至少今天还是。"
        : "你不想以后的事。但你的身体在替你想——下一场比赛你又伤了。你坐在治疗台上想起教练那天问你「想当教练吗」。也许你该说想的。也许你已经错过了最好的准备时机。但后悔不属于现在——现在你只想回到球场。";
      break;
    }

    // P-A49: last minute hero — the Ramos 93rd minute moment.
    case "last_minute_hero:go_for_it": {
      const success = roll(0.45, "positive");
      if (success) { mods.leagueTrophyProbabilityMultiplier = 2; }
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      good = success;
      outcome = success
        ? "你冲向了那个球。时间像慢了下来——你看见球旋转着向你飞来，你看见门将从门线上冲出来，你看见全场起立。你的额头碰到了球。球飞向死角。网窝在动。全场炸了。你跪在角旗区，队友们从四面八方冲来把你压在身下。93分钟。0-1变成了1-1。你是那个在最晚的时刻站出来的人。这个头球会永远被播放。"
        : "你冲向了那个球。你的额头碰到了——但球偏了。擦着门柱飞了出去。你跪在草地上，听着终场哨响。对方球迷在庆祝，你的队友瘫坐在地上。你看着那个飞走的球，想起人们说的「伟大的人在最晚的时刻站出来」。你站出来了。但你没有成为伟大的人——你只是差了一点。那一点你会想一辈子。";
      break;
    }

    // P-A50: super agent — sign vs decline (Raiola dimension).
    case "super_agent:sign_with_him": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      if (!success) { mods.roleShift = -1; }
      good = success;
      outcome = success
        ? "你签了他。第二天你的生活变了——他帮你谈了一份翻倍的合同，给你找了一栋新房子，甚至帮你选了车。你的转会身价涨了三倍。他像他说的那样——掌控了你的每一步。但你也发现，你的每个决定都有他的影子。你去了他想让你去的俱乐部，而不是你想去的。你说不清他是在帮你还是在用你。但你的身价不会骗人。"
        : "你签了他。但他和俱乐部谈崩了——他太强势，主席太骄傲。你被夹在中间，两头不讨好。他帮你要求的加薪没拿到，你的出场时间反而少了。他在电话里说「相信我」——但你在板凳上坐着的时候，只有你自己。也许他不适合你。也许超级经纪人不适合所有人。";
      break;
    }
    case "super_agent:decline": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你谢绝了他。他笑了：「你是个聪明人——但聪明人有时候会后悔。」你不知道他说的是不是对的。但你回到训练场的时候心里是安静的。你的生涯也许不会有他承诺的那么辉煌——但每一步都是你自己的。没有人的指纹在你的决定上。也许这就是自由。也许这就是贫穷。也许两者是一样的。"
        : "你拒绝了他。他转头签下了你的队友——两年后你的队友在豪门，你还在原地，用着那个只会点头的老经纪人。你以为你守住了自己，你只是守住了原来的位置。";
      break;
    }

    // P-A51: pre-match calm — stay calm vs get focused (Pirlo dimension).
    case "pre_match_calm:stay_calm": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      mods.nationalTournamentParticipation = "force";
      good = success;
      outcome = success
        ? "你打了两个小时游戏。队友走过来看了你一眼，摇了摇头走了。你笑了。终场哨响的时候你站在世界之巅——你助攻了第一个球，你罚进了第一个点球。赛后记者问你决赛前在做什么，你说：「玩。」他们以为你在开玩笑。你不是。你只是知道——最好的球员不是最紧张的，是最自由的。"
        : "你打了两个小时游戏。但上场后你的脑子没有切换过来——你太放松了，松到没有紧迫感。你的传球慢了一拍，你的跑位少了一步。赛后你看着0-1的比分，想起那两小时的游戏。也许平静是好的——但今天平静没有帮到你。也许你该紧张的。也许每个人都不一样。";
      break;
    }
    case "pre_match_calm:get_focused":
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.nationalTournamentParticipation = "force";
      good = true;
      outcome = "你关掉了游戏。你开始看对方防线的录像，你开始在自己的脑子里跑战术。队友说你太紧了——但你知道你只是认真。终场哨响你们赢了。你没有进最漂亮的球，但你做了最正确的事。赛后你想起那台被关掉的游戏机——也许你错了一种放松，但你找到了另一种准备。每个人都有自己的方式。你的方式是认真。"; break;

    // P-A52: second peak — reinvent vs accept decline (Van der Sar dimension).
    case "second_peak:reinvent": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你找到了第二巅峰。你不是最快的了，但你是最聪明的。你站在场上的时候比赛在你脑子里慢了下来——你看到了二十岁的你看不到的东西。赛季末你打破了不失球纪录，媒体说你是「永不算岁的门将」。你笑了——你确实不算岁了，你算的是经验。你的第二巅峰比第一个更安静，但更珍贵。"
        : "你试了。你没有达到第二巅峰，但你也没有继续下滑——你找到了一个稳定的水准。不是最耀眼的，但够用。教练说「有你在我就放心」。你笑了——不是最好的评价，但也不是最差的。有些人的第二巅峰是金球，你的第二巅峰是信任。也够了。";
      break;
    }
    case "second_peak:accept_decline":
      // P-DEGEN: 「接受衰退」曾是零回报陷阱。安全路：deferred +1（你踢得轻松、身体多撑几年）+
      // cautious_play（不再透支）；代价是顺位下滑（你不再追巅峰，主力位置让出去）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      mods.addTags = [tag("cautious_play", 2)];
      good = true;
      outcome = "你接受了。不再追巅峰了——你开始享受每一天，身体也多撑了几年。你上场不再是为了证明什么，是为了踢球——只是主力位置你让出去了，顺位滑了一档。你的表现没有更好，但你踢球的样子变了——更轻松，更快乐。也许这不是第二巅峰，但这是另一种好。你站在球场上听着球迷唱你的名字，想起二十年前第一次听到的样子。那首歌没有变。你变了。但还在唱。"; break;

    // P-A53: peak destroyed — fight vs retire (Van Basten dimension).
    case "peak_destroyed:fight": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (-10);
      mods.statsMultiplier = 0.1;
      mods.addTags = [tag("compromised_body", 8)];
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (5); }
      good = success;
      outcome = success
        ? "你用了两年。两年里你每天在康复室里比任何训练都痛苦。你想过放弃一千次——但你想起了倒下那一刻全场安静的瞬间。两年后你回到了球场。你不再是90+的那个你了——但你站在了那里。你站在了那里。你用两年换回了一切的一半。那一半比很多人的一生都多。"
        : `你用了两年。你拼命了。但你的踝关节不会让你回来了。你坐在更衣室里，看着队友上场，你知道你再也穿不了那双鞋了。教练来看你的时候哭了——一个从不哭的人哭了。你拍着他的肩说「没关系」。但你知道不是没关系。你${n.ageCn}岁，你本该还有很多年。那些年被一个从背后的铲球拿走了。`;
      break;
    }
    case "peak_destroyed:retire":
      // P-DEGEN: 故事写「你把球鞋放在了草草上、你二十八岁退役了」却未 forceRetire。
      // 现为真正的巅峰体面退出：forceRetire 止损保住巅峰传承 vs fight 的赌注。
      mods.forceRetire = true; mods.forceRetireReason = "injury"; mods.dignifiedExit = true;
      good = true;
      outcome = `你站在${n.club}的主场中央，全场起立鼓掌。你的教练在旁边擦眼泪——一个从不哭的人。\n你对着话筒说：「谢谢你们。我踢球的时候很快乐。但现在我该走了。」你把球鞋放在了草坪上，转身走向球员通道。你没有回头。你${n.ageCn}岁退役了——但你是在巅峰走的。你的最后一场比赛是你的最好的一场。不是每个人都能这样说。`; break;

    // P-A54: faith awakening — live by faith vs forget (Kaká dimension).
    case "faith_awakening:live_by_faith": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你带着感恩踢了每一场球。你进球后指向天空——不是为了表演，是为了记住你差点失去的那一切。你捐了收入的一部分给教会，你做了公益大使。媒体说你是「好人」，你说你只是「记得」。你的队友说你在场上笑得比别人多——你说是的，因为每一场都是赚的。"
        : "你试着带着感恩踢球。但有时候你会忘记——当奖金到账的时候，当媒体吹你的时候，当对手激怒你的时候。你没有完美地活出你的信仰，但你也没有放弃它。你只是一个人——一个会忘记也会记起来的普通人。你的鞋上写着你的信仰，有时候你会低头看一眼。";
      break;
    }
    case "faith_awakening:forget":
      // P-DEGEN: 「忘了感恩」曾是零回报陷阱。押注型：稳涨 +1 perm（纯野心驱动、专注赚钱踢球），
      // 代价是顺位下滑（你逐利、不被当团队的人）——与 live_by_faith（perm+2/−1 的感恩）互为镜像。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      good = false;
      outcome = "你把那次事故放在了脑后。你往前看了——往前看意味着不再回头看那个差点失去一切的下午。你踢得很好，你赚了很多钱，你忘了感恩——你稳稳地涨了一截，只是顺位滑了一档，没人再把你当那个心怀感恩的团队球员。多年后你坐在空荡的更衣室里，想起十八岁的那个下午——你站起来的那一刻，你说「以后每场都是赚的」。你忘了那句话。也许你还记得。也许你只是不想记起来。"; break;

    // P-A55: brand empire — build brand vs stay football (Beckham dimension).
    case "brand_empire:build_brand": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (!success) mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你签了。你去了一个把你当明星而不是球员的地方，你的名字出现在每本杂志上。你的球衣卖疯了，你的照片出现在最贵的那块广告牌上。你的教练说你「足球只是生活的一小部分了」——你说为什么不呢？你退役后买了一支球队，成了老板。你的足球生涯结束了，但你的足球帝国才刚开始。"
        : "你签了。但商业活动开始吞噬你的训练时间。你的代言排满了周末，你的上镜时间比上场时间多。你的教练在新闻发布会上说「他需要做选择」。你的队友看你的眼神变了——你不再是他们中的一员了，你是一个品牌。你赚了很多钱，但你失去了一些钱买不到的东西。";
      break;
    }
    case "brand_empire:stay_football": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你把商业合同推了回去。「我只是一名球员。」你说。经纪人摇了摇头说你会后悔的。也许他是对的——也许你错过了几亿美元。但你在训练场上跑圈的时候，草地还是那个味道，球还是那个触感。你的队友还是你的队友。你退役后没有成为老板，但你的队友来看你退役赛的时候，每一个都来了。有些东西钱买不到。有些东西只有在球场上才能找到。"
        : "你推掉了所有商业局，只留下足球。但足球没有因此更爱你——你的膝盖照样老，你的位置照样被抢。退役那天你才发现，那些做生意的队友有第二人生，而你只有回忆。";
      break;
    }

    // P-A56: cardiac arrest — comeback vs retire (Eriksen dimension).
    case "cardiac_arrest:comeback": {
      const success = roll(0.4, "positive");
      mods.statsMultiplier = 0.1; mods.overallDelta = (mods.overallDelta ?? 0) + (-5);
      mods.addTags = [tag("compromised_body", 6)];
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (3); }
      good = success;
      outcome = success
        ? "你装上了除颤器。你的俱乐部解约了——但他们不能阻止你踢球。你在新俱乐部复出了。上场两分钟你进了球——你跑到角旗区没有庆祝，只是跪在草地上，摸着胸口那个救了你命的小装置。全场起立。你的队友冲过来抱住你——上次他们这样抱你是在球场上做心肺复苏。你回来了。你活着回来了。"
        : "你装上了除颤器回来了。但你的身体不再是从前了——你每次冲刺都会想起那次倒下，每次心跳加速你都会害怕。你没有进复出的第一个球，但你站在了球场上。你的队友看着你笑了——你笑了。你还活着。你还站着。这就够了。也许还不够回到从前，但比从前多了一样东西：你知道活着是什么感觉。";
      break;
    }
    case "cardiac_arrest:retire":
      // P-DEGEN: 故事写「你不能踢了。永远不能了。你把球鞋收进了柜子」却未 forceRetire。
      // 现为真正的退役退出：forceRetire（心脏原因）vs comeback 的赌注。
      mods.forceRetire = true; mods.forceRetireReason = "injury"; mods.dignifiedExit = true;
      good = true;
      outcome = "你决定退役了。你坐在医院床上看着窗外的球场，想起你第一次走进球场的样子。你的心脏停了78分钟——78分钟。一个观众席上的心脏医生冲下来救了你。你的队友坐在床边什么也没说，只是握着你的手。\n你本来以为自己能回来——你一直「积极相信有一天能重新踢球」。但请来的那位专家说了「毁灭性的消息」：你不能踢了。永远不能了。\n你把球鞋收进了柜子。你回到你倒下的那座球场时全场起立鼓掌——8个月前你的心脏在那里停了78分钟。此刻它在跳。它不会再为足球跳了。但它还在跳。「感谢上帝我还活着。」你说得对。足球很重要。但活着比足球重要。"; break;

    // P-A57: representation — carry it vs play for self (Salah dimension).
    case "representation:carry_it": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      mods.leagueTrophyProbabilityMultiplier = success ? 1.2 : 1.1;
      good = success;
      outcome = success
        ? "你扛住了。你进了一个球，你跑到角旗区，你闭上了眼睛——你听到了四亿人在同一秒钟欢呼。你的母国在你进球的那一秒停了下来。你从一个三小时通勤去训练的村庄走到了这里，你知道你走的不只是你自己的路。赛后你说：「从一个村庄到这个级别，对我来说难以置信。」你信吗？你不确定。但你知道你在替那些从没走到这里的人走。"
        : "你扛住了——但重量压着你。你感觉到每个进球都不够，因为你不只是为自己踢球了。有时候你想回到那个只想踢球的少年。但你不能了——你已经是一面旗帜了，旗帜不能选择不飘。你的表现也许不是最好的，但你的母国在每一场比赛后给你发来消息。他们不要求你赢。他们只想看到你站在那里。你站在了那里。";
      break;
    }
    case "representation:play_for_self": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你摇了摇头。「我只是一名球员。」你不想做旗帜——你只想踢球。你为自己的进球而跑，为自己的快乐而踢，为自己的生涯而战。你的母国依然爱你，但你不愿为他们的期望而活。也许这样更自由。也许这样更孤独。也许两者是一样的。"
        : "你决定只为自己踢。你踢得不差，但看台上举着你名字的人慢慢少了——他们要的不是一个好球员，是一个属于他们的人。你赢了球，没赢到他们。";
      break;
    }

    // P-A58: prodigy burden — embrace vs stay grounded (Rooney dimension).
    case "prodigy_burden:embrace_it": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      if (!success) mods.addTags = [tag("compromised_body", 2)];
      good = success;
      outcome = success
        ? `你享受了这一切。你上了每一个头条，你出现在每一场派对，你的名字比你的球技更有名。但你的球技没有落下——至少暂时没有。你的教练说「他比同龄人成熟」——你笑了，你才${n.ageCn}岁，你知道你不成熟，你只是学得快。`
        : `你享受了这一切。但夜生活开始吞噬你——你${n.ageCn}岁就在凌晨四点的夜店被人拍到，你的教练在新闻发布会上被问到了这件事。你的训练状态下滑了，你的体重上升了。你想起你第一次上场时全场喊你名字的感觉——那时候你只想踢球。现在你想的是今晚去哪里。`;
      break;
    }
    case "prodigy_burden:stay_grounded": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你远离了聚光灯。你拒绝了所有采访，你的社交媒体只有训练照片。你的队友说你「像四十岁的人」。但你的训练比任何人都认真——因为你知道天赋需要保护。你的教练说「他不会被毁掉」。你没有享受这个年纪的所有快乐，但你会到了三十岁还在踢球。有些快乐可以等。天赋不能等。"
        : `你试着远离了聚光灯。但你才${n.ageCn}岁，你做不到完全不看手机，完全不在意那些头条。你训练很认真，但你偶尔会想——如果你享受一下会怎样？你不知道答案。也许你永远不会知道。但你选择了安全路，安全路不会让你飞最高，但也不会让你摔最惨。`;
      break;
    }

    // P-A59: the fire — channel anger vs let go (Zlatan dimension).
    case "the_fire:channel_anger": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      outcome = success
        ? "你用愤怒点燃了自己。每一场比赛你都带着那些声音上场——「你不行」「你不够好」「你穿错了衣服」。你把它们变成了燃料。你进了球，你跑到角旗区没有庆祝——你只是看着那些说你不行的人的方向。赛后你说：「我需要愤怒才能踢好。」也许这是真的。也许愤怒不是敌人——愤怒是引擎。"
        : "你试着用愤怒驱动自己。但愤怒有时候会烧到你自己——你吃了一张红牌，你骂了教练，你在更衣室里摔了东西。你的天赋在场上依然闪耀，但你在场下开始失去人。也许你需要愤怒——但也许你需要学会控制它。愤怒是火，火能照亮也能烧毁。";
      break;
    }
    case "the_fire:let_go": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你放下了愤怒。你不再带着那些声音上场——你只带着你自己。你的表现没有从前那么凶猛了，但你的笑容多了。你的队友说你变了，你说你只是不再需要证明什么了。也许你失去了那把火——也许你只是找到了另一种光。"
        : "你试着放下愤怒。但你放下愤怒之后发现——你没有别的东西了。你的天赋一直在，但驱动天赋的那把火灭了。你踢得像一个没有燃料的引擎。你想起你说过的「我需要愤怒才能踢好」。也许那不是气话。也许那是实话。你看着镜子里的自己——你不再愤怒了。但你也踢不好了。";
      break;
    }

    // P-A60: quiet excellence — master precision vs expand game (Kroos dimension).
    case "quiet_excellence:master_precision": {
      const success = roll(0.65, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你选择了精准。你不再追求跑得最快或跳得最高——你追求每一脚球都去到它该去的地方。赛季结束你成了全联赛传球成功率最高的球员。媒体说你「不抢眼但不可或缺」，你的队友说跟你踢球「像把球放进了保险箱」。你没有最耀眼的数据，但你的教练在赛季末说了一句最好的话：「有他在，我就放心。」"
        : "你选择了精准。但你发现精准也有天花板——当你面对比你快比你壮的对手时，你的精确有时候不够用。你继续精进，但你开始意识到也许你需要一点别的东西。不是速度，不是力量——也许是一点点凶狠。你十七年来一直踢得很安静，也许到了该吵一点的时候了。";
      break;
    }
    case "quiet_excellence:expand_game": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (!success) mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你开始扩大你的比赛。你不再只站在那条线上——你开始跑动、抢断、射门。你的精准还在，但你的比赛变宽了。你的教练说你「从保险箱变成了瑞士军刀」。也许你不再是那个最安静的人了——但你成了那个最全面的人。"
        : "你开始扩大你的比赛。但你离开了那条线之后，你的精准开始下降了。你跑动太多，你的传球不再精确了——你在试图成为你不是的人。你的教练把你放回了那条线上，什么也没说。你明白了——不是每个人都需要成为全部。有些人的伟大，就是站在一个地方，做到极致。";
      break;
    }

    // P-A61: giving back — give everything vs invest in self (Mané dimension).
    case "giving_back:give_everything": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -2);
      good = success;
      outcome = success
        ? "你把一大笔钱汇回了你的村庄。你建了一所学校——用你的名字命名，但你没告诉任何人。你建了一所医院，你给每家每月寄钱，你给学校买了电脑和4G网。你的队友在停车场开着新跑车经过你，你坐着公交车回酒店。他们不理解你。你不需要他们理解。你母亲在电话里哭着说「全村人都说你好样的」。你笑了——你只是踢球的。但也许踢球不只是为了自己。"
        : "你把能给的都给了：钱、时间、名字。但那个基金会被人拿走了一半，剩下的一半没花到该花的地方。媒体查出来的时候，标题上写的是你的名字。你做对了事，选错了人。";
      break;
    }
    case "giving_back:invest_in_self": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你选择了先保障自己。你买了房产，做了投资，给自己留了后路。你还会回馈——只是不是现在。你的村庄还在等，但你告诉自己「等我赚够了再说」。也许有一天你会回去建那所学校。也许那一天比你想象的要远。"
        : "你选择了先保障自己。但你发现「以后」永远不来——总有下一个投资，下一栋房子，下一辆车。你的村庄还在等。你在Instagram上看到了你家乡的那棵树——孩子们还在树下上课。你关掉手机。也许你该做了。也许你只是说说。";
      break;
    }

    // P-A62: no longer fun — walk away vs find fire (Nakata dimension).
    case "no_longer_fun:walk_away": {
      // P-DEGEN: 故事写「你退役了。你二十九岁…我将再也不会作为一名职业球员站在球场上」
      // 却未 forceRetire。现为真正的主动退役：forceRetire(voluntary) vs find_fire 的赌注。
      mods.forceRetire = true; mods.forceRetireReason = "voluntary"; mods.dignifiedExit = true;
      good = true;
      outcome = `你退役了。你${n.ageCn}岁，你的身体还行，你的合同还在。但你不再享受了。\n你在个人网站上写了一行字：「我将再也不会作为一名职业球员站在球场上。但我永远不会放弃足球。」\n你去了世界各地旅行，你学了你从没学过的东西。你发现足球场外的世界比你想象的大得多。你不是在逃避——你是在选择。有些人踢到四十岁，你在${n.ageCn}岁就说了「够了」。不是因为你不行了——是因为你想去发现还有什么。`;
      break;
    }
    case "no_longer_fun:find_fire": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你给了自己一次机会。你回到了训练场——不是为了合同，不是为了奖杯，是为了看看你还爱不爱它。第三周的一个早晨，你在训练中做了一个动作——你不假思索地做出来的，你的身体在飞。你笑了。火还在。也许它只是藏了一阵子。也许你需要的不休息——你需要重新记起为什么开始。"
        : "你给了自己一次机会。但火没有回来。你继续踢着，但你知道你在走形式。你的数据还可以，你的合同还在，但你在场上感觉不到任何东西。你想起那个窗外的飞机。也许你该走的。也许你只是害怕。害怕离开球场的你是什么。你还没找到答案——但你还在踢。还在找。";
      break;
    }

    // P-A63: discarded — prove them wrong vs stay and fight (De Bruyne dimension).
    case "discarded:prove_them_wrong": {
      const success = roll(0.5, "positive");
      // 真转会:desc/选项都说「去小俱乐部」, resolve 必须真的转会到一家你能踢
      //   主力的降档俱乐部。此前只设 roleOverride=starter 却不转会, 球员原地
      //   留在弃用他的豪门、被强行记成「主力」——OVR 76 在 rep-8 切尔西该是
      //   替补却成了主力, 与「被弃用」自相矛盾 (用户反馈: 26→27 赛季明明在
      //   走下坡路却当上主力)。复用 forcedExitDestinations (降档到 starter-fit、
      //   同联赛优先, 与 underperform/stuck_release 同构), roleOverride 守住
      //   「保证踢主力」的叙事承诺。pure/确定: 无 rng, refresh 与 rebuild 一致。
      const dest = forcedExitDestinations(ctx)[0];
      if (dest) mods.newClubId = dest.id;
      mods.roleOverride = "starter";
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      const destName = dest?.name ?? "那家小俱乐部";
      outcome = success
        ? `你去了${destName}。没有人认识你——但每个人都看到了你。你在新俱乐部的第一个赛季就破了助攻纪录。你的传球、你的视野、你的节奏——它们一直在那里，只是没人给过你机会展示。赛季末你的老俱乐部教练被问起你，他说「我们放走了一个好球员」。你笑了——不是好球员，是那个被你说「不够好」的人。你证明了他错了。但你知道你证明的不是给他看的——是给自己看的。`
        : `你去了${destName}。你踢上了主力，但你的数据没有立刻爆发——你太想证明他们错了，你在场上踢得急躁。半年后你才安静下来，开始做自己。赛季末你踢出了不错的数据——不是最好的，但足以让那些放走你的人后悔。你的时间会来的。你只是需要有人给你上场——哪怕是小俱乐部。`;
      break;
    }
    case "discarded:stay_and_fight": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你留下了。你在训练中比任何人都拼。你在预备队比赛中跑了一万五千米。三个月后教练终于看了你一眼——不是因为你在训练中多好，是因为他不得不看。你回到了首发。你用一场比赛证明了他等了三个月才看你是一个错误。"
        : "你留下了。但教练不看你不看你。你坐在板凳上整个赛季，你的信心一点一点消失。你想起那家想要你的小俱乐部——也许你该去的。也许在那边你还能踢。在这边你只是在变老。";
      break;
    }

    // P-A64: transfer regret — give it time vs admit mistake (Alexis dimension).
    case "transfer_regret:give_it_time": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你给了它时间。前五场你踢得很差——你太想证明自己了。但第六场你开始放松了，你开始找到感觉了。赛季末你踢出了不错的数据——不是你在旧俱乐部的水平，但比你想撕合同那天好多了。也许时间是对的解药。也许你只是需要停止想着回去。"
        : "你给了它时间。但时间没有帮你。一个月过去了，两个月，三个月。你的数据还是不行，你的信心还在下滑。你坐在更衣室里看着旧俱乐部的比赛——他们在赢，他们很快乐，没有你他们似乎更好了。你想起你在车里说的那句话：「我能回去吗？」也许你该听自己的。也许那时候还来得及。现在太晚了。";
      break;
    }
    case "transfer_regret:admit_mistake": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你承认了。你告诉经纪人你想走。俱乐部不愿意——他们刚花了大价钱买你。但你坚持了。你去了另一家俱乐部，降了薪但回到了你该在的地方。你的旧球迷不再骂你了——他们说你「至少有勇气承认错误」。你失去了钱，但你找回了你自己。"
        : "你承认了。但没有人让你走。俱乐部说「你签了合同」。你坐在板凳上看着队友踢球，想着你本可以留在家。你的旧俱乐部在赢球，你的新俱乐部在输球，你在中间什么也做不了。你想起那个第一次训练后的直觉——它是对的。但你没有听它。";
      break;
    }

    // P-A65: goal machine — pure instinct vs complete player (Haaland dimension).
    case "goal_machine:pure_instinct": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你选择了纯粹。你不再关心传球、防守、跑动——你只关心一件事：进球。你的数据爆炸了——连续十场进球，进球数领跑联赛。赛后你坐在草地上冥想，记者问你在想什么，你说「在想下一个球。」他们说你「不像人类」——也许你说得对。也许你只是一台为进球而生的机器。但机器不需要解释——它只需要运转。"
        : "你选择了纯粹。你的进球数据确实上去了——但你的队友开始不满了。你不防守，你不传球，你只在禁区里等。教练说你「太自私了」——你说你只是在做你该做的事。也许你是对的。也许你只是需要一点时间让别人理解一台机器不需要解释。";
      break;
    }
    case "goal_machine:complete_player": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      good = success;
      outcome = success
        ? "你选择了成为更全面的球员。你开始回撤接球、参与防守、为队友创造机会。你的进球数据降了——但你的助攻数据涨了。教练说你「从一台机器变成了一个人」。你的进球少了，但你的比赛变宽了。也许你不再是最好的射手——但你成了最好的球员。也许两者不一样。"
        : "你选择了成为更全面的球员。但你的进球数据在降，而你的全面性没有上来——你处在一个不伦不类的位置。你不再是那个纯粹的进球机器，但你也没成为完整的球员。你想起那个禁区里的直觉——也许你该听它的。也许有些人就是为了一件事而生的。";
      break;
    }

    // P-A66: broken leader — keep leading vs protect body (Kompany dimension).
    case "broken_leader:keep_leading": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (!success) { mods.addTags = [tag("compromised_body", 4)]; injury = true; }
      good = success;
      outcome = success
        ? "你带着碎过的身体上场了。你不能跑得像从前了，你不能跳得像从前了——但你在场上的时候，你的队友知道往哪跑。赛季末你进了一个禁区外的球——你的第一个——它锁定了冠军。你跑到角旗区没有庆祝，只是跪在草地上摸了摸膝盖。那双膝盖让你缺阵了878天，但今天它帮你踢出了生涯最重要的一球。你说：「值了。」"
        : "你带着碎过的身体上场了。但第三十分钟你的肌肉又拉了。你被抬下场的时候看着记分牌——0-0，没有你他们不知道怎么办。你坐在治疗台上想起你缺阵的878天。也许你该少踢一点的。也许你的身体已经在替你做决定了。但你不知道如果不在场上，你还是不是那个队长。";
      break;
    }
    case "broken_leader:protect_body": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你选择了保护身体。你减少了上场时间，你跳过了不重要的比赛。你的数据降了，但你的身体多撑了两个赛季。你在关键比赛中上场——不是每场，但每一场你上场的时候，球队都知道：队长在。有时候领袖不是踢最多的人——是站在那里就让人安心的人。"
        : "你选择了保护身体。但你发现坐在板凳上比在场上更痛——不是身体痛，是心。你看着队友在没有你的情况下挣扎，你想起你说过「这支队需要我」。也许少踢是对的。但「对」有时候比「需要」更难忍受。";
      break;
    }

    // P-A67: the machine — maintain vs live a little (Lewandowski dimension).
    case "the_machine:maintain_machine": {
      const success = roll(0.65, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你继续了。又一个赛季，又一串进球。你的数据像一台机器一样精确——连续好几个赛季40+进球。媒体问你秘诀是什么，你说「没有秘诀。只有每一天。」他们失望了——他们想要魔法。你没有魔法。你有的只是日复一日地选择做正确的事。也许那比魔法更难。也许那才是真正的天赋。"
        : "你继续了。但你在第三十个比赛日感到了疲惫——不是身体的疲惫，是意志的疲惫。你看着你的作息表，每一项后面都打了勾，但勾开始模糊了。你没有放弃——但你开始怀疑：这台机器还要运转多久？什么时候可以停？也许答案是从不。也许那就是代价。";
      break;
    }
    case "the_machine:live_a_little": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      good = success;
      outcome = success
        ? "你放松了一天。你出去吃了一顿饭，喝了一杯酒，笑了一晚。第二天你回来训练的时候觉得轻了一些。你的数据没有降——也许一天不会毁掉一切。也许机器也需要偶尔停一停。你说「也许秘诀不是永远运转——是知道什么时候停。」"
        : "你放松了一天。但一天变成了两天，两天变成了一周。你的作息表开始漏勾了，你的训练开始迟到了。你的数据没有立刻崩——但你的习惯在崩。你看着那张贴在更衣柜里的作息表，想起你说过的「也许偶尔放松一天也无妨」。也许你是对的。也许你只是回不去了。";
      break;
    }

    // P-A68: legend bond — absorb vs be yourself (Ronaldinho-Messi dimension).
    case "legend_bond:absorb": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      good = success;
      outcome = success
        ? "你学了他的一切——他的传球时机、他的跑位嗅觉、他在球场上的笑容。但他走的那天，他给了你一个拥抱说「你不需要学我了——你已经比我好了。」你看着他走出更衣室，想起他给你传的第一个球。你不会忘记那个球。你也不会忘记他。多年后有人问你谁影响了你最多，你说了他的名字。"
        : "你学了他的一切。但你发现有些东西学不来——他在球场上的那种快乐，那种对足球的纯粹热爱。你学了他的技术，但没学到他的笑容。也许那不是学来的——那是天生的。你感谢他教你的一切，但你知道你终将走自己的路。";
      break;
    }
    case "legend_bond:be_yourself": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 4 : -2);
      good = success;
      outcome = success
        ? "你选择了做自己。你感激他对你的好，但你不学他的踢法——你学你自己的。他走的那天你送他到门口，他说「你会比我都好的」。你说「也许」。他笑了——你知道那个笑里有什么：一个传奇对一个未来传奇的信任。"
        : "你选择了做自己。但有时候你看着他踢球会想——如果你学了他，你会不会更好？你不知道答案。你只是走自己的路——也许它会通向同一个地方，也许不会。但至少是你的。";
      break;
    }

    // P-A69: one club — stay forever vs one last move (Totti dimension).
    case "one_club:stay_forever": {
      // P-DEGEN: 「一生一队」曾是零回报陷阱。安全路：稳涨 +1 perm + club_legend@99
      //（一座城市的灵魂，永久 persona 标签）；代价是母队争冠力不及豪门 → 联赛夺冠 ×0.7。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.leagueTrophyProbabilityMultiplier = 0.7;
      mods.addTags = [tag("club_legend", 99)];
      good = true;
      outcome = "你留下了。又过了几年，你的数据没有那么耀眼了，你的奖杯柜也没有那么满——你稳稳地涨了一截，只是这座球场的奖杯橱窗比豪门窄。但你穿着同一件球衣退役的那天，整座城市为你哭了。你的球衣号码被退役了——没有人再穿它了。你的雕像立在了球场外面。你少了几座奖杯，但你有了一样那些转会的球员永远不会有的东西：一座城市的灵魂。他们不是雇你踢球的——你是他们的儿子。一个从一而终的儿子。";
      break;
    }
    case "one_club:one_last_move": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你去了别处。最后几年你赢了几座你在母队永远不会赢的奖杯。你的新球迷爱你，但你的旧球迷不再唱你的名字了。你退役后回到母队看了一场球，球迷认出了你——他们没有嘘你，但也没有像从前一样喊你的名字了。你坐在看台上想：也许奖杯值得。也许不值。你不知道。你只知道你少了一样东西：一座城市的灵魂。"
        : "你去了别处。但你在新俱乐部踢得不好——你不适应新的城市、新的球迷、新的语言。你坐在更衣室里想起母队的球迷，想起那座你出生的城市。你想回去——但回不去了。你在新俱乐部退役了，没有人给你建雕像，没有人退役你的号码。你赢了奖杯，但失去了一座城市。";
      break;
    }

    // P-A70: two worlds — country first vs bridge both (Bale dimension).
    case "two_worlds:country_first": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      mods.nationalTournamentParticipation = "force";
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你选择了国家队。你在俱乐部的表现开始下滑——你的心不在这里了。但回到国家队你像变了一个人——你为你的国家打进了历史性的进球，你称之为「我国足球史上最伟大的时刻」。你唱国歌的时候哭了。俱乐部球迷骂你，但你不在乎了——你知道哪个世界是真的你。"
        : "你选择了国家队。但俱乐部开始惩罚你——把你放上板凳，削减你的出场时间。你在俱乐部成了「那个只在乎国家队的人」。你在两个世界都踢不好了——俱乐部不信任你，国家队的队友也看到了你在俱乐部的挣扎。也许两个世界不能只选一个。也许你需要两者才能完整。";
      break;
    }
    case "two_worlds:bridge_both": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      good = success;
      outcome = success
        ? "你选择了两个世界都要。你在俱乐部更加拼命——不是因为爱，是因为你想证明你不只是在等国家队比赛。你在两边都踢出了好数据。俱乐部球迷开始不再嘘你了——不是因为他们爱你了，是因为他们开始尊重你了。尊重比爱更稳。"
        : "你试着两个世界都要。但你的身体不够分——你在俱乐部累到在国家队的比赛中跑不动。你在两个世界都变得平庸了。也许Bale是对的——也许有些人只能在一个世界发光。也许你不是Bale。也许你只是你。";
      break;
    }

    // P-A71: uncompromising — stay true vs adapt (Riquelme dimension).
    case "uncompromising:stay_true": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (!success) mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你没有改变。你的教练把你放上板凳了——但你等着。你等着他发现你的传球不是跑出来的，是看出来的。一个月后他不得不把你放回首发——因为没有你，球队不知道往哪传。你站在那里不跑，但你的传球撕裂了防线。赛后有人说你「不像现代球员」。你笑了——你从来不是现代球员。你是最后一个古典的10号。也许以后不会再有了。"
        : "你没有改变。教练没有把你放回首发——他找了别人。一个比你跑得多的人。你在板凳上坐了一个赛季。你的天赋还在，但没有人用古典的方式踢球了。你想起你说过的「现代足球不适合我」。也许你说对了。也许你只是生错了时代。但你不后悔——至少你踢的每场球都是你自己的方式。";
      break;
    }
    case "uncompromising:adapt": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你学会了跑。不是心甘情愿——但你跑了。你的跑动范围扩大了，你的防守数据上去了。你的传球还是那么好——但现在你在更多的地方传出好球了。教练说你「成熟了」。你不知道这是成熟还是妥协。但你的数据更好了，你的奖杯更多了。也许那就够了。也许那就是现代足球的代价——你用一部分自己换了一部分成功。"
        : "你试着跑了。但你跑起来之后发现——你不会传了。你的脑子在跑的时候不能同时看。你变成了一台跑动机器——跑得多了，但什么都看不见了。你的教练说你「牺牲了优势来弥补不足」。你想起Riquelme说的「我不愿意为了跑而忘记思考」。也许他是对的。也许你该听他的。也许有些东西不该改。";
      break;
    }

    // P-A72: lost instinct — find it vs reinvent (Shevchenko dimension).
    case "lost_instinct:find_it": {
      const success = roll(0.25, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (-2);
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (2); }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-3); mods.addTags = [tag("compromised_body", 4)]; }
      good = success;
      outcome = success
        ? "你找了。你在训练场上加练了五百次射门——同一个位置，同一个角度，直到你的脚记住了。第三个月的一个比赛日，球到了你脚下——你不需要想了，你的脚自己动了。球进了。你没有庆祝——你只是低头看着你的脚。它回来了。也许它只是睡了一阵子。也许你只需要叫醒它。"
        : "你找了。但你越找越找不到——你太想它了，你太刻意了。你站在禁区里的时候不再是一个射手——你是一个在思考怎么射的人。射手的本能是不思考的。你正在用思考杀死它。你看着球一次次偏出，想起那些换了球队之后再也没找回准星的射手。也许有些东西一旦丢了就真的丢了。也许你该接受的——你不再是那个射手了。";
      break;
    }
    case "lost_instinct:reinvent": {
      const success = roll(0.4, "positive");
      mods.roleShift = -1;
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (1); }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-2); }
      good = success;
      outcome = success
        ? "你不再追那个射门了。你开始做一个不同的人——你回撤，你组织，你为队友创造机会。你不再是那个禁区里的杀手了——你成了禁区外的供给者。你的进球数据降了，但你的助攻上去了。你用另一种方式留在了球场上。也许你不再是最好的射手——但你还是最好的球员之一。只是换了一种最好的方式。"
        : "你试着改变踢法。但你不知道怎么做一个组织者——你一辈子都在射门，你不知道怎么不射门。你回撤之后发现自己哪里都不在了——不在禁区里射门，也不在中场组织。你成了一个不伦不类的球员。你想起那个曾经站在禁区里不需要思考的自己。那个你走了。新的你还没有来。也许永远不会来了。";
      break;
    }

    // P-A73: quiet exit — one last try vs walk quietly (Khedira dimension).
    case "quiet_exit:one_last_try": {
      const success = roll(0.25, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你拼了。你在预备队比赛中跑了全场最多的距离。新教练终于看了你一眼——不是因为你好，是因为你在他面前跑。他给了你一场机会。你没有进球——但你踢了九十分钟。赛后你在更衣室里坐着，队友走过来看了你一眼，说「你还在」。你点了点头。你还在。也许只是一场比赛——但你还在。"
        : "你拼了。但没有人看。你跑得比任何人都多，但你的数据表还是零。教练没有看你——他已经在想下个赛季的阵容了，那个名单里没有你。你收拾了更衣柜，最后一次走出训练基地。没有人来送你。你在停车场坐了一会儿，然后开车走了。不是所有人都有告别赛。有些人只是在某一天不再来了。";
      break;
    }
    case "quiet_exit:walk_quietly": {
      // P-DEGEN: 故事写「你把球鞋放进了柜子、走出了训练基地」却未 forceRetire。
      // 现为真正的安静退役：forceRetire(voluntary) vs one_last_try 的赌注。
      mods.forceRetire = true; mods.forceRetireReason = "voluntary"; mods.dignifiedExit = true;
      good = true;
      outcome = `你安静地走了。没有新闻发布会，没有告别赛，没有横幅。你把球鞋放进了柜子，把更衣柜清空了，然后走出了训练基地。\n你想起当年那场大赛的半决赛——七万人喊你的名字。此刻停车场空无一人。你坐进车里，看着后视镜里那座球场。你在那里赢了世界杯的预选赛，在那里进了${n.nation}的第五个球。你不需要告别赛——你的每场比赛都是告别。你安静地离开了。有些人的离场比入场更体面。`; break;
    }

    // P-A74: overshadowed — accept role vs demand trade (Dybala dimension).
    case "overshadowed:accept_role": {
      const success = roll(0.5, "positive");
      mods.roleShift = -1; mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你接受了配角。你挪到了新位置——你不擅长的位置。你学了一个赛季。你的进球数据从23降到了5。但你和他一起赢了联赛冠军。赛后他搂着你说「没有你我不行」。你不知道他说的是不是真的——但你知道你赢了。配角也是赢。只是赢的方式不同。"
        : "你接受了配角。但你不适应新位置——你的数据降了，你的信心降了，你的笑容也降了。你看他在你的老位置上踢得如鱼得水，球迷唱他的名字。你坐在板凳上想：你曾经是那个被唱名字的人。现在你是那个听别人被唱的人。也许这是成长。也许只是失去。";
      break;
    }
    case "overshadowed:demand_trade": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      mods.roleOverride = success ? "starter" : "high_rotation";
      good = success;
      outcome = success
        ? "你要求了转会。俱乐部放你走了——他们有他了，不需要你了。你去了新俱乐部，回到了你的老位置。你的数据回来了——不是23球，但比5球好多了。你不需要做谁的配角——你可以做自己的主角。只是在一个小一点的舞台上。也许小舞台的主角比大舞台的配角好。你不确定。但你在笑。"
        : "你要求了转会。但没有人要你——你年纪不小了，数据又不好。俱乐部说「留下来争位置」。你留了，但你坐在板凳上看他在你的位置上踢球。你想起你要求转会的那天——也许你该等一等。也许你只是太急了。也许你只是不想看着他在你的位置上笑。";
      break;
    }

    // P-A75: uncontrolled genius — try control vs accept self (Cassano dimension).
    case "uncontrolled_genius:try_control": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      if (!success) mods.addTags = [tag("compromised_body", 2)];
      good = success;
      outcome = success
        ? "你试了。你真的试了。你提前到了训练，你没有迟到聚餐，你没有扔球衣。三个月后教练看着你说「你变了」。你摇了摇头——你没变，你只是在憋。你知道那个真正的你还在里面。但至少今天你赢了。至少今天你控制住了。也许明天也能。也许。"
        : "你试了。但第二周你又迟到了。第三周你又和教练吵了。你看着镜子说「为什么你就是控制不了？」镜子没有回答。你的天赋在一线上，你的自控在另一条线上，它们从来不交叉。也许它们永远不会交叉。也许天才和自控住在两个身体里，你只有一个。";
      break;
    }
    case "uncontrolled_genius:accept_self": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你接受了你自己。你不再试图变成另一个人——你带着你的疯狂踢球。你的天才和你的疯狂在同一条线上了。你进了一个球后做了一个疯狂的庆祝——教练看着你叹了口气，但他没说什么。他知道你的天才需要你的疯狂。也许这就是代价——你不能只要天才不要疯子。它们是同一个人。"
        : "你接受了你自己。但接受自己的代价是——你的名字变成了一个形容词，意思就是「不符合球队精神的行为」。你的天赋足以成为传奇，但你只会成为一个故事——一个关于「如果」的故事。如果他能控制住自己……如果他没那么疯狂……如果。你的生涯不会是一部传奇，会是一个警告。一个关于天赋不够的故事。";
      break;
    }

    // P-A76: metabolic illness — fight vs accept (Götze dimension).
    case "metabolic_illness:fight_illness": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (-3);
      mods.addTags = [tag("compromised_body", 6)];
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (2); }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-2); }
      good = success;
      outcome = success
        ? "你和它斗了。你换了饮食，你做了治疗，你每天在康复室里比任何人都早到。你的速度回来了——不是全部，但够用了。你回到了球场，你不再是那个飞奔的少年了，但你还站着。你想起当年那个决赛的制胜球——那个你永远不会忘记。这个病不会拿走那个记忆。它只是让你慢了一点。但你还站着。"
        : "你和它斗了。但代谢疾病不是你斗得过的——它在你身体里面，比你更深。你的速度没有回来，你的体重还在涨。你坐在更衣室里看着队友奔跑，想起教练曾经对你说「证明你比谁都强」。你证明了——在那个加时赛的球里。但那已经是很多年前了。现在你只是想跑起来。跑不起来了。";
      break;
    }
    case "metabolic_illness:accept_reality": {
      const success = roll(0.45, "positive");
      // 接受现实=改踢法用脑子代腿：成功则稳住一截（+1 perm），失败则身体不配合新踢法（-1 perm + 顺位下滑）。
      //  修复双重赋值 bug：原 `= success ? 1 : 0;` 紧接 `= -1;` 无条件覆盖，成功分支被写成 -1、
      //  与失败完全相同 → 预览去重成空白，玩家看不到这是赌博。现恢复成功 +1 / 失败 -1 的差异。
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      if (!success) mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你接受了。你不再追那个飞奔的自己了——你改变踢法，用脑子代替腿。你的速度没了，但你的视野还在。你成了一个不同类型的球员——不是更好的，不是更差的，只是不同的。你退役后人们问起你的巅峰——你说113分钟。他们问然后呢？你说然后我学了一种新的踢法。两种都是我。"
        : "你接受了。但接受不等于适应。你换了踢法，但你的身体不配合新的踢法——你的脑子知道该怎么做，你的身体做不到。你变成了一个在场上看着别人跑的人。你想起几年前的你——飞奔、射门、绝杀。那个你走了。新的你还没有来。也许永远不会来了。也许有些东西一旦身体拿走了，就不还了。";
      break;
    }

    // P-A77: signature skill — master vs round out (Juninho dimension).
    case "signature_skill:master_it": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      mods.leagueTrophyProbabilityMultiplier = success ? 1.2 : 1.1;
      good = success;
      outcome = success
        ? "你继续了。你的任意球成了联赛里最令人生畏的武器——门将看到你站在球前就开始紧张。你的任意球一个接一个地进，多到没人再数得清。你退役后人们不再记得你的跑动、你的防守、你的传球。他们只记得你的任意球——那把出鞘必见血的圣剑。你用一生练一技。够了。"
        : "你继续了。你的任意球确实很厉害——但对手开始研究了。他们犯规时不再在你附近犯规了。你的任意球机会少了，你的武器被对手的战术封印了。也许你需要一套B计划。也许你只需要等待他们犯错。你等着。";
      break;
    }
    case "signature_skill:round_out": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      good = success;
      outcome = success
        ? "你开始变全面了。你练了传球、防守、跑动。你的任意球还是你的武器——但现在你还有别的武器了。你成了一个更全面的球员。也许你不会再是那个只靠一脚任意球的人了——但你踢了更多的比赛，因为你不再只是一个一技之长的球员了。"
        : "你试了。但你发现当你练别的技术时，你的任意球开始退步了——你不再每天留下来了。你的绝技在钝化，而你的全面性没有上来。你想起你十三岁时开始练那个球的那天。也许你不该改的。也许有些人就只该做好一件事。也许那就够了。";
      break;
    }

    // P-A78: can't stop — keep diving vs finally stop (Buffon dimension).
    case "cant_stop:keep_diving": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      if (!success) mods.addTags = [tag("compromised_body", 3)];
      good = success;
      outcome = success
        ? "你继续了。你的膝盖在响——但你的手还在扑。你扑出了一个点球，队友冲过来抱你——他们比你小二十岁，他们小时候在电视上看你踢球。你笑了。你不知道自己还能扑多久。但你今天扑了。今天够了。明天再说。"
        : "你继续了。但你的身体开始替你做决定了——你的反应慢了半秒，你的弹跳少了几厘米。你扑到了从前能扑到的球——但不是每一个了。你在更衣室里冰敷膝盖的时候，年轻的队友在笑闹。你想起你也是那样年轻的。你不知道你还剩多少。但你不想数。";
      break;
    }
    case "cant_stop:finally_stop": {
      // P-DEGEN: 故事写「你终于停了。你把球鞋放在了门线上——最后一次」却未 forceRetire。
      // 现为真正的退役退出：forceRetire(voluntary) vs keep_diving 的赌注。
      mods.forceRetire = true; mods.forceRetireReason = "voluntary"; mods.dignifiedExit = true;
      good = true;
      outcome = `你终于停了。你把球鞋放在了门线上——最后一次。你看着空荡的球门，想起${n.startAgeCn}岁第一次站在这里的那天。\n你${n.ageCn}岁了。你踢了${cnNum(Math.max(1, n.careerSeasons))}个赛季。你不需要再扑了。你走进球员通道的时候回头看了一眼——那座球门还在那里。它永远在那里。你不在了。但你扑过的每一个球都还在某个人的记忆里。够了。`; break;
    }

    // P-A79: underappreciated — demand respect vs let actions speak (Touré dimension).
    case "underappreciated:demand_respect": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      if (!success) mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你公开了你的不满。媒体炸了——「生日蛋糕门」成了头条。但俱乐部的反应不是道歉，而是「你应该用表现说话」。你愤怒了——你在场上踢出了你最好的赛季。你用进球回应了不尊重。但你知道——这不是关于进球的。这是关于一个人被忽视了太久。"
        : "你公开了你的不满。但媒体站在了俱乐部那边——「他贪心」「他自私」「一个生日而已」。你在更衣室里看着手机上的评论，想起你帮他们赢得的每一座奖杯。也许你不该说的。也许沉默比表达更安全。但你知道你说的都是真的。你只是不该说出来的。";
      break;
    }
    case "underappreciated:let_actions_speak": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你选择了沉默。你用进球说话。赛季末你进了20球——你在场上的表现比任何生日推文都响亮。俱乐部在赛季末给你办了一个迟到的生日蛋糕——也许是因为他们怕了，也许是因为他们终于记得了。你吹了蜡烛没有笑。但你知道——你不需要他们的蛋糕。你有你的数据。"
        : "你选择了沉默。但沉默不被听到——你的表现没有爆发，你的不满没有表达，你只是在沉默中变老。赛季末你看着俱乐部庆祝另一个球员的生日，想起你自己的。也许沉默不是答案。也许有些不尊重需要被说出来——即使没有人想听。";
      break;
    }

    // P-A80: patience runs out — leave vs stay (Batistuta dimension).
    case "patience_runs_out:leave_for_title": {
      const success = roll(0.55, "positive");
      mods.roleOverride = "starter"; mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      if (success) { mods.leagueTrophyProbabilityMultiplier = 2; }
      good = success;
      outcome = success
        ? `你走了。你去了新俱乐部，你进了20个球，你终于赢得了联赛冠军——你${n.ageCn}岁了，这是你的第一座联赛冠军。你跪在草地上摸着奖杯，想起${n.formerClubOr}。\n当你对新旧主进球时你拒绝庆祝。赛前你跑到客队球迷前敬礼。赛后你又去了。然后你一个人在球员通道哭了。你的铜像还在那座城市。但你的冠军在这里。两个都有了的代价是——你只能选一个地方哭。`
        : `你走了。但新俱乐部的夺冠计划没有成功——你${n.ageCn}岁了，你的身体不像从前了。你进了球但不够多，赛季末你们差了三分。你看着奖杯在别人手里，想起你离开的那座城市——你的铜像在那里，你的那些年在那里。你换了地方，但冠军还是没来。也许它不是关于地方的。也许它从来不是你能选的。`;
      break;
    }
    case "patience_runs_out:stay_loyal": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你留下了。第十年。你的腿不如从前了，但你的心还在。赛季最后一天你们排名第一——你的队友在场上拼命，你在禁区里等。终场哨响。你们赢了。联赛冠军。你的第一座。你跪在草地上哭了。九年——你等了九年。你的铜像在城外，你的冠军在手心里。两个都有了。不需要选。"
        : "你留下了。第十年。但冠军还是没有来。你又进了20球，但球队不够好。赛季结束你坐在更衣室里看着空手——又一个没有冠军的赛季。你三十二了。你的腿开始跟不上了。你想起那份合同——也许你该签的。也许忠诚的代价太高了。但你看着窗外的城市——你的铜像在那里。也许那比冠军重。也许。";
      break;
    }

    // P-A81: super sub — change the game (Larsson dimension).
    case "super_sub:change_game": {
      const success = roll(0.45, "positive");
      if (success) { mods.leagueTrophyProbabilityMultiplier = 2; }
      good = success;
      outcome = success
        ? `你上场了。二十分钟。你助攻了第一个球——一个你练了二十年的传中。你助攻了第二个——一个你不假思索的做墙。2-1。你们赢了决赛。\n赛后对手的巨星走过来说「我没看见什么大牌，我看见了你们。」你笑了——你${n.ageCn}了，你不是巨星，你是那个在最后一刻被需要的人。你的球衣在俱乐部商店销量第三——一个替补球员的球衣。也许你不是最大的，但你是最被需要的。`
        : "你上场了。二十分钟。你跑不动了——你的膝盖在抗议，你的呼吸在燃烧。你没有改变比赛。终场哨响你们输了。你坐在更衣室里看着你的旧膝盖。也许二十分钟不够了。也许你该在更早的时候说「我踢不了了」。但你不后悔上场——你只是后悔没帮到他们。";
      break;
    }

    // P-A82: forgotten test — accept ban vs fight (Ferdinand dimension).
    case "forgotten_test:accept_ban": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      mods.suspended = true; mods.overallDelta = (mods.overallDelta ?? 0) + (-2);
      good = success;
      outcome = success
        ? `你接受了八个月禁赛。你错过了${n.continentalCup}——你的国家队队友在没有你的情况下出征。你坐在家里看电视，想起那天你忘了的那件事。八个月后你回来了——你的第一场比赛是对死敌。你踢得很好。你重建了一切——一个又一个联赛冠军，一座${n.continentalClubCup}。你的错误没有定义你。但你永远不会忘记它。每次有人叫你做药检，你第一个到。`
        : "你接受了八个月禁赛。但八个月后你回来时——你的位置已经被别人占了。你的状态不在了，你的信心不在了。你花了半个赛季才回到首发。你想起那双你试到一半的鞋。那双鞋的代价比任何鞋都贵。";
      break;
    }
    case "forgotten_test:fight_it": {
      const success = roll(0.2, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.suspended = !success; mods.overallDelta = (mods.overallDelta ?? 0) + (-1);
      good = success;
      outcome = success
        ? "你申诉了。你做了头发检测，你证明了自己是清白的。禁赛减到了罚款。你的经纪人说「值了」。你知道你确实犯了错——但你也知道惩罚太重了。你回到了球场，但你不再忘了任何药检。一次就够了。"
        : "你申诉了。但足协不接受「忘了」作为理由。禁赛维持八个月。媒体说你在「逃避责任」。你的申诉让你看起来更糟了。你坐在家里看着电视上的比赛——你本该在那里的。你想起你该签的是「接受」而不是「申诉」。有时候认错比辩解更快。";
      break;
    }

    // P-A83: beautiful football — insist beauty vs pragmatic (Gullit dimension).
    case "beautiful_football:insist_beauty": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? "你坚持了美丽。你的球队踢出了联赛最好看的足球——传切配合、进攻流畅、球迷起立鼓掌。你赢了冠军，而且赢得漂亮。赛后记者问你秘诀，你说「足球应该让人想看」。他们又笑了——但这次他们没有在笑你。你在笑。你证明了美丽和胜利不是敌人。你可以同时拥有两者。"
        : "你坚持了美丽。但美丽没有赢得冠军——你的对手用丑陋的防守反击赢了联赛。你踢出了最好看的足球，但你没有奖杯。你的球迷说你「踢得好看但没赢」。你想说：好看本身就是赢。但你不确定你自己信不信。也许美丽需要奖杯来证明自己。也许不需要。你不知道。但你的足球确实让人想看。";
      break;
    }
    case "beautiful_football:pragmatic": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你选择了实用。你的阵型丑陋但有效——防守反击，1-0，三分。赛季末你赢了冠军。你的球迷说「赢就是赢」。你看着奖杯想：你说得对。赢就是赢。但你也想起你在战术板上画「性感足球」的那天。也许奖杯比美丽重。也许。但你不确定你快乐。"
        : "你选择了实用。但实用也没有赢——你的对手比你更实用。你踢了一个无聊的赛季，没有赢也没有人想看你。你想起那个「性感足球」的词。也许你该坚持的。也许美丽至少让你输得有人看。实用让你输得没人看。";
      break;
    }

    // P-A84: hidden wounds — seek help vs keep hidden (Dele dimension).
    case "hidden_wounds:seek_help": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      if (!success) mods.addTags = [tag("compromised_body", 3)];
      good = success;
      outcome = success
        ? "你开口了。你告诉了一个人——也许是心理咨询师，也许是老教练，也许只是一个你信任的人。你说出了那些你从没说过的东西。你没有立刻变好——但你感觉轻了一点。你回到了训练场，你的状态没有立刻回来，但你站在那里的样子不一样了。你不是在扛了——你在放下。放下不是放弃。放下是终于不用一个人了。"
        : "你开口了。但开口没有立刻帮到你——伤口太深了，一个疗程不够。你继续踢着，但你知道你在走向一个你不确定的方向。也许你需要更多时间。也许足球之外有比足球更重要的事。你不确定。但至少你知道了一件事——你不是一个人。知道这一点有时候就够了。有时候不够。但至少够了开始。";
      break;
    }
    case "hidden_wounds:keep_hidden": {
      const success = roll(0.25, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (!success) mods.addTags = [tag("compromised_body", 5)];
      good = success;
      outcome = success
        ? "你藏起来了。没有人知道——你在场上踢球，在场下笑，在更衣室里和队友开玩笑。他们不知道你每天晚上需要什么才能入睡。你的状态偶尔会下滑，但你用意志力撑住了。也许你会在退役后处理这些。也许那时候会更安全。也许那时候已经太晚了。但至少今天——没有人知道。你是安全的。你不确定这是不是好事。"
        : "你藏起来了。但藏起来的东西会膨胀——它开始吞噬你的睡眠、你的食欲、你的训练、你的比赛。你的状态在下滑，媒体说你是「浪费天赋」。他们不知道你已经在用全部力气只是站在这里。你想说——你想告诉他们——但你不知道怎么开口。也许你永远不会开口。也许有些伤足球治不好。也许你会在沉默中变老。";
      break;
    }

    // P-A85: unchanged — stay normal vs enjoy success (Kanté dimension).
    case "unchanged:stay_normal": {
      // P-DEGEN: 「不变」曾是零回报陷阱。安全路：稳涨 +1 perm + cautious_play（不变的生活
      // 护住身体、没夜店透支）；代价是顺位下滑（你没利用名气拍身价，俱乐部眼光滑向那些造势的人）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      mods.addTags = [tag("cautious_play", 3)];
      good = true;
      outcome = `你开着Mini回了家。你吃了妈妈做的饭——你从小吃到大的那道家乡菜。你的手机里有100条消息说你是世界最佳。你看了几条，然后放下了。\n你的队友在Instagram上晒跑车晒游艇晒夜店。你没有Instagram。你稳稳地涨了一截，身体也没被夜生活透支——只是你没造势，顺位悄悄滑了一档。你有一台Mini和一个做饭的妈妈。你赢了世界杯。你赢了${n.continentalClubCup}。你从来没有收到过一张红牌。你不是不变——你只是不需要变。有些人赢了世界就变了。你赢了世界还是你。也许这就是你赢的原因。`;
      break;
    }
    case "unchanged:enjoy_success": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你买了辆好车。你去了几次好餐厅。你的生活变了一点——但只是一点。你在训练场上还是你。你的队友说你「终于像个球星了」。你笑了——你不像球星。你只是开了一辆好一点的车。你还是你。只是车变了。人没变。也许永远不会变。"
        : "你买了辆好车。你开始出入你从前不去的场合。你的训练状态下滑了——不多，但你自己感觉到了。你看着镜子里的你，穿着你从前不会穿的衣服，开着你从前不会开的车。你还是你吗？你不确定。但你的Mini还在车库里。也许哪天你会再开它。也许那时你会说「对不起我离开了」。也许不会。";
      break;
    }

    // P-A86: the bison — sacrifice vs save (Essien dimension).
    case "the_bison:sacrifice_body": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (!success) { mods.addTags = [tag("compromised_body", 6)]; injury = true; }
      good = success;
      outcome = success
        ? "你继续跑了。你的膝盖在叫——但你比它更倔。你跑出了全场最多的距离，你抢断了最多的球。赛后你的膝盖冰敷了两个小时，但你的球队赢了。教练说你「像一头不会倒的野牛」。你笑了——野牛也会倒的。只是不是今天。今天你还站着。明天再说。"
        : `你继续跑了。但你的膝盖终于说了算——第七十分钟你倒在了地上，十字韧带又一次裂了。你被抬下场的时候看着记分牌——1-0，你们赢了。你帮他们赢了。但你的膝盖帮不了你了。你坐在治疗台上想起队医说的话——你的膝盖像四十岁的。你${n.ageCn}岁。足球一块一块地把它拿走了。`;
      break;
    }
    case "the_bison:save_yourself": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你少跑了。你的数据降了——抢断少了，覆盖少了。但你的膝盖在感谢你。你比所有人预计的都多踢了好几年——不是因为你最强，是因为你学会了保护自己。你不再是那头野牛了——你成了一只聪明的老牛。少跑一点，活久一点。也许这不是英雄的方式——但英雄的膝盖都是四十岁的。"
        : "你少跑了。但少跑的你不知道怎么踢球了——你的全部价值就是跑。你不跑了之后，你什么都不是了。你的队友开始不传给你了——不是不信任，是他们忘了你在那里。你坐在更衣室里想：也许野牛不该学会保护自己。也许野牛就该跑到倒下。你不知道哪种更好。但你知道你不再是野牛了。";
      break;
    }

    // P-A87: denied honor — let it go vs speak out (Sneijder dimension).
    case "denied_honor:let_it_go": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你放下了。你看着电视上那个人举金球，你关掉了电视。你摸了摸你自己柜子里那些奖杯。它们是真的。金球也是真的——但它不在你手里。你的队友说「你是最好的」，你说「我知道」。你不需要一个奖来告诉你你做了什么。你做了什么在球场上。在那个赛季里。在那些决赛里。那些不会消失。金球会。你赢下的那些不会。"
        : "你说服自己放下。但每年颁奖礼那天你都会关掉电视——嘴上说不在乎，身体比嘴诚实。那座你没拿到的奖压在心里，压成了一根刺。它没有让你更强，它只是一直在那里。";
      break;
    }
    case "denied_honor:speak_out": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      if (!success) mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你说了。你在采访中说「我不知道评委看了什么」。媒体炸了——有人支持你，有人说你「嫉妒」。但你不在乎——你只是不想沉默。你做了所有你能做的，你想让人知道你知道。也许他们不会改。但至少你说了。沉默才是真正的被夺走。"
        : "你说了。但媒体站在了评委那边——「金球是投票的结果」「他应该尊重结果」。你的公开不满让你看起来像在抱怨。你回到训练场，队友看着你的眼神变了——不是不支持，是觉得你「不该说」。也许你该沉默的。也许沉默比说话更体面。但你知道你被抢了。你只是不该说出来。";
      break;
    }

    // P-A88: raumdeuter — master space vs try technique (Müller dimension).
    case "raumdeuter:master_space": {
      const success = roll(0.65, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你精读了空间。你不再是跑得最快的那个人了——你从来不是。但你是那个总是出现在正确位置的人。你的队友说你「像鬼一样」——你从他们身边消失，然后出现在禁区里。赛季末你成了联赛助攻王和射手榜前三。他们说你的进球「不漂亮」——你说「漂亮不进网。我的进球进网。」你的天赋不在脚下。在你的眼睛里。在你看球之前看到的那个空间里。"
        : "你精读了空间。但对手开始研究你了——他们封住了你常出现的空间，你无处可去了。你试着找新的空间，但你的速度不够让你到达。也许你需要不只是空间——你还需要到达空间的速度。你看看你的腿，再看看你的脑子。也许两个都需要。也许一个不够。";
      break;
    }
    case "raumdeuter:try_technique": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      good = success;
      outcome = success
        ? "你开始练脚下技术了。你的盘带变好了，你的射门变准了。但你的空间感开始钝了——你不再像从前一样能看到空隙了。你多了一样武器，但失去了一样天赋。也许天赋是固定的——你增加了一个，就得减少一个。也许你该接受你的天赋在眼睛里而不是在脚下。也许有些人就不该练盘带。"
        : "你练了脚下技术。但你练不好——你的脚不是那种脚。你花了整个赛季练盘带，但你的盘带还是比不上一个十六岁的青训球员。你退回你的空间——但你离开太久，空间感也钝了。你站在场上不知道该去哪了。也许你不该改的。也许空间解读者就该解读空间，不需要脚。";
      break;
    }

    // P-A89: integrity — tell ref vs stay silent (Klose dimension).
    case "integrity:tell_ref": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你跑向裁判。「这个球是我的手。」你说。他看着你——也许他在想从来没球员主动来跟他说这个。他取消了进球。\n你的队友看着你——不是生气，是不解。你的教练在场边摇头。你回到中圈，比分归零了。但你做了一件很多人一辈子不做的事：你说了真话。\n赛后你收到了一座公平竞赛奖。你说「我只是做了应该做的。」你说得对。但不是所有人都会做应该做的事。这就是区别。"
        : "你跑向裁判说了真话。他取消了进球——然后你们输了那场球，也输掉了那个赛季。更衣室里没有人骂你，但也没有人看你。教练在赛季总结上说「我们输在细节」。你知道他说的细节是什么。你做对了事，代价由所有人一起付。";
      break;
    }
    case "integrity:stay_silent": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -2);
      good = success;
      outcome = success
        ? "你闭嘴了。球进了，比分变了，你赢了。没有人知道。赛后你看着那个进球的回放——你的手碰到了球，但镜头不够清楚。你逃过了。你的队友庆祝你，你的球迷唱你。你跟着庆祝，跟着笑。但回到酒店你看着天花板，想起那个球。你知道它不是你的。也许没人会知道。但你知道。你会一直知道。"
        : "你闭嘴了。但赛后的回放从另一个角度拍到了你的手。社交媒体炸了——「骗子」「作弊者」。你的教练问你「你为什么不告诉裁判？」你没有回答。你知道你该说的。你没有。现在所有人都知道了你不说的。不说的代价比说的代价更大。";
      break;
    }

    // P-A90: common goal — lead movement vs just donate (Mata dimension).
    case "common_goal:lead_movement": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你发起了运动。第一个月只有三个人加入。第二个月有十个。第三个月有五十个。1%从你的薪水变成了五十个人的薪水——从一小滴水变成了一个小池塘。媒体说你「改变了足球文化」。你说「我只是问了一个问题：我们能不能一起做点什么？」答案是可以的。你被授予了荣誉MBE——一个外国球员被英国国王表彰。不是因为你的进球。因为你的1%。"
        : "你发起了运动。但响应的人不多——有些球员说「这是我自己的钱」，有些经纪人说「你在干涉别人」。你捐了你的1%，但号召失败了。你不是一个领袖——你只是一个做了对的事的人。也许那就够了。也许1%不是关于多少人加入——是关于你做了没有。你做了。";
      break;
    }
    case "common_goal:just_donate": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你自己捐了。1%。没有号召别人，没有发起运动——只是安静地捐了。你的经纪人不知道，你的队友不知道，你的球迷不知道。你每个月看银行账单多了一行——「慈善捐款」。没有人鼓掌。没有人给你奖。但你知道你做了。也许安静地做对的事不需要观众。也许1%不需要变成运动。也许它只需要是一个人的选择。你的选择。"
        : "你签了支票，就此为止。钱到了账，你的名字出现在感谢名单的第四行。没有人再找过你，也没有人记得你捐过——支票是最容易给出去的东西，也是最容易被忘掉的东西。";
      break;
    }

    // P-A92: national god — answer call vs stay retired (Hagi dimension).
    case "national_god:answer_call": {
      // P-DEGEN: 曾是纯收益（为国出征无代价）。补收益：稳涨 +1 perm + fan_darling（国民把你当神）；
      // 代价是俱乐部那边被国家队分心 → roleShift −1（「回来别想首发了」）。
      mods.nationalTournamentParticipation = "force";
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      mods.addTags = [tag("fan_darling", 4)];
      good = true;
      outcome = "你回去了。你带着一条受伤的肩膀上场——你只踢了半场，但你踢的那半场你的国家在看。赛后你被队友抬着绕场一周，你成了国民的神。\n你回到俱乐部，主席脸黑了——你的顺位滑了一档，你为国家队分了心。你想起那个凌晨——100个人在电视台外面喊你的名字。你问自己「你算什么让整个国家求你」。你不知道答案。但你知道你回来了。也许你算不了什么——但你的国家觉得你算。那就够了。";
      break;
    }
    case "national_god:stay_retired": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你没有回去。你在电视上看到了你的国家队在没有你的情况下挣扎——他们输了一场关键比赛。评论员说「如果有他在……」你关掉了电视。也许你给了足够多了。也许你没有。你不知道。但你知道你的国家会继续找下一个你。也许他们找不到。也许你就是唯一的那一个。"
        : "你没有回去。你的国家没能晋级大赛。媒体说「如果他回来……」你看着手机没有回。你想起你说过「我已经给了足够多」。也许你没有。也许一个国家的足球之神不能说够了。也许够了不是你能说的——是他们说。他们还在等。你不在了。";
      break;
    }

    // P-A93: the kick — shoot (Koeman dimension). The single defining moment.
    case "history_kick:shoot": {
      const success = roll(0.5, "positive");
      if (success) { mods.leagueTrophyProbabilityMultiplier = 3; mods.continentalPrimaryTrophyProbabilityMultiplier = 3; }
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你起脚了。球飞过了人墙——像一把锤子。门将没动——不是因为他不想动，是因为球太快了。球在网窝里。全场塌了。你的队友从四面八方冲来。你跪在草地上——你只进了一个球。但你知道这一个球把你的名字和这家俱乐部永远绑在了一起。你站在这里，你的脚背上还有那一脚的余震。漫长的等待，一秒钟的决定。你做了。"
        : "你起脚了。球飞过了人墙——但偏了。擦着门柱飞了出去。你看着球飞向看台，听见全场的叹息和你队友的沉默。你跪在草地上——你只差了一厘米。这一脚本来可以把你的名字和这家俱乐部绑在一起，此刻它没有。点球大战来了。你不在罚球名单上——你的脚已经踢过了。它选择了不进去。";
      break;
    }

    // P-A94: the scar — own it vs hide it (Ribéry dimension).
    case "the_scar:own_it": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你接受了你的脸。你没有遮住它——你让它在那里。你在镜头前笑的时候伤疤在阳光下闪光。孩子问你怎么了，你说「这是上帝给我的不同」。他们笑了——他们不怕你的脸。大人怕。孩子不怕。\n你成了世界上最好的边锋之一。你的速度、你的盘带、你的射门——它们不是因为你的脸，但它们带着你的脸。你说「人们只能接受我本来的样子。」他们接受了。你的伤疤成了一种标志——不是缺陷，是特征。"
        : "你接受了你的脸。但接受不是一劳永逸的——有些日子你还是会在镜子前站很久。你继续踢，继续跑，继续进球。你的脸还在那里，但你学会了不再看它。你只看球。球不会看你的脸。球只知道你的脚。你的脚比任何人的脸都好看。";
      break;
    }
    case "the_scar:hide_it": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      good = success;
      outcome = success
        ? "你试了遮住它。但遮住了伤疤遮不住你自己——你踢球的时候还是会露出来。你慢慢地不再遮了。也许不是因为你接受了它，是因为你累了遮了。也许累也是一种接受。"
        : "你试了遮住它。但遮住一个伤疤需要每天花时间——而你的时间应该在球场上。你的注意力从训练转移到了镜子，你的状态开始下滑。你想起有人说过「上帝给了我这个不同」。也许你不该遮的。也许你的不同不是你的缺陷——是你的动力。";
      break;
    }

    // P-A95: defensive art — elegant defense vs tough defender (Maldini dimension).
    case "defensive_art:elegant_defense": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? `你选择了优雅。你不铲球——你站位。你让前锋看着你，发现没有空间可以过。你的防守像一堵看不见的墙——不是因为它硬，是因为它在那里。\n赛季末你全联赛最少犯规但最多抢断成功。媒体说你「不像后卫」。你说「也许我不像。也许后卫不需要像后卫。」${cnNum(Math.max(1, n.careerSeasons))}个赛季，${n.careerApps}场比赛，红牌几张就能数完。你用优雅证明了防守也是艺术。`
        : "你选择了优雅。但有些前锋不吃优雅——他们冲你撞你铲你。你站在那里不铲——他们就从你身边过了。你开始想：也许优雅需要一点硬。也许Maldini也不只靠站位——他也会在必要的时候硬碰硬。你学着在优雅和硬之间找到平衡。也许最好的防守是两者都有。";
      break;
    }
    case "defensive_art:tough_defender": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      if (!success) mods.addTags = [tag("compromised_body", 3)];
      good = success;
      outcome = success
        ? "你选择了硬。你铲球、你对抗、你用身体告诉前锋「这里不是你能来的地方」。你的数据没有Maldini那么优雅——你的犯规比他多。但你的对手也更怕你。赛季末你的球队失球全联赛最少。前锋说和你对抗「像撞墙」。你笑了——你确实是一堵墙。只是你的墙是用铲断砌的，不是用站位砌的。也许两种墙都行。"
        : "你选择了硬。但硬有代价——你的膝盖在第十二次铲球后开始抗议了。你在治疗台上想起Maldini说的「最好的防守不需要铲球」。也许他说得对。也许你该少铲一点。也许你的身体已经在告诉你了——硬不是唯一的方式。";
      break;
    }

    // P-A96: miracle comeback — fight back vs be grateful (Cazorla dimension).
    case "miracle_comeback:fight_back": {
      const success = roll(0.2, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (-6); mods.statsMultiplier = 0.1;
      mods.addTags = [tag("compromised_body", 6)];
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (4); }
      good = success;
      outcome = success
        ? "636天后你回到了球场。你替补上场时全场起立——他们知道你经历了什么。八次手术、坏疽、皮肤移植、差点截肢。你进了球——比某些健康赛季还多。你进球后亲吻手臂——你女儿的名字不在那里了，被皮肤移植盖住了。但你的脚还在。你的球还在。你还在。医生说「能走路就满足了」。你笑了——你不止在走路。你在踢球。"
        : "636天后你回来了。但你的脚踝不是从前的脚踝了——它是一块拼凑出来的东西。你上了场，但你知道你不再是那个从前的你了。你踢了一个赛季——不是最好的赛季，但你踢了。医生说「能走路就满足了」。你说「我踢了一个赛季」。他看着你没有说话。也许走路就够了。也许踢球是额外的。也许那个额外才是你。";
      break;
    }
    case "miracle_comeback:be_grateful": {
      // P-DEGEN: 故事写「你把球鞋收进了柜子。你没有踢球了」却未 forceRetree。
      // 现为真正的感恩退役：forceRetire(injury) vs fight_back 的赌注。
      mods.forceRetire = true; mods.forceRetireReason = "injury"; mods.dignifiedExit = true;
      good = true;
      outcome = "你选择了走路。你站在训练基地外面看着队友跑步——你的脚踝不会再让你跑了。医生说「能走路就满足了」。你说他说得对。你的女儿跑过来抱你的腿——那条差点不在的腿。你摸了摸手臂上的皮肤移植——你女儿的名字不在了，但你女儿在。你把球鞋收进了柜子。你没有踢球了。但你走路了。每一步都是额外的。每一步都是赚的。"; break;
    }

    // P-A97: captain's save — the Casillas moment. One-on-one in the WC final.
    case "captain_save:dive": {
      const success = roll(0.5, "positive");
      if (success) { mods.worldCupResultOverride = "champion"; mods.nationalTournamentParticipation = "force"; mods.forceNationalCaptain = true; }
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你扑了出去。你的手套碰到了球——球改变了方向。全场塌了。你救了世界杯决赛。\n加时赛你的队友进了一个球——你们赢了。你举起奖杯的时候眼泪掉下来了。你想起小时候在电视上看Matthäus、Dunga、Cafu举起奖杯的样子。此刻是你。你是第三个以门将身份举起世界杯的队长。你的手套上还有那一次扑救的痕迹。你的眼眶是湿的。你的国家在你的身后。你的国家在你的手里。"
        : "你扑了出去。但球从你的手套边滑过——球进了。你趴在草地上不动。全场在欢呼——不是为你。你想起小时候在电视上看别人举起奖杯。此刻不是你。你趴在那里，听着对方球迷在唱。你的手套上没有那个球的痕迹。你的眼泪在草地上。你的国家在你的身后——但他们不再在你的手里了。";
      break;
    }

    // P-A98: reinvention — change position vs stay winger (Valencia dimension).
    case "reinvention:change_position": {
      const success = roll(0.55, "positive");
      mods.roleShift = success ? 0 : -1;
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? `你改了。前三个月你踢得像个新手——你的身体记得怎么过人，不记得怎么防守。但第四个月你开始明白了——你以前过不掉的后卫，你现在知道他们会怎么跑。你用前锋的脑子踢后卫。赛季末你成了联赛最好的右后卫之一。媒体说你是「重生」。你说你不是重生——你只是换了一种活法。${n.careerApps}场顶级联赛出场，一项没人想到会被你破掉的纪录。你从边锋变成了队长。有时候活着不是坚持——是改变。`
        : "你改了。但你不适应——你的身体在老位置踢了这么多年，它不认识新位置。你踢了一个赛季平庸的后卫足球。你不够好，但你在场上。也许下个赛季会好一些。也许不会。但至少你还在踢——不是边锋，但还在踢。";
      break;
    }
    case "reinvention:stay_winger": {
      const success = roll(0.25, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      outcome = success
        ? "你没改。你用你的经验弥补了速度的丧失——你不再追着球跑了，你开始提前跑。你的数据降了，但你还在场上。也许你不是最好的边锋了，但你还是边锋。有些身份比能力更重要。你选择做你自己——即使做自己的代价是变慢。"
        : "你没改。但速度继续在消失——你越来越追不上了，你的出场越来越少。你坐在板凳上看一个比你快十岁的年轻人踢你的位置。你想起教练说的「改位置」。也许你该听的。也许有些身份不值得为它去死。也许边锋不是你——踢球才是你。但你选了边锋。现在边锋也选了离开你。";
      break;
    }

    // P-A99: dark impulse — seek help vs accept darkness (Suárez dimension).
    case "dark_impulse:seek_help": {
      const success = roll(0.45, "positive");
      // 咬人禁赛数月——少踢半季而非整季停赛（你后来回来了还进了球）。
      mods.statsMultiplier = 0.5; mods.overallDelta = (mods.overallDelta ?? 0) + (-2);
      if (success) mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      good = success;
      outcome = success
        ? "你去找了心理咨询师。你说了你从没对人说过的东西——你在球场上有时候不是你，是另一个你。你不知道怎么控制那个你。你花了三个月学会了在那一秒停下来——不是不咬，是在咬之前多想半秒。半秒就够了。你回到了球场，你进了很多球。你没有再咬。你的队友说你「变了」。你说你没有变——你只是学会了在野兽出来之前把它关回去。"
        : "你试着找了心理咨询师。但你的问题是场上的，不是沙发上的——咨询室里安静的你不是球场上疯狂的你。你回到了球场，你在第三场比赛又失控了。也许有些东西不是谈话能治的。也许你的天才和你的野兽是同一条绳子上的两端——你拉不住一头而不放开另一头。";
      break;
    }
    case "dark_impulse:accept_darkness": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      // 咬人禁赛——少踢半季而非整季停赛（你接受了野兽，但停赛罚单仍在）。
      mods.statsMultiplier = 0.5;
      good = success;
      outcome = success
        ? "你接受了。你就是你——进球的那个和咬人的那个是同一个人。你不会改，因为你的进球和你的冲动来自同一个地方。赛季末你的进球数排在联赛最前面。媒体说你是「天才和野兽」。你没有反驳。你只是继续进球。你的队友爱你的进球，恨你的冲动。但他们选了你——因为你的进球比你的咬人更多。也许这就是代价。"
        : "你接受了。但足球不再接受你了——第三次的禁赛是四个月。你被禁止进入任何球场，甚至不能当观众。你坐在家里看着电视上的比赛，你的队友在没有你的情况下踢。你想起你说过的「天才和野兽住同一个身体」。也许对。但此刻只有野兽在这里。天才被关在门外了。";
      break;
    }

    // P-A100: predator — trust instinct vs learn to play (Inzaghi dimension).
    case "predator:trust_instinct": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? `你继续站在越位线上。赛季末你的进球数一路涨。他们说你「不会踢球」。但进球爱上了你。你在${n.continentalClubCup}决赛进了两个球——你说过「从小做梦想在决赛进两个球」。你做到了。那位老帅说你「出生越位」。那位名宿说你「不会踢球」。但他们在说这些话的时候，你站在领奖台上，手里拿着${n.continentalClubCup}。也许你不会踢球。但球会找你。这就够了。`
        : "你继续站在越位线上。但你的进球数没有跟上——你越位太多次了，教练开始不耐烦。你的队友说「你需要回来参与组织」。你不想回来——回来就不是你了。你在越位线和板凳之间摇摆。也许你该听那位名宿的——也许你不会踢球。但进球知道你会。只是进球不是每场都来。";
      break;
    }
    case "predator:learn_to_play": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      outcome = success
        ? "你学了。你开始回撤，开始传球，开始参与组织。你的进球数降了——从24降到了12。但你的助攻上去了。你的教练说你「全面了」。你笑了——你不想要全面。你想要进球。但全面至少让你留在了场上。也许这是成长。也许这是妥协。也许两者是一样的。"
        : "你学了。但你学不会——你的脚不是那种脚。你花了整个赛季练盘带，但你的盘带还是比不上一个青训球员。你的位置感也钝了——你不再站在越位线上了，你回撤了，但你不知道回撤之后该去哪。你变成了一个不伦不类的人——不会踢球也不会进球。也许你该回到越位线上的。也许那里才是你的家。";
      break;
    }

    // P-A101: filial duty — carry all vs just play (Son dimension).
    case "filial_duty:carry_all": {
      const success = roll(0.5, "positive");
      if (success) { mods.nationalTournamentParticipation = "force"; }
      good = success;
      outcome = success
        ? `你赢了。你助攻了两个球——加时赛的每一脚。终场哨响你跪在草地上，队友冲过来抱住你。他们在笑也在哭——因为他们不用去当兵了。你做到了。\n赛后你打电话给你父亲。他什么也没说——你听见他在哭。你想起${n.startAgeCn}岁一个人出国的那天，他说「如果你基本功不够好，你在外面一天都活不下去。」你活下来了。你不只是活下来了——你扛着所有人活下来了。`
        : `你输了。你坐在更衣室里不动——你的队友要当兵去了。两年的时间。你不知道该说什么。你打电话给父亲，他说「你尽力了」。你知道他说得对。但「尽力了」三个字此刻不够重。你想起一千个颠球、${n.startAgeCn}岁一个人出国、看动画片学语言。你做了所有你能做的。但有时候所有你能做的不够。你的队友在收拾行李。你还在坐着。`;
      break;
    }
    case "filial_duty:just_play": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你只踢了你自己的球。没有想国家，没有想兵役——只想球。你进了两个球。你们赢了。赛后你的队友哭着感谢你——你不知道他们在谢什么。你只知道你踢了一场好球。也许这才是最好的方式——不去想重量，只踢球。重量自己会找到你。但如果你踢的时候在想重量，你踢不好。你选择了踢球。重量没有压垮你——因为你没有让它压你。"
        : "你只踢了你自己的球。但你想的太多了——你想着你父亲的训练，想着队友的兵役，想着你的国家。你的脑子太满了。你踢了一场糟糕的比赛。赛后你的队友什么也没说——他们不想怪你。但你知道他们知道。也许你该扛的。也许有些时候你不能只想球。也许有些时候球不只是球。";
      break;
    }

    // P-A102: redemption arc — one more time (Di María dimension).
    case "redemption_arc:one_more_time": {
      const success = roll(0.5, "positive");
      if (success) { mods.nationalTournamentParticipation = "force"; }
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你赢了。你造了第一个球的点球，你进了第二个。终场哨响你跪在草地上哭——不是伤心，是三场决赛的重量终于落下来了。你想起了第一次的大腿撕裂，第二次的腿筋，第三次的又一次伤病。三次决赛，三次错过。此刻你不再错过了。\n你的队友跑过来抱住你。他们知道你经历了什么——他们和你一起经历了。你戴着队长袖标——老队长下场了，袖标给了你。你举起了奖杯。你说「现在我只是另一个球迷了。」你笑着说的。但你的眼眶是湿的。你不是球迷。你是那个输了三次还敢上场第四次的人。"
        : "你输了。第四个决赛。你站在中圈看着对方庆祝，你的腿在发抖——不是累了，是太多次了。你的队友走过来拍你的肩——他们不知道说什么。你想起三次决赛、三次伤病、三次「下一次」。也许没有下一次了。也许有些人的命运就是差一步。你不知道你会不会还有第五次。但你知道一件事——如果你有，你会上场。因为你不是不怕输——你是不上场比输更痛。";
      break;
    }

    // P-A103: invisible engine — keep invisible vs demand recognition (Makélélé dimension).
    case "invisible_engine:keep_invisible": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? "你继续做引擎。赛季末你的球队失球全联赛最少。你的教练在赛季末评选最佳球员时选了你——不是因为你的进球，是因为没有你球队不会运转。\n主席最终卖了你——他说你「不会头球，传球不过三米」。你走的那天队长说「他的离开是这支球队终结的开始。」后来真的终结了。你去了新俱乐部，那里的人叫你的位置「Makélélé角色」。一个位置用你的名字命名——不是因为你进球多，是因为你做的事太重要了以至于需要一个名字。引擎不发光。但没有引擎，宾利不会跑。"
        : "你继续做引擎。但你的薪资还是全队最低——你做的活最多，拿的钱最少。赛季末你的球队赢了冠军，记者问MVP是谁，没有人提到你的名字。你看着奖杯——你知道没有你它不会在这里。但奖杯不知道。奖杯只记得进球的人。";
      break;
    }
    case "invisible_engine:demand_recognition": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你要求了涨薪。俱乐部同意了——不是因为他们想，是因为他们知道失去你的代价。赛季末你的球队失球数涨了30%——不是因为你踢得差了，是因为你在谈判的时候分了心。但你的合同涨了。也许钱比尊重容易量化。也许你需要的就是钱。但你的队长看着你说「你变了」。你没变——你只是不再免费了。"
        : `你要求了涨薪。主席拒绝了——他说你「不会头球，传球不过三米」。你坐在更衣室里看着他离开。你知道他不懂——他只看进球的人。你做了${n.careerApps}场比赛，进了${n.careerGoals}个球。你的位置用你的名字命名了。但你的主席不知道。也许有些人永远看不见引擎——直到引擎停了。你停了。你被卖了。新俱乐部的人说「我们一直在找你这样的人。」你笑了——你这样的人，就是那种没人看见但人人都需要的人。`;
      break;
    }

    // P-A104: horror tackle — comeback vs accept devastation (Eduardo dimension).
    case "horror_tackle:comeback": {
      const success = roll(0.25, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (-5); mods.statsMultiplier = 0.1;
      mods.addTags = [tag("compromised_body", 8)];
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (2); }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-3); }
      good = success;
      outcome = success
        ? "一年后你回来了。你进了一个球。全场起立。你跑向角旗区没有庆祝——你只是跪在草地上摸着你的脚踝。它还在。它能跑了。它能踢了。也许不是从前的那个你了——你的速度慢了，你的爆发力弱了。但你的脚踝还在。你的球还在。你还在。你回旧主的时候进了球没有庆祝——有些尊重比庆祝更重要。"
        : "一年后你回来了。但回来的你不是离开的你——你的速度不在了，你的爆发力不在了，你的射门不再是从前的射门。你踢了一个赛季——不是最好的赛季，但你踢了。你转到了另一家俱乐部。你的脚踝拼好了，但拼好的东西永远不是原来的。你想起在担架上问Gilberto「我会再踢球吗？」他没回答。现在你知道答案了——会。但「会」和「和从前一样」不是同一件事。";
      break;
    }
    case "horror_tackle:accept_devastation": {
      // P-DEGEN: 故事写「你把球鞋收进了柜子…现在你知道了——不会了」却未 forceRetire。
      // 现为真正的接受终结：forceRetire(injury) vs comeback 的赌注。
      mods.forceRetire = true; mods.forceRetireReason = "injury"; mods.dignifiedExit = true;
      good = true;
      outcome = `你接受了。你在医院床上看了你的国家在${n.continentalCup}上为你打出的横幅。你的教练把比赛献给了你。你没有上场——但你的国家记得你。\n你把球鞋收进了柜子。你的脚踝会好的——好到能走路，好到能抱孩子，好到能过正常人的生活。但不会再好了——好到能踢球。电视没有重放那个画面。你看了——在手机上，一个人看的。你看着自己的脚踝扭向不应该的方向。你关掉了手机。你不再看它了。你在医院的时候问队友「我会再踢球吗？」他没有回答。现在你知道了——不会了。但你能走路了。有些人连走路都不能了。`; break;
    }

    // P-A105: tunnel war — stand tall vs walk away (Vieira/Keane dimension).
    case "tunnel_war:stand_tall": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (!success) { mods.roleShift = -1; injury = true; }
      good = success;
      outcome = success
        ? "你没退。他也没退。你们在三米里站了十秒——十秒里没有说话，只有眼睛。然后裁判来了，你们分开了。你走上球场的时候全场在喊——不是喊你的名字，是喊两支球队的恩怨。你踢了九十分钟——你们没输。赛后你没有找他，他没找你。你们不需要说话——通道里的十秒已经说完了。十年了。十年里你们不让对方一寸。这就是你的队长——不是袖标给的，是通道里站出来的。"
        : "你没退。但你在第十二分钟被铲倒了——他的队友代他出手了。你躺在草地上看着脚踝。你想起通道里的三米。也许你应该走的——不是怕，是因为有些火不该在通道里点。你被抬下场的时候看见他看着你。他的表情不是得意——是遗憾。也许他也不想这样。但你们都不让。谁都不让。这就是代价。";
      break;
    }
    case "tunnel_war:walk_away": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你转身走了。你没有回应他——你走进更衣室坐了下来。你的队友看着你——不是失望，是不解。你队长怎么会不回嘴？你说「通道不是我们的战场。球场才是。」\n你走上球场的时候全场在喊。你进了一个球——你跑到角旗区看着他的方向。你没有庆祝。你只是看着他。他看着你。你们什么也没说。但你们都知道——球场里的回应比通道里的嘴更响。你用进球回了他的通道。"
        : "你转身走了。但你走的时候感觉——你退了一步。你退了一步他知道你退了。你走上球场的时候感觉自己轻了一截——不是身体轻了，是心里少了什么。你踢了一场平庸的比赛。赛后你想起通道里的三米——也许你该站住的。也许队长不让步不是选择——是本分。你让了。他没让。你知道了。";
      break;
    }

    // P-A106: Panenka — chip (Hakimi dimension). The calmest penalty in history.
    case "panenka:chip": {
      const success = roll(0.55, "positive");
      if (success) { mods.nationalTournamentParticipation = "force"; }
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? `球飞向空中。慢。太慢了。门将扑向左边——球在中间。球落地。弹进了网。\n全场塌了。你跑向角旗区跳了一支舞——你笑了。你对着看台鞠了一躬。你踢的是${n.nation}——那是你心里的国家。你进了四强——${n.nation}从来没有走过这一步。整个${n.continent}都在看着这一步。你不是一个人在踢球——你带着一整个大陆在踢。勺子点球。最冷静的选择。也许太冷静了——但冷静就是你的武器。`
        : "球飞向空中。慢。太慢了。门将没有扑——他站住了。他接住了。你看着球在他手里，你的脸是热的。你选了最自信的方式——也最危险的方式。它没有进去。你的队友看着你——不是怪你，是不敢看。你跪在点球点上想：为什么选了勺子？也许你想太多了。也许你太想表现得冷静了。也许冷静不是装出来的——真的冷静不需要勺子。";
      break;
    }

    // P-A107: silent fall — fight for life (Foé dimension).
    case "silent_fall:fight_for_life": {
      // 你挥了手「我没事」——把命压在场上。两种结局都终结生涯（心脏状况），
      // 区别是你能不能活着走出球场。forceRetire 接上原先缺失的机械结局。
      const success = roll(0.3, "positive");
      mods.forceRetire = true; mods.forceRetireReason = "injury";
      if (!success) severe = true; else mods.addTags = [tag("fan_darling", 6)];
      good = success;
      outcome = success
        ? "你撑过了那几分钟。终场哨响你倒在场边——但你还活着。医生说你有一处先天性肥厚，你不能再踢了。你活着走出球场，比大多数在这个名单上的人都幸运。你的国家给了你勋章。你抱着你的孩子，想起第七十二分钟草地靠近的那一刻——你赢了。不是赢了比赛，是赢了活着。"
        : `你没有撑过去。你倒在了中圈，没有人碰你。队友跪了一整分钟，全场在哭。你的俱乐部退役了你的号码，你的国家给了你国葬，一条路以你的名字命名。你${n.ageCn}岁。你坚持上场——你总是坚持的。也许这一次你不该坚持的。但你不会知道了。你只知道你爱踢球。你死在了你爱的地方。`; break;
    }
    case "silent_fall:ask_off": {
      // 举手示意换下——把命攥在自己手里。大概率安全退场（生涯仍终，但走着出去），
      // 小概率教练挥手让你再撑一会，你当场倒下被救回。两种都活着。
      const safe = roll(0.85, "positive");
      mods.forceRetire = true; mods.forceRetireReason = "injury"; mods.dignifiedExit = true;
      good = safe;
      outcome = safe
        ? "你举起了手。教练立刻把你换下——他看见了你的脸。赛后医生把你送去检查：先天性肥厚。你不能再踢了。但你走着出了球场，回家抱住了你的孩子。你赢了——不是赢了比赛，是赢了活着。"
        : "你举起了手，但教练挥了挥：「再撑一会。」你又跑了两步，然后草地飞来。你醒来在医院——队医说你差一点没救回来。你的心脏不允许你再踢了。但你活着。这一次你活着，是因为你举了手——哪怕他没听。"; break;
    }

    // P-A109: uncrowned — keep wandering vs settle down (Quintero dimension).
    case "uncrowned:keep_wandering": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? `你继续找了。你在${n.club}找到了家。教练对你像父亲一样。你在${n.continentalClubCup}决赛进了一个球——从禁区外。你把它纹在了小腿上。也许你成不了那种传奇。但你在你属于的地方成了英雄。天才不需要站在最大的舞台上才算天才——天才只需要找到那个欣赏它的地方。你找了十年，终于找到了。`
        : "你继续找了。但每个地方都住不长——你在一个联赛踢了一年又走了，在另一个拿了最高薪又走了，在第三个三进三出。你的天才还在——你的左脚还能踢出世界波。但你的行李箱越来越旧了。也许天才不需要家。也许有些人注定是流浪的——他们在每个地方留下一个世界波，然后离开。";
      break;
    }
    case "uncrowned:settle_down": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你停了。你选了一个地方——不是最大的，但是最懂你的。你的教练说「我不需要你跑——我需要你创造」。你在那里踢了最好的足球。也许你不是世界最佳。但你在一个地方成了传奇。那个地方的人把你纹在身上。你不再搬家了。你终于可以打开行李箱了。"
        : "你试着停了。但你停不下来——你的天才像一只不安分的鸟，它想飞。你在一个地方待了三个月就想走了。也许有些人不适合定居。也许你的天才就是你的流浪——它是你唯一不变的东西。你叹了口气，又收拾了行李箱。";
      break;
    }

    // P-A110: charm striker — keep scoring ugly vs try beautiful (Giroud dimension).
    case "charm_striker:keep_scoring_ugly": {
      const success = roll(0.65, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你继续用丑陋的方式进球。头球、挡射、捡漏——没有一个是漂亮的。但它们进了。赛季末你成了国家队最靠得住的那个射手。没有一个球进过集锦。但进了就是进了。\n记者问你「你怎么看待那些说你不够好的话？」你说「我不需要够好。我需要进球。」你笑了——你的笑容比你的进球漂亮。也许这就是为什么他们叫你「魅力射手」。不是因为你进球漂亮——是因为你让不漂亮看起来可以接受。"
        : `你继续用丑陋的方式进球。但你的进球数在降——你${n.ageCn}了，你的腿跟不上了。你还在场上——不是因为你是最好的，是因为没有人比你更会站在正确的地方等球。也许你不够好。也许进了那么多球就够好了。也许「够好」不是你能决定的——是你踢完了，他们看着那串数字说「够了」。`;
      break;
    }
    case "charm_striker:try_beautiful": {
      const success = roll(0.25, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      outcome = success
        ? "你试着进漂亮的球了。你练了倒钩、凌空、远射。你进了几个——它们确实漂亮。但你发现：你为了进漂亮球，少了不漂亮球。你的总数降了。也许漂亮和不漂亮不能同时要。也许你就是那个不漂亮但进球的人。你回去了。"
        : "你试着进漂亮的球了。但你的脚不是那种脚——你花了整个赛季练凌空，但你的凌空还是比不上青训营里那个孩子。你的不漂亮球也没了——你为了练漂亮忘了怎么不漂亮。你想起那个教练说的「你没有踢精英联赛的水平」。也许他说得对——但你进的球都在记分牌上。你不知道哪个才是真的。";
      break;
    }

    // P-A111: too much passion — keep caring vs calm down (Bruno Fernandes dimension).
    case "too_much_passion:keep_caring": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你继续在乎。你继续挥舞手臂，继续对裁判说话，继续在更衣室里比任何人大声。赛季末你助攻21次——联赛纪录。你赢了足总杯。那个说你「抱怨太多」的人改口了——他说「我错了」。你没改。你没冷静下来。你只是用冠军堵住了他的嘴。也许在乎太多是缺点。但你的21次助攻也是因为你在乎太多。也许溢出来的不只是情绪——还有创造力。"
        : "你继续在乎。但你的第三张红牌来了——又是两黄变一红。你在更衣室里看着手机上那些说你「petulant」的评论。你的队友不说话——他们不知道该说支持你还是说冷静点。也许你该冷静的。也许在乎太多在赢的时候是「热情」，在输的时候是「抱怨」。你不知道哪个是真的你——也许两个都是。";
      break;
    }
    case "too_much_passion:calm_down": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你学会了沉着。你没有不再在乎——你只是不再让人看到你在乎。你把热情从手臂上收回到了心里。你的红牌少了。你的数据没变——你的助攻还在。你的队友说你「成熟了」。你不知道这是成熟还是你失去了一部分自己。也许两者都是。也许成长就是学会把火从外面搬到里面。"
        : "你试着冷静了。但冷静的你不是你——你在场上不再挥手臂了，但你也不再跑那额外的十米了。你的激情和你的跑动是同一条绳子上的两端。你拉住了一头，另一头也跟着停了。你的数据降了。也许你该回去在乎太多的。也许有些人不适合冷静——也许他们的火就是他们的引擎。";
      break;
    }

    // P-A112: the wall — organize vs tackle more (Rúben Dias dimension).
    case "the_wall:organize": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? "你选择了组织。你的抢断数据不是联赛最高——但你的球队失球数是联赛最低。你的队友说「有他在后面我敢前压」。你的教练说「他让身边的人做出更好的决定」。赛季末球队踢出了近年最好的一季。你不是最亮的——你是最暗的。你看不见光，但你能感觉到安全。也许这就是最好的防守：不是挡住球——是让球放弃来。"
        : "你选择了组织。但你的队友不听你的——他们比你大比你老比你有名。你告诉他们该往哪走，他们看着你，然后自己走了。也许组织需要的不只是嘴巴——需要尊重。你没有尊重。你只有对的位置。也许下个赛季他们会听的。也许要等赢一次。";
      break;
    }
    case "the_wall:tackle_more": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      if (!success) mods.addTags = [tag("compromised_body", 3)];
      good = success;
      outcome = success
        ? "你选择了抢断更多。你的数据上去了——抢断、拦截、解围都是你的。你拿到了月最佳。但你的球队失球数没有降——你忙着抢球的时候没有人组织防线。也许数据不是目的。也许最好的防守不显示在数据里。也许它显示在失球数为零的记分牌上。你回去了。"
        : "你选择了抢断更多。但你的膝盖在第十二次铲球后开始抗议了。你坐在治疗台上想：也许你不该追数据的。也许你的价值不在抢断——在组织。也许让球放弃来比挡住球更难。但你已经追了——你的膝盖付出了代价。也许你该回去组织的。也许你从来就不需要证明。也许零失球就是你的证明。";
      break;
    }

    // P-A130: the pivot — accept role (Rodri dimension).
    case "the_pivot:accept_role": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.5;
      good = success;
      outcome = success
        ? "你接受了。你不进球——你让进球发生。你不抢断——你让球回到你脚下。赛季末你拿了赛季最佳——多少年来第一个防守型中场。你在受伤后举起了奖杯——一个不能踢球的人赢了最佳球员。也许这就是枢纽的定义：你不需要在场——你不在的时候，他们才知道你有多重要。"
        : "你接受了。但接受一个不闪光的角色在闪光的世界里是孤独的——你的队友进球了上头条，你组织了不上。赛季末你没有金球——你有一个安静的赛季。也许安静就够了。也许枢纽的价值不是奖杯——是球队在你不在的时候崩盘了。他们崩了。你现在知道你有多重要了。";
      break;
    }

    // P-A131: child prodigy — stay grounded vs embrace hype (Yamal dimension).
    case "child_prodigy:stay_grounded": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? `你记住了304。每次进球你比出那个手势——你长大那条街的邮编。你的祖母在电视前哭了。你没有忘记你从哪里来——一个工人区，一个移民家庭，一个走了很远的路才把你带到这里的祖母。也许这就是为什么你${n.ageCn}岁就站在${n.continentalCup}的决赛场上——因为你知道赢意味着什么。也许神童不在于年龄——在于你记得你是谁。`
        : `你记住了304。但记住有时候也意味着沉重——你${n.ageCn}岁就背着整条街的期望。每次上场你不仅仅在踢球——你在代表那个邮编。也许这个重量太重了。但你继续踢——因为它在你身后推着你。`;
      break;
    }
    case "child_prodigy:embrace_hype": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -1);
      if (!success) mods.addTags = [tag("compromised_body", 2)];
      good = success;
      outcome = success
        ? `你享受了一切。你的名字上了每个头条——「每五十年一个的现象」。你${n.ageCn}岁就打进了${n.continentalCup}的决赛。也许享受不是错的——也许你只是在你该享受的年纪享受。也许五十年后会有另一个你——但此刻只有你。`
        : `你享受了一切。但享受的代价来了——你在训练中开始分心，你在社交媒体上花了太多时间。你的教练说「你才${n.ageCn}岁——你的巅峰还没到。」你笑了——也许你不需要巅峰。也许你已经到了。但你的身体不同意——你在一场比赛中拉伤了。也许享受需要休息。也许神童也需要长大。`;
      break;
    }

    // P-A132: conquering arrival — fill legend boots vs humble start (Bellingham dimension).
    case "conquering_arrival:fill_legend_boots": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? `你穿上了传奇的鞋。你在前四场进了四个——追平队史纪录。你在德比里绝杀了${n.derbyClub}。你的教练说你「像一个老将」。你${n.ageCn}岁。\n赛季末你拿了${n.league}最佳球员。你偶像的海报还在你妈妈家的卧室里——但你现在在${n.club}的主场踢球。也许偶像的意义不是你变成他——是你站在他站过的地方，做你自己的事。`
        : "你穿上了传奇的鞋。但鞋太大了——你在追平C罗的期待中踢得太用力了。你在第五场没进球，第六场也没进。媒体说「他不过是昙花一现」。你知道你不是——但你不知道怎么证明。也许你不需要追平任何人。也许你只需要在下一场进球。一场就够了。一场一场来。";
      break;
    }
    case "conquering_arrival:humble_start": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      outcome = success
        ? `你没有追平那个纪录。你在前四场只进了一个——一个就一个。你的教练说「他不急。」你不急。你才${n.ageCn}岁——你有所有的时间。赛季末你进了十二个——不是纪录的数，但够了。也许做自己的事比追平传奇更难——因为做自己的事没有参照物。但你做了。`
        : `你试着不追那个纪录。但媒体不接受「不追」——他们要你追。每场都在比。你在一百年的阴影里踢球。也许做自己的事需要的不只是勇气——需要一个不在乎的环境。${n.club}不在乎——它只在乎你进不进球。`;
      break;
    }

    // P-A133: ACL prodigy — comeback vs fear (Wirtz dimension).
    case "acl_prodigy:comeback_stronger": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (-5); mods.statsMultiplier = 0.1;
      mods.addTags = [tag("compromised_body", 6)];
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (4); mods.leagueTrophyProbabilityMultiplier = 1.5; }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-2); }
      good = success;
      outcome = success
        ? "你回来了。第二个赛季你赢了一切——联赛冠军、杯赛冠军、赛季最佳。你在夺冠那天进了帽子戏法。你在最好的年纪撕裂了十字韧带——十个月后你站在领奖台上。也许十字韧带没有拿走你的天赋——它只是让你等了一下。也许等待让你更好。也许痛苦是天才的学费。"
        : "你回来了。但你不是那个少年破纪录的你了——你的速度慢了半步，你的变向多了一丝犹豫。你踢了一个还行的赛季——不是最好的，但你在场上。也许这就是你新的最好。也许你不会再破纪录了——但你在踢球。在十字韧带之后，在场就是胜利。";
      break;
    }
    case "acl_prodigy:fear_reinjury": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你保护了自己。你减少了突破，减少了对抗——你用传球代替了盘带。你的数据降了但你的膝盖活了。你会比同代人多踢好几年。也许保护自己不是怕——是聪明。也许有些天赋需要保护才能持久。"
        : "你保护了自己。但保护变成了逃避——你不再突破，不再对抗，不再是你。你的教练说你「变了」。你变了——因为你怕。怕不是错的——但怕让你不踢球了。你坐在板凳上想：也许你该信自己修复过的膝盖的。也许它比你以为的更强。";
      break;
    }

    // P-A134: puppet master — find space vs add goals (Xavi dimension).
    case "puppet_master:find_space": {
      const success = roll(0.65, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.4;
      good = success;
      outcome = success
        ? "你继续找空间了。一整天。每场比赛。你的传球成功率91%——你传了几百脚球只丢了9%。你不进球——你让进球发生。赛季末球队什么都在争。你的队友说跟你踢球「像坐旋转木马」。对面的老帅说你不丢球。你笑了——你丢过。但你丢的时候球已经在下一个空间了。如果足球是一门科学，你发现了公式。"
        : "你继续找空间了。但对手开始研究了——他们封住了你常找的空间。你试着找新空间——但599脚传球的时代过去了。你用更少的传球做同样的事。也许效率不是退步——是进化。也许少即是多。";
      break;
    }
    case "puppet_master:add_goals": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (!success) mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你练了射门。你的进球数涨了——从每季3个到每季8个。但你的助攻降了——你在射门的时候没有在传球。也许你找到了一种新的方式——也许进球和传球不需要二选一。也许你能同时做到。"
        : "你练了射门。但你的射门不够好——你花了一个赛季练射门，传球却钝了。你不再是那个一场传几百脚球的人了——你变成了一个不太会射门也不太会传球的人。也许你不该改的。也许有些人的天赋就是传球——不需要进球来证明。也许你就是你。";
      break;
    }

    // P-A135: overused prodigy — say no vs play everything (Pedri dimension).
    case "overused_prodigy:learn_to_say_no": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      if (!success) mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你说了不。你拒绝了奥运会的征召——你的俱乐部松了一口气。你的赛季缩短到了50场。你用省下来的时间练了核心力量和恢复。下个赛季你踢了40场——没有受伤。也许说不不是怕——是聪明。也许天赋需要保护才能持久。也许七十三场的教训就是：十八岁不应该踢七十三场。"
        : "你说了不。但说不的代价是——国家队教练不高兴了，媒体说你「不爱国」。你在下个赛季被放上了板凳——不是因为你不够好，是因为你说了不。也许说不需要勇气——但勇气的代价有时候是出场时间。也许你需要更聪明地说不。";
      break;
    }
    case "overused_prodigy:play_everything": {
      const success = roll(0.25, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      if (!success) { mods.addTags = [tag("compromised_body", 8)]; injury = true; mods.statsMultiplier = 0.5; }
      good = success;
      outcome = success
        ? `你踢了七十三场。你${n.ageCn}岁——你恢复了。赛季末你拿了奥运会银牌。你的腿没有断——这一次没有。但你的教练看着你的医疗报告说「你下次不一定这么幸运」。也许你这次赢了——但也许你在透支未来的身体。也许${n.ageCn}岁的七十三场会在二十八岁还债。`
        : `你踢了七十三场。然后在第八分钟你的腿筋断了。你坐在更衣室里看着你的腿——${n.ageCn}岁的腿，七十三场比赛的腿。你的赛季结束了。也许你不是铁做的。也许年轻不是无敌的。也许你的天赋是有限的——而你在七十三场比赛里把它花了一半。`;
      break;
    }

    // P-A136: penalty redemption — come back vs never again (Saka dimension).
    case "penalty_redemption:come_back_stronger": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你回来了。下个赛季你是球队最佳——连续两年，比肩那些名字。世界杯你进了三个球。然后在四分之一决赛——又有点球大战。你站在球前。你当年罚失的那个球还在你的脑子里。\n你起脚了。球进了。你闭上了眼睛——不是为了庆祝，是为了把当年的那个你和此刻的你放在了一起。你从罚失到罚进走了三年。也许救赎不是一个球——是三年里你没有逃避。"
        : "你回来了。但那个罚失还在你脑子里——每次站在点球点前你都会看到Donnarumma的手套。你没有逃避——但你也没有完全回来。你踢了一个好赛季，但不是最好的。也许救赎不是一下子发生的——它一点一点来。也许下一次。";
      break;
    }
    case "penalty_redemption:never_again": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你不再罚点球了。你的队友替你罚——你没有问题。你的赛季依然好。也许不罚点球不是逃避——是知道自己怕什么。也许有些创伤需要时间，不是勇气。也许你会在很多年后再罚一个——也许到那时候你准备好了。"
        : "你不再罚点球了。但「不再罚」变成了「不再面对」——你开始回避所有高压场景。你的教练说你「变了」。你变了——因为当年全国看着你失败。也许你需要面对的不是点球——是当年那个你。也许你该告诉那个孩子：不是你的错。";
      break;
    }

    // P-A137: late bloomer — seize moment (Emi Martinez dimension).
    case "late_bloomer:seize_moment": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.5;
      good = success;
      outcome = success
        ? `你抓住了。世界杯四分之一决赛你扑了两个点球——你对对手说垃圾话，你让他们笑——但你赢了。决赛你扑了一个单刀。你赢了金手套。你赢了世界冠军。你${n.ageCn}岁才真正开始——有些人这个岁数已经退役了。你等了十年——但你在等的时候没有放弃。也许大器晚成不是迟到——是在正确的时刻准备好了。`
        : "你抓住了。但这一刻太大了——你在世界杯决赛上紧张了。你扑出了一个但漏了两个。你没有赢金手套。但你站在了那里——一个等了十年的人站在了世界杯决赛的球门前。也许站在那里就够了。也许你不需要金手套——你需要的是不再等了。";
      break;
    }

    // P-A138: flickering star — keep fighting vs accept new self (Chiesa dimension).
    case "flickering_star:keep_fighting": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? `你继续了。你在9月当选了月最佳——在黑暗里待了两年后。你进了${n.league}首球——第88分钟，4-2。也许你不再是当年那个横扫一切的人了。但你还在踢。你还在进球。余烬不是火灭了——是火变小了但没灭。你用更小的火照亮了更近的路。也许这就是够的。`
        : "你继续了。但你还在黑暗里——月最佳没有来。你踢了20场，没有进球。你的教练说你「在找自己」。也许你在找的不是当年的你——他在某块客场的草地上留了一条十字韧带。也许你在找的是一个你还没见过的人。也许你需要更长时间。也许余烬需要更多风才能重新烧起来。";
      break;
    }
    case "flickering_star:accept_new_self": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你接受了。你不再是从前的你——但新的你也有价值。你从主力变成了轮换——但你是一个好的轮换。你在关键时刻上场，你贡献了。也许你不再是那个身价的人——但你是现在这个身价里最好的那个。也许接受不是放弃——是找到了另一种活法。"
        : "你接受了。但接受变成了解释——每次你表现不好你都说「我受过伤」。也许有一天你需要停止解释——也许你该就是踢。不管是从前的你还是新的你。也许接受不是终点——是起点。也许你需要先接受才能重新开始。";
      break;
    }

    // P-A139: two brothers — play for Spain vs parents' land (Williams dimension).
    case "two_brothers:play_for_spain": {
      const success = roll(0.6, "positive");
      mods.nationalTournamentParticipation = "force";
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? `你选了${n.nation}。${n.continentalCup}决赛你进了第一个球。你赢了。你哥哥在另一块大陆看着你——他选了父母的祖国，你选了${n.nation}。你们永远不会在国际赛场上并肩。但你们在各自的国家队里做同样的事：踢球。也许选择不是分开——是各自走自己的路然后在终点等对方。也许你们的父母走那条路就是为了这一刻——两个儿子各自发光。`
        : `你选了${n.nation}。但你没有在决赛进球——你坐在替补席上看着队友赢了。你哥哥发来消息：「恭喜。」你回了：「谢谢。」也许选择不是关于赢——是关于你代表谁。也许你代表的是你父母用脚走完那条路换来的那个家。`;
      break;
    }
    case "two_brothers:play_for_parents_land": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      mods.nationalTournamentParticipation = "force";
      good = success;
      outcome = success
        ? `你选了父母的祖国。你和哥哥终于并肩了——在国际赛场上。也许${n.nation}更强，也许你选了更难的路。但你看着哥哥的脸——你们第一次穿同样的球衣。也许来路比去路更重要。也许你不该忘记你的父母赤脚走完那条路是为了让你有选择。你选了他们来路那边的国家。也许这不是选择——是回家。`
        : `你选了父母的祖国。但那里没有你想象的好——你坐了三场板凳，第四场才上场。你哥哥说「这里不是${n.nation}。」你说「我知道。」也许选择更难的路不是勇敢——也许只是难。但你穿着那件球衣——你父母的祖国的颜色。也许这就够了。`;
      break;
    }

    // P-A140: dance through storm — keep dancing vs stop (Vinícius dimension).
    case "dance_through_storm:keep_dancing": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? `你继续跳了。赛季末你进了一堆球——你每次进球都跳。他们嘘你——但你跳得更大声了。你被联合国机构任命为亲善大使——史上第二个足球员。你家乡的城市为你亮了一夜的灯。也许跳舞不是挑衅——是你的回答。也许你从${n.nation}那条街走到${n.club}就是为了跳舞给全世界看。也许有些战斗不需要拳头——需要的是一只跳舞的脚。`
        : "你继续跳了。但26次歧视的重量压在你身上——你开始在训练中分心了。你的数据没有崩——但你的人崩了。你的心理咨询师说你需要休息。也许跳舞需要力气——而你的力气被26次猴子叫抽走了。也许你需要的不是更大的舞——是一群人和你一起跳。";
      break;
    }
    case "dance_through_storm:stop_dancing": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      good = success;
      outcome = success
        ? "你安静了。你进球后不再跳了——你只是走回中圈。他们不嘘了——但你觉得更安静了不是更好。也许安静不是妥协——是换了一种方式战斗。也许有些战斗不需要舞——需要的是沉默的坚持。也许你会在某一天再跳——当那天来的时候，你会跳得更大声。"
        : "你安静了。但安静没有换来尊重——他们找到了新的理由骂你。你的教练说你「失去了火花」。你看着镜子——也许你该继续跳的。也许安静不是答案——也许你的舞不是给骂你的人看的，是给你自己看的。也许你停止跳舞的那一刻你就输了。也许你该回去跳。";
      break;
    }

    // P-A141: the bull who stayed — stay captain vs chase bigger (Lautaro dimension).
    case "the_bull_stayed:stay_captain": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.5;
      good = success;
      outcome = success
        ? `你留下了。${n.careerOutput}个${n.outputLabel}。队长袖标。你的进球数又一次领跑——联赛和杯赛都打到了最后。你在${n.club}的历史射手榜上一路往前挪。他们说「团队目标比我的纪录更重要」——你说的。也许留下不是不敢走——是不需要走。也许传奇不是在哪里踢——是在一个地方踢了多久。你年轻时说不——因为你没准备好。${n.ageCn}岁说不——因为你已经在这里了。`
        : `你留下了。但留下的代价是——你看着同龄人去了更大的俱乐部，赚了更多的钱，捧起了${n.continentalClubCup}。你赢了联赛——但你没赢${n.continentalClubCup}。也许留下需要的不只是忠诚——需要耐心。也许双冠就够了。也许有一天${n.continentalClubCup}会来的。也许来的时候你还在。`;
      break;
    }
    case "the_bull_stayed:chase_bigger": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (!success) mods.roleShift = -1;
      good = success;
      outcome = success
        ? `你走了。你去了更大的俱乐部。你第一个赛季就赢了${n.continentalClubCup}。你看着你的新球衣——它比${n.formerClubOr}的更亮。但你在那里的${n.careerApps}场比赛不会消失。也许走不是背叛——是成长。也许有些传奇是在一个地方铸成然后带走的。`
        : `你走了。但你在大俱乐部没有位置——你从队长变成了替补。你坐在更衣室里想：也许你不该走的。也许你那些${n.outputLabel}不够换来一个新位置。也许你该回去的——但${n.formerClubOr}的球迷已经烧了你的球衣。也许有些门关了就关了。`;
      break;
    }

    // P-A142: the jewel — accept good vs chase one more (Dybala dimension).
    case "the_jewel:accept_good_not_great": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? `你接受了。${n.careerOutput}个${n.outputLabel}，${n.careerApps}场比赛——这不是失败的生涯。这是一段非常好的生涯。也许不是每个人都要成为那种传奇。也许成为${n.name}就够了。也许明珠的价值不在大小——在稀有。你停下了——不是因为你不能追了，是因为你不需要追了。你知道你是谁。`
        : `你接受了。但接受有时候是给自己找台阶——你想起${n.formerClubOr}不续约那天你发的社交媒体，第78分钟被换下时全场起立鼓掌。也许接受不是放下——是放过了自己。也许有些生涯不需要伟大来证明值得。`;
      break;
    }
    case "the_jewel:chase_one_more": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (!success) mods.addTags = [tag("compromised_body", 4)];
      good = success;
      outcome = success
        ? `你追了。你去了新俱乐部，你用了半年找状态，然后你在下半赛季进了12个球。你${n.ageCn}岁了——你不再被叫「下一个天才」了。他们叫你「老狐狸」。也许你追到了——不是追到了那个传奇的高度——是追到了你自己的高度。也许差一步不是永远差一步——是差一步然后多走了一步。`
        : `你追了。但你的膝盖不让你追了——你在第三场比赛拉伤了，缺阵三个月。你${n.ageCn}岁了，身体在说「够了」。也许你该在数字最好看的时候停的。也许追的代价是少了一些已经拥有的。也许明珠不需要追——它只需要在被看到的时候闪一下就够了。`;
      break;
    }

    // P-A144: record fee — prove worthy vs drown in pressure (Caicedo dimension).
    case "record_fee:prove_worthy": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? `你证明了。50米外的进球——赛季最佳。你首发了全部38场。你赢了${n.club}赛季最佳。你在${n.continentalClubCup}的决赛进了球。也许${n.fee}不是重量——是你十个哥哥姐姐的期望。也许你不是在踢球——你是在证明一个穷孩子可以值这个价。你${n.ageCn}岁。你的巅峰还没到。但你的回答已经到了。`
        : "你试了。但你的第一个赛季只有3个助攻——没有进球。媒体说「水货」。你说你是天价新援——他们不笑了，他们认真了。也许证明需要时间——不是每一段传奇都在第一年写成。也许你下个赛季会好。也许你需要忘记那个数字——你只是踢球的。";
      break;
    }
    case "record_fee:drown_in_pressure": {
      const success = roll(0.2, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 4 : -3);
      if (!success) mods.addTags = [tag("compromised_body", 3)];
      good = success;
      outcome = success
        ? `你承认了——太重了。你告诉教练你需要休息。你缺了一周。你回来的时候轻松了一点——也许不是轻松了，是不那么紧了。也许承认不是软弱——是知道自己什么时候需要喘气。也许${n.fee}的重量不是一个人扛的。`
        : `你扛不住了。你在训练中分心，在比赛中犹豫——你的教练说你「像在害怕」。你在板凳上看着比你便宜的球员踢你的位置。也许有些重量不是用肌肉扛的——是用脑子。也许你需要有人帮你。也许${n.fee}的代价不是你的——是别人放在你身上的。`;
      break;
    }

    // P-A145: Georgian pioneer — carry nation vs just play (Kvaratskhelia dimension).
    case "georgian_pioneer:carry_nation": {
      const success = roll(0.5, "positive");
      mods.nationalTournamentParticipation = "force";
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? `你扛了。${n.nation}第一次打进了${n.continentalCup}——你对${n.rivalNation}进了球。全世界的电视台说你「改变了${n.nation}的生活」。你的身价一路涨到了${n.fee}。你在${n.continentalClubCup}的决赛进了球。也许先驱不是第一个踢球的人——是第一个让全世界看到的人。也许你的盘带不只是过人——是在告诉世界${n.nation}在哪里。`
        : `你扛了。但${n.nation}太小了——你的队友不够强，你在场上一个人扛不过十一。你没有出${n.continentalCup}的小组赛。但你的名字上了世界头条——${n.nation}上了世界头条。也许扛着不是赢——是让世界看到。也许你不需要赢球来赢尊重——你只需要上场。`;
      break;
    }
    case "georgian_pioneer:just_play": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? `你只是踢球了。你不扛——你踢。你的盘带过人不是为了${n.nation}——是为了赢。但也许这就是最好的「扛」——因为你踢得好了，${n.nation}自然被看到了。也许先驱不需要扛旗——只需要走在他自己的路上。也许你走得好，旗帜自然就举起来了。`
        : `你只是踢球了。但「只是踢球」没有让${n.nation}被看到——也许你需要扛才有人注意。也许先驱不只是一个好球员——是一个愿意说「我来自${n.nation}」的好球员。也许你不需要扛——但也许你需要回头看看你身后的人。`;
      break;
    }

    // P-A146: glass genius — find stability vs accept fragility (Dembélé dimension).
    case "glass_genius:find_stability": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 5 : -4);
      if (success) { mods.leagueTrophyProbabilityMultiplier = 1.5; mods.overallDelta = (mods.overallDelta ?? 0) + (2); }
      else { mods.addTags = [tag("compromised_body", 6)]; injury = true; mods.statsMultiplier = 0.4; mods.overallDelta = (mods.overallDelta ?? 0) + (-3); }
      good = success;
      outcome = success
        ? `你找到了安定。当了父亲。结了婚。生涯最好的一个赛季，球队什么都在争。也许玻璃不是碎了——是在正确的时刻被粘好了。也许天赋需要的不只是一双好腿——需要一个让你安定的理由。你从破纪录的身价到被半价卖掉再回到${n.fee}——也许你的生涯不是一条直线——是一个U型。也许最低点不是终点——是粘合的地方。`
        : "你试了。但安定没有来——你的腿筋又断了。第三次。你在芬兰的手术台上看着天花板想：也许你的身体就是这样。也许天赋不是无限的——也许你的天赋和你的腿筋是同一根绳子上的两端。你拉住一头——另一头断了。你坐在病床上看着你的女儿的照片——也许你该为了她接受的。";
      break;
    }
    case "glass_genius:accept_fragility": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你接受了。你减少了出场——20场而不是40场。你在场上只踢60分钟然后下来。你的数据降了但你不再断了。也许接受不是放弃——是找到了一种和你的身体共处的方式。也许玻璃天才不需要每场都闪——只需要在对的时刻闪。"
        : "你接受了。但接受变成了不上场——你从天才变成了替补。你的教练说「他不会来了」。也许你该在找到安定之前不接受——也许接受太早了。也许你的身体还没有说完它的话。也许你该再试一次——不是为了证明什么，是为了不后悔。";
      break;
    }

    // P-A147: favela redemption — prove them wrong vs take money (Raphinha dimension).
    case "favela_redemption:prove_them_wrong": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.5;
      good = success;
      outcome = success
        ? `你证明了。帽子戏法——对${n.bigClub}。德比——在${n.derbyClub}的主场。你追平了一项${n.continentalClubCup}的纪录。你在${n.club}进的球一路往队史前面挪。${n.league}最佳球员。你亲吻了队徽。也许被拒绝不是终点——是起点。也许每一个「不要你」都是一颗种子。你从贫民窟到亲吻${n.club}的队徽——也许这条路不需要被接受——需要的是自己走完。`
        : "你试了。但你成不了那种传奇——你追了没追上。你进了很多球——但没有追上那个纪录。你的教练说你「好」。你没有要「好」——你要「最好」。也许「好」就是你这条路的「最好」。也许贫民窟的孩子不需要追平谁——他只需要踢出自己的最好。";
      break;
    }
    case "favela_redemption:take_money": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? `你拿了那笔钱。你去了一个只谈数字的联赛。你进了30个球。你的家人再也不用住一间卧室了。也许够了——也许「够了」不是一个贬义词。也许从贫民窟走到这一步就是传奇。也许你不需要在${n.club}亲吻队徽来证明——你只需要让你的家人不再饿肚子。`
        : `你拿了那笔钱。你去了一个只谈数字的联赛。但你在第一场就伤了——你的身体在说「这里不是${n.club}」。你坐在陌生的更衣室里想：也许你不该走的。也许那笔钱买不到你在${n.club}主场进球的感觉。也许有些东西比钱贵——但你的家人需要那笔钱。也许这就是代价。`;
      break;
    }

    // P-A148: firecracker — come back burning vs dial back (Gavi dimension).
    case "firecracker:come_back_burning": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      if (!success) { mods.addTags = [tag("compromised_body", 6)]; injury = true; mods.overallDelta = (mods.overallDelta ?? 0) + (-3); mods.statsMultiplier = 0.4; }
      good = success;
      outcome = success
        ? "你回来更亮地烧了。你戴上了Pedri给你的袖标。你在国家德比又和Vinícius对峙了——你的膝盖撑住了。也许火药桶不是最耐用的——但它在爆炸的时候最亮。也许348天没有拿走你的火——只是让它等了一下。也许你的膝盖不是铁做的——但你的心是。"
        : "你回来烧了。但太亮了——你的膝盖在第三场又裂了。第二次大伤。22岁之前两次ACL。你坐在病床上想：也许你不该这么亮的。也许火药桶需要保护它的壳——因为壳碎了就没有火了。也许你需要学会有时候不烧——为了更久地烧。";
      break;
    }
    case "firecracker:dial_back": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : 0);
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你收敛了。你减少了对抗——你不再和每个前锋对峙了。你的数据降了但你的膝盖活了。你踢了38场——第一次全勤。也许收敛不是变弱——是变聪明。也许火药桶学会控制火药量——是为了烧更久。也许你不需要每场都亮——只需要在关键场亮。"
        : "你收敛了。但收敛让你不开心——你上场的时候少了那把火。你的教练说你「变了」。你变了——因为你怕。怕不是错——但怕让你不是你了。也许你需要回去烧的——但带着一个更聪明的方式。也许火药桶不能收敛——它只能学会什么时候炸。";
      break;
    }

    // P-A113: the godfather — die on pitch vs push back (Conte dimension).
    case "the_godfather:die_on_pitch": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? "你为他死了。你跑了你从未跑过的距离，你铲了你从未铲过的球。赛季末你赢了冠军——积分纪录。他在更衣室里没有笑——他说「这是应该的」。你看着他，想起他第一天说的「停止做个废物」。你不觉得他在骂你——你觉得他在叫醒你。也许有些教练不需要让你喜欢他——只需要让你不敢辜负他。"
        : "你为他死了。但你不知道你是在为球队死还是为他死。你跑了全队最多的距离，但你不知道你为什么跑。也许是冠军。也许是因为他让你不敢停下来。赛季末你们没赢。他走了。你坐在空更衣室里——他的话不在了。但你的腿还记得那些跑过的距离。也许那些距离不是为他跑的——是为你自己。";
      break;
    }
    case "the_godfather:push_back": {
      const success = roll(0.3, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? "你推回去了。你在训练后告诉教练「我不为你死——我为自己踢。」他看着你三秒没说话。然后他说「好。那就为自己赢。」你不知道他是在接受还是在威胁。但你留在了首发——也许他尊重敢推回去的人。也许「为自己踢」和「为球队死」不矛盾——如果你踢好了，球队就赢了。"
        : "你推回去了。但教练不接受——你被放上了板凳。你在更衣室里看着队友在场上跑。你想：也许你该听话的。也许「死在球场上」不是真的死——是拼到极限。也许极限就是他能看到的东西。你坐在板凳上想这些，赛季结束了。他走了。你还在。但你错过了一个赛季。";
      break;
    }

    // P-A114: fallen prodigy — go small vs stay fight (Jović dimension).
    case "fallen_prodigy:go_small": {
      const success = roll(0.45, "positive");
      mods.roleOverride = success ? "starter" : "substitute";
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      good = success;
      outcome = success
        ? `你去了一个小联赛。没有人认识你——他们只记得你身上那个${n.fee}的标签。但你在第一场比赛就进了球。然后一个帽子戏法。然后联赛冠军。你被评为了赛季最佳射手。你${n.ageCn}岁——那个在${n.formerClubOr}无所不能的你已经不见了。但${n.ageCn}岁的你在这座陌生的城市里找到了。也许不是${n.club}。但你在踢球。你在进球。你在笑。那个标价的你不见了。但进球的你回来了。`
        : `你去了一个小联赛。但旧日的感觉没有回来——你的膝盖还在响，你的信心还没回来。你踢了一个还可以的赛季——不是最好的，但比在${n.club}好。也许你需要更长时间。也许旧日的你永远不会回来——但新的你可以。你在陌生城市的阳光下训练，想起那个在${n.formerClubOr}一场进五个的夜晚。也许那不是你。也许你只是住在那个身体里过一段时间的人。`;
      break;
    }
    case "fallen_prodigy:stay_fight": {
      const success = roll(0.15, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.roleShift = -1;
      good = success;
      outcome = success
        ? `你留了。第三年你终于进了一个球——不是五个，是一个。但那一个球让你跪在草地上哭了。因为你等了太久。也许你不是${n.formerClubOr}那个你了。也许你只是一个在${n.club}进了一个球的人。但那一个球是你的。没有人能拿走。`
        : `你留了。但第三个赛季你没有进球。你被卖了——免费。从${n.fee}到免费。你坐在陌生的更衣室里想起当年那个夜晚。你不知道你在哪里丢了你自己——在${n.club}？在伤病里？在板凳上？也许你在${n.formerClubOr}就不该走。也许你不该来${n.club}。但「不该」不改变「已经在」。你${n.ageCn}岁。你在一个没人认识你的地方。也许那里才是你的地方。`;
      break;
    }

    // P-A115: restless prince — keep moving vs stop running (Boateng dimension).
    case "restless_prince:keep_moving": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你继续走了。第13家俱乐部。你在那里踢了六个月——然后又吵了。又走了。第14家。又是六个月。你的天赋还在——但没有人愿意签一个每六个月就走的人。你坐在又一家新俱乐部的更衣室里，看着第14件球衣。你不知道你是在找家还是在逃离。也许两者分不开。也许你的天赋需要一个家，但你的性格不允许你有家。也许这就是代价——天赋够了，但安定不够。"
        : "你继续走了。但这一次没有俱乐部要你了——你的名声太大了，不是好的那种大。你坐在家里看着电视上的比赛。你的弟弟在踢。你没有打电话给他。你们已经很久不说话了。也许你该打的。也许你该说的。也许你不知道该说什么。你看着衣柜里的14件球衣——每一件都是一段你没能留住的时光。";
      break;
    }
    case "restless_prince:stop_running": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你停了。你选了一个地方——不是最大的，不是最好的，但是它不赶你走。你签了两年合同。第一年你还是想走——你的脚痒。但你留了。第二年你开始习惯——习惯一座城市，习惯一个更衣柜，习惯队友的脸不变。也许安定不是你的天赋。但也许你可以学。也许12件球衣够了。也许第13件可以穿久一点。"
        : "你试着停了。但你的脚还在痒——每当你听到其他俱乐部的名字，你的心跳就快了。你留了一个赛季，但你心里在走。你的队友看出来了——他们说你「人在这里心不在」。也许你不适合停。也许有些人注定是流浪的——他们的家不是一座城市，是一条路。你叹了口气，又打开了行李箱。";
      break;
    }

    // P-A116: the matador — keep running vs save legs (Cavani dimension).
    case "the_matador:keep_running": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (!success) mods.addTags = [tag("compromised_body", 3)];
      good = success;
      outcome = success
        ? `你继续跑了。赛季末你35个联赛进球——生涯最高。你的队友说你「${n.ageCn}岁了跑得比二十岁还多」。你笑了——你不知道你还能跑多久。但你知道你每多跑一步就多一个进球的可能性。也许你的天赋不是进球——是跑动。也许进球只是跑动的副产品。你跑到了最后一分钟，然后假装开了机关枪。斗牛士不停。斗牛士跑到公牛累了。`
        : "你继续跑了。但你的腿在第三十场比赛后开始说了算——你的小腿在发紧，你的膝盖在响。你坐在治疗台上想：也许你不需要跑一万五千米。也许一万三就够了。但你知道少了两千米就不是你了。你的跑动是你的身份——少了它你只是另一个前锋。但你的腿不认识你的身份。你的腿只认识疼痛。";
      break;
    }
    case "the_matador:save_legs": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你少跑了。你的进球数没有降——你用位置代替了跑动，你用脑子代替了腿。你学会了站在正确的地方而不是跑向正确的地方。你的教练说你「成熟了」。你不知道这是成熟还是衰老。但你的膝盖感谢你。你多踢了两年——也许就是因为少跑了那两千米。也许少跑不是放弃——是聪明。也许斗牛士不只是用脚斗牛——也用脑子。"
        : "你少跑了。但你的进球也少了——你的跑动和你的进球是同一条绳子上的两端。你拉住了一头，另一头也跟着停了。你站在禁区内等着球来——但球不来。你不跑了之后，队友也不传给你了——他们习惯了你跑出来接球。你不跑了，他们不知道你在哪。也许你该回去跑的。也许你的脑子不够代替你的腿。也许Cavani就是Cavani——跑动就是他。少了跑动他只是另一个等球的前锋。";
      break;
    }

    // P-A117: ironic goal — score and silence (Coutinho dimension).
    case "ironic_goal:score_and_silence": {
      const success = roll(0.5, "positive");
      if (success) mods.leagueTrophyProbabilityMultiplier = 2;
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? `你进了两个球。8-2。你没有庆祝——你只是站在那里看着记分牌。你的队友冲过来抱你，但你没动。你在想：你花了他们${n.fee}，然后你帮别人打了他们8-2。足球的幽默不是每个人都能笑出来的——你笑不出来。但你进了两个。球不认主。球只知道网。你赢了${n.continentalClubCup}——在打败了买你的那个人的同一年。也许这是最好的复仇——不是愤怒，是进球。`
        : "你被换上了场。你没有进球——但你的新俱乐部还是赢了。你站在场上看着你的旧主被打败，想起你一年半前签合同时的笑容。那时候你以为是梦想。此刻你站在他们的伤口上。你没有进球，但你在那里。足球最讽刺的地方不是你进球了——是你站在那里，穿着别的球衣，看着他们输。也许在场就够了。也许被借走就是最好的回答。";
      break;
    }

    // P-A118: penalty burden — carry and lead (Southgate dimension).
    case "penalty_burden:carry_and_lead": {
      const success = roll(0.5, "positive");
      // 带着罚失的球当教练：成功则把伤口变成教导、成国家队主帅进半决赛（+1 perm + 传道者）；
      //  失败则两次决赛都输、那个球 25 年不愈（-1 perm）。原两分支都空 mods → 预览空白。
      //  与同伴 step_away 的 ±1 perm 对齐。
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      if (success) mods.addTags = [tag("mentor_legend", 6)];
      good = success;
      outcome = success
        ? `你带着那个球走了很多年。你成了教练——然后你成了${n.nation}的主教练。你带着你的国家进了世界杯半决赛。球迷唱你的名字。你的马甲成了国民现象。\n赛前训练你让球员练了一千次点球——因为你不想他们体验你体验过的。记者问你「你还记得那年吗？」你说「每一天。」你说得对——你每一天都记得。但那个球没有毁掉你——它让你成为了更好的教练。它让你知道了一个人在罚失之后需要什么。你给了你的球员你当年没有得到的东西：理解。也许这就是救赎——不是进球，是理解。`
        : `你带着那个球走了很多年。你成了教练——然后你成了${n.nation}的主教练。你带着你的国家进了两次${n.continentalCup}决赛。两次都输了。你在赛后说「作为一个骄傲的${n.nation}人，为${n.nation}踢球和执教${n.nation}是我一生的荣誉。」你辞职了。你给了你的一切。但那个球还在——它很多年前进了，它现在还在。也许救赎不是赢得什么——是带着你的伤口走到了最远的地方。你走到了决赛。两次。你输了。但你在那里。带着那个球在那里。`;
      break;
    }

    // P-A119: boy king — keep rising vs give back now (Mbappé dimension).
    case "boy_king:keep_rising": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      if (success) mods.nationalTournamentParticipation = "force";
      good = success;
      outcome = success
        ? `你继续上升了。你在下一届世界杯决赛进了三个球——帽子戏法。虽然你输了点球大战，但你进了三个球。你成了世界杯历史最佳射手。有人说你「可能成为史上最伟大的世界杯球员」。你不知道你是否会——你只知道你还年轻。你的巅峰还没有来。也许这才是最可怕的——不是你已经做了什么，而是你还没做的。你从家乡那条街走到了${n.club}。八万人来看你的亮相。你才${n.ageCn}岁。你还有时间。你有所有的时间。`
        : "你继续上升了。但上升的代价是重量——你的国家把你当成救世主。你每次上场他们期待你进三个。你进了一个他们觉得你退步了。你在赛后说「失败」——因为你给自己的标准比他们给的高。也许上升不是永远向上的——也许它有弯曲。但你在弯路上也在走。你从邦迪走到了这里。你不知道这里是不是终点——但你知道这不是起点。起点在很久以前了。";
      break;
    }
    case "boy_king:give_back_now": {
      // P-DEGEN: 「把钱全捐了」曾是零回报陷阱。安全路：稳涨 +1 perm + fan_darling（你成了全民偶像），
      // 代价是分心慈善 → roleShift −1（你的心思不在球上，顺位滑了一档）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      mods.addTags = [tag("fan_darling", 6)];
      good = true;
      outcome = `你选择回馈了。你把世界杯奖金全捐了——给帮助残障人士的慈善机构。记者问你为什么。你说「我赚得够多了。重要的是帮助需要帮助的人。」\n你${n.ageCn}岁。你稳稳地涨了一截，也成了全民偶像——只是你的心思分给了慈善，顺位悄悄滑了一档。你有所有的时间去赢更多奖杯。但不是每个人都有时间被帮助。你在你最强的时候选择了弯腰——不是因为你不够强，是因为你知道有人比你更弱。你从家乡那条街来。你知道弱是什么感觉。你不会忘记。你继续踢球——但你踢球不只为了自己了。你踢球也为了那条街上的孩子。他们看着你——就像你小时候看着自己的偶像。也许你不需要进三个球来改变世界。你只需要让他们知道：从那条街可以走到这里。`; break;
    }

    // P-A26: father-agent — independence vs trust.
    case "father_agent:assert_independence": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你说了。你父亲沉默了很久，然后点了点头。「你长大了。」他收起了合同。从那天起你开始自己做决定——有些决定很好，有些很糟，但都是你的。你第一次觉得你的职业生涯属于你自己。"
        : "你说了。你父亲站起来走了，门关上的声音比任何话都重。他再也没有来过你的比赛。你请了新经纪人，做了自己的决定——但每次签约的时候你都会想起他摊在桌上的那三份合同。独立是有代价的。";
      break;
    }
    case "father_agent:trust_father":
      // P-DEGEN: 「听父亲的」曾是零回报陷阱。安全路：稳涨 +1 perm（父亲选的俱乐部是好平台），代价是你不是自己的人 →
      // roleShift −1（俱乐部把你当你父亲的项目，不是独立的领袖）。
      // 隔壁 assert_independence 是 0.5 赌注，honest-odds 已在 optionOdds 显双分支（per-option 表）。
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = -1;
      good = true;
      outcome = "你签了父亲选的那份合同。事实证明他是对的——那个俱乐部给了你最好的平台，你稳稳地涨了一截。赛后你打电话给他，他说「看见没，爸爸不会害你」。你笑了——但你知道，俱乐部那边把你当你父亲的项目，顺位也悄悄滑了一档。你的职业生涯有一半是你父亲的——你涨了一截，却没长出自己的主见。"; break;

    // legendary — single-option fate highlight (传承由生涯末评价，非此事件给出)
    case "wonder_strike_moment:attempt": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      good = success;
      outcome = success
        ? "球离开你脚的那一刻你就知道了。四十米——球在空中划了一道你从未踢出的弧线，擦着门柱内侧入网。全场寂静了一秒，然后塌了。解说员在喊你的名字。这个球会在十年后还在被播放。"
        : "你起脚了。球擦着门柱飞了出去。你看着球飞向看台，听见解说员说「勇气可嘉」。勇气可嘉——这就是你的四十米远射留给世界的东西。";
      break;
    }
    case "rags_to_riches:embrace": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你摸了摸球衣里的平安符。全村人此刻正在村委会的电视机前看你。你跑的每一步都带着泥地的记忆，每一次触球都带着七岁那双凑钱买的球鞋的重量。你不会让他们失望——因为你如果停下来，停下来的是一整个村庄的梦。"
        : "你张开双臂接住了这一切：钱、车、房子、每天打来的电话。你把整条街的人都养了起来——然后整条街都在等你给。第三年你发现自己在为二十个人踢球，而其中十九个人从来没问过你累不累。";
      break;
    }

    // trait-flag branches
    case "rival_fan_revenge:face_them": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      good = success;
      outcome = success
        ? "你走出球员通道的时候，嘘声像一堵墙砸过来。有东西从你身边飞过——你不去看。你走到角旗区，深吸一口气，抬起头。九十分钟后你进了球，你跑到旧主球迷看台前，没有庆祝，只是鞠了一躬。嘘声停了三秒——然后更大了。但那三秒够了。"
        : "你走出去的那一步就错了。一架无人机在你头顶盘旋，球迷的标语写着你的名字加「犹大」。你踢了六十分钟就被换下——不是因为战术，是因为你被砸中了。你回到更衣室的时候，发现自己在发抖。";
      break;
    }
    case "rival_fan_revenge:lay_low":
      // P-DEGEN: 曾是纯代价（只 roleShift −1，无收益）。补收益：稳涨 +1 perm +
      // cautious_play（你躲过那座地狱球场、身体没挨砸）；代价是顺位下滑、队友沉默。
      mods.roleShift = -1; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.addTags = [tag("cautious_play", 2)];
      good = false;
      outcome = "你告诉教练你不想踢这场。他理解了——但你的队友不得不在没有你的情况下面对那座地狱般的球场。你躲过了那阵砸下来的东西，身体没伤，也稳稳地涨了一截——只是顺位滑了一档，队友的沉默告诉你他们怎么看这事。赛后他们什么也没说，但你从更衣室的沉默里听出了答案。"; break;

    case "doping_whistleblower:pay_off": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -3);
      if (!success) { injury = true; mods.suspended = true; }
      good = success;
      outcome = success
        ? "你把钱转了过去。第二天他把录音删了。你松了一口气——但你知道你手里多了一个把柄，他手里也多了一个。从此你们在更衣室里彼此避开，像两个共享秘密的陌生人。"
        : "你转了钱，但他没有删录音。三天后足协的人来了。你坐在调查室里，想起那天喝下补剂时的痛快——那瓶东西不仅毁了你的身体，还毁了你的一切。";
      break;
    }
    case "doping_whistleblower:come_clean": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -2);
      good = success;
      outcome = success
        ? "你主动找足协坦白了。处罚来了——禁赛半年。但你知道如果等他们查出来，禁赛会是一年。你在新闻发布会上承认了错误，社交媒体上的骂声铺天盖地。但你回家后第一次在镜子里能直视自己了。"
        : "你主动找足协坦白了。但坦白没有换来宽大——他们顺着你的话查了下去，查出了整个更衣室，禁赛一年，队友再也不跟你说话。你说了真话，代价是没有人愿意再跟你站在一起。";
      break;
    }

    case "captain_rally:rally": {
      const success = roll(0.65, "positive");
      mods.leagueTrophyProbabilityMultiplier = success ? 1.5 : 1;
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你站起来的时候更衣室安静了。你说了什么你自己也不太记得——但你记得最后一句：「今晚输了我们散，今晚赢了我们一辈子是兄弟。」他们抬起头看着你，眼里的光回来了。那天晚上你们赢了，全队冲过来把你压在身下。"
        : "你站起来想说话，但嗓子是哑的。你说了几句，自己都觉得空洞。队友低着头没有人接话。你坐了回去——有些话，不是袖标能让你说出口的。那天晚上你们输了，更衣室里没有人说话。";
      break;
    }
    case "captain_rally:lead_by_example":
      // 以身作则：说不出振臂的话，就用九十分钟的跑动领着他们。确定性路径——
      // 没有振臂的高上限，但稳稳地把球队拉住一截。
      mods.leagueTrophyProbabilityMultiplier = 1.2; mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      good = true;
      outcome = "你站起来，又坐下了——你不知道说什么。于是你什么也没说。那天晚上你踢了九十分钟，跑动全场第一，每一次丢球都第一个追回来。队友后来告诉你，他们不是被你的话拉起来的，是被你的跑动拉起来的——「他都不放弃，我们凭什么。」你们没赢，但你们没散。袖标的重量，你用腿扛住了。";
      break;

    // P-A16: the butterfly lands — delayed injury relapse from playing through pain.
    case "injury_relapse:push_through": {
      const success = roll(0.35, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : 0);
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? -2 : -7);
      if (!success) { injury = true; severe = true; mods.statsMultiplier = 0.15; mods.addTags = [tag("compromised_body", 5)]; }
      else mods.addTags = [tag("compromised_body", 3)]; // even success costs long-term
      good = success;
      outcome = success
        ? "你又打了一针封闭。你上场了，你踢完了，你甚至进了球。但你回到家里跪在地板上起不来的时候，你知道你正在用余生换此刻。"
        : "你在第二十分钟倒下了。膝盖彻底报废——队医说你需要手术，恢复期一年，而且不保证能回到从前的水平。你躺在担架上的时候，想起了那场带伤上的决赛。你赢了那场比赛，输掉了后面所有的比赛。";
      break;
    }
    case "injury_relapse:surgery":
      mods.overallDelta = (mods.overallDelta ?? 0) + (-4); mods.overallDelta = (mods.overallDelta ?? 0) + (2);
      good = false; injury = true;
      outcome = "你选择了手术。恢复期很长——你错过了大半个赛季，看着队友踢球的感觉比带伤上场更煎熬。但队医说手术很成功，你的膝盖可以再用十年。你用一年换十年，这笔账不亏。"; break;

    // P-A153: the sweeper keeper — leave the line vs stay classical (Neuer dimension).
    case "sweeper_keeper:leave_the_line": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      if (!success) { injury = true; mods.overallDelta = (mods.overallDelta ?? 0) + (-2); }
      good = success;
      outcome = success
        ? "你冲出门禁区。你在大禁区线外解围，你到中场分球。教练说「他疯了——但这个疯子是对的。」你改变了门将这个位置。从此每个门将都想出门禁区。也许改变一个位置不需要许可——需要的是第一个敢的人。也许你的胆子比禁区大——所以禁区装不下你。"
        : "你冲出门禁区——但这一次你冲得太远了。你被吊射了，球进了。全场笑了。教练说「回去——别再出来了。」你退回门线，你想：也许我冲得太早了。但下一次你还是会冲——因为你知道你是对的，只是这次运气不好。也许改变位置的人会被笑——但笑过之后所有人会学他。";
      break;
    }
    case "sweeper_keeper:stay_classical": {
      const success = roll(0.7, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你守在门线上。你做最古典的门将该做的——挡球、组织、指挥。你赢了，你稳。没人说你是天才——但没人敢说你不是好的。也许古典不是落伍——是另一种好的方式。也许不是每个人都要改变位置——做好本分也是伟大。"
        : "你守在门线上。但你看着对面那个冲出门禁区的门将——你想：也许我应该试试的。你守住了，但你没有改变任何东西。也许安全是好的——但安全不会成为传奇。也许下一次你会冲——但不是今天。";
      break;
    }

    // P-A154: the warrior — throw body vs stay calm (Puyol dimension).
    case "the_warrior:throw_body": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      // captain ttl was 0 — dedupeTags drops ttl<=0 tags, so the captaincy
      // reward silently vanished. 6 periods matches the other captain writes.
      if (success) { mods.leagueTrophyProbabilityMultiplier = 1.3; mods.addTags = [tag("captain", 6), tag("talisman", 4)]; }
      if (!success) { injury = true; mods.overallDelta = (mods.overallDelta ?? 0) + (-2); mods.addTags = [tag("nagging_injury", 3)]; }
      good = success;
      outcome = success
        ? "你把身体扔出去——每一次。你的额头上缝了七针，你的膝盖缠着绷带，但你在角旗旁亲吻草皮。你的队友说「有他在我们敢压上。」你成了队长——不是因为你说话，是因为你第一个把身体扔出去。也许领袖不是声音最大的——是第一个敢的。也许战士不需要赢——需要的是让所有人看见他敢。"
        : "你把身体扔出去——但这一次你的肩膀先着地。你听到一声响。队医跑过来。你躺在草地上想：也许我该聪明的。但你知道下一次你还是会扔——因为那就是你。也许战士的代价是身体——但战士不会用别的方式。也许你会带着伤回来——因为站着比赢更重要。";
      break;
    }
    case "the_warrior:stay_calm": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      good = success;
      outcome = success
        ? "你用脑子踢。你预判，你指挥，你让队友去拼。你的身体省了——你比同代人多踢了好几年，没大伤。教练说你「聪明的领袖」。也许领袖不需要冲在最前——需要的是站在最后看全局。也许聪明的战士活得更久——踢得更久。"
        : "你用脑子踢。但你的队友等你冲——你没冲。他们不知道该不该压。你说「我指挥」——但指挥的人不动手，没人信。也许聪明是好的——但领袖有时候需要先冲。也许你应该更勇敢一点——而不是更聪明一点。";
      break;
    }

    // P-A155: the hand of god — be the god vs stay human (Maradona dimension).
    case "hand_of_god:be_the_god": {
      const success = roll(0.45, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      if (success) { mods.leagueTrophyProbabilityMultiplier = 1.5; mods.addTags = [tag("talisman", 8)]; }
      if (!success) { mods.addTags = [tag("compromised_body", 6)]; mods.overallDelta = (mods.overallDelta ?? 0) + (-2); }
      good = success;
      outcome = success
        ? "你做了国家的神。你用手打进了一个，你用脚过掉五个人进了另一个。他们说一个作弊一个神迹——你说「上帝之手」和「世纪之球」。你赢下了世界杯，一个刚输了战争的国家在你脚下忘掉了战争。也许神不需要公平——需要的是那一刻。也许你不是故意的——是上帝借了你的手。"
        : "你做了国家的神——但神会毁。你赢了世界杯，然后你上瘾了，你失控了，你的身体背叛了你。你以为你是神——但你是凡人，凡人会碎。也许做神是要付代价的——代价是失去人性。也许你最大的天赋也是你最大的诅咒：你以为你什么都能。";
      break;
    }
    case "hand_of_god:stay_human": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你拒绝做神。你说「我只是一个人。」你赢得了尊重而不是神化——你踢到了很久，你没有失控，你没有上瘾。你没赢第二次世界杯——但你赢得了一个完整的人生。也许拒绝神化是最大的勇气——比做神更难。也许你是凡人——但你是完整的凡人。"
        : "你拒绝做神——但国家要的是神。他们不满足于一个人。你踢得不错，但他们说你「不够」。也许你不能拒绝一个国家想要的东西——他们要神，你只能做神或离开。也许拒绝神化的代价是：你既不是神，也不再是英雄。";
      break;
    }

    // P-A156: the total footballer — invent the game vs win within rules (Cruyff dimension).
    case "total_footballer:invent_the_game": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (success) { mods.leagueTrophyProbabilityMultiplier = 1.4; mods.addTags = [tag("talisman", 6)]; }
      good = success;
      outcome = success
        ? `你改变了足球。你从前场跑到后场，后卫进球，前锋防守。你发明了那个转身——所有人学它。你拿遍了那个年代的个人奖，你说最大的骄傲是「我改变了足球被踢的方式」。也许天才不是进最多的球——是让所有人重新想球该怎么踢。也许${n.squadNumber}号不是号码——是一个问题：为什么不能？`
        : "你尝试改变足球——但改变要时间。你的队友跟不上你的流动。你赢了，但你没有完全改变什么——你太超前了。也许天才不是每个时代都能被理解的——也许你的改变要等你退役后才被人看见。也许你问了「为什么不能」——但世界还没准备好回答。";
      break;
    }
    case "total_footballer:win_within_rules": {
      const success = roll(0.65, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? "你在规则内赢。你踢你的位置，你进球，你拿金球。你赢了——稳稳地赢。但你心里知道你本可以改变更多。也许稳是好的——但稳不会成为传奇。也许你选择了安全——安全给了你奖杯，但没给你「为什么不能」。"
        : "你踢你的位置。你踢得不错——但你看着对面那个流动的14号，你想：也许我该那样踢的。你没有——你选择了稳。也许稳没错——但你错过了成为另一种伟大的可能。也许为什么不能是一个你不该回避的问题。";
      break;
    }

    // P-A157: the king — carry the world vs just play (Pelé dimension).
    case "the_king:carry_the_world": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (success) { mods.leagueTrophyProbabilityMultiplier = 1.5; mods.addTags = [tag("talisman", 8)]; }
      good = success;
      outcome = success
        ? "你成了球王。你赢了三次世界杯——没有人赢过第四次。你进了一千多个球。你让全世界看见了光脚的孩子也能成王。你说「我想用足球让世界看见穷孩子。」也许球王不是进最多球的人——是让一个孩子看见你之后相信自己也能成王的人。也许一千个球不重要——重要的是那一个孩子。"
        : `你背着全世界踢。重量太重了——你少年时就赢了世界杯，但之后所有人都要你赢。你赢了，但没有赢得那么轻松。你说「人们只记得那个少年——但我${n.ageCn}岁也还在踢。」也许球王不是永远的——也许你只是想做一个踢球的人，但世界不让你只是。`;
      break;
    }
    case "the_king:just_play": {
      const success = roll(0.7, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? `你只是踢球。你不背负——你说「我只是个踢球的人。」你赢得了世界杯，你赢得了尊重，但你没有成为「神」。你${n.ageCn}岁还在踢，你享受每一场。也许拒绝成为神是最好的选择——你成了一个人，一个完整的人。也许球王是那些没把自己当球王的人。`
        : "你只是踢球——但世界要的更多。你说你不想背负——他们说那你也得背负。你踢得不错但你没有被神化。也许你错过了传奇——但也许你赢得了生活。也许不是每个人都要做球王——做一个人也够。";
      break;
    }

    // P-A158: the invincible — beautiful or nothing vs win ugly (Henry dimension).
    case "the_invincible:beautiful_or_nothing": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -2);
      if (success) { mods.leagueTrophyProbabilityMultiplier = 1.35; mods.addTags = [tag("talisman", 5)]; }
      good = success;
      outcome = success
        ? `你把球走进球门——慢，但美。38场一场没输。你的球迷唱「他总是想把它走进去。」你笑了——因为你就是这么想的。你赢了世界杯、${n.continentalCup}、${n.continentalClubCup}。也许足球应该是美的——进球不只是结果，是方式。也许走进球门比射进去慢——但它更美。也许你定义的不是胜利——是足球该是什么样。`
        : "你坚持美——但有时候美不够赢。你输了两场决赛。你说「我不后悔踢得美——我只后悔没赢。」也许美和赢不总是同时来——但你不愿意为了赢放弃美。也许你的传奇不是奖杯——是你让所有人记住了足球可以是艺术。";
      break;
    }
    case "the_invincible:win_ugly": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -1);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.4;
      good = success;
      outcome = success
        ? "你射了。你不再坚持走进去——该射就射。你赢得了那些你以前输的决赛。但你看着回放——你的进球不那么美了。也许赢比美重要——你终于信了。也许你赢得了奖杯——但失去了你的「为什么」。也许有些东西赢了也换不回。"
        : "你射了——但你不是你。你赢得了几场——但你的球迷说「这不是我们的球员。」也许你不能假装成别人——也许美就是你的赢法。也许你该回去走进球门——哪怕输。";
      break;
    }

    // P-A159: the non-flying Dutchman — the turn vs overcome fear (Bergkamp dimension).
    case "non_flying_dutchman:the_turn": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 2 : -2);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.3;
      good = success;
      outcome = success
        ? "你用脚飞。你不坐飞机——你开车、坐火车、或者不去。但你在主场做的事——他们记一辈子。那个转身——球从左边来，你一脚绕过所有人。也许限制不是弱点——如果你在限制里创造了别人在自由里创造不出的东西。也许不坐飞机的人飞得最高——用脚。"
        : "你用脚飞——但你的脚也会累。你错过太多客场，你的教练开始犹豫。也许你的美是真的——但足球需要你出现在每一个客场。也许限制是美——但限制也是限制。也许有一天你得面对那个恐惧——或者接受你会错过一些。";
      break;
    }
    case "non_flying_dutchman:overcome_the_fear": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      if (success) mods.leagueTrophyProbabilityMultiplier = 1.25;
      // 恐飞没去成客场——只踢主场≈半季，不是整季停赛（你用脚飞，不是被禁赛）。
      if (!success) { mods.overallDelta = (mods.overallDelta ?? 0) + (-1); mods.statsMultiplier = 0.5; }
      good = success;
      outcome = success
        ? "你面对了恐惧。你坐上了飞机——你闭着眼，你抓着扶手，但你到了。你出现在每一个客场。你的进球更多了——因为你在。也许克服恐惧比进一个美的球更勇敢。也许不坐飞机的人终于飞了——不是用脚，是真的飞了。"
        : "你坐上了飞机——但你撑不住。你在机场就崩了。你没去成客场。你回到了不开飞机的日子。也许有些恐惧不是用来克服的——是用来共处的。也许你接受它反而更好——不开飞机的你，用脚飞得更高。";
      break;
    }

    // P-A160: the galloping major — restart at thirty vs rest on legacy (Puskás dimension).
    case "galloping_major:restart_at_thirty": {
      const success = roll(0.4, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 3 : -3);
      if (success) { mods.leagueTrophyProbabilityMultiplier = 1.5; mods.addTags = [tag("talisman", 6)]; }
      if (!success) { mods.addTags = [tag("compromised_body", 4)]; mods.roleShift = -1; }
      good = success;
      outcome = success
        ? `你${n.ageCn}岁重新开始。你胖了，没人要你——但${n.bigClub}要了。你和那里的头牌一起把${n.continentalClubCup}捧了又捧。你在决赛进了四个球——${n.ageCn}岁。也许少校不是没输过——是输了之后还能重新开始。也许伟大的球员不需要不输——需要的是输完了还能在这个岁数进四个。`
        : `你${n.ageCn}岁重新开始——但身体不合作。你胖了，你慢了。你在${n.bigClub}坐了板凳。也许这个岁数重新开始太难了——也许你早该停在最辉煌的时候。但你试了——这不丢人。也许飞奔的少校飞不动了——但他曾经飞过。`;
      break;
    }
    case "galloping_major:rest_on_legacy": {
      const success = roll(0.7, "positive");
      // 停在巅峰：成功则传奇永驻（+1 perm，稳住那一截）；失败则「如果」的反陋侵蚀——
      //  原失败分支 perm=0 无后果 → 预览空 mods 成空白。补一个小负面（-1 perm）：
      //  看着皇马赢杯心瘾难平，停得太早的遗憾蛰伏成动力不足。与叙事「保住了传奇、
  //  也保住了没试的遗憾」一致。
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? `你停在最辉煌的时候。你不重新开始——你说「我的传奇在那里，我不去别处毁它。」你成了${n.nation}的永恒。也许停下来也是一种智慧——不是每个伟大的球员都要在这个岁数再战。也许你的「如果」比你的「再来」更美——因为「如果」永远不会输。`
        : `你停了。但你坐在${n.nation}的小球会里看着${n.bigClub}捧起${n.continentalClubCup}——你想：如果我去了。也许停得太早了——也许你本可以再进四个的。但「如果」没有答案。也许停下来保住了传奇——但也保住了那个永远没试的遗憾。`;
      break;
    }

    // ── baseline 二选项: the 15 former single-option fate events' second path ──
    case "rags_to_riches:let_go": {
      const success = roll(0.6, "positive");
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.addTags = [tag("fan_darling", 4)]; }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-1); }
      good = success;
      outcome = success
        ? "你把全村的重量放下了。你回乡办了个球场，孩子们在那里踢球——他们叫你的名字，但不是求你。你只为自己踢，反而踢得更轻。你稳稳涨了一截，也成了真正属于自己的人。"
        : "你想放下，但放不下——每次进球你都会想起村委会那台电视。你试着只为自己踢，却踢得空了。你少了一截，村里人也说你变了。也许重量不是你想放就能放的。";
      break;
    }
    case "ironic_goal:celebrate": {
      const success = roll(0.5, "positive");
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (2); mods.addTags = [tag("fan_darling", 4)]; }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-2); mods.roleShift = -1; }
      good = success;
      outcome = success
        ? "你进了球，你庆祝了——你没有为任何人沉默。新主场的球迷爱上了你，你笑了——这是你的进球，你的快乐。你稳稳涨了一截，也没欠谁一个表情。"
        : "你进了球，你庆祝了。但旧主的球迷没有原谅你——他们说你忘恩。你的庆祝被做成集锦挨骂，更衣室里也有人侧目。你少了一截，顺位也滑了——你选择了做你自己，代价是孤立。";
      break;
    }
    case "beyond_football:let_football_talk": {
      const success = roll(0.55, "positive");
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.addTags = [tag("fan_darling", 4)]; }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-1); }
      good = success;
      outcome = success
        ? "你没有说那句话。你把这一刻还给了足球——下一场你进了一个球，你指向看台。你的母国在那一脚里看见了希望，不是一句话，是一个进球。你稳稳涨了一截，也成了不靠话筒发声的人。"
        : "你没有说那句话。但你也没能进那个球——你太想用足球说话，脚却软了。你少了一截，镜头也没再对准你。也许有些时刻不需要发声，但有些时刻沉默也不是答案。";
      break;
    }
    case "war_childhood:let_it_rest": {
      const success = roll(0.5, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你把那段记忆放下了。你不再每次上场都想起那个停车场。你踢得轻了一点，也自由了一点。你稳稳涨了一截——废墟在你身后，不在你脚下。"
        : "你想放下，但放不下——那段记忆是你踢球的全部动力。你试着不想，却踢得空了。你少了一截，也没找到新的火。也许你不是走出废墟了，你只是把废墟带在了身上。";
      break;
    }
    case "last_minute_hero:track_back": {
      const success = roll(0.6, "positive");
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.addTags = [tag("fan_darling", 4)]; }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-1); mods.roleShift = -1; }
      good = success;
      outcome = success
        ? "你回撤了。你相信队友。角球飞进禁区，你没有冲上去——你站在弧顶，准备拦截反击。队友顶进了那个球。你们赢了。赛后他指着你说「是他让我敢顶的」。你稳稳涨了一截，没抢功，但所有人记得你的回撤。"
        : "你回撤了。但队友没有顶进那个球——你看着它擦着门柱飞出。终场哨响，你输了。有人低声说「如果那个前锋冲上去呢」。你少了一截，顺位也滑了——你选择了相信别人，代价是这个如果。";
      break;
    }
    case "super_sub:pass_torch": {
      const success = roll(0.5, "positive");
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.addTags = [tag("mentor_legend", 4)]; }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-1); mods.roleShift = -1; }
      good = success;
      outcome = success
        ? "你没有上场。你拍了拍那个年轻人的肩：「去吧，改变这场决赛。」他上场了，他进了。你站在场边笑了——你的球衣退役了，他的故事开始了。你稳稳涨了一截，成了一个被记住的托举者。"
        : "你没有上场。但那个年轻人也没有改变比赛——你们输了。你坐在更衣室想：如果我上呢。你少了一截，顺位也滑了——你把机会让了出去，它没有回来。";
      break;
    }
    case "history_kick:lay_off": {
      const success = roll(0.7, "positive");
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.addTags = [tag("fan_darling", 4)]; }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-1); mods.roleShift = -1; }
      good = success;
      outcome = success
        ? "你没有起脚。你把球横敲给了位置更好的队友——他进了。你跳进他怀里，他先指了你。你的名字和这家俱乐部绑在了一起——不是靠那一脚，是靠那一传。你稳稳涨了一截，无私也成了传奇的一部分。"
        : "你没有起脚。你横敲——但传球被断了。对方反击，你们输了。你跪在草地上想：那一脚本来是你的。你少了一截，顺位也滑了——你让出了那一脚，也让出了你的名字。";
      break;
    }
    case "captain_save:stay_narrow": {
      const success = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你没有扑出去。你站住，封窄角度，等他先动。他动了——你接住了。全场塌了。你没有飞身扑救的英姿，但你守住了这一分。你稳稳涨了一截——最好的扑救有时候是不扑。"
        : "你没有扑出去。但你站得也太死了——他一脚穿裆，球进了。你趴在门线上不动。你少了一截——你选择了稳，稳没有救下这一场。";
      break;
    }
    case "redemption_arc:pass_the_armband": {
      const success = roll(0.55, "positive");
      if (success) { mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.addTags = [tag("mentor_legend", 4)]; }
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-1); mods.roleShift = -1; }
      good = success;
      outcome = success
        ? "你没有上场。你把袖标给了那个年轻人：「这次你来。」他上场了，他赢了。赛后他把奖杯递给你：「这是你的。」你笑了——你输了三次，但这一次你赢了一次，是用托举赢的。你稳稳涨了一截。"
        : "你没有上场。那个年轻人也没有赢——你们又输了。你坐在更衣室，没有人怪你。但你心里那个「如果我又上一次呢」没有答案。你少了一截，顺位也滑了。";
      break;
    }
    case "panenka:power_corner": {
      const success = roll(0.7, "positive");
      if (success) mods.nationalTournamentParticipation = "force";
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      if (!success) { mods.overallDelta = (mods.overallDelta ?? 0) + (-1); mods.roleShift = -1; }
      good = success;
      outcome = success
        ? "你没有挑中间。你往左下角爆射——球带着风进了。门将没动。你笑了——勺子是勇敢，爆射是稳妥。你稳稳涨了一截，用最不花的方式进了最重要的一球。"
        : "你没有挑中间。你爆射——但门将猜对了方向，扑了出去。你看着球在他怀里。你少了一截，顺位也滑了——你没敢勺子，也没进。";
      break;
    }
    case "the_pivot:refuse_pivot": {
      const success = roll(0.4, "positive");
      if (success) mods.overallDelta = (mods.overallDelta ?? 0) + (3);
      else { mods.overallDelta = (mods.overallDelta ?? 0) + (-2); injury = true; }
      good = success;
      outcome = success
        ? "你拒绝了。你说「我还能往前冲」。教练看了你很久，点了头。你那一赛季进了生涯最多的球——你证明了他错了，你不是枢纽，你是箭头。你涨了一大截——拒绝让你回到了你自己。"
        : "你拒绝了。但你的身体没有等你的脑子——第三场比赛你的腿拉伤了。你坐在治疗台上想：也许他说得对，也许你真的该换个踢法。你少了一截，也多了一处伤。";
      break;
    }
    case "late_bloomer:stay_steady": {
      const success = roll(0.65, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你没有逞强。你稳稳踢，该扑的扑，不该出的不出。你没有金手套，但你守住了每一场该守的。你稳稳涨了一截——大器晚成不是迟到，是用稳等到正确的时刻。"
        : "你没有逞强。但你太稳了——该出击的你没出，该扑的你没收。你少了一截，也错过了这个窗口。也许稳也要分时候。";
      break;
    }
    case "penalty_burden:step_away": {
      const success = roll(0.55, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你远离了点球点。你不再罚了。有人说你「逃了」，但你的职业生涯安静了下来——你稳稳涨了一截，也没再罚失一个。也许放下比带着它走更难。"
        : "你远离了点球点。但那个球跟着你——每次有人罚失，你都想起自己。你少了一截，也没真正放下。也许远离不是放下。";
      break;
    }
    case "wonder_strike_moment:lay_off": {
      const success = roll(0.75, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (success ? 1 : -1);
      good = success;
      outcome = success
        ? "你没有起脚。你横传给了位置更好的队友——他推射空门。你跳进他怀里，他指着你。你稳稳涨了一截——四十米是浪漫，一脚横传是冠军。"
        : "你没有起脚。你横传——但传球轻了，被断了。你看着对方反击，你少了一截——你让出了那一脚，它没有回来。";
      break;
    }
    // ─────────── P-RISE+ 上升期回报簇 (upside-only, 确定性) ───────────
    // 两个分支都净正向,差别在货币:能力(OVR) / 身份(标签) / 奖杯概率 / 传承。
    // 不掷骰 → inferTone 按 mods 判 ▲;不进 EVENT_ODDS 表。
    case "stand_song:salute":
      mods.addTags = [tag("fan_darling", 4)]; good = true;
      outcome = "你走到北看台下面，抬起手鼓掌。整个看台站起来跟着你的节拍。安保想拦，队长把他推开了。那首歌从这一场开始，每个主场都唱。"; break;
    case "stand_song:bring_team":
      mods.addTags = [tag("captain", 4)]; mods.leagueTrophyProbabilityMultiplier = 1.15; good = true;
      outcome = "你没有一个人过去。你把全队从中圈拽到北看台前面，排成一排鞠躬。散场后老队长在通道里对你说：「以前没人想到把我们也带过去。」"; break;

    case "coach_backing:accept_core":
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.roleShift = 1; good = true;
      outcome = "你在训练中接下了那个位置。战术会上主帅把白板擦干净，从你的名字开始画。整套体系跟着你转，你也跟着它长了一截。"; break;
    case "coach_backing:share_credit":
      mods.addTags = [tag("captain", 4)]; mods.leagueTrophyProbabilityMultiplier = 1.2; good = true;
      outcome = "你在自己的发布会上把话还了回去：「没有身后那两个人跑，我拿不到球。」那两个人第二天开始给你送更难的球。更衣室没有裂。"; break;

    case "academy_kids:go_train":
      mods.addTags = [tag("mentor_legend", 4)]; good = true;
      outcome = "你每周三下午出现在青训场。第一次去的时候没人敢传球给你，第四次去的时候他们已经开始故意过你。青训教练把那张照片打印出来贴在了办公室门上。"; break;
    case "academy_kids:focus_season":
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); good = true;
      outcome = "你把时间留给了自己的训练。赛季结束后青训教练发来第二张照片——挂钩上多了五件球衣，还是你的号码。"; break;

    case "signature_goal:credit_team":
      mods.leagueTrophyProbabilityMultiplier = 1.2; good = true;
      outcome = "你没有庆祝，回头指了指那个把球捅给你的后腰。他愣了一下，然后跑过来把你抱起来。那个赛季全队的助攻数是队史最高的。"; break;
    case "signature_goal:own_it":
      mods.addTags = [tag("fan_darling", 4)]; mods.overallDelta = (mods.overallDelta ?? 0) + (1); good = true;
      outcome = "你跑到角旗区，转身对着转播镜头，指了指球衣背后自己的名字。这个动作当晚被做成了动图。下一场客场，对方球迷在你触球时集体嘘你——你又进了一个。"; break;

    // P-DEGEN: earn_it 曾是 +2、take_it 是 +1，其余完全相同 —— 严格支配，
    // 于是「擦掉名字」永远是对的，这就不是抉择了(validations: dominant-strategy)。
    // 改成两条线的交换而不是同一条线上的大小：take_it 锁死这一季的国家队席位
    // (荣誉线确定)，earn_it 拿席位去赌能力线。世界杯年 take_it 对，平年 earn_it
    // 对 —— 最优解随处境翻转。
    case "nt_shirt_locked:take_it":
      mods.overallDelta = (mods.overallDelta ?? 0) + (1);
      mods.nationalTournamentParticipation = "force";
      good = true;
      outcome = "你接下了那个位置。集训的对抗赛里你踢满全场，主帅一次都没有换你。名单公布那天，只有你的名字没有被讨论过。"; break;
    case "nt_shirt_locked:earn_it": {
      const won = roll(0.6, "positive");
      mods.overallDelta = (mods.overallDelta ?? 0) + (won ? 2 : 1);
      mods.nationalTournamentParticipation = won ? "force" : "skip";
      if (won) mods.addTags = [tag("captain", 4)];
      good = won;
      outcome = won
        ? "你请主帅把名字擦掉。整个集训你和另外两个人抢同一个位置，最后一场热身赛你打满九十分钟。主帅在更衣室说：「这个位置本来就是他的，现在是他自己拿的。」"
        : "你请主帅把名字擦掉。然后你输了——那个比你小四岁的人在最后一场热身赛里进了两个。名单公布那天你在家里看的电视。主帅给你打了电话：「下次别把已经到手的东西推回来。」";
      break;
    }

    case "veteran_handover:take_locker":
      mods.addTags = [tag("captain", 4)]; mods.overallDelta = (mods.overallDelta ?? 0) + (1); good = true;
      outcome = "你接过名牌，把自己的挂了上去。那天之后，赛前最后一个走出更衣室的人从他变成了你——他留下的那套规矩，你一条没改。"; break;
    case "veteran_handover:keep_it_his":
      mods.addTags = [tag("fan_darling", 4)]; mods.leagueTrophyProbabilityMultiplier = 1.15; good = true;
      outcome = "你把他的名牌钉回了门上，柜子空着。俱乐部把这件事发到了官方账号上。他退役仪式那天，全场唱的是他的名字，他把话筒递给了你。"; break;

    case "unbeaten_run:keep_grinding":
      mods.overallDelta = (mods.overallDelta ?? 0) + (2); good = true;
      outcome = "你留下来加练，一个人。体能教练每次都陪到最后一组。赛季末那张跑动图换成了新的——十二场变成二十六场，第一位还是同一个名字。"; break;
    case "unbeaten_run:pull_team_in":
      mods.leagueTrophyProbabilityMultiplier = 1.25; good = true;
      outcome = "你把加练变成了全队的。头两周有人骂你，第三周开始没人再骂了。体能教练把跑动图撤了下来——榜上的差距已经没什么可看的。"; break;

    case "shirt_sales:donate":
      mods.addTags = [tag("mentor_legend", 4)]; good = true;
      outcome = "你把分成签给了青训营。俱乐部主席想开发布会，你说不用。半年后青训场铺了新草皮，门口的牌子上没有你的名字。"; break;
    case "shirt_sales:boot_deal":
      mods.overallDelta = (mods.overallDelta ?? 0) + (1); mods.overallDelta = (mods.overallDelta ?? 0) + (1); good = true;
      outcome = "你签下了球鞋合同，条件是拍摄全部安排在休赛期。赛季里你没有缺过一堂训练课。品牌方后来把你那双鞋的配色命名成了球队主场的颜色。"; break;

    default:
      outcome = ""; break;
  }

  // 伤病潮 (ascension 2): every injury cuts one OVR deeper. Applied BEFORE the
  // mitigations (ironman/combo_iron halve, pp_iron_will zeroes) so blessings
  // keep their promised effect against the worse number. previewBranch resolves
  // through this same function, so the option pill shows the deepened cost.
  // 能力变化已合并成单个 overallDelta——伤病折损全在此，减伤逻辑直接作用于它
  // （旧实现只减 immediate 段、放过 permanent 留疤；单字段后「OVR 损失减半」名实相符，
  // 对 ironman/铁血队长是诚实的小幅增强，regress 会量化）。
  if (injury && (ctx.ascension ?? 0) >= 2 && mods.overallDelta !== undefined && mods.overallDelta < 0) {
    mods.overallDelta -= 1;
  }
  // meta-layer: ironman halves injury OVR penalties (floored at 0 — minor
  // injuries cost nothing; the iron body also ignores the compromised_body
  // long-term growth drag, see run.ts).
  if (injury && ctx.blessings.includes("ironman") && mods.overallDelta !== undefined && mods.overallDelta < 0) {
    mods.overallDelta = -Math.max(0, Math.floor(-mods.overallDelta / 2));
  }
  // 铁血队长 (combo_iron 词条成型): injury OVR penalties halved — same shape as
  // ironman, stacks after it (both floored at 0, so stacking can't go negative).
  if (injury && ctx.statusTags.includes("combo_iron") && mods.overallDelta !== undefined && mods.overallDelta < 0) {
    mods.overallDelta = -Math.max(0, Math.floor(-mods.overallDelta / 2));
  }
  // pp_iron_will (钢铁意志 prestige perk): the FIRST injury of the run costs no
  // OVR at all. Applied after ironman so the two stack (ironman never fires on a
  // 0 delta anyway).
  if (injury && (ctx.permPerks ?? EMPTY_PERKS).includes("pp_iron_will") && ctx.injuriesTaken === 0
      && mods.overallDelta !== undefined && mods.overallDelta < 0) {
    mods.overallDelta = 0;
  }

  // 上升期减伤 (P-RISE): soften what a bad branch TAKES while the player is
  // still climbing. Runs after every case arm (including pp_iron_will above),
  // so it covers all ~150 branches without re-auditing them, and before tone
  // inference so ⇄/▼ is judged on the number the player actually pays.
  if (isRisingPhase(ctx)) {
    mods.overallDelta = riseSoften(mods.overallDelta);
  }

  // Valence (▲/⇄/▼): a rolled gamble reads by its result; a deterministic
  // option reads by what it actually does. The old binary `good` under-marked
  // an entire class of tradeoff options (benefit AND cost, e.g. +1 perm at the
  // price of roleShift −1) as failures — players saw ▼ on sensible choices and
  // reported "every pick lands negative". inferTone fixes ALL of those at once
  // without re-auditing 150 case arms; explicit `tone = ...` in a case wins.
  if (tone === undefined) {
    tone = rolled ? (good ? "good" : "bad") : inferTone(mods, good, injury);
  }
  // Deterministic tradeoffs are not failures: keep the streak/marquee flag in
  // sync with the displayed valence so a ⇄ pick never counts as a loss.
  if (!rolled && tone !== "bad") good = true;
  return { mods, outcome, good, injury, severe, tone, rolled };
}

/** Classify a DETERMINISTIC (un-rolled) resolution by its modifiers: benefit
 *  AND cost → mixed (⇄), only benefit → good, only cost → bad, neither →
 *  whatever the case's `good` flag says (pure-narrative outcomes keep their
 *  authored valence, but never read as a loss without an actual cost). */
function inferTone(mods: Modifiers, good: boolean, injury: boolean): OutcomeTone {
  const net = mods.overallDelta ?? 0;
  const roleUp = mods.roleOverride === "starter" || mods.roleOverride === "high_rotation" || (mods.roleShift ?? 0) > 0;
  const roleDown = mods.roleOverride === "substitute" || mods.roleOverride === "low_rotation" || (mods.roleShift ?? 0) < 0;
  const benefit = net > 0 || roleUp
    || mods.forceTrophy?.result === "force"
    || (mods.leagueTrophyProbabilityMultiplier ?? 1) > 1
    || mods.nationalTournamentParticipation === "force";
  const cost = net < 0 || roleDown || injury
    || !!mods.suspended || !!mods.forceRetire
    || (mods.statsMultiplier ?? 1) < 1  // 轻伤/短停赛少踢也是一种代价
    || mods.forceTrophy?.result === "skip"
    || (mods.leagueTrophyProbabilityMultiplier ?? 1) < 1
    || mods.nationalTournamentParticipation === "skip";
  // An EXPLICIT authored good=true is intent, not the forgotten default (the
  // default is false — only explicit assignments reach here as true): a chosen
  // exit like rock_bottom:walk_away must not verdict 事与愿违 for the cost the
  // player knowingly accepted — it reads ⇄ (a priced choice), never ▼.
  if (good) return cost ? "mixed" : "good";
  if (benefit && cost) return "mixed";
  if (benefit) return "good";
  if (cost) return "bad";
  return "mixed";
}

// ───────────────────────────── event catalog (28 events) ─────────────────────────────
//
// Each EventDef carries the target's eligibility gate (Zr) and a builder that
// produces a FiredEvent with the right options + resolve wired to
// resolveEventOption. Weights come from the target At table.
//
// Event-variety fix: the mundane training/position/coach events were at weight
// 80-100 while 150+ story events sat at 2-60 (×0.6-0.7 for rare/legendary) — a
// 25-100x ratio that let 6 events (季前特训/私人教练/改打位置/赛季负荷/位置竞争/
// 新帅上任) take ~half of every career's story-pool slots, so the player "always
// saw the same few". They're now at 60, the same order as the mid-tier story
// events, so the pool spreads across the catalog. These events are also OVR-
// load-bearing (季前特训 +3, 私人教练 +4) — verified by Monte Carlo that peak OVR
// is preserved (79.4 held) and the high-OVR story events they gate stay
// reachable.

export type Rarity = "common" | "rare" | "legendary";

/** An event's prose. A plain string for events that state nothing about the
 *  player, or a function of the narrative facts for the story events — those
 *  are modelled on real footballers and must render THIS career's nationality,
 *  club, league and age instead of the original's. See narrative.ts. */
type Desc = string | ((n: Narrative, ctx: EventContext) => string);

interface EventDef {
  key: string;
  title: string;
  desc: Desc;
  weight: number;
  /** Rarity scales effective weight down and flags the UI for a special frame. */
  rarity?: Rarity;
  eligible: (ctx: EventContext) => boolean;
  build: (ctx: EventContext) => FiredEvent;
}

/** National-team callup threshold by international reputation (Ar → ot). */
const NT_THRESHOLD = [60, 70, 74, 78, 80, 83];
function ntThreshold(intlRep: number): number {
  return NT_THRESHOLD[Math.max(0, Math.min(5, Math.floor(intlRep)))] ?? 60;
}
const isHighRole = (r: string) => r === "starter" || r === "high_rotation";
/** Career-phase gates (P7): split the pool by age so late career stops
 *  replaying youth events, reducing repetition fatigue. */
const isYouth = (ctx: EventContext) => ctx.age <= 19;
const isPrime = (ctx: EventContext) => ctx.age >= 20 && ctx.age <= 29;
const isTwilight = (ctx: EventContext) => ctx.age >= 30;
/** tag helpers (P7 trait-flag branching). */
const hasTag = (ctx: EventContext, tag: string) => ctx.statusTags.includes(tag);

/** Rarity → effective weight multiplier. The label (common/rare/legendary)
 *  is a VALUE/narrative-weight tag — it tells the UI how to frame the event
 *  (传奇金边 etc.) and signals the story's weight — it is NOT a frequency
 *  gate. The rarity's "rareness" is carried by the weight number itself
 *  (legendaries tend to have low weights 3-15), not by a multiplier that
 *  suppresses appearance. So a 传奇 story with weight 100 shows up as often as
 *  any weight-100 event; a weight-3 传奇 stays rare because 3 is small.
 *
 *  History: this used to scale 0.15 → 0.6 → 0.7 → 0.85/0.75, progressively
 *  un-hiding rare/legendary stories that were dead content. The final step is
 *  1.0 across the board — the user's ask: 稀有度是价值标签，不该压低出现频率.
 *  If a 传奇 event shows up too often after this, tune its WEIGHT number, not
 *  this multiplier (re-introducing a suppression factor would re-bury the
 *  story catalog the variety passes fought to surface). */
function rarityWeightMult(_rarity: Rarity | undefined): number {
  return 1;
}

/** Pool events whose resolve sets newClubId (a club move dressed as a story).
 *  Exported so run.ts can route them to the transfer channel (T) and so the
 *  story-channel draw can EXCLUDE them (a story slot must be a non-club-move
 *  event — the user's "转会与故事共存不互斥" ask: T carries the move, S carries
 *  the story, never two newClubId in one period). */
/** 池事件里「会换俱乐部」的 key —— run.ts 用它把这类故事路由到 T 通道，避免同一
 *  期里 S 与 T 两张牌都写 newClubId（mergeMods 取后者，先 resolve 的那次转会会被
 *  静默吞掉：玩家刚选完「英雄归来·衣锦还乡」，下一张牌就把他送去别处）。
 *
 *  **不变量：任何 resolve 会写 mods.newClubId 的池事件都必须在这个集合里。**
 *  这份名单手工维护过两次、漏了两次（triumphant_return / forced_sale / discarded
 *  都会转会却留在 S 通道），所以现在由 tools/event-shape-check.mjs 静态核对
 *  「集合 == 会写 newClubId 的池事件」，两边不一致直接红——不再靠人记得住。 */
export const POOL_CLUB_MOVE_KEYS = new Set([
  "position_competition", "club_crisis", "return_home",
  "triumphant_return", "forced_sale", "discarded",
]);

type EventOption = { key: string; text: string; sub?: string; clubId?: string };
/** Options may be a FUNCTION of ctx — the 选队权 events (回国踢球/位置竞争/
 *  俱乐部危机) render one option per candidate club instead of a single
 *  「离队」button whose destination the engine picks for the player. The
 *  builder must be pure (destination helpers are) so rebuildResolve
 *  reconstructs the same slate after a refresh, and resolveEventOption
 *  re-derives the picked club from the same helper. */
type EventOptions = readonly EventOption[] | ((ctx: EventContext) => readonly EventOption[]);

function makeEventDef(key: string, title: string, desc: Desc, weight: number, eligible: (ctx: EventContext) => boolean, options: EventOptions, rarity?: Rarity): EventDef {
  return {
    key, title, desc, weight, rarity, eligible,
    build: (ctx) => buildEvent(ctx, key, title, renderDesc(desc, ctx), typeof options === "function" ? options(ctx) : options, rarity),
  };
}

/** 把候选俱乐部渲染成 club-N 选项（联赛 · 星级 · 曾效力 · 到队后的定位）——
 *  和强制离队/降级去留 的选队卡一个格式，玩家一眼能比。roleLabel 由调用方
 *  给：这几个事件的 resolve 都强制 roleOverride «主力»，所以写死比按俱乐部
 *  强弱预测更诚实（显示什么就是到队后拿到什么）。 */
function clubOptions(ctx: EventContext, dests: readonly Club[], label: (club: Club) => string, roleLabel = "主力"): EventOption[] {
  const former = new Set(ctx.formerClubIds ?? []);
  return dests.map((c, i) => ({
    key: `club-${i}`,
    text: label(c),
    sub: `${LEAGUES.find((l) => l.id === c.leagueId)?.name ?? ""} · ${"★".repeat(clubStarRating(c.rep))}${former.has(c.id) ? " · 曾效力" : ""} · ${roleLabel}`,
    clubId: c.id,
  }));
}

/** Resolve a Desc against the career's own facts. */
function renderDesc(desc: Desc, ctx: EventContext): string {
  return typeof desc === "string" ? desc : desc(narrative(ctx), ctx);
}

/** Build a FiredEvent for a career event, wiring resolve to resolveEventOption. */
/** The set of boss/climax events — these are buffed (not penalized) by
 *  big_game_player, so the −10% penalty only applies to ordinary prob events. */
const BOSS_KEYS = new Set(["world_cup_showdown", "world_cup_qualifier_showdown", "continental_cup_showdown"]);

/** Apply big_game_player to a non-boss event's odds: −10% (capped at 0.01). */
function bigGameOdds(key: string, odds: number, blessings: readonly string[]): number {
  if (!blessings.includes("big_game_player")) return odds;
  if (BOSS_KEYS.has(key)) return odds; // boss events are buffed in run.ts instead
  return Math.max(0.01, odds - 0.1);
}

/** 铁肺 (iron_lungs): +25% on training-family event odds (mirrors the resolve
 *  roll in resolveEventOption, so the displayed odds match the actual roll —
 *  the PRODUCT "odds are the hero" rule). Capped at 0.95. */
function ironLungsOdds(key: string, odds: number, blessings: readonly string[]): number {
  if (!blessings.includes("iron_lungs") || !IRON_LUNGS_FAMILY.has(key)) return odds;
  return Math.min(0.95, odds + 0.25);
}

/** 天命难违 (ascension 6): −10pp on every ordinary event's good-branch odds.
 *  Mirrors the ascTax in resolveEventOption's roll — shown % == rolled %.
 *  Boss/climax events are exempt (run.ts taxes their authored odds instead). */
function ascensionOdds(key: string, odds: number, ascension: number): number {
  if ((ascension ?? 0) < 6 || BOSS_KEYS.has(key)) return odds;
  return Math.max(0.05, odds - 0.10);
}

/** HIDDEN momentum (势头) bonus: +10% success odds per consecutive rolled
 *  failure, capped at +30%. Owner decision: this regulation is invisible to
 *  the interface — the displayed % stays at base value and ONLY the actual
 *  roll is nudged, strictly in the player's favor (shown 60% may really be
 *  75%, never the reverse). This is the one sanctioned deviation from the
 *  "shown % == rolled %" rule; do NOT surface it in any UI copy or badge.
 *  Deterministic: streak derives from resolve history (see run.ts). */
function momentumBonus(failStreak: number | undefined): number {
  const s = failStreak ?? 0;
  return s > 0 ? Math.min(0.30, s * 0.10) : 0;
}

/** 上升期 (P-RISE) — the window a player EXPERIENCES as「我正在起势」: he has
 *  broken through (OVR ≥ RISE_MIN_OVR) but is neither world-class yet
 *  (OVR < RISE_MAX_OVR) nor past the dev curve's last growing bracket
 *  (age ≤ RISE_MAX_AGE).
 *
 *  Player report「一到上升期就负面buff」. Measured on 800 careers: the share of
 *  decisions resolving ▼ climbs 11% (OVR <65) → 19% (75-79) → 21% (80-84);
 *  inside the window 31.5% of periods ended with events NET-SUBTRACTING OVR and
 *  16.4% gained nothing at all. Cause: the odds never scaled with the player —
 *  an 82-OVR starter faced the same coin-flip a 68-OVR squad player did — so
 *  climbing bought MORE threat-framed events at an unchanged failure rate, which
 *  reads as「能赢的局都输了」and kills the confidence to keep taking risks
 *  (game-design-core: punishment-over-teaching — failure must instruct, not
 *  discourage; risk must stay opt-in and worth taking).
 *
 *  Two levers, one per half of the complaint (出现几率 + 实际影响):
 *   - RISE_ODDS tilts the roll toward the good branch. HIDDEN, exactly like
 *     momentum — the displayed % never moves and the deviation is always in the
 *     player's favour (owner's regulation rule).
 *   - RISE_LOSS_MULT scales what a bad branch TAKES. NOT hidden: it runs inside
 *     resolveEventOption, and previewBranch resolves through that same function,
 *     so the option card's pill shows the SAME softened number the career pays.
 *
 *  The RISE_MAX_OVR ceiling is deliberate: once you ARE world-class the game
 *  stops holding your hand — the elite band keeps its full risk, which is also
 *  what keeps 顶端稀有 (research/peak-rating-distribution-design.md). */
const RISE_MIN_OVR = 65;
const RISE_MAX_OVR = 82;
const RISE_MAX_AGE = 27;
/** Hidden success-odds tilt inside 上升期 (stacks with momentum, same caps). */
const RISE_ODDS = 0.08;
/** Negative OVR from an event is scaled by this inside 上升期 (−4 → −2). */
const RISE_LOSS_MULT = 0.7;

function isRisingPhase(ctx: EventContext): boolean {
  // Climax/boss events (worldCupShowdown / continentalCupShowdown) resolve
  // against a STUB context carrying only blessings + bossOdds — no player, no
  // age. They must read as "not 上升期": their odds are authored (and nerfed by
  // 飞升 5/6 in run.ts) and the final is meant to hurt when you lose. Read
  // defensively rather than relying on `undefined <= 27` short-circuiting.
  const ovr = ctx.player?.overall;
  const age = ctx.age;
  if (ovr === undefined || age === undefined) return false;
  return age <= RISE_MAX_AGE && ovr >= RISE_MIN_OVR && ovr < RISE_MAX_OVR;
}

/** Soften one negative OVR delta for 上升期; positives and 0 pass through. */
function riseSoften(delta: number | undefined): number | undefined {
  if (delta === undefined || delta >= 0) return delta;
  // ceil toward zero, floored at −1 so a penalty never silently vanishes —
  // the cost must still read as a cost (risk stays real, it just stops
  // out-running the growth the player earned).
  return Math.min(-1, Math.ceil(delta * RISE_LOSS_MULT));
}

/** What a resolved branch actually does to the career, in one line a fan reads
 *  without decoding: the ability swing first, then the squad-position swing,
 *  then the honors. Direction comes from the modifier itself, never from the
 *  ResolveResult's narrative `good` flag — a "safe" option that quietly drops
 *  you to the bench must read as the loss it is. */
export function previewLabel(r: ResolveResult): { label: string; good: boolean }[] {
  const m = r.mods;
  const out: { label: string; good: boolean }[] = [];
  const add = (label: string, good: boolean) => { out.push({ label, good }); };

  // 能力变化单一 pill：三段 OVR（即时/生涯/季末）已合并成单个 overallDelta，
  //  期初一次性应用、豁免天花板。净 0 不显示 pill——后果由 statsMultiplier（少踢→
  //  数据/评分缩水→成长与转会触发间接传导）或 roleOverride/标签承载，不再用「即时降、
  //  季末升」的净 0 戏法（玩家心算净效应是负担，不是信息）。PRODUCT 文案守则：去算法注脚，直读「能力 +2」。
  const ovrPill = (delta: number) =>
    delta !== 0 ? add(`${delta > 0 ? "能力 +" : "能力 -"}${Math.abs(delta)}`, delta > 0) : void 0;
  ovrPill(m.overallDelta ?? 0);
  if (m.forceRetire) add("生涯终结", false);
  // 体面退场的传承加成必须显形，否则「接受终结」在卡面上仍然只有纯损失，玩家
  //  读到的还是一个没人会选的选项——代价看得见、收益看不见，等于没改。
  if (m.dignifiedExit) add(`荣誉传承 ×${DIGNIFIED_EXIT_MULT}`, true);
  if (r.injury) add(r.severe ? "重伤" : "伤病", false);
  if (m.forceTrophy) {
    const won = m.forceTrophy.result === "force";
    const what = FORCE_TROPHY_LABELS[m.forceTrophy.trophy] ?? "冠军";
    add(won ? `${what}到手` : `${what}无缘`, won);
  }
  // 国家队大赛的结果覆盖（climax boss）——荣誉线的全部产出，也是 boss 选项卡上
  // 那对预览药丸的来源。放在 forceTrophy 之后、natPart 之前：boss 失败分支的
  // 首要后果是俱乐部赛季陪葬，成功分支的首要后果是奖杯。
  if (m.worldCupResultOverride) {
    const won = m.worldCupResultOverride !== "final";
    add(won ? "夺冠" : "屈居亚军", won);
  }
  // 停赛药丸：一次禁赛只停 1 季（杠杆1：suspended 单季化，不再随节奏放大成 N 季）。
  // 纯展示字符串, 不涉 RNG / 概率。
  if (m.suspended) add("停赛", false);
  // 身份标签显形：只显形「有真实机械效果 + 在球员卡 PERSONA chip 上已可见」
  //  的那几类——玩家既然能在顶栏看到自己「成了什么样的球员」，选项预览就该
  //  提前告知「这条选择会给你贴上/摘下哪个身份」。机械隐患标签（nagging_injury /
  //  doped / cautious_play）按 App.tsx PERSONA_TAG 设计保持隐藏（纯负面隐患，不
  //  上球员卡）；compromised_body 是例外——它既是球员卡可见的身份代价，又有
  //  sim.ts/run.ts 的成长拖累，必须显形。正向身份（fan_darling / captain /
  //  mentor_legend / club_legend）在 sim.ts 都有 standing 加成，是真实收益。
  if (m.addTags?.some((t) => t.split("@")[0] === "compromised_body")) add("带伤隐患", false);
  if (m.addTags?.some((t) => t.split("@")[0] === "fan_darling")) add("球迷宠儿", true);
  if (m.addTags?.some((t) => t.split("@")[0] === "captain")) add("队长袖标", true);
  if (m.addTags?.some((t) => t.split("@")[0] === "mentor_legend")) add("传道者", true);
  if (m.addTags?.some((t) => t.split("@")[0] === "club_legend")) add("功勋球员", true);
  if (m.addTags?.some((t) => t.split("@")[0] === "talisman")) add("护身符", true);
  // naturalized：改换 FIFA 会籍——球员卡上显形的「归化球员」身份 chip，是重大身份转变，
  //  预览该提前告知（与接受/拒绝的取舍直接相关）。rival_betrayal 是纯机械隐患标签，保持隐藏。
  if (m.addTags?.some((t) => t.split("@")[0] === "naturalized")) add("归化球员", true);
  // roleOverride（这一季你是什么角色）与 roleShift（顺位往哪挪）是两个维度，必须
  //  各自显形——之前用 else-if 让 roleOverride 吞掉 roleShift，导致 injury:continue
  //  受阻分支的 roleShift 被藏 → 该分支独有药丸为空 → optionPreview「共同药丸抽进
  //  必定区」条件失败 → 共同后果（沦为替补）撞 3 格上限被截、读成「失败才掉替补」。
  //  改成两个独立 if，同存时都显形（沦为替补 + 位置下滑），共同后果正确入必定区。
  if (m.roleOverride) {
    const up = m.roleOverride === "starter" || m.roleOverride === "high_rotation";
    add(m.roleOverride === "starter" ? "坐稳主力" : up ? "进入轮换" : "沦为替补", up);
  }
  if (m.roleShift) {
    add(m.roleShift > 0 ? "位置上升" : "位置下滑", m.roleShift > 0);
  }
  if (m.nationalTournamentParticipation === "force") add("为国出征", true);
  if (m.nationalTournamentParticipation === "skip") add("退出国家队", false);
  // The trophy multipliers are the most opaque thing an event can do — a player
  // who trades league odds for continental odds deserves to see the trade.
  for (const [field, name] of TROPHY_MULT_LABELS) {
    const mult = m[field];
    if (mult !== undefined && mult !== 1) add(`${name}夺冠 ×${mult}`, mult > 1);
  }
  if (m.statsMultiplier !== undefined && m.statsMultiplier !== 1) {
    add(m.statsMultiplier > 1 ? "出场增加" : "出场减少", m.statsMultiplier > 1);
  }
  if (m.newClubId || m.loanOutTo) add("转投他队", true);
  return out;
}

/** forceTrophy 的奖杯名——预览药丸里「无缘冠军」太笼统，玩家分不清丢的是国家队
 *  奖杯还是俱乐部赛季。只列事件真正会 force/skip 的那几座。 */
const FORCE_TROPHY_LABELS: Record<string, string> = {
  league: "联赛", domestic_cup: "杯赛", continental_primary: "洲际", world_cup: "世界杯",
};

const TROPHY_MULT_LABELS = [
  ["leagueTrophyProbabilityMultiplier", "联赛"],
  ["domesticCupTrophyProbabilityMultiplier", "杯赛"],
  ["continentalPrimaryTrophyProbabilityMultiplier", "洲际"],
  ["continentalSecondaryTrophyProbabilityMultiplier", "洲际次级"],
] as const satisfies readonly (readonly [keyof Modifiers, string])[];

/** 倍率族字段——中性值是 1（types.ts 的字段注释即如此定义），不是 0。 */
const NEUTRAL_AT_ONE = new Set<string>([
  "statsMultiplier",
  "leagueTrophyMult", "continentalTrophyMult",
  "leagueTrophyProbabilityMultiplier", "domesticCupTrophyProbabilityMultiplier",
  "continentalPrimaryTrophyProbabilityMultiplier", "continentalSecondaryTrophyProbabilityMultiplier",
  "clubWorldCupTrophyProbabilityMultiplier",
]);
/** 这个字段虽然在场，但取的是「什么也没做」的值吗？
 *
 *  previewLabel 对中性值不产药丸是对的（types.ts: overallDelta「净 0 不设」、
 *  statsMultiplier「默认 1」），所以 previewBranch 的 guard 不能改用
 *  `Object.keys(mods).length` 来判断「有没有效果」——一个 resolver 若先减后加
 *  写成净 0（reckless_challenge:own_it 的 +1/−1、lost_instinct:find_it 的 −2/+2），
 *  mods 里就留下一个 `overallDelta: 0`：有键、无药丸。guard 把它读成「未建模的
 *  效果」→ 整个选项的预览被丢掉，连**另一条分支**的真实代价一起吞掉。玩家实测
 *  上报的正是这个形态：射门消失的「拼命找回来」只剩一个孤零零的 25%，而失败分支
 *  的 能力−5 / 带伤隐患 一个字都看不到。
 *
 *  只有类型层明确定义为中性默认的取值才算「没做事」——这个方向是安全的：宁可把
 *  一个真效果当成未建模（退回 null，保守），也不能把它当成 无变化（撒谎）。 */
function isNeutralMod(field: string, v: unknown): boolean {
  if (v === undefined || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (NEUTRAL_AT_ONE.has(field)) return v === 1;
  if (field === "overallDelta" || field === "roleShift") return v === 0;
  return false;
}
/** 这份 mods 里有没有任何真实效果（而不只是「有键」）。 */
function hasEffectiveMod(mods: Modifiers): boolean {
  return Object.entries(mods).some(([k, v]) => !isNeutralMod(k, v));
}

/** Resolve one option's branch twice under independent throwaway RNG streams;
 *  keep the label only if both agree (a randomly-sized outcome must not be
 *  advertised as a fixed number — the odds are the hero, and a wrong number is
 *  worse than none). Never touches the real resolve stream. */
function previewBranch(
  ctx: EventContext, key: string, optionKey: string,
  forced: "positive" | "negative", prob: number | undefined, cap: number,
): ChoicePreview[] | null {
  let first: { label: string; good: boolean }[] | null = null;
  for (const salt of ["p1", "p2"]) {
    let seen: { label: string; good: boolean }[];
    try {
      const r = resolveEventOption(derive(`preview:${salt}`, key, optionKey), key, optionKey, ctx, forced);
      seen = previewLabel(r);
      // Nothing nameable came back. That means "no change" only if the branch
      // set no modifier that actually DOES anything; an effect this vocabulary
      // doesn't model yet (a status tag, a loyalty flag) must fall back to the
      // authored sub line rather than be advertised as 无变化. A field sitting
      // at its neutral value (overallDelta 0 / statsMultiplier 1 / 空 addTags)
      // is not such an effect — see isNeutralMod.
      if (seen.length === 0) {
        if (hasEffectiveMod(r.mods)) return null;
        seen = [{ label: PREVIEW_NO_CHANGE, good: true }];
      }
    } catch { return null; }
    if (first === null) first = seen;
    else if (first.map((x) => x.label).join() !== seen.map((x) => x.label).join()) return null;
  }
  if (!first) return null;
  // The probability that scopes this branch lives on the cluster label
  //  (ChoiceRollPreview.winProb), not on individual pills — one roll decides
  //  the whole branch, and stamping % only on the first pill left a no-% pill
  //  (a co-effect like 坐稳主力) reading as a standalone outcome. `prob` is
  //  kept on the signature for parity with the caller but no longer attached.
  void prob;
  return first.slice(0, cap).map((x) => ({ good: x.good, label: x.label }));
}

/** Display caps: a mobile card can show a few pills per zone before the card
 *  grows past thumb height. The certain zone and each roll cluster are capped
 *  independently. FULL is the pre-extraction cap — high enough that a branch's
 *  guaranteed effects (which may sit deep in previewLabel's order, e.g. 为国出征
 *  after several OVR/injury pills) are NOT dropped before the common-pill
 *  extraction can pull them into the certain zone. Display caps are applied
 *  AFTER extraction, so a guaranteed effect is never misclassified as a
 *  branch-unique pill just because it sat past the display cap in one branch. */
const PV_CAP_CERTAIN = 3, PV_CAP_ROLL = 4, PV_CAP_FULL = 16;
/** 被掏空的骰子簇的落点。中性档(既非利好也非利空)，跑马灯照常停靠。 */
const NO_EXTRA_PILLS: readonly ChoicePreview[] = [{ good: true, label: PREVIEW_NO_EXTRA }];
const SUMMARY_PREVIEW_EVENTS = new Set([
  "injury",
  "injury_at_peak",
  "injury_before_tournament",
  "career_threatening_injury",
  "injury_relapse",
]);
// PV_CAP_ROLL=4（非 3）：4 效果分支（如 injury:play_through 失败：−5/重伤/沦为替补/
//  带伤隐患）不得截掉真实效果——判决牌（不封顶）否则会露出卡片藏掉的药丸，
//  重现「卡片↔判决牌对不上」。

/** The pills shown under an option, split into a guaranteed `certain` zone
 *  and a probabilistic `roll` fork so the decision card never mixes a fixed
 *  effect into a gamble's branches (the IA bug: a no-% pill sitting between
 *  two % pills read as a standalone roll outcome when it was either a
 *  guaranteed effect or a branch co-effect).
 *  - Deterministic option (odds undefined): `certain` = its whole outcome,
 *    `roll` undefined. No gamble → no %, just a 必定 zone.
 *  - Rolled option: resolve both branches. If the two branches are identical
 *    (the dice only picks prose, e.g. silent_fall) → `certain` = that set,
 *    `roll` undefined (no gamble to display). Otherwise pull the pills
 *    COMMON to both branches into `certain` (a guaranteed consequence must
 *    not be shown as if it were one of the dice's outcomes) — but ONLY when
 *    each branch still keeps a UNIQUE pill after extraction; a branch that is
 *    a pure subset of the other (e.g. injury_at_peak:play_injured, where success
 *    is failure minus the bad stuff) is left clustered, because emptying a
 *    cluster leaves the reveal marquee nowhere to land and the subset
 *    relationship is itself honest when scoped by each cluster's %. */
/** Headless switch for batch simulation (tools/). Preview pills are pure
 *  display: previewBranch dry-runs resolveEventOption on its OWN rng streams
 *  (`derive("preview:p1"/"preview:p2", …)`), so it can neither read nor
 *  advance the career's RNG — dropping it cannot change a single outcome.
 *  It IS ~39% of headless sim CPU (8 full resolves per event, just to draw
 *  pills nobody reads in a probe). `tools/_harness.ts` turns it off; the app
 *  never touches it. tools/regress.ts asserts on/off produce identical career
 *  digests, so this stays honest. */
let previewsEnabled = true;
export function setPreviewsEnabled(on: boolean): void {
  previewsEnabled = on;
}

function optionPreview(ctx: EventContext, key: string, optionKey: string, odds: number | undefined): { certain: readonly ChoicePreview[]; roll?: ChoiceRollPreview } {
  if (!previewsEnabled) return { certain: [] };
  if (odds === undefined) {
    const det = previewBranch(ctx, key, optionKey, "positive", undefined, PV_CAP_CERTAIN);
    return { certain: det ?? [] };
  }
  // Resolve both branches at a high cap first so the common-pill extraction
  //  sees the FULL branch (a guaranteed effect deep in previewLabel's order
  //  must be found before it can be pulled into 必定). Display caps apply after.
  const win = previewBranch(ctx, key, optionKey, "positive", odds, PV_CAP_FULL);
  const lose = previewBranch(ctx, key, optionKey, "negative", 1 - odds, PV_CAP_FULL);
  if (!win || !lose) return { certain: [] };
  const key2 = (p: ChoicePreview) => `${p.label}|${p.good}`;
  const winKeys = new Set(win.map(key2));
  const loseKeys = new Set(lose.map(key2));
  const winOnly = win.filter((p) => !loseKeys.has(key2(p)));
  const loseOnly = lose.filter((p) => !winKeys.has(key2(p)));
  // Both branches identical → the dice only chooses prose; show the certain
  //  outcome (no gamble to display), not two same clusters with a fake fork.
  if (winOnly.length === 0 && loseOnly.length === 0) return { certain: win.slice(0, PV_CAP_CERTAIN) };
  // Guaranteed (common) + win-unique + lose-unique. A pill present in BOTH
  //  branches happens no matter how the dice fall, so it belongs in 必定 —
  //  including when that empties one cluster, which is exactly the shape of
  //  "certain damage, with a chance of something extra" (career_threatening_
  //  injury:rehab_war: both branches take −8 OVR / 重伤 / 停赛 / 带伤隐患, and
  //  only success adds 季末 +6). This case used to fall through to the
  //  full-branch fallback below, which lied twice: it painted those four
  //  guaranteed consequences as 45%/55% dice outcomes, and PV_CAP_ROLL then
  //  truncated 带伤隐患 off the win cluster — the card/判决牌 mismatch that cap
  //  exists to prevent. An emptied cluster gets an explicit 无额外后果 pill so
  //  the reveal marquee still has a landing target and the branch never reads
  //  as "nothing happens to you" (the 必定 cost is still paid).
  const common = win.filter((p) => loseKeys.has(key2(p)));
  if (common.length > 0) {
    return {
      certain: common.slice(0, PV_CAP_CERTAIN),
      roll: {
        winProb: odds,
        win: winOnly.length > 0 ? winOnly.slice(0, PV_CAP_ROLL) : NO_EXTRA_PILLS,
        lose: loseOnly.length > 0 ? loseOnly.slice(0, PV_CAP_ROLL) : NO_EXTRA_PILLS,
      },
    };
  }
  // Genuinely disjoint branches — nothing to extract. Keep both clustered in
  //  full; each cluster's % label scopes it.
  return { certain: [], roll: { winProb: odds, win: win.slice(0, PV_CAP_ROLL), lose: lose.slice(0, PV_CAP_ROLL) } };
}

function buildEvent(
  ctx: EventContext,
  key: string,
  title: string,
  desc: string,
  options: readonly EventOption[],
  rarity?: Rarity,
): FiredEvent {
  // Baseline invariant: every event is a real choice — ≥2 options. A single-
  //  option "dock" is a fake decision (no alternative → no trade-off), so it
  //  must never reach the UI. Throws in dev/build if a catalog entry or a
  //  direct buildEvent call slips through with one option.
  if (options.length < 2) throw new Error(`event ${key} needs >=2 options (baseline: every event is a real choice)`);
  // Per-option odds: each option that rolls gets its OWN success % (mirroring
  // that option's resolve roll, incl. iron_lungs / big_game_player) shown as a
  // sub % + a win/lose preview pill pair; a deterministic option shows only its
  // single outcome pill. There is deliberately NO event-level odds — the two
  // options of one event often roll different probabilities, and a single
  // number can't represent the option the player actually picks.
  const choices: Choice[] = options.map((o) => {
    const raw = optionOdds(key, o.key, ctx);
    const shown = raw !== undefined ? ascensionOdds(key, ironLungsOdds(key, bigGameOdds(key, raw, ctx.blessings), ctx.blessings), ctx.ascension) : undefined;
    return {
      id: o.key,
      kind: "event_option",
      text: o.text,
      sub: o.sub ?? (shown !== undefined ? `${pct(shown, ctx.blessings)}` : undefined),
      // 选队权选项带 clubId → UI 画出队徽，和转会窗的选项长一个样
      ...(o.clubId ? { clubId: o.clubId } : {}),
      ...(SUMMARY_PREVIEW_EVENTS.has(key) ? { effectsLayout: "summary" as const } : {}),
      ...optionPreview(ctx, key, o.key, shown),
    };
  });
  return {
    event: { key, title, desc, choices, eventKey: key, variantKey: ctx.variantKey, slotAge: ctx.slotAge, injuryType: ctx.injuryType, bossOdds: ctx.bossOdds, rarity },
    resolve: (choice, rng) => resolveEventOption(rng, key, choice.id, ctx),
  };
}

// ───────────────────────────── calendar-truth helpers ─────────────────────────────
// Several "大赛前" / "回国" events used to narrate a tournament or a home
// move that the trigger conditions never checked — a desc that says "距离
// 世界杯只剩两周" fired in any season, and "回家" routed a Croatian to a
// Spanish club. These helpers let an event gate/phrase itself against the
// career's actual calendar and the nation's actual leagues.

/** Detect whether a national-team tournament year falls in the upcoming
 *  period — mirrors run.ts's climax block (世界杯 for strong nations, the
 *  continental cup for minnow nations, phase-shifted by `tournamentOffset`).
 *  Returns the tournament age (a season within [age, age+periodLength)) or
 *  undefined. An event that narrates "大赛前" must only fire when a 大赛 is
 *  actually upcoming — otherwise the desc asserts a tournament the calendar
 *  doesn't back. */
function upcomingTournamentYear(ctx: EventContext): number | undefined {
  const toff = ctx.tournamentOffset ?? 0;
  const pl = ctx.periodLength ?? 1;
  const wcBase = 19 + toff;
  const contBase = wcBase - 1;
  const nation = nationById(ctx.player.nationalityId);
  const fifaRep = Math.max(0, Math.min(5, nation.fifaRep));
  const contRep = Math.max(0, Math.min(6, nation.contRep));
  const isMinnow = fifaRep <= 1 && contRep <= 2;
  const targetBase = isMinnow ? contBase : wcBase;
  for (let a = ctx.age; a < ctx.age + pl; a++) {
    if (a >= targetBase && (a - targetBase) % 4 === 0) return a;
  }
  return undefined;
}

/** The national tournament a nation chases — 世界杯 for strong nations, the
 *  continental cup (亚洲杯/非洲杯/…) for minnow nations whose realistic dream
 *  is the continental cup, not a WC final. Matches the climax block's
 *  strong/minnow split so an event's prose names the SAME tournament the
 *  career actually contests. */
function nationalTournamentName(ctx: EventContext): string {
  const nation = nationById(ctx.player.nationalityId);
  const fifaRep = Math.max(0, Math.min(5, nation.fifaRep));
  const contRep = Math.max(0, Math.min(6, nation.contRep));
  const isMinnow = fifaRep <= 1 && contRep <= 2;
  if (isMinnow) return CONT_CUP_NAME[nation.confederation] ?? "洲际杯";
  return "世界杯";
}

/** Whether the player's nation has a tier-1 league whose country matches the
 *  nation — i.e. there is an actual club "回家" can send him to. Many nations
 *  (克罗地亚/比利时/塞内加尔/…) have no league entry, so "回国踢球" would
 *  silently route him to a different country in the same confederation. This
 *  lets return_home frame the move honestly (home country vs home continent). */
function nationHasHomeLeague(nationalityId: string): boolean {
  const nation = nationById(nationalityId);
  return LEAGUES.some((l) => l.tier === 1 && l.country.toLowerCase() === nation.id);
}

// Eligibility gates mirror the target Zr. Some events (club_priority,
// relegation_loyalty, return_home, giant_tattoo, controversial_statement,
// injury, world_cup_showdown, qualifier_showdown) are triggered by other code
// paths, not by rollRandomEvent — but we keep their defs for fireEventByKey.

export const EVENT_DEFS: EventDef[] = [
  makeEventDef("training_extra", "季前特训", "休赛期第一天，体能教练把你单独留下。\n「你的爆发力还差一截，加练一个月体能，赛季就能多打15场。但这会透支你的身体——练废了就没人救你。」\n训练场上只剩你和一架发烫的跑步机。", 4, (ctx) => ascensionCanTrain(ctx.ascension) && ctx.age <= 30 && clusterFired(ctx, WIDE_MID) < WIDE_MID_BUDGET,
    [{ key: "accept", text: "咬牙加练，赌一把上限" }, { key: "reject", text: "按计划来，不冒险" }]),
  makeEventDef("personal_coach", "私人教练", "一位曾培养出金球先生的私人名帅找到你。\n「你有天赋，但缺最后的打磨。我带你不收钱，只要你听我的。不过——我的方法激进，可能让你脱胎换骨，也可能毁了你。」\n桌上摆着一份充满条款的合同。", 4, (ctx) => ascensionCanTrain(ctx.ascension) && ctx.player.overall >= 65 && ctx.age <= 32 && clusterFired(ctx, WIDE_MID) < WIDE_MID_BUDGET,
    [{ key: "accept", text: "签下合同，押上职业生涯" }, { key: "reject", text: "婉拒，保持现状" }]),
  makeEventDef("mysterious_substance", "神秘补剂", "赛后队医把你拉到角落，递来一瓶无标签的暗色液体。\n「这是合法的——技术上合法。能让你下赛季进球数翻倍。但万一查出问题……那就是另一回事了。」\n你的手心渗出汗水。", 4,
    (ctx) => ctx.age >= 22 && ctx.age <= 30 && clusterFired(ctx, WIDE_MID) < WIDE_MID_BUDGET,
    [{ key: "consume", text: "一饮而尽，抓住机会" }, { key: "reject", text: "推回去，不为所动" }]),
  makeEventDef("season_load", "赛季负荷", "赛程表像一面墙压下来——三线作战，一周双赛持续两个月。\n主帅在更衣室扫视一周，目光停在你身上：「你能扛，但要不要扛是你的事。多踢就能进金球名单，也随时可能伤到报销。」\n队友们沉默地看着你。", 4, (ctx) => isHighRole(ctx.role) && ctx.age >= 20 && ctx.age <= 32 && clusterFired(ctx, WIDE_MID) < WIDE_MID_BUDGET,
    [{ key: "accept", text: "扛起全队，向荣誉冲锋" }, { key: "stay_calm", text: "留力，不为赛季赌上一切" }]),
  makeEventDef("position_change", "改打位置", "主帅把你叫到办公室，在战术板上画了又擦。\n「你在现在的位置已经到了天花板。如果你愿意改打新位置，可能柳暗花明，也可能直接把自己废了。」\n战术板上两个箭头，通向不同的未来。", 4, (ctx) => ctx.player.position !== "GK" && ctx.age >= 19 && ctx.age <= 30 && clusterFired(ctx, WIDE_MID) < WIDE_MID_BUDGET,
    [{ key: "accept", text: "改打新位置，破而后立" }, { key: "reject", text: "坚守老本行，不为所动" }]),
  makeEventDef("position_competition", "位置竞争", "转会窗关闭前最后一刻，俱乐部砸重金买来了一个和你同位置的球员。\n他穿着你的号码，在训练中击落了你的所有数据。主帅在新闻发布会上说：「竞争是好事。」\n首发名单明天就出。", 35, (ctx) => isHighRole(ctx.role),
    // 让位 = 一次转会：去哪家由玩家挑（同联赛降档、能踢主力的三家），
    // 不再由引擎替他选一支。没有可降的档次时退回单一「主动让位」选项。
    (ctx) => {
      const dests = stepAsideDestinations(ctx);
      return [
        { key: "compete", text: "死磕到底，拼回主力" },
        ...(dests.length > 0
          ? clubOptions(ctx, dests, (c) => `让位，转投${c.name}`)
          : [{ key: "step_aside", text: "主动让位，去别处踢上主力" }]),
      ];
    }),
  makeEventDef("unexpected_prospect", "新秀崛起", (n) => `青训营提拔上来的小孩在训练中过了你三次。\n他比你小一大截，比你快，比你轻，笑起来露出虎牙。教练在新闻发布会上说：「他是俱乐部的未来。」\n你看着他在场上奔跑的样子，像极了刚来${n.club}时的你。你可以让位给他，也可以死守你的位置——但那会压住他的未来。`, 8,
    (ctx) => ctx.age > 22 && isHighRole(ctx.role),
    [{ key: "mentor", text: "主动让位，给年轻人腾出空间" }, { key: "hold_ground", text: "死守位置，谁也别想挤走我" }]),
  makeEventDef("rival_offer", "死敌邀约", "联赛死敌的体育总监在你家门口等到深夜。\n「我们给你三倍薪水，主力保证，还有一座等你捧起的奖杯。」\n但你的球迷会烧你的球衣，你的名字将在母队球迷口中变成叛徒。经纪人问你：你想要奖杯，还是想要爱？", 25,
    (ctx) => ctx.role === "starter" && ctx.club.rep >= 5,
    [{ key: "accept", text: "转投死敌，背叛换荣誉" }, { key: "reject", text: "拒绝，有些东西比奖杯重" }]),
  makeEventDef("club_crisis", "俱乐部危机", "俱乐部主席在更衣室里红着眼眶宣布：工资发不出来了。\n赞助商跑了，债务压顶，但你是这支球队最后的旗帜。留下，意味着工资腰斩、荣誉归零；离开，意味着亲手推落最后一根稻草。\n队友在角落里低头看着手机，没人说话。", 45,
    // 工资发不出来 = 贫困联赛(wealth 低) + 中小俱乐部(rep 低)的故事。
    // 排除：wealth>=0.8 的富豪联赛(沙特2.0/英超1.35/西意德甲1.0+/中超0.9)与
    // rep>=5 的豪门——这些俱乐部财力雄厚，不可能欠薪/破产。只留在葡超/荷甲/
    // 土超/苏超/希腊超/瑞士超/奥甲/捷克甲/波兰甲/乌超/墨甲/埃及超/巴甲/阿甲/
    // 英冠/西乙/中甲/日职联/K联赛/巴乙等真会发不出工资的联赛里的中小俱乐部。
    // 修复前门控是 rep>=3（反而把曼城/皇马/沙特都放进来、把小球会挡在门外）。
    (ctx) => ctx.club.rep <= 4 && ctx.league.wealth <= 0.7,
    // 离队 = 一次转会：跳到同联赛不沉的船，去哪家由玩家挑。联赛里没有别的
    // 俱乐部时（理论兜底）退回单一「离队」选项，保证事件永远 ≥2 个选项。
    (ctx) => {
      const dests = crisisLeaveDestinations(ctx);
      return [
        { key: "stay_and_fight", text: "留下，陪着球队坠入深渊" },
        ...(dests.length > 0
          ? clubOptions(ctx, dests, (c) => `离队，转投${c.name}`)
          : [{ key: "leave", text: "离队转会，不陪葬这段沉沦" }]),
      ];
    }),
  makeEventDef("fan_backlash", "球迷倒戈", "上一场的失误被做成集锦传遍全网。死忠看台打出了你的名字——涂上了黑色叉号。\n社交媒体上的人都在骂你，街头有人认出你后吐了口水。主帅说会给你时间，但更衣室里没人愿意和你同桌吃饭了。\n你站在球员通道口，听着一墙之隔的嘘声。", 35, (ctx) => ctx.age >= 24 && ctx.age <= 34,
    [{ key: "stay_and_fight", text: "走出去，顶着嘘声上场" }, { key: "demand_exit", text: "申请转会，离开这座球场" }]),
  makeEventDef("new_coach", "新帅上任", "新教练上任第一天，把全队叫到一起。\n「我只用听话的球员。你们我都不认识——状态、忠诚、脾气，全是空白的。」他的目光在你身上停了两秒，没说话就走了。\n助理教练塞给你一张纸条：「他想要首发名单，你只有这周的训练时间证明自己。」", 4, (ctx) => isHighRole(ctx.role) && ctx.age <= 33 && clusterFired(ctx, WIDE_MID) < WIDE_MID_BUDGET,
    [{ key: "stay_and_fight", text: "用训练回击质疑" }, { key: "talk_it_out", text: "找新帅坦谈一次，按他的要求改" }]),
  // 降级去留 (contextual — fired by run.ts on relegation). stay_and_fight is
  // the player's own choice (relegation doesn't force a leave — staying for the
  // 冲超 is a real arc); leave offers up to 3 争冠 clubs to PICK from (the 选队权
  // the user asked for, not a random single destination) — clubs at/above the
  // current rep in the same league where he'd be a starter/high_rotation.
  {
    key: "relegation_loyalty",
    title: "降级去留",
    desc: "终场哨响，记分牌上写着0-4。主场球迷哭成一片，有人翻过栅栏冲你吼——「你就这么走了？」\n更衣室里没有一个人说话。主帅收拾了东西走了，留下你一个人面对这个问题：降级了，走还是留？",
    weight: 100,
    eligible: () => false,
    build: (ctx) => relegationFiredEvent(ctx),
  },
  // 王座之战 (mechanics review): contextual — fired by run.ts for 85+ starters
  // aged 29+ at big clubs. eligible() is false to stay out of the random pool.
  makeEventDef("throne_challenge", "王座之战",
    "俱乐部官宣了新援——和你同位置，比你年轻十岁，转会费刷新队史纪录。\n发布会上他说：「我来这里，是为了成为最好的。」镜头齐刷刷转向看台上的你。\n更衣室里你的储物柜还在正中央。能守多久，看这个赛季。", 0,
    () => false,
    [{ key: "defend", text: "王座是我的——用每一分钟去守" },
     { key: "yield", text: "时候到了，把位置和经验一起交给他", sub: "让位 · 传承 +8" }], "rare"),
  makeEventDef("contract_nonrenewal", "不再续约", "体育总监的办公室很安静。他把一份文件推过桌面，没看你的眼睛。\n「俱乐部决定不再和你续约。你还有半年合同——你可以留下踢完，也可以现在就找下家。」\n走廊里贴着球队的全家福，你在第三排的边上。你在这里坐了太久的板凳，久到他们觉得你的位置可以省下来。", 100,
    () => false, // contextual: fired by run.ts at age 26+ on a bench role
    [{ key: "drop_down", text: "降档转会，去能踢上主力的地方" }, { key: "stay_and_fight", text: "留下拼到合同最后一天" }]),
  // 豪门扫地出门 (contextual — fired by run.ts for a starter/high-rotation
  // player at a big club rep≥6 underperforming the standard). eligible() is
  // false to stay out of the random pool; the trigger (shouldTriggerUnderperformance)
  // + age/role/tag gates live in run.ts. find_new_club is a deterministic 降档
  // (dest revealed in the outcome, like contract_nonrenewal); prove_yourself
  // rolls 40% (optionOdds above). weight 0 signals contextual (like throne).
  // 豪门扫地出门 (contextual — fired by run.ts for a player at a big club
  // rep≥6 whose rating stayed below the club's standard). eligible() is false
  // to stay out of the random pool; the trigger (shouldTriggerForcedExit) +
  // age/tag gates live in run.ts. FORCED transfer — NO prove_yourself / 留队
  // escape hatch (the user's ask: data barren to the trigger line = you must
  // go). The options are up to 3 降档 clubs built dynamically from the player
  // (the 选队权 the user asked for — leave shouldn't randomly assign one
  // club), each set up as 主力 so he can play and grow. underperformed@4 is the
  // anti-repeat; fresh_contract pauses the 33+ retention roll.
  {
    key: "underperform_release",
    title: "扫地出门",
    desc: "体育总监没有让你坐下。他把这几轮的剪辑带推过来——停球失误、跑位慢半拍、该传的球没传。\n「你配得上这件球衣吗？」他没等你回答。「这家俱乐部的标准，不是靠过去的名字撑的。最近两个赛季，你的表现……」他顿了顿，「我们不会再等了。你走吧——挑一支愿意要你的球队。」",
    weight: 0,
    eligible: () => false,
    build: (ctx) => forcedExitFiredEvent(ctx, "underperform_release"),
  },
  // 及时止损 (踢不出来 / 水土不服): contextual — fired by run.ts when a
  // player's rating stayed below the club's standard for ≥2 seasons. eligible()
  // is false to stay out of the random pool; the trigger (shouldTriggerForcedExit)
  // + age/tag gates live in run.ts. The 豪门青训 bench route is LOANED
  // (loan_offer) before reaching here — so stuck_release is the 降档转会 fork
  // for everyone else (small club, over-24, or a barren starter). FORCED
  // transfer — no fight_for_spot / 留队 escape hatch. The options are up to 3
  // 降档 clubs built dynamically (the 选队权 the user asked for), each set up
  // as 主力. stuck@4 is the anti-repeat; fresh_contract pauses the 33+
  // retention roll.
  {
    key: "stuck_release",
    title: "踢不出来",
    desc: "你坐在更衣柜前，本赛季的数据单攥在手里——出场少得可怜，进球助攻一栏是空的。\n已经第二个赛季了。你在这支球队找不到自己的位置：战术不适配、出场时间碎成渣、每次上场你都在证明自己，但每次证明都失败。\n经纪人打来电话：「换个环境吧。有俱乐部愿意让你踢主力——不是这里，但你能上场，能重新开始。」你看了一眼训练场的方向，那里已经没有你的位置了。",
    weight: 0,
    eligible: () => false,
    build: (ctx) => forcedExitFiredEvent(ctx, "stuck_release"),
  },
  makeEventDef("club_priority", "赛季重心", "赛季开始前，主帅把你叫到战术室。墙上贴着两张赛程表。\n「我们的阵容深度撑不起两线作战。你是更衣室的声音——你觉得，这个赛季我们把血押在哪边？」\n一边是联赛的漫长征途，一边是洲际之夜的聚光灯。", 40,
    (ctx) => ctx.role === "starter" && ctx.club.rep >= 5 && ctx.league.tier === 1,
    [{ key: "prioritize_league", text: "押联赛——冠军是一整年的证明" }, { key: "prioritize_continental", text: "押洲际——大场面才配大球员" }]),
  // 回国踢球: the aging-abroad star comes home. But "home" only has a
  // club to come home TO when the nation has a tier-1 league — a Croatian or
  // Senegalese has no home league, so the resolve routes him to a same-
  // confederation club (a different country). The desc + outcome frame that
  // honestly: "回家" when a home league exists, "回到家乡所在的大洲" when it
  // doesn't, instead of claiming "回家/母国" for a move that lands elsewhere.
  makeEventDef("return_home", "回国踢球", (_n, ctx) => {
      return nationHasHomeLeague(ctx.player.nationalityId)
        ? "母国的几家俱乐部同时托人送来了信和机票。\n「家里人都想你了，孩子。回来吧，待遇虽然不如外头，但你是这里的英雄。这里每个人都在等你回来。」信纸边角被揉皱了，像是写了又撕撕了又写。\n你看着摊在桌上的几张机票，和信封上那几枚熟悉的队徽。"
        : "母国没有一支接得住你的职业俱乐部——但同一片大陆上，有人还记得你从哪里来。几封信和机票送到了你手上：「回来吧，待遇不如外头，但这片大陆记得你是谁。在这里，你是英雄。」信纸边角被揉皱了，像是写了又撕撕了又写。\n你看着摊在桌上的几张机票。";
    }, 45,
    (ctx) => ctx.age >= 30 && nationById(ctx.player.nationalityId).confederation !== ctx.league.confederation,
    // 回哪支球队由玩家挑（母国联赛的三家；母国没联赛则母洲的三家）——事件
    // 描述承诺的范围就是候选范围。母洲连一家俱乐部都没有（大洋洲）时，只剩
    // 「回去挂靴」这条诚实的路：没有球队可回，回去就是退役。
    (ctx) => {
      const dests = homecomingDestinations(ctx);
      return [
        { key: "stay_abroad", text: "留在海外，梦想还没完" },
        ...(dests.length > 0
          ? clubOptions(ctx, dests, nationHasHomeLeague(ctx.player.nationalityId)
            // 母国有联赛 → 真的「回」；没有 → 只是回到那片大陆，别写成回国
            ? (c) => `回${c.name}，做那里的英雄`
            : (c) => `去${c.name}，回到那片大陆`)
          : [{ key: "accept", text: "接过机票，回去挂靴", sub: "没有球队可回 · 以传奇的身份告别" }]),
      ];
    }),
  makeEventDef("giant_tattoo", "巨幅纹身", "赞助商的合同摊在桌上，附带着一张设计图：从肩膀到脚踝的巨幅纹身，是他们的品牌图腾。\n「百万欧元代言费，但纹身必须保留十年，上不了身就不能擦掉。」经理说，「十个球员里有九个拒绝，拒绝的就拿不到代言。」\n你看着纹身图样想：这会和你的身体融为一体。", 35,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 26,
    [{ key: "accept", text: "签下合约，让品牌印在身上" }, { key: "reject", text: "拒绝，身体是自己的" }]),
  // P-A21: the fall from the peak — the moment a player realizes they're no longer
  // what they were (Kaká's lost acceleration, the freight train that slowed).
  // 坠落时刻: the desc used to say 「里面的人和金球照片上的那个人不太一样了」——
  // implying the player WON a Ballon d'Or, but the gate is just OVR≥82/age≥28
  // (no award check). A top player who never won the Ballon d'Or got a desc
  // about a trophy he never held. Reframed to 「巅峰照片」——the decline from
  // YOUR OWN peak, honest for any fading star, no unverifiable award claim.
  makeEventDef("fall_from_grace", "坠落时刻", "你在训练中做了一百次的过人动作——但这一次你过不去了。\n不是他防得好，是你慢了。你看到了：你曾经能追上的球现在追不上了，你曾经能过掉的人现在过不掉了。你的队友什么也没说，但他们的眼神你看得懂——他们也发现了。\n你坐在更衣室里看着镜子，里面的人和巅峰照片上的那个人不太一样了。", 40,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 28,
    [{ key: "reinvent", text: "重新定义自己，找到新的踢法" }, { key: "deny", text: "不可能，只是状态起伏，我要练回来" }]),
  // P-A21: dressing room politics — a clique, a scapegoat, the locker room split.
  makeEventDef("dressing_room_split", "更衣室分裂", "更衣室里有一半人不跟另一半说话了。\n起因是上一个转会窗的事——有人说你配合走人，有人说你叛变了。现在训练场上两组人各热各的，吃饭坐两桌。主帅装作看不见，但你知道他在等你自己解决。\n你是球队里唯一两边都还说话的人。", 8,
    (ctx) => isPrime(ctx) && isHighRole(ctx.role),
    [{ key: "mediate", text: "当那个把两边拉回来的人" }, { key: "pick_side", text: "选择一边，划清界限" }]),
  // P-A21: personal life — when your marriage starts affecting your football.
  makeEventDef("family_strain", "家庭裂痕", "你的妻子在深夜等你回家，但你刚从客场回来，明天又要走。\n「你很久没陪孩子了。」她的声音不是在责备，是在陈述事实。你看着她——你想起你踢球是为了这个家，但现在踢球让你失去了这个家。\n桌上是一份你忘了签的家长会通知单。", 15,
    (ctx) => ctx.age >= 26 && ctx.player.overall >= 75,
    [{ key: "family_first", text: "多陪家人，足球不是全部" }, { key: "stay_focused", text: "赛季关键期，家人会理解的" }]),
  makeEventDef("tax_trouble", "税务风波", "凌晨，律师的电话把你叫醒。\n「你被起诉了，涉嫌逃税。媒体已经拿到消息了。」律师的声音很冷静。「金额是你一整年的薪水，认罪能少一半，不认罪就上法庭——你的名字会上每一个头条。」\n窗外的记者已经开始排队了。", 8,
    (ctx) => {
      const nat = nationById(ctx.player.nationalityId);
      // "abroad" ≈ playing in a league whose country isn't the player's nation
      // (data uses uppercase FIFA codes for league.country; nation ids are
      // lowercase — compare by confederation divergence as the abroad proxy).
      return !!nat && nat.confederation !== ctx.league.confederation && clusterFired(ctx, WIDE_MID) < WIDE_MID_BUDGET;
    },
    [{ key: "stay_and_fight", text: "请最好的律师，正面对抗" }, { key: "settle", text: "认罪和解，花钱消灾息事" }]),
  makeEventDef("foreign_grandfather", "祖籍召唤", "一张泛黄的老照片从信封里滑出来——你的祖父年轻时的样子，穿着另一个国家队的球衣。\n那个国家足协的人找到你：「你的祖籍在这里，法律上你可以为我们出战。我们比你的母国强，但你的母国更需要你。」\n照片背面是一行祖父的笔迹，已经模糊了。", 25,
    // real gate (was `() => false`, unreachable): a promising young player
    // from a weak footballing nation — the strong-nation offer only tempts
    // when it actually upgrades the WC path.
    (ctx) => ctx.age <= 23 && ctx.player.overall >= 68 && nationById(ctx.player.nationalityId).fifaRep <= 2,
    [{ key: "switch_national_team", text: "改换国籍，为更强的队出战" }, { key: "keep_national_team", text: "保留原籍，忠于母国" }]),
  // 归化邀约：已退出国家队会籍（intl_retired tag）的球员，被一个更强的
  // 他国足协看中，提出归化。与祖籍召唤的区别：祖籍是血脉权（年轻、弱国），
  // 归化是居住权/契约权（退出国家队后、俱乐部表现出色被看重）。复用
  // newNationalityId 机制切 FIFA 会籍。Contextual 触发（eligible: () => false
  // 移出随机池），由 buildPeriodDecisions 带概率门地检查——保留「不一定来」
  // 的张力，但不被淹没在随机事件池里。
  makeEventDef("naturalization_offer", "归化邀约", (_n, ctx) => ctx.naturalizationActive
    ? "一封印着足协徽章的信送到了你家。「我们一直在关注你。」信的开头这样写。\n「你的实力配得上更大的舞台——但你现在的国家队，配不上你。我们愿意为你启动归化程序，效力满规定年限后你可以为我国出战。这不是退路，是野心。」信的末尾是一行小字：「你愿意为世界杯再赌一次吗？」"
    : "一封印着足协徽章的信送到了你家。「我们一直在关注你。」信的开头这样写。\n「你的实力配得上更大的舞台。我们愿意为你启动归化程序——效力满规定年限后，你可以为我国出战。你现在的国家队会籍……听说你已经退出了。」信的末尾是一行小字：「这是你最后一次为世界杯而战的机会。」", 30,
    () => false,
    [{ key: "accept", text: "接受归化，为更强的队出战世界杯" }, { key: "reject", text: "拒绝，谁的国家队都不踢" }]),
  makeEventDef("finish_high_school", "完成学业", "青训营的文化课老师把你叫到办公室。\n「你的成绩已经落后两年了。继续这样，你连高中都毕不了业。」老师摘下眼镜，「我知道你想踢球，但万一踢不出来呢？给自己留条后路。」\n桌上摊着你的成绩单，一片红。", 8,
    (ctx) => ctx.age <= 19 && clusterFired(ctx, YOUTH_RESTRICTED) < YOUTH_BUDGET,
    [{ key: "accept", text: "补课完成学业，留条后路" }, { key: "reject", text: "全力专注足球，破釜沉舟" }]),
  makeEventDef("controversial_statement", "争议言论", "你在直播中说的那句话被截了出来，配上了一段你没说过的前文，传遍全网。\n赞助商的电话开始响了，经纪人在凌晨打来电话：「这件事控不住了。你现在只有两条路：公开道歉保住代言，或者嘴硬到底看谁先倒。」\n评论区已经分成了两派在骂战。", 45,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 26,
    [{ key: "apologize", text: "发声明公开道歉" }, { key: "defy", text: "嘴硬到底，绝不低头" }]),
  // 英雄归来: the desc promises a return to the player's FIRST club（你第一次
  // 效力的俱乐部 / 重返旧主），but the old resolve only set roleOverride with
  // NO newClubId — the player stayed put while the prose said「这就是家」. And
  // the gate（age≥32）never checked the player had actually LEFT the first club,
  // so a one-club man got「回来」 having never left. Fix: gate on the debut
  // club differing from the current club, and actually transfer him there.
  makeEventDef("triumphant_return", "英雄归来", "你第一次效力的俱乐部主席亲自飞到了你现在所在的城市。\n「你走的时候是个孩子，回来的时候是个传奇。我们的球迷在门口挂了你的横幅——十年了，没人敢穿你的号码。」他递过来一份合同。「待遇不如现在，但这里有你的名字。」\n你看了一眼窗外，是满天的星。", 6,
    (ctx) => ctx.age >= 32 && (ctx.formerClubIds ?? []).length > 0 && (ctx.formerClubIds ?? [])[0] !== ctx.club.id && clusterFired(ctx, TWILIGHT_RESTRICTED) < TWILIGHT_BUDGET,
    [{ key: "join_club", text: "重返旧主，衣锦还乡" }, { key: "stay", text: "留在现队，故事还没完" }]),
  // P-A18: a wage-renegotiation event for a proven starter at a mid/big club.
  // The financial-vs-development fork made explicit — demand a raise (money but
  // risk frost) or accept a team-friendly deal (growth + goodwill).
  makeEventDef("wage_demand", "加薪谈判", "经纪人在你耳边说：「你的身价涨了三倍，工资还停在三年前。是时候了。」\n他拿出一份对比表——同位置的球员，数据不如你，工资是你的两倍。「强硬点，俱乐部不敢放你走。但他们也可能用板凳惩罚你。」\n合同桌上摆着两支笔。", 35, (ctx) => isPrime(ctx) && ctx.role === "starter" && ctx.player.overall >= 78,
    [{ key: "demand", text: "强硬要求加薪，不达目的不上场" }, { key: "team_friendly", text: "签团队友好合同，换出场保证" }]),
  // 巅峰伤病: the desc said 「窗外是争冠的关键一战」——a title-deciding match,
  // but the gate is just `role === starter` (no title-contention check). A
  // starter at a mid-table or relegation club isn't in a 争冠 race. Reframed
  // to 「赛季的关键一战」——a key match of the season, honest for any
  // starter at any club, keeping the cortisone-vs-rest tension intact.
  makeEventDef("injury_at_peak", "巅峰伤病", "训练中你听到「咔」的一声——膝盖里传来的。\n队医的脸色很差：「半月板有问题。你可以打封闭上场，撑过这个赛季；但每打一场，你的膝盖就老一岁。」\n窗外是赛季的关键一战，主场球票已经售罄。", 6,
    (ctx) => ctx.role === "starter",
    [{ key: "play_injured", text: "打封闭，带伤硬上" }, { key: "recover", text: "停赛治伤，长远的未来更重要" }]),
  // 大赛前伤病: the desc narrates a tournament two weeks away, so the gate
  // requires a national tournament (世界杯 for strong nations, the continental
  // cup for minnows) to actually fall in the upcoming period — otherwise the
  // prose asserts a 大赛 the calendar doesn't back. The desc names the SAME
  // tournament the career contests (minnows chase the continental cup, not a
  // WC final they can't realistically reach).
  makeEventDef("injury_before_tournament", "大赛前伤病", (_n, ctx) => {
      const cup = nationalTournamentName(ctx);
      return `距离${cup}只剩两周，你在训练中倒下了。\n核磁共振的结果出来了——韧带撕裂。队医说：「硬上，可能毁掉你的职业生涯；养伤，你会错过这届${cup}，下一次可能要等四年。」\n更衣室里你的国家队球衣已经挂好了。`;
    }, 20,
    (ctx) => ctx.player.overall >= ntThreshold(nationById(ctx.player.nationalityId).intlRep) && upcomingTournamentYear(ctx) !== undefined,
    [{ key: "play_through", text: "硬上，大赛不能等" }, { key: "recover", text: "养伤，保住职业生涯" }]),
  // ── 伤病后果模型（重新设计：维度收敛）────────────────────────────────
  // 一次伤病最多吐 ≤4 条后果，每条一个含义，不再叠加同轴信号：
  //   轻伤（轻/中）：不碰 OVR（overallDelta 净0→无 pill）。后果经「间接链」传导——
  //     roleOverride=替补 或 statsMultiplier 少踢 → 出场↓ → 进球/助攻/零封↓ → 评分↓
  //     → 成长预算↓ + forced-exit/转会触发。伤病不直接扣能力，而是「踢得少、数据掉」。
  //   重伤：overallDelta 单数一次性扣（豁免天花板）+ 沦为替补 + 带伤隐患(compromised_body)
  //     [+ 整季报销 suspended，仅跟腿/胫脉骨等最重者]。severeInjuries+1 驱动医学弧。
  //   打封闭硬上（赌博）：成功=少扣 OVR + 保主力 + 旧伤阴影(nagging_injury 埋雷无拖累)；
  //     失败=升级重伤（重扣 + severe + 带伤隐患 + 报销）。
  //  标签各单职：cautious_play=降伤病率、compromised_body=成长拖累、nagging_injury=复发引信、
  //  talisman=降伤病率+身份chip。医学弧（severe 2→队医警告、3→诊室→退役）与 talisman/
  //  ironman/glass_cannon 伤病率旋钮不变——这些是伤病有重量的来源，不是「乱」的部分。
  //  10 个伤病名仅是叙事皮，机制只看轻/重二档。
  makeEventDef("injury", "伤病", "那一瞬间你听到了骨头错位的声音。\n全场安静了一秒，然后是球迷的惊呼。担架抬你出场的时候，你能看见记分牌还在转。队医握着你的手说：「先别想足球了。」", 100,
    () => false, // triggered by the injury roll in run.ts
    INJURY_DECISION_OPTIONS),
  // P-A27: the career-threatening injury — Ronaldo Nazário dimension.
  // Not a routine injury — one that makes you question if you'll ever play again.
  makeEventDef("career_threatening_injury", "毁灭性伤病", "你倒在地上的时候听到了一声脆响——不是肌肉，是骨头。\n全场安静了。你试图站起来，但你的腿不听你的。队医跑到你身边的时候脸色发白：「这次不一样。」\n核磁共振的结果出来了——你需要手术，恢复期一年，而且不保证能回到从前。你躺在病床上看着天花板，想起你第一次触碰足球的那天。\n你不确定你还能不能回来。", 15,
    (ctx) => ctx.role === "starter" && ctx.player.overall >= 80 && ctx.age >= 24,
    [{ key: "rehab_war", text: "拼上一切康复，我要回来" }, { key: "accept_end", text: "也许这就是终点了" }], "rare"),
  // P-A28: pre-final collapse — the Ronaldo 1998 dimension. The body fails
  // before the biggest match of your life. Play anyway, or walk away.
  makeEventDef("pre_final_collapse", "决赛前的阴影", "世界杯决赛前六小时，你在酒店房间里倒下了。\n队医说是压力导致的身体崩溃——你的腿在发抖，视线模糊，心跳过速。你被送进了医院，做了三个小时的检查，结果显示身体没大碍——但你自己知道，你不在那里。\n距离决赛还有九十分钟。队医问你：你确定要上场吗？", 10,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 22,
    [{ key: "play_anyway", text: "我必须上场——这是我的决赛" }, { key: "step_aside", text: "我不在状态，让队友上" }], "legendary"),
  // world_cup_showdown / qualifier_showdown are boss events
  // built by dedicated builders (below), not the catalog.

  // ── P7: career-phase events + rare/legendary + trait-flag branches ──

  // Youth phase (16-19): academy-flavored events.
  makeEventDef("academy_rivalry", "青训德比", "青训营来了个新人——比你小三岁，技术比你好，笑得比你甜。\n教练的训练课上开始把「和你的比较」挂在嘴边，队友私下说「这小子迟早顶替你」。他每天比你早到一小时，晚走一小时。\n你看着他训练时的背影，想起自己刚来的时候也是这样。", 22,
    (ctx) => isYouth(ctx) && clusterFired(ctx, YOUTH_RESTRICTED) < YOUTH_BUDGET,
    [{ key: "outwork", text: "加倍加练，把他的位置抢回来" }, { key: "befriend", text: "主动走近，化敌为友" }]),
  makeEventDef("scout_attention", "球探注视", (n) => `看台上坐着一个穿西装的陌生人，手里拿着一本写满名字的笔记本。\n助理教练赛后来跟你说：「那是${n.scoutLeague}的球探，专门为你来的。好好踢，让他记住你的名字。」\n但你也知道——如果你这场的表现打动不了他，他笔记本上的名字就会被划掉。`, 18,
    // role 门：球探「专程为你来」要求你已在一线队稳定上场（starter/high_rotation）。
    // 排除板凳/外租处境（substitute/low_rotation/third_keeper）——否则「球探专程」
    // 与同期的 loan_offer（「你出场有限，要外租你」）叙事打架（D1 反馈 id=6：
    // 19 岁 overall 68 在 rep6 俱乐部 diff−11 坐板凳，却被意甲球探「专程」来看）。
    (ctx) => isYouth(ctx) && ctx.player.overall >= 60 && (ctx.role === "starter" || ctx.role === "high_rotation"),
    [{ key: "showcase", text: "豁出命去表现，让全世界看见" }, { key: "play_normal", text: "稳扎稳打，不被打乱节奏" }]),
  // Prime phase (20-29): peak-career stakes.
  makeEventDef("captaincy_offer", "队长袖标", "赛前主帅把你单独叫到更衣室角落，手里拿着袖标。\n「老队长走了。我想把袖标给你。这意味着你不是球员了，你是这个队的灵魂。赢了一起扛，输了你第一个挨刀。」他递过来，「想清楚再接。」\n袖标在他掌心里，很轻。", 8, (ctx) => isPrime(ctx) && ctx.role === "starter",
    [{ key: "accept", text: "接过袖标，扛起整支球队" }, { key: "decline", text: "婉拒，我只想好好踢球" }]),
  makeEventDef("contract_saga", "续约拉锯", "经纪人和俱乐部主席的谈判已经僵了三个月。\n「他们给你的报价是对内第三档薪资——你配得上第一档。」经纪人在电话里说，「要么我们强硬到底，要么我替你签了。强硬的话，可能被放上板凳；妥协的话，钱少但安心。」\n你看着手机里主席发来的最后一条消息。", 8, (ctx) => isPrime(ctx) && isHighRole(ctx.role),
    [{ key: "hold_out", text: "强硬到底，不拿到合理薪资不上场" }, { key: "settle", text: "爽快签约，换取出场和信任" }]),
  makeEventDef("loyalty_test", "豪门诱惑", "你的手机里有一条未读消息，来自一个不该联系你的人——超级豪门的体育总监。\n「私下聊聊？我们给你主力、三倍薪水、一座新球场。但你得自己施压转会——你现在的俱乐部不会轻易放你。」\n消息已读不回会被遗忘；回复了就回不去了。窗外的训练场灯火通明，队友们在等明天。", 6,
    (ctx) => isPrime(ctx) && ctx.role === "starter" && ctx.club.rep < 8,
    [{ key: "agitate", text: "回复，主动施压转会" }, { key: "stay_loyal", text: "删除消息，忠于母队" }]),
  // Twilight phase (30+): legacy and decline.
  makeEventDef("veteran_mentor", "老将传帮", "训练场上一个年轻球员怯生生地走到你身边，手里拿着一瓶水和一颗汗湿的心。\n「我从小看你的比赛长大……能教我那个过人吗？」他眼里有光，是那种你已经很久没在自己眼里见到的光。\n教练在远处看着你们，等着看你愿不愿意倾囊相授。", 8, (ctx) => isTwilight(ctx) && isHighRole(ctx.role),
    [{ key: "mentor", text: "倾囊相授，把经验传给下一代" }, { key: "stay_selfish", text: "守住自己的位置，教会徒弟饿死师傅" }]),
  makeEventDef("body_decline", "身体警报", "你起跳抢头球的时候，膝盖传来一阵从未有过的钝痛。\n落地时你知道了：你的身体不再是二十岁的身体了。队医说你还能踢，但要改踢法——少跑多传，用脑子不用腿。这意味着你不会像从前那样统治球场了，但能多踢五年。\n或者你可以硬扛不服老，直到身体彻底垮掉。", 6,
    (ctx) => isTwilight(ctx) && ctx.player.overall < 85 && clusterFired(ctx, TWILIGHT_RESTRICTED) < TWILIGHT_BUDGET,
    [{ key: "adapt", text: "改变踢法，用智慧换时间" }, { key: "ignore", text: "硬扛不服老，直到被抬下场" }]),
  makeEventDef("farewell_match", "告别战", "最后一个主场，球迷在看台上打出了一面横幅——你的名字，你的号码，一行小字：「谢谢。」\n赛前列队的时候，队友给你戴上了队长袖标。你看着满场的球迷，想起十六岁第一次走进球场的那天。\n比赛哨声响起前，你在球员通道里站了很久。", 8,
    (ctx) => isTwilight(ctx) && ctx.age >= 36 && clusterFired(ctx, TWILIGHT_RESTRICTED) < TWILIGHT_BUDGET,
    [{ key: "accept", text: "在主场告别，给球迷一个完美的句号" }, { key: "postpone", text: "再踢一季，我还不想说再见" }]),
  // P-A26: the father-agent — when family and career are inseparable.
  // Inspired by Neymar Sr. managing his son's entire career.
  makeEventDef("father_agent", "父亲经纪人", "你父亲坐在你对面，桌上摊着三份合同。\n他从小就带你训练、替你谈判、管你的钱。他不是你的经纪人，他是你的父亲。但今天他做的事让你不安——他在替你决定去哪支球队，他甚至没问你想不想去。\n「爸，」你说，「这是我的职业生涯。」他看着你的眼神从慈爱变成了生意人。", 18,
    (ctx) => isPrime(ctx) && ctx.role === "starter" && ctx.player.overall >= 78,
    [{ key: "assert_independence", text: "告诉父亲：从今天起我自己做决定" }, { key: "trust_father", text: "相信父亲，他从来没有害过我" }]),

  // P-A25: conscience — the player as a person with beliefs (Caszely dimension).
  // A public stand that costs you, or silence that costs something else.
  makeEventDef("conscience_stand", "良心的选择", "你的国家正在发生一些事。媒体递来话筒，问你怎么看。\n你的队友们都装作没听见。你的经纪人说「别碰政治，对商业不利」。但你知道——你说的每一句话都会被全国听见。你是一名球员，但你首先是一个人。\n你看着那个话筒。", 35,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 24,
    [{ key: "speak_out", text: "公开表态，哪怕付出代价" }, { key: "stay_silent", text: "保持沉默，足球不是政治" }], "rare"),

  // P-A30: racism — the Vinícius dimension. The abuse that transcends sport.
  makeEventDef("racist_abuse", "种族歧视", "客场的看台上传来猴子的叫声。不是一个人——是整个看台。\n你的队友假装没听见。裁判走过来说「继续踢」。但你的血在沸腾，你的拳头在攥紧。你想起你小时候在贫民窟踢球时，没有人关心你的肤色——他们只关心你踢得好不好。\n现在全世界的镜头对准了你。你要怎么回应？", 8,
    (ctx) => ctx.player.overall >= 75,
    [{ key: "speak_out", text: "停下比赛，公开对抗" }, { key: "play_through", text: "用进球回应，让足球说话" }, { key: "walk_off", text: "走下场——我不为他们表演" }], "rare"),

  // P-A31: fitness failure — the Taarabt/Redknapp dimension. Talent vs discipline.
  makeEventDef("fitness_failure", "体测失败", "休赛期结束第一天，体测数据出来了——你胖了六公斤。\n主帅在新闻发布会上没有留情面：「他不配踢职业足球。他在预备队跑得还没我多。」记者们笑了，你的队友低头看着地板。\n你站在更衣室的镜子前——你认得那个天才球员，但镜子里的人多了一圈腰围。你想起有人说你是艺术家不是工兵。但艺术家也得站上舞台。", 18,
    (ctx) => ctx.player.overall >= 75 && ctx.age >= 24,
    [{ key: "crash_diet", text: "拼命减肥，一个月减回来" }, { key: "own_it", text: "我就是这种球员，用技术弥补体能" }]),

  // P-A32: fan confrontation — the Cantona dimension. The moment the player
  // snaps back at a fan who crossed the line.
  makeEventDef("fan_confrontation", "球迷冲撞", "你被罚下场走向球员通道。一个球迷从看台跳下来冲到你面前，对着你的脸骂了最脏的话。\n你的拳头在攥紧。全场的镜头对准了你。你听到教练在更衣室里喊你的名字，你听到安保在跑过来，你听到那个球迷还在骂。\n你停下来转身面对他。你的身体在告诉你一件事，你的理智在告诉你另一件事。", 20,
    (ctx) => (ctx.role === "starter" || ctx.role === "high_rotation") && ctx.player.overall >= 77,
    [{ key: "snap", text: "给他一脚，让他知道这不是他能来的地方" }, { key: "walk_away", text: "转身走进通道，不回头" }], "rare"),

  // P-A34: price-tag pressure — the Torres dimension. The weight of a record
  // fee crushing a player's confidence. 903 minutes without a goal.
  makeEventDef("price_tag_pressure", "天价压力", (n) => `你转会费打破了${n.club}的俱乐部纪录。媒体在算你每一分钟值多少钱——他们已经算到了小数点后两位。\n但你已经八场比赛没进球了。每一次触球，看台上都有人在倒数你的进球荒。你的队友开始不传球给你了——不是不信任你，是不想给你压力。\n你站在点球点前，${n.formerClub ? `想起你在${n.formerClub}每场都进球的日子` : "想起你还没被标价的那些日子"}。那时候没人算你值多少钱。`, 40,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 24,
    [{ key: "force_it", text: "拼命要球，我要自己打破荒" }, { key: "simplify", text: "放下自我，先帮队友进球" }]),

  // P-A35: the fatal mistake — the Gerrard slip dimension. One uncontrollable
  // moment that costs everything. Not a choice — but how you respond IS.
  makeEventDef("fatal_mistake", "致命失误", "那个球滚到你脚下的时候一切都很简单——接住，传出去，比赛就结束了。\n但你的脚滑了。球从你脚下溜走，对方前锋像鬼影一样冲过去，单刀，进球。全场安静了一秒，然后是对方球迷的欢呼——和你的主场球迷的叹息。\n你跪在草地上。你知道这个球意味着什么。", 25,
    (ctx) => ctx.role === "starter" && ctx.player.overall >= 80,
    [{ key: "own_it", text: "站起来，面对媒体和球迷" }, { key: "hide", text: "躲开镜头，你需要一个人待着" }], "rare"),

  // P-A36: the rock bottom — the Vardy dimension. When everything says quit,
  // but you don't. From non-league to the top, the story of never giving up.
  makeEventDef("rock_bottom", "至暗时刻", "你在低级别联赛的更衣室里坐着。工资三十镑一周，白天在工厂做医疗夹板，晚上踢球。你的手机里有一条青训营老队友的消息——他刚签了豪门的一线队合同。\n你看着自己磨满老茧的手，想起十六岁被释放的那天。你现在的联赛连电视都不转播。你的电子脚镣在脚踝上冰凉。\n你想过放弃。很多人放弃了。", 8,
    (ctx) => ctx.player.overall < 70 && ctx.age >= 18 && ctx.club.rep <= 2 && clusterFired(ctx, WIDE_MID) < WIDE_MID_BUDGET,
    [{ key: "keep_going", text: "继续踢，哪怕只有一个人在看" }, { key: "walk_away", text: "够了，该找份正经工作了" }]),

  // P-A37: beyond football — the Drogba dimension. When a player's voice
  // transcends sport and becomes something larger. The rarest event in the pool.
  makeEventDef("beyond_football", "超越足球", "你的母国正在内战中。你刚带领国家队历史性晋级世界杯——全国都在看。\n摄像机对准了你。你知道这一刻不属于足球，属于比足球更大的东西。你穿着球衣，满身汗水，看着镜头——你的母国在等你说一句话。\n你可能止不住一场战争。但你可能给绝望的人一瞬间的希望。那一瞬间，有时候就够了。", 5,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 27,
    [{ key: "speak", text: "对着镜头，说出那句话" }, { key: "let_football_talk", text: "把这一刻还给足球——用进球说话" }], "legendary"),

  // P-A38: the joy that fades — the Ronaldinho dimension. Not a dark spiral,
  // but a bright one. He didn't destroy himself — he enjoyed himself, and it
  // cost him everything. "Should we be grateful or angry it ended so soon?"
  makeEventDef("joy_fades", "快乐消退", (n) => `你赢了一切——世界杯、金球、${n.continentalClubCup}。你是世界上踢球最快乐的人。\n但赢了一切之后，训练场不再是你最想去的地方了。你的笑容还在，你的天赋还在，但你的体能开始跟不上你的想象力。教练说你在「享受生活」，你说为什么不呢？\n你在${n.derbyClub}的主场被对方球迷起立鼓掌过。但现在你开始想：该感谢你给足球的，还是该生气它结束得这么早？`, 35,
    (ctx) => ctx.player.overall >= 85 && ctx.age >= 28,
    [{ key: "reignite", text: "重新点燃饥饿感，我还没赢够" }, { key: "enjoy", text: "享受这一切，足球本来就是快乐" }]),

  // P-A39: the contract year — when your next contract depends on this season.
  // Every player knows the phenomenon: the last year changes everything.
  makeEventDef("contract_year", "合同年", "你进入了合同的最后一年。\n经纪人在你耳边说：「这是你最重要的赛季。踢好了，下份合同翻三倍。踢不好……」他没有说完，但你听懂了。\n你的队友在更衣室里聊天，但他们不知道你的合同快到期了。你每次上场都像在面试——对方球探在看你，你的俱乐部在犹豫，其他俱乐部在算你的价格。", 8, (ctx) => isPrime(ctx) && ctx.role === "starter" && ctx.player.overall >= 76,
    [{ key: "go_all_out", text: "豁出命踢，这赛季决定我的未来" }, { key: "stay_calm", text: "正常踢，好合同自然来" }]),

  // P-A40: the final-match explosion — the Zidane 2006 dimension. A legend's
  // last game, provoked beyond endurance. The most human moment in the pool.
  makeEventDef("final_provocation", "最后一舞的怒火", "这是你的最后一场比赛。退役已经宣布了——世界杯决赛，全世界在看。\n比赛进行到加时赛。一个对方球员在你耳边低语了什么——关于你的家人，关于你的母亲。你听到了每一个字。\n你的拳头在攥紧。你想起你这辈子所有的克制、所有的忍让、所有的「为了球队」。但这不是足球的问题。这是你家人的问题。你看着他。", 8,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 28,
    [{ key: "headbutt", text: "一头撞向他，哪怕这是你的最后一场" }, { key: "walk_away", text: "忍住。你的最后一场不能用红牌结束" }], "legendary"),

  // P-A41: wasted talent — the Balotelli dimension. Not joy (Ronaldinho) or
  // darkness (Gascoigne) — just attitude. The gap between what you could be
  // and what you are. "A spectacular waste of talent."
  makeEventDef("wasted_talent", "天才的浪费", "你又一次迟到了。训练已经开始了二十分钟。\n主帅在办公室里等你，桌上是一叠你的红牌记录——本赛季第四张了。「你知道你有多少天赋吗？」他的声音不是在骂你，是在替你着急。「你训练不如三十七岁的老将。你的天赋可以让你成为世界第一——但天赋不踢球，人踢球。」\n你看着窗外训练场上的队友。他们没有你的天赋，但他们比你早到了一个小时。", 45,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 22,
    [{ key: "wake_up", text: "是时候认真了，我不想成为那个浪费天赋的人" }, { key: "shrug", text: "我就是我，天赋不需要解释" }]),

  // P-A42: the legendary shirt — the Depay dimension. The weight of a number
  // worn by legends before you. The shirt that can make or break you.
  makeEventDef("legendary_shirt", "传奇号码", (n) => `更衣室的柜子里挂着一件球衣——上面印着${n.squadNumber}号。\n教练说：「这件球衣穿过${n.club}历史上最好的那几个人。现在它是你的了。」你摸了摸那块布——它比普通球衣重，重得多。上一个穿它的人被媒体骂了两年。\n你穿上它走向训练场。每个人都在看你——不是看你的球技，是看你配不配得上这个号码。`, 40,
    (ctx) => ctx.player.overall >= 76 && ctx.role === "starter" && ctx.club.rep >= 7,
    [{ key: "embrace", text: "穿上它，我要成为下一个传奇" }, { key: "change_number", text: "换一个号码，我不想活在别人的影子里" }]),

  // P-A43: coach feud — the Pogba/Mourinho dimension. When the player and
  // coach become enemies, the whole club watches.
  makeEventDef("coach_feud", "将帅不和", "你在训练中和主帅吵了起来。不是小摩擦——是当着全队的面拍桌子。\n起因是战术：你要前插，他要你留守。他说你「不守纪律」，你说他「不懂进攻」。第二天他在新闻发布会上说你「影响了全队的状态」。你被剥夺了队长袖标。\n更衣室分成了两派：支持你的和支持教练的。主席在等你们自己解决——但你们都不打算让步。", 18,
    (ctx) => isPrime(ctx) && ctx.role === "starter" && ctx.player.overall >= 80,
    [{ key: "escalate", text: "公开对抗，让媒体和球迷来施压" }, { key: "back_down", text: "先服软，留得青山在" }]),

  // P-A44: frozen out — the Özil dimension. When the club doesn't want you
  // but won't sell you. The loneliest place in football: not injured, not
  // suspended, just unwanted. Training alone with the reserves.
  makeEventDef("frozen_out", "被冻结", "你出现在训练基地，但你的更衣柜空了。你的名字从首发名单上消失了——不是伤了，不是停了。教练说「战术选择」。\n你被注册到了U23梯队。你的周薪还是顶薪，但没有人在乎你了。你的队友不跟你说话了——不是恨你，是不敢。你一个人在预备队的训练场上跑步，看着远处一线队的灯光。\n你是一个被冻结的资产。", 35,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 28 && (ctx.role === "substitute" || ctx.role === "low_rotation" || ctx.role === "high_rotation"),
    [{ key: "force_move", text: "要求转会，哪怕降薪也要离开" }, { key: "dig_in", text: "拿高薪等合同到期，我不走" }]),

  // P-A45: the mentor coach — the Ancelotti dimension. When the right coach
  // sees something in you nobody else did. The Pirlo transformation.
  makeEventDef("mentor_coach", "伯乐", "新教练上任第一天就找到了你。\n「我知道你之前的教练怎么用你的——让你踢你不擅长的位置，要求你做你做不到的事。」他坐下来，在战术板上画了一个新位置。「我不要你变成别人。我要你变成最好的你自己。」\n你看着那个战术板上的箭头——它指向一个你从没踢过的位置，但你觉得那应该一直都是你的位置。", 8,
    (ctx) => (ctx.role === "substitute" || ctx.role === "low_rotation" || ctx.role === "high_rotation") && ctx.player.overall >= 68 && ctx.age >= 30,
    [{ key: "trust_him", text: "信任他，试这个新位置" }, { key: "insist", text: "我要踢我习惯的位置" }]),

  // P-A46: the breaking point — the Messi 2016 dimension. Three finals lost,
  // a nation's hopes crushing you. The moment you want to walk away from it all.
  makeEventDef("breaking_point", "崩溃边缘", "你又输了。又一场决赛，又一次看着别人捧杯。\n这已经是第三次了。你的国家队球迷开始说「他不行」「他只会在俱乐部踢好」。你在更衣室里坐了很久，没有人来叫你。\n你想起你第一次穿上国家队球衣的那天——那时候你以为你会给这个国家带来一座奖杯。现在你不确定你还能不能。\n你拿出手机，打开社交媒体，开始打一行字：「我决定退出国家队……」", 20,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 27,
    [{ key: "retire_intl", text: "发出那条消息，我累了" }, { key: "come_back", text: "删掉那行字，还没结束" }], "rare"),

  // P-A47: war childhood — the Modrić dimension. The deepest origin story
  // in the pool. Football as escape from war, loss, and a burned home.
  makeEventDef("war_childhood", "战火记忆", "赛前你在更衣室里闭上了眼睛。你回到了六岁——炸弹落在你家的城市，你的祖父再也回不来了，你的家变成了灰烬。\n你成了难民，住在酒店的停车场里。你在那里学会了踢球——在废墟和瓦砾之间，在防空警报的间隙里。一个难民孩子踢着一个破球，这就是你足球的开始。\n现在你站在世界杯的球场上。你睁开眼睛，听见全场在唱你国家的名字。你还记得那个停车场吗？那个孩子不会相信此刻。", 5,
    (ctx) => ctx.player.overall >= 76 && ctx.age >= 20,
    [{ key: "channel_it", text: "用那段记忆点燃你——你从废墟里走到这里" }, { key: "let_it_rest", text: "把那段记忆放下——我已经走出废墟了" }], "legendary"),

  // P-A48: transition preparation — the Guardiola dimension. Near the end,
  // the player starts thinking about what comes after. Coach or nothing.
  makeEventDef("transition_prep", "转型前夜", (n) => `你${n.ageCn}岁了。训练后你多留了一会儿，不是在加练——是在看战术板。\n教练走过来问你在干什么。你说：「我在想如果我坐在你的位置上，我会怎么排阵。」他笑了：「你想当教练？」你想了想——也许。也许不是教练。也许解说，也许青训，也许远离足球。\n但你知道踢球的日子不多了。你开始想下一步了。`, 8,
    (ctx) => isTwilight(ctx) && ctx.age >= 34 && clusterFired(ctx, TWILIGHT_RESTRICTED) < TWILIGHT_BUDGET,
    [{ key: "study_coaching", text: "开始学教练课程，为退役后做准备" }, { key: "stay_present", text: "不想以后，我还能踢" }]),

  // P-A49: the last minute — the Ramos dimension. 93rd minute, final ahead,
  // the ball comes to you. The hero or the villain — both live in the same body.
  makeEventDef("last_minute_hero", "第九十三分钟", "93分钟。记分牌上你们0-1落后。决赛。\n角球飞进禁区。你站在点球点附近——那是你的位置，不是前锋的位置，但此刻没有人在乎位置。球向你飞来。\n你的队友在看着你。对方的门将在看角球区。全场在倒数。你想起有人说过：伟大的人在最晚的时刻站出来。现在是你的时刻了。", 15,
    (ctx) => ctx.role === "starter" && ctx.player.overall >= 78,
    [{ key: "go_for_it", text: "冲上去，用头砸向那个球" }, { key: "track_back", text: "回撤防守，相信队友会进" }], "legendary"),

  // P-A50: super agent — the Raiola dimension. A larger-than-life figure who
  // promises everything but controls everything. "My players are all sick in the head."
  makeEventDef("super_agent", "超级经纪人", "他坐在你对面，穿着一件旧T恤，没有任何奢侈品的痕迹。但他的手机里存着全世界最贵球员的合同。\n「我不帮你谈合同。我帮你改变命运。」他说。「我会帮你开户、买车、找房子、选俱乐部。你的每一步都经过我。你只需要踢球——剩下的事，我来。」\n他笑了一下：「但记住——选了我，你就是我的人了。你的每个决定都有我的指纹。」", 15,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 22,
    [{ key: "sign_with_him", text: "签下他，让他掌控我的生涯" }, { key: "decline", text: "我需要自己掌控命运" }]),

  // P-A51: pre-match calm — the Pirlo dimension. The greatest performers
  // aren't tense — they're calm. How you spend the hours before the biggest
  // match of your life reveals who you are.
  makeEventDef("pre_match_calm", "大赛前的下午", "世界杯决赛前六小时。更衣室里有的队友在听音乐，有的在祈祷，有的在来回踱步。\n你的手机里有一条消息——一个朋友问你在做什么。你回了一个字：「玩。」\n你打开了游戏机。队友看着你的眼神像看一个疯子——决赛前六小时在打游戏？但你知道：紧张的人踢不好球。你不是不紧张——你只是把紧张放在了别的地方。", 10,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 22,
    [{ key: "stay_calm", text: "继续玩——平静是你最好的武器" }, { key: "get_focused", text: "关掉游戏，开始认真准备" }], "legendary"),

  // P-A52: second peak — the Van der Sar dimension. When age becomes wisdom,
  // not weakness. The career's second act, built on what you know, not what
  // you can run.
  makeEventDef("second_peak", "第二巅峰", (n) => `你${n.ageCn}岁了。媒体说你完了。你的速度确实慢了，你的弹跳确实差了——但你的脑子里装着${cnNum(Math.max(1, n.careerSeasons))}个赛季的比赛经验。\n新教练找到你：「我不需要你跑得最快。我需要你看得最清楚。」你在训练中发现了一种新的踢法——不是用身体统治比赛，是用脑子。你站在场上的时候，你知道球会飞向哪里，因为你在它飞之前就看见了。\n也许这是你的第二巅峰。也许不是。但你想试试。`, 25,
    (ctx) => isTwilight(ctx) && ctx.player.overall >= 78 && (ctx.role === "starter" || ctx.role === "high_rotation"),
    [{ key: "reinvent", text: "用智慧踢球，开始第二巅峰" }, { key: "accept_decline", text: "接受衰退，安静地走" }], "rare"),

  // P-A53: peak destroyed — the Van Basten dimension. The cruelest event in
  // the pool. Not a decline, not a choice — a tackle from behind that takes
  // everything at the absolute summit.
  makeEventDef("peak_destroyed", "巅峰终结", (n) => `你正处于生涯的顶点——身价最高，状态最好，全世界都承认你是最好的那一档。\n然后在那场比赛中，一个从背后的铲球来了。你听到了声音——不是骨头，是比骨头更深的东西在碎裂。\n你倒在地上的时候，全场安静了。你看着天花板，你知道这不是普通的伤。队医的脸色告诉你一切。你的踝关节——你靠它做一切的踝关节——碎了。\n你才${n.ageCn}岁。你本该还有很多年。`, 8,
    (ctx) => ctx.player.overall >= 86 && ctx.age >= 27,
    [{ key: "fight", text: "两年康复，我要回来" }, { key: "retire", text: "够了。在巅峰结束，总比在低谷好" }], "legendary"),

  // P-A54: faith — the Kaká dimension. Not a political stand, but a life
  // built on gratitude. The near-loss that made everything after it a gift.
  makeEventDef("faith_awakening", "信仰", "你还是个少年的时候差点不能走路了。一次泳池事故，脊椎骨折，医生说你可能再也踢不了球。\n你康复了。你站起来的时候，你说了一句话——不是对记者，是对自己：「我以后踢的每一场球，都是赚的。」\n从那天起你把收入的一部分捐给了教会，你进球后指向天空，你的鞋上写着你的信仰。你的经纪人说你「傻」，你笑了——你只是记得你差点失去一切。", 15,
    (ctx) => ctx.player.overall >= 75 && ctx.age >= 19,
    [{ key: "live_by_faith", text: "带着感恩踢球——一切都是赚的" }, { key: "forget", text: "过去了，我只想往前看" }], "rare"),

  // P-A55: brand empire — the Beckham dimension. When football becomes a
  // platform for something bigger. The $250M spectacle, the move to LA.
  makeEventDef("brand_empire", "商业帝国", "你的经纪人在桌上摊开了一份合同——不是足球合同，是商业合同。\n「你不仅是一名球员了。你是一个品牌。」他说。「去大洋彼岸，去镜头前面，去让全世界知道你的名字。足球只是开始——你的未来在球场之外。」\n你看了一眼合同上的数字。然后你看了窗外训练场上的灯光。你的教练还在等你。你的队友还在跑。你不知道哪边才是真的你。", 25,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 28,
    [{ key: "build_brand", text: "签下商业合同，足球之外还有更大的世界" }, { key: "stay_football", text: "我只是一名球员，球场是我的全部" }], "rare"),

  // P-A56: cardiac arrest — the Eriksen dimension. The most dramatic event
  // in the pool: dying on the pitch and choosing to come back.
  makeEventDef("cardiac_arrest", "心脏骤停", "第四十二分钟，你准备接界外球。然后你什么都不知道了。\n你醒来的时候在医院。队医告诉你：你的心脏停了。你的队友在球场上救了你——他把你翻成侧卧位，做了心肺复苏。全世界都看到了你在球场上倒下。\n医生说你可以装一个除颤器继续踢球。但你的俱乐部可能不会要你了——有些联赛不允许装除颤器的球员上场。\n你还想踢吗？", 3,
    (ctx) => ctx.player.overall >= 76 && ctx.age >= 25,
    [{ key: "comeback", text: "装上除颤器，我要回来" }, { key: "retire", text: "够了。活着比足球重要" }], "legendary"),

  // P-A57: representation — the Salah dimension. When you're not just a player,
  // you're a mirror for millions who never saw themselves at this level.
  makeEventDef("representation", "代表", "你走进球场的时候，你看到的不是球迷——你看到的是你的村庄。\n他们从你母国的每一个角落发来消息：你的名字被写在了墙上、穿在了孩子的背上、念在了老人的祈祷里。你不只是你自己了。你是四亿人从未拥有过的镜子——他们从没在这个级别看到过自己。\n你站在球员通道口，看着草坪。你知道你进的每个球不只是你的。它属于每一个在电视前看着你的人。", 8,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 20,
    [{ key: "carry_it", text: "扛起这个重量——他们需要我" }, { key: "play_for_self", text: "我只是一名球员，不是一面旗帜" }], "legendary"),

  // P-A58: prodigy's burden — the Rooney dimension. 16 years old, the nation's
  // savior. The weight that no one that young should carry.
  makeEventDef("prodigy_burden", "年少成名", (n) => `你${n.ageCn}岁。你进了一个球，全世界都知道了你的名字。\n媒体说你是「下一代天才」「国家拯救者」「三十年来最好的年轻球员」。你的队友比你大十岁，他们在训练中看你的眼神不是嫉妒——是好奇。你还没有学会开车，但你在开法拉利。\n你的手机每天有三百条消息。你的教练说「别看媒体」，但你怎么不看？你才${n.ageCn}岁。这个年纪的孩子什么都看。你不知道怎么处理这些——因为没有人教过你。`, 30,
    (ctx) => ctx.age <= 20 && ctx.player.overall >= 65,
    [{ key: "embrace_it", text: "享受这一切，我是天才" }, { key: "stay_grounded", text: "远离聚光灯，我只是一个踢球的少年" }]),

  // P-A59: the fire — the Zlatan dimension. "I need to be angry to play well."
  // When anger is not a weakness but a weapon. The fuel that comes from being
  // told you're not good enough.
  makeEventDef("the_fire", "怒火", "你从小被告知你不够好——穿错了衣服，住错了街区，说错了话。\n但你踢球的时候，那些看不起你的人都在场边看着。你的教练说你「太独」，你的队友说你「太傲」，媒体说你「太狂」。也许他们是对的。但你的愤怒让你跑得更快、跳得更高、踢得更狠。\n你站在球场上，闭上眼睛。你听见了那些说你不行的人的声音。你笑了。", 20,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 22,
    [{ key: "channel_anger", text: "用愤怒点燃自己——他们说我不行" }, { key: "let_go", text: "放下愤怒，只踢快乐的足球" }], "rare"),

  // P-A60: quiet excellence — the Kroos dimension. Not fire, not joy, not anger.
  // Precision. Knowing exactly what you are and what you are not.
  makeEventDef("quiet_excellence", "精准", "你的传球精度是全队最高的。你没有最快的速度，没有最强的身体，没有最花的技术。\n但你有一个别人没有的东西：你知道每一脚球该去哪里。不是大概——是精确到厘米。你的队友说跟你传球像「把球放进了保险箱」。\n教练在战术板上画了一条线——你的位置。他说：「我不需要你跑全场。我需要你站在这里，把球送到它该去的地方。」你看了一眼那条线，那就是你十七年来站的地方。", 25,
    (ctx) => ctx.player.overall >= 82 && ctx.role === "starter",
    [{ key: "master_precision", text: "精进到极致——精确是你的武器" }, { key: "expand_game", text: "我需要更多——只传球不够" }]),

  // P-A61: giving back — the Mané dimension. When success means lifting not
  // just yourself but everyone who never had your chance.
  makeEventDef("giving_back", "回馈", "你的银行账户里的数字比你的村庄一整年看到的钱还多。\n你的经纪人给你看投资建议：买房产，买股票，买豪车。但你看着手机里你母亲发来的照片——你的村庄还没有医院，最近的水井在三公里外，孩子们在一棵树下上课。\n你的队友在停车场开走了他的新跑车。你站在原地，看着手机里的照片。你的母亲在照片后面写着：「全村人都说你好样的。」你不知道你哪里好——你只是踢球。但你踢球赚的钱能不能让那棵树变成一间教室？", 20,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 24,
    [{ key: "give_everything", text: "把钱花在需要它的人身上——建学校、建医院" }, { key: "invest_in_self", text: "先保障自己的未来，以后再回馈" }], "rare"),

  // P-A62: no longer fun — the Nakata dimension. When the joy simply stops,
  // and the world outside the pitch calls louder than the pitch itself.
  // Not injury, not decline — just... done.
  makeEventDef("no_longer_fun", "不再享受", (n) => `你站在球场上，但你的心不在这里了。\n不是累了，不是伤了，不是老了——你只是不再享受了。每场比赛都一样，每个进球都一样，每座奖杯都一样。你看着窗外的世界——有那么多你没去过的地方，没见过的人，没做过的事。\n你才${n.ageCn}岁。你还能踢。但你在想：如果我不再享受了，为什么还要踢？\n你的经纪人说明年有新合同。你看着窗外的飞机划过天空。`, 10,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 28,
    [{ key: "walk_away", text: "退役——去发现足球之外的世界" }, { key: "find_fire", text: "再给自己一次机会——也许火还会回来" }], "legendary"),

  // P-A63: discarded — the De Bruyne dimension. When a big club tells you
  // you're not good enough, and you have to decide: accept it or prove them wrong.
  makeEventDef("discarded", "被弃用", "你坐在更衣室里。今天的首发名单上没有你的名字——又没有。\n你来到这家俱乐部时他们说你是未来。但现在新教练来了，他不看你训练，不看你的数据，他只看你「不够好」三个字。三场出场，零进球。你的队友说你应该走了——不是你不行，是他不看你。\n你的经纪人来电话了：「有一家小俱乐部想要你。不是豪门，但他们保证你踢主力。」你看着手机上的名字——你从没听说过那家俱乐部。但他们会让你上场。", 35,
    (ctx) => (ctx.role === "substitute" || ctx.role === "low_rotation") && ctx.player.overall >= 75 && ctx.club.rep >= 7,
    [{ key: "prove_them_wrong", text: "去小俱乐部——我要证明他们错了" }, { key: "stay_and_fight", text: "留下来，在训练中赢回位置" }]),

  // P-A64: transfer regret — the Alexis dimension. The first training session
  // at the new club, and you already know you made a mistake.
  makeEventDef("transfer_regret", "转会后悔", "你穿着新球衣走出训练场。第一次训练结束了。\n你坐在车里看着挡风玻璃发呆。你不知道为什么——但你感觉不对。队友不认识你，教练不知道怎么用你，战术体系和你之前踢的完全不同。你的旧俱乐部的球迷在社交媒体上骂你叛徒，你的新俱乐部的球迷在等着看你值不值那个价。\n你回到家对家人说了一句话：「我能撕毁合同回去吗？」", 25,
    (ctx) => ctx.age >= 26 && ctx.player.overall >= 78 && ctx.club.rep >= 7,
    [{ key: "give_it_time", text: "再给它时间——也许只是不适应" }, { key: "admit_mistake", text: "承认错了，想办法离开" }]),

  // P-A65: goalscoring machine — the Haaland dimension. Not joy, not anger,
  // not precision — pure instinct. The only thought: get a shot off.
  makeEventDef("goal_machine", "进球机器", "你站在禁区内。球在三十米外。但你的脑子里只有一个画面：球在网窝里。\n你不关心谁传球，不关心战术体系，不关心对手叫什么名字。你关心的是球和你之间的距离，以及最短的那条线。你的队友说你「不像人类」——你的跑位太精确了，精确得像一台机器。\n你进了一个球后坐到了地上——双腿盘起，闭上眼睛。喧闹的球场里你在冥想。他们说这很奇怪。你觉得这是你唯一能安静的时刻。", 15,
    (ctx) => ctx.player.position === "ST" && ctx.player.overall >= 78 && ctx.role === "starter",
    [{ key: "pure_instinct", text: "只做一件事——进球。其他都不重要" }, { key: "complete_player", text: "我想成为更全面的球员" }], "rare"),

  // P-A66: broken leader — the Kompany dimension. 37 injuries, 878 days
  // sidelined, yet every time you come back, you walk straight into the
  // starting lineup. The leader whose body keeps breaking, whose will does not.
  makeEventDef("broken_leader", "破碎的领袖", "你又一次从伤病中回来了。这已经是你的第N次复出了。\n你的身体档案比你的比赛记录还厚——肌肉拉伤、跟腱发炎、膝盖手术。你已经缺阵了两年多的比赛日。你的队友说你是「玻璃做的队长」。\n但你每次回来，教练都把你放回首发。不是因为你好——是因为没有你在场上，球队不知道往哪跑。你带着碎过的身体和没碎过的意志走上了球场。你的身体在告诉你别跑了，你的袖标在告诉你你必须跑。", 20,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 28 && ctx.role === "starter" && (ctx.injuriesTaken ?? 0) >= 1,
    [{ key: "keep_leading", text: "只要能站就站着——这支队需要我" }, { key: "protect_body", text: "少踢一点，让身体多撑几年" }]),

  // P-A67: the machine — the Lewandowski dimension. Not magic, not flair —
  // relentless, mechanical consistency. 700+ goals through sheer discipline.
  makeEventDef("the_machine", "机器", "你的作息表贴在更衣柜里：6:30起床，7:00早餐，7:30训练，12:00午餐，14:00午睡，15:00第二次训练，19:00晚餐，21:30睡觉。\n每一项后面都打了勾。每一天都打了勾。你的队友说你是「机器人」——你不喝酒、不吃垃圾食品、不走夜场。你的生活像一台机器一样运转。\n但机器不需要意志力——你需要。每个晚上当你看到朋友出去玩的时候，你选择睡觉。每个冬天当你想偷懒的时候，你选择训练。这就是你的天赋：不是进球——是日复一日地选择进球。", 15,
    (ctx) => ctx.player.overall >= 76 && ctx.age >= 26 && ctx.role === "starter",
    [{ key: "maintain_machine", text: "继续——机器的运转是一切的根基" }, { key: "live_a_little", text: "也许偶尔放松一天也无妨" }], "rare"),

  // P-A68: legend bond — the Ronaldinho-Messi dimension. When two eras
  // overlap briefly and create magic. The legend who tees up the future legend.
  makeEventDef("legend_bond", "传奇之交", "更衣室里你最熟的队友比你大七岁——他是这支球队的国王，你是刚来的新人。\n但他在训练中给你传球——不是偶尔，是每一次。他在赛后等你一起走。他对媒体说「这个孩子会比我都好」。你不知道一个巨星为什么要对你这么好。\n有一天他在训练中给你传了一个球——一个你不需要跑就能接到的球。你进了。那是你在一线队的第一个进球。你跑过去拥抱他，他笑了：「这只是第一个。」你知道他不会永远在这里——但此刻你们在一起。", 10,
    (ctx) => ctx.player.overall >= 66 && ctx.age <= 22 && ctx.club.rep >= 5,
    [{ key: "absorb", text: "向他学习一切——趁他还在" }, { key: "be_yourself", text: "我不想成为他，我想成为我自己" }], "rare"),

  // P-A69: one club — the Totti dimension. 24 years, 619 games, 250 goals,
  // one shirt. The ultimate loyalty in a world that rewards betrayal.
  makeEventDef("one_club", "一生一队", "你的母队不是最大的俱乐部。它没有最多的奖杯，没有最亮的灯光。\n但它在你出生的城市，它的球迷说你的方言，它的球场离你家二十分钟。每一个转会窗都有豪门来找你——更多的钱，更大的舞台，更多的奖杯。你每一次都说「不」。\n你在这里已经十年了。你穿着同一件球衣，在同一座球场，为同一群球迷。你的衣柜里没有别的球衣。也许你少了几座奖杯。但你的名字刻在了这座城市的石头里——那比任何奖杯都久。", 8,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 28 && ctx.role === "starter",
    [{ key: "stay_forever", text: "留下——我是这座城市的人" }, { key: "one_last_move", text: "也许最后一站去别处看看" }], "legendary"),

  // P-A70: two worlds — the Bale dimension. When you're a villain at your
  // club and a god for your country. The gap that nobody understands.
  makeEventDef("two_worlds", "两个世界", (n) => `你在俱乐部被嘘了——又一次。你刚帮${n.club}赢下${n.continentalClubCup}，但球迷只记得你没跑的那次回防。\n但回到国家队，你是另一个你。你走进更衣室，队友看着你的眼神像看一面旗帜。你为你的国家打进了历史性的进球——你称之为「${n.nation}足球史上最伟大的时刻」。你唱国歌的时候眼眶发红——在俱乐部你从来不唱。\n你是两个世界的人。一个世界恨你，一个世界爱你。你不知道哪个是真的你。也许两个都是。`, 15,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 26,
    [{ key: "country_first", text: "国家队是我的灵魂——俱乐部只是工作" }, { key: "bridge_both", text: "我不想只在一个世界被爱" }]),

  // P-A71: the uncompromising artist — the Riquelme dimension. "I never smile
  // when I play." The genius who refuses to run, refuse to adapt, refuses to
  // become something he isn't. The last true number 10.
  makeEventDef("uncompromising", "不妥协", "你的教练要你跑更多、防守更多、跑动更多。你要变得更像一个机器。\n但你不是一个机器。你是一个10号——古典的、缓慢的、思考的10号。你不跑不是因为你懒——是因为你看到的东西在跑之前就决定了。你站在那里像一棵树，但你的传球像风。\n教练说「现代足球不允许你这样踢」。你说「那现代足球就不适合我」。你看着他——你知道你可能会被放上板凳。但你不会改变。你不是不能跑——你是不愿意为了跑而忘记思考。", 12,
    (ctx) => (ctx.player.position === "CAM" || ctx.player.position === "CM") && ctx.player.overall >= 78 && ctx.role === "starter",
    [{ key: "stay_true", text: "我不会改变——我是最后的古典10号" }, { key: "adapt", text: "也许我该学会跑——即使不情愿" }], "rare"),

  // P-A72: lost instinct — the Shevchenko dimension. The cruelest decline:
  // not injury, not age, but the thing that made you great simply vanishing.
  makeEventDef("lost_instinct", "射门消失", "你又一次站在了禁区里。球到了你脚下——和以前一模一样的位置。\n但你的脚不知道该做什么了。那个曾经不需要思考的本能——那种在零点几秒内决定射哪里、怎么射、用哪只脚的能力——它不见了。你看着球，球看着你，然后你踢偏了。\n你没有受伤，你没有老到不行。你只是……不会了。你不知道它去哪了。它就像你身体里的一个开关被关掉了。", 8,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 28 && (ctx.player.position === "ST" || ctx.player.position === "LW" || ctx.player.position === "RW"),
    [{ key: "find_it", text: "拼命找回来——它一定还在某个地方" }, { key: "reinvent", text: "也许我该换一种方式踢球" }], "rare"),

  // P-A73: quiet exit — the Khedira dimension. Not a tragedy, not a hero's
  // farewell. Just a row of zeros and silence. The quietest ending in football.
  makeEventDef("quiet_exit", "安静消失", (n) => `你的赛季数据表躺在桌上：出场0，进球0，助攻0，零封0。一排零。\n你没有受伤，没有被停赛，没有被骂。你只是……不被需要了。新教练不看你，队友不问你，媒体不提你。你在训练中跑得比任何人都多，但没有人在数。\n你想起十年前你站在世界杯的球场上，为${n.nation}进了球——全场七万人都在喊你的名字。现在更衣室里没有人喊你了。你不是退场——你是被遗忘了。`, 10,
    (ctx) => ctx.player.overall >= 74 && ctx.age >= 30 && (ctx.role === "substitute" || ctx.role === "low_rotation"),
    [{ key: "one_last_try", text: "再拼一次——我不想被遗忘" }, { key: "walk_quietly", text: "安静地走——不是每个人都需要告别赛" }]),

  // P-A74: overshadowed — the Dybala dimension. When a bigger star arrives
  // and you become the supporting cast in your own story.
  makeEventDef("overshadowed", "让位", "俱乐部签了一个比你大的人。全世界的镜头都转向了他。\n你曾经是这支球队的头牌——你的海报挂在球场外，你的名字在球迷的歌里。现在他的海报覆盖了你的，你的歌被他的歌取代了。教练把你挪到了你不擅长的位置——因为那个位置要让给他。\n你坐在更衣室里看着你的更衣柜——还在原来的位置，但旁边多了一个比你大三倍的柜子。你还在队里。但你不再是主角了。", 30,
    (ctx) => ctx.player.overall >= 76 && ctx.age >= 24 && ctx.role === "starter" && ctx.club.rep >= 7,
    [{ key: "accept_role", text: "接受配角——和他一起赢也是赢" }, { key: "demand_trade", text: "我不要做配角——让我走" }]),

  // P-A75: uncontrolled genius — the Cassano dimension. "Cassanata" became
  // a word. He knew he was wasting his talent — and couldn't stop.
  makeEventDef("uncontrolled_genius", "失控的天才", (n) => `你又做了蠢事——在更衣室里和教练吵了一架，把球衣扔在了地上，在赛后聚餐迟到了两个小时。\n你的教练在新闻发布会上发明了一个词来描述你的行为——那个词后来成了${n.league}的通用黑话，意思就是「不符合球队精神的行为」。你的名字变成了一个形容词。\n你知道你在浪费什么。你知道你本可以是这一代最好的那一个。但你控制不了自己——你的天赋在一条线上，你的自控力在另一条线上，它们从来不交叉。你看着镜子里的自己说「为什么？」镜子没有回答。`, 20,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 22,
    [{ key: "try_control", text: "这次真的改——我不想成为那个故事" }, { key: "accept_self", text: "我就是我——也许天才和疯子住同一个身体" }]),

  // P-A76: metabolic illness — the Götze dimension. Not injury, not age, not
  // attitude. Your own body's chemistry turning against you. The enemy within.
  makeEventDef("metabolic_illness", "代谢疾病", (n) => `你不知道从什么时候开始的。也许是一年前——你发现训练后恢复比以前慢了。然后你的体重在不该涨的时候涨了。然后你跑不动了。\n队医把你叫到办公室，关上了门。他说了一个词——一个你从没在足球语境里听过的词。代谢疾病。不是伤，不是累，是你身体内部的化学出了问题。它在慢慢吞噬你的肌肉、你的速度、你的能量。\n你年轻的时候进过这个国家最重要的那个球。你现在${n.ageCn}岁，你的身体在背叛你。不是被铲的——是自己坏的。`, 8,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 26,
    [{ key: "fight_illness", text: "和它斗——治疗、饮食、一切手段" }, { key: "accept_reality", text: "接受它——我踢不了从前那种球了" }], "rare"),

  // P-A77: signature skill — the Juninho dimension. 77 free kicks. More than
  // anyone in history. One technique practiced since age 13 until it became a weapon.
  makeEventDef("signature_skill", "绝技", "你从十三岁开始练任意球。每天训练后你留下来——当别人走了的时候，你还在踢。\n你研究了一个老录像里那个人的技术，你微调了他的公式。你学会了让球不旋转——让它在空中跳舞，让门将猜不透它要去哪。你练了这么多年，踢了上万次。你的队友说你的任意球像一把武器——你笑了，它不是武器，它是你唯一拥有的东西。\n你的跑动不快，你的身体不强，你的传球不算最好。但你的任意球——你的任意球是这个世界最好的。", 12,
    (ctx) => ctx.player.overall >= 75 && (ctx.role === "starter" || ctx.role === "high_rotation") && ctx.player.position !== "GK",
    [{ key: "master_it", text: "继续精进——让它成为传奇" }, { key: "round_out", text: "也许我该变得更全面" }], "rare"),

  // P-A78: can't stop — the Buffon dimension. 45 years old, still diving.
  // Not for glory, not for money — because you can't imagine not playing.
  makeEventDef("cant_stop", "不愿停", (n) => `你${n.ageCn}岁了。你的队友比你小一整代。他们叫你「叔叔」。\n你的膝盖在每次扑救后都会响，你的恢复时间从一天变成了三天。你的队友退役了——第一批退役的比你大三岁，最后一批比你小十五岁。你看着他们一个一个走。\n但你还在。你不是不想停——你是不知道怎么停。从${n.startAgeCn}岁到${n.ageCn}岁，你的每一天都在球门前。你不知道球门外的你是什么样。也许你害怕那个人。也许你只是还爱着这个。你站在门线上看着球飞来——你扑了出去。膝盖响了。你笑了。还在。`, 8,
    (ctx) => ctx.player.position === "GK" && ctx.age >= 34,
    [{ key: "keep_diving", text: "继续——我还不知道怎么停" }, { key: "finally_stop", text: "也许该让膝盖休息了" }], "rare"),

  // P-A79: underappreciated — the Yaya Touré dimension. The colossus who won
  // everything but felt invisible. "No one wished me happy birthday."
  makeEventDef("underappreciated", "不被尊重", "你帮这支俱乐部终结了三十五年的冠军荒。你进了制胜球。你是他们的巨人。\n但今天是你生日。更衣室里没有人提起。俱乐部发了一条推特庆祝了一个年轻球员的生日——他上周才进了一线队。你的手机里只有经纪人发来的「生日快乐」。\n你的经纪人说「你应该生气」。你不只是在生气——你在受伤。你帮他们赢得了所有东西，但他们连你的生日都不记得。也许尊重不是靠赢来的。也许它从来不是你能控制的。", 25,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 28 && ctx.role === "starter" && ctx.club.rep >= 6,
    [{ key: "demand_respect", text: "公开表态——我值得更多尊重" }, { key: "let_actions_speak", text: "用表现说话——他们迟早会记得" }]),

  // P-A80: patience runs out — the Batistuta dimension. Nine years, 168 goals,
  // a bronze statue, but no title. The moment loyalty meets ambition.
  makeEventDef("patience_runs_out", "耐心尽头", "你在这家俱乐部九年了。你进了168个联赛进球。球迷在城外给你立了青铜雕像。\n但你没有联赛冠军。每一年你都说「再等一年」，每一年冠军都没有来。你现在三十一了——前锋的黄金时间不多了。你的经纪人拿来了一份合同——不是最大的俱乐部，但他们的教练说「我们今年要夺冠，你是最后一块拼图」。\n你看着合同，又看着窗外的城市——你的铜像在那里。你的球迷在那里。你的九年也在那里。但你的冠军不在那里。", 10,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 28 && ctx.role === "starter" && ctx.club.rep <= 3,
    [{ key: "leave_for_title", text: "离开——我等了九年，不能再等了" }, { key: "stay_loyal", text: "再等一年——也许明年就是我们的" }], "legendary"),

  // P-A81: super sub — the Larsson dimension. Not a starter, not a star — but
  // the man who comes off the bench in the final and changes everything.
  makeEventDef("super_sub", "替补英雄", (n) => `你坐在板凳上。决赛。你们0-1落后。\n你不是首发——你${n.ageCn}了，你的膝盖装着一条人工韧带。教练在第七十分钟看向你。你站起来脱掉了训练服——你的身体比从前老了，但你的脑子比从前清楚了。\n你知道你只有二十分钟。二十分钟改变一场决赛。你的队友比你小一大截，他们紧张——你不紧张。你踢过比这更多的决赛。你上场了。`, 8,
    (ctx) => ctx.player.overall >= 73 && ctx.age >= 30 && (ctx.role === "substitute" || ctx.role === "high_rotation" || ctx.role === "low_rotation"),
    [{ key: "change_game", text: "上场——二十分钟够了" }, { key: "pass_torch", text: "让更年轻的人上，我在场边撑他" }], "legendary"),

  // P-A82: forgotten test — the Ferdinand dimension. Not malice, not injury —
  // just a stupid mistake. You forgot. And forgetting costs everything.
  makeEventDef("forgotten_test", "遗忘", "你训练完就走了。你去购物了。你忘了今天有药检。\n不是故意的——你只是忘了。但药检官不会因为「忘了」就原谅你。队医打电话来的时候你正在试鞋。你赶回训练基地——但已经太晚了。\n足协的调查组在等你。你的手机里有100条消息——经纪人、教练、媒体。你犯了一个不涉及任何恶意的错误，但代价可能是一切。你看着试到一半的那双鞋，想起你忘了的不是药检——是责任。", 15,
    (ctx) => ctx.player.overall >= 76 && ctx.age >= 24,
    [{ key: "accept_ban", text: "接受处罚——我犯了错，我承担" }, { key: "fight_it", text: "申诉——我不是故意的，这不公平" }], "rare"),

  // P-A83: beautiful football — the Gullit dimension. "Sexy football." The
  // belief that football should delight the eye, not just the scoreboard.
  makeEventDef("beautiful_football", "美丽足球", "你的教练在战术板上画了一个丑陋的阵型——防守反击，堆人墙，等对手犯错。\n你看着那个阵型想：这不是足球。足球应该让人想看。足球应该让人站起来。足球应该让对手说「我想那样踢」。\n你曾经在一个记者面前发明了一个词来形容你想踢的足球——「性感足球」。他们笑了。但你知道你在说什么。足球不只是赢——足球是赢的方式。你可以丑陋地赢，也可以美丽地赢。你选择美丽。", 15,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 24 && ctx.role === "starter",
    [{ key: "insist_beauty", text: "坚持美丽——赢要赢得漂亮" }, { key: "pragmatic", text: "赢就是赢——漂亮不重要" }], "rare"),

  // P-A84: hidden wounds — the Dele dimension. The decline that looks like
  // laziness but is actually a child's pain. The things football can't heal.
  makeEventDef("hidden_wounds", "隐藏的伤口", "你的状态在下滑。媒体说你「懒」「不专注」「浪费天赋」。他们不知道。\n他们不知道你小时候经历过什么。他们不知道你为什么有时候睡不着觉，为什么有时候训练时突然走神，为什么你在最该开心的时候反而最空。\n足球给了你一切——名声、金钱、掌声。但足球治不好你来到足球之前就有的伤。你的教练说「专注」，你的经纪人说「努力」。他们不知道你已经在用全部力气只是站在球场上。", 8,
    (ctx) => ctx.player.overall >= 76 && ctx.age >= 24,
    [{ key: "seek_help", text: "寻求帮助——我不能再一个人扛了" }, { key: "keep_hidden", text: "藏起来——没有人需要知道" }], "rare"),

  // P-A85: unchanged — the Kanté dimension. Win everything, change nothing.
  // The world's best player who still drives a Mini and eats his mother's cooking.
  makeEventDef("unchanged", "不变", (n) => `你赢了世界杯。你赢了${n.continentalClubCup}。你赢了两次联赛冠军。你是全世界最好的球员之一。\n你的经纪人开法拉利。你的队友开兰博基尼。你开Mini。不是因为买不起——是因为你觉得Mini够了。\n你的手机里有一条来自俱乐部的消息：他们想通过一个离岸账户给你发工资来避税。你的律师说「这很正常」。你说「不。我只要正常工资。」\n你在停车场下了车，走过那些跑车，上了你的Mini。你笑了。你想起你曾经骑着滑板车去训练。现在你开Mini。你已经变了——从滑板车到Mini。这大概就是你允许自己变的全部了。`, 8,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 26,
    [{ key: "stay_normal", text: "做那个不变的人——Mini就够了" }, { key: "enjoy_success", text: "我赢了这么多——也许我该享受一下" }], "legendary"),

  // P-A86: the bison — the Essien dimension. You give your body completely.
  // Not leadership, not skill — pure sacrifice. Football takes you apart piece by piece.
  makeEventDef("the_bison", "野牛", (n) => `你又一次倒在了地上。你的膝盖——那条已经被修过三次的十字韧带——又在抗议了。\n你不是一个技巧型球员，不是一个领袖型球员。你是一头野牛——你的价值是奔跑、抢断、覆盖每一寸草地。你的踢法注定了你的身体会被消耗。你看过你的伤病记录：三次十字韧带，无数次肌肉拉伤，两年多的缺阵日。\n队医说你的膝盖像四十岁的。你${n.ageCn}岁。但你需要上场——不是因为你想要，是因为没有你跑的那些距离，球队就不完整。`, 12,
    (ctx) => ctx.player.overall >= 76 && ctx.age >= 28 && (ctx.injuriesTaken ?? 0) >= 1,
    [{ key: "sacrifice_body", text: "继续跑——我的身体是给足球的" }, { key: "save_yourself", text: "也许该少跑一点了——我的膝盖在求我" }]),

  // P-A87: denied honor — the Sneijder dimension. You won everything — treble,
  // World Cup final — and they gave the award to someone else. You did everything.
  // It wasn't enough.
  makeEventDef("denied_honor", "被剥夺的荣誉", "金球奖的提名名单出来了。你的名字在上面——第四名。\n你今年什么都拿到了。你进了世界杯决赛。你在淘汰赛进了五个球。你做了一个人在一年里能做的所有事。\n但第一名是另一个人——他赢了联赛但世界杯八强就出局了。你看着他举起奖杯，想起你举起的那些杯。你举了好几座。他举了一座。但他举起了金球。\n你的手机里有100条消息说「你被抢了」。你不知道你被抢了还是不够好。你只知道你做了所有你能做的。有时候所有你能做的不够。", 10,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 26,
    [{ key: "let_it_go", text: "放下——奖杯不重要，我拿到的那些是真的" }, { key: "speak_out", text: "这不公平——我应该说出來" }], "rare"),

  // P-A88: raumdeuter — the Müller dimension. "Interpreter of space." Not the
  // fastest, not the most technical — but you see the gaps no one else sees.
  makeEventDef("raumdeuter", "空间解读者", "你的队友比你快，比你壮，比你技术好。他们的训练比你花哨，他们的进球比你漂亮。\n但你进了一个球——你站在了没有人站的位置。不是因为你跑得快到了那里，是因为你在球飞出去之前就知道了它会去哪。你不需要追球——你只需要在它落地的地方等。\n有人问你的位置叫什么。你想了一下说「空间解读者」。他们笑了——这不是一个位置。你说，也许它不需要是。也许有些人的天赋不在脚下，在眼睛里。", 15,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 24 && ctx.role === "starter" && ctx.player.position !== "GK" && ctx.player.position !== "CB" && ctx.player.position !== "CDM",
    [{ key: "master_space", text: "精读空间——我的天赋在眼睛里" }, { key: "try_technique", text: "也许我该练练脚下技术" }], "rare"),

  // P-A89: integrity — the Klose dimension. The ball goes in your hand, the
  // referee doesn't see it, and you tell him. "Kids are watching us."
  makeEventDef("integrity", "正直", "球进了。你的手碰到了球——裁判没看见，对方没看见，全场只有你知道。\n你的队友冲过来抱你。比分牌翻动了。但你知道这个球不是你的——它是你的手的。你看着裁判，他已经在往中圈走了。\n你的脑子在说两件事：一件事说「说出去」，一件事说「闭嘴」。你做了你的选择。", 12,
    (ctx) => ctx.player.overall >= 75 && ctx.role === "starter",
    [{ key: "tell_ref", text: "告诉裁判——这个球是我的手" }, { key: "stay_silent", text: "闭嘴——裁判没问，我不说" }], "rare"),

  // P-A90: common goal — the Mata dimension. Not giving alone — organizing
  // every player to give 1%. Collective philanthropy in an individual sport.
  makeEventDef("common_goal", "共同目标", "你在一次采访中宣布了一件事：你将捐出薪水的1%给慈善。\n记者问「为什么？」你说「因为我能。因为足球给了我这么多。」但你不只是自己捐——你要号召每个球员都捐。1%。不多。但如果每个人都捐，那就很多。\n你的经纪人说「你在让其他球员尴尬」。你说「不是尴尬——是邀请。」有些人会加入。有些人不会。但1%不是关于钱的——是关于一种想法：我们在一起比我们一个人更强。", 10,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 26,
    [{ key: "lead_movement", text: "发起运动——1%改变世界" }, { key: "just_donate", text: "自己捐就好——不需要让别人加入" }], "rare"),

  // P-A92: the national god — the Hagi dimension. Not representing a region
  // (Salah) — being the football soul of an entire small nation. When you
  // retire, the country begs you to come back.
  makeEventDef("national_god", "国神", "你的母国不大。它在世界足球版图上只是一个点。但你在那个点里，不是球员——是神。\n他们叫你「喀尔巴阡的马拉多纳」。你在世界杯上踢了一个35米的不旋转吊射，整个国家在那一秒停了下来。你退役后，国家电视台做了5个小时的节目求你回来。100个人在凌晨守在电视台外面喊你的名字。\n你问自己：「你算什么，让整个国家求你？」你不知道答案。但你知道一件事——你的国家没有你就不完整。这不是骄傲。这是重量。", 5,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 28,
    [{ key: "answer_call", text: "回应国家——他们需要我" }, { key: "stay_retired", text: "不回去——我已经给了足够多" }], "legendary"),

  // P-A93: the kick — the Koeman dimension. One free kick, one hundred years
  // of waiting. The moment a club's identity changes forever.
  // 那一脚 (Koeman): the defining free-kick in a final. The old desc claimed
  // 「你的俱乐部从来没有赢过这座奖杯——一百年来从来没有」——a club
  // trophy-drought the engine doesn't track and can't verify, and flatly false
  // when the event fires for Real Madrid / Bayern. Reframed to the WEIGHT of
  // the moment (this kick binds your name to this club) — true for any club +
  // any trophy — instead of asserting an unverifiable drought.
  makeEventDef("history_kick", "那一脚", "加时赛。0-0。决赛。这座奖杯对你和这家俱乐部都意义非凡——一脚下去，要么把你的名字和这家俱乐部永远绑在一起，要么抱憾终生。\n裁判吹了哨。任意球。禁区边缘。你站在球后面。你的队友看着你——他们知道你的脚，他们知道这一脚可能改变一切。\n你看了一眼人墙，看了一眼门将，看了一眼球门。你只需要一个缝隙。一个就够。你深吸一口气。漫长的等待，落在你的脚背上。", 5,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 26 && ctx.role === "starter",
    [{ key: "shoot", text: "起脚——写下这一刻" }, { key: "lay_off", text: "让队友来罚这一脚" }], "legendary"),

  // P-A94: the scar — the Ribéry dimension. You carry something on your face
  // everyone can see. They told you it makes you less. You proved them wrong.
  makeEventDef("the_scar", "伤疤", "你脸上的伤疤从小就有。两岁时的一场车祸——一百多针，留下了一道从额头到下巴的痕迹。\n你小时候被人看，被人问，被人笑话。青训营说你不符合「形象」。你做过建筑工，你在最低级别的联赛里踢过球。但你的脸不是你的全部——你的脚才是。\n你站在球场上，伤疤在阳光下很显眼。但你的球更快。你的速度更狠。你用你的脚回答那些看你的脸的人。", 10,
    (ctx) => ctx.player.overall >= 73 && ctx.age >= 20,
    [{ key: "own_it", text: "这是我的——人们只能接受我本来的样子" }, { key: "hide_it", text: "也许我该想办法遮住它" }], "rare"),

  // P-A95: defensive art — the Maldini dimension. Defending as beauty. The
  // player who made stopping goals more elegant than scoring them.
  makeEventDef("defensive_art", "防守艺术", (n) => `你是一个后卫。你的工作不是进球——是阻止进球。\n前锋进球了全场欢呼。你阻止了一个进球——没有人欢呼。你的队友说「好防守」，然后走开了。没有人给你做集锦。没有人唱你的名字。\n但你知道：最好的防守不需要铲球。最好的防守是站在正确的位置，让对手觉得那里没有空间。对面的头牌说你拿球时「不像后卫，像优雅的中场」。一位名宿说「需要15个球员才能拼出一个你」。\n你不需要进球来证明你的价值。你只需要让对手进不了球。${cnNum(Math.max(1, n.careerSeasons))}个赛季。${n.careerApps}场。红牌几张就数完了。你做到了。`, 8,
    (ctx) => (ctx.player.position === "CB" || ctx.player.position === "LB" || ctx.player.position === "RB" || ctx.player.position === "CDM") && ctx.player.overall >= 80 && ctx.role === "starter",
    [{ key: "elegant_defense", text: "让防守成为艺术——不铲球只站位" }, { key: "tough_defender", text: "用硬碰硬——铲断才是后卫的本分" }], "rare"),

  // P-A96: miracle comeback — the Cazorla dimension. 8 surgeries, gangrene, skin
  // graft from arm (destroying a daughter's name tattoo), told to be happy to walk.
  // Then he came back and scored 11 goals at 35.
  makeEventDef("miracle_comeback", "奇迹复出", "你已经做了八次手术了。你的脚踝上的皮肤从你的手臂上移植过来的——你女儿名字的纹身被皮肤移植覆盖了。\n医生说「如果你能再走路，你就应该满足了。」你说你想踢球。医生没有笑——他只是看着你，那种「我不知道该说什么」的眼神。\n你躺在病床上看着天花板。636天没有踢球了。你的脚踝感染过坏疽。他们差点截肢。你想起你女儿的名字——它不在你手臂上了，被皮肤移植盖住了。但它在你的脑子里。", 3,
    (ctx) => ctx.player.overall >= 70 && ctx.age >= 25 && (ctx.injuriesTaken ?? 0) >= 1,
    [{ key: "fight_back", text: "我要回来——不只是走路，我要踢球" }, { key: "be_grateful", text: "能走路就够了——足球不值得再赌一次" }], "legendary"),

  // P-A97: the captain's save — the Casillas dimension. A goalkeeper who
  // saves the World Cup final one-on-one, then lifts the trophy in tears.
  // The last line of defense becomes the first face of triumph.
  makeEventDef("captain_save", "队长的扑救", "世界杯决赛。0-0。加时赛。\n对方前锋过掉了所有人。全场只有你和——他。一对一。你的整个国家在你的身后，在你的手套里。\n你小时候在电视上看别人举起世界杯——Matthäus、Dunga、Deschamps、Cafu、Cannavaro。你想过有一天那个举起奖杯的人会是你吗？你不知道。你只知道此刻球向他飞来了。", 3,
    (ctx) => ctx.player.position === "GK" && ctx.player.overall >= 82 && ctx.age >= 22,
    [{ key: "dive", text: "扑出去——你身后是整个国家" }, { key: "stay_narrow", text: "站住封角度，等他先动" }], "legendary"),

  // P-A98: reinvention — the Valencia dimension. From winger to right-back.
  // When your old position kills you, you don't die — you become someone else.
  makeEventDef("reinvention", "重生", (n) => `你的速度不在了。你知道——曾经追上过任何人的腿，现在追不上了。\n你的教练看着你的数据说「你的边锋生涯快到头了。」你没有反驳——你知道他说得对。但他说了后半句：「但你的防守意识是全队最好的。你愿不愿意改踢后卫？」\n你看着他，想起你从小踢的位置。改位置意味着从零开始——你是一个${n.ageCn}岁的「新秀」。你的队友会怎么看你？球迷会怎么看你？你不知道。你知道的是：不改，你就完了。`, 20,
    (ctx) => ctx.player.overall >= 76 && ctx.age >= 28 && (ctx.player.position === "LW" || ctx.player.position === "RW" || ctx.player.position === "CAM" || ctx.player.position === "LM" || ctx.player.position === "RM"),
    [{ key: "change_position", text: "改——与其死在老位置，不如在新位置活" }, { key: "stay_winger", text: "不——我是边锋，死也是边锋" }]),

  // P-A99: the dark impulse — the Suárez dimension. The line between
  // competitive fire and something ugly. The genius who couldn't always
  // distinguish between intensity and destruction.
  makeEventDef("dark_impulse", "黑暗冲动", "你又一次在禁区内和一个后卫纠缠。他拽了你的球衣——你回头咬了他的肩膀。\n你不知道你为什么咬了——你的脑子在那一秒是空白的。你的身体比你的理智快了半秒。全场安静了。裁判在跑过来。你的队友看着你的眼神不是震惊——是「又来了」。\n这已经不是第一次了。你知道你有这个问题——你在球场上有时候控制不住自己。你的天赋是真的，你的进球是真的，但你咬人也是真的。你坐在更衣室里看着手机——禁赛通知来了。你关掉手机。你看着镜子里的自己，不知道哪个是真的你——进球的那个，还是咬人的那个。", 8,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 24,
    [{ key: "seek_help", text: "我需要改变——这不是我" }, { key: "accept_darkness", text: "这就是我——天才和野兽住同一个身体" }], "rare"),

  // P-A100: the predator — the Inzaghi dimension. "Born offside." Not fast,
  // not strong, not technical — but always in the right place at the right
  // time. The goals are in love with him.
  makeEventDef("predator", "越线猎手", "你的队友说你「不会踢球」。一位名宿说你「不会踢球，只是总是站在正确的位置」。\n你不知道该不该生气。你说得对——你盘带不好，你传球一般，你速度不算快，你身体不算壮。但你知道一件事：球会在哪里。你在越位线上站了一整场，裁判吹了你三次越位。但第四次——你没有越位。球到了你脚下。你进了。\n对面的老帅说你是「出生越位的」。你笑了——也许他说得对。但进球不在乎你怎么进的。进球只在乎你进了。", 15,
    (ctx) => ctx.player.position === "ST" && ctx.player.overall >= 74 && ctx.role === "starter",
    [{ key: "trust_instinct", text: "继续站在越位线上——进球会找到我" }, { key: "learn_to_play", text: "也许我该学会真的'踢球'" }], "rare"),

  // P-A101: filial duty — the Son dimension. A father who shaped everything.
  // Military exemption on the line. The weight of family and nation combined.
  makeEventDef("filial_duty", "父与国", (n) => `你的父亲也是一个球员——一个没能走远的球员。他把他的梦想放在了你的脚上。\n他训练你到吐。他让你做一千个颠球，做不到就重来。他说「如果你的基本功不够好，你在外面一天都活不下来。」你${n.startAgeCn}岁一个人出了国——语言不通，朋友全无。你靠看动画片学当地话。\n现在你站在${n.nationId === "kor" ? "亚运会" : n.continentalCup}决赛上。${n.nationId === "kor" ? "如果你赢了，你的队友们可以免兵役。如果你输了——他们要去当两年兵。" : `${n.nation}上一次站在这里，是在你出生之前。如果你赢了，这一代人会记你一辈子。如果你输了——你会是那个输掉的人。`}你不只是在踢球——你扛着他们的未来。你父亲在电视机前看着你。你的国家在看着你。`, 5,
    (ctx) => ctx.player.overall >= 76 && ctx.age >= 24,
    [{ key: "carry_all", text: "扛起所有人的未来——这是我的责任" }, { key: "just_play", text: "我只能踢好我自己的球" }], "legendary"),

  // P-A102: redemption arc — the Di María dimension. Three finals lost. Two
  // through injury. Then one day it all changes. The player who kept showing
  // up after losing everything.
  makeEventDef("redemption_arc", "救赎", (n) => `你输了三个决赛了。世界杯决赛你受伤了没上场——队友输了。${n.continentalCup}决赛你伤了——又输了。又一个${n.continentalCup}决赛——又伤了，又输了点球。\n每一次你都说「下一次」。每一次下一次都还是输了。你的队友开始不看你——不是怪你，是不知道该怎么看你。他们知道你已经尽力了。但「尽力了」不等于「赢了」。\n现在又一次决赛来了。你的身体还在，你的腿还在，你的心还在。你不知道这是不是你的最后一次。但你知道一件事——你不会因为怕输就不上场。你会上场。你会输或赢。但你会上场。`, 5,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 28,
    [{ key: "one_more_time", text: "再上场一次——这一次会不同" }, { key: "pass_the_armband", text: "让年轻人冲，我在场边撑他们" }], "legendary"),

  // P-A103: the invisible engine — the Makélélé dimension. 607 games, 18 goals.
  // A position named after you. The work no one notices until it stops.
  makeEventDef("invisible_engine", "隐形引擎", (n) => `你在${n.careerApps}场比赛里只进了${n.careerGoals}个球。你的前锋队友每场进两个。你的教练从不夸你——因为他没注意到你在做什么。\n但你的队友知道。队长说你是「全队最好的球员」，只是「没人注意到」。你的主席说你「不会头球，传球不过三米」。他想把你卖了。\n一位名宿说了一句关于你的话——也许是足球史上最好的夸奖：「为什么要给宾利再刷一层金漆，如果你在丢失整个引擎？」\n你不需要进球。你不需要被夸。你只需要做那件没人看见但所有人都需要的事。你是引擎。引擎不发光——但没有引擎车不会走。`, 8,
    (ctx) => ctx.player.position === "CDM" && ctx.player.overall >= 74 && ctx.role === "starter",
    [{ key: "keep_invisible", text: "继续做引擎——不需要被看见" }, { key: "demand_recognition", text: "我值得更多——要求涨薪或转会" }], "rare"),

  // P-A104: the horror tackle — the Eduardo dimension. The injury so graphic
  // the TV refused to replay it. The comeback that was never quite the same.
  makeEventDef("horror_tackle", "断腿", "你听到了声音。不是骨头的——是比骨头更深的声音。\n你躺在草地上看着自己的脚踝。它朝着一个不应该是的方向。全场安静了。你的对手被红牌罚下了——他看着你的脚踝，他的脸是白的。\n电视转播没有重放这个画面。他们说「太残忍了」。你在担架上被抬走的时候，你的队友Gilberto跟着你——他是唯一一个会说你的语言和英语的人。他是你在担架上的翻译。你在救护车里问他「我会不会再踢球？」他没有回答。", 5,
    (ctx) => ctx.player.overall >= 73 && ctx.age >= 22 && ctx.role === "starter",
    [{ key: "comeback", text: "我要回来——一年后我会再进球" }, { key: "accept_devastation", text: "也许这就是终点了" }], "legendary"),

  // P-A105: tunnel war — the Vieira/Keane dimension. Two captains who would
  // not yield an inch. The fire that defined an era.
  makeEventDef("tunnel_war", "通道之战", "你在球员通道里遇到了对方的队长。他比你矮比你壮比你凶。\n他指着你的队友说「如果你碰他一下，我让你再也踢不了球。」你看着他——你认识的，你和他打了十年了。\n你的队友在你身后。他的队友在他身后。两个更衣室之间只有三米。你们在三米里站着，谁不让谁。裁判在跑过来。教练在喊。但通道里只有你们两个——两个队长，两种火。\n你可以说一句话。你只有一个选择。", 12,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 26 && ctx.role === "starter",
    [{ key: "stand_tall", text: "不让——来啊，看谁先退" }, { key: "walk_away", text: "不在这里——在球场上见" }]),

  // P-A106: Panenka — the Hakimi dimension. Penalties against your birth
  // nation. The calmest chip in the world. Africa's first semi-final.
  makeEventDef("panenka", "勺子", (n) => `世界杯淘汰赛。点球大战。你的对手是${n.worldRivalNation}——上一届的四强。\n你站在点球点前。你的队友们在等你。整个${n.continent}在等你。${n.nation}在等你——${n.isPowerhouse ? "上一次站在这里，是在你出生之前" : "等这一天等了太久太久"}。\n你看着门将。你知道他在猜——往左还是往右？你笑了。你不往左也不往右。你往中间。\n你起脚了。球慢慢飞向空中。时间慢了下来。`, 3,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 24,
    [{ key: "chip", text: "勺子——往中间挑" }, { key: "power_corner", text: "往角落爆射，不耍花活" }], "legendary"),

  // P-A107: the silent fall — the Foé dimension. The most devastating event
  // in the pool: a player who dies on the pitch. Not a choice — but how the
  // world responds to you matters.
  makeEventDef("silent_fall", "沉默倒下", "第七十二分钟。你在中圈。没有人碰你。\n你感觉——不对。你的胸口在紧。你的腿在软。你想站住，但草地在向你靠近。\n教练在场边看着你——他在犹豫要不要把你换下。你今早说「我要踢」的时候，他就这么犹豫过。你身体不舒服，可你总是坚持的。\n你现在还能举起手，示意他。", 2,
    (ctx) => ctx.player.overall >= 73 && ctx.age >= 25,
    [{ key: "fight_for_life", text: "挥手——我没事，继续踢" }, { key: "ask_off", text: "举手示意——换我下去，我不对劲" }], "legendary"),

  // P-A109: the uncrowned — the Quintero dimension. "Could go on to become a
  // player on par with Lionel Messi." Instead: three returns to River Plate,
  // a career of wandering. Genius without a home.
  makeEventDef("uncrowned", "未加冕", (n) => `有人在你还是个孩子的时候说你「可以成为那种传奇」。\n你信了。你的左脚确实像——同样的低重心，同样的转身，同样的弧线球。但你没有那种速度，没有那种身体，没有那种稳定性。你在${n.league}坐了三年板凳——每场二十分钟。你去过一个没人转播的联赛踢了一年。你回过${n.homeLeague}三次。\n你的天才从来没有疑问——但你的天才从来没有找到一个家。你像一个永远在搬家的天才：每个地方住一段时间，然后走了。你的左脚能在任何地方踢出世界波。但你不知道自己属于哪里。`, 10,
    (ctx) => ctx.player.overall >= 75 && ctx.age >= 24 && (ctx.player.position === "CAM" || ctx.player.position === "CM" || ctx.player.position === "LM" || ctx.player.position === "RM"),
    [{ key: "keep_wandering", text: "继续寻找——天才总会找到家的" }, { key: "settle_down", text: "也许该停下来了——在某处扎根" }], "rare"),

  // P-A110: charm striker — the Giroud dimension. "He doesn't have the level to
  // play among the elite." 57 international goals later. France's all-time top scorer.
  makeEventDef("charm_striker", "魅力射手", (n) => `你的第一个教练说你「没有踢精英联赛的水平」。你比同代人晚了好几年才签下第一份职业合同。\n你不是最快的，不是技术最好的，不是最漂亮的。你的进球不漂亮——但它们进了。你为${n.nation}出场${n.caps}次，进了${n.capGoals}个球。但媒体始终说你「不够好」。\n你不知道该怎么回应——你没有天赋可以拿来回应，也没有速度可以拿来回应。你用一种没有人欣赏的方式回应：你站在那里，等球来，然后进了。就这样，一次又一次。也许不够漂亮。但进了就是进了。`, 15,
    (ctx) => ctx.player.position === "ST" && ctx.player.overall >= 73 && ctx.age >= 26,
    [{ key: "keep_scoring_ugly", text: "继续用丑陋的方式进球——57是57" }, { key: "try_beautiful", text: "也许我该进一些漂亮的球来证明他们错了" }], "rare"),

  // P-A111: too much passion — the Bruno Fernandes dimension. Cares so visibly
  // it spills over. "Petulant." "Whinging." Then wins the FA Cup as captain.
  makeEventDef("too_much_passion", "过度的热情", "你又一次在场上挥舞手臂了——裁判没吹你想要的犯规。\n解说员说你「petulant」「抱怨太多」。前任名宿说队长应该「沉着冷静」。你三张红牌了——整个赛季最多的人。你在更衣室里比任何人都大声。你的队友说你在乎太多了——在乎到溢出来。\n但你的助攻是联赛最多的。你的进球是队内最多的。你带着袖标赢了足总杯。那个说你「抱怨太多」的名宿改口了：「我错了，他的领导力是出色的。」也许在乎太多是缺点。也许它是你唯一会的东西。", 18,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 26 && ctx.role === "starter",
    [{ key: "keep_caring", text: "继续在乎——这就是我" }, { key: "calm_down", text: "也许我该学会沉着" }]),

  // P-A112: the wall — the Rúben Dias dimension. "Makes the whole team feel
  // safe." Not tackles — presence. Not saves — organization.
  makeEventDef("the_wall", "铜墙铁壁", "你来了之后，球队失球数降了一半。不是因为你抢断多——你的抢断不是最多的。\n但你的队友说：「有他在后面，我敢前压了。」你的教练说：「他让身边的人做出更好的决定。」你不是最亮的那个人——你是最暗的那个人。你看不见光——但你能感觉到安全。\n他们叫你「世界最佳中后卫」。你不知道你做了什么——你只是站在那里，告诉队友该往哪走，该什么时候压上，该什么时候回收。你不抢球——你让球找不到路。也许这就是最好的防守：不是挡住球——是让球放弃来。", 12,
    (ctx) => (ctx.player.position === "CB" || ctx.player.position === "CDM") && ctx.player.overall >= 80 && ctx.role === "starter",
    [{ key: "organize", text: "组织——让球放弃来" }, { key: "tackle_more", text: "抢断更多——我需要数据来证明自己" }], "rare"),

  // P-A130: the pivot — the Rodri dimension. First defensive midfielder to win
  // the Ballon d'Or in 34 years. "Irreplaceable." Won it while injured.
  makeEventDef("the_pivot", "枢纽", "你是防守型中场。多少年来没有这个位置的人赢过金球。\n你不进球——你让进球发生。你不抢断——你让球回到你脚下。你不跑全场——你站在中间，让所有球经过你。数据说你在场时球队胜率比你不在场时高20%。\n教练说你是「不可替代的」。你受伤了——赛季报销。但就在你受伤一个月后，你赢了赛季最佳。你在病床上举起了奖杯——一个不能踢球的人赢了最佳球员。\n也许这就是枢纽的定义：你不需要在场——你不在的时候，他们才知道你有多重要。", 5,
    (ctx) => (ctx.player.position === "CDM" || ctx.player.position === "CM") && ctx.player.overall >= 85 && ctx.age >= 24,
    [{ key: "accept_role", text: "接受——枢纽不需要进球来证明价值" }, { key: "refuse_pivot", text: "拒绝——我还能往前冲" }], "legendary"),

  // P-A131: the child prodigy — the Yamal dimension. 16 years old. Euro champion.
  // "A phenomenon born every 50 years." From Rocafonda to the summit.
  makeEventDef("child_prodigy", "神童", (n) => `你${n.ageCn}岁。你在${n.continentalCup}决赛上送出了助攻。你是${n.continentalCup}历史最年轻的进球者——进球那天离你生日还有四天。\n你来自${n.nation}的一个工人区——一条所有人都想离开的街。你的庆祝手势是那条街的门牌号。你每次进球都在告诉世界你从哪里来。\n有人说你是「每五十年才出一个的现象」。你不知道——你只知道你${n.ageCn}岁，你在踢球，你在赢。也许你还没到巅峰——这才是最可怕的。`, 5,
    // 门控放宽（event-uniformity）: 原 OVR≥82 @age≤19 不可达（19岁 max=63）→ 60@≤19，
    // 对齐实测 OVR 分布：19岁达60是 top10% 的真·神童（传奇稀有靠年龄窗+legendary 低基线）。
    (ctx) => ctx.player.overall >= 60 && ctx.age <= 19,
    [{ key: "stay_grounded", text: "记住那条街——它永远在你身后" }, { key: "embrace_hype", text: "享受一切——我是每五十年一个的现象" }], "legendary"),

  // P-A132: the conquering arrival — the Bellingham dimension. €103m at 19.
  // Four goals in four games. 30-yard El Clasico strike. "He seems like a veteran."
  makeEventDef("conquering_arrival", "征服", (n) => `你${n.ageCn}岁。${n.club}。一笔让所有人倒吸一口气的转会费。\n你在前四场比赛里进了四个球——追平了队史纪录。你在德比里进了一个30米的远射——那是${n.club}在德比里的第300球。你在补时绝杀了${n.bigClub}。\n你的教练说你「像一个老将」。你笑了——你${n.ageCn}岁。但你不知道${n.ageCn}岁应该是什么感觉——你只知道你在主场进球了，全场喊你的名字。\n你的偶像在这块草皮上踢过球。你小时候在卧室贴他的海报。现在你在他踢过球的地方踢球。也许偶像的意义不是你变成他——是你站在他站过的地方，做你自己的事。`, 8,
    (ctx) => ctx.player.overall >= 72 && ctx.age <= 22 && ctx.club.rep >= 5,
    [{ key: "fill_legend_boots", text: "穿上传奇的鞋——做自己的事" }, { key: "humble_start", text: "也许我不该急着追平纪录——我该做我" }], "rare"),

  // P-A133: the ACL prodigy — the Wirtz dimension. Youngest Bundesliga scorer
  // at 17. ACL tear at 19 against his former club. Missed the World Cup.
  // Came back. Won the league. "Transformed agony into triumph."
  makeEventDef("acl_prodigy", "十字韧带", (n) => `你是${n.league}历史最年轻的进球者——17岁34天。你进了一个球——对${n.bigClub}。\n然后你${n.ageCn}岁。你在对阵${n.formerClubOr}的比赛中撕裂了十字韧带。你本来要去世界杯的——教练说你会在名单里。你不会了。\n你在病床上看着世界杯在你没有的情况下进行。十个月的康复。你回来的时候——不是那个17岁破纪录的你了。你用了一个赛季才找到自己。\n但第二个赛季你赢了一切——联赛冠军、杯赛冠军、赛季最佳。你在夺冠那天进了一个帽子戏法。也许十字韧带没有拿走你的天赋——它只是让你等了一下。也许等待让你更好。`, 8,
    (ctx) => ctx.player.overall >= 74 && ctx.age >= 18 && ctx.age <= 24 && (ctx.player.position === "CAM" || ctx.player.position === "CM" || ctx.player.position === "LW" || ctx.player.position === "RW"),
    [{ key: "comeback_stronger", text: "回来更强——等待让我更好" }, { key: "fear_reinjury", text: "我怕再伤——也许该保护自己" }], "rare"),

  // P-A134: the puppet master — the Xavi dimension. "I look for spaces. All day.
  // I'm always looking." Football as chess at full sprint.
  makeEventDef("puppet_master", "棋手", "你不快。你不壮。你不能跳过三个人。\n但你能看到他们看不到的东西——空间。球还没到，你已经知道它该去哪了。你的队友说跟你踢球「像坐旋转木马」——pum, pum, pum, pum——球在你和他之间来回来回，对手转晕了。\n对面的老帅说「我不觉得他这辈子丢过球」。你笑了——你丢过。但你丢的时候球已经在下一个空间了。\n你在那届世界杯传了几百脚球——91%的到位率。你不进球。你不抢断。你只传球。但你的传球让进球发生。如果足球是一门科学，你发现了公式。", 8,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 24 && (ctx.player.position === "CM" || ctx.player.position === "CAM" || ctx.player.position === "CDM"),
    [{ key: "find_space", text: "寻找空间——一整天都在找" }, { key: "add_goals", text: "也许我该多进几个球" }], "rare"),

  // P-A135: the overused prodigy — the Pedri dimension. 73 games in one season
  // at 18. Burnout, injuries, the cost of too much too young.
  makeEventDef("overused_prodigy", "透支", (n) => `你这个赛季踢了73场比赛。\n俱乐部、${n.continentalCup}、奥运会——三个赛事连着踢。你的教练说「太多了」。你的俱乐部说「太多了」。但国家队教练要你去奥运会。你${n.ageCn}岁。你没有说不的权力——或者你不知道你有。\n你在第七十三场比赛的第八分钟倒下了。腿筋。你的赛季结束了。你从那以后就一直在受伤——因为你在最该长身体的年纪踢了七十三场比赛。也许天赋不是无限的。也许身体有它的上限。也许你需要在透支之前学会说不。`, 10,
    (ctx) => ctx.player.overall >= 72 && ctx.age <= 22 && ctx.role === "starter",
    [{ key: "learn_to_say_no", text: "学会说不——保护自己" }, { key: "play_everything", text: "踢吧——我年轻我恢复得快" }], "rare"),

  // P-A136: the penalty redemption — the Saka dimension. 19 years old, missed
  // the decisive penalty, faced racism, came back and scored in the next shootout.
  makeEventDef("penalty_redemption", "点球救赎", (n) => `你${n.ageCn}岁。${n.continentalCup}决赛。点球大战。你是第五个主罚的——这是你职业生涯第一次罚点球。\n你站在球前。全${n.nation}看着你。你起脚了——门将扑住了。\n你看着球在他手里。全场在欢呼——不是为你。你走回中圈的时候你的队友搂住了你。但你知道：从今天起你的名字和「罚失」绑在一起了。\n然后你的手机响了。种族歧视。几百条。你说「我早就知道会是这样的」。你${n.ageCn}岁。你面对了大人不敢面对的东西。`, 5,
    (ctx) => ctx.player.overall >= 78 && ctx.age <= 22,
    [{ key: "come_back_stronger", text: "回来——下个点球我会进" }, { key: "never_again", text: "我再也不罚点球了" }], "legendary"),

  // P-A137: the late bloomer — the Emi Martinez dimension. 8 years of loans.
  // 28 years old before his debut. Then World Cup hero. "The boy who waited."
  makeEventDef("late_bloomer", "大器晚成", (n) => `你做了八年的替补。\n六次外借，六个你现在都懒得念出名字的小球会——那些年在${n.formerClubOr}只踢了15场。你${n.ageCn}岁才等到属于自己的位置。\n你在杯赛决赛后哭了——你等了十年。但俱乐部不给你主力。你转会了——转会费一栏里终于有了个数字，一个等了十年的人才值这么点。\n然后你成了${n.nation}的英雄。大赛四分之一决赛你扑了两个点球。决赛你扑了一个单刀。你赢了金手套。你${n.ageCn}岁才真正开始——有些人这个岁数已经退役了。也许大器晚成不是迟到——是在正确的时刻准备好了。`, 5,
    (ctx) => ctx.player.position === "GK" && ctx.age >= 26 && ctx.player.overall >= 73,
    [{ key: "seize_moment", text: "抓住——我等了十年就是这一刻" }, { key: "stay_steady", text: "稳着踢，这种时刻不该逞强" }], "legendary"),

  // P-A138: the flickering star — the Chiesa dimension. Had everything at 23.
  // ACL tear. Lost it. £10m. 5 PL appearances. Still fighting.
  makeEventDef("flickering_star", "余烬", (n) => `你年轻时拥有一切。${n.continentalCup}的决赛夜。决赛进球。${n.formerClubOr}。整个${n.nation}在你脚下。\n然后你在1月的一个下午倒在了客场的草地上。十字韧带。七个月。你回来时——不是当年那个你了。\n你的身价跌了一大截。你在${n.club}一个赛季只踢了5场${n.league}。球迷问你「他还能踢吗？」你不知道答案。\n但你在9月当选了月最佳——在黑暗里待了两年后。也许你不是当年那个你了。也许你是另一个你——一个从废墟里爬出来的你。也许余烬不是火灭了——是火变小了但没灭。`, 5,
    (ctx) => ctx.player.overall >= 76 && ctx.age >= 24 && ctx.age <= 30 && (ctx.player.position === "LW" || ctx.player.position === "RW" || ctx.player.position === "ST"),
    [{ key: "keep_fighting", text: "继续——火没灭只是小了" }, { key: "accept_new_self", text: "接受——我不再是从前的我" }], "rare"),

  // P-A139: two brothers two nations — the Williams dimension. Parents crossed
  // the Sahara barefoot. Two brothers, two national teams. Love and choice.
  makeEventDef("two_brothers", "兄弟", (n) => `你的父母走了很远的路才到${n.nation}——一段他们从来不肯细说的路。\n他们撕掉了旧护照，换了一个说法——为了活。你和你哥哥在同一家青训长大，一起踢球，一起上场。\n但国家队只能选一个。你选了${n.nation}——他选了父母出生的那个国家。你们永远不会在国际赛场上并肩。你球衣背后印着和他一样的姓——你永远是他的弟弟。\n${n.continentalCup}决赛你进了第一个球。你赢了。你哥哥在另一块大陆看着你。也许选择不是分开——是各自走自己的路然后在终点等对方。`, 5,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 20,
    [{ key: "play_for_spain", text: "为我长大的国家——这里是我的家" }, { key: "play_for_parents_land", text: "为父母的祖国——不要忘记来路" }], "rare"),

  // P-A140: the dance through the storm — the Vinícius dimension. 26 racist
  // incidents. Hanged effigy. Christ the Redeemer went dark. He kept dancing.
  makeEventDef("dance_through_storm", "风暴中的舞", (n) => `他们朝你做猴子叫。26次了。\n他们在你训练场外的桥上吊了一个假人——长得像你。四个人被逮捕了。你的俱乐部说这是「对文明的攻击」。整个${n.nation}都在为你说话。你家乡的城市为你熄了一夜的灯。150个组织联名写信。\n你每次进球后跳舞——他们说你挑衅。你的教练说你要冷静。有人说你自找的。你不知道——你只知道你从${n.nation}一条没人听说过的街来，你从贫穷里走出来，你在${n.club}进球了。\n你继续跳。也许跳舞不是挑衅——是你的回答。也许你的回答不是语言——是你的脚。也许你从那条街走到${n.club}，就是为了跳舞给全世界看。`, 5,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 20,
    [{ key: "keep_dancing", text: "继续跳——跳舞是我的回答" }, { key: "stop_dancing", text: "也许该安静一点——少惹麻烦" }], "legendary"),

  // P-A141: the bull who stayed — the Lautaro dimension. Turned down Real Madrid
  // at 18. Survived Lukaku's departure. Became captain. Chose staying over money.
  makeEventDef("the_bull_stayed", "留下的公牛", (n) => `你还年轻的时候${n.bigClub}要你。你说不——你说你没准备好。\n然后另一家豪门私下给你做了体检——你的俱乐部骂了他们。你留下了。\n你到了${n.club}。队里那个头号射手来了——你们一起赢了联赛。然后他走了——你没有跟着走。你成了唯一的射手。你成了队长。\n${n.careerOutput}个${n.outputLabel}。${n.careerApps}场比赛。你没有转会声明——你的转会声明是你的合同。每次有人来挖你，你签了续约。他们叫你「公牛」——因为你低头往前冲，不看旁边。\n也许留下不是不敢走——是不需要走。也许传奇不是在哪里踢——是在一个地方踢了多久。`, 5,
    (ctx) => ctx.player.overall >= 82 && ctx.age >= 28 && ctx.role === "starter" && ctx.club.rep <= 4,
    [{ key: "stay_captain", text: "留下——我是这里的队长" }, { key: "chase_bigger", text: "也许该去更大的舞台了" }], "legendary"),

  // P-A142: the jewel — the Dybala dimension. "The next Messi." 115 goals for
  // Juventus. But always close to the summit, never quite at it.
  makeEventDef("the_jewel", "明珠", (n) => `他们叫你「明珠」。他们说你会是下一个传奇。\n你在${n.formerClubOr}进了很多球——多到队史榜上绕不开你。你在${n.continentalClubCup}的决赛首发出场。你赢过MVP。你为${n.nation}出场了${n.caps}次。\n但——你总是差一步。${n.continentalClubCup}决赛输了4-1。一个更大的名字来了，你被挪了位置。5个联赛进球那个赛季。${n.formerClubOr}不续约了。你在${n.club}进了另一个决赛的球——但点球输了。你赢了世界杯——但你只上了两分钟。\n也许明珠不是最大的宝石——但它是最稀有的。也许「差一步」不是失败——是一段非常好的生涯，只是没成为传奇。也许不是每个人都要成为那种传奇。也许成为${n.name}就够了。`, 5,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 30 && (ctx.player.position === "CAM" || ctx.player.position === "ST" || ctx.player.position === "LW" || ctx.player.position === "RW"),
    [{ key: "accept_good_not_great", text: "接受——成为我自己就够了" }, { key: "chase_one_more", text: "再追一次——也许这次到了" }], "rare"),

  // P-A144: the record fee — the Caicedo dimension. £115m at 21. Debut penalty
  // conceded. 50-yard first goal. "The youngest of 10 siblings from a poor upbringing."
  makeEventDef("record_fee", "天价新援", (n) => `你${n.ageCn}岁。一笔${n.league}转会纪录。\n你是最小的——十个兄弟姐妹里最小的。你说你想成为「${n.nation}历史上最伟大的球员」。他们把你从${n.formerClubOr}买到了${n.club}——你穿上了一个传奇穿过的${n.squadNumber}号。\n你第一场比赛就送了一个点球。1-3输了。你说你是「天价新援」——媒体笑了。你没有笑。你在训练场待到深夜。\n然后你在最后一轮从50米外进了你的第一个球。赛季最佳进球。也许那个数字不是重量——是你哥哥姐姐们的期望。也许你不是在踢球——你是在证明一个穷孩子可以值这个价。`, 10,
    (ctx) => ctx.player.overall >= 72 && ctx.age <= 24 && (ctx.player.position === "CDM" || ctx.player.position === "CM") && ctx.club.rep >= 5,
    [{ key: "prove_worthy", text: "证明——穷孩子可以值这个价" }, { key: "drown_in_pressure", text: "也许我扛不住——太重了" }], "rare"),

  // P-A145: the Georgian pioneer — the Kvaratskhelia dimension. From Tbilisi to
  // "Kvaradona." €10m from Napoli. First Georgian at a major tournament.
  makeEventDef("georgian_pioneer", "先驱", (n) => `你来自${n.nation}——一个没有人指望在足球上听到名字的国家。\n你${n.startAgeCn}岁就踢上了成年队。你在国外踢了两年——然后出了事，你回家了。你在家乡的球队踢了11场进了8个球。\n${n.club}把你买来的时候——便宜得像捡来的。你第一场就进了球。他们开始拿你的名字造词。\n你带着${n.nation}打进了它从来没有到过的地方。你对${n.rivalNation}进了球——一个小国的大日子。全世界的电视台都在说你「改变了${n.nation}的足球」。\n也许先驱不是第一个踢球的人——是第一个让全世界看到的人。也许你的盘带不只是过人——是在告诉世界${n.nation}在哪里。`, 5,
    // Gated to nations with no World Cup pedigree — telling Brazil that nobody
    // has heard of its football would be the exact mismatch this rewrite fixes.
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 20 && nationById(ctx.player.nationalityId).fifaRep <= 1,
    [{ key: "carry_nation", text: "扛着整个国家——让世界看到我们" }, { key: "just_play", text: "我只是踢球——国家不需要我扛" }], "rare"),

  // P-A146: the glass genius — the Dembélé dimension. €105m at 20. Hamstring
  // surgery in Finland, twice. Couldn't stay healthy. Then Ballon d'Or.
  makeEventDef("glass_genius", "玻璃天才", (n) => `你${n.ageCn}岁。${n.club}。一笔破纪录的转会费。你接过了一个传奇留下的${n.squadNumber}号。\n你的第一场首发——腿筋断了。四个月。回来——又断了。你的腿筋做了两次手术——同一个国家，同一个医生。你一年只能踢20场。\n你是${n.club}罚单最多的球员。你迟到了。你不吃对东西。你的天赋是真的——你一场过五个人像喝水。但你一场踢不了90分钟。\n然后你当了父亲。你结婚了。生涯最好的一个赛季，${n.club}什么都在争。也许玻璃不是碎了——是在正确的时刻被粘好了。也许天赋需要的不只是一双好腿——需要一个让你安定的理由。`, 5,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 24 && (ctx.player.position === "LW" || ctx.player.position === "RW" || ctx.player.position === "ST"),
    [{ key: "find_stability", text: "找到安定——天赋需要一个理由" }, { key: "accept_fragility", text: "接受——也许我的身体就是这样" }], "rare"),

  // P-A147: the favela redemption — the Raphinha dimension. Rejected by every
  // club in Porto Alegre. Told to find another team. Then became the best.
  makeEventDef("favela_redemption", "穷孩子的逆袭", (n) => `你在${n.nation}最穷的那片棚户区长大。你和父母弟弟宠物住一间卧室。你在枪声和泥地里踢球。\n家乡的球队拒绝了你。省里最大的那家也拒绝了你。你老家的每一个大俱乐部都不要你。\n你从最小的俱乐部一路爬——一年换一个国家，一年换一个联赛。${n.club}来了。但你的体育总监说「去找另一个俱乐部吧」。一家石油俱乐部开出了让所有人闭嘴的价码。\n你没有走。你的新教练让你当了队长。你进了帽子戏法——对${n.bigClub}。你在客场进了德比的球。你追平了一项${n.continentalClubCup}的纪录。\n也许被拒绝不是终点——是起点。也许每一个「不要你」都是一颗种子。也许穷孩子不需要被接受——需要的是一个证明他们错了的理由。`, 5,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 26 && (ctx.player.position === "LW" || ctx.player.position === "RW" || ctx.player.position === "CAM" || ctx.player.position === "ST"),
    [{ key: "prove_them_wrong", text: "证明——每一个不要我的人都错了" }, { key: "take_money", text: "拿那笔天价——够了" }], "rare"),

  // P-A148: the firecracker — the Gavi dimension. 17 and compared to Xavi. ACL
  // at 19. 348 days out. Came back to the armband. "Oliver Atom" — boundless energy.
  makeEventDef("firecracker", "火药桶", (n) => `你刚进一线队就敢跟队里最好的中场对着干。你的火比你的技术更让人记住——你在德比里和对方的头牌对峙，你不会退。\n你${n.ageCn}岁。ACL。半月板。348天。你错过了${n.continentalCup}、奥运会、一个完整赛季。\n你回来的时候队长把袖标交给了你——一个青训营出来的孩子，把袖标传给另一个青训营出来的孩子。你戴上了它。\n然后你的膝盖又坏了。两次大伤，而你才${n.ageCn}岁。但你的火没有灭——他们说你的能量没有尽头。\n也许火药桶不是最耐用的——但它在爆炸的时候最亮。也许你的膝盖不是铁做的——但你的心是。`, 5,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 19 && ctx.age <= 24 && (ctx.player.position === "CM" || ctx.player.position === "CAM" || ctx.player.position === "CDM"),
    [{ key: "come_back_burning", text: "回来——更亮地烧" }, { key: "dial_back", text: "也许该收敛一点——膝盖更重要" }], "rare"),

  // P-A113: the godfather — the Conte dimension. A coach who demands
  // everything. "His words assault you. They crash through the doors of your mind."
  makeEventDef("the_godfather", "教父", "新教练上任第一天。他走进更衣室的时候像一条蛇——你的队友Pirlo说的。\n他没有打招呼。他看着你们所有人说：「我不在这里混日子。停止做个废物。」你说不出话——不是因为害怕，是因为他的话像锤子一样砸进你的脑子里。你以前听过教练训话。但没有人的话像他这样——不是激励，是命令。\n他说「如果你不愿意为这支球队死在球场上，你可以走。」没有人走。你不知道你留是因为想赢还是因为他让你不敢走。也许两者都是。", 15,
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 24 && ctx.role === "starter",
    [{ key: "die_on_pitch", text: "为他死在球场上——他的话砸进了我的脑子" }, { key: "push_back", text: "我不会为任何人死——我为自己踢" }]),

  // P-A114: the fallen prodigy — the Jović dimension. €60 million at 21.
  // Three goals in three years. Cut from a Champions League squad. Then Greece.
  makeEventDef("fallen_prodigy", "陨落的天才", (n) => `几年前，${n.club}花了破纪录的一笔钱把你买来。\n上一个赛季你进了17个联赛进球和10个欧战进球。你在一场比赛中进了五个球——那个联赛历史最年轻的五子登科。全世界都在说你是下一个大神。\n现在你在${n.club}的更衣室里坐着。两年了。三个联赛进球。你的膝盖伤过两次，你的信心伤过无数次。你被踢出了${n.continentalClubCup}大名单——一个曾经标价破纪录的球员被踢出了${n.continentalClubCup}大名单。\n你看着镜子里的自己——那个在${n.formerClubOr}一场进五个的你在哪里？`, 10,
    (ctx) => ctx.player.overall >= 74 && ctx.age >= 24 && ctx.player.position === "ST" && (ctx.role === "substitute" || ctx.role === "low_rotation"),
    [{ key: "go_small", text: "去一个小联赛——重新开始" }, { key: "stay_fight", text: "留下来——我不会这样结束" }], "rare"),

  // P-A115: the restless prince — the Boateng dimension. 12 clubs. Never
  // settled. Always moving on. The talent that couldn't find a home.
  makeEventDef("restless_prince", "流浪王子", "你打开衣柜——里面是12件不同的球衣。\n你不是不够好——你的天赋从来不是问题。但你在每一个地方都待不长。你和教练吵，和队友吵，和足协吵。你在世界杯被遣送回家。你的合同不是被卖——是被终止的。\n你想起你的弟弟——他赢了世界杯，安安稳稳待在一家俱乐部。你们是同一个父亲的孩子。但你选择了流浪，他选择了扎根。你们不再说话了。\n你坐在又一家新俱乐部的更衣室里。这是第12家了。你的衣柜里又多了一件球衣。你不知道你会在这里待多久——反正不会久。", 15,
    (ctx) => ctx.player.overall >= 75 && ctx.age >= 28,
    [{ key: "keep_moving", text: "继续走——也许下一站才是家" }, { key: "stop_running", text: "也许该停了——12件球衣够了" }]),

  // P-A116: the matador — the Cavani dimension. "A striker who covers the
  // entire pitch." Not just goals — relentless movement. The matador who never stopped running.
  makeEventDef("the_matador", "斗牛士", (n) => `你进了${n.careerOutput}个${n.outputLabel}——在${n.club}的队史榜上一路往前挪。但你最被记住的不是进球。\n你被记住的是跑动。你在九十分钟里跑动比某些中场还多。你的队友说「他从第一分钟跑到最后一分钟」。教练说「他覆盖了整个球场」。前锋不应该跑这么多——但你不是「应该」的前锋。你是「就是会」的前锋。\n你庆祝进球的时候假装开机关枪——像你小时候的偶像。他们叫你「斗牛士」——因为你面对球门的冷静像斗牛士面对公牛。但你知道你不是冷静——你是在跑完一万五千米之后还能冷静。那才是真正的天赋。`, 15,
    (ctx) => ctx.player.position === "ST" && ctx.player.overall >= 78 && ctx.age >= 30 && ctx.role === "starter",
    [{ key: "keep_running", text: "继续跑——跑到不能跑为止" }, { key: "save_legs", text: "也许该少跑一点——多用脑子" }], "rare"),

  // P-A117: the ironic goal — the Coutinho dimension. Loaned out by Barcelona,
  // then scores two against Barcelona in an 8-2 humiliation. Football's cruelest irony.
  makeEventDef("ironic_goal", "讽刺的进球", (n) => `你被${n.formerClubOr}外借了——天价买来的你，被借走了。\n你在${n.club}踢得不错——但谁会在乎？你只是被借走的。你的旧主在等你回来，但你知道他们不想你回来。\n然后${n.continentalClubCup}淘汰赛来了——${n.club}对阵${n.formerClubOr}。你坐在替补席上看着你的队友在上半场就进了四个球。你被换上了场。\n你助攻了第六个。然后你进了第七个。然后你进了第八个。8-2。你对着你的旧主进了两个球。你没有庆祝——你只是站在那里。你不知道你在笑还是在哭。也许两者都是。`, 5,
    // Whole premise is the club that sold you, so require one to actually exist.
    (ctx) => ctx.player.overall >= 78 && ctx.age >= 26 && (ctx.role === "substitute" || ctx.role === "high_rotation")
      && (ctx.formerClubIds ?? []).some((id) => id !== ctx.club.id),
    [{ key: "score_and_silence", text: "进球——不庆祝——让球说话" }, { key: "celebrate", text: "进球就庆祝——我欠谁沉默" }], "legendary"),

  // P-A118: the burden of a penalty — the Southgate dimension. One miss, 25 years
  // of weight. Then redemption. The man who carried a nation's heartbreak and came back to lead it.
  makeEventDef("penalty_burden", "点球的重量", (n) => `你罚失了点球。半决赛。主场。全${n.nation}看着你。\n那之后你出现在了一个披萨广告里——和另外两个罚失过点球的人一起。你们笑着说这件事。但你知道那个笑不是真的——它是一个面具。面具下面是一个一辈子不会愈合的伤口。\n你退役了。你当了教练。你当了${n.nation}的主教练。你带着你的国家进了世界杯半决赛。球迷唱你的名字。你的马甲成了国民现象。但每次有人在赛前提到「点球」两个字，你的胃会紧一下。这么多年了。那个球还在你的脑子里。它从来没有离开过。`, 3,
    (ctx) => ctx.player.overall >= 73 && ctx.age >= 28,
    [{ key: "carry_and_lead", text: "带着那个球走——它让我成为更好的教练" }, { key: "step_away", text: "远离点球与聚光灯，让这事过去" }], "legendary"),

  // P-A119: the boy king — the Mbappé dimension. World Cup at 19. Hat-trick in
  // a final at 23. Carrying a nation before he could legally rent a car.
  makeEventDef("boy_king", "少年王", (n) => `你还是个少年时就赢了世界杯。你在决赛进了球。你是这项运动史上第二个在世界杯决赛进球的少年。\n但赢了世界杯之后你做了什么？你把奖金全捐了。你说「我赚得够多了。重要的是帮助需要帮助的人。」你${n.ageCn}岁成了${n.nation}的队长。你在上一届世界杯决赛进了三个球——帽子戏法——但你输了点球大战。你说那是「失败」。\n你从${n.nation}一个工人区来。你的父亲是教练，母亲是手球运动员。你从小就知道你会走到这里——但知道和走到不是同一件事。你走到了。你少年时捧起了世界杯。你${n.ageCn}岁带着袖标。你不知道你还能走多远——但你知道你还年轻。也许这才是最可怕的：你还没到巅峰。`, 3,
    (ctx) => ctx.player.overall >= 85 && ctx.age >= 19 && ctx.age <= 25,
    [{ key: "keep_rising", text: "继续上升——我还没到巅峰" }, { key: "give_back_now", text: "先回馈——我赚得够多了" }], "legendary"),

  // ── Rare events (low weight, high variance outcomes) ──
  makeEventDef("mystery_benefactor", "神秘金主", "一个戴着墨镜的陌生人出现在训练场外，递给你一张名片和一个装满现金的信封。\n「有人很看好你的未来。这笔钱用来改善你的训练条件。不收利息，不问出处——只要你在合同到期后做你想做的事。」\n他转身走了，没留下名字。你捏着信封，感觉它在发烫。", 8,
    (ctx) => ascensionCanTrain(ctx.ascension) && ctx.player.overall >= 70,
    [{ key: "accept", text: "收下信封，天降横财" }, { key: "reject", text: "物归原主，不沾来路不明的钱" }], "rare"),
  makeEventDef("prodigy_sibling", "天才弟弟", (n) => `你弟弟踢球的样子像极了${n.startAgeCn}岁的你——同样的动作，同样的眼神，同样在贫民窟的泥地里光脚踢球。\n他现在十五岁，有球探在追他。母亲打电话给你：「带他走吧，他在这里会废掉。但你得想清楚——带他入行，他可能会超过你。」\n电话那头弟弟在练球的声音隐隐传来。`, 4,
    (ctx) => ctx.age >= 24 && ctx.age <= 33,
    [{ key: "sponsor", text: "全力扶持弟弟入行" }, { key: "distance", text: "保持距离，各自走自己的路" }], "rare"),
  makeEventDef("weather_odyssey", "跨国奇遇", "一封来自异国的邀请函躺在桌上，附带着一张机票和一张你从没见过的球场照片。\n「短期加盟，体验一种完全不同的足球。你会去到世界另一端，说着陌生的语言，吃着陌生的食物。你会变得不同。」\n你的队友说他认识一个去了的球员——回来之后判若两人。", 25,
    (ctx) => isPrime(ctx) && ctx.player.overall >= 75,
    [{ key: "accept", text: "买上机票，去世界的另一端看看" }, { key: "stay", text: "留在舒适区，未知太冒险" }], "rare"),

  // The loneliest moment — La Masia-style homesickness at the academy.
  makeEventDef("academy_homesick", "想家", "你躺在青训营的宿舍床上，盯着天花板。\n家里打来电话的时候你没有接——你不知道该说什么。你十二岁离开了家，身边没有人说你的方言，食堂的饭不是妈妈做的味道。队友在隔壁房间笑，你在这里哭。\n你想起你为什么来这里——但此刻你想不起足球了。", 15,
    (ctx) => isYouth(ctx) && ctx.player.overall >= 55 && clusterFired(ctx, YOUTH_RESTRICTED) < YOUTH_BUDGET,
    [{ key: "push_through", text: "擦干眼泪，明天继续训练" }, { key: "call_home", text: "给家里打电话，哭着说想回家" }]),

  // ── P-A21: media/dark-side events — the Gascoigne dimension ──

  // The moment fame consumes you — tabloids, parties, the spiral.
  makeEventDef("tabloid_spiral", "纸醉金迷", (n) => `你上了八卦头条——不是因为你进了球，是因为你凌晨四点从夜店出来被人拍了照。\n「你是球员，不是明星。」主帅把报纸摔在你面前。「但你的赞助商喜欢你上头条——只要不是负面。」你的手机里全是经纪人发来的派对邀约，每场都有名人等着认识你。\n你想起${n.startAgeCn}岁刚进来时的自己——那时候你想的不是这些。`, 18,
    (ctx) => ctx.player.overall >= 80 && ctx.age >= 24,
    [{ key: "embrace_fame", text: "享受名气，夜生活和足球可以兼得" }, { key: "step_back", text: "远离聚光灯，足球才是根本" }], "rare"),

  // The reckless challenge — like Gascoigne's 1991 FA Cup final foul.
  makeEventDef("reckless_challenge", "鲁莽飞铲", "比赛第三分钟，对方前锋过了你。你从背后铲了过去——不是因为战术需要，是因为你的自尊心不允许被他过掉。\n你听到裁判的哨声之前，先听到了骨头的声音。你不知道那是他的还是你的。全场安静了一秒。\n你躺在草地上，看着对方球员也在地上。你们对视了一眼。", 8,
    (ctx) => ctx.role === "starter" && ctx.age >= 20,
    [{ key: "own_it", text: "坦然接受红牌和代价" }, { key: "dive", text: "装作无辜，试图逃过处罚" }], "rare"),

  // The fan idolatropy — when fans worship you, and the weight of it.
  makeEventDef("fan_idolatry", "全民偶像", "一个小球迷举着你的球衣等在训练场外。他看到你的时候眼睛亮了——那种亮你只在镜子里见过。\n「你是我的英雄。」他说。他的父亲在后面微笑着。\n你接过他的球衣签了名。但你看着他跑开时的背影，突然意识到——他相信你不会犯错。而你只是一个也会害怕、也会犯错、也会在凌晨失眠的普通人。那个球衣的重量比你想象的重。", 70,
    (ctx) => ctx.player.overall >= 85 && ctx.age >= 24,
    [{ key: "embrace", text: "接受偶像身份，努力配得上" }, { key: "step_down", text: "拒绝神化，我只是个球员" }]),

  // P-A23: deadline day drama — the window's final hours, the agent's call.
  makeEventDef("deadline_day_drama", "转会截止日", "距离转会窗关闭还有六小时。你的经纪人打来电话，声音很急。\n「三家俱乐部在抢你。一家是豪门，给你主力但竞争激烈；一家是中游队，保证核心地位；还有一家是你母国的老东家，钱不多但那是家。窗关了就没了——你必须现在决定。」\n电话那头是三家俱乐部的合同在等。", 20,
    (ctx) => isPrime(ctx) && ctx.role === "starter" && ctx.player.overall >= 78,
    [{ key: "gamble_big", text: "赌豪门，哪怕坐板凳" }, { key: "secure_role", text: "去中游队，要的是上场时间" }, { key: "go_home", text: "回母国老东家，家的方向" }], "rare"),

  // P-A23: the club sells you against your will — the player as commodity.
  makeEventDef("forced_sale", "强行出售", "你是在新闻发布会上知道自己被卖了的。\n「俱乐部已接受报价。」主席看着镜头说的，不是看着你。你甚至不知道谈判在进行——他们瞒着你，因为知道你会拒绝。\n现在你的更衣柜被清空了，新俱乐部的球衣已经印好了你的名字。你没有选择——你是商品，商品不挑货架。", 45,
    (ctx) => ctx.player.overall >= 80 && ctx.club.rep >= 5,
    [{ key: "accept_fate", text: "接受现实，去新俱乐部证明他们错了" }, { key: "refuse", text: "拒绝报到，公开对抗俱乐部" }]),

  // ── Legendary events (very rare, run-defining) ──
  makeEventDef("wonder_strike_moment", "惊世远射", "比赛第八十七分钟，你在中圈拿球。没人防你——因为你离球门四十米。\n你抬头看了一眼门将的位置，他站在门线上，松懈地等着你传球。看台上有人开始离场。\n你右脚踩住球，左脚后摆。一个声音在脑子里说：试一下。", 8,
    (ctx) => ctx.role === "starter" && ctx.player.overall >= 80,
    [{ key: "attempt", text: "起脚——四十米，试一脚不可能" }, { key: "lay_off", text: "传给位置更好的队友" }], "legendary"),
  makeEventDef("rags_to_riches", "草根逆袭", "全村人凑钱给你买了第一双球鞋的时候，你七岁。\n现在你站在职业球场上，全村人凑在村委会的唯一一台电视机前看你踢球。你的每一步都是全村人的希望，每一个球都是你背在身上的整个村庄。\n赛前你摸了摸球衣——里面缝着村里老人们求来的平安符。", 100,
    (ctx) => ctx.age <= 22 && ctx.club.rep <= 2,
    [{ key: "embrace", text: "扛起全村的希望，活成那个传奇" }, { key: "let_go", text: "把全村的重量放下——我只为自己踢球" }], "legendary"),

  // ── trait-flag branch chains: events that only fire AFTER a prior tag ──
  // "rival_offer:accept" tags "rival_betrayal"; this is the fan-revenge follow-up.
  makeEventDef("rival_fan_revenge", "旧主球迷的报复", "你转投死敌的消息传出后，旧主球迷烧了你的球衣。你的名字在球迷论坛上变成了「犹大」。\n今天的客场是你旧主的主场。球迷通道外，有人在等你。你听见嘘声从四面八方传来，有东西砸在球员通道顶上。\n你深吸一口气，准备走出去。", 100,
    (ctx) => hasTag(ctx, "rival_betrayal"),
    [{ key: "face_them", text: "坦然走出去，顶住整座球场的嘘声" }, { key: "lay_low", text: "低调躲避，放弃这场出场" }]),
  // "mysterious_substance:consume" success tags "doped"; the doctor follow-up.
  makeEventDef("doping_whistleblower", "内部告密", "一个跟你关系不好的队友找到了你，手机里录着你跟队医的对话。\n「我要举报你。」他面无表情，「除非你付我一笔钱。」\n你想起那天喝下补剂时的痛快——现在那瓶东西变成了悬在头顶的刀。", 100,
    (ctx) => hasTag(ctx, "doped"),
    [{ key: "pay_off", text: "花钱封口，把把柄买回来" }, { key: "come_clean", text: "主动坦白，认罪认罚" }]),
  // "captaincy_offer:accept" tags "captain"; leadership pays off later.
  makeEventDef("captain_rally", "队长凝聚", "更衣室里没人说话。三连败，主帅快被解雇了，下一场再输就是深渊。\n你是队长。袖标在你臂上沉得像铁。你站起来，看着一个个低着头的队友——他们中间有人比你年轻十岁，有人下个月就要转会。\n你开口了。", 100,
    (ctx) => hasTag(ctx, "captain") && ctx.role === "starter",
    [{ key: "rally", text: "振臂一呼，把球队从深渊里拉出来" }, { key: "lead_by_example", text: "说不出话，用场上的跑动领着他们" }]),
  // P-A16: butterfly-effect delayed consequence — the nagging injury planted
  // by "play_injured" flaps its wings seasons later as a relapse. The player
  // chose short-term glory; the bill comes due.
  makeEventDef("injury_relapse", "旧伤复发", "训练中你做了无数次的一个动作——转身射门。但这一次膝盖传来一声脆响。\n你倒在地上的时候，想起那场带伤上的决赛。你赢了那场比赛，所有人都欢呼。现在那声欢呼变成了膝盖里的声音。\n队医跑过来的时候，你已经知道答案了。", 100,
    (ctx) => hasTag(ctx, "nagging_injury"),
    [{ key: "push_through", text: "再打一针封闭，硬扛到底" }, { key: "surgery", text: "接受手术，从零开始" }]),

  // P-A153: the sweeper keeper — the Neuer dimension. Revolutionized the
  // position, played as a libero, broke his leg twice and came back.
  makeEventDef("sweeper_keeper", "清道夫门神", (n) => `教练说「门将不该出门禁区。」你没有听。\n你跑出去——到大禁区线外，到中场。你是第11个 outfield 球员。你说「如果我待在门线上，我的后卫就少了一个人。」你改变了门将这个位置——从此门将不再只是挡球的，是参与比赛的。\n你两次断了腿。你回来。你${n.ageCn}岁了还在扑。他们问你什么时候停——你说「当我不怕了就停。」但你一直怕——所以你一直扑。\n也许改变一个位置不需要别人的允许——需要的是第一个敢的人。也许门将可以出门禁区——如果他的胆子比禁区大。`, 4,
    (ctx) => ctx.player.position === "GK" && ctx.player.overall >= 76 && ctx.age >= 26 && ctx.role === "starter",
    [{ key: "leave_the_line", text: "冲出门禁区——改变这个位置" }, { key: "stay_classical", text: "守在门线——做传统的门神" }], "rare"),

  // P-A154: the warrior — the Puyol dimension. The 2010 World Cup header,
  // the bandaged head, "Titus", leadership by throwing his body at everything.
  makeEventDef("the_warrior", "战士", "你的额头上缝了七针。你在2010世界杯半决赛用那个额头把球砸进了球门——你跪在角旗旁，你吻了草皮。\n你不高——1米78。但你的弹跳像有弹簧。你把身体扔向每一个球——你的膝盖、你的脸、你的肋骨都为此付过代价。你的队友说「有他在，我们敢往前压——因为我们知道后面有一个会为每一个球拼命的人。」\n你是队长。你不说漂亮话——你在更衣室里用眼睛看每一个人，他们就知道该跑了。也许领袖不是声音最大的——是第一个把身体扔出去的。也许战士不需要赢——需要的是让所有人看见他敢。", 4,
    (ctx) => (ctx.player.position === "CB" || ctx.player.position === "LB" || ctx.player.position === "RB") && ctx.player.overall >= 75 && ctx.age >= 28 && ctx.role === "starter",
    [{ key: "throw_body", text: "把身体扔出去——做第一个敢的" }, { key: "stay_calm", text: "用脑子不用身体——聪明的领袖" }], "rare"),

  // P-A155: the hand of god — the Maradona dimension. 1986, the goal of the
  // century and the hand of god, Argentina's god, the descent.
  makeEventDef("hand_of_god", "上帝之手", (n) => `世界杯淘汰赛。对手是${n.worldRivalNation}。\n第一个球——你用手打进去的。你没抬头，你没看裁判。你说「是上帝的手——上帝的手。」\n第二个球——你从中场开始带球，过了五个人，你把他们全过了。他们叫它「世纪之球」。\n你是一个国家的神——${n.nation}的足球刚刚被伤透了心，他们需要一个能让他们重新相信的人。你做到了。但你也是凡人——你上瘾，你失控，你的身体背叛了你。神和凡人住在同一个身体里——这是你的诅咒，也是你的伟大。\n也许上帝之手不是作弊——是一个小个子对大世界唯一的回答。也许世纪之球不是天赋——是愤怒。`, 2,
    (ctx) => ctx.player.overall >= 85 && (ctx.player.position === "CAM" || ctx.player.position === "ST" || ctx.player.position === "LW" || ctx.player.position === "RW" || ctx.player.position === "CM") && ctx.age >= 24,
    [{ key: "be_the_god", text: "做国家的神——他们需要一个" }, { key: "stay_human", text: "我只是一个人——神会毁了我" }], "legendary"),

  // P-A156: the total footballer — the Cruyff dimension. The turn, the 14,
  // total football, the philosopher who changed how the game is played.
  makeEventDef("total_footballer", "全攻全守", (n) => `你穿${n.squadNumber}号——没有人在世界杯穿这个号。你说「为什么不能？」\n你发明了一个转身——后来所有人都学它。你不踢固定的位置——你从前场跑到后场，后卫也能进球。你说「球员不该有位置——该有任务。」你改变了足球——从那时候起，足球不再是11个固定的人，是11个流动的任务。\n你拿遍了那个年代的个人奖。但你说你最大的骄傲不是奖杯——「我改变了足球被踢的方式。」也许天才不是进最多的球——是让所有人重新想球该怎么踢。也许${n.squadNumber}号不是号码——是一个问题：为什么不能？`, 3,
    (ctx) => ctx.player.overall >= 85 && (ctx.player.position === "CAM" || ctx.player.position === "CM" || ctx.player.position === "ST" || ctx.player.position === "LW" || ctx.player.position === "RW") && ctx.age >= 23 && ctx.role === "starter",
    [{ key: "invent_the_game", text: "改变足球——让所有人重新想" }, { key: "win_within_rules", text: "在规则内赢——不要冒险" }], "legendary"),

  // P-A157: the king — the Pelé dimension. 17 at the World Cup, three World
  // Cups, 1000+ goals, from poverty to the most famous athlete on earth.
  makeEventDef("the_king", "球王", (n) => `你还是个少年。世界杯半决赛你进了帽子戏法。决赛你进了两球——你哭着被队友抬下球场。你是世界上最年轻的世界杯冠军。\n你从贫困里来——${n.nation}最穷的那条街，光脚踢球，把报纸塞进袜子当球。你把世界杯捧了一次又一次——没有任何人比你捧得更多。你进的球多到没人数得清。你成了也许是世界上最有名的运动员。\n你说「我是一个想用足球让世界看见穷孩子的人。」也许球王不是进最多球的人——是让全世界看见光脚的孩子也能成为王的人。也许一千个球不重要——重要的是有一个孩子看见你之后相信了。`, 3,
    (ctx) => ctx.player.overall >= 85 && (ctx.player.position === "ST" || ctx.player.position === "CAM" || ctx.player.position === "LW" || ctx.player.position === "RW") && ctx.age >= 18 && ctx.age <= 24,
    [{ key: "carry_the_world", text: "让世界看见穷孩子也能成王" }, { key: "just_play", text: "只是踢球——不需要背负更多" }], "legendary"),

  // P-A158: the invincible — the Henry dimension. Arsenal's record scorer,
  // the invincibles season, "he tried to walk it in", the trophy that eluded.
  makeEventDef("the_invincible", "不败之王", (n) => `你是那个赛季的一部分——38场，一场没输。${n.league}历史只有一次。你是他们的队长、他们的进球、他们的速度。\n你的球迷唱「他总是想把它走进球门。」你笑了——因为这是真的。你说「足球应该是美的——进球不只是结果，是方式。」你赢得了世界杯、${n.continentalCup}、${n.continentalClubCup}。但有一个奖杯你总差一点——你两次在决赛里输。\n也许不败不是一个赛季——是一种信仰：足球应该是美的。也许走进球门比射进去慢——但它更美。也许你输的那两场决赛不定义你——你定义的是足球该是什么样子。`, 4,
    (ctx) => ctx.player.overall >= 85 && (ctx.player.position === "ST" || ctx.player.position === "LW" || ctx.player.position === "RW" || ctx.player.position === "CAM") && ctx.age >= 24 && ctx.role === "starter",
    [{ key: "beautiful_or_nothing", text: "美就是一切——走进球门比射更美" }, { key: "win_ugly", text: "赢比美重要——该射就射" }], "rare"),

  // P-A159: the non-flying Dutchman — the Bergkamp dimension. Fear of flying,
  // the turn against Newcastle, artistry that didn't need to travel far.
  makeEventDef("non_flying_dutchman", "不坐飞机的人", (n) => `你怕坐飞机。你的教练问你「去客场的比赛怎么办？」你说「我开车。或者坐火车。或者不去。」\n你因此错过了一些客场。但你在主场做的事——他们记了一辈子。你对${n.derbyClub}那个转身——球从左边来，你用一脚把球绕过后卫，绕过门将，它是足球史上最美的进球之一。\n你不快——你说「我不需要快。我需要的是看到别人看不到的。」你在${n.club}踢了${n.seasonsAtClubCn}年，你没有飞，但你改变了${n.league}对「美」的定义。也许限制不是弱点——如果你在限制里创造了别人在自由里创造不出的东西。也许不坐飞机的人飞得最高——用脚。`, 5,
    (ctx) => ctx.player.overall >= 80 && (ctx.player.position === "ST" || ctx.player.position === "CAM" || ctx.player.position === "LW" || ctx.player.position === "RW") && ctx.age >= 28,
    [{ key: "the_turn", text: "用脚飞——创造别人创造不出的美" }, { key: "overcome_the_fear", text: "去面对恐惧——也许该坐一次飞机" }], "rare"),

  // P-A160: the galloping major — the Puskás dimension. Hungary's golden
  // team, the galloping major, 4 European Cup finals, scoring in his 30s.
  makeEventDef("galloping_major", "飞奔的少校", (n) => `你是${n.nation}国家队的队长。他们叫你「飞奔的少校」——因为你也是军队的少校。\n你的国家队在四年里没输过一场——直到世界杯决赛。你那天有伤，你带伤上场，你输了。他们说「如果我没伤……」但「如果」不是足球。\n你${n.ageCn}岁离开${n.nation}——战争来了。你胖了，没人要你。${n.bigClub}要了你。你和那里的头牌一起把${n.continentalClubCup}捧了又捧。你在${n.continentalClubCup}的决赛进了四个球——${n.ageCn}岁。也许少校不是没输过——是输了之后还能重新开始。也许伟大的球员不需要不输——需要的是输完了还能在这个岁数进四个。`, 4,
    (ctx) => ctx.player.overall >= 80 && ctx.player.position === "ST" && ctx.age >= 30 && ctx.role === "starter",
    [{ key: "restart_at_thirty", text: "三十岁重新开始——在决赛进四个" }, { key: "rest_on_legacy", text: "荣誉够了——该停下了" }], "rare"),

  // ─────────────────── P-RISE+ 上升期回报簇 (upside-only) ───────────────────
  //
  // 玩家反馈「一到上升期就负面buff」的第二半：把池事件按「最坏分支的 OVR 后果」
  // 归档,上升期样本 ctx(24岁/OVR78/主力)的 50 个够格事件里 41 个是赌局档
  // (有正分支也有扣分分支),只有 7 个是救命档(最坏分支也不扣)。问题不是事件
  // 太负面——是**没有一张牌是纯粹的好事**。每次抽牌都在准备挨打,赢了也只是
  // 没输。门宽补偿后各事件出现率趋一致,所以配比由「条数」而非 weight 决定:
  // 补 8 个纯回报事件把救命档从 7/50(14%)拉到 15/58(26%)。
  //
  // 设计守则:两个选项都净正向,但**付的是不同的货币**(能力/身份/奖杯概率/传承)
  // ——没有错误答案,但仍是真选择(game-design-core: trade-offs, not puzzles)。
  // 都是确定性分支(不掷骰),所以不进 EVENT_ODDS 表;previewLabel 自动生成药丸。
  // 文案守则见 research/game-copy-standards.md B 组:只写看得见的、评价交给
  // 具名的人说出口、不替玩家总结意义、结果 ≤120 字。
  makeEventDef("stand_song", "看台的歌", "主场第六十分钟，北看台唱起一首没听过的歌。调子是从一首老球迷歌改的，歌词里反复出现你的名字。\n队长在场上笑着朝看台抬了抬下巴：「他们给你写歌了。」\n终场哨响了五分钟，那首歌还在唱。", 30,
    (ctx) => ctx.player.overall >= 75 && ctx.role === "starter" && ctx.age <= 28,
    [{ key: "salute", text: "走到看台下，鼓掌回应他们" }, { key: "bring_team", text: "把全队拉过去一起谢场" }]),

  makeEventDef("coach_backing", "主帅背书", "赛前发布会，记者问下赛季的引援计划。主帅把话筒拉近了一点。\n「我们不会再买这个位置的球员。」他说，「我们围绕他建队。」\n第二天早训，有队友在更衣室拍了拍你的后背，也有人没有抬头。", 30,
    (ctx) => ctx.player.overall >= 76 && ctx.role === "starter" && ctx.age <= 28,
    [{ key: "accept_core", text: "接下核心的位置" }, { key: "share_credit", text: "把功劳分给中场那几个" }]),

  makeEventDef("academy_kids", "青训营的号码", "青训教练发来一张照片：U15 更衣室的挂钩上七件球衣，七件背后印的都是你的号码。\n「他们抽签决定谁能穿。」他在照片下面补了一句，「抽输的那个哭了半小时。」", 30,
    (ctx) => ctx.player.overall >= 75 && ctx.age <= 28 && ctx.club.rep >= 4,
    [{ key: "go_train", text: "每周去青训营带一次训" }, { key: "focus_season", text: "把这个赛季踢好，就是最好的示范" }]),

  makeEventDef("signature_goal", "代表作", "你在中线接球，抬头看了一眼，然后开始跑。四十米，三个人，没有一个人碰到球。\n起脚，皮球擦着横梁下沿入网。解说员喊到破音。\n转播镜头切到客队教练席——对方主帅站着，在鼓掌。", 30,
    (ctx) => ctx.player.overall >= 76 && ctx.role === "starter" && ctx.age <= 28 && ctx.player.position !== "GK",
    [{ key: "credit_team", text: "回头指了指做球的队友" }, { key: "own_it", text: "跑到角旗区，对着镜头指自己的名字" }]),

  makeEventDef("nt_shirt_locked", "国家队的位置", "国家队集训第一天，主帅把战术板转过来。首发十一个位置的名字栏都是空的，只有一个填好了——你的名字。\n「其他人竞争。」他把笔盖扣上，「你不用。」", 25,
    (ctx) => ctx.player.overall >= 78 && ctx.role === "starter" && ctx.age <= 28,
    [{ key: "take_it", text: "接下这个位置" }, { key: "earn_it", text: "把名字擦掉——我和他们一起争" }]),

  makeEventDef("veteran_handover", "靠窗的柜子", "更衣室最里面靠窗的那个柜子空了。在这支球队踢了十二年的老将今天办完了退役手续。\n他把柜门上的名牌摘下来，递到你手里：「这个位置，现在归你。」\n全队站在原地看着。", 25,
    (ctx) => ctx.player.overall >= 76 && ctx.age <= 28 && ctx.club.rep >= 5,
    [{ key: "take_locker", text: "接过名牌，挂上自己的" }, { key: "keep_it_his", text: "把他的名牌钉回门上" }]),

  makeEventDef("unbeaten_run", "跑动榜", "体能教练在更衣室墙上贴了一张跑动图——十二场不败，每一场的跑动榜第一位都是同一个名字。\n他用手指敲了敲那张纸：「这不是天赋。」", 30,
    (ctx) => ctx.player.overall >= 75 && ctx.role === "starter" && ctx.age <= 28,
    [{ key: "keep_grinding", text: "保持加练" }, { key: "pull_team_in", text: "把加练变成全队的" }]),

  makeEventDef("shirt_sales", "球衣销量", "俱乐部商店的经理拿着一张报表走进更衣室：这个赛季卖出去的球衣，六成印着你的名字。\n「上一个做到这个数的人，」他把报表放在你柜子上，「球场外面现在立着他的雕像。」", 25,
    (ctx) => ctx.player.overall >= 77 && ctx.age <= 28,
    [{ key: "donate", text: "分成捐给俱乐部青训" }, { key: "boot_deal", text: "签下球鞋代言，赛季只管踢球" }]),
];

// ───────────────────────────── climax events (boss fights) ─────────────────────────────

/** Boss 选项卡走和普通特殊事件完全相同的构造（buildEvent 的那一套）：每个选项
 *  自带 `sub` 的胜率 % 和 `preview` 的胜/负药丸。以前这三个 boss builder 手搓
 *  choices、只给 sub，OptionCard 又把「纯 %」的 sub 当噪音剔掉（bare 规则），
 *  结果全游戏赌注最大的一战反而一个数字都不显示。 */
function bossChoices(
  key: string, ctxStub: EventContext, blessings: readonly string[],
  options: readonly { id: string; text: string }[],
): Choice[] {
  return options.map((o) => {
    const odds = optionOdds(key, o.id, ctxStub);
    return {
      id: o.id, kind: "event_option" as const, text: o.text,
      sub: odds !== undefined ? pct(odds, blessings) : undefined,
      ...optionPreview(ctxStub, key, o.id, odds),
    };
  });
}

/** Build the World Cup final showdown — the roguelike's capstone boss.
 *  Target: 50/50 coin flip; option is narrative flavor. Success forces the WC. */
export function worldCupShowdown(
  age: number,
  odds: number,
  betterStage: string,
  worseStage: string,
  blessings: readonly string[] = EMPTY_BLESS,
  nationName?: string,
): FiredEvent {
  const ctxStub = { blessings, variantKey: undefined, club: { rep: 0 }, bossOdds: odds } as unknown as EventContext;
  const nt = nationName ?? "你的国家队";
  return {
    event: {
      key: "world_cup_showdown", title: "世界杯决战",
      desc: `${age}岁，世界杯决赛之夜。${nt}杀入决战，全场屏息。胜则${betterStage}，永载史册；败则${worseStage}，功亏一篑。`,
      eventKey: "world_cup_showdown",
      bossOdds: odds,
      worldCupShowdown: { age, better: "champion", worse: "final" },
      choices: bossChoices("world_cup_showdown", ctxStub, blessings, [
        { id: "a", text: "挺身而出，扛起国家" },
        { id: "b", text: "稳中求胜，相信队友" },
      ]),
    },
    resolve: (choice, rng) => {
      const r = resolveEventOption(rng, "world_cup_showdown", choice.id, ctxStub);
      // 冠军/亚军的覆盖已在 resolveEventOption 内就位（预览药丸要看得见）。
      // you PLAYED that final — bypass the call-up threshold so the override
      // isn't silently dropped for a star below his nation's call-up bar.
      // 只在包装层设：它对两个分支都成立，放进 resolve 会抢占预览药丸的首行。
      r.mods.nationalTournamentParticipation = "force";
      // the career's ONE final showdown — consumed win or lose (run.ts gates on this).
      r.mods.addTags = [...(r.mods.addTags ?? []), tag("wc_boss_done", 99)];
      return r;
    },
  };
}

/** World Cup qualifier showdown — 50/50, gates WC qualification. */
export function worldCupQualifierShowdown(
  age: number,
  odds: number,
  boosted: boolean,
  carryTiers: number,
  blessings: readonly string[] = EMPTY_BLESS,
  nationName?: string,
): FiredEvent {
  const ctxStub = { blessings, variantKey: undefined, club: { rep: 0 }, bossOdds: odds } as unknown as EventContext;
  const nt = nationName ?? "国家队";
  return {
    event: {
      key: "world_cup_qualifier_showdown", title: "世界杯预选赛决战",
      desc: `${age}岁，预选赛生死战。${nt}背水一战。${boosted ? `你的表现带来 ${carryTiers} 级加成。` : ""}胜则进军世界杯，败则四年梦碎。`,
      eventKey: "world_cup_qualifier_showdown",
      bossOdds: odds,
      worldCupQualifier: { age, boosted, carryTiers },
      choices: bossChoices("world_cup_qualifier_showdown", ctxStub, blessings, [
        { id: "a", text: "倾尽全力，一战定生死" },
        { id: "b", text: "稳扎稳打，守住希望" },
      ]),
    },
    resolve: (choice, rng) => {
      const r = resolveEventOption(rng, "world_cup_qualifier_showdown", choice.id, ctxStub);
      // 出线与否（nationalTournamentParticipation）已在 resolveEventOption 内就位。
      // once per career (run.ts gates on this tag).
      r.mods.addTags = [...(r.mods.addTags ?? []), tag("wc_quali_done", 99)];
      return r;
    },
  };
}

/** Minnow-nation climax — the continental cup final (亚洲杯/非洲杯/美洲杯/
 *  欧洲杯). For nations that can't realistically reach a World Cup final
 *  (中国/泰国/越南/印尼/玻利维亚/斐济…), the realistic national dream is
 *  the continental cup, not「中国杀入世界杯决赛」. Success forces a
 *  national_continental champion; failure records a runner-up finish. */
const CONT_CUP_NAME: Record<Confederation, string> = {
  UEFA: "欧洲杯", CONMEBOL: "美洲杯", CONCACAF: "中北美金杯", AFC: "亚洲杯", CAF: "非洲杯", OFC: "大洋杯",
};
export function continentalCupShowdown(
  age: number,
  odds: number,
  confederation: Confederation,
  blessings: readonly string[] = EMPTY_BLESS,
  nationName?: string,
): FiredEvent {
  const ctxStub = { blessings, variantKey: undefined, club: { rep: 0 }, bossOdds: odds } as unknown as EventContext;
  const nt = nationName ?? "你的国家队";
  const cupName = CONT_CUP_NAME[confederation] ?? "洲际杯";
  return {
    event: {
      key: "continental_cup_showdown", title: `${cupName}决战`,
      desc: `${age}岁，${cupName}决赛之夜。${nt}杀入决战，全场屏息。胜则${cupName}封王，永载史册；败则功亏一篑，四年梦碎。`,
      eventKey: "continental_cup_showdown",
      bossOdds: odds,
      choices: bossChoices("continental_cup_showdown", ctxStub, blessings, [
        { id: "a", text: "挺身而出，扛起国家" },
        { id: "b", text: "稳中求胜，相信队友" },
      ]),
    },
    resolve: (choice, rng) => {
      const r = resolveEventOption(rng, "continental_cup_showdown", choice.id, ctxStub);
      // 洲际杯冠军/亚军的覆盖（simulateNational 在 isWcAge 分支认
      // worldCupResultOverride === "national_continental"）已在 resolveEventOption 内就位。
      // you PLAYED that final — bypass the call-up threshold so the override
      // isn't silently dropped for a star below his nation's call-up bar.
      r.mods.nationalTournamentParticipation = "force";
      // the career's ONE continental final showdown — consumed win or lose.
      r.mods.addTags = [...(r.mods.addTags ?? []), tag("cont_boss_done", 99)];
      return r;
    },
  };
}

// ───────────────────────────── selection ─────────────────────────────

/** Measurement infrastructure (event-uniformity): weight-override + eligible-
 *  collector hooks so probe tools (tools/ne-measure.ts, validate-compensation.ts)
 *  can re-measure n_E and run counterfactual draws without touching EVENT_DEFS.
 *  Inert in production (null by default); only tools call setPoolProbeHooks. */
export let POOL_WEIGHT_OVERRIDE: Readonly<Record<string, number>> | null = null;
export let POOL_ELIGIBLE_COLLECTOR: ((keys: readonly string[], age: number, storyOnly: boolean) => void) | null = null;
export function setPoolProbeHooks(w: Readonly<Record<string, number>> | null, c: ((keys: readonly string[], age: number, storyOnly: boolean) => void) | null): void {
  POOL_WEIGHT_OVERRIDE = w;
  POOL_ELIGIBLE_COLLECTOR = c;
}

/** 每事件每生涯平均够格期数 n_E（story 通道）——门宽补偿用。
 *  由 tools/ne-measure.ts 跨 8 套配置测得；改门控后须重测并覆盖本表。
 *  rollRandomEvent 用 (legendary?4:10)/(n_E+K) 补偿，使出现率≈1/n_E 抵消门宽差。
 *  injury 的 eligible 恒 false（走伤病系统），不进池，n_E=0 不参与。 */
const EVENT_ELIGIBLE_PERIODS: Readonly<Record<string, number>> = {
  "injury": 0.000,
  "patience_runs_out": 0.024,
  "conquering_arrival": 0.030,
  "the_king": 0.032,
  "fallen_prodigy": 0.038,
  "scout_attention": 0.015,
  "child_prodigy": 0.039,
  "record_fee": 0.043,
  "the_bull_stayed": 0.047,
  "doping_whistleblower": 0.048,
  "firecracker": 0.052,
  "injury_relapse": 0.057,
  "boy_king": 0.062,
  "penalty_redemption": 0.063,
  "captain_save": 0.075,
  "the_warrior": 0.093,
  "rival_fan_revenge": 0.095,
  "galloping_major": 0.098,
  "sweeper_keeper": 0.101,
  "the_matador": 0.111,
  "legend_bond": 0.122,
  "cant_stop": 0.122,
  "foreign_grandfather": 0.128,
  "discarded": 0.129,
  "quiet_exit": 0.154,
  "uncompromising": 0.158,
  "acl_prodigy": 0.168,
  "late_bloomer": 0.177,
  "invisible_engine": 0.196,
  "the_pivot": 0.197,
  "ironic_goal": 0.197,
  "georgian_pioneer": 0.200,
  "captain_rally": 0.211,
  "uncrowned": 0.220,
  "frozen_out": 0.223,
  "reinvention": 0.228,
  "academy_homesick": 0.229,
  "broken_leader": 0.235,
  "defensive_art": 0.246,
  "the_wall": 0.246,
  "finish_high_school": 0.261,
  "academy_rivalry": 0.261,
  "goal_machine": 0.276,
  "overused_prodigy": 0.279,
  "the_invincible": 0.297,
  "the_jewel": 0.309,
  "prodigy_burden": 0.355,
  "puppet_master": 0.369,
  "non_flying_dutchman": 0.371,
  "predator": 0.374,
  "the_bison": 0.390,
  "super_sub": 0.393,
  "charm_striker": 0.394,
  "total_footballer": 0.404,
  "hand_of_god": 0.432,
  "peak_destroyed": 0.434,
  "lost_instinct": 0.436,
  "flickering_star": 0.450,
  "joy_fades": 0.477,
  "legendary_shirt": 0.483,
  "overshadowed": 0.484,
  "underappreciated": 0.500,
  "favela_redemption": 0.530,
  "coach_feud": 0.547,
  "injury_before_tournament": 0.557,
  "mentor_coach": 0.560,
  "second_peak": 0.586,
  "glass_genius": 0.605,
  "fan_idolatry": 0.647,
  "raumdeuter": 0.657,
  "father_agent": 0.666,
  "deadline_day_drama": 0.666,
  "wage_demand": 0.668,
  "breaking_point": 0.673,
  "brand_empire": 0.673,
  "fall_from_grace": 0.674,
  "beyond_football": 0.681,
  "transfer_regret": 0.688,
  "one_club": 0.702,
  "miracle_comeback": 0.764,
  "rock_bottom": 0.781,
  "final_provocation": 0.781,
  "redemption_arc": 0.783,
  "national_god": 0.783,
  "no_longer_fun": 0.786,
  "tunnel_war": 0.790,
  "too_much_passion": 0.790,
  "contract_year": 0.810,
  "rags_to_riches": 0.828,
  "farewell_match": 0.832,
  "quiet_excellence": 0.836,
  "club_priority": 0.840,
  "rival_offer": 0.841,
  "unchanged": 0.844,
  "forced_sale": 0.903,
  "history_kick": 0.904,
  "career_threatening_injury": 0.929,
  "price_tag_pressure": 0.933,
  "fatal_mistake": 0.943,
  "uncontrolled_genius": 0.948,
  "wasted_talent": 0.951,
  "denied_honor": 0.952,
  "controversial_statement": 0.952,
  "wonder_strike_moment": 0.954,
  "weather_odyssey": 0.956,
  "pre_match_calm": 0.962,
  "representation": 0.964,
  "pre_final_collapse": 0.964,
  "the_machine": 1.007,
  "the_godfather": 1.052,
  "beautiful_football": 1.054,
  "giving_back": 1.075,
  "tabloid_spiral": 1.076,
  "conscience_stand": 1.076,
  "dark_impulse": 1.078,
  "panenka": 1.092,
  "dance_through_storm": 1.120,
  "giant_tattoo": 1.128,
  "common_goal": 1.129,
  "two_worlds": 1.130,
  "metabolic_illness": 1.130,
  "last_minute_hero": 1.130,
  "restless_prince": 1.161,
  "tax_trouble": 1.222,
  "transition_prep": 1.235,
  "veteran_mentor": 1.299,
  "cardiac_arrest": 1.345,
  "penalty_burden": 1.347,
  "the_fire": 1.348,
  "super_agent": 1.349,
  "two_brothers": 1.350,
  "fan_confrontation": 1.391,
  "family_strain": 1.428,
  "integrity": 1.428,
  "signature_skill": 1.507,
  "forgotten_test": 1.532,
  "hidden_wounds": 1.532,
  "filial_duty": 1.552,
  "triumphant_return": 1.564,
  "body_decline": 1.570,
  "mysterious_substance": 1.614,
  "war_childhood": 1.660,
  "fitness_failure": 1.669,
  "silent_fall": 1.676,
  "horror_tackle": 1.704,
  "loyalty_test": 1.727,
  "position_change": 1.767,
  "racist_abuse": 1.802,
  "faith_awakening": 1.805,
  "prodigy_sibling": 1.836,
  "captaincy_offer": 1.845,
  "dressing_room_split": 1.959,
  "contract_saga": 1.962,
  "season_load": 1.967,
  "personal_coach": 2.040,
  "new_coach": 2.043,
  "the_scar": 2.151,
  "training_extra": 2.152,
  "fan_backlash": 2.221,
  "unexpected_prospect": 2.480,
  "mystery_benefactor": 2.670,
  "reckless_challenge": 2.750,
  "injury_at_peak": 2.794,
  // P-RISE+ 上升期回报簇 — tools/ne-measure.ts 1500×8 配置 (N=12000) 实测。
  "veteran_handover": 0.520,
  "academy_kids": 0.662,
  "nt_shirt_locked": 0.713,
  "signature_goal": 0.754,
  "shirt_sales": 0.802,
  "coach_backing": 0.824,
  "stand_song": 0.887,
  "unbeaten_run": 0.892,
};

/** 门宽补偿常数：K 越小越激进（窄门事件 boost 越强）。K=0.1 为实测甜点
 *  （CV 1.57→1.22，顶部 58%→~15%，死事件复活，传奇保持偏低）。
 *  详见 rollRandomEvent 与 tools/validate-compensation.ts。 */
const GATE_COMP_K = 0.1;

/** 阶段槽位预算（event-uniformity）：青年/晚年是「稀疏窗口」——够格事件少，
 *  谁够格谁赢那几个槽，导致青年/晚年专属事件各自 ~20-27%。story 通道每生涯
 *  固定弹 ~9 次、总额守恒，加权/收门都治不了（收紧 A 必然让 B 顶上来）。
 *  唯一解：给「阶段专属簇」设每生涯名额上限，逼槽位回流到中段 ~90 个窄门
 *  事件。计数用 ctx.seenEvents（已记录本生涯弹过的池事件 key，P-VAR 同源），
 *  确定性不变。一个生涯仍见到「1 个青训故事 + 2 个晚年故事 + 2 个常遇节奏」，
 *  够丰富，不互抢。 */
const YOUTH_RESTRICTED = new Set(["finish_high_school", "academy_rivalry", "academy_homesick", "scout_attention", "child_prodigy"]);
const TWILIGHT_RESTRICTED = new Set(["body_decline", "transition_prep", "farewell_match", "triumphant_return", "second_peak", "veteran_mentor"]);
/** 常遇节奏簇：n_E>1.5 的宽门事件（季前特训/改打位置/至暗/税务…），资格期多，
 *  靠「资格时长」累加到 17-30%。给它们每生涯 2 个名额，超额槽位回流窄门事件。 */
const WIDE_MID = new Set(["training_extra", "position_change", "rock_bottom", "tax_trouble", "personal_coach", "mysterious_substance", "season_load", "new_coach"]);
const YOUTH_BUDGET = 1;
const TWILIGHT_BUDGET = 1;
const WIDE_MID_BUDGET = 1;
/** 某簇本生涯已弹次数（seenEvents 计数）。 */
function clusterFired(ctx: EventContext, cluster: ReadonlySet<string>): number {
  const seen = ctx.seenEvents;
  if (!seen) return 0;
  let n = 0;
  for (const k of seen) if (cluster.has(k)) n++;
  return n;
}

/** 池事件有效权重 = 分层基线 ÷ (n_E + K)，抵消门宽差使出现率趋一致。
 *  POOL_WEIGHT_OVERRIDE（探针用）优先，便于 counterfactual 测试不改 EVENT_DEFS。
 *  EVENT_BASE_OVERRIDE 对「中段累加型」超 15% 事件降基线（10→6），把超额槽位
 *  回流给中段 ~20 个窄门事件——只在密集中段窗口有效（青年/晚年稀疏窗口降基线
 *  无用，因为它们是唯一够格的，降了照样赢）。 */
const EVENT_BASE_OVERRIDE: Readonly<Record<string, number>> = {
  training_extra: 4, fan_backlash: 6, unexpected_prospect: 6, position_change: 6,
  injury_at_peak: 6, loyalty_test: 6, contract_saga: 6, reckless_challenge: 6,
  dressing_room_split: 6, veteran_mentor: 6, captaincy_offer: 6, prodigy_sibling: 6, prodigy_burden: 6,
};
/** P-RISE+ 上升期回报簇：8 个纯回报事件（最坏分支也不扣 OVR）。
 *  单纯把它们加进池子不够——池里有 176 个事件，+8 只占 4.5% 的抽取份额，实测
 *  每生涯只命中 0.19 次（5 个生涯才有 1 个玩家见到一次）。玩家反馈的是「上升
 *  期没有一张牌是纯粹的好事」，稀有的好事治不了这个体感。
 *  故给这个簇一个**上升期内的抽取加权**（与阶段槽位预算同一套 clusterFired
 *  机制，方向相反：那边设上限防霸场，这边设下限保出场），并用 BUDGET 封顶，
 *  免得回报簇反过来霸占故事通道。窗口外（≥82 OVR 或 >27 岁）不加权——世界级
 *  之后不再托底，与 isRisingPhase 的减伤边界同一条线。 */
const RISE_REWARD = new Set([
  "stand_song", "coach_backing", "academy_kids", "signature_goal",
  "nt_shirt_locked", "veteran_handover", "unbeaten_run", "shirt_sales",
]);
const RISE_REWARD_BUDGET = 2;
const RISE_REWARD_BOOST = 8;

function poolEffectiveWeight(d: EventDef, ctx?: EventContext): number {
  if (POOL_WEIGHT_OVERRIDE) return POOL_WEIGHT_OVERRIDE[d.key] ?? d.weight;
  const n = EVENT_ELIGIBLE_PERIODS[d.key];
  if (n === undefined || n <= 0) return Math.round(d.weight * rarityWeightMult(d.rarity));
  // 传奇基线 4（稀有度=价值标签，天然偏低，符合预期），普通/稀有 10（可被 override 降）。
  const base = EVENT_BASE_OVERRIDE[d.key] ?? (d.rarity === "legendary" ? 4 : 10);
  const w = base / (n + GATE_COMP_K);
  if (ctx && RISE_REWARD.has(d.key) && isRisingPhase(ctx)
      && clusterFired(ctx, RISE_REWARD) < RISE_REWARD_BUDGET) {
    return w * RISE_REWARD_BOOST;
  }
  return w;
}

/** Pick an eligible random event, or null. Draws use GATE-WIDTH COMPENSATION
 *  (poolEffectiveWeight): effective weight = tier base ÷ (n_E + K), so a
 *  wide-gate event (eligible often) and a narrow-gate event (eligible rarely)
 *  surface at ~equal career-appearance rates — counteracting the two hijack
 *  axes (high weight × wide gate; low weight × always-eligible youth window).
 *  Legendary base 4 keeps that tier rarer than common/rare base 10 (rarity is
 *  a value label, naturally lower — by design). The d.weight field is the
 *  legacy designer base; compensation overrides it at draw time.
 *  P-VAR anti-repeat: an event already fired this career (ctx.seenEvents) is
 *  excluded, so a pool story never repeats within one run. */
export function rollRandomEvent(
  ctx: EventContext,
  opts?: { excludeClubMove?: boolean },
): FiredEvent | null {
  // excludeClubMove: the story-channel (S) draw must NOT pick a club-move
  // story (position_competition/club_crisis/return_home — resolve sets
  // newClubId). Those route to T; a story slot is reserved for a non-move
  // story so transfer + story coexist without two newClubId in one period.
  const eligible = EVENT_DEFS.filter(
    (d) => d.eligible(ctx)
      && !ctx.seenEvents?.includes(d.key)
      && !(opts?.excludeClubMove && POOL_CLUB_MOVE_KEYS.has(d.key)),
  );
  // Measurement hooks (inert in production; null by default). POOL_WEIGHT_OVERRIDE
  // lets counterfactual probes swap weights; POOL_ELIGIBLE_COLLECTOR records the
  // eligible set per draw so n_E (gate-width) can be re-measured when gates change.
  if (POOL_ELIGIBLE_COLLECTOR) POOL_ELIGIBLE_COLLECTOR(eligible.map((d) => d.key), ctx.age, !!opts?.excludeClubMove);
  if (eligible.length === 0) return null;
  // 门宽补偿抽取：有效权重 = 分层基线 ÷ (n_E + K)，使各事件出现率趋一致
  // （抵消「宽门事件靠资格量霸场」「窄门事件靠高权重垄断」两类偏斜）。
  const idx = weighted(ctx.rngState, eligible.map((d) => [d, poolEffectiveWeight(d, ctx)] as const));
  if (!idx) return null;
  return idx.build(ctx);
}

/** Fire a specific contextual event by key (e.g. contract_nonrenewal,
 *  relegation_loyalty). Bypasses the def's eligibility gate: contextual events
 *  carry `eligible: () => false` to stay OUT of the random pool, and the
 *  caller (run.ts) owns the context check. The old `!def.eligible(ctx)` guard
 *  here made every such event permanently unreachable. */
export function fireEventByKey(ctx: EventContext, key: string): FiredEvent | null {
  const def = EVENT_DEFS.find((d) => d.key === key);
  if (!def) return null;
  return def.build(ctx);
}

/** Pick an injury event (target injury roll: up to 2 per career, 2%/season).
 *  玻璃大炮 (glass_cannon): ×3 injury rate. talisman halves the first injury. */
export function rollInjuryEvent(ctx: EventContext): FiredEvent | null {
  const plan = ctx.plan;
  const injuryCount = plan?.injuryCount ?? 0;
  const r = derive(ctx.seed, "injury", ctx.age, ctx.periodIndex);
  // Injuries beget injuries: each prior SEVERE injury adds +13%/season — the
  // snowball that makes a 3-重伤-28-岁退役 career possible (医学退役 arc).
  // P-INJ3: 基线 4.5%→3.5%(用户反馈仍偏多+背靠背两期伤病体感差)+ 雪球 0.15→
  // 0.13 进一步收窄尾巴,目标均值~1.0/生涯(一次为常、不幸才多)。重伤权重
  // 20%→15%(健康身体极少碰重伤)。普通伤即时 delta 再轻一档(P-INJ3 表),
  // 配合 deferred 回血=净0,普通伤完全不伤生涯。
  let perSeason = 0.035 + 0.13 * (ctx.severeInjuries ?? 0);
  if (ctx.blessings.includes("glass_cannon")) perSeason *= 3;
  if (ctx.blessings.includes("ironman")) perSeason *= 0.8;  // 铁人: the iron body is hurt less often
  if (ctx.blessings.includes("talisman") && injuryCount === 0) perSeason *= 0.4;
  if (ctx.statusTags.includes("cautious_play")) perSeason *= 0.5;
  // talisman STATUS TAG (granted by legendary event successes — the_warrior,
  // the_king, …): the totem protects the body while it lasts. Nine events
  // wrote this tag and nothing read it.
  if (ctx.statusTags.includes("talisman")) perSeason *= 0.5;
  // 铁血队长 (combo_iron 词条成型): the scarred captain's body knows how to last.
  if (ctx.statusTags.includes("combo_iron")) perSeason *= 0.7;
  perSeason = Math.min(perSeason, 0.35);
  // one roll per PERIOD, so compound the per-season rate over the period's
  // seasons — express pace (3 seasons/decision) must not under-sample injuries.
  const injuryRate = 1 - Math.pow(1 - perSeason, ctx.periodLength ?? 1);
  if (!chance(r, injuryRate)) return null;
  const types = ["hamstring", "meniscus", "acl", "ankle_sprain", "calf_tear",
    "tibia_fibula", "metatarsal_fracture", "achilles", "shoulder_dislocation", "disc_hernia"];
  // 重伤/普通伤分开(P-INJ4):基线重伤权重压到 13%(原 33%)——健康身体极少
  // 碰重伤,重伤是"罕见且重"的 tier。biased(已有重伤)时重伤 ×2 回到 ~23%,保
  // 留医学退役弧的牙齿(已伤的身体才会反复重伤)。目标:基线 1 次重伤~10%、
  // 2 次~4%、3 次~1%。普通伤(轻+中)走"即时扣+deferred 回血"=净0;重伤走
  // 即时扣+少量永久(见 continue/play_through)。
  const weights = [34, 27, 7, 24, 11, 3, 2, 1, 2, 1];
  // a body with prior severe injuries re-breaks BADLY: double the severe-type
  // weights (recurring ACL/achilles — the medical-retirement snowball's teeth).
  const SEVERE_TYPES = new Set(["acl", "tibia_fibula", "metatarsal_fracture", "achilles", "disc_hernia"]);
  const biased = (ctx.severeInjuries ?? 0) >= 1
    ? weights.map((w, i) => (SEVERE_TYPES.has(types[i]!) ? w * 2 : w))
    : weights;
  const idx = weighted(r, biased.map((w, i) => [i, w] as const));
  const injuryType = idx !== undefined ? types[idx]! : "hamstring";
  return buildEvent({ ...ctx, injuryType }, "injury", "伤病", "你受伤了。", INJURY_DECISION_OPTIONS);
}

// ───────────────────────────── 医学退役 arc (P-B1) ─────────────────────────────
//
// Severe injuries accumulate. The 2nd fires a warning (agency: play cautious or
// defy), the 3rd fires the verdict (retire with dignity, or gamble on one last
// comeback). This is what makes a "三次重伤，28岁退役" career possible — the
// tragic-but-shareable ending the base rules structurally prevented.

/** The doctor's warning — fires once, after the 2nd severe injury. */
export function doctorWarningEvent(ctx: EventContext): FiredEvent {
  return buildEvent(ctx, "doctor_warning", "队医的警告",
    "第二次大伤的复查日。队医把两张核磁共振片子并排插在灯箱上——去年一张，今年一张。\n「我见过很多像你这样的身体。」他关掉灯箱，转过身来。「再来一次，坐在你对面的就不是我了，是退役鉴定委员会。改踢法，或者赌命。你选。」\n诊室里很安静，你能听见自己膝盖里钢钉的重量。",
    [{ key: "cautious", text: "收着踢，我还想踢很多年", sub: "伤病风险减半（4个赛季）" },
     { key: "defy", text: "我的踢法就是我，不改" }], "rare");
}

/** The medical verdict — fires after the 3rd severe injury (and again on each
 *  further one, if the player gambled their way past it). */
export function medicalVerdictEvent(ctx: EventContext): FiredEvent {
  return buildEvent(ctx, "medical_verdict", "诊室的沉默",
    `第三次了。这次医生没有先开口——他只是把报告推过来，然后等你抬头。\n「作为医生，我的建议是退役。现在退，你还能正常走路、抱孩子、六十岁爬山。再拼下去……」他停住了。\n${ctx.age}岁。你的更衣柜还在，你的号码还在，你的名字还挂在首发名单的边缘。但你的身体已经提前交卷了。`,
    [{ key: "accept_retirement", text: "接受。在还能站着的时候离开", sub: "体面退役" },
     { key: "gamble", text: "赌一把。十四个月康复，我要回来" }], "legendary");
}

// ───────────────────────────── transfer events ─────────────────────────────

/** Build a transfer/contract event offering new clubs (real club names). */
export function transferEvent(ctx: EventContext): FiredEvent {
  const { player, club: currentClub, rngState: rng } = ctx;
  const former = new Set(ctx.formerClubIds ?? []);
  // P-RATING: performance → offer tier. The FORM (this season's 综合表现
  // rating), not market value, drives who courts you: ≥8.0 (优秀) → +1 tier
  // (豪门留意), <6.3 (低迷) → -1 tier (市场冷清). Same threshold lines as the
  // rating→growth loop — one rating, one meaning. The old MV-vs-OVR signal was
  // circular (MV tracks OVR), so it barely moved offers; rating is the
  // independent form signal. Your last season literally changes who courts
  // you, and the desc below names the rating so the player SEES the causality
  // (information before decision). Ceiling + agent filter still bound a hot
  // streak from rocketing to Real Madrid; a slump still gets lateral offers,
  // never locked out (forced-exit handles the extreme).
  const rr = ctx.recentRating ?? null;
  const perfBoost = rr == null ? 0 : rr >= 8.0 ? 1 : rr < 6.3 ? -1 : 0;
  const friction = pathFrictionOf(ctx);
  const offers = generateClubOffers(player, currentClub, rng, 3, perfBoost, friction);
  // P-NATION 叙事: 出身国视角的两个生涯时刻——「留洋船票」(T4/T5 无欧洲履历
  // 者收到 UEFA 报价,机制上正是跳板窗) 与「衣锦还乡」(28+ 旅外球员收到母国
  // 联赛报价)。纯文案层,不引入任何 rng——确定性不受影响。
  const originId = player.originNationalityId ?? player.nationalityId;
  const abroad = leagueById(currentClub.leagueId).country.toLowerCase() !== originId;
  const isHomecomingClub = (c: Club) => player.age >= 28 && abroad && leagueById(c.leagueId).country.toLowerCase() === originId;
  // 船票 flavor 锁定青年窗口 (≤24): 欧洲进口的是年轻人 (CIES MR79 首次留洋
  // 中位 21.5 岁)——25+ 的窗口回落常规 flavor,避免「不常来」的台词说太多遍。
  const euOffer = friction.originTier >= 4 && !friction.uefaExp && player.age <= 24
    ? offers.find((o) => leagueById(o.club.leagueId).confederation === "UEFA")
    : undefined;
  // P-A169: predict the player's role at each offered club so the transfer
  // decision surfaces "go here → you'd be a bench player, few appearances,
  // stunted growth" vs "go here → starter, full minutes, develops fast". This
  // is the strategic depth the user asked for: role positioning changes your
  // development path and playing time, and now the player SEES it pre-choice.
  const predictRole = (club: { rep: number }): string => predictRoleLabel(player, club, ctx.pendingMods);
  const choices: Choice[] = offers.map((o, i) => {
    const lg = LEAGUES.find((l) => l.id === o.club.leagueId);
    const role = predictRole(o.club);
    // 仅透露联赛声望（联赛名 + 星级）与角色定位——转会后的周薪、身价与夺冠
    // 概率属于"游戏内核"，签约前不公开，让选择回到声望与角色的取舍。
    // 升档/降档是声望比较的衍生判断，星级本身已表达声望，不再冗余标注。
    return {
      id: `club-${i}`,
      kind: "new_club",
      text: o.club.name,
      sub: `${lg?.name ?? ""} · ${"★".repeat(clubStarRating(o.club.rep))}${former.has(o.club.id) ? " · 曾效力" : ""}${isHomecomingClub(o.club) ? " · 衣锦还乡" : ""} · ${role}`,
      clubId: o.club.id,
    };
  });
  choices.push({ id: "stay", kind: "stay", text: `留在 ${currentClub.name}`, sub: predictRole(currentClub), clubId: currentClub.id });
  // dynamic description: flavor by who's courting + the form that drove it,
  // then the core tradeoff in ONE clause — the sub lines carry the prestige +
  // role read, so the desc stays short enough to read at a glance on mobile.
  // The rating is NAMED when form moved the offer tier, so the player sees the
  // rating→offer causality (environmental teaching, not a tutorial).
  const maxOfferRep = offers.length > 0 ? Math.max(...offers.map((o) => o.club.rep)) : 0;
  const formNote = rr == null ? ""
    : perfBoost > 0 ? `上季 ${rr.toFixed(1)} 分的表现让豪门开始留意你。`
    : perfBoost < 0 ? `上季 ${rr.toFixed(1)} 分的低迷让市场对你兴趣寥寥。`
    : "";
  // 留洋船票压过常规 flavor: 对无欧洲履历的 T4/T5 出身球员,窗口里出现 UEFA
  // 报价本身就是这个生涯最重要的一次机会,文案必须把分量点出来。
  const springboardCall = euOffer
    ? `${leagueById(euOffer.club.leagueId).name}的球探连看了你三场比赛。从你出发的地方到欧洲，这张船票不常来。`
    : "";
  const flavor = springboardCall || (maxOfferRep > currentClub.rep
    ? (formNote || "豪门正在密切关注你。")
    : maxOfferRep < currentClub.rep
      ? (formNote || "市场冷清，只有同级或更小的俱乐部问询。")
      : (formNote || "你的表现引起了关注。"));
  const desc = `${flavor}\n经纪人把几份合同摊在桌上，没急着开口，在等你先看。「都在这了。」他敲了敲桌面，「签哪一支，你自己定。」`;
  return {
    event: { key: "transfer", title: "转会窗口", desc, choices },
    resolve: (choice) => {
      if (choice.id === "stay") {
        // loyal_club: staying flags loyalStay (drives stayStreak → club_legend 标签)。
        return { mods: { loyalStay: true }, outcome: `你留在 ${currentClub.name}。`, good: true };
      }
      const idx = Number(choice.id.replace("club-", ""));
      const offer = offers[idx];
      if (!offer) return { mods: {}, outcome: "未达成转会。", good: false };
      const roleLabel = predictRole(offer.club);
      // outcome reflects the role positioning the player chose — the strategic
      // consequence the user wants visible. Bench → fewer minutes + harder
      // growth; starter → full development. The choice IS the positioning.
      const outcomeRoleNote =
        roleLabel === "主力" ? `你加盟 ${offer.club.name}，直接坐稳主力——教练把首发交给了你。`
        : roleLabel === "轮换" ? `你加盟 ${offer.club.name}，但主力位置有竞争——你从轮换打起，要靠自己抢回首发。`
        : roleLabel === "边缘" ? `你加盟 ${offer.club.name}，但出场机会有限——你在大俱乐部的边缘，得为每一分钟拼搏。`
        : roleLabel === "替补" ? `你加盟 ${offer.club.name}，但只能坐板凳——豪门的替补席不好坐，你要等机会。`
        : `你加盟 ${offer.club.name}。`;
      // P-NATION 叙事落点: 首次留洋 / 衣锦还乡的选择要在判决牌上被点名。
      const offerLg = leagueById(offer.club.leagueId);
      const firstEurope = friction.originTier >= 4 && !friction.uefaExp && offerLg.confederation === "UEFA";
      const homecoming = isHomecomingClub(offer.club);
      const outcome = firstEurope
        ? `${outcomeRoleNote}\n留洋第一步——这里不是终点，是跳板。踢出来，五大联赛的门才会开。`
        : homecoming
          ? `${outcomeRoleNote}\n衣锦还乡——你把在外面学到的一切，带回了家门口的联赛。`
          : outcomeRoleNote;
      return { mods: { newClubId: offer.club.id }, outcome, good: true };
    },
  };
}

/** 青训抉择 (academy choice) — the FIRST decision of every career, fired
 *  before any season is simulated (run.ts simulatePeriod's academy guard).
 *  Two offers are drawn without replacement from every club across all
 *  represented leagues in the player's home country; the third (留洋 offer)
 *  is drawn from a pool spanning every confederation — same-confederation clubs
 *  (free) plus cross-confederation clubs capped at rep ≤ 7 (the famous
 *  development academies — 本菲卡/波尔图/阿贾克斯/萨尔茨堡 — but NOT the
 *  global elite, so a 16yo isn't randomly offered 皇马). Nations without a
 *  represented domestic league retain homeLeagueOf's regional development-hub
 *  fallback. 青训放宽: the abroad pool used to be locked to the player's own
 *  confederation, which starved CAF (1 league) / CONMEBOL (3 leagues) / AFC
 *  prospects into a handful of same-region clubs; broadening it opens the
 *  classic「少年留洋」arc (南美/非洲少年去欧洲青训). Each pool has an
 *  independent derived RNG stream, making the offers a pure function of
 *  (player nationality, seed) and reproducible after refresh. No 留队 option:
 *  the player must pick an academy to begin; resolve sets newClubId, then
 *  simulatePeriod stamps it as the real startClubId and runs season 1. */
export function academyChoiceEvent(player: Player, seed: string): FiredEvent {
  const nation = nationById(player.nationalityId);
  const fallbackLeague = homeLeagueOf(nation.id);
  const domesticLeagues = LEAGUES.filter((league) => league.country.toLowerCase() === nation.id);
  const homeCountry = domesticLeagues[0]?.country ?? fallbackLeague.country;
  const homeLeagueIds = new Set(
    LEAGUES.filter((league) => league.country === homeCountry).map((league) => league.id),
  );
  const homePool = CLUBS.filter((club) => homeLeagueIds.has(club.leagueId));
  const pickWithoutReplacement = (pool: readonly Club[], count: number, rng: RngState): Club[] => {
    const remaining = [...pool];
    const picked: Club[] = [];
    while (picked.length < count && remaining.length > 0) {
      picked.push(remaining.splice(int(rng, 0, remaining.length - 1), 1)[0]!);
    }
    return picked;
  };

  const homeOffers = pickWithoutReplacement(
    homePool,
    2,
    derive(seed, "academy", nation.id, "home"),
  );
  const offeredIds = new Set(homeOffers.map((club) => club.id));
  const representedConfederation = LEAGUES.some((league) => league.confederation === nation.confederation)
    ? nation.confederation
    : fallbackLeague.confederation;
  // 青训放宽 (owner ask): 第三张「留洋」offer 不再锁死本联盟。同联盟保持自由
  // (本区大球会也是青训抉择的赌注——保留原行为)；跨联盟纳入 rep ≤ 7 的俱乐部,
  // 让 16 岁可去他联盟的青训营——本菲卡/波尔图/阿贾克斯/萨尔茨堡等著名青训
  // (rep5-7) 在列,全球顶级 (rep8-9: 皇马/曼城/拜仁…) 排除,避免「皇马随机相中
  // 中国 16 岁」的不真实。修掉 CAF/CONMEBOL 等仅 1-3 个联赛的小联盟青训抉择
  // 只有 6 家俱乐部可选的死局。
  const foreignPool = CLUBS.filter((club) => {
    if (offeredIds.has(club.id)) return false;
    const league = leagueById(club.leagueId);
    if (league.country === homeCountry) return false;
    if (league.confederation === representedConfederation) return true;   // 同联盟: 自由
    return club.rep <= 7;                                                  // 跨联盟: 留洋, 避开全球顶级
  });
  const regionalPool = foreignPool.length > 0
    ? foreignPool
    : CLUBS.filter((club) => !offeredIds.has(club.id)
      && leagueById(club.leagueId).confederation === representedConfederation);
  const regionalOffer = pickWithoutReplacement(
    regionalPool,
    1,
    derive(seed, "academy", nation.id, "continental"),
  );
  const offers = [...homeOffers, ...regionalOffer];

  const predict = (club: { rep: number }): string => predictRoleLabel(player, club);
  const youthRole = (club: Club): string => ROLE_NAME[resolveYouthRole(player.overall, club, player.position === "GK")];
  const choices: Choice[] = offers.map((c, i) => ({
    id: `club-${i}`,
    kind: "begin_career",
    text: c.name,
    sub: `${leagueById(c.leagueId).name} · ${"★".repeat(clubStarRating(c.rep))} · 青年队${youthRole(c)} · 一线队前景：${predict(c)}`,
    clubId: c.id,
  }));

  const desc = `十六岁。三份青训邀请摆在面前。\n大球会青年队挤满天才，一线队的门也最窄；小球会更容易踢上比赛，通往最高舞台的路却更长。每份资料都写着你在青年队的定位，以及升入一线队的前景。\n经纪人把资料推过来：「选一家，先在青年队证明自己。」`;
  return {
    event: { key: "academy_choice", title: "青训抉择", desc, choices, eventKey: "academy_choice" },
    resolve: (choice) => {
      const idx = Number(choice.id.replace("club-", ""));
      const club = offers[idx];
      if (!club) return { mods: {}, outcome: "未选定青训去处。", good: false };
      const seniorRole = predict(club);
      const youthStart = `你加入 ${club.name} 青年队，从${youthRole(club)}打起。`;
      const outcomeRoleNote = seniorRole === "主力"
        ? `${youthStart}教练认为，升上一线队后你有机会直接争主力。`
        : seniorRole === "轮换"
          ? `${youthStart}教练认为，升上一线队后你要从轮换开始竞争。`
          : seniorRole === "边缘"
            ? `${youthStart}一线队的门槛很高，你得先在青年队站稳。`
            : seniorRole === "替补"
              ? `${youthStart}一线队的门还很远，每次青年队出场都不能浪费。`
              : `${youthStart}一线队门将位置已满，你得耐心等待机会。`;
      return { mods: { newClubId: club.id }, outcome: outcomeRoleNote, good: true };
    },
  };
}

/** P-RETIRE: the soft-retention failure fired by run.ts when the body can't
 *  keep up at this level (a retention roll failed past age 33). Two choices:
 *  drop down to a weaker club (extend the career at a lower level — the
 *  踢低级别联赛养老 arc; self-balancing: a weaker club raises the OVR cushion
 *  so the next retention roll is easier) or hang up the boots. The career
 *  terminates only when the player declines past EVERY club's reach. No rng —
 *  the roll already happened in run.ts, so both exits are deterministic.
 *  eventKey "no_offers" routes resolve through resolveEventOption. */
export function noOffersEvent(ctx: EventContext): FiredEvent {
  const { club, league } = ctx;
  const weaker = CLUBS.filter((c) => c.leagueId === league.id && c.id !== club.id && c.rep <= club.rep)
    .sort((a, b) => a.rep - b.rep)[0];
  const choices: Choice[] = [
    {
      id: "drop_down",
      kind: "new_club",
      text: weaker ? `降档续约，去${weaker.name}` : "降档续约，去低级别联赛",
      sub: weaker ? `${weaker.name} · 降薪 · ${predictRoleLabel(ctx.player, weaker, ctx.pendingMods)}` : "去更低级别联赛延续生涯",
      clubId: weaker?.id,
    },
    { id: "retire", kind: "retire", text: "挂靴退役", sub: "功成身退 · 传承结算" },
  ];
  const desc = `更衣室里你的更衣柜还在，但体育总监没有把新合同推过来。\n「以你现在的状态，我们没办法续约了。」他没看你的眼睛。「隔壁几家的球探在看你的录像——他们能给的是主力，但薪水只有现在的一半。」\n你看着训练场，想起十六岁那年第一次踏上这片草皮。现在的问题是：去别处再踢几年，还是在这里把球靴挂起来。`;
  return {
    event: { key: "no_offers", title: "无人问津", desc, choices, eventKey: "no_offers" },
    resolve: (choice, rng) => resolveEventOption(rng, "no_offers", choice.id, ctx),
  };
}

/** P-RETIRE: the fame-league bid — the realistic exit for an ELITE aging star
 *  whose body failed the retention roll at a big club (皇马 32 岁 97 综合被
 *  无人问津 的反馈). A Modric/Casemiro/Ronaldo does NOT slide into 无人问津
 *  when the club won't renew: his name still carries weight, and the wealth-
 *  seeking leagues (沙特联, the fame league) wave mega contracts to buy his
 *  召唤力 and build their league around him. So this is a LEAGUE-DRIVEN
 *  transfer, not a forced pay-cut exit: 2 fame-league (Saudi) clubs headline
 *  the money move, ONE high-level same-confederation club offers the "keep
 *  playing at a high level for less" path (the Casemiro→曼联 / Totti-stays
 *  arc), and 挂靴 retires with dignity (voluntary, not 无人问津). The genuine
 *  伤仲永 / fading non-star (OVR < FAME_BID_OVR) still routes to noOffersEvent
 *  in run.ts — only a still-elite star attracts the fame bid.
 *
 *  Determinism: offers use a FRESH derive stream `fame-bid` (not ctx.rngState),
 *  so they're reproducible AND immune to whatever ctx.rngState consumption
 *  happened in the blocks above the retention gate. rebuildResolve reconstructs
 *  ctx with the same seed/age/periodIndex → identical offers → identical resolve.
 *  No rng in resolve (reads the pre-built offers via closure), matching
 *  transferEvent/wage_squeeze's inline-resolve pattern. */
export function fameLeagueBidEvent(ctx: EventContext, mode: "exit" | "offer" = "exit"): FiredEvent {
  const { player, club: cur } = ctx;
  const former = new Set(ctx.formerClubIds ?? []);
  // offer mode uses its own derive stream so the Saudi picks are independent
  // of the exit-mode picks (a career that sees both — rare — gets two distinct
  // offer sets, not a repeat of the same two clubs).
  const rng = derive(ctx.seed, mode === "offer" ? "fame-offer" : "fame-bid", ctx.age, ctx.periodIndex);
  const base = (rep: number) => SQUAD_BASE_BY_REP[rep] ?? 50;
  const byRep = (a: Club, b: Club) => b.rep - a.rep || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  // fame leagues (沙特联 — the `fame` flag): the money move. 头牌不再写死联赛
  // 第一 (那会让每段生涯的金元剧本都由同一家球队主演),而是在声望最高的
  // FAME_HEADLINE_POOL 家里 rng 抽 1——依旧是「拿得出天价合同的大俱乐部」,但
  // 跨 seed 换人;第二家从剩下的全部沙特队里抽,联赛扩编后是 17 选 1。
  const famePool = CLUBS.filter((c) => c.id !== cur.id && leagueById(c.leagueId).fame);
  const fameSorted = [...famePool].sort(byRep);
  const headlinePool = fameSorted.slice(0, FAME_HEADLINE_POOL);
  const topFame = headlinePool.length > 0 ? headlinePool[int(rng, 0, headlinePool.length - 1)] : undefined;
  const restFame = fameSorted.filter((c) => c !== topFame);
  const secondFame = restFame.length > 0 ? restFame[int(rng, 0, restFame.length - 1)] : undefined;
  const fame: Club[] = topFame ? (secondFame ? [topFame, secondFame] : [topFame]) : [];

  // The third option diverges by mode — the crux of the exit vs offer design:
  //   exit  → a high-level same-confederation drop-down (the club WON'T renew,
  //           so you must move — keep playing at a high level for less). A
  //           step DOWN but still respectable, where the player is a clear
  //           starter. Prefer non-former clubs; pick from the top half with
  //           rng for variety. Excludes the fame clubs already offered.
  //   offer → NO third club — instead a 留队 stay choice (the club still wants
  //           you; Saudi is the TEMPTATION, staying is the loyal Modric arc).
  //           Rendered as a stay Choice below, not a club dest.
  let thirdDest: { club: Club; fame: boolean } | null = null;
  let stayChoice: Choice | null = null;
  if (mode === "exit") {
    const curConf = leagueById(cur.leagueId).confederation;
    const dropPool = CLUBS.filter((c) =>
      c.id !== cur.id && !fame.includes(c)
      && leagueById(c.leagueId).confederation === curConf
      && c.rep < cur.rep && player.overall - base(c.rep) >= 0,
    ).sort(byRep);
    const nonFormer = dropPool.filter((c) => !former.has(c.id));
    const pickPool = nonFormer.length > 0 ? nonFormer : dropPool;
    if (pickPool.length > 0) {
      const topN = pickPool.slice(0, Math.max(1, Math.ceil(pickPool.length / 2)));
      thirdDest = { club: topN[int(rng, 0, topN.length - 1)]!, fame: false };
    }
  } else {
    stayChoice = {
      id: "stay", kind: "stay",
      text: `留在 ${cur.name}`,
      sub: "拒绝金元 · 留守欧洲",
      clubId: cur.id,
    };
  }

  const dests: { club: Club; fame: boolean }[] = [
    ...fame.map((c) => ({ club: c, fame: true })),
    ...(thirdDest ? [thirdDest] : []),
  ];
  const choices: Choice[] = dests.map((d, i) => {
    const lg = leagueById(d.club.leagueId);
    const stars = "★".repeat(clubStarRating(d.club.rep));
    const role = predictRoleLabel(player, d.club, ctx.pendingMods);
    const sub = d.fame
      ? `${lg.name} · ${stars} · 天价合同 · ${role}`
      : `${lg.name} · ${stars}${former.has(d.club.id) ? " · 曾效力" : ""} · ${role}`;
    return { id: `club-${i}`, kind: "new_club", text: d.club.name, sub, clubId: d.club.id };
  });
  if (stayChoice) choices.push(stayChoice);
  choices.push({ id: "retire", kind: "retire", text: "挂靴退役", sub: "功成身退 · 传承结算" });

  // desc by mode: exit is the forced-out beat (club won't renew); offer is the
  // temptation beat (club still wants you, Saudi comes knocking anyway).
  const desc = mode === "exit"
    ? `体育总监把茶杯放下，没有让你坐。「新合同的事，我们不再谈了。」他没看你。
但你的电话从昨晚起就没停过。沙特的豪门在另一头——他们要的不只是你的脚法，是你的名字：能用号召力撑起一整个联赛的那种名字。天价年薪、私人飞机，一切都摆在桌上。
欧洲也有一家俱乐部愿意把你当核心，让你继续在最高水平上踢球。钱、舞台、还是体面地挂靴——比任何转会窗都重的一个选择，落在你面前。`
    : `经纪人把一份传真推到你面前，没等你放下手机。「沙特联的豪门开出了天价——年薪翻倍，私人飞机，海边一栋别墅，全都写好了。」他压低声音，「他们要的不只是你的脚法，是你的名字：能用号召力撑起一整个联赛的那种名字。」
你看着训练场——你在这里还能踢，更衣室里你的位置还在，新合同就摆在桌上。天价的诱惑、留守的体面，还是干脆把球靴挂起来——比任何一个转会窗都重的一个选择，落在你面前。`;
  // offer mode uses its own eventKey so rebuildResolve can reconstruct it
  // distinctly from the exit-mode bid (same builder, different ev.key switch).
  const eventKey = mode === "offer" ? "fame_league_offer" : "fame_league_bid";
  // offer-mode anti-repeat tag — set on EVERY offer-mode resolve so the event
  // doesn't refire within its TTL regardless of which option was picked.
  // exit mode needs no anti-repeat (it's a terminal beat — the career either
  // ends or moves to a fresh_contract that pauses retention anyway).
  const seenTag = mode === "offer" ? [tag("fame_offer_seen", 4)] : [];
  return {
    event: { key: eventKey, title: "金元邀约", desc, choices },
    resolve: (choice) => {
      if (choice.id === "stay") {
        return {
          mods: { loyalStay: true, addTags: seenTag },
          outcome: `你把传真推回桌面，摇了摇头。「我在这里还有球要踢。」经纪人叹了口气，没再多说。你走出房间的时候，桌上那份天价合同的数字，你连一眼都没再看。`,
          good: true,
        };
      }
      if (choice.id === "retire") {
        return {
          mods: { forceRetire: true, forceRetireReason: "voluntary", addTags: seenTag },
          outcome: `你看着那份天价合同看了很久，然后把球靴挂在更衣柜上——不是因为没人要，恰恰相反，全世界都在抢你。但你想在还能踢的时候，自己选择告别。带着所有的荣耀和遗憾，你最后一个走出训练基地，灯一盏一盏熄在你身后。`,
          good: true,
        };
      }
      const idx = Number(choice.id.replace("club-", ""));
      const d = dests[idx];
      if (!d) return { mods: {}, outcome: "未达成转会。", good: false };
      const outcome = d.fame
        ? `你登上飞往${d.club.name}的航班。天价合同，私人飞机，一切和你十六岁那年在泥地球场上想象的都不一样——但球还是那个球，场上的九十分钟，依然属于你。`
        : `你签了${d.club.name}。降薪，但合同上写着两个字：主力。你想起十六岁那年，什么都没有，只有场上的九十分钟——现在你又回到了那种感觉。`;
      return {
        mods: { newClubId: d.club.id, addTags: [tag("fresh_contract", 2), ...seenTag] },
        outcome,
        good: true,
      };
    },
  };
}

/** 告别仪式 (retirement_ceremony) — the universal capstone for a FORCED
 *  retirement (OVR floor / age ceiling). The hard triggers used to call
 *  finalizeRun directly: a normal event fired, the player picked an option,
 *  the season advanced past the OVR/age line, and the career cut straight to
 *  the summary — the player never saw the consequence of their last choice
 *  nor got a retirement moment (player feedback: 按完正常事件就戛然而止).
 *  Now the hard trigger fires THIS event as the period's decision instead: the
 *  just-simulated season (the one where the body finally gave / age caught
 *  up) plays out, the prior event's verdict shows, then the player chooses
 *  HOW to announce their retirement. All three options retire (forceRetire);
 *  the difference is the farewell scene + a farewell_* persona tag that
 *  personalizes the summary capstone. No rng — a terminal narrative choice,
 *  like the 挂靴 option it parallels. The soft-retention 挂靴 (no_offers /
 *  金元邀约 / 薪资挤压) and the story-arc retirements (medical verdict,
 *  narrative pool events) already carry their own farewell beats, so they
 *  keep their direct endings; only the abrupt no-event retirements route here.
 *
 *  Determinism: the resolve closure captures `reason` (threaded onto the
 *  event as retireReason so rebuildResolve can reconstruct it after a
 *  refresh). No rng in resolve — the three options are deterministic exits. */
export function retirementCeremonyEvent(ctx: EventContext, reason: string): FiredEvent {
  const { club } = ctx;
  // the scene opens in the club's locker room; the lead-in adapts to WHY the
  // career is ending (old age / faded hero / no offers / injury) so the
  // farewell matches the arc that brought the player here.
  const lead: Record<string, string> = {
    age: `你坐在${club.name}的更衣室里，看着镜子里那张脸——比十六岁第一次走进球场那天老了太多。二十多年了，该走的路都走完了，该拿的也拿过了。`,
    faded: `你坐在${club.name}的更衣室里，看着镜子里那张脸。英雄迟暮——那个能凭一己之力改变比赛的你，回不来了。强撑下去只会让最后的自己难堪，该体面地告别了。`,
    no_offers: `你坐在${club.name}的更衣室里，喘着粗气。你的身体先于你的心退役了——训练场上你跟不上了，属于你的那个位置，也快不是你的了。再踢下去，只会消耗掉你攒下的所有体面。`,
    injury: `你坐在${club.name}更衣室的治疗床上，看着缠满绷带的膝盖。伤病带走了你的职业生涯——队医最后那句话你听得很清楚，你的身体撑不住职业赛的强度了。硬撑，下一次倒下可能就站不起来了。`,
  };
  const opener = lead[reason] ?? lead.no_offers!;
  const desc = `${opener}\n是时候了。\n至于怎么把这个消息告诉世界，你想了很久——是私下告诉最在乎的人，还是让所有人一起见证这个时刻？`;
  const choices: Choice[] = [
    { id: "call_family", kind: "retire", text: "打电话告诉家人", sub: "私下的告别 · 最安静" },
    { id: "social_media", kind: "retire", text: "在社媒上发文宣布", sub: "公开的告别 · 简单直接" },
    { id: "press_conference", kind: "retire", text: "召开退役发布会", sub: "隆重的告别 · 体面谢幕" },
  ];
  return {
    event: { key: "retirement_ceremony", title: "告别时刻", desc, choices, eventKey: "retirement_ceremony", retireReason: reason },
    resolve: (choice) => farewellResolve(choice.id, reason),
  };
}

/** The three farewell outcomes — each retires (forceRetire, same reason) and
 *  stamps a farewell_* persona tag so the summary can show the player's
 *  chosen way to say goodbye. Pure flavor (no mechanical stake at career's
 *  end); the closure captures the reason so forceRetireReason threads through
 *  to the ending label. */
function farewellResolve(optionKey: string, reason: string): ResolveResult {
  switch (optionKey) {
    case "call_family":
      return {
        mods: { forceRetire: true, forceRetireReason: reason, addTags: [tag("farewell_private", 99)] },
        outcome: "你拨通了家里的电话。那头沉默了很久，然后是母亲的声音——她什么都没问，只说了一句「回来吧」。你挂了电话，眼眶发酸。第二天，你的退役没上任何头条，只在家人之间传开。你想要的告别，就是这样。",
        good: true,
      };
    case "social_media":
      return {
        mods: { forceRetire: true, forceRetireReason: reason, addTags: [tag("farewell_public", 99)] },
        outcome: "你打开手机，敲下那行字：「感谢这一切。是时候说再见了。」按下发布的那一刻，评论区瞬间涌进上万条留言。你的退役，成了这天所有球迷时间线上的第一条。",
        good: true,
      };
    case "press_conference":
      return {
        mods: { forceRetire: true, forceRetireReason: reason, addTags: [tag("farewell_grand", 99)] },
        outcome: "发布会厅挤满了人——记者、前队友、教练，还有你年少时的青训教练坐在第一排。你坐在话筒前，念出那句排练了无数遍的话：「今天，我正式宣布退役。」闪光灯亮成一片。这才是你想要的告别。",
        good: true,
      };
    default:
      return { mods: { forceRetire: true, forceRetireReason: reason }, outcome: "你挂起了球靴。", good: true };
  }
}

/** 体面挂钩 (dignified_retire) — the "should I hang up?" offer for an aging
 *  player (≥RETENTION_START) whose OVR has faded out of the Saudi money zone
 *  (≤DIGNITY_RETIRE_OVR) but not yet hit the 50 hard floor. A real footballer
 *  retires at this 主力级 (~75-80), not dragged to the 50 替补级 hard floor —
 *  research/growth-curve-realism.md found re-sim dragged 93% of careers to <70
 *  before the OVR<50 floor caught them (median retire OVR 52), while real
 *  players retire at 75-80. This surfaces the retire decision EARLY, as a
 *  CHOICE (not a force): 挂靴 (voluntary + dignifiedExit, the 荣誉 ×1.25 lever
 *  that makes retiring at主力级 attractive vs grinding to 替补级) vs 再踢一季
 *  (decline, dignity_declined@4 anti-repeat). Agency preserved — a Modric who
 *  wants another year plays on; a Totti who's done hangs them up. Sits below
 *  the fame bid (Saudi buys a still-famous ≥80 star; a faded ≤78 pro gets
 *  this, not Saudi). Not a force — the OVR<50 hard floor still catches a player
 *  who keeps declining past this. Triggered by run.ts; no rng in resolve (a
 *  terminal-ish narrative choice, like the 挂靴 option it parallels). */
export function dignifiedRetireEvent(ctx: EventContext): FiredEvent {
  const { club } = ctx;
  const desc = `训练结束，你没有立刻去淋浴。更衣室里只剩你一个人，和墙上那排已经獲色的照片——那是你二十岁时的样子。\n队医上周的话还在耳边：「身体还能撑，但你自己知道，那个能凭一己之力改变比赛的你，回不来的次数越来越多了。」\n挂靴的念头，这个赛季不是第一次冒出来。问题是：是时候了吗？还是再踢一季，让最后一个赛季的自己，多记住一些奔跑。`;
  const choices: Choice[] = [
    { id: "retire", kind: "retire", text: "挂靴退役", sub: "功成身退 · 在还能踢的时候告别" },
    { id: "play_on", kind: "stay", text: `再踢一季`, sub: `留守 ${club.name} · 再给自己一年` },
  ];
  return {
    event: { key: "dignified_retire", title: "挂靴的念头", desc, choices, eventKey: "dignified_retire" },
    resolve: (choice) => {
      if (choice.id === "retire") {
        return {
          mods: { forceRetire: true, forceRetireReason: "voluntary", dignifiedExit: true },
          outcome: `你把球靴从更衣柜里拿出来，擦了擦，又放了回去——这一次，没有再拿出来。第二天你坐进教练办公室，只说了两个字：「我不踢了。」教练点点头，好像早就知道。你走出基地的时候太阳正好，你最后一次以球员的身份，看了一眼那片草皮。`,
          good: true,
        };
      }
      return {
        mods: { addTags: [tag("dignity_declined", 4)] },
        outcome: `你摇了摇头，把那个念头按了回去。「再踢一季。」你对自己说。更衣室的灯亮着，训练场的草皮等着你——你还能跑，那就再跑一年。`,
        good: true,
      };
    },
  };
}

/** P-RETIRE: the wage squeeze — 伤仲永的经济性谢幕。天赋崩了，但合同还停在
 *  巅峰期签下的那个数字，于是没有一家俱乐部愿意按这个价买他。24 岁身价 €2000 万
 *  → OVR 崩塌 → 27 岁退役的弧线是 ECONOMIC 的，不是随机的：把他挤出这项运动的
 *  是账本，不是伤病也不是失宠。
 *
 *  与 dignified_retire (挂靴的念头) 的分工：那个是「还能踢，要不要走」的体面
 *  自决 (33+，OVR≤78)；这个是「还想踢，但市场不认这个价」的被动挤压 (黄金期
 *  cadence，距生涯峰值跌 ≥8)。两条线不重叠。
 *
 *  触发判据在 sim.ts wageSqueeze()——卡面上那个「合同周薪」与 run.ts 的触发共用
 *  同一个函数，所以文案里的数字与判定永远一致，且纯由 (OVR, maxOverall) 决定，
 *  刷新后重建确定。
 *
 *  卡面不出现任何转会后的薪资数字或涨/降薪标签 (owner 决策)：这个决策真正的
 *  轴是「去哪一档 × 能不能踢上球」，薪资在引擎里只微弱地流进 careerWageTotal，
 *  摆上卡面既指导不了选择，又与「没人愿意匹配」的前提互相打架 (旧版本用上赛季
 *  的过期身价算报价薪水，78% 的场次会显示出一份不降反涨的合同)。前提只在描述
 *  里说一次，剩下交给沉默。 */
export function wageSqueezeEvent(ctx: EventContext, maxOverall: number): FiredEvent {
  const { player, club: currentClub, league, rngState: rng } = ctx;
  const former = new Set(ctx.formerClubIds ?? []);
  const { contractWage } = wageSqueeze(player, currentClub, league, maxOverall);
  const offers = generateClubOffers(player, currentClub, rng, 3, 0, pathFrictionOf(ctx));
  const predictRole = (club: { rep: number }): string => predictRoleLabel(player, club, ctx.pendingMods);
  const choices: Choice[] = offers.map((o, i) => {
    const lg = LEAGUES.find((l) => l.id === o.club.leagueId);
    const role = predictRole(o.club);
    // 与转会窗选项卡同一口径：联赛 · 星级 · (曾效力) · 定位。升档/降档是星级的
    // 衍生判断，标了只是把同一件事说两遍，还在卡面上多挤一行。
    return {
      id: `club-${i}`,
      kind: "new_club",
      text: o.club.name,
      sub: `${lg?.name ?? ""} · ${"★".repeat(clubStarRating(o.club.rep))}${former.has(o.club.id) ? " · 曾效力" : ""} · ${role}`,
      clubId: o.club.id,
    };
  });
  choices.push({ id: "retire", kind: "retire", text: "拒绝降薪，挂靴退役", sub: `体面收场 · 荣誉传承 ×${DIGNIFIED_EXIT_MULT}` });
  const desc = `经纪人把几份合同摊在桌上，翻页的时候没抬头。\n「你的合同还停在巅峰那年签的数字——周薪${fmtWage(contractWage)}。」他顿了顿，「以你现在的状态，没有一家愿意按这个价接。想接着踢，就得从这些里面挑一个。」\n你没问为什么。这半年跑动的每一步，你自己比谁都清楚。球靴还在包里，挂起来还是穿出去，这个问题比任何一个转会窗都重。`;
  return {
    event: { key: "wage_squeeze", title: "薪资挤压", desc, choices },
    resolve: (choice) => {
      if (choice.id === "retire") {
        // 主动拒绝降薪 = 自决的体面收场，与 dignified_retire 同一杠杆
        // (voluntary + 荣誉 ×1.25)。少了这个，「挂靴」相对「随便挑一家接着踢」
        // 是严格劣势选项——没有权衡的选项不是选择 (Sid Meier)。
        return { mods: { forceRetire: true, forceRetireReason: "voluntary", dignifiedExit: true }, outcome: `你把合同推回桌面。「我踢球不是为了这个数字。」你站起来，走出经纪人的办公室，外面天还亮着。球靴，是时候挂起来了——按你自己的时间，不是按别人的报价。`, good: true };
      }
      const idx = Number(choice.id.replace("club-", ""));
      const offer = offers[idx];
      if (!offer) return { mods: {}, outcome: "未达成转会。", good: false };
      const roleLabel = predictRole(offer.club);
      const outcomeRoleNote =
        roleLabel === "主力" ? `你签下了 ${offer.club.name} 的合同，数字比原来小得多，但你直接坐稳主力——你咽下那个数字，换回了场上的九十分钟。`
        : roleLabel === "轮换" ? `你签下了 ${offer.club.name} 的合同，从轮换打起。纸面上难看，可你还在名单里。`
        : roleLabel === "边缘" ? `你签下了 ${offer.club.name} 的合同，出场机会有限——你为每一分钟拼搏。`
        : roleLabel === "替补" ? `你签下了 ${offer.club.name} 的合同，只能坐板凳——豪门的替补席，比你想的更冷。`
        : `你签下了 ${offer.club.name} 的合同。`;
      return { mods: { newClubId: offer.club.id }, outcome: outcomeRoleNote, good: true };
    },
  };
}

/** Build a loan offer event (母本 loan model): loan out to a club, or stay.
 *  Surfaces the same role-positioning the transfer window does: staying at a
 *  big club = bench = the big-club-bench growth penalty (stunted development),
 *  while a loan to a smaller club = starter minutes = faster growth. Without
 *  these labels the earliest decision a benched academy prospect faces (age
 *  18-24) is a blind guess — "information before decision" (Risk-Reward
 *  Calibration) demands the stakes read up front. */
export function loanOfferEvent(ctx: EventContext): FiredEvent {
  const { player, club: contractClub, rngState: rng } = ctx;
  const offers = generateClubOffers(player, contractClub, rng, 2, 0, pathFrictionOf(ctx));
  const stayRole = predictRoleLabel(player, contractClub, ctx.pendingMods);
  const choices: Choice[] = offers.map((o, i) => ({
    id: `loan-${i}`,
    kind: "join_loan",
    text: `租借至 ${o.club.name}`,
    sub: `${"★".repeat(clubStarRating(o.club.rep))} · ${predictRoleLabel(player, o.club, ctx.pendingMods)}`,
    clubId: o.club.id,
  }));
  choices.push({ id: "stay", kind: "stay", text: `留在 ${contractClub.name}`, sub: stayRole, clubId: contractClub.id });
  const returnAge = player.age + 1;  // 1-season loan (loan-design §3.2)
  const benchWarn = stayRole === "替补" || stayRole === "边缘" || stayRole === "三门"
    ? "，再坐下去就耽误你了" : "";
  const desc = `你在 ${contractClub.name} 的出场时间有限${benchWarn}。主帅把你叫到一边：「你需要的不是更卖力的训练，是上场。」他摊开几张租借邀约，「去小一点的俱乐部，你能踢满整季——这里，你得继续等。」`;
  return {
    event: { key: "loan_offer", title: "租借邀约", desc, choices },
    resolve: (choice) => {
      if (choice.id === "stay") {
        return { mods: { loyalStay: true }, outcome: `你留在 ${contractClub.name}，继续从${stayRole}打起。`, good: true };
      }
      const idx = Number(choice.id.replace("loan-", ""));
      const offer = offers[idx];
      if (!offer) return { mods: {}, outcome: "未达成租借。", good: false };
      const loanLabel = predictRoleLabel(player, offer.club, ctx.pendingMods);
      const note = loanLabel === "主力" ? `你租借至 ${offer.club.name}，直接坐稳主力——出场时间换回了成长。`
        : loanLabel === "轮换" ? `你租借至 ${offer.club.name}，从轮换打起，比在母队更能上场。`
        : `你租借至 ${offer.club.name}。`;
      return { mods: { loanOutTo: offer.club.id, loanReturnAge: returnAge }, outcome: note, good: true };
    },
  };
}

/** Build the post-loan resolution event (母本 ca). Called when a loan just
 *  returned. If the player is now a starter/high_rotation at the parent club,
 *  they're retained (a normal transfer window). Otherwise young players can
 *  go on another loan or move permanently to the loan team. */
export function postLoanEvent(ctx: EventContext, completedLoan: { parentClubId: string; loanClubId: string }): FiredEvent {
  const { player, rngState: rng, role } = ctx;
  const parentClub = CLUBS.find((c) => c.id === completedLoan.parentClubId);
  const loanClub = CLUBS.find((c) => c.id === completedLoan.loanClubId);
  // retained: established a starting role → back to the parent club's window.
  if (role === "starter" || role === "high_rotation") {
    return transferEvent(ctx);
  }
  // re-loan only while still inside the development-loan window (YOUTH_LOAN_MAX_AGE).
  // Past it, a returned loanee who STILL can't crack the parent lineup is sold
  // down (the forced-exit 踢不出来 path in run.ts) — the club gives up by ~20-21,
  // not re-loaned into a multi-year loan-army loop. (was `age <= 24`.)
  const isYoung = player.age <= YOUTH_LOAN_MAX_AGE;
  const choices: Choice[] = [];
  if (isYoung && loanClub) {
    // another loan offer + permanent move to the loan team.
    const offers = generateClubOffers(player, parentClub ?? ctx.club, rng, 1, 0, pathFrictionOf(ctx));
    for (const o of offers) {
      choices.push({ id: `loan-${o.club.id}`, kind: "join_loan", text: `再租借至 ${o.club.name}`, sub: `${"★".repeat(clubStarRating(o.club.rep))} · ${predictRoleLabel(player, o.club, ctx.pendingMods)}`, clubId: o.club.id });
    }
  }
  if (loanClub) {
    choices.push({ id: `perm-${loanClub.id}`, kind: "permanent_transfer", text: `永久转会至 ${loanClub.name}`, sub: `${"★".repeat(clubStarRating(loanClub.rep))} · ${predictRoleLabel(player, loanClub, ctx.pendingMods)}`, clubId: loanClub.id });
  }
  const stayRole = parentClub ? predictRoleLabel(player, parentClub, ctx.pendingMods) : "";
  if (parentClub) {
    choices.push({ id: "stay", kind: "stay", text: `留在 ${parentClub.name}`, sub: stayRole, clubId: parentClub.id });
  }
  // The player came back from loan but STILL can't crack the parent club's
  // lineup (this is the benched-returner branch). Surface that: staying =
  // continued bench = the big-club-bench growth penalty, while re-loaning or
  // a permanent move to a smaller club = starter minutes = development.
  const benchStill = stayRole === "替补" || stayRole === "边缘" || stayRole === "三门";
  const desc = `租借期满，你回到了 ${parentClub?.name ?? "母队"}。归队这段日子，首发名单上依旧没有你的名字${benchStill ? `，你在这里仍是${stayRole}` : ""}。经纪人来电话了：「再出去踢一季，或者换个地方从头来——总比干坐着强。」`;
  return {
    event: { key: "post_loan", title: "租借归来", desc, choices },
    resolve: (choice) => {
      if (choice.kind === "stay") {
        return { mods: { loyalStay: true, addTags: [tag("loan_returned", 2)] }, outcome: `你留在 ${parentClub?.name ?? "母队"}，继续从${stayRole}打起。`, good: true };
      }
      if (choice.kind === "join_loan") {
        const id = choice.id.replace("loan-", "");
        const cl = CLUBS.find((c) => c.id === id);
        const label = cl ? predictRoleLabel(player, cl, ctx.pendingMods) : "";
        const note = label === "主力" ? `你再次租借至 ${cl?.name ?? "新队"}，继续坐稳主力练级。` : `你再次租借至 ${cl?.name ?? "新队"}。`;
        return { mods: { loanOutTo: id, loanReturnAge: player.age + 1 }, outcome: note, good: true };  // 1-season re-loan (loan-design §3.2)
      }
      if (choice.kind === "permanent_transfer") {
        const id = choice.id.replace("perm-", "");
        const cl = CLUBS.find((c) => c.id === id);
        const label = cl ? predictRoleLabel(player, cl, ctx.pendingMods) : "";
        const note = label === "主力" ? `你永久转会至 ${cl?.name ?? "新队"}，直接坐稳主力。` : `你永久转会至 ${cl?.name ?? "新队"}。`;
        return { mods: { newClubId: id }, outcome: note, good: true };
      }
      return { mods: {}, outcome: "你留在母队。", good: true };
    },
  };
}

/** Build a blockbuster offer event (母本 aa). A fame club (biggest in the
 *  world) courts a star player (age 28-34, peak OVR ≥ 80, tier ≥ 2). The stay
 *  option lets them decline. Offered once per tier (blockbusterOfferedTier). */
export function blockbusterOfferEvent(ctx: EventContext, maxOverall: number, offeredTier: number | undefined): FiredEvent | null {
  const { player, club: currentClub, rngState: rng } = ctx;
  if (player.age < 28 || player.age > 34) return null;
  const peakTier = maxOverall >= 90 ? 3 : maxOverall >= 85 ? 2 : +(maxOverall >= 80);
  if (peakTier < 2 || player.overall < 80) return null;
  if (offeredTier !== undefined && peakTier <= offeredTier) return null; // already offered this tier+
  // a fame club = the highest-rep clubs the player isn't already at. 门槛随峰值
  // 分档: 90+ 的传奇才配 rep≥8 的宇宙队 (13 家),85-89 放到 rep≥7 (32 家)——
  // 罗马/马赛/本菲卡/加拉塔萨雷追一个 30 岁的 86 综合前锋比皇马追他更可信,
  // 顺带让「豪门邀约」不再是同十三家轮流出场。
  const fameFloor = peakTier >= 3 ? 8 : 7;
  const fameClubs = CLUBS_POOL.filter((c) => c.id !== currentClub.id && c.rep >= fameFloor);
  if (fameClubs.length === 0) return null;
  // 45% chance per check (母本 je).
  if (!chance(rng, 0.45)) return null;
  const pick = fameClubs[int(rng, 0, fameClubs.length - 1)]!;
  const pickLeague = LEAGUES.find((l) => l.id === pick.leagueId);
  const joinLabel = predictRoleLabel(player, pick, ctx.pendingMods);
  const stayLabel = predictRoleLabel(player, currentClub, ctx.pendingMods);
  const benchAtFame = joinLabel === "边缘" || joinLabel === "替补" || joinLabel === "三门";
  // 豪门邀约同样只透露联赛声望与角色定位——夺冠概率与薪水签约前不公开，
  // 让"冲冠 vs 留守主力"的取舍回到角色与舞台本身。
  const choices: Choice[] = [
    { id: `join-${pick.id}`, kind: "new_club", text: `加盟 ${pick.name}`, sub: `${pickLeague?.name ?? ""} · ${"★".repeat(clubStarRating(pick.rep))} · ${predictRoleLabel(player, pick, ctx.pendingMods)}` },
    { id: "stay", kind: "stay", text: `留在 ${currentClub.name}`, sub: predictRoleLabel(player, currentClub, ctx.pendingMods) },
  ];
  // A fame club courts a star — but a 32yo declining star may be benched there
  // (chasing the ring as a squad player) while staying put keeps him a starter.
  // Surfacing the role turns this from a no-brainer "always take the galactico
  // offer" into the ring-chase vs loyal-starter trade-off it really is.
  const desc = `${pick.name} 向你抛来橄榄枝——这是职业生涯的巅峰转会，更是你距金球最近的一步。${benchAtFame ? `但以你现在的状态，去了豪门得为每一分钟出场拼——留在 ${currentClub.name}，你才是主角。` : ""}`;
  return {
    event: {
      key: "blockbuster_offer", title: "豪门邀约",
      desc,
      eventKey: "blockbuster_offer", choices,
    },
    resolve: (choice) => {
      if (choice.id === "stay") {
        return { mods: { loyalStay: true }, outcome: `你拒绝豪门，留在 ${currentClub.name}，继续以${stayLabel}出战。`, good: true };
      }
      const id = choice.id.replace("join-", "");
      const note = benchAtFame ? `你加盟 ${pick.name}！以${joinLabel}身份开启豪门岁月——为每一分钟而战。` : `你加盟 ${pick.name}！`;
      return { mods: { newClubId: id }, outcome: note, good: true };
    },
  };
}

interface ClubOffer {
  club: Club;
}

// 联赛放宽 (owner ask): 跨联盟转会「经纪人过滤」(CONF_PRESTIGE / agentAccepts)
// 已退役——它曾在声望匹配之上再设一道联盟门槛，把每窗报价锁死在少数同区联赛
// (足协 T5 首窗只剩几家 AFC 球队；CAF/CONMEBOL 青训抉择只有 1-3 个联赛)。
// 现以声望匹配 (generateClubOffers 的 ceiling + dirs/floor 声望带) 为唯一约束:
// 60 综合新人只看到声望相称的俱乐部，但俱乐部可来自任何联盟——跨 seed 报价不再
// 固定。五大联赛路径摩擦 (SPRINGBOARD_BLOCK_PCT) 仍是 T4/T5 直跳五大的跳板闸
// (保留「留洋跳板」叙事)；金元邀约 (fameLeagueBidEvent) 仍是晚年金钱转会专属
// 剧本 (本地球星巅峰期不会随便被沙特买走——那条线由它单独讲)。详见 ok() 注释。

/**
 * Generate transfer offers that MATCH the player's standing — the fix for the
 * "转会选项太粗糙/不真实" feedback. Two forces converge on each window:
 *
 *  1. ABILITY (playerRepTierForOffers): the rep tier whose squad base a player
 *     of this OVR would start at. Clubs ABOVE this won't bid — you're simply
 *     not good enough, and the agent rejects (no 世界级 player gets a minnow).
 *  2. VISIBILITY (current club prestige): how far UP you can jump in one move.
 *     A bench player can't be poached up at all (no one promotes a bench
 *     warmer); a proven local star climbs ~2 tiers; a YOUNG star (wonderkid)
 *     is discovered regardless of club (scouts find talent anywhere). A great
 *     season (perfBoost) lifts the ceiling, a poor one lowers it. Ability is the FLOOR of visibility, not just a cap: a player
 *     whose OVR has outgrown his club (大器晚成 in a minnow, or a loyal star who
 *     stayed put and kept rising) is courted at his ability tier + 1 — 豪门 bid
 *     on the PLAYER, not the shirt he wears. So a 90 综合 stuck at a rep3 西甲
 *     保级队 still draws rep9 豪门, never just the 保级 neighbours.
 *     "什么样的水平，什么样的俱乐部要。"
 *
 *  The window spreads offers across the player's ability tier (capped at the
 *  ceiling). 联赛放宽 (owner ask): the old confederation "agent filter" is
 *  retired — reputation matching (ceiling + the dirs/floor rep band) is the
 *  sole constraint, so every league at the player's level is reachable and
 *  the pool is no longer fixed to a handful of same-region leagues (足协 T5
 *  首窗不再只剩 AFC；CAF/CONMEBOL 小联盟也不再被锁死). A rep4 海港 star of
 *  rep4-LEVEL ability (≈72-78) attracts rep4-6 offers across ALL confederations
 *  (not just AFC + a UEFA stepping stone); the same club's 90 综合 star draws
 *  rep9 豪门 directly. The Big-5 path friction (SPRINGBOARD_BLOCK_PCT) still
 *  gates T4/T5 origins from jumping straight to the 五大联赛 — the 跳板
 *  narrative is preserved; the fame bid remains the late-career money move.
 *  Same seed + same choices still reproduces an identical career (pure function
 *  of the inputs). */
/** P-NATION 路径摩擦上下文: 出身国档位 + 是否已有欧洲履历 (现俱乐部或任一
 *  前俱乐部属 UEFA 联赛)。T1-T3 直接短路为「已通」——摩擦只作用于 T4/T5。 */
function pathFrictionOf(ctx: EventContext): { originTier: number; uefaExp: boolean } {
  const p = ctx.player;
  const originTier = youthTierOf(p.originNationalityId ?? p.nationalityId);
  if (originTier < 4) return { originTier, uefaExp: true };
  const inUefa = (clubId: string) => leagueById(clubById(clubId).leagueId).confederation === "UEFA";
  const uefaExp = leagueById(ctx.club.leagueId).confederation === "UEFA"
    || (ctx.formerClubIds ?? []).some(inUefa);
  return { originTier, uefaExp };
}

/** 五大联赛 (UEFA tier1 domRep≥4: 英超/西甲/意甲/德甲/法甲) — 路径摩擦的遮蔽对象。 */
const BIG5_LEAGUE_IDS: ReadonlySet<string> = new Set(
  LEAGUES.filter((l) => l.confederation === "UEFA" && l.tier === 1 && l.domRep >= 4).map((l) => l.id),
);

function generateClubOffers(player: Player, current: Club, rng: RngState, count: number, perfBoost = 0, friction?: { originTier: number; uefaExp: boolean }): ClubOffer[] {
  const curRep = current.rep;
  // P-NATION 路径摩擦: T4/T5 出身且无欧洲履历 → 每窗一次 roll,命中则本窗五大
  // 联赛俱乐部「没看见你」——报价自然落到跳板联赛 (葡超/荷甲/土超/奥甲/苏超…,
  // 它们不在遮蔽集里)。OVR>80 每点 −5% 递减:天才可跳级,概率不是墙。复现
  // 真实路径 J联赛→比利时/荷兰→五大 (research §6.3, CIES MR95/MR79)。
  const blockP = friction && !friction.uefaExp
    ? (SPRINGBOARD_BLOCK_PCT[friction.originTier] ?? 0) - 5 * Math.max(0, player.overall - 80)
    : 0;
  const big5Hidden = blockP > 0 && int(rng, 1, 100) <= blockP;
  const abilityTier = playerRepTierForOffers(player.overall);
  const isLocalStar = player.overall >= (SQUAD_BASE_BY_REP[curRep] ?? 52);
  const young = player.age <= 21;
  let ceiling = young && isLocalStar ? 9 : isLocalStar ? curRep + 2 : curRep;
  ceiling += perfBoost;
  ceiling = clamp(ceiling, 0, 9);
  // 能力是 visibility 的下限：球员 OVR 对应的主力档（abilityTier）+1，豪门按能力
  // 竞标，而非被 curRep+2 钉死。stepped progression 只约束"小俱乐部当明星的爬升
  // 节奏"，拦不住一个已打出身价的球员——90 综合在 rep3 保级队，rep8-9 豪门照样
  // 来，offer 不该只剩保级邻居。主力档+1 = 被高一档俱乐部留意（85→rep9 豪门视野、
  // 80→rep7 中上游留意），与"当主力档"统一成"能力→声望"的对应。
  // (涨薪预期 used to cap offers one tier lower here — measured on 400 careers
  // it was a BUFF: the lower ceiling steered careers away from the big-club
  // bench trap (min-of-three growth) and raw legacy went UP. The economic-tax
  // rung that followed was retired in the P-ASC-ECON rework (its slot is now
  // 情报封锁, blind odds); offers are ascension-free.)
  ceiling = clamp(Math.max(ceiling, abilityTier + 1), 0, 9);
  const tier = clamp(Math.min(abilityTier, ceiling), 0, 9);
  // full windows lead with the step-up offer; loan-sized windows stay lateral/down.
  const dirs = count >= 3 ? [1, 0, -1, -2, 2] : [0, -1, 1, -2, 2];
  const out: ClubOffer[] = [];
  const seen = new Set<string>([current.id]);
  const usedRep = new Set<number>();
  // 联赛放宽: 跨联盟转会不再受 agentAccepts 二次限制——声望匹配 (c.rep ≤
  // ceiling + dirs/floor 声望带) 是唯一约束，保证 60 综合新人只看到声望相称的
  // 俱乐部，但俱乐部可来自任何联盟，每个声望档的候选池从「同联盟+跳板」扩到
  // 「所有联盟」。五大联赛路径摩擦 (big5Hidden) 仍是 T4/T5 直跳五大的跳板闸。
  const ok = (c: Club) => c.rep <= ceiling
    && !(big5Hidden && BIG5_LEAGUE_IDS.has(c.leagueId));
  // 声望金字塔的顶端天然很窄 (rep9 只有 6 家、rep8 只有 7 家),精确档取样会让
  // 巅峰期每个转会窗都在同样十几家里打转——玩家能背出自己的转会路径 (owner
  // feedback「固定路径的转会模式」)。窄档 (候选 < OFFER_POOL_MIN) 向下借 1-2 档,
  // 按 4:2:1 加权先抽档、再在档内均匀抽队: 目标档仍占多数 (皇马级报价依旧是
  // 主流,爬到顶的爽点不被稀释),但约四成窗口换成同量级的另一批豪门,跨 seed
  // 的路径不再复读。中低档 (rep≤6) 本就有 33-121 家候选,走原精确档逻辑不受影响。
  const levelPool = (rep: number) =>
    CLUBS_POOL.filter((c) => c.id !== current.id && !seen.has(c.id) && c.rep === rep && ok(c));
  const BAND_WEIGHTS = [6, 2, 1];                  // 目标档 : 下一档 : 再下一档
  const pickForTier = (targetRep: number): Club | null => {
    const exact = levelPool(targetRep);
    if (exact.length >= OFFER_POOL_MIN) return exact[int(rng, 0, exact.length - 1)] ?? null;
    const levels = BAND_WEIGHTS
      .map((w, i) => ({ w, pool: targetRep - i >= 0 ? levelPool(targetRep - i) : [] }))
      .filter((l) => l.pool.length > 0);
    // 已经在最低档 (rep0 只有 16 家、rep1 66 家) 时无处可借,转而向上借一档——
    // 否则挣扎期的报价永远是同几家保级队 (梅州客家/FC安养 的复读)。向上借仍
    // 受 ok() 的 ceiling 约束,不会凭空塞进一个够不着的俱乐部。
    if (levels.reduce((s, l) => s + l.pool.length, 0) < OFFER_POOL_MIN) {
      const up = levelPool(targetRep + 1);
      if (up.length > 0) levels.push({ w: 2, pool: up });
    }
    if (levels.length === 0) return null;
    const total = levels.reduce((s, l) => s + l.w, 0);
    let roll = int(rng, 1, total);
    for (const l of levels) {
      roll -= l.w;
      if (roll <= 0) return l.pool[int(rng, 0, l.pool.length - 1)] ?? null;
    }
    return levels[0]!.pool[0] ?? null;
  };
  for (const d of dirs) {
    if (out.length >= count) break;
    const targetRep = clamp(tier + d, 0, 9);
    if (targetRep > ceiling) continue;            // never exceed the visibility ceiling
    if (usedRep.has(targetRep)) continue;          // one offer per tier — the spread is the point
    const pick = pickForTier(targetRep);
    if (!pick) continue;
    usedRep.add(targetRep);
    seen.add(pick.id);
    out.push({ club: pick });
  }
  // fill: prefer prestige-matched clubs (within ceiling + agent filter) over
  // under-offering, but NEVER break the match — a wrong offer is worse than fewer.
  // Floor the backfill at tier-2 (the spread's own low end) so a star's window
  // never gets a relegation minnow stuffed in — 90 综合的兜底补 offer 也不该是
  // 西甲保级队，全程落在能力相称的声望区间。
  if (out.length < count) {
    const floor = Math.max(0, tier - 2);
    const pool = CLUBS_POOL.filter((c) => c.id !== current.id && !seen.has(c.id) && ok(c) && c.rep >= floor);
    while (out.length < count && pool.length > 0) {
      const idx = int(rng, 0, pool.length - 1);
      const pick = pool.splice(idx, 1)[0]!;
      seen.add(pick.id);
      out.push({ club: pick });
    }
  }
  out.sort((a, b) => b.club.rep - a.club.rep);
  return out;
}

const CLUBS_POOL: readonly Club[] = CLUBS;

/** 一个声望档的候选俱乐部少于这个数就向下借档取样 (见 generateClubOffers)。
 *  14 ≈ 让顶端 rep9(6家)/rep8(7家) 借档、rep7(19家) 起自给自足。 */
const OFFER_POOL_MIN = 14;

/** 金元邀约头牌抽取范围 (按声望排序取前 N 家沙特队)。见 fameLeagueBidEvent。 */
const FAME_HEADLINE_POOL = 6;

/** Format a weekly wage (€K) — sub-1K wages show in euros, never "€0K". */
function fmtWage(wageK: number): string {
  if (wageK >= 1) return `€${Math.round(wageK)}K`;
  return `€${Math.max(100, Math.round(wageK * 1000 / 50) * 50)}`;
}

function playerRepTierForOffers(overall: number): number {
  if (overall >= 88) return 9;
  if (overall >= 85) return 8;
  if (overall >= 82) return 7;
  if (overall >= 79) return 6;
  if (overall >= 76) return 5;
  if (overall >= 72) return 4;
  if (overall >= 68) return 3;
  if (overall >= 63) return 2;
  if (overall >= 58) return 1;
  return 0;
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// ───────────────────────────── helpers ─────────────────────────────

/** Format a probability for display; `oracle` blessing shows one decimal place. */
function pct(x: number, blessings: readonly string[] = EMPTY_BLESS): string {
  const pctVal = blessings.includes("oracle")
    ? (Math.round(x * 1000) / 10)
    : Math.round(x * 100);
  return `${pctVal}%`;
}

/** 孤勇者 (ascension 7): forbids external-boost events — 季前特训 /
 *  私人教练 / 神秘金主. No one trains you, no one funds you; the climb is
 *  yours alone. */
function ascensionCanTrain(ascension: number): boolean {
  return ascension < 7;
}
