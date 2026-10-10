// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchitectureDocumentEditor } from './ArchitectureDocumentEditor';
const { read, write } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../../architecture/native', () => ({ readNativeArchitecture: read, writeArchitectureField: write }));
const document = { version: 1, generatedAt: '2026-10-09T09:00:00Z', summary: 'Architecture', perspectives: [{ id: 'overall', title: 'Overall', summary: 'Structure', nodes: [{ id: 'server', title: 'Server', summary: 'Summary', description: '# Server\n\nOriginal.', files: [] }], edges: [] }] };
beforeEach(() => { read.mockReset(); write.mockReset(); read.mockResolvedValue({ document, revision: 'first-revision' }); });
afterEach(() => cleanup());
describe('document editing under concurrent architecture updates', () => {
  it('saves against its loaded revision and keeps the draft visible when another agent has updated the document', async () => {
    const onSaved = vi.fn(), onCancel = vi.fn(); write.mockRejectedValue(new Error('Architecture changed; reload before saving'));
    render(<ArchitectureDocumentEditor root="/project" file=".termdock/architecture.json" perspective="overall" node="server" initialField="description" onSaved={onSaved} onCancel={onCancel} />);
    const input = await screen.findByRole('textbox', { name: 'Description' });
    await act(async () => {});
    fireEvent.change(input, { target: { value: 'My draft' } });
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Architecture changed; reload before saving');
    expect((input as HTMLTextAreaElement).value).toBe('My draft');
    expect(write).toHaveBeenCalledWith('/project', '.termdock/architecture.json', 'overall', 'server', 'description', 'My draft', 'first-revision');
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(onCancel).toHaveBeenCalledOnce();
  });
  it('uses stable module IDs for editable diagram sources and aborts its initial request when closed', async () => {
    const component = render(<ArchitectureDocumentEditor root="/project" file=".termdock/architecture.json" perspective="overall" initialField="diagram" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await act(async () => {});
    expect((screen.getByRole('textbox', { name: 'Diagram source' }) as HTMLTextAreaElement).value).toContain('server["Server"]');
    const signal = read.mock.calls[0][2] as AbortSignal; component.unmount(); expect(signal.aborted).toBe(true);
  });
});
