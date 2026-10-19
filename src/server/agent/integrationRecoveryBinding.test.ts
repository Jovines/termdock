import { describe, expect, it } from 'vitest';
import { selectRecoveredIntegrationBinding, type IntegrationRecoveryBindingEvidence } from './integrationRecoveryBinding.js';

function evidence(): IntegrationRecoveryBindingEvidence {
  return {
    sessionId: 'session-1', groupId: 'group-1', principalId: 'principal-1', agentSlug: 'traex',
    nativeSessionId: 'native-uuid', tmuxSessionName: 'wt-integration-session-1',
    descriptorOwners: [{ sessionId: 'session-1', groupId: 'group-1', principalId: 'principal-1' }],
    principalOwners: [{ groupId: 'group-1', principalId: 'principal-1', revoked: false }],
    groupOwners: ['group-1'], terminalOwners: ['session-1'], backendOwnershipVerified: true,
    recoveryOperationId: 'recovery-op-1', panes: [{
      tmuxSessionName: 'wt-integration-session-1', agentSlug: 'traex', nativeSessionId: 'native-uuid',
      nativeIdentitySource: 'linux-flock-owner', nativeIdentityVerified: true,
      binding: { serverPid: 200, sessionId: '$9', paneId: '%12', panePid: 300, agentSlug: 'traex', nativeSessionId: 'native-uuid' },
    }],
  };
}

describe('selectRecoveredIntegrationBinding', () => {
  it('accepts one completed recovery with exact logical, principal, group, native and current pane identity', () => {
    expect(selectRecoveredIntegrationBinding(evidence())).toMatchObject({
      recoveryOperationId: 'recovery-op-1', binding: { serverPid: 200, sessionId: '$9', paneId: '%12', panePid: 300 },
    });
  });

  it.each([
    ['missing successful recovery operation', (value: IntegrationRecoveryBindingEvidence) => { value.recoveryOperationId = null; }],
    ['wrong reserved tmux name', (value: IntegrationRecoveryBindingEvidence) => { value.tmuxSessionName = 'some-other-session'; }],
    ['wrong principal owner', (value: IntegrationRecoveryBindingEvidence) => { value.descriptorOwners[0]!.principalId = 'other'; }],
    ['multiple durable descriptors', (value: IntegrationRecoveryBindingEvidence) => { value.descriptorOwners.push({ ...value.descriptorOwners[0]! }); }],
    ['revoked principal', (value: IntegrationRecoveryBindingEvidence) => { value.principalOwners[0]!.revoked = true; }],
    ['ambiguous principal owner', (value: IntegrationRecoveryBindingEvidence) => { value.principalOwners.push({ ...value.principalOwners[0]! }); }],
    ['wrong group owner', (value: IntegrationRecoveryBindingEvidence) => { value.groupOwners[0] = 'other'; }],
    ['ambiguous group membership', (value: IntegrationRecoveryBindingEvidence) => { value.groupOwners.push('group-2'); }],
    ['ambiguous global terminal ownership', (value: IntegrationRecoveryBindingEvidence) => { value.terminalOwners.push('other'); }],
    ['backend ownership is unknown', (value: IntegrationRecoveryBindingEvidence) => { value.backendOwnershipVerified = false; }],
    ['multiple panes', (value: IntegrationRecoveryBindingEvidence) => { value.panes.push({ ...value.panes[0]! }); }],
    ['wrong native UUID', (value: IntegrationRecoveryBindingEvidence) => { value.panes[0]!.nativeSessionId = 'different'; }],
    ['argv/cache identity is insufficient', (value: IntegrationRecoveryBindingEvidence) => { value.panes[0]!.nativeIdentitySource = 'argv'; }],
    ['unverified writer lock is insufficient', (value: IntegrationRecoveryBindingEvidence) => { value.panes[0]!.nativeIdentityVerified = false; }],
  ])('fails closed for %s', (_name, mutate) => {
    const input = evidence(); mutate(input);
    expect(selectRecoveredIntegrationBinding(input)).toBeNull();
  });
});
