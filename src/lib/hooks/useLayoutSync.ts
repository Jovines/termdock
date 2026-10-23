import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { getSettings, type SettingsState } from '../terminal/api';
import { saveCollaborationPanel } from '../collaboration/panelPreferences';
import { SECURE_READY_EVENT } from '../federation/connectionRecovery';
import { useAppFeedback } from '../components/ui/AppFeedback';
import { useI18n } from '../i18n';
import type { SplitNode } from '../terminal/freeSplitLayout';

/** Keep the usable local layout while failed reads/writes recover in order. */
export function useLayoutSync(layoutId: string, tree: RefObject<SplitNode>, onLoad: (settings: SettingsState) => void) {
  const { locale } = useI18n();
  const [ready, setReady] = useState(false), [recovering, setRecovering] = useState(false);
  const load = useRef(onLoad); load.current = onLoad;
  const controls = useRef({ edited: false, revision: 0, persist: () => {} });
  const persist = useCallback(() => controls.current.persist(), []);
  const markChanged = useCallback(() => { controls.current.edited = true; controls.current.revision++; }, []);
  useAppFeedback(recovering ? { tone: 'recovering', message: locale === 'zh' ? '正在恢复布局同步…' : 'Restoring layout sync…' } : null);
  useEffect(() => {
    let disposed = false, loaded = false, reading = false, writing = false, savedRevision = 0, failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const owner = { edited: false, revision: 0, persist: () => { void sync(); } };
    controls.current = owner;
    setReady(false); setRecovering(false);
    const schedule = () => {
      if (disposed) return;
      clearTimeout(timer);
      timer = setTimeout(() => void sync(), Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)));
    };
    const sync = async () => {
      if (disposed || reading || writing) return;
      clearTimeout(timer);
      try {
        if (!loaded) {
          reading = true;
          const settings = await getSettings();
          if (disposed) return;
          // A late server response must never replace a layout adjusted locally.
          if (!owner.edited) load.current(settings);
          loaded = true; reading = false; setReady(true);
        }
        if (owner.revision > savedRevision && tree.current) {
          const revision = owner.revision;
          writing = true;
          await saveCollaborationPanel({ layouts: { [layoutId]: tree.current } });
          savedRevision = revision; writing = false;
        }
        if (!disposed) { failures = 0; setRecovering(false); if (owner.revision > savedRevision) schedule(); }
      } catch {
        if (!disposed) { setReady(true); setRecovering(true); schedule(); }
      } finally { reading = false; writing = false; }
    };
    const wake = () => { if (!document.hidden) void sync(); };
    void sync();
    window.addEventListener('online', wake); window.addEventListener(SECURE_READY_EVENT, wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      disposed = true; clearTimeout(timer);
      window.removeEventListener('online', wake); window.removeEventListener(SECURE_READY_EVENT, wake);
      document.removeEventListener('visibilitychange', wake);
      // One final best-effort flush. Never start a detached retry loop.
      if (owner.revision > savedRevision && loaded && tree.current) void saveCollaborationPanel({ layouts: { [layoutId]: tree.current } }).catch(() => {});
    };
  }, [layoutId, tree]);
  return { ready, markChanged, persist };
}
