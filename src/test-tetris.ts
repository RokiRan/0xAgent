// ============================================================
// Test: Build Tetris HTML Game using Agent Harness
// ============================================================

import { Harness } from './harness.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
    maxIterations: 15,
  },
});

const GAME_DIR = '/root/.openclaw/workspace/agent-harness/tetris-game';

async function main() {
  await harness.start();
  console.log('Agent harness ready. Building Tetris...\n');

  // Task 1: Create the game directory and HTML file
  const task1 = `
Create a complete Tetris HTML game in the directory "tetris-game".

Requirements:
1. Create directory "tetris-game" if not exists
2. Create a file "tetris-game/index.html" with a fully functional Tetris game
3. The game must include:
   - Classic 7 tetromino pieces (I, O, T, S, Z, J, L)
   - 10x20 game board
   - Keyboard controls (left/right/down arrows to move, up to rotate, space to drop)
   - Score tracking and level progression
   - Game over detection
   - Clean visual design with CSS
   - Next piece preview
   - Line clearing with animation
4. Use pure HTML/CSS/JavaScript in a single file (or separate CSS/JS files if you prefer)
5. The game must be playable and visually clear

Use the filesystem tool to create files and the shell tool to verify.
`;

  console.log('--- Task: Create Tetris Game ---');
  const r1 = await harness.chat('tetris-session', task1);
  console.log(r1);

  // Check if file was created
  console.log('\n--- Checking files ---');
  try {
    const { stdout } = await execAsync(`ls -la ${GAME_DIR}/`);
    console.log('Files created:', stdout);
  } catch {
    console.log('Directory not found, game creation may have failed');
  }
}

main().catch(console.error);
