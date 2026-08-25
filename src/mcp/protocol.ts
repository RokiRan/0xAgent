// ============================================================
// MCP Protocol: Model Context Protocol
// https://modelcontextprotocol.io
//
// This module implements both MCP Server and MCP Client:
// - Server: Exposes Harness tools/resources to external MCP clients
// - Client: Calls external MCP servers as additional tools
// ============================================================

// ── MCP Protocol Types ──

export interface McpJsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpImageContent {
  type: 'image';
  data: string; // base64
  mimeType: string;
}

export type McpContent = McpTextContent | McpImageContent;

// ── MCP Server ──
// Exposes Harness capabilities via MCP protocol

export interface McpServerConfig {
  name: string;
  version: string;
}

export class McpServer {
  private tools = new Map<string, McpTool>();
  private resources = new Map<string, McpResource>();
  private prompts = new Map<string, McpPrompt>();
  private toolHandlers = new Map<string, (args: Record<string, unknown>) => Promise<McpContent[]>>();
  private resourceHandlers = new Map<string, () => Promise<McpContent[]>>();
  private promptHandlers = new Map<string, (args: Record<string, string>) => Promise<McpContent[]>>();

  constructor(private config: McpServerConfig) {}

  // Register a tool
  registerTool(
    tool: McpTool,
    handler: (args: Record<string, unknown>) => Promise<McpContent[]>
  ): void {
    this.tools.set(tool.name, tool);
    this.toolHandlers.set(tool.name, handler);
  }

  // Register a resource
  registerResource(
    resource: McpResource,
    handler: () => Promise<McpContent[]>
  ): void {
    this.resources.set(resource.uri, resource);
    this.resourceHandlers.set(resource.uri, handler);
  }

  // Register a prompt
  registerPrompt(
    prompt: McpPrompt,
    handler: (args: Record<string, string>) => Promise<McpContent[]>
  ): void {
    this.prompts.set(prompt.name, prompt);
    this.promptHandlers.set(prompt.name, handler);
  }

  // Handle an MCP request
  async handleRequest(msg: McpJsonRpcMessage): Promise<McpJsonRpcMessage> {
    const { id, method, params } = msg;
    const base = { jsonrpc: '2.0' as const, id };

    try {
      switch (method) {
        case 'initialize': {
          const initParams = params as { protocolVersion?: string; capabilities?: unknown };
          return {
            ...base,
            result: {
              protocolVersion: initParams?.protocolVersion ?? '2024-11-05',
              capabilities: {
                tools: {},
                resources: {},
                prompts: {},
              },
              serverInfo: {
                name: this.config.name,
                version: this.config.version,
              },
            },
          };
        }

        case 'tools/list': {
          return {
            ...base,
            result: { tools: Array.from(this.tools.values()) },
          };
        }

        case 'tools/call': {
          const callParams = params as { name: string; arguments: Record<string, unknown> };
          const handler = this.toolHandlers.get(callParams.name);
          if (!handler) {
            return { ...base, error: { code: -32602, message: `Tool not found: ${callParams.name}` } };
          }
          const content = await handler(callParams.arguments);
          return { ...base, result: { content, isError: false } };
        }

        case 'resources/list': {
          return {
            ...base,
            result: { resources: Array.from(this.resources.values()) },
          };
        }

        case 'resources/read': {
          const readParams = params as { uri: string };
          const handler = this.resourceHandlers.get(readParams.uri);
          if (!handler) {
            return { ...base, error: { code: -32602, message: `Resource not found: ${readParams.uri}` } };
          }
          const content = await handler();
          return { ...base, result: { contents: [{ uri: readParams.uri, content }] } };
        }

        case 'prompts/list': {
          return {
            ...base,
            result: { prompts: Array.from(this.prompts.values()) },
          };
        }

        case 'prompts/get': {
          const promptParams = params as { name: string; arguments: Record<string, string> };
          const handler = this.promptHandlers.get(promptParams.name);
          if (!handler) {
            return { ...base, error: { code: -32602, message: `Prompt not found: ${promptParams.name}` } };
          }
          const content = await handler(promptParams.arguments);
          return { ...base, result: { description: '', messages: content.map(c => ({ role: 'assistant', content: c })) } };
        }

        case 'notifications/initialized':
          // No response needed for notifications
          return { jsonrpc: '2.0', id };

        default:
          return { ...base, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (err) {
      return { ...base, error: { code: -32603, message: String(err) } };
    }
  }
}

// ── MCP Client ──
// Connects to external MCP servers and exposes their tools as Harness tools

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';

export interface McpClientConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Per-request timeout in ms (default 30000). */
  requestTimeoutMs?: number;
  // Or connect via SSE
  url?: string;
}

export class McpClient {
  private tools: McpTool[] = [];
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stdin?: Writable;
  private child?: ChildProcess;
  private buffer = '';
  /** Per-request timeout; a silent server must not hang the caller forever. */
  private requestTimeoutMs: number;

  constructor(private config: McpClientConfig) {
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
  }

  async connect(): Promise<void> {
    if (this.config.command) {
      await this.connectStdio();
    } else if (this.config.url) {
      await this.connectSse();
    } else {
      throw new Error('MCP client requires either command or url');
    }
  }

  private async connectStdio(): Promise<void> {
    const child = spawn(this.config.command!, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stdin = child.stdin ?? undefined;

    // Newline-delimited JSON framing: a data chunk is NOT guaranteed to
    // align with message boundaries — buffer and split on '\n'.
    child.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: McpJsonRpcMessage;
        try {
          msg = JSON.parse(line) as McpJsonRpcMessage;
        } catch {
          continue; // non-JSON chatter on stdout (server logs etc.)
        }
        if (msg.id === undefined) continue; // notification, no response expected
        const entry = this.pending.get(Number(msg.id));
        if (!entry) continue;
        this.pending.delete(Number(msg.id));
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          entry.resolve(msg.result);
        }
      }
    });

