import { expect, it } from 'vitest';
import { composeChatContent, parseChatContent } from './chatReferences';
it('round-trips a multiline message quote through persisted ordinary text', () => {
  const reference = { author: 'Codex', time: '13:47', text: '第一段\n\n> 嵌套引用\n最后一段' };
  const stored = composeChatContent(' 请继续解释 ', reference);
  expect(stored).toContain('> Codex · 13:47');
  expect(parseChatContent(stored)).toEqual({ text: '请继续解释', reference });
  expect(parseChatContent('普通消息\n> 常规引用')).toEqual({ text: '普通消息\n> 常规引用', reference: null });
});
