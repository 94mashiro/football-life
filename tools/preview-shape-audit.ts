/**
 * 预览分组形态审计 —— 共有后果有没有被画成骰子结果、必定区有没有被上限截掉。
 *
 *   npx tsx tools/preview-shape-audit.ts
 *
 * 三条不变量:
 *   1. 同时出现在成功/失败两支的后果必须在必定区（否则必定发生的事被画成掷骰）
 *   2. 必定区不得被 PV_CAP_CERTAIN 截断（截掉一条 = 卡片少说一个后果）
 *   3. 被掏空的骰子簇必须有落点药丸（否则跑马灯无处停、且读成「什么都不发生」）
 */
import { EVENT_DEFS, optionOdds, type EventContext } from "../src/engine/events";
import { CLUBS, LEAGUES, NATIONS } from "../src/engine/data";
import { derive } from "../src/engine/rng";
import { isNeutralPreview, type Player, type ChoicePreview } from "../src/engine/types";

function ctx(age: number, overall: number): EventContext {
  const club = CLUBS.find((c) => c.id === "man-city") ?? CLUBS[0]!;
  const league = LEAGUES.find((l) => l.id === club.leagueId) ?? LEAGUES[0]!;
  const player = {
    id: "probe", name: "探针", nationalityId: NATIONS[0]!.id, position: "ST",
    age, overall, potential: 92, clubId: club.id, retired: false, squadNumber: 9,
  } as unknown as Player;
  return {
    player, club, league, seed: "shape-audit", age, role: "starter",
    periodIndex: age - 16, rngState: derive("shape-audit", "ctx"), blessings: [],
    injuriesTaken: 1, ascension: 0, statusTags: [],
  };
}

const k = (p: ChoicePreview) => `${p.label}|${p.good}`;
let bothBranch = 0, truncated = 0, emptyCluster = 0, hoisted = 0, scanned = 0;
const issues: string[] = [];

for (const age of [19, 24, 30, 34]) {
  for (const ovr of [62, 78, 90]) {
    const c = ctx(age, ovr);
    for (const def of EVENT_DEFS) {
      let fired;
      try { fired = def.build(c); } catch { continue; }
      for (const ch of fired.event.choices) {
        if (optionOdds(def.key, ch.id, c) === undefined || !ch.roll) continue;
        scanned++;
        const id = `${def.key}:${ch.id}`;
        const winK = new Set(ch.roll.win.map(k));
        const dup = ch.roll.lose.filter((p) => winK.has(k(p))).map((p) => p.label);
        if (dup.length > 0) { bothBranch++; issues.push(`两支共有却画成骰子: ${id} 「${dup.join("/")}」`); }
        if ((ch.certain?.length ?? 0) >= 3) { truncated++; issues.push(`必定区达上限(可能被截): ${id} ${ch.certain!.length} 条`); }
        if ((ch.certain?.length ?? 0) > 0) hoisted++;
        for (const [side, pills] of [["成功", ch.roll.win], ["失败", ch.roll.lose]] as const) {
          if (pills.length === 0) { emptyCluster++; issues.push(`空簇无落点: ${id} ${side}`); }
          else if (pills.length === 1 && isNeutralPreview(pills[0]!.label)) { /* 正是设计的落点 */ }
        }
      }
    }
  }
}

console.log(`扫描 ${scanned} 个赌注选项(4 年龄 × 3 能力档)`);
console.log(`  有必定区的: ${hoisted}`);
console.log(`  ✗ 共有后果被画成骰子: ${bothBranch}`);
console.log(`  ✗ 空簇无落点: ${emptyCluster}`);
console.log(`  ⚠ 必定区触顶(PV_CAP_CERTAIN=3): ${truncated}`);
const seen = new Set<string>();
for (const s of issues) { if (!seen.has(s)) { seen.add(s); console.log(`    ${s}`); } }
const fail = bothBranch + emptyCluster;
console.log(fail === 0 ? "\nPASS" : `\nFAIL (${fail})`);
if (fail > 0) process.exitCode = 1;
