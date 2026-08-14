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
import { leagueById, clubById, nationById, WONDERKID_WEIGHT } from "../engine/data";
import { seniorCareerSeasonCount, seniorCareerStats, seniorClubCount, type Trophy, type Award, type GameState } from "../engine/types";
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
// P-BLESS-PRICE 重定价 —— 三档离散定价, 价格 = 局数 × a0 p75 单局传承。
//
// 计价单位「1 局 = 475 传承」取自 steady 策略模拟的 a0 p75 分位（转会拣星 +
// 其余选第一项, N=400/档）——与真人裸装 386/局、first 策略 377/局同口径, 且
// 比 a0 中位（473, 云端 128 局真人）高一档: 买祝福的不会是中位以下的摆烂玩家,
// p75 是「打得不错的裸装玩家」水位, 也就是祝福真正面向的人群。取整到 500/局
// (475→500), 价格收敛到 5000 的整数倍。
//
// 公式:  局数 ∈ {10, 20, 30}      价格 = 局数 × 500
//   · 三档而非连续区间 —— 旧公式「20 + 90×r」把 13 件铺成 20→60 局的连续阶梯,
//     但实测 r 的分辨率撑不起 13 个价位（铁肺 3.6 / 护身符 3.7 / 忠诚 1.7 挤在
//     3% 带内却各自定价）。三档按质量粗分成「消耗品/中坚/核心」, 每档内同价,
//     跨档 2×、3× 的清晰差距, 玩家一眼读出贵贱。
//   · 地板 10 局 —— 仍守「祝福是跨多局目标」的精神（比旧 20 局宽松: 三档结构下
//     最便宜档就是「顺手买」档, 10 局门票足够挡住日抛）。
//   · 天花板 30 局 —— 最强金童从旧 60 局降到 30 局, 因 a0-a10 攀升致产出腰斩
//     (a10 ≈ a0 的 48%), 旧 60 局在高档等价 125 局不可达; 30 局在 a10 也只等价
//     63 局, 仍是跨多局目标但不再望尘莫及。
// 总盘 125,000, 约 250 局集齐（见 PRESTIGE 注释）。
//
// 两件按设计意图而非实测定价（实测值是已知缺陷, 修复后需复核 r 并重定这两行）:
//   · 大赛型选手 实测 r = −4.1% —— 决战 +10% 抵不过普通事件 −10%（决战触发率
//     asc0 仅 6.4%）, 目前买它使生涯变差。按 build-defining 件的同侪位给 r≈14%。
//   · 先知之眼 实测 r = 0 —— 信息优势对盲选策略不可见, 且 asc≥3 情报封锁下概率
//     被完全遮蔽(App.tsx OddsNum 不看 oracle), 高难度段价值归零。给 r≈5%。

export const BLESSINGS: readonly Blessing[] = [
  // 每行末尾的 r 是实测提升率（* 号 = 按设计意图取值, 见上）; 档 = 三档定价
  // (10/20/30 局 × 500) 的归属, 由 r 的自然断点决定（见 P-BLESS-PRICE 注释）。
  { id: "golden_boy", name: "金童", desc: "起始 OVR 58（而非 50）。天才少年，一出道即主力级。", cost: 15000 },        // r +44.5% → 30 局档
  { id: "iron_lungs", name: "铁肺", desc: "训练事件成功概率 +25%，体能续航出场更多、生涯更久。", cost: 5000 },       // r  +3.6% → 10 局档
  { id: "oracle", name: "先知之眼", desc: "成功概率显示到小数点后一位；情报封锁下仍可见高中低粗档。", cost: 5000 },  // r  +5%*  → 10 局档
  { id: "loyal_club", name: "忠诚之心", desc: "功勋球员：连续效力同一俱乐部 8 赛季以上，传承 +1.5%/季（最高 +18%）。", cost: 5000 }, // r +1.7% → 10 局档
  { id: "talisman", name: "护身符", desc: "生涯首次伤病概率降至四成。", cost: 5000 },                                // r  +3.7% → 10 局档
  { id: "sharpshooter", name: "神射手", desc: "进球率 +25%。生涯进球传承 +0.1%/球（最高 +18%）。", cost: 10000 },     // r +12.5% (ST +25.6%) → 20 局档
  { id: "ironman", name: "铁人", desc: "伤病概率 −20%，OVR 损失减半（轻微伤病不扣）。30 岁后传承 +1%/季（最高 +8%）。", cost: 10000 }, // r +10.2% → 20 局档
  { id: "marketable", name: "商业价值", desc: "所有传承分获取 +10%。", cost: 10000 },                                 // r +10.0% → 20 局档
  { id: "comeback", name: "浴火重生", desc: "30 岁后每次决策 25% 概率回血 +1 OVR。33 岁后传承 +2%/季（最高 +12%）。", cost: 10000 }, // r +8.5% → 20 局档
  // ── P2: build-defining blessings — change HOW you play, not just numbers ──
  { id: "glass_cannon", name: "玻璃大炮", desc: "成长 +40%，但伤病概率 ×3。高风险高回报的成长流。", cost: 15000 },   // r +23.3% → 30 局档
  { id: "mercenary", name: "雇佣兵", desc: "每次转会额外 +1 OVR，但无法成为俱乐部传奇（与忠诚之心互斥）。频繁跳槽换实力。", cost: 15000 }, // r +21.3% → 30 局档
  { id: "big_game_player", name: "大赛型选手", desc: "决战事件（世界杯对决、决胜点球）成功概率 +10%，普通事件 −10%。为大场面而生。", cost: 10000 }, // r +14%*  → 20 局档
  { id: "late_bloomer", name: "大器晚成", desc: "25 岁前成长略缓，25 岁后成长翻倍。慢热但后劲十足。", cost: 10000 }, // r +14.7% → 20 局档
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
  { level: 1, name: "从严", desc: "板凳球员的成长判定取两次中的较低值，主力不受影响；飞升 6 起板凳改取三次。" },
  { level: 2, name: "伤病潮", desc: "赛季伤病概率 2% → 5%，伤病的 OVR 损失 +1。" },
  { level: 3, name: "情报封锁", desc: "所有概率被黑色方块遮盖，全凭直觉下注。" },
  { level: 4, name: "岁月催人", desc: "衰退从 28 岁提前到 26 岁开始。" },
  { level: 5, name: "诸神黄昏", desc: "大赛决战之夜（世界杯/洲际杯）成功概率 −30%。" },
  { level: 6, name: "天命难违", desc: "所有事件成功概率 −10%。" },
  { level: 7, name: "无人问津", desc: "市场不再相信你：留队判定 −12%，金元邀约消失，生涯提前落幕。" },
  // ── P9: rule-changing ascensions — new rules, not just bigger penalties ──
  { level: 8, name: "转会冻结", desc: "转会窗每 5 个赛季才开一次（常规为 2 个），攀升更难。" },
  { level: 9, name: "国家队弃子", desc: "国家队入选门槛 +8：除非你成为世界级，否则再无国家队。" },
  { level: 10, name: "全面降级", desc: "所有联赛实力视作 −1 档（弱旅地狱）。" },
];

