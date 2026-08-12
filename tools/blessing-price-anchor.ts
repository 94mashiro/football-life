/**
 * 祝福定价锚探针：输出 a0-a10 各档的 steady 策略产出（中位/p75/p90），
 * 用于根据真实产出曲线重新校准祝福价格。
 * 策略与 ascension-economy-check.ts 的 steadyPolicy 一致（转会拣星+其余选第一项）。
 */
import { clubById } from "../src/engine/data";
import type { Choice, GameState } from "../src/engine/types";
import { drive, POLICIES, corpusSeed, quantile, type Policy, type Profile, type CareerTrace } from "./_harness";

const N = Number(process.argv[2] ?? 160);
const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const profile = (asc: number): Profile => ({
  id: `steady-a${asc}`,
  nationalityId: "bra",
  position: "ST",
  leagueId: "premier-league",
  pace: "normal",
  blessings: [],
  ascension: asc,
  allowWonderkid: false,
  permPerks: [],
});

function clubStars(choice: Choice, state: GameState): number {
  if (choice.id !== "stay" && choice.kind !== "stay") return (choice.sub ?? "").split("★").length - 1;
  try {
    const reputation = clubById(state.currentClubId).rep;
    return reputation >= 8 ? 5 : reputation >= 6 ? 4 : reputation >= 4 ? 3 : reputation >= 2 ? 2 : 1;
  } catch {
    return 0;
  }
}

const steadyPolicy: Policy = (choices, key, periodIndex, seed, state) => {
  if (state && (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer")) {
    return choices.reduce((best, choice) => clubStars(choice, state) > clubStars(best, state) ? choice : best, choices[0]!);
  }
  return POLICIES.first(choices, key, periodIndex, seed, state);
};

function sample(asc: number): CareerTrace[] {
  const traces: CareerTrace[] = [];
  for (let i = 0; i < N; i++) traces.push(drive(`bp-${corpusSeed(i)}`, profile(asc), steadyPolicy, `steady-a${asc}`));
  return traces;
}

const rows: { asc: number; med: number; p75: number; p90: number; mean: number }[] = [];
for (const asc of LEVELS) {
  const t = sample(asc);
  const leg = t.map((x) => x.legacy);
  rows.push({
    asc,
    med: quantile(leg, 0.5),
    p75: quantile(leg, 0.75),
    p90: quantile(leg, 0.9),
    mean: Math.round(leg.reduce((a, b) => a + b, 0) / leg.length),
  });
}

console.log(`祝福定价锚 · N=${N}/cell · steady 策略 (转会拣星+其余第一项)`);
console.log("asc | median | p75 | p90 | mean | ratio-to-a0");
const a0med = rows[0]!.med;
for (const r of rows) {
  console.log(
    ` a${String(r.asc).padStart(2)} | ${String(r.med).padStart(5)} | ${String(r.p75).padStart(5)} | ${String(r.p90).padStart(5)} | ${String(r.mean).padStart(5)} | ×${(r.med / a0med).toFixed(3)}`,
  );
}

// 加权平均：假设玩家在各档停留的局数权重（攀登旅程模型）。
// 模型 A：均匀停留（每档同样局数）—— 最简单的参考线。
const uniformAvg = rows.reduce((s, r) => s + r.med, 0) / rows.length;
// 模型 B：低档多、高档少（指数衰减权重 a0..a10: 11,10,9,...,1 归一化）
const decayW = LEVELS.map((_, i) => 11 - i);
const decaySum = decayW.reduce((a, b) => a + b, 0);
const decayAvg = rows.reduce((s, r, i) => s + r.med * decayW[i]!, 0) / decaySum;
// 模型 C：只看 a0-a3（多数祝福在低档买齐的窗口）
const lowAvg = rows.slice(0, 4).reduce((s, r) => s + r.med, 0) / 4;

console.log(`\n加权中位产出:`);
console.log(`  均匀 a0-a10 中位 = ${Math.round(uniformAvg)}`);
console.log(`  衰减 a0-a10 中位 = ${Math.round(decayAvg)} (低档权重高)`);
console.log(`  低档 a0-a3  中位 = ${Math.round(lowAvg)}`);
console.log(`  a0 真人锚 (云端) = 473`);
