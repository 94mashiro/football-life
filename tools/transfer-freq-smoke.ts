/**
 * 转会窗频率冒烟 — 统计每生涯「转会窗决策」(transfer/wage_squeeze) 出现次数
 * 与实际转会次数,验证「每 2-3 季一次转会选项」的设计意图。
 *
 * Run: npx tsx tools/transfer-freq-smoke.ts [N=400]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const N = Number(process.argv[2] ?? 400);

interface Setup { nation: string; pos: RunSetup["position"]; league: string; pace: RunSetup["pace"]; label: string; stay?: boolean }
const SETUPS: Setup[] = [
  { nation: "bra", pos: "ST", league: "premier-league", pace: "normal", label: "BRA ST 英超 爬梯" },
  { nation: "eng", pos: "CM", league: "premier-league", pace: "normal", label: "ENG CM 英超 爬梯" },
  { nation: "chn", pos: "ST", league: "china-league-one", pace: "normal", label: "CHN ST 中甲 爬梯" },
  { nation: "bra", pos: "ST", league: "premier-league", pace: "normal", label: "BRA ST 英超 留守", stay: true },
];

function clubStars(c: Choice, g: GameState): number {
  if (c.id === "stay" || c.kind === "stay" || c.kind === "join_loan") {
    try { const r = clubById(g.currentClubId).rep; return r >= 8 ? 5 : r >= 6 ? 4 : r >= 4 ? 3 : r >= 2 ? 2 : 1; } catch { return 0; }
  }
  return (c.sub ?? "").split("★").length - 1;
}
function pickChoice(g: GameState, stayMode: boolean): Choice {
  const ch = g.pendingChoice!.choices;
  if (ch.length === 1) return ch[0]!;
  const key = g.pendingChoice!.key;
  if (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer") {
    if (stayMode) {
      const stay = ch.find((c) => c.kind === "stay" || c.id === "stay");
      if (stay) return stay;
    }
    const clubs = ch.filter((c) => (c.kind === "new_club" || c.kind === "permanent_transfer") && (c.sub ?? "").includes("主力"));
    if (clubs.length) return clubs.reduce((best, c) => clubStars(c, g) > clubStars(best, g) ? c : best, clubs[0]!);
    const stay = ch.find((c) => c.kind === "stay" || c.id === "stay");
    if (stay) return stay;
  }
  const b = ch.find((c) => c.id === "b");
  if (b) return b;
  return ch[0]!;
}

function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

interface Counters { transferWindows: number; wageSqueeze: number; actualTransfers: number; seasons: number; retireAge: number; clubCount: number; }
function playOne(seed: string, setup: Setup): Counters {
  const baseSetup: RunSetup = {
    seed, nationalityId: setup.nation, position: setup.pos, leagueId: setup.league,
    pace: setup.pace, ascension: 0, blessings: [], allowWonderkid: false, permPerks: [],
  };
  let g = simulatePeriod(createRun(baseSetup));
  const c: Counters = { transferWindows: 0, wageSqueeze: 0, actualTransfers: 0, seasons: 0, retireAge: 0, clubCount: 1 };
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const key = g.pendingChoice.key;
      if (key === "transfer") c.transferWindows++;
      if (key === "wage_squeeze") c.wageSqueeze++;
      const ch = pickChoice(g, !!setup.stay);
      // 俱乐部变更现在经 pendingMods 下期生效，故用所选选项的 kind 判断「实际转会」
      // （new_club/permanent_transfer = 永久换队；join_loan = 租借不计入）。
      const isActualMove = ch.kind === "new_club" || ch.kind === "permanent_transfer";
      g = resolveChoice(g, ch);
      if (isActualMove) c.actualTransfers++;
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  c.seasons = g.seasons.length;
  c.retireAge = g.age;
  const clubs = new Set(g.seasons.map((s) => s.clubId));
  c.clubCount = clubs.size;
  return c;
}

const allByLabel: Record<string, Counters[]> = {};
for (const s of SETUPS) allByLabel[s.label] = [];
for (let i = 0; i < N; i++) {
  for (const s of SETUPS) {
    allByLabel[s.label].push(playOne(`smoke-${i}-${hash32(`smoke-${s.label}-${i}`)}`, s));
  }
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}
function rate(arr: number[], thr: number, below = false): number {
  if (!arr.length) return 0;
  const n = below ? arr.filter((x) => x <= thr).length : arr.filter((x) => x >= thr).length;
  return Math.round((n / arr.length) * 100);
}

console.log(`转会窗频率冒烟 · N=${N} per setup · (设计意图: 19-31岁每2季 ≈ 7 个转会窗)\n`);
console.log("setup".padEnd(20) + "转会窗中位".padStart(10) + "p10".padStart(6) + "p90".padStart(6) + "0窗占比".padStart(9) + "≥6窗占比".padStart(9) + "实际转会中位".padStart(12) + "俱乐部数中位".padStart(12));
for (const label of Object.keys(allByLabel)) {
  const arr = allByLabel[label]!;
  const windows = arr.map((c) => c.transferWindows + c.wageSqueeze);
  const transfers = arr.map((c) => c.actualTransfers);
  const clubs = arr.map((c) => c.clubCount);
  const zeroW = rate(windows, 0, true);
  const sixW = rate(windows, 6);
  console.log(
    label.padEnd(20) +
    String(median(windows)).padStart(10) +
    String(pct(windows, 0.1)).padStart(6) +
    String(pct(windows, 0.9)).padStart(6) +
    (zeroW + "%").padStart(9) +
    (sixW + "%").padStart(9) +
    String(median(transfers)).padStart(12) +
    String(median(clubs)).padStart(12)
  );
}
console.log("\n转会窗 = key transfer + wage_squeeze 决策出现次数 (玩家可选择留守)");
console.log("设计目标: 19-31 岁每 2 季一个窗 → 生涯应稳定出现 ~7 个转会决策");