/** ADR-0006: 飞升奖赏 = 榜位，不是传承币加成。结算传承 = 实绩（raw），全档不增不减。
 *
 *  旧设计（P-ASC-PREMIUM）给高飞升一条补偿曲线 f_asc(raw)→meta（tailSlope 至
 *  ×4.08），A10 极限能到 9000+ 传承币，超出货币系统设计预期，也让高飞升成为最优
 *  货币农场。竞品调研（docs/research/ascension-reward-competitors.md）证实：StS /
 *  Hades / Balatro / Dead Cells 没有一家对「可复利累积的永久解锁货币」按难度做每局
 *  乘法曲线。业主定调：高难的奖赏应是排行榜高位亮相（榜单飞升优先排序），而非
 *  对传承币的加成。
 *
 *  identity 后 `game.legacy === game.rawLegacy`，`bestByAscension` 自动存 raw，
 *  飞升解锁门 `ASCENSION_UNLOCK_REQ` 改读 raw 分位（tools/ascension-reanchor 重锚）。
 *  老存档的 `bestByAscension` 存的是旧通胀 meta，比新 raw 门大得多 → 祖护时不回锁
 *  （业主定调「旧 meta ≥ 新 raw 门」），且「harder counts down」让超授有界（最多
 *  到「打过的最高档 +1」，不会越级）。详见 ADR-0006。
 *
 *  保留 `applyAscensionLegacyReward` 这个命名接缝（scoreLegacy 调它），函数体降为
 *  identity —— 若未来要重引入难度奖赏，这里是唯一的挂载点，且须先过竞品调研 +
 *  design-review 门。 */

/** Settled legacy for a career whose ascension-0-scored value is `rawLegacy`,
 *  at difficulty `ascension`. ADR-0006: identity — no per-level premium. The
 *  `ascension` arg is kept for signature stability; it is a no-op. */
export function applyAscensionLegacyReward(rawLegacy: number, _ascension: number): number {
  return Math.round(rawLegacy);
}

/** P-ASC-GATES (owner-approved redesign): true StS unlock semantics — level L
 *  unlocks only via a qualifying run played AT ascension L−1 or higher
 *  (`bestByAscension`), never via a global-best tail run at low difficulty.
 *  The old absolute-bestRun gate let one lucky asc-0 career skip several
 *  rungs, which forced the gate numbers to play two roles at once ("beat the
 *  prior level" AND "absolute score line") and made them untunable.
 *
 *  ADR-0006: gates now read **raw** (结算 = 实绩 identity 后 bestByAscension
 *  自动存 raw)。门槛按各档 raw 分位重锚（tools/ascension-reanchor N=160，
 *  skilled=steady, allowWonderkid=false），命中率意图不变：~40-45% 早期档，
 *  顶部收紧到 ~7-13%。raw 随飞升单调下降，故高档门槛数值比旧 meta 门小得多——
 *  这不是放松，是「在更难的档打出该档的高分位」本就难。
 *
 *  老存档祖护：旧 bestByAscension 存的是通胀 meta，比新 raw 门大 → 满足新门不
 *  回锁（业主定调「旧 meta ≥ 新 raw 门」）。「harder counts down」(bestAtOrAbove)
 *  让超授有界：最多到「打过的最高档 +1」，不会越级白送整梯。 */
export const ASCENSION_UNLOCK_REQ: readonly number[] = [
  // ADR-0006: 改读 raw 分位（tools/ascension-reanchor N=160，同 economy-check 口径）。
  0,     // 0
  374,   // 1  ≈ p57 @ asc 0 skilled steady raw (~42% hit)
  359,   // 2  ≈ p59 @ asc 1  (~41%)
  348,   // 3  ≈ p59 @ asc 2  (~41%)
  329,   // 4  ≈ p59 @ asc 3  (~41%)
  271,   // 5  ≈ p71 @ asc 4  (~29%)
  253,   // 6  ≈ p71 @ asc 5  (~29%)
  244,   // 7  ≈ p74 @ asc 6  (~26%)
  235,   // 8  ≈ p74 @ asc 7  (~26%)
  240,   // 9  ≈ p87 @ asc 8  (~13%)
  244,   // 10 ≈ p93 @ asc 9  (~7%) — the leaderboard-chaser's badge
];

/** Frozen pre-premium gates (P-ASC-ECON era) — used ONLY to grandfather saves
 *  whose bestByAscension was earned on the old score scale: the premium curve
 *  inflated the reqs, and re-deriving maxAscension from old-scale bests would
 *  RE-LOCK earned rungs. loadMeta evaluates these once (v2→v3 migration) into
 *  `ascensionFloor`; never shown in UI, never re-evaluated afterwards. */
const PRE_PREMIUM_UNLOCK_REQ: readonly number[] = [
  0, 380, 415, 430, 450, 460, 480, 500, 540, 570, 600,
];

/** Frozen pre-redesign global-bestRun gates — used ONLY to grandfather saves
 *  that predate `bestByAscension` (loadMeta backfill). Never shown in UI. */
const LEGACY_GLOBAL_UNLOCK_REQ: readonly number[] = [
  0, 160, 300, 440, 600, 800, 1040, 1300, 1600, 2000, 2600,
];

