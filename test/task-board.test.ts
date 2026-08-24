// TaskBoard state-machine tests.
// Runner: /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs --test test/task-board.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeTaskDeps, waitFor } from './helpers.js';
import { TaskBoard } from '../src/appserver/task-board.js';

const ROOM = 'r-task';

function openTaskBoard(overrides: Parameters<typeof makeTaskDeps>[0] = {}): {
  board: TaskBoard;
  deps: ReturnType<typeof makeTaskDeps>;
} {
  const db = makeDb();
  const deps = makeTaskDeps(overrides);
  const board = new TaskBoard(db, deps);
  return { board, deps };
}

// 1. create 校验：acceptance 空 → 抛错；owner==approver → 抛错；低风险直接 ready
test('create 校验：acceptance 空 → 抛错', () => {
  const { board } = openTaskBoard();
  assert.throws(
    () => board.create(ROOM, '空验收', [], 'a1', 'approver', 'low'),
    /acceptance 不能为空/,
  );
  board.close();
});

test('create 校验：owner==approver → 抛错（防自我确认）', () => {
  const { board } = openTaskBoard();
  assert.throws(
    () => board.create(ROOM, '自我确认', ['x'], 'same', 'same', 'low'),
    /approver 不得等于 owner/,
  );
  board.close();
});

test('create 低风险无 owner → ready 状态（不自动派发）', () => {
  const { board } = openTaskBoard();
  const t = board.create(ROOM, '待领', ['a', 'b'], null, 'approver', 'low');
  assert.equal(t.state, 'ready');
  assert.equal(t.owner, null);
  assert.equal(t.leaseExpiresAt, null);
  board.close();
});

// 2. 风险门：risk:'high' → pending_approval；confirm() 后 → in_progress 且 postMessage 含确认消息
test('风险门：high risk → pending_approval；confirm() → in_progress 且贴出确认消息', () => {
  const { board, deps } = openTaskBoard();
  const t = board.create(ROOM, '高风险', ['a'], 'a1', 'approver', 'high');
  assert.equal(t.state, 'pending_approval');
  // 高风险时不应直接派发
  assert.equal(deps.requests.length, 0);

  const confirmed = board.confirm(t.id);
  assert.equal(confirmed.state, 'in_progress');
  assert.equal(confirmed.owner, 'a1');
  assert.ok(confirmed.leaseExpiresAt !== null && confirmed.leaseExpiresAt > Date.now());
  // postMessage 应包含「已获人工确认」通告
  const confirmMsg = deps.messages.find((m) => m.includes('已获人工确认'));
  assert.ok(confirmMsg, '应贴出人工确认通告');
  board.close();
});

// 3. 指派派发：create 带 owner → in_progress + requestAgent 被调用 (kind:'task',action:'assign')
test('指派派发：低风险带 owner → in_progress 且 requestAgent 收到 assign 请求', async () => {
  const { board, deps } = openTaskBoard();
  const t = board.create(ROOM, '带 owner', ['a'], 'a1', 'approver', 'low');
  assert.equal(t.state, 'in_progress');
  // dispatch 是 fire-and-forget：等请求被记录
  await waitFor(() => deps.requests.length >= 1);
  const req = deps.requests.find((r) => r.target === 'a1');
  assert.ok(req, '应向 a1 发请求');
  assert.deepEqual(req!.payload, {
    kind: 'task',
    action: 'assign',
    taskId: t.id,
    room: ROOM,
    title: '带 owner',
    acceptance: ['a'],
  });
  board.close();
});

// 4. 提交闭环：requestAgent 脚本化返回 submit → 状态 review
test('提交闭环：requestAgent 返回 submit+evidence → 状态 review 且 evidence 入库', async () => {
  const { board } = openTaskBoard({
    requestAgent: async (target, _payload) => {
      if (target !== 'a1') return {};
      return { kind: 'task', action: 'submit', evidence: '已完成：日志在 logs/run.out' };
    },
  });
  const t = board.create(ROOM, '提交闭环', ['a'], 'a1', 'approver', 'low');
  await waitFor(() => board.list(ROOM).find((x) => x.id === t.id)?.state === 'review');
  const got = board.list(ROOM).find((x) => x.id === t.id)!;
  assert.equal(got.state, 'review');
  assert.equal(got.evidence.length, 1);
  assert.equal(got.evidence[0], '已完成：日志在 logs/run.out');
  board.close();
});

