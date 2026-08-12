# src/api/ — 云端客户端层（Pages Functions + D1 的 SPA 侧）

## 背景

`AGENTS.md` 原架构图只画了 `ui → state → engine/meta`。云端榜单与事件反馈
是后加的能力：Cloudflare Pages Functions + D1 做后端，SPA 侧需要一个薄客户端
负责 (1) 每局结算后静默上传生涯摘要 + 决策日志（给后端调参分析供样本）、
(2) 拉取全球榜单（按国籍/位置/今日维度过滤）。这层落在哪里、依赖方向如何、
非确定性（`Math.random` / `new Date`）如何与「engine 必须确定」的不变量共处，
需要一条 ADR 说清，否则后续 agent 据过时架构图判断「engine 无 DOM / 无随机」
时会漏掉这层的特殊性。

## 决定

新增 `src/api/` 层，放两个模块：

- `leaderboard.ts` — `submitCareer(game)`（静默上传，永不 reject）、
  `fetchLeaderboard(opts)`（拉榜，按 nat/pos/since 过滤）、`getDeviceId()`、
  `localMidnightUtc()`、`BoardResponse`/`LeaderboardEntry` 类型。
- `feedback.ts` — `submitEventFeedback(game, event)`（内测期一键上报事件，
  连完整存档一起发，永不 reject）。

**依赖方向**：`ui/App.tsx → api`（拉榜 + 上报反馈）、`state/store.ts → api`
（结算后上传）。`api → engine/meta`（读 `GameState`/`seniorCareerStats`/
`legacyRank` 构造 payload）。方向单向，不回指 ui/state。**engine 永不 import api**
——上传是 `store.ts` 的 `useEffect` 副作用，不进纯 reducer（reducer 纯函数不变量
守住）。

## 非确定性与不变量的关系

- `Math.random` 出现在 `leaderboard.ts` 的 `uuid()` 兜底（仅当
  `crypto.randomUUID` 不可用）——**只用于生成匿名 deviceId，不进任何 sim 结果**。
  与 `meta/legacy.ts` 的 `randomSeed()`/`prestigeChoices()` 同属「engine 之外的非
  确定性」豁免，不违反「engine 随机只能 `derive()`」。
- `new Date` 出现在 `leaderboard.ts` 的 `localMidnightUtc()`（把「今日」算成
  观众本地时区的 UTC 字符串，给 D1 `since=` 过滤）——同样在 engine 之外。
- 容错原则：云端失败永不阻断本地结算或菜单渲染；上传 swallow 错误，榜单显示
  「暂无数据」。`customSeed` 局（可复现种子）永不上传——不刷 meta、不污染样本。

## regress 的关系

`api/` 不参与 `npm run regress` 的任何指纹层（行为/文案/元进程）——它纯是 I/O
客户端，无 sim 行为、无文案、无元进程逻辑。`regress:full` 的断言门也不触它。
故 `api/` 的改动不会让基线红；反之 `api/` 也不被回归保护，改动需靠 `tsc -b`
（`tsconfig` 已纳入）+ 手测。

## 后果

- AGENTS.md 架构图已补登 `api/`。`Math.random`/`new Date` 的「engine 之外豁免」
  在 AGENTS.md 确定性节一并写明。
- 未来给 `api/` 加端点：守住「engine 不 import api」「上传走 store 副作用不进
  reducer」「新随机/时间只用于 I/O 不进 sim」三条即可。