/** Best single-run legacy achieved at ascension `lvl` OR HIGHER (harder always
 *  counts down). 0 when the player has never finished a run that high. */
export function bestAtOrAbove(meta: MetaSave, lvl: number): number {
  const best = meta.bestByAscension ?? [];
  let max = 0;
  for (let k = lvl; k < best.length; k++) max = Math.max(max, best[k] ?? 0);
  return max;
}

/** Highest ascension the player has unlocked. Sequential: each rung must be
 *  earned by a qualifying run at the rung below (or higher) — no skipping.
 *  `ascensionFloor` grandfathers rungs earned on the pre-premium score scale
 *  (see PRE_PREMIUM_UNLOCK_REQ) — earned unlocks never re-lock. */
export function maxAscensionUnlocked(meta: MetaSave): number {
  let max = 0;
  for (let lvl = 1; lvl < ASCENSION_UNLOCK_REQ.length; lvl++) {
    if (bestAtOrAbove(meta, lvl - 1) >= ASCENSION_UNLOCK_REQ[lvl]!) max = lvl;
    else break;
  }
  return Math.max(max, meta.ascensionFloor ?? 0);
}

// ───────────────────────────── legacy scoring ─────────────────────────────

/** 体面退场的荣誉加成。选在 1.25：一个赛季在顶级俱乐部的期望产出约为荣誉盘的
 *  5–10%，所以 +25% 大致等价于「再踢三到四个赛季」——重伤/心脏/巅峰崩塌这些
 *  事件之后，玩家本来也踢不到的那几年。低于 1.15 翻不动任何局面（选项仍是死的），
 *  高于 1.4 会反过来变成「攒够荣誉就退役」的刷分线。 */
export const DIGNIFIED_EXIT_MULT = 1.25;

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
  olympic: 35,
};

const AWARD_LEGACY: Record<Award, number> = {
  // 方向 B: individual honors lifted so the Ballon d'Or race (which gates on
  // league+continental wins) is worth chasing in its own right, and a Golden
  // Boot/Glove season feels like a real career marker, not a rounding error.
  ballon_dor: 70,
  golden_boot: 40,
  golden_glove: 40,
  // regional ceiling honors (阶段四) — strictly below the global awards: a
  // continental POY (亚洲足球先生) sits just above a single Golden Boot/Glove,
  // the CSL MVP / 中超金靴 are domestic-league tier. They give a stay-home /
  // Asian career a personal legacy floor without rivaling the crown jewels.
  afc_poy: 45,
  csl_mvp: 25,
  csl_boot: 20,
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
  /** 已入账的奖杯+奖项分（不含本函数的产出，故不循环）。只有前锋的上限用它:
   *  见下方注释——「他们已经通过金球/金靴兑现过了」这个折扣的前提是那些荣誉
   *  存在,高飞升下并不存在。 */
  cabinet = 0,
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
  //
  // That discount ASSUMES those honors exist. At high ascension they don't:
  // 飞升9 closes the national-team path (世界杯 120 / 洲际 55) and 飞升10 shuts
  // the continental/big-club path that gates the Ballon d'Or, so the striker who
  // scored 182 goals across 18 seasons was being paid 12 points for the whole
  // career — the discount was applied without the thing it discounts. The cap
  // therefore scales with how thin the actual cabinet is: full cabinet (≥60,
  // i.e. any normal asc-0 career) keeps the flat 12 so the P-POS GK/ST parity
  // is untouched; an empty cabinet relaxes to 45, which is still below a
  // creator's 65 and a defender's 55.
  const cap = cabinet >= PERF_CAP_CABINET_FULL
    ? PERF_CAP_ATTACK_MIN
    : PERF_CAP_ATTACK_MIN + Math.round(
      (PERF_CAP_ATTACK_MAX - PERF_CAP_ATTACK_MIN) * (PERF_CAP_CABINET_FULL - cabinet) / PERF_CAP_CABINET_FULL,
    );
  return Math.min(Math.floor(goals / 5) + Math.floor(assists / 10), cap);
}

/** 前锋表现上限的两端与「荣誉满仓」判定线。上限随 cabinet 线性收紧到
 *  PERF_CAP_ATTACK_MIN。斜率 (45−12)/60 = 0.55 < 1，所以总分对 cabinet 仍严格
 *  单调递增——多拿一座奖杯永远比不拿划算，不存在「弃荣誉换上限」的套利。 */
const PERF_CAP_ATTACK_MIN = 12;
const PERF_CAP_ATTACK_MAX = 45;
const PERF_CAP_CABINET_FULL = 60;

/** P-DOMINANT-REBASE 全局再基准系数 — 见 scoreLegacy 内注释。由 ascension-probe
 *  改动前后各档中位比值(1.08~1.22, 中值 ~1.15)取倒数标定。 */
const LEGACY_REBASE = 0.86;

