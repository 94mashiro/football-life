/** Ascension economy probe: measure raw difficulty loss, effective payout,
 *  career length, and realized reward multiplier across all rungs. `raw`
 *  scores the same finished career at ascension 0, separating performance
 *  from the performance-gated ascension reward. */
import { createRun, simulatePeriod, resolveChoice, liveLegacy } from "../src/engine/run";
import { ascensionLegacyMultiplier } from "../src/meta/legacy";


const NCAREERS = 400;
const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function runOne(seed: string, asc: number): { meta: number; raw: number; peak: number; age: number; seasons: number; } {
  let g = createRun({ seed, nationalityId: "bra", position: "ST" as const, leagueId: "premier-league", pace: "normal", blessings: [], ascension: asc, permPerks: [] });
  g = simulatePeriod(g); let n = 0;
  while (g.phase === "playing" && n++ < 200) {
    if (g.pendingChoice) { g = resolveChoice(g, g.pendingChoice.choices[0]!); if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g); }
    else g = simulatePeriod(g);
  }
  // 传承一律走 liveLegacy（引擎自己的唯一入口）——手抄 17 个位置参数曾把已删除的
  // g.eventLegacy 塞进 dignifiedExit 槽位，静默算错传承。
  const score = (ascForScore: number) => liveLegacy({ ...g, ascension: ascForScore });
  // Score the identical finished career without ascension reward. This stays
  // exact even though the effective multiplier now depends on raw performance.
  const meta = score(g.ascension);
  const raw = score(0);
  return { meta, raw, peak: g.maxOverall ?? 0, age: g.age, seasons: g.seasons.length };
}
function hash(i: number): string { let h = 2166136261 ^ i; h = Math.imul(h, 16777619) >>> 0; return `asc-${i}-${h.toString(36)}`; }
function med(a: number[]): number { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2); }

for (const asc of LEVELS) {
  const metas: number[] = []; const raws: number[] = []; const peaks: number[] = []; const seasons: number[] = []; let p90 = 0;
  for (let i = 0; i < NCAREERS; i++) {
    const o = runOne(hash(i), asc);
    metas.push(o.meta); raws.push(o.raw); peaks.push(o.peak); seasons.push(o.seasons);
    if (o.peak >= 90) p90++;
  }
  const sorted = [...metas].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor(NCAREERS * p)];
  const rawMedian = med(raws);
  console.log(`asc ${String(asc).padStart(2)}: meta med=${med(metas)} raw med=${rawMedian} realized ×${ascensionLegacyMultiplier(asc, rawMedian).toFixed(2)} peak med=${med(peaks)} seasons med=${med(seasons)} | p55=${q(0.55)} p60=${q(0.60)} p65=${q(0.65)} p70=${q(0.70)} p75=${q(0.75)} p85=${q(0.85)} p90=${q(0.90)} | 90+ ${(100 * p90 / NCAREERS).toFixed(1)}%`);
}
