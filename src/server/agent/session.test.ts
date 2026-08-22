import { describe, expect, it } from 'vitest';
import {
  agentEventMatchesCurrentAgent,
  applyAgentEvent,
  buildHookSequence,
  defaultAgentSessionState,
  parseAgentEvent,
  type AgentEvent,
  type AgentEventKind,
} from './session.js';
import { agentBySlug } from './registry.js';

function ev(kind: AgentEventKind, opts: Partial<AgentEvent> = {}): AgentEvent {
  return {
    agent: agentBySlug('claude'),
    agentSlug: 'claude',
    kind,
    sessionId: null,
    message: null,
    promptPayload: null,
    cwd: null,
    status: null,
    ...opts,
  };
}

describe('parseAgentEvent', () => {
  it('parses well-formed sentinel events', () => {
    const parsed = parseAgentEvent(
      '777;notify;termdock://cli-agent;{"v":1,"agent":"claude","event":"permission-request","session_id":"abc-123","message":"Claude needs your permission to use Bash"}',
    );
    expect(parsed?.agent?.slug).toBe('claude');
    expect(parsed?.agentSlug).toBe('claude');
    expect(parsed?.kind).toBe('permission-request');
    expect(parsed?.sessionId).toBe('abc-123');
    expect(parsed?.message).toContain('permission');
    expect(parsed?.promptPayload).toBeNull();
  });

  it('rejects non-sentinel payloads, unknown events, and malformed JSON', () => {
    expect(parseAgentEvent('777;notify;Build;done')).toBeNull();
    expect(parseAgentEvent('777;notify;termdock://cli-agent;{"event":"quantum-leap"}')).toBeNull();
    expect(parseAgentEvent('777;notify;termdock://cli-agent;{oops')).toBeNull();
    expect(parseAgentEvent('9;4;3;0')).toBeNull();
  });
});

describe('agent event identity isolation', () => {
  it('accepts an event for an unclaimed or matching pane and rejects a foreign Agent', () => {
    const claude = agentBySlug('claude')!;
    const codex = agentBySlug('codex')!;
    const event = ev('stop', { agent: claude });
    expect(agentEventMatchesCurrentAgent(null, event)).toBe(true);
    expect(agentEventMatchesCurrentAgent(claude, event)).toBe(true);
    expect(agentEventMatchesCurrentAgent(codex, event)).toBe(false);
  });

  it('rejects stale events from an Agent that is no longer registered', () => {
    const codex = agentBySlug('codex')!;
    const event = ev('question-asked', { agent: null, agentSlug: 'removed-plugin' });
    expect(agentEventMatchesCurrentAgent(null, event)).toBe(false);
    expect(agentEventMatchesCurrentAgent(codex, event)).toBe(false);
  });
});

describe('buildHookSequence ↔ parseAgentEvent round-trip', () => {
  it('locks the two ends of the protocol together', () => {
    const seq = buildHookSequence(
      'claude',
      'notification',
      '{"session_id":"abc-123","message":"Claude needs your permission","cwd":"/w"}',
    );
    // Strip OSC framing (ESC ] … BEL) to get the payload the sniffer delivers
    const payload = seq.slice(2, -1);
    const parsed = parseAgentEvent(payload);
    expect(parsed?.agent?.slug).toBe('claude');
    expect(parsed?.kind).toBe('notification');
    expect(parsed?.sessionId).toBe('abc-123');
    expect(parsed?.message).toContain('permission');
    expect(parsed?.cwd).toBe('/w');

    // Garbage stdin still yields a well-formed bare event
    const bare = parseAgentEvent(buildHookSequence('claude', 'stop', 'not json at all').slice(2, -1));
    expect(bare?.kind).toBe('stop');
    expect(bare?.sessionId).toBeNull();

    // Grok's envelope is camelCase; the fields must land in snake_case
    const grok = parseAgentEvent(
      buildHookSequence('grok', 'session-start', '{"hookEventName":"session_start","sessionId":"g-42","cwd":"/w"}').slice(2, -1),
    );
    expect(grok?.agent?.slug).toBe('grok');
    expect(grok?.sessionId).toBe('g-42');
  });

  it('preserves differing prompt-submit payload shapes without interpreting them', () => {
    const claude = parseAgentEvent(buildHookSequence(
      'claude',
      'prompt-submit',
      '{"session_id":"c-1","prompt":"修复自动标题","cwd":"/repo"}',
    ).slice(2, -1));
    expect(claude?.promptPayload).toBe('{"session_id":"c-1","prompt":"修复自动标题","cwd":"/repo"}');

    const custom = parseAgentEvent(buildHookSequence(
      'codex',
      'prompt-submit',
      '{"request":{"content":[{"type":"text","text":"Keep titles stable"}]},"cwd":"/repo"}',
    ).slice(2, -1));
    expect(custom?.promptPayload).toBe(
      '{"request":{"content":[{"type":"text","text":"Keep titles stable"}]},"cwd":"/repo"}',
    );
  });
});

