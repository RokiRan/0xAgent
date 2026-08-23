#!/usr/bin/env node
// ============================================================
// CLI Entry
// A minimal REPL for interacting with the agent.
// ============================================================

import { Harness } from './harness.js';
import { createInterface } from 'readline';

const API_KEY = process.env.OPENAI_API_KEY ?? '';
if (!API_KEY) {
  console.error('Error: Set OPENAI_API_KEY environment variable.');
  process.exit(1);
}

const harness = new Harness({
  modelProvider: 'openai',
  model: {
    apiKey: API_KEY,
    model: 'gpt-4o-mini',
    temperature: 0.7,
  },
  tools: {
    filesystem: {
      rootPath: process.cwd(),
    },
    shell: {
      cwd: process.cwd(),
      timeout: 30000,
    },
  },
  agent: {
    maxIterations: 10,
  },
});

await harness.start();
console.log('Agent harness ready. Type "exit" to quit.\n');

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (prompt: string): Promise<string> =>
  new Promise((resolve) => rl.question(prompt, resolve));

let sessionId = 'default-session';

while (true) {
  const input = await ask('You: ');
  if (input.trim().toLowerCase() === 'exit') break;

  try {
    const response = await harness.chat(sessionId, input);
    console.log(`Agent: ${response}\n`);
  } catch (err) {
    console.error('Error:', err);
  }
}

rl.close();
console.log('Goodbye.');
