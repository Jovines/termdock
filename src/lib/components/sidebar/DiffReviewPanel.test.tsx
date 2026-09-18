// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./DiffReview', () => ({
  ChangeBadge: () => null,
  DiffReview: ({ renderListHeader }: { renderListHeader?: (modeToggle: React.ReactNode) => React.ReactNode }) => (
    <div>{renderListHeader?.(null)}</div>
  ),
}));

vi.mock('./ChangeWalkthroughPanel', () => ({ ChangeWalkthroughPanel: () => null }));

import { UniversalDiffReview } from './DiffReviewPanel';

const baseProps = {
  items: [],
  selectedKey: null,
  onSelect: () => undefined,
  emptyText: 'empty',
  headerTitle: 'View diff',
  wrap: true,
  activePane: true,
  mobile: false,
};

describe('UniversalDiffReview refresh entry', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a refresh button that invokes onRefresh', () => {
    const onRefresh = vi.fn();
    render(
      <UniversalDiffReview
        {...baseProps}
        onRefresh={onRefresh}
        refreshLabel="Refresh diff"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diff' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables the refresh button while refreshing', () => {
    render(
      <UniversalDiffReview
        {...baseProps}
        onRefresh={() => undefined}
        refreshing
        refreshLabel="Refresh diff"
      />,
    );
    expect((screen.getByRole('button', { name: 'Refresh diff' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('omits the refresh button when no handler is provided', () => {
    render(<UniversalDiffReview {...baseProps} />);
    expect(screen.queryByRole('button', { name: 'Refresh diff' })).toBeNull();
  });
});
