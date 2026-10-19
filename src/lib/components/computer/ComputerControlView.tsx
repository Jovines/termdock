import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Monitor, Maximize2, Unplug, Loader2, MousePointer2, Settings2, Keyboard, Clipboard, X, ChevronLeft, ZoomIn, ZoomOut } from 'lucide-react';
import type RFB from '@novnc/novnc';
import { useComputerPreferences } from '../../computer/useComputerPreferences';
import { computerLoginKey, type ComputerProfile } from '../../computer/preferences';
import type { RdpSession } from '../../computer/rdpSession';
import { useI18n, type TranslationKey } from '../../i18n';
import { savedConnection, SECURE_STATE_EVENT } from '../../federation/browserIntegration';
import { SecureVncChannel } from '../../computer/secureVncChannel';
import { computerShortcuts, isComputerPlatform } from '../../computer/platform';
import { vncPointer } from '../../computer/pointer';
import { attachComputerTouchpad, readComputerTouchMode, saveComputerTouchMode, type ComputerTouchMode, type TouchpadPosition } from '../../computer/touchpad';
import { isWorkspaceActive, WORKSPACE_VISIBILITY_EVENT } from '../../services/workspaceHost';
import { computerDesktopSize } from '../../computer/viewport';
import ComputerKeyboardInput from './ComputerKeyboardInput';
import { computerKeyQueue, type ComputerKeyEvent } from '../../computer/keyQueue';
import { attachComputerZoom, type ComputerZoom } from '../../computer/zoom';
import { attachVncKeyboard } from '../../computer/vncKeyboard';
import { computerTextKeysyms } from '../../computer/textKeys';
import { attachComputerClipboard, COMPUTER_CLIPBOARD_LIMIT } from '../../computer/clipboard';
import { createComputerMotionTrace } from '../../computer/motionTrace';

type State = 'idle' | 'connecting' | 'credentials' | 'connected' | 'error';
const buttonClass = 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-surface-2 disabled:opacity-40';
const inputClass = 'min-h-11 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary';

function errorKey(reason: string): TranslationKey {
  if (/API_NOT_ALLOWED|AUTHORIZATION|revoked|PAIRING/.test(reason)) return 'computer.permission';
  if (reason.includes('RDP_BACKEND_UNAVAILABLE')) return 'computer.rdpBackendUnavailable';
  if (reason.includes('RDP_CERTIFICATE')) return 'computer.rdpCertificate';
  if (reason.includes('CREDENTIALS_MISSING')) return 'computer.loginExpired';
  if (reason.includes('CREDENTIALS_FAILED')) return 'computer.loginSaveFailed';
  if (reason.includes('AUTH_FAILED')) return 'computer.authFailed';
  if (reason.includes('RDP_FAILED')) return 'computer.rdpFailed';
  if (reason.includes('SCREEN_SHARING_OFF')) return 'computer.sharingOff';
  if (reason.includes('PRIVATE_HOST_ONLY')) return 'computer.privateOnly';
  if (reason.includes('INVALID_HOST')) return 'computer.invalidHost';
  if (reason.includes('TIMEOUT')) return 'computer.timeout';
  if (reason.includes('UNREACHABLE')) return 'computer.unreachable';
  if (reason.includes('DISCONNECTED')) return 'computer.disconnected';
  return 'computer.failed';
}

