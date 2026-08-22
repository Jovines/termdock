import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopAppUpdateState, DesktopSnapshot, ServiceProbe } from './types.js';

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
  startLocal: (): Promise<ServiceProbe> => ipcRenderer.invoke('desktop:start-local'),
  installCli: (): Promise<DesktopSnapshot> => ipcRenderer.invoke('desktop:install-cli'),
  desktopUpdateState: (): Promise<DesktopAppUpdateState> => ipcRenderer.invoke('desktop:update-state'),
  checkDesktopUpdate: (): Promise<DesktopAppUpdateState> => ipcRenderer.invoke('desktop:check-update'),
  installDesktopUpdate: (): Promise<DesktopAppUpdateState> => ipcRenderer.invoke('desktop:install-update'),
  onDesktopUpdateState: (callback: (state: DesktopAppUpdateState) => void): void => {
    ipcRenderer.on('desktop:update-state-changed', (_event, state: DesktopAppUpdateState) => callback(state));
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
      target.dataset.nativeFileDrag = 'true';
    };
    const clearDragState = (event: DragEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-termdock-terminal-dropzone]')
        : null;
      if (target) delete target.dataset.nativeFileDrag;
    };
    const handleDrop = (event: DragEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-termdock-terminal-dropzone]')
        : null;
      if (!target || !event.dataTransfer) return;
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => webUtils.getPathForFile(file))
        .filter((filePath) => filePath.length > 0);
      delete target.dataset.nativeFileDrag;
      if (paths.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      callback({
        sessionKey: target.dataset.termdockTerminalDropzone ?? '',
        paths,
      });
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
