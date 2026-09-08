/** HTTP policy is evaluated at the final target, using the authenticated device identity.
 * Never forward an unknown route for a narrow grant. Full-service grants may use
 * isBusinessApiPath after an explicit service:* check, including future APIs. */
export interface ResolvedAccessRequest {
  action: string;
  sessionId?: string;
  /** Raw inventory contains unrelated metadata. Narrow viewers require a separate
   * projection of individually authorized backend Sessions, never this raw response. */
  metadata?: 'session-inventory' | 'global-client-state';
}
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
export function canonicalApiPath(path: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\\\x00-\x20\x7f#]/.test(path)) return null;
  const pathname = path.split('?')[0];
  if (pathname.includes('//')) return null;
  try {
    const segments = pathname.split('/').map((segment, index) => {
      if (index === 0 || (segment === '' && index === pathname.split('/').length - 1)) return segment;
      const value = decodeURIComponent(segment);
      // Decode exactly once. Never allow an encoded separator, traversal segment,
      // control byte, invalid UTF-8 or a second escape layer to change routing.
      if (!value || value === '.' || value === '..' || /[\\/\x00-\x1f\x7f]/.test(value) || /%[a-f0-9]{2}/i.test(value)) throw new Error('Ambiguous API path');
      return value;
    });
    const canonical = segments.join('/');
    if (canonical.endsWith('/') && !canonical.startsWith('/api/terminal/fs/preview/')) return null;
    return canonical;
  } catch { return null; }
}
const pathOnly = canonicalApiPath;
/** Restricts a full-service tunnel to business APIs, excluding authentication,
 * local-only operations and recursive federation/bootstrap endpoints. */
export function isBusinessApiPath(method: string, path: string): boolean {
  if (!METHODS.has(method)) return false;
  const pathname = pathOnly(path);
  if (!pathname) return false;
  return !/^\/api\/(?:auth|local|federation|onboarding|csrf)(?:\/|$)/i.test(pathname);
}
const fileReads = new Set(['list', 'watch', 'search', 'read', 'git-blob', 'eda-preview', 'eda-inspect', 'blob', 'video', 'download', 'diff', 'diff-files', 'untracked-files', 'git-context', 'git-bundle', 'change-audit', 'branch-diff', 'commit-diff', 'git-recent-commits', 'branch-audit', 'git-action/status', 'local-open-availability']);
const filePosts = new Set(['git-action', 'apply-hunk', 'upload', 'open-in-file-browser']);
const settings = new Set(['settings', 'toolbar-presets', 'program-detection', 'context-draft']);
const serviceReads = new Set(['update', 'auto-title/catalog', 'agent-hooks', 'agent-launchers', 'agent-plugins', 'quota', 'tmux/status', 'tmux/sessions', 'agent-resume-history']);
const reservedSessionIds = new Set(['fs', 'settings', 'client-state', 'session-inventory', 'operations', 'tmux', 'create', 'force-kill', 'serialize-state', 'agent-resume-history', 'toolbar-presets', 'context-draft', 'program-detection', 'update', 'quota', 'agent-hooks', 'agent-launchers', 'agent-plugins', 'agent-plugin-icon', 'auto-title', 'directory-suggestions']);
export function resolveAccessRequest(method: string, path: string): ResolvedAccessRequest | null {
  if (!isBusinessApiPath(method, path)) return null;
  const pathname = pathOnly(path)!;
  const read = method === 'GET' || method === 'HEAD';
  if (/^\/api\/notifications\/(status|subscribe|preferences|unsubscribe)$/.test(pathname)) {
    if (read && pathname.endsWith('/status')) return { action: 'service.view' };
    if (method === 'POST' && !pathname.endsWith('/status')) return { action: 'service.configure' };
    return null;
  }
  const prefix = '/api/terminal/';
  if (!pathname.startsWith(prefix)) return null;
  const route = pathname.slice(prefix.length);
  if (route.startsWith('fs/')) {
    const op = route.slice(3);
    if (read && (fileReads.has(op) || /^preview\/.+/.test(op))) return { action: 'file.read' };
    if ((method === 'POST' && filePosts.has(op)) || (method === 'DELETE' && ['file', 'change-audit', 'branch-audit'].includes(op)) || (method === 'GET' && op === 'cancel-slot')) return { action: 'file.write' };
    return null;
  }
  if (read && route === 'session-inventory') return { action: 'service.view', metadata: 'session-inventory' };
  if (read && route === 'client-state') return { action: 'service.view', metadata: 'global-client-state' };
  if (settings.has(route)) {
    if (read) return { action: 'service.view' };
    if (method === 'PUT' || (method === 'DELETE' && route === 'program-detection')) return { action: 'service.configure' };
    return null;
  }
  if (read && serviceReads.has(route)) return { action: 'service.view' };
  if (read && route === 'directory-suggestions') return { action: 'file.read' };
  if (method === 'POST' && route === 'create') return { action: 'service.create-session' };
  const session = /^([^/]+)(?:\/(health|attach|stream|input|resize|tmux|restart|agent-resume))?$/.exec(route);
  if (session && !reservedSessionIds.has(session[1].toLowerCase())) {
    const sessionId = session[1]; const op = session[2];
    if (read && ['health', 'attach', 'stream', 'agent-resume'].includes(op)) return { action: 'session.view', sessionId };
    if (method === 'POST' && op === 'input') return { action: 'session.input', sessionId };
    if (method === 'POST' && op === 'resize') return { action: 'session.resize', sessionId };
    if (method === 'DELETE' && !op) return { action: 'session.terminate', sessionId };
    // tmux switch-session can reach other backends; restart/agent-resume accept
    // launch configuration. Their unrestricted bodies require service authority.
    if (method === 'POST' && ['tmux', 'restart', 'agent-resume'].includes(op)) return { action: 'service.configure' };
  }
  // Complex operations manipulate global state or accept additional resource IDs.
  // An unregistered operation intentionally receives no custom-grant mapping.
  return null;
}
/** WS control mapping; caller must bind sessionId to the opened channel. */
export function terminalMessageAction(type: string): string | null {
  switch (type) {
    case 'input': case 'focus': case 'agent-review-ack': return 'session.input';
    case 'resize': return 'session.resize';
    case 'tmux': return 'service.configure';
    case 'ping': case 'viewing': case 'output-subscription': case 'output-ack': return 'session.view';
    // Legacy flow-control can pause the shared PTY; grant only to controllers.
    case 'flow-control': return 'session.input';
    default: return null;
  }
}
