// ============================================================
// MCP Plugin: Expose Harness tools as MCP Server
// Also integrates external MCP servers as Harness tools
// ============================================================

import { Plugin, PluginContext } from '../core/plugin.js';
import { Tool } from '../plugins/tools/interface.js';
import { McpServer, McpClient, McpStdioTransport } from './protocol.js';

export interface McpPluginConfig {
  // Server mode: expose Harness tools via MCP
  server?: {
    enabled: boolean;
    name?: string;
    version?: string;
    transport?: 'stdio';
  };
  // Client mode: connect to external MCP servers
  clients?: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

export const mcpPlugin: Plugin = {
  name: 'mcp',
  dependencies: ['tool:registry'],
  async activate(ctx: PluginContext) {
    const config = ctx.config as unknown as McpPluginConfig;

    // ── Server Mode ──
    if (config.server?.enabled) {
      const server = new McpServer({
        name: config.server.name ?? 'agent-harness',
        version: config.server.version ?? '0.1.0',
      });

      // Expose all registered tools as MCP tools
      const registry = ctx.services.get('tool:registry') as { list: () => Tool[] };
      const tools = registry.list();

      for (const tool of tools) {
        server.registerTool(
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          },
          async (args) => {
            const result = await tool.execute(args);
            return [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }];
          }
        );
      }

      ctx.services.register('mcp:server', server);

      if (config.server.transport === 'stdio') {
        const transport = new McpStdioTransport(server);
        transport.start();
        console.log('[mcp] Server started on stdio');
      }
    }

    // ── Client Mode ──
    if (config.clients && config.clients.length > 0) {
      const externalTools: Tool[] = [];

      for (const clientConfig of config.clients) {
        try {
          const client = new McpClient({
            command: clientConfig.command,
            args: clientConfig.args,
            env: clientConfig.env,
          });

          await client.connect();
          const tools = client.getTools();

          for (const tool of tools) {
            externalTools.push({
              name: `${clientConfig.name}:${tool.name}`,
              description: `[${clientConfig.name}] ${tool.description ?? tool.name}`,
              parameters: tool.inputSchema as Tool['parameters'],
              async execute(args) {
                const content = await client.callTool(tool.name, args);
                return content.map(c => c.type === 'text' ? c.text : `[image: ${c.mimeType}]`).join('\n');
              },
            });
          }

          console.log(`[mcp] Connected to ${clientConfig.name}, imported ${tools.length} tools`);
        } catch (err) {
          console.error(`[mcp] Failed to connect to ${clientConfig.name}:`, err);
        }
      }

      // Register external tools
      const registry = ctx.services.get('tool:registry') as { register: (t: Tool) => void };
      for (const tool of externalTools) {
        registry.register(tool);
      }

      ctx.services.register('mcp:external_tools', externalTools);
    }
  },
};
