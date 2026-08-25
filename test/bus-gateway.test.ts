// BusGateway 契约测试：focus window 闸门、token 预算 context、
// principles 回流、房间历史惰性加载。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BusGateway, RoomMessage } from '../src/appserver/bus-gateway.js';
import type { BusMessage } from '../src/plugins/agent-bus/bus.js';
import { bootRegistry, postJson, pollMessages, joinChannel, roomMsg, waitFor, type TestRegistry } from './helpers.js';

const chatText = (m: BusMessage): string => {
  const p = m.payload;
  return p && typeof p === 'object' && 'text' in p && typeof p.text === 'string' ? p.text : '';
};
const chatContext = (m: BusMessage): string[] => {
  const p = m.payload;
  return p && typeof p === 'object' && 'context' in p && Array.isArray(p.context) ? (p.context as string[]) : [];
};

interface GatewayFixture {
  gateway: BusGateway;
  reg: TestRegistry;
  focused: Set<string>;
  sent: RoomMessage[];
}

async function makeGateway(overrides: {
  focused?: string[];
  contextTokens?: number;
  principles?: string[];
  seedHistory?: RoomMessage[];
} = {}): Promise<GatewayFixture> {
  const reg = await bootRegistry();
  const focused = new Set(overrides.focused ?? []);
  const sent: RoomMessage[] = [];
  const gateway = new BusGateway({
    agentId: 'web-gateway',
    registryUrl: reg.url,
    channels: [],
    contextTokens: overrides.contextTokens ?? 3000,
    isFocused: (id) => focused.has(id),
    loadPrinciples: () => overrides.principles ?? [],
    store: { insert: (m) => sent.push(m), load: () => [...(overrides.seedHistory ?? [])] },
  });
  await gateway.createRoom('test-room');
  return { gateway, reg, focused, sent };
}

test('focus window: 专注 agent 被跳过，消息进摘要；非专注正常 relay', async (t) => {
  const { reg, focused } = await makeGateway({ focused: ['agent-b'] });
  t.after(() => reg.close());
  await joinChannel(reg.url, 'test-room', 'agent-a');
  await joinChannel(reg.url, 'test-room', 'agent-b');

  const gw = new BusGateway({
    agentId: 'web-gateway', registryUrl: reg.url, channels: [],
    isFocused: (id) => focused.has(id),
    store: { insert: () => {}, load: () => [] },
  });
  // createRoom 幂等，gateway 已在渠道内（上方 makeGateway 的实例）——此实例仅发消息
  const r = await gw.sendChat('test-room', 'focus 测试消息');
  assert.deepEqual(r.delivered, ['agent-a'], 'delivered 只含非专注成员');

  const msgsA = await pollMessages(reg.url, 'agent-a');
  assert.equal(msgsA.length, 1, 'agent-a 收到 relay 事件');
  const msgsB = await pollMessages(reg.url, 'agent-b');
  assert.equal(msgsB.length, 0, 'agent-b 队列空——消息进了摘要');
  await gw.disconnect();
});

test('focus window: 窗口结束 flush，摘要含被闸消息；@直聊永不拦截', async (t) => {
  const reg = await bootRegistry();
  t.after(() => reg.close());
  await joinChannel(reg.url, 'test-room', 'agent-a');
  await joinChannel(reg.url, 'test-room', 'agent-b');
  const focused = new Set(['agent-b']);
  const gw = new BusGateway({
    agentId: 'web-gateway', registryUrl: reg.url, channels: [],
    isFocused: (id) => focused.has(id),
    // 假 agent 永不应答；短超时防 pending 计时器拖住测试进程
    requestTimeoutMs: 400,
    store: { insert: () => {}, load: () => [] },
  });
  await gw.createRoom('test-room'); // 发送者必须在渠道内，否则 relay 403

  await gw.sendChat('test-room', '这条应进摘要');
  assert.equal((await pollMessages(reg.url, 'agent-b')).length, 0);

  // @直聊：sendChat 立即返回（request 不 await），闸门断言只依赖「未走摘要路径」
  await gw.sendChat('test-room', '@agent-b 直聊').catch(() => ({ delivered: [] as string[] }));
  // agent-b 队列里不应出现「摘要事件」（request 是否已入队与定时无关，every 断言安全）
  const directMsgs = await pollMessages(reg.url, 'agent-b');
  assert.ok(directMsgs.every((m) => !chatText(m).includes('专注窗口结束')), '直聊期间不触发摘要');

  // 窗口结束 → flush
  focused.clear();
  const flushed = await gw.flushDigests('test-room');
  assert.ok(flushed.includes('agent-b'), 'flush 返回 agent-b');
  const msgsB = await pollMessages(reg.url, 'agent-b');
  const digest = msgsB.find((m) => chatText(m).includes('专注窗口结束'));
  assert.ok(digest, 'agent-b 收到摘要事件');
  assert.ok(chatText(digest!).includes('这条应进摘要'), '摘要含被闸消息原文');
  await gw.disconnect();
});

