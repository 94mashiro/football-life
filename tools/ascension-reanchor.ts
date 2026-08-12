/**
 * 飞升经济曲线重锚探针（一次性，P-HEADROOM）。
 *
 * 压低基础峰值后各档 raw 传承分布整体下移，旧 ASCENSION_REWARD_CURVES 锚点指向的
 * raw 值新分布够不着 → 溢价失效、steady.p75 门槛红。本探针按原标定口径重测各档 raw
 * 分位，按设计意图重算锚点，并用新曲线回算 ascension-economy 的 5 条门槛验证。
 *
 * 设计意图（保留，见 legacy.ts ASCENSION_REWARD_CURVES 注释）：
 *   - 随机人群(varied) p65 → flat 245 反刷分地板（A10 特例 250）；
 *   - 熟练人群(steady) p75/p90/p99 → asc0 同分位 raw × 累计溢价(tailSlope，不动)；
 *   - beyond p99: tailSlope = 累计溢价。
 * 口径与 ascension-economy-check 同：BRA ST 英超, 无祝福/perk, allowWonderkid=FALSE
 * （steady/blind 门槛测的就是这人群；原标定注的 allowWonderkid=true 与门槛人群不符，
 * 旧分布宽能容忍，压低后差距放大 → A10 p75 raw 偏高冲进锚间陡段。改同口径）。
 *
 * Run: npx tsx tools/ascension-reanchor.ts [N=400]
 */
import { clubById } from "../src/engine/data";
import type { Choice, GameState } from "../src/engine/types";
import { drive, POLICIES, corpusSeed, quantile, type Policy, type Profile } from "./_harness";

const N = Number(process.argv[2] ?? 400);
const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// 累计溢价（tailSlope）—— P-HEADROOM 不动这条轴，只重锚 raw 位置。
const TAIL_SLOPE = [1, 1.28, 1.64, 2.10, 2.41, 2.77, 3.00, 3.23, 3.49, 3.77, 4.08];
// 反刷分地板：A10 特例 250（盲选 A10 底部 raw 偏低，抚到 250 抬盲选中位到 ~0.86）。
const FLOOR = (asc: number) => (asc === 10 ? 250 : 245);

const baseProfile = (ascension: number): Profile => ({
  id: `reanchor-a${ascension}`, nationalityId: "bra", position: "ST", leagueId: "premier-league",
  pace: "normal", blessings: [], ascension, allowWonderkid: false, permPerks: [],
});
const EXPERT_BLESS = ["sharpshooter", "glass_cannon", "big_game_player"];
const ALL_PERKS = ["pp_prodigy", "pp_longevity", "pp_legacy_magnet", "pp_iron_will", "pp_transfer_savvy", "pp_comeback_base", "pp_oracle_base", "pp_scout", "pp_boss_slayer"];
const expertProfile = (ascension: number): Profile => ({
  id: `exp-a${ascension}`, nationalityId: "bra", position: "ST", leagueId: "premier-league",
  pace: "normal", blessings: EXPERT_BLESS, ascension, allowWonderkid: true, permPerks: ALL_PERKS,
});

