import './lib/federation/scopeBootstrap';
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

syncInitialViewportCssVars();
installEncryptedFetch();
setupPwaUpdateReload();

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
      <PwaUpdateNotice />
      <ErrorBoundary>
        <Suspense fallback={<div className="termdock-boot" role="status">Loading Termdock</div>}>
        {(() => {
          const params = new URLSearchParams(window.location.search);
          if (params.get('dag-playground') === '1') return <DagPlayground />;
          if (params.get('diff-review-lab') === '1') return <DiffReviewLab />;
          if (params.get('diff-lab') === '1') return <DiffLab />;
          return <SecureAccessGate><App /></SecureAccessGate>;
        })()}
      </Suspense>
      </ErrorBoundary>
    </I18nProvider>
  </React.StrictMode>
);
