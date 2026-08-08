/**
 * 难度曲线冒烟测试 — 生涯 OVR 曲线的「调参指南针」。
 *
 * 跑 N 局完整生涯（headless），对巅峰 OVR 分布 + 生涯形态做 PASS/FAIL 断言。
 * 每条门槛打印「目标 vs 实测 vs ✓/✗」，任一不过则 exit 1 —— 改一个数值、重跑，
 * 看门槛从 ✗ 逐条翻成 ✓，让背后的数值调整变得可控。
 *
 * 两个干净 A/B 档（同一份随机选择策略，只差祝福，隔离祝福净效果）：
 *   baseline : 无祝福、飞升 0、随机未引导选择 —— 「什么祝福都不升」的新手。
 *   blessed  : 金童 + 神射手 + 大赛型选手、飞升 0、allowWonderkid —— 攒齐顶级祝福的玩家。
 *
 * 目标曲线（用户口述，编辑下方 TARGET 即可重定指南针）：
 *   baseline 中位巅峰 83–85 · ≥95 在 10–20%（好事件冲到 95–99 的「涌现」）·
 *   <70 ≤ 8%（不压抑积极性）· p10 ≥ 76 · 生涯 16–24 季 · 世界杯 4–20%。
 *   blessed 中位巅峰 ≥ 86 · ≥95 ≥ 18% · ≥90 ≥ 25% · <70 ≤ 3% · 传承 ≥ baseline×1.15。
 *   invariant：blessed 中位巅峰 ≥ baseline 中位巅峰（祝福绝不能帮倒忙）。
 *
 * Run:  npx tsx tools/difficulty-smoke.ts [N=400]
 *
 * 说明：门槛作用在 3 个代表性 setup 的「聚合」分布上（整盘曲线），下方附
 * 每 setup 明细。聚合门槛衡量「整盘难度曲线是否健康」，单 setup 明细显示
 * 哪条路线偏薄。改引擎数值后重跑，门槛逐条转绿即达标。
 */
import { createRun, simulatePeriod, resolveChoice, liveLegacy, type RunSetup } from "../src/engine/run";
import type { GameState, Choice } from "../src/engine/types";

// ───────────────────────────── target spec (the compass — edit to retune) ─────────────────────────────
//
// 两组门槛 + 一组不变量。baseline 是用户口述的「舒适 + 涌现」曲线；blessed
// 是「有祝福更轻松」的上界。数值改这里即可，无需动下面逻辑。
interface Gate {
  id: string;
  profile: "baseline" | "blessed" | "invariant";
  kind: "target" | "invariant";
  metric: string;        // 显示用
  target: string;        // 显示用（人读）
  /** 返回 [measured, passed]。invariant 门的两个 profile 都已跑完，结果在 ctx 里取。 */
  check: (ctx: Results) => [number, boolean];
}

