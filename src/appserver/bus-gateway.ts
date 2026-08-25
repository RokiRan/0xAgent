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

export interface RoomPresence {
  room: string;
  members: string[];
  online: string[];
}

/** Single agent's config reply (matches bus-agent kind:'config' get). */
export interface AgentConfigReply {
  kind: 'config';
  agent: string;
  host: string;
  persona: string;
  model: string;
  modelSmall: string;
  channel: string;
}

/** Per-agent fanout result for `getAgentConfigs`. One row per member, errors stay local. */
export interface AgentConfigEntry {
  agentId: string;
  online: boolean;
  config: AgentConfigReply | null;
  error: string | null;
}

/** Settings UI patch — only persona/modelSmall are hot-editable per contract §2. */
export interface AgentConfigPatch {
  persona?: string;
  modelSmall?: string;
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
  /**
   * 团队成员能力速览（agent-card）：返回每个 agent 的一行摘要，
   * 注入房间上下文头部——主脑派活时"看得见"队友的 OS/引擎/特殊能力。
   * 60s 缓存刷新；未配置 = 不注入。
   */
  loadAgentCards?: () => Promise<string[]>;
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
  private loadAgentCards?: () => Promise<string[]>;
  private rosterLines: string[] = [];
  private rosterTimer?: ReturnType<typeof setInterval>;
  /** Focus-window digests: `${room}:${agentId}` → held messages (cap 50, oldest dropped). */
  private digests = new Map<string, RoomMessage[]>();
  private static readonly DIGEST_CAP = 50;
  /** 存储降级：连续 3 次写失败 → degraded（聊天 fail-open，标记可观测）。 */
  private storeFailures = 0;
  private degraded = false;
  private history = new Map<string, RoomMessage[]>();
  private loadedRooms = new Set<string>();
  private listeners = new Set<(msg: RoomMessage) => void>();

  /** Last-seen threshold for "online": agents seen within this window are live. */
  private static readonly ONLINE_WINDOW_MS = 60_000;

  /** Presence subscriptions — fired on the polling loop when an agent's online status flips. */
  private presenceListeners = new Set<(msg: RoomPresence) => void>();

  /** Cached `members → online` snapshot per channel, used to detect flips. */
  private presenceState = new Map<string, RoomPresence>();


  /** Polling handle for the presence sweep. */
  private presenceTimer?: ReturnType<typeof setInterval>;

  /** Channels the presence loop is observing (defaults to config.channels). */
  private presenceChannels: string[];

