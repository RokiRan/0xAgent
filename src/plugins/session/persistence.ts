// ============================================================
// Plugin: File-based Session Persistence
// Save/restore conversation history to JSON files.
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';
import { Message } from '../model/interface.js';
import { Session, SessionManager } from '../session/memory.js';
import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';
import { join } from 'path';

export interface PersistenceConfig {
  storageDir: string;
  autoSave?: boolean;
}

interface StoredSession {
  id: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

class FileSessionManager implements SessionManager {
  private sessions = new Map<string, Session>();
  private dir: string;

  constructor(private config: PersistenceConfig) {
    this.dir = config.storageDir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Load existing sessions
    const files = await readdir(this.dir).catch(() => [] as string[]);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const id = file.slice(0, -5);
        const data = await readFile(join(this.dir, file), 'utf-8');
        const stored: StoredSession = JSON.parse(data);
        const session = new PersistedSession(stored.id, stored.messages, this);
        this.sessions.set(id, session);
      }
    }
  }

  create(id: string): Session {
    const session = new PersistedSession(id, [], this);
    this.sessions.set(id, session);
    this.save(session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): string[] {
    return Array.from(this.sessions.keys());
  }

  async save(session: PersistedSession): Promise<void> {
    const stored: StoredSession = {
      id: session.id,
      messages: session.messages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await writeFile(join(this.dir, `${session.id}.json`), JSON.stringify(stored, null, 2));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
    await unlink(join(this.dir, `${id}.json`)).catch(() => {});
  }
}

class PersistedSession implements Session {
  messages: Message[] = [];

  constructor(
    public id: string,
    initialMessages: Message[],
    private manager: FileSessionManager
  ) {
    this.messages = initialMessages;
  }

  add(message: Message): void {
    this.messages.push(message);
    if (this.manager) {
      this.manager.save(this);
    }
  }

  get(): Message[] {
    return this.messages;
  }

  clear(): void {
    this.messages = [];
    this.manager.save(this);
  }
}

export const persistencePlugin: Plugin = {
  name: 'session:persistence',
  async activate(ctx: PluginContext) {
    const cfg = ctx.config as unknown as PersistenceConfig;
    if (!cfg.storageDir) throw new Error('session:persistence requires storageDir');

    const manager = new FileSessionManager(cfg);
    await manager.init();
    ctx.services.register('session:manager', manager);
    ctx.events.emit('session:persistence:ready', { dir: cfg.storageDir });
  },
};
