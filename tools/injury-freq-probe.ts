/**
 * Injury-frequency probe — answers "伤病事件是不是过多?"
 *
 * Auto-plays many careers (pick choice[0] each time, the "safe" first option)
 * and tallies every injury-related decision the player faces, the severe-
 * injury count, and how careers end. Mirrors mc-entry.ts's harness.
 *
 * Run:  npx tsx tools/injury-freq-probe.ts
 */
import { createRun, simulatePeriod, resolveChoice } from "../src/engine/run";
import type { GameState } from "../src/engine/types";

// Core injury decisions — the player directly suffers / decides around an injury.
const INJURY_KEYS = new Set([
  "injury",                       // generic rollInjuryEvent (the common one)
  "injury_at_peak",               // narrative — peak OVR, gated
  "injury_before_tournament",     // narrative — pre-WC
  "injury_relapse",               // narrative — after playing through
  "career_threatening_injury",    // narrative — devastating
  "pre_final_collapse",           // narrative — pre-final body collapse
  "peak_destroyed",               // narrative — Ballon d'Or winner broken
  "horror_tackle",                // narrative — broken leg
  "acl_prodigy",                   // narrative — young ACL
]);
// Medical arc — CONSEQUENCES of severe injuries (still "injury events" the player
// decides around, but fire from the severeInjuries counter, not the injury roll).
const MEDICAL_KEYS = new Set([
  "doctor_warning",   // 2nd severe
  "medical_verdict",  // 3rd severe (+ each further)
]);
const INJURY_OR_MEDICAL = new Set([...INJURY_KEYS, ...MEDICAL_KEYS]);

interface Setup {
  nationalityId: string;
  position: string;
  leagueId: string;
  pace: "long" | "normal" | "express";
  ascension: number;
  blessings: string[];
  label: string;
}

const SETUPS: Setup[] = [
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal", ascension: 0, blessings: [], label: "BRA ST 英超 normal asc0 (baseline)" },
  { nationalityId: "eng", position: "CM", leagueId: "premier-league", pace: "normal", ascension: 0, blessings: [], label: "ENG CM 英超 normal asc0" },
  { nationalityId: "bra", position: "CB", leagueId: "premier-league", pace: "normal", ascension: 0, blessings: [], label: "BRA CB 英超 normal asc0 (defender)" },
  { nationalityId: "bra", position: "GK", leagueId: "premier-league", pace: "normal", ascension: 0, blessings: [], label: "BRA GK 英超 normal asc0 (keeper)" },
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "long", ascension: 0, blessings: [], label: "BRA ST 英超 long(1/decision) — highest decision density" },
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal", ascension: 2, blessings: [], label: "BRA ST 英超 normal asc2 (伤病潮 +3% nag)" },
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal", ascension: 0, blessings: ["glass_cannon"], label: "BRA ST 英超 normal asc0 玻璃大炮 (injury ×3)" },
];

const NCAREERS = 300;

interface CareerResult {
  injuryDecisions: number;        // total INJURY_OR_MEDICAL decisions faced
  injuryKeyBreakdown: Record<string, number>;
  totalDecisions: number;
  severeInjuries: number;        // from final state
  injuriesTaken: number;         // from final state
  retireReason: string;
  retireAge: number;
  peakOvr: number;
  injuriesByBucket: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

function bucket(n: number): CareerResult["injuriesByBucket"] {
  return (n >= 6 ? 6 : n) as CareerResult["injuriesByBucket"];
}

function runOne(seed: string, setup: Setup): CareerResult {
  const game0 = createRun({
    seed,
    nationalityId: setup.nationalityId,
    position: setup.position as any,
    leagueId: setup.leagueId,
    pace: setup.pace,
    blessings: setup.blessings,
    ascension: setup.ascension,
    permPerks: [],
  });
  let g: GameState = simulatePeriod(game0);
  const breakdown: Record<string, number> = {};
  let injuryDecisions = 0;
  let totalDecisions = 0;
  let guard = 0;
  while (g.phase === "playing" && guard++ < 300) {
    if (g.pendingChoice) {
      const key = g.pendingChoice.key;
      totalDecisions++;
      if (INJURY_OR_MEDICAL.has(key)) {
        injuryDecisions++;
        breakdown[key] = (breakdown[key] ?? 0) + 1;
      }
      const choice = g.pendingChoice.choices[0];
      if (!choice) break;
      g = resolveChoice(g, choice);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  return {
    injuryDecisions,
    injuryKeyBreakdown: breakdown,
    totalDecisions,
    severeInjuries: g.severeInjuries ?? 0,
    injuriesTaken: g.injuriesTaken ?? 0,
    retireReason: g.retirementReason ?? (g.phase === "summary" ? "completed" : "?"),
    retireAge: g.player.age,
    peakOvr: g.maxOverall ?? 0,
    injuriesByBucket: bucket(injuryDecisions),
  };
}

function hashSeed(i: number): string {
  let h = 2166136261 ^ i;
  h = Math.imul(h, 16777619) >>> 0;
  return `inj-seed-${i}-${h.toString(36)}`;
}

for (const setup of SETUPS) {
  const results: CareerResult[] = [];
  for (let i = 0; i < NCAREERS; i++) results.push(runOne(hashSeed(i), setup));

  const n = results.length;
  const avgInj = results.reduce((s, r) => s + r.injuryDecisions, 0) / n;
  const avgTotal = results.reduce((s, r) => s + r.totalDecisions, 0) / n;
  const avgSevere = results.reduce((s, r) => s + r.severeInjuries, 0) / n;
  const avgTaken = results.reduce((s, r) => s + r.injuriesTaken, 0) / n;

  const buckets: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const r of results) buckets[r.injuriesByBucket] = (buckets[r.injuriesByBucket] ?? 0) + 1;

  // severe distribution
  const sevBuckets: Record<number, number> = {};
  for (const r of results) sevBuckets[r.severeInjuries] = (sevBuckets[r.severeInjuries] ?? 0) + 1;

  // retire reasons
  const reasons: Record<string, number> = {};
  for (const r of results) reasons[r.retireReason] = (reasons[r.retireReason] ?? 0) + 1;

  // injury decision share of all decisions
  const injSharePct = (100 * avgInj) / avgTotal;

  // key breakdown aggregated
  const keyAgg: Record<string, number> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.injuryKeyBreakdown)) keyAgg[k] = (keyAgg[k] ?? 0) + v;

