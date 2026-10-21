// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { detectTmuxRecoveryIncident, retainDismissedTmuxSessions } from '../utils/tmuxRecovery.js';

// Exercise the actual route functions without boot-time tmux configuration or
// access to the developer's persisted sessions.
const source = fs.readFileSync(new URL('./terminal.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true);
function routeFunctions(names: string[], setup: string, dependencies: Record<string, unknown>) {
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
  const context = vm.createContext({ Date, console, ...dependencies });
  vm.runInContext(ts.transpileModule(`${setup}\n${functions}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
  return context;
}

it('passes failed and unavailable inventory scans as unknown to recovery detection', async () => {
  const list = vi.fn().mockRejectedValue(new Error('tmux query timed out'));
  const observe = vi.fn();
  const context = routeFunctions(['buildSessionInventory'], '', {
    getTmuxStatus: vi.fn().mockResolvedValue({ available: true }),
    listLiveTmuxInventorySessions: list, observeTmuxServerGeneration: observe,
    globalSessionState: { sessions: [], updatedAt: 1 }, terminalSessions: new Map(),
    getErrorMessage: String, isTmuxServerMissingMessage: () => false,
    getTmuxRecoveryView: () => null, inventoryTmuxLiveness: new WeakMap(),
    dynamicTmuxMetadata: { retain: vi.fn() },
  });
  await context.buildSessionInventory();
  expect(observe).toHaveBeenLastCalledWith([], false);
  context.getTmuxStatus.mockResolvedValue({ available: false });
  await context.buildSessionInventory();
  expect(list).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenLastCalledWith([], false);
  context.getTmuxStatus.mockResolvedValue({ available: true });
  list.mockResolvedValue([]);
  await context.buildSessionInventory();
  expect(observe).toHaveBeenLastCalledWith([], true);
});

it('preserves the generation and acknowledgements on query failures, then detects confirmed loss', async () => {
  const state = { lastServerPid: 137991, incident: null, dismissedSessionIds: ['dismissed'] };
  const persist = vi.fn();
  const pid = vi.fn().mockResolvedValue(137991);
  const context = routeFunctions(['observeTmuxServerGeneration'], '', {
    tmuxRecoveryState: state, persistTmuxRecoveryState: persist, getTmuxServerPid: pid,
    globalSessionState: { sessions: Array.from({ length: 41 }, (_, i) => ({
      sessionId: `s${i}`, mode: 'tmux', tmuxSessionName: `t${i}`, cwd: '/work', agentResume: { sessionId: `native${i}` },
    })) },
    terminalSessions: new Map(), intentionallyDeletingTmuxSessions: new Set(),
    detectTmuxRecoveryIncident, retainDismissedTmuxSessions, getErrorMessage: String,
  });
  await context.observeTmuxServerGeneration([], false);
  expect(pid).not.toHaveBeenCalled();
  expect(state).toEqual({ lastServerPid: 137991, incident: null, dismissedSessionIds: ['dismissed'] });
  pid.mockRejectedValueOnce(new Error('pid query timed out'));
  await context.observeTmuxServerGeneration([], true);
  expect(persist).not.toHaveBeenCalled();
  expect(state.incident).toBeNull();
  await context.observeTmuxServerGeneration([], true);
  expect(state.incident).toMatchObject({ previousServerPid: 137991, currentServerPid: 137991 });
  expect((state.incident as unknown as { affectedSessionIds: string[] }).affectedSessionIds).toHaveLength(41);
});

function recoveryFixture(program: string | null, rawArgs: string | null = null) {
  const record = { sessionId: 'frontend', mode: 'tmux', tmuxSessionName: 'original', cwd: '/work',
    agentResume: { slug: 'trae', sessionId: 'native' } };
  const state = { incident: { id: 'incident', affectedSessionIds: ['frontend', 'other'] } };
  const write = vi.fn();
  const metadata = vi.fn().mockResolvedValue(program ? { program, rawArgs } : null);
  const context = routeFunctions(['restoreTmuxRecoverySession'], '', {
    globalSessionState: { sessions: [record] }, tmuxRecoveryState: state,
    agentBySlug: () => ({ slug: 'trae' }), buildResumeCommand: () => 'trae --resume native',
    findActiveAgentResumeOwner: () => null, findExternalCodexWriter: async () => null,
    collaborationDeliveryWorker: { reconfigure: async (_id: string, run: () => unknown) => run() },
    tmuxLifecycle: { run: async (_key: string, run: () => unknown) => run() },
    prepareManagedTmuxSessionUnlocked: vi.fn(), resolveLiveTmuxMetadata: metadata,
    shellNamesBackend: new Set(['zsh', 'bash']), agentCustomCommands: () => [],
    detectAgentFromCommand: (command: string) => command.includes('traex') ? { slug: 'trae' } : null,
    collaborationRouting: { get: () => null }, beginAgentLaunchCheck: vi.fn(),
    writeAutomaticTerminalPrompt: write, persistTmuxRecoveryState: vi.fn(),
    runTmux: async () => '', getErrorMessage: String,
  });
  return { context, state, write, metadata };
}

it('retains a running Agent pane and clears its stale recovery entry without submitting resume', async () => {
  const { context, state, write, metadata } = recoveryFixture('node', 'node /app/traex');
  await context.restoreTmuxRecoverySession('op', 'frontend', vi.fn());
  expect(metadata).toHaveBeenCalledWith('original', false, true);
  expect(write).not.toHaveBeenCalled();
  expect(state.incident.affectedSessionIds).toEqual(['other']);
  expect(context.collaborationRouting.get()).toBeNull();
});

it('clears stale recovery entries when the exact Agent already has a backend owner', async () => {
  const { context, state, write, metadata } = recoveryFixture('traex');
  context.findActiveAgentResumeOwner = () => 'backend';
  await context.restoreTmuxRecoverySession('op', 'frontend', vi.fn());
  expect(metadata).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(state.incident.affectedSessionIds).toEqual(['other']);
});

it('resumes only a confirmed shell and rejects unknown or unrelated busy foregrounds', async () => {
  for (const program of [null, 'vim', 'zsh']) {
    const { context, state, write } = recoveryFixture(program);
    const restore = context.restoreTmuxRecoverySession('op', 'frontend', vi.fn());
    if (program === 'zsh') {
      await restore;
      expect(write).toHaveBeenCalledOnce();
      expect(state.incident.affectedSessionIds).toEqual(['other']);
    } else {
      await expect(restore).rejects.toMatchObject({ code: program ? 'RECOVERY_TARGET_BUSY' : 'RECOVERY_TARGET_UNCONFIRMED' });
      expect(write).not.toHaveBeenCalled();
      expect(state.incident.affectedSessionIds).toContain('frontend');
    }
  }
});

it('keeps recovery pending and submits nothing when live verification times out', async () => {
  const { context, state, write, metadata } = recoveryFixture('zsh');
  metadata.mockRejectedValue(new Error('tmux query timed out'));
  await expect(context.restoreTmuxRecoverySession('op', 'frontend', vi.fn())).rejects.toThrow('timed out');
  expect(write).not.toHaveBeenCalled();
  expect(state.incident.affectedSessionIds).toContain('frontend');
});

it('treats malformed pid responses as unknown and only confirmed missing servers as null', async () => {
  const run = vi.fn().mockResolvedValue('');
  const context = routeFunctions(['getTmuxServerPid'], '', {
    runTmux: run, getErrorMessage: String,
    isTmuxServerMissingMessage: (message: string) => message.includes('no server running'),
  });
  await expect(context.getTmuxServerPid()).rejects.toThrow('Invalid tmux server pid');
  run.mockRejectedValueOnce(new Error('tmux query timed out'));
  await expect(context.getTmuxServerPid()).rejects.toThrow('timed out');
  run.mockRejectedValueOnce(new Error('no server running'));
  expect(await context.getTmuxServerPid()).toBeNull();
  run.mockResolvedValue('137991');
  expect(await context.getTmuxServerPid()).toBe(137991);
});

it('dismisses the incident and hides its paused operation on subsequent inventory views', async () => {
  const route = ast.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === 'router.delete'
    && node.expression.arguments[0]?.getText(ast) === "'/tmux/recovery'") as ts.ExpressionStatement;
  const handler = (route.expression as ts.CallExpression).arguments[1].getText(ast);
  const operation = { id: 'op', incidentId: 'incident', state: 'paused', paused: true, running: 0,
    dismissedAt: undefined as number | undefined, items: [] };
  const state = { incident: { id: 'incident', affectedSessionIds: ['frontend'] }, dismissedSessionIds: [] };
  const persist = vi.fn();
  const broadcast = vi.fn();
  const context = routeFunctions(['getTmuxRecoveryView'], `
    let latestSessionInventoryAt = 123;
    globalThis.dismissRecovery = ${handler};
    globalThis.inventoryAge = () => latestSessionInventoryAt;
  `, {
    tmuxRecoveryState: state,
    tmuxRecoveryOperations: {
      latest: () => operation,
      dismissPausedOperations: vi.fn(async () => { operation.dismissedAt = 100; }),
    },
    persistTmuxRecoveryState: persist, broadcastClientState: broadcast, getErrorMessage: String,
  });
  const response = { status: vi.fn().mockReturnThis(), send: vi.fn(), json: vi.fn() };
  await context.dismissRecovery({}, response);
  expect(response.status).toHaveBeenCalledWith(204);
  expect(state.incident).toBeNull();
  expect(state.dismissedSessionIds).toEqual(['frontend']);
  expect(context.getTmuxRecoveryView()).toBeNull();
  expect(context.inventoryAge()).toBe(0);
  expect(persist).toHaveBeenCalledOnce();
  expect(broadcast).toHaveBeenCalledOnce();

  context.tmuxRecoveryOperations.dismissPausedOperations.mockRejectedValueOnce(Object.assign(new Error('still running'), { code: 'RECOVERY_OPERATION_ACTIVE' }));
  await context.dismissRecovery({}, response);
  expect(response.status).toHaveBeenLastCalledWith(409);
  expect(persist).toHaveBeenCalledOnce();
});
