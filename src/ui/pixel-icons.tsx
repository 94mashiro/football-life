/**
 * Pixel-art glyph set for the blessing shop showcase (`.bs-*`).
 *
 * Every glyph is a 16×16 character grid rendered as hard-edged SVG rects
 * (shape-rendering: crispEdges), so squares stay square at any display size.
 * '.' is transparent; every other char maps through the glyph's palette.
 * Rects are precomputed at module load (horizontal runs merged) — rendering
 * a card grid re-renders memoized components over static arrays.
 *
 * One shared grammar across the set: chunky solid fills, a darker shade on
 * the light-away side, one or two near-white glint pixels top-left. Blessing
 * glyphs are looked up by blessing id via <PxBlessing/>; interface glyphs
 * (currency gem, coin, bolt, nav marks…) export from the PX record.
 */

import { memo } from "react";

type Grid = readonly string[];
type Palette = Readonly<Record<string, string>>;
type Run = { readonly x: number; readonly y: number; readonly w: number; readonly c: string };

function gridRuns(grid: Grid, palette: Palette): Run[] {
  const out: Run[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x] ?? ".";
      const c = palette[ch];
      if (c === undefined) { x += 1; continue; }
      let w = 1;
      while (row[x + w] === ch) w += 1;
      out.push({ x, y, w, c });
      x += w;
    }
  });
  return out;
}

export type PxGlyphProps = { size?: number; className?: string };

function makeGlyph(grid: Grid, palette: Palette) {
  const runs = gridRuns(grid, palette);
  return memo(function PxGlyph({ size = 16, className }: PxGlyphProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true" focusable="false" className={className}>
        {runs.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={r.c} />)}
      </svg>
    );
  });
}

/* ── shared tones ── */
const GLINT = "#f6efff";    // near-white highlight
const GOLD = "#f5c518";
const GOLD_DK = "#b45309";
const PURPLE = "#a855f7";
const PURPLE_LT = "#c084fc";
const PURPLE_DK = "#7c3aed";

/* ── currency gem (传承) — faceted purple diamond ── */
const Gem = makeGlyph([
  "................",
  "................",
  "..kkkkkkkkkkkk..",
  ".kwhhhppppddddk.",
  ".khhhhppppddddk.",
  ".keeeeeeeeeeeek.",
  "..khhhppppdddk..",
  "...khhppppddk...",
  "....khppppdk....",
  ".....kppppk.....",
  "......kppk......",
  ".......kk.......",
  "................",
  "................",
  "................",
  "................",
], { k: "#33195e", w: GLINT, h: "#e3ccff", p: PURPLE, d: PURPLE_DK, e: "#5b21b6" });

/* ── coin (轮回) — square-holed gold coin, the cycle of fortunes ── */
const Coin = makeGlyph([
  "................",
  "................",
  ".....kkkkkk.....",
  "...kkwwggggkk...",
  "..kwwggggggddk..",
  ".kwggggggggggdk.",
  ".kwgggoooogggdk.",
  ".kggggoooogggdk.",
  ".kggggoooogggdk.",
  ".kggggoooogggdk.",
  ".kdggggggggdddk.",
  "..kdddggggdddk..",
  "...kkddddddkk...",
  ".....kkkkkk.....",
  "................",
  "................",
], { k: "#4a3005", w: "#fdeeb0", g: GOLD, o: "#8a5a06", d: "#c9920e" });

/* ── bolt (飞升) ── */
const Bolt = makeGlyph([
  "................",
  "......kkkkk.....",
  ".....kwwwwk.....",
  "....kwwwwk......",
  "...kwwwwk.......",
  "...kwwwwkkkk....",
  "..kwwwwwwwwk....",
  "..kkkkwwwwk.....",
  ".....kwwwk......",
  "....kwwwk.......",
  "...kwwwk........",
  "...kwwk.........",
  "..kwwk..........",
  "..kkk...........",
  "................",
  "................",
], { k: "#3b1d70", w: "#efe3ff" });

