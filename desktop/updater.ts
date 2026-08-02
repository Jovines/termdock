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

const UPDATE_REPOSITORY = 'Jovines/termdock';
const AUTOMATIC_CHECK_DELAY_MS = 15_000;
const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

type ShowMessageBox = (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;

let configured = false;
let manualCheckPending = false;
let updateDialogShown = false;
let showMessageBox: ShowMessageBox | null = null;
let lastReportedErrorAt = 0;

export function buildUpdateFeedUrl(
  version = app.getVersion(),
  platform = process.platform,
  arch = process.arch,
): string {
  return `https://update.electronjs.org/${UPDATE_REPOSITORY}/${platform}-${arch}/${version}`;
}

function supportsAutomaticUpdates(): boolean {
  return app.isPackaged && process.platform === 'darwin';
}

async function reportUpdateError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[desktop-updater]', message);
  const now = Date.now();
  if (!manualCheckPending || !showMessageBox || now - lastReportedErrorAt < 1_000) return;
  lastReportedErrorAt = now;
  manualCheckPending = false;
  await showMessageBox({
    type: 'error',
    title: '检查更新失败',
    message: '暂时无法检查 Termdock 更新',
    detail: message,
  });
}

export function configureDesktopUpdater(displayMessageBox: ShowMessageBox): void {
  if (configured || !supportsAutomaticUpdates()) return;
  configured = true;
  showMessageBox = displayMessageBox;

  autoUpdater.setFeedURL({ url: buildUpdateFeedUrl() });
  autoUpdater.on('error', (error) => {
    void reportUpdateError(error);
  });
  autoUpdater.on('update-available', () => {
    if (!manualCheckPending || !showMessageBox) return;
    manualCheckPending = false;
    void showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: 'Termdock 正在后台下载更新',
      detail: '下载完成后会询问是否立即重启安装。',
    });
  });
  autoUpdater.on('update-not-available', () => {
    if (!manualCheckPending || !showMessageBox) return;
    manualCheckPending = false;
    void showMessageBox({
      type: 'info',
      title: 'Termdock 已是最新版本',
      message: `当前版本 ${app.getVersion()} 已是最新版本。`,
    });
  });
  autoUpdater.on(
    'update-downloaded',
    (_event, releaseNotes, releaseName) => {
      if (updateDialogShown || !showMessageBox) return;
      updateDialogShown = true;
      const notes = typeof releaseNotes === 'string' ? releaseNotes.trim() : '';
      void showMessageBox({
        type: 'info',
        title: 'Termdock 更新已下载',
        message: `${releaseName || '新版本'} 已准备好安装`,
        detail: notes
          ? `${notes}\n\n重启后会自动安装更新。`
          : '重启后会自动安装更新。',
        buttons: ['重启并安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      }).then((result) => {
        if (result.response === 0) autoUpdater.quitAndInstall();
        else updateDialogShown = false;
      });
    },
  );

  const initialTimer = setTimeout(() => {
    void checkForDesktopUpdates(false);
  }, AUTOMATIC_CHECK_DELAY_MS);
  initialTimer.unref();
  const interval = setInterval(() => {
    void checkForDesktopUpdates(false);
  }, AUTOMATIC_CHECK_INTERVAL_MS);
  interval.unref();
}

export async function ensureLatestRuntime(): Promise<RuntimeUpdateResult | null> {
  if (!supportsAutomaticUpdates()) return null;
  return updateRuntimeFromRegistry({
    appVersion: app.getVersion(),
    resourcesPath: process.resourcesPath,
  });
}

export async function checkForDesktopUpdates(manual = true): Promise<void> {
  if (!supportsAutomaticUpdates()) {
    if (manual && showMessageBox) {
      await showMessageBox({
        type: 'info',
        title: '开发版本不检查更新',
        message: '自动更新只在签名安装的 Termdock.app 中启用。',
      });
    }
    return;
  }
  manualCheckPending ||= manual;
  try {
    const runtime = await ensureLatestRuntime();
    if (runtime?.status === 'updated') {
      console.log(`[desktop-updater] runtime updated to ${runtime.currentVersion}`);
      if (manual && showMessageBox) {
        manualCheckPending = false;
        await showMessageBox({
          type: 'info',
          title: 'Termdock Runtime 已更新',
          message: `已安装 ${runtime.currentVersion}`,
          detail: '下次由桌面版启动本机服务时自动使用；当前正在运行的服务和会话不受影响。',
        });
      }
      return;
    }
    if (runtime?.status !== 'requires-desktop') {
      if (manual && showMessageBox) {
        manualCheckPending = false;
        await showMessageBox({
          type: 'info',
          title: 'Termdock Runtime 已是最新版本',
          message: `当前 Runtime ${runtime?.currentVersion ?? app.getVersion()} 已是最新版本。`,
        });
      }
      return;
    }
    console.log(`[desktop-updater] desktop update required: ${runtime.reason ?? 'incompatible runtime'}`);
    await autoUpdater.checkForUpdates();
  } catch (error) {
    await reportUpdateError(error);
  }
}
