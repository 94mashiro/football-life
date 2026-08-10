/**
 * /api/feedback — 内测事件反馈的写入端。
 *
 *   POST /api/feedback → 存一条「这个事件不合理」上报（当前事件 + 完整存档）
 *
 * 只写不读：反馈是给开发侧离线看的（`wrangler d1 execute`），不经 API 暴露。
 * 与 /api/leaderboard 同样的原则——服务端信任 payload，只做长度钳制，让畸形/
 * 滥用请求撑不爆一行。
 */
import type { Env, EventContext } from "../_types";

interface FeedbackBody {
  deviceId: string;
  seed: string;
  age: number;
  eventKey?: string;
  eventTitle?: string;
  eventDesc?: string;
  /** 完整 GameState 的 JSON 字符串（客户端 stringify 后原样上传）。 */
  save?: string;
}

function clampStr(s: unknown, max: number): string {
  return String(s ?? "").slice(0, max);
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function onRequestPost(ctx: EventContext<Env>): Promise<Response> {
  let body: FeedbackBody;
  try {
    body = (await ctx.request.json()) as FeedbackBody;
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }

  const deviceId = clampStr(body.deviceId, 64);
  const seed = clampStr(body.seed, 64);
  if (!deviceId || !seed) return json({ ok: false, error: "missing deviceId/seed" }, 400);

  const age = typeof body.age === "number" && Number.isFinite(body.age) ? Math.round(body.age) : 0;

  // 存档整份进一列。一段生涯 ~25 季，JSON 通常在 20–80KB；256KB 的上限只是
  // 防滥用的天花板，正常存档远够不着（够不着就说明不是本游戏发来的）。
  const insert = await ctx.env.DB.prepare(
    "INSERT INTO feedback (device_id, seed, age, event_key, event_title, event_desc, save) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      deviceId,
      seed,
      Math.max(0, Math.min(99, age)),
      clampStr(body.eventKey, 64),
      clampStr(body.eventTitle, 120),
      clampStr(body.eventDesc, 4000),
      clampStr(body.save, 256 * 1024),
    )
    .run();

  if (!insert.success) return json({ ok: false, error: "insert failed" }, 500);
  return json({ ok: true, id: insert.meta.last_row_id ?? 0 });
}
