import { describe, expect, it } from 'vitest';
import { detectApprovalDialog, extractPasteMarkerNumbers, hasNewPasteMarker } from './collaborationTmuxDelivery.js';

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
