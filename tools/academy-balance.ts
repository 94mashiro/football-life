/** Academy balance — man-city academy careers, reports peak/seasons/legacy/reason
 *  + forced-exit age so we can see the 踢不出来 timing shift without wrecking
 *  careers that would have developed. Run: npx tsx tools/academy-balance.ts [N=400] [clubId=man-city] */
import { createRun, simulatePeriod, resolveChoice, liveLegacy, type RunSetup } from "../src/engine/run";
import type { GameState, Choice } from "../src/engine/types";

const N = Number(process.argv[2] ?? 400);
const clubId = String(process.argv[3] ?? "man-city");
let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function pickChoice(g: GameState): Choice { const ch = g.pendingChoice!.choices; return ch.length === 1 ? ch[0]! : ch[rint(0, ch.length - 1)]!; }

const peaks: number[] = [], seas: number[] = [], ages: number[] = [], legs: number[] = [];
const reasons: Record<string, number> = {};
let stuckAge: number[] = [];
let developed = 0; // peak >= 80 (broke through)

for (let i = 0; i < N; i++) {
  _s = 0x9e3779b9 ^ hash32(`ac-${i}`);
  const setup: RunSetup = { seed: `ac-${i}-${hash32(`ac-${i}`)}`, nationalityId: "eng", position: "ST", leagueId: "premier-league", blessings: [], ascension: 0, pace: "normal", clubId };
  let g = simulatePeriod(createRun(setup));
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      if (g.pendingChoice.key === "stuck_release" || g.pendingChoice.key === "underperform_release") stuckAge.push(g.age);
      g = resolveChoice(g, pickChoice(g));
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else g = simulatePeriod(g);
  }
  peaks.push(g.maxOverall); seas.push(g.seasons.length); ages.push(g.age);
  legs.push(liveLegacy(g));
  reasons[g.retirementReason ?? "?"] = (reasons[g.retirementReason ?? "?"] ?? 0) + 1;
  if (g.maxOverall >= 80) developed++;
}
const pct = (a: number[], p: number) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const med = (a: number[]) => pct(a, 0.5);
const ge = (a: number[], t: number) => Math.round(a.filter(x => x >= t).length / a.length * 100);
console.log(`# academy balance · ${clubId} · N=${N}`);
console.log(`peak: median ${med(peaks)} · ≥80 ${ge(peaks,80)}% · ≥85 ${ge(peaks,85)}% · ≥90 ${ge(peaks,90)}%  (broke-through ≥80: ${developed})`);
console.log(`seasons: median ${med(seas)} · p10 ${pct(seas,0.1)} · <8 (short) ${Math.round(seas.filter(s=>s<8).length/N*100)}%`);
console.log(`retireAge: median ${med(ages)} · p10 ${pct(ages,0.1)} · p90 ${pct(ages,0.9)}`);
console.log(`legacy: median ${med(legs)} · p10 ${pct(legs,0.1)} · p90 ${pct(legs,0.9)} · ≥300 ${ge(legs,300)}%`);
console.log(`reason: ${Object.entries(reasons).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${v}(${Math.round(v/N*100)}%)`).join(" · ")}`);
console.log(`forced-exit age (stuck/underperform): median ${med(stuckAge)} · ≤21 ${Math.round(stuckAge.filter(a=>a<=21).length/(stuckAge.length||1)*100)}% · ≥25 ${Math.round(stuckAge.filter(a=>a>=25).length/(stuckAge.length||1)*100)}% · histogram ${histo(stuckAge)}`);
function histo(arr: number[]): string { const b: Record<number, number> = {}; for (const a of arr) b[a]=(b[a]??0)+1; return Object.entries(b).sort((a,b)=>Number(a[0])-Number(b[0])).map(([k,v])=>`${k}:${v}`).join(" "); }
