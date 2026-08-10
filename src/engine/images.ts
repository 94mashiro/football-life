// Image asset paths for clubs / leagues / nations / trophies.
//
// Sourced from the copero career-simulator asset library (media.copero.com.ar),
// mirrored locally under /img/... (see docs/copero-reference/README.md for
// provenance, extraction, and the calibration cross-check against our DB).
// The 79 clubs copero doesn't cover (希腊超/瑞士超/奥甲/捷克甲/乌超/埃及超/中甲/巴乙
// + a handful copero skipped) were backfilled from TheSportsDB team badges
// (200×200 PNG, r2.thesportsdb.com), filed as clubs/<CC>/<our club id>.png.
// Resolvers return null when no asset exists — the UI falls back to a monogram
// or placeholder, never a broken <img>. Pure data + lookups; no React, no I/O.
//
// Coverage (our DB -> asset):
//   clubs   305 / 305 have a crest
//   leagues 20 / 28 have a logo + league-trophy (8 leagues copero doesn't cover)
//   nations 61 / 61 have a flag; 47 have a national-team crest (14 fall back)
//   trophies all 7 Trophy kinds resolve (CAF continental_primary is null —
//           copero's CAF data points at a CONCACAF trophy; no CAF CL asset exists)

import type { Trophy, Award } from "./types";

const IMG = "/img";

/** Path passthrough; returns null for unknown / unmapped ids. */
function resolve(map: Readonly<Record<string, string>>, key: string): string | null {
  return map[key] ? `${IMG}/${map[key]}` : null;
}

