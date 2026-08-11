/**
 * Scoreboard icon set — vector, not pixel.
 *
 * The header is a lit metal scoreboard (floodlight bloom, recessed cells, LED
 * glow). The 16×16 pixel glyphs in `pixel-icons.tsx` are a different material
 * language (chunky mosaic tiles built for the blessing-shop showcase) and
 * read like stickers on a trophy when dropped into the scoreboard. This set
 * shares the scoreboard's own vocabulary: thin outline + a soft single-fill,
 * one accent glow, drawn as crisp SVG on the same stroke weight as the chrome
 * icons in `icons.tsx`. Football-meaningful objects, not RPG gems/coins/bolts:
 *
 *   ball    — the brand mark (a football, not a diamond)
 *   legacy  — 青训接力 (a young seedling handed a ball — the torch passed on)
 *   best    — 最佳 (the Ballon d'Or — football's highest individual honor)
 *   ascension — 飞升 (a ladder/throne — climbing the difficulty tiers)
 *   cycle   — 轮回 (a rebirth arrow — the prestige loop, start over)
 *
 * Every glyph is `currentColor`-driven on its stroke so the scoreboard can tint
 * it (purple by default, gold under prestige) the same way it tints the
 * wordmark. The fills are a fixed low-saturation gradient so a glyph keeps its
 * form even where the accent glow overlaps.
 */

import { memo } from "react";

type Size = { size?: number; className?: string };

const S = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/* ── ball: the brand mark ── a classic truncated-icosahedron football: a
 *  central pentagon, five radiating seam lines. Drawn, not emoji — the emoji
 *  ⚽ renders differently per platform and has no material presence. */
export const ScoreBall = memo(function ScoreBall({ size = 18, className }: Size) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <circle cx="12" cy="12" r="9.4" {...S} strokeWidth={1.7} />
      {/* central pentagon */}
      <path d="M12 7.8l3.4 2.5-1.3 4h-4.2l-1.3-4z" {...S} strokeWidth={1.5} />
      {/* five radiating seams */}
      <path {...S} strokeWidth={1.4} d="M12 7.8V3.8M15.4 10.3l3.8-1.2M14.1 14.3l3.4 3.2M9.9 14.3l-3.4 3.2M8.6 10.3l-3.8-1.2" />
    </svg>
  );
});

/* ── legacy: 青训接力 ── a young shoot bearing a ball — the torch handed to
 *  the next generation. A football crowns a two-leaf seedling; "传承" is the
 *  academy-to-first-team pipeline, not a gem you hoard. */
export const ScoreLegacy = memo(function ScoreLegacy({ size = 14, className }: Size) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      {/* the ball handed down */}
      <circle cx="12" cy="6.4" r="4.1" {...S} strokeWidth={1.5} />
      <path d="M12 4.6l1.6 1.2-.6 1.8h-2l-.6-1.8z" {...S} strokeWidth={1.2} />
      {/* the stem */}
      <path {...S} strokeWidth={1.6} d="M12 10.4v9.6" />
      {/* two leaves */}
      <path {...S} strokeWidth={1.5} d="M12 14c-1.8 0-3.2-1-3.2-2.6 1.8 0 3.2 1 3.2 2.6z" />
      <path {...S} strokeWidth={1.5} d="M12 16.4c1.8 0 3.2-1 3.2-2.6-1.8 0-3.2 1-3.2 2.6z" />
    </svg>
  );
});

/* ── best: 最佳 ── the Ballon d'Or — a ball on a pedestal ribbon. The Ballon
 *  d'Or is football's highest individual honor; "最佳" is your best career,
 *  and a gold ball on a ribbon is the thing a fan pictures for it. */
export const ScoreBest = memo(function ScoreBest({ size = 14, className }: Size) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      {/* the golden ball */}
      <circle cx="12" cy="8.6" r="4.4" {...S} strokeWidth={1.5} />
      <path d="M12 6.6l1.7 1.3-.65 2h-2.1l-.65-2z" {...S} strokeWidth={1.2} />
      {/* the ribbon pedestal */}
      <path {...S} strokeWidth={1.5} d="M8.4 12.4L6.4 20l3-2 2.6 2 2.6-2 3 2-2-7.6" />
    </svg>
  );
});

/* ── ascension: 飞升 ── a ladder rising to a star — climbing the difficulty
 *  tiers. Ascension in this game is a harder run for a bigger legacy payout;
 *  the image is the climb, not a lightning bolt. */
export const ScoreAscension = memo(function ScoreAscension({ size = 14, className }: Size) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      {/* the star at the top — the summit */}
      <path d="M12 2.4l1.7 3.5 3.9.5-2.8 2.7.66 3.9L12 11.9 8.5 13l.66-3.9L6.4 6.4l3.9-.5z" {...S} strokeWidth={1.4} />
      {/* the ladder */}
      <path {...S} strokeWidth={1.6} d="M9 22V13M15 22V13" />
      <path {...S} strokeWidth={1.5} d="M9.6 15.5h4.8M9.4 18.5h5.2" />
    </svg>
  );
});

/* ── cycle: 轮回 ── a circular rebirth arrow — prestige is starting over,
 *  permanent perks carried into the next loop. A round arrow reads "again,
 *  from the top" — not a coin you spend. */
export const ScoreCycle = memo(function ScoreCycle({ size = 14, className }: Size) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <path
        {...S}
        strokeWidth={1.7}
        d="M20 12a8 8 0 1 1-2.34-5.66"
      />
      {/* the arrowhead that makes it a "restart" arrow, pointing back into the loop */}
      <path {...S} strokeWidth={1.6} d="M20 4.5v3.2h-3.2" />
    </svg>
  );
});

export const SCORE_ICONS = {
  ball: ScoreBall,
  legacy: ScoreLegacy,
  best: ScoreBest,
  ascension: ScoreAscension,
  cycle: ScoreCycle,
} as const;
