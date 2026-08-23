// ============================================================
// Plugin: In-Memory Session
// Simple conversation history storage.
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';
import { Message } from '../model/interface.js';

export interface Session {
  id: string;
  messages: Message[];
  add(message: Message): void;
  get(): Message[];
  clear(): void;
}

class MemorySession implements Session {
  messages: Message[] = [];

  constructor(public id: string) {}

  add(message: Message): void {
    this.messages.push(message);
  }

  get(): Message[] {
    return this.messages;
  }

  clear(): void {
    this.messages = [];
  }
}

export interface SessionManager {
  create(id: string): Session;
  get(id: string): Session | undefined;
  list(): string[];
}

class MemorySessionManager implements SessionManager {
  private sessions = new Map<string, MemorySession>();

  create(id: string): Session {
    const s = new MemorySession(id);
    this.sessions.set(id, s);
    return s;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): string[] {
    return Array.from(this.sessions.keys());
  }
}

export const sessionPlugin: Plugin = {
  name: 'session:memory',
  async activate(ctx: PluginContext) {
    const manager = new MemorySessionManager();
    ctx.services.register('session:manager', manager);
    ctx.events.emit('session:ready', {});
  },
};