// ── club crests ──────────────────────────────────────────────────────────
const CLUB_CREST: Readonly<Record<string, string>> = {
  "aberdeen": "clubs/SCO/aberdeen.svg",
  "ac-milan": "clubs/ITA/milan.svg",
  "aek-athens": "clubs/GRE/aek-athens.png",
  "ajax": "clubs/NED/ajax.svg",
  "al-ahli": "clubs/KSA/al-ahli.svg",
  "al-ahly": "clubs/EGY/al-ahly.png",
  "al-hilal": "clubs/KSA/al-hilal.svg",
  "al-ittihad": "clubs/KSA/al-ittihad.svg",
  "al-nassr": "clubs/KSA/al-nassr.svg",
  "alaves": "clubs/ESP/deportivo-alaves.svg",
  "albirex-niigata": "clubs/JPN/albirex-niigata.png",
  "almeria": "clubs/ESP/almeria.svg",
  "america-mineiro": "clubs/BRA/america-mineiro.png",
  "angers": "clubs/FRA/angers.svg",
  "antalyaspor": "clubs/TUR/antalyaspor.png",
  "anyang-fc": "clubs/KOR/anyang.svg",
  "argentinos-juniors": "clubs/ARG/argentinos-juniors.svg",
  "aris": "clubs/GRE/aris.png",
  "arsenal": "clubs/ENG/arsenal.svg",
  "aston-villa": "clubs/ENG/aston-villa.svg",
  "atalanta": "clubs/ITA/atalanta.svg",
  "athletic-bilbao": "clubs/ESP/athletic-club.svg",
  "athletico-paranaense": "clubs/BRA/athletico-paranaense.png",
  "atlanta-united": "clubs/USA/atlanta-united.svg",
  "atlas": "clubs/MEX/atlas.svg",
  "atletico-goianiense": "clubs/BRA/atletico-goianiense.png",
  "atletico-madrid": "clubs/ESP/atletico-madrid.svg",
  "atletico-mineiro": "clubs/BRA/atletico-mineiro.svg",
  "augsburg": "clubs/GER/fc-augsburg.svg",
  "austria-vienna": "clubs/AUT/austria-vienna.png",
  "auxerre": "clubs/FRA/auxerre.svg",
  "avai": "clubs/BRA/avai.png",
  "avispa-fukuoka": "clubs/JPN/avispa-fukuoka.svg",
  "az-alkmaar": "clubs/NED/az.svg",
  "bahia": "clubs/BRA/bahia.svg",
  "banik-ostrava": "clubs/CZE/banik-ostrava.png",
  "barcelona": "clubs/ESP/barcelona.svg",
  "basaksehir": "clubs/TUR/basaksehir.svg",
  "basel": "clubs/SUI/basel.png",
  "bayern": "clubs/GER/fc-bayern-munchen.svg",
  "beijing-guoan": "clubs/CHN/beijing-guoan.svg",
  "benfica": "clubs/POR/benfica.svg",
  "besiktas": "clubs/TUR/besiktas.svg",
  "blackburn": "clubs/ENG/blackburn-rovers.svg",
  "boca-juniors": "clubs/ARG/boca-juniors.svg",
  "bohemians": "clubs/CZE/bohemians.png",
  "bologna": "clubs/ITA/bologna.svg",
  "botafogo": "clubs/BRA/botafogo.svg",
  "bournemouth": "clubs/ENG/bournemouth.svg",
  "braga": "clubs/POR/sporting-braga.svg",
  "bragantino": "clubs/BRA/red-bull-bragantino.svg",
  "brentford": "clubs/ENG/brentford.svg",
  "brest": "clubs/FRA/stade-brestois.svg",
  "brighton": "clubs/ENG/brighton.svg",
  "burnley": "clubs/ENG/burnley.svg",
  "cadiz": "clubs/ESP/cadiz.svg",
  "cagliari": "clubs/ITA/cagliari.svg",
  "cardiff": "clubs/ENG/cardiff.svg",
  "ceara": "clubs/BRA/ceara.png",
  "celta-vigo": "clubs/ESP/celta-vigo.svg",
  "celtic": "clubs/SCO/celtic.svg",
  "cerezo-osaka": "clubs/JPN/cerezo-osaka.svg",
  "changchun-yatai": "clubs/CHN/changchun-yatai.png",
  "chapecoense": "clubs/BRA/chapecoense.png",
  "charlotte-fc": "clubs/USA/charlotte-fc.svg",
  "chelsea": "clubs/ENG/chelsea.svg",
  "chengdu-rongcheng": "clubs/CHN/chengdu-rongcheng.svg",
  "chivas": "clubs/MEX/cd-guadalajara.svg",
  "chongqing-tongliang": "clubs/CHN/tonglianglong.svg",
  "club-america": "clubs/MEX/america.svg",
  "como": "clubs/ITA/como.svg",
  "consadole-sapporo": "clubs/JPN/consadole-sapporo.png",
  "corinthians": "clubs/BRA/corinthians.svg",
  "coritiba": "clubs/BRA/coritiba.png",
  "coventry": "clubs/ENG/coventry-city.svg",
  "cremonese": "clubs/ITA/cremonese.svg",
  "criciuma": "clubs/BRA/criciuma.png",
  "cruzeiro": "clubs/BRA/cruzeiro.svg",
  "crystal-palace": "clubs/ENG/crystal-palace.svg",
  "cuiaba": "clubs/BRA/cuiaba.png",
  "daegu-fc": "clubs/KOR/daegu-fc.png",
  "daejeon-hana": "clubs/KOR/daejeon-hana-citizen.svg",
  "dalian-kuncheng": "clubs/CHN/dalian-kuncheng.png",
  "dalian-yingbo": "clubs/CHN/dalian-yingbo.svg",
  "deportivo": "clubs/ESP/deportivo-la-coruna.svg",
  "dortmund": "clubs/GER/borussia-dortmund.svg",
  "dynamo-kyiv": "clubs/UKR/dynamo-kyiv.png",
  "eibar": "clubs/ESP/eibar.svg",
  "eintracht": "clubs/GER/eintracht-frankfurt.svg",
  "elche": "clubs/ESP/elche.svg",
  "espanyol": "clubs/ESP/espanyol.svg",
  "estudiantes": "clubs/ARG/estudiantes-de-la-plata.svg",
  "everton": "clubs/ENG/everton.svg",
  "fagiano-okayama": "clubs/JPN/fagiano-okayama.svg",
  "fc-seoul": "clubs/KOR/fc-seoul.svg",
  "fc-tokyo": "clubs/JPN/fc-tokyo.svg",
  "feijenoord": "clubs/NED/feyenoord.svg",
  "fenerbahce": "clubs/TUR/fenerbahce.svg",
  "fiorentina": "clubs/ITA/fiorentina.svg",
  "flamengo": "clubs/BRA/flamengo.svg",
  "fluminense": "clubs/BRA/fluminense.svg",
  "fortaleza": "clubs/BRA/fortaleza.png",
  "foshan-nanshi": "clubs/CHN/foshan-nanshi.png",
  "freiburg": "clubs/GER/sc-freiburg.svg",
  "fulham": "clubs/ENG/fulham.svg",
  "galatasaray": "clubs/TUR/galatasaray.svg",
  "gamba-osaka": "clubs/JPN/gamba-osaka.svg",
  "gangwon-fc": "clubs/KOR/gangwon.svg",
  "genoa": "clubs/ITA/genoa.svg",
  "getafe": "clubs/ESP/getafe.svg",
  "ghazl-shehata": "clubs/EGY/ghazl-shehata.png",
  "girona": "clubs/ESP/girona-fc.svg",
  "gladbach": "clubs/GER/borussia-mgladbach.svg",
  "goias": "clubs/BRA/goias.png",
  "gornik-zabrze": "clubs/POL/gornik-zabrze.svg",
  "granada": "clubs/ESP/granada-cf.svg",
  "gremio": "clubs/BRA/gremio.svg",
  "guangxi-pingguo": "clubs/CHN/guangxi-pingguo.png",
  "gwangju-fc": "clubs/KOR/gwangju.svg",
  "hamburg": "clubs/GER/hamburger-sv.svg",
  "hearts": "clubs/SCO/hearts.svg",
  "heerenveen": "clubs/NED/heerenveen.svg",
  "heidenheim": "clubs/GER/heidenheim.png",
  "hellas-verona": "clubs/ITA/hellas-verona.png",
  "henan": "clubs/CHN/henan-songshan-longmen.svg",
  "hibernian": "clubs/SCO/hibernian.svg",
  "hoffenheim": "clubs/GER/tsg-hoffenheim.svg",
  "hubei-istar": "clubs/CHN/hubei-istar.png",
  "huesca": "clubs/ESP/huesca.png",
  "hull": "clubs/ENG/hull-city.svg",
  "incheon-united": "clubs/KOR/incheon-united.svg",
  "independiente": "clubs/ARG/independiente.svg",
  "inter-miami": "clubs/USA/inter-miami.svg",
  "inter": "clubs/ITA/inter.svg",
  "internacional": "clubs/BRA/internacional.svg",
  "ipswich": "clubs/ENG/ipswich-town.svg",
  "ismaily": "clubs/EGY/ismaily.png",
  "jablonec": "clubs/CZE/jablonec.png",
  "jeju-sk": "clubs/KOR/jeju.svg",
  "jeonbuk-hyundai": "clubs/KOR/jeonbuk.svg",
  "juventude": "clubs/BRA/juventude.png",
  "juventus": "clubs/ITA/juventus.svg",
  "kashima-antlers": "clubs/JPN/kashima-antlers.svg",
  "kashiwa-reysol": "clubs/JPN/kashiwa-reysol.svg",
  "kawasaki-frontale": "clubs/JPN/kawasaki-frontale.svg",
  "koln": "clubs/GER/1-fc-koln.svg",
  "kolos": "clubs/UKR/kolos.png",
  "kyoto-sanga": "clubs/JPN/kyoto-sanga.svg",
  "la-galaxy": "clubs/USA/los-angeles-galaxy.svg",
  "las-palmas": "clubs/ESP/las-palmas.svg",
  "lask": "clubs/AUT/lask.png",
  "lausanne": "clubs/SUI/lausanne.png",
  "lazio": "clubs/ITA/lazio.svg",
  "le-havre": "clubs/FRA/le-havre.svg",
  "lecce": "clubs/ITA/lecce.svg",
  "lech-poznan": "clubs/POL/lech-poznan.svg",
  "leeds": "clubs/ENG/leeds-united.svg",
  "legia-warsaw": "clubs/POL/legia-warszawa.svg",
  "leicester": "clubs/ENG/leicester.png",
  "lens": "clubs/FRA/rc-lens.svg",
  "levante": "clubs/ESP/levante-ud.svg",
  "liaoning-tieren": "clubs/CHN/liaoning-tieren.svg",
  "lille": "clubs/FRA/lille.svg",
  "liverpool": "clubs/ENG/liverpool.svg",
  "lorient": "clubs/FRA/lorient.svg",
  "luzern": "clubs/SUI/luzern.png",
  "lyon": "clubs/FRA/olympique-lyonnais.svg",
  "machida-zelvia": "clubs/JPN/machida-zelvia.svg",
  "mallorca": "clubs/ESP/mallorca.svg",
  "man-city": "clubs/ENG/manchester-city.svg",
  "man-utd": "clubs/ENG/manchester-united.svg",
  "marseille": "clubs/FRA/olympique-de-marseille.svg",
  "masry": "clubs/EGY/masry.png",
  "meizhou-hakka": "clubs/CHN/meizhou-hakka.png",
  "metz": "clubs/FRA/metz.svg",
  "middlesbrough": "clubs/ENG/middlesbrough.svg",
  "millwall": "clubs/ENG/millwall.svg",
  "minai": "clubs/UKR/minai.png",
  "mirandes": "clubs/ESP/mirandes.png",
  "mirassol": "clubs/BRA/mirassol.svg",
  "monaco": "clubs/FRA/as-monaco.svg",
  "monterrey": "clubs/MEX/monterrey.svg",
  "nagoya-grampus": "clubs/JPN/nagoya-grampus.svg",
  "nantes": "clubs/FRA/nantes.svg",
  "nantong-zhiyun": "clubs/CHN/nantong-zhiyun.png",
  "napoli": "clubs/ITA/napoli.svg",
  "newcastle": "clubs/ENG/newcastle-united.svg",
  "newells-old-boys": "clubs/ARG/newells-old-boys.svg",
  "nice": "clubs/FRA/nice.svg",
  "norwich": "clubs/ENG/norwich.svg",
  "nottingham": "clubs/ENG/nottingham-forest.svg",
  "ny-red-bulls": "clubs/USA/new-york-rb.svg",
  "of-iannina": "clubs/GRE/of-iannina.png",
  "olympiacos": "clubs/GRE/olympiacos.png",
  "osasuna": "clubs/ESP/osasuna.svg",
  "oviedo": "clubs/ESP/real-oviedo.svg",
  "palmeiras": "clubs/BRA/palmeiras.svg",
  "panathinaikos": "clubs/GRE/panathinaikos.png",
  "paok": "clubs/GRE/paok.png",
  "paris-fc": "clubs/FRA/paris-fc.svg",
  "parma": "clubs/ITA/parma.svg",
  "paysandu": "clubs/BRA/paysandu.png",
  "pisa": "clubs/ITA/pisa.svg",
  "pogon-szczecin": "clubs/POL/pogon-szczecin.svg",
  "pohang-steelers": "clubs/KOR/pohang-steelers.svg",
  "porto": "clubs/POR/porto.svg",
  "preston": "clubs/ENG/preston.svg",
  "psg": "clubs/FRA/paris-saint-germain.svg",
  "psv": "clubs/NED/psv.svg",
  "pumas": "clubs/MEX/pumas.svg",
  "pyramids-fc": "clubs/EGY/pyramids-fc.png",
  "qingdao-hainiu": "clubs/CHN/qingdao-hainiu.svg",
  "qingdao-west-coast": "clubs/CHN/qingdao-west-coast.svg",
  "qpr": "clubs/ENG/qpr.svg",
  "racing-club": "clubs/ARG/racing-club.svg",
  "racing-santander": "clubs/ESP/racing-santander.svg",
  "rakow": "clubs/POL/rakow-czestochowa.svg",
  "rangers": "clubs/SCO/rangers.svg",
  "rapid-vienna": "clubs/AUT/rapid-vienna.png",
  "rayo-vallecano": "clubs/ESP/rayo-vallecano.svg",
  "rb-leipzig": "clubs/GER/rb-leipzig.svg",
  "real-betis": "clubs/ESP/real-betis.svg",
  "real-madrid": "clubs/ESP/real-madrid.svg",
  "real-sociedad": "clubs/ESP/real-sociedad.svg",
  "real-valladolid": "clubs/ESP/valladolid.svg",
  "rennes": "clubs/FRA/stade-rennais.svg",
  "river-plate": "clubs/ARG/river-plate.svg",
  "roma": "clubs/ITA/roma.svg",
  "ross-county": "clubs/SCO/ross-county.png",
  "salzburg": "clubs/AUT/salzburg.png",
  "san-lorenzo": "clubs/ARG/san-lorenzo.svg",
  "sanfrecce-hiroshima": "clubs/JPN/sanfrecce-hiroshima.svg",
  "santos": "clubs/BRA/santos.svg",
  "sao-paulo": "clubs/BRA/sao-paulo.svg",
  "sassuolo": "clubs/ITA/sassuolo.svg",
  "seattle-sounders": "clubs/USA/seattle-sounders.svg",
  "servette": "clubs/SUI/servette.png",
  "sevilla": "clubs/ESP/sevilla.svg",
  "shaanxi-union": "clubs/CHN/shaanxi-union.png",
  "shakhtar": "clubs/UKR/shakhtar.png",
  "shandong-taishan": "clubs/CHN/shandong-taishan.svg",
  "shanghai-port": "clubs/CHN/shanghai-port.svg",
  "shanghai-shenhua": "clubs/CHN/shanghai-shenhua.svg",
  "shenzhen-peng-city": "clubs/CHN/shenzhen-xinpengcheng.svg",
  "shijiazhuang": "clubs/CHN/shijiazhuang.png",
  "shimizu-s-pulse": "clubs/JPN/shimizu-s-pulse.svg",
  "shonan-bellmare": "clubs/JPN/shonan-bellmare.png",
  "slavia-prague": "clubs/CZE/slavia-prague.png",
  "southampton": "clubs/ENG/southampton.svg",
  "sparta-prague": "clubs/CZE/sparta-prague.png",
  "sport-recife": "clubs/BRA/sport-recife.png",
  "sporting-cp": "clubs/POR/sporting-lisboa.svg",
  "sporting-gijon": "clubs/ESP/sporting-gijon.svg",
  "st-gallen": "clubs/SUI/st-gallen.png",
  "st-pauli": "clubs/GER/st-pauli.png",
  "stoke": "clubs/ENG/stoke-city.svg",
  "strasbourg": "clubs/FRA/rc-strasbourg.svg",
  "sturm-graz": "clubs/AUT/sturm-graz.png",
  "stuttgart": "clubs/GER/vfb-stuttgart.svg",
  "sunderland": "clubs/ENG/sunderland.svg",
  "suwon-fc": "clubs/KOR/suwon-fc.png",
  "suzhou-dongwu": "clubs/CHN/suzhou-dongwu.png",
  "swansea": "clubs/ENG/swansea.svg",
  "talleres": "clubs/ARG/talleres.svg",
  "tianjin-jinmen": "clubs/CHN/tianjin-jinmen-tiger.svg",
  "tigres": "clubs/MEX/tigres-uanl.svg",
  "tokyo-verdy": "clubs/JPN/tokyo-verdy.svg",
  "torino": "clubs/ITA/torino.svg",
  "tottenham": "clubs/ENG/tottenham.svg",
  "toulouse": "clubs/FRA/toulouse.svg",
  "trabzonspor": "clubs/TUR/trabzonspor.svg",
  "twente": "clubs/NED/twente.svg",
  "udinese": "clubs/ITA/udinese.svg",
  "ulsan-hd": "clubs/KOR/ulsan-hd.svg",
  "union-berlin": "clubs/GER/1-fc-union-berlin.svg",
  "urawa-reds": "clubs/JPN/urawa-reds.svg",
  "utrecht": "clubs/NED/utrecht.svg",
  "valencia": "clubs/ESP/valencia.svg",
  "vasco": "clubs/BRA/vasco-da-gama.svg",
  "velez-sarsfield": "clubs/ARG/velez-sarsfield.svg",
  "viktoria-plzen": "clubs/CZE/viktoria-plzen.png",
  "villarreal": "clubs/ESP/villarreal.svg",
  "vissel-kobe": "clubs/JPN/vissel-kobe.svg",
  "vitoria": "clubs/BRA/vitoria.svg",
  "vorskla": "clubs/UKR/vorskla.png",
  "waalwijk": "clubs/NED/waalwijk.png",
  "wac": "clubs/AUT/wac.png",
  "watford": "clubs/ENG/watford.svg",
  "werder": "clubs/GER/sv-werder-bremen.svg",
  "west-brom": "clubs/ENG/west-brom.svg",
  "west-ham": "clubs/ENG/west-ham.svg",
  "wisla-krakow": "clubs/POL/wisla-krakow.svg",
  "wolfsburg": "clubs/GER/wolfsburg.png",
  "wolves": "clubs/ENG/wolverhampton.svg",
  "wuhan-three-towns": "clubs/CHN/wuhan-three-towns.svg",
  "wuxi-wugou": "clubs/CHN/wuxi-wugou.png",
  "yanbian-longding": "clubs/CHN/yanbian-longding.png",
  "yokohama-marinos": "clubs/JPN/yokohama-f-marinos.svg",
  "young-boys": "clubs/SUI/young-boys.png",
  "yunnan-yukun": "clubs/CHN/yunnan-yukun.svg",
  "zamalek": "clubs/EGY/zamalek.png",
  "zaragoza": "clubs/ESP/zaragoza.png",
  "zhejiang": "clubs/CHN/zhejiang-professional.svg",
  "zorya": "clubs/UKR/zorya.png",
  "zurich": "clubs/SUI/zurich.png",
};

