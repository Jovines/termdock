import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredBranchAuditRecord, StoredChangeAuditRecord } from './changeAuditStore.js';

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string;

async function loadStore() {
  vi.resetModules();
  return import('./changeAuditStore.js');
}

describe('changeAuditStore section records', () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-audit-store-'));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it('keeps hunk-level and section-level change audit records distinct', async () => {
    const store = await loadStore();

    const result = store.injectChangeAudit({
      workspaceRoot: '/workspace',
      repoRoot: '/workspace/repo',
      generatedBy: 'test',
      records: [
        {
          repoRoot: '/workspace/repo',
          filePath: 'src/App.tsx',
          hunkHeader: '@@ -1,5 +1,6 @@',
          hunkIndex: 0,
          fingerprint: 'hunk-fingerprint',
          explanation: 'whole hunk explanation',
        },
        {
          repoRoot: '/workspace/repo',
          filePath: 'src/App.tsx',
          hunkHeader: '@@ -1,5 +1,6 @@',
          hunkIndex: 0,
          sectionIndex: 1,
          sectionFingerprint: 'section-fingerprint',
          fingerprint: 'hunk-fingerprint',
          explanation: 'section explanation',
        },
      ],
    });

    expect(result.inserted).toBe(2);
    expect(result.total).toBe(2);
    expect(result.records.map((record: StoredChangeAuditRecord) => record.id)).toHaveLength(new Set(result.records.map((record: StoredChangeAuditRecord) => record.id)).size);

    const listed = store.listChangeAuditRecords({ repoRoot: '/workspace/repo' }).records;
    expect(listed).toHaveLength(2);
    expect(listed.find((record: StoredChangeAuditRecord) => record.sectionIndex === 1)?.sectionFingerprint).toBe('section-fingerprint');
    expect(listed.find((record: StoredChangeAuditRecord) => record.sectionIndex === null)?.explanation).toBe('whole hunk explanation');
  });

  it('persists branch audit section metadata and gives each section its own id', async () => {
    const store = await loadStore();

    const result = store.injectBranchAudit({
      workspaceRoot: '/workspace',
      repoRoot: '/workspace/repo',
      baseRef: 'origin/main',
      branchName: 'feature/diff',
      headRef: 'HEAD',
      diffFingerprint: 'branch-diff',
      generatedBy: 'test',
      records: [
        {
          filePath: 'src/App.tsx',
          hunkHeader: '@@ -10,8 +10,10 @@',
          hunkIndex: 0,
          fingerprint: 'branch-hunk',
          explanation: 'branch hunk explanation',
        },
        {
          filePath: 'src/App.tsx',
          hunkHeader: '@@ -10,8 +10,10 @@',
          hunkIndex: 0,
          sectionIndex: 2,
          sectionFingerprint: 'branch-section',
          fingerprint: 'branch-hunk',
          explanation: 'branch section explanation',
        },
      ],
    });

    expect(result.inserted).toBe(2);
    expect(result.records.map((record: StoredBranchAuditRecord) => record.id)).toHaveLength(new Set(result.records.map((record: StoredBranchAuditRecord) => record.id)).size);

    const listed = store.listBranchAuditRecords({
      repoRoot: '/workspace/repo',
      baseRef: 'origin/main',
      branchName: 'feature/diff',
    }).records;
    expect(listed).toHaveLength(2);
    expect(listed.find((record: StoredBranchAuditRecord) => record.sectionIndex === 2)?.sectionFingerprint).toBe('branch-section');
    expect(listed.find((record: StoredBranchAuditRecord) => record.sectionIndex === null)?.explanation).toBe('branch hunk explanation');
  });
});
