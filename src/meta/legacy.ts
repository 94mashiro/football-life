/**
 * Meta-progression — the roguelike's persistent layer that lives across runs.
 *
 * A run ends in permadeath but earns Legacy points, which unlock Blessings
 * (run-modifying perks, like Slay the Spire relics) and raise Ascension
 * (difficulty modifiers). This is what makes repeated runs deepen rather
 * than repeat: you trade earned currency for new build options.
 *
 * Stored in localStorage; versioned so a schema change never corrupts a save.
 */
import type { DevProfile, Position } from "../engine/data";
import { NATIONS } from "../engine/data";
import type { Trophy, Award, Challenge } from "../engine/types";
import { hash } from "../engine/rng";

// ───────────────────────────── legend drafts (P8: scripted starting scenarios) ─────────────────────────────
//
//预制传奇剧本：固定 seed + 预设 setup，代表一种戏剧化起点。补齐母本缺的
// legend-draft，给"想体验特定故事"的玩家一个入口，也是可分享的素材。
// seed 是精心挑选的固定字符串（非随机），保证每个剧本跑出确定的戏剧弧线。

export interface LegendDraft {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly seed: string;
  readonly position: Position;
  readonly nationalityId: string;
  readonly leagueId: string;
  readonly pace: "long" | "normal" | "express";
  /** Emoji tag for the card. */
  readonly icon: string;
}

export const LEGEND_DRAFTS: readonly LegendDraft[] = [
  { id: "ld_galactico", name: "银河青训", desc: "16 岁入皇马青训，背负天才之名。能否在巨星堆里杀出主力？",
    seed: "galaxy01", position: "CAM", nationalityId: "esp", leagueId: "laliga", pace: "normal", icon: "🌟" },
  { id: "ld_survivor", name: "保级求生", desc: "英超垫底队起步，每个赛季都是生死战。带队保级还是随队降级？",
    seed: "surviv1", position: "CB", nationalityId: "eng", leagueId: "premier-league", pace: "normal", icon: "🛡️" },
  { id: "ld_late_bloom", name: "大器晚成", desc: "中国中甲起步，25 岁才觉醒。能否逆龄成长，杀入欧洲豪门？",
    seed: "lateb01", position: "ST", nationalityId: "chn", leagueId: "china-league-one", pace: "long", icon: "🌅" },
  { id: "ld_rags", name: "草根逆袭", desc: "巴西弱旅起步，身无长物。从贫民窟到世界杯，你能走多远？",
    seed: "rags001", position: "LW", nationalityId: "bra", leagueId: "brasileirao-b", pace: "normal", icon: "⚽" },
  { id: "ld_keeper", name: "门将传奇", desc: "门将之路，一夫当关。从替补三门到金手套，守门员的孤独荣耀。",
    seed: "keeper1", position: "GK", nationalityId: "ita", leagueId: "serie-a", pace: "normal", icon: "🧤" },
  { id: "ld_wonderkid", name: "天才陨落", desc: "德甲天才少年，万众瞩目。顶住压力成星，还是重蹈伤仲永覆辙？",
    seed: "wundr01", position: "CAM", nationalityId: "ger", leagueId: "bundesliga", pace: "normal", icon: "💫" },
  { id: "ld_express", name: "速通狂人", desc: "三赛季一决策，飞速踢完一生。追求最高传承效率的极限挑战。",
    seed: "xprss01", position: "ST", nationalityId: "fra", leagueId: "ligue-1", pace: "express", icon: "⚡" },
  { id: "ld_saudi", name: "沙特淘金", desc: "巅峰期远赴沙特联赛，金钱与荣耀的抉择。是非不断，传奇难写。",
    seed: "saudi01", position: "ST", nationalityId: "arg", leagueId: "saudi-pro-league", pace: "normal", icon: "💰" },
];

export interface Blessing {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly cost: number;
}

export interface AscensionMod {
  readonly level: number;
  readonly name: string;
  readonly desc: string;
}

// ───────────────────────────── blessings ─────────────────────────────

