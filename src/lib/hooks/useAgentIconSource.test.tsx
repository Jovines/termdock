// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAgentIconSource } from './useAgentIconSource';
import type { AgentIdentity } from '../terminal/types';

const agent: AgentIdentity = { slug: 'custom', displayName: 'Custom', icon: 'custom', isPlugin: true, accentColor: 'var(--success)', iconVersion: 1 };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['native', 'mask'] as const)('loads %s icons without a worker and releases URLs on version changes', async iconMode => {
  vi.stubGlobal('navigator', { serviceWorker: { controller: null } });
  const fetchIcon = vi.fn(async () => new Response('<svg/>'));
  vi.stubGlobal('fetch', fetchIcon);
  const create = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
  const revoke = vi.fn();
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }));
  const { result, rerender, unmount } = renderHook(({ version }) => useAgentIconSource({ ...agent, iconMode, iconVersion: version }), { initialProps: { version: 1 } });
  expect(result.current).toBeUndefined();
  await waitFor(() => expect(result.current).toBe('blob:first'));
  expect(fetchIcon).toHaveBeenCalledWith('/api/terminal/agent-plugin-icon/custom?v=1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  rerender({ version: 2 });
  expect(result.current).toBeUndefined();
  await waitFor(() => expect(result.current).toBe('blob:second'));
  expect(revoke).toHaveBeenCalledWith('blob:first');
  unmount();
  expect(revoke).toHaveBeenCalledWith('blob:second');
});

it.each(['offline', '404'])('keeps failed %s requests away from native image loading', async failure => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (failure === 'offline') throw new Error('offline');
    return new Response('', { status: 404 });
  }));
  const { result } = renderHook(() => useAgentIconSource(agent));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(result.current).toBeUndefined();
});

it('keeps built-in assets static', () => {
  const fetchIcon = vi.fn(); vi.stubGlobal('fetch', fetchIcon);
  const { result } = renderHook(() => useAgentIconSource({ ...agent, isPlugin: false }));
  expect(result.current).toBe('/icons/agents/custom.svg');
  expect(fetchIcon).not.toHaveBeenCalled();
});
