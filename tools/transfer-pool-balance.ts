/**
 * 转会/青训放宽后的 balance-check 探针 — 验证声望匹配仍成立、青训 rep≤7 闸门
 * 不漏、无退化策略。Run: npx tsx tools/transfer-pool-balance.ts [N]
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { clubById, leagueById, clubStarRating } from "../src/engine/data";
import type { GameState, Choice } from "../src/engine/types";

const N = Number(process.argv[2] ?? "60");
const NATIONS = ["chn", "arg", "sen", "bra", "eng", "kor", "egy", "mex"];
const START_LEAGUE: Record<string, string> = { chn: "china-league-one", arg: "argentine-primera", sen: "egyptian-pred", bra: "brasileirao-b", eng: "championship", kor: "k-league-1", egy: "egyptian-pred", mex: "liga-mx" };

// approximate abilityTier for rep-matching check (mirrors playerRepTierForOffers)
function abilityTier(ovr: number): number {
  if (ovr >= 88) return 9; if (ovr >= 85) return 8; if (ovr >= 82) return 7;
  if (ovr >= 79) return 6; if (ovr >= 76) return 5; if (ovr >= 72) return 4;
  if (ovr >= 68) return 3; if (ovr >= 63) return 2; if (ovr >= 58) return 1; return 0;
}
function ceilingOf(g: GameState): number {
  const p = g.player!; const curRep = clubById(g.currentClubId).rep;
  const base = [52, 58, 63, 68, 72, 76, 79, 82, 85, 88];
  const isLocalStar = p.overall >= (base[curRep] ?? 52);
  const young = p.age <= 21;
  let c = young && isLocalStar ? 9 : isLocalStar ? curRep + 2 : curRep;
  c = Math.max(c, abilityTier(p.overall) + 1);
  return Math.max(0, Math.min(9, c));
}

let transferOffers = 0, repOverCeiling = 0;
let academyAbroad = 0, academyAbroadOver7 = 0, academyBig5Giant = 0;
const BIG5 = new Set(["premier-league", "laliga", "serie-a", "bundesliga", "ligue-1"]);
const confSpread: Record<string, number> = {};

for (const nation of NATIONS) {
  for (let i = 0; i < N; i++) {
    const setup: RunSetup = { seed: `bal-${nation}-${i}`, nationalityId: nation, position: "ST", leagueId: START_LEAGUE[nation] ?? "premier-league", pace: "long", ascension: 0, blessings: [], allowWonderkid: false, permPerks: [] };
    let g = simulatePeriod(createRun(setup));
    // academy
    if (g.pendingChoice?.key === "academy_choice") {
      const homeCountry = leagueById(START_LEAGUE[nation] ?? "premier-league").country;
      const nationConf = leagueById(START_LEAGUE[nation] ?? "premier-league").confederation;
      for (const c of g.pendingChoice.choices) {
        if (!c.clubId) continue;
        const cl = clubById(c.clubId);
        const lg = leagueById(cl.leagueId);
        if (lg.country === homeCountry) continue; // home offer, skip
        academyAbroad++;
        // rep≤7 闸门只作用于跨联盟留洋；同联盟不封顶（本土孩子可去本区巨头）。
        const crossConf = lg.confederation !== nationConf;
        if (crossConf && cl.rep > 7) academyAbroadOver7++;
        if (crossConf && cl.rep >= 8 && BIG5.has(lg.id)) academyBig5Giant++; // 皇马/曼城/拜仁…
      }
      g = resolveChoice(g, g.pendingChoice.choices[0]);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    }
    // first transfer window only
    let guard = 0;
    while (g.phase === "playing" && guard++ < 60) {
      if (g.pendingChoice) {
        const key = g.pendingChoice.key;
        if (key === "transfer" || key === "loan_offer" || key === "wage_squeeze") {
          const ceil = ceilingOf(g);
          for (const c of g.pendingChoice.choices) {
            if (!c.clubId || c.kind === "stay") continue;
            const cl = clubById(c.clubId);
            transferOffers++;
            if (cl.rep > ceil) repOverCeiling++;
            confSpread[leagueById(cl.leagueId).confederation] = (confSpread[leagueById(cl.leagueId).confederation] ?? 0) + 1;
          }
          break;
        }
        const ch = g.pendingChoice.choices;
        const main = ch.find((c) => (c.sub ?? "").includes("主力") && c.kind !== "stay");
        g = resolveChoice(g, main ?? ch.find((c) => c.kind === "stay") ?? ch[0]!);
        if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
      } else g = simulatePeriod(g);
    }
  }
}

console.log(`\n===== balance-check: 转会/青训放宽 (N=${N} × ${NATIONS.length} 国籍) =====`);
console.log(`[转会/租借报价] 样本=${transferOffers}  超出 ceiling(声望失配)=${repOverCeiling}  ${repOverCeiling === 0 ? "✓ 声望匹配保持" : "✗ 有失配"}`);
console.log(`[青训留洋 offer] 样本=${academyAbroad}  rep>7(应被闸)=${academyAbroadOver7}  全球顶级 rep≥8 五大=${academyBig5Giant}  ${academyAbroadOver7 === 0 && academyBig5Giant === 0 ? "✓ 闸门生效" : "✗ 闸门漏"}`);
console.log(`[首窗联盟分布] ${Object.entries(confSpread).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ")}`);
