// ============================================================
// Plugin: HTTP Transport for Agent Bus (Geo-Distributed)
// Supports both P2P (same network) and Registry relay (cross-network).
// No external dependencies. Pure Node.js http module.
// ============================================================

import { Transport, BusMessage } from './bus.js';
import { createServer, request as httpRequest, IncomingMessage, ServerResponse, Server } from 'http';
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'fs';

export interface HttpTransportConfig {
  agentId: string;
  port?: number;
  host?: string;
  registryUrl?: string; // Required for cross-network. e.g. 'http://registry.example.com:9876'
  /** Shared token sent as x-bus-token when the registry has its gate enabled. */
  registryToken?: string;
  /** Home channel for outgoing messages. Default 'default'. */
  channel?: string;
  /** Extra channels to join on connect. */
  channels?: string[];
  /**
   * 能力档案提供器（agent-card）：每次 /register 心跳随车携带，
   * registry 重启后卡片随心跳自愈（同渠道成员籍模式）。
   */
  card?: () => unknown;
}

interface PeerInfo {
  agentId: string;
  url: string;
  lastSeen: number;
  /** 能力档案（agent-card 自报，随 /register 心跳刷新与快照持久化）。 */
  card?: unknown;
}

/**
 * HttpTransport supports two modes:
 * 1. P2P mode: Agent listens on HTTP port, other agents POST directly.
 *    Works only when agents are in the same network (LAN, same machine, or both have public IPs).
 * 2. Registry relay mode: All messages go through a central Registry.
 *    Works across networks (agents behind NAT, different regions).
 *    Agents only need outbound access to the Registry.
 */
export class HttpTransport implements Transport {
  private agentId: string;
  private port: number;
  private host: string;
  private server?: Server;
  private handler?: (msg: BusMessage) => void;
  private peers = new Map<string, PeerInfo>();
  private registryUrl?: string;
  private registryToken?: string;
  private channel: string;
  private extraChannels: string[];
  private cardProvider?: () => unknown;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private pollInterval?: ReturnType<typeof setInterval>;
  private useRegistryRelay: boolean;

  constructor(config: HttpTransportConfig) {
    this.agentId = config.agentId;
    this.port = config.port ?? 0;
    this.host = config.host ?? '127.0.0.1';
    this.registryUrl = config.registryUrl;
    this.registryToken = config.registryToken;
    this.channel = config.channel ?? 'default';
    this.extraChannels = config.channels ?? [];
    this.cardProvider = config.card;
    // If registryUrl is set, we use registry relay for cross-network scenarios
    this.useRegistryRelay = !!config.registryUrl;
  }

  async connect(_agentId?: string): Promise<void> {
    // Start local HTTP server (for P2P + receiving direct messages)
    await this.startServer();

    // Register with registry if configured (also ensures home + extra channels, self-healing)
    if (this.registryUrl) {
      await this.registerWithRegistry(true); // 初次失败直接抛错，拒绝僵尸在线
      this.heartbeatInterval = setInterval(() => {
        this.registerWithRegistry().catch((err) =>
          console.error(`[AgentBus] heartbeat error: ${String(err).slice(0, 120)}`));
      }, 30000);
      // Start polling for relayed messages
      this.pollInterval = setInterval(() => this.pollMessages(), 2000);
    }
  }

  /** Create a channel on the registry (idempotent) and join it. */
  async createChannel(channel: string): Promise<void> {
    if (!this.registryUrl) throw new Error('No registry configured');
    await this.postJson(`${this.registryUrl}/channels/create`, { channel, agentId: this.agentId });
  }

  /** Join an existing channel. */
  async joinChannel(channel: string): Promise<void> {
    if (!this.registryUrl) throw new Error('No registry configured');
    await this.postJson(`${this.registryUrl}/channels/join`, { channel, agentId: this.agentId });
  }

  /** Leave a channel. */
  async leaveChannel(channel: string): Promise<void> {
    if (!this.registryUrl) throw new Error('No registry configured');
    await this.postJson(`${this.registryUrl}/channels/leave`, { channel, agentId: this.agentId });
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.pollInterval) clearInterval(this.pollInterval);

    if (this.registryUrl) {
      await this.postJson(`${this.registryUrl}/unregister`, { agentId: this.agentId }).catch(() => {});
    }

