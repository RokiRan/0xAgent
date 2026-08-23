// ============================================================
// App Server: Stdio Transport
// JSON-RPC over stdio. Primary transport for CLI and IDE.
// ============================================================

import { AppServerTransport, JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './protocol.js';
import { createInterface } from 'readline';

export class StdioTransport implements AppServerTransport {
  private requestHandler?: (req: JsonRpcRequest) => Promise<JsonRpcResponse>;
  private closeHandler?: () => void;

  constructor() {
    // Read JSON-RPC lines from stdin
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

    rl.on('line', async (line) => {
      if (!this.requestHandler) return;
      try {
        const req = JSON.parse(line) as JsonRpcRequest;
        const res = await this.requestHandler(req);
        this.send(res);
      } catch {
        // Invalid JSON or not a request
      }
    });

    rl.on('close', () => {
      this.closeHandler?.();
    });
  }

  send(message: JsonRpcResponse | JsonRpcNotification): void {
    console.log(JSON.stringify(message));
  }

  onRequest(handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>): void {
    this.requestHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closeHandler?.();
    process.exit(0);
  }
}
