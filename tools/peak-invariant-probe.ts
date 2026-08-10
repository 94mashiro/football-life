// 巅峰不变量探针: maxOverall 必须 == max(各赛季 overall, 当前 overall)
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { randomSeed } from "../src/meta/legacy";
import type { GameState, Choice } from "../src/engine/types";

let _s = 0x9e3779b9;
function rnext() { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));

const N = Number(process.argv[2] ?? 300);
const ASC = Number(process.argv[3] ?? 5);
let bad = 0;

function trueMax(g: GameState) {
  let m = 0;
  for (const s of g.seasons) m = Math.max(m, s.overall);
  return Math.max(m, g.player!.overall);
}

for (let i = 0; i < N && bad < 5; i++) {
  const seed = randomSeed();
  _s = 0x9e3779b9 ^ (i * 2654435761);
  const rs: RunSetup = { seed, nationalityId: "fra", position: "ST", leagueId: "ligue-1", blessings: [], ascension: ASC, pace: "normal" };
  let g: GameState = simulatePeriod(createRun(rs));
  let guard = 0;
  let last = "start";
  let prevMods: unknown = {};
  while (g.phase === "playing" && guard++ < 400) {
    if (g.maxOverall > trueMax(g)) {
      console.log(`VIOLATION seed=${seed} after=${last} age=${g.player!.age} max=${g.maxOverall} true=${trueMax(g)} cur=${g.player!.overall} seasons=${g.seasons.map(s => s.overall).join(",")}`);
      console.log(`  appliedMods=${JSON.stringify(prevMods)}`);
      bad++;
      break;
    }
    if (g.pendingChoice) {
      const ch = g.pendingChoice.choices;
      const pick: Choice = ch.length > 1 ? ch[rint(0, ch.length - 1)]! : ch[0]!;
      last = `choose ${g.pendingChoice!.key}/${pick.id}`;
      g = resolveChoice(g, pick);
      if (g.phase === "playing" && !g.pendingChoice) { last += " +sim"; prevMods = g.pendingMods; g = simulatePeriod(g); }
    } else { last = "sim"; prevMods = g.pendingMods; g = simulatePeriod(g); }
  }
}
console.log(bad === 0 ? `OK: ${N} careers, no violation (asc=${ASC})` : `${bad} violations`);
