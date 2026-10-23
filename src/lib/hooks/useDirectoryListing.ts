import { useEffect, useId, useRef, useState } from 'react';
import { cancelIoSlot, listDirectory, type FileSortMode } from '../terminal/api';

type DirectoryListing = Awaited<ReturnType<typeof listDirectory>>;

interface Options {
  path: string;
  enabled?: boolean;
  showHidden?: boolean;
  action?: string;
  requestSlotId?: string;
  sortMode?: FileSortMode;
  gitIgnoreRoot?: string;
  onLoad?: (listing: DirectoryListing) => void;
}

/** Owns cancellation, stale-response protection and retry for every directory view. */
export function useDirectoryListing({ path, enabled = true, showHidden = false, action = 'list_directory', requestSlotId, sortMode = 'name', gitIgnoreRoot, onLoad }: Options) {
  const instance = useId();
  const slot = requestSlotId ?? `directory-list:${instance}`;
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([path, showHidden, action, slot, sortMode, gitIgnoreRoot, revision]);
  const [state, setState] = useState<{ key: string; result: DirectoryListing | null; error: string | null; loading: boolean }>();
  const loaded = useRef(onLoad);
  const requestSequence = useRef(0);
  loaded.current = onLoad;

  useEffect(() => {
    if (!enabled || !path) return;
    const controller = new AbortController();
    // A delayed cancel must never cancel a newer retry in the same browser.
    const requestSlot = `${slot}:${++requestSequence.current}`;
    setState({ key, result: null, error: null, loading: true });
    void listDirectory(path, controller.signal, showHidden, action, requestSlot, sortMode, gitIgnoreRoot)
      .then(result => {
        if (controller.signal.aborted) return;
        setState({ key, result, error: null, loading: false });
        loaded.current?.(result);
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setState({ key, result: null, error: error instanceof Error ? error.message : 'Failed to load directory', loading: false });
      });
    return () => {
      controller.abort();
      cancelIoSlot(requestSlot);
    };
  }, [enabled, path, showHidden, action, slot, sortMode, gitIgnoreRoot, key]);

  const current = state?.key === key ? state : undefined;
  return {
    result: current?.result ?? null,
    error: enabled ? current?.error ?? null : null,
    loading: enabled && !!path && (current?.loading ?? true),
    reload: () => setRevision(value => value + 1),
  };
}
