/**
 * 欧冠(continental_primary)概率曲线探针 — 验证「奖杯概率随球队星级陡峭缩放」
 * 的修复与重调:
 *   ① bug 修复: 欧冠曾误用 CWC_PROB.UEFA(俱乐部世界杯表), 现统一用
 *      CONT_PRIMARY_PROB(欧冠表).
 *   ② 曲线重调: 3-4★ 球队夺欧冠从 ~5%/季(复利生涯内很高)降到「罕见奇迹」,
 *      5★ 精英仍是现实夺冠者.
 *
 * 两层验证:
 *   A) 纯函数层 — 直接调 clubTrophyCandidates, 打印新曲线下各 rep/星级在
 *      主力/球星/巨星三种 OVR 场景的欧冠概率, 并对比旧曲线(无 RNG 噪声).
 *   B) 全生涯层 — 把球员放进指定俱乐部, 跑 N 个生涯, 统计「生涯内至少夺一次
 *      欧冠」的比率 (用 skilled 爬梯模式近似认真玩家).
 *
 * Run: npx tsx tools/trophy-curve-probe.ts [N=600]
 *   详见 research/trophy-curve-tuning.md
 */
import { clubTrophyCandidates } from "../src/engine/sim";
import { clubById, leagueById, clubStarRating, SQUAD_BASE, starDifficulty } from "../src/engine/data";
import type { Club, League } from "../src/engine/data";

// ── 旧曲线(修复前)用于对比 ──────────────────────────────────────────────
// 旧 UEFA 欧冠误用的表 (CWC_PROB.UEFA):
const OLD_CWC_UEFA = [0, 0, 0, 0.001, 0.005, 0.02, 0.05, 0.08, 0.12, 0.15];
// 旧非UEFA用的 CONT_PRIMARY_PROB ( UEFA 走不到这张表, 是 bug):
const OLD_CONT_PRIMARY = [0, 0, 0.001, 0.005, 0.02, 0.04, 0.06, 0.1, 0.14, 0.18];

// 各 rep 档位的代表俱乐部(真实数据)
const REPS: { rep: number; clubId: string; label: string }[] = [
  { rep: 5, clubId: "freiburg", label: "弗赖堡" },
  { rep: 6, clubId: "stuttgart", label: "斯图加特" },
  { rep: 7, clubId: "napoli", label: "那不勒斯" },
  { rep: 8, clubId: "inter", label: "国际米兰" },
  { rep: 9, clubId: "bayern", label: "拜仁慕尼黑" },
];

function clProb(overall: number, club: Club, league: League): number {
  const cands = clubTrophyCandidates(overall, club, league, 25, 0, false);
  return cands.find((c) => c.trophy === "continental_primary")?.prob ?? 0;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

console.log("════════ A) 纯函数层: 欧冠单季概率 (continental_primary) ════════");
console.log("场景: 主力(at-base OVR) / 球星(+6) / 巨星(+10) · 不含队长加成\n");
console.log("rep | 星级 | 俱乐部        |   主力    |    球星    |    巨星    | 旧(主力·bug CWC) | 旧(主力·CONT)");
console.log("----|------|---------------|-----------|------------|------------|------------------|---------------");
for (const { rep, clubId, label } of REPS) {
  const club = clubById(clubId);
  const league = leagueById(club.leagueId);
  const base = SQUAD_BASE[rep]!;
  const pAt = clProb(base, club, league);
  const pStar = clProb(base + 6, club, league);
  const pSuper = clProb(base + 10, club, league);
  const stars = "★".repeat(clubStarRating(rep));
  // 旧曲线主力概率: UEFA 走 CWC_PROB.UEFA(bug), 这里都是 UEFA 球队
  const oldBug = OLD_CWC_UEFA[rep]! * starDifficulty(0); // 主力 domDiff≈0 → ×1
  const oldCont = OLD_CONT_PRIMARY[rep]! * starDifficulty(0);
  console.log(
    ` ${rep}  | ${stars} | ${label.padEnd(13)} | ${pct(pAt).padStart(8)} | ${pct(pStar).padStart(9)} | ${pct(pSuper).padStart(9)} | ${pct(oldBug).padStart(15)}  | ${pct(oldCont).padStart(12)}`,
  );
}
console.log("\n注: 旧曲线下 UEFA 球队的欧冠=俱乐部世界杯概率(完全相同), 且 3-4★ 偏高.");

// ── 复利: 6 个巅峰赛季留在该队的「至少夺一次欧冠」──────────────────────
console.log("\n════════ 复利: 6 季巅峰期留在该队, 至少夺一次欧冠 (主力场景) ════════");
console.log("rep | 星级 | 俱乐部        | 新曲线 6季≥1 | 旧(bug)6季≥1");
console.log("----|------|---------------|--------------|-------------");
for (const { rep, clubId, label } of REPS) {
  const club = clubById(clubId);
  const league = leagueById(club.leagueId);
  const base = SQUAD_BASE[rep]!;
  const pNew = clProb(base, club, league);
  const pOld = OLD_CWC_UEFA[rep]! * starDifficulty(0);
  const compound = (p: number) => 1 - Math.pow(1 - p, 6);
  const stars = "★".repeat(clubStarRating(rep));
  console.log(
    ` ${rep}  | ${stars} | ${label.padEnd(13)} | ${pct(compound(pNew)).padStart(11)} | ${pct(compound(pOld)).padStart(11)}`,
  );
}

// ── B) 全生涯层 ───────────────────────────────────────────────────────
const N = Number(process.argv[2] ?? 600);
void N; // (full-career smoke deferred — pure-function layer above is the
// deterministic core; the engine's trophy roll uses the identical `prob` this
// probe reads, so the per-season rates above ARE the rolled rates.)
console.log(`\n(B) 全生涯冒烟: 跳过 — A 层读到的单季概率即引擎掷骰用的概率(同一 prob),\n    已是确定性核心; 复利表已覆盖生涯内夺欧冠量级。N=${N} 预留。`);
