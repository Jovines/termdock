/** Actual fixed old router/runtime for the packaged UI. Isolated data/listeners. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { createReactTerminalFixture } from './react-terminal-fixture';
const oldRoot = process.env.TD_PREVIEW_OLD_SERVER_ROOT;
if (!oldRoot) throw Error('Supply an immutable 79feaf2 server source archive');
const oldSourceHashes = {
  'passwordLoginRoutes.ts': '17c214fdfbc87002d987d540487a7e94ac16cf18156978f7c52bb569156f94c2',
  'passwordBootstrap.ts': '37516de21f762d8c3f66c84497cbdf6da3bff6b59dc65acc4ba31590da7d8942',
  'runtime.ts': 'c59ccc3f23bd1c4b9096ff386c48910a3e4308bc945f274bad69352b96455aa5',
};
for (const [file, hash] of Object.entries(oldSourceHashes)) assert.equal(createHash('sha256').update(readFileSync(join(oldRoot, 'src/server/federation', file))).digest('hex'), hash, file);
const load = (file: string) => import(pathToFileURL(join(oldRoot, file)).href);
const { createFederationRuntime } = await load('src/server/federation/runtime.ts');
const { isEncryptedRequest } = await load('src/server/federation/requestContext.ts');
const { TERMDOCK_PROTOCOL_VERSION, TERMDOCK_CAPABILITIES, getTermdockVersion } = await load('src/server/utils/version.ts');
const { createPasswordLoginRouter } = await load('src/server/federation/passwordLoginRoutes.ts');
const { RelayRouter } = await load('src/server/federation/relay.ts');
const { createInviteLink } = await load('src/lib/federation/inviteLink.ts');
process.env.TERMDOCK_PASSWORD = 'preview-bundle-test-password';
delete process.env.TERMDOCK_PUBLIC_ORIGIN;
const relay = process.argv.includes('--relay');
const nativeReact = process.argv.includes('--native-react');
const nativeInput=process.argv.includes('--native-input');
const nativeOverlay=process.argv.includes('--native-overlay');
assert(!nativeOverlay||process.argv.includes('--native-keyboard-manual'),'Overlay check requires the owned manual profile');
const keyboardBeforeNative=process.argv.includes('--native-keyboard-before-native');
assert(!keyboardBeforeNative||process.argv.includes('--native-keyboard-manual'),'Before-native mode requires the owned manual keyboard fixture');
const nativeKeyboardManual=process.argv.includes('--native-keyboard-manual');
const nativeKeyboard=process.argv.includes('--native-keyboard')||nativeKeyboardManual;
const nativeFeedback=process.argv.includes('--native-feedback')||nativeInput||nativeKeyboard;
const interactions=process.argv.includes('--interactions')||nativeFeedback;assert(!interactions||nativeReact,'Interactions require the owned React descriptor/model');
const benchmarkOutput=process.argv.includes('--benchmark-output');assert(!benchmarkOutput||nativeReact,'Benchmark output requires the owned React descriptor/model');
assert(!process.argv.includes('--user-fixes') || nativeReact,'User fixes require the owned React model');
const react = nativeReact ? createReactTerminalFixture({userFixes:process.argv.includes('--user-fixes'),interactions,nativeFeedback,nativeInput,nativeKeyboard,nativeKeyboardManual,nativeOverlay,benchmarkOutput,authorized:isEncryptedRequest}) : null;
let ordinary = 0, secureReads = 0, secureUploads = 0;
const peers: Array<any> = [];
async function peer(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'td-preview-bundle-server-'));
  const app = express(); let publicPort = 0;
  app.get('/', (_req, res) => res.type('html').send('OLD HTML MUST NEVER APPEAR'));
  app.get('/api/meta', (_req, res) => res.json({ product: 'termdock', version: getTermdockVersion(), protocolVersion: TERMDOCK_PROTOCOL_VERSION, capabilities: TERMDOCK_CAPABILITIES }));
  app.get('/api/auth/status', (_req, res) => res.json({ enabled: true, authenticated: false }));
  app.get('/api/auth/open/parameters', (_req, res) => res.status(403).json({ error: 'Password required' }));
  app.use((req, res, next) => { if (req.path.startsWith('/api/terminal') && req.socket.localPort === publicPort) {ordinary++;if(nativeReact){res.status(403).json({error:'Controlled business requires authenticated Noise'});return;}} next(); });
  if (react) react.install(app);
  app.get('/api/terminal/test-health', (_req, res) => { secureReads++; res.json({ secure: true }); });
  app.get('/api/csrf-token', (_req, res) => res.json({ csrfToken: 'test-token' }));
  app.post('/api/terminal/fs/upload', express.raw({ type: 'multipart/form-data', limit: '3mb' }), (req, res) => {
    // The fixed old authenticated Noise forwarder deliberately forwards only
    // content-type/accept/range/cache headers, never ambient auth/CSRF cookies.
    assert.equal(req.headers['x-xsrf-token'], undefined);
    assert(Buffer.isBuffer(req.body));
    assert(req.body.includes(Buffer.from('filename="native-fixture.bin"')));
    assert(req.body.includes(Buffer.alloc(2 * 1024 * 1024, 127)), 'real Rust read bytes must survive encrypted multipart transport');
    secureUploads++;
    res.json({ files: [{ path: '/tmp/native-fixture.bin' }], secure: true });
  });
  app.get('/api/terminal/session-inventory', (_req, res) => res.json({ version: 1, sessions: [] }));
  app.get('/api/terminal/settings', (_req, res) => res.json({ locale: 'zh', rightSidebarTabs: {}, newSessionAgentSlug: null }));
  app.get('/api/terminal/agents', (_req, res) => res.json({ agents: [] }));
  app.get('/api/terminal/presets', (_req, res) => res.json([]));
  app.get('/api/terminal/cwd', (_req, res) => res.json({ cwd: interactions?'/controlled':'/tmp' }));
  const runtime = await createFederationRuntime(app, dir, react ?? { terminal() {}, control() {} }, options);
  app.use('/api/auth/password', createPasswordLoginRouter(() => runtime));
  const server = createServer(app), ws = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/api/federation/secure')) return;
    // Direct Preview sockets carry the selected upstream's Origin; relay
    // target sockets remain originless and still require their own grants.
    if (req.headers.origin !== undefined) assert.equal(req.headers.origin, `http://${req.headers.host}`);
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
    ws.handleUpgrade(req, socket, head, client => { void runtime.accept(client, { allowOpenAccess: false }); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); publicPort = (server.address() as { port: number }).port;
  const p = { dir, runtime, server, ws, url: `http://127.0.0.1:${publicPort}` }; peers.push(p); return p;
}
const target = await peer();
let metadata: Record<string, unknown> = { url: target.url }, router: any;
if (relay) {
  const grants = new Set<string>(), tickets = new Map<string, { subject: string; target: string }>();
  const routeCode = randomBytes(32).toString('base64url'); let used = false;
  const entry = await peer({
    hasRouteGrant: (subject: string, id: string) => grants.has(subject) && id === target.runtime.serviceId,
    consumeRouteInvitation: (code: string, subject: string) => { assert.equal(code, routeCode); assert.equal(used, false); used = true; grants.add(subject); return { serviceId: target.runtime.serviceId }; },
    issueRouteTicket: (subject: string, id: string) => { assert(grants.has(subject)); assert.equal(id, target.runtime.serviceId); const token = randomUUID(); tickets.set(token, { subject, target: id }); return { routeToken: token, expiresAt: Date.now() + 30000 }; },
  });
  router = new RelayRouter({ authenticate: (context: unknown) => context, allowRegister: () => false, allowRoute: (p: { target: string }, id: string) => p.target === id });
  router.registerDirect(target.runtime.serviceId, async () => { const socket = new WebSocket(`${target.url.replace('http:', 'ws:')}/api/federation/secure`); await once(socket, 'open'); return socket; });
  entry.server.on('upgrade', (req: any, socket: any, head: any) => {
    const url = new URL(req.url, entry.url); if (url.pathname !== '/api/federation/relay') return;
    const ticket = tickets.get(url.searchParams.get('routeToken') || ''); assert(ticket); tickets.delete(url.searchParams.get('routeToken')!);
    entry.ws.handleUpgrade(req, socket, head, (ws: any) => { void router.attach(ws, ticket).then((ok: boolean) => { if (ok) ws.send(JSON.stringify({ type: 'ready' })); }); });
  });
  // This advertised target listener is closed: Chromium/Rust cannot reach the
  // target directly. Only the entry router has its real private transport.
  const closed = createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
  const serviceOrigin = `http://127.0.0.1:${(closed.address() as { port: number }).port}`;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  metadata = { url: entry.url, serviceOrigin, targetPeerId: target.runtime.serviceId, entryServiceId: entry.runtime.serviceId,
    invitation: createInviteLink({ v: 1, serviceId: target.runtime.serviceId, entryUrl: entry.url, serviceUrl: serviceOrigin, entryServiceId: entry.runtime.serviceId, routeCode, routeOnly: true, name: 'Existing service' }) };
}
process.stdout.write(JSON.stringify({ ...metadata, controlledTargetPeerId: target.runtime.serviceId, controlledInteractions:interactions, controlledNativeFeedback:nativeFeedback, controlledKeyboardManual:nativeKeyboardManual, controlledKeyboardBeforeNative:keyboardBeforeNative, serverRevision: '79feaf2442dd71a06806cc652252e9a7db4b54fb', oldSourceHashes }) + '\n');
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line === 'disconnect') {
    router?.close();
    for (const peer of peers) for (const socket of peer.ws.clients) socket.terminate();
    await Promise.all(peers.map(peer => new Promise<void>(resolve => peer.server.close(() => resolve()))));
    process.stdout.write(JSON.stringify({ disconnected: true }) + '\n');
  } else if(line==='inspect'){process.stdout.write(JSON.stringify({targetGrants:target.runtime.store.list().length})+'\n');}
  else if (line === 'done') break;
}
lines.close();
process.stdout.write(JSON.stringify({ ok: ordinary === 0 && (nativeReact ? react!.inspect().events.some(event => event.type === 'output-ack') : secureReads > 0 && secureUploads > 0), ordinary, secureReads, secureUploads, ...(react ? {react:react.inspect()} : {}) }) + '\n');
router?.close();
for (const peer of peers) { peer.runtime.close(); for (const socket of peer.ws.clients) socket.terminate(); peer.ws.close(); peer.server.close(); rmSync(peer.dir, { recursive: true, force: true }); }
