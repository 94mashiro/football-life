/**
 * App orchestrator — owns the top-level view switch and routes to screen
 * components. State lives in useGameStore (reducer). UI uses Tailwind utilities.
 */
import { useState, useRef, useEffect } from "react";
import { useGameStore } from "./state/store";
import type { PaceMode } from "./engine/run";
import { NATIONS, LEAGUES, ALL_POSITIONS, clubById, ROLE_GROUP, type Position, type RoleGroup } from "./engine/data";
import {
  BLESSINGS, ASCENSIONS, UNLOCKS, isUnlocked,
  PRESTIGE_PERKS, prestigeEligible, prestigeChoices, PRESTIGE_LEGACY_THRESHOLD,
  nearMissChallenges, makeChallenge, challengeSucceeded,
  dailySetup as dailySetupFn, type DailyResult,
  ACHIEVEMENTS, ALL_TROPHY_IDS,
  LEGEND_DRAFTS, type LegendDraft,
  ASCENSION_UNLOCK_REQ, maxAscensionUnlocked,
} from "./meta/legacy";
import type { GameState, Trophy, Award } from "./engine/types";
import { rivalAtAge } from "./engine/rival";
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
const AWARD_LABEL: Record<Award, string> = { ballon_dor: "金球", golden_boot: "金靴", golden_glove: "金手套" };
const ROLE_LABEL: Record<string, string> = {
  starter: "主力", high_rotation: "轮换", low_rotation: "边缘", substitute: "替补", third_keeper: "三门",
};

/** Nation flag emoji for the player card. England uses its subdivision flag. */
const FLAG: Record<string, string> = {
  bra: "🇧🇷", arg: "🇦🇷", fra: "🇫🇷", eng: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", esp: "🇪🇸", ger: "🇩🇪",
  ita: "🇮🇹", por: "🇵🇹", ned: "🇳🇱", bel: "🇧🇪", jpn: "🇯🇵", kor: "🇰🇷",
  chn: "🇨🇳", usa: "🇺🇸", mex: "🇲🇽", tur: "🇹🇷", sco: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  gre: "🇬🇷", egy: "🇪🇬",
};
function flagEmoji(id: string): string { return FLAG[id] ?? ""; }

export default function App() {
  const store = useGameStore();
  const { game } = store;
  // Play owns its own sticky top bar (slim identity strip) so the big FUT card
  // stops pushing the decision below the fold; menu/summary keep the shared Header.
  return (
    <div className="max-w-3xl mx-auto px-5 min-h-full flex flex-col">
      {game && game.phase === "playing" ? (
        <PlayScreen game={game} store={store} />
      ) : (
        <>
          <Header store={store} />
          {!game && <MenuScreen store={store} />}
          {game && game.phase === "summary" && <SummaryScreen game={game} store={store} />}
        </>
      )}
    </div>
  );
}

// ───────────────────────────── shared bits ─────────────────────────────

function TrophyBadge({ t, conf }: { t: Trophy; conf?: string }) {
  const gold = TROPHY_GOLD.includes(t);
  return (
    <span className={`font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded ${
      gold ? "bg-gold/15 text-gold" : "bg-accent/12 text-accent"
    }`}>
      {conf ? trophyLabel(t, conf) : TROPHY_LABEL[t]}
    </span>
  );
}
function AwardBadge({ a }: { a: Award }) {
  return <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gold/20 text-gold">{AWARD_LABEL[a]}</span>;
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

function SeasonRow({ s, fresh = false, position, seed }: { s: GameState["seasons"][number]; fresh?: boolean; position?: Position; seed?: string }) {
  const group: RoleGroup = position ? ROLE_GROUP[position] : "attacker";
  const rating = seasonRating(s, group);
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
            {s.trophies.map((t, i) => <TrophyBadge key={i} t={t} conf={confederationOfLeague(s.leagueId)} />)}
            {s.awards.map((a, i) => <AwardBadge key={`a${i}`} a={a} />)}
            {s.nationalTournaments.map((nt, i) => <TrophyBadge key={`n${i}`} t={nt.trophy} conf={confederationOfLeague(s.leagueId)} />)}
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
  if (total >= 100000) return `${(total / 1000).toFixed(1)}M`;
  if (total >= 1000) return `${Math.round(total)}K`;
  return `${total}K`;
}

function rankOf(score: number) {
  if (score >= 800) return { name: "球神", color: "var(--color-accent)" };
  if (score >= 500) return { name: "传奇", color: "var(--color-code)" };
  if (score >= 300) return { name: "巨星", color: "var(--color-good)" };
  if (score >= 150) return { name: "明星", color: "var(--color-warn)" };
  if (score >= 60) return { name: "球员", color: "var(--color-muted)" };
  return { name: "替补", color: "var(--color-dim)" };
}
/** OVR tier color — one mental model reused for odds/ratings (90+ gold, 80-89 good, 70-79 warn, <70 dim). */
function ovrTierClass(ovr: number): string {
  if (ovr >= 90) return "tier-gold";
  if (ovr >= 80) return "tier-good";
  if (ovr >= 70) return "tier-warn";
  return "tier-dim";
}
/** data-tier label for foil/glow treatments (mud-to-marble). */
function ovrTier(ovr: number): string {
  if (ovr >= 90) return "gold";
  if (ovr >= 80) return "good";
  if (ovr >= 70) return "warn";
  return "dim";
}
function legacyTier(l: number): string {
  if (l >= 800) return "gold";
  if (l >= 500) return "good";
  if (l >= 300) return "warn";
  return "dim";
}
/** Season rating — the achievement number for a season review (SofaScore-style
    5.5–9.5). Position-aware: a striker's rating rides on goals, a GK's on clean
    sheets vs conceded, a defender's on clean sheets. Derived purely from the
    season's real stats + role + honors, so it's deterministic from the seed and
    honest to the football story. Returns null when the player didn't appear
    (suspended / farewell) — you can't rate a season you didn't play. */
function seasonRating(s: GameState["seasons"][number], group: RoleGroup): number | null {
  const { appearances: app, goals, assists, cleanSheets: cs, goalsConceded: gc } = s.stats;
  if (app === 0) return null;
  const gpa = goals / app, apa = assists / app, cpa = cs / app, gcpa = gc / app;
  let r = 6.4;
  // role = minutes/impact: starters grade higher, bench lower (realistic)
  r += s.role === "starter" ? 0.25 : s.role === "high_rotation" ? 0.10
    : s.role === "low_rotation" ? -0.05 : s.role === "substitute" ? -0.15 : -0.25;
  // position-weighted output (per appearance)
  switch (group) {
    case "attacker":  r += gpa * 2.4 + apa * 1.0; break;
    case "creator":   r += apa * 1.8 + gpa * 1.2; break;
    case "support":   r += apa * 1.4 + gpa * 0.9 + (cs > 10 ? 0.2 : 0); break;
    case "defensive": r += cpa * 1.5 + gpa * 0.8 + apa * 0.4; break;
    case "goalkeeper":r += cpa * 2.2 - gcpa * 0.35; break;
  }
  // honors: winning stuff lifts the season's grade
  r += Math.min(0.5, s.trophies.length * 0.12);
  r += s.nationalTournaments.length * 0.12;
  if (s.awards.includes("ballon_dor")) r += 0.5;
  if (s.awards.includes("golden_boot") || s.awards.includes("golden_glove")) r += 0.35;
  if (s.relegated) r -= 0.2;
  return Math.max(5.5, Math.min(9.5, Math.round(r * 10) / 10));
}
/** Rating tier color (reuses the one tier mental model): ≥8.3 gold, ≥7.3 teal, ≥6.5 amber, else dim. */
function ratingTierClass(r: number): string {
  if (r >= 8.3) return "tier-gold";
  if (r >= 7.3) return "tier-good";
  if (r >= 6.5) return "tier-warn";
  return "tier-dim";
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

/** Odds pill class by success probability (green ≥70%, amber 40-69%, red <40%). */
function oddsClass(p: number): string {
  if (p >= 0.7) return "odds-good";
  if (p >= 0.4) return "odds-warn";
  return "odds-danger";
}
/** Color-only odds tier (no pill chrome) for the big decision-core % numeral. */
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

/** Next career milestone the player is climbing toward — the "horizon pull." */
function nextMilestone(age: number, overall: number): string {
  // World Cup years: 19, 23, 27, 31, ... (age-19) % 4 === 0
  const nextWc = (() => {
    let a = age;
    for (let i = 0; i < 5; i++) { if ((a - 19) % 4 === 0 && a >= 19) return a; a++; }
    return null;
  })();
  // Decisive penalty boss: ages 21, 25 (starter, OVR≥75)
  const nextDp = [21, 25].find((a) => a >= age && a - age <= 2);
  if (overall >= 75 && nextDp !== undefined && nextDp - age <= 1) return `⚡ 决胜点球 ${nextDp} 岁将至 · 冠军一念之间`;
  if (overall < 75 && age < 28) return `攀升 · 冲击主力与 75 OVR`;
  if (nextWc !== null && nextWc - age <= 2) return `世界杯年 ${nextWc} 岁逼近 · 国家队召唤在即`;
  if (overall < 85 && age < 30) return `黄金期 · 冲击 85 OVR 与洲际荣誉`;
  if (overall < 90 && age < 32) return `巅峰 · 金球之争与 90 OVR`;
  if (age < 35) return `收割期 · 堆积奖杯与个人荣誉`;
  if (age < 38) return `老将 · 与时间赛跑`;
  return `告别 · 传奇的最后一舞`;
}

/** Form/streak label from the last few seasons' goals — the "momentum pull." */
function formLabel(game: GameState): { text: string; tone: "hot" | "ok" | "cold" } {
  const recent = game.seasons.slice(-3);
  if (recent.length < 2) return { text: "起步阶段", tone: "ok" };
  const pos = game.player?.position ?? "ST";
  const isScorer = ["ST", "LW", "RW", "CAM"].includes(pos);
  if (!isScorer) {
    const conceded = recent.reduce((s, x) => s + x.stats.goalsConceded, 0);
    if (conceded <= recent.length * 15) return { text: "防线稳固 · 零封不断", tone: "hot" };
    if (conceded >= recent.length * 35) return { text: "后防吃紧 · 亟需止血", tone: "cold" };
    return { text: "防守稳健", tone: "ok" };
  }
  const goals = recent.reduce((s, x) => s + x.stats.goals, 0);
  const perSeason = goals / recent.length;
  if (perSeason >= 25) return { text: `射手榜领跑 · 近期 ${(goals / recent.length).toFixed(0)} 球/季`, tone: "hot" };
  if (perSeason >= 10) return { text: `状态稳定 · 近期 ${(goals / recent.length).toFixed(0)} 球/季`, tone: "ok" };
  return { text: `进球荒 · 近期仅 ${(goals / recent.length).toFixed(0)} 球/季`, tone: "cold" };
}

/** Career progress bar (16 → 40) — the Zeigarnik horizon pull. Extracted so the
    sticky play top bar and the shared header can both render it. */
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

/** Career progress bar (16 → 40) — the Zeigarnik horizon pull. Extracted so the
    sticky play top bar and the shared header can both render it. */
function CareerBar({ game }: { game: GameState }) {
  const p = game.player!;
  const pct = Math.min(100, Math.max(0, ((p.age - 16) / (40 - 16)) * 100));
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between font-mono text-[10px] text-dim mb-1">
        <span>16 青训</span>
        <span>{p.age} 岁 · 第 {game.seasons.length} 赛季</span>
        <span>40 退役</span>
      </div>
      <div className="career-bar"><div style={{ width: `${pct}%` }} /></div>
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
    <header className="sticky top-0 z-30 -mx-5 px-5 pt-5 pb-3 bg-ink/85 backdrop-blur border-b border-line">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-xl font-bold tracking-tight m-0">绿茵轮回</h1>
          <span className="font-mono text-[11px] text-accent tracking-[0.1em] uppercase">roguelike football sim</span>
        </div>
        <div className="flex gap-4 items-center font-mono text-xs text-muted flex-wrap">
          <span>传承 <b className="text-text">{" "}{meta.totalLegacy}</b></span>
          <span>最佳 <b className="text-text">{" "}{meta.bestRun}</b></span>
          <span>飞升 <b className="text-text">{" "}{meta.ascension}</b></span>
          {meta.prestige > 0 && <span className="text-gold">轮回 <b className="text-gold">{" "}{meta.prestige}</b></span>}
          {game && <span className="text-accent">seed: {game.seed}</span>}
        </div>
      </div>
      {game && game.player && <CareerBar game={game} />}
    </header>
  );
}

// ───────────────────────────── menu ─────────────────────────────

const NAV_TABS = [["play", "开始", "⚽"], ["blessings", "祝福", "✨"], ["ascension", "飞升", "🚀"], ["prestige", "轮回", "♻️"], ["hall", "殿堂", "🏆"]] as const;
type MenuTab = "play" | "blessings" | "ascension" | "prestige" | "hall";

function BottomNav({ tab, setTab }: { tab: MenuTab; setTab: (t: MenuTab) => void }) {
  return (
    <nav className="bottom-nav" aria-label="主导航">
      {NAV_TABS.map(([k, label, ico]) => (
        <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)} aria-current={tab === k ? "page" : undefined}>
          <span className="nav-ico">{ico}</span>
          {label}
        </button>
      ))}
    </nav>
  );
}