export function scoreLegacy(
  maxOverall: number,
  seasons: number,
  trophies: readonly Trophy[],
  awards: readonly Award[],
  ascension: number,
  retireReason: string | null,
  careerWageTotal?: number,
  finalMarketValue?: number,
  /** 体面退场 — the career ended because the player CHOSE to stop while he
   *  still could (接受终结/主动挂靴), not because he was stopped. See the
   *  DIGNIFIED_EXIT_MULT comment below for why this exists. */
  dignifiedExit?: boolean,
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
  /** P-NATION: 出身国青训档位的传承补偿乘数 (T1 ×1.0 … T5 ×1.8) — 弱国
   *  开局全程更难 (成长摩擦 + 报价路径摩擦),结算按倍率补回:高风险高回报。 */
  nationMult = 1,
): number {
  // Mechanics review: split base (ability/longevity/finance) from honors
  // (trophies/awards/event moments). The WC ×1.5 used to multiply the WHOLE
  // total (base + finance included), stacking with the 120-point trophy and
  // the +100 showdown event — one WC outscored entire careers and flattened
  // nation choice into "always pick fifaRep 5".
  // 荣誉先算：工资上限要用它表达（见下），前锋表现上限也要用奖杯柜的厚度。
  let honors = 0;
  for (const t of trophies) honors += TROPHY_LEGACY[t] ?? 0;
  for (const a of awards) honors += AWARD_LEGACY[a] ?? 0;
  // 奖杯柜 = 只算真正赢到的奖杯与奖项，不含生涯表现项本身，故 careerPerfLegacy
  // 用它当上限依据不构成循环。
  const cabinet = honors;
  // P-POS: position-weighted career performance. A great GK (Casillas: WC, CLs,
  // 200+ clean sheets) used to bank ~69% of a great ST's legacy because the
  // meta score only priced trophies + awards — and GKs win fewer of both while
  // being ineligible for Ballon d'Or/Golden Boot. Now each position's
  // bread-and-butter contribution pays into honors, soft-capped per position
  // so attackers (who already cash in via trophies + the Ballon d'Or/Golden
  // Boot awards) don't inflate. Defenders have no clean-sheet stat in the sim,
  // so they get a position-flat "defensive solidity" bonus instead — the
  // goals-prevented that stats never recorded, priced ~half a creator's output.
  honors += careerPerfLegacy(position, careerGoals, careerAssists, careerCleanSheets, cabinet);
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
    // 工资是「功勋生涯的放大器」，不是「荣誉的替代品」。旧上限只锚在
    // maxOverall×2（68 OVR ⇒ 136），而同一局的荣誉可能只有 32——公式允许工资
    // 是荣誉的 4 倍，于是高飞升的最优解变成「进一支保得住主力的弱旅，别受伤，
    // 苟满 18 个赛季领工资」：荣誉侧被难度删除，累积侧对难度免疫。上限同时受
    // 荣誉约束后，没赢过任何东西的高薪生涯拿不到工资分，这条线自然断掉。
    const wageCap = Math.min(maxOverall * 2, honors);
    base += Math.min(wageLegacy, wageCap);
  }
  if (finalMarketValue) base += Math.round(finalMarketValue * 2); // €1M final value ≈ 2 legacy
  // 荣誉与生涯表现已在函数开头结算——工资上限依赖 honors，故顺序前移。
  // 体面退场 (P-DEGEN): every "接受终结 / 主动挂靴" option used to be STRICTLY
  // DOMINATED. The score is monotone in seasons played (base += seasons, wages,
  // more trophy rolls, more award rolls) and retireReason was never scored, so
  // ending the run early could only ever cost points — a fake choice dressed as
  // a dramatic one (game-design-core: "no dominant strategy / situational
  // value"). The bonus is a PERCENTAGE of honors already banked, never a flat
  // number, and that is what makes it situational rather than a new dominant
  // line: a 35-year-old with a decorated pile gets more from walking out on his
  // own terms than from three more seasons on a wrecked body, while a 24-year-
  // old with nothing on the shelf gets almost nothing and should obviously
  // fight. 走得早，但走得完整 — priced, not just narrated.
  if (dignifiedExit) honors = Math.round(honors * DIGNIFIED_EXIT_MULT);
  // a career crowned by a World Cup title is legendary — ×1.5, but on the
  // HONORS portion only.
  const wonWorldCup = trophies.includes("world_cup");
  if (wonWorldCup) honors = Math.round(honors * 1.5);
  let total = base + honors;
  if (earnMult !== 1) total = Math.round(total * earnMult);
  // P-NATION: 弱国出身补偿——与飞升乘数同为「难度换回报」轴,平行叠乘。
  if (nationMult !== 1) total = Math.round(total * nationMult);
  void retireReason;
  // Mechanics review: pace factor. Express (3 seasons/decision) plays a career
  // in ~1/3 the wall-clock of normal with near-identical scoring — legacy/minute
  // made it the degenerate grind mode. ×0.85 keeps express a legitimate fast
  // lane (still the best legacy/minute) without making it strictly optimal.
  if (paceMult !== 1) total = Math.round(total * paceMult);
  // P-DOMINANT-REBASE: 统治级门槛放宽 + 表现分豁免天花板(P-PERF-EXEMPT/P-DOMINANT)
  // 把巅峰 OVR 与奖杯产出整体抬高, A0-A10 传承中位涨了 8-22%。全局 ×0.86 把传承
  // 产出压回旧量级——分布形状与所有相对规则不动, ASCENSION_UNLOCK_REQ / 排行段位 /
  // 解锁门槛的锚全部保持有效, 不需要重锚。放在飞升 identity 之前、所有乘数之后。
  total = Math.round(total * LEGACY_REBASE);
  // P-ASC-ECON: apply ascension LAST so the proficiency gate sees the complete
  // pre-ascension career score. The base multiplier compensates every rung;
  // only a genuinely high-scoring career progresses toward the elite ceiling.
  return applyAscensionLegacyReward(total, ascension);
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

/** 解锁门槛已取消 —— 空表, 而非删除这条通道。
 *
 *  它原本有 53 项(国籍 90–540 / 天才档 300 / 两件顶级祝福 3000·4000), 按累计
 *  传承逐步放开。实测它已经不是门槛: 按真实裸装产出 386/局, **第 1 局就发掉
 *  81%(43/53), 第 12 局 100%** —— 玩家还没看清它是什么, 它已经结束了。
 *
 *  而且它锁的是弱选项: 产出最高的 tier 1 青训国(esp/fra/ger, 均值 308)本来就在
 *  FREE_NATIONS 里, 被锁住的 tier 3/4/5 均值只有 253–272。一道只拦着更差选项、
 *  且在第一局就自行消失的门, 没有存在理由。
 *
 *  保留空表而不是删掉 UNLOCKS/isUnlocked: 所有消费端(国籍选择器的 locked、
 *  UnlockLine、祝福商店的 LockedBlessingAction)读到空表会自动降级成"全部可用",
 *  零 UI 改动; MetaSave.unlocked 字段也随之停写但不失效, 老存档不需要迁移。
 *
 *  注意: 这也让 allowWonderkid(App.tsx 由 isUnlocked("profile:wonderkid") 驱动)
 *  从第 1 局起恒为 true —— 与取消前"第 1 局解锁后自动永久开启"的实际行为一致,
 *  不是新行为。天才档本身的平衡问题(实测四档垫底: 均值 155 vs late 395)单独处理。 */
