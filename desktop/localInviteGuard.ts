export interface LocalInviteContext {
  registeredOrigin?: string;
  currentUrl: string;
  mainFrame: boolean;
  running: boolean;
  desktopManaged: boolean;
  servicePort: number;
}
/** Bootstrap secrets are restricted to the managed local application's top page.
 * Same-origin file previews, subframes and LAN/DNS aliases are deliberately excluded. */
export function canReadLocalInvite(context: LocalInviteContext): boolean {
  if (!context.mainFrame || !context.running || !context.desktopManaged || !context.registeredOrigin) return false;
  try {
    const url = new URL(context.currentUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== context.registeredOrigin || url.username || url.password) return false;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
    if (!['/', '/index.html'].includes(url.pathname)) return false;
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === context.servicePort;
  } catch { return false; }
}
