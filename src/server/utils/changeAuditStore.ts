import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

const STATE_DIR = path.join(os.homedir(), '.termdock');
const STORE_PATH = path.join(STATE_DIR, 'change-audit.json');
const MAX_RECORDS = 5_000;
const CACHE_REFRESH_INTERVAL_MS = 2_000;

export interface ChangeAuditHunkExplanation {
  repoRoot: string;
  filePath: string;
  oldPath?: string | null;
  newPath?: string | null;
  hunkHeader: string;
  hunkIndex?: number | null;
  fingerprint: string;
  explanation: string;
  summary?: string | null;
}

export interface ChangeAuditPayload {
  workspaceRoot?: string | null;
  repoRoot?: string | null;
  generatedBy?: string | null;
  records: ChangeAuditHunkExplanation[];
}

export interface StoredChangeAuditRecord extends ChangeAuditHunkExplanation {
  id: string;
  workspaceRoot?: string | null;
  generatedBy?: string | null;
  injectedAt: number;
}

interface PersistedChangeAuditState {
  version: 1;
  records: StoredChangeAuditRecord[];
  branchRecords?: StoredBranchAuditRecord[];
}

export interface BranchAuditPayload {
  workspaceRoot?: string | null;
  repoRoot?: string | null;
  baseRef?: string | null;
  branchName?: string | null;
  headRef?: string | null;
  diffFingerprint?: string | null;
  explanation?: string | null;
  summary?: string | null;
  generatedBy?: string | null;
  records?: BranchAuditHunkExplanation[];
}

export interface BranchAuditHunkExplanation {
  repoRoot?: string | null;
  baseRef?: string | null;
  branchName?: string | null;
  headRef?: string | null;
  filePath: string;
  oldPath?: string | null;
  newPath?: string | null;
  hunkHeader: string;
  hunkIndex?: number | null;
  fingerprint: string;
  diff?: string | null;
  explanation: string;
  summary?: string | null;
}

export interface StoredBranchAuditRecord {
  id: string;
  workspaceRoot?: string | null;
  repoRoot: string;
  baseRef: string;
  branchName?: string | null;
  headRef?: string | null;
  diffFingerprint?: string | null;
  filePath: string;
  oldPath?: string | null;
  newPath?: string | null;
  hunkHeader: string;
  hunkIndex?: number | null;
  fingerprint: string;
  diff?: string | null;
  explanation: string;
  summary?: string | null;
  generatedBy?: string | null;
  injectedAt: number;
}

let cachedState: PersistedChangeAuditState = { version: 1, records: [] };
let cachedMtimeMs = 0;
let reloadInFlight = false;
let lastRefreshStartedAt = 0;

// Change audit explanations are auxiliary sidebar data. Keep the browser GET
// path non-blocking: return the in-memory snapshot immediately and refresh the
// on-disk JSON in the background. Do not move readFile/JSON.parse back into
// listChangeAuditRecords(); it shares the same Node process as Git bundle,
// file tree and diff requests, so synchronous work here can stall the entire
// Changes tab.

function parseState(raw: string): PersistedChangeAuditState {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedChangeAuditState>;
    return {
      version: 1,
      records: Array.isArray(parsed.records) ? parsed.records.filter(isStoredRecord) : [],
      branchRecords: Array.isArray(parsed.branchRecords) ? parsed.branchRecords.filter(isStoredBranchRecord) : [],
    };
  } catch {
    return { version: 1, records: [] };
  }
}

function readStateForMutation(): PersistedChangeAuditState {
  try {
    const stat = fs.statSync(STORE_PATH);
    if (stat.mtimeMs === cachedMtimeMs) return cachedState;
    cachedState = parseState(fs.readFileSync(STORE_PATH, 'utf8'));
    cachedMtimeMs = stat.mtimeMs;
  } catch {
    cachedState = { version: 1, records: [] };
    cachedMtimeMs = 0;
  }
  return cachedState;
}

