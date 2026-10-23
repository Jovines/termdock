import { currentSecureClient, savedConnection, SECURE_STATE_EVENT } from '../federation/browserIntegration';
import { getActiveKeyboardLayer } from '../hooks/useKeyboardLayer';
import { requestReferenceInsertion } from '../components/sidebar/requestReferenceInsertion';

/** Activate the chosen session, then use the existing owned-paste/ACK chain exactly once. */
export function insertSessionDraft(sessionId: string, text: string): Promise<'inserted' | 'cancelled' | 'failed'> {
  const client = currentSecureClient(), connection = savedConnection();
  const scopeCurrent = () => currentSecureClient() === client && !client?.closed
    && savedConnection()?.url === connection?.url && savedConnection()?.targetPeerId === connection?.targetPeerId;
  return new Promise(resolve => {
    let finished = false, inserting = false;
    const cleanup = () => {
      observer.disconnect(); window.clearTimeout(timer);
      document.removeEventListener('pointerdown', cancel, true); document.removeEventListener('keydown', cancel, true);
      window.removeEventListener(SECURE_STATE_EVENT, check);
    };
    const finish = (result: 'inserted' | 'cancelled' | 'failed') => { if (!finished) { finished = true; cleanup(); resolve(result); } };
    const cancel = () => { if (!inserting) finish('cancelled'); };
    const check = () => {
      if (finished || inserting) return;
      if (!scopeCurrent()) { finish('cancelled'); return; }
      const host = Array.from(document.querySelectorAll<HTMLElement>('[data-session-workspace]'))
        .find(node => node.dataset.sessionWorkspace === sessionId && node.dataset.sessionActive === 'true' && node.dataset.sessionInputReady === 'true');
      if (!host || getActiveKeyboardLayer()) return;
      inserting = true; cleanup();
      void requestReferenceInsertion(text, sessionId, () => scopeCurrent() && host.isConnected && host.dataset.sessionActive === 'true', host,
        { paste: true, submitAfterPaste: false, focus: true }).then(ok => finish(ok ? 'inserted' : scopeCurrent() ? 'failed' : 'cancelled'), () => finish(scopeCurrent() ? 'failed' : 'cancelled'));
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-session-active', 'data-session-input-ready', 'aria-hidden', 'inert'] });
    const timer = window.setTimeout(() => finish(scopeCurrent() ? 'failed' : 'cancelled'), 8000);
    document.addEventListener('pointerdown', cancel, true); document.addEventListener('keydown', cancel, true);
    window.addEventListener(SECURE_STATE_EVENT, check);
    window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: sessionId }));
    requestAnimationFrame(check);
  });
}
