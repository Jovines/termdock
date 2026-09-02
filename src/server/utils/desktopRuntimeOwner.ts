import http from 'node:http';

export interface DesktopRuntimeOwnerState {
  status: 'idle' | 'checking' | 'current' | 'ready' | 'restarting' | 'error';
  currentVersion: string;
  latestVersion: string | null;
  source: 'desktop';
  checkedAt: number | null;
  error: string | null;
}

type StateListener = (state: DesktopRuntimeOwnerState) => void;

function isDesktopRuntimeOwnerState(value: unknown): value is DesktopRuntimeOwnerState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<DesktopRuntimeOwnerState>;
  return typeof state.status === 'string'
    && typeof state.currentVersion === 'string'
    && (state.latestVersion === null || typeof state.latestVersion === 'string')
    && state.source === 'desktop'
    && (state.checkedAt === null || typeof state.checkedAt === 'number')
    && (state.error === null || typeof state.error === 'string');
}

export class DesktopRuntimeOwnerClient {
  private state: DesktopRuntimeOwnerState;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stateSignature: string;

  constructor(
    private readonly socketPath: string,
    currentVersion: string,
    private readonly listener: StateListener,
  ) {
    this.state = {
      status: 'idle',
      currentVersion,
      latestVersion: null,
      source: 'desktop',
      checkedAt: null,
      error: null,
    };
    this.stateSignature = JSON.stringify(this.state);
  }

  getState(): DesktopRuntimeOwnerState {
    return { ...this.state };
  }

  start(): void {
    if (this.pollTimer) return;
    void this.refresh().catch(() => undefined);
    this.pollTimer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, 2_000);
    this.pollTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  refresh(): Promise<DesktopRuntimeOwnerState> {
    return this.request('GET', '/runtime-update');
  }

  checkForUpdates(): Promise<DesktopRuntimeOwnerState> {
    return this.request('POST', '/runtime-update/check', 180_000);
  }

  restart(): Promise<DesktopRuntimeOwnerState> {
    return this.request('POST', '/runtime-update/restart');
  }

  private request(
    method: 'GET' | 'POST',
    requestPath: string,
    timeoutMs = 10_000,
  ): Promise<DesktopRuntimeOwnerState> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        path: requestPath,
        method,
        headers: { accept: 'application/json' },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          let payload: unknown;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            reject(new Error('Termdock Desktop 返回了无效的 Runtime 更新状态。'));
            return;
          }
          if ((response.statusCode ?? 500) >= 400) {
            const error = payload && typeof payload === 'object' && 'error' in payload
              ? String((payload as { error: unknown }).error)
              : `Termdock Desktop 更新请求失败（HTTP ${response.statusCode ?? 500}）。`;
            reject(new Error(error));
            return;
          }
          if (!isDesktopRuntimeOwnerState(payload)) {
            reject(new Error('Termdock Desktop 返回了不完整的 Runtime 更新状态。'));
            return;
          }
          this.publish(payload);
          resolve(this.getState());
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error('Termdock Desktop Runtime 更新请求超时。')));
      request.on('error', (error) => reject(new Error(
        `无法联系管理此服务的 Termdock Desktop：${error.message}`,
      )));
      request.end();
    });
  }

  private publish(state: DesktopRuntimeOwnerState): void {
    const signature = JSON.stringify(state);
    this.state = { ...state };
    if (signature === this.stateSignature) return;
    this.stateSignature = signature;
    this.listener(this.getState());
  }
}
