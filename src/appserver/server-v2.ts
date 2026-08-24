// ============================================================
// App Server V2: With SQLite persistence and vector memory
// ============================================================

import {
  JsonRpcRequest, JsonRpcResponse, JsonRpcNotification,
  AppServerTransport, APP_SERVER_METHODS, APP_SERVER_NOTIFICATIONS,
  createResponse, createError, createNotification,
} from './protocol.js';
import {
  ThreadManager, Thread, Turn, Item,
  createTurn, createItem, generateId,
} from '../core/thread.js';
import { SQLiteThreadManager, SQLiteThreadManagerConfig } from '../core/sqlite-thread.js';
import { Approver } from '../core/approver.js';
import { PromptBuilder } from '../core/prompt-builder.js';
import { ContextCompactor } from '../core/compactor.js';
import { ThreadMemory } from '../core/vector-memory.js';
import { ModelProvider, Message, ToolSchema } from '../plugins/model/interface.js';
import { ToolRegistry } from '../plugins/tools/interface.js';

export interface AppServerV2Config {
  model: ModelProvider;
  tools: ToolRegistry;
  approver?: Approver;
  promptBuilder?: PromptBuilder;
  compactor?: ContextCompactor;
  maxIterations?: number;
  // Persistence
  persistence?: SQLiteThreadManagerConfig;
  // Memory
  enableMemory?: boolean;
}

export type RpcHandler = (req: JsonRpcRequest) => Promise<JsonRpcResponse> | JsonRpcResponse;

export class AppServerV2 {
  private threads: ThreadManager;
  private transports = new Set<AppServerTransport>();
  private runningTurns = new Map<string, AbortController>();
  private memory?: ThreadMemory;
  private sqliteManager?: SQLiteThreadManager;
  private customMethods = new Map<string, RpcHandler>();

  /** Register an additional JSON-RPC method (e.g. bus chat-room methods). */
  registerMethod(name: string, handler: RpcHandler): void {
    this.customMethods.set(name, handler);
  }

  constructor(private config: AppServerV2Config) {
    if (config.persistence) {
      this.sqliteManager = new SQLiteThreadManager(config.persistence);
      this.threads = this.sqliteManager;
    } else {
      this.threads = new (require('../core/thread.js').MemoryThreadManager)();
    }

    if (config.enableMemory !== false) {
      this.memory = new ThreadMemory();
    }
  }

  // Static factory for async init
  static async create(config: AppServerV2Config): Promise<AppServerV2> {
    const server = new AppServerV2(config);
    // Wait a tick for the constructor to finish (SQLite init is sync)
    return server;
  }

  attach(transport: AppServerTransport): void {
    this.transports.add(transport);
    transport.onRequest(req => this.handleRequest(req));
    transport.onClose(() => this.transports.delete(transport));
  }

  broadcast(notif: JsonRpcNotification): void {
    for (const t of this.transports) {
      t.send(notif);
    }
  }

  close(): void {
    this.sqliteManager?.close();
  }

