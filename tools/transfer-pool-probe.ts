/**
 * 转会/租借/青训 报价池多样性探针 — 衡量「固定起步 → 报价固定」的痛点。
 * 对给定国籍（默认中国 chn = 足协/T5），跨 N 个 seed 跑到第一个转会窗，
 * 统计青训抉择 + 首个转会窗 offer 的联赛/俱乐部分布。
 * Run: npx tsx tools/transfer-pool-probe.ts [nationId] [N] [pace]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById, leagueById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const nationId = process.argv[2] ?? "chn";
const N = Number(process.argv[3] ?? "40");
const pace = (process.argv[4] ?? "long") as RunSetup["pace"];

// pick a starter-role academy club (prefer 主力, else first club)
function pickAcademy(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  const main = ch.find((c) => (c.sub ?? "").includes("主力"));
  return main ?? ch[0]!;
}
// pick a starter-role transfer/loan offer (else stay)
function pickTransfer(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  const main = ch.find((c) => (c.sub ?? "").includes("主力") && c.kind !== "stay");
  if (main) return main;
  const stay = ch.find((c) => c.kind === "stay");
  return stay ?? ch[0]!;
}

function confederationOf(clubId: string) {
  return leagueById(clubById(clubId).leagueId).confederation;
}

const academyLeagues: Record<string, number> = {};
const academyClubs: Record<string, number> = {};
const firstWinLeagues: Record<string, number> = {};
const firstWinClubs: Record<string, number> = {};
const firstWinConfs: Record<string, number> = {};
let academySamples = 0;
let firstWinSamples = 0;
let firstWinAgeSum = 0;
const firstWinAgeHist: Record<number, number> = {};

for (let i = 0; i < N; i++) {
  const seed = `probe-${nationId}-${i}`;
  const setup: RunSetup = {
    seed, nationalityId: nationId, position: "ST", leagueId: "csl",
    pace: pace ?? "long", ascension: 0, blessings: [], allowWonderkid: false, permPerks: [],
  };
  let g = simulatePeriod(createRun(setup));
  // academy choice is the first pendingChoice
  if (g.pendingChoice && g.pendingChoice.key === "academy_choice") {
    for (const c of g.pendingChoice.choices) {
      if (!c.clubId) continue;
      const cl = clubById(c.clubId);
      const lg = leagueById(cl.leagueId);
      academyLeagues[lg.name] = (academyLeagues[lg.name] ?? 0) + 1;
      academyClubs[cl.name] = (academyClubs[cl.name] ?? 0) + 1;
      academySamples++;
    }
    g = resolveChoice(g, pickAcademy(g));
    if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
  }
  // advance to first transfer/loan window
  let guard = 0;
  while (g.phase === "playing" && guard++ < 60) {
    if (g.pendingChoice) {
      const key = g.pendingChoice.key;
      if (key === "transfer" || key === "loan_offer" || key === "wage_squeeze") {
        firstWinAgeSum += g.age;
        firstWinAgeHist[g.age] = (firstWinAgeHist[g.age] ?? 0) + 1;
        const curConf = confederationOf(g.currentClubId);
        for (const c of g.pendingChoice.choices) {
          if (!c.clubId || c.kind === "stay") continue;
          const cl = clubById(c.clubId);
          const lg = leagueById(cl.leagueId);
          firstWinLeagues[lg.name] = (firstWinLeagues[lg.name] ?? 0) + 1;
          firstWinClubs[cl.name] = (firstWinClubs[cl.name] ?? 0) + 1;
          firstWinConfs[lg.confederation] = (firstWinConfs[lg.confederation] ?? 0) + 1;
          firstWinSamples++;
        }
        // note: also count stay's current conf for context
        firstWinConfs[`__cur_${curConf}`] = (firstWinConfs[`__cur_${curConf}`] ?? 0) + 1;
        break;
      }
      g = resolveChoice(g, pickTransfer(g));
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
}

function top(obj: Record<string, number>, n: number): string {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${k}:${v}`).join("  ");
}

console.log(`\n===== 国籍 ${nationId}  pace=${pace ?? "long"}  N=${N} =====`);
console.log(`\n[青训抉择] 样本=${academySamples}  唯一联赛=${Object.keys(academyLeagues).length}  唯一俱乐部=${Object.keys(academyClubs).length}`);
console.log(`  联赛Top: ${top(academyLeagues, 8)}`);
console.log(`  俱乐部Top: ${top(academyClubs, 8)}`);
console.log(`\n[首个转会窗] 样本=${firstWinSamples}  俱乐部均龄=${(firstWinAgeSum / Math.max(1, Object.values(firstWinAgeHist).reduce((a, b) => a + b, 0))).toFixed(1)}`);
console.log(`  触发年龄分布: ${JSON.stringify(firstWinAgeHist)}`);
console.log(`  唯一联赛=${Object.keys(firstWinLeagues).length}  唯一俱乐部=${Object.keys(firstWinClubs).length}`);
console.log(`  联赛Top: ${top(firstWinLeagues, 10)}`);
console.log(`  俱乐部Top: ${top(firstWinClubs, 10)}`);
console.log(`  联盟分布(含__cur_前缀=球员当前联盟): ${top(firstWinConfs, 12)}`);