test('token 预算: 超预算省略显式报数，历史在预算内截断', async (t) => {
  const seed: RoomMessage[] = Array.from({ length: 8 }, (_, i) =>
    roomMsg('test-room', `user${i}`, `第${i}条历史消息，内容比较长，用来消耗上下文预算额度。`));
  const { reg } = await makeGateway({ contextTokens: 40, seedHistory: seed });
  t.after(() => reg.close());
  await joinChannel(reg.url, 'test-room', 'agent-a');
  const gw = new BusGateway({
    agentId: 'web-gateway', registryUrl: reg.url, channels: [], contextTokens: 40,
    store: { insert: () => {}, load: () => [...seed] },
  });
  await gw.sendChat('test-room', '新消息');
  const msgsA = await pollMessages(reg.url, 'agent-a');
  const ctx = chatContext(msgsA[0]);
  const joined = ctx.join('\n');
  assert.ok(joined.includes('省略了更早的'), '带省略标记');
  assert.ok(ctx.length < seed.length + 3, '行数受预算限制');
  await gw.disconnect();
});

test('principles 回流: 晋升原则注入 context 头部，计入预算', async (t) => {
  const { reg } = await makeGateway({ principles: ['先写完成定义再开工', '附和是噪声'] });
  t.after(() => reg.close());
  await joinChannel(reg.url, 'test-room', 'agent-a');
  const gw = new BusGateway({
    agentId: 'web-gateway', registryUrl: reg.url, channels: [],
    loadPrinciples: () => ['先写完成定义再开工', '附和是噪声'],
    store: { insert: () => {}, load: () => [] },
  });
  await gw.sendChat('test-room', '带原则的消息');
  const msgsA = await pollMessages(reg.url, 'agent-a');
  const ctx = chatContext(msgsA[0]);
  assert.ok(ctx[0].includes('已验证的原则'), '首行是原则块');
  assert.ok(ctx[0].includes('先写完成定义再开工') && ctx[0].includes('附和是噪声'), '原则完整注入');
  assert.ok(ctx.some((l) => l.includes('带原则的消息')), '历史消息在原则之后');
  await gw.disconnect();
});

test('房间历史惰性加载: 首次访问是 emit 也能恢复持久化历史', async (t) => {
  // 契约: getHistory 每房恰好加载一次 store；先发消息再读历史，顺序仍是旧→新
  const persisted = [roomMsg('test-room', 'old-user', '重启前的持久化消息')];
  const { reg } = await makeGateway({ seedHistory: persisted });
  t.after(() => reg.close());
  await joinChannel(reg.url, 'test-room', 'agent-a');
  const gw = new BusGateway({
    agentId: 'web-gateway', registryUrl: reg.url, channels: [],
    store: { insert: () => {}, load: () => [...persisted] },
  });
  await gw.sendChat('test-room', '重启后的第一条'); // emit 先于任何 getHistory
  const history = gw.getHistory('test-room');
  assert.equal(history.length, 2);
  assert.equal(history[0].text, '重启前的持久化消息', '持久化历史在前');
  assert.equal(history[1].text, '重启后的第一条', '新消息在后');
  await gw.disconnect();
});

