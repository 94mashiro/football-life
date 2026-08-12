# 共享 UI 词汇表抽到 src/ui/vocabulary.ts

App.tsx 长到 ~4800 行（AGENTS.md 旧文记的「~630 行」早已过时），其中一大块是
**共享 UI 词汇表**——奖杯/洲际/奖项/角色/告别/Persona 的 label map、confederation
查询、trophyLabel/hasGoldTrophy/personaTags 等纯数据 + 纯函数。它们被三个屏幕
（Menu/Play/Summary）反复 grep、反复复用，却埋在 4800 行里没有地址。

决定：把这块抽到 `src/ui/vocabulary.ts`。**不是**推翻 App.tsx「屏幕 + 内联组件
单文件」的既有决定——`src/ui/` 本就是共享 UI 模块的家（MonoCrest/ShareCard/Sheet
/icons 早就在那）；纯词汇表（无 JSX、无 hook、无引擎副作用）属于同一类共享物，
搬过去是补齐既有模式，不是改架构方向。

抽的是**纯数据 + 纯函数**：tsc 完整核验（漏改引用即编译红），行为不可能变（无
状态、无副作用）。这给了 UI 改动一个最弱的保险——`regress` 不覆盖 React，纯
函数提取是其中风险最低的一类。

## 范围

搬走：TROPHY_LABEL / CONT_PRIMARY_NAME / CONT_SECONDARY_NAME / NAT_CONT_NAME /
confederationOfLeague / trophyLabel / TROPHY_GOLD / hasGoldTrophy / BLIND_ASCENSION /
AWARD_LABEL / ROLE_LABEL / FAREWELL_LABEL / PersonaTag / PERSONA_TAG / PERSONA_ORDER /
TRAIT_TONE_CLASS / personaTags。

**留**在 App.tsx：屏幕、内联组件。（散落的 tier-color 函数 ovrTier/ovrTierClass/
tierTitle/ratingTier/ratingTierClass/oddsTierClass 原与 seasonRating 等交织，
在 vocabulary.ts 这个家立起来之后已作为一次连续块移动迁入——vocabulary.ts 现在
是完整的「共享 UI 词汇表 = label/persona + tier-color 心智模型」。）

## 考虑过的替代方案

- **全量拆分 App.tsx 的 54 个组件到 ui/**：逆转「单文件屏幕」决定、无行为指纹
  （regress 不覆盖 React）、4700 行机械移动、`react/only-export-components` lint
  约束——风险/收益比最差的一项。未做。本 ADR 不授权它；未来若要做，需独立评估
  且另立 ADR。
- **不抽、只修 AGENTS.md 的行数**：治标。词汇表仍无地址、仍难 grep。

## 后果

- App.tsx ~4800 → ~4687；vocabulary.ts 111 行。新增 label/persona 条目改在一处。
- 纯函数提取：tsc 全绿、build 全绿、regress（引擎/元进程，未触 React）三层全绿。
- 下一步：散落的 tier-color 函数可作一次连续块移动进 vocabulary.ts（家已立）。
