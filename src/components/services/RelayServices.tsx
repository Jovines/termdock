import { useEffect, useState } from 'react';
import { ChevronRight, Loader2, Server } from 'lucide-react';
import { listRelayTargets, prepareRelayConnection, type ConnectionIntent, type RelayTarget, type RelayTargetDirectory } from '../../lib/federation/browserIntegration';
import { DeviceAuthorizationRequired } from '../../lib/federation/deviceAuthorization';
import type { ServiceConnection } from '../../lib/services/serviceDirectory';

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
  useEffect(() => {
    let disposed = false;
    setLoading(true); setError(''); setDirectory(undefined);
    void listRelayTargets(service).then(result => { if (!disposed) setDirectory(result); })
      .catch(failure => { if (!disposed) setError(failure instanceof Error ? failure.message : '暂时无法读取中转列表，请重试。'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [service.id, service.url, revision]);
  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); onBusyChange(true); setError('');
    try { await task(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '暂时无法连接，请重试。'); }
    finally { setBusy(false); onBusyChange(false); }
  };
  const choose = async (target: RelayTarget) => {
    const intent = await prepareRelayConnection(directory!.route, target.serviceId);
    try { await onConnect(intent); }
    catch (failure) {
      if (!(failure instanceof DeviceAuthorizationRequired)) throw failure;
      setPending(intent);
    }
  };
  return <div className="service-form">
    {pending ? <form className="service-form" onSubmit={event => { event.preventDefault(); void run(async () => {
      try { await onConnectWithPassword?.(pending, password); } finally { setPassword(''); }
    }); }}>
      <p className="service-help">已通过“{service.label}”连接到“{pending.serviceName}”。请登录目标服务，完成此设备的访问授权。</p>
      {onConnectWithPassword ? <><label className="service-field"><span>目标服务密码</span><input type="password" autoFocus required autoComplete="current-password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
        <button type="submit" className="service-button service-primary" disabled={busy || !password}>{busy ? '正在登录…' : '登录并连接'}</button></> : <p className="service-help">请让目标服务管理员邀请此设备后再连接。</p>}
      <button type="button" className="service-button service-secondary" disabled={busy} onClick={() => { setPending(undefined); setPassword(''); setError(''); setRevision(value => value + 1); }}>返回中转列表</button>
    </form> : <>
      <p className="service-help">通过“{service.label}”连接下方服务。{directory?.canManage ? '选择未授权的服务会授权此设备使用该中转。' : '这里只显示已授权给此设备的中转。'}目标服务会单独验证访问权限。</p>
      {loading ? <p className="service-feedback" role="status"><Loader2 size={16} className="service-spinning" />正在读取可中转的服务…</p> : directory && <div className="service-list">
        {directory.items.map(target => <button key={target.serviceId} type="button" className="service-row-open service-full-width" disabled={busy || !target.available} onClick={() => void run(() => choose(target))}>
          <span className="service-icon"><Server size={19} /></span><span className="service-row-copy"><span className="service-name">{target.label || (target.url ? new URL(target.url).host : `中转服务 ${target.serviceId.slice(0, 8)}`)}</span><span className="service-description">{!target.available ? '中转暂不可用' : target.authorized ? '已获中转授权 · 连接' : '授权此设备并连接'}</span></span><ChevronRight size={16} />
        </button>)}
        {directory.items.length === 0 && <p className="service-empty">{directory.canManage ? '暂无可中转的服务。可在本机 Mac 客户端连接目标服务，或在目标服务的“备用连接”中启用本入口。' : '暂无已授权的中转服务，请让入口管理员分享备用连接邀请。'}</p>}
      </div>}
      {busy && <p className="service-feedback" role="status"><Loader2 size={16} className="service-spinning" />正在授权并连接目标服务…</p>}
      {!loading && <button type="button" className="service-button service-secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>刷新列表</button>}
    </>}
    {error && <p className="service-error" role="alert">{error}</p>}
  </div>;
}