function MenuScreen({ store }: { store: ReturnType<typeof useGameStore> }) {
  const { meta, startRun, newSeed, dailySeed, lastSetup, buyBlessing, setAscension, archive, clearArchive, prestige, daily, dailyStreak, togglePurist, toggleSound, loginBonus } = store;
  const [tab, setTab] = useState<MenuTab>("play");
  // setup state lifted here so the start CTA can stay fixed and always reachable
  const [seed, setSeed] = useState(() => newSeed());
  const [nat, setNat] = useState(lastSetup?.nationalityId ?? "bra");
  const [pos, setPos] = useState<Position>(lastSetup?.position ?? "ST");
  const [league, setLeague] = useState(lastSetup?.leagueId ?? "brasileirao");
  const [pace, setPace] = useState<PaceMode>((lastSetup?.pace as PaceMode) ?? "normal");
  const begin = () => startRun({ seed, nationalityId: nat, position: pos, leagueId: league, blessings: meta.ownedBlessings, ascension: meta.ascension, pace });
  // P-A6/P-A163: read the FULL setup from the URL hash on MOUNT — lives in
  // MenuScreen (always mounted) not SetupForm, so a brand-new TikTok visitor
  // (meta.runs===0 → SetupForm isn't rendered, only FirstRunGuide) still gets
  // the shared career auto-started. This is THE growth path: link → career.
  // Encoding: #s=<seed>&n=<nat>&p=<pos>&l=<league>&m=<pace> (legacy #seed= ok).
  // Full setup (s+n+p+l) auto-starts; seed-only prefills the seed field.
  useEffect(() => {
    const h = window.location.hash.slice(1);
    if (!h) return;
    const params = new URLSearchParams(h);
    const s = params.get("s") ?? params.get("seed");
    const n = params.get("n");
    const p = params.get("p") as Position | null;
    const l = params.get("l");
    const m = params.get("m") as PaceMode | null;
    const validPos = (["GK","CB","LB","RB","CDM","CM","LM","RM","CAM","LW","RW","ST"] as const);
    const okSeed = !!(s && /^[a-z0-9]+$/i.test(s));
    const okNat = !!(n && NATIONS.some((x) => x.id === n));
    const okPos = !!(p && validPos.includes(p));
    const okLeague = !!(l && LEAGUES.some((x) => x.id === l));
    const okPace = !!(m && (["long","normal","express"] as const).includes(m));
    if (okSeed) setSeed(s!.toLowerCase());
    if (okNat) setNat(n!);
    if (okPos) setPos(p!);
    if (okLeague) setLeague(l!);
    if (okPace) setPace(m!);
    if (okSeed && okNat && okPos && okLeague) {
      startRun({
        seed: s!.toLowerCase(), nationalityId: n!, position: p!, leagueId: l!,
        blessings: meta.ownedBlessings, ascension: meta.ascension,
        pace: (okPace ? m! : "normal") as PaceMode, permPerks: meta.permPerks,
      });
    }
    history.replaceState(null, "", window.location.pathname);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // P4: daily challenge — fixed seed + fixed setup, everyone plays the same career today.
  const today = new Date().toISOString().slice(0, 10);
  const todaysSeed = dailySeed(today);
  const ds = dailySetupFn(today);
  const todaysResult = daily.find((d) => d.date === today);
  const streak = dailyStreak(daily);
  const startDaily = () => {
    startRun({ seed: todaysSeed, nationalityId: ds.nationalityId, position: ds.position, leagueId: ds.leagueId, blessings: meta.ownedBlessings, ascension: meta.ascension, pace: "normal", permPerks: meta.permPerks });
  };

  return (
    <div className="flex flex-col gap-3 pt-4 pb-32">
      <h2 className="text-[26px] font-bold tracking-tight m-0 mb-1.5">每一次轮回，都是全新的传奇</h2>

      {/* P-A121: daily login bonus banner — DAU driver */}
      {(loginBonus.bonusLegacy ?? 0) > 0 && (
        <div className="card daily-card" style={{ background: "linear-gradient(135deg, rgba(184,255,61,0.10), rgba(125,211,252,0.06))" }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <SectionTitle>🎁 每日签到</SectionTitle>
              <p className="text-sm m-0 text-muted">
                连续第 <b className="text-gold">{loginBonus.consecutiveDays}</b> 天 ·
                今日获得 <b className="text-accent">+{loginBonus.bonusLegacy}</b> 传承分
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-[11px] text-dim m-0">累计签到 {loginBonus.totalLogins} 天</p>
              <p className="font-mono text-[10px] text-dim m-0">明天: +{Math.min(30, Math.max(3, loginBonus.consecutiveDays + 1))} 传承</p>
            </div>
          </div>
        </div>
      )}
      <p className="text-muted m-0 mb-6 max-w-[56ch]">从 16 岁青训踢到退役。每个决策改变命运，死亡是终点但传承永存。种子决定一切——同一颗种子永远跑出同一生涯，可分享、可复盘。<b className="text-accent">151个真实足球故事</b>等待你的选择。</p>

      {/* P-A13: hero showcase — the "惊艳第一眼". For returning players, surface
          their best rank as a glowing foil card; for newcomers, a teaser. */}
      <HeroShowcase meta={meta} rankOf={rankOf} />

      {meta.runs === 0 && tab === "play" && (
        <FirstRunGuide onStart={() => startRun({ seed: newSeed(), nationalityId: "bra", position: "ST", leagueId: "brasileirao", blessings: meta.ownedBlessings, ascension: 0, pace: "normal", permPerks: meta.permPerks })} />
      )}

      {tab === "play" && (
        <DailyChallengeCard
          seed={todaysSeed} setup={ds} todaysResult={todaysResult} streak={streak}
          onStart={startDaily} rankOf={rankOf}
        />
      )}

      {tab === "play" && (
        <LegendDraftPicker onStart={(d) => startRun({ seed: d.seed, nationalityId: d.nationalityId, position: d.position, leagueId: d.leagueId, blessings: meta.ownedBlessings, ascension: meta.ascension, pace: d.pace, permPerks: meta.permPerks })} />
      )}

      {tab === "play" && (
        <SetupForm meta={meta} newSeed={newSeed} dailySeed={dailySeed}
          seed={seed} setSeed={setSeed} nat={nat} setNat={setNat} pos={pos} setPos={setPos}
          league={league} setLeague={setLeague} pace={pace} setPace={setPace} onTogglePurist={togglePurist} onToggleSound={toggleSound} />
      )}
      {tab === "blessings" && <BlessingShop meta={meta} buyBlessing={buyBlessing} />}
      {tab === "ascension" && <AscensionPicker meta={meta} setAscension={setAscension} />}
      {tab === "prestige" && <PrestigeScreen meta={meta} prestige={prestige} />}
      {tab === "hall" && <HallOfFame meta={meta} />}

      {tab === "play" && (
        <div className="start-cta-bar">
          <button className="btn-primary start-cta px-6 py-3.5 text-base" onClick={begin}>开始生涯 →</button>
        </div>
      )}
      {meta.runs > 0 && (
        <div className="card mt-2">
          <SectionTitle>历史</SectionTitle>
          <StatStrip items={[
            { label: "累计轮回", value: meta.runs },
            { label: "总传承", value: meta.totalLegacy },
            { label: "最佳单局", value: meta.bestRun },
            { label: "最佳评级", value: <span style={{ color: rankOf(meta.bestRun).color }}>{rankOf(meta.bestRun).name}</span> },
          ]} />
        </div>
      )}
      {(() => {
        const next = UNLOCKS
          .filter((u) => !meta.unlocked.includes(u.id) && meta.totalLegacy < u.reqLegacy)
          .sort((a, b) => a.reqLegacy - b.reqLegacy)[0];
        if (!next) return null;
        const need = next.reqLegacy - meta.totalLegacy;
        return (
          <div className="card mt-2 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="font-mono text-[11px] font-semibold tracking-[0.16em] uppercase text-gold m-0">下一个解锁</p>
              <p className="text-sm m-0 mt-1"><b>{next.name}</b> · {next.desc}</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-accent text-lg m-0">还需 {need} 传承</p>
              <p className="font-mono text-[11px] text-dim m-0">{next.reqLegacy} 总传承达成</p>
            </div>
          </div>
        );
      })()}

      {tab === "play" && <DailyLeaderboard daily={daily} rankOf={rankOf} />}

      {archive.length > 0 && (
        <div className="card mt-2">
          <div className="flex items-center justify-between mb-2.5">
            <SectionTitle>生涯历史档案 · 共 {archive.length} 段</SectionTitle>
            <button className="btn-sm" onClick={() => { if (confirm("清空后这些记录找不回来了，确定？")) clearArchive(); }}>清空</button>
          </div>
          <div className="flex flex-col gap-2">
            {archive.slice(0, 8).map((a, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-2.5 items-center px-3 py-2 bg-surface border border-line rounded-md text-sm">
                <div className="min-w-0">
                  <div className="text-text flex items-center gap-2">
                    {a.name} <span className="font-mono text-[10px] text-dim">{a.position} · {nationName(a.nationalityId)}</span>
                  </div>
                  <span className="font-mono text-[11px] text-muted">{a.seasons}赛季 · 巅峰 {a.maxOverall} · {a.trophies}奖杯</span>
                </div>
                <span className="font-mono text-xs" style={{ color: rankOf(a.legacy).color }}>{a.rank}</span>
                <span className="font-mono text-sm font-bold text-accent">{a.legacy}</span>
              </div>
            ))}
          </div>
          <p className="font-mono text-[11px] text-dim mt-2.5">档案只存在这台设备的浏览器里。种子 {archive[0]!.seed} 可复现任意一局。</p>
        </div>
      )}

      <BottomNav tab={tab} setTab={setTab} />
    </div>
  );
}

function SetupForm({ meta, newSeed, dailySeed, seed, setSeed, nat, setNat, pos, setPos, league, setLeague, pace, setPace, onTogglePurist, onToggleSound }: {
  meta: ReturnType<typeof useGameStore>["meta"];
  newSeed: () => string;
  dailySeed: (dateStr: string) => string;
  seed: string; setSeed: (v: string) => void;
  nat: string; setNat: (v: string) => void;
  pos: Position; setPos: (v: Position) => void;
  league: string; setLeague: (v: string) => void;
  pace: PaceMode; setPace: (v: PaceMode) => void;
  onTogglePurist: () => void;
  onToggleSound: () => void;
}) {
  const freeNations = ["bra", "arg", "fra", "eng", "esp", "ger", "ita", "por", "ned", "bel", "chn"];
  const locked = (id: string) => !isUnlocked(meta, `nation:${id}`) && !freeNations.includes(id);

  const today = new Date().toISOString().slice(0, 10);
  const todaysSeed = dailySeed(today);
  const copySeed = () => {
    const text = `${seed}`;
    navigator.clipboard?.writeText(text).catch(() => {});
  };
  // P-A6/P-A163: the URL-hash read + auto-start now lives in MenuScreen (always
  // mounted, even for first-time visitors who see FirstRunGuide instead of this
  // form). This SetupForm no longer reads the hash — it just builds share URLs.
  // Build a share URL encoding the full setup so the recipient reproduces this
  // exact career. (seed-only legacy #seed= still accepted on read above.)
  const shareUrl = () =>
    `${window.location.origin}${window.location.pathname}#s=${seed}&n=${nat}&p=${pos}&l=${league}&m=${pace}`;
  // share a link with the seed baked into the URL — the TikTok zero-friction loop.
  const shareLink = () => {
    navigator.clipboard?.writeText(shareUrl()).catch(() => {});
  };
  // P-A122: share a challenge link with full setup baked in — the viral K-factor driver.
  const shareChallenge = () => {
    const url = shareUrl();
    const natName = NATIONS.find((n) => n.id === nat)?.name ?? "?";
    const leagueName = LEAGUES.find((l) => l.id === league)?.name ?? "?";
    const text = `⚽ 绿茵轮回 · 我挑战你\n${natName} ${pos} · ${leagueName}\n种子 ${seed}\n同种子=同生涯 你能超越我吗？\n${url}\n#绿茵轮回 #足球挑战`;
    navigator.clipboard?.writeText(text).catch(() => {});
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="card">
        <SectionTitle>种子 SEED</SectionTitle>
        <div className="flex gap-3 items-center">
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12))}
            className="flex-1 bg-surface-2 border border-line rounded-md px-3 py-2.5 text-accent font-mono text-[15px] outline-none focus:border-accent"
          />
          <button className="btn-sm" onClick={() => setSeed(newSeed())}>随机</button>
          <button className="btn-sm" onClick={copySeed}>复制</button>
          <button className="btn-sm" onClick={shareLink}>分享链接</button>
          <button className="btn-sm" onClick={shareChallenge}>挑战好友</button>
        </div>
        <button className="btn-sm mt-2.5 text-left" onClick={() => setSeed(todaysSeed)}>
          <span className="text-accent">今日种子</span> <span className="font-mono text-dim">{todaysSeed}</span>
          <span className="block font-normal text-[11px] text-dim mt-0.5">每天同一颗种子，可与好友比拼同一生涯。</span>
        </button>
        <p className="font-mono text-[11px] text-dim mt-2">同一种子 + 同一选择 = 完全相同的生涯。可分享给好友挑战。</p>

        {/* pace merged inline — was its own card; tighter, one less scroll stop */}
        <div className="mt-3.5 pt-3 border-t border-line-soft">
          <SectionTitle>节奏</SectionTitle>
          <div className="grid grid-cols-3 gap-2">
            {([["long", "沉浸", "每赛季一次决策"], ["normal", "标准", "每两赛季一次决策"], ["express", "速通", "每三赛季一次决策"]] as const).map(([m, label, hint]) => (
              <button key={m} className={`chip ${pace === m ? "chip-active" : ""}`} onClick={() => setPace(m)}>
                {label}
                <span className="block text-[10px] text-dim mt-0.5">{hint}</span>
              </button>
            ))}
          </div>
          {/* P-A6: purist mode toggle — hide odds for hardcore tension. */}
          <div className="grid grid-cols-2 gap-2 mt-3">
            <button className={`chip ${meta.puristMode ? "chip-active" : ""}`} onClick={onTogglePurist}>
              <span className="font-semibold">{meta.puristMode ? "盲选 · 开" : "盲选 · 关"}</span>
              <span className="block text-[10px] text-dim mt-0.5">隐藏概率</span>
            </button>
            <button className={`chip ${meta.soundOn !== false ? "chip-active" : ""}`} onClick={onToggleSound}>
              <span className="font-semibold">{meta.soundOn !== false ? "🔊 音效 · 开" : "🔇 音效 · 关"}</span>
              <span className="block text-[10px] text-dim mt-0.5">合成音效</span>
            </button>
          </div>
        </div>
      </div>

      <div className="card-quiet">
        <SectionTitle>国籍</SectionTitle>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))" }}>
          {NATIONS.map((n) => {
            const lk = locked(n.id);
            return (
              <button key={n.id} disabled={lk} onClick={() => !lk && setNat(n.id)}
                className={`chip ${nat === n.id ? "chip-active" : ""} ${lk ? "opacity-35 cursor-not-allowed" : ""}`}>
                <span className="text-base mr-1">{flagEmoji(n.id)}</span>{n.name}
                {lk && <span className="block text-[10px] text-dim mt-0.5">需 {UNLOCKS.find((u) => u.id === `nation:${n.id}`)?.reqLegacy} 传承</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="card-quiet">
        <SectionTitle>位置</SectionTitle>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))" }}>
          {ALL_POSITIONS.map((p) => (
            <button key={p} className={`chip ${pos === p ? "chip-active" : ""}`} onClick={() => setPos(p)}>{p}</button>
          ))}
        </div>
        <p className="font-mono text-[11px] text-dim mt-2">前锋更易刷进球与金球；后卫/门将靠冠军堆荣誉。</p>
      </div>

      <div className="card-quiet">
        <SectionTitle>起步联赛</SectionTitle>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))" }}>
          {LEAGUES.map((l) => (
            <button key={l.id} className={`chip ${league === l.id ? "chip-active" : ""}`} onClick={() => setLeague(l.id)}>
              {l.name}
              <span className="block text-[10px] text-dim mt-0.5">{l.tier === 1 ? "顶级" : "次级"} · {"★".repeat(Math.max(l.domRep, l.contRep) + 1)}</span>
            </button>
          ))}
        </div>
        <p className="font-mono text-[11px] text-dim mt-2">弱联赛易当主力但奖杯概率低；强联赛荣誉高但起步是替补。</p>
      </div>
    </div>
  );
}

