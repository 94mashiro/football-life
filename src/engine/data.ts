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
}

export const LEAGUES: readonly League[] = [
  // ── UEFA top flight ──
  { id: "premier-league", name: "英超", country: "ENG", confederation: "UEFA", tier: 1, domRep: 5, contRep: 5, hasDomesticCup: true },
  { id: "laliga",         name: "西甲", country: "ESP", confederation: "UEFA", tier: 1, domRep: 5, contRep: 5, hasDomesticCup: true },
  { id: "serie-a",        name: "意甲", country: "ITA", confederation: "UEFA", tier: 1, domRep: 5, contRep: 4, hasDomesticCup: true },
  { id: "bundesliga",     name: "德甲", country: "GER", confederation: "UEFA", tier: 1, domRep: 5, contRep: 5, hasDomesticCup: true },
  { id: "ligue-1",        name: "法甲", country: "FRA", confederation: "UEFA", tier: 1, domRep: 4, contRep: 4, hasDomesticCup: true },
  { id: "primeira-liga",  name: "葡超", country: "POR", confederation: "UEFA", tier: 1, domRep: 3, contRep: 3, hasDomesticCup: true },
  { id: "eredivisie",      name: "荷甲", country: "NED", confederation: "UEFA", tier: 1, domRep: 3, contRep: 3, hasDomesticCup: true },
  { id: "super-lig",       name: "土超", country: "TUR", confederation: "UEFA", tier: 1, domRep: 3, contRep: 2, hasDomesticCup: true },
  { id: "scottish-pred",   name: "苏超", country: "SCO", confederation: "UEFA", tier: 1, domRep: 2, contRep: 2, hasDomesticCup: true },
  { id: "greek-super",     name: "希腊超", country: "GRE", confederation: "UEFA", tier: 1, domRep: 2, contRep: 2, hasDomesticCup: true },
  { id: "swiss-super",     name: "瑞士超", country: "SUI", confederation: "UEFA", tier: 1, domRep: 2, contRep: 2, hasDomesticCup: true },
  { id: "austrian-bund",   name: "奥甲", country: "AUT", confederation: "UEFA", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true },
  { id: "czech-liga",      name: "捷克甲", country: "CZE", confederation: "UEFA", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true },
  { id: "polish-ekstraklasa", name: "波兰甲", country: "POL", confederation: "UEFA", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true },
  { id: "ukrainian-premier", name: "乌超", country: "UKR", confederation: "UEFA", tier: 1, domRep: 2, contRep: 2, hasDomesticCup: true },
  // ── CONCACAF ──
  { id: "mls",            name: "美职联", country: "USA", confederation: "CONCACAF", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true },
  { id: "liga-mx",        name: "墨甲", country: "MEX", confederation: "CONCACAF", tier: 1, domRep: 3, contRep: 2, hasDomesticCup: true },
  // ── CAF ──
  { id: "egyptian-pred",  name: "埃及超", country: "EGY", confederation: "CAF", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true },
  // ── UEFA second division ──
  { id: "championship",   name: "英冠", country: "ENG", confederation: "UEFA", tier: 2, domRep: 2, contRep: 0, hasDomesticCup: true },
  { id: "laliga-2",       name: "西乙", country: "ESP", confederation: "UEFA", tier: 2, domRep: 1, contRep: 0, hasDomesticCup: true },
  // ── AFC ──
  { id: "csl",            name: "中超",   country: "CHN", confederation: "AFC", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true },
  { id: "china-league-one", name: "中甲", country: "CHN", confederation: "AFC", tier: 2, domRep: 1, contRep: 0, hasDomesticCup: true },
  { id: "j1-league",     name: "日职联", country: "JPN", confederation: "AFC", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true },
  { id: "k-league-1",    name: "K联赛",  country: "KOR", confederation: "AFC", tier: 1, domRep: 2, contRep: 1, hasDomesticCup: true },
  { id: "saudi-pro-league", name: "沙特联", country: "KSA", confederation: "AFC", tier: 1, domRep: 3, contRep: 2, hasDomesticCup: true },
  // ── CONMEBOL ──
  { id: "brasileirao",    name: "巴甲", country: "BRA", confederation: "CONMEBOL", tier: 1, domRep: 3, contRep: 3, hasDomesticCup: true },
  { id: "brasileirao-b",  name: "巴乙", country: "BRA", confederation: "CONMEBOL", tier: 2, domRep: 1, contRep: 0, hasDomesticCup: true },
  { id: "argentine-primera", name: "阿甲", country: "ARG", confederation: "CONMEBOL", tier: 1, domRep: 2, contRep: 3, hasDomesticCup: true },
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
  { id: "man-city", name: "曼城", leagueId: "premier-league", domRep: 5, contRep: 5, intlRep: 5, rep: 5, rivalId: "man-utd" },
  { id: "liverpool", name: "利物浦", leagueId: "premier-league", domRep: 4, contRep: 4, intlRep: 5, rep: 4, rivalId: "everton" },
  { id: "arsenal", name: "阿森纳", leagueId: "premier-league", domRep: 5, contRep: 5, intlRep: 5, rep: 5, rivalId: "tottenham" },
  { id: "chelsea", name: "切尔西", leagueId: "premier-league", domRep: 4, contRep: 4, intlRep: 4, rep: 4 },
  { id: "man-utd", name: "曼联", leagueId: "premier-league", domRep: 4, contRep: 4, intlRep: 4, rep: 4, rivalId: "man-city" },
  { id: "tottenham", name: "热刺", leagueId: "premier-league", domRep: 3, contRep: 3, intlRep: 4, rep: 3, rivalId: "arsenal" },
  { id: "newcastle", name: "纽卡斯尔联", leagueId: "premier-league", domRep: 2, contRep: 2, intlRep: 3, rep: 2 },
  { id: "aston-villa", name: "阿斯顿维拉", leagueId: "premier-league", domRep: 3, contRep: 3, intlRep: 3, rep: 3 },
  { id: "brighton", name: "布莱顿", leagueId: "premier-league", domRep: 3, contRep: 3, intlRep: 3, rep: 3 },
  { id: "west-ham", name: "西汉姆联", leagueId: "premier-league", domRep: 2, contRep: 2, intlRep: 3, rep: 2 },
  { id: "nottingham", name: "诺丁汉森林", leagueId: "premier-league", domRep: 2, contRep: 2, intlRep: 2, rep: 2 },
  { id: "crystal-palace", name: "水晶宫", leagueId: "premier-league", domRep: 3, contRep: 3, intlRep: 3, rep: 3 },
  { id: "fulham", name: "富勒姆", leagueId: "premier-league", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "brentford", name: "布伦特福德", leagueId: "premier-league", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "everton", name: "埃弗顿", leagueId: "premier-league", domRep: 1, contRep: 1, intlRep: 2, rep: 1, rivalId: "liverpool" },
  { id: "wolves", name: "狼队", leagueId: "premier-league", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "bournemouth", name: "伯恩茅斯", leagueId: "premier-league", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "leeds", name: "利兹联", leagueId: "premier-league", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "burnley", name: "伯恩利", leagueId: "premier-league", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "sunderland", name: "桑德兰", leagueId: "premier-league", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "leicester", name: "莱斯特城", leagueId: "championship", domRep: 3, contRep: 0, intlRep: 2, rep: 3 },
  { id: "southampton", name: "南安普顿", leagueId: "championship", domRep: 3, contRep: 0, intlRep: 2, rep: 3 },
  { id: "ipswich", name: "伊普斯维奇", leagueId: "championship", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "middlesbrough", name: "米德尔斯堡", leagueId: "championship", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "west-brom", name: "西布罗姆维奇", leagueId: "championship", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "coventry", name: "考文垂", leagueId: "championship", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "norwich", name: "诺维奇", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "watford", name: "沃特福德", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "hull", name: "赫尔城", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "stoke", name: "斯托克城", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "millwall", name: "米尔沃尔", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "preston", name: "普雷斯顿", leagueId: "championship", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "swansea", name: "斯旺西", leagueId: "championship", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "cardiff", name: "卡迪夫城", leagueId: "championship", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "blackburn", name: "布莱克本", leagueId: "championship", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "qpr", name: "女王公园巡游者", leagueId: "championship", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "real-madrid", name: "皇家马德里", leagueId: "laliga", domRep: 5, contRep: 5, intlRep: 5, rep: 5, rivalId: "barcelona" },
  { id: "barcelona", name: "巴塞罗那", leagueId: "laliga", domRep: 5, contRep: 5, intlRep: 5, rep: 5, rivalId: "real-madrid" },
  { id: "atletico-madrid", name: "马德里竞技", leagueId: "laliga", domRep: 4, contRep: 4, intlRep: 4, rep: 4, rivalId: "real-madrid" },
  { id: "villarreal", name: "比利亚雷亚尔", leagueId: "laliga", domRep: 3, contRep: 3, intlRep: 3, rep: 3 },
  { id: "athletic-bilbao", name: "毕尔巴鄂竞技", leagueId: "laliga", domRep: 3, contRep: 3, intlRep: 3, rep: 3 },
  { id: "real-sociedad", name: "皇家社会", leagueId: "laliga", domRep: 2, contRep: 2, intlRep: 3, rep: 2 },
  { id: "real-betis", name: "皇家贝蒂斯", leagueId: "laliga", domRep: 2, contRep: 2, intlRep: 3, rep: 2 },
  { id: "sevilla", name: "塞维利亚", leagueId: "laliga", domRep: 2, contRep: 2, intlRep: 3, rep: 2 },
  { id: "valencia", name: "瓦伦西亚", leagueId: "laliga", domRep: 2, contRep: 1, intlRep: 2, rep: 2 },
  { id: "girona", name: "赫罗纳", leagueId: "laliga", domRep: 2, contRep: 1, intlRep: 2, rep: 2 },
  { id: "celta-vigo", name: "塞尔塔", leagueId: "laliga", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "osasuna", name: "奥萨苏纳", leagueId: "laliga", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "rayo-vallecano", name: "巴列卡诺", leagueId: "laliga", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "mallorca", name: "马洛卡", leagueId: "laliga", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "getafe", name: "赫塔菲", leagueId: "laliga", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "espanyol", name: "西班牙人", leagueId: "laliga", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "alaves", name: "阿拉维斯", leagueId: "laliga", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "elche", name: "埃尔切", leagueId: "laliga", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "levante", name: "莱万特", leagueId: "laliga", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "oviedo", name: "奥维耶多", leagueId: "laliga", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "las-palmas", name: "拉斯帕尔马斯", leagueId: "laliga-2", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "real-valladolid", name: "巴利亚多利德", leagueId: "laliga-2", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "deportivo", name: "拉科鲁尼亚", leagueId: "laliga-2", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "racing-santander", name: "桑坦德竞技", leagueId: "laliga-2", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "almeria", name: "阿尔梅里亚", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "zaragoza", name: "萨拉戈萨", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "sporting-gijon", name: "希洪竞技", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "granada", name: "格拉纳达", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "cadiz", name: "加的斯", leagueId: "laliga-2", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "huesca", name: "韦斯卡", leagueId: "laliga-2", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "eibar", name: "埃瓦尔", leagueId: "laliga-2", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "mirandes", name: "米兰德斯", leagueId: "laliga-2", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "inter", name: "国际米兰", leagueId: "serie-a", domRep: 5, contRep: 4, intlRep: 5, rep: 5, rivalId: "ac-milan" },
  { id: "napoli", name: "那不勒斯", leagueId: "serie-a", domRep: 4, contRep: 3, intlRep: 4, rep: 4 },
  { id: "ac-milan", name: "AC米兰", leagueId: "serie-a", domRep: 4, contRep: 3, intlRep: 4, rep: 4, rivalId: "inter" },
  { id: "juventus", name: "尤文图斯", leagueId: "serie-a", domRep: 4, contRep: 4, intlRep: 4, rep: 4, rivalId: "torino" },
  { id: "atalanta", name: "亚特兰大", leagueId: "serie-a", domRep: 3, contRep: 3, intlRep: 4, rep: 3 },
  { id: "roma", name: "罗马", leagueId: "serie-a", domRep: 3, contRep: 3, intlRep: 4, rep: 3, rivalId: "lazio" },
  { id: "lazio", name: "拉齐奥", leagueId: "serie-a", domRep: 2, contRep: 2, intlRep: 3, rep: 2, rivalId: "roma" },
  { id: "fiorentina", name: "佛罗伦萨", leagueId: "serie-a", domRep: 2, contRep: 2, intlRep: 3, rep: 2 },
  { id: "bologna", name: "博洛尼亚", leagueId: "serie-a", domRep: 2, contRep: 2, intlRep: 3, rep: 2 },
  { id: "como", name: "科莫", leagueId: "serie-a", domRep: 3, contRep: 3, intlRep: 2, rep: 3 },
  { id: "torino", name: "都灵", leagueId: "serie-a", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "udinese", name: "乌迪内斯", leagueId: "serie-a", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "genoa", name: "热那亚", leagueId: "serie-a", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "cagliari", name: "卡利亚里", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "sassuolo", name: "萨索洛", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "hellas-verona", name: "维罗纳", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "parma", name: "帕尔马", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "lecce", name: "莱切", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "pisa", name: "比萨", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "cremonese", name: "克雷莫纳", leagueId: "serie-a", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "bayern", name: "拜仁慕尼黑", leagueId: "bundesliga", domRep: 5, contRep: 5, intlRep: 5, rep: 5 },
  { id: "dortmund", name: "多特蒙德", leagueId: "bundesliga", domRep: 4, contRep: 4, intlRep: 4, rep: 4 },
  { id: "rb-leipzig", name: "RB莱比锡", leagueId: "bundesliga", domRep: 3, contRep: 3, intlRep: 3, rep: 3 },
  { id: "stuttgart", name: "斯图加特", leagueId: "bundesliga", domRep: 3, contRep: 3, intlRep: 3, rep: 3 },
  { id: "eintracht", name: "法兰克福", leagueId: "bundesliga", domRep: 3, contRep: 3, intlRep: 3, rep: 3 },
  { id: "freiburg", name: "弗赖堡", leagueId: "bundesliga", domRep: 2, contRep: 2, intlRep: 2, rep: 2 },
  { id: "wolfsburg", name: "沃尔夫斯堡", leagueId: "bundesliga", domRep: 2, contRep: 1, intlRep: 2, rep: 2 },
  { id: "union-berlin", name: "柏林联合", leagueId: "bundesliga", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "werder", name: "云达不莱梅", leagueId: "bundesliga", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "gladbach", name: "门兴格拉德巴赫", leagueId: "bundesliga", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "hoffenheim", name: "霍芬海姆", leagueId: "bundesliga", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "augsburg", name: "奥格斯堡", leagueId: "bundesliga", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "st-pauli", name: "圣保利", leagueId: "bundesliga", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "heidenheim", name: "海登海姆", leagueId: "bundesliga", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "hamburg", name: "汉堡", leagueId: "bundesliga", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "koln", name: "科隆", leagueId: "bundesliga", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "psg", name: "巴黎圣日耳曼", leagueId: "ligue-1", domRep: 5, contRep: 5, intlRep: 5, rep: 5 },
  { id: "marseille", name: "马赛", leagueId: "ligue-1", domRep: 3, contRep: 3, intlRep: 4, rep: 3 },
  { id: "monaco", name: "摩纳哥", leagueId: "ligue-1", domRep: 3, contRep: 3, intlRep: 4, rep: 3 },
  { id: "lille", name: "里尔", leagueId: "ligue-1", domRep: 3, contRep: 2, intlRep: 3, rep: 3 },
  { id: "lyon", name: "里昂", leagueId: "ligue-1", domRep: 2, contRep: 2, intlRep: 3, rep: 2 },
  { id: "nice", name: "尼斯", leagueId: "ligue-1", domRep: 2, contRep: 2, intlRep: 3, rep: 2 },
  { id: "lens", name: "朗斯", leagueId: "ligue-1", domRep: 2, contRep: 2, intlRep: 3, rep: 2 },
  { id: "rennes", name: "雷恩", leagueId: "ligue-1", domRep: 2, contRep: 1, intlRep: 2, rep: 2 },
  { id: "strasbourg", name: "斯特拉斯堡", leagueId: "ligue-1", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "toulouse", name: "图卢兹", leagueId: "ligue-1", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "brest", name: "布雷斯特", leagueId: "ligue-1", domRep: 1, contRep: 1, intlRep: 2, rep: 1 },
  { id: "nantes", name: "南特", leagueId: "ligue-1", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "lorient", name: "洛里昂", leagueId: "ligue-1", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "auxerre", name: "欧塞尔", leagueId: "ligue-1", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "le-havre", name: "勒阿弗尔", leagueId: "ligue-1", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "paris-fc", name: "巴黎FC", leagueId: "ligue-1", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "angers", name: "昂热", leagueId: "ligue-1", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "metz", name: "梅斯", leagueId: "ligue-1", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "porto", name: "波尔图", leagueId: "primeira-liga", domRep: 4, contRep: 3, intlRep: 3, rep: 4 },
  { id: "benfica", name: "本菲卡", leagueId: "primeira-liga", domRep: 4, contRep: 3, intlRep: 3, rep: 4 },
  { id: "sporting-cp", name: "里斯本竞技", leagueId: "primeira-liga", domRep: 4, contRep: 3, intlRep: 3, rep: 4 },
  { id: "braga", name: "布拉加", leagueId: "primeira-liga", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "shanghai-port", name: "上海海港", leagueId: "csl", domRep: 4, contRep: 3, intlRep: 2, rep: 4, rivalId: "shanghai-shenhua" },
  { id: "shanghai-shenhua", name: "上海申花", leagueId: "csl", domRep: 4, contRep: 2, intlRep: 2, rep: 4, rivalId: "shanghai-port" },
  { id: "shandong-taishan", name: "山东泰山", leagueId: "csl", domRep: 4, contRep: 3, intlRep: 2, rep: 4 },
  { id: "chengdu-rongcheng", name: "成都蓉城", leagueId: "csl", domRep: 4, contRep: 2, intlRep: 2, rep: 4 },
  { id: "beijing-guoan", name: "北京国安", leagueId: "csl", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "zhejiang", name: "浙江队", leagueId: "csl", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "tianjin-jinmen", name: "天津津门虎", leagueId: "csl", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "wuhan-three-towns", name: "武汉三镇", leagueId: "csl", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "henan", name: "河南队", leagueId: "csl", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "qingdao-hainiu", name: "青岛海牛", leagueId: "csl", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "dalian-yingbo", name: "大连英博", leagueId: "csl", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "shenzhen-peng-city", name: "深圳新鹏城", leagueId: "csl", domRep: 0, contRep: 0, intlRep: 1, rep: 0 },
  { id: "yunnan-yukun", name: "云南玉昆", leagueId: "csl", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "qingdao-west-coast", name: "青岛西海岸", leagueId: "csl", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "chongqing-tongliang", name: "重庆铜梁龙", leagueId: "csl", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "liaoning-tieren", name: "辽宁铁人", leagueId: "csl", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "guangxi-pingguo", name: "广西平果哈嘹", leagueId: "china-league-one", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "shijiazhuang", name: "石家庄功夫", leagueId: "china-league-one", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "nantong-zhiyun", name: "南通支云", leagueId: "china-league-one", domRep: 2, contRep: 0, intlRep: 1, rep: 2 },
  { id: "changchun-yatai", name: "长春亚泰", leagueId: "china-league-one", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "suzhou-dongwu", name: "苏州东吴", leagueId: "china-league-one", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "yanbian-longding", name: "延边龙鼎", leagueId: "china-league-one", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "wuxi-wugou", name: "无锡吴钩", leagueId: "china-league-one", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "shaanxi-union", name: "陕西联合", leagueId: "china-league-one", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "hubei-istar", name: "湖北青年星", leagueId: "china-league-one", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "dalian-zhixing", name: "大连智行", leagueId: "china-league-one", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
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
  { id: "al-hilal", name: "利雅得新月", leagueId: "saudi-pro-league", domRep: 5, contRep: 4, intlRep: 3, rep: 5, rivalId: "al-nassr" },
  { id: "al-nassr", name: "利雅得胜利", leagueId: "saudi-pro-league", domRep: 4, contRep: 3, intlRep: 3, rep: 4, rivalId: "al-hilal" },
  { id: "al-ittihad", name: "吉达联合", leagueId: "saudi-pro-league", domRep: 4, contRep: 3, intlRep: 3, rep: 4 },
  { id: "al-ahli", name: "吉达国民", leagueId: "saudi-pro-league", domRep: 4, contRep: 3, intlRep: 3, rep: 4 },
  { id: "flamengo", name: "弗拉门戈", leagueId: "brasileirao", domRep: 5, contRep: 5, intlRep: 4, rep: 5, rivalId: "fluminense" },
  { id: "palmeiras", name: "帕尔梅拉斯", leagueId: "brasileirao", domRep: 5, contRep: 5, intlRep: 4, rep: 5, rivalId: "corinthians" },
  { id: "botafogo", name: "博塔弗戈", leagueId: "brasileirao", domRep: 4, contRep: 4, intlRep: 3, rep: 4 },
  { id: "sao-paulo", name: "圣保罗", leagueId: "brasileirao", domRep: 3, contRep: 4, intlRep: 3, rep: 4 },
  { id: "atletico-mineiro", name: "米内罗竞技", leagueId: "brasileirao", domRep: 3, contRep: 4, intlRep: 3, rep: 4 },
  { id: "fluminense", name: "弗鲁米嫩塞", leagueId: "brasileirao", domRep: 3, contRep: 4, intlRep: 3, rep: 4, rivalId: "flamengo" },
  { id: "cruzeiro", name: "克鲁塞罗", leagueId: "brasileirao", domRep: 3, contRep: 3, intlRep: 3, rep: 3 },
  { id: "gremio", name: "格雷米奥", leagueId: "brasileirao", domRep: 3, contRep: 3, intlRep: 3, rep: 3 },
  { id: "internacional", name: "国际队", leagueId: "brasileirao", domRep: 3, contRep: 3, intlRep: 3, rep: 3 },
  { id: "corinthians", name: "科林蒂安", leagueId: "brasileirao", domRep: 3, contRep: 3, intlRep: 3, rep: 3, rivalId: "palmeiras" },
  { id: "bahia", name: "巴伊亚", leagueId: "brasileirao", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "santos", name: "桑托斯", leagueId: "brasileirao", domRep: 2, contRep: 3, intlRep: 2, rep: 3 },
  { id: "fortaleza", name: "福塔莱萨", leagueId: "brasileirao", domRep: 2, contRep: 2, intlRep: 2, rep: 2 },
  { id: "bragantino", name: "布拉甘蒂诺", leagueId: "brasileirao", domRep: 2, contRep: 2, intlRep: 2, rep: 2 },
  { id: "vasco", name: "瓦斯科", leagueId: "brasileirao", domRep: 2, contRep: 2, intlRep: 2, rep: 2 },
  { id: "sport-recife", name: "累西腓体育", leagueId: "brasileirao", domRep: 1, contRep: 1, intlRep: 1, rep: 1 },
  { id: "vitoria", name: "维托利亚", leagueId: "brasileirao", domRep: 1, contRep: 1, intlRep: 1, rep: 1 },
  { id: "ceara", name: "塞阿拉", leagueId: "brasileirao", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "mirassol", name: "米拉索尔", leagueId: "brasileirao", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "juventude", name: "胡文图德", leagueId: "brasileirao", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "athletico-paranaense", name: "巴拉纳竞技", leagueId: "brasileirao-b", domRep: 2, contRep: 2, intlRep: 1, rep: 2 },
  { id: "coritiba", name: "科里蒂巴", leagueId: "brasileirao-b", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "chapecoense", name: "沙佩科恩斯", leagueId: "brasileirao-b", domRep: 1, contRep: 1, intlRep: 1, rep: 1 },
  { id: "goias", name: "戈亚斯", leagueId: "brasileirao-b", domRep: 1, contRep: 0, intlRep: 0, rep: 1 },
  { id: "cuiaba", name: "库亚巴", leagueId: "brasileirao-b", domRep: 1, contRep: 0, intlRep: 0, rep: 1 },
  { id: "criciuma", name: "克里西乌马", leagueId: "brasileirao-b", domRep: 1, contRep: 0, intlRep: 0, rep: 1 },
  { id: "atletico-goianiense", name: "戈亚尼恩斯竞技", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "avai", name: "阿瓦伊", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "america-mineiro", name: "米内罗美洲", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "paysandu", name: "帕伊桑杜", leagueId: "brasileirao-b", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  { id: "river-plate", name: "河床", leagueId: "argentine-primera", domRep: 5, contRep: 4, intlRep: 4, rep: 5, rivalId: "boca-juniors" },
  { id: "boca-juniors", name: "博卡青年", leagueId: "argentine-primera", domRep: 5, contRep: 3, intlRep: 3, rep: 5, rivalId: "river-plate" },
  { id: "racing-club", name: "竞技", leagueId: "argentine-primera", domRep: 3, contRep: 3, intlRep: 3, rep: 3 },
  { id: "estudiantes", name: "拉普拉塔大学生", leagueId: "argentine-primera", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "velez-sarsfield", name: "贝莱斯", leagueId: "argentine-primera", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "independiente", name: "独立", leagueId: "argentine-primera", domRep: 2, contRep: 2, intlRep: 2, rep: 2 },
  { id: "san-lorenzo", name: "圣洛伦索", leagueId: "argentine-primera", domRep: 2, contRep: 2, intlRep: 2, rep: 2 },
  { id: "talleres", name: "塔耶雷斯", leagueId: "argentine-primera", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "newells-old-boys", name: "纽维尔老男孩", leagueId: "argentine-primera", domRep: 1, contRep: 0, intlRep: 0, rep: 1 },
  { id: "argentinos-juniors", name: "阿根廷青年人", leagueId: "argentine-primera", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 荷甲 ──
  { id: "ajax", name: "阿贾克斯", leagueId: "eredivisie", domRep: 3, contRep: 3, intlRep: 4, rep: 3, rivalId: "feijenoord" },
  { id: "psv", name: "埃因霍温", leagueId: "eredivisie", domRep: 4, contRep: 3, intlRep: 4, rep: 4, rivalId: "ajax" },
  { id: "feijenoord", name: "费耶诺德", leagueId: "eredivisie", domRep: 3, contRep: 2, intlRep: 3, rep: 3, rivalId: "ajax" },
  { id: "az-alkmaar", name: "阿尔克马尔", leagueId: "eredivisie", domRep: 2, contRep: 1, intlRep: 2, rep: 2 },
  { id: "twente", name: "特温特", leagueId: "eredivisie", domRep: 1, contRep: 1, intlRep: 1, rep: 1 },
  { id: "heerenveen", name: "海伦芬", leagueId: "eredivisie", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "utrecht", name: "乌德勒支", leagueId: "eredivisie", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "waalwijk", name: "瓦尔韦克", leagueId: "eredivisie", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 土超 ──
  { id: "galatasaray", name: "加拉塔萨雷", leagueId: "super-lig", domRep: 4, contRep: 2, intlRep: 3, rep: 4, rivalId: "fenerbahce" },
  { id: "fenerbahce", name: "费内巴切", leagueId: "super-lig", domRep: 4, contRep: 2, intlRep: 3, rep: 4, rivalId: "galatasaray" },
  { id: "besiktas", name: "贝西克塔斯", leagueId: "super-lig", domRep: 3, contRep: 2, intlRep: 3, rep: 3 },
  { id: "trabzonspor", name: "特拉布宗体育", leagueId: "super-lig", domRep: 2, contRep: 1, intlRep: 2, rep: 2 },
  { id: "basaksehir", name: "巴萨克赛尔", leagueId: "super-lig", domRep: 1, contRep: 1, intlRep: 1, rep: 1 },
  { id: "antalyaspor", name: "安塔利亚体育", leagueId: "super-lig", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 苏超 ──
  { id: "celtic", name: "凯尔特人", leagueId: "scottish-pred", domRep: 3, contRep: 2, intlRep: 3, rep: 3, rivalId: "rangers" },
  { id: "rangers", name: "流浪者", leagueId: "scottish-pred", domRep: 3, contRep: 2, intlRep: 3, rep: 3, rivalId: "celtic" },
  { id: "aberdeen", name: "阿伯丁", leagueId: "scottish-pred", domRep: 1, contRep: 1, intlRep: 1, rep: 1 },
  { id: "hearts", name: "哈茨", leagueId: "scottish-pred", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "hibernian", name: "希伯尼安", leagueId: "scottish-pred", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "ross-county", name: "罗斯郡", leagueId: "scottish-pred", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 希腊超 ──
  { id: "olympiacos", name: "奥林匹亚科斯", leagueId: "greek-super", domRep: 3, contRep: 2, intlRep: 3, rep: 3, rivalId: "panathinaikos" },
  { id: "panathinaikos", name: "帕纳辛纳科斯", leagueId: "greek-super", domRep: 2, contRep: 2, intlRep: 2, rep: 2, rivalId: "olympiacos" },
  { id: "paok", name: "帕奥克", leagueId: "greek-super", domRep: 2, contRep: 1, intlRep: 2, rep: 2 },
  { id: "aek-athens", name: "AEK雅典", leagueId: "greek-super", domRep: 2, contRep: 1, intlRep: 2, rep: 2 },
  { id: "aris", name: "阿里斯", leagueId: "greek-super", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "of-iannina", name: "约阿尼纳", leagueId: "greek-super", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 美职联 ──
  { id: "la-galaxy", name: "洛杉矶银河", leagueId: "mls", domRep: 2, contRep: 0, intlRep: 2, rep: 2 },
  { id: "inter-miami", name: "迈阿密国际", leagueId: "mls", domRep: 2, contRep: 0, intlRep: 3, rep: 2 },
  { id: "ny-red-bulls", name: "纽约红牛", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "seattle-sounders", name: "西雅图海湾人", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "atlanta-united", name: "亚特兰大联", leagueId: "mls", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "charlotte-fc", name: "夏洛特FC", leagueId: "mls", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 墨甲 ──
  { id: "club-america", name: "美洲队", leagueId: "liga-mx", domRep: 3, contRep: 2, intlRep: 3, rep: 3, rivalId: "chivas" },
  { id: "chivas", name: "瓜达拉哈拉", leagueId: "liga-mx", domRep: 3, contRep: 1, intlRep: 3, rep: 3, rivalId: "club-america" },
  { id: "monterrey", name: "蒙特雷", leagueId: "liga-mx", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "tigres", name: "老虎大学", leagueId: "liga-mx", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "pumas", name: "美洲狮", leagueId: "liga-mx", domRep: 1, contRep: 1, intlRep: 1, rep: 1 },
  { id: "atlas", name: "阿特拉斯", leagueId: "liga-mx", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 埃及超 ──
  { id: "al-ahly", name: "阿尔阿赫利", leagueId: "egyptian-pred", domRep: 3, contRep: 2, intlRep: 3, rep: 3, rivalId: "zamalek" },
  { id: "zamalek", name: "扎马雷克", leagueId: "egyptian-pred", domRep: 2, contRep: 1, intlRep: 2, rep: 2, rivalId: "al-ahly" },
  { id: "pyramids-fc", name: "金字塔", leagueId: "egyptian-pred", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "masry", name: "马斯里", leagueId: "egyptian-pred", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "ismaily", name: "伊斯梅利", leagueId: "egyptian-pred", domRep: 1, contRep: 0, intlRep: 0, rep: 1 },
  { id: "ghazl-shehata", name: "加兹勒", leagueId: "egyptian-pred", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 瑞士超 ──
  { id: "young-boys", name: "年轻人", leagueId: "swiss-super", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "basel", name: "巴塞尔", leagueId: "swiss-super", domRep: 3, contRep: 3, intlRep: 3, rep: 3, rivalId: "young-boys" },
  { id: "zurich", name: "苏黎世", leagueId: "swiss-super", domRep: 2, contRep: 1, intlRep: 2, rep: 2 },
  { id: "st-gallen", name: "圣加仑", leagueId: "swiss-super", domRep: 1, contRep: 1, intlRep: 1, rep: 1 },
  { id: "luzern", name: "卢塞恩", leagueId: "swiss-super", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "servette", name: "塞尔维特", leagueId: "swiss-super", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "lausanne", name: "洛桑", leagueId: "swiss-super", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 奥甲 ──
  { id: "salzburg", name: "萨尔茨堡", leagueId: "austrian-bund", domRep: 4, contRep: 3, intlRep: 3, rep: 4 },
  { id: "sturm-graz", name: "格拉茨风暴", leagueId: "austrian-bund", domRep: 3, contRep: 2, intlRep: 2, rep: 3, rivalId: "salzburg" },
  { id: "rapid-vienna", name: "维也纳快速", leagueId: "austrian-bund", domRep: 2, contRep: 1, intlRep: 2, rep: 2 },
  { id: "austria-vienna", name: "奥地利维也纳", leagueId: "austrian-bund", domRep: 2, contRep: 1, intlRep: 2, rep: 2 },
  { id: "lask", name: "林茨", leagueId: "austrian-bund", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "wac", name: "沃尔夫斯贝格", leagueId: "austrian-bund", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 捷克甲 ──
  { id: "slavia-prague", name: "布拉格斯拉维亚", leagueId: "czech-liga", domRep: 3, contRep: 2, intlRep: 2, rep: 3, rivalId: "sparta-prague" },
  { id: "sparta-prague", name: "布拉格斯巴达", leagueId: "czech-liga", domRep: 3, contRep: 2, intlRep: 2, rep: 3, rivalId: "slavia-prague" },
  { id: "viktoria-plzen", name: "比尔森胜利", leagueId: "czech-liga", domRep: 2, contRep: 2, intlRep: 2, rep: 2 },
  { id: "banik-ostrava", name: "俄斯特拉发", leagueId: "czech-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "jablonec", name: "亚布洛内茨", leagueId: "czech-liga", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "bohemians", name: "波希米亚人", leagueId: "czech-liga", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 波兰甲 ──
  { id: "legia-warsaw", name: "华沙莱吉亚", leagueId: "polish-ekstraklasa", domRep: 3, contRep: 2, intlRep: 2, rep: 3 },
  { id: "lech-poznan", name: "波兹南莱赫", leagueId: "polish-ekstraklasa", domRep: 3, contRep: 2, intlRep: 2, rep: 3, rivalId: "pogon-szczecin" },
  { id: "rakow", name: "拉库夫", leagueId: "polish-ekstraklasa", domRep: 2, contRep: 1, intlRep: 2, rep: 2 },
  { id: "pogon-szczecin", name: "什切青波贡", leagueId: "polish-ekstraklasa", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "wisla-krakow", name: "克拉科维斯瓦", leagueId: "polish-ekstraklasa", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "gornik-zabrze", name: "扎布热矿工", leagueId: "polish-ekstraklasa", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
  // ── 乌超 ──
  { id: "shakhtar", name: "顿涅茨克矿工", leagueId: "ukrainian-premier", domRep: 4, contRep: 3, intlRep: 3, rep: 4, rivalId: "dynamo-kyiv" },
  { id: "dynamo-kyiv", name: "基辅迪纳摩", leagueId: "ukrainian-premier", domRep: 4, contRep: 3, intlRep: 3, rep: 4, rivalId: "shakhtar" },
  { id: "zorya", name: "卢甘斯克索黎亚", leagueId: "ukrainian-premier", domRep: 2, contRep: 1, intlRep: 1, rep: 2 },
  { id: "kolos", name: "科洛斯", leagueId: "ukrainian-premier", domRep: 1, contRep: 0, intlRep: 1, rep: 1 },
  { id: "vorskla", name: "沃斯卡拉", leagueId: "ukrainian-premier", domRep: 1, contRep: 0, intlRep: 0, rep: 1 },
  { id: "minai", name: "米奈", leagueId: "ukrainian-premier", domRep: 0, contRep: 0, intlRep: 0, rep: 0 },
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
// Nationality-flavored surnames + given names, picked deterministically from the
// seed so a career's name is reproducible/shareable (identity construction moat).

const SURNAMES: Record<string, readonly string[]> = {
  bra: ["Silva", "Santos", "Souza", "Oliveira", "Costa", "Pereira", "Rodrigues", "Almeida", "Ferreira", "Ribeiro", "Carvalho", "Gomes"],
  arg: ["González", "Rodríguez", "Fernández", "López", "Martínez", "Pérez", "García", "Sánchez", "Romero", "Díaz", "Acosta", "Sosa"],
  fra: ["Martin", "Bernard", "Dubois", "Moreau", "Laurent", "Simon", "Michel", "Garcia", "David", "Bertrand", "Roux", "Vincent"],
  eng: ["Smith", "Jones", "Taylor", "Brown", "Wilson", "Davies", "Evans", "Thomas", "Walker", "White", "Edwards", "Hughes"],
  esp: ["García", "González", "Rodríguez", "Fernández", "López", "Martínez", "Sánchez", "Pérez", "Gómez", "Ruiz", "Jiménez", "Díaz"],
  ger: ["Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner", "Becker", "Schulz", "Hoffmann", "Koch", "Bauer"],
  ita: ["Rossi", "Russo", "Ferrari", "Esposito", "Bianchi", "Romano", "Colombo", "Ricci", "Marino", "Greco", "Bruno", "Gallo"],
  por: ["Silva", "Santos", "Ferreira", "Pereira", "Oliveira", "Costa", "Rodrigues", "Martins", "Sousa", "Fernandes", "Gomes", "Lopes"],
  ned: ["de Jong", "Jansen", "de Vries", "van den Berg", "Bakker", "Visser", "Smit", "Meijer", "de Boer", "Mulder", "Bos", "Peters"],
  bel: ["Peeters", "Janssens", "Maes", "Jacobs", "Mertens", "Willems", "Claes", "Goossens", "Wouters", "De Smet", "Vermeulen", "De Clercq"],
  jpn: ["Tanaka", "Suzuki", "Takahashi", "Watanabe", "Yamamoto", "Sato", "Ito", "Kobayashi", "Yoshida", "Yamada", "Sasaki", "Matsumoto"],
  kor: ["Kim", "Lee", "Park", "Choi", "Jung", "Kang", "Cho", "Yoon", "Jang", "Lim", "Han", "Shin"],
  chn: ["Wang", "Li", "Zhang", "Liu", "Chen", "Yang", "Huang", "Zhao", "Wu", "Zhou", "Xu", "Sun"],
  usa: ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Anderson", "Taylor"],
  mex: ["Hernández", "García", "Martínez", "López", "González", "Pérez", "Rodríguez", "Sánchez", "Ramírez", "Cruz", "Flores", "Rivera"],
  tur: ["Yılmaz", "Kaya", "Demir", "Şahin", "Çelik", "Yıldız", "Yıldırım", "Öztürk", "Aydın", "Özdemir", "Arslan", "Doğan"],
  sco: ["McDonald", "Campbell", "Stewart", "MacLeod", "McKenzie", "Murray", "Taylor", "Wilson", "Fraser", "Reid", "Ross", "Burns"],
  gre: ["Papadopoulos", "Papadimitriou", "Georgiou", "Pappas", "Christou", "Nikolaou", "Ioannou", "Antoniou", "Vlachos", "Dimopoulos", "Stavrou", "Kontos"],
  egy: ["Mohamed", "Ahmed", "Mahmoud", "Ibrahim", "Hassan", "Abdel", "Mostafa", "Khaled", "Omar", "Yousef", "Tarek", "Salem"],
};
const GIVEN: Record<string, readonly string[]> = {
  bra: ["Lucas", "Gabriel", "Matheus", "João", "Pedro", "Bruno", "Rafael", "Felipe", "Vinícius", "Caio", "Diego", "André"],
  arg: ["Lucas", "Mateo", "Santiago", "Matías", "Nicolás", "Tomás", "Juan", "Diego", "Emiliano", "Lautaro", "Joaquín", "Franco"],
  fra: ["Lucas", "Hugo", "Theo", "Nathan", "Léo", "Adam", "Raphaël", "Louis", "Jules", "Gabriel", "Arthur", "Paul"],
  eng: ["Jack", "Harry", "Oliver", "George", "Jacob", "Charlie", "Thomas", "Oscar", "James", "Leo", "Alfie", "Mason"],
  esp: ["Hugo", "Martín", "Lucas", "Daniel", "Pablo", "Diego", "Álvaro", "Adrián", "David", "Iker", "Marco", "Sergio"],
  ger: ["Leon", "Finn", "Paul", "Elias", "Lukas", "Felix", "Jonas", "Maximilian", "Niklas", "Tim", "Julian", "Noah"],
  ita: ["Lorenzo", "Alessandro", "Matteo", "Francesco", "Andrea", "Davide", "Riccardo", "Gabriele", "Marco", "Thomas", "Nicolò", "Federico"],
  por: ["João", "Tiago", "Rui", "André", "Bruno", "Diogo", "Gonçalo", "Rafael", "Pedro", "Miguel", "Fábio", "Daniel"],
  ned: ["Daan", "Sem", "Lucas", "Levi", "Finn", "Bram", "Thijs", "Sven", "Jesse", "Luuk", "Mees", "Stijn"],
  bel: ["Lucas", "Liam", "Noah", "Finn", "Victor", "Arthur", "Matteo", "Kato", "Jules", "Seppe", "Tuur", "Wout"],
  jpn: ["Haruto", "Sōta", "Yūto", "Hiroto", "Kaito", "Riku", "Ren", "Yūki", "Kōki", "Daiki", "Shōgo", "Kazuki"],
  kor: ["Min-jae", "Jae-sung", "Seung-gi", "Tae-woo", "Hwang-in", "Kang-in", "Jae-hyun", "Seo-jin", "Hyun-woo", "Dong-jin", "Sang-min", "Jin-su"],
  chn: ["Hao", "Yuxin", "Zhihao", "Yifan", "Jiahao", "Junyi", "Yunhao", "Tianyu", "Boyang", "Ruoyu", "Zihan", "Mingze"],
  usa: ["Jackson", "Liam", "Noah", "Ethan", "Mason", "Lucas", "Logan", "Caleb", "Jayden", "Ezra", "Miles", "Tyler"],
  mex: ["Mateo", "Santiago", "Matías", "Diego", "Sebastián", "Emiliano", "Leonardo", "Ángel", "Daniel", "Joaquín", "Ricardo", "Fernando"],
  tur: ["Yusuf", "Eymen", "Mehmet", "Ahmet", "Emir", "Ali", "Mustafa", "Burak", "Kerem", "Deniz", "Arda", "Hakan"],
  sco: ["Callum", "Lewis", "Jack", "James", "Logan", "Finlay", "Aaron", "Cameron", "Kyle", "Ryan", "Connor", "Murray"],
  gre: ["Giorgos", "Nikos", "Yannis", "Kostas", "Dimitris", "Christos", "Panagiotis", "Stavros", "Vasilis", "Manos", "Spiros", "Antonis"],
  egy: ["Mohamed", "Ahmed", "Mahmoud", "Omar", "Youssef", "Khaled", "Mostafa", "Amr", "Hassan", "Karim", "Tarek", "Adel"],
};

/** Generate a nationality-flavored player name deterministically from the seed. */
export function generatePlayerName(seed: string, nationalityId: string): string {
  const surnames = SURNAMES[nationalityId] ?? SURNAMES.eng!;
  const givens = GIVEN[nationalityId] ?? GIVEN.eng!;
  const h1 = hashStr(`${seed}:name-surname:${nationalityId}`);
  const h2 = hashStr(`${seed}:name-given:${nationalityId}`);
  const surname = surnames[h1 % surnames.length]!;
  const given = givens[h2 % givens.length]!;
  return `${given} ${surname}`;
}

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

/** Reputation tier → squad base overall (what OVR a team of each tier "expects"). */
export const SQUAD_BASE = [52, 68, 75, 80, 84, 88];

// ───────────────────────────── national teams ─────────────────────────────

export interface Nation {
  id: string;
  name: string;
  confederation: Confederation;
  contRep: number;     // drives continental-cup + WC qualification odds
  fifaRep: number;     // drives World Cup win odds
  intlRep: number;     // drives call-up threshold + squad base
}

export const NATIONS: readonly Nation[] = [
  { id: "esp", name: "西班牙", confederation: "UEFA", contRep: 6, fifaRep: 5, intlRep: 5 },
  { id: "fra", name: "法国", confederation: "UEFA", contRep: 6, fifaRep: 5, intlRep: 5 },
  { id: "ger", name: "德国", confederation: "UEFA", contRep: 5, fifaRep: 5, intlRep: 5 },
  { id: "eng", name: "英格兰", confederation: "UEFA", contRep: 5, fifaRep: 4, intlRep: 5 },
  { id: "ita", name: "意大利", confederation: "UEFA", contRep: 5, fifaRep: 4, intlRep: 4 },
  { id: "por", name: "葡萄牙", confederation: "UEFA", contRep: 5, fifaRep: 3, intlRep: 4 },
  { id: "ned", name: "荷兰", confederation: "UEFA", contRep: 5, fifaRep: 3, intlRep: 4 },
  { id: "bel", name: "比利时", confederation: "UEFA", contRep: 4, fifaRep: 2, intlRep: 4 },
  { id: "cro", name: "克罗地亚", confederation: "UEFA", contRep: 4, fifaRep: 3, intlRep: 3 },
  { id: "den", name: "丹麦", confederation: "UEFA", contRep: 4, fifaRep: 2, intlRep: 3 },
  { id: "sui", name: "瑞士", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 3 },
  { id: "aut", name: "奥地利", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 3 },
  { id: "pol", name: "波兰", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 3 },
  { id: "tur", name: "土耳其", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 3 },
  { id: "swe", name: "瑞典", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 2 },
  { id: "nor", name: "挪威", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 2 },
  { id: "srb", name: "塞尔维亚", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 3 },
  { id: "ukr", name: "乌克兰", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 3 },
  { id: "cze", name: "捷克", confederation: "UEFA", contRep: 3, fifaRep: 1, intlRep: 2 },
  { id: "gre", name: "希腊", confederation: "UEFA", contRep: 2, fifaRep: 1, intlRep: 2 },
  { id: "sco", name: "苏格兰", confederation: "UEFA", contRep: 2, fifaRep: 0, intlRep: 2 },
  { id: "irl", name: "爱尔兰", confederation: "UEFA", contRep: 2, fifaRep: 0, intlRep: 2 },
  { id: "arg", name: "阿根廷", confederation: "CONMEBOL", contRep: 6, fifaRep: 5, intlRep: 5 },
  { id: "bra", name: "巴西", confederation: "CONMEBOL", contRep: 6, fifaRep: 5, intlRep: 5 },
  { id: "uru", name: "乌拉圭", confederation: "CONMEBOL", contRep: 5, fifaRep: 3, intlRep: 4 },
  { id: "col", name: "哥伦比亚", confederation: "CONMEBOL", contRep: 4, fifaRep: 2, intlRep: 3 },
  { id: "chi", name: "智利", confederation: "CONMEBOL", contRep: 4, fifaRep: 1, intlRep: 3 },
  { id: "ecu", name: "厄瓜多尔", confederation: "CONMEBOL", contRep: 3, fifaRep: 1, intlRep: 2 },
  { id: "par", name: "巴拉圭", confederation: "CONMEBOL", contRep: 3, fifaRep: 1, intlRep: 2 },
  { id: "per", name: "秘鲁", confederation: "CONMEBOL", contRep: 3, fifaRep: 0, intlRep: 2 },
  { id: "ven", name: "委内瑞拉", confederation: "CONMEBOL", contRep: 2, fifaRep: 0, intlRep: 1 },
  { id: "bol", name: "玻利维亚", confederation: "CONMEBOL", contRep: 1, fifaRep: 0, intlRep: 1 },
  { id: "jpn", name: "日本", confederation: "AFC", contRep: 5, fifaRep: 1, intlRep: 3 },
  { id: "kor", name: "韩国", confederation: "AFC", contRep: 5, fifaRep: 1, intlRep: 3 },
  { id: "irn", name: "伊朗", confederation: "AFC", contRep: 4, fifaRep: 1, intlRep: 3 },
  { id: "aus", name: "澳大利亚", confederation: "AFC", contRep: 4, fifaRep: 0, intlRep: 2 },
  { id: "ksa", name: "沙特阿拉伯", confederation: "AFC", contRep: 3, fifaRep: 0, intlRep: 2 },
  { id: "qat", name: "卡塔尔", confederation: "AFC", contRep: 3, fifaRep: 0, intlRep: 1 },
  { id: "uzb", name: "乌兹别克斯坦", confederation: "AFC", contRep: 2, fifaRep: 0, intlRep: 1 },
  { id: "irq", name: "伊拉克", confederation: "AFC", contRep: 2, fifaRep: 0, intlRep: 1 },
  { id: "chn", name: "中国", confederation: "AFC", contRep: 1, fifaRep: 0, intlRep: 1 },
  { id: "tha", name: "泰国", confederation: "AFC", contRep: 1, fifaRep: 0, intlRep: 0 },
  { id: "vie", name: "越南", confederation: "AFC", contRep: 1, fifaRep: 0, intlRep: 0 },
  { id: "idn", name: "印度尼西亚", confederation: "AFC", contRep: 0, fifaRep: 0, intlRep: 0 },
  { id: "mar", name: "摩洛哥", confederation: "CAF", contRep: 5, fifaRep: 2, intlRep: 3 },
  { id: "sen", name: "塞内加尔", confederation: "CAF", contRep: 5, fifaRep: 1, intlRep: 3 },
  { id: "egy", name: "埃及", confederation: "CAF", contRep: 4, fifaRep: 1, intlRep: 2 },
  { id: "nga", name: "尼日利亚", confederation: "CAF", contRep: 4, fifaRep: 1, intlRep: 2 },
  { id: "civ", name: "科特迪瓦", confederation: "CAF", contRep: 4, fifaRep: 1, intlRep: 2 },
  { id: "cmr", name: "喀麦隆", confederation: "CAF", contRep: 3, fifaRep: 1, intlRep: 2 },
  { id: "gha", name: "加纳", confederation: "CAF", contRep: 3, fifaRep: 1, intlRep: 2 },
  { id: "alg", name: "阿尔及利亚", confederation: "CAF", contRep: 3, fifaRep: 1, intlRep: 2 },
  { id: "tun", name: "突尼斯", confederation: "CAF", contRep: 3, fifaRep: 0, intlRep: 2 },
  { id: "mex", name: "墨西哥", confederation: "CONCACAF", contRep: 5, fifaRep: 1, intlRep: 3 },
  { id: "usa", name: "美国", confederation: "CONCACAF", contRep: 4, fifaRep: 1, intlRep: 2 },
  { id: "can", name: "加拿大", confederation: "CONCACAF", contRep: 4, fifaRep: 0, intlRep: 2 },
  { id: "crc", name: "哥斯达黎加", confederation: "CONCACAF", contRep: 3, fifaRep: 0, intlRep: 1 },
  { id: "jam", name: "牙买加", confederation: "CONCACAF", contRep: 2, fifaRep: 0, intlRep: 1 },
  { id: "pan", name: "巴拿马", confederation: "CONCACAF", contRep: 2, fifaRep: 0, intlRep: 1 },
  { id: "nzl", name: "新西兰", confederation: "OFC", contRep: 6, fifaRep: 0, intlRep: 1 },
  { id: "fij", name: "斐济", confederation: "OFC", contRep: 2, fifaRep: 0, intlRep: 0 },
];

export function nationById(id: string): Nation {
  const n = NATIONS.find((x) => x.id === id);
  if (!n) throw new Error(`unknown nation: ${id}`);
  return n;
}

// call-up OVR threshold by national team international reputation.
// Decoupled from peak OVR: a near-flat ~70 floor (72 for the very top nations)
// replaces the old 60..83 ladder calibrated to peak ~86. Matches the run.ts
// showdown threshold so call-up and the WC boss event gate on the same OVR.
export const CALLUP_THRESHOLD = [70, 70, 70, 70, 70, 70];

// ───────────────────────────── trophy probability tables ─────────────────────────────
// All indexed by reputation tier 0..5.

/** League title probability (by domestic reputation). */
export const LEAGUE_PROB = [0, 0.008, 0.03, 0.1, 0.18, 0.34];
/** Domestic cup probability (by domestic reputation). */
export const CUP_PROB = [0.005, 0.02, 0.05, 0.11, 0.16, 0.2];
/** Continental primary (Champions League) probability (by continental reputation). */
export const CONT_PRIMARY_PROB = [0, 1e-5, 0.02, 0.04, 0.1, 0.18];
/** Continental secondary probability. */
export const CONT_SECONDARY_PROB = [0, 0.03, 0.09, 0.015, 0, 0];
/** Club World Cup probability (only at eligible ages), per confederation (母本 values). */
export const CWC_PROB = {
  UEFA:      [0, 0, 0.005, 0.05, 0.1, 0.15],
  CONMEBOL:  [0, 0, 0, 0.002, 0.005, 0.012],
  CONCACAF:  [0, 0, 0, 0.0001, 0.0001, 0.0001],
  AFC:       [0, 0, 0, 0.001, 0.003, 0.008],
  CAF:       [0, 0, 0, 0.001, 0.002, 0.005],
  OFC:       [0, 0, 0, 0.0001, 0.0001, 0.0002],
} as const;

// national-team tables
/** National continental cup (Euros/Copa) win probability by continental reputation tier 0..6. */
export const NAT_CONT_PROB = [1e-5, 0.02, 0.05, 0.1, 0.2, 0.3, 0.8];
/** World Cup win probability by fifa reputation tier 0..5. */
export const WC_WIN_PROB = [0.004, 0.008, 0.07, 0.15, 0.26, 0.36];
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
/** Goals-conceded multiplier by domestic reputation (stronger team concedes less). */
export const CONCEDE_MULT = [1.4, 1.3, 1.1, 0.9, 0.7, 0.5];

// ───────────────────────────── development profiles ─────────────────────────────
// Annual OVR delta range [min,max] by profile + target age (even ages 18..44).
// Goalkeepers use a single table regardless of profile.

export type DevProfile = "early" | "normal" | "late" | "wonderkid";

export const DEV_TABLES: Record<DevProfile, Record<number, readonly [number, number]>> = {
  // P-A14: halved the growth ceilings so 90+ is EARNED, not the default. A
  // wonderkid now caps ~90-92 with perfect choices; a normal profile ~80-84.
  // The range FLOOR matters too: a bad season/role can stall growth (min 0 or
  // negative), so benching/injury choices now compound — the butterfly effect.
  early: {
    18: [3, 8], 20: [2, 7], 22: [1, 5], 24: [0, 3], 26: [-2, 1],
    28: [-2, -1], 30: [-2, 0], 32: [-4, 0], 34: [-5, -1], 36: [-6, -1],
    38: [-7, -2], 40: [-9, -3], 42: [-11, -4], 44: [-13, -5],
  },
  normal: {
    18: [2, 7], 20: [1, 7], 22: [1, 5], 24: [0, 4], 26: [0, 2],
    28: [-1, 0], 30: [-1, 0], 32: [-3, 0], 34: [-4, -1], 36: [-5, -1],
    38: [-7, -2], 40: [-9, -3], 42: [-11, -4], 44: [-13, -5],
  },
  late: {
    18: [1, 5], 20: [1, 5], 22: [1, 4], 24: [1, 4], 26: [0, 2],
    28: [0, 1], 30: [0, 1], 32: [-1, 0], 34: [-3, -1], 36: [-4, -1],
    38: [-6, -2], 40: [-8, -3], 42: [-10, -4], 44: [-12, -5],
  },
  wonderkid: {
    // Mechanics review: the old post-P-A14 table ([1,6]/[1,6]/[1,5]/[0,4]/[-1,2])
    // was STRICTLY DOMINATED by `normal` — a 100-legacy trap unlock. Wonderkid
    // is now the HIGH-VARIANCE profile: mean per bracket ≈ normal, but wide
    // ranges — the +9 season that makes a 92 peak possible, and the 0 season
    // that makes 伤仲永 real. Peak target unchanged (~88-92 with luck+choices).
    18: [0, 9], 20: [0, 8], 22: [0, 7], 24: [-1, 5], 26: [-1, 3],
    28: [-1, 0], 30: [-1, 0], 32: [-3, 0], 34: [-4, -1], 36: [-5, -1],
    38: [-7, -2], 40: [-9, -3], 42: [-11, -4], 44: [-13, -5],
  },
};

export const GK_DEV_TABLE: Record<number, readonly [number, number]> = {
  18: [1, 5], 20: [1, 5], 22: [1, 5], 24: [1, 4], 26: [0, 3],
  28: [0, 2], 30: [0, 0], 32: [-1, 0], 34: [-3, -1], 36: [-4, -1],
  38: [-5, -2], 40: [-6, -3], 42: [-7, -3], 44: [-12, -5],
};

export const GK_DEV_FALLBACK: readonly [number, number] = [-12, -5];
export const OUTFIELD_DEV_FALLBACK: readonly [number, number] = [-14, -7];

/** Starter training bonus by club international reputation tier.
 *  P-A161: was [1,1,1,2,2,3] — applied EVERY positive-growth season, it compounded
 *  to +12~+18 OVR over a career alone, pushing avg peak to ~86 and 35% to 90+.
 *  Capped at [1,1,1,1,2,2] (top-end 3→2) so the "big clubs train better" incentive
 *  survives but the per-season bonus is bounded. Combined with the growth-table
 *  trims below, 90+ is EARNED (~15%), not the default — the user's explicit goal:
 *  "OVR提升太轻松，90+要稀缺". */
export const STARTER_TRAIN_BONUS = [1, 1, 1, 1, 2, 2] as const;

// ───────────────────────────── reputation helpers ─────────────────────────────

/** Player star tier for transfer/blockbuster gating: ≥90→3, ≥85→2, ≥80→1, else 0. */
export function starTier(overall: number): number {
  return overall >= 90 ? 3 : overall >= 85 ? 2 : overall >= 80 ? 1 : 0;
}

/** Player reputation tier 0..5 (for transfer targeting), thresholds Ne. */
export function repTier(overall: number): number {
  if (overall >= 87) return 5;
  if (overall >= 83) return 4;
  if (overall >= 78) return 3;
  if (overall >= 73) return 2;
  if (overall >= 65) return 1;
  return 0;
}

/** Star difficulty multiplier: how much a player dominating a competition boosts its odds. */
export function starDifficulty(diff: number): number {
  if (diff >= 10) return 1.6;
  if (diff >= 6) return 1.3;
  if (diff >= 3) return 1.1;
  return 1;
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
