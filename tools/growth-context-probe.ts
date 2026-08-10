// 成长语境探针：出身国青训档 × 起步联赛 对 OVR 曲线的实际影响力
// 问题：中国/中超起步的球员 21 岁就 84 —— 语境是否真的进了成长公式？
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { randomSeed } from "../src/meta/legacy";
import { youthTierOf, leagueById } from "../src/engine/data";
import type { GameState, Choice, } from "../src/engine/types";
import type { Position } from "../src/engine/data";

const SETUPS: { label: string; pos: Position; league: string; nation: string }[] = [
  { label: "中国 · 中超",     pos: "ST", league: "csl", nation: "chn" },
  { label: "中国 · 中甲",     pos: "ST", league: "china-league-one", nation: "chn" },
  { label: "巴西 · 巴甲",     pos: "ST", league: "brasileirao", nation: "bra" },
  { label: "西班牙 · 西甲",   pos: "ST", league: "laliga", nation: "esp" },
  { label: "英格兰 · 英超",   pos: "ST", league: "premier-league", nation: "eng" },
  { label: "日本 · 日职",     pos: "ST", league: "j1-league", nation: "jpn" },
];

let _s = 0x9e3779b9;
function rnext() { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
function hash32(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));

const PER = Number(process.argv[2] ?? 1500);
const AGES = [18, 20, 21, 24, 28];

for (const [si, setup] of SETUPS.entries()) {
  const byAge: Record<number, number[]> = {};
  const peaks: number[] = [];
  const repAt21: number[] = [];
  for (let i = 0; i < PER; i++) {
    const seed = randomSeed();
    _s = 0x9e3779b9 ^ hash32(seed) ^ (si * 2654435761);
    const rs: RunSetup = { seed, nationalityId: setup.nation, position: setup.pos, leagueId: setup.league, blessings: [], ascension: 0, pace: "normal" };
    let g: GameState = simulatePeriod(createRun(rs));
    let guard = 0;
    while (g.phase === "playing" && guard++ < 400) {
      if (g.pendingChoice) {
        const ch = g.pendingChoice.choices;
        const pick: Choice = ch.length > 1 ? ch[rint(0, ch.length - 1)]! : ch[0]!;
        g = resolveChoice(g, pick);
        if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
      } else g = simulatePeriod(g);
    }
    let peak = 0;
    for (const s of g.seasons) {
      (byAge[s.age] ??= []).push(s.overall);
      peak = Math.max(peak, s.overall);
      if (s.age === 21) repAt21.push(leagueById(s.leagueId).domRep);
    }
    peaks.push(peak);
  }
  const domRep21 = repAt21.length ? (repAt21.reduce((x, y) => x + y, 0) / repAt21.length).toFixed(1) : "—";
  const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)] ?? 0;
  const cells = AGES.map((age) => {
    const a = byAge[age] ?? [];
    return a.length ? `${age}:${q(a, 0.5)}(p90 ${q(a, 0.9)})` : `${age}:—`;
  });
  const p = peaks.slice().sort((x, y) => x - y);
  const over84at21 = (byAge[21] ?? []).filter((v) => v >= 84).length / Math.max(1, (byAge[21] ?? []).length);
  console.log(
    `T${youthTierOf(setup.nation)} ${setup.label.padEnd(12)} | ${cells.join("  ")} | 峰值 中位${q(p, 0.5)} p90 ${q(p, 0.9)} | 21岁≥84 ${(over84at21 * 100).toFixed(1)}% | 21岁联赛档 ${domRep21}`,
  );
}
