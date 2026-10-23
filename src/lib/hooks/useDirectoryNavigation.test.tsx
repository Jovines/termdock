// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useDirectoryNavigation } from './useDirectoryNavigation';

afterEach(cleanup);

it('bounds navigation to the project and resets it when the project changes', () => {
  const view = renderHook(({ root }) => useDirectoryNavigation(root, root), { initialProps: { root: '/project/' } });
  act(() => view.result.current.navigate('/project/src/'));
  expect(view.result.current.path).toBe('/project/src');
  act(() => view.result.current.goParent());
  expect(view.result.current.path).toBe('/project');
  expect(view.result.current.canGoParent).toBe(false);
  act(() => view.result.current.navigate('/project-other'));
  expect(view.result.current.path).toBe('/project');
  act(() => view.result.current.navigate('/project/src'));
  view.rerender({ root: '/second' });
  expect(view.result.current.path).toBe('/second');
  view.rerender({ root: '/project/' });
  expect(view.result.current.path).toBe('/project');
});

it('can browse to filesystem root from a top-level directory', () => {
  const { result } = renderHook(() => useDirectoryNavigation('/workspace///'));
  act(() => result.current.goParent());
  expect(result.current.path).toBe('/');
  expect(result.current.canGoParent).toBe(false);
  act(() => result.current.navigate('/another'));
  expect(result.current.canGoParent).toBe(true);
  act(() => result.current.goRoot());
  expect(result.current.path).toBe('/');
});

it('preserves spaces and the configured symlink path while navigating', () => {
  const { result } = renderHook(() => useDirectoryNavigation('/linked project', '/linked project'));
  act(() => result.current.navigate('/linked project/folder '));
  expect(result.current.path).toBe('/linked project/folder ');
  act(() => result.current.goParent());
  expect(result.current.path).toBe('/linked project');
});
