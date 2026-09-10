import { describe, expect, it, vi } from 'vitest';
import { detectApprovalDialog, extractPasteMarkerNumbers, hasNewPasteMarker, sendTmuxPaneKey, writeCollaborationTmuxPane } from './collaborationTmuxDelivery.js';

const PANE = { serverPid: 1, sessionId: '$0', paneId: '%0', panePid: 2, agentSlug: '', nativeSessionId: null };
const IDENTITY = '1:$0:%0:2';

/** Split a `\;`-joined tmux invocation into its individual commands, each of
 *  which the server runs in order. */
function splitCommands(args: string[]): string[][] {
  const commands: string[][] = [[]];
  for (const arg of args) {
    if (arg === ';') commands.push([]);
    else commands.at(-1)!.push(arg);
  }
  return commands;
}

/** Fake tmux runner: answers the identity probe, records every command. The
 *  stdin channel records the payload separately — it is where delivery hands
 *  the body over, and it must never appear in the argv it is chained with. */
function recorder(overrides: Record<string, string> = {}) {
  const calls: string[][] = [];
  const bodies: string[] = [];
  const run = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'display-message' && args.at(-1)!.includes('pid')) return IDENTITY;
    return overrides[args[0]!] ?? '';
  });
  const stdin = vi.fn(async (args: string[], input: string) => {
    calls.push(args);
    bodies.push(input);
    return '';
  });
  return { run, stdin, calls, bodies };
}

describe('approval dialog screen detection', () => {
  it('recognizes interactive permission prompts without pressing keys blindly', () => {
    expect(detectApprovalDialog('This command requires approval\n1. Yes\n2. Yes, and don\'t ask again\n3. No')).toBe(true);
    expect(detectApprovalDialog('Tool is not allowed. Do you want to proceed?')).toBe(true);
    expect(detectApprovalDialog('是否允许执行该命令?\n1. 是\n2. 否')).toBe(true);
    expect(detectApprovalDialog('需要批准后才能继续:rm -rf /')).toBe(true);
  });

  it('ignores plain screens, transcripts and input boxes', () => {
    expect(detectApprovalDialog('$ ls\nDocuments  Projects')).toBe(false);
    expect(detectApprovalDialog('[Pasted text #1 +13 lines]')).toBe(false);
    expect(detectApprovalDialog('❯ td collab status')).toBe(false);
  });
});

describe('paste-marker diffing', () => {
  it('extracts the session-unique sequence numbers of collapsed paste markers', () => {
    expect(extractPasteMarkerNumbers('[Pasted text #2 +31 lines]')).toEqual(new Set([2]));
    expect(extractPasteMarkerNumbers('')).toEqual(new Set());
  });

  it('detects a marker that appeared since the write-time baseline', () => {
    expect(hasNewPasteMarker(
      'header\n[Pasted text #3 +8 lines]\n❯ ',
      'header\n[Pasted text #1 +13 lines]\n[Pasted text #2 +5 lines]\n❯ ',
    )).toBe(true);
  });

  it('ignores pre-existing stale markers and foreign drafts', () => {
    // Same markers before and after (no new one from this delivery).
    expect(hasNewPasteMarker(
      '[Pasted text #1 +13 lines]\n❯ ',
      '[Pasted text #1 +13 lines]\n❯ ',
    )).toBe(false);
    // Markers are only on screen after this delivery landed, but the
    // diff is against a baseline that already showed them.
    expect(hasNewPasteMarker(
      '[Pasted text #2 +5 lines]',
      '[Pasted text #1 +13 lines]\n[Pasted text #2 +5 lines]',
    )).toBe(false);
    // Empty baseline with markers after: every marker is new.
    expect(hasNewPasteMarker('[Pasted text #1 +13 lines]', '')).toBe(true);
  });
});

