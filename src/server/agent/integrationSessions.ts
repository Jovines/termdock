import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { atomicJson, integrationError, type IntegrationPrincipal, type LaunchProfile, type StartupInputCondition } from './integrationStore.js';
import { SessionLifecycleCoordinator, assertMessageRuntime, assertReleaseFacts, assertReleaseGeneration, type SessionLifecycleDescriptor } from './sessionLifecycle.js';
import { resumeConfigurationFingerprint } from './sessionResumeConfiguration.js';
import type { CollaborationPaneBinding } from './collaborationRouting.js';
import { NativeResumeOwnerError, type NativeOwnerCheck } from './nativeResumeOwner.js';

export interface IntegrationSession extends SessionLifecycleDescriptor {
  terminal_binding?: CollaborationPaneBinding | null;
  resume_configuration_fingerprint?: string;
  group_role?: string;
  operation_id: string; session_id: string; group_id: string; principal_id: string;
  agent_slug: string; agent_native_session_id: string | null;
  error_code: string | null; cwd: string; launch_profile: string; profile: LaunchProfile;
  created_at: number; updated_at: number; deadline: number; launch_submitted: boolean;
  startup_input?: { state: 'pending' | 'observed' | 'timed_out'; deadline: number; matched_since: number | null; observed_at: number | null };
  /** Safety condition attached to a legacy session at explicit restore, never new argv/cwd. */
  startup_condition?: StartupInputCondition;
  /** Administrator-only locators from the last rejected restore check. */
  restore_diagnostics?: NativeOwnerCheck & { operation_id: string };
}
/** Quote each configured argument as literal shell data, including paths. */
export function integrationLaunchCommand(record: IntegrationSession, restore: boolean): string {
  const launchArgs = record.profile.argv.map(arg => arg === '{cwd}' ? record.cwd : arg);
  const args = restore ? record.profile.resumeArgv.flatMap(arg => arg === '{launchArgs}' ? launchArgs
    : [arg === '{sessionId}' ? record.agent_native_session_id! : arg === '{cwd}' ? record.cwd : arg]) : launchArgs;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return `cd -- ${quote(record.cwd)} && ${[record.profile.executable, ...args].map(quote).join(' ')}`;
}
export interface IntegrationSessionAdapter {
  create(record: IntegrationSession, prepared: (binding: CollaborationPaneBinding) => void): Promise<void>;
  restore(record: IntegrationSession, prepared: (binding: CollaborationPaneBinding) => void): Promise<void>;
  inspect(record: IntegrationSession): Promise<{ exists: boolean; running: boolean; shell: boolean; agentSlug: string | null; nativeId: string | null }>;
  /** Current runtime presence includes orphaned tmux/backend, not inventory alone. */
  runtimePresent?(record: IntegrationSession): Promise<boolean>;
  release?(record: IntegrationSession, reconcile: boolean): Promise<void>;
  pendingMessages?(id: string): number;
  prepareRelease?(record: IntegrationSession): Promise<{ group_role?: string }>;
  resumeConfiguration?(record: IntegrationSession): Promise<unknown>;
  subscribe(listener: () => void): () => void;
  capture?(record: IntegrationSession): Promise<string>;
  registerDeliveryGuard?(guard: (id: string) => Promise<IntegrationDeliveryReadiness | null>): () => void;
}
export interface IntegrationDeliveryReadiness { allowed: boolean; reason: string | null }
function startupInput(record: Pick<IntegrationSession, 'profile' | 'startup_condition'>, now: number): IntegrationSession['startup_input'] {
  const condition = record.startup_condition ?? record.profile.startupInput;
  return condition ? { state: 'pending', deadline: now + (condition.timeoutMs ?? 120000), matched_since: null, observed_at: null } : undefined;
}
interface Document { version: 1; sessions: IntegrationSession[]; requests: Record<string, { hash: string; sessionId: string; operationId?: string; generation?: number; result?: IntegrationSession }> }
export function publicIntegrationSession(record: IntegrationSession) {
  const { profile: _, deadline: _deadline, launch_submitted: _submitted, startup_condition: _condition, restore_diagnostics: diagnostics, ...publicRecord } = record;
  return { ...publicRecord, ...(diagnostics ? { restore_diagnostics_available: true } : {}) };
}
export function permittedCwd(profile: LaunchProfile, cwd: string): string {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || /[\x00-\x1f\x7f]/.test(cwd)) integrationError('SESSION_CWD_DENIED', 'cwd must be absolute', 403);
  let real: string;
  try { real = fs.realpathSync(cwd); if (/[\x00-\x1f\x7f]/.test(real) || !fs.statSync(real).isDirectory()) throw new Error(); }
  catch { return integrationError('SESSION_CWD_MISSING', 'Task working directory must exist'); }
  if (!profile.cwdRoots.some(root => { try { const relative = path.relative(fs.realpathSync(root), real); return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); } catch { return false; } })) integrationError('SESSION_CWD_DENIED', 'Working directory is outside the configured roots', 403);
  return real;
}
/** Creation intent and exact launch configuration are durable before any input
 * enters a PTY. An ambiguous crash never starts another Agent automatically. */
