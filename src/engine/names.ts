/**
 * Player-name generation — nationality-authentic names.
 *
 * Each nation has a `NameSpec` describing HOW its names are assembled (which
 * order, which separators, which optional components) and the native-script
 * component pools to draw from. A single configurable `assembleName` then
 * builds the full name deterministically from the seed.
 *
 * Six writing systems, four structural families:
 *  - A. CJK / Vietnamese — surname FIRST (Korean: no space; Vietnamese: middle
 *    name). Scripts: Hanzi / Kanji / Hangul / Quốc-ngữ.
 *  - B. Hispanic double-surname — given (+2nd given) + paternal + maternal.
 *  - C. Lusophone double-surname — given (+2nd) + maternal + paternal (order
 *    reversed vs. Spanish; Brazilian shirt names often drop to one surname).
 *  - D. Single-surname — given (+2nd given) + surname. Covers English/French/
 *    German/Italian/Dutch/Nordic/Slavic(latin)/Arabic(latin)/Persian(latin)/
 *    Thai(latin)/English-diaspora. Same template as the old generator; only the
 *    pools change.
 *
 * Determinism (sacred): `player.name` is cosmetic — it NEVER feeds any `derive`
 * stream, so a career's outcomes (transfers/trophies/retirement) are identical
 * regardless of the name printed on the shirt. Each component draws from its
 * OWN independent `hashStr` stream tagged `${seed}:name-${key}:${nat}:${i}`,
 * so adding/removing/reordering one component never perturbs another — the
 * same property as `rng.ts`'s `derive()`. `hashStr` is duplicated here (vs.
 * `data.ts`) deliberately to keep this module dependency-free (no import
 * cycle) — it is a 6-line FNV-1a, the same algorithm.
 *
 * Frequency weights come from national statistics bodies (公安部 / 明治安田生命 /
 * 대법원 / INE / INSEE / ONS / SSA … — see research/player-names-research.md).
 * Name lists are facts, not copyrightable; we take frequency facts only and
 * build our own weighted pools. Male-frequency pools only: the game has no
 * gender axis (players are implicitly male footballers), so given-name pools
 * are male-name charts.
 *
 * Nations without an explicit spec fall back to a confederation-appropriate
 * real pool (UEFA→eng, CONMEBOL→arg, AFC→jpn, CAF→sen, CONCACAF→mex, OFC→eng)
 * — see `fallbackSpec`. This keeps every one of the 61 nations from ever
 * producing a generic English "Jack Smith": low-frequency nations at least
 * get a same-region, same-cultural-sphere real name.
 */
// Pure data + pure functions. No React, no DOM, no RNG module, no side effects.

// ───────────────────────────── deterministic hash ─────────────────────────────
// FNV-1a → xor of low bits. Duplicated from data.ts (kept local so this module
// stays dependency-free; the algorithm is identical). Returns a non-zero u32.
function hashStr(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0 || 1;
}

// ───────────────────────────── types ─────────────────────────────

/** A component pool. `weights` are relative frequency ratios (same length as
 *  `items`); omitted → uniform. */
export interface NamePool {
  readonly items: readonly string[];
  readonly weights?: readonly number[];
}

/** One slot in a name's assembly order (surname / given / 2nd-given / paternal /
 *  maternal / middle …). */
export interface NameComponent {
  readonly key: string;
  readonly pool: NamePool;
  /** May be dropped (e.g. Spanish maternal surname, Chinese 2nd given char). */
  readonly optional?: boolean;
  /** Inclusion probability 0..1 when `optional` (default 1). */
  readonly probability?: number;
  /** Separator inserted BEFORE this component (default " "; Korean given ""). */
  readonly join?: string;
}

/** One nation's name recipe. */
export interface NameSpec {
  readonly family: "A" | "B" | "C" | "D";
  readonly script: "native" | "latin";
  /** Assembly order; surname-first nations put `surname` first. */
  readonly order: readonly NameComponent[];
}

// ───────────────────────────── assembly ─────────────────────────────

/** Weighted pick from a pool; uniform when no weights. Pools are tiny (≤~30
 *  items) and a name is generated once per career, so the O(n) accumulation is
 *  negligible. */
