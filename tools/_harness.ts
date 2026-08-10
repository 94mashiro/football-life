/**
 * 批量模拟的共享底座 — 所有 probe / regress 都从这里拿「跑一局生涯」的能力。
 *
 * 在这个文件之前，tools/ 里 49 个脚本各自抄了一遍同一个 while 循环（外加 7 份
 * 分位数、4 份种子生成器）。引擎签名一改就是 49 处编辑。这里只提供一份。
 *
 * 三件事：
 *   drive()      —— headless 驱动一局完整生涯，返回可比对的 CareerTrace
 *   POLICIES     —— 确定性的选择策略（first / last / varied），覆盖不同分支路径
 *   quantile 等  —— 统计小工具
 *
 * headless 语义：drive() 关掉 optionPreview（预览药丸走自己的 derive 流，
 * 与生涯 RNG 完全隔离，关掉不改变任何结果——tools/regress.ts 会用「开/关两次
 * 摘要必须相同」来守住这个前提）。实测省掉约 40% 的模拟 CPU。
 */
import { createRun, simulatePeriod, resolveChoice, liveLegacy, type RunSetup } from "../src/engine/run";
import { setPreviewsEnabled } from "../src/engine/events";
import { hash } from "../src/engine/rng";
import type { GameState, Choice, Trophy, Award } from "../src/engine/types";
import type { Position } from "../src/engine/data";

setPreviewsEnabled(false);

// ───────────────────────────── setups & policies ─────────────────────────────

export interface Profile {
  readonly id: string;
  readonly nationalityId: string;
  readonly position: Position;
  readonly leagueId: string;
  readonly pace: "long" | "normal" | "express";
  readonly blessings: readonly string[];
  readonly ascension: number;
  readonly allowWonderkid?: boolean;
  readonly permPerks?: readonly string[];
}

/** A decision policy: given the pending choices, pick one. Must be a pure
 *  function of (choices, key, periodIndex, seed) so a replay is byte-identical. */
export type Policy = (choices: readonly Choice[], key: string, periodIndex: number, seed: string, state?: GameState) => Choice;

export const POLICIES: Record<string, Policy> = {
  /** 永远第一项 —— 多数事件的「稳」分支，probe 的历史默认。 */
  first: (cs) => cs[0]!,
  /** 永远最后一项 —— 多数事件的「赌」分支，走另一条极端路径。 */
  last: (cs) => cs[cs.length - 1]!,
  /** 按 (seed, key, period) 哈希取项 —— 一条散开的中间路径，能碰到 first/last
   *  两端都碰不到的中间选项（3+ 选项的转会/报价事件）。 */
  varied: (cs, key, periodIndex, seed) => cs[hash(`${seed}|${key}|${periodIndex}`) % cs.length]!,
};

// ───────────────────────────── the driver ─────────────────────────────

export interface CareerTrace {
  readonly seed: string;
  readonly profileId: string;
  readonly policyId: string;
  readonly peakOvr: number;
  readonly seasons: number;
  readonly finalAge: number;
  readonly legacy: number;
  readonly retireReason: string;
  readonly trophies: readonly Trophy[];
  readonly awards: readonly Award[];
  /** 转会足迹：依次待过的俱乐部 id。 */
  readonly clubPath: readonly string[];
  /** 面对过的决策 key + 选中的 option id，按顺序。 */
  readonly decisions: readonly string[];
  /** 逐季关键数字，摘要对全季有敏感度（不只是终值）。 */
  readonly seasonLine: readonly string[];
  /** 本局遇到的全部文案：事件标题/描述/选项文本/结算文本，按顺序。
   *  单独成一列指纹（见 copyDigest），不混进行为指纹 —— 改一个字的文案不该
   *  把 3600 局全标成「行为已变」，否则真正的行为漂移就被淹掉了。 */
  readonly copy: readonly string[];
}

const GUARD = 400;

