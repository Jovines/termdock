// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeWalkthrough } from '../../terminal/api';
import { ChangeWalkthroughPanel } from './ChangeWalkthroughPanel';

vi.mock('../../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const walkthrough: ChangeWalkthrough = {
  version: 1,
  id: 'review-flow',
  repoRoot: '/repo',
  workspaceRoot: '/repo',
  title: 'Review flow',
  summary: 'Follow the change through the implementation.',
  generatedBy: 'test',
  injectedAt: 1,
  highlights: [],
  nodes: [
    { id: 'source', title: 'Source', business: 'Read input.', anchor: { repoRoot: '/repo', filePath: 'source.ts', hunkIndex: 0 } },
    { id: 'process', title: 'Process', business: 'Transform input.' },
    { id: 'output', title: 'Output', business: 'Render output.', anchor: { repoRoot: '/repo', filePath: 'output.ts', hunkIndex: 0 } },
  ],
  edges: [
    { from: 'source', to: 'process', label: 'parse' },
    { from: 'process', to: 'output', label: 'render' },
  ],
  sections: [],
  risks: [],
  checks: [],
};

describe('ChangeWalkthroughPanel review navigation', () => {
  afterEach(cleanup);

  it('lets an unanchored process node focus its connected flow', () => {
    const { container } = render(
      <ChangeWalkthroughPanel walkthroughs={[walkthrough]} repoRoot="/repo" onNavigate={() => undefined} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Process/ }));

    const paths = Array.from(container.querySelectorAll<SVGPathElement>('[data-dag-edge]'));
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => path.parentElement?.getAttribute('style')?.includes('opacity: 1'))).toBe(true);
  });

  it('moves through anchored changes from the full-screen controls', () => {
    const onNavigate = vi.fn();
    render(
      <ChangeWalkthroughPanel
        walkthroughs={[walkthrough]}
        repoRoot="/repo"
        onNavigate={onNavigate}
        fullscreen
        onToggleFullscreen={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next change' }));
    expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: 'source.ts' }));

    fireEvent.click(screen.getByRole('button', { name: 'Next change' }));
    expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: 'output.ts' }));
    expect(screen.getByText('2/2')).toBeTruthy();
  });
});
