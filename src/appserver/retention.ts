// ============================================================
// Retention: 无 GC 的记忆是债务（cumora 启示录第三条）。
// room_messages 每房间保留最近 500 条；
// tasks/decisions 的终态（done/cancelled）超过 90 天删除；
// principles 不删（晋升的知识是资产）。
// ============================================================

import type { Database } from 'better-sqlite3';

const ROOM_MSG_KEEP = 500;
const TERMINAL_KEEP_MS = 90 * 24 * 3600 * 1000;

export function runRetention(db: Database): { roomMessages: number; tasks: number; decisions: number } {
  const rooms = db.prepare('SELECT DISTINCT room FROM room_messages').all() as { room: string }[];
  let roomMessages = 0;
  for (const { room } of rooms) {
    const r = db
      .prepare(
        `DELETE FROM room_messages WHERE room = ? AND id < COALESCE(
           (SELECT min(id) FROM (SELECT id FROM room_messages WHERE room = ? ORDER BY id DESC LIMIT ?)),
           0)`
      )
      .run(room, room, ROOM_MSG_KEEP);
    roomMessages += r.changes;
  }
  const cutoff = Date.now() - TERMINAL_KEEP_MS;
  const tasks = db
    .prepare("DELETE FROM room_tasks WHERE state IN ('done', 'cancelled') AND updated_at < ?")
    .run(cutoff).changes;
  const decisions = db
    .prepare("DELETE FROM room_decisions WHERE state = 'decided' AND updated_at < ?")
    .run(cutoff).changes;
  return { roomMessages, tasks, decisions };
}

/** Run at boot and then daily; logs only when something was actually removed. */
export function startRetention(db: Database): void {
  const run = () => {
    try {
      const r = runRetention(db);
      if (r.roomMessages + r.tasks + r.decisions > 0) {
        console.log(`[retention] removed: ${r.roomMessages} room msgs, ${r.tasks} tasks, ${r.decisions} decisions`);
      }
    } catch (err) {
      console.error('[retention] failed:', err);
    }
  };
  run();
  const timer = setInterval(run, 24 * 3600 * 1000);
  timer.unref();
}
