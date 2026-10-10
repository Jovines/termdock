import { DeviceAuthorizationRequired } from './deviceAuthorization';
import { isConnectionInterruption } from './connectionRecovery';

const failures = {
  CONNECTION_FAILED: { reason: 'connectionFailed', status: 503, message: '暂时连不上这台服务，请检查地址和网络后重试。' },
  INVALID_PASSWORD: { reason: 'invalidPassword', status: 401, message: '密码不正确，或服务身份无法验证。请检查后重试。' },
  IDENTITY_MISMATCH: { reason: 'identityMismatch', status: 409, message: '服务身份与已保存的记录不一致，请确认目标服务。' },
  RATE_LIMITED: { reason: 'rateLimited', status: 429, message: '尝试次数较多，请稍后再试。' },
  LOGIN_UNAVAILABLE: { reason: 'unavailable', status: 503, message: '暂时无法登录这台服务，请稍后重试。' },
  DEVICE_AUTHORIZATION_REQUIRED: { reason: 'authorizationRequired', status: 403, message: '请检查目标服务与入口的设备授权后重试。' },
} as const;

export type PasswordLoginFailureCode = keyof typeof failures;
export type LoginFailureReason = (typeof failures)[PasswordLoginFailureCode]['reason'];
export function loginFailureReason(code: unknown): LoginFailureReason | undefined {
  return typeof code === 'string' && Object.hasOwn(failures, code) ? failures[code as PasswordLoginFailureCode].reason : undefined;
}
export class PasswordLoginFailure extends Error {
  readonly status: number;
  constructor(readonly code: PasswordLoginFailureCode, readonly retryAfterMs?: number) {
    super(failures[code].message);
    this.status = failures[code].status;
  }
}
/** Only fixed public messages cross the login boundary, never bootstrap payloads,
 * transport endpoint details, private identity material or exception stacks. */
export function passwordLoginFailure(error: unknown): PasswordLoginFailure {
  if (error instanceof PasswordLoginFailure) return error;
  if (error instanceof DeviceAuthorizationRequired) return new PasswordLoginFailure('DEVICE_AUTHORIZATION_REQUIRED');
  if (error instanceof Error) {
    if (error.name === 'UnexpectedPeerError' || error.message === 'PEER_IDENTITY_MISMATCH') return new PasswordLoginFailure('IDENTITY_MISMATCH');
    if (error.message === 'LOGIN_RATE_LIMIT' || error.message === 'Too many password login attempts') return new PasswordLoginFailure('RATE_LIMITED');
    if (error.message === 'AUTHORIZATION_DENIED') return new PasswordLoginFailure('DEVICE_AUTHORIZATION_REQUIRED');
    if (error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name) || isConnectionInterruption(error)
      || error.message === 'Encrypted handshake timed out' || error.message === 'Encrypted transport failed') return new PasswordLoginFailure('CONNECTION_FAILED');
    if (error.message === 'Password authentication failed' || error.message === 'Password login expired' || error.message === 'INVALID_LOGIN') return new PasswordLoginFailure('INVALID_PASSWORD');
  }
  return new PasswordLoginFailure('LOGIN_UNAVAILABLE');
}
