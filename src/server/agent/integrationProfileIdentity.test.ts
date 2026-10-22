// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { validatePolicy, type IntegrationPolicy } from './integrationStore.js';
import { runIntegrationAdmin } from './integrationCli.js';
import { integrationSocketPath } from './integrationServer.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const policy = (): IntegrationPolicy => ({ id: 'isolated', groupId: 'group', permissions: ['session.create'],
  launchProfiles: [{ id: 'agent', agentSlug: 'fixture', executable: '/bin/sh', argv: [],
    cwdRoots: [path.join(os.homedir(), 'runs')], resumeArgv: ['resume', '{sessionId}', '{launchArgs}'],
    nativeIdentity: { kind: 'linux-flock-owner', directory: '{cwd}/agent/locks' } }] });
it('validates explicit identity scopes without granting permissions or changing the plugin', () => {
  expect(validatePolicy(policy())).toEqual(policy());
  for (const directory of ['{cwd}/../escape', '/tmp/locks', '{env}/locks']) {
    const value = policy(); value.launchProfiles[0]!.nativeIdentity!.directory = directory;
    expect(() => validatePolicy(value)).toThrow(/nativeIdentity/);
  }
});
it.each(['create', 'update'])('refuses %s with a native scope on an old service before any policy write', async operation => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-native-profile-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'policy.json'); fs.writeFileSync(file, JSON.stringify(policy()));
  const port = 60000 + Math.floor(Math.random() * 5000), socket = integrationSocketPath(port);
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  const paths: string[] = [];
  const server = http.createServer((req, res) => { paths.push(req.url!);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ integration_policy_update: true })); });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const output: string[] = [];
  const args = [operation, '--file', file, ...(operation === 'create' ? ['--credential-file', path.join(dir, 'credentials.json')] : [])];
  expect(await runIntegrationAdmin(args, port, 'test-admin-token', line => output.push(line))).toBe(1);
  expect(paths).toEqual(['/admin/capabilities']);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ code: 'SESSION_PROFILE_NATIVE_IDENTITY_UNSUPPORTED' });
  expect(output.join('')).not.toContain('test-admin-token');
  expect(fs.existsSync(path.join(dir, 'credentials.json'))).toBe(false);
});
