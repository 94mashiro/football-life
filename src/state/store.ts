/**
 * State store — a single useReducer over GameState + MetaSave.
 *
 * The reducer is pure: given an action and the current state it returns a new
 * state. The engine functions in run.ts are the only thing that mutates the
 * sim; this layer just routes UI intents (start run, advance period, pick a
 * choice, retire, buy blessing, set ascension) to those functions and persists
 * meta-progress side effects to localStorage.
 */
import { useReducer, useEffect, useCallback } from "react";
import type { GameState } from "../engine/types";
import { tournamentOffset } from "../engine/data";
import {
  createRun, simulatePeriod, resolveChoice, retireNow, type RunSetup,
} from "../engine/run";
import {
  type MetaSave, loadMeta, saveMeta, applyRunResult, purchaseBlessing,
  scoreLegacy, legacyRank, randomSeed, dailySeed, defaultMeta,
  saveArchiveEntry, clearArchive, loadArchive, type CareerArchiveEntry,
  applyPrestige, prestigeEligible, prestigeChoices, PRESTIGE_LEGACY_THRESHOLD,
  saveDailyResult, loadDailyResults, dailyStreak, todayStr, type DailyResult,
  mergeCollection, newlyCollectedTrophies, newlyCollectedAchievements, computeAchievementInput,
  loadLoginBonus, checkDailyLogin, applyLoginBonus, type LoginBonus,
} from "../meta/legacy";

export type Action =
  | { type: "START_RUN"; setup: RunSetup }
  | { type: "ADVANCE" }                       // simulate next period
  | { type: "CHOOSE"; choiceId: string }     // resolve pending decision
  | { type: "RETIRE" }                        // voluntary retire
  | { type: "ABORT_RUN" }                     // back to menu mid-run
  | { type: "BUY_BLESSING"; blessingId: string }
  | { type: "SET_ASCENSION"; level: number }
  | { type: "PRESTIGE"; perkId: string }     // sacrifice blessings+legacy → permanent perk
  | { type: "DISMISS_MILESTONE" }            // clear pendingMilestone after celebration
  | { type: "TOGGLE_PURIST" }                // hide/show visible odds (hardcore mode)
  | { type: "TOGGLE_SOUND" }                 // sfx on/off
  | { type: "TO_MENU" }
  | { type: "CLEAR_ARCHIVE" };

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

/** Settle a finished run: score legacy, archive the career, record the daily
 *  result, merge the trophy/achievement collection, apply legacy to meta.
 *  Shared by voluntary RETIRE and forced retirements (age / no offers /
 *  medical) that end the run inside simulatePeriod — previously the forced
 *  paths reached the summary screen without ever being scored. */
