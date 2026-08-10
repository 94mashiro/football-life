/**
 * 文案真实性探针：跑一批生涯，抓下每个事件的 desc 与 outcome，检查文案里出现的
 * 生涯事实是否与本局一致——占位符没渲染 (`${`/undefined/NaN)、数字读起来荒谬
 * (0 个进球/0 场比赛)、以及写死年龄与当前年龄不符。
 * Run:  npx tsx tools/copy-truth-probe.ts
 */
import { createRun, simulatePeriod, resolveChoice } from "../src/engine/run";
import type { GameState, } from "../src/engine/types";
import type { Position } from "../src/engine/data";
import { cnNum } from "../src/engine/narrative";

const SEEDS = Array.from({ length: 120 }, (_, i) => `copy-${i}`);
const NATIONS = ["bra", "chn", "cro", "kor", "eng", "arg"];
const POSITIONS = ["ST", "CM", "CB", "GK"] as const;
const LEAGUES = ["premier-league", "csl", "brasileirao", "austrian-bund"];

/** Ages asserted about the player RIGHT NOW — the age ends its clause
 *  ("你三十二岁。" / "你才二十九岁，"). A past-tense backstory age ("你十二岁
 *  离开了家") keeps running after 岁 and is not a claim about the present. */
const AGE_RE = /你(?:才|现在|已经|今年)?([一二三四五六七八九十]{1,3})岁(?=[了。，、！？\n]|$)/g;
const CN_AGES = new Map<string, number>();
for (let a = 10; a <= 45; a++) CN_AGES.set(cnNum(a), a);

interface Flag { seed: string; kind: string; sample: string }
const flags: Flag[] = [];
let texts = 0;

function check(seed: string, age: number, text: string) {
  texts++;
  if (text.includes("${") || text.includes("undefined") || text.includes("NaN")) {
    flags.push({ seed, kind: "unrendered", sample: text.slice(0, 90) });
  }
  if (/[进了扑出]\s*0\s*个|\b0场比赛|进了0个/.test(text)) {
    flags.push({ seed, kind: "zero-stat", sample: text.slice(0, 90) });
  }
  for (const m of text.matchAll(AGE_RE)) {
    const stated = CN_AGES.get(m[1]!);
    // Only "你(才/现在)N岁" asserts the present age. Allow the career-start
    // memory (16) and anything within a season of the truth.
    if (stated !== undefined && stated !== 16 && Math.abs(stated - age) > 1) {
      flags.push({ seed, kind: `age ${stated}≠${age}`, sample: m[0] + " … " + text.slice(0, 60) });
    }
  }
}

for (const [i, seed] of SEEDS.entries()) {
  let g: GameState = simulatePeriod(createRun({
    seed,
    nationalityId: NATIONS[i % NATIONS.length]!,
    position: POSITIONS[i % POSITIONS.length] as Position,
    leagueId: LEAGUES[i % LEAGUES.length]!,
    pace: "normal", blessings: [], ascension: 0, permPerks: [],
  }));
  let guard = 0;
  while (g.phase === "playing" && guard++ < 300) {
    if (g.pendingChoice) {
      const age = g.player!.age;
      check(seed, age, g.pendingChoice.desc);
      g = resolveChoice(g, g.pendingChoice.choices[guard % g.pendingChoice.choices.length]!);
      if (g.lastOutcome) check(seed, age, g.lastOutcome);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
}

const byKind = new Map<string, Flag[]>();
for (const f of flags) {
  const k = f.kind.startsWith("age") ? "age-mismatch" : f.kind;
  (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(f);
}
console.log(`checked ${texts} 段文案 / ${SEEDS.length} 局生涯`);
if (flags.length === 0) {
  console.log("✅ 无占位符残留、无 0 值荒谬数字、无写死年龄冲突");
} else {
  for (const [kind, list] of byKind) {
    console.log(`\n❌ ${kind}: ${list.length}`);
    for (const f of list.slice(0, 6)) console.log(`   [${f.seed}] ${f.sample}`);
  }
}
