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

const transport = new HttpTransport({
  agentId,
  registryUrl,
  channel,
  registryToken: process.env.BUS_TOKEN || undefined,
});
const bus = new AgentBusImpl(agentId, transport);

/** Strip <think>…</think> so only the spoken answer remains. */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function contextBlock(context: string[]): string {
  if (context.length === 0) return '';
  return `以下是群聊最近的消息记录（含其他 agent 的发言，供你衔接上下文）：\n${context.join('\n')}\n\n`;
}

async function answerText(text: string, from: string, context: string[] = []): Promise<string> {
  if (!model) return `${agentId}@${os.hostname()} 收到: ${text}`;
  const res = await model.generate([
    { role: 'system', content: `You are agent "${agentId}" running on host "${os.hostname()}", in a group chat.${persona ? ` 你的专长：${persona}。` : ''} Answer concisely in Chinese.` },
    { role: 'user', content: `${contextBlock(context)}现在 ${from} 说：${text}` },
  ]);
  return res.content ?? '';
}

/**
 * Decide whether to interject in a group chat message that did not @me.
 * Returns true only when the message clearly concerns this agent.
 */
async function shouldInterject(text: string, from: string, context: string[] = []): Promise<boolean> {
  if (!model) return false; // no LLM → cannot judge → stay silent
  const res = await model.generate([
    {
      role: 'system',
      content: `你是群聊中的 agent「${agentId}」，运行在 ${os.hostname()}。${persona ? `你的专长：${persona}。` : ''}判断是否回应这条群聊消息。

回应（YES）仅当：被点名/被提问，或你能提供前序发言中没有的实质性增量（纠错、关键补充、明确分歧）。
沉默（NO）当：话题与你专长无关；别人的回答已经完整；你只想表示赞同或总结（附和是噪声）；你最近已经发过言且讨论正在收敛；拿不准。

只回答 YES 或 NO。`,
    },
    { role: 'user', content: `${contextBlock(context)}${from}: ${text}` },
  ]);
  return stripThink(res.content ?? '').toUpperCase().startsWith('YES');
}

function extractContext(payload: object): string[] {
  return 'context' in payload && Array.isArray(payload.context)
    ? payload.context.filter((c): c is string => typeof c === 'string')
    : [];
}

