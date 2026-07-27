import type { LoadedPlugin } from './plugins.js';

/**
 * Third-party CLI coding-agent registry + detection.
 * （设计移植自 tty7 的 core/cli_agent.rs，Apache-2.0；此处为 TypeScript 重写）
 *
 * termdock recognizes when a pane is running a known coding agent (Claude
 * Code, Codex, Gemini CLI, …) so the tab can brand it and notifications can
 * say *which* agent finished or needs you. Detection is a pure function over
 * the foreground process's argv (which the server already polls for program
 * labels), so it works identically in shell mode and tmux mode.
 *
 * Strategy:
 * 1. Strip leading `VAR=value` environment assignments.
 * 2. If the launcher's own basename matches a known agent, that's it.
 * 3. Otherwise only if the launcher is a script *interpreter* (node, bun,
 *    python, npx, …), scan remaining path-like arguments for a segment that
 *    names an agent — the npm/pip-wrapped case (`node …/claude-code/cli.js`).
 *    The interpreter gate keeps `cat codex.md` from false-matching.
 * 4. User-defined rules (`agentCommands` in program-detection config): a map
 *    from command basename to agent slug, for personal wrappers (`cc`).
 */

export type AgentSlug = string;

export interface AgentInfo {
  slug: AgentSlug;
  displayName: string;
  /** command names: launcher binary + npm/pip package-dir aliases, lowercase */
  aliases: string[];
  /** brand accent for the tab dot / avatar background */
  accentColor: string;
  /** icon asset name under /icons/agents, or abs path for plugin SVG (null → generic bot glyph) */
  icon: string | null;
  /** Whether this agent is user-defined (plugin) vs built-in. */
  isPlugin?: boolean;
}

// Registry order matters only for iteration stability; lookup is by alias.
// flexoki-allow-file — vendor brand accents are deliberately theme-independent.
const AGENTS: AgentInfo[] = [
  { slug: 'claude',      displayName: 'Claude Code', aliases: ['claude', 'claude-code'],  accentColor: '#D97757', icon: 'claude' },
  { slug: 'codex',       displayName: 'Codex',       aliases: ['codex', 'codex-cli'],     accentColor: '#000000', icon: 'codex' },
  { slug: 'gemini',      displayName: 'Gemini',      aliases: ['gemini', 'gemini-cli'],   accentColor: '#4285F4', icon: 'gemini' },
  { slug: 'aider',       displayName: 'Aider',       aliases: ['aider', 'aider-chat'],    accentColor: '#14B8A6', icon: null },
  { slug: 'amp',         displayName: 'Amp',         aliases: ['amp'],                    accentColor: '#F34E3F', icon: 'amp' },
  { slug: 'opencode',    displayName: 'OpenCode',    aliases: ['opencode'],               accentColor: '#6E56CF', icon: 'opencode' },
  { slug: 'copilot',     displayName: 'Copilot',     aliases: ['copilot'],                accentColor: '#8957E5', icon: 'copilot' },
  { slug: 'cursor',      displayName: 'Cursor',      aliases: ['cursor-agent'],           accentColor: '#9AA0A6', icon: 'cursor' },
  { slug: 'goose',       displayName: 'Goose',       aliases: ['goose'],                  accentColor: '#9A8CFF', icon: 'goose' },
  { slug: 'droid',       displayName: 'Droid',       aliases: ['droid'],                  accentColor: '#F59E0B', icon: 'droid' },
  { slug: 'pi',          displayName: 'Pi',          aliases: ['pi'],                     accentColor: '#0EA5E9', icon: null },
  { slug: 'auggie',      displayName: 'Auggie',      aliases: ['auggie'],                 accentColor: '#16A34A', icon: null },
  { slug: 'hermes',      displayName: 'Hermes',      aliases: ['hermes'],                 accentColor: '#8B5CF6', icon: null },
  { slug: 'vibe',        displayName: 'Vibe',        aliases: ['vibe', 'vibe-acp'],       accentColor: '#FF7000', icon: null },
  { slug: 'antigravity', displayName: 'Antigravity', aliases: ['agy', 'antigravity'],     accentColor: '#2563EB', icon: null },
  { slug: 'grok',        displayName: 'Grok',        aliases: ['grok'],                   accentColor: '#000000', icon: 'grok' },
  { slug: 'qwen',        displayName: 'Qwen Code',   aliases: ['qwen', 'qwen-code'],      accentColor: '#7C3AED', icon: null },
];

