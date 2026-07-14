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
  sectionIndex?: number | null;
  sectionFingerprint?: string | null;
  fingerprint: string;
  explanation: string;
  summary?: string | null;
}

export interface ChangeWalkthroughAnchor {
  repoRoot?: string | null;
  filePath: string;
  hunkHeader?: string | null;
  hunkIndex?: number | null;
  hunkFingerprint?: string | null;
  sectionIndex?: number | null;
  sectionFingerprint?: string | null;
}

export interface ChangeWalkthroughHighlight {
  what: string;
  effect: string;
  tag?: string | null;
}

export interface ChangeWalkthroughNode {
  id: string;
  title: string;
  kind?: string | null;
  summary?: string | null;
  business: string;
  anchor?: ChangeWalkthroughAnchor | null;
}

export interface ChangeWalkthroughEdge {
  from: string;
  to: string;
  label?: string | null;
  desc?: string | null;
}

export interface ChangeWalkthroughSection {
  id: string;
  nodeId?: string | null;
  anchor: ChangeWalkthroughAnchor;
  summary: string;
  explanation?: string | null;
}

export interface ChangeWalkthroughRisk {
  title: string;
  anchor?: ChangeWalkthroughAnchor | null;
}

export interface ChangeWalkthrough {
  version: 1;
  id: string;
  workspaceRoot?: string | null;
  repoRoot: string;
  baseRef?: string | null;
  branchName?: string | null;
  headRef?: string | null;
  diffFingerprint?: string | null;
  title: string;
  scope?: string | null;
  summary?: string | null;
  generatedBy?: string | null;
  injectedAt: number;
  highlights: ChangeWalkthroughHighlight[];
  nodes: ChangeWalkthroughNode[];
  edges: ChangeWalkthroughEdge[];
  sections: ChangeWalkthroughSection[];
  risks: ChangeWalkthroughRisk[];
  checks: string[];
}

export type ChangeWalkthroughInput = Partial<Omit<ChangeWalkthrough, 'version' | 'id' | 'repoRoot' | 'injectedAt'>> & {
  repoRoot?: string | null;
};

export interface ChangeAuditPayload {
  workspaceRoot?: string | null;
  repoRoot?: string | null;
  generatedBy?: string | null;
  walkthrough?: ChangeWalkthroughInput | null;
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
  walkthroughs?: ChangeWalkthrough[];
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
  walkthrough?: ChangeWalkthroughInput | null;
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
  sectionIndex?: number | null;
  sectionFingerprint?: string | null;
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
  sectionIndex?: number | null;
  sectionFingerprint?: string | null;
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
      walkthroughs: Array.isArray(parsed.walkthroughs) ? parsed.walkthroughs.filter(isStoredWalkthrough) : [],
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

function isStoredWalkthrough(value: unknown): value is ChangeWalkthrough {
  if (!value || typeof value !== 'object') return false;
  const walkthrough = value as Partial<ChangeWalkthrough>;
  return walkthrough.version === 1
    && typeof walkthrough.id === 'string'
    && typeof walkthrough.repoRoot === 'string'
    && typeof walkthrough.title === 'string'
    && typeof walkthrough.injectedAt === 'number'
    && Array.isArray(walkthrough.highlights)
    && Array.isArray(walkthrough.nodes)
    && Array.isArray(walkthrough.edges)
    && Array.isArray(walkthrough.sections)
    && Array.isArray(walkthrough.risks)
    && Array.isArray(walkthrough.checks);
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeWalkthroughAnchor(anchor: unknown, fallback: { repoRoot?: string | null }): ChangeWalkthroughAnchor | null {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return null;
  const maybe = anchor as Partial<ChangeWalkthroughAnchor>;
  const filePath = normalizeString(maybe.filePath);
  if (!filePath) return null;
  const hunkIndex = typeof maybe.hunkIndex === 'number' && Number.isFinite(maybe.hunkIndex)
    ? Math.max(0, Math.floor(maybe.hunkIndex))
    : null;
  const sectionIndex = typeof maybe.sectionIndex === 'number' && Number.isFinite(maybe.sectionIndex)
    ? Math.max(0, Math.floor(maybe.sectionIndex))
    : null;
  return {
    repoRoot: normalizeString(maybe.repoRoot) ?? normalizeString(fallback.repoRoot),
    filePath,
    hunkHeader: normalizeString(maybe.hunkHeader),
    hunkIndex,
    hunkFingerprint: normalizeString(maybe.hunkFingerprint),
    sectionIndex,
    sectionFingerprint: normalizeString(maybe.sectionFingerprint),
  };
}

function normalizeStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeString).filter((item): item is string => Boolean(item)).slice(0, max);
}