describe('buffer-channel delivery', () => {
  it('loads the body on stdin and pipes it once through load-buffer + paste-buffer', async () => {
    const { run, calls, stdin, bodies } = recorder();
    await writeCollaborationTmuxPane(run, PANE, 'collab-message', stdin);
    expect(calls.map((args) => args[0])).toEqual(['display-message', 'load-buffer', 'delete-buffer']);
    // The joined invocation, split into the commands tmux will run in order.
    const commands = splitCommands(calls[1]!);
    const name = commands[0]![2]!;
    expect(name).toMatch(/^termdock-collab-\d+-\d+$/);
    expect(commands).toEqual([
      ['load-buffer', '-b', name, '-'],
      // -p lets tmux add the bracket pair only for apps that asked for it.
      ['paste-buffer', '-p', '-r', '-d', '-b', name, '-t', '%0'],
      // The submit CR travels the same mode-proof channel, but as a bare paste
      // so it stays a key instead of a literal inside the paste block.
      ['set-buffer', '-b', name, '--', '\r'],
      ['paste-buffer', '-d', '-b', name, '-t', '%0'],
    ]);
    // The body rode stdin, never the argv chain.
    expect(bodies).toEqual(['collab-message']);
    expect(calls[1]).not.toContain('collab-message');
    expect(calls.at(-1)).toEqual(['delete-buffer', '-b', name]);
  });

  it('carries no ESC and no LF in the buffer, so tmux 3.7+ has nothing to rewrite', async () => {
    const { run, stdin, bodies } = recorder();
    const bodyFor = async (prompt: string) => {
      bodies.length = 0;
      await writeCollaborationTmuxPane(run, PANE, prompt, stdin);
      return bodies[0]!;
    };
    const multiline = await bodyFor('first\nsecond\r\nthird');
    expect(multiline).toBe('first\rsecond\rthird');
    expect(multiline).not.toContain('\x1b');
    expect(multiline).not.toContain('\n');
    // The normalizer's ESC substitution is what keeps the body escape-free.
    expect(await bodyFor('safe\x1b[201~injected')).toBe('safe␛[201~injected');
  });

  it('no longer depends on the body being safe argv', async () => {
    // These payloads broke the previous set-buffer form outright: `;` split
    // the command even after `--` ("no data specified"), and backslashes hit
    // version-dependent unescaping. On stdin they are just bytes.
    const { run, stdin, bodies } = recorder();
    for (const payload of [';', '\\;', 'a\\b', '--', '\\']) {
      await writeCollaborationTmuxPane(run, PANE, payload, stdin);
      expect(bodies.at(-1)).toBe(payload);
    }
  });

  it('still sweeps the buffer when the paste fails', async () => {
    const { run, stdin, calls } = recorder();
    stdin.mockImplementation(async (args: string[]) => {
      calls.push(args);
      throw new Error('paste-buffer failed');
    });
    await expect(writeCollaborationTmuxPane(run, PANE, 'x', stdin)).rejects.toThrow('paste-buffer failed');
    expect(calls.map((args) => args[0])).toContain('delete-buffer');
  });

  it('gives concurrent deliveries distinct buffers', async () => {
    const { run, stdin, calls } = recorder();
    await writeCollaborationTmuxPane(run, PANE, 'one', stdin);
    await writeCollaborationTmuxPane(run, PANE, 'two', stdin);
    const names = calls.filter((args) => args[0] === 'load-buffer').map((args) => args[2]!);
    expect(new Set(names).size).toBe(2);
  });
});

describe('named keys vs pane modes', () => {
  it('sends the key when the pane is not in a mode', async () => {
    const { run, calls } = recorder({ 'display-message': '0' });
    await sendTmuxPaneKey(run, PANE, 'enter');
    expect(calls.at(-1)).toEqual(['send-keys', '-t', '%0', 'Enter']);
  });

  it('refuses while the pane is in copy-mode — Enter there exits the user scroll', async () => {
    const { run, calls } = recorder();
    run.mockImplementation(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'display-message' && args.at(-1)!.includes('pid')) return IDENTITY;
      if (args[0] === 'display-message') return '1';
      return '';
    });
    await expect(sendTmuxPaneKey(run, PANE, 'enter')).rejects.toThrow('TMUX_PANE_IN_MODE');
    expect(calls.some((args) => args[0] === 'send-keys')).toBe(false);
  });
});
