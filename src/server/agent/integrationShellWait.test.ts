import { expect, it, vi } from 'vitest';
import { waitForIntegrationShell, type IntegrationShellObservation } from './integrationShellWait.js';
import { beginLaunchDiagnostics, launchFailure } from './sessionLaunchDiagnostics.js';

const binding = { serverPid: 100, sessionId: '$1', paneId: '%1', panePid: 200, agentSlug: '', nativeSessionId: null };
const shell = (confirmed: boolean): IntegrationShellObservation => ({ binding, confirmed, agent: false,
  reason: confirmed ? null : 'SHELL_FOREGROUND_MISMATCH', pgid: 200, tpgid: confirmed ? 200 : 201 });
it('waits through shell initialization on one runtime without launching or typing', async () => {
  let time = 0;
  const observe = vi.fn().mockResolvedValueOnce(shell(false)).mockResolvedValue(shell(true));
  expect(await waitForIntegrationShell({ observe, now: () => time, pause: async ms => { time += ms; } })).toEqual(binding);
  expect(observe).toHaveBeenCalledTimes(2); expect(time).toBe(100);
});
it('returns immediately for a verified foreground shell', async () => {
  const pause = vi.fn();
  expect(await waitForIntegrationShell({ observe: async () => shell(true), pause })).toEqual(binding);
  expect(pause).not.toHaveBeenCalled();
});
it('rejects a changed pane even if the new pane is a verified shell', async () => {
  const observe = vi.fn().mockResolvedValueOnce(shell(false)).mockResolvedValue({ ...shell(true), binding: { ...binding, panePid: 300 } });
  await expect(waitForIntegrationShell({ observe, pause: async () => {} })).rejects.toMatchObject({ code: 'SESSION_IDENTITY_MISMATCH', shellEvidence: { samples: 2 } });
});
it('records bounded shell evidence on timeout and rejects an existing Agent immediately', async () => {
  let time = 0;
  await expect(waitForIntegrationShell({ observe: async () => shell(false), timeoutMs: 200,
    now: () => time, pause: async ms => { time += ms; } })).rejects.toMatchObject({ code: 'SESSION_TARGET_NOT_SHELL',
    shellEvidence: { samples: 3, waited_ms: 200, reason: 'SHELL_FOREGROUND_MISMATCH', binding } });
  const pause = vi.fn();
  await expect(waitForIntegrationShell({ observe: async () => ({ ...shell(false), agent: true }), pause })).rejects.toMatchObject({ code: 'SESSION_TARGET_NOT_SHELL' });
  expect(pause).not.toHaveBeenCalled();
});
it('persists only structured shell failure evidence in launch diagnostics', async () => {
  try {
    await waitForIntegrationShell({ observe: async () => shell(false), timeoutMs: 0 });
    throw new Error('expected failure');
  } catch (error) {
    expect(launchFailure(beginLaunchDiagnostics('op', 1, 'cold_start'), error, 'SESSION_TARGET_NOT_SHELL')).toMatchObject({
      paste: 'not_attempted', submit: 'not_attempted', reason_code: 'SESSION_TARGET_NOT_SHELL',
      shell_check: { reason: 'SHELL_FOREGROUND_MISMATCH', binding, samples: 1 },
    });
  }
});
