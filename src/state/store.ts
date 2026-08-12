/**
 * State store — a single useReducer over GameState + MetaSave.
 *
 * The reducer is pure: given an action and the current state it returns a new
 * state. The engine functions in run.ts are the only thing that mutates the
 * sim; this layer just routes UI intents (start run, advance period, pick a
 * choice, retire, buy blessing, set ascension) to those functions and persists
 * meta-progress side effects to localStorage.
 */
import { useReducer, useEffect, useCallback, useRef } from "react";
import { seniorCareerSeasonCount, seniorCareerStats, type GameState } from "../engine/types";
import { tournamentOffset } from "../engine/data";
import { submitCareer } from "../api/leaderboard";
import {
  createRun, simulatePeriod, resolveChoice, rebuildFiredEvent, type RunSetup,
} from "../engine/run";
import {
  loadMeta, saveMeta,
  saveArchiveEntry, clearArchive, loadArchive,
  saveDailyResult, loadDailyResults,
  loadLoginBonus, recordDailyBonus,
} from "../meta/persist";
import {
  type MetaSave, applyRunResult, purchaseBlessing,
  legacyRank, randomSeed, dailySeed, defaultMeta,
  type CareerArchiveEntry,
  applyPrestige, prestigeEligible, prestigeChoices, PRESTIGE_LEGACY_THRESHOLD,
  dailyStreak, todayStr, type DailyResult,
  mergeCollection, newlyCollectedTrophies, newlyCollectedAchievements, computeAchievementInput,
  applyLoginBonus, type LoginBonus,
  resolveLoadout, MAX_LOADOUT,
} from "../meta/legacy";

export type Action =
  | { type: "START_RUN"; setup: RunSetup }
  | { type: "ADVANCE" }                       // simulate next period
  | { type: "CHOOSE"; choiceId: string }     // resolve pending decision
  | { type: "ABORT_RUN" }                     // back to menu mid-run
  | { type: "BUY_BLESSING"; blessingId: string }
  | { type: "SET_LOADOUT"; ids: readonly string[] }  // equip blessings for runs (≤ MAX_LOADOUT)
  | { type: "SET_ASCENSION"; level: number }
  | { type: "PRESTIGE"; perkId: string }     // sacrifice blessings+legacy → permanent perk
  | { type: "DISMISS_MILESTONE" }            // clear pendingMilestone after celebration
  | { type: "TOGGLE_SOUND" }                 // sfx on/off
  | { type: "TOGGLE_HAPTICS" }               // vibration on/off
  | { type: "TO_MENU" }
  | { type: "CLEAR_ARCHIVE" }
  | { type: "ADD_LEGACY"; amount: number };  // 隐藏后门：菜单连点版本号加可花费传承

export interface AppRoot {
  game: GameState | null;
  meta: MetaSave;
  /** last setup used, for one-tap quick restart with the same config. */
  lastSetup: RunSetup | null;
  /** finished-career archive (母本 archive:v1) — browsable past runs. */
  archive: readonly CareerArchiveEntry[];
  /** daily-challenge results (P4) — local leaderboard. */
  daily: readonly DailyResult[];
  /** P-A121: daily login bonus state. */
  loginBonus: LoginBonus;
}

// ───────────────────────────── active-game autosave (P-A7: resume-at-decision) ─────────────────────────────
// Persist the active GameState to localStorage on every change so a player
// interrupted mid-career (the TikTok visitor who swipes away) returns directly
// to their pending decision on reload — never back at the menu. Cleared on
// retire/abort so a finished career doesn't ghost-restore.

const GAME_KEY = "pitch-reincarnation:game:v1";

