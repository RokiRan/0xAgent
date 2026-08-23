// ============================================================
// Core: Prompt Builder
// Cache-aware message ordering: static → dynamic.
// ============================================================

import { Message } from '../plugins/model/interface.js';

export interface PromptLayer {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string;
  stability: number;   // 0-100, higher = more static/cacheable
  toolCallId?: string;
  toolCalls?: Message['toolCalls'];
}

export interface PromptBuilderConfig {
  systemInstruction?: string;
  developerConfig?: string;
  agentsMdContent?: string;
  envContext?: string;
  toolDefinitions?: string;
}

export class PromptBuilder {
  private layers: PromptLayer[] = [];

  constructor(private config: PromptBuilderConfig = {}) {}

  // Build final message list with cache-aware ordering
  build(userInput: string, history: Message[] = []): Message[] {
    this.layers = [];

    // Layer 1: System instructions (most static, front of prompt = cache hit)
    if (this.config.systemInstruction) {
      this.addLayer('system', this.config.systemInstruction, 100);
    }

    // Layer 2: Developer config (user ~/.codex/config.toml equivalent)
    if (this.config.developerConfig) {
      this.addLayer('developer', this.config.developerConfig, 95);
    }

    // Layer 3: Tool definitions (static per session)
    if (this.config.toolDefinitions) {
      this.addLayer('system', this.config.toolDefinitions, 90);
    }

    // Layer 4: AGENTS.md context (semi-static, from git root)
    if (this.config.agentsMdContent) {
      this.addLayer('user', `AGENTS.md context:\n${this.config.agentsMdContent}`, 80);
    }

    // Layer 5: Environment context (cwd, shell)
    if (this.config.envContext) {
      this.addLayer('user', `Environment: ${this.config.envContext}`, 70);
    }

    // Layer 6: Conversation history (dynamic)
    for (const msg of history) {
      this.addLayer(
        msg.role === 'system' ? 'developer' : msg.role,
        msg.content,
        50,
        msg.toolCallId,
        msg.toolCalls
      );
    }

    // Layer 7: Current user input (most dynamic, end of prompt)
    this.addLayer('user', userInput, 10);

    // Sort by stability descending, then by insertion order
    this.layers.sort((a, b) => b.stability - a.stability);

    return this.layers.map(l => ({
      role: l.role === 'developer' ? 'system' : l.role,
      content: l.content,
      ...(l.toolCallId ? { toolCallId: l.toolCallId } : {}),
      ...(l.toolCalls ? { toolCalls: l.toolCalls } : {}),
    }));
  }

  private addLayer(
    role: PromptLayer['role'],
    content: string,
    stability: number,
    toolCallId?: string,
    toolCalls?: Message['toolCalls']
  ): void {
    this.layers.push({ role, content, stability, toolCallId, toolCalls });
  }

  // Estimate token count (rough: 1 token ≈ 4 chars for English, 2 for CJK)
  estimateTokens(text: string): number {
    let tokens = 0;
    for (const char of text) {
      tokens += char.charCodeAt(0) > 127 ? 2 : 0.25;
    }
    return Math.ceil(tokens);
  }

  estimateMessagesTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
  }
}
