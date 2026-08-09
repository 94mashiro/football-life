# 云端排行榜 · 后端说明

游戏在 Cloudflare Pages 上加了后端：**Pages Functions + D1**（serverless SQLite），同域同部署，无需另起服务。两件事——

1. **全服排行榜**：每局生涯结算时**静默匿名上报**（无选项、无感知，按产品决策强制开启），菜单「全服排行榜」可按球员国籍筛选查看。
2. **引擎调参分析**：上报的逐决策日志（`choiceLog`）存入 `career_events` 表，后台用 `wrangler d1 execute` 跑 SQL 看事件触发频率/选项分布/各档传承分布，作为微调判定事件的依据。

无防作弊（按产品决策）：服务端只存储与查询，对入参做区间裁剪防脏数据炸库。

---

## 一次性部署（需手动，用到你的 Cloudflare 账号）

```bash
# 1. 建 D1 库（输出会打印 database_id，复制它）
npx wrangler d1 create football-life

# 2. 把 database_id 填进 wrangler.jsonc 的 d1_databases[0].database_id
#    （替换 REPLACE_WITH_wrangler_d1_create_OUTPUT）

# 3. 远程建表
npx wrangler d1 migrations apply football-life --remote

# 4. 部署（Functions 随静态站一起上）
npm run build && npx wrangler pages deploy dist --project-name=football-life
```

> `/api/leaderboard` 由 Pages Functions 处理，优先级高于 `public/_redirects` 的 `/* /index.html 200` 兜底，不会被 SPA fallback 吞掉。

---

## 本地联调

```bash
# 终端 A：前端（Vite）
npm run dev

# 终端 B：后端（wrangler pages dev，本地 D1 在 .wrangler/state，不碰远程）
npm run build && npx wrangler pages dev dist --d1=DB=football-life
# 首次本地也需建表：
npx wrangler d1 migrations apply football-life --local
```

前端默认同源调用 `/api/*`。要指向本地 wrangler，在前端启动前设：

```bash
VITE_API_BASE=http://localhost:8788 npm run dev
```

---

## 后台分析 SQL（设备筛选 / 归因 / 调参）

直接对远程 D1 跑（只读分析，不经过 API）：

```bash
npx wrangler d1 execute football-life --remote --command="<下面的 SQL>"
```

### 传承分布（平衡调参的核心依据）

```sql
-- 各飞升档的传承中位数/均值/样本量（难度曲线是否自洽）
SELECT ascension, COUNT(*) n,
  CAST(AVG(legacy) AS INT) avg, MAX(legacy) max, MIN(legacy) min
FROM careers GROUP BY ascension ORDER BY ascension;

-- 各国籍出身的传承分布（P-NATION 补偿是否平衡）
SELECT nationality_id, COUNT(*) n, CAST(AVG(legacy) AS INT) avg, MAX(legacy) max
FROM careers GROUP BY nationality_id ORDER BY avg DESC;

-- 各位置的传承分布（P-POS 是否拉平 GK/后卫与前锋的差距）
SELECT position, COUNT(*) n, CAST(AVG(legacy) AS INT) avg
FROM careers GROUP BY position ORDER BY avg DESC;
```

### 事件调参（决策层微调依据，来自 `career_events`）

```sql
-- 各事件触发次数（看哪些事件太频繁/太稀有）
SELECT title, COUNT(*) n FROM career_events GROUP BY title ORDER BY n DESC;

-- 各事件各选项的 good 率（哪个选项过强/过弱，是否需要重平衡）
SELECT title, choice, COUNT(*) n,
  SUM(good)*100/COUNT(*) AS good_pct
FROM career_events GROUP BY title, choice ORDER BY title, n DESC;

-- 单事件的平均年龄分布（事件是否在该出现的年龄窗口触发）
SELECT title, CAST(AVG(age) AS INT) avg_age, MIN(age), MAX(age)
FROM career_events GROUP BY title;
```

### 设备归因（device_id 筛选）

```sql
-- 哪些设备玩得最多、最佳传承、夺冠率（活跃度 + 实力画像）
SELECT device_id, COUNT(*) runs, MAX(legacy) best,
  SUM(won_world_cup)*100/COUNT(*) wc_pct,
  SUM(won_ballon_dor)*100/COUNT(*) bd_pct
FROM careers GROUP BY device_id ORDER BY runs DESC LIMIT 50;

-- 看某个设备的所有生涯轨迹
SELECT seed, legacy, max_overall, seasons, trophies, ascension, retire_reason, created_at
FROM careers WHERE device_id = '<某个UUID>' ORDER BY created_at;

-- 留存：每个设备首末上报时间、跨天数、局数
SELECT device_id, COUNT(*) runs,
  MIN(created_at) first_run, MAX(created_at) last_run
FROM careers GROUP BY device_id ORDER BY runs DESC;
```

---

## 隐私：device_id 不进榜单

`device_id` 是前端首次生成的匿名 UUID（`crypto.randomUUID`），存 `careers.device_id` 列，用途有二：

1. **后台归因**：上面的 SQL 按 `device_id` 分组，看「同一设备的局数/最佳/夺冠率」。
2. **查自己名次**：GET `/api/leaderboard?deviceId=<自己的>` 只传查询者自己的 id 算 `myRank`。

**它不出现在榜单返回里**：GET 的 SELECT 故意不含 `device_id`，别的玩家看不到任何人的设备 id。榜单行只有名字/位置/国籍/传承分等展示字段。

> `customSeed`（手填种子的可复现局）**永不上报**——它不结算 meta，上报会污染榜单和调参样本。
