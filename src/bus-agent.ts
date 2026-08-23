#!/usr/bin/env node
// ============================================================
// Standalone LLM-backed Bus Agent
// Joins a registry channel, answers requests (MiniMax if key set),
// logs channel events.
//
//   AGENT_ID=pi-agent REGISTRY_URL=http://127.0.0.1:9876 \
//   BUS_CHANNEL=team MINIMAX_API_KEY=sk-... node bus-agent.mjs
//
// One-shot client mode (connect, request, print, exit):
//   ONESHOT_TARGET=pi-agent ONESHOT_TEXT="你好" node bus-agent.mjs
// ============================================================

import os from 'node:os';
import { AgentBusImpl } from './plugins/agent-bus/bus.js';
import { HttpTransport } from './plugins/agent-bus/http-transport.js';
import { MiniMaxProvider } from './plugins/model/minimax.js';

const agentId = process.env.AGENT_ID ?? '';
const registryUrl = process.env.REGISTRY_URL ?? '';
if (!agentId || !registryUrl) {
  console.error('Error: AGENT_ID and REGISTRY_URL are required.');
  process.exit(1);
}
const channel = process.env.BUS_CHANNEL ?? 'team';
const persona = process.env.AGENT_PERSONA ?? '';

const model = process.env.MINIMAX_API_KEY
  ? new MiniMaxProvider({
      apiKey: process.env.MINIMAX_API_KEY,
      baseUrl: process.env.MINIMAX_BASE_URL,
      model: process.env.MINIMAX_MODEL,
    })
  : undefined;

function extractText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string') {
    return payload.text;
  }
  return JSON.stringify(payload);
}

const transport = new HttpTransport({ agentId, registryUrl, channel });
const bus = new AgentBusImpl(agentId, transport);

/** Strip <think>…</think> so only the spoken answer remains. */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function answerText(text: string, from: string): Promise<string> {
  if (!model) return `${agentId}@${os.hostname()} 收到: ${text}`;
  const res = await model.generate([
    { role: 'system', content: `You are agent "${agentId}" running on host "${os.hostname()}", in a group chat.${persona ? ` 你的专长：${persona}。` : ''} Answer concisely in Chinese.` },
    { role: 'user', content: `${from}: ${text}` },
  ]);
  return res.content ?? '';
}

/**
 * Decide whether to interject in a group chat message that did not @me.
 * Returns true only when the message clearly concerns this agent.
 */
async function shouldInterject(text: string, from: string): Promise<boolean> {
  if (!model) return false; // no LLM → cannot judge → stay silent
  const res = await model.generate([
    {
      role: 'system',
      content: `你是群聊中的 agent「${agentId}」，运行在 ${os.hostname()}。${persona ? `你的专长：${persona}。` : ''}判断是否回应这条群聊消息：话题明显属于你的专长范围、或向你求助 → YES；与你专长无关的话题、寒暄闲聊 → NO；拿不准 → NO。只回答 YES 或 NO。`,
    },
    { role: 'user', content: `${from}: ${text}` },
  ]);
  return stripThink(res.content ?? '').toUpperCase().startsWith('YES');
}

/** Speak into a specific room (channel) as a chat event. */
async function speak(room: string, text: string): Promise<void> {
  await transport.send({
    id: `${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    type: 'event',
    from: agentId,
    to: 'broadcast',
    payload: { kind: 'chat', room, from: agentId, text },
    channel: room,
    timestamp: Date.now(),
  });
}

bus.onRequest(async (payload, reply) => {
  const text = extractText(payload);
  console.log(`[${agentId}] request: ${text.slice(0, 120)}`);
  try {
    reply({ agent: agentId, host: os.hostname(), text: await answerText(text, extractFrom(payload) ?? 'someone') });
  } catch (err) {
    reply({ agent: agentId, host: os.hostname(), error: String(err) });
  }
});

function extractFrom(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object' && 'from' in payload && typeof payload.from === 'string') {
    return payload.from;
  }
  return undefined;
}

bus.onMessage(async (msg) => {
  if (msg.type !== 'event' || msg.from === agentId) return;
  const p = msg.payload;
  if (!(p && typeof p === 'object' && 'kind' in p && p.kind === 'chat')) {
    console.log(`[${agentId}] event from ${msg.from} [${msg.channel ?? 'default'}]: ${JSON.stringify(p).slice(0, 200)}`);
    return;
  }
  const text = 'text' in p && typeof p.text === 'string' ? p.text : '';
  const from = 'from' in p && typeof p.from === 'string' ? p.from : msg.from;
  const isHuman = 'human' in p && p.human === true;
  const room = msg.channel ?? channel;
  console.log(`[${agentId}] chat from ${from} [${room}]: ${text.slice(0, 80)}`);

  // Only humans' messages trigger judgment; agent chatter never does (loop guard).
  if (!isHuman) return;

  const mentioned = new RegExp(`@${agentId}(?:\\b|$)`).test(text);
  if (!mentioned && !(await shouldInterject(text, from).catch(() => false))) {
    console.log(`[${agentId}] stays silent`);
    return;
  }
  console.log(`[${agentId}] interjects`);
  const answer = await answerText(text, from).catch((err) => `（回答失败: ${String(err)}）`);
  await speak(room, answer);
});

await bus.connect();
console.log(`[${agentId}] joined channel "${channel}" via ${registryUrl}`);

const oneshotTarget = process.env.ONESHOT_TARGET;
if (oneshotTarget) {
  const text = process.env.ONESHOT_TEXT ?? 'ping';
  const res = await bus.request(oneshotTarget, { text }, 90000);
  console.log('ONESHOT_RESULT ' + JSON.stringify(res));
  await bus.disconnect();
  process.exit(0);
}

await bus.broadcast({ online: true, agent: agentId, host: os.hostname() });

process.on('SIGTERM', () => bus.disconnect().then(() => process.exit(0)));
process.on('SIGINT', () => bus.disconnect().then(() => process.exit(0)));
