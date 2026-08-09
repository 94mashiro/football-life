/**
 * 巅峰年龄探针 — 生涯 OVR 曲线的「巅峰何时到来」指南针。
 *
 * 跑 N 局完整生涯（headless），记录每位球员达到生涯最高 OVR 的那个赛季的
 * 年龄（peakAge），打印分布。诊断「巅峰来得太早 / 太晚」。
 *
 * 真实足球参考： outfield 巅峰 ~28-29，门将 ~30。本探针目标：outfield 中位
 * 巅峰年龄 27-29，GK 29-31。
 *
 * Run:  npx tsx tools/peak-age.ts [N=400] [nation=bra] [pos=ST] [league=brasileirao] [asc=0] [mode=random]
 *   mode: "random" (unguided) | "skilled" (blessed + climb ladder + wonderkid)
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const args = process.argv.slice(2);
const N = Number(args[0] ?? 400);
const nation = String(args[1] ?? "bra");
const pos = String(args[2] ?? "ST") as RunSetup["position"];
const league = String(args[3] ?? "brasileirao");
const asc = Number(args[4] ?? 0);
const mode = String(args[5] ?? "random");
const SKILLED_BLESSINGS = ["sharpshooter", "glass_cannon", "big_game_player"];

let _s = 0x9e3779b9;
function rnext(): number { _s ^= _s << 13; _s >>>= 0; _s ^= _s >> 17; _s ^= _s << 5; _s >>>= 0; return _s; }
const rint = (lo: number, hi: number) => lo + Math.floor((rnext() / 4294967296) * (hi - lo + 1));
function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function pickChoice(g: GameState): Choice {
  const ch = g.pendingChoice!.choices;
  if (ch.length === 1) return ch[0]!;
  const key = g.pendingChoice!.key;
  if (mode === "skilled" && (key === "transfer" || key === "wage_squeeze" || key === "post_loan" || key === "blockbuster_offer")) {
    const stayStars = (() => { try { const r = clubById(g.currentClubId).rep; return r >= 8 ? 5 : r >= 6 ? 4 : r >= 4 ? 3 : r >= 2 ? 2 : 1; } catch { return 0; } })();
    const stars = (c: Choice) => c.id === "stay" ? stayStars : (c.sub ?? "").split("★").length - 1;
    let best = 0, bs = -1;
    for (let i = 0; i < ch.length; i++) { const s = stars(ch[i]!); if (s > bs) { bs = s; best = i; } }
    return ch[best]!;
  }
  return ch[rint(0, ch.length - 1)]!;
}

const peakAges: number[] = [];
const peakOvrs: number[] = [];
const retireAges: number[] = [];
const declStartAges: number[] = []; // first season OVR strictly < peak, after peak reached
const profile: Record<string, number> = {};

for (let i = 0; i < N; i++) {
  const seed = `pa-${i}-${hash32(`pa-${i}`)}`;
  _s = 0x9e3779b9 ^ hash32(seed);
  const setup: RunSetup = {
    seed, nationalityId: nation, position: pos, leagueId: league,
    blessings: mode === "skilled" ? SKILLED_BLESSINGS : [],
    ascension: asc, pace: "normal", allowWonderkid: mode === "skilled",
  };
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
  // peak age = age of the FIRST season whose overall == maxOverall
  let peakOvr = -1, peakAge = -1, declStart = -1;
  for (const s of g.seasons) {
    if (s.overall > peakOvr) { peakOvr = s.overall; peakAge = s.age; declStart = -1; }
    else if (declStart === -1 && s.overall < peakOvr) declStart = s.age;
  }
  peakAges.push(peakAge);
  peakOvrs.push(peakOvr);
  retireAges.push(g.age);
  if (declStart > 0) declStartAges.push(declStart);
  const dev = (g as unknown as { devProfile?: string }).devProfile ?? "?";
  profile[dev] = (profile[dev] ?? 0) + 1;
}

const pct = (a: number[], p: number) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const med = (a: number[]) => pct(a, 0.5);
const histo = (arr: number[]): string => {
  const b: Record<number, number> = {};
  for (const a of arr) b[a] = (b[a] ?? 0) + 1;
  return Object.entries(b).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}:${v}`).join(" ");
};

console.log(`# peak-age · N=${N} · ${nation}/${pos}/${league} · asc ${asc} · ${mode}`);
console.log(`devProfile mix: ${Object.entries(profile).map(([k, v]) => `${k}:${v}`).join(" · ")}`);
console.log(`peakAge: median ${med(peakAges)} · p10 ${pct(peakAges,0.1)} · p25 ${pct(peakAges,0.25)} · p75 ${pct(peakAges,0.75)} · p90 ${pct(peakAges,0.9)}`);
console.log(`peakAge histogram (age:count): ${histo(peakAges)}`);
console.log(`peakOVR: median ${med(peakOvrs)} · ≥90 ${Math.round(peakOvrs.filter(x=>x>=90).length/N*100)}% · ≥85 ${Math.round(peakOvrs.filter(x=>x>=85).length/N*100)}% · ≥80 ${Math.round(peakOvrs.filter(x=>x>=80).length/N*100)}%`);
console.log(`retireAge: median ${med(retireAges)} · p10 ${pct(retireAges,0.1)} · p90 ${pct(retireAges,0.9)}`);
console.log(`decline-start age (first season below peak): median ${declStartAges.length ? med(declStartAges) : "n/a"} · ≤24 ${Math.round(declStartAges.filter(a=>a<=24).length/(declStartAges.length||1)*100)}% · ≤26 ${Math.round(declStartAges.filter(a=>a<=26).length/(declStartAges.length||1)*100)}% · histogram ${histo(declStartAges)}`);
