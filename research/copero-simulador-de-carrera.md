# Copero · *Simulador de Carrera* — 研究笔记

> 研究对象：阿根廷体育数据站 **Copero**（copero.com.ar）的小游戏 **Simulador de Carrera**
> （路径 `/juegos/simulador-carrera`，"Convertite en leyenda / 成为传奇"）。
> 方法：用 agent-browser 实际开了一局（阿根廷 / DC / Normal 模式，16→40 岁完整跑完），
> 并下载其前端 chunk `CareerSimulatorPage-DW_0IenV.js`（643KB）反查事件、RNG、分享逻辑。
> 结论：**本仓库的《绿茵轮回》几乎就是这个引擎的忠实再实现 + roguelike 元层（传承/祝福/飞升）增强。**

---

## 一句话

它是一个"种子决定一切、几分钟跑完一辈子、每个决策都明牌显示成功率"的足球生涯 roguelite。
玩家上瘾的不是"管理"，而是"看命运 unfold + 想再来一把试试别的选择"。
**核心吸引力 = 种子可分享可复现 × 决策密度高 × 赔率永远明牌 × 生涯即叙事 × 成就长线目标 × WhatsApp 分享卡。**

---

## 1. 核心玩法循环（core loop）

**设置 → 模拟 N 个赛季 → 一个决策 → 再模拟 → … → 退役 → 分享卡。一次决策就是一次推进，没有单独的"继续"按钮。**

### 1.1 设置（"Definí tu identidad"）
- 姓氏（APELLIDO）、球衣号码（默认 10）、惯用脚（左/右）。
- 国籍：24+ 国家（阿根廷/巴西/西班牙/英格兰…，"VER MÁS" 展开）。
- 位置：EI/DC/ED/MI/MCO/MD/LI/MC/LD/MCD/DFC/POR（边锋/中锋/前腰/边卫/中卫/门将）。
- **强度三档**（决定"每几个赛季一个决策"，即 `periodLengthSeasons`）：
  - **Intensa**（硬核）：1 决策/赛季，深度沉浸。
  - **Normal**（默认）：每 2 个赛季 1 决策，平衡。
  - **Exprés**（快速）：每 3 个赛季 1 决策，快速体验。
  > 源码 `Me[mode].periodLengthSeasons`，对应本仓库 `PERIOD_LENGTH`（本仓库默认取 1，即 Intensa 密度）。

### 1.2 起点 = "泥到石"（mud-to-marble）
- 起始 OVR **50**，16 岁，**自由身**，空奖杯柜（"VITRINA VACÍA"）。
- 第一个决策 **"Oferta de cantera"**（青训邀约）：3 个**低级别俱乐部**二选一（我那局是阿根廷乙级 Primera Nacional 的 Dep. Maipú / Ferro / Quilmes）。
- 选定后立即模拟 2 个赛季，OVR 跳 50→55，出现生涯首行数据（出场/进球/助攻）。

### 1.3 每期决策类型（决策脊柱，源码 `debugDecision*` 枚举）
1. **AcademyOffer** 青训邀约（开局）。
2. **Transfer** "Mercado de pases" 转会窗（最常见）：2~3 个俱乐部报价 + "留在原队"。
3. **LoanOffer** "Oferta de préstamo" 租借报价；归还时 **PostLoanRetained / NotRetained**（归队有/无位置）。
4. **ContractNonRenewal** "Fin de ciclo" 俱乐部不续约（危机）。
5. **CareerEvent** "Evento de carrera" 叙事/风险事件（见下）。
6. **Summary** "Resumen final" 退役总结。

### 1.4 CareerEvent 事件层（roguelike 的"决策"灵魂）
从 bundle 抽出的事件目录（ES/EN/PT 三语）：