export const BLESSINGS: readonly Blessing[] = [
  { id: "golden_boy", name: "金童", desc: "起始 OVR 53（而非 50），且初始年龄 16。", cost: 30 },
  { id: "iron_lungs", name: "铁肺", desc: "训练事件成功率 +15%。", cost: 25 },
  { id: "oracle", name: "先知之眼", desc: "所有事件概率显示精确到小数点后一位。", cost: 20 },
  { id: "loyal_club", name: "忠诚之心", desc: "留队时传承分 ×1.5。", cost: 25 },
  { id: "talisman", name: "护身符", desc: "生涯首次伤病概率减半。", cost: 30 },
  { id: "sharpshooter", name: "神射手", desc: "进球率 +20%。", cost: 40 },
  { id: "ironman", name: "铁人", desc: "伤病 OVR 扣减减半（向下取整）。", cost: 35 },
  { id: "marketable", name: "商业价值", desc: "所有传承分获取 +20%。", cost: 45 },
  { id: "comeback", name: "浴火重生", desc: "30 岁后每周期有一次机会回血 +1 OVR。", cost: 50 },
  // ── P2: build-defining blessings — change HOW you play, not just numbers ──
  { id: "glass_cannon", name: "玻璃大炮", desc: "成长 +50%，但伤病概率 ×3。高风险高回报的成长流。", cost: 45 },
  { id: "mercenary", name: "雇佣兵", desc: "每次转会额外 +2 OVR，但留队不再获得传承加成。频繁跳槽换实力。", cost: 40 },
  { id: "big_game_player", name: "大赛型选手", desc: "Boss 事件好结局概率 +20%，普通概率事件 −10%。为决战而生。", cost: 45 },
  { id: "late_bloomer", name: "大器晚成", desc: "25 岁前成长减半，25 岁后成长 +50%。慢热但后劲十足。", cost: 35 },
];

export function blessingById(id: string): Blessing | undefined {
  return BLESSINGS.find((b) => b.id === id);
}

// ───────────────────────────── ascension ─────────────────────────────

export const ASCENSIONS: readonly AscensionMod[] = [
  { level: 1, name: "从严", desc: "成长 delta 取值偏向区间下限（更难成长）。" },
  { level: 2, name: "伤病潮", desc: "伤病概率 2% → 3%。" },
  { level: 3, name: "涨薪预期", desc: "转会 offer 档位 −1。" },
  { level: 4, name: "岁月催人", desc: "衰退从 28 岁提前到 26 岁开始。" },
  { level: 5, name: "诸神黄昏", desc: "世界杯夺冠概率 −30%。" },
  { level: 6, name: "天命难违", desc: "所有事件好结局概率 −10%。" },
  { level: 7, name: "孤勇者", desc: "无法接受私人教练/特训类增益事件。" },
  // ── P9: rule-changing ascensions — new rules, not just bigger penalties ──
  { level: 8, name: "转会冻结", desc: "转会窗口每 3 个周期才开一次（攀爬变难）。" },
  { level: 9, name: "国家队退役", desc: "无法被国家队征召（失去所有国家队荣誉路径）。" },
  { level: 10, name: "全面降级", desc: "所有联赛实力视作 −1 档（弱旅地狱）。" },
];

/** P9: ascension unlock gates — StS-style "win to climb". Each level requires a
 *  minimum bestRun legacy to unlock, so the player climbs the ladder by
 *  actually beating the prior difficulty, not just selecting it. */
export const ASCENSION_UNLOCK_REQ: readonly number[] = [
  0,    // 0
  80,   // 1
  150,  // 2
  220,  // 3
  300,  // 4
  400,  // 5
  520,  // 6
  650,  // 7
  800,  // 8
  1000, // 9
  1300, // 10
];

/** Highest ascension the player has unlocked (bestRun-gated). */
export function maxAscensionUnlocked(meta: MetaSave): number {
  let max = 0;
  for (let lvl = 0; lvl < ASCENSION_UNLOCK_REQ.length; lvl++) {
    if (meta.bestRun >= ASCENSION_UNLOCK_REQ[lvl]!) max = lvl;
    else break;
  }
  return max;
}

// ───────────────────────────── legacy scoring ─────────────────────────────

const TROPHY_LEGACY: Record<Trophy, number> = {
  league: 10,
  cup: 5,
  continental_primary: 30,
  continental_secondary: 15,
  club_world_cup: 40,
  national_continental: 35,
  world_cup: 120,
};

const AWARD_LEGACY: Record<Award, number> = {
  ballon_dor: 50,
  golden_boot: 25,
  golden_glove: 25,
};

