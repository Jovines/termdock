import { integrationError } from './integrationStore.js';

export interface DetachedCloseOwnership {
  sessionId: string; groupId: string; principalId: string;
  localGroup: boolean;
  descriptorOwners: Array<{ sessionId: string; groupId: string; principalId: string }>;
  principalOwners: Array<{ groupId: string; principalId: string; revoked: boolean }>;
  groupOwners: string[];
  terminalClaims: number;
  backendClaims: Array<{ routeOwner: string | null; foreignTerminal: boolean }>;
  otherPaneOwner: boolean;
}

/** Missing UI inventory is not authority to kill a named tmux session. Require
 * independent durable ownership first; live pane/native/process proof follows.
 * No terminal registration, route or group membership is created here. */
export function assertDetachedCloseOwnership(e: DetachedCloseOwnership): void {
  if (!e.localGroup || !e.sessionId || !e.groupId || !e.principalId
    || e.descriptorOwners.length !== 1 || e.descriptorOwners[0]?.sessionId !== e.sessionId
    || e.descriptorOwners[0]?.groupId !== e.groupId || e.descriptorOwners[0]?.principalId !== e.principalId
    || e.principalOwners.length !== 1 || e.principalOwners[0]?.principalId !== e.principalId
    || e.principalOwners[0]?.groupId !== e.groupId || e.principalOwners[0]?.revoked
    || e.groupOwners.length !== 1 || e.groupOwners[0] !== e.groupId) {
    integrationError('SESSION_CLOSE_OWNERSHIP_UNCONFIRMED', 'Missing terminal registration requires unique durable local session, principal and group ownership', 409);
  }
  if (e.terminalClaims || e.backendClaims.length > 1 || e.otherPaneOwner
    || e.backendClaims.some(b => b.foreignTerminal || b.routeOwner !== null && b.routeOwner !== e.sessionId)) {
    integrationError('SESSION_IDENTITY_MISMATCH', 'Another terminal, backend or route claims the close target', 409);
  }
}