    // If the server dies, every in-flight request must fail fast.
    const failAll = (reason: string) => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
      }
      this.pending.clear();
      this.stdin = undefined;
    };
    child.on('exit', (code) => failAll(`MCP server exited (code ${code})`));
    child.on('error', (err) => failAll(`MCP server error: ${String(err)}`));

    // Initialize
    try {
      await this.request({
        jsonrpc: '2.0',
        id: ++this.requestId,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'agent-harness', version: '0.1.0' },
        },
      });
    } catch (err) {
      child.kill();
      throw new Error(`MCP init failed: ${String(err)}`);
    }

    // Send initialized notification
    this.stdin?.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n');

    // Fetch tools
    const toolsResult = await this.request({
      jsonrpc: '2.0',
      id: ++this.requestId,
      method: 'tools/list',
    }) as { tools?: McpTool[] };

    this.tools = toolsResult?.tools ?? [];
    this.child = child;
  }

  private async connectSse(): Promise<void> {
    // SSE transport - simplified implementation
    throw new Error('SSE transport not yet implemented');
  }

  private async request(msg: McpJsonRpcMessage): Promise<unknown> {
    const stdin = this.stdin;
    if (!stdin) {
      throw new Error('MCP client is not connected (no transport to write to)');
    }
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const id = Number(msg.id!);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`MCP request timed out after ${this.requestTimeoutMs}ms (method ${msg.method})`));
    }, this.requestTimeoutMs);
    this.pending.set(id, { resolve, reject, timer });
    stdin.write(JSON.stringify(msg) + '\n');
    return promise;
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpContent[]> {
    const result = await this.request({
      jsonrpc: '2.0',
      id: ++this.requestId,
      method: 'tools/call',
      params: { name, arguments: args },
    }) as { content?: McpContent[]; isError?: boolean };

    if (result?.isError) {
      throw new Error(`Tool call failed: ${JSON.stringify(result)}`);
    }

    return result?.content ?? [];
  }

  disconnect(): void {
    this.child?.kill();
    this.child = undefined;
    this.stdin = undefined;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('MCP client disconnected'));
    }
    this.pending.clear();
  }
}

// ── MCP Stdio Transport ──
// Wraps MCP server for stdio communication (used by Claude Desktop, etc.)

export class McpStdioTransport {
  private server: McpServer;

  constructor(server: McpServer) {
    this.server = server;
  }

  start(): void {
    const { stdin, stdout } = process;

    let buffer = '';
    stdin.setEncoding('utf-8');
    stdin.on('data', async (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as McpJsonRpcMessage;
          const response = await this.server.handleRequest(msg);
          if (msg.id !== undefined) {
            stdout.write(JSON.stringify(response) + '\n');
          }
        } catch (err) {
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32700, message: String(err) },
          }) + '\n');
        }
      }
    });
  }
}