// 5. approve：review → done，postMessage 含 ADR 五行要素
test('approve：review → done 且 ADR 含五要素（背景/决定/否决/证据/回访条件）', async () => {
  const { board, deps } = openTaskBoard({
    requestAgent: async (target) => {
      if (target !== 'a1') return {};
      return { kind: 'task', action: 'submit', evidence: 'e1' };
    },
  });
  const t = board.create(ROOM, '验收', ['a', 'b'], 'a1', 'approver', 'low');
  await waitFor(() => board.list(ROOM).find((x) => x.id === t.id)?.state === 'review');
  const done = board.approve(t.id);
  assert.equal(done.state, 'done');
  assert.ok(done.adr !== null, 'ADR 应已写入');
  const adr = done.adr!;
  assert.ok(adr.includes('背景：'), 'ADR 应含「背景：」');
  assert.ok(adr.includes('决定：'), 'ADR 应含「决定：」');
  assert.ok(adr.includes('否决：'), 'ADR 应含「否决：」');
  assert.ok(adr.includes('证据：'), 'ADR 应含「证据：」');
  assert.ok(adr.includes('回访条件：'), 'ADR 应含「回访条件：」');
  // postMessage 应含「已通过验收」
  const okMsg = deps.messages.find((m) => m.includes('已通过验收'));
  assert.ok(okMsg, '应贴出通过验收通告');
  board.close();
});

// 6. returnTask：review → in_progress 带 note，且重新派发 action:'rework'
test('returnTask：review → in_progress 带 note，并触发 rework 派发', async () => {
  const submitted: string[] = [];
  const { board, deps } = openTaskBoard({
    requestAgent: async (target, payload) => {
      // helpers 默认会把请求记入 deps.requests；这里覆盖掉了，要再补上以便断言
      deps.requests.push({ target, payload });
      // 额外记录所有派发的 action 序列
      const p = payload as { kind?: string; action?: string };
      if (p?.kind === 'task' && p.action) submitted.push(p.action);
      if (target !== 'a1') return {};
      // 第一次 assign 提交 evidence；之后的 rework 不再回 submit
      if (p && (p as { action?: string }).action === 'rework') return {};
      return { kind: 'task', action: 'submit', evidence: 'e1' };
    },
  });
  const t = board.create(ROOM, '退回', ['a'], 'a1', 'approver', 'low');
  await waitFor(() => board.list(ROOM).find((x) => x.id === t.id)?.state === 'review');
  const returned = board.returnTask(t.id, '请补充 a 的证据');
  assert.equal(returned.state, 'in_progress');
  assert.ok(returned.leaseExpiresAt !== null && returned.leaseExpiresAt > Date.now());
  // dispatch 是 fire-and-forget；等请求里出现 rework
  await waitFor(() => submitted.includes('rework'));
  const reworkReq = deps.requests.find(
    (r) => (r.payload as { kind?: string; action?: string }).action === 'rework',
  );
  assert.ok(reworkReq, '应派发 rework');
  const pl = reworkReq!.payload as { action: string; note: string; taskId: string };
  assert.equal(pl.action, 'rework');
  assert.equal(pl.note, '请补充 a 的证据');
  assert.equal(pl.taskId, t.id);
  board.close();
});

// 7. cancel：→ cancelled（终态）
test('cancel：in_progress → cancelled（终态），ADR ≥10 字', () => {
  const { board, deps } = openTaskBoard();
  const t = board.create(ROOM, '终止', ['a'], 'a1', 'approver', 'low');
  assert.equal(t.state, 'in_progress');
  const cancelled = board.cancel(t.id, '需求取消：上游接口调整');
  assert.equal(cancelled.state, 'cancelled');
  assert.ok((cancelled.adr ?? '').length >= 10);
  const stopMsg = deps.messages.find((m) => m.includes('已终止'));
  assert.ok(stopMsg, '应贴出终止通告');
  // 再次 cancel 终态任务应抛错
  assert.throws(() => board.cancel(t.id, '再终止一次也应有 ADR'), /任务已 cancelled/);
  board.close();
});

