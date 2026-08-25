// ============================================================
// Plugin: ReAct Agent Loop
// Think -> Act -> Observe -> Repeat
// Loop core lives in tool-loop.ts; this plugin binds it to
// kernel services (model / tool registry / session manager).
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';
import { ModelProvider } from '../model/interface.js';
import { ToolRegistry } from '../tools/interface.js';
import { SessionManager } from '../session/memory.js';
import { runToolLoop } from './tool-loop.js';

const SYSTEM_PROMPT = `You are a helpful assistant with access to tools.
When you need to perform an action, use a tool call.
After receiving tool results, respond to the user.
Be concise. If no tool is needed, answer directly.`;

export interface AgentLoopConfig {
  maxIterations?: number;
}

class ReActLoop {
  private model: ModelProvider;
  private tools: ToolRegistry;
  private sessions: SessionManager;
  private maxIterations: number;

  constructor(ctx: PluginContext, config: AgentLoopConfig) {
    this.model = ctx.services.get('model:provider') as ModelProvider;
    this.tools = ctx.services.get('tool:registry') as ToolRegistry;
    this.sessions = ctx.services.get('session:manager') as SessionManager;
    this.maxIterations = config.maxIterations ?? 10;
  }

  async run(sessionId: string, userInput: string): Promise<string> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.sessions.create(sessionId);
      session.add({ role: 'system', content: SYSTEM_PROMPT });
    }

    session.add({ role: 'user', content: userInput });

    const result = await runToolLoop(this.model, this.tools, session.get(), {
      maxIterations: this.maxIterations,
      onMessage: (m) => session.add(m),
    });
    return result.text;
  }
}

export const reactLoopPlugin: Plugin = {
  name: 'agent-loop:react',
  dependencies: ['tool:filesystem'],
  async activate(ctx: PluginContext) {
    const config = ctx.config as AgentLoopConfig;
    const loop = new ReActLoop(ctx, config);
    ctx.services.register('agent:loop', loop);
    ctx.events.emit('agent:ready', { loop: 'react' });
  },
};
