// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DragStart, DropResult } from '@hello-pangea/dnd';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { LeftSidebar, buildCollaborationSections } from './LeftSidebar';

const mocks = vi.hoisted(() => ({
  start: null as null | ((start: DragStart) => void),
  capture: null as null | (() => void),
  end: null as null | ((result: DropResult) => void),
  save: vi.fn(), remove: vi.fn(), list: vi.fn(),
}));
vi.mock('../../terminal/api', async (original) => ({
  ...await original<typeof import('../../terminal/api')>(),
  listCollaborationGroups: mocks.list,
  saveCollaborationGroup: mocks.save,
  removeCollaborationGroup: mocks.remove,
}));
// Simulate the drawer's stale post-drag click suppression. Independent DnD
// surfaces must bypass it so their controls remain clickable after a gesture.
vi.mock('@use-gesture/react', () => ({
  useDrag: () => () => ({ onClickCapture: (event: { stopPropagation(): void }) => event.stopPropagation() }),
}));
vi.mock('@hello-pangea/dnd', () => ({
  DragDropContext: ({ children, onBeforeCapture, onDragStart, onDragEnd }: any) => {
    mocks.capture = onBeforeCapture; mocks.start = onDragStart; mocks.end = onDragEnd; return children;
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
async function setup(groupByFolder = false, groupIds = baseGroup.sessionIds, sessionOrder = ['a', 'b', 'c', 'd'], pinned = true) {
  useSidebarStore.setState({ groupByFolder, collapsedGroups: new Set() });
  mocks.list.mockResolvedValue({ groups: [{ ...baseGroup, sessionIds: groupIds }] });
  const handlers = callbacks();
  render(<I18nProvider><LeftSidebar {...handlers} isOpen pinned={pinned} drawerWidthPx={300}
    sessions={sessionOrder.map((id) => ({ id, name: id.toUpperCase(), mode: 'shell' as const }))}
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
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: vi.fn(() => []) });
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
    fireEvent.click(screen.getByRole('button', { name: 'Remove from split A' }));
    expect(handlers.onRemoveFromSplit).toHaveBeenCalledWith('a');
  });
  it('keeps full-group splits compact with the layout control on the first member', async () => {
    await setup(false, ['a', 'b']);
    const inner = document.querySelector('[data-collaboration-split]')!;
    expect(inner.querySelector('[aria-haspopup="menu"]')).toBeTruthy();
    expect(screen.queryByText('Release team')).toBeNull();
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
  it.each([false, true])('moves a workgroup as one item without splitting it (folders=%s)', async (folders) => {
    const handlers = await setup(folders);
    const handle = screen.getByRole('button', { name: '移动工作组 Release team' });
    expect(handle.getAttribute('data-drag-id')).toBe('collaboration:team');
    expect(screen.getByRole('button', { name: '打开 Agent 工作组消息：Release team' }).hasAttribute('data-drag-id')).toBe(false);
    const start: DragStart = {
      draggableId: 'collaboration:team', type: 'session', mode: 'FLUID',
      source: { droppableId: folders ? 'group-sessions:' : 'sidebar-entities', index: 0 },
    };
    act(() => mocks.start!(start));
    act(() => mocks.end!({ ...start, reason: 'DROP', combine: null, destination: { ...start.source, index: 1 } }));
    expect(handlers.onReorderSessions).toHaveBeenCalledWith(['d', 'a', 'c', 'b']);
    expect(handlers.onCombineSplitSessions).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('keeps the original center drop target when sorting displaces its row', async () => {
    const handlers = await setup();
    const member = document.querySelector<HTMLElement>('[data-collaboration-member="a"]')!;
    vi.spyOn(member, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 38, 200, 24));
    act(() => mocks.capture!());
    const end = drag('c');
    point(document.querySelector('[data-collaboration-group]'));
    end();
    expect(handlers.onCombineSplitSessions).toHaveBeenCalledWith('a', 'c');
  });
  it('prefers the visible group landing area over a covered split row', async () => {
    const handlers = await setup();
    const member = document.querySelector<HTMLElement>('[data-collaboration-member="b"]')!;
    vi.spyOn(member, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 38, 200, 24));
    act(() => mocks.capture!());
    const end = drag('a');
    point(document.querySelector('[data-collaboration-background]'));
    end();
    expect(handlers.onRemoveFromSplit).toHaveBeenCalledWith('a');
    expect(handlers.onCombineSplitSessions).not.toHaveBeenCalled();
  });
  it('keeps the target group anchored when an earlier session joins it', async () => {
    const handlers = await setup(false, baseGroup.sessionIds, ['d', 'a', 'b', 'c']);
    const end = drag('d', 'session');
    point(document.querySelector('[data-collaboration-background]'));
    end();
    expect(handlers.onReorderSessions).toHaveBeenCalledWith(['a', 'b', 'c', 'd']);
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  });
  it('keeps an entry drop target when the destination group is displaced during sorting', async () => {
    const handlers = await setup(false, baseGroup.sessionIds, ['d', 'a', 'b', 'c']);
    const landingArea = document.querySelector<HTMLElement>('[data-collaboration-background]')!;
    vi.spyOn(landingArea, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 47, 200, 6));
    act(() => mocks.capture!());
    const end = drag('d', 'session');
    point(null);
    end({ destination: { droppableId: 'group-sessions:', index: 1 } });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: 'team', name: 'Release team', sessionIds: ['a', 'c', 'b', 'd'] }));
    expect(handlers.onReorderSessions).toHaveBeenCalledWith(['a', 'b', 'c', 'd']);
  });
  it('keeps layout buttons usable when the overlay drawer has stale drag suppression', async () => {
    const handlers = await setup(false, baseGroup.sessionIds, ['a', 'b', 'c', 'd'], false);
    fireEvent.click(screen.getByRole('button', { name: 'Split layout: Side by side' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Stacked' }));
    expect(handlers.onSetSplitLayout).toHaveBeenCalledWith('a', 'vertical');
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
