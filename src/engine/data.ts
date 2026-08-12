/**
 * Static game data — leagues, national teams, positions, reputation tiers,
 * growth profiles, and the probability lookup tables that drive the sim.
 *
 * Reputations are integer tiers 0..5 throughout. Trophy base probabilities are
 * per-season Bernoulli probabilities indexed by the appropriate reputation
 * tier; the sim multiplies them by a "star difficulty" factor before rolling.
 *
 * This file is pure data + pure functions; no RNG, no React.
 */

// ───────────────────────────── positions ─────────────────────────────

export type Position =
  | "GK"
  | "CB" | "LB" | "RB"
  | "CDM" | "CM"
  | "LM" | "RM" | "CAM"
  | "LW" | "RW" | "ST";

export type RoleGroup = "goalkeeper" | "defensive" | "support" | "creator" | "attacker";

export const ROLE_GROUP: Record<Position, RoleGroup> = {
  GK: "goalkeeper",
  CB: "defensive", LB: "defensive", RB: "defensive",
  CDM: "defensive", CM: "support",
  LM: "creator", RM: "creator", CAM: "creator",
  LW: "attacker", RW: "attacker", ST: "attacker",
};

export const ALL_POSITIONS: readonly Position[] = [
  "GK", "CB", "LB", "RB", "CDM", "CM", "LM", "RM", "CAM", "LW", "RW", "ST",
];

// award modifier: forwards ×1, central mids ×0.5, defenders ×0.25
export function awardPositionMod(pos: Position): number {
  if (pos === "CB" || pos === "LB" || pos === "RB") return 0.25;
  if (pos === "CM" || pos === "CDM") return 0.5;
  return 1;
}

// ───────────────────────────── signature stat (P-POS) ─────────────────────────────
// 位置平衡·可见性: 每个位置组的「招牌数据」—— 球迷记住这个位置的那个计数。全部
// 已在 SeasonStats 里 tracked, 不新增模拟数据。前锋→进球、组织+CM→助攻、
// 防守+GK→零封。三个 surface (赛季账本精英 chip / 生涯总结 peak 行 / run.ts
// MVP 门槛) 共用这套阈值, 单一真源, 零漂移。

/** A position's signature counting stat — the one a fan remembers the role by. */
export type SignatureStat = "goals" | "assists" | "cleanSheets";

export function signatureStatOf(position: Position): SignatureStat {
  const g = ROLE_GROUP[position];
  if (g === "attacker") return "goals";
  if (g === "creator" || g === "support") return "assists";
  return "cleanSheets"; // defensive + goalkeeper
}

/** 精英赛季阈值 (MVP-caliber signature season)。数据 p90 推导, 非手填:
 *  goals p90=30 取 28、cleanSheets p90=17、assists 精英线 18 (≈助攻王级)。
 *  `goals≥28` / `cleanSheets≥17` 与 run.ts 的 MVP `statGreat` 门槛同值 (MVP
 *  资格判定与赛季精英 chip 共用同一门槛, 零漂移); `assists≥18` 为 chip 的签名
 *  阈值 (creator/support 的 MVP 资格另用 ga+as≥25, 二者概念不同可并存:
 *  一个 20球6助的 creator 赛季够 MVP 资格但不构成「助攻巅峰」)。 */
export const SIGNATURE_ELITE: Record<SignatureStat, number> = {
  goals: 28,
  assists: 18,
  cleanSheets: 17,
};

// ───────────────────────────── leagues ─────────────────────────────

export type Confederation = "UEFA" | "CONMEBOL" | "CONCACAF" | "AFC" | "CAF" | "OFC";

export interface League {
  id: string;
  name: string;
  country: string;
  confederation: Confederation;
  tier: 1 | 2;            // 1 = top flight, 2 = second division
  domRep: number;         // domestic reputation 0..5
  contRep: number;        // continental reputation 0..5
  hasDomesticCup: boolean;
  /** 联赛财力系数（母本 salary_wealth）— 联赛整体的薪资支付力。
   *  英超 1.35、沙特 2.0、巴甲 0.5、中甲 0.3。只作用于周薪 computeWage，
   *  不作用于身价：财力 = 联赛「付得起」多少，与球员「值多少」（身价由声望
   *  驱动）是两个独立轴——于是「沙特问题」成真：高薪低声望，溢价但跌身价。 */
  wealth: number;
  /** 工资帽 — 周薪硬上限（€K/周，母本 salary_cap）。仅中超/中甲设置。
   *  卡住明星：去中国能当大鱼，但收入封顶——钱 vs 声望/奖杯的真实取舍。
   *  母本用 3e6/5e5（其内部单位），此处按我们 €K/周量级校准为 180/25。 */
  salaryCap?: number;
  /** 名气溢价（母本 salary_fame）— 该联赛对明星球员支付额外招牌溢价。
   *  仅沙特联开启：低声望 + 高财力 + fame，模型「为名气买单」。溢价随球星
   *  档位放大（≥90 ×1.36 / ≥85 ×1.24 / ≥80 ×1.12，见 sim.ts computeWage）。 */
  fame?: boolean;
  /** 培养档位 0..5 (P-LEAGUE-RES) — 这个联赛「把人练出来」的水平，与 domRep
   *  （声望/关注度）是两回事。缺省 = domRep；只在两者分家时显式覆盖。
   *  domRep 的分辨率不够用：domRep 2 一个桶里装着 中超/日职/K联赛/英冠/阿甲/
   *  MLS/苏超 —— 英冠是通往英超的真实跳板，中超不是，可成长上两者完全一样。
   *  典型分家：钱多但不出人（中超、沙特联 → 调低）、声望不高但盛产球员的
   *  青训国度与跳板联赛（英冠、荷甲、葡超、阿甲、西乙 → 调高）。 */
  devRep?: number;
}

export const LEAGUES: readonly League[] = [
  // 财力 wealth 取自母本 salary_wealth（16 个母本联赛为精确值，其余按足球财力常识估）。
  // 工资帽 salaryCap 单位为 €K/周（母本内部单位不同，按我们量级校准）。fame 仅沙特。
  // ── UEFA top flight ──
  { id: "premier-league", name: "英超", country: "ENG", confederation: "UEFA", tier: 1, domRep: 5, contRep: 5, hasDomesticCup: true, wealth: 1.35 },
  { id: "laliga",         name: "西甲", country: "ESP", confederation: "UEFA", tier: 1, domRep: 5, contRep: 5, hasDomesticCup: true, wealth: 1.05 },
  { id: "serie-a",        name: "意甲", country: "ITA", confederation: "UEFA", tier: 1, domRep: 5, contRep: 4, hasDomesticCup: true, wealth: 1.0 },
  { id: "bundesliga",     name: "德甲", country: "GER", confederation: "UEFA", tier: 1, domRep: 5, contRep: 5, hasDomesticCup: true, wealth: 1.0 },
  { id: "ligue-1",        name: "法甲", country: "FRA", confederation: "UEFA", tier: 1, domRep: 4, contRep: 4, hasDomesticCup: true, wealth: 0.95 },
  { id: "primeira-liga",  name: "葡超", country: "POR", confederation: "UEFA", tier: 1, domRep: 3, contRep: 3, hasDomesticCup: true, wealth: 0.55, devRep: 4 },
  { id: "eredivisie",      name: "荷甲", country: "NED", confederation: "UEFA", tier: 1, domRep: 3, contRep: 3, hasDomesticCup: true, wealth: 0.6, devRep: 4 },
  { id: "super-lig",       name: "土超", country: "TUR", confederation: "UEFA", tier: 1, domRep: 3, contRep: 2, hasDomesticCup: true, wealth: 0.55 },
  { id: "scottish-pred",   name: "苏超", country: "SCO", confederation: "UEFA", tier: 1, domRep: 2, contRep: 2, hasDomesticCup: true, wealth: 0.4 },
  { id: "greek-super",     name: "希腊超", country: "GRE", confederation: "UEFA", tier: 1, domRep: 2, contRep: 2, hasDomesticCup: true, wealth: 0.35 },
  { id: "swiss-super",     name: "瑞士超", country: "SUI", confederation: "UEFA", tier: 1, domRep: 2, contRep: 2, hasDomesticCup: true, wealth: 0.45 },
  { id: "austrian-bund",   name: "奥甲", country: "AUT", confederation: "UEFA", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.4 },
  { id: "czech-liga",      name: "捷克甲", country: "CZE", confederation: "UEFA", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.35 },
  { id: "polish-ekstraklasa", name: "波兰甲", country: "POL", confederation: "UEFA", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.35 },
  { id: "ukrainian-premier", name: "乌超", country: "UKR", confederation: "UEFA", tier: 1, domRep: 2, contRep: 2, hasDomesticCup: true, wealth: 0.4 },
  // ── CONCACAF ──
  { id: "mls",            name: "美职联", country: "USA", confederation: "CONCACAF", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.65, devRep: 1 },
  { id: "liga-mx",        name: "墨甲", country: "MEX", confederation: "CONCACAF", tier: 1, domRep: 3, contRep: 2, hasDomesticCup: true, wealth: 0.45 },
  // ── CAF ──
  { id: "egyptian-pred",  name: "埃及超", country: "EGY", confederation: "CAF", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.3 },
  // ── UEFA second division ──
  { id: "championship",   name: "英冠", country: "ENG", confederation: "UEFA", tier: 2, domRep: 2, contRep: 0, hasDomesticCup: true, wealth: 0.5, devRep: 3 },
  { id: "laliga-2",       name: "西乙", country: "ESP", confederation: "UEFA", tier: 2, domRep: 1, contRep: 0, hasDomesticCup: true, wealth: 0.35, devRep: 2 },
  // ── AFC ──
  { id: "csl",            name: "中超",   country: "CHN", confederation: "AFC", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.9, salaryCap: 180, devRep: 1 },
  { id: "china-league-one", name: "中甲", country: "CHN", confederation: "AFC", tier: 2, domRep: 1, contRep: 0, hasDomesticCup: true, wealth: 0.3, salaryCap: 25, devRep: 0 },
  { id: "j1-league",     name: "日职联", country: "JPN", confederation: "AFC", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.55 },
  { id: "k-league-1",    name: "K联赛",  country: "KOR", confederation: "AFC", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.45 },
  { id: "saudi-pro-league", name: "沙特联", country: "KSA", confederation: "AFC", tier: 1, domRep: 3, contRep: 2, hasDomesticCup: true, wealth: 2.0, fame: true, devRep: 1 },
  // ── CONMEBOL ──
  { id: "brasileirao",    name: "巴甲", country: "BRA", confederation: "CONMEBOL", tier: 1, domRep: 3, contRep: 3, hasDomesticCup: true, wealth: 0.5, devRep: 4 },
  { id: "brasileirao-b",  name: "巴乙", country: "BRA", confederation: "CONMEBOL", tier: 2, domRep: 1, contRep: 0, hasDomesticCup: true, wealth: 0.22, devRep: 2 },
  { id: "argentine-primera", name: "阿甲", country: "ARG", confederation: "CONMEBOL", tier: 1, domRep: 2, contRep: 3, hasDomesticCup: true, wealth: 0.4, devRep: 3 },
];

export function leagueById(id: string): League {
  const l = LEAGUES.find((x) => x.id === id);
  if (!l) throw new Error(`unknown league: ${id}`);
  return l;
}

/**
 * Squad base-overall tier for a league: max of its domestic & continental
 * reputation, clamped 0..5. Used as the "Xn(team)" reputation baseline that a
 * player's OVR is compared against to decide their role.
 */
export function leagueIntlRepTier(league: League): number {
  return Math.max(league.domRep, league.contRep);
}

// ───────────────────────────── clubs ─────────────────────────────
// Clubs are first-class: the player belongs to a specific club, transfers are
// club-to-club, and a club's strength drives squad base + trophy odds — so a
// wonderkid can't carry a minnow to a title; you must transfer up (stepped
// progression, the reference game's core fantasy). Real 2025-26 season data,
// extracted from the target (母本) game's bundle: 61 nations + 230 clubs + 16 leagues.

export interface Club {
  readonly id: string;
  readonly name: string;
  readonly leagueId: string;
  readonly domRep: number;   // 0-5 domestic reputation (母本 field 5)
  readonly contRep: number;  // 0-5 continental reputation (母本 field 6)
  readonly intlRep: number;  // 0-5 international reputation (母本 field 7)
  /** composite strength = max(domRep, contRep); drives squad base + trophy odds. */
  readonly rep: number;
  readonly rivalId?: string;  // iconic same-city/main rival, for derbies
}