  // careers with >=1, >=2, >=3 injury decisions
  const ge1 = results.filter((r) => r.injuryDecisions >= 1).length;
  const ge2 = results.filter((r) => r.injuryDecisions >= 2).length;
  const ge3 = results.filter((r) => r.injuryDecisions >= 3).length;
  const ge4 = results.filter((r) => r.injuryDecisions >= 4).length;
  const medicalVerdictCareers = results.filter((r) => (r.injuryKeyBreakdown.medical_verdict ?? 0) > 0).length;
  const injuryRetired = results.filter((r) => r.retireReason === "injury").length;

  console.log(`\n${"═".repeat(72)}`);
  console.log(` ${setup.label}`);
  console.log(`${"═".repeat(72)}`);
  console.log(`careers: ${n}   avg total decisions/career: ${avgTotal.toFixed(1)}`);
  console.log(`avg injury-decisions/career: ${avgInj.toFixed(2)}   (${injSharePct.toFixed(1)}% of all decisions)`);
  console.log(`avg injuriesTaken: ${avgTaken.toFixed(2)}   avg SEVERE injuries: ${avgSevere.toFixed(2)}`);
  console.log(`\n→ 伤病决策次数分布 (per career):`);
  console.log(`   0次: ${(100 * buckets[0]! / n).toFixed(1).padStart(5)}%   1次: ${(100 * buckets[1]! / n).toFixed(1).padStart(5)}%   2次: ${(100 * buckets[2]! / n).toFixed(1).padStart(5)}%   3次: ${(100 * buckets[3]! / n).toFixed(1).padStart(5)}%   4次: ${(100 * buckets[4]! / n).toFixed(1).padStart(5)}%   5次: ${(100 * buckets[5]! / n).toFixed(1).padStart(5)}%   6+: ${(100 * buckets[6]! / n).toFixed(1).padStart(5)}%`);
  console.log(`   ≥1次: ${ge1}/${n} (${(100 * ge1 / n).toFixed(0)}%)   ≥2次: ${ge2} (${(100 * ge2 / n).toFixed(0)}%)   ≥3次: ${ge3} (${(100 * ge3 / n).toFixed(0)}%)   ≥4次: ${ge4} (${(100 * ge4 / n).toFixed(0)}%)`);
  console.log(`\n→ 重伤(severe)次数分布:`);
  const sevSorted = Object.entries(sevBuckets).map(([k, v]) => [Number(k), v] as [number, number]).sort((a, b) => a[0] - b[0]);
  for (const [k, v] of sevSorted) console.log(`   ${k}次: ${v} (${(100 * v / n).toFixed(1)}%)`);
  console.log(`\n→ 触发医学判决(medical_verdict)的生涯: ${medicalVerdictCareers}/${n} (${(100 * medicalVerdictCareers / n).toFixed(1)}%)`);
  console.log(`→ 因伤病退役(retireReason=injury): ${injuryRetired}/${n} (${(100 * injuryRetired / n).toFixed(1)}%)`);
  console.log(`\n→ 退役原因分布:`);
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(14)} ${v} (${(100 * v / n).toFixed(1)}%)`);
  const ovrBuckets: Record<string, number> = { "<70": 0, "70-75": 0, "76-79": 0, "80-82": 0, "83-85": 0, "86+": 0 };
  for (const r of results) {
    if (r.peakOvr < 70) ovrBuckets["<70"]++;
    else if (r.peakOvr < 76) ovrBuckets["70-75"]++;
    else if (r.peakOvr < 80) ovrBuckets["76-79"]++;
    else if (r.peakOvr < 83) ovrBuckets["80-82"]++;
    else if (r.peakOvr < 86) ovrBuckets["83-85"]++;
    else ovrBuckets["86+"]++;
  }
  const avgPeak = results.reduce((s, r) => s + r.peakOvr, 0) / n;
  console.log(`\n→ 巅峰 OVR: 均值 ${avgPeak.toFixed(1)}   分布: <70=${ovrBuckets["<70"]}  70-75=${ovrBuckets["70-75"]}  76-79=${ovrBuckets["76-79"]}  80-82=${ovrBuckets["80-82"]}  83-85=${ovrBuckets["83-85"]}  86+=${ovrBuckets["86+"]}`);
  console.log(`\n→ 伤病决策 key 聚合 (跨 ${n} 生涯, 共 ${Object.values(keyAgg).reduce((s, v) => s + v, 0)} 次决策):`);
  for (const [k, v] of Object.entries(keyAgg).sort((a, b) => b[1] - a[1])) {
    const tag = INJURY_KEYS.has(k) ? "[injury] " : MEDICAL_KEYS.has(k) ? "[medical]" : "[?]     ";
    console.log(`   ${tag} ${k.padEnd(28)} ${String(v).padStart(5)}  ${((v / n).toFixed(2)).padStart(6)}/career`);
  }
}
