import os from 'os';
import multicastDns, { type MulticastDns, type Packet } from 'multicast-dns';
import { LOCAL_ACCESS } from '../config.js';
import {
  createAutoLocalAccessName,
  getLocalAccessSetting,
  getLocalAccessSettingAsync,
  normalizeLocalAccessName,
  setLocalAccessSettingAsync,
  type LocalAccessNameSource,
} from './settings.js';
import { isAuthEnabled } from './authProtection.js';

export type LocalAccessStatus = 'active' | 'disabled' | 'needs-auth' | 'loopback-only' | 'conflict' | 'error';

export interface LocalAccessRuntimeOptions {
  host: string;
  port: number;
  scheme: 'http' | 'https';
  caCertPath?: string;
  onboardingPort?: number;
}

export interface LocalAccessInterfaceAddress {
  name: string;
  address: string;
  family: 'IPv4';
  label: string;
}

export interface LocalAccessState {
  name: string;
  source: LocalAccessNameSource;
  hostname: string;
  fallbackHostname: string;
  url: string;
  fallbackUrl: string;
  onboardingUrl: string | null;
  status: LocalAccessStatus;
  reason: string | null;
  httpsEnabled: boolean;
  caAvailable: boolean;
  lanAddresses: string[];
  interfaces: LocalAccessInterfaceAddress[];
}

const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

function hostnameForName(name: string): string {
  return `${name}.${LOCAL_ACCESS.domainSuffix}`;
}

function normalizeQuestionName(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1).toLowerCase() : name.toLowerCase();
}

export function isLoopbackHost(host: string): boolean {
  return LOCALHOST_NAMES.has(host) || host.startsWith('127.');
}

function interfaceLabel(name: string): string {
  if (name === 'en0') return 'Wi-Fi';
  if (name.startsWith('en')) return `Network adapter ${name}`;
  if (name.startsWith('bridge')) return `Bridge ${name}`;
  return name;
}

export function getLanIPv4Interfaces(): LocalAccessInterfaceAddress[] {
  const interfaces = os.networkInterfaces();
  const addresses: LocalAccessInterfaceAddress[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      addresses.push({ name, address: entry.address, family: 'IPv4', label: interfaceLabel(name) });
    }
  }
  const seen = new Set<string>();
  return addresses.filter((entry) => {
    if (seen.has(entry.address)) return false;
    seen.add(entry.address);
    return true;
  });
}

export function getLanIPv4Addresses(): string[] {
  return getLanIPv4Interfaces().map((entry) => entry.address);
}

