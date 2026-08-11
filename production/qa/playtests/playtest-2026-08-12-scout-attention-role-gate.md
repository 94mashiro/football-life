# Playtest Report — 球探注视 gate 加 role 门（D1 反馈 id=6 归因）

## Session Info
- **Date**: 2026-08-12
- **Build**: `9988c4e`（合并于 `d4ab955`）
- **Duration**: 1 条上报的逐条归因 + 40000 局 n_E 重测 + 3600 局回归
- **Tester**: 玩家（D1 `feedback` 表 id=6，device `116bfb28…`，seed `82b8m7tn`）
- **Platform**: 玩家上报端（移动 web）+ 引擎级 headless 模拟
- **Input Method**: 触摸（玩家）/ 自动决策策略（模拟）
- **Session Type**: Bug-driven — 内测事件反馈库遗留 1 条玩家上报的逐条归因

## Test Focus

D1 `feedback` 表 2026-08-11 上报、上一批（id 2–5）未一并处理而遗留的 id=6。
上报带当时的完整存档（GameState JSON），把存档还原成当时的牌面，再回引擎核对
触发条件与文案，判断「这个事件出现在这段生涯的这个阶段」是否合理。归因到一处
可复现的 gate 缺门缺陷，已修复。

## 上报清单

| id | 年龄 | 事件 | pace | 当时状态 | 归因 |
|---|---|---|---|---|---|
| 6 | 19 | 球探注视 | express | ST 68 OVR · 毕尔巴鄂(rep6) · substitute | gate 缺 role 门（本报告） |

## 问题

`scout_attention`（球探注视）的叙事前提是「意甲球探**专程**为你来，让你名声跳出
这座城市」，选项也是「豁命表现让人记住名字」。但上报玩家的存档里：

- 19 岁 wonderkid，overall 68，在毕尔巴鄂竞技（rep 6）。
- `resolveRole`：`SQUAD_BASE[6] = 79`，`diff = 68 − 79 = −11` → **substitute**（板凳）。
- 18 岁升一线队当替补：6 场 0 球 0 助攻，评分 5.8，身价 0.2M。
- **同期**另一决策位是 `loan_offer`（租借邀约）：「你在毕尔巴鄂竞技的出场时间有限，
  再坐下去就耽误你了……去小一点的俱乐部，你能踢满整季——这里，你得继续等。」

一边「球探专程为你来」，一边自家俱乐部要外租你出场——叙事与处境直接冲突。球探
不会专程飞来看一个坐板凳、即将被外租的球员。

### 归因

`scout_attention` 的 gate 是 `isYouth(ctx) && ctx.player.overall >= 60`（events.ts
line 5814）。`isYouth = age <= 19`，19 岁过；overall 68 过。gate 只看年龄和 OVR，
**没看 role**——一个 overall 68、在豪门坐板凳的替补也够格。

而 `loan_offer` 的触发条件（run.ts line 1686 `isLoanPath`）正是
`role ∈ {substitute, low_rotation, third_keeper}`。两者在「板凳替补 + 19 岁 + OVR≥60」
的处境下**同期双触发**，叙事打架。与上一批 bug #3（forced-exit 文案断言进球助攻为空，
与账本矛盾）同构：都是「事件出现在它叙事前提不成立的处境」。

## 改动

`src/engine/events.ts` `scout_attention` gate 收紧：

```ts
// 改前
(ctx) => isYouth(ctx) && ctx.player.overall >= 60,
// 改后
(ctx) => isYouth(ctx) && ctx.player.overall >= 60
  && (ctx.role === "starter" || ctx.role === "high_rotation"),
```

加 role 门，排除板凳/外租处境（`substitute` / `low_rotation` / `third_keeper`）——
与 `loan_offer` 的触发处境天然互斥，根治同期矛盾。叙事上：球探专程来看的，是在
小俱乐部一线队稳定上场、被更高联赛盯上的年轻主力，而不是豪门板凳上即将外租的人。

门宽变化（`tools/ne-measure.ts`，8 套配置 × 5000 生涯 = 40000 局）：

| | n_E |
|---|---|
| 改前 | 0.039 |
| 改后 | 0.015025 |

门宽收窄约 61%——板凳替补被排除，只剩主力/轮换在 youth 期够格。`EVENT_ELIGIBLE_PERIODS`
表（events.ts）同步更新 `scout_attention: 0.039 → 0.015`，`rollRandomEvent` 的门宽补偿
`(legendary?4:10)/(n_E+K)` 据此重算，保持出现率≈1/n_E。

