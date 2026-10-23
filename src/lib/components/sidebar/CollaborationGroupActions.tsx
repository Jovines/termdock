import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ChevronRight, LayoutGrid, MessageCircle, MoreHorizontal, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';
import { interruptActiveDrag } from '../../hooks/useDragInterruptionSensor';
import { useSuperLongPress } from '../../hooks/useSuperLongPress';
import { removeCollaborationGroup, saveCollaborationGroup, setCollaborationGroupArchived, type CollaborationGroup } from '../../terminal/api';

const action = 'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs transition hover:bg-surface-2 focus:bg-surface-2 focus:outline-none';
const button = 'min-h-11 rounded-lg px-4 text-xs transition disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';

/** Group actions share one entry for right-click, keyboard and touch. */
export function CollaborationGroupActions({ group, collapsed, onOpen, onMessages, onToggleCollapsed, onChanged, children }: {
  group: CollaborationGroup; collapsed: boolean; children: ReactNode;
  onOpen: () => void; onMessages?: () => void; onToggleCollapsed: () => void;
  onChanged: (group: CollaborationGroup | null) => void;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'rename' | 'delete' | 'archive' | 'unarchive'; group: CollaborationGroup } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null), modal = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const id = useId();
  const bindLongPress = useSuperLongPress();
  const restoreFocus = () => returnFocus.current?.isConnected ? returnFocus.current : trigger.current;
  const dismiss = () => { if (!pending.current) { setDialog(null); setError(''); } };
  useKeyboardLayer(menu, !!anchor, () => setAnchor(null), restoreFocus);
  useKeyboardLayer(modal, !!dialog, dismiss, restoreFocus);
  const open = (point?: { x: number; y: number }) => {
    interruptActiveDrag();
    returnFocus.current = document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement) ? document.activeElement : trigger.current;
    const rect = trigger.current?.getBoundingClientRect();
    setAnchor(point ?? { x: rect?.left ?? 8, y: rect?.bottom ?? 8 });
  };
  useEffect(() => { if (anchor) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true }); }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !root.current?.contains(event.target)) setAnchor(null); };
    const close = (event: Event) => { if (event.target instanceof Node && menu.current?.contains(event.target)) return; setAnchor(null); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [anchor]);
  useLayoutEffect(() => {
    if (!anchor || !menu.current) return;
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + 8, top = (viewport?.offsetTop ?? 0) + 8;
    const width = Math.min(240, (viewport?.width ?? innerWidth) - 16);
    const bottom = top + (viewport?.height ?? innerHeight) - 16;
    Object.assign(menu.current.style, { width: `${width}px`, maxHeight: `${bottom - top}px`, left: `${Math.max(left, Math.min(anchor.x, left + (viewport?.width ?? innerWidth) - 16 - width))}px`, top: `${Math.max(top, Math.min(anchor.y, bottom - menu.current.offsetHeight))}px` });
  }, [anchor]);
  const select = (callback: () => void) => { setAnchor(null); callback(); };
  const edit = (kind: 'rename' | 'delete' | 'archive' | 'unarchive') => { setError(''); setName(group.name); setDialog({ kind, group }); };
  const submit = async () => {
    if (!dialog || pending.current || dialog.kind === 'rename' && !name.trim()) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const snapshot = dialog.group;
      const next = dialog.kind === 'delete' ? (await removeCollaborationGroup(snapshot.id, snapshot.updatedAt), null)
        : dialog.kind === 'archive' || dialog.kind === 'unarchive' ? await setCollaborationGroupArchived(snapshot, dialog.kind === 'archive')
          : (await saveCollaborationGroup({ id: snapshot.id, name: name.trim(), sessionIds: snapshot.sessionIds, expectedUpdatedAt: snapshot.updatedAt })).group;
      setDialog(null); onChanged(next);
    } catch (cause) { const message = cause instanceof Error ? cause.message : '操作失败，请重试'; setError(message.includes('协作组已变化') ? '协作组刚刚发生变化，请取消后重新打开操作。' : message); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div ref={root} className="flex min-w-0 items-center" data-sidebar-gesture-ignore
    {...bindLongPress(() => open())}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); open({ x: event.clientX, y: event.clientY }); }}
    onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); event.stopPropagation(); open(); } }}>
    {children}
    <button ref={trigger} type="button" aria-label={`协作组操作：${group.name}`} title="协作组操作" aria-haspopup="menu" aria-expanded={!!anchor} aria-controls={anchor ? `${id}-menu` : undefined}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-elevated hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary md:h-[30px] md:w-7"
      onClick={event => { event.stopPropagation(); anchor ? setAnchor(null) : open(); }}><MoreHorizontal size={14} /></button>
    {anchor && createPortal(<div ref={menu} id={`${id}-menu`} role="menu" tabIndex={-1} aria-label={`协作组操作：${group.name}`} data-sidebar-gesture-ignore
      className="fixed z-popover overflow-y-auto overscroll-contain rounded-xl border border-border/15 bg-surface p-1 shadow-[0_12px_32px_var(--app-shadow-soft)]"
      onKeyDown={event => {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'ArrowDown' ? (current + 1) % items.length : event.key === 'ArrowUp' ? (current - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
        if (next !== null) { event.preventDefault(); event.stopPropagation(); items[next]?.focus({ preventScroll: true }); }
        if (event.key === 'Tab') { event.preventDefault(); setAnchor(null); }
      }}>
      <button role="menuitem" tabIndex={-1} className={action} onClick={() => select(onOpen)}><LayoutGrid size={15} />打开看板</button>
      <button role="menuitem" tabIndex={-1} disabled={!onMessages} className={`${action} disabled:opacity-40`} onClick={() => select(() => onMessages?.())}><MessageCircle size={15} />成员与消息</button>
      <button role="menuitem" tabIndex={-1} className={action} onClick={() => select(onToggleCollapsed)}><ChevronRight size={15} className={collapsed ? '' : 'rotate-90'} />{collapsed ? '展开成员会话' : '收起成员会话'}</button>
      <button role="menuitem" tabIndex={-1} className={action} onClick={() => select(() => edit('rename'))}><Pencil size={15} />重命名协作组</button>
      {!group.federated && <button role="menuitem" tabIndex={-1} className={action} onClick={() => select(() => edit(group.archivedAt === undefined ? 'archive' : 'unarchive'))}><Archive size={15} />{group.archivedAt === undefined ? '归档协作组' : '恢复显示'}</button>}
      <div role="separator" className="mx-2 my-1 h-px bg-border/30" />
      <button role="menuitem" tabIndex={-1} className={`${action} text-destructive`} onClick={() => select(() => edit('delete'))}><Trash2 size={15} />删除协作组</button>
    </div>, document.body)}
    {dialog && createPortal(<>
      <div className="fixed inset-0 z-modal-backdrop bg-black/50 backdrop-blur-sm" onClick={dismiss} />
      <section ref={modal} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1}
        className="fixed left-1/2 top-1/2 z-modal-panel max-h-[calc(100dvh-2rem)] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border/15 bg-surface p-4 text-foreground shadow-[0_28px_70px_var(--app-shadow-strong)]">
        <header className="flex items-center gap-2"><h2 id={`${id}-title`} className="min-w-0 flex-1 text-sm font-semibold">{dialog.kind === 'delete' ? '删除协作组' : dialog.kind === 'archive' ? '归档协作组' : dialog.kind === 'unarchive' ? '恢复协作组显示' : '重命名协作组'}</h2><button type="button" aria-label="关闭协作组操作" disabled={busy} className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-surface-2" onClick={dismiss}><X size={16} /></button></header>
        <p id={`${id}-description`} className="my-3 break-words text-xs leading-6 text-muted-foreground">{dialog.kind === 'delete' ? <>确定删除“{dialog.group.name}”？协作组及组内消息会被移除，成员终端会保留。此操作无法撤销。{dialog.group.federated && '删除会同步到其他服务。'}</> : dialog.kind === 'archive' ? <>归档“{dialog.group.name}”后，它会从默认侧栏隐藏。组、成员、消息和历史都会保留，之后可以恢复显示。</> : dialog.kind === 'unarchive' ? <>恢复“{dialog.group.name}”的显示后，它会重新出现在侧栏；不会自动恢复已关闭的会话。</> : '修改协作组的名称。'}</p>
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          {dialog.kind === 'rename' && <label className="block text-xs text-muted-foreground">协作组名称<input autoFocus required maxLength={256} disabled={busy} className="mt-2 min-h-11 w-full rounded-lg border border-border/30 bg-surface-2 px-3 text-sm text-foreground outline-none focus:border-primary" value={name} onChange={event => setName(event.target.value)} /></label>}
          {error && <p role="alert" className="mt-3 break-words text-xs leading-5 text-destructive">{error}</p>}
          <footer className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} className={`${button} bg-surface-2`} onClick={dismiss}>取消</button><button type="submit" disabled={busy || dialog.kind === 'rename' && !name.trim()} className={`${button} inline-flex items-center gap-2 ${dialog.kind === 'delete' ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground'}`}>{busy && <RefreshCw size={14} className="animate-spin" />}{busy ? dialog.kind === 'delete' ? '正在删除…' : '正在保存…' : dialog.kind === 'delete' ? '确认删除' : dialog.kind === 'archive' ? '归档并隐藏' : dialog.kind === 'unarchive' ? '恢复显示' : '保存名称'}</button></footer>
        </form>
      </section>
    </>, document.body)}
  </div>;
}