function saveGame(game: GameState | null): void {
  try {
    if (game && game.phase === "playing") localStorage.setItem(GAME_KEY, JSON.stringify(game));
    else localStorage.removeItem(GAME_KEY);
  } catch { /* storage unavailable; fail silently */ }
}
function loadGame(): GameState | null {
  try {
    const raw = localStorage.getItem(GAME_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as GameState;
    // Backfill tournamentOffset for careers saved before it existed (derived
    // from the seed, so it's deterministic and matches what createRun sets).
    if (g.phase === "playing" && g.tournamentOffset === undefined) {
      return { ...g, tournamentOffset: tournamentOffset(g.seed) };
    }
    // only resume an active career, never a finished one
    return g.phase === "playing" ? g : null;
  } catch { return null; }
}

const INITIAL_GAME: GameState | null = null;

/** Settle a career that reached an authored ending: score legacy, archive it,
 *  record the daily result, merge collections, and apply legacy to meta.
 *  Age / no-offers / medical / narrative retirements end inside the engine and
 *  settle here. The always-available top-bar exit dispatches ABORT_RUN instead,
 *  so an unfinished career never reaches summary, archive, meta, or upload. */
function settleRun(state: AppRoot, ended: GameState): AppRoot {
  const { meta } = state;
  // 传承 = 生涯末评价（scoreLegacy）。finalizeRun 已经结算好 legacy/rawLegacy
  // 并把 dignifiedExit 计入其中，所以这里 READ 而不是重算：过去这里重跑
  // liveLegacy(ended) 且不传 dignifiedExit，再用结果覆盖 ended.legacy，
  // 于是「体面退场」的 ×1.25 荣誉奖励被整条丢弃（结算页、归档、meta、上传
  // 全部拿到未带体面加成的分）——DIGNIFIED_EXIT_MULT 从未真正到过玩家手上。
  const runLegacy = ended.legacy;
  // 实绩 = 同一生涯按飞升 0 结算。ADR-0006 identity 后 legacy = rawLegacy，
  // 二者同值；评级/称号/归档档位读 rawLegacy（难度无关语义）。
  const runRaw = ended.rawLegacy;
  // 指定种子（debut console custom mode）：可复现的种子不得刷任何 meta 奖励。
  // 仍算出传承分供结算页展示与分享比较，但 meta 一字不改——不归档、不计数、
  // 不加传承、不更新最佳、不解锁、不合入奖杯/成就收藏。结算页会显式提示「不结算」。
  if (ended.customSeed) {
    return {
      ...state,
      game: { ...ended, legacy: runLegacy, newCollectedTrophies: [], newCollectedAchievements: [] },
      meta, archive: state.archive, daily: state.daily, loginBonus: state.loginBonus,
    };
  }
  // archive the finished career (母本 archive:v1) — browsable from the menu.
  const rank = legacyRank(runRaw).name;
  const reason = ended.retirementReason ?? "voluntary";
  // career totals + headline honors — the same numbers buildPayload uploads to
  // the cloud board, so the personal archive renders with the SAME honor-led
  // card as the server leaderboard (the two dimensions share one design).
  const clubCount = new Set(ended.seasons.map((s) => s.clubId)).size;
  const seniorSeasons = seniorCareerSeasonCount(ended.seasons);
  const totals = seniorCareerStats(ended.seasons);
  const entry: CareerArchiveEntry = {
    seed: ended.seed,
    name: ended.player?.name ?? "?",
    position: ended.player?.position ?? "?",
    nationalityId: ended.player?.nationalityId ?? "?",
    legacy: runLegacy,
    maxOverall: ended.maxOverall,
    seasons: seniorSeasons,
    trophies: ended.trophies.length,
    awards: ended.awards.length,
    rank,
    reason,
    ascension: ended.ascension,
    loadout: (ended.loadout ?? []).join(","),
    clubCount,
    goals: totals.goals,
    assists: totals.assists,
    appearances: totals.appearances,
    cleanSheets: totals.cleanSheets,
    goalsConceded: totals.goalsConceded,
    wonWorldCup: ended.trophies.includes("world_cup"),
    wonBallonDor: ended.awards.includes("ballon_dor"),
    wonGoldenBoot: ended.awards.includes("golden_boot"),
    wonGoldenGlove: ended.awards.includes("golden_glove"),
  };
  const archive = saveArchiveEntry(entry);
  // P4: record the daily-challenge result. Keyed on the dailyDate stamped at
  // START_RUN, not on a seed match: the seed alone says nothing about the
  // nat/pos/league the run was actually played with, so a casual run that
  // merely borrowed today's seed used to be filed as a daily result (and
  // shared with the official setup printed next to a score from a different
  // career entirely). Requiring today's date also means a daily link opened
  // tomorrow no longer silently fails to record.
  let daily = state.daily;
  let loginBonus = state.loginBonus;
  let dailyBonus = 0;
  const today = todayStr();
  if (ended.dailyDate === today) {
    // Mechanics review: the streak bonus is granted on the FIRST completion of
    // today's daily challenge (earned by play — replaces the login handout).
    const firstToday = !state.daily.some((e) => e.date === today);
    daily = saveDailyResult({
      date: today, seed: ended.seed, legacy: runLegacy, rank,
      maxOverall: ended.maxOverall, seasons: seniorSeasons, trophies: ended.trophies.length,
    });
    if (firstToday) {
      const streak = dailyStreak(daily);
      dailyBonus = Math.min(30, 3 + streak * 3);
      loginBonus = recordDailyBonus(streak, dailyBonus);
    }
  }
  // P6: merge trophy/achievement collection, then apply legacy. Capture the
  // newly-collected items so the summary screen can show "NEW!" highlights.
  const achInput = computeAchievementInput(ended);
  const newTrophies = newlyCollectedTrophies(meta, ended.trophies);
  const newAchievements = newlyCollectedAchievements(meta, achInput);
  const metaWithCollection = mergeCollection(meta, achInput);
  let metaFinal = applyRunResult(metaWithCollection, runLegacy, ended.ascension, runRaw);
  if (dailyBonus > 0) metaFinal = applyLoginBonus(metaFinal, dailyBonus);
  return {
    ...state,
    game: { ...ended, legacy: runLegacy, newCollectedTrophies: newTrophies, newCollectedAchievements: newAchievements.map((a) => a.id) },
    meta: metaFinal, archive, daily, loginBonus,
  };
}

function rootReducer(state: AppRoot, action: Action): AppRoot {
  const { game, meta } = state;
  switch (action.type) {
    case "START_RUN": {
      // Mechanics review: only the EQUIPPED loadout (≤ MAX_LOADOUT) is active,
      // not every blessing ever bought — build-defining blessings are a choice.
      const loadout = resolveLoadout(meta);
      const game = createRun({ ...action.setup, blessings: loadout, ascension: meta.ascension, permPerks: meta.permPerks });
      // immediately simulate the first period so the player lands on a decision
      const started = simulatePeriod({ ...game, blessings: game.blessings, permPerks: meta.permPerks });
      return { ...state, game: started, lastSetup: action.setup };
    }
    case "ADVANCE": {
      if (!game || game.phase !== "playing" || game.pendingChoice) return state;
      const next = simulatePeriod(game);
      return next.phase === "summary" ? settleRun(state, next) : { ...state, game: next };
    }
    case "CHOOSE": {
      if (!game || !game.pendingChoice) return state;
      const choice = game.pendingChoice.choices.find((c) => c.id === action.choiceId);
      if (!choice) return state;
      let next = resolveChoice(game, choice);
      // immediately advance into the next period after a choice (choice = end of period).
      // A retirement choice (forceRetire pending) is the exception: it banks the
      // farewell / 挂靴 / medical verdict as lastOutcome, and the career ends on
      // the NEXT advance — so hold here and let the PlayScreen auto-beat reveal
      // that verdict first, then advance() → simulatePeriod → finalizeRun →
      // summary. Without this a retirement choice jumped straight to the
      // summary and the player never saw the consequence of their last pick.
      if (next.phase === "playing" && !next.pendingChoice && !next.pendingMods?.forceRetire) {
        next = simulatePeriod(next);
      }
      // Engine-authored retirement (age / no offers / medical / narrative) settles normally.
      return next.phase === "summary" ? settleRun(state, next) : { ...state, game: next };
    }
    case "ABORT_RUN":
    case "TO_MENU":
      return { ...state, game: INITIAL_GAME };
    case "BUY_BLESSING": {
      const next = purchaseBlessing(meta, action.blessingId);
      if (!next) return state;
      // auto-equip into a free loadout slot so a fresh purchase is felt immediately.
      const equipped = resolveLoadout(next);
      const metaNext = equipped.length < MAX_LOADOUT && !equipped.includes(action.blessingId)
        ? { ...next, loadout: [...equipped, action.blessingId] }
        : next;
      return { ...state, meta: metaNext };
    }
    case "SET_LOADOUT":
      return { ...state, meta: { ...meta, loadout: action.ids.filter((id) => meta.ownedBlessings.includes(id)).slice(0, MAX_LOADOUT) } };
    case "SET_ASCENSION":
      return { ...state, meta: { ...meta, ascension: action.level } };
    case "PRESTIGE": {
      const next = applyPrestige(meta, action.perkId);
      return next ? { ...state, meta: next } : state;
    }
    case "DISMISS_MILESTONE": {
      if (!game) return state;
      return { ...state, game: { ...game, pendingMilestone: undefined } };
    }
    case "TOGGLE_SOUND":
      return { ...state, meta: { ...meta, soundOn: meta.soundOn === false } };
    case "TOGGLE_HAPTICS":
      return { ...state, meta: { ...meta, hapticsOn: meta.hapticsOn === false } };
    case "CLEAR_ARCHIVE":
      clearArchive();
      return { ...state, archive: [] };
    case "ADD_LEGACY":
      // 隐藏后门（菜单连点版本号五次）：直接加可花费传承，不计入 all-time、
      // 不触发解锁，与每日奖励 applyLoginBonus 一致——纯调试/手感用。
      return { ...state, meta: { ...meta, totalLegacy: meta.totalLegacy + action.amount } };
    default:
      return state;
  }
}

export function useGameStore() {
  // meta is loaded once; persisted on every change. The active game is
  // restored from autosave on init (P-A7: resume-at-decision) so an
  // interrupted career returns directly to its pending decision.
  const [root, dispatch] = useReducer(rootReducer, null, (): AppRoot => {
    // Mechanics review: no auto-claim on load — the daily bonus is granted in
    // settleRun when today's DAILY CHALLENGE is completed (earned by play).
    const root: AppRoot = { game: loadGame(), meta: loadMeta(), lastSetup: null, archive: loadArchive(), daily: loadDailyResults(), loginBonus: loadLoginBonus() };
    // pendingResolve 是函数，不可序列化——刷新后从 game + pendingChoice 重建
    // （否则 resolveChoice 因 !pendingResolve 直接 return，决策卡死）。
    if (root.game && root.game.pendingChoice && !root.game.pendingResolve) {
      // 刷新后 pendingResolve（函数）丢失，从 game + pendingChoice 重建。同时
      // 重跑 builder 刷新 choices，让转会定位标签反映本期已累积的 pendingMods
      // （特殊事件降档 → 随后转会窗定位降档），与持久化前的出队重建口径一致。
      const fe = rebuildFiredEvent(root.game);
      root.game = { ...root.game, pendingChoice: fe?.event ?? root.game.pendingChoice, pendingResolve: fe?.resolve };
    }
    return root;
  });

  useEffect(() => {
    saveMeta(root.meta);
  }, [root.meta]);
  // P-A7: autosave the active game on every state change.
  useEffect(() => {
    saveGame(root.game);
  }, [root.game]);

  // Cloud intake: silently upload every settled career (no opt-in — per product
  // decision) so the backend's engine-tuning analysis has a real-player sample.
  // Lives outside the reducer (a pure function) as a side effect. Deduped by the
  // game object's identity: a fresh settle produces a new object, so it uploads
  // once; React StrictMode's double-invoked effect sees the same reference the
  // second time and skips. customSeed runs never upload (reproducible, no meta).
  const reportedRef = useRef<GameState | null>(null);
  useEffect(() => {
    const g = root.game;
    if (g && g.phase === "summary" && !g.customSeed && g !== reportedRef.current) {
      reportedRef.current = g;
      void submitCareer(g);
    }
  }, [root.game]);

  const startRun = useCallback((setup: RunSetup) => dispatch({ type: "START_RUN", setup }), []);
  const advance = useCallback(() => dispatch({ type: "ADVANCE" }), []);
  const choose = useCallback((choiceId: string) => dispatch({ type: "CHOOSE", choiceId }), []);
  const abortRun = useCallback(() => dispatch({ type: "ABORT_RUN" }), []);
  const toMenu = useCallback(() => dispatch({ type: "TO_MENU" }), []);
  const buyBlessing = useCallback((blessingId: string) => dispatch({ type: "BUY_BLESSING", blessingId }), []);
  const setLoadout = useCallback((ids: readonly string[]) => dispatch({ type: "SET_LOADOUT", ids }), []);
  const setAscension = useCallback((level: number) => dispatch({ type: "SET_ASCENSION", level }), []);
  const prestige = useCallback((perkId: string) => dispatch({ type: "PRESTIGE", perkId }), []);
  const dismissMilestone = useCallback(() => dispatch({ type: "DISMISS_MILESTONE" }), []);
  const toggleSound = useCallback(() => dispatch({ type: "TOGGLE_SOUND" }), []);
  const toggleHaptics = useCallback(() => dispatch({ type: "TOGGLE_HAPTICS" }), []);
  const clearArchiveFn = useCallback(() => dispatch({ type: "CLEAR_ARCHIVE" }), []);
  const addLegacy = useCallback((amount: number) => dispatch({ type: "ADD_LEGACY", amount }), []);

  return {
    game: root.game,
    meta: root.meta,
    lastSetup: root.lastSetup,
    archive: root.archive,
    daily: root.daily,
    loginBonus: root.loginBonus,
    startRun, advance, choose, abortRun, toMenu, buyBlessing, setLoadout, setAscension, prestige, dismissMilestone, toggleSound, toggleHaptics,
    clearArchive: clearArchiveFn,
    addLegacy,
    newSeed: randomSeed,
    dailySeed,
    dailyStreak,
    legacyRank,
    defaultMeta,
    prestigeEligible, prestigeChoices, PRESTIGE_LEGACY_THRESHOLD,
  };
}