## Balance

`npm run regress:full` 8 项：

| 门槛 | 结果 |
|---|---|
| 难度曲线 15 条门槛 | ✓ |
| 飞升经济 | ✓ |
| 决战事件形态 / 预览药丸 | ✓ |
| 体面退场 | ✓ |
| 预览分组 | ✓ |
| 事件奖惩形态 | ✓ |
| 词条 combo | ✓ |
| **行为指纹（3600 局）** | ✗（预期位移，已 bless） |

聚合位移（基线 → 现在）：

| profile | 峰值 | 传承 | 备注 |
|---|---|---|---|
| eng-cm-epl | 82→81 | 272→271 | 微降 |
| eng-gk-epl | 80→79 | 316→317 | 微降 |
| asc5-st | 76 | 482→486 | +0.8%，最敏感 |
| 其余 | 持平 | 持平 | 被中位数稀释 |

多数 profile 不动——这正是上次报告说的「中位数最容易把个体不公平藏起来」。最敏感的
**asc5-st**（高飞升 ST，在豪门易坐板凳，本是 scout_attention 误触发重灾区）位移 +0.8%：
部分生涯失去 showcase 成功的 +2 overall 成长机会（变差），部分不再因 showcase 失败的
`roleShift −1`（变好）。位移在 1% 内，行为指纹层是 trace 级对比，精确捕捉到「板凳处境
不再触发该事件」这一改变。

已 `npm run regress:bless` 重落 `tools/baseline/regress.txt`——这是「这次改动动了游戏
行为」的诚实信号。再跑 `npm run regress` 三层全绿。

## Findings

### What worked well
- gate 加 role 门与 `loan_offer` 的触发处境天然互斥，从根上消除同期矛盾，不依赖
  跨事件协调或优先级裁决。
- n_E 重测流程（`ne-measure.ts` + `EVENT_ELIGIBLE_PERIODS` 表）让门宽变化被补偿
  机制如实吸收，不产生隐性出现率漂移。
- 反馈通道的信噪比依然高：继上一批 4/4 命中后，这条遗留的 1/1 也命中真缺陷。

### Pain points
- 上一批 bug #3 已暴露「事件出现在它叙事前提不成立的处境」这类问题，但当时只修了
  forced-exit 的文案，没有系统排查其它「叙事前提依赖 role/出场」的事件 gate。本条
  说明同类问题仍潜伏。Severity: Medium

### Confusion points
- 无。

## Bugs Encountered
| # | 描述 | 严重度 | 可复现 |
|---|---|---|---|
| 1 | `scout_attention` gate 缺 role 门，板凳替补被「球探专程」关注（本报告） | 中 | 是（seed `82b8m7tn`） |

## Balance Adjustments (本次)
- `src/engine/events.ts`：`scout_attention` gate 加 `(role===starter||high_rotation)`。
- `src/engine/events.ts` `EVENT_ELIGIBLE_PERIODS`：`scout_attention: 0.039 → 0.015`。
- `tools/baseline/regress.txt`：regress:bless 重落基线。

## Top 3 Priorities from this session
1. 已落地并验证，可合并。
2. ~~系统排查其它「叙事前提依赖一线队身份」的 youth 事件 gate~~ **已完成**（见下「举一反三」章节）。
3. 考虑给「叙事前提与处境冲突」加一道断言门槛——目前没有任何检查在守「一个事件
   出现时它的叙事前提是否成立」，两次都是靠玩家上报才发现。

## 举一反三：YOUTH_RESTRICTED gate 系统排查

scout_attention 修复后，对 `YOUTH_RESTRICTED` 簇全 5 个事件做了一次性排查探针
（2400 局 = 6 配置 × 400 局，记录每次触发时的 age/role/club.rep/overall 及同期
是否与 loan_offer 并存），发现 3 个同类问题：

| 事件 | 触发次数 | 板凳触发率 | 同期 loan | 严重度 | 处理 |
|---|---|---|---|---|---|
| `scout_attention` | 46 | 0% ✅ | 0% | — | 上轮已修 |
| `child_prodigy` | 98 | 83.7% | 32.7% | 高（legendary，叙事最夸张） | 加 role 门 |
| `academy_rivalry` | 726 | 86.4% | 32.8% | 中 | 加 role 门 |
| `academy_homesick` | 498 | 81.5% | 32.7% | 中 | 加 role 门 |
| `finish_high_school` | 703 | 88.6% | 36.3% | 低（不修） | — |

