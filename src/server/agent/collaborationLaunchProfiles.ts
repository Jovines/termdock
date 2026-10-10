import { CollaborationError } from './collaborationProtocol.js';

export interface CollaborationLaunchProfile {
  id: string;
  name: string;
  agentSlug: string;
  command: string;
  notes: string;
}
export interface CollaborationLaunchSettings {
  launchProfiles?: CollaborationLaunchProfile[];
  defaultLaunchProfileId?: string | null;
  memberLaunchProfiles?: Record<string, CollaborationLaunchProfile>;
}

/** User-authored shell commands; never interpolate coordinator-provided parameters. */
export function validateLaunchProfiles(profiles: unknown, defaultId: unknown): CollaborationLaunchProfile[] {
  const invalid = () => { throw new CollaborationError('INVALID_LAUNCH_PROFILE', '启动方案无效：请填写唯一标识、名称、Agent 和单行启动命令，并选择存在的默认方案', 400); };
  if (!Array.isArray(profiles) || profiles.length > 20) return invalid();
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)
      || Object.keys(profile).some(key => !['id', 'name', 'agentSlug', 'command', 'notes'].includes(key))
      || typeof profile.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.id) || ids.has(profile.id)
      || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 100
      || typeof profile.agentSlug !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.agentSlug)
      || typeof profile.command !== 'string' || !profile.command.trim() || profile.command.length > 4096
      || typeof profile.notes !== 'string' || profile.notes.length > 2000
      || /[\x00-\x1f\x7f]/.test(profile.command + profile.name)
      || /[\x00-\x08\x0b-\x1f\x7f]/.test(profile.notes)) return invalid();
    ids.add(profile.id);
  }
  if (defaultId !== undefined && defaultId !== null && (typeof defaultId !== 'string' || !ids.has(defaultId))) return invalid();
  return profiles.map(p => ({ id: p.id, name: p.name.trim(), agentSlug: p.agentSlug, command: p.command.trim(), notes: p.notes.trim() }));
}

export function resolveCollaborationLaunch(group: CollaborationLaunchSettings, input: { agentSlug?: unknown; launchProfileId?: unknown }) {
  if (input.launchProfileId !== undefined && typeof input.launchProfileId !== 'string') throw new CollaborationError('INVALID_LAUNCH_PROFILE', '启动方案标识必须是文本', 400);
  const slug = typeof input.agentSlug === 'string' ? input.agentSlug.trim().toLowerCase() : '';
  const explicit = typeof input.launchProfileId === 'string' && !!input.launchProfileId;
  const profileId = explicit ? input.launchProfileId : input.launchProfileId === '' ? null : group.defaultLaunchProfileId;
  const candidate = group.launchProfiles?.find(p => p.id === profileId);
  if (explicit && !candidate) throw new CollaborationError('LAUNCH_PROFILE_NOT_FOUND', '启动方案已被删除，请读取最新协作组配置', 409);
  if (explicit && slug && candidate!.agentSlug !== slug) throw new CollaborationError('LAUNCH_PROFILE_AGENT_MISMATCH', '启动方案与所选 Agent 类型不一致', 400);
  const profile = candidate && (!slug || candidate.agentSlug === slug) ? candidate : undefined;
  if (profile) validateLaunchProfiles([profile], profile.id);
  return { agentSlug: profile?.agentSlug ?? slug, profile };
}

export function launchProfileKey(profile?: CollaborationLaunchProfile): string {
  return profile ? JSON.stringify([profile.id, profile.agentSlug, profile.command]) : '';
}
