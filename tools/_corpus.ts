/**
 * 回归语料库 —— 固定的 (profile × policy × seed) 集合，`npm run regress` 的输入。
 *
 * 这不是平衡门槛，是「行为指纹」：只要引擎行为变了，这批生涯的摘要就会变。
 * 阈值型 probe 只能发现「分布跑出band」，语料库能发现任何改动，包括落在band
 * 内的意外漂移（改 A 事件顺手动了 B 的漂移，正是最难人肉发现的那种）。
 *
 * 覆盖面刻意撑开：门将/中卫/前锋、三档联赛、三种 pace、祝福/无祝福、飞升 0/5。
 * 改这里 = 换语料库 → 必须 `npm run regress:bless` 重新落基线（CORPUS_VERSION 同步 +1）。
 */
import type { Profile } from "./_harness";

/** 语料库结构版本。改 PROFILES / POLICY_IDS / SEEDS_PER_CELL / canonical() 都要 +1，
 *  基线文件带着它，版本不匹配时 regress 会明确报「语料库变了，需要 bless」而不是
 *  报成一堆假的行为漂移。 */
export const CORPUS_VERSION = 2;

export const PROFILES: readonly Profile[] = [
  { id: "bra-st-epl", nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal", blessings: [], ascension: 0 },
  { id: "eng-cm-epl", nationalityId: "eng", position: "CM", leagueId: "premier-league", pace: "normal", blessings: [], ascension: 0 },
  { id: "chn-st-l1", nationalityId: "chn", position: "ST", leagueId: "china-league-one", pace: "normal", blessings: [], ascension: 0 },
  { id: "eng-gk-epl", nationalityId: "eng", position: "GK", leagueId: "premier-league", pace: "normal", blessings: [], ascension: 0 },
  { id: "esp-cb-liga", nationalityId: "esp", position: "CB", leagueId: "laliga", pace: "express", blessings: [], ascension: 0 },
  { id: "blessed-st", nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal", blessings: ["golden_boy", "sharpshooter", "big_game_player"], ascension: 0 },
  { id: "asc5-st", nationalityId: "bra", position: "ST", leagueId: "premier-league", pace: "normal", blessings: [], ascension: 5 },
  { id: "fra-lw-long", nationalityId: "fra", position: "LW", leagueId: "ligue-1", pace: "long", blessings: ["ironman", "comeback"], ascension: 0 },
];

export const POLICY_IDS = ["first", "last", "varied"] as const;

/** 每个 (profile × policy) 格子的种子数。8 × 3 × 150 = 3600 局。 */
export const SEEDS_PER_CELL = 150;

export const TOTAL_CAREERS = PROFILES.length * POLICY_IDS.length * SEEDS_PER_CELL;
