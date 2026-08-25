// Bus agent config protocol handler 契约测试 (contract §2 §4):
//   get shape, set validity, priority chain, persistence, API-key safety.
//
// Directly exercises handleConfigRequest / readPersisted / writePersisted
// from src/bus-agent-config.ts without booting a bus agent — the module
// is the pure handler extracted for that reason (see ticket).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUS_CONFIG_ALLOWED_KEYS,
  handleConfigRequest,
  readPersisted,
  writePersisted,
  type BusAgentPersisted,
  type BusConfigResponse,
  type ConfigCtx,
} from '../src/bus-agent-config.js';

const AGENT_ID = 'unit-agent';
const CHANNEL = 'team';
// Sentinel API key — must never appear in any response, persisted file,
// or echoed value across the entire suite.
const SECRET_KEY = 'sk-secret-must-never-leak-MiniMax-test-key-9001';

interface LiveState {
  persona: string;
  big: string;
  small: string;
}

interface Fixture {
  dir: string;
  filePath: string;
  ctx: ConfigCtx;
  /** Records every applyChange payload so we can assert ordering. */
  applied: Array<{ persona?: string; modelSmall?: string }>;
  /** Mutable live state the ctx getters expose — pre-seeded by tests. */
  live: LiveState;
  /** Snapshot of every disk persistence made via applyChange. */
  writes: BusAgentPersisted[];
}

function mkCtx(seed: Partial<LiveState> = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-agent-cfg-'));
  const filePath = path.join(dir, `${AGENT_ID}.json`);
  const applied: Fixture['applied'] = [];
  const writes: Fixture['writes'] = [];
  const live: LiveState = {
    persona: seed.persona ?? '',
    big: seed.big ?? 'MiniMax-M3',
    small: seed.small ?? 'MiniMax-M3',
  };
  const ctx: ConfigCtx = {
    agentId: AGENT_ID,
    channel: CHANNEL,
    getBigModel: () => live.big,
    getSmallModel: () => live.small,
    getPersona: () => live.persona,
    host: 'unit-host',
    filePath,
    applyChange: (next) => {
      applied.push(next);
      if (typeof next.persona === 'string') live.persona = next.persona;
      if (typeof next.modelSmall === 'string') live.small = next.modelSmall;
      // Mirror the production handler: re-read disk, merge the touched keys,
      // re-write — so partial sets accumulate rather than blank siblings.
      const onDisk = readPersisted(filePath);
      if (typeof next.persona === 'string') onDisk.persona = next.persona;
      if (typeof next.modelSmall === 'string') onDisk.modelSmall = next.modelSmall;
      writePersisted(filePath, onDisk);
    },
  };
  return { dir, filePath, ctx, applied, live, writes };
}

function withDiskCapture(fx: Fixture): Fixture {
  const realApply = fx.ctx.applyChange;
  fx.ctx = {
    ...fx.ctx,
    applyChange: (next) => {
      realApply(next);
      fx.writes.push(readPersisted(fx.filePath));
    },
  };
  return fx;
}

