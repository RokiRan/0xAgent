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
  /** Shared token when the registry gate is enabled. */
  registryToken?: string;
  /** Channels to join on startup. */
  channels?: string[];
  /** Display name for messages sent from the web UI. */
  userName?: string;
  /** Max messages kept per room for history replay. */
  historySize?: number;
  /** Optional persistence; without it room history is memory-only. */
  store?: RoomStore;
  /**
   * cumora §6.6 focus window probe: returns true when the agent holds an
   * active lease (deep work). Focused agents are skipped on room fan-out;
   * their messages accumulate in a digest flushed when the window ends.
   */
  isFocused?: (agentId: string, room: string) => boolean;
  /**
   * Room context budget in approximate tokens (chars/2, CJK-biased).
   * Default 3000. Replaces the old fixed slice(-10) window.
   */
  contextTokens?: number;
  /**
   * Promoted principles for a room (cumora §6.5 闭环): injected at the head
   * of agent context so vetted knowledge actually reaches agents.
   */
  loadPrinciples?: (room: string) => string[];
  /** @mention request timeout (ms). Default 90000; tests set it short. */
  requestTimeoutMs?: number;
  /**
   * future-you（cumora §9.2.1）：agent 经 bus request kind:'reminder'
   * 给自己或他人排定时唤醒。直连 relay（非广播），不污染房间 rounds。
   */
  createReminder?: (room: string, agentId: string, prompt: string, scheduledFor: number) => unknown;
}

export class BusGateway {
  readonly agentId: string;
  private bus: AgentBusImpl;
  private transport: HttpTransport;
  private registryUrl: string;
  private userName: string;
  private historySize: number;
  private store?: RoomStore;
  private isFocused?: (agentId: string, room: string) => boolean;
  private loadPrinciples?: (room: string) => string[];
  private requestTimeoutMs: number;
  private contextTokens: number;
  /** Focus-window digests: `${room}:${agentId}` → held messages (cap 50, oldest dropped). */
  private digests = new Map<string, RoomMessage[]>();
  private static readonly DIGEST_CAP = 50;
  /** 存储降级：连续 3 次写失败 → degraded（聊天 fail-open，标记可观测）。 */
  private storeFailures = 0;
  private degraded = false;
  private history = new Map<string, RoomMessage[]>();
  private loadedRooms = new Set<string>();
  private listeners = new Set<(msg: RoomMessage) => void>();

  private registryToken?: string;

