/**
 * gen-trophies.mjs — procedural trophy art for competitions copero ships no
 * asset for (8 league titles, 9 domestic cups, 3 continental club cups).
 *
 * Rather than leave those honors image-less (or all sharing one flat fallback),
 * each competition gets its OWN silhouette, deterministically derived from its
 * id: bowl family, handles, base tiers and an enamel accent band all vary, so
 * 希腊超冠军 and 捷克甲冠军 are visibly different trophies while staying one
 * material family. Metal is semantic, not random — league titles are gold,
 * domestic cups silver, continental cups gold.
 *
 * Emits static SVGs into public/img/trophies/gen/ so every consumer stays a
 * plain <img src> (ledger, badges, and the html-to-image share card alike).
 *
 * Run: node scripts/gen-trophies.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/img/trophies/gen");

// same FNV-1a the UI uses for club hues — stable art across regenerations.
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0 || 1;
};

const METAL = {
  gold:   { hi: "#fbeec2", mid: "#dcae42", lo: "#8a5f14", rim: "#ffe9a8" },
  silver: { hi: "#f4f7fa", mid: "#b5c0ca", lo: "#67727d", rim: "#e8eef4" },
};

// ── bowl families ────────────────────────────────────────────────────────
// Each entry: the cup body path, the accent-band line, and whether it stands
// on a stem (a plate/shield sits straight on its plinth).
const BOWLS = [
  { // 0 chalice — the classic European cup
    body: "M13.5 8H34.5C34.5 21.5 30.4 29.6 24 30.6C17.6 29.6 13.5 21.5 13.5 8Z",
    band: "M14.2 12.6H33.8", stem: true, hx: 13.5,
  },
  { // 1 wide-mouth cup — squat, banded lip
    body: "M8.5 8H39.5L36 17.4C35.2 25.6 30.4 30.6 24 31C17.6 30.6 12.8 25.6 12 17.4Z",
    band: "M11.4 15.2H36.6", stem: true, hx: 11.6,
  },
  { // 2 amphora — pinched waist, flared shoulders
    body: "M17.6 7C11.6 11.4 12.4 18.6 18.4 21.6C13.6 24.2 15 29 19.4 30.4H28.6C33 29 34.4 24.2 29.6 21.6C35.6 18.6 36.4 11.4 30.4 7Z",
    band: "M16.4 12.2H31.6", stem: true, hx: 15.4,
  },
  { // 3 salver / shield plate — how many domestic titles are actually awarded
    body: "M11.5 7.5H36.5V20.5C36.5 28.8 31 34.7 24 37.2C17 34.7 11.5 28.8 11.5 20.5Z",
    band: "M14.5 13H33.5", stem: false, hx: null,
  },
];

// ── handle families (drawn mirrored around x=24; null = handle-less) ──────
const HANDLES = [
  null,
  (x) => `M${x} 11.5C${x - 6.5} 11.5 ${x - 7.5} 21 ${x - 1.2} 23.2`,   // round ears
  (x) => `M${x} 10.2C${x - 8.5} 10.8 ${x - 9.5} 17.5 ${x - 4} 21.8`,   // swept wings
  (x) => `M${x} 12H${x - 5.5}V20.5H${x - 1.5}`,                        // square bars
];

function trophySvg(seed, metalKey, { plate = false } = {}) {
  const h = hash(seed);
  const bowl = BOWLS[plate ? 3 : h % 3];
  const handle = bowl.hx === null ? null : HANDLES[(h >> 3) % HANDLES.length];
  const twoTier = ((h >> 7) & 1) === 1;
  const hue = h % 360;
  const m = METAL[metalKey];
  const id = (h % 100000).toString(36);

  const handles = handle
    ? `<g fill="none" stroke="url(#m${id})" stroke-width="2.6" stroke-linecap="round">` +
      `<path d="${handle(bowl.hx)}"/>` +
      `<path d="${handle(bowl.hx)}" transform="translate(48 0) scale(-1 1)"/></g>`
    : "";
  const stem = bowl.stem ? `<path d="M21.6 30h4.8v6h-4.8z" fill="url(#m${id})"/>` : "";
  const base = bowl.stem
    ? `<path d="M17.5 35.5h13l2.2 5.2H15.3z" fill="url(#m${id})"/>` +
      (twoTier ? `<rect x="12.6" y="40.2" width="22.8" height="4.6" rx="1.4" fill="url(#m${id})"/>` : "")
    : `<rect x="15" y="38.4" width="18" height="4.4" rx="1.3" fill="url(#m${id})"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">
<defs>
<linearGradient id="m${id}" x1="10" y1="4" x2="38" y2="44" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="${m.hi}"/><stop offset=".42" stop-color="${m.mid}"/><stop offset="1" stop-color="${m.lo}"/>
</linearGradient>
<clipPath id="c${id}"><path d="${bowl.body}"/></clipPath>
</defs>
${handles}
<path d="${bowl.body}" fill="url(#m${id})"/>
<g clip-path="url(#c${id})">
<path d="M24 0h24v48H24z" fill="#000" opacity=".14"/>
<path d="M17.5 5c-3.5 6-3 15 1.5 21-5-3-7.5-13-5-21z" fill="#fff" opacity=".38"/>
<path d="${bowl.band}" stroke="hsl(${hue} 48% 31%)" stroke-width="3.4" opacity=".85"/>
<path d="${bowl.band}" stroke="#fff" stroke-width=".8" opacity=".35" transform="translate(0 -1.8)"/>
</g>
<path d="${bowl.body}" fill="none" stroke="${m.rim}" stroke-width="1.1" opacity=".55"/>
${stem}
${base}
</svg>
`;
}

// ── the gap: everything trophyPath() could not resolve ────────────────────
const NO_LEAGUE_TROPHY = ["greek-super", "swiss-super", "austrian-bund", "czech-liga", "ukrainian-premier", "egyptian-pred", "china-league-one", "brasileirao-b"];
const NO_CUP = [...NO_LEAGUE_TROPHY.filter((x) => x !== "brasileirao-b"), "j1-league", "brasileirao-b"];
const NO_CONTINENTAL = [["CAF", "primary"], ["CONCACAF", "secondary"], ["AFC", "secondary"], ["CAF", "secondary"], ["OFC", "primary"], ["OFC", "secondary"]];

mkdirSync(OUT, { recursive: true });
const written = [];
const emit = (name, svg) => { writeFileSync(`${OUT}/${name}.svg`, svg); written.push(name); };

// league titles: gold, and the salver family for half of them (many domestic
// titles are literally a plate/shield, not a cup)
for (const id of NO_LEAGUE_TROPHY) emit(`league-${id}`, trophySvg(`league:${id}`, "gold", { plate: (hash(`league:${id}`) >> 5) % 2 === 0 }));
// domestic cups: silver, always a cup (a cup is a cup)
for (const id of NO_CUP) emit(`cup-${id}`, trophySvg(`cup:${id}`, "silver"));
// continental club cups: gold, big-eared
for (const [conf, kind] of NO_CONTINENTAL) emit(`cont-${conf}-${kind}`, trophySvg(`cont:${conf}:${kind}`, kind === "primary" ? "gold" : "silver"));
// last-resort fallback for anything added later without an asset
emit("generic", trophySvg("generic", "gold"));

console.log(`wrote ${written.length} trophies → ${OUT}`);
