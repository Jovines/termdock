/** Flowchart token conventions adapted from oh-my-mermaid's viewer (MIT).
 * Parsing returns data only; imported Mermaid directives never execute. */
export interface FlowNode { id: string; label: string; ref?: string; role?: 'entry' | 'store' | 'external' | 'concern' }
export interface FlowEdge { from: string; to: string; label: string }
export function parseFlowchart(raw: string): { nodes: FlowNode[]; edges: FlowEdge[]; issues: string[] } {
  if (raw.length > 100_000) throw new Error('Diagram is too large');
  const nodes = new Map<string, FlowNode>(), edges: FlowEdge[] = [], issues: string[] = [];
  const clean = (value: string) => value.replace(/<br\s*\/?>/gi, '\n').replace(/\\n/g, '\n');
  const token = (value: string): FlowNode | null => {
    const match = value.trim().match(/^(@?[\w-]+)(?:\s*(?:\[|\(\(?|\{)\s*(.*?)\s*(?:\]|\)\)?|\}))?(?:::\w+)?$/);
    if (!match) return null;
    const id = match[1].replace(/^@/, ''), label = clean((match[2] ?? id).replace(/^"|"$/g, ''));
    const ref = label.match(/^@([\w-]+)(?:\n|$)/)?.[1] ?? (match[1].startsWith('@') ? id : undefined);
    return { id, label, ...(ref ? { ref } : {}) };
  };
  const put = (node: FlowNode) => { const previous = nodes.get(node.id); if (!previous || node.label !== node.id) nodes.set(node.id, node); };
  const lines = raw.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('%%'));
  if (raw && !/^(?:graph|flowchart)\s+(?:LR|RL|TD|TB|BT)\b/i.test(lines[0] ?? '')) issues.push('Diagram must start with a flowchart direction');
  for (const original of lines) {
    const line = original.replace(/;\s*$/, '');
    if (/^(graph|flowchart|classDef|click\s|style\s|linkStyle|subgraph|end$)/i.test(line)) continue;
    const cls = line.match(/^class\s+([\w\-,\s]+)\s+(entry|store|external|concern)$/);
    if (cls) { for (const id of cls[1].split(',').map(value => value.trim())) { const node = nodes.get(id); if (node) node.role = cls[2] as FlowNode['role']; } continue; }
    if (/^class\s/.test(line)) continue;
    const quoted = line.match(/^(.+?)\s+--\s+"([^"]+)"\s+-->\s+(.+)$/);
    const parts = quoted ? [quoted[1], quoted[2], quoted[3]] : line.split(/(-->(?:\|[^|]*\|)?|--o|--x|---|-\.->|==>|~~>)/);
    if (parts.length >= 3) {
      for (let index = 0; index + 2 < parts.length; index += 2) {
        const from = token(parts[index]), to = token(parts[index + 2]);
        if (!from || !to) { issues.push(`Unrecognized connection: ${line}`); continue; }
        put(from); put(to);
        const label = clean(quoted ? parts[index + 1] : (parts[index + 1].match(/\|([^|]*)\|/)?.[1] ?? '').replace(/^"|"$/g, ''));
        edges.push({ from: from.id, to: to.id, label });
        if (!label) issues.push(`Connection needs a label: ${from.id} → ${to.id}`);
      }
    } else { const node = token(line); if (node) put(node); else issues.push(`Unrecognized diagram line: ${line}`); }
  }
  if (nodes.size > 200 || edges.length > 600) throw new Error('Diagram exceeds the architecture limit');
  return { nodes: [...nodes.values()], edges, issues };
}
