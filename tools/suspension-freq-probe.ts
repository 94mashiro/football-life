/**
 * Suspension-frequency probe — answers "整期停赛(连续 N 季 0 出场)有多常见?"
 *
 * Root question (user): at normal pace periodLength=2, a single `suspended=true`
 * event wipes BOTH seasons of a period → 2 consecutive 0-appearance seasons.
 * The user has been migrating most penalties to statsMultiplier (少踢而非整季停赛)
 * and wants full-period suspension to be RARE, not common.
 *
 * This probe measures, across the regress corpus (8 profiles × 3 policies × seeds):
 *  - % careers with ≥1 suspended season
 *  - longest run of consecutive suspended seasons (the "停赛延续" the user dislikes)
 *  - which decision (key:option) caused each suspension, split by:
 *      UNCONDITIONAL (the choice itself = a rehab/ban season, suspended always)
 *      CONDITIONAL   (only on roll failure — p_fail shown)
 *  - per-pace breakdown (long=1 / normal=2 / express=3 seasons per suspension)
 *
 * Run:  npx tsx tools/suspension-freq-probe.ts
 */
import { createRun, simulatePeriod, resolveChoice } from "../src/engine/run";
import { setPreviewsEnabled } from "../src/engine/events";
import { PROFILES, POLICY_IDS, SEEDS_PER_CELL } from "./_corpus";
import { POLICIES, type Policy } from "./_harness";
import type { GameState } from "../src/engine/types";

setPreviewsEnabled(false);

// Every event branch that sets mods.suspended = true (hand-extracted from events.ts).
// UNCONDITIONAL: suspended set right after the roll, NOT inside an if — the choice
//   itself is a rehab/ban period (you spend the period rehabbing / banned).
// CONDITIONAL: suspended only on roll failure — listed with the roll's p_fail
//   (the lose probability, before tilt/asc adjustments).
const SUSPENSION_BRANCHES: Record<string, { kind: "uncond" | "cond"; pFail?: number }> = {
  "mysterious_substance:consume": { kind: "cond", pFail: 0.35 }, // caught roll(0.35,"negative")
  "injury_at_peak:play_injured": { kind: "cond", pFail: 0.20 },
  "career_threatening_injury:rehab_war": { kind: "uncond" },
  "fan_confrontation:snap": { kind: "uncond" },
  "peak_destroyed:fight": { kind: "uncond" },
  "cardiac_arrest:comeback": { kind: "uncond" },
  "forgotten_test:accept_ban": { kind: "uncond" },
  "forgotten_test:fight_it": { kind: "cond", pFail: 0.80 }, // mods.suspended = !success, roll(0.2)
  "miracle_comeback:fight_back": { kind: "uncond" },
  "horror_tackle:comeback": { kind: "uncond" },
  "acl_prodigy:comeback_stronger": { kind: "uncond" },
  "overused_prodigy:play_everything": { kind: "cond", pFail: 0.75 },
  "glass_genius:find_stability": { kind: "cond", pFail: 0.65 },
  "firecracker:come_back_burning": { kind: "cond", pFail: 0.60 },
  "doping_whistleblower:pay_off": { kind: "cond", pFail: 0.40 },
  "injury_relapse:push_through": { kind: "cond", pFail: 0.65 },
};

interface CareerResult {
  suspendedSeasons: number;          // total seasons with suspended==true
  maxConsecutive: number;            // longest run of consecutive suspended seasons
  periodLength: number;
  pace: string;
  causingDecisions: string[];        // key:option of decisions whose resolve set suspended
}

