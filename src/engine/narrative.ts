/**
 * Narrative context — the player's OWN facts, for scripted story events.
 *
 * The story events in events.ts are each modelled on a real footballer, and
 * they used to carry that footballer's biography verbatim: born in Spain,
 * heart in Morocco; 115 goals for Juventus; Premier League record fee. Fired
 * for a Chinese striker at Salzburg, that reads as somebody else's life.
 *
 * This module derives the equivalent facts from THIS career — nationality,
 * continent, continental cup, club, league, former club, shirt number — so a
 * script can say "整个亚洲在等你" / "你在萨尔茨堡进了115个球" and stay true.
 *
 * Everything here is pure and deterministic: picks are hashed off the run seed
 * (via rng.derive on a fresh state) so they never disturb the career's RNG
 * stream and re-render identically on reload.
 */
import type { Club, Confederation, League, Position } from "./data";
import { CLUBS, LEAGUES, NATIONS, clubById, nationById } from "./data";
import { derive, int } from "./rng";
import { seniorCareerSeasonCount, seniorCareerStats, type SeasonResult, type CareerBeat, type Trophy, type Award, type Player } from "./types";

/** Structural input — EventContext satisfies this without importing events.ts
 *  (which imports this module; a named interface keeps the cycle broken). */
export interface NarrativeInput {
  player: { readonly nationalityId: string; readonly name: string; readonly position: Position; readonly squadNumber: number };
  club: Club;
  league: League;
  seed: string;
  age: number;
  formerClubIds?: readonly string[];
  /** The career's season log so far. Absent on call sites that predate it
   *  (the career-total fields then read 0 and the copy degrades gracefully). */
  seasons?: readonly SeasonResult[];
}

/** Confederation → the continent a script would name, and its national cup. */
const CONTINENT: Record<Confederation, string> = {
  UEFA: "欧洲", CONMEBOL: "南美", CONCACAF: "中北美", AFC: "亚洲", CAF: "非洲", OFC: "大洋洲",
};
const CONTINENTAL_CUP: Record<Confederation, string> = {
  UEFA: "欧洲杯", CONMEBOL: "美洲杯", CONCACAF: "金杯赛", AFC: "亚洲杯", CAF: "非洲杯", OFC: "大洋洲国家杯",
};
/** Confederation → its top club competition, as a script would name it. */
const CONTINENTAL_CLUB_CUP: Record<Confederation, string> = {
  UEFA: "欧冠", CONMEBOL: "解放者杯", CONCACAF: "中北美冠军杯", AFC: "亚冠", CAF: "非洲冠军联赛", OFC: "大洋洲冠军联赛",
};

/** Chinese numeral for 1..99 — the prose style writes ages out ("你十九岁"). */
const CN_DIGIT = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
export function cnNum(n: number): string {
  if (n < 0 || n > 99 || !Number.isInteger(n)) return String(n);
  if (n < 10) return CN_DIGIT[n]!;
  if (n < 20) return n === 10 ? "十" : `十${CN_DIGIT[n % 10]}`;
  const tens = `${CN_DIGIT[Math.floor(n / 10)]}十`;
  return n % 10 === 0 ? tens : `${tens}${CN_DIGIT[n % 10]}`;
}

