import { useEffect, useState } from 'react';
import { isWithinDirectory, normalizeDirectory, parentDirectory } from '../filesystem/browserPaths';

/** A bounded picker and the unrestricted explorer use the same navigation rules. */
export function useDirectoryNavigation(initialPath: string, rootPath = '/') {
  const root = normalizeDirectory(rootPath);
  const initial = isWithinDirectory(initialPath, root) ? normalizeDirectory(initialPath) : root;
  const [location, setLocation] = useState({ root, initial, path: initial });
  const path = location.root === root && location.initial === initial ? location.path : initial;
  useEffect(() => { setLocation({ root, initial, path: initial }); }, [root, initial]);
  const navigate = (next: string) => {
    if (isWithinDirectory(next, root)) setLocation({ root, initial, path: normalizeDirectory(next) });
  };
  return {
    path,
    navigate,
    canGoParent: path !== root,
    goParent: () => navigate(parentDirectory(path)),
    goRoot: () => navigate(root),
  };
}
