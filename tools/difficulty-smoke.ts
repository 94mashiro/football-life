/**
 * 难度曲线冒烟测试 — 生涯 OVR 曲线的「调参指南针」。
 *
 * 跑 N 局完整生涯（headless），对巅峰 OVR 分布 + 生涯形态做 PASS/FAIL 断言。
 * 每条门槛打印「目标 vs 实测 vs ✓/✗」，任一不过则 exit 1 —— 改一个数值、重跑，
 * 看门槛从 ✗ 逐条翻成 ✓，让背后的数值调整变得可控。
 *
 * 两个干净 A/B 档（同一份「稍微努努力」策略，只差祝福，隔离祝福净效果）：
 *   baseline : 无祝福、飞升 0、smart 选择（爬转会阶梯到能当主力的更大俱乐部、
 *            训练走稳）—— 「什么祝福都不升但会做选择」的玩家。
 *   blessed  : 金童 + 神射手 + 大赛型选手、飞升 0、allowWonderkid —— 攒齐顶级祝福的玩家。
 *
 * 目标曲线（P-HEADROOM 重定指南针：整体压低基础峰值 ~4 给祝福/未来装备留向上空间）：
 *   baseline 中位巅峰 77–83 · ≥90 4–12%（基础稀有，靠祝福/装备填）· ≥95 ≤6%（稀有）·
 *   <70 ≤ 15%（基础更弱，地板下调）· p10 ≥ 66 · 生涯 16–24 季 · 世界杯 4–20%。
 *   blessed 中位巅峰 ≥ 83 · ≥90 ≥ 22%（祝福明显抬升，填头部空间）· ≥95 ≤10% · <70 ≤ 2% · 传承 ≥ baseline×1.15。
 *   invariant：blessed 中位巅峰 ≥ baseline 中位巅峰（祝福绝不能帮倒忙）。
 *   BAL-GROWTH：旧指南针把 blessed ≥95 定为 ≥12%（希望 95 对有祝福者「常见」），
 *   实测造成 95 聚集（meta 玩家 43%≥95、众数 93/95）。重定为「95 稀有」：成长兑底
 *   降为地板（不再 ladder 众人到 92-95）、95+ 仅由 permanent 事件透支（稀有），分布散开到
 *   80s-95。事件/选择权重 > 成长兑底权重（worst↔best 策略 ~9 OVR 跨度）。
 *
 * Run:  npx tsx tools/difficulty-smoke.ts [N=400]
 *
 * 说明：门槛作用在 3 个代表性 setup 的「聚合」分布上（整盘曲线），下方附
 * 每 setup 明细。聚合门槛衡量「整盘难度曲线是否健康」，单 setup 明细显示
 * 哪条路线偏薄。改引擎数值后重跑，门槛逐条转绿即达标。
 */
