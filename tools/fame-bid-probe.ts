/**
 * Fame-bid probe — validates both fame-league-bid paths:
 *
 *  EXIT  (fame_league_bid): retention roll FAILED, OVR ≥ 85 → 金元邀约 (NOT
 *    无人问津). Genuine fade (OVR < 85) still lands no_offers.
 *    Invariant A: NO `no_offers` fire ever has OVR ≥ 85.
 *
 *  OFFER (fame_league_offer): retention PASSED, aging star 33+ OVR≥80 → the
 *    Modric "该不该接沙特钱" temptation. The club still wants him, so a 留队
 *    stay option exists (loyalStay).
 *    Invariant B: every offer fire has OVR ≥ 80, age ≥ 33, AND a stay choice.
 *    Invariant C: anti-repeat — after an offer fire, no second offer fire
 *    within 4 periods (fame_offer_seen TTL).
 *
 * Run: npx tsx tools/fame-bid-probe.ts [N=3000] [nation=eng] [pos=ST] [league=premier-league] [asc=0] [pace=normal] [blessing=golden_boy]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById, leagueById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const args = process.argv.slice(2);
const N = Number(args[0] ?? 3000);
const nation = String(args[1] ?? "eng");
const pos = String(args[2] ?? "ST") as RunSetup["position"];
const league = String(args[3] ?? "premier-league");
const asc = Number(args[4] ?? 0);
const pace = String(args[5] ?? "normal") as RunSetup["pace"];
const blessing = String(args[6] ?? "golden_boy");

function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// In an offer fire, pick STAY (loyalStay) so the career stays put — this lets
// us observe whether fame_offer_seen blocks a second offer within its TTL.
// In an exit fire, pick the first new_club (move on). Otherwise first choice.
function pickChoice(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  if (g.pendingChoice!.key === "fame_league_offer") {
    const stay = ch.find((c) => c.kind === "stay");
    if (stay) return stay;
  }
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
  clubFame: boolean;
  choices: number;
  hasStay: boolean;
}

const noOffersFires: Fire[] = [];
const exitFires: Fire[] = [];
const offerFires: Fire[] = [];
// anti-repeat check: for each career, the ages at which offer fired.
const offerAgesByCareer: number[][] = [];
let noOffersRetirePeakLt85 = 0;
let noOffersRetirePeakGe85 = 0;
let voluntaryRetire = 0;
// anti-repeat violations: two offer fires ≤4 periods (≤4 ages) apart.
let antiRepeatViolations = 0;

function playOne(seed: string) {
  const setup: RunSetup = {
    seed, nationalityId: nation, position: pos, leagueId: league,
    blessings: blessing ? [blessing] : [], ascension: asc, pace,
  };
  let g: GameState = simulatePeriod(createRun(setup));
  let guard = 0;
  const myOfferAges: number[] = [];
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const key = g.pendingChoice.key;
      if (key === "no_offers" || key === "fame_league_bid" || key === "fame_league_offer") {
        const club = clubById(g.currentClubId);
        const clubFame = !!leagueById(club.leagueId).fame;
        const hasStay = g.pendingChoice.choices.some((c) => c.kind === "stay");
        const rec: Fire = {
          key, age: g.age, ovr: g.player!.overall, clubRep: club.rep, club: club.name, clubFame,
          choices: g.pendingChoice.choices.length, hasStay,
        };
        if (key === "no_offers") noOffersFires.push(rec);
        else if (key === "fame_league_bid") exitFires.push(rec);
        else { offerFires.push(rec); myOfferAges.push(g.age); }
      }
      const pick = pickChoice(g);
      g = resolveChoice(g, pick);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  // anti-repeat: any two offer fires within 4 ages is a violation (TTL=4).
  for (let i = 1; i < myOfferAges.length; i++) {
    if (myOfferAges[i]! - myOfferAges[i - 1]! <= 4) antiRepeatViolations++;
  }
  if (myOfferAges.length > 0) offerAgesByCareer.push(myOfferAges);
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

const eliteNoOffers = noOffersFires.filter((f) => f.ovr >= 85);
// offer invariants
const offerBadOvr = offerFires.filter((f) => f.ovr < 80);
const offerBadAge = offerFires.filter((f) => f.age < 33);
const offerNoStay = offerFires.filter((f) => !f.hasStay);
const offerInFame = offerFires.filter((f) => f.clubFame);  // offer fired while already in a fame league
const careersWithOffer = offerAgesByCareer.length;

console.log(`# fame-bid probe · N=${N} · ${nation}/${pos}/${league} · asc ${asc} · ${pace} · blessing ${blessing} · ${dt}ms`);
console.log(`\n## event fires`);
console.log(`  no_offers fires:      ${noOffersFires.length}`);
console.log(`  fame_league_bid(退出):   ${exitFires.length}`);
console.log(`  fame_league_offer(留守诱惑): ${offerFires.length}  (across ${careersWithOffer} careers)`);
console.log(`\n## INVARIANT A: no no_offers fire with OVR ≥ 85`);
console.log(`  violations: ${eliteNoOffers.length}` + (eliteNoOffers.length ? " ❌" : " ✅"));
console.log(`\n## INVARIANT B: every offer fire has OVR≥80, age≥33, and a stay choice`);
console.log(`  OVR<80: ${offerBadOvr.length} · age<33: ${offerBadAge.length} · no-stay: ${offerNoStay.length}` +
  ((offerBadOvr.length || offerBadAge.length || offerNoStay.length) ? " ❌" : " ✅"));
console.log(`\n## INVARIANT D: offer never fires while already in a fame league (no re-tempt)`);
console.log(`  offer fires in fame league: ${offerInFame.length}` + (offerInFame.length ? " ❌" : " ✅"));
console.log(`\n## INVARIANT C: anti-repeat — no two offer fires within 4 periods (fame_offer_seen TTL=4)`);
console.log(`  violations: ${antiRepeatViolations}` + (antiRepeatViolations ? " ❌" : " ✅"));
console.log(`\n## no_offers fire OVR (should all be < 85)`);
if (noOffersFires.length) {
  const ovrs = noOffersFires.map((f) => f.ovr);
  console.log(`  min ${Math.min(...ovrs)} · median ${median(ovrs)} · max ${Math.max(...ovrs)}`);
}
console.log(`\n## exit fire (fame_league_bid) profile — OVR≥85, age≥33, NO stay`);
if (exitFires.length) {
  const ovrs = exitFires.map((f) => f.ovr);
  console.log(`  OVR  min ${Math.min(...ovrs)} · median ${median(ovrs)} · max ${Math.max(...ovrs)}`);
  console.log(`  age  ${histo(exitFires.map((f) => f.age))}`);
  console.log(`  choices: ${histo(exitFires.map((f) => f.choices))} (expect 4: 2沙特+欧洲+挂靴)`);
  console.log(`  has stay (should be 0): ${exitFires.filter((f) => f.hasStay).length}`);
}
console.log(`\n## offer fire (fame_league_offer) profile — OVR≥80, age≥33, WITH stay`);
if (offerFires.length) {
  const ovrs = offerFires.map((f) => f.ovr);
  console.log(`  OVR  min ${Math.min(...ovrs)} · median ${median(ovrs)} · max ${Math.max(...ovrs)}`);
  console.log(`  age  ${histo(offerFires.map((f) => f.age))}`);
  console.log(`  clubRep ${histo(offerFires.map((f) => f.clubRep))}`);
  console.log(`  choices: ${histo(offerFires.map((f) => f.choices))} (expect 4: 2沙特+留队+挂靴)`);
  console.log(`  has stay (should be all): ${offerFires.filter((f) => f.hasStay).length}/${offerFires.length}`);
  console.log(`  sample offer fires (age · ovr · club):`);
  for (const f of offerFires.slice(0, 12)) console.log(`    ${f.age}岁 · ${f.ovr} · ${f.club} (rep ${f.clubRep})`);
}
const perCareerCounts = offerAgesByCareer.map((a) => a.length);
console.log(`\n## offer frequency (careers that survived 33+ as aging stars OVR≥80)`);
console.log(`  careers with ≥1 offer: ${careersWithOffer}/${N} (${Math.round(careersWithOffer / N * 100)}%)`);
if (perCareerCounts.length) console.log(`  fires per such career: ${histo(perCareerCounts)}`);
console.log(`\n## retirement reasons`);
console.log(`  no_offers retire (peak<85):  ${noOffersRetirePeakLt85}`);
console.log(`  no_offers retire (peak≥85):  ${noOffersRetirePeakGe85}  ← should be ~0 (elite routes to fame bid / voluntary)`);
console.log(`  voluntary retire:            ${voluntaryRetire}`);
