import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { randomSeed } from "../src/meta/legacy";
import type { GameState, Choice } from "../src/engine/types";

let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const N = 200;
let totalPeriods = 0, silent = 0, flavor = 0, decisions = 0;
const decisionKeys: Record<string, number> = {};
const silentRunLens: number[] = [];

for (let i = 0; i < N; i++) {
  const seed = randomSeed();
  _s = 0x9e3779b9 ^ hash32(seed);
  const setup: RunSetup = { seed, nationalityId: "bra", position: "ST", leagueId: "brasileirao", blessings: [], ascension: 0, pace: "normal" };
  let g: GameState = simulatePeriod(createRun(setup));
  let runSilent = 0, guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const ch = g.pendingChoice.choices;
      totalPeriods++;
      if (ch.length > 1) {
        decisions++;
        decisionKeys[g.pendingChoice.key] = (decisionKeys[g.pendingChoice.key] ?? 0) + 1;
      } else {
        flavor++;
      }
      const pick: Choice = ch.length > 1 ? ch[rint(0, ch.length - 1)]! : ch[0]!;
      g = resolveChoice(g, pick);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      totalPeriods++;
      silent++;
      runSilent++;
      g = simulatePeriod(g);
    }
  }
  silentRunLens.push(runSilent);
}

console.log(`N=${N} · total periods ${totalPeriods} · per run ${(totalPeriods / N).toFixed(1)}`);
console.log(`silent ${silent} (${Math.round(silent / totalPeriods * 100)}%) · flavor ${flavor} (${Math.round(flavor / totalPeriods * 100)}%) · decisions ${decisions} (${Math.round(decisions / totalPeriods * 100)}%)`);
console.log(`median silent periods/run: ${[...silentRunLens].sort((a, b) => a - b)[Math.floor(N / 2)]}`);
console.log(`\ndecision breakdown:`);
for (const [k, v] of Object.entries(decisionKeys).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v} (${Math.round(v / decisions * 100)}% of decisions, ${Math.round(v / N * 100)}% of runs)`);
