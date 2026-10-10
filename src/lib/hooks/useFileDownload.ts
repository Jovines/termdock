import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { downloadFile, type DownloadResult } from '../terminal/api';

export type FileDownloadStatus = 'idle' | 'pending' | DownloadResult | 'error';
interface DownloadState {
  status: FileDownloadStatus;
  error: string | null;
  result: DownloadResult | null;
}
const IDLE: DownloadState = { status: 'idle', error: null, result: null };

/** A preview owns its download. Changing/closing it cancels its request. */
export function useFileDownload(path: string | null, active = true) {
  const [state, setState] = useState<DownloadState>(IDLE);
  const request = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    setState(IDLE);
    return () => {
      const previous = request.current;
      request.current = null;
      previous?.abort();
    };
  }, [path, active]);

  const cancel = useCallback(() => {
    const previous = request.current;
    if (!previous) return;
    request.current = null;
    previous.abort();
    setState({ status: 'canceled', error: null, result: 'canceled' });
  }, []);

  const start = useCallback(async () => {
    if (!active || !path || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setState({ status: 'pending', error: null, result: null });
    try {
      const result = await downloadFile(path, controller.signal);
      if (request.current !== controller) return;
      request.current = null;
      const settled = controller.signal.aborted ? 'canceled' : result;
      setState({ status: settled, error: null, result: settled });
    } catch (error) {
      if (request.current !== controller) return;
      request.current = null;
      if (controller.signal.aborted) {
        setState({ status: 'canceled', error: null, result: 'canceled' });
      } else {
        setState({ status: 'error', error: error instanceof Error ? error.message : String(error), result: null });
      }
    }
  }, [path, active]);

  return { ...state, start, cancel };
}
