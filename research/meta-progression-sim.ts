/**
 * Meta-progression Monte-Carlo harness — measures the career-outcome
 * distribution of a fresh account vs meta-progressed accounts by running the
 * REAL engine headlessly (createRun → simulatePeriod → resolveChoice loop).
 *
 * Run from repo root:  npx tsx research/meta-progression-sim.ts
 *
 * Findings from this harness are written up in meta-progression-analysis.md.
 * Choice policy is a deterministic pseudo-random pick (same for all cohorts,
 * so cross-cohort deltas are fair even though absolute play is unskilled).
 */
import { createRun, simulatePeriod, resolveChoice, retireNow, type RunSetup } from "../src/engine/run";
import { hash } from "../src/engine/rng";
import { scoreLegacy, BLESSINGS, PRESTIGE_PERKS } from "../src/meta/legacy";
import type { GameState } from "../src/engine/types";

const N = Number(process.env.N ?? 1000);
const ALL_BLESSINGS = BLESSINGS.map((b) => b.id);
const ALL_PERKS = PRESTIGE_PERKS.map((p) => p.id);
// the 9 original pure-upside blessings (excludes the build-defining tradeoff ones)
const CURATED = ["golden_boy", "iron_lungs", "oracle", "loyal_club", "talisman", "sharpshooter", "ironman", "marketable", "comeback"];

function playRun(seed: string, blessings: readonly string[], perks: readonly string[]): GameState {
  const setup: RunSetup = {
    seed, nationalityId: "eng", position: "ST", leagueId: "premier-league",
    blessings, ascension: 0, pace: "normal", permPerks: perks,
  };
  let g = createRun(setup);
  g = simulatePeriod(g);
  let guard = 0;
  while (g.phase === "playing" && guard++ < 300) {
    if (g.pendingChoice) {
      const cs = g.pendingChoice.choices;
      g = resolveChoice(g, cs[hash(`${seed}:policy:${g.age}:${guard}`) % cs.length]!);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  if (g.phase === "playing") g = retireNow(g);
  return g;
}

// mirrors the store's RETIRE scoring exactly (state/store.ts)
function finalLegacy(g: GameState): number {
  const wage = g.seasons.reduce((s, x) => s + ((x as { wage?: number }).wage ?? 0), 0);
  const mv = g.seasons.length > 0 ? ((g.seasons[g.seasons.length - 1] as { marketValue?: number }).marketValue ?? 0) : 0;
  return scoreLegacy(g.maxOverall, g.seasons.length, g.trophies, g.awards, g.ascension, g.retirementReason, g.challenge, wage, mv, (g as { eventLegacy?: number }).eventLegacy ?? 0);
}

function pctile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function summarize(label: string, runs: GameState[]): void {
  const ovr = runs.map((g) => g.maxOverall).sort((a, b) => a - b);
  const leg = runs.map(finalLegacy).sort((a, b) => a - b);
  const pct = (f: (g: GameState) => boolean) => ((runs.filter(f).length / runs.length) * 100).toFixed(1);
  console.log(`\n== ${label} (n=${runs.length}) ==`);
  console.log(`  maxOVR p50=${pctile(ovr, 0.5)} p90=${pctile(ovr, 0.9)} | OVR>=90: ${pct((g) => g.maxOverall >= 90)}%`);
  console.log(`  世界杯: ${pct((g) => g.trophies.includes("world_cup"))}%  金球: ${pct((g) => g.awards.includes("ballon_dor"))}%`);
  console.log(`  legacy p50=${pctile(leg, 0.5)} p90=${pctile(leg, 0.9)} | 球神>=800: ${(leg.filter((x) => x >= 800).length / leg.length * 100).toFixed(1)}%`);
  console.log(`  wonderkid档率: ${pct((g) => g.player?.devProfile === "wonderkid")}%`);
}

const seeds = Array.from({ length: N }, (_, i) => `mc${i.toString(36)}x`);
const cohorts: readonly [string, readonly string[], readonly string[]][] = [
  ["新号·零传承", [], []],
  ["满配·全祝福+全声望", ALL_BLESSINGS, ALL_PERKS],
  ["精选9数值祝福·无声望", CURATED, []],
];
for (const [label, bl, pk] of cohorts) summarize(label, seeds.map((s) => playRun(s, bl, pk)));

console.log("\n── 每声望 perk 单独隔离(p50 legacy)──");
{
  const base = seeds.map((s) => playRun(s, [], [])).map(finalLegacy).sort((a, b) => a - b);
  console.log(`  基线: ${pctile(base, 0.5)}`);
  for (const p of PRESTIGE_PERKS) {
    const leg = seeds.map((s) => playRun(s, [], [p.id])).map(finalLegacy).sort((a, b) => a - b);
    console.log(`  ${p.id}: ${pctile(leg, 0.5)}`);
  }
}
