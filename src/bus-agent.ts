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
import { RecordingProvider, httpLedgerSink } from './plugins/model/recording.js';
import { createEngineFromEnv } from './plugins/engine/index.js';
import { powerHostFromEnv, matchPowerIntent, powerExecute, PowerAction } from './plugins/power/index.js';
import { collectAgentCard, AgentCard } from './plugins/agent-bus/agent-card.js';
import type { ModelProvider } from './plugins/model/interface.js';

const agentId = process.env.AGENT_ID ?? '';
const registryUrl = process.env.REGISTRY_URL ?? '';
if (!agentId || !registryUrl) {
  console.error('Error: AGENT_ID and REGISTRY_URL are required.');
  process.exit(1);
}
const channel = process.env.BUS_CHANNEL ?? 'team';
const persona = process.env.AGENT_PERSONA ?? '';

// 双脑（cumora §7）：大脑只花在人会读的产出（reply/task），
// judge/vote/promise 这类守门判断走小脑。MINIMAX_MODEL_SMALL 未设时回落主模型
// （策略收口在位，行为不变），设置后立即分流。
const BIG_MODEL = process.env.MINIMAX_MODEL ?? 'MiniMax-M3';
const SMALL_MODEL = process.env.MINIMAX_MODEL_SMALL ?? BIG_MODEL;

// 台账（cumora §7.3）：provider 层收口记账，上报 registry /llm-calls，
// fire-and-forget——上报失败绝不影响调用本身。
const ledgerSink = httpLedgerSink(registryUrl, process.env.BUS_TOKEN || undefined);

// 编码引擎（omp / claude-code）：配置后任务委派给真实编码 CLI 执行，
// 不设则维持 LLM-only 空谈旧行为。
const coding = createEngineFromEnv();
if (coding.engine) console.log(`[${agentId}] coding engine: ${coding.engine.id} (workdir ${coding.workdir})`);

// 电源控制（env 白名单，只装同 LAN 的 agent）：意图确定性匹配，
// LLM 无法改目标；kind:'power' 走结构化通道，聊天走意图识别。
const powerHost = powerHostFromEnv();
if (powerHost) console.log(`[${agentId}] power control: ${powerHost.name} (${powerHost.ip})`);

// 能力档案（主脑调度的事实源）：启动采集一次，10 分钟刷新；
// 搭 /register 心跳进 registry，registry 重启后自愈。
// 能力是变量：GPU/工具/本地服务全部探针实测，电源控制随配置派生。
let agentCard: AgentCard | undefined;
const refreshCard = async () => {
  try {
    agentCard = await collectAgentCard(agentId, process.env, { powerTarget: powerHost?.name });
  } catch (err) {
    console.warn(`[${agentId}] card collect failed:`, err);
  }
};
await refreshCard();
setInterval(refreshCard, 10 * 60 * 1000).unref();

