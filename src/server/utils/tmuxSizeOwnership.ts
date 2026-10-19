/** Only an explicitly selected display may influence tmux's window size.
 * Terminal replies and focus events also count as activity for window-size
 * latest, so leaving every display eligible makes idle viewers fight.
 */
export async function claimTmuxSize(
  run: (args: string[]) => Promise<string>,
  session: string,
  pid: number | undefined,
  displayPids: ReadonlySet<number>,
): Promise<void> {
  if (pid === undefined) return;
  const clients = (await run(['list-clients', '-t', session, '-F', '#{client_pid} #{client_tty}']))
    .trim().split('\n').map(line => line.trim().split(/\s+/));
  const target = clients.find(([value]) => value === String(pid));
  if (!target?.[1]) return;
  const commands: string[][] = clients
    .filter(([value, tty]) => tty && value !== String(pid) && displayPids.has(Number(value)))
    .map(([, tty]) => ['refresh-client', '-t', tty, '-f', 'ignore-size']);
  commands.push(['refresh-client', '-t', target[1], '-f', '!ignore-size']);
  await run(commands.flatMap((command, index) => index ? [';', ...command] : command));
}
