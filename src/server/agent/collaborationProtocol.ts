import crypto from 'node:crypto';

/** Transport facts and application reports deliberately remain separate. */
export const COLLAB_LIMITS = {
  message_bytes: 1_048_576,
  metadata_bytes: 16_384,
  wire_bytes: 1_572_864,
  fragment_bytes: 32_768,
  fragment_ttl_ms: 86_400_000,
  idempotency_retention_ms: 7 * 86_400_000,
  default_page_size: 50,
  max_page_size: 200,
} as const;
export type ResponseKind = 'ack' | 'progress' | 'result';
export interface TaskEnvelope {
  task_id: string;
  status: 'ack' | 'working' | 'blocked' | 'complete' | 'failed';
  progress?: number;
  evidence?: unknown;
  blocker?: string;
}
export interface MessageExtras {
  idempotencyKey?: string;
  responseKind?: ResponseKind;
  metadata?: Record<string, unknown>;
  task?: TaskEnvelope;
  expiresAt?: number | null;
}
export class CollaborationError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 400) { super(message); }
}

/** A delivered terminal shows a short id, because a 36-character one wraps in
 *  a narrow pane and has to be retyped by whoever answers it. New ids are
 *  minted at that length already (newCollaborationId); ids stored before that
 *  change are UUIDs, and read-only shortening renders those as their first
 *  SHORT_ID_LENGTH characters. Both forms are the same width and both resolve,
 *  so the display is uniform across the old and new records.
 *
 *  The length is 10 rather than 8 because a UUID's 9th character is always a
 *  hyphen: at 10 characters a legacy UUID displays as `765c8819-a`, and since
 *  base36 never draws a hyphen that exact id cannot be minted, so a new id
 *  landing on an older UUID's displayed form is impossible by construction
 *  instead of merely guarded against. The space is also 36^10 ≈ 3.7e15, 1296×
 *  the 8-character one.
 *
 *  Anything that is neither a UUID nor an already-short id passes through
 *  untouched — a hand-written session id (`40bc89py`), a
 *  `remote:<origin>:<id>` address or a `cross-<uuid>` federated group are
 *  either already short or decoded by their own structural rules
 *  (`split(':')`), so truncating them would corrupt the parse. Storage, wire
 *  format, receipts and federation always carry the id as stored; nothing is
 *  rewritten on read. */
export const SHORT_ID_LENGTH = 10;
/** Shortest input accepted as a prefix; below this a lookup is exact-match
 *  only, so a one-character typo never turns into an ambiguity error. With
 *  10-character ids a 4-character prefix is routinely shared, so callers who
 *  type a prefix rather than the whole id should expect to be told to add
 *  characters. */
export const MIN_ID_PREFIX_LENGTH = 4;
const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function canonicalShortId(id: string): string {
  return CANONICAL_ID.test(id) ? id.slice(0, SHORT_ID_LENGTH) : id;
}
/** Lowercase base36, matching the session ids this system already mints. The
 *  10-character space is 36^10 ≈ 3.7e15 values. */
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Drawn from a CSPRNG: an id is the only thing standing between a caller and
 *  a message they are not party to, and a predictable sequence would let a
 *  member of one group walk into another's. */
export function drawCollaborationId(): string {
  let id = '';
  for (let index = 0; index < SHORT_ID_LENGTH; index += 1) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return id;
}
/** Mint a message, thread or group id, refusing anything already in `taken`.
 *  `taken` must hold every id in use *and* the truncated form each one
 *  displays as: resolveIdPrefix prefers an exact match, so a new id equal to a
 *  stored UUID's display prefix would win that race and hide the older
 *  message. At SHORT_ID_LENGTH = 10 a UUID's displayed form cannot be drawn
 *  at all (position 9 is a hyphen, which base36 never produces), but the guard
 *  stays because `taken` also holds ids that are short already. Locally this
 *  makes collisions impossible.
 *
 *  Across machines that merge by id — federation carries ids as given, it
 *  cannot rewrite them — two independent draws still collide with probability
 *  ≈ n_A·n_B/36^10, about 1 in 900 million with both sides at the
 *  2,000-message retention cap. A collision is not detected and does not
 *  simply drop a message: the two records merge by id, and because a
 *  higher-ranked status overwrites the receipt, a message that was never
 *  delivered can be reported as read. That fake receipt is what this length
 *  buys down (mergeFederatedMessages in collaborationStore.ts). */
