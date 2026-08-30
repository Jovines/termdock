import {
  app,
  autoUpdater,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
} from 'electron';
import {
  updateRuntimeFromRegistry,
  type RuntimeUpdateResult,
} from './runtime.js';
import { buildGitHubUpdateFeed, startGitHubUpdateFeedServer } from './githubUpdateFeed.js';
import type { DesktopAppUpdateState } from './types.js';

const AUTOMATIC_CHECK_DELAY_MS = 15_000;
const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const UPDATE_CHECK_TIMEOUT_MS = 30_000;

type ShowMessageBox = (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
type UpdateStateListener = (state: DesktopAppUpdateState) => void;

let configured = false;
let nativeCheckDialogPending = false;
let updateDialogShown = false;
let showMessageBox: ShowMessageBox | null = null;
let checkPromise: Promise<DesktopAppUpdateState> | null = null;
let settleCheck: ((state: DesktopAppUpdateState) => void) | null = null;
let checkTimeout: ReturnType<typeof setTimeout> | null = null;
let updateFeedPromise: Promise<string> | null = null;
const stateListeners = new Set<UpdateStateListener>();
let updateState: DesktopAppUpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  latestVersion: null,
  releaseName: null,
  checkedAt: null,
  error: null,
};

async function ensureUpdateFeedConfigured(): Promise<string> {
  updateFeedPromise ??= startGitHubUpdateFeedServer(
    app.getVersion(),
    process.platform,
    process.arch,
  ).then((feed) => {
    autoUpdater.setFeedURL({ url: feed.url });
    return feed.url;
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

async function reportUpdateError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[desktop-updater]', message);
  const state = publishUpdateState({ status: 'error', checkedAt: Date.now(), error: message });
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
    reportCurrentVersion();
  });
  autoUpdater.on(
    'update-downloaded',
    (_event, releaseNotes, releaseName) => {
      publishUpdateState({
        status: 'ready',
        latestVersion: normalizeReleaseVersion(releaseName),
        releaseName: releaseName || null,
        checkedAt: Date.now(),
        error: null,
      });
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
        if (result.response === 0) installDownloadedDesktopUpdate();
        else updateDialogShown = false;
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
  try {
    const runtime = await ensureLatestRuntime();
    if (runtime?.status === 'updated') {
      console.log(`[desktop-updater] runtime updated to ${runtime.currentVersion}`);
    }
  } catch (error) {
    console.error('[desktop-runtime] automatic update check failed', error);
  }
  await checkForDesktopUpdates().catch(() => undefined);
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
  return updateRuntimeFromRegistry({ appVersion: app.getVersion(), resourcesPath: process.resourcesPath });
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

  nativeCheckDialogPending ||= options.presentNativeDialogs === true;
  if (updateState.status === 'ready' || updateState.status === 'downloading') {
    return snapshotUpdateState();
  }
  if (checkPromise) return checkPromise;

  publishUpdateState({ status: 'checking', error: null });
  checkPromise = new Promise<DesktopAppUpdateState>((resolve) => {
    settleCheck = resolve;
    checkTimeout = setTimeout(() => {
      void reportUpdateError(new Error('Desktop update check timed out'));
    }, UPDATE_CHECK_TIMEOUT_MS);
    checkTimeout.unref?.();
    // Squirrel.Mac can treat a local proxy's standards-compliant 204 as an
    // invalid response on some Electron releases. Resolve the current-version
    // case from GitHub metadata before handing an actual update to it.
    void buildGitHubUpdateFeed(app.getVersion(), process.platform, process.arch).then((feed) => {
      if (feed.status === 204) {
        reportCurrentVersion();
        return undefined;
      }
      return ensureUpdateFeedConfigured();
    }).then((feedUrl) => {
      if (!feedUrl) return;
      try {
        autoUpdater.checkForUpdates();
      } catch (error) {
        void reportUpdateError(error);
      }
    }).catch((error) => void reportUpdateError(error));
  });
  return checkPromise;
}

export function installDownloadedDesktopUpdate(): DesktopAppUpdateState {
  if (updateState.status !== 'ready') {
    throw new Error('Desktop update has not finished downloading');
  }
  const state = publishUpdateState({ status: 'installing', error: null });
  autoUpdater.quitAndInstall();
  return state;
}
