/** Repaint through the existing PTY stream, preserving output order and modes.
 * capture-pane is an observation of cells, not a terminal parser checkpoint.
 * It must never be spliced into ongoing incremental output after a resize.
 */
export async function redrawTmuxClient(
  runTmux: (args: string[]) => Promise<string>,
  sessionName: string,
  clientPid: number | undefined,
): Promise<void> {
  if (typeof clientPid !== 'number') return;
  const clients = await runTmux([
    'list-clients', '-t', sessionName, '-F', '#{client_pid} #{client_tty}',
  ]);
  const client = clients.split('\n').map(line => line.trim().split(/\s+/))
    .find(([pid]) => pid === String(clientPid));
  // Never fall back to another attached client if this one exited.
  if (client?.[1]) await runTmux(['refresh-client', '-t', client[1]]);
}
