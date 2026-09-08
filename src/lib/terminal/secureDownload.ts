/** Give Safari a normal attachment response without revisiting a business API.
 * The short-lived URL is served entirely by the controlling service worker. */
export async function prepareEncryptedDownload(blob: Blob, filename: string): Promise<string | null> {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return null;
  const channel = new MessageChannel();
  return new Promise(resolve => {
    const finish = (value: string | null) => { clearTimeout(timer); channel.port1.close(); resolve(value); };
    const timer = setTimeout(() => finish(null), 5000);
    channel.port1.onmessage = event => {
      try {
        const url = new URL(event.data.url, location.origin);
        finish(url.origin === location.origin && /^\/__termdock-download\/[a-f0-9-]{36}$/.test(url.pathname) ? url.href : null);
      } catch { finish(null); }
    };
    channel.port1.onmessageerror = () => finish(null);
    try { controller.postMessage({ type: 'termdock:prepare-download', blob, filename }, [channel.port2]); }
    catch { finish(null); }
  });
}
