import { isArchitectureFile, parseArchitecture, type ArchitectureDocument, type ArchitectureField } from './model';
import type { ArchitectureChange } from '../../server/architecture/documentDiff';
import { getCsrfToken } from '../terminal/api';

async function request(root: string, endpoint: string, signal?: AbortSignal, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ root });
  const response = await fetch(`/api/terminal/architecture/${endpoint}${body ? '' : `${endpoint.includes('?') ? '&' : '?'}${params}`}`, {
    signal, cache: 'no-store', ...(body ? { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': await getCsrfToken() }, body: JSON.stringify({ root, ...body }) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
export async function listNativeArchitectures(root: string, signal: AbortSignal): Promise<string[]> {
  const result = await request(root, 'documents', signal);
  if (!Array.isArray(result.files)) throw new Error('Invalid architecture library');
  return [...new Set(result.files.filter((file): file is string => typeof file === 'string' && isArchitectureFile(file)))].sort();
}
export async function readNativeArchitecture(root: string, file: string, signal?: AbortSignal): Promise<{ document: ArchitectureDocument | null; revision: string | null }> {
  if (!isArchitectureFile(file)) throw new Error('Invalid architecture file');
  const result = await request(root, `document?${new URLSearchParams({ file })}`, signal);
  if (!('document' in result) || (result.revision !== null && typeof result.revision !== 'string')) throw new Error('Invalid architecture response');
  return { document: result.document ? parseArchitecture(JSON.stringify(result.document)) : null, revision: typeof result.revision === 'string' ? result.revision : null };
}
export async function writeArchitectureField(root: string, file: string, perspective: string, node: string | undefined, field: ArchitectureField, value: string, revision: string | null) {
  const result = await request(root, 'field', undefined, { file, perspective, node, field, value, revision });
  return parseArchitecture(JSON.stringify(result.document));
}
export async function architectureHistory(root: string, file: string, signal?: AbortSignal): Promise<{ id: string; savedAt: string; changes: ArchitectureChange[] }[]> {
  const result = await request(root, `history?${new URLSearchParams({ file })}`, signal);
  if (!Array.isArray(result.versions)) throw new Error('Invalid architecture history');
  return result.versions as { id: string; savedAt: string; changes: ArchitectureChange[] }[];
}
export async function exportOmmArchitecture(root: string, file: string) { return request(root, `bundle?${new URLSearchParams({ file })}`); }
export async function importOmmArchitecture(root: string, bundle: unknown, revision?: string | null) {
  const result = await request(root, 'bundle', undefined, { bundle, revision });
  return parseArchitecture(JSON.stringify(result.document));
}
export async function saveNativeArchitecture(root: string, file: string, document: ArchitectureDocument, revision?: string | null) {
  const result = await request(root, 'document', undefined, { file, document, ...(revision !== undefined ? { revision } : {}) });
  return parseArchitecture(JSON.stringify(result.document));
}
