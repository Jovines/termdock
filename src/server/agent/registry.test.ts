import { describe, expect, it } from 'vitest';
import {
  agentBySlug,
  buildResumeCommand,
  detectAgentFromArgv,
  detectAgentFromCommand,
} from './registry.js';

describe('detectAgentFromArgv', () => {
  it('detects native binaries', () => {
    expect(detectAgentFromArgv(['claude'])?.slug).toBe('claude');
    expect(detectAgentFromArgv(['/opt/homebrew/bin/codex', '--model', 'o3'])?.slug).toBe('codex');
    expect(detectAgentFromArgv(['/usr/local/bin/gemini'])?.slug).toBe('gemini');
    expect(detectAgentFromArgv(['cursor-agent'])?.slug).toBe('cursor');
    expect(detectAgentFromArgv(['claude/'])?.slug).toBe('claude');
  });

  it('strips leading env assignments', () => {
    expect(detectAgentFromArgv(['FOO=1', 'BAR=baz', 'claude'])?.slug).toBe('claude');
  });

  it('detects interpreter-wrapped agents by package dir', () => {
    expect(
      detectAgentFromArgv(['node', '/Users/x/.npm/_npx/node_modules/@anthropic-ai/claude-code/cli.js'])?.slug,
    ).toBe('claude');
    expect(detectAgentFromArgv(['npx', '@anthropic-ai/claude-code'])?.slug).toBe('claude');
    expect(detectAgentFromArgv(['npx', '@google/gemini-cli'])?.slug).toBe('gemini');
    expect(
      detectAgentFromArgv(['python3', '/usr/lib/python3.12/site-packages/aider/__main__.py'])?.slug,
    ).toBe('aider');
  });

  it('does not match non-interpreter arguments', () => {
    expect(detectAgentFromArgv(['cat', 'codex.md'])).toBeNull();
    expect(detectAgentFromArgv(['vim', 'claude-code/notes.txt'])).toBeNull();
    expect(detectAgentFromArgv(['less', 'aider'])).toBeNull();
    expect(detectAgentFromArgv(['zsh'])).toBeNull();
    expect(detectAgentFromArgv(['node', 'server.js'])).toBeNull();
    expect(detectAgentFromArgv([])).toBeNull();
  });

  it('detects newer agents by command', () => {
    const cases: Array<[string, string]> = [
      ['auggie', 'auggie'],
      ['agy', 'antigravity'],
      ['vibe-acp', 'vibe'],
      ['grok', 'grok'],
      ['/usr/local/bin/qwen', 'qwen'],
      ['pi', 'pi'],
      ['hermes', 'hermes'],
    ];
    for (const [cmd, slug] of cases) {
      expect(detectAgentFromArgv([cmd])?.slug).toBe(slug);
    }
  });

  it('applies custom wrapper rules to the launcher only', () => {
    const custom = { cc: 'claude' };
    expect(detectAgentFromArgv(['/home/x/bin/cc', '-c'], custom)?.slug).toBe('claude');
    // A rule naming an unknown agent is ignored
    expect(detectAgentFromArgv(['cc'], { cc: 'hal9000' })).toBeNull();
    // Custom rules never scan interpreter arguments
    expect(detectAgentFromArgv(['node', 'cc/cli.js'], custom)).toBeNull();
    // Built-ins still win on their own names
    expect(detectAgentFromArgv(['codex'], { codex: 'claude' })?.slug).toBe('codex');
  });

  it('detects from raw command lines', () => {
    expect(detectAgentFromCommand('claude --resume abc')?.slug).toBe('claude');
    expect(detectAgentFromCommand('claude.exe')?.slug).toBe('claude');
    expect(detectAgentFromCommand('node /x/node_modules/@anthropic-ai/claude-code/cli.js')?.slug).toBe('claude');
    expect(detectAgentFromCommand('npx.cmd @google/gemini-cli')?.slug).toBe('gemini');
    expect(detectAgentFromCommand('notepad claude.txt')).toBeNull();
    expect(detectAgentFromCommand('cat codex.md')).toBeNull();
    expect(detectAgentFromCommand('')).toBeNull();
  });
});

