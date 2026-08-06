// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildVideoPreviewUrl, getVideoMimeTypeForPath, isPreviewableVideoPath } from './api';

describe('video preview path detection', () => {
  it('accepts browser-decodable video extensions regardless of case', () => {
    expect(isPreviewableVideoPath('/repo/clips/demo.mp4')).toBe(true);
    expect(isPreviewableVideoPath('/repo/clips/demo.MP4')).toBe(true);
    expect(isPreviewableVideoPath('/repo/clips/demo.webm')).toBe(true);
    expect(isPreviewableVideoPath('/repo/clips/demo.mov')).toBe(true);
    expect(isPreviewableVideoPath('/repo/clips/demo.ogv')).toBe(true);
  });

  it('rejects non-video and unsupported formats', () => {
    expect(isPreviewableVideoPath('/repo/clips/demo.mkv')).toBe(false);
    expect(isPreviewableVideoPath('/repo/clips/demo.avi')).toBe(false);
    expect(isPreviewableVideoPath('/repo/clips/demo.png')).toBe(false);
    expect(isPreviewableVideoPath('/repo/clips/demo.mp3')).toBe(false);
    expect(isPreviewableVideoPath('/repo/readme.md')).toBe(false);
    expect(isPreviewableVideoPath('/repo/no-extension')).toBe(false);
  });

  it('maps matched extensions to their mime type', () => {
    expect(getVideoMimeTypeForPath('/repo/clips/demo.mp4')).toBe('video/mp4');
    expect(getVideoMimeTypeForPath('/repo/clips/demo.WEBM')).toBe('video/webm');
    expect(getVideoMimeTypeForPath('/repo/clips/demo.mkv')).toBeNull();
    expect(getVideoMimeTypeForPath('/repo/clips/demo')).toBeNull();
  });

  it('builds a streamable preview url with an encoded path', () => {
    expect(buildVideoPreviewUrl('/repo/clips/demo.mp4'))
      .toBe('/api/terminal/fs/video?path=%2Frepo%2Fclips%2Fdemo.mp4&action=view_file');
    expect(buildVideoPreviewUrl('/repo/my clip #1/demo.mp4'))
      .toBe('/api/terminal/fs/video?path=%2Frepo%2Fmy%20clip%20%231%2Fdemo.mp4&action=view_file');
  });
});
