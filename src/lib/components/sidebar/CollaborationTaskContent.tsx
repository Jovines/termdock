import { useMemo } from 'react';
import { buildMarkdownPreviewBlocks } from './RightSidebar';

/** Reuse the file reader's safe Markdown renderer without its file navigation chrome. */
export default function CollaborationTaskContent({ content }: { content: string }) {
  const blocks = useMemo(() => buildMarkdownPreviewBlocks(content.split('\n'), null, null), [content]);
  return <div className="min-w-0 space-y-3 break-words text-sm leading-6 text-foreground [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_pre]:max-w-full [&_table]:text-xs">
    {blocks.map((block, index) => <div key={index} className="min-w-0">{typeof block.content === 'function' ? block.content(null) : block.content}</div>)}
  </div>;
}