export function refreshChangeAuditCache(): void {
  const now = Date.now();
  if (now - lastRefreshStartedAt < CACHE_REFRESH_INTERVAL_MS) return;
  if (reloadInFlight) return;
  lastRefreshStartedAt = now;
  reloadInFlight = true;
  void (async () => {
    try {
      const stat = await fs.promises.stat(STORE_PATH);
      if (stat.mtimeMs !== cachedMtimeMs) {
        const raw = await fs.promises.readFile(STORE_PATH, 'utf8');
        cachedState = parseState(raw);
        cachedMtimeMs = stat.mtimeMs;
      }
    } catch {
      cachedState = { version: 1, records: [] };
      cachedMtimeMs = 0;
    } finally {
      reloadInFlight = false;
    }
  })();
}

function writeState(state: PersistedChangeAuditState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  cachedState = state;
  try {
    cachedMtimeMs = fs.statSync(STORE_PATH).mtimeMs;
  } catch {
    cachedMtimeMs = 0;
  }
}

function isStoredRecord(value: unknown): value is StoredChangeAuditRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredChangeAuditRecord>;
  return typeof record.id === 'string'
    && typeof record.repoRoot === 'string'
    && typeof record.filePath === 'string'
    && typeof record.hunkHeader === 'string'
    && typeof record.fingerprint === 'string'
    && typeof record.explanation === 'string'
    && typeof record.injectedAt === 'number';
}

function isStoredBranchRecord(value: unknown): value is StoredBranchAuditRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredBranchAuditRecord>;
  return typeof record.id === 'string'
    && typeof record.repoRoot === 'string'
    && typeof record.baseRef === 'string'
    && typeof record.filePath === 'string'
    && typeof record.hunkHeader === 'string'
    && typeof record.fingerprint === 'string'
    && (record.diff === undefined || record.diff === null || typeof record.diff === 'string')
    && typeof record.explanation === 'string'
    && typeof record.injectedAt === 'number';
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeRecord(record: ChangeAuditHunkExplanation, fallback: { workspaceRoot?: string | null; repoRoot?: string | null; generatedBy?: string | null }, injectedAt: number): StoredChangeAuditRecord | null {
  const repoRoot = normalizeString(record.repoRoot) ?? normalizeString(fallback.repoRoot);
  const filePath = normalizeString(record.filePath);
  const hunkHeader = normalizeString(record.hunkHeader);
  const fingerprint = normalizeString(record.fingerprint);
  const explanation = normalizeString(record.explanation);
  if (!repoRoot || !filePath || !hunkHeader || !fingerprint || !explanation) return null;

  const oldPath = normalizeString(record.oldPath);
  const newPath = normalizeString(record.newPath);
  const summary = normalizeString(record.summary);
  const hunkIndex = typeof record.hunkIndex === 'number' && Number.isFinite(record.hunkIndex)
    ? Math.max(0, Math.floor(record.hunkIndex))
    : null;
  const id = buildChangeAuditRecordId({ repoRoot, filePath, hunkHeader, fingerprint });
  return {
    id,
    repoRoot,
    filePath,
    oldPath,
    newPath,
    hunkHeader,
    hunkIndex,
    fingerprint,
    explanation,
    summary,
    workspaceRoot: normalizeString(fallback.workspaceRoot),
    generatedBy: normalizeString(fallback.generatedBy),
    injectedAt,
  };
}

export function buildChangeAuditFingerprint(parts: string[]): string {
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 16);
}

