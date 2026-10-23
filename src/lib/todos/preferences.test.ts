// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { readTodoPreferences, rememberTodoChoice, todoDirectoryChoices } from './preferences';
import type { TodoSnapshot } from './api';
beforeEach(() => localStorage.clear());
it('remembers successful choices across reloads, scopes them to the service, and omits task instructions', () => {
  rememberTodoChoice('one', { agentSlug: 'codex', command: 'codex --model custom', cwd: '/work/one/', prompt: 'private instructions' });
  rememberTodoChoice('one', { agentSlug: 'claude', command: 'claude', cwd: '/work/two', prompt: 'different instructions' });
  expect(readTodoPreferences('one')).toEqual({ choice: { agentSlug: 'claude', command: 'claude', cwd: '/work/two' }, directories: ['/work/two', '/work/one'] });
  expect(readTodoPreferences('two')).toEqual({ directories: [] });
  expect(localStorage.getItem('termdock:todo-preferences:v1:one')).not.toContain('instructions');
});
it('keeps current and previously used directories available and removes duplicate paths', () => {
  rememberTodoChoice('one', { agentSlug: 'codex', command: 'codex', cwd: '/work/recent', prompt: '' });
  const data = { defaults: { cwd: '/work/default' }, runs: [{ config: { cwd: '/work/run' } }], collectors: [{ config: { cwd: '/work/collector' } }] } as TodoSnapshot;
  expect(todoDirectoryChoices('/work/current/', ['/work/current', '/work/session'], data, 'one')).toEqual(['/work/current', '/work/recent', '/work/default', '/work/run', '/work/session', '/work/collector']);
});
it('recovers from invalid stored preferences without blocking forms', () => {
  localStorage.setItem('termdock:todo-preferences:v1:broken', '{');
  expect(readTodoPreferences('broken')).toEqual({ directories: [] });
  localStorage.setItem('termdock:todo-preferences:v1:broken', JSON.stringify({ choice: { cwd: 42 }, directories: [null, false, '/valid/'] }));
  expect(readTodoPreferences('broken')).toEqual({ choice: undefined, directories: ['/valid'] });
});
