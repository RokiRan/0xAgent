// ============================================================
// App Server: HTTP Static File Server
// Serves the Web UI and proxies API requests.
// ============================================================

import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface StaticServerConfig {
  port: number;
  host?: string;
  publicDir?: string;
}

export class StaticServer {
  private server?: http.Server;

  constructor(private config: StaticServerConfig) {}

  async start(): Promise<void> {
    const publicDir = this.config.publicDir ?? path.join(__dirname, '../../public');

    this.server = http.createServer(async (req, res) => {
      const url = req.url ?? '/';
      const filePath = url === '/' ? '/index.html' : url;
      const fullPath = path.join(publicDir, filePath);

      // Security: prevent directory traversal
      if (!fullPath.startsWith(publicDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      try {
        const content = await fs.readFile(fullPath);
        const ext = path.extname(fullPath);
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Serve index.html for SPA routing
          try {
            const indexPath = path.join(publicDir, 'index.html');
            const content = await fs.readFile(indexPath);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
          } catch {
            res.writeHead(404);
            res.end('Not found');
          }
        } else {
          res.writeHead(500);
          res.end(String(err));
        }
      }
    });

    return new Promise((resolve) => {
      this.server!.listen(this.config.port, this.config.host ?? '0.0.0.0', () => {
        console.log(`[StaticServer] Serving at http://${this.config.host ?? 'localhost'}:${this.config.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
