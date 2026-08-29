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
import type {
  AgentEventKind,
  AgentSessionStatus,
  AgentStatusDefinition,
  AgentStatusIndicator,
  AgentStatusTone,
} from './session.js';

export const PLUGINS_DIR = path.join(os.homedir(), '.termdock', 'agent-plugins');
export const MANIFEST_FILE = 'manifest.json';
export const ICON_FILE = 'icon.svg';
export const SOURCE_METADATA_FILE = '.termdock-source.json';

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

export const PLUGIN_MANIFEST_VERSION = 2;

export interface PluginHookEvent {
  /** Agent's native hook event name (e.g. "SessionStart"). */
  hook: string;
  /** Our sentinel event kind (e.g. "session-start"). */
  event: AgentEventKind;
  /** Optional matcher to narrow the subscription (e.g. "elicitation_dialog"). */
  matcher?: string;
  /** Optional timeout in seconds for this hook invocation. */
  timeout?: number;
  /** Optional plugin status id to activate when this hook fires. */
  status?: string;
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

export interface PluginTitleNamerConfig {
  /** Executable used to generate a title (no shell expansion). */
  command: string;
  /** Always-present arguments; must include {prompt}. */
  args: string[];
  /** Argument group prepended only when a model is selected. */
  modelArgs?: string[];
  /** Optional CLI command that prints a JSON array of model descriptors. */
  models?: {
    command: string;
    args?: string[];
  };
}

export interface AgentPluginManifest {
  version: number;
  slug: string;
  displayName: string;
  aliases: string[];
  /** Optional routing hints shown to collaborators (for example: review, frontend, testing). */
  capabilities?: string[];
  accentColor: string;
  /** Icon rendering mode: 'mask' = CSS mask+accentColor (default, monochrome); 'native' = raw SVG colors. */
  iconMode?: 'mask' | 'native';
  /** Fine-grained display statuses mapped onto stable behavioral phases. */
  statuses?: AgentStatusDefinition[];
  hooks?: PluginHookConfig;
  resume?: PluginResumeConfig;
  /** Make this Agent available as an automatic-title provider. */
  titleNamer?: PluginTitleNamerConfig;
}

export interface LoadedPlugin {
  manifest: AgentPluginManifest;
  /** Absolute path to the plugin directory. */
  dir: string;
  /** Absolute path to the icon SVG, if present. */
  iconPath: string | null;
  /** Icon file's mtime (ms), for cache-busting. */
  iconMtime: number;
  /** Where this plugin package came from. Older manifest-only plugins omit it. */
  source: PluginSourceMetadata | null;
}

export type PluginSourceType = 'git' | 'local' | 'manifest';

export interface PluginSourceMetadata {
  version: 1;
  type: PluginSourceType;
  source: string | null;
  revision: string | null;
  latestRevision: string | null;
  installedAt: number;
  updatedAt: number;
  checkedAt: number | null;
}

function parseSourceMetadata(raw: unknown): PluginSourceMetadata | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || !['git', 'local', 'manifest'].includes(String(value.type))) return null;
  return {
    version: 1,
    type: value.type as PluginSourceType,
    source: typeof value.source === 'string' ? value.source : null,
    revision: typeof value.revision === 'string' ? value.revision : null,
    latestRevision: typeof value.latestRevision === 'string' ? value.latestRevision : null,
    installedAt: typeof value.installedAt === 'number' ? value.installedAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    checkedAt: typeof value.checkedAt === 'number' ? value.checkedAt : null,
  };
}

export function readPluginSourceMetadata(dir: string): PluginSourceMetadata | null {
  try {
    return parseSourceMetadata(JSON.parse(fs.readFileSync(path.join(dir, SOURCE_METADATA_FILE), 'utf8')));
  } catch {
    return null;
  }
}

