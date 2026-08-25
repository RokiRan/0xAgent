// ============================================================
// Plugin: Shell Tool
// Execute shell commands with timeout and working directory.
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';
import { Tool } from './interface.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ShellConfig {
  cwd?: string;
  timeout?: number;
  allowedCommands?: string[];
}

export class ShellTool implements Tool {
  name = 'shell';
  description = 'Execute a shell command. Use with care.';
  parameters = {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default 30000)',
      },
    },
    required: ['command'],
  };

  constructor(private config: ShellConfig) {}

  async execute(args: Record<string, unknown>): Promise<unknown> {
    const command = args.command as string;
    const timeout = (args.timeout ?? this.config.timeout ?? 30000) as number;

    // Destructive/system-wide commands are blocked; the agent gets told
    // exactly which pattern matched so it can pick a safe alternative.
    const blocked = [
      'rm -rf /', 'rm -rf ~', 'rm -rf *', 'rm -rf .',
      'mkfs', 'dd if=', '> /dev/sd', ':(){ :|:& };:',
      'shutdown', 'reboot', 'poweroff', 'halt',
      'useradd', 'userdel',
    ];
    for (const b of blocked) {
      if (command.includes(b)) {
        throw new Error(`Blocked command pattern "${b}". This shell is for inspection and workspace tasks; destructive or system-wide commands are not allowed.`);
      }
    }

    const { stdout, stderr } = await execAsync(command, {
      cwd: this.config.cwd ?? process.cwd(),
      timeout,
      maxBuffer: 1024 * 1024,
    });

    return {
      success: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  }
}

export const shellPlugin: Plugin = {
  name: 'tool:shell',
  dependencies: ['tool:filesystem'],
  async activate(ctx: PluginContext) {
    const cfg = ctx.config as ShellConfig;
    const registry = ctx.services.get('tool:registry') as { register: (t: Tool) => void };
    registry.register(new ShellTool(cfg));
    ctx.events.emit('tool:registered', { name: 'shell' });
  },
};
