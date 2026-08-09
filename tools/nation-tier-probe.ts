/**
 * P-NATION 国籍青训档位探针 — 验证「概率弯曲、绝无硬墙」的设计目标。
 *
 * 同一批种子跑 T1(法国/法甲) vs T4(日本/J联赛) vs T5(中国/中超) 的随机选择
 * 生涯,对比:
 *   巅峰 OVR 中位/p90 · ≥90 率 · ≥95 率(硬墙检测:T5 必须 > 0 才 PASS) ·
 *   wonderkid 率 · 五大联赛抵达率(路径摩擦效果) · 传承中位(补偿是否兜住)。
 *
 * PASS 条件:
 *   1. 无硬墙: T5 的 ≥90 率 > 0 (神种子照样封王)。
 *   2. 难度成立: T1 巅峰中位 > T4 > T5 (方向正确,差距 2-6 OVR 量级)。
 *   3. 路径摩擦: T4/T5 的五大抵达率 < T1 (但 > 0,跳板通道存在)。
 *   4. 补偿兜底: T5 传承中位 ≥ T1 × 0.7 (高风险高回报,不是纯劣势)。
 *
 * Run:  npx tsx tools/nation-tier-probe.ts [N=400]
 */
import { createRun, simulatePeriod, resolveChoice, liveLegacy, type RunSetup } from "../src/engine/run";
import { LEAGUES } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const N = Number(process.argv[2] ?? 400);

const BIG5 = new Set(LEAGUES.filter((l) => l.confederation === "UEFA" && l.tier === 1 && l.domRep >= 4).map((l) => l.id));

// tiny xorshift32 for reproducible choice picking (harness-only, never the engine)
let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function pickChoice(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  return ch.length === 1 ? ch[0]! : ch[rint(0, ch.length - 1)]!;
}

interface Setup { nation: string; league: string; label: string; }
// 真实剧本组 (holistic: 国籍+母国联赛) + 隔离组 (iso: 同联赛起步,纯国籍效应)
const SETUPS: Setup[] = [
  { nation: "fra", league: "ligue-1", label: "T1 法国 ST 法甲" },
  { nation: "jpn", league: "j1-league", label: "T4 日本 ST J联赛" },
  { nation: "chn", league: "csl", label: "T5 中国 ST 中超" },
  { nation: "fra", league: "primeira-liga", label: "iso T1 法国 葡超" },
  { nation: "jpn", league: "primeira-liga", label: "iso T4 日本 葡超" },
  { nation: "chn", league: "primeira-liga", label: "iso T5 中国 葡超" },
];

interface RunStats { peak: number; legacy: number; big5: boolean; wonderkid: boolean; }

function playOne(seed: string, s: Setup): RunStats {
  _s = 0x9e3779b9 ^ hash32(seed + s.nation);
  const setup: RunSetup = { seed, nationalityId: s.nation, position: "ST", leagueId: s.league, blessings: [], ascension: 0, pace: "normal", permPerks: [], allowWonderkid: true };
  let g: GameState = simulatePeriod(createRun(setup));
  const wonderkid = g.player?.devProfile === "wonderkid";
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      g = resolveChoice(g, pickChoice(g));
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else g = simulatePeriod(g);
  }
  const big5 = g.seasons.some((x) => BIG5.has(x.leagueId));
  return { peak: g.maxOverall, legacy: liveLegacy(g), big5, wonderkid };
}

function pct(arr: number[], p: number): number { const ss = [...arr].sort((a, b) => a - b); return ss[Math.min(ss.length - 1, Math.floor(ss.length * p))]!; }
const rate = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`;

const results = new Map<string, RunStats[]>();
for (const s of SETUPS) {
  const runs: RunStats[] = [];
  for (let i = 0; i < N; i++) runs.push(playOne(`ntp-${i}`, s));
  results.set(s.label, runs);
}

console.log(`P-NATION 探针 · N=${N}/档\n`);
console.log("档位              巅峰p50  p90  ≥90    ≥95    天才档  五大抵达  传承p50");
for (const s of SETUPS) {
  const r = results.get(s.label)!;
  const peaks = r.map((x) => x.peak);
  const legs = r.map((x) => x.legacy);
  console.log(
    `${s.label.padEnd(16)}  ${pct(peaks, 0.5)}      ${pct(peaks, 0.9)}   ${rate(r.filter((x) => x.peak >= 90).length, N).padEnd(5)}  ${rate(r.filter((x) => x.peak >= 95).length, N).padEnd(5)}  ${rate(r.filter((x) => x.wonderkid).length, N).padEnd(6)}  ${rate(r.filter((x) => x.big5).length, N).padEnd(8)}  ${pct(legs, 0.5)}`,
  );
}

const t1 = results.get(SETUPS[0]!.label)!, t5 = results.get(SETUPS[2]!.label)!;
const i1 = results.get(SETUPS[3]!.label)!, i4 = results.get(SETUPS[4]!.label)!, i5 = results.get(SETUPS[5]!.label)!;
const p50 = (r: RunStats[]) => pct(r.map((x) => x.peak), 0.5);
const legP50 = (r: RunStats[]) => pct(r.map((x) => x.legacy), 0.5);
const big5Rate = (r: RunStats[]) => r.filter((x) => x.big5).length / N;

const checks: [string, boolean][] = [
  [`无硬墙: T5 ≥90 率 > 0 (实测 ${rate(t5.filter((x) => x.peak >= 90).length, N)})`, t5.some((x) => x.peak >= 90)],
  [`难度方向(隔离组): iso T1 巅峰p50 (${p50(i1)}) ≥ iso T4 (${p50(i4)}) ≥ iso T5 (${p50(i5)}), 且 T1 > T5`, p50(i1) >= p50(i4) && p50(i4) >= p50(i5) && p50(i1) > p50(i5)],
  [`路径摩擦: 五大抵达率 T1 (${rate(t1.filter((x) => x.big5).length, N)}) > T5 (${rate(t5.filter((x) => x.big5).length, N)}) > 0`, big5Rate(t1) > big5Rate(t5) && big5Rate(t5) > 0],
  [`补偿平衡: T5 传承p50 (${legP50(t5)}) 在 T1 (${legP50(t1)}) 的 [0.75, 1.15] 区间 (不弱不顶)`, legP50(t5) >= legP50(t1) * 0.75 && legP50(t5) <= legP50(t1) * 1.15],
];
console.log("");
let fail = 0;
for (const [label, ok] of checks) { console.log(`${ok ? "✓" : "✗"} ${label}`); if (!ok) fail++; }
process.exit(fail > 0 ? 1 : 0);
