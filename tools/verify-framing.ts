/** Verify the age-aware forced-exit framing: a young (≤20) player forced out
 *  gets the development-move title, not the harsh washout. Run a few careers to
 *  the first forced exit, print age + title. */
import { createRun, simulatePeriod, type RunSetup } from "../src/engine/run";

function hash32(s: string){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}

let youth = 0, vet = 0;
const samples: string[] = [];
for (let i = 0; i < 300; i++) {
  const seed = `fr-${i}-${hash32("fr" + i)}`;
  const setup: RunSetup = { seed, nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal", ascension: 0, blessings: [], permPerks: [] };
  let g = simulatePeriod(createRun(setup));
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const key = g.pendingChoice.key;
      if (key === "stuck_release" || key === "underperform_release") {
        const age = g.age;
        const title = g.pendingChoice.title;
        if (age <= 20) youth++; else vet++;
        if (samples.length < 6) samples.push(`age=${age} key=${key} title="${title}"`);
        break; // first forced exit only
      }
      g = { ...g, pendingChoice: null, pendingResolve: undefined };
      g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
}
console.log(`forced-exit fires: youth(≤20)=${youth} vet(>20)=${vet}`);
console.log(`samples:`);
for (const s of samples) console.log(`  ${s}`);
