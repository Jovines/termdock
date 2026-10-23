export type NewSessionCreationError = 'directoryUnavailable' | 'permissionDenied' | 'connection' | 'unknown';
export type NewSessionCreationResult = { ok: true; sessionId: string } | { ok: false; error: NewSessionCreationError };
export interface NewSessionRequestOptions {
  mode?: 'shell' | 'tmux';
  tmuxSessionName?: string;
  cwd?: string;
  command?: string;
  onResult?: (result: NewSessionCreationResult) => void;
  /** UI owner may withdraw automatic navigation without cancelling creation. */
  shouldActivate?: () => boolean;
}

export function classifySessionCreationError(error: unknown): NewSessionCreationError {
  const message = error instanceof Error ? error.message : '';
  if (/directory does not exist|not a directory/i.test(message)) return 'directoryUnavailable';
  if (/EACCES|permission denied|outside.*allowed|not allowed/i.test(message)) return 'permissionDenied';
  if (error instanceof TypeError || isConnectionInterruption(error) || /network|failed to fetch|connection|timed? ?out|timeout|aborted/i.test(message)) return 'connection';
  return 'unknown';
}

export const sessionCreationErrorKey = (error: NewSessionCreationError) => ({
  directoryUnavailable: 'sidebar.sessionCreateDirectoryUnavailable',
  permissionDenied: 'sidebar.sessionCreatePermissionDenied',
  connection: 'sidebar.sessionCreateConnectionFailed',
  unknown: 'sidebar.sessionCreateFailed',
} as const)[error];
import { isConnectionInterruption, SECURE_READY_EVENT } from '../federation/connectionRecovery';
import type { OpenSessionInventoryOptions } from './types';

/** Reuse the same frontend identity after a lost response, never create a second terminal. */
export async function openSessionWithRecovery<T>(options: OpenSessionInventoryOptions, open: (options: OpenSessionInventoryOptions) => Promise<T>,
  recovery: { current: () => boolean; pending: (value: boolean) => void }) {
  // Explicit cwd preserves strict restore semantics for client-supplied IDs.
  const request = options.preferredFrontendSessionId || options.cwd
    ? { ...options, preferredFrontendSessionId: options.preferredFrontendSessionId || `terminal-${crypto.randomUUID()}` } : options;
  try {
    for (let attempt = 0; ; attempt++) {
      try { return await open(request); }
      catch (error) {
        if (!request.preferredFrontendSessionId || attempt >= 3 || classifySessionCreationError(error) !== 'connection' || !recovery.current()) throw error;
        recovery.pending(true);
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); window.removeEventListener('online', done); window.removeEventListener(SECURE_READY_EVENT, done); resolve(); };
          const timer = setTimeout(done, 1000 * 2 ** attempt);
          window.addEventListener('online', done); window.addEventListener(SECURE_READY_EVENT, done);
        });
        if (!recovery.current()) throw error;
      }
    }
  } finally { recovery.pending(false); }
}
