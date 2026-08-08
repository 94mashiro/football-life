/** Blessing balance probe: is each build-defining blessing worth its cost?
 *  Run the SAME setup with no blessing vs each blessing (solo) and compare
 *  meta legacy. A blessing that barely moves legacy (relative to its cost) is
 *  a trap; one that dominates is a no-brainer (the loadout choice is illusory).
 *  Goal: each blessing earns back roughly its cost in extra legacy over a
 *  career, with build-defining ones (glass_cannon, big_game_player) creating
 *  distinct arcs not just bigger numbers. */
import { createRun, simulatePeriod, resolveChoice, legacyEarnMult } from "../src/engine/run";
import { scoreLegacy, BLESSINGS } from "../src/meta/legacy";

const NCAREERS = 400;
const BLESSINGS_TO_TEST = [
  "golden_boy", "sharpshooter", "oracle", "comeback", "loyal_club",
  "glass_cannon", "big_game_player", "late_bloomer", "mercenary", "iron_lungs",
];

function runOne(seed: string, blessings: readonly string[]): { meta: number; peak: number; } {
  let g = createRun({ seed, nationalityId: "bra", position: "ST" as const, leagueId: "premier-league", pace: "normal", blessings, ascension: 0, permPerks: [] });
  g = simulatePeriod(g); let n = 0;
  while (g.phase === "playing" && n++ < 200) {
    if (g.pendingChoice) { g = resolveChoice(g, g.pendingChoice.choices[0]!); if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g); }
    else g = simulatePeriod(g);
  }
  const wage = g.seasons.reduce((s, x) => s + (x.wage ?? 0), 0);
  const mv = g.seasons.length > 0 ? (g.seasons[g.seasons.length - 1]!.marketValue ?? 0) : 0;
  const meta = scoreLegacy(g.maxOverall, g.seasons.length, g.trophies, g.awards, g.ascension, g.retirementReason, g.challenge, wage, mv, g.eventLegacy ?? 0, legacyEarnMult(g.blessings ?? [], g.permPerks ?? []), 1, g.player?.position, g.seasons.reduce((s, x) => s + x.stats.goals, 0), g.seasons.reduce((s, x) => s + x.stats.assists, 0), g.seasons.reduce((s, x) => s + x.stats.cleanSheets, 0));
  return { meta, peak: g.maxOverall ?? 0 };
}
function hash(i: number): string { let h = 2166136261 ^ i; h = Math.imul(h, 16777619) >>> 0; return `bl-${i}-${h.toString(36)}`; }
function med(a: number[]): number { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2); }
function avg(a: number[]): number { return Math.round(a.reduce((s, x) => s + x, 0) / a.length); }

const baseMetas: number[] = []; const basePeaks: number[] = [];
for (let i = 0; i < NCAREERS; i++) { const o = runOne(hash(i), []); baseMetas.push(o.meta); basePeaks.push(o.peak); }
const baseMed = med(baseMetas), baseAvg = avg(baseMetas), basePeakAvg = avg(basePeaks);
console.log(`no blessing: meta med=${baseMed} avg=${baseAvg}  peak avg=${basePeakAvg}`);
console.log("blessing            cost   meta-med  meta-avg  Δmed(vs base)  Δavg   ROI(Δavg/cost)  peak-avg");
for (const b of BLESSINGS_TO_TEST) {
  const cost = BLESSINGS.find((x) => x.id === b)?.cost ?? 0;
  const metas: number[] = []; const peaks: number[] = [];
  for (let i = 0; i < NCAREERS; i++) { const o = runOne(hash(i), [b]); metas.push(o.meta); peaks.push(o.peak); }
  const m = med(metas), a = avg(metas), pa = avg(peaks);
  const dMed = m - baseMed, dAvg = a - baseAvg;
  const roi = (dAvg / cost).toFixed(2);
  console.log(`${b.padEnd(20)} ${String(cost).padStart(4)}   ${String(m).padStart(7)}   ${String(a).padStart(7)}    ${dMed >= 0 ? "+" : ""}${String(dMed).padStart(4)}      ${dAvg >= 0 ? "+" : ""}${String(dAvg).padStart(4)}   ${roi.padStart(6)}       ${pa}`);
}
