import type { DeviceProfile } from '../server/federation/deviceProfile';
import { RelayServices } from './services/RelayServices';
import { DeviceAuthorizationRequired } from '../lib/federation/deviceAuthorization';
import { ServiceRoutes } from './services/ServiceRoutes';
import { ServiceManager, type ServiceNavigation } from './services/ServiceManager';
import { saveServiceConnection, type ServiceConnection } from '../lib/services/serviceDirectory';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { toDataURL } from 'qrcode';
import { parseInviteLink } from '../lib/federation/inviteLink';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Copy, Loader2, Monitor, Plus, Pencil, Server, Smartphone, X } from 'lucide-react';

export interface FederationConnection { url: string; targetPeerId: string; pairingCode?: string; serviceName?: string; serviceOrigin?: string; entryServiceId?: string; routeCode?: string; routeOnly?: boolean }
export interface FederationGrantInput {
  subjectId: string;
  scope: { kind: 'service' } | { kind: 'sessions'; sessionIds: string[] };
  actions: string[];
  expiresAt?: number;
}
export interface FederationGrant extends FederationGrantInput { id: string; revokedAt?: number; label?: string; deviceProfile?: DeviceProfile; routeTargetServiceId?: string; routeTargetName?: string }
export interface FederationInviteInput {
  includeBackup?: boolean;
  scope: FederationGrantInput['scope'];
  actions: string[];
  label?: string;
  expiresAt?: number;
}
export interface FederationAccessProps {
  onConnect: (connection: FederationConnection) => void | Promise<void>;
  onClose: () => void;
  onConnectWithPassword?: (connection: FederationConnection, password: string) => Promise<void>;
  onAddService?: (input: string, password?: string) => Promise<{ passwordRequired?: boolean } | void>;
  onOpenService?: (service: ServiceConnection) => Promise<{ passwordRequired?: boolean } | void>;
  currentIdentity?: string;
  currentServiceName?: string;
  currentServiceId?: string;
  currentServiceOrigin?: string;
  loading?: boolean;
  loadError?: string;
  onRetry?: () => void;
  paired?: boolean;
  hasBackup?: boolean;
  initialInvite?: FederationConnection;
  sessions?: { sessionId: string; name: string }[];
  grants?: FederationGrant[];
  /** Legacy integration compatibility; invitations are the normal authorization flow. */
  onGrant?: (grant: FederationGrantInput) => void | Promise<void>;
  onCreateInvite?: (invite: FederationInviteInput) => Promise<{ url: string; expiresAt: number }>;
  onRename?: (subjectId: string, name: string) => Promise<void>;
  onRevoke?: (grantId: string) => void | Promise<void>;
}
const field = 'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm';
const button = 'appearance-none min-h-11 rounded-lg px-3 py-2 text-sm hover:bg-hover focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50';
const primaryButton = `${button} bg-primary text-primary-foreground hover:opacity-90`;
function connectionName(connection: FederationConnection) { return connection.serviceName || new URL(connection.url).hostname; }
function permissionName(actions: string[]) { return actions.includes('service:*') ? '完整权限' : actions.includes('session.input') ? '可操作' : actions.includes('session.view') ? '只读' : actions.includes('route.use') ? '仅中转' : '自定义权限'; }
function DeviceInformation({ profile, subjectId }: { profile?: DeviceProfile; subjectId: string }) {
  return <details className="mt-2 text-xs text-muted-foreground">
    <summary className="cursor-pointer leading-relaxed">{[profile?.model || profile?.hostname || profile?.system, profile?.route, `ID ${subjectId.slice(-8)}`].filter(Boolean).join(' · ')}</summary>
    <dl className="mt-2 space-y-2 rounded-lg bg-surface-2 p-3">
      {([['设备型号', profile?.model], ['主机名称', profile?.hostname], ['操作系统', profile?.system], ['客户端', profile?.client], ['打开方式', profile?.mode], ['处理器', profile?.cpu], ['架构', profile?.arch], ['最近连接路径', profile?.route], ['首次记录', profile?.firstSeenAt ? new Date(profile.firstSeenAt).toLocaleString() : undefined], ['最近连接', profile?.lastSeenAt ? new Date(profile.lastSeenAt).toLocaleString() : undefined], ['设备标识', subjectId]] as const).filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="mt-0.5 select-text break-all text-foreground">{value}</dd></div>)}
      <p className="leading-relaxed">{profile ? '系统、硬件与路径由设备报告；连接时间由服务记录。' : '此设备尚未报告详情，更新客户端并重新连接后可补齐。'}</p>
    </dl>
  </details>;
}
function qrColors() {
  const style = getComputedStyle(document.documentElement);
  const background = style.getPropertyValue('--background').trim(); const foreground = style.getPropertyValue('--foreground').trim();
  const brightness = (color: string) => {
    const rgb = color.replace('#', '');
    return parseInt(rgb.slice(0, 2), 16) * 0.299 + parseInt(rgb.slice(2, 4), 16) * 0.587 + parseInt(rgb.slice(4, 6), 16) * 0.114;
  };
  if (!background || !foreground) throw new Error('Theme unavailable');
  return brightness(background) < brightness(foreground) ? { dark: background, light: foreground } : { dark: foreground, light: background };
}
/** Pairing codes remain in component memory only and are cleared after successful use. */
export function FederationAccess({ onConnect, onClose, onConnectWithPassword, onAddService, onOpenService, currentIdentity, currentServiceName, currentServiceId, currentServiceOrigin, hasBackup = false, paired = false, initialInvite, sessions = [], grants = [], onCreateInvite, onRevoke, onRename, loading = false, loadError, onRetry }: FederationAccessProps) {
  const [initialNeedsPassword, setInitialNeedsPassword] = useState(false);
  const [initialPassword, setInitialPassword] = useState('');
  const [serviceNavigation, setServiceNavigation] = useState<ServiceNavigation>({});
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false); const [adding, setAdding] = useState(!paired);
  const [includeBackup, setIncludeBackup] = useState(true);
  const [preset, setPreset] = useState<'read' | 'write' | 'full'>('read');
  const [resource, setResource] = useState<'all' | 'selected'>('all'); const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [label, setLabel] = useState(''); const [grantExpiry, setGrantExpiry] = useState('');
  const [invitation, setInvitation] = useState<{ url: string; expiresAt: number }>(); const [qr, setQr] = useState('');
  const [tab, setTab] = useState<'services' | 'devices'>('services');
  const [editingDevice, setEditingDevice] = useState<string>();
  const [deviceLabel, setDeviceLabel] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<string>();
  const [selectingSessions, setSelectingSessions] = useState(false);
  const [draftSessionIds, setDraftSessionIds] = useState<string[]>([]);
  const activeGrants = grants.filter(grant => grant.revokedAt === undefined && (!grant.expiresAt || grant.expiresAt > Date.now()));
  const inactiveGrants = grants.filter(grant => !activeGrants.includes(grant));
  const devices = [...new Set(activeGrants.map(grant => grant.subjectId))].map(subjectId => {
    const own = activeGrants.filter(grant => grant.subjectId === subjectId);
    return { subjectId, grants: own, name: subjectId === currentIdentity ? '此设备' : own.find(grant => grant.label)?.label || '未命名设备' };
  }).sort((a, b) => Number(b.subjectId === currentIdentity) - Number(a.subjectId === currentIdentity));
  const overview = !editingDevice && !showDetails && paired && !adding && !inviting && !initialInvite;
  const back = () => { setEditingDevice(undefined); setShowDetails(false); setAdding(false); setInviting(false); setInvitation(undefined); setAdvanced(false); setError(''); setNotice(''); setPendingRevoke(undefined); };
  const beginInvite = () => { setInviting(true); setAdding(false); setAdvanced(false); setError(''); setNotice(''); };
  const deviceName = (grant: FederationGrant) => grant.subjectId === currentIdentity ? '此设备' : grant.label || '未命名设备';
  const dismiss = () => { if (selectingSessions) setSelectingSessions(false); else onClose(); };
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus(); return () => { previous?.focus(); };
  }, []);
  useEffect(() => {
    let canceled = false; setQr('');
    if (invitation) {
      try { void toDataURL(invitation.url, { width: 220, margin: 3, errorCorrectionLevel: 'M', color: qrColors() }).then(data => { if (!canceled) setQr(data); }).catch(() => {}); } catch { /* Copying the invitation remains available. */ }
    }
    return () => { canceled = true; };
  }, [invitation]);
  async function connect(connection: FederationConnection) {
    setBusy(true); setError(''); setNotice('');
    try {
      await onConnect(connection);
      const { url, targetPeerId, serviceName, serviceOrigin } = connection;
      await saveServiceConnection({ id: targetPeerId, url, targetPeerId, label: serviceName || new URL(url).host, serviceOrigin, entryServiceId: connection.entryServiceId });
      setAdding(false); setNotice('已连接。');
    } catch (failure) { if (connection.routeOnly && failure instanceof DeviceAuthorizationRequired) setInitialNeedsPassword(true); else setError('暂时无法连接，请检查网络，或确认邀请是否仍然有效。'); }
    finally { setBusy(false); }
  }
  async function createInvitation(event: FormEvent) {
    event.preventDefault(); if (!onCreateInvite) return; setError(''); setNotice('');
    const selected = selectedIds.filter(id => sessions.some(s => s.sessionId === id));
    if (preset !== 'full' && resource === 'selected' && !selected.length) { setError('请选择至少一个 Session。'); return; }
    const expiresAt = grantExpiry ? new Date(grantExpiry).getTime() : undefined;
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) { setError('授权到期时间必须晚于现在。'); return; }
    setBusy(true);
    try {
      const result = await onCreateInvite({
        ...(hasBackup ? { includeBackup } : {}),
        scope: preset === 'full' || resource === 'all' ? { kind: 'service' } : { kind: 'sessions', sessionIds: selected },
        actions: preset === 'full' ? ['service:*'] : preset === 'write' ? ['session.view', 'session.input', 'session.resize'] : ['session.view'],
        ...(label.trim() ? { label: label.trim() } : {}), ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      setInvitation(result);
    } catch (failure) { setError(failure instanceof Error && failure.message.startsWith('无法分享备用连接：') ? '无法分享备用连接：需要入口管理员授权。你也可以关闭“包含备用连接”，生成直连邀请。' : '暂时无法生成邀请，请确认当前设备有授权管理权限。'); }
    finally { setBusy(false); }
  }
  async function copyInvite() {
    if (!invitation) return;
    try { await navigator.clipboard.writeText(invitation.url); setNotice('邀请链接已复制。'); }
    catch { setError('浏览器未允许复制，请长按下方链接复制。'); }
  }
  const title = serviceNavigation.title || (editingDevice ? '设备名称' : showDetails ? (tab === 'devices' ? '授权详情' : '连接详情') : selectingSessions ? '选择终端' : inviting ? '邀请设备' : adding && paired ? '添加服务' : paired ? '服务与设备' : '连接 Termdock');
  const showBack = !!serviceNavigation.back || !!editingDevice || showDetails || selectingSessions || (paired && (adding || inviting));
  const returnToOverview = () => { if (serviceNavigation.back) { serviceNavigation.back(); return; } if (selectingSessions) setSelectingSessions(false); else back(); };
  const scopeName = (deviceGrants: FederationGrant[]) => deviceGrants.every(grant => grant.routeTargetServiceId) ? `${new Set(deviceGrants.map(grant => grant.routeTargetServiceId)).size} 台服务` : deviceGrants.some(grant => grant.scope.kind === 'service') ? '全部终端' : `${new Set(deviceGrants.flatMap(grant => grant.scope.kind === 'sessions' ? grant.scope.sessionIds : [])).size} 个终端`;
  return createPortal(<div className="fixed inset-0 z-modal-backdrop flex items-end justify-center bg-[var(--app-backdrop)] backdrop-blur-sm sm:items-center sm:p-6" data-sidebar-gesture-ignore onMouseDown={event => { if (event.target === event.currentTarget && !busy) dismiss(); }}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="federation-title" className="z-modal-panel flex max-h-[calc(100dvh-env(safe-area-inset-top)-12px)] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-border bg-surface font-sans text-foreground shadow-xl outline-none sm:max-h-[min(720px,90dvh)] sm:rounded-2xl" onKeyDown={event => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); dismiss(); }
      if (event.key !== 'Tab') return;
      const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"], summary');
      if (!nodes?.length) { event.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }}>
      <header className="shrink-0 border-b border-border px-5 pt-3">
        <div className="flex min-h-12 items-center gap-2 pb-2">
          {showBack && <button type="button" className={`${button} -ml-3 inline-flex w-11 items-center justify-center text-muted-foreground`} disabled={busy} onClick={returnToOverview} aria-label={selectingSessions ? '取消选择终端' : tab === 'devices' ? '返回设备' : '返回服务'}><ArrowLeft size={20} /></button>}
          <h2 id="federation-title" className="min-w-0 flex-1 text-base font-semibold">{title}</h2>
          <button type="button" className={`${button} -mr-3 inline-flex w-11 items-center justify-center text-muted-foreground`} disabled={busy} onClick={dismiss} aria-label="关闭"><X size={20} /></button>
        </div>
        {overview && !serviceNavigation.title && <div className="flex gap-6" role="tablist" aria-label="管理内容">{([['services', '服务'], ['devices', '设备']] as const).map(([value, name]) => <button type="button" key={value} role="tab" aria-selected={tab === value} aria-controls={`federation-${value}`} id={`federation-tab-${value}`} className={`min-h-11 border-b-2 px-1 text-sm transition ${tab === value ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => { setTab(value); setAdvanced(false); setPendingRevoke(undefined); setError(''); setNotice(''); }}>{name}{value === 'devices' && devices.length > 0 && <span className="ml-1.5 text-xs text-muted-foreground">{devices.length}</span>}</button>)}</div>}
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-4 pb-[max(20px,env(safe-area-inset-bottom))]">
        {((overview && tab === 'services') || (adding && !inviting && !initialInvite)) && <ServiceManager renderRelayServices={(service, onBusyChange) => <RelayServices service={service} onBusyChange={onBusyChange} onConnect={onConnect} onConnectWithPassword={onConnectWithPassword} />} renderRoutes={(service, onBusyChange) => <ServiceRoutes service={service} onBusyChange={onBusyChange} />} hideHeader initiallyAdding={adding} current={currentServiceId ? { id: currentServiceId, targetPeerId: currentServiceId, url: currentServiceOrigin || location.origin, label: currentServiceName || '当前服务' } : undefined} onNavigation={setServiceNavigation} onBusyChange={setBusy} onInvite={onCreateInvite ? beginInvite : undefined}
          onOpen={async service => { if (onOpenService) return onOpenService(service); else if (service.targetPeerId) await connect({ ...service, targetPeerId: service.targetPeerId, serviceName: service.label }); else if (onAddService) await onAddService(service.url); }}
          onAdd={async (input, password) => {
            if (onAddService) return onAddService(input, password);
            await connect(parseInviteLink(input));
          }} />}
        {overview && tab === 'devices' && <section role="tabpanel" id="federation-devices" aria-labelledby="federation-tab-devices">
          <p className="mb-2 text-xs leading-relaxed text-muted-foreground">可访问此服务的设备</p>
          {loading ? <p role="status" className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" />正在读取设备…</p> : <div className="divide-y divide-border">{devices.map(device => <div key={device.subjectId} className="py-3">
            <div className="flex items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted-foreground">{/iPhone|iPad|Android|手机|平板/i.test(device.grants.find(grant => grant.label)?.label || (device.subjectId === currentIdentity ? navigator.userAgent : '')) ? <Smartphone size={19} /> : <Monitor size={19} />}</span><div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-1"><p className="truncate text-sm font-medium">{device.name}</p>{onRename && (onRevoke || device.subjectId === currentIdentity) && <button type="button" aria-label={`重命名 ${device.name}`} className="inline-flex h-9 w-9 shrink-0 appearance-none items-center justify-center rounded-lg bg-transparent text-muted-foreground hover:bg-surface-2" onClick={() => { setEditingDevice(device.subjectId); setDeviceLabel(device.grants.find(grant => grant.label)?.label || ''); }}><Pencil size={14} /></button>}</div>{device.subjectId === currentIdentity && device.grants.find(grant => grant.label)?.label && <p className="truncate text-xs text-muted-foreground">{device.grants.find(grant => grant.label)?.label}</p>}<p className="mt-0.5 text-xs text-muted-foreground">{permissionName(device.grants.flatMap(grant => grant.actions))} · {scopeName(device.grants)}</p></div>{onRevoke && device.subjectId !== currentIdentity && pendingRevoke !== device.subjectId && <button type="button" className={`${button} -mr-2 text-xs text-muted-foreground hover:text-destructive`} disabled={busy} aria-label={`撤销 ${device.name} 的访问权限`} onClick={() => setPendingRevoke(device.subjectId)}>撤销</button>}</div>
            <DeviceInformation profile={device.grants.find(grant => grant.deviceProfile)?.deviceProfile} subjectId={device.subjectId} />
            {pendingRevoke === device.subjectId && <div className="mt-3 rounded-lg border border-border bg-background p-3"><p className="text-xs leading-relaxed">撤销后，这台设备将断开连接，需重新邀请才能访问。</p><div className="mt-2 flex justify-end gap-2"><button type="button" className={`${button} text-xs text-muted-foreground`} disabled={busy} onClick={() => setPendingRevoke(undefined)}>取消</button><button type="button" className={`${button} text-xs text-destructive`} disabled={busy} onClick={async () => { setBusy(true); setError(''); try { for (const grant of device.grants) await onRevoke?.(grant.id); setPendingRevoke(undefined); setNotice('设备访问权限已撤销。'); } catch { setError('暂时无法撤销，请重试。'); } finally { setBusy(false); } }}>确认撤销</button></div></div>}
          </div>)}{devices.length === 0 && !loadError && <p className="py-5 text-sm text-muted-foreground">暂无设备授权。{onCreateInvite ? '可通过邀请添加设备。' : ''}</p>}</div>}
          {onCreateInvite && <button type="button" className={`${button} mt-4 inline-flex w-full items-center justify-center gap-2 border border-border text-sm`} disabled={busy} onClick={beginInvite}><Plus size={16} />邀请设备</button>}
          {inactiveGrants.length > 0 && <details className="mt-4 text-xs text-muted-foreground"><summary className="cursor-pointer py-2">已失效的授权（{inactiveGrants.length}）</summary><div className="mt-1 space-y-2 border-l border-border pl-3">{inactiveGrants.map(grant => <p key={grant.id} className="flex gap-3"><span className="min-w-0 flex-1 truncate">{deviceName(grant)}</span><span className="shrink-0">{grant.revokedAt !== undefined ? '已撤销' : '已到期'}</span></p>)}</div></details>}
        </section>}
        {editingDevice && <form className="space-y-4" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await onRename?.(editingDevice, deviceLabel.trim()); setEditingDevice(undefined); } catch { setError('暂时无法保存设备名称，请重试。'); } finally { setBusy(false); } }}>
          <label className="block space-y-2 text-sm"><span>设备名称</span><input autoFocus className={field} maxLength={80} required value={deviceLabel} onChange={event => setDeviceLabel(event.target.value)} placeholder="例如：我的 iPhone、办公室电脑" /></label>
          <p className="text-xs leading-relaxed text-muted-foreground">为设备起一个容易辨认的名字，会同步显示在此服务的设备列表中。</p>
          <button type="submit" className={`${primaryButton} w-full`} disabled={busy || !deviceLabel.trim()}>{busy ? '正在保存…' : '保存名称'}</button>
        </form>}
        {showDetails && <section className="space-y-5">
          {tab === 'devices' ? devices.map(device => <div key={device.subjectId} className="space-y-3">
            <h3 className="text-sm font-medium">{device.name}</h3>
            <dl className="space-y-3 rounded-xl bg-surface-2 p-3 text-xs">
              <div><dt className="text-muted-foreground">访问权限</dt><dd className="mt-1">{permissionName(device.grants.flatMap(grant => grant.actions))} · {scopeName(device.grants)}</dd></div>
              {device.grants.map(grant => <div key={grant.id}><dt className="text-muted-foreground">{grant.routeTargetServiceId ? '允许经此入口访问' : grant.scope.kind === 'sessions' ? '可访问终端' : '有效期'}</dt><dd className="mt-1 leading-relaxed">{grant.routeTargetServiceId ? grant.routeTargetName || '指定服务' : grant.scope.kind === 'sessions' ? grant.scope.sessionIds.map(id => sessions.find(session => session.sessionId === id)?.name || id).join('、') : grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : '保留至撤销'}</dd>{grant.routeTargetServiceId && onRevoke && <button type="button" className={`${button} mt-1 -ml-3 text-xs text-destructive`} disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await onRevoke(grant.id); } catch { setError('暂时无法撤销，请重试。'); } finally { setBusy(false); } }}>撤销此中转权限</button>}</div>)}
              <div><dt className="text-muted-foreground">设备标识</dt><dd className="mt-1 break-all font-mono leading-relaxed text-muted-foreground select-text">{device.subjectId}</dd></div>
            </dl>
          </div>) : <dl className="space-y-4 text-xs"><div><dt className="text-muted-foreground">当前服务</dt><dd className="mt-1 text-sm">{currentServiceName || '当前服务'}</dd></div><div><dt className="text-muted-foreground">服务标识</dt><dd className="mt-1 break-all font-mono leading-relaxed select-text">{currentServiceId}</dd></div><div><dt className="text-muted-foreground">本设备标识</dt><dd className="mt-1 break-all font-mono leading-relaxed select-text">{currentIdentity}</dd></div></dl>}
        </section>}
        {initialInvite && !inviting && <section className="space-y-5 py-1">
          <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-muted-foreground"><Server size={22} /></span><div className="min-w-0"><p className="text-xs text-muted-foreground">你受邀连接</p><p className="mt-1 break-words text-base font-medium">{connectionName(initialInvite)}</p></div></div>
          {initialInvite.routeOnly && <p className="text-xs leading-relaxed text-muted-foreground">此邀请提供备用连接，目标服务仍会验证你的访问权限。</p>}
          {initialNeedsPassword ? <form className="space-y-3" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await onConnectWithPassword?.(initialInvite, initialPassword); } catch (failure) { setError(failure instanceof Error ? failure.message : '暂时无法登录，请重试。'); } finally { setInitialPassword(''); setBusy(false); } }}><label className="block space-y-2 text-sm"><span>目标服务密码</span><input className={field} type="password" required autoFocus autoComplete="current-password" value={initialPassword} onChange={event => setInitialPassword(event.target.value)} /></label><button className={`${primaryButton} w-full`} disabled={busy || !initialPassword}>{busy ? '正在登录…' : '登录并连接'}</button></form> : <button type="button" className={`${primaryButton} w-full text-sm`} disabled={busy} onClick={() => void connect(initialInvite)}>{busy ? '正在连接…' : '接受邀请'}</button>}
        </section>}
        {inviting && !selectingSessions && <section>
          {invitation ? <div className="space-y-4 text-center">
            <p className="text-sm font-medium">用另一台设备扫描二维码</p>
            {qr ? <img src={qr} width={220} height={220} className="mx-auto max-w-full rounded-xl" alt="设备邀请二维码" /> : <div className="mx-auto flex h-48 w-48 items-center justify-center"><Loader2 size={22} className="animate-spin text-muted-foreground" /></div>}
            <p className="text-xs leading-relaxed text-muted-foreground">仅限一台设备使用 · {new Date(invitation.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 前有效</p>
            <button type="button" className={`${primaryButton} inline-flex w-full items-center justify-center gap-2 text-sm`} onClick={() => void copyInvite()}><Copy size={16} />复制邀请链接</button>
            <details className="text-left text-xs text-muted-foreground"><summary className="cursor-pointer py-2">查看链接</summary><p className="mt-2 select-all break-all">{invitation.url}</p></details>
          </div> : <form className="space-y-5" onSubmit={createInvitation}>
            <fieldset><legend className="mb-2 text-sm font-medium">访问权限</legend><div className="space-y-2">{([
              ['read', '仅查看', '查看终端画面，不可输入命令'],
              ['write', '可操作', '查看终端画面，并输入命令'],
              ['full', '完整访问', '包括文件、设置和权限管理'],
            ] as const).map(([value, name, description]) => <label key={value} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition focus-within:ring-2 focus-within:ring-ring ${preset === value ? 'border-primary bg-primary/10' : 'border-border hover:bg-surface-2'}`}>
              <input type="radio" name="federation-permission" value={value} checked={preset === value} onChange={() => setPreset(value)} className="sr-only" />
              <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${preset === value ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background'}`}>{preset === value && <Check size={13} strokeWidth={3} />}</span>
              <span className="min-w-0"><span className="block text-sm font-medium text-foreground">{name}</span><span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span></span>
            </label>)}</div></fieldset>
            {preset !== 'full' && <fieldset><legend className="mb-2 text-sm font-medium">可访问的终端</legend><div className="flex gap-2"><button type="button" aria-pressed={resource === 'all'} className={`${button} flex-1 appearance-none border text-sm ${resource === 'all' ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground'}`} onClick={() => setResource('all')}>全部终端</button><button type="button" aria-pressed={resource === 'selected'} className={`${button} inline-flex flex-1 appearance-none items-center justify-center gap-1 border text-sm ${resource === 'selected' ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground'}`} onClick={() => { setDraftSessionIds(selectedIds); setSelectingSessions(true); }}>{resource === 'selected' ? `已选 ${selectedIds.length} 个` : '选择终端'}<ChevronRight size={14} /></button></div>{resource === 'all' && <p className="mt-2 text-xs text-muted-foreground">包括之后新建的终端。</p>}</fieldset>}
            {preset === 'write' && <p className="text-xs leading-relaxed text-muted-foreground">终端命令可读写该系统用户有权访问的文件。</p>}
            {preset === 'full' && <p className="text-xs leading-relaxed text-muted-foreground">拥有此服务的全部当前及未来权限。仅授予你完全信任的设备。</p>}
            {hasBackup && <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={includeBackup} onChange={event => setIncludeBackup(event.target.checked)} /><span>让新设备也能使用备用连接<span className="mt-1 block text-xs leading-relaxed text-muted-foreground">需要入口管理员授权；关闭后生成直接连接邀请。</span></span></label>}
            <div><button className={`${primaryButton} inline-flex w-full items-center justify-center gap-2 text-sm`} type="submit" disabled={busy || loading}>{busy && <Loader2 size={16} className="animate-spin" />}{busy ? '正在生成…' : '生成邀请'}</button><p className="mt-2 text-center text-xs leading-relaxed text-muted-foreground">链接 10 分钟内有效 · 访问权限{grantExpiry ? '按设定时间到期' : '保留至撤销'}</p></div>
          </form>}
        </section>}
        {selectingSessions && <section><p className="mb-3 text-xs text-muted-foreground">仅允许访问勾选的终端。</p><div className="space-y-1">{sessions.map(session => <label key={session.sessionId} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-surface-2"><input type="checkbox" className="h-4 w-4 accent-primary" checked={draftSessionIds.includes(session.sessionId)} onChange={event => setDraftSessionIds(event.target.checked ? [...draftSessionIds, session.sessionId] : draftSessionIds.filter(id => id !== session.sessionId))} /><span className="min-w-0 break-words">{session.name}</span></label>)}{!sessions.length && <p className="py-4 text-sm text-muted-foreground">当前没有可共享的终端。</p>}</div></section>}
        {loadError && <p role="alert" className="mt-4 text-sm text-destructive">{loadError}{onRetry && <button type="button" className={`${button} ml-1 text-sm underline`} onClick={onRetry}>重试</button>}</p>}
        {!serviceNavigation.title && !adding && !editingDevice && !showDetails && !selectingSessions && !invitation && <div className="mt-4 border-t border-border pt-2"><button type="button" className={`${button} -ml-3 inline-flex items-center gap-1 bg-transparent text-xs text-muted-foreground`} aria-expanded={overview ? undefined : advanced} onClick={() => overview ? setShowDetails(true) : setAdvanced(value => !value)}>{inviting ? '有效期与备注' : adding ? '手动连接' : tab === 'devices' ? '授权详情' : '连接详情'}{overview ? <ChevronRight size={14} /> : <ChevronDown size={13} className={advanced ? 'rotate-180' : ''} />}</button>
          {advanced && <section className="space-y-3 pb-1 pt-2">
            {inviting && <><label className="block space-y-1 text-sm"><span>设备备注（可选）</span><input className={field} value={label} onChange={event => setLabel(event.target.value)} placeholder="例如：工作电脑" /></label><label className="block space-y-1 text-sm"><span>授权到期时间</span><input type="datetime-local" className={field} value={grantExpiry} onChange={event => setGrantExpiry(event.target.value)} /></label></>}
            {!inviting && currentIdentity && <p className="break-all text-xs leading-relaxed text-muted-foreground">本设备身份：{currentIdentity}</p>}


          </section>}
        </div>}
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}{notice && <p role="status" className="mt-3 text-sm text-muted-foreground">{notice}</p>}
      </div>
      {selectingSessions && <footer className="shrink-0 border-t border-border px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]"><button type="button" className={`${primaryButton} w-full text-sm`} disabled={!draftSessionIds.length} onClick={() => { setSelectedIds(draftSessionIds); setResource('selected'); setSelectingSessions(false); }}>使用所选终端（{draftSessionIds.length}）</button></footer>}
    </div>
  </div>, document.body);
}
export default FederationAccess;
