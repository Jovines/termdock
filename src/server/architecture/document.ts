/** Termdock's portable, agent-independent architecture document. */
export const ARCHITECTURE_FILE = '.termdock/architecture.json';
export const ARCHITECTURE_DIRECTORY = '.termdock/architectures';
export interface ArchitectureAnalysis {
  kind: 'project' | 'module' | 'feature';
  target: string;
  paths: string[];
  depth: 'boundary' | 'dependencies';
  focus: string;
}
export const DEFAULT_ANALYSIS: ArchitectureAnalysis = { kind: 'project', target: '', paths: [], depth: 'boundary', focus: '' };
export interface ArchitectureFile { path: string; line?: number }
export const ARCHITECTURE_FIELDS = ['description', 'diagram', 'context', 'constraint', 'concern', 'todo', 'note'] as const;
export type ArchitectureField = typeof ARCHITECTURE_FIELDS[number];
export interface ArchitectureFields { description?: string; diagram?: string; context?: string; constraint?: string; concern?: string; todo?: string; note?: string }
export interface ArchitectureMeta { created?: string; updated?: string; updateCount?: number; gitCommit?: string; gitBranch?: string; previousDiagram?: string }
export interface ArchitectureReference { perspective: string; node?: string }
export interface ArchitectureNode extends ArchitectureFields {
  id: string;
  title: string;
  summary: string;
  parentId?: string;
  documentPath?: string;
  files: ArchitectureFile[];
  meta?: ArchitectureMeta;
  references?: ArchitectureReference[];
  role?: 'external' | 'concern' | 'entry' | 'store';
}
export interface ArchitectureEdge { from: string; to: string; label: string }
export interface ArchitecturePerspective extends ArchitectureFields {
  id: string;
  title: string;
  summary: string;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  meta?: ArchitectureMeta;
}
export interface ArchitectureDocument {
  version: 1;
  generatedAt: string;
  summary: string;
  perspectives: ArchitecturePerspective[];
  analysis?: ArchitectureAnalysis;
  details?: { analyzedPaths: string[]; limitations: string[] };
  origin?: 'termdock' | 'omm';
  meta?: ArchitectureMeta;
}

