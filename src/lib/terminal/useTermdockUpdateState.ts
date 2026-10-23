import { useCallback, useEffect, useRef, useState } from 'react';
import { SECURE_STATE_EVENT, savedConnection } from '../federation/browserIntegration';
import { subscribeClientState } from '../utils/clientStateSync';
import { getTermdockUpdateState, type TermdockUpdateState } from './api';

/** A control push or action result always wins over an older HTTP snapshot. */
export function useTermdockUpdateState() {
  const [state, setState] = useState<TermdockUpdateState | null>(null);
  const revision = useRef(0);
  const mounted = useRef(false);
  const apply = useCallback((next: TermdockUpdateState | null) => {
    revision.current++;
    if (mounted.current) setState(next);
  }, []);
  const refresh = useCallback(async () => {
    const requestRevision = ++revision.current;
    const target = savedConnection();
    try {
      const next = await getTermdockUpdateState();
      if (mounted.current && requestRevision === revision.current && target === savedConnection()) apply(next);
    } catch {
      // A lost connection cannot establish a newer update state. Reconnect,
      // foregrounding, and the control channel will request another snapshot.
    }
  }, [apply]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeClientState(event => {
      if (event.type === 'update-state') apply(event.state);
    });
    const reconnect = () => { apply(null); void refresh(); };
    const foreground = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener(SECURE_STATE_EVENT, reconnect);
    window.addEventListener('pageshow', foreground);
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    void refresh();
    return () => {
      mounted.current = false;
      revision.current++;
      unsubscribe();
      window.removeEventListener(SECURE_STATE_EVENT, reconnect);
      window.removeEventListener('pageshow', foreground);
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [apply, refresh]);

  return { state, apply, refresh };
}
