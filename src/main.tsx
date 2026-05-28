import React, { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { LoginScreen } from './lib/components/auth/LoginScreen';
import {
  AUTH_UNAUTHORIZED_EVENT,
  getAuthStatus,
  type AuthStatus,
} from './lib/terminal/api';

// Top-level gate that decides whether to show the LoginScreen or the real
// App. Listens to `auth:unauthorized` from the global fetch interceptor so
// that any 401 (e.g. session expired mid-use) drops back to login.
function AuthGate() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getAuthStatus();
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to query auth status');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const handler = () => {
      // Force-flip to "not authenticated" without waiting for the next
      // status fetch, so navigation feels immediate.
      setStatus((prev) => (prev ? { ...prev, authenticated: false } : prev));
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
  }, []);

  if (status === null) {
    return (
      <div
        className="flex w-screen items-center justify-center bg-background text-muted-foreground"
        style={{ height: 'var(--app-vh, 100vh)' }}
      >
        {error ? `Error: ${error}` : 'Loading…'}
      </div>
    );
  }

  if (status.enabled && !status.authenticated) {
    return <LoginScreen onLoginSuccess={refresh} />;
  }

  return <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>
);
