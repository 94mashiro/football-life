/**
 * Share-link encode/decode — the career-setup URL hash (`#s=seed&n=nat&p=pos…`).
 *
 * Pulled out of App.tsx per ADR 0002's "pure helpers get an address" direction:
 * a self-contained pair (encode + parse) over a small value type, no JSX, no
 * hooks, no engine side effects. App.tsx re-imports these; the module-load
 * `PENDING_LINK` read still lives in App.tsx (it needs to run before React
 * picks a screen, and keeps the `window` touchpoint at the UI boundary).
 *
 * Behaviour-identical to the prior inline definitions — `regress` does not cover
 * React, but the share-link round-trip is exercised by the daily/quick-start
 * paths; tsc verifies every moved symbol's references.
 */
import type { Position } from "../engine/data";
import { NATIONS, LEAGUES, ALL_POSITIONS, CLUBS } from "../engine/data";
import type { PaceMode } from "../engine/run";

export interface CareerLink {
  seed: string;
  nationalityId: string;
  position: Position;
  leagueId: string;
  /** The academy club (青训队伍). Encoded as `c`; when absent the recipient gets
   *  the deterministic weakest club in `leagueId` — so old league-only links and
   *  daily challenges reproduce the exact same career as before. */
  clubId?: string;
  pace: PaceMode;
  /** Custom identity — cosmetic only, but it rides along so the shirt matches. */
  playerName?: string;
  squadNumber?: number;
  /** YYYY-MM-DD — set only on daily-challenge links. */
  dailyDate?: string;
}

export const VALID_PACE: readonly PaceMode[] = ["long", "normal", "express"];

export function careerUrl(l: CareerLink): string {
  const q = new URLSearchParams({ s: l.seed, n: l.nationalityId, p: l.position, l: l.leagueId, m: l.pace });
  if (l.playerName?.trim()) q.set("nm", l.playerName.trim().slice(0, 16));
  if (l.squadNumber !== undefined) q.set("no", String(l.squadNumber));
  if (l.dailyDate) q.set("d", l.dailyDate);
  if (l.clubId) q.set("c", l.clubId);
  return `${window.location.origin}${window.location.pathname}#${q.toString()}`;
}

/** Parse a share hash. Yields the seed alone when only that is valid (legacy
 *  `#seed=` links just prefill the field) and a full CareerLink when the whole
 *  setup is present and valid. */
export function parseCareerUrl(hash: string): { seed?: string; link?: CareerLink } {
  const h = hash.replace(/^#/, "");
  if (!h) return {};
  const params = new URLSearchParams(h);
  const s = params.get("s") ?? params.get("seed");
  const n = params.get("n");
  const p = params.get("p") as Position | null;
  const l = params.get("l");
  const m = params.get("m") as PaceMode | null;
  const nm = params.get("nm");
  const no = params.get("no");
  const d = params.get("d");
  const c = params.get("c");
  const seed = s && /^[a-z0-9]+$/i.test(s) ? s.toLowerCase() : undefined;
  if (!seed) return {};
  const okNat = !!(n && NATIONS.some((x) => x.id === n));
  const okPos = !!(p && ALL_POSITIONS.includes(p));
  const okLeague = !!(l && LEAGUES.some((x) => x.id === l));
  if (!okNat || !okPos || !okLeague) return { seed };
  const noNum = no !== null ? Number(no) : NaN;
  return {
    seed,
    link: {
      seed, nationalityId: n!, position: p!, leagueId: l!,
      clubId: c && CLUBS.some((x) => x.id === c) ? c : undefined,
      pace: m && VALID_PACE.includes(m) ? m : "normal",
      playerName: nm && nm.length > 0 && nm.length <= 16 ? nm : undefined,
      squadNumber: Number.isInteger(noNum) && noNum >= 1 && noNum <= 99 ? noNum : undefined,
      dailyDate: d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined,
    },
  };
}
