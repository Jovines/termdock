import { describe, expect, it, vi } from 'vitest';
import { buildGitHubUpdateFeed, isNewerRelease } from './githubUpdateFeed.js';

const digest = `sha256:${'a'.repeat(64)}`;

describe('GitHub desktop update feed', () => {
  it('compares stable release versions', () => {
    expect(isNewerRelease('1.4.90', 'v1.4.91')).toBe(true);
    expect(isNewerRelease('1.4.90', 'v1.4.90')).toBe(false);
    expect(isNewerRelease('1.5.0', 'v1.4.99')).toBe(false);
  });

  it('returns a verified Squirrel feed for a newer GitHub release', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      tag_name: 'v1.4.91',
      name: 'Termdock v1.4.91',
      body: 'Release notes',
      published_at: '2026-08-22T12:00:00Z',
      assets: [{
        name: 'Termdock-darwin-arm64-1.4.91.zip',
        browser_download_url: 'https://github.com/Jovines/termdock/releases/download/v1.4.91/Termdock-darwin-arm64-1.4.91.zip',
        digest,
        size: 123456,
      }],
    }), { status: 200 })) as typeof fetch;

    const feed = await buildGitHubUpdateFeed('1.4.90', 'darwin', 'arm64', fetchImpl);
    expect(feed.status).toBe(200);
    expect(JSON.parse(feed.body ?? '{}')).toMatchObject({
      name: 'Termdock v1.4.91',
      sha256: 'a'.repeat(64),
      size: 123456,
    });
  });

  it('returns 204 when current and rejects an unverifiable asset', async () => {
    const currentFetch = vi.fn(async () => new Response(JSON.stringify({
      tag_name: 'v1.4.90',
      assets: [],
    }), { status: 200 })) as typeof fetch;
    await expect(buildGitHubUpdateFeed('1.4.90', 'darwin', 'arm64', currentFetch))
      .resolves.toEqual({ status: 204 });

    const unsafeFetch = vi.fn(async () => new Response(JSON.stringify({
      tag_name: 'v1.4.91',
      assets: [{
        name: 'Termdock-darwin-arm64-1.4.91.zip',
        browser_download_url: 'https://github.com/Jovines/termdock/releases/download/v1.4.91/Termdock-darwin-arm64-1.4.91.zip',
        size: 123456,
      }],
    }), { status: 200 })) as typeof fetch;
    await expect(buildGitHubUpdateFeed('1.4.90', 'darwin', 'arm64', unsafeFetch))
      .rejects.toThrow('no verified digest or size');
  });
});
