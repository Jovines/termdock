import { expect, it } from 'vitest';
import { composeChatDraft } from './chatComposerContent';
import { parseChatDisplayDraft } from './chatDisplayContent';
it('renders a historical recording path inline without rewriting the original text', () => {
  const content = '/Users/byte/.termdock/recordings/recording-123.mp4 还有这个问题';
  const parsed = parseChatDisplayDraft(content);
  expect(parsed.text).toBe('【视频1】 还有这个问题');
  expect(parsed.attachments).toEqual([{ path: '/Users/byte/.termdock/recordings/recording-123.mp4', name: 'recording-123.mp4', reference: '视频1' }]);
  expect(content).toBe('/Users/byte/.termdock/recordings/recording-123.mp4 还有这个问题');
});
it('keeps numbering, deduplicates repeated paths and handles quoted or shell-escaped spaces', () => {
  const content = composeChatDraft('【图片1】 "/tmp/screen record.mov" 与 /tmp/second\\ clip.webm，再看 "/tmp/screen record.mov"', [{ path: '/tmp/image.png', name: 'image.png', reference: '图片1' }], []);
  const parsed = parseChatDisplayDraft(content);
  expect(parsed.text).toBe('【图片1】 【视频2】 与 【视频3】，再看 【视频2】');
  expect(parsed.attachments.map(file => file.path)).toEqual(['/tmp/image.png', '/tmp/screen record.mov', '/tmp/second clip.webm']);
});
it('preserves ordinary filesystem paths, external URLs and existing video attachments', () => {
  const parsed = parseChatDisplayDraft('请读 /tmp/notes.md 和 https://example.com/video.mp4');
  expect(parsed.text).toBe('请读 /tmp/notes.md 和 https://example.com/video.mp4');
  expect(parsed.attachments).toEqual([]);
  const video = { path: '/tmp/a.mp4', name: 'a.mp4', reference: '视频2' };
  expect(parseChatDisplayDraft(composeChatDraft('【视频2】 /tmp/a.mp4', [video], []))).toMatchObject({ text: '【视频2】 【视频2】', attachments: [video] });
});
