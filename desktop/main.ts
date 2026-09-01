import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  type Session,
} from 'electron';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type {
  CliInstallation,
  DesktopConfig,
  DesktopPreferences,
  DesktopServiceActivity,
  DesktopSnapshot,
  DesktopStatusSnapshot,
  LocalServerState,
  LocalServiceStatus,
  SavedConnection,
  ServiceProbe,
  TrustedCertificateAuthority,
} from './types.js';
import {
  desktopStatusTooltip,
  formatCompactDesktopStatus,
  menuBarStatusRows,
  mergeServiceActivity,
  nextServiceOrigin,
  normalizeServiceActivity,
  summarizeServiceActivity,
  type ServiceActivityCount,
  type ActivityFocusScope,
} from './activityStatus.js';
import {
  checkForDesktopUpdates,
  checkForRuntimeUpdates,
  configureDesktopUpdater,
  ensureLatestRuntime,
  getDesktopUpdateState,
  getDesktopRuntimeUpdateState,
  installDownloadedDesktopUpdate,
  markDesktopRuntimeRestarting,
  markDesktopRuntimeRunning,
  subscribeDesktopRuntimeUpdateState,
  subscribeDesktopUpdateState,
} from './updater.js';
import {
  resolvePackagedRuntime,
  rollbackDownloadedRuntime,
  type DesktopRuntimePaths,
} from './runtime.js';
import { isExternalLinkStagingUrl, isSafeExternalUrl } from './externalLinks.js';
import { shouldThrottleDesktopRenderer } from './windowPolicy.js';
import {
  canOfferCertificateTrust,
  downloadCertificateAuthority,
  isCertificateTrustError,
  isLocalNetworkHostname,
  type DownloadedCertificateAuthority,
} from './certificateTrust.js';

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '..');
const termdockDir = path.join(os.homedir(), '.termdock');
const desktopConfigPath = path.join(termdockDir, 'desktop.json');
const serverStatePath = path.join(termdockDir, 'server.json');
const DEFAULT_LOCAL_URL = 'http://localhost:9834';
const PROTOCOL_VERSION = 1;
const HEALTH_TIMEOUT_MS = 3_500;
const START_TIMEOUT_MS = 90_000;
const RESTORE_LOAD_TIMEOUT_MS = 15_000;
const localServiceCertificatePath = path.join(termdockDir, 'certs', 'termdock-local.pem');
const sessionTrustedCertificateTargets = new Set<string>();
const sessionTrustedCertificateAuthorities = new Map<string, string>();
let managedLocalCertificateFingerprint: string | null = null;

/** Delivered-but-unseen desktop notifications, mirrored into the Dock badge. */
const activeNotifications = new Map<string, Notification>();
let unreadNotificationCount = 0;

function clearUnreadNotifications(): void {
  unreadNotificationCount = 0;
  app.setBadgeCount(0);
}

function triggerLocalNetworkPermission(): void {
  if (process.platform !== 'darwin') return;
  const socket = dgram.createSocket('udp4');
  const close = () => {
    try {
      socket.close();
    } catch {
      // The socket may already be closed after an immediate send failure.
    }
  };
  socket.once('error', close);
  socket.send(Buffer.from('Termdock'), 5353, '224.0.0.251', close);
}

let mainWindow: BrowserWindow | null = null;
let startupRestoreActive = false;
let startupProgressMessage = '正在启动 Termdock Desktop…';
const serviceWindows = new Map<string, BrowserWindow>();
const windowServiceOrigins = new WeakMap<BrowserWindow, string>();
const restorableServiceWindows = new WeakSet<BrowserWindow>();
const reportedServiceActivity = new Map<string, ServiceActivityCount>();
const observedServiceActivity = new Map<string, ServiceActivityCount>();
let lastFocusedServiceWindow: BrowserWindow | null = null;
let menuBarStatus: Tray | null = null;
let menuBarStatusWidth = 0;
let floatingWidgetWindow: BrowserWindow | null = null;
let floatingPositionTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
const FLOATING_WIDGET_WIDTHS = [64, 108, 152] as const;
const FLOATING_WIDGET_HEIGHT = 40;

function focusedWorkspaceWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windowServiceOrigins.has(focused)) return focused;
  if (lastFocusedServiceWindow && !lastFocusedServiceWindow.isDestroyed()) {
    return lastFocusedServiceWindow;
  }
  return [...serviceWindows.values()].find((window) => !window.isDestroyed()) ?? null;
}

function showAndFocusWindow(window: BrowserWindow): void {
  if (windowServiceOrigins.has(window)) lastFocusedServiceWindow = window;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function serviceActivitySnapshot(targetWindow: BrowserWindow): DesktopServiceActivity[] {
  const currentOrigin = windowServiceOrigins.get(targetWindow);
  return [...serviceWindows.entries()].flatMap(([origin, window]) => {
    if (window.isDestroyed()) return [];
    const activity = mergeServiceActivity(
      reportedServiceActivity.get(origin),
      observedServiceActivity.get(origin),
    );
    return [{
      origin,
      label: serviceLabel(origin),
      current: origin === currentOrigin,
      focused: window.isFocused(),
      ...activity,
    }];
  });
}

function broadcastServiceActivity(): void {
  for (const window of serviceWindows.values()) {
    if (window.isDestroyed()) continue;
    window.webContents.send('desktop:service-activity-changed', serviceActivitySnapshot(window));
  }
  refreshDesktopStatusSurfaces();
}

function serviceLabel(url: string): string {
  const normalized = normalizeServiceUrl(url);
  const saved = readDesktopConfig().connections.find((entry) => entry.url === normalized);
  if (saved?.label.trim()) return saved.label.trim();
  const parsed = new URL(normalized);
  return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    ? '本机'
    : parsed.host;
}

function allServiceActivity(): DesktopServiceActivity[] {
  const focused = BrowserWindow.getFocusedWindow();
  return [...serviceWindows.entries()].flatMap(([origin, window]) => {
    if (window.isDestroyed()) return [];
    return [{
      origin,
      label: serviceLabel(origin),
      current: window === lastFocusedServiceWindow,
      focused: window === focused,
      ...mergeServiceActivity(
        reportedServiceActivity.get(origin),
        observedServiceActivity.get(origin),
      ),
    }];
  });
}

function desktopStatusSnapshot(): DesktopStatusSnapshot {
  const services = allServiceActivity();
  const summary = summarizeServiceActivity(services);
  return {
    ...summary,
    text: formatCompactDesktopStatus(summary),
    tooltip: desktopStatusTooltip(summary),
    services,
    preferences: readDesktopConfig().desktopPreferences,
  };
}

function nextServiceWindow(scope: ActivityFocusScope): BrowserWindow | null {
  const currentOrigin = lastFocusedServiceWindow && !lastFocusedServiceWindow.isDestroyed()
    ? windowServiceOrigins.get(lastFocusedServiceWindow) ?? null
    : null;
  const origin = nextServiceOrigin(allServiceActivity(), currentOrigin, scope);
  return origin ? serviceWindows.get(origin) ?? null : focusedWorkspaceWindow();
}

function focusNextService(scope: ActivityFocusScope = 'attention'): void {
  const target = nextServiceWindow(scope);
  if (target && !target.isDestroyed()) {
    showAndFocusWindow(target);
    return;
  }
  void showConnectionCenter();
}

function menuBarContextMenu(): Menu {
  const status = desktopStatusSnapshot();
  const serviceItems: MenuItemConstructorOptions[] = status.services.length > 0
    ? status.services
      .sort((left, right) => right.reviewCount - left.reviewCount
        || right.runningCount - left.runningCount
        || left.label.localeCompare(right.label))
      .map((service) => ({
        label: `${service.label}${service.runningCount > 0 ? `  运行 ${service.runningCount}` : ''}${service.reviewCount > 0 ? `  待办 ${service.reviewCount}` : ''}`,
        click: () => {
          const target = serviceWindows.get(service.origin);
          if (target && !target.isDestroyed()) showAndFocusWindow(target);
        },
      }))
    : [{ label: '暂无已打开服务', enabled: false }];
  return Menu.buildFromTemplate([
    { label: status.tooltip, enabled: false },
    { type: 'separator' },
    ...serviceItems,
    { type: 'separator' },
    { label: '连接中心…', click: () => void showConnectionCenter() },
    {
      label: '显示悬浮状态',
      type: 'checkbox',
      checked: status.preferences.floatingWidgetEnabled,
      click: (item) => updateDesktopPreferences({ floatingWidgetEnabled: item.checked }),
    },
    { type: 'separator' },
    { role: 'quit' },
  ]);
}

function menuBarStatusImage(status: DesktopStatusSnapshot): Electron.NativeImage {
  const size = 18;
  const scale = 2;
  const bitmap = Buffer.alloc(size * scale * size * scale * 4);
  const glyphs: Record<string, string[]> = {
    '0': ['111', '101', '101', '101', '111'],
    '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'],
    '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'],
    '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'],
    '7': ['111', '001', '010', '010', '010'],
    '8': ['111', '101', '111', '101', '111'],
    '9': ['111', '101', '111', '001', '111'],
    '+': ['000', '010', '111', '010', '000'],
  };
  const drawPixel = (x: number, y: number, alpha = 255) => {
    for (let offsetY = 0; offsetY < scale; offsetY += 1) {
      for (let offsetX = 0; offsetX < scale; offsetX += 1) {
        const pixelX = x * scale + offsetX;
        const pixelY = y * scale + offsetY;
        if (pixelX < 0 || pixelX >= size * scale || pixelY < 0 || pixelY >= size * scale) continue;
        bitmap[(pixelY * size * scale + pixelX) * 4 + 3] = alpha;
      }
    }
  };
  const drawGlyph = (value: number, x: number, y: number, alpha: number) => {
    const glyph = glyphs[value > 9 ? '+' : String(value)] ?? glyphs['0'];
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((cell, columnIndex) => {
        if (cell === '1') drawPixel(x + columnIndex, y + rowIndex, alpha);
      });
    });
  };
  const icons = {
    running: [[0, 0], [0, 1], [1, 1], [0, 2], [1, 2], [2, 2], [3, 2], [0, 3], [1, 3], [0, 4]],
    review: [[2, 0], [1, 1], [3, 1], [0, 2], [4, 2], [1, 3], [3, 3], [2, 4]],
    services: [[0, 0], [1, 0], [3, 0], [4, 0], [1, 1], [3, 1], [2, 2], [2, 3], [1, 4], [2, 4], [3, 4]],
  } satisfies Record<string, number[][]>;
  // A single connection is the normal case, so its count is redundant. Give
  // the two actionable activity rows more breathing room instead. Zero and
  // multiple connections keep the service row because those states matter.
  menuBarStatusRows(status).forEach(({ metric, value, y }) => {
    const alpha = value > 0 ? 255 : 96;
    icons[metric].forEach(([offsetX, offsetY]) => drawPixel(1 + offsetX, y + offsetY, alpha));
    drawGlyph(value, 11, y, alpha);
  });
  // Template images are intentionally monochrome; macOS supplies the correct
  // menu-bar color for the active appearance and accessibility state.
  const image = nativeImage.createFromBitmap(bitmap, {
    width: size * scale,
    height: size * scale,
    scaleFactor: scale,
  });
  image.setTemplateImage(true);
  return image;
}

