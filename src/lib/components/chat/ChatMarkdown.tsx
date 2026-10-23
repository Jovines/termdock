import { memo } from 'react';
import { Markdown } from '../markdown/Markdown';
export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  return <Markdown content={content} />;
});
