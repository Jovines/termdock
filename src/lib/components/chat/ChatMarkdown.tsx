import { memo } from 'react';
import { Markdown } from '../markdown/Markdown';
import { normalizeChatMarkdown } from './normalizeChatMarkdown';
export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  return <Markdown content={normalizeChatMarkdown(content)} />;
});