function clubStars(choice: Choice, state: GameState): number {
  if (choice.id !== "stay" && choice.kind !== "stay") return (choice.sub ?? "").split("★").length - 1;
  try { const r = clubById(state.currentClubId).rep; return r >= 8 ? 5 : r >= 6 ? 4 : r >= 4 ? 3 : r >= 2 ? 2 : 1; }
  catch { return 0; }
}
const steadyPolicy: Policy = (choices, key, _pi, _seed, state) => {
  if (state && (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer"))
    return choices.reduce((best, c) => clubStars(c, state) > clubStars(best, state) ? c : best, choices[0]!);
  return POLICIES.first(choices, key, _pi, _seed, state);
};
const expertPolicy: Policy = (choices, key, _pi, _seed, state) => {
  if (state && (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer"))
    return choices.reduce((best, c) => clubStars(c, state) > clubStars(best, state) ? c : best, choices[0]!);
  return POLICIES.varied(choices, key, _pi, _seed, state);
};

interface Cell { varied: number[]; steady: number[]; }
function sample(asc: number): Cell {
  const varied: number[] = [], steady: number[] = [];
  for (let i = 0; i < N; i++) {
    const seed = `asc-econ-${corpusSeed(i)}`;
    varied.push(drive(seed, baseProfile(asc), POLICIES.varied).rawLegacy);
    steady.push(drive(seed, baseProfile(asc), steadyPolicy).rawLegacy);
  }
  return { varied, steady };
}
const cells = LEVELS.map(sample);
const rq = (d: number[]) => (q: number) => quantile(d, q);

// asc0 熟练分位 raw = 溢价基准（asc0 曲线 identity, meta=raw）。
const base75 = rq(cells[0]!.steady)(0.75), base90 = rq(cells[0]!.steady)(0.90), base99 = rq(cells[0]!.steady)(0.99);

// 新曲线（就地复制 applyAscensionLegacyReward 逻辑，用新锚点试算）。
function curve(rawLegacy: number, anchors: readonly (readonly [number, number])[], tailSlope: number): number {
  if (rawLegacy <= 0) return Math.round(rawLegacy);
  let px = 0, py = 0;
  for (const [x, y] of anchors) {
    if (rawLegacy <= x) return Math.round(py + ((rawLegacy - px) * (y - py)) / (x - px));
    px = x; py = y;
  }
  return Math.round(py + (rawLegacy - px) * tailSlope);
}
interface CurveDef { anchors: readonly (readonly [number, number])[]; tailSlope: number; }
const newCurves: CurveDef[] = LEVELS.map((asc) => {
  const ts = TAIL_SLOPE[asc]!;
  if (asc === 0) return { anchors: [] as readonly (readonly [number, number])[], tailSlope: ts };
  const dv = rq(cells[asc]!.varied), ds = rq(cells[asc]!.steady);
  return {
    anchors: [
      [Math.round(dv(0.65)), FLOOR(asc)],
      [Math.round(ds(0.75)), Math.round(base75 * ts)],
      [Math.round(ds(0.90)), Math.round(base90 * ts)],
      [Math.round(ds(0.99)), Math.round(base99 * ts)],
    ],
    tailSlope: ts,
  };
});
function metaOf(asc: number, rawLegacy: number): number {
  const c = newCurves[asc]!;
  return asc === 0 ? Math.round(rawLegacy) : curve(rawLegacy, c.anchors, c.tailSlope);
}

// ── 验证：用新曲线把缓存的 raw 折成 meta，回算 ascension-economy 5 条门槛 ──
const meta = LEVELS.map((asc) => ({
  varied: cells[asc]!.varied.map((r) => metaOf(asc, r)),
  steady: cells[asc]!.steady.map((r) => metaOf(asc, r)),
}));
// expert 单独跑（expert 装备生涯）。
const exRaw = (asc: number) => { const out: number[] = []; for (let i = 0; i < N; i++) out.push(drive(`asc-econ-${corpusSeed(i)}`, expertProfile(asc), expertPolicy).rawLegacy); return out; };
const ex0raw = exRaw(0), ex10raw = exRaw(10);

const ratio = (a: number, b: number) => a / Math.max(1, b);
const med = (xs: number[]) => quantile(xs, 0.5);
const p75 = (xs: number[]) => quantile(xs, 0.75);
const p90 = (xs: number[]) => quantile(xs, 0.90);
const blind0 = meta[0]!.varied, blind10 = meta[10]!.varied;
const steady0m = meta[0]!.steady, steady5m = meta[5]!.steady, steady10m = meta[10]!.steady;
const ex0 = ex0raw.map((r) => metaOf(0, r)), ex10 = ex10raw.map((r) => metaOf(10, r));

const gates: { id: string; target: string; m: number; pass: boolean }[] = [
  { id: "blind.median", target: "0.85 ≤ A10/A0 ≤ 1.30", m: ratio(med(blind10), med(blind0)), pass: false },
  { id: "steady.p75.A5", target: "2.2 ≤ A5/A0 ≤ 3.4", m: ratio(p75(steady5m), p75(steady0m)), pass: false },
  { id: "steady.p75.A10", target: "3.2 ≤ A10/A0 ≤ 5.0", m: ratio(p75(steady10m), p75(steady0m)), pass: false },
  { id: "expert.p90", target: "1.3 ≤ A10/A0 ≤ 5.0", m: ratio(p90(ex10), p90(ex0)), pass: false },
  { id: "expert.separation", target: "高手A10 P90 / 盲选A0 P90 ≥ 3.00", m: ratio(p90(ex10), p90(blind0)), pass: false },
];
for (const g of gates) {
  g.pass = g.id === "blind.median" ? (g.m >= 0.85 && g.m <= 1.30)
    : g.id === "steady.p75.A5" ? (g.m >= 2.2 && g.m <= 3.4)
    : g.id === "steady.p75.A10" ? (g.m >= 3.2 && g.m <= 5.0)
    : g.id === "expert.p90" ? (g.m >= 1.3 && g.m <= 5.0)
    : g.m >= 3.00;
}

// ── 报告 ──
console.log(`飞升经济重锚 · N=${N}/cell · BRA ST 英超 / 无祝福perk / allowWonderkid`);
console.log(`asc0 熟练分位(raw · 溢价基准): p75=${base75} p90=${base90} p99=${base99}\n`);
console.log("各档 raw 分位 + 新锚点:");
for (const asc of LEVELS) {
  const dv = rq(cells[asc]!.varied), ds = rq(cells[asc]!.steady);
  const c = newCurves[asc]!;
  console.log(`asc ${String(asc).padStart(2)}: varied p50=${Math.round(dv(0.5))} p65=${Math.round(dv(0.65))} | steady p75=${Math.round(ds(0.75))} p90=${Math.round(ds(0.90))} p99=${Math.round(ds(0.99))} | tailSlope ${c.tailSlope}`);
  if (c.anchors.length) console.log(`       anchors: ${c.anchors.map(([x, y]) => `[${x},${y}]`).join(", ")}`);
}
console.log("\n新曲线门槛回算 (ascension-economy 5 条):");
for (const g of gates) console.log(`${g.pass ? "✓" : "✗"} ${g.id.padEnd(20)} ${g.m.toFixed(3)} · ${g.target}`);
const fails = gates.filter((g) => !g.pass);
console.log(fails.length ? `\nFAIL: ${fails.length} 条未通过 → 调 FLOOR/tailSlope 或检查分位` : "\nPASS: 全部通过，可把下方 anchors 复制进 ASCENSION_REWARD_CURVES");

// ── 解锁门槛重定（skilled = steady, allowWonderkid=false；命中率意图同原：
//    asc1≈p57 ~42%、asc2-4≈p59 ~41%、asc5-6≈p71 ~29%、asc7-8≈p74 ~26%、
//    asc9≈p87 ~13%、asc10≈p93 ~7%）──
const P_HIT = [0.57, 0.59, 0.59, 0.59, 0.71, 0.71, 0.74, 0.74, 0.87, 0.93];
console.log("\n// ── 复制进 src/meta/legacy.ts ASCENSION_UNLOCK_REQ ──");
console.log("  0,     // 0");
for (let L = 1; L <= 10; L++) {
  const r = Math.round(quantile(meta[L - 1]!.steady, P_HIT[L - 1]!));
  console.log(`  ${String(r).padEnd(6)} // ${L}  ≈ p${Math.round(P_HIT[L - 1]! * 100)} @ asc ${L - 1} (skilled steady)`);
}

console.log("\n// ── 复制进 src/meta/legacy.ts ASCENSION_REWARD_CURVES ──");
for (const asc of LEVELS) {
  const c = newCurves[asc]!;
  if (asc === 0) { console.log("  { anchors: [], tailSlope: 1 }, // A0 — identity"); continue; }
  const a = c.anchors.map(([x, y]) => `[${x}, ${y}]`).join(", ");
  console.log(`  { anchors: [${a}], tailSlope: ${c.tailSlope} }, // A${asc}`);
}
process.exitCode = fails.length ? 1 : 0;