export const UNLOCKS: readonly Unlock[] = [];

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
  /** Spent the entire SENIOR career at one club (一生一队/一人一城)——青年队赛季
   *  不计，青训分配不是转会。 */
  readonly oneClubCareer: boolean;
  /** 最长的一段连续同队成年效力（赛季数）——功勋球员。 */
  readonly longestClubSpell: number;
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
  { id: "ah_csl_mvp", name: "中超最佳", desc: "赢得一次中超最佳球员。", achieved: (g) => g.awards.includes("csl_mvp") },
  { id: "ah_csl_boot", name: "中超金靴", desc: "赢得一次中超金靴。", achieved: (g) => g.awards.includes("csl_boot") },
  { id: "ah_afc_poy", name: "亚洲之光", desc: "赢得一次亚洲足球先生。", achieved: (g) => g.awards.includes("afc_poy") },
  { id: "ah_continental_master", name: "洲际大师", desc: "赢下两种洲际冠军。", achieved: (g) => g.trophies.includes("continental_primary") && g.trophies.includes("continental_secondary") },
  { id: "ah_cwc", name: "世界俱乐部之巅", desc: "赢得一次世俱杯。", achieved: (g) => g.trophies.includes("club_world_cup") },
  { id: "ah_national_hero", name: "国家英雄", desc: "赢得一次洲际国家队冠军（欧洲杯/美洲杯等）。", achieved: (g) => g.trophies.includes("national_continental") },
  { id: "ah_ironman", name: "铁人", desc: "整生涯零伤病，踢满 15 个赛季。", achieved: (g) => g.injuriesTaken === 0 && g.seasons >= 15 },
  { id: "ah_meteor", name: "流星", desc: "30 岁前因伤病被迫退役——燃烧得快，坠落得早。", achieved: (g) => g.retireReason === "injury" && (g.retireAge ?? 99) <= 30 },
  // ── build-defining CAREER-SHAPE goals (aligned to Copero's long-tail
  //  aspirational achievements that drive targeted replays: 巨人杀手/一生一队/
  //  足坛浪子/环球旅人/横扫五大联赛/无冕之王/三球王/金靴机器/史上最佳/
  //  美洲之王/黑马封王). Each maps to a specific career build, the
  //  "gotta catch 'em all" pull that gives a reason to start runs targeting a gap. ──
  { id: "ah_giant_killer", name: "巨人杀手", desc: "以小球会赢下洲际冠军。", achieved: (g) => g.smallClubContinental },
  { id: "ah_one_club_legend", name: "一生一队", desc: "整个成年生涯只效力一家俱乐部，并赢得联赛、杯赛与洲际冠军。", achieved: (g) => g.oneClubCareer && g.trophies.includes("league") && g.trophies.includes("cup") && g.trophies.includes("continental_primary") },
  { id: "ah_club_servant", name: "功勋球员", desc: "在同一家俱乐部连续效力 10 个成年赛季——可以转会，但你没有。", achieved: (g) => g.longestClubSpell >= 10 },
  { id: "ah_journeyman", name: "足坛浪子", desc: "生涯效力 8 家以上不同俱乐部。", achieved: (g) => g.distinctClubs >= 8 },
  { id: "ah_globetrotter", name: "环球旅人", desc: "在 4 个不同大洲足联的联赛效力过。", achieved: (g) => g.distinctConfederations >= 4 },
  { id: "ah_big_five_sweep", name: "横扫五大联赛", desc: "在五大联赛（英西意德法）都赢过联赛冠军。", achieved: (g) => g.bigFiveLeagueWins >= 5 },
  { id: "ah_ringless", name: "无冕之王", desc: "踢满 8 个赛季却一冠未得。", achieved: (g) => g.trophies.length === 0 && g.seasons >= 8 },
  { id: "ah_pele", name: "三球王", desc: "两度捧起世界杯，生涯轰入 350 球。", achieved: (g) => g.trophies.filter((t) => t === "world_cup").length >= 2 && g.totalGoals >= 350 },
  { id: "ah_golden_boot_machine", name: "金靴机器", desc: "赢得三次金靴。", achieved: (g) => g.awards.filter((a) => a === "golden_boot").length >= 3 },
  { id: "ah_goat", name: "史上最佳", desc: "一次世界杯 + 两次洲际冠军 + 三次金球奖。", achieved: (g) => g.trophies.filter((t) => t === "world_cup").length >= 1 && g.trophies.filter((t) => t === "continental_primary").length >= 2 && g.awards.filter((a) => a === "ballon_dor").length >= 3 },
  { id: "ah_rey_america", name: "美洲之王", desc: "赢下洲际国家队冠军（美洲杯）与洲际冠军（解放者杯）。", achieved: (g) => g.trophies.includes("national_continental") && g.trophies.includes("continental_primary") },
  { id: "ah_underdog_champion", name: "黑马封王", desc: "以弱国身份捧起世界杯。", achieved: (g) => g.trophies.includes("world_cup") && g.nationFifaRep <= 2 },
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
  const totalGoals = seniorCareerStats(game.seasons).goals;
  let smallClubContinental = false;
  let trebleSeason = false;
  // 功勋球员：最长的一段连续同队成年效力。租借/转会打断，回归母队重新起算。
  let spellClub: string | null = null;
  let spell = 0;
  let longestClubSpell = 0;
  for (const s of game.seasons) {
    clubs.add(s.clubId);
    if (s.squadLevel !== "youth") {
      spell = s.clubId === spellClub ? spell + 1 : 1;
      spellClub = s.clubId;
      if (spell > longestClubSpell) longestClubSpell = spell;
    }
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
    seasons: seniorCareerSeasonCount(game.seasons),
    totalGoals,
    distinctClubs: clubs.size,
    distinctConfederations: confs.size,
    oneClubCareer: seniorClubCount(game.seasons) === 1,
    longestClubSpell,
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
  "club_world_cup", "national_continental", "world_cup", "olympic",
];

/** Merge a finished run's trophies + achievements into the persistent
 *  collection, AND accumulate per-type trophy counts + per-achievement career
 *  counts (the "堆叠" the Hall of Fame shows — how many of each, not just
 *  whether). Returns the new save.
 *  Older saves predate the counters — backfill ≥1 from the existing collection
 *  (we only know each collected type was won at least once), then add this
 *  run's trophies (with duplicates) + earned achievements. The backfill is
 *  idempotent: it only fills gaps the counters lack, so it never re-counts. */
