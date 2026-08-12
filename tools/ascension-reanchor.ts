/**
 * 飞升解锁门重锚探针（ADR-0006 版：货币 = 实绩 identity）。
 *
 * ADR-0006 删除了 `ASCENSION_REWARD_CURVES` 溢价曲线 —— 结算传承 = raw，全档不增不减。
 * 于是飞升解锁门 `ASCENSION_UNLOCK_REQ` 必须改读 **raw** 分位（旧值是通胀后的 meta
 * 分位，比 raw 大得多，留着会让门几乎打不开）。本探针按原标定口径重测各档 raw 分位，
 * 在 skilled(steady) 人群上取定命中率意图的分位，输出新的 raw 门槛数组。
 *
 * 命中率意图（保留，与旧门相同）：每档需在「飞升 N-1 单局 raw ≥ 门槛」才解锁 N ——
 *   asc1≈p57 ~42%、asc2-4≈p59 ~41%、asc5-6≈p71 ~29%、asc7-8≈p74 ~26%、
 *   asc9≈p87 ~13%、asc10≈p93 ~7%。
 * 口径与 ascension-economy-check 同：BRA ST 英超, 无祝福/perk, allowWonderkid=false
 * （门槛测的就是这人群）。
 *
 * 新的不变量（由 ascension-economy-check 守）：raw 随飞升单调不增（高难赚得更少），
 * 货币农场明确落在低飞升，高飞升的奖赏是榜位（飞升优先排序）而非传承币。
 *
 * Run: npx tsx tools/ascension-reanchor.ts [N=160]
 */
import { clubById } from "../src/engine/data";
import type { Choice, GameState } from "../src/engine/types";
import { drive, POLICIES, corpusSeed, quantile, type Policy, type Profile } from "./_harness";

const N = Number(process.argv[2] ?? 160);
const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
// 命中率意图（与旧门相同）：在飞升 N-1 的 skilled steady raw 分布上的分位。
const P_HIT = [0.57, 0.59, 0.59, 0.59, 0.71, 0.71, 0.74, 0.74, 0.87, 0.93];

const baseProfile = (ascension: number): Profile => ({
  id: `reanchor-a${ascension}`, nationalityId: "bra", position: "ST", leagueId: "premier-league",
  pace: "normal", blessings: [], ascension, allowWonderkid: false, permPerks: [],
});

function clubStars(choice: Choice, state: GameState): number {
  if (choice.id !== "stay" && choice.kind !== "stay") return (choice.sub ?? "").split("★").length - 1;
  try { const r = clubById(state.currentClubId).rep; return r >= 8 ? 5 : r >= 6 ? 4 : r >= 4 ? 3 : r >= 2 ? 2 : 1; }
  catch { return 0; }
}
/** 转会拣星、其余选第一项 —— 任何玩家都能照抄的公开稳策略（skilled 人群）。 */
const steadyPolicy: Policy = (choices, key, _pi, _seed, state) => {
  if (state && (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer"))
    return choices.reduce((best, c) => clubStars(c, state) > clubStars(best, state) ? c : best, choices[0]!);
  return POLICIES.first(choices, key, _pi, _seed, state);
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

// ── 不变量自检：raw 随飞升单调不增（高难不赚更多货币）──
let monotoneOk = true;
for (let asc = 1; asc < LEVELS.length; asc++) {
  const prevMed = rq(cells[asc - 1]!.steady)(0.5);
  const curMed = rq(cells[asc]!.steady)(0.5);
  if (curMed > prevMed) { monotoneOk = false; console.error(`✗ 单调性违反: asc${asc - 1} steady 中位 ${Math.round(prevMed)} < asc${asc} ${Math.round(curMed)}`); }
}

// ── 报告 ──
console.log(`飞升解锁门重锚 · N=${N}/cell · BRA ST 英超 / 无祝福perk / allowWonderkid=false`);
console.log(`raw 单调不增自检: ${monotoneOk ? "✓ PASS" : "✗ FAIL"}\n`);
console.log("各档 raw 分位 (varied=盲选 / steady=skilled):");
for (const asc of LEVELS) {
  const dv = rq(cells[asc]!.varied), ds = rq(cells[asc]!.steady);
  console.log(`asc ${String(asc).padStart(2)}: varied p50=${Math.round(dv(0.5))} p65=${Math.round(dv(0.65))} | steady p50=${Math.round(ds(0.5))} p75=${Math.round(ds(0.75))} p90=${Math.round(ds(0.90))} p99=${Math.round(ds(0.99))}`);
}

console.log("\n// ── 复制进 src/meta/legacy.ts ASCENSION_UNLOCK_REQ ──");
console.log("  0,     // 0");
for (let L = 1; L <= 10; L++) {
  const r = Math.round(rq(cells[L - 1]!.steady)(P_HIT[L - 1]!));
  console.log(`  ${String(r).padEnd(6)} // ${L}  ≈ p${Math.round(P_HIT[L - 1]! * 100)} @ asc ${L - 1} (skilled steady raw)`);
}

process.exitCode = monotoneOk ? 0 : 1;
