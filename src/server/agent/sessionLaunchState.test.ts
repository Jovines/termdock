import { afterEach, expect, it, vi } from 'vitest';
import { mergeSessionLaunchState, type SessionLaunchState } from './sessionLaunchState.js';
import { captureRuntimeInputGuard, serializeTerminalInput, type RuntimeInputIdentity } from './terminalInput.js';
import { writeBracketedPrompt } from './promptDelivery.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const backend = { write: vi.fn() };
  let record: SessionLaunchState & { name: string } = { name: 'role', backendSessionId: 'backend',
    agentLaunchGeneration: null, agentLaunchCheck: null };
  let runtime = backend;
  let revision: string | null = null;
  const identity = (): RuntimeInputIdentity => ({ backendSessionId: record.backendSessionId,
    launchId: record.agentLaunchGeneration ?? null, backendInstance: runtime, routeRevision: revision });
  const start = (id: string) => {
    record = mergeSessionLaunchState(record, record, { expectedGeneration: record.agentLaunchGeneration ?? null,
      expectedCheckId: record.agentLaunchCheck?.id ?? null, generation: id,
      check: { id, agentSlug: 'fixture', nativeSessionId: null, deadline: Date.now() + 1000 } });
    return captureRuntimeInputGuard(identity);
  };
  return { backend, identity, start, get: () => record,
    metadata(snapshot: typeof record, name: string) { record = mergeSessionLaunchState({ ...snapshot, name }, record); },
    clear() { record = mergeSessionLaunchState(record, record, { expectedGeneration: record.agentLaunchGeneration ?? null,
      expectedCheckId: record.agentLaunchCheck?.id ?? null, generation: record.agentLaunchGeneration ?? null, check: null }); },
    replaceBackend() { runtime = { write: vi.fn() }; }, rebind() { revision = 'new-binding'; } };
}

it('keeps a new launch through delayed rename and old snapshot backfill, then writes once', async () => {
  vi.useFakeTimers();
  const f = fixture(), old = f.get();
  let finishRename!: () => void;
  const gate = new Promise<void>(resolve => { finishRename = resolve; });
  const rename = gate.then(() => f.metadata(old, 'renamed'));
  const guard = f.start('launch-A');
  const snapshotA = f.get();
  finishRename(); await rename;
  expect(f.get()).toMatchObject({ name: 'renamed', agentLaunchGeneration: 'launch-A', agentLaunchCheck: { id: 'launch-A' } });
  // An old metadata observer must not restore a cleared one-time check either.
  f.clear(); f.metadata(snapshotA, 'backfilled');
  expect(f.get().agentLaunchCheck).toBeNull();
  guard('launch_persisted');
  const write = writeBracketedPrompt(f.backend, 'launch command', guard);
  await vi.advanceTimersByTimeAsync(50); await write;
  expect(f.backend.write.mock.calls).toEqual([['\x1b[200~launch command\x1b[201~'], ['\r']]);
});

it('does not roll a second launch back when an older metadata callback commits', () => {
  const f = fixture(), guardA = f.start('launch-A'), old = f.get();
  f.start('launch-B'); f.metadata(old, 'late title');
  expect(f.get().agentLaunchGeneration).toBe('launch-B');
  expect(() => guardA('launch_persisted')).toThrow(expect.objectContaining({
    evidence: expect.objectContaining({ expected_launch_id: 'launch-A', current_launch_id: 'launch-B',
      check_phase: 'launch_persisted', backend_instance_matches: true }) }));
});

it('rejects a stale lifecycle check update instead of clearing the next launch', () => {
  const f = fixture(); f.start('launch-A'); const old = f.get(); f.start('launch-B');
  expect(() => mergeSessionLaunchState(old, f.get(), { expectedGeneration: 'launch-A', expectedCheckId: 'launch-A',
    generation: 'launch-A', check: null })).toThrow(expect.objectContaining({
      evidence: expect.objectContaining({ check_phase: 'launch_state_commit', current_launch_id: 'launch-B' }) }));
  expect(f.get().agentLaunchCheck?.id).toBe('launch-B');
});

it('retains the exact guard across persistence await and refuses a replacement before any write', async () => {
  const f = fixture();
  let persisted!: () => void;
  const gate = new Promise<void>(resolve => { persisted = resolve; });
  const begin = async () => { const guard = f.start('launch-A'); await gate; guard('launch_persisted'); return guard; };
  const pending = begin();
  const failed = expect(pending).rejects.toMatchObject({ code: 'TERMINAL_INPUT_TARGET_CHANGED',
    evidence: { expected_launch_id: 'launch-A', current_launch_id: 'launch-B', check_phase: 'launch_persisted' } });
  f.start('launch-B'); persisted(); await failed;
  expect(f.backend.write).not.toHaveBeenCalled();
});

it.each(['metadata', 'launch', 'backend', 'binding'] as const)('fences queued input after %s interleaves', async change => {
  vi.useFakeTimers();
  const f = fixture(), old = f.get(), guard = f.start('launch-A');
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocker = serializeTerminalInput(f.backend, async () => { entered(); await gate; });
  await started;
  const stages: string[] = [];
  const pending = writeBracketedPrompt(f.backend, 'private payload', guard, stage => stages.push(stage));
  const outcome = change === 'metadata' ? pending : expect(pending).rejects.toMatchObject({ code: 'TERMINAL_INPUT_TARGET_CHANGED',
    evidence: { check_phase: 'queue_acquired', expected_launch_id: 'launch-A', guard_captured_at: expect.any(Number), checked_at: expect.any(Number) } });
  if (change === 'metadata') f.metadata(old, 'late rename');
  if (change === 'launch') f.start('launch-B');
  if (change === 'backend') f.replaceBackend();
  if (change === 'binding') f.rebind();
  release(); await blocker; await vi.advanceTimersByTimeAsync(50); await outcome;
  if (change === 'metadata') expect(stages).toEqual(['queue_wait', 'queue_acquired', 'paste_attempted', 'paste_written', 'submit_attempted', 'submit_written']);
  else { expect(stages).toEqual(['queue_wait', 'queue_acquired']); expect(f.backend.write).not.toHaveBeenCalled(); }
});

it('does not submit to a new launch after the first paste has returned', async () => {
  vi.useFakeTimers();
  const f = fixture(), guard = f.start('launch-A');
  const pending = writeBracketedPrompt(f.backend, 'private payload', guard);
  const failure = expect(pending).rejects.toMatchObject({ code: 'TERMINAL_INPUT_TARGET_CHANGED', evidence: { check_phase: 'before_submit' } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.backend.write).toHaveBeenCalledTimes(1);
  f.start('launch-B');
  await vi.advanceTimersByTimeAsync(50); await failure;
  expect(f.backend.write).toHaveBeenCalledTimes(1);
});

it('does not silently adopt the latest launch when a guard captured null', () => {
  const f = fixture(), oldGuard = captureRuntimeInputGuard(f.identity);
  f.start('launch-A');
  expect(() => oldGuard('runtime_resolved')).toThrow(expect.objectContaining({ evidence: expect.objectContaining({
    expected_launch_id: null, current_launch_id: 'launch-A', backend_instance_matches: true, check_phase: 'runtime_resolved' }) }));
});
