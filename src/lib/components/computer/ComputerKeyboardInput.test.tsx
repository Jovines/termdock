// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ComputerKeyboardInput from './ComputerKeyboardInput';
vi.mock('../../i18n', () => ({ useI18n: () => ({ t: () => 'Keyboard input' }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('sends ordinary typing directly and forwards Enter and empty-field Backspace without a clipboard operation', () => {
  const sendText = vi.fn(), sendKey = vi.fn(); render(<ComputerKeyboardInput sendText={sendText} sendKey={sendKey} />);
  const input = screen.getByRole('textbox') as HTMLInputElement; expect(document.activeElement).toBe(input); expect(input.tagName).toBe('INPUT'); expect(input.tabIndex).toBe(0); expect(input.type).toBe('text'); expect(input.hidden).toBe(false);
  fireEvent.change(input, { target: { value: '\u200babc' } }); expect(sendText).toHaveBeenCalledExactlyOnceWith('abc'); expect(input.value).toBe('\u200babc');
  fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Backspace' }); expect(sendKey.mock.calls).toEqual([['enter'], ['backspace']]);
});
it('waits for IME completion and sends the committed text once despite a trailing input event', () => {
  const sendText = vi.fn(), sendKey = vi.fn(); render(<ComputerKeyboardInput sendText={sendText} sendKey={sendKey} />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: 'ni' } }); fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(sendText).not.toHaveBeenCalled(); expect(sendKey).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '你好' } }); fireEvent.compositionEnd(input); fireEvent.change(input, { target: { value: '你好' } });
  expect(sendText).toHaveBeenCalledExactlyOnceWith('你好'); expect(input.value).toBe('\u200b你好');
});
it('handles repeated phone deletion and Return from native beforeinput without keydown', () => {
  const sendText = vi.fn(), sendKey = vi.fn(); render(<ComputerKeyboardInput sendText={sendText} sendKey={sendKey} />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  for (const inputType of ['deleteContentBackward', 'deleteContentBackward', 'deleteContentForward', 'insertLineBreak', 'insertParagraph']) {
    const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
    fireEvent(input, event); expect(event.defaultPrevented).toBe(true); expect(input.value).toBe('\u200b');
  }
  expect(sendKey.mock.calls).toEqual([['backspace'], ['backspace'], ['delete'], ['enter'], ['enter']]); expect(sendText).not.toHaveBeenCalled();
});
it('supports keyboards which delete the anchor without beforeinput', () => {
  const sendText = vi.fn(), sendKey = vi.fn(); render(<ComputerKeyboardInput sendText={sendText} sendKey={sendKey} />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.input(input, { target: { value: '' }, inputType: 'deleteContentBackward' });
  expect(sendKey).toHaveBeenCalledExactlyOnceWith('backspace'); expect(input.value).toBe('\u200b'); expect(sendText).not.toHaveBeenCalled();
});
it('leaves candidate deletion to the IME and commits before a following real Return', () => {
  const operations: string[] = []; render(<ComputerKeyboardInput sendText={text => operations.push(text)} sendKey={key => operations.push(key)} />);
  const input = screen.getByRole('textbox');
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: 'ni' } });
  const deletion = new InputEvent('beforeinput', { inputType: 'deleteContentBackward', isComposing: true, cancelable: true });
  fireEvent(input, deletion); expect(deletion.defaultPrevented).toBe(false); expect(operations).toEqual([]);
  fireEvent.change(input, { target: { value: '你好' } }); fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: 'Enter' }); expect(operations).toEqual(['你好', 'enter']);
});
it('retains an IME commit on blur and does not send an IME processing key', () => {
  const sendText = vi.fn(), sendKey = vi.fn(); render(<ComputerKeyboardInput sendText={sendText} sendKey={sendKey} />);
  const input = screen.getByRole('textbox');
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 }); expect(sendKey).not.toHaveBeenCalled();
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: '手机输入🙂' } }); fireEvent.compositionEnd(input); fireEvent.blur(input);
  expect(sendText).toHaveBeenCalledExactlyOnceWith('手机输入🙂');
});
it('does not turn the trailing phone IME line break into a remote Return', () => {
  const sendText = vi.fn(), sendKey = vi.fn(); render(<ComputerKeyboardInput sendText={sendText} sendKey={sendKey} />);
  const input = screen.getByRole('textbox');
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: '你好' } }); fireEvent.compositionEnd(input);
  fireEvent(input, new InputEvent('beforeinput', { inputType: 'insertLineBreak', cancelable: true }));
  expect(sendText).toHaveBeenCalledExactlyOnceWith('你好'); expect(sendKey).not.toHaveBeenCalled();
  fireEvent(input, new InputEvent('beforeinput', { inputType: 'insertLineBreak', cancelable: true }));
  expect(sendKey).toHaveBeenCalledExactlyOnceWith('enter');
});

