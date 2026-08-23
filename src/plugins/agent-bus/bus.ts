// ============================================================
// Plugin: Agent Bus
// Multi-agent communication with pluggable transports.
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';

export interface BusMessage {
  id: string;
  type: 'request' | 'response' | 'event';
  from: string;
  to: string | 'broadcast';
  payload: unknown;
  correlationId?: string;
  timestamp: number;
  /** Registry relay channel. Absent = 'default'. */
  channel?: string;
}

export interface Transport {
  connect(agentId: string): Promise<void>;
  disconnect(): Promise<void>;
  send(msg: BusMessage): Promise<void>;
  onMessage(handler: (msg: BusMessage) => void): void;
}

export interface AgentBus {
  agentId: string;
  send(to: string, payload: unknown): Promise<void>;
  request<T = unknown>(to: string, payload: unknown, timeoutMs?: number): Promise<T>;
  broadcast(payload: unknown): Promise<void>;
  onMessage(handler: (msg: BusMessage) => void): () => void;
  onRequest(handler: (payload: unknown, reply: (response: unknown) => void) => void): () => void;
}

// In-memory transport for same-process agents
export class MemoryTransport implements Transport {
  private static brokers = new Map<string, MemoryTransport>();
  private handler?: (msg: BusMessage) => void;
  private agentId?: string;

  async connect(agentId: string): Promise<void> {
    this.agentId = agentId;
    MemoryTransport.brokers.set(agentId, this);
  }

  async disconnect(): Promise<void> {
    if (this.agentId) {
      MemoryTransport.brokers.delete(this.agentId);
    }
  }

  async send(msg: BusMessage): Promise<void> {
    if (msg.to === 'broadcast') {
      for (const [id, broker] of MemoryTransport.brokers) {
        if (id !== msg.from && broker.handler) {
          setImmediate(() => broker.handler!(msg));
        }
      }
    } else {
      const target = MemoryTransport.brokers.get(msg.to);
      if (target?.handler) {
        setImmediate(() => target.handler!(msg));
      }
    }
  }

  onMessage(handler: (msg: BusMessage) => void): void {
    this.handler = handler;
  }
}

// Redis transport for cross-process agents
export class RedisTransport implements Transport {
  private subscriber: any;
  private publisher: any;
  private agentId?: string;
  private handler?: (msg: BusMessage) => void;

  constructor(private redisUrl: string) {}

  async connect(agentId: string): Promise<void> {
    this.agentId = agentId;
    // Lazy load redis - dynamic import avoids compile-time dependency
    // @ts-ignore redis is optional peer dependency
    const redis = await import('redis').catch(() => null);
    if (!redis) throw new Error('redis package not installed');
    // @ts-ignore
    const { createClient } = redis;
    this.subscriber = createClient({ url: this.redisUrl });
    this.publisher = createClient({ url: this.redisUrl });
    await this.subscriber.connect();
    await this.publisher.connect();

    await this.subscriber.subscribe('agent:bus', (raw: string) => {
      const msg = JSON.parse(raw) as BusMessage;
      if ((msg.to === this.agentId || msg.to === 'broadcast') && msg.from !== this.agentId) {
        this.handler?.(msg);
      }
    });
  }

  async disconnect(): Promise<void> {
    await this.subscriber?.quit();
    await this.publisher?.quit();
  }

  async send(msg: BusMessage): Promise<void> {
    await this.publisher.publish('agent:bus', JSON.stringify(msg));
  }

  onMessage(handler: (msg: BusMessage) => void): void {
    this.handler = handler;
  }
}

export class AgentBusImpl implements AgentBus {
  agentId: string;
  private transport: Transport;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private msgHandlers: Set<(msg: BusMessage) => void> = new Set();
  private reqHandlers: Set<(payload: unknown, reply: (response: unknown) => void) => void> = new Set();

  constructor(agentId: string, transport: Transport) {
    this.agentId = agentId;
    this.transport = transport;
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  async connect(): Promise<void> {
    await this.transport.connect(this.agentId);
  }

  async disconnect(): Promise<void> {
    // Reject all pending
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Bus disconnected'));
    }
    this.pending.clear();
    await this.transport.disconnect();
  }