describe('agent session state machine', () => {
  it('applies plugin presentation while preserving a stable semantic phase', () => {
    const s = defaultAgentSessionState();
    applyAgentEvent(s, ev('prompt-submit', {
      status: {
        id: 'indexing',
        phase: 'working',
        label: 'Indexing workspace',
        indicator: 'pulse',
        tone: 'info',
      },
    }));
    expect(s.status).toBe('working');
    expect(s.presentation?.id).toBe('indexing');

    applyAgentEvent(s, ev('tool-complete'));
    expect(s.status).toBe('working');
    expect(s.presentation).toBeNull();
  });

  it('follows the turn lifecycle', () => {
    const s = defaultAgentSessionState();
    expect(s.status).toBe('idle');

    applyAgentEvent(s, ev('session-start', { sessionId: 'sid-1' }));
    expect(s.status).toBe('idle');
    expect(s.sessionId).toBe('sid-1');
    expect(s.rich).toBe(true);

    applyAgentEvent(s, ev('prompt-submit'));
    expect(s.status).toBe('working');

    // A Notification arriving MID-TURN (while working) is a real block
    applyAgentEvent(s, ev('notification', { message: 'Claude needs your permission' }));
    expect(s.status).toBe('waiting');
    expect(s.message).toContain('permission');

    // The user approved: the granted tool completes → back to work
    applyAgentEvent(s, ev('tool-complete'));
    expect(s.status).toBe('working');
    expect(s.message).toBeNull();

    // Tool completions during normal work are a no-op, not state churn
    applyAgentEvent(s, ev('tool-complete'));
    expect(s.status).toBe('working');

    applyAgentEvent(s, ev('stop'));
    expect(s.status).toBe('done');

    // A straggler tool-complete after the turn ended must not resurrect working
    applyAgentEvent(s, ev('tool-complete'));
    expect(s.status).toBe('done');

    // A Notification BETWEEN turns (idle nudge) must not fabricate a block
    applyAgentEvent(s, ev('notification', { message: 'Claude is waiting for your input' }));
    expect(s.status).toBe('done');

    // Session end goes idle but KEEPS the id — ended sessions resume
    applyAgentEvent(s, ev('session-end'));
    expect(s.status).toBe('idle');
    expect(s.sessionId).toBe('sid-1');
  });

  it('counts tool completions even when the status holds still', () => {
    const s = defaultAgentSessionState();
    applyAgentEvent(s, ev('prompt-submit'));
    expect(s.activity).toBe(0);

    for (let n = 1; n <= 3; n++) {
      applyAgentEvent(s, ev('tool-complete'));
      expect(s.status).toBe('working');
      expect(s.activity).toBe(n);
    }

    applyAgentEvent(s, ev('stop'));
    applyAgentEvent(s, ev('tool-complete'));
    expect(s.status).toBe('done');
    expect(s.activity).toBe(4);

    // Session end resets plenty of state but not the counter
    applyAgentEvent(s, ev('session-end'));
    expect(s.activity).toBe(4);
  });

  it('tracks and releases the agent cwd claim', () => {
    const s = defaultAgentSessionState();
    applyAgentEvent(s, ev('session-start', { cwd: '/repo' }));
    expect(s.agentCwd).toBe('/repo');

    // EnterWorktree lands as a tool-complete carrying the new directory
    applyAgentEvent(s, ev('tool-complete', { cwd: '/repo/.claude/worktrees/fix-x' }));
    expect(s.agentCwd).toBe('/repo/.claude/worktrees/fix-x');

    // An event without a cwd keeps the previous claim
    applyAgentEvent(s, ev('stop'));
    expect(s.agentCwd).toBe('/repo/.claude/worktrees/fix-x');

    applyAgentEvent(s, ev('session-end'));
    expect(s.agentCwd).toBeNull();
  });
});
