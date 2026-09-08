import { useEffect, useState } from 'react';
import { Check, ChevronRight, Copy, Loader2, Server } from 'lucide-react';
import { addServiceAddress, authorizeEntryRoute, connectionRoutes, createEntryInvitation, inspectEntryRoute, revokeEntryRoute, saveServiceRoutes } from '../../lib/federation/browserIntegration';
import { createInviteLink } from '../../lib/federation/inviteLink';
import { listServiceConnections, type ServiceConnection, type ServiceRoute } from '../../lib/services/serviceDirectory';

export function ServiceRoutes({ service, onBusyChange }: { service: ServiceConnection; onBusyChange: (busy: boolean) => void }) {
  const target = { ...service, targetPeerId: service.targetPeerId!, serviceName: service.label };
  const [routes, setRoutes] = useState(() => service.routes ?? connectionRoutes(target));
  const [entries, setEntries] = useState<ServiceConnection[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusyState] = useState(false), [error, setError] = useState('');
  const setBusy = (value: boolean) => { setBusyState(value); onBusyChange(value); };
  const [passwordEntry, setPasswordEntry] = useState<ServiceConnection>(), [password, setPassword] = useState('');
  const [address, setAddress] = useState(''), [notice, setNotice] = useState('');
  const [addingAddress, setAddingAddress] = useState(false);
  const [removing, setRemoving] = useState<ServiceRoute>(), [sharing, setSharing] = useState<string>(), [copied, setCopied] = useState(false);
  useEffect(() => { let done = false; void listServiceConnections().then(items => { if (!done) setEntries(items.filter(item => item.targetPeerId && item.targetPeerId !== service.targetPeerId)); }).catch(() => { if (!done) setError('暂时无法读取可用服务。'); }).finally(() => { if (!done) setLoading(false); }); return () => { done = true; }; }, [service.targetPeerId]);
  const name = (route: ServiceRoute) => entries.find(item => item.targetPeerId === route.targetPeerId)?.label || new URL(route.url).host;
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (failure) { const message = failure instanceof Error ? failure.message : ''; setError(/AUTHORIZATION|DENIED/.test(message) ? '当前设备没有入口管理权限。请让管理员分享备用连接邀请，或使用入口密码授权。' : '暂时无法完成。请确认入口能连接目标服务，且目标地址、证书和授权有效。'); } finally { setBusy(false); } };
  const enable = async (entry: ServiceConnection, secret?: string) => {
    const route = { url: entry.serviceOrigin || entry.url, targetPeerId: entry.targetPeerId! };
    await run(async () => {
      const access = await inspectEntryRoute(route, target.targetPeerId);
      if (!access.grants.some(grant => grant.active)) {
        if (!access.canManage && secret === undefined) { setPasswordEntry(entry); return; }
        await authorizeEntryRoute(target, route, secret);
      }
      const next = [...routes.filter(item => item.targetPeerId !== route.targetPeerId), route];
      await saveServiceRoutes(service, next); setRoutes(next); setPasswordEntry(undefined); setPassword('');
    });
  };
  if (sharing) return <div className="service-form"><p className="service-help">把链接发给需要使用此备用连接的人。它只允许通过入口连接“{service.label}”，对方仍需获得目标服务的访问权限。</p><label className="service-field"><span>备用连接邀请</span><input readOnly value={sharing} onFocus={event => event.target.select()} /></label><button type="button" className="service-button service-primary" onClick={() => { void navigator.clipboard.writeText(sharing).then(() => setCopied(true)).catch(() => setError('无法自动复制，请长按链接复制。')); }}><Copy size={16} />{copied ? '已复制' : '复制邀请链接'}</button><button type="button" className="service-button service-secondary" onClick={() => { setSharing(undefined); setCopied(false); }}>返回备用连接</button>{error && <p role="alert" className="service-error">{error}</p>}</div>;
  if (passwordEntry) return <form className="service-form" onSubmit={event => { event.preventDefault(); void enable(passwordEntry, password).finally(() => setPassword('')); }}><p className="service-help">需要“{passwordEntry.label}”的管理员授权。若这是你的服务，可以使用它的密码；否则请管理员分享备用连接邀请。</p><label className="service-field"><span>入口服务密码</span><input type="password" required value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" disabled={busy} autoFocus /></label><button type="submit" className="service-button service-primary" disabled={busy || !password}>{busy ? '正在授权…' : '授权并启用'}</button><button type="button" className="service-button service-secondary" disabled={busy} onClick={() => { setPasswordEntry(undefined); setPassword(''); }}>取消</button>{error && <p role="alert" className="service-error">{error}</p>}</form>;
  const directRoutes = routes.filter(route => route.targetPeerId === target.targetPeerId);
  const relayRoutes = routes.filter(route => route.targetPeerId !== target.targetPeerId);
  const addAddress = async () => {
    if (busy) return;
    setBusy(true); setAddingAddress(true); setError(''); setNotice('');
    try {
      setRoutes(await addServiceAddress({ ...service, routes }, address));
      setAddress(''); setNotice('备用地址已验证并保存。');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '暂时无法添加地址，请重试。');
    } finally { setBusy(false); setAddingAddress(false); }
  };
  return <div className="service-form">
    <p className="service-help">电脑换了网络？添加它在新网络下的地址，原地址连不上时会自动尝试。只接受同一台服务。</p>
    <form className="service-form" onSubmit={event => { event.preventDefault(); void addAddress(); }}>
      <label className="service-field"><span>备用地址</span><input value={address} onChange={event => { setAddress(event.target.value); setError(''); setNotice(''); }} required disabled={busy || routes.length >= 4} inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="例如：192.168.10.20:9834" /></label>
      <button type="submit" className="service-button service-primary" disabled={busy || routes.length >= 4 || !address.trim()}>{addingAddress ? <><Loader2 size={16} className="service-spinning" />正在验证…</> : '验证并添加'}</button>
    </form>
    {error && <p role="alert" className="service-error">{error}</p>}
    {notice && <p role="status" className="service-help">{notice}</p>}
    {routes.length >= 4 && <p className="service-help">已保存 4 个备用连接。移除不再使用的地址或入口后，可以继续添加。</p>}
    <div><p className="service-help">首选地址</p><p className="service-address">{service.serviceOrigin || service.url}</p></div>
    {directRoutes.length > 0 && <div className="service-list">{directRoutes.map(route => <div className="service-route-item" key={route.url}>
      <div className="service-route-line"><span className="service-address service-route-address">{route.url}</span><button type="button" className="service-icon-button" aria-label={`移除地址 ${route.url}`} disabled={busy} onClick={() => setRemoving(route)}>移除</button></div>
      {removing?.targetPeerId === route.targetPeerId && removing.url === route.url && <div className="service-form"><p className="service-help">从备用连接中移除此地址？不会停止正在运行的终端。</p><div className="service-actions service-actions-pair"><button type="button" className="service-button service-secondary" disabled={busy} onClick={() => setRemoving(undefined)}>取消</button><button type="button" className="service-button service-danger" disabled={busy} onClick={() => void run(async () => { const next = routes.filter(item => item.targetPeerId !== route.targetPeerId || item.url !== route.url); await saveServiceRoutes(service, next); setRoutes(next); setRemoving(undefined); })}>确认移除</button></div></div>}
    </div>)}</div>}
    <details className="service-relay-options">
      <summary>通过其他服务中转{relayRoutes.length ? `（${relayRoutes.length}）` : ''}</summary>
      <div className="service-form">
        <p className="service-help">所有直连地址都不可用时，尝试下方已授权入口；直连恢复后自动切回。</p>
        {relayRoutes.length > 0 && <div className="service-list">{relayRoutes.map(route => <div className="service-route-item" key={route.targetPeerId}><div className="service-route-line"><span className="service-icon"><Server size={18} /></span><span className="service-name">{name(route)}</span><Check size={16} className="service-selected" /></div>{removing?.targetPeerId === route.targetPeerId ? <div className="service-form"><p className="service-help">撤销此设备经“{name(route)}”连接目标的权限？如当前无法直连，目标服务将断开。</p><div className="service-actions service-actions-pair"><button type="button" className="service-button service-secondary" disabled={busy} onClick={() => setRemoving(undefined)}>取消</button><button type="button" className="service-button service-danger" disabled={busy} onClick={() => void run(async () => { await revokeEntryRoute(target.targetPeerId, route); const next = routes.filter(item => item.targetPeerId !== route.targetPeerId); await saveServiceRoutes(service, next); setRoutes(next); setRemoving(undefined); })}>确认撤销</button></div></div> : <div className="service-actions service-actions-pair"><button type="button" className="service-button service-secondary" disabled={busy} onClick={() => void run(async () => { const invitation = await createEntryInvitation(target, route); setSharing(createInviteLink({ v: 1, routeOnly: true, serviceId: target.targetPeerId, name: service.label, serviceUrl: service.serviceOrigin || service.url, entryUrl: route.url, entryServiceId: route.targetPeerId, routeCode: invitation.routeCode })); })}>分享备用连接</button><button type="button" className="service-button service-danger" disabled={busy} onClick={() => setRemoving(route)}>撤销授权</button></div>}</div>)}</div>}
        {loading ? <p role="status" className="service-feedback"><Loader2 size={16} className="service-spinning" />正在读取服务…</p> : <div><p className="service-help">添加中转入口</p>{entries.filter(entry => !routes.some(route => route.targetPeerId === entry.targetPeerId)).map(entry => <button key={entry.id} type="button" className="service-row-open service-full-width" disabled={busy || routes.length >= 4} onClick={() => void enable(entry)}><span className="service-row-copy"><span className="service-name">{entry.label}</span><span className="service-description">验证并授权后启用</span></span><ChevronRight size={16} /></button>)}{entries.length === 0 && <p className="service-empty">添加并登录另一台服务后，可以将它设为中转入口。</p>}</div>}
      </div>
    </details>
    {busy && !addingAddress && <p role="status" className="service-feedback"><Loader2 size={16} className="service-spinning" />正在验证连接与授权…</p>}
  </div>;
}