function weightedPick(pool: NamePool, h: number): string {
  const items = pool.items;
  const w = pool.weights;
  if (!w || w.length === 0) return items[h % items.length]!;
  let total = 0;
  for (const x of w) total += x;
  let r = (h / 4294967296) * total;
  for (let i = 0; i < items.length; i++) {
    r -= w[i] ?? 0;
    if (r < 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

/** Assemble a name from an ordered component list, deterministically from the
 *  seed. Each component draws from its own tagged hash stream so the streams
 *  are independent and reproducible regardless of sibling components. */
function assembleName(seed: string, nat: string, order: readonly NameComponent[], retry = 0): string {
  let out = "";
  for (let i = 0; i < order.length; i++) {
    const c = order[i]!;
    if (c.optional) {
      const pr = hashStr(`${seed}:name-${c.key}-opt:${nat}:${i}${retry ? ":" + retry : ""}`) / 4294967296;
      if (pr >= (c.probability ?? 1)) continue;
    }
    const h = hashStr(`${seed}:name-${c.key}:${nat}:${i}${retry ? ":" + retry : ""}`);
    const pick = weightedPick(c.pool, h);
    out += (i === 0 ? "" : (c.join ?? " ")) + pick;
  }
  return out || "Player";
}

// ───────────────────────────── spec table (44 nations) ─────────────────────────────

const pool = (items: readonly string[], weights?: readonly number[]): NamePool =>
  weights ? { items, weights } : { items };

// ── Family A: CJK / Vietnamese — surname FIRST ──
// chn/jpn/kor pools are RECOMBINED REAL-FOOTBALLER FRAGMENTS (Wikidata SPARQL pull
// of each nation's top-100 footballers, split into surname/given). A's surname +
// B's given → a plausible native name with football-fan resonance that NEVER
// reproduces a single real player's full name. See scripts/names-gen-cjk.py.
// Given fragments are kept whole (圭佑/磊/继海 — the player's actual given name),
// not split to single chars, preserving footballer-name cadence.
const A_CHN: NameSpec = {
  family: "A", script: "native",
  // 88/100 China internationals split; surname weights from 公安部 百家姓.
  order: [
    { key: "surname", pool: pool(
      ["王","李","张","刘","陈","杨","赵","黄","周","吴","徐","孙","马","朱","胡","郭","何","高","林","罗","郑","梁","谢","宋","唐","许","韩","冯","邓","曹","彭","曾","董","袁","潘","于","蒋","蔡","余","杜","叶","程","苏","魏","吕","丁","任","沈","姚","卢"],
      [7.0,6.8,6.5,5.4,5.2,3.2,2.7,2.4,2.3,2.2,1.7,1.6,1.4,1.3,1.3,1.2,1.1,1.0,0.9,0.8,0.7,0.6,0.6,0.5,0.5,0.5,0.5,0.4,0.4,0.4,0.4,0.4,0.4,0.3,0.3,0.3,0.3,0.3,0.3,0.3,0.3,0.3,0.3,0.2,0.2,0.2,0.2,0.2,0.2,0.2,0.2],
    ) },
    { key: "given", pool: pool(["智","磊","明","芳卓","继海","雯","秀全","海东","光太","玮锋","琳芃","志毅","佳一","俊闵","宁","林","铁","婉婷","呈栋","琦","玉宁","海","明宇","恩华","大雷","诚","祥","霜","云龙","波","大宝","威","旭","津","旭日","准翼","海滨","霄鹏","俊哲","潇霆","进安","鹏","金羽","稀哲","世豪","靖斌","晨","楚良","璞","骏凌","洪波","宏","至鹏","曦","方","承瑛","博文","茂臻","爱玲","昂","可","上源","珊珊","辰杰","力生","卓翔","尧","鸿辉","昊","汉超","建业","影","睿","根伟","涛","肇钧","航","彬彬","丽","立靖","柯","广沪","挺","晓旭","慧康"]), join: "" },
  ],
};
const A_JPN: NameSpec = {
  family: "A", script: "native",
  // 71/100 Japan internationals split; kanji surnames + given kept whole.
  order: [
    { key: "surname", pool: pool(["中田","酒井","武藤","中村","鈴木","本田","長友","岡崎","南野","遠藤","大迫","吉田","三浦","清武","釜本","内田","川島","宇佐美","浅野","大久保","中澤","今野","川口","小野","森重","森本","阿部","岡田","玉田","原口","谷口","中山","権田","永井","駒野","稲本","松井","藤春","興梠","青山","柿谷","松田","前田","井原","西川","久保","山村","森島","大黒","矢野","伊野波","安田","岩政","藤本","宮本","槙野","福西","岡野","豊田","扇原","相馬","金崎","徳永","大津","服部","前園"]) },
    { key: "given",  pool: pool(["大輔","直樹","圭佑","英寿","佑都","慎司","拓実","保仁","勇也","麻也","知良","弘嗣","邦茂","篤人","永嗣","高徳","嘉紀","俊輔","貴史","宏樹","拓磨","嘉人","佑二","泰幸","能活","伸二","真人","貴幸","勇樹","武史","圭司","元気","彰悟","雅史","修一","謙佑","友一","潤一","廣輝","慎三","敏弘","曜一朗","遼一","正巳","浩二","周作","建英","和也","寛晃","将志","貴章","雅彦","憲剛","理大","隆行","大樹","淳吾","恒靖","智章","崇史","雅行","陽平","雄樹","貴宏","夢生","悠平","祐樹","年宏","真聖"]), join: "" },
  ],
};
const A_KOR: NameSpec = {
  family: "A", script: "native",
  // 85/100 South Korea internationals split; 김21.5 이14.7 박8.4 weighted.
  order: [
    { key: "surname", pool: pool(
      ["김","이","박","최","정","강","조","윤","장","임","한","신","오","홍","차","백","하","송","구","안","유","곽","권","문","주","양"],
      [21.5,14.7,8.4,4.7,4.4,2.3,2.1,2.0,1.9,1.6,1.4,1.3,1.2,1.1,1.0,0.9,0.8,0.8,0.7,0.7,0.6,0.6,0.5,0.5,0.5,0.5],
    ) },
    { key: "given", pool: pool(["범근","정환","우영","지성","용식","유형","명보","주영","희찬","영권","강인","민재","정수","인범","대세","자철","청용","운재","근호","주호","두리","영표","승규","남일","보경","성룡","승호","재성","규성","동국","현수","천수","정우","진수","현우","현규","태용","선홍","석영","의조","승우","범석","상철","신욱","민우","진현","호","동진","승렬","도훈","진규","태휘","용수","국영","범영","용","영선","석호","영철","영광","창수","창훈","태욱","종우","정호","철","대성","반석","선민","문환","재석","종국","용형","재진","성용","승현","세종","현준","민수","석주","상식","성동"]), join: "" },
  ],
};
const A_VIE: NameSpec = {
  family: "A", script: "latin",
  // surname first + optional middle (Văn) + given; Quốc ngữ, spaces between
  order: [
    { key: "surname", pool: pool(["Nguyễn","Trần","Lê","Phạm","Hoàng","Phan","Vũ","Đặng","Bùi","Đỗ","Hồ","Ngô","Dương"]) },
    { key: "middle",  pool: pool(["Văn","Hữu","Đức","Quang","Minh","Văn"]), optional: true, probability: 0.6 },
    { key: "given",   pool: pool(["Minh","Hùng","Dũng","Anh","Tuấn","Sơn","Hải","Nam","Long","Quang","Thành","Phong","Hiếu","Khoa"]) },
  ],
};

// ── Family B: Hispanic double-surname (given + paternal + maternal) ──
// Shared Spanish given names; per-nation surname pools. Maternal surname is
// optional (everyday use often drops it).
const B_GIVEN = pool(["Hugo","Martín","Lucas","Daniel","Pablo","Diego","Álvaro","Adrián","David","Iker","Marco","Sergio","Mateo","Santiago","Nicolás","Joaquín","Emiliano","Lautaro","Bruno","Tomás"]);
const B_GIVEN2 = pool(["José","Antonio","Manuel","Javier","Alejandro","Francisco","Carlos","Luis","Miguel","Ángel"]);
const B_SPEC = (surnames: NamePool): NameSpec => ({
  family: "B", script: "latin",
  order: [
    { key: "given",    pool: B_GIVEN },
    { key: "given2",   pool: B_GIVEN2, optional: true, probability: 0.3 },
    { key: "paternal", pool: surnames },
    { key: "maternal", pool: surnames, optional: true, probability: 0.55 },
  ],
});
const B_ESP = B_SPEC(pool(["García","González","Rodríguez","Fernández","López","Martínez","Sánchez","Pérez","Gómez","Ruiz","Jiménez","Díaz","Moreno","Muñoz","Álvarez","Romero","Navarro","Torres"]));
const B_ARG = B_SPEC(pool(["González","Rodríguez","Fernández","López","Martínez","Pérez","García","Sánchez","Romero","Díaz","Acosta","Sosa","Pereyra","Méndez","Suárez","Ríos","Vega","Castro"]));
const B_MEX = B_SPEC(pool(["Hernández","García","Martínez","López","González","Pérez","Rodríguez","Sánchez","Ramírez","Cruz","Flores","Rivera","Gómez","Reyes","Torres","Ortiz","Mora"]));
const B_URU = B_SPEC(pool(["González","Rodríguez","Fernández","Martínez","Pérez","García","Sosa","Pereyra","Silva","Ramírez","Díaz","Castro","Berra","Aguirre","López"]));
const B_COL = B_SPEC(pool(["Rodríguez","Gómez","González","Martínez","García","López","Ramírez","Torres","Pérez","Rojas","Díaz","Moreno","Vargas","Jiménez","Castro"]));
const B_CHI = B_SPEC(pool(["González","Muñoz","Rojas","Díaz","Pérez","Contreras","Soto","Flores","Castillo","Fuentes","Vargas","Ramírez","Sepúlveda","Reyes","Morales"]));

// ── Family C: Lusophone double-surname (maternal + paternal, reversed) ──
// Brazilian shirt names often collapse to one surname, so maternal is optional.
const C_SPEC = (given: NamePool, surnames: NamePool): NameSpec => ({
  family: "C", script: "latin",
  order: [
    { key: "given",    pool: given },
    { key: "given2",   pool: B_GIVEN2, optional: true, probability: 0.25 },
    { key: "maternal", pool: surnames, optional: true, probability: 0.5 },
    { key: "paternal", pool: surnames },
  ],
});
const C_BRA = C_SPEC(
  pool(["Lucas","Gabriel","Matheus","João","Pedro","Bruno","Rafael","Felipe","Vinícius","Caio","Diego","André","Gustavo","Wesley","Eduardo","Fernando"]),
  pool(["Silva","Santos","Souza","Oliveira","Costa","Pereira","Rodrigues","Almeida","Ferreira","Ribeiro","Carvalho","Gomes","Lima","Barbosa","Martins"]),
);
const C_POR = C_SPEC(
  pool(["João","Tiago","Rui","André","Bruno","Diogo","Gonçalo","Rafael","Pedro","Miguel","Fábio","Daniel","Hugo","Nuno","Paulo"]),
  pool(["Silva","Santos","Ferreira","Pereira","Oliveira","Costa","Rodrigues","Martins","Sousa","Fernandes","Gomes","Lopes","Ribeiro","Carvalho"]),
);

// ── Family D: single-surname (given + surname) — covers the majority ──
// For most D nations a 2nd given name is rare → lower probability.
const D2_SPEC = (given: NamePool, surname: NamePool, p2 = 0.15): NameSpec => ({
  family: "D", script: "latin",
  order: [
    { key: "given",  pool: given },
    { key: "given2", pool: B_GIVEN2, optional: true, probability: p2 },
    { key: "surname", pool: surname },
  ],
});

const D_ENG = D2_SPEC(
  pool(["Jack","Harry","Oliver","George","Jacob","Charlie","Thomas","Oscar","James","Leo","Alfie","Mason","Archie","Henry","Freddie","Theodore","Harry","Finley"]),
  pool(["Smith","Jones","Taylor","Brown","Wilson","Davies","Evans","Thomas","Walker","White","Edwards","Hughes","Roberts","Green","Hall","Wood","Clarke","Wright"]),
);
const D_SCO = D2_SPEC(
  pool(["Callum","Lewis","Jack","James","Logan","Finlay","Aaron","Cameron","Kyle","Ryan","Connor","Murray","Rory","Fraser","Brodie","Struan"]),
  pool(["McDonald","Campbell","Stewart","MacLeod","McKenzie","Murray","Taylor","Wilson","Fraser","Reid","Ross","Burns","Robertson","Clark","Scott","Young","Paterson"]),
);
const D_IRL = D2_SPEC(
  pool(["Sean","Conor","Liam","Finn","Oisín","Cillian","James","Patrick","Aidan","Tadhg","Daniel","Jack","Darragh","Fionn","Luca","Bobby"]),
  pool(["Murphy","Kelly","O'Brien","Ryan","O'Connor","Walsh","O'Neill","Doyle","Byrne","Gallagher","O'Connor","Lynch","Murray","Hogan","Brady","Dunne"]),
);
const D_FRA = D2_SPEC(
  pool(["Lucas","Hugo","Theo","Nathan","Léo","Adam","Raphaël","Louis","Jules","Gabriel","Arthur","Paul","Noah","Liam","Ethan","Tom","Maël"]),
  pool(["Martin","Bernard","Dubois","Moreau","Laurent","Simon","Michel","Garcia","David","Bertrand","Roux","Vincent","Robert","Richard","Petit","Durand","Lefebvre"]),
);
const D_GER = D2_SPEC(
  pool(["Leon","Finn","Paul","Elias","Lukas","Felix","Jonas","Maximilian","Niklas","Tim","Julian","Noah","Liam","Fritz","Moritz","Philipp"]),
  pool(["Müller","Schmidt","Schneider","Fischer","Weber","Meyer","Wagner","Becker","Schulz","Hoffmann","Koch","Bauer","Richter","Klein","Wolf","Schäfer"]),
);
const D_ITA = D2_SPEC(
  pool(["Lorenzo","Alessandro","Matteo","Francesco","Andrea","Davide","Riccardo","Gabriele","Marco","Tommaso","Nicolò","Federico","Giacomo","Edoardo","Samuele","Filippo"]),
  pool(["Rossi","Russo","Ferrari","Esposito","Bianchi","Romano","Colombo","Ricci","Marino","Greco","Bruno","Gallo","Conti","De Luca","Costa","Mancini"]),
);
const D_NED = D2_SPEC(
  pool(["Daan","Sem","Lucas","Levi","Finn","Bram","Thijs","Sven","Jesse","Luuk","Mees","Stijn","Ruben","Jesse","Ties","Jip"]),
  pool(["de Jong","Jansen","de Vries","van den Berg","Bakker","Visser","Smit","Meijer","de Boer","Mulder","Bos","Peters","Hendriks","van Dijk","de Wit"]),
);
const D_BEL = D2_SPEC(
  pool(["Lucas","Liam","Noah","Finn","Victor","Arthur","Matteo","Kato","Jules","Seppe","Tuur","Wout","Stan","Mauro","Lowie","Warre"]),
  pool(["Peeters","Janssens","Maes","Jacobs","Mertens","Willems","Claes","Goossens","Wouters","De Smet","Vermeulen","De Clercq","Desmet","Van Damme","Willems"]),
);
const D_USA = D2_SPEC(
  pool(["Jackson","Liam","Noah","Ethan","Mason","Lucas","Logan","Caleb","Jayden","Ezra","Miles","Tyler","Aiden","Carter","Owen","Sebastian"]),
  pool(["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Anderson","Taylor","Wilson","Thomas","Hernandez","Lee"]),
);
const D_TUR = D2_SPEC(
  pool(["Yusuf","Eymen","Mehmet","Ahmet","Emir","Ali","Mustafa","Burak","Kerem","Deniz","Arda","Hakan","Eren","Berke","Emre","Mert"]),
  pool(["Yılmaz","Kaya","Demir","Şahin","Çelik","Yıldız","Yıldırım","Öztürk","Aydın","Özdemir","Arslan","Doğan","Kılıç","Aslan","Çetin","Kara"]),
);
const D_GRE = D2_SPEC(
  pool(["Giorgos","Nikos","Yannis","Kostas","Dimitris","Christos","Panagiotis","Stavros","Vasilis","Manos","Spiros","Antonis","Thanos","Michalis","Petros","Andreas"]),
  pool(["Papadopoulos","Papadimitriou","Georgiou","Pappas","Christou","Nikolaou","Ioannou","Antoniou","Vlachos","Dimopoulos","Stavrou","Kontos","Pavlou","Filippou","Georgiadis"]),
);
// Arabic / Persian / Thai via Latin transliteration (FIFA convention; avoids
// RTL Arabic-script rendering cost — see research §2.7, §decision).
const D_EGY = D2_SPEC(
  pool(["Mohamed","Ahmed","Mahmoud","Omar","Youssef","Khaled","Mostafa","Amr","Hassan","Karim","Tarek","Adel","Sherif","Walid","Hossam","Ibrahim"]),
  pool(["Mohamed","Ahmed","Hassan","Ibrahim","Abdelrahman","Mahmoud","Mostafa","Khaled","Omar","Salem","Ali","Said","Riad","Fouad","Salah","Eid"]),
);
const D_KSA = D2_SPEC(
  pool(["Mohamed","Ahmed","Abdulrahman","Salem","Abdullah","Khalid","Faisal","Sultan","Bandar","Nawaf","Yasser","Saud","Mansour","Majed","Turki","Naif"]),
  pool(["Al-Harbi","Al-Otaibi","Al-Qahtani","Al-Dossari","Al-Ghamdi","Al-Shehri","Al-Mutairi","Al-Anazi","Al-Balawi","Al-Zahrani","Al-Subaie","Al-Shammari","Al-Malki","Al-Rashidi"]),
);
const D_QAT = D2_SPEC(
  pool(["Mohamed","Ahmed","Abdullah","Khalid","Abdulaziz","Hassan","Ali","Tamim","Jassim","Saif","Hamad","Nasser","Khalifa","Fahad","Mubarak","Sultan"]),
  pool(["Al-Abdulla","Al-Mohannadi","Al-Kuwari","Al-Maliki","Al-Naimi","Al-Suwaidi","Al-Boainain","Al-Hitmi","Al-Muhannadi","Al-Marri","Al-Dosari","Al-Kuwari"]),
);
const D_IRN = D2_SPEC(
  pool(["Mehdi","Saeid","Karim","Ali","Reza","Amir","Hossein","Pooya","Milad","Majid","Sina","Omid","Kaveh","Arash","Babak","Shahin"]),
  pool(["Taremi","Azizi","Mohammadi","Hosseini","Karimi","Ebrahimi","Rezaei","Moradi","Hashemi","Gholizadeh","Nouri","Farahani","Kazemi","Rostami","Sadeghi","Shirazi"]),
);
const D_THA = D2_SPEC(
  pool(["Chanathip","Teerasil","Sarachart","Theerathon","Supachok","Suphanat","Bordin","Sasalak","Peeradon","Worachit","Pansa","Channarong","Chenrop","Chaiyawat","Chotinan"]),
  pool(["Songkrasin","Dangda","Buathong","Chantharak","Promraksa","Wonggorn","Sukstrip","Thongklin","In-urai","Bootok","Praphaiphan","Chaichana","Tapsuwan"]),
);
// Slavic — patronymic OMITTED (user decision; football broadcast uses given +
// surname, e.g. Shevchenko). Pools are native-region surnames/given names.
const D_UKR = D2_SPEC(
  pool(["Oleksandr","Dmytro","Maksym","Andriy","Denys","Vladyslav","Yaroslav","Bohdan","Pavlo","Serhiy","Yurii","Mykola","Oleh","Viktor","Ruslan","Artur"]),
  pool(["Kovalenko","Melnyk","Shevchenko","Tkachenko","Kovalchuk","Bondarenko","Boyko","Tymoshenko","Marchenko","Kuzmenko","Savchuk","Polishchuk","Romanenko","Lysenko","Bondar"]),
);
const D_SRB = D2_SPEC(
  pool(["Nikola","Marko","Stefan","Filip","Aleksa","Luka","Dušan","Milan","Lazar","Uroš","Bogdan","Vuk","Petar","Nemanja","Andrija","Veljko"]),
  pool(["Jovanović","Popović","Nikolić","Stanković","Radić","Petrović","Đorđević","Mitrović","Simović","Tomić","Ilić","Stojanović","Marković","Pavlović","Zorić"]),
);
const D_CRO = D2_SPEC(
  pool(["Luka","Ivan","Marko","Filip","Marin","Domagoj","Ante","Matej","Borna","Franjo","Petar","Lovro","Josip","Dino","Sime","Roko"]),
  pool(["Horvat","Babić","Marić","Kovačić","Novak","Vuković","Knežević","Marinković","Radić","Perić","Pavić","Vidović","Blažević","Bošnjak","Filipović"]),
);
const D_POL = D2_SPEC(
  pool(["Jan","Jakub","Antoni","Szymon","Filip","Aleksander","Franciszek","Mateusz","Piotr","Michał","Wojciech","Kacper","Tymon","Ignacy","Stanisław","Witold"]),
  pool(["Nowak","Kowalski","Wiśniewski","Wójcik","Kowalczyk","Kamiński","Lewandowski","Zieliński","Szymański","Woźniak","Dąbrowski","Kozłowski","Jankowski","Mazur","Krawczyk"]),
);
const D_CZE = D2_SPEC(
  pool(["Jakub","Jan","Tomáš","Adam","Matěj","Lukáš","Martin","Ondřej","David","Vojtěch","František","Matyáš","Daniel","Petr","Filip","Štěpán"]),
  pool(["Novák","Svoboda","Novotný","Dvořák","Černý","Procházka","Kučera","Horák","Pokorný","Pospíšil","Marek","Vavřík","Kratochvíl","Fiala","Sedláček"]),
);
// Africa — English/French/Arabic-influenced given names, regional surnames.
const D_SEN = D2_SPEC(
  pool(["Sadio","Moussa","Mamadou","Ibrahima","Cheikh","Oumar","Ismaila","Boulaye","Pape","Demba","Mame","Assane","Habib","Serigne","Modou","Mbacke"]),
  pool(["Mané","Ndiaye","Diop","Fall","Sarr","Diallo","Gueye","Mbaye","Faye","Ndour","Sow","Bâ","Mbow","Diouf","Cissé","Touré"]),
);
const D_NGA = D2_SPEC(
  pool(["Ahmed","John","Victor","Kelechi","Samuel","Chukwuemeka","Uche","Ebuka","Chidi","Emeka","Daniel","Kunle","Tunde","Joshua","David","Henry"]),
  pool(["Okafor","Okeke","Eze","Nwosu","Adeyemi","Oluwaseun","Adebayo","Ibrahim","Ojo","Okonkwo","Nnamdi","Ogbonna","Ikechukwu","Onuoha","Chukwu"]),
);
const D_CIV = D2_SPEC(
  pool(["Sébastien","Ismaël","Maxime","Yao","Yves","Christian","Stéphane","Kader","Didier","Wilfried","Salomon","Franck","Serge","Gervais","Koffi","Aboubacar"]),
  pool(["Koné","Traoré","Coulibaly","Bamba","Cissé","Diabaté","Touré","Kouassi","Yéo","Doumbia","Gnépo","Zadi","N'Guessan","Kouamé","Diarra"]),
);
const D_CMR = D2_SPEC(
  pool(["Samuel","Eric","Rigobert","Jean-Pierre","Patrick","Achille","Enoh","Vincent","Karl","André","Joël","Claude","Landry","Georges","Eric","Karl"]),
  pool(["Eto'o","Fofana","Nkoulou","Mbia","Bassogog","Choupo-Moting","Aboubakar","Onana","Njie","Kameni","Salli","Moumi","Ngomis","Ndongo","Ze"]),
);
const D_MAR = D2_SPEC(
  pool(["Achraf","Hakim","Amine","Romain","Noussair","Younes","Sofiane","Ayoub","Mehdi","Yassine","Oussama","Bilal","Hamza","Adam","Anas","Omar"]),
  pool(["Hakimi","Ziyech","Benatia","Boufal","En-Nesyri","Amrabat","Aguerd","Saiss","Mazraoui","Ounahi","Hakimi","El Kaabi","Bono","Amallah","Dari"]),
);
const D_GHA = D2_SPEC(
  pool(["Kwadwo","Asamoah","Andre","Jordan","Mohammed","Inaki","Thomas","Kamaldeen","Mohammed","Daniel","Emmanuel","Fatawu","Antoine","John","Salis","Baba"]),
  pool(["Boateng","Ayew","Asamoah","Mensah","Owusu","Appiah","Sarpong","Adjei","Annang","Frimpong","Dankwa","Mensimah","Owusu","Adjei","Agyei"]),
);
const D_ALG = D2_SPEC(
  pool(["Riyad","Ismaël","Islam","Saïd","Baghdad","Houssem","Ryad","Yacine","Adam","Sofiane","Faouzi","Hillar","Said","Bilal","Nabil","Aymen"]),
  pool(["Mahrez","Brahimi","Bensebaini","Slimani","Feghouli","Belkebla","Bennacer","Brahimi","Said","Bensebaini","Zerrouki","Atal","Mandi","Slimani","Belfodil"]),
);
const D_TUN = D2_SPEC(
  pool(["Wahbi","Yassine","Aïssa","Saif-Eddine","Ellyes","Wajdi","Hannibal","Ali","Naïm","Anis","Hamza","Safa","Mohamed","Ghailene","Seif","Bilel"]),
  pool(["Khazri","Sassi","Skhiri","Drager","Bronn","Haddadi","Talbi","Ben Romdhane","Jaziri","Maaloul","Sliti","Kechta","Meriah","Gouja","Abdi"]),
);
// English-diaspora (Aus/Can/Jam) — own surname pools (Aus=convict-era common;
// Can=French+English mix; Jam=Creole).
const D_AUS = D2_SPEC(
  pool(["Liam","Noah","Oliver","Jack","William","Lucas","Thomas","Henry","Charlie","James","Leo","Hudson","Cooper","Hunter","Carter","Ethan"]),
  pool(["Smith","Williams","Brown","Wilson","Taylor","Johnson","White","Martin","Anderson","Thompson","Jones","Walker","Harris","Lee","King","Wright"]),
);
const D_CAN = D2_SPEC(
  pool(["Liam","Noah","Oliver","William","Benjamin","Lucas","Henry","Jack","Theodore","Leo","Owen","Nathan","Julian","Hudson","Ethan","Levi"]),
  pool(["Smith","Brown","Tremblay","Martin","Roy","Gagnon","Lee","Wilson","Johnson","MacDonald","Fortin","Gagné","Côté","Bouchard","Côté","Dubois"]),
);
const D_JAM = D2_SPEC(
  pool(["Raheem","Leon","Kemar","Damion","Andre","Shamar","Jahmari","Demario","Roshane","Kevon","Travon","Deandre","Tyrek","Romario","Jaheel","Khalif"]),
  pool(["Bailey","Brown","Williams","Clarke","Thompson","Reid","Campbell","Grant","Smith","Jones","Francis","Brown","Gordon","Lawson","McFarlane"]),
);
// Nordic + DACH — own pools so a Dane/Swede/Swiss never reads as "Jack Smith".
const D_DEN = D2_SPEC(
  pool(["Christian","Magnus","Valdemar","Carl","Anton","Victor","Noah","Frederik","Alfred","August","Elias","Malthe","Liam","Oliver","Emil","Mads"]),
  pool(["Nielsen","Hansen","Pedersen","Andersen","Christensen","Larsen","Sørensen","Møller","Rasmussen","Jørgensen","Petersen","Madsen","Kristensen","Thomsen"]),
);
const D_SWE = D2_SPEC(
  pool(["Lucas","Liam","William","Elias","Noah","Oliver","Leo","Alexander","Erik","Oskar","Matteo","Felix","Viktor","Anton","Emil","Sebastian"]),
  pool(["Andersson","Johansson","Karlsson","Nilsson","Eriksson","Larsson","Olsson","Persson","Svensson","Gustafsson","Berg","Lindberg","Lindström","Lundin","Axelsson"]),
);
const D_NOR = D2_SPEC(
  pool(["Lucas","Oskar","Emil","Noah","Oliver","Filip","Jakob","Aksel","Erik","Martin","Sander","Jonas","Henrik","Marius","Elias","Mathias"]),
  pool(["Hansen","Johansen","Olsen","Larsen","Andersen","Nilsen","Pedersen","Kristiansen","Jensen","Karlsen","Berg","Bakken","Lund","Solberg","Haugen"]),
);
const D_SUI = D2_SPEC(
  pool(["Luca","Noah","Liam","Gabriel","Matteo","David","Elias","Julian","Leo","Nino","Theo","Alessandro","Marco","Niklas","Florian","Jonas"]),
  pool(["Müller","Meier","Schneider","Weber","Keller","Huber","Fischer","Brun","Ammann","Studer","Gerber","Kunz","Frei","Zbinden","Stocker"]),
);
const D_AUT = D2_SPEC(
  pool(["Lukas","Paul","Felix","Jonas","Maximilian","David","Marco","Tobias","Liam","Noah","Philipp","Sebastian","Julian","Stefan","Daniel","Matteo"]),
  pool(["Gruber","Wagner","Huber","Bauer","Steiner","Mayer","Pfeiffer","Reiter","Berger","Leitner","Eder","Schwarz","Binder","Hofer","Winkler"]),
);

// ───────────────────────────── the table ─────────────────────────────

export const NAME_SPECS: Record<string, NameSpec> = {
  // Family A — surname first
  chn: A_CHN, jpn: A_JPN, kor: A_KOR, vie: A_VIE,
  // Family B — Hispanic double-surname
  esp: B_ESP, arg: B_ARG, mex: B_MEX, uru: B_URU, col: B_COL, chi: B_CHI,
  // Family C — Lusophone double-surname (reversed)
  bra: C_BRA, por: C_POR,
  // Family D — single-surname (Western / Slavic / Arabic-latin / African / SEA / diaspora)
  eng: D_ENG, sco: D_SCO, irl: D_IRL, fra: D_FRA, ger: D_GER, ita: D_ITA,
  ned: D_NED, bel: D_BEL, usa: D_USA, tur: D_TUR, gre: D_GRE,
  egy: D_EGY, ksa: D_KSA, qat: D_QAT, irn: D_IRN, tha: D_THA,
  ukr: D_UKR, srb: D_SRB, cro: D_CRO, pol: D_POL, cze: D_CZE,
  sen: D_SEN, nga: D_NGA, civ: D_CIV, cmr: D_CMR, mar: D_MAR, gha: D_GHA, alg: D_ALG, tun: D_TUN,
  aus: D_AUS, can: D_CAN, jam: D_JAM,
  den: D_DEN, swe: D_SWE, nor: D_NOR, sui: D_SUI, aut: D_AUT,
};

// ───────────────────────────── confederation fallback ─────────────────────────────
// Nations without an explicit spec (low-frequency picks) fall back to a real
// same-region pool — never a generic English "Jack Smith". The fallback IS a
// full NameSpec, so its assembly order (e.g. Hispanic double-surname for
// CONMEBOL/CENTRAL-AMERICA, CJK for AFC) is also authentic.
const FALLBACK_BY_CONF: Record<string, string> = {
  UEFA: "eng",
  CONMEBOL: "arg",
  CONCACAF: "mex",
  AFC: "jpn",
  CAF: "sen",
  OFC: "eng",
};

// local copy of confederation lookup to stay dependency-free; data.ts re-exports
// this generator and confederation lives there, so we resolve fallback lazily.
// (We avoid importing data.ts to prevent a cycle; the confederation→fallback
//  map above is the only thing we need, and it's static.)
const CONF_OF_NATION: Record<string, string> = {
  // UEFA
  esp: "UEFA", fra: "UEFA", ger: "UEFA", eng: "UEFA", ita: "UEFA", por: "UEFA", ned: "UEFA",
  bel: "UEFA", cro: "UEFA", den: "UEFA", sui: "UEFA", aut: "UEFA", pol: "UEFA", tur: "UEFA",
  swe: "UEFA", nor: "UEFA", srb: "UEFA", ukr: "UEFA", cze: "UEFA", gre: "UEFA", sco: "UEFA", irl: "UEFA",
  // CONMEBOL
  arg: "CONMEBOL", bra: "CONMEBOL", uru: "CONMEBOL", col: "CONMEBOL", chi: "CONMEBOL",
  ecu: "CONMEBOL", par: "CONMEBOL", per: "CONMEBOL", ven: "CONMEBOL", bol: "CONMEBOL",
  // AFC
  jpn: "AFC", kor: "AFC", irn: "AFC", aus: "AFC", ksa: "AFC", qat: "AFC", uzb: "AFC",
  irq: "AFC", chn: "AFC", tha: "AFC", vie: "AFC", idn: "AFC",
  // CAF
  mar: "CAF", sen: "CAF", egy: "CAF", nga: "CAF", civ: "CAF", cmr: "CAF", gha: "CAF", alg: "CAF", tun: "CAF",
  // CONCACAF
  mex: "CONCACAF", usa: "CONCACAF", can: "CONCACAF", crc: "CONCACAF", jam: "CONCACAF", pan: "CONCACAF",
  // OFC
  nzl: "OFC", fij: "OFC",
};

function fallbackSpec(nationalityId: string): NameSpec {
  const conf = CONF_OF_NATION[nationalityId] ?? "UEFA";
  const fbId = FALLBACK_BY_CONF[conf] ?? "eng";
  return NAME_SPECS[fbId] ?? A_CHN;
}

// ───────────────────────────── public API ─────────────────────────────

// Real-player full names whose fragments we recombine (chn/jpn/kor top-100
// internationals). assembleName re-rolls the given if a recombination would
// reproduce one of these verbatim — the "recombine A's surname + B's given"
// design MUST NOT clone a real player. (243 names; auto-gen via scripts/names-gen-cjk.py.)
const REAL_FULL_NAMES: ReadonlySet<string> = new Set([
  '三浦知良','中山雅史','中村俊輔','中村憲剛','中澤佑二','中田浩二','中田英寿','久保建英',
  '于大宝','于根伟','于汉超','于海','井原正巳','今野泰幸','任航','伊野波雅彦',
  '傅明','内田篤人','冯潇霆','刘建业','刘彬彬','刘爱玲','前園真聖','前田遼一',
  '区楚良','南野拓実','原口元気','叶鸿辉','吉田麻也','吴承瑛','吴曦','周海滨',
  '大久保嘉人','大津祐樹','大迫勇也','大黒将志','姜至鹏','孙可','孙祥','孙继海',
  '孙雯','宇佐美貴史','安琦','安田理大','宮本恒靖','宿茂臻','小野伸二','山村和也',
  '岡崎慎司','岡田武史','岡野雅行','岩政大樹','川口能活','川島永嗣','廖力生','张呈栋',
  '张恩华','张玉宁','张琳芃','张睿','张稀哲','徐云龙','徳永悠平','扇原貴宏',
  '曲波','曾诚','服部年宏','本田圭佑','朱广沪','朱挺','朱辰杰','李影',
  '李昂','李明','李玮锋','李磊','李金羽','李铁','李霄鹏','杜威',
  '杨丽','杨旭','杨晨','杨智','杨璞','松井大輔','松田直樹','柿谷曜一朗',
  '梅方','森島寛晃','森本貴幸','森重真人','槙野智章','権田修一','武磊','武藤嘉紀',
  '武藤雄樹','永井謙佑','江津','浅野拓磨','清武弘嗣','玉田圭司','王上源','王大雷',
  '王珊珊','王霜','王靖斌','相馬直樹','矢野貴章','石柯','祁宏','福西崇史',
  '稲本潤一','肇俊哲','興梠慎三','苏进安','范志毅','荣昊','董芳卓','蒋光太',
  '蒿俊闵','蔡慧康','蔡立靖','藤春廣輝','藤本淳吾','西川周作','谷口彰悟','豊田陽平',
  '贾秀全','赵旭日','遠藤保仁','邓卓翔','邵佳一','郑智','郜林','郝海东',
  '酒井宏樹','酒井高徳','金崎夢生','釜本邦茂','鈴木大輔','鈴木隆行','長友佑都','阿部勇樹',
  '陈婉婷','陈涛','陈肇钧','青山敏弘','韦世豪','韩鹏','颜骏凌','駒野友一',
  '马宁','马明宇','马晓旭','高准翼','高尧','高洪波','黄博文','강민수',
  '곽태휘','구자철','권창훈','김남일','김도훈','김동진','김문환','김민우',
  '김민재','김보경','김상식','김승규','김신욱','김영광','김영권','김용식',
  '김정우','김진규','김진수','김진현','김창수','문선민','박종우','박주영',
  '박주호','박지성','백성동','백승호','송범근','송종국','신태용','안정환',
  '양현준','오반석','오범석','오재석','오현규','유상철','윤석영','윤영선',
  '윤정환','이강인','이근호','이동국','이범영','이승렬','이승우','이영표',
  '이용','이운재','이유형','이재성','이정수','이천수','이청용','이호',
  '장현수','정대세','정성룡','정승현','정우영','조규성','조영철','조용형',
  '조재진','조현우','주세종','차두리','차범근','최성용','최용수','최태욱',
  '하대성','하석주','한국영','홍명보','홍정호','홍철','황석호','황선홍',
  '황의조','황인범','황희찬',
]);

/** Generate a nationality-authentic player name deterministically from the
 *  seed. Same `seed + nationalityId` always yields the same name string.
 *  If a recombination would clone a real player's full name (CJK fragment pools),
 *  re-rolls with a deterministic retry stream — bounded so it never loops. */
export function generatePlayerName(seed: string, nationalityId: string): string {
  const spec = NAME_SPECS[nationalityId] ?? fallbackSpec(nationalityId);
  for (let retry = 0; retry < 8; retry++) {
    const name = assembleName(seed, nationalityId, spec.order, retry);
    if (!REAL_FULL_NAMES.has(name)) return name;
  }
  return assembleName(seed, nationalityId, spec.order, 99);
}
