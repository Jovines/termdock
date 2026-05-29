import { useEffect, useCallback } from 'react';
import { Loader2 as RiLoader } from 'lucide-react';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { getFileDiff } from '../../terminal/api';

interface DiffLine {
  type: 'context' | 'add' | 'remove' | 'header' | 'hunk-header';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.split('\n');
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      result.push({ type: 'header', content: line });
      continue;
    }

    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      result.push({ type: 'hunk-header', content: line });
      continue;
    }

    if (line.startsWith('+')) {
      result.push({ type: 'add', content: line.slice(1), newLineNo: newLine++ });
    } else if (line.startsWith('-')) {
      result.push({ type: 'remove', content: line.slice(1), oldLineNo: oldLine++ });
    } else if (line.startsWith(' ')) {
      result.push({ type: 'context', content: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ });
    } else if (line.trim() === '') {
      // Empty context line
      result.push({ type: 'context', content: '', oldLineNo: oldLine++, newLineNo: newLine++ });
    }
  }

  return result;
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const baseClass = 'font-mono text-[11px] leading-5 whitespace-pre';

  switch (line.type) {
    case 'header':
      return (
        <div className={`${baseClass} bg-surface-2 text-muted-foreground px-3 py-0.5`}>
          {line.content}
        </div>
      );
    case 'hunk-header':
      return (
        <div className={`${baseClass} bg-primary/10 text-primary px-3 py-0.5`}>
          {line.content}
        </div>
      );
    case 'add':
      return (
        <div className={`${baseClass} bg-green-500/15 text-green-400 px-3`}>
          <span className="text-green-500/60 mr-2 select-none">+</span>{line.content}
        </div>
      );
    case 'remove':
      return (
        <div className={`${baseClass} bg-red-500/15 text-red-400 px-3`}>
          <span className="text-red-500/60 mr-2 select-none">-</span>{line.content}
        </div>
      );
    default:
      return (
        <div className={`${baseClass} text-muted-foreground px-3`}>
          <span className="text-muted-foreground/40 mr-2 select-none"> </span>{line.content}
        </div>
      );
  }
}

interface DiffViewerProps {
  filePath: string | null;
}

export function DiffViewer({ filePath }: DiffViewerProps) {
  const { diffContent, diffLoading, diffError, setDiff } = useSidebarStore();

  const loadDiff = useCallback(async (path: string | null) => {
    setDiff(path, null, true, null);
    try {
      const result = await getFileDiff(path ?? undefined);
      setDiff(path, result.diff, false, result.error ?? null);
    } catch (err) {
      setDiff(path, null, false, err instanceof Error ? err.message : 'Failed to load diff');
    }
  }, [setDiff]);

  useEffect(() => {
    loadDiff(filePath);
  }, [filePath, loadDiff]);

  if (diffLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RiLoader size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (diffError) {
    return (
      <div className="px-4 py-4 text-sm text-destructive">
        {diffError}
      </div>
    );
  }

  if (!diffContent || diffContent.trim() === '') {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        {filePath ? 'No changes in this file.' : 'No unstaged changes.'}
      </div>
    );
  }

  const lines = parseUnifiedDiff(diffContent);

  return (
    <div className="overflow-x-auto">
      {lines.map((line, i) => (
        <DiffLineRow key={i} line={line} />
      ))}
    </div>
  );
}
