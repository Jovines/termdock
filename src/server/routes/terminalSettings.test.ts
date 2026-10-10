// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { localAccessInterfaceUrl } from '../utils/localAccess.js';

// Run the actual settings builder without the terminal router's boot-time tmux
// setup or reads/writes to the developer's saved sessions.
const source = fs.readFileSync(new URL('./terminal.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true);
const builder = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getSettingsPayload')!;
const builderSource = builder.getText(ast);
function settingsPayload(localAccess: Record<string, unknown>, qr: ReturnType<typeof vi.fn>) {
  const dependencies = Object.fromEntries([...builderSource.matchAll(/\b(get[A-Z]\w*)\(/g)]
    .filter(match => match[1] !== 'getSettingsPayload').map(match => [match[1], () => null]));
  const context = vm.createContext({
    ...dependencies, Promise, localAccessInterfaceUrl,
    localAccessManager: { getState: () => localAccess },
    getOnboardingServerUrl: () => 'http://192.168.1.20:20000/ca',
    QRCode: { toDataURL: qr },
    caffeinateManager: { getPreventSleep: () => false, isActive: () => false, isNetworkAvailable: () => true },
  });
  vm.runInContext(ts.transpileModule(builderSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.getSettingsPayload();
}

describe('settings interface invitations', () => {
  it.each([
    ['http://test.termdock.local:18700', '192.168.1.20', 'http://192.168.1.20:18700'],
    ['https://test.termdock.local:18701', '192.168.1.20', 'https://192.168.1.20:18701'],
    ['https://test.termdock.local', '192.168.1.20', 'https://192.168.1.20'],
    ['http://test.termdock.local', '2001:db8::20', 'http://[2001:db8::20]'],
    ['https://test.termdock.local:9834', '192.168.1.20', 'https://192.168.1.20:9834'],
  ])('encodes the same origin in the QR and copy URL for %s', async (url, address, expected) => {
    const qr = vi.fn().mockResolvedValue('data:qr');
    const result = await settingsPayload({ url, status: 'active', interfaces: [{ address }] }, qr);
    expect(result.localAccess.interfaces[0]).toMatchObject({ url: expected, qrDataUrl: 'data:qr' });
    expect(qr).toHaveBeenCalledWith(expected, expect.any(Object));
  });

  it('keeps the copyable address when QR creation fails', async () => {
    const result = await settingsPayload({ url: 'http://test.termdock.local:18700', status: 'active', interfaces: [{ address: '10.1.1.20' }] }, vi.fn().mockRejectedValue(new Error('QR failed')));
    expect(result.localAccess.interfaces[0]).toMatchObject({ url: 'http://10.1.1.20:18700', qrDataUrl: null });
  });

  it('does not offer a LAN certificate address for a loopback-only listener', async () => {
    const qr = vi.fn();
    const result = await settingsPayload({ url: 'https://test.termdock.local:18700', status: 'loopback-only', interfaces: [] }, qr);
    expect(result.localAccess.onboardingUrl).toBeNull();
    expect(result.localAccess.interfaces).toHaveLength(0);
    expect(qr).not.toHaveBeenCalled();
  });
});
