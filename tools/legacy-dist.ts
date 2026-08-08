/**
 * Per-run legacy distribution probe — the calibration baseline for blessing
 * pricing. Runs N full careers headlessly and reports the distribution of the
 * EXACT figure the store banks at settle: liveLegacy(g) (career-end
 * scoreLegacy with position-perf + earnMult + loyal_club bonus, the same call
 * settleRun uses). The older sim-balance.ts used a stale scoreLegacy signature
 * that dropped position-perf legacy and defaulted position=ST — undercounting
 * the real award, so it was the wrong number to price against.
 *
 * Random choice at each decision = the unguided-new-player baseline (matches
 * sim-balance's "random" mode). Run across several setups so the median isn't
 * dominated by one nation/position/league.
 *
 * Run:  npx tsx tools/legacy-dist.ts [N=300]
 */
import { createRun, simulatePeriod, resolveChoice, liveLegacy, type RunSetup } from "../src/engine/run";
import type { GameState, Choice } from "../src/engine/types";

const N = Number(process.argv[2] ?? 300);

// tiny xorshift32 for reproducible choice picking (harness-only, never the engine)
let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));

function pickChoice(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  return ch.length === 1 ? ch[0]! : ch[rint(0, ch.length - 1)]!;
}

function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

interface Setup { nation: string; pos: RunSetup["position"]; league: string; label: string; }
const SETUPS: Setup[] = [
  { nation: "bra", pos: "ST", league: "brasileirao", label: "BRA ST 巴甲" },
  { nation: "bra", pos: "ST", league: "premier-league", label: "BRA ST 英超" },
  { nation: "eng", pos: "CM", league: "premier-league", label: "ENG CM 英超" },
  { nation: "ita", pos: "CB", league: "serie-a", label: "ITA CB 意甲" },
  { nation: "ger", pos: "GK", league: "bundesliga", label: "GER GK 德甲" },
];

function playOne(seed: string, s: Setup): number {
  _s = 0x9e3779b9 ^ hash32(seed);
  const setup: RunSetup = { seed, nationalityId: s.nation, position: s.pos, leagueId: s.league, blessings: [], ascension: 0, pace: "normal", permPerks: [] };
  let g: GameState = simulatePeriod(createRun(setup));
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      g = resolveChoice(g, pickChoice(g));
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else g = simulatePeriod(g);
  }
  return liveLegacy(g);
}

function pct(arr: number[], p: number): number { const ss = [...arr].sort((a, b) => a - b); return ss[Math.min(ss.length - 1, Math.floor(ss.length * p))]!; }
function med(arr: number[]): number { return pct(arr, 0.5); }

const allLegs: number[] = [];
console.log("# per-run legacy distribution (liveLegacy = the real settle figure)");
console.log(`# N=${N} careers per setup · asc 0 · normal pace · no blessings · random (unguided) choices\n`);
for (const s of SETUPS) {
  const legs: number[] = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) legs.push(playOne(`ld-${i}-${hash32(`ld-${s.label}-${i}`)}`, s));
  allLegs.push(...legs);
  const dt = Date.now() - t0;
  console.log(`${s.label.padEnd(14)} median ${med(legs)} · p10 ${pct(legs,0.1)} · p25 ${pct(legs,0.25)} · p75 ${pct(legs,0.75)} · p90 ${pct(legs,0.9)} · max ${Math.max(...legs)} · ${dt}ms`);
}
console.log(`\n${"ALL SETUPS".padEnd(14)} median ${med(allLegs)} · p10 ${pct(allLegs,0.1)} · p25 ${pct(allLegs,0.25)} · p50 ${med(allLegs)} · p75 ${pct(allLegs,0.75)} · p90 ${pct(allLegs,0.9)} · max ${Math.max(...allLegs)} · n=${allLegs.length}`);
console.log(`\n# pricing reference (runs-to-afford = price / median-per-run):`);
console.log(`#   10-run blessing  ≈ ${med(allLegs) * 10}   25-run ≈ ${med(allLegs) * 25}   50-run ≈ ${med(allLegs) * 50}`);
