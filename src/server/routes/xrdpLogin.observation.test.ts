import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ readFile: vi.fn(), execFile: vi.fn(), spawn: vi.fn(), networkInterfaces: vi.fn(() => ({})) }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, spawn: mocks.spawn }));
vi.mock('node:os', () => ({ networkInterfaces: mocks.networkInterfaces }));
import { observeLocalXrdpLogin, XrdpLoginJournal } from './xrdpLogin.js';

const record = (message: string, pid = '123', unit = 'xrdp.service') => JSON.stringify({ _SYSTEMD_UNIT: unit, _PID: pid, MESSAGE: message }) + '\n';
const marker = (name: string) => `[INFO ] Connected client computer name: ${name}`;
const child = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
let processFixture: ReturnType<typeof child>;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.readFile.mockResolvedValue('[Globals]\nport=3390\n[Session]\nport=3389\n');
  mocks.execFile.mockImplementation((command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    callback(null, command === 'systemctl' ? 'active\n' : record('listener ready'));
  });
  processFixture = child();
  mocks.spawn.mockImplementation(() => { queueMicrotask(() => processFixture.emit('spawn')); return processFixture; });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('trusted XRDP journal correlation', () => {
  it('ignores forged units, unmatched processes and malformed records; matches fragmented trusted metadata', () => {
    const result = vi.fn(); const journal = new XrdpLoginJournal('td-fixture', result);
    expect(() => journal.receive('invalid JSON\nnull\n[]\n42\n"text"\n')).not.toThrow();
    journal.receive(record(marker('td-fixture'), '123', 'other.service') + record('login successful for user fixture'));
    journal.receive(record(marker('td-other')) + record('login failed for user fixture'));
    expect(result).not.toHaveBeenCalled();
    const match = record(marker('td-fixture'));
    journal.receive(match.slice(0, 20)); journal.receive(match.slice(20));
    journal.receive(record('login failed for user neighbour', '999'));
    expect(journal.matched).toBe(true); expect(result).not.toHaveBeenCalled();
    journal.receive(record('login successful for user fixture'));
    journal.receive(record('login failed for user fixture'));
    expect(result.mock.calls).toEqual([['authenticated']]);
  });
  it('reports matched PAM failure once and ignores late success', () => {
    const result = vi.fn(); const journal = new XrdpLoginJournal('td-fixture', result);
    journal.receive(record(marker('td-fixture')) + record('login failed for user fixture') + record('login successful for user fixture'));
    expect(result.mock.calls).toEqual([['failed']]);
  });
  it('bounds incomplete input and suppresses cancelled callbacks', () => {
    const result = vi.fn(); const journal = new XrdpLoginJournal('td-fixture', result);
    journal.receive('x'.repeat(256 * 1024 + 1)); expect(result).toHaveBeenCalledWith('unavailable');
    const cancelled = vi.fn(); const other = new XrdpLoginJournal('td-fixture', cancelled);
    other.cancel(); other.receive(record(marker('td-fixture')) + record('login successful for user fixture')); other.finish('timeout');
    expect(cancelled).not.toHaveBeenCalled();
  });
});

describe('optional local XRDP observer lifecycle', () => {
  it('does not read host files or spawn for remote addresses, and skips unmatched ports', async () => {
    expect(await observeLocalXrdpLogin('192.168.23.99', 3390, vi.fn())).toBeNull();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(await observeLocalXrdpLogin('127.0.0.1', 3389, vi.fn())).toBeNull();
    expect(mocks.execFile).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('falls back to ordinary RDP if host integration cannot be read', async () => {
    mocks.readFile.mockRejectedValueOnce(new Error('fixture permission denied'));
    expect(await observeLocalXrdpLogin('127.0.0.1', 3390, vi.fn())).toBeNull();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('decodes fragmented UTF8, kills the child after authentication and cancels timeout', async () => {
    const result = vi.fn(); const observer = (await observeLocalXrdpLogin('127.0.0.1', 3390, result))!;
    expect(observer.clientName).toMatch(/^td-[a-f0-9]{12}$/);
    const data = Buffer.from(record(marker(observer.clientName)) + record('login successful for user 测试'));
    const split = data.indexOf(Buffer.from('测')) + 1;
    processFixture.stdout.emit('data', data.subarray(0, split)); processFixture.stdout.emit('data', data.subarray(split));
    expect(result.mock.calls).toEqual([['authenticated']]); expect(processFixture.kill).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(20_000); processFixture.emit('exit');
    expect(result).toHaveBeenCalledOnce();
    const [command, args, options] = mocks.spawn.mock.calls[0];
    expect(command).toBe('journalctl'); expect(args).toContain('--unit=xrdp.service');
    expect(options).toEqual({ stdio: ['ignore', 'pipe', 'ignore'] });
  });
  it.each([false, true])('times out with matched process %s and cleans the child', async matched => {
    const result = vi.fn(); const observer = (await observeLocalXrdpLogin('127.0.0.1', 3390, result))!;
    if (matched) processFixture.stdout.emit('data', Buffer.from(record(marker(observer.clientName))));
    vi.advanceTimersByTime(15_000);
    expect(result.mock.calls).toEqual([[matched ? 'timeout' : 'unavailable']]); expect(processFixture.kill).toHaveBeenCalledOnce();
  });
  it('cancels without callbacks and ignores late child output', async () => {
    const result = vi.fn(); const observer = (await observeLocalXrdpLogin('127.0.0.1', 3390, result))!;
    observer.close(); processFixture.stdout.emit('data', Buffer.from(record(marker(observer.clientName)) + record('login failed for user fixture')));
    processFixture.emit('exit'); vi.advanceTimersByTime(20_000);
    expect(result).not.toHaveBeenCalled(); expect(processFixture.kill).toHaveBeenCalledOnce();
  });
  it('does not return an already exited observer that would put the RDP bridge back into pending', async () => {
    mocks.spawn.mockImplementation(() => { queueMicrotask(() => { processFixture.emit('spawn'); processFixture.emit('exit'); }); return processFixture; });
    const result = vi.fn();
    expect(await observeLocalXrdpLogin('127.0.0.1', 3390, result)).toBeNull();
    expect(result.mock.calls).toEqual([['unavailable']]);
  });
});