    return new Promise((resolve) => {
      // Never connected → no server; resolve instead of waiting on a
      // callback that would never fire (disconnect-before-connect hang).
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  async send(msg: BusMessage): Promise<void> {
    msg.channel ??= this.channel;
    if (msg.to === 'broadcast') {
      // Broadcast: try P2P to known peers + registry relay
      const promises: Promise<void>[] = [];
      for (const peer of this.peers.values()) {
        if (peer.agentId !== msg.from) {
          promises.push(this.tryDeliver(peer.url, msg));
        }
      }
      if (this.registryUrl) {
        promises.push(this.postJson(`${this.registryUrl}/broadcast`, msg));
      }
      await Promise.allSettled(promises);
    } else {
      // Direct send: try P2P first, fallback to registry relay
      const peer = this.peers.get(msg.to);
      if (peer) {
        try {
          await this.deliverToPeer(peer.url, msg);
          return;
        } catch {
          // P2P failed, fallback to registry
        }
      }

      if (this.registryUrl) {
        await this.postJson(`${this.registryUrl}/relay`, msg);
      } else {
        throw new Error(`Agent "${msg.to}" not found and no registry configured`);
      }
    }
  }

  onMessage(handler: (msg: BusMessage) => void): void {
    this.handler = handler;
  }

  registerPeer(agentId: string, url: string): void {
    this.peers.set(agentId, { agentId, url, lastSeen: Date.now() });
  }

  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  // ─── Private ───────────────────────────────────────────────

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      this.server.listen(this.port, this.host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        console.log(`[AgentBus] HTTP transport listening on http://${this.host}:${this.port}`);
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && req.url === '/bus') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const msg = JSON.parse(body) as BusMessage;
          res.writeHead(200);
          res.end(JSON.stringify({ received: true }));
          this.handler?.(msg);
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Bad request' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private async tryDeliver(url: string, msg: BusMessage): Promise<void> {
    try {
      await this.deliverToPeer(url, msg);
    } catch {
      // Ignore P2P failures
    }
  }

  private async deliverToPeer(url: string, msg: BusMessage): Promise<void> {
    await this.postJson(`${url}/bus`, msg);
  }

  private async postJson(url: string, data: unknown): Promise<void> {
    const body = JSON.stringify(data);
    const parsedUrl = new URL(url);

    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...(this.registryToken ? { 'x-bus-token': this.registryToken } : {}),
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            let errBody = '';
            res.on('data', (chunk) => { errBody += chunk; });
            res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 2000)}`)));
          }
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private async getJson(url: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const req = httpRequest(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers: this.registryToken ? { 'x-bus-token': this.registryToken } : {},
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(body);
            }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Initial register must fail loudly (bad token / unreachable registry =
   * agent zombie-onlined). Heartbeats stay fault-tolerant — one transient
   * failure shouldn't kill a healthy agent.
   */
  private async registerWithRegistry(initial = false): Promise<void> {
    if (!this.registryUrl) return;
    const attempt = async (path: string, body: unknown) => {
      try {
        await this.postJson(`${this.registryUrl}${path}`, body);
      } catch (err) {
        if (initial) throw new Error(`Registry ${path} failed: ${String(err)}`);
        console.error(`[AgentBus] heartbeat ${path} failed: ${String(err).slice(0, 120)}`);
      }
    };
    await attempt('/register', {
      agentId: this.agentId,
      url: `http://${this.host}:${this.port}`,
      card: this.cardProvider?.(),
    });
    // Self-heal: re-ensure home + extra channels on every heartbeat.
    // Registry is in-memory; if it restarted, channels vanish and this rebuilds them.
    await attempt('/channels/create', {
      channel: this.channel,
      agentId: this.agentId,
    });
    for (const ch of this.extraChannels) {
      await attempt('/channels/join', { channel: ch, agentId: this.agentId });
    }
  }

  private async pollMessages(): Promise<void> {
    if (!this.registryUrl) return;
    try {
      const data = await this.getJson(`${this.registryUrl}/poll?agentId=${this.agentId}`) as { messages: BusMessage[] };
      if (data.messages) {
        for (const msg of data.messages) {
          this.handler?.(msg);
        }
      }
    } catch {
      // Poll failed, retry next interval
    }
  }
}

