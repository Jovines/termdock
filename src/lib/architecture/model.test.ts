import { describe, expect, it } from 'vitest';
import { analysisFile, ARCHITECTURE_FILE, DEFAULT_ANALYSIS, architectureFilePath, isArchitectureFile, normalizeAnalysis, architectureDiagram, architectureScope, buildArchitecturePrompt, parseArchitecture, type ArchitectureDocument } from './model';

const sample = (): ArchitectureDocument => ({
  version: 1, generatedAt: '2026-10-09T09:00:00Z', summary: 'A terminal application',
  perspectives: [{ id: 'overview', title: 'Architecture', summary: 'Modules',
    nodes: [
      { id: 'ui', title: 'UI', summary: 'Interface', files: [{ path: 'src/App.tsx', line: 20 }] },
      { id: 'server', title: 'Server', summary: 'Backend', files: [] },
      { id: 'routes', parentId: 'server', title: 'Routes', summary: 'API', files: [] },
      { id: 'pty', parentId: 'server', title: 'PTY', summary: 'Processes', files: [] },
    ], edges: [{ from: 'ui', to: 'routes', label: 'Requests' }, { from: 'routes', to: 'pty', label: 'Input' }] }],
});
const parse = (doc: unknown) => parseArchitecture(JSON.stringify(doc));

