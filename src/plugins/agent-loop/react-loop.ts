// ============================================================
// Plugin: ReAct Agent Loop
// Think -> Act -> Observe -> Repeat
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';
import { ModelProvider, Message, ToolCall } from '../model/interface.js';
import { ToolRegistry, Tool } from '../tools/interface.js';
import { Session, SessionManager } from '../session/memory.js';

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

    const toolList = this.tools.list();
    const schemas = toolList.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    for (let i = 0; i < this.maxIterations; i++) {
      const messages = session.get();
      const response = await this.model.generate(messages, schemas);

      if (response.content || response.toolCalls) {
        session.add({
          role: 'assistant',
          content: response.content ?? '',
          toolCalls: response.toolCalls,
        });
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        return response.content ?? '(no response)';
      }

      // Execute tool calls
      for (const tc of response.toolCalls) {
        const result = await this.executeTool(tc);
        session.add({
          role: 'tool',
          content: JSON.stringify(result),
          toolCallId: tc.id,
        });
      }
    }

    return 'Max iterations reached.';
  }

  private async executeTool(tc: ToolCall): Promise<unknown> {
    const tool = this.tools.get(tc.name);
    if (!tool) {
      return { error: `Tool "${tc.name}" not found` };
    }
    try {
      return await tool.execute(tc.arguments);
    } catch (err) {
      return { error: String(err) };
    }
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
