import { expect, it } from 'vitest';
import { httpUploadLimit } from './httpUploadLimit';

it('allows file bodies for both upload routes, including encoded Session ids', () => {
  for (const path of ['/api/terminal/fs/upload', '/api/terminal/one/chat/attachments', '/api/terminal/tmux%3Aone/chat/attachments']) {
    expect(httpUploadLimit(path)).toBe(110 * 1024 * 1024);
  }
});
it('keeps ordinary requests and lookalike routes at the smaller budget', () => {
  for (const path of ['/api/terminal/one/chat', '/api/terminal/one/input', '/api/terminal/one/chat/attachments-extra', '/api/terminal/one/chat/attachments/extra', '/api/terminal/fs/upload/extra']) {
    expect(httpUploadLimit(path)).toBe(5 * 1024 * 1024);
  }
});