- **角色/出场时间**：`Competencia por el puesto`（竞争主力，按钮直接写 **"50% Titular / 50% Rotación baja"**）、`Te cuelgan`（被替补）、`Cambio de posición`（改位置）。
- **伤病（风险层，真实伤病名）**：`Rotura de ligamentos cruzados`(ACL)、`Rotura de meniscos`(半月板)、`Fractura de metatarso`(跖骨)、`Fractura de tibia y peroné`、`Achilles tendon rupture`、`Desgarro de isquiotibial/gemelo`(腿筋/小腿撕裂)、`Luxación de hombro`(肩脱位)、`Hernia de disco`、`Esguince de tobillo`(踝扭伤)。结局：`It gets infected`(感染恶化) / `The injury heals normally` / `Comenzar la recuperación` / `Ir mesmo así`(带伤上)。
- **高光事件（age-gated climax，源码按 age 触发）**：
  - `injury-at-peak` = "Lesión en el mejor momento"（巅峰伤病）——对应本仓库"巅峰伤病"。
  - `decisive-penalty`（点球决战）——对应本仓库 `decisivePenalty`。
- **优先级/锦标赛侧重（forceTrophy 类）**：`Priorizar la liga` / `Priorizar la copa internacional` / `Priorizar el descanso`。
  结局直接改夺冠概率：`Se duplica la probabilidad de ganar la liga`(联赛夺冠概率翻倍) / `Se reduce a la mitad…`(减半) / `Más/Menos chances de salir campeón`。→ **俱乐部 tier 决定奖杯赔率**，决策可改俱乐部 tier（`teamTierOverrides` / `nextTeamTier`）。
- **成长/训练**：`Cambiar la técnica` vs `Mantener tu técnica`、`Plan de alimentación`(饮食)、`Entrenar a fondo`(加练) / `Treino em dobro`(双倍训练)、`Bajar la carga`(减负)、`Carga de la temporada`(赛季负荷)。
- **国家队**：`Cambiar de selección`(改换国家队，规则是"Abuelo de otra nacionalidad"祖籍外援)、`Mantenés tu selección actual`。
- **叙事/球迷共鸣**：`Enojo de la hinchada`/`Ira da torcida`(球迷怒火，按钮写明"−2 OVR temporal por la presión mental")、`Crisis en el club`(俱乐部危机)、`Ser su mentor`(给新人当导师)、`Prueba de honestidad`(诚实考验)、`Terminar el secundario`(读完高中——年轻球员叙事！)、`Bancar a tu hermano/tío/primo`(给家人站台)。
- **生涯终点**：`Finalizar tu carrera profesional` / `Tu carrera llegó a su fin`。

> 对照本仓库 `events.ts` 的 `EVENT_DEFS` 与 `buildPeriodDecision` 优先级（climax→decisivePenalty→转会窗→随机事件→fallback 转会），骨架几乎一致。

### 1.5 赔率永远明牌（odds as hero）
- **转会决策不显示赔率**（只是俱乐部二选一）。
- **事件决策把概率写进按钮**：例 `Competir — 50% Titular / 50% Rotación baja`；优先级事件写"夺冠概率翻倍/减半"；球迷事件写"−2 OVR 临时"。
- 选完即结算：我那局选"Competir"中了 50% 的坏结局 → 落到替补 → 自动进入下一期。
  > 这正是本仓库 PRODUCT.md 说的"visible odds are the differentiator"。Copero 是这么做的，本仓库继承并强化。

### 1.6 模拟与成长曲线
- **确定性 RNG**：xorshift，`o>>>17, o^=o<<5, t/4294967296`，与 FNV-1a+xorshift32 同族。
- **命名空间 derive**：`De(\`${seed}:injury:${step}\`)`、`De(\`${seed}:injury-at-peak:${rngState}:${teamId}:${age}\`)`、`De(\`${seed}:decisive-penalty:…\`)`、`De(\`${seed}:variant:${step}:${id}\`)`——每个逻辑事件独立可复现流。**与本仓库 `derive(seed,"injury",age)` 完全同构。**
- **发育档案（dev profiles）按 age 的 OVR 曲线**：bundle 里有多条曲线（如 `[50,60,70,80,90,95,99,96,94,91,88,...]` 峰值约 28 岁到 99；`[45,50,55,60,64,68,69,67,65,62,58,...]` 峰值约 28 岁到 69 后下滑）。`developmentProfile:Li(seed,position,r)` 由种子+位置决定 → 对应本仓库 `rollDevProfile`。
- 我那局实测：OVR 50(16)→55→63→69→72(约26-28岁峰值)→71→…→65(34)→58(40)，VALOR €3.9M 峰值→€80K 退役。**真实的"巅峰-下滑"弧线**，是叙事张力的来源。

