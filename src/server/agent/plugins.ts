/**
 * Agent plugin system: user-defined agents loaded from
 * `~/.termdock/agent-plugins/<slug>/manifest.json`.
 *
 * Each plugin can define:
 * 1. Agent identity (display name, aliases, accent color, icon)
 * 2. Hook installation config (target file + event mappings)
 * 3. Resume command support
 *
 * Plugins are merged into the built-in agent registry and hook installer
 * list at startup. Slugs that collide with built-in agents are skipped.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentEventKind } from './session.js';

const PLUGINS_DIR = path.join(os.homedir(), '.termdock', 'agent-plugins');
const MANIFEST_FILE = 'manifest.json';
const ICON_FILE = 'icon.svg';

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

export const PLUGIN_MANIFEST_VERSION = 1;

export interface PluginHookEvent {
  /** Agent's native hook event name (e.g. "SessionStart"). */
  hook: string;
  /** Our sentinel event kind (e.g. "session-start"). */
  event: AgentEventKind;
  /** Optional matcher to narrow the subscription (e.g. "elicitation_dialog"). */
  matcher?: string;
  /** Optional timeout in seconds for this hook invocation. */
  timeout?: number;
}

export interface PluginHookConfig {
  /** Path to the agent's hooks config file, ~-abbreviated. */
  target: string;
  /** Event mappings. */
  events: PluginHookEvent[];
}

export interface PluginResumeConfig {
  /** Shell command template. `{sessionId}` is replaced with the real id. */
  command: string;
  /** Session-targeting flags to strip from the launch argv before resume. */
  staleFlags?: string[];
}

export interface AgentPluginManifest {
  version: number;
  slug: string;
  displayName: string;
  aliases: string[];
  accentColor: string;
  /** Icon rendering mode: 'mask' = CSS mask+accentColor (default, monochrome); 'native' = raw SVG colors. */
  iconMode?: 'mask' | 'native';
  hooks?: PluginHookConfig;
  resume?: PluginResumeConfig;
}

export interface LoadedPlugin {
  manifest: AgentPluginManifest;
  /** Absolute path to the plugin directory. */
  dir: string;
  /** Absolute path to the icon SVG, if present. */
  iconPath: string | null;
  /** Icon file's mtime (ms), for cache-busting. */
  iconMtime: number;
}

// ---------------------------------------------------------------------------
// Known sentinel event kinds — the set of events our state machine accepts
// ---------------------------------------------------------------------------

const VALID_EVENT_KINDS = new Set<AgentEventKind>([
  'session-start',
  'prompt-submit',
  'permission-request',
  'question-asked',
  'tool-complete',
  'notification',
  'stop',
  'session-end',
]);

// ---------------------------------------------------------------------------
// Slug validation (alphanumeric + hyphens, non-empty)
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s) && s.length <= 40;
}

// ---------------------------------------------------------------------------
// Hex color validation
// ---------------------------------------------------------------------------

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

// ---------------------------------------------------------------------------
// Path resolution: ~ → home directory
// ---------------------------------------------------------------------------