  async send(to: string, payload: unknown): Promise<void> {
    const msg: BusMessage = {
      id: this.generateId(),
      type: 'event',
      from: this.agentId,
      to,
      payload,
      timestamp: Date.now(),
    };
    await this.transport.send(msg);
  }

  async request<T = unknown>(to: string, payload: unknown, timeoutMs = 30000): Promise<T> {
    const id = this.generateId();
    const correlationId = id;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(correlationId, { resolve: resolve as any, reject, timer });

      const msg: BusMessage = {
        id,
        type: 'request',
        from: this.agentId,
        to,
        payload,
        correlationId,
        timestamp: Date.now(),
      };
      this.transport.send(msg).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(correlationId);
        reject(err);
      });
    });
  }

  async broadcast(payload: unknown): Promise<void> {
    const msg: BusMessage = {
      id: this.generateId(),
      type: 'event',
      from: this.agentId,
      to: 'broadcast',
      payload,
      timestamp: Date.now(),
    };
    await this.transport.send(msg);
  }

  onMessage(handler: (msg: BusMessage) => void): () => void {
    this.msgHandlers.add(handler);
    return () => this.msgHandlers.delete(handler);
  }

  onRequest(handler: (payload: unknown, reply: (response: unknown) => void) => void): () => void {
    this.reqHandlers.add(handler);
    return () => this.reqHandlers.delete(handler);
  }

  private handleMessage(msg: BusMessage): void {
    // Handle responses to pending requests
    if (msg.type === 'response' && msg.correlationId && this.pending.has(msg.correlationId)) {
      const pending = this.pending.get(msg.correlationId)!;
      clearTimeout(pending.timer);
      this.pending.delete(msg.correlationId);
      pending.resolve(msg.payload);
      return;
    }

    // Handle incoming requests
    if (msg.type === 'request') {
      const reply = (response: unknown) => {
        const resp: BusMessage = {
          id: this.generateId(),
          type: 'response',
          from: this.agentId,
          to: msg.from,
          payload: response,
          correlationId: msg.correlationId,
          timestamp: Date.now(),
        };
        this.transport.send(resp).catch(console.error);
      };
      for (const h of this.reqHandlers) {
        try {
          h(msg.payload, reply);
        } catch (err) {
          console.error('Request handler error:', err);
        }
      }
    }

    // Notify general message handlers
    for (const h of this.msgHandlers) {
      try {
        h(msg);
      } catch (err) {
        console.error('Message handler error:', err);
      }
    }
  }

  private generateId(): string {
    return `${this.agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

export interface BusConfig {
  agentId: string;
  transport?: 'memory' | 'redis' | 'http';
  redisUrl?: string;
  httpPort?: number;
  httpHost?: string;
  registryUrl?: string;
}

export const agentBusPlugin: Plugin = {
  name: 'agent:bus',
  async activate(ctx: PluginContext) {
    const cfg = ctx.config as unknown as BusConfig;
    if (!cfg.agentId) throw new Error('agent:bus requires agentId');

    let transport: Transport;
    if (cfg.transport === 'redis') {
      if (!cfg.redisUrl) throw new Error('agent:bus redis transport requires redisUrl');
      // @ts-ignore - redis is optional dependency
      transport = new RedisTransport(cfg.redisUrl);
    } else if (cfg.transport === 'http') {
      // Dynamic import to avoid compile-time dependency
      const { HttpTransport } = await import('./http-transport.js');
      transport = new HttpTransport({
        agentId: cfg.agentId,
        port: cfg.httpPort,
        host: cfg.httpHost,
        registryUrl: cfg.registryUrl,
      });
    } else {
      transport = new MemoryTransport();
    }

    const bus = new AgentBusImpl(cfg.agentId, transport);
    await bus.connect();
    ctx.services.register('agent:bus', bus);
    ctx.events.emit('agent:bus:connected', { agentId: cfg.agentId });
  },
};
