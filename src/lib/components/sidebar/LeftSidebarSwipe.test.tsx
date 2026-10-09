// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { LeftSidebar } from './LeftSidebar';

class TestPointerEvent extends MouseEvent {
  pointerId = 1;
  pointerType = 'touch';
  isPrimary = true;
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ locale: 'en', groups: [], agents: [] }) })));
  useSidebarStore.setState({ groupByFolder: false, collapsedGroups: new Set() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('skips confirmation for swipe actions, preserves normal close behavior, and resets on drawer close', () => {
  const onCloseSession = vi.fn();
  const onRemoveFromSplit = vi.fn();
  const props: ComponentProps<typeof LeftSidebar> = {
    isOpen: true, pinned: true, drawerWidthPx: 280,
    sessions: [
      { id: 'one', name: 'One', mode: 'shell' },
      { id: 'two', name: 'Two', mode: 'shell' },
      { id: 'three', name: 'Three', mode: 'shell' },
    ],
    activeSessionId: 'one', sessionStates: new Map(),
    splitWorkspaces: [{ id: 'split-one', sessionIds: ['one', 'two'], layout: 'horizontal' }],
    onClose: vi.fn(), onNewSession: vi.fn(), onCloseSession,
    onSplitSession: vi.fn(), onCloseSplit: vi.fn(), onRemoveFromSplit,
    onSetSplitLayout: vi.fn(), onReorderSplitWorkspace: vi.fn(), onRenameSplitWorkspace: vi.fn(),
    onCombineSplitSessions: vi.fn(), onReorderSessions: vi.fn(), onOpenSettings: vi.fn(),
  };
  const view = (isOpen = true) => <I18nProvider><LeftSidebar {...props} isOpen={isOpen} /></I18nProvider>;
  const { rerender } = render(view());
  function reveal(name: string) {
    const primary = screen.getByRole('button', { name });
    fireEvent.pointerDown(primary, { clientX: 80, clientY: 100 });
    fireEvent.pointerMove(primary, { clientX: 140, clientY: 100 });
    fireEvent.pointerUp(primary, { clientX: 140, clientY: 100 });
    fireEvent.click(primary);
    const swipe = primary.closest('[data-session-swipe]')!;
    return within(swipe as HTMLElement).getAllByRole('button', { name: `Close ${name}` })[0];
  }
  fireEvent.click(reveal('Three'));
  expect(onCloseSession).toHaveBeenLastCalledWith('three', expect.objectContaining({ type: 'click' }), { skipConfirmation: true });
  fireEvent.click(reveal('One'));
  expect(onCloseSession).toHaveBeenLastCalledWith('one', expect.objectContaining({ type: 'click' }), { skipConfirmation: true });
  expect(onRemoveFromSplit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close Three' }));
  expect(onCloseSession).toHaveBeenLastCalledWith('three', expect.objectContaining({ type: 'click' }));
  reveal('Two');
  rerender(view(false));
  rerender(view());
  expect(screen.getAllByRole('button', { name: 'Close Two' })).toHaveLength(1);
});
