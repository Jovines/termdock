// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffFileNavigator } from './DiffFileNavigator';

const file = {
  key: '/repo/docs/guide.md',
  path: 'docs/guide.md',
  absolutePath: '/repo/docs/guide.md',
  displayName: 'guide.md',
  displayDir: 'docs',
  status: 'modified',
};

function renderNavigator(onSelectFile: () => void) {
  return render(
    <div className="termdock-native-select">
      <DiffFileNavigator
        groups={[{ key: '/repo', root: '/repo', label: 'repo', files: [file] }]}
        selectedKey={null}
        mode="list"
        onSelectFile={onSelectFile}
        collapsedDirectoryKeys={new Set()}
        onToggleDirectory={() => undefined}
        renderLeading={() => null}
      />
    </div>,
  );
}

describe('DiffFileNavigator text selection', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not switch files when a text selection is active', () => {
    const onSelectFile = vi.fn();
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => 'guide.md',
    } as Selection);
    renderNavigator(onSelectFile);

    fireEvent.click(screen.getByRole('button'));

    expect(onSelectFile).not.toHaveBeenCalled();
  });

  it('still switches files on a normal click', () => {
    const onSelectFile = vi.fn();
    renderNavigator(onSelectFile);

    fireEvent.click(screen.getByRole('button'));

    expect(onSelectFile).toHaveBeenCalledWith(file);
  });

  it('exposes directory paths to a trailing action renderer in tree mode', () => {
    const renderDirectoryTrailing = vi.fn(() => <button type="button">Reference directory</button>);
    const group = { key: '/repo', root: '/repo', label: 'repo', files: [file] };
    render(
      <DiffFileNavigator
        groups={[group]}
        selectedKey={null}
        mode="tree"
        onSelectFile={() => undefined}
        collapsedDirectoryKeys={new Set()}
        onToggleDirectory={() => undefined}
        renderLeading={() => null}
        renderDirectoryTrailing={renderDirectoryTrailing}
      />,
    );

    expect(screen.getByRole('button', { name: 'Reference directory' })).toBeTruthy();
    expect(renderDirectoryTrailing).toHaveBeenCalledWith('docs', group);
  });
});
