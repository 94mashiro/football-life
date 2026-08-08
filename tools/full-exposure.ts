/** Full-exposure probe: tally every period's outcome by event key — decisions
 *  AND flavors — plus pool-vs-system split and per-career distinct beats. */
import { createRun, simulatePeriod, resolveChoice } from "../src/engine/run";
import type { GameState } from "../src/engine/types";

const SYSTEM_KEYS = new Set([
  "transfer", "wage_squeeze", "contract_nonrenewal", "no_offers",
  "relegation_loyalty", "club_national_team_conflict", "naturalization_offer",
  "post_loan", "loan_offer", "blockbuster_offer", "world_cup_showdown",
  "world_cup_qualifier_showdown", "continental_cup_showdown", "decisive_penalty",
  "doctor_warning", "medical_verdict", "throne_challenge", "rival_showdown",
  "injury",
]);

const SETUPS = [
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal", label: "BRA ST 英超 normal" },
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "long", label: "BRA ST 英超 long" },
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "express", label: "BRA ST 英超 express" },
  { nationalityId: "chn", position: "ST", leagueId: "csl", pace: "normal", label: "CHN ST 中超 normal (default)" },
] as const;

const NCAREERS = 300;

function runOne(seed: string, setup: any) {
  const g0 = createRun({ seed, nationalityId: setup.nationalityId, position: setup.position, leagueId: setup.leagueId, pace: setup.pace, blessings: [], ascension: 0, permPerks: [] });
  let g: GameState = simulatePeriod(g0);
  const beats: Record<string, { d: number; f: number }> = {};
  const seen: Set<string> = new Set();
  let guard = 0;
  while (g.phase === "playing" && guard++ < 200) {
    if (g.pendingChoice) {
      const key = g.pendingChoice.key;
      beats[key] = beats[key] ?? { d: 0, f: 0 };
      beats[key]!.d++;
      seen.add(key);
      const choice = g.pendingChoice.choices[0]!;
      g = resolveChoice(g, choice);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      if (g.pendingFlavor) {
        const key = g.pendingFlavorKey ?? "?";        beats[key] = beats[key] ?? { d: 0, f: 0 };
        beats[key]!.f++;
        seen.add(key);
      }
      g = simulatePeriod(g);
    }
  }
  const reason = g.retirementReason ?? (g.phase === "summary" ? "ended" : "maxed");
  return { beats, distinct: seen.size, periods: guard, reason };
}

function hashSeed(i: number): string {
  let h = 2166136261 ^ i;
  h = Math.imul(h, 16777619) >>> 0;
  return `mc-seed-${i}-${h.toString(36)}`;
}

for (const setup of SETUPS) {
  const agg: Record<string, { d: number; f: number }> = {};
  let periods = 0, distinctSum = 0;
  const reasons: Record<string, number> = {};
  for (let i = 0; i < NCAREERS; i++) {
    const r = runOne(hashSeed(i), setup);
    periods += r.periods;
    distinctSum += r.distinct;
    reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    for (const [k, v] of Object.entries(r.beats)) {
      agg[k] = agg[k] ?? { d: 0, f: 0 };
      agg[k]!.d += v.d;
      agg[k]!.f += v.f;
    }
  }
  const rows = Object.entries(agg).map(([k, v]) => ({ k, d: v.d, f: v.f, n: v.d + v.f }));
  rows.sort((a, b) => b.n - a.n);
  const total = rows.reduce((s, r) => s + r.n, 0);
  const sysN = rows.filter((r) => SYSTEM_KEYS.has(r.k)).reduce((s, r) => s + r.n, 0);
  const poolN = total - sysN;
  console.log(`\n=== ${setup.label} — ${NCAREERS} careers, ${(periods / NCAREERS).toFixed(1)} periods/career ===`);
  console.log(`total beats ${total} (${(total / NCAREERS).toFixed(1)}/career) · system ${(sysN / NCAREERS).toFixed(1)} (${(100 * sysN / total).toFixed(0)}%) · pool ${(poolN / NCAREERS).toFixed(1)} (${(100 * poolN / total).toFixed(0)}%) · distinct keys ${rows.length} · avg distinct beats/career ${(distinctSum / NCAREERS).toFixed(1)}`);
  console.log(`retirements: ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log("top 20 beats (key: total [d+f]):");
  for (const r of rows.slice(0, 20)) {
    const tag = SYSTEM_KEYS.has(r.k) ? "sys" : "pl ";
    console.log(`  ${tag} ${r.k.padEnd(32)} ${String(r.n).padStart(5)} [${r.d}+${r.f}]`);
  }
}
