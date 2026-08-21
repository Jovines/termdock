import fs from 'node:fs';
import path from 'node:path';
import {
  compareVersions,
  updateTermdockFromOfficialRegistry,
  type NpmUpdateFallbackStage,
  type NpmUpdateResult,
} from './npmUpdate.js';

export const AUTO_UPDATE_INITIAL_DELAY_MS = 15_000;
export const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export type TermdockUpdateStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'installing'
  | 'ready'
  | 'restarting'
  | 'error';

export interface TermdockUpdateState {
  status: TermdockUpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  source: NpmUpdateResult['source'] | null;
  checkedAt: number | null;
  error: string | null;
}

type UpdateRunner = typeof updateTermdockFromOfficialRegistry;

interface AutoUpdateDependencies {
  currentVersion: string;
  stateFilePath?: string | null;
  broadcast: (state: TermdockUpdateState) => void;
  requestRestart: () => void;
  updateRunner?: UpdateRunner;
  log?: (message: string) => void;
}

function initialState(currentVersion: string): TermdockUpdateState {
  return {
    status: 'idle',
    currentVersion,
    latestVersion: null,
    source: null,
    checkedAt: null,
    error: null,
  };
}

export function hasPendingTermdockUpdate(state: TermdockUpdateState): boolean {
  if (!state.latestVersion) return false;
  try {
    return compareVersions(state.latestVersion, state.currentVersion) > 0
      && (state.status === 'installing' || state.status === 'ready' || state.status === 'restarting' || state.status === 'error');
  } catch {
    return false;
  }
}

export class TermdockAutoUpdateManager {
  private state: TermdockUpdateState;
  private checkPromise: Promise<TermdockUpdateState> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private readonly updateRunner: UpdateRunner;

  constructor(private readonly dependencies: AutoUpdateDependencies) {
    this.state = this.loadState();
    this.updateRunner = dependencies.updateRunner ?? updateTermdockFromOfficialRegistry;
  }

  getState(): TermdockUpdateState {
    return { ...this.state };
  }

  start(): void {
    if (this.initialTimer || this.intervalTimer) return;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.checkNow();
    }, AUTO_UPDATE_INITIAL_DELAY_MS);
    this.initialTimer.unref?.();

    this.intervalTimer = setInterval(() => {
      void this.checkNow();
    }, AUTO_UPDATE_INTERVAL_MS);
    this.intervalTimer.unref?.();
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
  }

  checkNow(): Promise<TermdockUpdateState> {
    // Once an installed update is waiting for explicit confirmation, periodic
    // checks must never turn any external state change into implicit consent.
    // Keep the reminder until the user confirms or restarts manually.
    if (this.state.status === 'ready' && hasPendingTermdockUpdate(this.state)) {
      return Promise.resolve(this.getState());
    }
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.runCheck().finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  confirmRestart(): TermdockUpdateState {
    if (this.state.status !== 'ready' || !hasPendingTermdockUpdate(this.state)) {
      throw new Error('No installed Termdock update is waiting for restart.');
    }
    this.setState({ ...this.state, status: 'restarting', error: null });
    this.dependencies.requestRestart();
    return this.getState();
  }

  private async runCheck(): Promise<TermdockUpdateState> {
    this.setState({ ...this.state, status: 'checking', checkedAt: Date.now(), error: null });
    try {
      const result = await this.updateRunner(
        this.dependencies.currentVersion,
        (stage: NpmUpdateFallbackStage, error: Error) => {
          this.dependencies.log?.(`[auto-update] official npm ${stage} failed; using configured registry: ${error.message}`);
        },
        (latestVersion, source) => {
          if (compareVersions(latestVersion, this.dependencies.currentVersion) <= 0) return;
          this.setState({
            ...this.state,
            status: 'installing',
            latestVersion,
            source,
            checkedAt: Date.now(),
            error: null,
          });
        },
      );

      if (result.status !== 'updated') {
        this.setState({
          status: 'current',
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          source: result.source,
          checkedAt: Date.now(),
          error: null,
        });
        return this.getState();
      }

      this.setState({
        status: 'ready',
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        source: result.source,
        checkedAt: Date.now(),
        error: null,
      });

      return this.getState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ ...this.state, status: 'error', checkedAt: Date.now(), error: message });
      this.dependencies.log?.(`[auto-update] ${message}`);
      return this.getState();
    }
  }

  private setState(state: TermdockUpdateState): void {
    this.state = state;
    this.persistState();
    this.dependencies.broadcast(this.getState());
  }

  private loadState(): TermdockUpdateState {
    const fallback = initialState(this.dependencies.currentVersion);
    const stateFilePath = this.dependencies.stateFilePath;
    if (!stateFilePath) return fallback;
    try {
      const value = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as Partial<TermdockUpdateState>;
      if (typeof value.latestVersion !== 'string') return fallback;
      if (compareVersions(this.dependencies.currentVersion, value.latestVersion) >= 0) return fallback;
      if (value.status !== 'ready' && value.status !== 'restarting' && value.status !== 'error') return fallback;
      return {
        status: value.status === 'restarting' ? 'ready' : value.status,
        currentVersion: this.dependencies.currentVersion,
        latestVersion: value.latestVersion,
        source: value.source === 'configured' ? 'configured' : 'official',
        checkedAt: typeof value.checkedAt === 'number' ? value.checkedAt : null,
        error: typeof value.error === 'string' ? value.error : null,
      };
    } catch {
      return fallback;
    }
  }

  private persistState(): void {
    const stateFilePath = this.dependencies.stateFilePath;
    if (!stateFilePath) return;
    try {
      fs.mkdirSync(path.dirname(stateFilePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${stateFilePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, stateFilePath);
    } catch (error) {
      this.dependencies.log?.(`[auto-update] failed to persist state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
