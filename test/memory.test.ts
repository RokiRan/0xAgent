// ThreadMemory 契约测试：thread 隔离检索、显式检索不过滤、过取补偿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadMemory } from '../src/core/vector-memory.js';
import type { Thread, Item } from '../src/core/thread.js';

const mkThread = (id: string, content: string): Thread => ({
  id,
  title: id,
  createdAt: 0,
  updatedAt: 0,
  status: 'active',
  turns: [
    {
      id: `${id}-turn`,
      threadId: id,
      status: 'completed',
      startedAt: 0,
      items: [
        { id: `${id}-item`, type: 'message', role: 'user', content, status: 'completed', createdAt: 0 } satisfies Item,
      ],
    },
  ],
});

test('thread 隔离: scoped 检索只含本 thread，内容不串', () => {
  const mem = new ThreadMemory();
  mem.indexThread(mkThread('t1', '苹果公司的供应链策略分析'));
  mem.indexThread(mkThread('t2', '香蕉种植的土壤要求'));

  // 嵌入器是字符 trigram：查询必须与目标文档共享 ≥3 字窗口（'水果' 只有 2 字，得零分）
  const scoped = mem.search('供应链', 5, 't1');
  assert.ok(scoped.length > 0, 'scoped 有结果');
  assert.ok(scoped.every((r) => r.threadId === 't1'), 'scoped 只含本 thread');

  const ctx = mem.getRelevantContext('供应链', 2000, 't1');
  assert.ok(ctx.includes('苹果'), 'scoped context 含本 thread 内容');
  assert.ok(!ctx.includes('香蕉'), 'scoped context 不含他 thread 内容（隔离漏洞回归点）');
});

test('显式检索默认不过滤: 跨 thread 可见（memory/search API 语义）', () => {
  const mem = new ThreadMemory();
  mem.indexThread(mkThread('t1', '苹果公司的供应链策略分析'));
  mem.indexThread(mkThread('t2', '香蕉种植的土壤要求'));
  // 契约重点: 不传 threadId 时不强制过滤——显式工具保留跨会话召回能力
  const t1Hits = mem.search('供应链', 5);
  assert.ok(t1Hits.some((r) => r.threadId === 't1'), '无 scope 命中 t1');
  const t2Hits = mem.search('土壤要求', 5);
  assert.ok(t2Hits.some((r) => r.threadId === 't2'), '无 scope 命中 t2');
});

test('过取补偿: 过滤后仍能给足 topK（fetch 4x 再过滤）', () => {
  const mem = new ThreadMemory();
  // t2 塞 10 条高分干扰项，t1 只有 1 条——若不过取，scoped 可能空手而归
  for (let i = 0; i < 10; i++) mem.indexThread(mkThread(`t2-${i}`, '数据库索引优化方案'));
  mem.indexThread(mkThread('t1-a', '数据库查询缓存设计'));
  const scoped = mem.search('数据库', 2, 't1-a');
  assert.ok(scoped.length > 0, 'scoped 有结果');
  assert.ok(scoped.every((r) => r.threadId === 't1-a'), '干扰项被过滤');
});

test('空结果: 无匹配 thread 时返回空而非报错', () => {
  const mem = new ThreadMemory();
  mem.indexThread(mkThread('t1', '一些内容'));
  assert.deepEqual(mem.search('查询', 5, 'nonexistent-thread'), []);
  assert.equal(mem.getRelevantContext('查询', 2000, 'nonexistent-thread'), '');
});
