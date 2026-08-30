import React from 'react';
import { useI18n } from '../../i18n';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  componentStack: string;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

// Inner functional component used so the class boundary can call into the
// i18n hook (hooks can only run inside function components).
export function buildErrorDiagnostic(
  error: Error | null,
  componentStack: string,
  context: { url: string; userAgent: string; capturedAt: string },
): string {
  const errorName = error?.name || 'Error';
  const errorMessage = error?.message || 'Unexpected error';
  return [
    'Termdock error report',
    `Time: ${context.capturedAt}`,
    `URL: ${context.url}`,
    `User agent: ${context.userAgent}`,
    '',
    `${errorName}: ${errorMessage}`,
    error?.stack ? `\nStack:\n${error.stack}` : '',
    componentStack ? `\nReact component stack:\n${componentStack.trim()}` : '',
  ].filter(Boolean).join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand for older/insecure embedded browsers.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function ErrorFallback({ error, componentStack }: { error: Error | null; componentStack: string }) {
  const { t } = useI18n();
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const handleCopy = async () => {
    const diagnostic = buildErrorDiagnostic(error, componentStack, {
      url: window.location.href,
      userAgent: navigator.userAgent,
      capturedAt: new Date().toISOString(),
    });
    setCopyState(await copyText(diagnostic) ? 'copied' : 'failed');
  };
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="flex flex-col items-center gap-3 text-center max-w-md">
        <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
          <svg className="w-6 h-6 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div className="space-y-1">
          <h3 className="font-medium text-foreground">{t('errorBoundary.title')}</h3>
          <p className="text-sm text-muted-foreground">
            {error?.message || t('errorBoundary.unexpected')}
          </p>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="rounded-full bg-surface-2 px-5 py-2.5 text-sm font-medium text-foreground ring-1 ring-border/15 transition hover:bg-surface-elevated active:scale-[0.97]"
          >
            {copyState === 'copied'
              ? t('errorBoundary.copied')
              : copyState === 'failed'
                ? t('errorBoundary.copyFailed')
                : t('errorBoundary.copyDetails')}
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 active:scale-[0.97]"
          >
            {t('errorBoundary.retry')}
          </button>
        </div>
      </div>
    </div>
  );
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    componentStack: '',
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
      componentStack: '',
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Terminal error caught by boundary:', error, errorInfo);
    this.setState({ componentStack: errorInfo.componentStack ?? '' });
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return <ErrorFallback error={this.state.error} componentStack={this.state.componentStack} />;
    }
    return this.props.children;
  }
}
