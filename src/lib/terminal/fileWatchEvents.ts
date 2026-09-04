import type { FileWatchEvent } from './api';

export interface FileWatchEventBatch {
  applicableEvents: FileWatchEvent[];
  unavailableReason: string | null;
}

export function isHealthyRescanReason(reason?: string): boolean {
  return reason === 'event-storm'
    || reason === 'reconnected'
    || reason === 'directory-rescan'
    || reason === 'polling-fallback';
}

/**
 * A native watcher failure describes the auto-update transport, not a known
 * file-system change. Keep the current tree intact and let manual refresh
 * remain available; real events and explicit rescan signals still apply.
 */
export function partitionFileWatchEvents(events: FileWatchEvent[]): FileWatchEventBatch {
  let unavailableReason: string | null = null;
  const applicableEvents = events.filter((event) => {
    const unavailable = event.type === 'rescan-required' && !isHealthyRescanReason(event.reason);
    if (unavailable && event.reason && !unavailableReason) unavailableReason = event.reason;
    return !unavailable;
  });
  return { applicableEvents, unavailableReason };
}
