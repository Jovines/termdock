// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mountRightSidebarRepoPickerOverlay } from './RightSidebar';

afterEach(() => cleanup());

describe('right sidebar repository picker overlay', () => {
  it('keeps the mobile bottom sheet inside the sidebar render tree', () => {
    const { container } = render(
      <>{mountRightSidebarRepoPickerOverlay(<div data-repo-picker />, true, document.body)}</>,
    );

    expect(container.querySelector('[data-repo-picker]')).toBeTruthy();
    expect(document.body.querySelector('[data-repo-picker]')?.parentElement).toBe(container);
  });

  it('keeps the desktop anchored picker portaled to the app viewport', () => {
    const { container } = render(
      <>{mountRightSidebarRepoPickerOverlay(<div data-repo-picker />, false, document.body)}</>,
    );

    expect(container.querySelector('[data-repo-picker]')).toBeNull();
    expect(document.body.querySelector('[data-repo-picker]')?.parentElement).toBe(document.body);
  });
});
