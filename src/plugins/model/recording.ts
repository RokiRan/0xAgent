// ============================================================
// RecordingProvider: ledger decorator around any ModelProvider.
// cumora §7.3 适配——记账在 provider 层收口而非每个 call site，
// 漏点为零；fire-and-forget：记账失败只 warn，绝不弄挂调用本身。
// provider 没报 usage 时 measured=false，绝不猜测。
// ============================================================

import { ModelProvider, Message, ToolSchema, ModelResponse } from './interface.js';

export interface LlmCallRecord {
  ts: number;
  agentId: string;
  /** 调用目的：judge / reply / task / vote / promise / verify / turn … */
  purpose: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** false = provider 未报用量，记 0 不猜（cumora 诚实账本原则） */
  measured: boolean;
  latencyMs: number;
  status: 'ok' | 'error';
}

/** sink 必须同步返回；内部自行 fire-and-forget，绝不允许抛出。 */
export type LlmLedgerSink = (rec: LlmCallRecord) => void;

export class RecordingProvider implements ModelProvider {
  constructor(
    private inner: ModelProvider,
    private meta: { agentId: string; purpose: string; model: string },
    private sink: LlmLedgerSink,
  ) {}

  async generate(messages: Message[], tools?: ToolSchema[]): Promise<ModelResponse> {
    const started = Date.now();
    try {
      const res = await this.inner.generate(messages, tools);
      this.emit(res, started, 'ok');
      return res;
    } catch (err) {
      this.emit(undefined, started, 'error');
      throw err;
    }
  }

  private emit(res: ModelResponse | undefined, started: number, status: 'ok' | 'error'): void {
    try {
      this.sink({
        ts: started,
        agentId: this.meta.agentId,
        purpose: this.meta.purpose,
        model: this.meta.model,
        inputTokens: res?.usage?.inputTokens,
        outputTokens: res?.usage?.outputTokens,
        measured: res?.usage?.inputTokens !== undefined,
        latencyMs: Date.now() - started,
        status,
      });
    } catch (err) {
      console.warn('[llm-ledger] sink failed (call unaffected):', err);
    }
  }
}

/**
 * Registry HTTP sink: agents report to POST /llm-calls (系统记账走系统通道，
 * 不污染对话通道、不计入 rounds)。fire-and-forget。
 */
export function httpLedgerSink(registryUrl: string, token?: string): LlmLedgerSink {
  return (rec) => {
    void fetch(`${registryUrl}/llm-calls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-bus-token': token } : {}),
      },
      body: JSON.stringify(rec),
    }).catch((err) => console.warn('[llm-ledger] report failed (call unaffected):', err));
  };
}