/** Local URL to a club's crest, or null (use a monogram fallback). */
export function clubCrestPath(clubId: string): string | null {
  return resolve(CLUB_CREST, clubId);
}

// ── leagues: logo, league-title trophy, domestic-cup trophy ──────────────
const LEAGUE_LOGO: Readonly<Record<string, string>> = {
  "argentine-primera": "leagues/ARG/liga-profesional.svg",
  "brasileirao": "leagues/BRA/brasileirao.svg",
  "bundesliga": "leagues/GER/bundesliga.svg",
  "championship": "leagues/ENG/championship.svg",
  "csl": "leagues/CHN/csl-china.svg",
  "eredivisie": "leagues/NED/eredivisie-iso.svg",
  "j1-league": "leagues/JPN/j1-league.svg",
  "k-league-1": "leagues/KOR/k-league-1.svg",
  "laliga-2": "leagues/ESP/segunda-division.svg",
  "laliga": "leagues/ESP/laliga.svg",
  "liga-mx": "leagues/MEX/liga-mx.svg",
  "ligue-1": "leagues/FRA/ligue-1.svg",
  "mls": "leagues/USA/mls.svg",
  "polish-ekstraklasa": "leagues/POL/ekstraklasa.svg",
  "premier-league": "leagues/ENG/premier-league.svg",
  "primeira-liga": "leagues/POR/primeira-liga.svg",
  "saudi-pro-league": "leagues/KSA/ksa-saudi-pro-league.svg",
  "scottish-pred": "leagues/SCO/scottish-premiership.png",
  "serie-a": "leagues/ITA/serie-a.svg",
  "super-lig": "leagues/TUR/superliga-turquia.svg",
};
const LEAGUE_TROPHY: Readonly<Record<string, string>> = {
  "argentine-primera": "trophies/national/ARG/liga-profesional.png",
  "brasileirao": "trophies/national/BRA/brasileirao.png",
  "bundesliga": "trophies/national/GER/bundesliga.png",
  "championship": "trophies/national/ENG/championship.webp",
  "csl": "trophies/national/CHN/csl.png",
  "eredivisie": "trophies/national/NED/eredivisie.png",
  "j1-league": "trophies/national/JPN/j-league.png",
  "k-league-1": "trophies/national/KOR/k-league-1.png",
  "laliga-2": "trophies/national/ESP/la-liga-2.png",
  "laliga": "trophies/national/ESP/la-liga.png",
  "liga-mx": "trophies/national/MEX/liga-mx.png",
  "ligue-1": "trophies/national/FRA/ligue-1.png",
  "mls": "trophies/national/USA/mls.png",
  "polish-ekstraklasa": "trophies/national/POL/polish-cup.png",
  "premier-league": "trophies/national/ENG/premier-league.png",
  "primeira-liga": "trophies/national/POR/primeira-liga.svg",
  "saudi-pro-league": "trophies/national/KSA/saudi-pro-league.png",
  "scottish-pred": "trophies/national/SCO/scottish-premiership.png",
  "serie-a": "trophies/national/ITA/serie-a.png",
  "super-lig": "trophies/national/TUR/turkey-league.png",
};
const DOMESTIC_CUP: Readonly<Record<string, string>> = {
  "argentine-primera": "trophies/national/ARG/copa-argentina.png",
  "brasileirao": "trophies/national/BRA/copa-do-brasil.png",
  "bundesliga": "trophies/national/GER/dfb-pokal.png",
  "championship": "trophies/national/ENG/fa-cup.png",
  "csl": "trophies/national/CHN/cfa-cup.png",
  "eredivisie": "trophies/national/NED/knvb-becker.png",
  "k-league-1": "trophies/national/KOR/korea-cup.png",
  "laliga-2": "trophies/national/ESP/copa-del-rey.png",
  "laliga": "trophies/national/ESP/copa-del-rey.png",
  "liga-mx": "trophies/national/MEX/copa-mx.png",
  "ligue-1": "trophies/national/FRA/coupe-de-france.png",
  "mls": "trophies/national/USA/us-open-cup.png",
  "polish-ekstraklasa": "trophies/national/POL/polish-cup.png",
  "premier-league": "trophies/national/ENG/fa-cup.png",
  "primeira-liga": "trophies/national/POR/taca-portugal.png",
  "saudi-pro-league": "trophies/national/KSA/kings-cup.png",
  "scottish-pred": "trophies/national/SCO/scottish-cup.png",
  "serie-a": "trophies/national/ITA/coppa-italia.png",
  "super-lig": "trophies/national/TUR/turkey-cup.png",
};