export function buildChangeAuditRecordId(input: Pick<ChangeAuditHunkExplanation, 'repoRoot' | 'filePath' | 'hunkHeader' | 'fingerprint'>): string {
  return createHash('sha256')
    .update(`${input.repoRoot}\0${input.filePath}\0${input.hunkHeader}\0${input.fingerprint}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

export function buildBranchAuditRecordId(input: Pick<StoredBranchAuditRecord, 'repoRoot' | 'baseRef' | 'filePath' | 'hunkHeader' | 'fingerprint'> & { branchName?: string | null }): string {
  return createHash('sha256')
    .update(`${input.repoRoot}\0${input.baseRef}\0${input.branchName ?? ''}\0${input.filePath}\0${input.hunkHeader}\0${input.fingerprint}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

export function injectChangeAudit(payload: ChangeAuditPayload): { inserted: number; total: number; records: StoredChangeAuditRecord[] } {
  const injectedAt = Date.now();
  const normalized = (Array.isArray(payload.records) ? payload.records : [])
    .map((record) => normalizeRecord(record, payload, injectedAt))
    .filter((record): record is StoredChangeAuditRecord => record !== null);
  if (normalized.length === 0) return { inserted: 0, total: 0, records: [] };

  const state = readStateForMutation();
  const nextById = new Map(state.records.map((record) => [record.id, record]));
  for (const record of normalized) nextById.set(record.id, record);
  const records = Array.from(nextById.values())
    .sort((a, b) => b.injectedAt - a.injectedAt)
    .slice(0, MAX_RECORDS);
  writeState({ ...state, records });
  return { inserted: normalized.length, total: records.length, records: normalized };
}

export function clearChangeAuditRecords(filter: { ids?: string[]; workspaceRoot?: string | null; repoRoot?: string | null } = {}): { deleted: number; total: number } {
  const state = readStateForMutation();
  const ids = new Set((Array.isArray(filter.ids) ? filter.ids : []).filter((id) => typeof id === 'string' && id.length > 0));
  const workspaceRoot = normalizeString(filter.workspaceRoot);
  const repoRoot = normalizeString(filter.repoRoot);
  const shouldDelete = (record: StoredChangeAuditRecord) => {
    if (ids.size > 0) return ids.has(record.id);
    if (repoRoot) return record.repoRoot === repoRoot;
    if (workspaceRoot) return record.workspaceRoot === workspaceRoot;
    return false;
  };
  const records = state.records.filter((record) => !shouldDelete(record));
  const deleted = state.records.length - records.length;
  if (deleted > 0) writeState({ ...state, records });
  return { deleted, total: records.length };
}

function normalizeBranchRecord(record: BranchAuditHunkExplanation, fallback: BranchAuditPayload, injectedAt: number): StoredBranchAuditRecord | null {
  const repoRoot = normalizeString(record.repoRoot) ?? normalizeString(fallback.repoRoot);
  const baseRef = normalizeString(record.baseRef) ?? normalizeString(fallback.baseRef);
  const filePath = normalizeString(record.filePath);
  const hunkHeader = normalizeString(record.hunkHeader);
  const fingerprint = normalizeString(record.fingerprint);
  const explanation = normalizeString(record.explanation);
  if (!repoRoot || !baseRef || !filePath || !hunkHeader || !fingerprint || !explanation) return null;
  const branchName = normalizeString(record.branchName) ?? normalizeString(fallback.branchName);
  const hunkIndex = typeof record.hunkIndex === 'number' && Number.isFinite(record.hunkIndex)
    ? Math.max(0, Math.floor(record.hunkIndex))
    : null;
  return {
    id: buildBranchAuditRecordId({ repoRoot, baseRef, branchName, filePath, hunkHeader, fingerprint }),
    workspaceRoot: normalizeString(fallback.workspaceRoot),
    repoRoot,
    baseRef,
    branchName,
    headRef: normalizeString(record.headRef) ?? normalizeString(fallback.headRef),
    diffFingerprint: normalizeString(fallback.diffFingerprint),
    filePath,
    oldPath: normalizeString(record.oldPath),
    newPath: normalizeString(record.newPath),
    hunkHeader,
    hunkIndex,
    fingerprint,
    diff: normalizeString(record.diff),
    explanation,
    summary: normalizeString(record.summary),
    generatedBy: normalizeString(fallback.generatedBy),
    injectedAt,
  };
}

export function injectBranchAudit(payload: BranchAuditPayload): { inserted: number; total: number; records: StoredBranchAuditRecord[] } {
  const injectedAt = Date.now();
  const sourceRecords = Array.isArray(payload.records) ? payload.records : [];
  const normalized = sourceRecords
    .map((record) => normalizeBranchRecord(record, payload, injectedAt))
    .filter((record): record is StoredBranchAuditRecord => record !== null);
  if (normalized.length === 0) return { inserted: 0, total: cachedState.branchRecords?.length ?? 0, records: [] };

  const state = readStateForMutation();
  const nextById = new Map((state.branchRecords ?? []).map((entry) => [entry.id, entry]));
  for (const record of normalized) nextById.set(record.id, record);
  const branchRecords = Array.from(nextById.values())
    .sort((a, b) => b.injectedAt - a.injectedAt)
    .slice(0, MAX_RECORDS);
  writeState({ ...state, branchRecords });
  return { inserted: normalized.length, total: branchRecords.length, records: normalized };
}

export function clearBranchAuditRecords(filter: { ids?: string[]; workspaceRoot?: string | null; repoRoot?: string | null; baseRef?: string | null; branchName?: string | null } = {}): { deleted: number; total: number } {
  const state = readStateForMutation();
  const ids = new Set((Array.isArray(filter.ids) ? filter.ids : []).filter((id) => typeof id === 'string' && id.length > 0));
  const workspaceRoot = normalizeString(filter.workspaceRoot);
  const repoRoot = normalizeString(filter.repoRoot);
  const baseRef = normalizeString(filter.baseRef);
  const branchName = normalizeString(filter.branchName);
  const current = state.branchRecords ?? [];
  const shouldDelete = (record: StoredBranchAuditRecord) => {
    if (ids.size > 0) return ids.has(record.id);
    if (repoRoot && record.repoRoot !== repoRoot) return false;
    if (workspaceRoot && record.workspaceRoot && record.workspaceRoot !== workspaceRoot) return false;
    if (baseRef && record.baseRef !== baseRef) return false;
    if (branchName && record.branchName !== branchName) return false;
    return Boolean(repoRoot || workspaceRoot || baseRef || branchName);
  };
  const branchRecords = current.filter((record) => !shouldDelete(record));
  const deleted = current.length - branchRecords.length;
  if (deleted > 0) writeState({ ...state, branchRecords });
  return { deleted, total: branchRecords.length };
}

export function listChangeAuditRecords(filter: { workspaceRoot?: string | null; repoRoot?: string | null } = {}): { records: StoredChangeAuditRecord[]; loading: boolean } {
  refreshChangeAuditCache();
  const workspaceRoot = normalizeString(filter.workspaceRoot);
  const repoRoot = normalizeString(filter.repoRoot);
  const records = cachedState.records.filter((record) => {
    if (repoRoot && record.repoRoot !== repoRoot) return false;
    if (workspaceRoot && record.workspaceRoot && record.workspaceRoot !== workspaceRoot) return false;
    return true;
  });
  return { records, loading: reloadInFlight };
}

export function listBranchAuditRecords(filter: { workspaceRoot?: string | null; repoRoot?: string | null; baseRef?: string | null; branchName?: string | null } = {}): { records: StoredBranchAuditRecord[]; loading: boolean } {
  refreshChangeAuditCache();
  const workspaceRoot = normalizeString(filter.workspaceRoot);
  const repoRoot = normalizeString(filter.repoRoot);
  const baseRef = normalizeString(filter.baseRef);
  const branchName = normalizeString(filter.branchName);
  const records = (cachedState.branchRecords ?? []).filter((record) => {
    if (repoRoot && record.repoRoot !== repoRoot) return false;
    if (workspaceRoot && record.workspaceRoot && record.workspaceRoot !== workspaceRoot) return false;
    if (baseRef && record.baseRef !== baseRef) return false;
    if (branchName && record.branchName !== branchName) return false;
    return true;
  });
  return { records, loading: reloadInFlight };
}
