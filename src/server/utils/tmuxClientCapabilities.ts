import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Probe the selected client without starting or connecting to a tmux server. */
export async function supportsTmuxClientFeatures(binary: string): Promise<boolean> {
  try {
    // -T and attach/refresh-client -f ignore-size were introduced in tmux 3.2.
    // Keep -T before -V: old clients must parse it before exiting for -V.
    await execFileAsync(binary, ['-T', 'RGB,sync', '-V'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function buildTmuxAttachArgs(sessionName: string, supportsFeatures: boolean): string[] {
  return [
    ...(supportsFeatures ? ['-T', 'RGB,sync'] : []),
    'attach-session', '-t', sessionName,
  ];
}
