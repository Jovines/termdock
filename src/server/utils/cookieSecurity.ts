let secureCookies = false;

export function setSecureCookieMode(enabled: boolean): void {
  secureCookies = enabled;
}

export function shouldUseSecureCookies(): boolean {
  return secureCookies;
}

export function getCookieSecurityOptions() {
  return {
    secure: secureCookies,
    sameSite: 'strict' as const,
  };
}
