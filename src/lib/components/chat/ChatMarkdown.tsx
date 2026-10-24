import { memo } from 'react';
import { Markdown } from '../markdown/Markdown';
import { normalizeChatMarkdown } from './normalizeChatMarkdown';
import { useChatFileNavigation } from './ChatFileNavigation';
export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  const navigation = useChatFileNavigation();
  return <div onClickCapture={navigation ? event => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    const href = anchor?.getAttribute('href')?.trim();
    if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    // Local links must never navigate the browser to an application route,
    // even when permission or a missing cwd prevents opening a preview.
    event.preventDefault();
    event.stopPropagation();
    navigation.open(href);
  } : undefined}><Markdown content={normalizeChatMarkdown(content)} filePath={navigation?.filePath} /></div>;
});
