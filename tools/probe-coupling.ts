/**
 * Coupling probe: 评分→强制离队 + 总评→转会爬升.
 * Measures (1) forced-exit fire age for academy starts, (2) whether a player
 * who is forced DOWN ever climbs back to a higher rep via the transfer window.
 * Run: npx tsx tools/probe-coupling.ts [N=200] [league=premier-league]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const N = Number(process.argv[2] ?? 200);
const LEAGUE = String(process.argv[3] ?? "premier-league");

let forcedAt18 = 0, forcedAnyCareer = 0;
const firstForcedAge: number[] = [];
let climbedBack = 0, droppedCount = 0;
const peakOvrClimbed: number[] = [];
const peakOvrStuck: number[] = [];

function hash32(s: string){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}

// smart_climb: take the highest-rep STARTER offer; else stay. (optimal play)
function pickClimb(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  if (ch.length === 1) return ch[0]!;
  const key = g.pendingChoice!.key;
  if (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer") {
    const clubs = ch.filter(c => (c.kind === "new_club" || c.kind === "permanent_transfer") && (c.sub ?? "").includes("主力"));
    if (clubs.length) {
      const star = (c: Choice) => (c.sub ?? "").split("★").length - 1;
      return clubs.reduce((b, c) => star(c) > star(b) ? c : b, clubs[0]!);
    }
    const stay = ch.find(c => c.kind === "stay" || c.id === "stay");
    if (stay) return stay;
  }
  const b = ch.find(c => c.id === "b"); if (b) return b;
  return ch[0]!;
}

for (let i = 0; i < N; i++) {
  const seed = `cp-${i}-${hash32("cp" + i)}`;
  const setup: RunSetup = { seed, nationalityId: "bra", position: "ST", leagueId: LEAGUE, pace: "normal", ascension: 0, blessings: [], permPerks: [] };
  let g = simulatePeriod(createRun(setup));
  let droppedCount = 0; let didForced = false; let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const key = g.pendingChoice.key;
      if ((key === "stuck_release" || key === "underperform_release") && !didForced) {
        didForced = true;
        firstForcedAge.push(g.age);
        if (g.age === 18) forcedAt18++;
      }
      g = resolveChoice(g, pickClimb(g));
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  if (didForced) {
    forcedAnyCareer++;
    // the dropped-to rep = the club rep in the first season AFTER the forced exit
    // find the min rep reached after the forced exit, and the max rep reached later
    let minRepAfter = 10, maxRepAfter = -1;
    for (const s of g.seasons) {
      const r = clubById(s.clubId).rep;
      if (r < minRepAfter) minRepAfter = r;
    }
    // max rep across whole career
    for (const s of g.seasons) {
      const r = clubById(s.clubId).rep;
      if (r > maxRepAfter) maxRepAfter = r;
    }
    droppedCount++;
    // "climbed back" = reached a rep strictly higher than the min (the drop floor) by >=2
    if (maxRepAfter >= minRepAfter + 2) { climbedBack++; peakOvrClimbed.push(g.maxOverall); }
    else peakOvrStuck.push(g.maxOverall);
  }
}

const med = (a: number[]) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
console.log(`# coupling probe · N=${N} · ${LEAGUE} · smart_climb strategy`);
console.log(`careers with a forced-exit: ${forcedAnyCareer}/${N} (${Math.round(forcedAnyCareer / N * 100)}%)`);
console.log(`first forced-exit at age 18: ${forcedAt18}/${forcedAnyCareer || 1} (${Math.round(forcedAt18 / (forcedAnyCareer || 1) * 100)}% of forced)`);
console.log(`first forced-exit age median: ${med(firstForcedAge)}`);
console.log(`of forced careers, climbed back (+2 rep above the floor): ${climbedBack}/${droppedCount} (${Math.round(climbedBack / (droppedCount || 1) * 100)}%)`);
console.log(`  peak OVR — climbed back: med=${med(peakOvrClimbed)} | stuck low: med=${med(peakOvrStuck)}`);
