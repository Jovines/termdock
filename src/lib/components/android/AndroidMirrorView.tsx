import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, Bell, ChevronDown, Circle, Home, Keyboard, Layers, Loader2, Maximize2,
  MonitorSmartphone, PanelRight, Plug, Power, RefreshCw, RotateCw, Send, Smartphone, Unplug, Volume1, Volume2,
} from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import { useMultiSessionStore } from '../../stores/useMultiSessionStore';
import { useCollaborationPanelDock } from '../../stores/useCollaborationPanelDock';
import { AndroidMirrorController, type MirrorHeader, type MirrorState, type MirrorStats } from '../../android/mirrorController';
import { getSettings, updateSettings } from '../../terminal/api';
import {
  ANDROID_QUALITY_PRESETS, DEFAULT_ANDROID_QUALITY, androidErrorText, connectAndroidDevice, listAndroidDevices,
  normalizeAndroidQuality, type AndroidDevice, type AndroidDeviceList, type AndroidQuality, type AndroidQualityId,
} from '../../android/api';
import type { AndroidSavedPresetState } from '../../terminal/api';

export const ANDROID_DOCK_GROUP = 'android-mirror';
const DOCK_GROUP = ANDROID_DOCK_GROUP;
const QUALITY_STORAGE_KEY = 'termdock:android:quality:v1';
const QUALITY_LABEL: Record<AndroidQualityId, TranslationKey> = {
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

export function AndroidMirrorView({ sessionId, dockOnly = false }: { sessionId?: string | null; dockOnly?: boolean }) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<AndroidMirrorController | null>(null);
  const initialQuality = useMemo<AndroidQuality>(readStoredQuality, []);
  const qualityRef = useRef<AndroidQuality>(initialQuality);
  const activePointer = useRef<{ id: number; type: string } | null>(null);
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
  const [custom, setCustom] = useState({
    maxSize: initialQuality.maxSize,
    bitRate: initialQuality.bitRate,
    maxFps: initialQuality.maxFps,
  });
  const [mirrorState, setMirrorState] = useState<MirrorState>('idle');
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const [header, setHeader] = useState<MirrorHeader | null>(null);
  const [stats, setStats] = useState<MirrorStats>({ fps: 0, kbps: 0, width: 0, height: 0, received: 0, decoded: 0, controls: 0, last: '' });
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

  const disconnect = useCallback(() => {
    controllerRef.current?.disconnect();
    controllerRef.current = null;
    setMirrorState('idle');
    setMirrorError(null);
    setHeader(null);
  }, []);

  const connect = useCallback((serial: string) => {
    const canvas = canvasRef.current;
    if (!canvas || !serial) return;
    controllerRef.current?.disconnect();
    setMirrorError(null);
    setHeader(null);
    setWarning(null);
    const controller = new AndroidMirrorController(canvas, {
      onState: (state, error) => { setMirrorState(state); setMirrorError(error ?? null); },
      onHeader: next => setHeader(next),
      onStats: next => setStats(next),
      onWarning: message => setWarning(message),
    });
    controllerRef.current = controller;
    controller.connect(serial, qualityRef.current);
  }, []);

  // 偏好存服务端，换浏览器/设备也一致；localStorage 只作为首屏的即时初值。
  const persistAndroidPanel = useCallback((patch: {
    quality?: AndroidQuality;
    activePresetId?: string | null;
    presets?: AndroidSavedPresetState[];
    deviceSerial?: string | null;
  }) => {
    const payload = {
      ...(patch.quality ? { quality: { id: patch.quality.id, maxSize: patch.quality.maxSize, bitRate: patch.quality.bitRate, maxFps: patch.quality.maxFps } } : {}),
      ...(patch.activePresetId !== undefined ? { activePresetId: patch.activePresetId } : {}),
      ...(patch.presets !== undefined ? { presets: patch.presets } : {}),
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

  const changeQuality = useCallback((id: string) => {
    // 用户保存的预设以 user:<id> 表示，值等同于自定义。
    if (id.startsWith('user:')) {
      const preset = presets.find(item => item.id === id.slice(5));
      if (!preset) return;
      const next: AndroidQuality = { id: 'custom', maxSize: preset.maxSize, bitRate: preset.bitRate, maxFps: preset.maxFps };
      qualityRef.current = next;
      setQualityId('custom');
      setActivePresetId(preset.id);
      setCustom({ maxSize: preset.maxSize, bitRate: preset.bitRate, maxFps: preset.maxFps });
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
      return;
    }
    const preset = ANDROID_QUALITY_PRESETS.find(item => item.id === id) ?? DEFAULT_ANDROID_QUALITY;
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
    if (selectedSerial) connect(selectedSerial);
  }, [connect, selectedSerial, custom, persistAndroidPanel]);

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
    if (selectedSerial) connect(selectedSerial);
  }, [presetName, custom, presets, selectedSerial, connect, persistAndroidPanel]);

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      const controller = controllerRef.current;
      if (!controller) return;
      event.preventDefault();
      const point = toDevicePoint(canvas, event.clientX, event.clientY);
      controller.scroll(point.x, point.y, event.deltaX, event.deltaY);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

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
    canvas.setPointerCapture?.(event.pointerId);
    activePointer.current = { id: event.pointerId, type: event.pointerType };
    const point = toDevicePoint(canvas, event.clientX, event.clientY);
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
    if (!controller || !canvas || activePointer.current?.id !== event.pointerId) return;
    event.preventDefault();
    const point = toDevicePoint(canvas, event.clientX, event.clientY);
    controller.pointerMove(point.x, point.y, activePointer.current.type);
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
    if (!controller || !canvas || activePointer.current?.id !== event.pointerId) return;
    const point = toDevicePoint(canvas, event.clientX, event.clientY);
    controller.pointerUp(point.x, point.y, activePointer.current.type);
    if (press) addFadingDot(press);
    setPress(null);
    // 松手后拖尾淡出，再清空。
    setDragging(false);
    window.setTimeout(() => setTrail([]), 200);
    activePointer.current = null;
    gestureStart.current = null;
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
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

  const streaming = mirrorState === 'streaming';

  const body = (
    <div
      className="flex h-full min-h-0 flex-col bg-surface text-foreground"
      data-sidebar-gesture-ignore="true"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-2">
        <Smartphone size={14} className="shrink-0 text-muted-foreground" />
        <select
          value={selectedSerial}
          onChange={event => {
            const serial = event.target.value;
            setSelectedSerial(serial);
            autoConnected.current = serial;
            if (serial) persistAndroidPanel({ deviceSerial: serial });
          }}
          className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-[11px] text-foreground outline-none"
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
          className="shrink-0 rounded bg-surface-2 px-1.5 py-1 text-[11px] text-foreground outline-none"
          title={t('android.quality')}
          aria-label={t('android.quality')}
        >
          {ANDROID_QUALITY_PRESETS.map(preset => (
            <option key={preset.id} value={preset.id}>{t(QUALITY_LABEL[preset.id])}</option>
          ))}
          {presets.map(preset => (
            <option key={preset.id} value={`user:${preset.id}`}>{preset.name}</option>
          ))}
          <option value="custom">{t(QUALITY_LABEL.custom)}</option>
        </select>
        <button type="button" onClick={() => void refreshDevices()} className="rounded p-1.5 text-muted-foreground hover:bg-surface-2" title={t('android.refresh')}>
          {loadingList ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
        {streaming ? (
          <button type="button" onClick={disconnect} className="rounded p-1.5 text-destructive hover:bg-surface-2" title={t('android.disconnect')}>
            <Unplug size={13} />
          </button>
        ) : (
          <button type="button" onClick={() => selectedSerial && connect(selectedSerial)} disabled={!selectedSerial} className="rounded p-1.5 text-primary hover:bg-surface-2 disabled:opacity-40" title={t('android.connect')}>
            <Plug size={13} />
          </button>
        )}
        <button type="button" onClick={() => setShowAddress(value => !value)} className="rounded p-1.5 text-muted-foreground hover:bg-surface-2" title={t('android.addDevice')}>
          <ChevronDown size={13} />
        </button>
        <button
          type="button"
          onClick={() => { if (activeSessionId) setDock(DOCK_GROUP, docked ? null : { sessionId: activeSessionId, side: 'right' }); }}
          disabled={!activeSessionId}
          className={`rounded p-1.5 hover:bg-surface-2 disabled:opacity-40 ${docked ? 'text-primary' : 'text-muted-foreground'}`}
          title={docked ? t('android.splitClose') : t('android.splitOpen')}
        >
          <PanelRight size={13} />
        </button>
      </div>

      {(qualityId === 'custom' || activePresetId) && (
        <div className="grid gap-2 border-b border-border bg-surface-2/40 px-2 py-2 text-[11px]">
          <QualitySlider
            label={t('android.qualityResolution')}
            display={`${custom.maxSize}p`}
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
        <div className="border-b border-border bg-surface-2 px-2 py-1.5 text-[11px] text-destructive">{t('android.adbUnavailable')}</div>
      )}
      {!adbMissing && scrcpyMissing && (
        <div className="border-b border-border bg-surface-2 px-2 py-1.5 text-[11px] text-warning">{t('android.scrcpyUnavailable')}</div>
      )}
      {connectedDevice && connectedDevice.state !== 'device' && (
        <div className="border-b border-border bg-surface-2 px-2 py-1.5 text-[11px] text-warning">{deviceStateHint(connectedDevice, t)}</div>
      )}
      {listError && !adbMissing && <div className="border-b border-border bg-surface-2 px-2 py-1.5 text-[11px] text-destructive">{androidErrorText(listError)}</div>}
      {warning && <div className="border-b border-border bg-surface-2 px-2 py-1.5 text-[11px] text-warning">{warning}</div>}

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--chrome-bg)] p-1">
        <canvas
          ref={canvasRef}
          className="max-h-full max-w-full touch-none select-none rounded"
          style={{ display: streaming || header ? 'block' : 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
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

      <div className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
        <ToolButton label={t('android.back')} onClick={() => controllerRef.current?.back()} disabled={!streaming}><ArrowLeft size={14} /></ToolButton>
        <ToolButton label={t('android.home')} onClick={() => controllerRef.current?.home()} disabled={!streaming}><Home size={14} /></ToolButton>
        <ToolButton label={t('android.recents')} onClick={() => controllerRef.current?.recents()} disabled={!streaming}><Layers size={14} /></ToolButton>
        <ToolButton label={t('android.notifications')} onClick={() => controllerRef.current?.expandNotifications()} disabled={!streaming}><Bell size={14} /></ToolButton>
        <ToolButton label={t('android.rotate')} onClick={() => controllerRef.current?.rotate()} disabled={!streaming}><RotateCw size={14} /></ToolButton>
        <ToolButton label={t('android.volumeDown')} onClick={() => controllerRef.current?.volumeDown()} disabled={!streaming}><Volume1 size={14} /></ToolButton>
        <ToolButton label={t('android.volumeUp')} onClick={() => controllerRef.current?.volumeUp()} disabled={!streaming}><Volume2 size={14} /></ToolButton>
        <ToolButton label={t('android.power')} onClick={() => controllerRef.current?.power()} disabled={!streaming}><Power size={14} /></ToolButton>
        <ToolButton label={t('android.inputText')} active={textMode} onClick={() => setTextMode(value => !value)} disabled={!streaming}><Keyboard size={14} /></ToolButton>
        <span className="ml-auto whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
          {header ? `${stats.fps} fps · ${stats.kbps} kbps · ${stats.width}×${stats.height}` : ''}
        </span>
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

  if (docked && dockHost) {
    // dockOnly 由 App 顶层持有，只负责把内容投进分屏宿主。
    if (dockOnly) return createPortal(body, dockHost);
    return (
      <>
        {createPortal(body, dockHost)}
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-[11px] text-muted-foreground">
          <Maximize2 size={18} className="opacity-60" />
          <span>{t('android.splitDockedHint')}</span>
          <button type="button" onClick={() => setDock(DOCK_GROUP, null)} className="rounded bg-surface-2 px-2 py-1 text-foreground">{t('android.splitClose')}</button>
        </div>
      </>
    );
  }
  return body;
}

/** 分屏模式下由 App 顶层持有投屏实例，关闭侧栏不会中断分屏。 */
export function AndroidMirrorDock({ sessionId }: { sessionId?: string | null }) {
  const docked = useCollaborationPanelDock(state => Boolean(state.docks[ANDROID_DOCK_GROUP]));
  if (!docked) return null;
  return <AndroidMirrorView sessionId={sessionId} dockOnly />;
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

function ToolButton({ label, onClick, disabled, active, children }: {
  label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`rounded p-1.5 transition active:scale-95 disabled:opacity-30 ${active ? 'bg-surface-elevated text-primary' : 'text-muted-foreground hover:bg-surface-2'}`}
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
