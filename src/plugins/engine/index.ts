// ============================================================
// Coding Engine adapters (cumora BYOA 思路的最小版):
// agent 的编码任务不再只靠 LLM 空谈，而是委派给真实编码 CLI 执行。
// 引擎可插拔：新增能力 = 新增一个 CodingEngine 实现，bus-agent 主流程无感。
// 配置：CODING_ENGINE=omp|claude（不设 = LLM-only 旧行为）
//       CODING_WORKDIR（默认 $TMPDIR/0xagent-work，刻意不落仓库根——
//                      引擎有写权限，工作目录必须是显式边界）
//       CODING_TIMEOUT_MS（默认 240s，< task-board 5min 派发超时）
// ============================================================

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface EngineRunOpts {
  prompt: string;
  workdir: string;
  timeoutMs: number;
}

export interface EngineResult {
  text: string;
  exitCode: number;
  durationMs: number;
  /** claude JSON 输出自带成本；omp 无 → undefined（台账 measured=false 不猜） */
  costUsd?: number;
}

export interface CodingEngine {
  readonly id: string;
  run(opts: EngineRunOpts): Promise<EngineResult>;
}

function spawnCollect(cmd: string, args: string[], opts: EngineRunOpts): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // hub/systemd 托管进程的 PATH 很薄，找不到 ~/.bun/bin(omp)、~/.local/bin(claude)
    const env = {
      ...process.env,
      PATH: `${process.env.PATH ?? ''}:${homedir()}/.bun/bin:${homedir()}/.local/bin:/opt/homebrew/bin`,
    };
    // stdin 必须 'ignore'：omp -p 在 stdin 管道不关闭时会挂起等待（实测）
    const child = spawn(cmd, args, { cwd: opts.workdir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`engine timeout after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(new Error(`engine spawn failed: ${String(err)}`));
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: code ?? 1, durationMs: Date.now() - started });
    });
  });
}

/** omp -p：非交互 + auto-approve（无人值守必须）+ 不存 session。 */
export class OmpEngine implements CodingEngine {
  readonly id = 'omp';
  constructor(private bin = 'omp') {}
  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const r = await spawnCollect(this.bin, [
      '-p', opts.prompt,
      '--cwd', opts.workdir,
      '--auto-approve',
      '--no-session',
      '--max-time', `${Math.ceil(opts.timeoutMs / 1000)}s`,
    ], opts);
    if (r.exitCode !== 0) throw new Error(`omp exit ${r.exitCode}: ${r.stderr.slice(-500) || r.stdout.slice(-500)}`);
    return { text: r.stdout.trim(), exitCode: r.exitCode, durationMs: r.durationMs };
  }
}

/** claude -p --output-format json：结果/成本/用量单 JSON 返回。 */
export class ClaudeCodeEngine implements CodingEngine {
  readonly id = 'claude-code';
  constructor(private bin = 'claude') {}
  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const r = await spawnCollect(this.bin, [
      '-p', opts.prompt,
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
    ], opts);
    if (r.exitCode !== 0) throw new Error(`claude exit ${r.exitCode}: ${r.stderr.slice(-500) || r.stdout.slice(-500)}`);
    try {
      const data = JSON.parse(r.stdout) as { result?: string; is_error?: boolean; total_cost_usd?: number };
      if (data.is_error) throw new Error(`claude reported error: ${(data.result ?? '').slice(0, 300)}`);
      return { text: (data.result ?? '').trim(), exitCode: r.exitCode, durationMs: r.durationMs, costUsd: data.total_cost_usd };
    } catch (err) {
      if (err instanceof SyntaxError) return { text: r.stdout.trim(), exitCode: r.exitCode, durationMs: r.durationMs };
      throw err;
    }
  }
}

export interface EngineConfig {
  engine?: CodingEngine;
  workdir: string;
  timeoutMs: number;
}

export function createEngineFromEnv(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const kind = (env.CODING_ENGINE ?? '').trim();
  // 默认工作目录刻意避开仓库根：引擎持写权限，边界必须显式
  const workdir = env.CODING_WORKDIR ?? join(tmpdir(), '0xagent-work');
  mkdirSync(workdir, { recursive: true });
  const timeoutMs = Number(env.CODING_TIMEOUT_MS) || 240_000;
  const engine =
    kind === 'omp' ? new OmpEngine(env.CODING_BIN) :
    kind === 'claude' ? new ClaudeCodeEngine(env.CODING_BIN) :
    undefined;
  return { engine, workdir, timeoutMs };
}
