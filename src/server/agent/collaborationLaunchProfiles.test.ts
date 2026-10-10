import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CollaborationStore } from './collaborationStore.js';
import { launchProfileKey, resolveCollaborationLaunch, validateLaunchProfiles } from './collaborationLaunchProfiles.js';
import { buildCollaborationSpawnCommand } from './collaborationSpawn.js';
import { ensureTeam } from './collaborationTeam.js';

const fast = { id: 'fast', name: '快速排查', agentSlug: 'codex', command: 'codex --model example-fast -c model_reasoning_effort=low', notes: '适合简单排查；复杂实现用深度方案。' };
const deep = { id: 'deep', name: '深度实现', agentSlug: 'claude', command: 'claude --model example-deep --max-budget-usd 10', notes: '适合复杂实现和独立评审。' };
const group = { launchProfiles: [fast, deep], defaultLaunchProfileId: 'fast' };
const temporary: string[] = [];
afterEach(() => { for (const d of temporary.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('collaboration launch profiles', () => {
  it('delivers quoted model and parameter arguments unchanged to the launched process', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'td-profile-argv-')); temporary.push(d);
    const file = path.join(d, 'capture.cjs');
    fs.writeFileSync(file, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const configured = { ...fast, command: `node '${file}' --model 'example model' --config 'reasoning=high'` };
    const launch = resolveCollaborationLaunch({ launchProfiles: [configured] }, { agentSlug: 'codex', launchProfileId: 'fast' });
    const output = execFileSync('/bin/sh', ['-c', buildCollaborationSpawnCommand({ slug: launch.agentSlug, command: launch.profile!.command })], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual(['--model', 'example model', '--config', 'reasoning=high']);
  });
  it('uses an explicit profile including its model arguments and collaboration permissions', () => {
    const launch = resolveCollaborationLaunch(group, { agentSlug: 'claude', launchProfileId: 'deep' });
    expect(buildCollaborationSpawnCommand({ slug: launch.agentSlug, command: launch.profile!.command })).toBe(`${deep.command} --allowedTools "Bash(td collab *)"`);
    expect(launch.profile?.notes).toBe(deep.notes);
  });
  it('uses a matching default and allows an explicit plain launcher without changing agent type', () => {
    expect(resolveCollaborationLaunch(group, { agentSlug: 'codex' }).profile).toEqual(fast);
    expect(resolveCollaborationLaunch(group, { agentSlug: 'claude' }).profile).toBeUndefined();
    expect(resolveCollaborationLaunch(group, { agentSlug: 'codex', launchProfileId: '' }).profile).toBeUndefined();
    expect(resolveCollaborationLaunch(group, {}).agentSlug).toBe('codex');
  });
  it('fails closed for deleted profiles or a mismatched agent rather than launching a default command', () => {
    expect(() => resolveCollaborationLaunch(group, { launchProfileId: 'removed' })).toThrow(/已被删除/);
    expect(() => resolveCollaborationLaunch(group, { launchProfileId: 'deep', agentSlug: 'codex' })).toThrow(/不一致/);
  });
  it.each([
    { profiles: [fast, fast], defaultId: 'fast' },
    { profiles: [fast], defaultId: 'missing' },
    { profiles: [{ ...fast, command: 'codex\rmalicious' }], defaultId: 'fast' },
    { profiles: [{ ...fast, id: 12 }], defaultId: null },
    { profiles: [{ ...fast, unexpected: 'ignored?' }], defaultId: 'fast' },
  ])('rejects malformed configuration atomically: %j', ({ profiles, defaultId }) => {
    expect(() => validateLaunchProfiles(profiles, defaultId)).toThrow(/启动方案无效/);
  });
  it('persists profiles and keeps a running member’s original configuration through edits and removal', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'td-profiles-')); temporary.push(d);
    const file = path.join(d, 'groups.json'), store = new CollaborationStore(file);
    const saved = store.save({ name: '协作', sessionIds: ['worker'], ...group });
    store.setMemberLaunchProfile(saved.id, 'worker', fast);
    store.save({ id: saved.id, name: '改名', sessionIds: ['worker'] });
    expect(store.getGroup(saved.id)?.launchProfiles).toEqual(group.launchProfiles);
    store.save({ id: saved.id, name: '改名', sessionIds: ['worker'], launchProfiles: [{ ...fast, command: 'codex --model changed' }], defaultLaunchProfileId: 'fast' });
    store.save({ id: saved.id, name: '改名', sessionIds: ['worker'], launchProfiles: [], defaultLaunchProfileId: null });
    const restored = new CollaborationStore(file).getGroup(saved.id)!;
    expect(restored.memberLaunchProfiles?.worker).toEqual(fast);
    expect(restored.launchProfiles).toEqual([]);
  });
  it('does not silently reuse a member with the same agent and different launch parameters', async () => {
    const spawned: string[] = [];
    const team = await ensureTeam({ agentSlug: 'codex', cwd: '/repo', launchProfileKey: launchProfileKey(fast),
      members: () => [{ id: 'different-model', cwd: '/repo', agentSlug: 'codex' }], spawn: async role => { spawned.push(role); return 'new-' + spawned.length; } });
    expect(team).toEqual({ coordinatorSessionId: 'new-1', reviewerSessionIds: ['new-2'] });
    await expect(ensureTeam({ agentSlug: 'codex', cwd: '/repo', launchProfileKey: launchProfileKey(fast),
      members: () => [{ id: 'lead', cwd: '/repo', role: '自动协调者 (codex)', launchProfileKey: launchProfileKey({ ...fast, command: 'codex --model different' }) }], spawn: async () => 'never' })).rejects.toThrow(/已有自动配置/);
  });
  it('retains the member launch snapshot when moving to a different group', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'td-profile-move-')); temporary.push(d);
    const store = new CollaborationStore(path.join(d, 'groups.json'));
    const source = store.save({ name: '源组', sessionIds: ['worker'], ...group });
    const target = store.save({ name: '目标组', sessionIds: [] });
    store.setMemberLaunchProfile(source.id, 'worker', fast);
    store.moveMember({ sourceGroupId: source.id, targetGroupId: target.id, sessionId: 'worker',
      expectedSourceUpdatedAt: store.getGroup(source.id)!.updatedAt, expectedTargetUpdatedAt: target.updatedAt });
    expect(store.getGroup(target.id)?.memberLaunchProfiles?.worker).toEqual(fast);
    expect(store.getGroup(target.id)?.launchProfiles).toBeUndefined();
  });
});
