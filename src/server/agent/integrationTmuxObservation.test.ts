// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { selectCollaborationPane } from './collaborationRouting.js';

// Exercise the route's real observation code without loading its live user
// inventory, watcher or server. The second layout query used to multiply tmux
// spawns and mix two observation times in one integration binding check.
const source = fs.readFileSync(new URL('../routes/terminal.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true);
const inspect = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'inspectCollaborationTmux')!;
const declaration = ast.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
  .find(node => ts.isIdentifier(node.name) && node.name.text === 'integrationSessionAdapter')!;
const adapter = declaration.initializer as ts.ObjectLiteralExpression;
const method = adapter.properties.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'inspect')!;

function fixture(panes = 1) {
  const layout = { serverPid: 10, sessionId: '$1', sessionName: 'owned', activePaneId: '%1', windows: [{ panes: Array.from({ length: panes }, (_, index) => ({
    id: `%${index + 1}`, pid: 100 + index, currentPath: '/fixture',
  })) }] };
  const getTmuxLayout = vi.fn(async () => layout);
  const observeProgramNativeIdentity = vi.fn(async () => ({ nativeId: 'native', failure: null, source: 'linux-flock-owner' }));
  const context = vm.createContext({ process: { platform: 'linux' },
    getTmuxLayout, runTmux: vi.fn(async (args: string[]) => args[0] === 'display-message' ? '10' : ''),
    getErrorMessage: String, getProcessSnapshot: vi.fn(), resolveTmuxPaneProgram: async () => ({ command: 'fixture', rawArgs: 'fixture resume native' }),
    detectAgentFromCommand: () => ({ slug: 'fixture' }), agentCustomCommands: () => [], observeProgramNativeIdentity,
    globalSessionState: { sessions: [] }, shellNamesBackend: new Set(), normalizeProgramName: (name: string) => name,
    selectCollaborationPane, integrationNativeIdentity: () => undefined,
    integrationTerminalRecord: () => ({ tmuxSessionName: 'owned', backendSessionId: 'backend' }), terminalSessions: new Map(),
    integrationPaneIsIdleShell: async () => false, collaborationRouting: { get: () => null },
    integrationError(code: string) { throw Object.assign(new Error(code), { code }); },
  });
  const code = `${inspect.getText(ast)}; const adapter = {${method.getText(ast)}};`;
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const record = { session_id: 'session', agent_slug: 'fixture', agent_native_session_id: 'native',
    terminal_binding: { serverPid: 10, sessionId: '$1', paneId: '%1', panePid: 100, agentSlug: 'fixture', nativeSessionId: 'native' } };
  context.record = record;
  return { getTmuxLayout, observeProgramNativeIdentity, context };
}

it('shares one fresh layout within an observation but obtains a new one on the next observation', async () => {
  const f = fixture();
  expect(await vm.runInContext('adapter.inspect(record)', f.context)).toMatchObject({ running: true, nativeId: 'native' });
  expect(f.getTmuxLayout).toHaveBeenCalledTimes(1); expect(f.observeProgramNativeIdentity).toHaveBeenCalledTimes(1);
  await vm.runInContext('adapter.inspect(record)', f.context);
  expect(f.getTmuxLayout).toHaveBeenCalledTimes(2); expect(f.observeProgramNativeIdentity).toHaveBeenCalledTimes(2);
});

it('still rejects ambiguous panes and propagates exact native identity conflicts', async () => {
  const many = fixture(2);
  await expect(vm.runInContext('adapter.inspect(record)', many.context)).rejects.toMatchObject({ code: 'SESSION_IDENTITY_MISMATCH' });
  const wrong = fixture();
  wrong.observeProgramNativeIdentity.mockResolvedValue({ nativeId: 'other', failure: 'NATIVE_SESSION_IDENTITY_CONFLICT' as never, source: 'linux-flock-owner' });
  await expect(vm.runInContext('adapter.inspect(record)', wrong.context)).rejects.toMatchObject({ code: 'NATIVE_SESSION_ID_MISMATCH' });
});
