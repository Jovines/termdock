import { useCallback, useEffect, useRef, useState } from 'react';
import { computerLoginKey, computerPreferences, defaultComputerPreferences, type ComputerPreferences, type ComputerProfile } from './preferences';

/** Service-owned settings. Passwords never enter this state or its requests. */
export function useComputerPreferences(serviceId: string) {
  const [preferences, setPreferences] = useState(defaultComputerPreferences);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  const [credentialKeys, setCredentialKeys] = useState<string[]>([]);
  const [loginState, setLoginState] = useState<'idle' | 'saving' | 'error'>('idle');
  const current = useRef(preferences);
  const revision = useRef(0);
  const session = useRef(0);
  const acknowledged = useRef('');
  const pending = useRef<Promise<boolean> | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const change = useCallback((edit: (value: ComputerPreferences) => ComputerPreferences) => {
    current.current = edit(current.current); revision.current++;
    setPreferences(current.current); setSaveState('saving');
  }, []);
  useEffect(() => {
    const attempt = ++session.current;
    revision.current = 0; acknowledged.current = ''; pending.current = null;
    current.current = defaultComputerPreferences(); setPreferences(current.current); setLoaded(false); setSaveState('loading');
    setCredentialKeys([]); setLoginState('idle');
    const abort = new AbortController();
    void fetch('/api/computer/preferences', { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('PREFERENCES_LOAD_FAILED');
      return await response.json() as { preferences: ComputerPreferences; configured: boolean; credentialKeys?: string[]; credentialError?: boolean };
    }).then(result => {
      if (attempt !== session.current || abort.signal.aborted) return;
      let value = computerPreferences(result.preferences);
      // One-time migration of pre-server preferences. Server settings win later.
      const hasLocalEdits = revision.current > 0;
      if (!result.configured && !hasLocalEdits) try {
        const host = localStorage.getItem(`termdock:computer-host:${serviceId}`);
        if (host) {
          const local = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i.test(host);
          const target = local ? 'local' : 'remote';
          value = computerPreferences({ ...value, target, [target]: { ...value[target], host,
            platform: localStorage.getItem(`termdock:computer-platform:${serviceId}`) || value[target].platform,
            protocol: localStorage.getItem(`termdock:computer-protocol:${serviceId}`) || 'vnc',
            port: localStorage.getItem(`termdock:computer-rdp-port:${serviceId}`) || '3389' } });
          revision.current++;
        }
      } catch { /* storage unavailable */ }
      if (!hasLocalEdits) current.current = value;
      acknowledged.current = result.configured ? JSON.stringify(value) : '';
      setPreferences(current.current); setLoaded(true); setSaveState(result.configured ? 'saved' : 'saving');
      setCredentialKeys(Array.isArray(result.credentialKeys) ? result.credentialKeys.filter(key => typeof key === 'string') : []);
      setLoginState(result.credentialError ? 'error' : 'idle');
    }).catch(() => { if (!abort.signal.aborted && attempt === session.current) setSaveState('error'); });
    return () => {
      ++session.current; abort.abort();
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, [serviceId, reload]);
  const flush = useCallback((): Promise<boolean> => {
    if (pending.current) return pending.current;
    if (!loaded) return Promise.resolve(false);
    const attempt = session.current;
    const request = (async () => {
      while (acknowledged.current !== JSON.stringify(current.current)) {
        const snapshot = JSON.stringify(current.current), abort = new AbortController();
        controllers.current.add(abort); setSaveState('saving');
        try {
          const response = await fetch('/api/computer/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: snapshot, signal: abort.signal });
          if (!response.ok) throw new Error('PREFERENCES_SAVE_FAILED');
          if (attempt !== session.current) return false;
          acknowledged.current = snapshot;
        } catch {
          if (attempt === session.current) setSaveState('error');
          return false;
        } finally { controllers.current.delete(abort); }
      }
      if (attempt === session.current) setSaveState('saved');
      return true;
    })();
    pending.current = request;
    void request.finally(() => { if (pending.current === request) pending.current = null; });
    return request;
  }, [loaded]);
  useEffect(() => {
    if (!loaded || acknowledged.current === JSON.stringify(preferences)) return;
    const timer = setTimeout(() => { void flush(); }, 300);
    return () => clearTimeout(timer);
  }, [loaded, preferences, flush]);
  const credentialRequest = useCallback(async (action: 'save' | 'use' | 'forget', profile: ComputerProfile, password?: string): Promise<string | undefined> => {
    const attempt = session.current;
    const abort = new AbortController();
    if (action !== 'use') setLoginState('saving');
    try {
      if (!await flush() || attempt !== session.current) throw new Error('COMPUTER_CREDENTIALS_FAILED');
      controllers.current.add(abort);
      const response = await fetch(`/api/computer/credentials/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, ...(action === 'save' ? { password } : {}) }), signal: abort.signal });
      if (attempt !== session.current) throw new Error('COMPUTER_CREDENTIALS_FAILED');
      if (!response.ok) throw new Error(action === 'use' && response.status === 404 ? 'COMPUTER_CREDENTIALS_MISSING' : 'COMPUTER_CREDENTIALS_FAILED');
      const result = await response.json() as { password?: string };
      if (attempt !== session.current) throw new Error('COMPUTER_CREDENTIALS_FAILED');
      const key = computerLoginKey(profile);
      if (action === 'save') setCredentialKeys(keys => [...new Set([...keys, key])]);
      if (action === 'forget') setCredentialKeys(keys => keys.filter(value => value !== key));
      if (action === 'use' && (typeof result.password !== 'string' || !result.password)) throw new Error('COMPUTER_CREDENTIALS_MISSING');
      setLoginState('idle'); return result.password;
    } catch (error) {
      if (attempt === session.current && !abort.signal.aborted) setLoginState('error');
      throw error;
    } finally { controllers.current.delete(abort); }
  }, [flush]);
  return { preferences, change, loaded, saveState, flush, credentialKeys, loginState, credentialRequest, retry: () => loaded ? void flush() : setReload(value => value + 1) };
}