// 8. anti-翻案：done 任务 reopen 无新证据 → 抛错；有新证据 → in_progress
test('anti-翻案：done 后 reopen 空证据 → 抛错；带新证据 → in_progress 且证据追加', async () => {
  const { board } = openTaskBoard({
    requestAgent: async (target) => {
      if (target !== 'a1') return {};
      return { kind: 'task', action: 'submit', evidence: 'e1' };
    },
  });
  const t = board.create(ROOM, '翻案', ['a'], 'a1', 'approver', 'low');
  await waitFor(() => board.list(ROOM).find((x) => x.id === t.id)?.state === 'review');
  board.approve(t.id);
  const done = board.list(ROOM).find((x) => x.id === t.id)!;
  assert.equal(done.state, 'done');

  // 无证据 / 纯空白 → 抛错
  assert.throws(() => board.reopen(t.id, ''), /新证据 diff/);
  assert.throws(() => board.reopen(t.id, '   '), /新证据 diff/);

  // 有新证据 → in_progress + 续租约
  const reopened = board.reopen(t.id, '新日志表明验收条件 a 不充分');
  assert.equal(reopened.state, 'in_progress');
  assert.ok(reopened.leaseExpiresAt !== null && reopened.leaseExpiresAt > Date.now());
  assert.ok(reopened.evidence.some((e) => e.includes('新日志表明验收条件 a 不充分')));
  board.close();
});

// 9. 依赖图：addDep 正常加边；成环 → 抛错；自依赖 → 抛错
test('addDep 正常加边；自依赖抛错；成环抛错', () => {
  const { board } = openTaskBoard();
  const a = board.create(ROOM, 'A', ['a'], 'a1', 'approver', 'low');
  const b = board.create(ROOM, 'B', ['b'], 'b1', 'approver', 'low');
  // 自依赖
  assert.throws(() => board.addDep(a.id, a.id), /不允许自依赖/);
  // A blocked by B
  board.addDep(a.id, b.id);
  // B blocked by A 会形成环
  assert.throws(() => board.addDep(b.id, a.id), /会形成依赖环/);
  board.close();
});

// 10. ownersInFocus：in_progress owner 在列；approve/cancel 后出列
test('ownersInFocus：in_progress owner 在列；approve / cancel 后出列', async () => {
  const { board } = openTaskBoard({
    requestAgent: async (target) => {
      if (target !== 'a1') return {};
      return { kind: 'task', action: 'submit', evidence: 'e1' };
    },
  });
  const t = board.create(ROOM, '焦点', ['a'], 'a1', 'approver', 'low');
  assert.deepEqual(board.ownersInFocus(ROOM), ['a1']);
  await waitFor(() => board.list(ROOM).find((x) => x.id === t.id)?.state === 'review');
  // review 状态下 owner 仍处于深度工作期（DB 状态非 in_progress，会退出列）
  // 注意：源码 ownersInFocus 仅查 state='in_progress'，review 状态 owner 应不在列
  assert.deepEqual(board.ownersInFocus(ROOM), []);
  board.approve(t.id);
  assert.deepEqual(board.ownersInFocus(ROOM), []);

  // 另一条任务：cancel 后也应出列
  const t2 = board.create(ROOM, '焦点2', ['a'], 'b1', 'approver', 'low');
  assert.deepEqual(board.ownersInFocus(ROOM), ['b1']);
  board.cancel(t2.id, '上游接口调整取消该任务');
  assert.deepEqual(board.ownersInFocus(ROOM), []);
  board.close();
});

