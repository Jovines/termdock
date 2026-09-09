import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { DeviceProfile } from './deviceProfile.js';

/** Separate from user-chosen names, so refreshes never overwrite a rename. */
export class DeviceProfiles {
  constructor(private file: string) {}
  list(): Record<string, DeviceProfile> {
    try { return JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  set(subjectId: string, value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const profile: DeviceProfile = {};
    for (const key of ['system', 'client', 'model', 'arch', 'cpu', 'hostname', 'mode', 'route'] as const) {
      const item = (value as Record<string, unknown>)[key];
      if (typeof item === 'string' && item.trim() && item.length <= 240 && !/[\x00-\x1f\x7f]/.test(item)) profile[key] = item.trim();
    }
    const profiles = this.list();
    profiles[subjectId] = { ...profile, firstSeenAt: profiles[subjectId]?.firstSeenAt ?? Date.now(), lastSeenAt: Date.now() };
    writeFileSync(`${this.file}.tmp`, JSON.stringify(profiles), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
