import { ARCHITECTURE_FIELDS, parseArchitecture, type ArchitectureDocument, type ArchitectureField } from './document.js';
import { parseFlowchart } from './flowchart.js';

/** Keep native structural data and its editable Mermaid field consistent. */
export function updateArchitectureField(input: ArchitectureDocument, perspective: string, nodeId: string | undefined, field: ArchitectureField, value: string): ArchitectureDocument {
  if (!ARCHITECTURE_FIELDS.includes(field) || typeof value !== 'string' || value.length > 100_000) throw new Error('Invalid architecture field');
  const document = parseArchitecture(JSON.stringify(input));
  const view = document.perspectives.find(view => view.id === perspective);
  const target = nodeId ? view?.nodes.find(node => node.id === nodeId) : view;
  if (!view || !target) throw new Error('Architecture element not found');
  target[field] = value;
  if (field === 'description') target.summary = value.replace(/[#*`]/g, '').split(/\n\s*\n/)[0].slice(0, 600);
  if (field === 'diagram') {
    const graph = parseFlowchart(value);
    const invalid = graph.issues.filter(issue => !issue.startsWith('Connection needs'));
    if (invalid.length) throw new Error(invalid.join('\n'));
    const direct = view.nodes.filter(node => node.parentId === nodeId);
    const removed = new Set(direct.filter(node => !graph.nodes.some(item => item.id === node.id)).map(node => node.id));
    for (let index = 0; index < view.nodes.length; index++) for (const node of view.nodes) if (node.parentId && removed.has(node.parentId)) removed.add(node.id);
    view.nodes = view.nodes.filter(node => !removed.has(node.id));
    const directIds = new Set(direct.map(node => node.id));
    view.edges = view.edges.filter(edge => !removed.has(edge.from) && !removed.has(edge.to) && !(directIds.has(edge.from) && directIds.has(edge.to)));
    for (const item of graph.nodes) {
      let node = view.nodes.find(node => node.id === item.id);
      if (node && node.parentId !== nodeId) throw new Error(`Diagram ID belongs to another level: ${item.id}`);
      if (!node) { node = { id: item.id, title: item.label.split('\n')[0], summary: '', files: [], ...(nodeId ? { parentId: nodeId } : {}) }; view.nodes.push(node); }
      node.title = item.label.split('\n')[0]; node.role = item.role;
      if (item.ref) {
        if (!document.perspectives.some(view => view.id === item.ref)) throw new Error(`Reference does not exist: ${item.ref}`);
        node.references = [{ perspective: item.ref }];
      }
    }
    view.edges.push(...graph.edges);
    for (const other of document.perspectives) for (const node of other.nodes) if (node.references?.some(ref => ref.perspective === perspective && ref.node && removed.has(ref.node))) throw new Error('A removed node is referenced by another perspective');
  }
  return parseArchitecture(JSON.stringify(document));
}
