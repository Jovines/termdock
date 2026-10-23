// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { insertSessionDraft } from './insertSessionDraft';
import { TODO_GUIDANCE } from '../todos/guidance';
const state = vi.hoisted(() => ({ peer: 'one', client: { closed: false }, layer: null as object | null, insert: vi.fn() }));
vi.mock('../federation/browserIntegration', () => ({ currentSecureClient: () => state.client, savedConnection: () => ({ url: 'https://local', targetPeerId: state.peer }), SECURE_STATE_EVENT: 'secure-test' }));
vi.mock('../hooks/useKeyboardLayer', () => ({ getActiveKeyboardLayer: () => state.layer }));
vi.mock('../components/sidebar/requestReferenceInsertion', () => ({ requestReferenceInsertion: state.insert }));
beforeEach(() => {
  state.peer = 'one'; state.layer = null; state.insert.mockReset().mockResolvedValue(true);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
function host(id: string, ready = true) { const element = document.createElement('div'); element.dataset.sessionWorkspace = id; element.dataset.sessionActive = 'true'; element.dataset.sessionInputReady = String(ready); document.body.append(element); return element; }
it('inserts short CLI guidance once into the exact session through owned paste, without submitting', async () => {
  host('other'); const target = host('target');
  expect(TODO_GUIDANCE).toContain('td todo --help'); expect(TODO_GUIDANCE.length).toBeLessThan(80); expect(TODO_GUIDANCE).not.toContain('\n');
  expect(await insertSessionDraft('target', TODO_GUIDANCE)).toBe('inserted');
  expect(state.insert).toHaveBeenCalledOnce();
  expect(state.insert).toHaveBeenCalledWith(TODO_GUIDANCE, 'target', expect.any(Function), target, { paste: true, submitAfterPaste: false, focus: true });
});
it('waits for activation and editor readiness before inserting into a background session', async () => {
  const target = host('target', false); target.dataset.sessionActive = 'false';
  const result = insertSessionDraft('target', TODO_GUIDANCE);
  await new Promise(resolve => setTimeout(resolve, 5)); expect(state.insert).not.toHaveBeenCalled();
  target.dataset.sessionActive = 'true'; target.dataset.sessionInputReady = 'true';
  expect(await result).toBe('inserted'); expect(state.insert).toHaveBeenCalledOnce();
});
it('cancels a waiting insertion when the user changes intent or service', async () => {
  host('target', false); const first = insertSessionDraft('target', TODO_GUIDANCE);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); expect(await first).toBe('cancelled');
  const second = insertSessionDraft('target', TODO_GUIDANCE); state.peer = 'two'; window.dispatchEvent(new Event('secure-test'));
  expect(await second).toBe('cancelled'); expect(state.insert).not.toHaveBeenCalled();
});
it('reports rejected input instead of retrying or automatically executing it', async () => {
  host('target'); state.insert.mockResolvedValue(false);
  expect(await insertSessionDraft('target', TODO_GUIDANCE)).toBe('failed'); expect(state.insert).toHaveBeenCalledOnce();
});
it('waits for the session menu keyboard layer to close before acquiring input ownership', async () => {
  const target = host('target'); state.layer = {};
  const result = insertSessionDraft('target', TODO_GUIDANCE);
  await new Promise(resolve => setTimeout(resolve, 5)); expect(state.insert).not.toHaveBeenCalled();
  state.layer = null; target.dataset.sessionInputReady = 'true';
  expect(await result).toBe('inserted'); expect(state.insert).toHaveBeenCalledOnce();
});