export interface Narrative {
  /** 中国 */ nation: string;
  /** chn */ nationId: string;
  confederation: Confederation;
  /** 亚洲 */ continent: string;
  /** 亚洲杯 */ continentalCup: string;
  /** 亚冠 */ continentalClubCup: string;
  /** A traditional powerhouse (fifaRep >= 3) — a deep run is history repeating,
   *  not a first. Scripts must not tell Brazil it has never been here. */
  isPowerhouse: boolean;
  /** Never been anywhere (fifaRep === 0) — the pioneer scripts are true here. */
  isMinnow: boolean;
  /** 萨尔茨堡 */ club: string;
  /** 奥甲 */ league: string;
  /** Top flight of the player's own country (中超), or 国内联赛 if it has none. */
  homeLeague: string;
  /** The club the player left most recently, or "" if this is still club one. */
  formerClub: string;
  /** formerClub, or a neutral stand-in so a script never renders an empty slot. */
  formerClubOr: string;
  /** The club's iconic rival, else the strongest other club in the league. */
  derbyClub: string;
  /** Strongest club in the league that isn't the player's — the marquee scalp. */
  bigClub: string;
  /** A deterministic opponent nation from the same confederation. */
  rivalNation: string;
  /** A deterministic heavyweight opponent nation (fifaRep >= 3). */
  worldRivalNation: string;
  /** A big league that isn't this one — where the scouts come from. */
  scoutLeague: string;
  /** 9 — the player's actual shirt number. */
  squadNumber: number;
  /** 十九 — the player's actual age, written out. */
  ageCn: string;
  age: number;
  name: string;

  // ── career-to-date facts ────────────────────────────────────────────────
  // The story events used to quote the real footballer's numbers (115 goals,
  // 607 games, 三次金球奖). Fired for a 22-year-old with 40 caps that reads as
  // somebody else's CV, so every number a script states now comes from here.
  /** Career league appearances so far. */
  careerApps: number;
  /** Career goals so far. */
  careerGoals: number;
  /** Career assists so far. */
  careerAssists: number;
  /** Career clean sheets so far (the GK equivalent of goals). */
  careerCleanSheets: number;
  /** The player's headline output — goals for outfielders, clean sheets for GKs. */
  careerOutput: number;
  /** 进球 / 零封 — the label that goes with careerOutput. */
  outputLabel: string;
  /** Seasons played so far (the season log's length). */
  careerSeasons: number;
  /** Consecutive seasons at the CURRENT club (0 on the debut period). */
  seasonsAtClub: number;
  /** 十 — seasonsAtClub written out (at least 一, so prose never reads "你踢了零年"). */
  seasonsAtClubCn: string;
  /** How many clubs the career has passed through, current one included. */
  clubCount: number;
  /** National-team caps / goals so far. */
  caps: number;
  capGoals: number;
  /** Ballon d'Or count so far — a script may only crown the player if this > 0. */
  ballonDors: number;
  /** Club + national trophies won so far. */
  trophyCount: number;
  /** Most recent market value, as prose money ("€6000万" / "€1.2亿"). */
  fee: string;
  /** The career's own starting age, written out (十六) — 生涯起点, not a guess. */
  startAgeCn: string;
}

/** START_AGE, mirrored here so narrative.ts stays free of a run.ts import
 *  (run.ts imports events.ts imports narrative.ts — the reverse would cycle). */
const CAREER_START_AGE = 16;

/** €M → the way a Chinese match report writes a fee. */
export function feeCn(m: number): string {
  if (!(m > 0)) return "一笔不算大的转会费";
  if (m >= 100) return `€${(m / 100).toFixed(m % 100 === 0 ? 0 : 1)}亿`;
  return `€${Math.round(m * 100)}万`;
}

function pickFrom<T>(arr: readonly T[], seed: string, salt: string): T | undefined {
  if (arr.length === 0) return undefined;
  const r = derive(seed, "narr", salt);
  return arr[int(r, 0, arr.length - 1)];
}

/** The boss/climax builders (world_cup_showdown & friends) resolve against a
 *  ctx stub that carries only blessings + odds — they narrate a tournament, not
 *  the player's biography, so they never read these facts. Fill the stub in
 *  rather than crash: narrative() is a display-fact provider, not a gate. */
const STUB_PLAYER = { nationalityId: "bra", name: "你", position: "ST" as Position, squadNumber: 10 };

