import { routeCollaborationInput } from '../collaboration/inputTarget';
import { escapeShellPath } from './shellPath';
import type { ServiceDirectoryBridge } from '../services/serviceDirectory';
import { installEncryptedFileDrops } from './encryptedFileDrops';
export interface DesktopNativeSnapshot {
  appVersion: string;
  localService: {
    running: boolean;
    probe: {
      url: string;
      version?: string;
    } | null;
  };
}

export interface DesktopServiceActivity {
  origin: string;
  targetPeerId?: string;
  label: string;
  current: boolean;
  focused: boolean;
  runningCount: number;
  reviewCount: number;
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

export interface TermdockDesktopBridge extends ServiceDirectoryBridge {
  capabilities?:{webWorkspace?:boolean};
  openExternal?(url:string):Promise<void>;
  writeClipboardText?(text:string):Promise<void>;
  platform: string;
  /** Explicit Preview page-dialog capability; legacy Electron/browser omit it. */
  confirmationUI?: 'page-v1';
  confirm?(options: { title: string; message: string; confirmLabel: string; cancelLabel: string }): Promise<boolean>;
  /** Bounded, visible page feedback; no business operation or approval. */
  alert?(message:string):void;
  /** Metadata receipt after real page authorization; never grants permission. */
  acknowledgeServiceInvitation?(options: { targetPeerId: string; fingerprint: string }, isCurrent: () => boolean): Promise<boolean>;
  deviceInfo?(): Promise<import('../../server/federation/deviceProfile').DeviceProfile>;
  /** Versioned discovery/mutation contract; legacy clients omit this object. */
  collaboration?: { protocolVersion: number; peers: boolean; save: boolean };
  collaborationPeers?(): Promise<import('../collaboration/directory').CollaborationPeers>;
  collaborationList?(): Promise<{ groups: import('../terminal/api').CollaborationGroup[]; sessions: import('../terminal/api').OrchestrationSession[] }>;
  collaborationSave?(input: import('../terminal/api').CollaborationGroupInput & { expectedOrigin?: string }): Promise<{ group: import('../terminal/api').CollaborationGroup }>;
  collaborationRemove?(id: string): Promise<void>;
  collaborationFocus?(id: string, targetPeerId?:string): Promise<boolean>;
  /** Present when the desktop shell only acknowledges confirmed native delivery. */
  notificationDeliveryConfirmation?: boolean;
  snapshot(): Promise<DesktopNativeSnapshot>;
  desktopUpdateState?(): Promise<DesktopAppUpdateState>;
  checkDesktopUpdate?(): Promise<DesktopAppUpdateState>;
  installDesktopUpdate?(): Promise<DesktopAppUpdateState>;
  onDesktopUpdateState?(callback: (state: DesktopAppUpdateState) => void): void;
  onStartupProgress?(callback: (message: string | null) => void): void;
  reportServiceActivity?(activity: { runningCount: number; reviewCount: number }): void;
  focusService?(origin: string): Promise<boolean>;
  onServiceActivity?(callback: (services: DesktopServiceActivity[]) => void): () => void;
  showConnectionCenter(): Promise<void>;
  revealDataDirectory(): Promise<void>;
  openNotificationSettings?(): Promise<void>;
  prepareNotificationTest?(): Promise<void>;
  showNotification(payload: DesktopNotificationPayload): Promise<boolean>;
  /** Movie/file bytes or original paths verified for this Mac's service.
   * The active page owns encrypted uploads. Older bridges ignore options. */
  readClipboardFiles?(options?: { localServiceId?: string }): Promise<Array<{ name: string; bytes?: ArrayBuffer; type?: string; path?: string }>>;
  /** Native PNG bytes only; the renderer owns encrypted upload and target routing. */
  readClipboardImage?(): Promise<ArrayBuffer | null>;
  /** Preview saves page-fetched encrypted download bytes through a bounded native transfer. */
  saveDownloadBlob?(blob: Blob, filename: string, signal?: AbortSignal): Promise<'saved' | 'started' | 'canceled'>;
  saveDownloadStream?(stream: ReadableStream<Uint8Array>, filename: string, options?: { signal?: AbortSignal; expectedBytes?: number }): Promise<'saved' | 'canceled'>;
  /** Legacy isolated preload uploader. New UI must upload in the encrypted renderer. */
  pasteClipboardImage?(): Promise<string | null>;
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

export type DesktopServiceActivityBridge = TermdockDesktopBridge & Required<Pick<
  TermdockDesktopBridge,
  'reportServiceActivity' | 'focusService' | 'onServiceActivity'
>>;

export function supportsDesktopServiceActivity(
  bridge: TermdockDesktopBridge | null,
): bridge is DesktopServiceActivityBridge {
  return typeof bridge?.reportServiceActivity === 'function'
    && typeof bridge.focusService === 'function'
    && typeof bridge.onServiceActivity === 'function';
}

const nativeFileDropListeners = new Set<(payload: NativeFileDropPayload) => void>();
let nativeFileDropBridgeInstalled = false;

export function subscribeNativeFileDrops(
  listener: (payload: NativeFileDropPayload) => void,
): () => void {
  const bridge = getTermdockDesktopBridge();
  nativeFileDropListeners.add(listener);
  if (!nativeFileDropBridgeInstalled) {
    const deliver = (payload: NativeFileDropPayload) => {
      if (routeCollaborationInput(payload.paths.map(escapeShellPath).join(' ') + ' ')) return;
      for (const current of nativeFileDropListeners) current(payload);
    };
    installEncryptedFileDrops(deliver, !!bridge);
    bridge?.onNativeFileDrop(deliver);
    nativeFileDropBridgeInstalled = true;
  }
  return () => {
    nativeFileDropListeners.delete(listener);
  };
}