function refreshMenuBarStatus(status: DesktopStatusSnapshot): void {
  if (process.platform !== 'darwin' || !status.preferences.menuBarStatusEnabled) {
    menuBarStatus?.destroy();
    menuBarStatus = null;
    menuBarStatusWidth = 0;
    return;
  }
  const image = menuBarStatusImage(status);
  const imageWidth = image.getSize().width;
  if (!menuBarStatus || menuBarStatus.isDestroyed() || menuBarStatusWidth !== imageWidth) {
    menuBarStatus?.destroy();
    menuBarStatus = new Tray(image);
    menuBarStatusWidth = imageWidth;
    menuBarStatus.on('click', () => focusNextService('attention'));
    menuBarStatus.on('right-click', () => menuBarStatus?.popUpContextMenu(menuBarContextMenu()));
  } else {
    menuBarStatus.setImage(image);
  }
  menuBarStatus.setTitle('');
  menuBarStatus.setToolTip(`${status.tooltip}\n点击循环切换需关注的服务`);
}

function constrainFloatingPosition(
  position: { x: number; y: number } | null,
  width: number = FLOATING_WIDGET_WIDTHS[2],
): { x: number; y: number } {
  const height = FLOATING_WIDGET_HEIGHT;
  const display = position
    ? screen.getDisplayMatching({ x: position.x, y: position.y, width, height })
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const preferred = position ?? {
    x: area.x + area.width - width - 18,
    y: area.y + 18,
  };
  return {
    x: Math.min(area.x + area.width - width, Math.max(area.x, Math.round(preferred.x))),
    y: Math.min(area.y + area.height - height, Math.max(area.y, Math.round(preferred.y))),
  };
}

function createFloatingWidget(position: { x: number; y: number } | null): BrowserWindow {
  const bounds = constrainFloatingPosition(position);
  const window = new BrowserWindow({
    title: 'Termdock Status',
    type: 'panel',
    width: FLOATING_WIDGET_WIDTHS[2],
    height: FLOATING_WIDGET_HEIGHT,
    x: bounds.x,
    y: bounds.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: 'rgba(0, 0, 0, 0)',
    vibrancy: 'popover',
    visualEffectState: 'active',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(currentDir, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    // Electron otherwise temporarily transforms the whole process into a UI
    // element, which can hide the app menu and remove normal windows from App
    // Expose while this panel exists.
    skipTransformProcessType: true,
  });
  // Keep the auxiliary status panel out of App Expose / Mission Control so it
  // cannot disrupt macOS's three-finger application-window gesture.
  window.setHiddenInMissionControl(true);
  let constrainingMove = false;
  window.on('move', () => {
    if (constrainingMove || window.isDestroyed()) return;
    const [x, y] = window.getPosition();
    const [width] = window.getSize();
    const constrained = constrainFloatingPosition({ x, y }, width);
    if (constrained.x === x && constrained.y === y) return;
    constrainingMove = true;
    window.setPosition(constrained.x, constrained.y, false);
    constrainingMove = false;
  });
  window.on('moved', () => {
    if (floatingPositionTimer) clearTimeout(floatingPositionTimer);
    floatingPositionTimer = setTimeout(() => {
      floatingPositionTimer = null;
      if (window.isDestroyed()) return;
      const [x, y] = window.getPosition();
      const config = readDesktopConfig();
      config.desktopPreferences.floatingWidgetPosition = { x, y };
      writeDesktopConfig(config);
    }, 250);
  });
  window.on('closed', () => {
    if (floatingWidgetWindow === window) floatingWidgetWindow = null;
  });
  const rendererPath = app.isPackaged
    ? path.join(process.resourcesPath, 'renderer', 'floating.html')
    : path.join(projectRoot, 'desktop', 'renderer', 'floating.html');
  void window.loadFile(rendererPath).then(() => window.showInactive());
  return window;
}

function resizeFloatingWidget(metricCount: number): void {
  const window = floatingWidgetWindow;
  if (!window || window.isDestroyed()) return;
  const safeCount = Math.min(3, Math.max(1, Math.round(metricCount)));
  const width = FLOATING_WIDGET_WIDTHS[safeCount - 1];
  const [currentWidth] = window.getSize();
  if (currentWidth === width) return;
  const [x, y] = window.getPosition();
  window.setSize(width, FLOATING_WIDGET_HEIGHT, false);
  const constrained = constrainFloatingPosition({ x: x + currentWidth - width, y }, width);
  window.setPosition(constrained.x, constrained.y, false);
}

function refreshFloatingWidget(status: DesktopStatusSnapshot): void {
  if (process.platform !== 'darwin' || !status.preferences.floatingWidgetEnabled) {
    if (floatingWidgetWindow && !floatingWidgetWindow.isDestroyed()) floatingWidgetWindow.destroy();
    floatingWidgetWindow = null;
    return;
  }
  if (!floatingWidgetWindow || floatingWidgetWindow.isDestroyed()) {
    floatingWidgetWindow = createFloatingWidget(status.preferences.floatingWidgetPosition);
  }
}

function keepFloatingWidgetOnScreen(): void {
  if (!floatingWidgetWindow || floatingWidgetWindow.isDestroyed()) return;
  const [x, y] = floatingWidgetWindow.getPosition();
  const [width] = floatingWidgetWindow.getSize();
  const constrained = constrainFloatingPosition({ x, y }, width);
  if (constrained.x !== x || constrained.y !== y) {
    floatingWidgetWindow.setPosition(constrained.x, constrained.y, false);
  }
}

function refreshDesktopStatusSurfaces(): void {
  if (!app.isReady()) return;
  const status = desktopStatusSnapshot();
  refreshMenuBarStatus(status);
  refreshFloatingWidget(status);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('desktop:status-changed', status);
  }
}

