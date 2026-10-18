import { useCallback, useEffect, useRef, useState } from 'react';

const CLIPBOARD_FEEDBACK_MS = 5000;

type Feedback = { message: string; kind: 'clipboard' | 'persistent'; owner: string };
export type ClipboardFeedbackOperation = { owner: string; generation: number };
export type ClipboardFeedbackOperationHandle = ClipboardFeedbackOperation & {
  isCurrent: () => boolean;
  fail: (message: string) => void;
  succeed: () => void;
};

/** Small owner-scoped feedback state for native viewport clipboard operations. */
export function useNativeViewportFeedback(owner: string) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const ownerRef = useRef(owner);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const timerGenerationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (ownerRef.current !== owner) { generationRef.current += 1; ownerRef.current = owner; }

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const clearClipboardError = useCallback((operation?: ClipboardFeedbackOperation) => {
    if (operation && operation.owner !== ownerRef.current) return;
    if (operation && operation.generation !== generationRef.current) return;
    cancelTimer();
    timerGenerationRef.current += 1;
    generationRef.current += 1;
    setFeedback(current => current?.kind === 'clipboard' ? null : current);
  }, [cancelTimer]);

  const showClipboardError = useCallback((message: string, operation?: ClipboardFeedbackOperation) => {
    if (!mountedRef.current) return;
    const scope = operation ?? { owner: ownerRef.current, generation: generationRef.current + 1 };
    if (scope.owner !== ownerRef.current) return;
    if (operation && operation.generation !== generationRef.current) return;
    cancelTimer();
    if (!operation) generationRef.current += 1;
    const timerGeneration = ++timerGenerationRef.current;
    setFeedback(current => current?.kind === 'persistent' && current.owner === scope.owner ? current : { message, kind: 'clipboard', owner: scope.owner });
    timerRef.current = setTimeout(() => {
      if (timerGenerationRef.current !== timerGeneration || ownerRef.current !== scope.owner) return;
      setFeedback(current => current?.kind === 'clipboard' && current.owner === scope.owner ? null : current);
      timerRef.current = null;
    }, CLIPBOARD_FEEDBACK_MS);
  }, [cancelTimer]);

  const beginClipboardOperation = useCallback((): ClipboardFeedbackOperationHandle => {
    clearClipboardError();
    const operation = { owner: ownerRef.current, generation: ++generationRef.current };
    const isCurrent = () => mountedRef.current
      && operation.owner === ownerRef.current
      && operation.generation === generationRef.current;
    return {
      ...operation,
      isCurrent,
      fail: message => showClipboardError(message, operation),
      succeed: () => clearClipboardError(operation),
    };
  }, [clearClipboardError, showClipboardError]);

  const showPersistentError = useCallback((message: string, expectedOwner?: string) => {
    if (!mountedRef.current) return;
    if (expectedOwner && expectedOwner !== ownerRef.current) return;
    cancelTimer();
    timerGenerationRef.current += 1;
    generationRef.current += 1;
    setFeedback({ message, kind: 'persistent', owner: ownerRef.current });
  }, [cancelTimer]);

  const clear = useCallback(() => {
    cancelTimer();
    timerGenerationRef.current += 1;
    generationRef.current += 1;
    setFeedback(null);
  }, [cancelTimer]);

  useEffect(() => {
    if (feedback && feedback.owner !== owner) clear();
  }, [clear, feedback, owner]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelTimer();
      timerGenerationRef.current += 1;
      generationRef.current += 1;
    };
  }, [cancelTimer]);

  return {
    message: feedback?.owner === owner ? feedback.message : null,
    beginClipboardOperation,
    clearClipboardError,
    showClipboardError,
    showPersistentError,
    clear,
  };
}