### 1.7 生涯即叙事（career-as-story，UI 的脊柱）
- 顶部球员卡：OVR / 国旗 / 号码 / 位置 / 俱乐部 / **VALOR 市值** / 生涯累计 PJ·GLS·AST / 奖杯柜。
- **生涯时间线表**（EDAD/CLUB/OVR/PJ/GLS/AST，16→40 每 2 岁一行）+ 底部**国家队行**（阿根廷 0/0/0）。
- 整段生涯一眼看尽：7 个俱乐部（Ferro→Banfield→Tigre→Talleres→Godoy Cruz→Vélez→Aldosivi）的流浪轨迹本身就是故事。

### 1.8 退役总结（payoff）
- "CARRERA FINALIZADA"：巅峰 OVR、市值、生涯总数据、国家队记录、奖杯柜、**个人奖项**（Balón de Oro / Bota de Oro / Guante de Oro）。
- 逐俱乐部数据明细（journey）。
- 我那局：0 奖杯、0 国家队出场、0 个人奖——一个"平凡流浪汉"生涯，对应成就 **Ringless（无冠退役）**。
- **注意：Copero 没有复合"传承分/评分"**——结局用"巅峰 OVR + 奖杯 + 奖项 + 流浪轨迹"表达；本仓库的 `scoreLegacy` 是**额外加的** roguelike 元层。

---

## 2. 为什么日活/留存高（吸引力拆解）

### 2.1 种子可分享可复现（virality + replay 的引擎）
- 生涯由 `seed` 决定，**同一 seed + 同一选择 = 同一生涯**。localStorage 键 `copero:minigames:career-simulator:play:v1:{seed}` 按种子存档。
- 分享产物 = **图片卡**（`share-card-export` 生成，"Preparando imagen"）+ 病毒文案 **"Esta fue mi carrera en Copero. ¿Cómo sería la tuya?"**（这是我在 Copero 的生涯，你的会怎样？）+ 游戏链接。
  - ⚠ Copero 的分享链接是**裸 base URL**（`ea = https://copero.com.ar/juegos/simulador-carrera`），**不在 URL 里带 seed**——它走的是"看我的卡 → 去开你自己的"路线（WhatsApp 图片分享在拉美极强），而非"复现同一种子"。
  - 本仓库把这一点**升级**成"seed 写进 URL，朋友可复现同一生涯来比拼"——更 roguelike。

### 2.2 决策密度高 + 一决策即推进
- Normal 每 2 赛季一个决策，Intensa 每 1 赛季一个；**一次决策就推进**，没有"继续"按钮（PRODUCT 原则同源）。节奏极短，适合通勤/排队 5 分钟一把。

### 2.3 赔率永远明牌 → 紧张感 + "再来一把"心痒
- 概率写进按钮（50% Titular / 50% Rotación baja）→ 决策有"押注"的赌马快感。
- 坏结局（带伤争冠、被替补）→ "早知道选另一个" → **立刻 Volver a jugar 重开**。这是 Zeigarnik 效应的留存钩子。

### 2.4 泥到石 + 俱乐部 tier 驱动奖杯赔率
- 起步乙级 OVR 50，每期转会是"爬楼梯"的机会（乙级→甲级→豪门）。
- **俱乐部越强，夺冠赔率越高**（`teamTier` 决定），优先级决策可翻倍/减半夺冠概率——给"冲奖杯"一个清晰的策略目标。
- 奖杯柜 "VITRINA VACÍA → 装满"是极强的可见进度条。

### 2.5 生涯即叙事 + 生成式故事
- 时间线表 + 逐俱乐部数据 = 一段可讲述的生涯。每次跑都是独一无二的故事（流浪汉/忠诚传奇/GOAT）。
- 真实赛事名（Libertadores/Champions/Copa América/世界杯）+ 真实伤病名 → 球迷秒懂，代入感强（PRODUCT: "football stories over abstract mechanics"）。

