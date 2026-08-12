# 架构审查：绿茵轮回 整个项目

> 范围：`src/`（engine / state / meta / ui / api 全量）。基线状态：`tsc -b` ✅、`npm run lint` ✅（仅 `tools/` 2 处 unused-import，豁免）、`npm run regress` ✅（行为/文案/元进程三层未变）、`npm run regress:full` ✅（9 道门槛全绿）。
> 准绳：《重构》2ed 24 坏味道 + 61 手法；本仓库结构不变量（AGENTS.md「架构宪法」）。
> 裁决五道：行为可验证 / 经济值得 / 可小步 / 两顶帽子 / YAGNI。

## 结构不变量（Phase 2）

| 不变量 | 状态 | 证据 |
|---|---|---|
| 依赖单向 `ui → state → engine/meta` | ✅ | 无环。`data.ts` 零导入（叶节点）。`state → api → engine/meta`、`ui → api → engine/meta`，方向一致。 |
| engine 内不得 import React/DOM | ❌ **P0** | `src/engine/sfx.ts:35` `new (window.AudioContext …)` + `navigator.vibrate`（`buzz`）。仅 `App.tsx` 引用——UI 反馈模块错置在 engine。 |
| 确定性：engine 随机只能 `derive()`；`Math.random` 仅 `meta/legacy.ts` `randomSeed` | ✅（engine） | engine 内无 `Math.random`/`Date.now`；`meta/legacy.ts` 的 `Math.random`（randomSeed + prestigeChoices 洗牌）、`new Date`（dailySeed/todayStr/dailyStreak）均为文档化豁免。 |
| Reducer 纯函数；mutation 在 engine | ✅ | `store.ts` reducer 纯；`submitCareer` 走 `useEffect` 副作用，不进 reducer。 |
| 唯一豁免跨边 `events.ts → ttlTag from run.ts` | ✅ | 无新增未登记跨层边。`narrative.ts ← events.ts` 为 engine 内部（合规）。 |
| `types.ts` 零依赖 | ⚠️ 轻微 | `import type { Position, DevProfile } from "./data"`——**type-only，无环**（`data.ts` 零导入）。无运行时影响，违反字面但非结构风险。 |

**附带（非代码味道，是文档债）**：AGENTS.md「Architecture」一节**已过时**——未登记 `engine/narrative.ts`、`engine/names.ts`、`engine/images.ts`、`engine/sfx.ts`、`src/api/`（leaderboard + feedback）。后两者是 AGENTS.md 写就之后新增的层。建议补登 + 为 `api/` 立一条 ADR。

---

## 发现（按优先级）

### P0｜结构不变量违反

**P0-1 ｜ engine 层混入 DOM（`sfx.ts` 错置）｜ `src/engine/sfx.ts:35`**
- 坏味道：全局数据/可变数据的近亲——**engine 纯净性被破坏**（不变量「engine 内不得 import React/DOM」）。
- 证据：`new (window.AudioContext || …webkitAudioContext)()`；`buzz()` 内 `navigator.vibrate?.(pattern)`。整文件无 RNG、无 sim，纯 UI 音效/触觉反馈，仅被 `App.tsx` 引用。
- 处方：**搬移函数/搬移文件（8.1）**——移到 `src/ui/sfx.ts`，改 `App.tsx` 一处 import 路径。
- 类别：**纯重构**（无需 bless）。`tsc -b` 绿、`regress` 不触 sfx 故绿。
- 小步：① `git mv src/engine/sfx.ts src/ui/sfx.ts` ② 改 `App.tsx` import ③ `tsc -b` + `regress` 绿 → 提交。

### P1｜位于变更热路径（决策/模拟层 = 最常调平衡/加事件的地方）

