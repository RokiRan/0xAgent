// ============================================================
// LLM Ledger (server side): llm_calls 台账，cumora §7.3 适配。
// 一行 = 一次出站模型调用。诚实账本三原则：
//   1. fire-and-forget——insert 失败只 warn，绝不弄挂调用本身；
//   2. measured=false 时 token 记 NULL（聚合按 0），绝不猜测；
//   3. 错误调用也入账（status='error'），烧钱的事故要留痕。
// ============================================================

import type { Database } from 'better-sqlite3';
import type { LlmCallRecord } from '../plugins/model/recording.js';

export interface LlmStatsRow {
  purpose: string;
  agentId: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
}

export class LlmLedger {
  private insertStmt;

  constructor(private db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      measured INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'ok'
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_llm_calls_ts ON llm_calls(ts)');
    this.insertStmt = this.db.prepare(
      `INSERT INTO llm_calls (ts, agent_id, purpose, model, input_tokens, output_tokens, measured, latency_ms, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }

  /** Fire-and-forget：DB 故障只 warn（cumora：untracked spend 不可阻塞调用）。 */
  record = (rec: LlmCallRecord): void => {
    try {
      this.insertStmt.run(
        rec.ts, rec.agentId, rec.purpose, rec.model,
        rec.inputTokens ?? null, rec.outputTokens ?? null,
        rec.measured ? 1 : 0, rec.latencyMs, rec.status
      );
    } catch (err) {
      console.warn('[llm-ledger] insert failed (call unaffected):', err);
    }
  };

  /** Aggregate per (purpose, agentId) over the trailing `hours` window. */
  stats(hours = 24): LlmStatsRow[] {
    const since = Date.now() - hours * 3600_000;
    return this.db.prepare(
      `SELECT purpose, agent_id AS agentId,
              COUNT(*) AS calls,
              SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
              COALESCE(SUM(CASE WHEN measured = 1 THEN input_tokens ELSE 0 END), 0) AS inputTokens,
              COALESCE(SUM(CASE WHEN measured = 1 THEN output_tokens ELSE 0 END), 0) AS outputTokens,
              ROUND(AVG(latency_ms)) AS avgLatencyMs
       FROM llm_calls WHERE ts >= ?
       GROUP BY purpose, agent_id ORDER BY calls DESC`
    ).all(since) as LlmStatsRow[];
  }
}
