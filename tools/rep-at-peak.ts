/** Probe: what club rep do endgame careers peak at, per starting league?
 *  Diagnoses whether BRA/ESP endgame median 92 (vs EPL 93) is a transfer-ladder
 *  issue (can't reliably reach rep9) or a growth issue. */
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

const peaks: number[] = [];
const peakReps: number[] = [];       // club rep AT the peak-OVR season
const finalReps: number[] = [];
const maxRepEver: number[] = [];      // highest club rep ever reached
const repBuckets: Record<string, number> = { "rep5-": 0, "rep6": 0, "rep7": 0, "rep8": 0, "rep9": 0 };

for (let i = 0; i < N; i++) {
  const seed = `peak-${i}-${hash32(`peak-${i}`)}`;
  _s = 0x9e3779b9 ^ hash32(seed);
  const setup: RunSetup = { seed, nationalityId: nation, position: pos, leagueId: league,
    blessings: SKILLED_BLESSINGS, ascension: 0, pace: "normal", allowWonderkid: true, permPerks: ALL_PERKS };
  let g: GameState = simulatePeriod(createRun(setup));
  let peakOvr = g.maxOverall;
  let peakRep = clubById(g.currentClubId).rep;
  let maxRep = peakRep;
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const ch = g.pendingChoice.choices;
      const pick = ch.length > 1 ? pickChoice(g) : ch[0]!;
      g = resolveChoice(g, pick);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else g = simulatePeriod(g);
    const cr = clubById(g.currentClubId).rep;
    if (cr > maxRep) maxRep = cr;
    if (g.maxOverall > peakOvr) { peakOvr = g.maxOverall; peakRep = cr; }
  }
  peaks.push(peakOvr); peakReps.push(peakRep); finalReps.push(clubById(g.currentClubId).rep); maxRepEver.push(maxRep);
  const b = maxRep <= 5 ? "rep5-" : maxRep === 6 ? "rep6" : maxRep === 7 ? "rep7" : maxRep === 8 ? "rep8" : "rep9";
  repBuckets[b]!++;
}

const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
console.log(`# rep-at-peak · N=${N} · ${nation}/${pos}/${league}`);
console.log(`peak OVR: median ${pct(peaks,0.5)} · p90 ${pct(peaks,0.9)}`);
console.log(`max club rep ever: ${Object.entries(repBuckets).map(([k,v])=>`${k}:${v}(${Math.round(v/N*100)}%)`).join(" · ")}`);
console.log(`rep AT peak-OVR season: median ${pct(peakReps,0.5)} · p10 ${pct(peakReps,0.1)} · p90 ${pct(peakReps,0.9)}`);
console.log(`final club rep: median ${pct(finalReps,0.5)} · p10 ${pct(finalReps,0.1)} · p90 ${pct(finalReps,0.9)}`);
