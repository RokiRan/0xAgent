// ============================================================
// Harness Pro: Product-grade agent assembly
// ============================================================

import { Kernel } from './core/kernel.js';
import { openaiPlugin } from './plugins/model/openai.js';
import { minimaxPlugin } from './plugins/model/minimax.js';
import { filesystemPlugin } from './plugins/tools/filesystem.js';
import { sessionPlugin } from './plugins/session/memory.js';
import { persistencePlugin, PersistenceConfig } from './plugins/session/persistence.js';
import { reactLoopPlugin, AgentLoopConfig } from './plugins/agent-loop/react-loop.js';
import { sandboxPlugin, SandboxConfig } from './plugins/sandbox/process-sandbox.js';
import { plannerPlugin } from './plugins/planner/task-planner.js';
import { observabilityPlugin } from './plugins/observability/tracer.js';
import { agentBusPlugin, BusConfig } from './plugins/agent-bus/bus.js';

export type ModelProviderType = 'openai' | 'minimax';

export interface HarnessProConfig {
  modelProvider: ModelProviderType;
  model: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    temperature?: number;
  };
  filesystem: {
    rootPath: string;
    allowedPaths?: string[];
  };
  agent: AgentLoopConfig;
  sandbox?: SandboxConfig;
  persistence?: PersistenceConfig;
  bus?: BusConfig;
  enablePlanner?: boolean;
  enableObservability?: boolean;
}

export class HarnessPro {
  private kernel: Kernel;

  constructor(private config: HarnessProConfig) {
    this.kernel = new Kernel();
  }

  async start(): Promise<void> {
    // 1. Model provider
    const providerPlugin = this.config.modelProvider === 'minimax' ? minimaxPlugin : openaiPlugin;
    this.kernel.register({
      ...providerPlugin,
      activate: async (ctx) => {
        const cfg = { ...(ctx.config as unknown as Record<string, unknown>), ...this.config.model };
        await providerPlugin.activate({ ...ctx, config: cfg });
      },
    });

    // 2. Filesystem
    this.kernel.register({
      ...filesystemPlugin,
      activate: async (ctx) => {
        const cfg = { ...(ctx.config as unknown as Record<string, unknown>), ...this.config.filesystem };
        await filesystemPlugin.activate({ ...ctx, config: cfg });
      },
    });

    // 3. Sandbox (replaces raw shell tool with secure execution)
    if (this.config.sandbox !== undefined) {
      this.kernel.register({
        ...sandboxPlugin,
        activate: async (ctx) => {
          const cfg = { ...(ctx.config as unknown as Record<string, unknown>), ...(this.config.sandbox ?? {}) };
          await sandboxPlugin.activate({ ...ctx, config: cfg });
        },
      });
    }

    // 4. Session manager (memory + optional persistence)
    if (this.config.persistence) {
      this.kernel.register({
        ...persistencePlugin,
        activate: async (ctx) => {
          const cfg = { ...(ctx.config as unknown as Record<string, unknown>), ...this.config.persistence };
          await persistencePlugin.activate({ ...ctx, config: cfg });
        },
      });
    } else {
      this.kernel.register(sessionPlugin);
    }

    // 5. Agent loop
    this.kernel.register({
      ...reactLoopPlugin,
      activate: async (ctx) => {
        const cfg = { ...(ctx.config as unknown as Record<string, unknown>), ...this.config.agent };
        await reactLoopPlugin.activate({ ...ctx, config: cfg });
      },
    });

    // 6. Planner
    if (this.config.enablePlanner !== false) {
      this.kernel.register(plannerPlugin);
    }

    // 7. Observability
    if (this.config.enableObservability !== false) {
      this.kernel.register(observabilityPlugin);
    }

    // 8. Agent bus (multi-agent communication)
    if (this.config.bus) {
      this.kernel.register({
        ...agentBusPlugin,
        activate: async (ctx) => {
          const cfg = { ...(ctx.config as unknown as Record<string, unknown>), ...this.config.bus };
          await agentBusPlugin.activate({ ...ctx, config: cfg });
        },
      });
    }

    await this.kernel.loadAll();
  }

  async chat(sessionId: string, input: string): Promise<string> {
    const loop = this.kernel.context.services.get('agent:loop') as {
      run: (sessionId: string, input: string) => Promise<string>;
    };
    return loop.run(sessionId, input);
  }

  async plan(goal: string) {
    const planner = this.kernel.context.services.get('planner') as {
      createPlan(goal: string): Promise<any>;
      executePlan(plan: any): Promise<any>;
    };
    const plan = await planner.createPlan(goal);
    return planner.executePlan(plan);
  }

  get tracer() {
    return this.kernel.context.services.get('tracer') as {
      getTraces(filter?: any): any[];
      export(): string;
    } | undefined;
  }

  get bus() {
    return this.kernel.context.services.get('agent:bus') as {
      send(to: string, payload: unknown): Promise<void>;
      request<T>(to: string, payload: unknown, timeoutMs?: number): Promise<T>;
      broadcast(payload: unknown): Promise<void>;
    } | undefined;
  }

  get kernelInstance(): Kernel {
    return this.kernel;
  }
}
