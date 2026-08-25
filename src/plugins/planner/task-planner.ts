// ============================================================
// Plugin: Task Planner
// Decomposes complex goals into subtasks and orchestrates execution.
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';
import { ModelProvider, Message } from '../model/interface.js';
import { ToolRegistry } from '../tools/interface.js';
import { runToolLoop } from '../agent-loop/tool-loop.js';

export interface SubTask {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  dependsOn: string[];
}

export interface Plan {
  goal: string;
  tasks: SubTask[];
  status: 'planning' | 'executing' | 'completed' | 'failed';
}

export interface Planner {
  createPlan(goal: string): Promise<Plan>;
  executePlan(plan: Plan): Promise<Plan>;
}

const PLANNER_SYSTEM_PROMPT = `You are a task planner. Given a goal, break it down into concrete subtasks.

Rules:
1. Each subtask must be specific and actionable
2. Order tasks by dependency (earlier tasks = fewer dependencies)
3. Use tool calls when appropriate (filesystem, shell, code)
4. Keep tasks small (prefer 3-10 tasks)

Respond in JSON format:
{
  "tasks": [
    { "id": "1", "description": "...", "dependsOn": [] },
    { "id": "2", "description": "...", "dependsOn": ["1"] }
  ]
}`;

class LLMPlanner implements Planner {
  private model: ModelProvider;
  private tools: ToolRegistry;

  constructor(ctx: PluginContext) {
    this.model = ctx.services.get('model:provider') as ModelProvider;
    this.tools = ctx.services.get('tool:registry') as ToolRegistry;
  }

  async createPlan(goal: string): Promise<Plan> {
    const messages: Message[] = [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      { role: 'user', content: `Goal: ${goal}\n\nBreak this into subtasks.` },
    ];

    const response = await this.model.generate(messages);
    let tasks: SubTask[] = [];

    try {
      const parsed = JSON.parse(response.content) as { tasks: Array<{ id: string; description: string; dependsOn?: string[] }> };
      tasks = parsed.tasks.map(t => ({
        id: t.id,
        description: t.description,
        status: 'pending' as const,
        dependsOn: t.dependsOn ?? [],
      }));
    } catch {
      // Fallback: single task
      tasks = [{ id: '1', description: goal, status: 'pending', dependsOn: [] }];
    }

    return { goal, tasks, status: 'planning' };
  }

  async executePlan(plan: Plan): Promise<Plan> {
    plan.status = 'executing';

    // Topological sort by dependency
    const completed = new Set<string>();
    const failed = new Set<string>();

    while (completed.size + failed.size < plan.tasks.length) {
      const ready = plan.tasks.filter(
        t => t.status === 'pending' && t.dependsOn.every(d => completed.has(d))
      );

      if (ready.length === 0 && completed.size + failed.size < plan.tasks.length) {
        // Circular dependency or all remaining blocked
        const remaining = plan.tasks.filter(t => t.status === 'pending');
        remaining.forEach(t => { t.status = 'failed'; t.result = 'Blocked by dependencies'; });
        break;
      }

      // Execute ready tasks (sequential for now, parallel possible)
      for (const task of ready) {
        task.status = 'running';
        // Downstream tasks see upstream deliverables — a dependency that
        // carries no result forward is a dependency in name only.
        const priorResults = plan.tasks
          .filter(t => t.status === 'completed' && t.result)
          .map(t => `- [${t.id}] ${t.description}\n  结果: ${t.result}`)
          .join('\n');
        try {
          const result = await this.executeTask(task, priorResults);
          task.result = result;
          task.status = 'completed';
          completed.add(task.id);
        } catch (err) {
          task.result = String(err);
          task.status = 'failed';
          failed.add(task.id);
        }
      }
    }

    plan.status = failed.size > 0 ? 'failed' : 'completed';
    return plan;
  }

  private async executeTask(task: SubTask, priorResults: string): Promise<string> {
    const messages: Message[] = [
      { role: 'system', content: '你是子任务执行器。使用可用的工具（filesystem/shell 等）真正完成子任务——该读文件的读文件、该跑命令的跑命令，不要只描述做法。完成后简要报告实际做了什么、关键产出是什么。' },
      { role: 'user', content: `${priorResults ? `已完成的前置子任务及结果：\n${priorResults}\n\n` : ''}当前子任务：${task.description}` },
    ];

    const result = await runToolLoop(this.model, this.tools, messages, { maxIterations: 8 });
    return result.text;
  }
}

export const plannerPlugin: Plugin = {
  name: 'planner:llm',
  dependencies: ['tool:filesystem'],
  async activate(ctx: PluginContext) {
    const planner = new LLMPlanner(ctx);
    ctx.services.register('planner', planner);
    ctx.events.emit('planner:ready', {});
  },
};
