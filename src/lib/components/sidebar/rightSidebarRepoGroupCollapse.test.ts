// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { showsGitRepoGroupHeader } from './RightSidebar';

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