export function scoreLegacy(
  maxOverall: number,
  seasons: number,
  trophies: readonly Trophy[],
  awards: readonly Award[],
  ascension: number,
  retireReason: string | null,
  challenge?: Challenge,
  careerWageTotal?: number,
  finalMarketValue?: number,
): number {
  let total = maxOverall; // base from peak ability
  total += seasons;       // longevity
  for (const t of trophies) total += TROPHY_LEGACY[t] ?? 0;
  for (const a of awards) total += AWARD_LEGACY[a] ?? 0;
  // P-A17: career earnings — total wages (€K) and final market value (€M)
  // both feed into legacy, so a lucrative career (big leagues, big wages) adds
  // to the score — the financial dimension the user asked for. Scaled so it's
  // a meaningful but not dominant contributor (~10-15% of a top score).
  if (careerWageTotal) total += Math.round(careerWageTotal / 200); // €200K wage ≈ 1 legacy
  if (finalMarketValue) total += Math.round(finalMarketValue * 2); // €1M final value ≈ 2 legacy
  // ascension multiplier: harder = more rewarding
  total = Math.round(total * (1 + ascension * 0.15));
  // a career crowned by a World Cup title is legendary — ×1.5 (was keyed off a
  // retireReason value that was never set; use the trophy list instead).
  if (trophies.includes("world_cup")) total = Math.round(total * 1.5);
  // P3: redemption challenge — if the player carried a near-miss goal into this
  // run and achieved it, apply the bonus multiplier.
  if (challenge && challengeSucceeded(challenge, { trophies, awards, maxOverall, seasons })) {
    total = Math.round(total * challenge.legacyMult);
  }
  void retireReason;
  return total;
}

export function legacyRank(score: number): { name: string; color: string } {
  if (score >= 800) return { name: "球神", color: "#b8ff3d" };
  if (score >= 500) return { name: "传奇", color: "#4dd0c0" };
  if (score >= 300) return { name: "巨星", color: "#7ec8ff" };
  if (score >= 150) return { name: "明星", color: "#ffb454" };
  if (score >= 60) return { name: "球员", color: "#d0d0d0" };
  return { name: "替补", color: "#7e8b85" };
}

/** P-A128: letter grade for career — S/A/B/C/D, a more intuitive "how good was this" */
export function careerGrade(score: number): { grade: string; color: string } {
  if (score >= 800) return { grade: "S", color: "#b8ff3d" };
  if (score >= 500) return { grade: "A", color: "#4dd0c0" };
  if (score >= 300) return { grade: "B", color: "#7ec8ff" };
  if (score >= 150) return { grade: "C", color: "#ffb454" };
  if (score >= 60) return { grade: "D", color: "#d0d0d0" };
  return { grade: "F", color: "#7e8b85" };
}

// ───────────────────────────── unlock gates ─────────────────────────────

/** Unlocks gated by total legacy earned across all runs. */
export interface Unlock {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly reqLegacy: number;
  readonly kind: "blessing" | "nation" | "profile";
}

/** Nations selectable from the first run; every other nation is a legacy unlock. */
export const FREE_NATIONS: readonly string[] = ["bra", "arg", "fra", "eng", "esp", "ger", "ita", "por", "ned", "bel", "chn"];

// jpn/usa keep their original hand-tuned costs — players may already sit past them.
const NATION_REQ_OVERRIDES: Record<string, number> = { jpn: 50, usa: 80 };

// Cost scales with national-team strength: stronger stage → pricier unlock.
// Range works out to 30 (idn/fij) – 180 (uru), under the 200 blessing cap.
const NATION_UNLOCKS: Unlock[] = NATIONS
  .filter((n) => !FREE_NATIONS.includes(n.id))
  .map((n) => ({
    id: `nation:${n.id}`, name: n.name, desc: "可选国籍解锁。", kind: "nation" as const,
    reqLegacy: NATION_REQ_OVERRIDES[n.id] ?? 30 + 10 * (n.contRep + 2 * n.fifaRep + n.intlRep),
  }));

export const UNLOCKS: readonly Unlock[] = [
  ...NATION_UNLOCKS,
  { id: "profile:wonderkid", name: "天才档", desc: "可选成长档位解锁。", reqLegacy: 100, kind: "profile" },
  { id: "blessing:sharpshooter", name: "神射手", desc: "祝福解锁。", reqLegacy: 150, kind: "blessing" },
  { id: "blessing:comeback", name: "浴火重生", desc: "祝福解锁。", reqLegacy: 200, kind: "blessing" },
];

// ───────────────────────────── redemption challenges (P3: near-miss → next-run goal) ─────────────────────────────
//
// The strongest "one more run" driver is the near-miss: you almost did the
// thing. The summary screen surfaces the run's defining near-miss as an
// explicit CHALLENGE the player can carry into the next run for a legacy
// bonus. This converts "I came up short" into "next time I will" — the
// redemption pull that restarts the loop.

/** Catalog of redeemable challenges. Each has a detection predicate (did the
 *  just-finished run achieve it?) and a legacy multiplier reward. */
export interface ChallengeDef {
  readonly id: string;
  readonly label: string;        // "捧起世界杯"
  readonly hint: string;         // short why-it-matters line for the summary card
  readonly legacyMult: number;   // 1.3 = +30% legacy on success
  /** Did the just-finished run achieve this? (used both to detect a prior
   *  challenge success AND to decide which challenges to OFFER next time —
   *  we offer the near-misses the player just fell short of.) */
  achieved: (g: { trophies: readonly Trophy[]; awards: readonly Award[]; maxOverall: number; seasons: number }) => boolean;
}

