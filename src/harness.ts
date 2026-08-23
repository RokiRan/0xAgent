// ============================================================
// Harness: Main Entry
// Assembles all plugins and exposes a clean API.
// ============================================================

import { Kernel } from './core/kernel.js';
import { openaiPlugin } from './plugins/model/openai.js';
import { filesystemPlugin } from './plugins/tools/filesystem.js';
import { shellPlugin } from './plugins/tools/shell.js';
import { sessionPlugin } from './plugins/session/memory.js';
import { reactLoopPlugin, AgentLoopConfig } from './plugins/agent-loop/react-loop.js';

import { minimaxPlugin } from './plugins/model/minimax.js';

export type ModelProviderType = 'openai' | 'minimax';

export interface HarnessConfig {
  modelProvider: ModelProviderType;
  model: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    temperature?: number;
  };
  tools: {
    filesystem: {
      rootPath: string;
      allowedPaths?: string[];
    };
    shell: {
      cwd?: string;
      timeout?: number;
    };
  };
  agent: AgentLoopConfig;
}

export class Harness {
  private kernel: Kernel;

  constructor(private config: HarnessConfig) {
    this.kernel = new Kernel();
  }

  async start(): Promise<void> {
    // Register all plugins with their configs
    const providerPlugin = this.config.modelProvider === 'minimax' ? minimaxPlugin : openaiPlugin;

    this.kernel.register({
      ...providerPlugin,
      activate: async (ctx) => {
        const cfg = { ...(ctx.config as unknown as Record<string, unknown>), ...this.config.model };
        await providerPlugin.activate({ ...ctx, config: cfg });
      },
    });

    this.kernel.register({
      ...filesystemPlugin,
      activate: async (ctx) => {
        const cfg = { ...(ctx.config as unknown as Record<string, unknown>), ...this.config.tools.filesystem };
        await filesystemPlugin.activate({ ...ctx, config: cfg });
      },
    });

    this.kernel.register({
      ...shellPlugin,
      activate: async (ctx) => {
        const cfg = { ...(ctx.config as unknown as Record<string, unknown>), ...this.config.tools.shell };
        await shellPlugin.activate({ ...ctx, config: cfg });
      },
    });

    this.kernel.register(sessionPlugin);

    this.kernel.register({
      ...reactLoopPlugin,
      activate: async (ctx) => {
        const cfg = { ...(ctx.config as unknown as Record<string, unknown>), ...this.config.agent };
        await reactLoopPlugin.activate({ ...ctx, config: cfg });
      },
    });

    // Load all
    await this.kernel.loadAll();
  }

  async chat(sessionId: string, input: string): Promise<string> {
    const loop = this.kernel.context.services.get('agent:loop') as {
      run: (sessionId: string, input: string) => Promise<string>;
    };
    return loop.run(sessionId, input);
  }

  get kernelInstance(): Kernel {
    return this.kernel;
  }
}
