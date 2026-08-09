/**
 * 租借 bug 批量审计 v2 — 用引擎 g.activeLoan 作为租借状态的唯一真相源。
 *  (A) 接受租借后「租借期间出现转会类决策」的次数 (bug1: 租借被转会劫持)
 *  (B) 每次「接受租借」对应 post_loan 触发次数 (bug2: 应=1; >1 即重复)
 *  (C) 单次租借在租借队效力的赛季数 (bug3: 应=1)
 * Run: npx tsx tools/loan-audit.ts [N=40]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";

import type { GameState, Choice } from "../src/engine/types";

const N = Number(process.argv[2] ?? 40);
const setup = (seed: string): RunSetup => ({
  seed, nationalityId: "eng", position: "ST", leagueId: "premier-league",
  clubId: "chelsea", pace: "normal", ascension: 0, blessings: [],
  allowWonderkid: false, permPerks: [],
});

function pickAcceptLoan(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  const loan = ch.find((c) => c.kind === "join_loan");
  if (loan) return loan;
  const stay = ch.find((c) => c.kind === "stay" || c.id === "stay");
  if (stay) return stay;
  return ch[0]!;
}

let totalLoans = 0;
let totalPostLoan = 0;
let totalTransferDuringLoan = 0;
let totalLoanSeasons = 0;
let careersWithHijack = 0;

for (let i = 0; i < N; i++) {
  let g = simulatePeriod(createRun(setup(`loan-audit-${i}`)));
  let guard = 0;
  let loansThisCareer = 0;
  let postLoanThisCareer = 0;
  let hijackThisCareer = false;
  let loanClubId: string | null = null;
  let loanStartSeasonIdx = -1;
  let loanSeasonsThisLoan = 0;

  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    // count a season at the loan club when activeLoan just applied
    if (g.activeLoan && g.seasons.length > 0) {
      const last = g.seasons[g.seasons.length - 1]!;
      if (last.clubId === g.activeLoan.loanClubId) loanSeasonsThisLoan++;
    }
    if (g.pendingChoice) {
      const key = g.pendingChoice.key;
      const onLoan = !!g.activeLoan;
      // bug1: a club-MOVE decision (new_club/permanent_transfer option, or a transfer window)
      // firing while on loan = the loan can be hijacked into a transfer
      if (onLoan && key !== "post_loan" && g.pendingChoice.choices.some((c) => c.kind === "new_club" || c.kind === "permanent_transfer")) {
        totalTransferDuringLoan++;
        hijackThisCareer = true;
      }
      if (key === "loan_offer") {
        const choice = pickAcceptLoan(g);
        if (choice.kind === "join_loan") {
          loansThisCareer++;
          totalLoans++;
          loanStartSeasonIdx = g.seasons.length;
          loanSeasonsThisLoan = 0;
          const resolved = g.pendingResolve!(choice, { s: 0 } as any, g.seed);
          loanClubId = resolved.mods.loanOutTo ?? null;
        }
        g = resolveChoice(g, choice);
      } else if (key === "post_loan") {
        postLoanThisCareer++;
        totalPostLoan++;
        // pick stay to isolate post_loan REPEAT behavior (not re-loan)
        const stay = g.pendingChoice.choices.find((c) => c.kind === "stay" || c.id === "stay");
        g = resolveChoice(g, stay ?? g.pendingChoice.choices[0]!);
      } else {
        // non-loan, non-post-loan decision while on loan: pick stay (don't hijack)
        const stay = g.pendingChoice.choices.find((c) => c.kind === "stay" || c.id === "stay");
        g = resolveChoice(g, stay ?? pickAcceptLoan(g));
      }
      // when the loan returns (completedLoan set + activeLoan cleared), bank the
      // contiguous loan-club seasons from the accept point (1 season = bug3 fixed)
      if (loanClubId && g.completedLoan && !g.activeLoan) {
        let n = 0;
        for (let k = loanStartSeasonIdx; k < g.seasons.length; k++) {
          if (g.seasons[k]!.clubId === loanClubId) n++;
          else break;
        }
        totalLoanSeasons += n;
        loanClubId = null;
      }
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  if (hijackThisCareer) careersWithHijack++;
  if (i < 3) console.log(`  [seed${i}] loans=${loansThisCareer} postLoans=${postLoanThisCareer} (repeat=${postLoanThisCareer - loansThisCareer})`);
}

console.log(`# loan audit v2 · N=${N} careers · Chelsea academy · normal pace`);
console.log(`接受租借总次数: ${totalLoans} (平均 ${totalLoans / N} 次/生涯)`);
console.log(`post_loan 触发总次数: ${totalPostLoan} (平均 ${totalPostLoan / N} 次/生涯)`);
console.log(`  → 每次「接受租借」对应 post_loan 次数: ${totalLoans > 0 ? (totalPostLoan / totalLoans).toFixed(2) : 0} (应=1; >1 即 bug2 重复)`);
console.log(`租借期间出现转会类决策: ${totalTransferDuringLoan} 次 (bug1; 应=0)`);
console.log(`  → 出现劫持的生涯: ${careersWithHijack}/${N} (${Math.round(careersWithHijack / N * 100)}%)`);
console.log(`单次租借在租借队效力赛季数(平均): ${totalLoans > 0 ? (totalLoanSeasons / totalLoans).toFixed(2) : 0} (应=1; bug3)`);
