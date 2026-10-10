import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { INTEGRATION_PROTOCOL } from './integrationStore.js';
import { integrationSocketPath } from './integrationServer.js';
import { CollaborationError } from './collaborationProtocol.js';
import { executeCollaborationCommand, duration, type CollaborationCommand } from './collaborationCli.js';
import { getTermdockVersion } from '../utils/version.js';

export const INTEGRATION_HELP = `td integration — local scoped integration administration
  groups | list
  diagnostics <TD-session-id> (read the last restore check; administrator only)
  create --file <policy.json> --credential-file <private-output.json>
  update --file <policy.json> (same identity/group; preserves the credential)
  revoke <principal-id>
Credentials are saved as a private file and never printed. Workers set
TERMDOCK_INTEGRATION_CREDENTIAL_FILE, then use td collab --principal <id> …
Only the local administrator can provision/revoke grants. See docs/integrations.md.`;
export interface IntegrationCredential { id: string; token: string; protocol: number }
export function readIntegrationCredential(file: string, principalId: string): IntegrationCredential {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) || process.getuid && info.uid !== process.getuid()) throw new CollaborationError('INTEGRATION_CREDENTIAL_FILE_DENIED', 'Credential file must be owned by this user and private (0600)', 403);
  const credential = JSON.parse(fs.readFileSync(file, 'utf8')) as IntegrationCredential;
  if (credential.id !== principalId || !credential.token || credential.protocol !== INTEGRATION_PROTOCOL) throw new CollaborationError('INTEGRATION_CREDENTIAL_MISMATCH', 'Credential identity/protocol does not match the requested principal', 403);
  return credential;
}
function headers(credential?: IntegrationCredential, adminToken?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-termdock-integration-protocol': String(INTEGRATION_PROTOCOL),
    'x-termdock-cli-version': getTermdockVersion(),
    ...(credential ? { 'x-termdock-integration-id': credential.id, authorization: `Bearer ${credential.token}` } : {}),
    ...(adminToken ? { 'x-termdock-local-token': adminToken } : {}) };
}
function request(socketPath: string, method: string, route: string, body: unknown, requestHeaders: Record<string, string>, timeout = 30000): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: route, headers: requestHeaders }, res => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; if (raw.length > 4 * 1024 * 1024) req.destroy(new Error('Integration response exceeds limit')); });
      res.once('end', () => resolve({ statusCode: res.statusCode ?? 500, body: raw })); res.once('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Integration request timed out'))); req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