export function mergeCollection(meta: MetaSave, g: AchievementInput): MetaSave {
  // Dedupe within this run AND against the existing collection — trophyCollection
  // is a SET of types, so a career that wins 联赛 3× adds the type once (the
  // count is tracked separately in trophyCounts, which reads g.trophies raw).
  const newTrophies = g.trophies.filter((t, i, arr) => arr.indexOf(t) === i && !meta.trophyCollection.includes(t));
  const trophyCollection = newTrophies.length > 0 ? [...meta.trophyCollection, ...newTrophies] : meta.trophyCollection;
  const earnedAch = ACHIEVEMENTS.filter((a) => a.achieved(g)).map((a) => a.id);
  const newAch = earnedAch.filter((a) => !meta.achievementCollection.includes(a));
  const achievementCollection = newAch.length > 0 ? [...meta.achievementCollection, ...newAch] : meta.achievementCollection;

  // 堆叠: cumulative per-type trophy counts + per-achievement career counts.
  const trophyCounts: Record<string, number> = { ...(meta.trophyCounts ?? {}) };
  for (const t of meta.trophyCollection) if (!trophyCounts[t]) trophyCounts[t] = 1;
  for (const t of g.trophies) trophyCounts[t] = (trophyCounts[t] ?? 0) + 1;

  const achievementCounts: Record<string, number> = { ...(meta.achievementCounts ?? {}) };
  for (const id of meta.achievementCollection) if (!achievementCounts[id]) achievementCounts[id] = 1;
  for (const id of earnedAch) achievementCounts[id] = (achievementCounts[id] ?? 0) + 1;

  return { ...meta, trophyCollection, achievementCollection, trophyCounts, achievementCounts };
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
  { id: "pp_comeback_base", name: "涅槃基线",   desc: "永久：30 岁后每次决策 40% 概率回血 +1 OVR（无需浴火重生）。" },
  { id: "pp_oracle_base",   name: "洞察基线",   desc: "永久：成功概率显示到小数点后一位（无需先知之眼）。" },
  { id: "pp_scout",         name: "青训球探",   desc: "永久：20 岁前每两年成长 +1（累计 +2，精英青训营的栽培）。" },
  { id: "pp_boss_slayer",   name: "弑神者",     desc: "永久：决战事件成功概率 +20%。" },
];

export function prestigePerkById(id: string): PrestigePerk | undefined {
  return PRESTIGE_PERKS.find((p) => p.id === id);
}

/** Prestige unlocks once the player owns every blessing AND has banked enough
 *  legacy to make the sacrifice meaningful. 集齐 13 个祝福本身(总价 125000,
 *  ≈250 局)才是轮回的真正门槛; 此阈值不跟总价走(那会变成上千局、几乎不可达),
 *  而是「一个顶级祝福的价钱」——集齐后再攒最贵那件的钱即可献祭, 真正献祭掉的
 *  是整套祝福 + 这笔押金。
 *
 *  P-BLESS-PRICE: 改成从 BLESSINGS 派生而不是写死。上一版写死 15000 时它的
 *  语义注释同样是"一个顶级祝福价位", 但顶级祝福后来涨到别的数, 押金没跟上,
 *  注释和数值就此脱节。派生之后再调价它自动跟随。 */
export const PRESTIGE_LEGACY_THRESHOLD: number = BLESSINGS.reduce((m, b) => Math.max(m, b.cost), 0);
export function prestigeEligible(meta: MetaSave): boolean {
  return meta.ownedBlessings.length >= BLESSINGS.length
    && meta.totalLegacy >= PRESTIGE_LEGACY_THRESHOLD;
}

// ───────────────────────────── prestige price discount ─────────────────────────────

/** 每完成一次轮回, 全部祝福价格再乘一次的系数; 地板 0.40。
 *
 *  轮回会清空 ownedBlessings, 所以第 2 轮要重新攒齐 125000(≈250 局), 第 3 轮
 *  同样, …… 9 个 perk 拿满 ≈ 2250 局。按真实数据里最活跃设备的强度(2 天 26 局)
 *  也要 173 天——那不是循环, 是渐近线。而轮回恰恰是留住「已经玩了一个月」那批
 *  人的唯一机制, 线性重复读起来是惩罚而不是进阶。
 *
 *  折扣让循环收敛: 250 → 213 → 180 → 153 → 130 → 111 → 100(地板) 局,
 *  累计 9 轮约 1340 局, 比线性的 2250 局省 40%, 且每一轮都比上一轮快。献祭的
 *  叙事保住了(你依然失去全部祝福), 但代价是递减的。
 *
 *  地板 0.40 的作用是别让后期轮回变成白送: 最便宜的祝福 5000 × 0.40 = 2000,
 *  按每局 500 仍是 4 局——地板之下祝福就不再是「跨多局的目标」了, 这与
 *  P-BLESS-PRICE 定的 10 局门票精神冲突(那条只约束首轮定价, 但也不该被折扣
 *  稀释到没有重量)。
 *
 *  押金 PRESTIGE_LEGACY_THRESHOLD 不打折: 收藏变便宜, 但「拉下这根拉杆」的
 *  代价不变——否则轮回越多越随手, 献祭就失去了分量。 */
export const PRESTIGE_PRICE_DISCOUNT = 0.85;
export const PRESTIGE_PRICE_FLOOR = 0.40;

/** 第 `prestige` 轮时的价格系数（prestige 0 = 未轮回 = 1.0）。 */
export function prestigePriceMult(prestige: number): number {
  const p = Math.max(0, Math.trunc(prestige));
  return Math.max(PRESTIGE_PRICE_FLOOR, PRESTIGE_PRICE_DISCOUNT ** p);
}

/** 某个祝福在当前存档下的实际售价。取整到百位, 让折后价仍是可读的整数
 *  (10000 × 0.85 = 8500, 而不是 8499.999…)。 */
export function blessingCost(blessing: Blessing, prestige: number): number {
  const mult = prestigePriceMult(prestige);
  if (mult === 1) return blessing.cost;
  return Math.round((blessing.cost * mult) / 100) * 100;
}

