// =============================================================================
// registry-gates.test.ts — 协调层闸门的 HTTP 级集成测试
// -----------------------------------------------------------------------------
// 目标：覆盖 createRegistryServer（src/plugins/agent-bus/http-transport.ts）
//       暴露的所有可观察闸门契约，确保 registry / 渠道 / 中继 / 广播的
//       状态机与节流门在重构后行为不回退。
//
// 范围说明：
//   - 测试时间预算 ≤ 3s（见 helpers.waitFor 默认 3s 上限）。
//   - 不测纯时间常量路径：
//       * sweeper 的 60s 周期 + 3 分钟 STALE_MS 驱逐
//       * 消息 TTL 5 分钟（MSG_TTL_MS）过期
//       * hold-token 的 120s 过期
//     这三段需 wall-clock 推进，在 3s 预算下不稳定，故以文档方式标注
//     而非端到端测试。
//
// 运行：
//   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs --test \
//     test/registry-gates.test.ts
//
// 已知设计张力（见 test 注释中标记 FINDING）：
//   - 速率地板（30/min）在 lapping 闸先于它触发的设计下基本被遮蔽；
//     单一 agent 的窗口内 30 次广播尝试（不论其它闸是否先触发）会让
//     rate 计数器 +1，第 31 次真正触达 rate 闸返回 429 reason='rate'。
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bootRegistry,
  postJson,
  getJson,
  pollMessages,
} from './helpers.js';
import type { TestRegistry } from './helpers.js';

// -----------------------------------------------------------------------------
// 类型守卫：用 'in' / typeof 收窄 JSON 响应后再访问字段，避免 unchecked cast
// -----------------------------------------------------------------------------
function hasField<K extends string>(
  value: unknown,
  field: K,
): value is Record<K, unknown> {
  return typeof value === 'object' && value !== null && field in value;
}

interface HeldResponse {
  held: true;
  reason: string;
  unseen?: unknown[];
  token?: string;
}

function isErrorResponse(value: unknown): value is { error: string } {
  return hasField(value, 'error') && typeof value.error === 'string';
}

function isHeldResponse(value: unknown): value is HeldResponse {
  return (
    hasField(value, 'held') &&
    value.held === true &&
    hasField(value, 'reason') &&
    typeof value.reason === 'string'
  );
}

// 多处复用：把 held 响应里的 reason / unseen / token 抽出来，同时给出失败时的可读信息
function getHeldReason(body: unknown): string {
  assert.ok(isHeldResponse(body), `expected held response, got ${JSON.stringify(body)}`);
  return body.reason;
}

function getUnseen(body: unknown): unknown[] {
  assert.ok(isHeldResponse(body), `expected held response, got ${JSON.stringify(body)}`);
  return Array.isArray(body.unseen) ? body.unseen : [];
}

function getHoldToken(body: unknown): string {
  assert.ok(isHeldResponse(body), `expected held response, got ${JSON.stringify(body)}`);
  assert.ok(
    typeof body.token === 'string' && body.token.length > 0,
    `expected non-empty token, got ${JSON.stringify(body.token)}`,
  );
  return body.token;
}

function getErrorMessage(body: unknown): string {
  assert.ok(isErrorResponse(body), `expected error response, got ${JSON.stringify(body)}`);
  return body.error;
}

// 多用点的列表提取：把 hasField + Array.isArray + 字段类型断言合成一处
function getAgentsList(body: unknown): Array<{ agentId: string }> {
  assert.ok(hasField(body, 'agents'), `expected agents field, got ${JSON.stringify(body)}`);
  const agents = body.agents;
  assert.ok(Array.isArray(agents), `agents must be array, got ${JSON.stringify(agents)}`);
  return agents as Array<{ agentId: string }>;
}

function getMembersList(body: unknown): string[] {
  assert.ok(hasField(body, 'members'), `expected members field, got ${JSON.stringify(body)}`);
  const members = body.members;
  assert.ok(Array.isArray(members), 'members must be array');
  return members as string[];
}

function getChannelsList(body: unknown): Array<{ name: string; members: number }> {
  assert.ok(hasField(body, 'channels'), 'expected channels field');
  const ch = body.channels;
  assert.ok(Array.isArray(ch), 'channels must be array');
  return ch as Array<{ name: string; members: number }>;
}

interface MetricsBody {
  broadcasts: number;
  relays: number;
  evicted: number;
  held: Record<string, number>;
}