test('presence: startPresence 定时器存在；未 connect 时不崩溃；defensive dispose', async (t) => {
  const reg = await bootRegistry();
  t.after(() => reg.close());
  // 不 connect — startPresence 自身 lazy 触发第一次 tick，第一次 tick 内 fetchAgents
  // 会失败但不应抛给调用方。后续 timer 也无副作用。
  const gw = new BusGateway({ agentId: 'web-gateway', registryUrl: reg.url, channels: ['test-room'] });
  gw.startPresence({ intervalMs: 60_000 });
  // 此时立刻 stop——不应抛。
  await gw.disconnect();
  // 二次 disconnect：clearInterval(undefined) 必须 no-op。
  await gw.disconnect();
});

test('presence: getPresence 仅报新鲜 agent 在线；缺成员过滤；变化才通知', async (t) => {
  const reg = await bootRegistry();
  t.after(() => reg.close());
  await gw_createChannel(reg.url, 'test-room');
  // agent-fresh 注册了（lastSeen=now） → 应在线
  await joinChannel(reg.url, 'test-room', 'agent-fresh');
  // agent-stale 仅加入渠道未注册 → /agents 不含 → 不在线
  await postJson(reg.url, '/channels/join', { channel: 'test-room', agentId: 'agent-stale' });
  // 让注册时间稍早，确保 ONLINE_WINDOW_MS (60s) 边界外——伪造一个旧 lastSeen:
  // 通过注册后立即调用 /poll 拿到的 lastSeen 是 now；这里改用「不注册」模型更稳。

  const gw = new BusGateway({ agentId: 'web-gateway', registryUrl: reg.url, channels: ['test-room'] });
  // 不调 connect——presence 完全靠 fetchAgents+listMembers，无需 bus。

  // ① 单点查询 getPresence：online 只含已注册 agent（注册即新鲜）；
  // agent-stale 仅加入渠道未注册 → /agents 不含 → 不在线
  const snap = await gw.getPresence('test-room');
  assert.equal(snap.room, 'test-room');
  assert.deepEqual(snap.members.sort(), ['agent-fresh', 'agent-stale', 'web-gateway']);
  assert.deepEqual(snap.online, ['agent-fresh'], '仅注册的 agent-fresh 在线');

  // ② startPresence 后第一次 tick 必须触发 listener（成员集首次入缓存）
  const events: Array<{ members: string[]; online: string[] }> = [];
  gw.onPresence((p) => events.push({ members: [...p.members], online: [...p.online] }));
  gw.startPresence({ intervalMs: 60_000 });
  // 等一拍微任务让暖场 fetch 落地
  await new Promise<void>((resolve) => setImmediate(resolve));
  await waitFor(() => events.length >= 1, 2000);
  assert.equal(events.length, 1, '首次 tick 必发一次（首次入缓存）');
  assert.deepEqual(events[0].online, ['agent-fresh']);


  // ③ 触发第二次 tick——状态未变，不应再发
  await gw.presenceTick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1, '同状态第二次 tick 不重复通知');
  // ④ 状态变化：注册 agent-stale（lastSeen=now），再次 tick → 应再发一次且 online 含三者
  await joinChannel(reg.url, 'test-room', 'agent-stale'); // 注册+加入（joinChannel 已含 register）
  await gw.presenceTick();
  await waitFor(() => events.length >= 2, 2000);
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].online.sort(), ['agent-fresh', 'agent-stale'], '注册 agent-stale 后加入 online');


  // ⑤ disconnect 清 timer + 清缓存；再次 presenceTick 必须重置首帧
  await gw.disconnect();
  await gw.presenceTick();
  await waitFor(() => events.length >= 3, 2000);
  assert.equal(events.length, 3, 'disconnect 后首帧必通知');
});

