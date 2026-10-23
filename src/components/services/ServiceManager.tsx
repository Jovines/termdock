import { LoadingSpinner as Loader2 } from '../../lib/components/ui/Loading';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, ChevronRight, MoreHorizontal, Plus, Server, Smartphone } from 'lucide-react';
import { listServiceConnections, normalizeServiceAddress, observeServiceConnections, removeServiceConnection, sameService, saveServiceConnection, type ServiceConnection } from '../../lib/services/serviceDirectory';
import './ServiceManager.css';
import { useI18n } from '../../lib/i18n';
import { parseInviteLink } from '../../lib/federation/inviteLink';

export interface ServiceNavigation { title?: string; back?: () => void }
export interface ServiceManagerProps {
  initialServicePage?: { kind: 'edit' | 'routes'; service: ServiceConnection };
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
  certificateTrust?: {
    listPins: () => Promise<Record<string, string>>;
    inspect: (origin: string) => Promise<{ origin: string; fingerprint: string; trustedFingerprint?: string; receipt: string }>;
    trust: (origin: string, fingerprint: string, receipt: string) => Promise<unknown>;
    discard: (receipt: string) => Promise<void>;
    revoke: (origin: string) => Promise<void>;
  };
}
type Page = { kind: 'list' } | { kind: 'add'; input?: string; passwordRequired?: boolean } | { kind: 'edit'; service: ServiceConnection } | { kind: 'routes' | 'relay-services'; service: ServiceConnection };
type CertificateReview = { origin: string; fingerprint: string; trustedFingerprint?: string; receipt: string; retry: () => Promise<{ passwordRequired?: boolean } | void>; changed: boolean; confirmed: boolean; generation: number; retryInput: string };
export function ServiceManager({ current, renderRoutes, renderRelayServices, onOpen, onAdd, onInvite, hideHeader, onNavigation, onBusyChange, initiallyAdding = false, initialServicePage, certificateTrust }: ServiceManagerProps) {
  const { t } = useI18n();
  const validateInput = (input: string) => {
    try {
      if (input.includes('#termdock-invite=')) parseInviteLink(input);
      else normalizeServiceAddress(input);
    } catch {
      throw new Error(t(input.includes('#termdock-invite=') ? 'login.invalidInvitation' : 'login.invalidAddress'));
    }
  };
  const onValidate = (input: string) => {
    try { validateInput(input); return true; }
    catch (failure) { setError((failure as Error).message); return false; }
  };
  const [services, setServices] = useState<ServiceConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>(initialServicePage || (initiallyAdding ? { kind: 'add' } : { kind: 'list' }));
  const [busy, setBusyState] = useState(false);
  const setBusy = useCallback((value: boolean) => { setBusyState(value); onBusyChange?.(value); }, [onBusyChange]);
  const [error, setError] = useState('');
  const [certificateReview, setCertificateReview] = useState<CertificateReview>();
  const [certificatePins, setCertificatePins] = useState<Record<string, string>>({});
  const certificateGeneration = useRef(0);
  const certificateReceipt = useRef<string>();
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const ownerIsCurrent = (generation: number) => mounted.current && certificateGeneration.current === generation;
  const clearCertificateReceipt = (expected?: string) => { if (!expected || certificateReceipt.current === expected) certificateReceipt.current = undefined; };
  const discardCertificateReceipt = () => {
    const receipt = certificateReceipt.current;
    if (receipt) void certificateTrust?.discard(receipt).catch(() => {}).finally(() => clearCertificateReceipt(receipt));
  };
  const cancelCertificateReview = () => { certificateGeneration.current++; discardCertificateReceipt(); setCertificateReview(undefined); };
  const cancelReviewRef = useRef(cancelCertificateReview); cancelReviewRef.current = cancelCertificateReview;
  const back = useCallback(() => { cancelReviewRef.current(); setPage(previous => previous.kind === 'routes' || previous.kind === 'relay-services' ? { kind: 'edit', service: previous.service } : { kind: 'list' }); setError(''); }, []);
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
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; certificateGeneration.current++; discardCertificateReceipt(); }; }, []);
  useEffect(() => { cancelCertificateReview(); }, [current?.id, current?.url, current?.targetPeerId]);
  useEffect(() => { const generation = certificateGeneration.current; if (certificateTrust) void certificateTrust.listPins().then(pins => { if (ownerIsCurrent(generation)) setCertificatePins(pins); }).catch(() => {}); }, [certificateTrust]);
  const openWithCertificateReview = async (origin: string, retry: () => Promise<{ passwordRequired?: boolean } | void>, retryInput = origin) => {
    cancelCertificateReview();
    const generation = certificateGeneration.current;
    const pendingReview: { passwordRequired?: boolean; certificateReviewRequired: true } = { certificateReviewRequired: true };
    try { const result = await retry(); return ownerIsCurrent(generation) ? result : pendingReview; }
    catch (failure) {
      if (!ownerIsCurrent(generation)) return pendingReview;
      if (!certificateTrust || !['PREVIEW_DISCOVERY_FAILED', 'PREVIEW_CERTIFICATE_REJECTED'].includes((failure as { code?: string })?.code || '')) throw failure;
      try {
        const observed = await certificateTrust.inspect(origin);
        if (observed.origin !== origin || !/^[a-f0-9]{64}$/i.test(observed.fingerprint) || !observed.receipt) throw new Error('Invalid certificate inspection result');
        if (ownerIsCurrent(generation)) {
          certificateReceipt.current = observed.receipt;
          setCertificateReview({ origin, fingerprint: observed.fingerprint, trustedFingerprint: observed.trustedFingerprint, receipt: observed.receipt, retry, retryInput, changed: !!observed.trustedFingerprint && observed.trustedFingerprint.toLowerCase() !== observed.fingerprint.toLowerCase(), confirmed: false, generation });
        } else { void certificateTrust.discard(observed.receipt).catch(() => {}); }
      } catch {
        if (ownerIsCurrent(generation)) setError('无法读取此地址的 HTTPS 证书。请检查地址和网络后重试。');
      }
      return { certificateReviewRequired: true } as { passwordRequired?: boolean; certificateReviewRequired: true };
    }
  };
  const acceptCertificateAndRetry = async () => {
    const review = certificateReview;
    if (!review || !review.confirmed || !certificateTrust) return;
    await perform(async () => {
      try {
        if (!ownerIsCurrent(review.generation)) return;
        await certificateTrust.trust(review.origin, review.fingerprint, review.receipt);
        clearCertificateReceipt(review.receipt);
        if (!ownerIsCurrent(review.generation)) return;
        const updatedPins = await certificateTrust.listPins();
        if (!ownerIsCurrent(review.generation)) return;
        setCertificatePins(updatedPins);
        setCertificateReview(undefined);
        if (!ownerIsCurrent(review.generation)) return;
        const result = await review.retry();
        if (!ownerIsCurrent(review.generation)) return;
        if (result?.passwordRequired) setPage({ kind: 'add', input: review.retryInput, passwordRequired: true });
        else setPage({ kind: 'list' });
      } catch (failure) {
        clearCertificateReceipt(review.receipt);
        if ((failure as { code?: string })?.code === 'PREVIEW_CERTIFICATE_CHANGED' && ownerIsCurrent(review.generation)) {
          setCertificateReview(undefined);
          try {
            const updated = await certificateTrust.inspect(review.origin);
            if (updated.origin !== review.origin || !/^[a-f0-9]{64}$/i.test(updated.fingerprint) || !updated.receipt) throw new Error('Invalid certificate inspection result');
            if (ownerIsCurrent(review.generation)) { certificateReceipt.current = updated.receipt; setCertificateReview({ ...review, fingerprint: updated.fingerprint, trustedFingerprint: updated.trustedFingerprint, receipt: updated.receipt, changed: true, confirmed: false }); }
            else void certificateTrust.discard(updated.receipt).catch(() => {});
            if (ownerIsCurrent(review.generation)) setError('证书在确认期间发生变化。请重新核对新指纹后再决定是否信任。');
          } catch { if (ownerIsCurrent(review.generation)) setError('证书在确认期间发生变化，且无法重新读取。请稍后重试。'); }
          return;
        }
        if (ownerIsCurrent(review.generation)) { setCertificateReview(undefined); throw failure; }
      }
    });
  };
  const perform = async (task: () => Promise<void>) => {
    if (busyRef.current || !mounted.current) return;
    busyRef.current = true;
    setBusy(true); setError('');
    let generation = certificateGeneration.current;
    try { const pending = task(); generation = certificateGeneration.current; await pending; } catch (failure) { if (ownerIsCurrent(generation)) setError(failure instanceof Error ? failure.message : '暂时无法完成，请重试。'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
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
          <button type="button" className="service-row-open" disabled={busy || selected} onClick={() => void perform(async () => { const result = await openWithCertificateReview(service.serviceOrigin || service.url, () => onOpen(service)); if (result?.passwordRequired) setPage({ kind: 'add', input: service.serviceOrigin || service.url, passwordRequired: true }); })} aria-label={selected ? `当前服务 ${service.label}` : `打开 ${service.label}`}>
            <span className="service-icon"><Server size={20} /></span>
            <span className="service-row-copy"><span className="service-name">{service.label}</span><span className="service-description">{selected ? '当前服务' : new URL(service.serviceOrigin || service.url).host}</span></span>
            {selected ? <Check size={17} className="service-selected" /> : <ChevronRight size={16} className="service-muted" />}
          </button>
      <button type="button" className="service-icon-button" aria-label={`管理 ${service.label}`} disabled={busy} onClick={() => { cancelCertificateReview(); setPage({ kind: 'edit', service }); setError(''); }}><MoreHorizontal size={19} /></button>
        </div>;
      })}
      {rows.length === 0 && <p className="service-empty">还没有添加服务。连接你的电脑，或粘贴收到的邀请链接。</p>}
    </div>}
    <div className={`service-actions${onInvite ? ' service-actions-pair' : ''}`}>
      <button type="button" className="service-button service-secondary" disabled={busy} onClick={() => { cancelCertificateReview(); setPage({ kind: 'add' }); setError(''); }}><Plus size={16} />添加服务</button>
      {onInvite && <button type="button" className="service-button service-secondary" disabled={busy} onClick={onInvite}><Smartphone size={16} />邀请设备</button>}
    </div>
  </>;
  return <div className="service-manager">
    {!hideHeader && <div className="service-heading">{title && <button type="button" className="service-icon-button" aria-label="返回服务" disabled={busy} onClick={back}><ArrowLeft size={20} /></button>}<h2>{title || '服务'}</h2></div>}
    {page.kind === 'relay-services' ? renderRelayServices?.(pageService!, setBusy) : page.kind === 'routes' ? renderRoutes?.(pageService!, setBusy) : page.kind === 'list' ? list : page.kind === 'add' ? <AddServiceForm onValidate={onValidate} onSave={input => perform(async () => { cancelCertificateReview(); const url = normalizeServiceAddress(input); setServices(await saveServiceConnection({ id: url, url, label: new URL(url).host })); back(); })} onTargetChange={cancelCertificateReview} initialInput={page.input} passwordRequired={page.passwordRequired} busy={busy} onSubmit={async (input, password) => {
      let result: { passwordRequired?: boolean; certificateReviewRequired?: boolean } | void;
      await perform(async () => { const origin = input.includes('#termdock-invite=') ? parseInviteLink(input).serviceOrigin || parseInviteLink(input).url : normalizeServiceAddress(input); result = await openWithCertificateReview(origin, () => onAdd(input, password), input); if (!result?.passwordRequired && !(result as { certificateReviewRequired?: boolean } | undefined)?.certificateReviewRequired) back(); });
      return result!;
    }} /> : <EditServiceForm onRelayServices={renderRelayServices && page.service.targetPeerId ? () => setPage({ kind: 'relay-services', service: page.service }) : undefined} onRoutes={renderRoutes && page.service.targetPeerId ? () => setPage({ kind: 'routes', service: page.service }) : undefined} service={pageService!} busy={busy} canRemove={!current || !sameService(page.service, current)} onSave={name => void perform(async () => { setServices(await saveServiceConnection({ ...pageService!, label: name })); back(); })} onRemove={() => void perform(async () => { setServices(await removeServiceConnection(page.service.id)); back(); })} />}
    {certificateReview && <section className="service-certificate-review" aria-label="HTTPS 证书确认">
      <h3>检查 HTTPS 证书</h3><p>{certificateReview.origin}</p>
      {certificateReview.changed && <p role="alert">当前证书与已保存的信任指纹不同。请通过独立可信渠道重新核对，再决定是否更新信任。</p>}
      <p>请通过独立可信渠道向服务管理员核对以下 SHA-256 指纹。仅查看指纹不会信任证书。</p>
      <code>{certificateReview.fingerprint.match(/.{1,2}/g)?.join(':').toUpperCase()}</code>
      {certificateReview.trustedFingerprint && <p>已保存的指纹：<code>{certificateReview.trustedFingerprint.match(/.{1,2}/g)?.join(':').toUpperCase()}</code></p>}
      <label><input type="checkbox" checked={certificateReview.confirmed} disabled={busy} onChange={event => setCertificateReview(value => value ? { ...value, confirmed: event.target.checked } : value)} />我已通过独立可信渠道核对该指纹，并明确同意仅对此精确 HTTPS 地址信任。</label>
      <div className="service-actions service-actions-pair"><button type="button" className="service-button service-secondary" onClick={cancelCertificateReview}>取消</button><button type="button" className="service-button service-primary" disabled={busy || !certificateReview.confirmed} onClick={() => void acceptCertificateAndRetry()}>信任此指纹并重试一次</button></div>
    </section>}
    {certificateTrust && Object.keys(certificatePins).length > 0 && <details className="service-certificate-pins"><summary>已信任的 HTTPS 证书（{Object.keys(certificatePins).length}）</summary>{Object.entries(certificatePins).map(([origin, fingerprint]) => <div key={origin}><p>{origin}<br /><code>{fingerprint.match(/.{1,2}/g)?.join(':').toUpperCase()}</code></p><button type="button" className="service-button service-secondary" disabled={busy} onClick={() => void perform(async () => { const generation = certificateGeneration.current; await certificateTrust.revoke(origin); if (!ownerIsCurrent(generation)) return; const pins = await certificateTrust.listPins(); if (ownerIsCurrent(generation)) setCertificatePins(pins); })}>撤销信任</button></div>)}</details>}
    {error && <p className="service-error" role="alert">{error}</p>}
  </div>;
}
function AddServiceForm({ onValidate, busy, onSubmit, onSave, onTargetChange, initialInput = '', passwordRequired = false }: { onValidate: (input: string) => boolean; onSave: (input: string) => Promise<void>; onTargetChange: () => void; initialInput?: string; passwordRequired?: boolean; busy: boolean; onSubmit: (input: string, password?: string) => Promise<{ passwordRequired?: boolean; certificateReviewRequired?: boolean } | void> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const validate = () => { if (onValidate(input.trim())) return true; inputRef.current?.focus(); return false; };
  const [input, setInput] = useState(initialInput); const [password, setPassword] = useState(''); const [needsPassword, setNeedsPassword] = useState(passwordRequired);
  return <form className="service-form" onSubmit={async event => { event.preventDefault(); if (busy || !validate()) return; const result = await onSubmit(input.trim(), needsPassword ? password : undefined); if (result?.passwordRequired) setNeedsPassword(true); setPassword(''); }}>
    <label className="service-field"><span>服务地址或邀请链接</span><input ref={inputRef} value={input} onChange={event => { onTargetChange(); setInput(event.target.value); setNeedsPassword(false); setPassword(''); }} disabled={busy} required autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="例如：电脑地址:9834 或 https://…" /></label>
    {needsPassword ? <label className="service-field"><span>服务密码</span><input type="password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} required autoFocus autoComplete="current-password" placeholder="输入这台服务的密码" /></label> : <p className="service-help">连接自己的服务，输入地址即可；收到邀请时，粘贴完整链接。</p>}
    <button type="button" className="service-button service-secondary" disabled={busy || !input.trim() || input.includes("#termdock-invite=")} onClick={() => { if (validate()) void onSave(input.trim()); }}>仅保存，不连接</button>
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
