/**
 * 传承分高水位：身价下滑不得把已经达到的估值抹掉。
 *
 * 合成两季——巅峰身价 → 暮年腰斩，荣誉柜不变。liveLegacy 必须锁在第一季的
 * 估值上；体面退场可以抬高，不能压低。
 *
 * Run:  npx tsx tools/legacy-high-water.ts
 */
import { liveLegacy } from "../src/engine/run";
import type { GameState, Player, SeasonResult } from "../src/engine/types";

const STATS = { appearances: 34, goals: 18, assists: 8, cleanSheets: 0, goalsConceded: 30 };

function season(
  age: number, overall: number, marketValue: number, wage: number,
  extra?: { trophies?: SeasonResult["trophies"]; stats?: SeasonResult["stats"] },
): SeasonResult {
  return {
    age, squadLevel: "senior",
    clubId: "man_city", clubName: "Man City",
    leagueId: "premier-league", leagueName: "Premier League",
    tier: 1, role: "starter", overall,
    stats: extra?.stats ?? STATS,
    trophies: extra?.trophies ?? [], awards: [], nationalTournaments: [],
    relegated: false, marketValue, wage,
  };
}

const player: Player = {
  position: "ST", nationalityId: "bra", originNationalityId: "bra",
  overall: 88, age: 34, devProfile: "normal", name: "探针", squadNumber: 9,
};

function state(seasons: readonly SeasonResult[]): GameState {
  const age = seasons[seasons.length - 1]?.age ?? 16;
  const overall = seasons[seasons.length - 1]?.overall ?? 50;
  return {
    phase: "playing", seed: "high-water", player: { ...player, age, overall },
    currentClubId: "man_city", currentLeagueId: "premier-league",
    seasons,
    maxOverall: Math.max(0, ...seasons.map((s) => s.overall)),
    trophies: seasons.flatMap((s) => s.trophies),
    awards: seasons.flatMap((s) => s.awards),
    pendingChoice: null, legacy: 0, rawLegacy: 0, ascension: 0,
    retired: false, retirementReason: null, age,
  };
}

const ZERO = { appearances: 10, goals: 0, assists: 0, cleanSheets: 0, goalsConceded: 20 };
const peak = state([season(26, 88, 80, 400, { trophies: ["league"] })]);
const faded = state([
  season(26, 88, 80, 400, { trophies: ["league"] }),
  season(34, 82, 12, 180, { stats: ZERO }),
]);

let fail = 0;
const bad = (msg: string) => { console.log("  ✗ " + msg); fail++; };

const peakScore = liveLegacy(peak);
const fadedScore = liveLegacy(faded);
const dignified = liveLegacy(faded, true);

console.log(`  巅峰一季 ${peakScore}   暮年两季 ${fadedScore}   体面退场 ${dignified}`);

if (peakScore <= 0) bad("巅峰估值应为正");
if (fadedScore !== peakScore) bad(`身价腰斩后传承分变了（${peakScore} → ${fadedScore}），高水位失效`);
if (dignified < fadedScore) bad(`体面退场压低了高水位（${fadedScore} → ${dignified}）`);

console.log(fail === 0 ? "\nPASS" : `\nFAIL (${fail})`);
if (fail > 0) process.exitCode = 1;
