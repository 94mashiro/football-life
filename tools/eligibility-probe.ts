/** Eligibility probe across POSITIONS — verify position-specialized narrative
 *  events (defensive_art for CB, sweeper_keeper for GK, invisible_engine for
 *  CDM...) actually reach their target position. A ST-only probe made them
 *  look "dead" when they're just position-gated. */
import { createRun, simulatePeriod, resolveChoice } from "../src/engine/run";
import { EVENT_DEFS } from "../src/engine/events";
import type { EventContext } from "../src/engine/events";
import type { GameState } from "../src/engine/types";
import { derive } from "../src/engine/rng";
import { resolveRole } from "../src/engine/sim";
import { leagueById, clubById } from "../src/engine/data";

const NCAREERS = 250;
const SETUPS = [
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal", label: "ST" },
  { nationalityId: "ita", position: "GK", leagueId: "serie-a", pace: "normal", label: "GK" },
  { nationalityId: "eng", position: "CB", leagueId: "premier-league", pace: "normal", label: "CB" },
  { nationalityId: "eng", position: "CM", leagueId: "premier-league", pace: "normal", label: "CM" },
  { nationalityId: "esp", position: "CDM", leagueId: "laliga", pace: "normal", label: "CDM" },
  { nationalityId: "fra", position: "LW", leagueId: "ligue-1", pace: "normal", label: "LW" },
] as const;

function ctxFor(g: GameState): EventContext {
  const player = g.player!;
  const club = clubById(g.currentClubId);
  const league = leagueById(club.leagueId);
  const periodLength = g.periodLength ?? 1;
  const periodIndex = Math.max(0, g.seasons.length - periodLength);
  return {
    player, club, league, seed: g.seed, age: player.age,
    role: resolveRole(player.overall, club, player.position === "GK"),
    periodIndex, rngState: derive(g.seed, "period-decision", periodIndex),
    blessings: g.blessings ?? [], injuriesTaken: g.injuriesTaken ?? 0,
    severeInjuries: g.severeInjuries ?? 0, ascension: g.ascension,
    statusTags: (g.statusTags ?? []).map((t) => t.split("@")[0]!),
    plan: g.careerEventPlan, periodLength, permPerks: g.permPerks ?? [],
    formerClubIds: [...new Set(g.seasons.map((s) => s.clubId))],
    recentMarketValue: g.seasons.length > 0 ? (g.seasons[g.seasons.length - 1]!.marketValue ?? 0) : 0,
    tournamentOffset: g.tournamentOffset ?? 0,
  };
}
function hash(i: number): string { let h = 2166136261 ^ i; h = Math.imul(h, 16777619) >>> 0; return `el-${i}-${h.toString(36)}`; }

// classify decision vs flavor
const decisionKeys = new Set<string>(); const flavorKeys = new Set<string>();
{
  const g0 = createRun({ seed: "c", nationalityId: "bra", position: "ST" as any, leagueId: "premier-league", pace: "normal", blessings: [], ascension: 0, permPerks: [] });
  const ctx = ctxFor(simulatePeriod(g0));
  for (const d of EVENT_DEFS) { try { (d.build(ctx).event.choices.length >= 2 ? decisionKeys : flavorKeys).add(d.key); } catch { decisionKeys.add(d.key); } }
}

const allDecisionKeys = [...decisionKeys];
const everByPos: Record<string, Set<string>> = {};
for (const s of SETUPS) {
  const ever = new Set<string>();
  for (let i = 0; i < NCAREERS; i++) {
    let g = createRun({ seed: hash(i), nationalityId: s.nationalityId, position: s.position as any, leagueId: s.leagueId, pace: s.pace as any, blessings: [], ascension: 0, permPerks: [] });
    g = simulatePeriod(g); let guard = 0;
    while (g.phase === "playing" && guard++ < 200) {
      const ctx = ctxFor(g);
      for (const d of EVENT_DEFS) { try { if (d.eligible(ctx)) ever.add(d.key); } catch { /* */ } }
      if (g.pendingChoice) { const c = g.pendingChoice.choices[0]!; g = resolveChoice(g, c); if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g); }
      else g = simulatePeriod(g);
    }
  }
  everByPos[s.label] = ever;
}

const union = new Set<string>();
for (const s of SETUPS) for (const k of everByPos[s.label]!) union.add(k);
const deadDecisions = allDecisionKeys.filter((k) => !union.has(k));
console.log(`decision events: ${allDecisionKeys.length}  |  ever eligible across ALL positions: ${[...union].filter(k=>decisionKeys.has(k)).length}  |  NEVER eligible any position: ${deadDecisions.length}`);
console.log(`\nGenuinely DEAD decision events (never eligible for ANY tested position):`);
console.log(deadDecisions.join(", ") || "(none — all reach at least one position)");
console.log(`\nPer-position eligible decision counts:`);
for (const s of SETUPS) console.log(`  ${s.label.padEnd(5)}: ${[...everByPos[s.label]!].filter(k=>decisionKeys.has(k)).length} decision events reachable`);
