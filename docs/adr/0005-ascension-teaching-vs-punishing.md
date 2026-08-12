# 飞升惩罚的 teaching-vs-punishing 重审（ADR-0004 铁律① 精确化后续）

## 背景

ADR-0004 删了 `ASC_DEV_DRAIN` 隐藏暗扣、确立"飞升对成长的影响须可感知、可对抗、单调"铁律。落地后复盘，玩家提出更锋利的原则：**玩家玩的是球员生涯代入，不是上帝视角——不需要感知游戏机制上的设计**。这把铁律①从"可感知"精确为"**经世界反应可感知（diegetic）**"：因果须经世界反应（大俱乐部邀约、教练说辞、身体恢复变慢）让玩家感知，而非经 UI 数字（培养上限标、衰退期标签）。

据此对 10 档飞升做 teaching-vs-punishing 审计：每档问——该档的难有 diegetic 反馈吗？玩家能学到因果（解困路径）吗？还是只能"承受"无反馈的卡死？

## 审计结论

| 档 | diegetic 反馈 | 判定 | 动作 |
|---|---|---|---|
| L1 从严 | ✓ 板凳→成长慢，转会当主力可对抗 | ADR-0004 已修 | 无 |
| L2 伤病潮 | ✓ 伤病可见、频率可感、ironman 可对抗 | teaching | 无 |
| L3 情报封锁 | ✓ 黑方块即体验（难=信息丧失）| teaching-by-experience | 无 |
| L4 岁月催人 | ✗ 衰退 onset 无声 | punishing | **加 diegetic beat** |
| L5 诸神黄昏 | ✓ 决战 odds 可见 | teaching | 无 |
| L6 天命难违 | ✓ odds pill 显示 | teaching（ADR-0004 正面样板）| 无 |
| L7 无人问津 | ✓ 无报价/留队失败可见 | teaching | 无 |
| L8 转会冻结 | ✗ 窗无声关闭，超越俱乐部却走不了无反馈 | **punishing** | **重设计** |
| L9 国家队弃子 | ✓ 赛前 desc（opt-in 教学契约）+ 未入选状态 | teaching | 无 |
| L10 全面降级 | ✓ 赛前 desc + 弱联赛体感 | teaching | 无 |

**L9/L10 不需修**恰因代入原则：玩家赛前 opt-in 已知机制，生涯中体验后果——中途加 beat 解释"因飞升 X"反而是上帝视角。代入原则**证明**了 L9/L10 的正确性。

真正 punishing 的只有 **L8**（机制重设计）+ **L4**（diegetic beat）。六档已合规。

## 决定

### L8 转会冻结：从"冻结窗"重设计为"冻结升级报价"

**诊断**：旧 L8 = cadence 2→5（转会窗每 5 季才开）。超越俱乐部天花板想往上爬时，4 季无主动爬升窗，**无 diegetic 反馈**——球员只觉得"不涨了"，归因运气/年龄，学不到"该走但走不了"。

**重设计**（核心反转：冻结的不再是"窗"，而是"升级报价"）：
- **cadence 回归每 2 季**（窗照开，diegetic 信号不断）——`transferWindowCadence` 恒为 2，移除 asc≥8 特例。
- **升级报价（step-up +1/+2 rep 方向）冻结**，除非上季统治级解冻——`generateClubOffers` 加 `ascension` + `dominant` 参数；asc≥8 且非统治级时 `dirs` 移除升级方向，横向/降级补位。
- **统治级** = `ratingScore≥2`（rating − forcedExitBar ≥ 1.5，9.4% 赛季，club-relative）——已计算、稀有、"统治了这家俱乐部的标准"。每窗需重新挣（不 once 永久），豪门只看近期巅峰。
- **desc** 加 diegetic 提示：「豪门在等你拿出统治级的表现——眼下的报价都不值得签字」（football 语言，不提天花板/飞升）。
- **名字保留**「转会冻结」——语义重定向为"升级转会冻结"（窗开但往上那档冻死，仍读得通）。

**与 L7 区分**：L7 无人问津 = 市场整体抛弃（retention −12%、金元消失、地板 55）威胁**生涯**；L8 转会冻结 = 升级兴趣冻结（横向照常、留队舒服）威胁**攀升**。讲不同的"难"，体感分明。

**验证**（60 生涯取样）：asc0 升级报价占 84%（大俱乐部主动追，正常爬升）；asc8 降至 38%，横向补位（178→628）——窗照开、报价不断、大俱乐部只在统治级时来。asc8 peak 69→74，正确落在 asc7(77)/asc9(73) 之间（旧 L8 的 69 几乎贴 asc9，是死档；重设计顺带修了单调性）。经济 5/5、难度 15/15 绿。

### L4 岁月催人：diegetic 衰退开始节拍

**诊断**：衰退 onset（growthDelta 首返负值 = 衰退档激活）完全无声——球员只看到 OVR 跌，没有"身体开始走下坡"的叙事。ADR-0004 D5 原推迟的"衰退期 UI 标记"按代入原则否决（上帝视角），改 diegetic body narrative。

**实现**：`narrative.ts appendDeclineBeat`——衰退首次咬到（`delta<0 && age≥28`）的一次性身体叙事：「训练后恢复得越来越慢，身体开始走下坡了」。age≤29 用「比同龄人更早」呼应飞升 4 提前衰退（不点名机制，只述球员体感）。一次性（suffix 去重）。run.ts 在 growth 块后触发。

### 架构顺带：forcedExitBar 移到 data.ts

`forcedExitBar` 原是 run.ts 局部纯查表。为让 events.ts 的 L8 统治级门控共用同一条标准线（不跨边到 run.ts），移到 data.ts（纯数据/查表，AGENTS.md data.ts 定位），run.ts + events.ts 都 import。

## 考虑过的替代方案

- **L8 加叙事承认被困**（保留冻结窗 + 教练说"你到顶了"）：叙事只是补丁，核心问题（4 季无主动爬升窗）没解，玩家仍"承受"等待。否决。
- **L8 天花板-冻结交互（超越且走不了 → 加速 forced exit）**：会让玩家觉得"被游戏赶走"而非"自己学到该走"，仍是 punishing 倾向。否决。
- **L4 衰退期 UI 标签**（ADR-0004 D5 原案）：上帝视角，违反代入原则。否决，改 diegetic beat。
- **L9/L10 加中途 beat 解释"因飞升 X"**：上帝视角，违反代入原则；opt-in desc + 后果体感已是 teaching 契约。否决。

## 后果

- **regress 语料覆盖缺口**：`_corpus.ts` 只有 asc5，无 asc8+ 生涯，L8 机制改动对 regress 指纹不可见（只 L4 beat 改文案）。L8 验证靠 `ascension-probe`（测 0-10 全档）+ 取证探针（升级占比 asc0 84% → asc8 38%）。未来若扩语料到 asc8+，L8 会进指纹。
- **asc8+ 经济重锚**：L8 改动让 asc8+ raw 分布上移，A8/A9/A10 曲线锚点 + asc9/asc10 解锁门槛按 reanchor（N=160）同步。asc0-7 不变。
- **铁律① 精确化**：ADR-0004 铁律① 已同步更新为"经世界反应可感知（diegetic）"。

## Status

accepted — L8 重设计 + L4 diegetic beat + forcedExitBar 迁移已落地，difficulty-smoke 15/15、ascension-economy 5/5、regress:full 9/9 绿。审计结论（六档合规、L9/L10 因代入原则不需修）记录于此。
