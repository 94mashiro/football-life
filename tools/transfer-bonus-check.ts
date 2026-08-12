/**
 * 转会加成差分验证 —— 同一 seed/age/club 下，perk vs bare 的 pendingDelta 应恰差 +2，
 * mercenary vs bare 应差 +1。这才是「bonus 生效」的干净证明（bonus 叠在同期 S 通道
 * 事件/队列累积的 overallDelta 之上，所以不能断言 Δ===bonus，要断言差分）。
 */
import { createRun, simulatePeriod, resolveChoice, type RunSetup } from "../src/engine/run";
import { setPreviewsEnabled } from "../src/engine/events";
import type { Choice, GameState } from "../src/engine/types";

setPreviewsEnabled(false);

const LEAGUE = "premier-league";
const POS = "ST";
const NAT = "eng";

/** 找本期第一个 new_club（非 academy_choice）转会选项。 */
function findRealTransfer(g: GameState): { ev: GameState["pendingChoice"]; club: Choice } | null {
  const ev = g.pendingChoice;
  if (!ev || ev.key === "academy_choice") return null;
  const club = ev.choices.find((c) => c.kind === "new_club");
  return club ? { ev, club } : null;
}

interface FirstTransfer {
  seed: string;
  age: number;
  club: string;
  delta: number; // resolve 后 pendingMods.overallDelta
}

/** 跑到第一笔真实转会，记录 resolve 后的 pendingMods.overallDelta。 */
function firstTransferDelta(seed: string, blessings: readonly string[], permPerks: readonly string[]): FirstTransfer | null {
  const setup: RunSetup = {
    seed, nationalityId: NAT, position: POS as any, leagueId: LEAGUE,
    pace: "normal", blessings, ascension: 0, permPerks,
  };
  let g = simulatePeriod(createRun(setup));
  let guard = 0;
  while (g.phase === "playing" && guard++ < 400) {
    if (g.pendingChoice) {
      const t = findRealTransfer(g);
      if (t) {
        g = resolveChoice(g, t.club);
        return { seed, age: g.age, club: g.pendingMods?.newClubId ?? "?", delta: g.pendingMods?.overallDelta ?? 0 };
      }
      const cs = g.pendingChoice.choices;
      if (cs.length === 0) break;
      g = resolveChoice(g, cs[0]!);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  return null;
}

const seeds = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
let perkDiffs = 0, mercDiffs = 0, checked = 0, anomalies = 0;
console.log("seed      age club              bare  merc  perk  (merc-bare perk-bare)");
for (const seed of seeds) {
  const bare = firstTransferDelta(seed, [], []);
  const merc = firstTransferDelta(seed, ["mercenary"], []);
  const perk = firstTransferDelta(seed, [], ["pp_transfer_savvy"]);
  if (!bare || !merc || !perk) { console.log(`${seed}: 没碰到转账`); continue; }
  checked++;
  const dMerc = merc.delta - bare.delta;
  const dPerk = perk.delta - bare.delta;
  if (dMerc === 1) mercDiffs++;
  if (dPerk === 2) perkDiffs++;
  if (dMerc !== 1 || dPerk !== 2) anomalies++;
  console.log(
    `${seed.padEnd(9)} ${String(bare.age).padStart(3)} ${bare.club.padEnd(17)} ` +
    `${String(bare.delta).padStart(4)} ${String(merc.delta).padStart(4)} ${String(perk.delta).padStart(4)}   ` +
    `${dMerc >= 0 ? "+" : ""}${dMerc}   ${dPerk >= 0 ? "+" : ""}${dPerk}` +
    (dMerc === 1 && dPerk === 2 ? "" : "  ❌"),
  );
}
console.log(
  `\n${checked} seeds 对比：mercenary 差分=+1 命中 ${mercDiffs}/${checked}，perk 差分=+2 命中 ${perkDiffs}/${checked}` +
  (anomalies === 0 ? "\n✅ 转会加成机制完全生效：每笔真实转会 perk +2 / mercenary +1 叠入 pendingMods.overallDelta" : `\n❌ ${anomalies} 处异常`),
);

// 额外确认：academy_choice（青训抉择）被正确排除——第一笔俱乐部归属不触发 bonus
{
  const setup: RunSetup = {
    seed: "alpha", nationalityId: NAT, position: POS as any, leagueId: LEAGUE,
    pace: "normal", blessings: [], ascension: 0, permPerks: ["pp_transfer_savvy"],
  };
  let g = simulatePeriod(createRun(setup));
  // 开局第一决策应是 academy_choice
  const isAcademy = g.pendingChoice?.key === "academy_choice";
  const club = g.pendingChoice?.choices.find((c) => c.kind === "new_club");
  if (isAcademy && club) {
    g = resolveChoice(g, club);
    const delta = g.pendingMods?.overallDelta ?? 0;
    console.log(`\n青训抉择排除检查：academy_choice resolve 后 Δ=${delta}（应为 0，青训不算转会）` +
      (delta === 0 ? " ✅" : " ❌"));
  }
}
