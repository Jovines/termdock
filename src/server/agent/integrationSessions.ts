import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { atomicJson, integrationError, type IntegrationPrincipal, type LaunchProfile, type StartupInputCondition } from './integrationStore.js';
import type { CollaborationPaneBinding } from './collaborationRouting.js';

export interface IntegrationSession {
  terminal_binding?: CollaborationPaneBinding;
  operation_id: string; session_id: string; group_id: string; principal_id: string;
  agent_slug: string; agent_native_session_id: string | null;
  state: 'starting' | 'binding_pending' | 'ready' | 'restoring' | 'failed';
  error_code: string | null; cwd: string; launch_profile: string; profile: LaunchProfile;
  created_at: number; updated_at: number; deadline: number; launch_submitted: boolean;
  startup_input?: { state: 'pending' | 'observed' | 'timed_out'; deadline: number; matched_since: number | null; observed_at: number | null };
  /** Safety condition attached to a legacy session at explicit restore, never new argv/cwd. */
  startup_condition?: StartupInputCondition;
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
  subscribe(listener: () => void): () => void;
  capture?(record: IntegrationSession): Promise<string>;
  registerDeliveryGuard?(guard: (id: string) => Promise<IntegrationDeliveryReadiness | null>): () => void;
}
export interface IntegrationDeliveryReadiness { allowed: boolean; reason: string | null }
function startupInput(record: Pick<IntegrationSession, 'profile' | 'startup_condition'>, now: number): IntegrationSession['startup_input'] {
  const condition = record.startup_condition ?? record.profile.startupInput;
  return condition ? { state: 'pending', deadline: now + (condition.timeoutMs ?? 120000), matched_since: null, observed_at: null } : undefined;
}
interface Document { version: 1; sessions: IntegrationSession[]; requests: Record<string, { hash: string; sessionId: string }> }
export function publicIntegrationSession(record: IntegrationSession) {
  const { profile: _, deadline: _deadline, launch_submitted: _submitted, startup_condition: _condition, ...publicRecord } = record;
  return publicRecord;
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
  private restoring = new Set<string>();
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
    for (const record of this.doc.sessions) if (['starting', 'restoring', 'binding_pending'].includes(record.state) || record.startup_input?.state === 'pending') this.scheduleRefresh(record);
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
  private save(): void { atomicJson(this.file, this.doc); for (const listener of this.listeners) { try { listener(); } catch { /* Durable session state is reconciled on restart. */ } } }
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
      state: 'starting', error_code: null, cwd, launch_profile: profile.id, profile: structuredClone(profile),
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
        record.launch_submitted = true; this.saveRecord(record);
        const prepared = (binding: CollaborationPaneBinding) => { record.terminal_binding = binding; this.saveRecord(record); };
        if (restoring) await this.adapter.restore(record, prepared); else await this.adapter.create(record, prepared);
        await this.refresh(record.session_id);
        this.scheduleRefresh(record);
      } catch (error) {
        const current = this.doc.sessions.find(s => s.session_id === record.session_id)!;
        const code = (error as { code?: unknown }).code;
        this.saveRecord({ ...current, state: 'failed', error_code: typeof code === 'string' ? code : 'SESSION_LAUNCH_FAILED', updated_at: Date.now() });
      }
      return structuredClone(this.doc.sessions.find(s => s.session_id === record.session_id)!);
    })().finally(() => this.pending.delete(record.session_id));
    this.pending.set(record.session_id, promise); return promise;
  }
  async get(principal: IntegrationPrincipal, id: string): Promise<IntegrationSession> { this.lookup(principal, id); await this.refresh(id); return this.lookup(principal, id); }
  async restore(principal: IntegrationPrincipal, id: string, idempotencyKey: string): Promise<IntegrationSession> {
    const request = this.request(principal, idempotencyKey, ['restore', id]);
    if (request.previous) return this.pending.get(id) ?? this.get(principal, id);
    if (this.pending.has(id) || this.restoring.has(id)) integrationError('SESSION_OPERATION_IN_PROGRESS', 'Another session operation is in progress', 409);
    this.restoring.add(id);
    try {
      const record = await this.get(principal, id);
      if (!record.agent_native_session_id) integrationError('NATIVE_SESSION_ID_MISSING', 'An exact native session binding is required', 409);
      // Recheck the current grant and actual directories; restore uses the
      // original profile snapshot, never changed model or wrapper defaults.
      if (!principal.launchProfiles.some(p => p.id === record.launch_profile)) integrationError('LAUNCH_PROFILE_DENIED', 'Original launch profile is no longer authorized', 403);
      permittedCwd(record.profile, record.cwd);
      const observed = await this.adapter.inspect(record);
      if (observed.running) {
        if (observed.agentSlug !== record.agent_slug || observed.nativeId !== record.agent_native_session_id) integrationError('SESSION_IDENTITY_MISMATCH', 'Existing process does not prove the exact native binding', 409);
        this.doc.requests[request.scoped] = { hash: request.hash, sessionId: id };
        try { this.save(); } catch (error) { delete this.doc.requests[request.scoped]; throw error; }
        return record;
      }
      if (['starting', 'restoring', 'binding_pending'].includes(record.state)) integrationError('SESSION_OPERATION_IN_PROGRESS', 'Prior launch outcome is not yet resolved; inspect the original session', 409);
      if (observed.exists && !observed.shell) integrationError('SESSION_TARGET_NOT_SHELL', 'Original pane is not a verified shell', 409);
      record.state = 'restoring'; record.error_code = null; record.operation_id = randomUUID(); record.deadline = Date.now() + this.bindingTimeout; record.updated_at = Date.now();
      if (!record.profile.startupInput && !record.startup_condition) record.startup_condition = structuredClone(principal.launchProfiles.find(profile => profile.id === record.launch_profile)?.startupInput);
      record.startup_input = startupInput(record, Date.now());
      this.doc.requests[request.scoped] = { hash: request.hash, sessionId: id };
      try { this.saveRecord(record); } catch (error) { delete this.doc.requests[request.scoped]; throw error; }
      return await this.launch(record, true);
    } finally { this.restoring.delete(id); }
  }
  private async refresh(id: string): Promise<void> {
    const record = structuredClone(this.doc.sessions.find(s => s.session_id === id)); if (!record) return;
    let observed: Awaited<ReturnType<IntegrationSessionAdapter['inspect']>>;
    try { observed = await this.adapter.inspect(record); }
    catch (error) {
      const current = this.doc.sessions.find(s => s.session_id === id);
      if (JSON.stringify(current) !== JSON.stringify(record)) return;
      const code = (error as { code?: unknown }).code;
      if (record.state !== 'failed' || record.error_code !== code) this.saveRecord({ ...record, state: 'failed', error_code: typeof code === 'string' ? code : 'SESSION_OBSERVATION_FAILED', updated_at: Date.now() });
      return;
    }
    const next = { ...record };
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
    if (!this.doc.sessions.find(record => record.session_id === id)?.startup_input) return null;
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
