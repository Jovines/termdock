import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// undefined means a standalone document (including an iframe); null means
// the workspace boundary has not mounted yet. Never flash a body portal while
// a restored workspace is still mounting.
export const WorkspacePortalContext = createContext<HTMLElement | null | undefined>(undefined);

export function WorkspacePortal({ children }: { children: ReactNode }) {
  const boundary = useContext(WorkspacePortalContext);
  const target = boundary === undefined ? (typeof document === 'undefined' ? null : document.body) : boundary;
  return target ? createPortal(children, target) : null;
}
