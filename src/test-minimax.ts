// ============================================================
// Test: MiniMax Provider
// ============================================================

import { Harness } from './harness.js';

const API_KEY = 'sk-cp-zV6BqlqH98pU37wyTYDSSXEomnM6ni11DwtHteLliQrcLx9UZXgHMCvHT4YwXmu3J2dHgRM3bBa2CwwE6giSTMMN6NYdkYR-SKfPs4z8LQh_2nLqKJIPBRc';

const harness = new Harness({
  modelProvider: 'minimax',
  model: {
    apiKey: API_KEY,
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M3',
    temperature: 0.7,
  },
  tools: {
    filesystem: {
      rootPath: '/root/.openclaw/workspace/agent-harness',
    },
    shell: {
      cwd: '/root/.openclaw/workspace/agent-harness',
      timeout: 30000,
    },
  },
  agent: {
    maxIterations: 10,
  },
});

async function test() {
  await harness.start();
  console.log('MiniMax harness ready.\n');

  // Test 1: Simple chat
  console.log('--- Test 1: Simple Chat ---');
  const r1 = await harness.chat('test-1', 'Hello, who are you?');
  console.log('Response:', r1, '\n');

  // Test 2: Tool use (filesystem)
  console.log('--- Test 2: Filesystem Tool ---');
  const r2 = await harness.chat('test-2', 'List files in the current directory');
  console.log('Response:', r2, '\n');

  // Test 3: Tool use (shell)
  console.log('--- Test 3: Shell Tool ---');
  const r3 = await harness.chat('test-3', 'Run "echo hello from minimax" in shell');
  console.log('Response:', r3, '\n');

  console.log('All tests completed.');
}

test().catch(console.error);