/* ── four-point sparkle star (商店 mark) — tapered points, not a cross ── */
const Star = makeGlyph([
  "................",
  ".......pp.......",
  ".......pp.......",
  ".......pp.......",
  "......pppp......",
  "......pwwp......",
  ".....ppwwpp.....",
  ".pppppwwwwppppp.",
  ".pppppwwwwppppp.",
  ".....ppwwpp.....",
  "......pwwp......",
  "......pppp......",
  ".......pp.......",
  ".......pp.......",
  ".......pp.......",
  "................",
], { p: PURPLE, w: GLINT });

/* ── lock (未解锁) ── */
const Lock = makeGlyph([
  "................",
  "................",
  ".....kkkkkk.....",
  "....kk....kk....",
  "....kk....kk....",
  "....kk....kk....",
  "..kkkkkkkkkkkk..",
  "..kggggggggggk..",
  "..kggggddggggk..",
  "..kggggddggggk..",
  "..kgggggdggggk..",
  "..kggggggggggk..",
  "..kkkkkkkkkkkk..",
  "................",
  "................",
  "................",
], { k: "#3a3a46", g: "#82828e", d: "#2c2c36" });

/* ── plus (空栏位) ── */
const Plus = makeGlyph([
  "................",
  "................",
  "................",
  "................",
  ".......mm.......",
  ".......mm.......",
  ".......mm.......",
  "....mmmmmmmm....",
  "....mmmmmmmm....",
  ".......mm.......",
  ".......mm.......",
  ".......mm.......",
  "................",
  "................",
  "................",
  "................",
], { m: "#6f6a80" });

/* ── chunky left arrow (返回) ── */
const Back = makeGlyph([
  "................",
  "................",
  ".......ww.......",
  "......www.......",
  ".....www........",
  "....www.........",
  "...wwwwwwwwwww..",
  "..wwwwwwwwwwww..",
  "..wwwwwwwwwwww..",
  "...wwwwwwwwwww..",
  "....www.........",
  ".....www........",
  "......www.......",
  ".......ww.......",
  "................",
  "................",
], { w: "#f2eaff" });

/* ── player bust (顶栏头像) ── */
const Avatar = makeGlyph([
  "................",
  "....kkkkkkkk....",
  "...khhhhhhhhk...",
  "..khhhhhhhhhhk..",
  "..khhffffffhhk..",
  "..khffffffffhk..",
  "..khfeffffefhk..",
  "..khffffffffhk..",
  "...kffffffffk...",
  "...kkffffffkk...",
  ".....kffffk.....",
  "....kkjjjjkk....",
  "..kkjjjjjjjjkk..",
  ".kjjjjjffjjjjjk.",
  ".kjjjjjjjjjjjjk.",
  ".kjjjjjjjjjjjjk.",
], { k: "#160e24", h: "#2e2440", f: "#eec39a", e: "#191024", j: "#6d28d9" });

/* ── nav: double chevron up (飞升) ── */
const AscMark = makeGlyph([
  "................",
  "................",
  ".......pp.......",
  "......pppp......",
  ".....pppppp.....",
  "....pppppppp....",
  "................",
  ".......pp.......",
  "......pppp......",
  ".....pppppp.....",
  "....pppppppp....",
  "................",
  "................",
  "................",
  "................",
  "................",
], { p: "currentColor" });

/* ── nav: broken ring + head (轮回) ── */
const CycleMark = makeGlyph([
  "................",
  ".......ccc......",
  "....ccccc.......",
  "...cc.....cc....",
  "..cc.......cc...",
  "..cc........cc..",
  "..cc........cc..",
  "..cc........cc..",
  "..cc........cc..",
  "...cc......cc...",
  "....cc....cc....",
  ".....cccccc.....",
  "................",
  "................",
  "................",
  "................",
], { c: "currentColor" });

