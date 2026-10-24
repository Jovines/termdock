// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ShareAccessContext, SessionCapabilitiesContext } from '../../federation/ShareAccessContext';
import { sharedSessionCapabilities } from '../../federation/sessionCapabilities';
import { SessionChatView } from './SessionChatView';
import { clearChatSnapshots } from './chatSnapshot';
afterEach(() => { cleanup(); clearChatSnapshots(); sessionStorage.clear(); vi.unstubAllGlobals(); });
it('requires an explicit input capability even when a reused shared chat requests write access', async () => {
  const fetch = vi.fn(async () => Response.json({ agentAvailable: true, messages: [] })); vi.stubGlobal('fetch', fetch);
  const content = (write?: boolean) => <ShareAccessContext.Provider value={{}}><SessionCapabilitiesContext.Provider value={sharedSessionCapabilities(write === undefined ? undefined : { canWrite: write })}><SessionChatView sessionId="shared-capabilities" canWrite onTerminal={() => {}} /></SessionCapabilitiesContext.Provider></ShareAccessContext.Provider>;
  const view = render(content());
  const input = screen.getByRole('textbox') as HTMLElement;
  expect(input.getAttribute('contenteditable')).toBe('false');
  expect(input.getAttribute('aria-readonly')).toBe('true');
  view.rerender(content(true)); await waitFor(() => expect(input.getAttribute('contenteditable')).toBe('true'));
  expect(input.hasAttribute('aria-readonly')).toBe(false);
  view.rerender(content(false)); await waitFor(() => expect(input.getAttribute('contenteditable')).toBe('false'));
  view.rerender(<SessionCapabilitiesContext.Provider value={sharedSessionCapabilities({})}><SessionChatView sessionId="explicit-readonly" canWrite onTerminal={() => {}} /></SessionCapabilitiesContext.Provider>);
  expect(screen.getByRole('textbox').getAttribute('contenteditable')).toBe('false');
  expect(fetch.mock.calls.some(call => (call as unknown[])[1] && ((call as unknown[])[1] as RequestInit).method === 'POST')).toBe(false);
});
