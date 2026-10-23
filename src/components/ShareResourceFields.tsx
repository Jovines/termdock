import { createPortal } from 'react-dom';
import { useRef } from 'react';
import { useKeyboardLayer } from '../lib/hooks/useKeyboardLayer';
import { useEffect, useState } from 'react';
import { Folder, Monitor, RefreshCw, Smartphone, X } from 'lucide-react';
import type { ShareResources } from '../server/shared/shareResources';
import { listAndroidDevices, type AndroidDevice } from '../lib/android/api';
import { computerPreferences, type ComputerProfile } from '../lib/computer/preferences';
import { FileTree } from '../lib/components/sidebar/FileTree';
import { useSidebarStore } from '../lib/stores/useSidebarStore';
const select = 'min-h-11 rounded-lg border border-border bg-background px-2 text-sm';
const action = 'min-h-11 rounded-lg px-3 text-sm hover:bg-surface-2 disabled:opacity-50';
export function ShareResourceFields({ value, onChange }: { value: ShareResources; onChange: (value: ShareResources) => void }) {
  const [phones, setPhones] = useState<AndroidDevice[]>([]);
  const [computers, setComputers] = useState<ComputerProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [directory, setDirectory] = useState('');
  const [browse, setBrowse] = useState(false);
  const browserPanel = useRef<HTMLDivElement>(null);
  useKeyboardLayer(browserPanel, browse, () => setBrowse(false));
  const [browseRoot, setBrowseRoot] = useState(() => useSidebarStore.getState().rootPath || '/');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    void Promise.allSettled([listAndroidDevices(), fetch('/api/computer/preferences').then(async response => { if (!response.ok) throw new Error(); return response.json(); })]).then(([android, desktop]) => {
      if (!active) return;
      if (android.status === 'fulfilled') setPhones(android.value.devices);
      if (desktop.status === 'fulfilled') { const p = computerPreferences(desktop.value.preferences); setComputers([p.local, p.remote].filter((p, i, all) => p.host && all.findIndex(c => c.host === p.host && c.protocol === p.protocol && c.port === p.port) === i)); }
      if (android.status === 'rejected' || desktop.status === 'rejected') setError('部分设备暂时无法读取，可重试；目录分享仍可配置。');
      setLoading(false);
    });
    return () => { active = false; };
  }, [retry]);
  const addDirectory = () => {
    const path = directory.trim().replace(/\/+$/, '') || (directory.trim() === '/' ? '/' : '');
    if (!path || (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path))) { setError('请填写完整目录路径。'); return; }
    if (!value.directories?.some(d => d.path === path)) onChange({ ...value, directories: [...value.directories ?? [], { path, access: 'read' }] });
    setDirectory(''); setError('');
  };
  if (browse) return createPortal(<div className="fixed inset-0 z-popover flex items-end justify-center bg-[var(--app-backdrop)] p-3 backdrop-blur-sm sm:items-center" onMouseDown={e => { if (e.target === e.currentTarget) setBrowse(false); }}><div ref={browserPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="选择共享目录" className="flex max-h-[min(80dvh,640px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-xl outline-none"><div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2"><span className="text-sm font-medium">选择共享目录</span><button type="button" className={action} onClick={() => setBrowse(false)}>取消</button></div><p className="shrink-0 break-all px-4 py-3 text-xs text-muted-foreground">{browseRoot}</p><div className="min-h-0 flex-1 overflow-auto"><FileTree rootPath={browseRoot} directoriesOnly selectedFilePath={null} onFileSelect={() => {}} onDirectoryRoot={setBrowseRoot} /></div><div className="shrink-0 border-t border-border p-3 pb-[max(12px,env(safe-area-inset-bottom))]"><button type="button" className={`${action} w-full bg-primary text-primary-foreground`} onClick={() => { if (!value.directories?.some(d => d.path === browseRoot)) onChange({ ...value, directories: [...value.directories ?? [], { path: browseRoot, access: 'read' }] }); setBrowse(false); }}>共享此目录及其子目录</button></div></div></div>, document.body);

  return <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">附带侧栏功能 <span className="text-xs font-normal text-muted-foreground">可选</span></legend>
    <details className="rounded-xl border border-border px-3"><summary className="min-h-11 cursor-pointer py-3 text-sm"><Smartphone size={15} className="mr-2 inline" />手机设备 <span className="text-muted-foreground">{value.android?.length ? `已选 ${value.android.length} 台` : '未分享'}</span></summary><div className="space-y-2 pb-3">{phones.map(phone => {
      const selected = value.android?.find(p => p.serial === phone.serial);
      return <div key={phone.serial} className="flex flex-wrap items-center gap-2"><label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" checked={!!selected} onChange={e => onChange({ ...value, android: e.target.checked ? [...value.android ?? [], { serial: phone.serial, access: 'view' }] : value.android?.filter(p => p.serial !== phone.serial) })} /><span className="min-w-0 break-all">{phone.model || phone.serial}<span className="block text-xs text-muted-foreground">{phone.state === 'device' ? '已连接' : '离线或尚未授权'}</span></span></label>{selected && <select className={select} aria-label={`${phone.model || phone.serial}权限`} value={selected.access} onChange={e => onChange({ ...value, android: value.android?.map(p => p.serial === phone.serial ? { ...p, access: e.target.value as 'view' | 'control' } : p) })}><option value="view">仅查看</option><option value="control">查看并操作</option></select>}</div>;
    })}{!phones.length && <p className="py-2 text-xs text-muted-foreground">{loading ? '正在查找设备…' : '暂无手机设备，请先在手机侧栏连接设备。'}</p>}</div></details>
    <details className="rounded-xl border border-border px-3"><summary className="min-h-11 cursor-pointer py-3 text-sm"><Monitor size={15} className="mr-2 inline" />电脑 <span className="text-muted-foreground">{value.computers?.length ? `已选 ${value.computers.length} 台` : '未分享'}</span></summary><div className="space-y-2 pb-3">{computers.map(profile => {
      const port = profile.protocol === 'vnc' ? 5900 : Number(profile.port || 3389), key = `${profile.host}:${port}`;
      const selected = value.computers?.find(c => c.host === profile.host && c.protocol === profile.protocol && c.port === port);
      return <div key={key} className="flex flex-wrap items-center gap-2"><label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" checked={!!selected} onChange={e => onChange({ ...value, computers: e.target.checked ? [...value.computers ?? [], { host: profile.host, protocol: profile.protocol, port, access: 'view' }] : value.computers?.filter(c => c !== selected) })} /><span className="break-all">{profile.host === '127.0.0.1' ? '服务所在电脑' : profile.host}<span className="block text-xs text-muted-foreground">{profile.protocol.toUpperCase()} · {port}</span></span></label>{selected && <select className={select} aria-label={`${profile.host}权限`} value={selected.access} onChange={e => onChange({ ...value, computers: value.computers?.map(c => c === selected ? { ...c, access: e.target.value as 'view' | 'control' } : c) })}><option value="view">仅查看</option><option value="control">查看并操作</option></select>}</div>;
    })}<p className="text-xs leading-5 text-muted-foreground">接收者需使用自己的系统登录凭据。仅查看会在服务端阻止键盘、鼠标和剪贴板输入。</p></div></details>
    <details className="rounded-xl border border-border px-3"><summary className="min-h-11 cursor-pointer py-3 text-sm"><Folder size={15} className="mr-2 inline" />文件目录 <span className="text-muted-foreground">{value.directories?.length ? `已选 ${value.directories.length} 个` : '未分享'}</span></summary><div className="space-y-2 pb-3">{value.directories?.map(root => <div key={root.path} className="rounded-lg bg-surface-2 p-2"><p className="break-all text-xs">{root.path}</p><div className="mt-1 flex items-center justify-between gap-2"><select className={select} aria-label={`${root.path}权限`} value={root.access} onChange={e => onChange({ ...value, directories: value.directories?.map(d => d.path === root.path ? { ...d, access: e.target.value as 'read' | 'write' } : d) })}><option value="read">仅查看与下载</option><option value="write">可修改、上传与删除</option></select><button type="button" className={action} aria-label={`移除${root.path}`} onClick={() => onChange({ ...value, directories: value.directories?.filter(d => d.path !== root.path) })}><X size={16} /></button></div></div>)}<label className="block text-xs text-muted-foreground" htmlFor="share-directory">目录及其所有子目录</label><input id="share-directory" className={`${select} w-full`} placeholder="例如 /home/user/project" value={directory} onChange={e => setDirectory(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDirectory(); } }} /><div className="flex justify-end gap-2"><button type="button" className={action} onClick={() => setBrowse(true)}>浏览目录</button><button type="button" className={action} disabled={!directory.trim()} onClick={addDirectory}>添加目录</button></div><p className="text-xs leading-5 text-muted-foreground">仅开放所选目录及其子目录。跳转到目录外的符号链接不可访问。</p></div></details>
    {error && <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><span>{error}</span><button type="button" className={action} aria-label="重新读取设备" onClick={() => setRetry(r => r + 1)}><RefreshCw size={14} /></button></div>}
  </fieldset>;
}
export function ShareResourceSummary({ resources }: { resources?: ShareResources }) {
  if (!resources) return null;
  return <ul className="space-y-1 text-xs leading-5 text-muted-foreground">{resources.android?.map((d, i) => <li key={`a${i}`}>手机 · {d.serial} · {d.access === 'control' ? '可操作' : '仅查看'}</li>)}{resources.computers?.map((d, i) => <li key={`c${i}`}>电脑 · {d.host}:{d.port} · {d.access === 'control' ? '可操作' : '仅查看'}</li>)}{resources.directories?.map((d, i) => <li key={`f${i}`} className="break-all">文件 · {d.path} · {d.access === 'write' ? '可修改' : '仅查看'}</li>)}</ul>;
}
