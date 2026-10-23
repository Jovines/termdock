import { useSyncExternalStore } from 'react';

const KEY = 'termdock:agent-command-presets:v1';
export const LEGACY_COMMANDS_KEY = 'termdock:new-session-commands:v1';
const CHANGED = 'termdock:launch-commands-changed';
export interface AgentCommandPreset { id: string; name: string; command: string }
interface AgentCommands { presets: AgentCommandPreset[]; selectedId: string | null }
type Commands = Record<string, AgentCommands>;
function raw(key: string): string { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
export function readLegacyLaunchCommands(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw(LEGACY_COMMANDS_KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}
function readAll(): Commands {
  try {
    const value: unknown = JSON.parse(raw(KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([slug, item]) => {
      if (!item || typeof item !== 'object' || !Array.isArray(item.presets)) return [];
      const presets = item.presets.filter((p: unknown): p is AgentCommandPreset => !!p && typeof p === 'object'
        && 'id' in p && typeof p.id === 'string' && 'name' in p && typeof p.name === 'string'
        && 'command' in p && typeof p.command === 'string' && !!p.command.trim());
      return [[slug, { presets, selectedId: presets.some((p: AgentCommandPreset) => p.id === item.selectedId) ? item.selectedId : null }]];
    }));
  } catch { return {}; }
}
export function readAgentCommandPresets(slug: string, defaultCommand: string): AgentCommands {
  const stored = readAll()[slug];
  if (stored) return stored;
  const legacy = readLegacyLaunchCommands()[slug]?.trim();
  return legacy && legacy !== defaultCommand.trim()
    ? { presets: [{ id: 'legacy', name: legacy, command: legacy }], selectedId: 'legacy' }
    : { presets: [], selectedId: null };
}
export function getAgentLaunchCommand(slug: string, defaultCommand: string): string {
  const state = readAgentCommandPresets(slug, defaultCommand);
  return state.presets.find(p => p.id === state.selectedId)?.command ?? defaultCommand;
}
export function hasAgentCommandSelection(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(readAll(), slug) || Object.prototype.hasOwnProperty.call(readLegacyLaunchCommands(), slug);
}
function write(slug: string, state: AgentCommands, defaultCommand: string) {
  // Keep the legacy per-Agent override current without disturbing standalone shell commands.
  const legacy = { ...readLegacyLaunchCommands(), [slug]: state.presets.find(p => p.id === state.selectedId)?.command ?? defaultCommand };
  localStorage.setItem(LEGACY_COMMANDS_KEY, JSON.stringify(legacy));
  localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [slug]: state }));
  window.dispatchEvent(new Event(CHANGED));
}
export function selectAgentCommand(slug: string, defaultCommand: string, id: string | null) {
  const state = readAgentCommandPresets(slug, defaultCommand);
  if (id !== null && !state.presets.some(p => p.id === id)) throw new Error('Command preset unavailable');
  write(slug, { ...state, selectedId: id }, defaultCommand);
}
export function saveAgentCommand(slug: string, defaultCommand: string, input: { id?: string; name: string; command: string }): AgentCommandPreset {
  const command = input.command.trim();
  if (!command) throw new Error('Command required');
  const state = readAgentCommandPresets(slug, defaultCommand);
  const preset = { id: input.id && state.presets.some(p => p.id === input.id) ? input.id : crypto.randomUUID(), name: input.name.trim() || command, command };
  const presets = state.presets.filter(p => p.id !== preset.id);
  write(slug, { presets: [...presets, preset], selectedId: preset.id }, defaultCommand);
  return preset;
}
export function deleteAgentCommand(slug: string, defaultCommand: string, id: string) {
  const state = readAgentCommandPresets(slug, defaultCommand);
  write(slug, { presets: state.presets.filter(p => p.id !== id), selectedId: state.selectedId === id ? null : state.selectedId }, defaultCommand);
}
/** A launch remembers its exact command without replacing other saved variants. */
export function rememberAgentCommand(slug: string, defaultCommand: string, command: string) {
  const state = readAgentCommandPresets(slug, defaultCommand);
  const preset = state.presets.find(p => p.id === state.selectedId && p.command === command.trim()) ?? state.presets.find(p => p.command === command.trim());
  if (preset) selectAgentCommand(slug, defaultCommand, preset.id);
  else if (!command.trim() || command.trim() === defaultCommand.trim()) selectAgentCommand(slug, defaultCommand, null);
  else saveAgentCommand(slug, defaultCommand, { name: command.trim(), command });
}
function subscribe(callback: () => void) {
  window.addEventListener(CHANGED, callback);
  window.addEventListener('storage', callback);
  return () => { window.removeEventListener(CHANGED, callback); window.removeEventListener('storage', callback); };
}
export function useAgentCommandPresets(slug: string, defaultCommand: string): AgentCommands {
  useSyncExternalStore(subscribe, () => `${raw(KEY)}\n${raw(LEGACY_COMMANDS_KEY)}`, () => '');
  return readAgentCommandPresets(slug, defaultCommand);
}