function getMetrics(body: unknown): MetricsBody {
  assert.ok(typeof body === 'object' && body !== null, 'metrics body must be object');
  const b = body as Record<string, unknown>;
  assert.equal(typeof b.broadcasts, 'number');
  assert.equal(typeof b.relays, 'number');
  assert.equal(typeof b.evicted, 'number');
  assert.ok(typeof b.held === 'object' && b.held !== null, 'held must be object');
  return {
    broadcasts: b.broadcasts as number,
    relays: b.relays as number,
    evicted: b.evicted as number,
    held: b.held as Record<string, number>,
  };
}

// -----------------------------------------------------------------------------
// 小工具：构造最小 BusMessage，并按测试需要叠加 channel / payload / holdToken
// -----------------------------------------------------------------------------
interface BcastOpts {
  human?: boolean;
  holdToken?: string;
  payload?: unknown;
}

function bcastMsg(
  from: string,
  channel: string,
  text: string,
  opts: BcastOpts = {},
): Record<string, unknown> {
  const basePayload: Record<string, unknown> = { text };
  if (opts.human) basePayload.human = true;
  const payload = opts.payload ?? basePayload;
  const msg: Record<string, unknown> = {
    id: `m-${Math.random().toString(36).slice(2)}`,
    type: 'event',
    from,
    to: 'broadcast',
    payload,
    channel,
    timestamp: Date.now(),
  };
  if (opts.holdToken) msg.holdToken = opts.holdToken;
  return msg;
}

function relayMsg(
  from: string,
  to: string,
  channel: string,
  payload: unknown,
): Record<string, unknown> {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    type: 'event',
    from,
    to,
    payload,
    channel,
    timestamp: Date.now(),
  };
}

async function registerAgent(reg: TestRegistry, agentId: string): Promise<void> {
  const r = await postJson(reg.url, '/register', {
    agentId,
    url: `http://127.0.0.1:9/${agentId}`,
  });
  assert.equal(r.status, 200);
}

async function listAgentIds(reg: TestRegistry): Promise<string[]> {
  return getAgentsList(await getJson(reg.url, '/agents')).map((a) => a.agentId);
}

async function channelMembers(reg: TestRegistry, channel: string): Promise<string[]> {
  return getMembersList(
    await getJson(reg.url, `/channels/members?channel=${encodeURIComponent(channel)}`),
  );
}

async function listChannelNames(reg: TestRegistry): Promise<string[]> {
  return getChannelsList(await getJson(reg.url, '/channels')).map((c) => c.name);
}

// =============================================================================
// 1. /register 自动加入 default 渠道；/agents 可见
// =============================================================================
test('register: POST /register 把 agent 加入 default 渠道并在 /agents 列出', async () => {
  // 保护契约：注册即入 default；agent 元数据可经 /agents 列出；
  // 重复注册同 id 不抛错，仅刷新 lastSeen。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'alpha');
    await registerAgent(reg, 'beta');

    const ids = (await listAgentIds(reg)).sort();
    assert.deepEqual(ids, ['alpha', 'beta']);

    // default 渠道应同时包含这两人
    const members = (await channelMembers(reg, 'default')).sort();
    assert.deepEqual(members, ['alpha', 'beta']);
  } finally {
    await reg.close();
  }
});

// =============================================================================
// 2. 渠道生命周期：create 幂等 / join / leave / delete 拒 default / members 404
// =============================================================================
test('channels/create 是幂等的：首次 created:true，重复 created:false，creator 自动加入', async () => {
  // 保护契约：create 接口幂等，且首次创建的 agent 自动加入新渠道。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'creator');

    const first = await postJson(reg.url, '/channels/create', {
      agentId: 'creator',
      channel: 'proj-a',
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true, created: true });

    const second = await postJson(reg.url, '/channels/create', {
      agentId: 'creator',
      channel: 'proj-a',
    });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { ok: true, created: false });

    const members = await channelMembers(reg, 'proj-a');
    assert.deepEqual(members, ['creator']);
  } finally {
    await reg.close();
  }
});

test('channels/join 不存在渠道 → 404', async () => {
  // 保护契约：join 必须在已有渠道上操作；缺失的渠道必须显式 404，
  // 避免被静默新建（与 create 的语义边界）。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'joiner');
    const r = await postJson(reg.url, '/channels/join', {
      agentId: 'joiner',
      channel: 'no-such-channel',
    });
    assert.equal(r.status, 404);
    assert.equal(getErrorMessage(r.body), 'Channel not found');
  } finally {
    await reg.close();
  }
});

