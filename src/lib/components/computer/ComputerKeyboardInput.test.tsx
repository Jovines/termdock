// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ComputerKeyboardInput from './ComputerKeyboardInput';
vi.mock('../../i18n', () => ({ useI18n: () => ({ t: () => 'Keyboard input' }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('sends ordinary typing directly and forwards Enter and empty-field Backspace without a clipboard operation', () => {
  const sendText = vi.fn(), sendKey = vi.fn(); render(<ComputerKeyboardInput sendText={sendText} sendKey={sendKey} />);
  const input = screen.getByRole('textbox') as HTMLInputElement; expect(document.activeElement).toBe(input); expect(input.tagName).toBe('INPUT'); expect(input.tabIndex).toBe(-1); expect(input.type).toBe('text'); expect(input.hidden).toBe(false);
  fireEvent.change(input, { target: { value: 'abc' } }); expect(sendText).toHaveBeenCalledExactlyOnceWith('abc'); expect(input.value).toBe('');
  fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Backspace' }); expect(sendKey.mock.calls).toEqual([['enter'], ['backspace']]);
});
it('waits for IME completion and sends the committed text once despite a trailing input event', () => {
  let frame!: FrameRequestCallback; vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { frame = callback; return 1; })); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const sendText = vi.fn(), sendKey = vi.fn(); render(<ComputerKeyboardInput sendText={sendText} sendKey={sendKey} />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: 'ni' } }); fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(sendText).not.toHaveBeenCalled(); expect(sendKey).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '你好' } }); fireEvent.compositionEnd(input); fireEvent.change(input, { target: { value: '你好' } });
  expect(sendText).not.toHaveBeenCalled(); act(() => frame(0)); expect(sendText).toHaveBeenCalledExactlyOnceWith('你好'); expect(input.value).toBe('');
});
