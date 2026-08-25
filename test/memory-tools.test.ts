// memory-tools.test.ts — memory_remember / memory_search 工具契约：
// agent 在循环里主动写记忆、跨轮检索召回（不再只靠被动历史注入）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ThreadMemory } from '../src/core/vector-memory.js';
import { MemoryRememberTool, MemorySearchTool, registerMemoryTools } from '../src/plugins/tools/memory.js';
import { ToolRegistryImpl } from '../src/plugins/tools/registry.js';

test('remember 后经 search 可召回,role=note', async () => {
  const mem = new ThreadMemory();
  const remember = new MemoryRememberTool(mem);
  const search = new MemorySearchTool(mem);

  await remember.execute({ content: '树莓派的局域网地址是 10.0.0.191' });
  const out = (await search.execute({ query: '树莓派局域网地址' })) as {
    count: number;
    results: Array<{ content: string; role: string }>;
  };

  assert.equal(out.count, 1);
  assert.equal(out.results[0].content, '树莓派的局域网地址是 10.0.0.191');
  assert.equal(out.results[0].role, 'note');
});

test('remember/search 拒绝空输入', async () => {
  const mem = new ThreadMemory();
  await assert.rejects(new MemoryRememberTool(mem).execute({ content: '  ' }), /non-empty/);
  await assert.rejects(new MemorySearchTool(mem).execute({ query: '' }), /non-empty/);
});

test('registerMemoryTools 注册两个工具到 registry', () => {
  const registry = new ToolRegistryImpl();
  registerMemoryTools(registry, new ThreadMemory());
  assert.ok(registry.get('memory_remember'));
  assert.ok(registry.get('memory_search'));
});
