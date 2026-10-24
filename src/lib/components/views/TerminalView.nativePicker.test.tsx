// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';

vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../terminal/factory', () => ({ createTermdockAPI: () => ({}) }));
vi.mock('../terminal/MobileKeyboard', async original => ({
  ...await original<typeof import('../terminal/MobileKeyboard')>(),
  // Connection setup is outside this regression; expose the real view's action
  // through a focus-preserving toolbar button without waiting for a backend.
  MobileKeyboard: ({ onFilePress }: { onFilePress: () => void }) =>
    <button onMouseDown={event => event.preventDefault()} onClick={onFilePress}>选择文件</button>,
}));
vi.mock('../terminal/TerminalViewport', () => ({
  TerminalViewport: React.forwardRef(function Viewport(_props, ref) {
    const input = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref, () => ({
      focus: () => input.current?.focus(),
      blur: () => input.current?.blur(),
      requestRefresh: () => {},
      serializeSnapshot: () => null,
    }));
    return <textarea ref={input} aria-label="终端输入" />;
  }),
}));
import { TerminalView } from './TerminalView';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('lets a native file menu handle the keyboard without a manual blur or focus cycle', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const view = render(<TerminalView sessionId="picker-focus" initialConnectEnabled={false} />);
  const input = screen.getByLabelText('终端输入') as HTMLTextAreaElement;
  act(() => input.focus());
  const focus = vi.spyOn(input, 'focus'), blur = vi.spyOn(input, 'blur');
  const picker = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const launch = vi.spyOn(picker, 'click').mockImplementation(() => {
    // Model cancellation with DOM focus preserved, as can happen on iOS.
    expect(document.activeElement).toBe(input);
    picker.dispatchEvent(new Event('cancel'));
  });
  fireEvent.click(screen.getByText('选择文件'));
  expect(launch).toHaveBeenCalledTimes(1);
  expect(blur).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  act(() => input.focus());
  expect(document.activeElement).toBe(input);
});
