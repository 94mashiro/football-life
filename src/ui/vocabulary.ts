/**
 * The shared UI vocabulary — centralized label maps + the persona/identity
 * tag definitions used across the Menu / Play / Summary screens.
 *
 * This is the "shared vocabulary" the architecture review (candidate #4) pulled
 * out of App.tsx: pure data + pure functions over that data, no JSX, no hooks,
 * no engine side effects. It lives in src/ui/ alongside the other shared UI
 * modules (MonoCrest, ShareCard, Sheet, icons…) — consistent with the
 * existing pattern, not a reversal of App.tsx's "screens + inline components
 * in one file" decision (see docs/adr/0002).
 *
 * App.tsx imports these back; the symbols are `export`ed here and re-imported
 * there. Adding a label/persona entry is now a one-file edit instead of
 * grepping a 4700-line App.tsx.
 */
import type { Trophy, Award } from "../engine/types";
import { LEAGUES } from "../engine/data";

export const TROPHY_LABEL: Record<Trophy, string> = {
  league: "联赛", cup: "杯赛", continental_primary: "欧冠", continental_secondary: "欧联",
  club_world_cup: "世俱", national_continental: "洲际", world_cup: "世界杯", olympic: "奥运",
};
/** 母本 confederation-specific continental-cup names. */
export const CONT_PRIMARY_NAME: Record<string, string> = {
  UEFA: "欧冠", CONMEBOL: "解放者杯", AFC: "亚冠精英", CONCACAF: "北美冠军杯", CAF: "非冠", OFC: "大洋洲冠军联赛",
};
export const CONT_SECONDARY_NAME: Record<string, string> = {
  UEFA: "欧联", CONMEBOL: "南美杯", AFC: "亚冠二级", CONCACAF: "中北美联", CAF: "非联杯", OFC: "大洋洲杯",
};
export const NAT_CONT_NAME: Record<string, string> = {
  UEFA: "欧洲杯", CONMEBOL: "美洲杯", AFC: "亚洲杯", CONCACAF: "金杯赛", CAF: "非洲杯", OFC: "大洋洲国家杯",
};
/** League confederation lookup for confederation-aware trophy labels. */
export function confederationOfLeague(leagueId: string): string {
  return LEAGUES.find((l) => l.id === leagueId)?.confederation ?? "UEFA";
}
export function trophyLabel(t: Trophy, conf: string): string {
  if (t === "continental_primary") return CONT_PRIMARY_NAME[conf] ?? "洲际";
  if (t === "continental_secondary") return CONT_SECONDARY_NAME[conf] ?? "洲际次";
  if (t === "national_continental") return NAT_CONT_NAME[conf] ?? "洲际";
  return TROPHY_LABEL[t];
}
export const TROPHY_GOLD: Trophy[] = ["world_cup", "continental_primary", "club_world_cup", "national_continental"];
/** Does this trophy set contain any “gold” (major) trophy? Drives the hero
 *  card's trophy pill foil — 方向 C, mud-to-marble in the honor dimension. */
export function hasGoldTrophy(trophies: readonly Trophy[]): boolean {
  return trophies.some((t) => TROPHY_GOLD.includes(t));
}

/** 情报封锁 (ascension 3+): every probability numeral is black-taped — the
 *  run plays blind. Asc 0 has no blind logic at all; the old settings toggle
 *  (purist) is gone, blind is purely an ascension penalty now. */
export const BLIND_ASCENSION = 3;

export const AWARD_LABEL: Record<Award, string> = { ballon_dor: "金球", golden_boot: "金靴", golden_glove: "金手套", csl_mvp: "中超最佳", csl_boot: "中超金靴", afc_poy: "亚洲足球先生" };
export const ROLE_LABEL: Record<string, string> = {
  starter: "主力", high_rotation: "轮换", low_rotation: "边缘", substitute: "替补", third_keeper: "三门",
};

/** 告别仪式 (retirement_ceremony): the farewell style the player chose at a
 *  forced retirement (OVR floor / age ceiling) — surfaced on the summary as a
 *  persistent capstone marker (the verdict overlay showed the full scene in
 *  play; this line lets the player revisit their chosen way to say goodbye). */
export const FAREWELL_LABEL: Record<"private" | "public" | "grand", string> = {
  private: "私下告别 · 不张扬的离开",
  public: "发社媒宣布 · 公开的告别",
  grand: "召开退役发布会 · 隆重的告别",
};

/** P1 可见词条:把引擎的 persona/identity status tag 显形为顶栏上的「我成了
 *  什么样的球员」词条片——roguelike 的 build 可见化（research/core-loop-design.md
 *  P1）。只显形身份类 tag；机械性 tag（contract_crisis / *_done / talisman /
 *  nagging_injury / doped / cautious_play）保持隐藏。tag 编码为 "name@ttl"，取
 *  裸名；personaTagsEver 也是裸名，同一函数兼容两路输入。键集须与
 *  run.ts 的 PERSONA_TAG_KEYS 同步。 */
