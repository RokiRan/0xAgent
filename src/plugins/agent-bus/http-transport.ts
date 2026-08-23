// ============================================================
// Plugin: HTTP Transport for Agent Bus (Geo-Distributed)
// Supports both P2P (same network) and Registry relay (cross-network).
// No external dependencies. Pure Node.js http module.
// ============================================================

import { Transport, BusMessage } from './bus.js';
import { createServer, request as httpRequest, IncomingMessage, ServerResponse, Server } from 'http';

export interface HttpTransportConfig {
  agentId: string;
  port?: number;
  host?: string;
  registryUrl?: string; // Required for cross-network. e.g. 'http://registry.example.com:9876'
  /** Home channel for outgoing messages. Default 'default'. */
  channel?: string;
  /** Extra channels to join on connect. */
  channels?: string[];
}

interface PeerInfo {
  agentId: string;
  url: string;
  lastSeen: number;
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
  private channel: string;
  private extraChannels: string[];
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private pollInterval?: ReturnType<typeof setInterval>;
  private useRegistryRelay: boolean;

  constructor(config: HttpTransportConfig) {
    this.agentId = config.agentId;
    this.port = config.port ?? 0;
    this.host = config.host ?? '127.0.0.1';
    this.registryUrl = config.registryUrl;
    this.channel = config.channel ?? 'default';
    this.extraChannels = config.channels ?? [];
    // If registryUrl is set, we use registry relay for cross-network scenarios
    this.useRegistryRelay = !!config.registryUrl;
  }

  async connect(_agentId?: string): Promise<void> {
    // Start local HTTP server (for P2P + receiving direct messages)
    await this.startServer();

    // Register with registry if configured
    if (this.registryUrl) {
      await this.registerWithRegistry();
      // Ensure home channel exists and join it, plus any extra channels
      await this.createChannel(this.channel);
      for (const ch of this.extraChannels) {
        await this.joinChannel(ch).catch(() => {});
      }
      this.heartbeatInterval = setInterval(() => this.registerWithRegistry(), 30000);
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
      this.server?.close(() => resolve());
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
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
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

  private async registerWithRegistry(): Promise<void> {
    if (!this.registryUrl) return;
    await this.postJson(`${this.registryUrl}/register`, {
      agentId: this.agentId,
      url: `http://${this.host}:${this.port}`,
    }).catch(() => {});
    // Self-heal: re-ensure home + extra channels on every heartbeat.
    // Registry is in-memory; if it restarted, channels vanish and this rebuilds them.
    await this.postJson(`${this.registryUrl}/channels/create`, {
      channel: this.channel,
      agentId: this.agentId,
    }).catch(() => {});
    for (const ch of this.extraChannels) {
      await this.postJson(`${this.registryUrl}/channels/join`, { channel: ch, agentId: this.agentId }).catch(() => {});
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
  /** Agent broadcast messages since last human attention (lapping counter). */
  agentMsgs: number;
  /** Distinct agent speakers since last human attention. */
  speakers: Set<string>;
  /** from → last broadcast payload, for verbatim-dup. */
  lastText: Map<string, string>;
  /** from → fixed 60s window counter (rate floor, agent traffic only). */
  rate: Map<string, { start: number; count: number }>;
}

function newChannelState(): ChannelState {
  return { members: new Set(), agentMsgs: 0, speakers: new Set(), lastText: new Map(), rate: new Map() };
}

/** Human chat broadcasts reset loop counters — humans are the resetter, never throttled. */
function isHumanChat(msg: BusMessage): boolean {
  const p = msg.payload;
  return !!(p && typeof p === 'object' && 'human' in p && p.human === true);
}

const AGENT_BCAST_RATE_PER_MINUTE = 30;

export function createRegistryServer(port = 9876): Server {
  const agents = new Map<string, PeerInfo>();
  const queues = new Map<string, QueuedMessage[]>();
  // channel name -> state. 'default' always exists; /register auto-joins it.
  const channels = new Map<string, ChannelState>([['default', newChannelState()]]);
  const MAX_QUEUE_SIZE = 1000;
  const MSG_TTL_MS = 5 * 60 * 1000; // 5 minutes

  const server = createServer((req, res) => {    res.setHeader('Content-Type', 'application/json');

    const sendJson = (status: number, data: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(data));
    };

    // POST /register — Agent heartbeat + registration
    if (req.method === 'POST' && req.url === '/register') {
      collectBody(req, (body) => {
        try {
          const data = JSON.parse(body) as { agentId: string; url: string };
          agents.set(data.agentId, { agentId: data.agentId, url: data.url, lastSeen: Date.now() });
          channels.get('default')!.members.add(data.agentId);
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
          if (isHumanChat(msg)) { st.agentMsgs = 0; st.speakers.clear(); }

          let queue = queues.get(targetId);
          if (!queue) {
            queue = [];
            queues.set(targetId, queue);
          }
          queue.push({ msg, enqueuedAt: Date.now() });
          if (queue.length > MAX_QUEUE_SIZE) {
            queue.shift(); // Drop oldest
          }
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
            st.agentMsgs = 0;
            st.speakers.clear();
          } else {
            const now = Date.now();
            const win = st.rate.get(msg.from);
            if (!win || now - win.start >= 60000) {
              st.rate.set(msg.from, { start: now, count: 1 });
            } else if (++win.count > AGENT_BCAST_RATE_PER_MINUTE) {
              sendJson(429, { held: true, reason: 'rate' });
              return;
            }
            const text = JSON.stringify(msg.payload);
            if (st.lastText.get(msg.from) === text) {
              sendJson(409, { held: true, reason: 'verbatim' });
              return;
            }
            const speakers = new Set(st.speakers).add(msg.from);
            if (st.agentMsgs + 1 > speakers.size) {
              sendJson(429, { held: true, reason: 'lapping' });
              return;
            }
            st.agentMsgs++;
            st.speakers.add(msg.from);
            st.lastText.set(msg.from, text);
          }

          let count = 0;
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
          sendJson(200, { queued: count });
        } catch {
          sendJson(400, { error: 'Invalid JSON' });
        }
      });
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
