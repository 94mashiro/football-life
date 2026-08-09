/**
 * App orchestrator — owns the top-level view switch and routes to screen
 * components. State lives in useGameStore (reducer). UI uses Tailwind utilities.
 */
import { useState, useRef, useEffect, useCallback, Fragment } from "react";
import { useGameStore } from "./state/store";
import { Sheet } from "./ui/Sheet";
import { IconChevron, IconMode, IconNav, IconTrend } from "./ui/icons";
import type { PaceMode } from "./engine/run";
import { projectedRetireAge, clubTrophyCandidates, computeSeasonRating } from "./engine/sim";
import { NATIONS, LEAGUES, ALL_POSITIONS, CLUBS, clubsByLeague, weakestClubInLeague, clubById, leagueById, ROLE_GROUP, generatePlayerName, generateSquadNumber, clubStarRating, type Position, type RoleGroup } from "./engine/data";
import { clubCrestPath, leagueLogoPath, trophyPath, nationFlagPath } from "./engine/images";
import { ShareCardOverlay, type ShareCardData, type ShareTrophyEntry, type ShareClubEntry } from "./ui/ShareCard";
import {
  BLESSINGS, ASCENSIONS, UNLOCKS, FREE_NATIONS, isUnlocked, resolveLoadout, MAX_LOADOUT,
  PRESTIGE_PERKS, prestigeEligible, prestigeChoices, PRESTIGE_LEGACY_THRESHOLD,
  nearMissChallenges, makeChallenge, challengeSucceeded,
  dailySetup as dailySetupFn, todayStr, type DailyResult,
  ACHIEVEMENTS, ALL_TROPHY_IDS, computeAchievementInput,
  LEGEND_DRAFTS, type LegendDraft,
  ASCENSION_UNLOCK_REQ, maxAscensionUnlocked,
} from "./meta/legacy";
import type { GameState, Trophy, Award, TrophyOddsEntry, Choice, ChoicePreview } from "./engine/types";
import { sfxTap, sfxGood, sfxBad, sfxTrophy, sfxMilestone, sfxBoss, setSfxEnabled } from "./engine/sfx";

const TROPHY_LABEL: Record<Trophy, string> = {
  league: "联赛", cup: "杯赛", continental_primary: "欧冠", continental_secondary: "欧联",
  club_world_cup: "世俱", national_continental: "洲际", world_cup: "世界杯",
};
/** 母本 confederation-specific continental-cup names. */
const CONT_PRIMARY_NAME: Record<string, string> = {
  UEFA: "欧冠", CONMEBOL: "解放者杯", AFC: "亚冠精英", CONCACAF: "北美冠军杯", CAF: "非冠", OFC: "大洋洲冠军联赛",
};
const CONT_SECONDARY_NAME: Record<string, string> = {
  UEFA: "欧联", CONMEBOL: "南美杯", AFC: "亚冠二级", CONCACAF: "中北美联", CAF: "非联杯", OFC: "大洋洲杯",
};
const NAT_CONT_NAME: Record<string, string> = {
  UEFA: "欧洲杯", CONMEBOL: "美洲杯", AFC: "亚洲杯", CONCACAF: "金杯赛", CAF: "非洲杯", OFC: "大洋洲国家杯",
};
/** League confederation lookup for confederation-aware trophy labels. */
function confederationOfLeague(leagueId: string): string {
  return LEAGUES.find((l) => l.id === leagueId)?.confederation ?? "UEFA";
}
function trophyLabel(t: Trophy, conf: string): string {
  if (t === "continental_primary") return CONT_PRIMARY_NAME[conf] ?? "洲际";
  if (t === "continental_secondary") return CONT_SECONDARY_NAME[conf] ?? "洲际次";
  if (t === "national_continental") return NAT_CONT_NAME[conf] ?? "洲际";
  return TROPHY_LABEL[t];
}
const TROPHY_GOLD: Trophy[] = ["world_cup", "continental_primary", "club_world_cup", "national_continental"];
/** Does this trophy set contain any “gold” (major) trophy? Drives the hero
 *  card's trophy pill foil — 方向 C, mud-to-marble in the honor dimension. */
function hasGoldTrophy(trophies: readonly Trophy[]): boolean {
  return trophies.some((t) => TROPHY_GOLD.includes(t));
}

/** 方向 C: the current club's league-title odds for the top bar — a persistent
 *  “how close am I to the next trophy” pull at every moment of the career. The
 *  league title is the most relatable honor; surfacing it turns the bar from a
 *  pure OVR/age meter into an honor-chase meter. Returns null when the club is
 *  a minnow with <1% odds (no noise on the bar for a 0% career). */
function leagueTitleOdds(game: GameState, ovr: number): number | null {
  const club = game.currentClubId ? clubById(game.currentClubId) : null;
  if (!club) return null;
  const league = leagueById(club.leagueId);
  const toff = game.tournamentOffset ?? 0;
  const cands = clubTrophyCandidates(ovr, club, league, game.age, toff, (game.statusTags ?? []).some((t) => t.split("@")[0] === "captain"));
  const leagueEntry = cands.find((c) => c.trophy === "league");
  const p = leagueEntry?.prob ?? 0;
  return p >= 0.01 ? p : null;
}
const AWARD_LABEL: Record<Award, string> = { ballon_dor: "金球", golden_boot: "金靴", golden_glove: "金手套" };
const ROLE_LABEL: Record<string, string> = {
  starter: "主力", high_rotation: "轮换", low_rotation: "边缘", substitute: "替补", third_keeper: "三门",
};

/** P1 可见词条:把引擎的 persona/identity status tag 显形为顶栏上的「我成了
 *  什么样的球员」词条片——roguelike 的 build 可见化（research/core-loop-design.md
 *  P1）。只显形身份类 tag；机械性 tag（contract_crisis / *_done / talisman /
 *  nagging_injury / doped / cautious_play）保持隐藏。tag 编码为 "name@ttl"，取
 *  裸名；personaTagsEver 也是裸名，同一函数兼容两路输入。键集须与
 *  run.ts 的 PERSONA_TAG_KEYS 同步。 */
interface PersonaTag { label: string; tone: "legendary" | "special" | "good" | "warn" | "muted"; }
const PERSONA_TAG: Record<string, PersonaTag> = {
  club_legend:     { label: "一人一城", tone: "legendary" }, // 连续3次留队——Totti/Maldini 弧线
  naturalized:      { label: "归化球员", tone: "special" },   // 改换国家队会籍
  captain:          { label: "队长", tone: "good" },          // 袖标——联赛夺冠概率加成
  fan_darling:      { label: "球迷宠儿", tone: "good" },      // 球迷宠儿
  mentor_legend:    { label: "传道者", tone: "good" },        // 让位指导新秀
  compromised_body: { label: "带伤硬扛", tone: "warn" },      // 带伤上阵——成长代价
  intl_retired:     { label: "退出国家队", tone: "muted" },   // 告别国字号
};
const PERSONA_ORDER: readonly string[] = [
  "club_legend", "naturalized", "captain", "fan_darling", "mentor_legend", "compromised_body", "intl_retired",
];
const TRAIT_TONE_CLASS: Record<PersonaTag["tone"], string> = {
  legendary: "trait-legendary", special: "trait-special", good: "trait-good", warn: "trait-warn", muted: "trait-muted",
};
/** Persona 词条从裸 tag 名映射为可见 chip。接受 "name@ttl"（当前激活）或裸
 *  "name"（personaTagsEver 累积集）两种输入。按 PERSONA_ORDER 排序：身份感
 *  强的（金/紫）在前，代价/状态（橙/灰）在后。空数组 = 无词条（新秀卡干净）。 */
function personaTags(tags: readonly string[] | undefined): PersonaTag[] {
  if (!tags || tags.length === 0) return [];
  const have = new Set(tags.map((t) => t.split("@")[0]!));
  const out: PersonaTag[] = [];
  for (const key of PERSONA_ORDER) if (have.has(key)) out.push(PERSONA_TAG[key]!);
  return out;
}

/** Nation flag emoji for the player card. England uses its subdivision flag. */
const FLAG: Record<string, string> = {
  bra: "🇧🇷", arg: "🇦🇷", fra: "🇫🇷", eng: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", esp: "🇪🇸", ger: "🇩🇪",
  ita: "🇮🇹", por: "🇵🇹", ned: "🇳🇱", bel: "🇧🇪", jpn: "🇯🇵", kor: "🇰🇷",
  chn: "🇨🇳", usa: "🇺🇸", mex: "🇲🇽", tur: "🇹🇷", sco: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  gre: "🇬🇷", egy: "🇪🇬",
};
function flagEmoji(id: string): string { return FLAG[id] ?? ""; }

/** Club crest <img> with a caller-supplied fallback when no asset exists (or
 *  it fails to load). The scraped copero library covers 226/305 clubs; the
 *  rest fall back to whatever the caller renders — a circular monogram on the
 *  hero card, a hue-tinted badge in the ledger, nothing on a transfer choice —
 *  so a card is never broken by a missing crest. */
function Crest({ path, alt, fallback, size = 28, imgClass = "crest-img" }: {
  path: string | null; alt: string; fallback?: React.ReactNode; size?: number; imgClass?: string;
}) {
  const [err, setErr] = useState(false);
  if (!path || err) return <>{fallback ?? null}</>;
  return <img className={imgClass} src={path} alt={alt} width={size} height={size} loading="lazy" decoding="async" onError={() => setErr(true)} />;
}
/** League competition logo, or null (renders nothing). */
function LeagueLogo({ leagueId, size = 16 }: { leagueId: string; size?: number }) {
  const path = leagueLogoPath(leagueId);
  const [err, setErr] = useState(false);
  if (!path || err) return null;
  return <img className="league-logo" src={path} alt={leagueById(leagueId).name} width={size} height={size} loading="lazy" decoding="async" onError={() => setErr(true)} />;
}

/** P-A172: unified share helper — prefer the native Web Share sheet on mobile
 *  (one tap → pick TikTok / WeChat / etc), fall back to clipboard copy. The old
 *  clipboard-only path required copy + app-switch + paste on mobile, killing
 *  share conversion. navigator.share needs HTTPS + a user gesture (all share
 *  buttons are onClick) and is available on iOS Safari + Chrome Android.
 *  Pass the challenge link as `url`, NOT inside `text`: only a real url member
 *  makes iOS / WeChat / X render a link-preview card instead of flat text. */
async function shareText(text: string, url?: string): Promise<void> {
  const full = url ? `${text}\n${url}` : text;
  try {
    if (typeof navigator !== "undefined" && navigator.share) {
      await navigator.share(url ? { text, url } : { text });
      return;
    }
  } catch (err) {
    // ONLY a user-dismissed sheet may suppress the clipboard fallback. Every
    // other rejection — NotAllowedError inside a WeChat/Douyin in-app WebView,
    // a Permissions-Policy block in an embedded iframe, InvalidStateError from
    // a double tap — must still land the text somewhere. Returning on all of
    // them turned every share button into a silent no-op for exactly the
    // in-app-browser audience this feature targets, and the app has no toast
    // to reveal the failure.
    if ((err as { name?: string } | null)?.name === "AbortError") return;
  }
  try { await navigator.clipboard?.writeText(full); } catch { /* noop */ }
}

/** ── challenge links ──────────────────────────────────────────────────────
 *  One wire format, one encoder, one parser. This used to be a template literal
 *  hand-copied across four call sites with a fifth hand-rolled reader, which is
 *  precisely how two of the copies drifted into encoding the wrong league. Add
 *  a field here and every producer plus the consumer stay in step. */