function updateDesktopPreferences(
  patch: Partial<Pick<DesktopPreferences, 'menuBarStatusEnabled' | 'floatingWidgetEnabled'>>,
): void {
  const config = readDesktopConfig();
  if (typeof patch.menuBarStatusEnabled === 'boolean') {
    config.desktopPreferences.menuBarStatusEnabled = patch.menuBarStatusEnabled;
  }
  if (typeof patch.floatingWidgetEnabled === 'boolean') {
    config.desktopPreferences.floatingWidgetEnabled = patch.floatingWidgetEnabled;
  }
  writeDesktopConfig(config);
  refreshDesktopStatusSurfaces();
}

function showDesktopMessageBox(options: MessageBoxOptions) {
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
  return parent
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);
}

function openExternalLink(url: string): void {
  if (!isSafeExternalUrl(url)) return;
  void shell.openExternal(url);
}

function certificateTrustKey(hostname: string, fingerprint: string): string {
  return `${hostname.toLowerCase().replace(/^\[|\]$/g, '')}\0${fingerprint}`;
}

function installCertificateVerifyProcedure(targetSession: Session = session.defaultSession): void {
  targetSession.setCertificateVerifyProc((request, callback) => {
    let isLocalTarget = false;
    try {
      isLocalTarget = isLocalNetworkTarget(new URL(`https://${request.hostname}`));
    } catch {
      // Keep Chromium's default verification for malformed hostnames.
    }
    let presentedFingerprint: string | null = null;
    try {
      presentedFingerprint = new crypto.X509Certificate(request.certificate.data).fingerprint256;
    } catch {
      // Keep Chromium's default verification if the certificate cannot be parsed.
    }
    const explicitlyTrustedTarget = presentedFingerprint
      ? sessionTrustedCertificateTargets.has(certificateTrustKey(request.hostname, presentedFingerprint))
      : false;
    const managedLocalCertificate = isLocalTarget
      && presentedFingerprint === managedLocalCertificateFingerprint;
    callback(explicitlyTrustedTarget || managedLocalCertificate ? 0 : -3);
  });
}

function configureLocalServiceCertificateTrust(): void {
  try {
    managedLocalCertificateFingerprint = new crypto.X509Certificate(
      fs.readFileSync(localServiceCertificatePath),
    ).fingerprint256;
  } catch {
    // The certificate is created when the local service first enables HTTPS.
  }
  installCertificateVerifyProcedure();
}

function defaultConfig(): DesktopConfig {
  return {
    version: 1,
    connections: [],
    lastConnectionUrl: null,
    openConnectionUrls: [],
    trustedCertificateAuthorities: [],
    desktopPreferences: {
      menuBarStatusEnabled: true,
      floatingWidgetEnabled: false,
      floatingWidgetPosition: null,
    },
  };
}

function normalizeDesktopPreferences(value: unknown): DesktopPreferences {
  const input = value && typeof value === 'object'
    ? value as Partial<DesktopPreferences>
    : {};
  const position = input.floatingWidgetPosition;
  return {
    // The compact, text-only status is the useful default on macOS. Existing
    // desktop.json files therefore gain the feature without a migration step.
    menuBarStatusEnabled: input.menuBarStatusEnabled !== false,
    floatingWidgetEnabled: input.floatingWidgetEnabled === true,
    floatingWidgetPosition: position
      && Number.isFinite(position.x)
      && Number.isFinite(position.y)
      ? { x: Math.round(position.x), y: Math.round(position.y) }
      : null,
  };
}

function normalizeServiceUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('请输入 Termdock 服务地址');
  const parsed = new URL(value.includes('://') ? value : `http://${value}`);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('服务地址只支持 http:// 或 https://');
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

function isLocalNetworkTarget(url: URL): boolean {
  return isLocalNetworkHostname(url.hostname);
}

function networkErrorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause ? `${error.message} ${networkErrorDetails(cause)}` : error.message;
}

function looksLikeLocalNetworkPermissionError(error: unknown): boolean {
  return /ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_ACCESS_DENIED/i.test(networkErrorDetails(error));
}

function certificateDetail(target: string, certificate: DownloadedCertificateAuthority): string {
  return [
    `目标：${target}`,
    `CA：${certificate.subject.replace(/\n/g, ', ')}`,
    `CA SHA-256：${certificate.fingerprint256}`,
    `服务证书 SHA-256：${certificate.leafFingerprint256}`,
    `有效期：${certificate.validFrom} — ${certificate.validTo}`,
    '',
    '继续后仅 Termdock 会信任该目标使用的这张 CA，不会修改 macOS 系统钥匙串。请只信任你确认属于该服务的证书。',
  ].join('\n');
}

function trustedCertificateAuthorityFor(target: string): TrustedCertificateAuthority | undefined {
  const origin = new URL(target).origin;
  return readDesktopConfig().trustedCertificateAuthorities.find((entry) => entry.origin === origin);
}

async function requestCertificateTrust(
  target: string,
): Promise<DownloadedCertificateAuthority | null> {
  let certificate: DownloadedCertificateAuthority;
  try {
    certificate = await downloadCertificateAuthority(target);
  } catch (error) {
    await showDesktopMessageBox({
      type: 'error',
      title: '无法获取可信的 CA 证书',
      message: `无法为 ${target} 准备证书信任`,
      detail: networkErrorDetails(error),
    });
    return null;
  }

  const existingTrust = trustedCertificateAuthorityFor(target);
  if (existingTrust?.fingerprint256 === certificate.fingerprint256) {
    sessionTrustedCertificateAuthorities.set(new URL(target).origin, certificate.certificatePem);
    sessionTrustedCertificateTargets.add(
      certificateTrustKey(new URL(target).hostname, certificate.leafFingerprint256),
    );
    return certificate;
  }

  const confirmation = await showDesktopMessageBox({
    type: 'warning',
    title: '信任 HTTPS 服务证书',
    message: existingTrust
      ? '此服务的 CA 证书已发生变化'
      : '此服务使用了 Termdock 尚未信任的 HTTPS 证书',
    detail: `${certificateDetail(target, certificate)}${existingTrust
      ? `\n\n此前信任的 CA SHA-256：${existingTrust.fingerprint256}`
      : ''}`,
    buttons: ['信任并连接', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (confirmation.response !== 0) return null;

  const config = readDesktopConfig();
  const origin = new URL(target).origin;
  config.trustedCertificateAuthorities = config.trustedCertificateAuthorities
    .filter((entry) => entry.origin !== origin);
  config.trustedCertificateAuthorities.push({
    origin,
    fingerprint256: certificate.fingerprint256,
    subject: certificate.subject,
    trustedAt: Date.now(),
  });
  writeDesktopConfig(config);
  sessionTrustedCertificateAuthorities.set(origin, certificate.certificatePem);
  sessionTrustedCertificateTargets.add(
    certificateTrustKey(new URL(target).hostname, certificate.leafFingerprint256),
  );
  return certificate;
}

async function requestLocalNetworkPermissionRetry(target: string): Promise<boolean> {
  const result = await showDesktopMessageBox({
    type: 'warning',
    title: '需要本地网络权限',
    message: 'macOS 阻止了 Termdock 访问局域网服务',
    detail: `目标：${target}\n\n请在系统提示中选择“允许”。如果之前选择过“不允许”，请前往“系统设置 → 隐私与安全性 → 本地网络”开启 Termdock。`,
    buttons: ['已允许，重试', '打开系统设置', '取消'],
    defaultId: 0,
    cancelId: 2,
  });
  if (result.response === 1) {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
    );
  }
  return result.response === 0;
}

function readDesktopConfig(): DesktopConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(desktopConfigPath, 'utf8')) as Partial<DesktopConfig>;
    if (parsed.version !== 1 || !Array.isArray(parsed.connections)) return defaultConfig();
    const lastConnectionUrl = typeof parsed.lastConnectionUrl === 'string' ? parsed.lastConnectionUrl : null;
    return {
      version: 1,
      connections: parsed.connections.filter((entry): entry is SavedConnection =>
        Boolean(entry)
        && typeof entry.id === 'string'
        && typeof entry.label === 'string'
        && typeof entry.url === 'string'),
      lastConnectionUrl,
      // Older desktop.json files only remembered the most recent window. Use
      // that value once as their restore list, while preserving an explicit
      // empty list when the user intentionally closed every service window.
      openConnectionUrls: Array.isArray(parsed.openConnectionUrls)
        ? parsed.openConnectionUrls.filter((url): url is string => typeof url === 'string')
        : lastConnectionUrl ? [lastConnectionUrl] : [],
      trustedCertificateAuthorities: Array.isArray(parsed.trustedCertificateAuthorities)
        ? parsed.trustedCertificateAuthorities.filter((entry): entry is TrustedCertificateAuthority =>
          Boolean(entry)
          && typeof entry.origin === 'string'
          && typeof entry.fingerprint256 === 'string'
          && typeof entry.subject === 'string'
          && typeof entry.trustedAt === 'number')
        : [],
      desktopPreferences: normalizeDesktopPreferences(parsed.desktopPreferences),
    };
  } catch {
    return defaultConfig();
  }
}

