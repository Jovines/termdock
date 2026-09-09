import './lib/federation/scopeBootstrap';
import { installBrowserCollaboration } from './lib/collaboration/browserFederation';
import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { installEncryptedFetch } from './lib/federation/browserIntegration';
import { SecureAccessGate } from './lib/federation/SecureAccessGate';
// test comment
const App = lazy(() => import('./App'));
const DagPlayground = lazy(() => import('./lib/components/sidebar/DagPlayground').then((module) => ({ default: module.DagPlayground })));
const DiffLab = lazy(() => import('./lib/components/sidebar/DiffLab').then((module) => ({ default: module.DiffLab })));
const DiffReviewLab = lazy(() => import('./lib/components/sidebar/DiffReviewLab').then((module) => ({ default: module.DiffReviewLab })));
import { ErrorBoundary } from './lib/components/ui/ErrorBoundary';
import { syncInitialViewportCssVars } from './lib/hooks/useViewportHeight';
import { I18nProvider } from './lib/i18n';
import { PwaUpdateNotice } from './lib/components/PwaUpdateNotice';
import { setupPwaUpdateReload } from './lib/utils/pwaUpdate';
import { syncThemeColorMeta } from './lib/utils/themeColorMeta';
import { ServiceWorkspaceHost } from './lib/services/ServiceWorkspaceHost';
import { installWorkspaceHost } from './lib/services/workspaceHost';
import { savedConnection } from './lib/federation/browserIntegration';

syncInitialViewportCssVars();
installEncryptedFetch();
if (window.parent === window) setupPwaUpdateReload();
const initialService = savedConnection();
// Fetch the renderer while an existing device establishes its encrypted channel.
if (initialService) void import('./App').catch(() => {});
if (!new URLSearchParams(location.search).has('dag-playground') && !new URLSearchParams(location.search).has('diff-lab') && !new URLSearchParams(location.search).has('diff-review-lab')) {
  installWorkspaceHost(initialService ? { ...initialService, id: initialService.targetPeerId, label: initialService.serviceName || location.host } : undefined);
  installBrowserCollaboration();
}

try {
  const storedTheme = JSON.parse(window.localStorage.getItem('termdock-color-theme') || 'null') as unknown;
  if (storedTheme === 'dark' || storedTheme === 'light') {
    document.documentElement.dataset.theme = storedTheme;
    syncThemeColorMeta(storedTheme);
  }
} catch {
  // Ignore corrupt storage; App will fall back to the default theme.
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      {window.parent === window && <PwaUpdateNotice />}
      <ErrorBoundary>
        <Suspense fallback={<div className="termdock-boot" role="status">Loading Termdock</div>}>
        {(() => {
          const params = new URLSearchParams(window.location.search);
          if (params.get('dag-playground') === '1') return <DagPlayground />;
          if (params.get('diff-review-lab') === '1') return <DiffReviewLab />;
          if (params.get('diff-lab') === '1') return <DiffLab />;
          return <ServiceWorkspaceHost><SecureAccessGate><App /></SecureAccessGate></ServiceWorkspaceHost>;
        })()}
      </Suspense>
      </ErrorBoundary>
    </I18nProvider>
  </React.StrictMode>
);
