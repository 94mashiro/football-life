/**
 * 首冠频率冒烟 — 统计青训抉择后**首段**(赛季 1–2)触发「生涯首冠」里程碑的
 * 频率,验证「新秀坐豪门板凳不再近乎必拿首冠」的调优(starDifficulty 低于球队
 * 基准线降权)。三档分别测:0=巨头档(最强)、1=弱旅档(最弱)、2=中游档(中)。
 * 详见 research/first-trophy-dampen.md。
 *
 * Run: npx tsx tools/first-trophy-smoke.ts [slot=0] [N=400]
 *   slot 0=巨头档 / 1=弱旅档 / 2=中游档
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById } from "../src/engine/data";

const slot = Number(process.argv[2] ?? 0);
const N = Number(process.argv[3] ?? 400);

const setup = (seed: string): RunSetup => ({
  seed,
  nationalityId: "eng",
  position: "ST",
  leagueId: "premier-league", // rep-9 巨头 (man-city/arsenal) 落在巨头档
  blessings: [],
  ascension: 0,
  pace: "normal",
});

let anyTrophy = 0;
let firstTrophyMilestone = 0;
const trophyKinds: Record<string, number> = {};
const clubReps: Record<number, number> = {};

for (let i = 0; i < N; i++) {
  const seed = `smoke-ft-${i}`;
  let st = createRun(setup(seed));
  st = simulatePeriod(st); // 抛出青训抉择事件
  if (!st.pendingChoice) { console.warn(`no academy event @ ${i}`); continue; }
  const choice = st.pendingChoice.choices[slot] ?? st.pendingChoice.choices[0]!;
  const club = choice.clubId ? clubById(choice.clubId) : null;
  if (club) clubReps[club.rep] = (clubReps[club.rep] ?? 0) + 1;
  st = resolveChoice(st, choice); // 出队青训抉择(队列空)
  st = simulatePeriod(st); // 在所选青训跑赛季 1–2
  if (st.trophies.length > 0) anyTrophy++;
  if (st.pendingMilestone?.id === "first_trophy") firstTrophyMilestone++;
  for (const t of st.trophies) trophyKinds[t] = (trophyKinds[t] ?? 0) + 1;
}

console.log(JSON.stringify({
  slot,
  slotName: ["巨头档(strongest)", "弱旅档(weakest)", "中游档(middle)"][slot] ?? `slot${slot}`,
  N,
  clubReps,
  anyTrophy,
  anyTrophyPct: `${(anyTrophy / N * 100).toFixed(1)}%`,
  firstTrophyMilestone,
  firstTrophyPct: `${(firstTrophyMilestone / N * 100).toFixed(1)}%`,
  trophyKinds,
}, null, 2));
