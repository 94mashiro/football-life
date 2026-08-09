/**
 * 事件分布探针：跑大量生涯，统计每个事件的出现频率，检查「分布是否均匀」。
 *
 * 事件分三类（只有第一类能调均匀）：
 *   POOL        池事件——加权随机抽（rollRandomEvent），rarityWeightMult=1.0，
 *               频率由 weight + 资格条件决定。**均匀度的可调目标**。
 *   CONTEXTUAL  情境事件——eligible 恒 false，命中生涯状态强制弹（fireEventByKey）。
 *               绑生涯状态（降级/板凳/伤病年），不能调均匀。
 *   BUILDER     专属 builder——不在池里（转会/无人问津/薪资挤压/世界杯决赛…）。
 *               生涯弧线骨架，不能调均匀。
 *
 * 方法：跨 8 套差异化配置（位置×联赛×国籍）采样，最大化覆盖受门槛限制的事件
 * （GK 专属、弱国归化/回国、CAF/CONMEBOL 洲际杯等）。每生涯按 pendingChoice.key
 * 记录出现的「决策」事件（单选 flavor 不计——玩家不选择，非重复体感来源）。
 *
 * 输出：
 *   1. 全表：所有事件 key，分类，生涯出现率%，总次数。
 *   2. 池事件均匀度：出现率的中位数/均值/标准差/变异系数 CV。
 *   3. 离群：池事件里出现率 ≫ 中位数（劫持候选）与 =0（死事件/门槛过窄）。
 *   4. 情境/builder 单列展示（信息性，不可调）。
 *
 * 用法：npx tsx tools/event-distribution.ts [每生涯数]   默认 150/配置 × 8 = 1200 生涯
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { EVENT_DEFS } from "../src/engine/events";
import { randomSeed } from "../src/meta/legacy";
import type { GameState, Choice, Position } from "../src/engine/types";

// ─────────────── 分类：哪些 key 不在随机池里 ───────────────
// CONTEXTUAL: 在 EVENT_DEFS 注册但 eligible 恒 false（fireEventByKey 强制弹）。
const CONTEXTUAL_IN_POOL = new Set([
  "relegation_loyalty", "throne_challenge", "contract_nonrenewal",
  "underperform_release", "stuck_release", "naturalization_offer",
  "club_national_team_conflict",
]);
// BUILDER: 不在 EVENT_DEFS，由专属函数构造（run.ts 直接赋值 event.key）。
const BUILDER_ONLY = new Set([
  "world_cup_showdown", "world_cup_qualifier_showdown", "continental_cup_showdown",
  "transfer", "no_offers", "wage_squeeze", "fame_league_bid", "fame_league_offer",
  "loan_offer", "post_loan", "blockbuster_offer", "doctor_warning",
  "medical_verdict", "injury",
]);

// 池事件 = EVENT_DEFS 里 eligible 可为真的（排除情境事件）。
const POOL_KEYS = new Set(EVENT_DEFS.map((d) => d.key).filter((k) => !CONTEXTUAL_IN_POOL.has(k)));
// 全域 = 池 ∪ 情境 ∪ builder
const ALL_KEYS = new Set<string>([...POOL_KEYS, ...CONTEXTUAL_IN_POOL, ...BUILDER_ONLY]);

function categoryOf(key: string): "POOL" | "CTX" | "BLD" {
  if (POOL_KEYS.has(key)) return "POOL";
  if (CONTEXTUAL_IN_POOL.has(key)) return "CTX";
  if (BUILDER_ONLY.has(key)) return "BLD";
  return "POOL"; // 未知 key 归池（方便观察新加事件）
}

// ─────────────── 差异化采样矩阵 ───────────────
// 覆盖：GK + 6 外场位置；UEFA 为主 + AFC/CAF/CONMEBOL；强/中/弱国籍。
const SETUPS: { pos: Position; league: string; nation: string; tag: string }[] = [
  { pos: "ST",  league: "brasileirao",    nation: "bra", tag: "CONMEBOL·强" },
  { pos: "GK",  league: "premier-league", nation: "eng", tag: "英超·门将" },
  { pos: "CM",  league: "laliga",         nation: "esp", tag: "西甲·强" },
  { pos: "CB",  league: "serie-a",        nation: "cro", tag: "意甲·中" },
  { pos: "ST",  league: "csl",            nation: "chn", tag: "中超·弱AFC" },
  { pos: "LW",  league: "ligue-1",        nation: "sen", tag: "法甲·CAF" },
  { pos: "RW",  league: "eredivisie",     nation: "ned", tag: "荷甲·中" },
  { pos: "CDM", league: "bundesliga",     nation: "ger", tag: "德甲·强" },
];

// ─────────────── RNG（仅用于挑选项与生成种子，不进引擎）───────────────
let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const PER_SETUP = Number(process.argv[2] ?? 150);
const N = PER_SETUP * SETUPS.length;

// 聚合：fires[key] = 总出现次数；touched[key] = 出现过的生涯数
const fires: Record<string, number> = {};
const touched: Record<string, number> = {};
let totalDecisions = 0;

for (let si = 0; si < SETUPS.length; si++) {
  const setup = SETUPS[si]!;
  for (let i = 0; i < PER_SETUP; i++) {
    const seed = randomSeed();
    _s = 0x9e3779b9 ^ hash32(seed) ^ (si * 2654435761);
    const runSetup: RunSetup = {
      seed, nationalityId: setup.nation, position: setup.pos,
      leagueId: setup.league, blessings: [], ascension: 0, pace: "normal",
    };
    let g: GameState = simulatePeriod(createRun(runSetup));
    const seenThisCareer = new Set<string>();
    let guard = 0;
    while (g.phase === "playing" && guard++ < 400) {
      if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
      if (g.pendingChoice) {
        const ch = g.pendingChoice.choices;
        // 记录所有出现的事件 key（含单选传奇时刻——玩家仍会看到并点击）。
        const key = g.pendingChoice.key;
        fires[key] = (fires[key] ?? 0) + 1;
        totalDecisions++;
        if (!seenThisCareer.has(key)) { seenThisCareer.add(key); touched[key] = (touched[key] ?? 0) + 1; }
        const pick: Choice = ch.length > 1 ? ch[rint(0, ch.length - 1)]! : ch[0]!;
        g = resolveChoice(g, pick);
        if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
      } else {
        g = simulatePeriod(g);
      }
    }
  }
}

// ─────────────── 统计 ───────────────
const allKeys = [...ALL_KEYS].sort();
// 出现过的 key（含 0 次的全域 key）
const rows = allKeys.map((k) => ({
  key: k,
  cat: categoryOf(k),
  pct: (touched[k] ?? 0) / N * 100,
  fires: fires[k] ?? 0,
}));
rows.sort((a, b) => b.pct - a.pct || b.fires - a.fires);

// 池事件均匀度
const poolRows = rows.filter((r) => r.cat === "POOL" && r.fires > 0);
const poolPcts = poolRows.map((r) => r.pct).sort((a, b) => a - b);
const mean = poolPcts.reduce((s, v) => s + v, 0) / (poolPcts.length || 1);
const median = poolPcts.length ? poolPcts[Math.floor(poolPcts.length / 2)]! : 0;
const variance = poolPcts.reduce((s, v) => s + (v - mean) ** 2, 0) / (poolPcts.length || 1);
const stddev = Math.sqrt(variance);
const cv = mean > 0 ? stddev / mean : 0; // 变异系数：越小越均匀

const poolNever = rows.filter((r) => r.cat === "POOL" && r.fires === 0);
const poolOverRep = poolRows.filter((r) => r.pct > median * 2);   // ≫ 中位数：劫持候选
const poolUnderRep = poolRows.filter((r) => r.pct < median * 0.25 && r.pct > 0); // ≪ 中位数但仍出现

// ─────────────── 输出 ───────────────
console.log(`N=${N} 生涯 (${PER_SETUP}/配置 × ${SETUPS.length} 配置) · ${totalDecisions} 决策 · ${(totalDecisions / N).toFixed(1)} 决策/生涯`);
console.log(`\n事件全域: ${allKeys.length} 个 = 池 ${POOL_KEYS.size} + 情境 ${CONTEXTUAL_IN_POOL.size} + builder ${BUILDER_ONLY.size}`);

console.log(`\n════════ 池事件均匀度（可调目标）════════`);
console.log(`出现过的池事件: ${poolRows.length}/${POOL_KEYS.size}（${poolNever.length} 个从未出现）`);
console.log(`生涯出现率 中位数 ${median.toFixed(1)}% · 均值 ${mean.toFixed(1)}% · 标准差 ${stddev.toFixed(1)} · CV=${cv.toFixed(2)}（越小越均匀，0=完全均匀）`);

console.log(`\n── 劫持候选（池事件出现率 ≫ 中位数 ×2，${median.toFixed(1)}%×2=${(median*2).toFixed(1)}%）──`);
const over = poolOverRep.sort((a, b) => b.pct - a.pct);
if (over.length === 0) console.log("  （无）");
for (const r of over) console.log(`  ${r.key.padEnd(28)} ${r.pct.toFixed(1).padStart(6)}%  ${r.fires}次`);

console.log(`\n── 偏少（出现率 ≪ 中位数 ×0.25，但非0；可能是门槛过窄或权重过低）──`);
const under = poolUnderRep.sort((a, b) => a.pct - b.pct);
if (under.length === 0) console.log("  （无）");
for (const r of under.slice(0, 20)) console.log(`  ${r.key.padEnd(28)} ${r.pct.toFixed(1).padStart(6)}%  ${r.fires}次`);

console.log(`\n── 从未出现（死事件 / 门槛过窄 / 采样未覆盖）── ${poolNever.length} 个`);
if (poolNever.length === 0) console.log("  （无）");
for (const r of poolNever) console.log(`  ${r.key.padEnd(28)}   0%`);

console.log(`\n════════ 情境事件（绑生涯状态，不可调均匀）════════`);
for (const r of rows.filter((r) => r.cat === "CTX")) {
  console.log(`  ${r.key.padEnd(28)} ${r.pct.toFixed(1).padStart(6)}%  ${r.fires}次`);
}

console.log(`\n════════ Builder 骨架事件（生涯弧线，不可调均匀）════════`);
for (const r of rows.filter((r) => r.cat === "BLD")) {
  console.log(`  ${r.key.padEnd(28)} ${r.pct.toFixed(1).padStart(6)}%  ${r.fires}次`);
}

console.log(`\n════════ 全表（按生涯出现率降序）════════`);
console.log(`  ${"key".padEnd(28)} 类别  ${"出现率%".padStart(7)}  ${"次数".padStart(5)}`);
for (const r of rows) {
  console.log(`  ${r.key.padEnd(28)}  ${r.cat}  ${r.pct.toFixed(1).padStart(6)}%  ${String(r.fires).padStart(5)}`);
}