test('channels/leave 把成员移出但保留渠道', async () => {
  // 保护契约：leave 只调整成员集，不删除渠道（与 delete 区分）。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'leaver');
    await postJson(reg.url, '/channels/create', { agentId: 'leaver', channel: 'room' });
    await postJson(reg.url, '/channels/leave', { agentId: 'leaver', channel: 'room' });

    const members = await channelMembers(reg, 'room');
    assert.deepEqual(members, []);

    // 渠道仍然存在
    const ch = await listChannelNames(reg);
    assert.ok(ch.includes('room'));
  } finally {
    await reg.close();
  }
});

test('channels/delete 拒绝删除 default 渠道', async () => {
  // 保护契约：default 是注册自动落点；任何尝试删除它必须显式 400，
  // 防止误操作把所有 agent 抛出广播可见集合。
  const reg = await bootRegistry();
  try {
    const r = await postJson(reg.url, '/channels/delete', { channel: 'default' });
    assert.equal(r.status, 400);
    assert.equal(getErrorMessage(r.body), 'Cannot delete default channel');

    // 校验 default 依然存在
    const ch = await listChannelNames(reg);
    assert.ok(ch.includes('default'));
  } finally {
    await reg.close();
  }
});

test('channels/members?channel=不存在 → 404', async () => {
  // 保护契约：成员查询走和 join 同样的渠道存在性门禁。
  const reg = await bootRegistry();
  try {
    const r = await fetch(`${reg.url}/channels/members?channel=ghost`);
    assert.equal(r.status, 404);
  } finally {
    await reg.close();
  }
});

// =============================================================================
// 3. /relay 隔离：发送者非成员 403、目标非成员 403、渠道不存在 404
// =============================================================================
test('relay: 发送者非渠道成员 → 403 "Sender not in channel"', async () => {
  // 保护契约：relay 的发送者必须是目标渠道成员；不满足则 403，
  // 保护既有成员免受外部冒名投递。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'member');
    await postJson(reg.url, '/channels/create', { agentId: 'member', channel: 'priv' });
    // outsider 未注册、也未加入 priv
    const r = await postJson(
      reg.url,
      '/relay',
      relayMsg('outsider', 'member', 'priv', { x: 1 }),
    );
    assert.equal(r.status, 403);
    assert.equal(getErrorMessage(r.body), 'Sender not in channel');
  } finally {
    await reg.close();
  }
});

test('relay: 目标非渠道成员 → 403 "Target not in channel"', async () => {
  // 保护契约：relay 的目标也必须在渠道内；防止消息发往不存在的 inbox。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'sender');
    await postJson(reg.url, '/channels/create', { agentId: 'sender', channel: 'priv' });
    const r = await postJson(
      reg.url,
      '/relay',
      relayMsg('sender', 'stranger', 'priv', { x: 1 }),
    );
    assert.equal(r.status, 403);
    assert.equal(getErrorMessage(r.body), 'Target not in channel');
  } finally {
    await reg.close();
  }
});

test('relay: 渠道不存在 → 404', async () => {
  // 保护契约：relay 引用未创建的渠道必须 404，而不是被静默路由到 default。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'a');
    const r = await postJson(
      reg.url,
      '/relay',
      relayMsg('a', 'a', 'phantom', { x: 1 }),
    );
    assert.equal(r.status, 404);
    assert.equal(getErrorMessage(r.body), 'Channel not found');
  } finally {
    await reg.close();
  }
});

test('relay: 合法发送者与目标，目标 /poll 可取到消息', async () => {
  // 保护契约：relay 把消息入队到目标 agent 的 inbox；目标下次 /poll 必须
  // 看到该消息且队列被清空（pull 语义）。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 's');
    await registerAgent(reg, 't');
    const r = await postJson(
      reg.url,
      '/relay',
      relayMsg('s', 't', 'default', { hello: 't' }),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { queued: true });

    const msgs = await pollMessages(reg.url, 't');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from, 's');
    assert.equal(msgs[0].to, 't');
    assert.deepEqual(msgs[0].payload, { hello: 't' });

    // pull 语义：再次 poll 应为空
    const empty = await pollMessages(reg.url, 't');
    assert.deepEqual(empty, []);
  } finally {
    await reg.close();
  }
});

