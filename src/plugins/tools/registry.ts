// ============================================================
// Tool Registry (standalone-usable)
// Shared by the kernel plugin path (filesystemPlugin) and
// non-kernel hosts such as the bus-agent.
// ============================================================

import { Tool, ToolRegistry } from './interface.js';

export class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
  list(): Tool[] {
    return Array.from(this.tools.values());
  }
}