export interface PersonaTag { label: string; gloss: string; tone: "legendary" | "special" | "good" | "warn" | "muted"; }
export const PERSONA_TAG: Record<string, PersonaTag> = {
  // 词条成型 (combo) — 两个词条熔合的 build 报偿,永久生效,金色最前排。
  combo_dynasty:   { label: "王朝旗帜", gloss: "一城之魂铸王朝，联赛夺冠概率提升", tone: "legendary" },
  combo_talisman:  { label: "民心所向", gloss: "万人拥戴的袖标，洲际赛事夺冠概率提升", tone: "legendary" },
  combo_adopted:   { label: "第二故乡", gloss: "异乡成故乡，大赛决战成功概率提升", tone: "legendary" },
  combo_iron:      { label: "铁血队长", gloss: "伤疤是勋章，伤病影响减轻", tone: "legendary" },
  // 一人一城 = 升上一线队后从未转会（退役时判定，run.ts finalizeRun）；
  // 功勋球员 = 连续 3 次拒绝转会留队（club_legend@99）。两者不是一回事：
  // 一个说的是整段生涯只有一家俱乐部，一个说的是在某家俱乐部拒了三次报价。
  one_club:        { label: "一人一城", gloss: "成年生涯只效力过一家俱乐部", tone: "legendary" },
  club_legend:     { label: "功勋球员", gloss: "三度拒绝转会，与球队共命运", tone: "legendary" }, // 连续3次留队
  naturalized:      { label: "归化球员", gloss: "改换国家队会籍", tone: "special" },   // 改换国家队会籍
  captain:          { label: "队长", gloss: "球队袖标，夺冠加成", tone: "good" },          // 袖标——联赛夺冠概率加成
  fan_darling:      { label: "球迷宠儿", gloss: "球迷站在你这边", tone: "good" },      // 球迷宠儿
  mentor_legend:    { label: "传道者", gloss: "让位指导新秀", tone: "good" },        // 让位指导新秀
  compromised_body: { label: "带伤硬扛", gloss: "带伤上阵，成长受损", tone: "warn" },      // 带伤上阵——成长代价
  intl_retired:     { label: "退出国家队", gloss: "告别国字号", tone: "muted" },   // 告别国字号
};
export const PERSONA_ORDER: readonly string[] = [
  "combo_dynasty", "combo_talisman", "combo_adopted", "combo_iron",
  "one_club", "club_legend", "naturalized", "captain", "fan_darling", "mentor_legend", "compromised_body", "intl_retired",
];
export const TRAIT_TONE_CLASS: Record<PersonaTag["tone"], string> = {
  legendary: "trait-legendary", special: "trait-special", good: "trait-good", warn: "trait-warn", muted: "trait-muted",
};
/** Persona 词条从裸 tag 名映射为可见 chip。接受 "name@ttl"（当前激活）或裸
 *  "name"（personaTagsEver 累积集）两种输入。按 PERSONA_ORDER 排序：身份感
 *  强的（金/紫）在前，代价/状态（橙/灰）在后。空数组 = 无词条（新秀卡干净）。 */
export function personaTags(tags: readonly string[] | undefined): PersonaTag[] {
  if (!tags || tags.length === 0) return [];
  const have = new Set(tags.map((t) => t.split("@")[0]!));
  const out: PersonaTag[] = [];
  for (const key of PERSONA_ORDER) if (have.has(key)) out.push(PERSONA_TAG[key]!);
  return out;
}

// ── Tier color mental model ───────────────────────────────────────────────────
// One tier-color system reused for OVR / odds / ratings / card foil (AGENTS.md):
// gold (90+) / good-teal (80-89) / warn-amber (70-79) / dim (<70). Color is
// always paired with the numeral (color-blind-legible). Pure number→string.

/** OVR foil tier — the mud→marble arc drives the foil color (text + gradient
    face) on every OVR surface. 6 tiers (handoff 1.3): bronze / silver / gold /
    cyan / elite / special. Color is always paired with the numeral. */
export function ovrTier(ovr: number): string {
  if (ovr >= 99) return "special";
  if (ovr >= 95) return "elite";
  if (ovr >= 90) return "cyan";
  if (ovr >= 80) return "gold";
  if (ovr >= 70) return "silver";
  return "bronze";
}
/** Inline OVR text color — the foil tier's text hue (used on season rows, the
    identity strip, the FUT card, the summary). */
export function ovrTierClass(ovr: number): string {
  return `tier-${ovrTier(ovr)}`;
}
/** 档位头衔 — the OVR-tier career verdict shown on the summary endgame banner
    (无名之辈 → 足球之神). The mud→marble verdict a fan retells. */
export const TIER_TITLE: Record<string, string> = {
  bronze: "无名之辈", silver: "站稳脚跟", gold: "一方名将",
  cyan: "顶级球星", elite: "时代巨星", special: "足球之神",
};
export function tierTitle(ovr: number): string { return TIER_TITLE[ovrTier(ovr)]!; }
/** Rating tier (reuses the one-tier mental model: ≥8.3 gold, ≥7.3 teal,
 *  ≥6.5 amber, else dim) — drives the ledger 评分 badge's data-tier, mirroring
 *  the OVR 能力 badge so the verdict reads as a hero number, not plain text.
 *  "good" uses the teal band (same as the OVR cyan tier) for color-blind-
 *  legible parity with the ability badge. */
export function ratingTier(r: number): string {
  if (r >= 8.3) return "gold";
  if (r >= 7.3) return "good";
  if (r >= 6.5) return "warn";
  return "dim";
}
export function ratingTierClass(r: number): string {
  return `tier-${ratingTier(r)}`;
}
/** Color-only odds tier (no pill chrome) for trophy/title % numerals. */
export function oddsTierClass(p: number): string {
  if (p >= 0.7) return "tier-good";
  if (p >= 0.4) return "tier-warn";
  return "tier-danger";
}
