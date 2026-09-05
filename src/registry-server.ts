#!/usr/bin/env node
// ============================================================
// Standalone Agent Bus Registry Relay
// Runs on a public-reachable host; agents behind NAT poll it.
//   REGISTRY_PORT=9876 REGISTRY_STATE_FILE=./registry-state.json \
//   BUS_TOKEN=shared-secret node registry.mjs
// ============================================================

import { createRegistryServer } from './plugins/agent-bus/http-transport.js';

const port = Number(process.env.REGISTRY_PORT ?? 9876);
createRegistryServer(port, {
  stateFile: process.env.REGISTRY_STATE_FILE,
  token: process.env.BUS_TOKEN || undefined,
  ledgerFile: process.env.REGISTRY_LEDGER_FILE,
  uploadsDir: process.env.REGISTRY_UPLOADS_DIR,
});
if (process.env.BUS_TOKEN) console.log('[AgentBus] Token gate enabled');
if (process.env.REGISTRY_LEDGER_FILE) console.log('[AgentBus] LLM ledger enabled');
if (process.env.REGISTRY_UPLOADS_DIR) console.log('[AgentBus] Uploads enabled');
