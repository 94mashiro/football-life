// 巅峰虚高幅度: 固定种子跑到退役, 报 maxOverall 与「账本最高行」的分布
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import type { GameState, Choice } from "../src/engine/types";

let _s = 1;
function rnext() { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));

const N = Number(process.argv[2] ?? 400);
const ASC = Number(process.argv[3] ?? 5);
const peaks: number[] = [], legacies: number[] = [];
let drift = 0, driftN = 0;

for (let i = 0; i < N; i++) {
  _s = 0x9e3779b9 ^ ((i + 1) * 2654435761);
  const rs: RunSetup = { seed: `probe-${i}`, nationalityId: "fra", position: "ST", leagueId: "ligue-1", blessings: [], ascension: ASC, pace: "normal" };
  let g: GameState = simulatePeriod(createRun(rs));
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingChoice) {
      const ch = g.pendingChoice.choices;
      const pick: Choice = ch.length > 1 ? ch[rint(0, ch.length - 1)]! : ch[0]!;
      g = resolveChoice(g, pick);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else g = simulatePeriod(g);
  }
  const gridMax = g.seasons.reduce((m, s) => Math.max(m, s.overall), 0);
  peaks.push(g.maxOverall);
  legacies.push(g.legacy ?? 0);
  if (g.maxOverall > gridMax) { drift += g.maxOverall - gridMax; driftN++; }
}
const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)] ?? 0;
console.log(`asc=${ASC} n=${N} | 巅峰 中位${q(peaks, 0.5)} p90 ${q(peaks, 0.9)} | 传承 中位${q(legacies, 0.5)} p90 ${q(legacies, 0.9)} | 虚高生涯 ${(driftN / N * 100).toFixed(1)}% 平均+${driftN ? (drift / driftN).toFixed(2) : 0}`);
