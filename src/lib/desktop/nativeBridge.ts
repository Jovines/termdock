export interface DesktopCliInstallation {
  path: string;
  version: string | null;
  bundled: boolean;
}

export interface DesktopNativeSnapshot {
  appVersion: string;
  bundledCliVersion: string;
  cliInstallations: DesktopCliInstallation[];
  localService: {
    running: boolean;
    probe: {
      url: string;
      version?: string;
    } | null;
  };
}

export interface TermdockDesktopBridge {
  platform: string;
  snapshot(): Promise<DesktopNativeSnapshot>;
  installCli(): Promise<DesktopNativeSnapshot>;
  showConnectionCenter(): Promise<void>;
  revealDataDirectory(): Promise<void>;
  showNotification(payload: DesktopNotificationPayload): Promise<boolean>;
  onNativeFileDrop(
    callback: (payload: NativeFileDropPayload) => void,
  ): void;
}

export interface DesktopNotificationPayload {
  title: string;
  body?: string;
  tag?: string;
  sessionId?: string;
  silent?: boolean;
  /** Persistent alert style: banners auto-dismiss on macOS, so the main
   *  process additionally bounces the Dock icon to keep the signal alive. */
  persistent?: boolean;
}

export interface NativeFileDropPayload {
  sessionKey: string;
  paths: string[];
}

declare global {
  interface Window {
    termdockDesktop?: TermdockDesktopBridge;
  }
}

export function getTermdockDesktopBridge(): TermdockDesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return window.termdockDesktop ?? null;
}

const nativeFileDropListeners = new Set<(payload: NativeFileDropPayload) => void>();
let nativeFileDropBridgeInstalled = false;

export function subscribeNativeFileDrops(
  listener: (payload: NativeFileDropPayload) => void,
): () => void {
  const bridge = getTermdockDesktopBridge();
  if (!bridge) return () => undefined;
  nativeFileDropListeners.add(listener);
  if (!nativeFileDropBridgeInstalled) {
    bridge.onNativeFileDrop((payload) => {
      for (const current of nativeFileDropListeners) current(payload);
    });
    nativeFileDropBridgeInstalled = true;
  }
  return () => {
    nativeFileDropListeners.delete(listener);
  };
}