/** Per-context memo. `narrative()` is pure in its input and rescans CLUBS /
 *  LEAGUES on every call, but the callers hammer it with the SAME context
 *  object: resolveEventOption starts with narrative(ctx), and optionPreview
 *  dry-runs that resolver 8× per event (2 options × 2 branches × 2 salts) just
 *  to render the pills. Keying the cache on the context identity is exact —
 *  a context object is built fresh per period in run.ts and never mutated, so
 *  a hit can only ever return what a recompute would. Profile: narrative() was
 *  ~25% of headless sim CPU before this. */
const NARRATIVE_MEMO = new WeakMap<NarrativeInput, Narrative>();

export function narrative(ctx: NarrativeInput): Narrative {
  const memo = NARRATIVE_MEMO.get(ctx);
  if (memo) return memo;
  const built = buildNarrative(ctx);
  NARRATIVE_MEMO.set(ctx, built);
  return built;
}

function buildNarrative(ctx: NarrativeInput): Narrative {
  if (!ctx.player || !ctx.club || !ctx.league) {
    ctx = {
      ...ctx,
      player: ctx.player ?? STUB_PLAYER,
      club: ctx.club ?? CLUBS[0]!,
      league: ctx.league ?? LEAGUES[0]!,
      seed: ctx.seed ?? "",
      age: ctx.age ?? 16,
    };
  }
  const nation = nationById(ctx.player.nationalityId);
  const conf = nation.confederation;

  const home = LEAGUES.find((l) => l.tier === 1 && l.country.toLowerCase() === nation.id);

  // Former club = the most recent id in formerClubIds that isn't the current
  // club. run.ts builds that list from the season log in chronological order.
  const priorIds = (ctx.formerClubIds ?? []).filter((id) => id !== ctx.club.id);
  const formerId = priorIds[priorIds.length - 1];
  const formerClub = formerId ? safeClubName(formerId) : "";

  const leagueClubs = CLUBS.filter((c) => c.leagueId === ctx.club.leagueId && c.id !== ctx.club.id);
  const derby = ctx.club.rivalId ? safeClubName(ctx.club.rivalId) : "";
  const strongest = [...leagueClubs].sort((a, b) => b.rep - a.rep)[0];

  // Career totals — every number a script quotes about the player's past.
  const seasons = ctx.seasons ?? [];
  const careerStats = seniorCareerStats(seasons);
  let caps = 0, capGoals = 0;
  let ballonDors = 0, trophyCount = 0, marketValue = 0;
  for (const s of seasons) {
    caps += s.national?.caps ?? 0; capGoals += s.national?.goals ?? 0;
    ballonDors += s.awards.filter((a) => a === "ballon_dor").length;
    trophyCount += s.trophies.length;
    if (s.marketValue) marketValue = s.marketValue;
  }
  // Consecutive tail of seasons at the current club — "你在这里踢了N年".
  let seasonsAtClub = 0;
  for (let i = seasons.length - 1; i >= 0 && seasons[i]!.clubId === ctx.club.id; i--) seasonsAtClub++;
  const isGK = ctx.player.position === "GK";

  const sameConf = NATIONS.filter((n) => n.confederation === conf && n.id !== nation.id && n.fifaRep + n.contRep >= 3);
  const heavies = NATIONS.filter((n) => n.fifaRep >= 3 && n.id !== nation.id);
  const bigLeagues = LEAGUES.filter((l) => l.tier === 1 && l.domRep >= 4 && l.id !== ctx.league.id);

  return {
    nation: nation.name,
    nationId: nation.id,
    confederation: conf,
    continent: CONTINENT[conf],
    continentalCup: CONTINENTAL_CUP[conf],
    continentalClubCup: CONTINENTAL_CLUB_CUP[conf],
    isPowerhouse: nation.fifaRep >= 3,
    isMinnow: nation.fifaRep === 0,
    club: ctx.club.name,
    league: ctx.league.name,
    homeLeague: home?.name ?? "国内联赛",
    formerClub,
    formerClubOr: formerClub || "老东家",
    derbyClub: derby || strongest?.name || "同城对手",
    bigClub: strongest?.name ?? "榜首球队",
    rivalNation: pickFrom(sameConf, ctx.seed, "rival-nation")?.name ?? "东道主",
    worldRivalNation: pickFrom(heavies, ctx.seed, "world-rival")?.name ?? "卫冕冠军",
    scoutLeague: pickFrom(bigLeagues, ctx.seed, "scout-league")?.name ?? "欧洲豪门",
    squadNumber: ctx.player.squadNumber,
    ageCn: cnNum(ctx.age),
    age: ctx.age,
    name: ctx.player.name,
    careerApps: careerStats.appearances,
    careerGoals: careerStats.goals,
    careerAssists: careerStats.assists,
    careerCleanSheets: careerStats.cleanSheets,
    careerOutput: isGK ? careerStats.cleanSheets : careerStats.goals,
    outputLabel: isGK ? "零封" : "进球",
    careerSeasons: seniorCareerSeasonCount(seasons),
    seasonsAtClub,
    seasonsAtClubCn: cnNum(Math.max(1, seasonsAtClub)),
    clubCount: new Set([...seasons.map((s) => s.clubId), ctx.club.id]).size,
    caps,
    capGoals,
    ballonDors,
    trophyCount,
    fee: feeCn(marketValue),
    startAgeCn: cnNum(CAREER_START_AGE),
  };
}

