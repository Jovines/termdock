export interface SavedConnection {
  id: string;
  label: string;
  url: string;
  lastConnectedAt?: number;
}

export interface ServiceProbe {
  ok: boolean;
  url: string;
  version?: string;
  protocolVersion?: number;
  error?: string;
}

export interface LocalServerState {
  pid: number;
  host: string;
  port: number;
  scheme?: 'http' | 'https';
  localUrl?: string;
  logFile?: string;
  startedAt?: string;
}

export interface LocalServiceStatus {
  running: boolean;
  state: LocalServerState | null;
  probe: ServiceProbe | null;
}

export interface CliInstallation {
  path: string;
  version: string | null;
  bundled: boolean;
}

export interface DesktopSnapshot {
  appVersion: string;
  runtimeVersion: string;
  packaged: boolean;
  bundledCliVersion: string;
  cliInstallations: CliInstallation[];
  localService: LocalServiceStatus;
  connections: SavedConnection[];
  lastConnectionUrl: string | null;
  desktopPreferences: DesktopPreferences;
}

export interface DesktopServiceActivity {
  origin: string;
  label: string;
  current: boolean;
  focused: boolean;
  runningCount: number;
  reviewCount: number;
}

export interface DesktopStatusSummary {
  runningCount: number;
  reviewCount: number;
  serviceCount: number;
}

export interface DesktopPreferences {
  /** A compact, text-only status item in the macOS menu bar. */
  menuBarStatusEnabled: boolean;
  /** An always-on-top, draggable status shortcut. */
  floatingWidgetEnabled: boolean;
  floatingWidgetPosition: { x: number; y: number } | null;
}

export interface DesktopStatusSnapshot extends DesktopStatusSummary {
  text: string;
  tooltip: string;
  services: DesktopServiceActivity[];
  preferences: DesktopPreferences;
}

export type DesktopAppUpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'current'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

export interface DesktopAppUpdateState {
  status: DesktopAppUpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  releaseName: string | null;
  checkedAt: number | null;
  error: string | null;
}

export interface DesktopConfig {
  version: 1;
  connections: SavedConnection[];
  lastConnectionUrl: string | null;
  trustedCertificateAuthorities: TrustedCertificateAuthority[];
  desktopPreferences: DesktopPreferences;
}

export interface TrustedCertificateAuthority {
  origin: string;
  fingerprint256: string;
  subject: string;
  trustedAt: number;
}
