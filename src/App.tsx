/**
 * App orchestrator — owns the top-level view switch and routes to screen
 * components. State lives in useGameStore (reducer). UI uses Tailwind utilities.
 */
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, Fragment } from "react";
import { useGameStore } from "./state/store";
import { Sheet } from "./ui/Sheet";
import { IconChevron, IconGlobe, IconMode, IconNav, IconTrend } from "./ui/icons";
import { PX, PxBlessing } from "./ui/pixel-icons";
import { ScoreBall, ScoreLegacy, ScoreBest, ScoreAscension, ScoreCycle } from "./ui/score-icons";
import { liveLegacy, type PaceMode } from "./engine/run";
import { projectedRetireAge, clubTrophyCandidates, computeSeasonRating, leagueTitleCeiling } from "./engine/sim";
import { NATIONS, LEAGUES, ALL_POSITIONS, CLUBS, clubById, leagueById, homeLeagueOf, weakestClubInLeague, ROLE_GROUP, generatePlayerName, generateSquadNumber, NATION_LEGACY_MULT, isWcAge, isNatContAge, isOlympicAge, SIGNATURE_ELITE, signatureStatOf, type Position, type RoleGroup } from "./engine/data";
import { clubCrestPath, leagueLogoPath, trophyPath, nationFlagPath, awardImgPath } from "./engine/images";
import { ShareCardOverlay, TrophyCell, ClubCell, type ShareCardData, type ShareTrophyEntry, type ShareClubEntry } from "./ui/ShareCard";
import { MonoCrest, hashStr } from "./ui/MonoCrest";
import { fetchLeaderboard, localMidnightUtc, type BoardResponse, type LeaderboardEntry } from "./api/leaderboard";
import { submitEventFeedback, type FeedbackEvent } from "./api/feedback";
import {
  BLESSINGS, ASCENSIONS, UNLOCKS, FREE_NATIONS, isUnlocked, resolveLoadout, MAX_LOADOUT,
  blessingCost, PRESTIGE_PRICE_DISCOUNT,
  blessingById,
  PRESTIGE_PERKS, prestigeEligible, prestigeChoices, PRESTIGE_LEGACY_THRESHOLD,
  dailySetup as dailySetupFn, todayStr, type DailyResult,
  type CareerArchiveEntry,
  ACHIEVEMENTS, ALL_TROPHY_IDS, computeAchievementInput,
  LEGEND_DRAFTS, type LegendDraft,
  ASCENSION_UNLOCK_REQ, ascensionRewardSummary,
  maxAscensionUnlocked, bestAtOrAbove,
} from "./meta/legacy";
import { loadSetupDraft, saveSetupDraft } from "./meta/persist";
import { seniorCareerSeasonCount, seniorCareerStats, isNeutralPreview, type GameState, type Trophy, type Award, type TrophyOddsEntry, type Choice, type ChoicePreview, type ChoiceRollPreview, type Milestone, type NationalStatus } from "./engine/types";
import { sfxTap, sfxTick, sfxGood, sfxBad, sfxTrophy, sfxMilestone, sfxBoss, setSfxEnabled, setHapticsEnabled, hapticTap, hapticClick, hapticGood, hapticBad, hapticTrophy, hapticBoss, hapticMilestone } from "./engine/sfx";
import {
  TROPHY_LABEL, CONT_PRIMARY_NAME, NAT_CONT_NAME,
  confederationOfLeague, trophyLabel, TROPHY_GOLD, hasGoldTrophy, BLIND_ASCENSION,
  AWARD_LABEL, ROLE_LABEL, FAREWELL_LABEL,
  TRAIT_TONE_CLASS, personaTags, type PersonaTag,
  ovrTier, ovrTierClass, tierTitle, ratingTier, ratingTierClass, oddsTierClass,
} from "./ui/vocabulary";

/** 方向 C: the current club's league-title odds for the top bar — a persistent
 *  "how close am I to the next trophy" pull at every moment of the career. The
 *  league title is the most relatable honor; surfacing it turns the bar from a
 *  pure OVR/age meter into an honor-chase meter.
 *
 *  Returns the player's odds alongside the division's contender `ceiling` (the
 *  odds the strongest club in this league gets at a normal squad level). The
 *  chip tiers the odds RELATIVE to that ceiling (see traitToneOfOdds) so a
 *  genuine contender reads 争冠热门 even though league titles structurally never
 *  reach the 70/40% green band an absolute scale would demand — and a superstar
 *  build (captain + dynasty) can push a club above its base tier, the mud-to-
 *  marble payoff. The chip is always present while a club exists (a persistent
 *  meter); it never hides at a minnow, where the "you should climb" pull is
 *  most needed — a muted ≤0.1% chip carries that message better than silence. */
function leagueTitleOdds(game: GameState, ovr: number): { prob: number; ceiling: number } | null {
  if (game.age <= 17) return null;
  const club = game.currentClubId ? clubById(game.currentClubId) : null;
  if (!club) return null;
  const league = leagueById(club.leagueId);
  const toff = game.tournamentOffset ?? 0;
  const bare = (game.statusTags ?? []).map((t) => t.split("@")[0]!);
  const cands = clubTrophyCandidates(ovr, club, league, game.age, toff, bare.includes("captain"), bare.filter((t) => t.startsWith("combo_")));
  const prob = cands.find((c) => c.trophy === "league")?.prob ?? 0;
  return { prob, ceiling: leagueTitleCeiling(league) };
}
/** Apex 演出:巅峰时刻/词条成型的专属全屏庆祝卡。四拍编排(勋章定场→标题→
 *  数字滚动→解说词浮现)由 CSS animation-delay 驱动;数字滚动是唯一的 JS 动画
 *  (rAF + ease-out cubic,~1.1s,第三拍起滚),reduced-motion 直接显终值。
 *  点击任意处关闭走父层 onClick——演出不劫持玩家节奏。 */
const APEX_MEDAL: Record<string, string> = {
  world_cup: "🏆", ballon_dor: "🌟", ovr95: "⚡", mv100: "💎", combo: "⚜️",
};
function ApexCard({ ms, tier }: { ms: Milestone; tier: string }) {
  const stat = ms.stat;
  const from = stat?.from ?? 0;
  const [n, setN] = useState(from);
  useEffect(() => {
    if (!stat) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setN(stat.value); return; }
    let raf = 0;
    let t0 = 0;
    const dur = 1100;
    const step = (t: number) => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);   // ease-out cubic — 落定前减速的「咔哒」感
      setN(Math.round(from + (stat.value - from) * e));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    const d = setTimeout(() => { raf = requestAnimationFrame(step); }, 480);
    return () => { clearTimeout(d); cancelAnimationFrame(raf); };
    // 里程碑一旦弹出其 stat 即固定;换里程碑时重滚。
  }, [stat, from]);
  return (
    <div className="milestone-card apex-card anim-pop" data-tier={tier} data-moment={ms.moment}>
      <i className="ms-rays" aria-hidden />
      <i className="apex-sweep" aria-hidden />
      <div className="ms-medal">{APEX_MEDAL[ms.moment ?? ""] ?? "🏆"}</div>
      <p className="ms-kicker">{ms.moment === "combo" ? "词条成型" : "传奇时刻"}</p>
      <h2 className="ms-title">{ms.title}</h2>
      {ms.combo && (
        <>
          <div className="apex-fuse" aria-label={`${ms.combo.from[0]} 与 ${ms.combo.from[1]} 熔合`}>
            <span className="ptc-chip trait-muted apex-fuse-a">{ms.combo.from[0]}</span>
            <span className="apex-fuse-plus" aria-hidden>+</span>
            <span className="ptc-chip trait-muted apex-fuse-b">{ms.combo.from[1]}</span>
          </div>
          <p className="apex-effect">此后：{ms.combo.effect}</p>
        </>
      )}
      {stat && (
        <div className="apex-stat">
          <span className="apex-stat-num font-mono">{stat.prefix}{n}{stat.suffix}</span>
          <span className="apex-stat-label">{stat.label}</span>
        </div>
      )}
      {ms.commentary && <p className="apex-commentary">{ms.commentary}</p>}
      <p className="ms-age">{ms.age} 岁</p>
      <p className="ms-tap">点击继续</p>
    </div>
  );
}

/** Flag image — the real flag SVG for every nation (NATION_FLAG covers all 61).
 *  The single flag renderer: used wherever a flag leads a name (出道台国籍行、
 *  nation picker、leaderboard cards、生涯页身份栏). It replaced an emoji map that
 *  only shipped 19 glyphs and left most nations flagless. */
function FlagImg({ id, className = "flag-img" }: { id: string; className?: string }) {
  const p = nationFlagPath(id);
  return p ? <img className={className} src={p} alt="" loading="lazy" decoding="async" /> : null;
}

/** Confederation → Chinese label + the rail order (big football continents first,
 *  the two minor ones last). Drives the leaderboard's two-level nation filter. */
