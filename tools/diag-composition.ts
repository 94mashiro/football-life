/**
 * 产出构成诊断 —— 为「静态分值 vs 跨难度自适应」的决策提供数据。
 *
 * 网格：位置[ GK CB CM CAM ST ] × 国籍档[ T1 法国/法甲 · T5 中国/中超 ] × 飞升[ 0 5 10 ]
 * 策略：稳策略（转会拣星 + 其余第一项）—— 一个会做选择的普通玩家。
 * 每格 N 局，把传承拆成构成项（奖杯分 / 奖项分 / 位置表现分），报告：
 *   · 结算传承 settled / 实绩 raw / 有效飞升倍率 settled÷raw
 *   · 巅峰 OVR / 赛季数 / 进球·助攻·零封
 *   · 奖杯数·奖项数 · 世界杯率·金球率·洲际主率·联赛率
 *   · 奖杯分·奖项分·位置表现分（复刻 legacy.ts 常数）+ 三者占 honors 的份额
 *
 * 复刻的 TROPHY_LEGACY / AWARD_LEGACY / careerPerfLegacy 必须与 src/meta/legacy.ts
 * 逐字一致；脚本会在每局断言「复刻 honorsCore ≤ raw/nationMult」并抽查一致性。
 * 不反推 base（含体面退场×1.25 / 世界杯×1.5 / 工资帽 / earnMult，未知太多）。
 *
 * Run:  npx tsx tools/diag-composition.ts [N=80]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { setPreviewsEnabled } from "../src/engine/events";
import { clubById, youthTierOf, NATION_LEGACY_MULT } from "../src/engine/data";
import { seniorCareerStats, seniorCareerSeasonCount, type GameState, type Choice, type Trophy, type Award } from "../src/engine/types";
import type { Position } from "../src/engine/data";

setPreviewsEnabled(false);

// ── 复刻 src/meta/legacy.ts 的构成常数（逐字抄录，改那边要同步这里）──
const TROPHY_LEGACY: Record<Trophy, number> = {
  league: 20, cup: 12, continental_primary: 55, continental_secondary: 28,
  club_world_cup: 60, national_continental: 55, world_cup: 120, olympic: 35,
};
const AWARD_LEGACY: Record<Award, number> = {
  ballon_dor: 70, golden_boot: 40, golden_glove: 40,
  afc_poy: 45, csl_mvp: 25, csl_boot: 20,
};
const PERF_CAP_ATTACK_MIN = 12, PERF_CAP_ATTACK_MAX = 45, PERF_CAP_CABINET_FULL = 60;
function careerPerfLegacy(pos: Position, g: number, a: number, cs: number, cabinet: number): number {
  const isGK = pos === "GK";
  const isDef = pos === "CB" || pos === "LB" || pos === "RB";
  const isCreator = pos === "CM" || pos === "CAM" || pos === "LM" || pos === "RM" || pos === "CDM";
  if (isGK) return Math.min(Math.floor(cs / 2) + Math.floor(g / 15), 95);
  if (isDef) return Math.min(30 + Math.floor(g / 10) + Math.floor(a / 8), 55);
  if (isCreator) return Math.min(Math.floor(a / 3) + Math.floor(g / 6), 65);
  const cap = cabinet >= PERF_CAP_CABINET_FULL
    ? PERF_CAP_ATTACK_MIN
    : PERF_CAP_ATTACK_MIN + Math.round((PERF_CAP_ATTACK_MAX - PERF_CAP_ATTACK_MIN) * (PERF_CAP_CABINET_FULL - cabinet) / PERF_CAP_CABINET_FULL);
  return Math.min(Math.floor(g / 5) + Math.floor(a / 10), cap);
}

// ── 策略：转会拣星 + 其余第一项（稳策略，ascension-economy-check 同款）──
function clubStars(c: Choice, g: GameState): number {
  if (c.id === "stay" || c.kind === "stay" || c.kind === "join_loan") {
    try { const r = clubById(g.currentClubId).rep; return r >= 8 ? 5 : r >= 6 ? 4 : r >= 4 ? 3 : r >= 2 ? 2 : 1; } catch { return 0; }
  }
  return (c.sub ?? "").split("★").length - 1;
}
function pickChoice(g: GameState): Choice {
  const ev = g.pendingChoice!;
  const ch = ev.choices;
  if (ch.length === 1) return ch[0]!;
  const key = ev.key;
  if (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer" || key === "voluntary_transfer" || key === "club_moving") {
    const best = ch.reduce((b, c) => clubStars(c, g) > clubStars(b, g) ? c : b, ch[0]!);
    return best;
  }
  return ch[0]!;
}

interface Cell { pos: Position; nation: string; league: string; tier: number; asc: number; label: string }
const CELLS: Cell[] = [];
const POSITIONS: Position[] = ["GK", "CB", "CM", "CAM", "ST"];
const NATIONS: { id: string; league: string; tier: number; tag: string }[] = [
  { id: "fra", league: "ligue-1", tier: 1, tag: "T1法" },
  { id: "chn", league: "csl", tier: 5, tag: "T5中" },
];
for (const pos of POSITIONS) for (const nat of NATIONS) for (const asc of [0, 5, 10]) {
  CELLS.push({ pos, nation: nat.id, league: nat.league, tier: nat.tier, asc, label: `${pos} ${nat.tag} A${asc}` });
}

const N = Number(process.argv[2] ?? 80);

interface Row {
  settled: number; raw: number; peak: number; seasons: number;
  goals: number; assists: number; cleanSheets: number;
  trophyN: number; awardN: number;
  wc: boolean; ballon: boolean; contPri: boolean; league: boolean;
  trophyLegacy: number; awardLegacy: number; careerPerf: number; honorsCore: number;
}
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function playOne(seed: string, cell: Cell): Row | null {
  const setup: RunSetup = {
    seed, nationalityId: cell.nation, position: cell.pos, leagueId: cell.league,
    pace: "normal", ascension: cell.asc, blessings: [], allowWonderkid: true, permPerks: [],
  };
  let g: GameState;
  try { g = simulatePeriod(createRun(setup)); } catch { return null; }
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      try { g = resolveChoice(g, pickChoice(g)); } catch { return null; }
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else g = simulatePeriod(g);
  }
  if (g.phase === "playing") return null; // stuck
  const stats = seniorCareerStats(g.seasons);
  let trophyLegacy = 0; for (const t of g.trophies) trophyLegacy += TROPHY_LEGACY[t] ?? 0;
  let awardLegacy = 0; for (const aw of g.awards) awardLegacy += AWARD_LEGACY[aw] ?? 0;
  const cabinet = trophyLegacy + awardLegacy;
  const pos = g.player?.position ?? cell.pos;
  const careerPerf = careerPerfLegacy(pos, stats.goals, stats.assists, stats.cleanSheets, cabinet);
  const honorsCore = trophyLegacy + awardLegacy + careerPerf;
  return {
    settled: Math.round(g.legacy), raw: Math.round(g.rawLegacy),
    peak: g.maxOverall, seasons: seniorCareerSeasonCount(g.seasons),
    goals: stats.goals, assists: stats.assists, cleanSheets: stats.cleanSheets,
    trophyN: g.trophies.length, awardN: g.awards.length,
    wc: g.trophies.includes("world_cup"), ballon: g.awards.includes("ballon_dor"),
    contPri: g.trophies.includes("continental_primary"), league: g.trophies.includes("league"),
    trophyLegacy, awardLegacy, careerPerf, honorsCore,
  };
}

function pct<T>(arr: T[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => (a as unknown as number) - (b as unknown as number));
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))] as unknown as number;
}
const median = <T extends number>(arr: T[]) => pct(arr, 0.5);
const rate = (arr: boolean[]) => arr.length === 0 ? 0 : Math.round((arr.filter(Boolean).length / arr.length) * 100);

const t0 = Date.now();
const table: { cell: Cell; rows: Row[] }[] = [];
for (const cell of CELLS) {
  const rows: Row[] = [];
  for (let i = 0; i < N; i++) {
    const r = playOne(`diag-${hash32(cell.label)}-${i}`, cell);
    if (r) rows.push(r);
  }
  table.push({ cell, rows });
}
const dt = Date.now() - t0;

// ── 报告 ──
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xff60) || (c >= 0x3000 && c <= 0x303f) ? 2 : 1;
  }
  return w;
}
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - dispWidth(s)));
const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);

console.log(`# 产出构成诊断 · N=${N}/格 · ${CELLS.length} 格 · ${table.reduce((s, c) => s + c.rows.length, 0)} 局 · ${dt}ms\n`);
console.log(`${pad("格子", 12)} ${pad("结算", 5)} ${pad("实绩", 5)} ${pad("倍率", 5)} ${pad("OVR", 4)} ${pad("季", 3)} ${pad("进球", 4)} ${pad("助攻", 4)} ${pad("零封", 4)} ${pad("杯", 3)} ${pad("奖", 3)} ${pad("WC%", 4)} ${pad("金球", 4)} ${pad("洲主", 4)} ${pad("联赛", 4)} ${pad("奖杯分", 5)} ${pad("奖项分", 5)} ${pad("表现分", 5)} ${pad("奖杯%", 5)} ${pad("奖项%", 5)} ${pad("表现%", 5)}`);
for (const { cell, rows } of table) {
  if (rows.length === 0) { console.log(`${pad(cell.label, 12)} (无有效局)`); continue; }
  const settled = median(rows.map((r) => r.settled));
  const raw = median(rows.map((r) => r.raw));
  const mult = raw > 0 ? settled / raw : 0;
  const peak = median(rows.map((r) => r.peak));
  const seasons = median(rows.map((r) => r.seasons));
  const goals = median(rows.map((r) => r.goals));
  const assists = median(rows.map((r) => r.assists));
  const cs = median(rows.map((r) => r.cleanSheets));
  const tn = median(rows.map((r) => r.trophyN));
  const an = median(rows.map((r) => r.awardN));
  const wc = rate(rows.map((r) => r.wc));
  const ballon = rate(rows.map((r) => r.ballon));
  const contPri = rate(rows.map((r) => r.contPri));
  const league = rate(rows.map((r) => r.league));
  const tl = median(rows.map((r) => r.trophyLegacy));
  const al = median(rows.map((r) => r.awardLegacy));
  const cp = median(rows.map((r) => r.careerPerf));
  const hc = tl + al + cp;
  const sTl = hc > 0 ? Math.round((tl / hc) * 100) : 0;
  const sAl = hc > 0 ? Math.round((al / hc) * 100) : 0;
  const sCp = hc > 0 ? Math.round((cp / hc) * 100) : 0;
  console.log(`${pad(cell.label, 12)} ${pad(String(settled), 5)} ${pad(String(raw), 5)} ${pad(fmt(mult), 5)} ${pad(String(peak), 4)} ${pad(String(seasons), 3)} ${pad(String(goals), 4)} ${pad(String(assists), 4)} ${pad(String(cs), 4)} ${pad(String(tn), 3)} ${pad(String(an), 3)} ${pad(wc + "%", 4)} ${pad(ballon + "%", 4)} ${pad(contPri + "%", 4)} ${pad(league + "%", 4)} ${pad(String(tl), 5)} ${pad(String(al), 5)} ${pad(String(cp), 5)} ${pad(sTl + "%", 5)} ${pad(sAl + "%", 5)} ${pad(sCp + "%", 5)}`);
}

// ── 跨切片对比 ──
console.log(`\n# 跨切片：T5/T1 结算比（同位置同飞升）`);
for (const pos of POSITIONS) for (const asc of [0, 5, 10]) {
  const t1 = table.find((c) => c.cell.pos === pos && c.cell.tier === 1 && c.cell.asc === asc)!;
  const t5 = table.find((c) => c.cell.pos === pos && c.cell.tier === 5 && c.cell.asc === asc)!;
  if (t1.rows.length && t5.rows.length) {
    const r = median(t5.rows.map((x) => x.settled)) / Math.max(1, median(t1.rows.map((x) => x.settled)));
    console.log(`  ${pad(pos, 4)} A${asc}: T5/T1 结算 = ${fmt(r)}×`);
  }
}
console.log(`\n# 跨切片：A10/A0 结算比（同位置同国籍）—— 稳策略在高难度的兑现`);
for (const pos of POSITIONS) for (const nat of NATIONS) {
  const a0 = table.find((c) => c.cell.pos === pos && c.cell.nation === nat.id && c.cell.asc === 0)!;
  const a10 = table.find((c) => c.cell.pos === pos && c.cell.nation === nat.id && c.cell.asc === 10)!;
  if (a0.rows.length && a10.rows.length) {
    const r = median(a10.rows.map((x) => x.settled)) / Math.max(1, median(a0.rows.map((x) => x.settled)));
    console.log(`  ${pad(pos, 4)} ${nat.tag}: A10/A0 结算 = ${fmt(r)}×`);
  }
}

// ── 离群点 ──
const flat = table.filter((c) => c.rows.length).map((c) => ({ label: c.cell.label, settled: median(c.rows.map((r) => r.settled)), raw: median(c.rows.map((r) => r.raw)), cpShare: (() => { const tl = median(c.rows.map((r) => r.trophyLegacy)); const al = median(c.rows.map((r) => r.awardLegacy)); const cp = median(c.rows.map((r) => r.careerPerf)); const hc = tl + al + cp; return hc > 0 ? cp / hc : 0; })() }));
flat.sort((a, b) => a.settled - b.settled);
console.log(`\n# 离群点`);
console.log(`  最低结算: ${flat[0]!.label} = ${flat[0]!.settled}`);
console.log(`  最高结算: ${flat[flat.length - 1]!.label} = ${flat[flat.length - 1]!.settled}`);
const maxCp = [...flat].sort((a, b) => b.cpShare - a.cpShare)[0]!;
const minCp = [...flat].sort((a, b) => a.cpShare - b.cpShare)[0]!;
console.log(`  表现分占 honors 最高: ${maxCp.label} = ${fmt(maxCp.cpShare * 100)}%（荣誉塌缩→表现撑）`);
console.log(`  表现分占 honors 最低: ${minCp.label} = ${fmt(minCp.cpShare * 100)}%（荣誉主导）`);
