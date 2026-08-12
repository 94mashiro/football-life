# 飞升奖赏 = 榜位，不是传承币加成（删 ASCENSION_REWARD_CURVES 溢价曲线）

## 背景

飞升（ascension）的奖赏曾由 `applyAscensionLegacyReward` 的**逐级补偿曲线**承担：
`f_asc(raw) → meta`，A0 identity、A10 tailSlope ×4.08，配合逐级累计溢价。设计意图是
「高难高收益」——同一份实绩在高飞升结算成更多传承币。

业主复盘后否决了这个前提：

1. **超出货币设计预期**。A10 极限（满威望高手 + 好局）能结算到 9000+ 传承币，而传承
   币是**可复利累积的永久解锁货币**（买祝福、献祭轮回）。9000+ 的爆炸让高飞升成为最优
   货币农场，与「轮回献祭要降回低飞升攒钱」的循环设计冲突。
2. **奖赏错位**。业主定调：应给玩家**自由选择飞升难度的权利**——想挑战极限的选高难度，
   奖赏是**排行榜上的高位亮相**，而不是对传承币的加成。当前加成体系「太夸张」。

竞品调研（`docs/research/ascension-reward-competitors.md`，主源为各游戏官方 wiki）证实：
StS / Hades / Hades II / Balatro / Dead Cells **没有一家**对「可复利累积的永久解锁货币」
按难度做每局乘法曲线——
- StS 给榜单分数 +5%/级（+100%@A20），但 StS 没有可花费的元货币，加成只落在榜单分；
- Hades/Hades II 用**一次性阈值悬赏**（首通制），货币不被 Heat 乘；
- Balatro 难度奖赏是**纯解锁链**，无货币；
- Dead Cells 部分膨胀**线性消耗品**（cells），但不膨胀复利货币。

绿茵轮回当前的「每局 raw ×曲线系数 → 复利货币」在竞品中是异类，也是 9000+ 爆炸的根因。

## 决定

**结算传承 = 实绩（raw），全档不增不减（identity）。** 高飞升的奖赏是榜单的飞升优先
排序，不是传承币加成。

- `src/meta/legacy.ts`：删 `ASCENSION_REWARD_CURVES` / `AscensionRewardCurve` /
  `ascensionLegacyMultiplier` / `ascensionRewardSummary`；`applyAscensionLegacyReward`
  降为 identity（保留命名接缝——scoreLegacy 调它，未来若重引入难度奖赏这是唯一挂载点，
  须先过竞品调研 + design-review 门）。
- `ASCENSION_UNLOCK_REQ` 改读 **raw** 分位（`tools/ascension-reanchor` 重锚，N=160，同
  economy-check 口径），命中率意图不变（~40-45% 早期档 → ~7-13% 顶部）。identity 后
  `bestByAscension` 自动存 raw，门与分位同口径。
- UI（`App.tsx`）：飞升选择器删「结算传承 · 最高享受 ×N 加成」行（identity 下全 ×1.0，
  是噪音且「加成」一词已失实）；shelf-sub 改述新奖赏模型（Layer A 文案，零「加成」零
  dev jargon）；结算页 hero 删「实绩 X · 飞升N 加成 ×Y」分解行（identity 下恒 ×1.00）；
  头部/ModeBand 的「最佳」改读 `bestRunRaw`（诚实可超越，旧 `bestRun` 可能停在改版前
  通胀值永远不被新 raw 超越）。`index.css` 删死掉的 `.as-reward*` 规则。
- 回归：`tools/_meta-corpus.ts` 的 `ascension-reward` 指纹段改为钉 identity（任何重新
  引入曲线的回归都翻红）；`tools/ascension-economy-check.ts` 5 条门槛重写——旧门槛
  断言「高难高收益」（identity 下全红），新门槛断言「identity + 货币随飞升单调不增 +
  无任何溢价」。

### 与 ADR-0004 的关系

