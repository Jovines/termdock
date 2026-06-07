import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getLocalAccessSetting } from './utils/settings.js';
import { getLanIPv4Addresses } from './utils/localAccess.js';

const execFileAsync = promisify(execFile);

export interface CertificateWatcherOptions {
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  enabled: boolean;
}

export interface CertificatePaths {
  certPath: string;
  keyPath: string;
  caPath?: string;
}

const CHECK_INTERVAL_MS = 15_000;

function fileExists(filePath: string | undefined): filePath is string {
  return typeof filePath === 'string' && filePath.length > 0;
}

async function readCertificateSans(certPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('openssl', ['x509', '-in', certPath, '-noout', '-ext', 'subjectAltName'], {
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    return stdout
      .split(/[\n,]/)
      .map((part) => part.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function sanMatches(required: string, sans: string[]): boolean {
  if (required === '::1') {
    return sans.some((san) => san === 'IP Address:::1' || san === 'IP Address:0:0:0:0:0:0:0:1' || san === 'IP:::1');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(required) || required.includes(':')) {
    return sans.some((san) => san === `IP Address:${required}` || san === `IP:${required}`);
  }
  return sans.some((san) => san === `DNS:${required}`);
}

function requiredNames(): string[] {
  const localName = getLocalAccessSetting().name;
  return [
    '*.termdock.local',
    `${localName}.termdock.local`,
    ...getLanIPv4Addresses(),
    'localhost',
    '127.0.0.1',
    '::1',
  ];
}

export class CertificateWatcher extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(private readonly options: CertificateWatcherOptions) {
    super();
  }

  start(): void {
    if (this.timer || !this.options.enabled || !fileExists(this.options.certPath) || !fileExists(this.options.keyPath)) return;
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<void> {
    if (this.checking || !this.options.enabled || !fileExists(this.options.certPath) || !fileExists(this.options.keyPath)) return;
    this.checking = true;
    try {
      const sans = await readCertificateSans(this.options.certPath);
      const missing = requiredNames().filter((name) => !sanMatches(name, sans));
      if (missing.length === 0) return;
      console.log(`[cert-watch] certificate missing SANs (${missing.join(', ')}); regenerating and requesting restart`);
      this.emit('refresh-needed', missing);
    } finally {
      this.checking = false;
    }
  }
}
