/**
 * 赌博型选项「空白预览」审计 — 扫描所有 optionOdds 有定义（即赌博型，本应显示
 * 两分支概率 pill）但 build 后 preview 为 undefined 的选项。命中即「选项卡上什么
 * 都不显示、选中后却有效果」的 bug：通常是某个分支净 OVR=0 且只设了 previewLabel
 * 不建模的效果（标签 / 立即+延后相消的 OVR / 两分支首 pill 同标签 / 空 mods），
 * 导致 previewBranch 返回 null 或被 optionPreview 的同标签去重吃掉。
 *
 * 回归守卫：改 previewLabel / optionPreview / 事件 modifiers 后跑一遍，确认没有
 * 新增的空白预览（修复前 11 个，显形 compromised_body 后 10 个）。
 *
 * Run:  npx tsx tools/preview-null-audit.ts
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

const c = ctx();
let gambleCount = 0, nullCount = 0;
const nulls: string[] = [];
for (const def of EVENT_DEFS) {
  let fired;
  try { fired = def.build(c); } catch { continue; }
  for (const ch of fired.event.choices) {
    if (optionOdds(def.key, ch.id, c) === undefined) continue;  // 只看赌博型
    gambleCount++;
    if ((ch.certain?.length ?? 0) === 0 && ch.roll === undefined) {
      nullCount++;
      nulls.push(`${def.key}:${ch.id}  (${def.title} / ${ch.text})`);
    }
  }
}
console.log(`赌博型选项总数: ${gambleCount}`);
console.log(`其中 preview 为 undefined（选项卡空白）: ${nullCount}`);
console.log("─".repeat(60));
for (const n of nulls) console.log("  " + n);
