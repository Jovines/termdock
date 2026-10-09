export type ComputerPlatform = 'mac' | 'linux' | 'windows';

export interface ComputerProfile {
  host: string;
  platform: ComputerPlatform;
  protocol: 'rdp' | 'vnc';
  port: string;
  username: string;
  domain: string;
  ignoreCert: boolean;
  rememberLogin: boolean;
}
export interface ComputerPreferences {
  target: 'local' | 'remote';
  local: ComputerProfile;
  remote: ComputerProfile;
  viewOnly: boolean;
  fit: boolean;
  autoConnect: boolean;
}
export function defaultComputerPreferences(os?: string): ComputerPreferences {
  const platform: ComputerPlatform = os === 'darwin' ? 'mac' : os === 'win32' ? 'windows' : 'linux';
  const profile: ComputerProfile = { host: '127.0.0.1', platform, protocol: platform === 'mac' ? 'vnc' : 'rdp', port: '3389', username: '', domain: '', ignoreCert: false, rememberLogin: true };
  return { target: 'local', local: profile, remote: { ...profile, host: '' }, viewOnly: false, fit: true, autoConnect: true };
}

/** Project only non-secret, supported fields, including when reading old files. */
export function computerPreferences(value: unknown, os?: string): ComputerPreferences {
  const defaults = defaultComputerPreferences(os);
  if (!value || typeof value !== 'object') return defaults;
  const raw = value as Record<string, unknown>;
  const profile = (value: unknown, fallback: ComputerProfile): ComputerProfile => {
    const p = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const text = (key: string, limit: number) => typeof p[key] === 'string' && p[key].length <= limit && !/[\x00-\x1f]/.test(p[key]) ? p[key] as string : fallback[key as 'host' | 'username' | 'domain'];
    return {
      host: text('host', 253), username: text('username', 255), domain: text('domain', 255),
      platform: ['mac', 'linux', 'windows'].includes(String(p.platform)) ? p.platform as ComputerPlatform : fallback.platform,
      protocol: p.protocol === 'rdp' || p.protocol === 'vnc' ? p.protocol : fallback.protocol,
      port: typeof p.port === 'string' && /^\d{0,5}$/.test(p.port) && Number(p.port) <= 65535 ? p.port : fallback.port,
      ignoreCert: p.ignoreCert === true,
      rememberLogin: p.rememberLogin !== false,
    };
  };
  return { target: raw.target === 'remote' ? 'remote' : 'local', local: { ...profile(raw.local, defaults.local), host: '127.0.0.1' }, remote: profile(raw.remote, defaults.remote), viewOnly: raw.viewOnly === true, fit: raw.fit !== false, autoConnect: raw.autoConnect !== false };
}

/** Identity binding deliberately excludes display and certificate preferences. */
export function computerLoginKey(profile: ComputerProfile): string {
  return JSON.stringify([profile.host.trim().toLowerCase(), profile.protocol, profile.protocol === 'vnc' ? 5900 : Number(profile.port), profile.username.trim(), profile.domain.trim()]);
}
