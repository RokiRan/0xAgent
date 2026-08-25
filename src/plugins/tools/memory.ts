// ============================================================
// Plugin: Memory Tools
// Exposes remember/search as agent-callable tools so the loop
// can actively store and recall long-term notes instead of
// relying on passive session history alone.
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';
import { Tool, ToolRegistry } from './interface.js';
import { ThreadMemory } from '../../core/vector-memory.js';

export class MemoryRememberTool implements Tool {
  name = 'memory_remember';
  description = 'Store a fact, preference, or finding into long-term memory so it can be recalled in later conversations. Use for durable knowledge, not transient task state.';
  parameters = {
    type: 'object' as const,
    properties: {
      content: { type: 'string', description: 'The fact/note to remember, phrased self-contained' },
    },
    required: ['content'],
  };

  constructor(private memory: ThreadMemory) {}

  async execute(args: Record<string, unknown>): Promise<unknown> {
    const content = args.content as string;
    if (!content || content.trim().length === 0) {
      throw new Error('content must be a non-empty string');
    }
    this.memory.remember(content);
    return { success: true };
  }
}

export class MemorySearchTool implements Tool {
  name = 'memory_search';
  description = 'Search long-term memory across all past conversations and stored notes. Use when the answer may depend on earlier discussions or previously stored facts.';
  parameters = {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'What to look for' },
      topK: { type: 'number', description: 'Max results (default 5)' },
    },
    required: ['query'],
  };

  constructor(private memory: ThreadMemory) {}

  async execute(args: Record<string, unknown>): Promise<unknown> {
    const query = args.query as string;
    if (!query || query.trim().length === 0) {
      throw new Error('query must be a non-empty string');
    }
    const topK = typeof args.topK === 'number' ? args.topK : 5;
    const results = this.memory.search(query, topK);
    return {
      success: true,
      count: results.length,
      results: results.map(r => ({
        content: r.content,
        score: Number(r.score.toFixed(3)),
        role: r.role,
        threadId: r.threadId,
      })),
    };
  }
}

/** Register memory tools into an existing registry (shared by kernel & server hosts). */
export function registerMemoryTools(registry: ToolRegistry, memory: ThreadMemory): void {
  registry.register(new MemoryRememberTool(memory));
  registry.register(new MemorySearchTool(memory));
}

export const memoryToolPlugin: Plugin = {
  name: 'tool:memory',
  dependencies: ['tool:filesystem'],
  async activate(ctx: PluginContext) {
    const memory = new ThreadMemory();
    ctx.services.register('memory:thread', memory);
    registerMemoryTools(ctx.services.get('tool:registry') as ToolRegistry, memory);
    ctx.events.emit('tool:registered', { name: 'memory' });
  },
};
