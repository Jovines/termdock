import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { INTEGRATION_PROTOCOL } from './integrationStore.js';
import { integrationSocketPath } from './integrationServer.js';
import { CollaborationError } from './collaborationProtocol.js';
import { COLLAB_HELP, executeCollaborationCommand, duration, type CollaborationCommand } from './collaborationCli.js';
import { getTermdockVersion } from '../utils/version.js';

export const INTEGRATION_HELP = `td integration — local scoped integration administration
  groups | list
  group get <exact-group-id>
  group rename <exact-group-id> --name <name> --expected-updated-at <N> --idempotency-key <key>
    Administrator only; minimum CLI/running service 1.4.319;
    admin_local_group_rename=true covers get/rename and group revision reads.
    get returns {group:{id,name,updatedAt}}; groups also returns updatedAt.
    rename returns {group: current metadata, applied: original committed metadata,
    replayed: boolean}. Only name/updatedAt change; no membership, principal,
    terminal, launch, message, history or creation-snapshot changes.
    Read the revision first. GROUP_CHANGED returns currentUpdatedAt; reread and
    decide again with a new key. Retry uncertain results with the original key
    and all original parameters; a later rename is never overwritten by replay.
    Same normalized name is a recorded no-op. Keys are retained, capped at 2000.
    No terminal source, principal grant, prefix/name lookup or federated group.
    Errors: INVALID_GROUP_RENAME_REQUEST, INVALID_GROUP_ID, INVALID_GROUP,
    INVALID_GROUP_VERSION, INVALID_IDEMPOTENCY_KEY, IDEMPOTENCY_CONFLICT,
    GROUP_CHANGED, GROUP_NOT_FOUND, GROUP_NOT_LOCAL, GROUP_STATE_UNCONFIRMED,
    GROUP_RENAME_TARGET_UNAVAILABLE, GROUP_RENAME_STATE_UNCONFIRMED,
    GROUP_RENAME_LIMIT, ADMIN_LOCAL_GROUP_RENAME_UNSUPPORTED.
  group archive|unarchive <exact-group-id> --expected-updated-at <N> --idempotency-key <key>
    Administrator only; minimum CLI/running service 1.4.323; admin_local_group_archive=true.
    Reversible discovery metadata only. Default groups list hides archived groups;
    groups --include-archived lists them. group get always includes archivedAt when set.
    Membership, principals, sessions, runtime, messages and history are unchanged.
    Retry uncertain results with the same operation, revision and key; GROUP_CHANGED
    requires rereading current metadata and choosing a new key. Archive receipts are
    retained separately from the immutable group-create snapshot.
  group create --name <name> --idempotency-key <key>
    Administrator only; create an empty local group without a terminal source.
    Minimum CLI/running service 1.4.318; admin_local_group_create=true.
    Returns {group: original creation snapshot}; same key/parameters reuse it.
    Groups may later gain members; the snapshot is not their current membership.
    No IDs, members, federation, launch profiles or principal credentials accepted.
    Deleted/changed targets are not recreated; preserve the key after uncertain results.
    Errors: INVALID_GROUP, INVALID_IDEMPOTENCY_KEY, IDEMPOTENCY_CONFLICT,
    GROUP_CREATE_TARGET_UNAVAILABLE, GROUP_CREATION_STATE_UNCONFIRMED,
    GROUP_CREATE_LIMIT (2000 retained creation records), ADMIN_LOCAL_GROUP_CREATE_UNSUPPORTED.
    Next authorize a new fixed-group principal using integration create; no empty
    administrator terminal is required. Existing principal/session ownership is unchanged.
  clear-startup-input <TD-session-id> --generation <N>
    Administrator removes this session's saved screen conditions and disables
    inheritance on later restores; original identity/launch/history are preserved.
    Pending messages may then use the ordinary delivery worker; delivered bodies
    are never replayed. No Agent restart, resize, RPC or readiness claim.
    The generation increments once; read session get for the new generation and
    startup_input_disabled=true. Repeating with the old generation is rejected.
    Minimum CLI/running service 1.4.310; session_startup_input_clear=true.
    Errors: SESSION_STARTUP_INPUT_CLEAR_UNSUPPORTED, INVALID_SESSION_GENERATION,
    SESSION_GENERATION_MISMATCH, SESSION_OPERATION_IN_PROGRESS,
    INTEGRATION_SESSION_NOT_FOUND. Profile policy update alone keeps old snapshots.
  resume-configuration <TD-session-id> (read current/recorded fingerprints; no mutation)
  confirm-resume <TD-session-id> --generation <N> --fingerprint <sha256>
    Administrator explicitly authorizes the current launcher/plugin recovery semantics.
    This never proves unknown historical file contents or modifies Agent configuration.
    Old records need this confirmation before release; new records capture a fingerprint.
    Later changes fail closed. Grant session.release separately for runtime reclamation.
    Minimum CLI/running service 1.4.309; capabilities.session_resume_configuration=true.
    Errors: RESUME_CONFIGURATION_CHANGED, EXACT_RESUME_UNSUPPORTED,
    SESSION_GENERATION_MISMATCH, SESSION_OPERATION_IN_PROGRESS, LAUNCHER_UNAVAILABLE.
  diagnostics <TD-session-id> (read stored launch/restore diagnostics; administrator only)
    1.4.314 adds phase/timestamps, paste/submit write facts and target-change
    evidence; no argv/environment/credentials or application readiness claim.
    1.4.322 adds guard_captured/runtime_resolving/runtime_resolved stages and
    target_change.check_phase/guard_captured_at/checked_at, launch IDs and route revisions.
    Check actual server agent_launch_generation_consistency=true (minimum 1.4.322),
    terminal_input_check_diagnostics=true; upgrading only the CLI does not fix a running service.
    TERMINAL_INPUT_TARGET_CHANGED still rejects an actually replaced target.
    create never auto-retries; retry-cold remains a separate, explicitly authorized operation.
    Prior versions cannot reconstruct missing launch evidence retroactively.
  create --file <policy.json> --credential-file <private-output.json>
  update --file <policy.json> (same identity/group; preserves the credential)
  revoke <principal-id>
Credentials are saved as a private file and never printed. Workers set
TERMDOCK_INTEGRATION_CREDENTIAL_FILE, then use td collab --principal <id> …
Session owners: grant session.rename / session.close independently (minimum CLI/service 1.4.315).
Use td collab --principal <id> session rename|close --help for lifecycle constraints.
An empty administrator terminal is not required once a live local group is provisioned.
Ordinary messages: permissions message.send, message.read, events.read;
td collab --principal <id> --help lists send/reply/history and event examples.
No task or user acceptance is required for a message-driven integration.
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
  if (response.statusCode >= 300) throw new CollaborationError(result.code ?? 'INTEGRATION_REQUEST_FAILED', result.error ?? 'Integration request failed', response.statusCode,
    result.code === 'GROUP_CHANGED' && Number.isSafeInteger(result.currentUpdatedAt) ? { currentUpdatedAt: result.currentUpdatedAt } : undefined);
  return result;
}
export async function runIntegrationAdmin(argv: string[], port: number, adminToken: string, write: (line: string) => void): Promise<number> {
  let reserved: string | undefined;
  try {
    const action = argv[0] ?? 'help', options: Record<string, string> = {};
    if (action === 'help' || argv.includes('--help')) { write(INTEGRATION_HELP); return 0; }
    const socketPath = integrationSocketPath(port);
    if (action === 'group' && ['get', 'rename', 'archive', 'unarchive'].includes(argv[1])) {
      const operation = argv[1], id = argv[2], args: Record<string, string> = {};
      const usage = 'Usage: td integration group get <exact-id> | group rename <exact-id> --name <name> --expected-updated-at <N> --idempotency-key <key> | group archive|unarchive <exact-id> --expected-updated-at <N> --idempotency-key <key>';
      if (!id || !/^[a-zA-Z0-9._-]{1,80}$/.test(id)) throw new CollaborationError('INVALID_GROUP_ID', usage, 400);
      if (operation === 'get' && argv.length !== 3) throw new CollaborationError('INVALID_GROUP_RENAME_REQUEST', usage, 400);
      if (operation !== 'get') {
        for (let i = 3; i < argv.length; i += 2) {
          const allowed = operation === 'rename' ? ['--name', '--expected-updated-at', '--idempotency-key'] : ['--expected-updated-at', '--idempotency-key'];
          if (!allowed.includes(argv[i]) || !argv[i + 1] || Object.hasOwn(args, argv[i])) throw new CollaborationError(operation === 'rename' ? 'INVALID_GROUP_RENAME_REQUEST' : 'INVALID_GROUP_ARCHIVE_REQUEST', usage, 400);
          args[argv[i]] = argv[i + 1];
        }
        if (operation === 'rename' ? Object.keys(args).length !== 3 || !args['--name']?.trim() || !args['--idempotency-key']?.trim()
          : Object.keys(args).length !== 2 || !args['--idempotency-key']?.trim()) throw new CollaborationError(operation === 'rename' ? 'INVALID_GROUP_RENAME_REQUEST' : 'INVALID_GROUP_ARCHIVE_REQUEST', usage, 400);
        if (!/^(0|[1-9][0-9]*)$/.test(args['--expected-updated-at']) || !Number.isSafeInteger(Number(args['--expected-updated-at']))) throw new CollaborationError('INVALID_GROUP_VERSION', usage, 400);
      }
      const capabilities = parsed(await request(socketPath, 'GET', '/admin/capabilities', undefined, headers(undefined, adminToken)));
      const isArchive = operation === 'archive' || operation === 'unarchive';
      if (capabilities[isArchive ? 'admin_local_group_archive' : 'admin_local_group_rename'] !== true) throw new CollaborationError(isArchive ? 'ADMIN_LOCAL_GROUP_ARCHIVE_UNSUPPORTED' : 'ADMIN_LOCAL_GROUP_RENAME_UNSUPPORTED', `CLI and running service must support this operation (minimum 1.4.${isArchive ? '323' : '319'})`, 409);
      const body = operation === 'get' ? undefined : { ...(operation === 'rename' ? { name: args['--name'] } : {}), expected_updated_at: Number(args['--expected-updated-at']), idempotency_key: args['--idempotency-key'] };
      const suffix = operation === 'get' ? '' : `/${operation}`;
      write(JSON.stringify(parsed(await request(socketPath, body ? 'POST' : 'GET', `/admin/groups/${encodeURIComponent(id)}${suffix}`, body, headers(undefined, adminToken)))));
      return 0;
    }
    if (action === 'group') {
      const args: Record<string, string> = {};
      const usage = 'Usage: td integration group create --name <name> --idempotency-key <key>';
      if (argv[1] !== 'create') throw new CollaborationError('INVALID_GROUP_CREATE_REQUEST', usage, 400);
      for (let i = 2; i < argv.length; i += 2) {
        if (!['--name', '--idempotency-key'].includes(argv[i]) || !argv[i + 1] || Object.hasOwn(args, argv[i])) throw new CollaborationError('INVALID_GROUP_CREATE_REQUEST', usage, 400);
        args[argv[i]] = argv[i + 1];
      }
      if (!args['--name']?.trim() || !args['--idempotency-key']?.trim() || Object.keys(args).length !== 2) throw new CollaborationError('INVALID_GROUP_CREATE_REQUEST', usage, 400);
      const capabilities = parsed(await request(socketPath, 'GET', '/admin/capabilities', undefined, headers(undefined, adminToken)));
      if (capabilities.admin_local_group_create !== true) throw new CollaborationError('ADMIN_LOCAL_GROUP_CREATE_UNSUPPORTED', 'CLI and running service must support empty local group creation (minimum 1.4.318)', 409);
      write(JSON.stringify(parsed(await request(socketPath, 'POST', '/admin/groups', { name: args['--name'], idempotency_key: args['--idempotency-key'] }, headers(undefined, adminToken)))));
      return 0;
    }
    if (action === 'clear-startup-input') {
      const id = argv[1];
      if (argv.length !== 4 || !id || !/^[a-zA-Z0-9._-]{1,80}$/.test(id) || argv[2] !== '--generation'
        || !/^[1-9][0-9]*$/.test(argv[3]) || !Number.isSafeInteger(Number(argv[3]))) {
        throw new Error('Usage: td integration clear-startup-input <TD-session-id> --generation <positive integer>');
      }
      const capabilities = parsed(await request(socketPath, 'GET', '/admin/capabilities', undefined, headers(undefined, adminToken)));
      if (capabilities.session_startup_input_clear !== true) throw new CollaborationError('SESSION_STARTUP_INPUT_CLEAR_UNSUPPORTED', 'CLI and running service must be at least 1.4.310', 409);
      write(JSON.stringify(parsed(await request(socketPath, 'POST', `/admin/sessions/${encodeURIComponent(id)}/startup-input/clear`,
        { generation: Number(argv[3]) }, headers(undefined, adminToken)))));
      return 0;
    }
    if (action === 'resume-configuration' || action === 'confirm-resume') {
      const id = argv[1];
      if (!id || !/^[a-zA-Z0-9._-]{1,80}$/.test(id)) throw new Error('A full TD session id is required');
      const capabilities = parsed(await request(socketPath, 'GET', '/admin/capabilities', undefined, headers(undefined, adminToken)));
      if (capabilities.session_resume_configuration !== true) throw new CollaborationError('SESSION_RELEASE_UNSUPPORTED', 'CLI and running service must be at least 1.4.309', 409);
      let body: unknown;
      if (action === 'confirm-resume') {
        const args: Record<string, string> = {};
        for (let i = 2; i < argv.length; i += 2) { if (!['--generation', '--fingerprint'].includes(argv[i]) || !argv[i + 1] || args[argv[i]]) throw new Error('confirm-resume requires --generation and --fingerprint'); args[argv[i]] = argv[i + 1]; }
        if (!/^[1-9][0-9]*$/.test(args['--generation'] ?? '') || !Number.isSafeInteger(Number(args['--generation'])) || !/^[a-f0-9]{64}$/.test(args['--fingerprint'] ?? '')) throw new Error('Invalid generation or fingerprint');
        body = { generation: Number(args['--generation']), fingerprint: args['--fingerprint'] };
      } else if (argv.length !== 2) throw new Error('resume-configuration requires one TD session id');
      write(JSON.stringify(parsed(await request(socketPath, body ? 'POST' : 'GET', `/admin/sessions/${encodeURIComponent(id)}/resume-configuration`, body, headers(undefined, adminToken))))); return 0;
    }
    if (action === 'diagnostics') {
      if (argv.length !== 2 || !/^[a-zA-Z0-9._-]{1,80}$/.test(argv[1])) throw new Error('diagnostics requires one TD session id');
      const capabilities = parsed(await request(socketPath, 'GET', '/admin/capabilities', undefined, headers(undefined, adminToken)));
      if (capabilities.session_restore_diagnostics !== true) throw new CollaborationError('SESSION_RESTORE_DIAGNOSTICS_UNSUPPORTED', 'Running service does not support stored restore diagnostics', 409);
      write(JSON.stringify(parsed(await request(socketPath, 'GET', `/admin/sessions/${encodeURIComponent(argv[1])}/restore-diagnostics`, undefined, headers(undefined, adminToken))))); return 0;
    }
    if (action !== 'groups' && action !== 'list') for (let index = 1; index < argv.length; index += 2) {
      const flag = argv[index]; if (!['--file', '--credential-file'].includes(flag) || !argv[index + 1] || options[flag]) throw new Error('Invalid integration arguments'); options[flag] = argv[index + 1];
    }
    if (action === 'groups' || action === 'list') {
      if (action === 'list' && argv.length !== 1 || action === 'groups' && argv.length > 2 || action === 'groups' && argv.length === 2 && argv[1] !== '--include-archived') throw new Error('Usage: td integration groups [--include-archived] | list');
      if (action === 'groups' && argv[1] === '--include-archived') {
        const capabilities = parsed(await request(socketPath, 'GET', '/admin/capabilities', undefined, headers(undefined, adminToken)));
        if (capabilities.admin_local_group_archive !== true) throw new CollaborationError('ADMIN_LOCAL_GROUP_ARCHIVE_UNSUPPORTED', 'CLI and running service must support archived group discovery (minimum 1.4.323)', 409);
      }
      write(JSON.stringify(parsed(await request(socketPath, 'GET', action === 'groups' ? `/admin/groups${argv[1] ? '?include_archived=true' : ''}` : '/admin/principals', undefined, headers(undefined, adminToken))))); return 0;
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
    write(JSON.stringify({ ok: false, code: error instanceof CollaborationError ? error.code : 'INTEGRATION_ADMIN_ERROR',
      ...(error instanceof CollaborationError && error.code === 'GROUP_CHANGED' ? error.details : {}),
      error: error instanceof CollaborationError ? error.message : 'Integration administration failed; inspect arguments and private file paths' })); return 1;
  }
}
export async function revokeIntegration(id: string, port: number, adminToken: string, write: (line: string) => void): Promise<number> {
  try { write(JSON.stringify(parsed(await request(integrationSocketPath(port), 'POST', `/admin/principals/${encodeURIComponent(id)}/revoke`, {}, headers(undefined, adminToken))))); return 0; }
  catch (error) { write(JSON.stringify({ ok: false, code: error instanceof CollaborationError ? error.code : 'INTEGRATION_ADMIN_ERROR', error: error instanceof CollaborationError ? error.message : 'Integration revocation failed' })); return 1; }
}
export async function runIntegrationCollab(command: CollaborationCommand, port: number, io: { write(line: string): void; stdin(): Promise<string> }): Promise<number> {
  try {
    if (command.action === 'help') { io.write(COLLAB_HELP); return 0; }
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
      if (command.operation === 'rename' && capability.session_rename !== true) throw new CollaborationError('SESSION_RENAME_UNSUPPORTED', 'CLI/service must support session.rename (minimum 1.4.315)', 409);
      if (command.operation === 'close' && capability.session_close !== true) throw new CollaborationError('SESSION_CLOSE_UNSUPPORTED', 'CLI/service must support session.close (minimum 1.4.315)', 409);
      if (command.operation === 'retry-cold' && capability.session_cold_retry !== true) throw new CollaborationError('SESSION_COLD_RETRY_UNSUPPORTED', 'CLI and running service must support explicit cold retry (minimum 1.4.314)', 409);
      if (command.operation === 'release' && (capability.session_runtime_release !== true || capability.session_lifecycle_generation !== true || capability.stable_session_identity !== true)) throw new CollaborationError('SESSION_RELEASE_UNSUPPORTED', 'CLI and running service must support the lifecycle contract (minimum 1.4.309)', 409);
      const route = command.operation === 'create' ? '/sessions' : `/sessions/${encodeURIComponent(command.target!)}${['restore', 'release', 'retry-cold', 'rename', 'close'].includes(command.operation!) ? `/${command.operation}` : ''}`;
      const body = command.operation === 'create' ? { group_id: command.options.group, launch_profile: command.options['launch-profile'], cwd: command.options.cwd, idempotency_key: command.options['idempotency-key'] }
        : ['restore', 'release', 'retry-cold', 'rename', 'close'].includes(command.operation!) ? { ...(['release', 'retry-cold', 'rename', 'close'].includes(command.operation!) ? { generation: Number(command.options.generation), ...(command.operation === 'rename' ? { name: command.options.name } : {}) } : {}), idempotency_key: command.options['idempotency-key'] } : undefined;
      io.write(JSON.stringify(parsed(await request(socketPath, command.operation === 'get' ? 'GET' : 'POST', route, body, headers(credential))))); return 0;
    }
    const messageCapability = command.action === 'send' ? 'integration_message_send' : command.action === 'reply' ? 'integration_message_reply'
      : command.action === 'message' && command.operation === 'list' ? 'integration_message_history' : null;
    if (messageCapability && capability[messageCapability] !== true) throw new CollaborationError('INTEGRATION_MESSAGING_UNSUPPORTED', 'CLI and running service must support integration messaging (minimum 1.4.308); upgrade both and read capabilities', 409);
    if (!['task', 'message', 'send', 'reply'].includes(command.action) || command.action === 'message' && !['get', 'list'].includes(command.operation!)) throw new CollaborationError('INTEGRATION_OPERATION_DENIED', 'Command is not exposed to integration identities; see td collab --principal <id> --help', 403);
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
