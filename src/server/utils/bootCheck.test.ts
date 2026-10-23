// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const fixture = vi.hoisted(() => ({ root: '', ensure: vi.fn(), probe: vi.fn(), rebuild: vi.fn(), clear: vi.fn(), tmux: vi.fn() }));
vi.mock('./ensureNodePty.js', () => ({ ensureNodePty: fixture.ensure }));
vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => fixture.root } };
});
vi.mock('node:module', () => ({ createRequire: () => Object.assign((name: string) => name.endsWith('install-utils.cjs')
  ? { probeNodePty: fixture.probe, checkTmux: fixture.tmux, clearPtyModuleCache: fixture.clear }
  : { rebuildNodePty: fixture.rebuild }, { resolve: () => path.join(fixture.root, 'node-pty/package.json') }) }));
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock boot '));
  fixture.tmux.mockReturnValue({ ok: true, installed: false, version: 'tmux 3.6' });
});
afterEach(() => { fs.rmSync(fixture.root, { recursive: true, force: true }); });

it('rechecks dependencies despite a successful marker from another Node installation', async () => {
  const marker = path.join(fixture.root, '.termdock/.boot-check-ok');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ nodePty: { ok: true }, tmux: { ok: true }, runtime: { abi: 'old' } }));
  fixture.tmux.mockReturnValue({ ok: false, installed: false, error: 'removed tmux' });
  const { runBootChecks } = await import('./bootCheck.js');
  expect(runBootChecks().tmux.ok).toBe(false);
  expect(fixture.probe).toHaveBeenCalled();
  expect(fs.existsSync(marker)).toBe(false);
});
it('repairs an addon, clears cached native modules and probes again', async () => {
  fixture.probe.mockImplementationOnce(() => { throw new Error('old ABI'); });
  const { runBootChecks } = await import('./bootCheck.js');
  expect(runBootChecks().nodePty).toEqual({ ok: true, rebuilt: true });
  expect(fixture.rebuild).toHaveBeenCalledWith(path.join(fixture.root, 'node-pty'), { timeout: 120_000 });
  expect(fixture.clear).toHaveBeenCalled(); expect(fixture.probe).toHaveBeenCalledTimes(2);
  runBootChecks(); expect(fixture.probe).toHaveBeenCalledTimes(2);
});
it('keeps Darwin patch failures fatal without trying an unpatched fallback', async () => {
  fixture.ensure.mockImplementation(() => { throw new Error('patched rebuild failed'); });
  const { runBootChecks } = await import('./bootCheck.js');
  expect(runBootChecks().nodePty).toMatchObject({ ok: false, error: expect.stringContaining('patched rebuild failed') });
  expect(fixture.rebuild).not.toHaveBeenCalled(); expect(fixture.probe).not.toHaveBeenCalled();
});
it('reports a repair that still cannot create a terminal as a failure', async () => {
  fixture.probe.mockImplementation(() => { throw new Error('spawn failed'); });
  const { runBootChecks } = await import('./bootCheck.js');
  expect(runBootChecks().nodePty).toMatchObject({ ok: false, error: expect.stringContaining('spawn failed') });
});