**P1-1 ｜ 过长函数 + 重复 switch + 霰弹式修改｜ `src/engine/events.ts:600–5369`**
- 坏味道：**过长函数（#3）** + **重复的 switch（#12）** + **霰弹式修改（#8）**。
- 证据：`resolveEventOption` 是**单个 ~4769 行函数**，一个 `switch` 覆盖 **451 个 `"eventKey:optionKey"` case**。而每个事件的**定义**（title/desc/choices/odds）住在 5000 行之外的 `EVENT_DEFS`（5989–7299，~1300 行）。改一个事件的选项文案在 `EVENT_DEFS`，改它的后果在 4769 行 switch 里——两处必须靠 key 字符串对齐，漏改不报错（key 是 string）。
- 反例（同仓库已存在的正解）：`transferEvent`/`loanOfferEvent`/`worldCupShowdown` 等 builder 把 `event + resolve` 打包成一个 `FiredEvent` 闭包——定义与结果同处。`resolveEventOption` 是这条路线的**遗留未迁移部分**。
- 处方：**以多态取代条件表达式（10.4）**（TS 惯用：判别联合 + 每个 `EventDef` 自带 `resolve` 函数），让定义与结果同居，消除 5000 行 switch。先**提炼函数（6.1）** 把每个事件的 case 块抽成 `resolveXxx(ctx, optionKey, rng): ResolveResult`，注册到 `EventDef.resolve`，switch 兜底转发。
- 类别：**纯重构**（**无需 bless**）——前提是提取逐字保持 outcome 文本/数值不变；`regress` **文案层**逐行校验每条 outcome，任何走样立刻红。
- 小步（Branch-by-Abstraction，每步 `tsc -b` + `regress` 绿）：
  1. 给 `EventDef` 加可选 `resolve?: (ctx, optionKey, rng) => ResolveResult`；`resolveEventOption` 顶部 `if (def.resolve) return def.resolve(ctx, optionKey, rng)` 兜底，落空再走 switch（行为不变）。
  2. 一次一个事件：把该事件的所有 case 抽成 `resolveXxx`，挂到 `EventDef.resolve`，删 switch 里对应 case。每抽一个事件就跑 `regress`（行为 + 文案两层）。
  3. 重复 2 直至 switch 空壳，删除 `resolveEventOption` 的 switch 主体（保留薄分发或直接删）。
  4. 全程不碰 outcome 数值/文案——只搬位置。任何一步红了说明动了行为，**停下**而不是 bless。
- 经济性：决策层是 roguelike 最常调处（加事件/调赔率/改文案），命中率最高；4769 行 switch 的认知成本真实存在。**值得**。工作量大 → 列为战略级 P1，按事件分批长期推进，不阻塞其它工作。

### P2｜三次法则 / 变更路径、修复成本中等

**P2-1 ｜ 过长参数列表｜ `src/engine/run.ts` `buildPeriodDecisions`**
- 坏味道：**过长参数列表（#4）**。
- 证据：函数签名 **30 个位置参数**。`simulatePeriod` 是唯一调用点；`rebuildFiredEvent` 另起 `ctx`（不调用本函数）。
- 处方：**引入参数对象（6.8）**——`PeriodDecisionInput`。函数内部本就用这些参数拼 `EventContext`，多数参数直流入 ctx。
- 类别：纯重构。小步：① 定义 `PeriodDecisionInput` ② `simulatePeriod` 组装对象传入 ③ 函数体解构 ④ `tsc -b` + `regress` 绿。

**P2-2 ｜ 发散式变化｜ `src/engine/run.ts` 混编排 + 叙事文案**
- 坏味道：**发散式变化（#7）** + **依恋情结（#9）**。
- 证据：`run.ts`（编排层）里长出第二职责的叙事文案：`BEAT_TROPHY_NAME`/`BEAT_AWARD_NAME` 两个 Record、`appendSeasonBeats`、`appendNationalBeat`、`detectMilestone` 的 `commentary` 串、`finalizeRun` 的 `reasonText`/`postCareer` 串。而 `engine/narrative.ts` 已是「事件故事文案」的家——两套叙事文案分居两处，「改文案」会分别触碰、口径漂移。
- 处方：**搬移函数（8.1）**——把生涯节拍/里程碑叙事搬进 `narrative.ts`（或新建 `engine/career-narrative.ts`），`run.ts` 只调用、传 `seasons`。
- 类别：纯重构（文案层校验节拍文本逐字不变）。小步：① 搬 `BEAT_*` Record + `appendSeasonBeats`（自包含）② 搬 `appendNationalBeat` ③ 搬 `detectMilestone` 的 commentary 串 ④ 搬 `finalizeRun` 的 postCareer 串——每步 `regress` 文案绿。

