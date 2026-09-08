import {
  app,
  autoUpdater,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
} from 'electron';
import {
  resolvePackagedRuntime,
  updateRuntimeFromRegistry,
  type RuntimeUpdateResult,
} from './runtime.js';
import {
  buildGitHubUpdateFeed,
  startGitHubUpdateFeedServer,
  type UpdateFeedResponse,
} from './githubUpdateFeed.js';
import type { DesktopAppUpdateState, DesktopRuntimeUpdateState } from './types.js';

const AUTOMATIC_CHECK_DELAY_MS = 15_000;
const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const UPDATE_CHECK_TIMEOUT_MS = 30_000;

type ShowMessageBox = (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
type UpdateStateListener = (state: DesktopAppUpdateState) => void;
type RuntimeUpdateStateListener = (state: DesktopRuntimeUpdateState) => void;

let configured = false;
let nativeCheckDialogPending = false;
let updateDialogShown = false;
let showMessageBox: ShowMessageBox | null = null;
let checkPromise: Promise<DesktopAppUpdateState> | null = null;
let settleCheck: ((state: DesktopAppUpdateState) => void) | null = null;
let checkTimeout: ReturnType<typeof setTimeout> | null = null;
let updateFeedPromise: Promise<string> | null = null;
let selectedFeed: UpdateFeedResponse | null = null;
let nativeCheckInFlight = false;
let runtimeDownloadPromise: Promise<RuntimeUpdateResult> | null = null;
let runningRuntimeVersion: string | null = null;
const stateListeners = new Set<UpdateStateListener>();
const runtimeStateListeners = new Set<RuntimeUpdateStateListener>();
let updateState: DesktopAppUpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  latestVersion: null,
  releaseName: null,
  checkedAt: null,
  error: null,
};
let runtimeCheckPromise: Promise<DesktopRuntimeUpdateState> | null = null;
let runtimeUpdateState: DesktopRuntimeUpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  latestVersion: null,
  source: 'desktop',
  checkedAt: null,
  error: null,
};

async function ensureUpdateFeedConfigured(): Promise<string> {
  updateFeedPromise ??= startGitHubUpdateFeedServer(
    app.getVersion(),
    process.platform,
    process.arch,
    async () => {
      if (!selectedFeed) throw new Error('No desktop update has been selected');
      return selectedFeed;
    },
  ).then((feed) => {
    try {
      autoUpdater.setFeedURL({ url: feed.url });
    } catch (error) {
      feed.close();
      throw error;
    }
    return feed.url;
  }).catch((error) => {
    updateFeedPromise = null;
    throw error;
  });
  return updateFeedPromise;
}

function supportsAutomaticUpdates(): boolean {
  return app.isPackaged && process.platform === 'darwin';
}

function snapshotUpdateState(): DesktopAppUpdateState {
  return { ...updateState, currentVersion: app.getVersion() };
}

function publishUpdateState(patch: Partial<DesktopAppUpdateState>): DesktopAppUpdateState {
  updateState = { ...updateState, ...patch, currentVersion: app.getVersion() };
  const snapshot = snapshotUpdateState();
  for (const listener of stateListeners) listener(snapshot);
  return snapshot;
}

function finishPendingCheck(state = snapshotUpdateState()): void {
  if (checkTimeout) {
    clearTimeout(checkTimeout);
    checkTimeout = null;
  }
  settleCheck?.(state);
  settleCheck = null;
  checkPromise = null;
}

function normalizeReleaseVersion(releaseName: string): string | null {
  const match = releaseName.match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match?.[1] ?? null;
}

export function getDesktopUpdateState(): DesktopAppUpdateState {
  if (!supportsAutomaticUpdates()) {
    return { ...snapshotUpdateState(), status: 'unsupported', error: null };
  }
  return snapshotUpdateState();
}

export function subscribeDesktopUpdateState(listener: UpdateStateListener): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

function publishRuntimeUpdateState(
  patch: Partial<DesktopRuntimeUpdateState>,
): DesktopRuntimeUpdateState {
  runtimeUpdateState = { ...runtimeUpdateState, ...patch, source: 'desktop' };
  const snapshot = { ...runtimeUpdateState };
  for (const listener of runtimeStateListeners) listener(snapshot);
  return snapshot;
}

export function getDesktopRuntimeUpdateState(): DesktopRuntimeUpdateState {
  if (supportsAutomaticUpdates()) {
    try {
      const selected = resolvePackagedRuntime({
        appVersion: app.getVersion(),
        resourcesPath: process.resourcesPath,
      });
      if (runtimeUpdateState.status === 'idle' || runtimeUpdateState.status === 'current') {
        runtimeUpdateState = { ...runtimeUpdateState, currentVersion: runningRuntimeVersion ?? selected.version };
      }
    } catch {
      // The bundled version remains a safe display fallback.
    }
  }
  return { ...runtimeUpdateState };
}

export function subscribeDesktopRuntimeUpdateState(
  listener: RuntimeUpdateStateListener,
): () => void {
  runtimeStateListeners.add(listener);
  return () => runtimeStateListeners.delete(listener);
}

