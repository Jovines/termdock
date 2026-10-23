// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const roots: string[] = [], processes: ChildProcess[] = [], servers: Array<http.Server | https.Server> = [];
const slug = 'private-git-fixture';
const modules = Object.fromEntries(['pluginPackages', 'plugins', 'registry', 'installers', 'session'].map(name =>
  [name, fileURLToPath(new URL(`./${name}.ts`, import.meta.url))]));
afterEach(async () => {
  for (const child of processes.splice(0)) child.kill();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-private-plugin-')); roots.push(root);
  const work = path.join(root, 'work'), home = path.join(root, 'home');
  fs.mkdirSync(work); fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  delete env.GIT_CONFIG_COUNT;
  const git = async (...args: string[]) => (await execute('git', ['-c', `core.hooksPath=${os.devNull}`, '-C', work, ...args], { env })).stdout.trim();
  await git('init', '--initial-branch=main');
  fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({
    version: 2, slug, displayName: 'Private Git Fixture', aliases: [slug], accentColor: '#4385BE',
    statuses: [{ id: 'thinking', phase: 'working', label: 'Thinking', indicator: 'spinner', tone: 'info' },
      { id: 'complete', phase: 'done', label: 'Complete', indicator: 'badge', tone: 'success' }],
    hooks: { target: '~/.fixture-agent/hooks.json', events: [
      { hook: 'BeforeTurn', event: 'prompt-submit', status: 'thinking' },
      { hook: 'AfterTurn', event: 'stop', status: 'complete' },
    ] },
  }));
  fs.writeFileSync(path.join(work, 'helper.txt'), 'first version');
  await git('add', '--', 'manifest.json', 'helper.txt');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const bare = path.join(root, 'team', 'nested', 'plugin.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  await execute('git', ['clone', '--bare', '--', work, bare], { env });
  const revision = await git('rev-parse', 'HEAD');
  return { root, work, home, bare, git, revision, env };
}

async function runPlugin(home: string, source: string, mode: 'install' | 'update', env: NodeJS.ProcessEnv = {}) {
  // A separate process isolates PLUGINS_DIR and native hook configuration from
  // the developer account. It executes the installed hook command in a PTY.
  const script = `
    import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node-pty';
    import { preparePluginPackage, commitPreparedPlugin, checkPluginPackageUpdate } from ${JSON.stringify(modules.pluginPackages)};
    import { loadPlugins } from ${JSON.stringify(modules.plugins)};
    import { registerPluginAgents, detectAgentFromCommand } from ${JSON.stringify(modules.registry)};
    import { installHooksForSlug, hooksStateForSlug } from ${JSON.stringify(modules.installers)};
    import { parseAgentEvent, applyAgentEvent, defaultAgentSessionState } from ${JSON.stringify(modules.session)};
    const slug = ${JSON.stringify(slug)};
    const previous = loadPlugins().plugins.find(p => p.manifest.slug === slug);
    const update = previous ? await checkPluginPackageUpdate(previous) : null;
    const prepared = await preparePluginPackage(${JSON.stringify(source)}, previous ? slug : undefined);
    const dir = await commitPreparedPlugin(prepared, !!previous);
    const plugins = loadPlugins().plugins; registerPluginAgents(plugins);
    await installHooksForSlug(slug);
    const hooks = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.fixture-agent/hooks.json'), 'utf8')).hooks;
    const phases = [], state = defaultAgentSessionState();
    for (const hook of ['BeforeTurn', 'AfterTurn']) {
      const command = hooks[hook][0].hooks[0].command;
      const output = await new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', ${JSON.stringify("printf '%s' '{\"session_id\":\"private-native\"}' | ")} + command], {
          name: 'xterm-256color', cols: 80, rows: 24, cwd: ${JSON.stringify(process.cwd())},
          env: { ...process.env, TERMDOCK: '1', TMUX: '', TMUX_PANE: '', NODE_OPTIONS: '--import tsx' }
        });
        let text = ''; child.onData(data => { text += data; });
        const timer = setTimeout(() => { child.kill(); reject(new Error('hook timeout')); }, 5000);
        child.onExit(() => { clearTimeout(timer); resolve(text); });
      });
      const match = output.match(/\\x1b\\](777;notify;termdock:\\/\\/cli-agent;[^\\x07]+)\\x07/);
      const event = match && parseAgentEvent(match[1]);
      if (!event || event.agent?.slug !== slug) throw new Error('Plugin hook did not activate the registered Agent');
      applyAgentEvent(state, event); phases.push({ status: state.status, label: state.presentation?.label, native: state.sessionId });
    }
    console.log(JSON.stringify({ alias: detectAgentFromCommand(slug)?.slug,
      hookState: hooksStateForSlug(slug), phases, update, revision: prepared.metadata.revision,
      helper: fs.readFileSync(path.join(dir, 'helper.txt'), 'utf8'), mode: ${JSON.stringify(mode)} }));
  `;
  const result = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(), timeout: 20_000,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', TERMDOCK_PLUGIN_GIT_HOSTS: '', ...env },
  });
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
}