// =============================================================================
// 4. /broadcast 只扇出给本渠道成员（别的渠道成员收不到）
// =============================================================================
test('broadcast: 消息仅扇出到本渠道成员，跨渠道不可见', async () => {
  // 保护契约：广播 fanout 仅触及消息 channel 的成员集；
  // 同 agent 在其他渠道收不到该消息；发送者自己也不会收到自己的广播。
  // 注意：/register 把所有 agent 自动加进 default 渠道——本测试把 d3 主动
  // 离开 default，再验证跨渠道隔离。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'd1');  // default
    await registerAgent(reg, 'd2');  // default
    await registerAgent(reg, 'd3');  // 之后会 leave default
    await postJson(reg.url, '/channels/create', { agentId: 'd3', channel: 'other' });
    await postJson(reg.url, '/channels/leave', { agentId: 'd3', channel: 'default' });

    // d1 在 default 广播
    const r = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('d1', 'default', 'visible-to-default'),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { queued: 1 });  // 只投给 d2

    // d2 收到；d3 收不到
    const d2 = await pollMessages(reg.url, 'd2');
    assert.equal(d2.length, 1);
    assert.deepEqual(d2[0].payload, { text: 'visible-to-default' });

    const d3 = await pollMessages(reg.url, 'd3');
    assert.deepEqual(d3, []);

    // d1 自己也不会回声（sender 排除）
    const d1 = await pollMessages(reg.url, 'd1');
    assert.deepEqual(d1, []);
  } finally {
    await reg.close();
  }
});

test('broadcast: 发送者非本渠道成员 → 403', async () => {
  // 保护契约：与 relay 一样，broadcast 要求发送者也是消息 channel 的成员。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'm');
    await postJson(reg.url, '/channels/create', { agentId: 'm', channel: 'c' });
    const r = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('stranger', 'c', 'nope'),
    );
    assert.equal(r.status, 403);
    assert.equal(getErrorMessage(r.body), 'Sender not in channel');
  } finally {
    await reg.close();
  }
});

// =============================================================================
// 5. verbatim-dup：同 (channel, from) 逐字重复广播 → 409 HELD reason=verbatim
// =============================================================================
test('broadcast verbatim-dup: 同 (channel, from) 逐字重复 → 409 HELD verbatim', async () => {
  // 保护契约：同 (channel, from) 的 payload 文本必须变化；逐字重复会浪费
  // 接收方注意力，因此用 verbatim 闸门显式 HELD。
  // 闸门顺序：rate → verbatim → freshness → lapping。
  // 单一发送者在 default 上：首次 OK，第二次会同时被 freshness / verbatim
  // 拦截——闸门顺序保证 verbatim 先于 freshness 触发。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'v');
    const first = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('v', 'default', 'same-text'),
    );
    assert.equal(first.status, 200);

    const second = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('v', 'default', 'same-text'),
    );
    assert.equal(second.status, 409);
    assert.equal(getHeldReason(second.body), 'verbatim');
  } finally {
    await reg.close();
  }
});

// =============================================================================
// 6. 速率地板：同 agent 1 分钟内 30 条广播后第 31 条 → 429
// =============================================================================
test('rate floor: 同 agent 60s 内 30 次广播后第 31 次 → 429', async () => {
  // 保护契约：rate 闸门是 (channel, from) 的固定 60s 滑动窗口；
  // 30/min 是单 agent 流量上限，第 31 次在窗口内必须 429。
  //
  // [FINDING] 闸门顺序 rate → verbatim → freshness → lapping 让 rate 计数器
  //   在每次被任何闸拦截的请求上 +1（包括被 freshness/lapping 拦的）。
  //   单纯让一个 agent 连发 30 条会被 freshness / lapping 先拦截，但
  //   rate 计数仍逐次递增；第 31 次在 rate 闸触发返回 429 reason='rate'。
  //   文档化的"30 条"指窗口内 30 次广播尝试（不论其它闸是否先触发）。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'r');
    await postJson(reg.url, '/channels/create', { agentId: 'r', channel: 'rate' });

    // 30 次广播，文本各异以避开 verbatim；每次都会被 freshness / lapping 拦截
    // 但 rate 计数器会逐次 +1
    for (let i = 0; i < 30; i++) {
      const r = await postJson(
        reg.url,
        '/broadcast',
        bcastMsg('r', 'rate', `text-${i}`),
      );
      // 只校验是 200/409/429（HELD），不应有 4xx 其它错误码
      assert.ok(
        r.status === 200 || r.status === 409 || r.status === 429,
        `iteration ${i}: unexpected status ${r.status}`,
      );
    }

    // 31st 必须在 rate 闸触发
    const r31 = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r', 'rate', 'text-31'),
    );
    assert.equal(r31.status, 429);
    assert.equal(getHeldReason(r31.body), 'rate');
  } finally {
    await reg.close();
  }
});

