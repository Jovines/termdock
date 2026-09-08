/** Noise endpoints never use cookies as authority. A browser may legitimately
 * connect to a pinned target from another HTTPS service's PWA; possession of
 * the paired device key is still required before any business operation.
 * Legacy cookie-authenticated endpoints must not use this relaxed policy. */
export function secureChannelOriginAllowed(origin: string | undefined, sameOriginAllowed: () => boolean): boolean {
  if (origin === undefined) return true; // Native CLI/Mac relay.
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) return false;
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && sameOriginAllowed();
  } catch { return false; }
}
