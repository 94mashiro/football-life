/**
 * Balance Monte Carlo: measure career OUTCOMES under a fixed decision strategy.
 *
 * The default mc-entry counts which events fire. This one measures the RESULTS
 * — peak OVR, retire age, legacy, trophy/award totals, career length, and how
 * they vary by strategy — so we can find dead zones, dominant strategies, and
 * degenerate arcs (e.g. careers stalling at <70, or 86+ being too common, or
 * World Cup win rate being off the football-authentic ~5-15%).
 *
 * Strategies:
 *   - "first"      : always pick choices[0] (the existing harness default)
 *   - "stay"       : prefer stay/keep options; only transfer when forced (no stay)
 *   - "climb"      : always take the highest-rep transfer offer; else stay
 *   - "safe_train" : prefer safe/keep training options; on transfer pick highest rep
 */
import { createRun, simulatePeriod, resolveChoice, liveLegacy } from "../src/engine/run";

import type { GameState, Choice } from "../src/engine/types";

type Strategy = "first" | "stay" | "climb" | "safe_train" | "smart_climb";

interface Setup {
  nationalityId: string;
  position: string;
  leagueId: string;
  pace: "long" | "normal" | "express";
  label: string;
}

const SETUPS: Setup[] = [
  { nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal", label: "BRA ST 英超" },
  { nationalityId: "eng", position: "CM", leagueId: "premier-league", pace: "normal", label: "ENG CM 英超" },
  { nationalityId: "chn", position: "ST", leagueId: "china-league-one", pace: "long", label: "CHN ST 中甲 long" },
  { nationalityId: "arg", position: "LW", leagueId: "laliga", pace: "normal", label: "ARG LW 西甲" },
  { nationalityId: "ita", position: "GK", leagueId: "serie-a", pace: "normal", label: "ITA GK 意甲" },
];

const NCAREERS = 400;

function pickChoice(g: GameState, strategy: Strategy): Choice {
  const choices = g.pendingChoice!.choices;
  if (choices.length === 1) return choices[0]!;
  const byKind = (k: string) => choices.find((c) => c.kind === k);
  switch (strategy) {
    case "stay": {
      const stay = byKind("stay") ?? byKind("permanent_transfer") /* post-loan stay is stay kind */ ;
      if (stay) return stay;
      // no stay option: prefer retire over dropping down? no — keep playing: pick new_club w/ lowest rep (least disruption)
      const clubs = choices.filter((c) => c.kind === "new_club" || c.kind === "join_loan");
      if (clubs.length) {
        return clubs.reduce((best, c) => repOf(c) < repOf(best) ? c : best, clubs[0]!);
      }
      return choices[0]!;
    }
    case "climb": {
      const clubs = choices.filter((c) => c.kind === "new_club" || c.kind === "permanent_transfer");
      if (clubs.length) {
        return clubs.reduce((best, c) => repOf(c) > repOf(best) ? c : best, clubs[0]!);
      }
      return byKind("stay") ?? choices[0]!;
    }
    case "safe_train": {
      // training/risk events: prefer the "safe"/"稳" option (id b or "keep"); on transfers, climb
      const clubs = choices.filter((c) => c.kind === "new_club" || c.kind === "permanent_transfer");
      if (clubs.length) return clubs.reduce((best, c) => repOf(c) > repOf(best) ? c : best, clubs[0]!);
      if (byKind("stay")) return byKind("stay")!;
      // for event_option, prefer id "b" (the conservative one in most boss/training events)
      const b = choices.find((c) => c.id === "b");
      if (b) return b;
      return choices[0]!;
    }
    case "smart_climb": {
      // transfer ONLY to a club where the player would be a starter (主力),
      // picking the HIGHEST such rep; else stay. Mirrors optimal play: climb
      // the ladder gradually, never benching yourself at a giant too early.
      const clubs = choices.filter((c) => (c.kind === "new_club" || c.kind === "permanent_transfer") && c.sub?.includes("主力"));
      if (clubs.length) return clubs.reduce((best, c) => repOf(c) > repOf(best) ? c : best, clubs[0]!);
      if (byKind("stay")) return byKind("stay")!;
      // training: prefer the safe option (id b)
      const b = choices.find((c) => c.id === "b");
      if (b) return b;
      return choices[0]!;
    }
    case "first":
    default:
      return choices[0]!;
  }
}

function repOf(c: Choice): number {
  // parse star rating from sub if present, else 0
  const m = c.sub?.match(/★+/);
  return m ? m[0].length : 0;
}

interface Outcome {
  peakOvr: number;
  retireAge: number;
  legacy: number;
  metaLegacy: number;
  seasons: number;
  trophies: number;
  wcWon: boolean;
  ballonDor: boolean;
  goldenBoot: boolean;
  retireReason: string;
  maxStreak: number;
}

function runOne(seed: string, setup: Setup, strategy: Strategy): Outcome {
  const game0 = createRun({
    seed, nationalityId: setup.nationalityId, position: setup.position as any,
    leagueId: setup.leagueId, pace: setup.pace, blessings: [], ascension: 0, permPerks: [],
  });
  let g: GameState = simulatePeriod(game0);
  let guard = 0;
  while (g.phase === "playing" && guard++ < 200) {
    if (g.pendingChoice) {
      const choice = pickChoice(g, strategy);
      g = resolveChoice(g, choice);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  // 权威结算分走引擎自己的 liveLegacy（store.ts settleRun 同源），而不是在这里
  // 手抄 17 个位置参数——手抄版本已经漂了：它把早被删掉的 g.eventLegacy 塞进
  // 第 10 个槽位（那里是 dignifiedExit），且漏掉 blessingShapeMult / nationMult。
  const metaLegacy = liveLegacy(g);
  return {
    peakOvr: g.maxOverall ?? 0,
    retireAge: g.age,
    legacy: g.legacy,
    metaLegacy,
    seasons: g.seasons.length,
    trophies: g.trophies.length,
    wcWon: g.trophies.includes("world_cup"),
    ballonDor: g.awards.includes("ballon_dor"),
    goldenBoot: g.awards.includes("golden_boot"),
    retireReason: g.retirementReason ?? "unknown",
    maxStreak: g.bestStreak ?? 0,
  };
}

function hashSeed(i: number): string {
  let h = 2166136261 ^ i;
  h = Math.imul(h, 16777619) >>> 0;
  return `bal-${i}-${h.toString(36)}`;
}

function pct(n: number, d: number): string {
  return d === 0 ? "0%" : `${(100 * n / d).toFixed(1)}%`;
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

function analyze(setup: Setup, strategy: Strategy): void {
  const outs: Outcome[] = [];
  for (let i = 0; i < NCAREERS; i++) outs.push(runOne(hashSeed(i), setup, strategy));
  const n = outs.length;
  const peak = outs.map((o) => o.peakOvr);
  const age = outs.map((o) => o.retireAge);
  const leg = outs.map((o) => o.legacy);
  const meta = outs.map((o) => o.metaLegacy);
  const sea = outs.map((o) => o.seasons);
  const tro = outs.map((o) => o.trophies);
  const wc = outs.filter((o) => o.wcWon).length;
  const bd = outs.filter((o) => o.ballonDor).length;
  const gb = outs.filter((o) => o.goldenBoot).length;
  const reasons: Record<string, number> = {};
  for (const o of outs) reasons[o.retireReason] = (reasons[o.retireReason] ?? 0) + 1;

  const buckets = { "<70": 0, "70-75": 0, "76-79": 0, "80-82": 0, "83-85": 0, "86-89": 0, "90+": 0 };
  for (const p of peak) {
    if (p < 70) buckets["<70"]++;
    else if (p < 76) buckets["70-75"]++;
    else if (p < 80) buckets["76-79"]++;
    else if (p < 83) buckets["80-82"]++;
    else if (p < 86) buckets["83-85"]++;
    else if (p < 90) buckets["86-89"]++;
    else buckets["90+"]++;
  }

  console.log(`\n=== ${setup.label}  [${strategy}]  n=${n} ===`);
  console.log(`peak OVR: med=${median(peak)} avg=${(peak.reduce((s, x) => s + x, 0) / n).toFixed(1)}  | <70=${pct(buckets["<70"], n)} 70-75=${pct(buckets["70-75"], n)} 76-79=${pct(buckets["76-79"], n)} 80-82=${pct(buckets["80-82"], n)} 83-85=${pct(buckets["83-85"], n)} 86-89=${pct(buckets["86-89"], n)} 90+=${pct(buckets["90+"], n)}`);
  console.log(`retire age: med=${median(age)} avg=${(age.reduce((s, x) => s + x, 0) / n).toFixed(1)}  | seasons med=${median(sea)}`);
  console.log(`legacy(in-run): med=${median(leg)} avg=${(leg.reduce((s, x) => s + x, 0) / n).toFixed(0)}  |  legacy(meta/scoreLegacy): med=${median(meta)} avg=${(meta.reduce((s, x) => s + x, 0) / n).toFixed(0)} p90=${[...meta].sort((a, b) => a - b)[Math.floor(n * 0.9)]}`);
  console.log(`trophies: med=${median(tro)} avg=${(tro.reduce((s, x) => s + x, 0) / n).toFixed(1)}  | WC=${pct(wc, n)} BallonDor=${pct(bd, n)} GoldenBoot=${pct(gb, n)}`);
  console.log(`retire reasons: ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${pct(v, n)}`).join("  ")}`);
}

// run the default setup under all 4 strategies to compare
const focus = SETUPS[0]!;
for (const strat of ["first", "stay", "climb", "safe_train", "smart_climb"] as Strategy[]) {
  analyze(focus, strat);
}
// then run all setups under "first" (the canonical unguided baseline)
console.log("\n\n######## ALL SETUPS — strategy: first (unguided baseline) ########");
for (const s of SETUPS) analyze(s, "first");
