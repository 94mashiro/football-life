/**
 * 飞升经济回归门：同一批种子对照 A0 / A10，分别测普通路线与终局高手路线。
 *
 * 设计目标不是让高飞升人人多赚，而是把奖励集中在高表现尾部：
 * - 普通 A10 的单局与每赛季效率都不能超过 A0，杜绝短生涯速刷；
 * - 满威望高手的 A10 中位收益大致持平，但 P90 必须显著超过 A0；
 * - 高手 A10 尾部必须与普通 A0 拉开数量级可感知的差距。
 */
import { clubById } from "../src/engine/data";
import type { Choice, GameState } from "../src/engine/types";
import { drive, POLICIES, corpusSeed, quantile, type Policy, type Profile, type CareerTrace } from "./_harness";

const N = Number(process.argv[2] ?? 160);
const ALL_PERKS = [
  "pp_prodigy", "pp_longevity", "pp_legacy_magnet", "pp_iron_will",
  "pp_transfer_savvy", "pp_comeback_base", "pp_oracle_base", "pp_scout", "pp_boss_slayer",
];
const EXPERT_BLESSINGS = ["sharpshooter", "glass_cannon", "big_game_player"];

const profile = (id: string, ascension: number, expert: boolean): Profile => ({
  id,
  nationalityId: "bra",
  position: "ST",
  leagueId: "premier-league",
  pace: "normal",
  blessings: expert ? EXPERT_BLESSINGS : [],
  ascension,
  allowWonderkid: expert,
  permPerks: expert ? ALL_PERKS : [],
});

function clubStars(choice: Choice, state: GameState): number {
  if (choice.id !== "stay" && choice.kind !== "stay") return (choice.sub ?? "").split("★").length - 1;
  try {
    const reputation = clubById(state.currentClubId).rep;
    return reputation >= 8 ? 5 : reputation >= 6 ? 4 : reputation >= 4 ? 3 : reputation >= 2 ? 2 : 1;
  } catch {
    return 0;
  }
}

const expertPolicy: Policy = (choices, key, periodIndex, seed, state) => {
  if (state && (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer")) {
    return choices.reduce((best, choice) => clubStars(choice, state) > clubStars(best, state) ? choice : best, choices[0]!);
  }
  return POLICIES.varied(choices, key, periodIndex, seed, state);
};

function sample(config: Profile, policy: Policy): CareerTrace[] {
  const traces: CareerTrace[] = [];
  for (let i = 0; i < N; i++) traces.push(drive(`asc-econ-${corpusSeed(i)}`, config, policy, config.id));
  return traces;
}

const ordinary0 = sample(profile("ordinary-a0", 0, false), POLICIES.first);
const ordinary10 = sample(profile("ordinary-a10", 10, false), POLICIES.first);
const expert0 = sample(profile("expert-a0", 0, true), expertPolicy);
const expert10 = sample(profile("expert-a10", 10, true), expertPolicy);

const legacy = (traces: readonly CareerTrace[]) => traces.map((trace) => trace.legacy);
const perSeason = (traces: readonly CareerTrace[]) => traces.map((trace) => trace.legacy / Math.max(1, trace.seasons));
const median = (traces: readonly CareerTrace[]) => quantile(legacy(traces), 0.5);
const p90 = (traces: readonly CareerTrace[]) => quantile(legacy(traces), 0.9);
const efficiency = (traces: readonly CareerTrace[]) => quantile(perSeason(traces), 0.5);
const ratio = (value: number, baseline: number) => value / Math.max(1, baseline);

interface Gate {
  readonly id: string;
  readonly target: string;
  readonly measured: number;
  readonly pass: boolean;
}

const ordinaryMedianRatio = ratio(median(ordinary10), median(ordinary0));
const ordinaryP90Ratio = ratio(p90(ordinary10), p90(ordinary0));
const ordinaryEfficiencyRatio = ratio(efficiency(ordinary10), efficiency(ordinary0));
const expertMedianRatio = ratio(median(expert10), median(expert0));
const expertP90Ratio = ratio(p90(expert10), p90(expert0));
const expertSeparation = ratio(p90(expert10), p90(ordinary0));

const gates: Gate[] = [
  { id: "ordinary.median", target: "A10/A0 ≤ 0.85", measured: ordinaryMedianRatio, pass: ordinaryMedianRatio <= 0.85 },
  { id: "ordinary.p90", target: "A10/A0 ≤ 0.90", measured: ordinaryP90Ratio, pass: ordinaryP90Ratio <= 0.90 },
  { id: "ordinary.perSeason", target: "A10/A0 ≤ 0.95", measured: ordinaryEfficiencyRatio, pass: ordinaryEfficiencyRatio <= 0.95 },
  { id: "expert.median", target: "0.80 ≤ A10/A0 ≤ 1.10", measured: expertMedianRatio, pass: expertMedianRatio >= 0.80 && expertMedianRatio <= 1.10 },
  { id: "expert.p90", target: "1.20 ≤ A10/A0 ≤ 1.40", measured: expertP90Ratio, pass: expertP90Ratio >= 1.20 && expertP90Ratio <= 1.40 },
  { id: "expert.separation", target: "高手A10 P90 / 普通A0 P90 ≥ 3.00", measured: expertSeparation, pass: expertSeparation >= 3.00 },
];

console.log(`飞升经济门槛 · N=${N}/cell`);
console.log(`普通 A0: med=${median(ordinary0)} p90=${p90(ordinary0)} med/季=${efficiency(ordinary0).toFixed(1)}`);
console.log(`普通 A10: med=${median(ordinary10)} p90=${p90(ordinary10)} med/季=${efficiency(ordinary10).toFixed(1)}`);
console.log(`高手 A0: med=${median(expert0)} p90=${p90(expert0)} med/季=${efficiency(expert0).toFixed(1)}`);
console.log(`高手 A10: med=${median(expert10)} p90=${p90(expert10)} med/季=${efficiency(expert10).toFixed(1)}`);
for (const gate of gates) console.log(`${gate.pass ? "✓" : "✗"} ${gate.id.padEnd(20)} ${gate.measured.toFixed(3)} · ${gate.target}`);

const failures = gates.filter((gate) => !gate.pass);
if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} 条飞升经济门槛未通过`);
  process.exitCode = 1;
} else {
  console.log("\nPASS: 普通路线不可速刷，高飞升高手尾部获得显著溢价");
}