export function writePluginSourceMetadata(dir: string, metadata: PluginSourceMetadata): void {
  fs.writeFileSync(path.join(dir, SOURCE_METADATA_FILE), JSON.stringify(metadata, null, 2), 'utf8');
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
const VALID_STATUS_PHASES = new Set<AgentSessionStatus>(['idle', 'working', 'waiting', 'done']);
const VALID_STATUS_INDICATORS = new Set<AgentStatusIndicator>(['spinner', 'pulse', 'dot', 'ring', 'badge', 'terminal', 'question']);
const VALID_STATUS_TONES = new Set<AgentStatusTone>(['neutral', 'info', 'success', 'warning', 'danger', 'accent']);
const STATUS_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

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

function isSafeSvgIcon(svg: string): boolean {
  return /^\s*<svg\b/i.test(svg)
    && !/<(?:script|style|foreignObject|iframe|object|embed)\b/i.test(svg)
    && !/<\?(?:xml|xml-stylesheet)\b|<!DOCTYPE\b/i.test(svg)
    && !/\bon[a-z]+\s*=/i.test(svg)
    && !/(?:href|src)\s*=\s*["']?\s*(?!#)[^"'\s>]+/i.test(svg)
    && !/url\(\s*(?!["']?#)[^)]+\)/i.test(svg);
}

// ---------------------------------------------------------------------------
// Path resolution: ~ → home directory
// ---------------------------------------------------------------------------

function resolveHome(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function validateHookTarget(target: string): string | null {
  if (!target.startsWith('~/') || !target.toLowerCase().endsWith('.json')) {
    return 'hooks.target must be a ~/ path to a JSON file';
  }
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(home, target.slice(2));
  if (resolved === home || !resolved.startsWith(`${home}${path.sep}`)) {
    return 'hooks.target must stay inside the user home directory';
  }

  // Existing symlinks in any target component could redirect a later write
  // outside $HOME. Refuse them instead of relying on a racy realpath check.
  let current = home;
  for (const part of path.relative(home, resolved).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        return 'hooks.target may not traverse symbolic links';
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return 'hooks.target could not be safely inspected';
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

export interface PluginValidationError {
  slug: string;
  errors: string[];
  code?: 'AGENT_PLUGIN_MANIFEST_V1_UNSUPPORTED';
  migration?: {
    guideCommand: string;
    aiPrompt: string;
  };
}

export const V1_MIGRATION_GUIDE_COMMAND = 'td agent-plugin --json';
export const V1_MIGRATION_AI_PROMPT = [
  'Please migrate the attached Termdock Agent plugin manifest from v1 to v2.',
  'Preserve slug, displayName, aliases, accentColor, iconMode, hooks.target, and resume.',
  'Add statuses[] entries with id, phase (idle|working|waiting|done), label, indicator, and tone.',
  'Add a status reference to each relevant hooks.events[] mapping while keeping its core event value.',
  `Use the output of \`${V1_MIGRATION_GUIDE_COMMAND}\` as the authoritative schema.`,
  'Return only the corrected manifest JSON.',
].join(' ');

export function validateManifest(raw: unknown, dir: string): { manifest: AgentPluginManifest } | { error: PluginValidationError } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: { slug: path.basename(dir), errors: ['manifest.json is not a JSON object'] } };
  }
  const m = raw as Record<string, unknown>;

  const version = m.version;
  const isV1 = version === 1;
  if (isV1) {
    errors.push('manifest v1 is no longer supported; migrate this plugin to manifest v2');
    errors.push(`read the current machine-readable schema with: ${V1_MIGRATION_GUIDE_COMMAND}`);
  } else if (typeof version !== 'number' || version !== PLUGIN_MANIFEST_VERSION) {
    errors.push(`version must be ${PLUGIN_MANIFEST_VERSION}`);
  }

  const slug = m.slug;
  if (typeof slug !== 'string' || !isValidSlug(slug)) {
    errors.push('slug must be a lowercase alphanumeric string with hyphens (max 40 chars)');
  }

  const displayName = m.displayName;
  if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 80) {
    errors.push('displayName is required and must be a non-empty string (max 80 chars)');
  }

  const aliases = m.aliases;
  if (!Array.isArray(aliases) || aliases.length === 0 || aliases.length > 16
    || !aliases.every((a) => typeof a === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(a))) {
    errors.push('aliases must contain 1-16 safe command names');
  }

  const capabilities = m.capabilities;
  if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.length > 32
    || !capabilities.every((capability) => typeof capability === 'string'
      && /^[A-Za-z0-9\p{L}][A-Za-z0-9\p{L}\p{N}:._ -]{0,63}$/u.test(capability.trim())))) {
    errors.push('capabilities must contain at most 32 short capability names');
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

  // Optional plugin-defined status vocabulary. These decorate the stable
  // idle/working/waiting/done phases instead of replacing their semantics.
  let statuses: AgentStatusDefinition[] | undefined;
  const statusIds = new Set<string>();
  if (m.statuses !== undefined) {
    if (!Array.isArray(m.statuses) || m.statuses.length === 0) {
      errors.push('statuses must be a non-empty array if present');
    } else {
      const validStatuses: AgentStatusDefinition[] = [];
      for (let i = 0; i < m.statuses.length; i++) {
        const rawStatus = m.statuses[i];
        if (!rawStatus || typeof rawStatus !== 'object' || Array.isArray(rawStatus)) {
          errors.push(`statuses[${i}] is not an object`);
          continue;
        }
        const status = rawStatus as Record<string, unknown>;
        const id = status.id;
        const phase = status.phase;
        const label = status.label;
        const indicator = status.indicator;
        const tone = status.tone;
        if (typeof id !== 'string' || !STATUS_ID_RE.test(id)) {
          errors.push(`statuses[${i}].id must be lowercase alphanumeric with hyphens (max 40 chars)`);
          continue;
        }
        if (statusIds.has(id)) errors.push(`statuses[${i}].id duplicates "${id}"`);
        statusIds.add(id);
        if (typeof phase !== 'string' || !VALID_STATUS_PHASES.has(phase as AgentSessionStatus)) {
          errors.push(`statuses[${i}].phase must be one of: ${[...VALID_STATUS_PHASES].join(', ')}`);
        }
        if (typeof label !== 'string' || label.trim().length === 0 || label.length > 80) {
          errors.push(`statuses[${i}].label must be a non-empty string (max 80 chars)`);
        }
        if (indicator !== undefined && (typeof indicator !== 'string' || !VALID_STATUS_INDICATORS.has(indicator as AgentStatusIndicator))) {
          errors.push(`statuses[${i}].indicator must be one of: ${[...VALID_STATUS_INDICATORS].join(', ')}`);
        }
        if (tone !== undefined && (typeof tone !== 'string' || !VALID_STATUS_TONES.has(tone as AgentStatusTone))) {
          errors.push(`statuses[${i}].tone must be one of: ${[...VALID_STATUS_TONES].join(', ')}`);
        }
        validStatuses.push({
          id,
          phase: phase as AgentSessionStatus,
          label: typeof label === 'string' ? label.trim() : '',
          indicator: indicator as AgentStatusIndicator | undefined,
          tone: tone as AgentStatusTone | undefined,
        });
      }
      if (validStatuses.length > 0) statuses = validStatuses;
    }
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
      } else {
        const targetError = validateHookTarget(target.trim());
        if (targetError) errors.push(targetError);
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
          if (typeof hook !== 'string' || hook.trim().length === 0 || hook.length > 120) {
            errors.push(`hooks.events[${i}].hook is required`);
          }
          if (typeof event !== 'string' || !VALID_EVENT_KINDS.has(event as AgentEventKind)) {
            errors.push(`hooks.events[${i}].event must be one of: ${[...VALID_EVENT_KINDS].join(', ')}`);
          }
          const matcher = evt.matcher;
          if (matcher !== undefined && (typeof matcher !== 'string' || matcher.length > 512)) {
            errors.push(`hooks.events[${i}].matcher must be a string (max 512 chars) if provided`);
          }
          const timeout = evt.timeout;
          if (timeout !== undefined && (typeof timeout !== 'number' || timeout <= 0)) {
            errors.push(`hooks.events[${i}].timeout must be a positive number if provided`);
          }
          const status = evt.status;
          if (status !== undefined && (typeof status !== 'string' || !statusIds.has(status))) {
            errors.push(`hooks.events[${i}].status must reference a declared statuses[].id`);
          }
          validEvents.push({
            hook: hook as string,
            event: event as AgentEventKind,
            matcher: typeof matcher === 'string' ? matcher : undefined,
            timeout: typeof timeout === 'number' ? timeout : undefined,
            status: typeof status === 'string' ? status : undefined,
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
      } else {
        const tokens = command.trim().split(/\s+/);
        const executable = path.basename(tokens[0] ?? '');
        if (command.length > 1024
          || !tokens.every((token) => /^[A-Za-z0-9_./:@%+,={}-]+$/.test(token))
          || !Array.isArray(aliases)
          || !(aliases as string[]).includes(executable)) {
          errors.push('resume.command must be a simple argv-like command whose executable is one of aliases; shell syntax is not allowed');
        }
      }
      const staleFlags = r.staleFlags;
      if (staleFlags !== undefined && (!Array.isArray(staleFlags) || staleFlags.length > 32
        || !staleFlags.every((f) => typeof f === 'string' && /^--?[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(f)))) {
        errors.push('resume.staleFlags must be an array of safe CLI flags if provided');
      }
      resumeConfig = {
        command: command as string,
        staleFlags: Array.isArray(staleFlags) ? staleFlags as string[] : undefined,
      };
    }
  }

  // Optional automatic-title provider. Commands are argv arrays rather than
  // shell snippets so a UI-installed manifest cannot gain accidental shell
  // interpolation beyond the executable it explicitly declares.
  let titleNamer: PluginTitleNamerConfig | undefined;
  if (m.titleNamer !== undefined) {
    if (typeof m.titleNamer !== 'object' || Array.isArray(m.titleNamer) || m.titleNamer === null) {
      errors.push('titleNamer must be an object if present');
    } else {
      const n = m.titleNamer as Record<string, unknown>;
      const command = n.command;
      const args = n.args;
      const modelArgs = n.modelArgs;
      if (typeof command !== 'string' || command.trim().length === 0 || command.length > 1024) {
        errors.push('titleNamer.command is required');
      }
      if (!Array.isArray(args) || args.length > 64
        || !args.every((arg) => typeof arg === 'string' && arg.length <= 16_384)
        || !args.some((arg) => arg.includes('{prompt}'))) {
        errors.push('titleNamer.args must be a string array containing {prompt}');
      }
      if (modelArgs !== undefined && (!Array.isArray(modelArgs) || modelArgs.length === 0 || modelArgs.length > 32
        || !modelArgs.every((arg) => typeof arg === 'string' && arg.length <= 4096)
        || !modelArgs.some((arg) => arg.includes('{model}')))) {
        errors.push('titleNamer.modelArgs must be a non-empty string array containing {model} if provided');
      }
      if (Array.isArray(modelArgs) && Array.isArray(args)
        && args.some((arg) => typeof arg === 'string' && arg.includes('{model}'))) {
        errors.push('put {model} in titleNamer.modelArgs or args, not both');
      }
      let models: PluginTitleNamerConfig['models'];
      if (n.models !== undefined) {
        if (typeof n.models !== 'object' || Array.isArray(n.models) || n.models === null) {
          errors.push('titleNamer.models must be an object if present');
        } else {
          const rawModels = n.models as Record<string, unknown>;
          if (typeof rawModels.command !== 'string' || rawModels.command.trim().length === 0 || rawModels.command.length > 1024) {
            errors.push('titleNamer.models.command is required');
          }
          if (rawModels.args !== undefined && (!Array.isArray(rawModels.args) || rawModels.args.length > 64
            || !rawModels.args.every((arg) => typeof arg === 'string' && arg.length <= 16_384))) {
            errors.push('titleNamer.models.args must be a string array if present');
          }
          if (typeof rawModels.command === 'string') {
            models = {
              command: rawModels.command.trim(),
              args: Array.isArray(rawModels.args) ? rawModels.args as string[] : undefined,
            };
          }
        }
      }
      if (typeof command === 'string' && Array.isArray(args)) {
        titleNamer = {
          command: command.trim(),
          args: args as string[],
          modelArgs: Array.isArray(modelArgs) ? modelArgs as string[] : undefined,
          models,
        };
      }
    }
  }

  if (errors.length > 0) {
    return {
      error: {
        slug: typeof slug === 'string' ? slug : path.basename(dir),
        errors,
        code: isV1 ? 'AGENT_PLUGIN_MANIFEST_V1_UNSUPPORTED' : undefined,
        migration: isV1
          ? { guideCommand: V1_MIGRATION_GUIDE_COMMAND, aiPrompt: V1_MIGRATION_AI_PROMPT }
          : undefined,
      },
    };
  }

  return {
    manifest: {
      version: version as number,
      slug: slug as string,
      displayName: (displayName as string).trim(),
      aliases: (aliases as string[]).map((a) => (a as string).trim().toLowerCase()),
      capabilities: Array.isArray(capabilities)
        ? [...new Set((capabilities as string[]).map((capability) => capability.trim()))]
        : undefined,
      accentColor: accentColor as string,
      iconMode: iconMode as 'mask' | 'native' | undefined,
      statuses,
      hooks,
      resume: resumeConfig,
      titleNamer,
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
    let iconExists = fs.existsSync(iconPath);
    if (iconExists) {
      try {
        if (!isSafeSvgIcon(fs.readFileSync(iconPath, 'utf8'))) {
          errors.push({ slug: result.manifest.slug, errors: ['icon.svg contains unsafe or invalid SVG content'] });
          iconExists = false;
        } else {
          iconMtime = fs.statSync(iconPath).mtimeMs;
        }
      } catch {
        iconExists = false;
      }
    }
    plugins.push({
      manifest: result.manifest,
      dir,
      iconPath: iconExists ? iconPath : null,
      iconMtime,
      source: readPluginSourceMetadata(dir),
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
  const now = Date.now();
  writePluginSourceMetadata(dir, {
    version: 1,
    type: 'manifest',
    source: null,
    revision: null,
    latestRevision: null,
    installedAt: now,
    updatedAt: now,
    checkedAt: null,
  });
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
