/** Only confirmed, allowlisted access facts may stop network recovery. */
export type AccessFailureCode = 'RELAY_AUTHORIZATION_REQUIRED' | 'TARGET_AUTHORIZATION_REQUIRED' | 'PERMISSION_DENIED' | 'TARGET_IDENTITY_MISMATCH' | 'RELAY_SELF_TARGET';
export interface AccessFailureContext { targetServiceId?: string; entryServiceId?: string; entryUrl?: string }
const messages: Record<AccessFailureCode, string> = {
  RELAY_AUTHORIZATION_REQUIRED: '没有有效中转授权', TARGET_AUTHORIZATION_REQUIRED: '目标服务需要重新登录',
  PERMISSION_DENIED: '当前权限不允许此操作', TARGET_IDENTITY_MISMATCH: '服务身份与保存的身份不一致',
  RELAY_SELF_TARGET: '不能通过服务中转到其自身；同一服务的其它地址请添加为备用地址。',
};
export class ConnectionAccessError extends Error {
  readonly name = 'ConnectionAccessError';
  constructor(readonly code: AccessFailureCode, readonly context: AccessFailureContext = {}) { super(messages[code]); }
}
export function connectionAccessError(error: unknown, context: AccessFailureContext = {}): ConnectionAccessError | undefined {
  if (error instanceof ConnectionAccessError) { Object.assign(error.context, { ...context, ...error.context }); return error; }
  // Retained workspaces/test module reloads can carry the same protocol error
  // from another module instance. Never accept arbitrary messages as a code.
  if (error instanceof Error && error.name === 'ConnectionAccessError' && 'code' in error
    && typeof error.code === 'string' && Object.hasOwn(messages, error.code)) {
    return new ConnectionAccessError(error.code as AccessFailureCode, context);
  }
  if (error instanceof Error && error.name === 'UnexpectedPeerError') return new ConnectionAccessError('TARGET_IDENTITY_MISMATCH', context);
  return undefined;
}
export function relayAuthorizationError(error: unknown, context: AccessFailureContext): Error {
  if (error instanceof Error && (error.message === 'AUTHORIZATION_DENIED'
    || error instanceof ConnectionAccessError && error.code === 'PERMISSION_DENIED')) {
    return new ConnectionAccessError('RELAY_AUTHORIZATION_REQUIRED', context);
  }
  return error instanceof Error ? error : new Error('中转连接暂不可用');
}