/** Speak into a specific room (channel) as a chat event. */
async function speak(room: string, text: string, context: string[] = []): Promise<void> {
  await transport.send({
    id: `${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    type: 'event',
    from: agentId,
    to: 'broadcast',
    payload: { kind: 'chat', room, from: agentId, text, context },
    channel: room,
    timestamp: Date.now(),
  });
}

/** Handle task assign/rework requests from the TaskBoard; reply with evidence. */
async function handleTaskRequest(payload: object, reply: (r: unknown) => void): Promise<void> {
  const taskId = 'taskId' in payload && typeof payload.taskId === 'string' ? payload.taskId : '';
  const action = 'action' in payload && typeof payload.action === 'string' ? payload.action : 'assign';
  const title = 'title' in payload && typeof payload.title === 'string' ? payload.title : '';
  const acceptance =
    'acceptance' in payload && Array.isArray(payload.acceptance)
      ? payload.acceptance.filter((a): a is string => typeof a === 'string')
      : [];
  const note = 'note' in payload && typeof payload.note === 'string' ? payload.note : '';

  console.log(`[${agentId}] task ${action}: ${title.slice(0, 80)}`);
  const criteria = acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n');
  const prompt = `你收到一个任务。
标题：${title}
验收标准：
${criteria}
${action === 'rework' ? `上一次交付被退回，退回原因：${note}\n请修正后重新交付。` : ''}
请直接完成任务并给出交付物。你的回复将全文作为验收证据提交，请确保逐条满足验收标准。`;

  try {
    const answer = model
      ? stripThink((await model.generate([
          { role: 'system', content: `You are agent "${agentId}".${persona ? ` 你的专长：${persona}。` : ''} 完成任务并用中文交付。` },
          { role: 'user', content: prompt },
        ])).content ?? '')
      : `${agentId}@${os.hostname()} 无 LLM，无法执行任务`;
    reply({ kind: 'task', taskId, action: 'submit', agent: agentId, evidence: answer });
  } catch (err) {
    reply({ kind: 'task', taskId, action: 'failed', agent: agentId, error: String(err) });
  }
}

/** Handle decision vote requests: pick one of the given options with a rationale. */
async function handleDecisionVote(payload: object, reply: (r: unknown) => void): Promise<void> {
  const decisionId = 'decisionId' in payload && typeof payload.decisionId === 'string' ? payload.decisionId : '';
  const question = 'question' in payload && typeof payload.question === 'string' ? payload.question : '';
  const criterion = 'criterion' in payload && typeof payload.criterion === 'string' ? payload.criterion : '';
  const options =
    'options' in payload && Array.isArray(payload.options)
      ? payload.options.filter((o): o is string => typeof o === 'string')
      : [];

  console.log(`[${agentId}] decision vote: ${question.slice(0, 80)}`);
  if (!model || options.length === 0) {
    reply({ kind: 'decision', decisionId, option: '', rationale: '无法投票' });
    return;
  }
  const optLines = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  try {
    const res = await model.generate([
      { role: 'system', content: `你是 agent「${agentId}」。${persona ? `你的专长：${persona}。` : ''} 对议题投票：必须从给定选项中选一个，第一行只写所选选项的原文，第二行写一句话理由（从你的专长视角）。` },
      { role: 'user', content: `议题：${question}\n${criterion ? `判定标准：${criterion}\n` : ''}选项：\n${optLines}` },
    ]);
    const clean = stripThink(res.content ?? '');
    const [firstLine, ...rest] = clean.split('\n').map((s) => s.trim()).filter(Boolean);
    // Match by exact text first, then containment; no match = abstain
    const picked =
      options.find((o) => o === firstLine) ??
      options.find((o) => firstLine.includes(o) || o.includes(firstLine)) ??
      '';
    reply({ kind: 'decision', decisionId, option: picked, rationale: rest.join(' ').slice(0, 200) });
  } catch (err) {
    reply({ kind: 'decision', decisionId, option: '', rationale: String(err) });
  }
}

/** Handle promise confirmation: judge feasibility from persona before committing. */
async function handlePromiseConfirm(payload: object, reply: (r: unknown) => void): Promise<void> {
  const promiseId = 'promiseId' in payload && typeof payload.promiseId === 'string' ? payload.promiseId : '';
  const taskTitle = 'taskTitle' in payload && typeof payload.taskTitle === 'string' ? payload.taskTitle : '';
  const dueAt = 'dueAt' in payload && typeof payload.dueAt === 'string' ? payload.dueAt : '';
  if (!model) {
    reply({ kind: 'promise', promiseId, confirm: false, note: '无 LLM，不轻诺' });
    return;
  }
  try {
    const res = await model.generate([
      { role: 'system', content: `你是 agent「${agentId}」。${persona ? `你的专长：${persona}。` : ''} 有人向你登记一个交付承诺。只承诺你专长内且可行的事；拿不准就拒绝。第一行只写 YES 或 NO，第二行一句话理由。` },
      { role: 'user', content: `任务：${taskTitle}\n交付时限：${dueAt}` },
    ]);
    const clean = stripThink(res.content ?? '');
    const [verdict, ...rest] = clean.split('\n').map((s) => s.trim()).filter(Boolean);
    reply({ kind: 'promise', promiseId, confirm: verdict.toUpperCase().startsWith('YES'), note: rest.join(' ').slice(0, 150) });
  } catch (err) {
    reply({ kind: 'promise', promiseId, confirm: false, note: String(err) });
  }
}

bus.onRequest(async (payload, reply) => {
  if (payload && typeof payload === 'object' && 'kind' in payload && payload.kind === 'task') {
    await handleTaskRequest(payload, reply);
    return;
  }
  if (payload && typeof payload === 'object' && 'kind' in payload && payload.kind === 'decision') {
    await handleDecisionVote(payload, reply);
    return;
  }
  if (payload && typeof payload === 'object' && 'kind' in payload && payload.kind === 'promise') {
    await handlePromiseConfirm(payload, reply);
    return;
  }
  const text = extractText(payload);
  const ctx = payload && typeof payload === 'object' ? extractContext(payload) : [];
  console.log(`[${agentId}] request: ${text.slice(0, 120)}`);
  try {
    reply({ agent: agentId, host: os.hostname(), text: await answerText(text, extractFrom(payload) ?? 'someone', ctx) });
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
  const room = msg.channel ?? channel;
  console.log(`[${agentId}] chat from ${from} [${room}]: ${text.slice(0, 80)}`);

  // Agent messages are judgeable now — the registry's lapping gate bounds
  // inter-agent exchanges to ~1 message per agent per round, so no loop guard
  // is needed here. Judge failure stays fail-closed (silence).
  const mentioned = new RegExp(`@${agentId}(?:\\b|$)`).test(text);
  const ctx = extractContext(p);
  if (!mentioned && !(await shouldInterject(text, from, ctx).catch(() => false))) {
    console.log(`[${agentId}] stays silent`);
    return;
  }
  console.log(`[${agentId}] interjects`);
  // Freshness-aware speak: on HELD, recompute with the inlined unseen messages and retry once.
  let attemptCtx = [...ctx];
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await answerText(text, from, attemptCtx).catch((err) => `（回答失败: ${String(err)}）`);
    try {
      await speak(room, answer, attemptCtx);
      return;
    } catch (err) {
      const unseen = parseFreshnessHeld(err);
      if (unseen && attempt === 0) {
        console.log(`[${agentId}] HELD(freshness), recomputing with ${unseen.length} unseen`);
        attemptCtx = [...attemptCtx, ...unseen];
        continue;
      }
      console.log(`[${agentId}] speak held/failed: ${String(err).slice(0, 120)}`);
      return;
    }
  }
});

/** Parse a freshness HELD body into "from: text" lines; null if not a freshness hold. */
function parseFreshnessHeld(err: unknown): string[] | null {
  const m = String(err).match(/^HTTP 409: (\{.*\})$/s);
  if (!m) return null;
  try {
    const body = JSON.parse(m[1]) as Record<string, unknown>;
    if (body.held !== true || body.reason !== 'freshness' || !Array.isArray(body.unseen)) return null;
    return body.unseen
      .filter((u): u is { from: string; text: string } =>
        !!u && typeof u === 'object' && 'from' in u && 'text' in u && typeof u.from === 'string' && typeof u.text === 'string')
      .map((u) => `${u.from}: ${u.text}`);
  } catch {
    return null;
  }
}

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
