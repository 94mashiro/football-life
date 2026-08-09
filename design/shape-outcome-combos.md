# Shape: 后果组合化（选项卡 / 跑马灯 / 判决牌三处统一）

> 状态：设计稿（shape）。改动机器 + UI 一起改，落代码前先经 design-review。

## 问题（玩家视角）

玩家在「彻底休养」这张卡上看到三个互相矛盾的东西：

1. **卡片**把一次掷骰的后果拆成一颗颗独立药丸，还把共有效果（沦为替补）截掉——玩家分不清「这是一组同时发生，还是几件独立的事」。
2. **跑马灯**在每颗药丸上逐颗扫、落定只亮一颗——暗示「每条影响独立抽签」，与「一次掷骰决定整组」的真相相反。
3. **判决牌**只存「净 OVR + 伤病」两字段，角色/标签/乘数全消失——玩家对照卡片发现「对不上」，怀疑效果没生效。

根因：**三处各用一套数据模型描述同一件事**。卡片＝药丸列表，跑马灯＝数组下标，弹窗＝净数压缩。

## 北极星

**一个事件 = 一次掷骰 = 一个后果组合**。三处共用同一份「组合」数据，玩家在任何一格看到的都是同一个东西。这是 PRODUCT「概率是主角」原则的可信根基——卡片、动画、结果必须说的是同一句话。

## 玩家视角的三处判断

### A. OVR 两档 → 呈现合并（机制不动）

**玩家问**：「-3(当季) 和 +2(赛季末) 是两件事还是一件事？这伤到底多亏？」

- **判断**：不合成净 0（那是改平衡，会让受伤更便宜，可能催生「反复养伤刷 OVR」退化策略，需单独 balance-check）。把回升对合成**一颗药丸** `本季 −3 · 赛季末 +2（净 −1）`，时机内化进标签。
- 引擎三档（immediate 当季受俱乐部上限约束 / permanent 永久破上限冲 99 / deferred 赛季末受上限约束）原样保留——玩家不再替引擎做加法。
- 依据 game-design-core「简化测试」：去掉的是呈现复杂度，不是深度。

### B. 跑马灯 → 按组合扫，整组亮

**玩家问**：「这次骰子帮我落进了哪一组？」

- **判断**：从「逐颗扫」（rollN＝所有药丸数，cursor 逐颗）改成「两个停点扫」（rollN＝2，每个停点＝一个分支组合）。保留指数减速的紧张感（PRODUCT 的「18% 恐惧」），但落点停在组合层；落定时命中组合**整组亮**。
- 每个停点是 `win`/`lose` 两个 cluster，不是单颗 pill。
- 必定区静态全程亮，不进扫换（与现状一致）。

### C. 判决牌 → 照搬命中组合，净 OVR 降为摘要

**玩家问**：「我卡片上看到的，真的生效了吗？」

- **判断**：弹窗存命中组合的**真实效果列表**（引擎 resolve 时跑一次 `previewLabel`，结果存进 `lastVerdict.effects`），弹窗照搬卡片的药丸渲染——同一套药丸、同一份口径。
- 净 OVR 不删，降为底部小字摘要（玩家确实想要一个总账），但不再作为唯一信息，角色/标签/乘数不再凭空消失。
- 一致性是这游戏的根基：弹窗绝不能比卡片更糊。

## 三处落地方案

### A. 引擎：修两个根 bug，扩展 lastVerdict

1. **`previewLabel`（events.ts:4937）roleShift 屏蔽 bug**：`if (m.roleOverride) ... else if (m.roleShift)`——设了 roleOverride 就不再显 roleShift。
   - 彻底休养·受阻分支：`roleOverride=substitute` + `roleShift=-1`，roleShift 被吞 → 受阻分支独有药丸为空 → optionPreview 的「共同药丸抽进必定区」条件（要求两分支都留独有药丸，events.ts:5003）失败 → 全部留成分支堆 → 撞 3 格上限 → 沦为替补被截。
   - **修法**：roleOverride 与 roleShift 同时存在时，两者都显形（roleOverride 是「这一季什么角色」，roleShift 是「顺位往哪挪」，是两个维度）。调整 previewLabel 末段为两个独立 `if`，各加一条 pill（roleShift 标签维持「顺位下滑/上升」）。
   - 修完，彻底休养的共有效果（本季−3 / 沦为替补 / 伤病）会被抽进「必定发生」区，分叉只留差异（+2 回升 vs 再滑一档）。这同时解决了「沦为替补被截」「伤病含义不清」「没有组合读法」三件事。

