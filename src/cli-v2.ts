#!/usr/bin/env node
// ============================================================
// CLI V2: Interactive terminal client for Harness V2
// With SQLite persistence and vector memory.
// ============================================================

import { HarnessV2, HarnessV2Config } from './harness-v2.js';
import { createInterface } from 'readline';
import { stdin, stdout } from 'process';

function loadEnvConfig(): Partial<HarnessV2Config> {
  const provider = process.env.AGENT_MODEL_PROVIDER as 'openai' | 'minimax' | undefined;

  if (provider === 'minimax') {
    return {
      modelProvider: 'minimax',
      model: {
        apiKey: process.env.MINIMAX_API_KEY ?? '',
        baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1',
        model: process.env.MINIMAX_MODEL ?? 'MiniMax-M3',
      },
    };
  }

  return {
    modelProvider: 'openai',
    model: {
      apiKey: process.env.OPENAI_API_KEY ?? '',
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    },
  };
}

const envConfig = loadEnvConfig();

if (!envConfig.model?.apiKey) {
  console.error('Error: Set OPENAI_API_KEY or MINIMAX_API_KEY environment variable.');
  process.exit(1);
}

// Persistent storage
const DB_PATH = process.env.AGENT_DB_PATH ?? './data/threads.db';

const harness = new HarnessV2({
  ...envConfig,
  filesystem: {
    rootPath: process.cwd(),
  },
  agent: {
    maxIterations: 10,
    systemInstruction: 'You are a helpful coding assistant. Be concise. Use tools when needed.',
    enableCompaction: true,
    compactionThreshold: 12000,
  },
  approval: {
    readonly: false,
    network: false,
    autoApprove: ['filesystem:read', 'filesystem:list'],
    confirm: ['filesystem:write', 'filesystem:mkdir', 'shell', 'code'],
    reject: [],
  },
  persistence: {
    dbPath: DB_PATH,
  },
  enableMemory: true,
  transports: ['stdio', 'websocket'],
  webUI: {
    enabled: true,
    port: 3456,
  },
} as HarnessV2Config);

await harness.start();

const rl = createInterface({ input: stdin, output: stdout });
const ask = (prompt: string): Promise<string> => new Promise(resolve => rl.question(prompt, resolve));

console.log('\n┌─────────────────────────────────────────┐');
console.log('│  Agent Harness V2 - Codex-inspired     │');
console.log('│  Commands: /new /fork /list /archive   │');
console.log('│           /memory /search /help        │');
console.log('└─────────────────────────────────────────┘\n');

let currentThreadId = '';

// Helper to send JSON-RPC request
function sendRequest(method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const id = Date.now();
    const req = { jsonrpc: '2.0', id, method, params };
    console.log(JSON.stringify(req));

    // In real usage, the App Server would respond via stdout
    // For this demo, we resolve with mock responses
    setTimeout(() => {
      resolve({ ok: true });
    }, 100);
  });
}

async function createThread(): Promise<string> {
  const server = harness.server;
  if (!server) throw new Error('Server not initialized');

  // Access the thread manager directly (for demo)
  // In production, use JSON-RPC
  currentThreadId = `thread-${Date.now()}`;
  console.log(`[New thread: ${currentThreadId}]\n`);
  return currentThreadId;
}

await createThread();

while (true) {
  const input = await ask('You: ');
  const trimmed = input.trim();

  if (trimmed.toLowerCase() === 'exit') break;

  // Slash commands
  if (trimmed.startsWith('/')) {
    const [cmd, ...args] = trimmed.slice(1).split(' ');
    switch (cmd) {
      case 'new':
        await createThread();
        continue;
      case 'fork': {
        console.log(`[Fork thread not yet implemented in CLI]\n`);
        continue;
      }
      case 'list': {
        console.log(`[Thread list not yet implemented in CLI]\n`);
        continue;
      }
      case 'archive': {
        console.log(`[Archived: ${currentThreadId}]`);
        await createThread();
        continue;
      }
      case 'memory': {
        const query = args.join(' ');
        if (!query) {
          console.log('Usage: /memory <query>');
          continue;
        }
        console.log(`[Searching memory for: ${query}]\n`);
        // Memory search would go here
        continue;
      }
      case 'search': {
        const query = args.join(' ');
        if (!query) {
          console.log('Usage: /search <query>');
          continue;
        }
        console.log(`[Searching threads for: ${query}]\n`);
        continue;
      }
      case 'help': {
        console.log('\nCommands:');
        console.log('  /new       - Create new thread');
        console.log('  /fork      - Fork current thread');
        console.log('  /list      - List all threads');
        console.log('  /archive   - Archive current thread');
        console.log('  /memory    - Search vector memory');
        console.log('  /search    - Search thread contents');
        console.log('  exit       - Quit\n');
        continue;
      }
      default:
        console.log('Unknown command. Type /help for available commands.');
        continue;
    }
  }

  try {
    console.log(`[Processing: ${trimmed.slice(0, 50)}...]\n`);
    // In a real implementation, this would use the App Server's JSON-RPC
    console.log(`[Turn submitted to thread: ${currentThreadId}]\n`);
  } catch (err) {
    console.error('Error:', err);
  }
}

rl.close();
harness.stop();
console.log('Goodbye.');
