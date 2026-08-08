/** Probe: of careers that won Ballon d'Or, what was their peak OVR and did
 *  they win the league/continental in a ballon-winning season? Diagnoses which
 *  awardBaseProb tier drives the endgame rate. */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const ALL_PERKS = ["pp_prodigy", "pp_longevity", "pp_legacy_magnet", "pp_iron_will",
  "pp_transfer_savvy", "pp_comeback_base", "pp_oracle_base", "pp_scout", "pp_boss_slayer"];
const SKILLED_BLESSINGS = ["sharpshooter", "glass_cannon", "big_game_player"];

let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function pickChoice(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  if (ch.length === 1) return ch[0]!;
  const key = g.pendingChoice!.key;
  if (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer") {
    const stayStars = (() => { try { const r = clubById(g.currentClubId).rep; return r >= 8 ? 5 : r >= 6 ? 4 : r >= 4 ? 3 : r >= 2 ? 2 : 1; } catch { return 0; } })();
    const stars = (c: Choice) => c.id === "stay" ? stayStars : (c.sub ?? "").split("★").length - 1;
    let best = 0, bs = -1;
    for (let i = 0; i < ch.length; i++) { const s = stars(ch[i]!); if (s > bs) { bs = s; best = i; } }
    return ch[best]!;
  }
  return ch[rint(0, ch.length - 1)]!;
}

const N = Number(process.argv[2] ?? 400);
const nation = String(process.argv[3] ?? "eng");
const league = String(process.argv[5] ?? "premier-league");
const pos = String(process.argv[4] ?? "ST") as RunSetup["position"];

const peakBuckets: Record<string, number> = { "82-89": 0, "90-93": 0, "94-96": 0, "97+": 0 };
const trophyState: Record<string, number> = { "leagueOnly": 0, "contOnly": 0, "both": 0, "neither": 0 };
let totalBallon = 0;

for (let i = 0; i < N; i++) {
  const seed = `ballonprobe-${i}-${hash32(`ballonprobe-${i}`)}`;
  _s = 0x9e3779b9 ^ hash32(seed);
  const setup: RunSetup = { seed, nationalityId: nation, position: pos, leagueId: league,
    blessings: SKILLED_BLESSINGS, ascension: 0, pace: "normal", allowWonderkid: true, permPerks: ALL_PERKS };
  let g: GameState = simulatePeriod(createRun(setup));

  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const ch = g.pendingChoice.choices;
      const pick = ch.length > 1 ? pickChoice(g) : ch[0]!;
      g = resolveChoice(g, pick);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else g = simulatePeriod(g);
  }
  if (g.awards.includes("ballon_dor")) {
    totalBallon++;
    const p = g.maxOverall;
    const b = p < 90 ? "82-89" : p < 94 ? "90-93" : p < 97 ? "94-96" : "97+";
    peakBuckets[b]!++;
    // find a ballon-winning season's trophy state
    const ws = g.seasons.find((s) => s.awards.includes("ballon_dor"));
    if (ws) {
      const wl = ws.trophies.includes("league");
      const wc = ws.trophies.includes("continental_primary") || ws.trophies.includes("world_cup") || ws.trophies.includes("national_continental");
      const k = wl && wc ? "both" : wl ? "leagueOnly" : wc ? "contOnly" : "neither";
      trophyState[k]!++;
    }
  }
}
console.log(`# ballon-probe · N=${N} · ${nation}/${pos}/${league} · ballon winners ${totalBallon} (${Math.round(totalBallon/N*100)}%)`);
console.log(`peak OVR of winners: 82-89 ${peakBuckets["82-89"]} · 90-93 ${peakBuckets["90-93"]} · 94-96 ${peakBuckets["94-96"]} · 97+ ${peakBuckets["97+"]}`);
console.log(`trophy state in a ballon-winning season: leagueOnly ${trophyState["leagueOnly"]} · contOnly ${trophyState["contOnly"]} · both ${trophyState["both"]} · neither ${trophyState["neither"]}`);
