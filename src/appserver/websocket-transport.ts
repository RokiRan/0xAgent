// ============================================================
// App Server: WebSocket Transport
// Bidirectional JSON-RPC over WebSocket.
// ============================================================

import {
  JsonRpcRequest, JsonRpcResponse, JsonRpcNotification,
  AppServerTransport,
  createResponse, createError,
} from './protocol.js';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';

export interface WebSocketTransportConfig {
  port: number;
  host?: string;
  path?: string;
  heartbeatIntervalMs?: number;
}

export class WebSocketTransport implements AppServerTransport {
  private wss: WebSocketServer;
  private clients = new Map<string, WebSocket>();
  private requestHandler?: (req: JsonRpcRequest) => Promise<JsonRpcResponse>;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(private config: WebSocketTransportConfig) {
    this.wss = new WebSocketServer({
      port: config.port,
      host: config.host ?? '0.0.0.0',
      path: config.path ?? '/jsonrpc',
    });

    this.wss.on('connection', (ws, req) => {
      const clientId = this.extractClientId(req);
      this.clients.set(clientId, ws);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.jsonrpc === '2.0') {
            if (msg.method) {
              // Request or notification
              if (msg.id !== undefined) {
                this.requestHandler?.(msg as JsonRpcRequest).then((res) => {
                  ws.send(JSON.stringify(res));
                });
              } else {
                // Notification from client - ignore for now
              }
            }
          }
        } catch (err) {
          ws.send(JSON.stringify(createError(null, -32700, 'Parse error')));
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
      });

      ws.on('error', (err) => {
        console.error(`[WebSocket] Client ${clientId} error:`, err.message);
        this.clients.delete(clientId);
      });

      // Send welcome
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'system/connected',
        params: { clientId, timestamp: Date.now() },
      }));
    });

    // Heartbeat
    const interval = config.heartbeatIntervalMs ?? 30000;
    this.heartbeatTimer = setInterval(() => {
      for (const [id, ws] of this.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          this.clients.delete(id);
        }
      }
    }, interval);
  }

  onRequest(handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>): void {
    this.requestHandler = handler;
  }

  send(notif: JsonRpcNotification): void {
    const payload = JSON.stringify(notif);
    for (const ws of this.clients.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  onClose(_handler: () => void): void {
    // WebSocket server stays alive until explicitly closed
  }

  close(): void {
    clearInterval(this.heartbeatTimer);
    for (const ws of this.clients.values()) {
      ws.close();
    }
    this.wss.close();
  }

  private extractClientId(req: IncomingMessage): string {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    return url.searchParams.get('clientId') ?? `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