export class IntegrationSessions {
  private doc: Document = { version: 1, sessions: [], requests: {} };
  private pending = new Map<string, Promise<IntegrationSession>>();
  private listeners = new Set<() => void>();
  private lifecycle = new SessionLifecycleCoordinator();
  private mutations = new Map<string, { hash: string; promise: Promise<IntegrationSession> }>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private stopObservation: () => void;
  private stopDeliveryGuard?: () => void;
  private observing = false;
  private observeAgain = false;
  constructor(private file: string, private adapter: IntegrationSessionAdapter, private bindingTimeout = 120000) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Document;
      if (doc.version !== 1 || !Array.isArray(doc.sessions) || !doc.requests) throw new Error('Invalid integration session store'); this.doc = doc;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const record of this.doc.sessions) { record.generation ??= 1; record.runtime_present ??= null; }
    for (const record of this.doc.sessions) if (['starting', 'restoring', 'binding_pending'].includes(record.state) || record.state === 'releasing' || record.startup_input?.state === 'pending') this.scheduleRefresh(record);
    // A pre-restart partial match cannot prove continuity of the live screen.
    for (const record of this.doc.sessions) if (record.startup_input && record.startup_input.state !== 'observed') record.startup_input.matched_since = null;
    this.stopDeliveryGuard = adapter.registerDeliveryGuard?.(id => this.deliveryReadiness(id));
    this.stopObservation = adapter.subscribe(() => { void this.refreshAll().catch(() => {}); });
  }
  private scheduleRefresh(record: IntegrationSession): void {
    for (const deadline of new Set([record.deadline, ...(record.startup_input ? [record.startup_input.deadline] : [])])) {
      const timer = setTimeout(() => { this.timers.delete(timer); void this.refresh(record.session_id).catch(() => {}); }, Math.max(1, deadline - Date.now() + 5));
      timer.unref(); this.timers.add(timer);
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  snapshot(): IntegrationSession[] { return structuredClone(this.doc.sessions); }
  private save(): void {
    if (Buffer.byteLength(JSON.stringify(this.doc)) > 64 * 1024 * 1024) integrationError('SESSION_STORAGE_FULL', 'Recovery descriptor journal is full; no new operation was committed', 503);
    atomicJson(this.file, this.doc); for (const listener of this.listeners) { try { listener(); } catch { /* Durable session state is reconciled on restart. */ } } }
  private saveRecord(record: IntegrationSession): void {
    const before = this.doc.sessions;
    this.doc.sessions = [...before.filter(s => s.session_id !== record.session_id), structuredClone(record)];
    try { this.save(); } catch (error) { this.doc.sessions = before; throw error; }
  }
  private lookup(principal: IntegrationPrincipal, id: string): IntegrationSession {
    const record = this.doc.sessions.find(s => s.session_id === id && s.group_id === principal.groupId && s.principal_id === principal.id);
    if (!record) integrationError('INTEGRATION_SESSION_NOT_FOUND', 'Session is not owned by this integration', 404);
    return structuredClone(record);
  }
  private request(principal: IntegrationPrincipal, key: string, input: unknown) {
    if (!key || typeof key !== 'string' || key.length > 256) integrationError('INVALID_IDEMPOTENCY_KEY', 'An idempotency key is required');
    const scoped = `${principal.id}:${key}`, hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = this.doc.requests[scoped];
    if (previous && previous.hash !== hash) integrationError('IDEMPOTENCY_CONFLICT', 'Key was already used for different session parameters', 409);
    return { scoped, hash, previous };
  }
  async create(principal: IntegrationPrincipal, input: { profile: string; cwd: string; idempotencyKey: string }): Promise<IntegrationSession> {
    const request = this.request(principal, input.idempotencyKey, ['create', input.profile, input.cwd]);
    if (request.previous) return this.pending.get(request.previous.sessionId) ?? this.get(principal, request.previous.sessionId);
    const profile = principal.launchProfiles.find(p => p.id === input.profile);
    if (!profile) integrationError('LAUNCH_PROFILE_DENIED', 'Profile is not allowed by this integration', 403);
    const cwd = permittedCwd(profile, input.cwd);
    try { fs.accessSync(profile.executable, fs.constants.X_OK); } catch { return integrationError('LAUNCHER_UNAVAILABLE', 'Configured executable is not available'); }
    if (this.doc.sessions.length >= 2000) integrationError('INTEGRATION_SESSION_LIMIT', 'Integration session storage is full', 409);
    const now = Date.now(), record: IntegrationSession = { operation_id: randomUUID(), session_id: randomBytes(6).toString('hex'),
      group_id: principal.groupId, principal_id: principal.id, agent_slug: profile.agentSlug, agent_native_session_id: null,
      state: 'starting', generation: 1, runtime_present: null, error_code: null, cwd, launch_profile: profile.id, profile: structuredClone(profile),
      created_at: now, updated_at: now, deadline: now + this.bindingTimeout, launch_submitted: false };
    record.startup_input = startupInput(record, now);
    this.doc.requests[request.scoped] = { hash: request.hash, sessionId: record.session_id };
    try { this.saveRecord(record); } catch (error) { delete this.doc.requests[request.scoped]; throw error; }
    return this.launch(record, false);
  }
  private launch(record: IntegrationSession, restoring: boolean): Promise<IntegrationSession> {
    const promise = (async () => {
      try {
        // Store intent before launching. A failed persistence cannot execute.
        if (this.adapter.resumeConfiguration) {
          try {
            const fingerprint = await resumeConfigurationFingerprint(record, this.adapter);
            if (record.resume_configuration_fingerprint && record.resume_configuration_fingerprint !== fingerprint) integrationError('RESUME_CONFIGURATION_CHANGED', 'Recovery launcher or plugin semantics changed', 409);
            if (!restoring) record.resume_configuration_fingerprint = fingerprint;
          } catch (error) {
            // Existing creation supports plugins without an exact resume path.
            // They remain launchable, but cannot gain a releasable descriptor.
            if (restoring || (error as { code?: unknown }).code !== 'EXACT_RESUME_UNSUPPORTED') throw error;
          }
        }
        record.launch_submitted = true; this.saveRecord(record);
        const prepared = (binding: CollaborationPaneBinding) => { record.terminal_binding = binding; this.saveRecord(record); };
        if (restoring) await this.adapter.restore(record, prepared); else await this.adapter.create(record, prepared);
        await this.refresh(record.session_id);
        this.scheduleRefresh(record);
      } catch (error) {
        const current = this.doc.sessions.find(s => s.session_id === record.session_id)!;
        const code = (error as { code?: unknown }).code;
        this.saveRecord({ ...current, state: 'failed', error_code: typeof code === 'string' ? code : 'SESSION_LAUNCH_FAILED',
          restore_diagnostics: error instanceof NativeResumeOwnerError ? { ...structuredClone(error.diagnostics), operation_id: current.operation_id } : undefined,
          updated_at: Date.now() });
      }
      return structuredClone(this.doc.sessions.find(s => s.session_id === record.session_id)!);
    })().finally(() => this.pending.delete(record.session_id));
    this.pending.set(record.session_id, promise); return promise;
  }
  async get(principal: IntegrationPrincipal, id: string): Promise<IntegrationSession> { this.lookup(principal, id); await this.refresh(id); return this.lookup(principal, id); }
  /** Read the stored check only: no process probe, PTY attachment, or new launch. */
  restoreDiagnostics(id: string) {
    const record = this.doc.sessions.find(session => session.session_id === id);
    if (!record) return integrationError('INTEGRATION_SESSION_NOT_FOUND', 'Integration session does not exist', 404);
    return structuredClone({ session_id: record.session_id, operation_id: record.operation_id,
      state: record.state, error_code: record.error_code, diagnostics: record.restore_diagnostics ?? null });
  }
  assertRuntimeMessage(id: string): void { assertMessageRuntime(this.doc.sessions.find(s => s.session_id === id)); }
  assertMessageTarget(principal: IntegrationPrincipal, id: string): void {
    const record = this.doc.sessions.find(s => s.session_id === id && s.group_id === principal.groupId);
    assertMessageRuntime(record);
  }
  private async mutate(principal: IntegrationPrincipal, key: string, input: unknown, action: () => Promise<IntegrationSession>): Promise<IntegrationSession> {
    const request = this.request(principal, key, input);
    if (request.previous?.result) { this.lookup(principal, request.previous.sessionId); return structuredClone(request.previous.result); }
    const active = this.mutations.get(request.scoped);
    if (active) { if (active.hash !== request.hash) integrationError('IDEMPOTENCY_CONFLICT', 'Operation key parameters changed', 409); return active.promise; }
    const promise = action().then(result => {
      if (this.doc.requests[request.scoped]) {
        const before = this.doc.requests[request.scoped];
        this.doc.requests[request.scoped] = { ...before, result: structuredClone(result) };
        try { this.save(); } catch (error) { this.doc.requests[request.scoped] = before; throw error; }
      }
      return result;
    }).finally(() => this.mutations.delete(request.scoped));
    this.mutations.set(request.scoped, { hash: request.hash, promise }); return promise;
  }
  private async replayRequest(principal: IntegrationPrincipal, id: string, request: NonNullable<ReturnType<IntegrationSessions['request']>['previous']>): Promise<IntegrationSession> {
    const record = await (this.pending.get(id) ?? this.get(principal, id));
    if (request.operationId && (record.operation_id !== request.operationId || record.generation !== request.generation)) integrationError('OPERATION_OUTCOME_UNCONFIRMED', 'Original operation result was not committed and a later generation exists; read session get, do not reuse this key', 409);
    return record;
  }
  async restore(principal: IntegrationPrincipal, id: string, key: string): Promise<IntegrationSession> {
    return this.mutate(principal, key, ['restore', id], () => this.lifecycle.run(id, () => this.restoreOnce(principal, id, key)));
  }
  private async restoreOnce(principal: IntegrationPrincipal, id: string, idempotencyKey: string): Promise<IntegrationSession> {
    const request = this.request(principal, idempotencyKey, ['restore', id]);
    if (request.previous) return this.replayRequest(principal, id, request.previous);
    if (this.pending.has(id)) integrationError('SESSION_OPERATION_IN_PROGRESS', 'Another session operation is in progress', 409);
    let releaseNative: (() => void) | undefined;
    try {
      const record = await this.get(principal, id);
      if (!record.agent_native_session_id) integrationError('NATIVE_SESSION_ID_MISSING', 'An exact native session binding is required', 409);
      // Recheck the current grant and actual directories; restore uses the
      // original profile snapshot, never changed model or wrapper defaults.
      const authorizedProfile = principal.launchProfiles.find(p => p.id === record.launch_profile);
      if (!authorizedProfile) integrationError('LAUNCH_PROFILE_DENIED', 'Original launch profile is no longer authorized', 403);
      permittedCwd(authorizedProfile, record.cwd);
      permittedCwd(record.profile, record.cwd);
      if (record.operation_uncertain || record.state === 'releasing') integrationError('OPERATION_OUTCOME_UNCONFIRMED', 'Reconcile prior release using session get before restore', 409);
      const observed = await this.adapter.inspect(record);
      if (observed.running) {
        if (observed.agentSlug !== record.agent_slug || observed.nativeId !== record.agent_native_session_id) integrationError('SESSION_IDENTITY_MISMATCH', 'Existing process does not prove the exact native binding', 409);
        this.doc.requests[request.scoped] = { hash: request.hash, sessionId: id, operationId: record.operation_id, generation: record.generation };
        try { this.save(); } catch (error) { delete this.doc.requests[request.scoped]; throw error; }
        return record;
      }
      if (['starting', 'restoring', 'binding_pending'].includes(record.state)) integrationError('SESSION_OPERATION_IN_PROGRESS', 'Prior launch outcome is not yet resolved; inspect the original session', 409);
      if (observed.exists && !observed.shell) integrationError('SESSION_TARGET_NOT_SHELL', 'Original pane is not a verified shell', 409);
      if (record.state === 'released' && !record.resume_configuration_fingerprint) integrationError('RESUME_CONFIGURATION_UNCONFIRMED', 'Administrator must explicitly confirm the current recovery configuration', 409);
      releaseNative = this.lifecycle.reserveNative(record, this.doc.sessions);
      if (record.resume_configuration_fingerprint && record.resume_configuration_fingerprint !== await resumeConfigurationFingerprint(record, this.adapter)) integrationError('RESUME_CONFIGURATION_CHANGED', 'Recovery launcher or plugin semantics changed', 409);
      record.generation = (record.generation ?? 1) + 1;
      record.runtime_present = observed.exists;
      record.state = 'restoring'; record.error_code = null; record.operation_id = randomUUID(); record.deadline = Date.now() + this.bindingTimeout; record.updated_at = Date.now();
      record.restore_diagnostics = undefined;
      if (!record.profile.startupInput && !record.startup_condition) record.startup_condition = structuredClone(principal.launchProfiles.find(profile => profile.id === record.launch_profile)?.startupInput);
      record.startup_input = startupInput(record, Date.now());
      this.doc.requests[request.scoped] = { hash: request.hash, sessionId: id, operationId: record.operation_id, generation: record.generation };
      try { this.saveRecord(record); } catch (error) { delete this.doc.requests[request.scoped]; throw error; }
      return await this.launch(record, true);
    } finally { releaseNative?.(); }
  }
  async resumeConfiguration(id: string) {
    const record = this.doc.sessions.find(s => s.session_id === id);
    if (!record) return integrationError('INTEGRATION_SESSION_NOT_FOUND', 'Recovery record does not exist', 404);
    return { session_id: id, generation: record.generation ?? 1, recorded_fingerprint: record.resume_configuration_fingerprint ?? null,
      current_fingerprint: await resumeConfigurationFingerprint(record, this.adapter), confirmation_required: !record.resume_configuration_fingerprint };
  }
  async confirmResumeConfiguration(id: string, generation: number, fingerprint: string): Promise<IntegrationSession> {
    return this.lifecycle.run(id, async () => {
      const record = structuredClone(this.doc.sessions.find(s => s.session_id === id));
      if (!record) return integrationError('INTEGRATION_SESSION_NOT_FOUND', 'Recovery record does not exist', 404);
      assertReleaseGeneration(record, generation);
      if (this.pending.has(id) || ['starting', 'restoring', 'binding_pending', 'releasing'].includes(record.state)) integrationError('SESSION_OPERATION_IN_PROGRESS', 'Resolve the current operation before confirming compatibility', 409);
      if (!/^[a-f0-9]{64}$/.test(fingerprint) || fingerprint !== await resumeConfigurationFingerprint(record, this.adapter)) integrationError('RESUME_CONFIGURATION_CHANGED', 'Current fingerprint no longer matches the administrator confirmation', 409);
      record.resume_configuration_fingerprint = fingerprint; record.generation = generation + 1; record.updated_at = Date.now();
      this.saveRecord(record); return record;
    });
  }
  async release(principal: IntegrationPrincipal, id: string, generation: number, key: string): Promise<IntegrationSession> {
    return this.mutate(principal, key, ['release', id, generation], () => this.lifecycle.run(id, async () => {
      const request = this.request(principal, key, ['release', id, generation]);
      if (request.previous) return this.replayRequest(principal, id, request.previous);
      if (!this.adapter.release || !this.adapter.runtimePresent) integrationError('SESSION_RELEASE_UNSUPPORTED', 'Runtime adapter does not support release', 409);
      if (this.pending.has(id)) integrationError('SESSION_OPERATION_IN_PROGRESS', 'Launch is in progress', 409);
      const record = await this.get(principal, id);
      assertReleaseGeneration(record, generation);
      if (record.state !== 'released') {
        assertReleaseFacts(record, await this.adapter.inspect(record));
        if (this.adapter.pendingMessages?.(id)) integrationError('SESSION_PENDING_MESSAGES', 'Pending messages must be resolved before release', 409);
        if (!record.resume_configuration_fingerprint) integrationError('RESUME_CONFIGURATION_UNCONFIRMED', 'Administrator must inspect and confirm the recovery configuration before release', 409);
        if (record.resume_configuration_fingerprint !== await resumeConfigurationFingerprint(record, this.adapter)) integrationError('RESUME_CONFIGURATION_CHANGED', 'Recovery launcher or plugin semantics changed', 409);
      }
      if (record.state === 'released') {
        this.doc.requests[request.scoped] = { hash: request.hash, sessionId: id, operationId: record.operation_id, generation: record.generation };
        try { this.save(); } catch (error) { delete this.doc.requests[request.scoped]; throw error; }
        return record;
      }
      if (this.adapter.prepareRelease) record.group_role = (await this.adapter.prepareRelease(record)).group_role;
      record.state = 'releasing'; record.operation_id = randomUUID(); record.generation = generation + 1;
      record.operation_uncertain = false; record.error_code = null; record.updated_at = Date.now();
      this.doc.requests[request.scoped] = { hash: request.hash, sessionId: id, operationId: record.operation_id, generation: record.generation };
      try { this.saveRecord(record); } catch (error) { delete this.doc.requests[request.scoped]; throw error; }
      try {
        await this.adapter.release(record, false);
        if (await this.adapter.runtimePresent(record)) integrationError('OPERATION_OUTCOME_UNCONFIRMED', 'Runtime removal could not be confirmed', 409);
        record.state = 'released'; record.runtime_present = false; record.terminal_binding = null; record.startup_input = undefined;
      } catch (error) {
        record.state = 'failed'; record.operation_uncertain = true; record.runtime_present = null;
        record.error_code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'SESSION_RELEASE_FAILED';
      }
      record.updated_at = Date.now(); this.saveRecord(record); return record;
    }));
  }
  private async refresh(id: string): Promise<void> {
    const record = structuredClone(this.doc.sessions.find(s => s.session_id === id)); if (!record) return;
    if (record.state === 'released' || record.state === 'releasing' || record.operation_uncertain) {
      if (this.lifecycle.active(id)) return;
      try {
        if (record.state !== 'released') await this.adapter.release?.(record, true);
        const present = await this.adapter.runtimePresent?.(record);
        if (present === undefined) integrationError('SESSION_RELEASE_UNSUPPORTED', 'Runtime presence is unavailable', 409);
        if (record.state !== 'released') {
          if (present) integrationError('OPERATION_OUTCOME_UNCONFIRMED', 'Prior release still has a runtime; explicit release retry is required', 409);
          // Absent runtime metadata has been reconciled without killing a live runtime.
        } else if (present) integrationError('OPERATION_OUTCOME_UNCONFIRMED', 'A runtime exists for a released descriptor', 409);
        const next = { ...record, state: 'released' as const, runtime_present: false, terminal_binding: null, startup_input: undefined, operation_uncertain: false, error_code: null };
        if (JSON.stringify(this.doc.sessions.find(s => s.session_id === id)) !== JSON.stringify(record)) return;
        if (JSON.stringify(next) !== JSON.stringify(record)) this.saveRecord({ ...next, updated_at: Date.now() });
      } catch (error) {
        if (JSON.stringify(this.doc.sessions.find(s => s.session_id === id)) !== JSON.stringify(record)) return;
        const next = { ...record, state: 'failed' as const, runtime_present: null, operation_uncertain: true, error_code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'OPERATION_OUTCOME_UNCONFIRMED' };
        if (JSON.stringify(next) !== JSON.stringify(record)) this.saveRecord({ ...next, updated_at: Date.now() });
      }
      return;
    }
    let observed: Awaited<ReturnType<IntegrationSessionAdapter['inspect']>>;
    try { observed = await this.adapter.inspect(record); }
    catch (error) {
      const current = this.doc.sessions.find(s => s.session_id === id);
      if (JSON.stringify(current) !== JSON.stringify(record)) return;
      const code = (error as { code?: unknown }).code;
      if (record.state !== 'failed' || record.error_code !== code) this.saveRecord({ ...record, state: 'failed', error_code: typeof code === 'string' ? code : 'SESSION_OBSERVATION_FAILED', updated_at: Date.now() });
      return;
    }
    const next = { ...record, runtime_present: this.adapter.runtimePresent ? await this.adapter.runtimePresent(record) : observed.exists };
    if (observed.nativeId && (typeof observed.nativeId !== 'string' || observed.nativeId.length > 256 || /[\x00-\x1f\x7f]/.test(observed.nativeId))) { next.state = 'failed'; next.error_code = 'NATIVE_SESSION_ID_INVALID'; }
    else if (observed.running && observed.agentSlug !== record.agent_slug) { next.state = 'failed'; next.error_code = 'SESSION_IDENTITY_MISMATCH'; }
    else if (observed.running && observed.nativeId) {
      if (record.agent_native_session_id && record.agent_native_session_id !== observed.nativeId) { next.state = 'failed'; next.error_code = 'NATIVE_SESSION_ID_MISMATCH'; }
      else { next.agent_native_session_id = observed.nativeId; if (next.terminal_binding) next.terminal_binding = { ...next.terminal_binding, nativeSessionId: observed.nativeId }; next.state = 'ready'; next.error_code = null; }
    } else if (observed.running) { next.state = Date.now() > record.deadline ? 'failed' : 'binding_pending'; next.error_code = next.state === 'failed' ? 'SESSION_BINDING_TIMEOUT' : null; }
    else if (record.state === 'ready') { next.state = 'failed'; next.error_code = 'AGENT_NOT_RUNNING'; }
    else if (Date.now() > record.deadline && record.state !== 'failed') { next.state = 'failed'; next.error_code = 'SESSION_BINDING_TIMEOUT'; }
    if (next.startup_input && next.startup_input.state !== 'observed') {
      const condition = next.startup_condition ?? next.profile.startupInput!;
      let matched = false;
      if (observed.running && observed.agentSlug === record.agent_slug && (!next.error_code || next.error_code === 'SESSION_BINDING_TIMEOUT') && this.adapter.capture) {
        try {
          const fold = (text: string) => text.replace(/[^\S\r\n]+/g, ' ').trim();
          const viewport = fold(await this.adapter.capture(next));
          matched = condition.allOf.every(term => viewport.includes(fold(term))) && !(condition.noneOf ?? []).some(term => viewport.includes(fold(term)));
        } catch { /* Missing capture never opens the delivery guard. */ }
      }
      const input = { ...next.startup_input };
      input.matched_since = matched ? input.matched_since ?? Date.now() : null;
      if (matched && Date.now() - input.matched_since! >= (condition.stableMs ?? 1000)) { input.state = 'observed'; input.observed_at = Date.now(); }
      else input.state = Date.now() >= input.deadline ? 'timed_out' : 'pending';
      next.startup_input = input;
    }
    if (JSON.stringify(this.doc.sessions.find(s => s.session_id === id)) !== JSON.stringify(record)) return;
    if (JSON.stringify(next) !== JSON.stringify(record)) { next.updated_at = Date.now(); this.saveRecord(next); }
  }
  /** Only gates configured launches. Native UUID and Agent turn state are not input prerequisites. */
  async deliveryReadiness(id: string): Promise<IntegrationDeliveryReadiness | null> {
    const existing = this.doc.sessions.find(record => record.session_id === id);
    if (!existing) return null;
    if (existing.state === 'released' || existing.state === 'releasing' || existing.operation_uncertain) return { allowed: false, reason: existing.state === 'released' ? 'SESSION_RELEASED' : 'SESSION_OPERATION_IN_PROGRESS' };
    if (!existing.startup_input) return null;
    await this.refresh(id);
    const record = this.doc.sessions.find(record => record.session_id === id)!;
    if (record.error_code && record.error_code !== 'SESSION_BINDING_TIMEOUT') return { allowed: false, reason: record.error_code };
    return record.startup_input!.state === 'observed' ? { allowed: true, reason: null }
      : { allowed: false, reason: record.startup_input!.state === 'timed_out' ? 'SESSION_STARTUP_INPUT_TIMEOUT' : 'SESSION_STARTUP_INPUT_PENDING' };
  }
  async refreshAll(): Promise<void> {
    if (this.observing) { this.observeAgain = true; return; }
    this.observing = true;
    try { do { this.observeAgain = false; for (const record of this.snapshot()) await this.refresh(record.session_id); } while (this.observeAgain); }
    finally { this.observing = false; }
  }
  close(): void { this.stopObservation(); this.stopDeliveryGuard?.(); for (const timer of this.timers) clearTimeout(timer); }
}
