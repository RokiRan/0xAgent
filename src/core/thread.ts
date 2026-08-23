// ============================================================
// Core: Thread Primitives (Item / Turn / Thread)
// Inspired by Codex App Server protocol.
// ============================================================

export type ItemType = 'message' | 'tool_call' | 'tool_result' | 'diff' | 'approval_request' | 'approval_response';
export type ItemStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface Item {
  id: string;
  type: ItemType;
  status: ItemStatus;
  role?: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: string;
  delta?: string;              // streaming chunk
  toolCallId?: string;
  toolCalls?: ToolCallItem[];
  createdAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ToolCallItem {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface Turn {
  id: string;
  threadId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  items: Item[];
  startedAt: number;
  completedAt?: number;
}

export interface Thread {
  id: string;
  turns: Turn[];
  forkedFrom?: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

// --- Lightweight IDs ---
let _idCounter = 0;
export function generateId(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}-${(++_idCounter).toString(36)}`;
}

// --- Thread Manager ---
export interface ThreadManager {
  create(id?: string): Thread;
  get(id: string): Thread | undefined;
  list(): Thread[];
  fork(sourceId: string, newId?: string): Thread;
  archive(id: string): void;
  delete(id: string): void;
}

export class MemoryThreadManager implements ThreadManager {
  private threads = new Map<string, Thread>();

  create(id?: string): Thread {
    const threadId = id ?? generateId('th-');
    const thread: Thread = {
      id: threadId,
      turns: [],
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.threads.set(threadId, thread);
    return thread;
  }

  get(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  list(): Thread[] {
    return Array.from(this.threads.values());
  }

  fork(sourceId: string, newId?: string): Thread {
    const source = this.threads.get(sourceId);
    if (!source) throw new Error(`Thread not found: ${sourceId}`);

    const forked: Thread = {
      id: newId ?? generateId('th-'),
      turns: source.turns.map(t => ({
        ...t,
        id: generateId('tn-'),
        items: t.items.map(i => ({ ...i, id: generateId('it-') })),
      })),
      forkedFrom: sourceId,
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.threads.set(forked.id, forked);
    return forked;
  }

  archive(id: string): void {
    const t = this.threads.get(id);
    if (t) t.archived = true;
  }

  delete(id: string): void {
    this.threads.delete(id);
  }
}

// --- Turn helpers ---
export function createTurn(threadId: string): Turn {
  return {
    id: generateId('tn-'),
    threadId,
    status: 'pending',
    items: [],
    startedAt: Date.now(),
  };
}

export function createItem(type: ItemType, overrides: Partial<Item> = {}): Item {
  return {
    id: generateId('it-'),
    type,
    status: 'pending',
    createdAt: Date.now(),
    ...overrides,
  };
}

// --- Conversion to legacy Message[] (for model providers) ---
import { Message } from '../plugins/model/interface.js';

export function threadToMessages(thread: Thread): Message[] {
  const messages: Message[] = [];

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type === 'message' && item.role) {
        messages.push({
          role: item.role === 'developer' ? 'system' : item.role,
          content: item.content ?? '',
        });
      } else if (item.type === 'tool_call' && item.toolCalls) {
        messages.push({
          role: 'assistant',
          content: '',
          toolCalls: item.toolCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          })),
        });
      } else if (item.type === 'tool_result') {
        messages.push({
          role: 'tool',
          content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
          toolCallId: item.toolCallId,
        });
      }
    }
  }

  return messages;
}