/* ── trophy — shared: 大赛型选手 + nav 殿堂 ── */
const TROPHY_GRID: Grid = [
  "................",
  "................",
  "...kkkkkkkkkk...",
  "...kgwgggggdk...",
  "...kgwgggggdk...",
  "...kggggggggk...",
  "....kggggggk....",
  ".....kggggk.....",
  "......kggk......",
  "......kggk......",
  "......kggk......",
  "....kkkkkkkk....",
  "...kggggggggk...",
  "...kkkkkkkkkk...",
  "................",
  "................",
];
const TROPHY_PALETTE: Palette = { k: "#4a3005", g: GOLD, w: "#fdeeb0", d: GOLD_DK };
const Trophy = makeGlyph(TROPHY_GRID, TROPHY_PALETTE);
/* nav 殿堂 variant reads in currentColor so active/inactive states tint it */
const HallMark = makeGlyph(TROPHY_GRID, { k: "currentColor", g: "currentColor", w: "currentColor", d: "currentColor" });

export const PX = {
  gem: Gem, coin: Coin, bolt: Bolt, star: Star, lock: Lock, plus: Plus, back: Back,
  avatar: Avatar, asc: AscMark, cycle: CycleMark, hall: HallMark, trophy: Trophy,
} as const;

/* ─────────────────────────── blessing glyphs ─────────────────────────── */

/* 金童 — the golden crown */
const GoldenBoy = makeGlyph([
  "................",
  "................",
  "................",
  ".......gg.......",
  "..g....gg....g..",
  "..gg...gg...gg..",
  "..ggg.gggg.ggg..",
  "..gwgggggggggg..",
  "..gggggggggggg..",
  "..gppggppggppg..",
  "..gggggggggggg..",
  "..oooooooooooo..",
  "................",
  "................",
  "................",
  "................",
], { g: GOLD, w: "#fdeeb0", p: PURPLE, o: GOLD_DK });

/* 铁肺 — steel lungs */
const IronLungs = makeGlyph([
  "................",
  "................",
  ".......tt.......",
  ".......tt.......",
  ".....tttttt.....",
  "...ttt.tt.ttt...",
  "..wttt.tt.tttt..",
  "..tttt....tttt..",
  ".ttttt....ttttt.",
  ".ttttt....ttttt.",
  ".stttt....tttts.",
  ".sstt......ttss.",
  "..ss........ss..",
  "................",
  "................",
  "................",
], { t: "#c7d2e4", w: GLINT, s: "#7c8aa5" });

/* 先知之眼 — the oracle eye */
const Oracle = makeGlyph([
  "................",
  "................",
  "................",
  "................",
  ".....vvvvvv.....",
  "...vvwwwwwwvv...",
  "..vwwwppppwwwv..",
  ".vwwwppkwppwwwv.",
  ".vwwwppkkppwwwv.",
  "..vwwwppppwwwv..",
  "...vvwwwwwwvv...",
  ".....vvvvvv.....",
  "................",
  "................",
  "................",
  "................",
], { v: PURPLE_DK, w: "#efe6ff", p: PURPLE, k: "#160e24" });

/* 忠诚之心 — the loyal heart */
const LoyalClub = makeGlyph([
  "................",
  "................",
  "..rrrr....rrrr..",
  ".rrrrrr..rrrrrr.",
  ".rwwrrrrrrrrrre.",
  ".rwrrrrrrrrrrre.",
  ".rrrrrrrrrrrrre.",
  "..rrrrrrrrrrre..",
  "...rrrrrrrrre...",
  "....rrrrrrre....",
  ".....rrrrre.....",
  "......rrre......",
  ".......rr.......",
  "................",
  "................",
  "................",
], { r: "#ef4444", w: "#ffd9d9", e: "#b91c1c" });

/* 护身符 — the amulet */
const Talisman = makeGlyph([
  "................",
  ".......cc.......",
  "......c..c......",
  ".....c....c.....",
  "......gggg......",
  ".....gwvvvg.....",
  "....gvppppvg....",
  "....gvppppvg....",
  "....gvppppvg....",
  ".....gvvvvg.....",
  "......gggg......",
  ".......gg.......",
  "................",
  "................",
  "................",
  "................",
], { c: "#a16207", g: GOLD, w: GLINT, v: PURPLE_LT, p: PURPLE_DK });

