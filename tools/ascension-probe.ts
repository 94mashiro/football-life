/** Ascension economy probe: is the ×(1+0.15L) reward worth the stacked
 *  penalties? Measure meta legacy + 90+ + retire age across ascension levels
 *  for the same setup. If legacy/minute collapses at high ascension, the climb
 *  isn't worth it (the StS "win to climb" loop breaks). */
import { createRun, simulatePeriod, resolveChoice, legacyEarnMult } from "../src/engine/run";
import { scoreLegacy } from "../src/meta/legacy";

const NCAREERS = 400;
const LEVELS = [0, 3, 5, 7];

function runOne(seed: string, asc: number): { meta: number; peak: number; age: number; seasons: number; } {
  let g = createRun({ seed, nationalityId: "bra", position: "ST" as const, leagueId: "premier-league", pace: "normal", blessings: [], ascension: asc, permPerks: [] });
  g = simulatePeriod(g); let n = 0;
  while (g.phase === "playing" && n++ < 200) {
    if (g.pendingChoice) { g = resolveChoice(g, g.pendingChoice.choices[0]!); if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g); }
    else g = simulatePeriod(g);
  }
  const wage = g.seasons.reduce((s, x) => s + (x.wage ?? 0), 0);
  const mv = g.seasons.length > 0 ? (g.seasons[g.seasons.length - 1]!.marketValue ?? 0) : 0;
  const meta = scoreLegacy(g.maxOverall, g.seasons.length, g.trophies, g.awards, g.ascension, g.retirementReason, g.challenge, wage, mv, g.eventLegacy ?? 0, legacyEarnMult(g.blessings ?? [], g.permPerks ?? []), 1, g.player?.position, g.seasons.reduce((s, x) => s + x.stats.goals, 0), g.seasons.reduce((s, x) => s + x.stats.assists, 0), g.seasons.reduce((s, x) => s + x.stats.cleanSheets, 0));
  return { meta, peak: g.maxOverall ?? 0, age: g.age, seasons: g.seasons.length };
}
function hash(i: number): string { let h = 2166136261 ^ i; h = Math.imul(h, 16777619) >>> 0; return `asc-${i}-${h.toString(36)}`; }
function med(a: number[]): number { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2); }

for (const asc of LEVELS) {
  const metas: number[] = []; let p90 = 0, age90 = 0, seasons90 = 0;
  for (let i = 0; i < NCAREERS; i++) {
    const o = runOne(hash(i), asc);
    metas.push(o.meta);
    if (o.peak >= 90) { p90++; age90 += o.age; seasons90 += o.seasons; }
  }
  const sorted = [...metas].sort((a, b) => a - b);
  console.log(`asc ${asc}: meta med=${med(metas)} avg=${Math.round(metas.reduce((s, x) => s + x, 0) / NCAREERS)} p10=${sorted[Math.floor(NCAREERS * 0.1)]} p90=${sorted[Math.floor(NCAREERS * 0.9)]}  | 90+ = ${p90}/${NCAREERS} (${(100 * p90 / NCAREERS).toFixed(1)}%)${p90 > 0 ? ` avg-90+ retireAge=${(age90 / p90).toFixed(1)} seasons=${(seasons90 / p90).toFixed(1)}` : ""}`);
}
