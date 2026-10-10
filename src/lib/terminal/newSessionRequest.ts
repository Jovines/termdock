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
  if (error instanceof TypeError || /network|failed to fetch|connection|timed? ?out|timeout|aborted/i.test(message)) return 'connection';
  return 'unknown';
}

export const sessionCreationErrorKey = (error: NewSessionCreationError) => ({
  directoryUnavailable: 'sidebar.sessionCreateDirectoryUnavailable',
  permissionDenied: 'sidebar.sessionCreatePermissionDenied',
  connection: 'sidebar.sessionCreateConnectionFailed',
  unknown: 'sidebar.sessionCreateFailed',
} as const)[error];