export default function ComputerControlView() {
  const { t } = useI18n();
  const motionTrace = useMemo(() => createComputerMotionTrace(), []);
  useEffect(() => {
    motionTrace.record('panel-open', { viewport: [window.innerWidth, window.innerHeight], dpr: window.devicePixelRatio });
    motionTrace.flush('panel-open');
    return () => motionTrace.flush('panel-unmounted');
  }, [motionTrace]);
  const [serviceId, setServiceId] = useState(() => savedConnection()?.targetPeerId ?? '');
  const [service, setService] = useState<{ platform: string; hostname: string; rdpAvailable?: boolean } | null>(null);
  const { preferences, change, loaded, saveState, flush, retry, credentialKeys, loginState, credentialRequest } = useComputerPreferences(serviceId);
  const localTarget = preferences.target === 'local';
  const profile = preferences[preferences.target];
  const { host, platform, protocol, port, domain, ignoreCert, username } = profile;
  const rdpBackendUnavailable = protocol === 'rdp' && service?.rdpAvailable === false;
  const { viewOnly, fit } = preferences;
  const hasSavedLogin = profile.rememberLogin && credentialKeys.includes(computerLoginKey(profile));
  const updateProfile = (patch: Partial<ComputerProfile>) => change(value => ({ ...value, [value.target]: { ...value[value.target], ...patch } }));
  const setUsername = (username: string) => updateProfile({ username });
  const setDomain = (domain: string) => updateProfile({ domain });
  const setIgnoreCert = (ignoreCert: boolean) => { updateProfile({ ignoreCert }); void flush(); };
  const setPort = (port: string) => updateProfile({ port });
  const setViewOnly = (viewOnly: boolean) => { if (viewOnly) { releaseTouchpad.current(); keyQueue.clear(); setPanel(null); } change(value => ({ ...value, viewOnly })); void flush(); };
  const [advanced, setAdvanced] = useState(false);
  const shortcuts = computerShortcuts(platform);
  const pasteLabel = platform === 'mac' ? '⌘V' : 'Ctrl+V';
  const [password, setPassword] = useState('');
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<TranslationKey | null>(null);
  const [desktopName, setDesktopName] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<'tools' | 'clipboard' | 'keyboard' | null>(null);
  const keyboardInputRef = useRef<HTMLInputElement>(null);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const keyboardFullHeight = useRef(0);
  const [touchDevice, setTouchDevice] = useState(() => navigator.maxTouchPoints > 0 || window.innerWidth <= 640);
  useEffect(() => {
    const update = () => setTouchDevice(navigator.maxTouchPoints > 0 || window.innerWidth <= 640);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const keyboardActive = panel === 'keyboard' && keyboardFocused && (!touchDevice || !window.visualViewport || keyboardVisible);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef<ComputerZoom | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [clipboardSent, setClipboardSent] = useState(false);
  const [remoteClipboard, setRemoteClipboard] = useState<string | null>(null);
  const [clipboardError, setClipboardError] = useState(false);
  const [clipboardCopied, setClipboardCopied] = useState(false);
  const [authNeedsUsername, setAuthNeedsUsername] = useState(false);
  const [touchMode, setTouchMode] = useState(readComputerTouchMode);
  const cursorRef = useRef<HTMLDivElement>(null);
  const pointerPosition = useRef<TouchpadPosition | null>(null);
  const releaseTouchpad = useRef<() => void>(() => {});
  const releaseKeyboard = useRef<() => void>(() => {});
  const [visible, setVisible] = useState(isWorkspaceActive);
  const autoAttempt = useRef(false);
  const loginPassword = useRef('');
  const connectRef = useRef<() => void>(() => {});
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  // This element stays stable when the panel moves into its expanded portal.
  const screen = useMemo(() => {
    const element = document.createElement('div');
    element.className = 'h-full w-full min-h-0 overflow-hidden';
    return element;
  }, []);
  const rfbRef = useRef<RFB | RdpSession | null>(null);
  const inputEnabled = useRef(false); inputEnabled.current = state === 'connected' && !viewOnly;
  const keyQueue = useMemo(() => computerKeyQueue(([key, code, down]) => rfbRef.current?.sendKey(key, code, down)), []);
  const channelRef = useRef<SecureVncChannel | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dispose = useCallback(() => {
    releaseTouchpad.current(); releaseKeyboard.current();
    zoomRef.current?.dispose(); zoomRef.current = null;
    keyQueue.clear();
    pointerPosition.current = null;
    generation.current++;
    clearTimeout(timer.current);
    const rfb = rfbRef.current;
    rfbRef.current = null;
    rfb?.disconnect();
    channelRef.current?.close();
    channelRef.current = null;
    screen.replaceChildren();
  }, [screen, keyQueue]);

  useLayoutEffect(() => {
    mountRef.current?.appendChild(screen);
    return () => { screen.remove(); };
  }, [screen, expanded]);
  useEffect(() => () => dispose(), [dispose]);
  useEffect(() => {
    const hidden = () => {
      const active = isWorkspaceActive(); setVisible(active);
      if (active) return;
      autoAttempt.current = false; loginPassword.current = '';
      dispose(); setState('idle'); setPassword(''); setExpanded(false); setPanel(null);
    };
    window.addEventListener(WORKSPACE_VISIBILITY_EVENT, hidden);
    return () => window.removeEventListener(WORKSPACE_VISIBILITY_EVENT, hidden);
  }, [dispose]);
  useEffect(() => {
    const update = () => setServiceId(savedConnection()?.targetPeerId ?? '');
    window.addEventListener(SECURE_STATE_EVENT, update);
    return () => window.removeEventListener(SECURE_STATE_EVENT, update);
  }, []);
  useEffect(() => {
    dispose();
    autoAttempt.current = false; loginPassword.current = '';
    setState('idle'); setError(null); setPassword(''); setService(null);
    setExpanded(false); setPanel(null); setAdvanced(false); setDesktopName(''); setText(''); setClipboardSent(false);
    const abort = new AbortController();
    void fetch('/api/computer/status', { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error(response.status === 403 ? 'API_NOT_ALLOWED' : 'COMPUTER_FAILED');
      return await response.json() as { platform: string; hostname: string; rdpAvailable?: boolean };
    }).then(info => {
      if (abort.signal.aborted) return;
      setService(info);
    }).catch(reason => { if (!abort.signal.aborted) setError(errorKey(String(reason))); });
    return () => { abort.abort(); dispose(); };
  }, [serviceId, dispose]);
  useEffect(() => { if (viewOnly) releaseKeyboard.current(); if (rfbRef.current) rfbRef.current.viewOnly = viewOnly; }, [viewOnly]);
  useEffect(() => { if (rfbRef.current) rfbRef.current.scaleViewport = fit; }, [fit]);
  useEffect(() => { if (rfbRef.current && 'pauseResize' in rfbRef.current) rfbRef.current.pauseResize = Boolean(panel); }, [panel]);
  useEffect(() => {
    const session = rfbRef.current;
    if (!session) return;
    if ('keyboardActive' in session) session.keyboardActive = panel === 'keyboard';
    else session.focusOnClick = panel !== 'keyboard';
  }, [panel]);

  const chooseTarget = (local: boolean) => {
    if (local === localTarget || busy || !loaded) return;
    setPassword(''); setError(null);
    change(value => ({ ...value, target: local ? 'local' : 'remote' })); void flush();
  };
  const disconnect = () => {
    autoAttempt.current = true; loginPassword.current = '';
    dispose(); setState('idle'); setPassword(''); setExpanded(false); setPanel(null); setClipboardSent(false);
  };
  const connect = async (event?: FormEvent) => {
    event?.preventDefault();
    if (rdpBackendUnavailable) return;
    autoAttempt.current = true;
    if (state === 'credentials' && rfbRef.current && 'sendCredentials' in rfbRef.current) {
      loginPassword.current = password;
      rfbRef.current.sendCredentials({ username, password });
      setState('connecting'); return;
    }
    if (!isWorkspaceActive() || !loaded || (!password && !hasSavedLogin)) return;
    void flush();
    setRemoteClipboard(null); setClipboardError(false); setClipboardCopied(false);
    dispose(); setError(null); setDesktopName(''); setState('connecting'); setClipboardSent(false);
    const attempt = generation.current;
    const fail = (key: TranslationKey) => {
      if (attempt !== generation.current) return;
      dispose(); setState('error'); setError(key); setPanel(null);
      loginPassword.current = '';
      if (key === 'computer.authFailed' || key === 'computer.permission' || key === 'computer.loginExpired') setPassword('');
      if (hasSavedLogin && (key === 'computer.authFailed' || key === 'computer.loginExpired')) void credentialRequest('forget', profile).catch(() => {});
    };
    timer.current = setTimeout(() => fail('computer.timeout'), 60_000);
    try {
      let secret = password || await credentialRequest('use', profile);
      if (attempt !== generation.current) return;
      loginPassword.current = secret || '';
      let rfb: RFB | RdpSession;
      if (protocol === 'rdp') {
        const { RdpSession } = await import('../../computer/rdpSession');
        if (attempt !== generation.current) return;
        // Commit the final controls and safe areas before the
        // handshake. Guessing innerHeight - 100 made XRDP resize again on login.
        (document.activeElement as HTMLElement | null)?.blur?.();
        flushSync(() => { setState('connecting'); });
        const bounds = mountRef.current?.getBoundingClientRect();
        const initialSize = computerDesktopSize(bounds?.width || 1280, bounds?.height || 800);
        rfb = new RdpSession(screen, { host: host.trim(), port: Number(port), username: username.trim(), password: secret || '',
          domain: domain.trim(), ignoreCert, ...initialSize }, reason => fail(errorKey(reason)), motionTrace);
      } else {
        const { default: Vnc } = await import('@novnc/novnc');
        if (attempt !== generation.current) return;
        const channel = new SecureVncChannel(host.trim(), reason => fail(errorKey(reason)));
        channelRef.current = channel;
        const vnc = new Vnc(screen, channel, { shared: true, credentials: { username: username.trim() || undefined, password: secret } });
        vnc.background = 'var(--chrome-bg)'; vnc.resizeSession = false;
        vnc.qualityLevel = 6; vnc.compressionLevel = 2;
        rfb = vnc;
      }
      secret = undefined;
      rfbRef.current = rfb;
      rfb.scaleViewport = fit; rfb.viewOnly = viewOnly;
      rfb.addEventListener('connect', () => {
        if (attempt !== generation.current) return;
        clearTimeout(timer.current);
        setState('connected'); setPassword('');
        if (window.innerWidth <= 640) {
          (document.activeElement as HTMLElement | null)?.blur?.();
        }
        const successfulPassword = loginPassword.current; loginPassword.current = '';
        if (profile.rememberLogin && successfulPassword) void credentialRequest('save', profile, successfulPassword).catch(() => {});
      });
      rfb.addEventListener('credentialsrequired', event => {
        if (attempt !== generation.current) return;
        const types = (event as CustomEvent<{ types: string[] }>).detail.types;
        setAuthNeedsUsername(types.includes('username'));
        setState('credentials');
      });
      rfb.addEventListener('securityfailure', () => fail('computer.authFailed'));
      rfb.addEventListener('disconnect', () => fail('computer.disconnected'));
      rfb.addEventListener('desktopname', event => {
        if (attempt === generation.current) setDesktopName((event as CustomEvent<{ name: string }>).detail.name);
      });
    } catch (reason) { fail(errorKey(String(reason))); }
  };
  const sendKeys = (keys: Array<[number, string]>) => {
    const rfb = rfbRef.current;
    if (!rfb || state !== 'connected' || viewOnly) return;
    if (panel === 'keyboard') keyboardInputRef.current?.focus({ preventScroll: true });
    else if (panel !== 'clipboard' && !touchDevice) rfb.focus?.({ preventScroll: true });
    keyQueue.send([...keys.map(([key, code]): ComputerKeyEvent => [key, code, true]), ...[...keys].reverse().map(([key, code]): ComputerKeyEvent => [key, code, false])]);
  };
  const connected = state === 'connected';
  const busy = state === 'connecting' || state === 'credentials';
  const showDesktop = connected || state === 'connecting';
  useEffect(() => {
    const session = rfbRef.current;
    if (!connected || !session) return;
    // noVNC's private scale adapter is installed only on a real renderer.
    if (!('viewportZoom' in session) && !('_display' in session)) return;
    const controller = attachComputerZoom(session, setZoom);
    zoomRef.current = controller; setZoom(1);
    return () => { controller.dispose(); if (zoomRef.current === controller) zoomRef.current = null; };
  }, [connected]);
  useEffect(() => {
    const session = rfbRef.current, viewport = mountRef.current, cursor = cursorRef.current;
    if (!connected || (panel && panel !== 'keyboard') || (touchMode !== 'trackpad' && !(navigator.maxTouchPoints > 0)) || !session || !viewport || !cursor) return;
    const pointer = 'pointerTarget' in session ? session.pointerTarget : vncPointer(session);
    const release = attachComputerTouchpad(viewport, pointer, cursor, pointerPosition, { mode: touchMode, zoom: zoomRef.current ?? undefined, viewOnly, trace: motionTrace });
    releaseTouchpad.current = release;
    return () => { release(); if (releaseTouchpad.current === release) releaseTouchpad.current = () => {}; };
  }, [connected, viewOnly, touchMode, expanded, panel, motionTrace]);
  useEffect(() => {
    const session = rfbRef.current;
    if (!connected || viewOnly || !session) return;
    return attachComputerClipboard(screen, session, {
      paste: (value, shift) => {
        session.clipboardPasteFrom(value);
        sendKeys(shift ? [...shortcuts.paste.slice(0, 1), [0xffe1, 'ShiftLeft'], ...shortcuts.paste.slice(1)] : shortcuts.paste);
        setClipboardSent(true); setClipboardError(false);
      },
      receive: value => { setRemoteClipboard(value); setClipboardCopied(false); },
      failed: () => { setClipboardError(true); setPanel('clipboard'); },
    });
  }, [connected, viewOnly, platform, screen]);
  useEffect(() => {
    const session = rfbRef.current;
    if (!connected || viewOnly || !session || 'pointerTarget' in session || !('_keyboard' in session)) return;
    const release = attachVncKeyboard(session, sendText);
    releaseKeyboard.current = release;
    return () => { release(); if (releaseKeyboard.current === release) releaseKeyboard.current = () => {}; };
  }, [connected, viewOnly]);
  const chooseTouchMode = (mode: ComputerTouchMode) => {
    if (mode === touchMode) return;
    releaseTouchpad.current();
    setTouchMode(mode); saveComputerTouchMode(mode);
  };
  connectRef.current = () => { void connect(); };
  useEffect(() => {
    if (visible && loaded && service && !rdpBackendUnavailable && preferences.autoConnect && hasSavedLogin && state === 'idle' && !autoAttempt.current) connectRef.current();
  }, [visible, loaded, service, rdpBackendUnavailable, preferences.autoConnect, hasSavedLogin, state]);
  const forgetLogin = () => { autoAttempt.current = true; void credentialRequest('forget', profile).catch(() => {}); };
  const togglePanel = (next: 'tools' | 'clipboard' | 'keyboard') => {
    // Safari requires focus while the tap still has user activation. Mount
    // and focus the input synchronously instead of waiting for a passive effect.
    if (next === 'keyboard') {
      if (panel === 'keyboard' && !keyboardActive) {
        // iOS can dismiss its software keyboard while leaving the field focused.
        // A fresh focus within this tap reopens it without closing the input bar.
        keyboardInputRef.current?.blur(); keyboardInputRef.current?.focus({ preventScroll: true }); return;
      }
      releaseTouchpad.current();
      keyboardFullHeight.current = window.visualViewport?.height ?? window.innerHeight;
      flushSync(() => { setKeyboardFocused(false); setKeyboardVisible(false); setPanel(value => value === next ? null : next); });
    }
    else { releaseTouchpad.current(); setPanel(value => value === next ? null : next); }
  };
  const resetZoom = () => { zoomRef.current?.set(1); change(value => ({ ...value, fit: true })); void flush(); };
  const sendText = (value: string) => {
    if (!rfbRef.current || !inputEnabled.current) return;
    const events: ComputerKeyEvent[] = [];
    for (const keysym of computerTextKeysyms(value)) {
      events.push([keysym, null, true], [keysym, null, false]);
    }
    keyQueue.send(events);
  };
  useEffect(() => {
    if (!connected || (panel !== 'keyboard' && panel !== 'clipboard') || !window.visualViewport) return;
    const viewport = window.visualViewport, frame = frameRef.current;
    const update = () => {
      if (panel === 'keyboard') setKeyboardVisible(keyboardFocused && keyboardFullHeight.current - viewport.height > 100);
      if (expanded && frame && viewport.height >= 160) { frame.style.height = `${viewport.height}px`; frame.style.top = `${viewport.offsetTop}px`; }
    };
    update(); viewport.addEventListener('resize', update); viewport.addEventListener('scroll', update);
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); if (frame) { frame.style.height = ''; frame.style.top = ''; } };
  }, [connected, panel, expanded, keyboardFocused]);

  const zoomControls = <div className="flex shrink-0 items-center text-xs" role="group" aria-label={t('computer.desktopZoom')} title={touchDevice ? t('computer.pinchHint') : undefined}>
    <button type="button" className="flex min-h-11 min-w-11 items-center justify-center" aria-label={t('computer.zoomOut')} disabled={!connected || zoom <= 1} onPointerDown={event => event.preventDefault()} onClick={() => zoomRef.current?.set(zoom / 1.25)}><ZoomOut size={16} /></button>
    <button type="button" className="min-h-11 min-w-11" aria-label={t('computer.resetZoom')} disabled={!connected} onPointerDown={event => event.preventDefault()} onClick={resetZoom}>{Math.round(zoom * 100)}%</button>
    <button type="button" className="flex min-h-11 min-w-11 items-center justify-center" aria-label={t('computer.zoomIn')} disabled={!connected || zoom >= 8} onPointerDown={event => event.preventDefault()} onClick={() => zoomRef.current?.set(zoom * 1.25)}><ZoomIn size={16} /></button>
    {touchDevice && <span className="hidden pr-2 text-[10px] text-muted-foreground sm:inline">{t('computer.pinchHint')}</span>}
  </div>;

  // Keep pointer controls compact without shrinking touch targets.
  const toolbarButtonClass = `flex shrink-0 items-center justify-center rounded-md hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${touchDevice ? 'min-h-11 min-w-11' : 'h-8 min-w-8'}`;

  const body = (
    <div ref={frameRef} className={`flex min-h-0 flex-col bg-surface text-foreground ${expanded ? 'fixed inset-0 z-modal-panel h-dvh pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]' : 'relative h-full'}`}
      role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined} aria-label={t('computer.title')}
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && !event.nativeEvent.isComposing && panel) { event.preventDefault(); setPanel(null); } }} onKeyUp={event => event.stopPropagation()}>
      <div className={`relative z-30 flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 ${touchDevice ? 'min-h-12' : 'min-h-8'}`}>
        {expanded && <button type="button" className={toolbarButtonClass} onClick={() => { setExpanded(false); setPanel(null); }} aria-label={t('computer.exitFullscreen')}><ChevronLeft size={20} /></button>}
        <Monitor size={16} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{connected ? desktopName || (localTarget ? service?.hostname || savedConnection()?.serviceName : host) || t('computer.title') : t('computer.title')}</span>
        {connected && <span className="text-[11px] text-primary">{t('computer.connected')}</span>}
        {connected && loginState === 'error' && <span role="alert" className="text-[11px] text-destructive">{t('computer.loginSaveFailed')}</span>}
        {connected && saveState === 'saving' && <span role="status" aria-label={t('computer.settingsSaving')} title={t('computer.settingsSaving')}><Loader2 size={12} className="animate-spin text-muted-foreground" /></span>}
        {connected && saveState === 'error' && <button type="button" className={buttonClass} title={t('computer.settingsSaveFailed')} aria-label={t('computer.settingsSaveFailed')} onClick={retry}>! {t('computer.retry')}</button>}
        {busy && <button type="button" className={`${toolbarButtonClass} gap-1 px-1 text-xs`} onClick={disconnect}><Unplug size={14} />{t('computer.cancel')}</button>}
        {connected && !touchDevice && panel === 'keyboard' && <button type="button" className={toolbarButtonClass} onClick={() => togglePanel('keyboard')} aria-label={t('computer.keyboard')} aria-pressed={keyboardActive}><Keyboard size={18} /></button>}
        {connected && !touchDevice && <button type="button" className={`${toolbarButtonClass} ${panel === 'clipboard' ? 'bg-surface-2 text-primary' : ''}`} disabled={viewOnly} onClick={() => togglePanel('clipboard')} aria-label={t('computer.clipboardTool')} title={t('computer.clipboardTool')} aria-pressed={panel === 'clipboard'}><Clipboard size={18} /></button>}
        {connected && !expanded && <button type="button" className={`${toolbarButtonClass} gap-1 px-1 text-xs`} onClick={() => setExpanded(true)} aria-label={t('computer.fullscreen')}><Maximize2 size={16} />{t('computer.expand')}</button>}
        {connected && <button type="button" className={toolbarButtonClass} onClick={() => togglePanel('tools')} aria-label={t('computer.tools')} aria-expanded={panel === 'tools'}><Settings2 size={18} /></button>}
      </div>
      {!showDesktop && <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto w-full max-w-md">
        <form className="space-y-3" onSubmit={event => { void connect(event); }}>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-background p-1" role="group" aria-label={t('computer.target')}>
            <button type="button" className={`min-h-11 rounded-md px-3 text-sm font-medium ${localTarget ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface'}`} aria-pressed={localTarget} disabled={busy || !service || !loaded} onClick={() => chooseTarget(true)}>{t('computer.thisComputer')}</button>
            <button type="button" className={`min-h-11 rounded-md px-3 text-sm font-medium ${!localTarget ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface'}`} aria-pressed={!localTarget} disabled={busy || !loaded} onClick={() => chooseTarget(false)}>{t('computer.otherComputer')}</button>
          </div>
          {localTarget ? <p className="text-xs leading-relaxed text-muted-foreground" role="status">{service ? t('computer.localService', { name: savedConnection()?.serviceName || service.hostname }) : t('computer.loading')}</p> : <label className="block space-y-1 text-xs"><span>{t('computer.host')}</span><input className={inputClass} value={host} disabled={busy || !loaded} onChange={event => { updateProfile({ host: event.target.value, domain: '', ignoreCert: false }); setPassword(''); setError(null); }} placeholder={t('computer.hostPlaceholder')} onBlur={() => { void flush(); }} autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={253} /></label>}
          <p className="text-xs text-muted-foreground">{platform === 'mac' ? 'macOS' : platform === 'linux' ? 'Ubuntu / Linux' : 'Windows'} · {protocol.toUpperCase()} · {protocol === 'rdp' ? port || '3389' : '5900'}{viewOnly ? ` · ${t('computer.viewOnly')}` : ''}</p>
          <label className="block space-y-1 text-xs"><span>{t(protocol === 'rdp' ? 'computer.rdpUsername' : 'computer.username')}</span><input className={inputClass} value={username} disabled={!loaded} onChange={event => setUsername(event.target.value)} onBlur={() => { void flush(); }} autoCapitalize="none" autoCorrect="off" autoComplete="off" required={protocol === 'rdp' || (state === 'credentials' && authNeedsUsername)} maxLength={255} /></label>
          <label className="block space-y-1 text-xs"><span>{t('computer.password')}</span><input className={inputClass} type="password" value={password} disabled={!loaded} onChange={event => setPassword(event.target.value)} placeholder={hasSavedLogin && state !== 'credentials' ? t('computer.savedPassword') : undefined} autoComplete="new-password" required={!hasSavedLogin || state === 'credentials'} maxLength={1024} /></label>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t(protocol === 'rdp' ? 'computer.rdpLoginHint' : 'computer.vncLoginHint')}</p>
          <div className="flex min-h-11 items-center justify-between gap-2 text-xs">
            <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={profile.rememberLogin} disabled={busy || !loaded || loginState === 'saving'} onChange={event => {
              const rememberLogin = event.target.checked; updateProfile({ rememberLogin });
              if (!rememberLogin && hasSavedLogin) void credentialRequest('forget', { ...profile, rememberLogin }).catch(() => {});
              else void flush();
            }} />{t('computer.rememberLogin')}</label>
            {hasSavedLogin && <button type="button" className="min-h-11 text-muted-foreground underline" disabled={busy || loginState === 'saving'} onClick={forgetLogin}>{t('computer.forgetLogin')}</button>}
          </div>
          {loginState === 'error' && !error && <p role="alert" className="text-xs text-destructive">{t('computer.loginSaveFailed')}</p>}
          {rdpBackendUnavailable && <div role="status" className="space-y-1 text-xs leading-relaxed text-muted-foreground"><p>{t('computer.rdpBackendUnavailable')}</p><p>{t('computer.rdpBackendRecovery')}</p></div>}
          {state === 'credentials' && <p className="text-xs text-primary">{t('computer.credentials')}</p>}
          {error && <div role="alert" className="rounded-md bg-surface-2 p-3 text-xs leading-relaxed text-destructive">{t(error)}
            {error === 'computer.rdpCertificate' && <label className="mt-1 flex min-h-11 items-center gap-2 text-foreground"><input type="checkbox" checked={ignoreCert} onChange={event => setIgnoreCert(event.target.checked)} />{t('computer.trustCertificateHere')}</label>}
            {state === 'error' && error !== 'computer.rdpCertificate' && <button type="button" className="mt-1 block min-h-9 text-foreground underline" onClick={() => { setAdvanced(true); requestAnimationFrame(() => advancedRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })); }} >{t('computer.checkSettings')}</button>}
          </div>}
          <button type="submit" className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-40" disabled={!loaded || rdpBackendUnavailable || loginState === 'saving' || (localTarget && !service) || !host.trim() || (!password && (!hasSavedLogin || state === 'credentials')) || (protocol === 'rdp' && (!username.trim() || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535))}>
            {t(state === 'credentials' ? 'computer.authenticate' : state === 'error' ? 'computer.retryConnect' : 'computer.connect')}
          </button>
          <details ref={advancedRef} className="border-b border-border text-xs" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-muted-foreground"><span>{t('computer.advanced')}</span><span aria-hidden="true">{advanced ? '−' : '+'}</span></summary>
            <div className="space-y-3 pb-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1"><span>{t('computer.platform')}</span><select className={inputClass} value={platform} disabled={busy || !loaded} onChange={event => { if (isComputerPlatform(event.target.value)) updateProfile({ platform: event.target.value, protocol: event.target.value === 'mac' ? 'vnc' : 'rdp', ignoreCert: false }); setPassword(''); void flush(); }}>
                  <option value="mac">macOS</option><option value="linux">Ubuntu / Linux</option><option value="windows">Windows</option>
                </select></label>
                <label className="block space-y-1"><span>{t('computer.protocol')}</span><select className={inputClass} value={protocol} disabled={busy || !loaded} onChange={event => { updateProfile({ protocol: event.target.value === 'rdp' ? 'rdp' : 'vnc' }); setPassword(''); setError(null); void flush(); }}>
                  <option value="rdp">RDP</option><option value="vnc">VNC</option>
                </select></label>
              </div>
              {protocol === 'rdp' && <>
                <label className="block space-y-1"><span>{t('computer.port')}</span><input className={inputClass} type="number" min={1} max={65535} step={1} value={port} disabled={busy || !loaded} onBlur={() => { void flush(); }} onChange={event => setPort(event.target.value)} /></label>
                <label className="block space-y-1"><span>{t('computer.domain')}</span><input className={inputClass} value={domain} disabled={busy || !loaded} onBlur={() => { void flush(); }} onChange={event => setDomain(event.target.value)} autoComplete="off" maxLength={255} /></label>
                <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={ignoreCert} disabled={busy || !loaded} onChange={event => setIgnoreCert(event.target.checked)} />{t('computer.trustCertificate')}</label>
              </>}
              <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={viewOnly} disabled={busy || !loaded} onChange={event => setViewOnly(event.target.checked)} />{t('computer.viewOnly')}</label>
              <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={preferences.autoConnect} disabled={busy || !loaded} onChange={event => { change(value => ({ ...value, autoConnect: event.target.checked })); void flush(); }} />{t('computer.autoConnect')}</label>
            </div>
          </details>
        </form>
        <p role="status" className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t(saveState === 'saved' ? 'computer.settingsSaved' : saveState === 'error' ? (loaded ? 'computer.settingsSaveFailed' : 'computer.settingsLoadFailed') : saveState === 'loading' ? 'computer.settingsLoading' : 'computer.settingsSaving')}{saveState === 'error' && <button type="button" className="ml-2 min-h-9 text-primary underline" onClick={retry}>{t('computer.retry')}</button>}</p>
        <details className="text-xs">
          <summary className="flex min-h-11 cursor-pointer items-center text-muted-foreground">{t('computer.setup')}</summary>
          <ol className="ml-4 list-decimal space-y-2 pt-2 leading-relaxed text-muted-foreground"><li>{t(protocol === 'rdp' ? (platform === 'linux' ? 'computer.rdpLinuxStep1' : 'computer.rdpStep1') : platform === 'mac' ? 'computer.step1' : platform === 'linux' ? 'computer.linuxStep1' : 'computer.windowsStep1')}</li><li>{t(protocol === 'rdp' ? 'computer.rdpStep2' : platform === 'mac' ? 'computer.step2' : platform === 'linux' ? 'computer.linuxStep2' : 'computer.windowsStep2')}</li><li>{t('computer.step3')}</li></ol>
          {protocol === 'vnc' && platform === 'linux' && <>
            <p className="mt-3 leading-relaxed text-muted-foreground">{t('computer.linuxCommandHint')}</p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-background p-2 text-[11px]"><code>{'sudo apt install x11vnc\nx11vnc -storepasswd\nx11vnc -display "$DISPLAY" -auth guess -localhost -usepw -forever -shared -rfbport 5900'}</code></pre>
            <p className="mt-2 leading-relaxed text-muted-foreground">{t('computer.linuxProtocolHint')}</p>
          </>}
          <p className="mt-3 leading-relaxed text-muted-foreground">{t(protocol === 'rdp' ? 'computer.rdpNetworkHint' : 'computer.networkHint')}</p>
        </details>
        </div>
      </div>}
      {connected && panel === 'tools' && <button type="button" className={`absolute inset-x-0 ${touchDevice ? 'bottom-14 top-12' : 'bottom-0 top-8'} z-20 bg-background/40`} aria-label={t('computer.returnToDesktop')} onClick={() => setPanel(null)} />}
      {connected && <div hidden={panel !== 'tools'} className={`${panel === 'tools' ? 'flex' : 'hidden'} absolute inset-x-3 ${touchDevice ? 'top-14' : 'top-10'} z-30 max-h-[calc(100%-7rem)] flex-wrap items-center gap-3 overflow-y-auto rounded-lg border border-border bg-surface px-4 py-3 text-xs shadow-lg [&_button]:min-h-11 [&_select]:min-h-11 [&_label]:min-h-11`} role="region" aria-label={t('computer.tools')}>
        <div className="flex w-full items-center justify-between"><span className="font-medium">{t('computer.tools')}</span><button type="button" className="flex min-w-11 items-center justify-center" aria-label={t('computer.closeTools')} onClick={() => setPanel(null)}><X size={18} /></button></div>
        {touchDevice && <div className="flex w-full items-center gap-2">
          <div className="inline-flex rounded-md bg-background p-0.5" role="group" aria-label={t('computer.touchMode')}>
            {(['trackpad', 'direct'] as const).map(mode => <button key={mode} type="button"
              className={`min-h-9 rounded px-3 text-xs ${touchMode === mode ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface'}`}
              aria-pressed={touchMode === mode} onClick={() => chooseTouchMode(mode)}>{t(mode === 'trackpad' ? 'computer.trackpadMode' : 'computer.directTouchMode')}</button>)}
          </div>
        </div>}
        {!touchDevice && <>
          {zoomControls}
          <button type="button" className={buttonClass} disabled={viewOnly} onClick={() => togglePanel('keyboard')}><Keyboard size={14} />{t('computer.keyboard')}</button>
        </>}
        <label className="flex min-h-9 items-center gap-1.5"><input type="checkbox" checked={viewOnly} onChange={event => setViewOnly(event.target.checked)} />{t('computer.viewOnly')}</label>
        <button type="button" className={buttonClass} onClick={() => { zoomRef.current?.set(1); change(value => ({ ...value, fit: !value.fit })); void flush(); }}>{t(fit ? 'computer.actualSize' : 'computer.fit')}</button>
        <select className={`${buttonClass} min-w-0 bg-surface`} aria-label={t('computer.shortcuts')} value="" disabled={viewOnly} onChange={event => {
          sendKeys(shortcuts[event.target.value] ?? []);
        }}>
          <option value="" disabled>{t('computer.shortcuts')}</option><option value="tab">{platform === 'mac' ? '⌘ Tab' : 'Alt+Tab'} · {t('computer.switchApps')}</option><option value="search">{platform === 'mac' ? '⌘ Space' : 'Super / Win'} · {t(platform === 'mac' ? 'computer.spotlight' : 'computer.systemSearch')}</option>
          <option value="copy">{platform === 'mac' ? '⌘C' : 'Ctrl+C'}</option><option value="paste">{pasteLabel}</option><option value="escape">Esc</option><option value="enter">Enter</option><option value="backspace">⌫</option>
          <option value="up">↑</option><option value="down">↓</option><option value="left">←</option><option value="right">→</option>
        </select>
        <div className="flex w-full items-center justify-between border-t border-border pt-2">
          {hasSavedLogin && <button type="button" className={buttonClass} disabled={loginState === 'saving'} onClick={forgetLogin}>{t('computer.forgetLogin')}</button>}
          <button type="button" className={`${buttonClass} ml-auto text-destructive`} onClick={disconnect}><Unplug size={14} />{t('computer.disconnect')}</button>
        </div>
      </div>}
      <div ref={mountRef} data-sidebar-gesture-ignore="" className={`relative z-10 min-h-0 flex-1 overflow-hidden bg-[var(--chrome-bg)] ${showDesktop ? '' : 'hidden'}`}
        onMouseDownCapture={event => { if (panel === 'keyboard') event.preventDefault(); }}
        style={{ touchAction: connected ? 'none' : undefined }} aria-label={t('computer.remoteTitle')}>
        {!connected && showDesktop && <div role="status" className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-surface text-xs text-muted-foreground"><Loader2 size={16} className="animate-spin" />{t('computer.connecting')}</div>}
        {connected && <div ref={cursorRef} hidden aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-20 h-5 w-5 will-change-transform">
        </div>}
      </div>
      <div hidden={panel !== 'tools'}>
        {connected && touchDevice && !viewOnly && <p className="shrink-0 border-t border-border px-2 py-1 text-[10px] leading-relaxed text-muted-foreground">{t(touchMode === 'trackpad' ? 'computer.trackpadHint' : 'computer.directTouchHint')}</p>}
      </div>
      {connected && panel === 'keyboard' && !viewOnly && <>
        <ComputerKeyboardInput sendChord={sendKeys} commandKey={shortcuts.copy[0]} inputRef={keyboardInputRef} onFocusChange={setKeyboardFocused} sendText={sendText} sendKey={key => sendKeys(key === 'tab' ? [[0xff09, 'Tab']] : key === 'delete' ? [[0xffff, 'Delete']] : shortcuts[key])} />
        <div className="grid shrink-0 grid-cols-6 gap-1 bg-surface px-1" role="group" aria-label={t('computer.keyboardNavigation')}>
          {(['escape', 'left', 'down', 'up', 'right', 'selectAll'] as const).map(key => <button key={key} type="button" className="min-h-11 rounded-md text-sm hover:bg-surface-2"
            aria-label={t(`computer.key${key[0].toUpperCase()}${key.slice(1)}` as TranslationKey)}
            onPointerDown={event => event.preventDefault()} onClick={() => sendKeys(key === 'selectAll' ? [...shortcuts.copy.slice(0, 1), [0x61, 'KeyA']] : shortcuts[key])}>
            {{ escape: 'Esc', left: '←', down: '↓', up: '↑', right: '→', selectAll: platform === 'mac' ? '⌘A' : 'Ctrl+A' }[key]}
          </button>)}
        </div>
      </>}
      {connected && panel === 'clipboard' && !viewOnly && <form className="shrink-0 space-y-2 border-t border-border p-3" onSubmit={event => {
        event.preventDefault();
        if (!text || !rfbRef.current) return;
        try { rfbRef.current.clipboardPasteFrom(text); setClipboardSent(true); setClipboardError(false); }
        catch { setClipboardError(true); }
      }}>
        <textarea className={`${inputClass} min-w-0 resize-none py-2 text-base`} rows={2} aria-label={t('computer.clipboard')} placeholder={t('computer.clipboardPlaceholder')} value={text} onChange={event => { setText(event.target.value); setClipboardSent(false); }} maxLength={COMPUTER_CLIPBOARD_LIMIT} />
        <div className="flex gap-2"><button type="submit" className={`${buttonClass} min-h-11 flex-1`} disabled={!text}>{t('computer.clipboard')}</button><button type="button" className={`${buttonClass} min-h-11`} onClick={() => {
          try {
            if (text) rfbRef.current?.clipboardPasteFrom(text);
            sendKeys(shortcuts.paste); setClipboardError(false); setClipboardSent(Boolean(text));
          } catch { setClipboardError(true); }
        }}>{pasteLabel}</button></div>
        <p role="status" className="text-[10px] leading-relaxed text-muted-foreground">{clipboardSent ? t('computer.clipboardSent') : t('computer.clipboardHint', { shortcut: pasteLabel })}</p>
        {remoteClipboard !== null && <div className="space-y-1">
          <textarea className={`${inputClass} resize-none py-2 text-base`} rows={2} readOnly value={remoteClipboard} aria-label={t('computer.remoteClipboard')} onFocus={event => event.currentTarget.select()} />
          <button type="button" className={buttonClass} onClick={() => {
            if (!navigator.clipboard?.writeText) { setClipboardError(true); return; }
            void navigator.clipboard.writeText(remoteClipboard).then(() => { setClipboardCopied(true); setClipboardError(false); }, () => setClipboardError(true));
          }}>{t(clipboardCopied ? 'computer.clipboardCopied' : 'computer.copyToDevice')}</button>
        </div>}
        {clipboardError && <p role="alert" className="text-xs text-destructive">{t('computer.clipboardAccessFailed')}</p>}
        {error && <p role="alert" className="text-xs text-destructive">{t(error)}</p>}
      </form>}
      {showDesktop && touchDevice && <div className="relative z-30 flex shrink-0 items-center border-t border-border bg-surface px-1 py-1 text-[11px]">
        <div className={`grid min-w-0 flex-1 ${panel === 'keyboard' ? 'grid-cols-5' : 'grid-cols-3'}`}>
          <button type="button" className={`flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md ${keyboardActive ? 'bg-surface-2 text-primary' : ''}`} disabled={!connected || viewOnly} onClick={() => togglePanel('keyboard')} aria-pressed={keyboardActive}><Keyboard size={18} />{t('computer.keyboard')}</button>
          <button type="button" className={`flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md ${panel === 'clipboard' ? 'bg-surface-2 text-primary' : ''}`} disabled={!connected || viewOnly} onClick={() => togglePanel('clipboard')} aria-pressed={panel === 'clipboard'}><Clipboard size={18} />{t('computer.clipboardTool')}</button>
          {panel === 'keyboard' ? <>
            <button type="button" className="min-h-11 rounded-md text-sm" onPointerDown={event => event.preventDefault()} onClick={() => sendKeys([[0xff09, 'Tab']])}>Tab</button>
            <button type="button" className="min-h-11 rounded-md text-lg" onPointerDown={event => event.preventDefault()} onClick={() => sendKeys(shortcuts.backspace)}>⌫</button>
            <button type="button" className="min-h-11 rounded-md text-lg" onPointerDown={event => event.preventDefault()} onClick={() => sendKeys(shortcuts.enter)}>↵</button>
          </> : <>
            <button type="button" className="flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md" disabled={!connected || viewOnly} onClick={() => chooseTouchMode(touchMode === 'trackpad' ? 'direct' : 'trackpad')} aria-label={t('computer.switchTouchMode')}><MousePointer2 size={18} />{t(touchMode === 'trackpad' ? 'computer.trackpadMode' : 'computer.directTouchMode')}</button>
          </>}
        </div>
        {zoomControls}
      </div>}
    </div>
  );
  return expanded ? createPortal(body, document.body) : body;
}
