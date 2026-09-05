// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertDirectReference } from './insertDirectReference';

afterEach(() => vi.useRealTimers());
const setup = () => ({ insert: vi.fn(), upload: vi.fn().mockResolvedValue('/tmp/server.png'), isCurrent: vi.fn(() => true) });
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
    await insertDirectReference('PCB J1', 'point', { snapshot: Promise.resolve(new Blob(['png'])) }, options);
    expect(options.insert).not.toHaveBeenCalled();
  });
});