const TARGET: Gate[] = [
  // ── baseline: 舒适 + 涌现曲线 ──
  { id: "base.median", profile: "baseline", kind: "target", metric: "中位巅峰 OVR", target: "83 ≤ m ≤ 85",
    check: (c) => { const m = median(c.base.peaks); return [m, m >= 83 && m <= 85]; } },
  { id: "base.surge95", profile: "baseline", kind: "target", metric: "≥95 巅峰占比", target: "10%–20%",
    check: (c) => { const p = rate(c.base.peaks, 95); return [p, p >= 10 && p <= 20]; } },
  { id: "base.stall", profile: "baseline", kind: "target", metric: "<70 巅峰占比", target: "≤ 8%",
    check: (c) => { const p = rate(c.base.peaks, 69, true); return [p, p <= 8]; } },
  { id: "base.floor", profile: "baseline", kind: "target", metric: "p10 巅峰 OVR", target: "≥ 76",
    check: (c) => { const p = pct(c.base.peaks, 0.10); return [p, p >= 76]; } },
  { id: "base.seasons", profile: "baseline", kind: "target", metric: "中位生涯赛季数", target: "16 ≤ s ≤ 24",
    check: (c) => { const m = median(c.base.seasons); return [m, m >= 16 && m <= 24]; } },
  { id: "base.wc", profile: "baseline", kind: "target", metric: "世界杯生涯夺冠率", target: "4%–20%",
    check: (c) => { const p = c.base.wcWon; return [p, p >= 4 && p <= 20]; } },

  // ── blessed: 有祝福更轻松（严格优于 baseline 的上界）──
  { id: "bless.median", profile: "blessed", kind: "target", metric: "中位巅峰 OVR", target: "≥ 86",
    check: (c) => { const m = median(c.bless.peaks); return [m, m >= 86]; } },
  { id: "bless.surge95", profile: "blessed", kind: "target", metric: "≥95 巅峰占比", target: "≥ 18%",
    check: (c) => { const p = rate(c.bless.peaks, 95); return [p, p >= 18]; } },
  { id: "bless.elite90", profile: "blessed", kind: "target", metric: "≥90 巅峰占比", target: "≥ 25%",
    check: (c) => { const p = rate(c.bless.peaks, 90); return [p, p >= 25]; } },
  { id: "bless.stall", profile: "blessed", kind: "target", metric: "<70 巅峰占比", target: "≤ 3%",
    check: (c) => { const p = rate(c.bless.peaks, 69, true); return [p, p <= 3]; } },
  { id: "bless.legacy", profile: "blessed", kind: "target", metric: "中位传承 / baseline 中位", target: "≥ 1.15×",
    check: (c) => { const r = median(c.bless.legacy) / Math.max(1, median(c.base.legacy)); return [r, r >= 1.15]; } },

  // ── invariant: 必须恒成立的回归护栏（祝福绝不能帮倒忙）──
  { id: "inv.blessNoWorse", profile: "invariant", kind: "invariant", metric: "blessed 中位巅峰 vs baseline", target: "≥",
    check: (c) => { const r = median(c.bless.peaks) - median(c.base.peaks); return [r, r >= 0]; } },
  { id: "inv.noCrash", profile: "invariant", kind: "invariant", metric: "两档零崩溃生涯", target: "= 0",
    check: (c) => { const n = c.base.crashed + c.bless.crashed; return [n, n === 0]; } },
  { id: "inv.shortCareer", profile: "invariant", kind: "invariant", metric: "baseline <10 赛季占比", target: "≤ 5%",
    check: (c) => { const p = rateThr(c.base.seasons, 10, true); return [p, p <= 5]; } },
];

// ───────────────────────────── run profiles ─────────────────────────────
const N = Number(process.argv[2] ?? 400);
const BLESSED_LOADOUT = ["golden_boy", "sharpshooter", "big_game_player"];

interface Setup { nation: string; pos: RunSetup["position"]; league: string; pace: RunSetup["pace"]; label: string }
const SETUPS: Setup[] = [
  { nation: "bra", pos: "ST", league: "premier-league", pace: "normal", label: "BRA ST 英超" },
  { nation: "eng", pos: "CM", league: "premier-league", pace: "normal", label: "ENG CM 英超" },
  { nation: "chn", pos: "ST", league: "china-league-one", pace: "long", label: "CHN ST 中甲" },
];

// harness-only xorshift32 (never the engine) — reseeded per run from the seed
// so the choice sequence is reproducible. The engine stays deterministic from
// the seed; only our choice picker draws here.
let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));

/** Random unguided choice — the new-player baseline. Single-option events
 *  resolve their only choice; multi-option events pick uniformly at random. */
function pickChoice(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  return ch.length === 1 ? ch[0]! : ch[rint(0, ch.length - 1)]!;
}

function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

interface RunOutcome {
  peak: number; seasons: number; retireAge: number; reason: string;
  trophies: number; wc: boolean; ballon: boolean; legacy: number;
  crashed: boolean; setupLabel: string;
}

function playOne(seed: string, setup: Setup, blessed: boolean): RunOutcome {
  _s = 0x9e3779b9 ^ hash32(seed);   // reseed harness RNG per run (reproducible)
  const baseSetup: RunSetup = {
    seed, nationalityId: setup.nation, position: setup.pos, leagueId: setup.league,
    pace: setup.pace, ascension: 0,
    blessings: blessed ? BLESSED_LOADOUT : [],
    allowWonderkid: blessed,
    permPerks: [],
  };
  let g: GameState;
  try {
    g = simulatePeriod(createRun(baseSetup));
  } catch {
    return { peak: 0, seasons: 0, retireAge: 0, reason: "crash", trophies: 0, wc: false, ballon: false, legacy: 0, crashed: true, setupLabel: setup.label };
  }
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      try {
        g = resolveChoice(g, pickChoice(g));
      } catch {
        return { peak: g.maxOverall, seasons: g.seasons.length, retireAge: g.age, reason: "crash", trophies: g.trophies.length, wc: g.trophies.includes("world_cup"), ballon: g.awards.includes("ballon_dor"), legacy: liveLegacy(g), crashed: true, setupLabel: setup.label };
      }
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  const crashed = guard > 400 && g.phase === "playing";
  return {
    peak: g.maxOverall, seasons: g.seasons.length, retireAge: g.age,
    reason: g.retirementReason ?? "?", trophies: g.trophies.length,
    wc: g.trophies.includes("world_cup"), ballon: g.awards.includes("ballon_dor"),
    legacy: liveLegacy(g), crashed, setupLabel: setup.label,
  };
}

