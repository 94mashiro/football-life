/** Probe (阶段四): do the new regional ceiling awards — 中超最佳球员 (csl_mvp),
 *  中超金靴 (csl_boot), 亚洲足球先生 (afc_poy) — actually trigger, and at what
 *  career-ever rate? Sanity + rough balance for the award-images supplement.
 *  Run: npx tsx tools/award-rate-probe.ts [N] [setup]
 *    setup: csl  -> CSL + chn (Chinese) — exercises csl_mvp + csl_boot
 *           afc  -> premier-league + jpn (Asian in Europe) — exercises afc_poy
 *  Determinism note: these awards roll on INDEPENDENT derive streams
 *  ("csl-mvp"/"csl-boot"/"afc-poy") and are not counted in priorMajorAwards, so
 *  the global ballon/boot/glove + stats + trophies of every seed are
 *  byte-identical to pre-阶段四 — this probe only measures the NEW awards. */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById } from "../src/engine/data";
import type { GameState, Choice, Award } from "../src/engine/types";

const ALL_PERKS = ["pp_prodigy", "pp_longevity", "pp_legacy_magnet", "pp_iron_will",
  "pp_transfer_savvy", "pp_comeback_base", "pp_oracle_base", "pp_scout", "pp_boss_slayer"];
const SKILLED_BLESSINGS = ["sharpshooter", "glass_cannon", "big_game_player"];

let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function pickChoice(g: GameState, stay: boolean): Choice {
  const ch = g.pendingChoice!.choices;
  if (ch.length === 1) return ch[0]!;
  if (stay) {
    const s = ch.find((c) => c.id === "stay");
    if (s) return s;
  }
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

function drive(g: GameState): GameState {
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
    if (g.pendingChoice) {
      const ch = g.pendingChoice.choices;
      const pick = ch.length > 1 ? pickChoice(g, stayHome) : ch[0]!;
      g = resolveChoice(g, pick);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else g = simulatePeriod(g);
  }
  return g;
}

const N = Number(process.argv[2] ?? 300);
const setupName = String(process.argv[3] ?? "csl");
const stayHome = process.argv[4] === "stay";

const SETUPS: Record<string, { nation: string; league: string; pos: RunSetup["position"]; label: string }> = {
  csl: { nation: "chn", league: "csl", pos: "ST", label: "中超 / 中国 / ST" },
  afc: { nation: "jpn", league: "premier-league", pos: "ST", label: "英超 / 日本 / ST" },
};
const cfg = SETUPS[setupName] ?? SETUPS.csl!;

const NEW: Award[] = ["csl_mvp", "csl_boot", "afc_poy"];
const won: Record<string, number> = { csl_mvp: 0, csl_boot: 0, afc_poy: 0 };
const total: Record<string, number> = { csl_mvp: 0, csl_boot: 0, afc_poy: 0 };
let peakSum = 0, peakMax = 0;

for (let i = 0; i < N; i++) {
  const seed = `awardrate-${setupName}-${i}-${hash32(`awardrate-${setupName}-${i}`)}`;
  _s = 0x9e3779b9 ^ hash32(seed);
  const setup: RunSetup = { seed, nationalityId: cfg.nation, position: cfg.pos, leagueId: cfg.league,
    blessings: SKILLED_BLESSINGS, ascension: 0, pace: "normal", allowWonderkid: true, permPerks: ALL_PERKS };
  let g = drive(simulatePeriod(createRun(setup)));
  peakSum += g.maxOverall; peakMax = Math.max(peakMax, g.maxOverall);
  for (const a of NEW) {
    const c = g.awards.filter((x) => x === a).length;
    if (c > 0) won[a]!++;
    total[a]! += c;
  }
}

console.log(`# award-rate-probe · N=${N} · ${cfg.label}${stayHome ? " · STAY-HOME" : ""}`);
console.log(`peak OVR: avg ${(peakSum / N).toFixed(1)} · max ${peakMax}`);
for (const a of NEW) {
  console.log(`${a}: winners ${won[a]} (${Math.round((won[a]! / N) * 100)}%) · total ${total[a]} (avg ${(total[a]! / N).toFixed(2)} per career)`);
}
