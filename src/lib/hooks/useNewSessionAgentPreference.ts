import { useCallback, useEffect, useState } from 'react';
import {
  getAgentLaunchers,
  getSettings,
  updateSettings,
  type AgentLauncherInfo,
} from '../terminal/api';

const AGENT_PREFERENCE_KEY = 'termdock:new-session-agent:v1';

export type NewSessionAgentPreference = AgentLauncherInfo | null;

export function readNewSessionAgentPreference(): NewSessionAgentPreference {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(AGENT_PREFERENCE_KEY) || 'null') as Partial<AgentLauncherInfo> | null;
    if (!value || typeof value.slug !== 'string' || typeof value.command !== 'string') return null;
    return {
      slug: value.slug,
      command: value.command,
      displayName: typeof value.displayName === 'string' ? value.displayName : value.slug,
      capabilities: Array.isArray(value.capabilities)
        ? value.capabilities.filter((capability): capability is string => typeof capability === 'string')
        : undefined,
      accentColor: typeof value.accentColor === 'string' ? value.accentColor : 'var(--muted-foreground)',
      icon: typeof value.icon === 'string' ? value.icon : null,
      isPlugin: value.isPlugin === true,
      iconMode: value.iconMode === 'native' ? 'native' : value.iconMode === 'mask' ? 'mask' : undefined,
      iconVersion: typeof value.iconVersion === 'number' ? value.iconVersion : undefined,
    };
  } catch {
    return null;
  }
}

function cacheNewSessionAgentPreference(preference: NewSessionAgentPreference): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AGENT_PREFERENCE_KEY, JSON.stringify(preference));
  } catch {
    // The server remains the source of truth when browser storage is unavailable.
  }
}

export function resolveNewSessionAgentPreference(
  slug: string | null,
  agents: AgentLauncherInfo[],
): NewSessionAgentPreference {
  return slug ? agents.find((agent) => agent.slug === slug) ?? null : null;
}

export function useNewSessionAgentPreference() {
  const [preference, setPreference] = useState<NewSessionAgentPreference>(readNewSessionAgentPreference);
  const [agents, setAgents] = useState<AgentLauncherInfo[]>([]);
  const [detecting, setDetecting] = useState(true);

  const refresh = useCallback(async () => {
    setDetecting(true);
    try {
      const [settings, detected] = await Promise.all([getSettings(), getAgentLaunchers()]);
      const resolved = resolveNewSessionAgentPreference(settings.newSessionAgentSlug, detected);
      setAgents(detected);
      setPreference(resolved);
      cacheNewSessionAgentPreference(resolved);
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => {
    const start = () => {
      void refresh().catch(() => {
        // Keep the cached preference when the server is temporarily unavailable.
      });
    };
    if (performance.getEntriesByName('termdock:startup:initial-viewport-presented').length > 0) {
      start();
      return;
    }
    window.addEventListener('termdock:initial-viewport-presented', start, { once: true });
    return () => window.removeEventListener('termdock:initial-viewport-presented', start);
  }, [refresh]);

  const selectAgent = useCallback(async (next: NewSessionAgentPreference) => {
    const previous = preference;
    setPreference(next);
    cacheNewSessionAgentPreference(next);
    try {
      await updateSettings({ newSessionAgentSlug: next?.slug ?? null });
    } catch (error) {
      setPreference(previous);
      cacheNewSessionAgentPreference(previous);
      throw error;
    }
  }, [preference]);

  return { preference, agents, detecting, refresh, selectAgent };
}