2. **`lastVerdict` 扩展（run.ts:1739）**：resolve 时跑一次 `previewLabel(finalResolveResult)`，存进 `lastVerdict.effects: ChoicePreview[]`；保留 ovrDelta/injury/severe 兼容旧存档迁移（弹窗用 effects 渲染，ovrDelta 作摘要）。

### B. UI：跑马灯改组合扫，药丸合成回升对

1. **跑马灯落点（App.tsx:2940-2958）**：`rollN` 从「所有药丸数」改 2（win/lose 两个 cluster）；`cursor` 在 0/1 间扫；落定时整个 cluster 的 pills 全部 `is-landed`。
   - `Pill` 的 `idx` 改为 cluster 标识（0=win, 1=lose）而非药丸下标；`is-cursor`/`is-landed` 判断改为「是否在当前 cursor 的 cluster 内」。
   - 必定区药丸（idx=undefined）维持全程亮。
   - 落点判定 `isWin` 不变（仍用 lastOutcomeGood）。

2. **OVR 回升对合成（events.ts:4891 `ovrPill` 附近）**：在 previewLabel 的 OVR 段，检测「同分支 immediate 与 deferred 符号相反」时合成一颗 `本季 X · 赛季末 Y（净 Z）`；否则维持现状分开显。
   - 仅改呈现，引擎 Mods 结构与时机语义不变。
   - 纯永久（permanentOnly）单独显形 `(永久)`，不参与合成。

3. **判决牌渲染（App.tsx:3030-3052）**：vd-tags 区从「ovrDelta + injury 两 tag」改为渲染 `lastVerdict.effects` 的药丸列表（复用 Pill 组件或轻量版）；ovrDelta 降为底部小字「净 X」摘要。

### C. 逆境类事件分支标签中性化（上一轮约定）

`成功/失败` 对有真胜负的事件（罚点球罚进/罚失、世界杯夺冠/屈居亚军）准确，但对逆境类（伤病/伤病潮）两分支都净负，叫「成功」误导。本轮只做呈现层：给 `injury`/`injury_at_peak` 等逆境事件的 cluster-label 换中性词（「顺利康复/恢复受阻」「打封闭硬上/重伤倒下」），有真胜负的事件保留成功/失败。引擎数据上给 ChoiceRollPreview 加可选 `winLabel`/`loseLabel`，UI 优先用它、回退成功/失败。

## 范围与风险

- **改动机器**：previewLabel 的 roleShift 屏蔽修法（A1）会改变所有「roleOverride + roleShift 同存」事件的预览药丸数——需 grep 确认所有这类事件，逐个核对预览不会因此超出 3 格上限（已截的会冒出来）。
- **跑马灯改组合扫**：影响所有掷骰事件的跑马灯体验，不仅是伤病。需确认两支都有药丸的事件（optionPreview 保证 roll 存在则 win≥1 且 lose≥1）落点逻辑健壮。
- **lastVerdict 加字段**：旧存档无 effects 字段 → 弹窗回退到旧的 ovrDelta/injury 两 tag 渲染（安全迁移，不破）。
- **OVR 回升对合成**：要确保「同分支 imm 与 deferred 符号相反」是合成条件，避免误合成 imm/permanent 这种不同时机的对。

## 不在本轮（明确划出）

- OVR 机制改两档（回升净 0）——属平衡改动，需单独 balance-check，不在本轮。
- 所有掷骰事件换作者标签（彻底版）——工作量大，本轮只做逆境类呈现层中性化。
- 新的视觉世界——本设计是 refinement，保留裁决牌/决策卡现有视觉语言。

## 验证

- `npm run lint` + `npx tsc -b` 绿。
- 跑马灯在伤病事件上：点彻底休养，高亮在两个组合间扫、落定整组亮。
- 判决牌：弹窗药丸与卡片一致（含沦为替补/带伤隐患），不再只有净 OVR。
- 必定区出现「本季−3 / 沦为替补 / 伤病」，分叉只剩「+2 回升 vs 再滑一档」。
- 旧存档加载：lastVerdict.effects 缺失时回退，不崩。
