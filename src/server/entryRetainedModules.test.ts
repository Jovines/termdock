// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
import ts from 'typescript';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { resolveRetainedClientModule } from './utils/runtimeClient.js';
import { setStaticCacheHeaders } from './utils/staticAssets.js';

// Exercise the entry's actual route over HTTP, without booting production
// federation/session stores. A unit lookup misses sendFile's hidden-path rule.
const source = fs.readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('entry.ts', source, ts.ScriptTarget.Latest, true);
let handler: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'app.get'
    && node.arguments[0]?.getText(ast) === '/^\\/assets\\//') handler = node.arguments[1];
  ts.forEachChild(node, visit);
}
visit(ast);

it('serves retained JavaScript below a hidden state directory and never returns HTML for missing modules', async () => {
  expect(handler).toBeDefined();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'td-retained-http-'));
  const assets = path.join(home, '.termdock', 'client-snapshots', 'a'.repeat(24), 'dist', 'client', 'assets');
  fs.mkdirSync(assets, { recursive: true });
  const file = path.join(assets, 'lazy-12345678.js'); fs.writeFileSync(file, 'export default "retained";');
  fs.writeFileSync(path.join(assets, '..', 'private-notes.txt'), 'must never be exposed');
  const retainedModules = new Map([['/assets/lazy-12345678.js', file]]);
  const context = vm.createContext({ retainedModules, path, setStaticCacheHeaders,
    resolveRetainedClientModule: (modules: Map<string, string>, url: string) => resolveRetainedClientModule(modules, url, home) });
  const callback = vm.runInContext(ts.transpileModule(`(${handler!.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const app = express(); app.get(/^\/assets\//, callback);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${origin}/assets/lazy-12345678.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(await response.text()).toBe('export default "retained";');
    for (const name of ['missing-12345678.js', 'private-notes.txt']) {
      const missing = await fetch(`${origin}/assets/${name}`);
      expect(missing.status).toBe(404); expect(missing.headers.get('cache-control')).toBe('no-store');
      expect(await missing.text()).not.toContain('must never be exposed');
    }
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
