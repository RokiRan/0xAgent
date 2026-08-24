// ============================================================
// Plugin: Model Provider Interface
// Abstracts LLM calls. Implementations plug in different models.
// ============================================================

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  toolCalls?: ToolCall[];
  /**
   * Provider-reported token usage. Absent = provider did not report;
   * ledger records such calls with measured=false and NEVER guesses (cumora §7.3).
   */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ModelProvider {
  generate(messages: Message[], tools?: ToolSchema[]): Promise<ModelResponse>;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