function resolveHome(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

export interface PluginValidationError {
  slug: string;
  errors: string[];
}

function validateManifest(raw: unknown, dir: string): { manifest: AgentPluginManifest } | { error: PluginValidationError } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: { slug: path.basename(dir), errors: ['manifest.json is not a JSON object'] } };
  }
  const m = raw as Record<string, unknown>;

  const version = m.version;
  if (typeof version !== 'number' || version !== PLUGIN_MANIFEST_VERSION) {
    errors.push(`version must be ${PLUGIN_MANIFEST_VERSION}`);
  }

  const slug = m.slug;
  if (typeof slug !== 'string' || !isValidSlug(slug)) {
    errors.push('slug must be a lowercase alphanumeric string with hyphens (max 40 chars)');
  }

  const displayName = m.displayName;
  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    errors.push('displayName is required and must be a non-empty string');
  }

  const aliases = m.aliases;
  if (!Array.isArray(aliases) || aliases.length === 0 || !aliases.every((a) => typeof a === 'string' && a.trim().length > 0)) {
    errors.push('aliases must be a non-empty array of strings');
  }

  const accentColor = m.accentColor;
  if (typeof accentColor !== 'string' || !HEX_COLOR_RE.test(accentColor)) {
    errors.push('accentColor must be a 6-digit hex color (e.g. "#4385BE")');
  }

  // Optional iconMode
  const iconMode = m.iconMode;
  if (iconMode !== undefined && iconMode !== 'mask' && iconMode !== 'native') {
    errors.push('iconMode must be "mask" or "native" if provided');
  }

  // Optional hooks
  let hooks: PluginHookConfig | undefined;
  if (m.hooks !== undefined) {
    if (typeof m.hooks !== 'object' || Array.isArray(m.hooks) || m.hooks === null) {
      errors.push('hooks must be an object if present');
    } else {
      const h = m.hooks as Record<string, unknown>;
      const target = h.target;
      if (typeof target !== 'string' || target.trim().length === 0) {
        errors.push('hooks.target is required and must be a file path (~-abbreviated ok)');
      }
      const events = h.events;
      if (!Array.isArray(events) || events.length === 0) {
        errors.push('hooks.events must be a non-empty array');
      } else {
        const validEvents: PluginHookEvent[] = [];
        for (let i = 0; i < events.length; i++) {
          const e = events[i] as unknown;
          if (!e || typeof e !== 'object') {
            errors.push(`hooks.events[${i}] is not an object`);
            continue;
          }
          const evt = e as Record<string, unknown>;
          const hook = evt.hook;
          const event = evt.event;
          if (typeof hook !== 'string' || hook.trim().length === 0) {
            errors.push(`hooks.events[${i}].hook is required`);
          }
          if (typeof event !== 'string' || !VALID_EVENT_KINDS.has(event as AgentEventKind)) {
            errors.push(`hooks.events[${i}].event must be one of: ${[...VALID_EVENT_KINDS].join(', ')}`);
          }
          const matcher = evt.matcher;
          if (matcher !== undefined && typeof matcher !== 'string') {
            errors.push(`hooks.events[${i}].matcher must be a string if provided`);
          }
          const timeout = evt.timeout;
          if (timeout !== undefined && (typeof timeout !== 'number' || timeout <= 0)) {
            errors.push(`hooks.events[${i}].timeout must be a positive number if provided`);
          }
          validEvents.push({
            hook: hook as string,
            event: event as AgentEventKind,
            matcher: typeof matcher === 'string' ? matcher : undefined,
            timeout: typeof timeout === 'number' ? timeout : undefined,
          });
        }
        if (validEvents.length > 0) {
          hooks = { target: target as string, events: validEvents };
        }
      }
    }
  }

  // Optional resume
  let resumeConfig: PluginResumeConfig | undefined;
  if (m.resume !== undefined) {
    if (typeof m.resume !== 'object' || Array.isArray(m.resume) || m.resume === null) {
      errors.push('resume must be an object if present');
    } else {
      const r = m.resume as Record<string, unknown>;
      const command = r.command;
      if (typeof command !== 'string' || !command.includes('{sessionId}')) {
        errors.push('resume.command must contain the {sessionId} placeholder');
      }
      const staleFlags = r.staleFlags;
      if (staleFlags !== undefined && (!Array.isArray(staleFlags) || !staleFlags.every((f) => typeof f === 'string'))) {
        errors.push('resume.staleFlags must be an array of strings if provided');
      }
      resumeConfig = {
        command: command as string,
        staleFlags: Array.isArray(staleFlags) ? staleFlags as string[] : undefined,
      };
    }
  }

  if (errors.length > 0) {
    return { error: { slug: typeof slug === 'string' ? slug : path.basename(dir), errors } };
  }

  return {
    manifest: {
      version: version as number,
      slug: slug as string,
      displayName: (displayName as string).trim(),
      aliases: (aliases as string[]).map((a) => (a as string).trim().toLowerCase()),
      accentColor: accentColor as string,
      iconMode: iconMode as 'mask' | 'native' | undefined,
      hooks,
      resume: resumeConfig,
    },
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  errors: PluginValidationError[];
}

/**
 * Scan ~/.termdock/agent-plugins/ for plugin directories, validate each
 * manifest, and return the loaded plugins + any validation errors.
 */
export function loadPlugins(): PluginLoadResult {
  const plugins: LoadedPlugin[] = [];
  const errors: PluginValidationError[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  } catch {
    return { plugins, errors };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PLUGINS_DIR, entry.name);
    const manifestPath = path.join(dir, MANIFEST_FILE);

    let raw: string;
    try {
      raw = fs.readFileSync(manifestPath, 'utf8');
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      errors.push({ slug: entry.name, errors: ['manifest.json is not valid JSON'] });
      continue;
    }

    const result = validateManifest(parsed, dir);
    if ('error' in result) {
      errors.push(result.error);
      continue;
    }

    const iconPath = path.join(dir, ICON_FILE);
    let iconMtime = 0;
    const iconExists = fs.existsSync(iconPath);
    if (iconExists) {
      try { iconMtime = fs.statSync(iconPath).mtimeMs; } catch { /* keep 0 */ }
    }
    plugins.push({
      manifest: result.manifest,
      dir,
      iconPath: iconExists ? iconPath : null,
      iconMtime,
    });
  }

  return { plugins, errors };
}

/**
 * Save a plugin manifest to disk, creating the plugin directory.
 */
export function savePlugin(manifest: AgentPluginManifest): string {
  const dir = path.join(PLUGINS_DIR, manifest.slug);
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, MANIFEST_FILE);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return dir;
}

/**
 * Remove a plugin directory from disk.
 */
export function removePlugin(slug: string): void {
  const dir = path.join(PLUGINS_DIR, slug);
  if (!fs.existsSync(dir)) {
    throw new Error(`Plugin "${slug}" not found`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * List all plugin slugs (both currently loaded and directories on disk).
 */
export function listPluginDirectories(): string[] {
  try {
    return fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Resolve a ~-abbreviated path from a plugin's hooks.target to an absolute path.
 */
export function resolveHookTarget(hooksTargetPath: string): string {
  return resolveHome(hooksTargetPath);
}

/**
 * Read an icon SVG from a plugin directory as a string.
 */
export function readPluginIcon(slug: string): string | null {
  const iconPath = path.join(PLUGINS_DIR, slug, ICON_FILE);
  try {
    return fs.readFileSync(iconPath, 'utf8');
  } catch {
    return null;
  }
}
