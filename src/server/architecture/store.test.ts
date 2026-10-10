import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArchitectureConflict, ArchitectureStore } from './store';
import { architectureDiagram, architectureSourceDiagram, type ArchitectureDocument } from './document';
import { updateArchitectureField } from './fieldMutation';
import { runArchitectureCli } from './cli';

const sample = (): ArchitectureDocument => ({ version: 1, generatedAt: '2026-10-09T09:00:00Z', summary: 'Application', perspectives: [
  { id: 'overall', title: 'Overall', summary: 'Structure', description: '# Overview\n\nApplication responsibilities.', nodes: [
    { id: 'server', title: 'Server', summary: 'Backend', files: [], description: '# Server\n\nAPI and worker.', constraint: 'Keep requests encrypted.' },
    { id: 'api', title: 'API', parentId: 'server', summary: 'Endpoints', files: [], context: 'Request handling' },
    { id: 'auth', title: 'Auth', parentId: 'api', summary: 'Access check', files: [], todo: '- [ ] Audit' },
    { id: 'ui', title: 'UI', summary: 'Frontend', files: [], references: [{ perspective: 'security' }] },
  ], edges: [{ from: 'ui', to: 'api', label: 'Requests' }, { from: 'api', to: 'auth', label: 'Checks' }] },
  { id: 'security', title: 'Security', summary: 'Encryption', nodes: [{ id: 'encryption', title: 'Encryption', summary: 'AEAD', files: [], note: 'Protect inputs.' }], edges: [] },
] });
let root: string, store: ArchitectureStore;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'termdock-architecture-test-')); store = new ArchitectureStore(root); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe('architecture persistence and upstream interchange', () => {
  it('saves rich recursive documents, retains semantic history and rejects concurrent stale edits', async () => {
    const first = await store.save('.termdock/architecture.json', sample(), null);
    const updated = updateArchitectureField(first.document!, 'overall', 'server', 'description', '# Server\n\nChanged description.');
    const results = await Promise.allSettled([store.save('.termdock/architecture.json', updated, first.revision), store.save('.termdock/architecture.json', updateArchitectureField(first.document!, 'overall', 'server', 'description', 'Another edit'), first.revision)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(ArchitectureConflict);
    const second = await store.read();
    expect(second.document!.meta!.updateCount).toBe(2);
    expect(second.document!.perspectives[0].nodes.find(node => node.id === 'auth')!.meta!.updateCount).toBe(1);
    const history = await store.history('.termdock/architecture.json');
    expect(history).toHaveLength(1);
    expect(history[0].changes).toEqual(expect.arrayContaining([expect.objectContaining({ node: 'server', fields: expect.arrayContaining(['description']) })]));
    expect((await store.historical('.termdock/architecture.json', history[0].id)).perspectives[0].nodes[0].description).toContain('API and worker');
  });
  it('does not create revisions, change update counts or rewrite fields for unchanged content', async () => {
    const first = await store.save('.termdock/architecture.json', sample());
    expect(await store.save('.termdock/architecture.json', sample(), first.revision)).toEqual(first);
    expect(await store.history('.termdock/architecture.json')).toEqual([]);
    await store.writeOmmField('overall', 'description', 'Description');
    const before = await store.read('.omm');
    expect(await store.writeOmmField('overall', 'description', 'Description', before.revision)).toEqual(before);
    expect(await store.history('.omm')).toEqual([]);
  });
  it('round trips three levels, all documentation fields and cross-perspective references through actual .omm directories', async () => {
    const bundle = await store.exportOmmBundle(sample());
    expect(bundle.files['overall/server/api/auth/todo.md']).toBe('- [ ] Audit');
    await store.importOmmBundle(bundle, null);
    const loaded = await store.read('.omm');
    expect(loaded.document!.origin).toBe('omm');
    expect(loaded.document!.perspectives).toHaveLength(2);
    const view = loaded.document!.perspectives[0], server = view.nodes.find(node => node.title === 'Server')!, api = view.nodes.find(node => node.title === 'API')!, auth = view.nodes.find(node => node.title === 'Auth')!;
    expect(api.parentId).toBe(server.id); expect(auth.parentId).toBe(api.id);
    expect(server.constraint).toBe('Keep requests encrypted.');
    expect(view.nodes.find(node => node.references?.length)!.references).toEqual([{ perspective: 'security' }]);
    const diagram = architectureDiagram(view, undefined, 6);
    expect(diagram.groups.has(server.id)).toBe(true); expect(diagram.code).toContain('subgraph');
    const next = await store.writeOmmField('overall/server', 'note', 'Kept after updates.', loaded.revision);
    expect(next.revision).not.toBe(loaded.revision);
    expect((await store.readOmmFields('overall/server')).meta!.updateCount).toBe(1);
    await expect(store.writeOmmField('overall/server', 'note', 'stale', loaded.revision)).rejects.toBeInstanceOf(ArchitectureConflict);
  });
  it('validates every import destination and merged topology before changing existing documents', async () => {
    const bundle = await store.exportOmmBundle(sample()); await store.importOmmBundle(bundle);
    const before = await store.exportOmmBundle();
    await expect(store.importOmmBundle({ ...bundle, files: { 'overall/description.md': 'changed', '../escape.md': 'outside' } })).rejects.toThrow('Unsafe');
    const many = Array.from({ length: 201 }, (_, index) => `node${index}["Node"]`).join('\n');
    await expect(store.importOmmBundle({ ...bundle, files: { 'overall/description.md': 'changed', 'overall/diagram.mmd': `graph LR\n${many}` } })).rejects.toThrow('limit');
    expect(await store.exportOmmBundle()).toEqual(before);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'termdock-outside-test-'));
    try { await fs.symlink(outside, path.join(root, '.omm', 'escape')); await expect(store.writeOmmField('escape', 'note', 'secret')).rejects.toThrow('symlink'); expect(await fs.readdir(outside)).toEqual([]); } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
  it('edits diagrams without losing retained descendant documents and rejects deleting referenced nodes', () => {
    const document = sample(), diagram = architectureSourceDiagram(document.perspectives[0]);
    const edited = updateArchitectureField(document, 'overall', undefined, 'diagram', `${diagram}\nnewnode["New module"]\nui -->|"Calls"| newnode`);
    expect(edited.perspectives[0].nodes.find(node => node.id === 'auth')!.todo).toBe('- [ ] Audit');
    expect(edited.perspectives[0].nodes.find(node => node.id === 'newnode')!.title).toBe('New module');
    expect(() => updateArchitectureField(document, 'overall', 'server', 'diagram', 'graph LR\nui["Wrong level"]')).toThrow('another level');
  });
  it('supports real CLI writes, readable .omm tree paths, fields, references, diff, history and setup teardown', async () => {
    const output: string[] = [];
    const io = { write: (value: string) => output.push(value), stdin: async () => JSON.stringify(sample()) };
    const run = (...args: string[]) => runArchitectureCli([...args, '--project', root], io);
    expect(await run('save', '-')).toBe(0);
    expect(await run('export', '--format', 'omm', '--file', '.termdock/architecture.json')).toBe(0);
    await store.importOmmBundle(JSON.parse(output.at(-1)!));
    expect(await run('read', 'overall/server/api/auth', 'todo', '--format', 'omm')).toBe(0); expect(output.at(-1)).toBe('- [ ] Audit');
    expect(await run('tree', '--format', 'omm')).toBe(0); expect(output.join('\n')).toContain('    api');
    expect(await run('write', 'overall/server', 'context', 'Updated', '--format', 'omm')).toBe(0);
    expect(await run('show', 'overall/server', '--format', 'omm')).toBe(0); expect(JSON.parse(output.at(-1)!).context).toBe('Updated');
    expect(await run('refs', 'overall', '--format', 'omm')).toBe(0);
    expect(await run('diff', 'overall/server', '--format', 'omm')).toBe(0);
    expect(await run('history', '--format', 'omm')).toBe(0); expect(JSON.parse(output.at(-1)!)).toHaveLength(1);
    expect(await run('setup', 'codex')).toBe(0);
    expect(await fs.readFile(path.join(root, '.agents/skills/termdock-architecture/SKILL.md'), 'utf8')).toContain('inspect the actual code for EVERY node');
    expect(await run('setup', 'codex', '--teardown')).toBe(0);
    await expect(fs.stat(path.join(root, '.agents/skills/termdock-architecture/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
