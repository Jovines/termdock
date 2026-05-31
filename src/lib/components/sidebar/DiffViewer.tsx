import { Fragment, useEffect, useMemo } from 'react';
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

  useEffect(() => {
    let cancelled = false;
    const path = filePath;

    setDiff(path, null, true, null);

    getFileDiff(path ?? undefined, undefined, rootPath ?? undefined)
      .then((result) => {
        if (cancelled) return;
        setDiff(path, result.diff, false, result.error ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setDiff(path, null, false, err instanceof Error ? err.message : 'Failed to load diff');
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, rootPath, setDiff]);

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
              <Fragment key={hunk.content}>
                <Decoration>
                  <span className="diff-hunk-header">{hunk.content}</span>
                </Decoration>
                <Hunk hunk={hunk} />
              </Fragment>
            ))
          }
        </Diff>
      ))}
    </div>
  );
}
