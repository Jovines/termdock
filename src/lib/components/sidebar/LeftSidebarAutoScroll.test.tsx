// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { LeftSidebar } from './LeftSidebar';

let rowTop = 700;
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 280, width: 280, x: 0, y: top, toJSON() {} });
const props: ComponentProps<typeof LeftSidebar> = {
  isOpen: true, pinned: true, drawerWidthPx: 280,
  sessions: [{ id: 'one', name: 'Current session', mode: 'shell' }],
  activeSessionId: 'one', sessionStates: new Map(), splitWorkspaces: [],
  onClose: vi.fn(), onNewSession: vi.fn(), onCloseSession: vi.fn(),
  onSplitSession: vi.fn(), onCloseSplit: vi.fn(), onRemoveFromSplit: vi.fn(),
  onSetSplitLayout: vi.fn(), onReorderSplitWorkspace: vi.fn(), onRenameSplitWorkspace: vi.fn(),
  onCombineSplitSessions: vi.fn(), onReorderSessions: vi.fn(), onOpenSettings: vi.fn(),
};
const view = (overrides: Partial<typeof props> = {}) => (
  <I18nProvider><LeftSidebar {...props} {...overrides} /></I18nProvider>
);
const list = () => document.querySelector('.sidebar-session-primary')!.closest('.overflow-y-auto') as HTMLElement;

beforeEach(() => {
  rowTop = 700;
  useSidebarStore.setState({ groupByFolder: false, collapsedGroups: new Set() });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ locale: 'en', groups: [], agents: [] }) })));
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('overflow-y-auto') ? 400 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('sidebar-session-primary')) {
      const container = this.closest('.overflow-y-auto') as HTMLElement;
      return rect(100 + rowTop - (container?.scrollTop ?? 0), 36);
    }
    return rect(100, 400);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('active sidebar session visibility', () => {
  it('reveals the full row and follows late layout changes with unchanged session ID/count', () => {
    const { rerender } = render(view());
    expect(list().scrollTop).toBe(344);
    rowTop = 1000;
    rerender(view({ sessionStates: new Map([['one', { cwd: '/late/group', activeProgram: null, agentStatus: null }]]) }));
    expect(list().scrollTop).toBe(644);
    rowTop = 200;
    rerender(view());
    expect(list().scrollTop).toBe(192);
  });

  it('preserves manual scroll during status updates, then reveals the row on reopen', () => {
    const { rerender } = render(view());
    list().scrollTop = 0;
    rerender(view({ sessionStates: new Map([['one', { cwd: null, activeProgram: 'codex', agentStatus: 'working' }]]) }));
    expect(list().scrollTop).toBe(0);
    rerender(view({ isOpen: false }));
    rerender(view());
    expect(list().scrollTop).toBe(344);
  });

  it('waits for the selected session to arrive and does not move a visible row', () => {
    const { rerender } = render(view({ sessions: [] }));
    rowTop = 200;
    rerender(view());
    expect(list().scrollTop).toBe(0);
    rowTop = 700;
    rerender(view());
    expect(list().scrollTop).toBe(344);
  });
});