function writeDesktopConfig(config: DesktopConfig): void {
  fs.mkdirSync(termdockDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${desktopConfigPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, desktopConfigPath);
}

function readServerState(): LocalServerState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(serverStatePath, 'utf8')) as Partial<LocalServerState>;
    if (
      typeof parsed.pid !== 'number'
      || !Number.isInteger(parsed.pid)
      || typeof parsed.host !== 'string'
      || typeof parsed.port !== 'number'
    ) {
      return null;
    }
    return parsed as LocalServerState;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stateUrl(state: LocalServerState): string {
  if (state.localUrl) return normalizeServiceUrl(state.localUrl);
  const scheme = state.scheme ?? 'http';
  const host = state.host === '0.0.0.0' ? 'localhost' : state.host;
  return `${scheme}://${host}:${state.port}`;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    // Electron's network stack follows the macOS Keychain trust store. Node's
    // global fetch does not, so a healthy local service using Termdock's
    // mkcert certificate could otherwise be reported as a failed start.
    return await net.fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithCertificateAuthority(
  rawUrl: string,
  certificateAuthority?: string,
): Promise<{ status: number; json: unknown }> {
  return await new Promise((resolve, reject) => {
    const request = https.get(rawUrl, {
      agent: false,
      ca: certificateAuthority,
      rejectUnauthorized: true,
      headers: { Accept: 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256 * 1024) {
          request.destroy(new Error('服务响应过大'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            json: body ? JSON.parse(body) as unknown : null,
          });
        } catch {
          reject(new Error('服务返回了无效的 JSON'));
        }
      });
    });
    request.setTimeout(HEALTH_TIMEOUT_MS, () => request.destroy(new Error('连接超时')));
    request.on('error', reject);
  });
}

async function probeServiceWithCertificateAuthority(
  rawUrl: string,
  certificateAuthority?: string,
): Promise<ServiceProbe> {
  const url = normalizeServiceUrl(rawUrl);
  try {
    const healthResponse = await fetchJsonWithCertificateAuthority(
      `${url}/health`,
      certificateAuthority,
    );
    if (healthResponse.status < 200 || healthResponse.status >= 300) {
      return { ok: false, url, error: `健康检查返回 HTTP ${healthResponse.status}` };
    }
    const health = healthResponse.json as { status?: unknown } | null;
    if (health?.status !== 'ok') {
      return { ok: false, url, error: '目标地址不是可识别的 Termdock 服务' };
    }

    try {
      const metadataResponse = await fetchJsonWithCertificateAuthority(
        `${url}/api/meta`,
        certificateAuthority,
      );
      if (metadataResponse.status >= 200 && metadataResponse.status < 300) {
        const metadata = metadataResponse.json as {
          product?: unknown;
          version?: unknown;
          protocolVersion?: unknown;
          desktopManaged?: unknown;
        } | null;
        if (metadata?.product && metadata.product !== 'termdock') {
          return { ok: false, url, error: '目标服务的产品标识不是 Termdock' };
        }
        return {
          ok: true,
          url,
          version: typeof metadata?.version === 'string' ? metadata.version : undefined,
          protocolVersion: typeof metadata?.protocolVersion === 'number'
            ? metadata.protocolVersion
            : undefined,
          desktopManaged: metadata?.desktopManaged === true,
        };
      }
    } catch {
      // Older Termdock releases do not expose /api/meta.
    }
    return { ok: true, url };
  } catch (error) {
    return { ok: false, url, error: networkErrorDetails(error) };
  }
}

async function probeService(rawUrl: string): Promise<ServiceProbe> {
  let url: string;
  try {
    url = normalizeServiceUrl(rawUrl);
  } catch (error) {
    return { ok: false, url: rawUrl, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    const healthResponse = await fetchWithTimeout(`${url}/health`);
    if (!healthResponse.ok) {
      return { ok: false, url, error: `健康检查返回 HTTP ${healthResponse.status}` };
    }
    const health = await healthResponse.json() as { status?: unknown };
    if (health.status !== 'ok') {
      return { ok: false, url, error: '目标地址不是可识别的 Termdock 服务' };
    }

    try {
      const metadataResponse = await fetchWithTimeout(`${url}/api/meta`);
      if (metadataResponse.ok) {
        const metadata = await metadataResponse.json() as {
          product?: unknown;
          version?: unknown;
          protocolVersion?: unknown;
          desktopManaged?: unknown;
        };
        if (metadata.product && metadata.product !== 'termdock') {
          return { ok: false, url, error: '目标服务的产品标识不是 Termdock' };
        }
        return {
          ok: true,
          url,
          version: typeof metadata.version === 'string' ? metadata.version : undefined,
          protocolVersion: typeof metadata.protocolVersion === 'number'
            ? metadata.protocolVersion
            : undefined,
          desktopManaged: metadata.desktopManaged === true,
        };
      }
    } catch {
      // Older Termdock releases do not expose /api/meta. A valid health
      // response is enough to allow a backwards-compatible connection.
    }
    return { ok: true, url };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? '连接超时'
      : networkErrorDetails(error);
    return { ok: false, url, error: message };
  }
}

async function probeServiceWithLocalNetworkPermission(
  rawUrl: string,
  options: { interactive?: boolean } = {},
): Promise<ServiceProbe> {
  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeServiceUrl(rawUrl);
  } catch {
    return await probeService(rawUrl);
  }

  // Do the first macOS HTTPS probe with Node TLS. Sending an untrusted
  // certificate through Chromium first permanently caches that rejection for
  // the process and prevents an immediate retry after the user approves it.
  const approvedAuthority = sessionTrustedCertificateAuthorities.get(new URL(normalizedUrl).origin);
  let probe = approvedAuthority
    ? await probeServiceWithCertificateAuthority(normalizedUrl, approvedAuthority)
    : canOfferCertificateTrust(normalizedUrl)
      ? await probeServiceWithCertificateAuthority(normalizedUrl)
    : await probeService(normalizedUrl);
  if (probe.ok) return probe;

  let parsedProbeUrl: URL;
  try {
    parsedProbeUrl = new URL(probe.url);
  } catch {
    return probe;
  }
  if (canOfferCertificateTrust(probe.url) && isCertificateTrustError(probe.error)) {
    if (options.interactive === false) return probe;
    const certificate = await requestCertificateTrust(probe.url);
    if (!certificate) {
      return { ...probe, error: 'HTTPS 证书尚未受信任' };
    }
    return await probeServiceWithCertificateAuthority(rawUrl, certificate.certificatePem);
  }
  if (!isLocalNetworkTarget(parsedProbeUrl) || !looksLikeLocalNetworkPermissionError(probe.error)) {
    return probe;
  }

  if (options.interactive === false) return probe;
  if (!(await requestLocalNetworkPermissionRetry(probe.url))) {
    return { ...probe, error: 'Termdock 尚未获得 macOS 本地网络权限' };
  }
  probe = await probeService(rawUrl);
  return probe;
}

async function getLocalServiceStatus(): Promise<LocalServiceStatus> {
  const state = readServerState();
  if (!state || !isProcessRunning(state.pid)) {
    return { running: false, state, probe: null };
  }
  const probe = await probeService(stateUrl(state));
  return { running: probe.ok, state, probe };
}

type ResolvedDesktopRuntime = DesktopRuntimePaths & {
  node: string;
  launcher: string;
  toolchainBin: string;
};

function runtimePaths(): ResolvedDesktopRuntime {
  if (app.isPackaged) {
    const selected = resolvePackagedRuntime({
      appVersion: app.getVersion(),
      resourcesPath: process.resourcesPath,
    });
    return {
      ...selected,
      node: path.join(process.resourcesPath, 'runtime', 'bin', 'node'),
      launcher: path.join(process.resourcesPath, 'cli', 'td'),
      toolchainBin: path.join(process.resourcesPath, 'toolchain', 'bin'),
    };
  }
  return {
    node: process.env.TERMDOCK_NODE_BIN || 'node',
    serverRoot: projectRoot,
    cli: path.join(projectRoot, 'dist', 'server', 'cli.js'),
    launcher: path.join(projectRoot, 'desktop', 'cli', 'td'),
    toolchainBin: path.join(projectRoot, '.desktop-runtime', 'toolchain', 'bin'),
    version: app.getVersion(),
    source: 'development',
  };
}

