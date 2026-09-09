/** Same-origin retained workspaces share the physical screen and keyboard,
 * while their focus, terminal dimensions and stores remain document-local. */
export function viewportWindow(): Window & typeof globalThis {
  try {
    if (window.parent !== window && location.pathname === '/workspace.html'
      && window.parent.location.origin === location.origin && window.parent.__termdockWorkspaceHost) {
      return window.parent as Window & typeof globalThis;
    }
  } catch { /* Sandboxed previews never inherit workspace capabilities. */ }
  return window;
}
