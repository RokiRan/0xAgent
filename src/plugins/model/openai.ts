// ============================================================
// Plugin: OpenAI Model Provider
// A concrete implementation using fetch (no extra deps).
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';
import { ModelProvider, Message, ToolSchema, ModelResponse, ToolCall } from './interface.js';

export interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  /** Request timeout in ms — a stalled LLM connection must not hang the agent loop forever. Default 60s. */
  timeoutMs?: number;
}

export class OpenAIProvider implements ModelProvider {
  private config: Required<OpenAIConfig>;

  constructor(config: OpenAIConfig) {
    this.config = {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      temperature: 0.7,
      timeoutMs: 60000,
      ...config,
    };
  }

  async generate(messages: Message[], tools?: ToolSchema[]): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      temperature: this.config.temperature,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.toolCalls ? {
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        } : {}),
      })),
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = 'auto';
    }

    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    const data = await res.json() as {
      choices: Array<{
        message: {
          content?: string;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const choice = data.choices[0].message;
    const toolCalls: ToolCall[] | undefined = choice.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));

    return {
      content: choice.content ?? '',
      toolCalls,
    };
  }
}

export const openaiPlugin: Plugin = {
  name: 'model:openai',
  async activate(ctx: PluginContext) {
    const cfg = ctx.config as unknown as OpenAIConfig;
    if (!cfg.apiKey) throw new Error('model:openai requires apiKey');
    const provider = new OpenAIProvider(cfg);
    ctx.services.register('model:provider', provider);
    ctx.events.emit('model:ready', { provider: 'openai', model: cfg.model ?? 'gpt-4o-mini' });
  },
};
