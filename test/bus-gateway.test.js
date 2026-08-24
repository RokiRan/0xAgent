// BusGateway 契约测试：focus window 闸门、token 预算 context、
// principles 回流、房间历史惰性加载。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BusGateway } from '../src/appserver/bus-gateway.js';
import { bootRegistry, pollMessages, joinChannel, roomMsg } from './helpers.js';
const chatText = (m) => {
    const p = m.payload;
    return p && typeof p === 'object' && 'text' in p && typeof p.text === 'string' ? p.text : '';
};
const chatContext = (m) => {
    const p = m.payload;
    return p && typeof p === 'object' && 'context' in p && Array.isArray(p.context) ? p.context : [];
};
async function makeGateway(overrides = {}) {
    const reg = await bootRegistry();
    const focused = new Set(overrides.focused ?? []);
    const sent = [];
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
        store: { insert: () => { }, load: () => [] },
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
        store: { insert: () => { }, load: () => [] },
    });
    await gw.createRoom('test-room'); // 发送者必须在渠道内，否则 relay 403
    await gw.sendChat('test-room', '这条应进摘要');
    assert.equal((await pollMessages(reg.url, 'agent-b')).length, 0);
    // @直聊：sendChat 立即返回（request 不 await），闸门断言只依赖「未走摘要路径」
    await gw.sendChat('test-room', '@agent-b 直聊').catch(() => ({ delivered: [] }));
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
    assert.ok(chatText(digest).includes('这条应进摘要'), '摘要含被闸消息原文');
    await gw.disconnect();
});
test('token 预算: 超预算省略显式报数，历史在预算内截断', async (t) => {
    const seed = Array.from({ length: 8 }, (_, i) => roomMsg('test-room', `user${i}`, `第${i}条历史消息，内容比较长，用来消耗上下文预算额度。`));
    const { reg } = await makeGateway({ contextTokens: 40, seedHistory: seed });
    t.after(() => reg.close());
    await joinChannel(reg.url, 'test-room', 'agent-a');
    const gw = new BusGateway({
        agentId: 'web-gateway', registryUrl: reg.url, channels: [], contextTokens: 40,
        store: { insert: () => { }, load: () => [...seed] },
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
        store: { insert: () => { }, load: () => [] },
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
        store: { insert: () => { }, load: () => [...persisted] },
    });
    await gw.sendChat('test-room', '重启后的第一条'); // emit 先于任何 getHistory
    const history = gw.getHistory('test-room');
    assert.equal(history.length, 2);
    assert.equal(history[0].text, '重启前的持久化消息', '持久化历史在前');
    assert.equal(history[1].text, '重启后的第一条', '新消息在后');
    await gw.disconnect();
});
