// DecisionBoard convergence state-machine tests.
// Runner: /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs --test test/decision-board.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeDecisionDeps, waitFor } from './helpers.js';
import { DecisionBoard } from '../src/appserver/decision-board.js';

const ROOM = 'r1';
const OPTIONS = ['A', 'B'];

function openBoard(overrides: Parameters<typeof makeDecisionDeps>[0] = {}, args: {
  room?: string;
  question?: string;
  options?: string[];
  criterion?: string;
  quorum?: number;
  defaultOption?: string;
  timeboxMs?: number;
} = {}): { board: DecisionBoard; deps: ReturnType<typeof makeDecisionDeps> } {
  const db = makeDb();
  const deps = makeDecisionDeps(overrides);
  const board = new DecisionBoard(db, deps);
  return { board, deps };
}

test('open: 校验——选项少于 2 抛错', async () => {
  const { board } = openBoard();
  await assert.rejects(
    () => board.open(ROOM, 'q', ['only'], '', 1, 'only', 60_000),
    /至少需要两个选项/,
  );
  board.stop();
});

test('open: 校验——默认项不在选项中抛错', async () => {
  const { board } = openBoard();
  await assert.rejects(
    () => board.open(ROOM, 'q', ['A', 'B'], '', 1, 'C', 60_000),
    /默认项必须在选项之中/,
  );
  board.stop();
});

test('open: 校验——quorum<1 抛错', async () => {
  const { board } = openBoard();
  await assert.rejects(
    () => board.open(ROOM, 'q', OPTIONS, '', 0, 'A', 60_000),
    /quorum 至少为 1/,
  );
  board.stop();
});

test('open: 收票扇出——listMembers 含 gateway 被过滤后,每个成员被 requestAgent(kind:decision/action:vote)', async () => {
  const { board, deps } = openBoard({
    listMembers: async (room: string) => {
      assert.equal(room, ROOM);
      return ['a1', 'a2', 'a3', 'gateway-1'];
    },
    requestAgent: async (target, payload) => {
      // Record call, return nothing (vote collection will be a no-op).
      deps.requests.push({ target, payload });
      return {};
    },
  });
  const d = await board.open(ROOM, 'pick A or B', OPTIONS, 'criteria', 2, 'A', 60_000);
  assert.equal(d.state, 'voting');
  assert.equal(d.quorum, 2);
  // Give the void-ed collectVote promises a microtask to record.
  await new Promise((r) => setImmediate(r));
  await waitFor(() => deps.requests.length >= 3);
  const targets = deps.requests.map((r) => r.target).sort();
  assert.deepEqual(targets, ['a1', 'a2', 'a3']);
  for (const r of deps.requests) {
    assert.deepEqual(r.payload, {
      kind: 'decision',
      action: 'vote',
      decisionId: d.id,
      question: 'pick A or B',
      options: OPTIONS,
      criterion: 'criteria',
    });
  }
  board.stop();
});

test('quorum 收敛: quorum=2，a1/a2 都投 A → decided/decided_option=A/decided_by=quorum', async () => {
  const { board, deps } = openBoard({
    listMembers: async () => ['a1', 'a2', 'a3'],
    requestAgent: async (target) => {
      deps.requests.push({ target, payload: null });
      if (target === 'a1' || target === 'a2') {
        return { option: 'A', rationale: 'x' };
      }
      // a3 never returns a valid vote (mimics silence / timeout)
      return {};
    },
  });
  const d = await board.open(ROOM, 'q', OPTIONS, '', 2, 'A', 60_000);
  await waitFor(() => {
    const row = board.list(ROOM).find((x) => x.id === d.id);
    return row?.state === 'decided';
  });
  const got = board.list(ROOM).find((x) => x.id === d.id)!;
  assert.equal(got.state, 'decided');
  assert.equal(got.decidedOption, 'A');
  assert.equal(got.decidedBy, 'quorum');
  // Only valid voters counted; a3 didn't vote.
  assert.equal(Object.keys(got.votes).length, 2);
  assert.equal(got.votes.a1, 'A');
  assert.equal(got.votes.a2, 'A');
  assert.equal(got.rationales.a1, 'x');
  assert.equal(got.rationales.a2, 'x');
  // decided metric bumped
  assert.equal(board.metrics.decided, 1);
  board.stop();
});

