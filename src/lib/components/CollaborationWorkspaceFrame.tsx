import type { ReactNode } from 'react';

/** Keep terminal instances alive while the main workspace owns focus and input. */
export function CollaborationWorkspaceFrame({ workspace, children, rightInset = 0 }: { workspace: ReactNode; children: ReactNode; rightInset?: number }) {
  const active = !!workspace;
  return <>
    <div ref={node => { if (node) node.inert = active; }} aria-hidden={active ? true : undefined}
      style={{ visibility: active ? 'hidden' : undefined }}
      className="relative flex h-full w-full min-h-0 flex-col overflow-visible app-chrome-bg">
      {children}
    </div>
    {active && <div data-collaboration-workspace-frame className="absolute inset-y-0 left-0" style={{ right: rightInset }}>{workspace}</div>}
  </>;
}
