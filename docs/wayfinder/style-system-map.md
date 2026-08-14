---
id: map
title: 风格培养系统设计路线图
labels: [wayfinder:map]
---

## Destination

一份定版、过完 design-review 的「球员风格培养系统」设计文档：开局风格选择（词条树）、
深化节拍（cadence + 树门控）、成长预算守恒重分配、事件替换清单、词条显性化与赔率/退役
结算联动——可直接交付实现。实现本身在图外，是新 effort。

## Notes

- 铁律见 AGENTS.md：新随机一律 `derive()`；风格选择是玩家输入（seed 外，与 choices 同语义），天然确定。
- 不可推翻的已定版项：A0 低门槛爽档天花板、表现豁免斜坡、金球加权评定、转会即脊柱（T cadence 不动）。
- 每张票开工前按 AGENTS.md 门禁加载技能：机制票 → game-design-core + roguelike；文案票 →
  team-narrative；定稿票 → design-review。
- 参照：research/core-loop-design.md（P1 词条方向，本图吸收其结论）、
  research/single-option-events-design.md（抉择 vs 风味分流）、PRODUCT.md。
- 本 tracker 是本地 markdown（无远端 issue tracker）：认领 = 把票的 `assignee` 写成自己；
  状态 = open/closed；`blocked-by` 列票 id。改 tracker / 写 spec 同样走 worktree 流程合回 master。
- 调参往正向靠；既有「隐形保底」原则是否适用于风格词条的赔率修正，见票 007。

## Decisions so far

- [风格系统骨架十决策（建图裁定）](tickets/001-skeleton.md) — 目的地=spec；词条(印记)/风格(方向)两层共存；
  开局定基调+途中深化；轻事件+部分 contextual 让位；风格可动成长。骨架细化：词条树、
  开局 16 岁 S 事件、cadence×树门控、成长预算守恒重分配、boss/转会/判决/金球退役为砍除红线。

## Not yet specified

- 词条的 UI 呈现层（球员卡/生涯账本怎么显示词条与风格）——预期从词条树原型票（003）长出来，
  成型后再开票。
- 风格系统的数值初值与 balance 阈值——属于实现期 smoke/balance-check 阶段；若定稿票（009）
  发现必须进 spec 再开票。
- 词条门控事件的触发频率上限（多少词条同时活跃才不会把 S 通道挤爆）——等树形（003）和
  砍除清单（002）落地后才能具体化。

## Out of scope

- 实现代码与 UI 施工（目的地是 spec）。
- 掀翻已定版项：A0 天花板、表现豁免斜坡、金球加权评定。
- meta 数值成长线扩张（meta-progression-design 结论：方向是内容与难度轴，不是数值）。
