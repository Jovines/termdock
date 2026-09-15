import { useEffect, useState } from 'react';
import type { AgentIdentity } from '../terminal/types';

/** Plugin icons are business resources: native img/mask loads bypass encrypted fetch. */
export function useAgentIconSource(agent: AgentIdentity): string | undefined {
  const endpoint = agent.icon && agent.isPlugin
    ? `/api/terminal/agent-plugin-icon/${encodeURIComponent(agent.slug)}${agent.iconVersion ? `?v=${Math.floor(agent.iconVersion)}` : ''}`
    : undefined;
  const [loaded, setLoaded] = useState<{ endpoint: string; src: string }>();
  useEffect(() => {
    setLoaded(undefined);
    if (!endpoint) return;
    const controller = new AbortController();
    let src: string | undefined;
    void fetch(endpoint, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Icon request failed: ${response.status}`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        src = URL.createObjectURL(blob);
        setLoaded({ endpoint, src });
      })
      .catch(() => { /* Keep the generic avatar; never fall back to a native API request. */ });
    return () => {
      controller.abort();
      if (src) URL.revokeObjectURL(src);
    };
  }, [endpoint]);
  if (!agent.icon) return undefined;
  if (!agent.isPlugin) return `/icons/agents/${agent.icon}.svg`;
  return loaded?.endpoint === endpoint ? loaded?.src : undefined;
}