function runOne(seed: string, profileId: string, policy: Policy): CareerResult {
  const profile = PROFILES.find((p) => p.id === profileId)!;
  let g: GameState = simulatePeriod(createRun({
    seed,
    nationalityId: profile.nationalityId,
    position: profile.position,
    leagueId: profile.leagueId,
    pace: profile.pace,
    blessings: profile.blessings,
    ascension: profile.ascension,
    permPerks: [],
  }));
  const causingDecisions: string[] = [];
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingChoice) {
      const key = g.pendingChoice.key;
      const chosen = policy(g.pendingChoice.choices, key, g.seasons.length, seed);
      const decId = `${key}:${chosen.id}`;
      // Attribute suspension ONLY to the decision whose resolve flipped
      // pendingMods.suspended false→true. The two-channel queue (S then T)
      // accumulates mods: an S event that sets suspended leaves pendingMods
      // .suspended true for the subsequent T resolve too — without this
      // before/after guard the innocent T decision gets mis-credited.
      const before = !!g.pendingMods?.suspended;
      g = resolveChoice(g, chosen);
      const after = !!g.pendingMods?.suspended;
      if (!before && after) causingDecisions.push(decId);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }

  // count suspended seasons + longest consecutive run
  let suspendedSeasons = 0;
  let maxConsecutive = 0;
  let run = 0;
  for (const s of g.seasons) {
    if (s.suspended) {
      suspendedSeasons++;
      run++;
      if (run > maxConsecutive) maxConsecutive = run;
    } else {
      run = 0;
    }
  }
  return {
    suspendedSeasons,
    maxConsecutive,
    periodLength: g.periodLength ?? 1,
    pace: g.pace ?? "?",
    causingDecisions,
  };
}

// ── SINGLE pass over the corpus; tag every result with profileId + policyId ──
// (a previous version re-ran runOne 3× per cell and the three reports disagreed —
// either a counting bug or non-determinism; one pass + derive-all eliminates it).
interface Row { profileId: string; policyId: string; r: CareerResult }
const rows: Row[] = [];
for (const profile of PROFILES) {
  for (const policyId of POLICY_IDS) {
    const policy = POLICIES[policyId];
    for (let i = 0; i < SEEDS_PER_CELL; i++) {
      const seed = `corpus-${profile.id}-${policyId}-${i}`;
      rows.push({ profileId: profile.id, policyId, r: runOne(seed, profile.id, policy) });
    }
  }
}
const all = rows.map((x) => x.r);

const N = all.length;
const hasSusp = all.filter((r) => r.suspendedSeasons > 0);
const has2Consec = all.filter((r) => r.maxConsecutive >= 2);
const has3Consec = all.filter((r) => r.maxConsecutive >= 3);
// TRUE cross-period bleed: longest consecutive run EXCEEDS one period's length —
// a suspension event in period P AND period P+1 also suspended (the genuine
// 「停赛延续」 across the period boundary, rarer than a single plen-spanning ban).
const bleed = all.filter((r) => r.maxConsecutive > r.periodLength);

console.log(`${"═".repeat(78)}`);
console.log(` 整期停赛频率 — 全语料库 ${N} 局 (8 profile × 3 policy × ${SEEDS_PER_CELL} seed)`);
console.log(`${"═".repeat(78)}`);
console.log(`≥1 个停赛季(suspended season) 的生涯: ${hasSusp.length}/${N} = ${(100 * hasSusp.length / N).toFixed(1)}%`);
console.log(`≥2 连续停赛季                的生涯: ${has2Consec.length}/${N} = ${(100 * has2Consec.length / N).toFixed(1)}%`);
console.log(`≥3 连续停赛季                的生涯: ${has3Consec.length}/${N} = ${(100 * has3Consec.length / N).toFixed(1)}%`);
console.log(`跨期连停(>plen 连续)        的生涯: ${bleed.length}/${N} = ${(100 * bleed.length / N).toFixed(2)}%  ← 真正「停赛延续」跨期`);

// per-pace breakdown
console.log(`\n→ 按 pace 拆分 (periodLength = 一次停赛覆盖的赛季数):`);
const byPace: Record<string, CareerResult[]> = {};
for (const r of all) (byPace[r.pace] ??= []).push(r);
for (const [pace, rs] of Object.entries(byPace)) {
  const pl = rs[0]!.periodLength;
  const n = rs.length;
  const h1 = rs.filter((r) => r.suspendedSeasons > 0).length;
  const h2 = rs.filter((r) => r.maxConsecutive >= 2).length;
  const h3 = rs.filter((r) => r.maxConsecutive >= 3).length;
  const hBleed = rs.filter((r) => r.maxConsecutive > r.periodLength).length;
  console.log(`   ${pace.padEnd(7)} (plen=${pl}): ${n}局   遇停赛=${(100 * h1 / n).toFixed(1)}%   ≥2连续=${(100 * h2 / n).toFixed(1)}%   ≥3连续=${(100 * h3 / n).toFixed(1)}%   跨期连停=${(100 * hBleed / n).toFixed(2)}%`);
}

