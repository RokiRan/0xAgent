// ============================================================
// Core: Context Compactor
// Summarize long conversation history when token limit approaches.
// Lightweight alternative to Codex's /responses/compact endpoint.
// ============================================================

import { Message } from '../plugins/model/interface.js';

export interface CompactorConfig {
  tokenThreshold: number;      // Trigger compaction above this
  summaryModel?: string;       // Model to use for summarization (fallback to main model)
  preserveRecentTurns: number; // Keep N most recent turns untouched
}

export const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  tokenThreshold: 12000,
  preserveRecentTurns: 2,
};

export interface CompactionResult {
  summary: string;             // Compressed representation
  preserved: Message[];        // Recent turns kept as-is
  originalTokens: number;
  newTokens: number;
}

export class ContextCompactor {
  private config: CompactorConfig;

  constructor(config: Partial<CompactorConfig> = {}) {
    this.config = { ...DEFAULT_COMPACTOR_CONFIG, ...config };
  }

  // Simple heuristic: 1 token ≈ 4 chars English, 2 chars CJK
  estimateTokens(text: string): number {
    let tokens = 0;
    for (const char of text) {
      tokens += char.charCodeAt(0) > 127 ? 0.5 : 0.25;
    }
    return Math.ceil(tokens);
  }

  shouldCompact(messages: Message[]): boolean {
    const total = messages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
    return total > this.config.tokenThreshold;
  }

  // Compact messages: summarize older ones, preserve recent
  compact(messages: Message[]): CompactionResult {
    const originalTokens = messages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);

    if (originalTokens <= this.config.tokenThreshold) {
      return { summary: '', preserved: messages, originalTokens, newTokens: originalTokens };
    }

    // Split into older (to summarize) and recent (to preserve)
    const splitIndex = Math.max(1, messages.length - this.config.preserveRecentTurns * 2);
    const older = messages.slice(0, splitIndex);
    const preserved = messages.slice(splitIndex);

    // Naive summarization: extract key user requests and assistant responses
    const summary = this.summarize(older);
    const summaryMsg: Message = {
      role: 'system',
      content: `[Previous conversation summarized]:\n${summary}`,
    };

    const newMessages = [summaryMsg, ...preserved];
    const newTokens = newMessages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);

    return { summary, preserved, originalTokens, newTokens };
  }

  // Extract key points from older messages
  private summarize(messages: Message[]): string {
    const points: string[] = [];
    let currentTask = '';

    for (const msg of messages) {
      if (msg.role === 'user' && msg.content.length > 10) {
        currentTask = msg.content.slice(0, 200);
        points.push(`User requested: ${currentTask}`);
      } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const tools = msg.toolCalls.map(tc => tc.name).join(', ');
        points.push(`Used tools: ${tools}`);
      } else if (msg.role === 'tool') {
        const content = msg.content.slice(0, 100);
        points.push(`Tool result: ${content}`);
      }
    }

    // Deduplicate and limit
    const unique = [...new Set(points)].slice(-20);
    return unique.join('\n');
  }

  // Advanced: use a lightweight model to generate summary
  // This requires model provider injection; left as extension point
  async compactWithModel(
    messages: Message[],
    summarizeFn: (text: string) => Promise<string>
  ): Promise<CompactionResult> {
    const originalTokens = messages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);

    if (originalTokens <= this.config.tokenThreshold) {
      return { summary: '', preserved: messages, originalTokens, newTokens: originalTokens };
    }

    const splitIndex = Math.max(1, messages.length - this.config.preserveRecentTurns * 2);
    const older = messages.slice(0, splitIndex);
    const preserved = messages.slice(splitIndex);

    const olderText = older.map(m => `${m.role}: ${m.content}`).join('\n---\n');
    const summary = await summarizeFn(olderText);

    const summaryMsg: Message = {
      role: 'system',
      content: `[Conversation summary]: ${summary}`,
    };

    const newMessages = [summaryMsg, ...preserved];
    const newTokens = newMessages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);

    return { summary, preserved, originalTokens, newTokens };
  }
}
