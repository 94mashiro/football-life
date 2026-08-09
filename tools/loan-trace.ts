/**
 * 租借链路追踪 — 确认 bug：接受租借后，球员是否真回到母队，还是被「转会窗」
 * 在租借期间劫持（accepting a transfer sets newClubId → activeLoan 被清空、
 * 永不归队）。Run: npx tsx tools/loan-trace.ts [seed]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const seed = process.argv[2] ?? "loan-trace-1";
// Start at a BIG academy (Chelsea rep 8) so the youngster is benched → loan fires.
const setup: RunSetup = {
  seed, nationalityId: "eng", position: "ST", leagueId: "premier-league",
  clubId: "chelsea", pace: "normal", ascension: 0, blessings: [],
  allowWonderkid: false, permPerks: [],
};

function pickAcceptLoan(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  // prefer a join_loan choice (accept the loan)
  const loan = ch.find((c) => c.kind === "join_loan");
  if (loan) return loan;
  // otherwise prefer stay (to keep tracing, not abandon the club)
  const stay = ch.find((c) => c.kind === "stay" || c.id === "stay");
  if (stay) return stay;
  return ch[0]!;
}

let g = simulatePeriod(createRun(setup));
let guard = 0;
let loanAcceptedAt: number | null = null;
let loanParent: string | null = null;
let loanClub: string | null = null;
let loanReturnAge: number | null = null;
let returnedToParent = false;
let hijackedByTransfer = false;
let loansAccepted = 0;
const trace: string[] = [];

while (g.phase === "playing" && guard++ < 400) {
  if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
  const age = g.age;
  const club = clubById(g.currentClubId);
  const activeLoan = g.activeLoan;
  const alStr = activeLoan ? ` [租借中: ${clubById(activeLoan.parentClubId).name}→${clubById(activeLoan.loanClubId).name} 归队@${activeLoan.returnAge}]` : "";
  if (g.pendingChoice) {
    const key = g.pendingChoice.key;
    const title = g.pendingChoice.title;
    const choiceKinds = g.pendingChoice.choices.map((c) => c.kind).join("|");
    trace.push(`age=${age} 俱乐部=${club.name}(rep${club.rep}) 决策=${key}(${title})${alStr} 选项=[${choiceKinds}]`);
    if (key === "loan_offer") {
      loanAcceptedAt = age;
      loanParent = g.currentClubId;
      loansAccepted++;
      const choice = pickAcceptLoan(g);
      if (choice.kind === "join_loan") {
        const resolved = g.pendingResolve!(choice, { s: 0 } as any, g.seed);
        loanClub = resolved.mods.loanOutTo ?? null;
        loanReturnAge = resolved.mods.loanReturnAge ?? null;
      }
      g = resolveChoice(g, choice);
    } else if (key === "post_loan") {
      trace.push(`  >>> 租借归来决策触发 (母队=${loanParent ? clubById(loanParent).name : "?"})`);
      returnedToParent = true;
      // pick stay at parent (return) to keep it simple
      const stay = g.pendingChoice.choices.find((c) => c.kind === "stay" || c.id === "stay");
      g = resolveChoice(g, stay ?? g.pendingChoice.choices[0]!);
    } else {
      // any other decision while a loan is active = potential hijack
      if (activeLoan) {
        trace.push(`  !!! 租借期间出现非租借决策 (${key}) — 租借被劫持风险`);
        const choice = pickAcceptLoan(g);
        const resolved = g.pendingResolve!(choice, { s: 0 } as any, g.seed);
        if (resolved.mods.newClubId) {
          hijackedByTransfer = true;
          trace.push(`  !!! 该选项设 newClubId=${resolved.mods.newClubId} → 租借将被清空、永不归队`);
        }
        g = resolveChoice(g, choice);
      } else {
        const stay = g.pendingChoice.choices.find((c) => c.kind === "stay" || c.id === "stay");
        g = resolveChoice(g, stay ?? g.pendingChoice.choices[0]!);
      }
    }
    if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
  } else {
    g = simulatePeriod(g);
  }
}

console.log(trace.join("\n"));
console.log("\n=== 总结 ===");
console.log(`接受租借次数: ${loansAccepted}`);
console.log(`租借接受时 age: ${loanAcceptedAt}, 母队: ${loanParent ? clubById(loanParent).name : "-"}, 租借队: ${loanClub ? clubById(loanClub).name : "-"}, 归队age: ${loanReturnAge}`);
console.log(`是否触发 post_loan(真归队): ${returnedToParent}`);
console.log(`是否被转会劫持(租借期间出现 newClubId 决策): ${hijackedByTransfer}`);
console.log(`生涯俱乐部数: ${new Set(g.seasons.map((s) => s.clubId)).size}`);
console.log(`生涯俱乐部序列: ${g.seasons.map((s) => `${s.age}:${s.clubName}`).join(" → ")}`);