let replyModel: ModelProvider | undefined;
let taskModel: ModelProvider | undefined;
let judgeModel: ModelProvider | undefined;
let voteModel: ModelProvider | undefined;
let promiseModel: ModelProvider | undefined;
if (process.env.MINIMAX_API_KEY) {
  const base = { apiKey: process.env.MINIMAX_API_KEY, baseUrl: process.env.MINIMAX_BASE_URL };
  const big = new MiniMaxProvider({ ...base, model: BIG_MODEL });
  // 小脑做的是分类/裁决（judge/vote/promise），temperature=0 求确定性——
  // 0.7 下同一承诺请求会随机 YES/NO 漂移（综合测试实测）。
  const small = SMALL_MODEL === BIG_MODEL
    ? big
    : new MiniMaxProvider({ ...base, model: SMALL_MODEL, temperature: 0 });
  const wrap = (inner: ModelProvider, purpose: string, model: string) =>
    new RecordingProvider(inner, { agentId, purpose, model }, ledgerSink);
  replyModel = wrap(big, 'reply', BIG_MODEL);
  taskModel = wrap(big, 'task', BIG_MODEL);
  judgeModel = wrap(small, 'judge', SMALL_MODEL);
  voteModel = wrap(small, 'vote', SMALL_MODEL);
  promiseModel = wrap(small, 'promise', SMALL_MODEL);
}

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
  card: () => agentCard,
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
  if (!replyModel) return `${agentId}@${os.hostname()} 收到: ${text}`;
  const res = await replyModel.generate([
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
  if (!judgeModel) return false; // no LLM → cannot judge → stay silent
  const res = await judgeModel.generate([
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
    // 编码引擎优先：任务委派给真实 CLI 执行，产出是真实副作用而非空谈。
    if (coding.engine) {
      const started = Date.now();
      const enginePrompt = `你是 agent「${agentId}」${persona ? `（专长：${persona}）` : ''}，在工作目录中完成以下任务。\n${prompt}`;
      try {
        const result = await coding.engine.run({ prompt: enginePrompt, workdir: coding.workdir, timeoutMs: coding.timeoutMs });
        ledgerSink({ ts: started, agentId, purpose: 'task', model: `engine:${coding.engine.id}`, measured: false, latencyMs: result.durationMs, status: 'ok' });
        reply({ kind: 'task', taskId, action: 'submit', agent: agentId, evidence: result.text });
      } catch (err) {
        ledgerSink({ ts: started, agentId, purpose: 'task', model: `engine:${coding.engine.id}`, measured: false, latencyMs: Date.now() - started, status: 'error' });
        reply({ kind: 'task', taskId, action: 'failed', agent: agentId, error: String(err) });
      }
      return;
    }
    const answer = taskModel
      ? stripThink((await taskModel.generate([
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
  if (!voteModel || options.length === 0) {
    reply({ kind: 'decision', decisionId, option: '', rationale: '无法投票' });
    return;
  }
  const optLines = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  try {
    const res = await voteModel.generate([
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
  if (!promiseModel) {
    reply({ kind: 'promise', promiseId, confirm: false, note: '无 LLM，不轻诺' });
    return;
  }
  try {
    const res = await promiseModel.generate([
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
  // 结构化电源通道：{kind:'power', action:'on'|'off'|'status'}
  if (payload && typeof payload === 'object' && 'kind' in payload && payload.kind === 'power') {
    if (!powerHost) {
      reply({ ok: false, error: 'power control not configured' });
      return;
    }
    const action = 'action' in payload && typeof payload.action === 'string' ? payload.action : '';
    if (action !== 'on' && action !== 'off' && action !== 'status') {
      reply({ ok: false, error: `unknown action: ${action}` });
      return;
    }
    try {
      reply({ ok: true, result: await powerExecute(powerHost, action as PowerAction) });
    } catch (err) {
      reply({ ok: false, error: String(err) });
    }
    return;
  }
  const text = extractText(payload);
  const ctx = payload && typeof payload === 'object' ? extractContext(payload) : [];
  console.log(`[${agentId}] request: ${text.slice(0, 120)}`);
  // 聊天里的电源意图（@ 点名路径）：确定性匹配，优先于 LLM
  if (powerHost) {
    const action = matchPowerIntent(text, powerHost);
    if (action) {
      console.log(`[${agentId}] power intent: ${action}`);
      try {
        reply({ agent: agentId, host: os.hostname(), text: await powerExecute(powerHost, action) });
      } catch (err) {
        reply({ agent: agentId, host: os.hostname(), error: String(err) });
      }
      return;
    }
  }
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

  // 电源意图：确定性短路，不过 judge（关机不该由小脑裁量）
  if (powerHost) {
    const action = matchPowerIntent(text, powerHost);
    if (action) {
      console.log(`[${agentId}] power intent: ${action}`);
      const result = await powerExecute(powerHost, action).catch((err) => `电源操作失败: ${String(err)}`);
      await speak(room, result, extractContext(p)).catch((err) => console.log(`[${agentId}] speak failed: ${String(err).slice(0, 120)}`));
      return;
    }
  }

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
