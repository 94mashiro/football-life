// 位置巅峰偏移探针 (P-POS): 各位置的巅峰年龄 / 衰退起点是否真的分开了
import { createRun, simulatePeriod, resolveChoice, liveLegacy, type RunSetup } from "../src/engine/run";
import { randomSeed } from "../src/meta/legacy";
import type { GameState, Choice, Position } from "../src/engine/types";
let _s = 0x9e3779b9;
const rn = () => { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; };
const h = (s: string) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; };
const ri = (lo: number, hi: number) => lo + Math.floor((rn() / 4294967296) * (hi - lo + 1));
const PER = Number(process.argv[2] ?? 500);
const POSITIONS: Position[] = ["CB", "CDM", "CM", "ST", "LW", "GK"];
for (const pos of POSITIONS) {
  const peakAges: number[] = []; const peaks: number[] = []; const retireAges: number[] = []; const legacies: number[] = []; let ballon = 0;
  for (let i = 0; i < PER; i++) {
    const seed = randomSeed(); _s = 0x9e3779b9 ^ h(seed) ^ h(pos);
    const rs: RunSetup = { seed, nationalityId: "eng", position: pos, leagueId: "premier-league", blessings: [], ascension: 0, pace: "normal" };
    let g: GameState = simulatePeriod(createRun(rs)); let guard = 0;
    while (g.phase === "playing" && guard++ < 400) {
      if (g.pendingChoice) { const ch = g.pendingChoice.choices; const p: Choice = ch.length > 1 ? ch[ri(0, ch.length - 1)]! : ch[0]!;
        g = resolveChoice(g, p); if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g); } else g = simulatePeriod(g);
    }
    let best = -1, bestAge = 0, last = 0;
    for (const s of g.seasons) { if (s.overall > best) { best = s.overall; bestAge = s.age; } last = s.age; }
    if (best > 0) { peakAges.push(bestAge); peaks.push(best); retireAges.push(last); legacies.push(liveLegacy(g)); if (g.awards.includes("ballon_dor")) ballon++; }
  }
  const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)] ?? 0;
  console.log(`${pos.padEnd(4)} 巅峰年龄 中位${q(peakAges, 0.5)} (p25 ${q(peakAges, 0.25)} p75 ${q(peakAges, 0.75)}) | 巅峰总评 中位${q(peaks, 0.5)} | 退役 中位${q(retireAges, 0.5)} | 传承 中位${q(legacies, 0.5)} | 金球 ${(ballon / Math.max(1, peaks.length) * 100).toFixed(1)}%`);
}
