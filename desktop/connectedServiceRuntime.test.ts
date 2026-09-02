import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkConnectedServiceRuntime,
  getConnectedServiceRuntimeState,
  restartConnectedServiceRuntime,
} from './connectedServiceRuntime.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connected service Runtime restart compatibility', () => {
  it('asks the service loaded in the current window to restart itself', async () => {
    const state = {
      status: 'restarting',
      currentVersion: '1.4.127',
      latestVersion: '1.4.128',
      source: 'official',
      checkedAt: Date.now(),
      error: null,
    };
    const executeJavaScript = vi.fn().mockResolvedValue(state);

    await expect(restartConnectedServiceRuntime({ executeJavaScript })).resolves.toBe(state);

    expect(executeJavaScript).toHaveBeenCalledOnce();
    const [script, userGesture] = executeJavaScript.mock.calls[0] as [string, boolean];
    expect(userGesture).toBe(true);
    expect(script).toContain("fetch('/api/csrf-token')");
    expect(script).toContain("fetch('/api/terminal/update/restart'");
    expect(script).not.toContain('desktop:restart-runtime');
    expect(script).not.toContain('localhost:9834');
  });

  it('passes connected-service failures back to the legacy caller', async () => {
    const executeJavaScript = vi.fn().mockRejectedValue(new Error('旧 npm 服务重启失败'));

    await expect(restartConnectedServiceRuntime({ executeJavaScript }))
      .rejects.toThrow('旧 npm 服务重启失败');
  });

  it('reads and checks updates from the service loaded in the current window', async () => {
    const executeJavaScript = vi.fn().mockResolvedValue({ status: 'current' });

    await getConnectedServiceRuntimeState({ executeJavaScript });
    await checkConnectedServiceRuntime({ executeJavaScript });

    const [stateScript] = executeJavaScript.mock.calls[0] as [string, boolean];
    const [checkScript] = executeJavaScript.mock.calls[1] as [string, boolean];
    expect(stateScript).toContain("fetch('/api/terminal/update')");
    expect(checkScript).toContain("fetch('/api/terminal/update/check'");
    expect(stateScript).not.toContain('localhost:9834');
    expect(checkScript).not.toContain('localhost:9834');
  });

  it('uses the connected page credentials and CSRF token for the restart request', async () => {
    const restarting = {
      status: 'restarting',
      currentVersion: '1.4.127',
      latestVersion: '1.4.128',
      source: 'official',
      checkedAt: Date.now(),
      error: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ csrfToken: 'connected-service-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(restarting),
      });
    vi.stubGlobal('fetch', fetchMock);
    const executeJavaScript = vi.fn((script: string) => (0, eval)(script));

    await expect(restartConnectedServiceRuntime({ executeJavaScript })).resolves.toEqual(restarting);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/csrf-token');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/terminal/update/restart', {
      method: 'POST',
      headers: { 'X-XSRF-TOKEN': 'connected-service-token' },
    });
  });
});
