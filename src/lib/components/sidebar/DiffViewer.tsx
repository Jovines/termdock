import { useEffect, useCallback, useMemo } from 'react';
import { Loader2 as RiLoader } from 'lucide-react';
import { parseDiff, Diff, Hunk, Decoration } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { getFileDiff } from '../../terminal/api';

interface DiffViewerProps {
  filePath: string | null;
}

export function DiffViewer({ filePath }: DiffViewerProps) {
  const { diffContent, diffLoading, diffError, setDiff, rootPath } = useSidebarStore();

  const loadDiff = useCallback(async (path: string | null) => {
    setDiff(path, null, true, null);
    try {
      const result = await getFileDiff(path ?? undefined, undefined, rootPath ?? undefined);
      setDiff(path, result.diff, false, result.error ?? null);
    } catch (err) {
      setDiff(path, null, false, err instanceof Error ? err.message : 'Failed to load diff');
    }
  }, [setDiff, rootPath]);

  useEffect(() => {
    loadDiff(filePath);
  }, [filePath, loadDiff]);

  const files = useMemo(() => {
    if (!diffContent || diffContent.trim() === '') return [];
    return parseDiff(diffContent);
  }, [diffContent]);

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

  if (files.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        {filePath ? 'No changes in this file.' : 'No unstaged changes.'}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      {files.map((file) => (
        <Diff
          key={`${file.oldRevision}-${file.newRevision}`}
          viewType="unified"
          diffType={file.type}
          hunks={file.hunks}
        >
          {(hunks) =>
            hunks.map((hunk) => (
              <>
                <Decoration key={`dec-${hunk.content}`}>
                  <span className="diff-hunk-header">{hunk.content}</span>
                </Decoration>
                <Hunk key={hunk.content} hunk={hunk} />
              </>
            ))
          }
        </Diff>
      ))}
    </div>
  );
}
