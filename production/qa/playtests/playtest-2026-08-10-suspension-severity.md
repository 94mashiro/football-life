# Playtest Report — 停赛分档(整季停赛 vs 少踢)验证

## Session Info
- **Date**: 2026-08-10
- **Build**: worktree-suspension-severity
- **Duration**: 批模拟 ascension-probe(400 局 × 11 档)+ injury-freq-probe(300 局),改前改后各跑一轮(可复跑:`npx tsx tools/ascension-probe.ts` / `npx tsx tools/injury-freq-probe.ts`)
- **Tester**: 自动策略 bot(始终选第一个选项)
- **Platform**: 引擎级 Monte Carlo(无 UI)
- **Session Type**: Targeted test — 玩家诉求「只有恶性后果才整季停赛,轻伤/短停赛只少踢」

## Test Focus
把原本一律「整季停赛(`suspended`→账本显示『停赛』、0 数据、评分 null)」的后果,
按真实时限/行为分两档:

- **整季停赛**(留 `suspended`):赛季报销(十字韧带/腿筋/膝盖断)、≥1 年康复、心脏复出、
  8 个月禁赛(=整季)、药检阳性。共 16 处。
- **少踢不全停**(转 `statsMultiplier` 缩减出场):几场停赛+短伤停、假摔败露、走下场罚单、
  头butt 红牌、咬人禁赛、恐飞缺客场、飞升2 nag 轻伤。共 7 处 + nag。

验证三件事:(1) 飞升阶梯不被 nag 软化破坏;(2) 伤病/重伤/医学判决/退役经济不变
  (本改只动「严重度表达」,不动 severe 标志与伤病链);(3) 少踢季有了真实评分后,
  不至于误触 forced-exit(此前停赛季 rating=null 是 grace 跳过,现在要被评判)。

## Quantitative Data

### 1. 飞升阶梯(ascension-probe,400 局/档)— 改前 vs 改后

| 档 | 裸中位 改前→改后 | 实得中位 改前→改后 | 90+率 改前→改后 |
|---|---|---|---|
| 0 | 368 → 367 | 368 → 367 | 42.3% → 42.0% |
| 2 | 328 → 327 | 525 → 524 | 39.3% → 38.5% |
| 3 | 318 → 315 | 604 → 598 | 39.3% → 38.5% |
| 6 | 226 → 224 | 633 → 626 | 23.5% → 23.8% |
| 10 | 172 → 171 | 688 → 684 | 20.3% → 20.3% |

裸传承仍单调递减(368→171),实得仍单调递增(367→684),**阶梯完好**。
所有差值在蒙特卡洛噪声内(±2–6)。nag 由整季→0.6× 出场对 asc-2 的软化
**可忽略**(裸 328→327),与 run.ts 既有调参注「nag 中位影响为零」一致 ——
伤病潮的身份主要是叙事/氛围,机制上本就边缘。

### 2. 伤病经济(injury-freq-probe,300 局)— 改前 vs 改后

| 指标 | 改前 | 改后 |
|---|---|---|
| 重伤 0 次 | 71.3% | 72.3% |
| 重伤 1 次 | 16.7% | 15.3% |
| 重伤 2 次 | 9.0% | 9.0% |
| 重伤 3 次 | 3.0% | 3.3% |
| 触发医学判决 | 2.0% | 2.3% |
| 因伤退役 | 5.0% | 5.3% |
| 巅峰 OVR 均值 | 89.6 | 89.6 |
| injury 事件/生涯 | 2.19 | 2.16 |

**全部在噪声内**。印证本改是「严重度表达」改,不动 severe 标志 / 伤病链 /
医学判决 / 退役经济。被转 `statsMultiplier` 的 7 处事件本就不设 `severe`,
故不进医学判决弧;nag 也从来不是 severe,软化它不改变重伤计数。

### 3. forced-exit 顾虑(少踢季现在被评判)

此前停赛季 rating=null → belowStandardRun 视为 grace 跳过;现在少踢季有真实评分,
会进评判。但评分是**按人均产出率**(gpa/apa/cpa)算,0.6× 出场只缩「量」不缩
「率」,少踢季评分 ≈ 全季评分,不会凭空造出 below-standard 季。佐证:no_offers 退役
改前改后均为 1→1,实得传承稳定 —— 若 forced-exit 被误触会看到 no_offers 上升与
传承下降,均未发生。

## Findings

### What worked well
- 停赛分档干净:16 处整季停赛全部对得上真实时限(十字韧带≈10 个月、赛季报销、
  ≥1 年康复、8 个月禁赛=整季、药检阳性);7 处轻伤转少踢对应几场停赛/短禁赛/
  缺客场,行为与惩罚匹配。
- 「整季停赛」在账本里从「常见」变回「恶性」:此前 nag(每生涯~1 次)+ 7 轻伤事件
  是『停赛』高频来源,改后它们都正常出数据,只有赛季报销级后果才显示『停赛』。
- 飞升阶梯、伤病经济、forced-exit 三条均验证稳定,无退化策略。

### Pain points
- 无(批模拟未发现失衡)。

### Confusion points
- 无。

## Bugs Encountered
| # | 描述 | 严重度 | 可复现 |
|---|---|---|---|
| — | (与本改无关)`tools/forced-exit-age.ts` 硬编码 league id `"epl"` 已不存在,改前改后均崩 | 低 | 是(留待另修) |

## Balance Adjustments (本次)
- `run.ts` nag-injury:整季 `suspended` → `statsMultiplier 0.6`(轻伤少踢,不再整季停赛)。
- `events.ts` 7 处:`suspended` → `statsMultiplier`(0.5/0.6/0.8 按时限)。
- `sim.ts` `simSeasonStats` 接 `statsMultiplier` 参数,出场按比例缩,人均产出率不变。
- `types.ts` `Modifiers.statsMultiplier` / `SeasonResult.suspended` 注释更新为分档语义。
- `events.ts` `inferTone`:`statsMultiplier<1` 计为代价(少踢是损失)。

## Top 3 Priorities from this session
1. 分档已落地并验证 —— 整季停赛只留给恶性后果,轻伤少踢。
2. 飞升/伤病/forced-exit 三条经济线均稳定,可合并。
3. (旁注)`forced-exit-age.ts` 探针 league id 失效,后续单独修。

## Overall Assessment
- **Difficulty**: 改前改后一致(噪声内)
- **Pacing**: 一致
- **结论**: BALANCE-HEALTHY,可合并。
