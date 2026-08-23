// ============================================================
// Decision Board: 分歧收敛一等对象（cumora P2，§5.2/§6.2 适配）。
// open → voting（向在场 agent 收票）→ quorum 达成 decided；
// timebox 到点 → escalated（四行结构化封套给人）→ 人超时 → 采用默认项。
// anti-reopen：decided 只有新证据 diff 能回到 voting。
// ============================================================

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type DecisionState = 'voting' | 'decided' | 'escalated';

export interface RoomDecision {
  id: string;
  room: string;
  question: string;
  options: string[];
  criterion: string;
  quorum: number;
  defaultOption: string;
  state: DecisionState;
  votes: Record<string, string>; // agentId → option
  rationales: Record<string, string>;
  decidedOption: string | null;
  decidedBy: 'quorum' | 'human' | 'auto_default' | null;
  timeboxAt: number;
  escalatedAt: number | null;
  timeboxMs: number;
  createdAt: number;
  updatedAt: number;
}

// better-sqlite3 row shape; column names are the authority
interface DecisionRow {
  id: string;
  room: string;
  question: string;
  options: string;
  criterion: string;
  quorum: number;
  default_option: string;
  state: DecisionState;
  votes: string;
  rationales: string;
  decided_option: string | null;
  decided_by: RoomDecision['decidedBy'];
  timebox_at: number;
  escalated_at: number | null;
  timebox_ms: number;
  created_at: number;
  updated_at: number;
}

export interface DecisionBoardDeps {
  requestAgent: (target: string, payload: unknown, timeoutMs?: number) => Promise<unknown>;
  postMessage: (room: string, text: string) => void;
  listMembers: (room: string) => Promise<string[]>;
  sweepIntervalMs?: number;
}

export class DecisionBoard {
  readonly metrics = { decided: 0, escalated: 0, autoDefaulted: 0 };
  private db: Database;
  private deps: DecisionBoardDeps;
  private sweeper: ReturnType<typeof setInterval>;

  constructor(db: Database, deps: DecisionBoardDeps) {
    this.db = db;
    this.deps = deps;
    this.db.exec(`CREATE TABLE IF NOT EXISTS room_decisions (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      criterion TEXT NOT NULL DEFAULT '',
      quorum INTEGER NOT NULL,
      default_option TEXT NOT NULL,
      state TEXT NOT NULL,
      votes TEXT NOT NULL DEFAULT '{}',
      rationales TEXT NOT NULL DEFAULT '{}',
      decided_option TEXT,
      decided_by TEXT,
      timebox_at INTEGER NOT NULL,
      escalated_at INTEGER,
      timebox_ms INTEGER NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    )`);
    this.sweeper = setInterval(() => this.sweep(), deps.sweepIntervalMs ?? 15000);
    this.sweeper.unref();
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  async open(
    room: string,
    question: string,
    options: string[],
    criterion: string,
    quorum: number,
    defaultOption: string,
    timeboxMs: number
  ): Promise<RoomDecision> {
    if (options.length < 2) throw new Error('至少需要两个选项');
    if (!options.includes(defaultOption)) throw new Error('默认项必须在选项之中');
    if (quorum < 1) throw new Error('quorum 至少为 1');
    const now = Date.now();
    const id = `dec-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO room_decisions (id, room, question, options, criterion, quorum, default_option, state, timebox_at, timebox_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'voting', ?, ?, ?, ?)`
      )
      .run(id, room, question, JSON.stringify(options), criterion, quorum, defaultOption, now + timeboxMs, timeboxMs, now, now);

    const optLines = options.map((o, i) => `${i + 1}. ${o}`).join('；');
    this.deps.postMessage(
      room,
      `🗳️ 表决开始「${question}」选项：${optLines}。quorum=${quorum}，${Math.round(timeboxMs / 60000)} 分钟未决则升级给人，默认项「${defaultOption}」。`
    );

    // Fan out vote requests to all agent members
    const members = (await this.deps.listMembers(room).catch(() => [])).filter((m) => !m.includes('gateway'));
    for (const m of members) {
      void this.collectVote(id, room, m, question, options, criterion, timeboxMs);
    }
    return this.mustGet(id);
  }

  list(room: string): RoomDecision[] {
    const rows = this.db
      .prepare('SELECT * FROM room_decisions WHERE room = ? ORDER BY created_at DESC LIMIT 20')
      .all(room) as DecisionRow[];
    return rows.map(rowToDecision);
  }

  /** Human decides (from escalated or voting). */
  resolve(id: string, option: string): RoomDecision {
    const d = this.mustGet(id);
    if (d.state === 'decided') throw new Error('已 decided，只有新证据 diff 可 reopen');
    if (!d.options.includes(option)) throw new Error('选项不存在');
    this.decide(d, option, 'human');
    return this.mustGet(id);
  }

  /** decided → voting, only with new-evidence diff. */
  reopen(id: string, newEvidence: string): RoomDecision {
    const d = this.mustGet(id);
    if (d.state !== 'decided') throw new Error('只有 decided 的决策涉及 reopen');
    if (!newEvidence.trim()) throw new Error('reopen 必须提交新证据 diff');
    const now = Date.now();
    this.db
      .prepare("UPDATE room_decisions SET state = 'voting', votes = '{}', rationales = '{}', decided_option = NULL, decided_by = NULL, timebox_at = ?, escalated_at = NULL, updated_at = ? WHERE id = ?")
      .run(now + d.timeboxMs, now, id);
    this.deps.postMessage(d.room, `🔁 决策「${d.question}」因新证据重开表决：${newEvidence.trim().slice(0, 100)}`);
    void this.refanout(d);
    return this.mustGet(id);
  }

