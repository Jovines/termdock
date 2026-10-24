import { DeviceAuthorizationRequired } from './deviceAuthorization';
import { isConnectionInterruption } from './connectionRecovery';
import { ConnectionAccessError } from './accessFailure';

const failures = {
  CONNECTION_FAILED: { reason: 'connectionFailed', status: 503, message: '暂时连不上这台服务，请检查地址和网络后重试。' },
  INVALID_PASSWORD: { reason: 'invalidPassword', status: 401, message: '密码不正确，或服务身份无法验证。请检查后重试。' },
  IDENTITY_MISMATCH: { reason: 'identityMismatch', status: 409, message: '服务身份与已保存的记录不一致，请确认目标服务。' },
  RATE_LIMITED: { reason: 'rateLimited', status: 429, message: '尝试次数较多，请稍后再试。' },
  LOGIN_UNAVAILABLE: { reason: 'unavailable', status: 503, message: '暂时无法登录这台服务，请稍后重试。' },
  PASSWORD_NOT_CONFIGURED: { reason: 'passwordNotConfigured', status: 403, message: '目标服务未配置访问密码，且此设备尚未获得访问授权。请让目标服务管理员发送邀请或授权此设备后重新连接。' },
  TARGET_PASSWORD_REQUIRED: { reason: 'targetPasswordRequired', status: 403, message: '目标服务未配置有效访问密码，已禁用中转。请让目标服务管理员先配置访问密码。' },
  TARGET_SECURITY_UPGRADE_REQUIRED: { reason: 'securityUpgradeRequired', status: 403, message: '无法核验中转的密码保护，已禁用中转。请更新目标服务和中继程序。' },
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
  if (error instanceof ConnectionAccessError) return new PasswordLoginFailure(error.code === 'TARGET_IDENTITY_MISMATCH' ? 'IDENTITY_MISMATCH'
    : error.code === 'TARGET_PASSWORD_REQUIRED' || error.code === 'TARGET_SECURITY_UPGRADE_REQUIRED' ? error.code : 'DEVICE_AUTHORIZATION_REQUIRED');
  if (error instanceof Error) {
    if (error.message === 'PASSWORD_NOT_CONFIGURED') return new PasswordLoginFailure('PASSWORD_NOT_CONFIGURED');
    if (error.message === 'TARGET_PASSWORD_REQUIRED' || error.message === 'TARGET_SECURITY_UPGRADE_REQUIRED') return new PasswordLoginFailure(error.message);
    if (error.name === 'UnexpectedPeerError' || error.message === 'PEER_IDENTITY_MISMATCH') return new PasswordLoginFailure('IDENTITY_MISMATCH');
    if (error.message === 'LOGIN_RATE_LIMIT' || error.message === 'Too many password login attempts') return new PasswordLoginFailure('RATE_LIMITED');
    if (error.message === 'AUTHORIZATION_DENIED') return new PasswordLoginFailure('DEVICE_AUTHORIZATION_REQUIRED');
    if (error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name) || isConnectionInterruption(error)
      || error.message === 'Encrypted handshake timed out' || error.message === 'Encrypted transport failed') return new PasswordLoginFailure('CONNECTION_FAILED');
    if (error.message === 'Password authentication failed' || error.message === 'Password login expired' || error.message === 'INVALID_LOGIN') return new PasswordLoginFailure('INVALID_PASSWORD');
  }
  return new PasswordLoginFailure('LOGIN_UNAVAILABLE');
}
