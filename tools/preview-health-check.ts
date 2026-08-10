/**
 * 预览健康审计 — 全量检查所有选项的 preview：
 *  1. 赌博型（optionOdds 有值）：preview 必须 !== undefined（不空白），且两分支
 *     概率之和应 ≈ 1（win 的首条 prob + lose 的首条 prob = odds + (1-odds)）。
 *  2. 确定性型（optionOdds undefined）：preview 每条 prob 都应为 1（100%）。
 *  3. 两分支完全相同被收敛成确定性的：prob 应为 1（不应残留 odds 概率）。
 *
 *  例外（合法空白）：forcedExitFiredEvent（underperform_release / stuck_release 的
 *  club-N 选项）是「纯选队」——效果就是 newClubId 本身，UI 用俱乐部 crest + sub
 *  （联赛·星级·角色）已完整表达，加 pill 反而冗余。这些选项的空白是设计，排除。
 *
 * 报告任何违规。
 *
 * Run:  npx tsx tools/preview-health-check.ts
 */
import { EVENT_DEFS, optionOdds, type EventContext } from "../src/engine/events";
import { CLUBS, LEAGUES, NATIONS } from "../src/engine/data";
import { derive } from "../src/engine/rng";
import type { Player } from "../src/engine/types";

function ctx(): EventContext {
  const club = CLUBS.find((c) => c.id === "man_city") ?? CLUBS[0]!;
  const league = LEAGUES.find((l) => l.id === club.leagueId) ?? LEAGUES[0]!;
  const nation = NATIONS[0]!;
  const player = {
    id: "probe", name: "探针", nationalityId: nation.id, position: "ST",
    age: 28, overall: 82, potential: 90, clubId: club.id, retired: false,
  } as unknown as Player;
  return {
    player, club, league, seed: "probe", age: 28, role: "starter",
    periodIndex: 24, rngState: derive("probe", "ctx"), blessings: [],
    injuriesTaken: 1, ascension: 0, statusTags: ["nagging_injury@2"],
  };
}

// 纯选队选项：效果 = newClubId，UI 用 crest + sub 表达，preview 留空是设计。
const PURE_PICK_CLUB = new Set([
  "underperform_release:club-0", "underperform_release:club-1", "underperform_release:club-2",
  "stuck_release:club-0", "stuck_release:club-1", "stuck_release:club-2",
]);

const c = ctx();
let total = 0, gamble = 0, det = 0, blank = 0, detProbBad = 0;
const issues: string[] = [];
for (const def of EVENT_DEFS) {
  let fired;
  try { fired = def.build(c); } catch { continue; }
  for (const ch of fired.event.choices) {
    total++;
    const odds = optionOdds(def.key, ch.id, c);
    const id = `${def.key}:${ch.id}`;
    // 新预览模型：certain（必定区，不带 %）+ roll（骰子区，% 挂在簇标签上）。
    // 「空白」= 两者都没有。旧版读的是已删除的扁平 ch.preview/p.prob 字段。
    const empty = (ch.certain?.length ?? 0) === 0 && ch.roll === undefined;
    if (odds === undefined) {
      det++;
      if (empty) {
        if (PURE_PICK_CLUB.has(id)) continue;  // 设计性空白：纯选队
        blank++; issues.push(`空白(确定性): ${id}`); continue;
      }
      // 确定性选项不该有骰子区——没有 roll 就没有该标的百分比。
      if (ch.roll !== undefined) { detProbBad++; issues.push(`确定性选项却画了骰子区: ${id}`); }
    } else {
      gamble++;
      if (empty) { blank++; issues.push(`空白(赌博): ${id}`); continue; }
      if (ch.roll === undefined) { issues.push(`赌博没有骰子区(只剩必定区): ${id}`); continue; }
      if (!(ch.roll.winProb > 0 && ch.roll.winProb < 1)) issues.push(`赌博胜率不在 (0,1): ${id} winProb=${ch.roll.winProb}`);
      if (ch.roll.win.length === 0 && ch.roll.lose.length === 0) issues.push(`赌博两侧都空: ${id}`);
    }
  }
}
console.log(`选项总数: ${total} (赌博 ${gamble} / 确定性 ${det})`);
console.log(`空白(非设计): ${blank}`);
console.log(`确定性 prob≠100%: ${detProbBad}`);
console.log(`问题数: ${issues.length}`);
for (const i of issues.slice(0, 30)) console.log("  " + i);
