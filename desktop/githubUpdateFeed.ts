import http from 'node:http';

const GITHUB_RELEASE_API = 'https://api.github.com/repos/Jovines/termdock/releases/latest';

interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
  size?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

export interface UpdateFeedResponse {
  status: 200 | 204;
  body?: string;
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerRelease(currentVersion: string, releaseTag: string): boolean {
  const current = parseVersion(currentVersion);
  const release = parseVersion(releaseTag);
  if (!current || !release) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (release[index] !== current[index]) return release[index] > current[index];
  }
  return false;
}

export async function buildGitHubUpdateFeed(
  currentVersion: string,
  platform: string,
  arch: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateFeedResponse> {
  const response = await fetchImpl(GITHUB_RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Termdock/${currentVersion}`,
    },
  });
  if (!response.ok) throw new Error(`GitHub release check failed (HTTP ${response.status})`);

  const release = await response.json() as GitHubRelease;
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  if (!isNewerRelease(currentVersion, tag)) return { status: 204 };

  const version = tag.replace(/^v/, '');
  const assetName = `Termdock-${platform}-${arch}-${version}.zip`;
  const assets = Array.isArray(release.assets) ? release.assets as GitHubReleaseAsset[] : [];
  const asset = assets.find((candidate) => candidate.name === assetName);
  const url = typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : '';
  const digest = typeof asset?.digest === 'string' ? asset.digest : '';
  const size = typeof asset?.size === 'number' ? asset.size : 0;
  if (!url.startsWith('https://github.com/Jovines/termdock/releases/download/')) {
    throw new Error(`GitHub release ${tag} is missing ${assetName}`);
  }
  const sha256 = digest.match(/^sha256:([0-9a-f]{64})$/i)?.[1];
  if (!sha256 || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`GitHub release ${tag} has no verified digest or size for ${assetName}`);
  }

  return {
    status: 200,
    body: JSON.stringify({
      url,
      name: typeof release.name === 'string' && release.name ? release.name : tag,
      notes: typeof release.body === 'string' ? release.body : '',
      pub_date: typeof release.published_at === 'string' ? release.published_at : undefined,
      sha256,
      size,
    }),
  };
}

export async function startGitHubUpdateFeedServer(
  currentVersion: string,
  platform: string,
  arch: string,
): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    void buildGitHubUpdateFeed(currentVersion, platform, arch).then((feed) => {
      if (feed.status === 204) {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(feed.body);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(message);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to start the local desktop update feed');
  }
  return {
    url: `http://127.0.0.1:${address.port}/feed`,
    close: () => server.close(),
  };
}
