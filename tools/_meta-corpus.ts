/**
 * 元进程指纹 —— 生涯语料库覆盖不到的那一半。
 *
 * `drive()` 跑的是「一局生涯里发生了什么」，元进程（祝福价格、飞升门槛、
 * 解锁阈值、计分公式、成就判定、每日种子）是纯查表和纯函数，跑生涯
 * 碰不到，改坏了也没人发现——`scoreLegacy` 里改一个系数、`ASCENSION_UNLOCK_REQ`
 * 里挪一档，跑 3600 局也可能一点异常都看不出来。
 *
 * 这里把这些纯函数在一张固定输入网格上求值，按 section 各出一枚指纹。
 * 纯计算，毫秒级，直接跑在 regress 主进程里。
 *
 * 刻意排除：读写 localStorage 的（loadMeta/saveMeta/loadArchive…）、
 * 以及不确定的（randomSeed 用 Math.random、todayStr 用当前日期）。
 */
import {
  BLESSINGS, ASCENSIONS, ASCENSION_UNLOCK_REQ, UNLOCKS, ACHIEVEMENTS,
  PRESTIGE_PERKS, PRESTIGE_LEGACY_THRESHOLD, LEGEND_DRAFTS, FREE_NATIONS, MAX_LOADOUT,
  PRESTIGE_PRICE_DISCOUNT, PRESTIGE_PRICE_FLOOR, prestigePriceMult, blessingsTotalCost,
  ASCENSION_REWARD_CURVES, applyAscensionLegacyReward,
  DIGNIFIED_EXIT_MULT, ascensionLegacyMultiplier, defaultMeta, scoreLegacy, legacyRank, careerGrade, isUnlocked,
  maxAscensionUnlocked, bestAtOrAbove, rollDevProfile, dailySetup,
  prestigeEligible,
  resolveLoadout, startingPositions, type MetaSave,
} from "../src/meta/legacy";
import { legacyEarnMult } from "../src/engine/run";
import { hash } from "../src/engine/rng";
import type { Trophy, Award } from "../src/engine/types";

const h = (parts: unknown[]): string => hash(JSON.stringify(parts)).toString(36).padStart(7, "0");

const TROPHY_SETS: Trophy[][] = [
  [], ["league"], ["league", "cup"], ["continental_primary"], ["world_cup"],
  ["world_cup", "continental_primary", "league", "league", "league"],
];
const AWARD_SETS: Award[][] = [[], ["golden_boot"], ["ballon_dor"], ["ballon_dor", "ballon_dor", "golden_boot"]];
const REASONS = [null, "voluntary", "faded", "no_offers", "injury", "journeyman"];

function synthMeta(totalLegacy: number, best: number, runs: number): MetaSave {
  return { ...defaultMeta(), totalLegacy, totalLegacyAllTime: totalLegacy, bestRun: best, runs,
    bestByAscension: [best, Math.round(best * 0.8), Math.round(best * 0.6), 0, 0, 0, 0, 0, 0, 0] };
}