export const CHALLENGES: readonly ChallengeDef[] = [
  { id: "ch_world_cup", label: "捧起世界杯", hint: "足球的终极荣耀。", legacyMult: 1.5,
    achieved: (g) => g.trophies.includes("world_cup") },
  { id: "ch_ballon_dor", label: "加冕金球奖", hint: "成为世界最佳。", legacyMult: 1.4,
    achieved: (g) => g.awards.includes("ballon_dor") },
  { id: "ch_continental", label: "赢下洲际冠军", hint: "欧冠/解放者杯/亚冠。", legacyMult: 1.3,
    achieved: (g) => g.trophies.includes("continental_primary") || g.trophies.includes("continental_secondary") },
  { id: "ch_peak90", label: "巅峰突破 90", hint: "跻身历史级。", legacyMult: 1.3,
    achieved: (g) => g.maxOverall >= 90 },
  { id: "ch_first_trophy", label: "拿下生涯首冠", hint: "从零到一。", legacyMult: 1.25,
    achieved: (g) => g.trophies.length > 0 },
  { id: "ch_golden_boot", label: "夺得金靴", hint: "赛季最强射手。", legacyMult: 1.3,
    achieved: (g) => g.awards.includes("golden_boot") },
];

export function challengeById(id: string): ChallengeDef | undefined {
  return CHALLENGES.find((c) => c.id === id);
}

/** Detect whether a just-finished run satisfied its carried challenge. */
export function challengeSucceeded(challenge: Challenge | undefined, g: { trophies: readonly Trophy[]; awards: readonly Award[]; maxOverall: number; seasons: number }): boolean {
  if (!challenge) return false;
  return challengeById(challenge.id)?.achieved(g) ?? false;
}

/** Pick up to 3 near-miss challenges to OFFER at the summary screen — the
 *  defining moments the player just fell short of. Excludes already-achieved
 *  ones (no point redeeming what you just did) and respects a sensible order. */
export function nearMissChallenges(g: { trophies: readonly Trophy[]; awards: readonly Award[]; maxOverall: number; seasons: number }): readonly ChallengeDef[] {
  const misses = CHALLENGES.filter((c) => !c.achieved(g));
  // order by reward desc so the juiciest near-miss surfaces first
  const sorted = [...misses].sort((a, b) => b.legacyMult - a.legacyMult);
  return sorted.slice(0, 3);
}

/** Build a Challenge (for RunSetup) from a ChallengeDef id. */
export function makeChallenge(id: string): Challenge | undefined {
  const def = challengeById(id);
  if (!def) return undefined;
  return { id: def.id, label: def.label, legacyMult: def.legacyMult };
}

// ───────────────────────────── hall of fame (P6: completionist collection) ─────────────────────────────
//
// A persistent collection that tracks every trophy type and achievement the
// player has EVER earned across all runs. Completionists chase a full wall —
// this gives them the museum the bare archive list wasn't. Achievements are
// rare/career-defining feats (treble, 3-peat golden boot, etc.) that surface as
// grayed-out placeholders until first earned, the "gotta catch 'em all" pull.

export interface AchievementDef {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  /** Detect from a finished run's full state. */
  achieved: (g: { trophies: readonly Trophy[]; awards: readonly Award[]; maxOverall: number; seasons: number }) => boolean;
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: "ah_world_cup", name: "世界之巅", desc: "赢得一次世界杯。", achieved: (g) => g.trophies.includes("world_cup") },
  { id: "ah_ballon_dor", name: "世界最佳", desc: "赢得一次金球奖。", achieved: (g) => g.awards.includes("ballon_dor") },
  { id: "ah_treble", name: "三冠王", desc: "单赛季联赛 + 杯赛 + 洲际冠军。", achieved: (g) => g.trophies.includes("league") && g.trophies.includes("cup") && g.trophies.includes("continental_primary") },
  { id: "ah_peak90", name: "历史级", desc: "巅峰 OVR 达到 90。", achieved: (g) => g.maxOverall >= 90 },
  { id: "ah_peak95", name: "殿堂级", desc: "巅峰 OVR 达到 95。", achieved: (g) => g.maxOverall >= 95 },
  { id: "ah_longevity", name: "常青", desc: "踢满 22 个赛季（到 38 岁仍不退役）。", achieved: (g) => g.seasons >= 22 },
  { id: "ah_golden_boot", name: "金靴射手", desc: "赢得一次金靴。", achieved: (g) => g.awards.includes("golden_boot") },
  { id: "ah_golden_glove", name: "金手套", desc: "赢得一次金手套（门将）。", achieved: (g) => g.awards.includes("golden_glove") },
  { id: "ah_continental_master", name: "洲际大师", desc: "赢下两种洲际冠军（欧冠 + 欧联 等）。", achieved: (g) => g.trophies.includes("continental_primary") && g.trophies.includes("continental_secondary") },
  { id: "ah_cwc", name: "世界俱乐部之巅", desc: "赢得一次世俱杯。", achieved: (g) => g.trophies.includes("club_world_cup") },
  { id: "ah_national_hero", name: "国家英雄", desc: "赢得一次洲际国家队冠军（欧洲杯/美洲杯等）。", achieved: (g) => g.trophies.includes("national_continental") },
  { id: "ah_ironman", name: "铁人", desc: "整生涯 0 伤病完成（暂以 ≥20 赛季近似）。", achieved: (g) => g.seasons >= 20 },
];

