import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, Bell, Camera, Check, ChevronDown, Circle, Columns2, GripVertical, Home, Keyboard, Layers, Loader2, Maximize,
  Minimize, Minus, MonitorSmartphone, MoreHorizontal, PanelRightClose, PanelRightOpen, Plug, Plus, Power, RefreshCw, RotateCw, Send, Smartphone, Square, Unplug, Video, Volume1, Volume2, X,
} from 'lucide-react';
import { useAndroidMirrorStore } from '../../stores/useAndroidMirrorStore';
import { useI18n, type TranslationKey } from '../../i18n';
import { useMultiSessionStore } from '../../stores/useMultiSessionStore';
import { useCollaborationPanelDock } from '../../stores/useCollaborationPanelDock';
import { AutoQuality } from '../../android/autoQuality';
import { AndroidMirrorController, type MirrorHeader, type MirrorState, type MirrorStats } from '../../android/mirrorController';
import {
  captureMirrorScreenshot, formatRecordingElapsed,
} from '../../android/mirrorCapture';
import { getSettings, updateSettings } from '../../terminal/api';
import {
  ANDROID_QUALITY_PRESETS, DEFAULT_ANDROID_QUALITY, androidErrorText, connectAndroidDevice, listAndroidDevices,
  listAndroidRecordings, startAndroidRecording, stopAndroidRecording, type AndroidRecording,
  normalizeAndroidQuality, type AndroidDevice, type AndroidDeviceList, type AndroidQuality, type AndroidQualityId,
} from '../../android/api';
import { constrainMirrorPan, moveMirrorViewport, type ViewportGeometry } from '../../android/mirrorViewport';
import type { AndroidSavedPresetState } from '../../terminal/api';

export const ANDROID_DOCK_GROUP = 'android-mirror';
const DOCK_GROUP = ANDROID_DOCK_GROUP;
const QUALITY_STORAGE_KEY = 'termdock:android:quality:v1';
// ⋯ 菜单浮层：宽度固定，高度只用来做贴底越界钳制。
const MORE_MENU_WIDTH = 176;
const MORE_MENU_ESTIMATED_HEIGHT = 204;
// 视图缩放：1 = 铺满可视区（不再缩得更小），上限 8 倍够看清状态栏那种小字。
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
/** 按钮走档位阶梯；捏合/滚轮可以停在档位之间，再按按钮就归到相邻档。 */
const ZOOM_LADDER = [1, 1.25, 1.5, 2, 2.5, 3, 4, 6, 8];

const clampZoom = (value: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));

/** 缩放倍率的显示：整数不带小数，其余保留一位。 */
function formatZoomLabel(zoom: number): string {
  return `${Number.isInteger(zoom) ? zoom : zoom.toFixed(1)}×`;
}

/** 画布容器内容框的几何（client 坐标）：缩放锚点和平移边界都按它算。 */
type StageBox = ViewportGeometry;

function stageBox(canvas: HTMLCanvasElement): StageBox | null {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const rect = parent.getBoundingClientRect();
  const style = getComputedStyle(parent);
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const width = parent.clientWidth - paddingLeft - (parseFloat(style.paddingRight) || 0);
  const height = parent.clientHeight - paddingTop - (parseFloat(style.paddingBottom) || 0);
  return {
    cx: rect.left + parent.clientLeft + paddingLeft + width / 2,
    cy: rect.top + parent.clientTop + paddingTop + height / 2,
    width,
    height,
    contentWidth: canvas.offsetWidth,
    contentHeight: canvas.offsetHeight,
  };
}

/** 上一帧输入与当前布局：在边界丢弃多余位移，反向不用先走回起点。 */
interface ViewGesture {
  /** client 坐标：单指时就是那根手指，双指时是两指中心。 */
  startCentroid: { x: number; y: number };
  /** 双指间距，单指（鼠标 Alt 拖动）为 0，表示只平移不缩放。 */
  startDistance: number;
  box: StageBox;
}

/** 指针捕获是尽力而为：jsdom 等环境没有实现，捕获失败也不影响手势本身。 */
function capturePointer(canvas: HTMLCanvasElement, pointerId: number): void {
  try { canvas.setPointerCapture?.(pointerId); } catch { /* 没有捕获也照样收得到后续事件 */ }
}

function releasePointer(canvas: HTMLCanvasElement, pointerId: number): void {
  try { canvas.releasePointerCapture?.(pointerId); } catch { /* 松开时浏览器本来也会自动释放 */ }
}

/** rAF 的兜底：没有它的环境（老浏览器、部分测试环境）退回定时器。 */
const requestFrame = (callback: () => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : window.setTimeout(callback, 16);

const cancelFrame = (handle: number): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else window.clearTimeout(handle);
};
const QUALITY_LABEL: Record<AndroidQualityId, TranslationKey> = {
  auto: 'android.qualityAuto',
  low: 'android.qualityLow',
  medium: 'android.qualityMedium',
  high: 'android.qualityHigh',
  custom: 'android.qualityCustom',
};
const readStoredQuality = (): AndroidQuality => {
  try {
    const raw = localStorage.getItem(QUALITY_STORAGE_KEY);
    return raw ? normalizeAndroidQuality(JSON.parse(raw)) : DEFAULT_ANDROID_QUALITY;
  } catch { return DEFAULT_ANDROID_QUALITY; }
};
const writeStoredQuality = (quality: AndroidQuality) => {
  try { localStorage.setItem(QUALITY_STORAGE_KEY, JSON.stringify(quality)); } catch { /* storage unavailable */ }
};

