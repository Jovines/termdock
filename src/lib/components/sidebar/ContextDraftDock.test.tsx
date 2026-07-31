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
  characterCount: (count: number) => `${count} chars`,
};

function renderDock(value = 'Review this') {
  const handlers = {
    onChange: vi.fn(),
    onCollapsedChange: vi.fn(),
    onDisable: vi.fn(),
    onClear: vi.fn(),
    onInsert: vi.fn(),
    onInsertAndSend: vi.fn(),
  };
  render(
    <ContextDraftDock
      value={value}
      collapsed={false}
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
    // 插入/发送后收回静息行
    expect(handlers.onCollapsedChange).toHaveBeenCalledWith(true);
  });

  it('resting line expands on click and sends directly', () => {
    const handlers = {
      onChange: vi.fn(),
      onCollapsedChange: vi.fn(),
      onDisable: vi.fn(),
      onClear: vi.fn(),
      onInsert: vi.fn(),
      onInsertAndSend: vi.fn(),
    };
    render(
      <ContextDraftDock
        value="Review this"
        collapsed={true}
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
});