ADR-0004 明文：「单调性是 meta 经济 `ASCENSION_REWARD_CURVES`（A10 名义溢价 ×4.08）
『高难高收益』成立的前提」——即为保这条溢价曲线的单调性，专门建了 `ASC_CEIL_DROP`
可见天花板轴。本 ADR **逆转该前提**：高难不再有货币溢价，单调性不再服务货币曲线。
ADR-0004 的**其余结论保留**（删 `ASC_DEV_DRAIN` 隐藏暗扣、天花板轴、从严角色门控、
「经世界反应可感知」diegetic 铁律）——它们管的是「飞升如何让 raw 更低」，与本 ADR
「raw 如何结算成货币」是两条独立轴。天花板轴不再为货币曲线的单一性兜底，但仍为
「各档峰值单调可感知递减」服务（飞升选择器读档位 desc 时玩家仍要感到越往上越难）。

## 考虑过的替代方案

- **保留曲线但压低 tailSlope**：不解决根因——任何 >1 的乘法落在复利货币上都会让高飞升
  成为更优农场，只是爆炸更小。业主已否决「高难高收益」前提，压参数是绕开决策。否决。
- **改成 Hades 式一次性阈值悬赏**（如「首次飞升 5 退役 → 一次性传承奖励」）：是一条
  可行的**额外**奖赏通道（不与每局结算挂钩、不形成复利），但属新增功能、超本轮范围。
  记为未来设计空间，本轮不做。
- **解锁门改通关门**（竞品 StS/Dead Cells/Balatro 多数派：在 N 打通关 → 开 N+1）：
  绿茵轮回生涯**没有二元胜负**——每段生涯都以退役收尾，不存在「通关」事件，故门必须是
  「打得多好」而非「是否通关」。分数门槛是对该约束的合理回应。业主已选「保留技术阶梯」，
  故保留分数门槛、只把读数从通胀 meta 改成 raw。详见调研文档「取舍 A」。
- **老存档 bestByAscension 通缩回 raw**：旧值是通胀 meta，比新 raw 门大。业主定调
  「旧 meta ≥ 新 raw 门」祖护——不回锁。「harder counts down」（`bestAtOrAbove` 取
  L-1 及以上）让超授**有界**：最多到「打过的最高档 +1」，不会越级白送整梯。无需通缩
  迁移、无需 bump VERSION（schema 不变；`bestByAscension` 语义从 meta 平移到 raw，由
  门比较口径自然处理）。已知代价：老存档飞升选择器的「当前 X / 门槛」会短暂显示旧通胀
  meta 对新 raw 门（X 远大于门槛），打一局新 run 即自愈——纯展示，一次性。

## 后果

- **货币农场明确落在低飞升**：高飞升因 raw 更低而赚得更少，轮回献祭要降回低飞升攒钱
  （与循环设计一致）。`ascension-economy-check` 的新门槛守这条不变量。
- **榜位是高飞升的唯一奖赏**：榜单飞升优先排序（已有，不改）兑现「高飞升排高位」，
  不需要膨胀任何数字——比 StS 更克制（StS 至少膨胀榜单分 +5%/级，绿茵连这个都不膨胀，
  纯靠排序顺序）。
- **评级不变**：评级（球神/传奇/…）一直读 `rawLegacy`（难度无关），本改动不碰它。
  identity 后 `legacy === rawLegacy`，二者同值；评级与「最佳」数字现在一致（旧系统里
  通胀货币 vs 难度无关评级的割裂消失）。
- **老存档「最佳」数字可能下降**：头部/ModeBand 改读 `bestRunRaw` 后，旧存档显示从
  通胀 bestRun（可能 3000+）落回 raw（可能 250）。这是诚实的——旧 3000 是通胀假象，
  新 250 是真分，且能被新 run 超越。一次性观感下降，已在 ADR 记录。
- **regress 三层指纹全动**：行为层（game.legacy 变小）、文案层（选择器/结算页 copy
  改）、元进程层（曲线删 + 门槛重锚 + scoreLegacy 输出变）——皆为本改动预期，`regress:bless`
  重建基线。`ascension-economy-check` 5 条门槛语义重写，须与新标定一致。

## Status

accepted — `applyAscensionLegacyReward` identity + `ASCENSION_UNLOCK_REQ` 重锚 raw +
选择器/结算页/头部 UI 改 + `_meta-corpus`/`ascension-economy-check`/`ascension-reanchor`
探针改 + 本 ADR 已落地。待 `regress:full` 全绿 + `regress:bless` 重建基线后收尾。
竞品依据见 `docs/research/ascension-reward-competitors.md`。
