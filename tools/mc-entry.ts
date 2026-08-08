/**
 * Monte Carlo: tally which career-event decisions a player actually faces.
 *
 * Mirrors the store's flow: simulatePeriod → (if pendingChoice: record +
 * resolveChoice + auto-advance) → (else: ADVANCE). Counts decisions by
 * pendingChoice.key, plus flavor / silent periods. Runs many seeds for a
 * fixed setup so we can see whether the 170+ event catalog collapses to a
 * handful of repeating events.
 */
import { createRun, simulatePeriod, resolveChoice } from "../src/engine/run";
import type { GameState } from "../src/engine/types";

// Keys produced by buildPeriodDecision's SYSTEM/CONTEXTUAL paths (not the
// rollRandomEvent story pool). Everything else is drawn from the 170+ catalog.
const SYSTEM_KEYS = new Set([
  "transfer", "wage_squeeze", "contract_nonrenewal", "no_offers",
  "relegation_loyalty", "club_national_team_conflict", "naturalization_offer",
  "post_loan", "loan_offer", "blockbuster_offer", "world_cup_showdown",
  "world_cup_qualifier_showdown", "continental_cup_showdown", "decisive_penalty",
  "doctor_warning", "medical_verdict", "throne_challenge",
]);
const CATALOG_TOTAL = 176; // makeEventDef count in events.ts

interface Setup {
  nationalityId: string;
  position: string;
  leagueId: string;
  pace: "long" | "normal" | "express";
  label: string;
}

const SETUPS: Setup[] = [
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal", label: "BRA ST 英超 normal" },
  { nationalityId: "eng", position: "CM", leagueId: "premier-league", pace: "normal", label: "ENG CM 英超 normal" },
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "long", label: "BRA ST 英超 long(1/decision)" },
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "express", label: "BRA ST 英超 express" },
];

const NCAREERS = 300;

function runOne(seed: string, setup: Setup): { decisions: Record<string, number>; flavors: number; silent: number; periods: number; choiceCount: number; perCareerDistinct: number; maxRepeat: number; peakOvr: number } {
  const game0 = createRun({
    seed,
    nationalityId: setup.nationalityId,
    position: setup.position as any,
    leagueId: setup.leagueId,
    pace: setup.pace,
    blessings: [],
    ascension: 0,
    permPerks: [],
  });
  let g: GameState = simulatePeriod(game0);
  const decisions: Record<string, number> = {};
  let flavors = 0;
  let silent = 0;
  let periods = 0;
  let totalChoices = 0;
  let guard = 0;
  while (g.phase === "playing" && guard++ < 200) {
    periods++;
    if (g.pendingChoice) {
      const key = g.pendingChoice.key;
      decisions[key] = (decisions[key] ?? 0) + 1;
      totalChoices++;
      const choice = g.pendingChoice.choices[0];
      if (!choice) break;
      g = resolveChoice(g, choice);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      if (g.pendingFlavor) flavors++;
      else silent++;
      g = simulatePeriod(g);
    }
  }
  const perCareerDistinct = Object.keys(decisions).length;
  const maxRepeat = Object.values(decisions).reduce((m, v) => Math.max(m, v), 0);
  const peakOvr = g.maxOverall ?? 0;
  return { decisions, flavors, silent, periods, choiceCount: totalChoices, perCareerDistinct, maxRepeat, peakOvr };
}

function hashSeed(i: number): string {
  // deterministic but varied seeds
  let h = 2166136261 ^ i;
  h = Math.imul(h, 16777619) >>> 0;
  return `mc-seed-${i}-${h.toString(36)}`;
}

for (const setup of SETUPS) {
  const agg: Record<string, number> = {};
  let flavors = 0, silent = 0, periods = 0, choices = 0;
  let careers = 0;
  let sumPerCareerDistinct = 0, sumMaxRepeat = 0;
  let peakOvrSum = 0;
  const ovrBuckets = { "<70": 0, "70-75": 0, "76-79": 0, "80-82": 0, "83-85": 0, "86+": 0 };
  for (let i = 0; i < NCAREERS; i++) {
    const r = runOne(hashSeed(i), setup);
    careers++;
    for (const [k, v] of Object.entries(r.decisions)) agg[k] = (agg[k] ?? 0) + v;
    flavors += r.flavors; silent += r.silent; periods += r.periods; choices += r.choiceCount;
    sumPerCareerDistinct += r.perCareerDistinct; sumMaxRepeat += r.maxRepeat;
    peakOvrSum += r.peakOvr;
    if (r.peakOvr < 70) ovrBuckets["<70"]++;
    else if (r.peakOvr < 76) ovrBuckets["70-75"]++;
    else if (r.peakOvr < 80) ovrBuckets["76-79"]++;
    else if (r.peakOvr < 83) ovrBuckets["80-82"]++;
    else if (r.peakOvr < 86) ovrBuckets["83-85"]++;
    else ovrBuckets["86+"]++;
  }
  const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 15);
  console.log(`\n=== ${setup.label}  (${careers} careers, ${periods} periods, ${choices} decisions, ${flavors} flavor, ${silent} silent) ===`);
  console.log(`distinct decision keys seen: ${sorted.length} / ~${CATALOG_TOTAL} catalog  (=> ~${CATALOG_TOTAL - sorted.length} never faced as a decision)`);
  console.log("top 15 decisions (key: count  share-of-decisions):");
  for (const [k, v] of top) {
    const tag = SYSTEM_KEYS.has(k) ? "[system]" : "[pool]  ";
    console.log(`  ${tag} ${k.padEnd(30)} ${String(v).padStart(6)}  ${(100 * v / choices).toFixed(1)}%`);
  }
  const top10share = top.slice(0, 10).reduce((s, [, v]) => s + v, 0);
  console.log(`top 10 events = ${(100 * top10share / choices).toFixed(1)}% of all decisions`);
  console.log(`PER-CAREER (the feel): avg distinct events/career = ${(sumPerCareerDistinct / careers).toFixed(2)}, avg max-repeat of any one event = ${(sumMaxRepeat / careers).toFixed(2)}, avg peak OVR = ${(peakOvrSum / careers).toFixed(1)}`);
  console.log(`peak OVR buckets: <70=${ovrBuckets["<70"]} 70-75=${ovrBuckets["70-75"]} 76-79=${ovrBuckets["76-79"]} 80-82=${ovrBuckets["80-82"]} 83-85=${ovrBuckets["83-85"]} 86+=${ovrBuckets["86+"]}`);
  // split: system/contextual vs random story pool
  let sys = 0, pool = 0;
  const poolAgg: Record<string, number> = {};
  for (const [k, v] of sorted) {
    if (SYSTEM_KEYS.has(k)) sys += v; else { pool += v; poolAgg[k] = v; }
  }
  console.log(`system/contextual decisions: ${sys} (${(100 * sys / choices).toFixed(1)}%)  |  random-pool decisions: ${pool} (${(100 * pool / choices).toFixed(1)}%)`);
  const poolTop = Object.entries(poolAgg).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log("random-pool top 10 (the story events the player actually meets):");
  for (const [k, v] of poolTop) console.log(`  ${k.padEnd(30)} ${String(v).padStart(5)}  ${(100 * v / pool).toFixed(1)}% of pool`);
  if (process.env.MC_DUMP) {
    console.log("ALL DECISION KEYS (sorted by count):");
    for (const [k, v] of sorted) console.log(`  ${k}=${v}`);
  }
}
