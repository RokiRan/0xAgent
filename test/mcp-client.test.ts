// =============================================================================
// mcp-client.test.ts — MCP client stdio 传输的真实往返契约
// -----------------------------------------------------------------------------
// 目标：McpClient 的 request() 写路径曾经是 stub（只登记 pending 从不写
//       transport）。这里用行分隔 JSON 的 mock server 做真实 stdio 往返，
//       锁住三条可观察契约：
//         1. connect → tools/list → tools/call 全链路往返
//         2. server 中途死亡 → in-flight 请求必须 reject（不许悬挂）
//         3. server 死后新请求必须立即失败（无 transport）
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { McpClient } from '../src/mcp/protocol.js';

// 行分隔 JSON-RPC mock：initialize/tools/list/tools/call 正常应答；
// tools/call(die) 不应答直接退出，用于触发 pending-reject 路径。
const MOCK_SERVER = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '0.0.1' } });
    case 'tools/list':
      return reply({ tools: [
        { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'die', description: 'Exit without replying', inputSchema: { type: 'object', properties: {} } },
      ] });
    case 'tools/call':
      if (msg.params?.name === 'die') process.exit(1);
      return reply({ content: [{ type: 'text', text: 'ECHO:' + msg.params?.arguments?.text }], isError: false });
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }) + '\\n');
  }
});
`;

const connectMock = () =>
  new McpClient({
    command: process.execPath,
    args: ['--input-type=module', '--eval', MOCK_SERVER],
    requestTimeoutMs: 5000,
  });

test('connect 后 tools/list 与 tools/call 真实往返', async () => {
  const client = connectMock();
  await client.connect();
  try {
    const names = client.getTools().map(t => t.name).sort();
    assert.deepEqual(names, ['die', 'echo']);

    const out = await client.callTool('echo', { text: 'round-trip' });
    assert.equal(out[0]?.type, 'text');
    assert.equal(out[0]?.type === 'text' ? out[0].text : '', 'ECHO:round-trip');
  } finally {
    client.disconnect();
  }
});

test('server 中途死亡:in-flight 请求 reject 而非悬挂', async () => {
  const client = connectMock();
  await client.connect();
  await assert.rejects(client.callTool('die', {}), /exited/);
  client.disconnect();
});

test('server 死后:新请求立即失败(no transport)', async () => {
  const client = connectMock();
  await client.connect();
  await assert.rejects(client.callTool('die', {}), /exited/);
  await assert.rejects(client.callTool('echo', { text: 'x' }), /not connected/);
  client.disconnect();
});
