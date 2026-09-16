import { EventEmitter } from 'events';
import { getMissingCertificateNames } from './utils/certificateNames.js';
import { getLocalAccessSetting } from './utils/settings.js';
import { getLanIPv4Addresses } from './utils/localAccess.js';

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
const RETRY_INTERVAL_MS = 60_000;

function fileExists(filePath: string | undefined): filePath is string {
  return typeof filePath === 'string' && filePath.length > 0;
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
  private refreshInFlight = false;
  private pendingKey: string | null = null;
  private nextRetryAt = 0;

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

  markRefreshComplete(missing: string[], ok: boolean): void {
    const key = missing.join('\0');
    if (this.pendingKey !== key) return;
    this.refreshInFlight = false;
    if (ok) {
      this.pendingKey = null;
      this.nextRetryAt = 0;
    } else {
      this.nextRetryAt = Date.now() + RETRY_INTERVAL_MS;
    }
  }

  async check(): Promise<void> {
    if (this.checking || !this.options.enabled || !fileExists(this.options.certPath) || !fileExists(this.options.keyPath)) return;
    this.checking = true;
    try {
      const missing = await getMissingCertificateNames(this.options.certPath, requiredNames());
      if (missing.length === 0) {
        this.refreshInFlight = false;
        this.pendingKey = null;
        this.nextRetryAt = 0;
        return;
      }

      const key = missing.join('\0');
      const now = Date.now();
      if (this.refreshInFlight && this.pendingKey === key) return;
      if (this.pendingKey === key && this.nextRetryAt > now) return;

      this.refreshInFlight = true;
      this.pendingKey = key;
      console.log(`[cert-watch] certificate missing SANs (${missing.join(', ')}); regenerating and reloading TLS context`);
      this.emit('refresh-needed', missing);
    } catch (error) {
      // An unreadable certificate is not evidence of missing SANs. Keep the
      // active TLS context instead of repeatedly regenerating the certificate.
      console.warn('[cert-watch] could not inspect certificate; keeping current TLS context:', error);
    } finally {
      this.checking = false;
    }
  }
}
