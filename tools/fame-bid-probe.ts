/**
 * Fame-bid probe — validates the P-RETIRE elite-aging-star fix: a still-elite
 * player (OVR ≥ FAME_BID_OVR=85) whose retention roll fails routes to the
 * 金元邀约 (fame_league_bid) transfer event, NOT 无人问津 (no_offers). The
 * genuine fade (OVR < 85) still lands no_offers.
 *
 * Invariant under test: NO `no_offers` event fire ever has OVR ≥ 85.
 *
 * Run: npx tsx tools/fame-bid-probe.ts [N=3000] [nation=eng] [pos=ST] [league=epl] [asc=0] [pace=normal] [blessing=golden_boy]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const args = process.argv.slice(2);
const N = Number(args[0] ?? 3000);
const nation = String(args[1] ?? "eng");
const pos = String(args[2] ?? "ST") as RunSetup["position"];
const league = String(args[3] ?? "epl");
const asc = Number(args[4] ?? 0);
const pace = String(args[5] ?? "normal") as RunSetup["pace"];
const blessing = String(args[6] ?? "golden_boy");

function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// pick the FIRST new_club offer when present (exercise the transfer resolve),
// else the first choice — keeps the career moving without biasing toward retire.
function pickChoice(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  const move = ch.find((c) => c.kind === "new_club");
  if (move) return move;
  return ch[0]!;
}

interface Fire {
  key: string;
  age: number;
  ovr: number;
  clubRep: number;
  club: string;
  choices: number;
}

const noOffersFires: Fire[] = [];
const fameFires: Fire[] = [];
// careers that ended with forceRetireReason no_offers vs voluntary, split by peak OVR.
let noOffersRetirePeakLt85 = 0;
let noOffersRetirePeakGe85 = 0;     // should stay 0 for the retention path (elite → fame bid / voluntary)
let voluntaryRetire = 0;

function playOne(seed: string) {
  const setup: RunSetup = {
    seed, nationalityId: nation, position: pos, leagueId: league,
    blessings: blessing ? [blessing] : [], ascension: asc, pace,
  };
  let g: GameState = simulatePeriod(createRun(setup));
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const key = g.pendingChoice.key;
      if (key === "no_offers" || key === "fame_league_bid") {
        const club = clubById(g.currentClubId);
        const rec: Fire = {
          key, age: g.age, ovr: g.player.overall, clubRep: club.rep, club: club.name,
          choices: g.pendingChoice.choices.length,
        };
        if (key === "no_offers") noOffersFires.push(rec);
        else fameFires.push(rec);
      }
      const pick = pickChoice(g);
      g = resolveChoice(g, pick);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  // retirement reason bookkeeping
  const reason = g.retirementReason ?? "";
  const peak = g.maxOverall ?? 0;
  if (reason === "no_offers") {
    if (peak >= 85) noOffersRetirePeakGe85++;
    else noOffersRetirePeakLt85++;
  } else if (reason === "voluntary") voluntaryRetire++;
}

const t0 = Date.now();
for (let i = 0; i < N; i++) playOne(`fb-${i}-${hash32(`fb-${i}`)}`);
const dt = Date.now() - t0;

const pct = (arr: number[], p: number) => arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
const median = (arr: number[]) => pct(arr, 0.5);
function histo(arr: number[]): string {
  const b: Record<number, number> = {};
  for (const a of arr) b[a] = (b[a] ?? 0) + 1;
  return Object.entries(b).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}:${v}`).join(" ");
}

// THE invariant: no no_offers fire should have OVR ≥ 85.
const eliteNoOffers = noOffersFires.filter((f) => f.ovr >= 85);

console.log(`# fame-bid probe · N=${N} · ${nation}/${pos}/${league} · asc ${asc} · ${pace} · blessing ${blessing} · ${dt}ms`);
console.log(`\n## event fires`);
console.log(`  no_offers fires:    ${noOffersFires.length}`);
console.log(`  fame_league_bid:    ${fameFires.length}`);
console.log(`\n## INVARIANT: no no_offers fire with OVR ≥ 85`);
console.log(`  violations: ${eliteNoOffers.length}` + (eliteNoOffers.length ? " ❌" : " ✅"));
if (eliteNoOffers.length) {
  console.log(`  offending fires (age · ovr · club):`);
  for (const f of eliteNoOffers.slice(0, 20)) console.log(`    ${f.age}岁 · ${f.ovr} · ${f.club} (rep ${f.clubRep})`);
}
console.log(`\n## no_offers fire OVR distribution (should all be < 85)`);
if (noOffersFires.length) {
  const ovrs = noOffersFires.map((f) => f.ovr);
  console.log(`  min ${Math.min(...ovrs)} · median ${median(ovrs)} · max ${Math.max(...ovrs)}`);
  console.log(`  ≥85: ${noOffersFires.filter((f) => f.ovr >= 85).length} · ≥80: ${noOffersFires.filter((f) => f.ovr >= 80).length}`);
}
console.log(`\n## fame_league_bid fire profile (should all be OVR ≥ 85, age ≥ 33)`);
if (fameFires.length) {
  const ovrs = fameFires.map((f) => f.ovr);
  const ages = fameFires.map((f) => f.age);
  const reps = fameFires.map((f) => f.clubRep);
  console.log(`  OVR  min ${Math.min(...ovrs)} · median ${median(ovrs)} · max ${Math.max(...ovrs)}`);
  console.log(`  age  min ${Math.min(...ages)} · median ${median(ages)} · max ${Math.max(...ages)}`);
  console.log(`  clubRep min ${Math.min(...reps)} · median ${median(reps)} · max ${Math.max(...reps)}`);
  console.log(`  choices per fire: ${histo(fameFires.map((f) => f.choices))}`);
  console.log(`  sample fires (age · ovr · club):`);
  for (const f of fameFires.slice(0, 12)) console.log(`    ${f.age}岁 · ${f.ovr} · ${f.club} (rep ${f.clubRep}) · ${f.choices}选`);
} else {
  console.log(`  (none fired — try a stronger setup / larger N)`);
}
console.log(`\n## retirement reasons`);
console.log(`  no_offers retire (peak<85):  ${noOffersRetirePeakLt85}`);
console.log(`  no_offers retire (peak≥85):  ${noOffersRetirePeakGe85}  ← should be ~0 (elite routes to fame bid / voluntary)`);
console.log(`  voluntary retire:            ${voluntaryRetire}`);