/** All trophy types that can be collected (for the trophy wall progress). */
export const ALL_TROPHY_IDS: readonly string[] = [
  "league", "cup", "continental_primary", "continental_secondary",
  "club_world_cup", "national_continental", "world_cup",
];

/** Merge a finished run's trophies + achievements into the persistent
 *  collection. Returns the new save. */
export function mergeCollection(
  meta: MetaSave,
  g: { trophies: readonly Trophy[]; awards: readonly Award[]; maxOverall: number; seasons: number },
): MetaSave {
  const newTrophies = g.trophies.filter((t) => !meta.trophyCollection.includes(t));
  const trophyCollection = newTrophies.length > 0 ? [...meta.trophyCollection, ...newTrophies] : meta.trophyCollection;
  const earnedAch = ACHIEVEMENTS.filter((a) => a.achieved(g)).map((a) => a.id);
  const newAch = earnedAch.filter((a) => !meta.achievementCollection.includes(a));
  const achievementCollection = newAch.length > 0 ? [...meta.achievementCollection, ...newAch] : meta.achievementCollection;
  if (newTrophies.length === 0 && newAch.length === 0) return meta;
  return { ...meta, trophyCollection, achievementCollection };
}

/** Trophies newly collected this run (for a "new!" highlight on the summary). */
export function newlyCollectedTrophies(meta: MetaSave, trophies: readonly Trophy[]): readonly Trophy[] {
  return trophies.filter((t) => !meta.trophyCollection.includes(t));
}
export function newlyCollectedAchievements(meta: MetaSave, g: { trophies: readonly Trophy[]; awards: readonly Award[]; maxOverall: number; seasons: number }): readonly AchievementDef[] {
  return ACHIEVEMENTS.filter((a) => a.achieved(g) && !meta.achievementCollection.includes(a.id));
}
//
// The meta layer's fatal flaw: a focused player buys out all 9 blessings
// (~300 legacy) and all unlocks (max 200 reqLegacy) within 10-20 runs, after
// which legacy is a meaningless number and there is no reason to start another
// run. Prestige fixes this with an infinite "reset-for-permanent-power" loop
// (the Dead Cells / roguelite prestige model): once you own everything, you
// may sacrifice all blessings + spendable legacy to pick ONE permanent perk
// that persists across ALL future runs and stacks with every prior prestige.
// The perks make the next grind faster/stronger, and there are always more
// perks to earn — so "buy空" becomes "buy空才开始".

export interface PrestigePerk {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
}

export const PRESTIGE_PERKS: readonly PrestigePerk[] = [
  { id: "pp_prodigy",       name: "天选之子",   desc: "永久：起始 OVR +2（与金童叠加）。" },
  { id: "pp_longevity",     name: "常青树",     desc: "永久：衰退延迟 1 年。" },
  { id: "pp_legacy_magnet", name: "传承磁体",   desc: "永久：所有传承分获取 +10%（与商业价值叠加）。" },
  { id: "pp_iron_will",     name: "钢铁意志",   desc: "永久：每局首次伤病不扣 OVR。" },
  { id: "pp_transfer_savvy",name: "转会嗅觉",   desc: "永久：每次转会 +1 OVR。" },
  { id: "pp_comeback_base", name: "涅槃基线",   desc: "永久：30 岁后每周期 25% 回血 +1（无需浴火重生祝福）。" },
  { id: "pp_oracle_base",   name: "洞察基线",   desc: "永久：事件概率精确到一位小数（无需先知之眼祝福）。" },
  { id: "pp_scout",         name: "青训球探",   desc: "永久：起始俱乐部实力 +1 档（不超顶级）。" },
  { id: "pp_boss_slayer",   name: "弑神者",     desc: "永久：Boss 事件好结局概率 +10%。" },
];

export function prestigePerkById(id: string): PrestigePerk | undefined {
  return PRESTIGE_PERKS.find((p) => p.id === id);
}