export function newCollaborationId(taken: Set<string>, draw: () => string = drawCollaborationId): string {
  for (;;) {
    const id = draw();
    if (!taken.has(id)) { taken.add(id); return id; }
  }
}
export type IdResolution = { status: 'ok'; id: string } | { status: 'ambiguous'; matches: string[] } | { status: 'not-found' };
/** Resolve what a user typed against the ids that exist, git-style: an exact
 *  match always wins, otherwise a prefix of at least MIN_ID_PREFIX_LENGTH
 *  characters resolves when it is unique. Callers turn 'ambiguous' into an
 *  error built by ambiguousIdMessage. */
export function resolveIdPrefix(ids: string[], input: string): IdResolution {
  if (ids.includes(input)) return { status: 'ok', id: input };
  if (input.length < MIN_ID_PREFIX_LENGTH) return { status: 'not-found' };
  const matches = ids.filter((id) => id.startsWith(input));
  if (matches.length === 1) return { status: 'ok', id: matches[0]! };
  return matches.length ? { status: 'ambiguous', matches } : { status: 'not-found' };
}
/** Both message and group lookups answer an ambiguous prefix the same way: say
 *  how many matched, never which ones (a prefix search can reach another
 *  session's ids), and name the way out. */
export function ambiguousIdMessage(kind: '消息' | '协作组', count: number): string {
  return `${kind} id 前缀匹配到 ${count} 个对象，请提供更长的前缀或完整 id`;
}
export function validateExtras(input: MessageExtras): MessageExtras {
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 256)) {
    throw new CollaborationError('INVALID_IDEMPOTENCY_KEY', 'idempotency key must contain 1–256 characters');
  }
  if (input.responseKind !== undefined && !['ack', 'progress', 'result'].includes(input.responseKind)) throw new CollaborationError('INVALID_RESPONSE_KIND', 'response_kind must be ack, progress or result');
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) throw new CollaborationError('INVALID_METADATA', 'metadata must be a JSON object');
  const task = input.task;
  if (task !== undefined && (!task || typeof task.task_id !== 'string' || !task.task_id.trim() || task.task_id.length > 256
    || !['ack', 'working', 'blocked', 'complete', 'failed'].includes(task.status)
    || (task.progress !== undefined && (!Number.isFinite(task.progress) || task.progress < 0 || task.progress > 100))
    || (task.blocker !== undefined && typeof task.blocker !== 'string'))) throw new CollaborationError('INVALID_TASK', 'task requires task_id and status; progress is 0–100');
  const inferred: ResponseKind | undefined = task ? task.status === 'ack' ? 'ack' : ['complete', 'failed'].includes(task.status) ? 'result' : 'progress' : undefined;
  if (inferred && input.responseKind && inferred !== input.responseKind) throw new CollaborationError('TASK_KIND_CONFLICT', 'response_kind conflicts with task.status');
  if (input.expiresAt != null && (!Number.isFinite(input.expiresAt) || input.expiresAt <= 0)) throw new CollaborationError('INVALID_EXPIRY', 'expires_at must be an epoch millisecond timestamp');
  const extras = { idempotencyKey: input.idempotencyKey, responseKind: input.responseKind ?? inferred, metadata: input.metadata, task: input.task, expiresAt: input.expiresAt };
  if (Buffer.byteLength(JSON.stringify(extras)) > COLLAB_LIMITS.metadata_bytes) throw new CollaborationError('METADATA_TOO_LARGE', `metadata and task envelope exceed ${COLLAB_LIMITS.metadata_bytes} bytes`, 413);
  return extras;
}
export function extrasFromBody(body: Record<string, unknown>): MessageExtras {
  return validateExtras({ idempotencyKey: body.idempotency_key as string | undefined,
    responseKind: body.response_kind as ResponseKind | undefined, metadata: body.metadata as Record<string, unknown> | undefined,
    task: body.task as TaskEnvelope | undefined, expiresAt: body.expires_at as number | undefined });
}
export interface TransportDiagnostic {
  relay_online: boolean | null;
  peer_reachable: boolean | null;
  attempt_count: number;
  next_retry_at: number | null;
  last_error: string | null;
  checked_at: number;
  fragments_sent?: number;
  fragments_total?: number;
}
export interface MessageFragment {
  message_id: string;
  group_id: string;
  index: number;
  total: number;
  sha256: string;
  data: string;
}
export const STATUS_RANK = { pending: 0, failed: 1, expired: 1, delivered: 2, read: 3 } as const;
