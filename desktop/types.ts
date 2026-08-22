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
}
