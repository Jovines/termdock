import { LoadingSpinner as Loader2 } from '../../lib/components/ui/Loading';
import { useEffect, useState } from 'react';
import { ChevronRight, Server } from 'lucide-react';
import { listRelayTargets, prepareRelayConnection, inspectConnectionAccess, type ConnectionAccessStatus, type ConnectionIntent, type RelayTarget, type RelayTargetDirectory } from '../../lib/federation/browserIntegration';
import { DeviceAuthorizationRequired } from '../../lib/federation/deviceAuthorization';
import type { ServiceConnection } from '../../lib/services/serviceDirectory';
import { relayTargetName, relayTargetFailure } from '../../lib/federation/relayTarget';
import { passwordLoginFailure } from '../../lib/federation/passwordLoginFailure';

type TargetAccess = { status?: ConnectionAccessStatus; error?: string; blocked?: boolean };
function accessFailure(error: unknown): TargetAccess {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'TARGET_PASSWORD_REQUIRED' || code === 'TARGET_SECURITY_UPGRADE_REQUIRED' || code === 'TARGET_IDENTITY_MISMATCH') return { error: relayTargetFailure({ error: code }), blocked: true };
  return { error: passwordLoginFailure(error).message };
}

export function RelayServices({ service, onBusyChange, onConnect, onConnectWithPassword }: {
  service: ServiceConnection;
  onBusyChange: (busy: boolean) => void;
  onConnect: (intent: ConnectionIntent) => void | Promise<void>;
  onConnectWithPassword?: (intent: ConnectionIntent, password: string) => Promise<void>;
}) {
  const [directory, setDirectory] = useState<RelayTargetDirectory>();
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<ConnectionIntent>(), [password, setPassword] = useState('');
  const [access, setAccess] = useState<Record<string, TargetAccess>>({});
  useEffect(() => {
    let disposed = false, hasResult = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const checked = new Map<string, { at: number; value: TargetAccess }>();
    setLoading(true); setError(''); setDirectory(undefined); setAccess({}); setPending(undefined); setPassword('');
    const load = async (initial: boolean) => {
      try {
        const result = await listRelayTargets(service);
        if (disposed) return;
        hasResult = true; setDirectory(result); setError('');
        setLoading(false);
        const targets = result.items.filter(target => target.available && target.authorized);
        let index = 0;
        // Inspect only existing route grants, with bounded concurrency. The
        // target's permissions cannot be inferred from entry authorization.
        await Promise.all(Array.from({ length: Math.min(3, targets.length) }, async () => {
          while (!disposed && index < targets.length) {
            const target = targets[index++];
            const cached = checked.get(target.serviceId);
            if (cached && Date.now() - cached.at < 10_000) continue;
            let value: TargetAccess;
            try {
              const status = await inspectConnectionAccess({ url: result.route.url, entryServiceId: result.route.targetPeerId,
                targetPeerId: target.serviceId, routes: [result.route] }, controller.signal);
              value = status === 'invitationRequired' ? { error: relayTargetFailure({ error: 'TARGET_PASSWORD_REQUIRED' }), blocked: true } : { status };
            } catch (failure) { value = accessFailure(failure); }
            if (disposed) return;
            checked.set(target.serviceId, { at: Date.now(), value });
            setAccess(previous => ({ ...previous, [target.serviceId]: value }));
          }
        }));
      } catch (failure) {
        if (!disposed && (!hasResult || initial)) setError(failure instanceof Error ? failure.message : '暂时无法读取中转列表，请重试。');
      } finally {
        if (!disposed) {
          setLoading(false);
          timer = setTimeout(() => void load(false), 2_000);
        }
      }
    };
    void load(true);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [service.id, service.url, revision]);
  useEffect(() => {
    const target = pending && directory?.items.find(item => item.serviceId === pending.targetPeerId);
    if (pending && directory && (!target || !target.available)) {
      setPending(undefined); setPassword(''); setError(target ? relayTargetFailure(target) : '该服务已不可见，请刷新列表或联系入口管理员。');
    }
  }, [directory, pending]);
  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); onBusyChange(true); setError('');
    try { await task(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '暂时无法连接，请重试。'); }
    finally { setBusy(false); onBusyChange(false); }
  };
  const choose = async (target: RelayTarget) => {
    const intent = await prepareRelayConnection(directory!.route, target.serviceId);
    try {
      const status = await inspectConnectionAccess({ ...intent, url: directory!.route.url, serviceOrigin: undefined,
        entryServiceId: directory!.route.targetPeerId, routes: [directory!.route] });
      if (status === 'invitationRequired') {
        setAccess(previous => ({ ...previous, [target.serviceId]: { error: relayTargetFailure({ error: 'TARGET_PASSWORD_REQUIRED' }), blocked: true } }));
        return;
      }
      if (status === 'passwordRequired') { setPending(intent); return; }
      await onConnect(intent);
    }
    catch (failure) {
      if (!(failure instanceof DeviceAuthorizationRequired)) {
        const feedback = accessFailure(failure);
        setAccess(previous => ({ ...previous, [target.serviceId]: feedback })); throw new Error(feedback.error);
      }
      setPending(intent);
    }
  };
  return <div className="service-form">
    {pending ? <form className="service-form" onSubmit={event => { event.preventDefault(); void run(async () => {
      try { await onConnectWithPassword?.(pending, password); }
      catch (failure) {
        const code = passwordLoginFailure(failure).code;
        if (code === 'PASSWORD_NOT_CONFIGURED' || code === 'TARGET_PASSWORD_REQUIRED' || code === 'TARGET_SECURITY_UPGRADE_REQUIRED') {
          setAccess(previous => ({ ...previous, [pending.targetPeerId]: { error: relayTargetFailure({ error: code === 'TARGET_SECURITY_UPGRADE_REQUIRED' ? code : 'TARGET_PASSWORD_REQUIRED' }), blocked: true } }));
          setPending(undefined);
        }
        throw failure;
      } finally { setPassword(''); }
    }); }}>
      <p className="service-help">已通过“{service.label}”连接到“{pending.serviceName}”。请登录目标服务，完成此设备的访问授权。</p>
      {onConnectWithPassword ? <><label className="service-field"><span>目标服务密码</span><input type="password" autoFocus required autoComplete="current-password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
        <button type="submit" className="service-button service-primary" disabled={busy || !password}>{busy ? '正在登录…' : '登录并连接'}</button></> : <p className="service-help">请让目标服务管理员邀请此设备后再连接。</p>}
      <button type="button" className="service-button service-secondary" disabled={busy} onClick={() => { setPending(undefined); setPassword(''); setError(''); setRevision(value => value + 1); }}>返回中转列表</button>
    </form> : <>
      <p className="service-help">通过“{service.label}”连接下方服务。{directory?.canManage ? '选择未授权的服务会授权此设备使用该中转。' : '这里只显示已授权给此设备的中转。'}目标服务必须配置访问密码，并单独验证此设备的访问权限。</p>
      {loading ? <p className="service-feedback" role="status"><Loader2 size={16} className="service-spinning" />正在读取可中转的服务…</p> : directory && <div className="service-list">
        {directory.items.map(target => <button key={target.serviceId} type="button" className="service-row-open service-full-width" disabled={busy || !target.available || access[target.serviceId]?.blocked || target.authorized && !access[target.serviceId]} onClick={() => void run(() => choose(target))}>
          <span className="service-icon"><Server size={19} /></span><span className="service-row-copy"><span className="service-name">{relayTargetName(target)}</span><span className="service-description">{target.serviceId.slice(-12)} · {!target.available ? relayTargetFailure(target) : access[target.serviceId]?.error || (target.authorized ? access[target.serviceId]?.status === 'authorized' ? '已获中转和目标访问授权 · 连接' : access[target.serviceId]?.status === 'passwordRequired' ? '已获中转授权 · 此设备未获目标访问授权，请登录目标服务' : '已获中转授权 · 正在核验目标访问权限' : '尚未获中转授权 · 授权此设备并检查目标权限')}</span></span><ChevronRight size={16} />
        </button>)}
        {directory.items.length === 0 && <p className="service-empty">{directory.canManage ? '暂无可中转的服务。可在本机 Mac 客户端连接目标服务，或在目标服务的“备用连接”中启用本入口。' : '暂无已授权的中转服务，请让入口管理员分享备用连接邀请。'}</p>}
      </div>}
      {busy && <p className="service-feedback" role="status"><Loader2 size={16} className="service-spinning" />正在授权并连接目标服务…</p>}
      {!loading && <button type="button" className="service-button service-secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>刷新列表</button>}
    </>}
    {error && <p className="service-error" role="alert">{error}</p>}
  </div>;
}
