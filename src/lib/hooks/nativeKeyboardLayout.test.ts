// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { focusKeyboardInput, measureNativePagePan } from './nativeKeyboardLayout';

const originalUrl = location.href;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); history.replaceState({}, '', originalUrl); });

it('uses the actual root displacement even when viewport-height data is wrong', () => {
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  let top = -367;
  vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => ({ top }) as DOMRect);
  vi.stubGlobal('visualViewport', { height: 9999, offsetTop: 1234 });
  expect(measureNativePagePan()).toBe(367);
  top = 0; expect(measureNativePagePan()).toBe(0);
  top = 12.5; expect(measureNativePagePan()).toBe(-12.5);
});

it.each([['iPhone', undefined], ['Linux', { preventScroll: true }]] as const)('preserves the intended native focus policy (%s)', (agent, options) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(agent);
  const input = document.createElement('textarea');
  const focus = vi.spyOn(input, 'focus');
  focusKeyboardInput(input);
  if (options) expect(focus).toHaveBeenCalledWith(options);
  else expect(focus).toHaveBeenCalledWith();
});

it('includes the retained workspace frame displacement in the physical position', () => {
  history.replaceState({}, '', '/workspace.html');
  const parent = { location: { origin: location.origin }, __termdockWorkspaceHost: {} } as unknown as Window;
  const frame = document.createElement('iframe');
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent);
  vi.spyOn(window, 'frameElement', 'get').mockReturnValue(frame);
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ top: -300 } as DOMRect);
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ top: -30 } as DOMRect);
  expect(measureNativePagePan()).toBe(330);
});