**P2-3 ｜ 依恋情结（继续 ADR 0002 方向）｜ `src/App.tsx` 残留纯计算函数**
- 坏味道：**依恋情结（#9）**——纯计算（无 JSX）却反复读 engine/state 数据，住在 4644 行 UI 文件里。
- 证据：`leagueTitleOdds`、`careerEpitaph`、`signaturePeak`、`careerSignaturePeak`、`nationName`、`seasonRating`、`fmtCareerWage`、`fmtMv`、`rankOf`、`ovrPercentile`、`serverRankEntry`、`archiveRankEntry`、`ascTierHead`、`opensTier`、`pxRarity`、`careerUrl`、`parseCareerUrl`、`tally`、`seasonHighlight`、`seasonQuote`。
- 处方：**搬移函数（8.1）**——迁入 `ui/vocabulary.ts` 或新 `ui/career-format.ts`。**这正是 ADR 0002 已确立的方向**（该 ADR 已搬走 label/persona/tier 一族纯函数）。
- 边界（重要）：ADR 0002 **明确不授权**「全量拆 App.tsx 组件到 ui/」。本条只动**纯函数**，不碰组件。`regress` 不覆盖 React，但纯函数提取由 `tsc -b` 兜底（漏改引用即编译红）。
- 类别：纯重构。优先搬复用性最高的：`careerUrl`/`parseCareerUrl`（分享链编解码，可独立成 `ui/share-link.ts`）、`serverRankEntry`/`archiveRankEntry`（榜单映射）。其余按「下次路过那块 UI 再顺手搬」（营地法则）。

**P2-4 ｜ 文档债｜ AGENTS.md 架构节过时**
- 证据：未登记 `narrative.ts`/`names.ts`/`images.ts`/`sfx.ts`/`api/`。后续 agent 据过时架构图判断「engine 无 DOM」会漏掉 sfx.ts。
- 处方：补登 AGENTS.md Architecture 节 + 为 `api/` 立一条 ADR（说明 `api → engine/meta`、`Math.random` 仅用于 uuid 兜底非 sim、`new Date` 用于「今日」过滤）。低成本高收益。

### P3｜营地法则——记下，路过再捡，不建议现在动

**P3-1 ｜ 过大的模块｜ `src/meta/legacy.ts`（1272 行）**
- 坏味道：**过大的类（#20）** / **发散式变化（#7）**——混 blessings / ascensions / unlocks / achievements / prestige / scoring / seeds / migration ~6 个关注点。
- 裁决：AGENTS.md 指定 `meta/legacy.ts` 为「THE meta 模块」，且元进程回归层把它当整体跑；现在拆属过度工程。**明确：不现在动**。若未来加第 4 个 meta 关注点，再考虑拆 `meta/scoring.ts`/`meta/prestige.ts`。

**P3-2 ｜ 冗赘元素/死代码｜ `src/meta/legacy.ts:598` `UNLOCKS = []`**
- 坏味道：**冗赘的元素（#14）**。`UNLOCKS: readonly Unlock[] = []` 恒空；`isUnlocked` 走「列表命中 OR `totalLegacy ≥ req`」——列表恒空，全靠阈值路径。`App.tsx:1893` 对空列表 `.filter` 是 no-op。
- 处方：**移除死代码（8.9）** 删空列表 + `Unlock` 接口 + `isUnlocked` 的列表分支（保留阈值分支）；或注释保留理由。低成本，但无行为变更、回归元进程层会校验。**建议**：确认无消费方依赖列表后删。

**P3-3 ｜ 可变数据｜ `EventContext.naturalizationActive` 路由中改写**
- 坏味道：**可变数据（#6）**——`buildPeriodDecisions` 的两条 S 规则 `fire()` 里 `ctx.naturalizationActive = false/true`，事件 resolve 读它选文案。
- 裁决：ctx 每 period 新建、单线程，副作用局部；但「路由规则靠改共享对象传信」是隐式通道。处方可选：改为 `fireEventByKey(ctx, key, { naturalizationActive })` 参数。**现在不急**——路过归化逻辑时再收。

**P3-4 ｜ types.ts 字面「零依赖」｜ `import type { Position, DevProfile } from "./data"`**
- type-only、无环、无运行时影响。可**搬移字段（8.2）**把 `Position`/`DevProfile` 挪进 `types.ts` 让 `data → types`。但零行为收益、纯类型搬运。**明确不动**，除非未来 `data.ts` 要 import `types.ts`（届时顺手）。

---

## 明确不动（防后来者反复重提）