/* 神射手 — the flaming ball */
const Sharpshooter = makeGlyph([
  "................",
  ".......f........",
  "......ff...f....",
  ".....fFf..ff....",
  "....fFFf.fFf....",
  "...fFFFFfFFf....",
  "...fFFFFFFFFf...",
  "....kkwwwwkk....",
  "..kkwwwwwwwwkk..",
  ".kwwwwwkkwwwwwk.",
  ".kwwwwkkkkwwwwk.",
  ".kwwwwwkkwwwwwk.",
  "..kwwwwwwwwwwk..",
  "...kwwwwwwwwk...",
  ".....kkkkkk.....",
  "................",
], { f: "#f97316", F: "#fbbf24", k: "#221733", w: "#f4f1fb" });

/* 铁人 — the steel shield */
const Ironman = makeGlyph([
  "................",
  "................",
  "..ssssssssssss..",
  ".swwsssssssssss.",
  ".ssssssccssssss.",
  ".sssccccccccsss.",
  ".sssccccccccsss.",
  ".ssssssccssssss.",
  "..sssssccsssss..",
  "..sssssccsssss..",
  "...ssssccssss...",
  "....sssccsss....",
  ".....ssccss.....",
  "......ssss......",
  ".......ss.......",
  "................",
], { s: "#c7d2e4", w: GLINT, c: "#7dd3fc" });

/* 商业价值 — the coin stack */
const Marketable = makeGlyph([
  "................",
  "................",
  "................",
  ".............w..",
  "....gggggggg....",
  "...gwwggggggo...",
  "...oooooooooo...",
  "...gggggggggg...",
  "...oooooooooo...",
  "...gggggggggg...",
  "...oooooooooo...",
  "....oooooooo....",
  "................",
  "................",
  "................",
  "................",
], { g: GOLD, w: "#fdeeb0", o: GOLD_DK });

/* 浴火重生 — the phoenix flame */
const Comeback = makeGlyph([
  "................",
  ".......f........",
  "..f...ff...f....",
  "..ff.fFFf.ff....",
  "...ffFFFFfff....",
  "..ffFFwwFFff....",
  ".fffFwwwwFfff...",
  ".ffFFwwwwFFff...",
  "..fFFwwwwFFf....",
  "..fFFFwwFFFf....",
  "...fFFFFFFf.....",
  "....fFFFFf......",
  ".....ffff.......",
  "................",
  "................",
  "................",
], { f: "#f97316", F: "#fbbf24", w: "#fef3c7" });

/* 玻璃大炮 — the crystal shard cluster */
const GlassCannon = makeGlyph([
  "................",
  ".......cc.......",
  "......cwcc......",
  "......cwcc......",
  "......cccc......",
  ".....cccccc.c...",
  "..c..cccccc.cc..",
  ".ccc.ccCCcc.cc..",
  ".cwc.ccCCcc.cC..",
  ".ccc..cCCc...C..",
  "..C...cCCc......",
  ".......cc.......",
  "................",
  "................",
  "................",
  "................",
], { c: "#67e8f9", w: GLINT, C: "#0e7490" });

/* 雇佣兵 — the briefcase */
const Mercenary = makeGlyph([
  "................",
  "................",
  "................",
  "......BBBB......",
  ".....B....B.....",
  "..BBBBBBBBBBBB..",
  "..bbbbbbbbbbbb..",
  "..bbbbbggbbbbb..",
  "..bbbbbggbbbbb..",
  "..bbbbbbbbbbbb..",
  "..bbbbbbbbbbbb..",
  "..oooooooooooo..",
  "................",
  "................",
  "................",
  "................",
], { k: "#160e24", B: "#b45309", b: "#92400e", g: GOLD, o: "#5f2b07" });

/* 大器晚成 — the golden bud sprout */
const LateBloomer = makeGlyph([
  "................",
  "................",
  "......gggg......",
  ".....gwwggg.....",
  ".....gggggg.....",
  "......gggg......",
  ".......nn.......",
  "..nnn..nn..nnn..",
  ".nnNnn.nn.nnNnn.",
  "..nnn..nn..nnn..",
  ".......nn.......",
  ".......nn.......",
  ".....NNNNNN.....",
  "....NNNNNNNN....",
  "................",
  "................",
], { g: GOLD, w: "#fdeeb0", n: "#22c55e", N: "#15803d" });

