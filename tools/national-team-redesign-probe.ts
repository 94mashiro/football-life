/**
 * 国家队/世界杯路线重设计探针 — 验证世界杯决战 reach 曲线(research/
 * national-team-redesign.md §C2/D1)的验收标准。直接测引擎导出的 wcReachOdds
 * (精确公式值) + 跨 seed 掷 career-stable reach roll(经验命中率应收敛到公式值),
 * 不跑完整生涯(隔离成长/转会/退役噪声)。
 *
 * 验收:
 *   AC#1  中国+92 reach > 0 (改前硬墙=0,永不触发) — wcReachOdds(0,92)=0.17
 *   AC#2  巴西+82 reach ≈ 0.30 (9.0% 生涯夺冠基线不回退) — wcReachOdds(5,82)=0.30
 *   AC#3  中国+92 reach ∈ [0.12,0.22];中国+82 ≤ 0.06
 *   AC#4  OVR 92 梯度 bra > por > jpn > chn(单调)
 *   AC#6  OVR<82 → carry=0,reach=base(不触发决赛路径——决赛 floor 82 由路由保证)
 *
 * 经验命中率:对每个 (fifaRep,ovr) 跨 N seed 掷 chance(derive(seed,"wc-reach",
 * "career"), wcReachOdds(...)),频率应≈公式值(law of large numbers)——验证 reach
 * 确实用这个概率驱动 career-stable 单掷。
 *
 * Run:  npx tsx tools/national-team-redesign-probe.ts [N=20000]
 */
import { wcReachOdds } from "../src/engine/run";
import { chance, derive } from "../src/engine/rng";

const N = Number(process.argv[2] ?? 20000);

// fifaRep: bra(5) / por(3) / jpn(1) / chn(0). winOdds 分档: 4-5→0.30, 2-3→0.27, 0-1→0.30
const CASES: { nation: string; fifaRep: number; ovr: number; win: number }[] = [
  { nation: "chn", fifaRep: 0, ovr: 82, win: 0.30 },
  { nation: "chn", fifaRep: 0, ovr: 88, win: 0.30 },
  { nation: "chn", fifaRep: 0, ovr: 92, win: 0.30 },
  { nation: "jpn", fifaRep: 1, ovr: 82, win: 0.30 },
  { nation: "jpn", fifaRep: 1, ovr: 92, win: 0.30 },
  { nation: "por", fifaRep: 3, ovr: 82, win: 0.27 },
  { nation: "por", fifaRep: 3, ovr: 92, win: 0.27 },
  { nation: "bra", fifaRep: 5, ovr: 82, win: 0.30 },
  { nation: "bra", fifaRep: 5, ovr: 92, win: 0.30 },
  { nation: "bra", fifaRep: 5, ovr: 96, win: 0.30 },
];

console.log(`N=${N} empirical reach rolls per combo\n`);
console.log("nation\tfifaRep\tovr\treachOdds(formula)\treachEmp%\ttitleExp%(reach×win)");
let pass = true;
for (const c of CASES) {
  const odds = wcReachOdds(c.fifaRep, c.ovr);
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const seed = `probe:${c.nation}:${c.ovr}:${i}`;
    if (chance(derive(seed, "wc-reach", "career"), odds)) hits++;
  }
  const emp = hits / N;
  const titleExp = odds * c.win;
  console.log(`${c.nation}\t${c.fifaRep}\t${c.ovr}\t${odds.toFixed(4)}\t\t${(emp * 100).toFixed(2)}%\t\t${(titleExp * 100).toFixed(2)}%`);
  // 经验值应在公式值 ±1.5pp 内(N=20000, binomial σ ≈ sqrt(p(1-p)/N) ≈ 0.003)
  if (Math.abs(emp - odds) > 0.015) {
    console.log(`  ✗ FAIL 经验命中率 ${(emp * 100).toFixed(2)}% 偏离公式值 ${(odds * 100).toFixed(2)}% 超 1.5pp`);
    pass = false;
  }
}

const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "✓ PASS" : "✗ FAIL"}  ${msg}`);
  if (!cond) pass = false;
};

console.log("\n── 验收检查 ──");
// AC#1: 中国+92 reach > 0 (改前 0)
check(wcReachOdds(0, 92) > 0, `AC#1 中国+92 reach=${wcReachOdds(0, 92).toFixed(3)} > 0 (改前硬墙=0)`);
// AC#2: 巴西+82 reach ≈ 0.30
const bra82 = wcReachOdds(5, 82);
check(Math.abs(bra82 - 0.30) < 0.001, `AC#2 巴西+82 reach=${bra82.toFixed(3)} ≈ 0.30 (夺冠 ${(bra82 * 0.3 * 100).toFixed(1)}%,基线不回退)`);
// AC#3: 中国+92 ∈ [0.12,0.22];中国+82 ≤ 0.06
const chn92 = wcReachOdds(0, 92);
check(chn92 >= 0.12 && chn92 <= 0.22, `AC#3 中国+92 reach=${chn92.toFixed(3)} ∈ [0.12,0.22] (夺冠 ${(chn92 * 0.3 * 100).toFixed(1)}%)`);
check(wcReachOdds(0, 82) <= 0.06, `AC#3 中国+82 reach=${wcReachOdds(0, 82).toFixed(3)} ≤ 0.06`);
// AC#4: OVR 92 生涯夺冠期望梯度 (reach × winOdds) bra > por > jpn > chn。
//   注:reach 单独非单调(por 0.33 > bra 0.30)是设计意图——中坚国(葡)靠球星
//   carry 更常摸到决赛,但每次夺冠胜率更低(win 0.27<0.30),故夺冠期望仍 bra>por。
//   「葡萄牙需要英雄,巴西靠阵容厚度」(research/national-team-redesign.md §C2)。
const t92 = {
  bra: wcReachOdds(5, 92) * 0.30,
  por: wcReachOdds(3, 92) * 0.27,
  jpn: wcReachOdds(1, 92) * 0.30,
  chn: wcReachOdds(0, 92) * 0.30,
};
check(t92.bra > t92.por && t92.por > t92.jpn && t92.jpn > t92.chn, `AC#4 OVR92 夺冠期望梯度 bra(${(t92.bra * 100).toFixed(2)}%) > por(${(t92.por * 100).toFixed(2)}%) > jpn(${(t92.jpn * 100).toFixed(2)}%) > chn(${(t92.chn * 100).toFixed(2)}%)`);
// AC#6: OVR<82 → carry=0 (reach=base,决赛路径由路由的 OVR≥82 floor 保证不触发)
check(wcReachOdds(5, 81) === wcReachOdds(5, 82), `AC#6 OVR 81 carry=0 (reach=base=${wcReachOdds(5, 81).toFixed(3)},决赛路径由 floor 82 拦截)`);
check(wcReachOdds(0, 75) === wcReachOdds(0, 82), `AC#6 OVR 75 carry=0 (reach=base=${wcReachOdds(0, 75).toFixed(3)})`);

console.log(`\n${pass ? "ALL CHECKS PASS" : "SOME CHECKS FAILED"}`);
process.exit(pass ? 0 : 1);
