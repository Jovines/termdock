// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import type { ArchitecturePerspective } from '../../architecture/model';
const { renderSvg, save } = vi.hoisted(() => ({ renderSvg: vi.fn(), save: vi.fn() }));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: renderSvg } }));
vi.mock('../../terminal/api', () => ({ saveDownloadBlob: save }));
const view: ArchitecturePerspective = { id: 'overview', title: 'Overview', summary: '',
  nodes: [{ id: 'server', title: 'Server', summary: '', files: [] }], edges: [] };
const getBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');
beforeEach(() => {
  renderSvg.mockReset(); save.mockReset(); save.mockResolvedValue(undefined);
  renderSvg.mockImplementation(async (id: string) => ({ svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 50 60"><script>alert(1)</script><g><g class="node" id="${id}-flowchart-n0-0"><rect x="10" y="20" width="200" height="120"/><text>Server</text></g></g></svg>` }));
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 10, y: 20, width: 200, height: 120 }) });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  if (getBBox) Object.defineProperty(SVGElement.prototype, 'getBBox', getBBox);
  else delete (SVGElement.prototype as { getBBox?: unknown }).getBBox;
});
describe('interactive architecture SVG', () => {
  it('keeps an ordinary graph selection inside its reduced canvas without shrinking the chosen zoom', async () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { callbacks.push(callback); } observe() {} disconnect() {} });
    const component = render(<ArchitectureDiagram view={view} selectedId={null} onSelect={vi.fn()} referenceWidth={1200} />);
    const node = await screen.findByRole('button', { name: 'Server' });
    const viewport = component.container.querySelector<HTMLElement>('.termdock-architecture-viewport')!;
    let width = 1100;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, get: () => width });
    viewport.getBoundingClientRect = () => new DOMRect(0, 200, width, 416);
    node.getBoundingClientRect = () => new DOMRect(900 - viewport.scrollLeft, 300, 200, 60);
    const zoom = screen.getByRole('button', { name: 'Reset diagram zoom' }).textContent;
    width = 648;
    component.rerender(<ArchitectureDiagram view={view} selectedId="server" onSelect={vi.fn()} referenceWidth={1200} />);
    expect(viewport.scrollLeft).toBe(464);
    expect(node.getBoundingClientRect().right).toBe(636);
    expect(screen.getByRole('button', { name: 'Reset diagram zoom' }).textContent).toBe(zoom);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('moves an obstructed selection into the remaining canvas without changing zoom, including after expanding details', async () => {
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 2000, height: 1800 }) });
    const component = render(<ArchitectureDiagram view={view} selectedId={null} onSelect={vi.fn()} inspectorStage="preview" />);
    await screen.findByRole('button', { name: 'Server' });
    fireEvent.click(screen.getByRole('button', { name: 'Open fullscreen diagram' }));
    const dialog = screen.getByRole('dialog');
    const viewport = dialog.querySelector<HTMLElement>('.termdock-architecture-viewport')!;
    const node = screen.getByRole('button', { name: 'Server' });
    let height = 729;
    viewport.getBoundingClientRect = () => new DOMRect(0, 53, 402, height);
    node.getBoundingClientRect = () => new DOMRect(99, 789 - viewport.scrollTop, 204, 47);
    const zoom = screen.getByRole('button', { name: 'Reset diagram zoom' }).textContent;
    component.rerender(<ArchitectureDiagram view={view} selectedId="server" onSelect={vi.fn()} inspectorStage="preview" inspector={<div>Preview</div>} />);
    expect(viewport.scrollTop).toBe(66);
    expect(viewport.scrollLeft).toBe(0);
    height = 437;
    component.rerender(<ArchitectureDiagram view={view} selectedId="server" onSelect={vi.fn()} inspectorStage="details" inspector={<div>Details</div>} />);
    expect(viewport.scrollTop).toBe(358);
    expect(node.getBoundingClientRect().bottom).toBe(viewport.getBoundingClientRect().bottom - 12);
    expect(screen.getByRole('button', { name: 'Reset diagram zoom' }).textContent).toBe(zoom);
    expect(screen.getByRole('dialog')).toBe(dialog);
  });
  it('keeps a dense graph readable initially and offers an explicit overview fit', async () => {
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 2200, height: 1800 }) });
    const component = render(<ArchitectureDiagram view={view} selectedId={null} onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: 'Server' });
    const canvas = component.container.querySelector<HTMLElement>('.termdock-architecture-diagram')!;
    expect(parseFloat(canvas.style.width)).toBeGreaterThanOrEqual(2232);
    fireEvent.click(screen.getByRole('button', { name: 'Fit entire diagram' }));
    expect(parseFloat(canvas.style.width)).toBeLessThanOrEqual(320);
    fireEvent.click(screen.getByRole('button', { name: 'Reset diagram zoom' }));
    expect(parseFloat(canvas.style.width)).toBeGreaterThanOrEqual(2232);
  });
  it('opens a fullscreen modal, contains keyboard focus, and restores focus and scroll on Escape', async () => {
    render(<ArchitectureDiagram view={view} selectedId={null} onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: 'Server' });
    const expand = screen.getByRole('button', { name: 'Open fullscreen diagram' });
    expand.focus(); fireEvent.click(expand);
    expect(screen.getByRole('dialog', { name: 'Architecture diagram' })).toBeTruthy();
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    screen.getByRole('button', { name: 'Server' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Zoom out diagram' }));
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Server' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open fullscreen diagram' })));
    expect(document.body.style.overflow).toBe('');
  });
  it('closes fullscreen when the architecture panel is hidden', async () => {
    const component = render(<ArchitectureDiagram view={view} selectedId={null} onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: 'Server' });
    fireEvent.click(screen.getByRole('button', { name: 'Open fullscreen diagram' }));
    component.rerender(<ArchitectureDiagram view={view} selectedId={null} onSelect={vi.fn()} active={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });
  it('pans and pinches without selecting a node, then handles a captured tap only once', async () => {
    const select = vi.fn();
    const component = render(<ArchitectureDiagram view={view} selectedId={null} onSelect={select} />);
    const node = await screen.findByRole('button', { name: 'Server' });
    const viewport = component.container.querySelector<HTMLElement>('.termdock-architecture-viewport')!;
    const canvas = component.container.querySelector<HTMLElement>('.termdock-architecture-diagram')!;
    const pointer = (target: Element, type: string, id: number, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, 'pointerId', { value: id }); fireEvent(target, event);
    };
    pointer(node, 'pointerdown', 1, 100, 100);
    pointer(viewport, 'pointermove', 1, 40, 50);
    pointer(viewport, 'pointerup', 1, 40, 50);
    fireEvent.click(node);
    expect(viewport.scrollLeft).toBe(60); expect(viewport.scrollTop).toBe(50);
    expect(select).not.toHaveBeenCalled();
    const width = parseFloat(canvas.style.width);
    pointer(viewport, 'pointerdown', 1, 100, 100);
    pointer(viewport, 'pointerdown', 2, 200, 100);
    pointer(viewport, 'pointermove', 2, 250, 100);
    pointer(viewport, 'pointerup', 1, 100, 100); pointer(viewport, 'pointerup', 2, 250, 100);
    expect(parseFloat(canvas.style.width)).toBeGreaterThan(width);
    expect(select).not.toHaveBeenCalled();
    pointer(node, 'pointerdown', 3, 100, 100); pointer(viewport, 'pointerup', 3, 100, 100);
    fireEvent.click(node);
    expect(select).toHaveBeenCalledExactlyOnceWith('server');
  });
  it('fits translated content before display, strips scripts, and preserves selection after zoom', async () => {
    const select = vi.fn();
    const component = render(<ArchitectureDiagram view={view} selectedId={null} onSelect={select} />);
    const node = await screen.findByRole('button', { name: 'Server' });
    expect(component.container.querySelector('.termdock-architecture-diagram svg')?.getAttribute('viewBox')).toBe('-6 4 232 152');
    expect(component.container.querySelector('script')).toBeNull();
    expect(component.container.querySelector('text')?.textContent).toBe('Server');
    fireEvent.click(node);
    expect(select).toHaveBeenLastCalledWith('server');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in diagram' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Server' }), { key: 'Enter' });
    expect(select).toHaveBeenCalledTimes(2);
    component.rerender(<ArchitectureDiagram view={view} selectedId="server" onSelect={select} />);
    expect(screen.getByRole('button', { name: 'Server' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('exports the fitted SVG and reports failed downloads', async () => {
    save.mockRejectedValueOnce(new Error('Save failed'));
    render(<ArchitectureDiagram view={view} selectedId={null} onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: 'Server' });
    fireEvent.click(screen.getByRole('button', { name: 'Download architecture SVG' }));
    await screen.findByRole('alert');
    expect(save).toHaveBeenCalledWith(expect.any(Blob), 'architecture-overview.svg');
  });
  it('leaves module browsing available when Mermaid cannot render', async () => {
    renderSvg.mockRejectedValue(new Error('Invalid diagram'));
    render(<ArchitectureDiagram view={view} selectedId={null} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('explore the modules below'));
  });
});