const BLESSING_GLYPHS: Readonly<Record<string, ReturnType<typeof makeGlyph>>> = {
  golden_boy: GoldenBoy,
  iron_lungs: IronLungs,
  oracle: Oracle,
  loyal_club: LoyalClub,
  talisman: Talisman,
  sharpshooter: Sharpshooter,
  ironman: Ironman,
  marketable: Marketable,
  comeback: Comeback,
  glass_cannon: GlassCannon,
  mercenary: Mercenary,
  big_game_player: Trophy,
  late_bloomer: LateBloomer,
};

/** Pixel glyph for a blessing id; unknown ids fall back to the star so a
 *  future blessing never renders an empty pedestal. */
export function PxBlessing({ id, size = 56, className }: { id: string } & PxGlyphProps) {
  const Glyph = BLESSING_GLYPHS[id] ?? Star;
  return <Glyph size={size} className={className} />;
}

/* ─────────────────── stadium ground band (夜场看台) ───────────────────
 * The comp's one image-native region: lit crowd tiers under floodlights at
 * the foot of the screen. Authored as a 96×26 pixel scene — masts, roof,
 * three crowd tiers with rails, ad-board wall — with the crowd stippled by
 * a fixed-seed LCG so the drawing is deterministic across renders. */
const STAND_W = 96;

function stadiumGrid(): Grid {
  let s = 20260811;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const blank = ".".repeat(STAND_W);
  const solid = (ch: string) => ch.repeat(STAND_W);
  /* one crowd row: stippled heads in three dim tones, ~14% empty seats */
  const crowd = (tones: string) => Array.from({ length: STAND_W }, () => {
    const r = rnd();
    return r < 0.14 ? "." : tones[Math.floor(rnd() * tones.length)] ?? ".";
  }).join("");
  const rows: string[] = [];
  /* floodlight heads + masts at three bays */
  const masts = [14, 48, 82];
  const headRow = (w: number) => {
    const a = blank.split("");
    masts.forEach((x) => { for (let i = x - w; i <= x + w; i++) if (a[i] !== undefined) a[i] = "L"; });
    return a.join("");
  };
  const mastRow = () => {
    const a = blank.split("");
    masts.forEach((x) => { if (a[x] !== undefined) a[x] = "m"; });
    return a.join("");
  };
  rows.push(headRow(2), headRow(2));
  rows.push(mastRow(), mastRow(), mastRow());
  rows.push(solid("r"));                                  // roof edge
  rows.push(crowd("abc"), crowd("abc"), crowd("abc"));    // upper tier (dimmest)
  rows.push(solid("d"));                                  // rail
  rows.push(crowd("abbc"), crowd("bbca"), crowd("abcb"), crowd("bcab")); // mid tier
  rows.push(solid("d"));                                  // rail
  rows.push(crowd("bcbh"), crowd("cbhb"), crowd("bhbc"), crowd("hbcb"), crowd("bcbh")); // lower tier (closest, a few lit faces)
  rows.push(solid("d"));
  rows.push(solid("w"), "..ww".repeat(STAND_W / 4), solid("w")); // ad-board wall with dashes
  rows.push(solid("e"), solid("e"));                      // pitch apron
  return rows;
}

const STADIUM_GRID = stadiumGrid();
const STADIUM_H = STADIUM_GRID.length;
const STADIUM_RUNS = gridRuns(STADIUM_GRID, {
  L: "#ffe9a8", m: "#3a2f52", r: "#191024",
  a: "#4a3b68", b: "#6d5a8f", c: "#584878", h: "#b79ae0",
  d: "#241a38", w: "#2d2145", e: "#161022",
});

/** The fixed ground plane behind the shop — width-filling, bottom-anchored. */
export const PxStadium = memo(function PxStadium({ className }: { className?: string }) {
  return (
    <svg viewBox={`0 0 ${STAND_W} ${STADIUM_H}`} preserveAspectRatio="xMidYMax slice" shapeRendering="crispEdges" aria-hidden="true" focusable="false" className={className}>
      {STADIUM_RUNS.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={r.c} />)}
    </svg>
  );
});
