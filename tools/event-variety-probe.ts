/**
 * Probe: how many DISTINCT decision events does ONE career actually surface,
 * and which event repeats the most? (The "来来回回就五六个" feel question.)
 *
 * Picks ch[0] deterministically (so the spread is the engine's, not the
 * picker's). Tallies per-career distinct decision keys + the max repeat
 * count of any single key, then prints the distribution + the aggregate
 * top events.
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { randomSeed } from "../src/meta/legacy";
import type { GameState, Choice } from "../src/engine/types";

let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const N = 400;
const SETUP: RunSetup = { seed: "", nationalityId: "bra", position: "ST", leagueId: "brasileirao", blessings: [], ascension: 0, pace: "normal" };

const agg: Record<string, number> = {};
const distinctHist: Record<number, number> = {};
const maxRepeatHist: Record<number, number> = {};
const perCareerTransfer: number[] = [];
let careers = 0;
let totalDecisions = 0;

for (let i = 0; i < N; i++) {
  const seed = randomSeed();
  _s = 0x9e3779b9 ^ hash32(seed);
  let g: GameState = simulatePeriod(createRun({ ...SETUP, seed }));
  const seen: Record<string, number> = {};
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const ch = g.pendingChoice.choices;
      if (ch.length > 1) {
        const key = g.pendingChoice.key;
        seen[key] = (seen[key] ?? 0) + 1;
        agg[key] = (agg[key] ?? 0) + 1;
        totalDecisions++;
        const pick: Choice = ch[rint(0, ch.length - 1)]!;
        g = resolveChoice(g, pick);
        if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
      } else {
        // single-choice -> flavor, auto-resolve to advance
        const pick = ch[0]!;
        g = resolveChoice(g, pick);
        if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
      }
    } else {
      g = simulatePeriod(g);
    }
  }
  careers++;
  const distinct = Object.keys(seen).length;
  const maxRepeat = Object.values(seen).reduce((m, v) => Math.max(m, v), 0);
  distinctHist[distinct] = (distinctHist[distinct] ?? 0) + 1;
  maxRepeatHist[maxRepeat] = (maxRepeatHist[maxRepeat] ?? 0) + 1;
  perCareerTransfer.push(seen["transfer"] ?? 0);
}

const sumDistinct = Object.entries(distinctHist).reduce((s, [k, v]) => s + Number(k) * v, 0);
const sumMaxRep = Object.entries(maxRepeatHist).reduce((s, [k, v]) => s + Number(k) * v, 0);
const sumTransfer = perCareerTransfer.reduce((s, v) => s + v, 0);

console.log(`N=${N} careers · ${totalDecisions} multi-choice decisions total · ${(totalDecisions / N).toFixed(1)} decisions/career`);
console.log(`\n--- PER-CAREER FEEL ---`);
console.log(`avg DISTINCT decision events per career: ${(sumDistinct / N).toFixed(2)}`);
console.log(`avg MAX-REPEAT (the one event you see most): ${(sumMaxRep / N).toFixed(2)}`);
console.log(`avg transfers per career: ${(sumTransfer / N).toFixed(2)}`);
console.log(`\ndistinct-events-per-career histogram (k events : how many careers):`);
for (const k of Object.keys(distinctHist).map(Number).sort((a, b) => a - b)) {
  console.log(`  ${String(k).padStart(2)} : ${distinctHist[k]}`);
}
console.log(`\nmax-repeat-per-career histogram (k repeats of top event : how many careers):`);
for (const k of Object.keys(maxRepeatHist).map(Number).sort((a, b) => a - b)) {
  const bar = "█".repeat(maxRepeatHist[k]);
  console.log(`  ${String(k).padStart(2)} : ${String(maxRepeatHist[k]).padStart(3)} ${bar}`);
}
console.log(`\n--- AGGREGATE TOP 20 (across all ${N} careers) ---`);
const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted.slice(0, 20)) {
  console.log(`  ${k.padEnd(30)} ${String(v).padStart(5)}  ${(100 * v / totalDecisions).toFixed(1)}% of decisions  · fired in ${Math.round(100 * v / N)}% of careers`);
}
console.log(`\ntotal distinct decision keys seen across all careers: ${sorted.length}`);