// ───────────────────────────── stats helpers ─────────────────────────────
function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}
function median(arr: number[]): number { return pct(arr, 0.5); }
/** % of careers with peak ≥ thr (below=true → peak ≤ thr). */
function rate(arr: number[], thr: number, below = false): number {
  if (arr.length === 0) return 0;
  const n = below ? arr.filter((x) => x <= thr).length : arr.filter((x) => x >= thr).length;
  return Math.round((n / arr.length) * 100);
}
function rateThr(arr: number[], thr: number, below = false): number { return rate(arr, thr, below); }

interface ProfileAgg {
  peaks: number[]; seasons: number[]; legacy: number[];
  wcWon: number; ballonWon: number; crashed: number;
}
interface PerSetup { label: string; med: number; p10: number; p90: number; r95: number; r90: number; n: number }
interface Results {
  base: ProfileAgg & { per: PerSetup[]; reasonMix: Record<string, number> };
  bless: ProfileAgg & { per: PerSetup[]; reasonMix: Record<string, number> };
}

function aggregate(outs: RunOutcome[]): ProfileAgg & { per: PerSetup[]; reasonMix: Record<string, number> } {
  const peaks = outs.map((o) => o.peak);
  const seasons = outs.map((o) => o.seasons);
  const legacy = outs.map((o) => o.legacy);
  const reasonMix: Record<string, number> = {};
  for (const o of outs) reasonMix[o.reason] = (reasonMix[o.reason] ?? 0) + 1;
  const per: PerSetup[] = SETUPS.map((s) => {
    const p = outs.filter((o) => o.setupLabel === s.label).map((o) => o.peak);
    return { label: s.label, med: median(p), p10: pct(p, 0.1), p90: pct(p, 0.9), r95: rate(p, 95), r90: rate(p, 90), n: p.length };
  });
  return {
    peaks, seasons, legacy,
    wcWon: Math.round((outs.filter((o) => o.wc).length / outs.length) * 100),
    ballonWon: Math.round((outs.filter((o) => o.ballon).length / outs.length) * 100),
    crashed: outs.filter((o) => o.crashed).length,
    per, reasonMix,
  };
}

// ───────────────────────────── run ─────────────────────────────
function runProfile(blessed: boolean): ReturnType<typeof aggregate> {
  const outs: RunOutcome[] = [];
  for (let i = 0; i < N; i++) {
    for (const s of SETUPS) outs.push(playOne(`smoke-${i}-${hash32(`smoke-${s.label}-${i}`)}`, s, blessed));
  }
  return aggregate(outs);
}

const t0 = Date.now();
const base = runProfile(false);
const bless = runProfile(true);
const dt = Date.now() - t0;
const ctx: Results = { base, bless };

// ───────────────────────────── report ─────────────────────────────
const fmt = (n: number, d = 0) => Number.isInteger(n) ? String(n) : n.toFixed(d);
const fmtPct = (n: number) => `${n}%`;

/** CJK/fullwidth 感知的显示宽度（终端里中文占 2 列）。padEnd 按显示宽度补齐，
 *  这样表格列在含中文时也能对齐。 */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x303e) || (c >= 0x3041 && c <= 0x33ff)
      || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xa000 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f)
      || (c >= 0xff00 && c <= 0xff60) || (c >= 0x1f300 && c <= 0x1faff) ? 2 : 1;
  }
  return w;
}
const padEndW = (s: string, w: number) => s + " ".repeat(Math.max(0, w - dispWidth(s)));

