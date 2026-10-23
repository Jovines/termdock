// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { deleteAgentCommand, getAgentLaunchCommand, LEGACY_COMMANDS_KEY, readAgentCommandPresets, rememberAgentCommand, saveAgentCommand, selectAgentCommand } from './launchCommands';

beforeEach(() => localStorage.clear());
it('migrates the previous override while retaining standalone commands and other Agents', () => {
  localStorage.setItem(LEGACY_COMMANDS_KEY, JSON.stringify({ codex: 'codex --model old', claude: 'claude --verbose', '__saved_command__:htop': 'htop' }));
  saveAgentCommand('codex', 'codex', { name: 'Deep', command: 'codex --model deep' });
  expect(readAgentCommandPresets('codex', 'codex').presets.map(p => p.command)).toEqual(['codex --model old', 'codex --model deep']);
  expect(getAgentLaunchCommand('claude', 'claude')).toBe('claude --verbose');
  expect(JSON.parse(localStorage.getItem(LEGACY_COMMANDS_KEY)!)['__saved_command__:htop']).toBe('htop');
});
it('retains multiple variants, remembers selection and updates or deletes only the selected preset', () => {
  const daily = saveAgentCommand('codex', 'codex', { name: 'Daily', command: 'codex --model daily' });
  const deep = saveAgentCommand('codex', 'codex', { name: 'Deep', command: 'codex --model deep' });
  selectAgentCommand('codex', 'codex', daily.id);
  expect(getAgentLaunchCommand('codex', 'codex')).toBe(daily.command);
  saveAgentCommand('codex', 'codex', { ...daily, command: 'codex --model daily-v2' });
  deleteAgentCommand('codex', 'codex', daily.id);
  expect(getAgentLaunchCommand('codex', 'codex')).toBe('codex');
  expect(readAgentCommandPresets('codex', 'codex').presets).toEqual([deep]);
  rememberAgentCommand('codex', 'codex', deep.command);
  expect(getAgentLaunchCommand('codex', 'codex')).toBe(deep.command);
  expect(readAgentCommandPresets('codex', 'codex').presets).toHaveLength(1);
});
it('ignores corrupt storage without manufacturing an executable command', () => {
  localStorage.setItem('termdock:agent-command-presets:v1', '{broken');
  localStorage.setItem(LEGACY_COMMANDS_KEY, '[]');
  expect(getAgentLaunchCommand('codex', 'codex')).toBe('codex');
  expect(() => selectAgentCommand('codex', 'codex', 'missing')).toThrow();
});
