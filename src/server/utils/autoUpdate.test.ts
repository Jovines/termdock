import { describe, expect, it, vi } from 'vitest';
import { TermdockAutoUpdateManager, hasPendingTermdockUpdate } from './autoUpdate.js';

describe('TermdockAutoUpdateManager', () => {
  it('installs automatically but waits for confirmation while a web client is active', async () => {
    const broadcast = vi.fn();
    const requestRestart = vi.fn();
    const manager = new TermdockAutoUpdateManager({
      currentVersion: '1.4.68',
      stateFilePath: null,
      broadcast,
      requestRestart,
      updateRunner: async (_current, _fallback, onLatest) => {
        onLatest?.('1.4.69', 'official');
        return {
          status: 'updated',
          currentVersion: '1.4.68',
          latestVersion: '1.4.69',
          source: 'official',
        };
      },
    });

    const state = await manager.checkNow();
    expect(state.status).toBe('ready');
    expect(hasPendingTermdockUpdate(state)).toBe(true);
    expect(requestRestart).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ status: 'installing' }));

    await manager.checkNow();
    expect(requestRestart).not.toHaveBeenCalled();

    manager.confirmRestart();
    expect(requestRestart).toHaveBeenCalledOnce();
    expect(manager.getState().status).toBe('restarting');
  });

  it('never restarts without confirmation, even when no web client is active', async () => {
    const requestRestart = vi.fn();
    const manager = new TermdockAutoUpdateManager({
      currentVersion: '1.4.68',
      stateFilePath: null,
      broadcast: vi.fn(),
      requestRestart,
      updateRunner: async (_current, _fallback, onLatest) => {
        onLatest?.('1.4.69', 'configured');
        return {
          status: 'updated',
          currentVersion: '1.4.68',
          latestVersion: '1.4.69',
          source: 'configured',
        };
      },
    });

    expect((await manager.checkNow()).status).toBe('ready');
    expect(requestRestart).not.toHaveBeenCalled();

    manager.confirmRestart();
    expect(requestRestart).toHaveBeenCalledOnce();
  });

  it('does not expose an update marker when both registry queries fail before finding a version', async () => {
    const manager = new TermdockAutoUpdateManager({
      currentVersion: '1.4.68',
      stateFilePath: null,
      broadcast: vi.fn(),
      requestRestart: vi.fn(),
      updateRunner: async () => { throw new Error('registry unavailable'); },
    });

    const state = await manager.checkNow();
    expect(state.status).toBe('error');
    expect(state.latestVersion).toBeNull();
    expect(hasPendingTermdockUpdate(state)).toBe(false);
  });
});
