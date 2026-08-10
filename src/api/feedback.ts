/**
 * 事件反馈客户端 —— 内测期玩家在决策位一键上报「这个事件不合理」。
 *
 * 连当时的**完整存档**一起发：开发侧要判断的不是事件本身好不好，而是「这个
 * 事件出现在这段生涯的这个阶段」合不合理，那需要上下文（年龄/OVR/俱乐部/账本/
 * 状态标签/已走过的决策），只发一个事件名判断不了。存档就是 store 写进
 * localStorage 的那份 GameState，原样 stringify。
 *
 * 与 leaderboard 上传同样的容错原则：失败只回 false，绝不打断决策流程。
 */
import type { GameState } from "../engine/types";
import { getDeviceId } from "./leaderboard";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export interface FeedbackEvent {
  key?: string;
  title: string;
  desc: string;
}

/** 上报一条事件反馈。永不 reject —— 返回 false 表示没送到。 */
export function submitEventFeedback(game: GameState, event: FeedbackEvent): Promise<boolean> {
  return fetch(`${API_BASE}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: getDeviceId(),
      seed: game.seed,
      age: game.age,
      eventKey: event.key ?? "",
      eventTitle: event.title,
      eventDesc: event.desc,
      save: JSON.stringify(game),
    }),
    keepalive: true,
  })
    .then((r) => r.ok)
    .catch((e) => {
      console.warn("[feedback] upload failed", e);
      return false;
    });
}
