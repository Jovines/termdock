import type { SVGProps } from 'react';
import './Loading.css';

// Arc / LinearDots adapted for React 18 from https://loading.dev (MIT).
// The original license is retained in public/licenses/loading-dev.txt.
type LoadingSpinnerProps = SVGProps<SVGSVGElement> & { size?: number | string };

/** Decorative by default; put task-specific text on the enclosing status/button. */
export function LoadingSpinner({ size = 16, className = '', ...props }: LoadingSpinnerProps) {
  const labelled = Boolean(props['aria-label'] || props['aria-labelledby']);
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      aria-hidden={labelled ? undefined : true} role={labelled ? 'img' : undefined}
      focusable="false" {...props}
      className={`td-loading-spinner animate-spin ${className.replace(/\b(?:animate-spin|service-spinning)\b/g, '')}`}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5"
        strokeDasharray="18 44.8" strokeLinecap="round" />
    </svg>
  );
}

export function LoadingDots() {
  return (
    <span className="td-loading-dots" aria-hidden="true">
      {[0, 1, 2].map((dot) => <span key={dot} style={{ animationDelay: `${(dot - 3) * 400}ms` }} />)}
    </span>
  );
}

/** One announcement per loading region, with readable text even without motion. */
export function LoadingStatus({ label, className = '', dots = false }: {
  label: string;
  className?: string;
  dots?: boolean;
}) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true"
      className={`flex items-center justify-center gap-2 text-sm text-muted-foreground ${className}`}>
      {dots ? <LoadingDots /> : <LoadingSpinner size={18} />}
      <span>{label}</span>
    </div>
  );
}
