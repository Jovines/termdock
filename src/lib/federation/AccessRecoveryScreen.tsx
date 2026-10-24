import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ConnectionAccessError } from './accessFailure';
import { connectionAddresses, inspectConnectionAccess, type ConnectionIntent, type ConnectionAccessStatus } from './browserIntegration';
import { passwordLoginFailure } from './passwordLoginFailure';
import { listServiceConnections, type ServiceConnection } from '../services/serviceDirectory';
import { ServiceRoutes } from '../../components/services/ServiceRoutes';
import { LoginScreen } from '../components/auth/LoginScreen';
import { useKeyboardLayer } from '../hooks/useKeyboardLayer';

/** Recovery starts with a choice. Mounting or dismissing this screen writes no permissions. */
export function AccessRecoveryScreen({ failure, target, onSettings, onRecovered, settingsOpen = false }: {
  failure: ConnectionAccessError; target: ConnectionIntent | null;
  onSettings: () => void; onRecovered: () => Promise<void>; settingsOpen?: boolean;
}) {
  const [mode, setMode] = useState<'notice' | 'route' | 'login' | 'cancelled'>('notice');
  const [services, setServices] = useState<ServiceConnection[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<ConnectionAccessStatus | 'checking'>('checking');
  const [checkError, setCheckError] = useState('');
  const [revision, setRevision] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const modeRef = useRef(mode); modeRef.current = mode;
  useLayoutEffect(() => { panel.current?.toggleAttribute('inert', settingsOpen); }, [settingsOpen]);
  useEffect(() => () => { modeRef.current = 'cancelled'; }, []);
  useKeyboardLayer(panel, !settingsOpen, () => { if (!busy) setMode(mode === 'notice' ? 'cancelled' : 'notice'); });
  useEffect(() => { let done = false; void listServiceConnections().then(items => { if (!done) setServices(items); }).catch(() => {}); return () => { done = true; }; }, []);
  const name = target?.serviceName || services.find(s => s.targetPeerId === failure.context.targetServiceId)?.label || '目标服务';
  const entryId = failure.context.entryServiceId || target?.entryServiceId;
  const entryUrl = failure.context.entryUrl || (target?.entryServiceId ? target.url : undefined);
  const entry = services.find(s => s.targetPeerId === entryId);
  const entryName = entry?.label || '已保存的入口';
  const relay = failure.code === 'RELAY_AUTHORIZATION_REQUIRED';
  const login = failure.code === 'TARGET_AUTHORIZATION_REQUIRED';
  const relayBlocked = failure.code === 'TARGET_PASSWORD_REQUIRED' || failure.code === 'TARGET_SECURITY_UPGRADE_REQUIRED';
  const targetStamp = JSON.stringify(target);
  useEffect(() => {
    if (!login || !targetStamp || targetStamp === 'null') return;
    const controller = new AbortController();
    setAccess('checking'); setCheckError('');
    void inspectConnectionAccess(JSON.parse(targetStamp), controller.signal).then(result => {
      if (!controller.signal.aborted) setAccess(result);
    }).catch(error => {
      if (!controller.signal.aborted) setCheckError(passwordLoginFailure(error).message);
    });
    return () => controller.abort();
  }, [login, targetStamp, revision]);
  const title = relay ? `通过“${entryName}”连接“${name}”需要中转授权`
    : relayBlocked ? `“${name}”已禁用中转` : login ? `“${name}”需要设备访问授权` : failure.code === 'TARGET_IDENTITY_MISMATCH' ? `“${name}”的服务身份不一致` : failure.code === 'RELAY_SELF_TARGET' ? `“${name}”的中转配置指向自身` : `当前权限无法访问“${name}”`;
  const applyRecovery = async () => {
    if (modeRef.current !== 'route' && modeRef.current !== 'login') throw new Error('RECOVERY_CANCELLED');
    await onRecovered();
  };
  const reconnect = async () => { if (modeRef.current !== 'login') return; setError(''); try { await applyRecovery(); } catch { setError('授权尚未核验通过，请检查连接设置或联系对应服务管理员。'); } };
  return <div ref={panel} style={settingsOpen ? { visibility: 'hidden' } : undefined} aria-hidden={settingsOpen ? true : undefined} className={`fixed inset-0 z-modal-panel flex items-center justify-center overflow-auto bg-[var(--chrome-bg)] ${mode === 'login' ? '' : 'px-6 py-[max(24px,env(safe-area-inset-top))]'}`}>
    {mode === 'login' ? <div className="h-full w-full">
    <LoginScreen serviceOrigin={target ? connectionAddresses(target)[0] : undefined} serviceName={name}
      entryOrigin={entryUrl} entryName={entryName}
      focusEnabled={!settingsOpen} onLoginSuccess={() => void reconnect()} onManageServices={onSettings} />
    <button className="absolute bottom-[max(24px,env(safe-area-inset-bottom))] left-1/2 min-h-11 -translate-x-1/2 px-4 text-sm text-muted-foreground" onClick={() => setMode('notice')}>取消</button>
    {error && <p role="alert" className="absolute bottom-20 left-0 right-0 px-6 text-center text-sm text-destructive">{error}</p>}
  </div> :
    <section className="w-full max-w-sm" aria-label="恢复服务访问">
      <h1 className="text-base font-medium" role="alert">{title}</h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{mode === 'cancelled' ? relay ? '已取消中转授权操作。直连恢复后会自动连接；保存的服务、终端和草稿保持不变。' : '连接已暂停。保存的服务、终端和草稿保持不变。' : relay ? '此中转路线没有有效授权，已暂停中转重试。直连恢复后会自动连接，不会自动重新授权。' : relayBlocked ? failure.message : login ? checkError || (access === 'checking' ? '正在核验目标服务的设备授权与登录方式…' : access === 'invitationRequired' ? '目标服务未配置访问密码，且此设备尚未获得访问授权。请让目标服务管理员发送邀请或授权此设备后重新连接。' : access === 'authorized' ? '已核验目标服务的设备访问授权，可以重新连接。' : '此设备尚未获得目标服务的访问授权。请使用目标服务的密码登录，或让目标服务管理员发送邀请。') : '连接已暂停。请核对保存的身份或联系管理员确认具体权限；不会替换身份或扩大授权。'}</p>
      {(login || relayBlocked) && entryUrl && <p className="mt-2 text-sm text-muted-foreground">目标：“{name}”；经入口“{entryName}”（{new URL(entryUrl).host}）中转。入口的中转授权不能代替目标服务的访问授权。</p>}
      {mode === 'route' && target && failure.context.entryServiceId && failure.context.entryUrl ? <div className="mt-5"><ServiceRoutes
        service={{ ...target, id: target.targetPeerId, label: name }} onBusyChange={setBusy}
        recoverEntry={{ targetPeerId: failure.context.entryServiceId, url: failure.context.entryUrl }} onRecovered={applyRecovery} onCancelRecovery={() => setMode('notice')} /></div>
        : <div className="mt-5 flex flex-col gap-2">
          {mode !== 'cancelled' && relay && failure.context.entryServiceId && failure.context.entryUrl && <button className="service-button service-primary" onClick={() => setMode('route')}>重新授权</button>}
          {mode !== 'cancelled' && login && access === 'passwordRequired' && !checkError && <button className="service-button service-primary" onClick={() => setMode('login')}>登录目标服务</button>}
          {mode !== 'cancelled' && (relayBlocked || login && access === 'authorized' && !checkError) && <button className="service-button service-primary" disabled={busy} onClick={() => {
            setBusy(true); setError(''); void onRecovered().catch(failure => { setError(relayBlocked ? passwordLoginFailure(failure).message : '授权尚未核验通过，请重新检查或联系目标服务管理员。'); setRevision(value => value + 1); }).finally(() => setBusy(false));
          }}>{relayBlocked ? '重新检查中转' : '重新连接'}</button>}
          {mode !== 'cancelled' && login && (checkError || access === 'invitationRequired') && <button className="service-button service-secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>重新检查授权</button>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <button className="service-button service-secondary" onClick={onSettings}>查看连接设置</button>
          {mode === 'cancelled' && <button className="service-button service-secondary" onClick={() => setMode('notice')}>返回恢复选项</button>}
          {mode !== 'cancelled' && <button className="service-button service-secondary" onClick={() => setMode('cancelled')}>取消</button>}
        </div>}
    </section>}
  </div>;
}