describe('Termdock architecture documents', () => {
  it('keeps analyzed sources and limitations separate from the architecture summary', () => {
    const details = { analyzedPaths: ['src/App.tsx', 'src/server'], limitations: ['Static analysis; native client not exercised'] };
    expect(parse({ ...sample(), details }).details).toEqual(details);
    expect(() => parse({ ...sample(), details: { ...details, analyzedPaths: ['../secret'] } })).toThrow();
    const prompt = buildArchitecturePrompt('/project', 'en');
    expect(prompt).toContain('details.analyzedPaths');
    expect(prompt).toContain('Group implementation steps under their parent responsibility');
    expect(prompt).toContain('Do not put file lists');
  });
  it('saves scopes independently with stable paths, regardless of input order or dependency depth', () => {
    const module = { ...DEFAULT_ANALYSIS, kind: 'module' as const, paths: ['packages/auth', 'src/server', 'src/server'] };
    const file = analysisFile(module);
    expect(file).toMatch(/^\.termdock\/architectures\/module-/);
    expect(isArchitectureFile(file)).toBe(true);
    expect(analysisFile({ ...module, paths: ['src/server', 'packages/auth'], depth: 'dependencies', focus: 'Errors' })).toBe(file);
    expect(analysisFile({ ...module, paths: ['src/client'] })).not.toBe(file);
    expect(analysisFile({ ...DEFAULT_ANALYSIS, kind: 'feature', target: '文件上传完整流程' })).not.toBe(file);
    expect(analysisFile(DEFAULT_ANALYSIS)).toBe(ARCHITECTURE_FILE);
    expect(architectureFilePath('/project/', file)).toBe(`/project/${file}`);
  });
  it.each(['.termdock/architectures/../secret.json', '.termdock/architectures/feature-foo-12345678.json/extra', '/tmp/map.json', '.termdock/architectures/feature-foo-12345678.json?query', '.termdock/architectures/unrelated.json'])('rejects unsafe or unrelated output path %s', file => {
    expect(isArchitectureFile(file)).toBe(false);
    expect(() => architectureFilePath('/project', file)).toThrow();
  });
  it('stores scope metadata while continuing to accept existing project maps', () => {
    const scope = normalizeAnalysis({ ...DEFAULT_ANALYSIS, kind: 'module', paths: ['src/server'] });
    expect(parse({ ...sample(), analysis: scope }).analysis).toEqual(scope);
    expect(parse(sample()).analysis).toBeUndefined();
    expect(() => parse({ ...sample(), analysis: { ...scope, paths: ['../secret'] } })).toThrow();
    expect(() => normalizeAnalysis({ ...DEFAULT_ANALYSIS, kind: 'feature', target: ' ' })).toThrow();
  });
  it('limits module and feature analysis to their scope and updates only the chosen map', () => {
    const scope = { ...DEFAULT_ANALYSIS, kind: 'module' as const, paths: ['src/server'] };
    const prompt = buildArchitecturePrompt('/project', 'en', scope);
    expect(prompt).toContain('Analyze ONLY the specified module paths');
    expect(prompt).toContain('stop at the boundary');
    expect(prompt).toContain('leave all other saved maps unchanged');
    expect(prompt).toContain(analysisFile(scope));
    expect(prompt).toContain('do not overwrite an existing map');
    const feature = buildArchitecturePrompt('/project', 'zh', { ...DEFAULT_ANALYSIS, kind: 'feature', target: '文件上传', paths: ['src/upload.ts'], depth: 'dependencies' });
    expect(feature).toContain('Analyze ONLY the requested feature');
    expect(feature).toContain('follow only dependencies and callers directly needed');
    expect(feature).toContain('文件上传');
    expect(() => buildArchitecturePrompt('/project', 'en', scope, ARCHITECTURE_FILE)).toThrow();
  });
  it('keeps nested modules and verified source line references', () => {
    expect(parse(sample())).toEqual(sample());
  });
  it.each(['../secret', '/etc/passwd', 'https://example.com', 'src/../../secret', 'src\\secret', 'src/./App.tsx', 'src//App.tsx'])('rejects unsafe source reference %s', path => {
    const doc = sample(); doc.perspectives[0].nodes[0].files[0].path = path;
    expect(() => parse(doc)).toThrow();
  });
  it.each(['cycle', 'missing-parent', 'duplicate-node', 'missing-edge', 'line-zero', 'duplicate-view', 'version', 'date', 'too-many-nodes'])('rejects malformed topology or metadata: %s', mode => {
    const doc = sample(), view = doc.perspectives[0];
    switch (mode) {
      case 'cycle': view.nodes[1].parentId = 'routes'; break;
      case 'missing-parent': view.nodes[1].parentId = 'absent'; break;
      case 'duplicate-node': view.nodes.push(view.nodes[0]); break;
      case 'missing-edge': view.edges[0].to = 'absent'; break;
      case 'line-zero': view.nodes[0].files[0].line = 0; break;
      case 'duplicate-view': doc.perspectives.push(view); break;
      case 'version': Object.assign(doc, { version: 2 }); break;
      case 'date': doc.generatedAt = 'yesterday'; break;
      case 'too-many-nodes': view.nodes = Array.from({ length: 201 }, (_, index) => ({ ...view.nodes[0], id: `node${index}` }));
    }
    expect(() => parse(doc)).toThrow();
  });
  it('projects descendant connections onto their visible parent and preserves internal connections when expanding', () => {
    const view = sample().perspectives[0];
    expect(architectureScope(view).edges).toEqual([{ from: 'ui', to: 'server', label: 'Requests' }]);
    expect(architectureScope(view, 'server').edges).toEqual([{ from: 'routes', to: 'pty', label: 'Input' }]);
    expect(architectureScope(view, 'server').nodes.map(node => node.id)).toEqual(['routes', 'pty']);
  });
  it('does not accept diagram syntax from node IDs or display labels', () => {
    const view = sample().perspectives[0];
    view.nodes[0].title = 'UI"]\nclick n0 "https://evil"\n["';
    view.edges[0].label = '|"\nclick n1 call alert\n"|';
    const { code, nodes } = architectureDiagram(view);
    expect(code.split('\n')).toHaveLength(8);
    expect(code).not.toMatch(/^click /m);
    expect(nodes.map(node => node.id)).toEqual(['ui', 'server']);
  });
  it('prepares analysis of the literal workspace with the native output contract and atomic writing', () => {
    const root = '/repo with spaces/$(touch /tmp/unwanted)';
    const prompt = buildArchitecturePrompt(root, 'zh');
    expect(prompt).toContain(JSON.stringify(root));
    expect(prompt).toContain('.termdock/architecture.json');
    expect(prompt).toContain('Chinese');
    expect(prompt).toContain('write atomically');
    expect(prompt).not.toContain('npm install');
    expect(prompt).not.toContain('oh-my-mermaid');
  });
});
