/**
 * n_E 全量测量 + 门控审计（event-uniformity-probe worktree only）。
 * 跑 N 生涯，记录每个非转会池事件在 story 通道每生涯平均够格期数 n_E，
 * 连同 rarity/weight 一起 dump 成 JSON，供门控审计 + 补偿权重表生成。
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { EVENT_DEFS, POOL_CLUB_MOVE_KEYS, setPoolProbeHooks } from "../src/engine/events";
import { randomSeed } from "../src/meta/legacy";
import type { GameState, Choice, } from "../src/engine/types";
import type { Position } from "../src/engine/data";
import { writeFileSync } from "fs";

const CONTEXTUAL_IN_POOL = new Set([
  "relegation_loyalty", "throne_challenge", "contract_nonrenewal",
  "underperform_release", "stuck_release", "naturalization_offer",
  "club_national_team_conflict",
]);
const POOL_KEYS = new Set(EVENT_DEFS.map((d) => d.key).filter((k) => !CONTEXTUAL_IN_POOL.has(k)));
const NON_CLUB_POOL = new Set([...POOL_KEYS].filter((k) => !POOL_CLUB_MOVE_KEYS.has(k)));

const SETUPS: { pos: Position; league: string; nation: string }[] = [
  { pos: "ST", league: "brasileirao", nation: "bra" },
  { pos: "GK", league: "premier-league", nation: "eng" },
  { pos: "CM", league: "laliga", nation: "esp" },
  { pos: "CB", league: "serie-a", nation: "cro" },
  { pos: "ST", league: "csl", nation: "chn" },
  { pos: "LW", league: "ligue-1", nation: "sen" },
  { pos: "RW", league: "eredivisie", nation: "ned" },
  { pos: "CDM", league: "bundesliga", nation: "ger" },
];

let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const PER_SETUP = Number(process.argv[2] ?? 5000);
const N = PER_SETUP * SETUPS.length;

const eligibleCount: Record<string, number> = {};
setPoolProbeHooks(null, (keys, _age, storyOnly) => {
  if (!storyOnly) return;
  for (const k of keys) eligibleCount[k] = (eligibleCount[k] ?? 0) + 1;
});

for (let si = 0; si < SETUPS.length; si++) {
  const setup = SETUPS[si]!;
  for (let i = 0; i < PER_SETUP; i++) {
    const seed = randomSeed();
    _s = 0x9e3779b9 ^ hash32(seed) ^ (si * 2654435761);
    const runSetup: RunSetup = { seed, nationalityId: setup.nation, position: setup.pos, leagueId: setup.league, blessings: [], ascension: 0, pace: "normal" };
    let g: GameState = simulatePeriod(createRun(runSetup));
    let guard = 0;
    while (g.phase === "playing" && guard++ < 400) {
      if (g.pendingMilestone) g = { ...g, pendingMilestone: undefined };
      if (g.pendingChoice) {
        const ch = g.pendingChoice.choices;
        const pick: Choice = ch.length > 1 ? ch[rint(0, ch.length - 1)] : ch[0];
        g = resolveChoice(g, pick);
        if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
      } else g = simulatePeriod(g);
    }
  }
}
function rint(lo: number, hi: number) { return lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1)); }
setPoolProbeHooks(null, null);

const out: { key: string; rarity: string; weight: number; n_E: number }[] = [];
for (const d of EVENT_DEFS) {
  if (!NON_CLUB_POOL.has(d.key)) continue;
  out.push({ key: d.key, rarity: d.rarity ?? "common", weight: d.weight, n_E: (eligibleCount[d.key] ?? 0) / N });
}
out.sort((a, b) => a.n_E - b.n_E);
writeFileSync("/tmp/nE.json", JSON.stringify(out, null, 2));

// rarity breakdown
const byRar: Record<string, number> = {};
for (const r of out) byRar[r.rarity] = (byRar[r.rarity] ?? 0) + 1;
console.log(`N=${N} · 非转会池事件 ${out.length}`);
console.log(`稀有度分布: common=${byRar.common ?? 0} rare=${byRar.rare ?? 0} legendary=${byRar.legendary ?? 0}`);
console.log(`\n死/近死 (n_E < 0.1) — 候选门控审计：`);
for (const r of out.filter((x) => x.n_E < 0.1)) console.log(`  ${r.key.padEnd(24)} ${r.rarity.padEnd(9)} w=${String(r.weight).padStart(3)} n_E=${r.n_E.toFixed(3)}`);
console.log(`\n门宽劫持 (n_E > 3, common/rare) — 补偿要压的：`);
for (const r of out.filter((x) => x.n_E > 3 && x.rarity !== "legendary").sort((a, b) => b.n_E - a.n_E)) console.log(`  ${r.key.padEnd(24)} ${r.rarity.padEnd(9)} w=${String(r.weight).padStart(3)} n_E=${r.n_E.toFixed(2)}`);
console.log(`\n全表已写入 /tmp/nE.json`);