- **`App.tsx` 单文件 ~4644 行**：文档化决策；ADR 0002 **明令禁止**在无新 ADR 下拆组件。只有其中**纯函数**可搬（P2-3），组件不动。
- **`RngState` 单 box 原地 mutation**：性能决策（一次生涯数万次抽取），豁免。
- **`"name@ttl"` 字符串编码**：有 `ttlTag`/`decayTag`/`dedupeTags` 收口；绕开它们裸拼字符串才算基本类型偏执——当前未发现裸拼。
- **`setPreviewsEnabled` 模块级开关**：headless 批量模拟性能门，豁免。
- **`tools/` 一次性法证脚本**：不参与回归路径，不按产品代码标准审（2 处 unused-import 警告忽略）。
- **`sim.ts`**：~60 函数按 concern 分区（市值/评分/角色/数据/奖杯/国家队/奖项/成长/留用），无明显坏味道，不动。
- **`meta/persist.ts`**：纯 localStorage 适配器，单向 `persist → legacy` 无环，不动。
- **`ui/vocabulary.ts`**：ADR 0002 的产物，纯数据+纯函数，不动（继续往里搬纯函数见 P2-3）。
- **`mergeMods` 逐字段枚举 `Modifiers`**：这是**唯一收口点**（加一个字段只改这一处），是霰弹式修改的**解药**不是病——保留。
- **`narrative.ts` WeakMap memoization / `prestigeChoices` 的 `Math.random` 洗牌 / `dailyStreak` 的 `new Date`**：regress 文档化排除项，不动。

---

## 行为变更与结构调整的分界

本次审查范围是**整个项目快照**（无 diff）。所有处方均为**结构调整**，无行为变更意图。判据：每条都标了类别——**纯重构**（无需 bless，靠 `tsc -b` + `regress` 三层绿验证）或**长期重构**（Branch-by-Abstraction 分批）。**任何一步需要 `regress:bless` 即说明动了行为，必须停下**——那不再是重构，要走机制变更门（`game-design-core` + `roguelike` + `balance-check`）。

---

## 重构计划（按可执行顺序）

> 全程遵循 worktree 流程（AGENTS.md）。纯重构提交信息 `refactor: 中文描述`。

### 阶段 0 ｜ 立即（P0，单步）
- [ ] `git mv src/engine/sfx.ts src/ui/sfx.ts` + 改 `App.tsx` import → `tsc -b` + `regress` 绿 → `refactor: sfx 从 engine 迁到 ui（守住 engine 无 DOM 不变量）`

### 阶段 1 ｜ 文档对齐（P2-4，不碰代码）
- [ ] 补登 AGENTS.md Architecture 节（`narrative.ts`/`names.ts`/`images.ts`/`api/` + sfx 迁址）
- [ ] 为 `api/` 立 ADR 0003（依赖方向、`Math.random`/`new Date` 的非 sim 用途）

### 阶段 2 ｜ 低风险纯重构（P2，各独立小步）
- [ ] `buildPeriodDecisions` 引入参数对象（P2-1）
- [ ] run.ts 叙事文案搬入 `narrative.ts`/`career-narrative.ts`（P2-2，分 4 小步）
- [ ] App.tsx 高复用纯函数迁出：`careerUrl`/`parseCareerLink`→`ui/share-link.ts`；`serverRankEntry`/`archiveRankEntry`→近 RankEntry 处（P2-3 首批）
- [ ] `UNLOCKS = []` 死代码清理（P3-2，先确认无消费方依赖列表）

### 阶段 3 ｜ 战略级长期重构（P1-1，分批，不阻塞）
- [ ] `EventDef` 加 `resolve?` 字段 + `resolveEventOption` 兜底（基建，一步）
- [ ] 按事件逐个把 case 抽成 `resolveXxx` 挂上 `EventDef.resolve`，每事件跑 `regress`（行为+文案）绿
- [ ] 直至 switch 空壳，删主体。目标：events.ts 从 8737 行降至 ~3500–4000，定义与结果同居。

### 营地（路过再捡，不立项）
- P3-1 legacy.ts 拆分（等第 4 个 meta 关注点）
- P3-3 `naturalizationActive` 改参数传递（路过归化逻辑时）
- P3-4 `Position`/`DevProfile` 搬入 types.ts（等 data.ts 需 import types 时）
- App.tsx 其余纯函数继续往 vocabulary.ts/career-format.ts 搬（ADR 0002 持续推进）
