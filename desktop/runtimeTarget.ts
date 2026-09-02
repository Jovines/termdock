export interface DesktopRuntimeTargetInput {
  origin: string;
  servicePort: number;
  desktopManaged: boolean;
  localAddresses: ReadonlySet<string>;
}

export function isOwnedDesktopRuntimeTarget(input: DesktopRuntimeTargetInput): boolean {
  if (!input.desktopManaged) return false;
  try {
    const url = new URL(input.origin);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const localHost = hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '::1'
      || input.localAddresses.has(hostname);
    return localHost && port === input.servicePort;
  } catch {
    return false;
  }
}
