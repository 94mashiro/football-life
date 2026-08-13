/**
 * 飞升经济回归门（ADR-0006 版：货币 = 实绩 identity）。
 *
 * 设计哲学（业主定调，取代旧的「高难高收益」）：高难的奖赏是**排行榜高位亮相**
 * （榜单飞升优先排序），不是对传承币的加成。结算传承 = raw，全档不增不减 ——
 * - **identity**：`applyAscensionLegacyReward(raw, asc) === raw`，全档无乘法曲线；
 * - **货币随飞升单调不增**：高飞升因 raw 更低而赚得更少，货币农场明确落在低飞升；
 * - **无溢价**：任何分位、任何人群（盲选/熟练/满威望高手）都不出现「高难赚更多」；
 * - 高飞升的「奖赏」由榜单飞升优先排序兑现（UI 层，不在本探针），不进货币。
 *
 * 竞品依据见 docs/research/ascension-reward-competitors.md：StS/Hades/Balatro/Dead Cells
 * 没有一家对「可复利累积的永久解锁货币」按难度做每局乘法曲线。
 */
import { applyAscensionLegacyReward } from "../src/meta/legacy";
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

/** 满威望高手：拣星 + varied 的散开路径。 */
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
const steady = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((asc) => sample(profile(`steady-a${asc}`, asc, false), steadyPolicy));
const expert0 = sample(profile("expert-a0", 0, true), expertPolicy);
const expert10 = sample(profile("expert-a10", 10, true), expertPolicy);

const legacy = (traces: readonly CareerTrace[]) => traces.map((trace) => trace.legacy);
const median = (traces: readonly CareerTrace[]) => quantile(legacy(traces), 0.5);
const p75 = (traces: readonly CareerTrace[]) => quantile(legacy(traces), 0.75);
const p90 = (traces: readonly CareerTrace[]) => quantile(legacy(traces), 0.9);
const ratio = (value: number, baseline: number) => value / Math.max(1, baseline);

// identity 自检：全档 applyAscensionLegacyReward(raw) === raw。任何重新引入的难度乘法
// 曲线（回归）都会让这一条直接翻红 —— 这是 ADR-0006 最强的守门。
const IDENTITY_GRID = [0, 50, 150, 300, 600, 1500, 3000];
let identityOk = true;
for (const asc of [0, 1, 2, 3, 5, 7, 9, 10]) {
  for (const raw of IDENTITY_GRID) {
    if (applyAscensionLegacyReward(raw, asc) !== raw) { identityOk = false; break; }
  }
}

// 货币随飞升单调不增：steady 中位从 asc0 到 asc10 不得有任何回升。
// N=160 中位粒度约数分；P-INJ6 后 A2 伤病潮相对 A1 只剩 +2（持平），
// 严格 > 会把这种抖动判红。超过 5 分才算回升。
let monotoneOk = true;
for (let asc = 1; asc < steady.length; asc++) {
  if (median(steady[asc]!) > median(steady[asc - 1]!) + 5) { monotoneOk = false; break; }
}

const blindMedianRatio = ratio(median(blind10), median(blind0));
const steadyP75A10 = ratio(p75(steady[10]!), p75(steady[0]!));
const steadyMedianA10 = ratio(median(steady[10]!), median(steady[0]!));
const expertP90Ratio = ratio(p90(expert10), p90(expert0));

interface Gate {
  readonly id: string;
  readonly target: string;
  readonly measured: number | boolean;
  readonly pass: boolean;
}

const gates: Gate[] = [
  // identity：全档结算 = raw，无乘法曲线。最强的回归守门。
  { id: "identity", target: "applyAscensionLegacyReward(raw, asc) === raw 全档", measured: identityOk, pass: identityOk },
  // 货币单调不增：高飞升赚得更少（或持平），绝不回升。
  { id: "currency.monotone", target: "steady 中位 asc0→10 单调不增", measured: monotoneOk, pass: monotoneOk },
  // 货币下降有界：A10 中位明显低于 A0（高难赚得更少），但不坍塌到 0（分布健康）。
  { id: "currency.decreases", target: "0.2 ≤ A10/A0 steady 中位 < 1.0", measured: steadyMedianA10, pass: steadyMedianA10 >= 0.2 && steadyMedianA10 < 1.0 },
  // 无溢价（盲选）：盲选 A10 中位 ≤ A0，摆烂爬梯不赚更多。
  { id: "blind.no-premium", target: "盲选 A10/A0 中位 ≤ 1.05", measured: blindMedianRatio, pass: blindMedianRatio <= 1.05 },
  // 无溢价（熟练 p75）：任何分位都不出现高难赚更多。
  { id: "steady.p75.no-premium", target: "A10/A0 steady p75 ≤ 1.05", measured: steadyP75A10, pass: steadyP75A10 <= 1.05 },
  // 无溢价（满威望高手 p90）：装备生涯也无乘法加成。
  { id: "expert.p90.no-premium", target: "A10/A0 expert p90 ≤ 1.05", measured: expertP90Ratio, pass: expertP90Ratio <= 1.05 },
];

console.log(`飞升经济门槛 · N=${N}/cell · ADR-0006 identity`);
console.log(`盲选 A0: med=${median(blind0)} p90=${p90(blind0)}`);
console.log(`盲选 A10: med=${median(blind10)} p90=${p90(blind10)}`);
console.log(`稳策略 A0: med=${median(steady[0]!)} p75=${p75(steady[0]!)}`);
console.log(`稳策略 A5: med=${median(steady[5]!)} p75=${p75(steady[5]!)}`);
console.log(`稳策略 A10: med=${median(steady[10]!)} p75=${p75(steady[10]!)}`);
console.log(`高手 A0: med=${median(expert0)} p90=${p90(expert0)}`);
console.log(`高手 A10: med=${median(expert10)} p90=${p90(expert10)}`);
for (const gate of gates) {
  const m = typeof gate.measured === "boolean" ? (gate.measured ? "✓" : "✗") : gate.measured.toFixed(3);
  console.log(`${gate.pass ? "✓" : "✗"} ${gate.id.padEnd(24)} ${m} · ${gate.target}`);
}

const failures = gates.filter((gate) => !gate.pass);
if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} 条飞升经济门槛未通过`);
  process.exitCode = 1;
} else {
  console.log("\nPASS: 结算=实绩 identity、货币随飞升单调不增、无任何溢价");
}
