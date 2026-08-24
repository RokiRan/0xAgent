// ============================================================
// Plugin: MiniMax Model Provider (国区)
// Base URL: https://api.minimaxi.com/v1
// Model: MiniMax-M3
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';
import { ModelProvider, Message, ToolSchema, ModelResponse, ToolCall } from './interface.js';

export interface MiniMaxConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
}

export class MiniMaxProvider implements ModelProvider {
  private config: Required<MiniMaxConfig>;

  constructor(config: MiniMaxConfig) {
    this.config = {
      baseUrl: 'https://api.minimaxi.com/v1',
      model: 'MiniMax-M3',
      temperature: 0.7,
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
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MiniMax API error ${res.status}: ${text}`);
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
      usage?: { prompt_tokens?: number; completion_tokens?: number };
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
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
    };
  }
}

export const minimaxPlugin: Plugin = {
  name: 'model:minimax',
  async activate(ctx: PluginContext) {
    const cfg = ctx.config as unknown as MiniMaxConfig;
    if (!cfg.apiKey) throw new Error('model:minimax requires apiKey');
    const provider = new MiniMaxProvider(cfg);
    ctx.services.register('model:provider', provider);
    ctx.events.emit('model:ready', { provider: 'minimax', model: cfg.model ?? 'MiniMax-M3' });
  },
};