test('弃票: 返回的 option 不在 options 中 → 不计票', async () => {
  const { board, deps } = openBoard({
    listMembers: async () => ['a1', 'a2'],
    requestAgent: async (target) => {
      deps.requests.push({ target, payload: null });
      if (target === 'a1') return { option: 'A', rationale: 'ok' };
      if (target === 'a2') return { option: 'INVALID', rationale: 'oops' };
      return {};
    },
  });
  const d = await board.open(ROOM, 'q', OPTIONS, '', 1, 'A', 60_000);
  await waitFor(() => {
    const row = board.list(ROOM).find((x) => x.id === d.id);
    return row?.state === 'decided';
  });
  const got = board.list(ROOM).find((x) => x.id === d.id)!;
  assert.equal(got.state, 'decided');
  // a2's invented option = abstain → not in votes
  assert.deepEqual(Object.keys(got.votes).sort(), ['a1']);
  assert.equal(got.votes.a1, 'A');
  board.stop();
});

test('迟票忽略: decided 后再有 vote 返回 → 状态/votes 不变', async () => {
  // Two-phase scripted requestAgent: first calls (during voting) return nothing,
  // we manually drive recordVote via open()+a1 voting normally, then post-decide
  // we attempt to record a late vote through collectVote (a2's first call
  // happens too late to matter; we synthesise the late-vote scenario by
  // calling recordVote-like path via open then re-fanning).
  //
  // Approach: quorum=1. a1 votes A → decided. After that, the voided
  // collectVote for a2 resolves (returns a valid vote). recordVote must
  // short-circuit because state !== 'voting'.
  const lateResponses: Array<() => Promise<unknown>> = [];
  const { board, deps } = openBoard({
    listMembers: async () => ['a1', 'a2'],
    requestAgent: async (target, _payload, _timeoutMs) => {
      deps.requests.push({ target, payload: null });
      // Defer a1's vote until first poll; a2 stays silent.
      if (target === 'a1') {
        return new Promise((resolve) => setTimeout(() => resolve({ option: 'A', rationale: 'first' }), 30));
      }
      // a2: resolve quickly but we want to verify post-decide it doesn't move state.
      return new Promise((resolve) => {
        lateResponses.push(() => new Promise((r) => setTimeout(() => r({ option: 'B', rationale: 'late' }), 80)));
        resolve(lateResponses[lateResponses.length - 1]());
      });
    },
  });
  const d = await board.open(ROOM, 'q', OPTIONS, '', 1, 'A', 60_000);
  await waitFor(() => board.list(ROOM).find((x) => x.id === d.id)?.state === 'decided');
  const decidedAt = board.list(ROOM).find((x) => x.id === d.id)!;
  assert.equal(decidedAt.state, 'decided');
  assert.deepEqual(Object.keys(decidedAt.votes).sort(), ['a1']);
  // Now wait long enough for any late vote promises to resolve (a2's 80ms timer).
  await new Promise((r) => setTimeout(r, 200));
  const after = board.list(ROOM).find((x) => x.id === d.id)!;
  assert.equal(after.state, 'decided', 'state must not regress from decided');
  assert.deepEqual(Object.keys(after.votes).sort(), ['a1'], 'late vote must not be recorded');
  assert.equal(after.decidedOption, 'A');
  assert.equal(after.decidedBy, 'quorum');
  board.stop();
});

test('人类裁定: voting 中 resolve(id, B) → decided/decided_by=human', async () => {
  const { board } = openBoard({
    listMembers: async () => ['a1'],
    requestAgent: async () => ({}), // no votes ever arrive
  });
  const d = await board.open(ROOM, 'q', OPTIONS, '', 3, 'A', 60_000);
  assert.equal(d.state, 'voting');
  const resolved = board.resolve(d.id, 'B');
  assert.equal(resolved.state, 'decided');
  assert.equal(resolved.decidedOption, 'B');
  assert.equal(resolved.decidedBy, 'human');
  // And a 2nd resolve attempt on a decided decision should error.
  assert.throws(() => board.resolve(d.id, 'A'), /已 decided/);
  board.stop();
});

