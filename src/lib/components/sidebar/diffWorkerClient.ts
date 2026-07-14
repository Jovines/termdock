import type { FileData, HunkTokens } from 'react-diff-view';
import type { DiffInlineMode } from './DiffViewer';

interface WorkerSuccess {
  id: number;
  ok: true;
  files: FileData[];
  tokens: Array<[string, HunkTokens]>;
  parseMs: number;
  tokenizeMs: number;
}

interface WorkerFailure {
  id: number;
  ok: false;
  error: string;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

export interface DiffWorkerResult {
  files: FileData[];
  tokens: Map<string, HunkTokens>;
  parseMs: number;
  tokenizeMs: number;
}

let worker: Worker | null = null;
let requestSeq = 0;
const pending = new Map<number, {
  reject: (error: Error) => void;
  resolve: (result: DiffWorkerResult) => void;
}>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./diffWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const entry = pending.get(response.id);
      if (!entry) return;
      pending.delete(response.id);
      if (!response.ok) {
        entry.reject(new Error(response.error));
        return;
      }
      entry.resolve({
        files: response.files,
        tokens: new Map(response.tokens),
        parseMs: response.parseMs,
        tokenizeMs: response.tokenizeMs,
      });
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'Diff worker failed');
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

export function parseDiffInWorker(diffContent: string, inlineMode: DiffInlineMode, oldSource?: string): Promise<DiffWorkerResult> {
  const id = ++requestSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, diffContent, inlineMode, oldSource });
  });
}
