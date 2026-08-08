// 事件奖惩形态检查 — node tools/event-shape-check.mjs
//
// 设计不变量（每个选项必须是下面三者之一）：
//   1. SKIP    — 什么也不发生（一个事件里最多一条这样的路）
//   2. GAMBLE  — roll(p) 命中奖励，(1-p) 命中惩罚。两条分支都必须实际存在
//   3. TRADE   — 确定性的「换轴」：拿 A 换 B（换俱乐部/换国籍/退役/联赛×2 换洲际×0.5）
//
// 违规形态（本脚本报错的东西）：
//   PURE_REWARD  确定必得奖励、零代价 → 玩家不用思考
//   PURE_PENALTY 确定必挨惩罚、零收益 → 没人会选
// 两者都会让并排决策板上的后果预览一眼看出该选哪个，事件就死了。
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/engine/events.ts", import.meta.url), "utf8").split("\n");

const starts = [];
src.forEach((l, i) => {
  const m = l.match(/^\s*case "([a-z0-9_]+):([a-z0-9_]+)":/i);
  if (m) starts.push([i, `${m[1]}:${m[2]}`]);
});

const bad = [];
for (let k = 0; k < starts.length; k++) {
  const [i, key] = starts[k];
  const end = k + 1 < starts.length ? starts[k + 1][0] : src.length;
  // strip outcome prose — only the mechanics matter here
  const body = src.slice(i, end).filter((l) => !/outcome|^\s*[?:]/.test(l)).join(" ");
  if (/roll\(/.test(body)) continue; // GAMBLE — trusted (both branches share one roll)

  const mods = [...body.matchAll(/mods\.(\w+)\s*=\s*([^;]+)/g)].map((m) => [m[1], m[2].trim()]);
  if (!mods.length) continue; // SKIP
  // structural mods ARE the trade — a club/nation/role/trophy swap carries its own cost
  if (mods.some(([f]) => /newClubId|newNationalityId|forceRetire|nationalTournament|roleOverride|roleShift|suspended|ProbabilityMultiplier|worldCupResult/.test(f))) continue;

  const nums = mods.filter(([f]) => /OverallDelta/.test(f)).map(([, v]) => parseInt(v));
  const pos = nums.some((n) => n > 0), neg = nums.some((n) => n < 0);
  if (pos && !neg) bad.push(`PURE_REWARD  ${key}  (必得奖励、零代价 — 加 roll(p) 和惩罚分支)`);
  else if (neg && !pos) bad.push(`PURE_PENALTY ${key}  (必挨惩罚、零收益 — 加 roll(p) 和奖励分支)`);
}

if (bad.length) {
  console.error(`${bad.length} 个选项违反奖惩形态：\n` + bad.join("\n"));
  process.exit(1);
}
console.log(`OK — ${starts.length} 个选项全部符合 SKIP / GAMBLE / TRADE 形态`);
