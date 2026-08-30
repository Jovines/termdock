import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  DesktopAppUpdateState,
  DesktopPreferences,
  DesktopServiceActivity,
  DesktopSnapshot,
  DesktopStatusSnapshot,
  ServiceProbe,
} from './types.js';
import { shouldUploadDroppedFiles, uploadDroppedFiles } from './fileDropUpload.js';
import { installServiceActivityObserver } from './serviceActivityObserver.js';

if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
  try {
    contextBridge.executeInMainWorld({ func: installServiceActivityObserver });
  } catch (error) {
    console.warn('[desktop-activity] Could not install the compatibility observer', error);
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as {
    source?: unknown;
    activity?: { runningCount?: unknown; reviewCount?: unknown };
  } | null;
  if (data?.source !== 'termdock-desktop-activity-v1') return;
  ipcRenderer.send('desktop:observe-service-activity', data.activity ?? {});
});

type NativeDropState = 'local' | 'remote' | 'uploading' | 'error';

function setNativeDropState(target: HTMLElement, state: NativeDropState): void {
  target.dataset.nativeFileDrag = 'true';
  target.dataset.nativeFileDropState = state;
}

function clearNativeDropState(target: HTMLElement): void {
  delete target.dataset.nativeFileDrag;
  delete target.dataset.nativeFileDropState;
}

contextBridge.exposeInMainWorld('termdockDesktop', {
  platform: process.platform,
  notificationDeliveryConfirmation: true,
  snapshot: (): Promise<DesktopSnapshot> => ipcRenderer.invoke('desktop:snapshot'),
  probe: (url: string): Promise<ServiceProbe> => ipcRenderer.invoke('desktop:probe', url),
  saveConnection: (url: string, label: string): Promise<DesktopSnapshot> =>
    ipcRenderer.invoke('desktop:save-connection', { url, label }),
  removeConnection: (id: string): Promise<DesktopSnapshot> =>
    ipcRenderer.invoke('desktop:remove-connection', id),
  connect: (url: string): Promise<ServiceProbe> => ipcRenderer.invoke('desktop:connect', url),
  updateDesktopPreferences: (preferences: Partial<Pick<DesktopPreferences,
    'menuBarStatusEnabled' | 'floatingWidgetEnabled'>>): Promise<DesktopSnapshot> =>
    ipcRenderer.invoke('desktop:update-preferences', preferences),
  desktopStatus: (): Promise<DesktopStatusSnapshot> => ipcRenderer.invoke('desktop:status-snapshot'),
  onDesktopStatus: (callback: (status: DesktopStatusSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: DesktopStatusSnapshot) => callback(status);
    ipcRenderer.on('desktop:status-changed', listener);
    return () => ipcRenderer.removeListener('desktop:status-changed', listener);
  },
  focusNextService: (scope: 'attention' | 'running' | 'review' | 'all' = 'attention'): Promise<void> =>
    ipcRenderer.invoke('desktop:focus-next-service', scope),
  setFloatingMetricCount: (count: number): Promise<void> =>
    ipcRenderer.invoke('desktop:set-floating-metric-count', count),
  disableFloatingWidget: (): Promise<DesktopSnapshot> => ipcRenderer.invoke('desktop:disable-floating-widget'),
  startLocal: (): Promise<ServiceProbe> => ipcRenderer.invoke('desktop:start-local'),
  installCli: (): Promise<DesktopSnapshot> => ipcRenderer.invoke('desktop:install-cli'),
  desktopUpdateState: (): Promise<DesktopAppUpdateState> => ipcRenderer.invoke('desktop:update-state'),
  checkDesktopUpdate: (): Promise<DesktopAppUpdateState> => ipcRenderer.invoke('desktop:check-update'),
  installDesktopUpdate: (): Promise<DesktopAppUpdateState> => ipcRenderer.invoke('desktop:install-update'),
  onDesktopUpdateState: (callback: (state: DesktopAppUpdateState) => void): void => {
    ipcRenderer.on('desktop:update-state-changed', (_event, state: DesktopAppUpdateState) => callback(state));
  },
  reportServiceActivity: (activity: { runningCount: number; reviewCount: number }): void => {
    ipcRenderer.send('desktop:report-service-activity', activity);
  },
  focusService: (origin: string): Promise<boolean> => ipcRenderer.invoke('desktop:focus-service', origin),
  onServiceActivity: (callback: (services: DesktopServiceActivity[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, services: DesktopServiceActivity[]) => callback(services);
    ipcRenderer.on('desktop:service-activity-changed', listener);
    return () => ipcRenderer.removeListener('desktop:service-activity-changed', listener);
  },
  showConnectionCenter: (): Promise<void> => ipcRenderer.invoke('desktop:show-connection-center'),
  revealDataDirectory: (): Promise<void> => ipcRenderer.invoke('desktop:reveal-data-directory'),
  openNotificationSettings: (): Promise<void> => ipcRenderer.invoke('desktop:open-notification-settings'),
  prepareNotificationTest: (): Promise<void> => ipcRenderer.invoke('desktop:prepare-notification-test'),
  showNotification: (payload: {
    title: string;
    body?: string;
    tag?: string;
    sessionId?: string;
    silent?: boolean;
    persistent?: boolean;
  }): Promise<boolean> => ipcRenderer.invoke('desktop:show-notification', payload),
  onNativeFileDrop: (
    callback: (payload: { sessionKey: string; paths: string[] }) => void,
  ): void => {
    const handleDragOver = (event: DragEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-termdock-terminal-dropzone]')
        : null;
      if (!target || !event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setNativeDropState(
        target,
        shouldUploadDroppedFiles(window.location.hostname) ? 'remote' : 'local',
      );
    };
    const clearDragState = (event: DragEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-termdock-terminal-dropzone]')
        : null;
      if (target) clearNativeDropState(target);
    };
    const handleDrop = async (event: DragEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-termdock-terminal-dropzone]')
        : null;
      if (!target || !event.dataTransfer) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) {
        clearNativeDropState(target);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const sessionKey = target.dataset.termdockTerminalDropzone ?? '';

      if (!shouldUploadDroppedFiles(window.location.hostname)) {
        const paths = files
          .map((file) => webUtils.getPathForFile(file))
          .filter((filePath) => filePath.length > 0);
        clearNativeDropState(target);
        if (paths.length > 0) callback({ sessionKey, paths });
        return;
      }

      setNativeDropState(target, 'uploading');
      try {
        const paths = await uploadDroppedFiles(files);
        clearNativeDropState(target);
        if (paths.length > 0) callback({ sessionKey, paths });
      } catch (error) {
        console.error('[desktop-file-drop] Failed to upload files to the current service', error);
        setNativeDropState(target, 'error');
        window.setTimeout(() => {
          if (target.dataset.nativeFileDropState === 'error') clearNativeDropState(target);
        }, 3000);
      }
    };
    document.addEventListener('dragover', handleDragOver, true);
    document.addEventListener('dragleave', clearDragState, true);
    document.addEventListener('drop', handleDrop, true);
  },
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.termdockDesktop = 'true';
});

ipcRenderer.on('desktop:open-settings', () => {
  window.dispatchEvent(new CustomEvent('termdock:open-settings'));
});

ipcRenderer.on('desktop:command', (_event, command: string) => {
  window.dispatchEvent(new CustomEvent('termdock:native-command', { detail: command }));
});

ipcRenderer.on('desktop:focus-session', (_event, sessionId: string) => {
  window.dispatchEvent(new CustomEvent('termdock:focus-session', { detail: sessionId }));
});
