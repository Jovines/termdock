type WebWorkspaceBridge = {
  capabilities?: { webWorkspace?: boolean };
  openExternal?: (url:string)=>Promise<void>;
};

/** WK cannot provide xterm's default about:blank staging window. Open the
 * final HTTP(S) URL directly only for hosts that explicitly expose workspaces. */
export function createNativeWebLinkHandler(
  bridge: WebWorkspaceBridge | undefined,
  open: (url: string) => unknown,
): ((event: MouseEvent, uri: string) => void) | undefined {
  if (bridge?.capabilities?.webWorkspace !== true) return undefined;
  return (_event, uri) => {
    try {
      const url = new URL(uri);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      if(bridge.openExternal)void bridge.openExternal(url.href).catch(()=>{});
      else open(url.href);
    } catch { /* Ignore malformed terminal text. */ }
  };
}
