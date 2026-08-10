// 事件奖惩形态检查 — node tools/event-shape-check.mjs
//
// 设计不变量（每个选项必须是下面三者之一）：
//   1. SKIP    — 什么也不发生（一个事件里最多一条这样的路）
//   2. GAMBLE  — roll(p) 命中奖励，(1-p) 命中惩罚。两条分支都必须实际存在
//   3. TRADE   — 确定性的「换轴」：拿 A 换 B（换俱乐部/换国籍/退役/联赛×2 换洲际×0.5）
//
// 违规形态（本脚本报错的东西）：
//   DOMINANT     兄弟选项拿不出任何它给不了的东西，它却给得更多 → 永远只有一个
//                正确答案，这就不是抉择了
//   PURE_PENALTY 确定必挨惩罚、零收益 → 没人会选
//
// 关键判据是「跨选项」而不是「选项内部」：一个选项自身没有内在惩罚不代表它白拿 ——
// 只要兄弟能给出它给不了的东西（词条 / 奖杯概率 / 国家队席位 / 一次赌注），选它就等于
// 放弃那样东西，机会成本就是代价。旧版只看单个选项里有没有负号，把 7 个正当的
// 「跨选项换轴」误报成纯奖励，真正被支配的那一个反而淹在里面没人看见。
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/engine/events.ts", import.meta.url), "utf8").split("\n");

const starts = [];
src.forEach((l, i) => {
  const m = l.match(/^\s*case "([a-z0-9_]+):([a-z0-9_]+)":/i);
  if (m) starts.push([i, `${m[1]}:${m[2]}`]);
});

// 先把每个选项拆成 {事件, 是否赌注, 触碰的 mod 字段集}，好让下面按事件比较兄弟选项。
const opts = [];
for (let k = 0; k < starts.length; k++) {
  const [i, key] = starts[k];
  const end = k + 1 < starts.length ? starts[k + 1][0] : src.length;
  // strip outcome prose — only the mechanics matter here
  const body = src.slice(i, end).filter((l) => !/outcome|^\s*[?:]/.test(l)).join(" ");
  const mods = [...body.matchAll(/mods\.(\w+)\s*=\s*([^;]+)/g)].map((m) => [m[1], m[2].trim()]);
  opts.push({ key, event: key.split(":")[0], gamble: /roll\(/.test(body), mods, fields: new Set(mods.map(([f]) => f)) });
}
const byEvent = new Map();
for (const o of opts) byEvent.set(o.event, [...(byEvent.get(o.event) ?? []), o]);

const bad = [];
for (const { key, event, gamble, mods, fields } of opts) {
  if (gamble) continue; // GAMBLE — trusted (both branches share one roll)
  if (!mods.length) continue; // SKIP
  // structural mods ARE the trade — a club/nation/role/trophy/国家队席位 swap carries its own cost
  if (mods.some(([f]) => /newClubId|newNationalityId|forceRetire|nationalTournament|roleOverride|roleShift|suspended|ProbabilityMultiplier|worldCupResult/.test(f))) continue;

  // OVR delta 解析：三段 (immediate/permanent/deferred) 已合并成单个 overallDelta，
  //  赋值形如 `mods.overallDelta = (mods.overallDelta ?? 0) + (X)`（同分支多段累加求和）。
  //  只解析简单 `+ (数字)` 形式以判定纯奖励/纯惩罚；复杂表达式（ternary/Math/变量）
  //  判不了符号 → 跳过（不误报）。这样 master 上那 8 个简单 +N 纯奖励仍被标出。
  const ovrNums = [];
  for (const [f, v] of mods.filter(([f]) => /overallDelta/i.test(f))) {
    const simple = v.match(/^\(mods\.overallDelta \?\? 0\)\s*\+\s*\((-?\d+(?:\.\d+)?)\)$/);
    if (simple) ovrNums.push(Number(simple[1]));
  }
  const pos = ovrNums.some((n) => n > 0), neg = ovrNums.some((n) => n < 0);

  // 机会成本也是代价。一个选项自身没有内在惩罚，不等于它是白拿的 —— 只要兄弟
  // 选项能给出它给不了的东西（状态词条 / 奖杯概率 / 国家队席位 / 一次赌注），选它
  // 就等于放弃那样东西，这正是 Sid Meier 意义上的取舍。真正坏掉的只有一种形状：
  // 兄弟给的你全都有，你还给得更多 —— 那就永远只有一个正确答案
  // (game-design-core validations: dominant-strategy「If there's always a right
  // answer, there's no real choice」)。旧版只看单个选项内部有没有负号，于是把 7 个
  // 正当的「跨选项换轴」误报成纯奖励，真正被支配的那一个反而淹在里面。
  const siblings = (byEvent.get(event) ?? []).filter((s) => s.key !== key);
  if (siblings.some((s) => s.gamble || [...s.fields].some((f) => !fields.has(f)))) continue;

  const rivals = [...new Set(siblings.map((s) => s.key.split(":")[1]))].join(" / ") || "无兄弟选项";
  if (pos && !neg) bad.push(`DOMINANT  ${key}  (与 ${rivals} 只差数值大小，永远有唯一正确答案 — 让两边换不同的轴，或加 roll(p))`);
  else if (neg && !pos) bad.push(`PURE_PENALTY ${key}  (必挨惩罚、零收益 — 加 roll(p) 和奖励分支)`);
}

if (bad.length) {
  console.error(`${bad.length} 个选项违反奖惩形态：\n` + bad.join("\n"));
  process.exit(1);
}
console.log(`OK — ${starts.length} 个选项全部符合 SKIP / GAMBLE / TRADE 形态`);
