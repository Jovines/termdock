// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RetainedPane } from './RetainedPane';

afterEach(cleanup);

describe('retained sidebar panes', () => {
  it('retains content and dimensions while excluding hidden controls from focus', () => {
    const content = <><input defaultValue="draft" /><div data-testid="tokens"><span>code</span></div></>;
    const view = render(<RetainedPane active>{content}</RetainedPane>);
    const input = view.container.querySelector('input')!;
    const tokens = view.getByTestId('tokens');
    input.value = 'edited draft';
    view.rerender(<RetainedPane active={false}>{content}</RetainedPane>);
    const pane = view.container.firstElementChild as HTMLElement;
    expect(pane.style.clipPath).toBe('inset(100%)');
    expect(pane.getAttribute('aria-hidden')).toBe('true');
    expect(input.inert).toBe(true);
    expect(pane.inert).not.toBe(true);
    expect(tokens.inert).not.toBe(true);
    expect(pane.style.display).toBe('');
    expect(pane.style.visibility).toBe('');
    view.rerender(<RetainedPane active>{content}</RetainedPane>);
    expect(view.container.querySelector('input')).toBe(input);
    expect(input.value).toBe('edited draft');
    expect(input.inert).not.toBe(true);
    expect(pane.style.clipPath).toBe('');
  });

  it('excludes controls arriving while hidden and restores pre-existing inert state', async () => {
    const view = render(<RetainedPane active><div /></RetainedPane>);
    const pane = view.container.firstElementChild as HTMLElement;
    const existing = document.createElement('button');
    existing.inert = true;
    pane.firstElementChild!.append(existing);
    view.rerender(<RetainedPane active={false}><div /></RetainedPane>);
    const late = document.createElement('a');
    late.href = '/';
    await act(async () => { pane.firstElementChild!.append(late); });
    expect(late.inert).toBe(true);
    view.rerender(<RetainedPane active><div /></RetainedPane>);
    expect(late.inert).not.toBe(true);
    expect(existing.inert).toBe(true);
  });
});
