import { describe, expect, it } from 'vitest';
import { parseArchitectureLink } from './link';
import { architectureOverview } from './overview';
import { architectureDiagram, type ArchitectureDocument } from './model';
describe('native architecture links and composed overview', () => {
  it('accepts project viewer links without treating arbitrary files or malformed roots as architecture', () => {
    const search = (value: unknown) => `?architecture=${encodeURIComponent(JSON.stringify(value))}`;
    expect(parseArchitectureLink(search({ root: '/project with spaces', file: '.omm' }))).toEqual({ root: '/project with spaces', file: '.omm' });
    for (const value of [{ root: '/repo', file: '../secret' }, { root: 'https://evil', file: '.omm' }, { root: '/repo\0x', file: '.omm' }, { root: '/repo', file: 1 }]) expect(parseArchitectureLink(search(value))).toBeNull();
    expect(parseArchitectureLink('?architecture=invalid')).toBeNull();
  });
  it('keeps duplicate node IDs in different perspectives separate and maps clicks back to the actual documents', () => {
    const document: ArchitectureDocument = { version: 1, generatedAt: '2026-10-09T09:00:00Z', summary: '', perspectives: ['overall', 'security'].map(id => ({ id, title: id, summary: '', nodes: [{ id: 'server', title: 'Server', summary: '', files: [] }, { id: 'child', parentId: 'server', title: 'Child', summary: '', files: [] }], edges: [{ from: 'server', to: 'child', label: 'Contains' }] })) };
    const result = architectureOverview(document, 'All perspectives');
    expect(new Set(result.view.nodes.map(node => node.id)).size).toBe(6);
    expect(result.references.get('perspective1_node0')).toEqual({ perspective: 'security', node: 'server' });
    expect(architectureDiagram(result.view, undefined, 6).groups.size).toBe(4);
    expect(document.perspectives[0].nodes[0].id).toBe('server');
  });
});