async function executableVersion(executable: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(executable, ['--version'], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
    });
    return stdout.trim().split(/\s+/).at(-1) || null;
  } catch {
    return null;
  }
}

async function discoverCliInstallations(): Promise<CliInstallation[]> {
  const candidates = new Set<string>();
  try {
    const { stdout } = await execFileAsync('/bin/zsh', ['-lic', 'whence -pa td termdock'], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
    });
    for (const line of stdout.split('\n')) {
      const candidate = line.trim();
      if (candidate.startsWith('/')) candidates.add(candidate);
    }
  } catch {
    // A clean machine may not have any CLI entry yet.
  }
  for (const candidate of ['/usr/local/bin/td', '/opt/homebrew/bin/td']) {
    if (fs.existsSync(candidate)) candidates.add(candidate);
  }

  const bundledLauncher = runtimePaths().launcher;
  return Promise.all([...candidates].map(async (candidate) => {
    let resolved = candidate;
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      // Keep the visible path for a broken symlink so the repair UI can show it.
    }
    return {
      path: candidate,
      version: await executableVersion(candidate),
      bundled: resolved === bundledLauncher,
    };
  }));
}

async function bundledCliVersion(): Promise<string> {
  const runtime = runtimePaths();
  try {
    const { stdout } = await execFileAsync(runtime.node, [runtime.cli, '--version'], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      env: desktopRuntimeEnv(runtime),
    });
    return stdout.trim() || app.getVersion();
  } catch {
    return app.getVersion();
  }
}

async function snapshot(): Promise<DesktopSnapshot> {
  const config = readDesktopConfig();
  const [localService, cliInstallations, cliVersion] = await Promise.all([
    getLocalServiceStatus(),
    discoverCliInstallations(),
    bundledCliVersion(),
  ]);
  return {
    appVersion: app.getVersion(),
    runtimeVersion: cliVersion,
    packaged: app.isPackaged,
    bundledCliVersion: cliVersion,
    cliInstallations,
    localService,
    connections: config.connections,
    lastConnectionUrl: config.lastConnectionUrl,
    desktopPreferences: config.desktopPreferences,
  };
}

function desktopRuntimeEnv(runtime = runtimePaths()): NodeJS.ProcessEnv {
  const currentPath = process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin';
  const userBinPaths = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ];
  return {
    ...process.env,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_CTYPE: process.env.LC_CTYPE || process.env.LANG || 'en_US.UTF-8',
    PATH: [runtime.toolchainBin, ...userBinPaths, '/opt/homebrew/bin', '/usr/local/bin', currentPath]
      .filter(Boolean)
      .join(path.delimiter),
    TERMDOCK_DESKTOP: '1',
    TERMDOCK_BUNDLED_RUNTIME: app.isPackaged ? '1' : '0',
    TERMDOCK_VERSION: runtime.version,
    TERMDOCK_DESKTOP_SHELL_VERSION: app.getVersion(),
    TMUX_BIN: fs.existsSync(path.join(runtime.toolchainBin, 'tmux'))
      ? path.join(runtime.toolchainBin, 'tmux')
      : process.env.TMUX_BIN,
  };
}