  constructor(config: BusGatewayConfig) {
    this.agentId = config.agentId;
    this.registryUrl = config.registryUrl;
    this.registryToken = config.registryToken;
    this.userName = config.userName ?? 'web-user';
    this.historySize = config.historySize ?? 100;
    this.store = config.store;
    this.isFocused = config.isFocused;
    this.loadPrinciples = config.loadPrinciples;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 90000;
    this.contextTokens = config.contextTokens ?? 3000;
    this.transport = new HttpTransport({
      agentId: config.agentId,
      registryUrl: config.registryUrl,
      registryToken: config.registryToken,
      // extraChannels are re-joined on every heartbeat → membership survives registry restarts
      channels: config.channels ?? [],
    });
    this.bus = new AgentBusImpl(config.agentId, this.transport);

    // Agents may broadcast chat events into the room; surface them as messages.
    this.bus.onMessage((msg) => this.onBusEvent(msg));

    // future-you: agents schedule reminders via direct bus request (RPC plane,
    // not the chat channel — never counted in rounds, never shown to peers).
    this.bus.onRequest((payload, reply) => {
      if (
        payload && typeof payload === 'object' && 'kind' in payload && payload.kind === 'reminder' &&
        'agent' in payload && typeof payload.agent === 'string' &&
        'prompt' in payload && typeof payload.prompt === 'string' &&
        'at' in payload && typeof payload.at === 'number' &&
        'room' in payload && typeof payload.room === 'string'
      ) {
        if (!config.createReminder) {
          reply({ ok: false, error: 'reminders not enabled' });
          return;
        }
        try {
          const created = config.createReminder(payload.room, payload.agent, payload.prompt, payload.at);
          reply({ ok: true, reminder: created });
        } catch (err) {
          reply({ ok: false, error: String(err instanceof Error ? err.message : err) });
        }
        return;
      }
      // Unknown kinds: no reply (preserves pre-reminder behavior for stray requests).
    });
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

  /**
   * future-you 投递（cumora §9.2.1）：到点提醒直连唤醒 assignee，
   * 回复回落房间（与 @mention 同路径）。失败抛出由调用方决定文案。
   */
  async remindAgent(room: string, agentId: string, prompt: string): Promise<void> {
    const res = await this.bus.request(
      agentId,
      { kind: 'chat', room, from: 'reminder', human: true, text: `【定时提醒】${prompt}`, context: this.buildContext(room) },
      this.requestTimeoutMs,
    );
    this.emit({ room, from: agentId, kind: 'agent', text: this.extractReplyText(res), ts: Date.now() });
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
    if (!buf) {
      buf = [];
      this.history.set(room, buf);
    }
    // Lazy-load persisted history exactly once per room, even when the first
    // access is emit() (a send before any history view) — otherwise the
    // in-memory buf shadowed the store for the whole session.
    if (!this.loadedRooms.has(room)) {
      this.loadedRooms.add(room);
      if (this.store) buf.push(...this.store.load(room, this.historySize));
    }
    return buf;
  }

  /**
   * Assemble room context under a token budget (chars/2, CJK-biased).
   * Walks history newest-first; messages that don't fit are reported as an
   * explicit omission count so agents know the record is incomplete.
   * Over-long single messages are cut with a visible marker.
   */
  private buildContext(room: string): string[] {
    const history = this.getHistory(room);
    const budgetChars = this.contextTokens * 2;
    const lines: string[] = [];
    let used = 0;
    // Promoted principles first — high-value, small; counts against budget.
    const principles = this.loadPrinciples?.(room) ?? [];
    if (principles.length > 0) {
      const line = `【本房间已验证的原则，请遵守】${principles.join('；')}`;
      lines.push(line);
      used += line.length;
    }
    let omitted = 0;
    const tail: string[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      const text = m.text.length > 500 ? `${m.text.slice(0, 500)}…[截断]` : m.text;
      const line = `${m.from}: ${text}`;
      if (used + line.length > budgetChars) {
        omitted = i + 1;
        break;
      }
      tail.unshift(line);
      used += line.length;
    }
    if (omitted > 0) tail.unshift(`（上下文预算限制：省略了更早的 ${omitted} 条消息）`);
    lines.push(...tail);
    return lines;
  }

  /** Queue a message into an agent's focus-window digest. */
  private queueDigest(room: string, agentId: string, msg: RoomMessage): void {
    const key = `${room}:${agentId}`;
    let q = this.digests.get(key);
    if (!q) {
      q = [];
      this.digests.set(key, q);
    }
    q.push(msg);
    if (q.length > BusGateway.DIGEST_CAP) q.shift();
  }

  /**
   * cumora §6.6: flush digests whose focus window has ended (task closed,
   * lease recycled, or natural boundary). Delivered as one batched chat
   * event marked human so the agent evaluates missed requests.
   * Returns agentIds that were flushed.
   */
  async flushDigests(room?: string): Promise<string[]> {
    if (!this.isFocused) return [];
    const flushed: string[] = [];
    for (const [key, queue] of this.digests) {
      if (queue.length === 0) continue;
      const sep = key.indexOf(':');
      const r = key.slice(0, sep);
      const agentId = key.slice(sep + 1);
      if (room && r !== room) continue;
      if (this.isFocused(agentId, r)) continue;
      this.digests.delete(key);
      const body = queue
        .map((m) => `${m.from}: ${m.text.length > 200 ? `${m.text.slice(0, 200)}…` : m.text}`)
        .join('\n');
      await this.transport.send({
        id: `${this.agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        type: 'event',
        from: this.agentId,
        to: agentId,
        payload: {
          kind: 'chat',
          room: r,
          from: 'digest',
          human: true,
          text: `【专注窗口结束，补发期间 ${queue.length} 条房间消息】\n${body}`,
          context: this.buildContext(r),
        },
        channel: r,
        timestamp: Date.now(),
      });
      flushed.push(agentId);
    }
    return flushed;
  }

  /**
   * Send a chat message to a room.
   * - With @mentions: direct bus request to each mentioned agent (直聊, always
   *   delivered — focus window does not gate DMs).
   * - Without mentions: per-member fan-out; focused agents are skipped and the
   *   message lands in their digest instead (cumora §6.6).
   */
  async sendChat(room: string, text: string): Promise<{ delivered: string[] }> {
    const members = await this.listMembers(room);
    const mentions = [...text.matchAll(/@([\w-]+)/g)].map((m) => m[1]);
    const candidates = members.filter((m) => m !== this.agentId);

    this.emit({ room, from: this.userName, kind: 'user', text, ts: Date.now() });

    // Natural boundary: agents whose window ended since last message catch up first.
    await this.flushDigests(room);

    // Recent room context so agents see each other's messages (讨论的基础),
    // assembled under a token budget with explicit omission markers.
    const context = this.buildContext(room);

    if (mentions.length === 0) {
      // Per-member relay (not a channel broadcast) so focused agents can be
      // excluded selectively — a broadcast would reach them via /poll regardless.
      const delivered: string[] = [];
      for (const member of candidates) {
        const msg = {
          id: `${this.agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          type: 'event' as const,
          from: this.agentId,
          to: member,
          payload: { kind: 'chat', room, from: this.userName, human: true, text, context },
          channel: room,
          timestamp: Date.now(),
        };
        if (this.isFocused?.(member, room)) {
          this.queueDigest(room, member, { room, from: this.userName, kind: 'user', text, ts: msg.timestamp });
          continue;
        }
        await this.transport.send(msg);
        delivered.push(member);
      }
      return { delivered };
    }

    const targets = candidates.filter((m) => mentions.includes(m));
    for (const target of targets) {
      this.bus
        .request(target, { kind: 'chat', room, from: this.userName, human: true, text, context }, this.requestTimeoutMs)
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
    // Route through getHistory so the first-ever message also triggers the
    // one-time store load (keeps persisted history ahead of new messages).
    const buf = this.getHistory(msg.room);
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
    const res = await fetch(url, {
      headers: this.registryToken ? { 'x-bus-token': this.registryToken } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
