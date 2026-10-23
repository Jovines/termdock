// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useInitialRestoreGate } from './useInitialRestoreGate';
afterEach(cleanup);
function Frame({ ready, workspace }: { ready: boolean; workspace: boolean }) {
  const block = useInitialRestoreGate(ready, workspace);
  return <>{block && <div role="status">正在恢复会话…</div>}{workspace && <section>待办清单</section>}</>;
}
it('never blocks todo navigation with the terminal boot surface, even before a background terminal is ready', () => {
  const view = render(<Frame ready={false} workspace={false} />);
  expect(screen.getByRole('status')).toBeTruthy();
  view.rerender(<Frame ready={false} workspace />);
  expect(screen.getByText('待办清单')).toBeTruthy(); expect(screen.queryByRole('status')).toBeNull();
  view.rerender(<Frame ready={false} workspace={false} />);
  expect(screen.queryByRole('status')).toBeNull();
});
it('does not rearm first-load recovery during repeated workspace transitions or chat readiness changes', () => {
  const view = render(<Frame ready workspace={false} />);
  for (let i = 0; i < 5; i++) {
    view.rerender(<Frame ready={false} workspace />); expect(screen.queryByRole('status')).toBeNull();
    view.rerender(<Frame ready={false} workspace={false} />); expect(screen.queryByRole('status')).toBeNull();
  }
});
