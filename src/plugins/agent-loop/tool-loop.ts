// ============================================================
// Standalone Tool-Calling Loop
// Session-agnostic core shared by the ReAct plugin and the
// standalone bus-agent. Think -> Act -> Observe -> Repeat.
// ============================================================

import { ModelProvider, Message, ToolCall } from '../model/interface.js';
import { ToolRegistry } from '../tools/interface.js';

export interface ToolLoopOptions {
  /** Hard cap on model<->tool rounds. Default 10. */
  maxIterations?: number;
  /** Persist/observe each assistant & tool message as it happens. */
  onMessage?: (message: Message) => void;
  /** Observability hook for tool invocations (logging, audit). */
  onToolCall?: (call: ToolCall, result: unknown) => void;
}

export interface ToolLoopResult {
  text: string;
  iterations: number;
  toolCalls: number;
  /** True when the iteration cap was hit and the text is a forced summary. */
  truncated: boolean;
}

async function executeToolCall(tools: ToolRegistry, tc: ToolCall): Promise<unknown> {
  const tool = tools.get(tc.name);
  if (!tool) {
    const available = tools.list().map(t => t.name).join(', ') || '(none)';
    return { error: `Tool "${tc.name}" not found. Available tools: ${available}` };
  }
  try {
    return await tool.execute(tc.arguments);
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Run a model<->tool conversation to completion.
 *
 * `messages` is the seed (system/user/...); assistant and tool messages
 * produced during the loop are appended to an internal copy and surfaced
 * via onMessage — the caller decides whether/how to persist them.
 *
 * When the iteration cap is hit, one final tool-less generate asks the
 * model to summarize where it got to, so the caller never gets the bare
 * string 'Max iterations reached.' as an answer.
 */
export async function runToolLoop(
  model: ModelProvider,
  tools: ToolRegistry,
  messages: Message[],
  opts: ToolLoopOptions = {},
): Promise<ToolLoopResult> {
  const maxIterations = opts.maxIterations ?? 10;
  const history: Message[] = [...messages];
  const schemas = tools.list().map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const toolArg = schemas.length > 0 ? schemas : undefined;
  let toolCalls = 0;

  for (let i = 0; i < maxIterations; i++) {
    const response = await model.generate(history, toolArg);

    if (response.content || response.toolCalls) {
      const msg: Message = {
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: response.toolCalls,
      };
      history.push(msg);
      opts.onMessage?.(msg);
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      return { text: response.content ?? '(no response)', iterations: i + 1, toolCalls, truncated: false };
    }

    for (const tc of response.toolCalls) {
      toolCalls++;
      const result = await executeToolCall(tools, tc);
      const msg: Message = {
        role: 'tool',
        content: JSON.stringify(result),
        toolCallId: tc.id,
      };
      history.push(msg);
      opts.onMessage?.(msg);
      opts.onToolCall?.(tc, result);
    }
  }

  // Cap hit: force a tool-less wrap-up so partial work is still delivered.
  history.push({
    role: 'user',
    content: '你已达到最大工具调用轮次。请停止调用工具，基于目前已获得的信息直接给出最终回答，并注明哪些地方未能完成核实。',
  });
  const final = await model.generate(history, undefined);
  return {
    text: final.content ?? '(max iterations reached, no summary)',
    iterations: maxIterations,
    toolCalls,
    truncated: true,
  };
}
