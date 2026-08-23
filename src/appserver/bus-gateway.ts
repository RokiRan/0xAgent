// ============================================================
// Bus Gateway: bridges the local AppServer to the Agent Bus registry.
// The local server joins channels as an agent; browser chat-room
// messages are fanned out as bus requests to every agent in the room.
// ============================================================

import { AgentBusImpl, BusMessage } from '../plugins/agent-bus/bus.js';
import { HttpTransport } from '../plugins/agent-bus/http-transport.js';

export interface RoomInfo {
  name: string;
  members: string[];
}

export interface RoomMessage {
  room: string;
  from: string;
  kind: 'user' | 'agent' | 'system';
  text: string;
  ts: number;
}

export interface RoomStore {
  insert(msg: RoomMessage): void;
  load(room: string, limit: number): RoomMessage[];
}

export interface BusGatewayConfig {
  agentId: string;
  registryUrl: string;
  /** Channels to join on startup. */
  channels?: string[];
  /** Display name for messages sent from the web UI. */
  userName?: string;
  /** Max messages kept per room for history replay. */
  historySize?: number;
  /** Optional persistence; without it room history is memory-only. */
  store?: RoomStore;
}

export class BusGateway {
  readonly agentId: string;
  private bus: AgentBusImpl;
  private transport: HttpTransport;
  private registryUrl: string;
  private userName: string;
  private historySize: number;
  private store?: RoomStore;
  /** 存储降级：连续 3 次写失败 → degraded（聊天 fail-open，标记可观测）。 */
  private storeFailures = 0;
  private degraded = false;
  private history = new Map<string, RoomMessage[]>();
  private listeners = new Set<(msg: RoomMessage) => void>();

  constructor(config: BusGatewayConfig) {
    this.agentId = config.agentId;
    this.registryUrl = config.registryUrl;
    this.userName = config.userName ?? 'web-user';
    this.historySize = config.historySize ?? 100;
    this.store = config.store;
    this.transport = new HttpTransport({
      agentId: config.agentId,
      registryUrl: config.registryUrl,
      // extraChannels are re-joined on every heartbeat → membership survives registry restarts
      channels: config.channels ?? [],
    });
    this.bus = new AgentBusImpl(config.agentId, this.transport);

    // Agents may broadcast chat events into the room; surface them as messages.
    this.bus.onMessage((msg) => this.onBusEvent(msg));
  }

  async connect(): Promise<void> {
    await this.bus.connect();
  }

  async disconnect(): Promise<void> {
    await this.bus.disconnect();
  }

  onRoomMessage(listener: (msg: RoomMessage) => void): void {
    this.listeners.add(listener);
  }

  /** Direct bus request to an agent (used by TaskBoard for assign/rework). */
  async requestAgent(target: string, payload: unknown, timeoutMs = 90000): Promise<unknown> {
    return this.bus.request(target, payload, timeoutMs);
  }

  get health(): { degraded: boolean; storeFailures: number } {
    return { degraded: this.degraded, storeFailures: this.storeFailures };
  }

  /** Post a system message into a room (persisted + broadcast to WS clients). */
  postSystemMessage(room: string, text: string): void {
    this.emit({ room, from: 'system', kind: 'system', text, ts: Date.now() });
  }

  async listRooms(): Promise<RoomInfo[]> {
    const data = (await this.getJson(`${this.registryUrl}/channels`)) as { channels?: { name: string }[] };
    const rooms: RoomInfo[] = [];
    for (const ch of data.channels ?? []) {
      rooms.push({ name: ch.name, members: await this.listMembers(ch.name) });
    }
    return rooms;
  }

  async createRoom(name: string): Promise<void> {
    await this.transport.createChannel(name);
  }

  getHistory(room: string): RoomMessage[] {
    let buf = this.history.get(room);
    if (!buf && this.store) {
      buf = this.store.load(room, this.historySize);
      this.history.set(room, buf);
    }
    return buf ?? [];
  }

  /**
   * Send a chat message to a room.
   * - With @mentions: direct bus request to each mentioned agent (they must answer).
   * - Without mentions: broadcast the message as a channel event marked human;
   *   each agent decides for itself whether to interject, and speaks by posting
   *   a chat event back into the channel.
   */
  async sendChat(room: string, text: string): Promise<{ delivered: string[] }> {
    const members = await this.listMembers(room);
    const mentions = [...text.matchAll(/@([\w-]+)/g)].map((m) => m[1]);
    const candidates = members.filter((m) => m !== this.agentId);

    this.emit({ room, from: this.userName, kind: 'user', text, ts: Date.now() });

    // Recent room context so agents see each other's messages (讨论的基础)
    const context = this.getHistory(room)
      .slice(-10)
      .map((m) => `${m.from}: ${m.text.slice(0, 500)}`);

    if (mentions.length === 0) {
      await this.transport.send({
        id: `${this.agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        type: 'event',
        from: this.agentId,
        to: 'broadcast',
        payload: { kind: 'chat', room, from: this.userName, human: true, text, context },
        channel: room,
        timestamp: Date.now(),
      });
      return { delivered: candidates };
    }

    const targets = candidates.filter((m) => mentions.includes(m));
    for (const target of targets) {
      this.bus
        .request(target, { kind: 'chat', room, from: this.userName, human: true, text, context }, 90000)
        .then((res) => {
          this.emit({
            room,
            from: target,
            kind: 'agent',
            text: this.extractReplyText(res),
            ts: Date.now(),
          });
        })
        .catch((err) => {
          this.emit({ room, from: target, kind: 'system', text: `请求失败: ${String(err)}`, ts: Date.now() });
        });
    }
    return { delivered: targets };
  }

  private onBusEvent(msg: BusMessage): void {
    if (msg.type !== 'event' || msg.from === this.agentId) return;
    const room = msg.channel ?? 'default';
    const payload = msg.payload;
    if (payload && typeof payload === 'object' && 'kind' in payload && payload.kind === 'chat' && 'text' in payload && typeof payload.text === 'string') {
      this.emit({ room, from: msg.from, kind: 'agent', text: payload.text, ts: Date.now() });
    }
  }

  private extractReplyText(res: unknown): string {
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && 'text' in res && typeof res.text === 'string') return res.text;
    return JSON.stringify(res);
  }

  private emit(msg: RoomMessage): void {
    let buf = this.history.get(msg.room);
    if (!buf) {
      buf = [];
      this.history.set(msg.room, buf);
    }
    buf.push(msg);
    if (buf.length > this.historySize) buf.shift();
    try {
      this.store?.insert(msg);
      if (this.storeFailures > 0) this.storeFailures = 0;
      if (this.degraded) {
        this.degraded = false;
        console.log('[bus-gateway] store recovered, leaving degraded mode');
      }
    } catch (err) {
      this.storeFailures++;
      if (!this.degraded && this.storeFailures >= 3) {
        this.degraded = true;
        console.error('[bus-gateway] DEGRADED: room store failing, history is memory-only');
      }
      console.error('[bus-gateway] persist failed:', err);
    }
    for (const l of this.listeners) l(msg);
  }

  async listMembers(channel: string): Promise<string[]> {
    const data = (await this.getJson(`${this.registryUrl}/channels/members?channel=${encodeURIComponent(channel)}`)) as {
      members?: string[];
    };
    return data.members ?? [];
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
