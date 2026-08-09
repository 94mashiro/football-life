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
import { leagueById, clubById, nationById, NATIONS } from "../engine/data";
import type { Trophy, Award, Challenge, GameState } from "../engine/types";
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
// 定价基线: 一局生涯的中位传承 ≈ 300（tools/legacy-dist.ts 实测，无祝福/飞升0/
// normal/随机选择；难度曲线重调后从 266 升至 ~306——更高巅峰带更多奖杯/工资
// /荣誉，祝福与飞升门槛随之略微更易负担，与「不压抑积极性」意图一致）。设计目标——最弱祝福 ≈ 10 局传承可购，最强 ≈ 50 局，故以
// 300/局为锚定刻度铺一条 10→50 局的价格阶梯。祝福是长期攒局的里程碑，不是
// 每局都能买的日抛品。代价：集齐 13 个祝福 ≈ 286 局（见 PRESTIGE 注释）。

export const BLESSINGS: readonly Blessing[] = [
  { id: "golden_boy", name: "金童", desc: "起始 OVR 58（而非 50）。天才少年，一出道即主力级。", cost: 8000 },
  { id: "iron_lungs", name: "铁肺", desc: "训练事件成功概率 +25%，体能续航出场更多、生涯更久。", cost: 3300 },
  { id: "oracle", name: "先知之眼", desc: "成功概率显示到小数点后一位。", cost: 3000 },
  { id: "loyal_club", name: "忠诚之心", desc: "一人一城：连续效力同一俱乐部 8 赛季以上，传承 +1.5%/季（最高 +18%）。", cost: 4500 },
  { id: "talisman", name: "护身符", desc: "生涯首次伤病概率降至四成。", cost: 3600 },
  { id: "sharpshooter", name: "神射手", desc: "进球率 +35%。生涯进球传承 +0.1%/球（最高 +18%）。", cost: 12000 },
  { id: "ironman", name: "铁人", desc: "伤病概率 −20%，OVR 损失减半（轻微伤病不扣）。30 岁后传承 +1%/季（最高 +8%）。", cost: 4000 },
  { id: "marketable", name: "商业价值", desc: "所有传承分获取 +10%。", cost: 9000 },
  { id: "comeback", name: "浴火重生", desc: "30 岁后每次决策 25% 概率回血 +1 OVR。33 岁后传承 +2%/季（最高 +12%）。", cost: 15000 },
  // ── P2: build-defining blessings — change HOW you play, not just numbers ──
  { id: "glass_cannon", name: "玻璃大炮", desc: "成长 +50%，但伤病概率 ×3。高风险高回报的成长流。", cost: 7000 },
  { id: "mercenary", name: "雇佣兵", desc: "每次转会额外 +1 OVR，但无法成为俱乐部传奇（与忠诚之心互斥）。频繁跳槽换实力。", cost: 5500 },
  { id: "big_game_player", name: "大赛型选手", desc: "决战事件（世界杯对决、决胜点球）成功概率 +10%，普通事件 −10%。为大场面而生。", cost: 6000 },
  { id: "late_bloomer", name: "大器晚成", desc: "25 岁前成长略缓，25 岁后成长翻倍。慢热但后劲十足。", cost: 5000 },
];

export function blessingById(id: string): Blessing | undefined {
  return BLESSINGS.find((b) => b.id === id);
}

/** Mechanics review: blessings are a LOADOUT, not a passive stack. A run
 *  equips at most MAX_LOADOUT owned blessings — so build-defining blessings
 *  (玻璃大炮's ×3 injuries, 雇佣兵's no-loyalty) are a per-run CHOICE, not a
 *  permanent debt attached to every future run the moment they're bought.
 *  (The research branch built the same 装备制 on localStorage; master's
 *  meta-save version won — one implementation, not two.) */
export const MAX_LOADOUT = 3;

/** The blessings active for the next run: the explicit loadout if set, else
 *  the first MAX_LOADOUT owned (older saves keep continuity, visibly editable). */
export function resolveLoadout(meta: MetaSave): readonly string[] {
  const base = meta.loadout ?? meta.ownedBlessings;
  return base.filter((b) => meta.ownedBlessings.includes(b)).slice(0, MAX_LOADOUT);
}

// ───────────────────────────── ascension ─────────────────────────────