async function waitForLocalService(childPid?: number): Promise<ServiceProbe> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastProbe: ServiceProbe = { ok: false, url: DEFAULT_LOCAL_URL, error: '服务尚未启动' };
  while (Date.now() < deadline) {
    const state = readServerState();
    const url = state ? stateUrl(state) : DEFAULT_LOCAL_URL;
    lastProbe = await probeService(url);
    if (lastProbe.ok) return lastProbe;
    if (childPid && !isProcessRunning(childPid)) {
      return { ...lastProbe, error: '服务进程在健康检查通过前退出' };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return lastProbe;
}

async function ensureTmuxUtf8Environment(runtime: ResolvedDesktopRuntime): Promise<void> {
  const tmux = path.join(runtime.toolchainBin, 'tmux');
  if (!fs.existsSync(tmux)) return;
  const locale = desktopRuntimeEnv(runtime).LANG || 'en_US.UTF-8';
  for (const name of ['LANG', 'LC_CTYPE']) {
    try {
      await execFileAsync(tmux, ['set-environment', '-g', name, locale], {
        timeout: 5_000,
        maxBuffer: 128 * 1024,
        env: desktopRuntimeEnv(runtime),
      });
    } catch {
      // tmux is optional and may not have a running server yet.
    }
  }
}

async function confirmAndStopExisting(status: LocalServiceStatus): Promise<boolean> {
  if (!status.state) return true;
  const version = status.probe?.version ? `版本：${status.probe.version}\n` : '';
  const result = await showDesktopMessageBox({
    type: 'warning',
    title: '接管本机 Termdock 服务',
    message: '检测到正在运行的 Termdock 服务',
    detail: `${version}地址：${stateUrl(status.state)}\nPID：${status.state.pid}\n\n停止后将由桌面版使用同一个 ~/.termdock 重新启动。tmux 会话不会被删除。`,
    buttons: ['连接现有服务', '停止并由桌面版接管', '取消'],
    defaultId: 0,
    cancelId: 2,
  });
  if (result.response === 0) {
    await connectWindow(stateUrl(status.state));
    return false;
  }
  if (result.response !== 1) return false;
  if (!isProcessRunning(status.state.pid)) return true;
  process.kill(status.state.pid, 'SIGTERM');
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && isProcessRunning(status.state.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (isProcessRunning(status.state.pid)) {
    throw new Error(`旧服务 PID ${status.state.pid} 未能在超时时间内退出`);
  }
  try {
    const latest = readServerState();
    if (latest?.pid === status.state.pid) fs.rmSync(serverStatePath, { force: true });
  } catch {
    // The exiting CLI normally removes the state file itself.
  }
  return true;
}

async function startLocalService(): Promise<ServiceProbe> {
  const existing = await getLocalServiceStatus();
  if (existing.running) {
    const shouldStart = await confirmAndStopExisting(existing);
    if (!shouldStart) {
      return existing.probe ?? { ok: true, url: stateUrl(existing.state!) };
    }
  }

  if (app.isPackaged) {
    try {
      await ensureLatestRuntime();
    } catch (error) {
      console.error('[desktop-runtime] update check failed; using the current runtime', error);
    }
  }

  let runtime = runtimePaths();
  if (!fs.existsSync(runtime.cli)) {
    throw new Error('未找到 Termdock 服务端构建，请先运行 npm run build');
  }
  if (app.isPackaged && !fs.existsSync(runtime.node)) {
    throw new Error('安装包缺少内嵌 Node Runtime');
  }
  const startRuntime = async (selected: ResolvedDesktopRuntime): Promise<ServiceProbe> => {
    fs.mkdirSync(termdockDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(termdockDir, 'server.log');
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(selected.node, [
      selected.cli,
      '--foreground',
      '--host',
      '0.0.0.0',
      '--port',
      '9834',
    ], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: desktopRuntimeEnv(selected),
    });
    fs.closeSync(logFd);
    child.unref();
    return waitForLocalService(child.pid);
  };

  let probe = await startRuntime(runtime);
  if (!probe.ok && app.isPackaged && runtime.source === 'downloaded') {
    if (rollbackDownloadedRuntime({
      appVersion: app.getVersion(),
      resourcesPath: process.resourcesPath,
    }, runtime.version)) {
      console.error(`[desktop-runtime] ${runtime.version} failed to start; rolled back`);
      runtime = runtimePaths();
      probe = await startRuntime(runtime);
    }
  }
  if (!probe.ok) {
    throw new Error(`桌面版服务启动失败：${probe.error ?? '未知错误'}。日志：${path.join(termdockDir, 'server.log')}`);
  }
  await ensureTmuxUtf8Environment(runtime);
  markDesktopRuntimeRunning(runtime.version);
  await connectWindow(probe.url);
  return probe;
}

async function restartDesktopManagedRuntime(): Promise<ReturnType<typeof getDesktopRuntimeUpdateState>> {
  const status = await getLocalServiceStatus();
  if (status.running) {
    if (status.probe?.desktopManaged !== true) {
      throw new Error('当前本机服务不是由桌面版启动的，不能由桌面版自动重启。');
    }
    markDesktopRuntimeRestarting();
    const pid = status.state?.pid;
    if (!pid || !isProcessRunning(pid)) {
      throw new Error('桌面服务状态已失效，请重新打开连接中心。');
    }
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 15_000;
    while (isProcessRunning(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (isProcessRunning(pid)) throw new Error(`桌面服务 PID ${pid} 未能正常退出。`);
    const latest = readServerState();
    if (latest?.pid === pid) fs.rmSync(serverStatePath, { force: true });
  }
  await startLocalService();
  return getDesktopRuntimeUpdateState();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function installCli(): Promise<DesktopSnapshot> {
  if (!app.isPackaged) {
    throw new Error('CLI 一键安装只在打包后的 Termdock.app 中可用');
  }
  const runtime = runtimePaths();
  if (!fs.existsSync(runtime.launcher)) {
    throw new Error('安装包中缺少 CLI 启动器');
  }
  const current = await discoverCliInstallations();
  const detailLines = current.length > 0
    ? current.map((entry) => `${entry.path}（${entry.version ?? '版本未知'}）`)
    : ['未检测到已有 td/termdock 命令'];
  const confirmation = await showDesktopMessageBox({
    type: 'question',
    title: '安装 Termdock CLI',
    message: '将桌面版内嵌 CLI 安装为 td 和 termdock',
    detail: `${detailLines.join('\n')}\n\n目标目录：/usr/local/bin\n已有同名入口只会在你确认后替换。`,
    buttons: ['安装', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  if (confirmation.response !== 0) return snapshot();

  const command = [
    'mkdir -p /usr/local/bin',
    `ln -sfn ${shellQuote(runtime.launcher)} /usr/local/bin/td`,
    `ln -sfn ${shellQuote(runtime.launcher)} /usr/local/bin/termdock`,
  ].join(' && ');
  await execFileAsync('/usr/bin/osascript', [
    '-e',
    `do shell script "${appleScriptQuote(command)}" with administrator privileges`,
  ], { timeout: 120_000, maxBuffer: 256 * 1024 });
  return snapshot();
}

async function connectWindow(
  rawUrl: string,
  options: { focus?: boolean; updateLastConnection?: boolean; persist?: boolean } = {},
): Promise<ServiceProbe> {
  let probe = await probeServiceWithLocalNetworkPermission(rawUrl, {
    interactive: options.focus !== false,
  });
  if (!probe.ok) return probe;
  const parsed = new URL(probe.url);
  const key = parsed.origin;
  const existingWindow = serviceWindows.get(key);
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (options.persist !== false) {
      const config = readDesktopConfig();
      if (options.updateLastConnection !== false) config.lastConnectionUrl = probe.url;
      config.openConnectionUrls = [
        ...config.openConnectionUrls.filter((url) => {
          try { return new URL(url).origin !== key; } catch { return false; }
        }),
        probe.url,
      ];
      const existing = config.connections.find((entry) => entry.url === probe.url);
      if (existing) existing.lastConnectedAt = Date.now();
      writeDesktopConfig(config);
    }
    if (options.focus !== false) {
      mainWindow?.hide();
      showAndFocusWindow(existingWindow);
    } else {
      existingWindow.showInactive();
    }
    return probe;
  }

  const workspaceWindow = createDesktopWindow({ serviceOrigin: key, label: serviceLabel(probe.url) });
  serviceWindows.set(key, workspaceWindow);
  broadcastServiceActivity();
  while (!workspaceWindow.isDestroyed()) {
    try {
      const load = workspaceWindow.loadURL(probe.url);
      if (options.focus === false) {
        await Promise.race([
          load,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('恢复连接超时')), RESTORE_LOAD_TIMEOUT_MS);
            timer.unref();
          }),
        ]);
      } else {
        await load;
      }
      if (options.persist !== false) {
        const config = readDesktopConfig();
        if (options.updateLastConnection !== false) config.lastConnectionUrl = probe.url;
        config.openConnectionUrls = [
          ...config.openConnectionUrls.filter((url) => {
            try { return new URL(url).origin !== key; } catch { return false; }
          }),
          probe.url,
        ];
        const existing = config.connections.find((entry) => entry.url === probe.url);
        if (existing) existing.lastConnectedAt = Date.now();
        writeDesktopConfig(config);
      }
      restorableServiceWindows.add(workspaceWindow);
      if (options.focus !== false) {
        mainWindow?.hide();
        showAndFocusWindow(workspaceWindow);
      } else {
        // Restored workspaces must be real visible macOS windows so App Expose
        // can select them, but opening several at launch must not steal focus
        // from each other.
        workspaceWindow.showInactive();
      }
      return probe;
    } catch (error) {
      const message = networkErrorDetails(error);
      if (options.focus === false) {
        workspaceWindow.destroy();
        return { ...probe, ok: false, error: message };
      }
      if (isLocalNetworkTarget(parsed) && looksLikeLocalNetworkPermissionError(error)) {
        if (await requestLocalNetworkPermissionRetry(probe.url)) continue;
        workspaceWindow.destroy();
        return { ...probe, ok: false, error: 'Termdock 尚未获得 macOS 本地网络权限' };
      }
      workspaceWindow.destroy();
      await showDesktopMessageBox({
        type: 'error',
        title: '连接 Termdock 服务失败',
        message: `无法打开 ${probe.url}`,
        detail: message,
      });
      return { ...probe, ok: false, error: message };
    }
  }
  return { ...probe, ok: false, error: 'Termdock 窗口已关闭' };
}

async function showConnectionCenter(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createDesktopWindow();
  }
  const rendererPath = app.isPackaged
    ? path.join(process.resourcesPath, 'renderer', 'index.html')
    : path.join(projectRoot, 'desktop', 'renderer', 'index.html');
  await mainWindow?.loadFile(rendererPath);
  if (mainWindow) showAndFocusWindow(mainWindow);
}

async function showStartupProgress(message: string): Promise<void> {
  if (!startupRestoreActive) return;
  startupProgressMessage = message;
  await showConnectionCenter();
  if (!startupRestoreActive || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:startup-progress', startupProgressMessage);
}

function updateStartupProgress(message: string): void {
  if (!startupRestoreActive) return;
  startupProgressMessage = message;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:startup-progress', startupProgressMessage);
  }
}

function finishStartupProgress(): void {
  startupRestoreActive = false;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:startup-progress', null);
}

function createDesktopWindow(options?: { serviceOrigin: string; label: string }): BrowserWindow {
  const serviceSession = options
    ? session.fromPartition(`persist:termdock-service-${crypto
      .createHash('sha256')
      .update(options.serviceOrigin)
      .digest('hex')
      .slice(0, 24)}`)
    : null;
  if (serviceSession) installCertificateVerifyProcedure(serviceSession);
  const window = new BrowserWindow({
    title: options ? `Termdock — ${options.label}` : 'Termdock — 连接中心',
    show: false,
    // The web workspace enables its persistent right inspector at 1440px.
    // Open service windows above that breakpoint so the visible pin action
    // cannot write a pinned state that the initial layout refuses to render.
    width: options ? 1500 : 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: 'rgb(28, 27, 26)',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      ...(serviceSession ? { session: serviceSession } : {}),
      preload: path.join(currentDir, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // A service window owns live terminal streams. If Chromium suspends it
      // while macOS places the app in the background, tens of seconds of WS
      // messages can hit the renderer in one burst when the user returns.
      backgroundThrottling: shouldThrottleDesktopRenderer(Boolean(options)),
    },
  });
  if (options) windowServiceOrigins.set(window, options.serviceOrigin);
  if (options) {
    window.webContents.on('page-title-updated', (event) => {
      event.preventDefault();
      window.setTitle(`Termdock — ${options.label}`);
    });
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLinkStagingUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    }
    openExternalLink(url);
    return { action: 'deny' };
  });
  window.webContents.on('did-create-window', (childWindow, details) => {
    if (!isExternalLinkStagingUrl(details.url)) return;
    childWindow.hide();
    childWindow.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      openExternalLink(url);
      childWindow.close();
    });
  });
  window.webContents.on('will-navigate', (event, url) => {
    const serviceOrigin = windowServiceOrigins.get(window);
    if (!serviceOrigin) return;
    try {
      if (new URL(url).origin === serviceOrigin) return;
    } catch {
      // Block malformed navigations.
    }
    event.preventDefault();
    openExternalLink(url);
  });
  window.webContents.on('did-finish-load', () => {
    if (!windowServiceOrigins.has(window)) return;
    void window.webContents.insertCSS(`
      html[data-termdock-desktop='true'] {
        --safe-top-inset: max(env(safe-area-inset-top, 0px), 38px) !important;
      }
      html[data-termdock-desktop='true'] #root {
        padding-top: 0 !important;
      }
      html[data-termdock-desktop='true'] body::after {
        display: none !important;
      }
      html[data-termdock-desktop='true'] #root main > div > div:first-child {
        padding-left: 80px !important;
        position: relative;
        -webkit-app-region: no-drag;
      }
      html[data-termdock-desktop='true'] #root main > div > div:first-child::before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: 50%;
        width: min(240px, 25vw);
        transform: translateX(-50%);
        pointer-events: none;
        -webkit-app-region: drag;
      }
      html[data-termdock-desktop='true'] #root .h-full.flex.flex-col.app-chrome-bg.border-r > .shrink-0.border-b {
        padding-left: 80px !important;
        -webkit-app-region: drag;
      }
      html[data-termdock-desktop='true'] #root button,
      html[data-termdock-desktop='true'] #root a,
      html[data-termdock-desktop='true'] #root input,
      html[data-termdock-desktop='true'] #root textarea,
      html[data-termdock-desktop='true'] #root select,
      html[data-termdock-desktop='true'] #root [data-rbd-draggable-id] {
        -webkit-app-region: no-drag;
      }
      html[data-termdock-desktop='true'] [data-sidebar='right'] {
        padding-top: 0 !important;
      }
      html[data-termdock-desktop='true'] [data-sidebar='right'][style*='pointer-events: auto'] {
        transform: none !important;
      }
      html[data-termdock-desktop='true'] [data-sidebar='right'] > div:first-child {
        -webkit-app-region: no-drag;
      }
      html[data-termdock-desktop='true'] [data-sidebar='right'] > div:first-child > div:first-child > .min-w-0.flex-1 {
        -webkit-app-region: drag;
      }
      html[data-termdock-desktop='true'] [data-sidebar='right'] div:has(> [data-right-search]) + div:has(> button[aria-pressed]) {
        width: fit-content !important;
        margin-left: auto !important;
      }
      html[data-termdock-desktop='true'] [data-sidebar='right'] div:has(> [data-right-search]) + div:has(> button[aria-pressed]) > button {
        flex: none !important;
        padding: 0.125rem 0.5rem !important;
        font-size: 10px !important;
      }
    `);
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
    if (lastFocusedServiceWindow === window) lastFocusedServiceWindow = null;
    const serviceOrigin = windowServiceOrigins.get(window);
    if (serviceOrigin && serviceWindows.get(serviceOrigin) === window) {
      serviceWindows.delete(serviceOrigin);
      reportedServiceActivity.delete(serviceOrigin);
      observedServiceActivity.delete(serviceOrigin);
      broadcastServiceActivity();
    }
  });
  window.on('focus', () => {
    if (windowServiceOrigins.has(window)) lastFocusedServiceWindow = window;
    broadcastServiceActivity();
    // User is looking at the app — the Dock badge has served its purpose.
    clearUnreadNotifications();
  });
  window.on('close', (event) => {
    const serviceOrigin = windowServiceOrigins.get(window);
    if (serviceOrigin && !isQuitting && restorableServiceWindows.has(window)) {
      const config = readDesktopConfig();
      config.openConnectionUrls = config.openConnectionUrls.filter((url) => {
        try { return new URL(url).origin !== serviceOrigin; } catch { return false; }
      });
      writeDesktopConfig(config);
    }
    if (window === mainWindow && process.platform === 'darwin' && !isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  return window;
}

function installIpcHandlers(): void {
  ipcMain.handle('desktop:snapshot', () => snapshot());
  ipcMain.handle('desktop:probe', (_event, url: string) => probeServiceWithLocalNetworkPermission(url));
  ipcMain.handle('desktop:save-connection', async (_event, input: { url: string; label: string }) => {
    const url = normalizeServiceUrl(input.url);
    const config = readDesktopConfig();
    const existing = config.connections.find((entry) => entry.url === url);
    if (existing) {
      existing.label = input.label.trim() || new URL(url).host;
    } else {
      config.connections.push({
        id: crypto.randomUUID(),
        label: input.label.trim() || new URL(url).host,
        url,
      });
    }
    writeDesktopConfig(config);
    installMenu();
    return snapshot();
  });
  ipcMain.handle('desktop:remove-connection', async (_event, id: string) => {
    const config = readDesktopConfig();
    config.connections = config.connections.filter((entry) => entry.id !== id);
    writeDesktopConfig(config);
    installMenu();
    return snapshot();
  });
  ipcMain.handle('desktop:connect', (_event, url: string) => connectWindow(url));
  ipcMain.on('desktop:report-service-activity', (event, activity: {
    runningCount?: unknown;
    reviewCount?: unknown;
  }) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow) return;
    const origin = windowServiceOrigins.get(sourceWindow);
    if (!origin) return;
    const next = normalizeServiceActivity(activity);
    const current = reportedServiceActivity.get(origin);
    if (current?.runningCount === next.runningCount && current.reviewCount === next.reviewCount) {
      // The sender may have just reloaded and still needs the complete roster.
      sourceWindow.webContents.send('desktop:service-activity-changed', serviceActivitySnapshot(sourceWindow));
      return;
    }
    reportedServiceActivity.set(origin, next);
    broadcastServiceActivity();
  });
  ipcMain.on('desktop:observe-service-activity', (event, activity: {
    runningCount?: unknown;
    reviewCount?: unknown;
  }) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow) return;
    const origin = windowServiceOrigins.get(sourceWindow);
    if (!origin) return;
    const next = normalizeServiceActivity(activity);
    const current = observedServiceActivity.get(origin);
    if (current?.runningCount === next.runningCount && current.reviewCount === next.reviewCount) return;
    observedServiceActivity.set(origin, next);
    broadcastServiceActivity();
  });
  ipcMain.handle('desktop:focus-service', (event, origin: string) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || !windowServiceOrigins.has(sourceWindow)) return false;
    const targetWindow = serviceWindows.get(origin);
    if (!targetWindow || targetWindow.isDestroyed()) return false;
    showAndFocusWindow(targetWindow);
    broadcastServiceActivity();
    return true;
  });
  ipcMain.handle('desktop:start-local', () => startLocalService());
  ipcMain.handle('desktop:update-preferences', async (_event, preferences: {
    menuBarStatusEnabled?: unknown;
    floatingWidgetEnabled?: unknown;
  }) => {
    updateDesktopPreferences({
      ...(typeof preferences?.menuBarStatusEnabled === 'boolean'
        ? { menuBarStatusEnabled: preferences.menuBarStatusEnabled }
        : {}),
      ...(typeof preferences?.floatingWidgetEnabled === 'boolean'
        ? { floatingWidgetEnabled: preferences.floatingWidgetEnabled }
        : {}),
    });
    return snapshot();
  });
  ipcMain.handle('desktop:status-snapshot', () => desktopStatusSnapshot());
  ipcMain.handle('desktop:focus-next-service', (_event, scope: unknown) => {
    const normalized: ActivityFocusScope = scope === 'running'
      || scope === 'review'
      || scope === 'all'
      ? scope
      : 'attention';
    focusNextService(normalized);
  });
  ipcMain.handle('desktop:set-floating-metric-count', (event, count: unknown) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (sourceWindow !== floatingWidgetWindow || typeof count !== 'number' || !Number.isFinite(count)) return;
    resizeFloatingWidget(count);
  });
  ipcMain.handle('desktop:disable-floating-widget', async () => {
    updateDesktopPreferences({ floatingWidgetEnabled: false });
    return snapshot();
  });
  ipcMain.handle('desktop:install-cli', () => installCli());
  ipcMain.handle('desktop:update-state', () => getDesktopUpdateState());
  ipcMain.handle('desktop:check-update', () => checkForDesktopUpdates());
  ipcMain.handle('desktop:install-update', () => installDownloadedDesktopUpdate());
  ipcMain.handle('desktop:runtime-update-state', () => getDesktopRuntimeUpdateState());
  ipcMain.handle('desktop:check-runtime-update', () => checkForRuntimeUpdates());
  ipcMain.handle('desktop:restart-runtime', () => restartDesktopManagedRuntime());
  ipcMain.handle('desktop:show-connection-center', () => showConnectionCenter());
  ipcMain.handle('desktop:reveal-data-directory', async () => {
    fs.mkdirSync(termdockDir, { recursive: true, mode: 0o700 });
    const error = await shell.openPath(termdockDir);
    if (error) throw new Error(error);
  });
  ipcMain.handle('desktop:open-notification-settings', async () => {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.Notifications-Settings.extension?bundleId=com.jovines.termdock',
    );
  });
  ipcMain.handle('desktop:prepare-notification-test', (event) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (sourceWindow && !sourceWindow.isDestroyed()) sourceWindow.minimize();
  });
  ipcMain.handle('desktop:show-notification', (event, payload: {
    title?: unknown;
    body?: unknown;
    tag?: unknown;
    sessionId?: unknown;
    silent?: unknown;
    persistent?: unknown;
  }) => {
    if (!Notification.isSupported() || typeof payload?.title !== 'string') return false;
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    // The renderer also suppresses automatic notifications while focused, but
    // enforce the rule in the native process as well so a focus race can never
    // produce a foreground sound, Notification Center entry, or Dock badge.
    if (sourceWindow?.isFocused()) return true;
    // Web Notification tag semantics: a new notification with the same tag
    // replaces the previous one instead of stacking.
    const tag = typeof payload.tag === 'string' && payload.tag ? payload.tag : null;
    if (tag) {
      const previous = activeNotifications.get(tag);
      if (previous) {
        previous.close();
        activeNotifications.delete(tag);
      }
    }
    const notification = new Notification({
      title: payload.title.slice(0, 160),
      body: typeof payload.body === 'string' ? payload.body.slice(0, 1000) : undefined,
      silent: payload.silent === true,
    });
    if (tag) {
      activeNotifications.set(tag, notification);
      notification.on('close', () => {
        if (activeNotifications.get(tag) === notification) activeNotifications.delete(tag);
      });
    }
    notification.on('click', () => {
      const targetWindow = sourceWindow && !sourceWindow.isDestroyed()
        ? sourceWindow
        : focusedWorkspaceWindow();
      targetWindow?.show();
      targetWindow?.focus();
      if (typeof payload.sessionId === 'string') {
        targetWindow?.webContents.send('desktop:focus-session', payload.sessionId);
      }
    });
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (delivered: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (!delivered) {
          if (tag && activeNotifications.get(tag) === notification) {
            activeNotifications.delete(tag);
          }
          if (error) console.error(`[desktop notification] ${error}`);
          resolve(false);
          return;
        }
        unreadNotificationCount += 1;
        app.setBadgeCount(unreadNotificationCount);
        // macOS banners auto-dismiss even for "persistent" alerts; bounce the Dock
        // icon so the signal survives until the user looks at the app.
        if (payload.persistent === true && !sourceWindow?.isFocused()) {
          app.dock?.bounce('informational');
        }
        resolve(true);
      };
      notification.once('show', () => finish(true));
      notification.once('failed', (_notificationEvent, error) => finish(false, error));
      // macOS can silently discard notifications when this user disabled the
      // app in System Settings. Do not report success or increment the Dock
      // badge unless Electron confirms delivery.
      const timeout = setTimeout(() => {
        finish(false, 'macOS did not confirm notification delivery');
      }, 2_000);
      notification.show();
    });
  });
}

