/**
 * 上升期池事件「叙事配比」体检。
 *
 * 对一个代表性的上升期 ctx（24 岁 / OVR 78 / 主力 / rep7 豪门），枚举所有
 * eligible 的池事件，把每个事件的两个分支都跑一遍（forced positive / negative），
 * 按「最坏分支的 OVR 后果」给事件归档：
 *   救命档 upside-only  最坏分支也不扣 OVR
 *   赌局档 gamble       有正分支也有扣分分支
 *   纯威胁档 threat     所有分支都不给正 OVR
 * 输出按 weight 加权的配比——这是玩家实际「抽到什么」的分布，不是事件条数。
 *
 * Run: npx tsx tools/rise-pool-valence.ts [ovr=78] [age=24]
 */
import { EVENT_DEFS, resolveEventOption } from "../src/engine/events";
import { clubById, leagueById } from "../src/engine/data";
import { derive } from "../src/engine/rng";
import type { Player } from "../src/engine/types";
import type { EventContext } from "../src/engine/events";

const OVR = Number(process.argv[2] ?? 78);
const AGE = Number(process.argv[3] ?? 24);

const club = clubById("man-city") ?? clubById([...new Set(["arsenal"])][0]!);
const league = leagueById(club.leagueId);
const player = {
  name: "Probe", age: AGE, overall: OVR, position: "ST", nationalityId: "eng",
  originNationalityId: "eng", devProfile: "normal", squadNumber: 9,
} as unknown as Player;

const ctx = {
  player, club, league, seed: "valence", age: AGE, role: "starter",
  periodIndex: 4, rngState: derive("valence", "pool"), blessings: [],
  injuriesTaken: 0, ascension: 0, severeInjuries: 0, failStreak: 0,
  periodLength: 2, permPerks: [], formerClubIds: [], recentMarketValue: 60,
  recentRating: 7.2, statusTags: [], tournamentOffset: 0, seenEvents: [],
} as unknown as EventContext;

const ovrOf = (m: { immediateOverallDelta?: number; permanentOverallDelta?: number; deferredOverallDelta?: number }) =>
  (m.immediateOverallDelta ?? 0) + (m.permanentOverallDelta ?? 0) + (m.deferredOverallDelta ?? 0);

type Row = { key: string; title: string; weight: number; best: number; worst: number; bucket: string };
const rows: Row[] = [];

for (const def of EVENT_DEFS) {
  let ok = false;
  try { ok = def.eligible(ctx); } catch { ok = false; }
  if (!ok) continue;
  let fired;
  try { fired = def.build(ctx); } catch { continue; }
  const deltas: number[] = [];
  for (const c of fired.event.choices) {
    for (const forced of ["positive", "negative"] as const) {
      try {
        const r = resolveEventOption(derive("v", def.key, c.id, forced), def.key, c.id, ctx, forced);
        deltas.push(ovrOf(r.mods));
      } catch { /* branch not modelled for this option */ }
    }
  }
  if (deltas.length === 0) continue;
  const best = Math.max(...deltas), worst = Math.min(...deltas);
  const bucket = worst >= 0 ? (best > 0 ? "救命档" : "中性档") : best > 0 ? "赌局档" : "纯威胁档";
  rows.push({ key: def.key, title: def.title, weight: def.weight, best, worst, bucket });
}

const totalW = rows.reduce((s, r) => s + r.weight, 0);
console.log(`上升期样本 ctx: ${AGE}岁 / OVR ${OVR} / 主力 / ${club.name}(rep ${club.rep})`);
console.log(`eligible 池事件 ${rows.length} 个, 总权重 ${totalW}\n`);
console.log("档位            事件数  权重占比   平均最好  平均最坏");
for (const b of ["救命档", "赌局档", "中性档", "纯威胁档"]) {
  const g = rows.filter(r => r.bucket === b);
  if (!g.length) { console.log(`${b.padEnd(14)}  0`); continue; }
  const w = g.reduce((s, r) => s + r.weight, 0);
  const avg = (f: (r: Row) => number) => (g.reduce((s, r) => s + f(r), 0) / g.length).toFixed(1);
  console.log(`${b.padEnd(14)}  ${String(g.length).padStart(3)}   ${(w / totalW * 100).toFixed(1).padStart(6)}%   ${avg(r => r.best).padStart(7)}   ${avg(r => r.worst).padStart(7)}`);
}
console.log("\n权重最高的 20 个 (玩家最常抽到的):");
[...rows].sort((a, b) => b.weight - a.weight).slice(0, 20)
  .forEach(r => console.log(`  w${String(r.weight).padStart(3)} ${r.bucket.padEnd(5)} ${r.title}  (最好 ${r.best >= 0 ? "+" : ""}${r.best} / 最坏 ${r.worst})`));
console.log("\n纯威胁档全部:");
rows.filter(r => r.bucket === "纯威胁档").sort((a, b) => b.weight - a.weight)
  .forEach(r => console.log(`  w${String(r.weight).padStart(3)} ${r.title} (最好 ${r.best} / 最坏 ${r.worst})`));
