import { attachRegisteredDirectTargets, verifyDirectTarget, type DirectTargetConfig } from './directRoutes.js';
import type { RelayRouter } from './relay.js';
import { normalizeServiceAddress } from './connectionModel.js';

export type DirectTargetError = 'TARGET_CHECKING' | 'TARGET_IDENTITY_MISMATCH' | 'TARGET_UNREACHABLE';
interface State {
  target: DirectTargetConfig;
  signature: string;
  checking: boolean;
  nextCheck: number;
  error?: DirectTargetError;
  close?: () => void;
  controller?: AbortController;
}

/** A static configuration is a claim, not proof that its URL serves its ID.
 * Advertise direct providers only after a real TLS + pinned Noise handshake.
 * Reverse providers remain independent and keep working during these checks. */
export class DirectTargetRegistry<P> {
  private states = new Map<string, State>();
  private stopped = false;
  private activeChecks = 0;
  constructor(private router: RelayRouter<P>, private baseDir: string, private now: () => number = () => performance.now()) {}

  refresh(targets: DirectTargetConfig[]): void {
    if (this.stopped) return;
    const desired = new Map(targets.map(target => [this.key(target), target]));
    const signature = (target: DirectTargetConfig) => JSON.stringify([target.url, target.caPath, target.caFingerprint256, target.certificateFingerprint256]);
    for (const [id, state] of this.states) {
      const target = desired.get(id);
      if (!target || signature(target) !== state.signature) { state.controller?.abort(); state.close?.(); this.states.delete(id); }
    }
    for (const [id, target] of desired) {
      let state = this.states.get(id);
      if (!state) {
        state = { target, signature: signature(target), checking: false, nextCheck: 0, error: 'TARGET_CHECKING' };
        this.states.set(id, state);
      }
      state.target = target;
    }
    this.pump();
  }

  private key(target: DirectTargetConfig): string { return JSON.stringify([target.serviceId, normalizeServiceAddress(target.url)]); }
  private providers(serviceId: string): State[] { return [...this.states.values()].filter(state => state.target.serviceId === serviceId); }
  private pump(): void {
    if (this.stopped) return;
    for (const state of this.states.values()) {
      if (this.activeChecks >= 4) break;
      if (!state.checking && this.now() >= state.nextCheck) void this.check(state.target, state);
    }
  }
  error(serviceId: string): DirectTargetError | undefined {
    const states = this.providers(serviceId);
    if (states.some(state => state.close)) return;
    return ['TARGET_CHECKING', 'TARGET_IDENTITY_MISMATCH', 'TARGET_UNREACHABLE'].find(error => states.some(state => state.error === error)) as DirectTargetError | undefined;
  }

  describe(target: { serviceId: string; url?: string; label?: string }) {
    const state = this.providers(target.serviceId).find(provider => provider.close);
    const available = this.router.hasRoute(target.serviceId);
    // A valid reverse tunnel may coexist with an incorrect static URL. Do not
    // borrow the unverified URL/name and make A look like the entry B.
    const metadata = state ? { serviceId: target.serviceId, url: normalizeServiceAddress(state.target.url), ...(state.target.label ? { label: state.target.label } : {}) }
      : target.url ? { serviceId: target.serviceId } : target;
    const error = this.error(target.serviceId);
    return { ...metadata, available, ...(!available && error ? { error } : {}) };
  }

  private async check(target: DirectTargetConfig, state: State): Promise<void> {
    state.checking = true;
    this.activeChecks++;
    const controller = new AbortController(); state.controller = controller;
    const current = () => !this.stopped && this.states.get(this.key(target)) === state;
    try {
      await verifyDirectTarget(target, this.baseDir, controller.signal);
      if (!current()) return;
      state.close ??= attachRegisteredDirectTargets(this.router, [target], this.baseDir);
      state.error = undefined;
      state.nextCheck = this.now() + 30_000;
    } catch (error) {
      if (!current()) return;
      state.close?.(); state.close = undefined;
      state.error = error instanceof Error && error.name === 'UnexpectedPeerError' ? 'TARGET_IDENTITY_MISMATCH' : 'TARGET_UNREACHABLE';
      state.nextCheck = this.now() + 5000;
    } finally { state.checking = false; state.controller = undefined; this.activeChecks--; this.pump(); }
  }

  close(): void {
    this.stopped = true;
    for (const state of this.states.values()) { state.controller?.abort(); state.close?.(); }
    this.states.clear();
  }
}