/** League competition logo (e.g. Premier League crest), or null. */
export function leagueLogoPath(leagueId: string): string | null {
  return resolve(LEAGUE_LOGO, leagueId);
}
/** Trophy for winning the league title — a generated one if copero has none. */
export function leagueTrophyPath(leagueId: string): string {
  return resolve(LEAGUE_TROPHY, leagueId) ?? GEN(`league-${leagueId}`);
}
/** Domestic cup trophy for a league's country — generated if copero has none. */
export function domesticCupPath(leagueId: string): string {
  return resolve(DOMESTIC_CUP, leagueId) ?? GEN(`cup-${leagueId}`);
}

// ── nations: flag + national-team crest ───────────────────────────────────
const NATION_FLAG: Readonly<Record<string, string>> = {
  "alg": "flags/dz.svg",
  "arg": "flags/ar.svg",
  "aus": "flags/au.svg",
  "aut": "flags/at.svg",
  "bel": "flags/be.svg",
  "bol": "flags/bo.svg",
  "bra": "flags/br.svg",
  "can": "flags/ca.svg",
  "chi": "flags/cl.svg",
  "chn": "flags/cn.svg",
  "civ": "flags/ci.svg",
  "cmr": "flags/cm.svg",
  "col": "flags/co.svg",
  "crc": "flags/cr.svg",
  "cro": "flags/hr.svg",
  "cze": "flags/cz.svg",
  "den": "flags/dk.svg",
  "ecu": "flags/ec.svg",
  "egy": "flags/eg.svg",
  "eng": "flags/gb-eng.svg",
  "esp": "flags/es.svg",
  "fij": "flags/fj.svg",
  "fra": "flags/fr.svg",
  "ger": "flags/de.svg",
  "gha": "flags/gh.svg",
  "gre": "flags/gr.svg",
  "idn": "flags/id.svg",
  "irl": "flags/ie.svg",
  "irn": "flags/ir.svg",
  "irq": "flags/iq.svg",
  "ita": "flags/it.svg",
  "jam": "flags/jm.svg",
  "jpn": "flags/jp.svg",
  "kor": "flags/kr.svg",
  "ksa": "flags/sa.svg",
  "mar": "flags/ma.svg",
  "mex": "flags/mx.svg",
  "ned": "flags/nl.svg",
  "nga": "flags/ng.svg",
  "nor": "flags/no.svg",
  "nzl": "flags/nz.svg",
  "pan": "flags/pa.svg",
  "par": "flags/py.svg",
  "per": "flags/pe.svg",
  "pol": "flags/pl.svg",
  "por": "flags/pt.svg",
  "qat": "flags/qa.svg",
  "sco": "flags/gb-sct.svg",
  "sen": "flags/sn.svg",
  "srb": "flags/rs.svg",
  "sui": "flags/ch.svg",
  "swe": "flags/se.svg",
  "tha": "flags/th.svg",
  "tun": "flags/tn.svg",
  "tur": "flags/tr.svg",
  "ukr": "flags/ua.svg",
  "uru": "flags/uy.svg",
  "usa": "flags/us.svg",
  "uzb": "flags/uz.svg",
  "ven": "flags/ve.svg",
  "vie": "flags/vn.svg",
};
const NATION_CREST: Readonly<Record<string, string>> = {
  "alg": "national/ALG.svg",
  "arg": "national/ARG.svg",
  "aus": "national/AUS.svg",
  "aut": "national/AUT.svg",
  "bel": "national/BEL.svg",
  "bol": "national/BOL.svg",
  "bra": "national/BRA.svg",
  "can": "national/CAN.svg",
  "chi": "national/CHI.svg",
  "chn": "national/CHN.svg",
  "civ": "national/CIV.svg",
  "col": "national/COL.svg",
  "crc": "national/CRC.svg",
  "cro": "national/CRO.svg",
  "cze": "national/CZE.svg",
  "ecu": "national/ECU.svg",
  "egy": "national/EGY.svg",
  "esp": "national/ESP.svg",
  "fra": "national/FRA.svg",
  "ger": "national/GER.svg",
  "irl": "national/IRL.svg",
  "irn": "national/IRN.svg",
  "irq": "national/IRQ.svg",
  "ita": "national/ITA.svg",
  "kor": "national/KOR.svg",
  "ksa": "national/KSA.svg",
  "mar": "national/MAR.svg",
  "mex": "national/MEX.svg",
  "ned": "national/NED.svg",
  "nor": "national/NOR.svg",
  "nzl": "national/NZL.svg",
  "pan": "national/PAN.svg",
  "par": "national/PAR.svg",
  "per": "national/PER.svg",
  "por": "national/POR.svg",
  "qat": "national/QAT.svg",
  "sen": "national/SEN.svg",
  "sui": "national/SUI.svg",
  "swe": "national/SWE.svg",
  "tun": "national/TUN.svg",
  "tur": "national/TUR.svg",
  "uru": "national/URU.svg",
  "usa": "national/USA.svg",
  "uzb": "national/UZB.svg",
  "ven": "national/VEN.svg",
};

