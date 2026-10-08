import type { SavedConnection } from './types.js';

export interface ServiceMenuEntry {
  label: string;
  connection?: SavedConnection;
}

function localEndpoint(url: URL): string {
  const hostname = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ? 'localhost'
    : url.hostname;
  // HTTP and HTTPS bookmarks on the same local port refer to the same
  // listener, including bookmarks saved before HTTPS was enabled.
  return `${hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}${url.pathname.replace(/\/+$/, '')}`;
}

/** Merge the built-in local shortcut with its bookmark without changing the
 * saved directory. Names alone never identify a local service. */
export function serviceMenuEntries(connections: SavedConnection[], localUrl: string): ServiceMenuEntry[] {
  const local = localEndpoint(new URL(localUrl));
  const isLocal = (connection: SavedConnection): boolean => {
    // A remote target may use the local service as its relay entry.
    if (connection.entryServiceId && connection.entryServiceId !== connection.targetPeerId) return false;
    return localEndpoint(new URL(connection.serviceOrigin || connection.url)) === local;
  };
  const entries: ServiceMenuEntry[] = [
    { label: '本机' },
    ...connections.filter(connection => !isLocal(connection)).map(connection => ({
      label: connection.label.trim() || new URL(connection.serviceOrigin || connection.url).host,
      connection,
    })),
  ];
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.label, (counts.get(entry.label) || 0) + 1);
  return entries.map(entry => (counts.get(entry.label) || 0) > 1 && entry.connection
    ? { ...entry, label: `${entry.label} (${new URL(entry.connection.serviceOrigin || entry.connection.url).host})` }
    : entry);
}
