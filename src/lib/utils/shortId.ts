/** The short id a collaboration surface shows for a UUID, matching the server's
 *  `canonicalShortId` (src/server/agent/collaborationProtocol.ts) — keep the
 *  two in sync. Display only: requests and stored records always carry the full
 *  id. Ids that are not canonical UUIDs (a session id like `40bc89py`, a
 *  `remote:<origin>:<id>` address) pass through untouched. */
export function shortId(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id.slice(0, 10)
    : id;
}
