import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useSessionDirectory } from '../../stores/useSessionDirectory';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSessionCapabilities, useShareAccess } from '../../federation/ShareAccessContext';
import { resolveMarkdownLocalLinkTarget, type MarkdownLocalLinkTarget } from '../markdown/MarkdownPreview';
import { ChatFilePreview } from './ChatFilePreview';

const ChatFileNavigationContext = createContext<{
  filePath: string | null;
  open: (href: string) => void;
} | null>(null);
export const useChatFileNavigation = () => useContext(ChatFileNavigationContext);

/** Bind links to their conversation, including retained/offscreen workspaces. */
export function ChatFileNavigation({ sessionId, canWrite = true, active = true, children }: {
  sessionId: string; canWrite?: boolean; active?: boolean; children: ReactNode;
}) {
  const sessions = useSessionDirectory();
  const liveDirectory = useTerminalStore(state => {
    const session = state.sessions.get(sessionId);
    return session?.cwd || session?.directory;
  });
  const access = useShareAccess(), capabilities = useSessionCapabilities();
  const directory = access === undefined
    ? liveDirectory || sessions.find(session => session.sessionId === sessionId)?.cwd
    : access.directories?.[0]?.path;
  // Markdown resolves relative links beside a source file. Chat prose lives at cwd.
  const filePath = directory ? `${directory.replace(/\/$/, '')}/.termdock-chat.md` : null;
  const [target, setTarget] = useState<MarkdownLocalLinkTarget | null>(null);
  const open = useCallback((href: string) => {
    if (!active || !capabilities.has('resource.files')) return;
    const resolved = resolveMarkdownLocalLinkTarget(href, filePath, null);
    if (!resolved || resolved.directory) return;
    if (access !== undefined && !access.directories?.some(grant => {
      const root = grant.path.replace(/\/$/, '');
      return resolved.path === root || resolved.path.startsWith(`${root}/`);
    })) return;
    setTarget(resolved);
  }, [active, access, capabilities, filePath]);
  return <ChatFileNavigationContext.Provider value={{ filePath, open }}>
    {children}
    {active && target && <ChatFilePreview key={`${target.path}#${target.fragment ?? ''}`} path={target.path} fragment={target.fragment} rootPath={access?.directories?.find(grant => target.path.startsWith(`${grant.path.replace(/\/$/, '')}/`))?.path ?? null} sessionId={sessionId} canWrite={canWrite && capabilities.has('session.input')} close={() => setTarget(null)} />}
  </ChatFileNavigationContext.Provider>;
}
