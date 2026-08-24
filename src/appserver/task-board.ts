// ============================================================
// Task Board: Task/Contract + Lease as first-class objects (cumora P1).
// 完成 = 每条 acceptance 有 evidence 且 approver 确认；
// 租约逾期 → 回收回 ready；退回 → 带 note 返工并续租。
// 判定只读 DB 事实；agent 执行走 bus request/response。
// ============================================================

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type TaskState = 'pending_approval' | 'ready' | 'in_progress' | 'review' | 'done' | 'escalated' | 'cancelled';

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
  reassignCount: number;
  adr: string | null;
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
  reassign_count: number;
  adr: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskBoardDeps {
  /** Send a bus request to an agent; resolves with its reply payload. */
  requestAgent: (target: string, payload: unknown, timeoutMs?: number) => Promise<unknown>;
  /** Post a system message into a room (visible in UI, persisted). */
  postMessage: (room: string, text: string) => void;
  /** Channel members from the registry (for reassignment scoring). */
  listMembers: (room: string) => Promise<string[]>;
  /** Lease duration on (re)assignment. Default 30 min. */
  leaseMs?: number;
  /** Reaper sweep interval. Default 30s. */
  reaperIntervalMs?: number;
}

export class TaskBoard {
  readonly metrics = { leaseExpired: 0, reassigned: 0, escalated: 0, autoDefaulted: 0, nudged: 0 };
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
    // Schema migration for existing DBs (SQLite has no IF NOT EXISTS for columns)
    for (const ddl of [
      'ALTER TABLE room_tasks ADD COLUMN reassign_count INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE room_tasks ADD COLUMN adr TEXT',
      "ALTER TABLE room_tasks ADD COLUMN risk TEXT NOT NULL DEFAULT 'low'",
    ]) {
      try { this.db.exec(ddl); } catch { /* column already exists */ }
    }
    // Commitment ledger (cumora §5.3): promises + dependency edges
    this.db.exec(`CREATE TABLE IF NOT EXISTS room_promises (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      task_id TEXT NOT NULL,
      promiser TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS room_task_deps (
      blocked_task TEXT NOT NULL,
      blocking_task TEXT NOT NULL,
      last_nudge_at INTEGER,
      PRIMARY KEY (blocked_task, blocking_task)
    )`);
    // Memory layers (cumora §6.5): episode 经验 → semantic 原则需晋升门
    this.db.exec(`CREATE TABLE IF NOT EXISTS room_principles (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      text TEXT NOT NULL,
      sources TEXT NOT NULL DEFAULT '[]',
      promoted INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER
    )`);

