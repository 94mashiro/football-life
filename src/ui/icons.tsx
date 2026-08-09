/**
 * The interface icon set — drawn, not typed.
 *
 * Flags, trophies and celebration emoji are *content* in this game and stay as
 * they are. These four are *chrome*: close, disclose, expand, collapse. They
 * ship as authored SVG on one stroke weight so the overlay layer reads as built
 * rather than assembled out of whatever glyphs the font happened to have.
 */

import type { ReactNode } from "react";

const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function IconX({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path {...S} d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

/** Disclosure chevron — points to where the tap leads. */
export function IconChevron({ dir = "right", size = 14 }: { dir?: "right" | "up" | "down"; size?: number }) {
  const d = dir === "right" ? "M6 3l5 5-5 5" : dir === "up" ? "M3 10.5l5-5 5 5" : "M3 5.5l5 5 5-5";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path {...S} d={d} />
    </svg>
  );
}

/** The two-chevron "there is more here" mark used on the deck head. */
export function IconDetent({ open, size = 15 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false"
      style={{ transform: open ? "none" : "rotate(180deg)", transition: "transform .22s cubic-bezier(.2,.8,.2,1)" }}>
      <path {...S} d="M3.5 9.5l4.5-4 4.5 4" />
      <path {...S} d="M3.5 13l4.5-4 4.5 4" opacity="0.45" />
    </svg>
  );
}

/** Branch marker on a decision card's outcome pill — where this branch takes
 *  the career. Drawn on the same stroke as the rest of the chrome so the pills
 *  never fall back to a glyph. */
export function IconTrend({ dir, size = 12 }: { dir: "up" | "down" | "flat"; size?: number }) {
  const d = dir === "up" ? "M4 11l3.6-4 2.4 2 3-4.5" : dir === "down" ? "M4 5l3.6 4 2.4-2 3 4.5" : "M3.5 8h8";
  const head = dir === "up" ? "M13 4.5h-2.6M13 4.5v2.6" : dir === "down" ? "M13 11.5h-2.6M13 11.5v-2.6" : "M9 5.5 11.5 8 9 10.5";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path {...S} d={d} />
      <path {...S} d={head} />
    </svg>
  );
}

/* ── bottom navigation ──
   The tab bar is chrome, not content, so it earns the same authored-SVG
   treatment as the close/disclose set above. viewBox 24 at 20px lands the
   rendered stroke (≈1.67px) on parity with the 16-grid chrome icons at 14px,
   so the whole interface reads as one weight. currentColor lets the active
   tab's lime flow in through CSS without a per-state asset. */
export type NavName = "play" | "blessings" | "ascension" | "prestige" | "hall";

const NAV_SHAPES: Record<NavName, ReactNode> = {
  // 开始 — the ball itself; a football-first brand puts the sport on the hero tab.
  play: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8L15.8 10.8L14.4 15.2L9.6 15.2L8.2 10.8Z" />
      <path d="M12 8L12 3.5" />
      <path d="M15.8 10.8L20.1 9.4" />
      <path d="M14.4 15.2L17 18.9" />
      <path d="M9.6 15.2L7 18.9" />
      <path d="M8.2 10.8L3.9 9.4" />
    </>
  ),
  // 祝福 — one sharp four-point sparkle; crisper geometry than the ✨ glyph.
  blessings: <path d="M12 3L13.8 10.2L21 12L13.8 13.8L12 21L10.2 13.8L3 12L10.2 10.2Z" />,
  // 飞升 — a winged up-arrow; ascent with flight, not a generic upload chevron.
  ascension: (
    <>
      <path d="M12 20V6.5M7.5 10.5 12 6.5 16.5 10.5" />
      <path d="M4.5 9.5C7 12 9.5 13.5 12 15C14.5 13.5 17 12 19.5 9.5" />
    </>
  ),
  // 轮回 — a single circular arrow; one life feeding the next, not a "refresh".
  prestige: (
    <>
      <path d="M15.5 6A7 7 0 1 1 8.5 6" />
      <path d="M4.5 6 8.5 6 6.5 9.4" />
    </>
  ),
  // 殿堂 — a handled trophy on a pedestal; the hall of fame.
  hall: (
    <>
      <path d="M7 4H17V9C17 12.5 14.5 14 12 14C9.5 14 7 12.5 7 9Z" />
      <path d="M7 5.5C4 5.5 4 10.5 8 10" />
      <path d="M17 5.5C20 5.5 20 10.5 16 10" />
      <path d="M12 14V18" />
      <path d="M9 18H15L16.5 21H7.5Z" />
    </>
  ),
};

export function IconNav({ name, size = 20, className }: { name: NavName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      {NAV_SHAPES[name]}
    </svg>
  );
}

/* ── the menu's side-mode doors ──
   These four sat as ⚡🎬📊⚙️ next to an interface whose every other mark is
   drawn: an emoji renders in the platform's own style and weight, so the row
   read as assembled. Same 24-grid and stroke as the nav set. */
export type ModeName = "daily" | "drafts" | "records" | "prefs";

const MODE_SHAPES: Record<ModeName, ReactNode> = {
  // 今日挑战 — a bolt; today's fixture, one shot at it.
  daily: <path d="M13.5 3 6 13.2h4.8L10.5 21 18 10.8h-4.8Z" />,
  // 传奇剧本 — a clapperboard; scripted starts.
  drafts: (
    <>
      <path d="M3.5 4.2h17v4.6h-17Z" />
      <path d="M3.5 8.8h17v9.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" />
      <path d="M8.2 4.2 6.2 8.8M14 4.2 12 8.8" />
    </>
  ),
  // 战绩档案 — three columns of past runs.
  records: (
    <>
      <path d="M4 20h16" />
      <path d="M7 20v-6M12 20V6M17 20v-9" />
    </>
  ),
  // 偏好 — two sliders.
  prefs: (
    <>
      <path d="M4 8.5h16M4 15.5h16" />
      <circle cx="9.5" cy="8.5" r="2.2" />
      <circle cx="15" cy="15.5" r="2.2" />
    </>
  ),
};

export function IconMode({ name, size = 17 }: { name: ModeName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      {MODE_SHAPES[name]}
    </svg>
  );
}