test('presence: getAgentLastSeen 缓存最近一次 sweep 值；未知 agent 返回 null', async (t) => {
  const reg = await bootRegistry();
  t.after(() => reg.close());
  await joinChannel(reg.url, 'test-room', 'agent-x');
  const gw = new BusGateway({ agentId: 'web-gateway', registryUrl: reg.url, channels: ['test-room'] });
  // 未启动 presence 之前：缓存空
  assert.equal(gw.getAgentLastSeen('agent-x'), null, '未 sweep 时 null');
  gw.startPresence({ intervalMs: 60_000 });
  await gw.presenceTick();
  const ts = gw.getAgentLastSeen('agent-x');
  assert.ok(typeof ts === 'number' && ts > 0, 'sweep 后返回 epoch ms');
  assert.equal(gw.getAgentLastSeen('not-registered'), null);
  await gw.disconnect();
});

async function gw_createChannel(url: string, name: string): Promise<void> {
  const res = await postJson(url, '/channels/create', { channel: name, agentId: 'web-gateway' });
  if (res.status !== 200) throw new Error(`create channel failed: ${res.status}`);
}

// ── Config fanout (settings UI, contract §3) ──
// 策略：monkey-patch gateway.bus.request 用异步表查 payload.kind/action；
// 无须搭假 agent 服务端。覆盖：解析、超时、错回复、空房间、set 路径、自身配置读写。

// 单成员拉取合法 config；reply 形状错配时 config=null 但 transport 正常
test('getAgentConfigs: 单 agent 合法回复 + 形状错配均不回 throw', async (t) => {
  const { gateway, reg } = await makeGateway();
  t.after(() => reg.close());
  await joinChannel(reg.url, 'test-room', 'agent-x');

  const gw = gateway as unknown as { bus: { request(to: unknown, payload: unknown): Promise<unknown> } };
  const original = gw.bus.request.bind(gw.bus);

  gw.bus.request = async (to, payload) => {
    if (isConfigGet(payload)) {
      return { kind: 'config', agent: to, host: 'h1', persona: '擅长 A', model: 'big', modelSmall: 'small', channel: 'team' };
    }
    return original(to, payload);
  };
  const rows = await gateway.getAgentConfigs('test-room');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, 'agent-x');
  assert.equal(rows[0].error, null);
  assert.equal(rows[0].online, false, '无 presence sweep → 全离线');
  if (!rows[0].config) throw new Error('config 应被填充');
  assert.deepEqual(rows[0].config, {
    kind: 'config', agent: 'agent-x', host: 'h1', persona: '擅长 A', model: 'big', modelSmall: 'small', channel: 'team',
  });

  gw.bus.request = async (to, payload) => {
    if (isConfigGet(payload)) return { wrong: 'shape' };
    return original(to, payload);
  };
  const rows2 = await gateway.getAgentConfigs('test-room');
  assert.equal(rows2[0].error, null, '解析失败不算 transport error');
  await gateway.disconnect();
});

// 慢 agent 超时单独落 error；快 agent 不被拖垮。Real timer here is intentional — the timeout
// itself is what's under test.（契约 §3 的 10s 缩到 200ms：测的是「逐成员独立 + 不拖垮」语义。）
test('getAgentConfigs: 单 agent 超时 → 该行 error；其他成员不受影响', async (t) => {
  // （契约 §3 的 10s 缩到 200ms：测的是「逐成员独立 + 不拖垮」语义，不是时间精度。）
  const reg = await bootRegistry();
  t.after(() => reg.close());
  await joinChannel(reg.url, 'test-room', 'slow-agent');
  await joinChannel(reg.url, 'test-room', 'fast-agent');
  const gateway = new BusGateway({
    agentId: 'web-gateway', registryUrl: reg.url, channels: [], requestTimeoutMs: 200,
    store: { insert: () => {}, load: () => [] },
  });
  await gateway.createRoom('test-room');

  const gw = gateway as unknown as { bus: { request(to: unknown, payload: unknown): Promise<unknown> } };
  const original = gw.bus.request.bind(gw.bus);
  gw.bus.request = (to, payload) => {
    if (to === 'slow-agent' && isConfigGet(payload)) {
      return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 200ms')), 210));
    }
    if (isConfigGet(payload)) {
      return Promise.resolve({ kind: 'config', agent: to, host: 'h', persona: '', model: 'm', modelSmall: 's', channel: 'c' });
    }
    return original(to, payload);
  };

  const rows = await gateway.getAgentConfigs('test-room');
  const slow = rows.find((r) => r.agentId === 'slow-agent');
  const fast = rows.find((r) => r.agentId === 'fast-agent');
  if (!slow || !fast) throw new Error('expected both rows');
  assert.ok(/timeout/.test(slow.error ?? ''), 'slow 落 error');
  assert.equal(slow.config, null);
  assert.equal(slow.online, false);
  assert.ok(fast.config && fast.error === null, 'fast 不受 slow 影响');
  await gateway.disconnect();
});

