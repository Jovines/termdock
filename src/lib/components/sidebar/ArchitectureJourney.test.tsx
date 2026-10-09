// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchitecturePanel } from './ArchitecturePanel';
import type { ArchitectureDocument } from '../../architecture/model';
const { read, list, renderSvg } = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn(), renderSvg: vi.fn() }));
vi.mock('../../architecture/api', () => ({ readArchitecture: read, listArchitectures: list }));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: renderSvg } }));
vi.mock('../../terminal/api', () => ({ saveDownloadBlob: vi.fn() }));
const map: ArchitectureDocument = {
  version: 1, generatedAt: '2026-10-09T09:00:00Z', summary: 'A project',
  perspectives: [{ id: 'overview', title: 'Overview', summary: 'Responsibilities', nodes: [
    { id: 'server', title: 'Server', summary: 'Backend', files: [{ path: 'src/server.ts', line: 12 }] },
    { id: 'ui', title: 'UI', summary: 'Frontend', files: [] },
    { id: 'routes', title: 'Routes', parentId: 'server', summary: 'Dispatch', files: [] },
  ], edges: [{ from: 'ui', to: 'server', label: 'Requests' }] }, {
    id: 'data', title: 'Data flow', summary: 'Inputs', nodes: [{ id: 'input', title: 'Input', summary: 'Input', files: [] }], edges: [],
  }],
};
const getBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');
beforeEach(() => {
  sessionStorage.clear(); read.mockReset(); list.mockReset(); renderSvg.mockReset();
  read.mockResolvedValue(map); list.mockResolvedValue([]);
  renderSvg.mockImplementation(async (id: string, code: string) => ({ svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 1600"><g>${[...code.matchAll(/^n(\d+)\["([^"]+)"\]/gm)].map(([, index, title]) => `<g class="node" id="${id}-flowchart-n${index}-0"><rect width="180" height="60"/><text>${title}</text></g>`).join('')}</g></svg>` }));
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 2000, height: 1600 }) });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  if (getBBox) Object.defineProperty(SVGElement.prototype, 'getBBox', getBBox);
  else delete (SVGElement.prototype as { getBBox?: unknown }).getBBox;
});
const setup = async () => {
  const onOpenFile = vi.fn(), onInsertPrompt = vi.fn().mockResolvedValue(true);
  const view = render(<ArchitecturePanel rootPath="/project" active onOpenFile={onOpenFile} onInsertPrompt={onInsertPrompt} renderSource={file => <div data-architecture-source>Source {file.path}:{file.line}</div>} />);
  await screen.findByRole('button', { name: 'Server' });
  fireEvent.click(screen.getByRole('button', { name: 'Relationship diagram' }));
  await screen.findByRole('button', { name: 'Server' });
  fireEvent.click(screen.getByRole('button', { name: 'Open fullscreen diagram' }));
  const dialog = screen.getByRole('dialog', { name: 'Architecture diagram' });
  return { ...view, dialog, onOpenFile, onInsertPrompt };
};
describe('architecture reading journey', () => {
  it('starts with a compact phone preview and expands details only on request, with one reading layer per Escape', async () => {
    vi.stubGlobal('innerWidth', 402);
    const { dialog } = await setup();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Server' }));
    expect(within(dialog).getByRole('region', { name: 'Server' }).textContent).toContain('Backend');
    expect(within(dialog).queryByRole('button', { name: 'src/server.ts:12' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Read module details' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'src/server.ts:12' }));
    expect(within(dialog).getByText('Source src/server.ts:12')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(dialog).getByRole('button', { name: 'Collapse module details' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Collapse module details' }));
    expect(within(dialog).getByRole('button', { name: 'Read module details' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Read module details' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(dialog).getByRole('button', { name: 'Read module details' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog.querySelector('[data-architecture-inspector]')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Architecture diagram' })).toBe(dialog);
  });
  it('keeps fullscreen, zoom and pan through node, relation and source reading, and dismisses one layer per Escape', async () => {
    const { dialog, onOpenFile } = await setup();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in diagram' }));
    const viewport = dialog.querySelector<HTMLElement>('.termdock-architecture-viewport')!;
    viewport.scrollLeft = 240; viewport.scrollTop = 130;
    const zoom = within(dialog).getByRole('button', { name: 'Reset diagram zoom' }).textContent;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Server' }));
    expect(screen.getByRole('dialog', { name: 'Architecture diagram' })).toBe(dialog);
    expect(viewport.scrollLeft).toBe(240); expect(viewport.scrollTop).toBe(130);
    expect(within(dialog).getByRole('button', { name: 'UI' }).dataset.architectureRelated).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'From: UI · Requests' }));
    expect(within(dialog).getByRole('region', { name: 'UI' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Previous module' }));
    const body = dialog.querySelector<HTMLElement>('[data-architecture-inspector] > div')!;
    body.scrollTop = 72; fireEvent.scroll(body);
    fireEvent.click(within(dialog).getByRole('button', { name: 'src/server.ts:12' }));
    expect(within(dialog).getByText('Source src/server.ts:12')).toBeTruthy();
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true });
    expect(within(dialog).getByText('Source src/server.ts:12')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(dialog).queryByText('Source src/server.ts:12')).toBeNull();
    expect(within(dialog).getByRole('region', { name: 'Server' })).toBeTruthy();
    expect(body.scrollTop).toBe(72);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog.querySelector('[data-architecture-inspector]')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Reset diagram zoom' }).textContent).toBe(zoom);
    expect(viewport.scrollLeft).toBe(240); expect(viewport.scrollTop).toBe(130);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('explores submodules and switches perspectives while remaining fullscreen', async () => {
    const { dialog } = await setup();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Server' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Explore submodules' }));
    await within(dialog).findByRole('button', { name: 'Routes' });
    expect(screen.getByRole('dialog', { name: 'Architecture diagram' })).toBe(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back to parent' }));
    await within(dialog).findByRole('button', { name: 'Server' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Perspective' }), { target: { value: 'data' } });
    await within(dialog).findByRole('button', { name: 'Input' });
    expect(screen.getByRole('dialog', { name: 'Architecture diagram' })).toBe(dialog);
    expect(within(dialog).queryByRole('button', { name: 'Back to parent' })).toBeNull();
  });
  it('prepares a scoped analysis without replacing the current map and cancels back to its module', async () => {
    const { dialog, onInsertPrompt } = await setup();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Server' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Analyze this module in detail' }));
    expect((within(dialog).getByRole('textbox', { name: 'Module paths (one per line)' }) as HTMLTextAreaElement).value).toBe('src/server.ts');
    const form = within(dialog).getByRole('button', { name: 'Insert prompt' }).closest('form')!;
    within(dialog).getByRole('button', { name: 'Close fullscreen diagram' }).focus();
    expect(form.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', isComposing: true });
    expect(within(dialog).getByRole('button', { name: 'Insert prompt' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert prompt' }));
    await waitFor(() => expect(onInsertPrompt).toHaveBeenCalledOnce());
    expect((screen.getByRole('combobox', { name: 'Saved analyses' }) as HTMLSelectElement).value).toBe('.termdock/architecture.json');
    expect(await within(dialog).findByRole('button', { name: 'View this analysis' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(dialog).getByRole('region', { name: 'Server' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Architecture diagram' })).toBe(dialog);
  });
});
