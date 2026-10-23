import { useEffect, useState } from 'react';

/** Full-page restoration belongs to boot, never to a later workspace navigation. */
export function useInitialRestoreGate(initialViewportReady: boolean, workspaceActive: boolean): boolean {
  const [released, setReleased] = useState(initialViewportReady || workspaceActive);
  useEffect(() => { if (initialViewportReady || workspaceActive) setReleased(true); }, [initialViewportReady, workspaceActive]);
  return !released && !initialViewportReady && !workspaceActive;
}
