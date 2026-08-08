/**
 * 单生涯转会窗追踪 — 逐决策打印 key + 是否窗年,定位「谁吃掉了转会窗」。
 * Run: npx tsx tools/transfer-trace.ts [seed]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const seed = process.argv[2] ?? "smoke-3-3893829382";
const setup: RunSetup = {
  seed, nationalityId: "bra", position: "ST", leagueId: "premier-league",
  pace: "normal", ascension: 0, blessings: [], allowWonderkid: false, permPerks: [],
};

const TRANSFER_WINDOW_START_AGE = 19;
const TRANSFER_WINDOW_END_AGE = 31;
function isWindowAge(a: number): boolean {
  return a >= TRANSFER_WINDOW_START_AGE && a <= TRANSFER_WINDOW_END_AGE && (a - TRANSFER_WINDOW_START_AGE) % 2 === 0;
}

function pickStay(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  if (ch.length === 1) return ch[0]!;
  const stay = ch.find((c) => c.kind === "stay" || c.id === "stay");
  if (stay) return stay;
  const clubs = ch.filter((c) => (c.kind === "new_club" || c.kind === "permanent_transfer") && (c.sub ?? "").includes("主力"));
  if (clubs.length) return clubs[0]!;
  return ch[0]!;
}

let g = simulatePeriod(createRun(setup));
let guard = 0;
const windowCount = { transfer: 0, wage_squeeze: 0 };
while (g.phase === "playing" && guard++ < 400) {
  if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
  const age = g.age;
  const periodLen = g.periodLength ?? 2;
  const seasonAges: number[] = [];
  for (let a = age - periodLen; a < age; a++) seasonAges.push(a);
  const windowDue = seasonAges.some(isWindowAge) || (g.transferWindowOwed ?? false);
  const club = clubById(g.currentClubId);
  if (g.pendingChoice) {
    const key = g.pendingChoice.key;
    const isWin = key === "transfer" || key === "wage_squeeze";
    if (isWin) windowCount[key as "transfer" | "wage_squeeze"]++;
    const owed = g.transferWindowOwed ? " [OWED窗]" : "";
    const wd = windowDue ? " [窗年到期]" : "";
    console.log(`决策 age=${age} 季${seasonAges.join(",")} 俱乐部=${club.name}(rep${club.rep}) key=${key}${wd}${owed} ${isWin ? "✓转会窗" : "←吃了窗"}`);
    g = resolveChoice(g, pickStay(g));
    if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
  } else {
    console.log(`静默 age=${age} 季${seasonAges.join(",")} 俱乐部=${club.name}(rep${club.rep})`);
    g = simulatePeriod(g);
  }
}
console.log(`\n结束 age=${g.age} 退役=${g.retirementReason} 赛季=${g.seasons.length}`);
console.log(`转会窗决策: ${windowCount.transfer} transfer + ${windowCount.wage_squeeze} wage_squeeze = ${windowCount.transfer + windowCount.wage_squeeze}`);
console.log(`俱乐部数: ${new Set(g.seasons.map((s) => s.clubId)).size}`);