describe('agent registry metadata', () => {
  it('every alias resolves back to its agent', () => {
    expect(agentBySlug('claude')?.displayName).toBe('Claude Code');
    expect(agentBySlug(' QWEN ')?.slug).toBe('qwen');
    expect(agentBySlug('nope')).toBeNull();
  });
});

describe('buildResumeCommand', () => {
  const claude = agentBySlug('claude')!;
  const codex = agentBySlug('codex')!;
  const grok = agentBySlug('grok')!;

  it('builds shell-safe resume commands', () => {
    expect(buildResumeCommand(claude, 'abc-123', null)).toBe('claude --resume abc-123');
    expect(buildResumeCommand(codex, 'th_read.9', null)).toBe('codex resume th_read.9');
    expect(buildResumeCommand(agentBySlug('aider')!, 'abc', null)).toBeNull();
    // An id carrying shell syntax is refused outright
    expect(buildResumeCommand(claude, 'abc; rm -rf /', null)).toBeNull();
    expect(buildResumeCommand(claude, '$(boom)', null)).toBeNull();
    expect(buildResumeCommand(claude, '', null)).toBeNull();
  });

  it('carries launch flags onto the resume command', () => {
    expect(buildResumeCommand(claude, 'abc-123', ['claude', '--dangerously-skip-permissions']))
      .toBe('claude --dangerously-skip-permissions --resume abc-123');
    expect(buildResumeCommand(claude, 'abc', ['claude', '--model', 'opus']))
      .toBe('claude --model opus --resume abc');
    // Interpreter-wrapped launch: flags start after the token naming the agent
    expect(buildResumeCommand(claude, 'abc', ['node', '/x/node_modules/@anthropic-ai/claude-code/cli.js', '--dangerously-skip-permissions']))
      .toBe('claude --dangerously-skip-permissions --resume abc');
    // Stale session-targeting flags are stripped — the new id must win
    expect(buildResumeCommand(claude, 'new-id', ['claude', '--resume', 'old-id', '--model', 'opus']))
      .toBe('claude --model opus --resume new-id');
    // Codex: flags after the positional id; relaunched `codex resume <old>` sheds the old id
    expect(buildResumeCommand(codex, 'id-1', ['codex', '--yolo'])).toBe('codex resume id-1 --yolo');
    expect(buildResumeCommand(codex, 'id-2', ['codex', 'resume', 'id-1', '--yolo']))
      .toBe('codex resume id-2 --yolo');
    expect(buildResumeCommand(codex, 'id-3', ['codex', 'resume', '--last', '--yolo']))
      .toBe('codex resume id-3 --yolo');
  });

  it('drops the whole tail on anything ambiguous', () => {
    // Shell-unsafe token
    expect(buildResumeCommand(claude, 'abc', ['claude', '--allowedTools', 'Bash(git:*)']))
      .toBe('claude --resume abc');
    // Positional prompt
    expect(buildResumeCommand(claude, 'abc', ['claude', 'fix-the-bug']))
      .toBe('claude --resume abc');
    // Two consecutive bare words = positional prompt
    expect(buildResumeCommand(claude, 'abc', ['claude', '--model', 'opus', 'review', 'this']))
      .toBe('claude --resume abc');
    // A leading env assignment doesn't mis-anchor the flag tail
    expect(buildResumeCommand(claude, 'abc', ['CLAUDE_CONFIG_DIR=/opt/claude', 'claude', '--dangerously-skip-permissions']))
      .toBe('claude --dangerously-skip-permissions --resume abc');
    // No token names the agent (custom wrapper) → bare
    expect(buildResumeCommand(claude, 'abc', ['cc', '--dangerously-skip-permissions']))
      .toBe('claude --resume abc');
  });

  it('strips grok session/worktree targeting', () => {
    expect(buildResumeCommand(grok, 'g-2', ['grok', '--model', 'grok-code']))
      .toBe('grok --model grok-code --resume g-2');
    expect(buildResumeCommand(grok, 'g-2', ['grok', '--resume', 'g-1', '--fork-session']))
      .toBe('grok --resume g-2');
    expect(buildResumeCommand(grok, 'g-3', ['grok', '-w', '--worktree-ref', 'main', '--yolo']))
      .toBe('grok --yolo --resume g-3');
  });
});
