import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const MAX_CONTEXT_CHARS = 16_000;
const TITLE_TIMEOUT_MS = 45_000;

export function cleanTerminalContext(input: string): string {
  return input
    // OSC payloads include hook metadata and shell titles, neither is useful to the namer.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(-MAX_CONTEXT_CHARS);
}

export function buildAutoTitlePrompt(agentName: string, context: string, currentTitle?: string): string {
  return [
    `Create a concise title for this ${agentName} coding session.`,
    'Describe what the work actually became, not the initial command or generic activity.',
    currentTitle
      ? `Current title: ${JSON.stringify(currentTitle)}. Return it unchanged if it is still substantially accurate; rename only when the main work clearly shifted.`
      : 'This session has no previous automatic title.',
    'Use the dominant language of the terminal content. Return only the title.',
    'Constraints: 6-18 Chinese characters or 3-10 words; no quotes; no markdown; no trailing punctuation.',
    '',
    '<terminal_context>',
    context,
    '</terminal_context>',
  ].join('\n');
}

export function normalizeGeneratedTitle(output: string): string | null {
  const lines = output
    .replace(/```[a-z]*|```/gi, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const candidate = lines.at(-1)!
    .replace(/^(?:title|标题)\s*[:：]\s*/i, '')
    .replace(/^["'“‘`]+|["'”’`。.!！?？:：;；]+$/g, '')
    .trim();
  if (candidate.length < 2 || candidate.length > 80) return null;
  return candidate;
}

export function resolveTitleNamerOrder(
  sessionAgentSlug: string,
  namer: 'auto' | 'codex' | 'claude',
): Array<'codex' | 'claude'> {
  if (namer !== 'auto') return [namer];
  return sessionAgentSlug === 'claude' ? ['claude', 'codex'] : ['codex', 'claude'];
}

function titleUnits(title: string): string[] {
  const normalized = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!normalized) return [];
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words;
  return [...normalized];
}

export function shouldReplaceAutoTitle(currentTitle: string, nextTitle: string): boolean {
  const current = currentTitle.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const next = nextTitle.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (!current || !next || current === next || current.includes(next) || next.includes(current)) return false;
  const currentUnits = new Set(titleUnits(currentTitle));
  const nextUnits = new Set(titleUnits(nextTitle));
  const shared = [...currentUnits].filter((unit) => nextUnits.has(unit)).length;
  const union = new Set([...currentUnits, ...nextUnits]).size;
  return union === 0 || shared / union < 0.5;
}

export function isNewAgentSessionId(previous: string | null, next: string | null): boolean {
  return Boolean(previous && next && previous !== next);
}

async function runNamer(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: TITLE_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    return normalizeGeneratedTitle(stdout);
  } catch {
    return null;
  }
}

export async function generateAgentTitle(
  sessionAgentSlug: string,
  agentName: string,
  rawContext: string,
  options: {
    namer: 'auto' | 'codex' | 'claude';
    models: Record<string, string>;
    currentTitle?: string;
  },
): Promise<string | null> {
  const context = cleanTerminalContext(rawContext);
  if (context.length < 40) return null;
  const prompt = buildAutoTitlePrompt(agentName, context, options.currentTitle);

  const preferred = resolveTitleNamerOrder(sessionAgentSlug, options.namer);
  for (const namer of preferred) {
    const model = options.models[namer];
    const title = namer === 'claude'
      ? await runNamer('claude', [
        ...(model ? ['--model', model] : []),
        '--no-session-persistence',
        '-p',
        prompt,
      ])
      : await runNamer('codex', [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--color',
        'never',
        ...(model ? ['--model', model] : []),
        prompt,
      ]);
    if (title) return title;
  }
  return null;
}
