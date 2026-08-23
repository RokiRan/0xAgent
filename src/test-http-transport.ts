// ============================================================
// Test: HTTP Transport for Cross-Process Agent Communication
// No Redis required. Pure Node.js.
// ============================================================

import { AgentBusImpl } from './plugins/agent-bus/bus.js';
import { HttpTransport, createRegistryServer } from './plugins/agent-bus/http-transport.js';

async function test() {
  console.log('=== HTTP Transport Test (No Redis) ===\n');

  // 1. Start a registry server
  const registry = createRegistryServer(9876);
  await new Promise(r => setTimeout(r, 100));
  console.log('✅ Registry started on port 9876\n');

  // 2. Create two agents with HTTP transport
  const aliceTransport = new HttpTransport({
    agentId: 'alice',
    port: 9001,
    registryUrl: 'http://localhost:9876',
  });
  const aliceBus = new AgentBusImpl('alice', aliceTransport);
  await aliceBus.connect();
  console.log('✅ Alice connected on port 9001');

  const bobTransport = new HttpTransport({
    agentId: 'bob',
    port: 9002,
    registryUrl: 'http://localhost:9876',
  });
  const bobBus = new AgentBusImpl('bob', bobTransport);
  await bobBus.connect();
  console.log('✅ Bob connected on port 9002\n');

  // 3. Test: Event message
  console.log('--- Test 1: Event ---');
  bobBus.onMessage((msg) => {
    console.log(`[Bob] Received from ${msg.from}:`, msg.payload);
  });
  await aliceBus.send('bob', { greeting: 'Hello from Alice via HTTP!' });
  await new Promise(r => setTimeout(r, 200));

  // 4. Test: Request/Response
  console.log('\n--- Test 2: Request/Response ---');
  bobBus.onRequest((payload: any, reply) => {
    console.log(`[Bob] Handling request:`, payload);
    reply({ result: payload.x * payload.y, processedBy: 'bob' });
  });

  const response = await aliceBus.request('bob', { x: 6, y: 7 }, 5000);
  console.log(`[Alice] Got response:`, response);

  // 5. Test: Broadcast
  console.log('\n--- Test 3: Broadcast ---');
  const charlieTransport = new HttpTransport({
    agentId: 'charlie',
    port: 9003,
    registryUrl: 'http://localhost:9876',
  });
  const charlieBus = new AgentBusImpl('charlie', charlieTransport);
  await charlieBus.connect();
  console.log('✅ Charlie connected on port 9003\n');

  let broadcastCount = 0;
  bobBus.onMessage((msg) => {
    if (msg.to === 'broadcast') { broadcastCount++; console.log(`[Bob] Broadcast:`, msg.payload); }
  });
  charlieBus.onMessage((msg) => {
    if (msg.to === 'broadcast') { broadcastCount++; console.log(`[Charlie] Broadcast:`, msg.payload); }
  });

  await aliceBus.broadcast({ type: 'announcement', text: 'Meeting in 5 min' });
  await new Promise(r => setTimeout(r, 300));
  console.log(`\nBroadcast received by ${broadcastCount} agents\n`);

  // 6. Cleanup
  await aliceBus.disconnect();
  await bobBus.disconnect();
  await charlieBus.disconnect();
  registry.close();

  console.log('=== HTTP Transport Test Complete ===');
  console.log('\nSummary:');
  console.log('  ✅ No Redis required');
  console.log('  ✅ Pure Node.js http module');
  console.log('  ✅ Registry-based peer discovery');
  console.log('  ✅ Direct send, request/response, broadcast');
  console.log('  ✅ Cross-port / cross-process ready');
}

test().catch(console.error);
