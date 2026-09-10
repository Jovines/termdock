import { describe, expect, it } from 'vitest';
import { MIN_ID_PREFIX_LENGTH, SHORT_ID_LENGTH, ambiguousIdMessage, canonicalShortId, resolveIdPrefix } from './collaborationProtocol.js';

const UUID = '765c8819-ae14-46ae-b615-186eb5fd8b1f';
const UUID_B = '765c9999-0000-4000-8000-000000000000';

describe('collaboration id shortening', () => {
  it('shortens canonical UUIDs to the displayed 8 characters', () => {
    expect(SHORT_ID_LENGTH).toBe(8);
    expect(canonicalShortId(UUID)).toBe('765c8819');
    expect(canonicalShortId('00000000-0000-4000-8000-000000000000')).toHaveLength(8);
  });

  it('passes through every id that is not a canonical UUID', () => {
    // A short session id is already as short as it gets; truncating the
    // structural forms would break their own parsing (split(':'), cross- prefix).
    expect(canonicalShortId('40bc89py')).toBe('40bc89py');
    expect(canonicalShortId('remote:https%3A%2F%2Fa.example:40bc89py')).toBe('remote:https%3A%2F%2Fa.example:40bc89py');
    expect(canonicalShortId('cross-765c8819-ae14-46ae-b615-186eb5fd8b1f')).toBe('cross-765c8819-ae14-46ae-b615-186eb5fd8b1f');
    expect(canonicalShortId('')).toBe('');
    // Uppercase is still a UUID; a near-miss (short group, no dashes) is not.
    expect(canonicalShortId('765C8819-AE14-46AE-B615-186EB5FD8B1F')).toBe('765C8819');
    expect(canonicalShortId('765c8819ae1446aeb615186eb5fd8b1f')).toBe('765c8819ae1446aeb615186eb5fd8b1f');
  });
});

describe('id prefix resolution', () => {
  const ids = [UUID, UUID_B, '40bc89py'];

  it('prefers an exact match over any prefix match', () => {
    expect(resolveIdPrefix(ids, UUID)).toEqual({ status: 'ok', id: UUID });
    expect(resolveIdPrefix(ids, '40bc89py')).toEqual({ status: 'ok', id: '40bc89py' });
  });

  it('resolves a unique prefix', () => {
    expect(resolveIdPrefix(ids, '765c8819')).toEqual({ status: 'ok', id: UUID });
    expect(resolveIdPrefix(ids, '765c9')).toEqual({ status: 'ok', id: UUID_B });
  });

  it('reports ambiguity instead of guessing', () => {
    expect(resolveIdPrefix(ids, '765c')).toEqual({ status: 'ambiguous', matches: [UUID, UUID_B] });
  });

  it('is exact-match only below the minimum prefix length', () => {
    // '7' uniquely prefixes both uuids but is far too short to be an intent.
    expect(MIN_ID_PREFIX_LENGTH).toBe(4);
    expect(resolveIdPrefix(ids, '7')).toEqual({ status: 'not-found' });
    expect(resolveIdPrefix(ids, '765')).toEqual({ status: 'not-found' });
    expect(resolveIdPrefix(ids, '765c')).toMatchObject({ status: 'ambiguous' });
  });

  it('reports no match for an unknown id', () => {
    expect(resolveIdPrefix(ids, 'deadbeef')).toEqual({ status: 'not-found' });
    expect(resolveIdPrefix([], '765c8819')).toEqual({ status: 'not-found' });
  });

  it('words an ambiguity without naming the matches', () => {
    // A prefix search can reach ids belonging to another session; only the
    // count may leave the server.
    const message = ambiguousIdMessage('消息', 3);
    expect(message).toContain('3');
    expect(message).not.toContain('765c');
  });
});
