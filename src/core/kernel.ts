// ============================================================
// Core: Kernel
// The heart of the harness. Manages plugin lifecycle.
// ============================================================

import { Plugin, PluginContext } from './plugin.js';
import { EventBus } from './event-bus.js';
import { ServiceRegistry } from './service-registry.js';

export class Kernel {
  private plugins = new Map<string, Plugin>();
  private loaded = new Set<string>();
  private ctx: PluginContext;

  constructor(config: Record<string, unknown> = {}) {
    this.ctx = {
      services: new ServiceRegistry(),
      events: new EventBus(),
      config,
    };
  }

  get context(): PluginContext {
    return this.ctx;
  }

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" already registered`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  async load(name: string): Promise<void> {
    if (this.loaded.has(name)) return;

    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin "${name}" not found`);
    }

    // Resolve dependencies first
    if (plugin.dependencies) {
      for (const dep of plugin.dependencies) {
        if (!this.loaded.has(dep)) {
          await this.load(dep);
        }
      }
    }

    // Activate
    await plugin.activate(this.ctx);
    this.loaded.add(name);
    this.ctx.events.emit('plugin:loaded', { name });
  }

  async unload(name: string): Promise<void> {
    if (!this.loaded.has(name)) return;

    const plugin = this.plugins.get(name);
    if (plugin?.deactivate) {
      await plugin.deactivate(this.ctx);
    }
    this.loaded.delete(name);
    this.ctx.events.emit('plugin:unloaded', { name });
  }

  async loadAll(): Promise<void> {
    for (const name of this.plugins.keys()) {
      if (!this.loaded.has(name)) {
        await this.load(name);
      }
    }
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  list(): string[] {
    return Array.from(this.plugins.keys());
  }

  listLoaded(): string[] {
    return Array.from(this.loaded);
  }
}
