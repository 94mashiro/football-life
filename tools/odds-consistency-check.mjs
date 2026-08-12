// 选项赔率一致性检查 — node tools/odds-consistency-check.mjs
//
// 守的是「shown % == rolled %」不变量里最危险的那一半：每个选项的【基础赔率】
// 在两个地方各写了一遍——optionOdds 的 switch（显示用）和 resolveEventOption
// 里 roll(p, ...) 的字面量（掷骰用）。两边只靠注释约束保持一致；改一边忘了另
// 一边，卡面显示 60% 实际掷 55%，玩家算的 EV 全错，且没有任何测试能抓到（regress
// 的行为指纹只看结果分布，看不出「显示数与掷骰数」是否对得上）。
//
// 本脚本静态核对：对每个 `${key}:${optionKey}`，把 optionOdds 返回的字面量与
// resolve 里 roll(...) 的字面量配对——
//   • positive 目标：roll(p) == optionOdds()        （成功概率两边一致）
//   • negative 目标：roll(p) == 1 - optionOdds()    （失败概率 == 1 − 成功）
// 计算型赔率（positionCompetitionOdds / throneOdds / bossOdds）无法静态比数，
// 跳过；但若一边字面量、一边计算式，标为不一致。多 roll 的选项标「人工复核」。
//
// 这是 candidate #1（折叠分裂的事件定义）的安全替代：全表合并是 ~4800 行的重组，
// 风险太大不宜一次做完；先静态封住漏点，让赔率漂移无法进主线。
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/engine/events.ts", import.meta.url), "utf8").split("\n");

// 找一个顶层 export function 的行范围 [startLine, endLine)（闭括号在行首列 0）。
function fnRange(name) {
  const start = src.findIndex((l) => new RegExp(`^export function ${name}\\(`).test(l));
  if (start < 0) throw new Error(`${name} not found`);
  for (let i = start + 1; i < src.length; i++) {
    if (/^\}/.test(src[i])) return [start, i + 1];
  }
  throw new Error(`${name} close brace not found`);
}

const LIT = /^\d+(?:\.\d+)?$/;
function litNum(expr) {
  const e = expr.trim();
  return LIT.test(e) ? Number(e) : null;
}

