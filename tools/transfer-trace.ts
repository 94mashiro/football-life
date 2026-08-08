/**
 * 单生涯转会窗追踪 — 逐决策打印 key + 队列尾，验证「转会通道(T)与特殊事件
 * 通道(S)并存」的新模型：黄金期每个节奏点都弹转会，特殊事件与之排队共存，
 * 互不挤兑。Run: npx tsx tools/transfer-trace.ts [seed]
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
let coexisted = 0;   // 转会与特殊事件同 period 并存的次数
while (g.phase === "playing" && guard++ < 400) {
  if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
  const age = g.age;
  const periodLen = g.periodLength ?? 2;
  const seasonAges: number[] = [];
  for (let a = age - periodLen; a < age; a++) seasonAges.push(a);
  const windowDue = seasonAges.some(isWindowAge);
  const club = clubById(g.currentClubId);
  const tail = (g.pendingChoices ?? []).map((e) => e.key);
  if (g.pendingChoice) {
    const key = g.pendingChoice.key;
    const isWin = key === "transfer" || key === "wage_squeeze";
    if (isWin) windowCount[key as "transfer" | "wage_squeeze"]++;
    if (isWin && tail.length > 0) coexisted++;
    const wd = windowDue ? " [窗年到期]" : "";
    const queue = tail.length > 0 ? ` 队列=[${tail.join(",")}]` : "";
    console.log(`决策 age=${age} 俱乐部=${club.name}(rep${club.rep}) key=${key}${wd}${queue} ${isWin ? "✓转会" : ""}`);
    g = resolveChoice(g, pickStay(g));
    if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
  } else {
    console.log(`静默 age=${age} 俱乐部=${club.name}(rep${club.rep})${windowDue ? " [窗年却无转会?]" : ""}`);
    g = simulatePeriod(g);
  }
}
console.log(`\n结束 age=${g.age} 退役=${g.retirementReason} 赛季=${g.seasons.length}`);
console.log(`转会决策: ${windowCount.transfer} transfer + ${windowCount.wage_squeeze} wage_squeeze = ${windowCount.transfer + windowCount.wage_squeeze}`);
console.log(`转会与特殊事件并存次数: ${coexisted}`);
console.log(`俱乐部数: ${new Set(g.seasons.map((s) => s.clubId)).size}`);
