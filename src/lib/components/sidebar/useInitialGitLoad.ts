import { useEffect, type MutableRefObject } from 'react';

/** Preferences are optional; a stalled settings request must not block Git. */
export async function waitForGitPreferences(hydrate: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      hydrate(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 3_000); }),
    ]);
  } catch {
    // Keep the cached preference when settings are unavailable.
  } finally {
    clearTimeout(timer);
  }
}

/** Claim a workspace only when its delayed request actually starts. */
export function useInitialGitLoad({ active, rootPath, loading, delay, lastStartedRoot, load }: {
  active: boolean;
  rootPath: string | null;
  loading: boolean;
  delay: number;
  lastStartedRoot: MutableRefObject<string | null>;
  load: (root: string) => void;
}) {
  useEffect(() => {
    if (!active || !rootPath || loading || lastStartedRoot.current === rootPath) return;
    const timer = window.setTimeout(() => {
      lastStartedRoot.current = rootPath;
      load(rootPath);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [active, rootPath, loading, delay, lastStartedRoot, load]);
}
