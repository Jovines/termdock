import { getTitleNamerCatalog, runTitleNamer } from './titleNamerCatalog.js';

const MAX_CONTEXT_CHARS = 16_000;
export const AUTO_TITLE_MIN_CONTEXT_CHARS = 12;
export const AUTO_TITLE_LONG_RUNNING_CONTEXT_CHARS = 800;
export const AUTO_TITLE_LONG_RUNNING_DELAY_MS = 30_000;

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

export function hasSubstantiveAutoTitleContext(input: string): boolean {
  return cleanTerminalContext(input).length >= AUTO_TITLE_LONG_RUNNING_CONTEXT_CHARS;
}

export function isLongRunningAutoTitleTurnEligible(
  status: string | null | undefined,
  observedPrompt: boolean,
  turnActive: boolean,
): boolean {
  return observedPrompt && turnActive && status === 'working';
}

export function buildAutoTitlePrompt(
  agentName: string,
  context: string,
  currentTitle?: string,
  userPreference?: string,
): string {
  const preference = userPreference?.trim().slice(0, 2000);
  return [
    `Create a concise title for this ${agentName} coding session.`,
    "Describe the session's primary purpose: the user problem being solved or the intended change.",
    'Choose a stable title that represents the whole session, not the latest activity, implementation details, commands, progress, or completion status.',
    'If several related tasks support one broader goal, title that shared goal.',
    currentTitle
      ? `Current title: ${JSON.stringify(currentTitle)}. Keep it unchanged if it still represents the session's primary purpose; rename only when that primary purpose clearly changed.`
      : 'This session has no previous automatic title.',
    'Use the dominant language of the terminal content. Return only the title.',
    'Constraints: 6-18 Chinese characters or 3-10 words; no quotes; no markdown; no trailing punctuation.',
    ...(preference ? [
      '',
      'Apply these optional user title preferences when they are relevant:',
      '<user_title_preferences>',
      preference,
      '</user_title_preferences>',
    ] : []),
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
  namer: string,
  availableSlugs: string[] = ['codex', 'claude'],
): string[] {
  if (namer !== 'auto') return [namer];
  return [...new Set([
    ...(availableSlugs.includes(sessionAgentSlug) ? [sessionAgentSlug] : []),
    'codex',
    'claude',
    ...availableSlugs,
  ])].filter((slug) => availableSlugs.includes(slug));
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

export function isAutoTitleReevaluationDue(
  updatedAt: number,
  intervalMinutes: number,
  now = Date.now(),
): boolean {
  return now - updatedAt >= Math.max(5, intervalMinutes) * 60_000;
}

export async function generateAgentTitle(
  sessionAgentSlug: string,
  agentName: string,
  rawContext: string,
  options: {
    namer: string;
    models: Record<string, string>;
    currentTitle?: string;
    userPreference?: string;
  },
): Promise<string | null> {
  const context = cleanTerminalContext(rawContext);
  if (context.length < AUTO_TITLE_MIN_CONTEXT_CHARS) return null;
  const prompt = buildAutoTitlePrompt(agentName, context, options.currentTitle, options.userPreference);

  const catalog = await getTitleNamerCatalog();
  const preferred = resolveTitleNamerOrder(
    sessionAgentSlug,
    options.namer,
    catalog.filter((entry) => entry.available).map((entry) => entry.slug),
  );
  for (const namer of preferred) {
    const model = options.models[namer];
    const output = await runTitleNamer(namer, prompt, model);
    const title = output ? normalizeGeneratedTitle(output) : null;
    if (title) return title;
  }
  return null;
}
