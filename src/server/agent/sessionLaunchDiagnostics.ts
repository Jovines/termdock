import { CollaborationError } from './collaborationProtocol.js';
import { TerminalInputTargetChangedError, type PromptWriteStage } from './terminalInput.js';

export type LaunchPhase = 'configuration' | 'runtime_prepare' | 'runtime_verify' | 'binding_persist'
  | 'native_owner_check' | 'launch_intent' | 'binding_observe' | 'reconciled_shell' | PromptWriteStage;
export interface SessionLaunchDiagnostics {
  operation_id: string; generation: number; kind: 'cold_start' | 'cold_retry' | 'native_restore';
  phase: LaunchPhase; updated_at: number; error_code: string | null; reason_code: string | null;
  paste: 'not_attempted' | 'attempted' | 'write_returned';
  submit: 'not_attempted' | 'attempted' | 'write_returned';
  runtime_exists: boolean | null;
  steps: Array<{ phase: LaunchPhase; at: number }>;
  target_change?: TerminalInputTargetChangedError['evidence'];
}
export function beginLaunchDiagnostics(operation_id: string, generation: number,
  kind: SessionLaunchDiagnostics['kind']): SessionLaunchDiagnostics {
  const now = Date.now();
  return { operation_id, generation, kind, phase: 'configuration', updated_at: now,
    error_code: null, reason_code: null, paste: 'not_attempted', submit: 'not_attempted',
    runtime_exists: null, steps: [{ phase: 'configuration', at: now }] };
}
export function launchProgress(current: SessionLaunchDiagnostics, phase: LaunchPhase): SessionLaunchDiagnostics {
  const now = Date.now();
  return { ...current, phase, updated_at: now, steps: [...current.steps, { phase, at: now }].slice(-24),
    paste: phase === 'paste_attempted' ? 'attempted' : phase === 'paste_written' ? 'write_returned' : current.paste,
    submit: phase === 'submit_attempted' ? 'attempted' : phase === 'submit_written' ? 'write_returned' : current.submit };
}
/** Error text/stdout/argv are never copied into durable diagnostics. */
export function launchFailure(current: SessionLaunchDiagnostics, error: unknown, error_code: string): SessionLaunchDiagnostics {
  const value = error as { code?: unknown; message?: unknown } | null;
  const standard = new Set(['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ETIMEDOUT', 'EPIPE', 'ECONNRESET',
    'TMUX_PANE_CHANGED', 'TMUX_PANE_IN_MODE', 'SESSION_REMOVED', 'SHELL_BACKEND_CHANGED']);
  const reason_code = error instanceof TerminalInputTargetChangedError ? error.code
    : error instanceof CollaborationError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code
    : typeof value?.code === 'string' && standard.has(value.code) ? value.code
    : typeof value?.message === 'string' && standard.has(value.message) ? value.message : 'UNCLASSIFIED_LAUNCH_ERROR';
  return { ...current, updated_at: Date.now(), error_code, reason_code,
    ...(error instanceof TerminalInputTargetChangedError ? { target_change: error.evidence } : {}) };
}