export function AndroidMirrorView({ sessionId, dockOnly = false, onInsertPrompt, onInsertFile, onRecordingComplete }: {
  sessionId?: string | null;
  dockOnly?: boolean;
  onInsertPrompt?: (text: string) => void;
  /** 截图/录屏产物：上传到临时目录后插入路径引用。 */
  onInsertFile?: (file: File) => Promise<unknown> | void;
  onRecordingComplete?: (file: AndroidRecording) => void;
}) {
  const { t } = useI18n();
  const overlay = useAndroidMirrorStore(state => state.overlay);
  const setOverlay = useAndroidMirrorStore(state => state.setOverlay);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<AndroidMirrorController | null>(null);
  const connectedSerial = useRef<string | null>(null);
  const initialQuality = useMemo<AndroidQuality>(readStoredQuality, []);
  const qualityRef = useRef<AndroidQuality>(initialQuality);
  const adaptive = useRef<{ serial: string; policy: AutoQuality } | null>(null);
  const streamQuality = useRef<AndroidQuality | null>(null);
  const [autoBitrate, setAutoBitrate] = useState(4_000_000);
  /** 正在注入设备的那根手指；x/y 是设备坐标，手势被打断时就近作废。 */
  const activePointer = useRef<{ id: number; type: string; x: number; y: number } | null>(null);
  /** 按下的所有指针（client 坐标）：第二根落下即说明用户要操作视图而不是设备。 */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const viewGesture = useRef<ViewGesture | null>(null);
  /** 视图手势期间不向设备注入触摸；要等所有手指抬起才复位，否则收尾时会冒一次点击。 */
  const suppressTouch = useRef(false);
  /** 只有按钮的禁用态读这个状态；手势中的实时倍率走 ref，免得每帧重渲染整个面板。 */
  const [zoom, setZoom] = useState(ZOOM_MIN);
  const zoomRef = useRef(zoom);
  const panRef = useRef({ x: 0, y: 0 });
  /** 统计行里的倍率前缀：手势中直接改这行的文字，同样是为了绕开重渲染。 */
  const zoomLabelRef = useRef<HTMLSpanElement | null>(null);
  /** 待结算的手势帧句柄（0 表示没有）。 */
  const gestureFrame = useRef(0);
  const wheelFrame = useRef(0);
  const autoConnected = useRef<string | null>(null);
  const retryAttempt = useRef(0);

  const [listing, setListing] = useState<AndroidDeviceList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedSerial, setSelectedSerial] = useState<string>('');
  const [qualityId, setQualityId] = useState<AndroidQualityId>(initialQuality.id);
  const [presets, setPresets] = useState<AndroidSavedPresetState[]>([]);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState('');
  const [qualityPanelExpanded, setQualityPanelExpanded] = useState(true);
  const [custom, setCustom] = useState({
    maxSize: initialQuality.maxSize,
    bitRate: initialQuality.bitRate,
    maxFps: initialQuality.maxFps,
  });
  const [mirrorState, setMirrorState] = useState<MirrorState>('idle');
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const [header, setHeader] = useState<MirrorHeader | null>(null);
  const [stats, setStats] = useState<MirrorStats>({ fps: 0, kbps: 0, width: 0, height: 0, received: 0, decoded: 0, controls: 0, last: '' });
  const [bitrateWarning, setBitrateWarning] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [retryScheduled, setRetryScheduled] = useState(false);
  const [ripples, setRipples] = useState<{ id: number; left: number; top: number }[]>([]);
  const [press, setPress] = useState<{ left: number; top: number } | null>(null);
  const [trail, setTrail] = useState<{ x: number; y: number }[]>([]);
  const [dragging, setDragging] = useState(false);
  const gestureStart = useRef<{ left: number; top: number } | null>(null);
  const rippleId = useRef(0);
  const rippleTimers = useRef<number[]>([]);
  const [showAddress, setShowAddress] = useState(false);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  // 短暂反馈只写在底部常驻行里：任何会改变画布高度的提示都不接受。
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const recordingRef = useRef<AndroidRecording | null>(null);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const recordingRequest = useRef(false);
  const deliveredRecordings = useRef(new Set<string>());
  const recordingTimer = useRef<number | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const captureBusyRef = useRef(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  // 录屏由父级确认处理，离开投屏面板也不能跳过确认。
  const onRecordingCompleteRef = useRef(onRecordingComplete);
  onRecordingCompleteRef.current = onRecordingComplete;
  // 低频操作（网络连接 / 分屏 / 全屏 / 铺满侧栏）收进 ⋯ 菜单，让手机上一行放得下。
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreAnchor, setMoreAnchor] = useState<{ left: number; top: number } | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

  // 优先用 App 传入的当前会话 id；遗留 store 仅作兜底。
  const storeSessionId = useMultiSessionStore(state => state.activeSessionId ?? (state.sessions.keys().next().value as string | undefined) ?? null);
  const activeSessionId = sessionId ?? storeSessionId;
  const docked = useCollaborationPanelDock(state => Boolean(state.docks[DOCK_GROUP]));
  const dockHost = useCollaborationPanelDock(state => state.hosts[DOCK_GROUP]);
  const setDock = useCollaborationPanelDock(state => state.setDock);

  const refreshDevices = useCallback(async () => {
    setLoadingList(true);
    try {
      const result = await listAndroidDevices();
      setListing(result);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'ADB_UNAVAILABLE');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { void refreshDevices(); }, [refreshDevices]);

  const devices = listing?.devices ?? [];
  const connectedDevice = devices.find(device => device.serial === selectedSerial) ?? null;
  // 依赖缺失是可操作的引导，用专门的 i18n 文案而不是把原始错误码丢给用户。
  const adbMissing = Boolean(listError && /ADB_NOT_FOUND|ADB_UNAVAILABLE/i.test(listError));
  const scrcpyMissing = Boolean(listing?.adbAvailable && !listing.scrcpyVersion);

  /** 中断时先清本地状态，再释放捕获，避免 lostpointercapture 重入后重复注入。 */
  const cancelPointerGesture = useCallback(() => {
    const active = activePointer.current;
    const captured = [...pointers.current.keys()];
    activePointer.current = null;
    pointers.current.clear();
    viewGesture.current = null;
    suppressTouch.current = false;
    gestureStart.current = null;
    cancelFrame(gestureFrame.current);
    gestureFrame.current = 0;
    if (active) controllerRef.current?.pointerCancel(active.x, active.y, active.type);
    const canvas = canvasRef.current;
    if (canvas) for (const id of captured) releasePointer(canvas, id);
    setPress(null);
    setDragging(false);
    setTrail([]);
    setZoom(zoomRef.current);
  }, []);

  useEffect(() => {
    // 捕获失败或被其他分屏接管时，画布可能收不到松手事件。
    const onPointerEnd = (event: globalThis.PointerEvent) => {
      if (!pointers.current.has(event.pointerId)) return;
      if (event.type === 'pointercancel' || event.target !== canvasRef.current) cancelPointerGesture();
    };
    const onBlur = () => cancelPointerGesture();
    const onVisibilityChange = () => { if (document.hidden) cancelPointerGesture(); };
    window.addEventListener('pointerup', onPointerEnd, true);
    window.addEventListener('pointercancel', onPointerEnd, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      cancelPointerGesture();
    };
  }, [cancelPointerGesture]);

  const disconnect = useCallback(() => {
    cancelPointerGesture();
    controllerRef.current?.disconnect();
    controllerRef.current = null;
    setMirrorState('idle');
    setMirrorError(null);
    setHeader(null);
  }, [cancelPointerGesture]);

  const connect = useCallback((serial: string, preserveFrame = false) => {
    const canvas = canvasRef.current;
    if (!canvas || !serial) return;
    cancelPointerGesture();
    controllerRef.current?.disconnect();
    setMirrorError(null);
    if (!preserveFrame && connectedSerial.current !== serial) setHeader(null);
    connectedSerial.current = serial;
    setWarning(null);
    setBitrateWarning(null);
    const controller = new AndroidMirrorController(canvas, {
      onBitrateSupport: (supported, detail) => {
        if (controllerRef.current !== controller || qualityRef.current.id !== 'auto') return;
        setBitrateWarning(supported ? null : detail ?? 'BITRATE_REASON_UNAVAILABLE');
      },
      onState: (state, error) => { if (controllerRef.current !== controller) return; setMirrorState(state); setMirrorError(error ?? null); },
      onHeader: next => { if (controllerRef.current === controller) setHeader(next); },
      onStats: next => { if (controllerRef.current === controller) setStats(next); },
      onWarning: message => { if (controllerRef.current === controller) setWarning(message); },
    });
    controllerRef.current = controller;
    let quality = qualityRef.current;
    if (quality.id === 'auto') {
      if (adaptive.current?.serial !== serial) adaptive.current = { serial, policy: new AutoQuality() };
      adaptive.current.policy.connected(performance.now());
      quality = adaptive.current.policy.quality;
      setAutoBitrate(quality.bitRate);
    } else adaptive.current = null;
    streamQuality.current = quality;
    controller.connect(serial, quality);
  }, [cancelPointerGesture]);

  useEffect(() => {
    if (qualityId !== 'auto' || qualityRef.current.id !== 'auto' || mirrorState !== 'streaming'
      || !stats.adaptation || document.hidden) return;
    const policy = adaptive.current;
    const controller = controllerRef.current;
    if (!policy || policy.serial !== selectedSerial || !controller?.canSetBitrate) return;
    const canvas = canvasRef.current;
    const pixels = canvas ? Math.max(canvas.clientWidth, canvas.clientHeight) * (window.devicePixelRatio || 1) * zoomRef.current : 1600;
    const quality = policy.policy.sample(stats.adaptation, performance.now(), pixels || 1600);
    if (quality) void controller.setBitrate(quality.bitRate).then(applied => {
      if (applied && controllerRef.current === controller) {
        streamQuality.current = quality;
        setAutoBitrate(quality.bitRate);
      }
    });
  }, [stats, qualityId, mirrorState, selectedSerial, connect]);

  // 偏好存服务端，换浏览器/设备也一致；localStorage 只作为首屏的即时初值。
  const persistAndroidPanel = useCallback((patch: {
    quality?: AndroidQuality;
    activePresetId?: string | null;
    presets?: AndroidSavedPresetState[];
    docked?: { sessionId: string; side: 'left' | 'right' | 'top' | 'bottom' } | null;
    deviceSerial?: string | null;
  }) => {
    const payload = {
      ...(patch.quality ? { quality: { id: patch.quality.id, maxSize: patch.quality.maxSize, bitRate: patch.quality.bitRate, maxFps: patch.quality.maxFps } } : {}),
      ...(patch.activePresetId !== undefined ? { activePresetId: patch.activePresetId } : {}),
      ...(patch.presets !== undefined ? { presets: patch.presets } : {}),
      ...(patch.docked !== undefined ? { docked: patch.docked } : {}),
      ...(patch.deviceSerial !== undefined ? { deviceSerial: patch.deviceSerial } : {}),
    };
    void updateSettings({ androidPanel: payload }).catch(() => { /* keep local choice */ });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getSettings().then(settings => {
      if (cancelled) return;
      const panel = settings.androidPanel;
      if (panel?.quality) {
        const quality = normalizeAndroidQuality(panel.quality);
        qualityRef.current = quality;
        setQualityId(quality.id);
        // 自定义滑块以当前档位为起点。
        setCustom({ maxSize: quality.maxSize, bitRate: quality.bitRate, maxFps: quality.maxFps });
        writeStoredQuality(quality);
      }
      setPresets(panel?.presets ?? []);
      setActivePresetId(panel?.activePresetId ?? null);
      if (panel?.deviceSerial) {
        autoConnected.current = panel.deviceSerial;
        setSelectedSerial(panel.deviceSerial);
      }
    }).catch(() => { /* 设置读取失败时用本地初值 */ });
    return () => { cancelled = true; };
  }, []);

  const addFadingDot = useCallback((point: { left: number; top: number }) => {
    const id = ++rippleId.current;
    setRipples(current => [...current, { id, left: point.left, top: point.top }]);
    const timer = window.setTimeout(() => {
      setRipples(current => current.filter(item => item.id !== id));
      rippleTimers.current = rippleTimers.current.filter(item => item !== timer);
    }, 300);
    rippleTimers.current.push(timer);
  }, []);

  const applyManualQuality = useCallback((serial: string, next: AndroidQuality) => {
    const controller = controllerRef.current;
    const current = streamQuality.current;
    if (controller?.supportsLiveBitrate && connectedSerial.current === serial && current
      && current.maxSize === next.maxSize && current.maxFps === next.maxFps) {
      void controller.setBitrate(next.bitRate).then(applied => {
        if (controllerRef.current !== controller) return;
        if (applied) { streamQuality.current = next; setBitrateWarning(null); }
        else setBitrateWarning(controller.lastBitrateFailure ?? 'BITRATE_REASON_UNAVAILABLE');
      });
    } else connect(serial);
  }, [connect, t]);

  const changeQuality = useCallback((id: string) => {
    adaptive.current = null;
    // 用户保存的预设以 user:<id> 表示，值等同于自定义。
    if (id.startsWith('user:')) {
      const preset = presets.find(item => item.id === id.slice(5));
      if (!preset) return;
      const next: AndroidQuality = { id: 'custom', maxSize: preset.maxSize, bitRate: preset.bitRate, maxFps: preset.maxFps };
      qualityRef.current = next;
      setQualityId('custom');
      setActivePresetId(preset.id);
      setCustom({ maxSize: preset.maxSize, bitRate: preset.bitRate, maxFps: preset.maxFps });
      setQualityPanelExpanded(true);
      writeStoredQuality(next);
      persistAndroidPanel({ quality: next, activePresetId: preset.id });
      if (selectedSerial) connect(selectedSerial);
      return;
    }
    if (id === 'custom') {
      // 以当前生效档位的数值作为滑块起点；等点「应用」再重连，避免拖动期反复重启。
      const base = qualityRef.current;
      setQualityId('custom');
      setActivePresetId(null);
      setCustom({ maxSize: base.maxSize, bitRate: base.bitRate, maxFps: base.maxFps });
      setQualityPanelExpanded(true);
      return;
    }
    const preset = id === 'auto' ? normalizeAndroidQuality({ id: 'auto' })
      : ANDROID_QUALITY_PRESETS.find(item => item.id === id) ?? DEFAULT_ANDROID_QUALITY;
    qualityRef.current = preset;
    setQualityId(preset.id);
    setActivePresetId(null);
    writeStoredQuality(preset);
    persistAndroidPanel({ quality: preset, activePresetId: null });
    if (selectedSerial) connect(selectedSerial);
  }, [connect, selectedSerial, presets, persistAndroidPanel]);

  const applyCustomQuality = useCallback(() => {
    const next: AndroidQuality = { id: 'custom', maxSize: custom.maxSize, bitRate: custom.bitRate, maxFps: custom.maxFps };
    qualityRef.current = next;
    writeStoredQuality(next);
    persistAndroidPanel({ quality: next, activePresetId: null });
    setQualityId('custom');
    setActivePresetId(null);
    if (selectedSerial) applyManualQuality(selectedSerial, next);
  }, [applyManualQuality, selectedSerial, custom, persistAndroidPanel]);

  const savePreset = useCallback(() => {
    const name = presetName.trim();
    if (!name) return;
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const preset: AndroidSavedPresetState = { id, name, maxSize: custom.maxSize, bitRate: custom.bitRate, maxFps: custom.maxFps };
    const nextPresets = [...presets.filter(item => item.name !== name), preset].slice(-12);
    const next: AndroidQuality = { id: 'custom', maxSize: custom.maxSize, bitRate: custom.bitRate, maxFps: custom.maxFps };
    setPresets(nextPresets);
    setPresetName('');
    setActivePresetId(id);
    setQualityId('custom');
    qualityRef.current = next;
    writeStoredQuality(next);
    persistAndroidPanel({ quality: next, activePresetId: id, presets: nextPresets });
    if (selectedSerial) applyManualQuality(selectedSerial, next);
  }, [presetName, custom, presets, selectedSerial, applyManualQuality, persistAndroidPanel]);

  const deletePreset = useCallback(() => {
    if (!activePresetId) return;
    const nextPresets = presets.filter(item => item.id !== activePresetId);
    setPresets(nextPresets);
    setActivePresetId(null);
    persistAndroidPanel({ activePresetId: null, presets: nextPresets });
  }, [activePresetId, presets, persistAndroidPanel]);

  useEffect(() => () => {
    controllerRef.current?.disconnect();
    controllerRef.current = null;
    for (const timer of rippleTimers.current) window.clearTimeout(timer);
    rippleTimers.current = [];
  }, []);

  // 覆盖层时按 ESC 退出。
  useEffect(() => {
    if (overlay === 'off') return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOverlay('off'); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [overlay, setOverlay]);

  // 首次发现唯一一台已授权设备时自动投屏。
  useEffect(() => {
    const ready = devices.filter(device => device.state === 'device');
    if (selectedSerial || ready.length !== 1) return;
    const serial = ready[0]!.serial;
    if (autoConnected.current === serial) return;
    autoConnected.current = serial;
    setSelectedSerial(serial);
  }, [devices, selectedSerial]);

  useEffect(() => {
    if (!selectedSerial) return;
    connect(selectedSerial);
  }, [selectedSerial, connect]);

  // 断链自动重连（指数退避）；缺依赖/无权限/解码器不可用等致命错误不重试。
  useEffect(() => {
    if (mirrorState === 'streaming') { retryAttempt.current = 0; setRetryScheduled(false); return; }
    if (mirrorState !== 'error' || !selectedSerial || !isRetryableMirrorError(mirrorError ?? '')) return;
    const delay = Math.min(8000, 700 * 2 ** retryAttempt.current);
    retryAttempt.current += 1;
    setRetryScheduled(true);
    const timer = window.setTimeout(() => { setRetryScheduled(false); connect(selectedSerial); }, delay);
    return () => window.clearTimeout(timer);
  }, [mirrorState, mirrorError, selectedSerial, connect]);

  // ---- 视图缩放 / 平移 ----
  // 缩放靠 canvas 上的 transform，布局尺寸不变：指针换算用的 getBoundingClientRect
  // 自带变换，设备坐标映射不用为缩放改一行；本地的涟漪/拖尾也仍然钉在手指底下。

  /** box 可由调用方传入：手势里同一帧已经量过，再量一次等于白搭一次强制布局。 */
  const clampPan = useCallback((next: { x: number; y: number }, zoomValue: number, measured?: StageBox) => {
    const canvas = canvasRef.current;
    const box = measured ?? (canvas ? stageBox(canvas) : null);
    if (!canvas || !box) return { x: 0, y: 0 };
    return constrainMirrorPan(next, zoomValue, box);
  }, []);

  /**
   * 变换和倍率前缀只写 DOM：手势中若走 React 状态，每一帧都要重渲染整个面板，主线程一满就掉帧。
   *
   * 1× 无平移时一律不挂 transform（写空，和没有缩放这功能时一模一样）。挂上恒等变换同样是
   * 把画布提升成合成层，而合成层的栅格化比例是建层那一刻定下的：进面板时画布还是默认的
   * 300×150，首帧到达才换成帧尺寸，这层缓存不重算，画面就被按小尺寸栅格化再放大 —— 也就是
   * 「刚进去就糊」。同一串反复写也没有意义，跳过它，免得画布跟着每秒刷新的统计行走一遍样式。
   */
  const applyViewTransform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x, y } = panRef.current;
    const zoomValue = zoomRef.current;
    const next = zoomValue === ZOOM_MIN && x === 0 && y === 0
      ? ''
      : `translate3d(${x}px, ${y}px, 0) scale(${zoomValue})`;
    if (canvas.style.transform !== next) canvas.style.transform = next;
    const label = zoomLabelRef.current;
    if (label) label.textContent = zoomValue > ZOOM_MIN ? formatZoomLabel(zoomValue) : '';
  }, []);

  /** 以 focus（client 坐标，缺省为画面中心）为锚点缩放：锚点底下那一处画面保持不动。 */
  const applyZoom = useCallback((value: number, focus?: { x: number; y: number }, paint = true) => {
    const canvas = canvasRef.current;
    const current = zoomRef.current;
    const next = clampZoom(value);
    if (!canvas || next === current) return;
    const box = stageBox(canvas);
    if (!box) return;
    const anchor = focus ?? { x: box.cx, y: box.cy };
    const view = moveMirrorViewport({ zoom: current, pan: panRef.current }, box, anchor, anchor, next / current);
    zoomRef.current = view.zoom;
    panRef.current = view.pan;
    if (paint) applyViewTransform();
  }, [applyViewTransform]);

  // 连续输入只在按钮可用性变化时触发 React 更新。
  const syncZoomControls = useCallback(() => {
    const next = zoomRef.current;
    setZoom(previous => (previous <= ZOOM_MIN + 0.01) === (next <= ZOOM_MIN + 0.01)
      && (previous >= ZOOM_MAX - 0.01) === (next >= ZOOM_MAX - 0.01) ? previous : next);
  }, []);

  useEffect(() => () => {
    cancelFrame(gestureFrame.current);
    cancelFrame(wheelFrame.current);
  }, []);

  const readCentroid = () => {
    let x = 0;
    let y = 0;
    for (const point of pointers.current.values()) { x += point.x; y += point.y; }
    const count = pointers.current.size;
    return count ? { x: x / count, y: y / count } : null;
  };

  const readDistance = () => {
    const [first, second] = Array.from(pointers.current.values());
    return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0;
  };

  /** 每当参与手势的手指数变化（第二根落下、捏合退成拖动）都要重建基准，否则画面会跳。 */
  const beginViewGesture = () => {
    const centroid = readCentroid();
    const box = canvasRef.current ? stageBox(canvasRef.current) : null;
    if (!centroid || !box) return;
    viewGesture.current = {
      startCentroid: centroid,
      startDistance: readDistance(),
      box,
    };
  };

  /** 双指：整体拖动＝平移，张合＝以双指中心为锚点缩放；两种动作一次算完。 */
  const updateViewGesture = useCallback(() => {
    const gesture = viewGesture.current;
    const centroid = readCentroid();
    if (!gesture || !centroid) return;
    const distance = readDistance();
    const ratio = gesture.startDistance > 0 && distance > 0 ? distance / gesture.startDistance : 1;
    const view = moveMirrorViewport(
      { zoom: zoomRef.current, pan: panRef.current }, gesture.box,
      gesture.startCentroid, centroid, ratio,
    );
    zoomRef.current = view.zoom;
    panRef.current = view.pan;
    gesture.startCentroid = centroid;
    gesture.startDistance = distance;
  }, []);

  /**
   * 一帧最多结算一次手势。一帧里两根手指的 move 是两个独立任务，先到的那根会把
   * 另一根留在上一帧的位置：各自算一次，等于把「只动了一根」的中间态也画出来，
   * 于是画面在两个倍率之间来回跳（抖动）。等这一帧的输入都到齐再算，结果才自洽。
   */
  const scheduleGestureFrame = useCallback(() => {
    if (gestureFrame.current) return;
    gestureFrame.current = requestFrame(() => {
      gestureFrame.current = 0;
      updateViewGesture();
      applyViewTransform();
    });
  }, [updateViewGesture, applyViewTransform]);

  /** 抬手/收尾时把还没落地的这一帧先结算掉，别丢掉最后一段位移。 */
  const flushGestureFrame = useCallback(() => {
    if (!gestureFrame.current) return;
    cancelFrame(gestureFrame.current);
    gestureFrame.current = 0;
    updateViewGesture();
    applyViewTransform();
  }, [updateViewGesture, applyViewTransform]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stage = canvas.parentElement;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      // ⌘/Ctrl+滚轮＝缩放（触控板捏合发的也是带 ctrlKey 的滚轮），普通滚轮照旧转发给设备。
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (!event.deltaY || viewGesture.current) return;
        // 触控板的像素增量保持连续；行/页模式统一为像素，再映射到倍率。
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.parentElement?.clientHeight || 600 : 1;
        const delta = Math.max(-600, Math.min(600, event.deltaY * unit));
        applyZoom(zoomRef.current * Math.exp(-delta * 0.002), { x: event.clientX, y: event.clientY }, false);
        if (!wheelFrame.current) wheelFrame.current = requestFrame(() => {
          wheelFrame.current = 0;
          applyViewTransform();
          syncZoomControls();
        });
        return;
      }
      const controller = controllerRef.current;
      if (!controller || event.target !== canvas) return;
      event.preventDefault();
      const point = toDevicePoint(canvas, event.clientX, event.clientY);
      controller.scroll(point.x, point.y, event.deltaX, event.deltaY);
    };
    const preventNativeGesture = (event: Event) => event.preventDefault();
    stage.addEventListener('wheel', onWheel, { passive: false });
    // Safari also exposes native gesture events. Scope suppression to the preview,
    // including its gutters and reconnecting state, rather than the entire page.
    stage.addEventListener('gesturestart', preventNativeGesture, { passive: false });
    stage.addEventListener('gesturechange', preventNativeGesture, { passive: false });
    return () => {
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('gesturestart', preventNativeGesture);
      stage.removeEventListener('gesturechange', preventNativeGesture);
    };
  }, [applyZoom, applyViewTransform, syncZoomControls]);

  // 面板尺寸或设备方向一变，放大后的画面可能已经越出边界，按新尺寸重新钳制。
  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (viewGesture.current) viewGesture.current.box = stageBox(canvas)!;
      const clamped = clampPan(panRef.current, zoomRef.current);
      if (clamped.x === panRef.current.x && clamped.y === panRef.current.y) return;
      panRef.current = clamped;
      applyViewTransform();
    });
    observer.observe(canvas);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [clampPan, applyViewTransform]);

  // 变换和倍率前缀写在 DOM 上、不走状态，渲染后补一次，保证样式与 ref 不走散
  // （统计行每秒刷新会重渲染，header 之类变化也会）。
  useLayoutEffect(() => { applyViewTransform(); });

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const controller = controllerRef.current;
    const canvas = canvasRef.current;
    if (!controller || !canvas) return;
    // 鼠标右键=返回、中键=Home，与 scrcpy 默认绑定一致。
    if (event.pointerType === 'mouse' && event.button !== 0) {
      event.preventDefault();
      if (event.button === 2) controller.back();
      else if (event.button === 1) controller.home();
      return;
    }
    event.preventDefault();
    canvas.closest<HTMLElement>('.android-mirror-panel')?.focus({ preventScroll: true });
    applyViewTransform();
    syncZoomControls();
    flushGestureFrame();
    capturePointer(canvas, event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // 鼠标只有一根指针，Alt+拖动走和双指一样的视图手势。
    const altPan = event.pointerType === 'mouse' && event.altKey;
    if (pointers.current.size >= 2 || altPan) {
      // 第二根手指落下＝用户要看画面而不是操作设备：把已经发出的触摸作废（发 UP 会被当成一次点击）。
      const active = activePointer.current;
      if (active) {
        controller.pointerCancel(active.x, active.y, active.type);
        activePointer.current = null;
        gestureStart.current = null;
        setPress(null);
        setDragging(false);
        setTrail([]);
      }
      suppressTouch.current = true;
      beginViewGesture();
      return;
    }
    if (suppressTouch.current) return;
    const point = toDevicePoint(canvas, event.clientX, event.clientY);
    activePointer.current = { id: event.pointerId, type: event.pointerType, x: point.x, y: point.y };
    controller.pointerDown(point.x, point.y, event.pointerType);
    // 点击涟漪：确认手势被识别，并把落点反馈到画面上。
    const local = toLocalPoint(canvas, event.clientX, event.clientY);
    if (local) {
      gestureStart.current = { left: local.left, top: local.top };
      setTrail([]);
      setDragging(false);
      // 按住期间保持圆圈，松手才淡出。
      setPress(local);
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const controller = controllerRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !pointers.current.has(event.pointerId)) return;
    if (event.pointerType === 'mouse') {
      const bounds = canvas.getBoundingClientRect();
      const stage = canvas.parentElement?.getBoundingClientRect() ?? bounds;
      // 指针捕获期间不会触发 leave，必须按画布与裁切容器的交集判断是否越界。
      if (!(event.buttons & 1)
        || event.clientX < Math.max(bounds.left, stage.left)
        || event.clientX >= Math.min(bounds.right, stage.right)
        || event.clientY < Math.max(bounds.top, stage.top)
        || event.clientY >= Math.min(bounds.bottom, stage.bottom)) {
        cancelPointerGesture();
        return;
      }
    }
    event.preventDefault();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (viewGesture.current) { scheduleGestureFrame(); return; }
    const active = activePointer.current;
    if (!controller || !active || active.id !== event.pointerId) return;
    const point = toDevicePoint(canvas, event.clientX, event.clientY);
    active.x = point.x;
    active.y = point.y;
    controller.pointerMove(point.x, point.y, active.type);
    const local = toLocalPoint(canvas, event.clientX, event.clientY);
    const start = gestureStart.current;
    if (!local || !start) return;
    // 圆圈跟随手指，充当触摸光标。
    setPress(local);
    // 超过阈值才算拖动，积累一小段轨迹形成拖尾；纯点击不画。
    if (Math.hypot(local.left - start.left, local.top - start.top) >= 6) {
      setDragging(true);
      setTrail(current => {
        const last = current[current.length - 1];
        if (last && Math.hypot(local.left - last.x, local.top - last.y) < 4) return current;
        const next = [...current, { x: local.left, y: local.top }];
        return next.length > 12 ? next.slice(next.length - 12) : next;
      });
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const controller = controllerRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !pointers.current.has(event.pointerId)) return;
    // 抬手时可能还有一帧没落地：先把手指最后的位置结算掉，别丢掉这一段位移。
    flushGestureFrame();
    pointers.current.delete(event.pointerId);
    // 正常释放捕获时不再把这根指针视为活跃，lostpointercapture 不应取消其余手指。
    releasePointer(canvas, event.pointerId);
    if (pointers.current.size === 0) suppressTouch.current = false;
    // 视图手势要等所有手指抬起才算结束；捏合退成单指时以剩下那根重建基准，画面不跳。
    if (viewGesture.current) {
      if (pointers.current.size === 0) {
        viewGesture.current = null;
        // 手势结束才把倍率交回状态，按钮禁用态读的是它。
        setZoom(zoomRef.current);
      } else beginViewGesture();
      return;
    }
    const active = activePointer.current;
    if (!active || active.id !== event.pointerId) return;
    const point = toDevicePoint(canvas, event.clientX, event.clientY);
    controller?.pointerUp(point.x, point.y, active.type);
    if (press) addFadingDot(press);
    setPress(null);
    // 松手后拖尾淡出，再清空。
    setDragging(false);
    window.setTimeout(() => setTrail([]), 200);
    activePointer.current = null;
    gestureStart.current = null;
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // 菜单或输入框开着时按键归它们。菜单那半段是冗余保险（document 捕获阶段的
    // stopPropagation 已经拦住了），但输入框那半段是真的：否则地址框里敲退格会
    // 被 preventDefault 吃掉、同时把退格转发给设备。
    if (moreOpen || showAddress || textMode) return;
    const controller = controllerRef.current;
    if (!controller) return;
    if (event.key === 'Backspace') { event.preventDefault(); controller.key(67); }
    else if (event.key === 'Escape') { event.preventDefault(); controller.back(); }
    else if (event.key === 'Enter') { event.preventDefault(); controller.key(66); }
  };

  const submitAddress = async () => {
    const value = address.trim();
    if (!value) return;
    setBusy(true);
    try {
      const result = await connectAndroidDevice(value);
      setAddress('');
      setShowAddress(false);
      await refreshDevices();
      setSelectedSerial(result.serial);
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'ADB_CONNECT_FAILED');
    } finally {
      setBusy(false);
    }
  };

  const sendText = () => {
    const controller = controllerRef.current;
    const value = textDraft;
    if (!controller || !value) return;
    controller.sendText(value);
    setTextDraft('');
  };

  const showStatus = useCallback((message: string) => {
    setCaptureStatus(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => { noticeTimer.current = null; setCaptureStatus(null); }, 2500);
  }, []);

  /** 按钮按档位放大/缩小；捏合或滚轮停在档位之间时，按相邻档归位。 */
  const zoomByStep = useCallback((direction: 'in' | 'out') => {
    const current = zoomRef.current;
    const next = direction === 'in'
      ? ZOOM_LADDER.find(value => value > current + 0.01)
      : [...ZOOM_LADDER].reverse().find(value => value < current - 0.01);
    if (next === undefined) return;
    // 第一次放大时点破一次平移手势：借底部那行既有的短暂反馈位，不新开一行。
    if (current <= ZOOM_MIN && next > ZOOM_MIN) showStatus(t('android.zoomPanHint'));
    flushGestureFrame();
    applyZoom(next);
    setZoom(next);
  }, [applyZoom, flushGestureFrame, showStatus, t]);

  // 失败要显眼、要能读全，所以走头部错误条（本就是动态提示区）；
  // 成功只占用底部那行两秒半，不新开任何一行。
  const insertCapture = useCallback(async (file: File, done: string) => {
    try {
      await onInsertFile?.(file);
      showStatus(done);
    } catch (error) {
      setCaptureError(t('android.captureFailed') + (error instanceof Error ? `：${error.message}` : ''));
    }
  }, [onInsertFile, showStatus, t]);

  const takeScreenshot = async () => {
    const canvas = canvasRef.current;
    if (!canvas || captureBusyRef.current) return;
    captureBusyRef.current = true;
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      const file = await captureMirrorScreenshot(canvas);
      await insertCapture(file, t('android.captureInserted'));
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : String(error));
    } finally {
      captureBusyRef.current = false;
      setCaptureBusy(false);
    }
  };

  const receiveRecording = useCallback((item: AndroidRecording) => {
    if (item.status === 'ready' || item.status === 'error') {
      if (!deliveredRecordings.current.has(item.id)) {
        deliveredRecordings.current.add(item.id);
        onRecordingCompleteRef.current?.(item);
      }
    }
  }, []);

  const stopRecording = useCallback(async (_reason: string) => {
    const item = recordingRef.current;
    if (!item || recordingRequest.current) return;
    recordingRequest.current = true;
    setRecordingBusy(true);
    setCaptureError(null);
    try {
      const result = await stopAndroidRecording(item.id);
      recordingRef.current = null;
      setRecording(false);
      receiveRecording(result);
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : String(error));
    } finally { recordingRequest.current = false; setRecordingBusy(false); }
  }, [receiveRecording]);

  const startRecording = async () => {
    if (!selectedSerial || recordingRequest.current || recordingRef.current) return;
    recordingRequest.current = true;
    setRecordingBusy(true);
    setCaptureError(null);
    try {
      const item = await startAndroidRecording(selectedSerial);
      if (item.status === 'recording' || item.status === 'starting' || item.status === 'stopping') {
        recordingRef.current = item;
        setRecording(true);
        setRecordingElapsed(Math.max(0, Date.now() - item.startedAt));
      } else receiveRecording(item);
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : String(error));
    } finally { recordingRequest.current = false; setRecordingBusy(false); }
  };

  // 服务端拥有录制生命周期；刷新、切换面板和预览重连都不会停止录像。
  useEffect(() => {
    let cancelled = false;
    let polling = false;
    recordingRef.current = null;
    setRecording(false);
    const poll = async () => {
      if (!selectedSerial || polling || recordingRequest.current) return;
      polling = true;
      try {
        const { recordings } = await listAndroidRecordings(selectedSerial);
        if (cancelled || recordingRequest.current) return;
        const active = recordings.find(item => ['starting', 'recording', 'stopping'].includes(item.status));
        recordingRef.current = active ?? null;
        setRecording(Boolean(active));
        for (const item of recordings) receiveRecording(item);
      } catch { /* 保留已知录制状态，断网不等于服务端停止。 */ }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    recordingTimer.current = window.setInterval(() => {
      if (recordingRef.current) setRecordingElapsed(Math.max(0, Date.now() - recordingRef.current.startedAt));
    }, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (recordingTimer.current !== null) window.clearInterval(recordingTimer.current);
    };
  }, [selectedSerial, receiveRecording]);

  // ⋯ 菜单：点外部 / Esc / 视口变化都关掉。菜单是 portal 到 body 的浮层，
  // 用捕获阶段监听，确保 Esc 先被菜单吃掉，不会被下面的 onKeyDown 转成设备返回键。
  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (moreButtonRef.current?.contains(target) || moreMenuRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', close);
    };
  }, [moreOpen]);

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);

  const streaming = mirrorState === 'streaming';
  // 分屏时收成与 agent 面板一致的紧凑标题栏（h-6）。
  const compact = docked;
  const iconButtonClass = compact
    ? 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-surface-2 disabled:opacity-40'
    : 'rounded p-1.5 hover:bg-surface-2 disabled:opacity-40';

  const openMore = () => {
    const rect = moreButtonRef.current?.getBoundingClientRect();
    if (rect) {
      setMoreAnchor({
        left: Math.max(8, Math.min(rect.right - MORE_MENU_WIDTH, window.innerWidth - MORE_MENU_WIDTH - 8)),
        top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - MORE_MENU_ESTIMATED_HEIGHT - 8)),
      });
    }
    setMoreOpen(true);
  };
  const toggleSplit = () => {
    if (docked) {
      setDock(DOCK_GROUP, null);
      persistAndroidPanel({ docked: null });
      return;
    }
    if (!activeSessionId) return;
    const next = { sessionId: activeSessionId, side: 'right' as const };
    setDock(DOCK_GROUP, next);
    persistAndroidPanel({ docked: next });
  };
  // 菜单开着就算某种「展开态」，在标题栏上留一点可见状态，替代原来 4 个按钮各自的着色。
  const moreActive = showAddress || docked || overlay !== 'off';

  const body = (
    <div
      className="android-mirror-panel flex h-full min-h-0 min-w-0 flex-col bg-surface text-foreground"
      data-sidebar-gesture-ignore="true"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div
        data-panel-drag-title={docked ? 'true' : undefined}
        className={compact
          ? 'flex h-6 min-h-6 shrink-0 flex-nowrap items-center gap-1 overflow-hidden border-b border-border/15 bg-[var(--chrome-bg)] px-1.5 cursor-grab select-none active:cursor-grabbing'
          : 'flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-2'}
      >
        {docked && (
          <span
            data-panel-drag-title="true"
            role="button"
            aria-label={t('android.splitDrag')}
            title={t('android.splitDrag')}
            className="flex h-4 w-4 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:text-foreground active:cursor-grabbing"
          >
            <GripVertical size={12} />
          </span>
        )}
        <Smartphone size={compact ? 12 : 14} className="shrink-0 text-muted-foreground" />
        <select
          value={selectedSerial}
          onChange={event => {
            const serial = event.target.value;
            setSelectedSerial(serial);
            autoConnected.current = serial;
            if (serial) persistAndroidPanel({ deviceSerial: serial });
          }}
          className={compact
            ? 'h-5 min-w-0 flex-1 rounded bg-surface-2 px-1 text-[10px] leading-none text-foreground outline-none'
            : 'min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-[11px] text-foreground outline-none'}
          aria-label={t('android.device')}
        >
          <option value="">{devices.length ? t('android.selectDevice') : t('android.noDevices')}</option>
          {devices.map(device => (
            <option key={device.serial} value={device.serial}>
              {(device.model || device.serial) + deviceStateSuffix(device, t)}
            </option>
          ))}
        </select>
        <select
          value={activePresetId ? `user:${activePresetId}` : qualityId}
          onChange={event => changeQuality(event.target.value)}
          className={compact
            ? 'h-5 shrink-0 rounded bg-surface-2 px-1 text-[10px] leading-none text-foreground outline-none'
            : 'shrink-0 rounded bg-surface-2 px-1.5 py-1 text-[11px] text-foreground outline-none'}
          title={qualityId === 'auto' ? t('android.qualityAutoHint') : t('android.quality')}
          aria-label={t('android.quality')}
        >
          <option value="auto">{t('android.qualityAuto')}{qualityId === 'auto' ? ` · ${autoBitrate / 1_000_000} Mbps` : ''}</option>
          {ANDROID_QUALITY_PRESETS.map(preset => (
            <option key={preset.id} value={preset.id}>{t(QUALITY_LABEL[preset.id])}</option>
          ))}
          {presets.map(preset => (
            <option key={preset.id} value={`user:${preset.id}`}>{preset.name}</option>
          ))}
          <option value="custom">{t(QUALITY_LABEL.custom)}</option>
        </select>
        <button type="button" onClick={() => void refreshDevices()} className={`${iconButtonClass} text-muted-foreground`} title={t('android.refresh')}>
          {loadingList ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
        {streaming ? (
          <button type="button" onClick={disconnect} className={`${iconButtonClass} text-destructive`} title={t('android.disconnect')}>
            <Unplug size={13} />
          </button>
        ) : (
          <button type="button" onClick={() => selectedSerial && connect(selectedSerial)} disabled={!selectedSerial} className={`${iconButtonClass} text-primary`} title={t('android.connect')}>
            <Plug size={13} />
          </button>
        )}
        {(streaming || recording) && (
          <button
            type="button"
            onClick={() => void takeScreenshot()}
            disabled={!onInsertFile || captureBusy}
            className={`${iconButtonClass} text-muted-foreground`}
            title={onInsertFile ? t('android.screenshot') : t('android.captureUnavailable')}
            aria-label={t('android.screenshot')}
          >
            {captureBusy ? <Loader2 size={compact ? 12 : 13} className="animate-spin" /> : <Camera size={compact ? 12 : 13} />}
          </button>
        )}
        {(streaming || recording) && (
          <button
            type="button"
            onClick={() => { if (recording) void stopRecording('manual'); else void startRecording(); }}
            disabled={recordingBusy || (!recording && !onRecordingComplete)}
            className={`${iconButtonClass} ${recording ? 'text-destructive' : 'text-muted-foreground'}`}
            title={recording ? t('android.recordingStop') : (onRecordingComplete ? t('android.recordingStart') : t('android.captureUnavailable'))}
            aria-label={recording ? t('android.recordingStop') : t('android.recordingStart')}
          >
            {recordingBusy ? <Loader2 className="animate-spin" size={13} /> : recording ? <Square size={compact ? 10 : 11} fill="currentColor" /> : <Video size={compact ? 12 : 13} />}
          </button>
        )}
        <button
          ref={moreButtonRef}
          type="button"
          onClick={() => (moreOpen ? setMoreOpen(false) : openMore())}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          className={`${iconButtonClass} ${moreActive ? 'text-primary' : 'text-muted-foreground'}`}
          title={t('android.more')}
          aria-label={t('android.more')}
        >
          <MoreHorizontal size={compact ? 13 : 14} />
        </button>
      </div>

      {moreOpen && moreAnchor && createPortal(
        <div
          ref={moreMenuRef}
          role="menu"
          aria-label={t('android.more')}
          style={{ left: moreAnchor.left, top: moreAnchor.top, width: MORE_MENU_WIDTH }}
          className="fixed z-popover overflow-hidden rounded-md border border-border bg-surface-elevated py-1 text-[11px] shadow-lg"
        >
          <MirrorMenuItem
            icon={<ChevronDown size={13} />}
            label={t('android.addDevice')}
            active={showAddress}
            onSelect={() => { setShowAddress(value => !value); setMoreOpen(false); }}
          />
          <MirrorMenuItem
            icon={docked ? <X size={13} /> : <Columns2 size={13} />}
            label={t(docked ? 'android.splitClose' : 'android.splitOpen')}
            active={docked}
            disabled={!docked && !activeSessionId}
            onSelect={() => { toggleSplit(); setMoreOpen(false); }}
          />
          <MirrorMenuItem
            icon={overlay === 'window' ? <Minimize size={13} /> : <Maximize size={13} />}
            label={t(overlay === 'window' ? 'android.exitFullscreen' : 'android.fullscreen')}
            active={overlay === 'window'}
            onSelect={() => { setOverlay(overlay === 'window' ? 'off' : 'window'); setMoreOpen(false); }}
          />
          {!dockOnly && (
            <MirrorMenuItem
              icon={overlay === 'sidebar' ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
              label={t(overlay === 'sidebar' ? 'android.exitFullscreen' : 'android.fillSidebar')}
              active={overlay === 'sidebar'}
              onSelect={() => { setOverlay(overlay === 'sidebar' ? 'off' : 'sidebar'); setMoreOpen(false); }}
            />
          )}
          {header && (
            <div className="mt-1 border-t border-border px-3 py-2 text-[10px] leading-4 tabular-nums text-muted-foreground">
              <div className="truncate">{`${stats.fps} fps · ${stats.kbps} kbps`}</div>
              <div className="truncate">{`${stats.width}×${stats.height}`}</div>
            </div>
          )}
        </div>,
        document.body,
      )}

      {(qualityId === 'custom' || activePresetId) && (
        <div className="border-b border-border bg-surface-2/40 px-2 py-2 text-[11px]">
          <button
            type="button"
            onClick={() => setQualityPanelExpanded(value => !value)}
            aria-expanded={qualityPanelExpanded}
            className="flex w-full items-center gap-1 rounded text-muted-foreground hover:text-foreground"
          >
            <ChevronDown size={12} className={`transition-transform ${qualityPanelExpanded ? '' : '-rotate-90'}`} />
            <span>
              {t('android.quality')}
              {activePresetId ? ` · ${presets.find(item => item.id === activePresetId)?.name ?? ''}` : ''}
            </span>
          </button>
          {qualityPanelExpanded && (
          <div className="mt-2 grid gap-2">
          <QualitySlider
            label={t('android.qualityResolution')}
            display={`${custom.maxSize}px`}
            min={360} max={2160} step={8} value={custom.maxSize}
            onChange={value => setCustom(current => ({ ...current, maxSize: value }))}
          />
          <QualitySlider
            label={t('android.qualityBitRate')}
            display={`${(custom.bitRate / 1_000_000).toFixed(1)} Mbps`}
            min={0.5} max={20} step={0.5} value={custom.bitRate / 1_000_000}
            onChange={value => setCustom(current => ({ ...current, bitRate: Math.round(value * 1_000_000) }))}
          />
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-muted-foreground">{t('android.qualityFrameRate')}</span>
            <div className="flex gap-1">
              {[15, 30, 60].map(fps => (
                <button
                  key={fps}
                  type="button"
                  onClick={() => setCustom(current => ({ ...current, maxFps: fps }))}
                  className={`rounded px-2 py-0.5 ${custom.maxFps === fps ? 'bg-surface-elevated text-primary' : 'text-muted-foreground hover:bg-surface-2'}`}
                >
                  {fps}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setCustom(current => ({ ...current, maxFps: 0 }))}
                className={`rounded px-2 py-0.5 ${custom.maxFps === 0 ? 'bg-surface-elevated text-primary' : 'text-muted-foreground hover:bg-surface-2'}`}
              >
                {t('android.qualityAuto')}
              </button>
            </div>
            <button
              type="button"
              onClick={applyCustomQuality}
              disabled={!selectedSerial}
              className="ml-auto rounded bg-primary/15 px-2 py-1 text-primary disabled:opacity-40"
            >
              {t('android.qualityApply')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={presetName}
              onChange={event => setPresetName(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) savePreset(); }}
              placeholder={t('android.presetNamePlaceholder')}
              maxLength={40}
              className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-[11px] outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={savePreset}
              disabled={!presetName.trim()}
              className="shrink-0 rounded bg-surface-2 px-2 py-1 text-primary disabled:opacity-40"
            >
              {t('android.presetSave')}
            </button>
            {activePresetId && (
              <button type="button" onClick={deletePreset} className="shrink-0 rounded px-2 py-1 text-destructive hover:bg-surface-2">
                {t('android.presetDelete')}
              </button>
            )}
          </div>
          </div>
          )}
        </div>
      )}

      {showAddress && (
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-2">
          <input
            value={address}
            onChange={event => setAddress(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') void submitAddress(); }}
            placeholder={t('android.addressPlaceholder')}
            className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-[11px] outline-none placeholder:text-muted-foreground"
          />
          <button type="button" onClick={() => void submitAddress()} disabled={busy} className="rounded bg-surface-2 px-2 py-1 text-[11px] text-primary disabled:opacity-40">
            {busy ? <Loader2 size={12} className="animate-spin" /> : t('android.connect')}
          </button>
        </div>
      )}

      {adbMissing && (
        <div className="flex items-start gap-2 border-b border-border bg-surface-2 px-2 py-1.5 text-[11px] text-destructive">
          <span className="min-w-0 flex-1">{t('android.adbUnavailable')}</span>
          <DependencyFixButton label={t('android.insertFixPrompt')} onClick={() => onInsertPrompt?.(buildAndroidFixPrompt('adb', listError ?? ''))} enabled={Boolean(onInsertPrompt)} />
        </div>
      )}
      {!adbMissing && scrcpyMissing && (
        <div className="flex items-start gap-2 border-b border-border bg-surface-2 px-2 py-1.5 text-[11px] text-warning">
          <span className="min-w-0 flex-1">{t('android.scrcpyUnavailable')}</span>
          <DependencyFixButton label={t('android.insertFixPrompt')} onClick={() => onInsertPrompt?.(buildAndroidFixPrompt('scrcpy', ''))} enabled={Boolean(onInsertPrompt)} />
        </div>
      )}
      {connectedDevice && connectedDevice.state !== 'device' && (
        <div className="border-b border-border bg-surface-2 px-2 py-1.5 text-[11px] text-warning">{deviceStateHint(connectedDevice, t)}</div>
      )}
      {listError && !adbMissing && <div className="border-b border-border bg-surface-2 px-2 py-1.5 text-[11px] text-destructive">{androidErrorText(listError)}</div>}
      {bitrateWarning && (
        <details className="border-b border-border bg-surface-2 px-2 py-1.5 text-[11px] text-warning">
          <summary className="cursor-pointer">
            {t('android.qualityAutoUnavailable')} {t(
              bitrateWarning.startsWith('SCRCPY_VERSION') ? 'android.qualityAutoVersionError'
              : bitrateWarning.startsWith('SCRCPY_BUILD') ? 'android.qualityAutoBuildError'
              : /EXTENSION|SERVER_READ|PUSH/.test(bitrateWarning.split(':')[0]) ? 'android.qualityAutoExtensionError'
              : /TIMEOUT/.test(bitrateWarning.split(':')[0]) ? 'android.qualityAutoTimeoutError'
              : /ENCODER_REJECTED/.test(bitrateWarning.split(':')[0]) ? 'android.qualityAutoEncoderError'
              : /CHANNEL|TUNNEL|LISTEN|PROTOCOL|CONNECTION/.test(bitrateWarning.split(':')[0]) ? 'android.qualityAutoChannelError'
              : 'android.qualityAutoUnknownError')}
          </summary>
          <pre className="mt-1 select-text whitespace-pre-wrap break-all text-[10px]">{bitrateWarning}</pre>
        </details>
      )}
      {warning && <div className="border-b border-border bg-surface-2 px-2 py-1.5 text-[11px] text-warning">{warning}</div>}
      {captureError && (
        <div role="alert" className="border-b border-border bg-surface-2 px-2 py-1.5 text-[11px] text-destructive">
          {captureError}
        </div>
      )}


      <div className="relative flex min-h-0 min-w-0 flex-1 touch-none items-center justify-center overflow-hidden bg-[var(--chrome-bg)] p-1">
        <canvas
          ref={canvasRef}
          className="max-h-full max-w-full touch-none select-none rounded"
          style={{
            display: streaming || header ? 'block' : 'none',
            // 缩放/平移只改这一层：布局尺寸（max-w/max-h 铺满）不变，设备坐标映射照旧。
            // transform 不在这里给：手势中它由 applyViewTransform 直接写，逐帧渲染太重；
            // 静止态那串空值也由它写，别在这儿追上一条恒等变换（见那边的注释）。
            transformOrigin: 'center',
            // 全局 * 的 transform 过渡会把每帧输入变成 200ms 的追赶动画。
            transition: 'none',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => cancelPointerGesture()}
          onLostPointerCapture={event => {
            if (pointers.current.has(event.pointerId)) cancelPointerGesture();
          }}
          onPointerLeave={event => {
            if (pointers.current.has(event.pointerId) && !event.currentTarget.hasPointerCapture?.(event.pointerId)) {
              cancelPointerGesture();
            }
          }}
          onContextMenu={event => event.preventDefault()}
        />
        {press && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/80 bg-primary/35"
            style={{ left: press.left, top: press.top }}
          />
        )}
        {trail.length > 1 && (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full"
            style={{ opacity: dragging ? 1 : 0, transition: 'opacity 160ms linear' }}
          >
            {trail.slice(1).map((point, index) => {
              const from = trail[index]!;
              const weight = (index + 1) / (trail.length - 1);
              return (
                <line
                  key={index}
                  x1={from.x} y1={from.y} x2={point.x} y2={point.y}
                  stroke="var(--primary)" strokeWidth={1 + 1.6 * weight} strokeLinecap="round" opacity={0.06 + 0.45 * weight}
                />
              );
            })}
          </svg>
        )}
        {ripples.map(item => (
          <span
            key={item.id}
            aria-hidden="true"
            className="termdock-tap-fade pointer-events-none absolute h-4 w-4 rounded-full bg-primary"
            style={{ left: item.left, top: item.top }}
          />
        ))}
        {!streaming && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-[11px] text-muted-foreground">
            {mirrorState === 'connecting' && <><Loader2 size={18} className="animate-spin" /><span>{t('android.connecting')}</span></>}
            {mirrorState === 'error' && (
              <>
                <Circle size={14} className="text-destructive" />
                <span className="max-w-[80%] text-destructive">
                  {retryScheduled ? t('android.reconnecting') : androidErrorText(mirrorError || '')}
                </span>
                {selectedSerial && (
                  <button
                    type="button"
                    onClick={() => { retryAttempt.current = 0; connect(selectedSerial); }}
                    className="rounded bg-surface-2 px-2 py-1 text-foreground"
                  >
                    {t('android.retry')}
                  </button>
                )}
              </>
            )}
            {mirrorState === 'idle' && !adbMissing && !scrcpyMissing && (
              <>
                <MonitorSmartphone size={22} className="opacity-60" />
                <span>{devices.length ? t('android.idleHint') : t('android.noDevicesHint')}</span>
              </>
            )}
          </div>
        )}
      </div>

      <div className={`flex flex-wrap items-center gap-1 border-t border-border ${compact ? 'px-1.5 py-0.5' : 'px-2 py-1.5'}`}>
        <ToolButton compact={compact} label={t('android.back')} onClick={() => controllerRef.current?.back()} disabled={!streaming}><ArrowLeft size={14} /></ToolButton>
        <ToolButton compact={compact} label={t('android.home')} onClick={() => controllerRef.current?.home()} disabled={!streaming}><Home size={14} /></ToolButton>
        <ToolButton compact={compact} label={t('android.recents')} onClick={() => controllerRef.current?.recents()} disabled={!streaming}><Layers size={14} /></ToolButton>
        <ToolButton compact={compact} label={t('android.notifications')} onClick={() => controllerRef.current?.expandNotifications()} disabled={!streaming}><Bell size={14} /></ToolButton>
        <ToolButton compact={compact} label={t('android.rotate')} onClick={() => controllerRef.current?.rotate()} disabled={!streaming}><RotateCw size={14} /></ToolButton>
        <ToolButton compact={compact} label={t('android.volumeDown')} onClick={() => controllerRef.current?.volumeDown()} disabled={!streaming}><Volume1 size={14} /></ToolButton>
        <ToolButton compact={compact} label={t('android.volumeUp')} onClick={() => controllerRef.current?.volumeUp()} disabled={!streaming}><Volume2 size={14} /></ToolButton>
        <ToolButton compact={compact} label={t('android.power')} onClick={() => controllerRef.current?.power()} disabled={!streaming}><Power size={14} /></ToolButton>
        <ToolButton compact={compact} label={t('android.inputText')} active={textMode} onClick={() => setTextMode(value => !value)} disabled={!streaming}><Keyboard size={14} /></ToolButton>
        {/* 缩放改的是本地视图，不往设备注入任何东西。 */}
        <ToolButton compact={compact} label={t('android.zoomIn')} onClick={() => zoomByStep('in')} disabled={!streaming || zoom >= ZOOM_MAX - 0.01}><Plus size={14} /></ToolButton>
        <ToolButton compact={compact} label={t('android.zoomOut')} onClick={() => zoomByStep('out')} disabled={!streaming || zoom <= ZOOM_MIN + 0.01}><Minus size={14} /></ToolButton>
        {/* 实时统计收进更多菜单；底栏仅为缩放和录屏状态保留固定的小块空间。 */}
        <div className="relative ml-auto h-5 w-24 min-w-0 max-w-full shrink-0" data-mirror-capture-status>
          <span aria-hidden={recording || Boolean(captureStatus) || captureBusy}
            className={`block truncate text-right text-[10px] leading-5 tabular-nums text-muted-foreground ${recording || captureStatus || captureBusy ? 'invisible' : ''}`}>
            {header ? (
              <>
                {/* 内容由 applyViewTransform 直接写，免得捏合时为了这行字重渲染整个面板。 */}
                <span ref={zoomLabelRef} />
              </>
            ) : ''}
          </span>
          <div className="absolute inset-0 flex items-center justify-end overflow-hidden">
            <CaptureStatusBadge
              recording={recording}
              elapsed={recordingElapsed}
              status={captureBusy ? t('android.captureInserting') : captureStatus}
              stopLabel={t('android.recordingStop')}
              onStop={() => void stopRecording('manual')}
            />
          </div>
        </div>
      </div>

      {textMode && (
        <div className="flex items-center gap-1.5 border-t border-border px-2 py-1.5">
          <input
            value={textDraft}
            onChange={event => setTextDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); sendText(); } }}
            placeholder={t('android.inputPlaceholder')}
            className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-[11px] outline-none placeholder:text-muted-foreground"
            autoFocus
          />
          <button type="button" onClick={sendText} disabled={!textDraft} className="rounded bg-surface-2 p-1.5 text-primary disabled:opacity-40" title={t('android.send')}>
            <Send size={13} />
          </button>
        </div>
      )}
    </div>
  );

  // 全屏：同一实例 portal 到视口，不重挂也不重连。
  if (overlay === 'window') {
    return createPortal(
      <div className="fixed inset-0 z-modal-panel flex flex-col bg-[var(--chrome-bg)]"
        style={{
          paddingTop: 'var(--safe-top-inset, env(safe-area-inset-top, 0px))',
          paddingBottom: 'var(--safe-bottom-inset, env(safe-area-inset-bottom, 0px))',
        }}>
        {body}
      </div>,
      document.body,
    );
  }
  // 'sidebar' 模式：侧栏自身隐藏头部让面板铺满，这里照常内联渲染。
  if (dockOnly) return docked && dockHost ? createPortal(body, dockHost) : null;
  if (docked && dockHost) {
    return (
      <>
        {createPortal(body, dockHost)}
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-[11px] text-muted-foreground">
          <Columns2 size={18} className="opacity-60" />
          <span>{t('android.splitDockedHint')}</span>
          <button
            type="button"
            onClick={() => { setDock(DOCK_GROUP, null); persistAndroidPanel({ docked: null }); }}
            className="rounded bg-surface-2 px-2 py-1 text-foreground"
          >
            {t('android.splitClose')}
          </button>
        </div>
      </>
    );
  }
  return body;
}

/** 底部常驻行右侧的状态位：录屏时显示计时+停止，否则短暂显示插入结果。
 * 两者共用一个位置还有一层原因——它们并列就会被挤到第二行，反而把画面顶矮。 */
/** ⋯ 菜单里的一项：图标 + 文案，当前生效的模式用主色和勾标出来。 */
function MirrorMenuItem({ icon, label, active = false, disabled = false, onSelect }: {
  icon: ReactNode; label: string; active?: boolean; disabled?: boolean; onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent ${active ? 'text-primary' : 'text-foreground'}`}
    >
      <span aria-hidden="true" className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check size={12} className="shrink-0" />}
    </button>
  );
}

function CaptureStatusBadge({ recording, elapsed, status, stopLabel, onStop }: {
  recording: boolean; elapsed: number; status: string | null; stopLabel: string; onStop: () => void;
}) {
  if (recording) {
    return (
      <span
        role="status"
        aria-live="polite"
        className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] tabular-nums text-destructive"
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-destructive" />
        {formatRecordingElapsed(elapsed)}
        {/* 工具栏里已有同名按钮，这里带上时长以便区分（也顺带说明停掉的是哪一段）。 */}
        <button
          type="button"
          onClick={onStop}
          title={stopLabel}
          aria-label={`${stopLabel} · ${formatRecordingElapsed(elapsed)}`}
          className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-destructive/25"
        >
          <Square size={8} fill="currentColor" />
        </button>
      </span>
    );
  }
  if (!status) return null;
  return <span role="status" aria-live="polite" title={status} className="ml-auto truncate text-[10px] text-primary">{status}</span>;
}

/** 分屏模式下由 App 顶层持有投屏实例，关闭侧栏不会中断分屏。 */
export function AndroidMirrorDock({ sessionId }: { sessionId?: string | null }) {
  const docked = useCollaborationPanelDock(state => Boolean(state.docks[ANDROID_DOCK_GROUP]));
  const hostReady = useCollaborationPanelDock(state => Boolean(state.hosts[ANDROID_DOCK_GROUP]));
  const restored = useRef(false);
  // 刷新后从服务端恢复上次的 dock 位置，效果与 agent 面板一致。
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void getSettings().then(settings => {
      const saved = settings.androidPanel?.docked;
      if (!saved) return;
      if (!useCollaborationPanelDock.getState().docks[ANDROID_DOCK_GROUP]) {
        useCollaborationPanelDock.getState().setDock(ANDROID_DOCK_GROUP, saved);
      }
    }).catch(() => { /* 读取失败则不恢复分屏 */ });
  }, []);
  if (!docked || !hostReady) return null;
  return <AndroidMirrorView sessionId={sessionId} dockOnly />;
}

/** 环境不满足时：把可执行的修复步骤作为提示词插到当前会话，交给终端里的 Agent 处理。 */
function DependencyFixButton({ label, onClick, enabled }: { label: string; onClick: () => void; enabled: boolean }) {
  if (!enabled) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] text-foreground hover:bg-surface-elevated"
    >
      {label}
    </button>
  );
}

function buildAndroidFixPrompt(kind: 'adb' | 'scrcpy', detail: string): string {
  const what = kind === 'adb' ? 'adb（Android platform-tools）' : 'scrcpy / scrcpy-server';
  return [
    `Termdock 的“设备投屏”在当前服务端不可用：未找到 ${what}${detail ? `（错误：${detail}）` : ''}。`,
    '请在本机安装并让 Termdock 恢复可用：',
    '1) 安装依赖：',
    '   - macOS: brew install android-platform-tools scrcpy',
    '   - Ubuntu/Debian: sudo apt install adb scrcpy',
    '   - Windows: winget install Google.PlatformTools && winget install Genymobile.scrcpy',
    '2) 若不在 PATH，请在 ~/.termdock/.env 指定 TERMDOCK_ADB_BIN / TERMDOCK_SCRCPY_BIN / TERMDOCK_SCRCPY_SERVER。',
    '3) 完成后重启 Termdock 服务，并用 adb version、scrcpy --version 验证。',
    '边界：只做本机环境安装与配置，不要改动 Termdock 仓库代码。',
  ].join('\n');
}

function QualitySlider({ label, display, min, max, step, value, onChange }: {
  label: string; display: string; min: number; max: number; step: number; value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        className="h-1 min-w-0 flex-1 accent-primary"
        aria-label={label}
      />
      <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{display}</span>
    </div>
  );
}

function ToolButton({ label, onClick, disabled, active, compact, children }: {
  label: string; onClick: () => void; disabled?: boolean; active?: boolean; compact?: boolean; children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`${compact ? 'inline-flex h-5 w-5 items-center justify-center' : 'p-1.5'} rounded transition active:scale-95 disabled:opacity-30 ${active ? 'bg-surface-elevated text-primary' : 'text-muted-foreground hover:bg-surface-2'}`}
    >
      {children}
    </button>
  );
}

/** 指针位置转为 canvas 父容器的本地坐标（涟漪/拖动轨迹都用这个坐标系）。 */
function toLocalPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): { left: number; top: number } | null {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const canvasRect = canvas.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  return {
    left: canvasRect.left - parentRect.left + (clientX - canvasRect.left),
    top: canvasRect.top - parentRect.top + (clientY - canvasRect.top),
  };
}

function toDevicePoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const width = canvas.width || rect.width;
  const height = canvas.height || rect.height;
  const x = rect.width ? ((clientX - rect.left) / rect.width) * width : 0;
  const y = rect.height ? ((clientY - rect.top) / rect.height) * height : 0;
  return { x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y)) };
}

/** 缺依赖、无权限、解码器不可用等错误重试也不会好，避免无限重连。 */
function isRetryableMirrorError(message: string): boolean {
  if (/ADB_NOT_FOUND|SCRCPY_NOT_FOUND|SCRCPY_SERVER_NOT_FOUND|SCRCPY_VERSION_UNKNOWN|SCRCPY_UNSUPPORTED_CODEC|VIDEO_DECODER_UNSUPPORTED|decoder|decode/i.test(message)) return false;
  if (/INVALID_SERIAL|INVALID_ADDRESS|API_NOT_ALLOWED|AUTHORIZATION_DENIED/i.test(message)) return false;
  return true;
}

function deviceStateSuffix(device: AndroidDevice, t: (key: TranslationKey) => string): string {
  if (device.state === 'device') return device.androidVersion ? ` · Android ${device.androidVersion}` : '';
  if (device.state === 'unauthorized') return ` · ${t('android.stateUnauthorized')}`;
  if (device.state === 'offline') return ` · ${t('android.stateOffline')}`;
  return ` · ${t('android.stateUnknown')}`;
}

function deviceStateHint(device: AndroidDevice, t: (key: TranslationKey) => string): string {
  if (device.state === 'unauthorized') return t('android.unauthorizedHint');
  if (device.state === 'offline') return t('android.offlineHint');
  return t('android.stateUnknown');
}