export const ASCENSIONS: readonly AscensionMod[] = [
  { level: 1, name: "从严", desc: "成长判定取两次中的较低值，更难成长。" },
  { level: 2, name: "伤病潮", desc: "伤病概率 2% → 3%。" },
  { level: 3, name: "涨薪预期", desc: "转会收到的报价降一档。" },
  { level: 4, name: "岁月催人", desc: "衰退从 28 岁提前到 26 岁开始。" },
  { level: 5, name: "诸神黄昏", desc: "世界杯夺冠概率 −30%。" },
  { level: 6, name: "天命难违", desc: "所有事件成功概率 −10%。" },
  { level: 7, name: "孤勇者", desc: "无法接受私人教练/特训类增益事件。" },
  // ── P9: rule-changing ascensions — new rules, not just bigger penalties ──
  { level: 8, name: "转会冻结", desc: "转会窗每 5 次决策才开一次（常规为 3 次），攀升更难。" },
  { level: 9, name: "国家队退役", desc: "无法被国家队征召（失去所有国家队荣誉路径）。" },
  { level: 10, name: "全面降级", desc: "所有联赛实力视作 −1 档（弱旅地狱）。" },
];

/** P9: ascension unlock gates — StS-style "win to climb". Each level requires a
 *  minimum bestRun legacy to unlock, so the player climbs the ladder by
 *  actually beating the prior difficulty, not just selecting it. */
// P-META 压基线: gates ×2 on the compressed scoring scale — a median unguided
// run (~280) unlocks A1; each rung above asks for a genuinely better career
// (the ascension reward multiplier ×(1+0.15L) keeps the climb self-feeding,
// StS-style "the harder you play, the faster you unlock").
export const ASCENSION_UNLOCK_REQ: readonly number[] = [
  0,    // 0
  160,  // 1
  300,  // 2
  440,  // 3
  600,  // 4
  800,  // 5
  1040, // 6
  1300, // 7
  1600, // 8
  2000, // 9
  2600, // 10
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
  // 方向 B: honors rebalanced so a non-World-Cup career's trophy pile still
  // carries real weight (the honor chase must drive choices at EVERY tier, not
  // only when a WC is in play). Mid-tier trophies roughly doubled; the World
  // Cup is PINNED at 120 to keep its尖峰 — balanced-means-boring warns against
  // flattening the peak, and a WC should still be “one trophy changes a life.”
  league: 20,
  cup: 12,
  continental_primary: 55,
  continental_secondary: 28,
  club_world_cup: 60,
  national_continental: 55,
  world_cup: 120,
};

const AWARD_LEGACY: Record<Award, number> = {
  // 方向 B: individual honors lifted so the Ballon d'Or race (which gates on
  // league+continental wins) is worth chasing in its own right, and a Golden
  // Boot/Glove season feels like a real career marker, not a rounding error.
  ballon_dor: 70,
  golden_boot: 40,
  golden_glove: 40,
};

/** P-POS: position-weighted career-performance legacy. The career-scale
 *  perf weighting (goals for ST, assists for creators, clean sheets for GK)
 *  with a per-position SOFT CAP so the term lifts GK/defenders/creators toward
 *  strikers without inflating the attackers who already cash in via trophies +
 *  Ballon d'Or/Golden Boot.
 *  Tuned (via tools/balance-mc) so a median unguided ST career adds ~+10
 *  (a token — their goals already drove trophies + awards), a GK ~+81, a
 *  creator ~+63, a defender ~+40 — closing the 196-vs-285 GK/ST meta gap to
 *  within ~15 while keeping the overall median on the ascension-gate tuning
 *  (~280-295), so the difficulty curve doesn't slide a rung. Attackers stay
 *  fractionally ahead (they score the decisive goals, win the Ballon d'Or) —
 *  football-authentic tiering, not flat parity. */