  private async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      switch (req.method) {
        case APP_SERVER_METHODS.THREAD_CREATE:
          return this.handleThreadCreate(req);
        case APP_SERVER_METHODS.THREAD_GET:
          return this.handleThreadGet(req);
        case APP_SERVER_METHODS.THREAD_LIST:
          return this.handleThreadList(req);
        case APP_SERVER_METHODS.THREAD_FORK:
          return this.handleThreadFork(req);
        case APP_SERVER_METHODS.THREAD_ARCHIVE:
          return this.handleThreadArchive(req);
        case APP_SERVER_METHODS.THREAD_DELETE:
          return this.handleThreadDelete(req);
        case APP_SERVER_METHODS.TURN_SUBMIT:
          return await this.handleTurnSubmit(req);
        case APP_SERVER_METHODS.TURN_CANCEL:
          return this.handleTurnCancel(req);
        case APP_SERVER_METHODS.APPROVAL_RESOLVE:
          return this.handleApprovalResolve(req);
        case APP_SERVER_METHODS.APPROVAL_LIST:
          return this.handleApprovalList(req);
        // Memory methods
        case 'memory/search':
          return this.handleMemorySearch(req);
        case 'memory/context':
          return this.handleMemoryContext(req);
        case 'ping':
          return createResponse(req.id, { pong: true, timestamp: Date.now() });
        default: {
          const custom = this.customMethods.get(req.method);
          if (custom) return await custom(req);
          return createError(req.id, -32601, `Method not found: ${req.method}`);
        }
      }
    } catch (err) {
      return createError(req.id, -32603, String(err));
    }
  }

  // --- Thread handlers ---
  private handleThreadCreate(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params as { id?: string } | undefined;
    const thread = this.threads.create(params?.id);
    return createResponse(req.id, { thread });
  }

  private handleThreadGet(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params as { id: string };
    const thread = this.threads.get(params.id);
    if (!thread) return createError(req.id, -32000, 'Thread not found');
    return createResponse(req.id, { thread });
  }

  private handleThreadList(_req: JsonRpcRequest): JsonRpcResponse {
    return createResponse(_req.id, { threads: this.threads.list() });
  }

  private handleThreadFork(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params as { sourceId: string; newId?: string };
    const thread = this.threads.fork(params.sourceId, params.newId);
    return createResponse(req.id, { thread });
  }

  private handleThreadArchive(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params as { id: string };
    this.threads.archive(params.id);
    return createResponse(req.id, { ok: true });
  }

  private handleThreadDelete(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params as { id: string };
    this.threads.delete(params.id);
    return createResponse(req.id, { ok: true });
  }

  // --- Turn execution ---
  private async handleTurnSubmit(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = req.params as { threadId: string; input: string };
    const thread = this.threads.get(params.threadId);
    if (!thread) return createError(req.id, -32000, 'Thread not found');

    const turn = createTurn(params.threadId);
    turn.status = 'running';
    thread.turns.push(turn);

    // Persist immediately
    if (this.sqliteManager) {
      this.sqliteManager.saveTurn(turn);
    }

    const abortCtrl = new AbortController();
    this.runningTurns.set(turn.id, abortCtrl);

    this.broadcast(createNotification(APP_SERVER_NOTIFICATIONS.TURN_STARTED, {
      turnId: turn.id,
      threadId: params.threadId,
    }));

    // Start agent loop asynchronously
    this.runAgentLoop(turn, thread, params.input, abortCtrl.signal).catch(err => {
      turn.status = 'failed';
      this.broadcast(createNotification(APP_SERVER_NOTIFICATIONS.SYSTEM_ERROR, {
        turnId: turn.id,
        error: String(err),
      }));
    }).finally(() => {
      this.runningTurns.delete(turn.id);
    });

    return createResponse(req.id, { turnId: turn.id, status: 'running' });
  }

  private handleTurnCancel(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params as { turnId: string };
    const ctrl = this.runningTurns.get(params.turnId);
    if (ctrl) {
      ctrl.abort();
      return createResponse(req.id, { ok: true });
    }
    return createError(req.id, -32000, 'Turn not running');
  }

  // --- Approval handlers ---
  private handleApprovalResolve(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params as { id: string; approved: boolean };
    const resolved = this.config.approver?.resolveApproval(params.id, params.approved);
    return createResponse(req.id, { resolved: !!resolved });
  }

  private handleApprovalList(req: JsonRpcRequest): JsonRpcResponse {
    const pending = this.config.approver?.getPendingApprovals() ?? [];
    return createResponse(req.id, { pending });
  }

  // --- Memory handlers ---
  // Explicit retrieval tooling; unfiltered by default, optional threadId scope.
  private handleMemorySearch(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params as { query: string; topK?: number; threadId?: string };
    if (!this.memory) {
      return createResponse(req.id, { results: [] });
    }
    const results = this.memory.search(params.query, params.topK ?? 5, params.threadId);
    return createResponse(req.id, { results });
  }

  private handleMemoryContext(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params as { query: string; maxTokens?: number; threadId?: string };
    if (!this.memory) {
      return createResponse(req.id, { context: '' });
    }
    const context = this.memory.getRelevantContext(params.query, params.maxTokens ?? 2000, params.threadId);
    return createResponse(req.id, { context });
  }

  // --- The Agent Loop ---
  private async runAgentLoop(
    turn: Turn,
    thread: Thread,
    userInput: string,
    signal: AbortSignal
  ): Promise<void> {
    const { model, tools, approver, promptBuilder, compactor } = this.config;
    const maxIterations = this.config.maxIterations ?? 10;
    const toolSchemas: ToolSchema[] = tools.list().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // Build prompt with cache-aware ordering
    const history = this.turnsToMessages(thread.turns.slice(0, -1));

    // Inject relevant memory context — scoped to this thread so one
    // conversation's content never leaks into another's prompt
    let memoryContext = '';
    if (this.memory) {
      memoryContext = this.memory.getRelevantContext(userInput, 2000, thread.id);
      if (memoryContext) {
        this.broadcast(createNotification('memory/context_injected', {
          turnId: turn.id,
          contextLength: memoryContext.length,
        }));
      }
    }

    const messages = promptBuilder?.build(userInput, history) ?? [
      { role: 'system' as const, content: 'You are a helpful assistant.' },
      ...(memoryContext ? [{ role: 'system' as const, content: memoryContext }] : []),
      { role: 'user' as const, content: userInput },
    ];

    // Add user input as item
    const userItem = createItem('message', { role: 'user', content: userInput, status: 'completed' });
    turn.items.push(userItem);

    for (let i = 0; i < maxIterations; i++) {
      if (signal.aborted) {
        turn.status = 'failed';
        this.persistTurn(turn);
        return;
      }

      // Compact if needed
      if (compactor?.shouldCompact(messages)) {
        const compacted = compactor.compact(messages);
        messages.length = 0;
        messages.push(...compacted.preserved);
        if (compacted.summary) {
          messages.unshift({ role: 'system', content: `[Summary]: ${compacted.summary}` });
        }
      }

      // Model inference
      const response = await model.generate(messages, toolSchemas);

      const assistantItem = createItem('message', {
        role: 'assistant',
        content: response.content ?? '',
        status: 'completed',
        toolCalls: response.toolCalls?.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      });
      turn.items.push(assistantItem);
      this.persistTurn(turn);

      this.broadcast(createNotification(APP_SERVER_NOTIFICATIONS.ITEM_COMPLETED, {
        turnId: turn.id,
        item: assistantItem,
      }));

      if (!response.toolCalls || response.toolCalls.length === 0) {
        turn.status = 'completed';
        turn.completedAt = Date.now();
        this.persistTurn(turn);

        // Index to memory
        if (this.memory) {
          this.memory.indexThread(thread);
        }

        this.broadcast(createNotification(APP_SERVER_NOTIFICATIONS.TURN_COMPLETED, {
          turnId: turn.id,
          threadId: thread.id,
        }));
        return;
      }

      // Execute tool calls with approval
      for (const tc of response.toolCalls) {
        const toolCallItem = createItem('tool_call', {
          toolCallId: tc.id,
          toolCalls: [{ id: tc.id, name: tc.name, arguments: tc.arguments }],
          status: 'in_progress',
        });
        turn.items.push(toolCallItem);
        this.persistTurn(turn);

        this.broadcast(createNotification(APP_SERVER_NOTIFICATIONS.TOOL_CALL_STARTED, {
          turnId: turn.id,
          toolCall: tc,
        }));

        // Approval check
        const approvalId = generateId('ap-');
        const approved = await approver?.requestApproval(approvalId, {
          toolName: tc.name,
          arguments: tc.arguments,
        }) ?? true;

        if (!approved) {
          toolCallItem.status = 'failed';
          const resultItem = createItem('tool_result', {
            toolCallId: tc.id,
            content: JSON.stringify({ error: 'Approval denied' }),
            status: 'completed',
          });
          turn.items.push(resultItem);
          messages.push({ role: 'tool', content: '{"error":"Approval denied"}', toolCallId: tc.id });
          this.persistTurn(turn);
          continue;
        }

        // Execute
        const tool = tools.get(tc.name);
        let result: unknown;
        try {
          result = tool ? await tool.execute(tc.arguments) : { error: `Tool "${tc.name}" not found` };
        } catch (err) {
          result = { error: String(err) };
        }

        toolCallItem.status = 'completed';

        const resultItem = createItem('tool_result', {
          toolCallId: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
          status: 'completed',
        });
        turn.items.push(resultItem);
        this.persistTurn(turn);

        messages.push({
          role: 'assistant',
          content: '',
          toolCalls: [{ id: tc.id, name: tc.name, arguments: tc.arguments }],
        });
        messages.push({
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          toolCallId: tc.id,
        });

        this.broadcast(createNotification(APP_SERVER_NOTIFICATIONS.TOOL_CALL_COMPLETED, {
          turnId: turn.id,
          toolCallId: tc.id,
          result,
        }));
      }
    }

    turn.status = 'completed';
    turn.completedAt = Date.now();
    this.persistTurn(turn);

    if (this.memory) {
      this.memory.indexThread(thread);
    }

    this.broadcast(createNotification(APP_SERVER_NOTIFICATIONS.TURN_COMPLETED, {
      turnId: turn.id,
      threadId: thread.id,
    }));
  }

  private persistTurn(turn: Turn): void {
    if (this.sqliteManager) {
      this.sqliteManager.saveTurn(turn);
    }
  }

  private turnsToMessages(turns: Turn[]): Message[] {
    const messages: Message[] = [];
    for (const turn of turns) {
      for (const item of turn.items) {
        if (item.type === 'message' && item.role) {
          messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: item.content ?? '' });
        } else if (item.type === 'tool_call' && item.toolCalls) {
          messages.push({
            role: 'assistant',
            content: '',
            toolCalls: item.toolCalls.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
          });
        } else if (item.type === 'tool_result') {
          messages.push({ role: 'tool', content: item.content ?? '', toolCallId: item.toolCallId });
        }
      }
    }
    return messages;
  }
}