import { createRun, simulatePeriod, resolveChoice, liveLegacy, type RunSetup } from "../src/engine/run";
import { setPreviewsEnabled } from "../src/engine/events";
import { clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

// headless: 预览药丸走独立 derive 流，关掉不改变任何结果（tools/regress.ts 每轮
// 自检这一点），只省掉约 40% 的模拟 CPU。冒烟测只读分布，不读药丸。
setPreviewsEnabled(false);

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
  // ── baseline: 舒适 + 涌现曲线（无祝福但会做选择）──
  // ADR-0004: 上限 81→82——天花板轴（ASC_CEIL_DROP）压头部不压中位。
  // P-INJ6: 82→83——通用伤病从「一半生涯的税」降到 15%，中位不再被伤病暗压 1 分。
  { id: "base.median", profile: "baseline", kind: "target", metric: "中位巅峰 OVR", target: "77 ≤ m ≤ 83",
    check: (c) => { const m = median(c.base.peaks); return [m, m >= 77 && m <= 83]; } },
  { id: "base.elite90", profile: "baseline", kind: "target", metric: "≥90 巅峰占比", target: "4%–12%",
    check: (c) => { const p = rate(c.base.peaks, 90); return [p, p >= 4 && p <= 12]; } },
  { id: "base.surge95", profile: "baseline", kind: "target", metric: "≥95 巅峰占比", target: "≤ 6%",
    check: (c) => { const p = rate(c.base.peaks, 95); return [p, p <= 6]; } },
  { id: "base.stall", profile: "baseline", kind: "target", metric: "<70 巅峰占比", target: "≤ 15%",
    check: (c) => { const p = rate(c.base.peaks, 69, true); return [p, p <= 15]; } },
  { id: "base.floor", profile: "baseline", kind: "target", metric: "p10 巅峰 OVR", target: "≥ 66",
    check: (c) => { const p = pct(c.base.peaks, 0.10); return [p, p >= 66]; } },
  { id: "base.seasons", profile: "baseline", kind: "target", metric: "中位生涯赛季数", target: "16 ≤ s ≤ 24",
    check: (c) => { const m = median(c.base.seasons); return [m, m >= 16 && m <= 24]; } },
  { id: "base.wc", profile: "baseline", kind: "target", metric: "世界杯生涯夺冠率", target: "4%–20%",
    check: (c) => { const p = c.base.wcWon; return [p, p >= 4 && p <= 20]; } },

  // ── blessed: 有祝福更轻松（严格优于 baseline 的上界）──
  { id: "bless.median", profile: "blessed", kind: "target", metric: "中位巅峰 OVR", target: "≥ 83",
    check: (c) => { const m = median(c.bless.peaks); return [m, m >= 83]; } },
  { id: "bless.elite90", profile: "blessed", kind: "target", metric: "≥90 巅峰占比", target: "≥ 22%",
    check: (c) => { const p = rate(c.bless.peaks, 90); return [p, p >= 22]; } },
  { id: "bless.surge95", profile: "blessed", kind: "target", metric: "≥95 巅峰占比", target: "≤ 10%",
    check: (c) => { const p = rate(c.bless.peaks, 95); return [p, p <= 10]; } },
  { id: "bless.stall", profile: "blessed", kind: "target", metric: "<70 巅峰占比", target: "≤ 2%",
    check: (c) => { const p = rate(c.bless.peaks, 69, true); return [p, p <= 2]; } },
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
  { nation: "chn", pos: "ST", league: "china-league-one", pace: "normal", label: "CHN ST 中甲" },
];

/** 「稍微努努力」策略：爬转会阶梯到「能当主力」的最高 rep 俱乐部（不让自己
 *  在豪门坐板凳），训练/风险事件走稳（选 id="b" 的保守项）。两档共用此策略，
 *  只差祝福，净隔离祝福效果。纯确定性——选择由状态决定，不抽 harness RNG，
 *  故同一 seed 完全可复现（引擎本身的随机仍来自 seed 的 derive）。 */
function clubStars(c: Choice, g: GameState): number {
  if (c.id === "stay" || c.kind === "stay" || c.kind === "join_loan") {
    try { const r = clubById(g.currentClubId).rep; return r >= 8 ? 5 : r >= 6 ? 4 : r >= 4 ? 3 : r >= 2 ? 2 : 1; } catch { return 0; }
  }
  return (c.sub ?? "").split("★").length - 1;   // 转会报价的 ★ 数 = 目标俱乐部实力
}
function pickChoice(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  if (ch.length === 1) return ch[0]!;
  const key = g.pendingChoice!.key;
  // 转会类决策：爬到「能当主力」的最高 rep 俱乐部；没有就留队。
  if (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer") {
    const clubs = ch.filter((c) => (c.kind === "new_club" || c.kind === "permanent_transfer") && (c.sub ?? "").includes("主力"));
    if (clubs.length) return clubs.reduce((best, c) => clubStars(c, g) > clubStars(best, g) ? c : best, clubs[0]!);
    const stay = ch.find((c) => c.kind === "stay" || c.id === "stay");
    if (stay) return stay;
  }
  // 训练/风险/剧情事件：走稳——选 id="b"（多数 boss/训练事件的保守项）。
  const b = ch.find((c) => c.id === "b");
  if (b) return b;
  return ch[0]!;
}

function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

interface RunOutcome {
  peak: number; seasons: number; retireAge: number; reason: string;
  trophies: number; wc: boolean; ballon: boolean; legacy: number;
  crashed: boolean; setupLabel: string;
}

function playOne(seed: string, setup: Setup, blessed: boolean): RunOutcome {
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
