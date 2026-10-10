import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Monitor, Maximize2, Unplug, Loader2, MousePointer2, Settings2, Keyboard, Clipboard, X, ChevronLeft, ZoomIn } from 'lucide-react';
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
  const frameRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [clipboardSent, setClipboardSent] = useState(false);
  const [authNeedsUsername, setAuthNeedsUsername] = useState(false);
  const [touchMode, setTouchMode] = useState(readComputerTouchMode);
  const cursorRef = useRef<HTMLDivElement>(null);
  const pointerPosition = useRef<TouchpadPosition | null>(null);
  const releaseTouchpad = useRef<() => void>(() => {});
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
  const keyQueue = useMemo(() => computerKeyQueue(([key, code, down]) => rfbRef.current?.sendKey(key, code, down)), []);
  const channelRef = useRef<SecureVncChannel | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dispose = useCallback(() => {
    releaseTouchpad.current();
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
  useEffect(() => { if (rfbRef.current) rfbRef.current.viewOnly = viewOnly; }, [viewOnly]);
  useEffect(() => { if (rfbRef.current) rfbRef.current.scaleViewport = fit; }, [fit]);
  useEffect(() => { if (rfbRef.current && 'pauseResize' in rfbRef.current) rfbRef.current.pauseResize = Boolean(panel); }, [panel]);
  useEffect(() => { if (rfbRef.current && 'keyboardActive' in rfbRef.current) rfbRef.current.keyboardActive = panel === 'keyboard'; }, [panel]);

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
        const mobile = window.innerWidth <= 640;
        const bounds = frameRef.current?.getBoundingClientRect();
        const initialSize = computerDesktopSize(mobile ? window.innerWidth : bounds?.width || 1280,
          Math.max(1, (mobile ? window.innerHeight : bounds?.height || 800) - 100));
        rfb = new RdpSession(screen, { host: host.trim(), port: Number(port), username: username.trim(), password: secret || '',
          domain: domain.trim(), ignoreCert, ...initialSize }, reason => fail(errorKey(reason)));
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
          (document.activeElement as HTMLElement | null)?.blur?.(); setExpanded(true);
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
    keyQueue.send([...keys.map(([key, code]): ComputerKeyEvent => [key, code, true]), ...[...keys].reverse().map(([key, code]): ComputerKeyEvent => [key, code, false])]);
  };
  const connected = state === 'connected';
  const busy = state === 'connecting' || state === 'credentials';
  useEffect(() => {
    const session = rfbRef.current, viewport = mountRef.current, cursor = cursorRef.current;
    if (!connected || viewOnly || (panel && panel !== 'keyboard') || touchMode !== 'trackpad' || !session || !viewport || !cursor) return;
    const pointer = 'pointerTarget' in session ? session.pointerTarget : vncPointer(session);
    const release = attachComputerTouchpad(viewport, pointer, cursor, pointerPosition);
    releaseTouchpad.current = release;
    return () => { release(); if (releaseTouchpad.current === release) releaseTouchpad.current = () => {}; };
  }, [connected, viewOnly, touchMode, expanded, panel]);
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
  const togglePanel = (next: 'tools' | 'clipboard' | 'keyboard') => { releaseTouchpad.current(); setPanel(value => value === next ? null : next); };
  const sendText = (value: string) => {
    if (!rfbRef.current || viewOnly) return;
    const events: ComputerKeyEvent[] = [];
    for (const character of value) {
      const code = character.codePointAt(0)!;
      const keysym = character === '\n' ? 0xff0d : character === '\t' ? 0xff09 : code < 256 ? code : 0x01000000 | code;
      events.push([keysym, null, true], [keysym, null, false]);
    }
    keyQueue.send(events);
  };
  useEffect(() => {
    if (!connected || (panel !== 'keyboard' && panel !== 'clipboard') || !expanded || !window.visualViewport) return;
    const viewport = window.visualViewport, frame = frameRef.current;
    const update = () => { if (frame && viewport.height >= 160) { frame.style.height = `${viewport.height}px`; frame.style.top = `${viewport.offsetTop}px`; } };
    update(); viewport.addEventListener('resize', update); viewport.addEventListener('scroll', update);
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); if (frame) { frame.style.height = ''; frame.style.top = ''; } };
  }, [connected, panel, expanded]);

  const body = (
    <div ref={frameRef} className={`flex min-h-0 flex-col bg-surface text-foreground ${expanded ? 'fixed inset-0 z-modal-panel h-dvh pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]' : 'relative h-full'}`}
      role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined} aria-label={t('computer.title')}
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && !event.nativeEvent.isComposing && panel) { event.preventDefault(); setPanel(null); } }} onKeyUp={event => event.stopPropagation()}>
      <div className="relative z-30 flex min-h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
        {expanded && <button type="button" className="flex min-h-11 min-w-11 items-center justify-center" onClick={() => { setExpanded(false); setPanel(null); }} aria-label={t('computer.exitFullscreen')}><ChevronLeft size={20} /></button>}
        <Monitor size={16} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{connected ? desktopName || (localTarget ? service?.hostname || savedConnection()?.serviceName : host) || t('computer.title') : t('computer.title')}</span>
        {connected && <span className="text-[11px] text-primary">{t('computer.connected')}</span>}
        {connected && loginState === 'error' && <span role="alert" className="text-[11px] text-destructive">{t('computer.loginSaveFailed')}</span>}
        {connected && saveState === 'saving' && <span role="status" aria-label={t('computer.settingsSaving')} title={t('computer.settingsSaving')}><Loader2 size={12} className="animate-spin text-muted-foreground" /></span>}
        {connected && saveState === 'error' && <button type="button" className={buttonClass} title={t('computer.settingsSaveFailed')} aria-label={t('computer.settingsSaveFailed')} onClick={retry}>! {t('computer.retry')}</button>}
        {busy && <button type="button" className={buttonClass} onClick={disconnect}><Unplug size={14} />{t('computer.cancel')}</button>}
        {connected && !expanded && <button type="button" className="flex min-h-11 min-w-11 items-center justify-center gap-1 text-xs" onClick={() => setExpanded(true)} aria-label={t('computer.fullscreen')}><Maximize2 size={16} />{t('computer.expand')}</button>}
        {connected && <button type="button" className="flex min-h-11 min-w-11 items-center justify-center" onClick={() => togglePanel('tools')} aria-label={t('computer.tools')} aria-expanded={panel === 'tools'}><Settings2 size={18} /></button>}
      </div>
      {!connected && <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto w-full max-w-md">
        <form className="space-y-3" onSubmit={event => { void connect(event); }} aria-busy={state === 'connecting'}>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-background p-1" role="group" aria-label={t('computer.target')}>
            <button type="button" className={`min-h-11 rounded-md px-3 text-sm font-medium ${localTarget ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface'}`} aria-pressed={localTarget} disabled={busy || !service || !loaded} onClick={() => chooseTarget(true)}>{t('computer.thisComputer')}</button>
            <button type="button" className={`min-h-11 rounded-md px-3 text-sm font-medium ${!localTarget ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface'}`} aria-pressed={!localTarget} disabled={busy || !loaded} onClick={() => chooseTarget(false)}>{t('computer.otherComputer')}</button>
          </div>
          {localTarget ? <p className="text-xs leading-relaxed text-muted-foreground" role="status">{service ? t('computer.localService', { name: savedConnection()?.serviceName || service.hostname }) : t('computer.loading')}</p> : <label className="block space-y-1 text-xs"><span>{t('computer.host')}</span><input className={inputClass} value={host} disabled={busy || !loaded} onChange={event => { updateProfile({ host: event.target.value, domain: '', ignoreCert: false }); setPassword(''); setError(null); }} placeholder={t('computer.hostPlaceholder')} onBlur={() => { void flush(); }} autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={253} /></label>}
          <p className="text-xs text-muted-foreground">{platform === 'mac' ? 'macOS' : platform === 'linux' ? 'Ubuntu / Linux' : 'Windows'} · {protocol.toUpperCase()} · {protocol === 'rdp' ? port || '3389' : '5900'}{viewOnly ? ` · ${t('computer.viewOnly')}` : ''}</p>
          <label className="block space-y-1 text-xs"><span>{t(protocol === 'rdp' ? 'computer.rdpUsername' : 'computer.username')}</span><input className={inputClass} value={username} disabled={state === 'connecting' || !loaded} onChange={event => setUsername(event.target.value)} onBlur={() => { void flush(); }} autoCapitalize="none" autoCorrect="off" autoComplete="off" required={protocol === 'rdp' || (state === 'credentials' && authNeedsUsername)} maxLength={255} /></label>
          <label className="block space-y-1 text-xs"><span>{t('computer.password')}</span><input className={inputClass} type="password" value={password} disabled={state === 'connecting' || !loaded} onChange={event => setPassword(event.target.value)} placeholder={hasSavedLogin && state !== 'credentials' ? t('computer.savedPassword') : undefined} autoComplete="new-password" required={!hasSavedLogin || state === 'credentials'} maxLength={1024} /></label>
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
          <button type="submit" className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-40" disabled={!loaded || rdpBackendUnavailable || state === 'connecting' || loginState === 'saving' || (localTarget && !service) || !host.trim() || (!password && (!hasSavedLogin || state === 'credentials')) || (protocol === 'rdp' && (!username.trim() || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535))}>
            {state === 'connecting' && <Loader2 size={16} className="animate-spin" />}{t(state === 'connecting' ? 'computer.connecting' : state === 'credentials' ? 'computer.authenticate' : state === 'error' ? 'computer.retryConnect' : 'computer.connect')}
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
      {connected && panel === 'tools' && <button type="button" className="absolute inset-x-0 bottom-14 top-12 z-20 bg-background/40" aria-label={t('computer.returnToDesktop')} onClick={() => setPanel(null)} />}
      {connected && <div hidden={panel !== 'tools'} className={`${panel === 'tools' ? 'flex' : 'hidden'} absolute inset-x-3 top-14 z-30 max-h-[calc(100%-7rem)] flex-wrap items-center gap-3 overflow-y-auto rounded-lg border border-border bg-surface px-4 py-3 text-xs shadow-lg [&_button]:min-h-11 [&_select]:min-h-11 [&_label]:min-h-11`} role="region" aria-label={t('computer.tools')}>
        <div className="flex w-full items-center justify-between"><span className="font-medium">{t('computer.tools')}</span><button type="button" className="flex min-w-11 items-center justify-center" aria-label={t('computer.closeTools')} onClick={() => setPanel(null)}><X size={18} /></button></div>
        <div className="flex w-full items-center gap-2">
          <div className="inline-flex rounded-md bg-background p-0.5" role="group" aria-label={t('computer.touchMode')}>
            {(['trackpad', 'direct'] as const).map(mode => <button key={mode} type="button"
              className={`min-h-9 rounded px-3 text-xs ${touchMode === mode ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface'}`}
              aria-pressed={touchMode === mode} onClick={() => chooseTouchMode(mode)}>{t(mode === 'trackpad' ? 'computer.trackpadMode' : 'computer.directTouchMode')}</button>)}
          </div>
        </div>
        <label className="flex min-h-9 items-center gap-1.5"><input type="checkbox" checked={viewOnly} onChange={event => setViewOnly(event.target.checked)} />{t('computer.viewOnly')}</label>
        <button type="button" className={buttonClass} onClick={() => { change(value => ({ ...value, fit: !value.fit })); void flush(); }}>{t(fit ? 'computer.actualSize' : 'computer.fit')}</button>
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
      <div ref={mountRef} data-sidebar-gesture-ignore="" className={`relative z-10 min-h-0 flex-1 overflow-hidden bg-[var(--chrome-bg)] ${connected ? '' : 'hidden'}`}
        style={{ touchAction: connected && touchMode === 'trackpad' && !viewOnly ? 'none' : undefined }} aria-label={t('computer.remoteTitle')}>
        {connected && touchMode === 'trackpad' && !viewOnly && <div ref={cursorRef} hidden aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-20 h-5 w-5 will-change-transform">
          <MousePointer2 size={20} strokeWidth={2} className="fill-background text-primary drop-shadow" />
        </div>}
      </div>
      <div hidden={panel !== 'tools'}>
        {connected && !viewOnly && <p className="shrink-0 border-t border-border px-2 py-1 text-[10px] leading-relaxed text-muted-foreground">{t(touchMode === 'trackpad' ? 'computer.trackpadHint' : 'computer.directTouchHint')}</p>}
      </div>
      {connected && panel === 'keyboard' && !viewOnly && <ComputerKeyboardInput sendText={sendText} sendKey={key => sendKeys(shortcuts[key])} />}
      {connected && panel === 'clipboard' && !viewOnly && <form className="shrink-0 space-y-2 border-t border-border p-3" onSubmit={event => {
        event.preventDefault();
        if (!text || !rfbRef.current) return;
        try { rfbRef.current.clipboardPasteFrom(text); setClipboardSent(true); }
        catch { setError('computer.clipboardFailed'); }
      }}>
        <textarea className={`${inputClass} min-w-0 resize-none py-2 text-base`} rows={2} aria-label={t('computer.clipboard')} placeholder={t('computer.clipboardPlaceholder')} value={text} onChange={event => { setText(event.target.value); setClipboardSent(false); }} maxLength={16_384} />
        <div className="flex gap-2"><button type="submit" className={`${buttonClass} min-h-11 flex-1`} disabled={!text}>{t('computer.clipboard')}</button><button type="button" className={`${buttonClass} min-h-11`} onClick={() => sendKeys(shortcuts.paste)}>{pasteLabel}</button></div>
        <p role="status" className="text-[10px] leading-relaxed text-muted-foreground">{clipboardSent ? t('computer.clipboardSent') : t('computer.clipboardHint', { shortcut: pasteLabel })}</p>
        {error && <p role="alert" className="text-xs text-destructive">{t(error)}</p>}
      </form>}
      {connected && <div className={`relative z-30 grid shrink-0 ${panel === 'keyboard' ? 'grid-cols-5' : 'grid-cols-4'} border-t border-border bg-surface px-1 py-1 text-[11px]`}>
        <button type="button" className={`flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md ${panel === 'keyboard' ? 'bg-surface-2 text-primary' : ''}`} disabled={viewOnly} onClick={() => togglePanel('keyboard')} aria-pressed={panel === 'keyboard'}><Keyboard size={18} />{t('computer.keyboard')}</button>
        <button type="button" className={`flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md ${panel === 'clipboard' ? 'bg-surface-2 text-primary' : ''}`} disabled={viewOnly} onClick={() => togglePanel('clipboard')} aria-pressed={panel === 'clipboard'}><Clipboard size={18} />{t('computer.clipboardTool')}</button>
        {panel === 'keyboard' ? <>
          <button type="button" className="min-h-11 rounded-md text-sm" onPointerDown={event => event.preventDefault()} onClick={() => sendKeys([[0xff09, 'Tab']])}>Tab</button>
          <button type="button" className="min-h-11 rounded-md text-lg" onPointerDown={event => event.preventDefault()} onClick={() => sendKeys(shortcuts.backspace)}>⌫</button>
          <button type="button" className="min-h-11 rounded-md text-lg" onPointerDown={event => event.preventDefault()} onClick={() => sendKeys(shortcuts.enter)}>↵</button>
        </> : <>
          <button type="button" className="flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md" onClick={() => { change(value => ({ ...value, fit: !value.fit })); void flush(); }}><ZoomIn size={18} />{t(fit ? 'computer.zoom' : 'computer.fit')}</button>
          <button type="button" className="flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md" disabled={viewOnly} onClick={() => chooseTouchMode(touchMode === 'trackpad' ? 'direct' : 'trackpad')} aria-label={t('computer.switchTouchMode')}><MousePointer2 size={18} />{t(touchMode === 'trackpad' ? 'computer.trackpadMode' : 'computer.directTouchMode')}</button>
        </>}
      </div>}
    </div>
  );
  return expanded ? createPortal(body, document.body) : body;
}