// 11. 晋升门：单来源 promote 抛错；两个独立 taskId 来源 → 成功；pin 单来源 → 成功；promotedPrinciples 只含已晋升
test('晋升门：单来源 promote 抛错；双来源 → 成功；pin 单来源 → 成功；promotedPrinciples 只含已晋升', () => {
  const { board } = openTaskBoard();
  const t1 = board.create(ROOM, '经验 1', ['a'], 'a1', 'approver', 'low');
  const t2 = board.create(ROOM, '经验 2', ['b'], 'a2', 'approver', 'low');
  // 同一原则只登记一次（proposePrinciple 按 (room,text) 去重，相同 sourceTaskId 不重复加入 sources）
  board.proposePrinciple(ROOM, '提交前先跑单测', t1.id);
  const principles = board.listPrinciples(ROOM) as Array<{ id: string; sources: string; promoted: number }>;
  assert.equal(principles.length, 1);
  const id = principles[0].id;
  assert.deepEqual(JSON.parse(principles[0].sources), [t1.id]);

  // 单来源 promote → 抛错
  assert.throws(() => board.promotePrinciple(id), /晋升门拒绝/);
  assert.equal((board.listPrinciples(ROOM) as Array<{ promoted: number }>)[0].promoted, 0);

  // 第二个独立 task 来源 → 累计 sources
  board.proposePrinciple(ROOM, '提交前先跑单测', t2.id);
  const after = board.listPrinciples(ROOM) as Array<{ sources: string; promoted: number }>;
  assert.deepEqual(JSON.parse(after[0].sources).sort(), [t1.id, t2.id].sort());

  // 双来源 promote → 成功
  board.promotePrinciple(id);
  const promoted = board.listPrinciples(ROOM) as Array<{ id: string; promoted: number }>;
  assert.equal(promoted[0].promoted, 1);
  assert.deepEqual(board.promotedPrinciples(ROOM), ['提交前先跑单测']);

  // 再次 promote 已晋升条目：幂等（无 throw，promoted 仍 1）
  board.promotePrinciple(id);
  assert.equal(
    (board.listPrinciples(ROOM) as Array<{ promoted: number }>)[0].promoted,
    1,
  );

  // 新增一条原则（单来源）通过人类 pin 晋升
  board.proposePrinciple(ROOM, '紧急变更需双人复核', t1.id);
  const pinCandidate = (board.listPrinciples(ROOM) as Array<{ text: string; promoted: number; id: string }>)
    .find((p) => p.text === '紧急变更需双人复核')!;
  assert.equal(pinCandidate.promoted, 0);
  board.promotePrinciple(pinCandidate.id, true);
  // promotedPrinciples 同时列出 pin 晋升的原则
  const list = board.promotedPrinciples(ROOM);
  assert.ok(list.includes('紧急变更需双人复核'));
  assert.ok(list.includes('提交前先跑单测'));
  board.close();
});

// 12. 评分重派：leaseMs 短 + listMembers 多 agent → reaper 触发重派给非当前 owner
test('评分重派：短 lease + 多 agent 候选 → reaper 把任务派给另一个非当前 owner', async () => {
  const { board } = openTaskBoard({
    leaseMs: 50,
    reaperIntervalMs: 25,
    listMembers: async () => ['a1', 'a2', 'gateway-ignored'],
  });
  const t = board.create(ROOM, '租约重派', ['a'], 'a1', 'approver', 'low');
  assert.equal(t.owner, 'a1');
  assert.equal(t.state, 'in_progress');
  // 等 lease 过期 + reaper 触发 + 评分选 a2（gateway 被过滤，a1 也被过滤）
  // 注意：gateway-1 名字包含 'gateway' 被过滤；a1 === task.owner 被过滤；只剩 a2
  await waitFor(
    () => {
      const cur = board.list(ROOM).find((x) => x.id === t.id);
      return cur?.owner === 'a2';
    },
    3000,
  );
  const got = board.list(ROOM).find((x) => x.id === t.id)!;
  assert.equal(got.owner, 'a2', 'reaper 应把任务重派给 a2');
  assert.equal(got.state, 'in_progress');
  assert.equal(got.reassignCount, 1);
  assert.ok(board.metrics.reassigned >= 1, 'reassigned 计数应至少为 1');
  board.close();
});