/** National flag, or null. */
export function nationFlagPath(nationId: string): string | null {
  return resolve(NATION_FLAG, nationId);
}
/** National-team crest (FA badge), or null (use the flag as fallback). */
export function nationCrestPath(nationId: string): string | null {
  return resolve(NATION_CREST, nationId);
}

// ── continental + world trophies (per confederation) ──────────────────────
const CONTINENTAL: Readonly<Record<string, Readonly<{ primary: string | null; secondary: string | null; national: string | null }>>> = {
  UEFA: { primary: "/img/trophies/international/UEFA/champions-league.png", secondary: "/img/trophies/international/UEFA/europa-league.png", national: "/img/trophies/international/UEFA/euro.svg" },
  CONMEBOL: { primary: "/img/trophies/international/CONMEBOL/libertadores.png", secondary: "/img/trophies/international/CONMEBOL/copa-sudamericana.png", national: "/img/trophies/international/CONMEBOL/copa-america.png" },
  CONCACAF: { primary: "/img/trophies/international/CONCACAF/concachampions.svg", secondary: null, national: "/img/trophies/international/CONCACAF/gold-cup.svg" },
  AFC: { primary: "/img/trophies/international/AFC/champions-league-elite.png", secondary: null, national: "/img/trophies/international/AFC/asian-cup.svg" },
  CAF: { primary: null, secondary: null, national: "/img/trophies/international/CAF/afcon.svg" },
  OFC: { primary: null, secondary: null, national: "/img/trophies/international/OFC/nations-cup.png" },
};

