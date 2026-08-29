import fs from 'node:fs';
import path from 'node:path';

export interface SessionSearchMetadata {
  sessionId: string;
  backendSessionId: string | null;
  title: string;
  cwd: string;
  agentSlug: string | null;
  agentNativeSessionId: string | null;
  updatedAt: number;
}

export interface SessionSearchResult extends SessionSearchMetadata {
  snippet: string;
  matchCount: number;
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LOG_SEGMENT_BYTES = MAX_LOG_BYTES / 2;
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function clean(value: string): string {
  return value
    .replace(ANSI_PATTERN, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r/g, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

export class SessionSearchStore {
  private metadata = new Map<string, SessionSearchMetadata>();
  private pending = new Map<string, string[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly directory: string) {
    this.loadMetadata();
  }

  append(metadata: SessionSearchMetadata, output: string): void {
    const text = clean(output);
    this.metadata.set(metadata.sessionId, { ...metadata, updatedAt: Date.now() });
    if (text.trim()) this.pending.set(metadata.sessionId, [...(this.pending.get(metadata.sessionId) ?? []), text]);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 750);
  }

  update(metadata: SessionSearchMetadata): void {
    this.metadata.set(metadata.sessionId, { ...metadata, updatedAt: Date.now() });
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 750);
  }

  search(query: string, limit = 30): SessionSearchResult[] {
    this.flush();
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const results: SessionSearchResult[] = [];
    for (const metadata of this.metadata.values()) {
      const text = this.readLog(metadata.sessionId);
      const searchable = `${metadata.title}\n${metadata.cwd}\n${metadata.agentSlug ?? ''}\n${text}`;
      const lower = searchable.toLocaleLowerCase();
      const first = lower.indexOf(needle);
      if (first < 0) continue;
      let count = 0;
      let cursor = 0;
      while ((cursor = lower.indexOf(needle, cursor)) >= 0 && count < 999) { count += 1; cursor += needle.length; }
      const sourceStart = Math.max(0, first - 100);
      const sourceEnd = Math.min(searchable.length, first + needle.length + 180);
      results.push({ ...metadata, snippet: searchable.slice(sourceStart, sourceEnd).replace(/\s+/g, ' ').trim(), matchCount: count });
    }
    return results.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(1, Math.min(limit, 100)));
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.metadata.size === 0 && this.pending.size === 0) return;
    fs.mkdirSync(this.directory, { recursive: true });
    for (const [sessionId, chunks] of this.pending) {
      const logPath = this.logPath(sessionId);
      const chunk = Buffer.from(chunks.join(''));
      const currentSize = this.fileSize(logPath);
      if (currentSize > 0 && currentSize + chunk.length > LOG_SEGMENT_BYTES) {
        const previousPath = this.previousLogPath(sessionId);
        try { fs.rmSync(previousPath, { force: true }); } catch { /* best effort */ }
        fs.renameSync(logPath, previousPath);
      }

      // A single pathological TUI frame must not defeat the bounded log. Keep
      // its newest bytes; normal output remains append-only until rotation.
      const boundedChunk = chunk.length > LOG_SEGMENT_BYTES
        ? chunk.subarray(chunk.length - LOG_SEGMENT_BYTES)
        : chunk;
      fs.appendFileSync(logPath, boundedChunk, { mode: 0o600 });
    }
    this.pending.clear();
    const temporaryPath = `${this.metadataPath()}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, sessions: [...this.metadata.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.metadataPath());
  }

  private loadMetadata(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metadataPath(), 'utf8')) as { sessions?: SessionSearchMetadata[] };
      for (const item of parsed.sessions ?? []) {
        if (item && typeof item.sessionId === 'string') this.metadata.set(item.sessionId, item);
      }
    } catch { /* first run */ }
  }

  private readLog(sessionId: string): string {
    let text = '';
    try { text += fs.readFileSync(this.previousLogPath(sessionId), 'utf8'); } catch { /* no previous segment */ }
    try { text += fs.readFileSync(this.logPath(sessionId), 'utf8'); } catch { /* no current segment */ }
    return text;
  }

  private fileSize(filePath: string): number {
    try { return fs.statSync(filePath).size; } catch { return 0; }
  }

  private metadataPath(): string { return path.join(this.directory, 'sessions.json'); }
  private logPath(sessionId: string): string { return path.join(this.directory, `${encodeURIComponent(sessionId)}.log`); }
  private previousLogPath(sessionId: string): string { return `${this.logPath(sessionId)}.1`; }
}