// =============================================================================
// 7. lapping（无人类）：单 speaker cap=1 → 第 2 次 HELD
// =============================================================================
test('lapping（无人类）: 单一 speaker 第二次广播必 HELD', async () => {
  // 保护契约：无人类在场时，每个 round 内的 cap = distinct speakers；
  // 单 speaker 必然 cap=1，agentMsgs 第一次 0→1 通过，第二次 1+1>1 → HELD。
  // 这是防止单 agent 独白的核心门。
  //
  // 闸门顺序 rate → verbatim → freshness → lapping：单 speaker 第二次广播
  // 会先被 freshness 拦截（sender 自身从不被 fanout 触及，/poll 才能推进 seen）。
  // 为让 lapping 闸真正拦截，需要在两次广播之间 poll 把 seen 拉到 st.seq=1。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'l');
    await registerAgent(reg, 'l-helper');
    await postJson(reg.url, '/channels/create', { agentId: 'l', channel: 'lap' });
    await postJson(reg.url, '/channels/join', { agentId: 'l-helper', channel: 'lap' });

    // 第一次 bcast：成功（cap=1, agentMsgs=0→1, st.seq=1）
    const first = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('l', 'lap', 'first'),
    );
    assert.equal(first.status, 200, `expected 200, got ${first.status}: ${JSON.stringify(first.body)}`);

    // l 拉一次（拉空，但推进 l 自己的 seen 到 st.seq=1）——其实 sender 自身
    // 永远不会被 fanout 触及，所以这条无效果。改为 l-helper 拉一次以
    // 推进 l-helper 自己的 seen。
    await pollMessages(reg.url, 'l-helper');
    // 现在 l-helper 的 seen=1，st.seq=1 → freshness 通过
    // 第三次 bcast：l-helper 第一次广播（cap 从 1 升到 2，agentMsgs=1+1=2 ≤ 2）
    const helperFirst = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('l-helper', 'lap', 'unread-for-l'),
    );
    assert.equal(helperFirst.status, 200, `helper first bcast must succeed, got ${helperFirst.status}: ${JSON.stringify(helperFirst.body)}`);
    // l 拉取 l-helper 的未读，推进 l 自己的 seen 到 st.seq=2
    await pollMessages(reg.url, 'l');
    // helper 也要拉一次（l 的 first msg 在 helper 队列中），让 helper 自己的
    // seen 跟 st.seq 同步，方便后续动作
    // 第二次 bcast：freshness 通过（seen=st.seq），verbatim 通过（新文本），
    // lapping 拦截：agentMsgs=1, cap=1（l 仍在 speakers 但未新增，cap 不变），1+1>1 → 429
    const second = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('l', 'lap', 'second'),
    );
    assert.equal(second.status, 429, `expected 429, got ${second.status}: ${JSON.stringify(second.body)}`);
    assert.equal(getHeldReason(second.body), 'lapping');
  } finally {
    await reg.close();
  }
});

test('lapping: 人类 broadcast 后 agentMsgs/speakers 计数重置', async () => {
  // 保护契约：人类是循环 resetter；payload.human === true 的广播
  // 清零 agentMsgs + speakers + lastHumanAt，并触发 rounds 自适应 cap。
  // 重置后同一 agent 可再次广播。
  //
  // [FINDING] 单一 agent 单独在渠道时无法通过 /poll 推进 seen（sender 被
  //   fanout 排除），所以本测试必须引入第二个 agent 制造可消费的未读，
  //   让被测 agent 拉取后 seen 与 st.seq 同步。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'a');
    await registerAgent(reg, 'b');
    await postJson(reg.url, '/channels/create', { agentId: 'a', channel: 'reset' });
    await postJson(reg.url, '/channels/join', { agentId: 'b', channel: 'reset' });

    // 1) a 广播（建立 agentMsgs=1, speakers={a}, st.seq=1）
    await postJson(reg.url, '/broadcast', bcastMsg('a', 'reset', 'agent-msg'));

    // 2) b 拉取以推进 b 自己的 seen，让 b 的下次 bcast 不会撞 freshness
    await pollMessages(reg.url, 'b');

    // 3) b 用 human payload 广播——重置 agentMsgs=0, speakers={}, lastHumanAt=now
    const human = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('b', 'reset', 'human-msg', { human: true }),
    );
    assert.equal(human.status, 200, 'human broadcast must succeed');

    // 4) a 拉取以推进 a 的 seen（消费掉 b 的 human-msg）
    await pollMessages(reg.url, 'a');

    // 5) a 再次广播：freshness 通过（seen=st.seq），verbatim 通过（不同文本），
    //    lapping 在 humanPresent 分支 cap=6（rounds.length<3），0+1=1 ≤ 6 → OK
    const after = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('a', 'reset', 'after-reset'),
    );
    assert.equal(after.status, 200, `single speaker after human reset must pass, got ${after.status}: ${JSON.stringify(after.body)}`);
  } finally {
    await reg.close();
  }
});

