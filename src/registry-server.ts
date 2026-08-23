#!/usr/bin/env node
// ============================================================
// Standalone Agent Bus Registry Relay
// Runs on a public-reachable host; agents behind NAT poll it.
//   REGISTRY_PORT=9876 node registry.mjs
// ============================================================

import { createRegistryServer } from './plugins/agent-bus/http-transport.js';

const port = Number(process.env.REGISTRY_PORT ?? 9876);
createRegistryServer(port);
