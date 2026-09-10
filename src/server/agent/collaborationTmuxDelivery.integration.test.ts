import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { captureTmuxPaneText, recoverStuckPaste, sendTmuxPaneKey, writeCollaborationTmuxPane } from './collaborationTmuxDelivery.js';

const execFileAsync = promisify(execFile);

describe.skipIf(process.platform === 'win32')('collaboration tmux transport', () => {
  it('delivers to the pinned pane without a browser/client, even when another pane is active', async () => {
    const socket = `td-collab-${process.pid}-${Date.now()}`;
    const run = async (args: string[]) => (await execFileAsync('tmux', ['-L', socket, ...args], { timeout: 5_000 })).stdout;
    try {
      await run(['new-session', '-d', '-s', 'peer', 'cat']);
      const identity = (await run(['display-message', '-p', '-t', 'peer', '#{pid}:#{session_id}:#{pane_id}:#{pane_pid}'])).trim().split(':');
      const pane = { serverPid: Number(identity[0]), sessionId: identity[1]!, paneId: identity[2]!, panePid: Number(identity[3]),
        agentSlug: 'test-consumer', nativeSessionId: null };
      const other = (await run(['split-window', '-t', pane.paneId, '-P', '-F', '#{pane_id}', 'cat'])).trim();
      expect((await run(['display-message', '-p', '-t', 'peer', '#{pane_id}'])).trim()).toBe(other);
      expect((await run(['list-clients', '-t', '=peer'])).trim()).toBe('');
      await writeCollaborationTmuxPane(run, pane, 'collab-message-unique\nsecond-line');
      let target = '';
      for (let attempt = 0; attempt < 30; attempt++) {
        target = await run(['capture-pane', '-p', '-t', pane.paneId]);
        if (target.includes('second-line')) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(target).toContain('collab-message-unique');
      expect(target).toContain('second-line');
      expect(await run(['capture-pane', '-p', '-t', other])).not.toContain('collab-message-unique');
      expect((await run(['display-message', '-p', '-t', 'peer', '#{pane_id}'])).trim()).toBe(other);
      await expect(writeCollaborationTmuxPane(run, { ...pane, panePid: pane.panePid + 1 }, 'must-not-deliver')).rejects.toThrow('TMUX_PANE_CHANGED');
      expect(await run(['capture-pane', '-p', '-t', pane.paneId])).not.toContain('must-not-deliver');
    } finally { await run(['kill-server']).catch(() => undefined); }
  }, 15_000);

  it('reaches the app through an unscrolled copy-mode pane without disturbing the user view', async () => {
    const socket = `td-collab-cm-${process.pid}-${Date.now()}`;
    const run = async (args: string[]) => (await execFileAsync('tmux', ['-L', socket, ...args], { timeout: 5_000 })).stdout;
    try {
      await run(['new-session', '-d', '-s', 'peer', 'sh -c "seq 1 300; stty raw -echo; cat > /tmp/td-collab-cm.out"']);
      const identity = (await run(['display-message', '-p', '-t', 'peer', '#{pid}:#{session_id}:#{pane_id}:#{pane_pid}'])).trim().split(':');
      const pane = { serverPid: Number(identity[0]), sessionId: identity[1]!, paneId: identity[2]!, panePid: Number(identity[3]),
        agentSlug: 'test-consumer', nativeSessionId: null };
      // Wait for the reader to own the foreground pty (seq finished).
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await run(['display-message', '-p', '-t', pane.paneId, '#{pane_current_command}'])).trim() === 'cat') break;
        await new Promise((done) => setTimeout(done, 20));
      }
      await run(['copy-mode', '-t', pane.paneId, '-u']);
      await run(['send-keys', '-t', pane.paneId, '-X', 'scroll-up']);
      const before = (await run(['display-message', '-p', '-t', pane.paneId, '#{scroll_position}'])).trim();
      expect(before).not.toBe('0'); // the user really is scrolled up

      await writeCollaborationTmuxPane(run, pane, 'COPYMODE-REACHES-APP');

      expect((await run(['display-message', '-p', '-t', pane.paneId, '#{pane_in_mode}'])).trim()).toBe('1');
      expect((await run(['display-message', '-p', '-t', pane.paneId, '#{scroll_position}'])).trim()).toBe(before);
      expect(await run(['list-buffers'])).not.toContain(`termdock-collab-${process.pid}`);
      const delivered = await (async () => { try { return (await execFileAsync('sh', ['-c', 'sleep 0.4; cat /tmp/td-collab-cm.out'])).stdout; } catch { return ''; } })();
      expect(delivered).toContain('COPYMODE-REACHES-APP');
      // Named keys stay out of the mode: Enter here would copy-and-cancel.
      await expect(sendTmuxPaneKey(run, pane, 'enter')).rejects.toThrow('TMUX_PANE_IN_MODE');
      expect((await run(['display-message', '-p', '-t', pane.paneId, '#{scroll_position}'])).trim()).toBe(before);
    } finally { await run(['kill-server']).catch(() => undefined); }
  }, 15_000);
});
