/** Determinism check (阶段四): the new regional awards must NOT perturb any
 *  existing sim stream. This dumps a per-season fingerprint EXCLUDING the new
 *  awards (csl_mvp/csl_boot/afc_poy) for a fixed seed set + two setups —
 *  eng/premier-league (no new code path) and csl/chn (new code path executes).
 *  Run on master (pre-阶段四) and on the worktree, diff the outputs: identical
 *  ⇒ the global ballon/boot/glove + stats + trophies + growth + national are
 *  byte-identical, so the supplement is determinism-safe. */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById } from "../src/engine/data";
import type { GameState, Choice, Award } from "../src/engine/types";

const NEW: Award[] = ["csl_mvp", "csl_boot", "afc_poy"];
const isOld = (a: Award) => !NEW.includes(a);

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

function drive(g: GameState): GameState {
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
  return g;
}

function fp(g: GameState): string {
  const tot = g.seasons.reduce((a, s) => ({ ap: a.ap + s.stats.appearances, go: a.go + s.stats.goals, as: a.as + s.stats.assists }), { ap: 0, go: 0, as: 0 });
  const seasons = g.seasons.map((s) =>
    `${s.age}:${s.overall}:${s.role}:${s.stats.appearances}:${s.stats.goals}:${s.stats.assists}:${s.stats.cleanSheets}:${s.stats.goalsConceded}|${s.trophies.join(",")}|${s.awards.filter(isOld).join(",")}`).join(";");
  return `seed=${g.seed} peak=${g.maxOverall} ret=${g.retireReason} seasons=${g.seasons.length} clubs=${new Set(g.seasons.map((s) => s.clubName)).size} totals=${tot.ap}/${tot.go}/${tot.as} :: ${seasons}`;
}

const SETUPS = [
  { name: "eng-epl", nation: "eng", league: "premier-league", pos: "ST" as const },
  { name: "csl-chn", nation: "chn", league: "csl", pos: "ST" as const },
  { name: "jpn-epl", nation: "jpn", league: "premier-league", pos: "ST" as const },
  { name: "kor-csl", nation: "kor", league: "csl", pos: "GK" as const },
];

const N = Number(process.argv[2] ?? 12);
for (const su of SETUPS) {
  for (let i = 0; i < N; i++) {
    const seed = `det-${su.name}-${i}-${hash32(`det-${su.name}-${i}`)}`;
    _s = 0x9e3779b9 ^ hash32(seed);
    const setup: RunSetup = { seed, nationalityId: su.nation, position: su.pos, leagueId: su.league,
      blessings: ["sharpshooter", "glass_cannon", "big_game_player"], ascension: 0, pace: "normal", allowWonderkid: true,
      permPerks: ["pp_prodigy", "pp_longevity", "pp_legacy_magnet", "pp_iron_will", "pp_transfer_savvy", "pp_comeback_base", "pp_oracle_base", "pp_scout", "pp_boss_slayer"] };
    const g = drive(simulatePeriod(createRun(setup)));
    console.log(`[${su.name}] ${fp(g)}`);
  }
}