function installMenu(): void {
  const sendCommand = (command: string) => {
    focusedWorkspaceWindow()?.webContents.send('desktop:command', command);
  };
  const openService = (url: string) => {
    void connectWindow(url).then((probe) => {
      if (!probe.ok) {
        void showDesktopMessageBox({
          type: 'error',
          title: '连接 Termdock 服务失败',
          message: `无法打开 ${probe.url}`,
          detail: probe.error,
        });
      }
    });
  };
  const openLocalService = () => {
    void getLocalServiceStatus().then((status) => {
      if (status.running && status.state) {
        openService(stateUrl(status.state));
        return;
      }
      void showConnectionCenter();
    });
  };
  const config = readDesktopConfig();
  const serviceItems: MenuItemConstructorOptions[] = [
    { label: '本机', click: openLocalService },
    ...config.connections.map((connection) => ({
      label: connection.label || new URL(connection.url).host,
      click: () => openService(connection.url),
    })),
  ];
  const menu = Menu.buildFromTemplate([
    {
      label: 'Termdock',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: '设置…',
          accelerator: 'CmdOrCtrl+,',
          click: () => focusedWorkspaceWindow()?.webContents.send('desktop:open-settings'),
        },
        {
          label: '新建连接或切换服务…',
          accelerator: 'CmdOrCtrl+N',
          click: () => void showConnectionCenter(),
        },
        { label: '打开服务', submenu: serviceItems },
        {
          label: '安装或修复 CLI…',
          click: () => void installCli().catch((error) => {
            void showDesktopMessageBox({
              type: 'error',
              title: 'CLI 安装失败',
              message: error instanceof Error ? error.message : String(error),
            });
          }),
        },
        {
          label: '检查更新…',
          click: () => void checkForDesktopUpdates({ presentNativeDialogs: true }),
        },
        {
          label: '打开 Termdock 数据目录',
          click: () => {
            fs.mkdirSync(termdockDir, { recursive: true, mode: 0o700 });
            void shell.openPath(termdockDir);
          },
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+T',
          click: () => sendCommand('new-session'),
        },
        {
          label: '关闭当前会话',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendCommand('close-session'),
        },
        { type: 'separator' },
        {
          label: '上一个会话',
          accelerator: 'CmdOrCtrl+Shift+[',
          click: () => sendCommand('previous-session'),
        },
        {
          label: '下一个会话',
          accelerator: 'CmdOrCtrl+Shift+]',
          click: () => sendCommand('next-session'),
        },
        { type: 'separator' },
        {
          label: '上一个待处理',
          accelerator: 'CmdOrCtrl+Alt+[',
          click: () => sendCommand('previous-attention'),
        },
        {
          label: '下一个待处理',
          accelerator: 'CmdOrCtrl+Alt+]',
          click: () => sendCommand('next-attention'),
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '显示',
      submenu: [
        {
          label: '切换会话侧栏',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendCommand('toggle-left-sidebar'),
        },
        {
          label: '切换文件侧栏',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => sendCommand('toggle-right-sidebar'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        {
          label: '连接中心',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => void showConnectionCenter(),
        },
        { label: '打开服务', submenu: serviceItems },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'front' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
  app.dock?.setMenu(Menu.buildFromTemplate([
    { label: '连接中心', click: () => void showConnectionCenter() },
    { type: 'separator' },
    ...serviceItems,
  ]));
}

app.whenReady().then(async () => {
  triggerLocalNetworkPermission();
  configureLocalServiceCertificateTrust();
  installIpcHandlers();
  installMenu();
  refreshDesktopStatusSurfaces();
  screen.on('display-removed', keepFloatingWidgetOnScreen);
  screen.on('display-metrics-changed', keepFloatingWidgetOnScreen);
  configureDesktopUpdater(showDesktopMessageBox);
  subscribeDesktopUpdateState((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('desktop:update-state-changed', state);
    }
  });
  subscribeDesktopRuntimeUpdateState((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('desktop:runtime-update-state-changed', state);
    }
  });
  const startupConfig = readDesktopConfig();
  const restoreUrls = startupConfig.openConnectionUrls;
  startupRestoreActive = true;
  const startupProgressTimer = setTimeout(() => {
    void showStartupProgress('正在检查本机 Runtime 和已保存连接…');
  }, 350);
  startupProgressTimer.unref();
  let completedRestores = 0;
  updateStartupProgress(`正在恢复连接 0/${restoreUrls.length}…`);
  const restoreResults = await Promise.all(restoreUrls.map(async (url) => {
    const probe = await connectWindow(url, {
      focus: false,
      updateLastConnection: false,
      persist: false,
    });
    completedRestores += 1;
    updateStartupProgress(`正在恢复连接 ${completedRestores}/${restoreUrls.length}…`);
    return probe;
  }));
  const restoredWindowCount = restoreResults.filter((probe) => probe.ok).length;
  clearTimeout(startupProgressTimer);
  finishStartupProgress();
  if (restoredWindowCount > 0) {
    let preferredOrigin: string | null = null;
    try {
      preferredOrigin = startupConfig.lastConnectionUrl
        ? new URL(startupConfig.lastConnectionUrl).origin
        : null;
    } catch {
      // A malformed legacy value must not prevent the other saved windows
      // from being restored.
    }
    const preferredWindow = preferredOrigin ? serviceWindows.get(preferredOrigin) : null;
    showAndFocusWindow(preferredWindow ?? [...serviceWindows.values()][0]);
  } else {
    await showConnectionCenter();
  }
  app.on('activate', () => {
    const workspaceWindow = focusedWorkspaceWindow();
    if (workspaceWindow) {
      showAndFocusWindow(workspaceWindow);
      return;
    }
    void showConnectionCenter();
  });
}).catch((error) => {
  void dialog.showErrorBox('Termdock 启动失败', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('window-all-closed', () => {
  // Keep the macOS application lifecycle conventional: closing the last
  // window keeps the app available in the Dock, while the detached Termdock
  // service continues independently.
});

app.on('before-quit', () => {
  isQuitting = true;
});

export { PROTOCOL_VERSION };
