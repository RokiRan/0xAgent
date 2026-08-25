// ============================================================
// Plugin: Filesystem Tool
// Read / write / list files within a sandboxed root.
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';
import { Tool } from './interface.js';
import { ToolRegistryImpl } from './registry.js';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join, resolve, relative } from 'path';

export interface FSConfig {
  rootPath: string;
  allowedPaths?: string[];
}

function sanitizePath(root: string, inputPath: string): string {
  const target = resolve(root, inputPath);
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel === '..') {
    throw new Error('Path traversal blocked');
  }
  return target;
}

export class FilesystemTool implements Tool {
  name = 'filesystem';
  description = 'Read, write, list files. Use relative paths from workspace root.';
  parameters = {
    type: 'object' as const,
    properties: {
      operation: {
        type: 'string',
        enum: ['read', 'write', 'list', 'mkdir'],
        description: 'Operation to perform',
      },
      path: { type: 'string', description: 'Relative file or directory path' },
      content: { type: 'string', description: 'Content for write operation' },
    },
    required: ['operation', 'path'],
  };

  constructor(private root: string) {}

  async execute(args: Record<string, unknown>): Promise<unknown> {
    const op = args.operation as string;
    const rawPath = args.path as string;
    const fullPath = sanitizePath(this.root, rawPath);

    switch (op) {
      case 'read': {
        const data = await readFile(fullPath, 'utf-8');
        return { success: true, content: data };
      }
      case 'write': {
        const content = (args.content ?? '') as string;
        await writeFile(fullPath, content, 'utf-8');
        return { success: true, bytes: content.length };
      }
      case 'list': {
        const entries = await readdir(fullPath, { withFileTypes: true });
        return {
          success: true,
          entries: entries.map(e => ({
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
          })),
        };
      }
      case 'mkdir': {
        await mkdir(fullPath, { recursive: true });
        return { success: true };
      }
      default:
        throw new Error(`Unknown operation: ${op}. Valid operations: read, write, list, mkdir`);
    }
  }
}

export const filesystemPlugin: Plugin = {
  name: 'tool:filesystem',
  async activate(ctx: PluginContext) {
    const cfg = ctx.config as unknown as FSConfig;
    const root = cfg.rootPath ?? process.cwd();

    let registry: ToolRegistryImpl;
    if (ctx.services.has('tool:registry')) {
      registry = ctx.services.get('tool:registry') as ToolRegistryImpl;
    } else {
      registry = new ToolRegistryImpl();
      ctx.services.register('tool:registry', registry);
    }

    registry.register(new FilesystemTool(root));
    ctx.events.emit('tool:registered', { name: 'filesystem' });
  },
};