const BY_ALIAS = new Map<string, AgentInfo>();
const BY_SLUG = new Map<string, AgentInfo>();
for (const info of AGENTS) {
  BY_SLUG.set(info.slug, info);
  for (const alias of info.aliases) BY_ALIAS.set(alias, info);
}

export function agentBySlug(slug: string | null | undefined): AgentInfo | null {
  if (!slug) return null;
  return BY_SLUG.get(slug.trim().toLowerCase()) ?? null;
}

export function listAgents(): AgentInfo[] {
  return AGENTS.slice();
}

function matchToken(token: string): AgentInfo | null {
  return BY_ALIAS.get(token) ?? null;
}

/** A `KEY=value` shell environment assignment prefix (`FOO=bar cmd`). */
function isEnvAssignment(token: string): boolean {
  const eq = token.indexOf('=');
  if (eq <= 0) return false;
  const key = token.slice(0, eq);
  if (!/^[A-Za-z_]/.test(key)) return false;
  return /^[A-Za-z0-9_]+$/.test(key);
}

/**
 * The final path component with trailing script extension stripped.
 * `/usr/bin/claude` → `claude`, `cli.js` → `cli`, `claude.cmd` → `claude`.
 * Splits on both separators so Windows paths resolve the same on Unix.
 */
function baseStem(token: string): string {
  const trimmed = token.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.py', '.rb', '.sh', '.exe', '.cmd', '.bat', '.ps1']) {
    if (name.endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

/** Whether a launcher basename is an interpreter whose arguments name the real program. */
function isInterpreter(stem: string): boolean {
  return ['node', 'nodejs', 'bun', 'deno', 'npx', 'pnpm', 'yarn',
    'python', 'python3', 'ruby', 'uv', 'uvx', 'env'].includes(stem.toLowerCase());
}

function tokenNamesAgent(token: string, agent: AgentInfo): boolean {
  return token.split(/[/\\]/).some((seg) => matchToken(baseStem(seg).toLowerCase()) === agent);
}

/**
 * Identify the coding agent a foreground argv is running, or null.
 * `customRules` maps a command basename to an agent slug (personal wrappers);
 * applies to the launcher only and loses to a built-in match on the same name.
 */
export function detectAgentFromArgv(
  argv: string[],
  customRules: Record<string, string> = {},
): AgentInfo | null {
  let i = 0;
  while (i < argv.length && isEnvAssignment(argv[i])) i++;
  const launcher = argv[i];
  if (!launcher) return null;
  const launcherStem = baseStem(launcher);

  // Native binary (or built-in match wins over custom rules on the same name)
  const direct = matchToken(launcherStem.toLowerCase());
  if (direct) return direct;
  const custom = customRules[launcherStem.toLowerCase()];
  if (custom) {
    const agent = agentBySlug(custom);
    if (agent) return agent;
  }

  // Interpreter wrapper: scan the script path / package args it runs
  if (isInterpreter(launcherStem)) {
    for (let j = i + 1; j < argv.length; j++) {
      const arg = argv[j];
      if (arg.startsWith('-')) continue;
      for (const seg of arg.split(/[/\\]/)) {
        const hit = matchToken(baseStem(seg).toLowerCase());
        if (hit) return hit;
      }
    }
  }
  return null;
}

/**
 * Shell-split a raw command line (as captured from ps args) into argv, then
 * detect. Naive tokenization: whitespace split, quotes trimmed — enough for
 * the dominant shapes (`claude --model opus`, `node /path/cli.js --flag`).
 */
export function detectAgentFromCommand(
  command: string,
  customRules: Record<string, string> = {},
): AgentInfo | null {
  const argv = command
    .split(/\s+/)
    .map((t) => t.replace(/^["']+|["']+$/g, ''))
    .filter((t) => t.length > 0);
  return detectAgentFromArgv(argv, customRules);
}

// ---------------------------------------------------------------------------
// Resume: rebuild the shell command that resumes a previous agent session by
// its native session id, carrying the user's original launch flags.
// ---------------------------------------------------------------------------

/** Per-agent resume command templates; null = no known resume flag. */
function resumeCommandFor(agent: AgentInfo, sessionId: string, flags: string[]): string | null {
  const f = flags.length > 0 ? ' ' + flags.join(' ') : '';
  switch (agent.slug) {
    case 'claude':  return `claude${f} --resume ${sessionId}`;
    // Codex resumes via a subcommand; interactive options follow the positional id
    case 'codex':   return `codex resume ${sessionId}${f}`;
    case 'gemini':  return `gemini${f} --resume ${sessionId}`;
    case 'opencode': return `opencode${f} --session ${sessionId}`;
    case 'amp':     return `amp threads continue ${sessionId}${f}`;
    case 'cursor':  return `cursor-agent${f} --resume ${sessionId}`;
    case 'copilot': return `copilot${f} --resume ${sessionId}`;
    case 'grok':    return `grok${f} --resume ${sessionId}`;
    default:        return null;
  }
}

/** Session-targeting flags whose old value must not survive onto a resume. */
const STALE_SESSION_FLAGS: Partial<Record<AgentSlug, string[]>> = {
  claude:  ['--resume', '-r', '--continue', '-c', '--session-id', '--from-pr'],
  gemini:  ['--resume', '-r'],
  cursor:  ['--resume', '-r'],
  copilot: ['--resume', '-r', '--continue', '-c'],
  opencode: ['--session', '-s', '--continue', '-c'],
  codex:   ['--last'],
  grok:    ['--resume', '-r', '--load', '--continue', '-c', '--session-id', '-s',
            '--fork-session', '--worktree', '-w', '--worktree-ref', '--ref'],
};

/**
 * The launch-flag tail of argv worth replaying on a resume command, or null
 * to resume bare. Deliberately conservative: anything ambiguous falls back to
 * no flags rather than a corrupted command line.
 * - The tail is everything after the token that names this agent; leading
 *   `VAR=value` env assignments are skipped first. No naming token → null.
 * - Stale session-targeting flags are stripped (the new id must win).
 * - Every surviving token must be shell-safe, the first must be a `-` flag,
 *   and no two bare words may run consecutively (a bare word is only valid as
 *   the value directly behind a flag — anything else is a positional prompt
 *   that must not re-submit itself into the resumed session).
 */
function replayFlags(agent: AgentInfo, argv: string[]): string[] | null {
  let start = 0;
  while (start < argv.length && isEnvAssignment(argv[start])) start++;
  let named = -1;
  for (let j = start; j < argv.length; j++) {
    if (tokenNamesAgent(argv[j], agent)) { named = j; break; }
  }
  if (named < 0) return null;
  const tail = argv.slice(named + 1);

  // A relaunched `codex resume <old-id>`: drop the subcommand and its id
  if (agent.slug === 'codex' && tail[0] === 'resume') {
    tail.shift();
    if (tail.length > 0 && !tail[0].startsWith('-')) tail.shift();
  }

  const stale = STALE_SESSION_FLAGS[agent.slug] ?? [];
  for (let j = 0; j < tail.length;) {
    const t = tail[j];
    const isStale = stale.includes(t)
      || stale.some((f) => f.length > 2 && t.startsWith(`${f}=`));
    if (isStale) {
      tail.splice(j, 1);
      if (j < tail.length && !tail[j].startsWith('-')) tail.splice(j, 1);
    } else {
      j++;
    }
  }

  // Safety gate: plain tokens only, flag-shaped tail
  const safe = (t: string) => t.length > 0 && /^[A-Za-z0-9_=./,:@+~-]+$/.test(t);
  if (!tail.every(safe)) return null;
  let prevWasFlag = false;
  for (const t of tail) {
    const isFlag = t.startsWith('-');
    if (!isFlag && !prevWasFlag) return null;
    prevWasFlag = isFlag;
  }
  return tail;
}

/**
 * The shell command resuming a session, or null when the agent has no known
 * resume flag or the id/flags aren't shell-safe. Ids come from the agent's own
 * hook events but still land on a shell command line — refuse anything that
 * isn't a plain token.
 */
export function buildResumeCommand(
  agent: AgentInfo,
  sessionId: string,
  launchArgv: string[] | null | undefined,
): string | null {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  // Plugin-defined resume: use the command template
  if (agent.isPlugin) {
    const pluginResume = getPluginResumeConfig(agent.slug);
    if (pluginResume) {
      const safe = (t: string) => /^[A-Za-z0-9._-]+$/.test(t);
      if (!safe(sessionId)) return null;
      const cmd = pluginResume.command.replace('{sessionId}', sessionId);
      // Shell-safety: refuse anything non-alphanumeric
      if (!/^[A-Za-z0-9_[\]{},./:;@+=~'"!?#&()<>*|$ -]+$/.test(cmd)) return null;
      return cmd;
    }
    return null;
  }
  const flags = launchArgv ? replayFlags(agent, launchArgv) ?? [] : [];
  return resumeCommandFor(agent, sessionId, flags);
}

// ---------------------------------------------------------------------------
// Plugin agent integration
// ---------------------------------------------------------------------------

/** Plugin-defined resume configs, keyed by slug. */
const pluginResumeConfigs = new Map<string, { command: string; staleFlags: string[] }>();

/**
 * Register plugin agents into the lookup maps. Plugins whose slug or aliases
 * collide with built-in agents are skipped. Call `clearPluginAgents()` first
 * when reloading.
 */
export function registerPluginAgents(plugins: LoadedPlugin[]): { registered: number; skipped: string[] } {
  let registered = 0;
  const skipped: string[] = [];
  for (const p of plugins) {
    const { manifest } = p;
    if (BY_SLUG.has(manifest.slug)) {
      skipped.push(`${manifest.slug} (slug conflicts with built-in)`);
      continue;
    }
    let aliasConflict = false;
    for (const alias of manifest.aliases) {
      if (BY_ALIAS.has(alias)) {
        skipped.push(`${manifest.slug} (alias "${alias}" conflicts with built-in)`);
        aliasConflict = true;
        break;
      }
    }
    if (aliasConflict) continue;

    const info: AgentInfo = {
      slug: manifest.slug,
      displayName: manifest.displayName,
      aliases: manifest.aliases,
      accentColor: manifest.accentColor,
      icon: manifest.slug, // plugins use slug as icon key; frontend checks /agent-plugin-icon/<slug>
      isPlugin: true,
    };
    BY_SLUG.set(info.slug, info);
    for (const alias of info.aliases) BY_ALIAS.set(alias, info);

    if (manifest.resume) {
      pluginResumeConfigs.set(manifest.slug, {
        command: manifest.resume.command,
        staleFlags: manifest.resume.staleFlags ?? [],
      });
    }
    registered++;
  }
  return { registered, skipped };
}

export function clearPluginAgents(): void {
  for (const [slug, info] of BY_SLUG) {
    if (info.isPlugin) BY_SLUG.delete(slug);
  }
  for (const [alias, info] of BY_ALIAS) {
    if (info.isPlugin) BY_ALIAS.delete(alias);
  }
  pluginResumeConfigs.clear();
}

export function getPluginResumeConfig(slug: string): { command: string; staleFlags: string[] } | undefined {
  return pluginResumeConfigs.get(slug);
}

export function isPluginAgent(slug: string): boolean {
  return BY_SLUG.get(slug)?.isPlugin === true;
}
