import { useCallback, useEffect, useRef } from 'react';
import { buildDraftTerminalRequest } from './contextDraft';
import { requestReferenceInsertion } from './requestReferenceInsertion';

/** ACK owns the submitted snapshot, never edits made while it was pending. */
export function useContextDraftDelivery(config: {
  text: string;
  sessionId: string | null;
  active: boolean;
  onAccepted: () => void;
  onRejected: () => void;
}) {
  const latest = useRef(config);
  const revision = useRef(0);
  if (latest.current.text !== config.text || latest.current.sessionId !== config.sessionId || latest.current.active !== config.active) revision.current += 1;
  latest.current = config;
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; revision.current += 1; };
  }, []);
  return useCallback(async (submit: boolean): Promise<boolean> => {
    if (pending.current || !latest.current.active) return false;
    const snapshot = latest.current;
    const version = revision.current;
    const { text, options } = buildDraftTerminalRequest(snapshot.text, submit);
    if (!text) return false;
    pending.current = true;
    try {
      const accepted = await requestReferenceInsertion(text, snapshot.sessionId,
        () => mounted.current && latest.current.active && latest.current.sessionId === snapshot.sessionId,
        undefined, options);
      // Report input acceptance, but don't clear/collapse or label newer edits.
      const unchanged = mounted.current && version === revision.current;
      if (unchanged) {
        if (accepted) latest.current.onAccepted();
        else latest.current.onRejected();
      }
      return accepted && unchanged;
    } finally {
      pending.current = false;
    }
  }, []);
}