/** Prestige unlocks once the player owns every blessing AND has banked enough
 *  legacy to make the sacrifice meaningful. The threshold sits just above the
 *  total cost of all blessings so "buy everything, then prestige" is the path. */
export const PRESTIGE_LEGACY_THRESHOLD = 500;
export function prestigeEligible(meta: MetaSave): boolean {
  return meta.ownedBlessings.length >= BLESSINGS.length
    && meta.totalLegacy >= PRESTIGE_LEGACY_THRESHOLD;
}

/** Roll 3 permanent perks the player does not yet own (the pick-1-of-3 choice).
 *  If fewer than 3 remain, returns all remaining (the loop is winding down but
 *  still yields a pick). Uses Math.random — meta-layer only, never the sim. */
export function prestigeChoices(meta: MetaSave): readonly PrestigePerk[] {
  const remaining = PRESTIGE_PERKS.filter((p) => !meta.permPerks.includes(p.id));
  if (remaining.length <= 3) return remaining;
  // shuffle a copy, take 3
  const pool = [...remaining];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, 3);
}

/** Apply a prestige: sacrifice all blessings + spendable legacy, gain the
 *  chosen permanent perk. Unlocks (nations/profiles) are keyed to
 *  totalLegacyAllTime so they never re-lock. Returns the new save, or null if
 *  the perk is already owned / prestige is not eligible. */
export function applyPrestige(meta: MetaSave, perkId: string): MetaSave | null {
  if (!prestigeEligible(meta)) return null;
  if (meta.permPerks.includes(perkId)) return null;
  return {
    ...meta,
    totalLegacy: 0,             // spendable currency sacrificed
    ownedBlessings: [],          // must re-earn blessings
    prestige: meta.prestige + 1,
    permPerks: [...meta.permPerks, perkId],
  };
}

// ───────────────────────────── persistent save ─────────────────────────────

export interface MetaSave {
  readonly version: number;
  /** Spendable currency (resets to 0 on prestige). Drives blessing purchases. */
  totalLegacy: number;
  /** Lifetime legacy, never resets. Drives unlock gates so prestige never
   *  re-locks nations/profiles the player already earned. */
  totalLegacyAllTime: number;
  unlocked: readonly string[];
  ownedBlessings: readonly string[];   // purchased blessings available for runs
  bestRun: number;
  ascension: number;
  runs: number;
  /** Prestige count (how many permanent perks earned). */
  prestige: number;
  /** Permanent perks owned (stack across runs, never lost). */
  permPerks: readonly string[];
  /** P6: trophy collection — every trophy type ever won across all runs. */
  trophyCollection: readonly string[];
  /** P6: achievement collection — achievements ever earned. */
  achievementCollection: readonly string[];
  /** P-A6: purist mode — hides visible odds for hardcore tension. Default false. */
  puristMode?: boolean;
  /** P-A9: sound effects on/off. Default true. */
  soundOn?: boolean;
}

const META_KEY = "pitch-reincarnation:meta:v1";
const VERSION = 2;

export function defaultMeta(): MetaSave {
  return {
    version: VERSION, totalLegacy: 0, totalLegacyAllTime: 0, unlocked: [],
    ownedBlessings: [], bestRun: 0, ascension: 0, runs: 0, prestige: 0, permPerks: [],
    trophyCollection: [], achievementCollection: [],
  };
}

/** Migrate a v1 save (prestige-less) into the v2 shape without wiping progress. */
function migrateV1(raw: Record<string, unknown>): MetaSave {
  return {
    version: VERSION,
    totalLegacy: (raw.totalLegacy as number) ?? 0,
    // v1 had no all-time counter; seed it from the v1 total so old unlocks stick.
    totalLegacyAllTime: (raw.totalLegacy as number) ?? 0,
    unlocked: (raw.unlocked as string[]) ?? [],
    ownedBlessings: (raw.ownedBlessings as string[]) ?? [],
    bestRun: (raw.bestRun as number) ?? 0,
    ascension: (raw.ascension as number) ?? 0,
    runs: (raw.runs as number) ?? 0,
    prestige: 0,
    permPerks: [],
    trophyCollection: [],
    achievementCollection: [],
  };
}

export function loadMeta(): MetaSave {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return defaultMeta();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version === VERSION) return parsed as unknown as MetaSave;
    if (parsed.version === 1) return migrateV1(parsed);
    return defaultMeta();
  } catch {
    return defaultMeta();
  }
}

export function saveMeta(meta: MetaSave): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    // storage may be unavailable (private mode); fail silently
  }
}

