import type { CollaborationPaneBinding } from './collaborationRouting.js';

export interface IntegrationRecoveryPaneEvidence {
  tmuxSessionName: string;
  agentSlug: string;
  nativeSessionId: string | null;
  nativeIdentitySource: string | null;
  nativeIdentityVerified: boolean;
  binding: CollaborationPaneBinding;
}

export interface IntegrationRecoveryBindingEvidence {
  sessionId: string;
  groupId: string;
  principalId: string;
  agentSlug: string;
  nativeSessionId: string;
  tmuxSessionName: string;
  /** Exactly one durable IntegrationSession descriptor claims this identity. */
  descriptorOwners: Array<{ sessionId: string; groupId: string; principalId: string }>;
  principalOwners: Array<{ groupId: string; principalId: string; revoked: boolean }>;
  /** Active collaboration groups containing the logical session. */
  groupOwners: string[];
  /** Current global terminal records with the integration's reserved name. */
  terminalOwners: string[];
  /** Current tmux/backend inventory is uniquely bound to this frontend session. */
  backendOwnershipVerified: boolean;
  /** A persisted recovery operation completed this exact session successfully. */
  recoveryOperationId: string | null;
  /** Every pane in the exact tmux session is supplied; there must be one. */
  panes: IntegrationRecoveryPaneEvidence[];
}

/**
 * Recovery may replace tmux's server/session/pane tuple. Adopt that tuple only
 * when durable TD ownership, completed recovery, and a live native writer lock
 * all agree on the original logical session. Unknown evidence stays rejected.
 */
export function selectRecoveredIntegrationBinding(evidence: IntegrationRecoveryBindingEvidence): {
  binding: CollaborationPaneBinding; recoveryOperationId: string;
} | null {
  const expectedName = `wt-integration-${evidence.sessionId}`;
  if (!evidence.sessionId || !evidence.groupId || !evidence.principalId || !evidence.agentSlug
    || !evidence.nativeSessionId || evidence.tmuxSessionName !== expectedName
    || !evidence.recoveryOperationId || !evidence.backendOwnershipVerified) return null;
  if (evidence.descriptorOwners.length !== 1 || evidence.descriptorOwners[0]?.sessionId !== evidence.sessionId
    || evidence.descriptorOwners[0]?.groupId !== evidence.groupId
    || evidence.descriptorOwners[0]?.principalId !== evidence.principalId) return null;
  if (evidence.principalOwners.length !== 1 || evidence.principalOwners[0]?.principalId !== evidence.principalId
    || evidence.principalOwners[0]?.groupId !== evidence.groupId || evidence.principalOwners[0]?.revoked) return null;
  if (evidence.groupOwners.length !== 1 || evidence.groupOwners[0] !== evidence.groupId
    || evidence.terminalOwners.length !== 1 || evidence.terminalOwners[0] !== evidence.sessionId) return null;
  if (evidence.panes.length !== 1) return null;
  const pane = evidence.panes[0]!;
  const binding = pane.binding;
  if (pane.tmuxSessionName !== expectedName || pane.agentSlug !== evidence.agentSlug
    || pane.nativeSessionId !== evidence.nativeSessionId || pane.nativeIdentitySource !== 'linux-flock-owner'
    || !pane.nativeIdentityVerified || binding.agentSlug !== evidence.agentSlug
    || binding.nativeSessionId !== evidence.nativeSessionId || !Number.isSafeInteger(binding.serverPid) || binding.serverPid <= 1
    || !Number.isSafeInteger(binding.panePid) || binding.panePid <= 1
    || !/^\$\d+$/.test(binding.sessionId) || !/^%\d+$/.test(binding.paneId)) return null;
  return { binding: structuredClone(binding), recoveryOperationId: evidence.recoveryOperationId };
}
