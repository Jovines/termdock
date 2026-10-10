import { isArchitectureFile } from './model';
export interface ArchitectureLink { root: string; file: string; peerId?: string; serviceName?: string }
export function parseArchitectureLink(search: string): ArchitectureLink | null {
  try {
    const raw = new URLSearchParams(search).get('architecture'); if (!raw || raw.length > 6000) return null;
    const value = JSON.parse(raw);
    if (typeof value.root !== 'string' || value.root.length > 4096 || /[\x00-\x1f]/.test(value.root) || !/^(?:\/|[A-Za-z]:[\\/])/.test(value.root) || typeof value.file !== 'string' || !isArchitectureFile(value.file)) return null;
    if (value.peerId !== undefined && (typeof value.peerId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.peerId))) return null;
    return { root: value.root, file: value.file, ...(value.peerId ? { peerId: value.peerId } : {}), ...(typeof value.serviceName === 'string' ? { serviceName: value.serviceName.slice(0, 200) } : {}) };
  } catch { return null; }
}
const pendingKey = (peerId: string) => `termdock-secure-architecture-link:${peerId}`;
export function queueArchitectureLink(link: ArchitectureLink): void {
  if (!link.peerId) return;
  sessionStorage.setItem(pendingKey(link.peerId), JSON.stringify({ link, at: Date.now() }));
}
export function consumeArchitectureLink(peerId: string | undefined): ArchitectureLink | null {
  if (!peerId) return null;
  try {
    const key = pendingKey(peerId), raw = sessionStorage.getItem(key); sessionStorage.removeItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw); if (!Number.isFinite(value.at) || Date.now() - value.at > 60_000) return null;
    const link = parseArchitectureLink(`?architecture=${encodeURIComponent(JSON.stringify(value.link))}`);
    return link?.peerId === peerId ? link : null;
  } catch { return null; }
}
export function architectureViewerUrl(origin: string, link: ArchitectureLink): string {
  const url = new URL('/', origin); url.searchParams.set('architecture', JSON.stringify(link)); return url.href;
}
