import { Fragment, useEffect, useMemo } from 'react';
import { GitCompare as RiGitCompare, Loader2 as RiLoader } from 'lucide-react';
import { parseDiff, Diff, Hunk, Decoration } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { getFileDiff } from '../../terminal/api';

interface DiffViewerProps {
  filePath: string | null;
}

function getPathParts(path: string | null): { name: string; dir: string } {
  if (!path) return { name: 'Working tree changes', dir: 'All unstaged changes' };
  const parts = path.split('/').filter(Boolean);
  return {
    name: parts.pop() || path,
    dir: parts.join('/'),
  };
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

  const totalChanges = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          if (change.type === 'insert') additions += 1;
          if (change.type === 'delete') deletions += 1;
        }
      }
    }
    return { additions, deletions };
  }, [files]);

  const fileStats = useMemo(() => {
    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const file of files) {
      let additions = 0;
      let deletions = 0;
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          if (change.type === 'insert') additions += 1;
          if (change.type === 'delete') deletions += 1;
        }
      }
      stats.set(`${file.oldRevision}-${file.newRevision}-${file.newPath}`, { additions, deletions });
    }
    return stats;
  }, [files]);

  const titleParts = getPathParts(filePath);

  if (diffLoading) {
    return (
      <div className="mx-3 mt-3 flex items-center justify-center border border-border/15 bg-background-subtle py-8">
        <RiLoader size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (diffError) {
    return (
      <div className="mx-3 mt-3 border border-destructive/20 bg-destructive/5 px-4 py-4 text-sm text-destructive">
        {diffError}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="mx-3 mt-3 border border-border/15 bg-background-subtle px-4 py-8 text-center text-sm text-muted-foreground">
        <RiGitCompare size={24} className="mx-auto mb-2 text-muted-foreground/80" />
        {filePath ? 'No changes in this file.' : 'No unstaged changes.'}
      </div>
    );
  }

  return (
    <div className="termdock-diff px-3 py-2">
      <div className="border-b border-border/15 px-1 pb-2">
        <div className="truncate text-sm font-medium text-foreground" title={filePath ?? undefined}>
          {titleParts.name}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          {titleParts.dir && <span className="min-w-0 truncate">{titleParts.dir}</span>}
          <span>{files.length} file{files.length > 1 ? 's' : ''}</span>
          <span className="text-[color:var(--diff-insert-strong)]">+{totalChanges.additions}</span>
          <span className="text-[color:var(--diff-delete-strong)]">-{totalChanges.deletions}</span>
        </div>
      </div>
      {files.map((file) => {
        const key = `${file.oldRevision}-${file.newRevision}-${file.newPath}`;
        const stats = fileStats.get(key) ?? { additions: 0, deletions: 0 };
        const pathParts = getPathParts(file.newPath || file.oldPath);
        return (
        <div key={key} className="mt-3 overflow-hidden border border-border/20 bg-surface">
          <div className="flex items-center justify-between gap-3 border-b border-border/15 bg-background-subtle px-2 py-1.5">
            <div className="min-w-0" title={file.newPath || file.oldPath}>
              <div className="truncate font-mono text-[11px] text-foreground">{pathParts.name}</div>
              {pathParts.dir && <div className="truncate font-mono text-[10px] text-muted-foreground/70">{pathParts.dir}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-[10px] font-medium text-[color:var(--diff-insert-strong)]">+{stats.additions}</span>
              <span className="text-[10px] font-medium text-[color:var(--diff-delete-strong)]">-{stats.deletions}</span>
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {file.type}
              </span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <Diff
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
          </div>
        </div>
        );
      })}
    </div>
  );
}