/** Apply a finished run's legacy to the persistent save, returning the new save. */
export function applyRunResult(meta: MetaSave, runLegacy: number): MetaSave {
  const totalLegacy = meta.totalLegacy + runLegacy;
  const totalLegacyAllTime = meta.totalLegacyAllTime + runLegacy;
  const bestRun = Math.max(meta.bestRun, runLegacy);
  const runs = meta.runs + 1;
  // unlock anything newly reached — gated on lifetime legacy so prestige never re-locks.
  const newlyUnlocked = UNLOCKS.filter((u) => !meta.unlocked.includes(u.id) && totalLegacyAllTime >= u.reqLegacy).map((u) => u.id);
  const unlocked = [...meta.unlocked, ...newlyUnlocked];
  return { ...meta, totalLegacy, totalLegacyAllTime, bestRun, runs, unlocked };
}

export function purchaseBlessing(meta: MetaSave, blessingId: string): MetaSave | null {
  const b = blessingById(blessingId);
  if (!b) return null;
  if (meta.ownedBlessings.includes(blessingId)) return null;
  if (meta.totalLegacy < b.cost) return null;
  return {
    ...meta,
    totalLegacy: meta.totalLegacy - b.cost,
    ownedBlessings: [...meta.ownedBlessings, blessingId],
  };
}

// ───────────────────────────── career archive (母本 archive:v1) ─────────────────────────────
// A localStorage list of finished careers so the player can browse past runs
// from the menu ("从首页就能翻回过去任意一局的战绩卡") — a retention hook.

export interface CareerArchiveEntry {
  readonly seed: string;
  readonly name: string;
  readonly position: string;
  readonly nationalityId: string;
  readonly legacy: number;
  readonly maxOverall: number;
  readonly seasons: number;
  readonly trophies: number;
  readonly awards: number;
  readonly rank: string;
  readonly reason: string;
}

const ARCHIVE_KEY = "pitch-reincarnation:archive:v1";
const ARCHIVE_MAX = 30;

export function loadArchive(): readonly CareerArchiveEntry[] {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as CareerArchiveEntry[];
  } catch {
    return [];
  }
}

export function saveArchiveEntry(entry: CareerArchiveEntry): readonly CareerArchiveEntry[] {
  const existing = loadArchive();
  const next = [entry, ...existing].slice(0, ARCHIVE_MAX);
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable; fail silently
  }
  return next;
}

export function clearArchive(): void {
  try {
    localStorage.removeItem(ARCHIVE_KEY);
  } catch {
    // noop
  }
}

export function isUnlocked(meta: MetaSave, id: string): boolean {
  return meta.unlocked.includes(id) || meta.totalLegacyAllTime >= (UNLOCKS.find((u) => u.id === id)?.reqLegacy ?? Infinity);
}

// ───────────────────────────── seed helpers ─────────────────────────────