it('does not lose or duplicate a committed IME candidate when the keyboard panel unmounts', () => {
  const sendText = vi.fn(), sendKey = vi.fn(); const view = render(<ComputerKeyboardInput sendText={sendText} sendKey={sendKey} />);
  const input = screen.getByRole('textbox');
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: '已确认🙂' } }); fireEvent.compositionEnd(input);
  view.unmount(); expect(sendText).toHaveBeenCalledExactlyOnceWith('已确认🙂');
});

it('forwards hardware shortcuts and modified navigation while leaving native paste and IME alone', () => {
  const sendChord = vi.fn(), sendText = vi.fn(), sendKey = vi.fn();
  render(<ComputerKeyboardInput sendText={sendText} sendKey={sendKey} sendChord={sendChord} commandKey={[0xffe3, 'ControlLeft']} />);
  const input = screen.getByRole('textbox');
  fireEvent.keyDown(input, { key: 'a', code: 'KeyA', metaKey: true });
  fireEvent.keyDown(input, { key: 'Backspace', code: 'Backspace', ctrlKey: true });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true });
  expect(sendChord.mock.calls).toEqual([
    [[[0xffe3, 'ControlLeft'], [0x61, 'KeyA']]],
    [[[0xffe3, 'ControlLeft'], [0xff08, 'Backspace']]],
    [[[0xffe1, 'ShiftLeft'], [0xff0d, 'Enter']]],
  ]);
  fireEvent.keyDown(input, { key: 'v', code: 'KeyV', ctrlKey: true });
  fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'a', code: 'KeyA', ctrlKey: true, isComposing: true });
  expect(sendChord).toHaveBeenCalledTimes(3); expect(sendKey).not.toHaveBeenCalled();
});

it('retains native context for continuous typing, word replacement and repeated deletion across the local boundary', () => {
  const operations: string[] = [];
  render(<ComputerKeyboardInput sendText={text => operations.push(text)} sendKey={key => operations.push(key)} />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.input(input, { target: { value: '\u200bteh' }, inputType: 'insertText' });
  fireEvent.input(input, { target: { value: '\u200bthe' }, inputType: 'insertReplacementText' });
  fireEvent.input(input, { target: { value: '\u200bthe🙂' }, inputType: 'insertText' });
  const deletion = new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true });
  fireEvent(input, deletion); expect(deletion.defaultPrevented).toBe(false);
  fireEvent.input(input, { target: { value: '\u200bthe' }, inputType: 'deleteContentBackward' });
  fireEvent.input(input, { target: { value: '\u200b' }, inputType: 'deleteWordBackward' });
  fireEvent(input, new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
  expect(operations).toEqual(['teh', 'backspace', 'backspace', 'he', '🙂', 'backspace', 'backspace', 'backspace', 'backspace', 'backspace']);
  expect(input.value).toBe('\u200b');
});
it('sends consecutive IME candidates once and resets context after remote navigation', () => {
  const sendText = vi.fn(), sendKey = vi.fn(); render(<ComputerKeyboardInput sendText={sendText} sendKey={sendKey} />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  for (const value of ['你好', '你好世界🙂']) {
    fireEvent.compositionStart(input); fireEvent.change(input, { target: { value } });
    fireEvent.compositionEnd(input); fireEvent.input(input, { target: { value }, inputType: 'insertFromComposition' });
  }
  expect(sendText.mock.calls).toEqual([['你好'], ['世界🙂']]);
  fireEvent(input, new Event('termdock:computer-input-reset'));
  fireEvent.input(input, { target: { value: '\u200b新位置' }, inputType: 'insertText' });
  expect(sendText.mock.calls).toEqual([['你好'], ['世界🙂'], ['新位置']]);
  expect(sendKey).not.toHaveBeenCalled();
});
it('preserves multiline Unicode paste instead of letting a single-line input strip line breaks', () => {
  const pasteText = vi.fn(), sendText = vi.fn();
  render(<ComputerKeyboardInput sendText={sendText} sendKey={vi.fn()} pasteText={pasteText} />);
  const clipboardData = { types: ['text/plain'], getData: () => '第一行🙂\nsecond line\n' };
  fireEvent.paste(screen.getByRole('textbox'), { clipboardData });
  expect(pasteText).toHaveBeenCalledExactlyOnceWith('第一行🙂\nsecond line\n');
  expect(sendText).not.toHaveBeenCalled();
});
