// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Replay the actual admission function without starting the user's service.
const source = fs.readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('entry.ts', source, ts.ScriptTarget.Latest, true);
const admission = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'shouldWriteClientLog')!;
function setup() {
  const context = vm.createContext({ Date: { now: () => 10000 }, writeTextLog: vi.fn(),
    CLIENT_LOG_RATE_LIMIT: 120, CLIENT_LOG_RATE_WINDOW_MS: 10000, CLIENT_LOG_DEDUP_WINDOW_MS: 5000,
    clientLogWindowStartedAt: 0, clientLogWindowCount: 0, clientLogSuppressedCount: 0, clientLogRecent: new Map() });
  vm.runInContext(ts.transpileModule(admission.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return (message: string) => vm.runInContext(`shouldWriteClientLog('info', ${JSON.stringify(message)})`, context) as boolean;
}
it('keeps every motion trace chunk in the same five-second window', () => {
  const admit = setup();
  // The phone sends several ordered chunks after lifting its finger.
  expect(Array.from({ length: 40 }, () => admit('COMPUTER_MOTION_TRACE'))).toEqual(Array(40).fill(true));
});
it('continues deduplicating ordinary noise and rate limiting motion diagnostics', () => {
  const admit = setup(); expect(admit('noise')).toBe(true); expect(admit('noise')).toBe(false);
  for (let n = 0; n < 118; n++) expect(admit('COMPUTER_MOTION_TRACE')).toBe(true);
  expect(admit('COMPUTER_MOTION_TRACE')).toBe(false);
});
