/**
 * localStorage persistence adapter for the meta-progression save.
 *
 * The seam between deterministic meta logic (`legacy.ts`) and the outside
 * world lives here: every `localStorage` read/write for the five meta stores
 * (meta save, career archive, debut draft, daily results, login bonus) is
 * behind this module. `legacy.ts` stays deterministic — the regression 元进程
 * layer can exercise the pure meta logic without a storage adapter; an
 * in-memory adapter can satisfy this seam in tests/SSR without touching the
 * real `localStorage`.
 *
 * One-way dependency: `persist.ts` imports pure helpers/types from `legacy.ts`
 * (defaultMeta, the migration/normalize helpers, todayStr, the domain
 * record types). `legacy.ts` never imports from here — no cycle.
 */
import {
  defaultMeta, migrateV1, migrateV2, normalizeCounts, normalizeAscensionBests,
  todayStr, VERSION,
  type MetaSave, type CareerArchiveEntry, type SetupDraft, type DailyResult, type LoginBonus,
} from "./legacy";

// ───────────────────────────── meta save (localStorage key v1) ─────────────────────────────
const META_KEY = "pitch-reincarnation:meta:v1";

export function loadMeta(): MetaSave {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return defaultMeta();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version === VERSION) return normalizeAscensionBests(normalizeCounts(parsed as unknown as MetaSave));
    if (parsed.version === 2) return migrateV2(normalizeAscensionBests(normalizeCounts(parsed as unknown as MetaSave)));
    if (parsed.version === 1) return migrateV2(normalizeAscensionBests(normalizeCounts(migrateV1(parsed))));
    return defaultMeta();
  } catch {
    return defaultMeta();
  }
}

export function saveMeta(meta: MetaSave): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    // storage may be unavailable (private mode); fail silently
  }
}

// ───────────────────────────── career archive (母本 archive:v1) ─────────────────────────────
// A localStorage list of finished careers so the player can browse past runs
// from the menu ("从首页就能翻回过去任意一局的战绩卡") — a retention hook.
const ARCHIVE_KEY = "pitch-reincarnation:archive:v1";
const ARCHIVE_MAX = 30;

export function loadArchive(): readonly CareerArchiveEntry[] {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as CareerArchiveEntry[];
  } catch {
    return [];
  }
}

export function saveArchiveEntry(entry: CareerArchiveEntry): readonly CareerArchiveEntry[] {
  const existing = loadArchive();
  const next = [entry, ...existing].slice(0, ARCHIVE_MAX);
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable; fail silently
  }
  return next;
}

export function clearArchive(): void {
  try {
    localStorage.removeItem(ARCHIVE_KEY);
  } catch {
    // noop
  }
}

// ───────────────────────────── debut console draft (persisted menu config) ─────────────────────────────
// The debut console's player-identity + career config (name, number, nation,
// position, academy club, pace). Persisted so a page refresh restores the last
// configuration the player was working with instead of resetting to defaults —
// the menu no longer forgets who you were creating. Deliberately a SEPARATE
// store from lastSetup (the last STARTED run's full RunSetup): that one carries
// stale meta-driven fields (blessings/ascension/perks) and only updates on run
// start; this is the live, player-editable surface, saved on every change.
const SETUP_KEY = "pitch-reincarnation:setup:v1";

export function loadSetupDraft(): SetupDraft | null {
  try {
    const raw = localStorage.getItem(SETUP_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SetupDraft;
  } catch {
    return null;
  }
}

export function saveSetupDraft(draft: SetupDraft): void {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(draft));
  } catch {
    // storage unavailable; fail silently
  }
}

// ───────────────────────────── daily leaderboard (P4) ─────────────────────────────
// A local-only record of the player's daily-challenge results, so they can
// track their streak and compare with friends via shared cards. No backend.
const DAILY_KEY = "pitch-reincarnation:daily:v1";
const DAILY_MAX = 60;

export function loadDailyResults(): readonly DailyResult[] {
  try {
    const raw = localStorage.getItem(DAILY_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as DailyResult[];
  } catch {
    return [];
  }
}

export function saveDailyResult(entry: DailyResult): readonly DailyResult[] {
  const existing = loadDailyResults();
  // replace any prior entry for the same date (best attempt sticks only if higher)
  const prior = existing.find((e) => e.date === entry.date);
  if (prior && prior.legacy >= entry.legacy) return existing; // keep best
  const next = [entry, ...existing.filter((e) => e.date !== entry.date)].slice(0, DAILY_MAX);
  try {
    localStorage.setItem(DAILY_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable; fail silently
  }
  return next;
}

// ─────────────────────────────────────────────────────────────────
// Daily login bonus (P-A121: DAU driver — give players a reason to return)
// ─────────────────────────────────────────────────────────────────
const LOGIN_KEY = "pitch-reincarnation:login:v1";

function defaultLogin(): LoginBonus {
  return { lastLoginDate: "", consecutiveDays: 0, totalLogins: 0, bonusLegacy: 0 };
}

export function loadLoginBonus(): LoginBonus {
  try {
    const raw = localStorage.getItem(LOGIN_KEY);
    if (!raw) return defaultLogin();
    return JSON.parse(raw) as LoginBonus;
  } catch { return defaultLogin(); }
}

/** Mechanics review: the daily bonus is earned by COMPLETING today's daily
 *  challenge, not by opening the app — the old login handout (~a free blessing
 *  per week for zero play) diluted "legacy is earned by runs". Records the
 *  completion into the same LoginBonus store the menu ribbon reads. */
export function recordDailyBonus(streak: number, amount: number): LoginBonus {
  const prev = loadLoginBonus();
  const bonus: LoginBonus = {
    lastLoginDate: todayStr(),
    consecutiveDays: streak,
    totalLogins: prev.totalLogins + 1,
    bonusLegacy: amount,
  };
  try { localStorage.setItem(LOGIN_KEY, JSON.stringify(bonus)); } catch { /* noop */ }
  return bonus;
}
