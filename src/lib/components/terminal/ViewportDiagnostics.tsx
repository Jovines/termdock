import React from 'react';
import { viewportWindow } from '../../services/workspaceViewport';

function readGeometry(): string {
  const owner = viewportWindow();
  const viewport = owner.visualViewport;
  const style = document.documentElement.style;
  const px = (value: number | undefined) => value === undefined ? '?' : Math.round(value);
  const css = (name: string) => style.getPropertyValue(name) || '?';
  let ancestor = document.activeElement?.parentElement;
  let toolbar: Element | null = null;
  while (ancestor && !toolbar) {
    toolbar = ancestor.querySelector('[data-mobile-keyboard="true"]');
    ancestor = ancestor.parentElement;
  }
  const rect = toolbar?.getBoundingClientRect();
  const root = document.getElementById('root')?.getBoundingClientRect();
  return [
    `VVP ${px(viewport?.height)} off ${px(viewport?.offsetTop)} win ${owner.innerHeight}`,
    `base ${css('--app-base-vh')} kb ${css('--kb-height')} move ${css('--kb-translate-y')}`,
    `bar ${px(rect?.top)}…${px(rect?.bottom)} h ${px(rect?.height)} root ${px(root?.bottom)}`,
    `safe ${css('--safe-top-inset')}/${css('--safe-bottom-inset')} frame ${owner !== window ? 'child' : 'root'} focus ${document.activeElement?.tagName ?? '?'}`,
  ].join('\n');
}

/** Only mounted through the existing debug switch. Sampling includes actual
 * DOM geometry, so a viewport API problem can be distinguished from CSS flow.
 * No terminal text, identifiers or diagnostic data leave the page. */
export function ViewportDiagnostics({ onClose }: { onClose: () => void }) {
  const [geometry, setGeometry] = React.useState(readGeometry);
  React.useEffect(() => {
    const timer = window.setInterval(() => setGeometry(readGeometry()), 200);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="pointer-events-none fixed inset-x-2 z-toast rounded-lg border border-border/15 bg-surface p-2 text-foreground md:hidden"
    style={{ top: 'calc(var(--safe-top-inset, 0px) + 40px)' }}>
    <button type="button" className="pointer-events-auto absolute right-1 top-1 px-2 py-1 text-xs"
      onPointerDown={event => event.preventDefault()} onClick={onClose} aria-label="关闭布局诊断">×</button>
    <pre className="pr-5 font-mono text-[10px] leading-tight">{geometry}</pre>
  </div>;
}
