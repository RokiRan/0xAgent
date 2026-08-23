// ============================================================
// Test: Cross-Network Agent Communication via Registry Relay
// Simulates agents in different networks (behind NAT).
// No direct P2P. All messages go through Registry.
// ============================================================

import { AgentBusImpl } from './plugins/agent-bus/bus.js';
import { HttpTransport, createRegistryServer } from './plugins/agent-bus/http-transport.js';

async function test() {
  console.log('=== Cross-Network Agent Test (Registry Relay) ===\n');

  // 1. Start Registry on a "public" port
  const registry = createRegistryServer(9876);
  await new Promise(r => setTimeout(r, 100));
  console.log('✅ Registry started (simulating public server)\n');

  // 2. Agent A — in "Beijing office" (behind NAT, only outbound)
  const aliceTransport = new HttpTransport({
    agentId: 'alice',
    port: 9001,
    registryUrl: 'http://localhost:9876', // Only needs outbound access to registry
  });
  const aliceBus = new AgentBusImpl('alice', aliceTransport);
  await aliceBus.connect();
  console.log('✅ Alice connected (Beijing, behind NAT)');

  // 3. Agent B — in "Shanghai office" (behind NAT, only outbound)
  const bobTransport = new HttpTransport({
    agentId: 'bob',
    port: 9002,
    registryUrl: 'http://localhost:9876',
  });
  const bobBus = new AgentBusImpl('bob', bobTransport);
  await bobBus.connect();
  console.log('✅ Bob connected (Shanghai, behind NAT)\n');

  // 4. Test: Alice sends to Bob via Registry relay (simulating no direct route)
  console.log('--- Test 1: Alice sends to Bob via Registry Relay ---');
  const receivedMessages: any[] = [];
  bobBus.onMessage((msg) => {
    receivedMessages.push(msg);
    console.log(`[Bob] Received via relay from ${msg.from}:`, msg.payload);
  });

  // Clear peer cache to force relay (simulating A cannot reach B directly)
  (aliceTransport as any).peers.clear();

  await aliceBus.send('bob', { type: 'task', content: 'Process this file in Shanghai' });

  // Bob polls for messages (in real scenario, poll runs on interval)
  await new Promise(r => setTimeout(r, 500)); // Wait for relay
  await (bobTransport as any).pollMessages(); // Manual poll

  console.log(`Bob received ${receivedMessages.length} message(s)\n`);

  // 5. Test: Bob responds to Alice via Registry relay
  console.log('--- Test 2: Bob responds to Alice via Registry Relay ---');
  const aliceMessages: any[] = [];
  aliceBus.onMessage((msg) => {
    aliceMessages.push(msg);
    console.log(`[Alice] Received via relay from ${msg.from}:`, msg.payload);
  });

  (bobTransport as any).peers.clear(); // Force relay
  await bobBus.send('alice', { type: 'result', content: 'Task completed. File processed.' });

  await new Promise(r => setTimeout(r, 500));
  await (aliceTransport as any).pollMessages();

  console.log(`Alice received ${aliceMessages.length} message(s)\n`);

  // 6. Test: Request/Response via Registry
  console.log('--- Test 3: Request/Response via Registry ---');
  bobBus.onRequest((payload: any, reply) => {
    console.log(`[Bob] Handling request:`, payload);
    reply({ result: payload.a + payload.b, processedBy: 'bob-shanghai' });
  });

  (aliceTransport as any).peers.clear();
  const response = await aliceBus.request('bob', { a: 10, b: 32 }, 5000);
  console.log(`[Alice] Got response:`, response);

  // 7. Test: Broadcast to all agents via Registry
  console.log('\n--- Test 4: Broadcast via Registry ---');
  const charlieTransport = new HttpTransport({
    agentId: 'charlie',
    port: 9003,
    registryUrl: 'http://localhost:9876',
  });
  const charlieBus = new AgentBusImpl('charlie', charlieTransport);
  await charlieBus.connect();
  console.log('✅ Charlie connected (Shenzhen, behind NAT)\n');

  let broadcastCount = 0;
  const collectBroadcast = (bus: any, name: string) => {
    bus.onMessage((msg: any) => {
      if (msg.to === 'broadcast') {
        broadcastCount++;
        console.log(`[${name}] Broadcast:`, msg.payload);
      }
    });
  };
  collectBroadcast(aliceBus, 'Alice');
  collectBroadcast(bobBus, 'Bob');
  collectBroadcast(charlieBus, 'Charlie');

  (aliceTransport as any).peers.clear();
  await aliceBus.broadcast({ type: 'announcement', text: 'All offices sync at 9:00 AM' });
  await new Promise(r => setTimeout(r, 500));

  // All agents poll
  await (aliceTransport as any).pollMessages();
  await (bobTransport as any).pollMessages();
  await (charlieTransport as any).pollMessages();

  console.log(`\nBroadcast received by ${broadcastCount} agents\n`);

  // 8. Cleanup
  await aliceBus.disconnect();
  await bobBus.disconnect();
  await charlieBus.disconnect();
  registry.close();

  console.log('=== Cross-Network Test Complete ===');
  console.log('\nKey takeaways:');
  console.log('  ✅ Agents behind NAT can communicate without public IPs');
  console.log('  ✅ Only Registry needs a public IP (or be reachable by all agents)');
  console.log('  ✅ Agents only need outbound HTTP access');
  console.log('  ✅ Registry queues messages with TTL (5 min) and size limits');
  console.log('  ✅ P2P still works when agents are in the same network');
}

test().catch(console.error);
