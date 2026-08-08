/** Isolate league-start effect from pace effect on 90+ rate. */
import { createRun, simulatePeriod, resolveChoice } from "../src/engine/run";

interface Setup { nationalityId: string; position: string; leagueId: string; pace: "long" | "normal" | "express"; label: string; }
const SETUPS: Setup[] = [
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "long", label: "BRA ST 英超 long" },
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal", label: "BRA ST 英超 normal" },
  { nationalityId: "chn", position: "ST", leagueId: "china-league-one", pace: "long", label: "CHN ST 中甲 long" },
  { nationalityId: "chn", position: "ST", leagueId: "china-league-one", pace: "normal", label: "CHN ST 中甲 normal" },
  { nationalityId: "bra", position: "ST", leagueId: "brasileirao-b", pace: "long", label: "BRA ST 巴乙 long" },
  { nationalityId: "bra", position: "ST", leagueId: "brasileirao-b", pace: "normal", label: "BRA ST 巴乙 normal" },
];
const NCAREERS = 400;

function runOne(seed: string, setup: Setup): { peak: number; } {
  let g = createRun({ seed, nationalityId: setup.nationalityId, position: setup.position as any, leagueId: setup.leagueId, pace: setup.pace, blessings: [], ascension: 0, permPerks: [] });
  g = simulatePeriod(g);
  let guard = 0;
  while (g.phase === "playing" && guard++ < 200) {
    if (g.pendingChoice) {
      const c = g.pendingChoice.choices[0]!;
      g = resolveChoice(g, c);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else g = simulatePeriod(g);
  }
  return { peak: g.maxOverall ?? 0 };
}
function hash(i: number): string { let h = 2166136261 ^ i; h = Math.imul(h, 16777619) >>> 0; return `iso-${i}-${h.toString(36)}`; }

for (const s of SETUPS) {
  let sum = 0; const b = { "<70": 0, "70-79": 0, "80-85": 0, "86-89": 0, "90+": 0 };
  for (let i = 0; i < NCAREERS; i++) { const o = runOne(hash(i), s); sum += o.peak;
    if (o.peak < 70) b["<70"]++; else if (o.peak < 80) b["70-79"]++; else if (o.peak < 86) b["80-85"]++; else if (o.peak < 90) b["86-89"]++; else b["90+"]++;
  }
  console.log(`${s.label.padEnd(24)} avg=${(sum/NCAREERS).toFixed(1)}  <70=${b["<70"]} 70-79=${b["70-79"]} 80-85=${b["80-85"]} 86-89=${b["86-89"]} 90+=${b["90+"]} (${(100*b["90+"]/(NCAREERS)).toFixed(1)}%)  86+=${b["86-89"]+b["90+"]}`);
}
