import { createPortal } from 'react-dom';
// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { collaborationPanelClientId } from '../collaboration/panelPreferences';
import { FreeSplitLayout } from './FreeSplitLayout';
import { useCollaborationPanelDock } from '../stores/useCollaborationPanelDock';
const api = vi.hoisted(() => ({ getSettings: vi.fn().mockResolvedValue({}), updateSettings: vi.fn().mockResolvedValue({}) }));
vi.mock('../terminal/api', () => api);
afterEach(() => { cleanup(); useCollaborationPanelDock.setState({ docks: {}, hosts: {}, activePaneId: null }); vi.clearAllMocks(); });
it('renders four independent controls and resizes without remounting terminal contents', async () => {
  const mounts = vi.fn(), unmounts = vi.fn();
  function Terminal({ id }: { id: string }) { useEffect(() => { mounts(id); return () => { unmounts(id); }; }, [id]); return <button data-split-pane-title={id}>{id}</button>; }
  const { container } = render(<FreeSplitLayout layoutId="four" panes={['a', 'b', 'c', 'd'].map(id => ({ id, content: <Terminal id={id} /> }))} />);
  await waitFor(() => expect((screen.getByRole('separator', { name: '调整上半段分隔线' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getAllByRole('separator')).toHaveLength(4);
  fireEvent.keyDown(screen.getByRole('separator', { name: '调整上半段分隔线' }), { key: 'ArrowLeft' });
  const a = container.querySelector<HTMLElement>('[data-layout-pane="a"]')!;
  const c = container.querySelector<HTMLElement>('[data-layout-pane="c"]')!;
  expect(a.style.width).toBe('47%'); expect(c.style.width).toBe('50%');
  fireEvent.keyDown(screen.getByRole('separator', { name: '调整左半段分隔线' }), { key: 'ArrowDown' });
  expect(screen.getAllByRole('separator')).toHaveLength(4);
  expect(mounts).toHaveBeenCalledTimes(4); expect(unmounts).not.toHaveBeenCalled();
  await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
});
it('adds collaboration as a fourth leaf and collapses its space on returning to floating', async () => {
  render(<FreeSplitLayout layoutId="group" panes={['a', 'b', 'c'].map(id => ({ id, content: <div>{id}</div> }))} />);
  await act(async () => {});
  act(() => useCollaborationPanelDock.getState().setDock('group', { sessionId: 'c', side: 'right' }));
  await waitFor(() => expect(screen.getAllByRole('separator')).toHaveLength(4));
  expect(useCollaborationPanelDock.getState().hosts.group).toBeTruthy();
  act(() => useCollaborationPanelDock.getState().setDock('group', null));
  await waitFor(() => expect(screen.getAllByRole('separator')).toHaveLength(2));
  expect(useCollaborationPanelDock.getState().hosts.group).toBeUndefined();
});
it('drags a leaf into the upper row and cancels an outside drop without losing panes', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  const view = render(<FreeSplitLayout layoutId="drag" panes={['a', 'b', 'c', 'd'].map(id => ({ id, content: <button data-split-pane-title={id}>{id}</button> }))} />);
  await waitFor(() => expect((screen.getByRole('separator', { name: '调整上半段分隔线' }) as HTMLButtonElement).disabled).toBe(false));
  const container = view.container.querySelector<HTMLElement>('[data-split-container]')!;
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, toJSON() {} });
  fireEvent.pointerDown(screen.getByRole('button', { name: 'c' }), { button: 0, clientX: 100, clientY: 420 });
  fireEvent.pointerMove(container, { clientX: 20, clientY: 180 });
  const draggedPane = view.container.querySelector<HTMLElement>('[data-layout-pane="c"]')!;
  expect(draggedPane.style.transform).toContain('translate(-80px, -240px)');
  expect(view.container.querySelector('[data-drag-placeholder]')).not.toBeNull();
  expect(screen.queryByText('松手放到左侧')).toBeNull();
  fireEvent.pointerUp(container, { clientX: 20, clientY: 180 });
  const pane = (id: string) => view.container.querySelector<HTMLElement>(`[data-layout-pane="${id}"]`)!;
  expect(['a', 'b', 'c'].every(id => pane(id).style.top === '0%')).toBe(true);
  expect(pane('d').style.width).toBe('100%');
  expect(pane('c').style.transform).toBe('');
  expect(view.container.querySelector('[data-drag-placeholder]')).toBeNull();
  const before = [pane('a').style.left, pane('a').style.top, pane('a').style.width, pane('a').style.height];
  fireEvent.pointerDown(screen.getByRole('button', { name: 'a' }), { button: 0, clientX: 260, clientY: 20 });
  fireEvent.pointerMove(container, { clientX: 550, clientY: 650 });
  fireEvent.pointerMove(container, { clientX: -10, clientY: -10 });
  fireEvent.pointerUp(container, { clientX: -10, clientY: -10 });
  expect([pane('a').style.left, pane('a').style.top, pane('a').style.width, pane('a').style.height]).toEqual(before);
  expect(view.container.querySelectorAll('[data-layout-pane]')).toHaveLength(4);
  vi.unstubAllGlobals();
});

it('restores a moved collaboration leaf before the sidebar has mounted its composer', async () => {
  api.getSettings.mockResolvedValueOnce({ collaborationPanels: { [collaborationPanelClientId()]: {
    floatingGroupId: 'group', mode: 'docked', dock: { sessionId: 'c', side: 'right' }, layouts: { restored: {
      axis: 'y', ratio: 0.35,
      first: { axis: 'x', ratio: 0.5, first: { id: 'a' }, second: { axis: 'x', ratio: 0.5, first: { id: 'b' }, second: { id: 'c' } } },
      second: { id: '@collaboration' },
    } },
  } } });
  const view = render(<FreeSplitLayout layoutId="restored" panes={['a', 'b', 'c'].map(id => ({ id, content: <div>{id}</div> }))} />);
  await waitFor(() => expect(useCollaborationPanelDock.getState().hosts.group).toBeTruthy());
  const panel = view.container.querySelector<HTMLElement>('[data-layout-pane="@collaboration:group"]')!;
  expect(panel.style.top).toBe('35%'); expect(panel.style.width).toBe('100%');
});

it('keeps multiple groups in independent dock leaves and removes only the closed group', async () => {
  const view = render(<FreeSplitLayout layoutId="multi" panes={['a', 'b'].map(id => ({ id, content: <div>{id}</div> }))} />);
  await act(async () => {});
  act(() => {
    useCollaborationPanelDock.getState().setDock('alpha', { sessionId: 'a', side: 'right' });
    useCollaborationPanelDock.getState().setDock('beta', { sessionId: 'b', side: 'bottom' });
  });
  await waitFor(() => expect(Object.keys(useCollaborationPanelDock.getState().hosts)).toHaveLength(2));
  const beta = useCollaborationPanelDock.getState().hosts.beta;
  expect(beta).not.toBe(useCollaborationPanelDock.getState().hosts.alpha);
  expect(view.container.querySelectorAll('[data-layout-pane]')).toHaveLength(4);
  act(() => useCollaborationPanelDock.getState().setDock('alpha', null));
  await waitFor(() => expect(view.container.querySelectorAll('[data-layout-pane]')).toHaveLength(3));
  expect(useCollaborationPanelDock.getState().hosts.beta).toBe(beta);
  expect(useCollaborationPanelDock.getState().hosts.alpha).toBeUndefined();
});

it('selects portal panes, releases old text focus and restores the terminal when docking closes', async () => {
  function Composer() {
    const host = useCollaborationPanelDock(state => state.hosts.focus);
    return host ? createPortal(<textarea aria-label="panel draft" />, host) : null;
  }
  const view = render(<><FreeSplitLayout layoutId="focus" panes={[{ id: 'terminal', content: <textarea aria-label="terminal input" /> }]} /><Composer /></>);
  await act(async () => {});
  act(() => useCollaborationPanelDock.getState().setDock('focus', { sessionId: 'terminal', side: 'right' }));
  const composer = await screen.findByRole('textbox', { name: 'panel draft' });
  const terminal = screen.getByRole('textbox', { name: 'terminal input' });
  act(() => terminal.focus());
  expect(useCollaborationPanelDock.getState().activePaneId).toBe('terminal');
  fireEvent.pointerDown(composer);
  expect(document.activeElement).not.toBe(terminal);
  expect(useCollaborationPanelDock.getState().activePaneId).toBe('@collaboration:focus');
  expect(view.container.querySelector('[data-pane-active="true"]')?.getAttribute('data-layout-pane')).toBe('@collaboration:focus');
  act(() => useCollaborationPanelDock.getState().setDock('focus', null));
  expect(useCollaborationPanelDock.getState().activePaneId).toBe('terminal');
});
