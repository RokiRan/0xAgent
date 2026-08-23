// ============================================================
// Task Board: Task/Contract + Lease as first-class objects (cumora P1).
// 完成 = 每条 acceptance 有 evidence 且 approver 确认；
// 租约逾期 → 回收回 ready；退回 → 带 note 返工并续租。
// 判定只读 DB 事实；agent 执行走 bus request/response。
// ============================================================

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type TaskState = 'ready' | 'in_progress' | 'review' | 'done' | 'cancelled';

export interface RoomTask {
  id: string;
  room: string;
  title: string;
  acceptance: string[];
  evidence: string[];
  owner: string | null;
  approver: string;
  state: TaskState;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// better-sqlite3 row shape; column names are the authority
interface TaskRow {
  id: string;
  room: string;
  title: string;
  acceptance: string;
  evidence: string;
  owner: string | null;
  approver: string;
  state: TaskState;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TaskBoardDeps {
  /** Send a bus request to an agent; resolves with its reply payload. */
  requestAgent: (target: string, payload: unknown, timeoutMs?: number) => Promise<unknown>;
  /** Post a system message into a room (visible in UI, persisted). */
  postMessage: (room: string, text: string) => void;
  /** Lease duration on (re)assignment. Default 30 min. */
  leaseMs?: number;
}

export class TaskBoard {
  private db: Database;
  private deps: TaskBoardDeps;
  private leaseMs: number;
  private reaper: ReturnType<typeof setInterval>;