### 2.6 成就系统 = 长线目标 + 重开理由（关键留存）
"Ver logros" 里有 **20+ 成就**，每个都对应一种"特定打法/生涯形态"，逼玩家用不同策略重开：
- `GOAT`（1 世界杯 + 2 洲际 + 8 金球 + 4 欧冠）
- `Só o Pelé`（3 世界杯 + 1000 球）
- `El triplete`（单季三冠王）
- `Matagigantes`（小俱乐部夺 Libertadores/Champions）
- `Leyenda del club`（一生一队 + 夺国内杯+联赛+洲际）
- `Nómade`（六大洲都踢过）/ `Baldosero`（一生效力 24 队）/ `De Ushuaia al Darién`（南美十国联赛都踢过）
- `Dueño de Europa`（五大联赛都夺过）/ `Rey de América`（美洲杯+解放者杯）
- `Ringless`（无冠退役）/ `Desde abajo`（从第三级带同一队升级夺冠）/ `Desde la periferia`（非欧非南美球员夺金球）
- `El más ganador de la historia`（49+ 冠）/ `El mundo es tuyo`（世界杯+世俱杯）/ `Completar el fútbol`（所有大赛+大奖）
- `Héroe nacional`（带从未夺冠的国家夺世界杯）/ `Mr. Champions`（5 欧冠）/ `Terror de las redes`（6 金靴）/ `Araña Negra`（6 次最佳门将）

  - 登录后**跨设备同步**（"Los logros pueden tardar en sincronizarse entre dispositivos"）→ 账号体系锁留存。
  - 每个成就 ≈ 一种"build"——这是 roguelite 的多周目动力。

### 2.7 多档强度 + 多语言 → 覆盖面
- Intensa/Normal/Exprés 三档密度，照顾硬核 vs 速食玩家。
- ES/EN/PT 三语（阿根廷站自带葡语，吃巴西市场）。

---

## 3. 与本仓库《绿茵轮回》的对照（它做了什么 / 你增强了什么）

| 维度 | Copero Simulador | 本仓库 绿茵轮回 |
|---|---|---|
| 引擎 RNG | xorshift + 命名空间 derive | FNV-1a + xorshift32 + `derive()`（同构） |
| 决策脊柱 | AcademyOffer→Transfer/Loan/CareerEvent→Summary | `buildPeriodDecision` 优先级（同构） |
|  climax 事件 | injury-at-peak / decisive-penalty | 巅峰伤病 / decisivePenalty（同构） |
| 赔率明牌 | 概率写进按钮 | `Odds` 组件 + `clampOdds`（继承并强化为"主角"） |
| 发育档案 | 多条 OVR-by-age 曲线，seed+pos 决定 | `rollDevProfile`（同构） |
| 强度档位 | Intensa(1)/Normal(2)/Exprés(3) | `PERIOD_LENGTH=1`（默认 Intensa 密度） |
| 奖杯赔率 | 俱乐部 tier 驱动 + 优先级决策翻倍/减半 | `clubTrophyCandidates` + `leagueTrophyMult`/`forceTrophy` |
| 奖项 | Balón/Bota/Guante de Oro | `rollAwards`（同构） |
| 成就 | 20+ 长线目标 + 跨设备同步 | **已实现**（12 个 → 本轮扩到 23 个，补齐 Copero 风味形态目标；无跨设备同步，纯本地） |
| 分享 | 图片卡 + "你的会怎样" + 裸链接（不带 seed） | **已实现且更强**：canvas→PNG 图片卡（含宿敌行+种子挑战 CTA）+ seed 写进 URL 的可复现分享 |
| 元进度 | **无复合传承分** | `scoreLegacy` + 传承/祝福/飞升（roguelike 增强） |
| 起始 | OVR 50 / 16 岁 / 乙级三选一 | START_OVR 50 / START_AGE 16（同） |
| 退役年龄 | 40（实测到 40 才"llegó a su fin"） | RETIRE_AGE 40（同） |

**结论**：Copero 的留存公式 = **种子复现 × 明牌赔率 × 高决策密度 × 泥到石 × 生涯叙事 × 成就长线 × WhatsApp 分享卡**。
本仓库把"种子分享"升级成可复现比拼，并补上了 Copero 缺的"复合传承分 + roguelike 元进度（祝福/飞升/解锁）"——即把 Copero 的"一次性生涯 sim"加上了"跨周目成长"，这正是 roguelike 化的关键一步。

