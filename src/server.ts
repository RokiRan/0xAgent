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
import { BusGateway } from './appserver/bus-gateway.js';
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

const harness = new HarnessV2({
  ...envConfig,
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
  busGateway = new BusGateway({
    agentId: process.env.BUS_AGENT_ID ?? 'web-gateway',
    registryUrl: REGISTRY_URL,
    userName: process.env.BUS_USER_NAME ?? 'me',
  });
  await busGateway.connect((process.env.BUS_CHANNELS ?? 'team').split(',').filter(Boolean));
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
