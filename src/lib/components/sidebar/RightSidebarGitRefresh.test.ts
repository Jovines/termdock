import { describe, expect, it } from 'vitest';
import type { GitBundleResponse, GitChangedFile, GitRepositoryBundle } from '../../terminal/api';
import { replaceGitRepositorySnapshot } from './RightSidebar';

function changedFile(repoRoot: string, path: string): GitChangedFile {
  return {
    path,
    absolutePath: `${repoRoot}/${path}`,
    repoRoot,
    repoRelativeRoot: repoRoot === '/workspace' ? '.' : 'packages/child',
    repoName: repoRoot === '/workspace' ? 'workspace' : 'packages/child',
    status: 'modified',
    staged: false,
    unstaged: true,
    untracked: false,
    tracked: true,
    canStage: true,
    canUnstage: false,
    canStash: true,
    canRestoreWorktree: true,
  };
}

function repository(root: string, files: GitChangedFile[]): GitRepositoryBundle {
  const nested = root !== '/workspace';
  return {
    id: root,
    root,
    displayRoot: root,
    relativeRoot: nested ? 'packages/child' : '.',
    name: nested ? 'packages/child' : 'workspace',
    depth: nested ? 2 : 0,
    nested,
    available: true,
    files,
    context: { available: true, root, branch: nested ? 'child-main' : 'main' },
  };
}

describe('replaceGitRepositorySnapshot', () => {
  it('replaces only the refreshed child repository and preserves its workspace metadata', () => {
    const parentFile = changedFile('/workspace', 'README.md');
    const staleChildFile = changedFile('/workspace/packages/child', 'old.ts');
    const freshChildFile = changedFile('/workspace/packages/child', 'new.ts');
    const parentRepo = repository('/workspace', [parentFile]);
    const childRepo = repository('/workspace/packages/child', [staleChildFile]);
    const refreshedBundle: GitBundleResponse = {
      available: true,
      files: [{ ...freshChildFile, repoRelativeRoot: '.', repoName: 'child' }],
      context: { available: true, root: childRepo.root, branch: 'feature' },
      repositories: [{
        ...childRepo,
        relativeRoot: '.',
        name: 'child',
        depth: 0,
        nested: false,
        files: [{ ...freshChildFile, repoRelativeRoot: '.', repoName: 'child' }],
        context: { available: true, root: childRepo.root, branch: 'feature' },
      }],
    };

    const result = replaceGitRepositorySnapshot(
      [parentFile, staleChildFile],
      [parentRepo, childRepo],
      refreshedBundle,
      childRepo.root,
      parentRepo.root,
    );

    expect(result.files.map((file) => file.absolutePath)).toEqual([
      parentFile.absolutePath,
      freshChildFile.absolutePath,
    ]);
    expect(result.repositories[0]).toBe(parentRepo);
    expect(result.repositories[1]).toMatchObject({
      root: childRepo.root,
      relativeRoot: 'packages/child',
      name: 'packages/child',
      depth: 2,
      nested: true,
      files: [{ path: 'new.ts', repoRelativeRoot: 'packages/child', repoName: 'packages/child' }],
      context: { branch: 'feature' },
    });
    expect(result.repoFilters.map(({ root, count }) => ({ root, count }))).toEqual([
      { root: parentRepo.root, count: 1 },
      { root: childRepo.root, count: 1 },
    ]);
  });
});