function safeClubName(id: string): string {
  try { return clubById(id).name; } catch { return ""; }
}

// ───────────────────────────── career story beats (P-A1) ─────────────────────────────
//
// Career-feed beat generation — the memorable-moment one-liners appended to the
// career story feed each season. Pure: reads a SeasonResult, returns a beat (or
// none for a quiet season). Moved here from run.ts so all narrative copy lives
// in one home (run.ts is the orchestrator; it calls these, it does not author
// prose). Behaviour-identical to the prior inline definitions — the regress 文案
// layer verifies every beat string.

const BEAT_TROPHY_NAME: Record<Trophy, string> = {
  league: "联赛冠军", cup: "杯赛冠军", continental_primary: "洲际冠军",
  continental_secondary: "洲际次杯", club_world_cup: "世俱杯",
  national_continental: "洲际国家队冠军", world_cup: "世界杯冠军", olympic: "奥运金牌",
};
const BEAT_AWARD_NAME: Record<Award, string> = {
  ballon_dor: "金球奖", golden_boot: "金靴", golden_glove: "金手套",
  csl_mvp: "中超最佳球员", csl_boot: "中超金靴", afc_poy: "亚洲足球先生",
};

/** Append a beat for a noteworthy season. A season yields at most one beat
 *  (the most significant event), so the feed never double-counts. */
export function appendSeasonBeats(beats: readonly CareerBeat[], s: SeasonResult, seasonNum: number, player: Player): readonly CareerBeat[] {
  // pick the most significant beat for this season (priority order)
  let text = "";
  let tone: CareerBeat["tone"] = "neutral";
  const ovr = s.overall;
  if (s.awards.includes("ballon_dor")) { text = `${s.age}岁加冕金球奖！`; tone = "legendary"; }
  else if (s.trophies.includes("world_cup")) { text = `${s.age}岁捧起世界杯！封王之夜。`; tone = "legendary"; }
  else if (s.awards.length > 0) { text = `${s.age}岁夺得${s.awards.map(a => BEAT_AWARD_NAME[a]).join("、")}。`; tone = "good"; }
  else if (s.trophies.length >= 2) { text = `${s.age}岁${s.trophies.map(t => BEAT_TROPHY_NAME[t]).join("+")}，${s.clubName}的丰收季。`; tone = "good"; }
  else if (s.trophies.includes("continental_primary")) { text = `${s.age}岁赢下洲际冠军！${s.clubName}登顶。`; tone = "good"; }
  else if (s.trophies.length === 1) {
    const t0 = s.trophies[0]!;
    // national trophies belong to the country, not the club — 「随国家队拿下」,
    // not「随[club]拿下」(a World Cup is not won with West Ham).
    text = (t0 === "world_cup" || t0 === "national_continental")
      ? `${s.age}岁随国家队拿下${BEAT_TROPHY_NAME[t0]}。`
      : `${s.age}岁随${s.clubName}拿下${BEAT_TROPHY_NAME[t0]}。`;
    tone = "good";
  }
  else if (s.relegated) { text = `${s.age}岁${s.clubName}惨遭降级，至暗时刻。`; tone = "bad"; }
  else if (s.role === "substitute" && ovr >= 75) { text = `${s.age}岁在${s.clubName}坐穿板凳，才华虚耗。`; tone = "bad"; }
  else if (s.stats.goals >= 25) { text = `${s.age}岁轰入${s.stats.goals}球，射手本能爆发。`; tone = "good"; }
  else if (ovr >= 90 && player.overall < ovr) { text = `${s.age}岁OVR突破${ovr}，跻身历史级。`; tone = "legendary"; }
  else if (s.role === "starter" && ovr >= 85 && player.overall < ovr) { text = `${s.age}岁在${s.clubName}坐稳主力，巅峰渐至。`; tone = "good"; }
  else return beats; // quiet season — no beat
  return [...beats, { age: s.age, season: seasonNum, text, tone }];
}

