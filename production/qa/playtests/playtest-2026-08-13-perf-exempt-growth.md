# Playtest Report — P-PERF-EXEMPT 表现分豁免天花板（批量模拟）

## Session Info
- **Date**: 2026-08-13
- **Build**: feat/perf-exempt-growth（基于 32b197c）
- **Session Type**: 批量模拟调参验证（ascension-probe 400 局 × A0–A10 ×改动前后；regress 语料 3600 局）
- **Test Focus**: 表现分（GROWTH_PERF_BONUS）移出 applyCeiling 天花板后，A0–A10 巅峰总评分布涨到什么水平

## 改动内容
1. `growthDelta` 拆分返回 `{ delta, perfBonus }`：perfBonus（上场+评分档，±1..+2/季）不再过
   `applyCeiling`，也不吃祝福乘数——「踢得好」是球员自己挣的，同事件 `overallDelta` 的豁免语义。
   动机：88 OVR 在 rep8 豪门（有效天花板 87）时，统治级赛季与板凳赛季成长同为 0，
   「表现决定涨幅」在顶端完全失效（用户实局：24–27 岁连卡四季 88）。
2. `applyCeiling` 单调化：斜坡公式 e·(1−e/ramp) 越过 ramp/2 后回弯，掷 2 得 +1 而掷 3 得 +0；
   现钳在峰值 ceiling+ramp/4 饱和，roll 更好永不更差。

## 巅峰总评分布（ascension-probe，BRA ST 英超，无祝福，400 局/档）

| 档位 | 巅峰中位 前→后 | 90+ 占比 前→后 |
|------|--------------|---------------|
| A0   | 85 → 86      | 22.0% → 28.8% |
| A1   | 85 → 86      | 16.5% → 24.0% |
| A2   | 85 → 86      | 16.0% → 23.5% |
| A3   | 84 → 85      | 8.8% → 20.5%  |
| A4   | 81 → 82      | 1.0% → 6.5%   |
| A5   | 80 → 81      | 0.8% → 3.3%   |
| A6   | 78 → 79      | 0.3% → 0.8%   |
| A7   | 78 → 79      | 0.3% → 1.0%   |
| A8   | 75 → 78      | 0.0% → 0.3%   |
| A9   | 73 → 76      | 0.0% → 0.5%   |
| A10  | 75 → 78      | 0.0% → 0.5%   |

单调性保持：各档中位仍随飞升递减，无档位倒挂。豁免对高飞升的抬升更大
（A8–A10 中位 +3，A0–A3 +1）——天花板压得越狠的档位，表现分解放出的空间越大，
这正是豁免的语义（难度压环境，不压「踢得好」本身）。

## regress 语料（8 画像 × 3 策略 × 150 seeds）

- 各画像巅峰中位 +2~3（如 bra-st-epl 81→84，esp-cb-liga 80→82）
- **blessed-st（祝福满配）中位 86→91，p90 92→99，≥95 30%，≥90 68%** ——顶端通胀最显著
- chn-st-l1（中甲起步）中位 77→80，≥90 3→9%——「90 多踢中超」护栏松动但未破
- 传承中位普涨（bra-st-epl 282→351）——巅峰 OVR 直接进 scoreLegacy

## 门禁状态

- ✅ regress 已 bless；tsc/lint 绿；ascension-economy / climax / event-shape 等 9/10 绿
- ❌ difficulty-smoke 3/15 红（旧锚点，待 owner 重定）：
  - base.median 目标 77–83，实测 84
  - base.elite90 目标 4–12%，实测 22%
  - bless.surge95 目标 ≤10%，实测 19%

## 平衡观察（balance-check）

- **待观察的潜在垄断策略**：小俱乐部养分——低 rep 俱乐部评分标准线最低（6.5 vs 豪门 6.9），
  高 OVR 球员留守小庙更易拿统治级 +2 且豁免天花板。数据上未成垄断（chn-st-l1 ≥90 9%，
  远低于英超画像 29%；奖杯/奖项赔率仍拉着传承向豪门倾斜），但若后续压分布，优先看这里。
- late_bloomer / glass_cannon 乘数不再作用于表现分——两祝福对顶端的贡献略降，
  被豁免本身的抬升覆盖（blessed 组整体上涨）。

## Top 3 Priorities
1. **Owner 决策**：新分布是否接受？若压，候选杠杆：GROWTH_PERF_BONUS 预算表、
   DEV_CEILING_FLOOR/ASC_CEIL_DROP、difficulty-smoke TARGET 重锚（三者只动其一，先小步）。
2. blessed ≥95 30% 是最越界的一档——若只压一处，压祝福栈与表现分的叠加。
3. 小俱乐部养分策略随第 1 项一并复查。
