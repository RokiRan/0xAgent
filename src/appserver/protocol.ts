// ============================================================
// App Server: JSON-RPC Protocol
// Decouples agent core from any client (CLI, Web, IDE).
// ============================================================

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// Codex App Server Methods
export const APP_SERVER_METHODS = {
  // Thread lifecycle
  THREAD_CREATE: 'thread/create',
  THREAD_GET: 'thread/get',
  THREAD_LIST: 'thread/list',
  THREAD_FORK: 'thread/fork',
  THREAD_ARCHIVE: 'thread/archive',
  THREAD_DELETE: 'thread/delete',

  // Turn execution
  TURN_SUBMIT: 'turn/submit',
  TURN_CANCEL: 'turn/cancel',

  // Streaming
  ITEM_STREAM: 'item/stream',

  // Approval
  APPROVAL_RESOLVE: 'approval/resolve',
  APPROVAL_LIST: 'approval/list',

  // System
  PING: 'ping',
} as const;

// Notification events (server → client)
export const APP_SERVER_NOTIFICATIONS = {
  TURN_STARTED: 'turn/started',
  TURN_COMPLETED: 'turn/completed',
  ITEM_DELTA: 'item/delta',
  ITEM_COMPLETED: 'item/completed',
  TOOL_CALL_STARTED: 'tool_call/started',
  TOOL_CALL_COMPLETED: 'tool_call/completed',
  APPROVAL_REQUIRED: 'approval/required',
  SYSTEM_ERROR: 'system/error',
} as const;

// Helper factories
export function createRequest(id: JsonRpcId, method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

export function createResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function createError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export function createNotification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

// Transport interface
export interface AppServerTransport {
  send(message: JsonRpcResponse | JsonRpcNotification): void;
  onRequest(handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>): void;
  onClose(handler: () => void): void;
  close(): void;
}
