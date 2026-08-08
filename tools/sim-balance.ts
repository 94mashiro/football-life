/**
 * Balance sim harness — runs N full careers headlessly and prints outcome
 * distributions. The engine is pure (no React/localStorage at the sim path),
 * so we drive createRun → simulatePeriod → resolveChoice the same way the
 * store does, picking a RANDOM choice at each decision (the unguided-new-player
 * baseline the prior meta-progression audit used).
 *
 * Run:  npx tsx tools/sim-balance.ts [N=200] [nation=bra] [pos=ST] [league=brasileirao] [asc=0] [pace=normal]
 *
 * Find optimization points by reading outliers: % reaching 90+, WC win rate,
 * retirement-reason mix, career-length dead zones. Determinism of the SIM is
 * untouched — only our choice picker uses its own RNG (the harness, not the engine).
 */
import { createRun, simulatePeriod, resolveChoice, legacyEarnMult, type RunSetup } from "../src/engine/run";
import { scoreLegacy } from "../src/meta/legacy";
import { clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const args = process.argv.slice(2);
const N = Number(args[0] ?? 200);
const nation = String(args[1] ?? "bra");
const pos = String(args[2] ?? "ST") as RunSetup["position"];
const league = String(args[3] ?? "brasileirao");
const asc = Number(args[4] ?? 0);
const pace = String(args[5] ?? "normal") as RunSetup["pace"];
// mode: "random" (unguided new player) | "skilled" (strong blessing loadout +
// greedy transfer-up + wonderkid — proxies a competent asc-climber so high
// ascension isn't misjudged by random/no-blessing play).
const mode = String(args[6] ?? "random");
const SKILLED_BLESSINGS = ["sharpshooter", "glass_cannon", "big_game_player"];

// tiny xorshift32 for reproducible choice picking (harness-only, never the engine)
let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));

/** Pick a choice. Skilled mode climbs the transfer ladder (highest-rep offer,
 *  or stay if already at a bigger club than every offer) and takes the active
 *  option on club decisions; narrative events stay random (no model of which
 *  narrative choice is "best"). Rep is read as the ★ count in each choice's
 *  sub — transfer offers use indexed ids (club-0/1/2), so the sub is the only
 *  place the offered club's strength appears. */