export function markDesktopRuntimeRunning(version: string): DesktopRuntimeUpdateState {
  runningRuntimeVersion = version;
  return publishRuntimeUpdateState({
    status: 'current',
    currentVersion: version,
    latestVersion: null,
    checkedAt: Date.now(),
    error: null,
  });
}

export function markDesktopRuntimeRestarting(): DesktopRuntimeUpdateState {
  return publishRuntimeUpdateState({ status: 'restarting', error: null });
}

export function markDesktopRuntimeRestartFailed(error: unknown): DesktopRuntimeUpdateState {
  return publishRuntimeUpdateState({
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  });
}

export function checkForRuntimeUpdates(): Promise<DesktopRuntimeUpdateState> {
  if (runtimeCheckPromise) return runtimeCheckPromise;
  if (runtimeUpdateState.status === 'ready' || runtimeUpdateState.status === 'restarting') {
    return Promise.resolve(getDesktopRuntimeUpdateState());
  }
  const before = getDesktopRuntimeUpdateState().currentVersion;
  publishRuntimeUpdateState({ status: 'checking', error: null });
  runtimeCheckPromise = ensureLatestRuntime()
    .then((result) => {
      if (!result || result.status === 'disabled' || result.status === 'current') {
        const stagedVersion = result?.currentVersion ?? before;
        const needsRestart = stagedVersion !== before;
        return publishRuntimeUpdateState({
          status: needsRestart ? 'ready' : 'current',
          currentVersion: before,
          latestVersion: needsRestart ? stagedVersion : result?.latestVersion ?? null,
          checkedAt: Date.now(),
          error: null,
        });
      }
      if (result.status === 'requires-desktop') {
        return publishRuntimeUpdateState({
          status: 'error',
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion ?? null,
          checkedAt: Date.now(),
          error: result.reason ?? '该 Runtime 需要更新 macOS 桌面版。',
        });
      }
      return publishRuntimeUpdateState({
        status: 'ready',
        currentVersion: before,
        latestVersion: result.latestVersion ?? result.currentVersion,
        checkedAt: Date.now(),
        error: null,
      });
    })
    .catch((error) => publishRuntimeUpdateState({
      status: 'error',
      currentVersion: before,
      checkedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => {
      runtimeCheckPromise = null;
    });
  return runtimeCheckPromise;
}

async function reportUpdateError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[desktop-updater]', message);
  const state = publishUpdateState({
    status: updateState.status === 'installing' ? 'ready' : 'error',
    checkedAt: Date.now(),
    error: message,
  });
  finishPendingCheck(state);
  if (!nativeCheckDialogPending || !showMessageBox) return;
  nativeCheckDialogPending = false;
  await showMessageBox({
    type: 'error',
    title: '检查桌面版更新失败',
    message: '暂时无法检查 Termdock Desktop 更新',
    detail: message,
  });
}

function configureUpdaterEvents(): void {
  autoUpdater.on('error', (error) => {
    nativeCheckInFlight = false;
    void reportUpdateError(error);
  });
  autoUpdater.on('checking-for-update', () => {
    publishUpdateState({ status: 'checking', error: null });
  });
  autoUpdater.on('update-available', () => {
    const state = publishUpdateState({ status: 'downloading', checkedAt: Date.now(), error: null });
    finishPendingCheck(state);
    if (!nativeCheckDialogPending || !showMessageBox) return;
    nativeCheckDialogPending = false;
    void showMessageBox({
      type: 'info',
      title: '发现新的桌面版本',
      message: 'Termdock Desktop 正在后台下载更新',
      detail: '下载完成后可以在设置中重启安装，也可以使用随后出现的系统提示。',
    });
  });
  autoUpdater.on('update-not-available', () => {
    nativeCheckInFlight = false;
    reportCurrentVersion();
  });
  autoUpdater.on(
    'update-downloaded',
    (_event, releaseNotes, releaseName) => {
      nativeCheckInFlight = false;
      nativeCheckDialogPending = false;
      const state = publishUpdateState({
        status: 'ready',
        latestVersion: normalizeReleaseVersion(releaseName),
        releaseName: releaseName || null,
        checkedAt: Date.now(),
        error: null,
      });
      finishPendingCheck(state);
      if (updateDialogShown || !showMessageBox) return;
      updateDialogShown = true;
      const notes = typeof releaseNotes === 'string' ? releaseNotes.trim() : '';
      void showMessageBox({
        type: 'info',
        title: 'Termdock Desktop 更新已下载',
        message: `${releaseName || '新版本'} 已准备好安装`,
        detail: notes ? `${notes}\n\n重启后会自动安装更新。` : '重启后会自动安装更新。',
        buttons: ['重启并安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      }).then((result) => {
        if (result.response === 0 && updateState.status === 'ready') installDownloadedDesktopUpdate();
      }).catch((error) => {
        console.error('[desktop-updater] update dialog failed', error);
      }).finally(() => {
        updateDialogShown = false;
      });
    },
  );
}

function reportCurrentVersion(): DesktopAppUpdateState {
  const state = publishUpdateState({
    status: 'current',
    latestVersion: null,
    releaseName: null,
    checkedAt: Date.now(),
    error: null,
  });
  finishPendingCheck(state);
  if (!nativeCheckDialogPending || !showMessageBox) return state;
  nativeCheckDialogPending = false;
  void showMessageBox({
    type: 'info',
    title: '桌面版已是最新版本',
    message: `当前 Termdock Desktop ${app.getVersion()} 已是最新版本。`,
  });
  return state;
}

async function runAutomaticChecks(): Promise<void> {
  await Promise.all([
    checkForDesktopUpdates(),
    checkForRuntimeUpdates().then((runtime) => {
      if (runtime.status === 'ready' && runtime.latestVersion) {
        console.log(`[desktop-updater] runtime staged at ${runtime.latestVersion}`);
      } else if (runtime.status === 'error') {
        console.error('[desktop-runtime] automatic update check failed', runtime.error);
      }
    }),
  ]).catch((error) => console.error('[desktop-updater] automatic check failed', error));
}

export function configureDesktopUpdater(displayMessageBox: ShowMessageBox): void {
  if (configured || !supportsAutomaticUpdates()) return;
  configured = true;
  showMessageBox = displayMessageBox;

  configureUpdaterEvents();

  const initialTimer = setTimeout(() => {
    void runAutomaticChecks();
  }, AUTOMATIC_CHECK_DELAY_MS);
  initialTimer.unref();
  const interval = setInterval(() => {
    void runAutomaticChecks();
  }, AUTOMATIC_CHECK_INTERVAL_MS);
  interval.unref();
}

export async function ensureLatestRuntime(): Promise<RuntimeUpdateResult | null> {
  if (!supportsAutomaticUpdates()) return null;
  runtimeDownloadPromise ??= updateRuntimeFromRegistry({
    appVersion: app.getVersion(),
    resourcesPath: process.resourcesPath,
  }).finally(() => {
    runtimeDownloadPromise = null;
  });
  return runtimeDownloadPromise;
}

export async function checkForDesktopUpdates(options: {
  presentNativeDialogs?: boolean;
} = {}): Promise<DesktopAppUpdateState> {
  if (!supportsAutomaticUpdates()) {
    const state = getDesktopUpdateState();
    if (options.presentNativeDialogs && showMessageBox) {
      await showMessageBox({
        type: 'info',
        title: '开发版本不检查桌面更新',
        message: '桌面版更新只在签名安装的 Termdock.app 中启用。',
      });
    }
    return state;
  }

  if (updateState.status === 'ready' || updateState.status === 'downloading' || updateState.status === 'installing') {
    if (options.presentNativeDialogs && showMessageBox && updateState.status !== 'installing') {
      const ready = updateState.status === 'ready';
      const result = await showMessageBox({
        type: 'info',
        message: ready ? '桌面版更新已准备好安装' : '桌面版更新正在后台下载',
        buttons: ready ? ['重启并安装', '稍后'] : ['好'],
        defaultId: 0,
        cancelId: ready ? 1 : 0,
      });
      if (ready && result.response === 0 && updateState.status === 'ready') installDownloadedDesktopUpdate();
    }
    return snapshotUpdateState();
  }
  nativeCheckDialogPending ||= options.presentNativeDialogs === true;
  if (checkPromise) return checkPromise;
  // Electron cannot cancel or identify native checks. Wait for its terminal
  // event before retrying, even if our UI deadline has already elapsed.
  if (nativeCheckInFlight) return snapshotUpdateState();

  publishUpdateState({ status: 'checking', error: null });
  checkPromise = new Promise<DesktopAppUpdateState>((resolve) => {
    let active = true;
    settleCheck = resolve;
    checkTimeout = setTimeout(() => {
      active = false;
      void reportUpdateError(new Error('Desktop update check timed out'));
    }, UPDATE_CHECK_TIMEOUT_MS);
    checkTimeout.unref?.();
    // Squirrel.Mac can treat a local proxy's standards-compliant 204 as an
    // invalid response on some Electron releases. Resolve the current-version
    // case from GitHub metadata before handing an actual update to it.
    void buildGitHubUpdateFeed(app.getVersion(), process.platform, process.arch).then((feed) => {
      if (!active) return undefined;
      if (feed.status === 204) {
        reportCurrentVersion();
        return undefined;
      }
      selectedFeed = feed;
      return ensureUpdateFeedConfigured();
    }).then((feedUrl) => {
      if (!active || !feedUrl) return;
      try {
        nativeCheckInFlight = true;
        autoUpdater.checkForUpdates();
      } catch (error) {
        nativeCheckInFlight = false;
        void reportUpdateError(error);
      }
    }).catch((error) => {
      if (active) void reportUpdateError(error);
    });
  });
  return checkPromise;
}

export function installDownloadedDesktopUpdate(): DesktopAppUpdateState {
  if (updateState.status !== 'ready') {
    throw new Error('Desktop update has not finished downloading');
  }
  const state = publishUpdateState({ status: 'installing', error: null });
  try {
    autoUpdater.quitAndInstall();
  } catch (error) {
    publishUpdateState({ status: 'ready', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  return state;
}
