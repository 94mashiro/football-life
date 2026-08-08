/**
 * The interface icon set — drawn, not typed.
 *
 * Flags, trophies and celebration emoji are *content* in this game and stay as
 * they are. These four are *chrome*: close, disclose, expand, collapse. They
 * ship as authored SVG on one stroke weight so the overlay layer reads as built
 * rather than assembled out of whatever glyphs the font happened to have.
 */

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
