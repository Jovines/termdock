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

  it('edits, inserts, and sends without hiding the dock', () => {
    const handlers = renderDock();
    const input = screen.getByPlaceholderText('Write a prompt');

    fireEvent.change(input, { target: { value: 'Updated prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert & send' }));

    expect(handlers.onChange).toHaveBeenCalledWith('Updated prompt');
    expect(handlers.onInsert).toHaveBeenCalledTimes(1);
    expect(handlers.onInsertAndSend).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText('Write a prompt')).toBeTruthy();
  });

  it('uses command/control-enter as the send shortcut', () => {
    const handlers = renderDock();

    fireEvent.keyDown(screen.getByPlaceholderText('Write a prompt'), {
      key: 'Enter',
      ctrlKey: true,
    });

    expect(handlers.onInsertAndSend).toHaveBeenCalledTimes(1);
  });
});
