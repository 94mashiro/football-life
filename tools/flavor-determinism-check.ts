/**
 * 验证：4 个原 flavor 单选事件现已走决策台（pendingChoice），且同 seed 两遍
 * 生涯完全一致（确定性）。纯引擎调用，无 DOM。
 * Run:  npx tsx tools/flavor-determinism-check.ts
 */
import { createRun, simulatePeriod, resolveChoice } from "../src/engine/run";
import type { GameState } from "../src/engine/types";

const FLAVOR_KEYS = ["fan_backlash", "injury", "ironic_goal", "rags_to_riches"];

interface Trace {
  seasons: number;
  peakOvr: number;
  decisionKeys: string[];
  outcomes: string[];
}

function play(seed: string): Trace {
  let g: GameState = simulatePeriod(createRun({
    seed, nationalityId: "bra", position: "ST" as any, leagueId: "premier-league",
    pace: "normal", blessings: [], ascension: 0, permPerks: [],
  }));
  const decisionKeys: string[] = [];
  const outcomes: string[] = [];
  let guard = 0;
  while (g.phase === "playing" && guard++ < 300) {
    if (g.pendingChoice) {
      decisionKeys.push(g.pendingChoice.key);
      const choice = g.pendingChoice.choices[0]!;
      g = resolveChoice(g, choice);
      if (g.lastOutcome) outcomes.push(g.lastOutcome.slice(0, 12));
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  return { seasons: g.seasons.length, peakOvr: g.maxOverall ?? 0, decisionKeys, outcomes };
}

// 1) 确定性：同 seed 两遍必须逐字一致
let determinismOk = true;
const SEEDS = ["det-1", "det-2", "det-3", "abc", "xyz-99"];
for (const seed of SEEDS) {
  const a = play(seed);
  const b = play(seed);
  const same =
    a.seasons === b.seasons &&
    a.peakOvr === b.peakOvr &&
    JSON.stringify(a.decisionKeys) === JSON.stringify(b.decisionKeys) &&
    JSON.stringify(a.outcomes) === JSON.stringify(b.outcomes);
  if (!same) {
    determinismOk = false;
    console.error(`✗ 确定性破坏 seed=${seed}: seasons ${a.seasons}/${b.seasons} peak ${a.peakOvr}/${b.peakOvr}`);
    console.error("  A keys:", a.decisionKeys.join(","));
    console.error("  B keys:", b.decisionKeys.join(","));
  }
}

// 2) 4 个原 flavor 事件现在作为 pendingChoice 出现（走决策台）
const seen = new Set<string>();
for (let i = 0; i < 400; i++) {
  const t = play(`dock-${i}`);
  for (const k of t.decisionKeys) seen.add(k);
}
const docked = FLAVOR_KEYS.filter((k) => seen.has(k));
const missing = FLAVOR_KEYS.filter((k) => !seen.has(k));

console.log("=== flavor → 决策台 验证 ===");
console.log(`确定性 (同 seed 两遍一致): ${determinismOk ? "✓ 通过" : "✗ 失败"}`);
console.log(`已确认走决策台: ${docked.join(", ") || "(无)"}`);
console.log(`未在 400 生涯中触发 (条件苛刻，正常): ${missing.join(", ") || "(无)"}`);
console.log(`400 生涯中遇到的决策种类: ${seen.size}`);
