import { describe, expect, it } from 'vitest';
import { TmuxLifecycleCoordinator } from './tmuxLifecycle.js';

describe('TmuxLifecycleCoordinator', () => {
  it('serializes different tmux lifecycle mutations', async () => {
    const coordinator = new TmuxLifecycleCoordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = coordinator.run('create:a', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      return 'first';
    });
    const second = coordinator.run('delete:b', async () => {
      events.push('second:start');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('coalesces duplicate requests while keeping failures from blocking the queue', async () => {
    const coordinator = new TmuxLifecycleCoordinator();
    let calls = 0;
    const failed = coordinator.run('delete:a', async () => {
      calls += 1;
      throw new Error('gone');
    });
    const duplicate = coordinator.run('delete:a', async () => {
      calls += 1;
      return 'unexpected';
    });

    await expect(failed).rejects.toThrow('gone');
    await expect(duplicate).rejects.toThrow('gone');
    await expect(coordinator.run('create:b', async () => 'ok')).resolves.toBe('ok');
    expect(calls).toBe(1);
  });
});
