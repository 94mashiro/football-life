/**
 * Climax boss invariant check — the 国家队大赛 events settle the HONOR line only.
 *
 * Two lines, kept apart on purpose (owner decision): a national-team final may
 * decide whether you lift the cup, but it must never touch OVR — one final
 * should not be able to wreck a whole career build.
 *
 * Asserts, for all three showdowns and both options:
 *   1. no OVR modifier on any branch (immediate / permanent / deferred)
 *   2. every option carries a visible win% + a win/lose preview pill pair
 *      (the odds-are-the-hero rule; the boss used to show no number at all)
 *   3. neither option is strictly dominated — :a trades a real cost (输了俱乐部
 *      赛季陪葬) for a higher win rate, so both picks are defensible
 *
 * Run: npx vite build --config tools/vite.climax.config.ts && node tools/dist/climax-check.js
 */
import { worldCupShowdown, worldCupQualifierShowdown, continentalCupShowdown } from "../src/engine/events";
import type { FiredEvent } from "../src/engine/events";
import { derive } from "../src/engine/rng";

const CASES: readonly (readonly [string, FiredEvent])[] = [
  ["world_cup_showdown", worldCupShowdown(27, 0.3, "世界杯冠军", "功亏一篑", [], "巴西")],
  ["world_cup_qualifier_showdown", worldCupQualifierShowdown(23, 0.5, true, 0, [], "巴西")],
  ["continental_cup_showdown", continentalCupShowdown(26, 0.3, "AFC", [], "中国")],
];

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) { failures++; console.error(`FAIL ${msg}`); }
};

for (const [key, fired] of CASES) {
  for (const choice of fired.event.choices) {
    const label = `${key}:${choice.id}`;

    // 2. the odds and both branches of the gamble are on the card.
    //    预览模型是 certain（必定发生）+ roll（胜/负各自独有的后果），不是早期
    //    那个扁平的 choice.preview 二元组——这个断言曾对着已删除的字段跑了很久，
    //    一直红，而红的是探针不是游戏。tools/ 现在纳入 tsc，这类漂移会当场编译报错。
    check(/^\d+(\.\d+)?%$/.test(choice.sub ?? ""), `${label} sub 不是胜率 %：${choice.sub}`);
    const roll = choice.roll;
    check(roll !== undefined, `${label} 没有 roll 预览（决战必须是明牌赌注）`);
    check((roll?.win.length ?? 0) > 0 && (roll?.lose.length ?? 0) > 0, `${label} 缺少胜/负预览药丸`);

    // 1. neither branch may move OVR — 100 independent resolve streams.
    for (let i = 0; i < 100; i++) {
      const m = fired.resolve(choice, derive("climax-check", key, choice.id, i), "climax-check").mods;
      const ovr = (m.immediateOverallDelta ?? 0) + (m.permanentOverallDelta ?? 0) + (m.deferredOverallDelta ?? 0);
      if (ovr !== 0) { check(false, `${label} 动了 OVR：${ovr}`); break; }
    }
  }

  // 3. :a must buy its higher win rate with a cost, or it is a trap in reverse.
  const [a, b] = fired.event.choices;
  const oddsOf = (c: typeof a) => Number((c?.sub ?? "0%").replace("%", ""));
  check(oddsOf(a) > oddsOf(b), `${key} :a 的胜率没有高于 :b（${oddsOf(a)}% vs ${oddsOf(b)}%）`);
  const loseLabels = (c: typeof a) => [...(c?.roll?.lose ?? []), ...(c?.certain ?? [])]
    .filter((p) => !p.good).map((p) => p.label).sort().join("+");
  const aLose = loseLabels(a), bLose = loseLabels(b);
  check(aLose !== bLose, `${key} :a 失败没有额外代价，:b 被完全支配（两边都是「${aLose}」）`);
}

console.log(failures === 0 ? "climax-check: OK" : `climax-check: ${failures} 项不通过`);
if (failures > 0) process.exit(1);