// ─── Registry Server (runs on a machine with public IP) ─────

interface QueuedMessage {
  msg: BusMessage;
  enqueuedAt: number;
}

interface ChannelState {
  members: Set<string>;
  /** Monotonic broadcast sequence per channel. */
  seq: number;
  /** Recent broadcast log for HELD inline-unseen (bounded 50). */
  log: { seq: number; from: string; text: string }[];
  /** Agent broadcast messages since last human attention (lapping counter). */
  agentMsgs: number;
  /** Distinct agent speakers since last human attention. */
  speakers: Set<string>;
  /** Last human message timestamp — human presence relaxes the loop floor. */
  lastHumanAt: number;
  /** Completed-round message counts, for adaptive cap μ+2σ (bounded 100). */
  rounds: number[];
  /** from → last broadcast payload, for verbatim-dup. */
  lastText: Map<string, string>;
  /** from → fixed 60s window counter (rate floor, agent traffic only). */
  rate: Map<string, { start: number; count: number }>;
}

function newChannelState(): ChannelState {
  return { members: new Set(), seq: 0, log: [], agentMsgs: 0, speakers: new Set(), lastHumanAt: 0, rounds: [], lastText: new Map(), rate: new Map() };
}

/** Human chat broadcasts reset loop counters — humans are the resetter, never throttled. */
function isHumanChat(msg: BusMessage): boolean {
  const p = msg.payload;
  return !!(p && typeof p === 'object' && 'human' in p && p.human === true);
}

const AGENT_BCAST_RATE_PER_MINUTE = 30;

