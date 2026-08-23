// ============================================================
// Plugin: Process Sandbox
// Secure code execution with timeouts and resource limits.
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';
import { Tool } from '../tools/interface.js';
import { spawn } from 'child_process';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';

export interface SandboxConfig {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowedEnv?: string[];
  blockedCommands?: string[];
}

export interface SandboxResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

export interface Sandbox {
  execute(command: string, args?: string[], input?: string): Promise<SandboxResult>;
  runCode(language: string, code: string): Promise<SandboxResult>;
}

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/+/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\};/, // fork bomb
  /mkfs\./i,
  /dd\s+if=.+of=\/dev\//i,
  />\s*\/dev\/null.*&&.*rm/i,
];

class ProcessSandbox implements Sandbox {
  private config: Required<SandboxConfig>;
  private workDir: string;

  constructor(config: SandboxConfig = {}) {
    this.config = {
      cwd: config.cwd ?? process.cwd(),
      timeoutMs: config.timeoutMs ?? 30000,
      maxOutputBytes: config.maxOutputBytes ?? 1024 * 1024,
      allowedEnv: config.allowedEnv ?? ['PATH', 'HOME', 'LANG', 'NODE_OPTIONS'],
      blockedCommands: config.blockedCommands ?? [],
    };
    this.workDir = this.config.cwd;
  }

  async execute(command: string, args: string[] = [], input?: string): Promise<SandboxResult> {
    // Security check
    const fullCmd = `${command} ${args.join(' ')}`;
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(fullCmd)) {
        throw new Error(`Dangerous command blocked: ${fullCmd}`);
      }
    }
    for (const blocked of this.config.blockedCommands) {
      if (command.includes(blocked) || fullCmd.includes(blocked)) {
        throw new Error(`Blocked command: ${blocked}`);
      }
    }

    const start = Date.now();
    const env: Record<string, string> = {};
    for (const key of this.config.allowedEnv) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: this.workDir,
        env,
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

      if (input !== undefined) {
        child.stdin?.write(input);
        child.stdin?.end();
      }

      const timer = setTimeout(() => {
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

  async runCode(language: string, code: string): Promise<SandboxResult> {
    const id = randomBytes(8).toString('hex');
    const tmpDir = join('/tmp', `agent-sandbox-${id}`);
    await mkdir(tmpDir, { recursive: true });

    try {
      let command: string;
      let args: string[];

      switch (language.toLowerCase()) {
        case 'javascript':
        case 'js':
        case 'node':
          await writeFile(join(tmpDir, 'script.js'), code);
          command = 'node';
          args = [join(tmpDir, 'script.js')];
          break;
        case 'python':
        case 'py':
          await writeFile(join(tmpDir, 'script.py'), code);
          command = 'python3';
          args = [join(tmpDir, 'script.py')];
          break;
        case 'typescript':
        case 'ts':
          await writeFile(join(tmpDir, 'script.ts'), code);
          command = 'npx';
          args = ['tsx', join(tmpDir, 'script.ts')];
          break;
        case 'bash':
        case 'sh':
          await writeFile(join(tmpDir, 'script.sh'), code);
          command = 'bash';
          args = [join(tmpDir, 'script.sh')];
          break;
        default:
          throw new Error(`Unsupported language: ${language}`);
      }

      const oldCwd = this.workDir;
      this.workDir = tmpDir;
      const result = await this.execute(command, args);
      this.workDir = oldCwd;
      return result;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}

// Tool wrappers for sandbox
class SandboxShellTool implements Tool {
  name = 'shell';
  description = 'Execute a shell command safely with timeouts and output limits.';
  parameters = {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
    },
    required: ['command'],
  };

  constructor(private sandbox: Sandbox) {}

  async execute(args: Record<string, unknown>): Promise<unknown> {
    const command = args.command as string;
    const result = await this.sandbox.execute('bash', ['-c', command]);
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

class SandboxCodeTool implements Tool {
  name = 'code';
  description = 'Run code in a sandboxed environment (javascript, python, typescript, bash).';
  parameters = {
    type: 'object' as const,
    properties: {
      language: {
        type: 'string',
        enum: ['javascript', 'python', 'typescript', 'bash'],
        description: 'Programming language',
      },
      code: { type: 'string', description: 'Code to execute' },
    },
    required: ['language', 'code'],
  };

  constructor(private sandbox: Sandbox) {}

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

export const sandboxPlugin: Plugin = {
  name: 'sandbox:process',
  dependencies: ['tool:filesystem'],
  async activate(ctx: PluginContext) {
    const cfg = ctx.config as unknown as SandboxConfig;
    const sandbox = new ProcessSandbox(cfg);
    ctx.services.register('sandbox', sandbox);

    // Register tools
    const registry = ctx.services.get('tool:registry') as { register: (t: Tool) => void };
    registry.register(new SandboxShellTool(sandbox));
    registry.register(new SandboxCodeTool(sandbox));

    ctx.events.emit('sandbox:ready', { type: 'process' });
  },
};
