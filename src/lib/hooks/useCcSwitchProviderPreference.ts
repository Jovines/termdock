/**
 * Per-agent cc-switch provider preference ("remember last pick").
 *
 * The server-side settings doc (`settings.ccSwitchProviders`) is the source
 * of truth shared by every connected client; a localStorage mirror gives
 * synchronous reads for launch paths that cannot await a fetch (e.g. the
 * sidebar quick-launch button). An absent slug means "follow the global
 * config" — launch exactly as before with no per-instance override.
 *
 * @author chaoruitao@bytedance.com by Trae
 */

import { useCallback, useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../terminal/api';

const PROVIDER_PREFERENCE_KEY = 'termdock:cc-switch-provider:v1';

export type CcSwitchProviderPreference = Record<string, string>;

export type CcSwitchAppSlug = 'claude' | 'codex';

/** Agents that support per-instance cc-switch provider overrides. */
export function ccSwitchAppForSlug(slug: string | undefined | null): CcSwitchAppSlug | null {
  return slug === 'claude' || slug === 'codex' ? slug : null;
}

export function readCcSwitchProviderPreference(): CcSwitchProviderPreference {
  if (typeof window === 'undefined') return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(PROVIDER_PREFERENCE_KEY) || '{}') as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value)
      .filter(([slug, providerId]) => (
        /^[a-z][a-z0-9-]{0,39}$/.test(slug)
        && typeof providerId === 'string'
        && /^[A-Za-z0-9_-]{1,128}$/.test(providerId)
      ))) as CcSwitchProviderPreference;
  } catch {
    return {};
  }
}

function cacheCcSwitchProviderPreference(preference: CcSwitchProviderPreference): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PROVIDER_PREFERENCE_KEY, JSON.stringify(preference));
  } catch {
    // The server remains the source of truth when browser storage is unavailable.
  }
}

export function useCcSwitchProviderPreference() {
  const [providers, setProviders] = useState<CcSwitchProviderPreference>(readCcSwitchProviderPreference);

  useEffect(() => {
    let cancelled = false;
    void getSettings().then((settings) => {
      if (cancelled) return;
      const fromServer = settings.ccSwitchProviders ?? {};
      setProviders(fromServer);
      cacheCcSwitchProviderPreference(fromServer);
    }).catch(() => {
      // Keep the cached preference when the server is temporarily unavailable.
    });
    return () => { cancelled = true; };
  }, []);

  const rememberProvider = useCallback(async (slug: CcSwitchAppSlug, providerId: string | null) => {
    setProviders((previous) => {
      const next = { ...previous };
      if (providerId) next[slug] = providerId;
      else delete next[slug];
      cacheCcSwitchProviderPreference(next);
      return next;
    });
    try {
      await updateSettings({ ccSwitchProvider: { slug, providerId } });
    } catch {
      // Local mirror already updated; the next successful settings sync wins.
    }
  }, []);

  return { ccSwitchProviders: providers, rememberProvider };
}
