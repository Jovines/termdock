import { expect, it } from 'vitest';
import { composeChatDraft, mentionToken, parseChatDraft } from './chatComposerContent';
import { composeChatContent, parseChatContent } from './chatReferences';
const attachment = { path: '/tmp/截图 "新版".png', name: '截图 "新版".png', type: 'image/png', size: 1200 };
const member = { sessionId: 'worker', groupId: 'team', groupName: '界面打磨', name: '设计助手' };
it.each(['', '请看看这些文件', `${mentionToken(member)} 帮忙看看`])('round trips rich drafts through the existing plain-text and quote envelope (%s)', text => {
  const content = composeChatContent(composeChatDraft(text, [attachment], [member]), { author: '用户', time: '12:34', text: '原话' });
  const parsed = parseChatDraft(parseChatContent(content).text);
  expect(parsed.text).toBe(text); expect(parsed.attachments).toEqual([attachment]);
  expect(parsed.mentions).toEqual(text.includes(mentionToken(member)) ? [member] : []);
  expect(parseChatDraft(composeChatContent(composeChatDraft(text, [attachment], [member]), null))).toEqual(parsed);
});
it('preserves ordinary code and malformed context as text', () => {
  for (const text of ['```json\n{}\n```', '```termdock-context\n{broken}\n```', '```termdock-context\n{"attachments":[null],"mentions":[]}\n```']) expect(parseChatDraft(text)).toEqual({ text, attachments: [], mentions: [] });
});