/** Continental club trophy: primary = Champions League / Libertadores / etc.,
 *  secondary = Europa League / Sudamericana / etc. Confederations without a
 *  shipped asset (CAF/OFC/…) fall back to a generated cup. */
export function continentalTrophyPath(confederation: string, kind: "primary" | "secondary"): string {
  return CONTINENTAL[confederation]?.[kind] ?? GEN(`cont-${confederation}-${kind}`);
}
/** National continental trophy (Euros / Copa América / Nations Cup / …), or null. */
export function nationalContinentalTrophyPath(confederation: string): string | null {
  return CONTINENTAL[confederation]?.national ?? null;
}

/** Procedurally-drawn trophies for competitions copero ships no asset for —
 *  generated by `scripts/gen-trophies.mjs` (silhouette/handles/enamel band all
 *  derive from the competition id, so each one is its own trophy rather than a
 *  shared placeholder). Regenerate after adding leagues. */
const GEN = (name: string) => `/img/trophies/gen/${name}.svg`;
/** Last-resort trophy — only reached by a competition added after the last
 *  `gen-trophies.mjs` run. */
export const GENERIC_TROPHY_PATH = GEN("generic");
/** FIFA World Cup trophy. */
export const WORLD_CUP_PATH = `/img/trophies/international/FIFA/world-cup.png`;
/** FIFA Club World Cup trophy. */
export const CLUB_WORLD_CUP_PATH = `/img/trophies/international/FIFA/club-world-cup.png`;