    this.reaper = setInterval(() => void this.reapExpired(), deps.reaperIntervalMs ?? 30000);
    this.reaper.unref();
  }

  close(): void {
    clearInterval(this.reaper);
  }

  create(room: string, title: string, acceptance: string[], owner: string | null, approver: string, risk: 'low' | 'high' = 'low'): RoomTask {
    if (acceptance.length === 0) throw new Error('acceptance 不能为空（先写完成定义再开工）');
    if (owner && owner === approver) throw new Error('approver 不得等于 owner（防自我确认）');
    const now = Date.now();
    const id = `task-${randomUUID().slice(0, 8)}`;
    // risk gate: 高风险任务先停在 pending_approval，人确认后才派发（cumora §6.3 适配）
    const initialState: TaskState = risk === 'high' ? 'pending_approval' : 'ready';
    this.db
      .prepare(
        `INSERT INTO room_tasks (id, room, title, acceptance, evidence, owner, approver, state, risk, created_at, updated_at)
         VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`
      )
      .run(id, room, title, JSON.stringify(acceptance), owner, approver, initialState, risk, now, now);
    if (risk === 'high') {
      this.deps.postMessage(room, `⚠️ 高风险任务「${title}」已登记（risk=high），需人工 task/confirm 后才派发${owner ? `给 ${owner}` : ''}`);
    } else {
      this.deps.postMessage(room, `📋 新任务「${title}」已创建，验收标准 ${acceptance.length} 条${owner ? `，指派给 ${owner}` : ''}`);
    }
    const task = this.get(id)!;
    if (owner && risk !== 'high') this.assign(task, owner);
    return this.get(id)!;
  }

  /** Human confirms a high-risk task → dispatch to owner. */
  confirm(id: string): RoomTask {
    const task = this.mustGet(id);
    if (task.state !== 'pending_approval') throw new Error(`任务处于 ${task.state}，无需确认`);
    this.touch(id, { state: 'ready' });
    this.deps.postMessage(task.room, `✔️ 高风险任务「${task.title}」已获人工确认`);
    if (task.owner) this.assign(this.get(id)!, task.owner);
    return this.get(id)!;
  }

  list(room: string): RoomTask[] {
    const rows = this.db
      .prepare('SELECT * FROM room_tasks WHERE room = ? ORDER BY created_at DESC LIMIT 50')
      .all(room) as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * cumora §6.6 focus window 判定：owner 持有 in_progress 租约即处于深度工作期。
   * 判定只读 DB 事实，不看措辞；lease 逾期由 reaper 回收后自动退出窗口。
   */
  ownersInFocus(room: string): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT owner FROM room_tasks WHERE room = ? AND state = 'in_progress' AND owner IS NOT NULL")
      .all(room) as Array<{ owner: string }>;
    return rows.map((r) => r.owner);
  }

  /** Human/approver confirms: review → done. 关闭即写五行 ADR。 */
  approve(id: string): RoomTask {
    const task = this.mustGet(id);
    if (task.state !== 'review') throw new Error(`任务处于 ${task.state}，不能验收`);
    const adr = [
      `背景：任务「${task.title}」（验收标准 ${task.acceptance.length} 条）。`,
      `决定：通过验收（approver: ${task.approver}）。`,
      `否决：退回 ${task.evidence.length - 1 > 0 ? task.evidence.length - 1 : 0} 轮后定稿。`,
      `证据：${task.evidence.length} 条 evidence 在库。`,
      `回访条件：reopen 需新证据 diff。`,
    ].join('');
    this.db.prepare('UPDATE room_tasks SET state = ?, adr = ?, updated_at = ? WHERE id = ?')
      .run('done', adr, Date.now(), id);
    this.deps.postMessage(task.room, `✅ 任务「${task.title}」已通过验收`);
    return this.get(id)!;
  }

  /** Cancel is explicit and terminal — requires an ADR (为何终止、否决了什么). */
  cancel(id: string, adr: string): RoomTask {
    const task = this.mustGet(id);
    if (task.state === 'done' || task.state === 'cancelled') throw new Error(`任务已 ${task.state}`);
    if (!adr || adr.trim().length < 10) throw new Error('取消必须留 ADR（至少一句：为何终止、否决了什么）');
    this.db.prepare('UPDATE room_tasks SET state = ?, adr = ?, updated_at = ? WHERE id = ?')
      .run('cancelled', adr.trim(), Date.now(), id);
    this.deps.postMessage(task.room, `🛑 任务「${task.title}」已终止。ADR：${adr.trim()}`);
    return this.get(id)!;
  }

  /** done → in_progress only with new-evidence diff (anti-翻案空转). */
  reopen(id: string, newEvidence: string): RoomTask {
    const task = this.mustGet(id);
    if (task.state !== 'done') throw new Error('只有已完成的任务能被返工');
    if (!newEvidence.trim()) throw new Error('返工必须提交新证据 diff');
    if (!task.owner) throw new Error('任务无 owner，无法返工');
    const evidence = [...task.evidence, `[返工依据] ${newEvidence.trim()}`];
    this.db.prepare('UPDATE room_tasks SET evidence = ?, state = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(evidence), 'in_progress', Date.now() + this.leaseMs, Date.now(), id);
    this.deps.postMessage(task.room, `🔁 任务「${task.title}」因新证据返工：${newEvidence.trim().slice(0, 100)}`);
    void this.dispatch(task.owner, task.room, task.id, {
      kind: 'task', action: 'rework', taskId: task.id, room: task.room,
      title: task.title, acceptance: task.acceptance, note: `新证据返工：${newEvidence.trim()}`,
    });
    return this.get(id)!;
  }

  /**
   * 记忆晋升门（cumora §6.5）：episode 经验登记为候选原则；
   * 晋升需 N=2 个独立任务来源，或人类 pin。单次异常不得写成普遍规则。
   */
  proposePrinciple(room: string, text: string, sourceTaskId: string): void {
    const existing = this.db.prepare('SELECT * FROM room_principles WHERE room = ? AND text = ?').get(room, text) as
      | { id: string; sources: string }
      | undefined;
    if (existing) {
      const sources = JSON.parse(existing.sources) as string[];
      if (!sources.includes(sourceTaskId)) sources.push(sourceTaskId);
      this.db.prepare('UPDATE room_principles SET sources = ? WHERE id = ?').run(JSON.stringify(sources), existing.id);
      return;
    }
    this.db
      .prepare('INSERT INTO room_principles (id, room, text, sources, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(`prin-${randomUUID().slice(0, 8)}`, room, text, JSON.stringify([sourceTaskId]), Date.now());
  }

  promotePrinciple(id: string, byHumanPin = false): void {
    const row = this.db.prepare('SELECT * FROM room_principles WHERE id = ?').get(id) as
      | { sources: string; promoted: number; room: string; text: string }
      | undefined;
    if (!row) throw new Error(`原则不存在: ${id}`);
    if (row.promoted) return;
    const sources = JSON.parse(row.sources) as string[];
    if (!byHumanPin && sources.length < 2) {
      throw new Error(`晋升门拒绝：仅 ${sources.length} 个独立任务来源（需 ≥2），或由人类 pin`);
    }
    this.db.prepare('UPDATE room_principles SET promoted = 1, pinned = ? WHERE id = ?').run(byHumanPin ? 1 : 0, id);
    this.deps.postMessage(row.room, `📌 原则已晋升：「${row.text.slice(0, 80)}」（${byHumanPin ? '人类 pin' : `${sources.length} 个独立任务验证`}）`);
  }

  listPrinciples(room: string): unknown[] {
    return this.db.prepare('SELECT * FROM room_principles WHERE room = ? ORDER BY created_at DESC').all(room) as unknown[];
  }

  /** Human picks a new owner for an escalated/ready task. */
  reassign(id: string, owner: string): RoomTask {
    const task = this.mustGet(id);
    if (task.state !== 'escalated' && task.state !== 'ready') throw new Error(`任务处于 ${task.state}，不能重派`);
    this.assign(task, owner);
    return this.get(id)!;
  }

  /**
   * Create a promise (candidate) and ask the promiser to confirm via bus.
   * Only confirmed promises enter the dependency graph (抽取仅成候选，须确认).
   */
  async createPromise(room: string, taskId: string, promiser: string, dueAt: number): Promise<void> {
    const task = this.mustGet(taskId);
    const id = `promise-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare('INSERT INTO room_promises (id, room, task_id, promiser, due_at, confirmed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(id, room, taskId, promiser, dueAt, Date.now());
    this.deps.postMessage(room, `🤝 承诺候选：${promiser} 承诺「${task.title}」于 ${new Date(dueAt).toLocaleString()} 前交付，等待其确认`);
    try {
      const res = await this.deps.requestAgent(promiser, {
        kind: 'promise', action: 'confirm', promiseId: id, taskTitle: task.title, acceptance: task.acceptance,
        dueAt: new Date(dueAt).toISOString(),
      }, 60000);
      const confirmed = !!(res && typeof res === 'object' && 'confirm' in res && res.confirm === true);
      this.db.prepare('UPDATE room_promises SET confirmed = ? WHERE id = ?').run(confirmed ? 1 : 0, id);
      this.deps.postMessage(room, confirmed
        ? `🤝 ${promiser} 已确认承诺，依赖边生效`
        : `🤝 ${promiser} 未确认承诺（拒绝或弃权），依赖边不生效`);
    } catch {
      this.deps.postMessage(room, `🤝 ${promiser} 未在时限内回应承诺确认，候选搁置`);
    }
  }

  /** Add a dependency edge: blockedTask depends on blockingTask. Cycle-safe. */
  addDep(blockedTaskId: string, blockingTaskId: string): void {
    if (blockedTaskId === blockingTaskId) throw new Error('不允许自依赖');
    this.mustGet(blockedTaskId);
    this.mustGet(blockingTaskId);
    // cycle check: walk from blockingTask upward; if we reach blockedTask it's a cycle
    const seen = new Set<string>();
    let frontier = [blockingTaskId];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const f of frontier) {
        if (f === blockedTaskId) throw new Error('会形成依赖环');
        if (seen.has(f)) continue;
        seen.add(f);
        const rows = this.db.prepare('SELECT blocking_task FROM room_task_deps WHERE blocked_task = ?').all(f) as { blocking_task: string }[];
        next.push(...rows.map((r) => r.blocking_task));
      }
      frontier = next;
    }
    this.db
      .prepare('INSERT OR IGNORE INTO room_task_deps (blocked_task, blocking_task, last_nudge_at) VALUES (?, ?, NULL)')
      .run(blockedTaskId, blockingTaskId);
    this.deps.postMessage(this.mustGet(blockedTaskId).room,
      `🔗 依赖登记：「${this.mustGet(blockedTaskId).title}」阻塞于「${this.mustGet(blockingTaskId).title}」`);
  }

  /**
   * 阻塞驱动催办（cumora §6.4 适配）：只唤醒关键路径上的阻塞者，
   * 同一依赖边冷却期内不重复。由 reaper 节拍驱动。
   */
  private nudgeBlocked(now: number): void {
    const NUDGE_COOLDOWN_MS = 45 * 60 * 1000;
    const edges = this.db.prepare('SELECT * FROM room_task_deps').all() as {
      blocked_task: string; blocking_task: string; last_nudge_at: number | null;
    }[];
    for (const e of edges) {
      const blocked = this.get(e.blocked_task);
      const blocking = this.get(e.blocking_task);
      if (!blocked || !blocking) continue;
      if (blocked.state === 'done' || blocked.state === 'cancelled') continue;
      if (blocking.state === 'done' || blocking.state === 'cancelled') continue;
      // overdue = 租约已过期 或 承诺逾期未交付
      const leaseOverdue = blocking.state === 'in_progress' && blocking.leaseExpiresAt !== null && blocking.leaseExpiresAt < now;
      const promise = this.db
        .prepare('SELECT * FROM room_promises WHERE task_id = ? AND confirmed = 1 ORDER BY due_at DESC LIMIT 1')
        .get(blocking.id) as { due_at: number; promiser: string } | undefined;
      const promiseOverdue = !!promise && promise.due_at < now;
      if (!leaseOverdue && !promiseOverdue) continue;
      if (e.last_nudge_at && now - e.last_nudge_at < NUDGE_COOLDOWN_MS) continue;
      const owner = promise?.promiser ?? blocking.owner;
      if (!owner) continue;
      this.db.prepare('UPDATE room_task_deps SET last_nudge_at = ? WHERE blocked_task = ? AND blocking_task = ?')
        .run(now, e.blocked_task, e.blocking_task);
      this.metrics.nudged++;
      this.deps.postMessage(blocked.room,
        `⏰ 阻塞催办 @${owner}：「${blocking.title}」已逾期且正在阻塞「${blocked.title}」的最早完工时间，请推进或交接。`);
    }
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

  /** Lease expiry → score-based reassignment; second expiry → escalate to human. */
  private async reapExpired(): Promise<void> {
    const now = Date.now();
    this.nudgeBlocked(now);
    const rows = this.db
      .prepare("SELECT * FROM room_tasks WHERE state = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?")
      .all(now) as TaskRow[];
    for (const row of rows) {
      this.metrics.leaseExpired++;
      const task = rowToTask(row);
      if (task.reassignCount >= 1) {
        // 已重派过一次仍逾期 → 升级给人，不再自动轮转
        this.touch(task.id, { state: 'escalated', leaseExpiresAt: null });
        this.metrics.escalated++;
        this.deps.postMessage(
          task.room,
          `🚨 任务「${task.title}」升级给人类：owner ${task.owner} 租约再次到期（已自动重派 ${task.reassignCount} 次）。请决定：task/reassign 指定新 owner，或 task/cancel 终止（需留 ADR）。`
        );
        continue;
      }
      const next = await this.pickOwner(task);
      if (!next) {
        this.touch(task.id, { state: 'ready', owner: null, leaseExpiresAt: null });
        this.deps.postMessage(task.room, `♻️ 任务「${task.title}」租约到期，无在场候选可重派，回收为 ready`);
        continue;
      }
      this.metrics.reassigned++;
      this.db.prepare('UPDATE room_tasks SET reassign_count = reassign_count + 1 WHERE id = ?').run(task.id);
      this.deps.postMessage(task.room, `♻️ 任务「${task.title}」租约到期，评分重派：${task.owner} → ${next}`);
      this.assign(task, next);
    }
  }

  /** Deterministic owner scoring on DB facts (cumora §5.1.2): presence base − load + success rate. */
  private async pickOwner(task: RoomTask): Promise<string | null> {
    const members = (await this.deps.listMembers(task.room).catch(() => []))
      .filter((m) => !m.includes('gateway') && m !== task.owner);
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const m of members) {
      const load = (this.db.prepare("SELECT count(*) c FROM room_tasks WHERE owner = ? AND state = 'in_progress'").get(m) as { c: number }).c;
      const done = (this.db.prepare("SELECT count(*) c FROM room_tasks WHERE owner = ? AND state = 'done'").get(m) as { c: number }).c;
      const failed = (this.db.prepare("SELECT count(*) c FROM room_tasks WHERE owner = ? AND state IN ('cancelled','escalated')").get(m) as { c: number }).c;
      const successRate = done + failed === 0 ? 0.5 : done / (done + failed);
      const score = 100 - load * 10 + successRate * 10;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
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
    reassignCount: row.reassign_count ?? 0,
    adr: row.adr ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