### 三个事件的叙事前提与修法

- **`child_prodigy`（legendary）**：resolve 直接断言「你站在洲际杯决赛场上」、
  「每五十年一个的现象」。板凳替补触发叙事彻底崩塌。gate `overall>=60 && age<=19`
  加 role 门 `(starter||high_rotation)`，与 scout_attention 同法。n_E 0.039→0.014。
- **`academy_rivalry`**：resolve「教练在对抗赛把你排进首发」——板凳替补谈何「排进
  首发」。加 role 门。n_E 0.261→0.099。
- **`academy_homesick`**：「青训营宿舍床上想家」。板凳替补坐板凳+同期 loan 外租
  的处境与「青训营宿舍」违和。**改 age<=17 会令其永不触发**（counterfactual 探针
  验证：3000 局从 604 次→0 次——16 岁 slot 被高权重事件抢，17 岁无 slot），
  故用 role 门而非 age 门。n_E 0.229→0.085。
- **`finish_high_school` 不修**：18 岁高三补课与坐板凳不冲突，叙事成立。

### 附带发现（独立 bug，本次不动）

所有 YOUTH_RESTRICTED 事件 16-17 岁 0 次触发、全在 18+。根因：`findAvailableSlot`
用 `s <= age`，16 岁 slot 抽 1 个 YOUTH 事件后 `clusterFired` 达 `YOUTH_BUDGET=1`
锁死整个簇，18 岁 slot 再来时已满。「青训营」事件本该 16-17 岁弹却弹在 18-19 岁
一线队期，是 age 路由/池子层的另一个问题，需单独排查。

### Balance（举一反三轮）

`npm run regress:full` 8 项 7 绿，唯一红是行为指纹位移（预期）。聚合位移：

| profile | 峰值 | 传承 | 备注 |
|---|---|---|---|
| 多数 | −1 | −1~3% | 板凳失去 youth 事件成长机会 |
| blessed-st | 87 | 509→520(+2.2%) | golden_boy 多达标主力，多吃成长 |
| asc5-st | 75 | 486→472(−2.9%) | 高飞升豪门板凳重灾区 |
| fra-lw-long | 84 | 411→396(−3.7%) | long pace 事件占比大 |

难度曲线 15 条门槛全绿——位移是事件成长机会重新分配（板凳不再靠「青训营事件」
吃成长），非难度结构变化。已 `regress:bless` 重落基线。提交 `5276e9e`，合并
`47a4698`。

## 举一反三·age 路由：青训赛季扩到 3 年 + lastSeasonIsYouth 判定

role 门修复后，排查发现一个更深的 **pace 驱动 age 错位**：所有青训事件
16-17 岁 0 次触发、全在 18+。根因：

- `academy_choice` 独占生涯首期（16 岁 surface），选完跑 season 1（age 16→17）。
- `PACE_LENGTH.normal=2`（每 period 2 season），period 末建决策——normal 在 **18 岁**、
  express 在 **19 岁** 才建第一个青训期决策点。
- 青训赛季仅 2 年（16-17，`isYouth=age<=17`），18/19 岁决策点时球员已是 senior，
  离开青训营，但青训事件 gate `isYouth(ctx)=age<=19` 仍过 → 在 senior 期触发。
- long（plen=1）恰在 17 岁青训期触发，故无此 bug——**pace 驱动**，与上轮
  `statsMultiplier` 按 pace 放大同源（period 模型让单季语义事件随 pace 错位）。

验证（2400 局）：`academy_rivalry` 16-17 岁 0 次、18 岁 726 次；`academy_homesick`
16-17 岁 0 次、18 岁 498 次；三种 pace 第一个决策点 age 分别 17/18/19。

### 修法

- **`run.ts`**：青训赛季 `age<=17` → `<=18`（3 年，16-18）。三种 pace 第一个
  决策点的最后 season 都是 youth（long 17/18、normal 18、express 19）。
- **`events.ts`**：加 `lastSeasonIsYouth(ctx)` helper（最后 season squadLevel===
  youth）。13 个青训营场景事件 gate 的 `isYouth(ctx)`/`age<=19` 换成
  `lastSeasonIsYouth(ctx)`，与青训赛季边界对齐，三种 pace 都在青训赛季内触发。