/** P-A13: the menu hero — a glowing foil card showcasing the player's best
 *  achievement (the "惊艳第一眼" that a TikTok scroller screenshots). For
 *  returning players it shows their peak rank; for newcomers, a teaser of
 *  the climb from mud to marble. */
function HeroShowcase({ meta, rankOf }: {
  meta: ReturnType<typeof useGameStore>["meta"];
  rankOf: (s: number) => { name: string; color: string };
}) {
  const rank = rankOf(meta.bestRun);
  const hasRuns = meta.runs > 0;
  return (
    <div className="hero-showcase anim-pop" data-tier={legacyTier(meta.bestRun)}>
      <div className="hs-content">
        {hasRuns ? (
          <>
            <p className="font-mono text-[11px] font-semibold tracking-[0.16em] uppercase text-accent m-0">你的巅峰</p>
            <h3 className="text-[32px] font-bold tracking-tight m-0" style={{ color: rank.color }}>{rank.name}</h3>
            <div className="flex gap-4 mt-1 font-mono text-xs text-muted">
              <span>最佳单局 <b className="text-text">{meta.bestRun}</b></span>
              <span>累计 <b className="text-text">{meta.totalLegacyAllTime}</b> 传承</span>
              <span>{meta.runs} 段生涯</span>
            </div>
            {meta.prestige > 0 && <span className="pill pill-gold mt-2 inline-block">♻️ {meta.prestige} 次轮回</span>}
          </>
        ) : (
          <>
            <p className="font-mono text-[11px] font-semibold tracking-[0.16em] uppercase text-accent m-0">从青训到传奇</p>
            <h3 className="text-[32px] font-bold tracking-tight m-0 text-gradient">泥到大理石</h3>
            <p className="text-sm text-muted m-0 mt-1.5 max-w-[42ch]">16 岁起步 OVR 50，一步步爬到 90+。每段生涯都是不同的传奇。</p>
          </>
        )}
      </div>
    </div>
  );
}