  /** Most-recent lastSeen values from the registry, keyed by agentId. */
  private agentsLastSeen = new Map<string, number>();
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
    this.loadAgentCards = config.loadAgentCards;
    // Presence loop defaults to whatever the gateway is joined to; callers can
    // override via startPresence({ channels }).
    this.presenceChannels = [...(config.channels ?? [])];
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
    if (this.loadAgentCards) {
      const refresh = async () => {
        try {
          this.rosterLines = await this.loadAgentCards!();
        } catch { /* 保留旧快照——registry 抖动不清空团队视图 */ }
      };
      await refresh();
      this.rosterTimer = setInterval(refresh, 60_000);
      this.rosterTimer.unref();
    }
  }

  async disconnect(): Promise<void> {
    clearInterval(this.rosterTimer);
    clearInterval(this.presenceTimer);
    this.presenceTimer = undefined;
    this.presenceState.clear();
    await this.bus.disconnect();
  }

  onRoomMessage(listener: (msg: RoomMessage) => void): void {
    this.listeners.add(listener);
  }

  onPresence(listener: (msg: RoomPresence) => void): void {
    this.presenceListeners.add(listener);
  }

  /** 当前房间在线状态快照（无 listener 时也可单点调用，给 UI 即时取一次）。 */
  async getPresence(room: string): Promise<RoomPresence> {
    const [members, agents] = await Promise.all([
      this.listMembers(room),
      this.fetchAgents(),
    ]);
    const online = computeOnline(members, agents, BusGateway.ONLINE_WINDOW_MS);
    return { room, members, online };
  }

  /**
   * Start the presence sweep. Polls `{registryUrl}/agents` every `intervalMs`,
   * recomputes (members, online) per channel, and emits a flip to listeners
   * only when the pair changes (idempotent ticks are silent).
   * Defensive: pre-connect calls are queued — first tick fires after connect.
   */
  startPresence(options: { intervalMs?: number; channels?: string[] } = {}): void {
    if (options.channels) this.presenceChannels = [...options.channels];
    const intervalMs = options.intervalMs ?? 15_000;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = setInterval(() => {
      this.presenceTick().catch((err) => {
        console.error('[bus-gateway] presence tick failed:', err);
      });
    }, intervalMs);
    this.presenceTimer.unref();
    // Warm the cache eagerly so listeners see the first snapshot at t≈0
    // (avoids the "all offline until first tick" UX gap).
    void this.presenceTick().catch(() => { /* logged above */ });
  }

  /** Last seen timestamp (ms) for an agent from the most recent presence sweep, or null. */
  getAgentLastSeen(agentId: string): number | null {
    return this.agentsLastSeen.get(agentId) ?? null;
  }

  /** Force one presence sweep (used by tests / on-demand refresh). */
  async presenceTick(): Promise<void> {
    let agents: AgentDescriptor[];
    try {
      agents = await this.fetchAgents();
    } catch {
      // Registry blip → keep last known snapshot, don't clear (UX: all-greyout
      // is worse than a stale-but-recent presence signal).
      return;
    }
    this.agentsLastSeen.clear();
    for (const a of agents) this.agentsLastSeen.set(a.agentId, a.lastSeen);
    for (const room of this.presenceChannels) {
      let members: string[];
      try {
        members = await this.listMembers(room);
      } catch {
        continue;
      }
      const online = computeOnline(members, agents, BusGateway.ONLINE_WINDOW_MS);
      const prev = this.presenceState.get(room);
      const next: RoomPresence = { room, members, online };
      if (prev && presenceEqual(prev, next)) continue; // idempotent — no UI churn
      this.presenceState.set(room, next);
      for (const l of this.presenceListeners) l(next);
    }
  }

  /** GET /agents — typed view of the registry roster. */
  private async fetchAgents(): Promise<AgentDescriptor[]> {
    const data = (await this.getJson(`${this.registryUrl}/agents`)) as { agents?: AgentDescriptor[] };
    return data.agents ?? [];
  }

  /** Direct bus request to an agent (used by TaskBoard for assign/rework). */
  async requestAgent(target: string, payload: unknown, timeoutMs = 90000): Promise<unknown> {
    return this.bus.request(target, payload, timeoutMs);
  }

  /**
   * Fan out `kind:'config' action:'get'` to every room member in parallel
   * (10s timeout per agent). Serial fanout made the settings page wait
   * N×10s when several members were offline — parallel caps total at ~10s.
   * One member failing does NOT poison the rest — the row carries
   * `error` so the UI can still show other agents. Online status uses the
   * cached lastSeen (PresenceAgent's same 60s window); null = unknown → offline.
   * Self is excluded — gateway holds no config itself.
   */
  async getAgentConfigs(room: string): Promise<AgentConfigEntry[]> {
    const members = await this.listMembers(room);
    const targets = members.filter((m) => m !== this.agentId);
    return Promise.all(targets.map(async (agentId): Promise<AgentConfigEntry> => {
      const lastSeen = this.getAgentLastSeen(agentId);
      const online = lastSeen !== null && Date.now() - lastSeen < BusGateway.ONLINE_WINDOW_MS;
      let config: AgentConfigReply | null = null;
      let error: string | null = null;
      try {
        const reply = (await this.bus.request(agentId, { kind: 'config', action: 'get' }, 10_000)) as unknown;
        config = parseConfigReply(reply);
      } catch (err) {
        error = String(err instanceof Error ? err.message : err);
      }
      return { agentId, online, config, error };
    }));
  }

  /**
   * Send a config patch to a single agent (contract §2 set). Returns the
   * parsed reply or throws on transport-level failure. Caller surfaces the
   * agent's own `{ok:false, error}` via the returned `ok` flag.
   */
  async setAgentConfig(target: string, patch: AgentConfigPatch): Promise<{ ok: boolean; agent?: string; error?: string }> {
    const reply = (await this.bus.request(target, { kind: 'config', action: 'set', patch }, 10_000)) as unknown;
    return parseSetReply(reply);
  }

  /** Settings UI — gateway own userName (display name) and context token budget. */
  getGatewayConfig(): { userName: string; contextTokens: number } {
    return { userName: this.userName, contextTokens: this.contextTokens };
  }

  /**
   * Hot-update gateway config. Empty patch = no-op. Only known fields apply
   * (unknown keys ignored). contextTokens is clamped to [500, 20000] — values
   * outside that range silently fall back to the closest bound to keep the
   * context builder from looping on a degenerate budget.
   */
  applyGatewayConfig(patch: { userName?: unknown; contextTokens?: unknown }): void {
    if (typeof patch.userName === 'string' && patch.userName.length > 0 && patch.userName.length <= 64) {
      this.userName = patch.userName;
    }
    if (typeof patch.contextTokens === 'number' && Number.isFinite(patch.contextTokens)) {
      this.contextTokens = Math.min(20_000, Math.max(500, Math.round(patch.contextTokens)));
    }
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
    // 团队能力速览：主脑派活的事实源（agent-card，60s 快照）
    if (this.rosterLines.length > 0) {
      const line = `【团队成员能力】${this.rosterLines.join('；')}`;
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

/** Registry `/agents` row, narrowed to the fields presence cares about. */
export interface AgentDescriptor {
  agentId: string;
  url: string;
  lastSeen: number;
  card?: unknown;
}

/** Online = members ∩ {agents with lastSeen within the window}. Stable order. */
function computeOnline(members: string[], agents: AgentDescriptor[], windowMs: number): string[] {
  const cutoff = Date.now() - windowMs;
  const live = new Set<string>();
  for (const a of agents) if (a.lastSeen >= cutoff) live.add(a.agentId);
  return members.filter((m) => live.has(m));
}

/** Presence idempotency: skip emitting when members + online are both unchanged. */
function presenceEqual(a: RoomPresence, b: RoomPresence): boolean {
  if (a.room !== b.room) return false;
  if (a.members.length !== b.members.length || b.members.length !== a.members.length) return false;
  if (a.online.length !== b.online.length) return false;
  return a.members.every((m, i) => m === b.members[i]) && a.online.every((m, i) => m === b.online[i]);
}

/**
 * Narrow a raw bus reply to the contract §2 config-get shape. Returns null on
 * any mismatch — the agent either returned the wrong payload, or its version
 * is older than the contract. Caller decides whether null counts as error.
 */
function parseConfigReply(reply: unknown): AgentConfigReply | null {
  if (!reply || typeof reply !== 'object') return null;
  const r = reply as Record<string, unknown>;
  if (r.kind !== 'config') return null;
  if (typeof r.agent !== 'string') return null;
  if (typeof r.host !== 'string') return null;
  if (typeof r.persona !== 'string') return null;
  if (typeof r.model !== 'string') return null;
  if (typeof r.modelSmall !== 'string') return null;
  if (typeof r.channel !== 'string') return null;
  return {
    kind: 'config',
    agent: r.agent,
    host: r.host,
    persona: r.persona,
    model: r.model,
    modelSmall: r.modelSmall,
    channel: r.channel,
  };
}

/** Narrow a bus reply to the contract §2 config-set shape. Throws via `error` field for soft-fail. */
function parseSetReply(reply: unknown): { ok: boolean; agent?: string; error?: string } {
  if (!reply || typeof reply !== 'object') return { ok: false, error: 'invalid reply' };
  const r = reply as Record<string, unknown>;
  if (r.kind !== 'config') return { ok: false, error: 'invalid reply' };
  if (r.ok === true) {
    return { ok: true, agent: typeof r.agent === 'string' ? r.agent : undefined };
  }
  return { ok: false, error: typeof r.error === 'string' ? r.error : 'unknown error' };
}
