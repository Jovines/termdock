// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DragStart, DropResult } from '@hello-pangea/dnd';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { LeftSidebar, buildCollaborationSections } from './LeftSidebar';

const mocks = vi.hoisted(() => ({
  start: null as null | ((start: DragStart) => void),
  end: null as null | ((result: DropResult) => void),
  save: vi.fn(), remove: vi.fn(), list: vi.fn(),
}));
vi.mock('../../terminal/api', async (original) => ({
  ...await original<typeof import('../../terminal/api')>(),
  listCollaborationGroups: mocks.list,
  saveCollaborationGroup: mocks.save,
  removeCollaborationGroup: mocks.remove,
}));
vi.mock('@hello-pangea/dnd', () => ({
  DragDropContext: ({ children, onDragStart, onDragEnd }: any) => {
    mocks.start = onDragStart; mocks.end = onDragEnd; return children;
  },
  Droppable: ({ children }: any) => children({ innerRef: vi.fn(), droppableProps: {}, placeholder: null }, {}),
  Draggable: ({ children, draggableId }: any) => children({ innerRef: vi.fn(), draggableProps: {}, dragHandleProps: { 'data-drag-id': draggableId } }, {}),
}));
const workspace = { id: 'split-ab', sessionIds: ['a', 'b'], layout: 'horizontal' as const };
const baseGroup = { id: 'team', name: 'Release team', sessionIds: ['a', 'c', 'b'], createdAt: 1, updatedAt: 1 };
const callbacks = () => ({
  onClose: vi.fn(), onNewSession: vi.fn(), onCloseSession: vi.fn(), onSplitSession: vi.fn(),
  onCloseSplit: vi.fn(), onRemoveFromSplit: vi.fn(), onSetSplitLayout: vi.fn(),
  onReorderSplitWorkspace: vi.fn(), onRenameSplitWorkspace: vi.fn(), onCombineSplitSessions: vi.fn(),
  onReorderSessions: vi.fn(), onOpenSettings: vi.fn(),
});
async function setup(groupByFolder = false, groupIds = baseGroup.sessionIds) {
  useSidebarStore.setState({ groupByFolder, collapsedGroups: new Set() });
  mocks.list.mockResolvedValue({ groups: [{ ...baseGroup, sessionIds: groupIds }] });
  const handlers = callbacks();
  render(<I18nProvider><LeftSidebar {...handlers} isOpen pinned drawerWidthPx={300}
    sessions={['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase(), mode: 'shell' as const }))}
    activeSessionId="a" sessionStates={new Map()} splitWorkspaces={[workspace]} /></I18nProvider>);
  await screen.findByRole('region', { name: 'Agent 工作组：Release team' });
  return handlers;
}
function drag(id: string, type = 'collaboration-member') {
  const source = { droppableId: type === 'collaboration-member' ? 'collaboration-members:team' : 'group-sessions:', index: 0 };
  const start = { draggableId: `${type === 'session' ? 'session' : type}:${id}`, type, source, mode: 'FLUID' as const };
  act(() => mocks.start!(start));
  return (extra: Partial<DropResult> = {}) => act(() => mocks.end!({ ...start, destination: null, combine: null, reason: 'DROP', ...extra }));
}
function point(element: Element | null) {
  vi.stubGlobal('PointerEvent', MouseEvent);
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => element ? [element] : [] });
  fireEvent.pointerMove(window, { clientX: 50, clientY: 50 });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockResolvedValue({ group: baseGroup });
  mocks.remove.mockResolvedValue(undefined);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ locale: 'en', agents: [] }))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Agent workgroup split navigation', () => {
  it('groups contained splits in pane order and leaves cross-group splits as individual rows', () => {
    expect(buildCollaborationSections(['a', 'c', 'b'], [workspace])).toEqual([
      { sessionIds: ['a', 'b'], workspace }, { sessionIds: ['c'] },
    ]);
    expect(buildCollaborationSections(['a', 'c'], [workspace])).toEqual([
      { sessionIds: ['a'] }, { sessionIds: ['c'] },
    ]);
  });
  it('renders a contained split once with working layout and exit controls', async () => {
    const handlers = await setup();
    const inner = document.querySelector('[data-collaboration-split="split-ab"]')!;
    expect(Array.from(inner.querySelectorAll('[data-collaboration-member]')).map((e) => e.getAttribute('data-collaboration-member'))).toEqual(['a', 'b']);
    fireEvent.click(within(inner as HTMLElement).getByRole('button', { name: 'Split layout: Side by side' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Stacked' }));
    expect(handlers.onSetSplitLayout).toHaveBeenCalledWith('a', 'vertical');
    fireEvent.click(screen.getByRole('button', { name: 'Exit split Release team' }));
    expect(handlers.onCloseSplit).toHaveBeenCalledWith('a');
  });
  it('uses the workgroup header for a split containing every member', async () => {
    await setup(false, ['a', 'b']);
    const inner = document.querySelector('[data-collaboration-split]')!;
    expect(inner.querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Split layout: Side by side' })).toHaveLength(1);
  });
  it('combines members by drag without changing workgroup membership', async () => {
    const handlers = await setup();
    drag('c')({ combine: { draggableId: 'collaboration-member:a', droppableId: 'collaboration-members:team' } });
    expect(handlers.onCombineSplitSessions).toHaveBeenCalledWith('a', 'c');
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([false, true])('supports dragging an outside session into a group (folders=%s)', async (folders) => {
    const handlers = await setup(folders);
    const end = drag('d', 'session');
    point(document.querySelector('[data-collaboration-background]'));
    end();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: 'team', name: 'Release team', sessionIds: ['a', 'c', 'b', 'd'] }));
    expect(handlers.onCombineSplitSessions).not.toHaveBeenCalled();
  });
  it('supports dragging an outside session onto a member to join and split', async () => {
    const handlers = await setup(true);
    const end = drag('d', 'session');
    point(document.querySelector('[data-collaboration-member="a"]'));
    end();
    expect(handlers.onCombineSplitSessions).toHaveBeenCalledWith('a', 'd');
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  });
  it('moving to group background removes only the split membership', async () => {
    const handlers = await setup();
    const end = drag('a');
    point(document.querySelector('[data-collaboration-background]'));
    end();
    expect(handlers.onRemoveFromSplit).toHaveBeenCalledWith('a');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('cancel and unsupported drops preserve memberships', async () => {
    const handlers = await setup();
    const cancel = drag('a');
    point(document.querySelector('[data-collaboration-background]'));
    cancel({ reason: 'CANCEL' });
    const end = drag('a');
    point(null);
    end();
    expect(handlers.onRemoveFromSplit).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
