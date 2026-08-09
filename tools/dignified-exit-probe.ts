/**
 * 体面退场 + 预览分组 双探针。
 *
 * 1. 预览分组：赌注选项的两条分支中【共有】的后果只画一次并标 100%，只有真正
 *    随骰子变化的后果才带 45%/55%。回归的是 career_threatening_injury:rehab_war
 *    ——它的 -8 OVR / 重伤 / 停赛 写在 if/else 之外（骰子不决定），旧版把两分支
 *    各画一遍还各挂概率，且逐分支截断把「停赛」从成功侧砍掉，凭空造出一个不
 *    存在的分支差异。
 *
 * 2. 体面退场：DIGNIFIED_EXIT_MULT 必须让「接受终结」在【老将+荣誉满仓】时优于
 *    硬撑，在【年轻+一无所有】时劣于硬撑——即最优解随处境翻转，而不是换一个
 *    方向的支配策略。
 *
 * Run:  npx tsx tools/dignified-exit-probe.ts
 */
import { EVENT_DEFS, optionOdds, type EventContext } from "../src/engine/events";
import { CLUBS, LEAGUES, NATIONS } from "../src/engine/data";
import { derive } from "../src/engine/rng";
import { scoreLegacy } from "../src/meta/legacy";
import type { Player, Trophy, Award } from "../src/engine/types";

function ctx(age: number, overall: number): EventContext {
  const club = CLUBS.find((c) => c.id === "man_city") ?? CLUBS[0]!;
  const league = LEAGUES.find((l) => l.id === club.leagueId) ?? LEAGUES[0]!;
  const nation = NATIONS[0]!;
  const player = {
    id: "probe", name: "探针", nationalityId: nation.id, position: "ST",
    age, overall, potential: 92, clubId: club.id, retired: false,
  } as unknown as Player;
  return {
    player, club, league, seed: "probe", age, role: "starter",
    periodIndex: age - 16, rngState: derive("probe", "ctx"), blessings: [],
    injuriesTaken: 1, ascension: 0, statusTags: [],
  };
}

let fail = 0;
const bad = (msg: string) => { console.log("  ✗ " + msg); fail++; };

// ── 1. 预览分组 ──────────────────────────────────────────────────────────
console.log("[1] 预览分组");
const c = ctx(30, 84);
for (const def of EVENT_DEFS) {
  let fired;
  try { fired = def.build(c); } catch { continue; }
  for (const ch of fired.event.choices) {
    const odds = optionOdds(def.key, ch.id, c);
    if (odds === undefined || !ch.preview) continue;
    // 同一条后果不该在一个选项里出现两次——那正是旧版把共有后果画两遍的症状。
    const labels = ch.preview.map((p) => p.label);
    const dup = labels.find((l, i) => labels.indexOf(l) !== i);
    if (dup !== undefined) bad(`${def.key}:${ch.id} 重复 pill「${dup}」`);
  }
}
const inj = EVENT_DEFS.find((d) => d.key === "career_threatening_injury")!.build(c);
const rehab = inj.event.choices.find((x) => x.id === "rehab_war")!;
console.log("  毁灭性伤病 · 拼上一切康复:");
for (const p of rehab.preview ?? []) {
  console.log(`    ${p.good ? "▲" : "▼"} ${p.label}  ${p.prob !== undefined ? Math.round(p.prob * 100) + "%" : "—"}`);
}
// 必然后果必须标 100%，且「停赛」不能只出现在其中一侧。
const susp = (rehab.preview ?? []).filter((p) => p.label === "停赛");
if (susp.length === 1 && susp[0]!.prob !== 1) bad("「停赛」两分支都有，却没标 100%");
const end = inj.event.choices.find((x) => x.id === "accept_end")!;
console.log("  毁灭性伤病 · 也许这就是终点了:");
for (const p of end.preview ?? []) {
  console.log(`    ${p.good ? "▲" : "▼"} ${p.label}  ${p.prob !== undefined ? Math.round(p.prob * 100) + "%" : "—"}`);
}
if (!(end.preview ?? []).some((p) => p.good)) bad("体面退场没有任何正向 pill——卡面上仍是纯损失");

// ── 2. 体面退场的处境翻转 ────────────────────────────────────────────────
console.log("[2] 体面退场：最优解随处境翻转");
const score = (
  maxOvr: number, seasons: number, trophies: Trophy[], awards: Award[],
  wage: number, mv: number, dignified: boolean, goals: number,
) => scoreLegacy(maxOvr, seasons, trophies, awards, 0, null, undefined, wage, mv, dignified, 1, 1, "ST", goals, 60, 0, 1);

// 老将：34 岁，欧冠 ×2 + 联赛 ×5 + 金球，身体已毁。退役 vs 再撑 3 个残季
// （残季按重伤后的产出估：无奖杯、薪资减半、身价腰斩）。
const vetT: Trophy[] = ["continental_primary", "continental_primary", "league", "league", "league", "league", "league"];
const vetA: Award[] = ["ballon_dor", "golden_boot"];
const vetQuit = score(90, 18, vetT, vetA, 90000, 30, true, 300);
const vetGrind = score(90, 21, vetT, vetA, 105000, 8, false, 320);
console.log(`  老将(34/90/荣誉满仓)  体面退场 ${vetQuit}   硬撑三季 ${vetGrind}`);
if (vetQuit <= vetGrind) bad("老将局面下体面退场仍不划算——选项还是死的");

// 年轻：24 岁，履历空白。退役 vs 再踢 12 季正常生涯。
const youngQuit = score(80, 8, ["league"], [], 20000, 25, true, 60);
const youngGrind = score(88, 20, ["league", "league", "continental_primary", "cup"], ["golden_boot"], 90000, 15, false, 220);
console.log(`  新星(24/80/履历空白)  体面退场 ${youngQuit}   继续踢 ${youngGrind}`);
if (youngQuit >= youngGrind) bad("年轻局面下退役反而更优——变成了「攒够就退」的刷分线");

console.log(fail === 0 ? "\nPASS" : `\nFAIL (${fail})`);
if (fail > 0) process.exitCode = 1;
