// ============================================================
// Core: Plugin Interface
// Every capability in the harness is a plugin.
// ============================================================

import { EventBus } from './event-bus.js';
import { ServiceRegistry } from './service-registry.js';

export interface PluginContext {
  services: ServiceRegistry;
  events: EventBus;
  config: Record<string, unknown>;
}

export interface Plugin {
  name: string;
  dependencies?: string[];
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(ctx: PluginContext): Promise<void> | void;
}
