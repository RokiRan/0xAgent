// ============================================================
// Bus agent config protocol handler (contract §2 §4).
//
// Pure, side-effect-bearing module extracted so unit tests can drive it
// without booting a registry / transport.  bus-agent.ts owns the mutable
// model/persona references and calls handleConfigRequest() to resolve
// payloads received over the bus — keeping the protocol logic in one place.
//
// Security: this module never reads, embeds, or echoes the LLM API key.
// The persisted file holds {persona, modelSmall} only; only the keys
// listed in BUS_CONFIG_ALLOWED_KEYS may appear in a write patch.
// ============================================================

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/** Patch keys the UI may write through the bus (contract §2). */
export const BUS_CONFIG_ALLOWED_KEYS = ['persona', 'modelSmall'] as const;

export interface BusConfigPatch {
  persona?: string;
  modelSmall?: string;
}

/** Persisted shape under ~/.bus-agent/<agentId>.json (contract §4). */
export interface BusAgentPersisted {
  persona?: string;
  modelSmall?: string;
}

export interface ConfigSnapshot {
  agent: string;
  host: string;
  persona: string;
  model: string;
  modelSmall: string;
  channel: string;
}

/**
 * Wiring supplied by bus-agent.ts.  Every getter returns the *current*
 * value so a freshly built `handleConfigRequest` always sees hot-updated
 * model/persona references; `applyChange` is the only write path.
 */
export interface ConfigCtx {
  agentId: string;
  channel: string;
  /** Read-through to the current big-model name. */
  getBigModel: () => string;
  /** Current small-model name.  Updated through applyChange. */
  getSmallModel: () => string;
  /** Current persona string.  Updated through applyChange. */
  getPersona: () => string;
  /** Side-effect channel: mutate live refs + persist. */
  applyChange: (next: BusConfigPatch) => void;
  /** Override file path; defaults to ~/.bus-agent/<agentId>.json. */
  filePath?: string;
  /** Optional hostname override (tests). */
  host?: string;
}

/** Discriminated payload shape — what the responder actually returns. */
export type BusConfigResponse =
  | ({ kind: 'config' } & ConfigSnapshot)
  | { kind: 'config'; ok: true; agent: string }
  | { kind: 'config'; ok: false; error: string };

/** Read persisted state.  Returns {} when the file is absent or invalid. */
export function readPersisted(filePath: string): BusAgentPersisted {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const obj = parsed as Record<string, unknown>;
    const out: BusAgentPersisted = {};
    if (typeof obj.persona === 'string') out.persona = obj.persona;
    if (typeof obj.modelSmall === 'string') out.modelSmall = obj.modelSmall;
    return out;
  } catch {
    return {};
  }
}

/** Persist with mkdir -p semantics.  Throws on disk failure (caller decides policy).
 *  Keeps the previous content in `<file>.bak` — a bad `set` overwrite (or an
 *  accidental UI probe) is recoverable without filesystem snapshots. */
export function writePersisted(filePath: string, data: BusAgentPersisted): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
  } catch {
    // 备份失败不阻断主写——主写失败才会 throw。
  }
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}

/** Construct a ConfigSnapshot from the live refs + ctx. */
export function snapshot(ctx: ConfigCtx): ConfigSnapshot {
  return {
    agent: ctx.agentId,
    host: ctx.host ?? os.hostname(),
    persona: ctx.getPersona(),
    model: ctx.getBigModel(),
    modelSmall: ctx.getSmallModel(),
    channel: ctx.channel,
  };
}

/**
 * Validate a patch against the allow-list (contract §2 "校验 patch 只含
 * 允许键").  Returns the patch when every key/value is acceptable, else
 * an error string.  Unknown keys, non-string values, or empty patches
 * all reject — the UI cannot crash the agent by sending garbage.
 */
export function validatePatch(patch: unknown): { ok: true; value: BusConfigPatch } | { ok: false; error: string } {
  if (patch === undefined || patch === null) return { ok: false, error: 'patch missing' };
  if (typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'patch must be an object' };

  const obj = patch as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return { ok: false, error: 'patch empty' };
  for (const k of keys) {
    if (!(BUS_CONFIG_ALLOWED_KEYS as readonly string[]).includes(k)) {
      return { ok: false, error: `unsupported key: ${k}` };
    }
    if (typeof obj[k] !== 'string') {
      return { ok: false, error: `${k} must be string` };
    }
  }

  return { ok: true, value: obj as BusConfigPatch };
}

/**
 * Main entry — bus.onRequest config branch funnels here.  Pure modulo
 * the ctx.applyChange side channel, which keeps the live refs + file
 * write localised.  Returns contract-shaped responses; never throws.
 */
export function handleConfigRequest(payload: unknown, ctx: ConfigCtx): BusConfigResponse {
  if (!payload || typeof payload !== 'object') {
    return { kind: 'config', ok: false, error: 'payload must be an object' };
  }
  const p = payload as Record<string, unknown>;
  if (p.kind !== 'config') {
    return { kind: 'config', ok: false, error: 'unknown kind' };
  }
  const action = p.action;

  if (action === 'get') {
    return { kind: 'config', ...snapshot(ctx) };
  }

  if (action === 'set') {
    const validated = validatePatch(p.patch);
    if (!validated.ok) return { kind: 'config', ok: false, error: validated.error };
    // Apply is atomic from the caller's POV: every field succeeds or none.
    ctx.applyChange(validated.value);
    return { kind: 'config', ok: true, agent: ctx.agentId };
  }

  return { kind: 'config', ok: false, error: `unknown action: ${String(action)}` };
}
