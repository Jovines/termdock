// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReferenceLongPressCopy } from './referenceLongPress';

function ReferenceButton({ onCopied }: { onCopied: (key: string) => void }) {
  const getHandlers = useReferenceLongPressCopy(onCopied);
  return (
    <>
      <button type="button" {...getHandlers('/workspace/file.ts', 'file-key')}>Reference</button>
      {getHandlers.popoverNode}
    </>
  );
}

function pointerDown(
  element: Element,
  pointerType: 'mouse' | 'touch',
  pointerId: number,
): void {
  const event = new Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
    button: { value: 0 },
    clientX: { value: 40 },
    clientY: { value: 40 },
  });
  fireEvent(element, event);
}

describe('reference long press copy', () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.useFakeTimers();
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('copies immediately after a mouse long press without showing the copy popover', async () => {
    const onCopied = vi.fn();
    render(<ReferenceButton onCopied={onCopied} />);

    pointerDown(screen.getByRole('button', { name: 'Reference' }), 'mouse', 1);
    await vi.advanceTimersByTimeAsync(450);

    expect(writeText).toHaveBeenCalledWith('/workspace/file.ts');
    expect(onCopied).toHaveBeenCalledWith('file-key');
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('keeps the confirmation popover for touch long presses', async () => {
    const onCopied = vi.fn();
    render(<ReferenceButton onCopied={onCopied} />);

    pointerDown(screen.getByRole('button', { name: 'Reference' }), 'touch', 2);
    await vi.advanceTimersByTimeAsync(450);

    expect(writeText).not.toHaveBeenCalled();
    expect(onCopied).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
});
