// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { mergeReloadedSessionState } from './sessionLaunchState.js';

// Exercise the route's real read/commit boundary without importing the router
// and its live service, watchers, or user-owned session store.
const source = fs.readFileSync(new URL('../routes/terminal.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true);
const loader = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'loadGlobalSessionStateFromDisk')!;
it('does not clear a live launch token when a real loader await receives an old disk snapshot', async () => {
  const old = { sessionId: 'role', backendSessionId: 'backend', agentLaunchGeneration: null, agentLaunchCheck: null };
  let finish!: (value: unknown) => void;
  const diskRead = new Promise(resolve => { finish = resolve; });
  const context = vm.createContext({ structuredClone, mergeReloadedSessionState,
    console: { log: vi.fn(), warn: vi.fn() }, getErrorMessage: String,
    GLOBAL_SESSION_STATE_FILE: 'isolated-fixture', globalSessionState: { sessions: [old], updatedAt: 1 },
    readJsonFileIfExists: () => diskRead, deduplicateGlobalSessions: (items: unknown) => items,
    normalizePersistedClientSession: (item: unknown) => item, migrateFromClientStatesFile: vi.fn(), schedulePersistGlobalState: vi.fn() });
  vm.runInContext(ts.transpileModule(loader.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const pending = vm.runInContext('loadGlobalSessionStateFromDisk(true)', context) as Promise<void>;
  const live = { ...old, agentLaunchGeneration: 'new-launch', agentLaunchCheck: { id: 'new-launch' } };
  context.globalSessionState = { sessions: [live], updatedAt: 2 };
  finish({ sessions: [old], updatedAt: 1 }); await pending;
  expect(context.globalSessionState.sessions).toMatchObject([{ backendSessionId: 'backend', agentLaunchGeneration: 'new-launch', agentLaunchCheck: { id: 'new-launch' } }]);
});