/** P-A5: first-run onboarding — a TikTok visitor's first 30 seconds. One tap
 *  into a recommended default run (Brazilian ST, the most intuitive arc), with
 *  a 3-step "how it works" so they understand the loop before the first decision. */
function FirstRunGuide({ onStart }: { onStart: () => void }) {
  return (
    <div className="card first-run-card" style={{ background: "linear-gradient(135deg, rgba(125,211,252,0.10), rgba(34,197,94,0.06))" }}>
      <SectionTitle>👋 新玩家？30 秒上手</SectionTitle>
      <div className="flex flex-col gap-2.5 mb-3.5">
        <p className="text-sm m-0"><b className="text-accent">1.</b> 你是一名 16 岁青训球员，从弱队起步。</p>
        <p className="text-sm m-0"><b className="text-accent">2.</b> 每个赛季末做<b>一个决策</b>（转会/特训/带伤…），选择改变命运。</p>
        <p className="text-sm m-0"><b className="text-accent">3.</b> 踢到退役，按巅峰+奖杯算<b>传承分</b>，解锁更多起点。</p>
      </div>
      <button className="btn-primary w-full py-3.5 text-base" onClick={onStart}>一键开始第一局 → 巴西前锋</button>
      <p className="font-mono text-[11px] text-dim m-0 mt-2 text-center">推荐新手：巴西前锋，进球多、成长快、好上手。</p>
    </div>
  );
}

/** P4: the daily-challenge hero card — same seed + setup for everyone today.
 *  Surfaces today's result (if played), the streak, and a one-tap start. */
