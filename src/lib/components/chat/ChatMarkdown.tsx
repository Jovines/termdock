import { lazy, memo, Suspense } from 'react';
const Markdown = lazy(() => import('../markdown/MarkdownPreview').then(module => ({ default: module.MarkdownPreview })));
export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  return <Suspense fallback={<p className="whitespace-pre-wrap text-[15px] leading-7">{content}</p>}><Markdown embedded referenceLines={false} content={content} filePath={null} rootPath={null} lineRange={null} onLineRangeClick={() => {}} scrollTop={0} outlineOpen={false} lightboxOpen={false} /></Suspense>;
});