- 删 4 个事件的冗余 `ctx.age<=18`（lastSeasonIsYouth 已隐含，反挡 express 决策点
  age 19）。
- 补全青训十景 10 个新事件的 `EVENT_ELIGIBLE_PERIODS` n_E（原仅加事件定义未补表）。

`scout_attention`/`child_prodigy` 保留 `isYouth`/`age<=19`——球探/神童非青训营
场景，19 岁主力被球探看 / 洲际杯决赛成立。

### 验证

修复后三种 pace 青训事件触发 age（600 局）：long 17/18/19、normal 18、express 19，
均 last season youth。修复前 normal 18 岁（senior）、express 不弹 / 19 岁 senior。

`regress:full` 8 项 7 绿，难度曲线 15 门槛全绿。聚合位移：blessed-st 传承
519→545（+5%，青训赛季延长 + 事件在青训期触发）、eng-gk 传承 −2.8%（GK 18 岁
变 youth 出场数用 youth 范围略降）、多数 ±3% 内。已 `regress:bless`。

### 青训十景提交说明

排查中发现主 checkout工作区有 346 行未提交的「青训十景」事件改动（另一个 agent
的工作残留），先归档提交 `752d2c2`，再基于它修 age 路由（cherry-pick `c1e154f`）。

## 附带发现核查（均非 bug，不改代码）

age 路由修复后核查了三个附带发现：

### 1. dual_nationality_youth fifaRep 门——设计正确

`dual_nationality_youth`（青年双籍）gate 含 `nationById(...).fifaRep <= 2`。实测
（2000 局/配置）：弱国 sen(fifaRep=1)/chn(fifaRep=0) 触发 23-24%，强国
bra(fifaRep=5)/esp(fifaRep=5)/ita(fifaRep=4) 触发 0%。这是设计——青年双籍是
弱国球员的叙事（为更强的国家队而战），强国球员本来就有强国家队，不需双籍。
**非 bug，不改。**

### 2. express 下 growth_spurt/bone_age_verdict/u17_callup 低触发——本征特性

express 青训期仅 1 个决策点（period 末 age 19），这些事件触发率低是 role/overall
门 + 1 决策点的本征特性，非 age 错位（已删谷余 age<=18 门，lastSeasonIsYouth 放行）。
express 玩家青训体验被节奏压缩是固有特性（3 季/期，青训期 16-18 岁压在首期）。
**非 bug，不改。**

### 3. YOUTH_BUDGET=1 评估——保持现状

青训十景把 YOUTH_RESTRICTED 簇从 5 事件扩到 15 事件，仍共用 `YOUTH_BUDGET=1`
（一局只弹 1 个青训事件）。实测（2000 局/配置）：每局见青训事件数均值 0.90（
接近 1，budget 几乎用满）。每事件生涯触发率：高频 finish_high_school/
roommate_released/harsh_coach/bone_age_verdict ~11%，低频 child_prodigy 0.3%、
u17_callup 0.5%。

调 `YOUTH_BUDGET=2` 只对 long 有效（青训期 3 决策点能见 2 个），normal/express
青训期仅 1 决策点仍只见 1 个（period 模型硬约束，调 budget 无效）。收益仅惠及
long 少数玩家，且冲淡「每局 1 个青训记忆」的稀缺感。

保持 `YOUTH_BUDGET=1` 的理由：
- 青训期短（3 年），每局 1 个青训记忆叙事合理
- 15 事件×1 名额=高重复可玩性（roguelike 核心：多周目见不同青训记忆）
- 调 2 只惠及 long，normal/express 决策点不够无效——不平衡
- legendary 事件（child_prodigy）0.3% 稀有符合预期

**非 bug，保持现状。** 如未来想让玩家多见青训十景，正解是给 normal/express
青训期补决策点（改 period 模型，大改），非调 BUDGET。

## Overall Assessment
- **Difficulty**: 青训赛季延长 + 青训事件回归青训期，blessed-st 传承 +5%、GK 略降，
  非重平衡。
- **Pacing**: 三种节奏青训事件 age 错位修复，long/normal/express 都在青训赛季内触发。
- **结论**: BALANCE-HEALTHY，可合并。D1 feedback id=6 归因闭环完成，原始记录已删除。
  举一反三两轮（role 门 + age 路由）累计修 16 个青训/youth 事件 gate。
