import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
type Run = (file: string, args: string[]) => Promise<string>;
const runCommand: Run = async (file, args) => (await execFileAsync(file, args, {
  timeout: 2_000, maxBuffer: 16 * 1024,
})).stdout;

function validSession(value: string): boolean {
  return !!value && value.length <= 128 && !/[\r\n\t]/.test(value);
}

export async function detectLocalSessionContext(
  env: NodeJS.ProcessEnv = process.env, run: Run = runCommand,
) {
  const backendSessionId = env.TERMDOCK_BACKEND_SESSION_ID?.trim() || null;
  const tmux = env.TMUX_BIN || 'tmux';
  const paneId = env.TMUX_PANE?.trim();
  let tmuxSessionName: string | null = null;
  if (/^%\d+$/.test(paneId ?? '')) {
    try {
      const detected = (await run(tmux, ['display-message', '-p', '-t', paneId!, '#S'])).trim();
      if (validSession(detected)) tmuxSessionName = detected;
    } catch { /* Preserve the backend identity if tmux is unavailable. */ }
  }
  return { backendSessionId, tmuxSessionName };
}

/** Explicit collaboration identity overrides execution-location hints entirely.
 * Never send fallback identities alongside it: an invalid id must fail closed. */
export async function resolveLocalCollaborationContext(
  session: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  detect = () => detectLocalSessionContext(env),
): Promise<Record<string, string>> {
  const sessionId = (session ?? env.TERMDOCK_COLLAB_SESSION_ID)?.trim();
  if (sessionId) return { sessionId };
  const context = await detect();
  return Object.fromEntries(Object.entries(context).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