  constructor(db: Database, deps: TaskBoardDeps) {
    this.db = db;
    this.deps = deps;
    this.leaseMs = deps.leaseMs ?? 30 * 60 * 1000;

    this.db.exec(`CREATE TABLE IF NOT EXISTS room_tasks (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      title TEXT NOT NULL,
      acceptance TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '[]',
      owner TEXT,
      approver TEXT NOT NULL,
      state TEXT NOT NULL,
      lease_expires_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_room_tasks_room ON room_tasks(room)');

    this.reaper = setInterval(() => this.reapExpired(), 30000);
    this.reaper.unref();
  }

  close(): void {
    clearInterval(this.reaper);
  }

  create(room: string, title: string, acceptance: string[], owner: string | null, approver: string): RoomTask {
    if (acceptance.length === 0) throw new Error('acceptance 不能为空（先写完成定义再开工）');
    if (owner && owner === approver) throw new Error('approver 不得等于 owner（防自我确认）');
    const now = Date.now();
    const id = `task-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO room_tasks (id, room, title, acceptance, evidence, owner, approver, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, '[]', ?, ?, 'ready', ?, ?)`
      )
      .run(id, room, title, JSON.stringify(acceptance), null, approver, now, now);
    this.deps.postMessage(room, `📋 新任务「${title}」已创建，验收标准 ${acceptance.length} 条${owner ? `，指派给 ${owner}` : ''}`);
    const task = this.get(id)!;
    if (owner) this.assign(task, owner);
    return task;
  }

  list(room: string): RoomTask[] {
    const rows = this.db
      .prepare('SELECT * FROM room_tasks WHERE room = ? ORDER BY created_at DESC LIMIT 50')
      .all(room) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Human/approver confirms: review → done. */
  approve(id: string): RoomTask {
    const task = this.mustGet(id);
    if (task.state !== 'review') throw new Error(`任务处于 ${task.state}，不能验收`);
    this.touch(id, { state: 'done' });
    this.deps.postMessage(task.room, `✅ 任务「${task.title}」已通过验收`);
    return this.get(id)!;
  }

  /** Approver returns: review → in_progress with a rework note and fresh lease. */
  returnTask(id: string, note: string): RoomTask {
    const task = this.mustGet(id);
    if (task.state !== 'review') throw new Error(`任务处于 ${task.state}，不能退回`);
    if (!task.owner) throw new Error('任务无 owner，无法退回返工');
    this.touch(id, { state: 'in_progress', leaseExpiresAt: Date.now() + this.leaseMs });
    this.deps.postMessage(task.room, `↩️ 任务「${task.title}」被退回：${note}`);
    void this.dispatch(task.owner, task.room, task.id, {
      kind: 'task', action: 'rework', taskId: task.id, room: task.room,
      title: task.title, acceptance: task.acceptance, note,
    });
    return this.get(id)!;
  }

  stop(): void {
    clearInterval(this.reaper);
  }

  // ── internals ──

  private assign(task: RoomTask, owner: string): void {
    this.touch(task.id, { owner, state: 'in_progress', leaseExpiresAt: Date.now() + this.leaseMs });
    this.deps.postMessage(task.room, `🔧 ${owner} 认领任务「${task.title}」（租约 ${Math.round(this.leaseMs / 60000)} 分钟）`);
    void this.dispatch(owner, task.room, task.id, {
      kind: 'task', action: 'assign', taskId: task.id, room: task.room,
      title: task.title, acceptance: task.acceptance,
    });
  }

  private async dispatch(owner: string, room: string, taskId: string, payload: unknown): Promise<void> {
    try {
      const res = await this.deps.requestAgent(owner, payload, 5 * 60 * 1000);
      if (res && typeof res === 'object' && 'action' in res) {
        if (res.action === 'submit' && 'evidence' in res && typeof res.evidence === 'string') {
          this.onSubmit(taskId, res.evidence);
          return;
        }
        if (res.action === 'failed' && 'error' in res) {
          this.deps.postMessage(room, `⚠️ 任务执行失败（${owner}）：${String(res.error).slice(0, 120)}`);
          return;
        }
      }
      this.deps.postMessage(room, `⚠️ ${owner} 对任务 ${taskId} 的回复无法识别`);
    } catch (err) {
      // 超时/失败不直接改状态——租约到期由回收器处理（缺席是常态不是故障）
      this.deps.postMessage(room, `⏳ ${owner} 未在时限内交付任务 ${taskId}，等待租约到期回收`);
    }
  }

  private onSubmit(taskId: string, evidenceText: string): void {
    const task = this.mustGet(taskId);
    const evidence = [...task.evidence, evidenceText];
    this.db
      .prepare('UPDATE room_tasks SET evidence = ?, state = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(evidence), 'review', Date.now(), taskId);
    this.deps.postMessage(task.room, `📦 任务「${task.title}」已提交验收（evidence ${evidence.length} 条），等待 ${task.approver} 确认`);
  }

  /** Lease expiry → reclaim to ready. 缺席不惩罚，只记录并回收。 */
  private reapExpired(): void {
    const now = Date.now();
    const rows = this.db
      .prepare("SELECT * FROM room_tasks WHERE state = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?")
      .all(now) as TaskRow[];
    for (const row of rows) {
      this.db
        .prepare("UPDATE room_tasks SET state = 'ready', owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(now, row.id);
      this.deps.postMessage(row.room, `♻️ 任务「${row.title}」租约到期未推进，已回收为 ready（原 owner: ${row.owner}）`);
    }
  }

  private get(id: string): RoomTask | undefined {
    const row = this.db.prepare('SELECT * FROM room_tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  private mustGet(id: string): RoomTask {
    const task = this.get(id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    return task;
  }

  private touch(id: string, patch: { state?: TaskState; owner?: string | null; leaseExpiresAt?: number | null }): void {
    const cur = this.mustGet(id);
    this.db
      .prepare('UPDATE room_tasks SET state = ?, owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.state ?? cur.state,
        patch.owner === undefined ? cur.owner : patch.owner,
        patch.leaseExpiresAt === undefined ? cur.leaseExpiresAt : patch.leaseExpiresAt,
        Date.now(),
        id
      );
  }
}

function rowToTask(row: TaskRow): RoomTask {
  return {
    id: row.id,
    room: row.room,
    title: row.title,
    acceptance: JSON.parse(row.acceptance) as string[],
    evidence: JSON.parse(row.evidence) as string[],
    owner: row.owner,
    approver: row.approver,
    state: row.state,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
