// ============================================================
// Harness V2: Product-grade assembly with SQLite + Docker + Memory + Web UI
// ============================================================

import { Kernel } from './core/kernel.js';
import { openaiPlugin } from './plugins/model/openai.js';
import { minimaxPlugin } from './plugins/model/minimax.js';
import { filesystemPlugin } from './plugins/tools/filesystem.js';
import { ToolRegistry } from './plugins/tools/interface.js';

import { AppServerV2 } from './appserver/server-v2.js';
import { StdioTransport } from './appserver/stdio-transport.js';
import { WebSocketTransport } from './appserver/websocket-transport.js';
import { StaticServer } from './appserver/static-server.js';
import { Approver, ApprovalPolicy, DEFAULT_POLICY } from './core/approver.js';
import { PromptBuilder } from './core/prompt-builder.js';
import { ContextCompactor } from './core/compactor.js';
import { ModelProvider } from './plugins/model/interface.js';

export type ModelProviderType = 'openai' | 'minimax';

export interface HarnessV2Config {
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
  agent: {
    maxIterations?: number;
    systemInstruction?: string;
    enableCompaction?: boolean;
    compactionThreshold?: number;
  };
  approval?: ApprovalPolicy;
  transports?: ('stdio' | 'websocket')[];
  // Web UI
  webUI?: {
    enabled: boolean;
    port?: number;
    host?: string;
  };
  // Persistence
  persistence?: {
    dbPath: string;
  };
  // Memory
  enableMemory?: boolean;
}

export class HarnessV2 {
  private kernel: Kernel;
  private appServer?: AppServerV2;
  private model?: ModelProvider;
  private tools?: ToolRegistry;
  private wsTransport?: WebSocketTransport;
  private staticServer?: StaticServer;

  constructor(private config: HarnessV2Config) {
    this.kernel = new Kernel();
  }

  async start(): Promise<void> {
    // 1. Model provider
    const providerPlugin = this.config.modelProvider === 'minimax' ? minimaxPlugin : openaiPlugin;
    this.kernel.register({
      ...providerPlugin,
      activate: async (ctx) => {
        const cfg = { ...(ctx.config as Record<string, unknown>), ...this.config.model };
        await providerPlugin.activate({ ...ctx, config: cfg });
        this.model = ctx.services.get('model:provider') as ModelProvider;
      },
    });

    // 2. Filesystem tools
    this.kernel.register({
      ...filesystemPlugin,
      activate: async (ctx) => {
        const cfg = { ...(ctx.config as Record<string, unknown>), ...this.config.filesystem };
        await filesystemPlugin.activate({ ...ctx, config: cfg });
        this.tools = ctx.services.get('tool:registry') as ToolRegistry;
      },
    });

    // Load plugins
    await this.kernel.loadAll();

    if (!this.model || !this.tools) {
      throw new Error('Failed to initialize model or tools');
    }

    // 3. Build App Server V2
    const approver = new Approver(this.config.approval ?? DEFAULT_POLICY);
    const promptBuilder = new PromptBuilder({
      systemInstruction: this.config.agent.systemInstruction,
    });
    const compactor = this.config.agent.enableCompaction !== false
      ? new ContextCompactor({ tokenThreshold: this.config.agent.compactionThreshold ?? 12000 })
      : undefined;

    this.appServer = await AppServerV2.create({
      model: this.model,
      tools: this.tools,
      approver,
      promptBuilder,
      compactor,
      maxIterations: this.config.agent.maxIterations ?? 10,
      persistence: this.config.persistence,
      enableMemory: this.config.enableMemory,
    });

    // 4. Attach transports
    const transports = this.config.transports ?? ['stdio'];
    for (const t of transports) {
      if (t === 'stdio') {
        this.appServer.attach(new StdioTransport());
      } else if (t === 'websocket') {
        const wsPort = this.config.webUI?.port ?? 3001;
        this.wsTransport = new WebSocketTransport({ port: wsPort });
        this.appServer.attach(this.wsTransport);
      }
    }

    // 5. Web UI static server
    if (this.config.webUI?.enabled) {
      const uiPort = this.config.webUI.port ?? 3000;
      this.staticServer = new StaticServer({
        port: uiPort,
        host: this.config.webUI.host,
      });
      await this.staticServer.start();
      console.log(`\n🌐 Web UI: http://${this.config.webUI.host ?? 'localhost'}:${uiPort}`);
    }

    if (this.wsTransport) {
      console.log(`📡 WebSocket: ws://${this.config.webUI?.host ?? 'localhost'}:${this.config.webUI?.port ?? 3001}/jsonrpc`);
    }
  }

  get server(): AppServerV2 | undefined {
    return this.appServer;
  }

  get kernelInstance(): Kernel {
    return this.kernel;
  }

  stop(): void {
    this.staticServer?.stop();
    this.wsTransport?.close();
    this.appServer?.close();
  }
}
