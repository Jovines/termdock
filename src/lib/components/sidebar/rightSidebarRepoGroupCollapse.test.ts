// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { collectKnownGitRepoRoots, showsGitRepoGroupHeader } from './RightSidebar';

// `buildDiffNavigatorGroups` and `orderedChangedFilesForDiff` both consult this
// predicate before honoring the persisted collapsed set, because a collapsed
// group with no header renders neither its files nor a way to expand it.
describe('repo group collapse follows header visibility', () => {
  it('shows a header while several repos are listed', () => {
    expect(showsGitRepoGroupHeader({ activeGitRepoRoot: null, groupCount: 2, label: 'lib', rootName: 'app' })).toBe(true);
  });

  it('hides every header once one repo is drilled into', () => {
    expect(showsGitRepoGroupHeader({ activeGitRepoRoot: '/work/app', groupCount: 2, label: 'lib', rootName: 'app' })).toBe(false);
  });

  // Regression: the collapsed set is keyed by absolute root and persisted, so a
  // group collapsed while headers were visible stayed collapsed after the
  // multi-repo scan was switched back off. The pane then showed change counts
  // above a list that rendered nothing at all — no header left to expand.
  it('hides the header of the only group when it owns the workspace name', () => {
    expect(showsGitRepoGroupHeader({ activeGitRepoRoot: null, groupCount: 1, label: 'app', rootName: 'app' })).toBe(false);
  });

  it('keeps the header when the workspace sits inside a larger repo', () => {
    expect(showsGitRepoGroupHeader({ activeGitRepoRoot: null, groupCount: 1, label: 'monorepo', rootName: 'app' })).toBe(true);
  });
});

// The self-healing effect that drops an active root when its repo leaves the
// workspace validates against this set. A deferred placeholder lists in
// `repoFilters` with `context: null`, so it is absent from the loaded-context
// options the git actions use — reading the active root off those dropped the
// selection the moment a placeholder chip was clicked.
describe('known repo roots include unread placeholders', () => {
  it('counts a deferred placeholder listed only in the filters', () => {
    const roots = collectKnownGitRepoRoots(
      [{ root: '/work/app' }, { root: '/work/app/vendor/lib', deferred: true, context: null }],
      [{ root: '/work/app', context: { available: true } }],
    );
    expect(roots.has('/work/app/vendor/lib')).toBe(true);
    expect(roots.has('/work/app')).toBe(true);
    expect(roots.size).toBe(2);
  });

  it('counts a repo that only the repository list carries', () => {
    expect(collectKnownGitRepoRoots([], [{ root: '/work/app' }]).has('/work/app')).toBe(true);
  });
});
