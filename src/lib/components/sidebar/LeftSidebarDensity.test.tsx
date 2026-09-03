// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { LeftSidebar, normalizeSidebarCollaborationGroups, reorderSessionIdsForSplitExit } from './LeftSidebar';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LeftSidebar session density', () => {
  it('assigns overlapping collaboration memberships to one visible group deterministically', () => {
    const base = { name: 'Group', createdAt: 1, updatedAt: 1 };
    expect(normalizeSidebarCollaborationGroups([
      { ...base, id: 'primary', sessionIds: ['one', 'two'] },
      { ...base, id: 'secondary', sessionIds: ['two', 'three', 'four', 'missing'] },
    ], new Set(['one', 'two', 'three', 'four']))).toEqual([
      { ...base, id: 'primary', sessionIds: ['one', 'two'] },
      { ...base, id: 'secondary', sessionIds: ['three', 'four'] },
    ]);
  });

  it('places a session exiting a split group at the requested visual boundary', () => {
    const entities = [
      { sessionIds: ['one'] },
      { sessionIds: ['two', 'three'] },
      { sessionIds: ['four'] },
    ];
    expect(reorderSessionIdsForSplitExit(entities, 'three', 0))
      .toEqual(['three', 'one', 'two', 'four']);
    expect(reorderSessionIdsForSplitExit(entities, 'three', 2))
      .toEqual(['one', 'two', 'three', 'four']);
    expect(reorderSessionIdsForSplitExit(entities, 'three', 3))
      .toEqual(['one', 'two', 'four', 'three']);
  });

  it('keeps repository metadata out of session rows and expands split groups by default', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ locale: 'en' }),
    })));
    const onRemoveFromSplit = vi.fn();
    const onSetSplitLayout = vi.fn();

    render(
      <I18nProvider>
        <LeftSidebar
          isOpen
          pinned
          drawerWidthPx={280}
          onClose={vi.fn()}
          sessions={[
            { id: 'one', name: 'Session 1', mode: 'shell' },
            { id: 'two', name: 'Session 2', mode: 'shell' },
            { id: 'three', name: 'Session 3', mode: 'shell' },
          ]}
          activeSessionId="one"
          sessionStates={new Map([
            ['one', {
              cwd: '/work/repository-name',
              activeProgram: null,
              agentStatus: null,
              shellTitle: 'repository-name',
              promptState: 'idle',
              gitStatus: { branch: 'feature-branch', added: 3, removed: 1 },
            }],
            ['two', {
              cwd: '/work/repository-name',
              activeProgram: 'codex',
              agentStatus: 'working',
              gitStatus: { branch: 'feature-branch', added: 3, removed: 1 },
            }],
          ])}
          onNewSession={vi.fn()}
          onCloseSession={vi.fn()}
          onSplitSession={vi.fn()}
          onCloseSplit={vi.fn()}
          onRemoveFromSplit={onRemoveFromSplit}
          splitWorkspaces={[{ id: 'split-one', sessionIds: ['one', 'two'], layout: 'horizontal' }]}
          onSetSplitLayout={onSetSplitLayout}
          onReorderSplitWorkspace={vi.fn()}
          onRenameSplitWorkspace={vi.fn()}
          onCombineSplitSessions={vi.fn()}
          onReorderSessions={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    );

    const splitGroup = document.querySelector<HTMLElement>('[data-split-workspace="split-one"]');
    expect(splitGroup).toBeTruthy();
    expect(within(splitGroup!).queryByText('repository-name')).toBeNull();
    expect(screen.queryByText('feature-branch')).toBeNull();
    expect(within(splitGroup!).queryByText('Split group 1')).toBeNull();
    expect(within(splitGroup!).getByText('Session 1')).toBeTruthy();
    expect(within(splitGroup!).getByText('codex')).toBeTruthy();
    expect(within(splitGroup!).getByText('Session 1').closest('button')?.className).toContain('sidebar-session-primary');
    expect(screen.getByText('Session 3').closest('button')?.className).toContain('sidebar-session-primary');
    expect(screen.getByRole('button', { name: 'Remove from split Session 1' }).className).toContain('sidebar-session-action');
    expect(splitGroup?.className).toContain('border-border/10');
    expect(splitGroup?.querySelector('[data-split-members]')?.className).not.toContain('border-t');
    expect(splitGroup?.querySelector('header')).toBeNull();
    expect(within(splitGroup!).queryByLabelText('More actions')).toBeNull();

    const groupedSessionButton = within(splitGroup!).getByText('Session 1').closest('button');
    const ordinarySessionButton = screen.getByText('Session 3').closest('button');
    expect(groupedSessionButton?.getAttribute('data-rfd-drag-handle-draggable-id')).toBe('split-member:one');
    expect(ordinarySessionButton?.getAttribute('data-rfd-drag-handle-draggable-id')).toBe('session:three');
    expect(groupedSessionButton?.getAttribute('draggable')).not.toBe('true');
    expect(onRemoveFromSplit).not.toHaveBeenCalled();

    const splitExitMarker = document.querySelector<HTMLElement>('[data-split-exit-drop-index]');
    expect(splitExitMarker?.className).toContain('absolute');
    expect(splitExitMarker?.parentElement?.hasAttribute('data-sidebar-entity-index')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Split layout: Side by side' }));
    expect(screen.getByRole('menu', { name: 'Split layout' })).toBeTruthy();
    expect(screen.queryByRole('menuitemradio', { name: 'Grid' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Stacked' }));
    expect(onSetSplitLayout).toHaveBeenCalledWith('one', 'vertical');
    expect(screen.queryByRole('menu', { name: 'Split layout' })).toBeNull();
  });

  it('renders an Agent workgroup as the primary card while preserving member split state', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input).includes('/collaboration-groups')
        ? {
            groups: [{
              id: 'agent-group',
              name: 'Release team',
              sessionIds: ['one', 'two'],
              createdAt: 1,
              updatedAt: 2,
            }],
            sessions: [],
          }
        : { locale: 'en' },
    })));
    const onRemoveFromSplit = vi.fn();
    const onSplitSession = vi.fn();

    render(
      <I18nProvider>
        <LeftSidebar
          isOpen
          pinned
          drawerWidthPx={280}
          onClose={vi.fn()}
          sessions={[
            { id: 'one', name: 'Planner', mode: 'shell' },
            { id: 'two', name: 'Reviewer', mode: 'shell' },
            { id: 'three', name: 'Standalone', mode: 'shell' },
          ]}
          activeSessionId="one"
          sessionStates={new Map()}
          onNewSession={vi.fn()}
          onCloseSession={vi.fn()}
          onSplitSession={onSplitSession}
          onCloseSplit={vi.fn()}
          onRemoveFromSplit={onRemoveFromSplit}
          splitWorkspaces={[{ id: 'split-one', sessionIds: ['one', 'two'], layout: 'horizontal' }]}
          onSetSplitLayout={vi.fn()}
          onReorderSplitWorkspace={vi.fn()}
          onRenameSplitWorkspace={vi.fn()}
          onCombineSplitSessions={vi.fn()}
          onReorderSessions={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    );

    const workgroup = await screen.findByRole('region', { name: 'Agent 工作组：Release team' });
    expect(workgroup.querySelectorAll('[data-collaboration-member]')).toHaveLength(2);
    expect(workgroup.querySelectorAll('[data-split-member="true"]')).toHaveLength(2);
    expect(workgroup.querySelector('[data-split-workspace]')).toBeNull();
    expect(screen.getByLabelText('移动 Agent 工作组：Release team')).toBeTruthy();

    fireEvent.click(within(workgroup).getByRole('button', { name: 'Remove from split Planner' }));
    expect(onRemoveFromSplit).toHaveBeenCalledWith('one');
    fireEvent.click(screen.getByRole('button', { name: 'Split Standalone' }));
    expect(onSplitSession).toHaveBeenCalledWith('three');
    await waitFor(() => expect(document.querySelectorAll('[data-collaboration-group]')).toHaveLength(1));
  });
});
