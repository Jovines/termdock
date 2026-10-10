// @vitest-environment node
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Execute the entry's actual listen callback without booting federation, tmux,
// or changing the user's service settings.
const source = fs.readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('entry.ts', source, ts.ScriptTarget.Latest, true);
let listener: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'server.listen' && node.arguments[2]) listener = node.arguments[2];
  ts.forEachChild(node, visit);
}
visit(ast);

it('publishes the port and host of a real ephemeral loopback listener', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as AddressInfo;
    const state = { status: 'loopback-only', reason: 'loopback', onboardingUrl: null };
    const start = vi.fn().mockResolvedValue(state);
    const onboarding = vi.fn().mockReturnValue({ server: null, url: 'http://192.168.1.20:20000/ca' });
    const context = vm.createContext({
      server, port: 0, host: 'localhost', scheme: 'https', options: { httpsCaPath: '/test/ca.pem' },
      localAccessManager: { start }, startOnboardingServer: onboarding, console: { log: vi.fn(), warn: vi.fn() },
    });
    vm.runInContext(ts.transpileModule(`let latestLocalAccessState, latestOnboardingUrl; (${listener!.getText(ast)})();`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, context);
    await Promise.resolve();
    expect(start).toHaveBeenCalledWith({ host: '127.0.0.1', port: address.port, scheme: 'https', caCertPath: '/test/ca.pem', onboardingPort: address.port });
    expect(onboarding).toHaveBeenCalledWith({ httpsPort: address.port, caCertPath: '/test/ca.pem' });
    expect(vm.runInContext('latestOnboardingUrl', context)).toBeNull();
    expect(vm.runInContext('latestLocalAccessState', context)).toBe(state);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
