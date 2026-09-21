type GitRunner = (args: string[], timeoutMs?: number) => Promise<string>;
const MAX_SYNC_COMMITS = 1000;
const SYNC_STATUS_TIMEOUT_MS = 1500;
type SyncStatus = 'ahead' | 'behind' | 'synced';

// Resolve both tips once so a concurrent fetch cannot change classification mid-page.
export async function readRecentCommitHistory(run: GitRunner, { skip, limit, query }: { skip: number; limit: number; query: string }) {
  const head = (await run(['rev-parse', '--verify', '--quiet', 'HEAD']).catch((error) => {
    if (error?.code === 1) return '';
    throw error;
  })).trim();
  if (!head) return { commits: [], hasMore: false, commitSyncStatus: {}, upstream: null };
  const branch = (await run(['symbolic-ref', '-q', 'HEAD']).catch((error) => {
    if (error?.code === 1) return '';
    throw error;
  })).trim();
  const upstream = branch
    ? (await run(['for-each-ref', '--format=%(upstream)', '--count=1', branch])).trim() || null
    : null;
  const remote = upstream ? (await run(['rev-parse', '--verify', upstream])).trim() : null;
  const refs = remote ? [head, remote] : [head];
  const args = ['log', '--date-order', '--format=%H %s', `--skip=${skip}`, `-${limit + 1}`];
  if (query) args.push('--regexp-ignore-case', '--fixed-strings', `--grep=${query}`);
  let lines = (await run([...args, ...refs, '--'])).trim().split('\n').filter(Boolean);
  if (query && lines.length === 0 && /^[0-9a-f]{4,64}$/i.test(query)) {
    lines = (await run(['log', '--date-order', '--format=%H %s', `-${Math.max(skip + limit + 1, 200)}`, ...refs, '--']))
      .trim().split('\n').filter((line) => line.toLowerCase().startsWith(query.toLowerCase())).slice(skip, skip + limit + 1);
  }
  // Status badges are optional: never enumerate an unbounded divergence before
  // loading a page, or report an unclassified commit as synced after truncation.
  const unique = new Map<string, SyncStatus>();
  let completeSyncStatus = remote === head;
  if (remote && remote !== head && lines.length > 0) {
    try {
      const sides = (await run([
        'rev-list', '--left-right', `--max-count=${MAX_SYNC_COMMITS + 1}`, `${head}...${remote}`,
      ], SYNC_STATUS_TIMEOUT_MS)).trim().split('\n').filter(Boolean);
      completeSyncStatus = sides.length <= MAX_SYNC_COMMITS;
      for (const line of sides) {
        unique.set(line.slice(1), line[0] === '<' ? 'ahead' : 'behind');
      }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'git command timed out') throw error;
    }
  }
  const commitSyncStatus: Record<string, SyncStatus> = {};
  const commits = lines.slice(0, limit).map((line) => {
    const hash = line.split(' ')[0];
    const short = hash.slice(0, 12);
    const status = unique.get(hash) ?? (completeSyncStatus ? 'synced' : undefined);
    if (remote && status) commitSyncStatus[short] = status;
    return short + line.slice(hash.length);
  });
  return { commits, hasMore: lines.length > limit, commitSyncStatus, upstream };
}
