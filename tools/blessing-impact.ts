/**
 * Blessing impact probe (correct figure): measures each blessing's SOLO
 * impact on the REAL settle figure `liveLegacy(g)` — the exact number the
 * store banks at retirement (career-end scoreLegacy with position-perf +
 * earnMult + loyal_club bonus). Mirrors legacy-dist.ts. Older blessing-probe.ts
 * used a stale scoreLegacy signature; this one is authoritative.
 *
 * For each blessing: run the SAME seed list with [] vs [blessing], random
 * (unguided) choices, across several setups. Report median/avg Δ and the
 * with/without gap as % of base — the "can the player SEE the blessing" metric.
 *
 * Run:  npx tsx tools/blessing-impact.ts [N=200]
 */
import { createRun, simulatePeriod, resolveChoice, liveLegacy, type RunSetup } from "../src/engine/run";
import { BLESSINGS } from "../src/meta/legacy";
import type { GameState, Choice } from "../src/engine/types";

const N = Number(process.argv[2] ?? 200);

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
// ST (goals drive trophies+awards), CM (creator), CB (defender), GK (shutouts) — covers the
// position-weighted legacy paths so no blessing is judged only on the attacker axis.
const SETUPS: Setup[] = [
  { nation: "bra", pos: "ST", league: "brasileirao", label: "BRA ST 巴甲" },
  { nation: "bra", pos: "ST", league: "premier-league", label: "BRA ST 英超" },
  { nation: "eng", pos: "CM", league: "premier-league", label: "ENG CM 英超" },
  { nation: "ita", pos: "CB", league: "serie-a", label: "ITA CB 意甲" },
  { nation: "ger", pos: "GK", league: "bundesliga", label: "GER GK 德甲" },
];

function playOne(seed: string, s: Setup, blessings: readonly string[]): number {
  _s = 0x9e3779b9 ^ hash32(seed + blessings.join(","));
  const setup: RunSetup = { seed, nationalityId: s.nation, position: s.pos, leagueId: s.league, blessings, ascension: 0, pace: "normal", permPerks: [] };
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

function med(a: number[]): number { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2); }
function avg(a: number[]): number { return Math.round(a.reduce((s, x) => s + x, 0) / a.length); }

// build the seed list once (same seeds for base + every blessing → paired comparison)
const seeds: string[] = [];
for (const s of SETUPS) for (let i = 0; i < N; i++) seeds.push(`${s.label}#${i}`);

console.log(`# blessing solo-impact on liveLegacy (the real settle figure)`);
console.log(`# N=${N} careers per setup · ${SETUPS.length} setups · ${seeds.length} total · asc 0 · normal · random (unguided) choices\n`);

// baseline: no blessings
const baseArr: number[] = [];
for (const s of SETUPS) {
  const legs: number[] = [];
  for (let i = 0; i < N; i++) legs.push(playOne(`${s.label}#${i}`, s, []));
  baseArr.push(...legs);
}
const baseMed = med(baseArr), baseAvg = avg(baseArr);
console.log(`no blessing     : med ${baseMed} · avg ${baseAvg}`);
console.log("");
console.log("blessing            cost   med     avg     Δmed   Δavg   gap%   peak-Δavg   ROI(Δavg/cost)");
console.log("------------------ ----   ------  ------   -----  -----  -----  ----------   -------------");

const ALL = BLESSINGS.map((b) => b.id);
for (const b of ALL) {
  const cost = BLESSINGS.find((x) => x.id === b)?.cost ?? 0;
  const arr: number[] = [];
  for (const s of SETUPS) {
    for (let i = 0; i < N; i++) arr.push(playOne(`${s.label}#${i}`, s, [b]));
  }
  const m = med(arr), a = avg(arr);
  const dMed = m - baseMed, dAvg = a - baseAvg;
  const gapPct = ((a - baseAvg) / baseAvg * 100).toFixed(1);
  const roi = cost > 0 ? (dAvg / cost).toFixed(2) : "—";
  console.log(`${b.padEnd(18)} ${String(cost).padStart(4)}   ${String(m).padStart(6)}  ${String(a).padStart(6)}   ${dMed >= 0 ? "+" : ""}${String(dMed).padStart(5)}  ${dAvg >= 0 ? "+" : ""}${String(dAvg).padStart(5)}  ${gapPct.padStart(5)}%   ${roi.padStart(8)}`);
}
