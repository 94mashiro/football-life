import { createRun, simulatePeriod, resolveChoice, legacyEarnMult, type RunSetup } from "../src/engine/run";
import { scoreLegacy, randomSeed } from "../src/meta/legacy";
import { clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

// Full prestige endgame: 9 perks + 3 blessings + wonderkid, skilled transfer-up.
// Reproduces the memory-flagged "终局段偏陡" (OVR median 99, Ballon d'Or 63%).
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

const N = Number(process.argv[2] ?? 200);
const nation = String(process.argv[3] ?? "bra");
const pos = String(process.argv[4] ?? "ST") as RunSetup["position"];
const league = String(process.argv[5] ?? "brasileirao");

const peaks: number[] = [], legs: number[] = [];
let wc = 0, ballon = 0, ge90 = 0, ge95 = 0;
const reasonMix: Record<string, number> = {};

for (let i = 0; i < N; i++) {
  const seed = randomSeed();
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
  const wageTotal = g.seasons.reduce((s, x) => s + (x.wage ?? 0), 0);
  const finalMv = g.seasons.length > 0 ? (g.seasons[g.seasons.length - 1]!.marketValue ?? 0) : 0;
  const legacy = scoreLegacy(g.maxOverall, g.seasons.length, g.trophies, g.awards, g.ascension, g.retirementReason, g.challenge, wageTotal, finalMv, g.eventLegacy ?? 0, legacyEarnMult(g.blessings ?? [], g.permPerks ?? []), 1);
  peaks.push(g.maxOverall); legs.push(legacy);
  if (g.trophies.includes("world_cup")) wc++;
  if (g.awards.includes("ballon_dor")) ballon++;
  if (g.maxOverall >= 90) ge90++;
  if (g.maxOverall >= 95) ge95++;
  reasonMix[g.retirementReason ?? "?"] = (reasonMix[g.retirementReason ?? "?"] ?? 0) + 1;
}

const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
console.log(`# prestige endgame · N=${N} · ${nation}/${pos}/${league} · 9 perks + 3 blessings + wonderkid`);
console.log(`peak OVR: median ${pct(peaks, 0.5)} · p10 ${pct(peaks, 0.1)} · p90 ${pct(peaks, 0.9)} · ≥90 ${Math.round(ge90 / N * 100)}% · ≥95 ${Math.round(ge95 / N * 100)}%`);
console.log(`ballon_dor: ${Math.round(ballon / N * 100)}% · world_cup: ${Math.round(wc / N * 100)}%`);
console.log(`legacy: median ${pct(legs, 0.5)} · p10 ${pct(legs, 0.1)} · p90 ${pct(legs, 0.9)}`);
console.log(`retire: ${Object.entries(reasonMix).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}(${Math.round(v / N * 100)}%)`).join(" · ")}`);
