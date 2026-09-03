export interface RecoverableWebContents {
  getURL(): string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

interface ServiceDocumentState {
  origin?: unknown;
  readyState?: unknown;
  rootChildren?: unknown;
}

const SERVICE_DOCUMENT_STATE_SCRIPT = String.raw`
(() => ({
  origin: window.location.origin,
  readyState: document.readyState,
  rootChildren: document.getElementById('root')?.childElementCount ?? 0,
}))()
`;

export async function serviceDocumentNeedsReload(
  webContents: RecoverableWebContents,
  expectedOrigin: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  try {
    if (new URL(webContents.getURL()).origin !== expectedOrigin) return true;
  } catch {
    return true;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const state = await Promise.race([
      webContents.executeJavaScript(SERVICE_DOCUMENT_STATE_SCRIPT, true),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]) as ServiceDocumentState | null;
    return !state
      || state.origin !== expectedOrigin
      || state.readyState !== 'complete'
      || typeof state.rootChildren !== 'number'
      || state.rootChildren < 1;
  } catch {
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