it.skipIf(process.platform === 'win32').each(['http', 'https'] as const)('clones and updates a private nested Git repository over %s using local credentials and CA settings, then runs its installed hooks', async scheme => {
  const r = await repository();
  let authenticated = 0;
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.headers.authorization !== `Basic ${Buffer.from('fixture:test-only-password').toString('base64')}`) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="private-git"' }); res.end(); return;
    }
    authenticated++;
    const url = new URL(req.url!, 'http://localhost');
    const backend = spawn('git', ['http-backend'], { env: { ...r.env, GIT_PROJECT_ROOT: r.root,
      GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: req.headers['content-length'] ?? '', REMOTE_USER: 'fixture' } });
    let headers = Buffer.alloc(0), started = false;
    backend.stdout.on('data', (chunk: Buffer) => {
      if (started) { res.write(chunk); return; }
      headers = Buffer.concat([headers, chunk]);
      const end = headers.indexOf('\r\n\r\n'); if (end < 0) return;
      for (const line of headers.subarray(0, end).toString().split('\r\n')) {
        const colon = line.indexOf(':'); if (colon < 0) continue;
        const key = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]);
        else res.setHeader(key, value);
      }
      started = true; res.write(headers.subarray(end + 4));
    });
    backend.on('close', () => res.end()); backend.on('error', () => { res.statusCode = 500; res.end(); });
    req.pipe(backend.stdin);
  };
  const cert = path.join(r.root, 'git-ca.pem'), key = path.join(r.root, 'git-key.pem');
  if (scheme === 'https') await execute('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-noenc', '-days', '1', '-subj', '/CN=Private Git Fixture', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', key, '-out', cert]);
  const server = scheme === 'https' ? https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, handler) : http.createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = `${scheme}://127.0.0.1:${(server.address() as net.AddressInfo).port}/team/nested/plugin.git`;
  fs.writeFileSync(path.join(r.home, '.gitconfig'), '[credential]\n\thelper = "!f() { printf \'username=fixture\\npassword=test-only-password\\n\'; }; f"\n'
    + (scheme === 'https' ? `[http]\n\tsslCAInfo = ${cert}\n` : ''));
  const installed = await runPlugin(r.home, source, 'install');
  expect(installed).toMatchObject({ alias: slug, hookState: 'installed', revision: r.revision,
    phases: [{ status: 'working', label: 'Thinking', native: 'private-native' }, { status: 'done', label: 'Complete', native: 'private-native' }] });
  fs.writeFileSync(path.join(r.work, 'helper.txt'), 'second version');
  await r.git('add', '--', 'helper.txt');
  await r.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'update');
  await r.git('push', r.bare, 'main');
  const updated = await runPlugin(r.home, source, 'update');
  expect(updated).toMatchObject({ helper: 'second version', hookState: 'installed', update: { updateAvailable: true } });
  expect(updated.revision).not.toBe(installed.revision);
  expect(authenticated).toBeGreaterThanOrEqual(5);
}, 30_000);

it.skipIf(process.platform !== 'linux')('clones through a self-hosted SSH alias and authenticates using a real SSH agent', async () => {
  const r = await repository();
  const hostKey = path.join(r.root, 'host-key'), clientKey = path.join(r.root, 'client-key');
  await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
  const portServer = net.createServer();
  await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = (portServer.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const config = path.join(r.root, 'sshd-config');
  fs.writeFileSync(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${r.root}/sshd.pid\nAuthorizedKeysFile ${clientKey}.pub\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\n`);
  const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] }); processes.push(daemon);
  let errors = ''; daemon.stderr!.on('data', data => { errors += data; });
  await expect.poll(async () => {
    if (daemon.exitCode !== null) throw new Error(errors);
    return new Promise<boolean>(resolve => { const socket = net.connect(port, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); resolve(true); }); socket.on('error', () => resolve(false)); });
  }, { timeout: 5000 }).toBe(true);
  const agentSocket = path.join(r.root, 'agent.sock');
  const agent = spawn('ssh-agent', ['-D', '-a', agentSocket], { stdio: 'ignore' }); processes.push(agent);
  await expect.poll(() => fs.existsSync(agentSocket)).toBe(true);
  await execute('ssh-add', [clientKey], { env: { ...process.env, SSH_AUTH_SOCK: agentSocket } });
  const sshConfig = path.join(r.root, 'ssh-config'), knownHosts = path.join(r.root, 'known-hosts');
  fs.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${fs.readFileSync(`${hostKey}.pub`, 'utf8')}`);
  fs.writeFileSync(sshConfig, `Host git-fixture.internal\n HostName 127.0.0.1\n Port ${port}\n User ${os.userInfo().username}\n IdentityFile ${clientKey}.pub\n IdentitiesOnly yes\n UserKnownHostsFile ${knownHosts}\n StrictHostKeyChecking yes\n`);
  const installed = await runPlugin(r.home, `git-fixture.internal:${r.bare}`, 'install', {
    SSH_AUTH_SOCK: agentSocket, GIT_SSH_COMMAND: `ssh -F ${sshConfig} -o BatchMode=yes`,
  });
  expect(installed).toMatchObject({ alias: slug, hookState: 'installed', revision: r.revision,
    phases: [{ status: 'working' }, { status: 'done' }] });
}, 30_000);
