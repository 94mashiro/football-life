/**
 * Combo probe: measure 词条成型 (build combo) activation rates + apex milestone
 * frequency under fixed strategies, and verify determinism (same seed → same
 * milestones). Run: npx tsx tools/combo-probe.ts  (env N=careers per cell)
 */
import { createRun, simulatePeriod, resolveChoice } from "../src/engine/run";
import type { GameState, Choice } from "../src/engine/types";

const N = Number(process.env.N ?? 400);
const COMBOS = ["combo_dynasty", "combo_talisman", "combo_adopted", "combo_iron"];
const APEX = ["world_cup", "ballon_dor", "ovr95", "mv100"];

type Strategy = "first" | "stay" | "adopt";
function pickChoice(g: GameState, strategy: Strategy): Choice {
  const choices = g.pendingChoice!.choices;
  if (choices.length === 1) return choices[0]!;
  if (strategy === "stay") {
    const stay = choices.find((c) => c.kind === "stay");
    if (stay) return stay;
  }
  if (strategy === "adopt") {
    // 定向验证 combo_adopted 可达性:主动走 退出国家队 → 接受归化 的弧线。
    const t = choices.find((c) => /退出国家队|归化|入籍|接受/.test(c.text));
    if (t) return t;
  }
  return choices[0]!;
}

function runOne(seed: string, strategy: Strategy) {
  const g0 = createRun({
    seed, nationalityId: strategy === "adopt" ? "chn" : "bra", position: "ST" as never,
    leagueId: "premier-league", pace: "normal", blessings: [], ascension: 0, permPerks: [],
  });
  let g: GameState = simulatePeriod(g0);
  const milestones: string[] = [];
  let guard = 0;
  while (g.phase === "playing" && guard++ < 200) {
    if (g.pendingMilestone) milestones.push(g.pendingMilestone.id);
    if (g.pendingChoice) {
      g = resolveChoice(g, pickChoice(g, strategy));
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  return { milestones, tags: g.personaTagsEver ?? [], peak: g.maxOverall };
}

for (const strategy of ["first", "stay", "adopt"] as const) {
  const comboHits: Record<string, number> = Object.fromEntries(COMBOS.map((c) => [c, 0]));
  const apexHits: Record<string, number> = Object.fromEntries(APEX.map((a) => [a, 0]));
  let anyCombo = 0;
  for (let i = 0; i < N; i++) {
    const { milestones } = runOne(`probe-${strategy}-${i}`, strategy);
    let hit = false;
    for (const c of COMBOS) if (milestones.includes(c)) { comboHits[c]!++; hit = true; }
    for (const a of APEX) if (milestones.includes(a)) apexHits[a]!++;
    if (hit) anyCombo++;
  }
  console.log(`\n=== strategy=${strategy} N=${N} ===`);
  console.log(`any combo: ${(anyCombo / N * 100).toFixed(1)}%`);
  for (const c of COMBOS) console.log(`  ${c}: ${(comboHits[c]! / N * 100).toFixed(1)}%`);
  for (const a of APEX) console.log(`  apex ${a}: ${(apexHits[a]! / N * 100).toFixed(1)}%`);
}

// determinism: same seed twice → identical milestone sequence
const a = runOne("determinism-check", "first");
const b = runOne("determinism-check", "first");
const same = JSON.stringify(a.milestones) === JSON.stringify(b.milestones)
  && JSON.stringify(a.tags) === JSON.stringify(b.tags);
console.log(`\ndeterminism: ${same ? "OK" : "BROKEN"}`);
if (!same) process.exit(1);

// bottleneck check: tag prevalence under the adopt strategy
{
  const counts: Record<string, number> = {};
  const NN = Math.min(N, 400);
  for (let i = 0; i < NN; i++) {
    const { tags } = runOne(`probe-adopt-${i}`, "adopt");
    for (const t of tags) counts[t] = (counts[t] ?? 0) + 1;
  }
  console.log("\nadopt-strategy tag prevalence:");
  for (const [t, c] of Object.entries(counts).sort((x, y) => y[1] - x[1]))
    console.log(`  ${t}: ${(c / NN * 100).toFixed(1)}%`);
}