function DailyChallengeCard({ seed, setup, todaysResult, streak, onStart, rankOf }: {
  seed: string; setup: { position: string; nationalityId: string; leagueId: string };
  todaysResult?: DailyResult; streak: number; onStart: () => void;
  rankOf: (s: number) => { name: string; color: string };
}) {
  const leagueName = LEAGUES.find((l) => l.id === setup.leagueId)?.name ?? "?";
  return (
    <div className="card daily-card" style={{ background: "linear-gradient(135deg, rgba(251,191,36,0.10), rgba(125,211,252,0.06))" }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <SectionTitle>⚡ 今日挑战 · 全员同条件</SectionTitle>
          <p className="text-sm m-0 text-muted">
            <span className="text-text font-semibold">{flagEmoji(setup.nationalityId)} {setup.position} · {leagueName}</span>
            <span className="text-dim mx-1.5">|</span>
            种子 <span className="font-mono text-accent">{seed}</span>
          </p>
          <p className="font-mono text-[11px] text-dim m-0 mt-1.5">同种子 + 同选择 = 同生涯。把你的传承分发给好友比拼。</p>
        </div>
        <div className="text-right">
          {todaysResult ? (
            <>
              <div className="font-mono text-2xl font-bold" style={{ color: rankOf(todaysResult.legacy).color }}>{todaysResult.legacy}</div>
              <p className="font-mono text-[11px] text-dim m-0">今日已挑战 · {rankOf(todaysResult.legacy).name}</p>
              <button className="btn-sm btn-primary mt-2" onClick={onStart}>再战今日 ↻</button>
            </>
          ) : (
            <button className="btn-primary px-5 py-3" onClick={onStart}>开始今日挑战 →</button>
          )}
        </div>
      </div>
      {streak > 0 && (
        <div className="mt-3 pt-3 border-t border-line-soft flex items-center gap-2 font-mono text-[11px]">
          <span className="text-gold">🔥 连续 {streak} 天</span>
          <span className="text-dim">每日挑战不间断</span>
        </div>
      )}
    </div>
  );
}

/** P8: legend draft picker — scripted starting scenarios. Each is a fixed seed
 *  + preset setup representing a dramatic arc (galáctico youth, relegation
 *  fight, late bloomer...). One-tap start into a curated story. */
function LegendDraftPicker({ onStart }: { onStart: (d: LegendDraft) => void }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? LEGEND_DRAFTS : LEGEND_DRAFTS.slice(0, 4);
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <SectionTitle>🎬 传奇剧本</SectionTitle>
        <button className="btn-sm" onClick={() => setExpanded((v) => !v)}>{expanded ? "收起" : `全部 ${LEGEND_DRAFTS.length} 个`}</button>
      </div>
      <p className="font-mono text-[11px] text-dim m-0 mb-3">预设起点 + 固定种子，每个都是一段不同的传奇故事。一键开踢。</p>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
        {shown.map((d) => {
          const leagueName = LEAGUES.find((l) => l.id === d.leagueId)?.name ?? "?";
          return (
            <button key={d.id} onClick={() => onStart(d)} className="bg-surface-2 border border-line rounded-md p-3 text-left hover:border-accent transition-colors">
              <div className="flex items-center gap-2">
                <span className="text-lg">{d.icon}</span>
                <strong className="text-sm">{d.name}</strong>
              </div>
              <p className="text-[11px] text-muted m-0 mt-1.5 leading-snug min-h-[32px]">{d.desc}</p>
              <p className="font-mono text-[10px] text-dim m-0 mt-2">{flagEmoji(d.nationalityId)} {d.position} · {leagueName} · {d.pace === "long" ? "沉浸" : d.pace === "express" ? "速通" : "标准"}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** P4: the daily leaderboard — the player's own past daily results, a local
 *  streak/progress record they can screenshot and compare with friends. */
function DailyLeaderboard({ daily, rankOf }: { daily: readonly DailyResult[]; rankOf: (s: number) => { name: string; color: string } }) {
  if (daily.length === 0) return null;
  const bestLegacy = Math.max(...daily.map((d) => d.legacy));
  const avgLegacy = Math.round(daily.reduce((s, d) => s + d.legacy, 0) / daily.length);
  return (
    <div className="card mt-2">
      <SectionTitle>每日战绩 · {daily.length} 天</SectionTitle>
      <div className="flex gap-3 mb-3">
        <div className="flex-1 text-center bg-surface-2 border border-line rounded-md py-2">
          <div className="font-mono text-lg text-gold">{bestLegacy}</div>
          <p className="font-mono text-[10px] text-dim m-0">最佳</p>
        </div>
        <div className="flex-1 text-center bg-surface-2 border border-line rounded-md py-2">
          <div className="font-mono text-lg text-accent">{avgLegacy}</div>
          <p className="font-mono text-[10px] text-dim m-0">平均</p>
        </div>
        <div className="flex-1 text-center bg-surface-2 border border-line rounded-md py-2">
          <div className="font-mono text-lg text-text">{daily.length}</div>
          <p className="font-mono text-[10px] text-dim m-0">总天数</p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {daily.slice(0, 8).map((d) => (
          <div key={d.date} className="grid grid-cols-[auto_1fr_auto_auto] gap-2.5 items-center px-3 py-2 bg-surface border border-line rounded-md text-sm">
            <span className="font-mono text-[11px] text-dim">{d.date}</span>
            <span className="font-mono text-[11px] text-muted truncate">{d.seasons}赛季 · 巅峰 {d.maxOverall} · {d.trophies}奖杯</span>
            <span className="font-mono text-xs" style={{ color: rankOf(d.legacy).color }}>{d.rank}</span>
            <span className="font-mono text-sm font-bold text-accent">{d.legacy}</span>
          </div>
        ))}
      </div>
      <p className="font-mono text-[11px] text-dim mt-2.5">每日种子人人相同——截图发给好友，比比谁的传承分更高。</p>
    </div>
  );
}

function BlessingShop({ meta, buyBlessing }: { meta: ReturnType<typeof useGameStore>["meta"]; buyBlessing: (id: string) => void }) {
  return (
    <div className="card">
      <p className="text-sm text-muted m-0 mb-3.5">用传承点购买永久祝福，每轮回都生效。已拥有 {meta.ownedBlessings.length}/{BLESSINGS.length}。</p>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
        {BLESSINGS.map((b) => {
          const owned = meta.ownedBlessings.includes(b.id);
          const affordable = meta.totalLegacy >= b.cost;
          const unlocked = isUnlocked(meta, `blessing:${b.id}`);
          return (
            <div key={b.id} className="bg-surface-2 border border-line rounded-md p-3.5">
              <div className="flex justify-between items-baseline">
                <strong>{b.name}</strong>
                <span className="pill pill-accent">{b.cost}</span>
              </div>
              <p className="text-sm text-muted m-0 mt-1.5 mb-2.5 min-h-8">{b.desc}</p>
              {owned ? <span className="pill pill-gold">已拥有</span>
                : !unlocked ? <span className="pill opacity-60">需解锁</span>
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
            <div className="font-mono text-2xl text-gold m-0">{meta.prestige}</div>
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
            <div className="font-mono text-2xl text-gold">{trophyProgress}/{ALL_TROPHY_IDS.length}</div>
            <p className="font-mono text-[11px] text-dim m-0 mt-1">奖杯种类</p>
          </div>
          <div className="bg-surface-2 border border-line rounded-md p-3 text-center">
            <div className="font-mono text-2xl text-accent">{achProgress}/{ACHIEVEMENTS.length}</div>
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

function PlayTopBar({ game, onRetire, showCard, onToggleCard }: {
  game: GameState; onRetire: () => void; showCard: boolean; onToggleCard: () => void;
}) {
  // Sticky, always-visible identity: career bar + slim player strip. The big
  // foil card lives in the scrolling content (on demand) so it never pushes the
  // decision below the fold.
  return (
    <header className="sticky top-0 z-30 -mx-5 px-5 pt-3.5 pb-2.5 bg-ink/85 backdrop-blur border-b border-line">
      <CareerBar game={game} />
      <IdentityStrip game={game} onRetire={onRetire} expanded={showCard} onToggle={onToggleCard} />
    </header>
  );
}

/** Slim always-visible identity: flag + tiered OVR + name + club. Tap to expand
    the full foil card. Mud-to-marble via tier-tinted border + OVR numeral color. */
function IdentityStrip({ game, onRetire, expanded, onToggle }: {
  game: GameState; onRetire: () => void; expanded: boolean; onToggle: () => void;
}) {
  const p = game.player!;
  const club = game.currentClubId ? clubById(game.currentClubId).name : "—";
  return (
    <div className="flex items-center gap-2.5 mt-2.5">
      <button onClick={onToggle} className="identity-strip flex-1 min-w-0" data-tier={ovrTier(p.overall)} aria-expanded={expanded} aria-label="展开球员卡">
        <span className="is-flag">{flagEmoji(p.nationalityId)}</span>
        <span className={`is-ovr ${ovrTierClass(p.overall)}`}>{p.overall}</span>
        <span className="is-pos">{p.position}</span>
        <span className="is-name">{p.name}</span>
        <span className="is-sep">·</span>
        <span className="is-club">{club}</span>
        <span className="is-chev">{expanded ? "▴" : "▾"}</span>
      </button>
      <button className="btn-sm btn-danger" onClick={onRetire}>挂靴</button>
    </div>
  );
}

/** Compact context band — latest season, momentum, milestone. Muted and flat
    (no card chrome): context just enough to anchor the decision, never competing
    with the decision core for attention. OVR delta derived in-place from the
    previous season row. */
function ContextBand({ game }: { game: GameState }) {
  const p = game.player!;
  const f = formLabel(game);
  const last = game.seasons[game.seasons.length - 1];
  const prev = game.seasons[game.seasons.length - 2];
  const fColor = f.tone === "hot" ? "var(--color-good)" : f.tone === "cold" ? "var(--color-danger)" : "var(--color-muted)";
  const isGK = p.position === "GK";
  const delta = last && prev ? last.overall - prev.overall : 0;
  const dlt = delta > 0 ? `↑${delta}` : delta < 0 ? `↓${-delta}` : "→";
  const dltColor = delta > 0 ? "var(--color-good)" : delta < 0 ? "var(--color-danger)" : "var(--color-dim)";
  const lastRating = last ? seasonRating(last, ROLE_GROUP[p.position]) : null;
  return (
    <div className="context-band">
      <div className="cb-row">
        <span className="cb-lbl">上季</span>
        {last ? (
          <span className="cb-val">
            {last.clubName} · {ROLE_LABEL[last.role] ?? last.role}
            · <span className={ovrTierClass(last.overall)}>{last.overall}</span>
            <span className="cb-dlt" style={{ color: dltColor }}>{dlt}</span>
            · {isGK ? `${last.stats.cleanSheets}零封` : `${last.stats.goals}球`}
            {lastRating !== null && <span className={`cb-rating ${ratingTierClass(lastRating)}`}>{lastRating.toFixed(1)}</span>}
          </span>
        ) : <span className="cb-val">青训起步 · {nextMilestone(p.age, p.overall)}</span>}
      </div>
      <div className="cb-row">
        <span className="cb-lbl">势头</span>
        <span className="cb-val" style={{ color: fColor }}>{f.text}</span>
      </div>
      {last && (
        <div className="cb-row">
          <span className="cb-lbl">前路</span>
          <span className="cb-val cb-val-dim">{nextMilestone(p.age, p.overall)}</span>
        </div>
      )}
    </div>
  );
}

/** P5: the career-long rival strip — a permanent "someone to beat" panel that
 *  sets the player's latest season beside their rival's same-age season. The
 *  contrast (ahead/behind on goals & trophies) is the narrative engine. */
function RivalStrip({ game }: { game: GameState }) {
  const rival = game.rival!;
  const p = game.player!;
  const last = game.seasons[game.seasons.length - 1];
  const age = p.age;
  const rs = rivalAtAge(rival, age);
  // player's running totals vs rival's running totals up to this age
  const playerGoals = game.seasons.reduce((s, x) => s + x.stats.goals, 0);
  const playerTrophies = game.trophies.length;
  const rivalGoalsUpTo = rival.seasons.filter((s) => s.age <= age).reduce((s, x) => s + x.goals, 0);
  const rivalTrophiesUpTo = rival.seasons.filter((s) => s.age <= age).reduce((s, x) => s + x.trophies, 0);
  const goalLead = playerGoals - rivalGoalsUpTo;
  const trophyLead = playerTrophies - rivalTrophiesUpTo;
  const ovrGap = p.overall - (rs?.overall ?? 0);
  const lead = (n: number) => n > 0 ? `+${n}` : `${n}`;
  const leadColor = (n: number) => n >= 0 ? "var(--color-good)" : "var(--color-danger)";
  return (
    <div className="rival-strip card-quiet">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-semibold tracking-[0.16em] uppercase text-warn m-0">⚡ 宿敌</p>
          <p className="text-sm font-semibold m-0 mt-0.5 truncate">
            {flagEmoji(rival.nationalityId)} {rival.name}
            <span className="font-mono text-[11px] text-dim ml-1.5 font-normal">{clubById(rival.clubId).name}</span>
          </p>
        </div>
        <div className="text-right shrink-0">
          <span className={`font-mono text-lg font-bold ${ovrTierClass(rs?.overall ?? 0)}`}>{rs?.overall ?? "—"}</span>
          <span className="font-mono text-[11px] ml-1.5" style={{ color: leadColor(ovrGap) }}>{ovrGap >= 0 ? "领先" : "落后"} {Math.abs(ovrGap)}</span>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-2.5 font-mono text-[11px]">
        <div className="flex flex-col">
          <span className="text-dim">生涯进球</span>
          <span style={{ color: leadColor(goalLead) }}>{playerGoals} <span className="text-dim">vs</span> {rivalGoalsUpTo} · {lead(goalLead)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-dim">奖杯数</span>
          <span style={{ color: leadColor(trophyLead) }}>{playerTrophies} <span className="text-dim">vs</span> {rivalTrophiesUpTo} · {lead(trophyLead)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-dim">本季</span>
          <span className="text-muted">{last ? `${last.stats.goals}球` : "—"} <span className="text-dim">vs</span> {rs ? `${rs.goals}球` : "—"}</span>
        </div>
      </div>
    </div>
  );
}

/** P5: full career rivalry verdict at the summary screen — who won the
 *  generation? Compares the player's whole career against the rival's. */
function RivalSummaryCard({ game }: { game: GameState }) {
  const rival = game.rival!;
  const p = game.player!;
  const playerGoals = game.seasons.reduce((s, x) => s + x.stats.goals, 0);
  const playerAwards = game.awards.length;
  const cmp = (player: number, r: number, lowerBetter = false) => {
    const win = lowerBetter ? player <= r : player >= r;
    return win ? "var(--color-good)" : "var(--color-danger)";
  };
  const Row = ({ label, pv, rv, suffix = "" }: { label: string; pv: React.ReactNode; rv: React.ReactNode; suffix?: string }) => (
    <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-3 py-2 bg-surface border border-line rounded-md text-sm">
      <span className="text-dim font-mono text-[11px]">{label}</span>
      <span className="font-mono font-semibold text-right">{pv}{suffix}</span>
      <span className="font-mono text-muted text-right">{rv}{suffix}</span>
    </div>
  );
  const playerWon = game.maxOverall > rival.peakOverall && playerGoals >= rival.totalGoals && game.trophies.length >= rival.totalTrophies;
  const verdict = playerWon ? "你赢得了这一代" : "宿敌略胜一筹";
  const shareDuel = () => {
    const text = `⚡ 绿茵轮回 · 宿敌对决\n${flagEmoji(p.nationalityId)}${p.name}（你） vs ${flagEmoji(rival.nationalityId)}${rival.name}\n巅峰 ${game.maxOverall} vs ${rival.peakOverall} · 进球 ${playerGoals} vs ${rival.totalGoals} · 奖杯 ${game.trophies.length} vs ${rival.totalTrophies}\n${verdict}！\n种子 ${game.seed}`;
    navigator.clipboard?.writeText(text).catch(() => {});
  };
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2.5">
        <SectionTitle>⚡ 宿敌对决 · 一代之争</SectionTitle>
        <span className="font-mono text-xs font-bold" style={{ color: playerWon ? "var(--color-good)" : "var(--color-danger)" }}>{verdict}</span>
      </div>
      <div className="flex items-baseline justify-between mb-2.5 px-1">
        <span className="font-semibold text-sm">{flagEmoji(p.nationalityId)} {p.name} <span className="text-dim font-normal">（你）</span></span>
        <span className="font-mono text-[11px] text-dim">vs</span>
        <span className="font-semibold text-sm">{flagEmoji(rival.nationalityId)} {rival.name}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Row label="巅峰OVR" pv={<span style={{ color: cmp(game.maxOverall, rival.peakOverall) }}>{game.maxOverall}</span>} rv={rival.peakOverall} />
        <Row label="生涯进球" pv={<span style={{ color: cmp(playerGoals, rival.totalGoals) }}>{playerGoals}</span>} rv={rival.totalGoals} />
        <Row label="奖杯总数" pv={<span style={{ color: cmp(game.trophies.length, rival.totalTrophies) }}>{game.trophies.length}</span>} rv={rival.totalTrophies} />
        <Row label="个人荣誉" pv={<span style={{ color: cmp(playerAwards, rival.totalAwards) }}>{playerAwards}</span>} rv={rival.totalAwards} />
      </div>
      <button className="btn-sm mt-2.5" onClick={shareDuel}>复制宿敌对决卡片</button>
    </div>
  );
}

/** Collapsible career log — latest 3 seasons by default, expand for full history.
    Stops the page growing one row per season and pushing the decision around. */
function CareerLog({ game, expanded, onToggle }: {
  game: GameState; expanded: boolean; onToggle: () => void;
}) {
  // latest season is shown standalone above the decision; the log holds the rest
  const reversed = [...game.seasons].slice(0, -1).reverse();
  const shown = expanded ? reversed : reversed.slice(0, 3);
  const more = reversed.length - shown.length;
  return (
    <div className="mt-1">
      <button className="log-toggle" onClick={onToggle} aria-expanded={expanded}>
        <span className="log-title">生涯记录 · {game.seasons.length} 赛季</span>
        <span className="log-chev">{expanded ? "收起 ▴" : more > 0 ? `展开 +${more} ▾` : "▴"}</span>
      </button>
      <div className="log-totals">
        <span><span className="lt-n">{game.trophies.length}</span>奖杯</span>
        <span><span className="lt-n">{game.awards.length}</span>荣誉</span>
        <span><span className="lt-n">巅峰</span><span className={`lt-n ${ovrTierClass(game.maxOverall)}`}>{game.maxOverall}</span></span>
      </div>
      <div className="flex flex-col gap-2 mt-2">
        {shown.map((s, i) => <SeasonRow key={i} s={s} position={game.player?.position} seed={game.seed} />)}
      </div>
    </div>
  );
}

function PlayerHeroCard({ game }: { game: GameState }) {
  const p = game.player!;
  const last = game.seasons[game.seasons.length - 1];
  const isGK = p.position === "GK";
  // FUT-style bottom stat row — real football-story stats, not fabricated
  // attributes. GK shows clean sheets + goals conceded instead of goals/assists.
  const cells: [string, number][] = [];
  if (last) {
    cells.push(["APP", last.stats.appearances]);
    if (isGK) cells.push(["CLN", last.stats.cleanSheets], ["CON", last.stats.goalsConceded]);
    else cells.push(["GLS", last.stats.goals], ["AST", last.stats.assists], ["CLN", last.stats.cleanSheets]);
  }
  return (
    <div className="fut-card anim-slide" data-tier={ovrTier(p.overall)} style={{ "--cols": String(cells.length || 4) } as React.CSSProperties}>
      <div className="fc-head">
        <div>
          <div className={`fc-ovr anim-tick ${ovrTierClass(p.overall)}`}>{p.overall}</div>
          <div className="fc-pos">{p.position}</div>
          <div className="fc-num">#{p.squadNumber}</div>
        </div>
        <span className="fc-flag">{flagEmoji(p.nationalityId)}</span>
      </div>
      <div className="fc-name">{p.name}</div>
      <div className="fc-meta">{flagEmoji(p.nationalityId)} {nationName(p.nationalityId)} · {p.age} 岁 · {profileName(p.devProfile)}{last ? ` · ${ROLE_LABEL[last.role]}` : ""}</div>
      <div className="fc-club">
        <div className="club-name">{game.currentClubId ? clubById(game.currentClubId).name : "—"}</div>
        <div className="lg">{last ? last.leagueName : ""}</div>
      </div>
      {cells.length > 0 && (
        <div className="fc-stats">
          {cells.map(([c, v]) => (
            <div key={c}><div className="c">{c}</div><div className="v">{v}</div></div>
          ))}
        </div>
      )}
      <div className="fc-foot">
        <span className="pill pill-accent">传承 {game.legacy}</span>
        <span className="pill pill-purple">飞升 {game.ascension}</span>
      </div>
    </div>
  );
}

function PlayScreen({ game, store }: { game: GameState; store: ReturnType<typeof useGameStore> }) {
  const { choose, retire, abortRun, dismissMilestone } = store;
  const [showCard, setShowCard] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const decisionRef = useRef<HTMLDivElement>(null);
  const firstRun = useRef(true);
  const reduce = usePrefersReducedMotion();

  // resolve micro-interaction: a subtle haptic + tap sfx on choice (Balatro-style feedback).
  const pick = (id: string) => { try { navigator.vibrate?.(10); } catch { /* noop */ } sfxTap(); choose(id); };
  const isBad = game.lastOutcome && /安心|伤|败|怒|禁赛|门|重|不适/.test(game.lastOutcome);

  // P-A4: milestone celebration — vibrate + milestone sfx + auto-dismiss on tap.
  const milestone = game.pendingMilestone;
  const dismissMs = () => { try { navigator.vibrate?.(milestone?.tone === "legendary" ? 30 : 15); } catch { /* noop */ } sfxMilestone(); dismissMilestone(); };
  // P-A6: purist mode hides odds (the hardcore tension mode).
  const purist = !!store.meta.puristMode;

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
      if (key === "world_cup_showdown" || key === "world_cup_qualifier_showdown" || key === "decisive_penalty") sfxBoss();
    }
    prevChoiceKey.current = key ?? null;
  }, [game.pendingChoice?.key]);

  // resume-at-decision: each new decision snaps into view so the player never
  // scrolls to find the next choice. The first land is skipped (decision is
  // already visible). Honors prefers-reduced-motion.
  useEffect(() => {
    if (!game.pendingChoice) return;
    if (firstRun.current) { firstRun.current = false; return; }
    decisionRef.current?.scrollIntoView({
      behavior: reduce ? "auto" : "smooth",
      block: "start",
    });
  }, [game.pendingChoice, reduce]);

  return (
    <>
      {milestone && (
        <div className="milestone-overlay" onClick={dismissMs}>
          <div className={`milestone-card anim-pop ${milestone.tone === "legendary" ? "milestone-legendary" : ""}`}>
            <div className="ms-emoji">{milestone.tone === "legendary" ? "🏆" : "⭐"}</div>
            <h2 className="ms-title">{milestone.title}</h2>
            <p className="ms-desc">{milestone.desc}</p>
            <p className="ms-age">{milestone.age} 岁</p>
            <p className="ms-tap">点击继续</p>
          </div>
        </div>
      )}
      <PlayTopBar
        game={game}
        showCard={showCard}
        onToggleCard={() => setShowCard((v) => !v)}
        onRetire={() => { if (confirm("挂靴退役？本轮回将结算传承分。")) retire(); }}
      />
      <div className="flex flex-col gap-3 pt-3 pb-12">
        {showCard && <PlayerHeroCard game={game} />}

        {game.lastOutcome && (
          <div className={`outcome anim-slide mb-0 ${isBad ? "outcome-bad" : "outcome-good"}`}>
            <span className="outcome-ico">{isBad ? "▼" : "▲"}</span>
            {game.lastOutcome}
          </div>
        )}

        {/* muted context band — latest season + momentum + horizon. Flat, no chrome;
            never competes with the decision core below. */}
        <ContextBand game={game} />

        {/* P5: the career-long rival — a permanent "someone to beat" strip. */}
        {game.rival && <RivalStrip game={game} />}

        {/* decision core — the screen's hero. Odds are the hero (PRODUCT.md):
            a large meter + Anton %, risk-tier rim light. No diffuse bloom. */}
        {game.pendingChoice ? (
          <div
            ref={decisionRef}
            className="decision-core decision-anchor anim-pop"
            data-odds={game.pendingChoice.odds !== undefined ? oddsClass(game.pendingChoice.odds).replace("odds-", "") : undefined}
            data-rarity={game.pendingChoice.rarity}
          >
            <div className="dc-band">
              <h2 className="dc-title">
                {game.pendingChoice.rarity === "legendary" && <span className="rarity-badge legendary">★ 传说</span>}
                {game.pendingChoice.rarity === "rare" && <span className="rarity-badge rare">◆ 稀有</span>}
                {game.pendingChoice.title}
              </h2>
              <p className="dc-desc">{game.pendingChoice.desc}</p>
            </div>
            <div className="dc-body">
              {game.pendingChoice.odds !== undefined && !purist && (
                <div className="dc-odds">
                  <div className="dc-odds-head">
                    <span className="dc-odds-lbl">成功概率</span>
                    <span className={`dc-odds-pct ${oddsTierClass(game.pendingChoice.odds)}`}>
                      {Math.round(game.pendingChoice.odds * 1000) / 10}<span className="dc-odds-sym">%</span>
                    </span>
                  </div>
                  <div className="dc-odds-track">
                    <div className="dc-odds-fill" style={{ width: `${Math.min(100, game.pendingChoice.odds * 100)}%` }} />
                  </div>
                </div>
              )}
              {purist && game.pendingChoice.odds !== undefined && (
                <p className="font-mono text-[11px] text-dim m-0 mb-1">盲选模式 · 概率已隐藏</p>
              )}
              <div className="dc-options">
                {game.pendingChoice.choices.map((c, i) => (
                  <button key={c.id} className="option" onClick={() => pick(c.id)}>
                    <span className="font-semibold">
                      {c.text}
                      {c.sub && !purist && <span className="block font-normal text-xs text-muted mt-0.5">{c.sub}</span>}
                      {game.seasons.length < 3 && i === 0 && <span className="hint-badge ml-2 align-middle">推荐</span>}
                    </span>
                    <span className="text-dim font-mono">→</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="card decision-anchor text-center"><p className="text-muted m-0">推进中…</p></div>
        )}

        <CareerLog game={game} expanded={showLog} onToggle={() => setShowLog((v) => !v)} />

        <button className="btn btn-sm self-start bg-transparent border-transparent text-dim mt-1" onClick={abortRun}>
          放弃本轮回
        </button>
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
    : "无人问津";

  // one-tap quick restart with the same config (new random seed) — the "one more run" button.
  const quickRestart = () => {
    if (!lastSetup) { toMenu(); return; }
    startRun({ ...lastSetup, seed: store.newSeed(), permPerks: meta.permPerks });
  };
  // P-A127: career vs best comparison — "beat your best" motivation loop
  const isBestRun = game.legacy >= meta.bestRun;
  const bestGap = meta.bestRun - game.legacy;
  const canPrestige = prestigeEligible(meta);

  // P3: carry a near-miss into the next run as a redemption challenge.
  const startWithChallenge = (challengeId: string) => {
    if (!lastSetup) { toMenu(); return; }
    startRun({ ...lastSetup, seed: store.newSeed(), permPerks: meta.permPerks, challenge: makeChallenge(challengeId) });
  };

  // did the run satisfy a carried challenge? (shows a victory badge)
  const carriedSuccess = challengeSucceeded(game.challenge, { trophies: game.trophies, awards: game.awards, maxOverall: game.maxOverall, seasons: game.seasons.length });
  const nearMisses = nearMissChallenges({ trophies: game.trophies, awards: game.awards, maxOverall: game.maxOverall, seasons: game.seasons.length });
  // copy a shareable career card so a fan can post their result.
  const shareCard = () => {
    const t = game.trophies.map((x) => TROPHY_LABEL[x]).join(" ") || "none";
    const a = game.awards.map((x) => AWARD_LABEL[x]).join(" ") || "none";
    const text = "GreenInn " + rank.name + " Legacy " + game.legacy + " Peak " + game.maxOverall + " " + game.seasons.length + "s\nTrophies " + t + " Awards " + a + "\nSeed " + game.seed;
    navigator.clipboard?.writeText(text).catch(() => {});
  };
  // P-A120: TikTok-optimized share — short, punchy, with URL for virality.
  const shareTikTok = () => {
    const p = game.player;
    // P-A163: encode the FULL setup so a TikTok viewer who opens the link
    // reproduces this exact career — the "你能超越我吗" loop only works if the
    // recipient gets the same nat/pos/league, not just the same seed.
    const url = window.location.origin + window.location.pathname +
      "#s=" + game.seed + "&n=" + (p?.nationalityId ?? "") + "&p=" + (p?.position ?? "") +
      "&l=" + (game.currentLeagueId ?? "") + "&m=" + (game.pace ?? "normal");
    const best = (game.careerBeats ?? []).filter(b => b.tone === "legendary" || b.tone === "good").slice(-1)[0];
    const hook = best ? "\n" + best.text : "";
    const text = "GreenInn " + (p?.name ?? "?") + " " + rank.name + " OVR" + game.maxOverall + " " + game.trophies.length + " trophies" + hook + "\n" + url + "\n#greeninn #football";
    navigator.clipboard?.writeText(text).catch(() => {});
  };
  // P-A124: achievement brag card — generates shareable text for rare achievements
  const shareAchievement = (achName: string, achDesc: string) => {
    const p = game.player;
    const url = window.location.origin + window.location.pathname +
      "#s=" + game.seed + "&n=" + (p?.nationalityId ?? "") + "&p=" + (p?.position ?? "") +
      "&l=" + (game.currentLeagueId ?? "") + "&m=" + (game.pace ?? "normal");
    const text = "Achievement: " + achName + "\n" + achDesc + "\n" + (p?.name ?? "?") + " " + rank.name + " OVR" + game.maxOverall + "\n" + url;
    navigator.clipboard?.writeText(text).catch(() => {});
  };
  // P-A126: career one-liner — auto-generated punchy summary for social sharing
  const careerOneLiner = (): string => {
    const p = game.player;
    const wc = game.trophies.includes("world_cup") ? " WC" : "";
    const bd = game.awards.includes("ballon_dor") ? " BallonDor" : "";
    const cl = game.trophies.includes("continental_primary") ? " UCL" : "";
    const peak = game.maxOverall >= 90 ? " OVR" + game.maxOverall : "";
    const tags = [wc, bd, cl, peak].filter(Boolean).join(" ") || game.trophies.length + " trophies";
    return (p?.name ?? "?") + " " + flagEmoji(p?.nationalityId ?? "") + " " + rank.name + " " + tags;
  };
  // P-A2/P-A166: export a visual canvas career card (PNG) — the TikTok-shareable
  // image. Redesigned for the Chinese audience: Chinese labels, rank tier color
  // hierarchy, word-wrapped highlights, a rival row, and the seed CHALLENGE CTA
  // (the viral loop: the viewer reads the seed + setup and challenges it).
  // No external libs; pure Canvas2D.
  const exportCardImage = () => {
    const p = game.player;
    const W = 540, H = 760;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d")!;
    const CN = 'ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
    const wrap = (text: string, x: number, y: number, maxW: number, lh: number, maxLines = 2) => {
      let line = ""; let lines = 0;
      for (const ch of text) {
        const test = line + ch;
        if (ctx.measureText(test).width > maxW && line) {
          ctx.fillText(line, x, y + lines * lh); line = ch; lines++;
          if (lines >= maxLines - 1) { ctx.fillText(line + "…", x, y + lines * lh); return; }
        } else line = test;
      }
      ctx.fillText(line, x, y + lines * lh);
    };
    // background
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#0a0e0c"); bg.addColorStop(0.6, "#0f1714"); bg.addColorStop(1, "#0a0e0c");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    // top rank bar
    ctx.fillStyle = rank.color; ctx.fillRect(0, 0, W, 6);
    // eyebrow
    ctx.fillStyle = "#b8ff3d"; ctx.font = `600 13px ${CN}`; ctx.textAlign = "center";
    ctx.fillText("绿茵轮回 · ROGUELIKE 足球生涯", W / 2, 52);
    // rank name
    ctx.fillStyle = rank.color; ctx.font = `800 46px ${CN}`;
    ctx.fillText(rank.name, W / 2, 108);
    // legacy big number
    ctx.fillStyle = "#7dd3fc"; ctx.font = `800 92px ${CN}`;
    ctx.fillText(String(game.legacy), W / 2, 196);
    ctx.fillStyle = "#6e7681"; ctx.font = `500 14px ${CN}`;
    ctx.fillText("传承分", W / 2, 220);
    // player line
    if (p) {
      ctx.fillStyle = "#f4fff0"; ctx.font = `600 19px ${CN}`;
      ctx.fillText(flagEmoji(p.nationalityId) + " " + p.name + " · " + p.position, W / 2, 262);
      ctx.fillStyle = "#8b949e"; ctx.font = `400 13px ${CN}`;
      ctx.fillText(`${game.seasons.length}赛季 · 巅峰OVR${game.maxOverall} · ${game.trophies.length}奖杯 · ${game.awards.length}个人荣誉`, W / 2, 286);
    }
    // divider
    ctx.strokeStyle = "#2a3a30"; ctx.beginPath(); ctx.moveTo(60, 310); ctx.lineTo(W - 60, 310); ctx.stroke();
    // highlights
    ctx.fillStyle = "#6e7681"; ctx.font = `500 13px ${CN}`; ctx.textAlign = "left";
    ctx.fillText("生涯高光", 60, 338);
    ctx.fillStyle = "#c9d1d9"; ctx.font = `400 15px ${CN}`;
    const beats = (game.careerBeats ?? []).filter(b => b.tone === "legendary" || b.tone === "good").slice(-3);
    beats.forEach((b, i) => { wrap(b.text, 60, 365 + i * 44, W - 120, 22, 2); });
    // rival row
    let yOff = 365 + Math.max(beats.length, 1) * 44 + 16;
    if (game.rival) {
      const r = game.rival;
      const playerGoals = game.seasons.reduce((s, x) => s + x.stats.goals, 0);
      ctx.strokeStyle = "#2a3a30"; ctx.beginPath(); ctx.moveTo(60, yOff); ctx.lineTo(W - 60, yOff); ctx.stroke();
      ctx.fillStyle = "#fbbf24"; ctx.font = `600 13px ${CN}`; ctx.textAlign = "left";
      ctx.fillText("宿敌对决", 60, yOff + 26);
      ctx.fillStyle = "#c9d1d9"; ctx.font = `400 14px ${CN}`;
      ctx.fillText(`${p?.name ?? ""}  巅峰${game.maxOverall} · ${playerGoals}球 · ${game.trophies.length}杯`, 60, yOff + 48);
      ctx.textAlign = "right";
      ctx.fillText(`${r.name}  巅峰${r.peakOverall} · ${r.totalGoals}球 · ${r.totalTrophies}杯`, W - 60, yOff + 48);
      ctx.textAlign = "left";
      yOff += 70;
    }
    // challenge CTA — the viral loop core
    ctx.fillStyle = "#16201b"; ctx.strokeStyle = "#2a3a30";
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") { ctx.roundRect(60, yOff, W - 120, 78, 12); }
    else { ctx.rect(60, yOff, W - 120, 78); } // older Safari fallback
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#b8ff3d"; ctx.font = `600 16px ${CN}`; ctx.textAlign = "center";
    ctx.fillText("挑战我 · 同种子同生涯", W / 2, yOff + 30);
    ctx.fillStyle = "#7dd3fc"; ctx.font = `600 20px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillText(game.seed, W / 2, yOff + 58);
    // footer
    ctx.fillStyle = "#6e7681"; ctx.font = `400 12px ${CN}`; ctx.textAlign = "center";
    ctx.fillText("点开链接直接开踢 · 你能超越我吗？", W / 2, H - 38);
    ctx.fillStyle = "#7dd3fc"; ctx.font = `600 12px ${CN}`;
    ctx.fillText("绿茵轮回", W / 2, H - 18);
    const url = cv.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url; a.download = "lvyin-" + rank.name + "-" + game.seed + ".png";
    a.click();
  };

  // P-A10: count-up the legacy number for the dopamine tick.
  const legacyCount = useCountUp(game.legacy);
  return (
    <div className="flex flex-col gap-3 pt-4">
      {/* floating quick-restart */}
      <div className="flex gap-2.5 sticky top-0 z-20 -mx-2 px-2 py-2 bg-ink/80 backdrop-blur border-b border-line rounded-b-lg">
        <button className="btn-primary flex-1" onClick={quickRestart}>再来一局</button>
        <button className="btn" onClick={toMenu}>菜单</button>
      </div>
      {/* best run comparison */}
      {meta.runs > 1 && !isBestRun && bestGap > 0 && (
        <div className="card" style={{ borderColor: "var(--color-warn, oklch(0.78 0.16 70))" }}>
          <p className="text-sm m-0 text-warn">距最佳还差 <b className="text-text">{bestGap}</b> 传承分</p>
        </div>
      )}
      {isBestRun && meta.runs > 1 && (
        <div className="card" style={{ borderColor: "var(--color-gold, oklch(0.85 0.18 85))", background: "rgba(251,191,36,0.08)" }}>
          <p className="text-sm m-0 text-gold">新纪录！</p>
        </div>
      )}
      {achPopup && (
        <div className="milestone-overlay" onClick={nextAch}>
          <div className="milestone-card anim-pop milestone-legendary">
            <div className="ms-emoji">medal</div>
            <h2 className="ms-title">Achievement!</h2>
            <p className="ms-desc"><b className="text-gold">{achPopup.name}</b> - {achPopup.desc}</p>
            <button className="btn-sm mt-3" onClick={(e) => { e.stopPropagation(); shareAchievement(achPopup.name, achPopup.desc); }}>share</button>
            <p className="ms-tap">tap to continue</p>
          </div>
        </div>
      )}
      <div className="hero-card text-center" data-tier={legacyTier(game.legacy)} style={{ padding: 30 }}>
        <p className="font-mono text-[11px] font-semibold tracking-[0.16em] uppercase text-accent m-0">生涯终结</p>
        <h2 className="text-[28px] font-bold tracking-tight m-0 mb-1" style={{ color: rank.color }}>{rank.name}</h2>
        <div className="num text-[68px] leading-none text-accent anim-tick">{legacyCount}</div>
        <p className="text-muted m-0">传承分 · {reason}</p>
        <p className="font-mono text-[11px] text-dim mt-2">种子 {game.seed} · {game.seasons.length} 个赛季 · 巅峰 {game.maxOverall}</p>
      </div>

      <StatStrip items={[
        { label: "巅峰OVR", value: <span className={ovrTierClass(game.maxOverall)}>{game.maxOverall}</span> },
        { label: "赛季数", value: game.seasons.length },
        { label: "奖杯总数", value: game.trophies.length },
        { label: "个人荣誉", value: game.awards.length },
        { label: "生涯总薪", value: <span className="text-gold">€{fmtCareerWage(game.seasons)}</span> },
        ...(game.bestStreak ?? 0) >= 2 ? [{ label: "最长连冠", value: <span className="text-gold">{game.bestStreak}</span> }] : [],
      ]} />

      {carriedSuccess && game.challenge && (
        <div className="card" style={{ borderColor: "var(--gold, #fbbf24)", background: "rgba(251,191,36,0.08)" }}>
          <p className="text-sm m-0 text-gold">🏆 挑战达成：{game.challenge.label}！传承分 ×{game.challenge.legacyMult.toFixed(1)} 已生效。</p>
        </div>
      )}

      {nearMisses.length > 0 && (
        <div className="card">
          <SectionTitle>定义性时刻 · 未竟之志</SectionTitle>
          <p className="font-mono text-[11px] text-dim m-0 mb-3">这程你差了一步的事。选一个作为下局挑战目标——达成可获得传承分加成。</p>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
            {nearMisses.map((c) => (
              <div key={c.id} className="bg-surface-2 border border-line rounded-md p-3 flex flex-col">
                <strong className="text-warn">{c.label}</strong>
                <p className="text-sm text-muted m-0 mt-1 mb-2.5 flex-1">{c.hint}</p>
                <div className="flex items-center justify-between gap-2">
                  <span className="pill pill-accent">×{c.legacyMult.toFixed(1)} 传承</span>
                  <button className="btn-sm btn-primary" onClick={() => startWithChallenge(c.id)}>挑战此目标</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {game.trophies.length > 0 && (
        <div className="card"><SectionTitle>奖杯陈列</SectionTitle>
          <div className="flex flex-wrap gap-1.5">{game.trophies.map((t, i) => <TrophyBadge key={i} t={t} conf={confederationOfLeague(game.currentLeagueId)} />)}</div>
        </div>
      )}

      {game.rival && <RivalSummaryCard game={game} />}

      {(() => {
        // P6: highlight newly-collected trophies & achievements (collection "NEW!").
        const newT = game.newCollectedTrophies ?? [];
        const newA = (game.newCollectedAchievements ?? []).map((id) => ACHIEVEMENTS.find((a) => a.id === id)!).filter(Boolean);
        if (newT.length === 0 && newA.length === 0) return null;
        return (
          <div className="card" style={{ borderColor: "var(--gold, #fbbf24)", background: "rgba(251,191,36,0.08)" }}>
            <SectionTitle>🆕 首次入藏</SectionTitle>
            {newT.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">{newT.map((t, i) => <span key={i} className="pill pill-gold">{TROPHY_LABEL[t]} 首获！</span>)}</div>
            )}
            {newA.length > 0 && (
              <div className="flex flex-wrap gap-1.5">{newA.map((a, i) => <span key={i} className="pill pill-accent">{a.name} 解锁！</span>)}</div>
            )}
          </div>
        );
      })()}
      {game.awards.length > 0 && (
        <div className="card"><SectionTitle>个人荣誉</SectionTitle>
          <div className="flex flex-wrap gap-1.5">{game.awards.map((a, i) => <AwardBadge key={i} a={a} />)}</div>
        </div>
      )}

      {(game.careerBeats ?? []).length > 0 && (
        <div className="card">
          <SectionTitle>📖 生涯故事线</SectionTitle>
          <div className="flex flex-col gap-1.5">
            {(game.careerBeats ?? []).map((b, i) => (
              <div key={i} className="story-beat" data-tone={b.tone}>
                <span className="sb-age font-mono text-[11px] text-dim">{b.age}岁</span>
                <span className={`sb-text text-sm ${b.tone === "legendary" ? "text-gold font-semibold" : b.tone === "good" ? "text-text" : b.tone === "bad" ? "text-warn" : "text-muted"}`}>{b.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(game.choiceLog ?? []).length > 0 && (
        <div className="card">
          <SectionTitle>🦋 抉择回顾 · 你的蝴蝶效应</SectionTitle>
          <p className="font-mono text-[11px] text-dim m-0 mb-3">每一个选择都改变了一切。回顾你的关键抉择及其后果。</p>
          <div className="flex flex-col gap-2">
            {(game.choiceLog ?? []).map((c, i) => (
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
          </div>
          <p className="font-mono text-[11px] text-dim m-0 mt-3 text-center">换个种子、换个选择，下一段旅程完全不同。🦋</p>
        </div>
      )}

      {(() => {
        // P-A12: career goals curve — a mini bar chart of per-season goals/OVR,
        // the visual "career arc at a glance" that grabs a TikTok scroller.
        const goals = game.seasons.map((s) => s.stats.goals);
        const ovrs = game.seasons.map((s) => s.overall);
        if (goals.length < 2) return null;
        const isGK = game.player?.position === "GK";
        const metric = isGK ? game.seasons.map((s) => s.stats.cleanSheets) : goals;
        const maxM = Math.max(1, ...metric);
        const minOvr = Math.min(...ovrs), maxOvr = Math.max(...ovrs);
        const barW = Math.max(4, Math.min(20, 280 / metric.length));
        return (
          <div className="card">
            <SectionTitle>{isGK ? "生涯零封曲线" : "生涯进球曲线"}</SectionTitle>
            <div className="flex items-end gap-1 mt-2" style={{ height: 90 }}>
              {metric.map((m, i) => (
                <div key={i} className="flex flex-col items-center gap-0.5" style={{ width: barW }}>
                  <div
                    className="career-bar-fill rounded-t"
                    style={{ height: `${(m / maxM) * 70}px`, width: "100%", background: m === maxM ? "var(--color-gold)" : "var(--color-accent)", opacity: 0.8 }}
                    title={`${game.seasons[i]?.age}岁 · ${m}${isGK ? "零封" : "球"}`}
                  />
                  <span className="font-mono text-[8px] text-dim">{game.seasons[i]?.age}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-between mt-2 font-mono text-[11px] text-dim">
              <span>{isGK ? `最多 ${maxM} 零封` : `单季最高 ${maxM} 球`}</span>
              <span>OVR {minOvr}→{maxOvr} · {game.seasons.length}赛季</span>
            </div>
          </div>
        );
      })()}

      {(() => {
        // P-A19: market value curve — the wealth arc (€0.3M → €60M) that makes
        // the financial dimension visceral. Peak season in gold.
        const mvs = game.seasons.map((s) => s.marketValue ?? 0);
        if (mvs.length < 2 || Math.max(...mvs) < 1) return null;
        const maxMv = Math.max(1, ...mvs);
        const peakMv = Math.max(...mvs);
        const barW = Math.max(4, Math.min(20, 280 / mvs.length));
        return (
          <div className="card">
            <SectionTitle>身价轨迹 · 峰值€{peakMv >= 1 ? `${peakMv}M` : `${Math.round(peakMv * 1000)}K`}</SectionTitle>
            <div className="flex items-end gap-1 mt-2" style={{ height: 80 }}>
              {mvs.map((mv, i) => (
                <div key={i} className="flex flex-col items-center gap-0.5" style={{ width: barW }}>
                  <div
                    className="career-bar-fill rounded-t"
                    style={{ height: `${(mv / maxMv) * 60}px`, width: "100%", background: mv === peakMv ? "var(--color-gold)" : "var(--color-warn)", opacity: 0.85 }}
                    title={`${game.seasons[i]?.age}岁 · €${mv >= 1 ? `${mv}M` : `${Math.round(mv * 1000)}K`}`}
                  />
                  <span className="font-mono text-[8px] text-dim">{game.seasons[i]?.age}</span>
                </div>
              ))}
            </div>
            <p className="font-mono text-[11px] text-dim mt-2">从€{(mvs[0] ?? 0).toFixed(1)}M 到峰值€{peakMv}M — 你的市场价值轨迹</p>
          </div>
        );
      })()}

      {(() => {
        // P-A11: club career timeline — aggregate consecutive club stints.
        const stints: { clubName: string; leagueName: string; start: number; end: number; count: number; trophies: number }[] = [];
        for (const s of game.seasons) {
          const last = stints[stints.length - 1];
          if (last && last.clubName === s.clubName) { last.end = s.age; last.count += 1; last.trophies += s.trophies.length; }
          else stints.push({ clubName: s.clubName, leagueName: s.leagueName, start: s.age, end: s.age, count: 1, trophies: s.trophies.length });
        }
        if (stints.length === 0) return null;
        return (
          <div className="card">
            <SectionTitle>效力履历 · {stints.length} 段旅程</SectionTitle>
            <div className="flex flex-col gap-1.5">
              {stints.map((st, i) => (
                <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-3 py-2 bg-surface border border-line rounded-md text-sm">
                  <div className="min-w-0">
                    <span className="font-semibold">{st.clubName}</span>
                    <span className="font-mono text-[11px] text-dim ml-1.5">{st.leagueName}</span>
                  </div>
                  <span className="font-mono text-[11px] text-muted">{st.start}-{st.end}岁 · {st.count}季</span>
                  {st.trophies > 0 && <span className="font-mono text-[11px] text-gold">{st.trophies}🏆</span>}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      <div className="card"><SectionTitle>逐季回顾</SectionTitle>
        <div className="flex flex-col gap-2">{[...game.seasons].reverse().map((s, i) => <SeasonRow key={i} s={s} position={game.player?.position} seed={game.seed} />)}</div>
      </div>

      <div className="flex gap-2.5 mt-2 flex-wrap">
        <button className="btn-primary" onClick={quickRestart}>再来一局 ↻</button>
        <button className="btn" onClick={exportCardImage}>📸 导出生涯卡</button>
        <button className="btn" onClick={shareTikTok}>📱 复制TikTok文案</button>
        <button className="btn" onClick={() => navigator.clipboard?.writeText(careerOneLiner()).catch(() => {})}>复制一句话</button>
        <button className="btn" onClick={shareCard}>复制文字卡</button>
        <button className="btn" onClick={toMenu}>主菜单</button>
      </div>

      {canPrestige && (
        <div className="card hook-card" style={{ borderColor: "var(--gold, #fbbf24)" }}>
          <p className="text-sm m-0 text-gold">⚡ 你已可轮回！献祭祝福与传承，换取一项永久特权，下一段旅程更强。</p>
          <p className="font-mono text-[11px] text-dim m-0 mt-1.5">主菜单 → 轮回 标签查看三选一。</p>
        </div>
      )}
    </div>
  );
}
