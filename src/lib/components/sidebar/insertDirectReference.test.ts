// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertDirectReference } from './insertDirectReference';

afterEach(() => vi.useRealTimers());
const setup = () => ({ insert: vi.fn<(text: string, key: string) => boolean | Promise<boolean>>().mockReturnValue(true), upload: vi.fn().mockResolvedValue('/tmp/server.png'), isCurrent: vi.fn(() => true) });
describe('direct reference insertion', () => {
  it('inserts text synchronously without confirmation or upload', async () => {
    const options = setup();
    const result = insertDirectReference('/repo/doc.md:12', 'line', undefined, options);
    expect(options.insert).toHaveBeenCalledWith('/repo/doc.md:12', 'line');
    expect(options.upload).not.toHaveBeenCalled();
    await result;
  });
  it('automatically includes available evidence in one insertion', async () => {
    const options = setup();
    await insertDirectReference('PCB J1', 'point', { snapshot: Promise.resolve(new Blob(['png'])) }, options);
    expect(options.upload).toHaveBeenCalledOnce();
    expect(options.insert).toHaveBeenCalledOnce();
    expect(options.insert.mock.calls[0][0]).toContain('/tmp/server.png');
  });
  it('falls back to the original reference on upload failure', async () => {
    const options = setup(); options.upload.mockRejectedValue(new Error('offline'));
    await insertDirectReference('PCB J1', 'point', { snapshot: Promise.resolve(new Blob(['png'])) }, options);
    expect(options.insert).toHaveBeenCalledWith('PCB J1', 'point');
  });
  it('bounds slow evidence, aborts it and never inserts twice', async () => {
    vi.useFakeTimers();
    const options = setup();
    let resolve!: (path: string) => void;
    options.upload.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    const result = insertDirectReference('PCB J1', 'point', { snapshot: Promise.resolve(new Blob(['png'])) }, options);
    await vi.advanceTimersByTimeAsync(3000);
    await result;
    expect(options.upload.mock.calls[0][1].aborted).toBe(true);
    expect(options.insert).toHaveBeenCalledWith('PCB J1', 'point');
    resolve('/tmp/late.png'); await Promise.resolve();
    expect(options.insert).toHaveBeenCalledOnce();
  });
  it('does not insert into a different session or route after upload', async () => {
    const options = setup();
    options.upload.mockImplementation(async () => { options.isCurrent.mockReturnValue(false); return '/tmp/saved.png'; });
    await expect(insertDirectReference('PCB J1', 'point', { snapshot: Promise.resolve(new Blob(['png'])) }, options)).resolves.toBe(false);
    expect(options.insert).not.toHaveBeenCalled();
  });
  it.each([false, true])('waits for actual insertion acceptance with evidence %s', async withEvidence => {
    const options = setup(); let accept!: (accepted: boolean) => void;
    options.insert.mockReturnValue(new Promise<boolean>(resolve => { accept = resolve; }));
    const result = insertDirectReference('reference', 'key', withEvidence ? { snapshot: Promise.resolve(new Blob(['png'])) } : undefined, options);
    const settled = vi.fn(); void result.then(settled);
    await vi.waitFor(() => expect(options.insert).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    accept(true); await expect(result).resolves.toBe(true);
    expect(options.insert).toHaveBeenCalledOnce();
  });
  it.each([false, true])('preserves a rejected insertion result with asynchronous callback %s', async asynchronous => {
    const options = setup(); options.insert.mockReturnValue(asynchronous ? Promise.resolve(false) : false);
    await expect(insertDirectReference('reference', 'key', undefined, options)).resolves.toBe(false);
    expect(options.insert).toHaveBeenCalledOnce();
  });
  it.each([false, true])('propagates actual insertion failure after optional evidence failure %s', async withEvidence => {
    const options = setup(); const failure = new Error('terminal did not accept input');
    options.upload.mockRejectedValue(new Error('optional upload failed'));
    options.insert.mockImplementation(() => Promise.reject(failure));
    await expect(insertDirectReference('reference', 'key', withEvidence ? { snapshot: Promise.resolve(new Blob(['png'])) } : undefined, options)).rejects.toBe(failure);
    expect(options.insert).toHaveBeenCalledExactlyOnceWith('reference', 'key');
  });
  it('does not upload or insert after the target changes while waiting for a snapshot', async () => {
    const options = setup(); let captured!: (blob: Blob) => void;
    const result = insertDirectReference('reference', 'key', { snapshot: new Promise<Blob>(resolve => { captured = resolve; }) }, options);
    options.isCurrent.mockReturnValue(false); captured(new Blob(['png']));
    await expect(result).resolves.toBe(false);
    expect(options.upload).not.toHaveBeenCalled(); expect(options.insert).not.toHaveBeenCalled();
  });
});
