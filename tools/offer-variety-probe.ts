/**
 * 报价多样性探针 — 量化「转会路径固定」的体感来源。
 * 跑 N 段完整生涯（随机选项），记录每次转会窗看到的所有 offer 俱乐部，
 * 按声望档统计：候选池大小、实际出现的不同俱乐部数、top-5 集中度（HHI/份额）、
 * 以及同一段生涯里重复看到同一家俱乐部的比例。
 * Run: npx tsx tools/offer-variety-probe.ts [N=150] [nation=eng] [pos=ST] [league=premier-league]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { CLUBS, clubById } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const N = Number(process.argv[2] ?? 150);
const nation = process.argv[3] ?? "eng";
const pos = (process.argv[4] ?? "ST") as RunSetup["position"];
const league = process.argv[5] ?? "premier-league";

const seen: Record<string, number> = {};              // club id -> 被 offer 次数
const seenByRep: Record<number, Record<string, number>> = {};
let offers = 0, dupInCareer = 0, careerOffers = 0;
let eliteOffers = 0, eliteDup = 0;   // rep>=7 的报价里,同一生涯重复看到同一家的比例

let s = 12345;
const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

for (let i = 0; i < N; i++) {
  const setup: RunSetup = { seed: `variety-${i}`, nationalityId: nation, position: pos, leagueId: league, blessings: [], ascension: 0, pace: "normal" };
  let g: GameState = createRun(setup);
  const careerSeen = new Set<string>();
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    const pc = g.pendingChoice;
    if (!pc) { g = simulatePeriod(g); continue; }
    const clubChoices = pc.choices.filter((c) => c.kind === "new_club" || c.kind === "begin_career");
    if (clubChoices.length > 0 && pc.eventKey !== "academy_choice") {
      for (const c of clubChoices) {
        const club = CLUBS.find((x) => x.name === c.text.replace(/^加盟 /, "") || x.id === c.clubId);
        if (!club) continue;
        offers++; careerOffers++;
        seen[club.id] = (seen[club.id] ?? 0) + 1;
        (seenByRep[club.rep] ??= {})[club.id] = ((seenByRep[club.rep] ??= {})[club.id] ?? 0) + 1;
        if (careerSeen.has(club.id)) dupInCareer++;
        if (club.rep >= 7) { eliteOffers++; if (careerSeen.has(club.id)) eliteDup++; }
        careerSeen.add(club.id);
      }
    }
    const pick: Choice = pc.choices[Math.floor(rnd() * pc.choices.length)]!;
    g = resolveChoice(g, pick);
    if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
  }
}

console.log(`# offer variety · N=${N} · ${nation}/${pos}/${league} · offers=${offers}`);
console.log(`重复率: 同一生涯里再次被同一家俱乐部报价 ${(100 * dupInCareer / Math.max(1, careerOffers)).toFixed(1)}%`);
console.log(`顶级(rep≥7)报价重复率: ${(100 * eliteDup / Math.max(1, eliteOffers)).toFixed(1)}%  (n=${eliteOffers})`);
console.log(`\nrep  池内俱乐部  实际出现  覆盖率   top5 份额   报价数`);
for (let rep = 9; rep >= 0; rep--) {
  const m = seenByRep[rep];
  if (!m) continue;
  const pool = CLUBS.filter((c) => c.rep === rep).length;
  const counts = Object.values(m).sort((a, b) => b - a);
  const total = counts.reduce((a, b) => a + b, 0);
  const top5 = counts.slice(0, 5).reduce((a, b) => a + b, 0);
  console.log(`${rep}    ${String(pool).padStart(6)}  ${String(counts.length).padStart(8)}  ${(100 * counts.length / pool).toFixed(0).padStart(5)}%  ${(100 * top5 / total).toFixed(0).padStart(6)}%  ${String(total).padStart(7)}`);
}
const top = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log(`\n最常出现的 12 家: ${top.map(([id, n]) => `${clubById(id).name}(r${clubById(id).rep})×${n}`).join(" · ")}`);
