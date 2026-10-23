import { Markdown } from '../markdown/Markdown';

export default function CollaborationTaskContent({ content }: { content: string }) {
  return <Markdown content={content} variant="compact" />;
}
