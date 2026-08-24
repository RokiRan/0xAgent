// ============================================================
// Reminder Board: future-you（cumora §9.2.1 适配）。
// 把"我以后再做"从话术变成服务器担保的唤醒：
// 到点 → 系统消息落房 + 直接唤醒 assignee。
// 派发幂等：UPDATE ... WHERE status='pending' 的 changes 认领，
// 多 tick/重启下同一 slot 只有一个赢家（先插后做的 SQLite 等价物）。
// ============================================================

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface RoomReminder {
  id: string;
  room: string;
  agentId: string;
  prompt: string;
  scheduledFor: number;
  status: 'pending' | 'dispatched' | 'cancelled';
  createdAt: number;
}

interface ReminderRow {
  id: string;
  room: string;
  agent_id: string;
  prompt: string;
  scheduled_for: number;
  status: RoomReminder['status'];
  created_at: number;
}

export interface ReminderBoardDeps {
  /** Post a system message into a room (visible in UI, persisted). */
  postMessage: (room: string, text: string) => void;
  /** Wake the assignee with the reminder prompt (bus request path). */
  deliver: (room: string, agentId: string, prompt: string) => Promise<void>;
  /** Tick interval. Default 60s; tests inject a manual tick. */
  tickIntervalMs?: number;
}

export class ReminderBoard {
  private db: Database;
  private deps: ReminderBoardDeps;
  private timer?: ReturnType<typeof setInterval>;

  constructor(db: Database, deps: ReminderBoardDeps) {
    this.db = db;
    this.deps = deps;
    this.db.exec(`CREATE TABLE IF NOT EXISTS room_reminders (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      scheduled_for INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_room_reminders_due ON room_reminders(status, scheduled_for)');
    if (deps.tickIntervalMs !== 0) {
      this.timer = setInterval(() => void this.tick(), deps.tickIntervalMs ?? 60_000);
      this.timer.unref();
    }
  }

  create(room: string, agentId: string, prompt: string, scheduledFor: number): RoomReminder {
    if (!prompt.trim()) throw new Error('提醒内容不能为空');
    if (!Number.isFinite(scheduledFor)) throw new Error('scheduledFor 非法');
    const id = `rem-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare('INSERT INTO room_reminders (id, room, agent_id, prompt, scheduled_for, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, room, agentId, prompt.trim(), Math.round(scheduledFor), 'pending', Date.now());
    return this.mustGet(id);
  }

  cancel(id: string): void {
    const changes = this.db
      .prepare("UPDATE room_reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
      .run(id).changes;
    if (changes === 0) throw new Error(`提醒不存在或已派发: ${id}`);
  }

  list(room: string): RoomReminder[] {
    const rows = this.db
      .prepare('SELECT * FROM room_reminders WHERE room = ? ORDER BY scheduled_for DESC LIMIT 50')
      .all(room) as ReminderRow[];
    return rows.map(rowToReminder);
  }

  /**
   * Dispatch due reminders. Claim-by-update: only the tick that flips
   * status pending→dispatched delivers, so restarts never double-fire.
   */
  async tick(now = Date.now()): Promise<string[]> {
    const due = this.db
      .prepare("SELECT * FROM room_reminders WHERE status = 'pending' AND scheduled_for <= ? ORDER BY scheduled_for LIMIT 20")
      .all(now) as ReminderRow[];
    const dispatched: string[] = [];
    for (const row of due) {
      const claimed = this.db
        .prepare("UPDATE room_reminders SET status = 'dispatched' WHERE id = ? AND status = 'pending'")
        .run(row.id).changes;
      if (claimed === 0) continue; // 另一 tick 已认领
      dispatched.push(row.id);
      this.deps.postMessage(row.room, `⏰ 定时提醒 @${row.agent_id}：${row.prompt}`);
      try {
        await this.deps.deliver(row.room, row.agent_id, row.prompt);
      } catch (err) {
        // 投递失败不回滚状态——cumora 邮箱模型：系统消息已落房，
        // agent 下次活跃读房间历史自然补见，重发只会制造重复。
        this.deps.postMessage(row.room, `⚠️ 提醒 ${row.id} 直接唤醒 ${row.agent_id} 失败（${String(err).slice(0, 80)}），内容已在房间记录中`);
      }
    }
    return dispatched;
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private mustGet(id: string): RoomReminder {
    const row = this.db.prepare('SELECT * FROM room_reminders WHERE id = ?').get(id) as ReminderRow | undefined;
    if (!row) throw new Error(`提醒不存在: ${id}`);
    return rowToReminder(row);
  }
}

function rowToReminder(row: ReminderRow): RoomReminder {
  return {
    id: row.id,
    room: row.room,
    agentId: row.agent_id,
    prompt: row.prompt,
    scheduledFor: row.scheduled_for,
    status: row.status,
    createdAt: row.created_at,
  };
}