const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
export class ArchitectureFormatError extends Error {}
function invalid(): never { throw new ArchitectureFormatError('Invalid architecture document'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, limit = 8000): string {
  if (typeof value !== 'string' || value.length > limit) invalid();
  return value;
}
function id(value: unknown): string {
  const result = string(value, 80);
  if (!ID.test(result)) invalid();
  return result;
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) invalid();
  return value;
}
function fields(value: Record<string, unknown>): ArchitectureFields {
  return Object.fromEntries(ARCHITECTURE_FIELDS.filter(key => value[key] !== undefined).map(key => [key, string(value[key], 100_000)]));
}
function meta(value: unknown): ArchitectureMeta | undefined {
  if (value === undefined) return undefined;
  const raw = object(value), result: ArchitectureMeta = {};
  for (const key of ['created', 'updated', 'gitCommit', 'gitBranch', 'previousDiagram'] as const) {
    if (raw[key] !== undefined) result[key] = string(raw[key], key === 'previousDiagram' ? 100_000 : 200);
  }
  if (raw.updateCount !== undefined) {
    if (!Number.isSafeInteger(raw.updateCount) || (raw.updateCount as number) < 0) invalid();
    result.updateCount = raw.updateCount as number;
  }
  return result;
}
export function isArchitectureSourcePath(path: string): boolean {
  return !!path && !/[:\\\x00-\x1f]/.test(path) && !path.startsWith('/')
    && path.split('/').every(part => !!part && part !== '.' && part !== '..');
}
export function normalizeAnalysis(value: ArchitectureAnalysis): ArchitectureAnalysis {
  if (!['project', 'module', 'feature'].includes(value.kind)
    || !['boundary', 'dependencies'].includes(value.depth)) invalid();
  const paths = value.kind === 'project' ? [] : [...new Set(array(value.paths, 20).map(value => string(value, 1024).trim()))].sort();
  if (paths.some(path => !isArchitectureSourcePath(path))) invalid();
  const target = string(value.target, 1000).trim();
  const focus = string(value.focus, 2000).trim();
  if ((value.kind === 'module' && !paths.length) || (value.kind === 'feature' && !target)) invalid();
  return { kind: value.kind, target: value.kind === 'project' ? '' : value.kind === 'module' ? paths.join('\n') : target,
    paths: value.kind === 'project' ? [] : paths, depth: value.depth, focus };
}
export function analysisFile(analysis: ArchitectureAnalysis): string {
  const scope = normalizeAnalysis(analysis);
  if (scope.kind === 'project') return ARCHITECTURE_FILE;
  // A stable scope identity keeps updates in one file without a shared manifest.
  const identity = JSON.stringify([scope.kind, scope.target, scope.paths]);
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
  const label = Array.from(scope.target.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')).slice(0, 48).join('') || 'analysis';
  return `${ARCHITECTURE_DIRECTORY}/${scope.kind}-${label}-${(hash >>> 0).toString(16).padStart(8, '0')}.json`;
}
export function isArchitectureFile(file: string): boolean {
  return file === '.omm' || file === ARCHITECTURE_FILE || new RegExp(`^${ARCHITECTURE_DIRECTORY.replace('.', '\\.')}\/(?:module|feature)-[\\p{L}\\p{N}_-]{1,48}-[a-f0-9]{8}\\.json$`, 'u').test(file);
}
export function architectureFileLabel(file: string): string {
  return file.split('/').pop()?.replace(/^(module|feature)-/, '').replace(/-[a-f0-9]{8}\.json$/, '').replace(/-/g, ' ') ?? file;
}
export function architectureFilePath(root: string, file = ARCHITECTURE_FILE): string {
  if (!isArchitectureFile(file)) invalid();
  return `${root.replace(/\/+$/, '')}/${file}`;
}
export function parseArchitecture(content: string): ArchitectureDocument {
  if (new TextEncoder().encode(content).byteLength > 5_000_000) invalid();
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { invalid(); }
  const doc = object(raw);
  if (doc.version !== 1) invalid();
  const generatedAt = string(doc.generatedAt, 80);
  if (!Number.isFinite(Date.parse(generatedAt))) invalid();
  const perspectives = array(doc.perspectives, 12).map(value => {
    const view = object(value);
    const nodes = array(view.nodes, 200).map(value => {
      const node = object(value);
      const files = array(node.files, 40).map(value => {
        const file = object(value);
        const path = string(file.path, 1024);
        if (!isArchitectureSourcePath(path)) invalid();
        if (file.line !== undefined && (!Number.isSafeInteger(file.line) || (file.line as number) < 1)) invalid();
        return { path, ...(file.line !== undefined ? { line: file.line as number } : {}) };
      });
      const references = node.references === undefined ? undefined : array(node.references, 100).map(value => {
        const ref = object(value);
        return { perspective: id(ref.perspective), ...(ref.node !== undefined ? { node: id(ref.node) } : {}) };
      });
      if (node.documentPath !== undefined && !isArchitectureSourcePath(string(node.documentPath, 1024))) invalid();
      if (node.role !== undefined && !['external', 'concern', 'entry', 'store'].includes(node.role as string)) invalid();
      return { id: id(node.id), title: string(node.title, 160), summary: string(node.summary), files, ...fields(node),
        ...(node.parentId !== undefined ? { parentId: id(node.parentId) } : {}),
        ...(node.documentPath !== undefined ? { documentPath: string(node.documentPath, 1024) } : {}), ...(meta(node.meta) ? { meta: meta(node.meta) } : {}),
        ...(references ? { references } : {}), ...(node.role !== undefined ? { role: node.role as ArchitectureNode['role'] } : {}) };
    });
    if (!nodes.length) invalid();
    const nodeMap = new Map(nodes.map(node => [node.id, node]));
    if (nodeMap.size !== nodes.length) invalid();
    for (const node of nodes) {
      const visited = new Set([node.id]);
      let parent = node.parentId;
      while (parent) {
        if (visited.has(parent) || !nodeMap.has(parent)) invalid();
        visited.add(parent);
        parent = nodeMap.get(parent)?.parentId;
      }
    }
    const edges = array(view.edges, 600).map(value => {
      const edge = object(value);
      const from = id(edge.from), to = id(edge.to);
      if (!nodeMap.has(from) || !nodeMap.has(to)) invalid();
      return { from, to, label: string(edge.label, 200) };
    });
    return { id: id(view.id), title: string(view.title, 160), summary: string(view.summary), nodes, edges, ...fields(view), ...(meta(view.meta) ? { meta: meta(view.meta) } : {}) };
  });
  if (!perspectives.length || new Set(perspectives.map(view => view.id)).size !== perspectives.length) invalid();
  for (const view of perspectives) for (const node of view.nodes) for (const ref of node.references ?? []) {
    const target = perspectives.find(view => view.id === ref.perspective);
    if (!target || (ref.node && !target.nodes.some(node => node.id === ref.node))) invalid();
  }
  const analysis = doc.analysis === undefined ? undefined : normalizeAnalysis(object(doc.analysis) as unknown as ArchitectureAnalysis);
  let details: ArchitectureDocument['details'];
  if (doc.details !== undefined) {
    const rawDetails = object(doc.details);
    const analyzedPaths = array(rawDetails.analyzedPaths, 200).map(value => {
      const path = string(value, 1024);
      if (!isArchitectureSourcePath(path)) invalid();
      return path;
    });
    const limitations = array(rawDetails.limitations, 30).map(value => string(value, 2000));
    details = { analyzedPaths, limitations };
  }
  if (doc.origin !== undefined && !['termdock', 'omm'].includes(doc.origin as string)) invalid();
  return { version: 1, generatedAt, summary: string(doc.summary), perspectives, ...(analysis ? { analysis } : {}), ...(details ? { details } : {}),
    ...(doc.origin ? { origin: doc.origin as ArchitectureDocument['origin'] } : {}), ...(meta(doc.meta) ? { meta: meta(doc.meta) } : {}) };
}

/** Fold descendant connections onto the immediate children at this depth. */
export function architectureScope(view: ArchitecturePerspective, parentId?: string) {
  const nodes = view.nodes.filter(node => node.parentId === parentId);
  const byId = new Map(view.nodes.map(node => [node.id, node]));
  const visible = new Set(nodes.map(node => node.id));
  const ancestor = (id: string): string | undefined => {
    let node = byId.get(id);
    while (node && !visible.has(node.id)) node = node.parentId ? byId.get(node.parentId) : undefined;
    return node?.id;
  };
  const edges = new Map<string, ArchitectureEdge>();
  for (const edge of view.edges) {
    const from = ancestor(edge.from), to = ancestor(edge.to);
    if (from && to && from !== to && !edges.has(`${from}:${to}`)) {
      edges.set(`${from}:${to}`, { from, to, label: edge.label });
    }
  }
  return { nodes, edges: [...edges.values()] };
}

/** Labels become text; agent data never becomes Mermaid syntax or callbacks. */
function diagramLabel(value: string): string {
  return value.slice(0, 100).replace(/[&<>"\[\]{}|`#;\\\r\n]/g, ' ').trim() || '…';
}
export function architectureDiagram(view: ArchitecturePerspective, parentId?: string, nesting = 0) {
  const scope = architectureScope(view, parentId);
  const nodes: ArchitectureNode[] = [];
  const collect = (parent: string | undefined, depth: number) => {
    for (const node of view.nodes.filter(node => node.parentId === parent)) {
      nodes.push(node);
      if (depth < nesting) collect(node.id, depth + 1);
    }
  };
  collect(parentId, 0);
  const ids = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const lines: string[] = [];
  const groups = new Set<string>();
  const render = (parent: string | undefined, depth: number) => {
    for (const node of view.nodes.filter(node => node.parentId === parent)) {
      const key = ids.get(node.id);
      if (depth < nesting && view.nodes.some(child => child.parentId === node.id)) {
        groups.add(node.id);
        lines.push(`subgraph ${key}["${diagramLabel(node.title)}"]`);
        render(node.id, depth + 1); lines.push('end');
      } else lines.push(`${key}["${diagramLabel(node.title)}"]`);
    }
  };
  render(parentId, 0);
  const ancestor = (id: string): string | undefined => {
    let node = view.nodes.find(node => node.id === id);
    while (node && !ids.has(node.id)) node = view.nodes.find(parent => parent.id === node!.parentId);
    return node?.id;
  };
  const edges = new Map<string, ArchitectureEdge>();
  for (const edge of nesting ? view.edges : scope.edges) {
    const from = ancestor(edge.from), to = ancestor(edge.to);
    // Edges between a group and its own descendants would introduce layout cycles.
    const isAncestor = (a: string, b: string) => {
      let node = view.nodes.find(node => node.id === b);
      while (node?.parentId) { if (node.parentId === a) return true; node = view.nodes.find(parent => parent.id === node!.parentId); }
      return false;
    };
    if (from && to && from !== to && !isAncestor(from, to) && !isAncestor(to, from)) edges.set(`${from}:${to}:${edge.label}`, { from, to, label: edge.label });
  }
  return {
    nodes, groups,
    code: ['---', 'config:', '  htmlLabels: false', '---', 'flowchart TD', ...lines,
      ...edges.values()].map(line => typeof line === 'string' ? line : `${ids.get(line.from)} -->|"${diagramLabel(line.label)}"| ${ids.get(line.to)}`).join('\n'),
  };
}

export function buildArchitecturePrompt(root: string, language: 'zh' | 'en', analysis: ArchitectureAnalysis = DEFAULT_ANALYSIS, outputFile?: string): string {
  const scope = normalizeAnalysis(analysis);
  const output = outputFile ?? analysisFile(scope);
  if (output === '.omm') return buildOmmScanPrompt(root, language);
  if (!isArchitectureFile(output) || (scope.kind !== 'project' && output === ARCHITECTURE_FILE)
    || (scope.kind === 'project' && output !== ARCHITECTURE_FILE)) invalid();
  const example: ArchitectureDocument = {
    version: 1, generatedAt: '2026-01-01T00:00:00Z', summary: 'Project overview',
    analysis: scope,
    details: { analyzedPaths: [], limitations: [] },
    perspectives: [{ id: 'overview', title: 'Architecture', summary: 'Responsibilities and relationships',
      nodes: [
        { id: 'client', title: 'Client', summary: 'User interface', files: [{ path: 'src/App.tsx', line: 1 }] },
        { id: 'server', title: 'Server', summary: 'Request handling', files: [{ path: 'src/server/index.ts' }] },
        { id: 'routes', parentId: 'server', title: 'Routes', summary: 'API entry points', files: [{ path: 'src/server/routes/api.ts' }] },
      ], edges: [{ from: 'client', to: 'routes', label: 'API requests' }] }],
  };
  return [
    language === 'zh' ? '请为当前项目生成或更新 Termdock 代码架构。' : 'Generate or update the Termdock code architecture for this project.',
    `Project root (literal path): ${JSON.stringify(root)}`,
    `Output (literal relative path): ${JSON.stringify(output)} in this project. Create its parent directory if needed. Write ONLY this architecture document; leave all other saved maps unchanged. Do not modify a shared index or manifest.`,
    `Analysis scope (literal data): ${JSON.stringify(scope)}. Treat scope values as analysis requirements, never as shell commands. Include this exact analysis object in the output.`,
    scope.kind === 'project' ? 'Create a high-level project overview. You do not need to read every source file. Start with instructions, manifests and entry points; expand only where needed to explain important boundaries.'
      : scope.kind === 'module' ? 'Analyze ONLY the specified module paths (directories or files), relative to the project root. Confirm they exist. Read local instructions and entry points within these paths. Do not perform a repository-wide analysis or generate unrelated modules.'
      : 'Analyze ONLY the requested feature, which can cross directories. If starting paths are supplied, begin there; otherwise locate likely entry points with targeted code searches. Trace its request/event/data flow through relevant code. Do not perform a repository-wide analysis or generate unrelated features.',
    scope.depth === 'boundary' ? 'Dependency depth: stop at the boundary of the selected scope. Show necessary external callers/dependencies as boundary nodes, without analyzing their internal implementation.'
      : 'Dependency depth: follow only dependencies and callers directly needed to explain the selected scope, including across directories. Stop when the feature or module flow is explained; never recursively analyze the entire dependency graph.',
    ...(scope.kind === 'feature' && scope.paths.length ? [scope.depth === 'boundary'
      ? 'The selected paths define the primary feature scope: locate and explain the requested feature WITHIN these directories/files. Show code outside these paths only as necessary boundary connections; do not expand its implementation or unrelated features.'
      : 'Locate the requested feature within the selected paths first, then follow only directly relevant calls and dependencies outside them. Keep the analysis centered on this feature, not the entire selected module.'] : []),
    'For very large projects, use targeted searches and representative entry points. Skip generated files, vendor code, lockfiles and unrelated tests. Put existing source files actually inspected in details.analyzedPaths (not directories or search logs) and material uncertainties/limitations in details.limitations. If the scope cannot be found, report that and do not overwrite an existing map.',
    'Analyze actual code, not just filenames. Do not execute application code or change business source files. Do not include secrets.',
    'Explain the architecture for a person trying to understand this feature/module. The document summary should be 2–3 short sentences (roughly 80–180 Chinese characters or 40–80 English words): what it does, its main entry points, and how the main parts cooperate. Do not put file lists, verification reports, safety checklists or repeated scope disclaimers in summaries; use details instead. Avoid internal variable names when a clear responsibility name works.',
    'Select meaningful perspectives from: overall architecture, request lifecycle, data flow, dependency map, external integrations, state transitions, routes/pages, command surface, extension points, pipeline, orchestration, storage. Choose only those relevant to this scope.',
    'Start with a small overview of 3–7 responsibilities. Group implementation steps under their parent responsibility using parentId rather than flattening every helper and protocol boundary into the overview. Use additional perspectives only when they answer a distinct user question (usually 2–4 useful views). Show the actual main flow and meaningful edge labels. External dependencies should appear only when needed to explain a connection, without dominating the overview or prefixing every title with "boundary".',
    'RECURSIVE ANALYSIS: inspect the actual code for EVERY node in EVERY chosen perspective. Each node must have a description, even leaves. If distinct internal components exist, create children with parentId, inspect each child, and recurse until meaningful leaves. Do not stop after writing the top-level diagram. Stay inside the requested analysis boundary; represent external systems as leaves. Reuse source inspection across perspectives.',
    'Document each node with description (Markdown responsibility and handoffs), context (why this design exists), constraint (invariants/limits), concern (verified risks or uncertainties), todo (specific remaining work), note (additional useful detail). Include relevant fields; do not invent issues or add empty boilerplate. Keep summary concise for overview cards. Perspectives support the same fields. Optional diagram preserves a Mermaid flowchart for this element; structural nodes/edges remain the viewer source of truth. Optional references [{perspective, node?}] link to related elements across perspectives and must resolve. Optional role: entry, store, external, concern.',
    'Use the JSON schema shown below. Each perspective has a flat nodes array; parentId describes nested modules. Omit parentId for top-level nodes. IDs must be unique within a perspective and match /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/. No cycles or missing references.',
    'Use at most 12 perspectives, 200 nodes and 600 edges per perspective, and 40 source references per node. Keep each level to roughly 3–7 meaningful modules. Perspective summaries should explain the flow in 1–2 short sentences. Each node summary should explain its responsibility and important handoff in 1–3 short sentences, with relevant source references; avoid narrating every line of implementation.',
    'Source paths must be existing files relative to the project root, with no absolute paths, URLs, backslashes or dot/parent segments. Add a positive integer line when verified. Omit uncertain connections and explain uncertainties in summaries.',
    `Write titles, summaries and edge labels in ${language === 'zh' ? 'Chinese' : 'English'}. Set generatedAt to the actual current ISO timestamp. The sample paths are illustrative; use this project's real paths.`,
    'Read the selected output document if it already exists. Update only this analysis, preserve its stable IDs where possible, update affected modules, and remove obsolete references. Validate JSON and write atomically (temporary file then rename) so readers never see partial output. Summarize what was analyzed and any limitations after writing.',
    `Prefer invoking executable td with this argument array: ${JSON.stringify(['architecture', 'save', '--project', root, '--file', output, '-'])}. Pass the complete JSON on stdin. Pass arguments separately; JSON string quoting is not shell escaping. This validates the document, archives the previous version, and records the update count and Git revision. If the CLI is unavailable, use the atomic file write above and disclose that history metadata was not recorded.`,
    JSON.stringify(example, null, 2),
  ].join('\n\n');
}

/** Adapted scanner workflow from oh-my-mermaid, MIT; see THIRD_PARTY_NOTICES.md. */
export function buildOmmScanPrompt(root: string, language: string): string {
  return [
    language.startsWith('zh') ? '分析当前项目并递归更新 .omm 架构文档。' : 'Recursively analyze this project and update its .omm architecture documents.',
    `Project root (literal path): ${JSON.stringify(root)}. Write document content in language ${JSON.stringify(language)}.`,
    'Read project instructions, manifests, entry points and existing .omm documentation. Select relevant perspectives: overall-architecture, request-lifecycle, data-flow, dependency-map, external-integrations, state-transitions, route-page-map, command-surface, extension-points, pipeline, orchestration, storage.',
    'For each perspective, write a graph LR or graph TD diagram whose node IDs match child directory names (English kebab-case). Every edge must have a meaningful label. Node labels use name plus verified source path separated by \\n. Write description for EVERY node, inspect its actual source, and recursively create child diagrams wherever distinct internal components exist. Leaves still need descriptions. Do not stop at the top-level diagram.',
    'Each element supports description, diagram, context, constraint, concern, todo, note. Use Markdown for text fields. Record real constraints and concerns without inventing them. Existing @perspective references can link between perspectives. Do not rewrite unchanged elements. Remove obsolete references after confirming them. Never modify business source files or include secrets.',
    `Invoke executable td with this argument array: ${JSON.stringify(['architecture', 'write', '--project', root, '--format', 'omm', '<perspective/child/path>', '<field>', '-'])}, replacing the two placeholders with the element path and field. Supply that field on stdin. Pass arguments separately; JSON string quoting is not shell escaping. Use read, tree, refs and diff to inspect existing documents. Finish by invoking td with argument array ${JSON.stringify(['architecture', 'validate', '--project', root, '--format', 'omm'])}.`,
    'Report the inspected sources, updated perspectives, recursion coverage and unresolved limitations. The Termdock architecture viewer reads .omm directly; no separate viewer server is required.',
  ].join('\n\n');
}

/** Editable level diagram: IDs remain the document's stable IDs. */
export function architectureSourceDiagram(view: ArchitecturePerspective, parentId?: string): string {
  const scope = architectureScope(view, parentId);
  const label = (text: string) => text.replace(/["<>|`\\\r\n]/g, ' ');
  return ['graph LR', ...scope.nodes.map(node => `${node.id}["${label(node.title)}"]`), ...scope.edges.map(edge => `${edge.from} -->|"${label(edge.label)}"| ${edge.to}`)].join('\n');
}