// 设置页实测痛点：串行扇出 N 成员 × 超时 = 面板 loading 近一分钟。
// 并行后总耗时 ≈ 单成员耗时上限，与成员数无关。
test('getAgentConfigs: 多成员并行扇出，总耗时与成员数无关', async (t) => {
  const reg = await bootRegistry();
  t.after(() => reg.close());
  for (const id of ['p1', 'p2', 'p3', 'p4']) await joinChannel(reg.url, 'test-room', id);
  const gateway = new BusGateway({
    agentId: 'web-gateway', registryUrl: reg.url, channels: [], requestTimeoutMs: 500,
    store: { insert: () => {}, load: () => [] },
  });
  await gateway.createRoom('test-room');

  const gw = gateway as unknown as { bus: { request(to: unknown, payload: unknown): Promise<unknown> } };
  const original = gw.bus.request.bind(gw.bus);
  gw.bus.request = (to, payload) => {
    if (isConfigGet(payload)) {
      // 每个成员都慢 250ms：串行 ≥1s，并行 ≈250ms。
      return new Promise((resolve) => setTimeout(
        () => resolve({ kind: 'config', agent: to, host: 'h', persona: '', model: 'm', modelSmall: 's', channel: 'c' }),
        250,
      ));
    }
    return original(to, payload);
  };

  const started = Date.now();
  const rows = await gateway.getAgentConfigs('test-room');
  const elapsed = Date.now() - started;
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.config && r.error === null), '四行全部成功');
  assert.ok(elapsed < 750, `并行总耗时 ${elapsed}ms 应远低于串行下限 1000ms`);
  await gateway.disconnect();
});

// 用户契约：离线成员不拉取。stale lastSeen = 确证离线 → 跳过 request（零耗时、无 error），
// 只有在线/未知成员才发 config/get。
test('getAgentConfigs: 确证离线（stale lastSeen）的成员跳过 request，不烧超时', async (t) => {
  const reg = await bootRegistry();
  t.after(() => reg.close());
  await joinChannel(reg.url, 'test-room', 'stale-agent');
  await joinChannel(reg.url, 'test-room', 'live-agent');
  const gateway = new BusGateway({
    agentId: 'web-gateway', registryUrl: reg.url, channels: [], requestTimeoutMs: 200,
    store: { insert: () => {}, load: () => [] },
  });
  await gateway.createRoom('test-room');

  // 直接种 presence 缓存：stale-agent 两分钟前最后出现（> 60s 窗口），live-agent 刚出现。
  const seen = gateway as unknown as { agentsLastSeen: Map<string, number> };
  seen.agentsLastSeen.set('stale-agent', Date.now() - 120_000);
  seen.agentsLastSeen.set('live-agent', Date.now());

  const gw = gateway as unknown as { bus: { request(to: unknown, payload: unknown): Promise<unknown> } };
  const original = gw.bus.request.bind(gw.bus);
  const queried: string[] = [];
  gw.bus.request = (to, payload) => {
    if (isConfigGet(payload)) {
      queried.push(String(to));
      return Promise.resolve({ kind: 'config', agent: to, host: 'h', persona: 'p', model: 'm', modelSmall: 's', channel: 'c' });
    }
    return original(to, payload);
  };

  const rows = await gateway.getAgentConfigs('test-room');
  const stale = rows.find((r) => r.agentId === 'stale-agent');
  const live = rows.find((r) => r.agentId === 'live-agent');
  if (!stale || !live) throw new Error('expected both rows');
  assert.deepEqual(queried, ['live-agent'], 'stale 成员不发 request');
  assert.equal(stale.online, false);
  assert.equal(stale.config, null);
  assert.equal(stale.error, null, '跳过的离线行不是错误态');
  assert.ok(live.config && live.error === null);
  await gateway.disconnect();
});