/** 每个 section 一枚指纹 —— 报告能直接指出「动的是解锁阈值」还是「动的是计分公式」。 */
export function metaFingerprint(): readonly { section: string; digest: string }[] {
  const out: { section: string; digest: string }[] = [];
  const add = (section: string, v: unknown[]) => out.push({ section, digest: h(v) });

  // ── 静态平衡表：改一个价格/门槛/阈值都在这里显形 ──
  add("blessings", [BLESSINGS, MAX_LOADOUT]);
  add("ascensions", [ASCENSIONS, ASCENSION_UNLOCK_REQ]);
  add("ascension-reward", [
    ASCENSION_REWARD_CURVES,
    // 网格取样盖住曲线的每一段: 锚点之间 + 尾段斜率 + 大数值高手尾部。
    ASCENSION_REWARD_CURVES.flatMap((_, ascension) =>
      [100, 150, 200, 300, 400, 600, 900, 1500, 3000].map((raw) => [
        applyAscensionLegacyReward(raw, ascension),
        +ascensionLegacyMultiplier(ascension, raw).toFixed(6),
      ])),
  ]);
  add("unlocks", [UNLOCKS, FREE_NATIONS]);
  add("achievements", [ACHIEVEMENTS]);
  add("prestige", [PRESTIGE_PERKS, PRESTIGE_LEGACY_THRESHOLD]);
  // 轮回价格折扣 —— 每一轮的系数 + 每一轮的全套总价。总价那一列是自检:
  // 折扣若哪天被绕过(比如某处又直接读 b.cost), 系数不变但总价会露馅。
  add("prestige-discount", [
    PRESTIGE_PRICE_DISCOUNT, PRESTIGE_PRICE_FLOOR,
    Array.from({ length: 10 }, (_, p) => +prestigePriceMult(p).toFixed(6)),
    Array.from({ length: 10 }, (_, p) => blessingsTotalCost(p)),
  ]);
  add("legend-drafts", [LEGEND_DRAFTS]);
  add("positions", [startingPositions()]);

  // ── 计分公式：网格求值，任何系数变化都会翻这枚指纹 ──
  const scores: number[] = [];
  for (const ovr of [55, 70, 80, 88, 95]) {
    for (const seasons of [3, 12, 20, 26]) {
      for (const tr of TROPHY_SETS) for (const aw of AWARD_SETS) {
        for (const asc of [0, 3, 7, 9]) for (const reason of REASONS) {
          scores.push(Math.round(scoreLegacy(ovr, seasons, tr, aw, asc, reason)));
          scores.push(Math.round(scoreLegacy(ovr, seasons, tr, aw, asc, reason, 50_000, 120)));
        }
      }
    }
  }
  add("score-legacy", [scores, DIGNIFIED_EXIT_MULT]);

  // 体面退场倍率单独一枚：它是「主动挂靴」整条设计线的支点。
  const dignified: number[] = [];
  for (const ovr of [70, 85, 93]) for (const seasons of [10, 18, 24]) for (const dig of [false, true]) {
    dignified.push(Math.round(scoreLegacy(ovr, seasons, ["league"], ["golden_boot"], 0, "voluntary", undefined, undefined, dig)));
  }
  add("dignified-exit", [dignified]);

  add("legacy-rank", [[0, 100, 500, 1500, 4000, 9000, 20000, 60000].map((s) => [legacyRank(s), careerGrade(s)])]);

  // ── 传承倍率（run.ts 侧）：祝福/威望 perk 的收益斜率 ──
  const mults: number[] = [];
  for (const b of [[], ["marketable"], ["loyal_club"], ["marketable", "sharpshooter"]]) {
    for (const p of [[], ...PRESTIGE_PERKS.map((x) => [x.id])]) mults.push(+legacyEarnMult(b, p).toFixed(6));
  }
  add("legacy-earn-mult", [mults]);

  // ── 解锁 / 飞升门槛：跨传承档位扫一遍 ──
  const gates: unknown[] = [];
  for (const legacy of [0, 300, 1000, 3000, 6000, 12000, 30000, 80000]) {
    const m = synthMeta(legacy, Math.round(legacy / 3), 10);
    // prestigeChoices() 洗牌用的是 Math.random（威望商店的即时随机），不可比对；
    // 这里只取它抽样的「候选池」——池子是平衡决策，洗牌是玩家侧随机。
    const prestigePool = PRESTIGE_PERKS.filter((p) => !m.permPerks.includes(p.id)).map((p) => p.id);
    gates.push([legacy, maxAscensionUnlocked(m), bestAtOrAbove(m, 2), prestigeEligible(m),
      UNLOCKS.map((u) => isUnlocked(m, u.id)), prestigePool,
      resolveLoadout({ ...m, ownedBlessings: BLESSINGS.map((b) => b.id) })]);
  }
  add("unlock-gates", [gates]);

  // ── 成长档抽取（确定性，按 seed）──
  const dev: unknown[] = [];
  for (let i = 0; i < 60; i++) {
    for (const gk of [false, true]) for (const wk of [false, true]) for (const yt of [1, 2, 3]) {
      dev.push(rollDevProfile(`meta-corpus-${i}`, gk, wk, yt));
    }
  }
  add("dev-profile", [dev]);

  // ── 每日挑战：固定日期 → 固定 setup（不用当前日期，否则指纹每天都变）。
  // dailyStreak 刻意不收：它内部读 new Date()，收进来指纹每过一天就假红一次。 ──
  add("daily", [["2026-01-01", "2026-02-29", "2026-06-15", "2026-08-10", "2026-12-31"].map((d) => dailySetup(d))]);

  return out;
}