// =============================================================================
// 8. seen-cursor：未读 agent 广播 → 409 HELD freshness 且响应内联未读
// =============================================================================
test('freshness: agent 在有未读消息时广播 → 409 HELD 且内联 unseen', async () => {
  // 保护契约：seen-cursor 是 server 端强一致事实（cumora §2.2.1）：
  // 当 (agent, channel) 的 seen < st.seq 时，agent 必须先消费未读；
  // HELD 响应必须内联 unseen 内容，让客户端能 inline 展示，避免再 round-trip。
  // HELD 时 seen 推进到 st.seq，防止自循环。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'writer');
    await registerAgent(reg, 'reader');
    await postJson(reg.url, '/channels/create', { agentId: 'writer', channel: 'f' });
    await postJson(reg.url, '/channels/join', { agentId: 'reader', channel: 'f' });

    // writer 写一条，reader 的 inbox 收到未投递
    const seed = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('writer', 'f', 'unread-for-reader'),
    );
    assert.equal(seed.status, 200);

    // reader 不 poll，直接 broadcast：必 HELD freshness 且 unseen 非空
    const held = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('reader', 'f', 'reader-msg'),
    );
    assert.equal(held.status, 409);
    assert.equal(getHeldReason(held.body), 'freshness');
    const unseen = getUnseen(held.body);
    assert.ok(unseen.length >= 1, 'unseen must include the unread message');
    const token = getHoldToken(held.body);
    assert.ok(token.length > 0, 'freshness HELD issues hold-token');
    // unseen 不应包含 reader 自己的消息
    for (const entry of unseen) {
      if (hasField(entry, 'from')) {
        assert.notEqual(entry.from, 'reader', 'unseen must not include reader own messages');
      }
    }
  } finally {
    await reg.close();
  }
});

test('freshness: /poll 消费未读后 agent 可再广播', async () => {
  // 保护契约：/poll 既拉消息又推进 seen 游标；消费后 freshness 闸通过。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'w');
    await registerAgent(reg, 'r');
    await postJson(reg.url, '/channels/create', { agentId: 'w', channel: 'p' });
    await postJson(reg.url, '/channels/join', { agentId: 'r', channel: 'p' });

    await postJson(reg.url, '/broadcast', bcastMsg('w', 'p', 'hi'));
    // 不 poll 直接 bcast 必 HELD
    const blocked = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r', 'p', 'reply'),
    );
    assert.equal(blocked.status, 409);
    assert.equal(getHeldReason(blocked.body), 'freshness');

    // /poll 消费
    const drained = await pollMessages(reg.url, 'r');
    assert.ok(drained.length >= 1);

    // 再 bcast 应通过 freshness（r 是新 speaker，cap 从 1 升到 2）
    const ok = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r', 'p', 'reply-now'),
    );
    assert.equal(ok.status, 200, `expected 200 after poll, got ${ok.status}: ${JSON.stringify(ok.body)}`);
  } finally {
    await reg.close();
  }
});

// =============================================================================
// 9. hold-token / override：token 绑定 seq、120s TTL（不测过期）、单次消费
// =============================================================================
test('hold-token: 正确 token 一次性通过 freshness 闸', async () => {
  // 保护契约：freshness HELD 颁发的 token 绑定当时的 st.seq；
  // 同 seq、token 匹配、未过期时，broadcast 携带 holdToken 可通过 freshness 闸。
  // 闸门顺序保证：override 必须在 rate/verbatim 之后、lapping 之前生效。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'w');
    await registerAgent(reg, 'r');
    await postJson(reg.url, '/channels/create', { agentId: 'w', channel: 'h' });
    await postJson(reg.url, '/channels/join', { agentId: 'r', channel: 'h' });

    // w 写入让 r 看到未读
    await postJson(reg.url, '/broadcast', bcastMsg('w', 'h', 'unread'));

    // r 首次 bcast → HELD freshness，拿到 token
    const held = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r', 'h', 'first-try'),
    );
    assert.equal(held.status, 409);
    const token = getHoldToken(held.body);

    // r 用 token 再 bcast → 应当 override 通过 freshness
    // 同样需要 cap 充足：r 是新 speaker，cap 从 1 升到 2
    const over = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r', 'h', 'override-ok', { holdToken: token }),
    );
    assert.equal(over.status, 200, `override must succeed: ${JSON.stringify(over.body)}`);
  } finally {
    await reg.close();
  }
});

