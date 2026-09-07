import { getPublicOrigin } from './publicSecurity.js';
let secureCookies = false;

export function setSecureCookieMode(enabled: boolean): void {
  secureCookies = enabled;
}

export function shouldUseSecureCookies(): boolean {
  return secureCookies || Boolean(getPublicOrigin());
}

export function getCookieSecurityOptions() {
  return {
    secure: shouldUseSecureCookies(),
    sameSite: 'lax' as const,
  };
}
