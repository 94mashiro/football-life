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
  { id: "primeira-liga",  name: "葡超", country: "POR", confederation: "UEFA", tier: 1, domRep: 3, contRep: 3, hasDomesticCup: true, wealth: 0.55 },
  { id: "eredivisie",      name: "荷甲", country: "NED", confederation: "UEFA", tier: 1, domRep: 3, contRep: 3, hasDomesticCup: true, wealth: 0.6 },
  { id: "super-lig",       name: "土超", country: "TUR", confederation: "UEFA", tier: 1, domRep: 3, contRep: 2, hasDomesticCup: true, wealth: 0.55 },
  { id: "scottish-pred",   name: "苏超", country: "SCO", confederation: "UEFA", tier: 1, domRep: 2, contRep: 2, hasDomesticCup: true, wealth: 0.4 },
  { id: "greek-super",     name: "希腊超", country: "GRE", confederation: "UEFA", tier: 1, domRep: 2, contRep: 2, hasDomesticCup: true, wealth: 0.35 },
  { id: "swiss-super",     name: "瑞士超", country: "SUI", confederation: "UEFA", tier: 1, domRep: 2, contRep: 2, hasDomesticCup: true, wealth: 0.45 },
  { id: "austrian-bund",   name: "奥甲", country: "AUT", confederation: "UEFA", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.4 },
  { id: "czech-liga",      name: "捷克甲", country: "CZE", confederation: "UEFA", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.35 },
  { id: "polish-ekstraklasa", name: "波兰甲", country: "POL", confederation: "UEFA", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.35 },
  { id: "ukrainian-premier", name: "乌超", country: "UKR", confederation: "UEFA", tier: 1, domRep: 2, contRep: 2, hasDomesticCup: true, wealth: 0.4 },
  // ── CONCACAF ──
  { id: "mls",            name: "美职联", country: "USA", confederation: "CONCACAF", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.65 },
  { id: "liga-mx",        name: "墨甲", country: "MEX", confederation: "CONCACAF", tier: 1, domRep: 3, contRep: 2, hasDomesticCup: true, wealth: 0.45 },
  // ── CAF ──
  { id: "egyptian-pred",  name: "埃及超", country: "EGY", confederation: "CAF", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.3 },
  // ── UEFA second division ──
  { id: "championship",   name: "英冠", country: "ENG", confederation: "UEFA", tier: 2, domRep: 2, contRep: 0, hasDomesticCup: true, wealth: 0.5 },
  { id: "laliga-2",       name: "西乙", country: "ESP", confederation: "UEFA", tier: 2, domRep: 1, contRep: 0, hasDomesticCup: true, wealth: 0.35 },
  // ── AFC ──
  { id: "csl",            name: "中超",   country: "CHN", confederation: "AFC", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.9, salaryCap: 180 },
  { id: "china-league-one", name: "中甲", country: "CHN", confederation: "AFC", tier: 2, domRep: 1, contRep: 0, hasDomesticCup: true, wealth: 0.3, salaryCap: 25 },
  { id: "j1-league",     name: "日职联", country: "JPN", confederation: "AFC", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.55 },
  { id: "k-league-1",    name: "K联赛",  country: "KOR", confederation: "AFC", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true, wealth: 0.45 },
  { id: "saudi-pro-league", name: "沙特联", country: "KSA", confederation: "AFC", tier: 1, domRep: 3, contRep: 2, hasDomesticCup: true, wealth: 2.0, fame: true },
  // ── CONMEBOL ──
  { id: "brasileirao",    name: "巴甲", country: "BRA", confederation: "CONMEBOL", tier: 1, domRep: 3, contRep: 3, hasDomesticCup: true, wealth: 0.5 },
  { id: "brasileirao-b",  name: "巴乙", country: "BRA", confederation: "CONMEBOL", tier: 2, domRep: 1, contRep: 0, hasDomesticCup: true, wealth: 0.22 },
  { id: "argentine-primera", name: "阿甲", country: "ARG", confederation: "CONMEBOL", tier: 1, domRep: 2, contRep: 3, hasDomesticCup: true, wealth: 0.4 },
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
  { id: "real-betis", name: "皇家贝蒂斯", leagueId: "laliga", domRep: 2, contRep: 2, intlRep: 3, rep: 5 },
  { id: "sevilla", name: "塞维利亚", leagueId: "laliga", domRep: 2, contRep: 2, intlRep: 3, rep: 5 },
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
  { id: "porto", name: "波尔图", leagueId: "primeira-liga", domRep: 4, contRep: 3, intlRep: 3, rep: 7 },
  { id: "benfica", name: "本菲卡", leagueId: "primeira-liga", domRep: 4, contRep: 3, intlRep: 3, rep: 7 },
  { id: "sporting-cp", name: "里斯本竞技", leagueId: "primeira-liga", domRep: 4, contRep: 3, intlRep: 3, rep: 7 },
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
  { id: "paysandu", name: "帕伊桑杜", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "river-plate", name: "河床", leagueId: "argentine-primera", domRep: 5, contRep: 4, intlRep: 4, rep: 7, rivalId: "boca-juniors" },
  { id: "boca-juniors", name: "博卡青年", leagueId: "argentine-primera", domRep: 5, contRep: 3, intlRep: 3, rep: 7, rivalId: "river-plate" },
  { id: "racing-club", name: "竞技", leagueId: "argentine-primera", domRep: 3, contRep: 3, intlRep: 3, rep: 5 },
  { id: "estudiantes", name: "拉普拉塔大学生", leagueId: "argentine-primera", domRep: 3, contRep: 2, intlRep: 2, rep: 5 },
  { id: "velez-sarsfield", name: "贝莱斯", leagueId: "argentine-primera", domRep: 3, contRep: 2, intlRep: 2, rep: 5 },
  { id: "independiente", name: "独立", leagueId: "argentine-primera", domRep: 2, contRep: 2, intlRep: 2, rep: 4 },
  { id: "san-lorenzo", name: "圣洛伦索", leagueId: "argentine-primera", domRep: 2, contRep: 2, intlRep: 2, rep: 4 },
  { id: "talleres", name: "塔耶雷斯", leagueId: "argentine-primera", domRep: 2, contRep: 1, intlRep: 1, rep: 4 },
  { id: "newells-old-boys", name: "纽维尔老男孩", leagueId: "argentine-primera", domRep: 1, contRep: 0, intlRep: 0, rep: 3 },
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
  { id: "la-galaxy", name: "洛杉矶银河", leagueId: "mls", domRep: 2, contRep: 0, intlRep: 2, rep: 4 },
  { id: "inter-miami", name: "迈阿密国际", leagueId: "mls", domRep: 2, contRep: 0, intlRep: 3, rep: 4 },
  { id: "ny-red-bulls", name: "纽约红牛", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
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
  { id: "zurich", name: "苏黎世", leagueId: "swiss-super", domRep: 2, contRep: 1, intlRep: 2, rep: 4 },
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
  { id: "wisla-krakow", name: "克拉科维斯瓦", leagueId: "polish-ekstraklasa", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "gornik-zabrze", name: "扎布热矿工", leagueId: "polish-ekstraklasa", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
  // ── 乌超 ──
  { id: "shakhtar", name: "顿涅茨克矿工", leagueId: "ukrainian-premier", domRep: 4, contRep: 3, intlRep: 3, rep: 6, rivalId: "dynamo-kyiv" },
  { id: "dynamo-kyiv", name: "基辅迪纳摩", leagueId: "ukrainian-premier", domRep: 4, contRep: 3, intlRep: 3, rep: 6, rivalId: "shakhtar" },
  { id: "zorya", name: "卢甘斯克索黎亚", leagueId: "ukrainian-premier", domRep: 2, contRep: 1, intlRep: 1, rep: 4 },
  { id: "kolos", name: "科洛斯", leagueId: "ukrainian-premier", domRep: 1, contRep: 0, intlRep: 1, rep: 3 },
  { id: "vorskla", name: "沃斯卡拉", leagueId: "ukrainian-premier", domRep: 1, contRep: 0, intlRep: 0, rep: 3 },
  { id: "minai", name: "米奈", leagueId: "ukrainian-premier", domRep: 0, contRep: 0, intlRep: 0, rep: 1 },
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
// of player quality AND nation strength: Brazil (intlRep 5) first caps at ~80, a
// minnow (intlRep 0) at ~62. A weak player simply doesn't get called up to a
// strong nation → no national caps, no national tournament, no WC climax. The
// climax floors in run.ts (WC_FINAL_FLOOR / CONT_FINAL_FLOOR) sit ABOVE this
// ladder — the FINAL is for a star, not a squad call-up.
//   intlRep 0 (斐济/越南/印尼):          62  — a decent pro makes it
//   intlRep 1 (中国/玻利维亚/巴拿马):    66
//   intlRep 2 (苏格兰/美国/加纳):        70
//   intlRep 3 (日本/韩国/墨西哥/摩洛哥): 74
//   intlRep 4 (葡萄牙/比利时/乌拉圭):    78
//   intlRep 5 (巴西/西班牙/法国/德国/英格兰/阿根廷): 80
export const CALLUP_THRESHOLD = [62, 66, 70, 74, 78, 80];

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
 *  飞升 10 仍走 effClub.rep-1, so a rep-5 club at 飞升10 reads rep4 → gated out. */
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
    // P-ROLE: 精进期（24-28）上限各 -1，压 late 档峰值（实测中位 93、是 ≥90
    //   大户）。「大器晚成」的身份是“巅峰来得晚”而非“巅峰更高”——青年档
    //   不动（保成长期形态），只收精进期的堆顶能力，把 late 峰值从 93 压向 91。
    18: [3, 6], 20: [3, 6], 22: [2, 5], 24: [2, 4], 26: [1, 3],
    28: [1, 2], 30: [0, 2], 32: [0, 1], 34: [-2, 0], 36: [-3, -1],
    38: [-5, -2], 40: [-7, -3], 42: [-10, -4], 44: [-12, -5],
  },
  wonderkid: {
    // BAL-GROWTH: 削 +10 的伤仲永级尖峰——那是 95 聚集的元凶。成长兜底不应
    //   独自把人顶到 95：95+ 应由 permanent 事件透支（稀有），而非一个 18 岁
    //   的爆发季。18 的爆发上界 10→7，20-24 上限各砍 1-2，均值略低于 normal。
    //   地板仍归零（巅峰前不掉评）、26 起 -1 保留「伤仲永」可能——高方差档的
    //   身份是「可能爆发也可能伤仲永」，不是「白送 95」。
    18: [0, 7], 20: [0, 5], 22: [0, 4], 24: [0, 3], 26: [-1, 2],
    28: [-1, 1], 30: [-1, 0], 32: [-3, 0], 34: [-4, -1], 36: [-5, -1],
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

/** Starter training bonus by club international reputation tier.
 *  BAL-GROWTH: 改为全档 +1（去掉精英档 +2 的复利）。旧值每个正增长赛季
 *  叠加，整生涯独贡献 +12~+18 OVR——把成长兜底从「地板」做成了「梯子」：
 *  即使乱选也把人托到 85+，配合天花板把众人 shelf 在 92-95（实测 meta 玩家
 *  88%≥90、43%≥95、众数 93/95）。改为全 +1 后「大俱乐部训练更好」的激励
 *  交还给「天花板高、奖杯多」而非每季白送数值；成长只交付中位 ~78-82 的地板，
 *  90+ 由事件选择挣得、95+ 由 permanent 事件透支（稀有），分布散开到
 *  80s-95——兑现「事件影响权重 > 成长兜底权重」的设计意图。 */
export const STARTER_TRAIN_BONUS = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] as const;

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
 *    天花板（rep0-5）不动，守住“90 多踢中超”的护栏。 */
export const DEV_CEILING_FLOOR: readonly number[] = [10, 12, 12, 10, 12, 9, 6, 3, 2, 1];
export const DEV_CEILING_RAMP: readonly number[] = [15, 15, 15, 15, 15, 15, 6, 4, 4, 4];

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
