-- v5: 内测事件反馈表。玩家在决策位觉得「这个事件出现在这里不合理」时一键上报，
-- 服务端把当时的完整存档（GameState JSON，与 localStorage 里那份同源）连同当前
-- 事件一起落库。开发侧离线读（`wrangler d1 execute`），综合事件本身 + 它所处的
-- 生涯阶段判断合理性 —— 所以 save 存整份而不是几个摘要字段：判断需要上下文
-- （年龄/OVR/俱乐部/赛季账本/状态标签/已走过的决策），事后补不回来。
--
-- 没有 careers 外键：反馈发生在生涯**进行中**，那时 careers 里还没有这一行
-- （careers 只在退役结算时上传）。seed + device_id 就是事后关联的钥匙。
-- `wrangler d1 execute football-life --file=migrations/0005_feedback.sql --remote`

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT    NOT NULL,              -- anonymous client UUID
  seed        TEXT    NOT NULL,              -- 生涯种子，可复现这一局
  age         INTEGER NOT NULL,              -- 上报时的年龄（事件所处的生涯阶段）
  event_key   TEXT    NOT NULL DEFAULT '',   -- 事件 key，按事件聚合的分组列
  event_title TEXT    NOT NULL DEFAULT '',
  event_desc  TEXT    NOT NULL DEFAULT '',   -- 事件正文（文案改版后仍能还原当时看到的）
  save        TEXT    NOT NULL DEFAULT '',   -- 完整存档 JSON
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 主查询：哪个事件被吐槽得最多。
CREATE INDEX IF NOT EXISTS idx_feedback_event ON feedback (event_key, age);
