// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dismissSoftKeyboardForEdgeOpen } from './sidebarSoftKeyboard';

afterEach(() => {
  document.body.replaceChildren();
});

describe('dismissSoftKeyboardForEdgeOpen', () => {
  it('blurs the focused terminal textarea', () => {
    const textarea = document.createElement('textarea');
    textarea.className = 'xterm-helper-textarea';
    document.body.appendChild(textarea);
    textarea.focus();
    const blur = vi.spyOn(textarea, 'blur');

    dismissSoftKeyboardForEdgeOpen();

    expect(blur).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(textarea);
  });

  it('blurs other focused editable controls that can own the soft keyboard', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const blur = vi.spyOn(input, 'blur');

    dismissSoftKeyboardForEdgeOpen();

    expect(blur).toHaveBeenCalledOnce();
  });

  it('leaves unrelated focused controls alone', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    const blur = vi.spyOn(button, 'blur');

    dismissSoftKeyboardForEdgeOpen();

    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });
});
