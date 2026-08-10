/** Ascension economy probe: is the ×(1+0.05L) reward worth the stacked
 *  penalties? Measure meta legacy + 90+ + retire age across ascension levels
 *  for the same setup. `raw` scores with ascension=0 to separate DIFFICULTY
 *  (raw drop) from REWARD (multiplier) — the ladder is only honest when raw
 *  falls monotonically and effective meta rises only mildly. */
import { createRun, simulatePeriod, resolveChoice, liveLegacy } from "../src/engine/run";


const NCAREERS = 400;
const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function runOne(seed: string, asc: number): { meta: number; raw: number; peak: number; age: number; seasons: number; } {
  let g = createRun({ seed, nationalityId: "bra", position: "ST" as const, leagueId: "premier-league", pace: "normal", blessings: [], ascension: asc, permPerks: [] });
  g = simulatePeriod(g); let n = 0;
  while (g.phase === "playing" && n++ < 200) {
    if (g.pendingChoice) { g = resolveChoice(g, g.pendingChoice.choices[0]!); if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g); }
    else g = simulatePeriod(g);
  }
  const wage = g.seasons.reduce((s, x) => s + (x.wage ?? 0), 0);
  const mv = g.seasons.length > 0 ? (g.seasons[g.seasons.length - 1]!.marketValue ?? 0) : 0;
  // 传承一律走 liveLegacy（引擎自己的唯一入口）——手抄 17 个位置参数曾把已删除的
  // g.eventLegacy 塞进 dignifiedExit 槽位，静默算错传承。
  const score = (ascForScore: number) => liveLegacy({ ...g, ascension: ascForScore });
  // raw = effective meta with the reward multiplier divided back out.
  const meta = score(g.ascension);
  return { meta, raw: Math.round(meta / (1 + g.ascension * 0.05)), peak: g.maxOverall ?? 0, age: g.age, seasons: g.seasons.length };
}
function hash(i: number): string { let h = 2166136261 ^ i; h = Math.imul(h, 16777619) >>> 0; return `asc-${i}-${h.toString(36)}`; }
function med(a: number[]): number { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2); }

for (const asc of LEVELS) {
  const metas: number[] = []; const raws: number[] = []; const peaks: number[] = []; let p90 = 0;
  for (let i = 0; i < NCAREERS; i++) {
    const o = runOne(hash(i), asc);
    metas.push(o.meta); raws.push(o.raw); peaks.push(o.peak);
    if (o.peak >= 90) p90++;
  }
  const sorted = [...metas].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor(NCAREERS * p)];
  console.log(`asc ${String(asc).padStart(2)}: meta med=${med(metas)} raw med=${med(raws)} peak med=${med(peaks)} | p55=${q(0.55)} p60=${q(0.60)} p65=${q(0.65)} p70=${q(0.70)} p75=${q(0.75)} p85=${q(0.85)} p90=${q(0.90)} | 90+ ${(100 * p90 / NCAREERS).toFixed(1)}%`);
}