// ── individual awards (Ballon d'Or / Golden Boot / Glove + regional ceiling) ──
// Trophy-art PNGs mirrored from the 足一把 career-sim asset library
// (career-sim.pages.dev/assets/trophies/) — real trophy photographs on a
// transparent ground, ~160px tall, so personal honors read as实物 the way
// the cup trophies do, not as a flat text/emoji pill. boot.png is shared by
// golden_boot (欧洲金靴) and csl_boot (中超金靴) — both are golden-boot
// objects; the label distinguishes the tier.
const AWARD_IMG: Readonly<Record<Award, string>> = {
  ballon_dor: "awards/ballon.png",
  golden_boot: "awards/boot.png",
  golden_glove: "awards/glove.png",
  csl_mvp: "awards/best.png",
  csl_boot: "awards/boot.png",
  afc_poy: "awards/afc-poy.png",
};
/** Image for an individual award (Ballon d'Or / Golden Boot / Glove / 中超最佳
 *  / 中超金靴 / 亚洲足球先生). Never null — every award has a shipped asset. */
export function awardImgPath(a: Award): string {
  return `${IMG}/${AWARD_IMG[a]}`;
}

/** Resolve a won-trophy image for a badge. `leagueId` is required for the
 *  per-league domestic title/cup (each league has its own trophy image);
 *  `conf` for continental club trophies; `natConf` (falls back to `conf`)
 *  for the national continental cup (Euros/Copa América/…). Never returns
 *  null — competitions copero ships no asset for (e.g. the CAF Champions
 *  League) fall back to GENERIC_TROPHY_PATH, so every honor gets a trophy
 *  image rather than a bare label. */
export function trophyPath(t: Trophy, conf: string, leagueId?: string, natConf?: string): string {
  return trophyAsset(t, conf, leagueId, natConf) ?? GENERIC_TROPHY_PATH;
}
function trophyAsset(t: Trophy, conf: string, leagueId?: string, natConf?: string): string | null {
  switch (t) {
    case "league": return leagueId ? leagueTrophyPath(leagueId) : null;
    case "cup": return leagueId ? domesticCupPath(leagueId) : null;
    case "continental_primary": return continentalTrophyPath(conf, "primary");
    case "continental_secondary": return continentalTrophyPath(conf, "secondary");
    case "national_continental": return nationalContinentalTrophyPath(natConf ?? conf);
    case "world_cup": return WORLD_CUP_PATH;
    case "club_world_cup": return CLUB_WORLD_CUP_PATH;
  }
}
