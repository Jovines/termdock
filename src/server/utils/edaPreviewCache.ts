export interface EdaPreviewCacheEntry {
  body: Buffer;
  mimeType: string;
}

/** Small byte-bounded LRU for expensive KiCad render results. */
export class EdaPreviewCache {
  private readonly entries = new Map<string, EdaPreviewCacheEntry>();
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): EdaPreviewCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: EdaPreviewCacheEntry): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.totalBytes -= previous.body.length;
      this.entries.delete(key);
    }
    if (entry.body.length > this.maxBytes) return;
    this.entries.set(key, entry);
    this.totalBytes += entry.body.length;
    while (this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.totalBytes -= oldest.body.length;
    }
  }

  get sizeBytes(): number {
    return this.totalBytes;
  }
}

export function requestAcceptsEtag(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const target = etag.replace(/^W\//, '');
  return (Array.isArray(header) ? header : [header]).some((value) => (
    value.split(',').some((candidate) => {
      const token = candidate.trim();
      return token === '*' || token.replace(/^W\//, '') === target;
    })
  ));
}