function pickChoice(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  if (ch.length === 1) return ch[0]!;
  const key = g.pendingChoice!.key;
  if (mode === "skilled" && (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer")) {
    const stayStars = (() => { try { const r = clubById(g.currentClubId).rep; return r >= 8 ? 5 : r >= 6 ? 4 : r >= 4 ? 3 : r >= 2 ? 2 : 1; } catch { return 0; } })();
    const stars = (c: Choice) => c.id === "stay" ? stayStars : (c.sub ?? "").split("★").length - 1;
    let best = 0, bs = -1;
    for (let i = 0; i < ch.length; i++) { const s = stars(ch[i]!); if (s > bs) { bs = s; best = i; } }
    return ch[best]!;
  }
  return ch[rint(0, ch.length - 1)]!;
}

interface RunResult {
  peak: number; seasons: number; retireAge: number; reason: string;
  trophies: number; wc: boolean; ballon: boolean; legacy: number;
  loans: number; transfers: number; decisions: number;
}

function playOne(seed: string): RunResult {
  _s = 0x9e3779b9 ^ hash32(seed);  // reseed per run
  const setup: RunSetup = {
    seed, nationalityId: nation, position: pos, leagueId: league,
    blessings: mode === "skilled" ? SKILLED_BLESSINGS : [],
    ascension: asc, pace, allowWonderkid: mode === "skilled",
  };
  let g: GameState = simulatePeriod(createRun(setup));
  let loans = 0, transfers = 0, decisions = 0, guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const ch = g.pendingChoice.choices;
      const pick: Choice = ch.length > 1 ? pickChoice(g) : ch[0]!;
      if (ch.length > 1) {
        decisions++;
        if (g.pendingChoice.key === "transfer" || g.pendingChoice.key === "wage_squeeze") transfers++;
        if (g.pendingChoice.key === "loan_offer" || g.pendingChoice.key === "post_loan") loans++;
      }
      g = resolveChoice(g, pick);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  const wageTotal = g.seasons.reduce((s, x) => s + (x.wage ?? 0), 0);
  const finalMv = g.seasons.length > 0 ? (g.seasons[g.seasons.length - 1]!.marketValue ?? 0) : 0;
  const paceMult = g.pace === "express" ? 0.85 : 1;
  const legacy = scoreLegacy(g.maxOverall, g.seasons.length, g.trophies, g.awards, g.ascension, g.retirementReason, g.challenge, wageTotal, finalMv, g.eventLegacy ?? 0, legacyEarnMult(g.blessings ?? [], g.permPerks ?? []), paceMult);
  return {
    peak: g.maxOverall, seasons: g.seasons.length, retireAge: g.age, reason: g.retirementReason ?? "?",
    trophies: g.trophies.length, wc: g.trophies.includes("world_cup"), ballon: g.awards.includes("ballon_dor"),
    legacy, loans, transfers, decisions,
  };
}

function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
function median(arr: number[]): number { return pct(arr, 0.5); }

const runs: RunResult[] = [];
const t0 = Date.now();
for (let i = 0; i < N; i++) runs.push(playOne(`bal-${i}-${hash32(`bal-${i}`)}`));  // deterministic — reproducible A/B
const dt = Date.now() - t0;

const peaks = runs.map(r => r.peak);
const seas = runs.map(r => r.seasons);
const ages = runs.map(r => r.retireAge);
const legs = runs.map(r => r.legacy);
const tcount = runs.map(r => r.trophies);

const reasonMix: Record<string, number> = {};
for (const r of runs) reasonMix[r.reason] = (reasonMix[r.reason] ?? 0) + 1;

console.log(`# balance sim · N=${N} · ${nation}/${pos}/${league} · asc ${asc} · ${pace} · ${mode} · ${dt}ms`);
console.log(`peak OVR: median ${median(peaks)} · p10 ${pct(peaks,0.1)} · p90 ${pct(peaks,0.9)} · ≥90 ${pct1(peaks,90)}% · ≥85 ${pct1(peaks,85)}% · ≥80 ${pct1(peaks,80)}%`);
console.log(`seasons : median ${median(seas)} · p10 ${pct(seas,0.1)} · p90 ${pct(seas,0.9)} · <8seasons (short career) ${pctLt(seas,8)}%`);
console.log(`retireAge: median ${median(ages)} · p10 ${pct(ages,0.1)} · p90 ${pct(ages,0.9)}`);
console.log(`retire reason: ${Object.entries(reasonMix).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${v}(${Math.round(v/N*100)}%)`).join(" · ")}`);
console.log(`trophies: 0-trophy ${pctEq(tcount,0)}% · median ${median(tcount)} · ≥3 ${pctGe(tcount,3)}%`);
console.log(`world_cup: ${runs.filter(r=>r.wc).length} (${Math.round(runs.filter(r=>r.wc).length/N*100)}%) · ballon_dor: ${runs.filter(r=>r.ballon).length} (${Math.round(runs.filter(r=>r.ballon).length/N*100)}%)`);
console.log(`legacy: median ${median(legs)} · p10 ${pct(legs,0.1)} · p90 ${pct(legs,0.9)} · ≥300 ${pctGe(legs,300)}%`);
console.log(`decisions: median ${median(runs.map(r=>r.decisions))} · transfers median ${median(runs.map(r=>r.transfers))} · loans median ${median(runs.map(r=>r.loans))} · careers with a loan ${pctGt(runs.map(r=>r.loans),0)}%`);

// ending-variety cross-tab: of careers ending "no_offers", how many actually
// had a solid career (peak/trophies/length) that "无人问津，黯然离场" mislabels?
const noOff = runs.filter(r => r.reason === "no_offers");
console.log(`\n# no_offers ending breakdown (n=${noOff.length}):`);
console.log(`  peak ≥80: ${pct1(noOff.map(r=>r.peak),80)}% · peak ≥75: ${pct1(noOff.map(r=>r.peak),75)}% · trophies ≥3: ${pctGe(noOff.map(r=>r.trophies),3)}% · seasons ≥18: ${pctGe(noOff.map(r=>r.seasons),18)}%`);
console.log(`  would move to "faded" if (peak≥80 OR trophies≥3): ${Math.round(noOff.filter(r=>r.peak>=80||r.trophies>=3).length/noOff.length*100)}% of no_offers (${noOff.filter(r=>r.peak>=80||r.trophies>=3).length}/${noOff.length})`);
console.log(`  would move to "faded" if (peak≥80 OR (trophies≥3 AND seasons≥18)): ${Math.round(noOff.filter(r=>r.peak>=80||(r.trophies>=3&&r.seasons>=18)).length/noOff.length*100)}% of no_offers (${noOff.filter(r=>r.peak>=80||(r.trophies>=3&&r.seasons>=18)).length}/${noOff.length})`);

function pct1(arr: number[], thr: number): number { return Math.round(arr.filter(x=>x>=thr).length/arr.length*100); }
function pctLt(arr: number[], thr: number): number { return Math.round(arr.filter(x=>x<thr).length/arr.length*100); }
function pctGe(arr: number[], thr: number): number { return Math.round(arr.filter(x=>x>=thr).length/arr.length*100); }
function pctGt(arr: number[], thr: number): number { return Math.round(arr.filter(x=>x>thr).length/arr.length*100); }
function pctEq(arr: number[], thr: number): number { return Math.round(arr.filter(x=>x===thr).length/arr.length*100); }
