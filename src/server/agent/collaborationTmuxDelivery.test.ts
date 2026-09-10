import { describe, expect, it, vi } from 'vitest';
import { detectApprovalDialog, extractPasteMarkerNumbers, hasNewPasteMarker, sendTmuxPaneKey, writeCollaborationTmuxPane } from './collaborationTmuxDelivery.js';

const PANE = { serverPid: 1, sessionId: '$0', paneId: '%0', panePid: 2, agentSlug: '', nativeSessionId: null };
const IDENTITY = '1:$0:%0:2';

/** Fake tmux runner: answers the identity probe, records every command. */
function recorder(overrides: Record<string, string> = {}) {
  const calls: string[][] = [];
  const run = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'display-message' && args.at(-1)!.includes('pid')) return IDENTITY;
    return overrides[args[0]!] ?? '';
  });
  return { run, calls };
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
  it('writes through set-buffer + paste-buffer and sweeps the buffer afterwards', async () => {
    const { run, calls } = recorder();
    await writeCollaborationTmuxPane(run, PANE, 'collab-message');
    expect(calls.map((args) => args[0])).toEqual(['display-message', 'set-buffer', 'paste-buffer', 'set-buffer', 'paste-buffer', 'delete-buffer']);
    const setBuffer = calls[1]!;
    expect(setBuffer[1]).toBe('-b');
    expect(setBuffer[2]).toMatch(/^termdock-collab-\d+-\d+$/);
    expect(setBuffer.at(-1)).toBe('collab-message');
    // -p lets tmux add the bracket pair only for apps that asked for it.
    expect(calls[2]).toEqual(['paste-buffer', '-p', '-r', '-d', '-b', setBuffer[2], '-t', '%0']);
    // The submit CR travels the same mode-proof channel, but as a bare paste
    // so it stays a key instead of a literal inside the paste block.
    expect(calls[3]).toEqual(['set-buffer', '-b', setBuffer[2], '--', '\r']);
    expect(calls[4]).toEqual(['paste-buffer', '-d', '-b', setBuffer[2], '-t', '%0']);
    expect(calls[5]).toEqual(['delete-buffer', '-b', setBuffer[2]]);
  });

  it('carries no ESC and no LF in the buffer, so tmux 3.7+ has nothing to rewrite', async () => {
    const { run, calls } = recorder();
    // Each delivery sets the text body and then the bare submit CR; the body
    // is the second-to-last set-buffer.
    const bodyFor = async (prompt: string) => {
      await writeCollaborationTmuxPane(run, PANE, prompt);
      return calls.filter((args) => args[0] === 'set-buffer').at(-2)!.at(-1)!;
    };
    const multiline = await bodyFor('first\nsecond\r\nthird');
    expect(multiline).toBe('first\rsecond\rthird');
    expect(multiline).not.toContain('\x1b');
    expect(multiline).not.toContain('\n');
    // The normalizer's ESC substitution is what keeps the body escape-free.
    expect(await bodyFor('safe\x1b[201~injected')).toBe('safe␛[201~injected');
  });

  it('still sweeps the buffer when the paste fails', async () => {
    const { run, calls } = recorder();
    run.mockImplementation(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'display-message' && args.at(-1)!.includes('pid')) return IDENTITY;
      if (args[0] === 'paste-buffer') throw new Error('paste-buffer failed');
      return '';
    });
    await expect(writeCollaborationTmuxPane(run, PANE, 'x')).rejects.toThrow('paste-buffer failed');
    expect(calls.map((args) => args[0])).toContain('delete-buffer');
  });

  it('gives concurrent deliveries distinct buffers', async () => {
    const { run, calls } = recorder();
    await writeCollaborationTmuxPane(run, PANE, 'one');
    await writeCollaborationTmuxPane(run, PANE, 'two');
    const names = calls.filter((args) => args[0] === 'set-buffer').map((args) => args[2]);
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
