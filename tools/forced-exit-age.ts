/**
 * Forced-exit age probe — runs N careers and records the age at which the
 * 踢不出来 / 扫地出门 (stuck_release / underperform_release) forced-transfer
 * events fire, plus the loan path. Confirms/rebuts the user's claim that the
 * trigger lands ~25 instead of the realistic 20-21.
 *
 * Run: npx tsx tools/forced-exit-age.ts [N=400] [nation=eng] [pos=ST] [league=premier-league] [asc=0] [pace=normal]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const args = process.argv.slice(2);
const N = Number(args[0] ?? 400);
const nation = String(args[1] ?? "eng");
const pos = String(args[2] ?? "ST") as RunSetup["position"];
const league = String(args[3] ?? "premier-league");
const asc = Number(args[4] ?? 0);
const pace = String(args[5] ?? "normal") as RunSetup["pace"];
// optional explicit academy club id (豪门青训 scenario — overrides the
// weakest-club default so we can probe the loan-path interception case).
const clubId = String(args[6] ?? "");

let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function pickChoice(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  if (ch.length === 1) return ch[0]!;
  return ch[rint(0, ch.length - 1)]!;
}

interface FireRecord {
  key: string;
  age: number;
  ovr: number;
  clubRep: number;
  role: string;
}

const fires: FireRecord[] = [];
let loansFired = 0;
let careersWithStuck = 0;
// record the seed of the first career whose stuck_release fires at a big club (rep>=5) age<=30 — for tracing.
let traceSeed: string | null = null;

function playOne(seed: string) {
  _s = 0x9e3779b9 ^ hash32(seed);
  const setup: RunSetup = { seed, nationalityId: nation, position: pos, leagueId: league, blessings: [], ascension: asc, pace, ...(clubId ? { clubId } : {}) };
  let g: GameState = simulatePeriod(createRun(setup));
  let hadStuck = false;
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const key = g.pendingChoice.key;
      if (key === "stuck_release" || key === "underperform_release") {
        const club = clubById(g.currentClubId);
        const last = g.seasons[g.seasons.length - 1];
        fires.push({ key, age: g.age, ovr: g.player!.overall, clubRep: club.rep, role: last?.role ?? "?" });
        hadStuck = true;
        if (!traceSeed && club.rep >= 5 && g.age <= 30) traceSeed = seed;
      }
      if (key === "loan_offer" || key === "post_loan") loansFired++;
      const pick = pickChoice(g);
      g = resolveChoice(g, pick);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  if (hadStuck) careersWithStuck++;
}

const t0 = Date.now();
for (let i = 0; i < N; i++) playOne(`fx-${i}-${hash32(`fx-${i}`)}`);
const dt = Date.now() - t0;

const stuck = fires.filter(f => f.key === "stuck_release");
const under = fires.filter(f => f.key === "underperform_release");
const ages = fires.map(f => f.age);

const pct = (arr: number[], p: number) => arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
const median = (arr: number[]) => pct(arr, 0.5);

function histo(arr: number[]): string {
  const buckets: Record<number, number> = {};
  for (const a of arr) buckets[a] = (buckets[a] ?? 0) + 1;
  return Object.entries(buckets).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}岁:${v}`).join(" ");
}

console.log(`# forced-exit age probe · N=${N} · ${nation}/${pos}/${league} · asc ${asc} · ${pace} · ${dt}ms`);
console.log(`careers hitting stuck/underperform: ${careersWithStuck}/${N} (${Math.round(careersWithStuck / N * 100)}%)`);
console.log(`total forced-exit fires: ${fires.length} (stuck ${stuck.length} · underperform ${under.length})`);
console.log(`loan/post_loan fires total: ${loansFired} (~${(loansFired / N).toFixed(2)}/career)`);
console.log(`\nforced-exit AGE distribution (all fires):`);
console.log(`  median ${median(ages)} · p10 ${pct(ages, 0.1)} · p25 ${pct(ages, 0.25)} · p75 ${pct(ages, 0.75)} · p90 ${pct(ages, 0.9)}`);
console.log(`  ≤21 age fires: ${ages.filter(a => a <= 21).length} (${Math.round(ages.filter(a => a <= 21).length / (ages.length || 1) * 100)}%)`);
console.log(`  ≤23 age fires: ${ages.filter(a => a <= 23).length} (${Math.round(ages.filter(a => a <= 23).length / (ages.length || 1) * 100)}%)`);
console.log(`  ≥25 age fires: ${ages.filter(a => a >= 25).length} (${Math.round(ages.filter(a => a >= 25).length / (ages.length || 1) * 100)}%)`);
console.log(`  histogram: ${histo(ages)}`);
console.log(`\n# by event:`);
console.log(`  stuck_release ages: ${histo(stuck.map(f => f.age))}`);
console.log(`  underperform_release ages: ${histo(under.map(f => f.age))}`);
console.log(`\n# stuck_release by club rep:`);
const byRep: Record<number, FireRecord[]> = {};
for (const f of stuck) (byRep[f.clubRep] ??= []).push(f);
for (const rep of Object.keys(byRep).sort((a, b) => Number(a) - Number(b))) {
  const rs = byRep[Number(rep)]!;
  console.log(`  rep ${rep}: n=${rs.length} · ages ${histo(rs.map(f => f.age))}`);
}
if (traceSeed) console.log(`\nTRACE SEED (big-club stuck_release, age<=30): ${traceSeed}`);
