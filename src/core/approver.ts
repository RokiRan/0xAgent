// ============================================================
// Core: Approval Policy
// Inspired by Codex Smart Approvals.
// ============================================================

export type ApprovalLevel = 'auto' | 'confirm' | 'reject';

export interface ToolAction {
  toolName: string;
  arguments: Record<string, unknown>;
  riskHint?: string;
}

export interface ApprovalPolicy {
  readonly: boolean;           // If true, no writes allowed
  network: boolean;            // If true, network access allowed
  autoApprove: string[];       // Tool names that auto-approve
  confirm: string[];           // Tool names that need confirmation
  reject: string[];            // Tool names that always reject
}

export const DEFAULT_POLICY: ApprovalPolicy = {
  readonly: false,
  network: false,
  autoApprove: ['filesystem:read', 'filesystem:list'],
  confirm: ['filesystem:write', 'filesystem:mkdir', 'shell', 'code'],
  reject: [],
};

export const READONLY_POLICY: ApprovalPolicy = {
  readonly: true,
  network: false,
  autoApprove: ['filesystem:read', 'filesystem:list'],
  confirm: [],
  reject: ['filesystem:write', 'filesystem:mkdir', 'shell', 'code'],
};

export class Approver {
  private policy: ApprovalPolicy;
  private pendingApprovals = new Map<string, { resolve: (ok: boolean) => void; action: ToolAction }>();

  constructor(policy: ApprovalPolicy = DEFAULT_POLICY) {
    this.policy = policy;
  }

  setPolicy(policy: ApprovalPolicy): void {
    this.policy = policy;
  }

  // Decide approval level for a tool call
  decide(action: ToolAction): ApprovalLevel {
    const name = action.toolName;

    if (this.policy.reject.includes(name)) return 'reject';
    if (this.policy.autoApprove.includes(name)) return 'auto';
    if (this.policy.confirm.includes(name)) return 'confirm';

    // Heuristics for unlisted tools
    if (this.policy.readonly) {
      if (name.includes('write') || name.includes('delete') || name.includes('shell') || name.includes('exec')) {
        return 'reject';
      }
    }

    // Default: confirm anything that looks risky
    if (name.includes('shell') || name.includes('exec') || name.includes('write') || name.includes('delete')) {
      return 'confirm';
    }

    return 'auto';
  }

  // Async approval with optional human-in-the-loop
  async requestApproval(id: string, action: ToolAction): Promise<boolean> {
    const level = this.decide(action);

    if (level === 'auto') return true;
    if (level === 'reject') return false;

    // confirm: return a promise that can be resolved externally
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, { resolve, action });
    });
  }

  // External resolver (e.g., CLI UI, Web UI)
  resolveApproval(id: string, approved: boolean): boolean {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return false;
    pending.resolve(approved);
    this.pendingApprovals.delete(id);
    return true;
  }

  getPendingApprovals(): Array<{ id: string; action: ToolAction }> {
    return Array.from(this.pendingApprovals.entries()).map(([id, p]) => ({ id, action: p.action }));
  }

  // Batch decision for a list of tool calls
  decideBatch(actions: ToolAction[]): Array<{ action: ToolAction; level: ApprovalLevel }> {
    return actions.map(a => ({ action: a, level: this.decide(a) }));
  }
}
