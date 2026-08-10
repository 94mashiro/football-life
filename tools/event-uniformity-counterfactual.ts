/**
 * 事件均匀性对照探针（event-uniformity-probe worktree only — not for master）。
 *
 * 回答用户的问题：「剩下的 100+ 特殊事件触发概率要尽可能严格一致」。
 *
 * 诊断（已成立）：池事件出现率受两个独立轴驱动——
 *   轴1 weight (3→100)：高权重事件霸场 (rags_to_riches 100→51%, injury 100→48%)
 *   轴2 资格门宽度：权重仅 4 的事件靠"几乎全生涯够格"霸场
 *        (training_extra 4→27%, mysterious_substance 4→25%, position_change 4→22%)
 * 所以「只拉平权重」不够——拉平后高权重劫持者下降，但门宽劫持者反而上升。
 *
 * 真正的解 = 门宽补偿：w_E ∝ 1/n_E（n_E = 事件 E 每生涯平均够格的期数），
 * 使每个事件的「期望出现次数」≈ n_E × (1/n_E)/Σ ≈ 常数，与门宽无关。
 *
 * 本探针跑 4 个 pass 对照（N=40000 生涯/8 配置）：
 *   pass0 collect : 采集 n_E（story 通道够格期数）
 *   pass1 current  : 现状（原 weight）
 *   pass2 uniform  : 非转会事件权重全设 1（只动轴1）
 *   pass3 compens  : 非转会事件权重 = 1/(n_E + k)（动轴1+轴2，k 软化极端）
 * 输出每个 pass 的 中位/均值/标准差/CV + 头部 + 尾部 + 死事件。
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { EVENT_DEFS, POOL_CLUB_MOVE_KEYS, setPoolProbeHooks } from "../src/engine/events";
import { randomSeed } from "../src/meta/legacy";
import type { GameState, Choice, } from "../src/engine/types";
import type { Position } from "../src/engine/data";

const CONTEXTUAL_IN_POOL = new Set([
  "relegation_loyalty", "throne_challenge", "contract_nonrenewal",
  "underperform_release", "stuck_release", "naturalization_offer",
  "club_national_team_conflict",
]);
const POOL_KEYS = new Set(EVENT_DEFS.map((d) => d.key).filter((k) => !CONTEXTUAL_IN_POOL.has(k)));
// 非转会池事件 = 用户说的「100+ 特殊事件」（排除 3 个转会类路由）
const NON_CLUB_POOL = new Set([...POOL_KEYS].filter((k) => !POOL_CLUB_MOVE_KEYS.has(k)));

const SETUPS: { pos: Position; league: string; nation: string }[] = [
  { pos: "ST",  league: "brasileirao",    nation: "bra" },
  { pos: "GK",  league: "premier-league", nation: "eng" },
  { pos: "CM",  league: "laliga",         nation: "esp" },
  { pos: "CB",  league: "serie-a",        nation: "cro" },
  { pos: "ST",  league: "csl",            nation: "chn" },
  { pos: "LW",  league: "ligue-1",        nation: "sen" },
  { pos: "RW",  league: "eredivisie",    nation: "ned" },
  { pos: "CDM", league: "bundesliga",     nation: "ger" },
];

let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const PER_SETUP = Number(process.argv[2] ?? 5000);
const N = PER_SETUP * SETUPS.length;

// n_E 采集：每生涯每期 story 通道够格的事件集合
const eligibleCount: Record<string, number> = {}; // key → 累计够格期数
let collectorCareers = 0;

function runPass(override: Record<string, number> | null, collector: ((keys: readonly string[], age: number, storyOnly: boolean) => void) | null = null): { fires: Record<string, number>; touched: Record<string, number>; total: number } {
  setPoolProbeHooks(override, collector);
  const fires: Record<string, number> = {};
  const touched: Record<string, number> = {};
  let total = 0;
  for (let si = 0; si < SETUPS.length; si++) {
    const setup = SETUPS[si]!;
    for (let i = 0; i < PER_SETUP; i++) {
      const seed = randomSeed();
      _s = 0x9e3779b9 ^ hash32(seed) ^ (si * 2654435761);
      const runSetup: RunSetup = { seed, nationalityId: setup.nation, position: setup.pos, leagueId: setup.league, blessings: [], ascension: 0, pace: "normal" };
      let g: GameState = simulatePeriod(createRun(runSetup));
      const seen = new Set<string>();
      let guard = 0;
      while (g.phase === "playing" && guard++ < 400) {
        if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
        if (g.pendingChoice) {
          const ch = g.pendingChoice.choices;
          const key = g.pendingChoice.key;
          fires[key] = (fires[key] ?? 0) + 1;
          total++;
          if (!seen.has(key)) { seen.add(key); touched[key] = (touched[key] ?? 0) + 1; }
          const pick: Choice = ch.length > 1 ? ch[rint(0, ch.length - 1)]! : ch[0]!;
          g = resolveChoice(g, pick);
          if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
        } else {
          g = simulatePeriod(g);
        }
      }
    }
  }
  return { fires, touched, total };
}

// pass0: collect n_E（跑一遍生涯，collector 累计）
runPass(null, (keys, _age, storyOnly) => {
  if (!storyOnly) return; // 只数 story 通道（非转会事件的主抽）
  for (const k of keys) eligibleCount[k] = (eligibleCount[k] ?? 0) + 1;
});
collectorCareers = N;
setPoolProbeHooks(null, null);
const nE: Record<string, number> = {};
for (const k of Object.keys(eligibleCount)) nE[k] = eligibleCount[k]! / collectorCareers;

// 构造三个 override
const uniformOverride: Record<string, number> = {};
for (const k of NON_CLUB_POOL) uniformOverride[k] = 1;

// 补偿：w = 1/(n_E + k)。k 软化极端。测多个 k 看权衡曲线。
const nEs = Object.values(nE).filter((v) => v > 0).sort((a, b) => a - b);
const kMed = nEs[Math.floor(nEs.length / 2)] ?? 1;
function compensFor(k: number): Record<string, number> {
  const o: Record<string, number> = {};
  for (const key of NON_CLUB_POOL) {
    const n = nE[key] ?? 0;
    o[key] = n > 0 ? 1 / (n + k) : 1;
  }
  return o;
}
const compensK0 = compensFor(0);       // 纯补偿，不软化（窄门事件权重极大）
const compensK02 = compensFor(0.2);   // 轻软化
const compensKMed = compensFor(kMed);  // 中位数软化（原 pass3）

// 跑对照 pass
const passCur = runPass(null);
const passUni = runPass(uniformOverride);
const passC0 = runPass(compensK0);
const passC02 = runPass(compensK02);
const passCMed = runPass(compensKMed);
setPoolProbeHooks(null, null);

// 统计辅助：只看非转会池事件（用户的 100+ 特殊事件）
function stats(pass: ReturnType<typeof runPass>) {
  const rows = [...NON_CLUB_POOL].map((k) => ({ key: k, pct: (pass.touched[k] ?? 0) / N * 100, fires: pass.fires[k] ?? 0 }));
  const fired = rows.filter((r) => r.fires > 0).map((r) => r.pct).sort((a, b) => a - b);
  const n = fired.length;
  const mean = fired.reduce((s, v) => s + v, 0) / (n || 1);
  const med = n ? fired[Math.floor(n / 2)]! : 0;
  const sd = Math.sqrt(fired.reduce((s, v) => s + (v - mean) ** 2, 0) / (n || 1));
  const cv = mean > 0 ? sd / mean : 0;
  const dead = rows.filter((r) => r.fires === 0).length;
  const max = fired.length ? fired[fired.length - 1]! : 0;
  const min = fired.length ? fired[0]! : 0;
  return { n, mean, med, sd, cv, dead, max, min, rows };
}

const sCur = stats(passCur);
const sUni = stats(passUni);
const sC0 = stats(passC0);
const sC02 = stats(passC02);
const sCMed = stats(passCMed);

function show(label: string, s: ReturnType<typeof stats>) {
  console.log(`\n【${label}】 非转会池事件 ${NON_CLUB_POOL.size} 个 · 出现过 ${s.n}`);
  console.log(`  出现率: 中位 ${s.med.toFixed(2)}% · 均值 ${s.mean.toFixed(2)}% · 标准差 ${s.sd.toFixed(2)} · CV=${s.cv.toFixed(2)} · 区间 ${s.min.toFixed(2)}%–${s.max.toFixed(1)}% · 死事件 ${s.dead}`);
}
console.log(`N=${N} 生涯/对照 · kMed(补偿软化)=${kMed.toFixed(2)} (= n_E 中位数)`);
console.log(`非转会池事件 ${NON_CLUB_POOL.size} 个（用户「100+ 特殊事件」）`);
show("pass1 现状 原weight", sCur);
show("pass2 拉平 weight=1（只动轴1）", sUni);
show(`pass3a 门宽补偿 k=0（纯 1/n_E）`, sC0);
show(`pass3b 门宽补偿 k=0.2`, sC02);
show(`pass3c 门宽补偿 k=${kMed.toFixed(2)}（中位数软化）`, sCMed);

// CV 权衡曲线
console.log(`\n=== CV / 区间 随补偿激进度 ===`);
console.log(`  现状          CV=${sCur.cv.toFixed(2)}  区间 ${sCur.min.toFixed(2)}%–${sCur.max.toFixed(1)}%`);
console.log(`  拉平 w=1      CV=${sUni.cv.toFixed(2)}  区间 ${sUni.min.toFixed(2)}%–${sUni.max.toFixed(1)}%`);
console.log(`  补偿 k=0      CV=${sC0.cv.toFixed(2)}  区间 ${sC0.min.toFixed(2)}%–${sC0.max.toFixed(1)}%`);
console.log(`  补偿 k=0.2    CV=${sC02.cv.toFixed(2)}  区间 ${sC02.min.toFixed(2)}%–${sC02.max.toFixed(1)}%`);
console.log(`  补偿 k=${kMed.toFixed(2)}  CV=${sCMed.cv.toFixed(2)}  区间 ${sCMed.min.toFixed(2)}%–${sCMed.max.toFixed(1)}%`);

// 头部对照（出现率前 12）
function top(s: ReturnType<typeof stats>, n = 12) {
  return s.rows.slice().sort((a, b) => b.pct - a.pct).slice(0, n);
}
console.log(`\n=== 头部 12（出现率最高）对照 ===`);
console.log(`  ${"key".padEnd(24)} ${"现状".padStart(7)} ${"拉平".padStart(7)} ${"k=0".padStart(7)} ${"k=.2".padStart(7)} ${"kMed".padStart(7)}   n_E`);
const tCur = new Map(sCur.rows.map((r) => [r.key, r.pct]));
const tUni = new Map(sUni.rows.map((r) => [r.key, r.pct]));
const tC0 = new Map(sC0.rows.map((r) => [r.key, r.pct]));
const tC02 = new Map(sC02.rows.map((r) => [r.key, r.pct]));
const tCMed = new Map(sCMed.rows.map((r) => [r.key, r.pct]));
const allTop = new Set([...top(sCur, 12).map((r) => r.key), ...top(sUni, 12).map((r) => r.key), ...top(sC0, 12).map((r) => r.key), ...top(sC02, 12).map((r) => r.key), ...top(sCMed, 12).map((r) => r.key)]);
const topSorted = [...allTop].map((k) => ({ k, cur: tCur.get(k) ?? 0, uni: tUni.get(k) ?? 0, c0: tC0.get(k) ?? 0, c02: tC02.get(k) ?? 0, cmed: tCMed.get(k) ?? 0, n: nE[k] ?? 0 })).sort((a, b) => b.cur - a.cur || b.c0 - a.c0);
for (const r of topSorted.slice(0, 16)) {
  console.log(`  ${r.k.padEnd(24)} ${r.cur.toFixed(1).padStart(6)}% ${r.uni.toFixed(1).padStart(6)}% ${r.c0.toFixed(1).padStart(6)}% ${r.c02.toFixed(1).padStart(6)}% ${r.cmed.toFixed(1).padStart(6)}%   ${r.n.toFixed(1)}`);
}

// 尾部对照（出现率最低 12，含死事件）
console.log(`\n=== 尾部 14（出现率最低 / 死）对照 ===`);
console.log(`  ${"key".padEnd(24)} ${"现状".padStart(7)} ${"拉平".padStart(7)} ${"k=0".padStart(7)} ${"k=.2".padStart(7)} ${"kMed".padStart(7)}   n_E`);
const botSorted = [...NON_CLUB_POOL].map((k) => ({ k, cur: tCur.get(k) ?? 0, uni: tUni.get(k) ?? 0, c0: tC0.get(k) ?? 0, c02: tC02.get(k) ?? 0, cmed: tCMed.get(k) ?? 0, n: nE[k] ?? 0 })).sort((a, b) => a.cur - b.cur || a.c0 - b.c0);
for (const r of botSorted.slice(0, 16)) {
  console.log(`  ${r.k.padEnd(24)} ${r.cur.toFixed(2).padStart(6)}% ${r.uni.toFixed(2).padStart(6)}% ${r.c0.toFixed(2).padStart(6)}% ${r.c02.toFixed(2).padStart(6)}% ${r.cmed.toFixed(2).padStart(6)}%   ${r.n.toFixed(2)}`);
}

// 直方图对照
const B: readonly (readonly [number, number, string])[] = [[20, 1e9, "≥20%"], [10, 20, "10–20%"], [6, 10, "6–10%"], [3, 6, "3–6%"], [1.5, 3, "1.5–3%"], [0.5, 1.5, "0.5–1.5%"], [0.1, 0.5, "0.1–0.5%"], [0.0001, 0.1, ">0~<0.1%"], [-1, 0, "=0 死"]];
console.log(`\n=== 出现率直方图对照（非转会池事件 ${NON_CLUB_POOL.size}）===`);
console.log(`  ${"区间".padStart(10)}  ${"现状".padStart(4)} ${"拉平".padStart(4)} ${"k=0".padStart(4)} ${"k=.2".padStart(4)} ${"kMed".padStart(4)}`);
for (const [lo, hi, label] of B) {
  const c = sCur.rows.filter((r) => r.pct > lo && r.pct <= hi).length;
  const u = sUni.rows.filter((r) => r.pct > lo && r.pct <= hi).length;
  const a = sC0.rows.filter((r) => r.pct > lo && r.pct <= hi).length;
  const b2 = sC02.rows.filter((r) => r.pct > lo && r.pct <= hi).length;
  const m = sCMed.rows.filter((r) => r.pct > lo && r.pct <= hi).length;
  console.log(`  ${label.padStart(10)} : ${String(c).padStart(3)}  ${String(u).padStart(3)}  ${String(a).padStart(3)}  ${String(b2).padStart(3)}  ${String(m).padStart(3)}`);
}

// n_E 分布（诊断用）
console.log(`\n=== n_E 分布（每生涯平均够格期数，story 通道）===`);
const nBuckets: readonly (readonly [number, number, string])[] = [[0, 0, "=0(从不够格/仅转会槽)"], [0.001, 1, "0–1"], [1, 3, "1–3"], [3, 6, "3–6"], [6, 10, "6–10"], [10, 15, "10–15"], [15, 1e9, "≥15"]];
for (const [lo, hi, label] of nBuckets) {
  const c = [...NON_CLUB_POOL].filter((k) => (nE[k] ?? 0) > lo && (nE[k] ?? 0) <= hi).length;
  console.log(`  ${label.padStart(20)} : ${String(c).padStart(3)}`);
}