interface CareerLink {
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

function careerUrl(l: CareerLink): string {
  const q = new URLSearchParams({ s: l.seed, n: l.nationalityId, p: l.position, l: l.leagueId, m: l.pace });
  if (l.playerName?.trim()) q.set("nm", l.playerName.trim().slice(0, 16));
  if (l.squadNumber !== undefined) q.set("no", String(l.squadNumber));
  if (l.dailyDate) q.set("d", l.dailyDate);
  if (l.clubId) q.set("c", l.clubId);
  return `${window.location.origin}${window.location.pathname}#${q.toString()}`;
}

const VALID_PACE: readonly PaceMode[] = ["long", "normal", "express"];

/** Parse a share hash. Yields the seed alone when only that is valid (legacy
 *  `#seed=` links just prefill the field) and a full CareerLink when the whole
 *  setup is present and valid. */
function parseCareerUrl(hash: string): { seed?: string; link?: CareerLink } {
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

/** The CTA + hashtag tail, defined once so the wording cannot drift between the
 *  buttons a single user meets in one session (it had already forked into three
 *  phrasings).
 *  NB "同设定", not "同生涯": the link carries seed + nat/pos/league/pace, but
 *  blessings, ascension and prestige perks always come from the RECIPIENT's own
 *  save — store.ts overrides them on START_RUN — and they move start OVR, the
 *  starting club, growth, injury rate and the legacy multiplier the card invites
 *  a comparison against. Same settings is the most we can honestly promise. */
const SHARE_CTA = "同种子同设定，你能超越我吗？";
const SHARE_TAGS = "#绿茵轮回 #足球挑战";
const DAILY_TAGS = "#绿茵轮回 #今日挑战";


/** P-A6/P-A163: the share hash is read ONCE, at module load, before React gets
 *  to choose a screen. It used to be an effect inside MenuScreen, which mounts
 *  only when there is no game — so for a returning visitor whose in-progress
 *  career is restored from localStorage the link did nothing at all, and the
 *  un-consumed hash then hijacked them into a stranger's run the moment they
 *  next hit 主菜单. Reading here makes the link work from any entry state and
 *  guarantees the hash is consumed exactly once. */
const PENDING_LINK: { seed?: string; link?: CareerLink } =
  typeof window !== "undefined" ? parseCareerUrl(window.location.hash) : {};
if (typeof window !== "undefined" && window.location.hash) {
  history.replaceState(null, "", window.location.pathname);
}
/** A shared link starts exactly one run. StrictMode runs mount effects twice in
 *  dev, which would otherwise raise the overwrite confirm twice and start the
 *  career twice. */
let linkConsumed = false;

/** Auto-start a shared career link. Lives at App level so it fires whether the
 *  visitor lands on the menu or on a career restored from localStorage. */
function useSharedLinkAutoStart(store: ReturnType<typeof useGameStore>) {
  const { startRun, game, dailySeed } = store;
  // read through a ref so the mount-only effect still sees the restored game
  const gameRef = useRef(game);
  gameRef.current = game;
  useEffect(() => {
    const link = PENDING_LINK.link;
    if (!link || linkConsumed) return;
    linkConsumed = true;
    // Never silently bin a career in progress — that run belongs to the person
    // holding the phone, not to whoever sent the link.
    const live = gameRef.current;
    if (live && live.phase === "playing" &&
        !window.confirm("打开这个挑战链接会放弃当前进行中的生涯，确定？")) return;
    const today = todayStr();
    if (link.dailyDate && link.dailyDate !== today) {
      // A daily link opened after its day: play TODAY's daily instead of a stale
      // seed that could never be recorded. The invite was "come do the daily",
      // so this still lands the recipient on the board it advertised.
      const ds = dailySetupFn(today);
      // Shared/daily runs are neutral (no blessings/perks/ascension, wonderkid
      // open): the whole point of a shared seed is that both phones replay the
      // SAME career — meta state on either side would break the promise.
      startRun({
        seed: dailySeed(today), nationalityId: ds.nationalityId, position: ds.position,
        leagueId: ds.leagueId, blessings: [], ascension: 0,
        pace: "normal", permPerks: [], allowWonderkid: true, dailyDate: today,
      });
      return;
    }
    startRun({
      seed: link.seed, nationalityId: link.nationalityId, position: link.position,
      leagueId: link.leagueId, clubId: link.clubId, blessings: [], ascension: 0,
      pace: link.pace, permPerks: [], allowWonderkid: true, dailyDate: link.dailyDate,
      playerName: link.playerName, squadNumber: link.squadNumber,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export default function App() {
  const store = useGameStore();
  const { game } = store;
  useSharedLinkAutoStart(store);
  // Play is a fixed-height app shell (its own header, its own scroller, its own
  // docked decision deck) so the choice never leaves the thumb zone. Menu and
  // summary are documents and keep the shared header + page scroll.
  if (game && game.phase === "playing") return <PlayScreen game={game} store={store} />;
  return (
    <div className="max-w-3xl mx-auto px-5 min-h-full flex flex-col">
      <Header store={store} />
      {!game && <MenuScreen store={store} />}
      {game && game.phase === "summary" && <SummaryScreen game={game} store={store} />}
    </div>
  );
}

// ───────────────────────────── shared bits ─────────────────────────────

/** The confederation a nation's trophies read in — a Brazilian wins the 美洲杯
 *  even while employed in an AFC league, so national-team badges must never
 *  label from the league's confederation. */
function natConfOf(natId?: string): string | undefined {
  return NATIONS.find((x) => x.id === natId)?.confederation;
}
/** `n` collapses repeats into one badge (欧冠 ×3) instead of N identical pills. */
function TrophyBadge({ t, conf, natConf, n, leagueId }: { t: Trophy; conf?: string; natConf?: string; n?: number; leagueId?: string }) {
  const gold = TROPHY_GOLD.includes(t);
  const useConf = t === "national_continental" ? (natConf ?? conf) : conf;
  const img = useConf ? trophyPath(t, useConf, leagueId, natConf) : null;
  return (
    <span className={`trophy-badge font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded ${
      gold ? "bg-gold/15 text-gold" : "bg-accent/12 text-accent"
    }`}>
      {img && <img className="trophy-badge-img" src={img} alt="" loading="lazy" decoding="async" />}
      <span>{useConf ? trophyLabel(t, useConf) : TROPHY_LABEL[t]}</span>
      {n && n > 1 ? <b className="ml-0.5 opacity-70">×{n}</b> : null}
    </span>
  );
}
function AwardBadge({ a, n }: { a: Award; n?: number }) {
  return (
    <span className="award-badge font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gold/20 text-gold">
      {AWARD_LABEL[a]}
      {n && n > 1 ? <b className="ml-1 opacity-70">×{n}</b> : null}
    </span>
  );
}

/** 方向 A: per-club trophy odds surfaced on transfer choices — the honor axis
 *  competitors hide, rendered as a compact color-coded pill row so it reads as
 *  real odds (the “Odds are the hero” differentiator), not a wall of text.
 *  gold entries (联赛/洲际主项) lead and are bolder; silver entries (杯赛/洲际副项)
 *  trail muted. Only rendered when the choice actually carries trophy odds. */
function TrophyOddsRow({ odds, purist }: { odds: readonly TrophyOddsEntry[]; purist: boolean }) {
  if (odds.length === 0 || purist) return null;
  return (
    <div className="trophy-odds-row mt-1">
      {odds.map((o, i) => {
        const tier = oddsTierClass(o.prob);
        return (
          <span key={i} className={`trophy-odds-pill ${tier} ${o.tier === "gold" ? "is-gold" : "is-silver"}`} title={`${o.label}夺冠概率`}>
            <span className="trophy-odds-lbl">🏆{o.label}</span>
            <span className="trophy-odds-pct">{Math.round(o.prob * 1000) / 10}%</span>
          </span>
        );
      })}
    </div>
  );
}
/** 决策板 —— the choice is a board of comparable cards, not a stack of rows.
 *
 *  A career decision is a comparison ("which of these three clubs?", "gamble or
 *  not?"), and a vertical list makes the reader hold each option in memory to
 *  compare it with the next. Side by side, the same facts land in the same
 *  place in every column, so the eye does the comparing.
 *
 *  Two card flavors, chosen by what the choice actually carries:
 *  - a club card (crest, name, spec column, trophy odds, league footer) for
 *    transfer/loan offers;
 *  - a fate card (the line you'd take, then both branches as color-coded
 *    outcome pills) for events.
 *  The baseline options (留在/退役/走人) are not offers and never share the
 *  offers' geometry — they sit under the board as one full-width row. */

const OFFER_VERB: Partial<Record<Choice["kind"], string>> = {
  new_club: "加盟", join_loan: "租借至", permanent_transfer: "买断加盟", stay: "留在",
};
/** Kinds that are the decision's baseline rather than one of its offers. */
const BASELINE_KINDS = new Set<Choice["kind"]>(["stay", "retire", "farewell", "goodbye", "walkaway"]);

/** Star rating → tier color (the one-tier mental model, equipment-quality
 *  style): 5★ gold / 4★ purple / 3★ amber / 2★ muted / 1★ dim. The hue carries
 *  the level so the eye sorts clubs by color without counting stars — the
 *  same color+numeral legibility the OVR/odds tiers use. */
function starTierClass(stars: number): string {
  if (stars >= 5) return "tier-gold";
  if (stars === 4) return "tier-good";
  if (stars === 3) return "tier-warn";
  if (stars === 2) return "tier-muted";
  return "tier-dim";
}

/** Colored ★ run — the club-strength indicator on the picker, the setup hint
 *  and (via renderSubWithStars) inside transfer-option sub lines. */
function Stars({ n, className }: { n: number; className?: string }) {
  return <span className={[starTierClass(n), className].filter(Boolean).join(" ")}>{"★".repeat(Math.max(0, n))}</span>;
}

/** Color the ★ segment inside a dot-separated sub line. Transfer options read
 *  "联赛 · ★★★★ · 主力" and the ★ run is always its own segment, so a pure-★
 *  match picks up the tier color while the rest keeps the parent's muted hue. */
function renderSubWithStars(sub: string) {
  return sub.split(" · ").map((seg, i) => (
    <Fragment key={i}>
      {i > 0 && " · "}
      {/^★+$/.test(seg) ? <span className={starTierClass(seg.length)}>{seg}</span> : seg}
    </Fragment>
  ));
}

function PreviewPills({ preview, purist }: { preview: readonly ChoicePreview[]; purist: boolean }) {
  return (
    <span className="oc-pills">
      {preview.map((p, i) => {
        const flat = p.label === "无变化";
        return (
          <span key={i} className={`oc-pill ${flat ? "is-flat" : p.good ? "is-good" : "is-bad"}`}>
            <IconTrend dir={flat ? "flat" : p.good ? "up" : "down"} />
            <span className="oc-pill-lbl">{p.label}</span>
            {p.prob !== undefined && !purist && (
              <b className="oc-pill-pct">{Math.round(p.prob * 100)}%</b>
            )}
          </span>
        );
      })}
    </span>
  );
}

function OptionCard({ c, purist, fate, onPick }: {
  c: Choice; purist: boolean; fate: boolean; onPick: () => void;
}) {
  const club = c.clubId ? clubById(c.clubId) : undefined;
  const league = club ? leagueById(club.leagueId) : undefined;
  // The sub line is dot-separated facts; as a column they line up row-for-row
  // across the cards, which is the whole point of the board. The league is
  // dropped here only when the footer already shows it — matched by value, not
  // by position, so a reordered sub can never silently lose a fact. When the
  // outcome pills carry the odds, the sub is only ever a restatement of them.
  // A sub that is only the event's odds (boss events) restates the headline
  // probability already sitting above the board — twice on screen, once per
  // card, is noise. Anything with real content survives.
  const bare = !c.sub || /^\d+(\.\d+)?%$/.test(c.sub) || purist || !!c.preview;
  const specs = bare ? [] : c.sub!.split(" · ").filter((s) => s && s !== league?.name && s !== club?.name);
  return (
    <button className="option-card" data-kind={club ? "club" : "fate"} data-fate={fate ? "true" : undefined} onClick={onPick}>
      {club ? (
        <>
          <span className="oc-verb">{OFFER_VERB[c.kind] ?? "前往"}</span>
          <span className="oc-name">{club.name}</span>
          <Crest path={clubCrestPath(club.id)} alt="" size={40} imgClass="oc-crest"
            fallback={<span className="oc-crest-mono">{club.name.slice(0, 1)}</span>} />
        </>
      ) : (
        <span className="oc-name oc-name-fate">{c.text}</span>
      )}
      {specs.length > 0 && (
        <span className="oc-specs">{specs.map((s, i) => <span key={i} className={/^★+$/.test(s) ? starTierClass(s.length) : undefined}>{s}</span>)}</span>
      )}
      {c.preview && c.preview.length > 0 && <PreviewPills preview={c.preview} purist={purist} />}
      {c.trophyOdds && <TrophyOddsRow odds={c.trophyOdds} purist={purist} />}
      {league && (
        <span className="oc-league">
          <Crest path={leagueLogoPath(league.id)} alt="" size={13} imgClass="oc-league-logo" fallback={null} />
          {league.name}
        </span>
      )}
    </button>
  );
}

function DecisionBoard({ choices, purist, fate, onPick }: {
  choices: readonly Choice[]; purist: boolean; fate: boolean; onPick: (id: string) => void;
}) {
  const offers = choices.filter((c) => !BASELINE_KINDS.has(c.kind));
  const baseline = choices.filter((c) => BASELINE_KINDS.has(c.kind));
  // Past three columns the cards stop being comparable at thumb width, so a
  // long enumerated decision (降薪报价、告别名单) keeps the scannable row list.
  if (offers.length === 0 || offers.length > 3) {
    return (
      <div className="deck-options">
        {choices.map((c) => (
          <button key={c.id} className="option" onClick={() => onPick(c.id)}>
            <span className="option-lead">
              {c.clubId && <Crest path={clubCrestPath(c.clubId)} alt={c.text} size={22} imgClass="opt-crest" />}
              <span className="font-semibold">
                {c.text}
                {c.sub && !purist && <span className="block font-normal text-[10px] leading-snug text-muted mt-0.5">{renderSubWithStars(c.sub)}</span>}
                {c.trophyOdds && <TrophyOddsRow odds={c.trophyOdds} purist={purist} />}
              </span>
            </span>
            <span className="option-go"><IconChevron dir="right" /></span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="deck-options">
      <div className="option-board" data-cols={offers.length}>
        {offers.map((c) => (
          <OptionCard key={c.id} c={c} purist={purist} fate={fate} onPick={() => onPick(c.id)} />
        ))}
      </div>
      {baseline.map((c) => {
        const club = c.clubId ? clubById(c.clubId) : undefined;
        return (
          <button key={c.id} className="option option-baseline" onClick={() => onPick(c.id)}>
            <span className="option-lead">
              {club && <Crest path={clubCrestPath(club.id)} alt="" size={22} imgClass="opt-crest" fallback={<span className="chip-crest-mono">{club.name.slice(0, 1)}</span>} />}
              <span className="font-semibold">
                {c.text}
                {c.sub && !purist && <span className="block font-normal text-[10px] leading-snug text-muted mt-0.5">{renderSubWithStars(c.sub)}</span>}
                {c.trophyOdds && <TrophyOddsRow odds={c.trophyOdds} purist={purist} />}
              </span>
            </span>
            <span className="option-go"><IconChevron dir="right" /></span>
          </button>
        );
      })}
    </div>
  );
}

/** Count occurrences preserving first-seen order — for the ×N badge collapse. */
function tally<T extends string>(list: readonly T[]): [T, number][] {
  const m = new Map<T, number>();
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()];
}
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[11px] font-semibold tracking-[0.16em] uppercase text-accent mb-2.5">{children}</p>;
}

/** Compact stat strip — one unified panel with dividers (replaces identical card grid). */
function StatStrip({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <div className="stat-strip">
      {items.map((it) => (
        <div key={it.label}>
          <div className="lbl">{it.label}</div>
          <div className="val">{it.value}</div>
        </div>
      ))}
    </div>
  );
}

/** The canonical OVR badge (handoff 4.2) — a foil-gradient block with a micro
    label ("能力" / "生涯最高") and a font-black OVR. The mud→marble anchor,
    reused in the summary hero and the player sheet. */
function OvrBadge({ ovr, label, size = "md" }: { ovr: number; label: string; size?: "sm" | "md" | "lg" }) {
  const dim = size === "lg" ? { w: 72, h: 72, n: 32 } : size === "sm" ? { w: 42, h: 42, n: 18 } : { w: 56, h: 56, n: 24 };
  return (
    <div className={`ovr-badge foil-${ovrTier(ovr)}`} data-tier={ovrTier(ovr)} style={{ width: dim.w, height: dim.h }}>
      <span className="ob-label" style={size === "sm" ? { fontSize: 7 } : undefined}>{label}</span>
      <span className="ob-num" style={{ fontSize: dim.n }}>{ovr}</span>
    </div>
  );
}

function SeasonRow({ s, fresh = false, position, seed, natConf }: { s: GameState["seasons"][number]; fresh?: boolean; position?: Position; seed?: string; natConf?: string }) {
  const group: RoleGroup = position ? ROLE_GROUP[position] : "attacker";
  const rating = seasonRating(s, position);
  const hl = seasonHighlight(s, seed, group);
  const q = seasonQuote(s, rating);
  return (
    <div className={`season-row ${fresh ? "anim-slide" : ""}`}>
      <span className="sr-age">{s.age}</span>
      <div className="sr-body">
        <div className="sr-top">
          <span className="sr-club">
            {s.clubName}
            {s.relegated && <span className="sr-tag">降级</span>}
          </span>
          <span className="sr-nums">
            <span className={`sr-ovr ${ovrTierClass(s.overall)}`}>{s.overall}</span>
            {rating !== null && <span className={`sr-rating ${ratingTierClass(rating)}`}>{rating.toFixed(1)}</span>}
          </span>
        </div>
        <div className="sr-meta">
          {s.leagueName} · {ROLE_LABEL[s.role] ?? s.role}
          <span className="sr-stats"> · {seasonStatChips(s, group)}</span>
          {s.marketValue !== undefined && s.marketValue > 0 && (
            <span className="sr-mv"> · 身价€{s.marketValue >= 1 ? `${s.marketValue}M` : `${Math.round(s.marketValue * 1000)}K`}</span>
          )}
        </div>
        {hl && <div className="sr-highlight">⚽ {hl}</div>}
        {q && <div className="sr-quote">“{q}”</div>}
        {(s.trophies.length > 0 || s.awards.length > 0 || s.nationalTournaments.length > 0 || (s.seasonHonors ?? []).length > 0) && (
          <div className="sr-honors">
            {s.trophies.map((t, i) => <TrophyBadge key={i} t={t} conf={confederationOfLeague(s.leagueId)} leagueId={s.leagueId} />)}
            {s.awards.map((a, i) => <AwardBadge key={`a${i}`} a={a} />)}
            {s.nationalTournaments.map((nt, i) => <TrophyBadge key={`n${i}`} t={nt.trophy} conf={confederationOfLeague(s.leagueId)} leagueId={s.leagueId} natConf={natConf} />)}
            {(s.seasonHonors ?? []).map((h, i) => (
              <span key={`h${i}`} className={`font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded ${h === "mvp" ? "bg-gold/20 text-gold" : "bg-accent/12 text-accent"}`}>{h === "mvp" ? "MVP" : "最佳11人"}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** P-A3: a deterministic per-season match moment, derived from the seed + the
 *  season's stats so each season feels like real football rather than a row of
 *  numbers. Picks the most dramatic beat available (trophy decider > hat-trick >
 *  clean sheet > debut). */
function seasonHighlight(s: GameState["seasons"][number], seed: string | undefined, group: RoleGroup): string | null {
  const h = seed ? hashStr(`${seed}:highlight:${s.age}`) : (s.age * 7919);
  const pick = <T,>(arr: readonly T[]) => arr[h % arr.length]!;
  // trophy decider — a final moment that won the silverware
  if (s.trophies.includes("continental_primary")) return pick(["加时赛绝杀，洲际冠军！", "点球大战封王", "决赛梅开二度，登顶洲际"]);
  if (s.trophies.includes("league")) return pick(["最后一轮锁定联赛冠军", "争冠天王山之战破门", "提前夺冠，球迷涌入球场"]);
  if (s.trophies.includes("cup")) return pick(["杯赛决赛绝杀", "点球大战稳稳罚进", "杯赛黑马之旅封王"]);
  if (s.trophies.includes("world_cup")) return pick(["世界杯决赛加时绝杀！永恒之夜", "点球大战封王，举国欢腾", "决赛头球定鼎，历史铭记"]);
  // individual heroics
  if (s.stats.goals >= 20) return pick([`${s.stats.goals}球赛季，金靴在望`, "上演帽子戏法引爆全场", "连场破门，射手榜领跑"]);
  if (group === "goalkeeper" && s.stats.cleanSheets >= 15) return pick([`${s.stats.cleanSheets}场零封，钢铁防线`, "点球神扑，全场沸腾", "门将封神，一夫当关"]);
  if (s.stats.assists >= 15) return pick(["助攻戴帽，喂饼大师", "妙传撕裂防线，全场起立", "赛季助攻王级别的视野"]);
  if (s.role === "starter" && s.overall >= 85) return pick(["坐稳主力，赛季全勤", "队长袖标，领袖气质", "全场最佳，球迷高歌你之名"]);
  if (s.relegated) return pick(["保级生死战失利，泪洒球场", "最后一轮降级，至暗时刻", "无力回天，随队坠入深渊"]);
  if (s.role === "substitute") return pick(["替补登场造险，等待机会", "板凳上的煎熬", "有限时间里拼命证明自己"]);
  return null;
}

// minimal deterministic hash for UI-only highlight picking (not the sim engine).
function hashStr(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0 || 1;
}

/** P-A11: a coach/media one-line verdict per season, derived from rating +
 *  role + stats. Gives each season a "被评说" texture — the fan-talk layer. */
function seasonQuote(s: GameState["seasons"][number], rating: number | null): string | null {
  if (rating === null) return null;
  const h = hashStr(`${s.age}:${s.clubId}:quote`);
  const pick = <T,>(arr: readonly T[]) => arr[h % arr.length]!;
  if (rating >= 8.5) return pick(["世界级表现，无可挑剔", "这是现象级的一季", "媒体惊呼：新一代球王", "球迷起立鼓掌，赛季最佳"]);
  if (rating >= 7.8) return pick(["出色的一季，稳坐核心", "数据亮眼，赢得信任", "关键先生，不可或缺", "高光时刻频现"]);
  if (rating >= 7.0) return pick(["稳健可靠，尽职尽责", "表现合格，仍有上升空间", "球队的重要一环", "默默奉献的中坚"]);
  if (rating >= 6.3) return pick(["表现平庸，需要突破", "出场时间有限，难有作为", "教练给的机会不多", "挣扎中寻找状态"]);
  return pick(["令人失望的一季", "出场寥寥，前途堪忧", "板凳坐穿，质疑声四起", "迷失赛季，亟待反弹"]);
}

/** P-A17: format a career wage total (sum of weekly wages × ~50 weeks) for display. */
function fmtCareerWage(seasons: readonly { wage?: number }[]): string {
  const total = seasons.reduce((sum, s) => sum + (s.wage ?? 0) * 50, 0); // €K weekly × 50 weeks
  if (total >= 1000) return `${(total / 1000).toFixed(1)}M`; // €1M+ reads as M, never 16900K
  return `${Math.round(total)}K`;
}

/** Market value in €M → compact label (0.4 → 400K, 12.5 → 12.5M). */
function fmtMv(mv: number): string {
  return mv >= 1 ? `${mv}M` : mv > 0 ? `${Math.round(mv * 1000)}K` : "0";
}

/** 显示态赛季：最后揭示季。revealCount=0 时取上个 period 末季（最后揭示过的），
 *  开局第一 period 无上个 period 则取首季（= 初始 16 岁 OVR，无信息量）。
 *  不剧透本 period 未揭示的季——新 period 开局显示上个 period 末状态，
 *  点「下一赛季」后才推进到本 period 首季。 */
function displaySeasonOf(game: GameState, revealCount: number, periodLength: number): GameState["seasons"][number] {
  const revealedCount = Math.max(0, game.seasons.length - periodLength + revealCount);
  return revealedCount > 0 ? game.seasons[revealedCount - 1]! : game.seasons[0]!;
}

function rankOf(score: number) {
  if (score >= 800) return { name: "球神", color: "var(--color-accent)" };
  if (score >= 500) return { name: "传奇", color: "var(--color-gold)" };
  if (score >= 300) return { name: "巨星", color: "var(--color-good)" };
  if (score >= 150) return { name: "明星", color: "var(--color-warn)" };
  if (score >= 60) return { name: "球员", color: "var(--color-muted)" };
  return { name: "替补", color: "var(--color-dim)" };
}
/** Peak-OVR → "超越了 X% 的球员" percentile, interpolated over anchor points.
 *  Flavor framing of the same number the tier system already grades — one more
 *  way to feel what a 92 巅峰 means. Deterministic; never claims 100%. */
function ovrPercentile(ovr: number): number {
  const pts = [[50, 5], [60, 30], [70, 60], [80, 86], [90, 98], [95, 99.5], [99, 99.9]] as const;
  if (ovr <= 50) return 5;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1]!, [x2, y2] = pts[i]!;
    if (ovr <= x2) return Math.round((y1 + ((ovr - x1) / (x2 - x1)) * (y2 - y1)) * 10) / 10;
  }
  return 99.9;
}
/** The one-line epitaph — the career compressed into the sentence a fan retells:
 *  origin club + the defining moment, best first (world cup > ballon d'or >
 *  continental > league > the quiet endings). This is what a settlement is
 *  remembered and shared by. nationalTournaments only records champions, so
 *  the world-cup line can never fire on a semifinal run. */
function careerEpitaph(game: GameState): string {
  const from = `从${game.seasons[0]?.clubName ?? "青训营"}出发`;
  const wc = game.seasons.find((s) => s.nationalTournaments.some((n) => n.trophy === "world_cup"));
  if (wc && game.player) return `${from}，${wc.age}岁率${nationName(game.player.nationalityId)}捧起大力神杯`;
  const bd = game.seasons.find((s) => s.awards.includes("ballon_dor"));
  if (bd) return `${from}，${bd.age}岁加冕金球先生`;
  const cp = game.seasons.find((s) => s.trophies.includes("continental_primary"));
  if (cp) return `${from}，${cp.age}岁登顶${CONT_PRIMARY_NAME[confederationOfLeague(cp.leagueId)] ?? "洲际之巅"}`;
  const lg = game.seasons.find((s) => s.trophies.includes("league"));
  if (lg) return `${from}，${lg.age}岁首夺联赛冠军`;
  if (game.trophies.length === 0 && game.seasons.length >= 8) return `${from}，征战 ${game.seasons.length} 个赛季，无冕却未曾停下`;
  return `${from}，${game.age}岁挂靴，巅峰 OVR ${game.maxOverall}`;
}
/** OVR foil tier — the mud→marble arc drives the foil color (text + gradient
    face) on every OVR surface. 6 tiers (handoff 1.3): bronze / silver / gold /
    cyan / elite / special. Color is always paired with the numeral. */
function ovrTier(ovr: number): string {
  if (ovr >= 99) return "special";
  if (ovr >= 95) return "elite";
  if (ovr >= 90) return "cyan";
  if (ovr >= 80) return "gold";
  if (ovr >= 70) return "silver";
  return "bronze";
}
/** Inline OVR text color — the foil tier's text hue (used on season rows, the
    identity strip, the FUT card, the summary). */
function ovrTierClass(ovr: number): string {
  return `tier-${ovrTier(ovr)}`;
}
/** 档位头衔 — the OVR-tier career verdict shown on the summary endgame banner
    (无名之辈 → 足球之神). The mud→marble verdict a fan retells. */
const TIER_TITLE: Record<string, string> = {
  bronze: "无名之辈", silver: "站稳脚跟", gold: "一方名将",
  cyan: "顶级球星", elite: "时代巨星", special: "足球之神",
};
function tierTitle(ovr: number): string { return TIER_TITLE[ovrTier(ovr)]!; }
/** Season rating — the canonical 综合表现 score (5.5–9.5, SofaScore-style).
 *  Position-fair: computeSeasonRating centers a 合格主力 at ≈7.0 across every
 *  position, so one number judges a CB and a ST equally. Persisted on the
 *  season as a first-class stat (the hero number beyond 出场/进球/助攻/零封);
 *  this wrapper reads it and falls back to recomputing for seasons saved
 *  before the field existed. null = the player didn't appear (suspended /
 *  farewell) — you can't rate a season you didn't play. */
function seasonRating(s: GameState["seasons"][number], position?: Position): number | null {
  if (s.rating !== undefined) return s.rating;
  if (!position) return null;
  const club = clubById(s.clubId);
  const league = leagueById(s.leagueId);
  return club && league ? computeSeasonRating(s, position, club, league) : null;
}
/** Rating tier (reuses the one-tier mental model: ≥8.3 gold, ≥7.3 teal,
 *  ≥6.5 amber, else dim) — drives the ledger 评分 badge's data-tier, mirroring
 *  the OVR 能力 badge so the verdict reads as a hero number, not plain text.
 *  "good" uses the teal band (same as the OVR cyan tier) for color-blind-
 *  legible parity with the ability badge. */
function ratingTier(r: number): string {
  if (r >= 8.3) return "gold";
  if (r >= 7.3) return "good";
  if (r >= 6.5) return "warn";
  return "dim";
}
function ratingTierClass(r: number): string {
  return `tier-${ratingTier(r)}`;
}
/** Position-aware stat chips — the role's current-season data, always visible
    (was hidden on mobile). Tells the right football story per position: a CB's
    clean sheets, a GK's goals conceded, a striker's goals. */
function seasonStatChips(s: GameState["seasons"][number], group: RoleGroup): string {
  const a = s.stats.appearances;
  const g = s.stats.goals, as = s.stats.assists, cs = s.stats.cleanSheets, gc = s.stats.goalsConceded;
  switch (group) {
    case "goalkeeper": return `${a}场 · ${cs}零封 · 失${gc}`;
    case "defensive":  return `${a}场 · ${cs}零封${g > 0 ? ` · ${g}球` : ""}`;
    case "support":    return `${a}场 · ${g}球 · ${as}助`;
    case "creator":    return `${a}场 · ${as}助 · ${g}球`;
    case "attacker":   return `${a}场 · ${g}球 · ${as}助`;
  }
}

/** Color-only odds tier (no pill chrome) for trophy/title % numerals. */
function oddsTierClass(p: number): string {
  if (p >= 0.7) return "tier-good";
  if (p >= 0.4) return "tier-warn";
  return "tier-danger";
}
function nationName(id: string): string {
  return NATIONS.find((n) => n.id === id)?.name ?? id;
}
function profileName(p: string): string {
  return ({ early: "早慧", normal: "常规", late: "晚成", wonderkid: "天才" } as Record<string, string>)[p] ?? p;
}


/** P-A10: count-up animation hook — animates a number from 0 to target over
 *  ~900ms on mount. The dopamine tick for the summary legacy/trophy numbers. */
function useCountUp(target: number, dur = 900): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0; const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      // ease-out cubic for a satisfying deceleration
      const eased = 1 - Math.pow(1 - p, 3);
      setV(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  return v;
}

/** In-progress career status line (menu). Age is NOT the frame here anymore —
    a fill bar that grows with age implied "you are X% through a fixed career",
    which the soft-retention model just broke. What remains is a status line:
    where you are now (age/season) + the LIVE horizon (projected retire age,
    which MOVES with choices/injuries — the emergent uncertainty) + streak.
    The hero card + legacy chip already carry the real "progress"; this is
    context, not an axis. */
function CareerBar({ game }: { game: GameState }) {
  const p = game.player!;
  const club = clubById(game.currentClubId);
  const horizon = projectedRetireAge(p, club, game.statusTags ?? [], game.severeInjuries ?? 0, game.blessings ?? [], game.permPerks ?? []);
  const end = Math.max(p.age + 1, horizon);
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between font-mono text-[10px] text-dim mb-1">
        <span>{p.age} 岁 · 第 {game.seasons.length} 赛季</span>
        <span>预计踢到 {end} 岁</span>
      </div>
      {(game.trophyStreak ?? 0) >= 2 && (
        <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px]">
          <span className="text-gold">🔥 {game.trophyStreak}连冠</span>
          <span className="text-dim">· 每3连冠 +8 传承</span>
        </div>
      )}
      {game.challenge && (
        <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px]">
          <span className="text-warn">🎯 挑战</span>
          <span className="text-muted">{game.challenge.label}</span>
          <span className="text-dim">· 达成 ×{game.challenge.legacyMult.toFixed(1)} 传承</span>
        </div>
      )}
    </div>
  );
}

/** True when the user asked for less motion — scroll-snap and animations honor it. */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() =>
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

// ───────────────────────────── header ─────────────────────────────

function Header({ store }: { store: ReturnType<typeof useGameStore> }) {
  const { game, meta } = store;
  return (
    <header className="app-header">
      {/* One line: wordmark left, the three meta figures right as a divided
          numeral strip. The latin "roguelike football sim" tagline moved into
          the console head — it was a second brand line on a 390px header that
          pushed the figures onto a row of their own. */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="wordmark">绿茵轮回</h1>
        <div className="hdr-stats">
          <span className="hs"><span className="hs-lbl">传承</span><span className="hs-val">{meta.totalLegacy}</span></span>
          <span className="hs"><span className="hs-lbl">最佳</span><span className="hs-val">{meta.bestRun}</span></span>
          <span className="hs"><span className="hs-lbl">飞升</span><span className="hs-val">{meta.ascension}</span></span>
          {meta.prestige > 0 && (
            <span className="hs hs-gold"><span className="hs-lbl">轮回</span><span className="hs-val">{meta.prestige}</span></span>
          )}
          {game && game.customSeed && <span className="hdr-seed">种子 {game.seed}</span>}
        </div>
      </div>
      {game && game.player && <CareerBar game={game} />}
    </header>
  );
}

// ───────────────────────────── menu ─────────────────────────────

const NAV_TABS = [["play", "开始"], ["blessings", "祝福"], ["ascension", "飞升"], ["prestige", "轮回"], ["hall", "殿堂"]] as const;
type MenuTab = "play" | "blessings" | "ascension" | "prestige" | "hall";

function BottomNav({ tab, setTab }: { tab: MenuTab; setTab: (t: MenuTab) => void }) {
  return (
    <nav className="bottom-nav" aria-label="主导航">
      {NAV_TABS.map(([k, label]) => (
        <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)} aria-current={tab === k ? "page" : undefined}>
          <IconNav name={k} className="nav-ico" />
          {label}
        </button>
      ))}
    </nav>
  );
}

/** Quiet deploy colophon — which commit is live. Commit (+ `*` if the worktree
    was dirty at build) and build date are baked into the bundle by vite.config.ts
    `define`. Docked at the bottom of the document screens (menu/summary), the
    place you check “did the new deploy ship”; kept off the play screen's thumb
    zone so it never competes with the hero odds. */
function VersionFooter({ onCheat }: { onCheat?: () => void }) {
  // 隐藏后门：连续点五下版本号触发 onCheat（仅主页传入 +100 传承）。两次
  // 点击间隔超过 1.5s 即视为中断重新计数——避免误触，又让调试时能快速连点。
  const countRef = useRef(0);
  const lastTapRef = useRef(0);
  const tap = () => {
    if (!onCheat) return;
    const now = Date.now();
    countRef.current = now - lastTapRef.current > 1500 ? 1 : countRef.current + 1;
    lastTapRef.current = now;
    if (countRef.current >= 5) {
      countRef.current = 0;
      onCheat();
    }
  };
  return (
    <p className="version-stamp" aria-label={`构建 ${__APP_COMMIT__} · ${__APP_BUILD_DATE__}`} onClick={tap}>
      构建 <b>{__APP_COMMIT__}</b> · {__APP_BUILD_DATE__}
    </p>
  );
}

/** Each tab owns its heading. The play tab's tagline used to sit above every
    tab, so the blessing shop opened under "每一次轮回，都是全新的传奇" and a
    stack of play-tab promo cards before reaching its own content. */
const TAB_TITLE: Record<MenuTab, string> = {
  play: "每一次轮回，都是全新的传奇",
  blessings: "永久祝福",
  ascension: "飞升难度",
  prestige: "轮回献祭",
  hall: "名人殿堂",
};

function MenuScreen({ store }: { store: ReturnType<typeof useGameStore> }) {
  const { meta, startRun, newSeed, dailySeed, lastSetup, buyBlessing, setLoadout, setAscension, archive, clearArchive, prestige, daily, dailyStreak, togglePurist, toggleSound, loginBonus, addLegacy } = store;
  const [tab, setTab] = useState<MenuTab>("play");
  // Setup state lives here rather than in the console so the URL-hash import
  // below can seed it before the console ever renders. A shared link (parsed
  // once at module load, see PENDING_LINK) prefills the chips so a seed-only
  // legacy link still lands on the right setup; a complete link is auto-started
  // from App, above.
  const [seed, setSeed] = useState(() => PENDING_LINK.seed ?? newSeed());
  // 种子模式：默认「随机」——每局自动掷一颗随机种子，玩家无需感知当前种子。
  // 仅当玩家主动切到「指定」并输入种子号才用特定种子；指定种子的轮回可复现，
  // 因此不结算任何 meta 奖励（传承/最佳/飞升/成就）。带着分享链接里的种子进菜单时默认「指定」。
  const [seedMode, setSeedMode] = useState<"random" | "custom">(PENDING_LINK.seed ? "custom" : "random");
  const [nat, setNat] = useState(PENDING_LINK.link?.nationalityId ?? lastSetup?.nationalityId ?? "chn");
  const [playerName, setPlayerName] = useState(PENDING_LINK.link?.playerName ?? lastSetup?.playerName ?? "");
  const [squadNumber, setSquadNumber] = useState<number | null>(PENDING_LINK.link?.squadNumber ?? lastSetup?.squadNumber ?? null);
  const [pos, setPos] = useState<Position>(PENDING_LINK.link?.position ?? lastSetup?.position ?? "ST");
  const [club, setClub] = useState<string>(() => {
    // A hand-picked academy from a share link or last run wins; else fall back
    // to the deterministic weakest club in the link/save/default league, so the
    // default first career is byte-identical to the old league-only start.
    const picked = PENDING_LINK.link?.clubId ?? lastSetup?.clubId;
    if (picked && CLUBS.some((c) => c.id === picked)) return picked;
    const lId = PENDING_LINK.link?.leagueId ?? lastSetup?.leagueId ?? "csl";
    const initLeague = LEAGUES.some((l) => l.id === lId) ? lId : "csl";
    return weakestClubInLeague(initLeague, seed).id;
  });
  const [pace, setPace] = useState<PaceMode>(PENDING_LINK.link?.pace ?? (lastSetup?.pace as PaceMode) ?? "normal");
  // Anything that is not "start the career I just configured" lives on the sheet
  // plane. The play tab is one screen — the console, and doors to the rest.
  const [sheet, setSheet] = useState<null | "daily" | "drafts" | "records" | "prefs">(null);
  const closeSheet = useCallback(() => setSheet(null), []);
  // 装备制在祝福商店里配置(resolveLoadout/SET_LOADOUT);出发时读当前装配。
  const allowWonderkid = isUnlocked(meta, "profile:wonderkid");
  const begin = () => startRun({ seed, nationalityId: nat, position: pos, leagueId: clubById(club).leagueId, clubId: club, blessings: resolveLoadout(meta), ascension: meta.ascension, pace, permPerks: meta.permPerks, allowWonderkid, playerName: playerName.trim() || undefined, squadNumber: squadNumber ?? undefined, customSeed: seedMode === "custom" });

  // P4: daily challenge — fixed seed + fixed setup, everyone plays the same career today.
  const today = todayStr();
  const todaysSeed = dailySeed(today);
  const ds = dailySetupFn(today);
  const todaysResult = daily.find((d) => d.date === today);
  const streak = dailyStreak(daily);
  const startDaily = () => {
    setSheet(null);
    // dailyDate is what marks this run as today's daily. The result used to be
    // filed on a bare seed match, so a casual run that borrowed today's seed
    // from the 今日种子 chip counted as a daily — with the official setup then
    // printed on the share card next to a score from an entirely different career.
    // 公平模式(StS Daily 语义):祝福/声望/升华全部中和,天才档全员开放——
    // 同一天所有人跑同一条生涯,榜单才可比。
    startRun({ seed: todaysSeed, nationalityId: ds.nationalityId, position: ds.position, leagueId: ds.leagueId, blessings: [], ascension: 0, pace: "normal", permPerks: [], allowWonderkid: true, dailyDate: today, playerName: playerName.trim() || undefined, squadNumber: squadNumber ?? undefined });
  };
  const startDraft = (d: LegendDraft) => {
    setSheet(null);
    // 剧本承诺"固定 seed = 确定的戏剧弧线",meta 状态会打破它——同样中和。
    startRun({ seed: d.seed, nationalityId: d.nationalityId, position: d.position, leagueId: d.leagueId, blessings: [], ascension: 0, pace: d.pace, permPerks: [], allowWonderkid: true });
  };
  const hasRecords = meta.runs > 0 || archive.length > 0 || daily.length > 0;

  return (
    <div className="flex flex-col gap-2.5 pt-3 pb-24">
      {/* Mechanics review: the ribbon is a receipt for COMPLETING today's daily
          challenge (granted in settleRun) — not a login handout. Only shown on
          the day it was earned. */}
      {tab === "play" && (loginBonus.bonusLegacy ?? 0) > 0 && loginBonus.lastLoginDate === todayStr() && (
        <p className="login-ribbon">
          <span>🏆 今日挑战完成 · 连击 {loginBonus.consecutiveDays} 天</span>
          <span className="lr-gain">+{loginBonus.bonusLegacy} 传承</span>
          <span className="lr-next">明天再战 +{Math.min(30, 3 + (loginBonus.consecutiveDays + 1) * 3)}</span>
        </p>
      )}

      {/* The play tab's promise lives in the console head; the other tabs still
          name themselves above their content. */}
      {tab !== "play" && <h2 className="text-[18px] font-bold tracking-tight m-0">{TAB_TITLE[tab]}</h2>}

      {tab === "play" && (
        <>
          {/* The one primary object on this surface. */}
          <DebutConsole
            meta={meta} newSeed={newSeed} dailySeed={dailySeed}
            seed={seed} setSeed={setSeed} seedMode={seedMode} setSeedMode={setSeedMode}
            nat={nat} setNat={setNat} pos={pos} setPos={setPos}
            club={club} setClub={setClub} pace={pace} setPace={setPace}
            playerName={playerName} setPlayerName={setPlayerName}
            squadNumber={squadNumber} setSquadNumber={setSquadNumber}
            onStart={begin}
          />

          <ModeBand
            dailyLegacy={todaysResult?.legacy} streak={streak}
            hasRecords={hasRecords} runs={meta.runs} bestRun={meta.bestRun}
            purist={!!meta.puristMode} sound={meta.soundOn !== false}
            rankOf={rankOf} onOpen={setSheet}
          />

          <UnlockLine meta={meta} />
        </>
      )}

      {tab === "blessings" && <BlessingShop meta={meta} buyBlessing={buyBlessing} setLoadout={setLoadout} />}
      {tab === "ascension" && <AscensionPicker meta={meta} setAscension={setAscension} />}
      {tab === "prestige" && <PrestigeScreen meta={meta} prestige={prestige} />}
      {tab === "hall" && <HallOfFame meta={meta} />}

      <DailySheet
        open={sheet === "daily"} onClose={closeSheet} date={today}
        seed={todaysSeed} setup={ds} todaysResult={todaysResult} streak={streak}
        onStart={startDaily} rankOf={rankOf}
      />
      <DraftSheet open={sheet === "drafts"} onClose={closeSheet} onStart={startDraft} />
      <RecordSheet
        open={sheet === "records"} onClose={closeSheet}
        meta={meta} daily={daily} archive={archive} clearArchive={clearArchive} rankOf={rankOf}
      />
      <PrefsSheet
        open={sheet === "prefs"} onClose={closeSheet}
        purist={!!meta.puristMode} sound={meta.soundOn !== false}
        onTogglePurist={togglePurist} onToggleSound={toggleSound}
      />

      <VersionFooter onCheat={() => { addLegacy(100); sfxMilestone(); }} />
      <BottomNav tab={tab} setTab={setTab} />
    </div>
  );
}

/** Real position names, so the picker reads like football rather than like a
    column of three-letter codes. */
const POS_LABEL: Record<string, string> = {
  GK: "门将", CB: "中后卫", LB: "左后卫", RB: "右后卫",
  CDM: "后腰", CM: "中前卫", LM: "左前卫", RM: "右前卫",
  CAM: "前腰", LW: "左边锋", RW: "右边锋", ST: "中锋",
};

/** Shirt numbers a fan associates with each role — the one-tap shortlist;
    any other number goes in by hand. */
const CLASSIC_NUMBERS: Record<RoleGroup, number[]> = {
  goalkeeper: [1, 12, 13, 22, 25],
  defensive: [2, 3, 4, 5, 6],
  support: [6, 8, 14, 16, 18],
  creator: [7, 10, 11, 14, 21],
  attacker: [7, 9, 10, 11, 99],
};

/** A long enumerated choice, opened over the page instead of laid out down it.
    Select-then-confirm: a tap only marks the option (pending); the 确认 button
    in the footer commits it. Closing any other way (X / drag / backdrop)
    discards the pending pick, so the row is never changed by a stray tap.
    This is the debut console's configuration surface — deliberately slower than
    the in-game one-tap decisions, which still commit on tap. */
function PickerSheet({ open, onClose, title, sub, options, value, onPick, minCol = 106 }: {
  open: boolean; onClose: () => void; title: string; sub?: React.ReactNode;
  options: { id: string; label: React.ReactNode; hint?: React.ReactNode; locked?: boolean }[];
  value: string; onPick: (id: string) => void; minCol?: number;
}) {
  const [pending, setPending] = useState(value);
  useEffect(() => { if (open) setPending(value); }, [open, value]);
  return (
    <Sheet open={open} onClose={onClose} tall title={title} sub={sub}
      footer={<button className="btn-primary w-full py-3 text-base" onClick={() => { onPick(pending); onClose(); }}>确认</button>}>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minCol}px, 1fr))` }}>
        {options.map((o) => (
          <button
            key={o.id}
            disabled={o.locked}
            aria-pressed={pending === o.id}
            className={`chip ${pending === o.id ? "chip-active" : ""} ${o.locked ? "opacity-35 cursor-not-allowed" : ""}`}
            onClick={() => { if (!o.locked) setPending(o.id); }}
          >
            {o.label}
            {o.hint && <span className="block text-[10px] text-dim mt-0.5 font-normal">{o.hint}</span>}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/** The 青训队伍 picker — every club grouped by its league. ~230 clubs is a
 *  long list, so league section heads anchor the scroll; each chip's star hint
 *  is the club's OWN strength (rep), making the bench-vs-starter tradeoff
 *  scannable without reading the league head. */
function ClubPickerSheet({ open, onClose, value, onPick }: {
  open: boolean; onClose: () => void; value: string; onPick: (id: string) => void;
}) {
  const [pending, setPending] = useState(value);
  useEffect(() => { if (open) setPending(value); }, [open, value]);
  return (
    <Sheet open={open} onClose={onClose} tall title="青训队伍" sub="选定母队——强队荣誉高但起步替补，弱队易当主力"
      footer={<button className="btn-primary w-full py-3 text-base" onClick={() => { onPick(pending); onClose(); }}>确认</button>}>
      <div className="flex flex-col gap-3">
        {LEAGUES.map((l) => {
          const clubs = clubsByLeague(l.id);
          if (clubs.length === 0) return null;
          return (
            <div key={l.id}>
              <div className="club-group-head">
                <LeagueLogo leagueId={l.id} size={15} />
                <span className="cgh-name">{l.name}</span>
                <span className="cgh-meta">{l.tier === 1 ? "顶级" : "次级"} · <Stars n={Math.max(l.domRep, l.contRep) + 1} /></span>
              </div>
              <div className="grid gap-2 mt-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))" }}>
                {clubs.map((c) => (
                  <button
                    key={c.id}
                    aria-pressed={pending === c.id}
                    className={`chip chip-club ${pending === c.id ? "chip-active" : ""}`}
                    onClick={() => setPending(c.id)}
                  >
                    <Crest path={clubCrestPath(c.id)} alt={c.name} size={22} imgClass="chip-crest" fallback={<span className="chip-crest-mono">{c.name.slice(0, 1)}</span>} />
                    <span className="chip-name">{c.name}</span>
                    <Stars n={clubStarRating(c.rep)} className="block text-[10px] mt-0.5 font-normal" />
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}

const PACE_LABEL: Record<PaceMode, [string, string]> = {
  long: ["沉浸", "每赛季一次决策"], normal: ["标准", "每两赛季一次决策"], express: ["速通", "每三赛季一次决策"],
};

/**
 * The debut console — the play tab's only primary object.
 *
 * Six value rows that state the career you are about to start, and the button
 * that starts it, inside one container. The CTA used to live in a fixed
 * `.start-cta-bar` docked above the nav; that bar existed only because the form
 * had been pushed below a stack of promo cards and scrolled out of reach. With
 * the console back in the first viewport the button can sit against the
 * configuration it commits, which is where a commit button belongs.
 *
 * 姓名 and 号码 share one 身份 row rather than taking one each: they are two
 * halves of the same answer ("who is on the shirt"), and the console only
 * clears the fold while it stays at six rows.
 */
function DebutConsole({ meta, newSeed, dailySeed, seed, setSeed, seedMode, setSeedMode, nat, setNat, pos, setPos, club, setClub, pace, setPace, playerName, setPlayerName, squadNumber, setSquadNumber, onStart }: {
  meta: ReturnType<typeof useGameStore>["meta"];
  newSeed: () => string;
  dailySeed: (dateStr: string) => string;
  seed: string; setSeed: (v: string) => void;
  seedMode: "random" | "custom"; setSeedMode: (m: "random" | "custom") => void;
  nat: string; setNat: (v: string) => void;
  pos: Position; setPos: (v: Position) => void;
  club: string; setClub: (v: string) => void;
  pace: PaceMode; setPace: (v: PaceMode) => void;
  playerName: string; setPlayerName: (v: string) => void;
  squadNumber: number | null; setSquadNumber: (v: number | null) => void;
  onStart: () => void;
}) {
  const locked = (id: string) => !isUnlocked(meta, `nation:${id}`) && !FREE_NATIONS.includes(id);
  const [picker, setPicker] = useState<null | "nat" | "identity" | "pos" | "club" | "pace" | "seed">(null);
  const closePicker = useCallback(() => setPicker(null), []);

  // what the seed would generate — shown as the fallback identity
  const generatedName = generatePlayerName(seed, nat);
  const generatedNumber = generateSquadNumber(seed, pos);

  const today = todayStr();
  const todaysSeed = dailySeed(today);
  // 复制种子 must actually copy. Routing it through shareText handed a bare
  // ≤12-char token to a native share sheet with no URL and no context, and
  // dismissing the sheet left the clipboard untouched — while the button sits
  // right beside the seed input whose only point is to get the string back out.
  // 分享链接 / 挑战好友 next to it already cover sharing.
  const copySeed = () => { void navigator.clipboard?.writeText(seed).catch(() => {}); };
  // The chosen academy club and its league — picking a club fully determines
  // the start (the league is derived). Strength stars sit on the club, not the
  // league: a 16-year-old debuting at a 5-star club rides the bench; at a 1-star
  // club he starts. That bench-vs-starter tradeoff IS the 青训队伍 decision.
  const clubObj = clubById(club);
  const leagueObj = LEAGUES.find((l) => l.id === clubObj.leagueId);
  // P-A6/P-A163: the URL-hash read + auto-start now lives at App level (see
  // PENDING_LINK), so it runs even when a restored career means MenuScreen never
  // mounts. This SetupForm only builds share URLs.
  const setupLink = (): CareerLink => ({
    seed, nationalityId: nat, position: pos, leagueId: clubObj.leagueId, clubId: club, pace,
    playerName: playerName.trim() || undefined,
    squadNumber: squadNumber ?? undefined,
  });
  // share a link with the seed baked into the URL — the TikTok zero-friction loop.
  const shareLink = () => {
    const natName = NATIONS.find((n) => n.id === nat)?.name ?? "?";
    shareText(`⚽ 绿茵轮回 · ${natName} ${POS_LABEL[pos] ?? pos} · ${clubObj.name}`, careerUrl(setupLink()));
  };
  // P-A122: share a challenge link with full setup baked in — the viral K-factor driver.
  const shareChallenge = () => {
    const natName = NATIONS.find((n) => n.id === nat)?.name ?? "?";
    const who = playerName.trim() ? playerName.trim() + " · " : "";
    const text = `⚽ 绿茵轮回 · 我挑战你\n${who}${natName} ${POS_LABEL[pos] ?? pos} · ${clubObj.name}\n种子 ${seed}\n${SHARE_CTA}\n${SHARE_TAGS}`;
    shareText(text, careerUrl(setupLink()));
  };

  return (
    <div className="card console">
      {/* Label and promise share the console's head line — the promise used to
          be an h2 band of its own above the card, costing a full row of the
          first viewport to say nothing the console could not carry. */}
      <div className="console-head">
        <span className="ch-title">出道台</span>
        <span className="ch-sub">每一次轮回，都是全新的传奇</span>
      </div>

      {/* Six long lists — identity, 19 nations, 12 positions, 230 青训队伍, 3
          paces, and a seed — as rows that state their value and open over the
          page to change it. Laid down the page they were three screens of chip
          grid. The 身份 row leads because a name and a number on a shirt is the
          one line here that reads as a person rather than a setting. */}
      <div className="field-list">
        <button className="field-row" onClick={() => setPicker("identity")}>
          <span className="fr-lbl">身份</span>
          <span className="fr-val">
            {playerName.trim()
              ? <span className="font-semibold">{playerName.trim()}</span>
              : <span className="text-muted-hi">{generatedName}</span>}
            <span className="font-mono font-bold text-accent ml-1.5">#{squadNumber ?? generatedNumber}</span>
            <span className="fr-hint">留空按种子生成，印在球衣与战报</span>
          </span>
          <span className="fr-go"><IconChevron dir="right" /></span>
        </button>
        <button className="field-row" onClick={() => setPicker("nat")}>
          <span className="fr-lbl">国籍</span>
          <span className="fr-val">
            <span className="mr-1.5">{flagEmoji(nat)}</span>{nationName(nat)}
          </span>
          <span className="fr-go"><IconChevron dir="right" /></span>
        </button>
        <button className="field-row" onClick={() => setPicker("pos")}>
          <span className="fr-lbl">位置</span>
          <span className="fr-val">
            {POS_LABEL[pos] ?? pos} <span className="font-mono text-dim text-[13px]">{pos}</span>
            <span className="fr-hint">前锋刷进球与金球，后卫门将靠冠军</span>
          </span>
          <span className="fr-go"><IconChevron dir="right" /></span>
        </button>
        <button className="field-row" onClick={() => setPicker("club")}>
          <span className="fr-lbl">青训队伍</span>
          <span className="fr-val">
            <Crest path={clubCrestPath(club)} alt={clubObj.name} size={18} imgClass="fr-crest" />
            {clubObj.name}
            <span className="fr-hint">{leagueObj?.name ?? "—"} · {leagueObj?.tier === 1 ? "顶级" : "次级"} · <Stars n={clubStarRating(clubObj.rep)} /> · 强队替补，弱队主力</span>
          </span>
          <span className="fr-go"><IconChevron dir="right" /></span>
        </button>
        <button className="field-row" onClick={() => setPicker("pace")}>
          <span className="fr-lbl">节奏</span>
          <span className="fr-val">
            {PACE_LABEL[pace][0]}
            <span className="fr-hint">{PACE_LABEL[pace][1]}</span>
          </span>
          <span className="fr-go"><IconChevron dir="right" /></span>
        </button>
        <button className="field-row" onClick={() => setPicker("seed")}>
          <span className="fr-lbl">种子</span>
          <span className="fr-val">
            {seedMode === "custom"
              ? <span className="font-mono text-accent">{seed}</span>
              : <span className="text-accent">🎲 随机</span>}
            <span className="fr-hint">{seedMode === "custom" ? "指定种子不结算传承与成就，仅供复盘分享" : "每局自动随机，正常结算传承与奖励"}</span>
          </span>
          <span className="fr-go"><IconChevron dir="right" /></span>
        </button>
      </div>

      {/* P-A5: a first-time visitor gets the loop in three lines, inside the
          console instead of as a card above it. The console already defaults to
          the recommended Brazilian striker, so the CTA below IS the one-tap
          start the separate 新手引导 card used to duplicate. */}
      {meta.runs === 0 && (
        <ol className="how-list">
          <li>16 岁青训球员，从弱队起步</li>
          <li>每个赛季末做<b className="text-text">一个决策</b>，选择改变命运</li>
          <li>踢到退役，按巅峰 + 奖杯结算<b className="text-text">传承分</b></li>
        </ol>
      )}

      <button className="btn-primary w-full mt-3.5 py-3.5 text-base start-cta" onClick={onStart}>开始生涯 →</button>

      <PickerSheet
        open={picker === "nat"} onClose={closePicker} title="国籍" value={nat} onPick={setNat}
        sub="国籍决定国家队舞台——世界杯与洲际杯的荣誉从这里来"
        options={NATIONS.map((n) => ({
          id: n.id,
          label: <><span className="text-base mr-1">{flagEmoji(n.id)}</span>{n.name}</>,
          locked: locked(n.id),
          hint: locked(n.id) ? `需 ${UNLOCKS.find((u) => u.id === `nation:${n.id}`)!.reqLegacy} 传承` : undefined,
        }))}
      />
      <PickerSheet
        open={picker === "pos"} onClose={closePicker} title="位置" value={pos} onPick={(v) => setPos(v as Position)}
        sub="前锋刷进球与金球；后卫、门将靠冠军堆荣誉"
        options={ALL_POSITIONS.map((p) => ({ id: p, label: POS_LABEL[p] ?? p, hint: p }))}
      />
      <ClubPickerSheet open={picker === "club"} onClose={closePicker} value={club} onPick={setClub} />
      <PickerSheet
        open={picker === "pace"} onClose={closePicker} title="节奏" value={pace} onPick={(v) => setPace(v as PaceMode)} minCol={150}
        sub="决策之间隔多少个赛季——密一点更有戏，疏一点跑得快"
        options={(["long", "normal", "express"] as const).map((m) => ({ id: m, label: PACE_LABEL[m][0], hint: PACE_LABEL[m][1] }))}
      />

      {/* Name and number answer one question — who is on the shirt — so they
          share a sheet as well as a row. Both fall back to the seed. */}
      <Sheet open={picker === "identity"} onClose={closePicker} title="身份" sub="印在球衣背面和分享战报上。留空则按种子生成。">
        <input
          value={playerName}
          aria-label="球员姓名"
          placeholder={generatedName}
          maxLength={16}
          onChange={(e) => setPlayerName(e.target.value.replace(/\s+/g, " ").trimStart())}
          className="w-full bg-surface-2 border border-line rounded-md px-3 py-3 text-[15px] font-semibold outline-none focus:border-accent"
        />
        <div className="flex gap-2 mt-2.5">
          <button className="btn-sm flex-1" onClick={() => setPlayerName(generatedName)}>🎲 种子名</button>
          {playerName.trim() && <button className="btn-sm flex-1" onClick={() => setPlayerName("")}>清空</button>}
        </div>
        <p className="font-mono text-[11px] text-muted mt-2 mb-4">种子名：{generatedName} · 最多 16 字</p>

        <SectionTitle>球衣号码</SectionTitle>
        <div className="flex gap-2">
          <input
            value={squadNumber ?? ""}
            aria-label="球衣号码，1 到 99"
            inputMode="numeric"
            placeholder={`#${generatedNumber}`}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/\D/g, "").slice(0, 2));
              setSquadNumber(n >= 1 ? n : null);
            }}
            className="w-24 bg-surface-2 border border-line rounded-md px-3 py-3 text-[15px] font-mono font-bold text-center outline-none focus:border-accent"
          />
          <button
            aria-pressed={squadNumber === null}
            className={`chip flex-1 ${squadNumber === null ? "chip-active" : ""}`}
            onClick={() => setSquadNumber(null)}
          >
            🎲 随机 <span className="text-[10px] text-muted font-normal">按种子 · #{generatedNumber}</span>
          </button>
        </div>
        {/* One row of shirt numbers a fan of this position would reach for —
            the full 1–99 wall lives behind the input, not on screen. */}
        <div className="flex gap-2 mt-2.5">
          {CLASSIC_NUMBERS[ROLE_GROUP[pos]].map((n) => (
            <button
              key={n}
              aria-pressed={squadNumber === n}
              className={`chip flex-1 font-mono ${squadNumber === n ? "chip-active" : ""}`}
              onClick={() => setSquadNumber(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </Sheet>

      {/* Determinism is the product's signature, so the seed keeps a real
          surface — just not a permanent card in the first viewport. Editing,
          rerolling, borrowing today's seed and sending it to a friend are the
          same task and now sit in the same place. */}
      <Sheet
        open={picker === "seed"} onClose={closePicker} title="种子 SEED"
        sub={`${nationName(nat)} ${pos} · ${leagueObj?.name ?? "—"}`}
      >
        {/* 模式切换：默认「随机」（无需感知种子），「指定」才输入种子号。指定种子可复现，
            因此不结算任何 meta 奖励——杜绝用已知好种子刷传承/最佳/飞升/成就。 */}
        <div className="flex gap-2 mb-3">
          <button
            aria-pressed={seedMode === "random"}
            className={`chip flex-1 ${seedMode === "random" ? "chip-active" : ""}`}
            onClick={() => setSeedMode("random")}
          >
            🎲 随机
          </button>
          <button
            aria-pressed={seedMode === "custom"}
            className={`chip flex-1 ${seedMode === "custom" ? "chip-active" : ""}`}
            onClick={() => setSeedMode("custom")}
          >
            ✏️ 指定
          </button>
        </div>

        {seedMode === "random" ? (
          <>
            <p className="text-[13px] text-muted m-0 mb-1">每局自动生成随机种子，正常结算传承、最佳、飞升与成就。</p>
            <p className="font-mono text-[11px] text-dim m-0 mb-4">无需感知当前种子——想复现或挑战某段生涯时再切到「指定」。</p>
            <div className="field-list">
              <button className="field-row" onClick={() => { shareChallenge(); closePicker(); }}>
                <span className="fr-val">
                  挑战好友
                  <span className="fr-hint">带上完整配置的战帖，对方点开就是同一段生涯</span>
                </span>
                <span className="fr-go"><IconChevron dir="right" /></span>
              </button>
              <button className="field-row" onClick={() => { shareLink(); closePicker(); }}>
                <span className="fr-val">
                  分享链接
                  <span className="fr-hint">只发链接，对方打开直接开踢</span>
                </span>
                <span className="fr-go"><IconChevron dir="right" /></span>
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[13px] text-warn bg-warn/10 border border-warn/30 rounded-md px-3 py-2 m-0 mb-3">
              ⚠️ 指定种子不结算任何奖励（传承 / 最佳 / 飞升 / 成就），仅供复盘与分享。
            </p>
            <div className="flex gap-2.5 items-center">
              <input
                value={seed}
                aria-label="种子"
                onChange={(e) => setSeed(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12))}
                className="flex-1 min-w-0 bg-surface-2 border border-line rounded-md px-3 py-2.5 text-accent font-mono text-[15px] outline-none focus:border-accent"
              />
              <button className="btn-sm shrink-0" onClick={() => setSeed(newSeed())}>随机</button>
            </div>
            <p className="font-mono text-[11px] text-dim mt-2 mb-4">同一种子 + 同一选择 = 完全相同的生涯。可分享、可复盘。</p>
            <div className="field-list">
              <button className="field-row" onClick={() => setSeed(todaysSeed)}>
                <span className="fr-val">
                  今日种子 <span className="font-mono text-accent">{todaysSeed}</span>
                  <span className="fr-hint">每天同一颗种子，可与好友比拼同一生涯</span>
                </span>
                <span className="fr-go"><IconChevron dir="right" /></span>
              </button>
              <button className="field-row" onClick={() => { shareChallenge(); closePicker(); }}>
                <span className="fr-val">
                  挑战好友
                  <span className="fr-hint">带上完整配置的战帖，对方点开就是同一段生涯</span>
                </span>
                <span className="fr-go"><IconChevron dir="right" /></span>
              </button>
              <button className="field-row" onClick={() => { shareLink(); closePicker(); }}>
                <span className="fr-val">
                  分享链接
                  <span className="fr-hint">只发链接，对方打开直接开踢</span>
                </span>
                <span className="fr-go"><IconChevron dir="right" /></span>
              </button>
              <button className="field-row" onClick={() => { copySeed(); closePicker(); }}>
                <span className="fr-val">
                  复制种子
                  <span className="fr-hint">把 {seed} 复制到剪贴板</span>
                </span>
                <span className="fr-go"><IconChevron dir="right" /></span>
              </button>
            </div>
          </>
        )}
      </Sheet>
    </div>
  );
}

/**
 * The secondary band — one line per side mode, each a door to the sheet plane.
 *
 * 今日挑战, 传奇剧本 and the record archive all used to be full-width cards of
 * the same weight as the debut console, stacked above it, so the primary act
 * sat seventh on the page. They are things you choose *instead of* configuring
 * a debut, not things you read on the way to one — a labelled row states what
 * each offers and opens it over the page.
 */
function ModeBand({ dailyLegacy, streak, hasRecords, runs, bestRun, purist, sound, rankOf, onOpen }: {
  dailyLegacy?: number; streak: number; hasRecords: boolean;
  runs: number; bestRun: number; purist: boolean; sound: boolean;
  rankOf: (s: number) => { name: string; color: string };
  onOpen: (s: "daily" | "drafts" | "records" | "prefs") => void;
}) {
  return (
    <section>
      <SectionTitle>更多玩法</SectionTitle>
      <div className="mode-list">
        <button className="mode-row" onClick={() => onOpen("daily")}>
          <span className="mr-ico"><IconMode name="daily" /></span>
          <span className="mr-body">
            <span className="mr-title">今日挑战</span>
            <span className="mr-meta">
              全员同条件
              {dailyLegacy !== undefined
                ? <> · 今日 <b style={{ color: rankOf(dailyLegacy).color }}>{dailyLegacy}</b> 分</>
                : " · 今日未挑战"}
            </span>
          </span>
          {streak > 0 && <span className="mr-tag">🔥 {streak} 天</span>}
          <span className="mr-go"><IconChevron dir="right" /></span>
        </button>

        <button className="mode-row" onClick={() => onOpen("drafts")}>
          <span className="mr-ico"><IconMode name="drafts" /></span>
          <span className="mr-body">
            <span className="mr-title">传奇剧本</span>
            <span className="mr-meta">{LEGEND_DRAFTS.length} 个预设起点，一键开踢</span>
          </span>
          <span className="mr-go"><IconChevron dir="right" /></span>
        </button>

        {hasRecords && (
          <button className="mode-row" onClick={() => onOpen("records")}>
            <span className="mr-ico"><IconMode name="records" /></span>
            <span className="mr-body">
              <span className="mr-title">战绩档案</span>
              <span className="mr-meta">
                {runs} 段生涯
                {bestRun > 0 && <> · 最佳 <b style={{ color: rankOf(bestRun).color }}>{bestRun}</b> {rankOf(bestRun).name}</>}
              </span>
            </span>
            <span className="mr-go"><IconChevron dir="right" /></span>
          </button>
        )}

        <button className="mode-row" onClick={() => onOpen("prefs")}>
          <span className="mr-ico"><IconMode name="prefs" /></span>
          <span className="mr-body">
            <span className="mr-title">偏好</span>
            <span className="mr-meta">盲选 {purist ? "开" : "关"} · 音效 {sound ? "开" : "关"}</span>
          </span>
          <span className="mr-go"><IconChevron dir="right" /></span>
        </button>
      </div>
    </section>
  );
}

/** The next unlock, as a progress line rather than a card. Measured against
    `totalLegacyAllTime` — the same figure `isUnlocked` gates on — so spending
    legacy in the blessing shop no longer appears to move the goalpost. */
function UnlockLine({ meta }: { meta: ReturnType<typeof useGameStore>["meta"] }) {
  const pending = UNLOCKS
    .filter((u) => !isUnlocked(meta, u.id))
    .sort((a, b) => a.reqLegacy - b.reqLegacy);
  const next = pending[0];
  if (!next) return null;
  const earned = meta.totalLegacyAllTime;
  const need = Math.max(0, next.reqLegacy - earned);
  // Measure the bar from the previous threshold so the last stretch reads as
  // progress rather than as a sliver that never moves.
  const prevReq = UNLOCKS
    .filter((u) => u.reqLegacy < next.reqLegacy)
    .reduce((m, u) => Math.max(m, u.reqLegacy), 0);
  const span = Math.max(1, next.reqLegacy - prevReq);
  const pct = Math.min(100, Math.max(0, ((earned - prevReq) / span) * 100));
  return (
    // The running total used to sit on a fourth line of its own; it rides the
    // bar instead, so the whole progress statement is three lines.
    <div className="card-quiet unlock-line">
      <div className="flex items-baseline justify-between gap-3">
        <p className="m-0 text-sm"><span className="text-gold font-semibold">下一个解锁</span> · <b>{next.name}</b></p>
        <p className="m-0 font-mono text-[13px] text-accent shrink-0">还需 {need}</p>
      </div>
      <p className="m-0 mt-0.5 text-[13px] text-muted-hi">{next.desc}</p>
      <div className="flex items-center gap-2.5 mt-2">
        <div className="career-bar flex-1" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${next.name} 解锁进度`}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="font-mono text-[10.5px] text-dim shrink-0 tabular-nums">{earned} / {next.reqLegacy}</span>
      </div>
    </div>
  );
}

/** P4: the daily challenge — same seed + setup for everyone today. It lives on
 *  the sheet plane now: a side mode you pick instead of configuring a debut,
 *  not a card you scroll past on the way to one. */
function DailySheet({ open, onClose, date, seed, setup, todaysResult, streak, onStart, rankOf }: {
  open: boolean; onClose: () => void; date: string;
  seed: string; setup: { position: string; nationalityId: string; leagueId: string };
  todaysResult?: DailyResult; streak: number; onStart: () => void;
  rankOf: (s: number) => { name: string; color: string };
}) {
  const leagueName = LEAGUES.find((l) => l.id === setup.leagueId)?.name ?? "?";
  const natName = NATIONS.find((n) => n.id === setup.nationalityId)?.name ?? "?";
  // P-A171: share today's daily challenge — the daily viral hook. A completed
  // challenge generates a "我今日传承分X，你能超越吗？" card with the full setup
  // link, so a viewer opens the identical daily career. Highest-DAU lever: a
  // fresh reason to share + play EVERY day.
  // The link carries the DATE. Without it, a card posted today and tapped
  // tomorrow started a stale seed that could never be recorded as a daily —
  // no streak, no board — which is the common case for a link on a feed.
  const shareDaily = () => {
    const url = careerUrl({
      seed, nationalityId: setup.nationalityId, position: setup.position as Position,
      leagueId: setup.leagueId, pace: "normal", dailyDate: date,
    });
    const head = `⚽ 绿茵轮回 · 今日挑战\n${natName} ${POS_LABEL[setup.position] ?? setup.position} · ${leagueName}`;
    const text = todaysResult
      ? `${head}\n我的传承分 ${todaysResult.legacy}（${rankOf(todaysResult.legacy).name}）· 巅峰OVR${todaysResult.maxOverall} · ${todaysResult.seasons}赛季${todaysResult.trophies ? ` · ${todaysResult.trophies}奖杯` : ""}\n${SHARE_CTA}\n${DAILY_TAGS}`
      : `${head}\n种子 ${seed} · 全员同设定\n来比拼同一生涯！\n${DAILY_TAGS}`;
    shareText(text, url);
  };
  return (
    <Sheet
      open={open} onClose={onClose} title="今日挑战"
      sub={`${date} · 全员同条件`}
      footer={
        <div className="flex gap-2.5">
          <button className="btn-primary flex-1 py-3" onClick={onStart}>{todaysResult ? "再战今日 ↻" : "开始今日挑战 →"}</button>
          <button className="btn" onClick={shareDaily}>分享</button>
        </div>
      }
    >
      <div className="field-list">
        <div className="field-row cursor-default">
          <span className="fr-lbl">今日阵容</span>
          <span className="fr-val">{flagEmoji(setup.nationalityId)} {natName} {POS_LABEL[setup.position] ?? setup.position} · {leagueName}</span>
        </div>
        <div className="field-row cursor-default">
          <span className="fr-lbl">种子</span>
          <span className="fr-val font-mono text-accent">{seed}</span>
        </div>
        {streak > 0 && (
          <div className="field-row cursor-default">
            <span className="fr-lbl">连胜</span>
            <span className="fr-val text-gold">🔥 连续 {streak} 天</span>
          </div>
        )}
      </div>

      {todaysResult && (
        <div className="mt-4">
          <StatStrip items={[
            { label: "今日传承", value: <span style={{ color: rankOf(todaysResult.legacy).color }}>{todaysResult.legacy}</span> },
            { label: "评级", value: <span className="text-[20px]" style={{ color: rankOf(todaysResult.legacy).color }}>{rankOf(todaysResult.legacy).name}</span> },
            { label: "巅峰", value: todaysResult.maxOverall },
            { label: "赛季", value: todaysResult.seasons },
          ]} />
        </div>
      )}

      <p className="font-mono text-[11px] text-dim mt-4 mb-0">同种子 + 同选择 = 同生涯。把你的传承分发给好友比拼。</p>
    </Sheet>
  );
}

/** P8: legend drafts — scripted starting scenarios, each a fixed seed + preset
 *  setup representing a dramatic arc (galáctico youth, relegation fight, late
 *  bloomer...). The sheet scrolls, so all of them show without an expand toggle. */
function DraftSheet({ open, onClose, onStart }: {
  open: boolean; onClose: () => void; onStart: (d: LegendDraft) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} tall title="传奇剧本" sub={`${LEGEND_DRAFTS.length} 个预设起点 · 固定种子，每个都是一段不同的传奇`}>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
        {LEGEND_DRAFTS.map((d) => {
          const leagueName = LEAGUES.find((l) => l.id === d.leagueId)?.name ?? "?";
          return (
            <button key={d.id} onClick={() => onStart(d)} className="draft-card">
              <span className="flex items-center gap-2">
                <span className="text-lg" aria-hidden="true">{d.icon}</span>
                <strong className="text-sm">{d.name}</strong>
              </span>
              <span className="block text-[11.5px] text-muted mt-1.5 leading-snug">{d.desc}</span>
              <span className="block font-mono text-[10px] text-dim mt-2">{flagEmoji(d.nationalityId)} {d.position} · {leagueName} · {d.pace === "long" ? "沉浸" : d.pace === "express" ? "速通" : "标准"}</span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

/** Everything retrospective in one place: lifetime totals, the daily-challenge
 *  record, and the local career archive. Three separate cards used to sit at the
 *  bottom of the play tab saying versions of the same thing. */
function RecordSheet({ open, onClose, meta, daily, archive, clearArchive, rankOf }: {
  open: boolean; onClose: () => void;
  meta: ReturnType<typeof useGameStore>["meta"];
  daily: readonly DailyResult[];
  archive: ReturnType<typeof useGameStore>["archive"];
  clearArchive: () => void;
  rankOf: (s: number) => { name: string; color: string };
}) {
  const bestLegacy = daily.length > 0 ? Math.max(...daily.map((d) => d.legacy)) : 0;
  const avgLegacy = daily.length > 0 ? Math.round(daily.reduce((s, d) => s + d.legacy, 0) / daily.length) : 0;
  return (
    <Sheet open={open} onClose={onClose} tall title="战绩档案" sub={`${meta.runs} 段生涯 · 累计 ${meta.totalLegacyAllTime} 传承`}>
      <StatStrip items={[
        { label: "累计轮回", value: meta.runs },
        { label: "可用传承", value: meta.totalLegacy },
        { label: "最佳单局", value: meta.bestRun },
        { label: "最佳评级", value: <span className="text-[20px]" style={{ color: rankOf(meta.bestRun).color }}>{rankOf(meta.bestRun).name}</span> },
      ]} />

      {daily.length > 0 && (
        <div className="mt-5">
          <SectionTitle>每日战绩 · {daily.length} 天</SectionTitle>
          <div className="flex gap-2.5 mb-3 font-mono text-[11px] text-dim">
            <span>最佳 <b className="text-gold text-[13px]">{bestLegacy}</b></span>
            <span>平均 <b className="text-accent text-[13px]">{avgLegacy}</b></span>
          </div>
          <div className="record-list">
            {daily.slice(0, 12).map((d) => (
              <div key={d.date} className="record-row">
                <span className="font-mono text-[11px] text-dim">{d.date}</span>
                <span className="font-mono text-[11px] text-muted truncate">{d.seasons}赛季 · 巅峰 {d.maxOverall} · {d.trophies}奖杯</span>
                <span className="font-mono text-xs" style={{ color: rankOf(d.legacy).color }}>{d.rank}</span>
                <span className="font-mono text-sm font-bold text-accent">{d.legacy}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {archive.length > 0 && (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <SectionTitle>生涯档案 · {archive.length} 段</SectionTitle>
            <button className="btn-sm" onClick={() => { if (confirm("清空后这些记录找不回来了，确定？")) clearArchive(); }}>清空</button>
          </div>
          <div className="record-list">
            {archive.slice(0, 12).map((a, i) => (
              <div key={i} className="record-row">
                <span className="truncate">{a.name}</span>
                <span className="font-mono text-[11px] text-muted truncate">{a.position} · {nationName(a.nationalityId)} · {a.seasons}赛季 · 巅峰 {a.maxOverall}</span>
                <span className="font-mono text-xs" style={{ color: rankOf(a.legacy).color }}>{a.rank}</span>
                <span className="font-mono text-sm font-bold text-accent">{a.legacy}</span>
              </div>
            ))}
          </div>
          <p className="font-mono text-[11px] text-dim mt-2.5 mb-0">档案只存在这台设备的浏览器里。种子 {archive[0]!.seed} 可复现任意一局。</p>
        </div>
      )}

      {daily.length === 0 && archive.length === 0 && (
        <p className="text-sm text-muted mt-4 mb-0">还没有完成的生涯。踢完第一局，这里会记下巅峰、奖杯和传承分。</p>
      )}
    </Sheet>
  );
}

/** Two switches that shape how a run feels but are set once and forgotten.
 *  They used to occupy a quarter of the setup card above the start button. */
function PrefsSheet({ open, onClose, purist, sound, onTogglePurist, onToggleSound }: {
  open: boolean; onClose: () => void;
  purist: boolean; sound: boolean;
  onTogglePurist: () => void; onToggleSound: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="偏好" sub="设一次就好，之后每一局都按这个来">
      <div className="field-list">
        <button className="field-row" role="switch" aria-checked={purist} onClick={onTogglePurist}>
          <span className="fr-val">
            盲选模式
            <span className="fr-hint">隐藏每个选项的成功概率，全凭直觉下注</span>
          </span>
          <span className={`switch ${purist ? "switch-on" : ""}`} aria-hidden="true"><i /></span>
        </button>
        <button className="field-row" role="switch" aria-checked={sound} onClick={onToggleSound}>
          <span className="fr-val">
            音效
            <span className="fr-hint">进球、夺冠与结算时的合成音效</span>
          </span>
          <span className={`switch ${sound ? "switch-on" : ""}`} aria-hidden="true"><i /></span>
        </button>
      </div>
    </Sheet>
  );
}

/** Action shown for a blessing gated behind a cumulative-legacy threshold
 *  the player hasn't reached yet. Surfaces the reason (累计传承分 gate) and the
 *  progress toward it — a bare "需解锁" pill hides why you can't buy. */
function LockedBlessingAction({ req, earned, name }: { req: number; earned: number; name: string }) {
  const need = Math.max(0, req - earned);
  const pct = req > 0 ? Math.min(100, Math.max(0, (earned / req) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="pill opacity-60">需解锁</span>
        <span className="font-mono text-[10.5px] text-dim shrink-0">还需 {need} 传承</span>
      </div>
      <div className="career-bar mt-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${name} 解锁进度`}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <p className="m-0 mt-1.5 font-mono text-[10.5px] text-dim">累计 {earned} / {req} 传承</p>
    </div>
  );
}

function BlessingShop({ meta, buyBlessing, setLoadout }: { meta: ReturnType<typeof useGameStore>["meta"]; buyBlessing: (id: string) => void; setLoadout: (ids: readonly string[]) => void }) {
  // Mechanics review: blessings are a loadout (≤ MAX_LOADOUT per run), not a
  // passive always-on stack — 玻璃大炮/雇佣兵 are a build choice, not a debt.
  const equipped = resolveLoadout(meta);
  const toggle = (id: string) => {
    if (equipped.includes(id)) setLoadout(equipped.filter((x) => x !== id));
    else if (equipped.length < MAX_LOADOUT) setLoadout([...equipped, id]);
  };
  return (
    <div className="card">
      <p className="text-sm text-muted m-0 mb-3.5">用传承点购买祝福，出发前选择装备的组合——每局最多 {MAX_LOADOUT} 个生效。已拥有 {meta.ownedBlessings.length}/{BLESSINGS.length} · 已装备 {equipped.length}/{MAX_LOADOUT}。</p>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
        {BLESSINGS.map((b) => {
          const owned = meta.ownedBlessings.includes(b.id);
          const isEquipped = equipped.includes(b.id);
          const slotsFull = equipped.length >= MAX_LOADOUT;
          const affordable = meta.totalLegacy >= b.cost;
          const unlocked = isUnlocked(meta, `blessing:${b.id}`);
          return (
            <div key={b.id} className={`bg-surface-2 border rounded-md p-3.5 ${isEquipped ? "border-accent" : "border-line"}`}>
              <div className="flex justify-between items-baseline">
                <strong>{b.name}</strong>
                <span className="pill pill-accent">{b.cost}</span>
              </div>
              <p className="text-sm text-muted m-0 mt-1.5 mb-2.5 min-h-8">{b.desc}</p>
              {owned
                ? <button className={`btn-sm ${isEquipped ? "btn-primary" : ""}`} disabled={!isEquipped && slotsFull} onClick={() => toggle(b.id)}>
                    {isEquipped ? "已装备 ✓" : slotsFull ? "栏位已满" : "装备"}
                  </button>
                : !unlocked ? <LockedBlessingAction req={UNLOCKS.find((u) => u.id === `blessing:${b.id}`)?.reqLegacy ?? 0} earned={meta.totalLegacyAllTime} name={b.name} />
                : <button className="btn-sm btn-primary" disabled={!affordable} onClick={() => buyBlessing(b.id)}>{affordable ? "购买" : "传承不足"}</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AscensionPicker({ meta, setAscension }: { meta: ReturnType<typeof useGameStore>["meta"]; setAscension: (n: number) => void }) {
  const maxUnlocked = maxAscensionUnlocked(meta);
  return (
    <div className="card">
      <p className="text-sm text-muted m-0 mb-3.5">飞升提升难度但增加传承分倍率（+15%/级）。需以足够高的单局传承分解锁下一级——赢了才能往上爬。</p>
      <div className="flex flex-col gap-2">
        <button className={`chip text-left ${meta.ascension === 0 ? "chip-active" : ""}`} onClick={() => setAscension(0)}>
          <strong>飞升 0 — 常规</strong><span className="block text-[10px] text-dim mt-0.5">无修正</span>
        </button>
        {ASCENSIONS.map((a) => {
          const unlocked = a.level <= maxUnlocked;
          const req = ASCENSION_UNLOCK_REQ[a.level] ?? 0;
          return (
            <button
              key={a.level}
              disabled={!unlocked}
              className={`chip text-left ${meta.ascension === a.level ? "chip-active" : ""} ${!unlocked ? "opacity-40 cursor-not-allowed" : ""}`}
              onClick={() => unlocked && setAscension(a.level)}
            >
              <strong>飞升 {a.level} — {a.name}{a.level >= 8 && <span className="rarity-badge legendary ml-2">规则</span>}</strong>
              <span className="block text-[10px] text-dim mt-0.5">{a.desc}</span>
              {!unlocked && <span className="block text-[10px] text-warn mt-0.5">需最佳单局 ≥ {req} 解锁（当前 {meta.bestRun}）</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────────── prestige (P1: infinite meta loop) ─────────────────────────────

/** The prestige screen — the "reset for permanent power" loop that gives a
 *  bought-out player a reason to start another run. Pick 1 of 3 perks by
 *  sacrificing all blessings + spendable legacy. Perks never expire and stack. */
function PrestigeScreen({ meta, prestige }: { meta: ReturnType<typeof useGameStore>["meta"]; prestige: (perkId: string) => void }) {
  const eligible = prestigeEligible(meta);
  const owned = meta.permPerks;
  const allOwned = owned.length >= PRESTIGE_PERKS.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="card">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <SectionTitle>轮回 · 永久传承</SectionTitle>
            <p className="text-sm text-muted m-0 max-w-[52ch]">
              拥有全部祝福后，可献祭一切（祝福 + 传承）换取一个<b className="text-gold">永久特权</b>。
              永不丢失，跨所有未来生涯叠加。轮回次数越多，下一段旅程越强——这是无终点之路。
            </p>
          </div>
          <div className="text-right">
            <div className="font-mono text-xl text-gold m-0">{meta.prestige}</div>
            <p className="font-mono text-[11px] text-dim m-0">已轮回</p>
          </div>
        </div>
        <div className="stat-strip mt-3.5">
          <div><div className="lbl">已得特权</div><div className="val">{owned.length}/{PRESTIGE_PERKS.length}</div></div>
          <div><div className="lbl">现有传承</div><div className="val text-accent">{meta.totalLegacy}</div></div>
          <div><div className="lbl">需传承</div><div className="val">{PRESTIGE_LEGACY_THRESHOLD}</div></div>
          <div><div className="lbl">已集祝福</div><div className="val">{meta.ownedBlessings.length}/{BLESSINGS.length}</div></div>
        </div>
      </div>

      {owned.length > 0 && (
        <div className="card">
          <SectionTitle>已获永久特权</SectionTitle>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            {owned.map((id) => {
              const p = PRESTIGE_PERKS.find((x) => x.id === id)!;
              return (
                <div key={id} className="bg-gold/8 border border-gold/30 rounded-md p-3">
                  <strong className="text-gold">{p.name}</strong>
                  <p className="text-sm text-muted m-0 mt-1">{p.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {allOwned ? (
        <div className="card text-center py-6">
          <p className="text-lg m-0 text-gold">🏆 全部 {PRESTIGE_PERKS.length} 项永久特权已集齐</p>
          <p className="text-sm text-muted m-0 mt-2">你已走完轮回之路的尽头。可继续在更高飞升难度中追求更高单局传承。</p>
        </div>
      ) : eligible ? (
        <div className="card">
          <SectionTitle>本次可选 · 三选一</SectionTitle>
          <p className="font-mono text-[11px] text-warn m-0 mb-3">献祭后祝福清零、传承归零，但解锁永不回退。三选一后立即生效。</p>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            {prestigeChoices(meta).map((p) => (
              <div key={p.id} className="bg-surface-2 border border-line rounded-md p-3.5 flex flex-col">
                <strong className="text-accent">{p.name}</strong>
                <p className="text-sm text-muted m-0 mt-1.5 mb-3 min-h-8 flex-1">{p.desc}</p>
                <button className="btn-sm btn-primary" onClick={() => { if (confirm(`献祭全部祝福与 ${meta.totalLegacy} 传承，换取「${p.name}」？此操作不可撤销。`)) prestige(p.id); }}>轮回获取</button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="card text-center py-6">
          <p className="text-sm m-0 text-muted">未达轮回条件</p>
          <p className="font-mono text-[11px] text-dim m-0 mt-2">
            需拥有全部 {BLESSINGS.length} 个祝福，且传承 ≥ {PRESTIGE_LEGACY_THRESHOLD}。
          </p>
          <p className="font-mono text-[11px] text-dim m-0 mt-1">
            当前：祝福 {meta.ownedBlessings.length}/{BLESSINGS.length} · 传承 {meta.totalLegacy}/{PRESTIGE_LEGACY_THRESHOLD}
          </p>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── hall of fame (P6) ─────────────────────────────

/** The completionist museum — every trophy type & achievement ever earned,
 *  with grayed-out placeholders for the uncollected. The "gotta catch 'em all"
 *  pull that gives a reason to start runs targeting specific gaps. */
function HallOfFame({ meta }: { meta: ReturnType<typeof useGameStore>["meta"] }) {
  const ownedTrophies = new Set(meta.trophyCollection);
  const ownedAchievements = new Set(meta.achievementCollection);
  const trophyProgress = ALL_TROPHY_IDS.filter((t) => ownedTrophies.has(t)).length;
  const achProgress = ACHIEVEMENTS.filter((a) => ownedAchievements.has(a.id)).length;
  return (
    <div className="flex flex-col gap-3">
      <div className="card">
        <SectionTitle>🏆 荣誉殿堂</SectionTitle>
        <p className="text-sm text-muted m-0 mb-3.5 max-w-[52ch]">跨越所有生涯收集的奖杯与成就。灰色为未获得——下一次轮回去补齐它。</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-surface-2 border border-line rounded-md p-3 text-center">
            <div className="font-mono text-xl text-gold">{trophyProgress}/{ALL_TROPHY_IDS.length}</div>
            <p className="font-mono text-[11px] text-dim m-0 mt-1">奖杯种类</p>
          </div>
          <div className="bg-surface-2 border border-line rounded-md p-3 text-center">
            <div className="font-mono text-xl text-accent">{achProgress}/{ACHIEVEMENTS.length}</div>
            <p className="font-mono text-[11px] text-dim m-0 mt-1">成就解锁</p>
          </div>
        </div>
      </div>

      <div className="card">
        <SectionTitle>奖杯收藏</SectionTitle>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}>
          {ALL_TROPHY_IDS.map((t) => {
            const owned = ownedTrophies.has(t as Trophy);
            return (
              <div key={t} className={`rounded-md p-2.5 border text-center ${owned ? "bg-gold/10 border-gold/30" : "bg-surface-2 border-line opacity-40"}`}>
                <div className={`text-base ${owned ? "" : "grayscale"}`}>{owned ? "🏅" : "🔒"}</div>
                <div className={`text-xs font-semibold mt-1 ${owned ? "text-gold" : "text-dim"}`}>{TROPHY_LABEL[t as Trophy]}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <SectionTitle>成就墙</SectionTitle>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
          {ACHIEVEMENTS.map((a) => {
            const owned = ownedAchievements.has(a.id);
            return (
              <div key={a.id} className={`rounded-md p-3 border ${owned ? "bg-accent/8 border-accent/30" : "bg-surface-2 border-line opacity-50"}`}>
                <div className="flex items-center gap-2">
                  <span>{owned ? "✅" : "🔒"}</span>
                  <strong className={owned ? "text-accent" : "text-dim"}>{a.name}</strong>
                </div>
                <p className="text-sm text-muted m-0 mt-1.5">{a.desc}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── play screen ─────────────────────────────

/** The play shell's fixed header — the player card's successor. A compact
    identity bar carries everything the FUT card used to (foil OVR, flag, name,
    #num, position·role·dev, persona chips, club + league) plus the two career
    exits (放弃/挂靴) the card used to hide behind a sheet. One foil OVR badge
    anchors the mud→marble arc (the game dynamism); the bar is rim-lit by OVR
    tier. The meta line below holds the live signals (horizon, market value,
    league-title odds, streak, challenge, 飞升, 传承, seed), and the resident
    生涯计分 strip stays the 传承-input scorecard. */
function PlayTopBar({ game, onAbort, onRetire, revealCount }: { game: GameState; onAbort: () => void; onRetire: () => void; revealCount: number }) {
  const p = game.player!;
  const periodLength = game.periodLength ?? 2;
  // 显示态跟着已揭示季走，不剧透本 period 未揭示的季。revealCount=0 取上个
  // period 末季（开局无则首季 = 初始 16 岁 OVR）；揭示后取最后揭示季。
  const revealedCount = Math.max(0, game.seasons.length - periodLength + revealCount);
  const ds = displaySeasonOf(game, revealCount, periodLength);
  const clubObj = clubById(game.currentClubId);
  const club = clubObj.name;
  const league = leagueById(clubObj.leagueId);
  const age = ds.age;
  const ovr = ds.overall;
  // P-RETIRE: the live horizon — projected retire age from the REVEALED state
  // so it doesn't spoil this period's unrevealed seasons. Warm when the end
  // is near so the horizon is felt without implying linear progress-to-age.
  const horizon = projectedRetireAge({ ...p, age, overall: ovr }, clubObj, game.statusTags ?? [], game.severeInjuries ?? 0, game.blessings ?? [], game.permPerks ?? []);
  const horizonEnd = Math.max(age + 1, horizon);
  const horizonNear = horizonEnd - age <= 2;
  const streak = game.trophyStreak ?? 0;
  const mv = revealedCount > 0 ? (ds.marketValue ?? 0) : 0;
  const prevDs = revealedCount > 1 ? game.seasons[revealedCount - 2] : undefined;
  const mvDelta = revealedCount > 0 && prevDs ? Math.round((mv - (prevDs.marketValue ?? 0)) * 10) / 10 : 0;
  const seasonNum = revealedCount;
  const traits = personaTags(game.statusTags);
  const titleOdds = leagueTitleOdds(game, ovr);
  return (
    <header className="play-top">
      <div className="play-top-inner">
        {/* 顶栏面板 —— 一块按 OVR 档位描边的整板，内部四条等宽横带用发丝线分隔，
            每条一个语义、一种版式，全部同一左基线（计分板除外，它是刻意的等分表）：
              ① 身份：foil 能力徽章 + 姓名/号码 + 国籍·位置·定位·成长型 + 右侧生涯出口
              ② 处境：俱乐部·联赛·年龄·赛季·预计退役 —— 一行平铺的「我在哪儿」
              ③ 信号：身价/夺冠率/连冠/挑战/飞升/词条/种子 —— 统一 chip 家族，只换色调
              ④ 计分：传承输入五格 + 传承结果格
            旧版三种容器（卡片/裸文字/右靠 chip 轨）混排导致的对不齐与右轨孤行到此为止。 */}
        <div className="ptc" data-tier={ovrTier(ovr)}>
          <div className="ptc-row ptc-id">
            <OvrBadge ovr={ovr} label="能力" size="sm" />
            <div className="pi-id">
              <div className="pi-name">
                <span className="pi-flag">{flagEmoji(p.nationalityId)}</span>
                <span className="pi-name-txt">{p.name}</span>
                <span className="pi-num">#{p.squadNumber}</span>
              </div>
              <div className="pi-sub">
                <span>{nationName(p.nationalityId)}</span><i>·</i>
                <span>{p.position}</span><i>·</i>
                <span>{ROLE_LABEL[ds.role] ?? ds.role}</span><i>·</i>
                <span>{profileName(p.devProfile)}</span>
              </div>
            </div>
            <div className="pi-actions">
              <button className="pi-btn pi-abort" onClick={onAbort} aria-label="放弃本轮回">放弃</button>
              <button className="pi-btn pi-retire" onClick={onRetire} aria-label="挂靴退役">挂靴</button>
            </div>
          </div>

          <div className="ptc-row ptc-where">
            <span className="pi-club">
              <Crest path={clubCrestPath(clubObj.id)} alt={club} size={15} imgClass="pi-crest" fallback={<span className="pi-crest-mono">{club.slice(0, 1)}</span>} />
              <span className="pi-club-name">{club}</span>
              <i>·</i>
              <span className="pi-league">{league.name}</span>
            </span>
            <i className="pi-sep">·</i>
            <span className="pi-clock">{age} 岁{seasonNum > 0 ? ` · 第 ${seasonNum} 赛季` : " · 出道在即"}</span>
            <i className="pi-sep">·</i>
            <span className={`pi-horizon ${horizonNear ? "is-near" : ""}`}>预计 {horizonEnd} 岁</span>
          </div>

          {/* 信号带 —— 此局戏剧 + 生涯词条共用一个 chip 家族（同高同圆角同字号，
              只有色调不同），左流排布，永不出现右靠孤行。全空时整带不渲染。 */}
          {(mv > 0 || titleOdds !== null || streak >= 2 || game.challenge || game.ascension > 0 || traits.length > 0 || game.customSeed) && (
            <div className="ptc-row ptc-chips" aria-label="当前信号与生涯词条">
              {mv > 0 && (
                <span className="ptc-chip trait-legendary" title="市场身价">
                  <b className="pc-lbl">身价</b>€{fmtMv(mv)}
                  {mvDelta !== 0 && <span className={`pc-delta ${mvDelta > 0 ? "up" : "down"}`}>{mvDelta > 0 ? "↑" : "↓"}</span>}
                </span>
              )}
              {titleOdds !== null && (
                <span className={`ptc-chip ${traitToneOfOdds(titleOdds)}`} title="本季联赛夺冠概率">
                  <b className="pc-lbl">夺冠</b>{Math.round(titleOdds * 1000) / 10}%
                </span>
              )}
              {streak >= 2 && <span className="ptc-chip trait-legendary" title="连冠势头"><b className="pc-lbl">连冠</b>{streak}</span>}
              {game.challenge && <span className="ptc-chip trait-warn" title="挑战目标"><b className="pc-lbl">挑战</b>{game.challenge.label} ×{game.challenge.legacyMult.toFixed(1)}</span>}
              {game.ascension > 0 && <span className="ptc-chip trait-purple" title="飞升难度"><b className="pc-lbl">飞升</b>{game.ascension}</span>}
              {traits.map((t) => <span key={t.label} className={`ptc-chip ${TRAIT_TONE_CLASS[t.tone]}`}>{t.label}</span>)}
              {game.customSeed && <span className="ptc-chip trait-muted" title="本局种子"><b className="pc-lbl">种子</b>{game.seed}</span>}
            </div>
          )}

          <CareerScoreStrip game={game} />
        </div>
      </div>
    </header>
  );
}

/** 夺冠概率 → chip 色调，沿用全局档位心智（≥70% 好 / 40-69% 警 / <40% 危）。 */
function traitToneOfOdds(p: number) {
  return p >= 0.7 ? "trait-good" : p >= 0.4 ? "trait-warn" : "trait-danger";
}

/** 生涯计分板 — the resident career scoreboard: the 传承 INPUTS (巅峰/赛季/
 *  奖杯/荣誉/总薪) live during play as label-over-number cells, with 传承 itself
 *  docked as the gold hero output cell on the right (the result the inputs feed).
 *  One place tells the whole 传承 story — inputs → 传承 — instead of scattering
 *  the total in the meta line and the inputs in a separate strip. Distinct from
 *  the per-season ledger rating below; mirrors the summary's career vocabulary
 *  (巅峰OVR/奖杯/个人荣誉/生涯总薪) so the criteria read the same at career end. */
function CareerScoreStrip({ game }: { game: GameState }) {
  const peak = game.maxOverall;
  const seasons = game.seasons.length;
  const trophies = game.trophies.length;
  const awards = game.awards.length;
  const totalWage = game.seasons.reduce((s, x) => s + (x.wage ?? 0), 0);
  return (
    <div className="ptc-row career-score" aria-label="生涯计分构成">
      <span className="cs-cell"><b className="cs-lbl">巅峰</b><span className={`cs-val ${ovrTierClass(peak)}`}>{peak}</span></span>
      <span className="cs-cell"><b className="cs-lbl">赛季</b><span className="cs-val">{seasons}</span></span>
      <span className="cs-cell"><b className="cs-lbl">奖杯</b><span className={`cs-val ${trophies > 0 ? (hasGoldTrophy(game.trophies) ? "tier-gold" : "tier-good") : "tier-dim"}`}>{trophies}</span></span>
      <span className="cs-cell"><b className="cs-lbl">荣誉</b><span className={`cs-val ${awards > 0 ? "tier-gold" : "tier-dim"}`}>{awards}</span></span>
      <span className="cs-cell"><b className="cs-lbl">总薪</b><span className={`cs-val ${totalWage > 0 ? "tier-gold" : "tier-dim"}`}>€{fmtCareerWage(game.seasons)}</span></span>
      <span className="cs-cell cs-legacy" title="当前传承"><b className="cs-lbl">传承</b><span className="cs-val is-legacy">{game.legacy}</span></span>
    </div>
  );
}

/** 生涯账本的赛季荣誉架 — a season's decorated haul, restyled from a flat
 *  monospace chip log into a trophy shelf. Three honor kinds read as three
 *  distinct objects so a fan sorts a season's glory by weight at a glance:
 *  · team/national trophies → an icon-led, prestige-rimmed slot (the cup is
 *    the hero; gold majors glow, domestic silverware is quieter; national
 *    wins carry the country flag so "won with 国家队" reads apart from club)
 *  · personal awards (金球/金靴/金手套) → a pill-shaped medal (Ballon d'Or =
 *    gold, the crown jewel; boot/glove = steel) — a different shape from the
 *    trophy slot, the way career sims separate team silverware from personal
 *    glory
 *  · league citations (MVP/最佳11人) → a hairline-only chip, no fill, so it
 *    never competes with the trophies and medals beside it
 *  Sorted by prestige so the crown jewels lead (世界杯 → 金球 → other majors →
 *  domestic → 金靴/金手套 → MVP → 最佳11人). Also fixes a latent double-render:
 *  national trophies used to draw twice (once via s.trophies, once via
 *  s.nationalTournaments) — national honors now draw only from the dedicated
 *  nationalTournaments source. */
function LedgerHaul({ s, natId }: { s: GameState["seasons"][number]; natId?: string }) {
  const conf = confederationOfLeague(s.leagueId);
  const natConf = natConfOf(natId);
  type Item =
    | { rank: number; kind: "trophy"; key: string; gold: boolean; label: string; img: string | null; flag: string | null }
    | { rank: number; kind: "medal"; key: string; medal: "gold" | "steel"; label: string }
    | { rank: number; kind: "cite"; key: string; cite: "gold" | "accent"; star: boolean; label: string };
  const PRESTIGE: Record<Trophy, number> = {
    world_cup: 0, continental_primary: 2, club_world_cup: 2, national_continental: 2,
    continental_secondary: 4, league: 4, cup: 4,
  };
  const items: Item[] = [];
  // club trophies — national ones (world_cup / national_continental) draw from
  // nationalTournaments below, so skip them here to avoid the double-render.
  for (const t of s.trophies) {
    if (t === "world_cup" || t === "national_continental") continue;
    items.push({ rank: PRESTIGE[t], kind: "trophy", key: `t:${t}`, gold: TROPHY_GOLD.includes(t), label: trophyLabel(t, conf), img: trophyPath(t, conf, s.leagueId), flag: null });
  }
  // national trophies — from the dedicated source, with the country flag.
  for (const nt of s.nationalTournaments) {
    const t = nt.trophy;
    const useConf = t === "national_continental" ? (natConf ?? conf) : conf;
    items.push({ rank: PRESTIGE[t], kind: "trophy", key: `n:${t}`, gold: TROPHY_GOLD.includes(t), label: trophyLabel(t, useConf), img: trophyPath(t, useConf, s.leagueId, natConf), flag: natId ? nationFlagPath(natId) : null });
  }
  for (const a of s.awards) {
    items.push({ rank: a === "ballon_dor" ? 1 : 3, kind: "medal", key: `a:${a}`, medal: a === "ballon_dor" ? "gold" : "steel", label: AWARD_LABEL[a] });
  }
  for (const h of (s.seasonHonors ?? [])) {
    items.push({ rank: h === "mvp" ? 5 : 6, kind: "cite", key: `h:${h}`, cite: h === "mvp" ? "gold" : "accent", star: h === "mvp", label: h === "mvp" ? "MVP" : "最佳11人" });
  }
  items.sort((x, y) => x.rank - y.rank);
  return (
    <div className="lg-haul">
      {items.map((it) => {
        if (it.kind === "trophy") {
          return (
            <span key={it.key} className="lg-trophy" data-tier={it.gold ? "gold" : "neutral"}>
              {it.flag && <img className="lg-trophy-flag" src={it.flag} alt="" loading="lazy" decoding="async" />}
              {it.img && <img className="lg-trophy-img" src={it.img} alt="" loading="lazy" decoding="async" />}
              <span className="lg-trophy-label">{it.label}</span>
            </span>
          );
        }
        if (it.kind === "medal") {
          return <span key={it.key} className="lg-medal" data-tier={it.medal}>{it.label}</span>;
        }
        return (
          <span key={it.key} className="lg-cite" data-tier={it.cite}>
            {it.star && <span className="lg-cite-mark">★</span>}{it.label}
          </span>
        );
      })}
    </div>
  );
}
/** 生涯账本 — the content plane's backbone. One row per season (age · club
    monogram · OVR badge on the tier scale · match data), newest-first: the
    in-progress / deciding row pins to the top as a stable anchor, completed
    seasons descend below it (newest → oldest) so the eye never chases a
    receding bottom as the career grows. Each row carries its full season
    haul inline — a dense strip of 奖杯/个人荣誉/国家队/赛季荣誉 — so every
    accolade the season earned is on the page at a glance, no tap-to-expand. */
function CareerLedger({ game, revealCount, periodLength }: { game: GameState; revealCount: number; periodLength: number }) {
  const p = game.player!;
  const isGK = p.position === "GK";
  const cols = isGK ? ["场", "零封", "失球"] : ["场", "球", "助"];
  const choice = game.pendingChoice;
  // 只渲染已揭示的季：前 period 全揭示 + 本 period 揭示到 revealCount，不剧透。
  const revealedCount = Math.max(0, game.seasons.length - periodLength + revealCount);
  const shown = game.seasons.slice(0, revealedCount);
  const revealing = revealCount < periodLength;
  const lastRevealedAge = revealedCount > 0 ? (game.seasons[revealedCount - 1]?.age ?? 15) : 15;
  const currentAge = revealing ? lastRevealedAge + 1 : lastRevealedAge;
  const currentTitle = revealing ? `第 ${revealedCount + 1} 季进行中…` : (choice ? `决策中 · ${choice.title}` : "推进中…");
  // 决策行是「未定态」锚点，能力格留空：选择带的能力调整要到下个 period 才落地
  // （run.ts simulatePeriod 的 upfront/deferred shift），此刻显示的是「选择前」的假
  // 能力；且顶栏 OvrBadge 与下方已揭示季已各显示同一能力，留空避免重复与误导。
  return (
    <div className="ledger">
      <div className="lg-sticky">
        <div className="lg-grid lg-head" aria-hidden="true">
          <span>岁</span><span /><span>球队</span><span className="lg-hc">定位</span><span className="lg-hc">能力</span>
          {cols.map((c) => <span key={c} className="lg-hs">{c}</span>)}
          <span className="lg-hc">评分</span>
        </div>
      </div>
      <div className="lg-grid lg-row-current" data-rarity={revealing ? undefined : choice?.rarity} aria-current="step">
        <span className="lg-age">{currentAge}</span>
        <span className="lg-dot-cell"><span className="lg-dot" /></span>
        <span className="lg-club">
          <span className="lg-current-title">{currentTitle}</span>
        </span>
        <span className="lg-role lg-role-zero">—</span>
        <span className="lg-ovr" data-tier="dim">—</span>
        {cols.map((c) => <span key={c} className="lg-s lg-s-zero">—</span>)}
        <span className="lg-rating" data-tier="dim">—</span>
      </div>
      {[...shown].reverse().map((s, i) => {
        const stats = isGK
          ? [s.stats.appearances, s.stats.cleanSheets, s.stats.goalsConceded]
          : [s.stats.appearances, s.stats.goals, s.stats.assists];
        const honors = s.trophies.length + s.awards.length + (s.seasonHonors ?? []).length;
        const rating = seasonRating(s, p.position);
        return (
          <div key={s.age} className={`lg-season ${i < revealCount ? "anim-slide" : ""}`}>
            <div className="lg-grid lg-row">
              <span className="lg-age">{s.age}</span>
              <span className="lg-crest" style={{ "--crest-h": String(hashStr(s.clubId) % 360) } as React.CSSProperties}>
                <Crest path={clubCrestPath(s.clubId)} alt={s.clubName} size={20} imgClass="lg-crest-img" fallback={s.clubName.slice(0, 1)} />
              </span>
              <span className="lg-club">
                <span className="lg-club-name">
                  <span className="lg-name-txt">{s.clubName}</span>
                  {s.relegated && <span className="sr-tag">降级</span>}
                </span>
              </span>
              <span className="lg-role">{ROLE_LABEL[s.role] ?? "—"}</span>
              <span className="lg-ovr" data-tier={ovrTier(s.overall)}>{s.overall}</span>
              {stats.map((v, j) => <span key={j} className={`lg-s ${v === 0 ? "lg-s-zero" : ""}`}>{v}</span>)}
              <span className="lg-rating" data-tier={rating !== null ? ratingTier(rating) : "dim"}>{rating !== null ? rating.toFixed(1) : "—"}</span>
            </div>
            {honors > 0 && (
              <LedgerHaul s={s} natId={game.player?.nationalityId} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 判决牌停留时长（ms）——同时驱动自动关闭的定时器和牌底那条等待条。 */
const VERDICT_MS = 2400;

function PlayScreen({ game, store }: { game: GameState; store: ReturnType<typeof useGameStore> }) {
  const { choose, advance, retire, abortRun, dismissMilestone } = store;
  const periodLength = game.periodLength ?? 2;
  const scrollRef = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();
  // 赛季节拍：本 period 逐季自动揭示。新 period 到来 → 归零重开。
  const periodGen = Math.floor(game.seasons.length / periodLength);
  const [revealCount, setRevealCount] = useState(0);
  // 选完事件后，结果先在决策位就地亮相一拍，再自动进入下一赛季
  const [outcomeFor, setOutcomeFor] = useState<string | null>(null);
  useEffect(() => { setRevealCount(0); }, [periodGen]);
  const revealing = revealCount < periodLength;
  // 账本窗口钉在最新一季：新行揭示后、决策位涨缩后都滚到顶部（最新季在列表最上方），眼睛不用来回找
  const dockMode = outcomeFor ? "outcome" : game.pendingChoice ? "decision" : "idle";
  useEffect(() => {
    const el = scrollRef.current;
    if (el) requestAnimationFrame(() => el.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" }));
  }, [revealCount, periodGen, dockMode, reduce]);
  // P-A168: one-time onboarding tip — a modal overlay on the very first career.
  // Explains the core loop (OVR = ability, odds = success chance, choices change
  // OVR). It used to be an inline card gated on revealCount, so it scrolled away
  // on its own before anyone clicked 知道了 — the flag never got written and it
  // came back every new career. Now the flag is written the moment it shows.
  const [showTip, setShowTip] = useState(() => {
    try { return localStorage.getItem("lvyin:onboarded") !== "1"; } catch { return true; }
  });
  useEffect(() => {
    if (showTip) { try { localStorage.setItem("lvyin:onboarded", "1"); } catch { /* storage off */ } }
  }, [showTip]);
  const dismissTip = () => setShowTip(false);

  // resolve micro-interaction: a subtle haptic + tap sfx on choice (Balatro-style feedback).
  const pick = (id: string) => { try { navigator.vibrate?.(10); } catch { /* noop */ } sfxTap(); setOutcomeFor(game.pendingChoice?.title ?? "结果"); choose(id); };
  // 生涯出口 —— 从球员卡迁入顶栏：放弃回主菜单、挂靴结算传承。两次都需二次确认，
  // 因为它们现在是常驻顶栏的一键操作，误触代价远高于旧版藏在二级 sheet 里。
  const onAbort = () => { if (confirm("放弃当前轮回？将返回主菜单，本轮回不结算传承分。")) abortRun(); };
  const onRetire = () => { if (confirm(game.customSeed ? "挂靴退役？指定种子不结算奖励，仅展示传承分。" : "挂靴退役？本轮回将结算传承分。")) retire(); };
  // 好坏由引擎的 resolve 结果决定（lastVerdict.good），不再靠关键词正则猜。
  const verdict = game.lastVerdict;
  const isBad = !!verdict && !verdict.good;

  // P-A4: milestone celebration — vibrate + milestone sfx + auto-dismiss on tap.
  const milestone = game.pendingMilestone;
  // the player's current OVR — drives the milestone popup's foil face (handoff 4.13).
  const displayOvr = displaySeasonOf(game, revealCount, periodLength).overall;
  const dismissMs = () => { try { navigator.vibrate?.(milestone?.tone === "legendary" ? 30 : 15); } catch { /* noop */ } sfxMilestone(); dismissMilestone(); };
  // P-A6: purist mode hides odds (the hardcore tension mode).
  const purist = !!store.meta.puristMode;

  // 自动节拍：结果亮相一拍 → 逐季自动揭示 → 决策弹出。里程碑弹层时暂停。
  // 没有决策的 period 揭示完后自动推进，全程无需点「下一赛季/继续」。
  useEffect(() => {
    if (milestone) return;
    if (outcomeFor && game.lastOutcome) {
      const t = setTimeout(() => setOutcomeFor(null), VERDICT_MS);
      return () => clearTimeout(t);
    }
    if (revealing) {
      const t = setTimeout(() => setRevealCount((c) => c + 1), revealCount === 0 ? 700 : 1500);
      return () => clearTimeout(t);
    }
    if (!game.pendingChoice) {
      const t = setTimeout(() => advance(), 900);
      return () => clearTimeout(t);
    }
  }, [milestone, outcomeFor, revealing, revealCount, game.pendingChoice, game.lastOutcome, advance]);

  // P-A9: sync sfx enabled state with the meta toggle.
  useEffect(() => { setSfxEnabled(store.meta.soundOn !== false); }, [store.meta.soundOn]);
  // P-A9: outcome sfx — play good/bad/trophy sound when a new outcome appears.
  const prevOutcome = useRef<string | null>(null);
  useEffect(() => {
    if (game.lastOutcome && game.lastOutcome !== prevOutcome.current) {
      const isTrophy = /冠军|封王|封帝|捧杯|夺冠|金球|金靴|金手套|世界杯/.test(game.lastOutcome);
      if (isTrophy) sfxTrophy();
      else if (isBad) sfxBad();
      else sfxGood();
    }
    prevOutcome.current = game.lastOutcome ?? null;
  }, [game.lastOutcome, isBad]);
  // P-A9: boss event sfx — tense rumble when a boss decision appears.
  const prevChoiceKey = useRef<string | null>(null);
  useEffect(() => {
    const key = game.pendingChoice?.key;
    if (key && key !== prevChoiceKey.current) {
      if (key === "world_cup_showdown" || key === "world_cup_qualifier_showdown" || key === "continental_cup_showdown") sfxBoss();
    }
    prevChoiceKey.current = key ?? null;
  }, [game.pendingChoice?.key]);



  return (
    <>
      {/* 判决牌 —— 选完事件后的结果不再挤在决策位里，而是全屏浮层给它一拍。
          好/坏用整张牌的光色 + 印章 + 判词三重编码（不只靠颜色），
          底部细条把这一拍的等待时间画出来，点任意处可提前跳过。 */}
      {outcomeFor && game.lastOutcome && !milestone && (
        <div className="verdict-overlay" onClick={() => setOutcomeFor(null)}>
          <div className="verdict-card anim-pop" data-verdict={isBad ? "bad" : "good"}>
            <i className="vd-rays" aria-hidden />
            <div className="vd-seal" aria-hidden>{isBad ? "▼" : "▲"}</div>
            <p className="vd-kicker">{outcomeFor}</p>
            <h2 className="vd-word">{isBad ? "事与愿违" : "如你所愿"}</h2>
            {verdict?.choice && <p className="vd-choice">你选择了「{verdict.choice}」</p>}
            <p className="vd-text">{game.lastOutcome}</p>
            {(!!verdict?.ovrDelta || verdict?.injury) && (
              <div className="vd-tags">
                {!!verdict?.ovrDelta && (
                  <span className={`vd-tag ${verdict.ovrDelta > 0 ? "vd-tag-up" : "vd-tag-down"}`}>
                    能力 <b className="font-mono">{verdict.ovrDelta > 0 ? "+" : "−"}{Math.abs(verdict.ovrDelta)}</b>
                  </span>
                )}
                {verdict?.injury && <span className="vd-tag vd-tag-down">{verdict.severe ? "重伤" : "伤病"}</span>}
              </div>
            )}
            <span className="vd-timer" aria-hidden><i style={{ animationDuration: `${VERDICT_MS}ms` }} /></span>
          </div>
        </div>
      )}
      {milestone && (
        <div className="milestone-overlay" onClick={dismissMs}>
          <div className={`milestone-card anim-pop ${milestone.tone === "legendary" ? "milestone-legendary" : ""}`} data-tier={ovrTier(displayOvr)}>
            <i className="ms-rays" aria-hidden />
            <div className="ms-medal">{milestone.tone === "legendary" ? "🏆" : "⭐"}</div>
            <p className="ms-kicker">{milestone.tone === "legendary" ? "传奇时刻" : "生涯里程碑"}</p>
            <h2 className="ms-title">{milestone.title}</h2>
            <p className="ms-desc">{milestone.desc}</p>
            <p className="ms-age">{milestone.age} 岁</p>
            <p className="ms-tap">点击继续</p>
          </div>
        </div>
      )}
      {showTip && (
        <div className="tip-overlay" onClick={dismissTip}>
          <div className="tip-sheet anim-pop" onClick={(e) => e.stopPropagation()}>
            <h2 className="tip-title">你的第一次轮回</h2>
            <ol className="tip-list">
              <li><b>赛季自己会走。</b>数据、能力、身价一行行写进生涯账本。</li>
              <li><b>决策改变命运。</b>屏幕下方会弹出转会、世界杯、伤病——胜率写在牌面上。</li>
              <li><b>把 <span className="font-mono">OVR</span> 养大。</b>能力值与身价随表现涨跌，这就是这一轮回。</li>
            </ol>
            <button className="btn btn-primary w-full" onClick={dismissTip}>开始生涯</button>
          </div>
        </div>
      )}
      <div className="play-shell">
        <PlayTopBar game={game} onAbort={onAbort} onRetire={onRetire} revealCount={revealCount} />

        <div className="play-body">
          <div className="play-scroll" ref={scrollRef}>
            <div className="play-scroll-inner">
              {/* 生涯页只留两样东西：球员（顶栏）+ 赛季账本，窗口钉在最新一季 */}
              <CareerLedger
                game={game}
                revealCount={revealCount}
                periodLength={periodLength}
              />
            </div>
          </div>
        </div>

        {/* 决策位 —— 页面唯一的行动区：结果亮相 → 赛季推进 → 决策弹出，都在这一格 */}
        <div
          className="decision-dock"
          data-rarity={!revealing && !outcomeFor && game.pendingChoice ? game.pendingChoice.rarity : undefined}
          data-fate={!revealing && !outcomeFor && game.pendingChoice?.fate ? "true" : undefined}
        >
          {/* 结果亮相期间决策位保持待机——判决牌在浮层里，这一格不再抢戏。 */}
          {!outcomeFor && !revealing && game.pendingChoice ? (
            <div className="dock-decision anim-slide">
              <div className="dock-head">
                <span className="dock-title">
                  {game.pendingChoice.rarity === "legendary" ? <span className="rarity-badge legendary">传说</span>
                    : game.pendingChoice.rarity === "rare" ? <span className="rarity-badge rare">稀有</span> : null}
                  {game.pendingChoice.fate && <span className="rarity-badge fate">宿命</span>}
                  {game.pendingChoice.title}
                </span>
              </div>
              {/* 叙事是这款游戏的内容本体，永远不截断：长文在决策位内滚动，
                  一个字都不省略（省略号会把事件的因果吃掉，玩家就没法判断）。 */}
              <p className="deck-desc">{game.pendingChoice.desc}</p>
              <DecisionBoard choices={game.pendingChoice.choices} purist={!!purist}
                fate={!!game.pendingChoice.fate} onPick={pick} />
            </div>
          ) : (
            <div className="dock-idle"><span className="lg-dot" /> 赛季进行中…</div>
          )}
        </div>
      </div>

    </>
  );
}



// ───────────────────────────── summary ─────────────────────────────

function SummaryScreen({ game, store }: { game: GameState; store: ReturnType<typeof useGameStore> }) {
  const { toMenu, startRun, lastSetup, meta } = store;
  const rank = rankOf(game.legacy);
  // P-A5: achievement celebration popup — the first new achievement earns a
  // full-screen celebration, reusing the milestone overlay style.
  const newAch = (game.newCollectedAchievements ?? []).map((id) => ACHIEVEMENTS.find((a) => a.id === id)!).filter(Boolean);
  const [achIdx, setAchIdx] = useState(0);
  const achPopup = newAch[achIdx];
  const nextAch = () => { try { navigator.vibrate?.(20); } catch { /* noop */ } setAchIdx((i) => i + 1); };
  const reason = game.retirementReason === "voluntary" ? "主动挂靴"
    : game.retirementReason === "age" ? "年迈退役"
    : game.retirementReason === "faded" ? "英雄迟暮"
    : game.retirementReason === "journeyman" ? "坚守多年"
    : game.retirementReason === "injury" ? "伤病退役"
    : game.retirementReason === "no_offers" ? "无人问津"
    : "无人问津";
  // one-tap quick restart with the same config (new random seed) — the "one more run" button.
  const quickRestart = () => {
    if (!lastSetup) { toMenu(); return; }
    // 再来一局掷一颗新随机种子 → 随机模式、正常结算（覆盖上一局可能的「指定」标记）。
    startRun({ ...lastSetup, seed: store.newSeed(), customSeed: false, permPerks: meta.permPerks });
  };
  // P-A127: career vs best comparison — "beat your best" motivation loop
  const isBestRun = game.legacy >= meta.bestRun;
  const bestGap = meta.bestRun - game.legacy;
  const canPrestige = prestigeEligible(meta);

  // P3: carry a near-miss into the next run as a redemption challenge.
  const startWithChallenge = (challengeId: string) => {
    if (!lastSetup) { toMenu(); return; }
    startRun({ ...lastSetup, seed: store.newSeed(), customSeed: false, permPerks: meta.permPerks, challenge: makeChallenge(challengeId) });
  };

  // did the run satisfy a carried challenge? (shows a victory badge)
  const carriedSuccess = challengeSucceeded(game.challenge, { trophies: game.trophies, awards: game.awards, maxOverall: game.maxOverall, seasons: game.seasons.length });
  const nearMisses = nearMissChallenges({ trophies: game.trophies, awards: game.awards, maxOverall: game.maxOverall, seasons: game.seasons.length });
  // P-A163: one link builder for the whole summary screen. It encodes the
  // STARTING league — currentLeagueId moves with every transfer, so a career
  // that began in 巴甲 and ended at Real Madrid used to hand the recipient a
  // La Liga start, i.e. a different career from the one the card challenges
  // them to beat. startLeagueId is stamped at createRun; the seasons[0] fallback
  // covers saves written before that field existed.
  const summaryLink = (): CareerLink => ({
    seed: game.seed,
    nationalityId: game.player?.nationalityId ?? "",
    position: (game.player?.position ?? "ST") as Position,
    leagueId: game.startLeagueId ?? game.seasons[0]?.leagueId ?? game.currentLeagueId,
    clubId: game.startClubId ?? game.seasons[0]?.clubId ?? game.currentClubId,
    pace: (game.pace as PaceMode) ?? "normal",
    // identity rides along so the recipient's shirt matches the card
    playerName: game.player?.name,
    squadNumber: game.player?.squadNumber,
  });
  // P-A124: achievement brag card — generates shareable text for rare achievements
  const shareAchievement = (achName: string, achDesc: string) => {
    const p = game.player;
    const text = `🏅 绿茵轮回 · 解锁成就「${achName}」\n${achDesc}\n${p?.name ?? "?"} · ${rank.name} · 巅峰OVR${game.maxOverall}\n${SHARE_CTA}\n${SHARE_TAGS}`;
    shareText(text, careerUrl(summaryLink()));
  };
  // Career totals — the numbers a football career is actually remembered by.
  const isGK = game.player?.position === "GK";
  const totals = game.seasons.reduce(
    (t, s) => ({
      appearances: t.appearances + s.stats.appearances,
      goals: t.goals + s.stats.goals,
      assists: t.assists + s.stats.assists,
      cleanSheets: t.cleanSheets + s.stats.cleanSheets,
      goalsConceded: t.goalsConceded + s.stats.goalsConceded,
    }),
    { appearances: 0, goals: 0, assists: 0, cleanSheets: 0, goalsConceded: 0 },
  );
  const clubCount = new Set(game.seasons.map((s) => s.clubName)).size;
  const peakMv = Math.max(0, ...game.seasons.map((s) => s.marketValue ?? 0));

  // 生涯成就 — every achievement this career EARNED, not just first-time ones.
  // The vanity wall: a 球王-shape run must read as one on the tenth replay too,
  // or the settlement only celebrates novelty instead of the career.
  const achInput = computeAchievementInput(game);
  const earnedAch = ACHIEVEMENTS.filter((a) => a.achieved(achInput));
  const epitaph = careerEpitaph(game);

  // P-A10: count-up the legacy number for the dopamine tick.
  const legacyCount = useCountUp(game.legacy);
  const [shareImgOpen, setShareImgOpen] = useState(false);

  // 生涯分享卡 — everything the PNG card needs, derived from the finished
  // career. Trophies are tallied WITH league context (西甲冠军×4 reads like a
  // career; 联赛×7 doesn't); clubs keep first-appearance order. The QR carries
  // the challenge link — scanning it lands on the same seed + setup.
  const shareCardData = (): ShareCardData => {
    const p = game.player;
    const natConf = natConfOf(p?.nationalityId);
    const GOLD_T: readonly Trophy[] = ["world_cup", "continental_primary", "national_continental", "club_world_cup"];
    const PRESTIGE: Record<string, number> = { world_cup: 0, continental_primary: 1, national_continental: 3, club_world_cup: 4, league: 5, cup: 6, continental_secondary: 7 };
    const tMap = new Map<string, { rank: number; e: ShareTrophyEntry }>();
    for (const s of game.seasons) {
      const conf = confederationOfLeague(s.leagueId);
      for (const t of s.trophies) {
        let key: string, label: string, img: string | null;
        if (t === "league") { key = `league:${s.leagueId}`; label = `${s.leagueName}冠军`; img = trophyPath(t, conf, s.leagueId); }
        else if (t === "cup") { key = `cup:${s.leagueId}`; label = `${s.leagueName}杯赛`; img = trophyPath(t, conf, s.leagueId); }
        else if (t === "continental_primary" || t === "continental_secondary") { key = `${t}:${conf}`; label = trophyLabel(t, conf); img = trophyPath(t, conf); }
        else if (t === "national_continental") { key = "nc"; label = trophyLabel(t, natConf ?? conf); img = trophyPath(t, conf, undefined, natConf); }
        else { key = t; label = trophyLabel(t, conf); img = trophyPath(t, conf); }
        const cur = tMap.get(key);
        if (cur) cur.e.count += 1;
        else tMap.set(key, { rank: PRESTIGE[t] ?? 8, e: { img, emoji: "🏆", label, count: 1, gold: GOLD_T.includes(t) } });
      }
    }
    const AWARD_ICON: Record<Award, string> = { ballon_dor: "🥇", golden_boot: "👟", golden_glove: "🧤" };
    const entries = [...tMap.values()];
    for (const [a, n] of tally(game.awards)) {
      entries.push({ rank: a === "ballon_dor" ? 2 : 8, e: { img: null, emoji: AWARD_ICON[a], label: AWARD_LABEL[a], count: n, gold: a === "ballon_dor" } });
    }
    const trophies = entries.sort((x, y) => x.rank - y.rank || y.e.count - x.e.count).map((x) => x.e).slice(0, 15);

    // national team — caps/goals + the deepest run per cup (世界杯 before 洲际杯).
    let national: ShareCardData["national"] = null;
    if (p) {
      const called = game.seasons.filter((s) => s.national?.calledUp);
      if (called.length > 0) {
        const caps = called.reduce((n, s) => n + (s.national?.caps ?? 0), 0);
        const goals = called.reduce((n, s) => n + (s.national?.goals ?? 0), 0);
        const contName = NAT_CONT_NAME[natConf ?? ""] ?? "洲际杯";
        const stageRank: Record<string, number> = { "冠军": 5, "亚军": 4, "四强": 3, "八强": 2, "小组赛": 1 };
        const bestByCup = new Map<string, string>();
        for (const s of game.seasons) {
          const t = s.national?.tournament;
          if (!t) continue;
          const cup = t.trophy === "world_cup" ? "世界杯" : contName;
          const cur = bestByCup.get(cup);
          if (!cur || (stageRank[t.stage] ?? 0) > (stageRank[cur] ?? 0)) bestByCup.set(cup, t.stage);
        }
        const best = [...bestByCup.entries()].sort((a, b) => (stageRank[b[1]] ?? 0) - (stageRank[a[1]] ?? 0)).map(([c, st]) => `${c}${st}`).join(" · ");
        national = { line: `${nationName(p.nationalityId)}国家队 ${caps} 场${isGK ? "" : ` · ${goals} 球`}`, best };
      }
    }

    const clubMap = new Map<string, ShareClubEntry>();
    for (const s of game.seasons) {
      const cur = clubMap.get(s.clubId);
      if (cur) cur.seasons += 1;
      else clubMap.set(s.clubId, { id: s.clubId, crest: clubCrestPath(s.clubId), name: s.clubName, seasons: 1 });
    }
    const allClubs = [...clubMap.values()];

    return {
      name: p?.name ?? "?",
      flagPath: p ? nationFlagPath(p.nationalityId) : null,
      nation: p ? nationName(p.nationalityId) : "",
      posLabel: POS_LABEL[p?.position ?? ""] ?? p?.position ?? "",
      peakOvr: game.maxOverall,
      tier: ovrTier(game.maxOverall),
      seasons: game.seasons.length,
      clubCount,
      peakMv: fmtMv(peakMv),
      totalWage: fmtCareerWage(game.seasons),
      legacy: game.legacy,
      rankName: rank.name,
      title: tierTitle(game.maxOverall),
      percentile: ovrPercentile(game.maxOverall),
      epitaph,
      achievements: earnedAch.slice(0, 6).map((a) => ({ name: a.name, desc: a.desc.replace(/。$/, "") })),
      extraAchievements: Math.max(0, earnedAch.length - 6),
      national,
      trophies,
      stats: isGK
        ? [{ label: "出场", value: totals.appearances }, { label: "零封", value: totals.cleanSheets }, { label: "失球", value: totals.goalsConceded }]
        : [{ label: "出场", value: totals.appearances }, { label: "进球", value: totals.goals }, { label: "助攻", value: totals.assists }],
      clubs: allClubs.slice(0, 15),
      extraClubs: Math.max(0, allClubs.length - 15),
      seed: game.seed,
      url: careerUrl(summaryLink()),
      host: window.location.host,
    };
  };
  const [archiveTab, setArchiveTab] = useState(0);
  const [archiveMore, setArchiveMore] = useState(false);
  // 生涯档案 content (deep-dive lists capped at 6; 展开 for full history).
  const beats = game.careerBeats ?? [];
  const choices = game.choiceLog ?? [];
  const ARCHIVE_CAP = 6;
  const archiveList = <T,>(list: readonly T[]): T[] => (archiveMore ? [...list] : list.slice(0, ARCHIVE_CAP));
  return (
    <div className="flex flex-col gap-3 pt-4 pb-32">
      {/* 本局战果 — the settlement verdict: new record / gap to best / carried challenge.
          指定种子的轮回不结算任何奖励，只显式提示「不计入」，不展示新纪录/差距/挑战。 */}
      {game.customSeed ? (
        <div className="card">
          <p className="text-sm m-0 text-warn font-semibold">⚠️ 指定种子 · 本局不结算奖励</p>
          <p className="text-[13px] text-muted m-0 mt-1">传承分仅作展示与分享比较，不计入传承、最佳、飞升与成就。出道台切回「🎲 随机」即可正常结算。</p>
        </div>
      ) : (meta.runs > 1 || (carriedSuccess && game.challenge)) && (
        <div className="card">
          {isBestRun && meta.runs > 1 && <p className="text-sm m-0 text-gold">🏆 新纪录！刷新个人最佳传承分</p>}
          {!isBestRun && bestGap > 0 && <p className="text-sm m-0 text-warn">距最佳还差 <b className="text-text">{bestGap}</b> 传承分</p>}
          {carriedSuccess && game.challenge && (
            <p className={`text-sm m-0 text-gold ${(isBestRun || bestGap > 0) ? "mt-1.5" : ""}`}>🎯 挑战达成：{game.challenge.label} · 传承分 ×{game.challenge.legacyMult.toFixed(1)}</p>
          )}
        </div>
      )}
      {achPopup && (
        <div className="milestone-overlay" onClick={nextAch}>
          <div className="milestone-card anim-pop milestone-legendary">
            <i className="ms-rays" aria-hidden />
            <div className="ms-medal">🏅</div>
            <p className="ms-kicker">成就解锁</p>
            <h2 className="ms-title">{achPopup.name}</h2>
            <p className="ms-desc">{achPopup.desc}</p>
            <button className="btn-sm mt-3" onClick={(e) => { e.stopPropagation(); shareAchievement(achPopup.name, achPopup.desc); }}>📱 分享成就</button>
            <p className="ms-tap">点击继续</p>
          </div>
        </div>
      )}
      <div className="hero-card">
        {/* 英雄头：生涯最高 OVR 档位徽章 + 身份。徽章用玩家巅峰档位的渐变锡纸——
            mud→marble 的德服，一个 60 OVR 的轮回和一个 92 的不该长一个样（handoff 4.11）。 */}
        <div className="hero-head">
          <OvrBadge ovr={game.maxOverall} label="生涯最高" />
          <div className="hero-id">
            <div className="hero-name">
              {flagEmoji(game.player?.nationalityId ?? "")} {game.player?.name ?? "?"}
              {game.player?.squadNumber ? <span className="hn-num">#{game.player.squadNumber}</span> : null}
            </div>
            <div className="hero-sub">
              {POS_LABEL[game.player?.position ?? ""] ?? game.player?.position} · {game.seasons.length} 赛季 · {clubCount} 家俱乐部
            </div>
          </div>
        </div>
        {(() => { const traits = personaTags(game.personaTagsEver); return traits.length > 0 && (
          <div className="hero-traits" aria-label="生涯词条">
            {traits.map((t) => <span key={t.label} className={`hero-trait ${TRAIT_TONE_CLASS[t.tone]}`}>{t.label}</span>)}
          </div>
        ); })()}

        {/* 结局横幅：档位色锡纸条 + 档位头衔 + 百分位 + 墓志铭。这是这段生涯被复述的样子。 */}
        <div className="hero-banner" data-tier={ovrTier(game.maxOverall)}>
          <span className="hb-eyebrow">生涯结局</span>
          <h2 className="hb-title">{tierTitle(game.maxOverall)}</h2>
          <p className="hb-pct">巅峰能力超越了 {ovrPercentile(game.maxOverall)}% 的球员</p>
          <p className="hb-epitaph">{epitaph}</p>
        </div>

        {/* 传承分揭晓：游戏核心进度货币的计数动画——与档位头衔是两个维度
            （档位=踢得多好，传承分=轮回货币），都留着。 */}
        <div className="hero-legacy">
          <div className="num hero-legacy-num anim-tick">{legacyCount}</div>
          <p className="hero-legacy-label">传承分 · {reason}</p>
          <p className="hero-rank" style={{ color: rank.color }}>{rank.name}</p>
        </div>

        <p className="hero-seed">种子 {game.seed}</p>
      </div>

      {/* 8 numbers, 2 clean rows: 场上表现 then 荣誉与钱. 出场/进球/助攻 是足球生涯
          最本能的三个数字，之前整页都没有。赛季数已移到 hero 身份行，不重复。 */}
      <StatStrip items={[
        { label: "巅峰OVR", value: <span className={ovrTierClass(game.maxOverall)}>{game.maxOverall}</span> },
        { label: "出场", value: totals.appearances },
        ...(isGK
          ? [{ label: "零封", value: totals.cleanSheets }, { label: "失球", value: totals.goalsConceded }]
          : [{ label: "进球", value: totals.goals }, { label: "助攻", value: totals.assists }]),
        { label: "奖杯", value: game.trophies.length },
        { label: "个人荣誉", value: game.awards.length },
        { label: "巅峰身价", value: <span className="text-gold">€{fmtMv(peakMv)}</span> },
        { label: "生涯总薪", value: <span className="text-gold">€{fmtCareerWage(game.seasons)}</span> },
      ]} />

      {/* P-NAT: 国家队生涯 — the parallel national track's career verdict.
          Caps/goals accumulated over every call-up season, the national
          honors (世界杯 / 洲际杯), and the single deepest tournament run, so
          a career that fought for its country is honored on the summary, not
          only the club line. Hidden when the player was never capped. */}
      {(() => {
        const p = game.player;
        if (!p) return null;
        const called = game.seasons.filter((s) => s.national?.calledUp);
        if (called.length === 0) return null;
        const caps = called.reduce((s, x) => s + (x.national?.caps ?? 0), 0);
        const goals = called.reduce((s, x) => s + (x.national?.goals ?? 0), 0);
        const wc = game.seasons.filter((s) => s.national?.tournament?.trophy === "world_cup").length;
        const cont = game.seasons.filter((s) => s.national?.tournament?.trophy === "national_continental").length;
        const conf = natConfOf(p.nationalityId);
        const contName = conf ? (NAT_CONT_NAME[conf] ?? "洲际杯") : "洲际杯";
        const stageRank: Record<string, number> = { "冠军": 5, "亚军": 4, "四强": 3, "八强": 2, "小组赛": 1 };
        let best: { cup: string; stage: string } | null = null;
        for (const s of game.seasons) {
          const t = s.national?.tournament;
          if (!t) continue;
          const cup = t.trophy === "world_cup" ? "世界杯" : contName;
          if (!best || (stageRank[t.stage] ?? 0) > (stageRank[best.stage] ?? 0)) best = { cup, stage: t.stage };
        }
        return (
          <div className="card">
            <SectionTitle>国家队生涯 · {flagEmoji(p.nationalityId)} {nationName(p.nationalityId)}</SectionTitle>
            <StatStrip items={[
              { label: "国字号赛季", value: called.length },
              { label: "出场", value: caps },
              { label: "进球", value: goals },
              { label: "世界杯", value: wc > 0 ? <span className="text-gold">×{wc}</span> : "—" },
              { label: contName, value: cont > 0 ? <span className="text-gold">×{cont}</span> : "—" },
            ]} />
            {best && (
              <p className="lbl-c text-[11px] text-muted m-0 mt-2.5">
                最佳战绩 <span className="text-accent font-semibold">· {best.cup}{best.stage}</span>
              </p>
            )}
          </div>
        );
      })()}

      {/* 生涯成就 — 这段生涯配得上的所有成就徽章，津津乐道的部分。
          新解锁的标出来；老成就照样陈列（荣誉不因重复而褪色）。 */}
      {earnedAch.length > 0 && (
        <div className="card">
          <SectionTitle>生涯成就</SectionTitle>
          <div className="flex flex-col gap-1.5">
            {earnedAch.map((a) => {
              const isNew = (game.newCollectedAchievements ?? []).includes(a.id);
              return (
                <div key={a.id} className="ach-row">
                  <span className="ach-star" aria-hidden="true">✦</span>
                  <span className="min-w-0 flex-1">
                    <b className="text-gold">{a.name}</b>
                    <span className="text-sm text-muted ml-2">{a.desc.replace(/。$/, "")}</span>
                  </span>
                  {isNew && <span className="pill pill-accent flex-none self-center">新解锁</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(() => {
        // 荣誉室 — trophies + awards + first-time trophy collection in one card.
        // (首次解锁的成就已在上方生涯成就墙标「新解锁」，不再重复成 pill。)
        const newT = game.newCollectedTrophies ?? [];
        if (game.trophies.length === 0 && game.awards.length === 0 && newT.length === 0) return null;
        return (
          <div className="card">
            <SectionTitle>荣誉室</SectionTitle>
            {/* 重复奖杯折成 欧冠×3 — 一个 4 冠球员之前要占 4 个 pill，现在占 1 个。 */}
            {game.trophies.length > 0 && (
              <div className="mb-2.5">
                <p className="lbl-c text-[10px] text-dim m-0 mb-1.5">
                  奖杯 <span className="text-muted font-normal">· {game.trophies.length} 座</span>
                  {(game.bestStreak ?? 0) >= 2 && <span className="text-gold font-normal"> · 最长 {game.bestStreak} 连冠</span>}
                </p>
                <div className="flex flex-wrap gap-1.5">{tally(game.trophies).map(([t, n]) => <TrophyBadge key={t} t={t} n={n} conf={confederationOfLeague(game.currentLeagueId)} leagueId={game.currentLeagueId} natConf={natConfOf(game.player?.nationalityId)} />)}</div>
              </div>
            )}
            {game.awards.length > 0 && (
              <div className="mb-2.5">
                <p className="lbl-c text-[10px] text-dim m-0 mb-1.5">个人荣誉 <span className="text-muted font-normal">· {game.awards.length} 项</span></p>
                <div className="flex flex-wrap gap-1.5">{tally(game.awards).map(([a, n]) => <AwardBadge key={a} a={a} n={n} />)}</div>
              </div>
            )}
            {newT.length > 0 && (
              <div>
                <p className="lbl-c text-[10px] text-dim m-0 mb-1.5">🆕 首次入藏</p>
                {/* dedupe: three 洲际 wins are ONE first collection, not three pills.
                    Same conf-aware naming as the badges above (解放者杯, not 欧冠). */}
                <div className="flex flex-wrap gap-1.5">{[...new Set(newT)].map((t) => (
                  <span key={t} className="pill pill-gold">
                    {trophyLabel(t, t === "national_continental" ? natConfOf(game.player?.nationalityId) ?? "UEFA" : confederationOfLeague(game.currentLeagueId))} 首获！
                  </span>
                ))}</div>
              </div>
            )}
          </div>
        );
      })()}

      {/* 生涯曲线 — the career arc at a glance: scoring/clean-sheet + market value.
          A real chart, not a bar doodle: shared-age x-axis, y-rail with the max,
          peak bar gilded + value-labeled, rise-in animation. */}
      {(() => {
        const seasons = game.seasons;
        const ovrs = seasons.map((s) => s.overall);
        const mvs = seasons.map((s) => s.marketValue ?? 0);
        if (seasons.length < 2) return null;
        const metric = isGK ? seasons.map((s) => s.stats.cleanSheets) : seasons.map((s) => s.stats.goals);
        const metricLabel = isGK ? "零封" : "进球";
        const maxM = Math.max(1, ...metric);
        const peakIdx = metric.lastIndexOf(maxM);
        const minOvr = Math.min(...ovrs), maxOvr = Math.max(...ovrs);
        // reuse the career peak (was Math.max(1, …), which mislabelled the peak
        // bar whenever a whole career stayed under €1M).
        const showMv = mvs.length >= 2 && peakMv > 0;
        const mvPeakIdx = mvs.lastIndexOf(peakMv);
        const peakMvLabel = fmtMv(peakMv);
        // label only the peak bar (and its neighbours when few bars) to avoid clutter
        const labelGoals = (i: number) => seasons.length <= 6 || i === peakIdx;
        const labelMv = (i: number) => seasons.length <= 6 || i === mvPeakIdx;
        return (
          <div className="card career-chart">
            <SectionTitle>生涯曲线</SectionTitle>

            {/* goals / clean sheets — the scorer arc */}
            <p className="lbl-c text-[10px] text-dim m-0 mb-2">{metricLabel} <span className="text-muted font-normal">· 单季最高 {maxM}</span></p>
            <div className="cc-sub" style={{ height: 84 }}>
              <div className="cc-rail"><span className="cc-max">{maxM}</span></div>
              <div className="cc-plot">
                {metric.map((m, i) => (
                  <div
                    key={i}
                    className="cc-bar"
                    data-peak={m === maxM}
                    style={{ height: `${Math.max(4, (m / maxM) * 100)}%`, animationDelay: `${i * 45}ms` }}
                    title={`${seasons[i]?.age}岁 · ${m} ${metricLabel}`}
                  >
                    {labelGoals(i) && <span className="cc-v">{m}</span>}
                  </div>
                ))}
              </div>
            </div>
            <div className="cc-axis">
              {seasons.map((s) => <span key={s.age}>{s.age}</span>)}
            </div>

            {showMv && (
              <>
                <div className="cc-divider" />
                <p className="lbl-c text-[10px] text-dim m-0 mb-2">身价 <span className="text-muted font-normal">· 峰值 €{peakMvLabel}</span></p>
                <div className="cc-sub" style={{ height: 64 }}>
                  <div className="cc-rail"><span className="cc-max">€{peakMvLabel}</span></div>
                  <div className="cc-plot">
                    {mvs.map((mv, i) => (
                      <div
                        key={i}
                        className="cc-bar"
                        data-peak={mv === peakMv}
                        style={{ height: `${Math.max(4, (mv / peakMv) * 100)}%`, animationDelay: `${120 + i * 45}ms` }}
                        title={`${seasons[i]?.age}岁 · €${fmtMv(mv)}`}
                      >
                        {labelMv(i) && <span className="cc-v">€{fmtMv(mv)}</span>}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="cc-axis">
                  {seasons.map((s) => <span key={s.age}>{s.age}</span>)}
                </div>
              </>
            )}

            <p className="font-mono text-[11px] text-dim mt-3 m-0">
              {isGK ? `最多 ${maxM} 零封` : `单季最高 ${maxM} 球`} · OVR {minOvr}→{maxOvr}{showMv ? ` · 身价峰值 €${peakMvLabel}` : ""}
            </p>
          </div>
        );
      })()}

      {/* 未竟之志 — near-miss challenges, offered for the next run. */}
      {nearMisses.length > 0 && (
        <div className="card">
          <SectionTitle>定义性时刻 · 未竟之志</SectionTitle>
          <p className="font-mono text-[11px] text-dim m-0 mb-3">这程你差了一步的事。选一个作为下局挑战目标——达成可获得传承分加成。</p>
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {nearMisses.map((c) => (
              <div key={c.id} className="bg-surface-2 border border-line rounded-md p-3 flex flex-col flex-none w-[232px]">
                <strong className="text-warn">{c.label}</strong>
                <p className="text-sm text-muted m-0 mt-1 mb-2.5 flex-1">{c.hint}</p>
                <div className="flex items-center justify-between gap-2">
                  <span className="pill pill-accent">×{c.legacyMult.toFixed(1)} 传承</span>
                  <button className="btn-sm btn-primary" onClick={() => startWithChallenge(c.id)}>挑战</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 生涯档案 — the deep-dive: story / choices / clubs / seasons, one list at a time. */}
      {(() => {
        // P-A11 club stints, folded in as the 效力 tab.
        const stints: { clubName: string; leagueName: string; start: number; end: number; count: number; trophies: number; apps: number; goals: number; assists: number; cleanSheets: number }[] = [];
        for (const s of game.seasons) {
          const last = stints[stints.length - 1];
          if (last && last.clubName === s.clubName) {
            last.end = s.age; last.count += 1; last.trophies += s.trophies.length;
            last.apps += s.stats.appearances; last.goals += s.stats.goals; last.assists += s.stats.assists; last.cleanSheets += s.stats.cleanSheets;
          } else {
            stints.push({ clubName: s.clubName, leagueName: s.leagueName, start: s.age, end: s.age, count: 1, trophies: s.trophies.length, apps: s.stats.appearances, goals: s.stats.goals, assists: s.stats.assists, cleanSheets: s.stats.cleanSheets });
          }
        }
        const stintGK = game.player?.position === "GK";
        const seasonsList = [...game.seasons].reverse();
        if (beats.length === 0 && choices.length === 0 && stints.length === 0 && seasonsList.length === 0) return null;
        const shownBeats = archiveList(beats);
        const shownChoices = archiveList(choices);
        const shownSeasons = archiveList(seasonsList);
        const more = Math.max(0, archiveTab === 0 ? beats.length - ARCHIVE_CAP
          : archiveTab === 1 ? choices.length - ARCHIVE_CAP
          : archiveTab === 2 ? stints.length - ARCHIVE_CAP
          : seasonsList.length - ARCHIVE_CAP);
        return (
          <div className="card">
            <SectionTitle>生涯档案</SectionTitle>
            <div className="grid grid-cols-4 gap-1.5 mb-3">
              {(["故事线", "抉择", "效力", "逐季"] as const).map((label, i) => (
                <button
                  key={label}
                  className={`chip text-[11px] px-1 ${archiveTab === i ? "chip-active" : ""}`}
                  onClick={() => { setArchiveTab(i); setArchiveMore(false); }}
                >
                  {label}
                </button>
              ))}
            </div>
            {archiveTab === 0 && (
              <div className="flex flex-col gap-1.5">
                {shownBeats.map((b, i) => (
                  <div key={i} className="story-beat" data-tone={b.tone}>
                    <span className="sb-age font-mono text-[11px] text-dim">{b.age}岁</span>
                    <span className={`sb-text text-sm ${b.tone === "legendary" ? "text-gold font-semibold" : b.tone === "good" ? "text-text" : b.tone === "bad" ? "text-warn" : "text-muted"}`}>{b.text}</span>
                  </div>
                ))}
                {shownBeats.length === 0 && <p className="text-sm text-muted m-0">暂无故事记录</p>}
              </div>
            )}
            {archiveTab === 1 && (
              <div className="flex flex-col gap-2">
                {shownChoices.map((c, i) => (
                  <div key={i} className="choice-log-entry">
                    <div className="cle-age font-mono text-[11px] text-dim">{c.age}岁</div>
                    <div className="cle-body">
                      <span className="cle-title font-semibold text-sm">{c.title}</span>
                      <span className="cle-choice text-xs text-accent">→ {c.choice}</span>
                      <p className="cle-outcome text-sm text-muted m-0 mt-0.5">{c.outcome}</p>
                    </div>
                    <span className={`cle-icon ${c.good ? "text-good" : "text-warn"}`}>{c.good ? "▲" : "▼"}</span>
                  </div>
                ))}
                {shownChoices.length === 0 && <p className="text-sm text-muted m-0">暂无抉择记录</p>}
                {shownChoices.length > 0 && (
                  <p className="font-mono text-[11px] text-dim m-0 mt-3 text-center">换个种子、换个选择，下一段旅程完全不同。🦋</p>
                )}
              </div>
            )}
            {archiveTab === 2 && (
              <div className="flex flex-col gap-1.5">
                {stints.map((st, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-3 py-2 bg-surface border border-line rounded-md text-sm">
                    <div className="min-w-0">
                      <span className="font-semibold">{st.clubName}</span>
                      <span className="font-mono text-[11px] text-dim ml-1.5">{st.leagueName}</span>
                    </div>
                    <span className="font-mono text-[11px] text-muted">{st.start}-{st.end}岁 · {st.count}季</span>
                    {st.trophies > 0 && <span className="font-mono text-[11px] text-gold">{st.trophies}🏆</span>}
                    <span className="col-span-3 font-mono text-[11px] text-dim">
                      {st.apps}场{stintGK ? ` · ${st.cleanSheets}零封` : ` · ${st.goals}球 · ${st.assists}助攻`}
                    </span>
                  </div>
                ))}
                {stints.length === 0 && <p className="text-sm text-muted m-0">暂无效力记录</p>}
              </div>
            )}
            {archiveTab === 3 && (
              <div className="flex flex-col gap-2">
                {shownSeasons.map((s, i) => <SeasonRow key={i} s={s} position={game.player?.position} seed={game.seed} natConf={natConfOf(game.player?.nationalityId)} />)}
              </div>
            )}
            {more > 0 && (
              <button className="log-toggle mt-3" onClick={() => setArchiveMore((v) => !v)} aria-expanded={archiveMore}>
                <span className="log-title">{archiveMore ? "收起" : `展开全部 +${more}`}</span>
                <span className="log-chev">{archiveMore ? "收起 ▴" : "展开 ▾"}</span>
              </button>
            )}
          </div>
        );
      })()}

      {/* fixed action dock — the settlement's single control row */}
      <div className="summary-dock">
        <button className="btn-primary dock-primary" onClick={quickRestart}>再来一局</button>
        <button className="btn dock-btn" onClick={() => setShareImgOpen(true)}>分享</button>
        <button className="btn dock-btn" onClick={toMenu}>主菜单</button>
      </div>

      {shareImgOpen && <ShareCardOverlay data={shareCardData()} onClose={() => setShareImgOpen(false)} />}

      {canPrestige && (
        <div className="card hook-card" style={{ borderColor: "var(--gold, #fbbf24)" }}>
          <p className="text-sm m-0 text-gold">⚡ 你已可轮回！献祭祝福与传承，换取一项永久特权，下一段旅程更强。</p>
          <p className="font-mono text-[11px] text-dim m-0 mt-1.5">主菜单 → 轮回 标签查看三选一。</p>
        </div>
      )}
      <VersionFooter />
    </div>
  );
}