function settleRun(state: AppRoot, ended: GameState): AppRoot {
  const { meta } = state;
  const careerWageTotal = ended.seasons.reduce((sum, s) => sum + (s.wage ?? 0), 0);
  const finalMarketValue = ended.seasons.length > 0 ? (ended.seasons[ended.seasons.length - 1]!.marketValue ?? 0) : 0;
  const runLegacy = scoreLegacy(ended.maxOverall, ended.seasons.length, ended.trophies, ended.awards, ended.ascension, ended.retirementReason, ended.challenge, careerWageTotal, finalMarketValue, ended.eventLegacy ?? 0);
  // archive the finished career (母本 archive:v1) — browsable from the menu.
  const rank = legacyRank(runLegacy).name;
  const reason = ended.retirementReason ?? "voluntary";
  const entry: CareerArchiveEntry = {
    seed: ended.seed,
    name: ended.player?.name ?? "?",
    position: ended.player?.position ?? "?",
    nationalityId: ended.player?.nationalityId ?? "?",
    legacy: runLegacy,
    maxOverall: ended.maxOverall,
    seasons: ended.seasons.length,
    trophies: ended.trophies.length,
    awards: ended.awards.length,
    rank,
    reason,
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
  const today = todayStr();
  if (ended.dailyDate === today) {
    daily = saveDailyResult({
      date: today, seed: ended.seed, legacy: runLegacy, rank,
      maxOverall: ended.maxOverall, seasons: ended.seasons.length, trophies: ended.trophies.length,
    });
  }
  // P6: merge trophy/achievement collection, then apply legacy. Capture the
  // newly-collected items so the summary screen can show "NEW!" highlights.
  const achInput = computeAchievementInput(ended);
  const newTrophies = newlyCollectedTrophies(meta, ended.trophies);
  const newAchievements = newlyCollectedAchievements(meta, achInput);
  const metaWithCollection = mergeCollection(meta, achInput);
  const metaFinal = applyRunResult(metaWithCollection, runLegacy);
  return {
    ...state,
    game: { ...ended, legacy: runLegacy, newCollectedTrophies: newTrophies, newCollectedAchievements: newAchievements.map((a) => a.id) },
    meta: metaFinal, archive, daily,
  };
}

function rootReducer(state: AppRoot, action: Action): AppRoot {
  const { game, meta } = state;
  switch (action.type) {
    case "START_RUN": {
      const game = createRun({ ...action.setup, blessings: meta.ownedBlessings, ascension: meta.ascension, permPerks: meta.permPerks, challenge: action.setup.challenge });
      // immediately simulate the first period so the player lands on a decision
      const started = simulatePeriod({ ...game, blessings: meta.ownedBlessings, permPerks: meta.permPerks });
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
      // immediately advance into the next period after a choice (choice = end of period)
      if (next.phase === "playing" && !next.pendingChoice) {
        next = simulatePeriod(next);
      }
      // a forced retirement (age / no offers / medical) settles like a voluntary one.
      return next.phase === "summary" ? settleRun(state, next) : { ...state, game: next };
    }
    case "RETIRE": {
      // only an ACTIVE run can be retired — a settled summary re-dispatch would
      // double-apply legacy to meta.
      if (!game || game.phase !== "playing") return state;
      return settleRun(state, retireNow(game));
    }
    case "ABORT_RUN":
    case "TO_MENU":
      return { ...state, game: INITIAL_GAME };
    case "BUY_BLESSING": {
      const next = purchaseBlessing(meta, action.blessingId);
      return next ? { ...state, meta: next } : state;
    }
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
    case "TOGGLE_PURIST":
      return { ...state, meta: { ...meta, puristMode: !meta.puristMode } };
    case "TOGGLE_SOUND":
      return { ...state, meta: { ...meta, soundOn: meta.soundOn === false } };
    case "CLEAR_ARCHIVE":
      clearArchive();
      return { ...state, archive: [] };
    default:
      return state;
  }
}

export function useGameStore() {
  // meta is loaded once; persisted on every change. The active game is
  // restored from autosave on init (P-A7: resume-at-decision) so an
  // interrupted career returns directly to its pending decision.
  const [root, dispatch] = useReducer(rootReducer, null, (): AppRoot => {
    const root: AppRoot = { game: loadGame(), meta: loadMeta(), lastSetup: null, archive: loadArchive(), daily: loadDailyResults(), loginBonus: loadLoginBonus() };
    // P-A121: check daily login on init — claim bonus if it's a new day.
    const prevLogin = loadLoginBonus();
    const { bonus, claimable, amount } = checkDailyLogin(prevLogin);
    if (claimable) {
      root.loginBonus = bonus;
      root.meta = applyLoginBonus(root.meta, amount);
      saveMeta(root.meta);
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

  const startRun = useCallback((setup: RunSetup) => dispatch({ type: "START_RUN", setup }), []);
  const advance = useCallback(() => dispatch({ type: "ADVANCE" }), []);
  const choose = useCallback((choiceId: string) => dispatch({ type: "CHOOSE", choiceId }), []);
  const retire = useCallback(() => dispatch({ type: "RETIRE" }), []);
  const abortRun = useCallback(() => dispatch({ type: "ABORT_RUN" }), []);
  const toMenu = useCallback(() => dispatch({ type: "TO_MENU" }), []);
  const buyBlessing = useCallback((blessingId: string) => dispatch({ type: "BUY_BLESSING", blessingId }), []);
  const setAscension = useCallback((level: number) => dispatch({ type: "SET_ASCENSION", level }), []);
  const prestige = useCallback((perkId: string) => dispatch({ type: "PRESTIGE", perkId }), []);
  const dismissMilestone = useCallback(() => dispatch({ type: "DISMISS_MILESTONE" }), []);
  const togglePurist = useCallback(() => dispatch({ type: "TOGGLE_PURIST" }), []);
  const toggleSound = useCallback(() => dispatch({ type: "TOGGLE_SOUND" }), []);
  const clearArchiveFn = useCallback(() => dispatch({ type: "CLEAR_ARCHIVE" }), []);

  return {
    game: root.game,
    meta: root.meta,
    lastSetup: root.lastSetup,
    archive: root.archive,
    daily: root.daily,
    loginBonus: root.loginBonus,
    startRun, advance, choose, retire, abortRun, toMenu, buyBlessing, setAscension, prestige, dismissMilestone, togglePurist, toggleSound,
    clearArchive: clearArchiveFn,
    newSeed: randomSeed,
    dailySeed,
    dailyStreak,
    legacyRank,
    defaultMeta,
    prestigeEligible, prestigeChoices, PRESTIGE_LEGACY_THRESHOLD,
  };
}