function buildState(
  setting: { name: string; source: LocalAccessNameSource },
  options: LocalAccessRuntimeOptions,
  status: LocalAccessStatus,
  reason: string | null,
): LocalAccessState {
  const hostname = hostnameForName(setting.name);
  const interfaces = getLanIPv4Interfaces();
  const lanAddresses = interfaces.map((entry) => entry.address);
  const onboardingHost = lanAddresses[0] ?? null;
  const fallbackHostname = onboardingHost ?? hostname;
  return {
    name: setting.name,
    source: setting.source,
    hostname,
    fallbackHostname,
    url: `${options.scheme}://${hostname}:${options.port}`,
    fallbackUrl: `${options.scheme}://${fallbackHostname}:${options.port}`,
    onboardingUrl: onboardingHost ? `http://${onboardingHost}:${options.onboardingPort ?? options.port}/onboarding` : null,
    status,
    reason,
    httpsEnabled: options.scheme === 'https',
    caAvailable: Boolean(options.caCertPath),
    lanAddresses,
    interfaces,
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class LocalAccessManager {
  private mdns: MulticastDns | null = null;
  private state: LocalAccessState | null = null;
  private options: LocalAccessRuntimeOptions | null = null;

  getState(): LocalAccessState {
    const options = this.options ?? { host: '0.0.0.0', port: 9834, scheme: 'http' as const };
    if (this.state) return this.state;
    return buildState(getLocalAccessSetting(), options, 'disabled', 'Local access has not started yet.');
  }

  async start(options: LocalAccessRuntimeOptions): Promise<LocalAccessState> {
    this.options = options;
    await this.stop();

    let setting = await getLocalAccessSettingAsync();
    const lanAddresses = getLanIPv4Addresses();
    if (isLoopbackHost(options.host)) {
      this.state = buildState(setting, options, 'loopback-only', 'Server is bound to loopback only.');
      return this.state;
    }
    if (lanAddresses.length === 0) {
      this.state = buildState(setting, options, 'disabled', 'No LAN IPv4 address was found.');
      return this.state;
    }
    if (!isAuthEnabled()) {
      this.state = buildState(setting, options, 'needs-auth', 'Set an access password before advertising on the LAN.');
      return this.state;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const hostnames = [hostnameForName(setting.name)];
      const conflict = await this.hasConflict(hostnames, lanAddresses);
      if (!conflict) break;
      if (setting.source === 'manual') {
        this.state = buildState(setting, options, 'conflict', `${hostnames.join(' / ')} is already in use on this LAN.`);
        return this.state;
      }
      setting = { name: createAutoLocalAccessName(), source: 'auto' };
      await setLocalAccessSettingAsync(setting);
    }

    this.mdns = multicastDns({ loopback: true, reuseAddr: true });
    this.mdns.on('query', (packet) => this.handleQuery(packet));
    this.state = buildState(setting, options, 'active', null);
    return this.state;
  }

  async updateName(input: string, source: LocalAccessNameSource): Promise<LocalAccessState> {
    const normalized = normalizeLocalAccessName(input);
    if (!normalized) {
      const current = this.getState();
      this.state = { ...current, status: 'error', reason: 'Invalid local access name.' };
      return this.state;
    }
    await setLocalAccessSettingAsync({ name: normalized, source });
    if (!this.options) {
      this.state = buildState({ name: normalized, source }, { host: '0.0.0.0', port: 9834, scheme: 'http' }, 'disabled', 'Local access has not started yet.');
      return this.state;
    }
    return this.start(this.options);
  }

  async resetAutoName(): Promise<LocalAccessState> {
    await setLocalAccessSettingAsync({ name: createAutoLocalAccessName(), source: 'auto' });
    if (!this.options) {
      const setting = await getLocalAccessSettingAsync();
      this.state = buildState(setting, { host: '0.0.0.0', port: 9834, scheme: 'http' }, 'disabled', 'Local access has not started yet.');
      return this.state;
    }
    return this.start(this.options);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const mdns = this.mdns;
      this.mdns = null;
      if (!mdns) {
        resolve();
        return;
      }
      try {
        mdns.destroy(resolve);
      } catch {
        resolve();
      }
    });
  }

  private handleQuery(packet: Packet): void {
    const state = this.state;
    if (!state || state.status !== 'active' || !this.mdns) return;
    const hostnames = new Set([state.hostname.toLowerCase()]);
    const wantsAnswer = (packet.questions ?? []).some((question) => {
      const qName = normalizeQuestionName(question.name);
      return hostnames.has(qName) && (question.type === 'A' || question.type === 'ANY');
    });
    if (!wantsAnswer) return;
    const answers = Array.from(hostnames).flatMap((hostname) => state.lanAddresses.map((address) => ({
      name: hostname,
      type: 'A',
      ttl: LOCAL_ACCESS.mdnsTtlSeconds,
      data: address,
    })));
    try {
      this.mdns.respond({ answers });
    } catch (error) {
      console.warn('[local-access] failed to respond to mDNS query:', error);
    }
  }

  private async hasConflict(hostnames: string[], localAddresses: string[]): Promise<boolean> {
    const mdns = multicastDns({ loopback: false, reuseAddr: true });
    const localSet = new Set(localAddresses);
    let conflict = false;
    const targets = new Set(hostnames.map((hostname) => hostname.toLowerCase()));
    mdns.on('response', (packet) => {
      for (const answer of packet.answers ?? []) {
        const name = normalizeQuestionName(answer.name);
        if (!targets.has(name) || answer.type !== 'A') continue;
        if (typeof answer.data === 'string' && !localSet.has(answer.data)) {
          conflict = true;
        }
      }
    });
    try {
      mdns.query(hostnames.map((name) => ({ name, type: 'A' })));
      await wait(650);
    } catch {
      return false;
    } finally {
      try { mdns.destroy(); } catch { /* ignore */ }
    }
    return conflict;
  }
}

export const localAccessManager = new LocalAccessManager();
