// ============================================================
// Plugin: Docker Sandbox
// Containerized code execution with resource limits.
// Requires Docker. Falls back to ProcessSandbox if unavailable.
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';
import { Tool } from '../tools/interface.js';
import { spawn } from 'child_process';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';

export interface DockerSandboxConfig {
  image?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  memoryLimit?: string;      // e.g. '512m'
  cpuLimit?: string;         // e.g. '1.0'
  network?: boolean;
  volumes?: string[];
}

export interface DockerSandboxResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

export class DockerSandbox {
  private config: Required<DockerSandboxConfig>;

  constructor(config: DockerSandboxConfig = {}) {
    this.config = {
      image: config.image ?? 'node:20-alpine',
      timeoutMs: config.timeoutMs ?? 30000,
      maxOutputBytes: config.maxOutputBytes ?? 1024 * 1024,
      memoryLimit: config.memoryLimit ?? '512m',
      cpuLimit: config.cpuLimit ?? '1.0',
      network: config.network ?? false,
      volumes: config.volumes ?? [],
    };
  }

  static async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('docker', ['version'], { stdio: 'ignore' });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }

  async execute(command: string[], options: {
    input?: string;
    cwd?: string;
    env?: Record<string, string>;
    image?: string;
  } = {}): Promise<DockerSandboxResult> {
    const start = Date.now();
    const id = randomBytes(8).toString('hex');
    const containerName = `agent-sandbox-${id}`;

    const args = [
      'run',
      '--rm',
      '--name', containerName,
      '-m', this.config.memoryLimit,
      '--cpus', this.config.cpuLimit,
      '-t', // allocate pseudo-tty for proper signal handling
      ...(this.config.network ? [] : ['--network', 'none']),
      ...this.config.volumes.flatMap(v => ['-v', v]),
    ];

    if (options.cwd) {
      args.push('-w', '/workspace');
      args.push('-v', `${options.cwd}:/workspace`);
    }

    // Environment variables
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push('-e', `${key}=${value}`);
    }

    args.push(this.config.image);
    args.push(...command);

    return new Promise((resolve) => {
      const child = spawn('docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      const maxBytes = this.config.maxOutputBytes;

      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < maxBytes) {
          stdout += data.toString('utf-8', 0, Math.min(data.length, maxBytes - stdout.length));
        }
        if (stdout.length >= maxBytes && !truncated) {
          truncated = true;
          child.kill('SIGTERM');
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < maxBytes) {
          stderr += data.toString('utf-8', 0, Math.min(data.length, maxBytes - stderr.length));
        }
      });

      if (options.input !== undefined) {
        child.stdin?.write(options.input);
        child.stdin?.end();
      }

      const timer = setTimeout(() => {
        // Force kill container
        spawn('docker', ['kill', containerName], { stdio: 'ignore' });
        child.kill('SIGKILL');
      }, this.config.timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          success: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code,
          durationMs: Date.now() - start,
          truncated,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          stdout: '',
          stderr: err.message,
          exitCode: null,
          durationMs: Date.now() - start,
          truncated: false,
        });
      });
    });
  }

  async runCode(language: string, code: string): Promise<DockerSandboxResult> {
    const id = randomBytes(8).toString('hex');
    const tmpDir = join('/tmp', `agent-sandbox-${id}`);
    await mkdir(tmpDir, { recursive: true });

    try {
      switch (language.toLowerCase()) {
        case 'javascript':
        case 'js':
        case 'node': {
          await writeFile(join(tmpDir, 'script.js'), code);
          return this.execute(['node', '/workspace/script.js'], { cwd: tmpDir });
        }
        case 'python':
        case 'py': {
          await writeFile(join(tmpDir, 'script.py'), code);
          return this.execute(['python3', '/workspace/script.py'], { cwd: tmpDir, image: 'python:3.11-alpine' });
        }
        case 'bash':
        case 'sh': {
          await writeFile(join(tmpDir, 'script.sh'), code);
          return this.execute(['sh', '/workspace/script.sh'], { cwd: tmpDir, image: 'alpine:latest' });
        }
        default:
          throw new Error(`Unsupported language for Docker sandbox: ${language}`);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  async runShell(command: string): Promise<DockerSandboxResult> {
    return this.execute(['sh', '-c', command], { image: 'alpine:latest' });
  }
}

// Tool wrappers
class DockerShellTool implements Tool {
  name = 'shell';
  description = 'Execute a shell command inside a Docker container with resource limits.';
  parameters = {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
    },
    required: ['command'],
  };

  constructor(private sandbox: DockerSandbox) {}

  async execute(args: Record<string, unknown>): Promise<unknown> {
    const command = args.command as string;
    const result = await this.sandbox.runShell(command);
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      truncated: result.truncated,
    };
  }
}

class DockerCodeTool implements Tool {
  name = 'code';
  description = 'Run code in a Docker sandbox (javascript, python, bash).';
  parameters = {
    type: 'object' as const,
    properties: {
      language: {
        type: 'string',
        enum: ['javascript', 'python', 'bash'],
        description: 'Programming language',
      },
      code: { type: 'string', description: 'Code to execute' },
    },
    required: ['language', 'code'],
  };

  constructor(private sandbox: DockerSandbox) {}

  async execute(args: Record<string, unknown>): Promise<unknown> {
    const language = args.language as string;
    const code = args.code as string;
    const result = await this.sandbox.runCode(language, code);
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      truncated: result.truncated,
    };
  }
}

export const dockerSandboxPlugin: Plugin = {
  name: 'sandbox:docker',
  dependencies: ['tool:filesystem'],
  async activate(ctx: PluginContext) {
    const cfg = ctx.config as unknown as DockerSandboxConfig;

    const available = await DockerSandbox.isAvailable();
    if (!available) {
      console.warn('[sandbox:docker] Docker not available. Skipping Docker sandbox.');
      return;
    }

    const sandbox = new DockerSandbox(cfg);
    ctx.services.register('sandbox:docker', sandbox);

    const registry = ctx.services.get('tool:registry') as { register: (t: Tool) => void };
    registry.register(new DockerShellTool(sandbox));
    registry.register(new DockerCodeTool(sandbox));

    ctx.events.emit('sandbox:ready', { type: 'docker' });
  },
};
