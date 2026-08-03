const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * xterm's WebLinksAddon opens a blank window first and assigns its URL after
 * window.open() returns. Electron must briefly allow that hidden staging
 * window or the addon never gets an object whose location it can update.
 */
export function isExternalLinkStagingUrl(url: string): boolean {
  return url === 'about:blank';
}

export function isSafeExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