  // ── internals ──

  private async refanout(d: RoomDecision): Promise<void> {
    const members = (await this.deps.listMembers(d.room).catch(() => [])).filter((m) => !m.includes('gateway'));
    for (const m of members) {
      void this.collectVote(d.id, d.room, m, d.question, d.options, d.criterion, d.timeboxMs);
    }
  }

  private async collectVote(
    id: string,
    room: string,
    agent: string,
    question: string,
    options: string[],
    criterion: string,
    timeboxMs: number
  ): Promise<void> {
    try {
      const res = await this.deps.requestAgent(
        agent,
        { kind: 'decision', action: 'vote', decisionId: id, question, options, criterion },
        timeboxMs + 30000
      );
      if (!(res && typeof res === 'object' && 'option' in res && typeof res.option === 'string')) return;
      const rationale = 'rationale' in res && typeof res.rationale === 'string' ? res.rationale : '';
      this.recordVote(id, agent, res.option, rationale);
    } catch {
      // 超时/缺席：不记票，由 timebox 收敛
    }
  }

  private recordVote(id: string, agent: string, option: string, rationale: string): void {
    const d = this.mustGet(id);
    if (d.state !== 'voting') return; // late vote ignored
    if (!d.options.includes(option)) return; // invented option = abstain
    const votes = { ...d.votes, [agent]: option };
    const rationales = { ...d.rationales, [agent]: rationale };
    this.db
      .prepare('UPDATE room_decisions SET votes = ?, rationales = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(votes), JSON.stringify(rationales), Date.now(), id);
    this.deps.postMessage(d.room, `🗳️ ${agent} 投票「${option}」${rationale ? `（${rationale.slice(0, 60)}）` : ''}`);

    // quorum check
    const tally: Record<string, number> = {};
    for (const v of Object.values(votes)) tally[v] = (tally[v] ?? 0) + 1;
    for (const [opt, n] of Object.entries(tally)) {
      if (n >= d.quorum) {
        this.decide({ ...d, votes }, opt, 'quorum');
        return;
      }
    }
  }

  private decide(d: RoomDecision, option: string, by: NonNullable<RoomDecision['decidedBy']>): void {
    this.db
      .prepare("UPDATE room_decisions SET state = 'decided', decided_option = ?, decided_by = ?, updated_at = ? WHERE id = ?")
      .run(option, by, Date.now(), d.id);
    this.metrics.decided++;
    const tally: Record<string, number> = {};
    for (const v of Object.values(d.votes)) tally[v] = (tally[v] ?? 0) + 1;
    const tallyText = Object.entries(tally).map(([o, n]) => `${o}×${n}`).join('，') || '无票';
    this.deps.postMessage(d.room, `✅ 决策已收敛「${d.question}」→ **${option}**（${by === 'quorum' ? `quorum 达成：${tallyText}` : by === 'human' ? '人类裁定' : '超时采用默认项'}）。reopen 需新证据 diff。`);
  }

  private sweep(): void {
    const now = Date.now();
    const voting = this.db
      .prepare("SELECT * FROM room_decisions WHERE state = 'voting' AND timebox_at < ?")
      .all(now) as DecisionRow[];
    for (const row of voting) {
      const d = rowToDecision(row);
      const tally: Record<string, number> = {};
      for (const v of Object.values(d.votes)) tally[v] = (tally[v] ?? 0) + 1;
      const tallyText = Object.entries(tally).map(([o, n]) => `${o}×${n}`).join('，') || '无票';
      // 四行结构化升级封套（要决定什么 / 选项与证据 / 默认项 / 时限与超时后果）
      this.db
        .prepare("UPDATE room_decisions SET state = 'escalated', escalated_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, d.id);
      this.metrics.escalated++;
      this.deps.postMessage(
        d.room,
        `🚨 决策升级给人类：\n① 要决定：${d.question}\n② 选项与票数：${d.options.join(' / ')}（${tallyText}）\n③ 默认项：「${d.defaultOption}」（open 时声明）\n④ 请在 ${Math.round(d.timeboxMs / 60000)} 分钟内 decision/resolve，超时将采用默认项。`
      );
    }
    const escalated = this.db
      .prepare("SELECT * FROM room_decisions WHERE state = 'escalated' AND escalated_at IS NOT NULL AND escalated_at + timebox_ms < ?")
      .all(now) as DecisionRow[];
    for (const row of escalated) {
      this.metrics.autoDefaulted++;
      this.decide(rowToDecision(row), row.default_option, 'auto_default');
    }
  }

  private mustGet(id: string): RoomDecision {
    const row = this.db.prepare('SELECT * FROM room_decisions WHERE id = ?').get(id) as DecisionRow | undefined;
    if (!row) throw new Error(`决策不存在: ${id}`);
    return rowToDecision(row);
  }
}

function rowToDecision(row: DecisionRow): RoomDecision {
  return {
    id: row.id,
    room: row.room,
    question: row.question,
    options: JSON.parse(row.options) as string[],
    criterion: row.criterion,
    quorum: row.quorum,
    defaultOption: row.default_option,
    state: row.state,
    votes: JSON.parse(row.votes) as Record<string, string>,
    rationales: JSON.parse(row.rationales) as Record<string, string>,
    decidedOption: row.decided_option,
    decidedBy: row.decided_by,
    timeboxAt: row.timebox_at,
    escalatedAt: row.escalated_at,
    timeboxMs: row.timebox_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