test('hold-token: 同一 token 第二次使用 → 已被消费，闸仍触发', async () => {
  // 保护契约：token 是 single-use——任何带 holdToken 的请求触发 holds.delete；
  // 重用时 holds 中已无该 token，override 失败，freshness 闸重新触发。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'w');
    await registerAgent(reg, 'r');
    await postJson(reg.url, '/channels/create', { agentId: 'w', channel: 's' });
    await postJson(reg.url, '/channels/join', { agentId: 'r', channel: 's' });

    await postJson(reg.url, '/broadcast', bcastMsg('w', 's', 'm1'));

    // 拿 token
    const held = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r', 's', 'probe'),
    );
    assert.equal(held.status, 409);
    const token = getHoldToken(held.body);

    // drain
    await pollMessages(reg.url, 'r');
    // 再制造未读
    await postJson(reg.url, '/broadcast', bcastMsg('w', 's', 'm2'));
    // 第一次用 token 应通过（消耗 token）
    const firstUse = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r', 's', 'use-1', { holdToken: token }),
    );
    assert.equal(firstUse.status, 200, `first token use must succeed: ${JSON.stringify(firstUse.body)}`);

    // drain
    await pollMessages(reg.url, 'r');
    // 再次制造未读
    await postJson(reg.url, '/broadcast', bcastMsg('w', 's', 'm3'));

    // 第二次用同一 token → 已消费，必 HELD（不能通过 override）
    const secondUse = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r', 's', 'use-2', { holdToken: token }),
    );
    assert.equal(secondUse.status, 409, 'second use of same token must HELD');
    assert.equal(getHeldReason(secondUse.body), 'freshness');
  } finally {
    await reg.close();
  }
});

test('hold-token: 错 seq 的 token（st.seq 已推进）→ override 拒绝', async () => {
  // 保护契约：token 与颁发时的 st.seq 绑定；其它 agent 推进 st.seq 后，
  // 旧 token 的 held0.seq !== st.seq → overrideOk=false → 闸仍触发。
  // （TTL 过期路径需要 wall-clock 推进，120s 超 3s 测试预算，不在此测。）
  //
  // [FINDING] 单一 bcast 很难推进 st.seq（单 speaker cap=1 + 自身 freshness 拦）。
  //   引入第三方 speaker 拉高 cap 后再用 token 验证 seq 失配分支。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'w');
    await registerAgent(reg, 'r');
    await registerAgent(reg, 'r2');
    await postJson(reg.url, '/channels/create', { agentId: 'w', channel: 'q' });
    await postJson(reg.url, '/channels/join', { agentId: 'r', channel: 'q' });
    await postJson(reg.url, '/channels/join', { agentId: 'r2', channel: 'q' });

    // w 写入让 r 有未读 → r 拿到 token
    await postJson(reg.url, '/broadcast', bcastMsg('w', 'q', 'm1'));
    const held = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r', 'q', 'probe'),
    );
    assert.equal(held.status, 409);
    const tokenV1 = getHoldToken(held.body);

    // drain r 后让 r 用 tokenV1 通过（消耗，并让 r 进 speakers）
    await pollMessages(reg.url, 'r');
    const firstUse = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r', 'q', 'use-v1', { holdToken: tokenV1 }),
    );
    assert.equal(firstUse.status, 200, `first use of v1 must succeed: ${JSON.stringify(firstUse.body)}`);

    // drain r 后再造未读 → r 拿 tokenV2
    await pollMessages(reg.url, 'r');
    await postJson(reg.url, '/broadcast', bcastMsg('w', 'q', 'm2'));
    const held2 = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r', 'q', 'probe-2'),
    );
    assert.equal(held2.status, 409);
    const tokenV2 = getHoldToken(held2.body);

    // 让 r2 先 poll 并 bcast 一次以推进 st.seq
    await pollMessages(reg.url, 'r2');
    const r2bcast = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r2', 'q', 'r2-msg'),
    );
    assert.equal(r2bcast.status, 200, `r2 bcast must succeed: ${JSON.stringify(r2bcast.body)}`);

    // drain r 后用 tokenV2：seq 已变，override 必失败
    await pollMessages(reg.url, 'r');
    const stale = await postJson(
      reg.url,
      '/broadcast',
      bcastMsg('r', 'q', 'stale-attempt', { holdToken: tokenV2 }),
    );
    // 关键断言：200 表示 token 静默通过——这里不应 200
    if (stale.status === 200) {
      assert.fail(
        `stale token (wrong seq) must not silently pass; got 200: ${JSON.stringify(stale.body)}`,
      );
    }
    // 应是 409 (freshness) 或 429 (lapping)
    assert.ok(stale.status === 409 || stale.status === 429, `unexpected status ${stale.status}`);
    if (stale.status === 409) {
      const reason = getHeldReason(stale.body);
      assert.ok(
        reason === 'freshness' || reason === 'lapping',
        `unexpected reason: ${reason}`,
      );
    } else {
      assert.equal(getHeldReason(stale.body), 'lapping');
    }
  } finally {
    await reg.close();
  }
});

