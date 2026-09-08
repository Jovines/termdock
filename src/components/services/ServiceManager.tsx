import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, ChevronRight, Loader2, MoreHorizontal, Plus, Server, Smartphone } from 'lucide-react';
import { listServiceConnections, observeServiceConnections, removeServiceConnection, sameService, saveServiceConnection, type ServiceConnection } from '../../lib/services/serviceDirectory';
import './ServiceManager.css';

export interface ServiceNavigation { title?: string; back?: () => void }
export interface ServiceManagerProps {
  current?: ServiceConnection;
  renderRelayServices?: (service: ServiceConnection, onBusy: (busy: boolean) => void) => ReactNode;
  renderRoutes?: (service: ServiceConnection, onBusy: (busy: boolean) => void) => ReactNode;
  onOpen: (service: ServiceConnection) => Promise<{ passwordRequired?: boolean } | void>;
  onAdd: (input: string, password?: string) => Promise<{ passwordRequired?: boolean } | void>;
  onInvite?: () => void;
  hideHeader?: boolean;
  onNavigation?: (navigation: ServiceNavigation) => void;
  onBusyChange?: (busy: boolean) => void;
  initiallyAdding?: boolean;
}
type Page = { kind: 'list' } | { kind: 'add'; input?: string; passwordRequired?: boolean } | { kind: 'edit'; service: ServiceConnection } | { kind: 'routes' | 'relay-services'; service: ServiceConnection };
export function ServiceManager({ current, renderRoutes, renderRelayServices, onOpen, onAdd, onInvite, hideHeader, onNavigation, onBusyChange, initiallyAdding = false }: ServiceManagerProps) {
  const [services, setServices] = useState<ServiceConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>(initiallyAdding ? { kind: 'add' } : { kind: 'list' });
  const [busy, setBusyState] = useState(false);
  const setBusy = useCallback((value: boolean) => { setBusyState(value); onBusyChange?.(value); }, [onBusyChange]);
  const [error, setError] = useState('');
  const back = useCallback(() => { setPage(previous => previous.kind === 'routes' || previous.kind === 'relay-services' ? { kind: 'edit', service: previous.service } : { kind: 'list' }); setError(''); }, []);
  const title = page.kind === 'add' ? '添加服务' : page.kind === 'edit' ? '服务设置' : page.kind === 'routes' ? '备用连接' : page.kind === 'relay-services' ? '可中转的服务' : undefined;
  useEffect(() => { onNavigation?.({ title, ...(title ? { back } : {}) }); }, [title, back, onNavigation]);
  useEffect(() => {
    let disposed = false, request = 0;
    const refresh = async () => {
      const generation = ++request;
      try { const result = await listServiceConnections(); if (!disposed && request === generation) { setServices(result); setError(''); } }
      catch { if (!disposed && request === generation) setError('暂时无法读取服务列表，请重试。'); }
      finally { if (!disposed && request === generation) setLoading(false); }
    };
    void refresh(); const unsubscribe = observeServiceConnections(() => void refresh());
    return () => { disposed = true; unsubscribe(); };
  }, []);
  const perform = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await task(); } catch (failure) { setError(failure instanceof Error ? failure.message : '暂时无法完成，请重试。'); }
    finally { setBusy(false); }
  };
  const pageService = page.kind === 'edit' || page.kind === 'routes' || page.kind === 'relay-services' ? services.find(item => sameService(item, page.service)) || page.service : undefined;
  const currentRecord = current ? services.find(item => sameService(item, current)) || current : undefined;
  const others = services.filter(item => !current || !sameService(item, current));
  const rows = currentRecord ? [currentRecord, ...others] : others;
  const list = <>
    {loading ? <p className="service-feedback" role="status"><Loader2 size={16} className="service-spinning" />正在读取服务…</p> : <div className="service-list">
      {rows.map(service => {
        const selected = !!current && sameService(service, current);
        return <div className="service-row" key={service.id}>
          <button type="button" className="service-row-open" disabled={busy || selected} onClick={() => void perform(async () => { const result = await onOpen(service); if (result?.passwordRequired) setPage({ kind: 'add', input: service.serviceOrigin || service.url, passwordRequired: true }); })} aria-label={selected ? `当前服务 ${service.label}` : `打开 ${service.label}`}>
            <span className="service-icon"><Server size={20} /></span>
            <span className="service-row-copy"><span className="service-name">{service.label}</span><span className="service-description">{selected ? '当前服务' : new URL(service.serviceOrigin || service.url).host}</span></span>
            {selected ? <Check size={17} className="service-selected" /> : <ChevronRight size={16} className="service-muted" />}
          </button>
          <button type="button" className="service-icon-button" aria-label={`管理 ${service.label}`} disabled={busy} onClick={() => { setPage({ kind: 'edit', service }); setError(''); }}><MoreHorizontal size={19} /></button>
        </div>;
      })}
      {rows.length === 0 && <p className="service-empty">还没有添加服务。连接你的电脑，或粘贴收到的邀请链接。</p>}
    </div>}
    <div className={`service-actions${onInvite ? ' service-actions-pair' : ''}`}>
      <button type="button" className="service-button service-secondary" disabled={busy} onClick={() => { setPage({ kind: 'add' }); setError(''); }}><Plus size={16} />添加服务</button>
      {onInvite && <button type="button" className="service-button service-secondary" disabled={busy} onClick={onInvite}><Smartphone size={16} />邀请设备</button>}
    </div>
  </>;
  return <div className="service-manager">
    {!hideHeader && <div className="service-heading">{title && <button type="button" className="service-icon-button" aria-label="返回服务" disabled={busy} onClick={back}><ArrowLeft size={20} /></button>}<h2>{title || '服务'}</h2></div>}
    {page.kind === 'relay-services' ? renderRelayServices?.(pageService!, setBusy) : page.kind === 'routes' ? renderRoutes?.(pageService!, setBusy) : page.kind === 'list' ? list : page.kind === 'add' ? <AddServiceForm initialInput={page.input} passwordRequired={page.passwordRequired} busy={busy} onSubmit={async (input, password) => {
      let result: { passwordRequired?: boolean } | void;
      await perform(async () => { result = await onAdd(input, password); if (!result?.passwordRequired) back(); });
      return result!;
    }} /> : <EditServiceForm onRelayServices={renderRelayServices && page.service.targetPeerId ? () => setPage({ kind: 'relay-services', service: page.service }) : undefined} onRoutes={renderRoutes && page.service.targetPeerId ? () => setPage({ kind: 'routes', service: page.service }) : undefined} service={pageService!} busy={busy} canRemove={!current || !sameService(page.service, current)} onSave={name => void perform(async () => { setServices(await saveServiceConnection({ ...pageService!, label: name })); back(); })} onRemove={() => void perform(async () => { setServices(await removeServiceConnection(page.service.id)); back(); })} />}
    {error && <p className="service-error" role="alert">{error}</p>}
  </div>;
}
function AddServiceForm({ busy, onSubmit, initialInput = '', passwordRequired = false }: { initialInput?: string; passwordRequired?: boolean; busy: boolean; onSubmit: (input: string, password?: string) => Promise<{ passwordRequired?: boolean } | void> }) {
  const [input, setInput] = useState(initialInput); const [password, setPassword] = useState(''); const [needsPassword, setNeedsPassword] = useState(passwordRequired);
  return <form className="service-form" onSubmit={async event => { event.preventDefault(); const result = await onSubmit(input.trim(), needsPassword ? password : undefined); if (result?.passwordRequired) setNeedsPassword(true); setPassword(''); }}>
    <label className="service-field"><span>服务地址或邀请链接</span><input value={input} onChange={event => { setInput(event.target.value); setNeedsPassword(false); setPassword(''); }} disabled={busy} required autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="例如：电脑地址:9834 或 https://…" /></label>
    {needsPassword ? <label className="service-field"><span>服务密码</span><input type="password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} required autoFocus autoComplete="current-password" placeholder="输入这台服务的密码" /></label> : <p className="service-help">连接自己的服务，输入地址即可；收到邀请时，粘贴完整链接。</p>}
    <button type="submit" className="service-button service-primary" disabled={busy || !input.trim() || (needsPassword && !password)}>{busy ? <><Loader2 size={16} className="service-spinning" />正在连接…</> : needsPassword ? '登录并连接' : '继续'}</button>
  </form>;
}
function EditServiceForm({ service, busy, canRemove, onSave, onRemove, onRoutes, onRelayServices }: { onRelayServices?: () => void; onRoutes?: () => void; service: ServiceConnection; busy: boolean; canRemove: boolean; onSave: (name: string) => void; onRemove: () => void }) {
  const [name, setName] = useState(service.label); const [confirmRemove, setConfirmRemove] = useState(false);
  return <form className="service-form" onSubmit={event => { event.preventDefault(); onSave(name.trim()); }}>
    <label className="service-field"><span>服务名称</span><input value={name} onChange={event => setName(event.target.value)} disabled={busy} required maxLength={120} placeholder="例如：办公室电脑" /></label>
    <p className="service-address">{service.serviceOrigin || service.url}</p>
    <button type="submit" className="service-button service-primary" disabled={busy || !name.trim()}>保存名称</button>
    {onRelayServices && <button type="button" className="service-row-open" disabled={busy} onClick={onRelayServices}><span className="service-row-copy"><span className="service-name">可中转的服务</span><span className="service-description">通过这台服务连接其他电脑</span></span><ChevronRight size={16} /></button>}
    {onRoutes && <button type="button" className="service-row-open" disabled={busy} onClick={onRoutes}><span className="service-row-copy"><span className="service-name">备用连接</span><span className="service-description">添加其他网络地址或授权入口</span></span><ChevronRight size={16} /></button>}
    {canRemove && <div className="service-remove">{confirmRemove ? <><p className="service-help">从列表移除“{service.label}”？不会停止服务或删除终端。</p><div className="service-actions service-actions-pair"><button type="button" className="service-button service-secondary" disabled={busy} onClick={() => setConfirmRemove(false)}>取消</button><button type="button" className="service-button service-danger" disabled={busy} onClick={onRemove}>确认移除</button></div></> : <button type="button" className="service-button service-danger" disabled={busy} onClick={() => setConfirmRemove(true)}>移除服务</button>}</div>}
  </form>;
}