export function drive(seed: string, p: Profile, policy: Policy, policyId = "?"): CareerTrace {
  const setup: RunSetup = {
    seed,
    nationalityId: p.nationalityId,
    position: p.position,
    leagueId: p.leagueId,
    pace: p.pace,
    blessings: p.blessings,
    ascension: p.ascension,
    allowWonderkid: p.allowWonderkid,
    permPerks: p.permPerks ?? [],
  };
  let g: GameState = simulatePeriod(createRun(setup));
  const decisions: string[] = [];
  const copy: string[] = [];
  let guard = 0;
  while (g.phase === "playing" && guard++ < GUARD) {
    if (g.pendingChoice) {
      const ev = g.pendingChoice;
      const cs = ev.choices;
      if (cs.length === 0) break;
      // 玩家这一拍真正读到的字：卡面 + 每个选项。选项全收（不只选中的那个），
      // 所以「改了没被选中的那条文案」也照样能发现。
      copy.push(`E ${ev.key}|${ev.title}|${ev.desc}`);
      for (const c of cs) copy.push(`O ${c.id}|${c.text}|${c.sub ?? ""}`);
      const chosen = policy(cs, ev.key, g.seasons.length, seed, g);
      decisions.push(`${ev.key}:${chosen.id}`);
      g = resolveChoice(g, chosen);
      copy.push(`R ${g.lastOutcome ?? ""}|${g.lastOutcomeGood ?? ""}|${g.lastOutcomeTone ?? ""}`);
      if (g.phase === "playing" && !g.pendingChoice) g = simulatePeriod(g);
    } else {
      g = simulatePeriod(g);
    }
  }
  // 生涯故事线（赛季叙事 beat）—— 也是玩家读到的字，同样进文案指纹。
  for (const b of g.careerBeats ?? []) copy.push(`B ${b.age}|${b.tone}|${b.text}`);
  const clubPath: string[] = [];
  const seasonLine: string[] = [];
  for (const s of g.seasons) {
    if (clubPath[clubPath.length - 1] !== s.clubId) clubPath.push(s.clubId);
    const st = s.stats;
    seasonLine.push(`${s.age},${s.clubId},${s.role},${s.overall},${st.appearances}/${st.goals}/${st.assists}/${st.cleanSheets}`);
  }
  return {
    seed,
    profileId: p.id,
    policyId,
    peakOvr: g.maxOverall ?? 0,
    seasons: g.seasons.length,
    finalAge: g.seasons[g.seasons.length - 1]?.age ?? 16,
    legacy: Math.round(liveLegacy(g)),
    retireReason: g.retirementReason ?? "",
    trophies: g.trophies,
    awards: g.awards,
    clubPath,
    decisions,
    seasonLine,
    copy,
  };
}

// ───────────────────────────── digest ─────────────────────────────

/** 一局生涯的规范串 —— 摘要就是它的哈希。包含逐季数据 + 决策序列，所以任何
 *  引擎行为变化都会体现出来（不止终值分布落在阈值带内那种「看不见的漂移」）。 */
export function canonical(t: CareerTrace): string {
  return [
    t.peakOvr, t.seasons, t.finalAge, t.legacy, t.retireReason,
    t.trophies.join("+"), t.awards.join("+"), t.clubPath.join(">"),
    t.decisions.join(";"), t.seasonLine.join("|"),
  ].join("~");
}

/** FNV-1a over the canonical string, base36. 沿用 rng.ts 的哈希，不另造一个。 */
export function digest(t: CareerTrace): string {
  return hash(canonical(t)).toString(36).padStart(7, "0");
}

/** 文案指纹 —— 与行为指纹分开。改一个字的事件描述，行为指纹必须纹丝不动，
 *  只有这一列变；反过来，纯数值调整不该动这一列。两列各自独立报告，谁都
 *  淹不掉谁。 */
export function copyDigest(t: CareerTrace): string {
  return hash(t.copy.join("\n")).toString(36).padStart(7, "0");
}

// ───────────────────────────── stats helpers ─────────────────────────────

/** 第 q 分位（0..1），线性最近秩。空数组返回 0。 */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function shareOf(xs: readonly number[], pred: (x: number) => boolean): number {
  return xs.length === 0 ? 0 : xs.filter(pred).length / xs.length;
}

/** 确定性种子生成器 —— 取代 4 份各自实现的 hashSeed。 */
export function corpusSeed(i: number): string {
  return `regress-${i}-${hash(`corpus:${i}`).toString(36)}`;
}