// 空房间（含 self 之外 0 成员）→ 空数组，不发任何 request
test('getAgentConfigs: 房间无其他成员 → 空数组', async (t) => {
  const { gateway, reg } = await makeGateway();
  t.after(() => reg.close());
  let calls = 0;
  const gw = gateway as unknown as { bus: { request(to: unknown, payload: unknown): Promise<unknown> } };
  const original = gw.bus.request.bind(gw.bus);
  gw.bus.request = (to, payload) => { calls++; return original(to, payload); };

  const rows = await gateway.getAgentConfigs('test-room');
  assert.deepEqual(rows, []);
  assert.equal(calls, 0, '无成员时不发任何 request');
  await gateway.disconnect();
});

// set 路径覆盖：ok:true / ok:false / 错回复 三种走线
test('setAgentConfig: ok:true / ok:false / 错回复都映射到 {ok,error}', async (t) => {
  const { gateway, reg } = await makeGateway();
  t.after(() => reg.close());

  const gw = gateway as unknown as { bus: { request(to: unknown, payload: unknown): Promise<unknown> } };
  let lastPatch: unknown;
  gw.bus.request = async (to, payload) => {
    if (isConfigSet(payload)) {
      lastPatch = (payload as { patch: unknown }).patch;
      if (to === 'good') return { kind: 'config', ok: true, agent: 'good' };
      if (to === 'bad') return { kind: 'config', ok: false, error: 'validation failed' };
      return { wrong: 'shape' };
    }
    return null;
  };

  const ok = await gateway.setAgentConfig('good', { persona: 'X', modelSmall: 'Y' });
  assert.deepEqual(ok, { ok: true, agent: 'good' });
  assert.deepEqual(lastPatch, { persona: 'X', modelSmall: 'Y' }, 'patch 原样转发');

  const bad = await gateway.setAgentConfig('bad', { persona: 'X' });
  assert.deepEqual(bad, { ok: false, error: 'validation failed' });

  const malformed = await gateway.setAgentConfig('weird', {});
  assert.deepEqual(malformed, { ok: false, error: 'invalid reply' }, '非合同回复 → invalid reply');
  await gateway.disconnect();
});

// gateway 自身配置读写 + 边界裁剪
test('gateway 自身配置: get 反映初值；apply 热更新并裁剪 contextTokens / userName', async (t) => {
  const { gateway, reg } = await makeGateway();
  t.after(() => reg.close());

  // makeGateway 的 contextTokens 默认 3000；未传 userName → 'web-user'
  const init = gateway.getGatewayConfig();
  assert.equal(init.userName, 'web-user');
  assert.equal(init.contextTokens, 3000);

  gateway.applyGatewayConfig({ userName: 'alice', contextTokens: 5000 });
  assert.deepEqual(gateway.getGatewayConfig(), { userName: 'alice', contextTokens: 5000 });

  // 边界裁剪：超 20000 → 截到 20000；低于 500 → 抬到 500。
  gateway.applyGatewayConfig({ contextTokens: 99_999 });
  assert.equal(gateway.getGatewayConfig().contextTokens, 20_000);
  gateway.applyGatewayConfig({ contextTokens: 10 });
  assert.equal(gateway.getGatewayConfig().contextTokens, 500);

  // 过长 userName 不被采纳（保持 alice）
  gateway.applyGatewayConfig({ userName: 'x'.repeat(100) });
  assert.equal(gateway.getGatewayConfig().userName, 'alice');

  // 非数字 contextTokens 跳过
  gateway.applyGatewayConfig({ contextTokens: 'oops' as unknown as number });
  assert.equal(gateway.getGatewayConfig().contextTokens, 500);
  await gateway.disconnect();
});

function isConfigGet(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return (payload as { kind?: unknown }).kind === 'config' && (payload as { action?: unknown }).action === 'get';
}

function isConfigSet(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return (payload as { kind?: unknown }).kind === 'config' && (payload as { action?: unknown }).action === 'set';
}