/** Generate a random shareable seed string (base36, 8 chars). */
export function randomSeed(): string {
  // Math.random is fine here — only used for NEW run seed generation, never
  // for sim outcomes (those use the deterministic engine from the seed).
  let s = "";
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

/**
 * Deterministic "seed of the day" — same date string → same seed for everyone,
 * so a daily challenge is shareable. The date string is computed in the UI
 * (engine has no Date access); we just hash it to a stable base36 seed.
 */
export function dailySeed(dateStr: string): string {
  const h = hash(`daily:${dateStr}`);
  // spread the 32-bit hash into an 8-char base36 string
  let s = "";
  let n = h;
  for (let i = 0; i < 8; i++) {
    s += (n % 36).toString(36);
    n = Math.floor(n / 36) || ((n * 2654435761) >>> 0);
  }
  return s;
}

/** Deterministic daily-challenge setup (P4): the date fixes the position,
 *  nationality, and league so everyone plays the SAME career today. Derived
 *  from the date hash (not the seed hash, so the seed alone stays free-form). */
export interface DailySetup {
  readonly position: Position;
  readonly nationalityId: string;
  readonly leagueId: string;
}
const DAILY_POSITIONS: readonly Position[] = ["ST", "LW", "CAM", "CM", "CB", "GK"];
const DAILY_NATIONS = ["bra", "arg", "fra", "eng", "esp", "ger", "ita", "por", "ned", "bel", "chn", "jpn"];
const DAILY_LEAGUES = ["premier-league", "laliga", "serie-a", "bundesliga", "ligue-1", "brasileirao", "csl", "j1-league"];

export function dailySetup(dateStr: string): DailySetup {
  const pos = DAILY_POSITIONS[hash(`daily-pos:${dateStr}`) % DAILY_POSITIONS.length]!;
  const nationalityId = DAILY_NATIONS[hash(`daily-nat:${dateStr}`) % DAILY_NATIONS.length]!;
  const leagueId = DAILY_LEAGUES[hash(`daily-league:${dateStr}`) % DAILY_LEAGUES.length]!;
  return { position: pos, nationalityId, leagueId };
}

// ───────────────────────────── daily leaderboard (P4) ─────────────────────────────
// A local-only record of the player's daily-challenge results, so they can
// track their streak and compare with friends via shared cards. No backend.

export interface DailyResult {
  readonly date: string;
  readonly seed: string;
  readonly legacy: number;
  readonly rank: string;
  readonly maxOverall: number;
  readonly seasons: number;
  readonly trophies: number;
}

const DAILY_KEY = "pitch-reincarnation:daily:v1";
const DAILY_MAX = 60;

export function loadDailyResults(): readonly DailyResult[] {
  try {
    const raw = localStorage.getItem(DAILY_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as DailyResult[];
  } catch {
    return [];
  }
}

export function saveDailyResult(entry: DailyResult): readonly DailyResult[] {
  const existing = loadDailyResults();
  // replace any prior entry for the same date (best attempt sticks only if higher)
  const prior = existing.find((e) => e.date === entry.date);
  if (prior && prior.legacy >= entry.legacy) return existing; // keep best
  const next = [entry, ...existing.filter((e) => e.date !== entry.date)].slice(0, DAILY_MAX);
  try {
    localStorage.setItem(DAILY_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable; fail silently
  }
  return next;
}

/** Today's date as YYYY-MM-DD (the UI's only Date access point). */
export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────
// Daily login bonus (P-A121: DAU driver — give players a reason to return)
// ─────────────────────────────────────────────────────────────────

export interface LoginBonus {
  readonly lastLoginDate: string;
  readonly consecutiveDays: number;
  readonly totalLogins: number;
  readonly bonusLegacy: number;  // legacy claimed today (0 if not yet)
}

const LOGIN_KEY = "pitch-reincarnation:login:v1";

function defaultLogin(): LoginBonus {
  return { lastLoginDate: "", consecutiveDays: 0, totalLogins: 0, bonusLegacy: 0 };
}

export function loadLoginBonus(): LoginBonus {
  try {
    const raw = localStorage.getItem(LOGIN_KEY);
    if (!raw) return defaultLogin();
    return JSON.parse(raw) as LoginBonus;
  } catch { return defaultLogin(); }
}

/** Called on app load. Returns updated bonus and whether today's bonus is claimable. */
export function checkDailyLogin(prev: LoginBonus): { bonus: LoginBonus; claimable: boolean; amount: number } {
  const today = todayStr();
  if (prev.lastLoginDate === today) {
    return { bonus: prev, claimable: false, amount: 0 };
  }
  // check consecutive
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);
  const consecutive = prev.lastLoginDate === yStr ? prev.consecutiveDays + 1 : 1;
  // bonus = max(3, consecutiveDays) capped at 30
  const amount = Math.min(30, Math.max(3, consecutive));
  const bonus: LoginBonus = {
    lastLoginDate: today,
    consecutiveDays: consecutive,
    totalLogins: prev.totalLogins + 1,
    bonusLegacy: amount,
  };
  try { localStorage.setItem(LOGIN_KEY, JSON.stringify(bonus)); } catch { /* noop */ }
  return { bonus, claimable: true, amount };
}

/** Apply the daily bonus to meta (spendable legacy). */
export function applyLoginBonus(meta: MetaSave, amount: number): MetaSave {
  return { ...meta, totalLegacy: meta.totalLegacy + amount };
}

/** Count consecutive days (ending today or yesterday) with a recorded result. */
export function dailyStreak(results: readonly DailyResult[]): number {
  if (results.length === 0) return 0;
  const dates = new Set(results.map((r) => r.date));
  let streak = 0;
  // walk back from today; a gap of 1 day (yesterday missing but today present)
  // still counts the run up to the gap.
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    if (dates.has(ds)) streak++;
    else if (i === 0) continue; // today not yet played is fine
    else break;
  }
  return streak;
}

/** Pick the player's dev profile from the seed (goalkeepers forced to normal). */
export function rollDevProfile(seed: string, isGK: boolean, allowWonderkid: boolean): DevProfile {
  if (isGK) return "normal";
  // thresholds: 18% early, 33% late, 39% wonderkid (if unlocked), else normal
  const v = hash(`${seed}:development-profile`) / 4294967296;
  if (v < 0.18) return "early";
  if (v < 0.51) return "late";
  if (allowWonderkid && v < 0.9) return "wonderkid";
  return "normal";
}

/** Default starting position list (some locked until unlocks). */
export function startingPositions(): readonly Position[] {
  return ["GK", "CB", "LB", "RB", "CDM", "CM", "LM", "RM", "CAM", "LW", "RW", "ST"];
}
