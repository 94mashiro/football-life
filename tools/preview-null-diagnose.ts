/**
 * 空白预览分支诊断 — 对每个 preview 为 undefined 的赌博型选项，分别打印成功/
 * 失败分支（forced positive/negative）的 mods 与 previewLabel 标签，定位空白根因：
 *   - 成功分支净 OVR=0 且只设未建模标签 → 该分支 null
 *   - 两分支可见效果完全相同 → 被 optionPreview 去重
 *   - 某分支纯空 mods → resolve 遗漏（需补数值后果）
 * 配合 preview-null-audit（列出空白清单）使用。
 *
 * Run:  npx tsx tools/preview-null-diagnose.ts
 */
import { EVENT_DEFS, optionOdds, resolveEventOption, type EventContext } from "../src/engine/events";
import { CLUBS, LEAGUES, NATIONS } from "../src/engine/data";
import { derive } from "../src/engine/rng";
import type { Player, ResolveResult } from "../src/engine/types";

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

function dump(r: ResolveResult): string {
  const m = r.mods;
  const parts: string[] = [];
  if (m.immediateOverallDelta) parts.push(`imm${m.immediateOverallDelta}`);
  if (m.permanentOverallDelta) parts.push(`perm${m.permanentOverallDelta}`);
  if (m.deferredOverallDelta) parts.push(`def${m.deferredOverallDelta}`);
  if (m.forceRetire) parts.push("生涯终结");
  if (r.injury) parts.push(r.severe ? "重伤" : "伤病");
  if (m.suspended) parts.push("停赛");
  if (m.roleOverride) parts.push("roleOverride=" + m.roleOverride);
  else if (m.roleShift) parts.push("roleShift" + m.roleShift);
  if (m.addTags?.length) parts.push("tags[" + m.addTags.map((t) => t.split("@")[0]).join(",") + "]");
  if (m.newClubId) parts.push("newClub=" + m.newClubId);
  if (m.newNationalityId) parts.push("newNation=" + m.newNationalityId);
  for (const f of ["leagueTrophyProbabilityMultiplier", "domesticCupTrophyProbabilityMultiplier", "continentalPrimaryTrophyProbabilityMultiplier", "continentalSecondaryTrophyProbabilityMultiplier"] as const) {
    const v = (m as Record<string, number | undefined>)[f];
    if (v !== undefined && v !== 1) parts.push(f + "=×" + v);
  }
  return parts.length ? parts.join(" | ") : "(空 mods)";
}

const c = ctx();
for (const def of EVENT_DEFS) {
  let fired;
  try { fired = def.build(c); } catch { continue; }
  for (const ch of fired.event.choices) {
    if (optionOdds(def.key, ch.id, c) === undefined) continue;
    if ((ch.certain?.length ?? 0) > 0 || ch.roll !== undefined) continue;
    const wp = resolveEventOption(derive("preview:d", def.key, ch.id), def.key, ch.id, c, "positive");
    const lp = resolveEventOption(derive("preview:d", def.key, ch.id), def.key, ch.id, c, "negative");
    console.log(`■ ${def.key}:${ch.id}  (${ch.text})`);
    console.log(`  成功: ${dump(wp)}`);
    console.log(`  失败: ${dump(lp)}`);
  }
}
