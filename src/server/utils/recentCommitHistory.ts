type GitRunner = (args: string[]) => Promise<string>;
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
  const unique = new Map<string, SyncStatus>();
  if (remote) {
    const sides = await run(['rev-list', '--left-right', `${head}...${remote}`]);
    for (const line of sides.trim().split('\n')) {
      if (line) unique.set(line.slice(1), line[0] === '<' ? 'ahead' : 'behind');
    }
  }
  const refs = remote ? [head, remote] : [head];
  const args = ['log', '--date-order', '--format=%H %s', `--skip=${skip}`, `-${limit + 1}`];
  if (query) args.push('--regexp-ignore-case', '--fixed-strings', `--grep=${query}`);
  let lines = (await run([...args, ...refs, '--'])).trim().split('\n').filter(Boolean);
  if (query && lines.length === 0 && /^[0-9a-f]{4,64}$/i.test(query)) {
    lines = (await run(['log', '--date-order', '--format=%H %s', `-${Math.max(skip + limit + 1, 200)}`, ...refs, '--']))
      .trim().split('\n').filter((line) => line.toLowerCase().startsWith(query.toLowerCase())).slice(skip, skip + limit + 1);
  }
  const commitSyncStatus: Record<string, SyncStatus> = {};
  const commits = lines.slice(0, limit).map((line) => {
    const hash = line.split(' ')[0];
    const short = hash.slice(0, 12);
    if (remote) commitSyncStatus[short] = unique.get(hash) ?? 'synced';
    return short + line.slice(hash.length);
  });
  return { commits, hasMore: lines.length > limit, commitSyncStatus, upstream };
}