const CONFED_LABEL: Record<string, string> = {
  UEFA: "欧洲", CONMEBOL: "南美", AFC: "亚洲", CAF: "非洲", CONCACAF: "中北美", OFC: "大洋洲",
};
const CONFED_ORDER: readonly string[] = ["UEFA", "CONMEBOL", "AFC", "CAF", "CONCACAF", "OFC"];

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
    if (link.dailyDate) {
      // A daily link (same day or stale): play TODAY's daily with the fixed
      // daily academy (deterministic weakest club → bypass the academy event so
      // every daily player runs the SAME comparable career). Same-day links
      // carry today's seed/setup already; stale links get redirected to today.
      // The invite was "come do the daily", so this always lands on today's board.
      const ds = dailySetupFn(today);
      // Shared/daily runs are neutral (no blessings/perks/ascension, wonderkid
      // open): the whole point of a shared seed is that both phones replay the
      // SAME career — meta state on either side would break the promise.
      startRun({
        seed: dailySeed(today), nationalityId: ds.nationalityId, position: ds.position,
        leagueId: ds.leagueId, clubId: weakestClubInLeague(ds.leagueId, dailySeed(today)).id,
        blessings: [], ascension: 0,
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
  // Haptics config is global (module-level flag in sfx.ts), so sync it in the
  // always-mounted root — a toggle in the menu prefs takes effect at once,
  // before any run starts, and covers the summary screen too.
  useEffect(() => { setHapticsEnabled(store.meta.hapticsOn !== false); }, [store.meta.hapticsOn]);
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
/** 降级标记——账本行里紧跟队名的红色下箭印章。下箭由 SVG 绘制（矢量、清晰、
 *  跨字体一致），胜过字体 ↓ 字形；材质深度（顶光 + 内描边 + 投影）使其压印于行上
 *  而非平贴。降级语义由 aria-label「降级」+ 下箭形状承担，红色仅强调（色盲安全）。
 *  账本揭示时自上方坠落钉入，作降级季的震撼标点（见 index.css .lg-reveal 规则）。 */
function RelegatedMark() {
  return (
    <span className="releg-mark" title="降级" role="img" aria-label="降级">
      <svg viewBox="0 0 10 12" width="9" height="11" aria-hidden="true" focusable="false">
        <path d="M4 1H6V6.5H8.5L5 10.5L1.5 6.5H4Z" fill="currentColor" />
      </svg>
    </span>
  );
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
    <span className="award-badge trophy-badge font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gold/15 text-gold">
      <img className="trophy-badge-img" src={awardImgPath(a)} alt={AWARD_LABEL[a]} loading="lazy" decoding="async" />
      <span>{AWARD_LABEL[a]}</span>
      {n && n > 1 ? <b className="ml-0.5 opacity-80">×{n}</b> : null}
    </span>
  );
}
/** 赛季提名的图标 — 联赛 MVP / 最佳11人 是仅有的两项没有奖杯实物图的荣誉，
 *  过去 MVP 借一个 ★ 字符、最佳11人干脆空着，于是同一行里三种荣誉 chip 的高度、
 *  内边距和视觉重量都对不齐。这里给两者各画一枚 13px 的自绘图标（与
 *  `.trophy-badge-img` / `.lg-medal-img` 同尺寸、同 currentColor 分级色）：
 *  MVP = 实心星；最佳11人 = 球场框 + 中线 + 一条后防线加一个前锋的阵型点，
 *  轮廓即「首发名单」，13px 下靠剪影而非细节可读。 */
type SeasonHonor = NonNullable<GameState["seasons"][number]["seasonHonors"]>[number];
function HonorMark({ h }: { h: SeasonHonor }) {
  if (h === "mvp") {
    return (
      <svg className="honor-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 2.4l2.92 5.92 6.53.95-4.72 4.6 1.11 6.5L12 17.32l-5.84 3.07 1.11-6.5-4.72-4.6 6.53-.95z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="honor-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="5.2" y="1.8" width="13.6" height="20.4" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" opacity="0.5" />
      <path d="M5.2 12h13.6" stroke="currentColor" strokeWidth="1.3" opacity="0.32" />
      <circle cx="12" cy="7.2" r="1.9" fill="currentColor" />
      <circle cx="7.6" cy="16.8" r="1.9" fill="currentColor" />
      <circle cx="12" cy="16.8" r="1.9" fill="currentColor" />
      <circle cx="16.4" cy="16.8" r="1.9" fill="currentColor" />
    </svg>
  );
}
const HONOR_LABEL: Record<SeasonHonor, string> = { mvp: "MVP", toty: "最佳11人" };

/** 方向 A: per-club trophy odds surfaced on transfer choices — the honor axis
 *  competitors hide, rendered as a compact color-coded pill row so it reads as
 *  real odds (the “Odds are the hero” differentiator), not a wall of text.
 *  gold entries (联赛/洲际主项) lead and are bolder; silver entries (杯赛/洲际副项)
 *  trail muted. Only rendered when the choice actually carries trophy odds. */
function TrophyOddsRow({ odds, blind }: { odds: readonly TrophyOddsEntry[]; blind: OddsVeil }) {
  if (odds.length === 0) return null;
  return (
    <div className="trophy-odds-row mt-1">
      {odds.map((o, i) => {
        // 粗档下药丸本体保持中性（tier 留空）——颜色只由胶带上那个字承载，
        // 免得整枚药丸染色看起来像概率已经明示。
        const tier = blind ? "" : oddsTierClass(o.prob);
        return (
          <span key={i} className={`trophy-odds-pill ${tier} ${o.tier === "gold" ? "is-gold" : "is-silver"}`} title={`${o.label}夺冠概率`}>
            <span className="trophy-odds-lbl">🏆{o.label}</span>
            {blind
              ? <HiddenOdds className="trophy-odds-pct" label="夺冠概率已隐藏" band={blind === "band" ? o.prob : undefined} />
              : <span className="trophy-odds-pct">{Math.round(o.prob * 1000) / 10}%</span>}
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

/** Boss/climax showdowns carry no `rarity` in the engine (they're triggered,
 *  not drawn from the weighted pool), so the rarity-based special frame would
 *  never reach them. These three keys are elevated to `legendary` for the
 *  decision dock's visual tier — a presentation signal only, no engine change.
 *  A World Cup final is the career's apex; it must not render as a plain
 *  common frame. */
const BOSS_DOCK_KEYS = new Set(["world_cup_showdown", "world_cup_qualifier_showdown", "continental_cup_showdown"]);

/** The decision dock's visual tier — common / rare / legendary — drives the
 *  framed card's tint, lighting and trim so the frame's weight matches the
 *  event's weight. Derived from the event's rarity plus the boss-key elevation
 *  above. Pure presentation; does not touch odds, weights, or resolve. */
function dockTierOf(rarity: "common" | "rare" | "legendary" | undefined, key: string | undefined): "common" | "rare" | "legendary" {
  if (rarity === "legendary" || (key !== undefined && BOSS_DOCK_KEYS.has(key))) return "legendary";
  if (rarity === "rare") return "rare";
  return "common";
}

/** 三态判决字形：▲ 赢面 / ◆ 有得有失 / ▼ 失手。三重编码（字形+颜色+判词），
 *  与 ▲/▼ 同为几何字形家族，色盲可辨。 */
const TONE_GLYPH = { good: "▲", mixed: "◆", bad: "▼" } as const;

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

/** Color the ★ segment inside a dot-separated sub line. Transfer options read
 *  "联赛 · ★★★★ · 主力" and the ★ run is always its own segment, so a pure-★
 *  match picks up the tier color while the rest keeps the parent's muted hue. */
function renderSubWithStars(sub: string, blind: OddsVeil = false) {
  return sub.split(" · ").map((seg, i) => (
    <Fragment key={i}>
      {i > 0 && " · "}
      {/^★+$/.test(seg) ? <span className={starTierClass(seg.length)}>{seg}</span> : redactOdds(seg, blind)}
    </Fragment>
  ));
}

/** 叙事高亮 —— key figures inside diegetic prose (评分/身价/年龄/比分…) are set
 *  in the scoreboard's numeral voice (bright + heavy + tabular) so the fact the
 *  world is quoting jumps out of the muted narration. Neutral emphasis only:
 *  good/bad valence stays with the surrounding words, never with the numeral.
 *  分钟 is excluded so "第 78 分钟" doesn't half-match as a rating. */
const PROSE_STAT_RE = /\d+(?:\.\d+)? ?(?:[万亿]欧?|分(?!钟)|岁|天|场|球|次|号|年|家|连冠|%)|\d+ ?[-:] ?\d+/g;
function Prose({ text, className, blind = false }: { text: string; className?: string; blind?: OddsVeil }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(PROSE_STAT_RE)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(blind && m[0].endsWith("%")
      ? <HiddenOdds key={m.index} />
      : <em key={m.index} className="prose-stat">{m[0]}</em>);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <p className={className}>{parts}</p>;
}

/** The branch pills. `cursor` turns the list into the结算跑马灯: the pill under
 *  the cursor is lit, the rest recede, and `landed` marks the branch that
 *  actually fired. Same pills the player read before choosing — the reveal
 *  happens on the odds themselves, not in a separate widget. */
/** Format a 0..1 probability as the odds string. Honors the oracle blessing's
 *  1-decimal precision so a cluster label never disagrees with the headline
 *  odds elsewhere (matches engine `pct` exactly — single source of truth would
 *  be nicer, but `pct` is engine-internal and the UI already mirrors its math
 *  for the Odds bar). */
function fmtOdds(x: number, oracle: boolean): string {
  return `${oracle ? Math.round(x * 1000) / 10 : Math.round(x * 100)}%`;
}

/** 情报封锁下概率的可见度。
 *
 *  `false` 明示 · `"full"` 全遮蔽 · `"band"` 只露粗档（先知之眼）。
 *
 *  收敛成一个联合类型而不是再加一个 oracle prop：`blind` 已经穿过 8 个组件，
 *  所有 `blind ? …` 的真值判断在联合类型下原样成立，只有真正拿得到数值的
 *  四处需要加分支。多一个并行 prop 迟早会在某处漏传，两个真相就此分叉。 */
type OddsVeil = false | "full" | "band";

/** 封锁下的粗档。阈值与 oddsTierClass 完全一致——全局只有一套 tier 心智模型，
 *  所以同一个概率在封锁前后落在同一档、同一个颜色，玩家不用学第二套刻度。 */
function oddsBand(x: number): { glyph: string; tier: string; label: string } {
  if (x >= 0.7) return { glyph: "高", tier: "tier-good", label: "成功概率偏高" };
  if (x >= 0.4) return { glyph: "中", tier: "tier-warn", label: "成功概率中等" };
  return { glyph: "低", tier: "tier-danger", label: "成功概率偏低" };
}

/** 被黑胶带贴住的概率。先知之眼不撕胶带，只在胶带上写一个字——你有线人，
 *  但没有档案。带 band 时沿用同一个盒子尺寸，封锁/粗档切换不重排。 */
function HiddenOdds({ className, label = "概率已隐藏", band }: {
  className?: string; label?: string; band?: number;
}) {
  const b = band == null ? null : oddsBand(band);
  if (!b) return <span className={`redact${className ? ` ${className}` : ""}`} aria-label={label} />;
  return (
    <span className={`redact redact-band ${b.tier}${className ? ` ${className}` : ""}`} aria-label={b.label}>
      {b.glyph}
    </span>
  );
}

/** A success-rate numeral, or a black-taped placeholder under 情报封锁
 *  (先知之眼 leaves the coarse band showing). */
function OddsNum({ x, oracle, blind }: { x: number; oracle: boolean; blind: OddsVeil }) {
  if (blind) return <HiddenOdds className="oc-odds" label="成功概率已隐藏" band={blind === "band" ? x : undefined} />;
  return <b className="oc-odds">{fmtOdds(x, oracle)}</b>;
}

/** Replace probability numerals embedded in any string with an empty visual
 *  placeholder. The number is intentionally absent from the blind DOM. */
const ODDS_NUM_RE = /\d+(?:\.\d+)?%/g;
function redactOdds(text: string, blind: OddsVeil): React.ReactNode {
  if (!blind) return text;
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(ODDS_NUM_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    // 文案里内嵌的百分比**不**降级为粗档：这条正则匹配的是任意 `\d+%`，
    // 里面既有成功概率，也有「传承 +18%」「进球率 +25%」这类完全不是概率的
    // 数字。遮蔽它们无害（只是藏起来），但给它们标一个「高/中/低」是在断言
    // 一个假语义。粗档只出现在 UI 明确标注为概率的槽位（OddsNum /
    // TrophyOddsRow / 夺冠 chip），那里的数值来源确定。
    out.push(<HiddenOdds key={m.index} />);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/** One effect pill. `idx` is the pill's CLUSTER index (0 = 成功支, 1 = 失败支);
 *  the marquee cursor sweeps the two clusters (not each pill — one roll decides a
 *  whole branch, so the whole combo lights together), so a pill dims unless its
 *  cluster is the cursor/landed one. Certain pills (idx === undefined) are never
 *  dimmed — they happen regardless of the dice, so they stay lit as the baseline. */
function Pill({ p, idx, cursor, landed }: {
  p: ChoicePreview; idx?: number; cursor?: number; landed?: boolean;
}) {
  const flat = isNeutralPreview(p.label);
  const cls = idx === undefined || cursor === undefined
    ? ""
    : idx !== cursor ? " is-dimmed" : landed ? " is-landed" : " is-cursor";
  return (
    <span className={`oc-pill ${flat ? "is-flat" : p.good ? "is-good" : "is-bad"}${cls}`}>
      <IconTrend dir={flat ? "flat" : p.good ? "up" : "down"} />
      <span className="oc-pill-lbl">{p.label}</span>
    </span>
  );
}

const EMPTY_PREVIEW: readonly ChoicePreview[] = [];

/** The effects preview for an option, split into a guaranteed 必定 zone and a
 *  probabilistic 成功/失败 fork. This is the fix for the IA bug where a no-%
 *  pill (a guaranteed effect like 为国出征, or a branch co-effect like
 *  坐稳主力) sat between two % pills and read as a standalone roll outcome:
 *  guaranteed effects now live in a labelled 必定 zone with no percentage, and
 *  each roll branch is scoped by its own 成功/失败 % label so every pill under
 *  it is unambiguously part of that branch. The marquee cursor sweeps the roll
 *  fork only; certain pills stay lit (they always happen). */
/** 利好优先扫读：同一选项卡上利好永远排在利空前面——跨卡扫读位一致，
 *  玩家形成稳定反射（Operate 的 earned familiarity）。引擎 previewLabel 的顺序
 *  是按后果类型排的（OVR→奖杯→roleShift…），同一类型序在不同选项上会读出
 *  相反的利弊序，所以这一层排序留在 UI 侧、不动引擎语义。V8 sort 稳定 → 同
 *  利弊内保持引擎原序，确定性不破；中性药丸(无变化/无额外后果, good:true)归中性档，免被塞进
 *  利好堆。跑马灯 idx 是数组位置、落点按分支(win/lose 全支)只认分支不认
 *  利弊，故扫换与落点对齐 lastOutcomeGood 的逻辑不受排序影响。 */
const valenceRank = (p: ChoicePreview): number =>
  isNeutralPreview(p.label) ? 1 : p.good ? 0 : 2;
const byValence = (ps: readonly ChoicePreview[]): readonly ChoicePreview[] =>
  ps.length < 2 ? ps : ps.slice().sort((a, b) => valenceRank(a) - valenceRank(b));

function summarizeInjuryEffects(previews: readonly ChoicePreview[]): readonly ChoicePreview[] {
  const visible = previews.filter((preview) => preview.label !== "伤病");
  const hasSevereInjury = visible.some((preview) => preview.label === "重伤");
  const hasLastingRisk = visible.some((preview) => preview.label === "带伤隐患");
  const normalized = hasSevereInjury && hasLastingRisk
    ? [...visible.filter((preview) => preview.label !== "重伤" && preview.label !== "带伤隐患"),
        { label: "重伤留患", good: false }]
    : visible;
  const groups = [
    normalized.filter((preview) => !isNeutralPreview(preview.label) && preview.good),
    normalized.filter((preview) => isNeutralPreview(preview.label)),
    normalized.filter((preview) => !preview.good),
  ].filter((group) => group.length > 0);

  return groups.map((group) => {
    const ovr = group.filter((preview) => preview.label.endsWith(" OVR"));
    const other = group.filter((preview) => !preview.label.endsWith(" OVR"));
    const labels = ovr.length > 1
      ? [`OVR ${ovr.map((preview) => preview.label.slice(0, -4)).join(" / ")}`, ...other.map((preview) => preview.label)]
      : group.map((preview) => preview.label);
    return { label: labels.join(" · "), good: group[0]!.good };
  });
}

function OptionEffects({ c, oracle, blind, cursor, landed }: {
  c: Choice; oracle: boolean; blind: OddsVeil; cursor?: number; landed?: boolean;
}) {
  const summarize = c.effectsLayout === "summary" ? summarizeInjuryEffects : byValence;
  const certain = summarize(c.certain ?? EMPTY_PREVIEW);
  const fork: ChoiceRollPreview | undefined = c.roll;
  if (certain.length === 0 && !fork) return null;
  const win = fork ? summarize(fork.win) : EMPTY_PREVIEW;
  const lose = fork ? summarize(fork.lose) : EMPTY_PREVIEW;
  return (
    <div className="oc-effects">
      {certain.length > 0 && (
        <div className="oc-group oc-group-certain">
          <span className="oc-group-label">必定发生</span>
          <span className="oc-pills">
            {certain.map((p, i) => <Pill key={i} p={p} cursor={cursor} landed={landed} />)}
          </span>
        </div>
      )}
      {fork && (
        <div className="oc-group oc-group-roll">
          <span className="oc-cluster">
            <span className="oc-cluster-label">成功<OddsNum x={fork.winProb} oracle={oracle} blind={blind} /></span>
            <span className="oc-pills">
              {win.map((p, i) => <Pill key={i} p={p} idx={0} cursor={cursor} landed={landed} />)}
            </span>
          </span>
          <span className="oc-cluster">
            <span className="oc-cluster-label">失败<OddsNum x={1 - fork.winProb} oracle={oracle} blind={blind} /></span>
            <span className="oc-pills">
              {lose.map((p, i) => <Pill key={i} p={p} idx={1} cursor={cursor} landed={landed} />)}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
function OptionCard({ c, blind, oracle, onPick, dataRoll, rollState }: {
  c: Choice; blind: OddsVeil; oracle: boolean; onPick: () => void;
  dataRoll?: "picked" | "dim"; rollState?: { cursor: number; landed: boolean };
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
  // A rolled option's % now lives on the 成功/失败 cluster labels, so a pure-%
  //  sub is suppressed as noise; an authored sub (e.g. 让位 · 传承 +8 on a
  //  deterministic option) survives only when there is no effects preview.
  const hasEffects = !!(c.certain?.length || c.roll);
  const bare = !c.sub || /^\d+(\.\d+)?%$/.test(c.sub) || hasEffects;
  const specs = bare ? [] : c.sub!.split(" · ").filter((s) => s && s !== league?.name && s !== club?.name);
  return (
    <button className="option-card" data-kind={club ? "club" : "fate"} data-effects-layout={c.effectsLayout} data-roll={dataRoll} disabled={!!dataRoll} onClick={onPick}>
      {club ? (
        <>
          <span className="oc-verb">{OFFER_VERB[c.kind] ?? "前往"}</span>
          <span className="oc-name">{club.name}</span>
          <Crest path={clubCrestPath(club.id)} alt="" size={40} imgClass="oc-crest"
            fallback={<MonoCrest clubId={club.id} label={club.name.slice(0, 1)} size={40} />} />
        </>
      ) : (
        <span className="oc-name oc-name-fate">{redactOdds(c.text, blind)}</span>
      )}
      {specs.length > 0 && (
        <span className="oc-specs">{specs.map((s, i) => <span key={i} className={/^★+$/.test(s) ? starTierClass(s.length) : undefined}>{redactOdds(s, blind)}</span>)}</span>
      )}
      {hasEffects && (
        <OptionEffects c={c} oracle={oracle} blind={blind}
          cursor={rollState?.cursor} landed={rollState?.landed} />
      )}
      {c.trophyOdds && <TrophyOddsRow odds={c.trophyOdds} blind={blind} />}
      {league && (
        <span className="oc-league">
          <Crest path={leagueLogoPath(league.id)} alt="" size={13} imgClass="oc-league-logo" fallback={null} />
          {league.name}
        </span>
      )}
    </button>
  );
}

function DecisionBoard({ choices, blind, oracle, onPick, roll }: {
  choices: readonly Choice[]; blind: OddsVeil; oracle: boolean; onPick: (id: string) => void;
  roll?: { pickedId: string; cursor: number; landed: boolean } | null;
}) {
  const offers = choices.filter((c) => !BASELINE_KINDS.has(c.kind));
  const baseline = choices.filter((c) => BASELINE_KINDS.has(c.kind));
  // 跑马灯期间整板锁定（不可再点）：选中的牌点亮、其余压暗，布局原位不动。
  const locked = !!roll;
  // Past three columns the cards stop being comparable at thumb width, so a
  // long enumerated decision (降薪报价、告别名单) keeps the scannable row list.
  if (offers.length === 0 || offers.length > 3) {
    return (
      <div className="deck-options" data-locked={locked ? "" : undefined}>
        {choices.map((c) => (
          <button key={c.id} className="option" data-roll={roll ? (c.id === roll.pickedId ? "picked" : "dim") : undefined} disabled={locked} onClick={() => onPick(c.id)}>
            <span className="option-lead">
              {c.clubId && <Crest path={clubCrestPath(c.clubId)} alt={c.text} size={22} imgClass="opt-crest" />}
              <span className="font-semibold">
                {redactOdds(c.text, blind)}
                {c.sub && <span className="block font-normal text-[10px] leading-snug text-muted mt-0.5">{renderSubWithStars(c.sub, blind)}</span>}
                {c.trophyOdds && <TrophyOddsRow odds={c.trophyOdds} blind={blind} />}
              </span>
            </span>
            <span className="option-go"><IconChevron dir="right" /></span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="deck-options" data-locked={locked ? "" : undefined}>
      <div className="option-board" data-cols={offers.length}>
        {offers.map((c) => (
          <OptionCard key={c.id} c={c} blind={blind} oracle={oracle} onPick={() => onPick(c.id)}
            dataRoll={roll ? (c.id === roll.pickedId ? "picked" : "dim") : undefined}
            rollState={roll && c.id === roll.pickedId ? { cursor: roll.cursor, landed: roll.landed } : undefined} />
        ))}
      </div>
      {baseline.map((c) => {
        const club = c.clubId ? clubById(c.clubId) : undefined;
        return (
          <button key={c.id} className="option option-baseline" data-roll={roll ? (c.id === roll.pickedId ? "picked" : "dim") : undefined} disabled={locked} onClick={() => onPick(c.id)}>
            <span className="option-lead">
              {club && <Crest path={clubCrestPath(club.id)} alt="" size={22} imgClass="opt-crest" fallback={<MonoCrest clubId={club.id} label={club.name.slice(0, 1)} size={22} />} />}
              <span className="font-semibold">
                {redactOdds(c.text, blind)}
                {c.sub && <span className="block font-normal text-[10px] leading-snug text-muted mt-0.5">{renderSubWithStars(c.sub, blind)}</span>}
                {c.trophyOdds && <TrophyOddsRow odds={c.trophyOdds} blind={blind} />}
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
  const dim = size === "lg" ? { w: 72, h: 72, n: 32 } : size === "sm" ? { w: 38, h: 38, n: 17 } : { w: 56, h: 56, n: 24 };
  return (
    <div className={`ovr-badge foil-${ovrTier(ovr)}`} data-tier={ovrTier(ovr)} style={{ width: dim.w, height: dim.h }}>
      <span className="ob-label" style={size === "sm" ? { fontSize: 7 } : undefined}>{label}</span>
      <span className="ob-num" style={{ fontSize: dim.n }}>{ovr}</span>
    </div>
  );
}

function YouthTeamTag() {
  return <span className="youth-team-tag">青年队</span>;
}

function SeasonRow({ s, fresh = false, position, seed, natConf, continuation = false }: { s: GameState["seasons"][number]; fresh?: boolean; position?: Position; seed?: string; natConf?: string; continuation?: boolean }) {
  const group: RoleGroup = position ? ROLE_GROUP[position] : "attacker";
  const rating = seasonRating(s, position);
  const hl = s.squadLevel === "youth" ? null : seasonHighlight(s, seed, group);
  const q = seasonQuote(s, rating);
  const peak = signaturePeak(s, position);
  return (
    <div className={`season-row ${fresh ? "anim-slide" : ""}`}>
      <span className="sr-age">{s.age}</span>
      <div className="sr-body">
        <div className="sr-top">
          <span className="sr-club">
            <span className="sr-club-name">{s.clubName}</span>
            {s.squadLevel === "youth" && <YouthTeamTag />}
            {s.relegated && <RelegatedMark />}
          </span>
          <span className="sr-nums">
            <span className={`sr-ovr ${ovrTierClass(s.overall)}`}>{s.overall}</span>
            {rating !== null && <span className={`sr-rating ${ratingTierClass(rating)}`}>{rating.toFixed(1)}</span>}
          </span>
        </div>
        <div className="sr-meta">
          {s.squadLevel === "youth" ? "青年联赛" : s.leagueName} · {ROLE_LABEL[s.role] ?? s.role}
          <span className="sr-stats"> · {seasonStatChips(s, group, continuation)}</span>
          {s.marketValue !== undefined && s.marketValue > 0 && (
            <span className="sr-mv"> · 身价€{s.marketValue >= 1 ? `${s.marketValue}M` : `${Math.round(s.marketValue * 1000)}K`}</span>
          )}
        </div>
        {hl && <div className="sr-highlight">⚽ {hl}</div>}
        {q && <div className="sr-quote">“{q}”</div>}
        {(peak || s.trophies.length > 0 || s.awards.length > 0 || s.nationalTournaments.length > 0 || (s.seasonHonors ?? []).length > 0) && (
          <div className="sr-honors">
            {peak && (
              <span className="trophy-badge font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded sig-peak" aria-label={`${peak.label} ${peak.value}${peak.unit}`}>
                <span className="sp-label">{peak.label}</span><span className="sp-num">{peak.value}{peak.unit}</span>
              </span>
            )}
            {s.trophies.map((t, i) => <TrophyBadge key={i} t={t} conf={confederationOfLeague(s.leagueId)} leagueId={s.leagueId} />)}
            {s.awards.map((a, i) => <AwardBadge key={`a${i}`} a={a} />)}
            {s.nationalTournaments.map((nt, i) => <TrophyBadge key={`n${i}`} t={nt.trophy} conf={confederationOfLeague(s.leagueId)} leagueId={s.leagueId} natConf={natConf} />)}
            {(s.seasonHonors ?? []).map((h, i) => (
              <span key={`h${i}`} className={`trophy-badge font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded ${h === "mvp" ? "bg-gold/20 text-gold" : "bg-accent/12 text-accent"}`}><HonorMark h={h} /><span>{HONOR_LABEL[h]}</span></span>
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

/** P-A11: a coach/media one-line verdict per season, derived from rating +
 *  role + stats. Gives each season a "被评说" texture — the fan-talk layer. */
function seasonQuote(s: GameState["seasons"][number], rating: number | null): string | null {
  if (rating === null) return null;
  if (s.squadLevel === "youth") return null;
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

/** 一季揭示仪式的落幕时刻（ms）——驱动自动节拍：下一季 / 下一事件得等这季的
 *  仪式走完 + 一个呼吸（REVEAL_BREATH_MS）才进场，不被上一段动画的尾巴压住
 *  （节奏感，不局促）。无荣誉：评分盖章 0.62s + 0.3s = 920ms。有荣誉：第二拍
 *  行撑开(1.08s)后奖杯逐枚写进，末枚 1.44s + (n-1)·40ms（n≥6 封顶 1.64s）+ 0.3s。
 *  数值与 index.css 的 .lg-reveal 编排同步——改那边需同步此处。 */
function revealFinishMs(s: GameState["seasons"][number]): number {
  const haul = s.trophies.length + s.awards.length + (s.seasonHonors?.length ?? 0);
  if (haul === 0) return 920;
  const n = Math.min(haul, 6);
  return 1440 + (n - 1) * 40 + 300;
}
/** 这季是否带荣誉行——与 LedgerHaul 渲染门 `honors > 0` 同口径，决定揭示走
 *  两拍(有，奖杯仪式)还是一拍(无)，进而决定下一事件要不要等仪式落幕。 */
function seasonHasHaul(s: GameState["seasons"][number]): boolean {
  return s.trophies.length + s.awards.length + (s.seasonHonors?.length ?? 0) > 0;
}
/** 揭示节拍（ms）。BREATH = 改前 haul 季的余韵（1500−1040≈460），让加长后的
 *  奖杯仪式落幕仍留与原先一致的呼吸；INTER/FIRST/ADVANCE 是原基线，无荣誉季
 *  不回退（max 兜底），只补回被加长仪式吃掉的拍。 */
const REVEAL_BREATH_MS = 460;
const REVEAL_INTER_MS = 1500;
const REVEAL_FIRST_MS = 700;
const REVEAL_ADVANCE_MS = 900;

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
  const seniorSeasons = seniorCareerSeasonCount(game.seasons);
  const wc = game.seasons.find((s) => s.nationalTournaments.some((n) => n.trophy === "world_cup"));
  if (wc && game.player) return `${from}，${wc.age}岁率${nationName(game.player.nationalityId)}捧起大力神杯`;
  const bd = game.seasons.find((s) => s.awards.includes("ballon_dor"));
  if (bd) return `${from}，${bd.age}岁加冕金球先生`;
  const cp = game.seasons.find((s) => s.trophies.includes("continental_primary"));
  if (cp) return `${from}，${cp.age}岁登顶${CONT_PRIMARY_NAME[confederationOfLeague(cp.leagueId)] ?? "洲际之巅"}`;
  const lg = game.seasons.find((s) => s.trophies.includes("league"));
  if (lg) return `${from}，${lg.age}岁首夺联赛冠军`;
  if (game.trophies.length === 0 && seniorSeasons >= 8) return `${from}，征战 ${seniorSeasons} 个赛季，无冕却未曾停下`;
  return `${from}，${game.age}岁挂靴，巅峰 OVR ${game.maxOverall}`;
}
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
/** 续停检测 — 杠杆1 后一次禁赛只停本期第一季(seasonInPeriod===0), 同期内不会再有
 *  续停; 只有跨期连续两季都停赛(主要是 long 节奏, normal/express 下几乎不可能)
 *  才显「停赛延续」: 当前季停赛且上一季也停赛。区分「连续两期各一次禁赛」与「单次
 *  禁赛」, 让账本/档案读得懂因果。纯渲染派生，不读引擎。 */
function suspensionContinuationAges(seasons: GameState["seasons"]): Set<number> {
  const cont = new Set<number>();
  for (let i = 1; i < seasons.length; i++) {
    if (seasons[i]!.suspended && seasons[i - 1]!.suspended) {
      cont.add(seasons[i]!.age);
    }
  }
  return cont;
}

/** Position-aware stat chips — the role's current-season data, always visible
    (was hidden on mobile). Tells the right football story per position: a CB's
    clean sheets, a GK's goals conceded, a striker's goals. */
function seasonStatChips(s: GameState["seasons"][number], group: RoleGroup, continuation = false): string {
  if (s.suspended) return continuation ? "停赛延续" : "停赛";
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

/** P-POS 位置平衡·可见性: 一个赛季的「招牌巅峰」—— 位置招牌数据跨过精英线
 *  (SIGNATURE_ELITE) 时返回 chip 素材, 否则 null。这是非前锋与中锋 9.0 评分
 *  同等的可见上限信号: 后卫 17 零封、组织 18 助攻、前锋 28 球都亮一枚金箔 chip,
 *  与评分/奖杯并排。青年赛季/停赛季/0 出场季不评 (没踢不评巅峰)。门槛与
 *  run.ts MVP statGreat 同源 (goals≥28/cleanSheets≥17), 零漂移。 */
function signaturePeak(s: GameState["seasons"][number], position?: Position): { label: string; value: number; unit: string } | null {
  if (!position || s.squadLevel === "youth" || s.suspended || s.stats.appearances === 0) return null;
  const stat = signatureStatOf(position);
  const value = stat === "goals" ? s.stats.goals : stat === "assists" ? s.stats.assists : s.stats.cleanSheets;
  if (value < SIGNATURE_ELITE[stat]) return null;
  const label = stat === "goals" ? "射手巅峰"
    : stat === "assists" ? "助攻巅峰"
    : position === "GK" ? "门神巅峰" : "防线巅峰";
  const unit = stat === "cleanSheets" ? "零封" : stat === "assists" ? "助" : "球";
  return { label, value, unit };
}

/** 生涯总结的招牌巅峰行: 生涯最高招牌数据 + (跨过精英线时) 位置称号。每段生涯
 *  都有「最佳一季的招牌产出」, 故永远显示; 称号 (钢铁防线/助攻王/金靴级/
 *  一夫当关) 只在跨过精英线时才给, 避免给一个 3 零封的生涯错配「钢铁防线」。 */
function careerSignaturePeak(position: Position, seasons: readonly GameState["seasons"][number][]): { value: number; unit: string; title: string | null } {
  const stat = signatureStatOf(position);
  let value = 0;
  for (const s of seasons) {
    if (s.squadLevel === "youth") continue;
    const v = stat === "goals" ? s.stats.goals : stat === "assists" ? s.stats.assists : s.stats.cleanSheets;
    if (v > value) value = v;
  }
  const unit = stat === "cleanSheets" ? "零封" : stat === "assists" ? "助" : "球";
  const title = value >= SIGNATURE_ELITE[stat]
    ? (stat === "goals" ? "金靴级" : stat === "assists" ? "助攻王" : position === "GK" ? "一夫当关" : "钢铁防线")
    : null;
  return { value, unit, title };
}
function nationName(id: string): string {
  return NATIONS.find((n) => n.id === id)?.name ?? id;
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
  const horizon = projectedRetireAge(p, club, game.statusTags ?? [], game.severeInjuries ?? 0, game.blessings ?? [], game.permPerks ?? [], game.ascension);
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
    <header className="app-header" data-prestige={meta.prestige > 0 ? "" : undefined}>
      {/* 球场记分牌:柜体悬浮于夜空,顶部泛光从上方洒下,比分段是凹陷的背光格,
          数字像 LED 在发光。轮回≥1 整座镀金(mud→marble,与英雄卡 foil 同源)。
          图标是足球语义矢量描边(与记分牌同源材质),不是 RPG 宝石/金币:logo=足球徽章·
          传承=青训接力·最佳=金球·飞升=天梯·轮回=循环重生。材质见 index.css
          .app-header(柜体+泛光)/.hdr-stats .hs(背光格+LED 光晕)。 */}
      <div className="sb-row">
        <div className="sb-plate">
          <ScoreBall size={20} className="sb-mark" />
          <h1 className="wordmark">绿茵轮回</h1>
        </div>
        <div className="hdr-stats">
          <span className="hs"><span className="hs-head"><ScoreLegacy size={14} className="hs-ico" /><span className="hs-lbl">传承</span></span><span className="hs-val">{meta.totalLegacy}</span></span>
          <span className="hs"><span className="hs-head"><ScoreBest size={14} className="hs-ico" /><span className="hs-lbl">最佳</span></span><span className="hs-val">{meta.bestRun}</span></span>
          <span className="hs"><span className="hs-head"><ScoreAscension size={14} className="hs-ico" /><span className="hs-lbl">飞升</span></span><span className="hs-val">{meta.ascension}</span></span>
          {meta.prestige > 0 && (
            <span className="hs hs-gold"><span className="hs-head"><ScoreCycle size={14} className="hs-ico" /><span className="hs-lbl">轮回</span></span><span className="hs-val">{meta.prestige}</span></span>
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
  const { meta, startRun, newSeed, dailySeed, lastSetup, buyBlessing, setLoadout, setAscension, archive, clearArchive, prestige, daily, dailyStreak, toggleSound, toggleHaptics, loginBonus, addLegacy } = store;
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
  // 种子/种子模式本身不持久化：随机模式应「每次刷新掷新种」，而残留的「指定」
  // 模式会让刷新后的每一局都静默不结算——见 loadSetupDraft 注释。
  const [seedMode, setSeedMode] = useState<"random" | "custom">(PENDING_LINK.seed ? "custom" : "random");
  // 持久化的「初舞台草稿」(姓名/号码/国籍/位置/青训队/节奏)：刷新页面后菜单不再
  // 重置为默认，而是恢复玩家上次正在编辑的配置。优先级：分享链接 > 草稿 > 上局
  // setup > 默认。每个字段都校验（数据变动后旧草稿失效则回退）。
  const draft = loadSetupDraft();
  const draftNat = draft && NATIONS.some((n) => n.id === draft.nationalityId) ? draft.nationalityId : undefined;
  const draftName = draft?.playerName;
  const draftNum = draft && draft.squadNumber !== null && Number.isInteger(draft.squadNumber) && draft.squadNumber >= 1 && draft.squadNumber <= 99 ? draft.squadNumber : undefined;
  const draftPos = draft && ALL_POSITIONS.includes(draft.position) ? draft.position : undefined;
  const draftPace = draft && VALID_PACE.includes(draft.pace) ? draft.pace : undefined;
  const [nat, setNat] = useState(PENDING_LINK.link?.nationalityId ?? draftNat ?? lastSetup?.nationalityId ?? "chn");
  const [playerName, setPlayerName] = useState(PENDING_LINK.link?.playerName ?? draftName ?? lastSetup?.playerName ?? "");
  // 名字是否派生自种子（🎲 种子名按钮）而非亲手输入。派生名不写进草稿——种子
  // 每次刷新重掷（随机模式刻意不持久化种子），把派生名冻结成字符串会留下死快照：
  // 刷新后名字不再跟随新种子（用户反馈「用了种子名，刷新后还是之前的名字」）。
  // 派生名在种子/国籍变动时自动重新生成，草稿只存亲手输入的自定义名（存空=按种子生成）。
  const [nameDerived, setNameDerived] = useState(false);
  const [squadNumber, setSquadNumber] = useState<number | null>(PENDING_LINK.link?.squadNumber ?? draftNum ?? lastSetup?.squadNumber ?? null);
  const [pos, setPos] = useState<Position>(PENDING_LINK.link?.position ?? draftPos ?? lastSetup?.position ?? "ST");
  // 青训队伍不再在菜单选择——进入生涯后由「青训抉择」首事件决定（见 engine
  // academyChoiceEvent）。联赛由国籍推断（homeLeagueOf），故菜单不再持有 club 状态。
  const [pace, setPace] = useState<PaceMode>(PENDING_LINK.link?.pace ?? draftPace ?? (lastSetup?.pace as PaceMode) ?? "normal");
  // 种子/国籍一变，派生名跟着重新生成——名字跟随种子，而不是冻结旧值。
  useEffect(() => {
    if (nameDerived) setPlayerName(generatePlayerName(seed, nat));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, nat]);
  // 菜单草稿实时持久化：任意字段变动即写回 localStorage，刷新即可恢复。
  // 派生名不落盘：存空，让「按种子生成」的兜底在刷新后跟随新种子。
  useEffect(() => {
    saveSetupDraft({
      nationalityId: nat, position: pos, pace,
      playerName: nameDerived ? "" : playerName,
      squadNumber,
    });
  }, [nat, pos, pace, playerName, squadNumber, nameDerived]);
  // Anything that is not "start the career I just configured" lives on the sheet
  // plane. The play tab is one screen — the console, and doors to the rest.
  const [sheet, setSheet] = useState<null | "daily" | "drafts" | "ranking" | "prefs">(null);
  const [rankingTab, setRankingTab] = useState<RankingTab>("server");
  const closeSheet = useCallback(() => setSheet(null), []);
  const openRanking = useCallback((t: RankingTab) => { setRankingTab(t); setSheet("ranking"); }, []);
  // 装备制在祝福商店里配置(resolveLoadout/SET_LOADOUT);出发时读当前装配。
  const allowWonderkid = isUnlocked(meta, "profile:wonderkid");
  // 联赛由国籍推断（母国顶级联赛，无则同洲青训强队联赛）；青训球队进入生涯后选。
  // 派生名不随 setup 传入——留空让 createRun 按该局真实种子生成，名字永远跟随种子。
  const begin = () => startRun({ seed, nationalityId: nat, position: pos, leagueId: homeLeagueOf(nat).id, blessings: resolveLoadout(meta), ascension: meta.ascension, pace, permPerks: meta.permPerks, allowWonderkid, playerName: nameDerived ? undefined : playerName.trim() || undefined, squadNumber: squadNumber ?? undefined, customSeed: seedMode === "custom" });

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
    // 青训抉择:每日固定青训球队(确定性最弱队,即旧默认),绕过青训事件——
    // 否则每人各选一家青训,生涯即分穻,每日榜单不可比。与旧每日字节一致。
    startRun({ seed: todaysSeed, nationalityId: ds.nationalityId, position: ds.position, leagueId: ds.leagueId, clubId: weakestClubInLeague(ds.leagueId, todaysSeed).id, blessings: [], ascension: 0, pace: "normal", permPerks: [], allowWonderkid: true, dailyDate: today, playerName: nameDerived ? undefined : playerName.trim() || undefined, squadNumber: squadNumber ?? undefined });
  };
  const startDraft = (d: LegendDraft) => {
    setSheet(null);
    // 剧本承诺"固定 seed = 确定的戏剧弧线",meta 状态会打破它——同样中和。
    // 青训抉择:剧本固定青训球队(确定性最弱队,即旧默认),绕过青训事件——
    // 剧本的戏剧弧线预设了起始俱乐部,玩家自选会打破它。与旧剧本字节一致。
    startRun({ seed: d.seed, nationalityId: d.nationalityId, position: d.position, leagueId: d.leagueId, clubId: weakestClubInLeague(d.leagueId, d.seed).id, blessings: [], ascension: 0, pace: d.pace, permPerks: [], allowWonderkid: true });
  };
  // 我也要玩:读榜单记录的种子+身份开一局。customSeed 语义即全部保障——
  // 不结算 meta、不上传榜单(见 api/leaderboard.ts),是邀请而非刷分口。
  // 祝福/声望中和(记录未携带),升华取记录值以还原当局难度;青训不锁——
  // 与自定义种子控制台同语义,青训抉择仍是玩家的第一个决策。
  const startFromRecord = (e: LeaderboardEntry) => {
    setSheet(null);
    startRun({ seed: e.seed, nationalityId: e.nationalityId, position: e.position as Position, leagueId: e.leagueId || homeLeagueOf(e.nationalityId).id, blessings: [], ascension: e.ascension, pace: (e.pace as PaceMode) || "normal", permPerks: [], allowWonderkid: true, playerName: e.name, customSeed: true });
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

      {/* The play tab's promise lives in the console head; the other tabs
          name themselves above their content. The blessings tab is a
          self-titled showcase panel (祝福商店 in its head strip), so it skips
          the outer per-tab h2 the other document tabs carry. */}
      {tab !== "play" && tab !== "blessings" && <h2 className="text-[18px] font-bold tracking-tight m-0">{TAB_TITLE[tab]}</h2>}

      {tab === "play" && (
        <>
          {/* The one primary object on this surface. */}
          <DebutConsole
            meta={meta} newSeed={newSeed} dailySeed={dailySeed}
            seed={seed} setSeed={setSeed} seedMode={seedMode} setSeedMode={setSeedMode}
            nat={nat} setNat={setNat} pos={pos} setPos={setPos}
            pace={pace} setPace={setPace}
            playerName={playerName} setPlayerName={setPlayerName} setNameDerived={setNameDerived}
            squadNumber={squadNumber} setSquadNumber={setSquadNumber}
            onStart={begin}
          />

          <ModeBand
            dailyLegacy={todaysResult?.legacy} streak={streak}
            hasRecords={hasRecords} bestRun={meta.bestRun} bestRunRaw={meta.bestRunRaw ?? meta.bestRun}
            sound={meta.soundOn !== false} haptics={meta.hapticsOn !== false}
            rankOf={rankOf} onOpen={setSheet} onOpenRanking={openRanking}
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
        onStart={startDaily} rankOf={rankOf} onOpenRanking={openRanking}
      />
      <DraftSheet open={sheet === "drafts"} onClose={closeSheet} onStart={startDraft} />
      <RankingSheet
        open={sheet === "ranking"} onClose={closeSheet} initial={rankingTab}
        meta={meta} daily={daily} archive={archive} clearArchive={clearArchive} rankOf={rankOf}
        onPlayEntry={startFromRecord}
      />
      <PrefsSheet
        open={sheet === "prefs"} onClose={closeSheet}
        sound={meta.soundOn !== false} haptics={meta.hapticsOn !== false}
        onToggleSound={toggleSound} onToggleHaptics={toggleHaptics}
      />

      <VersionFooter onCheat={() => { addLegacy(100); sfxMilestone(); }} />
      <BottomNav tab={tab} setTab={setTab} />
    </div>
  );
}

/** Real position names, so the picker reads like football rather than like a
    column of three-letter codes. */
/** P-NATION 青训档位标签 (index 1..5) — 难度即卖点:荒漠开局是最高难度剧本。 */
const YOUTH_TIER_LABEL = ["", "足球王国", "精英青训", "新兴足球", "足球边陲", "足球荒漠"] as const;

const POS_LABEL: Record<string, string> = {
  GK: "门将", CB: "中后卫", LB: "左后卫", RB: "右后卫",
  CDM: "后腰", CM: "中前卫", LM: "左前卫", RM: "右前卫",
  CAM: "前腰", LW: "左边锋", RW: "右边锋", ST: "中锋",
};

/** Every shirt number 1–99 the rules allow — the grid draws one cell per
 *  entry, so a position no longer gates which numbers you may wear. */
const SQUAD_NUMBERS = Array.from({ length: 99 }, (_, i) => i + 1);

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
function DebutConsole({ meta, newSeed, dailySeed, seed, setSeed, seedMode, setSeedMode, nat, setNat, pos, setPos, pace, setPace, playerName, setPlayerName, setNameDerived, squadNumber, setSquadNumber, onStart }: {
  meta: ReturnType<typeof useGameStore>["meta"];
  newSeed: () => string;
  dailySeed: (dateStr: string) => string;
  seed: string; setSeed: (v: string) => void;
  seedMode: "random" | "custom"; setSeedMode: (m: "random" | "custom") => void;
  nat: string; setNat: (v: string) => void;
  pos: Position; setPos: (v: Position) => void;
  pace: PaceMode; setPace: (v: PaceMode) => void;
  playerName: string; setPlayerName: (v: string) => void;
  /** 标记名字是否来自 🎲 种子名（派生名不落盘、随种子重新生成）。 */
  setNameDerived: (v: boolean) => void;
  squadNumber: number | null; setSquadNumber: (v: number | null) => void;
  onStart: () => void;
}) {
  const locked = (id: string) => !isUnlocked(meta, `nation:${id}`) && !FREE_NATIONS.includes(id);
  const [picker, setPicker] = useState<null | "nat" | "identity" | "pos" | "pace" | "seed">(null);
  const closePicker = useCallback(() => setPicker(null), []);

  // 中文输入法（IME）合成期间，onChange 会把未提交的拼音字母也写进 state，
  // 名字里就混进了英文字符。用合成标志拦下合成期的变更，等 compositionend
  // 再提交最终文本——onChange 与 compositionend 都读 e.currentTarget.value，
  // 顺序无关：先 end 后 change 会重复提交同一值（幂等），先 change 后 end 则由
  // end 兜底，不会丢字。
  const composingNameRef = useRef(false);
  const commitName = (v: string) => { setPlayerName(v.replace(/\s+/g, " ").trimStart()); setNameDerived(false); };

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
  // 青训球队不再在菜单选——进入生涯后由「青训抉择」首事件决定。联赛由国籍推断
  // (homeLeagueOf：母国顶级联赛，无则同洲青训强队联赛)；分享链接带这个联赛，
  // 不再带青训俱乐部（生涯中重选）。联赛名也用于分享文案的起点归属。
  const leagueObj = homeLeagueOf(nat);
  // P-A6/P-A163: the URL-hash read + auto-start now lives at App level (see
  // PENDING_LINK), so it runs even when a restored career means MenuScreen never
  // mounts. This SetupForm only builds share URLs.
  const setupLink = (): CareerLink => ({
    seed, nationalityId: nat, position: pos, leagueId: leagueObj.id, pace,
    playerName: playerName.trim() || undefined,
    squadNumber: squadNumber ?? undefined,
  });
  // share a link with the seed baked into the URL — the TikTok zero-friction loop.
  const shareLink = () => {
    const natName = NATIONS.find((n) => n.id === nat)?.name ?? "?";
    shareText(`⚽ 绿茵轮回 · ${natName} ${POS_LABEL[pos] ?? pos} · ${leagueObj.name}`, careerUrl(setupLink()));
  };
  // P-A122: share a challenge link with full setup baked in — the viral K-factor driver.
  const shareChallenge = () => {
    const natName = NATIONS.find((n) => n.id === nat)?.name ?? "?";
    const who = playerName.trim() ? playerName.trim() + " · " : "";
    const text = `⚽ 绿茵轮回 · 我挑战你\n${who}${natName} ${POS_LABEL[pos] ?? pos} · ${leagueObj.name}\n种子 ${seed}\n${SHARE_CTA}\n${SHARE_TAGS}`;
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

      {/* Five long lists — identity, 19 nations, 12 positions, 3 paces, and a
          seed — as rows that state their value and open over the page to change
          it. The 青训队伍 is no longer picked here; it is the first in-game
          decision (青训抉择). Laid down the page they were three screens of chip
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
            <FlagImg id={nat} className="flag-img mr-1.5" />{nationName(nat)}
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
          <li>16 岁青训球员，进入生涯先<b className="text-text">选定青训球队</b></li>
          <li>每个赛季末做<b className="text-text">一个决策</b>，选择改变命运</li>
          <li>踢到退役，按巅峰 + 奖杯结算<b className="text-text">传承分</b></li>
        </ol>
      )}

      <button className="btn-primary w-full mt-3.5 py-3.5 text-base start-cta" onClick={onStart}>开始生涯 →</button>

      <PickerSheet
        open={picker === "nat"} onClose={closePicker} title="国籍" value={nat} onPick={setNat}
        sub="你的祖国——青训底子决定成长难度，弱国出身传承更丰"
        options={NATIONS.map((n) => ({
          id: n.id,
          label: <><FlagImg id={n.id} className="nf-flag" />{n.name}</>,
          locked: locked(n.id),
          hint: locked(n.id)
            ? `需 ${UNLOCKS.find((u) => u.id === `nation:${n.id}`)?.reqLegacy ?? 0} 传承`
            : `${YOUTH_TIER_LABEL[n.youthTier]}${n.youthTier > 1 ? ` · 传承 ×${NATION_LEGACY_MULT[n.youthTier]}` : ""}`,
        }))}
      />
      <PickerSheet
        open={picker === "pos"} onClose={closePicker} title="位置" value={pos} onPick={(v) => setPos(v as Position)}
        sub="前锋靠进球与金球扬名，后卫门将靠冠军立身"
        options={ALL_POSITIONS.map((p) => ({ id: p, label: POS_LABEL[p] ?? p, hint: p }))}
      />
      <PickerSheet
        open={picker === "pace"} onClose={closePicker} title="节奏" value={pace} onPick={(v) => setPace(v as PaceMode)} minCol={150}
        sub="密一点更有戏，疏一点跑得快——你的一生隔几场决策"
        options={(["long", "normal", "express"] as const).map((m) => ({ id: m, label: PACE_LABEL[m][0], hint: PACE_LABEL[m][1] }))}
      />

      {/* Name and number answer one question — who is on the shirt — so they
          share a sheet as well as a row. Both fall back to the seed. */}
      <Sheet open={picker === "identity"} onClose={closePicker} title="身份" sub="印在球衣背面和分享战报上。留空则按种子生成。" tall>
        <input
          value={playerName}
          aria-label="球员姓名"
          placeholder={generatedName}
          maxLength={16}
          onChange={(e) => { if (!composingNameRef.current) commitName(e.currentTarget.value); }}
          onCompositionStart={() => { composingNameRef.current = true; }}
          onCompositionEnd={(e) => { composingNameRef.current = false; commitName(e.currentTarget.value); }}
          className="w-full bg-surface-2 border border-line rounded-md px-3 py-3 text-[15px] font-semibold outline-none focus:border-accent"
        />
        <div className="flex gap-2 mt-2.5">
          <button className="btn-sm flex-1" onClick={() => { setPlayerName(generatedName); setNameDerived(true); }}>🎲 种子名</button>
          {playerName.trim() && <button className="btn-sm flex-1" onClick={() => { setPlayerName(""); setNameDerived(false); }}>清空</button>}
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
        {/* The whole 1–99 wall, on screen — tap any shirt number. The input
            above is the fast-type path; 🎲 is the seed default. A position no
            longer narrows which numbers you may wear. */}
        <div className="num-grid mt-3">
          {SQUAD_NUMBERS.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={squadNumber === n}
              aria-label={`${n}号`}
              className={`num-cell ${squadNumber === n ? "num-cell-active" : ""}`}
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
function ModeBand({ dailyLegacy, streak, hasRecords, bestRun, bestRunRaw, sound, haptics, rankOf, onOpen, onOpenRanking }: {
  dailyLegacy?: number; streak: number; hasRecords: boolean;
  /** 最佳单局传承分（货币，随难度膨胀）——显示为数字。 */
  bestRun: number;
  /** 最佳实绩（难度无关）——用来取评级名，见 MetaSave.bestRunRaw。 */
  bestRunRaw: number;
  sound: boolean; haptics: boolean;
  rankOf: (s: number) => { name: string; color: string };
  onOpen: (s: "daily" | "drafts" | "prefs") => void;
  onOpenRanking: (t: RankingTab) => void;
}) {
  return (
    <section>
      <SectionTitle>更多玩法</SectionTitle>
      <div className="mode-list">
        <button className="mode-row" onClick={() => onOpenRanking("server")}>
          <span className="mr-ico"><IconMode name="leaderboard" /></span>
          <span className="mr-body">
            <span className="mr-title">排行榜</span>
            <span className="mr-meta">
              全服 · 今日 · 个人
              {hasRecords && bestRun > 0 && <> · 最佳 <b style={{ color: rankOf(bestRunRaw).color }}>{bestRun}</b> {rankOf(bestRunRaw).name}</>}
            </span>
          </span>
          <span className="mr-go"><IconChevron dir="right" /></span>
        </button>

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

        <button className="mode-row" onClick={() => onOpen("prefs")}>
          <span className="mr-ico"><IconMode name="prefs" /></span>
          <span className="mr-body">
            <span className="mr-title">偏好</span>
            <span className="mr-meta">音效 {sound ? "开" : "关"} · 震动 {haptics ? "开" : "关"}</span>
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
function DailySheet({ open, onClose, date, seed, setup, todaysResult, streak, onStart, rankOf, onOpenRanking }: {
  open: boolean; onClose: () => void; date: string;
  seed: string; setup: { position: string; nationalityId: string; leagueId: string };
  todaysResult?: DailyResult; streak: number; onStart: () => void;
  rankOf: (s: number) => { name: string; color: string };
  onOpenRanking: (t: RankingTab) => void;
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
          <span className="fr-val"><FlagImg id={setup.nationalityId} className="flag-img mr-1.5" />{natName} {POS_LABEL[setup.position] ?? setup.position} · {leagueName}</span>
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

      <button type="button" className="lb-link mt-4" onClick={() => onOpenRanking("server")}>
        查看排行榜 <IconChevron dir="right" size={13} />
      </button>

      <p className="font-mono text-[11px] text-dim mt-3 mb-0">同种子 + 同选择 = 同生涯。把你的传承分发给好友比拼。</p>
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
              <span className="block font-mono text-[10px] text-dim mt-2"><FlagImg id={d.nationalityId} className="flag-img mr-1" />{d.position} · {leagueName} · {d.pace === "long" ? "沉浸" : d.pace === "express" ? "速通" : "标准"}</span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

/** A normalized ranking entry — the shape BOTH dimensions of the board
 *  (cloud server + local personal archive) map into, so the SAME honor-led row
 *  card renders a server career and a personal one identically. The rich stat /
 *  honor fields are optional: the cloud always sends them, a freshly-archived
 *  career stores them, but a career archived before they existed deserializes
 *  without them and the card omits the missing line (graceful, no data loss). */
interface RankEntry {
  name: string;
  position: string;
  nationalityId: string;
  maxOverall: number;
  seasons: number;
  legacy: number;
  rankName: string;
  trophies: number;
  awards: number;
  clubCount?: number;
  goals?: number;
  assists?: number;
  appearances?: number;
  cleanSheets?: number;
  goalsConceded?: number;
  wonWorldCup?: boolean;
  wonBallonDor?: boolean;
  wonGoldenBoot?: boolean;
  wonGoldenGlove?: boolean;
  // ownership flag — server rows the viewer uploaded themselves (marked on the
  // cloud board with the royal-violet "your record" wash). Personal-archive
  // rows leave it unset: that tab is already all-yours, no mark needed.
  mine?: boolean;
  // identity extras (personal archive carries these)
  seed?: string;
  reason?: string;
  createdAt?: string;
  /** 飞升难度 (0 = base) — shown as a badge so the difficulty context travels
   *  with the record. Absent on old archives → treated as 0 (no badge). */
  ascension?: number;
  /** Equipped blessing ids as a CSV — the BUILD this career played with. Absent/
   *  empty on old archives and custom/daily runs → no build row. */
  loadout?: string;
}
/** Cloud row → normalized entry (0/1 honor flags → booleans). */
function serverRankEntry(e: LeaderboardEntry): RankEntry {
  return {
    name: e.name, position: e.position, nationalityId: e.nationalityId,
    maxOverall: e.maxOverall, seasons: e.seasons, legacy: e.legacy, rankName: e.rankName,
    trophies: e.trophies, awards: e.awards, clubCount: e.clubCount,
    goals: e.goals, assists: e.assists, appearances: e.appearances,
    cleanSheets: e.cleanSheets, goalsConceded: e.goalsConceded,
    wonWorldCup: !!e.wonWorldCup, wonBallonDor: !!e.wonBallonDor,
    wonGoldenBoot: !!e.wonGoldenBoot, wonGoldenGlove: !!e.wonGoldenGlove,
    mine: !!e.mine,
    createdAt: e.createdAt,
    ascension: e.ascension,
    loadout: e.loadout,
  };
}
/** Local archive row → normalized entry (rich fields absent on old archives
 *  stay undefined and the card degrades). */
function archiveRankEntry(a: CareerArchiveEntry): RankEntry {
  return {
    name: a.name, position: a.position, nationalityId: a.nationalityId,
    maxOverall: a.maxOverall, seasons: a.seasons, legacy: a.legacy, rankName: a.rank,
    trophies: a.trophies, awards: a.awards, clubCount: a.clubCount,
    goals: a.goals, assists: a.assists, appearances: a.appearances,
    cleanSheets: a.cleanSheets, goalsConceded: a.goalsConceded,
    wonWorldCup: a.wonWorldCup, wonBallonDor: a.wonBallonDor,
    wonGoldenBoot: a.wonGoldenBoot, wonGoldenGlove: a.wonGoldenGlove,
    seed: a.seed, reason: a.reason,
    ascension: a.ascension,
    loadout: a.loadout,
  };
}

/** 排行榜 — 两个维度同一张表。全服=云端匿名上传的生涯荣誉榜（社交传播锥点，
 *  按国籍比拼）；我的生涯=本机归档的过往轮回（即时、离线）。两段共用同一张
 *  荣誉导向的行卡：排名 · 名字与身份 · 赛季/巅峰/俱乐部 · 出场/进球/助攻（或
 *  零封/失球）· 荣誉墙（世界杯/金球/金靴/金手套 + 奖杯数）· 传承分评级。
 *  这是「刷榜的成就感」该住的地方——个人与全服同一套展示维度与信息。 */
function RankingSheet({ open, onClose, initial, meta, daily, archive, clearArchive, rankOf, onPlayEntry }: {
  open: boolean; onClose: () => void; initial: RankingTab;
  meta: ReturnType<typeof useGameStore>["meta"];
  daily: readonly DailyResult[];
  archive: readonly CareerArchiveEntry[];
  clearArchive: () => void;
  rankOf: (s: number) => { name: string; color: string };
  onPlayEntry: (e: LeaderboardEntry) => void;
}) {
  const [tab, setTab] = useState<RankingTab>(initial);
  useEffect(() => { if (open) setTab(initial); }, [open, initial]);
  return (
    <Sheet open={open} onClose={onClose} tall title="排行榜" sub="全服 · 个人">
      <RankingTabs tab={tab} setTab={setTab} />
      {tab === "server"
        ? <RankingServer rankOf={rankOf} onPlayEntry={onPlayEntry} />
        : <RankingPersonal meta={meta} daily={daily} archive={archive} clearArchive={clearArchive} rankOf={rankOf} />}
    </Sheet>
  );
}
type RankingTab = "server" | "personal";

/** The two-dimension segment control — 全服 (the cloud board; 今日 is one of its
 *  filters, not a dimension of its own) · 我的生涯 (local archive). A segmented
 *  control, not page tabs, so the dimension is one self-evident switch; the
 *  active segment fills accent (the only CTA surface). */
function RankingTabs({ tab, setTab }: { tab: RankingTab; setTab: (t: RankingTab) => void }) {
  return (
    <div className="rk-tabs" role="tablist">
      <button role="tab" aria-selected={tab === "server"} className={`rk-tab ${tab === "server" ? "rk-tab-on" : ""}`} onClick={() => setTab("server")}>全服</button>
      <button role="tab" aria-selected={tab === "personal"} className={`rk-tab ${tab === "personal" ? "rk-tab-on" : ""}`} onClick={() => setTab("personal")}>我的生涯</button>
    </div>
  );
}

/** Session cache, keyed by the filter triple. Switching tabs (or reopening the
 *  sheet) unmounts the board; without this every return re-fetched and blanked
 *  the list back to 加载中. Module-level on purpose — it should outlive the
 *  sheet, and a reload is a fresh session anyway. */
const boardCache = new Map<string, BoardResponse>();

/** Shared fetch lifecycle for the two cloud dimensions (全服 / 今日): one effect
 *  per filter change, cancelled on cleanup, with a tri-state loading/error/data.
 *  Deduplicating it keeps the two boards' loading + fallback copy identical.
 *  A cached filter renders instantly and still revalidates in the background,
 *  so the list never flashes empty on a tab switch. */
function useLeaderboard({ nat, pos, since }: { nat?: string; pos?: string; since?: string }) {
  const key = `${nat ?? ""}|${pos ?? ""}|${since ?? ""}`;
  const cached = boardCache.get(key) ?? null;
  const [data, setData] = useState<BoardResponse | null>(cached);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const hit = boardCache.get(key) ?? null;
    setData(hit); setLoading(!hit); setError(false);
    fetchLeaderboard({ nat, pos, since, limit: 100 })
      .then((d) => { boardCache.set(key, d); if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(!hit); setLoading(false); } });
    return () => { cancelled = true; };
  }, [key, nat, pos, since]);
  return { data, loading, error };
}

/** 全服 dimension — the cloud leaderboard. Three filters on one line: 国籍 ·
 *  位置 · 时间. 时间 is a two-state toggle (全部时间 / 今日); 今日 scopes the
 *  board to careers UPLOADED since the viewer's local midnight — a date filter
 *  on the same list, not a separate mode and not the daily-challenge seed race.
 *
 *  NationFilter + PositionFilter share one open-state so opening one closes the
 *  other (their fixed backdrops would otherwise swallow each other's trigger
 *  tap, forcing a double tap to switch filters). */
function RankingServer({ rankOf, onPlayEntry }: {
  rankOf: (s: number) => { name: string; color: string };
  onPlayEntry: (e: LeaderboardEntry) => void;
}) {
  const [nat, setNat] = useState<string>("");
  const [pos, setPos] = useState<string>("");
  const [todayOnly, setTodayOnly] = useState(false);
  const [openFilter, setOpenFilter] = useState<null | "nat" | "pos">(null);
  // stable across renders so the fetch effect doesn't re-run on every keystroke
  // elsewhere; recomputed when the toggle flips (a session crossing midnight
  // re-reads the cutoff on the next toggle, which is close enough).
  const since = useMemo(() => (todayOnly ? localMidnightUtc() : undefined), [todayOnly]);
  const { data, loading, error } = useLeaderboard({ nat, pos, since });

  const entries = data?.entries ?? [];
  const lifetime = data?.lifetimeRuns ?? null;
  return (
    <>
      <div className="rk-toolbar">
        <div className="rk-filters">
          <NationFilter value={nat} onChange={(id) => { setNat(id); setOpenFilter(null); }} open={openFilter === "nat"} onOpenChange={(o) => setOpenFilter(o ? "nat" : null)} />
          <PositionFilter value={pos} onChange={(id) => { setPos(id); setOpenFilter(null); }} open={openFilter === "pos"} onOpenChange={(o) => setOpenFilter(o ? "pos" : null)} />
          <button
            type="button" className="nf-trigger" data-on={todayOnly || undefined}
            aria-pressed={todayOnly} onClick={() => { setTodayOnly(!todayOnly); setOpenFilter(null); }}
          >
            <span className="nf-trigger-lbl">{todayOnly ? "今日" : "全部时间"}</span>
          </button>
        </div>
        {todayOnly ? (
          data && <p className="rk-lifetime">今日 <b className="text-accent">{data.total.toLocaleString()}</b> 段生涯</p>
        ) : lifetime != null && (
          <p className="rk-lifetime">已开局 <b className="text-accent">{lifetime.toLocaleString()}</b> 段生涯</p>
        )}
      </div>
      {data && data.myRank != null && (
        <div className="lb-myrank">
          <span className="lb-myrank-lbl">{todayOnly ? "你的今日" : "你的最佳"}</span>
          <b className="lb-myrank-num text-accent">#{data.myRank}</b>
          <span className="lb-myrank-scope">/ {data.total.toLocaleString()} 段</span>
        </div>
      )}
      <div className="mt-2">
        {loading ? (
          <p className="text-sm text-muted m-0">加载中…</p>
        ) : error ? (
          <p className="text-sm text-muted m-0">暂时连不上榜单，稍后再试。</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted m-0">
            {todayOnly ? "今天还没有生涯上榜。踢完一局，你就是第一个。" : "还没有人上榜。踢完一局，你的传承分就会出现在这里。"}
          </p>
        ) : (
          <div className="lb-list">
            {entries.map((e, i) => (
              <Fragment key={i}>
                {opensTier(entries.map((x) => x.ascension), i) && ascTierHead(e.ascension)}
                <RankRowCard rank={i + 1} e={serverRankEntry(e)} rankOf={rankOf} onPlay={() => onPlayEntry(e)} />
              </Fragment>
            ))}
          </div>
        )}
      </div>
      <p className="font-mono text-[11px] text-dim mt-4 mb-0">
        {todayOnly
          ? "今日 = 当天上传的生涯，按你所在时区的 00:00 划线。"
          : "榜单数据来自所有玩家的生涯结算，匿名上传、仅用于排行与平衡分析。"}
      </p>
    </>
  );
}

/** 我的生涯 dimension — the local archive (instant, offline) rendered with the
 *  SAME honor-led row card as the server board, plus a personal summary and the
 *  daily-challenge history that used to live in the old 战绩档案 sheet. */
function RankingPersonal({ meta, daily, archive, clearArchive, rankOf }: {
  meta: ReturnType<typeof useGameStore>["meta"];
  daily: readonly DailyResult[];
  archive: readonly CareerArchiveEntry[];
  clearArchive: () => void;
  rankOf: (s: number) => { name: string; color: string };
}) {
  const bestLegacy = daily.length > 0 ? Math.max(...daily.map((d) => d.legacy)) : 0;
  const avgLegacy = daily.length > 0 ? Math.round(daily.reduce((s, d) => s + d.legacy, 0) / daily.length) : 0;
  // archive ranked ascension-first, legacy second — the personal board mirrors
  // the server's ranking order so the two dimensions read the same way.
  const ranked = [...archive].sort((a, b) => ((b.ascension ?? 0) - (a.ascension ?? 0)) || (b.legacy - a.legacy));
  return (
    <>
      <StatStrip items={[
        { label: "累计轮回", value: meta.runs },
        { label: "可用传承", value: meta.totalLegacy },
        { label: "最佳单局", value: meta.bestRun },
        { label: "最佳评级", value: <span className="text-[20px]" style={{ color: rankOf(meta.bestRunRaw ?? meta.bestRun).color }}>{rankOf(meta.bestRunRaw ?? meta.bestRun).name}</span> },
      ]} />

      {ranked.length > 0 && (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <SectionTitle>生涯档案 · {ranked.length} 段</SectionTitle>
            <button className="btn-sm" onClick={() => { if (confirm("清空后这些记录找不回来了，确定？")) clearArchive(); }}>清空</button>
          </div>
          <div className="lb-list">
            {ranked.map((a, i) => (
              <Fragment key={i}>
                {opensTier(ranked.map((x) => x.ascension ?? 0), i) && ascTierHead(a.ascension ?? 0)}
                <RankRowCard rank={i + 1} e={archiveRankEntry(a)} rankOf={rankOf} />
              </Fragment>
            ))}
          </div>
          <p className="font-mono text-[11px] text-dim mt-2.5 mb-0">档案只存在这台设备的浏览器里。种子 {ranked[0]!.seed} 可复现任意一局。</p>
        </div>
      )}

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

      {ranked.length === 0 && daily.length === 0 && (
        <p className="text-sm text-muted mt-4 mb-0">还没有完成的生涯。踢完第一局，这里会记下巅峰、奖杯和传承分。</p>
      )}
    </>
  );
}

/** The honor-led trophy pill cluster for one board entry: only the four
crown-jewel honors that matter on a ranking (世界杯 / 金球 / 金靴 / 金手套) are
named out — they are the ones a fan flexes and the only ones the per-row space
*has* to hold. 「奖杯」 wraps the rest of the silverware (联赛/杯赛/洲际…) into one
raw count so a domestic-cup merchant's career isn't 8 invisible trophies; the
secret tip + the count reads richer than 4 named + 4 ghosts. Order: 世界杯 first
(it's the top of the sport), then 金球 (the personal peak), then 金靴/金手套 (the
position-specific scoring honors). */
function RankHonors({ e, build }: { e: RankEntry; build: string[] }) {
  const honors: { key: string; label: string; on: boolean }[] = [
    { key: "wc", label: "世界杯", on: !!e.wonWorldCup },
    { key: "bd", label: "金球", on: !!e.wonBallonDor },
    { key: "gb", label: "金靴", on: !!e.wonGoldenBoot },
    { key: "gg", label: "金手套", on: !!e.wonGoldenGlove },
  ];
  return (
    <div className="lb-tags">
      {honors.filter((h) => h.on).map((h) => (
        <span key={h.key} className="lb-tag" data-tier="gold">{h.label}</span>
      ))}
      {e.trophies > 0 && (
        <span className="lb-tag" title="联赛/杯赛/洲际等团队奖杯总数">
          奖杯 ×{e.trophies}
        </span>
      )}
      {build.map((n) => (
        <span key={n} className="lb-tag" data-kind="build">{n}</span>
      ))}
    </div>
  );
}

/** One ranking row — a fan's brag board entry, not a spreadsheet line. Shared
 *  by BOTH dimensions (server + personal) via the normalized RankEntry, so the
 *  two boards read identically.
 *
 *  Three zones, top-anchored so the eye lands on one band: a rank rail, a body
 *  of exactly three blocks (identity → résumé → tag wall), and a right rail
 *  that spans the row (verdict pinned top, 我也要玩 pinned bottom). The résumé
 *  is two tight muted rows of the SAME treatment — career shape then output —
 *  so the row carries one headline numeral only (the legacy score); the old
 *  black 15px stat block used to fight it. Every accolade, trophy count and
 *  blessing lives in ONE wrapping tag row (gold honors first), instead of three
 *  separate pill strips in three styles. Stats render only when present
 *  (server + new archives; old archives omit them). Every surface honors the
 *  tier color-pairing rule (color + numerals, never color alone). */
function RankRowCard({ rank, e, rankOf, onPlay }: {
  rank: number; e: RankEntry; rankOf: (s: number) => { name: string; color: string };
  /** 我也要玩 — server rows carry the full identity (seed/league/pace/ascension)
   *  needed to replay the record; archive rows don't, so they omit the action. */
  onPlay?: () => void;
}) {
  const isGK = e.position === "GK";
  // leading stats by position: keepers flex clean sheets, outfielders flex
  // goals. Only render the row when the totals are present (server always; new
  // archives yes; pre-v2 archives omit it).
  const hasStats = e.appearances != null;
  const stats: { label: string; value: number }[] = hasStats
    ? [
        { label: "出场", value: e.appearances ?? 0 },
        ...(isGK
          ? [{ label: "零封", value: e.cleanSheets ?? 0 }, { label: "失球", value: e.goalsConceded ?? 0 }]
          : [{ label: "进球", value: e.goals ?? 0 }, { label: "助攻", value: e.assists ?? 0 }]),
      ]
    : [];
  const rk = rankOf(e.legacy);
  const hasHonors = !!(e.wonWorldCup || e.wonBallonDor || e.wonGoldenBoot || e.wonGoldenGlove || e.trophies > 0);
  // The BUILD this record played with — equipped blessing names (≤3). Skipped
  // for old archives / custom-daily runs with no loadout, and for any id that
  // no longer resolves to a known blessing (dirty data → skip, never crash).
  const buildNames = e.loadout
    ? e.loadout.split(",").map((s) => s.trim()).filter(Boolean)
        .map((id) => blessingById(id)?.name)
        .filter((n): n is string => !!n)
    : [];
  const hasBuild = buildNames.length > 0;
  return (
    <div className="lb-row" data-pod={rank <= 3 ? rank : undefined} data-mine={e.mine ? "" : undefined}>
      <div className="lb-rank-strip" data-pod={rank <= 3 ? rank : undefined}>
        {rank <= 3 && <span className="lb-rank-medal">{RANK_MEDAL[rank]}</span>}
        <span className="lb-rank-num"><i>#</i>{rank}</span>
      </div>
      <div className="lb-body">
        <div className="lb-id">
          <FlagImg id={e.nationalityId} className="lb-flag" />
          <span className="lb-name">{e.name}</span>
          <span className="lb-pos">{POS_LABEL[e.position] ?? e.position}</span>
          {e.ascension ? <span className="lb-asc" title={`飞升难度 ${e.ascension}`}><i>飞升</i>{e.ascension}</span> : null}
          {e.mine && <span className="lb-mine">我的</span>}
        </div>
        {/* résumé — career shape over output, one muted treatment for both so
            the pair reads as a single block and never as a second headline. */}
        <div className="lb-facts">
          <div className="lb-fact">
            <span>巅峰 <b className={ovrTierClass(e.maxOverall)}>{e.maxOverall}</b></span>
            <span className="lb-sep">·</span>
            <span><b>{e.seasons}</b> 赛季</span>
            {e.clubCount != null && (<>
              <span className="lb-sep">·</span>
              <span><b>{e.clubCount}</b> 家俱乐部</span>
            </>)}
          </div>
          {hasStats && (
            <div className="lb-fact">
              {stats.map((s, i) => (
                <Fragment key={s.label}>
                  {i > 0 && <span className="lb-sep">·</span>}
                  <span><b>{s.value.toLocaleString()}</b> {s.label}</span>
                </Fragment>
              ))}
            </div>
          )}
        </div>
        {(hasHonors || hasBuild) && <RankHonors e={e} build={buildNames} />}
      </div>
      <div className="lb-score">
        <div className="lb-verdict">
          <span className="lb-score-rank" style={{ color: rk.color }}>{rk.name}</span>
          <span className="lb-score-val">{e.legacy.toLocaleString()}</span>
        </div>
        {onPlay && <button type="button" className="lb-play" onClick={onPlay}>我也要玩</button>}
      </div>
    </div>
  );
}

/** Top-3 medal glyphs (🥇🥈🥉) — small, on the rank strip. Below 3: the bare #N
 *  numeral carries the position (color alone never ranks — the rule from
 *  PRODUCT accessibility). */
const RANK_MEDAL: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

/** 飞升 tier divider for the ascension-first board. Rendered at every point
 *  where the (descending) ascension value changes, plus above the first entry
 *  when it is not asc-0 — an all-asc-0 board stays divider-free. */
function ascTierHead(asc: number): React.ReactNode {
  const name = asc > 0 ? ASCENSIONS[asc - 1]?.name ?? "" : "常规";
  return (
    <div className="lb-tier-head" key={`tier-${asc}`}>
      飞升 {asc}<em>{name}</em>
    </div>
  );
}
/** Whether entry `i` of an ascension-first-sorted list opens a new tier. */
function opensTier(ascs: readonly number[], i: number): boolean {
  const cur = ascs[i] ?? 0;
  return i === 0 ? cur > 0 : (ascs[i - 1] ?? 0) !== cur;
}

/** The two-level nation filter — a compact pill trigger that opens a true
 *  floating menu (absolutely positioned over the board, own scroll, outside-tap
 *  closes) because 60+ nations is too many for a flat tab rail and an inline
 *  disclosure would shove the whole board down. Tapping the trigger shows
 *  continents; tapping a continent expands its nations as a two-column flag
 *  grid beneath it (one level of disclosure at a time — mobile). Selecting a
 *  nation applies it and closes; 「全部国籍」 clears. The menu anchors to the
 *  toolbar row (`.rk-toolbar` is the positioned ancestor), so it spans the
 *  sheet body without a portal — the sheet is already the top layer. */
function NationFilter({ value, onChange, open, onOpenChange }: { value: string; onChange: (id: string) => void; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [openConf, setOpenConf] = useState<string | null>(null);
  // close when the filter leaves the sheet (the board refetches on change).
  useEffect(() => { if (!open) setOpenConf(null); }, [open]);

  // nations grouped by confederation, in CONFED_ORDER; the counts read in the
  // drawer so a player scanning for their country sees the continent is worth
  // opening.
  const byConf = new Map<string, typeof NATIONS[number & keyof typeof NATIONS][]>();
  for (const n of NATIONS) {
    const arr = byConf.get(n.confederation) ?? [];
    arr.push(n);
    byConf.set(n.confederation, arr);
  }
  const selectedConf = value ? NATIONS.find((n) => n.id === value)?.confederation : null;

  return (
    <div className="nf">
      <button className="nf-trigger" onClick={() => onOpenChange(!open)} aria-expanded={open} aria-haspopup="listbox">
        {value ? <FlagImg id={value} className="nf-flag" /> : <span className="nf-globe"><IconGlobe /></span>}
        <span className="nf-trigger-lbl">{value ? nationName(value) : "全部国籍"}</span>
        <IconChevron dir={open ? "up" : "down"} size={13} />
      </button>
      {open && (<>
        <button className="nf-backdrop" aria-label="收起筛选" onClick={() => onOpenChange(false)} />
        <div className="nf-menu" role="listbox" aria-label="按国籍筛选">
          <button
            className={`nf-opt nf-opt-all ${value === "" ? "nf-opt-on" : ""}`}
            onClick={() => { onChange(""); onOpenChange(false); }}
          >
            <span className="nf-globe"><IconGlobe /></span>全部国籍
          </button>
          {CONFED_ORDER.map((conf) => {
            const ns = byConf.get(conf) ?? [];
            if (ns.length === 0) return null;
            const expanded = openConf === conf || selectedConf === conf;
            return (
              <div key={conf} className="nf-group">
                <button className="nf-conf" onClick={() => setOpenConf(expanded ? null : conf)} aria-expanded={expanded}>
                  <span className="nf-conf-lbl">{CONFED_LABEL[conf]}</span>
                  <span className="nf-conf-count">{ns.length}</span>
                  <IconChevron dir={expanded ? "up" : "down"} />
                </button>
                {expanded && (
                  <div className="nf-opts">
                    {ns.map((n) => (
                      <button
                        key={n.id}
                        className={`nf-opt nf-opt-nat ${value === n.id ? "nf-opt-on" : ""}`}
                        onClick={() => { onChange(n.id); onOpenChange(false); }}
                      >
                        <FlagImg id={n.id} className="nf-flag" />{n.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </>)}
    </div>
  );
}

/** Position filter — the second axis on the 全服 board. 12 positions grouped
 *  by the role line a fan thinks in (门将 / 后卫 / 中场 / 前锋), a flat menu (no
 *  two-level disclosure — 12 fits one screen). Shares the NationFilter's pill +
 *  floating-menu look so the two filters read as one filter pair; the two menus
 *  share an open-state (passed in) so opening one closes the other. */
const POS_GROUPS: { label: string; positions: Position[] }[] = [
  { label: "门将", positions: ["GK"] },
  { label: "后卫", positions: ["CB", "LB", "RB"] },
  { label: "中场", positions: ["CDM", "CM", "LM", "RM", "CAM"] },
  { label: "前锋", positions: ["LW", "RW", "ST"] },
];
function PositionFilter({ value, onChange, open, onOpenChange }: {
  value: string; onChange: (id: string) => void;
  open: boolean; onOpenChange: (o: boolean) => void;
}) {
  return (
    <div className="nf">
      <button className="nf-trigger" onClick={() => onOpenChange(!open)} aria-expanded={open} aria-haspopup="listbox">
        <span className="nf-trigger-lbl">{value ? (POS_LABEL[value] ?? value) : "全部位置"}</span>
        <IconChevron dir={open ? "up" : "down"} size={13} />
      </button>
      {open && (<>
        <button className="nf-backdrop" aria-label="收起筛选" onClick={() => onOpenChange(false)} />
        <div className="nf-menu" role="listbox" aria-label="按位置筛选">
          <button
            className={`nf-opt nf-opt-all ${value === "" ? "nf-opt-on" : ""}`}
            onClick={() => { onChange(""); onOpenChange(false); }}
          >
            全部位置
          </button>
          {POS_GROUPS.map((g) => (
            <div key={g.label} className="pf-group">
              <div className="pf-sec">{g.label}</div>
              <div className="pf-opts">
                {g.positions.map((p) => (
                  <button
                    key={p}
                    className={`nf-opt pf-opt ${value === p ? "nf-opt-on" : ""}`}
                    onClick={() => { onChange(p); onOpenChange(false); }}
                  >
                    <span>{POS_LABEL[p]}</span>
                    <span className="pf-code">{p}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </>)}
    </div>
  );
}

/** Two switches that shape how a run feels but are set once and forgotten.
 *  They used to occupy a quarter of the setup card above the start button. */
function PrefsSheet({ open, onClose, sound, haptics, onToggleSound, onToggleHaptics }: {
  open: boolean; onClose: () => void;
  sound: boolean; haptics: boolean;
  onToggleSound: () => void; onToggleHaptics: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="偏好" sub="设一次就好，之后每一局都按这个来">
      <div className="field-list">
        <button className="field-row" role="switch" aria-checked={sound} onClick={onToggleSound}>
          <span className="fr-val">
            音效
            <span className="fr-hint">进球、夺冠与结算时的合成音效</span>
          </span>
          <span className={`switch ${sound ? "switch-on" : ""}`} aria-hidden="true"><i /></span>
        </button>
        <button className="field-row" role="switch" aria-checked={haptics} onClick={onToggleHaptics}>
          <span className="fr-val">
            震动
            <span className="fr-hint">点选项、掷酸落点与夺冠时的触感反馈（移动端）</span>
          </span>
          <span className={`switch ${haptics ? "switch-on" : ""}`} aria-hidden="true"><i /></span>
        </button>
      </div>
    </Sheet>
  );
}

/* ═══════════════════ 祝福商店 — the shelf (bs) ═══════════════════
 * Direction contract (world pinned by the user's approved design comp):
 * THESIS: the blessing shop is the pre-rebirth arsenal ritual — a trophy
 *   room at night — refusing the default settings-list shop.
 * OWN-WORLD: pitch-night violet shelf. The CARDS are the only frames — each a
 *   polished collectible case: a circular lit display well, soft rarity glow
 *   and offset shadow (传说金/史诗紫/稀有蓝/普通灰 accents); the 16×16 pixel
 *   glyphs are the artifacts inside the cases — crisp sprite in soft glass.
 *   No outer showcase panel, no notched/pixel framing: light and shadow are
 *   the design language. (Flattened from a panel-in-panel composition: the
 *   outer showcase box + inner card box read as two nested frames and shrank
 *   the content; one frame layer — the cards — is enough.)
 * STORY: read your wealth → weigh rarity-priced blessings → equip ≤3.
 * FIRST VIEWPORT: the shared Header (identity + 传承/轮回/飞升) frames the
 *   page; a flat head row (title + 轮回折扣 + 已拥有) sits above an 出战 tray
 *   of circular slots (tap to unequip) that summarizes the loadout. The
 *   shared BottomNav returns the player to the play tab to depart.
 * FORM: a flat shelf in the normal document flow — fills the app shell like
 *   the sibling tabs, no full-screen takeover, no custom topbar/nav, no
 *   depart CTA, no width cap. Every number on screen is real MetaSave state.
 */

type PxRarity = "legendary" | "epic" | "rare" | "common";
const PX_RARITY_LABEL: Record<PxRarity, string> = { legendary: "传说", epic: "史诗", rare: "稀有", common: "普通" };
/** Rarity reads from the BASE cost (stable identity), not the discounted
 *  price — 轮回折扣 must never demote 金童 from 传说 to 史诗. */
function pxRarity(baseCost: number): PxRarity {
  return baseCost >= 20000 ? "legendary" : baseCost >= 15000 ? "epic" : baseCost >= 12000 ? "rare" : "common";
}

function BlessingShop({ meta, buyBlessing, setLoadout }: {
  meta: ReturnType<typeof useGameStore>["meta"];
  buyBlessing: (id: string) => void;
  setLoadout: (ids: readonly string[]) => void;
}) {
  // Mechanics review: blessings are a loadout (≤ MAX_LOADOUT per run), not a
  // passive always-on stack — 玻璃大炮/雇佣兵 are a build choice, not a debt.
  const equipped = resolveLoadout(meta);
  const slotsFull = equipped.length >= MAX_LOADOUT;
  // The shelf sorts by sticker price, hero first — 金童 headlines the shop.
  const shelf = useMemo(
    () => [...BLESSINGS].sort((a, b) => blessingCost(b, meta.prestige) - blessingCost(a, meta.prestige)),
    [meta.prestige],
  );
  const toggle = (id: string) => {
    if (equipped.includes(id)) setLoadout(equipped.filter((x) => x !== id));
    else if (!slotsFull) setLoadout([...equipped, id]);
  };
  // 下一目标 = 最便宜的未拥有祝福（按折后价）——顶栏进度条指向它，
  // 商店首屏就能读出「还差多少」。
  const discountPct = Math.round((1 - PRESTIGE_PRICE_DISCOUNT ** meta.prestige) * 100);

  return (
    <section className="bs" aria-label="祝福商店">
      {/* Flat shelf in the document flow — the shared Header (top) + BottomNav
          (bottom) frame the page; the cards are the only frames (the collectible
          cases). No outer panel, no width cap: fills the app shell like the
          sibling tabs. The head row carries the title + 折扣 + 已拥有 count;
          the 出战 tray + sub copy + shelf sit flat below. */}
      <header className="bs-head">
        <span className="bs-head-ico" aria-hidden="true"><PX.star size={18} /></span>
        <h2 className="bs-title">祝福商店</h2>
        {meta.prestige > 0 && <span className="bs-discount">轮回折扣 −{discountPct}%</span>}
        <span className="bs-owned">已拥有 {meta.ownedBlessings.length}/{BLESSINGS.length}</span>
      </header>
      {/* 出战配置 — icon-only circular slots, tap to unequip. The cards'
          卸下 button stays the primary affordance; this is the at-a-glance
          loadout summary. */}
      <div className="bs-equip" role="group" aria-label="已装备的祝福">
        <span className="bs-equip-lbl">出战 <b>{equipped.length}/{MAX_LOADOUT}</b></span>
        <div className="bs-equip-slots">
          {Array.from({ length: MAX_LOADOUT }, (_, i) => {
            const b = equipped[i] !== undefined ? blessingById(equipped[i]) : undefined;
            return b ? (
              <button key={b.id} className="bs-slot" data-rarity={pxRarity(b.cost)} onClick={() => toggle(b.id)} aria-label={`卸下祝福 ${b.name}`} title={b.name}>
                <PxBlessing id={b.id} size={22} />
              </button>
            ) : (
              <span key={`empty-${i}`} className="bs-slot bs-slot-empty" aria-hidden="true"><PX.plus size={14} /></span>
            );
          })}
        </div>
      </div>
      <p className="bs-sub">{`用传承购买祝福，出发前装备——每局最多 ${MAX_LOADOUT} 个生效。`}</p>

      <div className="bs-grid">
        {shelf.map((b) => {
          const owned = meta.ownedBlessings.includes(b.id);
          const isEquipped = equipped.includes(b.id);
          // 轮回折扣后的实际售价 —— 与 purchaseBlessing 的扣款走同一个
          // 函数, 显示价和结算价不会分叉。
          const cost = blessingCost(b, meta.prestige);
          const affordable = meta.totalLegacy >= cost;
          const unlocked = isUnlocked(meta, `blessing:${b.id}`);
          // 未解锁时显示的「还差 N 传承解锁」—— N 抽出来只为把文案写成模板字符串，
          // 数字两侧的空格写死在字符串字面量里，不再依赖 JSX 邻接文本的空白保留规则。
          const unlockGap = Math.max(0, (UNLOCKS.find((u) => u.id === `blessing:${b.id}`)?.reqLegacy ?? 0) - meta.totalLegacyAllTime).toLocaleString();
          const state = !unlocked ? "locked" : !owned ? (affordable ? "buy" : "short") : isEquipped ? "equipped" : "owned";
          const rarity = pxRarity(b.cost);
          return (
            <article key={b.id} className="bs-card" data-rarity={rarity} data-state={state}>
              <div className="bs-card-top">
                <span className="bs-tag">{PX_RARITY_LABEL[rarity]}</span>
                {isEquipped && <span className="bs-badge">出战 {equipped.indexOf(b.id) + 1}</span>}
                {owned && !isEquipped && <span className="bs-badge bs-badge-owned">已拥有</span>}
              </div>
              <span className="bs-well" aria-hidden="true">
                {state === "locked" ? <PX.lock size={42} /> : <PxBlessing id={b.id} size={48} />}
              </span>
              <strong className="bs-name">{b.name}</strong>
              <p className="bs-desc">{b.desc}</p>
              <div className="bs-action">
                {owned ? (
                  <button className="bs-btn" disabled={!isEquipped && slotsFull} onClick={() => toggle(b.id)} aria-pressed={isEquipped}>
                    {isEquipped ? "卸下" : slotsFull ? "栏位已满" : "装备"}
                  </button>
                ) : !unlocked ? (
                  <button className="bs-btn" disabled aria-label={`${b.name} 未解锁`}>
                    {`还差 ${unlockGap} 传承解锁`}
                  </button>
                ) : (
                  <button className="bs-price" disabled={!affordable} onClick={() => buyBlessing(b.id)} aria-label={affordable ? `购买 ${b.name}，${cost.toLocaleString()} 传承` : `${b.name} 传承不足，需 ${cost.toLocaleString()} 传承购买`}>
                    {affordable ? <b>{cost.toLocaleString()}</b> : `需 ${cost.toLocaleString()} 传承购买`}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function AscensionPicker({ meta, setAscension }: { meta: ReturnType<typeof useGameStore>["meta"]; setAscension: (n: number) => void }) {
  const maxUnlocked = maxAscensionUnlocked(meta);
  return (
    <div className="card">
      <p className="text-sm text-muted m-0 mb-3.5">难度越高，同一份成就的含金量越高。每一级都按该难度下的实绩折算传承：常规生涯有保底补偿，打出顶级生涯才能兑现完整含金量。排行榜按飞升难度优先排名。</p>
      <div className="flex flex-col gap-2">
        <button className={`chip text-left ${meta.ascension === 0 ? "chip-active" : ""}`} onClick={() => setAscension(0)}>
          <strong>飞升 0 — 常规</strong><span className="block text-[10px] text-dim mt-0.5">无修正 · 传承 ×1.00</span>
        </button>
        {ASCENSIONS.map((a) => {
          const unlocked = a.level <= maxUnlocked;
          const req = ASCENSION_UNLOCK_REQ[a.level] ?? 0;
          const reward = ascensionRewardSummary(a.level);
          return (
            <button
              key={a.level}
              disabled={!unlocked}
              className={`chip text-left ${meta.ascension === a.level ? "chip-active" : ""} ${!unlocked ? "opacity-40 cursor-not-allowed" : ""}`}
              onClick={() => unlocked && setAscension(a.level)}
            >
              <strong>飞升 {a.level} — {a.name}{a.level >= 8 && <span className="rarity-badge legendary ml-2">规则</span>}</strong>
              <span className="block text-[10px] text-dim mt-0.5">{a.desc}</span>
              <span className="block text-[10px] text-good mt-0.5">含金量 常规生涯 ×{reward.medMult.toFixed(1)} · 顶级生涯 ×{reward.topMult.toFixed(1)}</span>
              {!unlocked && <span className="block text-[10px] text-warn mt-0.5">需在飞升 {a.level - 1} 及以上单局 ≥ {req}（当前 {bestAtOrAbove(meta, a.level - 1)}）</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────────── prestige (P1: infinite meta loop) ─────────────────────────────

/** The prestige screen — the "reset for permanent power" loop. Always shows
 *  the FULL permanent-perk catalog (all 9), status-coded like the sibling
 *  blessing / ascension / hall screens: 已得 (gold) / 本次可选 (accent + button) /
 *  待选 (dim placeholder). The old "未达轮回条件" dead-end hid every perk, so a
 *  grinding player never saw the payoff menu — now the whole catalog is visible
 *  before, during, and after the grind, with an eligibility-progress banner
 *  (祝福 + 传承 bars) showing how close. No mechanic change: prestigeEligible /
 *  prestigeChoices / applyPrestige / thresholds are untouched. */
function PrestigeScreen({ meta, prestige }: { meta: ReturnType<typeof useGameStore>["meta"]; prestige: (perkId: string) => void }) {
  const eligible = prestigeEligible(meta);
  const owned = meta.permPerks;
  const ownedSet = new Set(owned);
  const allOwned = owned.length >= PRESTIGE_PERKS.length;

  // 本次三选一：useMemo 锁定，否则每次重渲染 prestigeChoices(Math.random) 都会
  // 重抽，「本次可选」高亮会随渲染漂移。meta 引用变化（完成一次献祭后）才重抽。
  const offered = useMemo(
    () => (eligible && !allOwned ? prestigeChoices(meta) : []),
    [eligible, allOwned, meta],
  );
  const offeredSet = new Set(offered.map((p) => p.id));

  // 献祭门槛进度——未达条件时的「概况」：离献祭还有多远。
  const blessingNeed = Math.max(0, BLESSINGS.length - meta.ownedBlessings.length);
  const legacyNeed = Math.max(0, PRESTIGE_LEGACY_THRESHOLD - meta.totalLegacy);
  const blessingPct = Math.min(100, (meta.ownedBlessings.length / BLESSINGS.length) * 100);
  const legacyPct = Math.min(100, (meta.totalLegacy / PRESTIGE_LEGACY_THRESHOLD) * 100);

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

      {/* 献祭门槛概况：未达条件时不再是一句死胡同，而是「离目标多远」+ 下方全谱。 */}
      {!eligible && !allOwned && (
        <div className="card">
          <SectionTitle>献祭条件</SectionTitle>
          <p className="text-sm text-muted m-0 mb-3">集齐全部祝福且传承满 {PRESTIGE_LEGACY_THRESHOLD} 后，可献祭三选一。下方为全部可获永久特权。</p>
          <div className="flex flex-col gap-3">
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="pill pill-accent">祝福</span>
                <span className="font-mono text-[10.5px] text-dim shrink-0">{blessingNeed > 0 ? `还差 ${blessingNeed} 个` : "已集齐"}</span>
              </div>
              <div className="career-bar mt-2" role="progressbar" aria-valuenow={Math.round(blessingPct)} aria-valuemin={0} aria-valuemax={100} aria-label="祝福收集进度">
                <div style={{ width: `${blessingPct}%` }} />
              </div>
              <p className="m-0 mt-1.5 font-mono text-[10.5px] text-dim">已集 {meta.ownedBlessings.length} / {BLESSINGS.length}</p>
            </div>
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="pill pill-accent">传承</span>
                <span className="font-mono text-[10.5px] text-dim shrink-0">{legacyNeed > 0 ? `还差 ${legacyNeed}` : "已满"}</span>
              </div>
              <div className="career-bar mt-2" role="progressbar" aria-valuenow={Math.round(legacyPct)} aria-valuemin={0} aria-valuemax={100} aria-label="传承积累进度">
                <div style={{ width: `${legacyPct}%` }} />
              </div>
              <p className="m-0 mt-1.5 font-mono text-[10.5px] text-dim">现有 {meta.totalLegacy} / {PRESTIGE_LEGACY_THRESHOLD}</p>
            </div>
          </div>
        </div>
      )}

      {/* 全部永久特权一览——始终展示，无论是否可献祭。
          已得=金 / 本次可选=紫+按钮 / 待选=灰占位。状态由框+药丸+文字三重承载（色盲安全）。 */}
      <div className="card">
        <SectionTitle>永久特权</SectionTitle>
        {allOwned ? (
          <p className="text-sm text-gold m-0 mb-3">🏆 全部 {PRESTIGE_PERKS.length} 项永久特权已集齐——你已走完轮回之路的尽头。</p>
        ) : eligible ? (
          <p className="font-mono text-[11px] text-warn m-0 mb-3">献祭后祝福清零、传承归零，但解锁永不回退。三选一后立即生效。</p>
        ) : (
          <p className="text-sm text-muted m-0 mb-3">共 {PRESTIGE_PERKS.length} 项永久特权，献祭后逐一获取、跨生涯叠加、永不丢失。</p>
        )}
        <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
          {PRESTIGE_PERKS.map((p) => {
            const isOwned = ownedSet.has(p.id);
            const isOffered = offeredSet.has(p.id);
            const cls = isOwned
              ? "bg-gold/8 border border-gold/30"
              : isOffered
                ? "bg-surface-2 border border-accent"
                : "bg-surface-2 border border-line";
            const nameCls = isOwned ? "text-gold" : isOffered ? "text-accent" : "text-dim";
            return (
              <div key={p.id} className={`${cls} rounded-md p-3.5 flex flex-col`}>
                <div className="flex items-baseline justify-between gap-2">
                  <strong className={nameCls}>{p.name}</strong>
                  {isOwned ? (
                    <span className="pill pill-gold">已得</span>
                  ) : isOffered ? (
                    <span className="pill pill-accent">本次可选</span>
                  ) : (
                    <span className="pill pill-muted">待选</span>
                  )}
                </div>
                <p className="text-sm text-muted m-0 mt-1.5 mb-3 min-h-8 flex-1">{p.desc}</p>
                {isOffered && (
                  <button className="btn-sm btn-primary" onClick={() => { if (confirm(`献祭全部祝福与 ${meta.totalLegacy} 传承，换取「${p.name}」？此操作不可撤销。`)) prestige(p.id); }}>轮回获取</button>
                )}
              </div>
            );
          })}
        </div>
      </div>
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
  // 堆叠: cumulative trophy haul across ALL runs (Σ per-type counts). Older
  // saves lack the counters; mergeCollection backfills ≥1 per collected type,
  // so this sum is a safe lower bound — never more than the player truly won.
  const totalTrophies = ALL_TROPHY_IDS.reduce((s, t) => s + (meta.trophyCounts?.[t] ?? 0), 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="card">
        <SectionTitle>🏆 荣誉殿堂</SectionTitle>
        <p className="text-sm text-muted m-0 mb-3.5 max-w-[52ch]">跨越所有生涯收集的奖杯与成就。灰色为未获得——下一次轮回去补齐它。</p>
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-surface-2 border border-line rounded-md p-2.5 text-center">
            <div className="font-mono text-xl text-gold tabular-nums">{totalTrophies}</div>
            <p className="font-mono text-[10px] text-dim m-0 mt-1">累计奖杯</p>
          </div>
          <div className="bg-surface-2 border border-line rounded-md p-2.5 text-center">
            <div className="font-mono text-xl text-gold tabular-nums">{trophyProgress}<span className="text-dim">/{ALL_TROPHY_IDS.length}</span></div>
            <p className="font-mono text-[10px] text-dim m-0 mt-1">奖杯种类</p>
          </div>
          <div className="bg-surface-2 border border-line rounded-md p-2.5 text-center">
            <div className="font-mono text-xl text-accent tabular-nums">{achProgress}<span className="text-dim">/{ACHIEVEMENTS.length}</span></div>
            <p className="font-mono text-[10px] text-dim m-0 mt-1">成就解锁</p>
          </div>
        </div>
      </div>

      <div className="card">
        <SectionTitle>奖杯收藏</SectionTitle>
        <p className="text-sm text-muted m-0 mb-3">每座奖杯的累计获得数——数字越大，堆得越高。</p>
        <div className="hall-grid">
          {ALL_TROPHY_IDS.map((t) => {
            const trophy = t as Trophy;
            const owned = ownedTrophies.has(trophy);
            const count = meta.trophyCounts?.[trophy] ?? 0;
            return (
              <div key={t} className="hall-trophy" data-owned={owned}>
                <img className="hall-trophy-img" src={trophyPath(trophy, "UEFA")} alt="" loading="lazy" decoding="async" />
                {owned && <div className="hall-trophy-count">×{count}</div>}
                <div className="hall-trophy-label">{TROPHY_LABEL[trophy]}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <SectionTitle>成就墙</SectionTitle>
        <p className="text-sm text-muted m-0 mb-3">已解锁 <b className="text-accent">{achProgress}</b> / {ACHIEVEMENTS.length} 项；徽章 <span className="text-gold font-semibold">×N</span> 为跨生涯达成次数。</p>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
          {ACHIEVEMENTS.map((a) => {
            const owned = ownedAchievements.has(a.id);
            const count = meta.achievementCounts?.[a.id] ?? 0;
            return (
              <div key={a.id} className={`rounded-md p-3 border ${owned ? "bg-accent/8 border-accent/30" : "bg-surface-2 border-line opacity-50"}`}>
                <div className="flex items-center gap-2">
                  <span>{owned ? "✅" : "🔒"}</span>
                  <strong className={owned ? "text-accent" : "text-dim"}>{a.name}</strong>
                  {count > 1 && <span className="hall-ach-count" title={`跨 ${count} 段生涯达成`}>×{count}</span>}
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
    #num, position·role·dev, persona chips, club + league) plus the career exit
    (挂靴) the card used to hide behind a sheet. One foil OVR badge
    anchors the mud→marble arc (the game dynamism); the bar is rim-lit by OVR
    tier. The meta line below holds the live signals (horizon, market value,
    league-title odds, streak, challenge, 飞升, seed); the resident 生涯计分
    strip is the 传承-input scorecard, with 本局 (this run's projected 传承)
    docked as the neutral result cell — distinct from the header's 传承 bank. */
function PlayTopBar({ game, onExit, revealCount }: { game: GameState; onExit: () => void; revealCount: number }) {
  const p = game.player!;
  const periodLength = game.periodLength ?? 2;
  // 青训抉择阶段：尚未模拟任何赛季、球员还在选青训球队。此时没有「当前赛季」
  // 可显示，也没有俱乐部/身价/夺冠概率/预计退役——顶栏只亮身份与「青训抉择中」。
  const academyPhase = !!game.academyPending && game.seasons.length === 0;
  // 显示态跟着已揭示季走，不剧透本 period 未揭示的季。revealCount=0 取上个
  // period 末季（开局无则首季 = 初始 16 岁 OVR）；揭示后取最后揭示季。
  const revealedCount = Math.max(0, game.seasons.length - periodLength + revealCount);
  const ds = academyPhase ? null : displaySeasonOf(game, revealCount, periodLength);
  const clubObj = clubById(game.currentClubId);  // 青训阶段是占位俱乐部，只在 league 推导时用
  const league = leagueById(clubObj.leagueId);
  const age = academyPhase ? p.age : ds!.age;
  const ovr = academyPhase ? p.overall : ds!.overall;
  const roleLabel = academyPhase ? "青训" : (ROLE_LABEL[ds!.role] ?? ds!.role);
  const clubName = academyPhase ? "青训抉择中" : clubObj.name;
  // 巅峰不在这一行复述: 能力徽章下方原有一枚「巅峰 NN」戳, 而计分带第一格就是
  //   同一个数(同一块面板、隔一条分隔线)。徽章「能力 76」+ 正下方「巅峰 86」已经
  //   把「巅峰 ≥ 能力」读成一个整体, 戳是第三遍。
  // P-RETIRE: the live horizon — projected retire age from the REVEALED state
  // so it doesn't spoil this period's unrevealed seasons. Warm when the end
  // is near so the horizon is felt without implying linear progress-to-age.
  // 青训阶段无生涯可言，不预计退役。
  const horizon = academyPhase ? null : projectedRetireAge({ ...p, age, overall: ovr }, clubObj, game.statusTags ?? [], game.severeInjuries ?? 0, game.blessings ?? [], game.permPerks ?? [], game.ascension);
  const horizonEnd = horizon == null ? null : Math.max(age + 1, horizon);
  const horizonNear = horizonEnd != null && horizonEnd - age <= 2;
  const streak = game.trophyStreak ?? 0;
  const mv = academyPhase ? 0 : (revealedCount > 0 ? (ds!.marketValue ?? 0) : 0);
  const prevDs = (!academyPhase && revealedCount > 1) ? game.seasons[revealedCount - 2] : undefined;
  const mvDelta = (!academyPhase && revealedCount > 0 && prevDs) ? Math.round((mv - (prevDs.marketValue ?? 0)) * 10) / 10 : 0;
  const seasonNum = revealedCount;
  const traits = personaTags(game.statusTags);
  // 情报封锁 (ascension 3+): blind mode — every odds numeral is black-taped.
  // 先知之眼在封锁下降级为粗档（高/中/低）而不是彻底失效：一件 11500 的祝福
  // 不该在玩家常驻的高飞升段价值归零，而全额恢复精度又会把这一档飞升废掉。
  const blind: OddsVeil = game.ascension >= BLIND_ASCENSION
    ? (game.blessings?.includes("oracle") ? "band" : "full") : false;
  const titleOdds = academyPhase ? null : leagueTitleOdds(game, ovr);
  const titlePct = titleOdds ? Math.round(titleOdds.prob * 1000) / 10 : 0;
  // 生涯词条 chip 可点：点开看含义。title 在移动端不可见，故给锚定小弹层；
  //  弹层 fixed 避开 .ptc 的 overflow:hidden 裁切；点别处/滚动/Esc 消，不挡操作。
  const [gloss, setGloss] = useState<{ tag: PersonaTag; rect: DOMRect } | null>(null);
  useEffect(() => {
    if (!gloss) return;
    const close = () => setGloss(null);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t && (t.closest(".gloss-pop") || t.closest(".ptc-chip-btn"))) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [gloss]);
  return (
    <header className="play-top">
      <div className="play-top-inner">
        {/* 顶栏面板 —— 账本才是生涯页的主角，所以顶栏压到两条带、约原先一半高：
              ① 身份区：foil 能力徽章立在左侧，右侧三条紧排文本行共用一个左基线
                 · 姓名行：旗 + 姓名 + 号码 + 右侧生涯出口（挂靴）
                 · 处境行：位置·定位 · 队徽俱乐部·联赛 · 年龄（+ 退役临近时的告警）
                   （国籍文字删掉——旗已经说了）
                 · 信号行：统一 chip 家族，空时整行不渲染
            常驻位的准入闸（三条全过才留）：① 每期会变 ② 影响马上要做的决策
            ③ 这块屏别处没说过。据此删掉：巅峰戳（正下方计分带首格就是同一个数）、
            S{N}（与年龄同构，S = 岁 − 15）、成长型（种子暗骰，玩家不可操作，
            写出来既剧透成长曲线又占一个不会变的位）；常驻「预计退役 NN」降级
            成只在剩 ≤2 赛季时亮的告警——它每期会飘，常驻读起来像随机数。
              ② 计分：传承输入四格 + 传承结果格（赛季数已在处境行，不再重复一格）
            材质纪律：档位 foil（能力徽章 + 面板描边）是全板唯一的特殊材质；金色
            只属于已赢得的荣耀（连冠/奖杯/荣誉/世界杯），本局传承是派生预览而非
            战利品，归入中性色，靠右端 docked + 分隔线表达「输入→合计」；其余元素
            一律归入两个安静家族——文字与统一 chip——号码、出口按钮、身价都不配
            拥有自己的颜色语言。 */}
        <div className="ptc" data-tier={ovrTier(ovr)}>
          <div className="ptc-row ptc-id">
            <div className="pi-ovr">
              <OvrBadge ovr={ovr} label="能力" size="sm" />
            </div>
            <div className="pi-id">
              <div className="pi-name">
                <FlagImg id={p.nationalityId} className="flag-img pi-flag" />
                <span className="pi-name-txt">{p.name}</span>
                <span className="pi-num">#{p.squadNumber}</span>
                <div className="pi-actions">
                  <button className="pi-btn" onClick={onExit} aria-label="挂靴并结束本轮回">挂靴</button>
                </div>
              </div>

              <div className="pi-where">
                <span className="pi-role">{p.position}<i>·</i>{roleLabel}</span>
                <i className="pi-sep">·</i>
                <span className="pi-club">
                  {academyPhase
                    ? null
                    : <Crest path={clubCrestPath(clubObj.id)} alt={clubName} size={13} imgClass="pi-crest" fallback={<MonoCrest clubId={clubObj.id} label={clubName.slice(0, 1)} size={13} />} />}
                  <span className="pi-club-name">{clubName}</span>
                  <i>·</i>
                  <span className="pi-league">{league.name}</span>
                </span>
                <i className="pi-sep">·</i>
                <span className="pi-clock">{age}岁{seasonNum > 0 ? "" : " · 出道在即"}</span>
                {/* 退役地平线只在够得着时说话：常驻的「预计NN」每期会飘（27 岁看到
                    35、下期变 33），读起来像随机数；剩 ≤2 赛季时它才是真信号，
                    此时才亮成琥珀告警。「还剩多少」平时由顶部生涯进度条承担。 */}
                {horizonNear && horizonEnd != null && (
                  <>
                    <i className="pi-sep">·</i>
                    <span className="pi-horizon is-near" title="预计退役年龄">还剩{horizonEnd - age}赛季</span>
                  </>
                )}
              </div>

              {/* 信号行 —— 此局戏剧 + 生涯词条共用一个 chip 家族（同高同圆角同字号，
                  只有色调不同），左流排布。全空时整行不渲染，顶栏再矮一档。 */}
              {(mv > 0 || titleOdds !== null || streak >= 2 || game.ascension > 0 || traits.length > 0 || game.customSeed) && (
                <div className="pi-chips" aria-label="当前信号与生涯词条">
                  {mv > 0 && (
                    <span className="ptc-chip trait-muted" title="市场身价">
                      <b className="pc-lbl">身价</b>€{fmtMv(mv)}
                      {mvDelta !== 0 && <span className={`pc-delta ${mvDelta > 0 ? "up" : "down"}`}>{mvDelta > 0 ? "↑" : "↓"}</span>}
                    </span>
                  )}
                  {titleOdds !== null && (
                    <span className={`ptc-chip ${blind ? "trait-muted" : traitToneOfOdds(titleOdds.prob, titleOdds.ceiling)}`} title="本季联赛夺冠概率">
                      <b className="pc-lbl">夺冠</b>{blind ? <HiddenOdds label="夺冠概率已隐藏" band={blind === "band" ? titleOdds.prob : undefined} /> : titlePct >= 0.1 ? `${titlePct}%` : "—"}
                    </span>
                  )}
                  {streak >= 2 && <span className="ptc-chip trait-legendary" title="连冠势头"><b className="pc-lbl">连冠</b>{streak}</span>}
                  {/* 飞升 / 种子 留在这里：PlayScreen 在 App() 里提前返回，不渲染
                      带着这两个数的 app-header——生涯页上这儿是它们唯一的落点。 */}
                  {game.ascension > 0 && <span className="ptc-chip trait-purple" title="飞升难度"><b className="pc-lbl">飞升</b>{game.ascension}</span>}
                  {traits.map((t) => (
                    <button
                      key={t.label}
                      type="button"
                      className={`ptc-chip ptc-chip-btn ${TRAIT_TONE_CLASS[t.tone]}`}
                      title={t.gloss}
                      aria-label={`${t.label}：${t.gloss}`}
                      onClick={(e) => setGloss((g) => g?.tag.label === t.label ? null : { tag: t, rect: e.currentTarget.getBoundingClientRect() })}
                    >{t.label}<span className={`pc-go ${gloss?.tag.label === t.label ? "is-open" : ""}`}><IconChevron dir="down" size={9} /></span></button>
                  ))}
                  {game.customSeed && <span className="ptc-chip trait-muted" title="本局种子"><b className="pc-lbl">种子</b>{game.seed}</span>}
                </div>
              )}
            </div>
          </div>

          <CareerScoreStrip game={game} revealCount={revealCount} periodLength={periodLength} />
        </div>
      </div>
      {gloss && (() => {
        const vw = window.innerWidth || 390;
        const left = Math.max(8, Math.min(gloss.rect.left, vw - 256));
        return (
          <div className="gloss-pop" style={{ top: gloss.rect.bottom + 6, left }} role="tooltip">
            <span className={`gp-label ${TRAIT_TONE_CLASS[gloss.tag.tone]}`}>{gloss.tag.label}</span>
            <span className="gp-gloss">{gloss.tag.gloss}</span>
          </div>
        );
      })()}
    </header>
  );
}

/** 夺冠 chip 色调 — 相对本联赛夺冠天花板，而非绝对 70/40 阈值。联赛冠军结构性
 *  够不着 70%（rep9 巨头基线才 34%），绝对尺度会把真正的争冠热门涂成红、荣誉
 *  追击表永远转不了绿。相对尺度修复它：达到本联赛天花板的 60% 即争冠热门(绿)、
 *  20% 中游冲击(琥珀)、之下鱼腩(灰)。红色退出联赛 chip 词汇——鱼腩是"不在此界"
 *  而非"危险"，灰比红诚实，也避免红被滥发稀释。自动适配联赛强度(小池塘的大鱼
 *  在那儿即争冠)，并奖赏巨星 build(starDifficulty+队长+王朝可把球队推过其基线档位)。 */
function traitToneOfOdds(prob: number, ceiling: number) {
  const ratio = ceiling > 0 ? prob / ceiling : 0;
  if (ratio >= 0.6) return "trait-good";
  if (ratio >= 0.2) return "trait-warn";
  return "trait-muted";
}

/** 生涯计分板 — the resident career scoreboard: the 传承 INPUTS (巅峰/奖杯/
 *  荣誉/总薪) as label-beside-number cells, with this run's projected 传承
 *  docked as the result cell on the right. Labeled 本局 (this run) — the scope
 *  qualifier that keeps it apart from the header's 传承 bank (meta.totalLegacy),
 *  a different number on the same screen. The result stays color-neutral: gold
 *  is reserved for glory you have WON (奖杯/荣誉/连冠/世界杯), and a derived
 *  projection is not a trophy, so position + a hairline separator carry the
 *  inputs→sum story a gold field used to shout. Mirrors the summary's career
 *  vocabulary (巅峰OVR/奖杯/个人荣誉/生涯总薪) so the criteria read the same at
 *  career end. */
function CareerScoreStrip({ game, revealCount, periodLength }: { game: GameState; revealCount: number; periodLength: number }) {
  // 计分四格 + 本局都跟已揭示季走（同 PlayTopBar 的能力/巅峰口径），不剧透本
  // period 未揭示的季：选完事件、store simulatePeriod 后，game 的全局值已更新到新
  // period，但逐季揭示动画还没播——这里只取已揭示赛季的汇总（巅峰=已揭示季最高、
  // 奖杯/荣誉=已揭示季奖杯/荣誉计数、总薪=已揭示季薪水、本局=已揭示态 liveLegacy
  // 预估），逐季揭示时一格一格爬到终值。
  const revealedCount = Math.max(0, game.seasons.length - periodLength + revealCount);
  const shown = game.seasons.slice(0, revealedCount);
  const shownTrophies = shown.flatMap((s) => s.trophies);
  const shownAwards = shown.flatMap((s) => s.awards);
  const peak = shown.length > 0 ? shown.reduce((m, s) => Math.max(m, s.overall), 0) : (game.player?.overall ?? game.maxOverall);
  const trophies = shownTrophies.length;
  const awards = shownAwards.length;
  const totalWage = shown.reduce((s, x) => s + (x.wage ?? 0), 0);
  const shownAge = shown.length > 0 ? shown[shown.length - 1]!.age : (game.player?.age ?? 16);
  const legacy = liveLegacy({ ...game, seasons: shown, trophies: shownTrophies, awards: shownAwards, maxOverall: peak, player: game.player ? { ...game.player, age: shownAge } : game.player });
  return (
    <div className="ptc-row career-score" aria-label="生涯计分构成">
      <span className="cs-cell"><b className="cs-lbl">巅峰</b><span className={`cs-val ${ovrTierClass(peak)}`}>{peak}</span></span>
      <span className="cs-cell"><b className="cs-lbl">奖杯</b><span className={`cs-val ${trophies > 0 ? (hasGoldTrophy(shownTrophies) ? "tier-gold" : "tier-good") : "tier-dim"}`}>{trophies}</span></span>
      <span className="cs-cell"><b className="cs-lbl">荣誉</b><span className={`cs-val ${awards > 0 ? "tier-gold" : "tier-dim"}`}>{awards}</span></span>
      <span className="cs-cell"><b className="cs-lbl">总薪</b><span className={`cs-val ${totalWage > 0 ? "" : "tier-dim"}`}>€{fmtCareerWage(shown)}</span></span>
      <span className="cs-cell cs-legacy" title="本局预计传承分"><b className="cs-lbl">本局</b><span className="cs-val is-legacy">{legacy}</span></span>
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
function LedgerHaul({ s, natId, position }: { s: GameState["seasons"][number]; natId?: string; position?: Position }) {
  const conf = confederationOfLeague(s.leagueId);
  const natConf = natConfOf(natId);
  type Item =
    | { rank: number; kind: "trophy"; key: string; gold: boolean; label: string; img: string | null; flag: string | null }
    | { rank: number; kind: "medal"; key: string; medal: "gold" | "steel"; label: string; award: Award }
    | { rank: number; kind: "cite"; key: string; cite: "gold" | "accent"; honor: SeasonHonor; label: string };
  const PRESTIGE: Record<Trophy, number> = {
    world_cup: 0, continental_primary: 2, club_world_cup: 2, national_continental: 2,
    continental_secondary: 4, league: 4, cup: 4, olympic: 3,
  };
  const items: Item[] = [];
  // P-POS 位置平衡·可见性: 赛季招牌巅峰 chip 作荣誉架首项(rank -1, 在世界杯/
  // 金球之前) —— 后卫 17 零封、组织 18 助攻、前锋 28 球的一季亮一枚金箔, 与
  // 评分/奖杯并排, 是非前锋与中锋 9.0 评分同等的可见上限信号。青年/停赛/0
  // 出场季不评。门槛与 run.ts MVP statGreat 同源。
  const peak = signaturePeak(s, position);
  // club trophies — national ones (world_cup / national_continental) draw from
  // nationalTournaments below, so skip them here to avoid the double-render.
  for (const t of s.trophies) {
    if (t === "world_cup" || t === "national_continental" || t === "olympic") continue;
    items.push({ rank: PRESTIGE[t], kind: "trophy", key: `t:${t}`, gold: TROPHY_GOLD.includes(t), label: trophyLabel(t, conf), img: trophyPath(t, conf, s.leagueId), flag: null });
  }
  // national trophies — from the dedicated source, with the country flag.
  for (const nt of s.nationalTournaments) {
    const t = nt.trophy;
    const useConf = t === "national_continental" ? (natConf ?? conf) : conf;
    items.push({ rank: PRESTIGE[t], kind: "trophy", key: `n:${t}`, gold: TROPHY_GOLD.includes(t), label: trophyLabel(t, useConf), img: trophyPath(t, useConf, s.leagueId, natConf), flag: natId ? nationFlagPath(natId) : null });
  }
  for (const a of s.awards) {
    items.push({ rank: a === "ballon_dor" ? 1 : 3, kind: "medal", key: `a:${a}`, medal: a === "ballon_dor" ? "gold" : "steel", label: AWARD_LABEL[a], award: a });
  }
  for (const h of (s.seasonHonors ?? [])) {
    items.push({ rank: h === "mvp" ? 5 : 6, kind: "cite", key: `h:${h}`, cite: h === "mvp" ? "gold" : "accent", honor: h, label: HONOR_LABEL[h] });
  }
  items.sort((x, y) => x.rank - y.rank);
  return (
    <div className="lg-haul">
      {peak && (
        <span className="trophy-badge sig-peak lg-peak" aria-label={`${peak.label} ${peak.value}${peak.unit}`}>
          <span className="sp-label">{peak.label}</span><span className="sp-num">{peak.value}{peak.unit}</span>
        </span>
      )}
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
          return <span key={it.key} className="lg-medal" data-tier={it.medal}><img className="lg-medal-img" src={awardImgPath(it.award)} alt="" loading="lazy" decoding="async" />{it.label}</span>;
        }
        return (
          <span key={it.key} className="lg-cite" data-tier={it.cite}>
            <HonorMark h={it.honor} />{it.label}
          </span>
        );
      })}
    </div>
  );
}

/** 国家队荣誉铭牌 — pinned above the season ledger as a distinct, prestigious
 *  record rather than another table header. It shows identity, the current or
 *  next national-team tournament, and cumulative records. Everything derives
 *  from already revealed seasons so the pinned summary never spoils the row
 *  that is still being written into the ledger. */
const NATIONAL_STANDING_LABEL: Record<NationalStatus, string> = {
  none: "未入选", debut: "首次入选", squad: "国脚", starter: "主力", star: "核心", captain: "队长",
};
/** standing → tier color (mud-to-marble, mirrors the OVR/rating tier system so
 *  the national armband reads on the same color ladder as the ability badge).
 *  色伴数字/文字,不单靠色。 */
function nationalStandingTier(s: NationalStatus): string {
  switch (s) {
    case "captain": return "tier-gold";
    case "star": return "tier-gold";
    case "starter": return "tier-good";
    case "squad": return "tier-warn";
    case "debut": return "tier-warn";
    default: return "tier-dim";
  }
}
function NationalCount({ value, previous }: { value: number; previous: number }) {
  if (value <= previous) return <b className="nat-stat-value">{value}</b>;
  return (
    <b className="nat-stat-value">
      <span className="sr-only">{value}</span>
      <i
        className="nat-count-roll"
        aria-hidden="true"
        style={{ "--nat-from": String(previous), "--nat-to": String(value) } as React.CSSProperties}
      />
    </b>
  );
}
function NationalTeamStrip({ game, seasons }: { game: GameState; seasons: readonly GameState["seasons"][number][] }) {
  const p = game.player;
  if (!p) return null;
  const isGK = p.position === "GK";
  const toff = game.tournamentOffset ?? 0;
  const previousSeasons = seasons.slice(0, -1);
  const called = seasons.filter((s) => s.national?.calledUp);
  const previousCalled = previousSeasons.filter((s) => s.national?.calledUp);
  const caps = called.reduce((n, s) => n + (s.national?.caps ?? 0), 0);
  const goals = called.reduce((n, s) => n + (s.national?.goals ?? 0), 0);
  const assists = called.reduce((n, s) => n + (s.national?.assists ?? 0), 0);
  const previousCaps = previousCalled.reduce((n, s) => n + (s.national?.caps ?? 0), 0);
  const previousGoals = previousCalled.reduce((n, s) => n + (s.national?.goals ?? 0), 0);
  const previousAssists = previousCalled.reduce((n, s) => n + (s.national?.assists ?? 0), 0);
  // 站位读「当季」而不是「最后一次入选那季」——否则一个 32 岁掉出名单的老将会
  // 永远挂着巅峰时的「核心」，国家队线看上去只有升没有降。掉出名单后显「已淡出」
  // （tier-dim），累计出场/进球仍然留在铭牌上：荣誉是历史，站位是现状。
  const latestSeason = seasons[seasons.length - 1];
  const currentlyCalled = latestSeason?.national?.calledUp ?? false;
  const standing: NationalStatus = currentlyCalled ? (latestSeason?.national?.status ?? "none") : "none";
  const standingLabel = currentlyCalled
    ? (NATIONAL_STANDING_LABEL[standing] ?? "未入选")
    : called.length > 0 ? "已淡出" : "未入选";
  const hasCaps = caps > 0;
  const youthSeasons = seasons.filter((s) => s.youthNational && s.youthNational.level !== "none");
  const previousYouthSeasons = previousSeasons.filter((s) => s.youthNational && s.youthNational.level !== "none");
  const youthCaps = youthSeasons.reduce((n, s) => n + (s.youthNational?.caps ?? 0), 0);
  const youthGoals = youthSeasons.reduce((n, s) => n + (s.youthNational?.goals ?? 0), 0);
  const youthAssists = youthSeasons.reduce((n, s) => n + (s.youthNational?.assists ?? 0), 0);
  const previousYouthCaps = previousYouthSeasons.reduce((n, s) => n + (s.youthNational?.caps ?? 0), 0);
  const previousYouthGoals = previousYouthSeasons.reduce((n, s) => n + (s.youthNational?.goals ?? 0), 0);
  const previousYouthAssists = previousYouthSeasons.reduce((n, s) => n + (s.youthNational?.assists ?? 0), 0);
  const lastYouth = youthSeasons[youthSeasons.length - 1];
  const youthLevel = lastYouth?.youthNational?.level;
  const youthLabel = youthLevel === "u21" ? "U21国脚" : youthLevel === "u17" ? "U17国脚" : undefined;
  const showYouth = !hasCaps && !!youthLabel;
  const natConf = natConfOf(p.nationalityId);
  const contName = NAT_CONT_NAME[natConf ?? ""] ?? "洲际杯";
  const stageRank: Record<string, number> = { "冠军": 5, "亚军": 4, "四强": 3, "八强": 2, "小组赛": 1 };
  const bestByCup = new Map<string, string>();
  for (const s of seasons) {
    const t = s.national?.tournament;
    if (!t) continue;
    const cup = t.trophy === "world_cup" || (!t.trophy && isWcAge(s.age, toff)) ? "世界杯" : contName;
    const cur = bestByCup.get(cup);
    if (!cur || (stageRank[t.stage] ?? 0) > (stageRank[cur] ?? 0)) bestByCup.set(cup, t.stage);
  }
  const best = [...bestByCup.entries()]
    .sort((a, b) => (stageRank[b[1]] ?? 0) - (stageRank[a[1]] ?? 0))
    .map(([cup, stage]) => `${cup} · ${stage}`)
    .join(" / ");
  const latest = latestSeason;
  const latestTournament = latest?.national?.tournament;
  const latestOlympic = latest?.nationalTournaments.some((t) => t.trophy === "olympic");
  let eventLabel = "下一项赛事";
  let eventName = "暂无赛程";
  let eventState: "current" | "next" = "next";
  if (latest && latestTournament) {
    eventLabel = "本季赛事";
    const currentCup = latestTournament.trophy === "national_continental"
      ? contName
      : isWcAge(latest.age, toff) ? "世界杯" : contName;
    eventName = `${currentCup} · ${latestTournament.stage}`;
    eventState = "current";
  } else if (latest && latestOlympic) {
    eventLabel = "本季赛事";
    eventName = "奥运会 · 金牌";
    eventState = "current";
  } else {
    const startAge = (latest?.age ?? Math.max(15, p.age - 1)) + 1;
    for (let age = startAge; age <= 40; age++) {
      if (showYouth && age <= 24 && isOlympicAge(age, toff)) { eventName = "奥运会"; break; }
      if (isNatContAge(age, toff)) { eventName = contName; break; }
      if (isWcAge(age, toff)) { eventName = "世界杯"; break; }
    }
  }
  const shownCaps = hasCaps ? caps : showYouth ? youthCaps : 0;
  const shownGoals = hasCaps ? goals : showYouth ? youthGoals : 0;
  const shownAssists = hasCaps ? assists : showYouth ? youthAssists : 0;
  const priorShownCaps = hasCaps ? previousCaps : showYouth ? previousYouthCaps : 0;
  const priorShownGoals = hasCaps ? previousGoals : showYouth ? previousYouthGoals : 0;
  const priorShownAssists = hasCaps ? previousAssists : showYouth ? previousYouthAssists : 0;
  const dim = !hasCaps && !showYouth;
  return (
    <div className={`nat-strip${dim ? " is-dim" : ""}`} role="group" aria-label="国家队生涯">
      <div className="nat-head">
        <span className="nat-flag"><FlagImg id={p.nationalityId} className="nat-flag-img" /></span>
        <div className="nat-identity">
          <span className="nat-name">{nationName(p.nationalityId)}国家队</span>
          <span className={`nat-standing ${showYouth ? "tier-warn" : nationalStandingTier(standing)}`}>{showYouth ? youthLabel : standingLabel}</span>
        </div>
        <div className="nat-event" data-state={eventState}>
          <span className="nat-event-label">{eventLabel}</span>
          <span key={`${eventLabel}:${eventName}`} className="nat-event-copy">{eventName}</span>
        </div>
      </div>
      <div className={`nat-records${isGK ? " is-gk" : ""}`}>
        <span className="nat-stat">
          <span className="nat-stat-label">{showYouth ? "青年出场" : "出场"}</span>
          <NationalCount key={`caps:${latest?.age ?? 0}`} value={shownCaps} previous={priorShownCaps} />
        </span>
        {!isGK && (
          <span className="nat-stat">
            <span className="nat-stat-label">{showYouth ? "青年进球" : "进球"}</span>
            <NationalCount key={`goals:${latest?.age ?? 0}`} value={shownGoals} previous={priorShownGoals} />
          </span>
        )}
        {!isGK && (
          <span className="nat-stat">
            <span className="nat-stat-label">{showYouth ? "青年助攻" : "助攻"}</span>
            <NationalCount key={`assists:${latest?.age ?? 0}`} value={shownAssists} previous={priorShownAssists} />
          </span>
        )}
        <span className="nat-best">
          <span className="nat-stat-label">最佳战绩</span>
          <b>{best || "尚无大赛战绩"}</b>
        </span>
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        国家队数据更新：{shownCaps}场{!isGK && `，${shownGoals}球，${shownAssists}助攻`}，{eventLabel}{eventName}
      </span>
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
function CareerLedger({ game, revealCount, periodLength, display }: { game: GameState; revealCount: number; periodLength: number; display: { status: "settling" | "deciding" | "advancing"; title?: string; rarity?: "common" | "rare" | "legendary" } }) {
  const p = game.player!;
  const isGK = p.position === "GK";
  // P-POS 位置平衡·可见性: 列顺序把招牌数据提前——后卫见零封、组织见助攻、
  // 前锋见进球。旧版非 GK 一律「场/球/助」, 后卫的零封不在列里(球/助多是 0),
  // 招牌数据被埋。现按位置组重排, 招牌数据作第二列(紧跟出场), 让后卫的一季
  // 零封与前锋的一季进球同等读作「这季的产出」。GK 不变(本就零封在前)。
  const group: RoleGroup = ROLE_GROUP[p.position];
  const cols = isGK ? ["场", "零封", "失球"]
    : group === "defensive" ? ["场", "零封", "球"]
    : group === "creator" || group === "support" ? ["场", "助", "球"]
    : ["场", "球", "助"];
  // 青训抉择阶段：尚未模拟任何赛季——账本当前行不显「第 1 季进行中」，而是
  // 「青训抉择 · {事件名}」，与决策位的青训事件呼应。
  const academyPhase = !!game.academyPending && game.seasons.length === 0;
  // 只渲染已揭示的季：前 period 全揭示 + 本 period 揭示到 revealCount，不剧透。
  const revealedCount = Math.max(0, game.seasons.length - periodLength + revealCount);
  const shown = game.seasons.slice(0, revealedCount);
  // 续停标记：跨期连续两季停赛(杠杆1 后同期内不再续停)显「停赛延续」（见 suspensionContinuationAges）。
  const contAges = suspensionContinuationAges(game.seasons);
  const revealing = !academyPhase && revealCount < periodLength;
  const lastRevealedAge = revealedCount > 0 ? (game.seasons[revealedCount - 1]?.age ?? 15) : 15;
  const currentAge = academyPhase ? p.age : (revealing ? lastRevealedAge + 1 : lastRevealedAge);
  // 当前行不是一条赛季 —— 它是「这一季还没发生」的进度条。旧版把它排成和赛季同构的
  // 网格、能力/场/球/助全填破折号，读起来像一条数据缺失的坏行；现在它换成异构的进展板：
  // 左边状态词 + 事件名，右边是等待提示，底边一条流动的等待轨，动效本身就说明「在等你」。
  // 事件态走 display（PlayScreen 按动画节拍算好）：结算期间冻结在刚选的事件，决策等待
  // 期才切到当前 pendingChoice——与决策位 dockView 同步，不再提前跳到下一个事件。
  const waiting = !revealing && display.status === "deciding";
  const stateLabel = academyPhase
    ? "青训抉择"
    : revealing
      ? `第 ${revealedCount + 1} 季进行中`
      : display.status === "settling"
        ? "结算中"
        : display.status === "deciding"
          ? "决策中"
          : "推进中";
  const subject = revealing ? null : display.title ?? null;
  return (
    <div className="ledger">
      <div className="lg-sticky">
        <NationalTeamStrip game={game} seasons={shown} />
        <div className="lg-grid lg-head" aria-hidden="true">
          <span>岁</span><span /><span>球队</span><span className="lg-hc">定位</span><span className="lg-hc">能力</span>
          {cols.map((c) => <span key={c} className="lg-hs">{c}</span>)}
          <span className="lg-hc">评分</span>
        </div>
      </div>
      <div className="lg-now" data-rarity={revealing ? undefined : display.rarity} data-waiting={waiting ? "" : undefined} aria-current="step">
        <span className="lg-now-age">{currentAge}</span>
        <span className="lg-dot" />
        <span className="lg-now-copy">
          <span className="lg-now-state">{stateLabel}</span>
          {subject && <span className="lg-now-subject">{subject}</span>}
        </span>
        {waiting && (
          <span className="lg-now-cue">
            等你决策
            <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
        )}
        <span className="lg-now-rail" aria-hidden="true" />
      </div>
      {[...shown].reverse().map((s, i) => {
        const stats = isGK
          ? [s.stats.appearances, s.stats.cleanSheets, s.stats.goalsConceded]
          : group === "defensive" ? [s.stats.appearances, s.stats.cleanSheets, s.stats.goals]
          : (group === "creator" || group === "support") ? [s.stats.appearances, s.stats.assists, s.stats.goals]
          : [s.stats.appearances, s.stats.goals, s.stats.assists];
        const honors = s.trophies.length + s.awards.length + (s.seasonHonors ?? []).length;
        const rating = seasonRating(s, p.position);
        // 本 period 新揭示的行走「落笔」编排（lg-reveal, index.css）：行展开顶开
        // 下方行 → 身份 → 能力 → 数据滚数 → 评分盖章 → 荣誉架亮相。滚数的可见数字
        // 是 CSS counter（--lgn 驱动），真实数值留在 sr-only 里给读屏器。
        const fresh = i < revealCount;
        return (
          <div key={s.age} className={`lg-season ${fresh ? "lg-reveal" : ""}`}>
            <div className="lg-season-in">
              <div className="lg-grid lg-row">
                <span className="lg-age">{s.age}</span>
                <span className="lg-crest">
                  <Crest path={clubCrestPath(s.clubId)} alt={s.clubName} size={20} imgClass="lg-crest-img" fallback={<MonoCrest clubId={s.clubId} label={s.clubName.slice(0, 1)} size={20} />} />
                </span>
                <span className="lg-club">
                  <span className="lg-club-name">
                    <span className="lg-name-txt">{s.clubName}</span>
                    {s.squadLevel === "youth" && <YouthTeamTag />}
                    {s.relegated && <RelegatedMark />}
                  </span>
                </span>
                <span className="lg-role">{ROLE_LABEL[s.role] ?? "—"}</span>
                <span className="lg-ovr" data-tier={ovrTier(s.overall)}>{s.overall}</span>
                {s.suspended ? (
                  <span className={`lg-susp${contAges.has(s.age) ? " is-cont" : ""}`}>{contAges.has(s.age) ? "停赛延续" : "停赛"}</span>
                ) : (
                  <>
                    {stats.map((v, j) => (
                      <span key={j} className={`lg-s ${v === 0 ? "lg-s-zero" : ""}`}>
                        {fresh ? (
                          <>
                            <span className="sr-only">{v}</span>
                            <i className="lg-roll" aria-hidden="true" style={{ "--lgn": String(v) } as React.CSSProperties} />
                          </>
                        ) : v}
                      </span>
                    ))}
                    <span className="lg-rating" data-tier={rating !== null ? ratingTier(rating) : "dim"}>{rating !== null ? rating.toFixed(1) : "—"}</span>
                  </>
                )}
              </div>
              {honors > 0 && (
                <div className="lg-haul-wrap">
                  <div className="lg-haul-wrap-in">
                    <LedgerHaul s={s} natId={game.player?.nationalityId} position={p.position} />
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 判决牌停留时长（ms）——同时驱动自动关闭的定时器和牌底那条等待条。
 *  反馈：结果文案偏长，2.4s 读不完就被自动关掉，提到 .6s（+50%）留足阅读时间。 */
const VERDICT_MS = 3600;

/** 成就弹窗的两道拍子（ms）：入场拍等结算页 count-up（900ms）落幕再弹，
 *  换拍是多张成就之间的半拍间隔（也顺手挡住上一张的连点）。 */
const ACH_ENTER_MS = 1000;
const ACH_STEP_MS = 260;

function PlayScreen({ game, store }: { game: GameState; store: ReturnType<typeof useGameStore> }) {
  const { choose, advance, abortRun, dismissMilestone } = store;
  const periodLength = game.periodLength ?? 2;
  const scrollRef = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();
  // 赛季节拍：本 period 逐季自动揭示。新 period 到来 → 归零重开。
  const periodGen = Math.floor(game.seasons.length / periodLength);
  const [revealCount, setRevealCount] = useState(0);
  // 收尾呼吸：末季揭示动画落幕前决策位不浮出——无荣誉季的评分盖章(~920ms)还在
  //  播,决策位就 anim-slide 滑入会两个动画同帧叠在一起。所有季都等末季揭示走完;
  //  有荣誉季再留 REVEAL_BREATH_MS 让奖杯余韵落下。settledRef 守一期一次——避免
  //  呼吸定时器被自身 set 触发的重跑清掉后重触发成死循环。
  //  ⚠ 存的是「这口气要屏多少毫秒」而不是布尔：定时器由下面那只只依赖 settleMs 的
  //  effect 独占(见那里的注释)——挂起呼吸和放下呼吸必须分属两只 effect,否则任何
  //  无关依赖变化都能把定时器清掉、而 settledRef 又不许重挂,呼吸就永远放不下来。
  const [settleMs, setSettleMs] = useState(0);
  const revealSettling = settleMs > 0;
  const settledRef = useRef(false);
  // 选完事件后，结果先在决策位就地亮相一拍，再自动进入下一赛季
  const [outcomeFor, setOutcomeFor] = useState<string | null>(null);
  // 结算跑马灯：点完选项，高亮先在这个选项的两支结果上扫过，减速，停在真正
  // 发生的那一支——概率是这游戏的主角，落点得让玩家亲眼看着落下去，而不是
  // 结果凭空出现。约 1.7 秒，正好是「等一下」而不是「等着」。
  const [roll, setRoll] = useState<{
    title: string; desc: string; rarity?: "common" | "rare" | "legendary";
    key?: string; choices: readonly Choice[]; picked: Choice; step: number;
    /** 确定性选项（转会/青训抉择/留队退役等没有掷骰的抉择）不走跑马灯，复用
     *  这条冻结通道做「落定等一拍」：选中的牌点亮锁入、其余压暗约 0.5s 再
     *  接上判决牌。rollN=0 → rollSteps=0 → 立刻命中「落定等一拍」分支。 */
    dwell?: boolean;
  } | null>(null);
  // 新 period 到来时归零逐季揭示。用 useLayoutEffect（paint 前同步）而非 useEffect：
  // choose() 选完最后一个事件后 store 立刻 simulatePeriod 推进到新 period（seasons 已
  // +periodLength、maxOverall 已更新），若用 useEffect 异步重置 revealCount，浏览器会先
  // paint 一帧「revealCount=旧值 + 新 seasons」——顶栏能力/巅峰取到新 period 末季，等于
  // 把本期结局提前剧透给判决牌还没播完的玩家。useLayoutEffect 在 paint 前同步重置，这一
  // 帧从不被看见。
  useLayoutEffect(() => { setRevealCount(0); setSettleMs(0); settledRef.current = false; }, [periodGen]);
  // 青训抉择阶段：尚未模拟任何赛季、球员还在选青训球队。此时没有赛季可逐季揭示，
  // 强制 revealing=false——否则自动揭示循环会空转 ~2 秒显示「赛季进行中…」，
  // 把青训抉择决策位压成 idle；设为 false 后决策位立即浮出青训事件。
  const academyPhase = !!game.academyPending && game.seasons.length === 0;
  const revealing = !academyPhase && revealCount < periodLength;
  // 仪式仍在进行 = 还在逐季揭示，或末季揭示动画/收尾呼吸未结束。决策位在此期间
  //  不浮出（dockView 拿它当门）——末季账本揭示(评分盖章/奖杯仪式)没走完前下一
  //  事件不滑进来,避免两个动画同帧叠在一起。
  const ceremonyActive = revealing || revealSettling;
  // 账本窗口钉在最新一季：新行揭示后、决策位涨缩后都滚到顶部（最新季在列表最上方），眼睛不用来回找
  const dockMode = roll ? "roll" : outcomeFor ? "outcome" : game.pendingChoice ? "decision" : "idle";
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
  const pick = (id: string) => {
    hapticTap();
    sfxTap();
    const pc = game.pendingChoice;
    const title = pc?.title ?? "结果";
    const c = pc?.choices.find((x) => x.id === id);
    // 有掷骰的选项走跑马灯（两支结果上扫过、减速、落定）；确定性选项（转会/
    //  青训抉择/留队退役——没有概率分支）没有可落的点，但也不该「砰」一下直
    //  接弹判决牌——给「我选了这一家」一个被看见的落定拍：复用 roll 冻结通道
    //  做半拍 dwell，选中的牌点亮锁入、其余压暗，约 0.5s 后再让判决牌接上
    //  （rollN=0 → rollSteps=0 → 命中「落定等一拍」分支，620ms 后 setOutcomeFor）。
    //  降低动效偏好下一律直给，与跑马灯在 reduce 下跳过的口径一致。
    if (!reduce && c?.roll && pc) {
      // 冻结决策板：choose() 立刻出队推进，pendingChoice 已变成下一题或空，
      // 所以把玩家刚看到的那块板原样留住——布局不动，只点亮选中的那张牌，
      // 跑马灯就在那张牌的两支结果上跑。
      setRoll({ title, desc: pc.desc, rarity: pc.rarity, key: pc.key, choices: pc.choices, picked: c, step: 0 });
    } else if (!reduce && c && pc) {
      // 确定性 dwell：同一块板原样冻结，选中的牌锁入高亮、其余压暗，半拍后
      // 再让判决牌接上。dwell 标记把好坏音效/震感也慈到判决牌亮相那一刻
      // （见下方 sfx effect 的 hold 判定），不在落定拍里提前剧透结果好坏。
      setRoll({ title, desc: pc.desc, rarity: pc.rarity, key: pc.key, choices: pc.choices, picked: c, step: 0, dwell: true });
    } else {
      setOutcomeFor(title);
    }
    choose(id);
  };
  // 常驻挂靴是无条件提前退出，不是生涯内挣来的结局：不结算、不归档、不上传。
  // 二次确认完整列出三项后果，避免玩家把它误解为随时可兑现的结算按钮。
  const onExit = () => {
    if (confirm("挂靴将立即结束当前轮回。\n\n本轮不结算传承、不进入生涯档案，也不会上传排行榜。确定挂靴？")) abortRun();
  };
  // 好坏由引擎的 resolve 结果决定（三态 lastOutcomeTone），不再靠关键词正则猜。
  // 旧存档没有 tone → 按 lastOutcomeGood 回退成两态。
  const verdict = game.lastVerdict;
  const verdictEffects = verdict?.effects
    ? (verdict.effectsLayout === "summary" ? summarizeInjuryEffects(verdict.effects) : byValence(verdict.effects))
    : EMPTY_PREVIEW;
  const vTone = game.lastOutcomeTone ?? (game.lastOutcomeGood === false ? "bad" : "good");
  const isBad = vTone === "bad";

  // P-A4: milestone celebration — vibrate + milestone sfx + auto-dismiss on tap.
  // 亮相时机压到本期演出落幕之后：引擎在 simulatePeriod 里就把里程碑算好了，
  //  但那一刻玩家才刚点完选项，跑马灯/判决牌/逐季揭示都还没播——直接弹等于
  //  抢在自己的因果之前（还会把判决牌顶掉，玩家看不到自己那一选的结果）。
  //  这里只做「显示门」：跑马灯、判决牌、逐季揭示、收尾呼吸全部落幕才亮相，
  //  即里程碑那一季已经写进账本之后。下面所有节拍 effect 用的都是这个门后的
  //  milestone——门没开时节拍照常走，门一开节拍才暂停等玩家点。
  const milestone = roll || outcomeFor || revealing || revealSettling ? undefined : game.pendingMilestone;
  // the player's current OVR — drives the milestone popup's foil face (handoff 4.13).
  // 青训抉择阶段尚无赛季，取球员初始 OVR（displaySeasonOf 此时无季可取）。
  const displayOvr = academyPhase ? (game.player?.overall ?? 50) : displaySeasonOf(game, revealCount, periodLength).overall;
  const dismissMs = () => { hapticMilestone(milestone?.tone === "legendary"); sfxMilestone(); dismissMilestone(); };
  // 情报封锁 (ascension 3+): blind mode — every odds numeral is black-taped.
  // 先知之眼在封锁下降级为粗档（高/中/低）而不是彻底失效：一件 11500 的祝福
  // 不该在玩家常驻的高飞升段价值归零，而全额恢复精度又会把这一档飞升废掉。
  const blind: OddsVeil = game.ascension >= BLIND_ASCENSION
    ? (game.blessings?.includes("oracle") ? "band" : "full") : false;
  // oracle 祝福让成功概率显 1 位小数（与引擎 pct 同口径），用于掷骰两支的百分比标签。
  const oracle = !!game.blessings?.includes("oracle");

  // 跑马灯的落点与步数。resolve 已在同一批 setState 跑完，这一帧就知道命中的是
  // 哪一支。预览现在是明确的 成功/失败 两支（另加一个静态、全程亮的必定区）：
  // 跑马灯只在两支上扫，落点停于 resolve 命中那支的首颗药丸（与判决牌 OVR 口径一致）。
  const fork = roll?.picked.roll;
  // 跑马灯扫的是「两支结果」不是逐颗药丸——一次掷骰决定整组后果，高亮应在两个
  //  组合间扫、落定时整组亮，而非逐颗抽签（那暗示每条影响独立掷骰，与真相相反；
  //  也回到 2868 行注释「两支结果上扫过」的本意——逐颗扫是实现跑偏了）。
  //  roll 存在则 win≥1 且 lose≥1（见 optionPreview），故恒为 2 支、落点总有效。
  //  必定区静态全程亮，不进扫换。
  const rollN = fork ? 2 : 0;
  const isWin = game.lastOutcomeGood ?? !isBad;
  const rollTarget = rollN ? (isWin ? 0 : 1) : 0;
  // ×6（非旧 ×4）补偿 rollN 从「药丸数」缩到 2 支——保持约 1.7s 的「等一下」节拍。
  const rollSteps = rollN * 6 + rollTarget;
  const rollDone = !!roll && roll.step >= rollSteps;
  // 决策位此刻展示的那块板：跑马灯期间用冻结快照（choose() 已把 pendingChoice
  // 推进到下一题或清空），否则用当前决策；判决牌与逐季揭示时这一格待机。
  // 布局不动——选中的牌原地点亮、其余压暗，跑马灯就在那张牌的两支结果上扫过。
  const dockView = roll
    ? { title: roll.title, desc: roll.desc, rarity: roll.rarity, key: roll.key, choices: roll.choices,
        roll: { pickedId: roll.picked.id, cursor: rollN ? roll.step % rollN : 0, landed: rollDone }, fresh: false }
    : !outcomeFor && !ceremonyActive && !milestone && game.pendingChoice
      ? { title: game.pendingChoice.title, desc: game.pendingChoice.desc, rarity: game.pendingChoice.rarity,
          key: game.pendingChoice.key, choices: game.pendingChoice.choices, roll: null, fresh: true }
      : null;
  // 账本顶栏「进行中」状态对齐动画节拍：跑马灯/判决牌结算期间（roll/outcomeFor）冻结
  // 在玩家刚选的事件——结算动画优先级最高，即使 choose() 已把最后一个事件选完、store
  // 已 simulatePeriod 推进到新 period（revealing=true），账本也不提前透露「下一季进行中」；
  // 结算动画播完才让位给逐季揭示（revealing）或下一个决策（pendingChoice）。这样账本顶
  // 栏的事件切换与决策位 dockView 同步：不再在第一个事件还没结算完时就提前跳到第二个
  // 事件，也不再在单事件结算完、判决牌还没弹就跳到新 period。
  const ledgerDisplay: {
    status: "settling" | "deciding" | "advancing";
    title?: string;
    rarity?: "common" | "rare" | "legendary";
  } = roll
    ? { status: "settling", title: roll.title, rarity: roll.rarity }
    : outcomeFor
      ? { status: "settling", title: outcomeFor }
      : ceremonyActive
        ? { status: "advancing" }
        : game.pendingChoice
          ? { status: "deciding", title: game.pendingChoice.title, rarity: game.pendingChoice.rarity }
          : { status: "advancing" };
  // 事件框的视觉等级（common/rare/legendary）—— 只驱动镶边卡的色与光，
  //  不碰引擎。boss 决战键在此提升为 legendary（见 dockTierOf）。
  const dockTier = dockView ? dockTierOf(dockView.rarity, dockView.key) : null;
  // 确定性选项「落定等一拍」期间给卡面挂 data-dwell：选中的牌做一次锁入顿挫，
  //  把「我选了这一家」的落定感做出来（跑马灯路径不挂这个，它有自己的药丸落定）。
  const dockDwell = !!roll?.dwell;
  useEffect(() => {
    if (!roll || milestone) return;
    if (roll.step >= rollSteps) {
      // 停稳后再让位给结果文案——落定那一下需要一拍被看见。
      const t = setTimeout(() => { setOutcomeFor(roll.title); setRoll(null); }, 620);
      return () => clearTimeout(t);
    }
    // 指数减速：起手 ~60ms 一格，越接近落点越慢，最后一格 ~320ms 才咔哒一声。
    const p = roll.step / rollSteps;
    const t = setTimeout(() => {
      sfxTick();
      setRoll((r) => (r ? { ...r, step: r.step + 1 } : r));
    }, 60 + 260 * p * p);
    return () => clearTimeout(t);
  }, [roll, rollSteps, milestone]);

  // 自动节拍：结果亮相一拍 → 逐季自动揭示 → 决策弹出。里程碑弹层时暂停。
  // 没有决策的 period 揭示完后自动推进，全程无需点「下一赛季/继续」。
  // 节拍绑动画时长：每拍等「刚揭示那季的仪式落幕 + 呼吸」再揭下一季/推进，
  //  避免加长后的奖杯仪式被下一段动画压住（节奏感，不局促）。
  useEffect(() => {
    if (milestone || roll) return;
    // 判决牌只在 lastOutcome 有字时绘制,但计时不看它:万一某天有事件结算出空文案,
    //  outcomeFor 也必须自己退场,否则节拍停在「结算中」等一张永远不出现的牌。
    if (outcomeFor) {
      const t = setTimeout(() => setOutcomeFor(null), VERDICT_MS);
      return () => clearTimeout(t);
    }
    if (revealing) {
      // 逐季揭示：期首季前的过门拍(REVEAL_FIRST_MS)不绑动画（此刻无季在播）；
      // 之后每拍等「刚揭示那季的仪式落幕 + 呼吸」再揭下一季，否则两行动画叠
      //  在一起——奖杯季尤其明显。无荣誉季 max(基线, 落幕+呼吸)=基线，不回退。
      let delay: number;
      if (revealCount === 0) {
        delay = REVEAL_FIRST_MS;
      } else {
        const justRevealed = game.seasons[game.seasons.length - periodLength + revealCount - 1];
        delay = justRevealed ? Math.max(REVEAL_INTER_MS, revealFinishMs(justRevealed) + REVEAL_BREATH_MS) : REVEAL_INTER_MS;
      }
      const t = setTimeout(() => setRevealCount((c) => c + 1), delay);
      return () => clearTimeout(t);
    }
    // 有里程碑待弹时绝不自动推进——推进会再跑一次 simulatePeriod,把还没亮相的
    //  里程碑冲掉。等玩家点掉弹层(pendingMilestone 清空)本 effect 再重跑推进。
    if (!game.pendingChoice && !game.pendingMilestone) {
      // 无决策期：等末季揭示动画走完(revealFinishMs)再推进。advance() 触发
      //  revealCount 归零,末季 lg-reveal 会被掐断——haul 季奖杯逐枚淡入原地 snap
      //  成直接出现,无荣誉季评分盖章也被截断,与决策位撞拍同类的节奏断裂。推进后
      //  的期首过门拍(REVEAL_FIRST_MS=700)就是期与期之间的呼吸缓冲(≥ REVEAL_BREATH_MS,
      //  期界比季内换拍更重,多留一拍合理),不另加;无荣誉季 revealFinishMs=920 仍 >
      //  REVEAL_ADVANCE_MS=900,同样等动画走完。决策期的呼吸由下方 settle effect 管。
      const last = game.seasons[game.seasons.length - 1];
      const delay = last
        ? Math.max(REVEAL_ADVANCE_MS, revealFinishMs(last))
        : REVEAL_ADVANCE_MS;
      const t = setTimeout(() => advance(), delay);
      return () => clearTimeout(t);
    }
  }, [milestone, roll, outcomeFor, revealing, revealCount, game.seasons, game.pendingChoice, game.pendingMilestone, game.lastOutcome, advance, periodLength]);
  // 收尾呼吸（决策期）：末季揭示动画落幕前决策位不浮出。无荣誉季的评分盖章
  //  (revealFinishMs ~920ms)还在播、决策位就 anim-slide 滑入,会两个动画同帧
  //  叠在一起(节奏拥挤)——这正是「两个赛季一个事件」节奏下第二季进账本时事件
  //  弹窗提前撞上来的来源。所有季都等末季揭示走完(revealFinishMs);有荣誉季再
  //  留 REVEAL_BREATH_MS 让奖杯余韵落下,无荣誉季不留额外呼吸保住 quick-hit 节奏。
  //  ⚠ 用 useLayoutEffect 而非 useEffect:revealing 翻 false(revealCount 达到 periodLength)
  //  那一帧与 revealSettling 翻 true 之间若是异步 effect,会漏出 1 帧 ceremonyActive=false
  //  空窗——决策位闪现一帧再被隐藏(中间那帧 DOM 虽不绘制,但 anim-slide 已启动、清除
  //  时会被抬起)。useLayoutEffect 在 paint 前同步把呼吸设上,中间帧从不绘制,闪现消失。
  //  settledRef 守一期一次;这只 effect 只「挂起」呼吸,放下由下面独立的定时器 effect 负责。
  //  待弹的里程碑同样走这道呼吸（`game.pendingMilestone` 也开门）：无决策期本来
  //  没有收尾呼吸,末季那行的揭示动画还在播,弹层就会当场盖上去——里程碑该等它
  //  写完账本再亮相。
  useLayoutEffect(() => {
    if (milestone || roll || revealing || !(game.pendingChoice || game.pendingMilestone)) return;
    const last = game.seasons[game.seasons.length - 1];
    if (!last || settledRef.current) return;
    settledRef.current = true;
    setSettleMs(revealFinishMs(last) + (seasonHasHaul(last) ? REVEAL_BREATH_MS : 0));
  }, [milestone, roll, revealing, game.seasons, game.pendingChoice, game.pendingMilestone]);
  // 呼吸的定时器只挂在 settleMs 上——这是「卡死在赛季进行中…」那个 bug 的修法。
  //  旧版把定时器挂在上面那只 effect 里:期界那一帧 revealCount 还没归零(归零发生在
  //  同一 commit 的 periodGen effect 里,本帧的 revealing 仍是旧值 false),静默期自动
  //  推进进来的新决策就让它抢先把呼吸挂上;下一帧 revealCount=0 → revealing 翻 true →
  //  依赖变化触发 cleanup 清掉定时器,而 settledRef 已置位、重跑直接 return——呼吸再也
  //  放不下来。ceremonyActive 于是永久为真,决策位被挡在门后,账本停在「推进中」、
  //  决策位停在「赛季进行中…」,整局生涯就此卡死(玩家上报的正是这一幕)。
  //  拆成两只:只依赖 settleMs 的这只无论被谁重跑都会重新挂上定时器,呼吸必然落地。
  useEffect(() => {
    if (!settleMs) return;
    const t = setTimeout(() => setSettleMs(0), settleMs);
    return () => clearTimeout(t);
  }, [settleMs]);
  // 新一轮逐季揭示开始 = 上一期的收尾呼吸作废:放下呼吸、把「一期一次」的闸重置,
  //  让本期末季揭示完之后能重新挂一口正确时长的气(periodGen 那只 effect 归零 revealCount
  //  时,本帧 revealing 仍是旧值,故必须由 revealing 自己再收一次尾)。
  useLayoutEffect(() => {
    if (!revealing) return;
    settledRef.current = false;
    setSettleMs(0);
  }, [revealing]);

  // P-A9: sync sfx enabled state with the meta toggle.
  useEffect(() => { setSfxEnabled(store.meta.soundOn !== false); }, [store.meta.soundOn]);
  // P-A9: outcome sfx — play good/bad/trophy sound when a new outcome appears.
  const prevOutcome = useRef<string | null>(null);
  useEffect(() => {
    // 跑马灯还在转、或确定性选项正在「落定等一拍」——先把好坏音效憋住，
    // 提前响等于剧透：跑马灯剧透落点，dwell 剧透判决牌的好坏。
    if (roll && (!rollDone || !!roll.dwell)) return;
    if (game.lastOutcome && game.lastOutcome !== prevOutcome.current) {
      const isTrophy = /冠军|封王|封帝|捧杯|夺冠|金球|金靴|金手套|世界杯/.test(game.lastOutcome);
      if (isTrophy) { sfxTrophy(); hapticTrophy(); }
      else if (isBad) { sfxBad(); hapticBad(); }
      else if (vTone === "mixed") { hapticGood(); }   // 有得有失：轻震一下，不吹号也不哀乐
      else { sfxGood(); hapticGood(); }
    }
    prevOutcome.current = game.lastOutcome ?? null;
  }, [game.lastOutcome, isBad, vTone, roll, rollDone]);
  // P-A9: boss event sfx — tense rumble when a boss decision appears.
  const prevChoiceKey = useRef<string | null>(null);
  useEffect(() => {
    const key = game.pendingChoice?.key;
    if (key && key !== prevChoiceKey.current) {
      if (key === "world_cup_showdown" || key === "world_cup_qualifier_showdown" || key === "continental_cup_showdown") { sfxBoss(); hapticBoss(); }
    }
    prevChoiceKey.current = key ?? null;
  }, [game.pendingChoice?.key]);
  // Apex 演出亮相即刻起乐——庆祝的声音属于亮相那一拍,不是关闭那一下
  // (通用里程碑维持原状:关闭时 sfxMilestone)。
  const prevMsId = useRef<string | null>(null);
  useEffect(() => {
    if (milestone?.moment && milestone.id !== prevMsId.current) { sfxTrophy(); hapticTrophy(); }
    prevMsId.current = milestone?.id ?? null;
  }, [milestone]);



  return (
    <>
      {/* 判决牌 —— 选完事件后的结果不再挤在决策位里，而是全屏浮层给它一拍。
          好/坏用整张牌的光色 + 印章 + 判词三重编码（不只靠颜色），
          底部细条把这一拍的等待时间画出来，点任意处可提前跳过。 */}
      {outcomeFor && game.lastOutcome && !milestone && (
        <div className="verdict-overlay" onClick={() => setOutcomeFor(null)}>
          <div className="verdict-card anim-pop" data-verdict={vTone}>
            <i className="vd-rays" aria-hidden />
            <div className="vd-seal" aria-hidden>{TONE_GLYPH[vTone]}</div>
            <p className="vd-kicker">{outcomeFor}</p>
            <h2 className="vd-word">{vTone === "bad" ? "事与愿违" : vTone === "mixed" ? "有得有失" : "如你所愿"}</h2>
            {verdict?.choice && <p className="vd-choice">你选择了「{verdict.choice}」</p>}
            <Prose className="vd-text" text={game.lastOutcome} blind={blind} />
            {verdict && (verdictEffects.length || verdict.ovrDelta || verdict.injury) ? (
              <div className="vd-tags">
                {verdictEffects.length > 0
                  ? verdictEffects.map((p, i) => (
                      <span key={i} className={`vd-tag ${p.good ? "vd-tag-up" : "vd-tag-down"}`}>{p.label}</span>
                    ))
                  : (<>
                    {!!verdict.ovrDelta && (
                      <span className={`vd-tag ${verdict.ovrDelta > 0 ? "vd-tag-up" : "vd-tag-down"}`}>
                        能力 <b className="font-mono">{verdict.ovrDelta > 0 ? "+" : "−"}{Math.abs(verdict.ovrDelta)}</b>
                      </span>
                    )}
                    {verdict.injury && <span className="vd-tag vd-tag-down">{verdict.severe ? "重伤" : "伤病"}</span>}
                  </>)}
              </div>
            ) : null}
            <span className="vd-timer" aria-hidden><i style={{ animationDuration: `${VERDICT_MS}ms` }} /></span>
          </div>
        </div>
      )}
      {milestone && (
        <div className="milestone-overlay" onClick={dismissMs}>
          {milestone.moment ? (
            <ApexCard ms={milestone} tier={ovrTier(displayOvr)} />
          ) : (
            <div className={`milestone-card anim-pop ${milestone.tone === "legendary" ? "milestone-legendary" : ""}`} data-tier={ovrTier(displayOvr)}>
              <i className="ms-rays" aria-hidden />
              <div className="ms-medal">{milestone.tone === "legendary" ? "🏆" : "⭐"}</div>
              <p className="ms-kicker">{milestone.tone === "legendary" ? "传奇时刻" : "生涯里程碑"}</p>
              <h2 className="ms-title">{milestone.title}</h2>
              <Prose className="ms-desc" text={milestone.desc} />
              <p className="ms-age">{milestone.age} 岁</p>
              <p className="ms-tap">点击继续</p>
            </div>
          )}
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
        <PlayTopBar game={game} onExit={onExit} revealCount={revealCount} />

        <div className="play-body">
          <div className="play-scroll" ref={scrollRef}>
            <div className="play-scroll-inner">
              {/* 生涯页只留两样东西：球员（顶栏）+ 赛季账本，窗口钉在最新一季 */}
              <CareerLedger
                game={game}
                revealCount={revealCount}
                periodLength={periodLength}
                display={ledgerDisplay}
              />
            </div>
          </div>
        </div>

        {/* 决策位 —— 页面唯一的行动区：结果亮相 → 赛季推进 → 决策弹出，都在这一格 */}
        <div className="decision-dock">
          {dockView ? (
            /* 决策中或结算中——同一块板。跑马灯期间选中的牌原地点亮、其余压暗，
               两支结果在那张牌里扫过、减速、落定；不拉宽、不藏其余选项，玩家
               读过的那两颗药丸原地变成开奖盘。只有新决策才走 anim-slide 入场。
               事件框是一张镶边卡：描边+花边+打光随事件等级（common/rare/legendary）
               逐档加重，把决策位的分量与事件本身的分量对齐——青训抉择是冷静的钢框，
               稀有事件染紫光，世界杯决战起金光与光束。 */
            <div className={`dock-decision${dockView.fresh ? " anim-slide" : ""}`} data-tier={dockTier} data-dwell={dockDwell ? "" : undefined}>
              {dockTier === "legendary" && <i className="dock-rays" aria-hidden />}
              <div className="dock-head">
                <span className="dock-title">
                  {dockView.rarity === "legendary" ? <span className="rarity-badge legendary">传说</span>
                    : dockView.rarity === "rare" ? <span className="rarity-badge rare">稀有</span> : null}
                  {redactOdds(dockView.title, blind)}
                </span>
                {/* 内测反馈 —— key 让它随事件换牌自动重置回未上报态 */}
                <FeedbackFlag key={dockView.key} game={game} event={dockView} />
              </div>
              {/* 叙事是这款游戏的内容本体，永远不截断：长文在决策位内滚动，
                  一个字都不省略（省略号会把事件的因果吃掉，玩家就没法判断）。 */}
              <Prose className="deck-desc" text={dockView.desc} blind={blind} />
              <DecisionBoard choices={dockView.choices} blind={blind} oracle={oracle} onPick={pick} roll={dockView.roll} />
            </div>
          ) : (
            <div className="dock-idle"><span className="lg-dot" /> 赛季进行中…</div>
          )}
        </div>
      </div>

    </>
  );
}



/** 内测反馈按钮 —— 决策位标题栏右上角的一枚小旗。玩家觉得「这个事件出现在这里
 *  不合理」时一键上报：当前事件 + 当时的完整存档进 feedback 表，开发侧离线判断。
 *  刻意做小、做灰：它是内测期的工具，不能跟标题和赔率抢注意力。
 *  一键即完成，没有表单——填表的摩擦会让上报量掉到零，而「哪个事件被吐槽最多」
 *  这个信号只需要计数 + 存档就够查。 */
function FeedbackFlag({ game, event }: { game: GameState; event: FeedbackEvent }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const label = state === "sent" ? "已上报" : state === "failed" ? "重试" : state === "sending" ? "上报中" : "反馈";
  return (
    <button
      type="button"
      className="dock-flag"
      data-state={state}
      disabled={state !== "idle" && state !== "failed"}
      aria-label={`反馈「${event.title}」这个事件不合理`}
      onClick={() => {
        hapticTap();
        setState("sending");
        submitEventFeedback(game, event).then((ok) => setState(ok ? "sent" : "failed"));
      }}
    >
      <span aria-hidden>⚑</span>{label}
    </button>
  );
}

// ───────────────────────────── summary ─────────────────────────────

function SummaryScreen({ game, store }: { game: GameState; store: ReturnType<typeof useGameStore> }) {
  const { toMenu, startRun, lastSetup, meta } = store;
  // 评级读实绩，不读传承分：传承分 = 实绩 × 难度加成，是货币，跨飞升档不可比。
  // 读它会让 A10 的一座西乙冠军生涯被判成「球神」，同一张卡上「无名之辈」和
  // 「球神」并存。实绩是难度无关的「我做成了什么」，评级只该读它。
  const rank = rankOf(game.rawLegacy);
  // P-A5: achievement celebration popup — the first new achievement earns a
  // full-screen celebration, reusing the milestone overlay style.
  const newAch = (game.newCollectedAchievements ?? []).map((id) => ACHIEVEMENTS.find((a) => a.id === id)!).filter(Boolean);
  const [achIdx, setAchIdx] = useState(0);
  // 成就弹窗排进演出队列 —— 它过去在 SummaryScreen 挂载那一帧就全屏盖上来，
  //  跟生涯页那一串「跑马灯 → 判决牌 → 推进」的秩序完全脱节：玩家点完事件
  //  选项、判决牌收走、屏幕一换就被一张弹窗糊脸，手指还在同一串连点里，弹窗
  //  常被那一下直接吃掉（庆祝没被看见），也把结算页传承数字的跳动撞碎。
  //  现在给它两道拍子，与生涯页同一套「上一段动画落幕再让下一段进场」口径：
  //   · 入场拍：等结算页入场（传承 count-up 900ms）落幕再弹，庆祝落在一块
  //     已经安定的屏上；
  //   · 换拍：多个成就之间留半拍，既是节奏也是防连点——上一张的那一下点击
  //     不会顺手把下一张也关掉。
  //  降低动效偏好下两拍都归零（与 anim-* 在 reduce 下失效同口径）。
  const reduce = usePrefersReducedMotion();
  const [achArmed, setAchArmed] = useState(false);
  useEffect(() => {
    if (reduce) { setAchArmed(true); return; }
    setAchArmed(false);
    const t = setTimeout(() => setAchArmed(true), achIdx === 0 ? ACH_ENTER_MS : ACH_STEP_MS);
    return () => clearTimeout(t);
  }, [achIdx, reduce]);
  const achPopup = achArmed ? newAch[achIdx] : undefined;
  const nextAch = () => { hapticClick(); setAchIdx((i) => i + 1); };
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
  const seniorSeasons = seniorCareerSeasonCount(game.seasons);

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
  const totals = seniorCareerStats(game.seasons);
  const clubCount = new Set(game.seasons.map((s) => s.clubName)).size;
  const peakMv = Math.max(0, ...game.seasons.map((s) => s.marketValue ?? 0));
  // P-POS: 生涯招牌巅峰行——生涯最高招牌数据 + (跨精英线时) 位置称号。
  const sigPeak = careerSignaturePeak(game.player?.position ?? "ST", game.seasons);

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
  //
  // 荣誉陈列 is shared with the summary's 荣誉室 / 效力球队 grids so the two
  // surfaces stay aligned: the share card caps at 15 for space, the summary
  // shows the full career.
  const natConf = natConfOf(game.player?.nationalityId);
  const GOLD_T: readonly Trophy[] = ["world_cup", "continental_primary", "national_continental", "club_world_cup"];
  const PRESTIGE: Record<string, number> = { world_cup: 0, continental_primary: 1, national_continental: 3, club_world_cup: 4, league: 5, cup: 6, continental_secondary: 7 };
  const trophyEntries = (cap?: number): ShareTrophyEntry[] => {
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
    const AWARD_RANK: Record<Award, number> = { ballon_dor: 2, afc_poy: 3, golden_boot: 4, golden_glove: 4, csl_mvp: 6, csl_boot: 8 };
    const entries = [...tMap.values()];
    for (const [a, n] of tally(game.awards)) {
      entries.push({ rank: AWARD_RANK[a], e: { img: awardImgPath(a), emoji: "", label: AWARD_LABEL[a], count: n, gold: a === "ballon_dor" } });
    }
    const sorted = entries.sort((x, y) => x.rank - y.rank || y.e.count - x.e.count).map((x) => x.e);
    return cap ? sorted.slice(0, cap) : sorted;
  };
  const clubEntries = (): ShareClubEntry[] => {
    const clubMap = new Map<string, ShareClubEntry>();
    for (const s of game.seasons) {
      const cur = clubMap.get(s.clubId);
      if (cur) cur.seasons += 1;
      else clubMap.set(s.clubId, { id: s.clubId, crest: clubCrestPath(s.clubId), name: s.clubName, seasons: 1 });
    }
    return [...clubMap.values()];
  };

  const shareCardData = (): ShareCardData => {
    const p = game.player;
    const trophies = trophyEntries(15);

    // national team — caps/goals + the deepest run per cup (世界杯 before 洲际杯).
    let national: ShareCardData["national"] = null;
    if (p) {
      const called = game.seasons.filter((s) => s.national?.calledUp);
      if (called.length > 0) {
        const caps = called.reduce((n, s) => n + (s.national?.caps ?? 0), 0);
        const goals = called.reduce((n, s) => n + (s.national?.goals ?? 0), 0);
        const assists = called.reduce((n, s) => n + (s.national?.assists ?? 0), 0);
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
        national = { line: `${nationName(p.nationalityId)}国家队 ${caps} 场${isGK ? "" : ` · ${goals} 球 · ${assists} 助攻`}`, best };
      }
    }

    const allClubs = clubEntries();

    return {
      name: p?.name ?? "?",
      flagPath: p ? nationFlagPath(p.nationalityId) : null,
      nation: p ? nationName(p.nationalityId) : "",
      posLabel: POS_LABEL[p?.position ?? ""] ?? p?.position ?? "",
      peakOvr: game.maxOverall,
      tier: ovrTier(game.maxOverall),
      seasons: seniorSeasons,
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
  const [archiveOpen, setArchiveOpen] = useState(false);
  // 生涯档案 — the full forensic record (故事/抉择/逐季/成就), one tap away in
  // a bottom sheet so the settlement stays two screens. The sheet scrolls, so
  // the lists render in full (no in-page cap / 展开 toggle).
  const beats = game.careerBeats ?? [];
  const choices = game.choiceLog ?? [];
  const seasonsList = [...game.seasons].reverse();
  // 续停标记（档案逐季）：与账本同源，让回看时也能读出「一次禁赛跨 N 季」。
  const contAges = suspensionContinuationAges(game.seasons);
  const archiveTabs = ["故事线", "抉择", "逐季", "成就"] as const;
  return (
    <div className="flex flex-col gap-3 pt-4 pb-32">
      {/* 本局战果 — the settlement verdict: new record / gap to best.
          指定种子的轮回不结算任何奖励，只显式提示「不计入」，不展示新纪录/差距。 */}
      {game.customSeed ? (
        <div className="card">
          <p className="text-sm m-0 text-warn font-semibold">⚠️ 指定种子 · 本局不结算奖励</p>
          <p className="text-[13px] text-muted m-0 mt-1">传承分仅作展示与分享比较，不计入传承、最佳、飞升与成就。出道台切回「🎲 随机」即可正常结算。</p>
        </div>
      ) : meta.runs > 1 && (
        <div className="card">
          {isBestRun && meta.runs > 1 && <p className="text-sm m-0 text-gold">🏆 新纪录！刷新个人最佳传承分</p>}
          {!isBestRun && bestGap > 0 && <p className="text-sm m-0 text-warn">距最佳还差 <b className="text-text">{bestGap}</b> 传承分</p>}
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
              <FlagImg id={game.player?.nationalityId ?? ""} className="flag-img mr-1.5" />{game.player?.name ?? "?"}
              {game.player?.squadNumber ? <span className="hn-num">#{game.player.squadNumber}</span> : null}
            </div>
            <div className="hero-sub">
              {POS_LABEL[game.player?.position ?? ""] ?? game.player?.position} · {seniorSeasons} 赛季 · {clubCount} 家俱乐部
            </div>
          </div>
        </div>
        {(() => { const traits = personaTags(game.personaTagsEver); return traits.length > 0 && (
          <div className="hero-traits" aria-label="生涯词条">
            {traits.map((t) => (
              <span key={t.label} className={`hero-trait ${TRAIT_TONE_CLASS[t.tone]}`}>
                <b className="ht-label">{t.label}</b>
                <span className="ht-gloss">{t.gloss}</span>
              </span>
            ))}
          </div>
        ); })()}

        {/* 结局横幅：档位色锡纸条 + 档位头衔 + 百分位 + 墓志铭。这是这段生涯被复述的样子。 */}
        <div className="hero-banner" data-tier={ovrTier(game.maxOverall)}>
          <span className="hb-eyebrow">生涯结局</span>
          <h2 className="hb-title">{tierTitle(game.maxOverall)}</h2>
          <p className="hb-pct">巅峰能力超越了 {ovrPercentile(game.maxOverall)}% 的球员</p>
          <p className="hb-epitaph">{epitaph}</p>
        </div>

        {/* P-POS 位置平衡·可见性: 生涯招牌巅峰——与传承分/评级并列的「上限信号」。
            每段生涯都有最佳一季的招牌产出 (后卫零封/组织助攻/前锋进球), 故永远显示;
            位置称号 (钢铁防线/助攻王/金靴级/一夫当关) 只在跨过精英线时才给, 让非前锋
            的巅峰与中锋的金靴同等读作「这是这段生涯的天花板」。金, 但远小于传承分
            字号, 不妨位。 */}
        <div className={`hero-peak${sigPeak.title ? " is-elite" : ""}`}>
          <span className="hp-eyebrow">生涯最佳</span>
          <span className="hp-stat">{sigPeak.value}{sigPeak.unit}{sigPeak.title ? ` · ${sigPeak.title}` : ""}</span>
        </div>

        {/* 传承分揭晓：游戏核心进度货币的计数动画——与档位头衔是两个维度
            （档位=踢得多好，传承分=轮回货币），都留着。 */}
        <div className="hero-legacy">
          <div className="num hero-legacy-num anim-tick">{legacyCount}</div>
          <p className="hero-legacy-label">传承分 · {reason}</p>
          {/* P-ASC-PREMIUM: 飞升局明示含金量构成——溢价被看见才成立（juice）。
              实绩 = 同一生涯按飞升 0 结算；比值即该局兑现的难度含金量。 */}
          {game.ascension > 0 && game.rawLegacy > 0 && (
            <p className="hero-legacy-label">实绩 {game.rawLegacy} · 飞升{game.ascension} 含金量 ×{(game.legacy / game.rawLegacy).toFixed(2)}</p>
          )}
          <p className="hero-rank" style={{ color: rank.color }}>{rank.name}</p>
        </div>
        {/* 告别方式 + 种子合并为一条脚注——两者都是 meta/落款信息，分占两行
            喧宾夺主；合并后 hero 更紧凑，传承分揭晓仍是视觉重心。 */}
        <p className="hero-foot">
          {game.farewellStyle && <>
            <span className="hf-kicker">告别</span>
            <span className="hf-text">{FAREWELL_LABEL[game.farewellStyle]}</span>
          </>}
          <span className="hf-seed">种子 {game.seed}</span>
        </p>
      </div>

      {/* 生涯数据 — 四个最本能的数字一行：出场/进球/助攻 + 巅峰身价（GK 换零封/失球）。
          巅峰OVR 已在 hero 徽章、奖杯/个人荣誉在荣誉室小标题、生涯总薪进档案与分享卡——
          同一个数不在两处出现。 */}
      <StatStrip items={[
        { label: "出场", value: totals.appearances },
        ...(isGK
          ? [{ label: "零封", value: totals.cleanSheets }, { label: "失球", value: totals.goalsConceded }]
          : [{ label: "进球", value: totals.goals }, { label: "助攻", value: totals.assists }]),
        { label: "巅峰身价", value: <span className="text-gold">€{fmtMv(peakMv)}</span> },
      ]} />

      {(() => {
        // 荣誉室 — the trophy cabinet, laid out as the SAME icon grid the share
        // card uses (奖杯 + 个人荣誉 mixed, sorted by prestige, league-context
        // labels so 意甲冠军×4 reads like a career). Reusing the sc-* classes
        // keeps the summary pixel-aligned with the share image, and the chip
        // behind every crest/trophy guarantees dark monochrome art reads.
        // 国家队夺冠（世界杯/洲际杯）也经 s.trophies 流入此处——荣誉归一柜。
        const newT = game.newCollectedTrophies ?? [];
        const entries = trophyEntries();
        if (entries.length === 0 && newT.length === 0) return null;
        return (
          <div className="card">
            <SectionTitle>荣誉室</SectionTitle>
            {entries.length > 0 && (
              <div>
                <p className="lbl-c text-[10px] text-dim m-0 mb-2">
                  奖杯 <span className="text-muted font-normal">· {game.trophies.length} 座</span>
                  {(game.bestStreak ?? 0) >= 2 && <span className="text-gold font-normal"> · 最长 {game.bestStreak} 连冠</span>}
                  {game.awards.length > 0 && <span className="text-muted font-normal"> · 个人荣誉 {game.awards.length} 项</span>}
                </p>
                <div className="sc-trophies" style={{ marginTop: 0 }}>
                  {entries.map((t, i) => <TrophyCell key={`${t.label}-${i}`} t={t} />)}
                </div>
              </div>
            )}
            {newT.length > 0 && (
              <div className="mt-3">
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

      {/* 国家队 — 仅 capped 球员显示。压成一行国际生涯深度：国旗国名 · 出场进球 ·
          最佳战绩。原 6 格 stat-strip（国字号赛季/出场/进球/世界杯×N/洲际杯×N）密度低
          且与荣誉室（夺冠奖杯已在柜）重复，砍成一句；夺冠荣誉归荣誉室，这里只留国字号
          生涯的“深度”——踢了几场、进几个、走过多远。 */}
      {(() => {
        const p = game.player;
        if (!p) return null;
        const called = game.seasons.filter((s) => s.national?.calledUp);
        if (called.length === 0) return null;
        const natGK = p.position === "GK";
        const caps = called.reduce((s, x) => s + (x.national?.caps ?? 0), 0);
        const goals = called.reduce((s, x) => s + (x.national?.goals ?? 0), 0);
        const assists = called.reduce((s, x) => s + (x.national?.assists ?? 0), 0);
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
          <p className="nat-summary">
            <span className="ns-name"><FlagImg id={p.nationalityId} className="flag-img mr-1" />{nationName(p.nationalityId)}国家队</span>
            <span className="ns-sep" aria-hidden>·</span>
            <span className="ns-nums">{caps}场{natGK ? "" : ` · ${goals}球 · ${assists}助`}</span>
            {best && <><span className="ns-sep" aria-hidden>·</span><span className="ns-best">最佳 {best.cup}{best.stage}</span></>}
          </p>
        );
      })()}

      {/* 效力球队 — the clubs the player represented, the crest grid the share
          card uses (crest chip + name + seasons). The journey reads at a glance;
          per-club 年龄/联赛/奖杯/数据 detail lives in the 档案·逐季 tab (one tap),
          so it isn't shown twice on the settlement. */}
      {(() => {
        const clubs = clubEntries();
        if (clubs.length === 0) return null;
        return (
          <div className="card">
            <SectionTitle>效力球队</SectionTitle>
            <div className="sc-clubs" style={{ marginTop: 0 }}>
              {clubs.map((c) => <ClubCell key={c.id} c={c} />)}
            </div>
          </div>
        );
      })()}

      {/* 生涯曲线 — the career arc: per-season OVR (mud→marble), the one shape a
          career is retold by. The goals & market-value charts used to stack two
          more panels here (the same career shown three ways); their peaks now
          ride the caption so the settlement keeps one chart, and the full
          per-season 进球/身价 detail lives in 档案·逐季. */}
      {(() => {
        const seasons = game.seasons;
        const ovrs = seasons.map((s) => s.overall);
        if (seasons.length < 2) return null;
        const metric = isGK ? seasons.map((s) => s.stats.cleanSheets) : seasons.map((s) => s.stats.goals);
        const metricLabel = isGK ? "零封" : "球";
        const maxM = Math.max(1, ...metric);
        const minOvr = Math.min(...ovrs), maxOvr = Math.max(...ovrs);
        const peakOvrIdx = ovrs.lastIndexOf(maxOvr);
        // Non-zero y-window (both bounds on the rail) so a 50→55 climb keeps its
        // real shape instead of reading as a surge; inset so the gilded peak
        // bar + its value label never clip.
        let ovrLo = Math.max(40, minOvr - 3);
        let ovrHi = Math.min(99, maxOvr + 3);
        if (ovrHi - ovrLo < 12) { const mid = (ovrHi + ovrLo) / 2; ovrLo = Math.max(40, Math.round(mid - 6)); ovrHi = Math.min(99, Math.round(mid + 6)); }
        const ovrSpan = Math.max(1, ovrHi - ovrLo);
        const showMv = peakMv > 0;
        return (
          <div className="card career-chart">
            <SectionTitle>生涯曲线</SectionTitle>
            <p className="lbl-c text-[10px] text-dim m-0 mb-2">能力 <span className="text-muted font-normal">· 巅峰 {maxOvr}</span></p>
            <div className="cc-sub" style={{ height: 96 }}>
              <div className="cc-rail cc-rail-range"><span className="cc-max">{ovrHi}</span><span className="cc-max">{ovrLo}</span></div>
              <div className="cc-plot">
                {ovrs.map((v, i) => (
                  <div
                    key={i}
                    className="cc-bar"
                    data-tier={ovrTier(v)}
                    data-peak={i === peakOvrIdx}
                    style={{ height: `${Math.max(5, ((v - ovrLo) / ovrSpan) * 100)}%`, animationDelay: `${i * 45}ms` }}
                    title={`${seasons[i]?.age}岁 · OVR ${v}`}
                  >
                    {(seasons.length <= 6 || i === peakOvrIdx) && <span className="cc-v">{v}</span>}
                  </div>
                ))}
              </div>
            </div>
            <div className="cc-axis">
              {seasons.map((s) => <span key={s.age}>{s.age}</span>)}
            </div>
            {/* The two dropped charts' peaks ride this one caption — the same
                facts, once, without a second and third panel. */}
            <p className="font-mono text-[11px] text-dim mt-3 m-0">
              OVR {minOvr}→{maxOvr} · 单季最高 {maxM} {metricLabel}{showMv ? ` · 身价峰值 €${fmtMv(peakMv)}` : ""}
            </p>
          </div>
        );
      })()}

      {/* 完整生涯档案 — the forensic record (故事/抉择/逐季/成就) is one tap away
          in a bottom sheet, so the settlement stays two screens. The sheet
          scrolls, so the lists render in full (no in-page cap / 展开toggle).
          生涯成就 moved here from the settlement body — new ones still pop up
          fullscreen via achPopup above. */}
      {(() => {
        const hasArchive = beats.length > 0 || choices.length > 0 || seasonsList.length > 0 || earnedAch.length > 0;
        if (!hasArchive) return null;
        return (
          <button className="archive-trigger" onClick={() => setArchiveOpen(true)}>
            <span className="at-label">完整生涯档案</span>
            <span className="at-meta">故事 · 抉择 · 逐季 · 成就</span>
            <IconChevron dir="right" />
          </button>
        );
      })()}

      {/* fixed action dock — the settlement's single control row */}
      <div className="summary-dock">
        <button className="btn-primary dock-primary" onClick={quickRestart}>再来一局</button>
        <button className="btn dock-btn" onClick={() => setShareImgOpen(true)}>分享</button>
        <button className="btn dock-btn" onClick={toMenu}>主菜单</button>
      </div>

      {shareImgOpen && <ShareCardOverlay data={shareCardData()} onClose={() => setShareImgOpen(false)} />}

      {/* 完整生涯档案 sheet — the forensic record, one tap away from the trigger
          above. Four tabs (故事/抉择/逐季/成就) render in full; the sheet scrolls. */}
      <Sheet open={archiveOpen} onClose={() => setArchiveOpen(false)} title="完整生涯档案" tall
        sub={`${archiveTabs[archiveTab]} · 同种子同选择可完整复现`}>
        <div className="grid grid-cols-4 gap-1.5 mb-3">
          {archiveTabs.map((label, i) => (
            <button
              key={label}
              className={`chip text-[11px] px-1 ${archiveTab === i ? "chip-active" : ""}`}
              onClick={() => setArchiveTab(i)}
            >
              {label}
            </button>
          ))}
        </div>
        {archiveTab === 0 && (
          <div className="flex flex-col gap-1.5">
            {beats.map((b, i) => (
              <div key={i} className="story-beat" data-tone={b.tone}>
                <span className="sb-age font-mono text-[11px] text-dim">{b.age}岁</span>
                <span className={`sb-text text-sm ${b.tone === "legendary" ? "text-gold font-semibold" : b.tone === "good" ? "text-text" : b.tone === "bad" ? "text-warn" : "text-muted"}`}>{b.text}</span>
              </div>
            ))}
            {beats.length === 0 && <p className="text-sm text-muted m-0">暂无故事记录</p>}
          </div>
        )}
        {archiveTab === 1 && (
          <div className="flex flex-col gap-2">
            {choices.map((c, i) => {
              // 三态判决：▲赢面 / ◆有得有失 / ▼失手。旧存档无 tone → 按 good 回退。
              const t = c.tone ?? (c.good ? "good" : "bad");
              return (
                <div key={i} className="choice-log-entry">
                  <div className="cle-age font-mono text-[11px] text-dim">{c.age}岁</div>
                  <div className="cle-body">
                    <span className="cle-title font-semibold text-sm">{c.title}</span>
                    <span className="cle-choice text-xs text-accent">→ {c.choice}</span>
                    <Prose className="cle-outcome text-sm text-muted m-0 mt-0.5" text={c.outcome} />
                  </div>
                  <span className={`cle-icon ${t === "good" ? "text-good" : t === "mixed" ? "text-muted-hi" : "text-warn"}`}>{TONE_GLYPH[t]}</span>
                </div>
              );
            })}
            {choices.length === 0 && <p className="text-sm text-muted m-0">暂无抉择记录</p>}
            {choices.length > 0 && (
              <p className="font-mono text-[11px] text-dim m-0 mt-3 text-center">换个种子、换个选择，下一段旅程完全不同。🦋</p>
            )}
          </div>
        )}
        {archiveTab === 2 && (
          <div className="flex flex-col gap-2">
            {seasonsList.map((s, i) => <SeasonRow key={i} s={s} position={game.player?.position} seed={game.seed} natConf={natConfOf(game.player?.nationalityId)} continuation={contAges.has(s.age)} />)}
          </div>
        )}
        {archiveTab === 3 && (
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
            {earnedAch.length === 0 && <p className="text-sm text-muted m-0">本局未达成成就</p>}
          </div>
        )}
      </Sheet>

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