/** ADR-0005 L4 岁月催人 diegetic beat: 衰退首次咬到时的一次性身体叙事。
 *  触发在 run.ts 当 growthDelta 首次返回负值（衰退档激活）且年龄 ≥28。
 *  football 体验语言（训练后恢复变慢），不是「衰退期」UI 标签——代入而非上帝视角。
 *  age≤29 用「比同龄人更早」呼应飞升 4 提前衰退（不点名机制，只述球员体感）；
 *  一次性（suffix 去重），衰退期内的后续赛季不再宣告。 */
const DECLINE_BEAT_SUFFIX = "身体开始走下坡了。";
export function appendDeclineBeat(beats: readonly CareerBeat[], age: number): readonly CareerBeat[] {
  if (beats.some((b) => b.text.endsWith(DECLINE_BEAT_SUFFIX))) return beats;
  const early = age <= 29;
  const text = early
    ? `${age}岁，训练后恢复得越来越慢——身体比同龄人更早${DECLINE_BEAT_SUFFIX}`
    : `${age}岁，训练后恢复得越来越慢，岁月不饶人，${DECLINE_BEAT_SUFFIX}`;
  return [...beats, { age, season: 0, text, tone: "bad" }];
}

/** P-NAT: a national-team narrative beat — the parallel national storyline's
 *  milestones, appended alongside the club beats so the feed carries BOTH
 *  careers. At most one national beat per season (the most significant national
 *  event); a champion trophy is skipped (appendSeasonBeats already recorded
 *  the 「捧起世界杯」 moment). */
const NAT_FAREWELL_SUFFIX = "国脚生涯就此落幕。";
export function appendNationalBeat(beats: readonly CareerBeat[], s: SeasonResult, prev: SeasonResult | undefined, seasonNum: number): readonly CareerBeat[] {
  const nat = s.national;
  if (!nat) return beats;
  const prevStatus = prev?.national?.status;
  const prevCalledUp = prev?.national?.calledUp ?? false;
  // P-NAT 老将告别: 上季还在名单里, 这季征召没有你 —— 国脚生涯的落幕和俱乐部线
  // 的「无人问津」对称, 值一条节拍。31 岁起才算告别; 年轻时的落选只是起伏。
  if (!nat.calledUp) {
    // 落幕只播一次: 门槛线上下震荡(入选→落选→再入选)不该反复宣告告别。
    if (prevCalledUp && s.age >= 31 && !beats.some((b) => b.text.endsWith(NAT_FAREWELL_SUFFIX))) {
      return [...beats, { age: s.age, season: seasonNum, text: `${s.age}岁再没等来国家队的征召，${NAT_FAREWELL_SUFFIX}`, tone: "bad" }];
    }
    return beats;
  }
  if (nat.tournament?.trophy) return beats; // champion — already a club beat
  if (nat.status === "captain" && prevStatus !== "captain") {
    return [...beats, { age: s.age, season: seasonNum, text: `${s.age}岁戴上国家队队长袖标，扛起祖国旗帜。`, tone: "legendary" }];
  }
  if (nat.tournament?.stage === "亚军") {
    return [...beats, { age: s.age, season: seasonNum, text: `${s.age}岁随国家队杀入决赛惜获亚军，虽败犹荣。`, tone: "good" }];
  }
  if (nat.status === "debut" && !prevCalledUp) {
    return [...beats, { age: s.age, season: seasonNum, text: `${s.age}岁首次入选国家队！身披祖国战袍。`, tone: "good" }];
  }
  if (nat.tournament?.stage === "四强") {
    return [...beats, { age: s.age, season: seasonNum, text: `${s.age}岁随国家队杀入四强，举国沸腾。`, tone: "good" }];
  }
  return beats;
}