---

## 4. 与 Copero 差异的复盘（研究后修正）

> 代码库远比 AGENTS.md 描述的成熟——经实际核查，研究初稿里列的"缺口"大多**已经实现**，且多处比 Copero 更强。真正剩下的、值得对齐的只有一处。

| 项 | 初稿判断 | 实际核查 |
|---|---|---|
| 强度三档（Intensa/Normal/Exprés） | 未提及 | ✅ 已实现 `PaceMode` long/normal/express，UI 已暴露（沉浸/标准/速通），分享 URL 已带 `m=` |
| "侧重联赛/洲际"改夺冠概率 | 可补 | ✅ 已实现 `club_priority` 事件（`leagueTrophyProbabilityMultiplier=2` 等） |
| 成就系统 | 未实现/可补 | ⚠️ **已实现 12 个**，但全是"赢没赢X/到没到Y"，缺 Copero 最驱动重玩的**生涯形态**目标（流浪汉/一生一队/巨人杀手/横扫五大联赛/六大洲/三球王/GOAT）——因为检测器只收 `{trophies,awards,maxOverall,seasons}`，无法表达跨俱乐部/联赛/大洲的形态。**本轮已补齐（见下）。** |
| 分享图片卡 | 缺 | ✅ 已实现 `exportCardImage`（canvas→PNG，含宿敌行+种子挑战 CTA+中文），且比 Copero 多了 seed 可复现 |

### 本轮已落地的对齐（commit 待提交）

扩充成就检测输入为 `AchievementInput`（新增 `totalGoals / distinctClubs / distinctConfederations / oneClubCareer / bigFiveLeagueWins / smallClubContinental / trebleSeason / injuriesTaken / nationFifaRep`），由纯函数 `computeAchievementInput(game)` 从 `seasons` + `leagueById/clubById/nationById` 一次性算出。成就从 12 个扩到 **23 个**，新增 11 个 Copero 风味"build-defining"长线目标：
- `巨人杀手`（小俱乐部夺洲际 = Matagigantes）
- `一生一队`（一队生涯+联赛+杯赛+洲际 = Leyenda del club）
- `足坛浪子`（≥8 家俱乐部 = Baldosero）
- `环球旅人`（≥4 大洲足联 = Nómade）
- `横扫五大联赛`（五大联赛都夺联赛 = Dueño de Europa）
- `无冕之王`（≥8 赛季 0 冠 = Ringless）
- `三球王`（2 世界杯+350 球 = Só o Pelé）
- `金靴机器`（3 金靴 = Terror de las redes）
- `史上最佳`（1 世界杯+2 洲际+3 金球 = GOAT）
- `美洲之王`（洲际国家队+洲际俱乐部 = Rey de América）
- `黑马封王`（弱国 FIFA≤2 夺世界杯 = Héroe nacional）
并顺手修复 `三冠王`（原按生涯累计误判，改为单赛季 `trebleSeason`）与 `铁人`（原以≥20 赛季近似，改为 `injuriesTaken===0 && seasons>=15`）。成就墙 UI 无需改动（auto-fill 网格遍历 `ACHIEVEMENTS`），进度显示自动变为 `0/23`。`npm run build` + `lint` 均通过。

---

## 5. 来源（Sources）

- 实操：agent-browser 隔离会话 `copero-research`，实跑一局 16→40 岁（阿根廷/DC/Normal）。
- 页面：`https://copero.com.ar/juegos/simulador-carrera`（SPA，React+Vite）。
- 游戏逻辑 chunk：`https://copero.com.ar/assets/CareerSimulatorPage-DW_0IenV.js`（643KB，反查事件/RNG/分享）。
- 分享卡 chunk：`/assets/share-card-export-CsEnxtOp.js`、`/assets/share-2-BW7w4Tit.js`。
- localStorage 键：`copero:minigames:career-simulator:preferences:v1`、`...:play:v1:{seed}`、`...:language:v1`。
- 本仓库对照：`PRODUCT.md`、`AGENTS.md`、`src/engine/`（rng.ts/run.ts/sim.ts/events.ts）。