/** 当前存档下集齐全部祝福的总价（商店抬头用, 也是折扣是否生效的自检点）。 */
export function blessingsTotalCost(prestige: number): number {
  return BLESSINGS.reduce((s, b) => s + blessingCost(b, prestige), 0);
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
  /** 最佳实绩 — the best single-run 实绩 (ascension-0 score) ever banked, i.e.
   *  the difficulty-independent companion to `bestRun`. `bestRun` is a CURRENCY
   *  high-score and is inflated by ascension, so it must not be fed to a rating
   *  label; this is what 最佳评级 reads. Optional: older saves lack it and fall
   *  back to `bestRun` (a one-time overstatement, not a reset — bumping VERSION
   *  would wipe every player's save). */
  bestRunRaw?: number;
  /** P-ASC-GATES: best single-run legacy per ascension level played (index =
   *  level). Drives per-level unlock gates. Older saves lack it; loadMeta
   *  backfills from the frozen pre-redesign global gates so earned rungs
   *  never re-lock. */
  bestByAscension?: readonly number[];
  /** P-ASC-PREMIUM: rungs earned on the pre-premium score scale, grandfathered
   *  at the v2→v3 migration (the premium curve inflated ASCENSION_UNLOCK_REQ;
   *  re-deriving from old-scale bests would re-lock earned rungs). Only ever
   *  raised, never re-evaluated. */
  ascensionFloor?: number;
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
  /** P6 堆叠: cumulative count of each trophy type won across all runs (the
   *  Hall of Fame "堆叠" — how many of each trophy, not just whether). Older
   *  saves lack this; mergeCollection backfills ≥1 from trophyCollection. */
  trophyCounts?: Readonly<Record<string, number>>;
  /** P6 堆叠: cumulative count of careers that earned each achievement. */
  achievementCounts?: Readonly<Record<string, number>>;
  /** P-A9: sound effects on/off. Default true. */
  soundOn?: boolean;
  /** P-A10: haptic feedback (vibration) on/off. Default true. Independent of
   *  sound — mobile players often want the buzz with the sound muted. */
  hapticsOn?: boolean;
}

export const VERSION = 3;

export function defaultMeta(): MetaSave {
  return {
    version: VERSION, totalLegacy: 0, totalLegacyAllTime: 0, unlocked: [],
    ownedBlessings: [], bestRun: 0, bestByAscension: [], ascensionFloor: 0, ascension: 0, runs: 0, prestige: 0, permPerks: [],
    trophyCollection: [], achievementCollection: [],
    trophyCounts: {}, achievementCounts: {},
  };
}

/** Migrate a v1 save (prestige-less) into the v2 shape without wiping progress. */
export function migrateV1(raw: Record<string, unknown>): MetaSave {
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
    trophyCounts: {},
    achievementCounts: {},
  };
}

/** v2 → v3 (P-ASC-PREMIUM): grandfather the rungs this save had earned under
 *  the pre-premium gate numbers. Runs AFTER normalizeAscensionBests (it reads
 *  bestByAscension). Idempotent — the floor is only ever raised. */
export function migrateV2(meta: MetaSave): MetaSave {
  let floor = 0;
  for (let lvl = 1; lvl < PRE_PREMIUM_UNLOCK_REQ.length; lvl++) {
    if (bestAtOrAbove(meta, lvl - 1) >= PRE_PREMIUM_UNLOCK_REQ[lvl]!) floor = lvl;
    else break;
  }
  return { ...meta, version: VERSION, ascensionFloor: Math.max(floor, meta.ascensionFloor ?? 0) };
}

/** Backfill cumulative counts for saves that predate the counters — a v2 save
 *  with trophyCollection/achievementCollection but no trophyCounts. We can
 *  only guarantee ≥1 per collected type/achievement; mergeCollection refines
 *  with real per-run totals on the next completed run. Idempotent — a save
 *  that already has counts passes through unchanged. */
export function normalizeCounts(meta: MetaSave): MetaSave {
  if (meta.trophyCounts && meta.achievementCounts) return meta;
  const trophyCounts: Record<string, number> = { ...(meta.trophyCounts ?? {}) };
  for (const t of meta.trophyCollection) if (!trophyCounts[t]) trophyCounts[t] = 1;
  const achievementCounts: Record<string, number> = { ...(meta.achievementCounts ?? {}) };
  for (const id of meta.achievementCollection) if (!achievementCounts[id]) achievementCounts[id] = 1;
  return { ...meta, trophyCounts, achievementCounts };
}

/** Backfill `bestByAscension` for saves that predate the per-level unlock
 *  gates. Grandfathering: every rung the save had unlocked under the frozen
 *  global-bestRun rule is re-earned by seeding a qualifying score at each
 *  rung below it — earned unlocks never re-lock. Idempotent. */
export function normalizeAscensionBests(meta: MetaSave): MetaSave {
  if (meta.bestByAscension) return meta;
  let oldMax = 0;
  for (let lvl = 0; lvl < LEGACY_GLOBAL_UNLOCK_REQ.length; lvl++) {
    if (meta.bestRun >= LEGACY_GLOBAL_UNLOCK_REQ[lvl]!) oldMax = lvl;
    else break;
  }
  const seeded: number[] = [];
  for (let k = 0; k < oldMax; k++) seeded[k] = ASCENSION_UNLOCK_REQ[k + 1]!;
  // the save's global best could have been earned at ANY level — crediting it
  // at the selected level would gift an unearned rung. Credit at 0: never
  // over-grants, and the asc-0 readout still reflects the old best.
  seeded[0] = Math.max(seeded[0] ?? 0, meta.bestRun);
  return { ...meta, bestByAscension: seeded };
}

/** Apply a finished run's legacy to the persistent save, returning the new save.
 *  `runAscension` records the per-level best that drives ascension unlocks. */
