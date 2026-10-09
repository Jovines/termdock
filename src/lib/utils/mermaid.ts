interface MermaidLike {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}
let mermaidPromise: Promise<MermaidLike> | null = null;
let initialized = false;
export function loadMermaid(): Promise<MermaidLike> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then(mod => (mod.default ?? mod) as unknown as MermaidLike)
      .catch(error => { mermaidPromise = null; throw error; });
  }
  return mermaidPromise;
}
export function initializeMermaid(mermaid: MermaidLike): void {
  if (initialized) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
  initialized = true;
}