function parsed(response: { statusCode: number; body: string }): Record<string, any> {
  const result = JSON.parse(response.body);
  if (response.statusCode >= 300) throw new CollaborationError(result.code ?? 'INTEGRATION_REQUEST_FAILED', result.error ?? 'Integration request failed', response.statusCode);
  return result;
}
export async function runIntegrationAdmin(argv: string[], port: number, adminToken: string, write: (line: string) => void): Promise<number> {
  let reserved: string | undefined;
  try {
    const action = argv[0] ?? 'help', options: Record<string, string> = {};
    if (action === 'help' || action === '--help') { write(INTEGRATION_HELP); return 0; }
    const socketPath = integrationSocketPath(port);
    if (action === 'diagnostics') {
      if (argv.length !== 2 || !/^[a-zA-Z0-9._-]{1,80}$/.test(argv[1])) throw new Error('diagnostics requires one TD session id');
      const capabilities = parsed(await request(socketPath, 'GET', '/admin/capabilities', undefined, headers(undefined, adminToken)));
      if (capabilities.session_restore_diagnostics !== true) throw new CollaborationError('SESSION_RESTORE_DIAGNOSTICS_UNSUPPORTED', 'Running service does not support stored restore diagnostics', 409);
      write(JSON.stringify(parsed(await request(socketPath, 'GET', `/admin/sessions/${encodeURIComponent(argv[1])}/restore-diagnostics`, undefined, headers(undefined, adminToken))))); return 0;
    }
    for (let index = 1; index < argv.length; index += 2) {
      const flag = argv[index]; if (!['--file', '--credential-file'].includes(flag) || !argv[index + 1] || options[flag]) throw new Error('Invalid integration arguments'); options[flag] = argv[index + 1];
    }
    if (action === 'groups' || action === 'list') {
      if (argv.length !== 1) throw new Error('Unexpected arguments');
      write(JSON.stringify(parsed(await request(socketPath, 'GET', action === 'groups' ? '/admin/groups' : '/admin/principals', undefined, headers(undefined, adminToken))))); return 0;
    }
    if (action === 'update') {
      if (!options['--file'] || Object.keys(options).length !== 1) throw new Error('update requires only --file');
      const policy = JSON.parse(fs.readFileSync(options['--file'], 'utf8'));
      const capabilities = parsed(await request(socketPath, 'GET', '/admin/capabilities', undefined, headers(undefined, adminToken)));
      if (capabilities.integration_policy_update !== true || policy.launchProfiles?.some((profile: { startupInput?: unknown }) => profile.startupInput !== undefined) && capabilities.startup_input_conditions !== true) throw new CollaborationError('STARTUP_INPUT_CONDITION_UNSUPPORTED', 'Running service does not support this policy update', 409);
      write(JSON.stringify(parsed(await request(socketPath, 'POST', `/admin/principals/${encodeURIComponent(policy.id)}/policy`, policy, headers(undefined, adminToken))))); return 0;
    }
    if (action === 'create') {
      if (!options['--file'] || !options['--credential-file'] || Object.keys(options).length !== 2) throw new Error('create requires --file and --credential-file');
      const policy = JSON.parse(fs.readFileSync(options['--file'], 'utf8'));
      if (policy.launchProfiles?.some((profile: { startupInput?: unknown }) => profile.startupInput !== undefined)) {
        const capabilities = parsed(await request(socketPath, 'GET', '/admin/capabilities', undefined, headers(undefined, adminToken)));
        if (capabilities.startup_input_conditions !== true) throw new CollaborationError('STARTUP_INPUT_CONDITION_UNSUPPORTED', 'Running service does not support startup input conditions', 409);
      }
      const destination = path.resolve(options['--credential-file']); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(destination, 'wx', 0o600)); reserved = destination;
      const credential = parsed(await request(socketPath, 'POST', '/admin/principals', policy, headers(undefined, adminToken)));
      fs.writeFileSync(reserved, JSON.stringify(credential), { mode: 0o600 });
      write(JSON.stringify({ ok: true, id: credential.id, credential_file: reserved })); reserved = undefined; return 0;
    }
    throw new Error('Unknown integration operation');
  } catch (error) {
    if (reserved) fs.unlinkSync(reserved);
    write(JSON.stringify({ ok: false, code: error instanceof CollaborationError ? error.code : 'INTEGRATION_ADMIN_ERROR', error: error instanceof CollaborationError ? error.message : 'Integration administration failed; inspect arguments and private file paths' })); return 1;
  }
}
export async function revokeIntegration(id: string, port: number, adminToken: string, write: (line: string) => void): Promise<number> {
  try { write(JSON.stringify(parsed(await request(integrationSocketPath(port), 'POST', `/admin/principals/${encodeURIComponent(id)}/revoke`, {}, headers(undefined, adminToken))))); return 0; }
  catch (error) { write(JSON.stringify({ ok: false, code: error instanceof CollaborationError ? error.code : 'INTEGRATION_ADMIN_ERROR', error: error instanceof CollaborationError ? error.message : 'Integration revocation failed' })); return 1; }
}
export async function runIntegrationCollab(command: CollaborationCommand, port: number, io: { write(line: string): void; stdin(): Promise<string> }): Promise<number> {
  try {
    const principalId = String(command.options.principal), file = process.env.TERMDOCK_INTEGRATION_CREDENTIAL_FILE;
    if (!file) throw new CollaborationError('INTEGRATION_CREDENTIAL_REQUIRED', 'Set TERMDOCK_INTEGRATION_CREDENTIAL_FILE to a private credential file', 401);
    const credential = readIntegrationCredential(file, principalId), socketPath = integrationSocketPath(port);
    const capability = parsed(await request(socketPath, 'GET', '/capabilities', undefined, headers(credential)));
    if (capability.integration_protocol !== INTEGRATION_PROTOCOL) throw new CollaborationError('INCOMPATIBLE_INTEGRATION_PROTOCOL', 'CLI/service protocols are incompatible', 409);
    if (command.action === 'capabilities') { io.write(JSON.stringify({ ...capability, cli_version: getTermdockVersion() })); return 0; }
    if (command.action === 'events') {
      const consumer = String(command.options.consumer ?? 'default');
      if (command.operation === 'ack') { io.write(JSON.stringify(parsed(await request(socketPath, 'POST', '/events/ack', { consumer, cursor: command.target }, headers(credential))))); return 0; }
      const params = new URLSearchParams({ consumer }); if (command.options.group) params.set('group', String(command.options.group));
      return subscribe(socketPath, `/events?${params}`, credential, command.options.timeout ? duration(String(command.options.timeout)) : undefined, io.write);
    }
    if (command.action === 'session') {
      const route = command.operation === 'create' ? '/sessions' : `/sessions/${encodeURIComponent(command.target!)}${command.operation === 'restore' ? '/restore' : ''}`;
      const body = command.operation === 'create' ? { group_id: command.options.group, launch_profile: command.options['launch-profile'], cwd: command.options.cwd, idempotency_key: command.options['idempotency-key'] }
        : command.operation === 'restore' ? { idempotency_key: command.options['idempotency-key'] } : undefined;
      io.write(JSON.stringify(parsed(await request(socketPath, command.operation === 'get' ? 'GET' : 'POST', route, body, headers(credential))))); return 0;
    }
    if (!['task', 'message', 'help'].includes(command.action) || command.action === 'message' && command.operation !== 'get') throw new CollaborationError('INTEGRATION_OPERATION_DENIED', 'Command is not exposed to integration identities', 403);
    return executeCollaborationCommand(command, {}, { ...io, request: async (method, endpoint, body, timeout) => {
      const origin = { source: command.options.source, externalActor: command.options['external-actor'] ? JSON.parse(String(command.options['external-actor'])) : undefined,
        externalMessageId: command.options['external-message-id'], metadata: command.options.metadata ? JSON.parse(String(command.options.metadata)) : undefined };
      return request(socketPath, method, endpoint.replace('/api/terminal/operations/orchestration', ''), body === undefined ? undefined : { ...(body as object), origin }, headers(credential), timeout);
    } });
  } catch (error) {
    io.write(JSON.stringify({ ok: false, code: error instanceof CollaborationError ? error.code : 'INTEGRATION_CONNECTION_FAILED', error: error instanceof CollaborationError ? error.message : 'Local integration connection failed; credentials were not sent to a public service' })); return 1;
  }
}
async function subscribe(socketPath: string, route: string, credential: IntegrationCredential, timeout: number | undefined, write: (line: string) => void): Promise<number> {
  const deadline = timeout ? Date.now() + timeout : Infinity; let backoff = 1000;
  while (Date.now() < deadline) {
    const outcome = await new Promise<'retry' | 'stop' | 'timeout'>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const req = http.request({ socketPath, method: 'GET', path: route, headers: headers(credential) }, res => {
        res.setEncoding('utf8'); let pending = '', ended = false;
        res.on('data', chunk => {
          pending += chunk;
          if (pending.length > 2 * 1024 * 1024) { ended = true; req.destroy(); resolve('stop'); return; }
          for (;;) {
            const newline = pending.indexOf('\n'); if (newline < 0) break;
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (!line.trim()) continue;
            let event: { type?: string; retryable?: boolean };
            try { event = JSON.parse(line); } catch { write(JSON.stringify({ type: 'error', code: 'INVALID_EVENT_RESPONSE', retryable: false })); ended = true; req.destroy(); resolve('stop'); return; }
            write(line);
            if (event.type === 'error' && !event.retryable) { ended = true; req.destroy(); resolve('stop'); }
          }
        });
        res.once('end', () => {
          if ((res.statusCode ?? 500) >= 300 && pending) {
            try { const error = JSON.parse(pending); write(JSON.stringify(error)); } catch { write(JSON.stringify({ type: 'error', code: 'INVALID_EVENT_RESPONSE', retryable: false })); }
            resolve((res.statusCode ?? 500) >= 500 ? 'retry' : 'stop');
          } else if (!ended) resolve('retry');
        });
        res.once('close', () => { if (!ended) resolve('retry'); });
      });
      req.once('error', () => resolve('retry'));
      req.once('close', () => { if (timer) clearTimeout(timer); });
      if (Number.isFinite(deadline)) timer = setTimeout(() => { resolve('timeout'); req.destroy(); }, Math.max(1, deadline - Date.now()));
      req.end();
    });
    if (outcome === 'stop') return 1; if (outcome === 'timeout') return 0;
    write(JSON.stringify({ type: 'connection', state: 'reconnecting', retry_in_ms: backoff }));
    await new Promise(resolve => setTimeout(resolve, Math.min(backoff, Math.max(0, deadline - Date.now())))); backoff = Math.min(backoff * 2, 30000);
  }
  return 0;
}