test('anti-reopen: decided 后 reopen 无证据抛错;带新证据回 voting 且 votes 清空', async () => {
  const { board, deps } = openBoard({
    listMembers: async () => ['a1'],
    requestAgent: async (target, payload) => {
      deps.requests.push({ target, payload });
      return { option: 'A', rationale: 'first' };
    },
  });
  const d = await board.open(ROOM, 'q', OPTIONS, '', 1, 'A', 60_000);
  await waitFor(() => board.list(ROOM).find((x) => x.id === d.id)?.state === 'decided');
  // 1) reopen without evidence → error
  assert.throws(() => board.reopen(d.id, ''), /新证据 diff/);
  assert.throws(() => board.reopen(d.id, '   '), /新证据 diff/);
  // 2) reopen with whitespace-only fails, decided state preserved
  const still = board.list(ROOM).find((x) => x.id === d.id)!;
  assert.equal(still.state, 'decided');
  // 3) reopen with new evidence → back to voting, votes cleared
  const beforeReopen = deps.requests.length;
  const reopened = board.reopen(d.id, 'new log shows A was wrong');
  assert.equal(reopened.state, 'voting');
  assert.equal(reopened.decidedOption, null);
  assert.equal(reopened.decidedBy, null);
  assert.deepEqual(reopened.votes, {});
  assert.deepEqual(reopened.rationales, {});
  // timebox was extended (>= : open 与 reopen 可能落在同一毫秒内)
  assert.ok(reopened.timeboxAt >= d.timeboxAt);
  // fan-out happened (requestAgent called again for a1)
  await new Promise((r) => setImmediate(r));
  await waitFor(() => deps.requests.length > beforeReopen);
  board.stop();
});

test('timebox 升级: 短 timebox + requestAgent 永不返回有效票 → sweep → escalated', async () => {
  const { board } = openBoard({
    listMembers: async () => ['a1', 'a2'],
    requestAgent: async () => new Promise(() => { /* never resolves */ }),
    sweepIntervalMs: 25,
  });
  const d = await board.open(ROOM, 'q', OPTIONS, '', 5, 'A', 50);
  assert.equal(d.state, 'voting');
  await waitFor(() => board.list(ROOM).find((x) => x.id === d.id)?.state === 'escalated', 2000);
  const got = board.list(ROOM).find((x) => x.id === d.id)!;
  assert.equal(got.state, 'escalated');
  assert.ok(got.escalatedAt !== null);
  assert.equal(board.metrics.escalated, 1);
  board.stop();
});

test('timebox 升级后人类超时采用默认项: 可测——escalated 后再等 timeboxMs → auto_default', async () => {
  // sweep() runs every sweepIntervalMs. For each escalated row whose
  // escalated_at + timebox_ms < now, it calls decide(defaultOption, 'auto_default').
  // We open with timeboxMs=50, wait for escalated, then wait >50ms more so that
  // escalated_at + 50 < now triggers the next sweep to auto_default.
  const { board } = openBoard({
    listMembers: async () => ['a1'],
    requestAgent: async () => new Promise(() => { /* never resolves */ }),
    sweepIntervalMs: 20,
  });
  const d = await board.open(ROOM, 'q', OPTIONS, '', 5, 'A', 50);
  await waitFor(() => board.list(ROOM).find((x) => x.id === d.id)?.state === 'escalated', 2000);
  // Now wait past escalated_at + timeboxMs for the next sweep.
  await waitFor(
    () => board.list(ROOM).find((x) => x.id === d.id)?.state === 'decided',
    2000,
  );
  const got = board.list(ROOM).find((x) => x.id === d.id)!;
  assert.equal(got.state, 'decided');
  assert.equal(got.decidedOption, 'A', 'auto_default picks declared defaultOption');
  assert.equal(got.decidedBy, 'auto_default');
  assert.equal(board.metrics.autoDefaulted, 1);
  board.stop();
});

test('list(room): 返回该房间全部决策(默认按 created_at DESC LIMIT 20)', async () => {
  const { board } = openBoard({
    listMembers: async () => [],
    requestAgent: async () => ({}),
  });
  const d1 = await board.open(ROOM, 'q1', OPTIONS, '', 1, 'A', 60_000);
  // small gap so created_at differs deterministically
  await new Promise((r) => setTimeout(r, 5));
  const d2 = await board.open(ROOM, 'q2', OPTIONS, '', 1, 'A', 60_000);
  await new Promise((r) => setTimeout(r, 5));
  const d3 = await board.open('other-room', 'q3', OPTIONS, '', 1, 'A', 60_000);

  const inRoom = board.list(ROOM);
  const ids = inRoom.map((x) => x.id);
  assert.deepEqual(ids, [d2.id, d1.id], 'ordered by created_at DESC, excludes other rooms');
  assert.equal(inRoom.length, 2);
  assert.ok(inRoom.every((x) => x.room === ROOM));
  // The other room has its own
  const other = board.list('other-room');
  assert.deepEqual(other.map((x) => x.id), [d3.id]);
  // All carry the open() defaults
  assert.equal(inRoom[0].question, 'q2');
  assert.equal(inRoom[1].question, 'q1');
  board.stop();
});
