/**
 * 分层补偿方案验证（event-uniformity-probe）。
 * 用 /tmp/nE_final.json 的 n_E，构造 override = (legendary?4:10)/(n_E+K)，
 * 跑 40k 生涯测出现率，对照 K=0.05/0.1/0.2 + 现状基线。
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { EVENT_DEFS, POOL_CLUB_MOVE_KEYS, setPoolProbeHooks } from "../src/engine/events";
import { randomSeed } from "../src/meta/legacy";
import type { GameState, Choice, Position } from "../src/engine/types";
import { readFileSync } from "fs";

const nE: { key: string; rarity: string; n_E: number }[] = JSON.parse(readFileSync("/tmp/nE_final.json", "utf8"));
const nEMap = new Map(nE.map((e) => [e.key, e.n_E]));
const CONTEXTUAL = new Set(["relegation_loyalty", "throne_challenge", "contract_nonrenewal", "underperform_release", "stuck_release", "naturalization_offer", "club_national_team_conflict"]);
const POOL = new Set(EVENT_DEFS.map((d) => d.key).filter((k) => !CONTEXTUAL.has(k)));
const NON_CLUB = new Set([...POOL].filter((k) => !POOL_CLUB_MOVE_KEYS.has(k)));

const SETUPS: { pos: Position; league: string; nation: string }[] = [
  { pos: "ST", league: "brasileirao", nation: "bra" }, { pos: "GK", league: "premier-league", nation: "eng" },
  { pos: "CM", league: "laliga", nation: "esp" }, { pos: "CB", league: "serie-a", nation: "cro" },
  { pos: "ST", league: "csl", nation: "chn" }, { pos: "LW", league: "ligue-1", nation: "sen" },
  { pos: "RW", league: "eredivisie", nation: "ned" }, { pos: "CDM", league: "bundesliga", nation: "ger" },
];
let _s = 0x9e3779b9;
function rnext() { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
function hash32(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const PER = Number(process.argv[2] ?? 5000);
const N = PER * SETUPS.length;

function overrideFor(K: number, clamp: number): Record<string, number> | null {
  if (K < 0) return null; // baseline
  const o: Record<string, number> = {};
  for (const d of EVENT_DEFS) {
    if (!NON_CLUB.has(d.key)) continue;
    const n = nEMap.get(d.key) ?? 0;
    const base = (d.rarity === "legendary") ? 4 : 10;
    let w = n > 0 ? base / (n + K) : base;
    if (clamp > 0) w = Math.min(w, clamp);
    o[d.key] = w;
  }
  return o;
}

function runPass2(override: Record<string, number> | null) {
  setPoolProbeHooks(override, null);
  const touched: Record<string, number> = {};
  for (let si = 0; si < SETUPS.length; si++) {
    for (let i = 0; i < PER; i++) {
      const seed = randomSeed();
      _s = 0x9e3779b9 ^ hash32(seed) ^ (si * 2654435761);
      const rs: RunSetup = { seed, nationalityId: SETUPS[si]!.nation, position: SETUPS[si]!.pos, leagueId: SETUPS[si]!.league, blessings: [], ascension: 0, pace: "normal" };
      let g: GameState = simulatePeriod(createRun(rs));
      const seen = new Set<string>();
      let guard = 0;
      while (g.phase === "playing" && guard++ < 400) {
        if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
        if (g.pendingChoice) {
          const ch = g.pendingChoice.choices;
          const key = g.pendingChoice.key;
          if (!seen.has(key)) { seen.add(key); touched[key] = (touched[key] ?? 0) + 1; }
          const pick: Choice = ch.length > 1 ? ch[rint(0, ch.length - 1)]! : ch[0]!;
          g = resolveChoice(g, pick);
          if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
        } else g = simulatePeriod(g);
      }
    }
  }
  return touched;
}

function stats(touched: Record<string, number>, label: string) {
  const rows = [...NON_CLUB].map((k) => ({ key: k, pct: (touched[k] ?? 0) / N * 100, rarity: nE.find((e) => e.key === k)?.rarity ?? "common" }));
  const fired = rows.filter((r) => r.pct > 0).map((r) => r.pct).sort((a, b) => a - b);
  const n = fired.length;
  const mean = fired.reduce((s, v) => s + v, 0) / (n || 1);
  const med = n ? fired[Math.floor(n / 2)] : 0;
  const sd = Math.sqrt(fired.reduce((s, v) => s + (v - mean) ** 2, 0) / (n || 1));
  const cv = mean > 0 ? sd / mean : 0;
  const dead = rows.filter((r) => r.pct === 0 && r.key !== "injury").length;
  const max = fired.length ? fired[fired.length - 1] : 0;
  // common/rare band
  const cr = rows.filter((r) => r.rarity !== "legendary" && r.pct > 0).map((r) => r.pct).sort((a, b) => a - b);
  const lg = rows.filter((r) => r.rarity === "legendary" && r.pct > 0).map((r) => r.pct).sort((a, b) => a - b);
  const crMed = cr.length ? cr[Math.floor(cr.length / 2)] : 0;
  const lgMed = lg.length ? lg[Math.floor(lg.length / 2)] : 0;
  console.log(`【${label}】 出现${n}/${NON_CLUB.size} · 死${dead} · 中位${med.toFixed(2)}% 均值${mean.toFixed(2)}% 标准差${sd.toFixed(2)} CV=${cv.toFixed(2)} 顶${max.toFixed(1)}%`);
  console.log(`   普通/稀有 band: 中位${crMed.toFixed(2)}% 区间${cr[0]?.toFixed(2) ?? 0}–${cr[cr.length - 1]?.toFixed(1) ?? 0}%  | 传奇 band: 中位${lgMed.toFixed(2)}% 区间${lg[0]?.toFixed(2) ?? 0}–${lg[lg.length - 1]?.toFixed(1) ?? 0}%`);
  return rows;
}

console.log(`N=${N} 生涯 · 普通稀有base=10 传奇base=4 · K=0.1\n`);
const base = runPass2(overrideFor(-1, 0));
const noclamp = runPass2(overrideFor(0.1, 0));
const c6 = runPass2(overrideFor(0.1, 6));
setPoolProbeHooks(null, null);

const rBase = stats(base, "现状基线");
const rNo = stats(noclamp, "K=0.1 无clamp");
const rC6 = stats(c6, "K=0.1 clamp=6");

// top hijackers comparison
console.log(`\n=== 头部对照（出现率 top 14）===`);
console.log(`  ${"key".padEnd(22)} ${"现状".padStart(6)} ${"无clamp".padStart(7)} ${"c6".padStart(6)}`);
const allKeys = new Set<string>();
for (const r of [rBase, rNo, rC6]) for (const x of r.sort((a, b) => b.pct - a.pct).slice(0, 14)) allKeys.add(x.key);
const m = (rows: ReturnType<typeof stats>, k: string) => rows.find((r) => r.key === k)?.pct ?? 0;
const topSorted = [...allKeys].map((k) => ({ k, b: m(rBase, k), a: m(rNo, k), c: m(rC6, k) })).sort((a, b) => b.c - a.c);
for (const r of topSorted.slice(0, 18)) console.log(`  ${r.k.padEnd(22)} ${r.b.toFixed(1).padStart(5)}% ${r.a.toFixed(1).padStart(6)}% ${r.c.toFixed(1).padStart(5)}%`);

// legendary band comparison (the user cares legendary stays rare)
console.log(`\n=== 传奇事件出现率（应保持 < 普通）===`);
const lgKeys = [...NON_CLUB].filter((k) => nE.find((e) => e.key === k)?.rarity === "legendary").sort((a, b) => m(rNo, b) - m(rNo, a));
console.log(`  ${"key".padEnd(22)} ${"现状".padStart(6)} ${"无clamp".padStart(7)} ${"c6".padStart(6)}`);
for (const k of lgKeys.slice(0, 10)) console.log(`  ${k.padEnd(22)} ${m(rBase, k).toFixed(2).padStart(5)}% ${m(rNo, k).toFixed(2).padStart(6)}% ${m(rC6, k).toFixed(2).padStart(5)}%`);
