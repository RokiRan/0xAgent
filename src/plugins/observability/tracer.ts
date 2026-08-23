// ============================================================
// Plugin: Observability
// Execution tracing and logging for production debugging.
// ============================================================

import { Plugin, PluginContext } from '../../core/plugin.js';

export interface TraceEvent {
  id: string;
  type: 'llm-call' | 'tool-call' | 'tool-result' | 'agent-thought' | 'error' | 'session';
  timestamp: number;
  durationMs?: number;
  agentId?: string;
  sessionId?: string;
  data: Record<string, unknown>;
}

export interface Tracer {
  log(event: TraceEvent): void;
  getTraces(filter?: { agentId?: string; sessionId?: string; type?: string }): TraceEvent[];
  export(): string;
}

class InMemoryTracer implements Tracer {
  private traces: TraceEvent[] = [];
  private maxSize: number;

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  log(event: TraceEvent): void {
    this.traces.push(event);
    if (this.traces.length > this.maxSize) {
      this.traces = this.traces.slice(-this.maxSize);
    }
  }

  getTraces(filter?: { agentId?: string; sessionId?: string; type?: string }): TraceEvent[] {
    let result = this.traces;
    if (filter?.agentId) {
      result = result.filter(t => t.agentId === filter.agentId);
    }
    if (filter?.sessionId) {
      result = result.filter(t => t.sessionId === filter.sessionId);
    }
    if (filter?.type) {
      result = result.filter(t => t.type === filter.type);
    }
    return result;
  }

  export(): string {
    return JSON.stringify(this.traces, null, 2);
  }
}

export const observabilityPlugin: Plugin = {
  name: 'observability:memory',
  async activate(ctx: PluginContext) {
    const tracer = new InMemoryTracer();
    ctx.services.register('tracer', tracer);

    // Auto-trace key events
    ctx.events.on('model:ready', (data: Record<string, unknown>) => {
      tracer.log({
        id: `evt-${Date.now()}`,
        type: 'session',
        timestamp: Date.now(),
        data: { event: 'model:ready', ...data },
      });
    });

    ctx.events.on('plugin:loaded', (data: Record<string, unknown>) => {
      tracer.log({
        id: `evt-${Date.now()}`,
        type: 'session',
        timestamp: Date.now(),
        data: { event: 'plugin:loaded', ...data },
      });
    });

    ctx.events.emit('observability:ready', {});
  },
};
