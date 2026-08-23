// ============================================================
// Agent Parallel Scheduler
// Distributes tasks across multiple sub-agents and aggregates results.
// ============================================================

import { ModelProvider, Message, ToolSchema } from '../plugins/model/interface.js';
import { ToolRegistry } from '../plugins/tools/interface.js';

export interface SubAgentConfig {
  id: string;
  model?: ModelProvider; // Uses parent model if not specified
  systemPrompt?: string;
  tools?: string[]; // Tool names to expose; empty = all
  maxIterations?: number;
}

export interface ParallelTask {
  id: string;
  description: string;
  context?: string;
  agentId?: string; // Specific agent, or auto-assign
}

export interface ParallelResult {
  taskId: string;
  agentId: string;
  success: boolean;
  output: string;
  durationMs: number;
  error?: string;
}

export interface SchedulerConfig {
  agents: SubAgentConfig[];
  maxConcurrency?: number;
  aggregationModel?: ModelProvider; // For result synthesis
}

export class ParallelScheduler {
  private agents: Map<string, SubAgent> = new Map();
  private defaultModel: ModelProvider;

  constructor(
    private config: SchedulerConfig,
    defaultModel: ModelProvider,
    private toolRegistry: ToolRegistry
  ) {
    this.defaultModel = defaultModel;
    for (const cfg of config.agents) {
      this.agents.set(cfg.id, new SubAgent(cfg, cfg.model ?? defaultModel, toolRegistry));
    }
  }

  // Execute tasks in parallel with concurrency limit
  async runParallel(tasks: ParallelTask[]): Promise<ParallelResult[]> {
    const concurrency = this.config.maxConcurrency ?? tasks.length;
    const results: ParallelResult[] = [];
    const queue = [...tasks];
    const running = new Set<Promise<void>>();

    return new Promise((resolve) => {
      const runNext = () => {
        if (queue.length === 0 && running.size === 0) {
          resolve(results);
          return;
        }

        while (running.size < concurrency && queue.length > 0) {
          const task = queue.shift()!;
          const promise = this.executeTask(task).then((result) => {
            results.push(result);
            running.delete(promise);
            runNext();
          });
          running.add(promise);
        }
      };

      runNext();
    });
  }

  // Execute a single task
  private async executeTask(task: ParallelTask): Promise<ParallelResult> {
    const start = Date.now();
    const agentId = task.agentId ?? this.pickAgent(task);
    const agent = this.agents.get(agentId);

    if (!agent) {
      return {
        taskId: task.id,
        agentId,
        success: false,
        output: '',
        durationMs: Date.now() - start,
        error: `Agent not found: ${agentId}`,
      };
    }

    try {
      const output = await agent.run(task.description, task.context);
      return {
        taskId: task.id,
        agentId,
        success: true,
        output,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        taskId: task.id,
        agentId,
        success: false,
        output: '',
        durationMs: Date.now() - start,
        error: String(err),
      };
    }
  }

  // Auto-assign agent based on task description
  private pickAgent(task: ParallelTask): string {
    // Simple round-robin or keyword matching
    const agents = Array.from(this.agents.keys());
    if (agents.length === 0) throw new Error('No agents available');

    // Keyword-based routing
    const desc = task.description.toLowerCase();
    for (const [id, agent] of this.agents) {
      const cfg = agent.getConfig();
      if (cfg.systemPrompt) {
        const keywords = cfg.systemPrompt.toLowerCase().split(/\s+/);
        if (keywords.some(kw => desc.includes(kw))) {
          return id;
        }
      }
    }

    // Fallback: hash-based
    const hash = task.id.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    return agents[hash % agents.length];
  }

  // Aggregate parallel results into a coherent response
  async aggregate(query: string, results: ParallelResult[]): Promise<string> {
    const aggregationModel = this.config.aggregationModel ?? this.defaultModel;

    const prompt = `You are synthesizing results from multiple agents.

Original query: ${query}

Agent results:
${results.map(r => `
--- Agent ${r.agentId} (task: ${r.taskId}) ---
Success: ${r.success}
${r.output}
${r.error ? `Error: ${r.error}` : ''}
`).join('\n')}

Please synthesize these results into a coherent, comprehensive response.
If some agents failed, note what was attempted and what succeeded.
Be concise but thorough.`;

    const response = await aggregationModel.generate([
      { role: 'user', content: prompt }
    ]);

    return response.content;
  }

  // Map-Reduce pattern: map tasks, reduce results
  async mapReduce<T>(
    items: T[],
    mapFn: (item: T) => ParallelTask,
    reduceFn?: (results: ParallelResult[]) => Promise<string>
  ): Promise<string> {
    const tasks = items.map(mapFn);
    const results = await this.runParallel(tasks);

    if (reduceFn) {
      return reduceFn(results);
    }

    // Default aggregation
    const successResults = results.filter(r => r.success);
    if (successResults.length === 0) {
      return `All ${results.length} tasks failed. Errors: ${results.map(r => r.error).join('; ')}`;
    }

    return successResults.map(r => r.output).join('\n\n---\n\n');
  }
}

// ── Sub Agent ──
class SubAgent {
  constructor(
    private config: SubAgentConfig,
    private model: ModelProvider,
    private toolRegistry: ToolRegistry
  ) {}

  getConfig(): SubAgentConfig {
    return this.config;
  }

  async run(task: string, context?: string): Promise<string> {
    const messages: Message[] = [];

    if (this.config.systemPrompt) {
      messages.push({ role: 'system', content: this.config.systemPrompt });
    }

    if (context) {
      messages.push({ role: 'system', content: `Context: ${context}` });
    }

    messages.push({ role: 'user', content: task });

    const maxIterations = this.config.maxIterations ?? 5;
    const toolSchemas = this.getToolSchemas();

    for (let i = 0; i < maxIterations; i++) {
      const response = await this.model.generate(messages, toolSchemas);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        return response.content;
      }

      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      });

      for (const tc of response.toolCalls) {
        const tool = this.toolRegistry.get(tc.name);
        let result: unknown;
        try {
          result = tool ? await tool.execute(tc.arguments) : { error: `Tool not found: ${tc.name}` };
        } catch (err) {
          result = { error: String(err) };
        }

        messages.push({
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          toolCallId: tc.id,
        });
      }
    }

    return messages[messages.length - 1]?.content ?? 'Max iterations reached';
  }

  private getToolSchemas(): ToolSchema[] {
    const allTools = this.toolRegistry.list();
    const allowed = this.config.tools;

    const tools = allowed && allowed.length > 0
      ? allTools.filter(t => allowed.includes(t.name))
      : allTools;

    return tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}
