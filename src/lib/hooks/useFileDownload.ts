import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { downloadFile, type DownloadResult } from '../terminal/api';
import { selectedTarget, subscribeSelectedTarget } from '../federation/clientScope';

export type FileDownloadStatus = 'idle' | 'pending' | DownloadResult | 'error';
interface DownloadState {
  status: FileDownloadStatus;
  error: string | null;
  result: DownloadResult | null;
}
const IDLE: DownloadState = { status: 'idle', error: null, result: null };

/** A preview owns its download. Changing/closing it cancels its request. */
export function useDownloadTask(task: (signal: AbortSignal) => Promise<DownloadResult>, owner: unknown, active = true) {
  const [state, setState] = useState<DownloadState>(IDLE);
  const request = useRef<{ controller: AbortController; targetPeerId: string | undefined } | null>(null);

  useEffect(() => subscribeSelectedTarget((target) => {
    const current = request.current;
    if (!current || current.targetPeerId === target?.targetPeerId) return;
    request.current = null;
    current.controller.abort(new DOMException('Download target changed', 'AbortError'));
    setState({ status: 'canceled', error: null, result: 'canceled' });
  }), []);

  useLayoutEffect(() => {
    setState(IDLE);
    return () => {
      const previous = request.current;
      request.current = null;
      previous?.controller.abort();
    };
  }, [owner, active]);

  const cancel = useCallback(() => {
    const previous = request.current;
    if (!previous) return;
    request.current = null;
    previous.controller.abort();
    setState({ status: 'canceled', error: null, result: 'canceled' });
  }, []);

  const start = useCallback(async () => {
    if (!active || request.current) return;
    const controller = new AbortController();
    const targetPeerId = selectedTarget()?.targetPeerId;
    request.current = { controller, targetPeerId };
    setState({ status: 'pending', error: null, result: null });
    try {
      const result = await task(controller.signal);
      if (request.current?.controller !== controller) return;
      request.current = null;
      const settled = controller.signal.aborted ? 'canceled' : result;
      setState({ status: settled, error: null, result: settled });
    } catch (error) {
      if (request.current?.controller !== controller) return;
      request.current = null;
      if (controller.signal.aborted) {
        setState({ status: 'canceled', error: null, result: 'canceled' });
      } else {
        setState({ status: 'error', error: error instanceof Error ? error.message : String(error), result: null });
      }
    }
  }, [task, active]);

  return { ...state, start, cancel };
}

/** File trees and previews share the same cancellation and result lifecycle. */
export function useFileDownload(path: string | null, active = true) {
  const task = useCallback((signal: AbortSignal) => downloadFile(path!, signal), [path]);
  return useDownloadTask(task, path, active && !!path);
}
