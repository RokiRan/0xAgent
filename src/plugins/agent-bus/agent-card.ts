// ============================================================
// Agent Card: 能力档案自报（主脑调度的事实源）。
// 分两部分：
//   探针实测 —— OS/CPU/内存/运行时/引擎（which/where 探测，失败记 unknown 不猜）
//   env 声明 —— AGENT_POWERS（特殊能力无法穷举扫描，声明比探测诚实）
// 卡片搭 /register 心跳的车进 registry，随心跳自愈（同渠道成员籍模式）。
// ============================================================

import os from 'node:os';
import { execFile } from 'node:child_process';

export interface AgentCard {
  agentId: string;
  host: string;
  platform: string;
  arch: string;
  osRelease: string;
  cpuModel: string;
  cores: number;
  memGB: number;
  runtimes: Record<string, string>;
  engines: string[];
  powers: string[];
  codingEngine?: string;
  updatedAt: number;
}

function probe(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim().split('\n')[0]);
    });
  });
}

async function detectBin(name: string): Promise<boolean> {
  const isWin = process.platform === 'win32';
  const out = await probe(isWin ? 'where' : 'which', [name]);
  return out !== undefined && out.length > 0;
}

export async function collectAgentCard(agentId: string, env: NodeJS.ProcessEnv = process.env): Promise<AgentCard> {
  const cpus = os.cpus();
  const engines: string[] = [];
  if (await detectBin('omp')) engines.push('omp');
  if (await detectBin('claude')) engines.push('claude');
  const runtimes: Record<string, string> = { node: process.version };
  const py =
    (await probe('python3', ['--version'])) ??
    (await probe('python', ['--version']));
  runtimes.python = py ?? 'unknown';
  return {
    agentId,
    host: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cores: cpus.length,
    memGB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    runtimes,
    engines,
    powers: (env.AGENT_POWERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    codingEngine: env.CODING_ENGINE?.trim() || undefined,
    updatedAt: Date.now(),
  };
}

/** 一行紧凑摘要（~40 token），用于房间上下文注入与 UI 展示。 */
export function cardSummary(card: AgentCard): string {
  const plat = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }[card.platform] ?? card.platform;
  const eng = card.codingEngine ? `${card.codingEngine}引擎` : card.engines.length > 0 ? `${card.engines.join('/')}可用` : 'LLM-only';
  const powers = card.powers.length > 0 ? ` · ${card.powers.join(' ')}` : '';
  return `${card.agentId}: ${plat} ${card.arch} · ${card.cores}核${card.memGB}GB · ${eng}${powers}`;
}
