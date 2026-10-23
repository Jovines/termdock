import { createContext, useContext, type MouseEvent } from 'react';
import type { ShareResources } from '../../server/shared/shareResources';
import { NO_SESSION_CAPABILITIES, SERVICE_SESSION_CAPABILITIES, type SessionCapabilities } from './sessionCapabilities';
/** Undefined means the normal service UI; an object is an explicit resource grant. */
export const ShareAccessContext = createContext<ShareResources | undefined>(undefined);
export const useShareAccess = () => useContext(ShareAccessContext);
export const SessionCapabilitiesContext = createContext<SessionCapabilities | undefined>(undefined);
/** A shared subtree without an explicit session grant starts with zero capabilities. */
export function useSessionCapabilities(): SessionCapabilities {
  const capabilities = useContext(SessionCapabilitiesContext), shared = useShareAccess();
  return capabilities ?? (shared === undefined ? SERVICE_SESSION_CAPABILITIES : NO_SESSION_CAPABILITIES);
}

/** Shared content has no owner actions; selected text still gets native copy. */
export function sharedSessionContextMenu(event: MouseEvent<HTMLElement>) {
  event.stopPropagation();
  const target = event.target;
  const inputSelection = (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)
    && target.selectionStart !== null && target.selectionStart !== target.selectionEnd;
  if (!inputSelection && !window.getSelection()?.toString()) event.preventDefault();
}
