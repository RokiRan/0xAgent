#!/usr/bin/env node
// ============================================================
// Server entry: Web UI + WebSocket transport only (no REPL).
// Usage:
//   AGENT_MODEL_PROVIDER=minimax MINIMAX_API_KEY=sk-... npm run server
//   OPENAI_API_KEY=sk-... npm run server
// ============================================================

import { HarnessV2, HarnessV2Config } from './harness-v2.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { BusGateway, RoomMessage } from './appserver/bus-gateway.js';
import { TaskBoard, RoomTask } from './appserver/task-board.js';
import { DecisionBoard } from './appserver/decision-board.js';
import { startRetention } from './appserver/retention.js';
import { LlmLedger } from './appserver/llm-ledger.js';
import { ReminderBoard } from './appserver/reminders.js';
import { RecordingProvider } from './plugins/model/recording.js';
import { MiniMaxProvider } from './plugins/model/minimax.js';
import { createResponse, createError, createNotification, JsonRpcRequest } from './appserver/protocol.js';

function loadEnvConfig(): Partial<HarnessV2Config> {
  const provider = process.env.AGENT_MODEL_PROVIDER as 'openai' | 'minimax' | undefined;

  if (provider === 'minimax') {
    return {
      modelProvider: 'minimax',
      model: {
        apiKey: process.env.MINIMAX_API_KEY ?? '',
        baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1',
        model: process.env.MINIMAX_MODEL ?? 'MiniMax-M3',
      },
    };
  }

  return {
    modelProvider: 'openai',
    model: {
      apiKey: process.env.OPENAI_API_KEY ?? '',
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    },
  };
}

const envConfig = loadEnvConfig();

if (!envConfig.model?.apiKey) {
  console.error('Error: Set OPENAI_API_KEY or MINIMAX_API_KEY environment variable.');
  process.exit(1);
}

const DB_PATH = process.env.AGENT_DB_PATH ?? './data/threads.db';
mkdirSync(dirname(DB_PATH), { recursive: true });
const PORT = Number(process.env.AGENT_PORT ?? 3456);

// Room-side tables share one connection (sync driver serializes).
// Hoisted above HarnessV2 so the LLM ledger sink exists before modelWrapper runs.
const chatDb = new Database(DB_PATH);
chatDb.exec(`CREATE TABLE IF NOT EXISTS room_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  sender TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
)`);
chatDb.exec('CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room, id)');
const llmLedger = new LlmLedger(chatDb);

const harness = new HarnessV2({
  ...envConfig,
  // cumora §7.3 台账：主回路每次调用记账，fire-and-forget，绝不阻塞调用
  modelWrapper: (p) => new RecordingProvider(
    p,
    { agentId: 'appserver', purpose: 'turn', model: envConfig.model?.model ?? 'unknown' },
    llmLedger.record,
  ),
  filesystem: {
    rootPath: process.cwd(),
  },
  agent: {
    maxIterations: 10,
    systemInstruction: 'You are a helpful coding assistant. Be concise. Use tools when needed.',
    enableCompaction: true,
    compactionThreshold: 12000,
  },
  approval: {
    readonly: false,
    network: false,
    autoApprove: ['filesystem:read', 'filesystem:list'],
    confirm: ['filesystem:write', 'filesystem:mkdir', 'shell', 'code'],
    reject: [],
  },
  persistence: {
    dbPath: DB_PATH,
  },
  enableMemory: true,
  transports: ['websocket'],
  webUI: {
    enabled: true,
    port: PORT,
  },
} as HarnessV2Config);

await harness.start();
console.log(`[server] Web UI: http://localhost:${PORT}`);

