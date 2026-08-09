/**
 * 旧伤复发 (injury_relapse) 选项预览探针 — 验证修复：
 *   - push_through（再打一针封闭，硬扛到底）：成功分支原 net 0 OVR + 只设
 *     compromised_body 标签 → 预览为 undefined（选项卡空白）。显形 compromised_body
 *     后成功分支应显示「带伤隐患」，与失败分支「-7 OVR」一起带 35%/65% 概率。
 *   - surgery（接受手术）：确定性选项，两条后果（-2 OVR / 伤病）原无概率，
 *     现应都标 100%。
 *
 * Run:  npx tsx tools/injury-relapse-probe.ts
 */
import { EVENT_DEFS, optionOdds, type EventContext } from "../src/engine/events";
import { CLUBS, LEAGUES, NATIONS } from "../src/engine/data";
import { derive } from "../src/engine/rng";
import type { Player } from "../src/engine/types";

function buildCtx(statusTags: readonly string[]): EventContext {
  const club = CLUBS.find((c) => c.id === "man_city") ?? CLUBS[0]!;
  const league = LEAGUES.find((l) => l.id === club.leagueId) ?? LEAGUES[0]!;
  const nation = NATIONS[0]!;
  const player: Player = {
    id: "probe", name: "探针", nationalityId: nation.id, position: "ST",
    age: 28, overall: 82, potential: 90, clubId: club.id, retired: false,
  } as unknown as Player;
  return {
    player, club, league, seed: "probe-seed", age: 28, role: "starter",
    periodIndex: 24, rngState: derive("probe", "ctx"), blessings: [],
    injuriesTaken: 1, ascension: 0, statusTags,
  };
}

function main() {
  const def = EVENT_DEFS.find((d) => d.key === "injury_relapse");
  if (!def) throw new Error("injury_relapse not found in EVENT_DEFS");
  const ctx = buildCtx(["nagging_injury@2"]);
  console.log(`事件: ${def.key} / ${def.title}`);
  const fired = def.build(ctx);
  for (const c of fired.event.choices) {
    const odds = optionOdds(def.key, c.id, ctx);
    console.log("─".repeat(60));
    console.log(`选项 id=${c.id}  text=${c.text}`);
    console.log(`  optionOdds = ${odds === undefined ? "undefined (deterministic → 应标 100%)" : odds}`);
    console.log(`  sub        = ${c.sub === undefined ? "undefined" : JSON.stringify(c.sub)}`);
    console.log(`  preview    = ${c.preview === undefined ? "undefined  ← 仍空白（异常）" : JSON.stringify(c.preview)}`);
  }
  console.log("─".repeat(60));
}

main();
