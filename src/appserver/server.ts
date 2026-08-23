// ============================================================
// App Server: Core Implementation
// Hosts agent threads, handles JSON-RPC protocol.
// ============================================================

import {
  JsonRpcRequest, JsonRpcResponse, JsonRpcNotification,
  AppServerTransport, APP_SERVER_METHODS, APP_SERVER_NOTIFICATIONS,
  createResponse, createError, createNotification,
} from './protocol.js';
import {
  ThreadManager, Thread, Turn, Item,
  MemoryThreadManager, createTurn, createItem, generateId,
} from '../core/thread.js';
import { Approver } from '../core/approver.js';
import { PromptBuilder } from '../core/prompt-builder.js';
import { ContextCompactor } from '../core/compactor.js';
import { ModelProvider, Message, ToolSchema } from '../plugins/model/interface.js';
import { ToolRegistry } from '../plugins/tools/interface.js';

export interface AppServerConfig {
  model: ModelProvider;
  tools: ToolRegistry;
  approver?: Approver;
  promptBuilder?: PromptBuilder;
  compactor?: ContextCompactor;
  maxIterations?: number;
}

export class AppServer {
  private threads: ThreadManager;
  private transports = new Set<AppServerTransport>();
  private runningTurns = new Map<string, AbortController>();

  constructor(private config: AppServerConfig) {
    this.threads = new MemoryThreadManager();
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
        case APP_SERVER_METHODS.PING:
          return createResponse(req.id, { pong: true, timestamp: Date.now() });
        default:
          return createError(req.id, -32601, `Method not found: ${req.method}`);
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

  // --- Turn execution (the agent loop) ---
  private async handleTurnSubmit(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = req.params as { threadId: string; input: string };
    const thread = this.threads.get(params.threadId);
    if (!thread) return createError(req.id, -32000, 'Thread not found');

    const turn = createTurn(params.threadId);
    turn.status = 'running';
    thread.turns.push(turn);
    thread.updatedAt = Date.now();

    const abortCtrl = new AbortController();
    this.runningTurns.set(turn.id, abortCtrl);

    // Notify clients
    this.broadcast(createNotification(APP_SERVER_NOTIFICATIONS.TURN_STARTED, {
      turnId: turn.id,
      threadId: params.threadId,
    }));

    // Start agent loop asynchronously (do not await)
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
    const messages = promptBuilder?.build(userInput, history) ?? [
      { role: 'system' as const, content: 'You are a helpful assistant.' },
      { role: 'user' as const, content: userInput },
    ];

    // Add user input as item
    const userItem = createItem('message', { role: 'user', content: userInput, status: 'completed' });
    turn.items.push(userItem);

    for (let i = 0; i < maxIterations; i++) {
      if (signal.aborted) {
        turn.status = 'failed';
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

      this.broadcast(createNotification(APP_SERVER_NOTIFICATIONS.ITEM_COMPLETED, {
        turnId: turn.id,
        item: assistantItem,
      }));

      if (!response.toolCalls || response.toolCalls.length === 0) {
        turn.status = 'completed';
        turn.completedAt = Date.now();
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
    this.broadcast(createNotification(APP_SERVER_NOTIFICATIONS.TURN_COMPLETED, {
      turnId: turn.id,
      threadId: thread.id,
    }));
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
