// ============================================================
// Core: SQLite Thread Persistence
// Replaces MemoryThreadManager with ACID persistence.
// ============================================================

import Database from 'better-sqlite3';
import {
  ThreadManager, Thread, Turn, Item,
  generateId,
} from './thread.js';

export interface SQLiteThreadManagerConfig {
  dbPath: string;
}

export class SQLiteThreadManager implements ThreadManager {
  private db: Database.Database;

  constructor(config: SQLiteThreadManagerConfig) {
    this.db = new Database(config.dbPath);
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        forked_from TEXT,
        archived INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        role TEXT,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        created_at INTEGER,
        completed_at INTEGER,
        metadata TEXT,
        FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns(thread_id);
      CREATE INDEX IF NOT EXISTS idx_items_turn ON items(turn_id);
      CREATE INDEX IF NOT EXISTS idx_threads_archived ON threads(archived);
    `);
  }

  create(id?: string): Thread {
    const threadId = id ?? generateId('th-');
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO threads (id, archived, created_at, updated_at)
      VALUES (?, 0, ?, ?)
    `);
    stmt.run(threadId, now, now);

    return {
      id: threadId,
      turns: [],
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  get(id: string): Thread | undefined {
    const threadRow = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined;
    if (!threadRow) return undefined;

    return this.hydrateThread(threadRow);
  }

  list(): Thread[] {
    const rows = this.db.prepare('SELECT * FROM threads WHERE archived = 0 ORDER BY updated_at DESC').all() as ThreadRow[];
    return rows.map(r => this.hydrateThread(r));
  }

  listArchived(): Thread[] {
    const rows = this.db.prepare('SELECT * FROM threads WHERE archived = 1 ORDER BY updated_at DESC').all() as ThreadRow[];
    return rows.map(r => this.hydrateThread(r));
  }

  fork(sourceId: string, newId?: string): Thread {
    const source = this.get(sourceId);
    if (!source) throw new Error(`Thread not found: ${sourceId}`);

    const forkedId = newId ?? generateId('th-');
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO threads (id, forked_from, archived, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?)
    `).run(forkedId, sourceId, now, now);

    // Copy turns and items
    for (const turn of source.turns) {
      const newTurnId = generateId('tn-');
      this.db.prepare(`
        INSERT INTO turns (id, thread_id, status, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(newTurnId, forkedId, turn.status, turn.startedAt, turn.completedAt ?? null);

      for (const item of turn.items) {
        this.db.prepare(`
          INSERT INTO items (id, turn_id, type, status, role, content, tool_call_id, tool_calls, created_at, completed_at, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          generateId('it-'),
          newTurnId,
          item.type,
          item.status,
          item.role ?? null,
          item.content ?? null,
          item.toolCallId ?? null,
          item.toolCalls ? JSON.stringify(item.toolCalls) : null,
          item.createdAt,
          item.completedAt ?? null,
          item.metadata ? JSON.stringify(item.metadata) : null
        );
      }
    }

    return this.get(forkedId)!;
  }

  archive(id: string): void {
    this.db.prepare('UPDATE threads SET archived = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
  }

  // Save a turn with all its items
  saveTurn(turn: Turn): void {
    const threadRow = this.db.prepare('SELECT id FROM threads WHERE id = ?').get(turn.threadId) as { id: string } | undefined;
    if (!threadRow) throw new Error(`Thread not found: ${turn.threadId}`);

    // Upsert turn
    const existing = this.db.prepare('SELECT id FROM turns WHERE id = ?').get(turn.id) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE turns SET status = ?, completed_at = ? WHERE id = ?
      `).run(turn.status, turn.completedAt ?? null, turn.id);
    } else {
      this.db.prepare(`
        INSERT INTO turns (id, thread_id, status, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(turn.id, turn.threadId, turn.status, turn.startedAt, turn.completedAt ?? null);
    }

    // Upsert items
    for (const item of turn.items) {
      const itemExists = this.db.prepare('SELECT id FROM items WHERE id = ?').get(item.id) as { id: string } | undefined;
      if (itemExists) {
        this.db.prepare(`
          UPDATE items SET status = ?, role = ?, content = ?, tool_call_id = ?, tool_calls = ?, completed_at = ?, metadata = ?
          WHERE id = ?
        `).run(
          item.status,
          item.role ?? null,
          item.content ?? null,
          item.toolCallId ?? null,
          item.toolCalls ? JSON.stringify(item.toolCalls) : null,
          item.completedAt ?? null,
          item.metadata ? JSON.stringify(item.metadata) : null,
          item.id
        );
      } else {
        this.db.prepare(`
          INSERT INTO items (id, turn_id, type, status, role, content, tool_call_id, tool_calls, created_at, completed_at, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id,
          turn.id,
          item.type,
          item.status,
          item.role ?? null,
          item.content ?? null,
          item.toolCallId ?? null,
          item.toolCalls ? JSON.stringify(item.toolCalls) : null,
          item.createdAt,
          item.completedAt ?? null,
          item.metadata ? JSON.stringify(item.metadata) : null
        );
      }
    }

    // Update thread timestamp
    this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), turn.threadId);
  }

  // Search threads by content
  search(query: string, limit = 10): Thread[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT t.* FROM threads t
      JOIN turns tn ON t.id = tn.thread_id
      JOIN items i ON tn.id = i.turn_id
      WHERE t.archived = 0 AND i.content LIKE ?
      ORDER BY t.updated_at DESC
      LIMIT ?
    `).all(`%${query}%`, limit) as ThreadRow[];

    return rows.map(r => this.hydrateThread(r));
  }

  private hydrateThread(row: ThreadRow): Thread {
    const turnRows = this.db.prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY started_at').all(row.id) as TurnRow[];
    const turns: Turn[] = turnRows.map(tr => {
      const itemRows = this.db.prepare('SELECT * FROM items WHERE turn_id = ? ORDER BY created_at').all(tr.id) as ItemRow[];
      const items: Item[] = itemRows.map(ir => ({
        id: ir.id,
        type: ir.type as Item['type'],
        status: ir.status as Item['status'],
        role: ir.role as Item['role'] | undefined,
        content: ir.content ?? undefined,
        toolCallId: ir.tool_call_id ?? undefined,
        toolCalls: ir.tool_calls ? JSON.parse(ir.tool_calls) : undefined,
        createdAt: ir.created_at,
        completedAt: ir.completed_at ?? undefined,
        metadata: ir.metadata ? JSON.parse(ir.metadata) : undefined,
      }));

      return {
        id: tr.id,
        threadId: tr.thread_id,
        status: tr.status as Turn['status'],
        items,
        startedAt: tr.started_at,
        completedAt: tr.completed_at ?? undefined,
      };
    });

    return {
      id: row.id,
      turns,
      forkedFrom: row.forked_from ?? undefined,
      archived: !!row.archived,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}

// --- Row types ---
interface ThreadRow {
  id: string;
  forked_from: string | null;
  archived: number;
  created_at: number;
  updated_at: number;
  metadata: string | null;
}

interface TurnRow {
  id: string;
  thread_id: string;
  status: string;
  started_at: number;
  completed_at: number | null;
}

interface ItemRow {
  id: string;
  turn_id: string;
  type: string;
  status: string;
  role: string | null;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  created_at: number;
  completed_at: number | null;
  metadata: string | null;
}
