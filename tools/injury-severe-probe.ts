import { createRun, simulatePeriod, resolveChoice } from "../src/engine/run";
import type { GameState } from "../src/engine/types";

const SETUP = { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal" as const, ascension: 0, blessings: [] as string[], label: "基线 BRA ST normal" };
const SETUP_GC = { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal" as const, ascension: 0, blessings: ["glass_cannon"], label: "玻璃大炮" };
const SETUP_LONG = { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "long" as const, ascension: 0, blessings: [] as string[], label: "long(1决策/季)" };
const NC = 300;

function runOne(seed: string, s: { nationalityId: string; position: string; leagueId: string; pace: "long" | "normal" | "express"; ascension: number; blessings: string[]; label: string }) {
  let g: GameState = simulatePeriod(createRun({ seed, nationalityId: s.nationalityId, position: s.position as any, leagueId: s.leagueId, pace: s.pace, blessings: s.blessings, ascension: s.ascension, permPerks: [] }));
  let totalInj = 0, severeType = 0, guard = 0;
  while (g.phase === "playing" && guard++ < 300) {
    if (g.pendingChoice) {
      const k = g.pendingChoice.key;
      if (k === "injury") {
        totalInj++;
        // 重伤类型判定:看 desc 里的严重度——injury 事件 desc 含"重伤"
        // 但 buildEvent 用 ctx.injuryType。改用更稳的:injuryDelta 通过 outcome 文本
        // 不可靠。直接看 pendingChoice.desc 是否含"重"。实际上 injury 事件 desc 固定
        // "你受伤了。"——拿不到类型。改为统计 severe(继续用 severeInjuries 维度)。
      }
      const ch = g.pendingChoice.choices[0];
      if (!ch) break;
      g = resolveChoice(g, ch);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else g = simulatePeriod(g);
  }
  return { totalInj, severeCount: g.severeInjuries ?? 0 };
}

for (const s of [SETUP, SETUP_LONG, SETUP_GC]) {
  let sumInj = 0, sumSev = 0, n = 0;
  const sevBuckets: Record<number, number> = {};
  for (let i = 0; i < NC; i++) {
    const r = runOne(`s-${i}-${(2166136261 ^ i)>>>0}`, s);
    sumInj += r.totalInj; sumSev += r.severeCount; n++;
    sevBuckets[r.severeCount] = (sevBuckets[r.severeCount] ?? 0) + 1;
  }
  console.log(`\n=== ${s.label} (${n} careers) ===`);
  console.log(`平均伤病事件/生涯: ${(sumInj/n).toFixed(2)}   平均 severe(计入重伤,含拖重)/生涯: ${(sumSev/n).toFixed(2)}`);
  // severe 的来源:continue 抽到重伤类型(15%/25%权重) + play_through 失败(55%)
  // 一次伤病事件触发 severe 的概率 ≈ P(重伤类型) + P(轻伤)×P(硬上)×P(失败)
  // 但玩家可能选 continue(不硬上)——探针自动选 choice[0]=continue,故 severe 几乎只来自重伤类型
  console.log(`severe(重伤)次数分布:`);
  for (const k of Object.keys(sevBuckets).map(Number).sort((a,b)=>a-b)) {
    console.log(`   ${k}次: ${sevBuckets[k]} (${(100*sevBuckets[k]/n).toFixed(1)}%)`);
  }
}
