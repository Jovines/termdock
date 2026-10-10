import type { ArchitectureDocument, ArchitecturePerspective, ArchitectureReference } from './model';

/** Display-only composition; original IDs and documents stay unchanged. */
export function architectureOverview(document: ArchitectureDocument, title: string): { view: ArchitecturePerspective; references: Map<string, ArchitectureReference> } {
  const references = new Map<string, ArchitectureReference>();
  const view: ArchitecturePerspective = { id: 'all-perspectives', title, summary: document.summary, nodes: [], edges: [] };
  document.perspectives.forEach((perspective, index) => {
    const group = `perspective${index}`;
    const ids = new Map(perspective.nodes.map((node, nodeIndex) => [node.id, `${group}_node${nodeIndex}`]));
    references.set(group, { perspective: perspective.id });
    view.nodes.push({ id: group, title: perspective.title, summary: perspective.summary, files: [], description: perspective.description });
    for (const node of perspective.nodes) {
      const id = ids.get(node.id)!; references.set(id, { perspective: perspective.id, node: node.id });
      view.nodes.push({ ...node, id, parentId: node.parentId ? ids.get(node.parentId) : group });
    }
    view.edges.push(...perspective.edges.map(edge => ({ ...edge, from: ids.get(edge.from)!, to: ids.get(edge.to)! })));
  });
  return { view, references };
}
