import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { BranchAuditRecord, BranchDiffHunk, ChangeAuditRecord } from '../../terminal/api';
import { type DiffNavigatorFile } from './DiffFileNavigator';
import { ChangeDiffReview } from './ChangeDiffReview';

export interface DiffReviewItem {
  key: string;
  hunk: BranchDiffHunk;
  current?: BranchAuditRecord | null;
  stale?: BranchAuditRecord | null;
}

interface DiffReviewPanelProps {
  items: DiffReviewItem[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  emptyText: string;
  mobile?: boolean;
  backLabel?: string;
  headerTitle?: string;
  headerMeta?: string;
  onClose?: () => void;
  closeLabel?: string;
  wrap?: boolean;
  onToggleWrap?: () => void;
  wrapTitle?: string;
  wrapOnLabel?: string;
  wrapOffLabel?: string;
  desktopLayout?: 'split' | 'stacked';
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
  onReferenceCopied?: (key: string) => void;
  insertedReferenceKey?: string | null;
  copiedReferenceKey?: string | null;
  referenceContext?: {
    repoRoot?: string | null;
    baseRef?: string | null;
    branchName?: string | null;
    headRef?: string | null;
  };
}

type ViewMode = 'list' | 'tree';

interface FileAuditGroup {
  key: string;
  filePath: string;
  items: DiffReviewItem[];
  additions: number;
  deletions: number;
  explained: number;
  stale: number;
}

function buildFileGroups(items: DiffReviewItem[]): FileAuditGroup[] {
  const map = new Map<string, FileAuditGroup>();
  for (const item of items) {
    const group = map.get(item.hunk.filePath) ?? {
      key: item.hunk.filePath,
      filePath: item.hunk.filePath,
      items: [],
      additions: 0,
      deletions: 0,
      explained: 0,
      stale: 0,
    };
    group.items.push(item);
    group.additions += item.hunk.additions;
    group.deletions += item.hunk.deletions;
    if (item.current) group.explained += 1;
    if (item.stale) group.stale += 1;
    map.set(item.hunk.filePath, group);
  }
  return Array.from(map.values()).sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function toNavigatorFile(group: FileAuditGroup): DiffNavigatorFile {
  const name = group.filePath.split('/').pop() ?? group.filePath;
  return {
    key: group.key,
    path: group.filePath,
    displayName: name,
    displayDir: group.filePath.includes('/') ? group.filePath.slice(0, -name.length - 1) : '',
    status: group.explained > 0 ? 'explained' : group.stale > 0 ? 'stale' : 'unknown',
    title: group.filePath,
  };
}

function combineFileHunkDiffs(diffs: string[], expectedHunkHeaders: string[]): string {
  const parts = diffs.filter((diff) => diff.trim().length > 0);
  if (parts.length <= 1) return parts[0] ?? '';
  const combined: string[] = [];
  const seenHunks = new Set<string>();
  for (const [index, diff] of parts.entries()) {
    const lines = diff.split('\n');
    const firstHunkIndex = lines.findIndex((line) => line.startsWith('@@ '));
    if (firstHunkIndex < 0) {
      combined.push(...lines);
      continue;
    }
    if (index === 0) {
      combined.push(...lines.slice(0, firstHunkIndex));
    }
    const expectedHeader = expectedHunkHeaders[index];
    let cursor = firstHunkIndex;
    while (cursor >= 0 && cursor < lines.length) {
      const next = lines.findIndex((line, lineIndex) => lineIndex > cursor && line.startsWith('@@ '));
      const end = next >= 0 ? next : lines.length;
      const hunkLines = lines.slice(cursor, end);
      const hunkHeader = hunkLines[0] ?? '';
      const shouldKeep = expectedHeader ? hunkHeader === expectedHeader : true;
      const hunkKey = hunkHeader || expectedHeader || hunkLines.join('\n');
      if (shouldKeep && !seenHunks.has(hunkKey)) {
        combined.push(...hunkLines);
        seenHunks.add(hunkKey);
      }
      cursor = next;
    }
  }
  return combined.join('\n');
}

function buildFileAuditStreamItems({
  groups,
  selectedKey,
  onInsertDiffReference,
  referenceContext,
}: {
  groups: FileAuditGroup[];
  selectedKey: string | null;
  onInsertDiffReference?: (label: string, text: string, key?: string) => void;
  referenceContext?: {
    repoRoot?: string | null;
    baseRef?: string | null;
    branchName?: string | null;
    headRef?: string | null;
  };
}) {
  return groups.map((group, index) => {
          const diffText = combineFileHunkDiffs(
            group.items.map((item) => item.hunk.diff || item.current?.diff || item.stale?.diff || ''),
            group.items.map((item) => item.hunk.hunkHeader),
          );
          const auditRecords: ChangeAuditRecord[] = group.items
            .map((item) => item.current ?? item.stale)
            .filter((record): record is BranchAuditRecord => Boolean(record))
            .map((record) => ({
              id: record.id,
              repoRoot: record.repoRoot,
              filePath: record.filePath,
              oldPath: record.oldPath,
              newPath: record.newPath,
              hunkHeader: record.hunkHeader,
              hunkIndex: record.hunkIndex,
              fingerprint: record.fingerprint,
              diff: record.diff,
              explanation: record.explanation,
              summary: record.summary,
              workspaceRoot: record.workspaceRoot,
              generatedBy: record.generatedBy,
              injectedAt: record.injectedAt,
            }));
          const name = group.filePath.split('/').pop() ?? group.filePath;
          const dir = group.filePath.includes('/') ? group.filePath.slice(0, -name.length - 1) : '';
          const sources = Array.from(new Set(group.items.map((item) => {
            if (item.hunk.source === 'uncommitted') return 'uncommitted working tree';
            if (item.hunk.source === 'committed' && item.hunk.commit) return `commit ${item.hunk.commit}`;
            if (item.hunk.source === 'committed') return 'committed change';
            return 'unknown source';
          })));
          const wrapReference = onInsertDiffReference
            ? (label: string, text: string, key?: string) => {
              const referenceText = [
                'Branch diff reference',
                `repo: ${referenceContext?.repoRoot ?? auditRecords[0]?.repoRoot ?? ''}`,
                `base: ${referenceContext?.baseRef ?? ''}`,
                `branch: ${referenceContext?.branchName ?? ''}`,
                `head: ${referenceContext?.headRef ?? ''}`,
                `file: ${group.filePath}`,
                `hunks: ${group.items.map((item) => item.hunk.hunkHeader).join(' | ')}`,
                `source: ${sources.join(', ')}`,
                '',
                text.trimEnd(),
                '',
              ].join('\n');
              onInsertDiffReference(label, referenceText, key);
            }
            : undefined;
          return {
            key: group.key,
            file: { path: group.filePath, absolutePath: auditRecords[0]?.repoRoot ? `${auditRecords[0].repoRoot}/${group.filePath}` : group.filePath, status: group.explained > 0 ? 'explained' : group.stale > 0 ? 'stale' : 'unknown' },
            repoRoot: auditRecords[0]?.repoRoot ?? null,
            selectionPath: group.key,
            displayName: name,
            displayDir: dir,
            selected: selectedKey === group.key,
            eager: index < 3 || selectedKey === group.key,
            diffOverride: diffText,
            auditRecords,
            onInsertDiffReference: wrapReference,
          };
        });
}

function syncBranchSelectionFromStream(container: HTMLDivElement, selectedKey: string | null, onSelect: (key: string) => void): string | null {
  const items = Array.from(container.querySelectorAll<HTMLElement>('[data-diff-stream-item]'));
  if (items.length === 0) return null;
  const containerTop = container.getBoundingClientRect().top;
  const anchorY = containerTop + 48;
  let best: HTMLElement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom < anchorY) continue;
    const distance = Math.abs(rect.top - anchorY);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  const key = best?.dataset.diffSelectionPath ?? best?.dataset.diffStreamItem ?? null;
  if (!key || key === selectedKey) return key;
  onSelect(key);
  return key;
}

function scrollBranchDiffItemIntoView(key: string): void {
  const target = document.querySelector<HTMLElement>(`[data-diff-stream-item="${CSS.escape(key)}"]`);
  if (!target) return;
  const scroller = target.closest<HTMLElement>('.termdock-diff-stream-scroller');
  if (!scroller) {
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  const targetTop = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
}

export function DiffReviewPanel({
  items,
  selectedKey,
  onSelect,
  emptyText,
  mobile = false,
  backLabel = 'Back',
  headerTitle,
  headerMeta,
  onClose,
  closeLabel = 'Back',
  wrap = true,
  onToggleWrap,
  wrapTitle,
  wrapOnLabel = 'Wrap on',
  wrapOffLabel = 'Wrap off',
  desktopLayout = 'split',
  onInsertDiffReference,
  onReferenceCopied,
  insertedReferenceKey,
  copiedReferenceKey,
  referenceContext,
}: DiffReviewPanelProps) {
  const groups = useMemo(() => buildFileGroups(items), [items]);
  const groupByKey = useMemo(() => new Map(groups.map((group) => [group.key, group])), [groups]);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set());
  const fallbackKey = groups.find((group) => group.explained > 0 || group.stale > 0)?.key ?? groups[0]?.key ?? null;
  const effectiveKey = selectedKey && groups.some((group) => group.key === selectedKey) ? selectedKey : fallbackKey;
  const navigatorGroups = useMemo(() => [{
    key: 'branch-audit',
    label: 'Branch audit',
    files: groups.map(toNavigatorFile),
  }], [groups]);
  const streamItems = useMemo(() => buildFileAuditStreamItems({
    groups,
    selectedKey: effectiveKey,
    onInsertDiffReference,
    referenceContext,
  }), [effectiveKey, groups, onInsertDiffReference, referenceContext]);

  useEffect(() => {
    if (!selectedKey && fallbackKey) onSelect(fallbackKey);
  }, [fallbackKey, onSelect, selectedKey]);

  if (items.length === 0) {
    return (
      <div className="rounded-lg bg-surface-2 px-3 py-6 text-center text-xs text-muted-foreground">
        {emptyText}
      </div>
    );
  }

  const wrapToggle = onToggleWrap ? (
    <button
      type="button"
      onClick={onToggleWrap}
      aria-pressed={wrap}
      title={wrapTitle}
      className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition active:scale-95 ${
        wrap
          ? 'bg-primary/15 text-primary'
          : 'bg-surface-2 text-muted-foreground hover:text-foreground'
      }`}
    >
      <span className="font-mono text-[12px] leading-none">Aa</span>
      <span>{wrap ? wrapOnLabel : wrapOffLabel}</span>
    </button>
  ) : null;

  const renderHeader = (modeToggle: React.ReactNode) => (
    <div className="px-0 py-0">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          {headerTitle && (
            <div className="truncate text-[12px] font-semibold text-foreground">
              {headerTitle}
            </div>
          )}
          {headerMeta && (
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {headerMeta}
            </div>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-xs font-semibold text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
          >
            <ArrowLeft size={14} />
            {closeLabel}
          </button>
        )}
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
        {modeToggle}
        {wrapToggle}
      </div>
    </div>
  );

  const mobileDetailHeader = onToggleWrap ? ({ slideToList }: { slideToList: () => void }) => (
    <div className="flex items-center justify-between gap-2">
      <button
        type="button"
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-xs font-semibold text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
        onClick={slideToList}
      >
        <ArrowLeft size={14} />
        {backLabel}
      </button>
      <button
        type="button"
        onClick={onToggleWrap}
        aria-pressed={wrap}
        title={wrapTitle}
        className={`inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-[11px] font-medium transition active:scale-95 ${
          wrap
            ? 'bg-primary/15 text-primary'
            : 'bg-surface-2 text-muted-foreground hover:text-foreground'
        }`}
      >
        <span className="font-mono text-[12px] leading-none">Aa</span>
        <span>{wrap ? wrapOnLabel : wrapOffLabel}</span>
      </button>
    </div>
  ) : undefined;

  return (
    <ChangeDiffReview
      mobile={mobile}
      desktopLayout={desktopLayout}
      backLabel={backLabel}
      groups={navigatorGroups}
      selectedKey={effectiveKey}
      mode={viewMode}
      onModeChange={setViewMode}
      compact={mobile}
      collapsedDirectoryKeys={collapsedDirectories}
      onToggleDirectory={(key) => {
        setCollapsedDirectories((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }}
      onSelectFile={(file) => {
        onSelect(file.key);
        window.requestAnimationFrame(() => scrollBranchDiffItemIntoView(file.key));
      }}
      renderLeading={(file) => {
        const group = groupByKey.get(file.key);
        return (
          <span className={`text-[10px] font-semibold ${group?.explained ? 'text-accent' : group?.stale ? 'text-[color:var(--warning)]' : 'text-muted-foreground'}`}>
            {group?.explained ? 'E' : group?.stale ? 'S' : '-'}
          </span>
        );
      }}
      renderTrailing={(file) => {
        const group = groupByKey.get(file.key);
        return group ? <span className="shrink-0 text-[10px] text-muted-foreground">+{group.additions} -{group.deletions}</span> : null;
      }}
      renderListHeader={renderHeader}
      renderMobileDetailHeader={mobileDetailHeader}
      onDetailScroll={(container) => syncBranchSelectionFromStream(container, effectiveKey, onSelect)}
      streamItems={streamItems}
      activePane
      wrap={wrap}
      showScrollHint={!wrap}
      renderStreamBadge={(_, item) => {
        const group = groupByKey.get(item.key);
        return (
          <span className={`flex w-4 shrink-0 justify-center text-[10px] font-semibold ${group?.explained ? 'text-accent' : group?.stale ? 'text-[color:var(--warning)]' : 'text-muted-foreground'}`}>
            {group?.explained ? 'E' : group?.stale ? 'S' : '-'}
          </span>
        );
      }}
      onInsertDiffReference={onInsertDiffReference}
      onReferenceCopied={onReferenceCopied}
      insertedReferenceKey={insertedReferenceKey}
      copiedReferenceKey={copiedReferenceKey}
      emptyContent={<div className="rounded-lg bg-surface-2 px-3 py-6 text-center text-xs text-muted-foreground">{emptyText}</div>}
    />
  );
}
