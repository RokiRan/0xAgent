// Shared test helpers for the coordination-layer suite.
// Runner: npx tsx --test test/   (node:test, zero extra deps)

import Database from 'better-sqlite3';
import type { Database as SqliteDb } from 'better-sqlite3';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRegistryServer } from '../src/plugins/agent-bus/http-transport.js';
import type { BusMessage } from '../src/plugins/agent-bus/bus.js';
import type { RoomMessage } from '../src/appserver/bus-gateway.js';
import type { TaskBoardDeps } from '../src/appserver/task-board.js';
import type { DecisionBoardDeps } from '../src/appserver/decision-board.js';

export interface TestRegistry {
  url: string;
  close: () => Promise<void>;
}

/** Registry on an ephemeral port; close() awaited in test teardown. */
export async function bootRegistry(): Promise<TestRegistry> {
  const server: Server = createRegistryServer(0);
  // Node 20: no Promise.withResolvers — executor form required here
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function postJson(url: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function getJson(url: string, path: string): Promise<unknown> {
  const res = await fetch(`${url}${path}`);
  return res.json();
}

export async function pollMessages(url: string, agentId: string): Promise<BusMessage[]> {
  const data = (await getJson(url, `/poll?agentId=${agentId}`)) as { messages?: BusMessage[] };
  return data.messages ?? [];
}

/** Register + join in one call. */
export async function joinChannel(url: string, channel: string, agentId: string): Promise<void> {
  await postJson(url, '/register', { agentId, url: `http://127.0.0.1:9/${agentId}` });
  const res = await postJson(url, '/channels/join', { agentId, channel });
  if (res.status === 404) {
    await postJson(url, '/channels/create', { channel, agentId });
  }
}

export function makeDb(): SqliteDb {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

export interface RecordedCall {
  target: string;
  payload: unknown;
}

/** TaskBoard deps with recording fakes; override requestAgent to script replies. */
export function makeTaskDeps(overrides: Partial<TaskBoardDeps> = {}): TaskBoardDeps & {
  messages: string[];
  requests: RecordedCall[];
} {
  const messages: string[] = [];
  const requests: RecordedCall[] = [];
  return {
    messages,
    requests,
    postMessage: (_room, text) => { messages.push(text); },
    requestAgent: (target, payload) => {
      requests.push({ target, payload });
      return Promise.resolve({ kind: 'task', action: 'failed', error: 'no handler' });
    },
    listMembers: () => Promise.resolve([]),
    ...overrides,
  };
}

/** DecisionBoard deps with recording fakes. */
export function makeDecisionDeps(overrides: Partial<DecisionBoardDeps> = {}): DecisionBoardDeps & {
  messages: string[];
  requests: RecordedCall[];
} {
  const messages: string[] = [];
  const requests: RecordedCall[] = [];
  return {
    messages,
    requests,
    postMessage: (_room, text) => { messages.push(text); },
    requestAgent: (target, payload) => {
      requests.push({ target, payload });
      return Promise.resolve({});
    },
    listMembers: () => Promise.resolve([]),
    sweepIntervalMs: 60_000,
    ...overrides,
  };
}

export function roomMsg(room: string, from: string, text: string, kind: RoomMessage['kind'] = 'user'): RoomMessage {
  return { room, from, kind, text, ts: Date.now() };
}

/** Poll a predicate until true or timeout (ms). Throws on timeout. */
export async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timeout');
}
