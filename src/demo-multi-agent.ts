// ============================================================
// Demo: Multi-Agent Communication
// Two agents (Alice & Bob) talk to each other via agent:bus.
// ============================================================

import { Kernel } from './core/kernel.js';
import { agentBusPlugin, AgentBus, MemoryTransport } from './plugins/agent-bus/bus.js';

async function demo() {
  console.log('=== Multi-Agent Communication Demo ===\n');

  // Create two kernels (simulating two agent instances)
  const aliceKernel = new Kernel();
  const bobKernel = new Kernel();

  // Register bus plugin for Alice
  aliceKernel.register({
    ...agentBusPlugin,
    activate: async (ctx) => {
      const bus = new (await import('./plugins/agent-bus/bus.js')).AgentBusImpl(
        'alice',
        new MemoryTransport()
      );
      await bus.connect();
      ctx.services.register('agent:bus', bus);
      ctx.events.emit('agent:bus:connected', { agentId: 'alice' });
    },
  });

  // Register bus plugin for Bob
  bobKernel.register({
    ...agentBusPlugin,
    activate: async (ctx) => {
      const bus = new (await import('./plugins/agent-bus/bus.js')).AgentBusImpl(
        'bob',
        new MemoryTransport()
      );
      await bus.connect();
      ctx.services.register('agent:bus', bus);
      ctx.events.emit('agent:bus:connected', { agentId: 'bob' });
    },
  });

  // Start both
  await aliceKernel.loadAll();
  await bobKernel.loadAll();

  const aliceBus = aliceKernel.context.services.get('agent:bus') as AgentBus;
  const bobBus = bobKernel.context.services.get('agent:bus') as AgentBus;

  // --- Test 1: Simple message (event) ---
  console.log('--- Test 1: Event Message ---');
  bobBus.onMessage((msg) => {
    console.log(`[Bob] Received from ${msg.from}:`, msg.payload);
  });

  await aliceBus.send('bob', { type: 'greeting', text: 'Hello Bob, this is Alice!' });
  await new Promise((r) => setTimeout(r, 100));

  // --- Test 2: Request / Response ---
  console.log('\n--- Test 2: Request/Response ---');
  bobBus.onRequest((payload: any, reply) => {
    console.log(`[Bob] Handling request:`, payload);
    reply({ result: payload.number * 2, processedBy: 'bob' });
  });

  const response = await aliceBus.request('bob', { number: 21 }, 5000);
  console.log(`[Alice] Got response:`, response);

  // --- Test 3: Broadcast ---
  console.log('\n--- Test 3: Broadcast ---');
  let received = 0;
  aliceBus.onMessage((msg) => {
    if (msg.to === 'broadcast') {
      console.log(`[Alice] Received broadcast:`, msg.payload);
      received++;
    }
  });
  bobBus.onMessage((msg) => {
    if (msg.to === 'broadcast') {
      console.log(`[Bob] Received broadcast:`, msg.payload);
      received++;
    }
  });

  // Add a third agent to show broadcast works across all
  const charlieKernel = new Kernel();
  charlieKernel.register({
    ...agentBusPlugin,
    activate: async (ctx) => {
      const bus = new (await import('./plugins/agent-bus/bus.js')).AgentBusImpl(
        'charlie',
        new MemoryTransport()
      );
      await bus.connect();
      ctx.services.register('agent:bus', bus);
    },
  });
  await charlieKernel.loadAll();
  const charlieBus = charlieKernel.context.services.get('agent:bus') as AgentBus;
  charlieBus.onMessage((msg) => {
    if (msg.to === 'broadcast') {
      console.log(`[Charlie] Received broadcast:`, msg.payload);
      received++;
    }
  });

  await aliceBus.broadcast({ type: 'announcement', text: 'All hands meeting in 5 min' });
  await new Promise((r) => setTimeout(r, 100));

  console.log(`\nTotal broadcast receivers: ${received}`);

  // --- Test 4: Timeout handling ---
  console.log('\n--- Test 4: Request Timeout ---');
  try {
    await aliceBus.request('nonexistent', { test: 'timeout' }, 500);
  } catch (err) {
    console.log(`[Alice] Expected timeout error: ${(err as Error).message}`);
  }

  console.log('\n=== Demo Complete ===');
}

demo().catch(console.error);
