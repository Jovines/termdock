import { integrationError } from './integrationStore.js';

export interface NativeResumeOwnerCandidate {
  backendSessionId: string;
  cachedSlug: string | null;
  cachedNativeId: string | null;
}
export interface NativeResumeProcess {
  confirmed: boolean;
  agentSlug: string | null;
  nativeId: string | null;
}

/** Last-known bindings select uncertain conflicts; only process observations
 * prove a conversation is running. The caller separately verifies its own pane. */
export async function assertNativeResumeAvailable(
  target: { slug: string; nativeSessionId: string },
  excludedBackendSessionId: string | null,
  candidates: NativeResumeOwnerCandidate[],
  observe: (candidate: NativeResumeOwnerCandidate) => Promise<NativeResumeProcess[]>,
): Promise<void> {
  let uncertain = false;
  for (const candidate of candidates) {
    if (candidate.backendSessionId === excludedBackendSessionId) continue;
    const cachedMatch = candidate.cachedSlug === target.slug && candidate.cachedNativeId === target.nativeSessionId;
    let processes: NativeResumeProcess[];
    try { processes = await observe(candidate); }
    catch { if (cachedMatch) uncertain = true; continue; }
    for (const process of processes) {
      if (process.confirmed && process.agentSlug === target.slug && process.nativeId === target.nativeSessionId) {
        integrationError('NATIVE_SESSION_ALREADY_RUNNING', 'Another terminal process proves the exact native conversation is running', 409);
      }
      if (cachedMatch && (!process.confirmed || process.agentSlug === target.slug && !process.nativeId)) uncertain = true;
    }
  }
  if (uncertain) integrationError('NATIVE_SESSION_OWNER_UNCONFIRMED', 'A possible native owner cannot be verified; inspect its terminal before restoring', 409);
}