export function applyRunResult(meta: MetaSave, runLegacy: number, runAscension = 0, runRawLegacy?: number): MetaSave {
  const totalLegacy = meta.totalLegacy + runLegacy;
  const totalLegacyAllTime = meta.totalLegacyAllTime + runLegacy;
  const bestRun = Math.max(meta.bestRun, runLegacy);
  // 最佳实绩 tracks the ascension-0 score separately — see MetaSave.bestRunRaw.
  const bestRunRaw = Math.max(meta.bestRunRaw ?? meta.bestRun, runRawLegacy ?? runLegacy);
  const byAsc = [...(meta.bestByAscension ?? [])];
  byAsc[runAscension] = Math.max(byAsc[runAscension] ?? 0, runLegacy);
  const runs = meta.runs + 1;
  // unlock anything newly reached — gated on lifetime legacy so prestige never re-locks.
  const newlyUnlocked = UNLOCKS.filter((u) => !meta.unlocked.includes(u.id) && totalLegacyAllTime >= u.reqLegacy).map((u) => u.id);
  const unlocked = [...meta.unlocked, ...newlyUnlocked];
  return { ...meta, totalLegacy, totalLegacyAllTime, bestRun, bestRunRaw, bestByAscension: byAsc, runs, unlocked };
}

export function purchaseBlessing(meta: MetaSave, blessingId: string): MetaSave | null {
  const b = blessingById(blessingId);
  if (!b) return null;
  if (meta.ownedBlessings.includes(blessingId)) return null;
  // 轮回折扣: 结算与判定都走 blessingCost, 不能读 b.cost —— 否则商店显示折后价、
  // 扣款按原价, 或者反过来。价格只有一个真相来源。
  const cost = blessingCost(b, meta.prestige);
  if (meta.totalLegacy < cost) return null;
  return {
    ...meta,
    totalLegacy: meta.totalLegacy - cost,
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
  /** 飞升难度 (0 = base) — surfaced on the archive card so the two boards
   *  (server + personal) show the same difficulty context. */
  readonly ascension?: number;
  /** Equipped blessing ids as a CSV — the BUILD this career played with, so
   *  other players can learn from a top run. Empty/absent for old archives and
   *  custom/daily runs (no loadout equipped). */
  readonly loadout?: string;
  // v2 rich fields — the same numbers the cloud leaderboard shows, so the
  // personal archive renders with the SAME honor-led card as the server board.
  // Optional: careers archived before these fields existed deserialize without
  // them and degrade gracefully (the card omits the missing line). Keeping the
  // archive on its :v1 key (no version bump) preserves every existing entry.
  readonly clubCount?: number;
  readonly goals?: number;
  readonly assists?: number;
  readonly appearances?: number;
  readonly cleanSheets?: number;
  readonly goalsConceded?: number;
  readonly wonWorldCup?: boolean;
  readonly wonBallonDor?: boolean;
  readonly wonGoldenBoot?: boolean;
  readonly wonGoldenGlove?: boolean;
}

export function isUnlocked(meta: MetaSave, id: string): boolean {
  // An item not listed in UNLOCKS has no cumulative-legacy gate, so it is
  // always available — gate 0, not Infinity (which made every non-listed
  // blessing like 金童/铁肺 show "需解锁" forever and stay unbribable).
  return meta.unlocked.includes(id) || meta.totalLegacyAllTime >= (UNLOCKS.find((u) => u.id === id)?.reqLegacy ?? 0);
}

// ───────────────────────────── debut console draft (persisted menu config) ─────────────────────────────
// The debut console's player-identity + career config (name, number, nation,
// position, academy club, pace). Persisted so a page refresh restores the last
// configuration the player was working with instead of resetting to defaults —
// the menu no longer forgets who you were creating. Deliberately a SEPARATE
// store from lastSetup (the last STARTED run's full RunSetup): that one carries
// stale meta-driven fields (blessings/ascension/perks) and only updates on run
// start; this is the live, player-editable surface, saved on every change.
// The seed is intentionally NOT persisted: random mode must stay "fresh seed
// each session", and a lingering custom-seed mode would silently make every
// refreshed run non-settling (no meta rewards). Pace uses the inline union so
// this layer need not import PaceMode from engine/run (which already imports
// FROM here — a cycle the layered architecture forbids).

export interface SetupDraft {
  readonly nationalityId: string;
  readonly position: Position;
  /** The debut console no longer picks an academy club — the player chooses it
   *  as the first in-game event. Kept optional only so old drafts (written
   *  before this change) parse without error; ignored by the menu. */
  readonly clubId?: string;
  /** Inline union (not the engine/run PaceMode type) to keep this layer
   *  dependency-free of engine/run — see the section header. */
  readonly pace: "long" | "normal" | "express";
  readonly playerName: string;
  readonly squadNumber: number | null;
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
export function rollDevProfile(seed: string, isGK: boolean, allowWonderkid: boolean, youthTier = 1): DevProfile {
  if (isGK) return "normal";
  // thresholds: 18% early, 33% late, 10% wonderkid, else normal (39%).
  // P-DEV-SHAPE: wonderkid 窗口 39% → 10%。旧值让「天才」成了最常见的档位, 而且
  // 它吃掉的是 normal——normal 从 49% 被挤到 10%, 丢掉了注释里写明的「49% 玩家
  // 的地板保护」身份。天才要稀有才叫天才; 窗口让回去之后 normal 回到 39%。
  // 强度由 DEV_TABLES.wonderkid 单独调(见 data.ts P-DEV-SHAPE): 抽取率决定多少
  // 人抽到, 成长表决定抽到的人过得怎么样——两个旋钮, 不要混用。
  // P-NATION: 出身国青训档位缩窄 wonderkid 窗口 (T5 ×0.5 → ~5%)——缩窗不
  // 封死,弱国天才照出,只是更稀有 (概率弯曲,不是墙)。
  const v = hash(`${seed}:development-profile`) / 4294967296;
  if (v < 0.18) return "early";
  if (v < 0.51) return "late";
  const wonderkidWindow = 0.10 * (WONDERKID_WEIGHT[youthTier] ?? 1);
  if (allowWonderkid && v < 0.51 + wonderkidWindow) return "wonderkid";
  return "normal";
}

/** Default starting position list (some locked until unlocks). */
export function startingPositions(): readonly Position[] {
  return ["GK", "CB", "LB", "RB", "CDM", "CM", "LM", "RM", "CAM", "LW", "RW", "ST"];
}