// =============================================================================
// 10. /metrics 计数器随 HELD 事件增长
// =============================================================================
test('metrics: 每次 HELD 事件递增对应 held.<reason> 计数', async () => {
  // 保护契约：/metrics 是 gate observability（cumora §7.3）的唯一窗口；
  // 任何 HELD 响应必须递增对应 reason 计数（rate/verbatim/freshness/lapping/
  // hard_cap），保证 dashboard 能发现门触发频率。
  const reg = await bootRegistry();
  try {
    await registerAgent(reg, 'm1');
    await postJson(reg.url, '/channels/create', { agentId: 'm1', channel: 'met' });

    const before = getMetrics(await getJson(reg.url, '/metrics'));

    // 触发 verbatim：同 agent 重复文本
    await postJson(reg.url, '/broadcast', bcastMsg('m1', 'met', 'dup'));
    await postJson(reg.url, '/broadcast', bcastMsg('m1', 'met', 'dup'));

    // 触发 freshness：先有别 agent 写入让 m1 未读
    await registerAgent(reg, 'm2');
    await postJson(reg.url, '/channels/join', { agentId: 'm2', channel: 'met' });
    await postJson(reg.url, '/broadcast', bcastMsg('m2', 'met', 'for-m1'));
    // m1 不 poll 直接 bcast → freshness
    await postJson(reg.url, '/broadcast', bcastMsg('m1', 'met', 'while-unread'));

    const after = getMetrics(await getJson(reg.url, '/metrics'));

    // verbatim 至少 +1
    assert.ok(
      (after.held.verbatim ?? 0) >= (before.held.verbatim ?? 0) + 1,
      `verbatim counter must increment: before=${before.held.verbatim} after=${after.held.verbatim}`,
    );
    // freshness 至少 +1
    assert.ok(
      (after.held.freshness ?? 0) >= (before.held.freshness ?? 0) + 1,
      `freshness counter must increment: before=${before.held.freshness} after=${after.held.freshness}`,
    );
    // broadcasts 至少 +1（m2 那条成功）
    assert.ok(
      after.broadcasts >= before.broadcasts + 1,
      `broadcasts must increment: before=${before.broadcasts} after=${after.broadcasts}`,
    );
  } finally {
    await reg.close();
  }
});

test('BUS_TOKEN 鉴权 + 注册失败响亮退出（可观测性契约）', async () => {
  // 带 token 的 registry：无 token 的 transport connect() 必须抛错
  // （修复前：401 被静默吞掉，agent 日志照常打 "joined channel" 僵尸在线）
  const { createRegistryServer } = await import('../src/plugins/agent-bus/http-transport.js');
  const { HttpTransport } = await import('../src/plugins/agent-bus/http-transport.js');
  const server = createRegistryServer(0, { token: 'secret-token' });
  await new Promise<void>((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;

  const noToken = new HttpTransport({ agentId: 'bad-agent', registryUrl: url });
  await assert.rejects(noToken.connect(), /401|Unauthorized/i, '无 token 必须 connect 失败');
  await noToken.disconnect();

  const withToken = new HttpTransport({ agentId: 'good-agent', registryUrl: url, registryToken: 'secret-token' });
  await withToken.connect();
  const agents = (await (await fetch(`${url}/agents`, { headers: { 'x-bus-token': 'secret-token' } })).json()) as { agents: Array<{ agentId: string }> };
  assert.ok(agents.agents.some((a) => a.agentId === 'good-agent'), '带 token 注册成功');
  await withToken.disconnect();
  server.close();
});