function cleanFixture(fx: Fixture): void {
  try { fs.rmSync(fx.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Narrow to the get-shape branch by asserting `ok` is absent and pulling
 *  typed fields through a single index access at the assertion boundary. */
function assertGetShape(res: BusConfigResponse): asserts res is { kind: 'config'; agent: string; host: string; persona: string; model: string; modelSmall: string; channel: string } {
  if ('ok' in res) {
    assert.fail('expected get-shape response, got ok-shape: ' + JSON.stringify(res));
  }
}

/** Narrow to the error branch of set. */
function assertErrorShape(res: BusConfigResponse): asserts res is { kind: 'config'; ok: false; error: string } {
  if (!('ok' in res) || res.ok !== false) {
    assert.fail('expected ok:false, got: ' + JSON.stringify(res));
  }
}

test('get shape: snapshot 返回 contract §2 全部字段', () => {
  const fx = withDiskCapture(mkCtx({ persona: '前端', big: 'big-1', small: 'small-1' }));
  try {
    const res = handleConfigRequest({ kind: 'config', action: 'get' }, fx.ctx);
    assert.equal(res.kind, 'config');
    assertGetShape(res);
    assert.equal(res.agent, AGENT_ID);
    assert.equal(res.host, 'unit-host');
    assert.equal(res.persona, '前端');
    assert.equal(res.model, 'big-1');
    assert.equal(res.modelSmall, 'small-1');
    assert.equal(res.channel, CHANNEL);
  } finally { cleanFixture(fx); }
});

test('get 后不影响 persona/live state', () => {
  const fx = withDiskCapture(mkCtx({ persona: 'original' }));
  try {
    handleConfigRequest({ kind: 'config', action: 'get' }, fx.ctx);
    assert.equal(fx.live.persona, 'original');
    assert.equal(fx.applied.length, 0, 'get 不应触发 applyChange');
  } finally { cleanFixture(fx); }
});

test('set 合法 patch → ok:true + 返回 agent + 写盘 + 后续 get 反映', () => {
  const fx = withDiskCapture(mkCtx());
  try {
    const res = handleConfigRequest(
      { kind: 'config', action: 'set', patch: { persona: '后端', modelSmall: 'haiku' } },
      fx.ctx,
    );
    assert.deepEqual(res, { kind: 'config', ok: true, agent: AGENT_ID });
    assert.equal(fx.live.persona, '后端');
    assert.equal(fx.live.small, 'haiku');
    const onDisk = readPersisted(fx.filePath);
    assert.equal(onDisk.persona, '后端');
    assert.equal(onDisk.modelSmall, 'haiku');
    const after = handleConfigRequest({ kind: 'config', action: 'get' }, fx.ctx);
    assert.equal(after.kind, 'config');
    assertGetShape(after);
    assert.equal(after.persona, '后端');
    assert.equal(after.modelSmall, 'haiku');
  } finally { cleanFixture(fx); }
});

test('set 单字段 patch 不会抹掉另一字段（part merge）', () => {
  const fx = withDiskCapture(mkCtx());
  try {
    handleConfigRequest({ kind: 'config', action: 'set', patch: { persona: '固定' } }, fx.ctx);
    handleConfigRequest({ kind: 'config', action: 'set', patch: { modelSmall: 'judge-2' } }, fx.ctx);
    const onDisk = readPersisted(fx.filePath);
    assert.equal(onDisk.persona, '固定', '先 set 的 persona 不被清空');
    assert.equal(onDisk.modelSmall, 'judge-2');
  } finally { cleanFixture(fx); }
});

test('set 非法键 → ok:false + 不写盘 + 不污染 live', () => {
  const fx = withDiskCapture(mkCtx({ persona: '干净' }));
  try {
    const res = handleConfigRequest(
      { kind: 'config', action: 'set', patch: { apiKey: SECRET_KEY } },
      fx.ctx,
    );
    assertErrorShape(res);
    assert.match(res.error, /unsupported key/);
    assert.equal(fx.live.persona, '干净');
    assert.equal(readPersisted(fx.filePath).persona, undefined);
  } finally { cleanFixture(fx); }
});

test('set 非字符串值 → ok:false', () => {
  const fx = withDiskCapture(mkCtx());
  try {
    const res = handleConfigRequest(
      { kind: 'config', action: 'set', patch: { persona: 42 as unknown as string } },
      fx.ctx,
    );
    assertErrorShape(res);
    assert.match(res.error, /must be string/);
  } finally { cleanFixture(fx); }
});

test('set 空 patch / 缺 patch / 数组 patch → ok:false', () => {
  const fx = withDiskCapture(mkCtx());
  try {
    const empty = handleConfigRequest({ kind: 'config', action: 'set', patch: {} }, fx.ctx);
    assertErrorShape(empty);
    assert.match(empty.error, /empty/);

    const missing = handleConfigRequest({ kind: 'config', action: 'set' }, fx.ctx);
    assertErrorShape(missing);
    assert.match(missing.error, /missing/);

    const arr = handleConfigRequest(
      { kind: 'config', action: 'set', patch: [] as unknown as object },
      fx.ctx,
    );
    assertErrorShape(arr);
    assert.match(arr.error, /object/);
  } finally { cleanFixture(fx); }
});

test('set 未知 action / 错 kind / 空 payload → ok:false 不写盘', () => {
  const fx = withDiskCapture(mkCtx({ persona: '保持' }));
  try {
    const badAction = handleConfigRequest({ kind: 'config', action: 'merge' }, fx.ctx);
    assertErrorShape(badAction);
    const wrongKind = handleConfigRequest({ kind: 'task' }, fx.ctx);
    assertErrorShape(wrongKind);
    const nullPayload = handleConfigRequest(null, fx.ctx);
    assertErrorShape(nullPayload);
    const stringPayload = handleConfigRequest('hi', fx.ctx);
    assertErrorShape(stringPayload);
    assert.equal(fx.live.persona, '保持');
    assert.equal(readPersisted(fx.filePath).persona, undefined);
  } finally { cleanFixture(fx); }
});

test('启动优先级: env > 文件 > 默认 (boot merge 复刻 bus-agent 启动逻辑)', () => {
  const fx = withDiskCapture(mkCtx());
  try {
    // 1. 模拟 "上次运行残留文件" — 文件里有 persona + modelSmall
    writePersisted(fx.filePath, { persona: '文件-persona', modelSmall: '文件-small' });

    // 2. 复刻 bus-agent.ts 的 boot merge: env > 文件 > 默认
    //    (用 process.env 模拟 env 的当前值，由调用方控制)
    function bootCtx(envPersona: string | undefined, envSmall: string | undefined): {
      ctx: ConfigCtx;
      live: LiveState;
    } {
      const persisted = readPersisted(fx.filePath);
      const big = process.env.MINIMAX_MODEL ?? 'MiniMax-M3';
      const smallInit =
        (typeof envSmall === 'string' && envSmall.length > 0) ? envSmall :
        (typeof persisted.modelSmall === 'string' && persisted.modelSmall.length > 0 ? persisted.modelSmall : big);
      const personaInit =
        (typeof envPersona === 'string' && envPersona.length > 0) ? envPersona :
        (typeof persisted.persona === 'string' && persisted.persona.length > 0 ? persisted.persona : '');
      const live: LiveState = { persona: personaInit, big, small: smallInit };
      const ctx: ConfigCtx = {
        agentId: AGENT_ID,
        channel: CHANNEL,
        host: 'unit-host',
        filePath: fx.filePath,
        getBigModel: () => live.big,
        getSmallModel: () => live.small,
        getPersona: () => live.persona,
        applyChange: (next) => {
          if (typeof next.persona === 'string') live.persona = next.persona;
          if (typeof next.modelSmall === 'string') live.small = next.modelSmall;
        },
      };
      return { ctx, live };
    }

    // env 都设了 → env 胜
    {
      const { ctx } = bootCtx('env-persona', 'env-small');
      const res = handleConfigRequest({ kind: 'config', action: 'get' }, ctx);
      assertGetShape(res);
      assert.equal(res.persona, 'env-persona', 'env > 文件 (persona)');
      assert.equal(res.modelSmall, 'env-small', 'env > 文件 (modelSmall)');
    }
    // env 都缺 → 文件胜
    {
      const { ctx } = bootCtx(undefined, undefined);
      const res = handleConfigRequest({ kind: 'config', action: 'get' }, ctx);
      assertGetShape(res);
      assert.equal(res.persona, '文件-persona', 'env 缺 → 文件 (persona)');
      assert.equal(res.modelSmall, '文件-small', 'env 缺 → 文件 (modelSmall)');
    }
    // env 空串 (被 shell 显式 unset 同效果) → 也走文件
    {
      const { ctx } = bootCtx('', '');
      const res = handleConfigRequest({ kind: 'config', action: 'get' }, ctx);
      assertGetShape(res);
      assert.equal(res.persona, '文件-persona');
      assert.equal(res.modelSmall, '文件-small');
    }
    // 文件被删 + env 缺 → 默认
    fs.rmSync(fx.filePath, { force: true });
    {
      const { ctx } = bootCtx(undefined, undefined);
      const res = handleConfigRequest({ kind: 'config', action: 'get' }, ctx);
      assertGetShape(res);
      assert.equal(res.persona, '', 'persona 默认空串');
      assert.equal(res.modelSmall, 'MiniMax-M3', 'modelSmall 默认回落 big');
    }
  } finally { cleanFixture(fx); }
});

test('API key 永久不出现在 response / persisted file / applyChange payload', () => {
  const fx = withDiskCapture(mkCtx());
  try {
    const cases: unknown[] = [
      handleConfigRequest({ kind: 'config', action: 'get' }, fx.ctx),
      handleConfigRequest({ kind: 'config', action: 'set', patch: { persona: 'p' } }, fx.ctx),
      handleConfigRequest({ kind: 'config', action: 'set', patch: { apiKey: SECRET_KEY } }, fx.ctx),
      handleConfigRequest({ kind: 'config', action: 'set', patch: { model: SECRET_KEY } }, fx.ctx),
    ];
    for (const r of cases) {
      assert.ok(!JSON.stringify(r).includes(SECRET_KEY), 'response 不含 API key');
    }
    const onDisk = JSON.stringify(readPersisted(fx.filePath));
    assert.ok(!onDisk.includes(SECRET_KEY), 'disk file 不含 API key');
    for (const call of fx.applied) {
      const hasApiKey = 'apiKey' in call;
      const hasModel = 'model' in call;
      assert.ok(!hasApiKey && !hasModel, 'applyChange 收到的不该含禁用键');
    }
  } finally { cleanFixture(fx); }
});

test('持久化往返: writePersisted → readPersisted 等价（容错读取垃圾）', () => {
  const fx = withDiskCapture(mkCtx());
  try {
    writePersisted(fx.filePath, { persona: 'A', modelSmall: 'B' });
    const back = readPersisted(fx.filePath);
    assert.deepEqual(back, { persona: 'A', modelSmall: 'B' });

    fs.writeFileSync(fx.filePath, 'not json {', 'utf8');
    assert.deepEqual(readPersisted(fx.filePath), {});

    fs.writeFileSync(fx.filePath, JSON.stringify({ persona: 123, modelSmall: null }), 'utf8');
    assert.deepEqual(readPersisted(fx.filePath), {});

    const missing = path.join(fx.dir, 'missing.json');
    assert.deepEqual(readPersisted(missing), {});
  } finally { cleanFixture(fx); }
});

test('writePersisted 覆盖前留 .bak：误写可用上一版恢复', () => {
  const fx = withDiskCapture(mkCtx());
  try {
    writePersisted(fx.filePath, { persona: '原始-persona', modelSmall: 'B' });
    writePersisted(fx.filePath, { persona: '误写-persona', modelSmall: 'B' });
    // 主文件是新值，.bak 是上一版
    assert.equal(readPersisted(fx.filePath).persona, '误写-persona');
    const bak = JSON.parse(fs.readFileSync(`${fx.filePath}.bak`, 'utf8')) as BusAgentPersisted;
    assert.equal(bak.persona, '原始-persona');
    // 首写（无旧文件）不产生 .bak 也不炸
    const fresh = path.join(fx.dir, 'fresh.json');
    writePersisted(fresh, { persona: 'X' });
    assert.equal(fs.existsSync(`${fresh}.bak`), false);
  } finally { cleanFixture(fx); }
});

test('BUS_CONFIG_ALLOWED_KEYS 严格只列 persona + modelSmall（冻结允许键）', () => {
  assert.deepEqual([...BUS_CONFIG_ALLOWED_KEYS].sort(), ['modelSmall', 'persona']);
});

test('set 与 hostname fallback: 没设 ctx.host 时用 os.hostname()（不会爆）', () => {
  const fx = withDiskCapture(mkCtx());
  try {
    // 解构删 host 字段是标准做法，保留窄化推导
    const { host: _drop, ...rest } = fx.ctx;
    void _drop;
    const ctxNoHost: ConfigCtx = { ...rest };
    const res = handleConfigRequest({ kind: 'config', action: 'get' }, ctxNoHost);
    assert.equal(res.kind, 'config');
    assertGetShape(res);
    assert.ok(typeof res.host === 'string' && res.host.length > 0, 'host 字段非空字符串');
  } finally { cleanFixture(fx); }
});
