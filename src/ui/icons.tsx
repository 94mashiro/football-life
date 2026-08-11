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

/** Globe — the "all nations" mark on the leaderboard's nation filter. */
export function IconGlobe({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle {...S} cx="8" cy="8" r="6" />
      <ellipse {...S} cx="8" cy="8" rx="2.6" ry="6" />
      <path {...S} d="M2 8h12" />
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
export type ModeName = "daily" | "drafts" | "records" | "prefs" | "leaderboard";

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
  // 排行榜 — a medal on a ribbon; the global board, ranked honours.
  leaderboard: (
    <>
      <circle cx="12" cy="9" r="5" />
      <path d="M9 13.5 7 21l5-2.5L17 21l-2-7.5" />
      <path d="M10 9l1.5 1.5L15 7" />
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

/* ── blessing emblems ──
   Each blessing is a foil power-card in the shop, and a card needs a face:
   one authored glyph per blessing, drawn on the same 24-grid / 1.9 stroke as
   the rest of the chrome so the shelf reads as one set, not twelve imports. */
const BLESSING_SHAPES: Record<string, ReactNode> = {
  // 金童 — a five-point star; the boy-wonder headline.
  golden_boy: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />,
  // 铁肺 — lungs; stamina is the whole point of the blessing.
  iron_lungs: (
    <>
      <path d="M12 3.5V8" />
      <path d="M10.5 8.8C8 8.3 6 10.5 5.6 13.5c-.4 3 .4 5.5 2.4 5.9 1.8.4 2.5-1.1 2.5-2.9z" />
      <path d="M13.5 8.8c2.5-.5 4.5 1.7 4.9 4.7.4 3-.4 5.5-2.4 5.9-1.8.4-2.5-1.1-2.5-2.9z" />
    </>
  ),
  // 先知之眼 — an eye; it sees the odds one decimal deeper.
  oracle: (
    <>
      <path d="M2.8 12S6.4 6 12 6s9.2 6 9.2 6-3.6 6-9.2 6-9.2-6-9.2-6z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  // 忠诚之心 — a heart; one club, whole career.
  loyal_club: <path d="M12 20.3s-7.2-4.8-7.2-9.6C4.8 8 6.7 6.1 9 6.1c1.4 0 2.5.7 3 1.7.5-1 1.6-1.7 3-1.7 2.3 0 4.2 1.9 4.2 4.6 0 4.8-7.2 9.6-7.2 9.6z" />,
  // 护身符 — a hexagonal amulet with a core; the charm you wear into the draw.
  talisman: (
    <>
      <path d="M12 3.2l7.3 4.2v8.4L12 20l-7.3-4.2V7.4z" />
      <circle cx="12" cy="11.6" r="2.6" />
    </>
  ),
  // 神射手 — a crosshair; goals on demand.
  sharpshooter: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2.5V6M12 18v3.5M2.5 12H6M18 12h3.5" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  // 铁人 — a dumbbell; the body that never breaks.
  ironman: <path d="M7.5 8.5v7M16.5 8.5v7M4 10.5v3M20 10.5v3M7.5 12h9" />,
  // 商业价值 — a cut gem; the brand is a jewel.
  marketable: (
    <>
      <path d="M7 4.5h10L20.5 9 12 19.5 3.5 9z" />
      <path d="M3.5 9h17M12 19.5L8.8 9l1.7-4.5M12 19.5L15.2 9l-1.7-4.5" />
    </>
  ),
  // 浴火重生 — a flame; the career that comes back from ash.
  comeback: <path d="M12 3.2c.9 3.2 4.8 4.9 4.8 9a4.8 4.8 0 1 1-9.6 0c0-2.5 1.3-4 2.6-5.6.2 1.2.8 2 1.7 2.6-.4-2.6-.2-4.5.5-6z" />,
  // 玻璃大炮 — a cannon with lit fuse; huge output, fragile chassis.
  glass_cannon: (
    <>
      <path d="M4.8 14.8L14.4 7l3.2 3.6-9.8 7.4z" />
      <circle cx="9.5" cy="17" r="3.2" />
      <path d="M16.6 4.4l1.1-1.6M18.9 7.2l2-.9" />
    </>
  ),
  // 雇佣兵 — crossed swords; sells to the highest bidder.
  mercenary: (
    <>
      <path d="M5 4.2L17.2 16.4" />
      <path d="M19 4.2L6.8 16.4" />
      <path d="M13.6 15.2l3-3M10.4 15.2l-3-3" />
    </>
  ),
  // 大赛型选手 — a cup; made for the one night that matters.
  big_game_player: (
    <>
      <path d="M8 4h8v4.5a4 4 0 0 1-8 0z" />
      <path d="M8 5.5H5.3a2.7 2.7 0 0 0 2.8 3.6M16 5.5h2.7a2.7 2.7 0 0 1-2.8 3.6" />
      <path d="M12 12.5v3M8.8 18.5h6.4M10 15.5h4" />
    </>
  ),
  // 大器晚成 — a sprout; two leaves, the second one higher. Late, then all at once.
  late_bloomer: (
    <>
      <path d="M12 21v-7" />
      <path d="M12 14c0-3.6-2.5-5.6-6.3-5.6 0 3.9 2.3 5.6 6.3 5.6z" />
      <path d="M12 11.4c0-3.2 2.3-5 5.8-5 0 3.5-2.1 5-5.8 5z" />
    </>
  ),
};

export function IconBlessing({ id, size = 20 }: { id: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      {BLESSING_SHAPES[id] ?? BLESSING_SHAPES.talisman}
    </svg>
  );
}

/** Padlock — the face of a blessing still gated behind cumulative legacy. */
export function IconLock({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <rect x="6.5" y="10.5" width="11" height="8.5" rx="2" />
      <path d="M9 10.5V8a3 3 0 0 1 6 0v2.5" />
    </svg>
  );
}

/** Empty loadout slot marker — an authored plus, not a typed ＋. */
export function IconPlus({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path {...S} d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

/** Equipped check on the loadout badge — drawn, same stroke as the chrome. */
export function IconCheck({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path {...S} d="M3 8.5l3.2 3.2L13 4.8" />
    </svg>
  );
}
