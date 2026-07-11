import { useEffect, useMemo, useState } from 'react';
import { DiffReview, type DiffReviewFile } from './DiffReview';
import type { DiffNavigatorGroup } from './DiffFileNavigator';

// Auth-free sandbox that mounts the REAL mobile DiffReview with many mock files
// so entry positioning and bidirectional scrolling can be verified in
// isolation. Diffs are revealed after a short delay (?delay=ms) to faithfully
// reproduce the real app's async loading, where content appears late — the
// exact condition that makes an unanchored list jump when scrolling up.

const FILE_COUNT = 40;
const REPO_ROOT = '/tmp/termdock-diff-review-lab';

function buildDiff(path: string, lineCount: number): string {
  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${lineCount} +1,${lineCount} @@`,
  ];
  for (let i = 0; i < lineCount; i += 1) {
    if (i % 5 === 0) lines.push(`-const removed_${i} = ${i};`);
    if (i % 3 === 0) lines.push(`+const added_${i} = ${i} * 2;`);
    lines.push(` context line ${i} in ${path}`);
  }
  return lines.join('\n');
}

function buildMockFiles(revealed: Set<number>, delayed: boolean): DiffReviewFile[] {
  return Array.from({ length: FILE_COUNT }, (_, index) => {
    // Deterministic but varied heights: short, medium and very tall files.
    const lineCount = 6 + ((index * 7) % 60);
    const path = `src/module${String(index).padStart(2, '0')}/File${index}.ts`;
    const key = `${REPO_ROOT}/${path}`;
    const fullDiff = buildDiff(path, lineCount);
    // Until revealed, show a tiny 1-line stub so the item is short; when the
    // timer reveals it, the diff grows — mimicking real async loading.
    const stub = buildDiff(path, 1);
    return {
      key,
      path,
      absolutePath: key,
      status: 'modified',
      repoRoot: REPO_ROOT,
      displayName: `File${index}.ts`,
      displayDir: `src/module${String(index).padStart(2, '0')} · ${lineCount} lines`,
      diffOverride: !delayed || revealed.has(index) ? fullDiff : stub,
      auditRecords: [],
    };
  });
}

export function DiffReviewLab() {
  const delayMs = useMemo(() => {
    if (typeof window === 'undefined') return 0;
    const raw = new URLSearchParams(window.location.search).get('delay');
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }, []);
  const delayed = delayMs > 0;
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());

  // Reveal each file's full diff after the delay, once, spread out a little so
  // multiple items above the viewport grow at different times (the real case).
  useEffect(() => {
    if (!delayed) return;
    const timers = Array.from({ length: FILE_COUNT }, (_, index) =>
      window.setTimeout(() => {
        setRevealed((prev) => {
          const next = new Set(prev);
          next.add(index);
          return next;
        });
      }, delayMs + index * 20),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [delayed, delayMs]);

  const files = useMemo(() => buildMockFiles(revealed, delayed), [revealed, delayed]);
  const groups = useMemo<DiffNavigatorGroup[]>(() => [{
    key: 'mock-repo',
    root: REPO_ROOT,
    label: 'diff-review-lab',
    files: files.map((file) => ({
      key: file.key,
      path: file.path,
      absolutePath: file.absolutePath,
      displayName: file.displayName,
      displayDir: file.displayDir,
      status: file.status,
    })),
  }], [files]);

  // Optional deterministic entry for automated verification: ?select=<index>
  // auto-selects that file and force-mounts the detail so the stream can be
  // inspected without driving the Swiper.
  const forcedIndex = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const raw = new URLSearchParams(window.location.search).get('select');
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n >= 0 && n < files.length ? n : null;
  }, [files.length]);

  const [selectedKey, setSelectedKey] = useState<string | null>(
    () => (forcedIndex !== null ? files[forcedIndex].key : null),
  );
  const [mode, setMode] = useState<'list' | 'tree'>('list');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Mirror the real app: the detail only mounts once its Swiper slide is active.
  const [slideIndex, setSlideIndex] = useState(forcedIndex !== null ? 1 : 0);
  const detailMounted = forcedIndex !== null || slideIndex === 1;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground" data-diff-review-lab>
      <div className="shrink-0 border-b border-border/20 px-3 py-2 text-xs text-muted-foreground">
        DiffReview Lab · {files.length} mock files · selected: <span data-lab-selected>{selectedKey ?? 'none'}</span> · slide {slideIndex}
      </div>
      <div className="min-h-0 flex-1">
        <DiffReview
          mobile
          backLabel="Back"
          files={files}
          groups={groups}
          selectedKey={selectedKey}
          mode={mode}
          onModeChange={setMode}
          collapsedDirectoryKeys={collapsed}
          onToggleDirectory={(key) => setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
          })}
          onSelectFile={(navigatorFile) => setSelectedKey(navigatorFile.key)}
          onMobileSlideChange={setSlideIndex}
          detailMounted={detailMounted}
          renderLeading={() => null}
          renderStreamBadge={(status) => <span className="text-[10px] text-muted-foreground">{status}</span>}
          wrap
          showScrollHint={false}
          activePane
        />
      </div>
    </div>
  );
}