function compact<T>(items: Array<T | null>): T[] {
  return items.filter((item): item is T => item !== null);
}

function normalizeWalkthrough(input: ChangeWalkthroughInput | null | undefined, fallback: { workspaceRoot?: string | null; repoRoot?: string | null; generatedBy?: string | null; baseRef?: string | null; branchName?: string | null; headRef?: string | null; diffFingerprint?: string | null }, injectedAt: number): ChangeWalkthrough | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const repoRoot = normalizeString(input.repoRoot) ?? normalizeString(fallback.repoRoot);
  const title = normalizeString(input.title);
  if (!repoRoot || !title) return null;

  const highlights: ChangeWalkthroughHighlight[] = Array.isArray(input.highlights) ? compact(input.highlights.map((entry): ChangeWalkthroughHighlight | null => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const maybe = entry as Partial<ChangeWalkthroughHighlight>;
    const what = normalizeString(maybe.what);
    const effect = normalizeString(maybe.effect);
    if (!what || !effect) return null;
    return { what, effect, tag: normalizeString(maybe.tag) };
  })).slice(0, 8) : [];

  const nodes: ChangeWalkthroughNode[] = Array.isArray(input.nodes) ? compact(input.nodes.map((entry): ChangeWalkthroughNode | null => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const maybe = entry as Partial<ChangeWalkthroughNode>;
    const id = normalizeString(maybe.id);
    const nodeTitle = normalizeString(maybe.title);
    const business = normalizeString(maybe.business);
    if (!id || !nodeTitle || !business) return null;
    return {
      id,
      title: nodeTitle,
      kind: normalizeString(maybe.kind),
      summary: normalizeString(maybe.summary),
      business,
      anchor: normalizeWalkthroughAnchor(maybe.anchor, { repoRoot }),
    };
  })).slice(0, 24) : [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: ChangeWalkthroughEdge[] = Array.isArray(input.edges) ? compact(input.edges.map((entry): ChangeWalkthroughEdge | null => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const maybe = entry as Partial<ChangeWalkthroughEdge>;
    const from = normalizeString(maybe.from);
    const to = normalizeString(maybe.to);
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) return null;
    return { from, to, label: normalizeString(maybe.label), desc: normalizeString(maybe.desc) };
  })).slice(0, 32) : [];

  const sections: ChangeWalkthroughSection[] = Array.isArray(input.sections) ? compact(input.sections.map((entry): ChangeWalkthroughSection | null => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const maybe = entry as Partial<ChangeWalkthroughSection>;
    const id = normalizeString(maybe.id);
    const summary = normalizeString(maybe.summary);
    const anchor = normalizeWalkthroughAnchor(maybe.anchor, { repoRoot });
    if (!id || !summary || !anchor) return null;
    const nodeId = normalizeString(maybe.nodeId);
    return {
      id,
      nodeId: nodeId && nodeIds.has(nodeId) ? nodeId : null,
      anchor,
      summary,
      explanation: normalizeString(maybe.explanation),
    };
  })).slice(0, 200) : [];

  const risks: ChangeWalkthroughRisk[] = Array.isArray(input.risks) ? compact(input.risks.map((entry): ChangeWalkthroughRisk | null => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const maybe = entry as Partial<ChangeWalkthroughRisk>;
    const riskTitle = normalizeString(maybe.title);
    if (!riskTitle) return null;
    return { title: riskTitle, anchor: normalizeWalkthroughAnchor(maybe.anchor, { repoRoot }) };
  })).slice(0, 16) : [];

  const id = buildChangeAuditFingerprint([
    repoRoot,
    normalizeString(input.scope) ?? '',
    title,
    nodes.map((node) => node.id).join(','),
    sections.map((section) => `${section.anchor.filePath}:${section.anchor.hunkIndex ?? ''}:${section.anchor.sectionIndex ?? ''}:${section.anchor.sectionFingerprint ?? ''}`).join(','),
  ]);

  return {
    version: 1,
    id,
    workspaceRoot: normalizeString(input.workspaceRoot) ?? normalizeString(fallback.workspaceRoot),
    repoRoot,
    baseRef: normalizeString(input.baseRef) ?? normalizeString(fallback.baseRef),
    branchName: normalizeString(input.branchName) ?? normalizeString(fallback.branchName),
    headRef: normalizeString(input.headRef) ?? normalizeString(fallback.headRef),
    diffFingerprint: normalizeString(input.diffFingerprint) ?? normalizeString(fallback.diffFingerprint),
    title,
    scope: normalizeString(input.scope),
    summary: normalizeString(input.summary),
    generatedBy: normalizeString(input.generatedBy) ?? normalizeString(fallback.generatedBy),
    injectedAt,
    highlights,
    nodes,
    edges,
    sections,
    risks,
    checks: normalizeStringList(input.checks, 24),
  };
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
  const sectionIndex = typeof record.sectionIndex === 'number' && Number.isFinite(record.sectionIndex)
    ? Math.max(0, Math.floor(record.sectionIndex))
    : null;
  const sectionFingerprint = normalizeString(record.sectionFingerprint);
  const id = buildChangeAuditRecordId({ repoRoot, filePath, hunkHeader, fingerprint, sectionFingerprint, sectionIndex });
  return {
    id,
    repoRoot,
    filePath,
    oldPath,
    newPath,
    hunkHeader,
    hunkIndex,
    sectionIndex,
    sectionFingerprint,
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

export function buildChangeAuditRecordId(input: Pick<ChangeAuditHunkExplanation, 'repoRoot' | 'filePath' | 'hunkHeader' | 'fingerprint'> & { sectionFingerprint?: string | null; sectionIndex?: number | null }): string {
  return createHash('sha256')
    .update(`${input.repoRoot}\0${input.filePath}\0${input.hunkHeader}\0${input.fingerprint}\0${input.sectionIndex ?? ''}\0${input.sectionFingerprint ?? ''}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

export function buildBranchAuditRecordId(input: Pick<StoredBranchAuditRecord, 'repoRoot' | 'baseRef' | 'filePath' | 'hunkHeader' | 'fingerprint'> & { branchName?: string | null; sectionIndex?: number | null; sectionFingerprint?: string | null }): string {
  return createHash('sha256')
    .update(`${input.repoRoot}\0${input.baseRef}\0${input.branchName ?? ''}\0${input.filePath}\0${input.hunkHeader}\0${input.fingerprint}\0${input.sectionIndex ?? ''}\0${input.sectionFingerprint ?? ''}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

export function injectChangeAudit(payload: ChangeAuditPayload): { inserted: number; total: number; walkthroughs: number; records: StoredChangeAuditRecord[] } {
  const injectedAt = Date.now();
  const normalized = (Array.isArray(payload.records) ? payload.records : [])
    .map((record) => normalizeRecord(record, payload, injectedAt))
    .filter((record): record is StoredChangeAuditRecord => record !== null);
  const state = readStateForMutation();
  const nextById = new Map(state.records.map((record) => [record.id, record]));
  for (const record of normalized) nextById.set(record.id, record);
  const records = Array.from(nextById.values())
    .sort((a, b) => b.injectedAt - a.injectedAt)
    .slice(0, MAX_RECORDS);
  const walkthrough = normalizeWalkthrough(payload.walkthrough, payload, injectedAt);
  const walkthroughs = walkthrough
    ? [walkthrough, ...(state.walkthroughs ?? []).filter((entry) => entry.repoRoot !== walkthrough.repoRoot || entry.id !== walkthrough.id)].slice(0, 100)
    : state.walkthroughs;
  if (normalized.length > 0 || walkthrough) writeState({ ...state, records, walkthroughs });
  return { inserted: normalized.length, total: records.length, walkthroughs: walkthroughs?.length ?? 0, records: normalized };
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
  let walkthroughs = state.walkthroughs;
  if (repoRoot || workspaceRoot || ids.size === 0) {
    const currentWalkthroughs = state.walkthroughs ?? [];
    walkthroughs = currentWalkthroughs.filter((walkthrough) => {
      if (repoRoot && walkthrough.repoRoot === repoRoot) return false;
      if (workspaceRoot && walkthrough.workspaceRoot === workspaceRoot) return false;
      return true;
    });
  }
  if (deleted > 0 || walkthroughs !== state.walkthroughs) writeState({ ...state, records, walkthroughs });
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
  const sectionIndex = typeof record.sectionIndex === 'number' && Number.isFinite(record.sectionIndex)
    ? Math.max(0, Math.floor(record.sectionIndex))
    : null;
  const sectionFingerprint = normalizeString(record.sectionFingerprint);
  return {
    id: buildBranchAuditRecordId({ repoRoot, baseRef, branchName, filePath, hunkHeader, fingerprint, sectionIndex, sectionFingerprint }),
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
    sectionIndex,
    sectionFingerprint,
    fingerprint,
    diff: normalizeString(record.diff),
    explanation,
    summary: normalizeString(record.summary),
    generatedBy: normalizeString(fallback.generatedBy),
    injectedAt,
  };
}

export function injectBranchAudit(payload: BranchAuditPayload): { inserted: number; total: number; walkthroughs: number; records: StoredBranchAuditRecord[] } {
  const injectedAt = Date.now();
  const sourceRecords = Array.isArray(payload.records) ? payload.records : [];
  const normalized = sourceRecords
    .map((record) => normalizeBranchRecord(record, payload, injectedAt))
    .filter((record): record is StoredBranchAuditRecord => record !== null);

  const state = readStateForMutation();
  const nextById = new Map((state.branchRecords ?? []).map((entry) => [entry.id, entry]));
  for (const record of normalized) nextById.set(record.id, record);
  const branchRecords = Array.from(nextById.values())
    .sort((a, b) => b.injectedAt - a.injectedAt)
    .slice(0, MAX_RECORDS);
  const walkthrough = normalizeWalkthrough(payload.walkthrough, payload, injectedAt);
  const walkthroughs = walkthrough
    ? [walkthrough, ...(state.walkthroughs ?? []).filter((entry) => (
      entry.repoRoot !== walkthrough.repoRoot
      || entry.baseRef !== walkthrough.baseRef
      || entry.branchName !== walkthrough.branchName
      || entry.diffFingerprint !== walkthrough.diffFingerprint
      || entry.id !== walkthrough.id
    ))].slice(0, 100)
    : state.walkthroughs;
  if (normalized.length > 0 || walkthrough) writeState({ ...state, branchRecords, walkthroughs });
  return { inserted: normalized.length, total: branchRecords.length, walkthroughs: walkthroughs?.length ?? 0, records: normalized };
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
  let walkthroughs = state.walkthroughs;
  if (repoRoot || workspaceRoot || baseRef || branchName || ids.size === 0) {
    const currentWalkthroughs = state.walkthroughs ?? [];
    walkthroughs = currentWalkthroughs.filter((walkthrough) => {
      if (repoRoot && walkthrough.repoRoot !== repoRoot) return true;
      if (workspaceRoot && walkthrough.workspaceRoot && walkthrough.workspaceRoot !== workspaceRoot) return true;
      if (baseRef && walkthrough.baseRef !== baseRef) return true;
      if (branchName && walkthrough.branchName !== branchName) return true;
      return !(repoRoot || workspaceRoot || baseRef || branchName);
    });
  }
  if (deleted > 0 || walkthroughs !== state.walkthroughs) writeState({ ...state, branchRecords, walkthroughs });
  return { deleted, total: branchRecords.length };
}

export function listChangeAuditRecords(filter: { workspaceRoot?: string | null; repoRoot?: string | null } = {}): { records: StoredChangeAuditRecord[]; walkthroughs: ChangeWalkthrough[]; loading: boolean } {
  refreshChangeAuditCache();
  const workspaceRoot = normalizeString(filter.workspaceRoot);
  const repoRoot = normalizeString(filter.repoRoot);
  const records = cachedState.records.filter((record) => {
    if (repoRoot && record.repoRoot !== repoRoot) return false;
    if (workspaceRoot && record.workspaceRoot && record.workspaceRoot !== workspaceRoot) return false;
    return true;
  });
  const walkthroughs = (cachedState.walkthroughs ?? []).filter((walkthrough) => {
    if (repoRoot && walkthrough.repoRoot !== repoRoot) return false;
    if (workspaceRoot && walkthrough.workspaceRoot && walkthrough.workspaceRoot !== workspaceRoot) return false;
    return true;
  });
  return { records, walkthroughs, loading: reloadInFlight };
}

export function listBranchAuditRecords(filter: { workspaceRoot?: string | null; repoRoot?: string | null; baseRef?: string | null; branchName?: string | null } = {}): { records: StoredBranchAuditRecord[]; walkthroughs: ChangeWalkthrough[]; loading: boolean } {
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
  const walkthroughs = (cachedState.walkthroughs ?? []).filter((walkthrough) => {
    if (repoRoot && walkthrough.repoRoot !== repoRoot) return false;
    if (workspaceRoot && walkthrough.workspaceRoot && walkthrough.workspaceRoot !== workspaceRoot) return false;
    if (baseRef && walkthrough.baseRef !== baseRef) return false;
    if (branchName && walkthrough.branchName !== branchName) return false;
    return true;
  });
  return { records, walkthroughs, loading: reloadInFlight };
}
