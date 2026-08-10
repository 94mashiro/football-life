# Playtest Report — 飞升高手奖励与提前结算防刷（批模拟）

## Session Info

- **Date**: 2026-08-11
- **Build**: `codex/retire-ascension-economy`
- **Duration**: 逐级 4,400 局；专项经济门 640 局；强祝福/满威望对照 1,600 局；固定回归语料 3,600 局
- **Tester**: 确定性自动策略（普通固定策略、熟练转会策略、满威望高手构筑）
- **Platform**: 引擎级 headless 模拟 + React/TypeScript production build
- **Input Method**: 自动决策策略
- **Session Type**: Targeted test — 传承产出、防刷与高端玩家分层

## Test Focus

验证三个目标：常驻挂靴不能提前兑现；普通玩家提高飞升不会获得更高刷分效率；满威望高端玩家在 A10 的高表现尾部能与普通玩家拉开明显差距。祝福价格保持不变。

## First Impressions (First 5 minutes)

- **Understood the goal?** Yes
- **Understood the controls?** Partially（本轮为 headless，界面仅做静态与构建验证）
- **Emotional response**: Engaged
- **Notes**: 单一高倍率无法同时满足防刷与高手奖励；表现门控能把增量集中到真正高分局。

## Gameplay Flow

### What worked well

- 常驻生涯出口只保留“挂靴”，确认文案明确列出“不结算传承、不进档案、不上传排行榜”。
- 普通 A10 中位收益仅为 A0 的 62.0%，每赛季效率为 76.8%，没有短局速刷优势。
- 满威望高手 A10 中位收益为 A0 的 103.3%，但 P90 为 136.9%，奖励集中在高表现尾部。
- Smoothstep 让 300→600 原始传承区间连续兑现，不产生单点阈值套利。

### Pain points

- 真人单局时长尚未采集，当前“每赛季效率”只是“每分钟效率”的代理指标。Severity: Medium
- 满威望高手 A10 P90 已接近目标上界 1.40，需用上线数据监控 P95/P99。Severity: Low

### Confusion points

- “基础倍率”和“高表现最高倍率”是新概念；飞升选择器已同时显示两者，并说明 300→600 的兑现区间。

### Moments of delight

- A10 满威望高手 P90 从 2,570 提升到 3,327（+29.5%），高端构筑的成功局有明确冲榜爆发感。

## Bugs Encountered

| # | Description | Severity | Reproducible |
|---|---|---|---|
| 1 | 无功能性错误；新增经济门、全量回归、lint、build 均通过 | — | — |

## Feature-Specific Feedback

### 常驻挂靴

- **Understood purpose?** Yes
- **Found engaging?** N/A
- **Suggestions**: 上线后检查新记录中 0 高级联赛赛季、主动退役上传是否降为 0。

### 表现门控飞升倍率

- **Understood purpose?** Yes
- **Found engaging?** Yes
- **Suggestions**: 保留 A10 ×3.00 的高手上限；若真实产出过高，优先调整 600 满倍率点。

## Quantitative Data

| 样本 | A0 中位 | A0 P90 | A10 中位 | A10 P90 | A10/A0 中位 | A10/A0 P90 |
|---|---:|---:|---:|---:|---:|---:|
| 普通路线 | 400 | 860 | 248 | 453 | 0.620 | 0.527 |
| 满威望高手 | 1,717 | 2,742 | 1,774 | 3,753 | 1.033 | 1.369 |

- **普通每赛季效率**: A0 17.4，A10 13.4（比值 0.768）
- **强祝福熟练路线**: A0 511 / 1,020；A10 273 / 852（中位 / P90）
- **独立满威望对照**: A0 1,657 / 2,570；A10 1,584 / 3,327
- **Regression**: 8/8 门通过，含新增 `ascension-economy` 6 条断言

## Overall Assessment

- **Would play again?** Yes
- **Difficulty**: Just Right（普通 A10 付出明确，高手成功局有奖励）
- **Pacing**: Good
- **Session length preference**: 需真人遥测确认

## Action Routing

- **Design changes needed**: 无阻塞项
- **Balance adjustments**: 当前无需继续调数值；上线后观察满倍率达成率与高分尾部
- **Bug reports**: 无
- **Polish items**: 可在后续为高表现倍率增加结算页拆解，但不应在本次扩大范围
- **CD-PLAYTEST**: Lean mode，跳过（非 phase gate）

## Top 3 Priorities from this session

1. 上线后按版本监控 A7–A10 的传承/分钟与 <8 赛季结算占比。
2. 监控 A10 原始传承 ≥600 的达成率、P95/P99 和设备集中度。
3. 一周后再评估祝福价格与 15,000 威望门槛；当前保持不变，避免同时改动产出和消耗导致归因失败。
