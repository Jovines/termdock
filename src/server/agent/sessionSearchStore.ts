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
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const BUDGET_MAINTENANCE_INTERVAL_MS = 10 * 60_000;
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
  private metadataDirty = false;
  private metadataMustPersist = false;
  private lastMetadataWriteAt = 0;
  private lastBudgetMaintenanceAt = 0;

  constructor(private readonly directory: string, private readonly limits: {
    maxTotalBytes?: number;
    maxSessions?: number;
    maxAgeMs?: number;
  } = {}) {
    this.loadMetadata();
    this.enforceBudget();
  }

  append(metadata: SessionSearchMetadata, output: string): void {
    const text = clean(output);
    const previous = this.metadata.get(metadata.sessionId);
    this.metadata.set(metadata.sessionId, { ...metadata, updatedAt: Date.now() });
    this.metadataDirty = true;
    this.metadataMustPersist ||= this.metadataChanged(previous, metadata);
    if (text.trim()) this.pending.set(metadata.sessionId, [...(this.pending.get(metadata.sessionId) ?? []), text]);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 750);
  }

  update(metadata: SessionSearchMetadata): void {
    const previous = this.metadata.get(metadata.sessionId);
    this.metadata.set(metadata.sessionId, { ...metadata, updatedAt: Date.now() });
    this.metadataDirty = true;
    this.metadataMustPersist ||= this.metadataChanged(previous, metadata);
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
    if (this.metadata.size === 0 && this.pending.size === 0 && !this.metadataDirty) return;
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
    const now = Date.now();
    if (this.metadataDirty && (this.metadataMustPersist || now - this.lastMetadataWriteAt >= 30_000)) this.persistMetadata();
    if (now - this.lastBudgetMaintenanceAt >= BUDGET_MAINTENANCE_INTERVAL_MS) this.enforceBudget(now);
  }

  enforceBudget(now = Date.now()): void {
    this.lastBudgetMaintenanceAt = now;
    const maxSessions = this.limits.maxSessions ?? DEFAULT_MAX_SESSIONS;
    const maxAgeMs = this.limits.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const maxTotalBytes = this.limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const newest = [...this.metadata.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const retained = new Set(
      newest.filter((item, index) => index < maxSessions && now - item.updatedAt <= maxAgeMs).map((item) => item.sessionId),
    );
    let changed = false;
    for (const sessionId of this.metadata.keys()) {
      if (retained.has(sessionId)) continue;
      this.metadata.delete(sessionId);
      this.pending.delete(sessionId);
      this.removeSessionLogs(sessionId);
      changed = true;
    }

    let files = this.listLogFiles();
    for (const file of files) {
      if (retained.has(file.sessionId)) continue;
      try { fs.rmSync(file.path, { force: true }); } catch { /* best effort */ }
    }
    files = this.listLogFiles();
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const removalOrder = [
      ...files.filter((file) => file.previous).sort((a, b) => a.mtimeMs - b.mtimeMs),
      ...files.filter((file) => !file.previous).sort((a, b) => a.mtimeMs - b.mtimeMs),
    ];
    for (const file of removalOrder) {
      if (totalBytes <= maxTotalBytes) break;
      try { fs.rmSync(file.path, { force: true }); } catch { continue; }
      totalBytes -= file.size;
      if (!file.previous) {
        this.metadata.delete(file.sessionId);
        changed = true;
      }
    }
    if (changed) {
      this.metadataDirty = true;
      this.metadataMustPersist = true;
      this.persistMetadata();
    }
  }

  private loadMetadata(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metadataPath(), 'utf8')) as { sessions?: SessionSearchMetadata[] };
      for (const item of parsed.sessions ?? []) {
        if (item && typeof item.sessionId === 'string') this.metadata.set(item.sessionId, item);
      }
      this.lastMetadataWriteAt = Date.now();
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

  private metadataChanged(previous: SessionSearchMetadata | undefined, next: SessionSearchMetadata): boolean {
    return !previous
      || previous.backendSessionId !== next.backendSessionId
      || previous.title !== next.title
      || previous.cwd !== next.cwd
      || previous.agentSlug !== next.agentSlug
      || previous.agentNativeSessionId !== next.agentNativeSessionId;
  }

  private persistMetadata(): void {
    fs.mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.metadataPath()}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, sessions: [...this.metadata.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.metadataPath());
    this.lastMetadataWriteAt = Date.now();
    this.metadataDirty = false;
    this.metadataMustPersist = false;
  }

  private removeSessionLogs(sessionId: string): void {
    try { fs.rmSync(this.logPath(sessionId), { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(this.previousLogPath(sessionId), { force: true }); } catch { /* best effort */ }
  }

  private listLogFiles(): Array<{ path: string; sessionId: string; previous: boolean; size: number; mtimeMs: number }> {
    let names: string[];
    try { names = fs.readdirSync(this.directory); } catch { return []; }
    return names.flatMap((name) => {
      const match = name.match(/^(.*)\.log(\.1)?$/);
      if (!match) return [];
      let sessionId: string;
      try { sessionId = decodeURIComponent(match[1]); } catch { return []; }
      const filePath = path.join(this.directory, name);
      try {
        const stat = fs.statSync(filePath);
        return stat.isFile()
          ? [{ path: filePath, sessionId, previous: Boolean(match[2]), size: stat.size, mtimeMs: stat.mtimeMs }]
          : [];
      } catch { return []; }
    });
  }

  private metadataPath(): string { return path.join(this.directory, 'sessions.json'); }
  private logPath(sessionId: string): string { return path.join(this.directory, `${encodeURIComponent(sessionId)}.log`); }
  private previousLogPath(sessionId: string): string { return `${this.logPath(sessionId)}.1`; }
}