function payloadText(msg: BusMessage): string {
  const p = msg.payload;
  if (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string') return p.text.slice(0, 500);
  return JSON.stringify(p)?.slice(0, 500) ?? '';
}

export interface RegistryOptions {
  /** Snapshot file for agents/channels/queues; empty = memory-only. */
  stateFile?: string;
  /** Shared token required on every endpoint when set (empty = open). */
  token?: string;
  /**
   * Append-only JSONL file for POST /llm-calls (cumora §7.3 台账).
   * 系统记账走系统通道：agent 直接打到 registry，不经过对话通道，
   * 不计入 rounds、不被其他 agent 看到。Empty = endpoint disabled (405).
   */
  ledgerFile?: string;
}

interface PersistedState {
  agents: PeerInfo[];
  channels: { name: string; members: string[]; seq: number; log: { seq: number; from: string; text: string }[] }[];
  queues: { agentId: string; msgs: QueuedMessage[] }[];
}

export function createRegistryServer(port = 9876, options: RegistryOptions = {}): Server {
  const agents = new Map<string, PeerInfo>();
  const queues = new Map<string, QueuedMessage[]>();
  // channel name -> state. 'default' always exists; /register auto-joins it.
  const channels = new Map<string, ChannelState>([['default', newChannelState()]]);
  const MAX_QUEUE_SIZE = 1000;
  const MSG_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // ── Persistence (邮箱模型: 落盘是唯一事实源，重启不丢在途消息) ──
  const stateFile = options.stateFile ?? '';
  if (stateFile && existsSync(stateFile)) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as PersistedState;
      const now = Date.now();
      for (const a of saved.agents ?? []) agents.set(a.agentId, a);
      for (const c of saved.channels ?? []) {
        const st = newChannelState();
        st.members = new Set(c.members);
        st.seq = c.seq;
        st.log = c.log ?? [];
        channels.set(c.name, st);
      }
      for (const q of saved.queues ?? []) {
        // Drop messages past TTL — 过期的信不再投递
        queues.set(q.agentId, (q.msgs ?? []).filter((m) => now - m.enqueuedAt < MSG_TTL_MS));
      }
      console.log(`[AgentBus] Restored state: ${agents.size} agents, ${channels.size} channels`);
    } catch (err) {
      console.error('[AgentBus] State file unreadable, starting fresh:', err);
    }
  }
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleSave(): void {
    if (!stateFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      const snapshot: PersistedState = {
        agents: [...agents.values()],
        channels: [...channels.entries()].map(([name, st]) => ({
          name,
          members: [...st.members],
          seq: st.seq,
          log: st.log,
        })),
        queues: [...queues.entries()].map(([agentId, msgs]) => ({ agentId, msgs })),
      };
      const tmp = `${stateFile}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(snapshot));
        renameSync(tmp, stateFile); // atomic replace
      } catch (err) {
        console.error('[AgentBus] State save failed:', err);
      }
    }, 1000);
  }

  // Gate observability (cumora §7.3): what fires, how often
  const metrics = {
    broadcasts: 0,
    relays: 0,
    evicted: 0,
    llmCalls: 0,
    held: {} as Record<string, number>,
  };
  const countHeld = (reason: string) => {
    metrics.held[reason] = (metrics.held[reason] ?? 0) + 1;
  };

  // seen-cursor: highest channel seq DELIVERED to an agent via /poll (server-side fact).
  // Deliberately separate from any read/inbox cursor (cumora §2.2.1).
  const seen = new Map<string, number>(); // key: `${agentId}|${channel}`
  // hold-token: override = confirming already-shown state; single-use, 120s TTL.
  const holds = new Map<string, { token: string; seq: number; expires: number }>(); // key: `${agentId}|${channel}`

  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    const sendJson = (status: number, data: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(data));
    };

    // Token gate: when BUS_TOKEN is set, every endpoint requires it
    if (options.token && req.headers['x-bus-token'] !== options.token) {
      sendJson(401, { error: 'Unauthorized' });
      return;
    }

    // POST /register — Agent heartbeat + registration
    if (req.method === 'POST' && req.url === '/register') {
      collectBody(req, (body) => {
        try {
          const data = JSON.parse(body) as { agentId: string; url: string; card?: unknown };
          agents.set(data.agentId, { agentId: data.agentId, url: data.url, lastSeen: Date.now(), card: data.card });
          channels.get('default')!.members.add(data.agentId);
          scheduleSave();
          sendJson(200, { ok: true });
        } catch {
          sendJson(400, { error: 'Invalid JSON' });
        }
      });
      return;
    }

    // POST /unregister
    if (req.method === 'POST' && req.url === '/unregister') {
      collectBody(req, (body) => {
        try {
          const data = JSON.parse(body) as { agentId: string };
          agents.delete(data.agentId);
          queues.delete(data.agentId);
          for (const st of channels.values()) st.members.delete(data.agentId);
          scheduleSave();
          sendJson(200, { ok: true });
        } catch {
          sendJson(400, { error: 'Invalid JSON' });
        }
      });
      return;
    }

    // POST /channels/create — Create a channel (idempotent); creator joins
    if (req.method === 'POST' && req.url === '/channels/create') {
      collectBody(req, (body) => {
        try {
          const data = JSON.parse(body) as { channel: string; agentId: string };
          if (!data.channel) { sendJson(400, { error: 'Missing channel' }); return; }
          const existed = channels.has(data.channel);
          if (!existed) channels.set(data.channel, newChannelState());
          if (data.agentId) channels.get(data.channel)!.members.add(data.agentId);
          scheduleSave();
          sendJson(200, { ok: true, created: !existed });
        } catch {
          sendJson(400, { error: 'Invalid JSON' });
        }
      });
      return;
    }

    // POST /channels/join — Join an existing channel
    if (req.method === 'POST' && req.url === '/channels/join') {
      collectBody(req, (body) => {
        try {
          const data = JSON.parse(body) as { channel: string; agentId: string };
          const st = channels.get(data.channel);
          if (!st) { sendJson(404, { error: 'Channel not found' }); return; }
          st.members.add(data.agentId);
          scheduleSave();
          sendJson(200, { ok: true });
        } catch {
          sendJson(400, { error: 'Invalid JSON' });
        }
      });
      return;
    }

    // POST /channels/leave
    if (req.method === 'POST' && req.url === '/channels/leave') {
      collectBody(req, (body) => {
        try {
          const data = JSON.parse(body) as { channel: string; agentId: string };
          channels.get(data.channel)?.members.delete(data.agentId);
          scheduleSave();
          sendJson(200, { ok: true });
        } catch {
          sendJson(400, { error: 'Invalid JSON' });
        }
      });
      return;
    }

    // POST /channels/delete — Remove a channel entirely (default is protected)
    if (req.method === 'POST' && req.url === '/channels/delete') {
      collectBody(req, (body) => {
        try {
          const data = JSON.parse(body) as { channel: string };
          if (!data.channel || data.channel === 'default') {
            sendJson(400, { error: 'Cannot delete default channel' });
            return;
          }
          const existed = channels.delete(data.channel);
          scheduleSave();
          sendJson(200, { ok: true, deleted: existed });
        } catch {
          sendJson(400, { error: 'Invalid JSON' });
        }
      });
      return;
    }

    // GET /channels — List channels with member counts
    if (req.method === 'GET' && req.url === '/channels') {
      sendJson(200, {
        channels: Array.from(channels.entries()).map(([name, st]) => ({
          name,
          members: st.members.size,
        })),
      });
      return;
    }

    // GET /channels/members?channel=X — List channel members
    if (req.method === 'GET' && req.url?.startsWith('/channels/members')) {
      const url = new URL(req.url!, `http://localhost`);
      const name = url.searchParams.get('channel') ?? 'default';
      const st = channels.get(name);
      if (!st) { sendJson(404, { error: 'Channel not found' }); return; }
      sendJson(200, { channel: name, members: Array.from(st.members) });
      return;
    }

    // POST /relay — Store message for target agent
    if (req.method === 'POST' && req.url === '/relay') {
      collectBody(req, (body) => {
        try {
          const msg = JSON.parse(body) as BusMessage;
          const targetId = msg.to;
          if (!targetId || targetId === 'broadcast') {
            sendJson(400, { error: 'Invalid target' });
            return;
          }
          const channel = msg.channel ?? 'default';
          const st = channels.get(channel);
          if (!st) { sendJson(404, { error: 'Channel not found' }); return; }
          if (!st.members.has(msg.from)) { sendJson(403, { error: 'Sender not in channel' }); return; }
          if (!st.members.has(targetId)) { sendJson(403, { error: 'Target not in channel' }); return; }
          // Human-directed traffic resets loop counters (humans are the resetter)
          if (isHumanChat(msg)) { st.agentMsgs = 0; st.speakers.clear(); st.lastHumanAt = Date.now(); }

          let queue = queues.get(targetId);
          if (!queue) {
            queue = [];
            queues.set(targetId, queue);
          }
          queue.push({ msg, enqueuedAt: Date.now() });
          if (queue.length > MAX_QUEUE_SIZE) {
            queue.shift(); // Drop oldest
          }
          metrics.relays++;
          scheduleSave();
          sendJson(200, { queued: true });
        } catch {
          sendJson(400, { error: 'Invalid JSON' });
        }
      });
      return;
    }

    // GET /poll — Agent pulls its messages
    if (req.method === 'GET' && req.url?.startsWith('/poll')) {
      const url = new URL(req.url!, `http://localhost`);
      const agentId = url.searchParams.get('agentId');
      if (!agentId) {
        sendJson(400, { error: 'Missing agentId' });
        return;
      }

      const queue = queues.get(agentId) ?? [];
      const now = Date.now();
      // Filter expired messages, return valid ones, clear queue
      const valid = queue.filter(q => now - q.enqueuedAt < MSG_TTL_MS).map(q => q.msg);
      queues.set(agentId, []); // Clear after poll
      scheduleSave();

      // Advance seen cursors to the max delivered seq per channel
      for (const m of valid) {
        if (m.channel && typeof m.seq === 'number') {
          const key = `${agentId}|${m.channel}`;
          if ((seen.get(key) ?? 0) < m.seq) seen.set(key, m.seq);
        }
      }

      // Update lastSeen
      const agent = agents.get(agentId);
      if (agent) agent.lastSeen = now;

      sendJson(200, { messages: valid });
      return;
    }

    // POST /broadcast — Relay to all members of the message's channel
    // Gates (agent traffic only; humans reset and are never throttled):
    //   rate floor 30/min, verbatim-dup, lapping (agentMsgs > distinct speakers → HELD)
    if (req.method === 'POST' && req.url === '/broadcast') {
      collectBody(req, (body) => {
        try {
          const msg = JSON.parse(body) as BusMessage;
          const channel = msg.channel ?? 'default';
          const st = channels.get(channel);
          if (!st) { sendJson(404, { error: 'Channel not found' }); return; }
          if (!st.members.has(msg.from)) { sendJson(403, { error: 'Sender not in channel' }); return; }

          if (isHumanChat(msg)) {
            // Record the completed round for the adaptive cap, then reset
            if (st.agentMsgs > 0) {
              st.rounds.push(st.agentMsgs);
              if (st.rounds.length > 100) st.rounds.shift();
            }
            st.agentMsgs = 0;
            st.speakers.clear();
            st.lastHumanAt = Date.now();
          } else {
            const now = Date.now();
            const win = st.rate.get(msg.from);
            if (!win || now - win.start >= 60000) {
              st.rate.set(msg.from, { start: now, count: 1 });
            } else if (++win.count > AGENT_BCAST_RATE_PER_MINUTE) {
              countHeld('rate');
              sendJson(429, { held: true, reason: 'rate' });
              return;
            }
            const text = JSON.stringify(msg.payload);
            if (st.lastText.get(msg.from) === text) {
              countHeld('verbatim');
              sendJson(409, { held: true, reason: 'verbatim' });
              return;
            }
            // Freshness precheck: unseen channel messages → HELD with inline unseen + hold-token.
            // Override (holdToken) is single-use and only valid while the shown seq is still latest.
            const key = `${msg.from}|${channel}`;
            const held0 = msg.holdToken ? holds.get(key) : undefined;
            const overrideOk =
              !!held0 && held0.token === msg.holdToken && held0.expires > Date.now() && held0.seq === st.seq;
            if (msg.holdToken) holds.delete(key); // consume on any presentation
            if (!overrideOk && (seen.get(key) ?? 0) < st.seq) {
              countHeld('freshness');
              const cursor = seen.get(key) ?? 0;
              const unseen = st.log.filter((e) => e.seq > cursor && e.from !== msg.from);
              seen.set(key, st.seq); // HELD advances baseline — no HELD self-loop
              const newToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
              holds.set(key, { token: newToken, seq: st.seq, expires: Date.now() + 120000 });
              sendJson(409, { held: true, reason: 'freshness', unseen, token: newToken });
              return;
            }
            // Two-tier loop floor (cumora §6.7, tuned): human present → bounded
            // discussion cap (6/round; a discussion round ≈ 2-3 agents × 2 exchanges);
            // human absent → strict lapping.
            //
            // REGRESSION GUARD (docs/COORDINATION.md#1): cap 曾取 20，三 agent
            // 在纯技术话题上 judge 恒 YES 互评无限续，1 小时 34 条广播 0 次拦截，
            // 账单空烧。floor=6 是事故校准值，不是拍脑袋——调大前先读事故记录。
            const speakers = new Set(st.speakers).add(msg.from);
            const humanPresent = now - st.lastHumanAt < 10 * 60 * 1000;
            let cap = speakers.size;
            if (humanPresent) {
              if (st.rounds.length >= 3) {
                const mean = st.rounds.reduce((a, b) => a + b, 0) / st.rounds.length;
                const variance = st.rounds.reduce((a, b) => a + (b - mean) ** 2, 0) / st.rounds.length;
                cap = Math.max(6, Math.ceil(mean + 2 * Math.sqrt(variance)));
              } else {
                cap = 6;
              }
            }
            if (st.agentMsgs + 1 > cap) {
              countHeld(humanPresent ? 'hard_cap' : 'lapping');
              sendJson(429, { held: true, reason: humanPresent ? 'hard_cap' : 'lapping' });
              return;
            }
            st.agentMsgs++;
            st.speakers.add(msg.from);
            st.lastText.set(msg.from, text);
          }

          let count = 0;
          st.seq++;
          msg.seq = st.seq;
          st.log.push({ seq: st.seq, from: msg.from, text: payloadText(msg) });
          if (st.log.length > 50) st.log.shift();
          for (const id of st.members) {
            if (id !== msg.from) {
              let queue = queues.get(id);
              if (!queue) {
                queue = [];
                queues.set(id, queue);
              }
              queue.push({ msg, enqueuedAt: Date.now() });
              count++;
            }
          }
          metrics.broadcasts++;
          scheduleSave();
          sendJson(200, { queued: count });
        } catch {
          sendJson(400, { error: 'Invalid JSON' });
        }
      });
      return;
    }

    // GET /metrics — gate counters (no message content, counts only)
    if (req.method === 'GET' && req.url === '/metrics') {
      sendJson(200, metrics);
      return;
    }

    // POST /llm-calls — agent-side LLM 台账上报（append-only JSONL，fire-and-forget）
    if (req.method === 'POST' && req.url === '/llm-calls') {
      if (!options.ledgerFile) { sendJson(405, { error: 'Ledger not enabled' }); return; }
      collectBody(req, (body) => {
        try {
          const rec = JSON.parse(body) as { agentId?: string; purpose?: string; ts?: number };
          if (!rec.agentId || !rec.purpose) { sendJson(400, { error: 'Missing agentId or purpose' }); return; }
          appendFileSync(options.ledgerFile!, `${JSON.stringify(rec)}\n`);
          metrics.llmCalls++;
          sendJson(200, { ok: true });
        } catch {
          sendJson(400, { error: 'Invalid JSON' });
        }
      });
      return;
    }

    // GET /llm-calls/stats?hours=24 — aggregate per (purpose, agentId)
    if (req.method === 'GET' && req.url?.startsWith('/llm-calls/stats')) {
      if (!options.ledgerFile) { sendJson(405, { error: 'Ledger not enabled' }); return; }
      const url = new URL(req.url, 'http://localhost');
      const hours = Number(url.searchParams.get('hours')) || 24;
      const since = Date.now() - hours * 3600_000;
      const agg = new Map<string, { purpose: string; agentId: string; calls: number; errors: number; inputTokens: number; outputTokens: number }>();
      try {
        if (existsSync(options.ledgerFile)) {
          for (const line of readFileSync(options.ledgerFile, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let rec: { ts?: number; agentId?: string; purpose?: string; status?: string; inputTokens?: number; outputTokens?: number; measured?: boolean };
            try { rec = JSON.parse(line); } catch { continue; }
            if (!rec.ts || rec.ts < since || !rec.agentId || !rec.purpose) continue;
            const key = `${rec.purpose}|${rec.agentId}`;
            let row = agg.get(key);
            if (!row) {
              row = { purpose: rec.purpose, agentId: rec.agentId, calls: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
              agg.set(key, row);
            }
            row.calls++;
            if (rec.status && rec.status !== 'ok') row.errors++;
            if (rec.measured) {
              row.inputTokens += rec.inputTokens ?? 0;
              row.outputTokens += rec.outputTokens ?? 0;
            }
          }
        }
      } catch (err) {
        sendJson(500, { error: `Ledger read failed: ${String(err)}` });
        return;
      }
      sendJson(200, { hours, rows: [...agg.values()].sort((a, b) => b.calls - a.calls) });
      return;
    }

    // GET /resolve — Lookup agent URL (for P2P optimization)
    if (req.method === 'GET' && req.url?.startsWith('/resolve')) {
      const url = new URL(req.url!, `http://localhost`);
      const agentId = url.searchParams.get('agentId');
      const peer = agentId ? agents.get(agentId) : undefined;
      if (peer) {
        sendJson(200, { url: peer.url });
      } else {
        sendJson(404, { error: 'Agent not found' });
      }
      return;
    }

    // GET /agents — List all registered agents
    if (req.method === 'GET' && req.url === '/agents') {
      sendJson(200, { agents: Array.from(agents.values()) });
      return;
    }

    sendJson(404, { error: 'Not found' });
  });

  // Evict agents that stopped heartbeating (registry has no disconnect guarantee)
  const STALE_MS = 3 * 60 * 1000;
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, peer] of agents) {
      if (now - peer.lastSeen > STALE_MS) {
        agents.delete(id);
        queues.delete(id);
        for (const st of channels.values()) st.members.delete(id);
        metrics.evicted++;
        scheduleSave();
      }
    }
  }, 60000);
  sweeper.unref();

  server.listen(port, () => {
    console.log(`[AgentBus] Registry server listening on port ${port}`);
  });

  return server;
}

function collectBody(req: IncomingMessage, callback: (body: string) => void): void {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => callback(body));
}
