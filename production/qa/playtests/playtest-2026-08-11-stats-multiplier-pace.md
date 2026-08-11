# Playtest Report — 少踢倍率的节奏放大（批模拟）

## Session Info

- **Date**: 2026-08-11
- **Build**: `94mashiro/event-feedback-audit`
- **Duration**: 分节奏对照 5,400 局 ×2（改前/改后）；带%选项预览扫描 1,440 局；forced-exit 文案扫描 3,600 局；固定回归语料 3,600 局
- **Tester**: 确定性自动策略（first / last / varied）
- **Platform**: 引擎级 headless 模拟
- **Input Method**: 自动决策策略
- **Session Type**: Bug-driven — 内测事件反馈库 4 条玩家上报的逐条归因

## Test Focus

反馈库（D1 `feedback` 表，2026-08-10 ~ 08-11，共 4 条）每条都带着上报当时的完整
存档。把存档还原成当时的牌面，再回引擎核对触发条件与文案，判断「这个事件出现在
这段生涯的这个阶段」是否合理。4 条全部归因到可复现的缺陷。本报告覆盖其中的机制项
（`statsMultiplier` 的节奏放大），另三项（预览药丸被吞、文案对不上账本、半角逗号）
是展示/文案层，同批提交。

## 上报清单

| id | 年龄 | 事件 | pace | 当时状态 | 归因 |
|---|---|---|---|---|---|
| 2 | 25 | 毁灭性伤病 | express | GK 84 OVR | 少踢倍率按期放大（本报告） |
| 3 | 22 | 踢不出来 | express | ST 69 OVR | 文案断言进球助攻为空，与账本矛盾 |
| 4 | 36 | 射门消失 | normal | ST 80 OVR | 25% 选项零预览药丸 |
| 5 | 22 | 转会窗口 | long | ST 80 OVR | 半角逗号 |

## 问题

`Modifiers.statsMultiplier`（少踢）在 `simOneSeason` 里对本期**每一季**生效，而它的
同胞 `suspended`（整季停赛）只作用于 `seasonInPeriod === 0`。于是同一张卡在三种节奏
下代价差 3 倍，卡面却三种节奏都只画一个「出场减少」。

实测（`statsMultiplier = 0.1`，同一状态施加同一张卡，对照组为不施加）：

| pace | periodLength | 受影响赛季出场 | 对照（无卡） | 报销 |
|---|---|---|---|---|
| long | 1 | [5] | [47] | 1 季 |
| normal | 2 | [5, 3] | [47, 28] | 2 季 |
| express | 3 | [4, 4, 4] | [43, 44, 42] | 3 季 |

这是**单向**放大：全表 21 处取值 0.1–0.8，无一 >1，是纯罚项；而 `overallDelta` 每期
一次性应用、不随节奏放大。结果是 express 玩家拿同样的上行、吃 3 倍的下行——pace 本
是「几季一次决策」的节奏偏好，却成了没写在任何地方的难度旋钮。

上报 id 2 正是 express：25 岁 84 OVR 巅峰门将吃「毁灭性伤病」，卡面写「恢复期一年」，
实际报销 3 季。

### 归因（历史）

- `a33feba`（08-10）给 `suspended` 加上单季门，注释写明「真实足球里禁赛/伤停几乎一律
  只影响 1 季，不再随 periodLength 放大成整期 N 季」。
- `188993c`（08-10）引入 `statsMultiplier`，**没有**同步这道门，并把 7 个事件从
  `suspended` 迁到它上面。

即：那 7 个事件被从有门的杠杆搬到了无门的杠杆上，等于对它们恢复了同日刚被移除的
按期放大。`playtest-2026-08-10-suspension-severity.md` 验证了分档语义，但没有覆盖
「新杠杆缺一道旧杠杆已有的门」这一维。

## 改动

`run.ts` `simOneSeason`：`statsMultiplier` 与 `suspended` 同样收敛到本期第一季。

```
const eventStatsMult = seasonInPeriod === 0 ? (mods.statsMultiplier ?? 1) : 1;
const statsMultiplier = eventStatsMult * (nagInjury ? 0.6 : 1);
```

nag 轻伤不受这道门影响——它每季各自掷（`derive` 带 `seasonInPeriod`），本就是单季事件。
跨期的持续后果有自己的通道（`addTags` 带 TTL），不该借这个字段实现。

改后三种节奏统一报销 1 季，第二/三季出场与对照组**数值完全一致**（[5,28] / [4,44,42]）。

## Balance

分节奏对照，每档 1,800 局（ST/CM/GK × first/last/varied × 200 种子）：

| pace | 峰值 OVR 中位 | p10 | p90 | 传承中位 | 赛季中位 |
|---|---|---|---|---|---|
| long 改前/改后 | 85 / 85 | 70 / 70 | 95 / 95 | 266 / 266 | 18 / 18 |
| normal 改前/改后 | 82 / 82 | 71 / 71 | 92 / 92 | 229 / 229 | 20 / 20 |
| express 改前/改后 | 81 / 81 | 70 / 70 | 90 / 90 | **179 / 181** | 21 / 21 |

long 恒等（plen=1 时每季都是 season 0，本就是空操作）；normal 全等；express 只有传承
中位 +1.1%，其余全部不动。

聚合位移小是因为这类卡每局至多命中一两次，被中位数稀释——但对**命中它的那一局**是
3 季对 1 季。中位数正好是最容易把这种个体不公平藏起来的统计量，而玩家是按局体验的。

`npm run regress:full` 8 项中 7 项断言门槛全绿（难度曲线 15 条门槛、飞升经济、决战
事件形态、体面退场、预览分组、事件奖惩形态、词条 combo），唯一的红是预期的行为指纹
差异，已 bless。

## Findings

### What worked well
- 修复与 `suspended` 的既有先例同构，不引入第三种时序语义。
- 难度曲线未移动：这是修个别不公平时刻，不是重平衡。
- 反馈通道本身很准——4 条上报 4 条命中真缺陷，样本虽小但信噪比高。

### Pain points
- 回归语料库 8 个 profile 里只有 1 个 express、1 个 long，节奏维度覆盖偏薄，这次的
  聚合位移几乎被稀释干净。Severity: Medium
- 「新杠杆是否继承了旧杠杆的门」目前没有任何门槛在守。Severity: Medium

### Confusion points
- 无。

## Bugs Encountered
| # | 描述 | 严重度 | 可复现 |
|---|---|---|---|
| 1 | `statsMultiplier` 按期放大（本报告） | 中 | 是 |
| 2 | 净 0 分支使整个选项预览被丢弃（`reckless_challenge:own_it` 213/213、`lost_instinct:find_it` 59/59） | 中 | 是 |
| 3 | forced-exit barren 文案断言进球助攻为空，523 次触发中 334 次（63.9%）与账本矛盾 | 中 | 是 |
| 4 | 两处半角逗号 | 低 | 是 |

## Balance Adjustments (本次)
- `run.ts` `simOneSeason`：`mods.statsMultiplier` 收敛到 `seasonInPeriod === 0`。

## Top 3 Priorities from this session
1. 已落地并验证，可合并。
2. 语料库补一个 express/long profile，否则节奏维度的漂移长期看不见。
3. 考虑加一条门槛：**同一 mods 字段在 long/normal/express 下的生涯影响必须同量级**
   ——这次这类 bug 没有任何断言在守，是靠玩家上报才发现的。

## Overall Assessment
- **Difficulty**: express 略降（传承中位 +1.1%），long/normal 恒等
- **Pacing**: 一致
- **结论**: BALANCE-HEALTHY，可合并。
