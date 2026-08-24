// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FloatingAnnotationButton, getFloatingAnnotationButtonStyle } from './FloatingAnnotationButton';

afterEach(cleanup);

describe('FloatingAnnotationButton', () => {
  it('opens diagonally inward from the pointer in every viewport quadrant', () => {
    expect(getFloatingAnnotationButtonStyle({ xPercent: 20, yPercent: 30 })).toEqual({
      left: 'calc(20% + 8px)',
      top: 'calc(30% + 8px)',
    });
    expect(getFloatingAnnotationButtonStyle({ xPercent: 80, yPercent: 70 })).toEqual({
      right: 'calc(20% + 8px)',
      bottom: 'calc(30% + 8px)',
    });
  });

  it('is a panel-local floating action and does not bubble into the preview picker', () => {
    const onParentClick = vi.fn();
    const onClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <FloatingAnnotationButton anchor={{ xPercent: 25, yPercent: 40 }} onClick={onClick}>引用标注</FloatingAnnotationButton>
      </div>,
    );

    const button = screen.getByRole('button', { name: '引用标注' });
    expect(button.classList.contains('absolute')).toBe(true);
    expect(button.style.left).toBe('calc(25% + 8px)');
    expect(button.style.top).toBe('calc(40% + 8px)');
    expect(button.classList.contains('h-7')).toBe(true);
    expect(button.classList.contains('z-30')).toBe(true);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
