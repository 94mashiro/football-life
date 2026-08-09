/**
 * 国家队/奖项门槛探针 — 验证「弱球员不该触发国家队/世界杯/金球/最佳阵容」
 * 的设计目标。按国家强度 (intlRep) 分档测量:
 *   - 巅峰 OVR 分布 (p50/p90/≥80/≥85/≥90)
 *   - 国家队入选率 (任一赛季 calledUp)
 *   - 国家队大赛出场率 (任一赛季 national.tournament 有值——含 showdown 与被动出线)
 *   - 世界杯夺冠率 / 洲际杯夺冠率
 *   - 最佳阵容(toty)率 / MVP 率 / 金球率
 *   * 重点诊断: 在「弱球员」(巅峰 < 78) 子群里, 上述事件的触发率——
 *   这是用户反馈的核心: 能力差的球员不该触发国家队/世界杯/金球/最佳阵容。
 *
 * Run:  npx tsx tools/national-gate-probe.ts [N=400]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const N = Number(process.argv[2] ?? 400);

// tiny xorshift32 for reproducible choice picking (harness-only, never the engine)
let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function pickChoice(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  if (ch.length === 1) return ch[0]!;
  const key = g.pendingChoice!.key;
  // transfer-style: prefer the bigger club (mirrors a player climbing the ladder)
  if (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer" || key === "relegation_loyalty" || key === "underperform_release" || key === "stuck_release") {
    const stars = (c: Choice) => {
      if (c.id === "stay") { try { const r = clubById(g.currentClubId).rep; return r >= 8 ? 5 : r >= 6 ? 4 : r >= 4 ? 3 : r >= 2 ? 2 : 1; } catch { return 0; } }
      return (c.sub ?? "").split("★").length - 1;
    };
    let best = 0, bs = -1;
    for (let i = 0; i < ch.length; i++) { const s = stars(ch[i]!); if (s > bs) { bs = s; best = i; } }
    return ch[best]!;
  }
  return ch[rint(0, ch.length - 1)]!;
}

interface Setup { nation: string; league: string; label: string; }
const SETUPS: Setup[] = [
  { nation: "bra", league: "brasileirao", label: "巴西(intlRep5 强)" },
  { nation: "fra", league: "ligue-1", label: "法国(intlRep5 强)" },
  { nation: "jpn", league: "j1-league", label: "日本(intlRep3 中)" },
  { nation: "mex", league: "liga-mx", label: "墨西哥(intlRep3 中)" },
  { nation: "chn", league: "csl", label: "中国(intlRep1 弱)" },
  { nation: "tha", league: "j1-league", label: "泰国(intlRep0 极弱)" },
];

interface RunStats {
  peak: number;
  calledUp: boolean;
  natTournament: boolean;   // any season with a tournament stage (showdown or qualified)
  wcWon: boolean;
  contWon: boolean;
  toty: boolean;
  mvp: boolean;
  ballon: boolean;
  peakAtCallup: number | null; // the OVR at the FIRST called-up season (who gets in?)
}

function playOne(seed: string, s: Setup): RunStats {
  _s = 0x9e3779b9 ^ hash32(seed + s.nation);
  const setup: RunSetup = { seed, nationalityId: s.nation, position: "ST", leagueId: s.league,
    blessings: [], ascension: 0, pace: "normal", permPerks: [], allowWonderkid: true };
  let g: GameState = simulatePeriod(createRun(setup));
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const ch = g.pendingChoice.choices;
      const pick = ch.length > 1 ? pickChoice(g) : ch[0]!;
      g = resolveChoice(g, pick);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else g = simulatePeriod(g);
  }
  let peak = 0, firstCallOvr: number | null = null;
  let calledUp = false, natTournament = false, wcWon = false, contWon = false, toty = false, mvp = false;
  for (const ssn of g.seasons) {
    peak = Math.max(peak, ssn.overall);
    if (ssn.national?.calledUp) { calledUp = true; if (firstCallOvr === null) firstCallOvr = ssn.overall; }
    if (ssn.national?.tournament) natTournament = true;
    if (ssn.trophies.includes("world_cup")) wcWon = true;
    if (ssn.trophies.includes("national_continental")) contWon = true;
    if (ssn.seasonHonors?.includes("toty")) toty = true;
    if (ssn.seasonHonors?.includes("mvp")) mvp = true;
  }
  const ballon = g.awards.includes("ballon_dor");
  return { peak, calledUp, natTournament, wcWon, contWon, toty, mvp, ballon, peakAtCallup: firstCallOvr };
}

const pct = (arr: number[], p: number) => { const ss = [...arr].sort((a, b) => a - b); return ss[Math.min(ss.length - 1, Math.floor(ss.length * p))]!; };
const rate = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`.padStart(6);

console.log(`国家队/奖项门槛探针 · N=${N}/档 (随机选择 + 爬梯)\n`);
console.log("档位                  巅峰p50 p90  ≥80    ≥85    入选率  大赛率  世界杯 洲际杯 最佳阵 MVP  金球  首次入选OVR");
for (const s of SETUPS) {
  const runs: RunStats[] = [];
  for (let i = 0; i < N; i++) runs.push(playOne(`ngp-${i}`, s));
  const peaks = runs.map((r) => r.peak);
  const callOvrs = runs.filter((r) => r.peakAtCallup !== null).map((r) => r.peakAtCallup!);
  console.log(
    `${s.label.padEnd(18)}  ${pct(peaks, 0.5).toString().padStart(3)}  ${pct(peaks, 0.9).toString().padStart(3)}  ${rate(runs.filter((r) => r.peak >= 80).length, N)} ${rate(runs.filter((r) => r.peak >= 85).length, N)} ${rate(runs.filter((r) => r.calledUp).length, N)} ${rate(runs.filter((r) => r.natTournament).length, N)} ${rate(runs.filter((r) => r.wcWon).length, N)} ${rate(runs.filter((r) => r.contWon).length, N)} ${rate(runs.filter((r) => r.toty).length, N)} ${rate(runs.filter((r) => r.mvp).length, N)} ${rate(runs.filter((r) => r.ballon).length, N)}  ${callOvrs.length ? pct(callOvrs, 0.5) : "-"}`,
  );
}

// 诊断: 弱球员 (巅峰 < 78) 子群里这些事件的触发率——核心痛点
console.log("\n=== 诊断: 弱球员 (巅峰 < 78) 子群触发率 (应接近 0) ===");
console.log("档位                  弱球员数  入选率  大赛率  世界杯 洲际杯 最佳阵 MVP  金球  首次入选OVR");
for (const s of SETUPS) {
  const runs: RunStats[] = [];
  for (let i = 0; i < N; i++) runs.push(playOne(`ngp-${i}`, s));
  const weak = runs.filter((r) => r.peak < 78);
  if (weak.length === 0) { console.log(`${s.label.padEnd(18)}  0`); continue; }
  const callOvrs = weak.filter((r) => r.peakAtCallup !== null).map((r) => r.peakAtCallup!);
  console.log(
    `${s.label.padEnd(18)}  ${weak.length.toString().padStart(3)}    ${rate(weak.filter((r) => r.calledUp).length, weak.length)} ${rate(weak.filter((r) => r.natTournament).length, weak.length)} ${rate(weak.filter((r) => r.wcWon).length, weak.length)} ${rate(weak.filter((r) => r.contWon).length, weak.length)} ${rate(weak.filter((r) => r.toty).length, weak.length)} ${rate(weak.filter((r) => r.mvp).length, weak.length)} ${rate(weak.filter((r) => r.ballon).length, weak.length)}  ${callOvrs.length ? pct(callOvrs, 0.5) : "-"}`,
  );
}
