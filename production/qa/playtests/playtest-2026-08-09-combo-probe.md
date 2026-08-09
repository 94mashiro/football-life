# Playtest Report — 词条成型 + Apex 演出(批模拟)

## Session Info
- **Date**: 2026-08-09
- **Build**: worktree-celebration-pack(爽感演出包合入前)
- **Duration**: 批模拟 400 局 × 3 策略(tools/combo-probe.ts,可复跑:`N=400 npx tsx tools/combo-probe.ts`)
- **Tester**: 自动策略 bot(first / stay / adopt)
- **Platform**: 引擎级 Monte Carlo(无 UI)
- **Session Type**: Targeted test — 新机制触发率验证

## Test Focus
词条成型(4 条 combo)激活率是否随 build 承诺度变化;apex 里程碑频率;确定性回归。

## Quantitative Data
| 指标 | first(乱点) | stay(忠诚流) | adopt(归化流) |
|---|---|---|---|
| 任一 combo | 18.8% | 44.8% | 11.8% |
| 王朝旗帜 combo_dynasty | 0.0% | 44.8% | 0.0% |
| 民心所向 combo_talisman | 10.3% | 7.2% | 6.5% |
| 第二故乡 combo_adopted | 0.0% | 0.0% | 0.3% |
| 铁血队长 combo_iron | 12.0% | 21.5% | 6.5% |
| apex 世界杯 | 2.5% | 5.5% | 1.5% |
| apex 金球 | 3.3% | 3.0% | 2.8% |
| apex OVR95 | 4.5% | 0.8% | 2.0% |
| apex 身价破亿 | 25.3% | 5.3% | 13.5% |

确定性:同 seed 双跑,里程碑序列与词条集完全一致 → **OK**。

## What worked well
- **combo 对 build 承诺敏感**:忠诚流 44.8% 解锁王朝旗帜,乱点 0%——「选择复利」成立,报偿不白给。
- **稀有弧线自带确定报偿**:归化(naturalized 0.3%)是全游戏最稀有的身份,但凡是走通的生涯,fan_darling(普及 25.8%)几乎必然补齐 → combo_adopted 是「走到即所得」的发现型宝石,非死内容。
- apex 里程碑维持稀有档(世界杯 1.5-5.5%、金球 ~3%),演出不会通胀。

## Pain points
- 无(High/Medium 级)。combo_adopted 的低触发率是上游归化弧线的既有稀有度,非本次改动引入;bot 的 0.3% 是文本正则策略的下界,真人定向追弧线会显著更高。

## Balance 判定
- 王朝旗帜 ×1.2 与队长 ×1.08 叠乘上限 ×1.296,奖杯概率有 Math.min(1,…) 钳制,未观测到饱和异常。
- 全部 combo 只增益(正向调参原则),荣誉线不碰 OVR(combo_adopted 只动大赛赔率)。
- 不调数值,按现状合入;若后续真人反馈归化线过冷,优先加宽上游「退出国家队」事件的门,而非放宽 combo 配对。

## Top 3 Priorities
1. 合入现状(数值不动)。
2. 观察真实玩家的 combo 解锁分布(尤其忠诚流是否感知到夺冠概率 chip 上浮)。
3. 归化弧线冷热留给下一轮真人反馈裁决。
