import { describe, expect, it } from 'vitest';
import { MIN_ID_PREFIX_LENGTH, SHORT_ID_LENGTH, ambiguousIdMessage, canonicalShortId, drawCollaborationId, newCollaborationId, resolveIdPrefix } from './collaborationProtocol.js';

const UUID = '765c8819-ae14-46ae-b615-186eb5fd8b1f';
const UUID_B = '765c9999-0000-4000-8000-000000000000';

describe('collaboration id shortening', () => {
  it('shortens canonical UUIDs to the displayed length', () => {
    expect(SHORT_ID_LENGTH).toBe(10);
    expect(canonicalShortId(UUID)).toBe('765c8819-a');
    expect(canonicalShortId('00000000-0000-4000-8000-000000000000')).toHaveLength(SHORT_ID_LENGTH);
  });

  it('puts a hyphen in every shortened UUID, which base36 can never mint', () => {
    // The reason the length is 10 and not 8: a UUID's 9th character is always
    // the hyphen after its first group, so a shortened UUID is not a string
    // drawCollaborationId can produce. A minted id therefore cannot land on an
    // older UUID's displayed form, which is what would make an exact match
    // outrank the prefix and hide the stored record. This is the property the
    // takenIds guard backstops; it does not need to carry it alone.
    expect(canonicalShortId(UUID)).toBe(`${UUID.slice(0, 8)}-a`);
    for (const id of [UUID, UUID_B, '00000000-0000-4000-8000-000000000000']) {
      expect(canonicalShortId(id)[8]).toBe('-');
    }
    // ...and no draw can carry one either, so the two forms never intersect.
    const drawn = Array.from({ length: 200 }, () => drawCollaborationId());
    expect(drawn.some((id) => id.includes('-'))).toBe(false);
    expect(drawn).not.toContain(canonicalShortId(UUID));
  });

  it('passes through every id that is not a canonical UUID', () => {
    // A short session id is already as short as it gets; truncating the
    // structural forms would break their own parsing (split(':'), cross- prefix).
    expect(canonicalShortId('40bc89py')).toBe('40bc89py');
    expect(canonicalShortId('remote:https%3A%2F%2Fa.example:40bc89py')).toBe('remote:https%3A%2F%2Fa.example:40bc89py');
    expect(canonicalShortId('cross-765c8819-ae14-46ae-b615-186eb5fd8b1f')).toBe('cross-765c8819-ae14-46ae-b615-186eb5fd8b1f');
    expect(canonicalShortId('')).toBe('');
    // Uppercase is still a UUID; a near-miss (short group, no dashes) is not.
    expect(canonicalShortId('765C8819-AE14-46AE-B615-186EB5FD8B1F')).toBe('765C8819-A');
    expect(canonicalShortId('765c8819ae1446aeb615186eb5fd8b1f')).toBe('765c8819ae1446aeb615186eb5fd8b1f');
  });
});

describe('id generation', () => {
  it('mints the displayed length directly instead of a long id that gets cut', () => {
    const id = drawCollaborationId();
    expect(id).toHaveLength(SHORT_ID_LENGTH);
    // Lowercase base36, the same alphabet session ids already use.
    expect(id).toMatch(/^[0-9a-z]{10}$/);
    expect(canonicalShortId(id)).toBe(id);
    expect(new Set(Array.from({ length: 500 }, () => drawCollaborationId())).size).toBe(500);
  });

  it('redraws rather than returning an id already in use', () => {
    const draws = ['dup', 'dup00000', 'free0001'];
    let index = 0;
    // 'dup' is taken, 'dup00000' is taken, so the third draw is the one used —
    // a single retry would have yielded a collision.
    const taken = new Set(['dup', 'dup00000']);
    expect(newCollaborationId(taken, () => draws[index++]!)).toBe('free0001');
    // The chosen id joins the taken set, so the next call cannot reuse it.
    expect(taken.has('free0001')).toBe(true);
  });

  it('keeps drawing until a non-colliding id appears', () => {
    let calls = 0;
    const id = newCollaborationId(new Set(['aa']), () => (calls++ < 5 ? 'aa' : 'bb'));
    expect(id).toBe('bb');
    expect(calls).toBe(6);
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
