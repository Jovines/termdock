import { useCallback, useEffect, useRef, useState } from 'react';
import { currentSecureClient, savedConnection } from '../../federation/browserIntegration';
import type { ChatUIState } from '../../../server/shared/chatPresentation';
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Keep only this editor's changed fields when another device saves first. */
export function mergeChatUIEdits(base: unknown, edited: unknown, remote: unknown): unknown {
  if (equal(base, edited)) return remote;
  if (!object(base) || !object(edited) || !object(remote)) return edited;
  return Object.fromEntries([...new Set([...Object.keys(remote), ...Object.keys(edited)])].filter(key => !['__proto__', 'prototype', 'constructor'].includes(key)).map(key => [key, mergeChatUIEdits(base[key], edited[key], remote[key])]));
}
export function useChatUIState(sessionId: string, messageId: string, snapshot: ChatUIState | undefined, enabled: boolean) {
  const key = `termdock:chat-ui:${savedConnection()?.targetPeerId || location.origin}:${sessionId}:${messageId}`;
  const initial = snapshot || { revision: 0, values: {} };
  const model = useRef({ base: initial, values: initial.values, saving: false, waiters: [] as (() => void)[], live: true, blocked: false, enabled });
  model.current.enabled = enabled;
  const [hydration, setHydration] = useState(initial.values), [status, setStatus] = useState(''), [error, setError] = useState('');
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    model.current.live = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (saved?.values && saved?.base && enabled) {
        model.current.values = mergeChatUIEdits(saved.base.values, saved.values, initial.values) as Record<string, unknown>;
        setHydration(model.current.values); setChanges(value => value + 1);
      }
    } catch { /* An unfinished form can still be filled from server history. */ }
    return () => { model.current.live = false; };
  // Each message has its own keyed renderer and recovery record.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!snapshot || snapshot.revision <= model.current.base.revision || model.current.saving || !equal(model.current.values, model.current.base.values)) return;
    model.current.base = snapshot; model.current.values = snapshot.values; setHydration(snapshot.values);
  }, [snapshot]);
  const update = useCallback((values: Record<string, unknown>) => {
    const state = model.current;
    if (!state.enabled || equal(values, state.values)) return;
    state.values = values; state.blocked = false; setStatus('正在保存…'); setError('');
    try { sessionStorage.setItem(key, JSON.stringify({ base: state.base, values })); } catch { /* Keep the live form. */ }
    setChanges(value => value + 1);
  }, [key]);
  const save = useCallback(async function saveState(): Promise<boolean> {
    const state = model.current;
    if (!state.enabled || !state.live || state.blocked) return false;
    if (state.saving) { await new Promise<void>(resolve => state.waiters.push(resolve)); return saveState(); }
    if (equal(state.values, state.base.values)) return true;
    const values = state.values, previous = state.base, client = currentSecureClient(); state.saving = true;
    try {
      const response = await fetch(`/api/terminal/${encodeURIComponent(sessionId)}/chat/${encodeURIComponent(messageId)}/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: previous.revision, values }), signal: AbortSignal.timeout(15000) });
      const payload = await response.json();
      if (!state.live || !state.enabled || currentSecureClient() !== client) return false;
      if (response.status === 409 && payload.state) {
        state.values = mergeChatUIEdits(previous.values, state.values, payload.state.values) as Record<string, unknown>;
        state.base = payload.state; state.blocked = true; setHydration(state.values);
        try { sessionStorage.setItem(key, JSON.stringify({ base: state.base, values: state.values })); } catch { /* Keep the form. */ }
        throw new Error('其他客户端更新了填写内容，你的修改已保留，请确认后重新保存。');
      }
      if (!response.ok) throw new Error('暂时无法保存，填写内容已保留。');
      state.base = payload;
      if (equal(values, state.values)) { setStatus('已保存'); sessionStorage.removeItem(key); }
      else setChanges(value => value + 1);
      setError(''); return true;
    } catch (failure) { if (state.live) { state.blocked = true; setStatus(''); setError(failure instanceof Error ? failure.message : '暂时无法保存，填写内容已保留。'); } return false; }
    finally { state.saving = false; state.waiters.splice(0).forEach(resolve => resolve()); }
  }, [sessionId, messageId, key]);
  useEffect(() => { if (!enabled) return; const timer = setTimeout(() => { void save(); }, 350); return () => clearTimeout(timer); }, [changes, enabled, save]);
  return { hydration, update, save, status, error, retry: () => { model.current.blocked = false; void save(); } };
}
