// 退化策略探针: 青训期环境权重(P-YOUTH)上线后,「青训抉择永远选声望更高的那家」是否成为唯一解?
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { randomSeed } from "../src/meta/legacy";
import { clubById, leagueById } from "../src/engine/data";
import type { GameState, Choice, } from "../src/engine/types";
import type { Position } from "../src/engine/data";
let _s = 0x9e3779b9;
const rnext = () => { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; };
const h32 = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
const score = (c: Choice) => { const id = (c as unknown as { clubId?: string }).clubId; if (!id) return -1;
  try { const cl = clubById(id); return cl.rep * 2 + leagueById(cl.leagueId).domRep; } catch { return -1; } };
const PER = Number(process.argv[2] ?? 600);
for (const mode of ["big", "small"] as const) {
  for (const [label, nation, league] of [["ENG 英超", "eng", "premier-league"], ["CHN 中超", "chn", "csl"]] as const) {
    const peaks: number[] = []; const firstRep: number[] = [];
    for (let i = 0; i < PER; i++) {
      const seed = randomSeed(); _s = 0x9e3779b9 ^ h32(seed);
      const rs: RunSetup = { seed, nationalityId: nation, position: "ST" as Position, leagueId: league, blessings: [], ascension: 0, pace: "normal" };
      let g: GameState = simulatePeriod(createRun(rs)); let guard = 0; let academyDone = false;
      while (g.phase === "playing" && guard++ < 400) {
        if (g.pendingChoice) {
          const ch = g.pendingChoice.choices;
          let pick: Choice;
          if (!academyDone && ch.every((c) => score(c) >= 0)) {
            const sorted = [...ch].sort((a, b) => score(b) - score(a));
            pick = mode === "big" ? sorted[0]! : sorted[sorted.length - 1]!;
            academyDone = true;
          } else pick = ch.length > 1 ? ch[rint(0, ch.length - 1)]! : ch[0]!;
          g = resolveChoice(g, pick);
          if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
        } else g = simulatePeriod(g);
      }
      let peak = 0; for (const s of g.seasons) peak = Math.max(peak, s.overall);
      peaks.push(peak);
      const s0 = g.seasons[0]; if (s0) { try { firstRep.push(clubById(s0.clubId).rep); } catch { /* ignore */ } }
    }
    const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)] ?? 0;
    const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(1);
    console.log(`${mode === "big" ? "选大俱乐部" : "选小俱乐部"} ${label} | 首季声望均值 ${avg(firstRep)} | 峰值 中位${q(peaks, 0.5)} p90 ${q(peaks, 0.9)} | ≥90 ${(peaks.filter((v) => v >= 90).length / peaks.length * 100).toFixed(0)}%`);
  }
}
