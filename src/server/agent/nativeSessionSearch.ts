import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';

export interface NativeSessionRecord {
  key: string;
  agentSlug: 'codex' | 'claude';
  agentNativeSessionId: string;
  title: string;
  cwd: string;
  updatedAt: number;
}

export interface NativeSessionMatch extends NativeSessionRecord {
  snippet: string;
  matchCount: number;
}

export interface NativeSearchStatus {
  total: number;
  indexed: number;
  building: boolean;
  failed: number;
  warning: string | null;
}

export interface NativeSearchResponse {
  results: NativeSessionMatch[];
  matchedSessions: string[];
  total: number;
  index: NativeSearchStatus;
}

/** Keep transcript parsing and text scans off the terminal server's event loop.
 * The worker and its private, incremental cache start only when search is used.
 */
export class NativeSessionSearch {
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void }>();

  constructor(private readonly directory: string) {}

  search(query: string, limit: number, titles: Array<{ agentSlug: string; agentNativeSessionId: string; title: string }>, signal?: AbortSignal): Promise<NativeSearchResponse> {
    return this.request({ type: 'search', query, limit, titles }, signal) as Promise<NativeSearchResponse>;
  }

  get(key: string): Promise<NativeSessionRecord | null> {
    return this.request({ type: 'get', key }) as Promise<NativeSessionRecord | null>;
  }

  private request(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('搜索已取消'));
    if (!this.worker) {
      const compiled = new URL('../workers/nativeSessionSearchWorker.js', import.meta.url);
      // tsx development runs source files; production always uses compiled JS.
      const url = fs.existsSync(compiled) ? compiled : new URL('../workers/nativeSessionSearchWorker.ts', import.meta.url);
      this.worker = new Worker(url, { workerData: {
        directory: this.directory,
        codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
        claudeHome: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
      } });
      const worker = this.worker;
      worker.unref();
      worker.on('message', (message: { id: number; value?: unknown; error?: string }) => {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.cleanup();
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.value);
      });
      const fail = (error: Error) => {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.cleanup(); entry.reject(error); }
        this.pending.clear();
        void worker.terminate();
      };
      worker.on('error', fail);
      worker.on('exit', () => fail(new Error('历史会话索引服务已退出，请重新搜索')));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const worker = this.worker!;
      const cancel = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', cancel);
        worker.postMessage({ id, type: 'cancel' });
        reject(new Error('搜索已取消'));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', cancel);
        worker.postMessage({ id, type: 'cancel' });
        reject(new Error('历史会话搜索超时，请缩短关键词后重试'));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer, cleanup: () => signal?.removeEventListener('abort', cancel) });
      signal?.addEventListener('abort', cancel, { once: true });
      worker.postMessage({ id, ...input });
    });
  }
}