// per-policy breakdown (player choice matters: "last" = gamble branches)
console.log(`\n→ 按 policy 拆分 (first=稳, last=赌, varied=散):`);
const byPolicy: Record<string, CareerResult[]> = {};
for (const x of rows) (byPolicy[x.policyId] ??= []).push(x.r);
for (const pid of POLICY_IDS) {
  const rs = byPolicy[pid] ?? [];
  const n = rs.length;
  const h1 = rs.filter((r) => r.suspendedSeasons > 0).length;
  const h2 = rs.filter((r) => r.maxConsecutive >= 2).length;
  console.log(`   ${pid.padEnd(7)}: ${n}局   ≥1停赛季=${(100 * h1 / n).toFixed(1)}%   ≥2连续=${(100 * h2 / n).toFixed(1)}%`);
}

// pace × policy crosstab — 「标准节奏玩家」的精确频率。每格一行避免列错位误读。
console.log(`\n→ pace × policy 交叉表:`);
console.log(`   ${"pace".padEnd(8)} ${"policy".padEnd(7)}  遇停赛      ≥2连续`);
const crossTab: Record<string, Record<string, [number, number, number]>> = {};
for (const x of rows) {
  const pace = x.r.pace;
  if (!crossTab[pace]) crossTab[pace] = {};
  if (!crossTab[pace]![x.policyId]) crossTab[pace]![x.policyId] = [0, 0, 0];
  const cell = crossTab[pace]![x.policyId]!;
  if (x.r.suspendedSeasons > 0) cell[0] += 1;
  if (x.r.maxConsecutive >= 2) cell[1] += 1;
  cell[2] += 1;
}
for (const pace of Object.keys(crossTab).sort()) {
  for (const pid of POLICY_IDS) {
    const [hit, consec, n] = crossTab[pace]![pid] ?? [0, 0, 0];
    console.log(`   ${pace.padEnd(8)} ${pid.padEnd(7)}  ${hit}/${n}=${(100 * hit / n).toFixed(1)}%   ${consec}/${n}=${(100 * consec / n).toFixed(1)}%`);
  }
}

// which decisions caused suspensions
console.log(`\n→ 触发停赛的决策 (key:option) 聚合 — 共 ${hasSusp.reduce((s, r) => s + r.causingDecisions.length, 0)} 次停赛事件:`);
const decAgg: Record<string, number> = {};
for (const r of hasSusp) for (const d of r.causingDecisions) decAgg[d] = (decAgg[d] ?? 0) + 1;
const sorted = Object.entries(decAgg).sort((a, b) => b[1] - a[1]);
for (const [d, v] of sorted) {
  const meta = SUSPENSION_BRANCHES[d];
  const tag = meta?.kind === "uncond" ? "[必然] "
    : meta?.kind === "cond" ? `[${Math.round((meta.pFail ?? 0) * 100)}%失败]`
    : "[?]";
  console.log(`   ${tag.padEnd(10)} ${d.padEnd(42)} ${String(v).padStart(5)}  ${(v / N * 100).toFixed(2)}%/career`);
}

// suspended-seasons-per-career distribution
console.log(`\n→ 每生涯停赛季数分布:`);
const sBuckets: Record<number, number> = {};
for (const r of all) sBuckets[r.suspendedSeasons] = (sBuckets[r.suspendedSeasons] ?? 0) + 1;
for (const [k, v] of Object.entries(sBuckets).map(([k, v]) => [Number(k), v] as [number, number]).sort((a, b) => a[0] - b[0])) {
  console.log(`   ${k}季: ${String(v).padStart(5)} (${(100 * v / N).toFixed(1)}%)`);
}