function careerPerfLegacy(
  position: Position,
  goals: number,
  assists: number,
  cleanSheets: number,
): number {
  const isGK = position === "GK";
  const isDef = position === "CB" || position === "LB" || position === "RB";
  const isCreator = position === "CM" || position === "CAM" || position === "LM" || position === "RM" || position === "CDM";
  if (isGK) {
    // primary: shutouts (a Casillas career is ~300+); rare GK goals are a bonus
    return Math.min(Math.floor(cleanSheets / 2) + Math.floor(goals / 15), 95);
  }
  if (isDef) {
    // defenders (CB/LB/RB) have no clean-sheet stat — a flat defensive-solidarity
    // bonus (the goals prevented that stats never recorded) + their modest G/A.
    return Math.min(30 + Math.floor(goals / 10) + Math.floor(assists / 8), 55);
  }
  if (isCreator) {
    // primary: assists (a Modric/De Bruyne career lives here); goals chip in
    return Math.min(Math.floor(assists / 3) + Math.floor(goals / 6), 65);
  }
  // attackers — goals carry, but capped low: they already get Ballon d'Or /
  // Golden Boot + the trophy pile their goals helped win.
  return Math.min(Math.floor(goals / 5) + Math.floor(assists / 10), 12);
}

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
  /** Career-end legacy bonuses derived from the career SHAPE (not event
   *  grants) — e.g. loyal_club's one-club-man tenure bonus. Added to honors
   *  before the ascension/challenge/earn multipliers so it scales with them. */
  careerEndBonus?: number,
  /** marketable/pp_legacy_magnet earn multiplier (legacyEarnMult) — applied to
   *  the whole final score, fixing the old behavior where "+20% 所有传承分"
   *  only touched the ~2% event slice. */
  earnMult = 1,
  paceMult = 1,
  /** P-POS: position-weighted career performance — the meta score previously
   *  ignored goals/assists/clean sheets entirely, so a GK (no Ballon d'Or, fewer
   *  trophies) banked ~69% of a striker's legacy for an equally-great career.
   *  Each position's PRIMARY contribution now pays into `honors`, soft-capped so
   *  attackers (who already cash in via trophies + Ballon d'Or/Golden Boot)
   *  don't inflate: goals for ST, assists for creators, clean sheets for GK.
   *  Defenders have no clean-sheet stat, so they get a position-flat "defensive
   *  solidity" bonus — the goals-prevented that stats never recorded. */
  position: Position = "ST",
  careerGoals = 0,
  careerAssists = 0,
  careerCleanSheets = 0,
): number {
  // Mechanics review: split base (ability/longevity/finance) from honors
  // (trophies/awards/event moments). The WC ×1.5 used to multiply the WHOLE
  // total (base + finance included), stacking with the 120-point trophy, the
  // +100 showdown event AND the ch_world_cup challenge ×1.5 — one WC outscored
  // entire careers and flattened nation choice into "always pick fifaRep 5".
  let base = maxOverall; // peak ability
  base += seasons;       // longevity
  // P-A17: career earnings — total wages (€K) and final market value (€M)
  // both feed into legacy, so a lucrative career (big leagues, big wages) adds
  // to the score — the financial dimension the user asked for. Scaled so it's
  // a meaningful but not dominant contributor (~10-15% of a top score).
  // 方向 B: wage contribution is SOFT-CAPPED at maxOverall×2 so a banked-but-
  // trophyless late career can't outscore honors by hoarding wages alone —
  // money is a dimension of the score, not a substitute for winning. The cap
  // only bites at extreme wage totals (a 92 OVR career caps at ~184 from wages),
  // so normal careers are untouched; it trims only the degenerate "high pay,
  // no cups" line the user flagged.
  if (careerWageTotal) {
    const wageLegacy = Math.round(careerWageTotal / 200); // €200K wage ≈ 1 legacy
    const wageCap = maxOverall * 2;
    base += Math.min(wageLegacy, wageCap);
  }
  if (finalMarketValue) base += Math.round(finalMarketValue * 2); // €1M final value ≈ 2 legacy
  let honors = 0;
  // career-end bonuses (e.g. loyal_club one-club-man tenure) — NOT event
  // grants; added before the multipliers so they scale with ascension too.
  if (careerEndBonus) honors += careerEndBonus;
  for (const t of trophies) honors += TROPHY_LEGACY[t] ?? 0;
  for (const a of awards) honors += AWARD_LEGACY[a] ?? 0;
  // P-POS: position-weighted career performance. A great GK (Casillas: WC, CLs,
  // 200+ clean sheets) used to bank ~69% of a great ST's legacy because the
  // meta score only priced trophies + awards — and GKs win fewer of both while
  // being ineligible for Ballon d'Or/Golden Boot. Now each position's
  // bread-and-butter contribution pays into honors, soft-capped per position
  // so attackers (who already cash in via trophies + the Ballon d'Or/Golden
  // Boot awards) don't inflate. Defenders have no clean-sheet stat in the sim,
  // so they get a position-flat "defensive solidity" bonus instead — the
  // goals-prevented that stats never recorded, priced ~half a creator's output.
  honors += careerPerfLegacy(position, careerGoals, careerAssists, careerCleanSheets);
  // a career crowned by a World Cup title is legendary — ×1.5, but on the
  // HONORS portion only.
  const wonWorldCup = trophies.includes("world_cup");
  if (wonWorldCup) honors = Math.round(honors * 1.5);
  let total = base + honors;
  // ascension multiplier: harder = more rewarding. P-ASC: the old ×(1+0.15L)
  // was too flat — measured (tools/ascension-probe) it made asc 3 meta (218)
  // FALL BELOW asc 0 (279) because the stacked penalties (从严/伤病潮/涨薪
  // 预期/岁月催人/诸神黄昏/天命难违/孤勇者) cost ~46% of raw legacy while the
  // reward added only +45%. The climb wasn't self-feeding: higher ascension
  // earned LESS, so no reason to raise it — the StS "win to climb" loop broke.
  // Steepened to ×(1+0.30L) so each level pays more than the last (asc 3 ≈
  // asc 0, asc 5+ clearly above), making the difficulty worth the risk from
  // the very first rung. The ASCENSION_UNLOCK_REQ gates are high enough (A5=800, A10=2600) that the
  // steeper curve doesn't skip rungs — it just makes the climb genuinely
  // rewarding again.
  total = Math.round(total * (1 + ascension * 0.30));
  // P3: redemption challenge — if the player carried a near-miss goal into this
  // run and achieved it, apply the bonus multiplier. The ch_world_cup challenge
  // does NOT stack on top of the WC honors bonus — same feat, one reward.
  if (challenge && challengeSucceeded(challenge, { trophies, awards, maxOverall, seasons })
      && !(wonWorldCup && challenge.id === "ch_world_cup")) {
    total = Math.round(total * challenge.legacyMult);
  }
  if (earnMult !== 1) total = Math.round(total * earnMult);
  void retireReason;
  // Mechanics review: pace factor. Express (3 seasons/decision) plays a career
  // in ~1/3 the wall-clock of normal with near-identical scoring — legacy/minute
  // made it the degenerate grind mode. ×0.85 keeps express a legitimate fast
  // lane (still the best legacy/minute) without making it strictly optimal.
  if (paceMult !== 1) total = Math.round(total * paceMult);
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

// P-META 压基线: all gates ×3 (nations formula + overrides + profile/blessing
// rows) — same rationale as the blessing costs; the unlock track should pace
// multiple careers, not evaporate on run one.
// jpn/usa keep their original hand-tuned costs ×3 — players may already sit past them.
const NATION_REQ_OVERRIDES: Record<string, number> = { jpn: 150, usa: 240 };

// Cost scales with national-team strength: stronger stage → pricier unlock.
// Range works out to 90 (idn/fij) – 540 (uru).
const NATION_UNLOCKS: Unlock[] = NATIONS
  .filter((n) => !FREE_NATIONS.includes(n.id))
  .map((n) => ({
    id: `nation:${n.id}`, name: n.name, desc: "可选国籍解锁。", kind: "nation" as const,
    reqLegacy: NATION_REQ_OVERRIDES[n.id] ?? 90 + 30 * (n.contRep + 2 * n.fifaRep + n.intlRep),
  }));

export const UNLOCKS: readonly Unlock[] = [
  ...NATION_UNLOCKS,
  { id: "profile:wonderkid", name: "天才档", desc: "可选成长档位解锁。", reqLegacy: 300, kind: "profile" },
  // 顶级祝福的「资格门槛」: 累计传承达此值才解锁购买按钮。新价格下
  // 真正的门槛是售价(12000/15000), 这里只是一个「你已打了几局、有资格
  // 追顶级祝福」的资历里程碑(≈10-13 局累计), 而非购买力门槛——故设为售价的
  // ~1/4, 让上一轮加的 LockedBlessingAction 进度条在前期(前10-13局)有东西可填,
  // 之后由售价接管。
  { id: "blessing:sharpshooter", name: "神射手", desc: "祝福解锁。", reqLegacy: 3000, kind: "blessing" },
  { id: "blessing:comeback", name: "浴火重生", desc: "祝福解锁。", reqLegacy: 4000, kind: "blessing" },
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

/** Enriched career-shape input for achievement detection. The narrow
 *  {trophies, awards, maxOverall, seasons} shape could only express "did you
 *  win/reach X" — not the build-defining CAREER-SHAPE goals (one-club legend,
 *  giant-killer, globetrotter, big-five sweep) that drive targeted replays.
 *  Computed once from the finished GameState by computeAchievementInput(). */
export interface AchievementInput {
  readonly trophies: readonly Trophy[];
  readonly awards: readonly Award[];
  readonly maxOverall: number;
  readonly seasons: number;
  /** Total career goals (三球王 scoring feats). */
  readonly totalGoals: number;
  /** Distinct clubs played for (足坛浪子). */
  readonly distinctClubs: number;
  /** Distinct confederations played in (环球旅人). */
  readonly distinctConfederations: number;
  /** Spent the entire career at one club (一生一队). */
  readonly oneClubCareer: boolean;
  /** Distinct big-5 European leagues (ENG/ESP/ITA/GER/FRA) won a league title in (横扫五大联赛). */
  readonly bigFiveLeagueWins: number;
  /** Won a continental trophy at a minnow club (rep ≤ 1) (巨人杀手). */
  readonly smallClubContinental: boolean;
  /** A single season with league + cup + continental_primary (三冠王 — per-season, not career-total). */
  readonly trebleSeason: boolean;
  /** Injuries suffered this run (铁人). */
  readonly injuriesTaken: number;
  /** Player's nationality FIFA rep (黑马封王: a WC with a weak nation). */
  readonly nationFifaRep: number;
  /** Retirement age (流星: forced out young). */
  readonly retireAge?: number;
  /** Retirement reason — "injury" = medical retirement (流星). */
  readonly retireReason?: string | null;
}

export interface AchievementDef {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  /** Detect from a finished run's career-shape input. */
  achieved: (g: AchievementInput) => boolean;
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: "ah_world_cup", name: "世界之巅", desc: "赢得一次世界杯。", achieved: (g) => g.trophies.includes("world_cup") },
  { id: "ah_ballon_dor", name: "世界最佳", desc: "赢得一次金球奖。", achieved: (g) => g.awards.includes("ballon_dor") },
  { id: "ah_treble", name: "三冠王", desc: "单赛季联赛 + 杯赛 + 洲际冠军。", achieved: (g) => g.trebleSeason },
  { id: "ah_peak90", name: "历史级", desc: "巅峰 OVR 达到 90。", achieved: (g) => g.maxOverall >= 90 },
  { id: "ah_peak95", name: "殿堂级", desc: "巅峰 OVR 达到 95。", achieved: (g) => g.maxOverall >= 95 },
  { id: "ah_longevity", name: "常青", desc: "踢满 22 个赛季（到 38 岁仍不退役）。", achieved: (g) => g.seasons >= 22 },
  { id: "ah_golden_boot", name: "金靴射手", desc: "赢得一次金靴。", achieved: (g) => g.awards.includes("golden_boot") },
  { id: "ah_golden_glove", name: "金手套", desc: "赢得一次金手套（门将）。", achieved: (g) => g.awards.includes("golden_glove") },
  { id: "ah_continental_master", name: "洲际大师", desc: "赢下两种洲际冠军（欧冠 + 欧联 等）。", achieved: (g) => g.trophies.includes("continental_primary") && g.trophies.includes("continental_secondary") },
  { id: "ah_cwc", name: "世界俱乐部之巅", desc: "赢得一次世俱杯。", achieved: (g) => g.trophies.includes("club_world_cup") },
  { id: "ah_national_hero", name: "国家英雄", desc: "赢得一次洲际国家队冠军（欧洲杯/美洲杯等）。", achieved: (g) => g.trophies.includes("national_continental") },
  { id: "ah_ironman", name: "铁人", desc: "整生涯零伤病，踢满 15 个赛季。", achieved: (g) => g.injuriesTaken === 0 && g.seasons >= 15 },
  { id: "ah_meteor", name: "流星", desc: "30 岁前因伤病被迫退役——燃烧得快，坠落得早。", achieved: (g) => g.retireReason === "injury" && (g.retireAge ?? 99) <= 30 },
  // ── build-defining CAREER-SHAPE goals (aligned to Copero's long-tail
  //  aspirational achievements that drive targeted replays: 巨人杀手/一生一队/
  //  足坛浪子/环球旅人/横扫五大联赛/无冕之王/三球王/金靴机器/史上最佳/
  //  美洲之王/黑马封王). Each maps to a specific career build, the
  //  "gotta catch 'em all" pull that gives a reason to start runs targeting a gap. ──
  { id: "ah_giant_killer", name: "巨人杀手", desc: "以小球会（实力≤1）赢下洲际冠军（欧冠/解放者杯/亚冠等）。", achieved: (g) => g.smallClubContinental },
  { id: "ah_one_club_legend", name: "一生一队", desc: "整个生涯只效力一家俱乐部，并赢得联赛、杯赛与洲际冠军。", achieved: (g) => g.oneClubCareer && g.trophies.includes("league") && g.trophies.includes("cup") && g.trophies.includes("continental_primary") },
  { id: "ah_journeyman", name: "足坛浪子", desc: "生涯效力 8 家以上不同俱乐部。", achieved: (g) => g.distinctClubs >= 8 },
  { id: "ah_globetrotter", name: "环球旅人", desc: "在 4 个不同大洲足联的联赛效力过。", achieved: (g) => g.distinctConfederations >= 4 },
  { id: "ah_big_five_sweep", name: "横扫五大联赛", desc: "在五大联赛（英西意德法）都赢过联赛冠军。", achieved: (g) => g.bigFiveLeagueWins >= 5 },
  { id: "ah_ringless", name: "无冕之王", desc: "踢满 8 个赛季却一冠未得。", achieved: (g) => g.trophies.length === 0 && g.seasons >= 8 },
  { id: "ah_pele", name: "三球王", desc: "两度捧起世界杯，生涯轰入 350 球。", achieved: (g) => g.trophies.filter((t) => t === "world_cup").length >= 2 && g.totalGoals >= 350 },
  { id: "ah_golden_boot_machine", name: "金靴机器", desc: "赢得三次金靴。", achieved: (g) => g.awards.filter((a) => a === "golden_boot").length >= 3 },
  { id: "ah_goat", name: "史上最佳", desc: "一次世界杯 + 两次洲际冠军 + 三次金球奖。", achieved: (g) => g.trophies.filter((t) => t === "world_cup").length >= 1 && g.trophies.filter((t) => t === "continental_primary").length >= 2 && g.awards.filter((a) => a === "ballon_dor").length >= 3 },
  { id: "ah_rey_america", name: "美洲之王", desc: "赢下洲际国家队冠军（美洲杯）与洲际冠军（解放者杯）。", achieved: (g) => g.trophies.includes("national_continental") && g.trophies.includes("continental_primary") },
  { id: "ah_underdog_champion", name: "黑马封王", desc: "以弱国（FIFA 实力≤2）身份捧起世界杯。", achieved: (g) => g.trophies.includes("world_cup") && g.nationFifaRep <= 2 },
];

/** The five European big-five leagues, keyed by league country. */
const BIG5_COUNTRIES = new Set(["ENG", "ESP", "ITA", "GER", "FRA"]);

/** Compute the career-shape achievement input from a finished run's state.
 *  Pure: iterates the season log once, cross-referencing club/league data to
 *  derive the shape fields (distinct clubs/confederations, big-five wins,
 *  small-club continental, per-season treble). Called once at retirement. */
export function computeAchievementInput(game: GameState): AchievementInput {
  const clubs = new Set<string>();
  const confs = new Set<string>();
  const bigFiveWon = new Set<string>();
  let totalGoals = 0;
  let smallClubContinental = false;
  let trebleSeason = false;
  for (const s of game.seasons) {
    clubs.add(s.clubId);
    totalGoals += s.stats.goals;
    const lg = leagueById(s.leagueId);
    if (lg) confs.add(lg.confederation);
    const hasContinental = s.trophies.includes("continental_primary") || s.trophies.includes("continental_secondary");
    if (hasContinental) {
      const cl = clubById(s.clubId);
      if (cl && cl.rep <= 3) smallClubContinental = true;
    }
    if (s.trophies.includes("league") && lg && BIG5_COUNTRIES.has(lg.country)) bigFiveWon.add(lg.country);
    if (s.trophies.includes("league") && s.trophies.includes("cup") && s.trophies.includes("continental_primary")) trebleSeason = true;
  }
  const nat = game.player ? nationById(game.player.nationalityId) : undefined;
  return {
    trophies: game.trophies,
    awards: game.awards,
    maxOverall: game.maxOverall,
    seasons: game.seasons.length,
    totalGoals,
    distinctClubs: clubs.size,
    distinctConfederations: confs.size,
    oneClubCareer: clubs.size === 1,
    bigFiveLeagueWins: bigFiveWon.size,
    smallClubContinental,
    trebleSeason,
    injuriesTaken: game.injuriesTaken ?? 0,
    nationFifaRep: nat?.fifaRep ?? 5,
    retireAge: game.age,
    retireReason: game.retirementReason,
  };
}

/** All trophy types that can be collected (for the trophy wall progress). */
export const ALL_TROPHY_IDS: readonly string[] = [
  "league", "cup", "continental_primary", "continental_secondary",
  "club_world_cup", "national_continental", "world_cup",
];

/** Merge a finished run's trophies + achievements into the persistent
 *  collection. Returns the new save. */
export function mergeCollection(meta: MetaSave, g: AchievementInput): MetaSave {
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
export function newlyCollectedAchievements(meta: MetaSave, g: AchievementInput): readonly AchievementDef[] {
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
  { id: "pp_prodigy",       name: "天选之子",   desc: "永久：起始 OVR +8（与金童取高，不叠加）。" },
  { id: "pp_longevity",     name: "常青树",     desc: "永久：衰退延迟 1 年。" },
  { id: "pp_legacy_magnet", name: "传承磁体",   desc: "永久：所有传承分获取 +25%（与商业价值叠加）。" },
  { id: "pp_iron_will",     name: "钢铁意志",   desc: "永久：每局首次伤病不扣 OVR。" },
  { id: "pp_transfer_savvy",name: "转会嗅觉",   desc: "永久：每次转会 +2 OVR。" },
  { id: "pp_comeback_base", name: "涅槃基线",   desc: "永久：30 岁后每次决策 50% 概率回血 +2 OVR（无需浴火重生）。" },
  { id: "pp_oracle_base",   name: "洞察基线",   desc: "永久：成功概率显示到小数点后一位（无需先知之眼）。" },
  { id: "pp_scout",         name: "青训球探",   desc: "永久：20 岁前每个周期成长 +1（精英青训营的栽培）。" },
  { id: "pp_boss_slayer",   name: "弑神者",     desc: "永久：决战事件成功概率 +20%。" },
];

export function prestigePerkById(id: string): PrestigePerk | undefined {
  return PRESTIGE_PERKS.find((p) => p.id === id);
}

/** Prestige unlocks once the player owns every blessing AND has banked enough
 *  legacy to make the sacrifice meaningful. NOTE: 在新价格阶梯下, 集齐 13 个祝福
 *  本身就要 ≈286 局(总价 85900), 这才是轮回的真正门槛; 此阈值不再跟总价走
 *  (那会变成 ~590 局、几乎不可达), 而是定为一个「一个顶级祝福价位」的固定
 *  押金(15000)——集齐后再攒一个顶级祝福的钱即可献祭, 真正献祭掉的是整套
 *  祝福(要重新攒 286 局才能买回) + 这笔押金。 */
export const PRESTIGE_LEGACY_THRESHOLD = 15000;
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
  /** Equipped blessing loadout (≤ MAX_LOADOUT). Undefined on older saves →
   *  resolveLoadout falls back to the first owned blessings. */
  loadout?: readonly string[];
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
  // An item not listed in UNLOCKS has no cumulative-legacy gate, so it is
  // always available — gate 0, not Infinity (which made every non-listed
  // blessing like 金童/铁肺 show "需解锁" forever and stay unbribable).
  return meta.unlocked.includes(id) || meta.totalLegacyAllTime >= (UNLOCKS.find((u) => u.id === id)?.reqLegacy ?? 0);
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

/** Mechanics review: the daily bonus is earned by COMPLETING today's daily
 *  challenge, not by opening the app — the old login handout (~a free blessing
 *  per week for zero play) diluted "legacy is earned by runs". Records the
 *  completion into the same LoginBonus store the menu ribbon reads. */
export function recordDailyBonus(streak: number, amount: number): LoginBonus {
  const prev = loadLoginBonus();
  const bonus: LoginBonus = {
    lastLoginDate: todayStr(),
    consecutiveDays: streak,
    totalLogins: prev.totalLogins + 1,
    bonusLegacy: amount,
  };
  try { localStorage.setItem(LOGIN_KEY, JSON.stringify(bonus)); } catch { /* noop */ }
  return bonus;
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
