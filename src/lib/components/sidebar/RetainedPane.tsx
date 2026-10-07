import { memo, useLayoutEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex],[contenteditable],iframe,summary,audio[controls],video[controls]';

/** Retain layout without invalidating inherited styles on every diff token. */
export const RetainedPane = memo(function RetainedPane({ active, mounted = true, fallback = null, children }: {
  active: boolean;
  mounted?: boolean;
  fallback?: ReactNode;
  children: ReactNode | (() => ReactNode);
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || active) return;
    // Pane-wide visibility, pointer-events and inert all invalidate inherited
    // styles across tens of thousands of syntax tokens. Clip the pane instead,
    // and apply native focus exclusion only to its interactive descendants.
    const controls = new Map<HTMLElement, boolean>();
    const exclude = (element: HTMLElement) => {
      if (controls.has(element)) return;
      controls.set(element, element.inert);
      element.inert = true;
    };
    const excludeTree = (element: Element) => {
      if (element instanceof HTMLElement && element.matches(FOCUSABLE)) exclude(element);
      element.querySelectorAll<HTMLElement>(FOCUSABLE).forEach(exclude);
    };
    excludeTree(root);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target instanceof HTMLElement && record.target.matches(FOCUSABLE)) exclude(record.target);
        } else {
          record.addedNodes.forEach((node) => { if (node instanceof Element) excludeTree(node); });
        }
      }
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['tabindex', 'href', 'contenteditable', 'controls'] });
    return () => {
      observer.disconnect();
      for (const [element, inert] of controls) element.inert = inert;
    };
  }, [active, mounted]);

  return (
    <div ref={rootRef} className="absolute inset-0 min-h-0 overflow-hidden bg-surface text-foreground"
      style={active ? undefined : { clipPath: 'inset(100%)' }} aria-hidden={!active}>
      {mounted ? (typeof children === 'function' ? children() : children) : fallback}
    </div>
  );
}, (previous, next) => !previous.active && !next.active && previous.mounted === next.mounted);
