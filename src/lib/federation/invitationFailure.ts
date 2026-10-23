import { connectionAccessError } from './accessFailure';
type Denial = 'expired' | 'used' | 'invalid';
export function invitationDenial(error: unknown): Denial | undefined {
  const code = error instanceof Error ? error.message : '';
  if (['INVITATION_EXPIRED', 'ROUTE_INVITATION_EXPIRED'].includes(code)) return 'expired';
  if (['INVITATION_USED', 'ROUTE_INVITATION_USED'].includes(code)) return 'used';
  // Older servers, removed records and revoked invitations cannot confirm a
  // more specific reason. Never infer expiry from a transport failure.
  if (['PAIRING_DENIED', 'ROUTE_PAIRING_DENIED'].includes(code)) return 'invalid';
}
export function describeInvitationFailure(error: unknown) {
  const denial = invitationDenial(error);
  if (denial === 'expired') return { kind: denial, title: '邀请已过期', description: '此链接已超过有效期。请联系分享者重新生成邀请，再使用新的链接连接。', retryable: false };
  if (denial === 'used') return { kind: denial, title: '邀请已被使用', description: '此链接只能用于一台设备。已接受邀请的设备可从服务列表进入；其他设备需要分享者提供新的邀请链接。', retryable: false };
  if (denial === 'invalid') return { kind: denial, title: '邀请已失效', description: '此链接已不可用，可能已过期、被使用或被撤销。请联系分享者重新生成邀请。', retryable: false };
  if (connectionAccessError(error)?.code === 'TARGET_IDENTITY_MISMATCH' || error instanceof Error && error.message === 'PEER_IDENTITY_MISMATCH') return { kind: 'identity' as const, title: '连接的服务不匹配', description: '实际连接的服务与邀请链接不一致。请核对链接，或联系分享者获取新的邀请。', retryable: false };
  return { kind: 'connection' as const, title: '暂时无法连接', description: '未能连接到分享服务。请检查网络，并确认分享者的服务正在运行后重试。', retryable: true };
}