// ───────────────────────────── retirement narrative (P-A1 / P-A20) ─────────────────────────────
//
// The two capstone beats — the retirement reason line + the post-career path
// line — are pure functions of the career's final shape (reason, peak OVR,
// trophies, awards, final market value). Moved here from finalizeRun so the
// orchestrator calls prose rather than authoring it. Behaviour-identical; the
// regress 文案 layer verifies every string.

export interface RetirementNarrative {
  reasonText: string;
  reasonTone: CareerBeat["tone"];
  postCareer: string;
  postCareerTone: CareerBeat["tone"];
}

export function retirementNarrative(
  finalReason: string,
  maxOverall: number,
  trophies: readonly Trophy[],
  awards: readonly Award[],
  finalMv: number,
): RetirementNarrative {
  const reasonText = finalReason === "age" ? "年迈挂靴，传奇落幕。"
    : finalReason === "faded" ? "英雄迟暮，带着荣光离场。"
    : finalReason === "journeyman" ? "坚守多年，体面挂靴。"
    : finalReason === "no_offers" ? "无人问津，黯然离场。"
    : finalReason === "injury" ? "身体先于梦想倒下——医学退役。"
    : "主动挂靴，功成身退。";
  const reasonTone: CareerBeat["tone"] = finalReason === "no_offers" || finalReason === "injury" ? "bad" : "neutral";
  // P-A20: post-career path — determined by peak + trophies + final value.
  let postCareer = "回归平民生活，远离聚光灯。";
  if (finalReason === "injury") {
    postCareer = maxOverall >= 85
      ? "天妒英才——全世界都在问「如果他没受伤」。你成了足球史上永远的假设。"
      : "伤病带走了生涯。你转型康复师，帮年轻球员避开你走过的坑。";
  }
  else if (maxOverall >= 90 && trophies.includes("world_cup")) postCareer = "以世界杯英雄之姿退役，举国铭记。";
  else if (maxOverall >= 90 && awards.includes("ballon_dor")) postCareer = "金球先生退役，执教邀约如雪片飞来。";
  else if (maxOverall >= 90) postCareer = "传奇挂靴，转型名帅，执教邀约不断。";
  else if (maxOverall >= 85 && trophies.length >= 5) postCareer = "功勋老将退役，受邀担任俱乐部形象大使。";
  else if (finalMv >= 20) postCareer = "身价不菲，转型足球评论员，活跃于荧屏。";
  else if (maxOverall >= 80 || finalReason === "faded") postCareer = "体面退役，回到母国青训执教。";
  else if (finalReason === "journeyman") postCareer = "多年坚守，回到低级别联赛执教青训。";
  else if (finalReason === "no_offers") postCareer = "无人接手，黯然告别职业足坛。";
  const postCareerTone: CareerBeat["tone"] = maxOverall >= 90 ? "legendary" : "neutral";
  return { reasonText, reasonTone, postCareer, postCareerTone };
}
