// ============================================================
// Agent Card: 能力档案自报（主脑调度的事实源）。
// 一切能力都是探针实测或配置派生，没有任何"声明式"字段：
//   GPU      —— nvidia-smi（Win/Linux）/ system_profiler（macOS）
//   引擎/工具 —— which/where 探测（omp/claude/git/docker/ffmpeg/go/rustc）
//   本地服务  —— 存活探测（ComfyUI :8188），服务停了卡片自动消失
//   派生能力  —— 配置派生（电源控制；目标 MAC/SSH 只能是配置，但有无自动反映）
// 失败一律记 unknown/缺席，绝不猜。卡片搭 /register 心跳进 registry。
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
  gpu?: string;
  runtimes: Record<string, string>;
  engines: string[];
  tools: string[];
  services: string[];
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

/** GPU：nvidia-smi（NVIDIA 驱动自带，Win/Linux 通吃）；macOS 走 system_profiler。 */
async function detectGpu(): Promise<string | undefined> {
  if (process.platform === 'darwin') {
    const out = await probeFull('system_profiler', ['SPDisplaysDataType', '-json']);
    if (!out) return undefined;
    try {
      const data = JSON.parse(out) as { SPDisplaysDataType?: Array<{ sppci_model?: string }> };
      return data.SPDisplaysDataType?.[0]?.sppci_model;
    } catch {
      return undefined;
    }
  }
  const out = await probe('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']);
  if (!out) return undefined;
  const [name, mem] = out.split(',').map((s) => s.trim());
  if (!name) return undefined;
  const gb = mem ? Math.round(parseInt(mem) / 1024) : 0;
  return gb > 0 ? `${name} ${gb}GB` : name;
}

// system_profiler -json 输出多行，需要全文而非首行
function probeFull(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

/** 本地服务存活探测：活着才出现在卡片上（能力是变量不是铭牌）。 */
async function detectHttp(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export interface PowerDerive {
  /** 电源控制能力（配置派生）：配置了 POWER_HOST_* 即上报 power:<name>。 */
  powerTarget?: string;
}

export async function collectAgentCard(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
  derive: PowerDerive = {},
): Promise<AgentCard> {
  const cpus = os.cpus();
  const probes = ['omp', 'claude', 'git', 'docker', 'ffmpeg', 'go', 'rustc'] as const;
  const found = await Promise.all(probes.map(async (b) => ((await detectBin(b)) ? b : null)));
  const engines: string[] = [];
  const tools: string[] = [];
  for (const b of found) {
    if (b === null) continue;
    if (b === 'omp' || b === 'claude') engines.push(b);
    else tools.push(b);
  }

  const runtimes: Record<string, string> = { node: process.version };
  const py = (await probe('python3', ['--version'])) ?? (await probe('python', ['--version']));
  runtimes.python = py ?? 'unknown';

  const [gpu, comfyui] = await Promise.all([detectGpu(), detectHttp('http://127.0.0.1:8188/system_stats')]);
  const services = comfyui ? ['comfyui:8188'] : [];

  const powers: string[] = [];
  if (derive.powerTarget) powers.push(`power:${derive.powerTarget}`);

  return {
    agentId,
    host: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cores: cpus.length,
    memGB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    gpu,
    runtimes,
    engines,
    tools,
    services,
    powers,
    codingEngine: env.CODING_ENGINE?.trim() || undefined,
    updatedAt: Date.now(),
  };
}

/** 一行紧凑摘要（~40 token），用于房间上下文注入与 UI 展示。 */
export function cardSummary(card: AgentCard): string {
  const plat = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }[card.platform] ?? card.platform;
  const eng = card.codingEngine ? `${card.codingEngine}引擎` : card.engines.length > 0 ? `${card.engines.join('/')}可用` : 'LLM-only';
  const gpu = card.gpu ? ` · ${card.gpu}` : '';
  const svc = card.services.length > 0 ? ` · ${card.services.join(' ')}` : '';
  const tools = card.tools.length > 0 ? ` · ${card.tools.join('/')}` : '';
  const powers = card.powers.length > 0 ? ` · ${card.powers.join(' ')}` : '';
  return `${card.agentId}: ${plat} ${card.arch} · ${card.cores}核${card.memGB}GB${gpu} · ${eng}${svc}${tools}${powers}`;
}