function runGates(): { passed: number; failed: number; failedIds: string[] } {
  let passed = 0, failed = 0;
  const failedIds: string[] = [];
  console.log("\n难度曲线冒烟测试 — 生涯 OVR 曲线门槛");
  let lastProfile = "";
  for (const g of TARGET) {
    if (g.profile !== lastProfile) {
      lastProfile = g.profile;
      const title = g.profile === "baseline" ? "baseline · 无祝福/新手（舒适 + 涌现曲线）"
        : g.profile === "blessed" ? "blessed · 有祝福（更轻松上界）"
        : "invariant · 回归护栏（必须恒成立）";
      console.log(`── ${title} ──`);
    }
    const [measured, ok] = g.check(ctx);
    const mstr = g.id.startsWith("inv.blessNoWorse") ? `${fmt(measured, 1)} (差)`
      : g.metric.includes("%") || g.id.includes("surge") || g.id.includes("stall") || g.id.includes("elite") || g.id.includes("wc") || g.id.includes("Short") || g.id.includes("short") ? fmtPct(Math.round(measured))
      : g.id === "bless.legacy" ? `${fmt(measured, 2)}×`
      : fmt(measured);
    const verdict = ok ? "✓" : "✗";
    console.log(`  [${g.kind === "invariant" ? "INV" : "TGT"}] ${padEndW(g.metric, 26)} 目标 ${padEndW(g.target, 12)} 实测 ${padEndW(mstr, 9)} ${verdict}`);
    if (ok) passed++; else { failed++; failedIds.push(g.id); }
  }
  return { passed, failed, failedIds };
}

const { passed, failed, failedIds } = runGates();

// 分布明细 + 每 setup 打印
console.log(`\n# difficulty-smoke · N=${N} × ${SETUPS.length} setups = ${N * SETUPS.length} 局/档 · ${dt}ms · 两档共 ${N * SETUPS.length * 2} 局`);
console.log(`# baseline 分布: 中位巅峰 ${median(base.peaks)} · p10 ${pct(base.peaks,0.1)} · p90 ${pct(base.peaks,0.9)} · ≥95 ${rate(base.peaks,95)}% · ≥90 ${rate(base.peaks,90)}% · ≥85 ${rate(base.peaks,85)}% · ≥80 ${rate(base.peaks,80)}% · <70 ${rate(base.peaks,69,true)}%`);
console.log(`# blessed  分布: 中位巅峰 ${median(bless.peaks)} · p10 ${pct(bless.peaks,0.1)} · p90 ${pct(bless.peaks,0.9)} · ≥95 ${rate(bless.peaks,95)}% · ≥90 ${rate(bless.peaks,90)}% · ≥85 ${rate(bless.peaks,85)}% · ≥80 ${rate(bless.peaks,80)}% · <70 ${rate(bless.peaks,69,true)}%`);
console.log(`# baseline 退役原因: ${Object.entries(base.reasonMix).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${v}`).join(" · ")}`);
console.log(`# blessed  退役原因: ${Object.entries(bless.reasonMix).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${v}`).join(" · ")}`);
console.log(`# baseline 传承: 中位 ${median(base.legacy)} · p10 ${pct(base.legacy,0.1)} · p90 ${pct(base.legacy,0.9)}  |  blessed 传承: 中位 ${median(bless.legacy)} · p90 ${pct(bless.legacy,0.9)}`);
console.log(`# baseline 世界杯 ${base.wcWon}% · 金球 ${base.ballonWon}%   |   blessed 世界杯 ${bless.wcWon}% · 金球 ${bless.ballonWon}%`);
console.log("\n# 每 setup 中位巅峰 / ≥95 / ≥90（看哪条路线偏薄）:");
for (const p of base.per) console.log(`#   baseline ${p.label.padEnd(12)} 中位 ${fmt(p.med)} · p10 ${p.p10} · p90 ${p.p90} · ≥95 ${p.r95}% · ≥90 ${p.r90}% · n=${p.n}`);
for (const p of bless.per) console.log(`#   blessed  ${p.label.padEnd(12)} 中位 ${fmt(p.med)} · p10 ${p.p10} · p90 ${p.p90} · ≥95 ${p.r95}% · ≥90 ${p.r90}% · n=${p.n}`);

console.log("");
if (failed === 0) {
  console.log(`✅ 难度曲线达标: ${passed}/${passed + failed} 门槛通过。`);
} else {
  console.log(`❌ 难度曲线未达标: ${passed}/${passed + failed} 门槛通过，${failed} 条 ✗:`);
  for (const id of failedIds) {
    const g = TARGET.find((x) => x.id === id)!;
    const [measured] = g.check(ctx);
    console.log(`   · ${id}  ${g.metric}: 目标 ${g.target}，实测 ${fmt(measured, 2)} → 改引擎对应数值后重跑`);
  }
  console.log("\n# 这是「调参指南针」—— ✗ 即待补的差距，不是 bug。改 src/engine 的成长/天花板/");
  console.log("# 事件涌现数值后重跑本脚本，看门槛逐条翻绿。门槛本身可在此文件顶部 TARGET 编辑。");
}
process.exit(failed === 0 ? 0 : 1);