// ── 赔率来源（重构后）：基础赔率在目录选项的 `odds` 字段（328 个字面量）+
//   INJURY_DECISION_OPTIONS 常量 + optionOdds 里 9 个计算 case。解析这三处→ ooCases。
//   resolve 的 roll(p,...) 仍是字面量（第二份来源）——本检查守的仍是「显示赔率 ==
//   掷骰赔率」，只是显示赔率现在从目录读，而非一个 332-case switch。
const ooCases = new Map();
const whole = src.join("\n");
// (1) 目录 makeEventDef("KEY", ... { key: "OPT", odds: N, ... })
const defRe = /makeEventDef\("([a-z0-9_]+)"/g;
let dm;
while ((dm = defRe.exec(whole)) !== null) {
  const key = dm[1];
  const openParen = whole.indexOf("(", dm.index);
  // balanced-paren scan to find the call body
  let depth = 1, j = openParen + 1;
  while (depth > 0 && j < whole.length) {
    const c = whole[j];
    if (c === "(") depth++; else if (c === ")") depth--;
    j++;
  }
  const body = whole.slice(openParen + 1, j - 1);
  for (const om of body.matchAll(/\{\s*key:\s*"([a-z0-9_]+)",\s*odds:\s*(\d+(?:\.\d+)?)/g)) {
    ooCases.set(`${key}:${om[1]}`, { literal: Number(om[2]), expr: String(om[2]) });
  }
}
// (2) INJURY_DECISION_OPTIONS 常量（injury 事件的 continue/play_through）
const injStart = src.findIndex((l) => /^const INJURY_DECISION_OPTIONS = \[/.test(l));
if (injStart >= 0) {
  for (let i = injStart; i < injStart + 6; i++) {
    const m = src[i]?.match(/\{ key: "([a-z0-9_]+)", odds: (\d+(?:\.\d+)?)/);
    if (m) ooCases.set(`injury:${m[1]}`, { literal: Number(m[2]), expr: m[2] });
  }
}
// (3) optionOdds 里 9 个 case：字面量返回（medical_verdict/doctor_warning）记为 literal，
//   计算式返回（position_competition/throne/new_coach/6 boss）记 computed。
const [ooStart, ooEnd] = fnRange("optionOdds");
let p3 = [];
for (let i = ooStart; i < ooEnd; i++) {
  const line = src[i];
  if (/^\s*default:/i.test(line)) { p3 = []; continue; }
  // 同行 case + return literal/expr
  const same = line.match(/^\s*case "([a-z0-9_]+:[a-z0-9_]+)":\s*return (.+?);\s*$/);
  if (same) {
    if (!ooCases.has(same[1])) ooCases.set(same[1], { literal: litNum(same[2]), expr: same[2] });
    continue;
  }
  const cm = line.match(/^\s*case "([a-z0-9_]+:[a-z0-9_]+)":/i);
  if (cm) { p3.push(cm[1]); continue; }
  const rm = line.match(/^\s*return (.+?);\s*$/);
  if (rm && p3.length > 0) {
    for (const k of p3) if (!ooCases.has(k)) ooCases.set(k, { literal: litNum(rm[1]), expr: rm[1] });
    p3 = [];
  }
}

// ── resolveEventOption：解析每个 `case "k:o":` → 其块内所有 roll(arg, "target")。
const [reStart, reEnd] = fnRange("resolveEventOption");
const reCases = new Map();
let curKey = null;
let curRolls = [];
const flush = () => {
  if (curKey !== null) reCases.set(curKey, { rolls: curRolls });
  curKey = null; curRolls = [];
};
for (let i = reStart; i < reEnd; i++) {
  const line = src[i];
  const cm = line.match(/^\s*case "([a-z0-9_]+:[a-z0-9_]+)":/i);
  if (cm) { flush(); curKey = cm[1]; curRolls = []; continue; }
  if (curKey === null) continue;
  // 忽略注释里的 roll(...)（选项块无 http://，// 截断安全）
  const code = line.replace(/\/\/.*$/, "");
  for (const rm of code.matchAll(/roll\((.+?),\s*"(positive|negative)"\)/g)) {
    const arg = rm[1].trim();
    curRolls.push({ arg, target: rm[2], literal: litNum(arg) });
  }
}
flush();

const bad = [];
let checked = 0, skippedComputed = 0, multiRoll = 0;

// 已知的「optionOdds 给了赔率、resolve 却不掷骰」选项——多为当年加二选项baseline 时
// 连带进来的残留显示赔率（resolve 是确定性结果，卡面会坍成「必定」无 % 赌注，
// 不构成 shown≠rolled 的掷骰漂移）。本检查只守【新】漂移；这几条留待逐事件清理。
for (const [k, oo] of ooCases) {
  const re = reCases.get(k);
  if (!re) {
    if (oo.literal !== null) bad.push(`ORPHAN  ${k}  optionOdds 返回 ${oo.expr}，但 resolveEventOption 无此 case（显示有赔率、掷骰缺）`);
    continue;
  }
  if (re.rolls.length === 0) {
    if (oo.literal !== null) bad.push(`NO_ROLL  ${k}  目录给了 odds=${oo.literal}，但 resolve 不 roll（显示是赌注、掷骰是确定）`);
    continue;
  }
  if (re.rolls.length > 1) { multiRoll++; continue; } // 多 roll：人工复核，不强行比数
  const r = re.rolls[0];
  if (oo.literal === null) {
    if (r.literal !== null) bad.push(`MISMATCH ${k}  optionOdds 计算式 (${oo.expr})，roll 用字面量 ${r.literal}`);
    else skippedComputed++;
    continue;
  }
  if (r.literal === null) { bad.push(`MISMATCH ${k}  optionOdds 字面量 ${oo.literal}，roll 用计算式 (${r.arg})`); continue; }
  if (r.target === "positive") {
    if (Math.abs(r.literal - oo.literal) > 1e-9) bad.push(`DRIFT   ${k}  optionOdds=${oo.literal}，roll(${r.literal}, positive) —— 应相等`);
  } else {
    if (Math.abs(r.literal - (1 - oo.literal)) > 1e-9) bad.push(`DRIFT   ${k}  optionOdds=${oo.literal}（成功），roll(${r.literal}, negative) —— 失败应 == 1−成功 = ${(1 - oo.literal).toFixed(2)}`);
  }
  checked++;
}

// 反向：resolve 有 roll 字面量、optionOdds 却无此 case（显示无 %、掷骰有数）
for (const [k, re] of reCases) {
  if (ooCases.has(k)) continue;
  const litRolls = re.rolls.filter((r) => r.literal !== null);
  if (litRolls.length > 0) bad.push(`MISSING ${k}  resolve roll 字面量 ${litRolls.map((r) => r.literal).join("/")}，但 optionOdds 无此 case（显示无赔率）`);
}

if (bad.length) {
  console.error(`${bad.length} 处选项赔率不一致（shown % != rolled %）：\n` + bad.join("\n"));
  process.exit(1);
}
console.log(`OK — ${checked} 对字面量赔率一致（shown == rolled），${skippedComputed} 对计算式跳过，${multiRoll} 个多 roll 选项留人工复核；optionOdds ${ooCases.size} 项 / resolve ${reCases.size} 项`);
