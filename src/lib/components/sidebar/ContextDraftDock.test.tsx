// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextDraftDock } from './ContextDraftDock';

const labels = {
  title: 'Context draft',
  hint: 'References are added here.',
  placeholder: 'Write a prompt',
  collapse: 'Collapse',
  expand: 'Expand',
  disable: 'Disable',
  clear: 'Clear',
  insert: 'Insert',
  insertAndSend: 'Insert & send',
  inserted: 'Inserted',
  sent: 'Sent',
  send: 'Send draft',
  appended: 'Reference added',
  resize: 'Drag to resize',
  autoCollapseAfterSend: 'Collapse after insert/send',
  characterCount: (count: number) => `${count} chars`,
};

function renderDock(value = 'Review this') {
  const handlers = {
    onChange: vi.fn(),
    onCollapsedChange: vi.fn(),
    onAutoCollapseAfterSendChange: vi.fn(),
    onDisable: vi.fn(),
    onClear: vi.fn(),
    onInsert: vi.fn(),
    onInsertAndSend: vi.fn(),
  };
  render(
    <ContextDraftDock
      value={value}
      collapsed={false}
      autoCollapseAfterSend={false}
      labels={labels}
      {...handlers}
    />,
  );
  return handlers;
}

describe('ContextDraftDock', () => {
  afterEach(cleanup);

  it('edits, inserts, and sends from the editing state', () => {
    const handlers = renderDock();
    const input = screen.getByPlaceholderText('Write a prompt');

    fireEvent.change(input, { target: { value: 'Updated prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert & send' }));

    expect(handlers.onChange).toHaveBeenCalledWith('Updated prompt');
    expect(handlers.onInsert).toHaveBeenCalledTimes(1);
    expect(handlers.onInsertAndSend).toHaveBeenCalledTimes(1);
    // 插入/发送不自行收起：父组件等终端 ack 成功才清空收起
    expect(handlers.onCollapsedChange).not.toHaveBeenCalled();
  });

  it('resting line expands on click and sends directly', () => {
    const handlers = {
      onChange: vi.fn(),
      onCollapsedChange: vi.fn(),
      onAutoCollapseAfterSendChange: vi.fn(),
      onDisable: vi.fn(),
      onClear: vi.fn(),
      onInsert: vi.fn(),
      onInsertAndSend: vi.fn(),
    };
    render(
      <ContextDraftDock
        value="Review this"
        collapsed={true}
        autoCollapseAfterSend={false}
        labels={labels}
        {...handlers}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(handlers.onCollapsedChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Send draft' }));
    expect(handlers.onInsertAndSend).toHaveBeenCalledTimes(1);
  });

  it('uses command/control-enter as the send shortcut', () => {
    const handlers = renderDock();

    fireEvent.keyDown(screen.getByPlaceholderText('Write a prompt'), {
      key: 'Enter',
      ctrlKey: true,
    });

    expect(handlers.onInsertAndSend).toHaveBeenCalledTimes(1);
  });

  it('never collapses on blur (continuous editing)', () => {
    const handlers = renderDock();
    const input = screen.getByPlaceholderText('Write a prompt');

    // 草稿坞主打持续编辑：失焦不收起，收起只靠显式操作（箭头/Esc/发送）。
    fireEvent.blur(input);

    expect(handlers.onCollapsedChange).not.toHaveBeenCalled();
  });

  it('moves the caret to the end after an external draft append', () => {
    const handlers = {
      onChange: vi.fn(),
      onCollapsedChange: vi.fn(),
      onAutoCollapseAfterSendChange: vi.fn(),
      onDisable: vi.fn(),
      onClear: vi.fn(),
      onInsert: vi.fn(),
      onInsertAndSend: vi.fn(),
    };
    const { rerender } = render(
      <ContextDraftDock
        value="Review this"
        collapsed={false}
        autoCollapseAfterSend={false}
        focusRequest={0}
        labels={labels}
        {...handlers}
      />,
    );
    const input = screen.getByPlaceholderText('Write a prompt') as HTMLTextAreaElement;
    input.setSelectionRange(0, 0);

    rerender(
      <ContextDraftDock
        value={'Review this\n\n/repo/src/App.tsx'}
        collapsed={false}
        autoCollapseAfterSend={false}
        focusRequest={1}
        labels={labels}
        {...handlers}
      />,
    );

    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('clears the draft without collapsing on touch', () => {
    const handlers = renderDock();
    const dock = document.querySelector('[data-context-draft-dock]')!;
    const input = screen.getByPlaceholderText('Write a prompt');

    fireEvent.pointerDown(dock);
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(handlers.onCollapsedChange).not.toHaveBeenCalled();
    expect(handlers.onClear).toHaveBeenCalledTimes(1);
  });

  it('lets the user toggle automatic collapse after send', () => {
    const handlers = renderDock();

    const toggle = screen.getByRole('switch', { name: 'Collapse after insert/send' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);
    expect(handlers.onAutoCollapseAfterSendChange).toHaveBeenCalledWith(true);
  });
});
