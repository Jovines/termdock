import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { CollaborationError } from './collaborationProtocol.js';
export interface ResumeConfigurationSnapshot {
  agent_slug: string; cwd: string;
  profile: { executable: string; argv: string[]; resumeArgv: string[] };
}
const fail = (code: string, message: string): never => { throw new CollaborationError(code, message, 409); };

/** Fingerprint only the launcher file and recovery semantics. This does not
 * claim to fingerprint its dependencies, private Agent binaries, or history. */
export async function resumeConfigurationFingerprint<T extends ResumeConfigurationSnapshot>(record: T, adapter: { resumeConfiguration?(record: T): Promise<unknown> }): Promise<string> {
  const semantics = await adapter.resumeConfiguration?.(record);
  if (semantics === undefined) fail('EXACT_RESUME_UNSUPPORTED', 'Adapter does not expose exact recovery semantics');
  try {
    const executable = fs.realpathSync(record.profile.executable);
    const before = fs.statSync(executable);
    if (!before.isFile() || before.size > 512 * 1024 * 1024) fail('LAUNCHER_UNAVAILABLE', 'Launcher must be a regular file within the fingerprint size limit');
    fs.accessSync(executable, fs.constants.X_OK);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(executable)) hash.update(chunk);
    const after = fs.statSync(executable);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || fs.realpathSync(record.profile.executable) !== executable) fail('RESUME_CONFIGURATION_CHANGED', 'Launcher changed while fingerprinting');
    return createHash('sha256').update(JSON.stringify({ version: 1, executable, content: hash.digest('hex'),
      agent: record.agent_slug, argv: record.profile.argv, resumeArgv: record.profile.resumeArgv, cwd: record.cwd, semantics })).digest('hex');
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    return fail('LAUNCHER_UNAVAILABLE', 'Recovery launcher could not be read and verified');
  }
}