export const CLUBS: readonly Club[] = [
  { id: "man-city", name: "曼城", leagueId: "premier-league", domRep: 5, contRep: 5, intlRep: 5, rep: 9, rivalId: "man-utd" },
  { id: "liverpool", name: "利物浦", leagueId: "premier-league", domRep: 4, contRep: 4, intlRep: 5, rep: 8, rivalId: "everton" },
  { id: "arsenal", name: "阿森纳", leagueId: "premier-league", domRep: 5, contRep: 5, intlRep: 5, rep: 9, rivalId: "tottenham" },
  { id: "chelsea", name: "切尔西", leagueId: "premier-league", domRep: 4, contRep: 4, intlRep: 4, rep: 8 },
  { id: "man-utd", name: "曼联", leagueId: "premier-league", domRep: 4, contRep: 4, intlRep: 4, rep: 8, rivalId: "man-city" },
  { id: "tottenham", name: "热刺", leagueId: "premier-league", domRep: 3, contRep: 3, intlRep: 4, rep: 7, rivalId: "arsenal" },
  { id: "newcastle", name: "纽卡斯尔联", leagueId: "premier-league", domRep: 2, contRep: 2, intlRep: 3, rep: 6 },
  { id: "aston-villa", name: "阿斯顿维拉", leagueId: "premier-league", domRep: 3, contRep: 3, intlRep: 3, rep: 7 },
  { id: "brighton", name: "布莱顿", leagueId: "premier-league", domRep: 3, contRep: 3, intlRep: 3, rep: 6 },
  { id: "west-ham", name: "西汉姆联", leagueId: "premier-league", domRep: 2, contRep: 2, intlRep: 3, rep: 6 },
  { id: "nottingham", name: "诺丁汉森林", leagueId: "premier-league", domRep: 2, contRep: 2, intlRep: 2, rep: 5 },
  { id: "crystal-palace", name: "水晶宫", leagueId: "premier-league", domRep: 3, contRep: 3, intlRep: 3, rep: 6 },
  { id: "fulham", name: "富勒姆", leagueId: "premier-league", domRep: 1, contRep: 1, intlRep: 2, rep: 5 },
  { id: "brentford", name: "布伦特福德", leagueId: "premier-league", domRep: 1, contRep: 1, intlRep: 2, rep: 5 },
  { id: "everton", name: "埃弗顿", leagueId: "premier-league", domRep: 1, contRep: 1, intlRep: 2, rep: 5, rivalId: "liverpool" },
  { id: "wolves", name: "狼队", leagueId: "premier-league", domRep: 1, contRep: 1, intlRep: 2, rep: 5 },
  { id: "bournemouth", name: "伯恩茅斯", leagueId: "premier-league", domRep: 1, contRep: 1, intlRep: 2, rep: 5 },
  { id: "leeds", name: "利兹联", leagueId: "premier-league", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "burnley", name: "伯恩利", leagueId: "premier-league", domRep: 0, contRep: 0, intlRep: 1, rep: 2 },
  { id: "sunderland", name: "桑德兰", leagueId: "premier-league", domRep: 0, contRep: 0, intlRep: 1, rep: 2 },
  { id: "leicester", name: "莱斯特城", leagueId: "championship", domRep: 3, contRep: 0, intlRep: 2, rep: 4 },
  { id: "southampton", name: "南安普顿", leagueId: "championship", domRep: 3, contRep: 0, intlRep: 2, rep: 4 },
  { id: "ipswich", name: "伊普斯维奇", leagueId: "championship", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "middlesbrough", name: "米德尔斯堡", leagueId: "championship", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "west-brom", name: "西布罗姆维奇", leagueId: "championship", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "coventry", name: "考文垂", leagueId: "championship", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "norwich", name: "诺维奇", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "watford", name: "沃特福德", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "hull", name: "赫尔城", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "stoke", name: "斯托克城", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "millwall", name: "米尔沃尔", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "preston", name: "普雷斯顿", leagueId: "championship", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "swansea", name: "斯旺西", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "cardiff", name: "卡迪夫城", leagueId: "championship", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "blackburn", name: "布莱克本", leagueId: "championship", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "qpr", name: "女王公园巡游者", leagueId: "championship", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "real-madrid", name: "皇家马德里", leagueId: "laliga", domRep: 5, contRep: 5, intlRep: 5, rep: 9, rivalId: "barcelona" },
  { id: "barcelona", name: "巴塞罗那", leagueId: "laliga", domRep: 5, contRep: 5, intlRep: 5, rep: 9, rivalId: "real-madrid" },
  { id: "atletico-madrid", name: "马德里竞技", leagueId: "laliga", domRep: 4, contRep: 4, intlRep: 4, rep: 8, rivalId: "real-madrid" },
  { id: "villarreal", name: "比利亚雷亚尔", leagueId: "laliga", domRep: 3, contRep: 3, intlRep: 3, rep: 6 },
  { id: "athletic-bilbao", name: "毕尔巴鄂竞技", leagueId: "laliga", domRep: 3, contRep: 3, intlRep: 3, rep: 6 },
  { id: "real-sociedad", name: "皇家社会", leagueId: "laliga", domRep: 2, contRep: 2, intlRep: 3, rep: 5 },
  { id: "real-betis", name: "皇家贝蒂斯", leagueId: "laliga", domRep: 2, contRep: 2, intlRep: 3, rep: 5, rivalId: "sevilla" },
  { id: "sevilla", name: "塞维利亚", leagueId: "laliga", domRep: 2, contRep: 2, intlRep: 3, rep: 5, rivalId: "real-betis" },
  { id: "valencia", name: "瓦伦西亚", leagueId: "laliga", domRep: 2, contRep: 1, intlRep: 2, rep: 4 },
  { id: "girona", name: "赫罗纳", leagueId: "laliga", domRep: 2, contRep: 1, intlRep: 2, rep: 4 },
  { id: "celta-vigo", name: "塞尔塔", leagueId: "laliga", domRep: 1, contRep: 1, intlRep: 2, rep: 4 },
  { id: "osasuna", name: "奥萨苏纳", leagueId: "laliga", domRep: 1, contRep: 1, intlRep: 2, rep: 4 },
  { id: "rayo-vallecano", name: "巴列卡诺", leagueId: "laliga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "mallorca", name: "马洛卡", leagueId: "laliga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "getafe", name: "赫塔菲", leagueId: "laliga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "espanyol", name: "西班牙人", leagueId: "laliga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "alaves", name: "阿拉维斯", leagueId: "laliga", domRep: 0, contRep: 0, intlRep: 1, rep: 2 },
  { id: "elche", name: "埃尔切", leagueId: "laliga", domRep: 0, contRep: 0, intlRep: 1, rep: 2 },
  { id: "levante", name: "莱万特", leagueId: "laliga", domRep: 0, contRep: 0, intlRep: 1, rep: 2 },
  { id: "oviedo", name: "奥维耶多", leagueId: "laliga", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "las-palmas", name: "拉斯帕尔马斯", leagueId: "laliga-2", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "real-valladolid", name: "巴利亚多利德", leagueId: "laliga-2", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "deportivo", name: "拉科鲁尼亚", leagueId: "laliga-2", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "racing-santander", name: "桑坦德竞技", leagueId: "laliga-2", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "almeria", name: "阿尔梅里亚", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "zaragoza", name: "萨拉戈萨", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "sporting-gijon", name: "希洪竞技", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "granada", name: "格拉纳达", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "cadiz", name: "加的斯", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "huesca", name: "韦斯卡", leagueId: "laliga-2", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "eibar", name: "埃瓦尔", leagueId: "laliga-2", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "mirandes", name: "米兰德斯", leagueId: "laliga-2", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "inter", name: "国际米兰", leagueId: "serie-a", domRep: 5, contRep: 4, intlRep: 5, rep: 8, rivalId: "ac-milan" },
  { id: "napoli", name: "那不勒斯", leagueId: "serie-a", domRep: 4, contRep: 3, intlRep: 4, rep: 7 },
  { id: "ac-milan", name: "AC米兰", leagueId: "serie-a", domRep: 4, contRep: 3, intlRep: 4, rep: 7, rivalId: "inter" },
  { id: "juventus", name: "尤文图斯", leagueId: "serie-a", domRep: 4, contRep: 4, intlRep: 4, rep: 8, rivalId: "torino" },
  { id: "atalanta", name: "亚特兰大", leagueId: "serie-a", domRep: 3, contRep: 3, intlRep: 4, rep: 7 },
  { id: "roma", name: "罗马", leagueId: "serie-a", domRep: 3, contRep: 3, intlRep: 4, rep: 7, rivalId: "lazio" },
  { id: "lazio", name: "拉齐奥", leagueId: "serie-a", domRep: 2, contRep: 2, intlRep: 3, rep: 6, rivalId: "roma" },
  { id: "fiorentina", name: "佛罗伦萨", leagueId: "serie-a", domRep: 2, contRep: 2, intlRep: 3, rep: 6 },
  { id: "bologna", name: "博洛尼亚", leagueId: "serie-a", domRep: 2, contRep: 2, intlRep: 3, rep: 6 },
  { id: "como", name: "科莫", leagueId: "serie-a", domRep: 3, contRep: 3, intlRep: 2, rep: 5 },
  { id: "torino", name: "都灵", leagueId: "serie-a", domRep: 1, contRep: 1, intlRep: 2, rep: 5 },
  { id: "udinese", name: "乌迪内斯", leagueId: "serie-a", domRep: 1, contRep: 1, intlRep: 2, rep: 5 },
  { id: "genoa", name: "热那亚", leagueId: "serie-a", domRep: 1, contRep: 0, intlRep: 1, rep: 5 },
  { id: "cagliari", name: "卡利亚里", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "sassuolo", name: "萨索洛", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "hellas-verona", name: "维罗纳", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "parma", name: "帕尔马", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "lecce", name: "莱切", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "pisa", name: "比萨", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "cremonese", name: "克雷莫纳", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "bayern", name: "拜仁慕尼黑", leagueId: "bundesliga", domRep: 5, contRep: 5, intlRep: 5, rep: 9 },
  { id: "dortmund", name: "多特蒙德", leagueId: "bundesliga", domRep: 4, contRep: 4, intlRep: 4, rep: 8 },
  { id: "rb-leipzig", name: "RB莱比锡", leagueId: "bundesliga", domRep: 3, contRep: 3, intlRep: 3, rep: 6 },
  { id: "stuttgart", name: "斯图加特", leagueId: "bundesliga", domRep: 3, contRep: 3, intlRep: 3, rep: 6 },
  { id: "eintracht", name: "法兰克福", leagueId: "bundesliga", domRep: 3, contRep: 3, intlRep: 3, rep: 6 },
  { id: "freiburg", name: "弗赖堡", leagueId: "bundesliga", domRep: 2, contRep: 2, intlRep: 2, rep: 5 },
  { id: "wolfsburg", name: "沃尔夫斯堡", leagueId: "bundesliga", domRep: 2, contRep: 1, intlRep: 2, rep: 5 },
  { id: "union-berlin", name: "柏林联合", leagueId: "bundesliga", domRep: 1, contRep: 1, intlRep: 2, rep: 4 },
  { id: "werder", name: "云达不莱梅", leagueId: "bundesliga", domRep: 1, contRep: 1, intlRep: 2, rep: 4 },
  { id: "gladbach", name: "门兴格拉德巴赫", leagueId: "bundesliga", domRep: 1, contRep: 1, intlRep: 2, rep: 4 },
  { id: "hoffenheim", name: "霍芬海姆", leagueId: "bundesliga", domRep: 1, contRep: 1, intlRep: 2, rep: 4 },
  { id: "augsburg", name: "奥格斯堡", leagueId: "bundesliga", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "st-pauli", name: "圣保利", leagueId: "bundesliga", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "heidenheim", name: "海登海姆", leagueId: "bundesliga", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "hamburg", name: "汉堡", leagueId: "bundesliga", domRep: 0, contRep: 0, intlRep: 1, rep: 2 },
  { id: "koln", name: "科隆", leagueId: "bundesliga", domRep: 0, contRep: 0, intlRep: 1, rep: 2 },
  { id: "psg", name: "巴黎圣日耳曼", leagueId: "ligue-1", domRep: 5, contRep: 5, intlRep: 5, rep: 9 },
  { id: "marseille", name: "马赛", leagueId: "ligue-1", domRep: 3, contRep: 3, intlRep: 4, rep: 7 },
  { id: "monaco", name: "摩纳哥", leagueId: "ligue-1", domRep: 3, contRep: 3, intlRep: 4, rep: 7 },
  { id: "lille", name: "里尔", leagueId: "ligue-1", domRep: 3, contRep: 2, intlRep: 3, rep: 7 },
  { id: "lyon", name: "里昂", leagueId: "ligue-1", domRep: 2, contRep: 2, intlRep: 3, rep: 6 },
  { id: "nice", name: "尼斯", leagueId: "ligue-1", domRep: 2, contRep: 2, intlRep: 3, rep: 6 },
  { id: "lens", name: "朗斯", leagueId: "ligue-1", domRep: 2, contRep: 2, intlRep: 3, rep: 6 },
  { id: "rennes", name: "雷恩", leagueId: "ligue-1", domRep: 2, contRep: 1, intlRep: 2, rep: 5 },
  { id: "strasbourg", name: "斯特拉斯堡", leagueId: "ligue-1", domRep: 1, contRep: 1, intlRep: 2, rep: 5 },
  { id: "toulouse", name: "图卢兹", leagueId: "ligue-1", domRep: 1, contRep: 1, intlRep: 2, rep: 5 },
  { id: "brest", name: "布雷斯特", leagueId: "ligue-1", domRep: 1, contRep: 1, intlRep: 2, rep: 5 },
  { id: "nantes", name: "南特", leagueId: "ligue-1", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "lorient", name: "洛里昂", leagueId: "ligue-1", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "auxerre", name: "欧塞尔", leagueId: "ligue-1", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "le-havre", name: "勒阿弗尔", leagueId: "ligue-1", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "paris-fc", name: "巴黎FC", leagueId: "ligue-1", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "angers", name: "昂热", leagueId: "ligue-1", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "metz", name: "梅斯", leagueId: "ligue-1", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "porto", name: "波尔图", leagueId: "primeira-liga", domRep: 4, contRep: 3, intlRep: 3, rep: 7, rivalId: "benfica" },
  { id: "benfica", name: "本菲卡", leagueId: "primeira-liga", domRep: 4, contRep: 3, intlRep: 3, rep: 7, rivalId: "porto" },
  { id: "sporting-cp", name: "里斯本竞技", leagueId: "primeira-liga", domRep: 4, contRep: 3, intlRep: 3, rep: 7, rivalId: "benfica" },
  { id: "braga", name: "布拉加", leagueId: "primeira-liga", domRep: 2, contRep: 1, intlRep: 1, rep: 5 },
  { id: "shanghai-port", name: "上海海港", leagueId: "csl", domRep: 4, contRep: 3, intlRep: 2, rep: 4, rivalId: "shanghai-shenhua" },
  { id: "shanghai-shenhua", name: "上海申花", leagueId: "csl", domRep: 4, contRep: 2, intlRep: 2, rep: 4, rivalId: "shanghai-port" },
  { id: "shandong-taishan", name: "山东泰山", leagueId: "csl", domRep: 4, contRep: 3, intlRep: 2, rep: 4 },
  { id: "chengdu-rongcheng", name: "成都蓉城", leagueId: "csl", domRep: 4, contRep: 2, intlRep: 2, rep: 4 },
  { id: "beijing-guoan", name: "北京国安", leagueId: "csl", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "zhejiang", name: "浙江队", leagueId: "csl", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "tianjin-jinmen", name: "天津津门虎", leagueId: "csl", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "wuhan-three-towns", name: "武汉三镇", leagueId: "csl", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "henan", name: "河南队", leagueId: "csl", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "qingdao-hainiu", name: "青岛海牛", leagueId: "csl", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "dalian-yingbo", name: "大连英博", leagueId: "csl", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "shenzhen-peng-city", name: "深圳新鹏城", leagueId: "csl", domRep: 0, contRep: 0, intlRep: 1, rep: 1 },
  { id: "yunnan-yukun", name: "云南玉昆", leagueId: "csl", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "qingdao-west-coast", name: "青岛西海岸", leagueId: "csl", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "chongqing-tongliang", name: "重庆铜梁龙", leagueId: "csl", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "liaoning-tieren", name: "辽宁铁人", leagueId: "csl", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "guangxi-pingguo", name: "广西平果哈嘹", leagueId: "china-league-one", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "shijiazhuang", name: "石家庄功夫", leagueId: "china-league-one", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "nantong-zhiyun", name: "南通支云", leagueId: "china-league-one", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "changchun-yatai", name: "长春亚泰", leagueId: "china-league-one", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "suzhou-dongwu", name: "苏州东吴", leagueId: "china-league-one", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "yanbian-longding", name: "延边龙鼎", leagueId: "china-league-one", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "wuxi-wugou", name: "无锡吴钩", leagueId: "china-league-one", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "shaanxi-union", name: "陕西联合", leagueId: "china-league-one", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "hubei-istar", name: "湖北青年星", leagueId: "china-league-one", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "dalian-kuncheng", name: "大连鲲城", leagueId: "china-league-one", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "foshan-nanshi", name: "佛山南狮", leagueId: "china-league-one", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "meizhou-hakka", name: "梅州客家", leagueId: "china-league-one", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "kawasaki-frontale", name: "川崎前锋", leagueId: "j1-league", domRep: 4, contRep: 3, intlRep: 2, rep: 4 },
  { id: "yokohama-marinos", name: "横滨水手", leagueId: "j1-league", domRep: 4, contRep: 3, intlRep: 2, rep: 4 },
  { id: "vissel-kobe", name: "神户胜利船", leagueId: "j1-league", domRep: 4, contRep: 3, intlRep: 2, rep: 4 },
  { id: "kashima-antlers", name: "鹿岛鹿角", leagueId: "j1-league", domRep: 4, contRep: 2, intlRep: 2, rep: 4 },
  { id: "urawa-reds", name: "浦和红钻", leagueId: "j1-league", domRep: 3, contRep: 3, intlRep: 2, rep: 3 },
  { id: "sanfrecce-hiroshima", name: "广岛三箭", leagueId: "j1-league", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "gamba-osaka", name: "大阪钢巴", leagueId: "j1-league", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "machida-zelvia", name: "町田泽维亚", leagueId: "j1-league", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "nagoya-grampus", name: "名古屋鲸八", leagueId: "j1-league", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "cerezo-osaka", name: "大阪樱花", leagueId: "j1-league", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "fc-tokyo", name: "FC东京", leagueId: "j1-league", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "kashiwa-reysol", name: "柏太阳神", leagueId: "j1-league", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "tokyo-verdy", name: "东京绿茵", leagueId: "j1-league", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "avispa-fukuoka", name: "福冈黄蜂", leagueId: "j1-league", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "kyoto-sanga", name: "京都不死鸟", leagueId: "j1-league", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "albirex-niigata", name: "新泻天鹅", leagueId: "j1-league", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "consadole-sapporo", name: "札幌冈萨多", leagueId: "j1-league", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "shimizu-s-pulse", name: "清水心跳", leagueId: "j1-league", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "shonan-bellmare", name: "湘南比马", leagueId: "j1-league", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "fagiano-okayama", name: "冈山绿雉", leagueId: "j1-league", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "jeonbuk-hyundai", name: "全北现代", leagueId: "k-league-1", domRep: 4, contRep: 3, intlRep: 2, rep: 4 },
  { id: "ulsan-hd", name: "蔚山HD", leagueId: "k-league-1", domRep: 4, contRep: 3, intlRep: 2, rep: 4 },
  { id: "pohang-steelers", name: "浦项制铁", leagueId: "k-league-1", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "fc-seoul", name: "FC首尔", leagueId: "k-league-1", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "gangwon-fc", name: "江原FC", leagueId: "k-league-1", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "gwangju-fc", name: "光州FC", leagueId: "k-league-1", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "daegu-fc", name: "大邱FC", leagueId: "k-league-1", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "jeju-sk", name: "济州SK", leagueId: "k-league-1", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "daejeon-hana", name: "大田韩亚市民", leagueId: "k-league-1", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "suwon-fc", name: "水原FC", leagueId: "k-league-1", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "incheon-united", name: "仁川联", leagueId: "k-league-1", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "anyang-fc", name: "FC安养", leagueId: "k-league-1", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "al-hilal", name: "利雅得新月", leagueId: "saudi-pro-league", domRep: 5, contRep: 4, intlRep: 3, rep: 7, rivalId: "al-nassr" },
  { id: "al-nassr", name: "利雅得胜利", leagueId: "saudi-pro-league", domRep: 4, contRep: 3, intlRep: 3, rep: 6, rivalId: "al-hilal" },
  { id: "al-ittihad", name: "吉达联合", leagueId: "saudi-pro-league", domRep: 4, contRep: 3, intlRep: 3, rep: 6 },
  { id: "al-ahli", name: "吉达国民", leagueId: "saudi-pro-league", domRep: 4, contRep: 3, intlRep: 3, rep: 6 },
  { id: "flamengo", name: "弗拉门戈", leagueId: "brasileirao", domRep: 5, contRep: 5, intlRep: 4, rep: 7, rivalId: "fluminense" },
  { id: "palmeiras", name: "帕尔梅拉斯", leagueId: "brasileirao", domRep: 5, contRep: 5, intlRep: 4, rep: 7, rivalId: "corinthians" },
  { id: "botafogo", name: "博塔弗戈", leagueId: "brasileirao", domRep: 4, contRep: 4, intlRep: 3, rep: 6 },
  { id: "sao-paulo", name: "圣保罗", leagueId: "brasileirao", domRep: 3, contRep: 4, intlRep: 3, rep: 6 },
  { id: "atletico-mineiro", name: "米内罗竞技", leagueId: "brasileirao", domRep: 3, contRep: 4, intlRep: 3, rep: 6 },
  { id: "fluminense", name: "弗鲁米嫩塞", leagueId: "brasileirao", domRep: 3, contRep: 4, intlRep: 3, rep: 6, rivalId: "flamengo" },
  { id: "cruzeiro", name: "克鲁塞罗", leagueId: "brasileirao", domRep: 3, contRep: 3, intlRep: 3, rep: 5 },
  { id: "gremio", name: "格雷米奥", leagueId: "brasileirao", domRep: 3, contRep: 3, intlRep: 3, rep: 5 },
  { id: "internacional", name: "国际队", leagueId: "brasileirao", domRep: 3, contRep: 3, intlRep: 3, rep: 5 },
  { id: "corinthians", name: "科林蒂安", leagueId: "brasileirao", domRep: 3, contRep: 3, intlRep: 3, rep: 5, rivalId: "palmeiras" },
  { id: "bahia", name: "巴伊亚", leagueId: "brasileirao", domRep: 3, contRep: 2, intlRep: 2, rep: 5 },
  { id: "santos", name: "桑托斯", leagueId: "brasileirao", domRep: 2, contRep: 3, intlRep: 2, rep: 5 },
  { id: "fortaleza", name: "福塔莱萨", leagueId: "brasileirao", domRep: 2, contRep: 2, intlRep: 2, rep: 4 },
  { id: "bragantino", name: "布拉甘蒂诺", leagueId: "brasileirao", domRep: 2, contRep: 2, intlRep: 2, rep: 4 },
  { id: "vasco", name: "瓦斯科", leagueId: "brasileirao", domRep: 2, contRep: 2, intlRep: 2, rep: 4 },
  { id: "sport-recife", name: "累西腓体育", leagueId: "brasileirao", domRep: 1, contRep: 1, intlRep: 1, rep: 2 },
  { id: "vitoria", name: "维托利亚", leagueId: "brasileirao", domRep: 1, contRep: 1, intlRep: 1, rep: 2 },
  { id: "ceara", name: "塞阿拉", leagueId: "brasileirao", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "mirassol", name: "米拉索尔", leagueId: "brasileirao", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "juventude", name: "胡文图德", leagueId: "brasileirao", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "athletico-paranaense", name: "巴拉纳竞技", leagueId: "brasileirao-b", domRep: 2, contRep: 2, intlRep: 1, rep: 3 },
  { id: "coritiba", name: "科里蒂巴", leagueId: "brasileirao-b", domRep: 2, contRep: 1, intlRep: 1, rep: 3 },
  { id: "chapecoense", name: "沙佩科恩斯", leagueId: "brasileirao-b", domRep: 1, contRep: 1, intlRep: 1, rep: 2 },
  { id: "goias", name: "戈亚斯", leagueId: "brasileirao-b", domRep: 1, contRep: 0, intlRep: 0, rep: 2 },
  { id: "cuiaba", name: "库亚巴", leagueId: "brasileirao-b", domRep: 1, contRep: 0, intlRep: 0, rep: 2 },
  { id: "criciuma", name: "克里西乌马", leagueId: "brasileirao-b", domRep: 1, contRep: 0, intlRep: 0, rep: 2 },
  { id: "atletico-goianiense", name: "戈亚尼恩斯竞技", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "avai", name: "阿瓦伊", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "america-mineiro", name: "米内罗美洲", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "paysandu", name: "帕伊桑杜", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 0, rivalId: "remo" },
  { id: "river-plate", name: "河床", leagueId: "argentine-primera", domRep: 5, contRep: 4, intlRep: 4, rep: 7, rivalId: "boca-juniors" },
  { id: "boca-juniors", name: "博卡青年", leagueId: "argentine-primera", domRep: 5, contRep: 3, intlRep: 3, rep: 7, rivalId: "river-plate" },
  { id: "racing-club", name: "竞技", leagueId: "argentine-primera", domRep: 3, contRep: 3, intlRep: 3, rep: 5 },
  { id: "estudiantes", name: "拉普拉塔大学生", leagueId: "argentine-primera", domRep: 3, contRep: 2, intlRep: 2, rep: 5, rivalId: "gimnasia-lp" },
  { id: "velez-sarsfield", name: "贝莱斯", leagueId: "argentine-primera", domRep: 3, contRep: 2, intlRep: 2, rep: 5 },
  { id: "independiente", name: "独立", leagueId: "argentine-primera", domRep: 2, contRep: 2, intlRep: 2, rep: 4 },
  { id: "san-lorenzo", name: "圣洛伦索", leagueId: "argentine-primera", domRep: 2, contRep: 2, intlRep: 2, rep: 4 },
  { id: "talleres", name: "塔耶雷斯", leagueId: "argentine-primera", domRep: 2, contRep: 1, intlRep: 1, rep: 4 },
  { id: "newells-old-boys", name: "纽维尔老男孩", leagueId: "argentine-primera", domRep: 1, contRep: 0, intlRep: 0, rep: 3, rivalId: "rosario-central" },
  { id: "argentinos-juniors", name: "阿根廷青年人", leagueId: "argentine-primera", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  // ── 荷甲 ──
  { id: "ajax", name: "阿贾克斯", leagueId: "eredivisie", domRep: 3, contRep: 3, intlRep: 4, rep: 6, rivalId: "feijenoord" },
  { id: "psv", name: "埃因霍温", leagueId: "eredivisie", domRep: 4, contRep: 3, intlRep: 4, rep: 6, rivalId: "ajax" },
  { id: "feijenoord", name: "费耶诺德", leagueId: "eredivisie", domRep: 3, contRep: 2, intlRep: 3, rep: 6, rivalId: "ajax" },
  { id: "az-alkmaar", name: "阿尔克马尔", leagueId: "eredivisie", domRep: 2, contRep: 1, intlRep: 2, rep: 5 },
  { id: "twente", name: "特温特", leagueId: "eredivisie", domRep: 1, contRep: 1, intlRep: 1, rep: 4 },
  { id: "heerenveen", name: "海伦芬", leagueId: "eredivisie", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "utrecht", name: "乌德勒支", leagueId: "eredivisie", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "waalwijk", name: "瓦尔韦克", leagueId: "eredivisie", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 土超 ──
  { id: "galatasaray", name: "加拉塔萨雷", leagueId: "super-lig", domRep: 4, contRep: 2, intlRep: 3, rep: 7, rivalId: "fenerbahce" },
  { id: "fenerbahce", name: "费内巴切", leagueId: "super-lig", domRep: 4, contRep: 2, intlRep: 3, rep: 6, rivalId: "galatasaray" },
  { id: "besiktas", name: "贝西克塔斯", leagueId: "super-lig", domRep: 3, contRep: 2, intlRep: 3, rep: 6 },
  { id: "trabzonspor", name: "特拉布宗体育", leagueId: "super-lig", domRep: 2, contRep: 1, intlRep: 2, rep: 5 },
  { id: "basaksehir", name: "巴萨克赛尔", leagueId: "super-lig", domRep: 1, contRep: 1, intlRep: 1, rep: 4 },
  { id: "antalyaspor", name: "安塔利亚体育", leagueId: "super-lig", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  // ── 苏超 ──
  { id: "celtic", name: "凯尔特人", leagueId: "scottish-pred", domRep: 3, contRep: 2, intlRep: 3, rep: 6, rivalId: "rangers" },
  { id: "rangers", name: "流浪者", leagueId: "scottish-pred", domRep: 3, contRep: 2, intlRep: 3, rep: 6, rivalId: "celtic" },
  { id: "aberdeen", name: "阿伯丁", leagueId: "scottish-pred", domRep: 1, contRep: 1, intlRep: 1, rep: 4 },
  { id: "hearts", name: "哈茨", leagueId: "scottish-pred", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "hibernian", name: "希伯尼安", leagueId: "scottish-pred", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "ross-county", name: "罗斯郡", leagueId: "scottish-pred", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 希腊超 ──
  { id: "olympiacos", name: "奥林匹亚科斯", leagueId: "greek-super", domRep: 3, contRep: 2, intlRep: 3, rep: 6, rivalId: "panathinaikos" },
  { id: "panathinaikos", name: "帕纳辛纳科斯", leagueId: "greek-super", domRep: 2, contRep: 2, intlRep: 2, rep: 5, rivalId: "olympiacos" },
  { id: "paok", name: "帕奥克", leagueId: "greek-super", domRep: 2, contRep: 1, intlRep: 2, rep: 5 },
  { id: "aek-athens", name: "AEK雅典", leagueId: "greek-super", domRep: 2, contRep: 1, intlRep: 2, rep: 5 },
  { id: "aris", name: "阿里斯", leagueId: "greek-super", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "of-iannina", name: "约阿尼纳", leagueId: "greek-super", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 美职联 ──
  { id: "la-galaxy", name: "洛杉矶银河", leagueId: "mls", domRep: 2, contRep: 0, intlRep: 2, rep: 4, rivalId: "lafc" },
  { id: "inter-miami", name: "迈阿密国际", leagueId: "mls", domRep: 2, contRep: 0, intlRep: 3, rep: 4 },
  { id: "ny-red-bulls", name: "纽约红牛", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 3, rivalId: "nycfc" },
  { id: "seattle-sounders", name: "西雅图海湾人", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "atlanta-united", name: "亚特兰大联", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "charlotte-fc", name: "夏洛特FC", leagueId: "mls", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 墨甲 ──
  { id: "club-america", name: "美洲队", leagueId: "liga-mx", domRep: 3, contRep: 2, intlRep: 3, rep: 5, rivalId: "chivas" },
  { id: "chivas", name: "瓜达拉哈拉", leagueId: "liga-mx", domRep: 3, contRep: 1, intlRep: 3, rep: 5, rivalId: "club-america" },
  { id: "monterrey", name: "蒙特雷", leagueId: "liga-mx", domRep: 3, contRep: 2, intlRep: 2, rep: 5 },
  { id: "tigres", name: "老虎大学", leagueId: "liga-mx", domRep: 3, contRep: 2, intlRep: 2, rep: 5 },
  { id: "pumas", name: "美洲狮", leagueId: "liga-mx", domRep: 1, contRep: 1, intlRep: 1, rep: 3 },
  { id: "atlas", name: "阿特拉斯", leagueId: "liga-mx", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 埃及超 ──
  { id: "al-ahly", name: "阿尔阿赫利", leagueId: "egyptian-pred", domRep: 3, contRep: 2, intlRep: 3, rep: 5, rivalId: "zamalek" },
  { id: "zamalek", name: "扎马雷克", leagueId: "egyptian-pred", domRep: 2, contRep: 1, intlRep: 2, rep: 4, rivalId: "al-ahly" },
  { id: "pyramids-fc", name: "金字塔", leagueId: "egyptian-pred", domRep: 2, contRep: 1, intlRep: 1, rep: 4 },
  { id: "masry", name: "马斯里", leagueId: "egyptian-pred", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "ismaily", name: "伊斯梅利", leagueId: "egyptian-pred", domRep: 1, contRep: 0, intlRep: 0, rep: 3 },
  { id: "ghazl-shehata", name: "加兹勒", leagueId: "egyptian-pred", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 瑞士超 ──
  { id: "young-boys", name: "年轻人", leagueId: "swiss-super", domRep: 3, contRep: 2, intlRep: 2, rep: 5 },
  { id: "basel", name: "巴塞尔", leagueId: "swiss-super", domRep: 3, contRep: 3, intlRep: 3, rep: 5, rivalId: "young-boys" },
  { id: "zurich", name: "苏黎世", leagueId: "swiss-super", domRep: 2, contRep: 1, intlRep: 2, rep: 4, rivalId: "grasshopper" },
  { id: "st-gallen", name: "圣加仑", leagueId: "swiss-super", domRep: 1, contRep: 1, intlRep: 1, rep: 3 },
  { id: "luzern", name: "卢塞恩", leagueId: "swiss-super", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "servette", name: "塞尔维特", leagueId: "swiss-super", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "lausanne", name: "洛桑", leagueId: "swiss-super", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 奥甲 ──
  { id: "salzburg", name: "萨尔茨堡", leagueId: "austrian-bund", domRep: 4, contRep: 3, intlRep: 3, rep: 6 },
  { id: "sturm-graz", name: "格拉茨风暴", leagueId: "austrian-bund", domRep: 3, contRep: 2, intlRep: 2, rep: 5, rivalId: "salzburg" },
  { id: "rapid-vienna", name: "维也纳快速", leagueId: "austrian-bund", domRep: 2, contRep: 1, intlRep: 2, rep: 4 },
  { id: "austria-vienna", name: "奥地利维也纳", leagueId: "austrian-bund", domRep: 2, contRep: 1, intlRep: 2, rep: 4 },
  { id: "lask", name: "林茨", leagueId: "austrian-bund", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "wac", name: "沃尔夫斯贝格", leagueId: "austrian-bund", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 捷克甲 ──
  { id: "slavia-prague", name: "布拉格斯拉维亚", leagueId: "czech-liga", domRep: 3, contRep: 2, intlRep: 2, rep: 5, rivalId: "sparta-prague" },
  { id: "sparta-prague", name: "布拉格斯巴达", leagueId: "czech-liga", domRep: 3, contRep: 2, intlRep: 2, rep: 5, rivalId: "slavia-prague" },
  { id: "viktoria-plzen", name: "比尔森胜利", leagueId: "czech-liga", domRep: 2, contRep: 2, intlRep: 2, rep: 4 },
  { id: "banik-ostrava", name: "俄斯特拉发", leagueId: "czech-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "jablonec", name: "亚布洛内茨", leagueId: "czech-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "bohemians", name: "波希米亚人", leagueId: "czech-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 波兰甲 ──
  { id: "legia-warsaw", name: "华沙莱吉亚", leagueId: "polish-ekstraklasa", domRep: 3, contRep: 2, intlRep: 2, rep: 5 },
  { id: "lech-poznan", name: "波兹南莱赫", leagueId: "polish-ekstraklasa", domRep: 3, contRep: 2, intlRep: 2, rep: 5, rivalId: "pogon-szczecin" },
  { id: "rakow", name: "拉库夫", leagueId: "polish-ekstraklasa", domRep: 2, contRep: 1, intlRep: 2, rep: 4 },
  { id: "pogon-szczecin", name: "什切青波贡", leagueId: "polish-ekstraklasa", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "wisla-krakow", name: "克拉科维斯瓦", leagueId: "polish-ekstraklasa", domRep: 1, contRep: 0, intlRep: 1, rep: 3, rivalId: "cracovia" },
  { id: "gornik-zabrze", name: "扎布热矿工", leagueId: "polish-ekstraklasa", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 乌超 ──
  { id: "shakhtar", name: "顿涅茨克矿工", leagueId: "ukrainian-premier", domRep: 4, contRep: 3, intlRep: 3, rep: 6, rivalId: "dynamo-kyiv" },
  { id: "dynamo-kyiv", name: "基辅迪纳摩", leagueId: "ukrainian-premier", domRep: 4, contRep: 3, intlRep: 3, rep: 6, rivalId: "shakhtar" },
  { id: "zorya", name: "卢甘斯克索黎亚", leagueId: "ukrainian-premier", domRep: 2, contRep: 1, intlRep: 1, rep: 4 },
  { id: "kolos", name: "科洛斯", leagueId: "ukrainian-premier", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "vorskla", name: "沃斯卡拉", leagueId: "ukrainian-premier", domRep: 1, contRep: 0, intlRep: 0, rep: 3 },
  { id: "minai", name: "米奈", leagueId: "ukrainian-premier", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ═══ 联赛扩编 (2025-26 真实阵容): 上列各联赛补齐至真实球队数 ═══
  // ── 英冠 (24) ──
  { id: "sheffield-united", name: "谢菲尔德联", leagueId: "championship", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "derby-county", name: "德比郡", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "birmingham", name: "伯明翰", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "portsmouth", name: "朴茨茅斯", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "bristol-city", name: "布里斯托尔城", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "wrexham", name: "雷克斯汉姆", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "charlton", name: "查尔顿", leagueId: "championship", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "bolton", name: "博尔顿", leagueId: "championship", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 西乙 (22) ──
  { id: "malaga", name: "马拉加", leagueId: "laliga-2", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "leganes", name: "莱加内斯", leagueId: "laliga-2", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "burgos", name: "布尔戈斯", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "albacete", name: "阿尔瓦塞特", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "castellon", name: "卡斯特利翁", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "cordoba", name: "科尔多瓦", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "andorra", name: "安道尔", leagueId: "laliga-2", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "ceuta", name: "休达", leagueId: "laliga-2", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "tenerife", name: "特内里费", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "eldense", name: "埃尔登塞", leagueId: "laliga-2", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 德甲 (18) ──
  { id: "leverkusen", name: "勒沃库森", leagueId: "bundesliga", domRep: 3, contRep: 3, intlRep: 4, rep: 7 },
  { id: "mainz", name: "美因茨", leagueId: "bundesliga", domRep: 1, contRep: 1, intlRep: 2, rep: 4 },
  // ── 葡超 (18) ──
  { id: "vitoria-guimaraes", name: "吉马良斯", leagueId: "primeira-liga", domRep: 2, contRep: 1, intlRep: 2, rep: 5 },
  { id: "famalicao", name: "法马利康", leagueId: "primeira-liga", domRep: 1, contRep: 1, intlRep: 1, rep: 4 },
  { id: "santa-clara", name: "圣克拉拉", leagueId: "primeira-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "moreirense", name: "莫雷伦斯", leagueId: "primeira-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "gil-vicente", name: "吉尔维森特", leagueId: "primeira-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "arouca", name: "阿罗卡", leagueId: "primeira-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "estoril", name: "埃斯托里尔", leagueId: "primeira-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "rio-ave", name: "里奥阿维", leagueId: "primeira-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "casa-pia", name: "卡萨皮亚", leagueId: "primeira-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "estrela-amadora", name: "阿马多拉之星", leagueId: "primeira-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "nacional", name: "纳西奥纳尔", leagueId: "primeira-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "maritimo", name: "马里迪莫", leagueId: "primeira-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "alverca", name: "阿尔韦卡", leagueId: "primeira-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "academico-viseu", name: "维塞乌学院", leagueId: "primeira-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 荷甲 (18) ──
  { id: "go-ahead-eagles", name: "前进之鹰", leagueId: "eredivisie", domRep: 1, contRep: 1, intlRep: 1, rep: 4 },
  { id: "nec-nijmegen", name: "奈梅亨", leagueId: "eredivisie", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "groningen", name: "格罗宁根", leagueId: "eredivisie", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "sparta-rotterdam", name: "鹿特丹斯巴达", leagueId: "eredivisie", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "fortuna-sittard", name: "锡塔德财富", leagueId: "eredivisie", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "zwolle", name: "兹沃勒", leagueId: "eredivisie", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "excelsior", name: "精英鹿特丹", leagueId: "eredivisie", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "willem-ii", name: "威廉二世", leagueId: "eredivisie", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "den-haag", name: "海牙", leagueId: "eredivisie", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "telstar", name: "泰尔斯达", leagueId: "eredivisie", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 土超 (18) ──
  { id: "samsunspor", name: "萨姆松体育", leagueId: "super-lig", domRep: 2, contRep: 1, intlRep: 2, rep: 5 },
  { id: "goztepe", name: "哥兹塔比", leagueId: "super-lig", domRep: 1, contRep: 1, intlRep: 1, rep: 4 },
  { id: "konyaspor", name: "科尼亚体育", leagueId: "super-lig", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "alanyaspor", name: "阿兰亚体育", leagueId: "super-lig", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "rizespor", name: "里泽体育", leagueId: "super-lig", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "kasimpasa", name: "卡瑟姆帕萨", leagueId: "super-lig", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "gaziantep", name: "加济安泰普", leagueId: "super-lig", domRep: 0, contRep: 0, intlRep: 0, rep: 3 },
  { id: "eyupspor", name: "埃于普体育", leagueId: "super-lig", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "kocaelispor", name: "科贾埃利体育", leagueId: "super-lig", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "genclerbirligi", name: "根杰勒比利吉", leagueId: "super-lig", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "corum-fk", name: "乔鲁姆", leagueId: "super-lig", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "amedspor", name: "阿马德体育", leagueId: "super-lig", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  // ── 苏超 (12) ──
  { id: "dundee-united", name: "邓迪联", leagueId: "scottish-pred", domRep: 1, contRep: 0, intlRep: 1, rep: 3, rivalId: "dundee" },
  { id: "motherwell", name: "马瑟韦尔", leagueId: "scottish-pred", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "st-mirren", name: "圣米伦", leagueId: "scottish-pred", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "kilmarnock", name: "基尔马诺克", leagueId: "scottish-pred", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "dundee", name: "邓迪", leagueId: "scottish-pred", domRep: 0, contRep: 0, intlRep: 0, rep: 2, rivalId: "dundee-united" },
  { id: "falkirk", name: "法尔柯克", leagueId: "scottish-pred", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 波兰甲 (18) ──
  { id: "jagiellonia", name: "亚盖隆尼亚", leagueId: "polish-ekstraklasa", domRep: 3, contRep: 2, intlRep: 2, rep: 5 },
  { id: "zaglebie-lubin", name: "卢宾扎格温比", leagueId: "polish-ekstraklasa", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "slask-wroclaw", name: "弗罗茨瓦夫", leagueId: "polish-ekstraklasa", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "widzew-lodz", name: "罗兹维泽夫", leagueId: "polish-ekstraklasa", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "piast-gliwice", name: "格利维采皮亚斯特", leagueId: "polish-ekstraklasa", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "cracovia", name: "克拉科维亚", leagueId: "polish-ekstraklasa", domRep: 1, contRep: 0, intlRep: 1, rep: 3, rivalId: "wisla-krakow" },
  { id: "motor-lublin", name: "卢布林摩托", leagueId: "polish-ekstraklasa", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "radomiak", name: "拉多米亚克", leagueId: "polish-ekstraklasa", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "korona-kielce", name: "凯尔采科罗纳", leagueId: "polish-ekstraklasa", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "gks-katowice", name: "卡托维兹", leagueId: "polish-ekstraklasa", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "wisla-plock", name: "普沃茨克维斯瓦", leagueId: "polish-ekstraklasa", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "wieczysta-krakow", name: "维奇斯塔", leagueId: "polish-ekstraklasa", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 美职联 (30) ──
  { id: "lafc", name: "洛杉矶FC", leagueId: "mls", domRep: 2, contRep: 1, intlRep: 2, rep: 4, rivalId: "la-galaxy" },
  { id: "columbus-crew", name: "哥伦布机员", leagueId: "mls", domRep: 2, contRep: 1, intlRep: 2, rep: 4 },
  { id: "fc-cincinnati", name: "辛辛那提", leagueId: "mls", domRep: 2, contRep: 1, intlRep: 2, rep: 4 },
  { id: "nycfc", name: "纽约城", leagueId: "mls", domRep: 2, contRep: 1, intlRep: 2, rep: 3, rivalId: "ny-red-bulls" },
  { id: "philadelphia-union", name: "费城联合", leagueId: "mls", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "orlando-city", name: "奥兰多城", leagueId: "mls", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "portland-timbers", name: "波特兰伐木者", leagueId: "mls", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "minnesota-united", name: "明尼苏达联", leagueId: "mls", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "vancouver-whitecaps", name: "温哥华白帽", leagueId: "mls", domRep: 2, contRep: 1, intlRep: 1, rep: 3 },
  { id: "san-diego-fc", name: "圣迭戈FC", leagueId: "mls", domRep: 2, contRep: 0, intlRep: 1, rep: 3 },
  { id: "nashville-sc", name: "纳什维尔", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "austin-fc", name: "奥斯汀", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "real-salt-lake", name: "盐湖城", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "fc-dallas", name: "达拉斯", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "sporting-kc", name: "堪萨斯城竞技", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "houston-dynamo", name: "休斯敦迪纳摩", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "colorado-rapids", name: "科罗拉多急流", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "chicago-fire", name: "芝加哥火焰", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "new-england", name: "新英格兰革命", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "dc-united", name: "华盛顿联", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "toronto-fc", name: "多伦多FC", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 2 },
  { id: "cf-montreal", name: "蒙特利尔", leagueId: "mls", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "san-jose", name: "圣何塞地震", leagueId: "mls", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "st-louis-city", name: "圣路易斯城", leagueId: "mls", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 墨甲 (18) ──
  { id: "cruz-azul", name: "蓝十字", leagueId: "liga-mx", domRep: 3, contRep: 2, intlRep: 3, rep: 5, rivalId: "club-america" },
  { id: "toluca", name: "托卢卡", leagueId: "liga-mx", domRep: 3, contRep: 2, intlRep: 2, rep: 5 },
  { id: "pachuca", name: "帕丘卡", leagueId: "liga-mx", domRep: 2, contRep: 2, intlRep: 2, rep: 4 },
  { id: "club-leon", name: "莱昂", leagueId: "liga-mx", domRep: 2, contRep: 2, intlRep: 2, rep: 4 },
  { id: "santos-laguna", name: "拉古纳桑托斯", leagueId: "liga-mx", domRep: 2, contRep: 1, intlRep: 1, rep: 4 },
  { id: "tijuana", name: "蒂华纳", leagueId: "liga-mx", domRep: 1, contRep: 1, intlRep: 1, rep: 3 },
  { id: "necaxa", name: "内卡萨", leagueId: "liga-mx", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "atletico-san-luis", name: "圣路易斯竞技", leagueId: "liga-mx", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "fc-juarez", name: "华雷斯", leagueId: "liga-mx", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "queretaro", name: "克雷塔罗", leagueId: "liga-mx", domRep: 0, contRep: 0, intlRep: 1, rep: 2 },
  { id: "puebla", name: "普埃布拉", leagueId: "liga-mx", domRep: 0, contRep: 0, intlRep: 1, rep: 2 },
  { id: "atlante", name: "阿特兰特", leagueId: "liga-mx", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 沙特联 (18) ──
  { id: "al-qadsiah", name: "卡迪西亚", leagueId: "saudi-pro-league", domRep: 2, contRep: 1, intlRep: 2, rep: 5 },
  { id: "al-shabab", name: "利雅得青年人", leagueId: "saudi-pro-league", domRep: 2, contRep: 1, intlRep: 2, rep: 5 },
  { id: "neom", name: "NEOM", leagueId: "saudi-pro-league", domRep: 1, contRep: 1, intlRep: 2, rep: 4 },
  { id: "al-ettifaq", name: "团结", leagueId: "saudi-pro-league", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "al-taawoun", name: "合作", leagueId: "saudi-pro-league", domRep: 1, contRep: 1, intlRep: 1, rep: 4 },
  { id: "al-fateh", name: "法塔赫", leagueId: "saudi-pro-league", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "al-khaleej", name: "海湾", leagueId: "saudi-pro-league", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "al-fayha", name: "法伊哈", leagueId: "saudi-pro-league", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "al-riyadh", name: "利雅得", leagueId: "saudi-pro-league", domRep: 0, contRep: 0, intlRep: 1, rep: 3 },
  { id: "al-kholood", name: "霍鲁德", leagueId: "saudi-pro-league", domRep: 0, contRep: 0, intlRep: 0, rep: 3 },
  { id: "al-hazem", name: "哈兹姆", leagueId: "saudi-pro-league", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "al-faisaly", name: "费萨利", leagueId: "saudi-pro-league", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "abha", name: "阿卜哈", leagueId: "saudi-pro-league", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "diriyah", name: "迪里耶", leagueId: "saudi-pro-league", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  // ── 阿甲 (30) ──
  { id: "rosario-central", name: "罗萨里奥中央", leagueId: "argentine-primera", domRep: 3, contRep: 2, intlRep: 2, rep: 5, rivalId: "newells-old-boys" },
  { id: "lanus", name: "拉努斯", leagueId: "argentine-primera", domRep: 2, contRep: 2, intlRep: 2, rep: 4, rivalId: "banfield" },
  { id: "huracan", name: "于拉坎", leagueId: "argentine-primera", domRep: 2, contRep: 1, intlRep: 1, rep: 4 },
  { id: "defensa-y-justicia", name: "正义防卫", leagueId: "argentine-primera", domRep: 2, contRep: 2, intlRep: 1, rep: 4 },
  { id: "belgrano", name: "贝尔格拉诺", leagueId: "argentine-primera", domRep: 2, contRep: 1, intlRep: 1, rep: 4 },
  { id: "godoy-cruz", name: "戈多伊克鲁斯", leagueId: "argentine-primera", domRep: 1, contRep: 1, intlRep: 1, rep: 3 },
  { id: "atletico-tucuman", name: "图库曼竞技", leagueId: "argentine-primera", domRep: 1, contRep: 1, intlRep: 1, rep: 3 },
  { id: "independiente-rivadavia", name: "里瓦达维亚独立", leagueId: "argentine-primera", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "platense", name: "普拉滕塞", leagueId: "argentine-primera", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "tigre", name: "老虎竞技", leagueId: "argentine-primera", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "union-santa-fe", name: "圣菲联合", leagueId: "argentine-primera", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "banfield", name: "班菲尔德", leagueId: "argentine-primera", domRep: 1, contRep: 0, intlRep: 1, rep: 3, rivalId: "lanus" },
  { id: "barracas-central", name: "巴拉卡斯中央", leagueId: "argentine-primera", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "central-cordoba", name: "中央科尔多瓦", leagueId: "argentine-primera", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "gimnasia-lp", name: "拉普拉塔体操", leagueId: "argentine-primera", domRep: 1, contRep: 0, intlRep: 1, rep: 3, rivalId: "estudiantes" },
  { id: "instituto", name: "科尔多瓦学院", leagueId: "argentine-primera", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "sarmiento", name: "萨米恩托", leagueId: "argentine-primera", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "aldosivi", name: "阿尔多西维", leagueId: "argentine-primera", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "deportivo-riestra", name: "列斯特拉", leagueId: "argentine-primera", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "san-martin-sj", name: "圣胡安圣马丁", leagueId: "argentine-primera", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  // ── 希腊超 (14) ──
  { id: "ofi-crete", name: "OFI克里特", leagueId: "greek-super", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "atromitos", name: "阿特罗米托斯", leagueId: "greek-super", domRep: 1, contRep: 0, intlRep: 1, rep: 4 },
  { id: "asteras-tripolis", name: "特里波利斯", leagueId: "greek-super", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "volos", name: "沃洛斯", leagueId: "greek-super", domRep: 0, contRep: 0, intlRep: 0, rep: 3 },
  { id: "panetolikos", name: "帕纳托利科斯", leagueId: "greek-super", domRep: 0, contRep: 0, intlRep: 0, rep: 3 },
  { id: "levadiakos", name: "莱瓦迪亚科斯", leagueId: "greek-super", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "kifisia", name: "基菲夏", leagueId: "greek-super", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "panserraikos", name: "潘塞拉科斯", leagueId: "greek-super", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 瑞士超 (12) ──
  { id: "lugano", name: "卢加诺", leagueId: "swiss-super", domRep: 2, contRep: 1, intlRep: 2, rep: 4 },
  { id: "sion", name: "锡永", leagueId: "swiss-super", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "grasshopper", name: "草蜢", leagueId: "swiss-super", domRep: 1, contRep: 0, intlRep: 1, rep: 3, rivalId: "zurich" },
  { id: "thun", name: "图恩", leagueId: "swiss-super", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "winterthur", name: "温特图尔", leagueId: "swiss-super", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 奥甲 (12) ──
  { id: "hartberg", name: "哈特贝格", leagueId: "austrian-bund", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "grazer-ak", name: "格拉茨竞技", leagueId: "austrian-bund", domRep: 1, contRep: 0, intlRep: 1, rep: 3, rivalId: "sturm-graz" },
  { id: "altach", name: "阿尔塔赫", leagueId: "austrian-bund", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "ried", name: "里德", leagueId: "austrian-bund", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "wsg-tirol", name: "蒂罗尔", leagueId: "austrian-bund", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "blau-weiss-linz", name: "蓝白林茨", leagueId: "austrian-bund", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 捷克甲 (16) ──
  { id: "sigma-olomouc", name: "奥洛穆茨", leagueId: "czech-liga", domRep: 1, contRep: 1, intlRep: 1, rep: 3 },
  { id: "slovacko", name: "斯洛瓦茨科", leagueId: "czech-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "mlada-boleslav", name: "姆拉达博莱斯拉夫", leagueId: "czech-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "slovan-liberec", name: "利贝雷茨", leagueId: "czech-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "hradec-kralove", name: "赫拉德茨", leagueId: "czech-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "teplice", name: "特普利采", leagueId: "czech-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "pardubice", name: "帕尔杜比采", leagueId: "czech-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "karvina", name: "卡尔维纳", leagueId: "czech-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "zlin", name: "兹林", leagueId: "czech-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "dukla-praha", name: "布拉格杜克拉", leagueId: "czech-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 乌超 (16) ──
  { id: "polissya", name: "日托米尔波利西亚", leagueId: "ukrainian-premier", domRep: 2, contRep: 1, intlRep: 1, rep: 4 },
  { id: "oleksandriya", name: "亚历山德里亚", leagueId: "ukrainian-premier", domRep: 2, contRep: 1, intlRep: 1, rep: 4 },
  { id: "kryvbas", name: "克里夫巴斯", leagueId: "ukrainian-premier", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "rukh-lviv", name: "利沃夫鲁赫", leagueId: "ukrainian-premier", domRep: 1, contRep: 0, intlRep: 1, rep: 3, rivalId: "karpaty-lviv" },
  { id: "karpaty-lviv", name: "利沃夫喀尔巴阡", leagueId: "ukrainian-premier", domRep: 1, contRep: 0, intlRep: 1, rep: 3, rivalId: "rukh-lviv" },
  { id: "lnz-cherkasy", name: "切尔卡瑟LNZ", leagueId: "ukrainian-premier", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "veres-rivne", name: "罗夫诺韦雷斯", leagueId: "ukrainian-premier", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "obolon-kyiv", name: "基辅奥博隆", leagueId: "ukrainian-premier", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "kudrivka", name: "库德里夫卡", leagueId: "ukrainian-premier", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "epicentr", name: "埃皮森特尔", leagueId: "ukrainian-premier", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 埃及超 (18) ──
  { id: "ceramica-cleopatra", name: "克娄巴特拉陶瓷", leagueId: "egyptian-pred", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "enppi", name: "国家石油", leagueId: "egyptian-pred", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "smouha", name: "斯莫哈", leagueId: "egyptian-pred", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "national-bank", name: "国民银行", leagueId: "egyptian-pred", domRep: 1, contRep: 0, intlRep: 0, rep: 2 },
  { id: "ittihad-alexandria", name: "亚历山大联合", leagueId: "egyptian-pred", domRep: 1, contRep: 0, intlRep: 0, rep: 2 },
  { id: "pharco", name: "法尔科", leagueId: "egyptian-pred", domRep: 1, contRep: 0, intlRep: 0, rep: 2 },
  { id: "zed-fc", name: "ZED", leagueId: "egyptian-pred", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "modern-sport", name: "现代体育", leagueId: "egyptian-pred", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "petrojet", name: "石油喷射", leagueId: "egyptian-pred", domRep: 0, contRep: 0, intlRep: 0, rep: 2 },
  { id: "el-gouna", name: "古纳", leagueId: "egyptian-pred", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "arab-contractors", name: "阿拉伯承包商", leagueId: "egyptian-pred", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 中甲 (16) ──
  { id: "jiangxi-lushan", name: "江西庐山", leagueId: "china-league-one", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "quanzhou-yaxin", name: "泉州亚新", leagueId: "china-league-one", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "shanghai-jiading", name: "上海嘉定汇龙", leagueId: "china-league-one", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "heilongjiang-ice-city", name: "黑龙江冰城", leagueId: "china-league-one", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 巴乙 (20) ──
  { id: "novorizontino", name: "新奥里藏蒂诺", leagueId: "brasileirao-b", domRep: 2, contRep: 1, intlRep: 1, rep: 3 },
  { id: "remo", name: "雷莫", leagueId: "brasileirao-b", domRep: 1, contRep: 1, intlRep: 1, rep: 3, rivalId: "paysandu" },
  { id: "vila-nova", name: "新城", leagueId: "brasileirao-b", domRep: 1, contRep: 0, intlRep: 0, rep: 2 },
  { id: "crb", name: "CRB", leagueId: "brasileirao-b", domRep: 1, contRep: 0, intlRep: 0, rep: 2 },
  { id: "operario-pr", name: "帕拉纳工人", leagueId: "brasileirao-b", domRep: 1, contRep: 0, intlRep: 0, rep: 2 },
  { id: "ferroviaria", name: "铁路", leagueId: "brasileirao-b", domRep: 1, contRep: 0, intlRep: 0, rep: 2 },
  { id: "botafogo-sp", name: "圣保罗博塔弗戈", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "amazonas", name: "亚马逊", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "volta-redonda", name: "红弯", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  { id: "athletic-club-mg", name: "竞技俱乐部", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
];

export function clubById(id: string): Club {
  const c = CLUBS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown club: ${id}`);
  return c;
}

/** All clubs in a league, strongest first. */
export function clubsByLeague(leagueId: string): readonly Club[] {
  return CLUBS.filter((c) => c.leagueId === leagueId).sort((a, b) => b.rep - a.rep);
}

/**
 * Pick the weakest club in a league to start a career at (the underdog start),
 * deterministically from the seed so a seed is reproducible. Falls back to the
 * single weakest if several share the lowest rep.
 */
export function weakestClubInLeague(leagueId: string, seed: string): Club {
  const clubs = clubsByLeague(leagueId);
  if (clubs.length === 0) throw new Error(`no clubs for league: ${leagueId}`);
  const minRep = clubs[clubs.length - 1]!.rep;
  const weakest = clubs.filter((c) => c.rep === minRep);
  if (weakest.length === 1) return weakest[0]!;
  const h = hashStr(`${seed}:start-club:${leagueId}`);
  return weakest[h % weakest.length]!;
}

/**
 * Pick a club one rep tier stronger than the given (weakest) club — the
 * 青训球探 (pp_scout) prestige perk start. Deterministic from the seed. Cap at
 * the second-weakest tier so the underdog arc is preserved (never starts at a
 * top club). Falls back to the given club if the league is too shallow.
 */
export function strongerClubInLeague(leagueId: string, than: Club, seed: string): Club {
  const clubs = clubsByLeague(leagueId);
  if (clubs.length <= 1) return than;
  // one rep tier stronger than the weakest, but never the very strongest club.
  const minRep = clubs[clubs.length - 1]!.rep;
  const targetRep = minRep + 1;
  const candidates = clubs.filter((c) => c.rep === targetRep);
  if (candidates.length === 0) return than;
  const h = hashStr(`${seed}:start-club-scout:${leagueId}`);
  return candidates[h % candidates.length]!;
}

// minimal non-RNG string hash for deterministic club picking (rng.ts hash is
// available but kept out to avoid a cross-module cycle here)
function hashStr(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0 || 1;
}

// ───────────────────────────── player name generation ─────────────────────────────
// Nationality-authentic name assembly lives in ./names (CJK / Hispanic / Lusophone /
// single-surname families + native-script pools). Re-exported here so callers keep
// importing from ./data. `player.name` is cosmetic — never feeds any derive stream,
// so changing the name generator never perturbs a career's outcomes. See names.ts.
export { generatePlayerName } from "./names";
export type { NameSpec, NameComponent, NamePool } from "./names";

/** Pick a position-appropriate squad number deterministically from the seed. */
export function generateSquadNumber(seed: string, position: Position): number {
  // GK: low numbers (1-12, often 1); defenders: 2-6; mids: 4-8/10; forwards: 7/9/10/11
  const rng = hashStr(`${seed}:squad-number:${position}`) / 4294967296;
  if (position === "GK") return 1 + Math.floor(rng * 12);
  if (["CB", "LB", "RB"].includes(position)) return 2 + Math.floor(rng * 5);
  if (["CDM", "CM", "LM", "RM"].includes(position)) return 4 + Math.floor(rng * 6);
  // CAM/LW/RW/ST — iconic forward numbers
  const fw = [7, 9, 10, 11, 17, 19, 21, 23, 27, 39];
  return fw[Math.floor(rng * fw.length)]!;
}

/** Reputation tier → squad base overall (what OVR a team of each tier "expects").
 *  10-tier (0..9) global scale: the old 6-tier scale compressed the world so a
 *  中超 top club sat one tier below 皇马 and a 国安 sub could land a 西乙
 *  offer. Spreading to 0..9 pulls the hierarchy apart — rep9 = global elite
 *  (base 88, same as the old ceiling), rep0 = amateur minnow (base 52). */
export const SQUAD_BASE = [52, 58, 63, 68, 72, 76, 79, 82, 85, 88];

// ───────────────────────────── national teams ─────────────────────────────

export interface Nation {
  id: string;
  name: string;
  confederation: Confederation;
  contRep: number;     // drives continental-cup + WC qualification odds
  fifaRep: number;     // drives World Cup win odds
  intlRep: number;     // drives call-up threshold + squad base
  /** 青训档位 1(足球王国)..5(足球荒漠) — 出身国的青训体系质量,终身烙印。
   *  只弯曲概率(成长摩擦/天才档权重/豪门报价可见性),绝不设硬上限——弱国
   *  神种子照样能上 95+。分档依据 research/nationality-development-research.md:
   *  CIES MR99 人均五大联赛产出(B5/百万人) × FM Youth Rating 交叉校准,现实
   *  50~7000 倍差距按 FM/EA 先例对数压缩。传承乘数反向补偿(T5 ×1.8)。 */
  youthTier: 1 | 2 | 3 | 4 | 5;
}

export const NATIONS: readonly Nation[] = [
  { id: "esp", name: "西班牙", confederation: "UEFA", contRep: 6, fifaRep: 5, intlRep: 5, youthTier: 1 },
  { id: "fra", name: "法国", confederation: "UEFA", contRep: 6, fifaRep: 5, intlRep: 5, youthTier: 1 },
  { id: "ger", name: "德国", confederation: "UEFA", contRep: 5, fifaRep: 5, intlRep: 5, youthTier: 1 },
  { id: "eng", name: "英格兰", confederation: "UEFA", contRep: 5, fifaRep: 4, intlRep: 5, youthTier: 1 },
  { id: "ita", name: "意大利", confederation: "UEFA", contRep: 5, fifaRep: 4, intlRep: 4, youthTier: 1 },
  { id: "por", name: "葡萄牙", confederation: "UEFA", contRep: 5, fifaRep: 3, intlRep: 4, youthTier: 1 },
  { id: "ned", name: "荷兰", confederation: "UEFA", contRep: 5, fifaRep: 3, intlRep: 4, youthTier: 1 },
  { id: "bel", name: "比利时", confederation: "UEFA", contRep: 4, fifaRep: 2, intlRep: 4, youthTier: 2 },
  { id: "cro", name: "克罗地亚", confederation: "UEFA", contRep: 4, fifaRep: 3, intlRep: 3, youthTier: 2 },
  { id: "den", name: "丹麦", confederation: "UEFA", contRep: 4, fifaRep: 2, intlRep: 3, youthTier: 2 },
  { id: "sui", name: "瑞士", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 3, youthTier: 2 },
  { id: "aut", name: "奥地利", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 3, youthTier: 2 },
  { id: "pol", name: "波兰", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 3, youthTier: 2 },
  { id: "tur", name: "土耳其", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 3, youthTier: 2 },
  { id: "swe", name: "瑞典", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 2, youthTier: 2 },
  { id: "nor", name: "挪威", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 2, youthTier: 2 },
  { id: "srb", name: "塞尔维亚", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 3, youthTier: 2 },
  { id: "ukr", name: "乌克兰", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 3, youthTier: 2 },
  { id: "cze", name: "捷克", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 2, youthTier: 2 },
  { id: "gre", name: "希腊", confederation: "UEFA", contRep: 2, fifaRep: 1, intlRep: 2, youthTier: 3 },
  { id: "sco", name: "苏格兰", confederation: "UEFA", contRep: 2, fifaRep: 0, intlRep: 2, youthTier: 3 },
  { id: "irl", name: "爱尔兰", confederation: "UEFA", contRep: 2, fifaRep: 0, intlRep: 2, youthTier: 3 },
  { id: "arg", name: "阿根廷", confederation: "CONMEBOL", contRep: 6, fifaRep: 5, intlRep: 5, youthTier: 1 },
  { id: "bra", name: "巴西", confederation: "CONMEBOL", contRep: 6, fifaRep: 5, intlRep: 5, youthTier: 1 },
  { id: "uru", name: "乌拉圭", confederation: "CONMEBOL", contRep: 5, fifaRep: 3, intlRep: 4, youthTier: 2 },
  { id: "col", name: "哥伦比亚", confederation: "CONMEBOL", contRep: 4, fifaRep: 2, intlRep: 3, youthTier: 2 },
  { id: "chi", name: "智利", confederation: "CONMEBOL", contRep: 4, fifaRep: 1, intlRep: 3, youthTier: 3 },
  { id: "ecu", name: "厄瓜多尔", confederation: "CONMEBOL", contRep: 3, fifaRep: 1, intlRep: 2, youthTier: 3 },
  { id: "par", name: "巴拉圭", confederation: "CONMEBOL", contRep: 3, fifaRep: 1, intlRep: 2, youthTier: 3 },
  { id: "per", name: "秘鲁", confederation: "CONMEBOL", contRep: 3, fifaRep: 0, intlRep: 2, youthTier: 3 },
  { id: "ven", name: "委内瑞拉", confederation: "CONMEBOL", contRep: 2, fifaRep: 0, intlRep: 1, youthTier: 4 },
  { id: "bol", name: "玻利维亚", confederation: "CONMEBOL", contRep: 1, fifaRep: 0, intlRep: 1, youthTier: 4 },
  { id: "jpn", name: "日本", confederation: "AFC", contRep: 5, fifaRep: 1, intlRep: 3, youthTier: 4 },
  { id: "kor", name: "韩国", confederation: "AFC", contRep: 5, fifaRep: 1, intlRep: 3, youthTier: 4 },
  { id: "irn", name: "伊朗", confederation: "AFC", contRep: 4, fifaRep: 1, intlRep: 3, youthTier: 4 },
  { id: "aus", name: "澳大利亚", confederation: "AFC", contRep: 4, fifaRep: 0, intlRep: 2, youthTier: 4 },
  { id: "ksa", name: "沙特阿拉伯", confederation: "AFC", contRep: 3, fifaRep: 0, intlRep: 2, youthTier: 4 },
  { id: "qat", name: "卡塔尔", confederation: "AFC", contRep: 3, fifaRep: 0, intlRep: 1, youthTier: 5 },
  { id: "uzb", name: "乌兹别克斯坦", confederation: "AFC", contRep: 2, fifaRep: 0, intlRep: 1, youthTier: 4 },
  { id: "irq", name: "伊拉克", confederation: "AFC", contRep: 2, fifaRep: 0, intlRep: 1, youthTier: 5 },
  { id: "chn", name: "中国", confederation: "AFC", contRep: 1, fifaRep: 0, intlRep: 1, youthTier: 5 },
  { id: "tha", name: "泰国", confederation: "AFC", contRep: 1, fifaRep: 0, intlRep: 0, youthTier: 5 },
  { id: "vie", name: "越南", confederation: "AFC", contRep: 1, fifaRep: 0, intlRep: 0, youthTier: 5 },
  { id: "idn", name: "印度尼西亚", confederation: "AFC", contRep: 0, fifaRep: 0, intlRep: 0, youthTier: 5 },
  { id: "mar", name: "摩洛哥", confederation: "CAF", contRep: 5, fifaRep: 2, intlRep: 3, youthTier: 3 },
  { id: "sen", name: "塞内加尔", confederation: "CAF", contRep: 5, fifaRep: 1, intlRep: 3, youthTier: 3 },
  { id: "egy", name: "埃及", confederation: "CAF", contRep: 4, fifaRep: 1, intlRep: 2, youthTier: 3 },
  { id: "nga", name: "尼日利亚", confederation: "CAF", contRep: 4, fifaRep: 1, intlRep: 2, youthTier: 3 },
  { id: "civ", name: "科特迪瓦", confederation: "CAF", contRep: 4, fifaRep: 1, intlRep: 2, youthTier: 3 },
  { id: "cmr", name: "喀麦隆", confederation: "CAF", contRep: 3, fifaRep: 1, intlRep: 2, youthTier: 3 },
  { id: "gha", name: "加纳", confederation: "CAF", contRep: 3, fifaRep: 1, intlRep: 2, youthTier: 3 },
  { id: "alg", name: "阿尔及利亚", confederation: "CAF", contRep: 3, fifaRep: 1, intlRep: 2, youthTier: 3 },
  { id: "tun", name: "突尼斯", confederation: "CAF", contRep: 3, fifaRep: 0, intlRep: 2, youthTier: 3 },
  { id: "mex", name: "墨西哥", confederation: "CONCACAF", contRep: 5, fifaRep: 1, intlRep: 3, youthTier: 4 },
  { id: "usa", name: "美国", confederation: "CONCACAF", contRep: 4, fifaRep: 1, intlRep: 2, youthTier: 4 },
  { id: "can", name: "加拿大", confederation: "CONCACAF", contRep: 4, fifaRep: 0, intlRep: 2, youthTier: 4 },
  { id: "crc", name: "哥斯达黎加", confederation: "CONCACAF", contRep: 3, fifaRep: 0, intlRep: 1, youthTier: 5 },
  { id: "jam", name: "牙买加", confederation: "CONCACAF", contRep: 2, fifaRep: 0, intlRep: 1, youthTier: 5 },
  { id: "pan", name: "巴拿马", confederation: "CONCACAF", contRep: 2, fifaRep: 0, intlRep: 1, youthTier: 5 },
  { id: "nzl", name: "新西兰", confederation: "OFC", contRep: 6, fifaRep: 0, intlRep: 1, youthTier: 5 },
  { id: "fij", name: "斐济", confederation: "OFC", contRep: 2, fifaRep: 0, intlRep: 0, youthTier: 5 },
];

export function nationById(id: string): Nation {
  const n = NATIONS.find((x) => x.id === id);
  if (!n) throw new Error(`unknown nation: ${id}`);
  return n;
}

/** Youth tier of a nation (1..5); unknown ids fall back to 1 (no friction). */
export function youthTierOf(nationId: string): number {
  return NATIONS.find((x) => x.id === nationId)?.youthTier ?? 1;
}

/** The league a player from `nationId` would come up through — the academy
 *  league inferred from nationality. 青训抉择 uses this as the fallback home
 *  country when the player's nation has no represented domestic league.
 *  Matches a tier-1 league whose `country` code equals the nation id
 *  (esp→laliga, chn→csl, eng→premier-league…). Many nations have no domestic
 *  top flight in the data (Belgium, Croatia, Sweden, Uruguay, most of Africa,
 *  OFC…); for those, fall back to a confederation-appropriate development hub
 *  — the regional football power a kid from that nation would realistically
 *  enter (a Belgian/Dane → 荷甲's famous academies; a Uruguayan/Colombian → 阿甲;
 *  a Central American → 墨甲; an AFC minnow → 日职联; an African → 埃及超).
 *  Pure & deterministic so the academy offers reproduce from seed + league. */
const CONFED_FALLBACK_LEAGUE: Record<Confederation, string> = {
  UEFA: "eredivisie",
  CONMEBOL: "argentine-primera",
  CONCACAF: "liga-mx",
  AFC: "j1-league",
  CAF: "egyptian-pred",
  OFC: "j1-league", // no OFC league in the data — nearest major pro league
};
export function homeLeagueOf(nationId: string): League {
  const nation = nationById(nationId);
  const home = LEAGUES.find((l) => l.tier === 1 && l.country.toLowerCase() === nationId);
  if (home) return home;
  return leagueById(CONFED_FALLBACK_LEAGUE[nation.confederation] ?? "eredivisie");
}

// ───────────────── 国籍青训档位表 (P-NATION) ─────────────────
// 全部按 youthTier 1..5 索引 (index 0 未用)。量级依据
// research/nationality-development-research.md §6.2:现实「进五大联赛」人均差距
// 50~7000 倍,FM/EA 均压缩到 3~15 倍;难度主体放在路径摩擦(报价可见性),
// 天赋摩擦只做轻微概率调制——概率弯曲,永不设硬墙。

/** 成长摩擦概率:成长 roll 触发 min-of-two 的概率(仅正成长区间,宽区间集中在
 *  青年段 → 天然青年最重、终身不清零;衰退区间从不受罚)。 */
export const YOUTH_FRICTION_PROB = [0, 0, 0.12, 0.25, 0.35, 0.5] as const;
/** 天才档 (wonderkid) 抽取窗口宽度权重——缩窗不封死:T5 照样能出天才,只是
 *  「十年一遇」。 */
export const WONDERKID_WEIGHT = [0, 1, 0.9, 0.75, 0.6, 0.5] as const;
/** 传承补偿乘数:弱国出身 = 高风险高回报 (对数压缩自现实难度比)。
 *  P-GATE 重校准: 旧值 [1, 1.1, 1.2, 1.35, 1.5] 是针对「弱强国球员刷便宜洲际杯」
 *  的旧基线校准的 (tools/nation-tier-probe: T5 raw ≈ T1 的 ~68%, ×1.5 拉平)。
 *  CALLUP_THRESHOLD 改为按国家分档后,强国入选门槛抬高 (巴西 70→80) → 强国
 *  传承正确下降 (修掉了弱法国球员刷欧洲杯的 bug),奖杯差距收窄 → T5 需要的
 *  补偿变小。下调到 [1, 1.04, 1.08, 1.13, 1.18] 后 T5 raw ≈ T1 (easy-league
 *  起步的高峰抵消了发展摩擦),×1.18 仍补偿 iso 组的发展劣势 (T5_iso ≈ 0.9×T1),
 *  且 realistic 组 T5 ≤ 1.15×T1 (不越过 T1,防「刷分永选中国」)。 */
export const NATION_LEGACY_MULT = [0, 1, 1.04, 1.08, 1.13, 1.18] as const;
/** 路径摩擦:T4/T5 出身且尚无欧洲履历时,单个转会窗「五大联赛俱乐部不可见」
 *  的基础概率(%),按 OVR>80 每点 −5 递减——天才可跳级,是概率不是墙。
 *  复现真实路径 J联赛→比利时/荷兰跳板→五大 (CIES MR95/MR79, Hudl)。 */
export const SPRINGBOARD_BLOCK_PCT = [0, 0, 0, 0, 55, 75] as const;

// call-up OVR threshold by national team international reputation (intlRep 0..5).
// PER-NATION LADDER (P-GATE): a top nation only caps genuine starters/stars; a
// minnow caps anyone who's a pro. The old FLAT 70 let a 71-OVR bench player into
// BRAZIL's squad — football-incoherent (Brazil's squad is 85+) — and, via the
// equally-flat climax gates, let a 74-OVR player reach a WC/continental FINAL.
// Now the ladder rises with nation strength so the national track is a function
// of player quality AND nation strength: Brazil (intlRep 5) first caps at ~82, a
// minnow (intlRep 0) at ~70. A weak player simply doesn't get called up to a
// strong nation → no national caps, no national tournament, no WC climax. The
// climax floors in run.ts (WC_FINAL_FLOOR / CONT_FINAL_FLOOR) sit ABOVE this
// ladder — the FINAL is for a star, not a squad call-up.
// national-track-youth-olympic: ladder RAISED across the board to land the
//   aggregate career call-up rate at ~50% (was ~74%: strong 56% / weak 93%).
//   The per-nation gradient (国家水平作衡量标准) is PRESERVED — strong nations
//   remain harder to crack than weak ones — but weak nations drop from ~90%
//   (gift) to ~70-75%, strong from 56% to ~52%. 'Not every career gets in' is
//   the goal; 'a 71 bench player into Brazil' (P-GATE) stays gated out. Weak
//   nations stay higher than strong ones (the preserved gradient — a minnow's
//   squad IS easier to crack), just no longer a gift. Numbers are smoke-calibrated
//   (tools/national-gate-probe.ts).
//   intlRep 0 (斐济/越南/印尼):          80  — a genuine pro makes it
//   intlRep 1 (中国/玻利维亚/巴拿马):    80
//   intlRep 2 (苏格兰/美国/加纳):        81
//   intlRep 3 (日本/韩国/墨西哥/摩洛哥): 81
//   intlRep 4 (葡萄牙/比利时/乌拉圭):    82
//   intlRep 5 (巴西/西班牙/法国/德国/英格兰/阿根廷): 83
export const CALLUP_THRESHOLD = [80, 80, 81, 81, 82, 83];

/** P-NAT 老将淡出: 年龄档 → 入选门槛加价 (33+/35+/37+)。国家队线原本只有升没有
 *  降——门槛纯看 OVR, 于是一个 36 岁的老将只要能力还在就永远在队里、永远挂着
 *  巅峰站位。真实的国家队恰恰是最先换血的地方: 主帅围绕下一届大赛重建, 老将
 *  先丢核心圈、再丢首发、最后落选。加价刻意温和(最高 +5): 真正历史级的球员
 *  (Modrić/C罗) 仍能踢到 37, 一般国脚在 34-36 之间自然告别。
 *  站位门槛用同一档 ×NAT_AGE_STANDING_STEP。 */
export const NAT_AGE_TAX = [0, 1, 3, 5];
/** 每个年龄档抬高「核心/主力」站位所需的 OVR。33 岁起当核心要 90+, 35 岁起 94+
 *  —— 老将留得下来, 但留下来的是国脚身份, 不是巅峰的核心位。 */
export const NAT_AGE_STANDING_STEP = 4;

/** Youth national-team call-up OVR threshold (national-track-youth-olympic),
 *  by national team intlRep 0..5 — the 国家水平作衡量标准 ladder lifted into the
 *  youth track. U17 (16-17岁) sits below U21 (18-20岁), both below the senior
 *  CALLUP_THRESHOLD — a youth cap is a lower bar than a senior cap. Designed
 *  for ~50% of careers to hit at least one youth call-up (smoke-calibrated):
 *  a 16-OVR-50 academy nobody clears NO bar (min U17 is 55) — 'not everyone
 *  gets in just by turning the age'. A wonderkid climbing fast clears U17 by
 *  17, U21 by 18-19, then the senior bar in his early 20s — the earned ladder.
 *  golden_boy bends probabilities via faster growth, never a hard bypass. */
export const YOUTH_CALLUP_U17 = [55, 57, 59, 62, 64, 66];
export const YOUTH_CALLUP_U21 = [63, 65, 67, 69, 70, 71];

/** Olympic gold probability (national-track-youth-olympic), by fifaRep 0..5
 *  (国奥 strength tracks the senior side). Exposure-tier — BELOW a WC-final-win
 *  but the Olympics is the 'first big tournament' for a player who hasn't
 *  reached the WC FINAL_FLOOR (82) yet, so its gate is the U21 youth bar (way
 *  more players qualify than the WC gate) and the win prob stays modest.
 *  Smoke-calibrated to ~15-25% of eligible careers taking gold (honour bloat
 *  is welcome per user — this adds to the cabinet, not the WC's scarcity). */
export const OLYMPIC_WIN_PROB = [0.08, 0.10, 0.13, 0.17, 0.22, 0.28];

/** 青训租借发展窗上限 (years of career age). A big club (rep≥5) will only loan
 *  a youngster out for DEVELOPMENT through this age; a bench academy player
 *  OLDER than this who still can't crack the lineup is permanently moved on
 *  (踢不出来 → forced 降档 transfer) instead of being loaned around again.
 *
 *  Realism: a real club gives up on a non-developing academy prospect by ~20-21
 *  and sells him down to a lower league to play — NOT by loaning him out
 *  repeatedly until 25 (the old `age <= 24` gate let the 踢不出来 forced exit
 *  drift to a median of ~26-32 for big-club academy washouts, detached from
 *  reality). Capping the development-loan window here lands the give-up at
 *  ~20-21: a player loaned at 18 returns at 20, and if he's still bench he's
 *  sold down rather than re-loaned into a 4-year loan-army loop.
 *
 *  Shared by run.ts (the forced-exit loan path) and events.ts (the post-loan
 *  re-loan option) so both gates escalate to a permanent move at the same age.
 *  The standalone routine loan offer (run.ts) keeps its own wider 18-24 window —
 *  that's for a bench player who ISN'T on the forced-exit track (1 below-standard
 *  season, not the washout), where a development loan at 22 is still authentic. */
export const YOUTH_LOAN_MAX_AGE = 19;

// ───────────────────────────── trophy probability tables ─────────────────────────────
// All indexed by CLUB reputation tier 0..9 (the league's own domRep/contRep stay
// 0..5 — they drive market value/wage/scoring, a separate axis). Trophy odds
// spread across 10 tiers so a rep9 giant (34% league) and a rep5 club (6%)
// no longer collapse onto the same handful of values.

/** League title probability (by club reputation). */
export const LEAGUE_PROB = [0, 0, 0.003, 0.01, 0.03, 0.06, 0.1, 0.16, 0.25, 0.34];
/** Domestic cup probability (by club reputation). */
export const CUP_PROB = [0.002, 0.005, 0.01, 0.03, 0.06, 0.09, 0.12, 0.15, 0.18, 0.2];
/** Continental primary (Champions League / Libertadores / …) probability, by
 *  club reputation 0..9. The hardest club trophy: the CL is dominated by a
 *  handful of elite clubs, so the curve is STEEP — a 3★ (rep5) club winning it
 *  is a once-a-generation miracle (0.4%/season), a lower-4★ club (rep6, e.g.
 *  斯图加特/拉齐奥) a genuine upset (~1%), and only 5★ contenders (rep8-9:
 *  国米/多特 → 拜仁/皇马/曼城) win with any regularity (7%/15%). This makes the
 *  Champions League EARNED — you transfer UP to a contender to lift it, the
 *  career-climb choice the sim is built around (one player can't carry a minnow
 *  to a CL title). rep<5 is 0 (those clubs chase the secondary continental
 *  trophy, not the primary); the gate `rep >= 5` in clubTrophyCandidates
 *  enforces it, the zeros document it. See research/trophy-curve-tuning.md.
 *  洲际主豁免于飞升 10 全面降级：clubTrophyCandidates 的 continental-primary 用
 *  真实 rep（primaryRep），不被 effClub.rep-1 降档——rep-5 在飞升10 仍踢欧冠。
 *  league/cup/洲际副/CWC 仍走 effClub（弱旅地狱压这些）。 */
export const CONT_PRIMARY_PROB = [0, 0, 0, 0, 0, 0.004, 0.01, 0.028, 0.07, 0.15];
/** Continental secondary probability (peaks at mid clubs — elites chase the primary). */
export const CONT_SECONDARY_PROB = [0, 0.005, 0.02, 0.05, 0.08, 0.09, 0.07, 0.04, 0.02, 0.01];
/** Club World Cup probability (only at eligible ages), per confederation, by club rep 0..9. */
export const CWC_PROB = {
  UEFA:      [0, 0, 0, 0.001, 0.005, 0.02, 0.05, 0.08, 0.12, 0.15],
  CONMEBOL:  [0, 0, 0, 0, 0.001, 0.002, 0.005, 0.008, 0.01, 0.012],
  CONCACAF:  [0, 0, 0, 0, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001],
  AFC:       [0, 0, 0, 0, 0.0005, 0.001, 0.003, 0.005, 0.007, 0.008],
  CAF:       [0, 0, 0, 0, 0.0005, 0.001, 0.002, 0.003, 0.004, 0.005],
  OFC:       [0, 0, 0, 0, 0.0001, 0.0001, 0.0001, 0.0001, 0.0002, 0.0002],
} as const;

// national-team tables
// P-META: 压基线 — the meta-progression audit (research/meta-progression-analysis.md)
// measured a fresh account's FIRST career winning the World Cup 67.7% of the
// time and Euros/Copa ~80%: the game's ultimate glory was near-automatic, so
// no cross-run progression could exist. The passive per-tournament win rates
// below are cut to "miracle" levels — the world_cup_showdown boss (once per
// career, run.ts) is the intended main path to a WC title, and even that is
// rare. Target: ~10% of elite-nation careers ever lift the WC.
/** National continental cup (Euros/Copa) win probability by continental reputation tier 0..6. */
export const NAT_CONT_PROB = [1e-5, 0.01, 0.02, 0.04, 0.08, 0.12, 0.4];
/** World Cup win probability by fifa reputation tier 0..5. */
export const WC_WIN_PROB = [0.001, 0.002, 0.004, 0.008, 0.012, 0.02];
/** World Cup qualification probability by continental reputation tier. */
export const WC_QUAL_PROB = [0.03, 0.25, 0.6, 0.85, 1, 1, 1];
/** WC qualification carry tiers: each OVR threshold passed adds +1 tier index. */
export const WC_CARRY_THRESHOLDS = [82, 88] as const;

// ───────────────────────────── season stat tables ─────────────────────────────
// goals/assists per appearance, indexed by [roleGroup][strengthLevel 0..6]
// level 0 = star on a weak team (dominates), 6 = weakling on a strong team.

export const GOALS_PER_APP: Record<RoleGroup, readonly number[]> = {
  attacker:    [0.75, 0.58, 0.45, 0.34, 0.2, 0.1, 0.04],
  creator:     [0.55, 0.4, 0.3, 0.2, 0.13, 0.07, 0.03],
  support:     [0.1, 0.07, 0.05, 0.03, 0.015, 0, 0],
  defensive:   [0.07, 0.05, 0.04, 0.03, 0.01, 0, 0],
  goalkeeper:  [0, 0, 0, 0, 0, 0, 0],
};

export const ASSISTS_PER_APP: Record<RoleGroup, readonly number[]> = {
  attacker:    [0.3, 0.22, 0.15, 0.11, 0.08, 0.06, 0.04],
  creator:     [0.45, 0.34, 0.26, 0.19, 0.11, 0.06, 0.04],
  support:     [0.26, 0.19, 0.14, 0.09, 0.05, 0.02, 0.015],
  defensive:   [0.07, 0.05, 0.04, 0.02, 0.01, 0, 0],
  goalkeeper:  [0, 0, 0, 0, 0, 0, 0],
};

/** League scoring multiplier by domestic reputation (stronger league = more goals). */
export const LEAGUE_SCORE_MULT = [0.55, 0.75, 0.95, 1, 1.1, 1.2];
/** Goals-conceded multiplier by club reputation (stronger team concedes less). */
export const CONCEDE_MULT = [1.5, 1.4, 1.3, 1.1, 0.95, 0.85, 0.75, 0.65, 0.55, 0.5];

// ───────────────────────────── development profiles ─────────────────────────────
// Annual OVR delta range [min,max] by profile + target age (even ages 18..44).
// Goalkeepers use a single table regardless of profile.

export type DevProfile = "early" | "normal" | "late" | "wonderkid";

export const DEV_TABLES: Record<DevProfile, Record<number, readonly [number, number]>> = {
  // 巅峰延迟重调（peak-age 探针 + difficulty-smoke 指南针驱动）：旧表青年档
  // 上下限过高、24-26 档就转平甚至转负（normal 24:[-1,4]/26:[-1,2]/28:[-1,1]），
  // 中位巅峰年龄落在 24-26、37% 在 ≤26 开始走下坡——而真实足球 outfield
  // 巅峰 ~28-29、门将 ~30。现把曲线整体右移 ~2-4 年：青年档下调（减快速
  // 冲顶）、24-28 档地板归零（巅峰前不再掉总评）、衰退档后移 2 年。
  // 关键：巅峰延后会拉高峰值（更长爬梯窗 + 主力训练 bonus 落到 24-28 正增
  // 长档），故青年档同步下调 ~1.5 以把累计成长压回原位——峰值高度不变
  // （中位 ~85、≥90 ~37% 的既有水平，不恶化 difficulty-smoke），只是到达更晚。
  //   early   巅峰 ~26-27（早熟早衰，18% 玩家）
  //   normal  巅峰 ~28-29（默认，49% 玩家）
  //   late    巅峰 ~30-31（大器晚成，33% 玩家）
  //   wonderkid 巅峰 ~28-29，高方差（+10 爆发季 / 0 伤仲永季保留）
  // 衰退期 32+ 整体后移并略放缓；44+ fallback 不动。有祝福（金童+15 起跑 +
  // wonderkid + 精英天花板）仍上探 95+，只是到达年龄从 24 推到 28-29。
  early: {
    18: [3, 6], 20: [2, 6], 22: [1, 5], 24: [1, 4], 26: [0, 3],
    28: [-1, 1], 30: [-2, -1], 32: [-4, -1], 34: [-5, -1], 36: [-6, -1],
    38: [-7, -2], 40: [-9, -3], 42: [-11, -4], 44: [-13, -5],
  },
  normal: {
    // BAL-GROWTH: normal 档不动——它是 49% 玩家的「地板保护」。试过下调青年档
    //   上限, 结果把 smart 玩家的 p10 从 74 压到 67、<70 占比 4%→14%（不压抑积极性
    //   的护栏破）。95 聚集由 wonderkid 尖峰 + rep9 天花板 + pp_prodigy 起跑通胀 +
    //   comeback 堆顶驱动, 非本档——那些已各自削减, 本档保留原值守住地板。
    18: [3, 5], 20: [2, 5], 22: [1, 4], 24: [0, 3], 26: [0, 1],
    28: [0, 2], 30: [-1, 1], 32: [-2, 0], 34: [-4, -1], 36: [-5, -1],
    38: [-7, -2], 40: [-9, -3], 42: [-11, -4], 44: [-13, -5],
  },
  late: {
    // P-DEV-SHAPE: 「大器晚成」原本在**每一个区间**都 ≥ normal（16→32 累计成长
    //   20.5 vs normal 12.0），所以它不是「巅峰来得晚」而是「哪儿都更强」——
    //   实测条件均值 395 vs normal 242，是四档里的绝对霸主（≥90 OVR 占比
    //   50.2%，其余三档 0.7–13.5%）。身份要成立，晚熟就必须为后期强势付出
    //   前期代价：青年档（18-22）压到明显低于 normal，精进期（24-30）保持领先。
    //   累计 20.5 → 17.5，形态从「全程更强」变成「起步慢、22 岁起补上」：
    //   条件均值 395 → 288，但 p25 143（四档最低）配 ≥95 占比 3.5%（四档最高）
    //   ——身份从「哪儿都更强」变成「地板最低、天花板最高」的高风险档。
    //   注意 18 岁地板是 1 而不是 0：迭代中试过 [0,3]，条件均值反而掉到 236、
    //   峰值均值 78.5 成了四档最低，且把 difficulty-smoke 的 p10 巅峰门槛压到
    //   72（目标 ≥73）——0 地板会踩进 wonderkid 那条死亡螺旋（掷 0 → 丢训练
    //   bonus → 板凳 → min-of-N）。「前期弱」要靠低上限表达，不能靠零地板，
    //   否则弱的不是前期而是整条生涯。22 岁的 [3,5] 是配套的恢复力：让 18 岁
    //   起步不顺的那批人爬得回来，p10 才守得住。
    18: [1, 3], 20: [2, 4], 22: [3, 5], 24: [2, 4], 26: [1, 4],
    28: [1, 2], 30: [0, 2], 32: [0, 1], 34: [-2, 0], 36: [-3, -1],
    38: [-5, -2], 40: [-7, -3], 42: [-10, -4], 44: [-12, -5],
  },
  wonderkid: {
    // P-DEV-SHAPE: 旧表是四档垫底（条件均值 155、巅峰中位 71、≥90 占比 0.7%），
    //   而且被 normal 全分位数支配——不是高方差，是单向滑坡。根因不在均值，在
    //   青年期的 `0` 地板触发的三重复利：
    //     ① 掷出 0 → `delta > 0` 不成立 → 训练 bonus 整个作废 (sim.ts growthDelta)
    //     ② 落后 → 板凳 → 20 岁后 minRolls → 取两次/三次最小值
    //     ③ min-of-N 对宽区间的杀伤远大于窄区间，而 asc≥1「从严」正是只咬
    //        width ≥ 4 的区间——本档每一格都在射程内，被重复收割
    //   在这个引擎里「宽区间」不等于高方差，而是负债。所以高方差的身份不能靠
    //   低地板来表达：青年档地板抬到 ≥1（min-of-3 也保底为正，螺旋断掉），
    //   上限放开到 9/8/6/5 给出真正的爆发季；「伤仲永」的风险整体后移到 26+，
    //   那里读起来是「早衰」——一个球迷看得懂的故事，而不是一次看不见的青年期卡死。
    //   累计 8.0 → 14.0，峰值来得最早（24 岁前累计 17.0，四档最高）也谢得最快。
    //   配合抽取窗口 39% → 10%（见 legacy.ts rollDevProfile）：稀有且最强。
    18: [2, 9], 20: [2, 8], 22: [1, 6], 24: [1, 5], 26: [-2, 4],
    28: [-3, 3], 30: [-4, 1], 32: [-5, 0], 34: [-5, -1], 36: [-6, -1],
    38: [-7, -2], 40: [-9, -3], 42: [-11, -4], 44: [-13, -5],
  },
};

export const GK_DEV_TABLE: Record<number, readonly [number, number]> = {
  // P-GK: youth ceiling bumped 5→6 on the two earliest brackets only. The old
  // ceiling sat 2 below a normal outfielder's, costing a GK ~4-6 OVR by age 22
  // and capping 90+ at 0.3% (vs ST 3.5%) — a Buffon/Casillas/Neuer career was
  // nearly impossible. A +1 on all four youth brackets overshot to 4.5% (above
  // ST) — the youth ceiling is a leveraged tail multiplier, so a small bump on
  // the two earliest brackets lands a great GK at ~1-2% 90+ (rarer than a ST,
  // football-authentic) while lifting the 86+ tier that was starving.
  // 巅峰延迟：门将真实巅峰 ~30，旧表 28:[0,2]/30:[0,0] 让 GK 中位巅峰落在
  // 28。抬 28-30 档让成长延续到 29、衰退从 30 起，巅峰推到 ~30（与 outfield
  // 的 ~28-29 拉开 1-2 年，符合门将晚熟）。GK 青年档不动（门将本就慢熟、
  // 起步低，再压会伤底部）；32+ 衰退不动，长生涯优势保留。
  18: [1, 6], 20: [1, 6], 22: [1, 5], 24: [1, 4], 26: [0, 3],
  28: [0, 3], 30: [0, 2], 32: [-1, 0], 34: [-3, -1], 36: [-4, -1],
  38: [-5, -2], 40: [-6, -3], 42: [-7, -3], 44: [-12, -5],
};

export const GK_DEV_FALLBACK: readonly [number, number] = [-12, -5];
export const OUTFIELD_DEV_FALLBACK: readonly [number, number] = [-14, -7];

/** 上场时间 → 成长 (P-MINUTES)。取代 STARTER_TRAIN_BONUS 的「拿/不拿」两档:
 *  那张表按俱乐部声望索引却十档全是 1,且门槛只分主力-ish 与其他,实测
 *  76% 的赛季(主力 57% + 半主力 19%)拿到完全相同的 +1 —— 「上场时间」这条轴
 *  只有两个状态。真实里 主力/半主力/轮换/板凳 是梯度,踢满 38 轮和踢 15 轮
 *  的成长不该一样。
 *  板凳档给 0 而不是负数:growthDelta 的 minRolls/bigClubBench 已经在 roll 层
 *  惩罚过板凳了,这里再扣一次就是双重惩罚(且违反「调参往正向靠」)。
 *  键与 types.ts 的 Role 联合一致，但此处不 import Role —— types.ts 已经
 *  import 了 data.ts 的 Position，反向 import 会成环（AGENTS.md 禁止）。 */
export const ROLE_TRAIN_BONUS = {
  starter: 2,
  high_rotation: 1,
  low_rotation: 0,
  substitute: 0,
  third_keeper: 0,
} as const;

/** 评分 → 成长的判定带 (P-RATING)。阈值是「相对俱乐部标准的偏离」而非绝对
 *  评分 —— 在云南玉昆拿 7.5 和在皇马拿 7.5 不是一回事,后者难得多。标准线复用
 *  run.ts 的 forcedExitBar(按声望 6.5→6.9),它本来就是「管理层认可的及格线」。
 *  旧实现是绝对阈值的两端阶跃(≥8.0 +1 / <6.3 −1),实测 68.5% 的赛季落在中间
 *  死区 —— 7.9 分和 6.4 分的赛季长得一模一样。
 *  负向只到 −1(不设 −2):踢不好已经通过角色下降、强制离队被惩罚了。 */
export const RATING_GROWTH_BANDS: readonly { minDiff: number; delta: number }[] = [
  { minDiff: 1.5, delta: 2 },    // 统治级——远超这家俱乐部的标准 (实测 9.4% 的赛季)
  { minDiff: 0.8, delta: 1 },    // 稳定高于标准 (20.9%)
  { minDiff: -0.3, delta: 0 },   // 达标 (52.2%)
  { minDiff: -Infinity, delta: -1 }, // 不达标 (17.5%)
];

/** 综合表现档 → 成长加成 (P-PERF)。索引 = 上场时间分(ROLE_TRAIN_BONUS 0..2) +
 *  评分分(RATING_GROWTH_BANDS −1..2) + 1 的偏移,即 raw −1..4 映射到 0..5。
 *
 *  为什么要合并而不是两项直接相加:两条轴高度相关(主力才踢得出高评分),直接
 *  相加等于把同一件事算两遍——实测直接相加把 baseline 巅峰中位从 86 顶到 90、
 *  ≥90 从 30% 顶到 51%。这张表是**预算表**:它决定「表现」这条轴一共能发多少
 *  成长,而 raw 的分辨率(6 档 vs 旧的 2 档)决定玩家能感知到多少区分度。两件事
 *  分开调——想加区分度就拉开表内的差,想控通胀就压表的均值。
 *
 *  raw:      −1   0   1   2   3   4
 *  含义:   板凳+   板凳/  主力  主力  主力  主力
 *          踢砸   轮换   达标  稳定  优秀  统治
 *  加成:    −1    0    0    1    1    2   ← 见下方数组 */
export const GROWTH_PERF_BONUS: readonly number[] = [-1, 0, 0, 1, 1, 2];

/** Development ceiling (P-CEIL). A player outgrows their club's training
 *  environment. Growth is FULL up to SQUAD_BASE[club.rep] + DEV_CEILING_FLOOR[rep]
 *  (a star can exceed their club's level by this much), then ramps linearly down
 *  to ~0 over DEV_CEILING_RAMP[rep] (see sim.ts growthDelta/applyCeiling). A SOFT
 *  cap, not a hard stop: a star at a small club still develops SLOWLY toward
 *  the cap and arrives at a bigger club at a usable OVR so the transfer ladder
 *  still reaches 90+. But 90+ at a minnow is effectively impossible — growth is
 *  a tiny fraction that far above the base, and the age-28 decline outpaces it.
 *  The floor is TAPERED by club rep: small for weak clubs (they cap low), larger
 *  for big clubs (stars develop further into the 90s). This separates the two
 *  goals a flat gap can't: a weak CSL minnow caps ~70-75 (fixes
 *  "90多踢中超没人要我"), AND big clubs keep enough headroom that the climb
 *  path still produces 90+ stars.
 *
 *  难度曲线重调（tools/difficulty-smoke 指南针驱动）：rep0-1 地板从 4/6 抬到
 *  8/10——金童（+15 起跑 → 65）原本一到 rep1 弱队（天花板 64）就被压死、起跑
 *  优势被吃掉，现 rep1 天花板 68 让 65 在全成长带内、能继续涨到转会；弱联赛
 *  （中甲）起步的普通玩家也在 rep0 天花板 60 多涨一点再转会，抬底部尾巴。
 *  rep5-9 地板微抬一档，让爬到中强/精英俱乐部的玩家能摸到 90-95（baseline 实测：
 *  中位 83、≥90 22%、≥95 7%；有祝福上探到 ≥90 36%、≥95 20%）。
 *  Per-rep full-growth ceiling = base + floor, ~0-growth at base+floor+ramp
 *  (10-tier scale; bases spread 52→88 across rep0..9):
 *    rep0 52: full→62,  ramp 15 (~0 at 77)  (弱队起步多涨点再转会)
 *    rep1 58: full→70,  ramp 15 (~0 at 85)  (金童 65 起跑不再被压)
 *    rep2 63: full→75,  ramp 15 (~0 at 90)  (p10 底部抬高)
 *    rep3 68: full→78,  ramp 15 (~0 at 93)  (caps ~88, 90+ barely)
 *    rep5 76: full→85,  ramp 15 (~0 at 100) (base game)
 *    rep6 79: full→86,  ramp 6  (~0 at 92)  (strong club)
 *    rep7 82: full→86,  ramp 4  (~0 at 90)  (climb target)
 *    rep8 85: full→88,  ramp 4  (~0 at 92)  (elite)
 *    rep9 88: full→90,  ramp 4  (~0 at 94)  (elite — 95+ 仅事件透支, 稀有)
 *  Two dials, both per-rep: the FLOOR (a star exceeds their club by this much)
 *  and the RAMP (how fast growth decays above the ceiling). The top-rep floors
 *  are TRIMMED (rep6-9: 13/11/9/7 not 14/15/16/17) so the cap ENGAGES below
 *  the 99 hard cap — otherwise rep8-9 ceilings sat at 101/105 and at OVR 99 the
 *  factor was 1.0 (excess 0): the ceiling was decorative and full-prestige
 *  endgames bloated to a 97-99 median. But trimming alone did nothing: the
 *  delta-scaling cap (factor at the CURRENT ovr) can't contain the huge
 *  full-prestige deltas (wonderkid [1,10] × glass_cannon 1.5 = up to +15/season)
 *  — a big delta from below the ceiling jumps straight past the ramp to 99.
 *  So elite clubs (rep≥6) use a RESULT-based cap (applyCeiling caps the
 *  resulting OVR, scaling the portion that lands above the ceiling) while
 *  base-game clubs (rep≤5) keep the original delta-scaling cap so base-game
 *  dynamics are UNCHANGED. The ramp is PER-REP for the same reason: 15 at low
 *  clubs (gentle, unchanged), steep at elite clubs (6/4/4/5 across rep6-9) so
 *  the result-cap peak ≈ ceiling+ramp/2. The spread stays monotonic
 *  (87→88→89→91→94 across rep5-9) so climbing the transfer ladder still raises
 *  your ceiling; 95+ at an elite club is EARNED. Aging decline is unaffected;
 *  this scales GROWTH only.
 *
 *  BAL-GROWTH（成长兜底→地板）：实测 meta 玩家（祝福+perk+爬梯）88%≥90、
 *  43%≥95、众数 93/95——成长+天花板把众人 shelf 在 92-95，事件选择被淹没。
 *  下调 rep9 地板 4→2，精英天花板 92→90：成长单独峰值 ~88-90，95+ 只能靠
 *  permanent 事件透支（稀有），分布散开到 80s-95。rep0-1 维持抬高的底部（弱
 *  队起步仍能涨到转会）。新天花板 62/70/75/78/84/85/86/86/88/90，仍单调，爬梯
 *  仍抬升天花板。permanent 仍豁免天花板（生涯级跃升是顶到 99 的唯一杠杆）；
 *  immediate/deferred 仍套天花板（俱乐部环境的 transient 波动）。
 *  P-ROLE: 降低大俱乐部天花板梯度（声望权重↓）——顶端 rep6-9 各 -1，让
 *    “在豪门就自动堆顶”减弱。配合 growthDelta 的 starter bonus 权重提升
 *    （上场时间↑），净效应是“上场踢球”比“坐在豪门板凳”更能长。小俱乐部
 *    天花板（rep0-5）不动，守住“90 多踢中超”的护栏。
 *
 *  P-LEAGUE 成长语境: 天花板不再只看俱乐部声望,而是看「俱乐部声望 + 所在联赛
 *  水平」(见 LEAGUE_DEV_SHIFT / sim.ts devRep)。中超 rep3 的国安和西甲 rep3 的
 *  球队原本发展完全一致——联赛参数在 growthDelta 里被 `void league` 丢掉,整条
 *  语境轴(出身国 T1 vs T5、五大 vs 中超)对生涯曲线的总影响只有 ~1 OVR。挂上
 *  联赛档位后「转去更强的联赛」才真正解锁成长,把死掉的联赛轴变回决策轴。
 *  rep0-5 的 RAMP 15→8:配合下面统一的 result-based cap,让低中级俱乐部的硬顶
 *  收敛在「天花板 +2」而不是无限漂移(旧 delta-scaling cap 按当前 OVR 取系数,
 *  正好卡在天花板上的球员仍拿满额 delta,一季直接越过整条斜坡——中超 rep3
 *  名义天花板 78、实际能漂到 ~93,这就是「21 岁 84」的直接成因)。 */
export const DEV_CEILING_FLOOR: readonly number[] = [13, 14, 14, 13, 10, 9, 7, 5, 4, 3];
export const DEV_CEILING_RAMP: readonly number[] = [15, 15, 15, 15, 15, 8, 6, 4, 4, 4];

/** 联赛发展档位偏移 (P-LEAGUE),按 league.domRep 0..5 索引。作用于天花板用的
 *  「有效声望」= clamp(club.rep + shift, 0, 9)——弱联赛把俱乐部的培养环境整体
 *  降一到两档,强联赛不动。概率/软上限,不是硬墙:天才照样能在中超涨到硬顶,
 *  再往上必须转去更强的联赛(现实路径 中超→葡超/荷甲跳板→五大)。
 *    domRep 0-1 (中甲/西乙/巴乙)   −2
 *    domRep 2   (中超/日职/K联赛/英冠/阿甲/MLS) −1
 *    domRep 3   (葡超/荷甲/巴甲/墨甲/沙特联)     0
 *    domRep 4-5 (法甲/英超/西甲/意甲/德甲)        0
 *  不给强联赛正偏移:五大俱乐部的 rep 本身已经在 6-9 档,再加码会把顶端顶穿。 */
export const LEAGUE_DEV_SHIFT: readonly number[] = [-2, -2, -1, 0, 0, 0];

// ───────────────── 青训期环境权重 (P-YOUTH) ─────────────────
// 天花板只在球员逼近它时才起作用,而 16-20 岁的球员离任何天花板都还很远——
// 于是「在哪长大」在最该有差距的窗口里反而毫无影响(实测六种语境的 18 岁中位
// 全是 57-58)。这组权重补的就是这段:青训期的成长率按「出身国青训档位 ×
// 培养环境(俱乐部声望+联赛档位)」缩放。过了年龄线交还给天花板与上场时间。

/** 青训期上限年龄(含)。growthDelta 的 targetAge 走偶数档,所以 20 覆盖 18/20
 *  两档,即球员的 16-20 岁——现实里的青训队到成年队过渡窗。 */
export const YOUTH_DEV_MAX_AGE = 20;

/** 出身国青训档位 → 青训期成长率乘数(按 youthTier 1..5,index 0 未用)。
 *  终身烙印但只在青训期计算:一个中国孩子 16-20 岁长得慢,20 岁之后到了欧洲,
 *  成长交给新环境——出身不再继续罚他。幅度对齐 NATION_LEGACY_MULT 的补偿刻度,
 *  T1/T5 相差 ~22%,叠加 CLUB_YOUTH_MULT 后总差距 ~1.7 倍。 */
export const NATION_YOUTH_MULT = [0, 1.1, 1.05, 1, 0.95, 0.9] as const;

/** 培养环境 → 青训期成长率乘数(按 devRep 0..9,即俱乐部声望 + 联赛档位偏移)。
 *  拉玛西亚(eff 9)vs 中甲小队(eff 0)= 1.20 vs 0.88。梯度做得比天花板梯子平缓,
 *  因为「上场时间」必须仍然压过「在豪门」——豪门板凳的 min-of-three 惩罚
 *  (growthDelta bigClubBench)幅度远大于这里的 +20%,所以早早去豪门坐板凳依旧
 *  是错解,这条设计意图(P-ROLE)不被本表推翻。 */
export const CLUB_YOUTH_MULT = [0.88, 0.92, 0.96, 1, 1.03, 1.06, 1.09, 1.11, 1.13, 1.15] as const;

// ───────────────────────────── reputation helpers ─────────────────────────────

/** Player star tier for transfer/blockbuster gating: ≥90→3, ≥85→2, ≥80→1, else 0. */
export function starTier(overall: number): number {
  return overall >= 90 ? 3 : overall >= 85 ? 2 : overall >= 80 ? 1 : 0;
}

/** Player reputation tier 0..9 (mirrors the club-rep scale: the tier whose
 *  squad base a player of this OVR would start at). Used for transfer
 *  targeting on the same 0..9 axis as club.rep. */
export function repTier(overall: number): number {
  if (overall >= 88) return 9;
  if (overall >= 85) return 8;
  if (overall >= 82) return 7;
  if (overall >= 79) return 6;
  if (overall >= 76) return 5;
  if (overall >= 72) return 4;
  if (overall >= 68) return 3;
  if (overall >= 63) return 2;
  if (overall >= 58) return 1;
  return 0;
}

/** Visual club star rating (1..5) — the 0..9 rep compressed to a readable
 *  mobile display (the engine uses the precise 0..9; the UI shows 1-5 stars
 *  so a card never renders 10 stars wide). rep8-9 → 5★ (elite), down to 1★. */
export function clubStarRating(rep: number): number {
  if (rep >= 8) return 5;
  if (rep >= 6) return 4;
  if (rep >= 4) return 3;
  if (rep >= 2) return 2;
  return 1;
}

/** Star difficulty multiplier: how a player's contribution (OVR vs the club's
 *  squad base) scales a competition's trophy odds. Symmetric around the squad
 *  base: a star lifting his team BOOSTS odds (up to ×1.6); a player well BELOW
 *  the squad base DRAGS them (down to ×0.3).
 *
 *  The penalty side is the rookie/benchwarmer fix. A 16yo debutant is 30–40
 *  OVR below ANY non-trivial club's squad base — before this, they shared the
 *  SAME trophy odds as an at-base starter (both returned ×1), so the 巨头档
 *  academy fork trivially farmed a 生涯首冠 in the first period (~79% at a
 *  rep-9 giant for a 50-OVR kid who never started). That made the academy
 *  choice a dominant strategy (pick the biggest club → free medals) and
 *  devalued the first-trophy milestone (it fired in season 1 with no buildup).
 *  Now a well-below-base player is a football-legible drag on a title chase —
 *  the occasional minutes a youth player gets are a weak link, and the team
 *  isn't being lifted BY him — so his carried-trophy odds fall. It self-targets
 *  the rookie season (a 16yo is always below base) without an age special-case,
 *  fades naturally as he grows into the squad (domDiff → 0 → ×1.0), and
 *  generalizes to a late-career washout who drops to a club he's still below.
 *  The carried-trophy drama survives (down to ~37% first-period at a giant,
 *  not zeroed) so a lucky medal is still possible. 详见 research/
 *  first-trophy-dampen.md（400 次冒烟 + balance-check）；可复跑 tools/first-trophy-smoke.ts。 */
export function starDifficulty(diff: number): number {
  if (diff >= 10) return 1.6;
  if (diff >= 6) return 1.3;
  if (diff >= 3) return 1.1;
  if (diff >= -3) return 1;      // at / just below squad base — a starter, no drag
  if (diff >= -9) return 0.8;    // rotation / first bench — slight drag
  if (diff >= -16) return 0.6;   // clear benchwarmer — moderate drag
  if (diff >= -24) return 0.45;  // deep bench — big drag
  return 0.3;                    // well below base — the rookie-at-a-giant case
}

/** Goalscoring ability factor from OVR (Ke). */
export function scoringAbility(overall: number): number {
  const o = Math.max(40, Math.min(99, overall));
  if (o <= 65) return 0.6;
  if (o <= 80) return 0.6 + ((o - 65) / 15) * 0.25;
  if (o <= 85) return 0.85 + ((o - 80) / 5) * 0.15;
  return 1 + ((o - 85) / 14) * 0.42;
}

/** Tournament-cycle offset for a career, deterministic from the seed.
 *  ∈ {0,1,2,3}. The World Cup used to be nailed to ages 19/23/27/31 for
 *  EVERY career — a fixed narrative beat, not a football event the player
 *  earns. Now each career's WC cycle is phase-shifted by this offset, so the
 *  World Cup lands at (19+offset, +4, +4, ...). Same seed + same choices still
 *  reproduces an identical career (the offset is a pure function of the seed).
 *  Intercontinental events keep their real-world 1-year lead on the WC and the
 *  Club WC a 1-year lag — both shifted by the same offset. */
export function tournamentOffset(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 4;
}
/** Club World Cup eligibility age (1 year after the WC year), phase-shifted. */
export function isCwcAge(age: number, toff = 0): boolean {
  const base = 19 + toff;       // WC year base; CWC lags the WC by 1 year
  return age >= base + 1 && (age - (base + 1)) % 4 === 0;
}
/** National continental cup eligibility age (1 year before the WC), shifted. */
export function isNatContAge(age: number, toff = 0): boolean {
  const base = 19 + toff;       // continental cups lead the WC by 1 year
  return age >= base - 1 && (age - (base - 1)) % 4 === 0;
}
/** World Cup year age, phase-shifted by the career's tournament offset. */
export function isWcAge(age: number, toff = 0): boolean {
  const base = 19 + toff;
  return age >= base && (age - base) % 4 === 0;
}
/** Olympic year age = World Cup year + 2 (real-world cadence: 2022 WC → 2024
 *  Olympics), phase-shifted. Sits 2 years after the WC and never collides with
 *  the WC (WC) or continental cup (WC-1) — the three tournament streams are
 *  pairwise distinct years for every tournamentOffset. The Olympics is the
 *  'first big tournament' tier (national-track-youth-olympic): gated ≤24 and
 *  to the U21 youth bar, so a young player who hasn't hit the WC FINAL_FLOOR
 *  can still play a major tournament. */
export function isOlympicAge(age: number, toff = 0): boolean {
  const base = 19 + toff + 2;   // WC year + 2
  return age >= base && (age - base) % 4 === 0;
}