// Optional: Agent Bus chat rooms (multi-agent chat via registry channels)
const REGISTRY_URL = process.env.BUS_REGISTRY_URL;
let busGateway: BusGateway | undefined;
if (REGISTRY_URL && harness.server) {
  const appServer = harness.server;

  // chatDb + room_messages created above (before harness); reuse here.
  const insertMsg = chatDb.prepare('INSERT INTO room_messages (room, sender, kind, text, ts) VALUES (?, ?, ?, ?, ?)');
  const loadMsg = chatDb.prepare('SELECT room, sender, kind, text, ts FROM room_messages WHERE room = ? ORDER BY id DESC LIMIT ?');
  startRetention(chatDb);
  // Row shape returned by better-sqlite3 .all(); boundary cast, column names are authoritative
  interface MsgRow { room: string; sender: string; kind: RoomMessage['kind']; text: string; ts: number }

  busGateway = new BusGateway({
    agentId: process.env.BUS_AGENT_ID ?? 'web-gateway',
    registryUrl: REGISTRY_URL,
    registryToken: process.env.BUS_TOKEN || undefined,
    userName: process.env.BUS_USER_NAME ?? 'me',
    // REGRESSION GUARD (docs/COORDINATION.md#2): channels 必须传进 transport
    // （heartbeat 每次重 join）。曾经漏传 → registry 重启后 gateway 丢成员籍，
    // 所有 agent 回复 403 静默消失。删这行 = 复现该事故。
    channels: (process.env.BUS_CHANNELS ?? 'team').split(',').filter(Boolean),
    contextTokens: Number(process.env.BUS_CONTEXT_TOKENS) || 3000,
    // cumora §6.6 focus window: probe TaskBoard for active leases.
    // Lazy closure — taskBoard is constructed below but only called at chat time.
    isFocused: (agentId, room) => taskBoard.ownersInFocus(room).includes(agentId),
    // cumora §6.5 闭环: promoted principles reach agent context (same lazy closure).
    loadPrinciples: (room) => taskBoard.promotedPrinciples(room),
    // future-you（cumora §9.2.1）: agent 经 bus request 排定时唤醒（lazy closure，同 isFocused）
    createReminder: (room, agentId, prompt, scheduledFor) => reminderBoard.create(room, agentId, prompt, scheduledFor),
    store: {
      insert: (m) => { insertMsg.run(m.room, m.from, m.kind, m.text, m.ts); },
      load: (room, limit) =>
        (loadMsg.all(room, limit) as MsgRow[])
          .reverse()
          .map((r) => ({ room: r.room, from: r.sender, kind: r.kind, text: r.text, ts: r.ts })),
    },
  });
  await busGateway.connect();
  busGateway.onRoomMessage((msg) => {
    appServer.broadcast(createNotification('room/message', msg));
  });

  const param = (req: JsonRpcRequest, key: string) => {
    const p = req.params as Record<string, unknown> | undefined;
    const v = p?.[key];
    return typeof v === 'string' ? v : undefined;
  };

  appServer.registerMethod('room/list', async (req) => createResponse(req.id, { rooms: await busGateway!.listRooms() }));
  appServer.registerMethod('room/create', async (req) => {
    const name = param(req, 'name');
    if (!name) return createError(req.id, -32602, 'Missing name');
    await busGateway!.createRoom(name);
    return createResponse(req.id, { ok: true });
  });
  appServer.registerMethod('room/history', (req) => {
    const room = param(req, 'room');
    if (!room) return createError(req.id, -32602, 'Missing room');
    return createResponse(req.id, { messages: busGateway!.getHistory(room) });
  });
  appServer.registerMethod('room/send', async (req) => {
    const room = param(req, 'room');
    const text = param(req, 'text');
    if (!room || !text) return createError(req.id, -32602, 'Missing room or text');
    return createResponse(req.id, await busGateway!.sendChat(room, text));
  });

  // Task board (Task/Contract + Lease)
  // 验收门小脑（cumora §10.1.1 + §7 双脑）：verify 走 MINIMAX_MODEL_SMALL，
  // 经 RecordingProvider 入台账（purpose='verify'）。10s 短超时——辅助调用 fail-fast。
  let verifyCompletion: ((task: RoomTask, evidenceText: string) => Promise<{ complete: boolean; reason?: string; nextStep?: string }>) | undefined;
  if (envConfig.modelProvider === 'minimax' && envConfig.model?.apiKey) {
    const smallModel = process.env.MINIMAX_MODEL_SMALL ?? envConfig.model.model ?? 'MiniMax-M3';
    const verifier = new RecordingProvider(
      new MiniMaxProvider({ apiKey: envConfig.model.apiKey, baseUrl: envConfig.model.baseUrl, model: smallModel }),
      { agentId: 'appserver', purpose: 'verify', model: smallModel },
      llmLedger.record,
    );
    verifyCompletion = async (task, evidenceText) => {
      const criteria = task.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n');
      const gen = verifier.generate([
        { role: 'system', content: `你是验收员。对照验收标准审查交付证据，只用 JSON 回答 {"complete": boolean, "reason": string, "next_step": string}。
规则：人类要了交付物而证据只是"收到/我看看"式的确认，complete 必须为 false（确认 ≠ 交付）。
验收的是"任务被完成"，不要求逐条措辞对应，但每条标准都要有实质证据支撑。拿不准判 false。` },
        { role: 'user', content: `任务：${task.title}\n验收标准：\n${criteria}\n\n交付证据：\n${evidenceText.slice(0, 8000)}` },
      ]);
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('verify timeout')), 10_000));
      const res = await Promise.race([gen, timeout]);
      const text = res.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('verifier returned non-JSON');
      const v = JSON.parse(m[0]) as { complete?: boolean; reason?: string; next_step?: string };
      return { complete: v.complete === true, reason: v.reason, nextStep: v.next_step };
    };
  }

  const taskBoard = new TaskBoard(chatDb, {
    requestAgent: (target, payload, timeoutMs) => busGateway!.requestAgent(target, payload, timeoutMs),
    postMessage: (room, text) => busGateway!.postSystemMessage(room, text),
    listMembers: (room) => busGateway!.listMembers(room),
    verifyCompletion,
  });
  // cumora §6.6: window-end digest delivery — flush on task transitions and
  // a 30s sweep (covers lease-expiry recycle ending a window with no RPC).
  const flushFocus = (room?: string) =>
    busGateway!.flushDigests(room).catch((err) => console.error('[focus] digest flush failed:', err));
  setInterval(() => flushFocus(), 30000).unref();

  appServer.registerMethod('task/create', (req) => {
    const room = param(req, 'room');
    const title = param(req, 'title');
    const owner = param(req, 'owner') ?? null;
    const p = req.params as Record<string, unknown> | undefined;
    const acceptance = Array.isArray(p?.acceptance) ? p.acceptance.filter((a): a is string => typeof a === 'string') : [];
    if (!room || !title) return createError(req.id, -32602, 'Missing room or title');
    const risk = param(req, 'risk') === 'high' ? 'high' as const : 'low' as const;
    try {
      return createResponse(req.id, { task: taskBoard.create(room, title, acceptance, owner, 'human', risk) });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('task/list', (req) => {
    const room = param(req, 'room');
    if (!room) return createError(req.id, -32602, 'Missing room');
    return createResponse(req.id, { tasks: taskBoard.list(room) });
  });
  appServer.registerMethod('task/approve', (req) => {
    const id = param(req, 'taskId');
    if (!id) return createError(req.id, -32602, 'Missing taskId');
    try {
      const task = taskBoard.approve(id);
      flushFocus(); // after mutation: window must be closed before probing
      return createResponse(req.id, { task });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('task/return', (req) => {
    const id = param(req, 'taskId');
    const note = param(req, 'note') ?? '未说明原因';
    if (!id) return createError(req.id, -32602, 'Missing taskId');
    try {
      const task = taskBoard.returnTask(id, note);
      flushFocus(); // after mutation: window must be closed before probing
      return createResponse(req.id, { task });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('task/cancel', (req) => {
    const id = param(req, 'taskId');
    const adr = param(req, 'adr') ?? '';
    if (!id) return createError(req.id, -32602, 'Missing taskId');
    try {
      const task = taskBoard.cancel(id, adr);
      flushFocus(); // after mutation: window must be closed before probing
      return createResponse(req.id, { task });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('task/reopen', (req) => {
    const id = param(req, 'taskId');
    const evidence = param(req, 'evidence') ?? '';
    if (!id) return createError(req.id, -32602, 'Missing taskId');
    try {
      const task = taskBoard.reopen(id, evidence);
      flushFocus(); // after mutation: window must be closed before probing
      return createResponse(req.id, { task });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('task/reassign', (req) => {
    const id = param(req, 'taskId');
    const owner = param(req, 'owner');
    if (!id || !owner) return createError(req.id, -32602, 'Missing taskId or owner');
    try {
      const task = taskBoard.reassign(id, owner);
      flushFocus(); // after mutation: window must be closed before probing
      return createResponse(req.id, { task });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('task/confirm', (req) => {
    const id = param(req, 'taskId');
    if (!id) return createError(req.id, -32602, 'Missing taskId');
    try {
      const task = taskBoard.confirm(id);
      flushFocus(); // after mutation: window must be closed before probing
      return createResponse(req.id, { task });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('promise/create', async (req) => {
    const room = param(req, 'room');
    const taskId = param(req, 'taskId');
    const promiser = param(req, 'promiser');
    const p = req.params as Record<string, unknown> | undefined;
    const dueInMin = typeof p?.dueInMin === 'number' ? p.dueInMin : 60;
    if (!room || !taskId || !promiser) return createError(req.id, -32602, 'Missing room, taskId or promiser');
    try {
      await taskBoard.createPromise(room, taskId, promiser, Date.now() + dueInMin * 60000);
      return createResponse(req.id, { ok: true });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('dep/add', (req) => {
    const blocked = param(req, 'blockedTaskId');
    const blocking = param(req, 'blockingTaskId');
    if (!blocked || !blocking) return createError(req.id, -32602, 'Missing blockedTaskId or blockingTaskId');
    try {
      taskBoard.addDep(blocked, blocking);
      return createResponse(req.id, { ok: true });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  console.log(`[server] TaskBoard ready (room_tasks)`);

  // Reminder board (future-you, cumora §9.2.1)
  const reminderBoard = new ReminderBoard(chatDb, {
    postMessage: (room, text) => busGateway!.postSystemMessage(room, text),
    deliver: (room, agentId, prompt) => busGateway!.remindAgent(room, agentId, prompt),
  });
  appServer.registerMethod('reminder/create', (req) => {
    const room = param(req, 'room');
    const agent = param(req, 'agent');
    const prompt = param(req, 'prompt');
    const p = req.params as Record<string, unknown> | undefined;
    const atRaw = p?.at;
    const at = typeof atRaw === 'number' ? atRaw : typeof atRaw === 'string' ? Date.parse(atRaw) : NaN;
    if (!room || !agent || !prompt || !Number.isFinite(at)) {
      return createError(req.id, -32602, 'Missing room/agent/prompt or invalid at (epoch ms or ISO string)');
    }
    try {
      return createResponse(req.id, { reminder: reminderBoard.create(room, agent, prompt, at) });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('reminder/list', (req) => {
    const room = param(req, 'room');
    if (!room) return createError(req.id, -32602, 'Missing room');
    return createResponse(req.id, { reminders: reminderBoard.list(room) });
  });
  appServer.registerMethod('reminder/cancel', (req) => {
    const id = param(req, 'reminderId');
    if (!id) return createError(req.id, -32602, 'Missing reminderId');
    try {
      reminderBoard.cancel(id);
      return createResponse(req.id, { ok: true });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  console.log(`[server] ReminderBoard ready (room_reminders)`);

  // Decision board (quorum + timebox + anti-reopen)
  const decisionBoard = new DecisionBoard(chatDb, {
    requestAgent: (target, payload, timeoutMs) => busGateway!.requestAgent(target, payload, timeoutMs),
    postMessage: (room, text) => busGateway!.postSystemMessage(room, text),
    listMembers: (room) => busGateway!.listMembers(room),
  });
  appServer.registerMethod('decision/open', async (req) => {
    const room = param(req, 'room');
    const question = param(req, 'question');
    const p = req.params as Record<string, unknown> | undefined;
    const options = Array.isArray(p?.options) ? p.options.filter((o): o is string => typeof o === 'string') : [];
    const criterion = param(req, 'criterion') ?? '';
    const defaultOption = param(req, 'defaultOption') ?? options[0] ?? '';
    const quorum = typeof p?.quorum === 'number' ? p.quorum : 2;
    const timeboxMin = typeof p?.timeboxMin === 'number' ? p.timeboxMin : 5;
    if (!room || !question) return createError(req.id, -32602, 'Missing room or question');
    try {
      return createResponse(req.id, { decision: await decisionBoard.open(room, question, options, criterion, quorum, defaultOption, timeboxMin * 60000) });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('decision/list', (req) => {
    const room = param(req, 'room');
    if (!room) return createError(req.id, -32602, 'Missing room');
    return createResponse(req.id, { decisions: decisionBoard.list(room) });
  });
  appServer.registerMethod('decision/resolve', (req) => {
    const id = param(req, 'decisionId');
    const option = param(req, 'option');
    if (!id || !option) return createError(req.id, -32602, 'Missing decisionId or option');
    try {
      return createResponse(req.id, { decision: decisionBoard.resolve(id, option) });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('decision/reopen', (req) => {
    const id = param(req, 'decisionId');
    const evidence = param(req, 'evidence') ?? '';
    if (!id) return createError(req.id, -32602, 'Missing decisionId');
    try {
      return createResponse(req.id, { decision: decisionBoard.reopen(id, evidence) });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });

  appServer.registerMethod('principle/propose', (req) => {
    const room = param(req, 'room');
    const text = param(req, 'text');
    const taskId = param(req, 'taskId') ?? 'manual';
    if (!room || !text) return createError(req.id, -32602, 'Missing room or text');
    taskBoard.proposePrinciple(room, text, taskId);
    return createResponse(req.id, { ok: true });
  });
  appServer.registerMethod('principle/promote', (req) => {
    const id = param(req, 'principleId');
    if (!id) return createError(req.id, -32602, 'Missing principleId');
    try {
      taskBoard.promotePrinciple(id, false);
      return createResponse(req.id, { ok: true });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('principle/pin', (req) => {
    const id = param(req, 'principleId');
    if (!id) return createError(req.id, -32602, 'Missing principleId');
    try {
      taskBoard.promotePrinciple(id, true);
      return createResponse(req.id, { ok: true });
    } catch (err) {
      return createError(req.id, -32000, String(err instanceof Error ? err.message : err));
    }
  });
  appServer.registerMethod('principle/list', (req) => {
    const room = param(req, 'room');
    if (!room) return createError(req.id, -32602, 'Missing room');
    return createResponse(req.id, { principles: taskBoard.listPrinciples(room) });
  });

  // Metrics: local board counters + remote registry gate counters
  appServer.registerMethod('metrics/get', async (req) => {
    let registry: unknown;
    try {
      const res = await fetch(`${REGISTRY_URL}/metrics`, {
        headers: process.env.BUS_TOKEN ? { 'x-bus-token': process.env.BUS_TOKEN } : {},
      });
      registry = await res.json();
    } catch {
      registry = { error: 'registry unreachable' };
    }
    return createResponse(req.id, {
      tasks: taskBoard.metrics,
      decisions: decisionBoard.metrics,
      gateway: busGateway!.health,
      registry,
    });
  });

  // LLM 台账（cumora §7.3）：本地 SQLite（server 侧调用）+ registry JSONL（agent 上报）合并视图
  appServer.registerMethod('llm/stats', async (req) => {
    const p = req.params as Record<string, unknown> | undefined;
    const hours = typeof p?.hours === 'number' ? p.hours : 24;
    let remote: unknown;
    try {
      const res = await fetch(`${REGISTRY_URL}/llm-calls/stats?hours=${hours}`, {
        headers: process.env.BUS_TOKEN ? { 'x-bus-token': process.env.BUS_TOKEN } : {},
      });
      remote = res.ok ? ((await res.json()) as { rows?: unknown }).rows ?? [] : { error: `HTTP ${res.status}` };
    } catch {
      remote = { error: 'registry unreachable' };
    }
    return createResponse(req.id, { hours, server: llmLedger.stats(hours), agents: remote });
  });
  console.log(`[server] Bus gateway "${process.env.BUS_AGENT_ID ?? 'web-gateway'}" -> ${REGISTRY_URL}`);
}

process.on('SIGINT', () => {
  void busGateway?.disconnect();
  harness.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  void busGateway?.disconnect();
  harness.stop();
  process.exit(0);
});
