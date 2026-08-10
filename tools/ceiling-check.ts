// 成长天花板自检 (P-LEAGUE)。跑：npx tsx tools/ceiling-check.ts
// 断言天花板的三条契约：硬顶收敛、联赛档位真的进公式、衰退永不缩放。
import { applyCeiling, devEnvRep } from "../src/engine/sim";
import { clubById } from "../src/engine/data";

/** 反复施加一个大 delta，看 OVR 收敛到哪 —— 这就是「在这家俱乐部能长到多少」。 */
function hardTop(clubId: string, start = 50): number {
  const club = clubById(clubId);
  let ovr = start;
  for (let i = 0; i < 200; i++) {
    const d = applyCeiling(12, ovr, club);
    if (d <= 0) break;
    ovr += d;
  }
  return ovr;
}

const cases: [string, string][] = [
  ["beijing-guoan", "中超 rep3"],
  ["yunnan-yukun", "中超 rep1"],
  ["real-madrid", "西甲 rep9"],
];
for (const [id, label] of cases) {
  console.log(`${label.padEnd(10)} ${clubById(id).name.padEnd(8)} eff-rep ${devEnvRep(clubById(id))} → 硬顶 ${hardTop(id)}`);
}

const guoan = hardTop("beijing-guoan");
const yukun = hardTop("yunnan-yukun");
const madrid = hardTop("real-madrid");

// 1. 中超养成有真硬顶 —— 用户报的「21 岁 84 待在国安」必须不可能。
console.assert(guoan <= 82, `国安硬顶应 ≤82，实测 ${guoan}`);
// 2. 爬梯必须真的抬天花板（否则转会决策没有意义）。
console.assert(madrid >= 90, `皇马硬顶应 ≥90，实测 ${madrid}`);
console.assert(madrid > guoan && guoan > yukun, `硬顶必须随环境单调：${yukun} < ${guoan} < ${madrid}`);
// 3. 联赛档位确实进了公式：中超 rep3 的有效声望必须低于同 rep 的欧洲俱乐部。
console.assert(devEnvRep(clubById("beijing-guoan")) < clubById("beijing-guoan").rep, "中超应有 −1 档偏移");
// 4. 衰退永不缩放 —— 转会去弱队的老将不会被天花板二次惩罚。
console.assert(applyCeiling(-5, 95, clubById("yunnan-yukun")) === -5, "负 delta 必须原样通过");
// 5. 全成长带内不打折。
console.assert(applyCeiling(4, 55, clubById("beijing-guoan")) === 4, "天花板以下应满额成长");

console.log("ceiling-check ✓");
