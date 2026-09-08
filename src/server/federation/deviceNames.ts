import { readFileSync, writeFileSync, renameSync } from 'node:fs';

/** Display metadata only; never participates in authorization. */
export class DeviceNames {
  constructor(private file: string) {}
  list(): Record<string, string> {
    try { return Object.fromEntries(Object.entries(JSON.parse(readFileSync(this.file, 'utf8'))).filter(([, name]) => typeof name === 'string')) as Record<string, string>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  set(subjectId: string, name: unknown, onlyIfMissing: boolean): string {
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('INVALID_DEVICE_NAME');
    const names = this.list();
    if (onlyIfMissing && Object.hasOwn(names, subjectId)) return names[subjectId];
    const next = Object.fromEntries([...Object.entries(names).filter(([id]) => id !== subjectId), [subjectId, name.trim()]]);
    writeFileSync(`${this.file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    return name.trim();
  }
}
