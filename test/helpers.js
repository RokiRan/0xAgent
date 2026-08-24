// Shared test helpers for the coordination-layer suite.
// Runner: npx tsx --test test/   (node:test, zero extra deps)
import Database from 'better-sqlite3';
import { createRegistryServer } from '../src/plugins/agent-bus/http-transport.js';
/** Registry on an ephemeral port; close() awaited in test teardown. */
export async function bootRegistry() {
    const server = createRegistryServer(0);
    // Node 20: no Promise.withResolvers — executor form required here
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}
export async function postJson(url, path, body) {
    const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}
export async function getJson(url, path) {
    const res = await fetch(`${url}${path}`);
    return res.json();
}
export async function pollMessages(url, agentId) {
    const data = (await getJson(url, `/poll?agentId=${agentId}`));
    return data.messages ?? [];
}
/** Register + join in one call. */
export async function joinChannel(url, channel, agentId) {
    await postJson(url, '/register', { agentId, url: `http://127.0.0.1:9/${agentId}` });
    const res = await postJson(url, '/channels/join', { agentId, channel });
    if (res.status === 404) {
        await postJson(url, '/channels/create', { channel, agentId });
    }
}
export function makeDb() {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    return db;
}
/** TaskBoard deps with recording fakes; override requestAgent to script replies. */
export function makeTaskDeps(overrides = {}) {
    const messages = [];
    const requests = [];
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
export function makeDecisionDeps(overrides = {}) {
    const messages = [];
    const requests = [];
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
export function roomMsg(room, from, text, kind = 'user') {
    return { room, from, kind, text, ts: Date.now() };
}
/** Poll a predicate until true or timeout (ms). Throws on timeout. */
export async function waitFor(pred, timeoutMs = 3000, stepMs = 25) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await pred())
            return;
        await new Promise((r) => setTimeout(r, stepMs));
    }
    throw new Error('waitFor timeout');
}
