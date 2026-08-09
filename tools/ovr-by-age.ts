// 测各年龄 OVR 分布（校准神童类门控）
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { randomSeed } from "../src/meta/legacy";
import type { GameState, Choice, Position } from "../src/engine/types";

const SETUPS: { pos: Position; league: string; nation: string }[] = [
  { pos: "ST", league: "brasileirao", nation: "bra" }, { pos: "GK", league: "premier-league", nation: "eng" },
  { pos: "CM", league: "laliga", nation: "esp" }, { pos: "CB", league: "serie-a", nation: "cro" },
  { pos: "ST", league: "csl", nation: "chn" }, { pos: "LW", league: "ligue-1", nation: "sen" },
  { pos: "RW", league: "eredivisie", nation: "ned" }, { pos: "CDM", league: "bundesliga", nation: "ger" },
];
let _s = 0x9e3779b9;
function rnext() { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
function hash32(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));

const PER = 3000;
const byAge: Record<number, number[]> = {};
for (let si = 0; si < SETUPS.length; si++) {
  for (let i = 0; i < PER; i++) {
    const seed = randomSeed();
    _s = 0x9e3779b9 ^ hash32(seed) ^ (si * 2654435761);
    const rs: RunSetup = { seed, nationalityId: SETUPS[si]!.nation, position: SETUPS[si]!.pos, leagueId: SETUPS[si]!.league, blessings: [], ascension: 0, pace: "normal" };
    let g: GameState = simulatePeriod(createRun(rs));
    let guard = 0;
    while (g.phase === "playing" && guard++ < 400) {
      if (g.player) (byAge[g.player.age] ??= []).push(g.player.overall);
      if (g.pendingChoice) {
        const ch = g.pendingChoice.choices;
        const pick: Choice = ch.length > 1 ? ch[rint(0, ch.length - 1)]! : ch[0]!;
        g = resolveChoice(g, pick);
        if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
      } else g = simulatePeriod(g);
    }
  }
}
for (const age of [16, 17, 18, 19, 20, 21, 22, 24, 26, 28, 30]) {
  const a = (byAge[age] ?? []).sort((x, y) => x - y);
  if (!a.length) continue;
  const pct = (p: number) => a[Math.floor(a.length * p)]!;
  console.log(`age ${age}: n=${a.length} p10=${pct(0.1)} p25=${pct(0.25)} 中位=${pct(0.5)} p75=${pct(0.75)} p90=${pct(0.9)} max=${a[a.length - 1]}`);
}
