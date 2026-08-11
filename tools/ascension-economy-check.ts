/**
 * 飞升经济回归门（P-ASC-PREMIUM 版）：同一批种子对照多个飞升档，三类人群。
 *
 * 设计哲学（业主定稿，取代旧的「A10 不得超过 A0」）：高难度伴随高收益，
 * 但溢价必须按表现兑现、且有天花板——
 * - 盲选（varied）人群的中位必须持平：摆烂爬梯不多赚，这是反刷分地板；
 * - 稳策略（first+转会拣星）人群的 p75 兑现前重后缓的累计溢价
 *   （A5 ≈ ×2.8、A10 ≈ ×4.1，锚点见 src/meta/legacy.ts ASCENSION_REWARD_CURVES）；
 * - 满威望高手的 A10 尾部有溢价但受尾段斜率退坡约束，不得爆炸；
 * - 高手 A10 尾部与盲选 A0 拉开数量级可感知的差距（榜单叙事）。
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

/** 转会拣星、其余选第一项 —— 任何玩家都能照抄的公开稳策略。 */
const steadyPolicy: Policy = (choices, key, periodIndex, seed, state) => {
  if (state && (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer")) {
    return choices.reduce((best, choice) => clubStars(choice, state) > clubStars(best, state) ? choice : best, choices[0]!);
  }
  return POLICIES.first(choices, key, periodIndex, seed, state);
};

/** 满威望高手：拣星 + varied 的散开路径（历史口径保留）。 */
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

const blind0 = sample(profile("blind-a0", 0, false), POLICIES.varied);
const blind10 = sample(profile("blind-a10", 10, false), POLICIES.varied);
const steady0 = sample(profile("steady-a0", 0, false), steadyPolicy);
const steady5 = sample(profile("steady-a5", 5, false), steadyPolicy);
const steady10 = sample(profile("steady-a10", 10, false), steadyPolicy);
const expert0 = sample(profile("expert-a0", 0, true), expertPolicy);
const expert10 = sample(profile("expert-a10", 10, true), expertPolicy);

const legacy = (traces: readonly CareerTrace[]) => traces.map((trace) => trace.legacy);
const median = (traces: readonly CareerTrace[]) => quantile(legacy(traces), 0.5);
const p75 = (traces: readonly CareerTrace[]) => quantile(legacy(traces), 0.75);
const p90 = (traces: readonly CareerTrace[]) => quantile(legacy(traces), 0.9);
const ratio = (value: number, baseline: number) => value / Math.max(1, baseline);

interface Gate {
  readonly id: string;
  readonly target: string;
  readonly measured: number;
  readonly pass: boolean;
}

const blindMedianRatio = ratio(median(blind10), median(blind0));
const steadyP75A5 = ratio(p75(steady5), p75(steady0));
const steadyP75A10 = ratio(p75(steady10), p75(steady0));
const expertP90Ratio = ratio(p90(expert10), p90(expert0));
const expertSeparation = ratio(p90(expert10), p90(blind0));

const gates: Gate[] = [
  // 反刷分地板：盲选中位大致持平（曲线把随机人群 p50 锚回 A0 水位）。
  // 上界 1.30 而非 1.00：锚点用 xorshift 随机策略标定，varied 的哈希散开口径
  // 略高 ~20%；追求逐策略精确持平是过拟合，地板要挡的是「数量级」的白赚。
  { id: "blind.median", target: "0.85 ≤ A10/A0 ≤ 1.30", measured: blindMedianRatio, pass: blindMedianRatio >= 0.85 && blindMedianRatio <= 1.30 },
  // 溢价兑现：稳策略 p75 落在前重后缓曲线的 A5/A10 目标带。
  { id: "steady.p75.A5", target: "2.2 ≤ A5/A0 ≤ 3.4", measured: steadyP75A5, pass: steadyP75A5 >= 2.2 && steadyP75A5 <= 3.4 },
  { id: "steady.p75.A10", target: "3.2 ≤ A10/A0 ≤ 5.0", measured: steadyP75A10, pass: steadyP75A10 >= 3.2 && steadyP75A10 <= 5.0 },
  // 高手尾部：有溢价（≥1.3）但被尾段斜率退坡封顶（≤5.0），不得爆炸。
  { id: "expert.p90", target: "1.3 ≤ A10/A0 ≤ 5.0", measured: expertP90Ratio, pass: expertP90Ratio >= 1.3 && expertP90Ratio <= 5.0 },
  // 榜单叙事：高手 A10 尾部对盲选 A0 尾部保持数量级差距。
  { id: "expert.separation", target: "高手A10 P90 / 盲选A0 P90 ≥ 3.00", measured: expertSeparation, pass: expertSeparation >= 3.00 },
];

console.log(`飞升经济门槛 · N=${N}/cell`);
console.log(`盲选 A0: med=${median(blind0)} p90=${p90(blind0)}`);
console.log(`盲选 A10: med=${median(blind10)} p90=${p90(blind10)}`);
console.log(`稳策略 A0: med=${median(steady0)} p75=${p75(steady0)}`);
console.log(`稳策略 A5: med=${median(steady5)} p75=${p75(steady5)}`);
console.log(`稳策略 A10: med=${median(steady10)} p75=${p75(steady10)}`);
console.log(`高手 A0: med=${median(expert0)} p90=${p90(expert0)}`);
console.log(`高手 A10: med=${median(expert10)} p90=${p90(expert10)}`);
for (const gate of gates) console.log(`${gate.pass ? "✓" : "✗"} ${gate.id.padEnd(20)} ${gate.measured.toFixed(3)} · ${gate.target}`);

const failures = gates.filter((gate) => !gate.pass);
if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} 条飞升经济门槛未通过`);
  process.exitCode = 1;
} else {
  console.log("\nPASS: 盲选不涨不跌、稳策略按曲线兑现溢价、高手尾部有顶");
}
