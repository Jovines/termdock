import { createContext, useContext, useEffect, useCallback, useLayoutEffect, useMemo, useState, useDeferredValue, useRef, lazy, Suspense, type CSSProperties, type Dispatch, type KeyboardEvent, type MouseEvent, type PointerEvent, type SetStateAction, type UIEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useGesture } from '@use-gesture/react';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperInstance } from 'swiper';
import 'swiper/css';
import {
  X as RiCloseLine,
  ArrowLeft as RiArrowLeft,
  ArrowRight as RiArrowRight,
  ArrowUp as RiArrowUp,
  ChevronRight as RiChevronRight,
  ChevronDown as RiChevronDown,
  Folder as RiFolder,
  Home as RiHome,
  List as RiList,
  GitCompare as RiGitCompare,
  Search as RiSearch,
  MoreHorizontal as RiMoreHorizontal,
  FileText as RiFileText,
  Copy as RiCopy,
  Download as RiDownload,
  RefreshCw as RiRefresh,
  GitBranch as RiGitBranch,
  Loader2 as RiLoader,
  ListTree as RiListTree,
  Pin as RiPin,
  PinOff as RiPinOff,
  Link2 as RiLink,
  Eye as RiEye,
  EyeOff as RiEyeOff,
  Sparkles as RiSparkles,
  Upload as RiUpload,
  Trash2 as RiTrash,
  PencilLine as RiPencilLine,
} from 'lucide-react';
import { Sidebar } from './Sidebar';
import { FileTree } from './FileTree';
import { UniversalDiffReview } from './DiffReviewPanel';
import { flattenDiffNavigatorTree, type DiffNavigatorFile, type DiffNavigatorGroup } from './DiffFileNavigator';
import { DiffReview, type DiffReviewFile, ChangeBadge, nextDiffStreamScrollRequest } from './DiffReview';
import { ChangeStatusWithAuditBadge, getFileAuditStatus } from './AuditStatusBadge';
import { ChangeWalkthroughPanel } from './ChangeWalkthroughPanel';
import type { DiffInlineMode, DiffViewType } from './DiffViewer';
import type { DiffReviewMode } from './DiffReviewWorkspace';
import { useSidebarStore, type RightSidebarTab } from '../../stores/useSidebarStore';
import { cancelIoSlot, clearBranchAuditRecords, clearChangeAuditRecords, getBranchAuditRecords, getBranchDiff, getChangeAuditRecords, getCommitDiff, getContextDraft, getGitActionStatus, getGitBundle, getGitContext, getLocalFileBrowserAvailability, getRecentCommits, getUntrackedFiles, isPreviewableImagePath, isPreviewableModel3dPath, openInFileBrowser, readFileContent, readImagePreviewBlob, readModel3dBlob, runGitAction, updateContextDraft, watchFileSystem, downloadFile, uploadFiles, type BranchAuditRecord, type BranchDiffHunk, type BranchDiffResponse, type ChangeAuditRecord, type ChangeWalkthrough, type ChangeWalkthroughAnchor, type GitActionRequest, type GitActionResponse, type GitBundleResponse, type GitChangedFile, type GitContext, type GitDiffOptions, type GitRepositoryBundle, type GitRepositoryFilter, type FileSearchMode } from '../../terminal/api';
import { useI18n } from '../../i18n';
import { flushCacheThrottled, readCache, writeCache, writeCacheThrottled } from '../../utils/localStorageCache';
import { subscribeClientState } from '../../utils/clientStateSync';
import { loadRefractor, resolveLanguage, shouldHighlight, highlightToLines, type RefractorLike } from '../../utils/syntaxHighlight';
import { useReferenceLongPressCopy } from './referenceLongPress';
import {
  buildFileReference,
  buildLineReference,
  buildPromptReference,
  buildReferenceInputText,
  resolveAbsoluteReferencePath,
} from './referencePaths';
import { ContextDraftDock } from './ContextDraftDock';
import { appendContextDraft, buildDraftTerminalPayload } from './contextDraft';
import './sidebarSelection.css';

interface RightSidebarProps {
  isOpen: boolean;
  drawerWidthPx: number;
  onClose: () => void;
  onOpen?: () => void;
  push?: boolean;
  rightSidebarFilePreviewOpen?: boolean;
  rightSidebarFilePreviewCloseSignal?: number;
  onOpenRightSidebarFilePreview?: () => void;
  onCloseRightSidebarFilePreview?: () => void;
  rightSidebarRepoPickerOpen?: boolean;
  rightSidebarRepoPickerCloseSignal?: number;
  onOpenRightSidebarRepoPicker?: () => void;
  onCloseRightSidebarRepoPicker?: () => void;
  markdownOutlineOpen?: boolean;
  markdownOutlineCloseSignal?: number;
  onOpenMarkdownOutline?: () => void;
  onCloseMarkdownOutline?: () => void;
  markdownImageLightboxOpen?: boolean;
  markdownImageLightboxCloseSignal?: number;
  onOpenMarkdownImageLightbox?: () => void;
  onCloseMarkdownImageLightbox?: () => void;
}

const FILE_TREE_SCROLL_STORAGE_KEY = 'termdock:right-sidebar:file-tree-scroll:v1';
const FILE_PREVIEW_READING_STATE_STORAGE_KEY = 'termdock:right-sidebar:file-preview-reading-state:v1';
const FILE_TREE_WIDTH_STORAGE_KEY = 'termdock:right-sidebar:file-tree-width:v1';
const MARKDOWN_VIEW_MODE_STORAGE_KEY = 'termdock:right-sidebar:markdown-view-mode:v1';
const DIFF_CHANGE_LIST_MODE_STORAGE_KEY = 'termdock:right-sidebar:diff-change-list-mode:v1';
const DIFF_WRAP_STORAGE_KEY = 'termdock:right-sidebar:diff-wrap:v1';
const DIFF_VIEW_TYPE_STORAGE_KEY = 'termdock:diff-viewer:view-type:v1';
const FILE_SEARCH_MODE_STORAGE_KEY = 'termdock:right-sidebar:file-search-mode:v1';
const COLLAPSED_GIT_REPO_GROUPS_STORAGE_KEY = 'termdock:right-sidebar:collapsed-git-repo-groups:v1';
const COLLAPSED_DIFF_DIRECTORIES_STORAGE_KEY = 'termdock:right-sidebar:collapsed-diff-directories:v1';
const BRANCH_AUDIT_MODULE_OPEN_STORAGE_KEY = 'termdock:right-sidebar:branch-audit-module-open:v1';
const BRANCH_AUDIT_MODULE_STORAGE_KEY = 'termdock:right-sidebar:branch-audit-module:v1';
const BRANCH_AUDIT_MODULE_CACHE_WRITE_MS = 150;
const GIT_BUNDLE_SNAPSHOT_STORAGE_KEY = 'termdock:right-sidebar:git-bundle-snapshots:v1';
const ACTIVE_GIT_REPO_STORAGE_KEY = 'termdock:right-sidebar:active-git-repo:v1';
const CONTEXT_DRAFT_ENABLED_STORAGE_KEY = 'termdock:right-sidebar:context-draft-enabled:v1';
const CONTEXT_DRAFT_COLLAPSED_STORAGE_KEY = 'termdock:right-sidebar:context-draft-collapsed:v1';
const CONTEXT_DRAFT_TEXT_STORAGE_KEY = 'termdock:right-sidebar:context-draft-text:v1';
const CONTEXT_DRAFT_WRITE_MS = 300;
const MAX_FILE_TREE_SCROLL_ROOTS = 20;
const MAX_FILE_PREVIEW_READING_STATE_FILES = 120;
const MAX_GIT_BUNDLE_SNAPSHOT_ROOTS = 8;
const GIT_BUNDLE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FILE_TREE_SCROLL_WRITE_MS = 250;
const FILE_PREVIEW_READING_STATE_WRITE_MS = 250;
const FILE_TREE_WIDTH_WRITE_MS = 120;
const GIT_BUNDLE_SLOW_MS = 700;
const SIDEBAR_BACKGROUND_IO_DELAY_MS = 600;
// File-watch reconnect backoff: the /fs/watch stream dies on server restart,
// deploy, or network hiccups. Retry with capped backoff; before each retry the
// watched roots' caches are invalidated and the watch epoch is bumped, because
// events fired while disconnected can never be replayed.
const FILE_WATCH_RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
const MOBILE_SIDEBAR_OPEN_SETTLE_DELAY_MS = 320;
// Closing: the settled reset is deferred past the close spring so the
// gesture only pays ONE heavy RightSidebar render pass (the isOpen flip)
// instead of two back-to-back.
const MOBILE_SIDEBAR_CLOSE_SETTLE_DELAY_MS = 500;
const RECENT_COMMITS_PAGE_SIZE = 20;
const FILE_PREVIEW_STUCK_TIMEOUT_MS = 12_000;
const DEFAULT_FILE_TREE_WIDTH_PX = 300;
const MIN_FILE_TREE_WIDTH_PX = 240;
const MAX_FILE_TREE_WIDTH_PX = 560;
// Below this width we treat the panel as a phone-sized overlay: dual-pane
// mode collapses to a single column with back-navigation, and the third
// "File" tab is hidden (its content is reachable via the Files tab).
const MOBILE_WIDTH_THRESHOLD_PX = 600;
// Wide mode keeps the dual-pane workspace; below this width the panel falls
// back to stacked tabs even on desktop.
const WIDE_WIDTH_THRESHOLD_PX = 720;
const MARKDOWN_TABLE_CELL_CLASS = 'border-r px-2 py-1.5 sm:px-3 sm:py-2';
const MARKDOWN_TABLE_CELL_CONTENT_CLASS = 'max-w-[18rem] whitespace-normal break-words sm:max-w-[27rem]';
const MARKDOWN_TABLE_HEADER_CLASS = `${MARKDOWN_TABLE_CELL_CLASS} border-b border-border/15 font-semibold last:border-r-0`;
const MARKDOWN_TABLE_BODY_CELL_CLASS = `${MARKDOWN_TABLE_CELL_CLASS} border-border/10 align-top text-muted-foreground last:border-r-0`;
// Native horizontal-scroll regions inside the sidebar (code blocks, tables).
// The sidebar gesture arbiter resolves these against the enclosing swiper and
// the drawer per touch sequence, so no swiper-no-swiping / gesture-ignore
// markers are needed — the class only carries the touch-action CSS rule.
const FILE_PREVIEW_HORIZONTAL_SCROLL_CLASS = 'termdock-file-preview-horizontal-scroll';

// three.js is heavy (~600 kB), so the 3D viewer loads on demand the first
// time a .stl/.glb/.gltf file is previewed.
const ModelPreview = lazy(() => import('./ModelPreview'));
// 类型导入: 查看器的语义特征(来自 .features.json sidecar)
import type { ModelFeature } from './ModelPreview';
const MARKDOWN_TABLE_SCROLL_CLASS = `${FILE_PREVIEW_HORIZONTAL_SCROLL_CLASS} termdock-md-table-scroll max-w-full overflow-x-auto overflow-y-hidden rounded-lg border border-border/20 bg-surface`;

type GitActionKey = GitActionRequest['action'];
type LineRange = { start: number; end: number };
type DiffChangeListMode = DiffReviewMode;

interface BranchAuditPreviewEntry {
  key: string;
  diff: BranchDiffResponse;
  repoLabel: string;
  createdAt: number;
}

type ConfirmGitAction =
  | { kind: 'restore'; file: GitChangedFile; phrase: string }
  | { kind: 'stash-all'; repoRoot?: string | null; repoLabel?: string };

interface GitActionButton {
  key: GitActionKey;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkdn', '.mkd']);
type MarkdownViewMode = 'preview' | 'source';

function isMarkdownViewMode(value: unknown): value is MarkdownViewMode {
  return value === 'preview' || value === 'source';
}

function isDiffChangeListMode(value: unknown): value is DiffChangeListMode {
  return value === 'list' || value === 'tree' || value === 'ai';
}

function readMarkdownViewMode(): MarkdownViewMode {
  return readCache(MARKDOWN_VIEW_MODE_STORAGE_KEY, isMarkdownViewMode) ?? 'preview';
}

function readDiffChangeListMode(): DiffChangeListMode {
  return readCache(DIFF_CHANGE_LIST_MODE_STORAGE_KEY, isDiffChangeListMode) ?? 'tree';
}

function isDiffWrap(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isStringValue(value: unknown): value is string {
  return typeof value === 'string';
}

function readDiffWrap(): boolean {
  return readCache(DIFF_WRAP_STORAGE_KEY, isDiffWrap) ?? true;
}

function isDiffViewType(value: unknown): value is DiffViewType {
  return value === 'unified' || value === 'split';
}

function readDiffViewType(): DiffViewType {
  return readCache(DIFF_VIEW_TYPE_STORAGE_KEY, isDiffViewType) ?? 'unified';
}

function isFileSearchMode(value: unknown): value is FileSearchMode {
  return value === 'name' || value === 'content' || value === 'regex';
}

function readFileSearchMode(): FileSearchMode {
  return readCache(FILE_SEARCH_MODE_STORAGE_KEY, isFileSearchMode) ?? 'name';
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}

function isGitChangedFileCacheValue(value: unknown): value is GitChangedFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const file = value as Partial<GitChangedFile>;
  return typeof file.path === 'string'
    && typeof file.absolutePath === 'string'
    && typeof file.status === 'string'
    && typeof file.staged === 'boolean'
    && typeof file.unstaged === 'boolean'
    && typeof file.untracked === 'boolean'
    && typeof file.tracked === 'boolean'
    && typeof file.canStage === 'boolean'
    && typeof file.canUnstage === 'boolean'
    && typeof file.canStash === 'boolean'
    && typeof file.canRestoreWorktree === 'boolean'
    && (file.repoRoot === undefined || typeof file.repoRoot === 'string')
    && (file.repoRelativeRoot === undefined || typeof file.repoRelativeRoot === 'string')
    && (file.repoName === undefined || typeof file.repoName === 'string')
    && (file.oldPath === undefined || typeof file.oldPath === 'string')
    && (file.indexStatus === undefined || typeof file.indexStatus === 'string')
    && (file.worktreeStatus === undefined || typeof file.worktreeStatus === 'string');
}

function isGitContextFileCacheValue(value: unknown): value is NonNullable<GitContext['changedFiles']>[number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const file = value as Partial<NonNullable<GitContext['changedFiles']>[number]>;
  return typeof file.path === 'string' && typeof file.absolutePath === 'string' && typeof file.status === 'string';
}

function isGitContextCacheValue(value: unknown): value is GitContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Partial<GitContext>;
  return typeof context.available === 'boolean'
    && (context.cwd === undefined || typeof context.cwd === 'string')
    && (context.root === undefined || typeof context.root === 'string')
    && (context.branch === undefined || context.branch === null || typeof context.branch === 'string')
    && isOptionalStringArray(context.remotes)
    && isOptionalStringArray(context.branches)
    && isOptionalStringArray(context.remoteBranches)
    && (context.upstream === undefined || context.upstream === null || typeof context.upstream === 'string')
    && (context.upstreamRemote === undefined || context.upstreamRemote === null || typeof context.upstreamRemote === 'string')
    && (context.upstreamBranch === undefined || context.upstreamBranch === null || typeof context.upstreamBranch === 'string')
    && (context.ahead === undefined || context.ahead === null || typeof context.ahead === 'number')
    && (context.behind === undefined || context.behind === null || typeof context.behind === 'number')
    && (context.status === undefined || typeof context.status === 'string')
    && isOptionalStringArray(context.recentCommits)
    && (context.changedFiles === undefined || (Array.isArray(context.changedFiles) && context.changedFiles.every(isGitContextFileCacheValue)))
    && (context.truncated === undefined || typeof context.truncated === 'boolean')
    && (context.error === undefined || typeof context.error === 'string')
    && (context.code === undefined || typeof context.code === 'string');
}

function isGitRepositoryBundleCacheValue(value: unknown): value is GitRepositoryBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const repo = value as Partial<GitRepositoryBundle>;
  return typeof repo.id === 'string'
    && typeof repo.root === 'string'
    && (repo.displayRoot === undefined || typeof repo.displayRoot === 'string')
    && typeof repo.relativeRoot === 'string'
    && typeof repo.name === 'string'
    && typeof repo.depth === 'number'
    && typeof repo.nested === 'boolean'
    && typeof repo.available === 'boolean'
    && Array.isArray(repo.files)
    && repo.files.every(isGitChangedFileCacheValue)
    && (repo.context === null || repo.context === undefined || isGitContextCacheValue(repo.context))
    && (repo.untrackedDeferred === undefined || typeof repo.untrackedDeferred === 'boolean')
    && (repo.error === undefined || typeof repo.error === 'string');
}

function isGitRepositoryFilterCacheValue(value: unknown): value is GitRepositoryFilter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const repo = value as Partial<GitRepositoryFilter>;
  return typeof repo.root === 'string'
    && typeof repo.label === 'string'
    && (repo.branch === undefined || repo.branch === null || typeof repo.branch === 'string')
    && typeof repo.count === 'number'
    && typeof repo.staged === 'number';
}

function isGitBundleResponseCacheValue(value: unknown): value is GitBundleResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bundle = value as Partial<GitBundleResponse>;
  return typeof bundle.available === 'boolean'
    && Array.isArray(bundle.files)
    && bundle.files.every(isGitChangedFileCacheValue)
    && (bundle.context === null || bundle.context === undefined || isGitContextCacheValue(bundle.context))
    && (bundle.repositories === undefined || (Array.isArray(bundle.repositories) && bundle.repositories.every(isGitRepositoryBundleCacheValue)))
    && (bundle.repoFilters === undefined || (Array.isArray(bundle.repoFilters) && bundle.repoFilters.every(isGitRepositoryFilterCacheValue)))
    && (bundle.truncatedRepositories === undefined || typeof bundle.truncatedRepositories === 'boolean')
    && (bundle.untrackedDeferred === undefined || typeof bundle.untrackedDeferred === 'boolean')
    && (bundle.error === undefined || typeof bundle.error === 'string')
    && (bundle.code === undefined || typeof bundle.code === 'string');
}

interface GitBundleSnapshot {
  bundle: GitBundleResponse;
  updatedAt: number;
}

function isGitBundleSnapshotCache(value: unknown): value is Record<string, GitBundleSnapshot> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const snapshot = entry as Partial<GitBundleSnapshot>;
    return typeof snapshot.updatedAt === 'number' && isGitBundleResponseCacheValue(snapshot.bundle);
  });
}

function readGitBundleSnapshotCache(): Record<string, GitBundleSnapshot> {
  return readCache(GIT_BUNDLE_SNAPSHOT_STORAGE_KEY, isGitBundleSnapshotCache) ?? {};
}

function readGitBundleSnapshot(rootPath: string | null): GitBundleSnapshot | null {
  if (!rootPath) return null;
  const snapshot = readGitBundleSnapshotCache()[rootPath];
  if (!snapshot) return null;
  if (Date.now() - snapshot.updatedAt > GIT_BUNDLE_SNAPSHOT_MAX_AGE_MS) return null;
  return snapshot;
}

function toCacheableGitBundle(bundle: GitBundleResponse): GitBundleResponse {
  const cacheable: GitBundleResponse = { ...bundle };
  delete cacheable.cached;
  delete cacheable.stale;
  delete cacheable.cacheAgeMs;
  delete cacheable.nestedDeferred;
  return cacheable;
}

function writeGitBundleSnapshot(rootPath: string | null, bundle: GitBundleResponse): void {
  if (!rootPath || !bundle.available || bundle.error) return;
  const cache = readGitBundleSnapshotCache();
  cache[rootPath] = { bundle: toCacheableGitBundle(bundle), updatedAt: Date.now() };
  const entries = Object.entries(cache)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_GIT_BUNDLE_SNAPSHOT_ROOTS);
  writeCache(GIT_BUNDLE_SNAPSHOT_STORAGE_KEY, Object.fromEntries(entries));
}

function getRepositoriesFromGitBundle(bundle: GitBundleResponse): GitRepositoryBundle[] {
  return bundle.repositories ?? (bundle.context?.root ? [{
    id: bundle.context.root,
    root: bundle.context.root,
    relativeRoot: '.',
    name: getPathBasename(bundle.context.root) || bundle.context.root,
    depth: 0,
    nested: false,
    available: bundle.available,
    files: bundle.files,
    context: bundle.context,
    error: bundle.error,
  }] : []);
}

function isActiveGitRepoCache(value: unknown): value is Record<string, string | null> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((entry) => entry === null || typeof entry === 'string');
}

function readActiveGitRepoCache(): Record<string, string | null> {
  return readCache(ACTIVE_GIT_REPO_STORAGE_KEY, isActiveGitRepoCache) ?? {};
}

function readActiveGitRepoRoot(rootPath: string | null): string | null | undefined {
  if (!rootPath) return undefined;
  const cache = readActiveGitRepoCache();
  return Object.prototype.hasOwnProperty.call(cache, rootPath) ? cache[rootPath] : undefined;
}

function writeActiveGitRepoRoot(rootPath: string | null, repoRoot: string | null): void {
  if (!rootPath) return;
  writeCache(ACTIVE_GIT_REPO_STORAGE_KEY, {
    ...readActiveGitRepoCache(),
    [rootPath]: repoRoot,
  });
}

function resolveActiveGitRepoRootFromBundle(bundle: GitBundleResponse, preferred: string | null | undefined): string | null {
  if (!preferred) return null;
  const filterRoots = new Set((bundle.repoFilters ?? []).map((repo) => repo.root));
  if (filterRoots.has(preferred)) return preferred;
  if (filterRoots.size > 0) return null;
  return (bundle.repositories ?? []).some((repo) => repo.root === preferred) ? preferred : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function readCollapsedSet(key: string): Set<string> {
  const arr = readCache(key, isStringArray);
  return arr ? new Set(arr) : new Set();
}

function writeCollapsedSet(key: string, set: Set<string>): void {
  writeCache(key, [...set]);
}

interface BranchAuditModuleState {
  selectedRepoRoots: string[];
  repoTargetBranches: Record<string, string>;
  repoBaseBranches?: Record<string, string>;
  previewEntries?: BranchAuditPreviewEntry[];
  selectedPreviewKey?: string | null;
  selectedPreviewFileKey?: string | null;
  previewDetailOpen?: boolean;
  previewScrollTops?: Record<string, number>;
  previewMobileSlideIndex?: number;
  includeUncommitted?: boolean;
  updatedAt: number;
}

function isBranchDiffHunk(value: unknown): value is BranchDiffHunk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const maybe = value as Partial<BranchDiffHunk>;
  return typeof maybe.filePath === 'string'
    && typeof maybe.hunkHeader === 'string'
    && typeof maybe.hunkIndex === 'number'
    && typeof maybe.fingerprint === 'string'
    && typeof maybe.additions === 'number'
    && typeof maybe.deletions === 'number'
    && typeof maybe.diff === 'string'
    && (maybe.oldPath === undefined || maybe.oldPath === null || typeof maybe.oldPath === 'string')
    && (maybe.newPath === undefined || maybe.newPath === null || typeof maybe.newPath === 'string')
    && (maybe.source === undefined || maybe.source === 'committed' || maybe.source === 'uncommitted' || maybe.source === 'unknown')
    && (maybe.commit === undefined || maybe.commit === null || typeof maybe.commit === 'string');
}

function isBranchDiffResponse(value: unknown): value is BranchDiffResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const maybe = value as Partial<BranchDiffResponse>;
  return typeof maybe.available === 'boolean'
    && (maybe.repoRoot === undefined || typeof maybe.repoRoot === 'string')
    && (maybe.workspaceRoot === undefined || typeof maybe.workspaceRoot === 'string')
    && (maybe.baseRef === undefined || typeof maybe.baseRef === 'string')
    && (maybe.baseBranch === undefined || typeof maybe.baseBranch === 'string')
    && (maybe.currentBranch === undefined || maybe.currentBranch === null || typeof maybe.currentBranch === 'string')
    && (maybe.headRef === undefined || maybe.headRef === null || typeof maybe.headRef === 'string')
    && (maybe.diffFingerprint === undefined || typeof maybe.diffFingerprint === 'string')
    && (maybe.stat === undefined || typeof maybe.stat === 'string')
    && (maybe.files === undefined || isStringArray(maybe.files))
    && (maybe.hunks === undefined || (Array.isArray(maybe.hunks) && maybe.hunks.every(isBranchDiffHunk)))
    && (maybe.commits === undefined || isStringArray(maybe.commits))
    && (maybe.commitCount === undefined || typeof maybe.commitCount === 'number')
    && (maybe.diff === undefined || typeof maybe.diff === 'string')
    && (maybe.truncated === undefined || typeof maybe.truncated === 'boolean')
    && (maybe.error === undefined || typeof maybe.error === 'string');
}

function isBranchAuditPreviewEntry(value: unknown): value is BranchAuditPreviewEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const maybe = value as Partial<BranchAuditPreviewEntry>;
  return typeof maybe.key === 'string'
    && isBranchDiffResponse(maybe.diff)
    && typeof maybe.repoLabel === 'string'
    && typeof maybe.createdAt === 'number';
}

function isBranchAuditModuleCache(value: unknown): value is Record<string, BranchAuditModuleState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const maybe = entry as Partial<BranchAuditModuleState>;
    return Array.isArray(maybe.selectedRepoRoots)
      && maybe.selectedRepoRoots.every((repoRoot) => typeof repoRoot === 'string')
      && Boolean(maybe.repoTargetBranches)
      && typeof maybe.repoTargetBranches === 'object'
      && !Array.isArray(maybe.repoTargetBranches)
      && Object.values(maybe.repoTargetBranches as Record<string, unknown>).every((branch) => typeof branch === 'string')
      && (maybe.repoBaseBranches === undefined || (
        Boolean(maybe.repoBaseBranches)
        && typeof maybe.repoBaseBranches === 'object'
        && !Array.isArray(maybe.repoBaseBranches)
        && Object.values(maybe.repoBaseBranches as Record<string, unknown>).every((branch) => typeof branch === 'string')
      ))
      && (maybe.previewEntries === undefined || (
        Array.isArray(maybe.previewEntries)
        && maybe.previewEntries.every(isBranchAuditPreviewEntry)
      ))
      && (maybe.selectedPreviewKey === undefined || maybe.selectedPreviewKey === null || typeof maybe.selectedPreviewKey === 'string')
      && (maybe.selectedPreviewFileKey === undefined || maybe.selectedPreviewFileKey === null || typeof maybe.selectedPreviewFileKey === 'string')
      && (maybe.previewDetailOpen === undefined || typeof maybe.previewDetailOpen === 'boolean')
      && (maybe.previewScrollTops === undefined || (
        Boolean(maybe.previewScrollTops)
        && typeof maybe.previewScrollTops === 'object'
        && !Array.isArray(maybe.previewScrollTops)
        && Object.values(maybe.previewScrollTops as Record<string, unknown>).every((top) => typeof top === 'number')
      ))
      && (maybe.previewMobileSlideIndex === undefined || typeof maybe.previewMobileSlideIndex === 'number')
      && (maybe.includeUncommitted === undefined || typeof maybe.includeUncommitted === 'boolean')
      && typeof maybe.updatedAt === 'number';
  });
}

function readBranchAuditModuleCache(): Record<string, BranchAuditModuleState> {
  return readCache(BRANCH_AUDIT_MODULE_STORAGE_KEY, isBranchAuditModuleCache) ?? {};
}

function getBranchAuditHistoryKey(record: Pick<BranchAuditRecord, 'repoRoot' | 'baseRef'> & {
  branchName?: string | null;
  headRef?: string | null;
  diffFingerprint?: string | null;
}): string {
  return [record.repoRoot, record.baseRef, record.branchName ?? '', record.headRef ?? '', record.diffFingerprint ?? ''].join('\0');
}

function getBranchShortName(branch: string | null | undefined): string {
  const value = branch?.trim() ?? '';
  const slashIndex = value.indexOf('/');
  return slashIndex >= 0 ? value.slice(slashIndex + 1) : value;
}

function isSameBranchRef(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = left?.trim();
  const b = right?.trim();
  if (!a || !b) return false;
  return a === b || getBranchShortName(a) === getBranchShortName(b);
}

function pickBranchAuditFallbackBase(context: GitContext | null | undefined): string {
  const currentBranch = context?.branch ?? null;
  const candidates = [
    context?.upstream,
    ...(context?.remoteBranches ?? []),
    ...(context?.branches ?? []),
  ];
  return candidates.find((branch) => branch && !isSameBranchRef(branch, currentBranch)) ?? '';
}

function clampFileTreeWidth(width: number, drawerWidthPx: number): number {
  const maxByDrawer = Math.max(MIN_FILE_TREE_WIDTH_PX, drawerWidthPx - 320);
  const max = Math.min(MAX_FILE_TREE_WIDTH_PX, maxByDrawer);
  return Math.min(max, Math.max(MIN_FILE_TREE_WIDTH_PX, width));
}

function isFileTreeWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readFileTreeWidth(drawerWidthPx: number): number {
  return clampFileTreeWidth(readCache(FILE_TREE_WIDTH_STORAGE_KEY, isFileTreeWidth) ?? DEFAULT_FILE_TREE_WIDTH_PX, drawerWidthPx);
}

function getFileExtension(filePath: string): string {
  const basename = filePath.split(/[\\/]/).pop() ?? filePath;
  const dotIndex = basename.lastIndexOf('.');
  return dotIndex >= 0 ? basename.slice(dotIndex).toLowerCase() : '';
}

function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTS.has(getFileExtension(filePath));
}

function isMarkdownHorizontalRule(line: string): boolean {
  const compact = line.trim().replace(/\s+/g, '');
  return /^-{3,}$/.test(compact) || /^\*{3,}$/.test(compact) || /^_{3,}$/.test(compact);
}

function isMarkdownBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+/.test(trimmed)
    || isMarkdownHorizontalRule(line)
    || /^>\s?/.test(trimmed)
    || /^(```|~~~)/.test(trimmed)
    || /^(?:[-+*]|\d+[.)])\s+/.test(trimmed);
}

function getSafeMarkdownHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/[<>]/.test(trimmed)) return trimmed;
  return null;
}

interface MarkdownReferenceDefinition {
  href: string;
  title?: string;
}

type MarkdownReferenceDefinitions = Map<string, MarkdownReferenceDefinition>;

interface MarkdownFootnoteDefinition {
  id: string;
  text: string;
  index: number;
}

type MarkdownFootnoteDefinitions = Map<string, MarkdownFootnoteDefinition>;

type MarkdownPreviewImage = {
  kind: 'image';
  src: string;
  alt: string;
  title?: string;
} | {
  kind: 'mermaid';
  svg: string;
  alt: string;
  title?: string;
};

const MarkdownMermaidOpenContext = createContext<((svg: string) => void) | null>(null);

interface MarkdownRenderContext {
  markdownFilePath: string | null;
  rootPath: string | null;
  referenceDefinitions: MarkdownReferenceDefinitions;
  footnoteDefinitions: MarkdownFootnoteDefinitions;
  headingSlugCounts: Map<string, number>;
  images: MarkdownPreviewImage[];
  onImageOpen?: (index: number) => void;
  footnotesLabel: string;
  backToFootnoteLabel: (index: number) => string;
}

interface MarkdownPreviewRenderResult {
  blocks: MarkdownPreviewBlock[];
  images: MarkdownPreviewImage[];
}

interface MarkdownHeadingInfo {
  level: number;
  text: string;
  id: string;
}

function normalizeMarkdownReferenceId(id: string): string {
  return id.trim().replace(/\s+/g, ' ').toLowerCase();
}

function getMarkdownPlainText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function normalizeMarkdownAtxHeadingText(text: string): string {
  return text.replace(/\s+#+\s*$/, '').trim();
}

function getMarkdownHeadingId(text: string, context: MarkdownRenderContext): string {
  const plain = getMarkdownPlainText(text);
  const base = plain
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    || 'section';
  const count = context.headingSlugCounts.get(base) ?? 0;
  context.headingSlugCounts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function getMarkdownHeadingDisplayText(text: string): string {
  return getMarkdownPlainText(text) || text.trim();
}

function parseMarkdownReferenceDefinition(line: string): { id: string; definition: MarkdownReferenceDefinition } | null {
  const match = line.match(/^\s{0,3}\[([^\]]+)\]:\s+(.+?)\s*$/);
  if (!match) return null;
  const target = parseMarkdownInlineTarget(match[2]);
  if (!target) return null;
  return {
    id: normalizeMarkdownReferenceId(match[1]),
    definition: {
      href: target.href,
      title: target.title,
    },
  };
}

function collectMarkdownReferenceDefinitions(lines: string[]): MarkdownReferenceDefinitions {
  const definitions: MarkdownReferenceDefinitions = new Map();
  for (const line of lines) {
    const parsed = parseMarkdownReferenceDefinition(line);
    if (parsed) definitions.set(parsed.id, parsed.definition);
  }
  return definitions;
}

function normalizeMarkdownFootnoteId(id: string): string {
  return id.trim().toLowerCase();
}

function parseMarkdownFootnoteDefinition(line: string): { id: string; text: string } | null {
  const match = line.match(/^\s{0,3}\[\^([^\]]+)\]:\s+(.+)\s*$/);
  if (!match) return null;
  return { id: normalizeMarkdownFootnoteId(match[1]), text: match[2] };
}

function collectMarkdownFootnoteDefinitions(lines: string[]): MarkdownFootnoteDefinitions {
  const definitions: MarkdownFootnoteDefinitions = new Map();
  let currentId: string | null = null;
  for (const line of lines) {
    const parsed = parseMarkdownFootnoteDefinition(line);
    if (parsed) {
      currentId = parsed.id;
      definitions.set(parsed.id, {
        id: parsed.id,
        text: parsed.text,
        index: definitions.size + 1,
      });
      continue;
    }
    if (currentId && /^\s{4,}\S/.test(line)) {
      const current = definitions.get(currentId);
      if (current) current.text = `${current.text} ${line.trim()}`;
      continue;
    }
    if (line.trim()) currentId = null;
  }
  return definitions;
}

function collectMarkdownFootnoteDefinitionLineIndexes(lines: string[]): Set<number> {
  const indexes = new Set<number>();
  let activeFootnote = false;
  lines.forEach((line, index) => {
    if (parseMarkdownFootnoteDefinition(line)) {
      indexes.add(index);
      activeFootnote = true;
      return;
    }
    if (activeFootnote && /^\s{4,}\S/.test(line)) {
      indexes.add(index);
      return;
    }
    if (line.trim()) activeFootnote = false;
  });
  return indexes;
}

function maskMarkdownHiddenLines(lines: string[]): string[] {
  const masked = [...lines];
  let index = 0;

  const frontMatterDelimiter = lines[0]?.trim();
  if (frontMatterDelimiter === '---' || frontMatterDelimiter === '+++') {
    masked[0] = '';
    index = 1;
    while (index < lines.length && lines[index].trim() !== frontMatterDelimiter) {
      masked[index] = '';
      index += 1;
    }
    if (index < lines.length) {
      masked[index] = '';
      index += 1;
    }
  }

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('<!--')) {
      masked[index] = '';
      if (!trimmed.includes('-->')) {
        index += 1;
        while (index < lines.length && !lines[index].includes('-->')) {
          masked[index] = '';
          index += 1;
        }
        if (index < lines.length) masked[index] = '';
      }
      index += 1;
      continue;
    }
    index += 1;
  }

  return masked;
}

function getParentDirectoryPath(filePath: string): string {
  const normalized = filePath.replace(/\/+$/, '');
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex <= 0) return slashIndex === 0 ? '/' : '';
  return normalized.slice(0, slashIndex);
}

function normalizeMarkdownLocalImagePath(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0];
  const absolute = pathname.startsWith('/');
  const stack: string[] = [];

  for (const part of pathname.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }

  const normalizedPathname = `${absolute ? '/' : ''}${stack.join('/')}`;
  return normalizedPathname || (absolute ? '/' : '.');
}

function resolveMarkdownImageSrc(src: string, markdownFilePath: string | null, rootPath: string | null): string | null {
  const trimmed = src.trim();
  if (!trimmed || /^(?:javascript|data):/i.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!isPreviewableImagePath(trimmed.split(/[?#]/, 1)[0])) return null;

  let absolutePath: string;
  if (trimmed.startsWith('/')) {
    const isFileSystemAbsolute = rootPath && (trimmed === rootPath || trimmed.startsWith(`${rootPath}/`));
    absolutePath = normalizeMarkdownLocalImagePath(rootPath && !isFileSystemAbsolute ? `${rootPath}/${trimmed.slice(1)}` : trimmed);
  } else {
    if (!markdownFilePath) return null;
    absolutePath = normalizeMarkdownLocalImagePath(`${getParentDirectoryPath(markdownFilePath)}/${trimmed}`);
  }

  return `/api/terminal/fs/blob?path=${encodeURIComponent(absolutePath)}`;
}

// Display-height band for normalizing SVGs in the markdown preview. SVG files
// carry arbitrary declared sizes (a 24×24 icon vs a 1000×1000 diagram), which
// made some render tiny and others flood the panel. SVGs are vector and scale
// cleanly, so they are sized from a clamped target height with the aspect
// ratio following. Raster images keep their intrinsic size — upscaling them
// would blur.
const MARKDOWN_SVG_MIN_DISPLAY_HEIGHT = 128;
const MARKDOWN_SVG_MAX_DISPLAY_HEIGHT = 360;
const MARKDOWN_IMAGE_MAX_DISPLAY_HEIGHT = 480;

export function isSvgImageSrc(src: string): boolean {
  try {
    // Markdown images are served as /api/terminal/fs/blob?path=<encoded>, so
    // the .svg extension lives inside the query string, not the URL path.
    return /\.svg(?=$|[?#&])/i.test(decodeURIComponent(src));
  } catch {
    return false;
  }
}

// Computes the exact display box (px) for a markdown image once its natural
// size is known: SVG normalization (height band above), then caps at the
// container width and the 480px max height, ratio always preserved. Returns
// null when the natural size is unusable. The same box drives the loading
// placeholder and the final img, so swapping them causes no layout shift.
export function computeMarkdownImageDisplayBox(
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  containerWidth: number,
): { width: number; height: number } | null {
  if (!naturalWidth || !naturalHeight) return null;
  let width: number;
  let height: number;
  if (isSvgImageSrc(src)) {
    height = Math.min(Math.max(naturalHeight, MARKDOWN_SVG_MIN_DISPLAY_HEIGHT), MARKDOWN_SVG_MAX_DISPLAY_HEIGHT);
    width = (naturalWidth * height) / naturalHeight;
  } else {
    width = naturalWidth;
    height = naturalHeight;
  }
  if (containerWidth > 0 && width > containerWidth) {
    height = (height * containerWidth) / width;
    width = containerWidth;
  }
  if (height > MARKDOWN_IMAGE_MAX_DISPLAY_HEIGHT) {
    width = (width * MARKDOWN_IMAGE_MAX_DISPLAY_HEIGHT) / height;
    height = MARKDOWN_IMAGE_MAX_DISPLAY_HEIGHT;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

// Extracts the local absolute path back out of an /api/terminal/fs/blob URL.
// Returns null for remote (https://) images, which are passed through as-is.
function getLocalPathFromBlobSrc(src: string): string | null {
  if (!src.startsWith('/api/terminal/fs/blob?')) return null;
  try {
    const params = new URLSearchParams(src.slice(src.indexOf('?')));
    return params.get('path');
  } catch {
    return null;
  }
}

// Ties a /api/terminal/fs/blob URL to the file watcher's version state: when
// the underlying file changes on disk (per-path bump) or the watcher reports a
// rescan / reconnects / the user hits refresh (global epoch bump), the version
// changes and `&v=N` is appended so consumers refetch — otherwise they kept
// showing the stale bytes (the blob endpoint is Cache-Control: no-store, but
// fetched object URLs and <img> caches are keyed by URL).
function useVersionedFsBlobSrc(src: string): string {
  const localPath = getLocalPathFromBlobSrc(src);
  const version = useSidebarStore((s) => (
    localPath ? (s.fileChangeVersions.get(localPath) ?? 0) + s.fileWatchEpoch : 0
  ));
  return localPath && version > 0 ? `${src}&v=${version}` : src;
}

type MarkdownImageState =
  | { status: 'loading' }
  | { status: 'ready'; objectUrl: string }
  | { status: 'fallback' }; // fetch failed — render the plain <img> natively

// Markdown image that reserves its final display box BEFORE downloading, so
// the preview never jumps when the image arrives:
//  1. IntersectionObserver starts the fetch only near the viewport (the lazy
//     behavior loading="lazy" used to give us).
//  2. The blob endpoint returns X-Image-Width/Height, so the display box
//     (computeMarkdownImageDisplayBox) is known as soon as headers land.
//  3. A pulsing placeholder occupies exactly that box; the ready img is
//     rendered at the same explicit size and fades in — zero layout shift.
// The URL goes through useVersionedFsBlobSrc, so on-disk changes to the image
// file (or a watch rescan / manual refresh) append `&v=N` and refetch.
function MarkdownImage({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const isVector = isSvgImageSrc(src);
  const versionedSrc = useVersionedFsBlobSrc(src);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [state, setState] = useState<MarkdownImageState>({ status: 'loading' });
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  // Measure the enclosing block container (placeholder → button/span wrapper →
  // <p>) so width-capped boxes match the CSS max-w-full constraint exactly.
  // Tracked with a ResizeObserver because the sidebar width can change.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const container = root?.parentElement?.parentElement ?? root?.parentElement;
    if (!container) return;
    const update = () => setContainerWidth(container.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Lazy-start: only fetch when the image scrolls near the viewport.
  useEffect(() => {
    if (nearViewport) return;
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: '400px' });
    observer.observe(root);
    return () => observer.disconnect();
  }, [nearViewport]);

  useEffect(() => {
    if (!nearViewport) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: 'loading' });
    // If the fetch hangs (slow/blocked storage, dev server restart), fall
    // back to the native <img> instead of parking on the placeholder forever.
    const hangTimer = window.setTimeout(() => {
      controller.abort(new DOMException('Image fetch timed out', 'TimeoutError'));
    }, 15_000);
    fetch(versionedSrc, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const width = Number(response.headers.get('X-Image-Width')) || 0;
        const height = Number(response.headers.get('X-Image-Height')) || 0;
        const blob = await response.blob();
        return { blob, width, height };
      })
      .then(({ blob, width, height }) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        if (width > 0 && height > 0) setNaturalSize({ width, height });
        setState({ status: 'ready', objectUrl });
      })
      .catch(() => {
        // Plain cleanup aborts (unmount / src change) must not overwrite the
        // next effect's state; the hang-timer abort and real errors fall back
        // to the native <img>.
        const reason = controller.signal.reason;
        const abortedByCleanup = controller.signal.aborted && !(reason instanceof DOMException && reason.name === 'TimeoutError');
        if (!abortedByCleanup) setState({ status: 'fallback' });
      })
      .finally(() => {
        window.clearTimeout(hangTimer);
      });
    return () => {
      window.clearTimeout(hangTimer);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [nearViewport, versionedSrc]);

  const box = computeMarkdownImageDisplayBox(src, naturalSize?.width ?? 0, naturalSize?.height ?? 0, containerWidth);
  // While headers are pending, reserve a rough guess; the exact size follows
  // as soon as headers land (usually the same round-trip).
  const placeholderBox = box ?? { width: MARKDOWN_SVG_MIN_DISPLAY_HEIGHT * 2, height: MARKDOWN_SVG_MIN_DISPLAY_HEIGHT };

  return (
    <div ref={rootRef} className="block max-w-full" style={box ? { width: box.width, height: box.height } : undefined}>
      {state.status === 'ready' ? (
        <img
          src={state.objectUrl}
          alt={alt}
          title={title}
          decoding="async"
          className={`${isVector ? '' : 'termdock-fade-in '}block max-h-[480px] max-w-full object-contain`}
          style={box ? { width: box.width, height: box.height } : undefined}
          onLoad={(event) => {
            // No dimension headers (older server / remote image): measure
            // after decode and resize the box once, like before.
            if (naturalSize) return;
            const img = event.currentTarget;
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
            }
          }}
        />
      ) : state.status === 'fallback' ? (
        <img
          src={versionedSrc}
          alt={alt}
          title={title}
          loading="lazy"
          decoding="async"
          className="block max-h-[480px] max-w-full object-contain"
          style={box ? { width: box.width, height: box.height } : undefined}
          onLoad={(event) => {
            // Fetch failed or remote image without headers: measure after
            // decode and resize once (also rescues 0×0-collapsed SVGs).
            if (naturalSize) return;
            const img = event.currentTarget;
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
            }
          }}
        />
      ) : (
        <div
          aria-hidden
          className="flex max-w-full animate-pulse items-center justify-center rounded bg-surface-elevated/60"
          style={{ width: placeholderBox.width, height: placeholderBox.height }}
        >
          <span className="text-[10px] text-muted-foreground/60">{alt || '…'}</span>
        </div>
      )}
    </div>
  );
}

function renderMarkdownImage(
  key: string,
  alt: string,
  src: string,
  title: string | undefined,
  context: MarkdownRenderContext,
): ReactNode {
  const imageSrc = resolveMarkdownImageSrc(src, context.markdownFilePath, context.rootPath);
  if (!imageSrc) return `![${alt}](${src})`;

  const imageIndex = context.images.length;
  context.images.push({ kind: 'image', src: imageSrc, alt, title });
  const image = <MarkdownImage src={imageSrc} alt={alt} title={title} />;

  return context.onImageOpen ? (
    <button
      key={key}
      type="button"
      className="my-2 block max-w-full overflow-hidden rounded-md border border-border/20 bg-surface-2 text-left transition hover:border-border-strong focus:outline-none focus:ring-2 focus:ring-ring/45"
      title={title || alt || 'Open image'}
      onClick={(event) => {
        event.stopPropagation();
        context.onImageOpen?.(imageIndex);
      }}
    >
      {image}
    </button>
  ) : (
    <span key={key} className="my-2 block max-w-full overflow-hidden rounded-md border border-border/20 bg-surface-2">
      {image}
    </span>
  );
}

function splitAutoLinkPunctuation(token: string): { linkText: string; suffix: string } {
  let linkText = token;
  let suffix = '';
  while (/[.,;:!?)]$/.test(linkText)) {
    suffix = `${linkText.slice(-1)}${suffix}`;
    linkText = linkText.slice(0, -1);
  }
  return { linkText, suffix };
}

function isMarkdownEmail(text: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text);
}

function parseMarkdownInlineTarget(raw: string): { href: string; title?: string } | null {
  const trimmed = raw.trim();
  const angleMatch = trimmed.match(/^<([^>]+)>(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?$/);
  if (angleMatch) {
    return { href: angleMatch[1], title: angleMatch[2] ?? angleMatch[3] ?? angleMatch[4] };
  }
  const plainMatch = trimmed.match(/^(\S+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?$/);
  if (!plainMatch) return null;
  return { href: plainMatch[1], title: plainMatch[2] ?? plainMatch[3] ?? plainMatch[4] };
}

const MARKDOWN_ESCAPE_SENTINEL = '\uE000';
const MARKDOWN_ESCAPABLE = /\\([\\`*{}\[\]#+\-.!_|~>$])/g;

function maskMarkdownEscapes(text: string): string {
  return text.replace(MARKDOWN_ESCAPABLE, (_, char: string) => `${MARKDOWN_ESCAPE_SENTINEL}${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function unmaskMarkdownEscapes(text: string): string {
  return text
    .replace(new RegExp(`${MARKDOWN_ESCAPE_SENTINEL}([0-9a-f]{4})`, 'g'), (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\([()])/g, '$1');
}

function normalizeMarkdownCodeSpan(code: string): string {
  const normalized = code.replace(/[\r\n]+/g, ' ');
  if (/^ .+ $/.test(normalized) && /[^ ]/.test(normalized.slice(1, -1))) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

interface DOMPurifyLike {
  sanitize: (dirty: string, config?: Record<string, unknown>) => string;
}

const MARKDOWN_HTML_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'details',
    'div', 'em', 'i', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's',
    'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
    'th', 'thead', 'tr', 'u', 'ul',
  ],
  ALLOWED_ATTR: ['href', 'title', 'class', 'id', 'colspan', 'rowspan'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: true,
};

let domPurifyPromise: Promise<DOMPurifyLike> | null = null;

function loadDOMPurify(): Promise<DOMPurifyLike> {
  if (!domPurifyPromise) {
    domPurifyPromise = import('dompurify')
      .then((mod) => ((mod as { default?: DOMPurifyLike }).default ?? mod) as DOMPurifyLike)
      .catch((error) => {
        domPurifyPromise = null;
        throw error;
      });
  }
  return domPurifyPromise;
}

function MarkdownSanitizedHtml({ html }: { html: string }) {
  const { t } = useI18n();
  const [sanitized, setSanitized] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSanitized(null);
    loadDOMPurify()
      .then((domPurify) => {
        if (cancelled) return;
        setSanitized(domPurify.sanitize(html, MARKDOWN_HTML_SANITIZE_CONFIG));
      })
      .catch(() => {
        if (!cancelled) setSanitized('');
      });
    return () => { cancelled = true; };
  }, [html]);

  if (sanitized === null) return <div className="py-2 text-xs text-muted-foreground">{t('rightSidebar.renderingHtml')}</div>;
  if (!sanitized) return null;
  return <div className="text-muted-foreground" dangerouslySetInnerHTML={{ __html: sanitized }} />;
}

function MarkdownSanitizedInlineHtml({ html }: { html: string }) {
  const [sanitized, setSanitized] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSanitized(null);
    loadDOMPurify()
      .then((domPurify) => {
        if (!cancelled) setSanitized(domPurify.sanitize(html, MARKDOWN_HTML_SANITIZE_CONFIG));
      })
      .catch(() => {
        if (!cancelled) setSanitized('');
      });
    return () => { cancelled = true; };
  }, [html]);

  if (sanitized === null) return null;
  if (!sanitized) return html;
  return <span dangerouslySetInnerHTML={{ __html: sanitized }} />;
}

function parseMarkdownHtmlBlockStart(line: string): { tag: string; selfContained: boolean } | null {
  const match = line.trim().match(/^<(div|section|article|aside|table|p|ul|ol|li|blockquote|pre|figure|figcaption)\b[^>]*>/i);
  if (!match) return null;
  const tag = match[1].toLowerCase();
  return {
    tag,
    selfContained: new RegExp(`</${tag}>`, 'i').test(line),
  };
}

interface KatexLike {
  renderToString: (tex: string, options?: Record<string, unknown>) => string;
}

let katexPromise: Promise<KatexLike> | null = null;

function loadKatex(): Promise<KatexLike> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ])
      .then(([mod]) => ((mod as { default?: KatexLike }).default ?? mod) as KatexLike)
      .catch((error) => {
        katexPromise = null;
        throw error;
      });
  }
  return katexPromise;
}

function MarkdownMath({ tex, display = false }: { tex: string; display?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setFailed(false);
    loadKatex()
      .then((katex) => {
        if (cancelled) return;
        setHtml(katex.renderToString(tex, {
          displayMode: display,
          throwOnError: false,
          trust: false,
          strict: 'ignore',
        }));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [display, tex]);

  if (failed) return <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.92em] text-foreground">{display ? `$$${tex}$$` : `$${tex}$`}</code>;
  if (!html) return <span className="text-muted-foreground/70">{display ? 'Rendering formula...' : tex}</span>;

  const className = display
    ? 'my-2 overflow-auto rounded-md bg-surface-2 px-3 py-2 text-center'
    : 'inline-block align-middle';

  // KaTeX returns sanitized HTML for a restricted TeX language. `trust:false`
  // keeps URL / HTML-like extensions inert; unsupported input is rendered as
  // error text instead of throwing.
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderMarkdownHtmlInline(token: string, key: string, context: MarkdownRenderContext): ReactNode | null {
  if (/^<br\s*\/?>$/i.test(token)) return <br key={key} />;

  const match = token.match(/^<(kbd|mark|sub|sup)>(.*?)<\/\1>$/i);
  if (!match) {
    if (/^<(a|abbr|span|b|strong|em|i|u|s|del|code)\b[\s\S]*<\/\1>$/i.test(token)) {
      return <MarkdownSanitizedInlineHtml key={key} html={token} />;
    }
    return null;
  }

  const tag = match[1].toLowerCase();
  const children = renderMarkdownInline(match[2], `${key}-${tag}`, true, context);
  if (tag === 'kbd') {
    return <kbd key={key} className="rounded border border-border/30 bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-foreground shadow-sm">{children}</kbd>;
  }
  if (tag === 'mark') {
    return <mark key={key} className="rounded bg-warning/25 px-0.5 text-foreground">{children}</mark>;
  }
  if (tag === 'sub') return <sub key={key}>{children}</sub>;
  return <sup key={key}>{children}</sup>;
}

function renderMarkdownInline(
  text: string,
  keyPrefix: string,
  wrapLongTokens = true,
  context: MarkdownRenderContext,
): ReactNode[] {
  const maskedText = maskMarkdownEscapes(text);
  const pattern = /(\\\([^)]*\\\)|\$[^$\n]+\$|<br\s*\/?>|<(?:a|abbr|span|b|strong|em|i|u|s|del|code|kbd|mark|sub|sup)\b[\s\S]*?<\/(?:a|abbr|span|b|strong|em|i|u|s|del|code|kbd|mark|sub|sup)>|!?\[[^\]]*\]\((?:<[^>]+>|(?:[^\s()]+|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)|!?\[[^\]]+\]\[[^\]]*\]|!?\[[^\]]+\]|\[\^[^\]]+\]|(`+)([\s\S]*?)\2|~~[^~]+~~|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|<https?:\/\/[^>\s]+>|<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|https?:\/\/[^\s<]+|www\.[^\s<]+|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)/gi;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(maskedText)) !== null) {
    if (match.index > lastIndex) nodes.push(unmaskMarkdownEscapes(maskedText.slice(lastIndex, match.index)));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;

    const htmlInline = token.startsWith('<') ? renderMarkdownHtmlInline(token, key, context) : null;
    if (htmlInline) {
      nodes.push(htmlInline);
    } else if (token.startsWith('\\(') && token.endsWith('\\)')) {
      nodes.push(<MarkdownMath key={key} tex={token.slice(2, -2)} />);
    } else if (token.startsWith('$') && token.endsWith('$')) {
      nodes.push(<MarkdownMath key={key} tex={token.slice(1, -1)} />);
    } else if (token.startsWith('`')) {
      const tickLength = token.match(/^`+/)?.[0].length ?? 1;
      nodes.push(<code key={key} className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.92em] text-foreground`}>{normalizeMarkdownCodeSpan(token.slice(tickLength, -tickLength))}</code>);
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={key} className="text-muted-foreground decoration-border-strong">{renderMarkdownInline(token.slice(2, -2), `${key}-del`, wrapLongTokens, context)}</del>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key} className="font-semibold text-foreground">{renderMarkdownInline(token.slice(2, -2), `${key}-strong`, wrapLongTokens, context)}</strong>);
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(<em key={key} className="italic">{renderMarkdownInline(token.slice(1, -1), `${key}-em`, wrapLongTokens, context)}</em>);
    } else if (token.startsWith('![')) {
      const inlineImageMatch = token.match(/^!\[([^\]]*)\]\((.*)\)$/);
      const referenceImageMatch = token.match(/^!\[([^\]]+)\]\[([^\]]*)\]$/);
      const shortcutImageMatch = token.match(/^!\[([^\]]+)\]$/);
      if (inlineImageMatch) {
        const target = parseMarkdownInlineTarget(inlineImageMatch[2]);
        nodes.push(target ? renderMarkdownImage(key, inlineImageMatch[1], target.href, target.title, context) : token);
      } else if (referenceImageMatch) {
        const definitionId = referenceImageMatch[2] || referenceImageMatch[1];
        const definition = context.referenceDefinitions.get(normalizeMarkdownReferenceId(definitionId));
        nodes.push(definition ? renderMarkdownImage(key, referenceImageMatch[1], definition.href, definition.title, context) : token);
      } else if (shortcutImageMatch) {
        const definition = context.referenceDefinitions.get(normalizeMarkdownReferenceId(shortcutImageMatch[1]));
        nodes.push(definition ? renderMarkdownImage(key, shortcutImageMatch[1], definition.href, definition.title, context) : token);
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith('[^')) {
      const footnoteId = normalizeMarkdownFootnoteId(token.slice(2, -1));
      const footnote = context.footnoteDefinitions.get(footnoteId);
      nodes.push(footnote ? (
        <sup key={key} id={`fnref-${footnote.id}`} title={footnote.text} className="ml-0.5 rounded bg-surface-2 px-1 text-[0.72em] font-semibold text-primary">
          <a href={`#fn-${footnote.id}`} className="text-primary no-underline">{footnote.index}</a>
        </sup>
      ) : token);
    } else if (token.startsWith('<http')) {
      const linkText = token.slice(1, -1);
      nodes.push(
        <a key={key} href={linkText} target="_blank" rel="noreferrer" className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary`}>
          {linkText}
        </a>,
      );
    } else if (token.startsWith('<') && token.endsWith('>') && isMarkdownEmail(token.slice(1, -1))) {
      const email = token.slice(1, -1);
      nodes.push(
        <a key={key} href={`mailto:${email}`} className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary`}>
          {email}
        </a>,
      );
    } else if (isMarkdownEmail(splitAutoLinkPunctuation(token).linkText)) {
      const { linkText, suffix } = splitAutoLinkPunctuation(token);
      nodes.push(
        <a key={key} href={`mailto:${linkText}`} className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary`}>
          {linkText}
        </a>,
      );
      if (suffix) nodes.push(suffix);
    } else if (token.startsWith('http') || token.startsWith('www.')) {
      const { linkText, suffix } = splitAutoLinkPunctuation(token);
      const href = linkText.startsWith('www.') ? `https://${linkText}` : linkText;
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noreferrer" className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary`}>
          {linkText}
        </a>,
      );
      if (suffix) nodes.push(suffix);
    } else {
      const inlineLinkMatch = token.match(/^\[([^\]]+)\]\((.*)\)$/);
      const referenceLinkMatch = token.match(/^\[([^\]]+)\]\[([^\]]*)\]$/);
      const shortcutLinkMatch = token.match(/^\[([^\]]+)\]$/);
      const definitionId = referenceLinkMatch ? referenceLinkMatch[2] || referenceLinkMatch[1] : shortcutLinkMatch?.[1] ?? null;
      const definition = definitionId ? context.referenceDefinitions.get(normalizeMarkdownReferenceId(definitionId)) : null;
      const inlineTarget = inlineLinkMatch ? parseMarkdownInlineTarget(inlineLinkMatch[2]) : null;
      const href = inlineTarget?.href ?? definition?.href ?? null;
      const safeHref = href ? getSafeMarkdownHref(href) : null;
      const label = inlineLinkMatch?.[1] ?? referenceLinkMatch?.[1] ?? shortcutLinkMatch?.[1] ?? '';
      nodes.push(safeHref ? (
        <a key={key} href={safeHref} title={inlineTarget?.title ?? definition?.title} target="_blank" rel="noreferrer" className={`${wrapLongTokens ? 'break-all' : 'whitespace-nowrap'} text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary`}>
          {renderMarkdownInline(label, `${key}-link`, wrapLongTokens, context)}
        </a>
      ) : token);
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < maskedText.length) nodes.push(unmaskMarkdownEscapes(maskedText.slice(lastIndex)));
  return nodes.length > 0 ? nodes : [text];
}

function hasMarkdownHardBreak(line: string): boolean {
  return /(?: {2,}|\\)$/.test(line);
}

function stripMarkdownHardBreak(line: string): string {
  return line.replace(/(?: {2,}|\\)$/, '');
}

function isIndentedCodeLine(line: string): boolean {
  return /^(?: {4}|\t)/.test(line);
}

function stripIndentedCodeLine(line: string): string {
  return line.startsWith('\t') ? line.slice(1) : line.replace(/^ {4}/, '');
}

function renderMarkdownInlineLines(lines: string[], keyPrefix: string, context: MarkdownRenderContext): ReactNode[] {
  const nodes: ReactNode[] = [];
  lines.forEach((line, index) => {
    const hardBreak = hasMarkdownHardBreak(line);
    nodes.push(...renderMarkdownInline(stripMarkdownHardBreak(line), `${keyPrefix}-${index}`, true, context));
    if (index < lines.length - 1) nodes.push(hardBreak ? <br key={`${keyPrefix}-${index}-br`} /> : ' ');
  });
  return nodes;
}

// Same line splitting as renderMarkdownInlineLines, but in two phases so the
// inline rendering (which has side effects: image gallery registration) runs
// EAGERLY while the block is built, and only the per-line wrapper spans —
// data-md-ref-* stamps + data-selected highlight — are re-created whenever
// the referenced line range changes. This mirrors how table blocks precompute
// their cells: content functions must never re-run renderMarkdownInline, or
// images would be registered again on every render.
function renderMarkdownRefLineNodes(lines: string[], keyPrefix: string, context: MarkdownRenderContext): { perLine: ReactNode[]; hardBreaks: boolean[] } {
  const perLine: ReactNode[] = [];
  const hardBreaks: boolean[] = [];
  lines.forEach((line, index) => {
    hardBreaks.push(hasMarkdownHardBreak(line));
    perLine.push(renderMarkdownInline(stripMarkdownHardBreak(line), `${keyPrefix}-${index}`, true, context));
  });
  return { perLine, hardBreaks };
}

function wrapMarkdownRefLines(
  perLine: ReactNode[],
  hardBreaks: boolean[],
  lineNums: number[],
  keyPrefix: string,
  lineRange: { start: number; end: number } | null,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  perLine.forEach((lineNodes, index) => {
    const lineNo = lineNums[index] ?? 0;
    const selected = Boolean(lineRange && lineNo >= lineRange.start && lineNo <= lineRange.end);
    nodes.push(
      <span
        key={`${keyPrefix}-ref-${index}`}
        data-md-ref-start={lineNo}
        data-md-ref-end={lineNo}
        data-selected={selected ? 'true' : undefined}
      >
        {lineNodes}
      </span>,
    );
    if (index < perLine.length - 1) nodes.push(hardBreaks[index] ? <br key={`${keyPrefix}-${index}-br`} /> : ' ');
  });
  return nodes;
}

function splitMarkdownTableRow(line: string): string[] {
  const normalized = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let escaping = false;
  let codeFenceLength = 0;
  let bracketDepth = 0;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === '`') {
      const start = index;
      while (index + 1 < normalized.length && normalized[index + 1] === '`') index += 1;
      const tickLength = index - start + 1;
      current += '`'.repeat(tickLength);
      if (codeFenceLength === 0) codeFenceLength = tickLength;
      else if (codeFenceLength === tickLength) codeFenceLength = 0;
      continue;
    }
    if (codeFenceLength === 0 && char === '[') {
      bracketDepth += 1;
    } else if (codeFenceLength === 0 && char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
    }
    if (char === '|' && codeFenceLength === 0 && bracketDepth === 0) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (escaping) current += '\\';
  cells.push(current.trim());
  return cells;
}

type MarkdownTableAlign = 'left' | 'center' | 'right' | null;

function parseMarkdownTableAlignments(line: string): MarkdownTableAlign[] {
  return splitMarkdownTableRow(line).map((cell) => {
    if (/^:-+:$/.test(cell)) return 'center';
    if (/^-+:$/.test(cell)) return 'right';
    if (/^:-+$/.test(cell)) return 'left';
    return null;
  });
}

function getMarkdownTableAlignClass(align: MarkdownTableAlign): string {
  if (align === 'center') return 'text-center';
  if (align === 'right') return 'text-right';
  return 'text-left';
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/.test(line.trim());
}

export function shouldCloseMarkdownImageLightboxDrag(verticalMovement: number, verticalVelocity: number): boolean {
  return verticalMovement > 96 || (verticalMovement > 44 && verticalVelocity > 0.35);
}

interface MarkdownListItem {
  content: string;
  ordered: boolean;
  start?: number;
  children: MarkdownListItem[];
  paragraphs: string[];
  // 1-based source line range of the item (including nested children and
  // continuation paragraphs), relative to the array passed to
  // parseMarkdownListBlock — absolute for top-level lists, quote-relative for
  // lists nested inside blockquotes (callers add a line offset when stamping
  // data-md-ref-* attributes).
  lineStart: number;
  lineEnd: number;
}

function getMarkdownListIndent(line: string): number {
  return (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length;
}

function parseMarkdownListItemLine(line: string): { ordered: boolean; start?: number; content: string } | null {
  const match = line.trim().match(/^([-+*]|\d+[.)])\s+(.+)$/);
  if (!match) return null;
  const ordered = /^\d+[.)]$/.test(match[1]);
  return { ordered, start: ordered ? Number.parseInt(match[1], 10) : undefined, content: match[2] };
}

function parseMarkdownListBlock(
  lines: string[],
  startIndex: number,
  baseIndent: number,
  ordered: boolean,
  skipDefinitionLines: boolean,
  footnoteDefinitionLines: Set<number> = new Set(),
): { items: MarkdownListItem[]; nextIndex: number } {
  const items: MarkdownListItem[] = [];
  const stack: Array<{ indent: number; item: MarkdownListItem }> = [];
  let index = startIndex;

  while (index < lines.length) {
    const currentLine = lines[index];
    if (skipDefinitionLines && (parseMarkdownReferenceDefinition(currentLine) || footnoteDefinitionLines.has(index))) {
      index += 1;
      continue;
    }

    const itemMatch = parseMarkdownListItemLine(currentLine);
    const indent = getMarkdownListIndent(currentLine);

    if (!itemMatch) {
      if (indent > baseIndent && stack.length > 0) {
        const target = [...stack].reverse().find((entry) => entry.indent < indent)?.item ?? stack[stack.length - 1].item;
        target.paragraphs.push(currentLine.trim());
        for (const entry of stack) entry.item.lineEnd = index + 1;
        index += 1;
        continue;
      }
      break;
    }

    if (indent < baseIndent) break;
    if (indent === baseIndent && itemMatch.ordered !== ordered) break;

    const item: MarkdownListItem = { content: itemMatch.content, ordered: itemMatch.ordered, start: itemMatch.start, children: [], paragraphs: [], lineStart: index + 1, lineEnd: index + 1 };
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.item ?? null;
    if (parent) parent.children.push(item);
    else items.push(item);
    stack.push({ indent, item });
    for (const entry of stack) entry.item.lineEnd = index + 1;
    index += 1;
  }

  return { items, nextIndex: index };
}

export function __testParseMarkdownListBlock(lines: string[]): MarkdownListItem[] {
  const first = lines.find((line) => parseMarkdownListItemLine(line));
  if (!first) return [];
  const parsed = parseMarkdownListItemLine(first);
  if (!parsed) return [];
  return parseMarkdownListBlock(lines, 0, getMarkdownListIndent(first), parsed.ordered, true, collectMarkdownFootnoteDefinitionLineIndexes(lines)).items;
}

// List rendering is split like paragraphs (see renderMarkdownRefLineNodes):
// buildMarkdownListItemRenders runs all inline rendering eagerly (image
// registration happens once, at block-build time), wrapMarkdownListItems only
// re-creates the <li> wrappers — data-md-ref-* stamps and the data-selected
// highlight — when the referenced line range changes.
interface MarkdownListGroupRender {
  ordered: boolean;
  start?: number;
  items: MarkdownListItemRender[];
}

interface MarkdownListItemRender {
  key: string;
  taskItem: boolean;
  refStart: number;
  refEnd: number;
  content: ReactNode;
  groups: MarkdownListGroupRender[];
}

function buildMarkdownListItemRenders(
  items: MarkdownListItem[],
  keyPrefix: string,
  context: MarkdownRenderContext,
  lineOffset = 0,
): MarkdownListItemRender[] {
  return items.map((item, itemIndex) => {
    const taskMatch = item.content.match(/^\[([ xX])\]\s+(.+)$/);
    return {
      key: `item-${itemIndex}`,
      taskItem: Boolean(taskMatch),
      refStart: item.lineStart + lineOffset,
      refEnd: item.lineEnd + lineOffset,
      content: (
        <>
          {taskMatch ? <input type="checkbox" checked={taskMatch[1].toLowerCase() === 'x'} readOnly className="mr-2 align-[-2px] accent-primary" /> : null}
          {renderMarkdownInline(taskMatch?.[2] ?? item.content, `li-${keyPrefix}-${itemIndex}`, true, context)}
          {item.paragraphs.length > 0 && (
            <div className="mt-1 space-y-1 text-muted-foreground">
              {item.paragraphs.map((paragraph, paragraphIndex) => (
                <p key={`paragraph-${paragraphIndex}`}>
                  {renderMarkdownInline(paragraph, `li-${keyPrefix}-${itemIndex}-p-${paragraphIndex}`, true, context)}
                </p>
              ))}
            </div>
          )}
        </>
      ),
      groups: buildMarkdownListGroupRenders(item.children, `${keyPrefix}-${itemIndex}`, context, lineOffset),
    };
  });
}

function buildMarkdownListGroupRenders(
  items: MarkdownListItem[],
  keyPrefix: string,
  context: MarkdownRenderContext,
  lineOffset = 0,
): MarkdownListGroupRender[] {
  const groups: Array<{ ordered: boolean; items: MarkdownListItem[] }> = [];
  for (const item of items) {
    const current = groups[groups.length - 1];
    if (current && current.ordered === item.ordered) current.items.push(item);
    else groups.push({ ordered: item.ordered, items: [item] });
  }

  return groups.map((group, groupIndex) => ({
    ordered: group.ordered,
    start: group.ordered ? group.items[0]?.start : undefined,
    items: buildMarkdownListItemRenders(group.items, `${keyPrefix}-g${groupIndex}`, context, lineOffset),
  }));
}

function wrapMarkdownListItems(renders: MarkdownListItemRender[], lineRange: { start: number; end: number } | null): ReactNode[] {
  return renders.map((item) => {
    const selected = Boolean(lineRange && item.refStart <= lineRange.end && item.refEnd >= lineRange.start);
    return (
      <li
        key={item.key}
        className={item.taskItem ? 'list-none' : undefined}
        data-md-ref-start={item.refStart}
        data-md-ref-end={item.refEnd}
        data-selected={selected ? 'true' : undefined}
      >
        {item.content}
        {item.groups.length > 0 && wrapMarkdownListGroups(item.groups, lineRange)}
      </li>
    );
  });
}

function wrapMarkdownListGroups(groups: MarkdownListGroupRender[], lineRange: { start: number; end: number } | null): ReactNode[] {
  return groups.map((group, groupIndex) => {
    const ListTag = group.ordered ? 'ol' : 'ul';
    return (
      <ListTag key={`nested-${groupIndex}`} start={group.start} className={`${group.ordered ? 'list-decimal' : 'list-disc'} mt-1 space-y-0.5 pl-4 marker:text-muted-foreground/60`}>
        {wrapMarkdownListItems(group.items, lineRange)}
      </ListTag>
    );
  });
}

function renderMarkdownFootnotes(context: MarkdownRenderContext): ReactNode | null {
  const footnotes = Array.from(context.footnoteDefinitions.values()).sort((a, b) => a.index - b.index);
  if (footnotes.length === 0) return null;

  return (
    <section className="mt-3 border-t border-border/20 pt-2 text-[12px] leading-5 text-muted-foreground">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">{context.footnotesLabel}</div>
      <ol className="list-decimal space-y-1 pl-5">
        {footnotes.map((footnote) => (
          <li key={footnote.id} id={`fn-${footnote.id}`}>
            {renderMarkdownInline(footnote.text, `footnote-${footnote.id}`, true, context)}
            {' '}
            <a href={`#fnref-${footnote.id}`} className="text-primary no-underline" aria-label={context.backToFootnoteLabel(footnote.index)}>↩</a>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Quote content is built in the same two phases as paragraphs/lists (see
// renderMarkdownRefLineNodes): buildMarkdownQuoteNodeRenders runs ALL inline
// rendering eagerly at block-build time (image gallery registration must not
// re-run per render), producing descriptors; wrapMarkdownQuoteNodes then only
// re-assembles the tree with per-line data-selected highlights whenever the
// referenced line range changes.
type MarkdownQuoteNodeRender =
  | { kind: 'static'; node: ReactNode }
  | { kind: 'paragraph'; keyPrefix: string; perLine: ReactNode[]; hardBreaks: boolean[]; lineNums: number[] }
  | { kind: 'list'; keyPrefix: string; ordered: boolean; start?: number; renders: MarkdownListItemRender[] }
  | { kind: 'code'; key: string; code: string; lang: string; blockKey: string; codeStartLine: number };

function buildMarkdownQuoteNodeRenders(lines: string[], keyPrefix: string, context: MarkdownRenderContext, lineNums?: number[]): MarkdownQuoteNodeRender[] {
  const nodes: MarkdownQuoteNodeRender[] = [];
  let index = 0;
  // Quote lines are consumed consecutively, so lineNums[i] is the 1-based
  // source line of quote line i; nested constructs (lists, code) only know
  // their quote-relative index and get shifted back through this.
  const lineAt = (quoteIndex: number) => lineNums?.[quoteIndex] ?? quoteIndex + 1;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^<details>\s*$/i.test(trimmed)) {
      const blockStart = index;
      let summary = 'Details';
      const bodyLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^<\/details>\s*$/i.test(lines[index].trim())) {
        const summaryMatch = lines[index].trim().match(/^<summary>(.*?)<\/summary>\s*$/i);
        if (summaryMatch) summary = summaryMatch[1].trim() || summary;
        else bodyLines.push(lines[index].trimStart());
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push({
        kind: 'static',
        node: (
          <details key={`${keyPrefix}-details-${blockStart}`} className="overflow-hidden rounded-lg border border-border/20 bg-surface px-3 py-2 text-muted-foreground">
            <summary className="cursor-pointer text-sm font-semibold text-foreground">{renderMarkdownInline(summary, `${keyPrefix}-details-${blockStart}-summary`, true, context)}</summary>
            {bodyLines.length > 0 && (
              <div className="mt-2 text-sm leading-6">{renderMarkdownInlineLines(bodyLines, `${keyPrefix}-details-${blockStart}`, context)}</div>
            )}
          </details>
        ),
      });
      continue;
    }

    const htmlBlockStart = parseMarkdownHtmlBlockStart(line);
    if (htmlBlockStart) {
      const htmlLines = [line];
      const blockStart = index;
      index += 1;
      while (
        index < lines.length
        && !htmlBlockStart.selfContained
        && !new RegExp(`</${htmlBlockStart.tag}>`, 'i').test(lines[index])
      ) {
        htmlLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length && !htmlBlockStart.selfContained) {
        htmlLines.push(lines[index]);
        index += 1;
      }
      nodes.push({ kind: 'static', node: <MarkdownSanitizedHtml key={`${keyPrefix}-html-${blockStart}`} html={htmlLines.join('\n')} /> });
      continue;
    }

    const fenceMatch = trimmed.match(/^(```|~~~)\s*(.*)$/);
    if (fenceMatch) {
      const codeLines: string[] = [];
      const fence = fenceMatch[1];
      const lang = fenceMatch[2]?.trim();
      const blockStart = index;
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      if (lang.toLowerCase() === 'mermaid') {
        nodes.push({ kind: 'static', node: <MarkdownMermaidBlock key={`${keyPrefix}-code-${blockStart}`} code={codeLines.join('\n')} blockKey={`${keyPrefix}-code-${blockStart}`} /> });
      } else if (['math', 'latex', 'tex'].includes(lang.toLowerCase())) {
        nodes.push({ kind: 'static', node: <MarkdownMath key={`${keyPrefix}-code-${blockStart}`} tex={codeLines.join('\n')} display /> });
      } else {
        nodes.push({ kind: 'code', key: `${keyPrefix}-code-${blockStart}`, code: codeLines.join('\n'), lang, blockKey: `${keyPrefix}-code-${blockStart}`, codeStartLine: lineAt(blockStart) + 1 });
      }
      continue;
    }

    if (isIndentedCodeLine(line)) {
      const codeLines: string[] = [];
      const blockStart = index;
      while (index < lines.length && (isIndentedCodeLine(lines[index]) || !lines[index].trim())) {
        codeLines.push(lines[index].trim() ? stripIndentedCodeLine(lines[index]) : '');
        index += 1;
      }
      nodes.push({ kind: 'code', key: `${keyPrefix}-indented-code-${blockStart}`, code: codeLines.join('\n').replace(/\n+$/, ''), lang: '', blockKey: `${keyPrefix}-indented-code-${blockStart}`, codeStartLine: lineAt(blockStart) });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length + 1);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      const headingText = normalizeMarkdownAtxHeadingText(headingMatch[2]);
      const headingId = getMarkdownHeadingId(headingText, context);
      nodes.push({
        kind: 'static',
        node: (
          <Tag key={`${keyPrefix}-heading-${index}`} id={headingId} className="scroll-mt-16 font-semibold text-foreground">
            {renderMarkdownInline(headingText, `${keyPrefix}-heading-${index}`, true, context)}
          </Tag>
        ),
      });
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && line.includes('|') && isMarkdownTableSeparator(lines[index + 1])) {
      const header = splitMarkdownTableRow(line);
      const alignments = parseMarkdownTableAlignments(lines[index + 1]);
      const rows: string[][] = [];
      const blockStart = index;
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      nodes.push({
        kind: 'static',
        node: (
          <div key={`${keyPrefix}-table-${blockStart}`} className={MARKDOWN_TABLE_SCROLL_CLASS} data-markdown-table-scroll>
              <table className="w-max min-w-full max-w-none table-auto border-collapse text-left text-[11px] sm:text-xs">
                <thead className="bg-surface-2 text-foreground">
                <tr>{header.map((cell, cellIndex) => <th key={`h-${cellIndex}`} className={`${MARKDOWN_TABLE_HEADER_CLASS} ${getMarkdownTableAlignClass(alignments[cellIndex] ?? null)}`}><div className={MARKDOWN_TABLE_CELL_CONTENT_CLASS}>{renderMarkdownInline(cell, `${keyPrefix}-th-${blockStart}-${cellIndex}`, true, context)}</div></th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((row, rowIndex) => (
                    <tr key={`r-${rowIndex}`} className="border-t border-border/10">
                    {header.map((_, cellIndex) => <td key={`c-${cellIndex}`} className={`${MARKDOWN_TABLE_BODY_CELL_CLASS} ${getMarkdownTableAlignClass(alignments[cellIndex] ?? null)}`}><div className={MARKDOWN_TABLE_CELL_CONTENT_CLASS}>{renderMarkdownInline(row[cellIndex] ?? '', `${keyPrefix}-td-${blockStart}-${rowIndex}-${cellIndex}`, true, context)}</div></td>)}
                    </tr>
                  ))}
                </tbody>
            </table>
          </div>
        ),
      });
      continue;
    }

    const listMatch = parseMarkdownListItemLine(line);
    if (listMatch) {
      const ordered = listMatch.ordered;
      const baseIndent = getMarkdownListIndent(line);
      const start = listMatch.start;
      const blockStart = index;
      const parsed = parseMarkdownListBlock(lines, index, baseIndent, ordered, false);
      index = parsed.nextIndex;
      nodes.push({
        kind: 'list',
        keyPrefix: `${keyPrefix}-list-${blockStart}`,
        ordered,
        start: ordered ? start : undefined,
        renders: buildMarkdownListItemRenders(parsed.items, `${keyPrefix}-list-${blockStart}`, context, lineAt(0) - 1),
      });
      continue;
    }

    const paragraphLines = [line.trimStart()];
    const paragraphNums = [lineAt(index)];
    const blockStart = index;
    index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      if (index + 1 < lines.length && lines[index].includes('|') && isMarkdownTableSeparator(lines[index + 1])) break;
      paragraphLines.push(lines[index].trimStart());
      paragraphNums.push(lineAt(index));
      index += 1;
    }
    const renderedParagraph = renderMarkdownRefLineNodes(paragraphLines, `${keyPrefix}-p-${blockStart}`, context);
    nodes.push({ kind: 'paragraph', keyPrefix: `${keyPrefix}-p-${blockStart}`, perLine: renderedParagraph.perLine, hardBreaks: renderedParagraph.hardBreaks, lineNums: paragraphNums });
  }

  return nodes;
}

function wrapMarkdownQuoteNodes(renders: MarkdownQuoteNodeRender[], lineRange: { start: number; end: number } | null): ReactNode[] {
  return renders.map((item) => {
    switch (item.kind) {
      case 'static':
        return item.node;
      case 'paragraph':
        return <p key={item.keyPrefix}>{wrapMarkdownRefLines(item.perLine, item.hardBreaks, item.lineNums, item.keyPrefix, lineRange)}</p>;
      case 'list': {
        const ListTag = item.ordered ? 'ol' : 'ul';
        return (
          <ListTag key={item.keyPrefix} start={item.start} className={`${item.ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 pl-4 marker:text-muted-foreground/70`}>
            {wrapMarkdownListItems(item.renders, lineRange)}
          </ListTag>
        );
      }
      case 'code':
        return <MarkdownCodeBlock key={item.key} code={item.code} lang={item.lang} blockKey={item.blockKey} codeStartLine={item.codeStartLine} lineRange={lineRange} />;
    }
  });
}

interface MarkdownPreviewBlock {
  key: string;
  startLine: number;
  endLine: number;
  content: ReactNode | ((lineRange: { start: number; end: number } | null) => ReactNode);
  heading?: MarkdownHeadingInfo;
  interactive?: boolean;
  kind?: 'table';
  // True when the block stamps data-md-ref-* targets inside (paragraph lines,
  // list items, quote lines, code lines): a partial selection then highlights
  // only the exact lines + a rail segment instead of washing the whole block.
  fineGrained?: boolean;
}

interface MarkdownCodeBlockProps {
  code: string;
  lang: string;
  blockKey: string;
  // 1-based source line of the first code line; when set, every rendered line
  // is stamped with data-md-ref-* so it can be referenced on its own.
  codeStartLine?: number;
  lineRange?: { start: number; end: number } | null;
}

interface MermaidLike {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidLike> | null = null;
let mermaidInitialized = false;
const MERMAID_SVG_PADDING = 16;
const MERMAID_SVG_MIN_WIDTH = 192;

function loadMermaid(): Promise<MermaidLike> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then((mod) => ((mod as { default?: MermaidLike }).default ?? mod) as MermaidLike)
      .catch((error) => {
        mermaidPromise = null;
        throw error;
      });
  }
  return mermaidPromise;
}

function initializeMermaid(mermaid: MermaidLike): void {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'neutral',
  });
  mermaidInitialized = true;
}

function normalizeMermaidSvgSize(svg: string): string {
  const viewBoxMatch = svg.match(/\sviewBox=(["'])([^"']+)\1/i);
  if (!viewBoxMatch) return svg;
  const [, , viewBox] = viewBoxMatch;
  const values = viewBox.trim().split(/[\s,]+/).map(Number);
  const [, , width, height] = values;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return svg;

  const displayWidth = Math.max(MERMAID_SVG_MIN_WIDTH, Math.ceil(width));
  const displayHeight = Math.ceil((displayWidth / width) * height);
  return svg.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    const cleanedAttrs = attrs
      .replace(/\s(?:width|height)=(["']).*?\1/gi, '')
      .replace(/\sstyle=(["']).*?\1/gi, '');
    return `<svg${cleanedAttrs} width="${displayWidth}" height="${displayHeight}">`;
  });
}

function fitMermaidSvgToContent(root: HTMLElement | null): void {
  const svg = root?.querySelector<SVGSVGElement>('svg');
  if (!svg) return;

  let box: DOMRect | SVGRect;
  try {
    box = svg.getBBox();
  } catch {
    return;
  }

  if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) return;

  const viewX = box.x - MERMAID_SVG_PADDING;
  const viewY = box.y - MERMAID_SVG_PADDING;
  const viewWidth = box.width + MERMAID_SVG_PADDING * 2;
  const viewHeight = box.height + MERMAID_SVG_PADDING * 2;
  const displayWidth = Math.max(MERMAID_SVG_MIN_WIDTH, Math.ceil(viewWidth));
  const displayHeight = Math.ceil((displayWidth / viewWidth) * viewHeight);

  svg.setAttribute('viewBox', `${viewX} ${viewY} ${viewWidth} ${viewHeight}`);
  svg.setAttribute('width', String(displayWidth));
  svg.setAttribute('height', String(displayHeight));
  svg.removeAttribute('style');
}

function normalizeMarkdownFenceLanguage(lang: string): string | null {
  const firstToken = lang.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!firstToken) return null;
  const normalized = firstToken.replace(/^language-/, '');
  return resolveLanguage(`code.${normalized}`) ?? normalized;
}

function MarkdownMermaidBlock({
  code,
  blockKey,
}: {
  code: string;
  blockKey: string;
}) {
  const { t } = useI18n();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const diagramRef = useRef<HTMLDivElement | null>(null);
  const onOpen = useContext(MarkdownMermaidOpenContext);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);

    loadMermaid()
      .then(async (mermaid) => {
        initializeMermaid(mermaid);
        const id = `termdock-md-mermaid-${blockKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        const { svg: renderedSvg } = await mermaid.render(id, code);
        if (cancelled) return;
        setSvg(normalizeMermaidSvgSize(renderedSvg));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [blockKey, code]);

  useLayoutEffect(() => {
    if (!svg) return;
    fitMermaidSvgToContent(diagramRef.current);
  }, [svg]);

  const handleOpen = useCallback(() => {
    const currentSvg = diagramRef.current?.querySelector('svg')?.outerHTML ?? svg;
    if (currentSvg) onOpen?.(currentSvg);
  }, [onOpen, svg]);

  if (failed) {
    return <MarkdownCodeBlock code={code} lang="mermaid" blockKey={`${blockKey}-fallback`} />;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border/20 bg-surface shadow-sm">
      <div className="border-b border-border/15 bg-surface-2 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">mermaid</div>
      <div className="bg-surface p-3">
        {svg ? (
          <button
            type="button"
            className="block max-w-full rounded text-left focus:outline-none focus:ring-2 focus:ring-ring/45"
            title={t('rightSidebar.openMermaidDiagram')}
            onClick={(event) => {
              event.stopPropagation();
              handleOpen();
            }}
          >
            <span
              ref={diagramRef}
              role="img"
              aria-label={t('rightSidebar.mermaidDiagram')}
              className="block max-h-[70vh] max-w-full overflow-auto rounded bg-white p-2 text-slate-900 [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </button>
        ) : (
          <div className="py-6 text-center text-xs text-muted-foreground">{t('rightSidebar.renderingDiagram')}</div>
        )}
      </div>
    </div>
  );
}

function MarkdownCodeBlock({ code, lang, blockKey, codeStartLine, lineRange }: MarkdownCodeBlockProps) {
  const language = normalizeMarkdownFenceLanguage(lang);
  const [highlighted, setHighlighted] = useState<ReactNode[][] | null>(null);

  useEffect(() => {
    if (!language || !shouldHighlight(code)) {
      setHighlighted(null);
      return;
    }
    let cancelled = false;
    loadRefractor()
      .then((refractor) => {
        if (cancelled || !refractor.registered(language)) {
          if (!cancelled) setHighlighted(null);
          return;
        }
        try {
          setHighlighted(highlightToLines(refractor, code, language));
        } catch {
          if (!cancelled) setHighlighted(null);
        }
      })
      .catch(() => {
        if (!cancelled) setHighlighted(null);
      });
    return () => { cancelled = true; };
  }, [blockKey, code, language]);

  const perLine: ReactNode[][] = highlighted ?? (code || ' ').split('\n').map((line) => [line || ' ']);

  return (
    <div className="overflow-hidden rounded-lg border border-border/20 bg-surface shadow-sm">
      {lang && <div className="border-b border-border/15 bg-surface-2 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{lang}</div>}
      <pre className={`${FILE_PREVIEW_HORIZONTAL_SCROLL_CLASS} termdock-code overflow-auto p-3 text-[11px] leading-relaxed text-foreground`}><code>{perLine.map((lineNodes, lineIndex) => {
        const lineNo = codeStartLine != null ? codeStartLine + lineIndex : null;
        const selected = Boolean(lineRange && lineNo != null && lineNo >= lineRange.start && lineNo <= lineRange.end);
        return (
          <span
            key={`${blockKey}-line-${lineIndex}`}
            data-md-ref-start={lineNo ?? undefined}
            data-md-ref-end={lineNo ?? undefined}
            data-selected={selected ? 'true' : undefined}
          >
            {lineNodes}{lineIndex < perLine.length - 1 ? '\n' : null}
          </span>
        );
      })}</code></pre>
    </div>
  );
}

export function buildMarkdownPreviewRenderResult(
  lines: string[],
  markdownFilePath: string | null,
  rootPath: string | null,
  onImageOpen?: (index: number) => void,
  labels?: { footnotes: string; backToFootnote: (index: number) => string },
): MarkdownPreviewRenderResult {
  lines = maskMarkdownHiddenLines(lines);
  const referenceDefinitions = collectMarkdownReferenceDefinitions(lines);
  const footnoteDefinitionLines = collectMarkdownFootnoteDefinitionLineIndexes(lines);
  const images: MarkdownPreviewImage[] = [];
  const context: MarkdownRenderContext = {
    markdownFilePath,
    rootPath,
    referenceDefinitions,
    footnoteDefinitions: collectMarkdownFootnoteDefinitions(lines),
    headingSlugCounts: new Map(),
    images,
    onImageOpen,
    footnotesLabel: labels?.footnotes ?? 'Footnotes',
    backToFootnoteLabel: labels?.backToFootnote ?? ((index) => `Back to footnote ${index}`),
  };
  const blocks: MarkdownPreviewBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (parseMarkdownReferenceDefinition(line) || footnoteDefinitionLines.has(index)) {
      index += 1;
      continue;
    }

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^<details>\s*$/i.test(trimmed)) {
      const blockStart = index;
      let summary = 'Details';
      const bodyLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^<\/details>\s*$/i.test(lines[index].trim())) {
        const summaryMatch = lines[index].trim().match(/^<summary>(.*?)<\/summary>\s*$/i);
        if (summaryMatch) summary = summaryMatch[1].trim() || summary;
        else bodyLines.push(lines[index].trimStart());
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        key: `details-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        content: (
          <details className="overflow-hidden rounded-lg border border-border/20 bg-surface px-3 py-2 text-muted-foreground">
            <summary className="cursor-pointer text-sm font-semibold text-foreground">{renderMarkdownInline(summary, `details-${blockStart}-summary`, true, context)}</summary>
            {bodyLines.length > 0 && (
              <div className="mt-2 text-sm leading-6">{renderMarkdownInlineLines(bodyLines, `details-${blockStart}`, context)}</div>
            )}
          </details>
        ),
      });
      continue;
    }

    const htmlBlockStart = parseMarkdownHtmlBlockStart(line);
    if (htmlBlockStart) {
      const htmlLines = [line];
      const blockStart = index;
      index += 1;
      while (
        index < lines.length
        && !htmlBlockStart.selfContained
        && !new RegExp(`</${htmlBlockStart.tag}>`, 'i').test(lines[index])
      ) {
        htmlLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length && !htmlBlockStart.selfContained) {
        htmlLines.push(lines[index]);
        index += 1;
      }
      blocks.push({
        key: `html-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        content: <MarkdownSanitizedHtml html={htmlLines.join('\n')} />,
      });
      continue;
    }

    const fenceMatch = trimmed.match(/^(```|~~~)\s*(.*)$/);
    if (fenceMatch) {
      const codeLines: string[] = [];
      const fence = fenceMatch[1];
      const lang = fenceMatch[2]?.trim();
      const blockStart = index;
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        key: `code-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        fineGrained: lang.toLowerCase() !== 'mermaid' && !['math', 'latex', 'tex'].includes(lang.toLowerCase()),
        content: lang.toLowerCase() === 'mermaid'
          ? <MarkdownMermaidBlock code={codeLines.join('\n')} blockKey={`code-${blockStart}`} />
          : ['math', 'latex', 'tex'].includes(lang.toLowerCase())
          ? <MarkdownMath tex={codeLines.join('\n')} display />
          : (lineRange) => <MarkdownCodeBlock code={codeLines.join('\n')} lang={lang} blockKey={`code-${blockStart}`} codeStartLine={blockStart + 2} lineRange={lineRange} />,
      });
      continue;
    }

    if (isIndentedCodeLine(line)) {
      const codeLines: string[] = [];
      const blockStart = index;
      index += 0;
      while (index < lines.length && (isIndentedCodeLine(lines[index]) || !lines[index].trim())) {
        codeLines.push(lines[index].trim() ? stripIndentedCodeLine(lines[index]) : '');
        index += 1;
      }
      blocks.push({
        key: `indented-code-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        fineGrained: true,
        content: (lineRange) => <MarkdownCodeBlock code={codeLines.join('\n').replace(/\n+$/, '')} lang="" blockKey={`indented-code-${blockStart}`} codeStartLine={blockStart + 1} lineRange={lineRange} />,
      });
      continue;
    }

    if (trimmed.startsWith('$$')) {
      const mathLines: string[] = [];
      const blockStart = index;
      const firstLine = trimmed.replace(/^\$\$\s*/, '');
      if (firstLine.endsWith('$$') && firstLine.length > 2) {
        mathLines.push(firstLine.replace(/\s*\$\$$/, ''));
        index += 1;
      } else {
        if (firstLine) mathLines.push(firstLine);
        index += 1;
        while (index < lines.length && !lines[index].trim().endsWith('$$')) {
          mathLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          const closingLine = lines[index].trim().replace(/\s*\$\$$/, '');
          if (closingLine) mathLines.push(closingLine);
          index += 1;
        }
      }
      blocks.push({
        key: `math-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        content: <MarkdownMath tex={mathLines.join('\n')} display />,
      });
      continue;
    }

    if (
      index + 1 < lines.length
      && trimmed
      && !isMarkdownBlockStart(line)
      && /^(=+|-+)\s*$/.test(lines[index + 1].trim())
    ) {
      const level = lines[index + 1].trim().startsWith('=') ? 1 : 2;
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      const headingId = getMarkdownHeadingId(trimmed, context);
      const heading: MarkdownHeadingInfo = { level, text: getMarkdownHeadingDisplayText(trimmed), id: headingId };
      blocks.push({
        key: `setext-heading-${index}`,
        startLine: index + 1,
        endLine: index + 2,
        heading,
        content: (
          <Tag id={headingId} className={`scroll-mt-16 font-semibold text-foreground ${level === 1 ? 'mt-1 border-b border-border/20 pb-1.5 text-lg sm:pb-2 sm:text-xl' : 'mt-1 border-b border-border/15 pb-1 text-base sm:pb-1.5 sm:text-lg'}`}>
            {renderMarkdownInline(trimmed, `setext-heading-${index}`, true, context)}
          </Tag>
        ),
      });
      index += 2;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = normalizeMarkdownAtxHeadingText(headingMatch[2]);
      const headingClasses: Record<number, string> = {
        1: 'mt-1 border-b border-border/20 pb-1.5 text-lg sm:pb-2 sm:text-xl',
        2: 'mt-1 border-b border-border/15 pb-1 text-base sm:pb-1.5 sm:text-lg',
        3: 'text-sm sm:text-base',
        4: 'text-[13px] sm:text-sm',
        5: 'text-[11px] uppercase tracking-wide sm:text-xs',
        6: 'text-[11px] uppercase tracking-wide text-muted-foreground',
      };
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      const headingId = getMarkdownHeadingId(headingText, context);
      const heading: MarkdownHeadingInfo = { level, text: getMarkdownHeadingDisplayText(headingText), id: headingId };
      blocks.push({
        key: `heading-${index}`,
        startLine: index + 1,
        endLine: index + 1,
        heading,
        content: <Tag id={headingId} className={`scroll-mt-16 font-semibold text-foreground ${headingClasses[level]}`}>{renderMarkdownInline(headingText, `heading-${index}`, true, context)}</Tag>,
      });
      index += 1;
      continue;
    }

    if (isMarkdownHorizontalRule(line)) {
      blocks.push({
        key: `hr-${index}`,
        startLine: index + 1,
        endLine: index + 1,
        content: <hr className="border-border/20" />,
      });
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      const quoteLineNums: number[] = [];
      const blockStart = index;
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        quoteLineNums.push(index + 1);
        index += 1;
      }
      const calloutMatch = quoteLines[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (calloutMatch) {
        const label = calloutMatch[1].toUpperCase();
        const firstLine = calloutMatch[2]?.trim();
        const bodyLines = [
          ...(firstLine ? [firstLine] : []),
          ...quoteLines.slice(1),
        ];
        const bodyNums = [
          ...(firstLine ? [quoteLineNums[0]] : []),
          ...quoteLineNums.slice(1),
        ];
        const renderedBody = renderMarkdownRefLineNodes(bodyLines, `callout-${blockStart}`, context);
        blocks.push({
          key: `callout-${blockStart}`,
          startLine: blockStart + 1,
          endLine: index,
          fineGrained: true,
          content: (lineRange) => (
            <aside className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-muted-foreground">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">{label}</div>
              {bodyLines.length > 0 && <div>{wrapMarkdownRefLines(renderedBody.perLine, renderedBody.hardBreaks, bodyNums, `callout-${blockStart}`, lineRange)}</div>}
            </aside>
          ),
        });
        continue;
      }
      const quoteRenders = buildMarkdownQuoteNodeRenders(quoteLines, `quote-${blockStart}`, context, quoteLineNums);
      blocks.push({
        key: `quote-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        fineGrained: true,
        content: (lineRange) => (
          <blockquote className="space-y-2 border-l-2 border-border-strong bg-surface-2/70 py-1.5 pl-2.5 pr-2 text-muted-foreground sm:py-2 sm:pl-3">
            {wrapMarkdownQuoteNodes(quoteRenders, lineRange)}
          </blockquote>
        ),
      });
      continue;
    }

    if (index + 1 < lines.length && line.includes('|') && isMarkdownTableSeparator(lines[index + 1])) {
      const header = splitMarkdownTableRow(line);
      const alignments = parseMarkdownTableAlignments(lines[index + 1]);
      const rows: string[][] = [];
      const blockStart = index;
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      const renderedHeader = header.map((cell, cellIndex) => renderMarkdownInline(cell, `th-${blockStart}-${cellIndex}`, true, context));
      const renderedRows = rows.map((row, rowIndex) => header.map((_, cellIndex) => renderMarkdownInline(row[cellIndex] ?? '', `td-${blockStart}-${rowIndex}-${cellIndex}`, true, context)));
      blocks.push({
        key: `table-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        interactive: false,
        kind: 'table',
        content: (lineRange) => {
          const isSelectedLine = (line: number) => Boolean(lineRange && line >= lineRange.start && line <= lineRange.end);
          return (
            <div className={MARKDOWN_TABLE_SCROLL_CLASS} data-markdown-table-scroll>
              <table className="w-max min-w-full max-w-none table-auto border-collapse text-left text-[11px] sm:text-xs">
                <thead className="bg-surface-2 text-foreground">
                  <tr data-markdown-table-row-line={blockStart + 1} data-md-ref-start={blockStart + 1} data-md-ref-end={blockStart + 1} data-selected={isSelectedLine(blockStart + 1) ? 'true' : undefined}>{renderedHeader.map((cellContent, cellIndex) => <th key={`h-${cellIndex}`} className={`${MARKDOWN_TABLE_HEADER_CLASS} ${getMarkdownTableAlignClass(alignments[cellIndex] ?? null)}`}><div className={MARKDOWN_TABLE_CELL_CONTENT_CLASS}>{cellContent}</div></th>)}</tr>
                </thead>
                <tbody>
                  {renderedRows.map((row, rowIndex) => {
                    const rowLine = blockStart + rowIndex + 3;
                    return (
                      <tr key={`r-${rowIndex}`} className="border-t border-border/10" data-markdown-table-row-line={rowLine} data-md-ref-start={rowLine} data-md-ref-end={rowLine} data-selected={isSelectedLine(rowLine) ? 'true' : undefined}>
                        {header.map((_, cellIndex) => <td key={`c-${cellIndex}`} className={`${MARKDOWN_TABLE_BODY_CELL_CLASS} ${getMarkdownTableAlignClass(alignments[cellIndex] ?? null)}`}><div className={MARKDOWN_TABLE_CELL_CONTENT_CLASS}>{row[cellIndex]}</div></td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        },
      });
      continue;
    }

    const listMatch = parseMarkdownListItemLine(line);
    if (listMatch) {
      const ordered = listMatch.ordered;
      const baseIndent = getMarkdownListIndent(line);
      const start = listMatch.start;
      const blockStart = index;
      const parsed = parseMarkdownListBlock(lines, index, baseIndent, ordered, true, footnoteDefinitionLines);
      index = parsed.nextIndex;
      const ListTag = ordered ? 'ol' : 'ul';
      const listRenders = buildMarkdownListItemRenders(parsed.items, `list-${blockStart}`, context);
      blocks.push({
        key: `list-${blockStart}`,
        startLine: blockStart + 1,
        endLine: index,
        fineGrained: true,
        content: (lineRange) => (
          <ListTag start={ordered ? start : undefined} className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 pl-4 text-muted-foreground marker:text-muted-foreground/70 sm:space-y-1 sm:pl-5`}>
            {wrapMarkdownListItems(listRenders, lineRange)}
          </ListTag>
        ),
      });
      continue;
    }

    const paragraphLines: string[] = [line.trimStart()];
    const paragraphNums: number[] = [index + 1];
    const blockStart = index;
    index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      if (index + 1 < lines.length && lines[index].includes('|') && isMarkdownTableSeparator(lines[index + 1])) break;
      if (parseMarkdownReferenceDefinition(lines[index]) || footnoteDefinitionLines.has(index)) {
        index += 1;
        continue;
      }
      paragraphLines.push(lines[index].trimStart());
      paragraphNums.push(index + 1);
      index += 1;
    }
    const renderedParagraph = renderMarkdownRefLineNodes(paragraphLines, `p-${blockStart}`, context);
    blocks.push({
      key: `p-${blockStart}`,
      startLine: blockStart + 1,
      endLine: index,
      fineGrained: true,
      content: (lineRange) => <p className="text-muted-foreground">{wrapMarkdownRefLines(renderedParagraph.perLine, renderedParagraph.hardBreaks, paragraphNums, `p-${blockStart}`, lineRange)}</p>,
    });
  }

  const footnotes = renderMarkdownFootnotes(context);
  if (footnotes) {
    blocks.push({
      key: 'footnotes',
      startLine: lines.length,
      endLine: lines.length,
      content: footnotes,
    });
  }

  return { blocks, images };
}

export function buildMarkdownPreviewBlocks(lines: string[], markdownFilePath: string | null, rootPath: string | null): MarkdownPreviewBlock[] {
  return buildMarkdownPreviewRenderResult(lines, markdownFilePath, rootPath).blocks;
}

interface MarkdownHeadingPathItem extends MarkdownHeadingInfo {
  startLine: number;
}

export function getMarkdownHeadingPathAtLine(blocks: MarkdownPreviewBlock[], line: number): MarkdownHeadingPathItem[] {
  const stack: MarkdownHeadingPathItem[] = [];
  for (const block of blocks) {
    if (block.startLine > line) break;
    if (!block.heading) continue;
    while (stack.length > 0 && stack[stack.length - 1].level >= block.heading.level) stack.pop();
    stack.push({ ...block.heading, startLine: block.startLine });
  }
  return stack;
}

export function getMarkdownHeadingOutline(blocks: MarkdownPreviewBlock[]): MarkdownHeadingPathItem[] {
  return blocks
    .filter((block): block is MarkdownPreviewBlock & { heading: MarkdownHeadingInfo } => Boolean(block.heading))
    .map((block) => ({ ...block.heading, startLine: block.startLine }));
}

interface MarkdownPreviewProps {
  content: string;
  filePath: string | null;
  rootPath: string | null;
  lineRange: { start: number; end: number } | null;
  onLineRangeClick: (event: MouseEvent<HTMLElement>, startLine: number, endLine: number) => void;
  // Drag-to-select on the selection rails: reports the live range while
  // dragging (phase 'move') and the committed range on release (phase 'end').
  onLineRangeDrag?: (event: MouseEvent<HTMLElement>, startLine: number, endLine: number, phase: 'move' | 'end') => void;
  scrollTop: number;
  outlineOpen: boolean;
  outlineCloseSignal?: number;
  onOutlineOpen?: () => void;
  onOutlineClose?: () => void;
  lightboxOpen: boolean;
  lightboxCloseSignal?: number;
  onLightboxOpen?: () => void;
  onLightboxClose?: () => void;
}

// Lightbox variant of the versioned image: same `&v=N` cache-busting as
// MarkdownImage, so an image that changes on disk while the lightbox is open
// reloads instead of showing the bytes captured when it was opened.
function LightboxZoomableImage({ src, alt, onZoomChange, onDoubleTap }: {
  src: string;
  alt: string;
  onZoomChange?: (zoomed: boolean) => void;
  onDoubleTap?: () => void;
}) {
  const versionedSrc = useVersionedFsBlobSrc(src);
  return (
    <ZoomableImage
      src={versionedSrc}
      alt={alt}
      onLoad={() => undefined}
      onError={() => undefined}
      onZoomChange={onZoomChange}
      onDoubleTap={onDoubleTap}
    />
  );
}

interface MarkdownImageLightboxProps {
  images: MarkdownPreviewImage[];
  index: number;
  onChange: (index: number) => void;
  onClose: () => void;
}

export function MarkdownImageLightbox({ images, index, onChange, onClose }: MarkdownImageLightboxProps) {
  const { t } = useI18n();
  const active = images[index];
  const canNavigate = images.length > 1;
  const swiperRef = useRef<SwiperInstance | null>(null);
  const lightboxDragRef = useRef<HTMLDivElement | null>(null);
  const closeTapTimerRef = useRef<number | null>(null);
  const suppressTapCloseUntilRef = useRef(0);
  const [imageZoomed, setImageZoomed] = useState(false);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [dragging, setDragging] = useState(false);

  const clearTapCloseTimer = useCallback(() => {
    if (closeTapTimerRef.current === null) return;
    window.clearTimeout(closeTapTimerRef.current);
    closeTapTimerRef.current = null;
  }, []);

  const scheduleTapClose = useCallback(() => {
    if (imageZoomed || Date.now() < suppressTapCloseUntilRef.current) return;
    clearTapCloseTimer();
    // 450ms gives the second tap of a double-tap time to arrive and veto the
    // close (see ZoomableViewport's pointer-level double-tap detection) —
    // at 300ms the close used to win the race and double-tap "didn't work".
    closeTapTimerRef.current = window.setTimeout(() => {
      closeTapTimerRef.current = null;
      onClose();
    }, 450);
  }, [clearTapCloseTimer, imageZoomed, onClose]);

  const goTo = useCallback((nextIndex: number) => {
    if (images.length === 0) return;
    const normalizedIndex = (nextIndex + images.length) % images.length;
    swiperRef.current?.slideTo(normalizedIndex);
    onChange(normalizedIndex);
  }, [images.length, onChange]);

  const goPrevious = useCallback(() => goTo(index - 1), [goTo, index]);
  const goNext = useCallback(() => goTo(index + 1), [goTo, index]);

  useEffect(() => {
    clearTapCloseTimer();
    setDragOffsetY(0);
    setDragging(false);
    setImageZoomed(false);
  }, [clearTapCloseTimer, index]);

  useEffect(() => {
    const swiper = swiperRef.current;
    if (!swiper) return;
    swiper.allowTouchMove = canNavigate && !imageZoomed;
  }, [canNavigate, imageZoomed]);

  useEffect(() => {
    const swiper = swiperRef.current;
    if (!swiper || swiper.activeIndex === index) return;
    swiper.slideTo(index, 0);
  }, [index]);

  useEffect(() => clearTapCloseTimer, [clearTapCloseTimer]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (!canNavigate) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goPrevious();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goNext();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [canNavigate, goNext, goPrevious, onClose]);

  useGesture(
    {
      onDrag: ({ movement: [mx, my], pinching }) => {
        if (pinching || imageZoomed) return;
        if (Math.abs(my) < Math.abs(mx) * 1.15 && dragOffsetY === 0) return;
        setDragging(true);
        if (Math.abs(my) > 8) suppressTapCloseUntilRef.current = Date.now() + 300;
        setDragOffsetY(Math.max(0, my));
      },
      onDragEnd: ({ movement: [, my], velocity: [, vy] }) => {
        if (imageZoomed) return;
        setDragging(false);
        if (Math.abs(my) > 8) suppressTapCloseUntilRef.current = Date.now() + 300;
        if (shouldCloseMarkdownImageLightboxDrag(my, vy)) {
          onClose();
          return;
        }
        setDragOffsetY(0);
      },
    },
    {
      target: lightboxDragRef,
      drag: {
        filterTaps: true,
        pointer: { touch: true },
      },
    },
  );

  if (!active) return null;
  const activeTitle = active.title || active.alt || (active.kind === 'mermaid' ? t('rightSidebar.mermaidDiagram') : t('rightSidebar.image'));

  return (
    <>
      <div className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-modal-panel flex flex-col bg-background-subtle/95 text-foreground" data-sidebar-gesture-ignore>
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/20 bg-surface/80 px-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{activeTitle}</div>
            <div className="text-[10px] text-muted-foreground">{index + 1} / {images.length}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {canNavigate && (
              <>
                <button
                  type="button"
                  onClick={goPrevious}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                  aria-label={t('rightSidebar.previousImage')}
                  title={t('common.previous')}
                >
                  <RiArrowLeft size={17} />
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                  aria-label={t('rightSidebar.nextImage')}
                  title={t('common.next')}
                >
                  <RiArrowRight size={17} />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
              aria-label={t('rightSidebar.closeImagePreview')}
              title={t('common.close')}
            >
              <RiCloseLine size={18} />
            </button>
          </div>
        </div>
        <div
          ref={lightboxDragRef}
          className="relative min-h-0 flex-1 overflow-hidden"
          data-markdown-image-lightbox-stage
          data-sidebar-gesture-ignore
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.stopPropagation()}
          onClick={scheduleTapClose}
        >
          <div
            className="h-full w-full"
            style={{
              transform: `translate3d(0, ${dragOffsetY}px, 0) scale(${Math.max(0.86, 1 - dragOffsetY / 900)})`,
              opacity: Math.max(0.35, 1 - dragOffsetY / 360),
              transition: dragging ? 'none' : 'transform 0.2s ease-out, opacity 0.2s ease-out',
              willChange: 'transform, opacity',
            }}
          >
            <Swiper
              onSwiper={(instance) => {
                swiperRef.current = instance;
                instance.allowTouchMove = canNavigate && !imageZoomed;
              }}
              onSlideChange={(instance) => {
                if (instance.activeIndex !== index) onChange(instance.activeIndex);
              }}
              initialSlide={index}
              speed={260}
              slidesPerView={1}
              resistanceRatio={0.82}
              threshold={6}
              longSwipesRatio={0.2}
              touchAngle={45}
              touchStartPreventDefault={false}
              simulateTouch={false}
              className="h-full"
            >
              {images.map((image, imageIndex) => (
                <SwiperSlide key={`${image.kind}-${imageIndex}-${image.alt}`} className="h-full">
                  <div className="h-full w-full px-3 py-4 sm:px-6 sm:py-6">
                    {image.kind === 'image' ? (
                      <LightboxZoomableImage
                        src={image.src}
                        alt={image.alt || image.title || t('rightSidebar.markdownImage')}
                        onZoomChange={setImageZoomed}
                        onDoubleTap={clearTapCloseTimer}
                      />
                    ) : (
                      <ZoomableMermaidDiagram
                        svg={image.svg}
                        title={image.title || image.alt || t('rightSidebar.mermaidDiagram')}
                        onZoomChange={setImageZoomed}
                        onDoubleTap={clearTapCloseTimer}
                      />
                    )}
                  </div>
                </SwiperSlide>
              ))}
            </Swiper>
          </div>
        </div>
      </div>
    </>
  );
}

export function MarkdownPreview({
  content,
  filePath,
  rootPath,
  lineRange,
  onLineRangeClick,
  onLineRangeDrag,
  scrollTop,
  outlineOpen,
  outlineCloseSignal,
  onOutlineOpen,
  onOutlineClose,
  lightboxOpen,
  lightboxCloseSignal,
  onLightboxOpen,
  onLightboxClose,
}: MarkdownPreviewProps) {
  const { t } = useI18n();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [mermaidLightboxImage, setMermaidLightboxImage] = useState<MarkdownPreviewImage | null>(null);
  const [activeHeadingLine, setActiveHeadingLine] = useState<number>(1);
  const [outlineDesktopPos, setOutlineDesktopPos] = useState<{ top: number; right: number } | null>(null);
  const previewRootRef = useRef<HTMLDivElement | null>(null);
  const outlineToggleRef = useRef<HTMLButtonElement | null>(null);
  const { blocks, images } = useMemo(
    () => buildMarkdownPreviewRenderResult(
      content.split('\n'),
      filePath,
      rootPath,
      (index) => {
        setMermaidLightboxImage(null);
        setLightboxIndex(index);
        onLightboxOpen?.();
      },
      {
        footnotes: t('rightSidebar.footnotes'),
        backToFootnote: (index) => t('rightSidebar.backToFootnote', { index }),
      },
    ),
    [content, filePath, rootPath, onLightboxOpen, t],
  );
  const lightboxImages = useMemo(
    () => mermaidLightboxImage ? [...images, mermaidLightboxImage] : images,
    [images, mermaidLightboxImage],
  );
  const handleOpenMermaidLightbox = useCallback((svg: string) => {
    const image: MarkdownPreviewImage = {
      kind: 'mermaid',
      svg,
      alt: 'Mermaid diagram',
      title: 'Mermaid diagram',
    };
    setMermaidLightboxImage(image);
    setLightboxIndex(images.length);
    onLightboxOpen?.();
  }, [images.length, onLightboxOpen]);

  useEffect(() => {
    setLightboxIndex(null);
    setMermaidLightboxImage(null);
  }, [content, filePath]);

  useEffect(() => {
    setLightboxIndex(null);
    setMermaidLightboxImage(null);
  }, [lightboxCloseSignal]);

  useEffect(() => {
    if (!lightboxOpen) {
      setLightboxIndex(null);
      setMermaidLightboxImage(null);
    }
  }, [lightboxOpen]);

  useEffect(() => {
    setActiveHeadingLine(1);
  }, [content, filePath]);

  useLayoutEffect(() => {
    const root = previewRootRef.current;
    if (!root || blocks.length === 0) return;
    const blockNodes = Array.from(root.querySelectorAll<HTMLElement>('[data-markdown-preview-block-start]'));
    let nextLine = 1;
    const threshold = 28;
    for (const node of blockNodes) {
      if (node.offsetTop - scrollTop <= threshold) {
        nextLine = Number(node.dataset.markdownPreviewBlockStart) || nextLine;
      } else {
        break;
      }
    }
    setActiveHeadingLine((current) => current === nextLine ? current : nextLine);
  }, [blocks, scrollTop]);

  const activeHeadingPath = useMemo(() => getMarkdownHeadingPathAtLine(blocks, activeHeadingLine), [activeHeadingLine, blocks]);
  const headingOutline = useMemo(() => getMarkdownHeadingOutline(blocks), [blocks]);
  const outlineResetKey = `${filePath ?? ''}\n${content}`;
  const lastOutlineResetKeyRef = useRef(outlineResetKey);
  const tableTapRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const railDragRef = useRef<{ pointerId: number; anchorLine: number; moved: boolean } | null>(null);
  const railDragSuppressClickRef = useRef(false);

  useEffect(() => {
    if (lastOutlineResetKeyRef.current === outlineResetKey) return;
    lastOutlineResetKeyRef.current = outlineResetKey;
    onOutlineClose?.();
  }, [onOutlineClose, outlineResetKey]);

  useEffect(() => {
    if (outlineCloseSignal !== undefined) setOutlineDesktopPos(null);
  }, [outlineCloseSignal]);

  useLayoutEffect(() => {
    if (!outlineOpen) {
      setOutlineDesktopPos(null);
      return;
    }
    const computePosition = () => {
      const button = outlineToggleRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      setOutlineDesktopPos({
        top: rect.bottom + 6,
        right: Math.max(8, viewportWidth - rect.right),
      });
    };
    computePosition();
    window.addEventListener('resize', computePosition);
    window.addEventListener('scroll', computePosition, true);
    return () => {
      window.removeEventListener('resize', computePosition);
      window.removeEventListener('scroll', computePosition, true);
    };
  }, [outlineOpen, scrollTop, activeHeadingPath]);


  const jumpToHeading = useCallback((heading: MarkdownHeadingPathItem) => {
    const root = previewRootRef.current;
    const scroller = root?.closest('[data-markdown-preview-scroller]') as HTMLDivElement | null;
    const target = root?.querySelector<HTMLElement>(`[data-markdown-preview-block-start="${heading.startLine}"]`);
    if (!scroller || !target) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const stickyHeader = root?.querySelector<HTMLElement>('[data-markdown-heading-sticky]');
    const stickyHeaderHeight = stickyHeader?.getBoundingClientRect().height ?? 0;
    const targetTop = targetRect.top - scrollerRect.top + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, targetTop - stickyHeaderHeight - 8), behavior: 'smooth' });
    setActiveHeadingLine(heading.startLine);
    onOutlineClose?.();
  }, [onOutlineClose]);

  const handleTablePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (isInteractiveTextTarget(event.target)) return;
    tableTapRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  }, []);

  const handleTablePointerUp = useCallback((
    event: React.PointerEvent<HTMLElement>,
    startLine: number,
    endLine: number,
  ) => {
    const start = tableTapRef.current;
    tableTapRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = Math.abs(event.clientX - start.startX);
    const dy = Math.abs(event.clientY - start.startY);
    if (dx > 8 || dy > 8) return;
    const target = event.target;
    if (isInteractiveTextTarget(target) || hasNativeTextSelection()) return;
    const range = resolveMarkdownRefRange(target, startLine, endLine);
    onLineRangeClick(event as unknown as MouseEvent<HTMLElement>, range.start, range.end);
  }, [onLineRangeClick]);

  const handleTablePointerCancel = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (tableTapRef.current?.pointerId === event.pointerId) tableTapRef.current = null;
  }, []);

  // Drag-to-select on the per-block selection rails. The anchor line comes
  // from whatever fine-grained target (data-md-ref-*) sits under the pointer;
  // blocks without one interpolate between their first/last source line by
  // vertical position, so dragging stays continuous across block boundaries.
  const resolveLineAtPoint = useCallback((x: number, y: number): number | null => {
    const root = previewRootRef.current;
    if (!root || typeof document.elementFromPoint !== 'function') return null;
    const hit = document.elementFromPoint(x, y);
    if (!(hit instanceof HTMLElement) || !root.contains(hit)) return null;
    const refTarget = hit.closest<HTMLElement>('[data-md-ref-start]');
    if (refTarget) {
      const line = Number(refTarget.dataset.mdRefStart);
      if (Number.isFinite(line) && line > 0) return line;
    }
    const blockNode = hit.closest<HTMLElement>('[data-markdown-preview-block-start]');
    if (!blockNode) return null;
    const startLine = Number(blockNode.dataset.markdownPreviewBlockStart);
    const block = blocks.find((item) => item.startLine === startLine);
    if (!block) return Number.isFinite(startLine) && startLine > 0 ? startLine : null;
    if (block.endLine <= block.startLine) return block.startLine;
    const rect = blockNode.getBoundingClientRect();
    const ratio = rect.height > 0 ? Math.min(1, Math.max(0, (y - rect.top) / rect.height)) : 0;
    return Math.round(block.startLine + ratio * (block.endLine - block.startLine));
  }, [blocks]);

  const handleRailPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!onLineRangeDrag) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // Nudge the probe point past the rail column and grid gap so the anchor
    // resolves to the fine-grained line next to the rail rather than the rail
    // itself (widest rail config: 0.875rem column + 0.5rem gap = 22px).
    const anchorLine = resolveLineAtPoint(event.clientX + 24, event.clientY);
    if (anchorLine == null) return;
    railDragRef.current = { pointerId: event.pointerId, anchorLine, moved: false };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom and older browsers may not support pointer capture; dragging
      // still works as long as the pointer stays over the rail.
    }
  }, [onLineRangeDrag, resolveLineAtPoint]);

  const handleRailPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = railDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !onLineRangeDrag) return;
    const currentLine = resolveLineAtPoint(event.clientX + 16, event.clientY);
    if (currentLine == null) return;
    if (!drag.moved && currentLine === drag.anchorLine) return;
    drag.moved = true;
    railDragSuppressClickRef.current = true;
    onLineRangeDrag(
      event as unknown as MouseEvent<HTMLElement>,
      Math.min(drag.anchorLine, currentLine),
      Math.max(drag.anchorLine, currentLine),
      'move',
    );
  }, [onLineRangeDrag, resolveLineAtPoint]);

  const handleRailPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = railDragRef.current;
    railDragRef.current = null;
    if (!drag || drag.pointerId !== event.pointerId || !onLineRangeDrag) return;
    if (!drag.moved) return; // plain click — the block click handler toggles the reference
    const currentLine = resolveLineAtPoint(event.clientX + 16, event.clientY) ?? drag.anchorLine;
    onLineRangeDrag(
      event as unknown as MouseEvent<HTMLElement>,
      Math.min(drag.anchorLine, currentLine),
      Math.max(drag.anchorLine, currentLine),
      'end',
    );
  }, [onLineRangeDrag, resolveLineAtPoint]);

  const handleRailPointerCancel = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (railDragRef.current?.pointerId === event.pointerId) railDragRef.current = null;
  }, []);

  const railDragHandlers = {
    onPointerDown: handleRailPointerDown,
    onPointerMove: handleRailPointerMove,
    onPointerUp: handleRailPointerUp,
    onPointerCancel: handleRailPointerCancel,
  };

  // A drag that selected a range ends with a click event bubbling to the
  // block/rail click handlers; swallow that one click so the freshly dragged
  // range isn't toggled away.
  const consumeRailDragClick = (): boolean => {
    if (!railDragSuppressClickRef.current) return false;
    railDragSuppressClickRef.current = false;
    return true;
  };

  if (blocks.length === 0) {
    return <div className="min-w-0 max-w-full px-4 py-4 text-sm leading-6 text-foreground"><p className="text-muted-foreground">{t('rightSidebar.emptyFile')}</p></div>;
  }

  return (
    <>
      <div ref={previewRootRef} className="relative min-w-0 max-w-full">
        {activeHeadingPath.length > 0 && (
          <div className="sticky top-0 z-10 border-b border-border/15 bg-surface px-2 py-1 shadow-sm sm:px-3" data-markdown-heading-sticky>
            <div className="flex min-w-0 items-center gap-2 overflow-hidden" title={activeHeadingPath.map((heading) => heading.text).join(' / ')}>
              <span className="h-4 w-0.5 shrink-0 rounded-full bg-primary/70" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold leading-5 text-foreground sm:text-[13px]" data-markdown-heading-current>
                {activeHeadingPath[activeHeadingPath.length - 1].text}
              </span>
              {headingOutline.length > 1 && (
                <button
                  ref={outlineToggleRef}
                  type="button"
                  onClick={() => {
                    if (outlineOpen) onOutlineClose?.();
                    else onOutlineOpen?.();
                  }}
                  className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition active:scale-95 ${outlineOpen ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
                  aria-expanded={outlineOpen}
                  aria-label={t('rightSidebar.markdownOutline')}
                  title={t('rightSidebar.markdownOutline')}
                >
                  <RiListTree size={12} />
                  <span>{t('rightSidebar.markdownOutlineShort')}</span>
                </button>
              )}
            </div>
          </div>
        )}
        {outlineOpen && (
          <>
            <div className="fixed inset-0 z-menu-backdrop bg-[rgb(var(--background-rgb)_/_0.18)] sm:hidden" onClick={onOutlineClose} />
            <div
              className="hidden fixed z-menu-panel w-80 max-w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border/20 bg-surface p-2 shadow-xl sm:block"
              style={outlineDesktopPos ? { top: `${outlineDesktopPos.top}px`, right: `${outlineDesktopPos.right}px` } : { top: -9999, right: -9999 }}
              data-markdown-heading-outline-desktop
            >
              <div className="max-h-72 overflow-auto pr-1">
                {headingOutline.map((heading) => {
                  const active = activeHeadingPath[activeHeadingPath.length - 1]?.startLine === heading.startLine;
                  return (
                    <button
                      key={`desktop-${heading.id}-${heading.startLine}`}
                      type="button"
                      onClick={() => jumpToHeading(heading)}
                      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition active:scale-[0.995] ${active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
                      style={{ paddingLeft: `${Math.min(heading.level - 1, 4) * 12 + 8}px` }}
                      title={heading.text}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-primary' : 'bg-border-strong/70'}`} aria-hidden="true" />
                      <span className="w-5 shrink-0 font-mono text-[9px] text-muted-foreground/70">H{heading.level}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px]">{heading.text}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div
              className="fixed inset-x-0 bottom-0 z-drawer-panel max-h-[min(74vh,34rem)] rounded-t-xl border border-border/20 bg-surface p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] shadow-[0_-18px_48px_var(--app-shadow-strong)] sm:hidden"
              data-markdown-heading-outline-mobile
            >
              <div className="mb-1 flex items-center justify-between gap-2 px-1.5 py-1 sm:hidden">
                <div className="text-[12px] font-semibold text-foreground">{t('rightSidebar.markdownOutlineShort')}</div>
                <button
                  type="button"
                  onClick={onOutlineClose}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
                  aria-label={t('rightSidebar.closeMarkdownOutline')}
                  title={t('common.close')}
                >
                  <RiCloseLine size={14} />
                </button>
              </div>
              <div className="max-h-[calc(min(74vh,34rem)-3.25rem-env(safe-area-inset-bottom,0px))] overflow-auto overscroll-contain pr-1 sm:max-h-72">
                {headingOutline.map((heading) => {
                  const active = activeHeadingPath[activeHeadingPath.length - 1]?.startLine === heading.startLine;
                  return (
                    <button
                      key={`${heading.id}-${heading.startLine}`}
                      type="button"
                      onClick={() => jumpToHeading(heading)}
                      className={`flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left transition active:scale-[0.995] ${active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
                      style={{ paddingLeft: `${Math.min(heading.level - 1, 4) * 12 + 8}px` }}
                      title={heading.text}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-primary' : 'bg-border-strong/70'}`} aria-hidden="true" />
                      <span className="w-5 shrink-0 font-mono text-[9px] text-muted-foreground/70">H{heading.level}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px]">{heading.text}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
        <div className="min-w-0 max-w-full space-y-1.5 overflow-x-hidden break-words px-1.5 py-3 text-[13px] leading-5 text-foreground sm:space-y-2 sm:px-2 sm:py-4 sm:text-sm sm:leading-6">
        <MarkdownMermaidOpenContext.Provider value={handleOpenMermaidLightbox}>
        {blocks.map((block) => {
          const intersects = Boolean(lineRange && block.startLine <= lineRange.end && block.endLine >= lineRange.start);
          const wholeSelected = Boolean(lineRange && lineRange.start <= block.startLine && lineRange.end >= block.endLine);
          // Fine-grained blocks highlight the exact referenced lines inside,
          // so the block-wide wash and full-height rail only appear when the
          // whole block is referenced. Blocks without inner targets light up
          // as a whole on any overlap.
          const blockSelected = block.kind === 'table' ? false : (block.fineGrained ? wholeSelected : intersects);
          const tableWholeSelected = Boolean(block.kind === 'table' && lineRange?.start === block.startLine && lineRange.end === block.endLine);
          // Segment of the selection rail matching the referenced lines, so a
          // partial selection lights only its own slice of the rail.
          let railSegment: ReactNode = null;
          if (block.kind !== 'table' && block.fineGrained && intersects && !wholeSelected && lineRange) {
            const lineCount = block.endLine - block.startLine + 1;
            const segmentStart = Math.max(lineRange.start, block.startLine);
            const segmentEnd = Math.min(lineRange.end, block.endLine);
            const segmentTop = (segmentStart - block.startLine) / lineCount;
            const segmentHeight = (segmentEnd - segmentStart + 1) / lineCount;
            railSegment = (
              <span
                aria-hidden="true"
                data-md-rail-segment
                className="absolute left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-primary transition sm:w-1"
                style={{
                  top: `calc(0.25rem + (100% - 0.5rem) * ${segmentTop})`,
                  height: `calc((100% - 0.5rem) * ${segmentHeight})`,
                }}
              />
            );
          }
          const renderedContent = typeof block.content === 'function' ? block.content(lineRange) : block.content;
          const lineLabel = block.startLine === block.endLine ? String(block.startLine) : `${block.startLine}-${block.endLine}`;
          const blockContent = (
            <>
              <span
                className={getReferenceSelectionRailShellClass(blockSelected)}
                aria-hidden="true"
                {...railDragHandlers}
              >
                <span className={getReferenceSelectionRailBarClass(blockSelected)} />
                {railSegment}
              </span>
              <div className="min-w-0" data-sidebar-selectable>{renderedContent}</div>
            </>
          );
          if (block.interactive === false) {
            return (
              <div
                key={block.key}
                data-markdown-preview-block-start={block.startLine}
                className={`group grid w-full grid-cols-[0.625rem_minmax(0,1fr)] gap-1.5 rounded-md py-0.5 pr-1.5 text-left outline-none transition sm:grid-cols-[0.875rem_minmax(0,1fr)] sm:gap-2 sm:pr-2 ${blockSelected ? 'bg-primary/10' : ''}`}
                title={`Line ${lineLabel}`}
                aria-label={`Line ${lineLabel}`}
              >
                {block.kind === 'table' ? (
                  <button
                    type="button"
                    className={getReferenceSelectionRailShellClass(tableWholeSelected, 'self')}
                    onClick={(event) => {
                      event.preventDefault();
                      if (consumeRailDragClick()) return;
                      onLineRangeClick(event as unknown as MouseEvent<HTMLElement>, block.startLine, block.endLine);
                    }}
                    title={`Reference table lines ${lineLabel}`}
                    aria-label={`Reference table lines ${lineLabel}`}
                    {...railDragHandlers}
                  >
                    <span className={getReferenceSelectionRailBarClass(tableWholeSelected, 'self')} />
                  </button>
                ) : (
                  <span
                    className={getReferenceSelectionRailShellClass(blockSelected, 'none')}
                    aria-hidden="true"
                    {...railDragHandlers}
                  >
                    <span className={getReferenceSelectionRailBarClass(blockSelected, 'none')} />
                    {railSegment}
                  </span>
                )}
                <div
                  className="min-w-0 cursor-text select-text"
                  data-sidebar-selectable
                  role="button"
                  tabIndex={0}
                  onPointerDown={handleTablePointerDown}
                  onPointerUp={(event) => handleTablePointerUp(event, block.startLine, block.endLine)}
                  onPointerCancel={handleTablePointerCancel}
                  onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onLineRangeClick(event as unknown as MouseEvent<HTMLElement>, block.startLine, block.endLine);
                  }}
                  title={`Reference line ${lineLabel}`}
                  aria-label={`Reference line ${lineLabel}`}
                >
                  {renderedContent}
                </div>
              </div>
            );
          }
          return (
            <div
              role="button"
              tabIndex={0}
              key={block.key}
              data-markdown-preview-block-start={block.startLine}
              onClick={(event) => {
                const target = event.target;
                if (isInteractiveTextTarget(target) || hasNativeTextSelection()) return;
                if (consumeRailDragClick()) return;
                const range = resolveMarkdownRefRange(target, block.startLine, block.endLine);
                onLineRangeClick(event, range.start, range.end);
              }}
              onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onLineRangeClick(event as unknown as MouseEvent<HTMLElement>, block.startLine, block.endLine);
              }}
              className={`group grid w-full cursor-pointer grid-cols-[0.625rem_minmax(0,1fr)] gap-1.5 rounded-md py-0.5 pr-1.5 text-left outline-none transition active:scale-[0.998] sm:grid-cols-[0.875rem_minmax(0,1fr)] sm:gap-2 sm:pr-2 ${blockSelected ? 'bg-primary/10' : 'hover:bg-[var(--surface-2)]'}`}
              title={`Reference line ${lineLabel}`}
              aria-label={`Reference line ${lineLabel}`}
            >
              {blockContent}
            </div>
          );
        })}
        </MarkdownMermaidOpenContext.Provider>
        </div>
      </div>
      {lightboxOpen && lightboxIndex !== null && lightboxImages[lightboxIndex] && (
        <MarkdownImageLightbox
          images={lightboxImages}
          index={lightboxIndex}
          onChange={setLightboxIndex}
          onClose={() => {
            setLightboxIndex(null);
            setMermaidLightboxImage(null);
            onLightboxClose?.();
          }}
        />
      )}
    </>
  );
}

interface GitPickerOption {
  value: string;
  label: string;
  meta?: string;
}

interface GitTargetPickerProps {
  label: string;
  value: string;
  options: GitPickerOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

interface FileTreeScrollEntry {
  top: number;
  updatedAt: number;
}

interface FilePreviewReadingStateEntry {
  top: number;
  left?: number;
  markdownTop?: number;
  lineRange?: { start: number; end: number } | null;
  updatedAt: number;
}

function GitTargetPicker({ label, value, options, placeholder, searchPlaceholder, emptyText, disabled, onChange }: GitTargetPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuRect, setMenuRect] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) return options;
    return options.filter((option) => `${option.label} ${option.meta ?? ''}`.toLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, options]);

  const current = options.find((option) => option.value === value);
  const commitQuery = () => {
    const next = query.trim();
    if (!next) return;
    onChange(next);
    setOpen(false);
    setQuery('');
  };
  const updateMenuRect = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) {
      return false;
    }
    const margin = 12;
    const width = Math.max(220, Math.min(rect.width, window.innerWidth - margin * 2));
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const openBelow = spaceBelow >= 180 || spaceBelow >= spaceAbove;
    const availableHeight = Math.max(96, (openBelow ? spaceBelow : spaceAbove) - 4);
    const maxHeight = Math.min(320, availableHeight);
    setMenuRect({
      left,
      top: openBelow ? rect.bottom + 4 : Math.max(margin, rect.top - maxHeight - 4),
      width,
      maxHeight,
    });
    return true;
  }, []);

  const openMenu = () => {
    updateMenuRect();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updateMenuRect();
      });
    };
    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
      setQuery('');
    };
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);
    document.addEventListener('pointerdown', closeOnPointerDown, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
      document.removeEventListener('pointerdown', closeOnPointerDown, true);
    };
  }, [open, updateMenuRect]);

  return (
    <div className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setQuery('');
          if (open) {
            setOpen(false);
            return;
          }
          openMenu();
        }}
        className="group flex w-full items-center justify-between gap-2 rounded-md border border-border/15 bg-surface-2 px-2.5 py-1.5 text-left transition hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="min-w-0">
          <span className="block text-[9px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
          <span className={`block truncate text-[12px] ${value ? 'text-foreground' : 'text-muted-foreground/70'}`}>
            {current?.label ?? (value || placeholder)}
          </span>
        </span>
        <RiChevronDown size={13} className={`shrink-0 text-muted-foreground transition group-hover:text-foreground ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && !disabled && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          className="fixed z-popover overflow-hidden rounded-lg border border-border/15 bg-surface shadow-lg"
          onClick={(event) => event.stopPropagation()}
          style={{
            left: menuRect?.left ?? 12,
            top: menuRect?.top ?? 12,
            width: menuRect?.width ?? 260,
            maxHeight: menuRect?.maxHeight ?? 320,
          }}
        >
          <div className="border-b border-border/10 p-1.5">
            <div className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1.5">
              <RiSearch size={12} className="shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setOpen(false);
                    setQuery('');
                    return;
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitQuery();
                  }
                }}
                onBlur={() => {
                  if (query.trim() && filteredOptions.length === 0) commitQuery();
                }}
                placeholder={searchPlaceholder}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </div>
          </div>
          <div className="overflow-y-auto p-1" style={{ maxHeight: Math.max(96, (menuRect?.maxHeight ?? 320) - 46) }}>
            {query.trim() && !options.some((option) => option.value === query.trim()) && (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={commitQuery}
                className="mb-1 flex w-full items-center justify-between gap-2 rounded-md bg-primary/10 px-2 py-1.5 text-left text-[12px] font-medium text-primary transition hover:bg-primary/15"
              >
                <span className="min-w-0 truncate">{query.trim()}</span>
                <span className="shrink-0 text-[10px] text-primary/75">{t('common.use')}</span>
              </button>
            )}
            {filteredOptions.length > 0 ? filteredOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  setQuery('');
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition hover:bg-surface-2 ${option.value === value ? 'bg-accent/10 text-accent' : 'text-foreground'}`}
              >
                <span className="min-w-0 truncate font-medium">{option.label}</span>
                {option.meta && <span className="shrink-0 text-[10px] text-muted-foreground">{option.meta}</span>}
              </button>
            )) : (
              <div className="px-2 py-2 text-[11px] text-muted-foreground">{emptyText}</div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

interface AuditPromptScopeRepoOption {
  root: string;
  label: string;
  branch?: string | null;
}

interface AuditPromptScopeButtonProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showScopePicker: boolean;
  selectedAll: boolean;
  repos: AuditPromptScopeRepoOption[];
  selectedRoots: string[];
  onToggleRepo: (repoRoot: string | null) => void;
  onGenerate: () => void;
  onSecondaryAction?: () => void;
  disabled?: boolean;
  generateDisabled?: boolean;
  secondaryDisabled?: boolean;
  inserted?: boolean;
  buttonLabel: string;
  insertedLabel: string;
  title: string;
  ariaLabel: string;
  scopeTitle: string;
  scopeLabel: string;
  allLabel: string;
  generateLabel: string;
  secondaryLabel?: string;
  secondaryTitle?: string;
  secondaryLoading?: boolean;
  loading?: boolean;
  error?: boolean;
  statusTitle?: string;
  extraContent?: ReactNode;
  renderRepoExtra?: (repo: AuditPromptScopeRepoOption) => ReactNode;
}

function AuditPromptScopeButton({
  open,
  onOpenChange,
  showScopePicker,
  selectedAll,
  repos,
  selectedRoots,
  onToggleRepo,
  onGenerate,
  onSecondaryAction,
  disabled,
  generateDisabled,
  secondaryDisabled,
  inserted,
  buttonLabel,
  insertedLabel,
  title,
  ariaLabel,
  scopeTitle,
  scopeLabel,
  allLabel,
  generateLabel,
  secondaryLabel,
  secondaryTitle,
  secondaryLoading,
  loading,
  error,
  statusTitle,
  extraContent,
  renderRepoExtra,
}: AuditPromptScopeButtonProps) {
  return (
    <div className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => {
          if (showScopePicker) onOpenChange(!open);
          else if (!generateDisabled) onGenerate();
        }}
        disabled={disabled}
        className={`relative inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-[11px] font-medium transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${
          error
            ? 'text-destructive hover:bg-destructive/5'
            : inserted
            ? 'bg-surface-elevated text-foreground'
            : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
        }`}
        aria-label={ariaLabel}
        title={statusTitle ?? (showScopePicker ? `${scopeTitle}: ${scopeLabel}` : title)}
      >
        {loading ? <RiLoader size={13} className="animate-spin" /> : <RiSparkles size={13} />}
        <span>{inserted ? insertedLabel : buttonLabel}</span>
        {showScopePicker && <RiChevronDown size={11} className={`shrink-0 transition ${open ? 'rotate-180' : ''}`} />}
        {error && <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-destructive" />}
      </button>
      {showScopePicker && open && (
        <div
          className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] px-3 py-6 backdrop-blur-sm animate-fade-in"
          onClick={() => onOpenChange(false)}
        >
          <div
            className="fixed left-1/2 top-1/2 z-modal-panel flex max-h-[min(82vh,36rem)] w-[calc(100vw-1.5rem)] max-w-[42rem] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border/20 bg-surface text-[11px] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-border/15 px-3 py-2">
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-foreground">{scopeTitle}</div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{scopeLabel}</div>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                aria-label="Close"
              >
                <RiCloseLine size={14} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {extraContent}
              <button
                type="button"
                onClick={() => onToggleRepo(null)}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left font-medium transition ${
                  selectedAll
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                }`}
              >
                <span className="truncate">{allLabel}</span>
                {selectedAll && <span className="text-[10px]">✓</span>}
              </button>
              {repos.map((repo) => {
                const selected = selectedRoots.includes(repo.root);
                return (
                  <div key={repo.root} className={`mt-1 rounded-md transition ${selected ? 'bg-primary/15 text-primary' : ''}`}>
                    <button
                      type="button"
                      onClick={() => onToggleRepo(repo.root)}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left font-medium transition ${
                        selected
                          ? 'text-primary'
                          : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                      }`}
                      title={repo.root}
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{repo.label}</span>
                        {repo.branch && <span className="block truncate text-[9px] opacity-70">{repo.branch}</span>}
                      </span>
                      {selected && <span className="text-[10px]">✓</span>}
                    </button>
                    {renderRepoExtra && (selectedAll || selected) && (
                      <div className="px-2 pb-2">
                        {renderRepoExtra(repo)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className={`grid grid-cols-1 gap-1.5 border-t border-border/15 p-2 ${onSecondaryAction && secondaryLabel ? 'sm:grid-cols-2' : ''}`}>
              {onSecondaryAction && secondaryLabel && (
                <button
                  type="button"
                  onClick={() => {
                    if (secondaryDisabled) return;
                    onOpenChange(false);
                    onSecondaryAction();
                  }}
                  disabled={secondaryDisabled}
                  className="flex h-7 w-full items-center justify-center gap-1 rounded-md bg-surface-2 px-2 text-[11px] font-semibold text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 active:scale-95"
                  title={secondaryTitle}
                >
                  {secondaryLoading ? <RiLoader size={12} className="animate-spin" /> : <RiGitCompare size={12} />}
                  {secondaryLabel}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (generateDisabled) return;
                  onOpenChange(false);
                  onGenerate();
                }}
                disabled={generateDisabled}
                className="flex h-7 w-full items-center justify-center gap-1 rounded-md bg-primary/15 px-2 text-[11px] font-semibold text-primary transition hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-50 active:scale-95"
                title={title}
              >
                <RiSparkles size={12} />
                {generateLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type FileTreeScrollCache = Record<string, FileTreeScrollEntry>;

function isFileTreeScrollCache(value: unknown): value is FileTreeScrollCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const maybeEntry = entry as Partial<FileTreeScrollEntry>;
    if (typeof maybeEntry.top !== 'number' || !Number.isFinite(maybeEntry.top)) return false;
    if (typeof maybeEntry.updatedAt !== 'number' || !Number.isFinite(maybeEntry.updatedAt)) return false;
  }
  return true;
}

function readFileTreeScrollCache(): FileTreeScrollCache {
  return readCache(FILE_TREE_SCROLL_STORAGE_KEY, isFileTreeScrollCache) ?? {};
}

function writeFileTreeScrollPosition(rootPath: string, top: number): void {
  const cache = readFileTreeScrollCache();
  const nextEntries = Object.entries({
    ...cache,
    [rootPath]: { top, updatedAt: Date.now() },
  })
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_FILE_TREE_SCROLL_ROOTS);
  writeCacheThrottled(FILE_TREE_SCROLL_STORAGE_KEY, Object.fromEntries(nextEntries), FILE_TREE_SCROLL_WRITE_MS);
}

type FilePreviewReadingStateCache = Record<string, FilePreviewReadingStateEntry>;

function isLineRange(value: unknown): value is { start: number; end: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const maybeRange = value as { start?: unknown; end?: unknown };
  return (
    typeof maybeRange.start === 'number' &&
    Number.isFinite(maybeRange.start) &&
    typeof maybeRange.end === 'number' &&
    Number.isFinite(maybeRange.end) &&
    maybeRange.start >= 1 &&
    maybeRange.end >= maybeRange.start
  );
}

function isFilePreviewReadingStateCache(value: unknown): value is FilePreviewReadingStateCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const maybeEntry = entry as Partial<FilePreviewReadingStateEntry>;
    if (typeof maybeEntry.top !== 'number' || !Number.isFinite(maybeEntry.top)) return false;
    if (maybeEntry.left !== undefined && (typeof maybeEntry.left !== 'number' || !Number.isFinite(maybeEntry.left))) return false;
    if (maybeEntry.markdownTop !== undefined && (typeof maybeEntry.markdownTop !== 'number' || !Number.isFinite(maybeEntry.markdownTop))) return false;
    if (maybeEntry.lineRange !== undefined && maybeEntry.lineRange !== null && !isLineRange(maybeEntry.lineRange)) return false;
    if (typeof maybeEntry.updatedAt !== 'number' || !Number.isFinite(maybeEntry.updatedAt)) return false;
  }
  return true;
}

function getFilePreviewReadingStateKey(rootPath: string | null, filePath: string | null): string | null {
  if (!filePath) return null;
  const absolutePath = rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
  return rootPath ? `${rootPath}::${absolutePath}` : absolutePath;
}

function readFilePreviewReadingStateCache(): FilePreviewReadingStateCache {
  return readCache(FILE_PREVIEW_READING_STATE_STORAGE_KEY, isFilePreviewReadingStateCache) ?? {};
}

function readFilePreviewReadingState(rootPath: string | null, filePath: string | null): FilePreviewReadingStateEntry | null {
  const key = getFilePreviewReadingStateKey(rootPath, filePath);
  return key ? (readFilePreviewReadingStateCache()[key] ?? null) : null;
}

function writeFilePreviewReadingState(rootPath: string | null, filePath: string | null, patch: Partial<FilePreviewReadingStateEntry>): void {
  const key = getFilePreviewReadingStateKey(rootPath, filePath);
  if (!key) return;
  const cache = readFilePreviewReadingStateCache();
  const current = cache[key] ?? { top: 0, left: 0, markdownTop: 0, lineRange: null, updatedAt: Date.now() };
  const nextEntries = Object.entries({
    ...cache,
    [key]: { ...current, ...patch, updatedAt: Date.now() },
  })
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_FILE_PREVIEW_READING_STATE_FILES);
  writeCacheThrottled(FILE_PREVIEW_READING_STATE_STORAGE_KEY, Object.fromEntries(nextEntries), FILE_PREVIEW_READING_STATE_WRITE_MS);
}

function Pane({ active, mounted = true, fallback = null, children }: { active: boolean; mounted?: boolean; fallback?: ReactNode; children: ReactNode | (() => ReactNode) }) {
  return (
    <div className={`h-full min-h-0 overflow-hidden bg-surface text-foreground ${active ? 'block' : 'hidden'}`} aria-hidden={!active}>
      {mounted ? (typeof children === 'function' ? children() : children) : fallback}
    </div>
  );
}

function GitChangesLoadingState({ slow }: { slow: boolean }) {
  const { t } = useI18n();
  return (
    <div className="mx-3 mt-3 overflow-hidden rounded-xl border border-border/15 bg-surface-2 px-4 py-8 text-center text-sm text-muted-foreground">
      <RiLoader size={20} className="mx-auto mb-2 animate-spin text-muted-foreground/80" />
      <div>{t('rightSidebar.loadingGitChanges')}</div>
      {slow && <div className="mt-1 text-xs text-muted-foreground/75">{t('rightSidebar.loadingGitChangesSlow')}</div>}
    </div>
  );
}

function GitChangesErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mx-3 mt-3 overflow-hidden rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-5 text-center text-sm text-destructive">
      <div className="font-medium">{t('rightSidebar.gitChangesLoadFailed')}</div>
      <div className="mt-1 break-words text-xs opacity-85">{message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-full bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive transition hover:bg-destructive/15 active:scale-95"
      >
        {t('rightSidebar.retryGitChanges')}
      </button>
    </div>
  );
}

function getRelativeDisplayPath(path: string, rootPath: string | null): { name: string; dir: string } {
  const relative = rootPath && path.startsWith(`${rootPath}/`) ? path.slice(rootPath.length + 1) : path;
  const parts = relative.split('/').filter(Boolean);
  return {
    name: parts.pop() || relative,
    dir: parts.join('/'),
  };
}

function getPathBasename(path: string | null): string {
  if (!path) return '';
  const normalized = path.replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized || '/';
}

function getParentPath(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\/+$/, '') || '/';
  if (normalized === '/') return null;
  const parent = normalized.slice(0, normalized.lastIndexOf('/')) || '/';
  return parent === normalized ? null : parent;
}

function getNextReferenceLineRange(
  current: LineRange | null,
  startLine: number,
  endLine: number,
): LineRange | null {
  const nextStart = Math.min(startLine, endLine);
  const nextEnd = Math.max(startLine, endLine);
  if (current?.start === nextStart && current.end === nextEnd) return null;
  if (current && current.start === current.end) {
    return {
      start: Math.min(current.start, nextStart),
      end: Math.max(current.end, nextEnd),
    };
  }
  return { start: nextStart, end: nextEnd };
}

export function getNextMarkdownPreviewLineRange(
  current: LineRange | null,
  startLine: number,
  endLine: number,
): LineRange | null {
  return getNextReferenceLineRange(current, startLine, endLine);
}

function getReferenceSelectionRailShellClass(selected: boolean, hover: 'group' | 'self' | 'none' = 'group'): string {
  const hoverClass = hover === 'group'
    ? 'group-hover:bg-[var(--surface-elevated)]'
    : hover === 'self' ? 'hover:bg-[var(--surface-elevated)]' : '';
  // touch-none: drags starting on a rail are line-range selections, so the
  // browser must not hijack the gesture for scrolling. relative: anchors the
  // partial-selection rail segment (data-md-rail-segment). Selected state is
  // a primary tint so it reads as "referenced", not as yet another gray.
  return `relative flex min-h-5 w-full touch-none select-none items-stretch justify-center rounded transition sm:min-h-6 ${selected ? 'bg-primary/20' : `bg-[var(--surface-2)] ${hoverClass}`}`;
}

function getReferenceSelectionRailBarClass(selected: boolean, hover: 'group' | 'self' | 'none' = 'group'): string {
  const hoverClass = hover === 'group'
    ? 'group-hover:bg-[var(--muted-foreground)]'
    : hover === 'self' ? 'hover:bg-[var(--muted-foreground)]' : '';
  return `my-1 w-0.5 rounded-full transition sm:w-1 ${selected ? 'bg-primary' : `bg-[var(--border-strong)] ${hoverClass}`}`;
}

function getReferenceFloatingButtonClass(isMobile: boolean, completed: boolean): string {
  const sizeClass = isMobile ? 'h-9 px-4 text-[12px]' : 'h-7 px-3 text-[11px]';
  const toneClass = completed
    ? 'bg-surface-elevated text-foreground ring-border-strong/40 hover:bg-surface-2'
    : 'bg-primary text-primary-foreground ring-primary/30 hover:bg-primary/90';
  // 局部刻度 z-30（面板内部悬浮钮铁律 < 40）：高于 sticky 表头(z-10)，
  // 但任何全屏浮层（lightbox / modal / drawer）打开时必然盖住它。
  // 曾经用 z-popover(200) → lightbox(110) 打开后按钮还浮在图上面。
  return `pointer-events-auto absolute z-30 inline-flex items-center gap-1 rounded-full font-semibold shadow-lg ring-1 transition active:scale-95 ${sizeClass} ${toneClass}`;
}

function toChangedFileMap(files: GitChangedFile[]): Map<string, GitChangedFile> {
  const map = new Map<string, GitChangedFile>();
  for (const file of files) {
    map.set(getChangedFileKey(file), file);
  }
  return map;
}

function mergeChangedFileMaps(current: Map<string, GitChangedFile>, files: GitChangedFile[]): Map<string, GitChangedFile> {
  const next = new Map(current);
  for (const file of files) {
    next.set(getChangedFileKey(file), file);
  }
  return next;
}

function countNestedChangedFiles(files: Iterable<GitChangedFile>, rootPath: string | null): number {
  let count = 0;
  for (const file of files) {
    const repoRoot = getChangedFileRepoRoot(file, rootPath);
    if (repoRoot && rootPath && repoRoot !== rootPath) count += 1;
  }
  return count;
}

function countStagedChangedFiles(files: GitChangedFile[]): number {
  return files.reduce((count, file) => count + (file.staged ? 1 : 0), 0);
}

function mergeRepoChangedFiles(current: GitChangedFile[], incoming: GitChangedFile[]): GitChangedFile[] {
  return Array.from(mergeChangedFileMaps(toChangedFileMap(current), incoming).values())
    .sort((a, b) => a.path.localeCompare(b.path));
}

function buildRepoFilterFromBundle(repo: GitRepositoryBundle, rootPath: string | null): GitRepositoryFilter | null {
  if (repo.files.length === 0) return null;
  const label = repo.relativeRoot === '.'
    ? getPathBasename(rootPath ?? repo.root) || repo.name || repo.root
    : (repo.relativeRoot || repo.name || getPathBasename(repo.root) || repo.root);
  return {
    root: repo.root,
    label,
    branch: repo.context?.branch ?? null,
    count: repo.files.length,
    staged: countStagedChangedFiles(repo.files),
  };
}

function buildRepoFiltersFromBundles(repositories: GitRepositoryBundle[], rootPath: string | null): GitRepositoryFilter[] {
  const rootLabel = getPathBasename(rootPath ?? '') || rootPath || '';
  return repositories
    .map((repo) => buildRepoFilterFromBundle(repo, rootPath))
    .filter((repo): repo is GitRepositoryFilter => Boolean(repo))
    .sort((a, b) => {
      if (rootLabel && a.label === rootLabel) return -1;
      if (rootLabel && b.label === rootLabel) return 1;
      return a.label.localeCompare(b.label);
    });
}

function getChangedFileRepoRoot(file: GitChangedFile, fallbackRoot: string | null): string | null {
  return file.repoRoot ?? fallbackRoot;
}

function getChangedFileKey(file: GitChangedFile): string {
  return `${file.repoRoot ?? ''}\u0000${file.path}`;
}

function getChangedFileSelectionPath(file: GitChangedFile): string {
  return file.absolutePath || file.path;
}

function getChangedFileBusyPath(file: GitChangedFile): string {
  return getChangedFileKey(file);
}

function getChangedFileRepoLabel(file: GitChangedFile): string {
  return file.repoRelativeRoot && file.repoRelativeRoot !== '.' ? file.repoRelativeRoot : (file.repoName ?? '');
}

function countStagedChanges(files: GitChangedFile[]): number {
  return files.reduce((count, file) => count + (file.staged ? 1 : 0), 0);
}

function summarizeChangedFiles(files: Iterable<GitChangedFile>) {
  const counts = { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, untracked: 0, conflicted: 0, staged: 0, other: 0 };
  for (const file of files) {
    if (file.status === 'added') counts.added += 1;
    else if (file.status === 'modified') counts.modified += 1;
    else if (file.status === 'deleted') counts.deleted += 1;
    else if (file.status === 'renamed') counts.renamed += 1;
    else if (file.status === 'copied') counts.copied += 1;
    else if (file.status === 'untracked') counts.untracked += 1;
    else if (file.status === 'conflicted') counts.conflicted += 1;
    else counts.other += 1;
    if (file.staged) counts.staged += 1;
  }
  return counts;
}

function buildGitBundleRequestSlotId(cwd: string | undefined): string {
  let hash = 0;
  const value = cwd ?? 'root';
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return `right-sidebar-git-bundle:${(hash >>> 0).toString(36)}`;
}

function formatGitCacheAge(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'just now';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function formatAuditTimestamp(timestamp: number | null | undefined, locale: string): string | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isGitBundleCancellation(bundle: GitBundleResponse): boolean {
  const error = bundle.error ?? bundle.context?.error ?? '';
  return error.includes('request was cancelled') || error.includes('IO_REQUEST_CANCELLED');
}

function isConfirmedNonGitContext(context: GitContext | null): boolean {
  return context?.available === false && context.code === 'NOT_GIT_REPOSITORY';
}

function hasNativeTextSelection(): boolean {
  if (typeof window === 'undefined') return false;
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

function isInteractiveTextTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('a, button, input, textarea, select, label, [contenteditable="true"]'));
}

// Resolve the source line range referenced by a click inside a Markdown
// preview block: the nearest element stamped with data-md-ref-start/end (a
// paragraph line, list item, quote line, code line, table row) wins, so
// references land on exactly what was tapped instead of the whole block.
function resolveMarkdownRefRange(
  target: EventTarget | null,
  fallbackStart: number,
  fallbackEnd: number,
): { start: number; end: number } {
  const refTarget = target instanceof HTMLElement ? target.closest<HTMLElement>('[data-md-ref-start]') : null;
  const start = Number(refTarget?.dataset.mdRefStart);
  const end = Number(refTarget?.dataset.mdRefEnd ?? refTarget?.dataset.mdRefStart);
  if (Number.isFinite(start) && start > 0 && Number.isFinite(end) && end > 0) {
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }
  return { start: fallbackStart, end: fallbackEnd };
}

function GitActionMenu({ actions, running, completed }: {
  actions: GitActionButton[];
  running: { action: GitActionKey; path?: string } | null;
  completed: { action: GitActionKey; path?: string } | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const activeAction = actions.find((action) => running?.action === action.key);
  const completedAction = actions.find((action) => completed?.action === action.key);
  if (actions.length === 0) return null;

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        disabled={actions.every((action) => action.disabled) && !running && !completed}
        className={`inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full transition active:scale-95 disabled:opacity-50 ${
          open
            ? 'bg-surface-elevated text-foreground'
            : completedAction
            ? 'bg-accent/10 text-accent'
            : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
        }`}
        title={activeAction?.label ?? completedAction?.label ?? t('rightSidebar.gitQuickActions')}
      >
        {activeAction ? <RiLoader size={13} className="animate-spin" /> : completedAction ? <span className="text-[12px] font-semibold">✓</span> : <RiMoreHorizontal size={14} />}
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+2px)] z-30 w-44 overflow-hidden rounded-xl border border-border/15 bg-surface/98 p-1 text-[12px] shadow-xl shadow-[0_18px_48px_var(--app-shadow-soft)] backdrop-blur animate-fade-in">
          {actions.map((action) => {
            const isRunning = running?.action === action.key;
            const isCompleted = completed?.action === action.key;
            return (
              <button
                key={action.key}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  action.onClick();
                  setOpen(false);
                }}
                disabled={action.disabled || Boolean(running)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium transition active:scale-[0.99] disabled:opacity-50 ${
                  isCompleted
                    ? 'bg-accent/10 text-accent'
                    : action.destructive
                    ? 'text-destructive hover:bg-destructive/10'
                    : 'text-foreground hover:bg-surface-2'
                }`}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {isRunning ? <RiLoader size={13} className="animate-spin" /> : isCompleted ? '✓' : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function canScrollVertically(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;
  return (overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight + 1;
}

function findDiffStreamScroller(target: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = target;
  while (current) {
    if (current.classList.contains('termdock-diff-stream-scroller') && canScrollVertically(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return target.closest<HTMLElement>('.termdock-diff-stream-scroller');
}

function isVisibleElement(element: HTMLElement): boolean {
  return element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== 'hidden';
}

function scrollDiffStreamItemIntoView(path: string): void {
  const escapedPath = CSS.escape(path);
  const selector = [
    `[data-diff-stream-item="${escapedPath}"]`,
    `[data-diff-selection-path="${escapedPath}"]`,
    `[data-diff-absolute-path="${escapedPath}"]`,
  ].join(',');
  const scrollers = Array.from(document.querySelectorAll<HTMLElement>('.termdock-diff-stream-scroller'));
  let target: HTMLElement | null = null;
  for (const scroller of scrollers) {
    if (!isVisibleElement(scroller)) continue;
    const candidate = scroller.querySelector<HTMLElement>(selector);
    if (candidate && isVisibleElement(candidate)) {
      target = candidate;
      break;
    }
  }
  target ??= Array.from(document.querySelectorAll<HTMLElement>(selector)).find(isVisibleElement) ?? null;
  if (!target) return;
  const scroller = findDiffStreamScroller(target);
  if (!scroller) {
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  const targetTop = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTo({ top: Math.max(0, targetTop), behavior: 'instant' });
}

function scrollDiffAnchorIntoView(anchor: ChangeWalkthroughAnchor): void {
  const escapedPath = CSS.escape(anchor.filePath);
  const sectionIndex = typeof anchor.sectionIndex === 'number' ? String(anchor.sectionIndex) : null;
  const hunkIndex = typeof anchor.hunkIndex === 'number' ? String(anchor.hunkIndex) : null;
  const sectionFingerprint = anchor.sectionFingerprint ? CSS.escape(anchor.sectionFingerprint) : null;
  const hunkFingerprint = anchor.hunkFingerprint ? CSS.escape(anchor.hunkFingerprint) : null;
  const selectors = [
    sectionIndex !== null && sectionFingerprint
      ? `[data-diff-section-audit="${escapedPath}"][data-diff-section-index="${sectionIndex}"][data-diff-section-fingerprint="${sectionFingerprint}"]`
      : null,
    sectionIndex !== null && sectionFingerprint
      ? `[data-diff-section-anchor="${escapedPath}"][data-diff-section-index="${sectionIndex}"][data-diff-section-fingerprint="${sectionFingerprint}"]`
      : null,
    sectionIndex !== null
      ? `[data-diff-section-audit="${escapedPath}"][data-diff-section-index="${sectionIndex}"]`
      : null,
    sectionIndex !== null
      ? `[data-diff-section-anchor="${escapedPath}"][data-diff-section-index="${sectionIndex}"]`
      : null,
    hunkIndex !== null && hunkFingerprint
      ? `[data-diff-hunk-anchor="${escapedPath}"][data-diff-hunk-index="${hunkIndex}"][data-diff-hunk-fingerprint="${hunkFingerprint}"]`
      : null,
    hunkIndex !== null
      ? `[data-diff-hunk-anchor="${escapedPath}"][data-diff-hunk-index="${hunkIndex}"]`
      : null,
    `[data-diff-file-path="${escapedPath}"]`,
  ].filter((selector): selector is string => Boolean(selector));
  const scrollers = Array.from(document.querySelectorAll<HTMLElement>('.termdock-diff-stream-scroller'));
  let target: HTMLElement | null = null;
  for (const scroller of scrollers) {
    if (!isVisibleElement(scroller)) continue;
    for (const selector of selectors) {
      const candidate = scroller.querySelector<HTMLElement>(selector);
      if (candidate && isVisibleElement(candidate)) {
        target = candidate;
        break;
      }
    }
    if (target) break;
  }
  target ??= selectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector))).find(isVisibleElement) ?? null;
  if (!target) {
    scrollDiffStreamItemIntoView(anchor.filePath);
    return;
  }
  const scroller = findDiffStreamScroller(target);
  if (!scroller) {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const targetTop = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTo({ top: Math.max(0, targetTop - 48), behavior: 'instant' });
  target.animate?.([
    { boxShadow: '0 0 0 0 rgba(var(--primary-rgb), 0)' },
    { boxShadow: '0 0 0 3px rgba(var(--primary-rgb), 0.35)' },
    { boxShadow: '0 0 0 0 rgba(var(--primary-rgb), 0)' },
  ], { duration: 900, easing: 'ease-out' });
}

const IMAGE_MIN_SCALE = 1;
const IMAGE_MAX_SCALE = 8;

function clampImageScale(scale: number): number {
  return Math.min(IMAGE_MAX_SCALE, Math.max(IMAGE_MIN_SCALE, scale));
}

interface ZoomableImageProps {
  src: string;
  alt: string;
  /** Content is a vector image (SVG) — allows upscaling to fit the stage. */
  vector?: boolean;
  onLoad: (event: React.SyntheticEvent<HTMLImageElement>) => void;
  onError: () => void;
  onZoomChange?: (zoomed: boolean) => void;
  onDoubleTap?: () => void;
}

interface ZoomableViewportProps {
  resetKey: string;
  onZoomChange?: (zoomed: boolean) => void;
  onDoubleTap?: () => void;
  children: (state: {
    transformStyle: CSSProperties;
    vectorTransformStyle: CSSProperties;
    scale: number;
    zoomed: boolean;
    animateTransform: boolean;
  }) => ReactNode;
}

// Pinch-to-zoom viewer. Supports touch pinch (mobile), trackpad pinch,
// ctrl/⌘ + wheel (desktop), two-axis trackpad panning while zoomed, and
// double-tap / double-click to toggle zoom. The container carries
// `data-sidebar-gesture-ignore` only while zoomed, so pans of enlarged content
// are never hijacked — while an unzoomed horizontal swipe still flows to the
// sidebar's gesture arbiter (e.g. swiper back-navigation).
function ZoomableViewport({ resetKey, onZoomChange, onDoubleTap, children }: ZoomableViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [animateTransform, setAnimateTransform] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const activePointersRef = useRef<Set<number>>(new Set());
  const sequenceWasMultiRef = useRef(false);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const manualDoubleTapAtRef = useRef(0);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Reset when the active content changes (a new file/diagram was selected).
  useEffect(() => {
    setTransform({ scale: 1, x: 0, y: 0 });
  }, [resetKey]);

  // Clamp the pan offset so the (scaled) content can't be dragged completely
  // out of the viewport. Uses the content element's real layout size — with
  // fit-to-stage sizing the content no longer necessarily matches the
  // viewport, and oversized content allows proportionally more pan.
  const clampOffset = useCallback((scale: number, x: number, y: number) => {
    const el = containerRef.current;
    if (!el) return { x, y };
    const content = el.firstElementChild instanceof HTMLElement ? el.firstElementChild : null;
    const contentWidth = content?.clientWidth || el.clientWidth;
    const contentHeight = content?.clientHeight || el.clientHeight;
    const maxX = Math.max(0, (contentWidth * scale - el.clientWidth) / 2);
    const maxY = Math.max(0, (contentHeight * scale - el.clientHeight) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    };
  }, []);

  const applyZoom = useCallback((nextScale: number, originX?: number, originY?: number) => {
    setTransform((prev) => {
      const scale = clampImageScale(nextScale);
      const el = containerRef.current;
      if (!el || scale === 1) {
        return { scale, x: 0, y: 0 };
      }
      // Zoom toward the pointer/pinch focal point so the pixel under the cursor
      // stays put. Falls back to the center when no origin is provided.
      const rect = el.getBoundingClientRect();
      const focalX = (originX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
      const focalY = (originY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
      const ratio = scale / prev.scale;
      const x = focalX - (focalX - prev.x) * ratio;
      const y = focalY - (focalY - prev.y) * ratio;
      return { scale, ...clampOffset(scale, x, y) };
    });
  }, [clampOffset]);

  const toggleZoom = useCallback((originX?: number, originY?: number) => {
    setAnimateTransform(true);
    if (transformRef.current.scale > 1) {
      setTransform({ scale: 1, x: 0, y: 0 });
    } else {
      applyZoom(2.5, originX, originY);
    }
    window.setTimeout(() => setAnimateTransform(false), 220);
  }, [applyZoom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // NOTE: no stopPropagation on pointerdown/move except for the ACTIVE
    // single-finger pan. The pinch listener (use-gesture, below) attaches in
    // the bubble phase on this same element, and a capture-phase
    // stopPropagation starves it — that used to kill pinch-to-zoom entirely
    // whenever the touch landed on the image itself.
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const isFirstPointer = activePointersRef.current.size === 0;
      activePointersRef.current.add(event.pointerId);

      // Manual double-tap detection instead of relying on dblclick: a second
      // tap within 350ms / 24px toggles zoom and vetoes the lightbox's
      // tap-to-close (whose timer would otherwise win the race on touch).
      if (isFirstPointer) {
        const now = Date.now();
        const last = lastTapRef.current;
        if (last && now - last.time < 350 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 24) {
          lastTapRef.current = null;
          manualDoubleTapAtRef.current = now;
          onDoubleTap?.();
          toggleZoom(event.clientX, event.clientY);
          return;
        }
      }

      // A second finger ends any single-finger pan — the pinch gesture owns
      // the sequence from here.
      if (activePointersRef.current.size > 1) {
        sequenceWasMultiRef.current = true;
        dragRef.current = null;
        return;
      }

      if (transformRef.current.scale <= 1) return;
      event.preventDefault();
      // Pending pan: only engages once the finger moves past the tap
      // threshold — otherwise the pointer-up counts as a tap (and can form a
      // double-tap to zoom back out).
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: transformRef.current.x,
        originY: transformRef.current.y,
        moved: false,
      };
      try {
        el.setPointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture can fail for synthetic or already-captured pointers;
        // window-level move/up listeners still keep panning functional.
      }
      setAnimateTransform(false);
    };

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
      }
      // Only the ACTIVE pan swallows the event — pinch pointers must keep
      // flowing to the gesture listeners.
      event.stopPropagation();
      event.preventDefault();
      setTransform((prev) => ({
        ...prev,
        ...clampOffset(prev.scale, drag.originX + dx, drag.originY + dy),
      }));
    };

    const handlePointerEnd = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      const wasPanPointer = drag?.pointerId === event.pointerId && drag.moved;
      if (drag?.pointerId === event.pointerId) {
        if (drag.moved) event.stopPropagation();
        dragRef.current = null;
        try {
          el.releasePointerCapture?.(event.pointerId);
        } catch {
          // Best effort only; a missing capture should not break pan cleanup.
        }
      }
      if (!activePointersRef.current.delete(event.pointerId)) return;
      if (activePointersRef.current.size === 0) {
        // A completed single-pointer, non-pan sequence is a tap candidate for
        // double-tap detection. Pinch and pan sequences are not.
        if (!sequenceWasMultiRef.current && !wasPanPointer) {
          lastTapRef.current = { time: Date.now(), x: event.clientX, y: event.clientY };
        }
        sequenceWasMultiRef.current = false;
      }
    };

    el.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: false });
    window.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
    window.addEventListener('pointerup', handlePointerEnd, { capture: true });
    window.addEventListener('pointercancel', handlePointerEnd, { capture: true });
    return () => {
      el.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      window.removeEventListener('pointermove', handlePointerMove, { capture: true });
      window.removeEventListener('pointerup', handlePointerEnd, { capture: true });
      window.removeEventListener('pointercancel', handlePointerEnd, { capture: true });
    };
  }, [clampOffset, onDoubleTap, toggleZoom]);

  useGesture(
    {
      onPinch: ({ offset: [scale], origin: [ox, oy] }) => {
        setAnimateTransform(false);
        applyZoom(scale, ox, oy);
      },
      onWheel: ({ event, delta: [dx, dy], ctrlKey }) => {
        // Trackpad pinch surfaces as a wheel event with ctrlKey on most
        // browsers. Once zoomed, an unmodified two-finger gesture should move
        // the image like a native canvas in both axes. Keeping each incoming
        // wheel delta intact also preserves the trackpad's OS-level momentum.
        if (ctrlKey) {
          event.preventDefault();
          event.stopPropagation();
          setAnimateTransform(false);
          applyZoom(transformRef.current.scale * (1 - dy * 0.01), event.clientX, event.clientY);
          return;
        }
        if (transformRef.current.scale <= 1) return;
        event.preventDefault();
        event.stopPropagation();
        setAnimateTransform(false);
        setTransform((prev) => ({
          ...prev,
          ...clampOffset(prev.scale, prev.x - dx, prev.y - dy),
        }));
      },
    },
    {
      target: containerRef,
      eventOptions: { passive: false },
      pinch: {
        scaleBounds: { min: IMAGE_MIN_SCALE, max: IMAGE_MAX_SCALE },
        from: () => [transformRef.current.scale, 0],
        rubberband: true,
      },
    },
  );

  const zoomed = transform.scale > 1;

  useEffect(() => {
    onZoomChange?.(zoomed);
  }, [onZoomChange, zoomed]);

  return (
    <div
      ref={containerRef}
      data-sidebar-gesture-ignore={zoomed ? '' : undefined}
      className="flex h-full w-full touch-none select-none items-center justify-center overflow-hidden"
      style={{ cursor: zoomed ? 'grab' : 'zoom-in' }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        // The pointer-level double-tap detection already toggled zoom for
        // this sequence — don't let the trailing dblclick toggle it back.
        if (Date.now() - manualDoubleTapAtRef.current < 500) return;
        onDoubleTap?.();
        toggleZoom(event.clientX, event.clientY);
      }}
    >
      {children({
        scale: transform.scale,
        zoomed,
        animateTransform,
        transformStyle: {
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          transformOrigin: 'center center',
          transition: animateTransform ? 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
          willChange: 'transform',
        },
        // Scaling an SVG's composited layer makes WebKit/Chromium reuse the
        // rasterization created at scale=1. Vector viewers instead use this
        // translation-only style and grow the SVG's layout box, which forces
        // a fresh vector paint at every zoom level.
        vectorTransformStyle: {
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
          transformOrigin: 'center center',
          transition: animateTransform ? 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
        },
      })}
    </div>
  );
}

// Lightbox/preview image with fit-to-stage initial sizing. Previously images
// rendered at their intrinsic size capped by the stage, so a 100×100 SVG
// showed up as a postage stamp in a full-size viewer and pinch-zooming it
// felt broken. Now the initial size fits the stage: SVGs (vector, upscale
// cleanly) fit in both directions; raster images only shrink (upscaling
// would blur).
function ZoomableImage({ src, alt, vector, onLoad, onError, onZoomChange, onDoubleTap }: ZoomableImageProps) {
  const [fitSize, setFitSize] = useState<{ width: number; height: number } | null>(null);
  // blob: object URLs carry no extension, so callers with a known MIME type
  // pass `vector` explicitly; otherwise fall back to the URL's .svg suffix.
  const isVector = vector ?? isSvgImageSrc(src);

  useEffect(() => {
    setFitSize(null);
  }, [src]);

  return (
    <ZoomableViewport resetKey={src} onZoomChange={onZoomChange} onDoubleTap={onDoubleTap}>
      {({ transformStyle, vectorTransformStyle, scale, animateTransform }) => {
        const image = (
          <img
            src={src}
            alt={alt}
            draggable={false}
            className="max-h-full max-w-full touch-none select-none rounded border border-border/15 bg-surface object-contain shadow-sm"
            style={isVector && fitSize
              ? {
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: fitSize.width * scale,
                  height: fitSize.height * scale,
                  maxWidth: 'none',
                  maxHeight: 'none',
                  transform: 'translate3d(-50%, -50%, 0)',
                  transition: animateTransform ? 'width 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), height 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
                }
              : fitSize
                ? { ...transformStyle, width: fitSize.width, height: fitSize.height }
                : isVector
                  ? vectorTransformStyle
                  : transformStyle}
            onLoad={(event) => {
              const img = event.currentTarget;
              const container = img.parentElement;
              if (container && img.naturalWidth > 0 && img.naturalHeight > 0) {
                const availableWidth = Math.max(1, container.clientWidth - 2);
                const availableHeight = Math.max(1, container.clientHeight - 2);
                const fitScale = Math.min(availableWidth / img.naturalWidth, availableHeight / img.naturalHeight);
                const nextScale = isVector ? fitScale : Math.min(fitScale, 1);
                setFitSize({
                  width: Math.max(1, Math.round(img.naturalWidth * nextScale)),
                  height: Math.max(1, Math.round(img.naturalHeight * nextScale)),
                });
              }
              onLoad(event);
            }}
            onError={onError}
          />
        );

        if (!isVector || !fitSize) return image;
        return (
          <div
            data-vector-zoom-surface
            className="relative shrink-0 touch-none select-none"
            style={{ ...vectorTransformStyle, width: fitSize.width, height: fitSize.height }}
          >
            {image}
          </div>
        );
      }}
    </ZoomableViewport>
  );
}

function ZoomableMermaidContent({
  svg,
  title,
  scale,
  vectorTransformStyle,
}: {
  svg: string;
  title: string;
  scale: number;
  vectorTransformStyle: CSSProperties;
}) {
  const diagramRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const root = diagramRef.current;
    const svgNode = root?.querySelector<SVGSVGElement>('svg');
    if (!root || !svgNode) return;

    const fitSvg = () => {
      const viewBox = svgNode.getAttribute('viewBox');
      const values = viewBox?.trim().split(/[\s,]+/).map(Number) ?? [];
      let width = values[2];
      let height = values[3];
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        width = Number(svgNode.getAttribute('width'));
        height = Number(svgNode.getAttribute('height'));
      }
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

      const availableWidth = Math.max(1, root.clientWidth - 24);
      const availableHeight = Math.max(1, root.clientHeight - 24);
      const fitScale = Math.min(availableWidth / width, availableHeight / height, 1);
      svgNode.style.width = `${Math.max(1, Math.floor(width * fitScale * scale))}px`;
      svgNode.style.height = `${Math.max(1, Math.floor(height * fitScale * scale))}px`;
      svgNode.style.maxWidth = 'none';
      svgNode.style.maxHeight = 'none';
      svgNode.style.transform = String(vectorTransformStyle.transform ?? '');
      svgNode.style.transformOrigin = 'center center';
      svgNode.style.transition = String(vectorTransformStyle.transition ?? 'none');
    };

    fitSvg();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitSvg);
    observer?.observe(root);
    return () => observer?.disconnect();
  }, [scale, svg, vectorTransformStyle]);

  return (
    <div
      ref={diagramRef}
      role="img"
      aria-label={title}
      className="flex h-full w-full touch-none select-none items-center justify-center overflow-hidden rounded border border-border/15 bg-white p-3 text-slate-900 shadow-sm [&_svg]:block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function ZoomableMermaidDiagram({ svg, title, onZoomChange, onDoubleTap }: {
  svg: string;
  title: string;
  onZoomChange?: (zoomed: boolean) => void;
  onDoubleTap?: () => void;
}) {
  return (
    <ZoomableViewport resetKey={svg} onZoomChange={onZoomChange} onDoubleTap={onDoubleTap}>
      {({ vectorTransformStyle, scale }) => (
        <ZoomableMermaidContent
          svg={svg}
          title={title}
          scale={scale}
          vectorTransformStyle={vectorTransformStyle}
        />
      )}
    </ZoomableViewport>
  );
}

interface FilePreviewProps {
  filePath: string | null;
  onInsertReference: (path: string, key?: string) => void;
  onInsertText: (text: string, key: string) => void;
  /** Insert a model-feature reference (draft-aware, same as file refs). */
  onInsertFeature?: (text: string, key: string) => void;
  onReferenceCopied: (key: string) => void;
  onClose?: () => void;
  isMobile: boolean;
  markdownOutlineOpen: boolean;
  markdownOutlineCloseSignal?: number;
  onOpenMarkdownOutline?: () => void;
  onCloseMarkdownOutline?: () => void;
  markdownImageLightboxOpen: boolean;
  markdownImageLightboxCloseSignal?: number;
  onOpenMarkdownImageLightbox?: () => void;
  onCloseMarkdownImageLightbox?: () => void;
  lineRange: { start: number; end: number } | null;
  onLineRangeChange: Dispatch<SetStateAction<{ start: number; end: number } | null>>;
  insertedReferenceKey: string | null;
  copiedReferenceKey: string | null;
  scrollToLine?: number | null;
  onScrollToLineHandled?: () => void;
}

type FilePreviewState =
  | { kind: 'idle' }
  | { kind: 'loading'; mode: 'text' | 'image' | 'model3d' }
  | { kind: 'text'; content: string; meta: { size: number; truncated?: boolean } }
  | { kind: 'image'; objectUrl: string; meta: { size: number | null; mimeType: string; modified: string | null }; dimensions?: { width: number; height: number } }
  | { kind: 'model3d'; objectUrl: string; ext: string; meta: { size: number | null; mimeType: string; modified: string | null } }
  | { kind: 'binary' }
  | { kind: 'error'; message: string };

let filePreviewLoadingSeq = 0;
let gitBundleLogSeq = 0;
let diffInteractionLogSeq = 0;
let diffInteractionIdSeq = 0;

function logFilePreviewLoadingEvent(event: string, data: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({
    level: event === 'still_active' ? 'warn' : 'info',
    message: `FILE_PREVIEW_LOADING ${event}`,
    data: {
      ts: Date.now(),
      ...data,
    },
  });
  void fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => undefined);
}

function logGitBundleClientEvent(event: string, data: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({
    level: event === 'error' || event === 'empty_bundle' ? 'warn' : 'info',
    message: `GIT_BUNDLE ${event}`,
    data: {
      seq: ++gitBundleLogSeq,
      ts: Date.now(),
      ...data,
    },
  });
  void fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => undefined);
}

function logDiffInteractionEvent(event: string, data: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({
    level: 'info',
    message: `DIFF_INTERACTION ${event}`,
    data: {
      seq: ++diffInteractionLogSeq,
      ts: Date.now(),
      ...data,
    },
  });
  void fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => undefined);
}

function createDiffInteractionId(): string {
  return `diff-ui-${Date.now().toString(36)}-${(++diffInteractionIdSeq).toString(36)}`;
}

function getDiffRowElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('[data-diff-selection-path]') : null;
}

function getNativePointerLogData(event: globalThis.PointerEvent | globalThis.MouseEvent): Record<string, unknown> {
  const target = event.target instanceof HTMLElement ? event.target : null;
  return {
    eventType: event.type,
    button: event.button,
    pointerType: event instanceof globalThis.PointerEvent ? event.pointerType : undefined,
    targetTag: target?.tagName,
    targetClass: target?.className,
    targetText: target?.textContent?.slice(0, 80),
  };
}

export function FilePreview({
  filePath,
  onInsertReference,
  onInsertText,
  onInsertFeature,
  onReferenceCopied,
  onClose,
  isMobile,
  markdownOutlineOpen,
  markdownOutlineCloseSignal,
  onOpenMarkdownOutline,
  onCloseMarkdownOutline,
  markdownImageLightboxOpen,
  markdownImageLightboxCloseSignal,
  onOpenMarkdownImageLightbox,
  onCloseMarkdownImageLightbox,
  lineRange,
  onLineRangeChange,
  insertedReferenceKey,
  copiedReferenceKey,
  scrollToLine,
  onScrollToLineHandled,
}: FilePreviewProps) {
  const { t } = useI18n();
  const rootPath = useSidebarStore((s) => s.rootPath);
  const [previewState, setPreviewState] = useState<FilePreviewState>({ kind: 'idle' });
  const [modelFeatures, setModelFeatures] = useState<ModelFeature[] | null>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Floating "引用" button position relative to the scroller. Mouse clicks set
  // this near the cursor; non-pointer jumps fall back to the selected line.
  const [floatingInsertPos, setFloatingInsertPos] = useState<{ top: number; left: number } | null>(null);
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownViewMode>(() => readMarkdownViewMode());
  const [refractor, setRefractor] = useState<RefractorLike | null>(null);
  const [markdownPreviewScrollTop, setMarkdownPreviewScrollTop] = useState(0);
  // Per-line highlighted React nodes, keyed implicitly by the current text
  // content. `null` means "render plain text" (unknown language, too large, or
  // refractor not loaded yet).
  const [highlightedLines, setHighlightedLines] = useState<ReactNode[][] | null>(null);
  const [downloadState, setDownloadState] = useState<{ status: 'idle' | 'pending' | 'error'; message?: string }>({ status: 'idle' });
  const getReferenceLongPressHandlers = useReferenceLongPressCopy(onReferenceCopied);

  const readingStateKey = getFilePreviewReadingStateKey(rootPath, filePath);

  // 把仓库相对路径解析成绝对路径，用作 watcher / version map 的查询 key。
  const versionedPath = filePath
    ? (rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath)
    : null;

  // watcher 在 store 里维护「每个绝对路径的变更版本号 + 全局 epoch」。当前
  // 预览路径对应的版本变化时（外部 created/updated/deleted），或 epoch
  // 变化时（rescan 降级 / watch 重连 / 手动刷新），自动触发重新加载。
  // 文件管理器是纯查看场景，没有"覆盖用户编辑"的冲突顾虑，所以直接静默刷新。
  const externalVersion = useSidebarStore((s) => (
    versionedPath ? (s.fileChangeVersions.get(versionedPath) ?? 0) + s.fileWatchEpoch : s.fileWatchEpoch
  ));

  // 用于区分"切到新文件"和"同一个文件外部变更"。前者要重置 UI（loading 占位、
  // 清行选区、重置 markdown 视图模式），后者保留滚动位置与用户选择。
  const lastFullPathRef = useRef<string | null>(null);
  const restoredReadingStateKeyRef = useRef<string | null>(null);

  // 手动刷新 nonce:移动端 SSE 挂起后 watch 可能不会重连,预览界面提供
  // 刷新按钮兜底,nonce 变化与外部变更走同一条重新加载路径(不重置 UI)。
  const [manualRefreshNonce, setManualRefreshNonce] = useState(0);
  const refreshPreview = useCallback(() => setManualRefreshNonce((n) => n + 1), []);

  useEffect(() => {
    if (!filePath) {
      lastFullPathRef.current = null;
      setPreviewState({ kind: 'idle' });
      return;
    }

    const fullPath = rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
    const controller = new AbortController();
    const loadingId = ++filePreviewLoadingSeq;
    const requestSlotId = `right-sidebar-file-preview:${loadingId}`;
    const startedAt = performance.now();
    let loadingEnded = false;
    const endLoading = (reason: string, extra: Record<string, unknown> = {}) => {
      if (loadingEnded) return;
      loadingEnded = true;
      logFilePreviewLoadingEvent('end', {
        loadingId,
        reason,
        durationMs: Math.round(performance.now() - startedAt),
        filePath,
        fullPath,
        rootPath,
        ...extra,
      });
    };
    let objectUrl: string | null = null;
    const isImage = isPreviewableImagePath(fullPath);
    const isModel3d = !isImage && isPreviewableModel3dPath(fullPath);
    const isMarkdown = isMarkdownPath(fullPath);
    const previewMode = isImage ? 'image' : isModel3d ? 'model3d' : 'text';
    const isPathChange = lastFullPathRef.current !== fullPath;
    lastFullPathRef.current = fullPath;

    if (isPathChange) {
      logFilePreviewLoadingEvent('start', { loadingId, filePath, fullPath, rootPath, mode: previewMode, externalVersion });
      setDownloadState({ status: 'idle' });
      setPreviewState({ kind: 'loading', mode: previewMode });
      restoredReadingStateKeyRef.current = null;
      const savedReadingState = readFilePreviewReadingState(rootPath, filePath);
      onLineRangeChange(savedReadingState?.lineRange ?? null);
      setMarkdownViewMode(isMarkdown ? readMarkdownViewMode() : 'source');
    }
    const watchdog = window.setTimeout(() => {
      if (loadingEnded || controller.signal.aborted) return;
      logFilePreviewLoadingEvent('still_active', {
        loadingId,
        filePath,
        fullPath,
        rootPath,
        mode: previewMode,
        durationMs: Math.round(performance.now() - startedAt),
        isPathChange,
      });
    }, 3_000);
    const stuckTimer = window.setTimeout(() => {
      if (loadingEnded || controller.signal.aborted) return;
      const message = 'File preview is still waiting on disk I/O. Try the file again or refresh the directory.';
      controller.abort(new DOMException(message, 'TimeoutError'));
      setPreviewState({ kind: 'error', message });
      endLoading('stuck_timeout', { error: message });
    }, FILE_PREVIEW_STUCK_TIMEOUT_MS);

    if (isImage) {
      readImagePreviewBlob(fullPath, controller.signal, 'view_file', requestSlotId)
        .then((result) => {
          objectUrl = URL.createObjectURL(result.blob);
          setPreviewState({
            kind: 'image',
            objectUrl,
            meta: { size: result.size, mimeType: result.mimeType, modified: result.modified },
          });
          endLoading('image_loaded', { bytes: result.size, mimeType: result.mimeType });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setPreviewState({ kind: 'error', message: err instanceof Error ? err.message : t('rightSidebar.imageLoadFailed') });
          endLoading('error', { error: err instanceof Error ? err.message : String(err) });
        });
    } else if (isModel3d) {
      readModel3dBlob(fullPath, controller.signal, 'view_file', requestSlotId)
        .then((result) => {
          objectUrl = URL.createObjectURL(result.blob);
          setPreviewState({
            kind: 'model3d',
            objectUrl,
            ext: result.ext,
            meta: { size: result.size, mimeType: result.mimeType, modified: result.modified },
          });
          endLoading('model3d_loaded', { bytes: result.size, ext: result.ext });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setPreviewState({ kind: 'error', message: err instanceof Error ? err.message : t('rightSidebar.model3dLoadFailed') });
          endLoading('error', { error: err instanceof Error ? err.message : String(err) });
        });
    } else {
      readFileContent(fullPath, controller.signal, 'view_file', requestSlotId)
        .then((result) => {
          if (result.binary) {
            setPreviewState({ kind: 'binary' });
            return;
          }
          setPreviewState({ kind: 'text', content: result.content, meta: { size: result.size, truncated: result.truncated } });
          endLoading('text_loaded', { bytes: result.size, truncated: Boolean(result.truncated) });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setPreviewState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to read file' });
          endLoading('error', { error: err instanceof Error ? err.message : String(err) });
        });
    }

    return () => {
      controller.abort();
      cancelIoSlot(requestSlotId);
      window.clearTimeout(watchdog);
      window.clearTimeout(stuckTimer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      endLoading('cleanup');
    };
  }, [filePath, rootPath, externalVersion, manualRefreshNonce, onLineRangeChange, t]);

  // 语义特征 sidecar: 约定放 <模型目录>/features/<名>.json
  useEffect(() => {
    if (previewState.kind !== 'model3d' || !filePath) {
      setModelFeatures(null);
      return;
    }
    let cancelled = false;
    // 例: 3d-parts/x/glb/assembly.glb → 3d-parts/x/features/assembly.json
    const slash = filePath.lastIndexOf('/');
    const fileName = slash >= 0 ? filePath.slice(slash + 1) : filePath;
    const dir = slash >= 0 ? filePath.slice(0, slash) : '';
    const parentSlash = dir.lastIndexOf('/');
    const modelRoot = parentSlash >= 0 ? dir.slice(0, parentSlash) : '';
    const stem = fileName.replace(/\.(stl|glb|gltf)$/i, '');
    const sidecarPath = `${modelRoot ? `${modelRoot}/` : ''}features/${stem}.json`;
    readFileContent(sidecarPath)
      .then((result) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(result.content) as {
            version?: number;
            features?: ModelFeature[];
          };
          // 契约版本校验(见 docs/model-features.schema.json): 只认 version 1
          setModelFeatures(
            data.version === 1 && Array.isArray(data.features) && data.features.length > 0
              ? data.features
              : null,
          );
        } catch {
          setModelFeatures(null);
        }
      })
      .catch(() => {
        if (!cancelled) setModelFeatures(null);
      });
    return () => {
      cancelled = true;
    };
  }, [previewState, filePath]);

  // Syntax highlighting for the text preview. Runs after the content is loaded,
  // skips Markdown preview mode (handled separately), unknown languages, and
  // oversized files. refractor is lazy-loaded the first time it's needed.
  useEffect(() => {
    if (previewState.kind !== 'text') {
      setHighlightedLines(null);
      return;
    }
    const readable = rootPath && filePath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
    const language = resolveLanguage(readable);
    const content = previewState.content;
    // Markdown rendered in "preview" mode uses MarkdownPreview, not the line
    // renderer, so highlighting would be wasted there. In "source" mode we do
    // highlight the raw markdown like any other language.
    const isMarkdownPreview = isMarkdownPath(readable ?? '') && markdownViewMode === 'preview';
    if (!language || isMarkdownPreview || !shouldHighlight(content)) {
      setHighlightedLines(null);
      return;
    }

    let cancelled = false;
    const run = (mod: RefractorLike) => {
      if (cancelled || !mod.registered(language)) {
        if (!cancelled) setHighlightedLines(null);
        return;
      }
      try {
        setHighlightedLines(highlightToLines(mod, content, language));
      } catch {
        setHighlightedLines(null);
      }
    };

    if (refractor) {
      run(refractor);
    } else {
      setHighlightedLines(null);
      loadRefractor()
        .then((mod) => { if (!cancelled) { setRefractor(mod); run(mod); } })
        .catch(() => { /* best-effort: fall back to plain text */ });
    }

    return () => { cancelled = true; };
  }, [previewState, refractor, filePath, rootPath, markdownViewMode]);

  useLayoutEffect(() => {
    if (!readingStateKey || previewState.kind !== 'text') return;
    const restoreKey = `${readingStateKey}:${markdownViewMode}`;
    if (restoredReadingStateKeyRef.current === restoreKey) return;
    const savedReadingState = readFilePreviewReadingState(rootPath, filePath);
    restoredReadingStateKeyRef.current = restoreKey;
    if (!savedReadingState) return;
    const frame = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const top = markdownViewMode === 'preview'
        ? savedReadingState.markdownTop ?? savedReadingState.top
        : savedReadingState.top;
      scroller.scrollTo({
        top: Math.max(0, top ?? 0),
        left: Math.max(0, savedReadingState.left ?? 0),
      });
      setMarkdownPreviewScrollTop(markdownViewMode === 'preview' ? Math.max(0, top ?? 0) : 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [filePath, markdownViewMode, previewState.kind, readingStateKey, rootPath]);

  useEffect(() => {
    if (!readingStateKey) return;
    writeFilePreviewReadingState(rootPath, filePath, { lineRange });
  }, [filePath, lineRange, readingStateKey, rootPath]);

  // After a content-search jump, highlight and scroll to the requested line
  // once the file's text has actually rendered. We clear the request via the
  // callback so re-selecting the same line later still works.
  useEffect(() => {
    if (scrollToLine == null) return;
    if (previewState.kind !== 'text') return;
    setFloatingInsertPos(null);
    onLineRangeChange({ start: scrollToLine, end: scrollToLine });
    const target = scrollToLine;
    const frame = requestAnimationFrame(() => {
      const node = lineRefs.current.get(target);
      if (node) node.scrollIntoView({ block: 'center' });
      onScrollToLineHandled?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollToLine, previewState, onLineRangeChange, onScrollToLineHandled]);

  // 没有鼠标事件的场景（例如搜索结果跳转）才兜底定位到选中行右侧。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !lineRange) {
      setFloatingInsertPos(null);
      return;
    }
    if (floatingInsertPos) return;
    const isImagePreviewLocal = previewState.kind === 'image' || (previewState.kind === 'loading' && previewState.mode === 'image');
    const readableLocal = rootPath && filePath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
    const showMarkdownPreviewLocal = previewState.kind === 'text' && isMarkdownPath(readableLocal ?? '') && markdownViewMode === 'preview';
    if (previewState.kind !== 'text' || isImagePreviewLocal || showMarkdownPreviewLocal) {
      setFloatingInsertPos(null);
      return;
    }

    const computePos = () => {
      const node = lineRefs.current.get(lineRange.end);
      if (!node || !scroller) {
        setFloatingInsertPos(null);
        return;
      }
      const top = node.offsetTop + node.offsetHeight / 2;
      const left = scroller.scrollLeft + Math.max(8, scroller.clientWidth - 120);
      setFloatingInsertPos({ top, left });
    };

    computePos();
    const ro = new ResizeObserver(() => computePos());
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [lineRange, floatingInsertPos, previewState, markdownViewMode, filePath, rootPath, highlightedLines]);

  if (!filePath) {
    return <div className="mx-3 mt-3 overflow-hidden rounded-xl border border-border/15 bg-surface-2 px-4 py-8 text-center text-sm text-muted-foreground">{t('rightSidebar.selectFilePrompt')}</div>;
  }

  const readablePath = rootPath && !filePath.startsWith('/') ? `${rootPath}/${filePath}` : filePath;
  const display = getRelativeDisplayPath(readablePath, rootPath);
  const reference = buildFileReference(readablePath, rootPath);
  const lines = previewState.kind === 'text' && previewState.content ? previewState.content.split('\n') : [];
  // Gutter only needs room for the widest line number (+1ch breathing room),
  // so short files render numbers close to the left edge instead of leaving a
  // fixed gap sized for thousand-line files.
  const gutterWidthCh = Math.max(2, String(lines.length).length) + 1;
  const meta = previewState.kind === 'text' || previewState.kind === 'image' || previewState.kind === 'model3d' ? previewState.meta : null;
  const isMarkdown = isMarkdownPath(readablePath);
  const showMarkdownPreview = previewState.kind === 'text' && isMarkdown && markdownViewMode === 'preview';
  const isImagePreview = previewState.kind === 'image' || (previewState.kind === 'loading' && previewState.mode === 'image');
  const isModel3dPreview = previewState.kind === 'model3d' || (previewState.kind === 'loading' && previewState.mode === 'model3d');
  const lineReference = buildLineReference(readablePath, rootPath, lineRange);
  const lineReferenceText = (() => {
    if (!lineRange || previewState.kind !== 'text' || lines.length === 0) return lineReference;
    const selected: string[] = [];
    for (let n = lineRange.start; n <= lineRange.end; n += 1) {
      selected.push(`${n} ${lines[n - 1] ?? ''}`);
    }
    const lang = getFileExtension(readablePath).replace(/^\./, '');
    const fence = '```';
    return `${lineReference}\n${fence}${lang}\n${selected.join('\n')}\n${fence}\n`;
  })();
  const fileReferenceKey = `path:${readablePath}`;
  const lineReferenceKey = lineRange ? `path:${readablePath}:${lineRange.start}-${lineRange.end}` : fileReferenceKey;
  const fileReferenceInserted = insertedReferenceKey === fileReferenceKey;
  const lineReferenceInserted = insertedReferenceKey === lineReferenceKey;
  const fileReferenceCopied = copiedReferenceKey === fileReferenceKey;
  const lineReferenceCopied = copiedReferenceKey === lineReferenceKey;
  const lineReferenceCompleted = lineReferenceInserted || lineReferenceCopied;
  const selectedLineLabel = lineRange
    ? (lineRange.start === lineRange.end ? `L${lineRange.start}` : `L${lineRange.start}-${lineRange.end}`)
    : null;

  const placeFloatingInsertButton = (event: MouseEvent<HTMLElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const targetRect = event.currentTarget.getBoundingClientRect();
    const clientX = event.clientX || targetRect.left + targetRect.width / 2;
    const clientY = event.clientY || targetRect.top + targetRect.height / 2;
    const top = clientY - rect.top + scroller.scrollTop;
    const buttonWidth = isMobile ? 116 : 132;
    const maxLeft = scroller.scrollLeft + Math.max(8, scroller.clientWidth - buttonWidth);
    const left = Math.min(
      Math.max(8, clientX - rect.left + scroller.scrollLeft + 10),
      maxLeft,
    );
    setFloatingInsertPos({ top, left });
  };

  const handleLineClick = (event: MouseEvent<HTMLElement>, lineNumber: number) => {
    if (hasNativeTextSelection()) return;
    placeFloatingInsertButton(event);
    onLineRangeChange((current) => {
      const nextRange = getNextReferenceLineRange(current, lineNumber, lineNumber);
      if (!nextRange) {
        setFloatingInsertPos(null);
      }
      return nextRange;
    });
  };

  const handlePreviewLineRangeClick = (event: MouseEvent<HTMLElement>, startLine: number, endLine: number) => {
    placeFloatingInsertButton(event);
    onLineRangeChange((current) => {
      const nextRange = getNextReferenceLineRange(current, startLine, endLine);
      if (!nextRange) {
        setFloatingInsertPos(null);
      }
      return nextRange;
    });
  };

  const handlePreviewLineRangeDrag = (event: MouseEvent<HTMLElement>, startLine: number, endLine: number, phase: 'move' | 'end') => {
    if (phase === 'end') placeFloatingInsertButton(event);
    onLineRangeChange({ start: startLine, end: endLine });
  };

  const handleMarkdownPreviewScroll = (event: UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    setMarkdownPreviewScrollTop(scrollTop);
    writeFilePreviewReadingState(rootPath, filePath, {
      top: scrollTop,
      left: scrollLeft,
      markdownTop: scrollTop,
    });
  };

  const handleSourcePreviewScroll = (event: UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    writeFilePreviewReadingState(rootPath, filePath, {
      top: scrollTop,
      left: scrollLeft,
    });
  };

  const insertRangeReference = () => {
    if (!lineRange) return;
    onInsertText(lineReferenceText, lineReferenceKey);
  };

  const handleDownload = async () => {
    if (!readablePath || downloadState.status === 'pending') return;
    if (previewState.kind === 'loading' || previewState.kind === 'error') return;
    setDownloadState({ status: 'pending' });
    try {
      await downloadFile(readablePath);
      setDownloadState({ status: 'idle' });
    } catch (err) {
      setDownloadState({ status: 'error', message: err instanceof Error ? err.message : t('rightSidebar.downloadFailed') });
    }
  };

  return (
    // The container is a flex column that fills the panel. The middle scroller
    // is `min-h-0 flex-1` so the bottom action bar can stick to the visible
    // bottom regardless of file length.
    <div className="flex h-full min-h-0 flex-col bg-surface text-foreground">
      {getReferenceLongPressHandlers.popoverNode}
      <div className={`shrink-0 border-b border-border/15 px-3 ${isMobile && showMarkdownPreview ? 'py-1.5' : 'py-2'}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {isMobile && onClose && (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                aria-label={t('rightSidebar.backToFileList')}
                title={t('common.back')}
              >
                <RiArrowLeft size={15} />
              </button>
            )}
            <div className="min-w-0" title={readablePath}>
              <div className={`${isMobile ? 'max-w-[46vw]' : ''} truncate text-sm font-medium text-foreground`}>{display.name}</div>
              {display.dir && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{display.dir}</div>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {isMarkdown && previewState.kind === 'text' && (
              <button
                type="button"
                onClick={() => {
                  if (markdownOutlineOpen) onCloseMarkdownOutline?.();
                  setMarkdownViewMode((mode) => {
                    const next = mode === 'preview' ? 'source' : 'preview';
                    writeCache(MARKDOWN_VIEW_MODE_STORAGE_KEY, next);
                    return next;
                  });
                  onLineRangeChange(null);
                }}
                className="inline-flex h-9 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs font-semibold text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95 sm:px-3"
                title={markdownViewMode === 'preview' ? t('rightSidebar.markdownSource') : t('rightSidebar.markdownPreview')}
              >
                {markdownViewMode === 'preview' ? t('rightSidebar.markdownSource') : t('rightSidebar.markdownPreview')}
              </button>
            )}
            {!isMobile && (
              <button
                type="button"
                onClick={() => onInsertReference(readablePath, fileReferenceKey)}
                {...getReferenceLongPressHandlers(reference, fileReferenceKey)}
                className={`inline-flex h-9 items-center gap-1 rounded-full px-3 text-xs font-semibold transition active:scale-95 ${
                  fileReferenceInserted || fileReferenceCopied
                    ? 'bg-surface-elevated text-foreground'
                    : 'bg-primary/15 text-primary hover:bg-primary/25'
                }`}
                title={t('rightSidebar.insertReference', { reference })}
              >
                {fileReferenceCopied ? t('rightSidebar.copied') : fileReferenceInserted ? t('rightSidebar.inserted') : t('rightSidebar.insertFileRef')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(reference)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
              title={t('rightSidebar.copyReference', { reference })}
              aria-label={t('rightSidebar.copyFileRef')}
            >
              <RiCopy size={13} />
            </button>
            <button
              type="button"
              onClick={() => void handleDownload()}
              disabled={downloadState.status === 'pending' || previewState.kind === 'loading' || previewState.kind === 'error'}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95 disabled:opacity-50 disabled:active:scale-100"
              title={downloadState.status === 'error' ? downloadState.message ?? t('rightSidebar.downloadFailed') : t('rightSidebar.downloadFile')}
              aria-label={t('rightSidebar.downloadFile')}
            >
              {downloadState.status === 'pending' ? <RiLoader size={13} className="animate-spin" /> : <RiDownload size={14} />}
            </button>
          </div>
        </div>
        {meta && !(isMobile && showMarkdownPreview) && (
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            {meta.size !== null && <span>{t('rightSidebar.byteCount', { count: meta.size.toLocaleString() })}</span>}
            {'truncated' in meta && meta.truncated && <span className="text-[color:var(--warning)]">{t('rightSidebar.previewTruncated')}</span>}
            {'mimeType' in meta && <span>{meta.mimeType}</span>}
            {'dimensions' in previewState && previewState.dimensions && <span>{previewState.dimensions.width} × {previewState.dimensions.height}</span>}
          </div>
        )}
        {/* Hint row — fixed height so toggling line range doesn't shift the
            file content below. */}
        {!(isMobile && showMarkdownPreview) && !isModel3dPreview && previewState.kind !== 'binary' && <div className="mt-1 flex h-4 items-center gap-2 text-[10px] text-muted-foreground/75">
          <span className="truncate">
            {isImagePreview
              ? t('rightSidebar.imagePreviewHint')
              : showMarkdownPreview
                ? lineRange
                  ? t('rightSidebar.selectedLineHint', { lineLabel: selectedLineLabel ?? '' })
                  : t('rightSidebar.markdownPreviewHint')
              : lineRange
                ? t('rightSidebar.selectedLineHint', { lineLabel: selectedLineLabel ?? '' })
                : t('rightSidebar.multiLineHint')}
          </span>
        </div>}
      </div>
      {previewState.kind === 'loading' ? (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-8 text-center text-sm text-muted-foreground">
          {previewState.mode === 'image' ? t('rightSidebar.loadingImage') : previewState.mode === 'model3d' ? t('rightSidebar.model3dLoading') : 'Loading file…'}
        </div>
      ) : previewState.kind === 'error' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-3 mt-3 border border-destructive/20 bg-destructive/5 px-4 py-4 text-sm text-destructive">{previewState.message}</div>
        </div>
      ) : previewState.kind === 'binary' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-3 mt-3 rounded-xl border border-border/15 bg-surface-2 px-4 py-6 text-center text-sm text-muted-foreground">
            {t('rightSidebar.binaryPreviewHint')}
          </div>
        </div>
      ) : previewState.kind === 'image' ? (
        <div className="min-h-0 flex-1 overflow-hidden bg-surface p-3">
          <ZoomableImage
            src={previewState.objectUrl}
            alt={display.name}
            vector={previewState.meta.mimeType === 'image/svg+xml'}
            onLoad={(event) => {
              const img = event.currentTarget;
              setPreviewState((current) => (
                current.kind === 'image'
                  ? { ...current, dimensions: { width: img.naturalWidth, height: img.naturalHeight } }
                  : current
              ));
            }}
            onError={() => setPreviewState({ kind: 'error', message: t('rightSidebar.imageLoadFailed') })}
          />
        </div>
      ) : previewState.kind === 'model3d' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface">
          <Suspense fallback={<div className="min-h-0 flex-1 px-3 py-8 text-center text-sm text-muted-foreground">{t('rightSidebar.model3dLoading')}</div>}>
            <ModelPreview
              blobUrl={previewState.objectUrl}
              ext={previewState.ext}
              fileName={display.name}
              filePath={readablePath}
              features={modelFeatures}
              onInsertFeature={onInsertFeature}
              onRefresh={refreshPreview}
            />
          </Suspense>
        </div>
      ) : showMarkdownPreview ? (
        <div
          ref={scrollerRef}
          className="termdock-native-select relative min-h-0 flex-1 overflow-auto bg-surface"
          data-markdown-preview-scroller
          onScroll={handleMarkdownPreviewScroll}
          style={{ touchAction: 'pan-x pan-y' }}
        >
          <MarkdownPreview
            content={previewState.content}
            filePath={readablePath}
            rootPath={rootPath}
            lineRange={lineRange}
            onLineRangeClick={handlePreviewLineRangeClick}
            onLineRangeDrag={handlePreviewLineRangeDrag}
            scrollTop={markdownPreviewScrollTop}
            outlineOpen={markdownOutlineOpen}
            outlineCloseSignal={markdownOutlineCloseSignal}
            onOutlineOpen={onOpenMarkdownOutline}
            onOutlineClose={onCloseMarkdownOutline}
            lightboxOpen={markdownImageLightboxOpen}
            lightboxCloseSignal={markdownImageLightboxCloseSignal}
            onLightboxOpen={onOpenMarkdownImageLightbox}
            onLightboxClose={onCloseMarkdownImageLightbox}
          />
          {lineRange && floatingInsertPos && (
            <button
              type="button"
              onClick={insertRangeReference}
              {...getReferenceLongPressHandlers(lineReferenceText, lineReferenceKey)}
              style={{ top: floatingInsertPos.top, left: floatingInsertPos.left, transform: 'translateY(-50%)' }}
              className={getReferenceFloatingButtonClass(isMobile, lineReferenceCompleted)}
              title={`Insert markdown reference: ${lineReference}`}
            >
              <RiLink size={isMobile ? 13 : 11} />
              {lineReferenceCopied ? t('rightSidebar.copied') : lineReferenceInserted ? t('rightSidebar.inserted') : t('rightSidebar.insertLineRef', { lineLabel: selectedLineLabel ?? '' })}
            </button>
          )}
        </div>
      ) : previewState.kind === 'text' ? (
        <div
          ref={scrollerRef}
          onScroll={handleSourcePreviewScroll}
          className={`${FILE_PREVIEW_HORIZONTAL_SCROLL_CLASS} termdock-native-select termdock-code relative min-h-0 flex-1 overflow-auto rounded-none bg-surface p-2 font-mono text-[11px] leading-relaxed text-foreground`}
        >
          {lines.length > 0 ? (
            <div className="min-w-full">
              {lines.map((line, index) => {
                const lineNumber = index + 1;
                const isSelected = Boolean(lineRange && lineNumber >= lineRange.start && lineNumber <= lineRange.end);
                const highlighted = highlightedLines && highlightedLines.length === lines.length
                  ? highlightedLines[index]
                  : null;
                return (
                  <div
                    // eslint-disable-next-line react/no-array-index-key
                    key={index}
                    ref={(node) => {
                      if (node) lineRefs.current.set(lineNumber, node);
                      else lineRefs.current.delete(lineNumber);
                    }}
                    role="button"
                    tabIndex={0}
                    onClick={(event) => handleLineClick(event, lineNumber)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      handleLineClick(event as unknown as MouseEvent<HTMLElement>, lineNumber);
                    }}
                    // Line-number gutter width tracks the file's digit count so a
                    // short file doesn't reserve room for thousands of lines and
                    // leave a big gap between the edge and the numbers.
                    style={{ gridTemplateColumns: `${gutterWidthCh}ch 1fr` }}
                    className={`group grid w-max min-w-full cursor-text gap-2 rounded-md pr-1 text-left transition ${
                      isSelected
                        ? 'bg-[var(--surface-2)] text-foreground'
                        : 'hover:bg-surface-2'
                    }`}
                    title={`Tap to reference ${reference}:${lineNumber}`}
                  >
                    <span className={`select-none rounded text-right text-[10px] transition ${isSelected ? 'bg-[var(--surface-elevated)] text-muted-foreground' : 'text-muted-foreground/55'}`}>{lineNumber}</span>
                    <span className="whitespace-pre select-text" data-sidebar-selectable>{highlighted ?? (line || ' ')}</span>
                  </div>
                );
              })}
            </div>
          ) : 'Empty file.'}
          {/* Floating insert button — anchors to the selected line so reference
              insertion stays close to the user's last tap/click on every size. */}
          {lineRange && floatingInsertPos && (
            <button
              type="button"
              onClick={insertRangeReference}
              {...getReferenceLongPressHandlers(lineReferenceText, lineReferenceKey)}
              style={{ top: floatingInsertPos.top, left: floatingInsertPos.left, transform: 'translateY(-50%)' }}
              className={getReferenceFloatingButtonClass(isMobile, lineReferenceCompleted)}
              title={`Insert code reference: ${lineReference}`}
            >
              <RiLink size={isMobile ? 13 : 11} />
              {lineReferenceCopied ? t('rightSidebar.copied') : lineReferenceInserted ? t('rightSidebar.inserted') : t('rightSidebar.insertLineRef', { lineLabel: selectedLineLabel ?? '' })}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function RightSidebar(
  {
    isOpen,
    drawerWidthPx,
    onClose,
    onOpen,
    push,
    rightSidebarFilePreviewOpen = false,
    rightSidebarFilePreviewCloseSignal,
    onOpenRightSidebarFilePreview,
    onCloseRightSidebarFilePreview,
    rightSidebarRepoPickerOpen = false,
    rightSidebarRepoPickerCloseSignal,
    onOpenRightSidebarRepoPicker,
    onCloseRightSidebarRepoPicker,
    markdownOutlineOpen = false,
    markdownOutlineCloseSignal,
    onOpenMarkdownOutline,
    onCloseMarkdownOutline,
    markdownImageLightboxOpen = false,
    markdownImageLightboxCloseSignal,
    onOpenMarkdownImageLightbox,
    onCloseMarkdownImageLightbox,
  }: RightSidebarProps,
) {
  const { t, locale } = useI18n();
  const [fileQuery, setFileQuery] = useState('');
  const searchOpen = useSidebarStore((s) => s.rightSearchOpen);
  const setRightSearchOpen = useSidebarStore((s) => s.setRightSearchOpen);
  const [searchMode, setSearchMode] = useState<FileSearchMode>(() => readFileSearchMode());
  const deferredFileQuery = useDeferredValue(fileQuery);
  const [gitContext, setGitContext] = useState<GitContext | null>(null);
  const [gitRepositories, setGitRepositories] = useState<GitRepositoryBundle[]>([]);
  const [gitRepoFilters, setGitRepoFilters] = useState<GitRepositoryFilter[]>([]);
  const [activeGitRepoRoot, setActiveGitRepoRoot] = useState<string | null>(null);
  const [repoPickerAnchor, setRepoPickerAnchor] = useState<{ x: number; y: number } | null>(null);
  const [insertedReferenceKey, setInsertedReferenceKey] = useState<string | null>(null);
  const [copiedReferenceKey, setCopiedReferenceKey] = useState<string | null>(null);
  const [contextDraftEnabled, setContextDraftEnabled] = useState(
    () => readCache(CONTEXT_DRAFT_ENABLED_STORAGE_KEY, isDiffWrap) ?? false,
  );
  const [contextDraftCollapsed, setContextDraftCollapsed] = useState(
    () => readCache(CONTEXT_DRAFT_COLLAPSED_STORAGE_KEY, isDiffWrap) ?? false,
  );
  const [contextDraftText, setContextDraftText] = useState(
    () => readCache(CONTEXT_DRAFT_TEXT_STORAGE_KEY, isStringValue) ?? '',
  );
  const [draftFocusRequest, setDraftFocusRequest] = useState(0);
  // 草稿插入终端失败（session 断联/无活跃终端）：保留草稿并提示
  const [draftInsertFailed, setDraftInsertFailed] = useState(false);
  // Line-range selection lives in the sidebar so the sticky action bar and
  // the file scroller stay in sync without prop-drilling the click handler.
  const [lineRange, setLineRange] = useState<{ start: number; end: number } | null>(null);
  // A pending "scroll to this line" request from content search. Cleared by the
  // preview once it has highlighted and scrolled to the matched line.
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);
  const [collapsedGitRepoGroups, setCollapsedGitRepoGroups] = useState<Set<string>>(() => readCollapsedSet(COLLAPSED_GIT_REPO_GROUPS_STORAGE_KEY));
  const [collapsedDiffDirectories, setCollapsedDiffDirectories] = useState<Set<string>>(() => readCollapsedSet(COLLAPSED_DIFF_DIRECTORIES_STORAGE_KEY));
  const [diffChangeListMode, setDiffChangeListMode] = useState<DiffChangeListMode>(() => readDiffChangeListMode());
  // When on, long diff lines wrap instead of overflowing horizontally. The
  // user can opt in per-session without leaving the panel.
  const [diffWrap, setDiffWrap] = useState(() => readDiffWrap());
  const [diffViewType, setDiffViewType] = useState<DiffViewType>(() => readDiffViewType());
  const diffInlineMode: DiffInlineMode = 'words';
  const [diffRefreshKey, setDiffRefreshKey] = useState(0);
  const [changeAuditRecords, setChangeAuditRecords] = useState<ChangeAuditRecord[]>([]);
  const [changeWalkthroughs, setChangeWalkthroughs] = useState<ChangeWalkthrough[]>([]);
  const [changeAuditLoading, setChangeAuditLoading] = useState(false);
  const [changeAuditError, setChangeAuditError] = useState<string | null>(null);
  const [changeAuditRepoRoots, setChangeAuditRepoRoots] = useState<string[]>([]);
  const [changeAuditScopeOpen, setChangeAuditScopeOpen] = useState(false);
  const [branchAuditRecords, setBranchAuditRecords] = useState<BranchAuditRecord[]>([]);
  const [branchWalkthroughs, setBranchWalkthroughs] = useState<ChangeWalkthrough[]>([]);
  const [branchAuditDetailOpen, setBranchAuditDetailOpen] = useState(false);
  const [branchAuditPreviewDiff, setBranchAuditPreviewDiff] = useState<BranchDiffResponse | null>(null);
  const [branchAuditPreviewEntries, setBranchAuditPreviewEntries] = useState<BranchAuditPreviewEntry[]>([]);
  const [branchAuditPreviewScrollTops, setBranchAuditPreviewScrollTops] = useState<Record<string, number>>({});
  const [branchAuditPreviewLoading, setBranchAuditPreviewLoading] = useState(false);
  const [branchAuditPreviewError, setBranchAuditPreviewError] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<BranchDiffResponse | null>(null);
  const [commitDiffLoading, setCommitDiffLoading] = useState<string | null>(null);
  const [commitDiffError, setCommitDiffError] = useState<string | null>(null);
  const [recentCommitsOpen, setRecentCommitsOpen] = useState(false);
  const [recentCommitQuery, setRecentCommitQuery] = useState('');
  const deferredRecentCommitQuery = useDeferredValue(recentCommitQuery);
  const [recentCommits, setRecentCommits] = useState<string[]>([]);
  const [recentCommitsLoading, setRecentCommitsLoading] = useState(false);
  const [recentCommitsLoadingMore, setRecentCommitsLoadingMore] = useState(false);
  const [recentCommitsError, setRecentCommitsError] = useState<string | null>(null);
  const [recentCommitsHasMore, setRecentCommitsHasMore] = useState(false);
  const recentCommitsAbortRef = useRef<AbortController | null>(null);
  const recentCommitsRequestIdRef = useRef(0);
  const recentCommitsStateRef = useRef({ count: 0, loading: false, loadingMore: false, hasMore: false });
  const [selectedCommitDiffFileKey, setSelectedCommitDiffFileKey] = useState<string | null>(null);
  const [branchAuditModuleOpen, setBranchAuditModuleOpen] = useState(() => readCache(BRANCH_AUDIT_MODULE_OPEN_STORAGE_KEY, isDiffWrap) ?? false);
  const [branchAuditScopeOpen, setBranchAuditScopeOpen] = useState(false);
  const [branchAuditRepoRoots, setBranchAuditRepoRoots] = useState<string[]>([]);
  const [branchAuditRepoBranches, setBranchAuditRepoBranches] = useState<Record<string, string>>({});
  const [branchAuditRepoBaseBranches, setBranchAuditRepoBaseBranches] = useState<Record<string, string>>({});
  const [branchAuditIncludeUncommitted, setBranchAuditIncludeUncommitted] = useState(true);
  const [branchAuditDetailsLoadingRoots, setBranchAuditDetailsLoadingRoots] = useState<Set<string>>(() => new Set());
  const [selectedBranchAuditHistoryKey, setSelectedBranchAuditHistoryKey] = useState<string | null>(null);
  const [selectedBranchAuditFileKey, setSelectedBranchAuditFileKey] = useState<string | null>(null);
  const [mobileFilePreviewOpen, setMobileFilePreviewOpen] = useState(false);
  const [mobileFileSlideIndex, setMobileFileSlideIndex] = useState(0);
  const [, setMobileDiffSlideIndex] = useState(0);
  const [mobileSidebarSettled, setMobileSidebarSettled] = useState(false);
  const [hasMountedGitPane, setHasMountedGitPane] = useState(false);
  const [hasMountedDiffPane, setHasMountedDiffPane] = useState(
    () => useSidebarStore.getState().rightTab === 'diff',
  );
  const [hasMountedPreviewPane, setHasMountedPreviewPane] = useState(false);
  const [runningGitAction, setRunningGitAction] = useState<{ action: GitActionKey; path?: string } | null>(null);
  const [completedGitAction, setCompletedGitAction] = useState<{ action: GitActionKey; path?: string; label: string } | null>(null);
  const [confirmGitAction, setConfirmGitAction] = useState<ConfirmGitAction | null>(null);
  const [gitActionError, setGitActionError] = useState<string | null>(null);
  const [gitQuickActionsOpen, setGitQuickActionsOpen] = useState(false);
  const [gitDetailsLoading, setGitDetailsLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [switchBranch, setSwitchBranch] = useState('');
  const [pushRemote, setPushRemote] = useState('');
  const [pushBranch, setPushBranch] = useState('');
  const [fileWatchError, setFileWatchError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [canOpenInFileBrowser, setCanOpenInFileBrowser] = useState(false);
  const [diffStreamScrollRequest, setDiffStreamScrollRequest] = useState<{ key: string | null; nonce: number }>({ key: null, nonce: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = drawerWidthPx < MOBILE_WIDTH_THRESHOLD_PX;
  const isWide = !isMobile && drawerWidthPx >= WIDE_WIDTH_THRESHOLD_PX;
  const [fileTreeWidthPx, setFileTreeWidthPx] = useState(() => readFileTreeWidth(drawerWidthPx));
  const rightTab = useSidebarStore((s) => s.rightTab);
  const setRightTab = useSidebarStore((s) => s.setRightTab);
  const rootPath = useSidebarStore((s) => s.rootPath);
  const explorerRoot = useSidebarStore((s) => s.explorerRoot);
  const pinnedExplorerRootsCache = useSidebarStore((s) => s.pinnedExplorerRootsCache);
  const setExplorerRoot = useSidebarStore((s) => s.setExplorerRoot);
  const resetExplorerToProject = useSidebarStore((s) => s.resetExplorerToProject);
  const pinExplorerRoot = useSidebarStore((s) => s.pinExplorerRoot);
  const unpinExplorerRoot = useSidebarStore((s) => s.unpinExplorerRoot);
  const selectedFilePath = useSidebarStore((s) => s.selectedFilePath);
  const selectFile = useSidebarStore((s) => s.selectFile);
  const showHiddenFiles = useSidebarStore((s) => s.showHiddenFiles);
  const toggleShowHiddenFiles = useSidebarStore((s) => s.toggleShowHiddenFiles);
  const changedFiles = useSidebarStore((s) => s.changedFiles);
  const setChangedFiles = useSidebarStore((s) => s.setChangedFiles);
  const invalidateDirectoryCache = useSidebarStore((s) => s.invalidateDirectoryCache);
  const applyFileWatchEvents = useSidebarStore((s) => s.applyFileWatchEvents);
  const bumpFileWatchEpoch = useSidebarStore((s) => s.bumpFileWatchEpoch);
  const gitBundleLoading = useSidebarStore((s) => s.gitBundleLoading);
  const gitBundleSlow = useSidebarStore((s) => s.gitBundleSlow);
  const gitBundleError = useSidebarStore((s) => s.gitBundleError);
  const gitBundleLastLoadedAt = useSidebarStore((s) => s.gitBundleLastLoadedAt);
  const gitBundleCacheInfo = useSidebarStore((s) => s.gitBundleCacheInfo);
  const setGitBundleLoading = useSidebarStore((s) => s.setGitBundleLoading);
  const setGitBundleSlow = useSidebarStore((s) => s.setGitBundleSlow);
  const setGitBundleError = useSidebarStore((s) => s.setGitBundleError);
  const markGitBundleLoaded = useSidebarStore((s) => s.markGitBundleLoaded);
  const fileTreeRoot = explorerRoot ?? rootPath;
  const rootEntriesLoaded = useSidebarStore((s) => Boolean(fileTreeRoot && s.directoryCache.has(fileTreeRoot)));
  const fileTreeScrollRef = useRef<HTMLDivElement | null>(null);
  const gitBundleRequestIdRef = useRef(0);
  const gitBundleAbortRef = useRef<AbortController | null>(null);
  const gitBundlePendingRef = useRef<{ cwd: string; includeNested: boolean; refresh: boolean; cacheOnly: boolean; promise: Promise<GitBundleResponse | null> } | null>(null);
  const untrackedRequestSeqRef = useRef(0);
  const untrackedRequestIdsRef = useRef<Map<string, number>>(new Map());
  const untrackedAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const untrackedCompletedRootsRef = useRef<Set<string>>(new Set());
  const untrackedRunningRootsRef = useRef<Set<string>>(new Set());
  const gitDetailsRequestIdRef = useRef(0);
  const gitDetailsAbortRef = useRef<AbortController | null>(null);
  const changeAuditRequestIdRef = useRef(0);
  const changeAuditAbortRef = useRef<AbortController | null>(null);
  const branchAuditRequestIdRef = useRef(0);
  const branchAuditAbortRef = useRef<AbortController | null>(null);
  const branchAuditDetailsLoadingRootsRef = useRef(new Set<string>());
  const branchAuditModuleHydratedRootRef = useRef<string | null>(null);
  const branchAuditModuleSkipWriteRootRef = useRef<string | null>(null);
  const diffStreamSyncedPathRef = useRef<string | null>(null);
  const lastAutoRefreshRootRef = useRef<string | null>(null);
  const fileTreeResizeRef = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null);
  const mobileFileSwiperRef = useRef<SwiperInstance | null>(null);
  const mobileDiffSwiperRef = useRef<SwiperInstance | null>(null);
  const isCurrentSidebarRoot = useCallback((expectedRootPath: string | null): boolean => (
    useSidebarStore.getState().rootPath === expectedRootPath
  ), []);

  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;
    const logGlobalDiffPointer = (event: globalThis.PointerEvent | globalThis.MouseEvent) => {
      const row = getDiffRowElement(event.target);
      if (!row) return;
      logDiffInteractionEvent('global_change_row_event', {
        ...getNativePointerLogData(event),
        selectionPath: row.dataset.diffSelectionPath,
        filePath: row.dataset.diffFilePath,
        absolutePath: row.dataset.diffAbsolutePath,
        repoRoot: row.dataset.diffRepoRoot,
        status: row.dataset.diffStatus,
        selectedFilePath: useSidebarStore.getState().selectedFilePath,
        rightTab: useSidebarStore.getState().rightTab,
        activeGitRepoRoot,
        changedFiles: useSidebarStore.getState().changedFiles.size,
      });
    };
    window.addEventListener('pointerdown', logGlobalDiffPointer, { capture: true });
    window.addEventListener('click', logGlobalDiffPointer, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', logGlobalDiffPointer, { capture: true });
      window.removeEventListener('click', logGlobalDiffPointer, { capture: true });
    };
  }, [activeGitRepoRoot, isOpen]);

  const loadUntrackedFiles = useCallback(async (cwd: string | undefined = rootPath ?? undefined) => {
    if (!cwd) return null;
    if (untrackedCompletedRootsRef.current.has(cwd) || untrackedRunningRootsRef.current.has(cwd)) {
      logGitBundleClientEvent('untracked_skip_cached', { cwd, rootPath, completed: untrackedCompletedRootsRef.current.has(cwd), running: untrackedRunningRootsRef.current.has(cwd) });
      return null;
    }
    const expectedRootPath = rootPath;
    const requestId = untrackedRequestSeqRef.current + 1;
    untrackedRequestSeqRef.current = requestId;
    untrackedRequestIdsRef.current.set(cwd, requestId);
    const requestSlotId = `right-sidebar-git-untracked:${cwd}`;
    const controller = new AbortController();
    untrackedAbortControllersRef.current.set(cwd, controller);
    untrackedRunningRootsRef.current.add(cwd);
    logGitBundleClientEvent('untracked_start', { requestId, cwd, rootPath });
    try {
      let result = await getUntrackedFiles(cwd, controller.signal, requestSlotId);
      let attempts = 0;
      while (result.status === 'running' && attempts < 120) {
        if (untrackedRequestIdsRef.current.get(cwd) !== requestId || controller.signal.aborted) {
          logGitBundleClientEvent('untracked_stale_result', { requestId, activeRequestId: untrackedRequestIdsRef.current.get(cwd), cwd, status: result.status });
          return null;
        }
        if (!isCurrentSidebarRoot(expectedRootPath)) {
          logGitBundleClientEvent('untracked_root_changed', { requestId, cwd, expectedRootPath, currentRootPath: useSidebarStore.getState().rootPath });
          return null;
        }
        await new Promise((resolve) => window.setTimeout(resolve, attempts < 10 ? 1000 : 3000));
        attempts += 1;
        result = await getUntrackedFiles(cwd, controller.signal, requestSlotId);
      }
      if (untrackedRequestIdsRef.current.get(cwd) !== requestId || !isCurrentSidebarRoot(expectedRootPath)) {
        logGitBundleClientEvent('untracked_stale_result', { requestId, activeRequestId: untrackedRequestIdsRef.current.get(cwd), cwd, expectedRootPath, currentRootPath: useSidebarStore.getState().rootPath, files: result.files.length, status: result.status });
        return null;
      }
      if (result.status === 'done') {
        setChangedFiles(mergeChangedFileMaps(useSidebarStore.getState().changedFiles, result.files));
        if (result.files.length > 0) {
          setGitRepositories((currentRepositories) => {
            const currentByRoot = new Map(currentRepositories.map((repo) => [repo.root, repo]));
            const currentRepo = currentByRoot.get(cwd);
            if (!currentRepo) return currentRepositories;
            const nextRepoFiles = mergeRepoChangedFiles(currentRepo.files, result.files);
            const nextRepositories = currentRepositories.map((repo) => (
              repo.root === cwd
                ? {
                  ...repo,
                  files: nextRepoFiles,
                  context: repo.context ? {
                    ...repo.context,
                    changedFiles: nextRepoFiles.map((file) => ({ path: file.path, absolutePath: file.absolutePath, status: file.status })),
                    truncated: false,
                  } : repo.context,
                  untrackedDeferred: false,
                }
                : repo
            ));
            setGitRepoFilters(buildRepoFiltersFromBundles(nextRepositories, rootPath));
            const rootRepo = nextRepositories.find((repo) => repo.root === rootPath);
            if (rootRepo?.context) {
              setGitContext((current) => (
                current?.root === rootRepo.root
                  ? { ...current, ...rootRepo.context }
                  : current
              ));
            }
            writeGitBundleSnapshot(rootPath, {
              available: true,
              files: nextRepositories.flatMap((repo) => repo.files),
              context: rootRepo?.context ?? gitContext,
              repositories: nextRepositories,
              repoFilters: buildRepoFiltersFromBundles(nextRepositories, rootPath),
              untrackedDeferred: nextRepositories.some((repo) => repo.untrackedDeferred),
            });
            return nextRepositories;
          });
        }
        untrackedCompletedRootsRef.current.add(cwd);
        logGitBundleClientEvent('untracked_apply', { requestId, cwd, files: result.files.length });
        return result;
      }
      const message = result.error || (result.status === 'running' ? 'Untracked file scan is still running.' : 'Failed to scan untracked files');
      untrackedCompletedRootsRef.current.add(cwd);
      logGitBundleClientEvent('untracked_error', { requestId, cwd, message, code: result.code, status: result.status });
      return null;
    } catch (error) {
      if (untrackedRequestIdsRef.current.get(cwd) !== requestId || !isCurrentSidebarRoot(expectedRootPath) || isAbortError(error)) {
        logGitBundleClientEvent('untracked_aborted', { requestId, activeRequestId: untrackedRequestIdsRef.current.get(cwd), cwd, expectedRootPath, currentRootPath: useSidebarStore.getState().rootPath, message: error instanceof Error ? error.message : String(error) });
        return null;
      }
      const message = error instanceof Error ? error.message : 'Failed to scan untracked files';
      untrackedCompletedRootsRef.current.add(cwd);
      logGitBundleClientEvent('untracked_error', { requestId, cwd, message });
      return null;
    } finally {
      if (untrackedAbortControllersRef.current.get(cwd) === controller) untrackedAbortControllersRef.current.delete(cwd);
      if (untrackedRequestIdsRef.current.get(cwd) === requestId) untrackedRequestIdsRef.current.delete(cwd);
      untrackedRunningRootsRef.current.delete(cwd);
    }
  }, [gitContext, isCurrentSidebarRoot, rootPath, setChangedFiles]);

  const changeAuditTargetRepoRoots = useMemo(() => {
    const validRoots = new Set(gitRepoFilters.map((repo) => repo.root));
    const explicit = changeAuditRepoRoots.filter((repoRoot) => validRoots.has(repoRoot));
    if (explicit.length > 0) return explicit;
    return activeGitRepoRoot ? [activeGitRepoRoot] : [];
  }, [activeGitRepoRoot, changeAuditRepoRoots, gitRepoFilters]);
  const changeAuditTargetsAllRepos = changeAuditTargetRepoRoots.length === 0;
  const changeAuditTargetRepos = useMemo(() => (
    changeAuditTargetRepoRoots
      .map((repoRoot) => gitRepositories.find((repo) => repo.root === repoRoot))
      .filter((repo): repo is GitRepositoryBundle => Boolean(repo))
  ), [changeAuditTargetRepoRoots, gitRepositories]);
  const changeAuditScopeRepos = useMemo<AuditPromptScopeRepoOption[]>(() => (
    gitRepoFilters.map((repo) => ({
      root: repo.root,
      label: repo.label,
      branch: repo.branch ?? null,
    }))
  ), [gitRepoFilters]);

  const loadChangeAuditRecords = useCallback(async () => {
    if (!rootPath) {
      setChangeAuditRecords([]);
      setChangeWalkthroughs([]);
      return;
    }
    const expectedRootPath = rootPath;
    // Auxiliary data must stay out of per-file/per-hunk render paths. Load
    // audit explanations once at the sidebar level, then pass the snapshot to
    // DiffViewer. Do not fetch this from every DiffViewer instance; concurrent
    // helper I/O can starve Git bundle, file tree and diff requests.
    const requestId = changeAuditRequestIdRef.current + 1;
    changeAuditRequestIdRef.current = requestId;
    changeAuditAbortRef.current?.abort();
    const controller = new AbortController();
    changeAuditAbortRef.current = controller;
    setChangeAuditLoading(changeAuditRecords.length === 0);
    setChangeAuditError(null);
    try {
      const auditResult = changeAuditTargetRepoRoots.length > 0
        ? await Promise.all(changeAuditTargetRepoRoots.map((repoRoot) => (
          getChangeAuditRecords({ workspaceRoot: rootPath, repoRoot }, controller.signal)
        ))).then((entries) => ({
          records: entries.flatMap((entry) => entry.records),
          walkthroughs: entries.flatMap((entry) => entry.walkthroughs ?? []),
        }))
        : await getChangeAuditRecords({ workspaceRoot: rootPath }, controller.signal);
      if (changeAuditRequestIdRef.current !== requestId || !isCurrentSidebarRoot(expectedRootPath)) return;
      setChangeAuditRecords(auditResult.records);
      setChangeWalkthroughs(auditResult.walkthroughs ?? []);
    } catch (error) {
      if (changeAuditRequestIdRef.current !== requestId || !isCurrentSidebarRoot(expectedRootPath) || isAbortError(error)) return;
      setChangeAuditError(error instanceof Error ? error.message : 'Failed to load change audit explanations');
    } finally {
      if (changeAuditAbortRef.current === controller) changeAuditAbortRef.current = null;
      if (changeAuditRequestIdRef.current === requestId && isCurrentSidebarRoot(expectedRootPath)) setChangeAuditLoading(false);
    }
  }, [changeAuditRecords.length, changeAuditTargetRepoRoots, isCurrentSidebarRoot, rootPath]);

  const loadBranchAuditRecords = useCallback(async (repoRoot: string | null, baseRef?: string | null, branchName?: string | null) => {
    if (!repoRoot && !rootPath) {
      setBranchAuditRecords([]);
      setBranchWalkthroughs([]);
      return;
    }
    const expectedRootPath = rootPath;
    const requestId = branchAuditRequestIdRef.current + 1;
    branchAuditRequestIdRef.current = requestId;
    branchAuditAbortRef.current?.abort();
    const controller = new AbortController();
    branchAuditAbortRef.current = controller;
    try {
      const repoRoots = repoRoot
        ? [repoRoot]
        : Array.from(new Set([
          rootPath,
          ...gitRepositories.map((repo) => repo.root),
        ].filter((root): root is string => Boolean(root))));
      const result = await Promise.all(repoRoots.map((targetRepoRoot) => (
        getBranchAuditRecords({
          repoRoot: targetRepoRoot,
          baseRef,
          branchName,
        }, controller.signal)
      ))).then((entries) => {
        const recordsById = new Map<string, BranchAuditRecord>();
        const walkthroughsById = new Map<string, ChangeWalkthrough>();
        for (const entry of entries) {
          for (const record of entry.records) recordsById.set(record.id, record);
          for (const walkthrough of entry.walkthroughs ?? []) walkthroughsById.set(walkthrough.id, walkthrough);
        }
        return {
          records: Array.from(recordsById.values()),
          walkthroughs: Array.from(walkthroughsById.values()),
        };
      });
      if (branchAuditRequestIdRef.current !== requestId || !isCurrentSidebarRoot(expectedRootPath)) return;
      setBranchAuditRecords(result.records);
      setBranchWalkthroughs(result.walkthroughs ?? []);
    } catch (error) {
      if (branchAuditRequestIdRef.current !== requestId || !isCurrentSidebarRoot(expectedRootPath) || isAbortError(error)) return;
      console.warn('[RightSidebar] Failed to load branch explanations', error);
    } finally {
      if (branchAuditAbortRef.current === controller) branchAuditAbortRef.current = null;
    }
  }, [gitRepositories, isCurrentSidebarRoot, rootPath]);

  const applyGitBundle = useCallback((bundle: GitBundleResponse, options: {
    reloadDiff?: boolean;
    persistSnapshot?: boolean;
    syncActiveRepo?: boolean;
    activeRepoRoot?: string | null;
    loadDeferred?: boolean;
    loadAudit?: boolean;
    background?: boolean;
    cacheOnly?: boolean;
  } = {}) => {
    if (!isCurrentSidebarRoot(rootPath)) {
      logGitBundleClientEvent('apply_skipped_root_changed', {
        expectedRootPath: rootPath,
        currentRootPath: useSidebarStore.getState().rootPath,
        bundleRoot: bundle.context?.root,
        files: bundle.files.length,
      });
      return;
    }
    logGitBundleClientEvent(bundle.files.length === 0 ? 'empty_bundle' : 'apply', {
      rootPath,
      available: bundle.available,
      files: bundle.files.length,
      repositories: bundle.repositories?.map((repo) => ({
        root: repo.root,
        relativeRoot: repo.relativeRoot,
        files: repo.files.length,
        available: repo.available,
        error: repo.error,
      })),
      repoFilters: bundle.repoFilters?.map((repo) => ({
        root: repo.root,
        label: repo.label,
        count: repo.count,
      })),
      cached: bundle.cached,
      stale: bundle.stale,
      cacheAgeMs: bundle.cacheAgeMs,
      untrackedDeferred: bundle.untrackedDeferred,
      error: bundle.error,
    });
    const repositories = getRepositoriesFromGitBundle(bundle);
    const repoFilters = bundle.repoFilters ?? [];
    const currentChangedFiles = useSidebarStore.getState().changedFiles;
    const cacheOnlyMiss = Boolean(options.cacheOnly && !bundle.cached && bundle.files.length === 0 && repositories.length === 0);
    if (cacheOnlyMiss && (currentChangedFiles.size > 0 || gitRepositories.length > 0 || gitContext)) {
      logGitBundleClientEvent('cache_only_apply_skipped_empty_backend_cache', {
        rootPath,
        currentFiles: currentChangedFiles.size,
        currentRepositories: gitRepositories.length,
      });
      return;
    }
    const currentNestedCount = countNestedChangedFiles(currentChangedFiles.values(), rootPath);
    const nextNestedCount = countNestedChangedFiles(bundle.files, rootPath);
    const nextHasNestedRepos = repositories.some((repo) => repo.root !== rootPath);
    const shouldKeepCurrentChanges = Boolean(
      options.background
        && currentChangedFiles.size > 0
        && (
          (bundle.files.length === 0 && !bundle.error)
          || (currentNestedCount > 0 && nextNestedCount === 0 && !nextHasNestedRepos)
        ),
    );
    if (shouldKeepCurrentChanges) {
      logGitBundleClientEvent('background_apply_skipped_degraded_bundle', {
        rootPath,
        currentFiles: currentChangedFiles.size,
        nextFiles: bundle.files.length,
        currentNestedCount,
        nextNestedCount,
        nextRepositories: repositories.map((repo) => ({
          root: repo.root,
          relativeRoot: repo.relativeRoot,
          files: repo.files.length,
        })),
        cached: bundle.cached,
        stale: bundle.stale,
        error: bundle.error,
      });
      return;
    }
    setChangedFiles(toChangedFileMap(bundle.files));
    setGitRepositories(repositories);
    setGitRepoFilters(repoFilters);
    if (options.syncActiveRepo !== false) {
      const preferredActiveRoot = options.activeRepoRoot !== undefined
        ? options.activeRepoRoot
        : activeGitRepoRoot ?? readActiveGitRepoRoot(rootPath);
      const nextActiveRoot = resolveActiveGitRepoRootFromBundle({ ...bundle, repositories, repoFilters }, preferredActiveRoot);
      setActiveGitRepoRoot(nextActiveRoot);
      writeActiveGitRepoRoot(rootPath, nextActiveRoot);
    }
    if (options.persistSnapshot !== false) {
      writeGitBundleSnapshot(rootPath, { ...bundle, repositories, repoFilters });
    }
    setGitContext((current) => {
      if (!bundle.context) return null;
      const currentRoot = current?.root ?? rootPath;
      if (!current?.available || currentRoot !== (bundle.context.root ?? rootPath)) return bundle.context;
      return { ...current, ...bundle.context };
    });
    if (options.reloadDiff) setDiffRefreshKey((key) => key + 1);
    const current = useSidebarStore.getState().selectedFilePath;
    if (current && !current.startsWith('/') && !bundle.files.some((file) => file.path === current || file.absolutePath === current)) {
      selectFile(null);
    }
    setCollapsedGitRepoGroups((collapsed) => {
      const valid = new Set(bundle.files.map((file) => getChangedFileRepoRoot(file, rootPath)).filter(Boolean) as string[]);
      const next = new Set<string>();
      for (const root of collapsed) {
        if (valid.has(root)) next.add(root);
      }
      writeCollapsedSet(COLLAPSED_GIT_REPO_GROUPS_STORAGE_KEY, next);
      return next;
    });
    if (options.loadDeferred !== false) {
      const deferredRoots = repositories
        .filter((repo) => repo.untrackedDeferred && repo.root)
        .map((repo) => repo.root);
      for (const repoRoot of deferredRoots) {
        void loadUntrackedFiles(repoRoot);
      }
    }
    if (options.loadAudit !== false) void loadChangeAuditRecords();
  }, [activeGitRepoRoot, isCurrentSidebarRoot, loadChangeAuditRecords, loadUntrackedFiles, rootPath, selectFile, setChangedFiles]);

  useEffect(() => {
    const gitBundleSnapshot = readGitBundleSnapshot(rootPath);
    branchAuditModuleHydratedRootRef.current = null;
    branchAuditModuleSkipWriteRootRef.current = rootPath;
    const snapshotBundle = gitBundleSnapshot?.bundle ?? null;
    const snapshotRepositories = snapshotBundle ? getRepositoriesFromGitBundle(snapshotBundle) : [];
    const snapshotRepoFilters = snapshotBundle?.repoFilters ?? [];
    const persistedActiveGitRepoRoot = readActiveGitRepoRoot(rootPath);
    const restoredActiveGitRepoRoot = snapshotBundle
      ? resolveActiveGitRepoRootFromBundle({ ...snapshotBundle, repositories: snapshotRepositories, repoFilters: snapshotRepoFilters }, persistedActiveGitRepoRoot)
      : null;
    gitBundleRequestIdRef.current += 1;
    gitDetailsRequestIdRef.current += 1;
    untrackedRequestSeqRef.current += 1;
    gitBundleAbortRef.current?.abort();
    cancelIoSlot(buildGitBundleRequestSlotId(gitBundlePendingRef.current?.cwd ?? rootPath ?? undefined));
    gitBundlePendingRef.current = null;
    gitBundleAbortRef.current = null;
    gitDetailsAbortRef.current?.abort();
    cancelIoSlot('right-sidebar-git-details');
    gitDetailsAbortRef.current = null;
    for (const controller of untrackedAbortControllersRef.current.values()) controller.abort();
    for (const repoRoot of untrackedAbortControllersRef.current.keys()) cancelIoSlot(`right-sidebar-git-untracked:${repoRoot}`);
    untrackedAbortControllersRef.current.clear();
    untrackedRequestIdsRef.current.clear();
    changeAuditRequestIdRef.current += 1;
    changeAuditAbortRef.current?.abort();
    changeAuditAbortRef.current = null;
    branchAuditRequestIdRef.current += 1;
    branchAuditAbortRef.current?.abort();
    branchAuditAbortRef.current = null;
    recentCommitsRequestIdRef.current += 1;
    recentCommitsAbortRef.current?.abort();
    cancelIoSlot('right-sidebar-recent-commits');
    recentCommitsAbortRef.current = null;
    setChangeAuditRecords([]);
    setChangeWalkthroughs([]);
    setChangeAuditLoading(false);
    setChangeAuditError(null);
    setChangeAuditRepoRoots([]);
    setChangeAuditScopeOpen(false);
    setBranchAuditRecords([]);
    setBranchWalkthroughs([]);
    setBranchAuditDetailOpen(false);
    setBranchAuditPreviewDiff(null);
    setBranchAuditPreviewLoading(false);
    setBranchAuditPreviewError(null);
    setCommitDiff(null);
    setCommitDiffLoading(null);
    setCommitDiffError(null);
    setRecentCommitsOpen(false);
    setRecentCommitQuery('');
    setRecentCommits([]);
    setRecentCommitsLoading(false);
    setRecentCommitsLoadingMore(false);
    setRecentCommitsError(null);
    setRecentCommitsHasMore(false);
    setSelectedCommitDiffFileKey(null);
    setSelectedBranchAuditHistoryKey(null);
    setSelectedBranchAuditFileKey(null);
    setBranchAuditModuleOpen(false);
    writeCache(BRANCH_AUDIT_MODULE_OPEN_STORAGE_KEY, false);
    setBranchAuditScopeOpen(false);
    const branchAuditModuleState = rootPath ? readBranchAuditModuleCache()[rootPath] : null;
    const restoredPreviewEntries = branchAuditModuleState?.previewEntries ?? [];
    const restoredPreviewKey = branchAuditModuleState?.selectedPreviewKey ?? null;
    const restoredPreviewEntry = restoredPreviewKey
      ? restoredPreviewEntries.find((entry) => entry.key === restoredPreviewKey) ?? null
      : null;
    setBranchAuditRepoRoots(branchAuditModuleState?.selectedRepoRoots ?? []);
    setBranchAuditRepoBranches(branchAuditModuleState?.repoTargetBranches ?? {});
    setBranchAuditRepoBaseBranches(branchAuditModuleState?.repoBaseBranches ?? {});
    setBranchAuditPreviewEntries(restoredPreviewEntries);
    setBranchAuditPreviewScrollTops(branchAuditModuleState?.previewScrollTops ?? {});
    if (restoredPreviewEntry && branchAuditModuleState?.previewDetailOpen) {
      setBranchAuditPreviewDiff(restoredPreviewEntry.diff);
      setSelectedBranchAuditHistoryKey(restoredPreviewEntry.key);
      setSelectedBranchAuditFileKey(branchAuditModuleState.selectedPreviewFileKey ?? (restoredPreviewEntry.diff.hunks?.[0] ? `${restoredPreviewEntry.diff.hunks[0].filePath}\u0000${restoredPreviewEntry.diff.hunks[0].hunkHeader}\u0000${restoredPreviewEntry.diff.hunks[0].hunkIndex}` : null));
      setBranchAuditDetailOpen(true);
    }
    setBranchAuditIncludeUncommitted(branchAuditModuleState?.includeUncommitted ?? true);
    branchAuditModuleHydratedRootRef.current = rootPath;
    setGitDetailsLoading(false);
    setActiveGitRepoRoot(restoredActiveGitRepoRoot);
    untrackedCompletedRootsRef.current.clear();
    untrackedRunningRootsRef.current.clear();
    setRunningGitAction(null);
    setCompletedGitAction(null);
    setConfirmGitAction(null);
    setGitActionError(null);
    if (gitBundleSnapshot && snapshotBundle) {
      setChangedFiles(toChangedFileMap(snapshotBundle.files));
      markGitBundleLoaded({
        cached: true,
        stale: true,
        cacheAgeMs: Math.max(0, Date.now() - gitBundleSnapshot.updatedAt),
        nestedDeferred: false,
        untrackedDeferred: snapshotBundle.untrackedDeferred,
      });
    }
    setGitRepositories(snapshotRepositories);
    setGitRepoFilters(snapshotRepoFilters);
    setGitContext(snapshotBundle?.context ?? null);
    lastAutoRefreshRootRef.current = null;
  }, [rootPath]);

  const loadGitBundle = useCallback(async (cwd: string | undefined = rootPath ?? undefined, options: { reloadDiff?: boolean; includeNested?: boolean; background?: boolean; refresh?: boolean; cacheOnly?: boolean } = {}) => {
    if (!cwd) return null;
    const expectedRootPath = rootPath;
    const includeNested = options.includeNested ?? true;
    const refresh = options.refresh ?? options.reloadDiff ?? false;
    const cacheOnly = options.cacheOnly ?? false;
    const background = options.background ?? false;
    if (refresh) untrackedCompletedRootsRef.current.clear();
    const pending = gitBundlePendingRef.current;
    if (pending && pending.cwd === cwd && pending.includeNested === includeNested && pending.refresh === refresh && pending.cacheOnly === cacheOnly) {
      logGitBundleClientEvent('reuse_pending', { cwd, includeNested, refresh, cacheOnly });
      return pending.promise;
    }
    const requestId = gitBundleRequestIdRef.current + 1;
    gitBundleRequestIdRef.current = requestId;
    gitBundleAbortRef.current?.abort();
    const requestSlotId = buildGitBundleRequestSlotId(cwd);
    cancelIoSlot(requestSlotId);
    const controller = new AbortController();
    gitBundleAbortRef.current = controller;
    let slowTimer: number | null = null;
    if (!background) {
      setGitBundleLoading(true);
      setGitBundleSlow(false);
    }
    setGitBundleError(null);
    logGitBundleClientEvent('start', {
      requestId,
      cwd,
      rootPath,
      requestSlotId,
      includeNested,
      refresh,
      cacheOnly,
      background,
      existingChanges: changedFiles.size,
      lastLoadedAt: gitBundleLastLoadedAt,
    });
    if (!background && typeof window !== 'undefined') {
      slowTimer = window.setTimeout(() => {
        if (gitBundleRequestIdRef.current === requestId) setGitBundleSlow(true);
      }, GIT_BUNDLE_SLOW_MS);
    }

    const promise = (async () => {
      const bundle = await getGitBundle(cwd, controller.signal, {
        includeNested,
        refresh,
        cacheOnly,
        action: refresh ? 'manual_git_refresh' : 'open_sidebar_git_refresh',
        requestSlotId,
        requestTimeoutMs: refresh ? null : undefined,
      });
      if (isGitBundleCancellation(bundle)) {
        logGitBundleClientEvent('cancelled_result_ignored', {
          requestId,
          activeRequestId: gitBundleRequestIdRef.current,
          cwd,
          error: bundle.error ?? bundle.context?.error,
        });
        return null;
      }
      if (gitBundleRequestIdRef.current !== requestId || !isCurrentSidebarRoot(expectedRootPath)) {
        logGitBundleClientEvent('stale_result', {
          requestId,
          activeRequestId: gitBundleRequestIdRef.current,
          cwd,
          expectedRootPath,
          currentRootPath: useSidebarStore.getState().rootPath,
          files: bundle.files.length,
          repositories: bundle.repositories?.length ?? 0,
        });
        return null;
      }
      applyGitBundle(bundle, {
        reloadDiff: options.reloadDiff,
        persistSnapshot: includeNested,
        syncActiveRepo: includeNested,
        background,
        cacheOnly,
      });
      return bundle;
    })();
    gitBundlePendingRef.current = { cwd, includeNested, refresh, cacheOnly, promise };
    try {
      const result = await promise;
      if (gitBundleRequestIdRef.current === requestId && result && isCurrentSidebarRoot(expectedRootPath)) {
        markGitBundleLoaded({
          cached: result.cached,
          stale: result.stale,
          cacheAgeMs: result.cacheAgeMs,
          nestedDeferred: !includeNested || result.nestedDeferred,
          untrackedDeferred: result.untrackedDeferred,
        });
      } else if (gitBundleRequestIdRef.current === requestId && isCurrentSidebarRoot(expectedRootPath)) {
        setGitBundleLoading(false);
        setGitBundleSlow(false);
      }
      return result;
    } catch (err) {
      if (gitBundleRequestIdRef.current !== requestId || !isCurrentSidebarRoot(expectedRootPath) || isAbortError(err)) {
        logGitBundleClientEvent('aborted', {
          requestId,
          activeRequestId: gitBundleRequestIdRef.current,
          cwd,
          expectedRootPath,
          currentRootPath: useSidebarStore.getState().rootPath,
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
      logGitBundleClientEvent('error', {
        requestId,
        cwd,
        includeNested,
        refresh,
        background,
        message: err instanceof Error ? err.message : String(err),
      });
      if (!background) {
        setGitContext(null);
        setGitBundleError(err instanceof Error ? err.message : 'Failed to load Git changes');
      }
      return null;
    } finally {
      if (slowTimer !== null) window.clearTimeout(slowTimer);
      if (gitBundleAbortRef.current === controller) gitBundleAbortRef.current = null;
      if (gitBundlePendingRef.current?.promise === promise) gitBundlePendingRef.current = null;
      if (!background && gitBundleRequestIdRef.current === requestId && isCurrentSidebarRoot(expectedRootPath)) {
        setGitBundleLoading(false);
        setGitBundleSlow(false);
      }
    }
  }, [applyGitBundle, changedFiles.size, gitBundleLastLoadedAt, isCurrentSidebarRoot, markGitBundleLoaded, rootPath, setGitBundleError, setGitBundleLoading, setGitBundleSlow]);

  const refreshGitState = useCallback(async () => {
    if (!rootPath) return;
    await loadGitBundle(rootPath, { reloadDiff: true, includeNested: true, refresh: true });
  }, [loadGitBundle, rootPath]);

  const loadGitDetails = useCallback(async (cwd: string | undefined = rootPath ?? undefined) => {
    if (!cwd) return null;
    const expectedRootPath = rootPath;
    const requestId = gitDetailsRequestIdRef.current + 1;
    gitDetailsRequestIdRef.current = requestId;
    gitDetailsAbortRef.current?.abort();
    cancelIoSlot('right-sidebar-git-details');
    const controller = new AbortController();
    gitDetailsAbortRef.current = controller;
    setGitDetailsLoading(true);
    try {
      const context = await getGitContext(cwd, controller.signal, 'load_git_details', 'right-sidebar-git-details');
      if (gitDetailsRequestIdRef.current !== requestId || !isCurrentSidebarRoot(expectedRootPath)) return null;
      setGitRepositories((repos) => repos.map((repo) => (
        repo.root === context.root
          ? { ...repo, available: context.available, context, error: context.error }
          : repo
      )));
      setGitContext((current) => {
        if (current?.root && context.root && current.root !== context.root) return current;
        if (!current?.available || !context.available) return context;
        return { ...current, ...context };
      });
      return context;
    } catch (error) {
      if (isAbortError(error) || !isCurrentSidebarRoot(expectedRootPath)) return null;
      if (gitDetailsRequestIdRef.current === requestId) {
        setGitActionError(error instanceof Error ? error.message : 'Failed to load Git details');
      }
      return null;
    } finally {
      if (gitDetailsAbortRef.current === controller) gitDetailsAbortRef.current = null;
      if (gitDetailsRequestIdRef.current === requestId && isCurrentSidebarRoot(expectedRootPath)) setGitDetailsLoading(false);
    }
  }, [isCurrentSidebarRoot, rootPath]);

  useEffect(() => {
    if (!isOpen) {
      gitBundleRequestIdRef.current += 1;
      gitDetailsRequestIdRef.current += 1;
      untrackedRequestSeqRef.current += 1;
      gitBundleAbortRef.current?.abort();
      cancelIoSlot(buildGitBundleRequestSlotId(gitBundlePendingRef.current?.cwd ?? rootPath ?? undefined));
      gitBundlePendingRef.current = null;
      gitBundleAbortRef.current = null;
      gitDetailsAbortRef.current?.abort();
      cancelIoSlot('right-sidebar-git-details');
      gitDetailsAbortRef.current = null;
      for (const controller of untrackedAbortControllersRef.current.values()) controller.abort();
      for (const repoRoot of untrackedAbortControllersRef.current.keys()) cancelIoSlot(`right-sidebar-git-untracked:${repoRoot}`);
      untrackedAbortControllersRef.current.clear();
      untrackedRequestIdsRef.current.clear();
      branchAuditRequestIdRef.current += 1;
      branchAuditAbortRef.current?.abort();
      branchAuditAbortRef.current = null;
      recentCommitsRequestIdRef.current += 1;
      recentCommitsAbortRef.current?.abort();
      cancelIoSlot('right-sidebar-recent-commits');
      recentCommitsAbortRef.current = null;
      setGitDetailsLoading(false);
      setBranchAuditPreviewLoading(false);
      setBranchAuditPreviewError(null);
      setCommitDiff(null);
      setCommitDiffLoading(null);
      setCommitDiffError(null);
      setRecentCommitsOpen(false);
      setRecentCommitQuery('');
      setRecentCommits([]);
      setRecentCommitsLoading(false);
      setRecentCommitsLoadingMore(false);
      setRecentCommitsError(null);
      setRecentCommitsHasMore(false);
      setFileQuery('');
      setRightSearchOpen(false);
      setLineRange(null);
      setHasMountedGitPane(false);
      if (isMobile) setHasMountedDiffPane(false);
      // Keep diff view mode + wrap preference across close/open so the
      // user's chosen reading mode is preserved within a session.
    }
  }, [isMobile, isOpen, setRightSearchOpen]);

  // Focus the search input whenever the search box opens, regardless of whether
  // it was opened by the header button or a global keyboard shortcut.
  useEffect(() => {
    if (!searchOpen) return;
    const timer = setTimeout(() => {
      document.querySelector<HTMLInputElement>('input[data-right-search]')?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [searchOpen]);

  useEffect(() => {
    if (!isMobile) setMobileFilePreviewOpen(false);
  }, [isMobile]);

  const slideMobileDiffTo = useCallback((index: number) => {
    setMobileDiffSlideIndex(index);
    const swiper = mobileDiffSwiperRef.current;
    if (!swiper) return;
    swiper.update();
    swiper.slideTo(index, 0);
    window.requestAnimationFrame(() => {
      swiper.update();
      swiper.slideTo(index, 0);
    });
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    setMobileFilePreviewOpen(rightSidebarFilePreviewOpen);
    if (!rightSidebarFilePreviewOpen) {
      // The App-level close only flips state — also slide the swiper back to
      // the file list. Without this, mobileFileSlideIndex stays 1, which keeps
      // the FilePreview mounted and visible (filePath prop stays truthy), so
      // the preview pane looks stuck and the back button appears to need two
      // taps: one to clear App state, one to actually navigate back.
      setMobileFileSlideIndex(0);
      mobileFileSwiperRef.current?.slideTo(0);
      setLineRange(null);
    }
  }, [isMobile, rightSidebarFilePreviewOpen, rootPath]);

  useEffect(() => {
    if (rightSidebarFilePreviewCloseSignal !== undefined) {
      // Same slide-back as above, for close paths that only bump the signal
      // (e.g. Android/hardware back handled via popstate).
      setMobileFileSlideIndex(0);
      mobileFileSwiperRef.current?.slideTo(0);
      setMobileFilePreviewOpen(false);
      setLineRange(null);
    }
  }, [rightSidebarFilePreviewCloseSignal]);

  useEffect(() => {
    if (rightSidebarRepoPickerCloseSignal !== undefined) {
      // The open state is owned by App/history. This effect exists so the
      // component reacts consistently when Android Back closes the sheet.
      setRepoPickerAnchor(null);
    }
  }, [rightSidebarRepoPickerCloseSignal]);

  useEffect(() => {
    if (!isMobile && rightSidebarFilePreviewOpen) {
      onCloseRightSidebarFilePreview?.();
    }
  }, [isMobile, onCloseRightSidebarFilePreview, rightSidebarFilePreviewOpen]);

  useEffect(() => {
    setFileTreeWidthPx((width) => clampFileTreeWidth(width, drawerWidthPx));
  }, [drawerWidthPx]);

  const startFileTreeResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!isWide) return;
    event.preventDefault();
    fileTreeResizeRef.current = {
      startX: event.clientX,
      startWidth: fileTreeWidthPx,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [fileTreeWidthPx, isWide]);

  const handleFileTreeResizeMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const resize = fileTreeResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const nextWidth = clampFileTreeWidth(resize.startWidth + event.clientX - resize.startX, drawerWidthPx);
    setFileTreeWidthPx(nextWidth);
    writeCacheThrottled(FILE_TREE_WIDTH_STORAGE_KEY, nextWidth, FILE_TREE_WIDTH_WRITE_MS);
  }, [drawerWidthPx]);

  const stopFileTreeResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const resize = fileTreeResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    fileTreeResizeRef.current = null;
    flushCacheThrottled(FILE_TREE_WIDTH_STORAGE_KEY);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released if the browser cancelled drag.
    }
  }, []);

  const gitKnownUnavailable = Boolean(rootPath && gitBundleLastLoadedAt !== null && isConfirmedNonGitContext(gitContext));
  // Non-Git workspaces have no Git/Changes tabs. Only the medium-width desktop
  // layout keeps a separate "Preview" tab; mobile (overlay) and wide (side-by-
  // side) layouts render the preview without a dedicated tab.
  const effectiveRightTab: RightSidebarTab = gitKnownUnavailable
    ? (!isMobile && !isWide && rightTab === 'file' ? 'file' : 'files')
    : (isMobile || isWide) && rightTab === 'file' ? 'files' : rightTab;
  const gitPaneActive = effectiveRightTab === 'git';
  const filesPaneActive = effectiveRightTab === 'files';
  const diffPaneActive = effectiveRightTab === 'diff';
  const previewPaneActive = effectiveRightTab === 'file' && !isMobile && !isWide;
  useEffect(() => {
    if (!isMobile) {
      setMobileSidebarSettled(true);
      return;
    }
    if (!isOpen) {
      const handle = window.setTimeout(() => {
        setMobileSidebarSettled(false);
      }, MOBILE_SIDEBAR_CLOSE_SETTLE_DELAY_MS);
      return () => window.clearTimeout(handle);
    }
    setMobileSidebarSettled(false);
    const handle = window.setTimeout(() => {
      setMobileSidebarSettled(true);
    }, MOBILE_SIDEBAR_OPEN_SETTLE_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [isMobile, isOpen]);

  useEffect(() => {
    if (!isMobile || !diffPaneActive) return;
    const swiper = mobileDiffSwiperRef.current;
    if (!swiper) return;
    const frame = window.requestAnimationFrame(() => {
      swiper.update();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [diffPaneActive, isMobile]);

  // A non-git result can be stale. When the user opens Git/Changes, only sync
  // from the backend cache here; rebuilding that cache is reserved for manual
  // refresh so normal tab switches do not start expensive Git I/O.
  useEffect(() => {
    if (!gitKnownUnavailable || !rootPath || gitBundleLoading) return;
    const handle = window.setTimeout(() => {
      void loadGitBundle(rootPath, { includeNested: true, background: true, cacheOnly: true });
    }, 3_000);
    return () => window.clearTimeout(handle);
  }, [gitKnownUnavailable, rootPath, gitBundleLoading, loadGitBundle]);

  // Git/Changes share one cache-backed data source. Opening either pane restores
  // the frontend snapshot immediately, then performs a backend-cache sync only.
  // Manual refresh is the only path that rebuilds the backend Git cache.
  useEffect(() => {
    const shouldLoadGit = isOpen && (gitPaneActive || diffPaneActive);
    if (!shouldLoadGit || !rootPath || gitBundleLoading) return;
    if (!rootEntriesLoaded) return;
    if (lastAutoRefreshRootRef.current === rootPath) return;
    lastAutoRefreshRootRef.current = rootPath;
    const delay = gitPaneActive && !isMobile ? 0 : SIDEBAR_BACKGROUND_IO_DELAY_MS;
    const handle = window.setTimeout(() => {
      void loadGitBundle(rootPath, { includeNested: true, background: true, cacheOnly: true });
    }, delay);
    return () => {
      window.clearTimeout(handle);
    };
  }, [diffPaneActive, gitBundleLoading, gitPaneActive, isMobile, isOpen, loadGitBundle, rootEntriesLoaded, rootPath]);

  useEffect(() => {
    if (!isOpen || !gitPaneActive) return;
    if (!isMobile || mobileSidebarSettled) setHasMountedGitPane(true);
  }, [gitPaneActive, isMobile, isOpen, mobileSidebarSettled]);

  useEffect(() => {
    if (!isOpen || gitPaneActive) return;
    const handle = window.setTimeout(() => {
      setHasMountedGitPane(true);
    }, SIDEBAR_BACKGROUND_IO_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [gitPaneActive, isOpen]);

  useEffect(() => {
    if (!diffPaneActive) return;
    setHasMountedDiffPane(true);
  }, [diffPaneActive]);

  useEffect(() => {
    if (previewPaneActive) setHasMountedPreviewPane(true);
  }, [previewPaneActive]);

  const handleFileTreeScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (!fileTreeRoot) return;
    writeFileTreeScrollPosition(fileTreeRoot, event.currentTarget.scrollTop);
  }, [fileTreeRoot]);

  useEffect(() => {
    return () => {
      gitBundleAbortRef.current?.abort();
      flushCacheThrottled(FILE_TREE_SCROLL_STORAGE_KEY);
      flushCacheThrottled(FILE_PREVIEW_READING_STATE_STORAGE_KEY);
      flushCacheThrottled(FILE_TREE_WIDTH_STORAGE_KEY);
      flushCacheThrottled(CONTEXT_DRAFT_TEXT_STORAGE_KEY);
    };
  }, []);

  useEffect(() => {
    if (!fileTreeRoot || !rootEntriesLoaded) return;
    const savedTop = readFileTreeScrollCache()[fileTreeRoot]?.top;
    if (typeof savedTop !== 'number') return;
    let frame = window.requestAnimationFrame(() => {
      if (fileTreeScrollRef.current) fileTreeScrollRef.current.scrollTop = savedTop;
      frame = window.requestAnimationFrame(() => {
        if (fileTreeScrollRef.current) fileTreeScrollRef.current.scrollTop = savedTop;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fileTreeRoot, rootEntriesLoaded]);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    getLocalFileBrowserAvailability(controller.signal)
      .then((result) => setCanOpenInFileBrowser(Boolean(result.available)))
      .catch(() => setCanOpenInFileBrowser(false));
    return () => controller.abort();
  }, [isOpen]);

  const handleFileSelect = useCallback((path: string) => {
    selectFile(path);
    setLineRange(null);
    if (isMobile) {
      setMobileFilePreviewOpen(true);
      setMobileFileSlideIndex(1);
      mobileFileSwiperRef.current?.slideTo(1);
      onOpenRightSidebarFilePreview?.();
      return;
    }
    // In wide mode the preview is already visible alongside the tree, so we
    // don't need to switch tabs and steal focus from the user's browse flow.
    if (!isWide) setRightTab(isMobile ? 'files' : 'file');
  }, [isMobile, isWide, onOpenRightSidebarFilePreview, selectFile, setRightTab]);

  // Jump straight to a content-search match: open the file and ask the preview
  // to highlight and scroll to the matched line once its content has loaded.
  const handleContentMatchSelect = useCallback((path: string, line: number) => {
    selectFile(path);
    setScrollToLine(line);
    if (isMobile) {
      setMobileFilePreviewOpen(true);
      setMobileFileSlideIndex(1);
      mobileFileSwiperRef.current?.slideTo(1);
      onOpenRightSidebarFilePreview?.();
      return;
    }
    if (!isWide) setRightTab('file');
  }, [isMobile, isWide, onOpenRightSidebarFilePreview, selectFile, setRightTab]);

  const handleUploadFiles = useCallback(async (files: File[], directoryPath?: string) => {
    const targetDir = directoryPath || explorerRoot || rootPath;
    if (!targetDir || files.length === 0) return;
    setUploading(true);
    try {
      await uploadFiles(targetDir, files);
      invalidateDirectoryCache(targetDir, false);
    } catch (err) {
      setGitActionError(err instanceof Error ? err.message : t('rightSidebar.uploadFailed'));
      window.setTimeout(() => setGitActionError(null), 4000);
    } finally {
      setUploading(false);
    }
  }, [explorerRoot, rootPath, invalidateDirectoryCache, t]);

  const handleOpenInFileBrowser = useCallback(async (path: string) => {
    try {
      await openInFileBrowser(path);
    } catch (err) {
      setGitActionError(err instanceof Error ? err.message : t('fileTree.openInFileBrowserFailed'));
      window.setTimeout(() => setGitActionError(null), 4000);
    }
  }, [t]);

  const handleFileTreeDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true);
    }
  }, []);

  const handleFileTreeDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleFileTreeDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      void handleUploadFiles(Array.from(files));
    }
  }, [handleUploadFiles]);

  const markReferenceInserted = useCallback((key: string) => {
    setInsertedReferenceKey(key);
    window.setTimeout(() => setInsertedReferenceKey((current) => (current === key ? null : current)), 1400);
  }, []);

  const markReferenceCopied = useCallback((key: string) => {
    setCopiedReferenceKey(key);
    window.setTimeout(() => setCopiedReferenceKey((current) => (current === key ? null : current)), 1400);
  }, []);

  useEffect(() => {
    writeCache(CONTEXT_DRAFT_ENABLED_STORAGE_KEY, contextDraftEnabled);
  }, [contextDraftEnabled]);

  useEffect(() => {
    writeCache(CONTEXT_DRAFT_COLLAPSED_STORAGE_KEY, contextDraftCollapsed);
  }, [contextDraftCollapsed]);

  useEffect(() => {
    writeCacheThrottled(CONTEXT_DRAFT_TEXT_STORAGE_KEY, contextDraftText, CONTEXT_DRAFT_WRITE_MS);
  }, [contextDraftText]);

  // 草稿内容跨设备实时同步：服务端为真源（~/.termdock/context-draft.json），
  // control WebSocket 推送其它客户端的变更；本端改动防抖 500ms 上传。
  // lastSyncedDraftRef 记录「与服务端一致的文本」，用于跳过回声和自己的上传。
  const draftSyncClientIdRef = useRef<string>(crypto.randomUUID?.() ?? `draft-${Math.random().toString(36).slice(2)}`);
  const lastSyncedDraftRef = useRef<string | null>(null);
  const draftUploadTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getContextDraft()
      .then((server) => {
        if (cancelled) return;
        lastSyncedDraftRef.current = server.text;
        setContextDraftText((local) => {
          // 服务端有内容 → 以服务端为准；服务端为空但本地有 → 保留本地，
          // 后面的上传 effect 会把它推上去
          if (server.text && server.text !== local) return server.text;
          return local;
        });
      })
      .catch(() => { /* 拉取失败用本地缓存 */ });
    const unsubscribe = subscribeClientState((event) => {
      if (event.type !== 'context-draft') return;
      if (event.origin === draftSyncClientIdRef.current) return;
      lastSyncedDraftRef.current = event.text;
      setContextDraftText(event.text);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (draftUploadTimerRef.current !== null) {
        window.clearTimeout(draftUploadTimerRef.current);
        draftUploadTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (lastSyncedDraftRef.current === contextDraftText) return;
    if (draftUploadTimerRef.current !== null) window.clearTimeout(draftUploadTimerRef.current);
    const text = contextDraftText;
    draftUploadTimerRef.current = window.setTimeout(() => {
      draftUploadTimerRef.current = null;
      updateContextDraft(text, draftSyncClientIdRef.current)
        .then(() => {
          lastSyncedDraftRef.current = text;
        })
        .catch(() => { /* 同步失败，下次改动再试 */ });
    }, 500);
  }, [contextDraftText]);

  const routeReferenceText = useCallback((text: string, key: string, suffix?: string) => {
    if (!text) return;
    if (contextDraftEnabled) {
      setContextDraftText((current) => appendContextDraft(current, text) + (suffix ?? ''));
      // 触屏设备保持静息行：不展开编辑器、不弹软键盘，由草稿坞行内闪烁反馈追加
      if (!window.matchMedia('(pointer: coarse)').matches) {
        setContextDraftCollapsed(false);
        setDraftFocusRequest((n) => n + 1);
      }
    } else {
      window.dispatchEvent(new CustomEvent('termdock-insert-reference', {
        detail: { text: suffix ? text + suffix : text, focus: false },
      }));
    }
    markReferenceInserted(key);
  }, [contextDraftEnabled, markReferenceInserted]);

  const getPathReferenceText = useCallback((path: string) => {
    const absolutePath = resolveAbsoluteReferencePath(path, rootPath);
    return buildPromptReference(absolutePath, rootPath);
  }, [rootPath]);
  const getReferenceLongPressHandlers = useReferenceLongPressCopy(markReferenceCopied);

  const insertPathReference = useCallback((path: string, key?: string) => {
    const absolutePath = resolveAbsoluteReferencePath(path, rootPath);
    routeReferenceText(buildReferenceInputText(absolutePath, rootPath), key ?? `path:${absolutePath}`);
  }, [rootPath, routeReferenceText]);

  const insertReferenceText = useCallback((text: string, key: string) => {
    if (!text) return;
    // 多行代码块（有 \n）插入末尾加换行，单行路径不加
    const suffix = text.includes('\n') ? '\n' : undefined;
    routeReferenceText(text.endsWith('\n') || text.endsWith(' ') ? text : `${text} `, key, suffix);
  }, [routeReferenceText]);

  const insertContextText = useCallback((label: string, text: string, key?: string) => {
    if (!text) return;
    // 大段内容（agent 回复、diff 等）插入末尾加换行
    routeReferenceText(text.endsWith(' ') ? text : `${text} `, key ?? `context:${label}`, '\n');
  }, [routeReferenceText]);

  const sendContextDraftToTerminal = useCallback((submit: boolean) => {
    const payload = buildDraftTerminalPayload(contextDraftText, submit);
    if (!payload) return;
    // 多行草稿：告诉终端走 bracketed-paste 包裹，避免 \n 被 PTY 当
    // 行分隔符，让整段草稿作为一条消息发送而不是拆成多条。
    const paste = submit && contextDraftText.trim().includes('\n');
    // 断联的 session 无法接收输入：终端侧会拒绝并回 ack。只有 ack 成功
    // 才清空草稿并收起；失败（含超时无活跃终端）保留草稿并提示。
    const nonce = `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('termdock-insert-reference-ack', handleAck);
      window.clearTimeout(timeoutId);
      if (ok) {
        setDraftInsertFailed(false);
        setContextDraftText('');
        setContextDraftCollapsed(true);
      } else {
        setDraftInsertFailed(true);
        setContextDraftCollapsed(false);
      }
    };
    const handleAck = (event: Event) => {
      const detail = (event as CustomEvent<{ nonce?: string; ok?: boolean }>).detail;
      if (detail?.nonce !== nonce) return;
      settle(detail.ok === true);
    };
    const timeoutId = window.setTimeout(() => settle(false), 1500);
    window.addEventListener('termdock-insert-reference-ack', handleAck);
    setDraftInsertFailed(false);
    window.dispatchEvent(new CustomEvent('termdock-insert-reference', {
      detail: { text: payload, focus: false, paste, nonce },
    }));
  }, [contextDraftText]);

  const rootName = useMemo(() => {
    if (!rootPath) return t('rightSidebar.workspace');
    return getPathBasename(rootPath);
  }, [rootPath, t]);

  const explorerName = useMemo(() => getPathBasename(fileTreeRoot) || rootName, [fileTreeRoot, rootName]);
  const explorerParentPath = useMemo(() => getParentPath(fileTreeRoot), [fileTreeRoot]);
  const pinnedExplorerRoots = useMemo(() => (rootPath ? pinnedExplorerRootsCache[rootPath] ?? [] : []), [pinnedExplorerRootsCache, rootPath]);
  const pinnedExplorerRootSet = useMemo(() => new Set(pinnedExplorerRoots.map((entry) => entry.path)), [pinnedExplorerRoots]);
  const fileTreeRootPinned = Boolean(fileTreeRoot && pinnedExplorerRootSet.has(fileTreeRoot));
  const canPinFileTreeRoot = Boolean(rootPath && fileTreeRoot && fileTreeRoot !== rootPath);
  const browsingOutsideProject = Boolean(rootPath && explorerRoot && explorerRoot !== rootPath);
  const fileTreeRootReferenceKey = fileTreeRoot ? `path:${fileTreeRoot}` : null;
  const changeAuditPromptKey = 'context:change-audit';

  const goToExplorerParent = useCallback(() => {
    if (explorerParentPath) setExplorerRoot(explorerParentPath);
  }, [explorerParentPath, setExplorerRoot]);

  const goToProjectRoot = useCallback(() => {
    resetExplorerToProject();
  }, [resetExplorerToProject]);

  const refreshExplorerRoot = useCallback(() => {
    if (!fileTreeRoot) return;
    // Recursive: expanded subdirectories keep their own cached listings, so a
    // root-only invalidation left them stale and the refresh appeared to do
    // nothing. Expanded dirs whose cache entry disappears refetch themselves
    // (FileTreeItem's isExpanded && !children effect).
    invalidateDirectoryCache(fileTreeRoot, true);
    // Also bump the global watch epoch so the file preview and markdown
    // images reload too — previously refresh only repainted the tree while
    // already-loaded content kept showing stale bytes.
    bumpFileWatchEpoch();
  }, [bumpFileWatchEpoch, fileTreeRoot, invalidateDirectoryCache]);

  const togglePinnedExplorerRoot = useCallback(() => {
    if (!fileTreeRoot || !canPinFileTreeRoot) return;
    if (fileTreeRootPinned) unpinExplorerRoot(fileTreeRoot);
    else pinExplorerRoot(fileTreeRoot, 'directory');
  }, [canPinFileTreeRoot, fileTreeRoot, fileTreeRootPinned, pinExplorerRoot, unpinExplorerRoot]);

  const openDirectoryAsExplorerRoot = useCallback((path: string) => {
    setExplorerRoot(path);
    setFileQuery('');
  }, [setExplorerRoot]);

  const togglePinnedDirectory = useCallback((path: string) => {
    if (!rootPath || path === rootPath) return;
    if (pinnedExplorerRootSet.has(path)) unpinExplorerRoot(path);
    else pinExplorerRoot(path, 'directory');
  }, [pinExplorerRoot, pinnedExplorerRootSet, rootPath, unpinExplorerRoot]);

  const togglePinnedFile = useCallback((path: string) => {
    if (!rootPath || !path) return;
    if (pinnedExplorerRootSet.has(path)) unpinExplorerRoot(path);
    else pinExplorerRoot(path, 'file');
  }, [pinExplorerRoot, pinnedExplorerRootSet, rootPath, unpinExplorerRoot]);

  const expandedPaths = useSidebarStore((s) => s.expandedPaths);
  // Watch ONLY the directories the tree has actually expanded (plus the
  // selected file's parent when it lives outside the explorer root). The
  // server-side watcher recursively scans the full subtree of every root it
  // subscribes to on a libuv threadpool worker — watching the whole explorer
  // root (e.g. /home/qiao with 300k+ directories) blocks a worker for minutes
  // per subscription, exhausts inotify, and eventually freezes every fs
  // request. The key is a stable sorted string so selecting a file (which
  // changes selectedFilePath) does not tear down and re-establish the stream.
  const watchedFileRootsKey = useMemo(() => {
    const roots = new Set<string>();
    if (filesPaneActive && fileTreeRoot) {
      const treeRoot = `${fileTreeRoot.replace(/\/+$/, '')}/`;
      for (const expandedPath of expandedPaths) {
        if (expandedPath === fileTreeRoot) continue;
        if (expandedPath.startsWith(treeRoot)) roots.add(expandedPath);
      }
    }
    // The previewed file can live outside the explorer root (e.g. browsing a
    // subdirectory while a project file is open); keep its parent watched so
    // external edits still reload the preview.
    if ((filesPaneActive || previewPaneActive) && rootPath && selectedFilePath) {
      const selectedAbsolutePath = selectedFilePath.startsWith('/') ? selectedFilePath : `${rootPath}/${selectedFilePath}`;
      const selectedParent = getParentPath(selectedAbsolutePath);
      // A file directly inside the explorer root needs no extra watcher — the
      // root itself is deliberately not watched (it can be the whole home dir).
      if (selectedParent && selectedParent !== fileTreeRoot) roots.add(selectedParent);
    }
    return [...roots].sort().join('\n');
  }, [expandedPaths, filesPaneActive, previewPaneActive, fileTreeRoot, rootPath, selectedFilePath]);

  useEffect(() => {
    const watchedFileRoots = watchedFileRootsKey ? watchedFileRootsKey.split('\n') : [];
    if (!isOpen || watchedFileRoots.length === 0) return;
    const controller = new AbortController();
    let cancelled = false;
    let startTimer = 0;
    let retryTimer = 0;
    setFileWatchError(null);

    const runWatchLoop = async () => {
      let attempt = 0;
      while (!cancelled && !controller.signal.aborted) {
        if (attempt > 0) {
          // Reconnecting: events fired while the stream was down are lost
          // forever, so self-heal before retrying — drop cached listings under
          // the watched roots (expanded dirs refetch themselves) and bump the
          // epoch so previews / markdown images reload.
          for (const root of watchedFileRoots) invalidateDirectoryCache(root, true);
          bumpFileWatchEpoch();
        }
        let failure: unknown = null;
        try {
          // Established (or about to): clear any error from a previous
          // disconnect; a failed attempt re-sets it below.
          setFileWatchError(null);
          await watchFileSystem(watchedFileRoots, (events) => {
            applyFileWatchEvents(events);
          }, controller.signal);
          // A clean resolve means the server closed the stream (deploy,
          // restart) — treat it as a disconnect and reconnect as well.
          failure = new Error('File watch stream ended');
        } catch (error) {
          failure = error;
        }
        if (cancelled || controller.signal.aborted || isAbortError(failure)) return;
        setFileWatchError(failure instanceof Error ? failure.message : 'File watching unavailable');
        const delay = FILE_WATCH_RECONNECT_DELAYS_MS[Math.min(attempt, FILE_WATCH_RECONNECT_DELAYS_MS.length - 1)];
        attempt += 1;
        await new Promise<void>((resolve) => {
          retryTimer = window.setTimeout(resolve, delay);
        });
      }
    };

    startTimer = window.setTimeout(() => {
      if (cancelled) return;
      void runWatchLoop();
    }, SIDEBAR_BACKGROUND_IO_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      window.clearTimeout(retryTimer);
      controller.abort();
    };
  }, [applyFileWatchEvents, bumpFileWatchEpoch, invalidateDirectoryCache, isOpen, watchedFileRootsKey]);

  useEffect(() => {
    if (!rootPath) return;
    if (branchAuditModuleHydratedRootRef.current !== rootPath) return;
    if (branchAuditModuleSkipWriteRootRef.current === rootPath) {
      branchAuditModuleSkipWriteRootRef.current = null;
      return;
    }
    const cache = readBranchAuditModuleCache();
    writeCacheThrottled(BRANCH_AUDIT_MODULE_STORAGE_KEY, {
      ...cache,
      [rootPath]: {
        selectedRepoRoots: branchAuditRepoRoots,
        repoTargetBranches: branchAuditRepoBranches,
        repoBaseBranches: branchAuditRepoBaseBranches,
        previewEntries: branchAuditPreviewEntries,
        selectedPreviewKey: branchAuditPreviewDiff && branchAuditDetailOpen ? selectedBranchAuditHistoryKey : null,
        selectedPreviewFileKey: branchAuditPreviewDiff && branchAuditDetailOpen ? selectedBranchAuditFileKey : null,
        previewDetailOpen: Boolean(branchAuditPreviewDiff && branchAuditDetailOpen),
        previewScrollTops: branchAuditPreviewScrollTops,
        previewMobileSlideIndex: 1,
        includeUncommitted: branchAuditIncludeUncommitted,
        updatedAt: Date.now(),
      },
    }, BRANCH_AUDIT_MODULE_CACHE_WRITE_MS);
  }, [branchAuditDetailOpen, branchAuditIncludeUncommitted, branchAuditPreviewDiff, branchAuditPreviewEntries, branchAuditPreviewScrollTops, branchAuditRepoBaseBranches, branchAuditRepoBranches, branchAuditRepoRoots, rootPath, selectedBranchAuditFileKey, selectedBranchAuditHistoryKey]);

  const changedSummary = useMemo(() => summarizeChangedFiles(changedFiles.values()), [changedFiles]);

  const gitRepositoryByRoot = useMemo(() => {
    const map = new Map<string, GitRepositoryBundle>();
    for (const repo of gitRepositories) map.set(repo.root, repo);
    return map;
  }, [gitRepositories]);

  const activeGitRepoSummary = useMemo(() => (
    activeGitRepoRoot ? gitRepoFilters.find((repo) => repo.root === activeGitRepoRoot) ?? null : null
  ), [activeGitRepoRoot, gitRepoFilters]);

  const selectedChangedFile = useMemo(() => {
    if (!selectedFilePath) return null;
    return Array.from(changedFiles.values()).find((file) => (
      file.path === selectedFilePath || file.absolutePath === selectedFilePath
    )) ?? null;
  }, [changedFiles, selectedFilePath]);

  const gitActionRepoOptions = useMemo<GitPickerOption[]>(() => {
    const byRoot = new Map<string, GitRepositoryBundle>();
    for (const repo of gitRepositories) {
      if (repo.available && repo.context?.available) byRoot.set(repo.root, repo);
    }
    if (byRoot.size === 0 && gitContext?.available && gitContext.root) {
      byRoot.set(gitContext.root, {
        id: gitContext.root,
        root: gitContext.root,
        relativeRoot: '.',
        name: rootName,
        depth: 0,
        nested: false,
        available: true,
        files: Array.from(changedFiles.values()).filter((file) => getChangedFileRepoRoot(file, rootPath) === gitContext.root),
        context: gitContext,
      });
    }
    return Array.from(byRoot.values())
      .sort((a, b) => {
        if (a.root === rootPath) return -1;
        if (b.root === rootPath) return 1;
        return (a.relativeRoot || a.name).localeCompare(b.relativeRoot || b.name);
      })
      .map((repo) => {
        const label = repo.relativeRoot === '.' ? rootName : (repo.relativeRoot || repo.name || getPathBasename(repo.root));
        const staged = countStagedChanges(repo.files);
        const total = repo.files.length;
        return {
          value: repo.root,
          label,
          meta: [
            repo.context?.branch,
            total > 0 ? t('rightSidebar.repoChangedCount', { count: total }) : null,
            staged > 0 ? t('rightSidebar.repoStagedCount', { count: staged }) : null,
          ].filter(Boolean).join(' · '),
        };
      });
  }, [changedFiles, gitContext, gitRepositories, rootName, rootPath, t]);

  const activeGitActionRepoRoot = useMemo(() => {
    if (activeGitRepoRoot && gitActionRepoOptions.some((repo) => repo.value === activeGitRepoRoot)) return activeGitRepoRoot;
    if (selectedChangedFile?.repoRoot && gitActionRepoOptions.some((repo) => repo.value === selectedChangedFile.repoRoot)) return selectedChangedFile.repoRoot;
    if (gitActionRepoOptions.length === 1) return gitActionRepoOptions[0].value;
    if (gitActionRepoOptions.length > 1) return gitActionRepoOptions[0].value;
    return null;
  }, [activeGitRepoRoot, gitActionRepoOptions, selectedChangedFile?.repoRoot]);

  const activeGitActionRepo = activeGitActionRepoRoot ? gitRepositoryByRoot.get(activeGitActionRepoRoot) ?? null : null;
  const activeGitActionContext = activeGitActionRepo?.context?.available
    ? activeGitActionRepo.context
    : activeGitActionRepoRoot === gitContext?.root ? gitContext : null;
  const requiresGitActionRepoSelection = gitActionRepoOptions.length > 0 && !activeGitActionRepoRoot;
  const activeGitActionFiles = useMemo(() => (
    requiresGitActionRepoSelection
      ? []
      : activeGitActionRepoRoot
      ? Array.from(changedFiles.values()).filter((file) => getChangedFileRepoRoot(file, rootPath) === activeGitActionRepoRoot)
      : Array.from(changedFiles.values())
  ), [activeGitActionRepoRoot, changedFiles, requiresGitActionRepoSelection, rootPath]);
  const activeGitActionSummary = useMemo(() => summarizeChangedFiles(activeGitActionFiles), [activeGitActionFiles]);
  const activeGitActionContextReady = Boolean(
    activeGitActionContext?.available
      && activeGitActionContext.root
      && activeGitActionRepoRoot
      && activeGitActionContext.root === activeGitActionRepoRoot,
  );
  const activeGitActionRepoLabel = activeGitActionRepoRoot
    ? gitActionRepoOptions.find((repo) => repo.value === activeGitActionRepoRoot)?.label ?? getPathBasename(activeGitActionRepoRoot)
    : t('rightSidebar.gitRepositoryPlaceholder');
  const activeGitActionBranchLabel = activeGitActionContextReady
    ? (activeGitActionContext?.branch ?? 'HEAD')
    : requiresGitActionRepoSelection
      ? t('rightSidebar.selectRepositoryForGitActions')
      : gitDetailsLoading
        ? t('rightSidebar.gitActionRunning')
        : 'HEAD';
  const gitDetailsLoaded = Boolean(
    activeGitActionContext?.available
      && activeGitActionContext.root === activeGitActionRepoRoot
      && activeGitActionContext.status,
  );

  useEffect(() => {
    recentCommitsStateRef.current = {
      count: recentCommits.length,
      loading: recentCommitsLoading,
      loadingMore: recentCommitsLoadingMore,
      hasMore: recentCommitsHasMore,
    };
  }, [recentCommits.length, recentCommitsHasMore, recentCommitsLoading, recentCommitsLoadingMore]);

  useEffect(() => {
    recentCommitsRequestIdRef.current += 1;
    recentCommitsAbortRef.current?.abort();
    cancelIoSlot('right-sidebar-recent-commits');
    recentCommitsAbortRef.current = null;
    setRecentCommitQuery('');
    setRecentCommits([]);
    setRecentCommitsLoading(false);
    setRecentCommitsLoadingMore(false);
    setRecentCommitsError(null);
    setRecentCommitsHasMore(false);
  }, [activeGitActionRepoRoot]);

  const loadRecentCommits = useCallback(async (options: { reset?: boolean } = {}) => {
    if (!rootPath || !activeGitActionRepoRoot || requiresGitActionRepoSelection) return;
    const reset = options.reset ?? false;
    const snapshot = recentCommitsStateRef.current;
    const skip = reset ? 0 : snapshot.count;
    if (!reset && (snapshot.loading || snapshot.loadingMore || !snapshot.hasMore)) return;
    const requestId = recentCommitsRequestIdRef.current + 1;
    recentCommitsRequestIdRef.current = requestId;
    recentCommitsAbortRef.current?.abort();
    cancelIoSlot('right-sidebar-recent-commits');
    const controller = new AbortController();
    recentCommitsAbortRef.current = controller;
    if (reset) setRecentCommitsLoading(true);
    else setRecentCommitsLoadingMore(true);
    setRecentCommitsError(null);
    try {
      const result = await getRecentCommits({
        cwd: rootPath,
        repoRoot: activeGitActionRepoRoot,
        limit: RECENT_COMMITS_PAGE_SIZE,
        skip,
        query: deferredRecentCommitQuery.trim(),
        requestSlotId: 'right-sidebar-recent-commits',
      }, controller.signal);
      if (recentCommitsRequestIdRef.current !== requestId) return;
      if (!result.available) {
        setRecentCommitsError(result.error ?? 'Recent commits are unavailable');
        if (reset) setRecentCommits([]);
        setRecentCommitsHasMore(false);
        return;
      }
      setRecentCommits((current) => (reset ? result.commits : [...current, ...result.commits]));
      setRecentCommitsHasMore(result.hasMore);
    } catch (error) {
      if (recentCommitsRequestIdRef.current !== requestId || isAbortError(error)) return;
      setRecentCommitsError(error instanceof Error ? error.message : 'Failed to load recent commits');
      if (reset) setRecentCommits([]);
      setRecentCommitsHasMore(false);
    } finally {
      if (recentCommitsAbortRef.current === controller) recentCommitsAbortRef.current = null;
      if (recentCommitsRequestIdRef.current === requestId) {
        setRecentCommitsLoading(false);
        setRecentCommitsLoadingMore(false);
      }
    }
  }, [activeGitActionRepoRoot, deferredRecentCommitQuery, requiresGitActionRepoSelection, rootPath]);

  useEffect(() => {
    if (!recentCommitsOpen) return;
    void loadRecentCommits({ reset: true });
  }, [deferredRecentCommitQuery, loadRecentCommits, recentCommitsOpen]);

  const handleRecentCommitsScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight < target.scrollHeight - 48) return;
    void loadRecentCommits({ reset: false });
  }, [loadRecentCommits]);

  useEffect(() => {
    if (!activeGitActionRepoRoot || !gitContext?.available || !gitPaneActive || !hasMountedGitPane || gitDetailsLoaded || gitDetailsLoading || requiresGitActionRepoSelection) return;
    void loadGitDetails(activeGitActionRepoRoot);
  }, [activeGitActionRepoRoot, gitContext?.available, gitDetailsLoaded, gitDetailsLoading, gitPaneActive, hasMountedGitPane, loadGitDetails, requiresGitActionRepoSelection]);

  useEffect(() => {
    if (!isOpen || (!diffPaneActive && !gitPaneActive) || !rootPath) return;
    void loadChangeAuditRecords();
  }, [diffPaneActive, gitPaneActive, isOpen, loadChangeAuditRecords, rootPath]);

  useEffect(() => {
    if (!isOpen || !gitPaneActive || !hasMountedGitPane || !branchAuditModuleOpen || !rootPath) return;
    void loadBranchAuditRecords(null);
  }, [branchAuditModuleOpen, gitPaneActive, hasMountedGitPane, isOpen, loadBranchAuditRecords, rootPath]);

  const activeGitRepoIndex = useMemo(() => {
    if (!activeGitRepoRoot) return 0;
    const index = gitRepoFilters.findIndex((repo) => repo.root === activeGitRepoRoot);
    return index >= 0 ? index + 1 : 0;
  }, [activeGitRepoRoot, gitRepoFilters]);

  const getFirstChangedFileSelectionPathForRepo = useCallback((repoRoot: string | null) => {
    if (!repoRoot) return null;
    const file = Array.from(changedFiles.values())
      .filter((candidate) => getChangedFileRepoRoot(candidate, rootPath) === repoRoot)
      .sort((a, b) => a.path.localeCompare(b.path))[0];
    return file ? getChangedFileSelectionPath(file) : null;
  }, [changedFiles, rootPath]);

  const showGitRepoFilter = gitRepoFilters.length > 1;

  const gitRepoSwitcherItems = useMemo(() => [
    { root: null as string | null, label: t('rightSidebar.allRepositories'), count: changedFiles.size, branch: null as string | null },
    ...gitRepoFilters.map((repo) => ({ root: repo.root, label: repo.label, count: repo.count, branch: repo.branch ?? null })),
  ], [changedFiles.size, gitRepoFilters, t]);

  const activeGitRepoSwitcherItem = gitRepoSwitcherItems[activeGitRepoIndex] ?? gitRepoSwitcherItems[0];
  const showChangeAiMode = Boolean(activeGitRepoRoot);

  useEffect(() => {
    if (activeGitRepoRoot && !gitActionRepoOptions.some((repo) => repo.value === activeGitRepoRoot)) {
      setActiveGitRepoRoot(null);
      writeActiveGitRepoRoot(rootPath, null);
    }
    setChangeAuditRepoRoots((current) => current.filter((repoRoot) => gitRepoFilters.some((repo) => repo.root === repoRoot)));
  }, [activeGitRepoRoot, gitActionRepoOptions, gitRepoFilters, rootPath]);

  const switchBranchOptions = useMemo<GitPickerOption[]>(() => {
    const values = new Set<string>();
    if (activeGitActionContext?.branch) values.add(activeGitActionContext.branch);
    for (const branch of activeGitActionContext?.branches ?? []) values.add(branch);
    return Array.from(values).map((branch) => ({
      value: branch,
      label: branch,
      meta: branch === activeGitActionContext?.branch ? t('rightSidebar.pushCurrentBranchBadge') : undefined,
    }));
  }, [activeGitActionContext?.branch, activeGitActionContext?.branches, t]);

  const pushRemoteOptions = useMemo<GitPickerOption[]>(() => {
    const values = new Set<string>();
    if (activeGitActionContext?.upstreamRemote) values.add(activeGitActionContext.upstreamRemote);
    for (const remote of activeGitActionContext?.remotes ?? []) values.add(remote);
    return Array.from(values).map((remote) => ({
      value: remote,
      label: remote,
      meta: remote === activeGitActionContext?.upstreamRemote ? t('rightSidebar.pushUpstreamBadge') : undefined,
    }));
  }, [activeGitActionContext?.remotes, activeGitActionContext?.upstreamRemote, t]);
  const showPushRemotePicker = pushRemoteOptions.length > 1;

  const pushBranchOptions = useMemo<GitPickerOption[]>(() => {
    const options: GitPickerOption[] = [];
    const seen = new Set<string>();
    const addOption = (branch: string | null | undefined, meta?: string) => {
      if (!branch || seen.has(branch)) return;
      seen.add(branch);
      options.push({ value: branch, label: branch, meta });
    };
    addOption(activeGitActionContext?.upstreamBranch, activeGitActionContext?.upstreamBranch ? t('rightSidebar.pushUpstreamBadge') : undefined);
    addOption(activeGitActionContext?.branch, activeGitActionContext?.branch ? t('rightSidebar.pushCurrentBranchBadge') : undefined);
    for (const branch of activeGitActionContext?.branches ?? []) addOption(branch, branch === activeGitActionContext?.branch ? t('rightSidebar.pushCurrentBranchBadge') : 'local');
    const upstreamRemote = activeGitActionContext?.upstreamRemote;
    for (const remoteBranch of activeGitActionContext?.remoteBranches ?? []) {
      const slashIndex = remoteBranch.indexOf('/');
      const remote = slashIndex >= 0 ? remoteBranch.slice(0, slashIndex) : null;
      const branch = slashIndex >= 0 ? remoteBranch.slice(slashIndex + 1) : remoteBranch;
      if (!upstreamRemote || remote === upstreamRemote) addOption(branch, 'remote');
    }
    return options;
  }, [activeGitActionContext?.branch, activeGitActionContext?.branches, activeGitActionContext?.remoteBranches, activeGitActionContext?.upstreamBranch, activeGitActionContext?.upstreamRemote, t]);

  const branchAuditScopeRepos = useMemo<AuditPromptScopeRepoOption[]>(() => (
    gitActionRepoOptions.map((repo) => {
      const bundle = gitRepositoryByRoot.get(repo.value);
      return {
        root: repo.value,
        label: repo.label,
        branch: bundle?.context?.branch ?? null,
      };
    })
  ), [gitActionRepoOptions, gitRepositoryByRoot]);
  useEffect(() => {
    if (branchAuditScopeRepos.length === 0) return;
    setBranchAuditRepoBranches((current) => {
      let changed = false;
      const next = { ...current };
      const validRoots = new Set(branchAuditScopeRepos.map((repo) => repo.root));
      for (const repoRoot of Object.keys(next)) {
        if (!validRoots.has(repoRoot)) {
          delete next[repoRoot];
          changed = true;
        }
      }
      for (const repo of branchAuditScopeRepos) {
        if (!next[repo.root] && repo.branch) {
          next[repo.root] = repo.branch;
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setBranchAuditRepoBaseBranches((current) => {
      let changed = false;
      const next = { ...current };
      const validRoots = new Set(branchAuditScopeRepos.map((repo) => repo.root));
      for (const repoRoot of Object.keys(next)) {
        if (!validRoots.has(repoRoot)) {
          delete next[repoRoot];
          changed = true;
        }
      }
      for (const repo of branchAuditScopeRepos) {
        const context = gitRepositoryByRoot.get(repo.root)?.context;
        if (next[repo.root] && isSameBranchRef(next[repo.root], context?.branch)) {
          delete next[repo.root];
          changed = true;
        }
        if (next[repo.root]) continue;
        const fallbackBase = pickBranchAuditFallbackBase(context);
        if (fallbackBase) {
          next[repo.root] = fallbackBase;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [branchAuditScopeRepos, gitRepositoryByRoot]);
  const branchAuditTargetRepoRoots = useMemo(() => {
    const validRoots = new Set(branchAuditScopeRepos.map((repo) => repo.root));
    return branchAuditRepoRoots.filter((repoRoot) => validRoots.has(repoRoot));
  }, [branchAuditRepoRoots, branchAuditScopeRepos]);
  const branchAuditTargetsAllRepos = branchAuditTargetRepoRoots.length === 0;
  const branchAuditTargetRepos = useMemo(() => (
    (branchAuditTargetsAllRepos ? branchAuditScopeRepos : branchAuditScopeRepos.filter((repo) => branchAuditTargetRepoRoots.includes(repo.root)))
  ), [branchAuditScopeRepos, branchAuditTargetRepoRoots, branchAuditTargetsAllRepos]);
  const branchAuditReadyRepos = useMemo(() => (
    branchAuditTargetRepos.filter((repo) => Boolean(branchAuditRepoBaseBranches[repo.root]?.trim()))
  ), [branchAuditRepoBaseBranches, branchAuditTargetRepos]);
  const branchAuditMissingBaseRepos = useMemo(() => (
    branchAuditTargetRepos.filter((repo) => !branchAuditRepoBaseBranches[repo.root]?.trim())
  ), [branchAuditRepoBaseBranches, branchAuditTargetRepos]);
  const loadBranchAuditRepoDetails = useCallback(async (repoRoot: string) => {
    if (!repoRoot || branchAuditDetailsLoadingRootsRef.current.has(repoRoot)) return;
    const existing = gitRepositoryByRoot.get(repoRoot)?.context;
    if ((existing?.branches?.length ?? 0) > 0 || (existing?.remoteBranches?.length ?? 0) > 0 || existing?.upstream) return;
    const expectedRootPath = rootPath;
    branchAuditDetailsLoadingRootsRef.current.add(repoRoot);
    setBranchAuditDetailsLoadingRoots((current) => new Set(current).add(repoRoot));
    try {
      const context = await getGitContext(repoRoot, undefined, 'load_branch_audit_repo_details', `right-sidebar-branch-audit-details:${repoRoot}`);
      if (!context.available || !isCurrentSidebarRoot(expectedRootPath)) return;
      setGitRepositories((repositories) => repositories.map((repo) => (
        repo.root === repoRoot
          ? { ...repo, available: true, context: { ...repo.context, ...context }, error: undefined }
          : repo
      )));
      setBranchAuditRepoBranches((current) => {
        if (current[repoRoot] || !context.branch) return current;
        return { ...current, [repoRoot]: context.branch };
      });
      setBranchAuditRepoBaseBranches((current) => {
        if (current[repoRoot]) return current;
        const fallbackBase = pickBranchAuditFallbackBase(context);
        return fallbackBase ? { ...current, [repoRoot]: fallbackBase } : current;
      });
    } catch (error) {
      if (!isAbortError(error)) {
        console.warn('[RightSidebar] Failed to load branch audit repo details', repoRoot, error);
      }
    } finally {
      branchAuditDetailsLoadingRootsRef.current.delete(repoRoot);
      setBranchAuditDetailsLoadingRoots((current) => {
        const next = new Set(current);
        next.delete(repoRoot);
        return next;
      });
    }
  }, [gitRepositoryByRoot, isCurrentSidebarRoot, rootPath]);

  useEffect(() => {
    if (!branchAuditScopeOpen) return;
    for (const repo of branchAuditTargetRepos) {
      void loadBranchAuditRepoDetails(repo.root);
    }
  }, [branchAuditScopeOpen, branchAuditTargetRepos, loadBranchAuditRepoDetails]);

  useEffect(() => {
    if (!activeGitActionContextReady || !activeGitActionContext) return;
    setSwitchBranch(activeGitActionContext.branch || (activeGitActionContext.branches?.[0] ?? ''));
    setPushRemote(activeGitActionContext.upstreamRemote || (activeGitActionContext.remotes?.includes('origin') ? 'origin' : activeGitActionContext.remotes?.[0] ?? ''));
    setPushBranch(activeGitActionContext.upstreamBranch || activeGitActionContext.branch || (activeGitActionContext.branches?.[0] ?? ''));
  }, [activeGitActionContext, activeGitActionContextReady]);

  const pushSyncInfo = useMemo(() => {
    if (requiresGitActionRepoSelection) {
      return { text: t('rightSidebar.selectRepositoryForGitActions'), className: 'bg-[rgb(var(--warning-rgb)_/_0.12)] text-[color:var(--warning)]' };
    }
    if (!gitDetailsLoaded || gitDetailsLoading) {
      return { text: t('common.loading'), className: 'bg-surface-2 text-muted-foreground' };
    }
    if (!activeGitActionContext?.upstream) {
      return { text: t('rightSidebar.pushNoUpstream'), className: 'bg-surface-2 text-muted-foreground' };
    }
    const ahead = activeGitActionContext.ahead ?? 0;
    const behind = activeGitActionContext.behind ?? 0;
    if (ahead > 0 && behind > 0) {
      return { text: t('rightSidebar.pushDivergedCount', { ahead, behind }), className: 'bg-destructive/10 text-destructive' };
    }
    if (ahead > 0) {
      return { text: t('rightSidebar.pushAheadCount', { count: ahead }), className: 'bg-accent/10 text-accent' };
    }
    if (behind > 0) {
      return { text: t('rightSidebar.pushBehindCount', { count: behind }), className: 'bg-surface-2 text-[color:var(--diff-hunk-accent)]' };
    }
    return { text: t('rightSidebar.pushUpToDate'), className: 'bg-surface-2 text-muted-foreground' };
  }, [activeGitActionContext?.ahead, activeGitActionContext?.behind, activeGitActionContext?.upstream, gitDetailsLoaded, gitDetailsLoading, requiresGitActionRepoSelection, t]);

  const openRepoPicker = useCallback((event?: MouseEvent<HTMLButtonElement>) => {
    if (event && !isMobile) {
      const rect = event.currentTarget.getBoundingClientRect();
      setRepoPickerAnchor({
        x: Math.min(rect.left, window.innerWidth - 352),
        y: Math.min(rect.bottom + 6, window.innerHeight - 64),
      });
    } else {
      setRepoPickerAnchor(null);
    }
    onOpenRightSidebarRepoPicker?.();
  }, [isMobile, onOpenRightSidebarRepoPicker]);

  const closeRepoPicker = useCallback(() => {
    setRepoPickerAnchor(null);
    onCloseRightSidebarRepoPicker?.();
  }, [onCloseRightSidebarRepoPicker]);

  function renderRepoSwitcherButton() {
    if (!showGitRepoFilter) return null;
    const label = activeGitRepoSwitcherItem?.label ?? t('rightSidebar.allRepositories');
    const count = activeGitRepoSwitcherItem?.count ?? changedFiles.size;
    const basename = getPathBasename(label) || label;
    return (
      <button
        type="button"
        onClick={openRepoPicker}
        className={`inline-flex h-7 min-w-0 max-w-[13rem] shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition active:scale-95 ${
          rightSidebarRepoPickerOpen
            ? 'border-primary/25 bg-primary/10 text-primary'
            : 'border-border/10 bg-surface-2 text-muted-foreground hover:border-border/25 hover:bg-surface-elevated hover:text-foreground'
        }`}
        aria-haspopup="listbox"
        aria-expanded={rightSidebarRepoPickerOpen}
        title={label}
      >
        <RiGitBranch size={12} className="shrink-0" />
        <span className="min-w-0 truncate">{basename}</span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${count > 0 ? 'bg-accent/10 text-accent' : 'bg-surface text-muted-foreground'}`}>{count}</span>
        <RiChevronDown size={12} className="shrink-0" />
      </button>
    );
  }

  function renderRepoPickerOverlay() {
    if (!rightSidebarRepoPickerOpen || !showGitRepoFilter) return null;
    const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight;
    const desktopLeft = Math.max(12, Math.min(repoPickerAnchor?.x ?? (viewportWidth - 368), viewportWidth - 352));
    const desktopTop = Math.max(12, Math.min(repoPickerAnchor?.y ?? 80, viewportHeight - 420));
    const desktopPanelStyle: CSSProperties | undefined = isMobile ? undefined : { left: desktopLeft, top: desktopTop };
    return (
      <div
        className={`fixed inset-0 z-drawer-backdrop ${isMobile ? 'bg-[var(--app-backdrop)]' : 'bg-transparent'}`}
        onClick={closeRepoPicker}
      >
        <div
          className={isMobile
            ? 'fixed inset-x-0 bottom-0 z-drawer-panel max-h-[72vh] overflow-hidden rounded-t-2xl border-t border-border/20 bg-surface-elevated shadow-2xl'
            : 'fixed z-drawer-panel w-[21rem] max-w-[calc(100vw-1.5rem)] max-h-[min(26rem,calc(100vh-1.5rem))] overflow-hidden rounded-lg border border-border/20 bg-surface-elevated shadow-xl ring-1 ring-black/5'}
          style={desktopPanelStyle}
          onClick={(event) => event.stopPropagation()}
        >
          <div className={isMobile
            ? 'flex items-center justify-between border-b border-border/15 px-4 py-3'
            : 'flex items-center justify-between border-b border-border/12 px-3 py-2'}
          >
            <div>
              <div className={isMobile ? 'text-sm font-semibold text-foreground' : 'text-xs font-semibold text-foreground'}>
                {t('rightSidebar.repositories')}
              </div>
              {!isMobile && (
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {gitRepoSwitcherItems.length}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${changedFiles.size > 0 ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted-foreground'}`}>
                    {changedFiles.size}
                  </span>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={closeRepoPicker}
              className={isMobile
                ? 'rounded-full bg-surface-2 p-1.5 text-muted-foreground hover:bg-surface hover:text-foreground'
                : 'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground'}
              aria-label={t('rightSidebar.close')}
            >
              <RiCloseLine size={isMobile ? 16 : 14} />
            </button>
          </div>
          <div className={isMobile
            ? 'max-h-[calc(72vh-3.25rem)] overflow-y-auto overscroll-contain px-3 py-2 pb-[calc(env(safe-area-inset-bottom)+5.5rem)]'
            : 'max-h-[calc(min(26rem,100vh-1.5rem)-3.5rem)] overflow-y-auto overscroll-contain p-1.5'}
          >
            {gitRepoSwitcherItems.map((repo) => {
              const selected = (repo.root ?? null) === activeGitRepoRoot;
              const repoName = getPathBasename(repo.label) || repo.label;
              return (
                <button
                  key={repo.root ?? 'all'}
                  type="button"
                  onClick={() => {
                    selectGitRepoRoot(repo.root);
                    closeRepoPicker();
                  }}
                  className={`group mb-0.5 flex w-full items-center gap-2 rounded-md text-left transition active:scale-[0.99] ${
                    isMobile ? 'px-3 py-2' : 'px-2 py-1.5'
                  } ${
                    selected ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                  }`}
                  title={repo.label}
                  role="option"
                  aria-selected={selected}
                >
                  <span className={`h-7 w-1 shrink-0 rounded-full ${selected ? 'bg-primary' : 'bg-transparent group-hover:bg-border/40'}`} />
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${selected ? 'bg-primary/10 text-primary' : 'bg-surface-2 text-muted-foreground group-hover:text-foreground'}`}>
                    <RiGitBranch size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`${isMobile ? 'text-[13px]' : 'text-[12px]'} block truncate font-semibold leading-snug`}>
                      {repoName}
                    </span>
                    <span className="block truncate text-[10px] leading-snug text-muted-foreground/70">
                      {repo.root === null ? t('rightSidebar.allRepositories') : repo.label}
                    </span>
                  </span>
                  {repo.branch && (
                    <span className="hidden max-w-[5.5rem] shrink min-w-0 truncate rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
                      {repo.branch}
                    </span>
                  )}
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${repo.count > 0 ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted-foreground'}`}>{repo.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  function renderRepoSwitcher() {
    return renderRepoPickerOverlay();
  }

  function toDiffNavigatorFile(file: GitChangedFile): DiffNavigatorFile {
    const repoRoot = getChangedFileRepoRoot(file, rootPath);
    const absolutePath = file.absolutePath || (repoRoot ? `${repoRoot}/${file.path}` : file.path);
    const display = getRelativeDisplayPath(absolutePath, repoRoot ?? rootPath);
    const selectionPath = getChangedFileSelectionPath(file);
    return {
      key: selectionPath,
      path: file.path,
      absolutePath,
      displayName: display.name,
      displayDir: display.dir,
      oldPath: file.oldPath,
      status: file.status,
      title: absolutePath,
    };
  }

  function renderChangeNavigatorSubtitle(file: GitChangedFile) {
    return file.oldPath ? (
      <span className="block truncate text-[10px] text-muted-foreground/60">
        {t('rightSidebar.changedFromPath', { path: file.oldPath })}
      </span>
    ) : null;
  }

  function renderChangeNavigatorTrailing(file: GitChangedFile) {
    const repoRoot = getChangedFileRepoRoot(file, rootPath);
    const absolutePath = file.absolutePath || (repoRoot ? `${repoRoot}/${file.path}` : file.path);
    const referenceKey = `path:${absolutePath}`;
    const referenceInserted = insertedReferenceKey === referenceKey;
    const referenceCopied = copiedReferenceKey === referenceKey;
    const actions = buildGitActionButtons(file);
    const busyPath = getChangedFileBusyPath(file);
    return (
      <span className="flex shrink-0 items-center gap-1">
        <GitActionMenu actions={actions} running={runningGitAction} completed={completedGitAction?.path === busyPath ? completedGitAction : null} />
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            insertPathReference(absolutePath, referenceKey);
          }}
          {...getReferenceLongPressHandlers(getPathReferenceText(absolutePath), referenceKey)}
          className={`inline-flex h-6 shrink-0 items-center justify-center rounded-full px-2 text-[11px] font-semibold opacity-100 transition active:scale-95 md:opacity-0 md:group-hover:opacity-100 ${referenceInserted || referenceCopied ? 'bg-surface-elevated text-foreground' : 'bg-primary/10 text-primary'}`}
          title={t('rightSidebar.insertThisFile')}
        >
          {referenceCopied ? t('rightSidebar.copied') : referenceInserted ? t('rightSidebar.inserted') : t('rightSidebar.insertFileRef')}
        </button>
      </span>
    );
  }

  function renderDiffChangeModeToggle() {
    return (
      <div className="inline-flex h-7 shrink-0 overflow-hidden rounded-full bg-surface-2 p-0.5" aria-label={t('rightSidebar.diffViewMode')}>
        <button
          type="button"
          onClick={() => setDiffChangeMode('list')}
          aria-pressed={diffChangeListMode === 'list'}
          title={t('rightSidebar.diffViewModeList')}
          className={`inline-flex h-6 w-7 items-center justify-center rounded-full transition active:scale-95 ${
            diffChangeListMode === 'list'
              ? 'bg-surface-elevated text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <RiList size={13} />
        </button>
        <button
          type="button"
          onClick={() => setDiffChangeMode('tree')}
          aria-pressed={diffChangeListMode === 'tree'}
          title={t('rightSidebar.diffViewModeTree')}
          className={`inline-flex h-6 w-7 items-center justify-center rounded-full transition active:scale-95 ${
            diffChangeListMode === 'tree'
              ? 'bg-surface-elevated text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <RiListTree size={13} />
        </button>
        {showChangeAiMode && (
          <button
            type="button"
            onClick={() => setDiffChangeMode('ai')}
            aria-pressed={diffChangeListMode === 'ai'}
            title={t('rightSidebar.diffViewModeAi')}
            className={`inline-flex h-6 w-7 items-center justify-center rounded-full transition active:scale-95 ${
              diffChangeListMode === 'ai'
                ? 'bg-surface-elevated text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <RiSparkles size={13} />
          </button>
        )}
      </div>
    );
  }

  function renderDiffViewTypeToggle() {
    const splitEnabled = isWide;
    const effectiveMode: DiffViewType = splitEnabled ? diffViewType : 'unified';
    return (
      <div className="inline-flex h-7 shrink-0 overflow-hidden rounded-full bg-surface-2 p-0.5" aria-label={t('diffViewer.view')}>
        <button
          type="button"
          onClick={() => setDiffViewMode('unified')}
          aria-pressed={effectiveMode === 'unified'}
          title={t('diffViewer.unifiedMode')}
          className={`inline-flex h-6 items-center rounded-full px-2 text-[10px] font-semibold transition active:scale-95 ${
            effectiveMode === 'unified'
              ? 'bg-surface-elevated text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t('diffViewer.unified')}
        </button>
        <button
          type="button"
          onClick={() => setDiffViewMode('split')}
          disabled={!splitEnabled}
          aria-pressed={effectiveMode === 'split'}
          title={splitEnabled ? t('diffViewer.splitMode') : t('diffViewer.unifiedMode')}
          className={`inline-flex h-6 items-center rounded-full px-2 text-[10px] font-semibold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 ${
            effectiveMode === 'split'
              ? 'bg-surface-elevated text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t('diffViewer.split')}
        </button>
      </div>
    );
  }

  function buildDiffNavigatorGroups(): DiffNavigatorGroup[] {
    return filteredChangedFileGroups.map((group) => {
      const staged = countStagedChanges(group.files.map(([, file]) => file));
      const showRepoHeader = !activeGitRepoRoot && (filteredChangedFileGroups.length > 1 || group.label !== rootName);
      const collapsed = Boolean(group.root && collapsedGitRepoGroups.has(group.root));
      const groupKey = group.root ?? group.label;
      return {
        key: groupKey,
        root: group.root,
        label: group.label,
        branch: group.branch,
        collapsed,
        files: group.files.map(([, file]) => toDiffNavigatorFile(file)),
        header: showRepoHeader ? (
          <div
            className={`flex w-full items-center gap-1.5 px-2 py-1.5 transition hover:bg-surface-2 ${
              collapsed ? 'rounded-lg' : 'rounded-t-lg border-b border-border/10'
            }`}
          >
            <button
              type="button"
              onClick={() => toggleGitRepoGroup(group.root)}
              aria-expanded={!collapsed}
              className="flex min-w-0 flex-1 items-center gap-2 text-left active:scale-[0.99]"
            >
              <span className="shrink-0 text-muted-foreground">
                {collapsed ? <RiChevronRight size={13} /> : <RiChevronDown size={13} />}
              </span>
              <RiGitBranch size={12} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-semibold text-foreground">{group.label}</span>
                {group.branch && <span className="block truncate text-[10px] text-muted-foreground">{group.branch}</span>}
              </span>
              <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">{group.files.length}</span>
              {staged > 0 && <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">{staged}</span>}
            </button>
            {group.root && (
              <>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    runRepoGitAction('stage-all', group.root, group.label);
                  }}
                  disabled={Boolean(runningGitAction)}
                  className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
                  title={t('rightSidebar.stageAll')}
                >
                  {t('rightSidebar.stageAll')}
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    runRepoGitAction('stash-all', group.root, group.label);
                  }}
                  disabled={Boolean(runningGitAction)}
                  className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-surface-elevated disabled:opacity-50"
                  title={t('rightSidebar.stashAll')}
                >
                  {t('rightSidebar.stashAll')}
                </button>
              </>
            )}
          </div>
        ) : null,
      };
    });
  }

  function buildDiffReviewFiles(): DiffReviewFile[] {
    if (changedFiles.size === 0) {
      return [{
        key: 'empty',
        path: '',
        status: 'unknown',
        repoRoot: null,
        displayName: t('rightSidebar.noChanges'),
        diffOverride: '',
        auditRecords: [],
      }];
    }
    return orderedChangedFilesForDiff.map(([, file]) => {
      const repoRoot = getChangedFileRepoRoot(file, rootPath);
      const absolutePath = file.absolutePath || (repoRoot ? `${repoRoot}/${file.path}` : file.path);
      return {
        key: getChangedFileSelectionPath(file),
        path: file.path,
        absolutePath,
        status: file.status,
        repoRoot,
        displayName: getRelativeDisplayPath(absolutePath, repoRoot).name,
        displayDir: getRelativeDisplayPath(absolutePath, repoRoot).dir,
        auditRecords: changeAuditRecords,
      };
    });
  }

  function renderChangeNavigatorLeading(navigatorFile: DiffNavigatorFile) {
    const file = Array.from(changedFiles.values()).find((candidate) => getChangedFileSelectionPath(candidate) === navigatorFile.key);
    const repoRoot = file ? getChangedFileRepoRoot(file, rootPath) : null;
    const auditStatus = getFileAuditStatus(changeAuditRecords, repoRoot, file?.path ?? navigatorFile.path);
    return (
      <ChangeStatusWithAuditBadge
        changeStatus={navigatorFile.status}
        auditStatus={auditStatus}
        renderChangeBadge={(status) => <ChangeBadge status={status} />}
      />
    );
  }

  const syncSelectionFromDiffStream = useCallback((container: HTMLDivElement): string | null => {
    if (isMobile) return null;
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
    const path = best?.dataset.diffSelectionPath ?? best?.dataset.diffStreamItem ?? null;
    if (!path) return null;
    if (diffStreamSyncedPathRef.current === path && useSidebarStore.getState().selectedFilePath === path) return path;
    diffStreamSyncedPathRef.current = path;
    selectFile(path);
    return path;
  }, [isMobile, selectFile]);

  const canPull = Boolean(!runningGitAction && activeGitActionRepoRoot && !requiresGitActionRepoSelection && (activeGitActionContext?.upstream || (pushRemote.trim() && pushBranch.trim())));
  const canPush = Boolean(!runningGitAction && activeGitActionRepoRoot && !requiresGitActionRepoSelection && (activeGitActionContext?.upstream || (pushRemote.trim() && pushBranch.trim())));
  const canSwitchBranch = Boolean(!runningGitAction && activeGitActionRepoRoot && !requiresGitActionRepoSelection && switchBranch.trim() && switchBranch.trim() !== activeGitActionContext?.branch);

  const filteredChangedFiles = useMemo(() => {
    const query = deferredFileQuery.trim().toLowerCase();
    const entries = Array.from(changedFiles.entries())
      .filter(([, file]) => !activeGitRepoRoot || getChangedFileRepoRoot(file, rootPath) === activeGitRepoRoot)
      .sort(([a], [b]) => a.localeCompare(b));
    if (!query) return entries;
    return entries.filter(([path, file]) => `${path} ${file.path} ${file.status} ${file.repoRelativeRoot ?? ''} ${file.repoName ?? ''}`.toLowerCase().includes(query));
  }, [activeGitRepoRoot, changedFiles, deferredFileQuery, rootPath]);

  useEffect(() => {
    logDiffInteractionEvent('selected_file_state', {
      selectedFilePath,
      selectedChangedFilePath: selectedChangedFile?.path ?? null,
      selectedChangedFileAbsolutePath: selectedChangedFile?.absolutePath ?? null,
      selectedChangedFileRepoRoot: selectedChangedFile?.repoRoot ?? null,
      rootPath,
      activeGitRepoRoot,
      rightTab,
      effectiveRightTab,
      diffPaneActive,
      changedFiles: changedFiles.size,
      filteredChangedFiles: filteredChangedFiles.length,
      gitBundleLoading,
      gitBundleLastLoadedAt,
    });
  }, [activeGitRepoRoot, changedFiles.size, diffPaneActive, effectiveRightTab, filteredChangedFiles.length, gitBundleLastLoadedAt, gitBundleLoading, rightTab, rootPath, selectedChangedFile?.absolutePath, selectedChangedFile?.path, selectedChangedFile?.repoRoot, selectedFilePath]);

  const filteredChangedFileGroups = useMemo(() => {
    const groups = new Map<string, { root: string | null; label: string; branch?: string | null; files: Array<[string, GitChangedFile]> }>();
    for (const entry of filteredChangedFiles) {
      const [, file] = entry;
      const repoRoot = getChangedFileRepoRoot(file, rootPath);
      const label = getChangedFileRepoLabel(file) || rootName;
      const key = repoRoot ?? label;
      const repo = repoRoot ? gitRepositoryByRoot.get(repoRoot) : undefined;
      const group = groups.get(key) ?? { root: repoRoot, label, branch: repo?.context?.branch, files: [] };
      group.files.push(entry);
      groups.set(key, group);
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (a.label === rootName) return -1;
      if (b.label === rootName) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [filteredChangedFiles, gitRepositoryByRoot, rootName, rootPath]);

  const orderedChangedFilesForDiff = useMemo(() => {
    const ordered: Array<[string, GitChangedFile]> = [];
    const fileBySelectionPath = new Map<string, [string, GitChangedFile]>();
    for (const entry of filteredChangedFiles) {
      fileBySelectionPath.set(getChangedFileSelectionPath(entry[1]), entry);
    }
    for (const group of filteredChangedFileGroups) {
      if (group.root && collapsedGitRepoGroups.has(group.root)) continue;
      if (diffChangeListMode !== 'tree') {
        ordered.push(...group.files);
        continue;
      }
      const navigatorFiles = group.files.map(([, file]) => toDiffNavigatorFile(file));
      for (const navigatorFile of flattenDiffNavigatorTree(navigatorFiles)) {
        const entry = fileBySelectionPath.get(navigatorFile.key);
        if (entry) ordered.push(entry);
      }
    }
    return ordered;
  }, [collapsedGitRepoGroups, diffChangeListMode, filteredChangedFileGroups, filteredChangedFiles]);

  useEffect(() => {
    if (!diffPaneActive || orderedChangedFilesForDiff.length === 0) return;
    if (isMobile) return;
    const handles: number[] = [];
    const syncInitial = () => {
      const scroller = document.querySelector<HTMLDivElement>('.termdock-diff-stream-scroller');
      if (scroller) {
        const synced = syncSelectionFromDiffStream(scroller);
        if (synced) return;
      }
      const firstItem = document.querySelector<HTMLElement>('[data-diff-stream-item]');
      const visiblePath = firstItem?.dataset.diffSelectionPath ?? firstItem?.dataset.diffStreamItem ?? null;
      if (visiblePath) {
        diffStreamSyncedPathRef.current = visiblePath;
        selectFile(visiblePath);
        return;
      }
      const first = orderedChangedFilesForDiff[0]?.[1];
      if (!first) return;
      const path = getChangedFileSelectionPath(first);
      diffStreamSyncedPathRef.current = path;
      selectFile(path);
    };
    for (const delay of [80, 240, 600, 1200]) {
      handles.push(window.setTimeout(syncInitial, delay));
    }
    return () => handles.forEach((handle) => window.clearTimeout(handle));
  }, [diffPaneActive, isMobile, orderedChangedFilesForDiff, selectFile, syncSelectionFromDiffStream]);

  const changeAuditPromptText = useMemo(() => {
    const quoteShellArg = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const repoOptions = changeAuditTargetRepoRoots.length > 0
      ? changeAuditTargetRepos
      : gitRepositories.filter((repo) => repo.files.length > 0);
    const targetRepos = repoOptions.length > 0
      ? repoOptions
      : rootPath
        ? [{
          root: rootPath,
          relativeRoot: '.',
          name: rootName,
        }]
        : [];
    const repoList = targetRepos.length > 0
      ? targetRepos.map((repo) => {
        const workspacePath = repo.relativeRoot === '.' ? '.' : repo.relativeRoot;
        return `- ${workspacePath} (${repo.root})`;
      }).join('\n')
      : `- ${rootPath ? '.' : ''}`;
    const exportCommands = targetRepos.length > 0
      ? targetRepos.map((repo) => `   td audit-export ${quoteShellArg(repo.root)}`).join('\n')
      : '   td audit-export';
    const payloadCommand = targetRepos.length > 0
      ? '   td audit ~/.termdock/change-audit/payload-<repo>.json'
      : '   td audit ~/.termdock/change-audit/payload.json';
    return [
      '任务：为目标仓库的 Git diff hunk 生成自包含审计解释，并通过 Termdock CLI 注入。',
      '',
      `当前工作区：${rootPath ?? ''}`,
      '目标仓库：',
      repoList,
      '',
      '执行步骤：',
      '1. 仅对“目标仓库”逐个执行 audit-export。嵌套子仓使用括号内 repo 绝对路径作为命令参数。',
      exportCommands,
      '2. 先检查 audit-export 输出的 coverage[]：确认 untrackedFiles 是否为空、未跟踪文件是否已经出现在 hunks[].filePath 中；如果 coverage 显示存在未跟踪文件但 hunks[] 未包含对应文件，必须汇报导出异常，不要假装已解释。',
      '3. 读取 audit-export 输出的全部 hunks[].diff，包含 tracked 与 untracked hunks；先理解整批改动的业务目标、行为变化、文件分工和跨 hunk 依赖。',
      '4. 以 audit-export 内置 diff 为分析依据。仅在单个 hunk 信息不足时执行：td audit-show <hunkId> <对应仓库绝对路径>',
      '5. 在 ~/.termdock/change-audit/ 生成批量 payload JSON。',
      '   mkdir -p ~/.termdock/change-audit',
      '6. payload 顶层字段：workspaceRoot、repoRoot、generatedBy、walkthrough、records[]。',
      '7. walkthrough 必须先生成，用三层结构说明整批改动：highlights[] 面向不了解代码的人讲“改了什么/带来什么效果”；nodes[]/edges[] 表达关键链路；risks[]/checks[] 写真实风险和验证。节点可带 anchor，点击后会跳到对应 diff。',
      '8. records[] 必须覆盖每个 hunk 内的多个 section，而不是只写 hunk 总结；从 audit-export hunk 原样复制 filePath、oldPath、newPath、hunkHeader、hunkIndex、fingerprint；如果解释的是 section，额外填写 sectionIndex 和 sectionFingerprint；补充 summary、explanation。',
      '9. 写入 payload 后批量注入：',
      payloadCommand,
      '10. 少量 hunk 或临时补单条时使用：printf "%s\\n" "这里写该 hunk 的改动意义" | td audit-explain <hunkId> <对应仓库绝对路径>',
      '11. 注入成功后清理本次 payload：rm -f ~/.termdock/change-audit/payload*.json',
      '',
      'payload.walkthrough 示例字段：',
      '{',
      '  "title": "一句话标题",',
      '  "summary": "整批改动的目的和结果",',
      '  "highlights": [{ "what": "改了什么", "effect": "用户或系统得到什么", "tag": "体验" }],',
      '  "nodes": [{ "id": "n1", "title": "节点标题", "kind": "ui", "business": "零上下文业务解释", "anchor": { "repoRoot": "<repoRoot>", "filePath": "<filePath>", "hunkIndex": 0, "hunkFingerprint": "<fingerprint>", "sectionIndex": 0, "sectionFingerprint": "<sectionFingerprint>" } }],',
      '  "edges": [{ "from": "n1", "to": "n2", "label": "调用/传递/消费", "desc": "这条关系的业务含义" }],',
      '  "risks": [{ "title": "真实风险或口径疑问", "anchor": { "filePath": "<filePath>" } }],',
      '  "checks": ["可执行验证动作"]',
      '}',
      '',
      '写作标准：',
      '- summary：一句话概括该 hunk 在整批改动中的职责。',
      '- explanation：自包含说明业务链路、该 hunk 的作用、解决的问题、与其它 hunk 的关系。',
      '- walkthrough.highlights 必须大白话，不要堆文件名/函数名；只看 highlights 应该知道这次改动干嘛。',
      '- walkthrough.nodes 优先对应方法、关键业务步骤或关键 section；每个有 anchor 的节点必须能跳回真实 diff。',
      '- 面向不了解本轮对话的 AI 编写，补足必要上下文。',
      '- 输出高信息量结论；避免铺垫、套话、流程复述、泛泛风险、逐行翻译 diff。',
      '',
      '完成条件：汇报每个目标仓库已注入的 hunk 数和总数。',
    ].join('\n');
  }, [changeAuditTargetRepoRoots.length, changeAuditTargetRepos, gitRepositories, rootName, rootPath]);

  const insertChangeAuditPrompt = useCallback((mode: 'generate' | 'regenerate' | 'refresh-stale' = 'generate') => {
    if (showGitRepoFilter && changeAuditRepoRoots.length === 0 && !activeGitRepoRoot) {
      setChangeAuditScopeOpen(true);
      return;
    }
    const promptText = mode === 'generate'
      ? changeAuditPromptText
      : [
        mode === 'regenerate'
          ? '模式：重新生成。基于当前 audit-export 为全部 hunk 重新生成解释并覆盖写回。'
          : '模式：补充失效。基于当前 audit-export 补充新增、变更或已失效的 hunk 解释；保留仍有效的解释。',
        '',
        changeAuditPromptText,
      ].join('\n');
    logGitBundleClientEvent('insert_change_audit_prompt', {
      rootPath,
      activeGitRepoRoots: changeAuditTargetRepoRoots,
      mode,
      hasAuditListCommand: promptText.includes('td audit-list'),
      promptLength: promptText.length,
    });
    insertContextText(t('rightSidebar.insertChangeAuditPrompt'), promptText, `${changeAuditPromptKey}:${mode}`);
    void loadChangeAuditRecords();
    if (!push) onClose();
  }, [activeGitRepoRoot, changeAuditPromptText, changeAuditRepoRoots.length, changeAuditTargetRepoRoots, insertContextText, loadChangeAuditRecords, onClose, push, rootPath, showGitRepoFilter, t]);

  const handleClearAuditRecord = useCallback(async (id: string) => {
    try {
      await clearChangeAuditRecords({ ids: [id] });
      setChangeAuditRecords((prev) => prev.filter((record) => record.id !== id));
    } catch {
      void loadChangeAuditRecords();
    }
  }, [loadChangeAuditRecords]);

  const handleClearLoadedChangeAuditRecords = useCallback(async () => {
    if (changeAuditRecords.length === 0) return;
    const ids = changeAuditRecords.map((record) => record.id);
    try {
      await clearChangeAuditRecords({ ids });
      setChangeAuditRecords((prev) => prev.filter((record) => !ids.includes(record.id)));
      setChangeAuditError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to clear change audit explanations';
      setChangeAuditError(t('rightSidebar.changeAuditClearFailed', { message }));
      void loadChangeAuditRecords();
    }
  }, [changeAuditRecords, loadChangeAuditRecords, t]);

  const handleClearBranchAuditGroup = useCallback(async (group: { key: string; records: BranchAuditRecord[] }) => {
    if (group.records.length === 0) return;
    const ids = group.records.map((record) => record.id);
    try {
      await clearBranchAuditRecords({ ids });
      setBranchAuditRecords((prev) => prev.filter((record) => !ids.includes(record.id)));
      if (selectedBranchAuditHistoryKey === group.key) {
        setSelectedBranchAuditHistoryKey(null);
        setBranchAuditDetailOpen(false);
      }
    } catch (error) {
      setGitActionError(t('rightSidebar.branchAuditClearFailed', {
        message: error instanceof Error ? error.message : 'Failed to clear branch explanation',
      }));
      void loadBranchAuditRecords(null);
    }
  }, [loadBranchAuditRecords, selectedBranchAuditHistoryKey, t]);

  const toggleChangeAuditRepoRoot = useCallback((repoRoot: string | null) => {
    setChangeAuditRepoRoots((current) => {
      if (repoRoot === null) {
        setChangeAuditScopeOpen(false);
        return [];
      }
      return current.includes(repoRoot)
        ? current.filter((value) => value !== repoRoot)
        : [...current, repoRoot];
    });
  }, []);

  const toggleBranchAuditRepoRoot = useCallback((repoRoot: string | null) => {
    setBranchAuditRepoRoots((current) => {
      if (repoRoot === null) {
        setBranchAuditScopeOpen(false);
        return [];
      }
      return current.includes(repoRoot)
        ? current.filter((value) => value !== repoRoot)
        : [...current, repoRoot];
    });
  }, []);

  const branchAuditReviewItems = useMemo(() => {
    if (!hasMountedGitPane) return [];
    const buildRecordHunk = (record: BranchAuditRecord): BranchDiffHunk => {
      const diff = record.diff ?? '';
      let additions = 0;
      let deletions = 0;
      for (const line of diff.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) additions += 1;
        if (line.startsWith('-')) deletions += 1;
      }
      return {
        filePath: record.filePath,
        oldPath: record.oldPath,
        newPath: record.newPath,
        hunkHeader: record.hunkHeader,
        hunkIndex: record.hunkIndex ?? 0,
        fingerprint: record.fingerprint,
        additions,
        deletions,
        diff,
      };
    };
    if (branchAuditPreviewDiff) {
      return (branchAuditPreviewDiff.hunks ?? []).map((hunk) => {
        const current = branchAuditRecords.find((record) => (
          record.repoRoot === branchAuditPreviewDiff.repoRoot
          && record.baseRef === branchAuditPreviewDiff.baseRef
          && (record.branchName ?? null) === (branchAuditPreviewDiff.currentBranch ?? null)
          && record.filePath === hunk.filePath
          && record.hunkHeader === hunk.hunkHeader
          && (record.hunkIndex ?? 0) === hunk.hunkIndex
          && record.fingerprint === hunk.fingerprint
        )) ?? null;
        return {
          key: `${hunk.filePath}\u0000${hunk.hunkHeader}\u0000${hunk.hunkIndex}`,
          hunk,
          current,
          stale: null,
        };
      });
    }
    if (!selectedBranchAuditHistoryKey) return [];
    return branchAuditRecords
      .filter((record) => getBranchAuditHistoryKey(record) === selectedBranchAuditHistoryKey)
      .map((record) => {
        const hunk = buildRecordHunk(record);
        return {
          key: `${record.filePath}\u0000${record.hunkHeader}\u0000${record.hunkIndex ?? 0}`,
          hunk,
          current: record,
          stale: null,
        };
      });
  }, [branchAuditPreviewDiff, branchAuditRecords, hasMountedGitPane, selectedBranchAuditHistoryKey]);

  const hasBranchAuditRecords = branchAuditRecords.length > 0;
  const branchAuditHistoryGroups = useMemo(() => {
    if (!hasMountedGitPane) return [];
    const groups = new Map<string, { key: string; repoRoot: string; repoLabel: string; baseRef: string; branchName: string | null; headRef: string | null; diffFingerprint: string | null; records: BranchAuditRecord[]; latestInjectedAt: number }>();
    for (const record of branchAuditRecords) {
      const repoRoot = record.repoRoot;
      const repo = gitRepositoryByRoot.get(repoRoot);
      const repoLabel = repo?.relativeRoot === '.' ? rootName : repo?.relativeRoot || repo?.name || getPathBasename(repoRoot);
      const key = getBranchAuditHistoryKey(record);
      const group = groups.get(key) ?? {
        key,
        repoRoot,
        repoLabel,
        baseRef: record.baseRef,
        branchName: record.branchName ?? null,
        headRef: record.headRef ?? null,
        diffFingerprint: record.diffFingerprint ?? null,
        records: [],
        latestInjectedAt: 0,
      };
      group.records.push(record);
      group.latestInjectedAt = Math.max(group.latestInjectedAt, record.injectedAt ?? 0);
      groups.set(key, group);
    }
    return Array.from(groups.values()).sort((a, b) => b.latestInjectedAt - a.latestInjectedAt);
  }, [branchAuditRecords, gitRepositoryByRoot, hasMountedGitPane, rootName]);
  const selectedBranchAuditHistoryGroup = useMemo(() => (
    selectedBranchAuditHistoryKey
      ? branchAuditHistoryGroups.find((group) => group.key === selectedBranchAuditHistoryKey) ?? null
      : null
  ), [branchAuditHistoryGroups, selectedBranchAuditHistoryKey]);
  const selectedBranchAuditDetailMeta = branchAuditPreviewDiff ? {
    repoRoot: branchAuditPreviewDiff.repoRoot ?? '',
    repoLabel: branchAuditPreviewDiff.repoRoot
      ? (gitRepositoryByRoot.get(branchAuditPreviewDiff.repoRoot)?.relativeRoot === '.'
        ? rootName
        : gitRepositoryByRoot.get(branchAuditPreviewDiff.repoRoot)?.relativeRoot || gitRepositoryByRoot.get(branchAuditPreviewDiff.repoRoot)?.name || getPathBasename(branchAuditPreviewDiff.repoRoot))
      : rootName,
    baseRef: branchAuditPreviewDiff.baseRef ?? branchAuditPreviewDiff.baseBranch ?? '',
    branchName: branchAuditPreviewDiff.currentBranch ?? null,
    headRef: branchAuditPreviewDiff.headRef ?? null,
    diffFingerprint: branchAuditPreviewDiff.diffFingerprint ?? null,
  } : selectedBranchAuditHistoryGroup;

  const commitDiffReviewItems = useMemo(() => (
    (commitDiff?.hunks ?? []).map((hunk) => ({
      key: `${hunk.filePath}\u0000${hunk.hunkHeader}\u0000${hunk.hunkIndex}`,
      hunk,
      current: null,
      stale: null,
    }))
  ), [commitDiff?.hunks]);

  const selectedBranchWalkthroughs = useMemo(() => {
    if (branchAuditPreviewDiff) return [];
    const group = selectedBranchAuditHistoryGroup;
    if (!group) return [];
    return branchWalkthroughs.filter((walkthrough) => (
      walkthrough.repoRoot === group.repoRoot
      && walkthrough.baseRef === group.baseRef
      && (walkthrough.branchName ?? null) === group.branchName
      && (!group.diffFingerprint || walkthrough.diffFingerprint === group.diffFingerprint)
    ));
  }, [branchAuditPreviewDiff, branchWalkthroughs, selectedBranchAuditHistoryGroup]);

  const handleBranchWalkthroughNavigate = useCallback((anchor: ChangeWalkthroughAnchor) => {
    const target = branchAuditReviewItems.find((item) => (
      item.hunk.filePath === anchor.filePath
      || (anchor.repoRoot ? `${anchor.repoRoot}/${item.hunk.filePath}` === anchor.filePath : false)
    ));
    if (!target) return;
    setSelectedBranchAuditFileKey(target.key);
    window.setTimeout(() => scrollDiffAnchorIntoView(anchor), 90);
    window.setTimeout(() => scrollDiffAnchorIntoView(anchor), 320);
    window.setTimeout(() => scrollDiffAnchorIntoView(anchor), 760);
  }, [branchAuditReviewItems]);

  const branchAuditPromptText = useMemo(() => {
    const quoteShellArg = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const targetRepos = branchAuditReadyRepos;
    const repoList = targetRepos.length > 0
      ? targetRepos.map((repo) => `- ${repo.label} (${repo.root})，目标分支：${branchAuditRepoBranches[repo.root] || repo.branch || '(current branch)'}，基线分支：${branchAuditRepoBaseBranches[repo.root] || '(not set)'}`).join('\n')
      : `- ${rootPath ? '.' : ''}`;
    const exportCommands = targetRepos.length > 0
      ? targetRepos.map((repo) => {
        const targetBranch = branchAuditRepoBranches[repo.root] || repo.branch || '';
        const baseBranch = branchAuditRepoBaseBranches[repo.root] || '';
        const safeName = repo.label.replace(/[^A-Za-z0-9_-]+/g, '_') || 'repo';
        const switchLine = targetBranch ? `   git -C ${quoteShellArg(repo.root)} switch ${quoteShellArg(targetBranch)}` : `   # ${repo.label}: keep current branch`;
        return [
          switchLine,
          '   mkdir -p ~/.termdock/branch-audit',
          `   td branch-audit-export ${quoteShellArg(baseBranch)} ${quoteShellArg(repo.root)} > ~/.termdock/branch-audit/branch-audit-export-${safeName}.json`,
        ].join('\n');
      }).join('\n')
      : '   td branch-audit-export <base-branch>';
    return [
      '解释目标仓库当前分支相对于基线分支的改动，并把解释写回 Termdock。',
      '',
      `当前工作区：${rootPath ?? ''}`,
      `包含本地未提交更改：${branchAuditIncludeUncommitted ? '是' : '否'}`,
      '目标仓库：',
      repoList,
      '',
      '操作指令：',
      branchAuditIncludeUncommitted
        ? '1. 只针对上面列出的目标仓库导出分支 hunk；如果指定了目标分支，先在对应仓库切到目标分支。导出内容需要包含目标分支相对基线分支的提交改动，以及当前工作区 staged/unstaged/untracked 改动。嵌套子仓或软链接子仓必须使用括号里的仓库绝对路径，不要改用当前工作区根目录。示例：'
        : '1. 只针对上面列出的目标仓库导出分支 hunk；如果指定了目标分支，先在对应仓库切到目标分支。不要包含本地 staged/unstaged/untracked 改动；如果导出结果里混入了本地工作区改动，生成解释时必须忽略这些本地改动，只解释目标分支相对基线分支的提交改动。嵌套子仓或软链接子仓必须使用括号里的仓库绝对路径，不要改用当前工作区根目录。示例：',
      exportCommands,
      '2. 读取导出的 ~/.termdock/branch-audit/branch-audit-export*.json 中的 hunks[]，不要把临时 JSON 放到业务仓目录，也不要把整份 JSON 粘贴回输入框。导出工具使用 base...HEAD（三点）生成 diff，只表示当前分支独有改动；提交列表使用 base..HEAD（两点）。',
      '3. 先生成 walkthrough，用 highlights[] 说明整批分支改动目的和影响，用 nodes[]/edges[] 画出主链路、分支链路和验证链路；节点可带 anchor，点击后会跳到对应 diff。',
      '4. 逐个 hunk 写解释。解释要说明该 hunk 的意图、解决的问题、影响、风险，以及它和其它 hunk 的关系；不要逐行复述 diff。',
      '5. 每个仓库分别生成 ~/.termdock/branch-audit/payload-<repo>.json，payload 必须包含 workspaceRoot、repoRoot、baseRef、branchName、headRef、diffFingerprint、walkthrough 和 records[]；records[] 每条 record 对应一个 hunk，diff 字段必须从 hunk.diff 原样复制。',
      '6. 把解释写入 payload 后执行：td branch-audit ~/.termdock/branch-audit/payload-<repo>.json',
      '7. 注入成功后删除本次生成的临时 JSON：rm -f ~/.termdock/branch-audit/branch-audit-export-*.json ~/.termdock/branch-audit/payload-*.json',
      '',
      'payload 示例：',
      '```json',
      JSON.stringify({
        workspaceRoot: rootPath ?? null,
        repoRoot: '<target repo root>',
        baseRef: '<target repo base branch>',
        branchName: '<from export currentBranch>',
        headRef: '<from export headRef>',
        diffFingerprint: '<from export diffFingerprint>',
        generatedBy: 'termdock-branch-audit',
        walkthrough: {
          title: '<one-line branch change title>',
          summary: '<branch change goal and effect>',
          highlights: [{ what: '<what changed>', effect: '<user/system effect>', tag: '<category>' }],
          nodes: [{ id: 'n1', title: '<node title>', kind: 'process', business: '<zero-context business explanation>', anchor: { repoRoot: '<target repo root>', filePath: '<from hunk.filePath>', hunkIndex: 0, hunkFingerprint: '<from hunk.fingerprint>' } }],
          edges: [{ from: 'n1', to: 'n2', label: '<relationship>', desc: '<business meaning>' }],
          risks: [{ title: '<real risk or validation gap>' }],
          checks: ['<executable validation step>'],
        },
        records: [
          {
            filePath: '<from hunk.filePath>',
            oldPath: '<from hunk.oldPath or null>',
            newPath: '<from hunk.newPath or null>',
            hunkHeader: '<from hunk.hunkHeader>',
            hunkIndex: 0,
            fingerprint: '<from hunk.fingerprint>',
            diff: '<copy from hunk.diff exactly>',
            explanation: '<replace with hunk explanation>',
            summary: '',
          },
        ],
      }, null, 2),
      '```',
    ].join('\n');
  }, [branchAuditIncludeUncommitted, branchAuditReadyRepos, branchAuditRepoBaseBranches, branchAuditRepoBranches, rootPath]);

  const insertBranchAuditScopePrompt = useCallback((mode: 'generate' | 'regenerate' | 'refresh-stale' = 'generate') => {
    const basePrompt = mode === 'generate'
      ? branchAuditPromptText
      : [
        mode === 'regenerate'
          ? '模式：重新生成。请基于当前分支导出结果重新生成全部 hunk 解释并覆盖写回。'
          : '模式：补充失效。请基于当前分支导出结果只补充新增、变更或已失效的 hunk 解释，仍有效的解释不要重复写回。',
        '',
        branchAuditPromptText,
      ].join('\n');
    insertContextText(t('rightSidebar.branchAuditShort'), basePrompt, `context:branch-audit-scope:${mode}`);
    if (!push) onClose();
  }, [branchAuditPromptText, insertContextText, onClose, push, t]);

  const openBranchAuditPreviewDiff = useCallback(async () => {
    if (!rootPath || branchAuditReadyRepos.length === 0) return;
    const expectedRootPath = rootPath;
    setBranchAuditPreviewLoading(true);
    setBranchAuditPreviewError(null);
    setBranchAuditPreviewDiff(null);
    setCommitDiff(null);
    try {
      const results = await Promise.all(branchAuditReadyRepos.map(async (repo) => {
        const base = branchAuditRepoBaseBranches[repo.root]?.trim();
        if (!base) throw new Error(t('rightSidebar.branchAuditMissingBase', { repo: repo.label }));
        const targetBranch = (branchAuditRepoBranches[repo.root] || repo.branch || '').trim();
        return getBranchDiff({
          cwd: rootPath,
          repoRoot: repo.root,
          base,
          head: targetBranch && targetBranch !== repo.branch ? targetBranch : null,
          includeUncommitted: branchAuditIncludeUncommitted,
          requestSlotId: `right-sidebar-branch-preview:${repo.root}`,
        });
      }));
      if (!isCurrentSidebarRoot(expectedRootPath)) return;
      const unavailable = results.find((result) => !result.available);
      if (unavailable) {
        setBranchAuditPreviewError(unavailable.error ?? 'Branch diff is unavailable');
        return;
      }
      const merged = results.length === 1 ? results[0] : {
        available: true,
        workspaceRoot: rootPath,
        repoRoot: rootPath,
        baseRef: results.map((result) => result.baseRef ?? result.baseBranch).filter(Boolean).join(', '),
        currentBranch: results.map((result) => result.currentBranch ?? 'HEAD').filter(Boolean).join(', '),
        headRef: results.map((result) => result.headRef).filter(Boolean).join(', '),
        diffFingerprint: results.map((result) => result.diffFingerprint).filter(Boolean).join('+'),
        stat: results.map((result) => result.stat).filter(Boolean).join('\n'),
        files: results.flatMap((result, index) => {
          const repo = branchAuditReadyRepos[index];
          return (result.files ?? []).map((file) => `${repo?.label ?? result.repoRoot ?? 'repo'}/${file}`);
        }),
        hunks: results.flatMap((result, index) => {
          const repo = branchAuditReadyRepos[index];
          const prefix = repo?.label ?? result.repoRoot ?? 'repo';
          return (result.hunks ?? []).map((hunk) => ({
            ...hunk,
            filePath: `${prefix}/${hunk.filePath}`,
            oldPath: hunk.oldPath ? `${prefix}/${hunk.oldPath}` : hunk.oldPath,
            newPath: hunk.newPath ? `${prefix}/${hunk.newPath}` : hunk.newPath,
          }));
        }),
        commits: results.flatMap((result) => result.commits ?? []),
        commitCount: results.reduce((sum, result) => sum + (result.commitCount ?? result.commits?.length ?? 0), 0),
        diff: results.map((result) => result.diff).filter(Boolean).join('\n'),
        truncated: results.some((result) => result.truncated),
      } satisfies BranchDiffResponse;
      const createdAt = Date.now();
      const entryKey = [
        'preview',
        merged.repoRoot ?? rootPath,
        merged.baseRef ?? merged.baseBranch ?? '',
        merged.currentBranch ?? '',
        merged.headRef ?? '',
        merged.diffFingerprint ?? createdAt,
      ].join('\0');
      const repoLabel = branchAuditReadyRepos.length === 1
        ? branchAuditReadyRepos[0].label
        : `${branchAuditReadyRepos.length} repos`;
      setBranchAuditPreviewDiff(merged);
      setBranchAuditPreviewEntries((current) => [
        { key: entryKey, diff: merged, repoLabel, createdAt },
        ...current.filter((entry) => entry.key !== entryKey),
      ].slice(0, 8));
      setBranchAuditPreviewScrollTops((current) => (
        current[entryKey] === undefined ? current : { ...current, [entryKey]: 0 }
      ));
      setSelectedBranchAuditHistoryKey(entryKey);
      setSelectedBranchAuditFileKey(merged.hunks?.[0] ? `${merged.hunks[0].filePath}\u0000${merged.hunks[0].hunkHeader}\u0000${merged.hunks[0].hunkIndex}` : null);
      setBranchAuditDetailOpen(true);
    } catch (error) {
      if (!isCurrentSidebarRoot(expectedRootPath) || isAbortError(error)) return;
      setBranchAuditPreviewError(error instanceof Error ? error.message : 'Failed to load branch diff');
    } finally {
      if (isCurrentSidebarRoot(expectedRootPath)) setBranchAuditPreviewLoading(false);
    }
  }, [branchAuditIncludeUncommitted, branchAuditReadyRepos, branchAuditRepoBaseBranches, branchAuditRepoBranches, isCurrentSidebarRoot, rootPath, t]);

  const openBranchAuditPreviewEntry = useCallback((entry: BranchAuditPreviewEntry) => {
    setBranchAuditPreviewDiff(entry.diff);
    setBranchAuditPreviewError(null);
    setSelectedBranchAuditHistoryKey(entry.key);
    setSelectedBranchAuditFileKey(entry.diff.hunks?.[0] ? `${entry.diff.hunks[0].filePath}\u0000${entry.diff.hunks[0].hunkHeader}\u0000${entry.diff.hunks[0].hunkIndex}` : null);
    setBranchAuditDetailOpen(true);
  }, []);

  const deleteBranchAuditPreviewEntry = useCallback((key: string) => {
    setBranchAuditPreviewEntries((current) => current.filter((entry) => entry.key !== key));
    setBranchAuditPreviewScrollTops((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (selectedBranchAuditHistoryKey === key) {
      setSelectedBranchAuditHistoryKey(null);
      setBranchAuditPreviewDiff(null);
      setBranchAuditDetailOpen(false);
    }
  }, [selectedBranchAuditHistoryKey]);

  const openBranchAuditHistoryDetail = useCallback((historyKey: string) => {
    const group = branchAuditHistoryGroups.find((item) => item.key === historyKey);
    if (!group) return;
    setBranchAuditPreviewDiff(null);
    setBranchAuditPreviewError(null);
    setSelectedBranchAuditHistoryKey(historyKey);
    setSelectedBranchAuditFileKey(group.records[0]?.filePath ?? null);
    setBranchAuditDetailOpen(true);
  }, [branchAuditHistoryGroups]);

  const openCommitDiff = useCallback(async (commitLine: string) => {
    if (!rootPath || !activeGitActionRepoRoot) return;
    const [commit] = commitLine.split(/\s+/);
    if (!commit) return;
    setCommitDiffLoading(commit);
    setCommitDiffError(null);
    setCommitDiff(null);
    try {
      const result = await getCommitDiff({
        cwd: rootPath,
        repoRoot: activeGitActionRepoRoot,
        commit,
        requestSlotId: 'right-sidebar-commit-diff',
      });
      if (!result.available) {
        setCommitDiffError(result.error ?? 'Commit diff is unavailable');
        return;
      }
      setCommitDiff(result);
      const first = result.hunks?.[0];
      setSelectedCommitDiffFileKey(first ? `${first.filePath}\u0000${first.hunkHeader}\u0000${first.hunkIndex}` : null);
    } catch (error) {
      setCommitDiffError(error instanceof Error ? error.message : 'Failed to load commit diff');
    } finally {
      setCommitDiffLoading(null);
    }
  }, [activeGitActionRepoRoot, rootPath]);

  const handleBranchAuditDetailScrollPositionChange = useCallback((scrollTop: number) => {
    if (!branchAuditPreviewDiff || !selectedBranchAuditHistoryKey) return;
    const roundedTop = Math.max(0, Math.round(scrollTop));
    setBranchAuditPreviewScrollTops((current) => (
      Math.abs((current[selectedBranchAuditHistoryKey] ?? 0) - roundedTop) < 24
        ? current
        : { ...current, [selectedBranchAuditHistoryKey]: roundedTop }
    ));
  }, [branchAuditPreviewDiff, selectedBranchAuditHistoryKey]);

  useEffect(() => {
    if (!isMobile || !branchAuditDetailOpen || !branchAuditPreviewDiff) return;
    slideMobileDiffTo(1);
  }, [branchAuditDetailOpen, branchAuditPreviewDiff, isMobile, slideMobileDiffTo]);

  const requestDiffStreamScroll = useCallback((path: string | null) => {
    if (!path) return;
    setDiffStreamScrollRequest((current) => nextDiffStreamScrollRequest(current, path));
  }, []);
  const effectiveDiffStreamScrollKey = diffStreamScrollRequest.key === selectedFilePath
    ? diffStreamScrollRequest.key
    : null;

  const selectDiffFile = useCallback((path: string | null) => {
    const state = useSidebarStore.getState();
    const interactionId = createDiffInteractionId();
    logDiffInteractionEvent('select_diff_file', {
      interactionId,
      path,
      previousSelectedFilePath: state.selectedFilePath,
      rootPath: state.rootPath,
      activeGitRepoRoot,
      changedFiles: state.changedFiles.size,
      gitBundleLoading: state.gitBundleLoading,
      gitBundleLastLoadedAt: state.gitBundleLastLoadedAt,
      rightTab: state.rightTab,
    });
    selectFile(path);
    setRightTab('diff');
    if (isMobile && path) {
      slideMobileDiffTo(1);
    }
    requestDiffStreamScroll(path);
    queueMicrotask(() => {
      const next = useSidebarStore.getState();
      logDiffInteractionEvent('select_diff_file_after', {
        interactionId,
        requestedPath: path,
        selectedFilePath: next.selectedFilePath,
        rootPath: next.rootPath,
        rightTab: next.rightTab,
        changedFiles: next.changedFiles.size,
        activeGitRepoRoot,
      });
    });
  }, [activeGitRepoRoot, isMobile, requestDiffStreamScroll, selectFile, setRightTab, slideMobileDiffTo]);

  const handleWalkthroughNavigate = useCallback((anchor: ChangeWalkthroughAnchor) => {
    const targetFile = Array.from(changedFiles.values()).find((file) => {
      const repoRoot = getChangedFileRepoRoot(file, rootPath);
      const selectionPath = getChangedFileSelectionPath(file);
      return file.path === anchor.filePath
        || selectionPath === anchor.filePath
        || file.absolutePath === anchor.filePath
        || (repoRoot ? `${repoRoot}/${file.path}` === anchor.filePath : false)
        || (anchor.repoRoot && repoRoot === anchor.repoRoot && file.path === anchor.filePath);
    });
    if (targetFile) {
      selectDiffFile(getChangedFileSelectionPath(targetFile));
      window.setTimeout(() => scrollDiffAnchorIntoView(anchor), 90);
      window.setTimeout(() => scrollDiffAnchorIntoView(anchor), 320);
      window.setTimeout(() => scrollDiffAnchorIntoView(anchor), 760);
      return;
    }
    scrollDiffAnchorIntoView(anchor);
  }, [changedFiles, rootPath, selectDiffFile]);

  const renderChangeWalkthroughPanel = useCallback(({ slideToDetail }: { slideToDetail?: () => void } = {}) => (
    changeWalkthroughs.length > 0 ? (
      <ChangeWalkthroughPanel
        walkthroughs={changeWalkthroughs}
        repoRoot={activeGitRepoRoot}
        onNavigate={(anchor) => {
          if (isMobile) window.requestAnimationFrame(() => slideToDetail?.());
          handleWalkthroughNavigate(anchor);
        }}
      />
    ) : (
      <div className="rounded-lg border border-border/15 bg-surface px-3 py-6 text-center text-xs text-muted-foreground">
        <RiSparkles size={18} className="mx-auto mb-2 text-muted-foreground/80" />
        {t('rightSidebar.changeWalkthroughEmpty')}
      </div>
    )
  ), [activeGitRepoRoot, changeWalkthroughs, handleWalkthroughNavigate, isMobile, t]);

  const toggleGitRepoGroup = useCallback((repoRoot: string | null) => {
    if (!repoRoot) return;
    setCollapsedGitRepoGroups((current) => {
      const next = new Set(current);
      if (next.has(repoRoot)) next.delete(repoRoot);
      else next.add(repoRoot);
      writeCollapsedSet(COLLAPSED_GIT_REPO_GROUPS_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const toggleDiffDirectory = useCallback((path: string) => {
    setCollapsedDiffDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      writeCollapsedSet(COLLAPSED_DIFF_DIRECTORIES_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const setDiffChangeMode = useCallback((mode: DiffChangeListMode) => {
    setDiffChangeListMode(mode);
    writeCache(DIFF_CHANGE_LIST_MODE_STORAGE_KEY, mode);
  }, []);

  useEffect(() => {
    if (showChangeAiMode || diffChangeListMode !== 'ai') return;
    setDiffChangeMode('tree');
  }, [diffChangeListMode, setDiffChangeMode, showChangeAiMode]);

  const toggleDiffWrap = useCallback(() => {
    setDiffWrap((prev) => {
      const next = !prev;
      writeCache(DIFF_WRAP_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const setDiffViewMode = useCallback((mode: DiffViewType) => {
    setDiffViewType(mode);
    writeCache(DIFF_VIEW_TYPE_STORAGE_KEY, mode);
  }, []);

  // Histogram keeps code blocks stable around repeated lines and the precise
  // word enhancer handles the inner fragments. These are product defaults,
  // not user-facing tuning knobs.
  const diffOptions = useMemo<GitDiffOptions>(() => ({
    algorithm: 'histogram',
    whitespace: 'default',
  }), []);

  const updateSearchMode = useCallback((mode: FileSearchMode) => {
    setSearchMode(mode);
    writeCache(FILE_SEARCH_MODE_STORAGE_KEY, mode);
  }, []);

  const waitForGitActionJob = useCallback(async (initial: GitActionResponse, request: GitActionRequest, label: string, pathForBusy?: string): Promise<GitActionResponse> => {
    let current: GitActionResponse | { ok: false; status: 'missing'; error?: string } = initial;
    while (current.ok && current.status === 'running') {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      current = await getGitActionStatus({ jobId: current.jobId, cwd: request.cwd, action: request.action });
    }
    if (!current.ok) {
      throw new Error('Git action status is unavailable');
    }
    if (current.status === 'error') {
      throw new Error(current.error || current.message || 'Git action failed');
    }
    const completedAction = { action: request.action, path: pathForBusy, label };
    setCompletedGitAction(completedAction);
    window.setTimeout(() => setCompletedGitAction((active) => (
      active?.action === completedAction.action && active.path === completedAction.path ? null : active
    )), 1400);
    return current;
  }, []);

  const runSidebarGitAction = useCallback(async (request: GitActionRequest, label: string, pathForBusy?: string): Promise<boolean> => {
    const expectedRootPath = rootPath;
    if (rootPath) untrackedCompletedRootsRef.current.delete(rootPath);
    setGitActionError(null);
    setCompletedGitAction(null);
    setRunningGitAction({ action: request.action, path: pathForBusy });
    try {
      const started = await runGitAction(request);
      const result = await waitForGitActionJob(started, request, label, pathForBusy);
      if (!isCurrentSidebarRoot(expectedRootPath)) return false;
      const refreshedBundle = rootPath
        ? await getGitBundle(rootPath, undefined, { includeNested: true, cacheOnly: true, action: 'git_action_cache_sync', requestSlotId: buildGitBundleRequestSlotId(rootPath) }).catch(() => result.bundle)
        : result.bundle;
      if (!isCurrentSidebarRoot(expectedRootPath)) return false;
      if (refreshedBundle) applyGitBundle(refreshedBundle, { reloadDiff: true, cacheOnly: true });
      setConfirmGitAction(null);
      return true;
    } catch (err) {
      setCompletedGitAction(null);
      setGitActionError(t('rightSidebar.gitActionFailed', { message: err instanceof Error ? err.message : 'Unknown error' }));
      return false;
    } finally {
      if (isCurrentSidebarRoot(expectedRootPath)) setRunningGitAction(null);
    }
  }, [applyGitBundle, isCurrentSidebarRoot, rootPath, t, waitForGitActionJob]);

  const runRepoGitAction = useCallback((action: 'stage-all' | 'stash-all', repoRoot: string | null, repoLabel: string) => {
    if (!repoRoot) return;
    if (action === 'stage-all') {
      void runSidebarGitAction({ action: 'stage-all', cwd: repoRoot }, t('rightSidebar.stageAll'), `repo:${repoRoot}`);
      return;
    }
    setConfirmGitAction({ kind: 'stash-all', repoRoot, repoLabel });
  }, [runSidebarGitAction, t]);

  const selectGitRepoRoot = useCallback((repoRoot: string | null) => {
    setActiveGitRepoRoot(repoRoot);
    writeActiveGitRepoRoot(rootPath, repoRoot);
    setSwitchBranch('');
    setPushRemote('');
    setPushBranch('');
    selectFile(getFirstChangedFileSelectionPathForRepo(repoRoot));
    if (!gitPaneActive) setRightTab('diff');
  }, [getFirstChangedFileSelectionPathForRepo, gitPaneActive, rootPath, selectFile, setRightTab]);

  const handleSwitchBranch = useCallback(async () => {
    if (!activeGitActionRepoRoot || requiresGitActionRepoSelection) {
      setGitActionError(t('rightSidebar.selectRepositoryForGitActions'));
      return;
    }
    const branch = switchBranch.trim();
    if (!branch || branch === activeGitActionContext?.branch) return;
    await runSidebarGitAction({ action: 'switch-branch', cwd: activeGitActionRepoRoot, branch }, t('rightSidebar.switchBranch'));
  }, [activeGitActionContext?.branch, activeGitActionRepoRoot, requiresGitActionRepoSelection, runSidebarGitAction, switchBranch, t]);

  const handleQuickCommit = useCallback(async () => {
    if (!activeGitActionRepoRoot || requiresGitActionRepoSelection) {
      setGitActionError(t('rightSidebar.selectRepositoryForGitActions'));
      return;
    }
    const message = commitMessage.trim();
    if (!message) return;
    const ok = await runSidebarGitAction({ action: 'commit', cwd: activeGitActionRepoRoot, message }, t('rightSidebar.commitChanges'));
    if (ok) setCommitMessage('');
  }, [activeGitActionRepoRoot, commitMessage, requiresGitActionRepoSelection, runSidebarGitAction, t]);

  const handleQuickPush = useCallback(async () => {
    if (!activeGitActionRepoRoot || requiresGitActionRepoSelection) {
      setGitActionError(t('rightSidebar.selectRepositoryForGitActions'));
      return;
    }
    const remote = pushRemote.trim();
    const branch = pushBranch.trim();
    await runSidebarGitAction({
      action: 'push',
      cwd: activeGitActionRepoRoot,
      ...(remote ? { remote } : {}),
      ...(branch ? { branch } : {}),
    }, t('rightSidebar.pushChanges'));
  }, [activeGitActionRepoRoot, pushBranch, pushRemote, requiresGitActionRepoSelection, runSidebarGitAction, t]);

  const handleQuickPull = useCallback(async () => {
    if (!activeGitActionRepoRoot || requiresGitActionRepoSelection) {
      setGitActionError(t('rightSidebar.selectRepositoryForGitActions'));
      return;
    }
    const remote = pushRemote.trim();
    const branch = pushBranch.trim();
    await runSidebarGitAction({
      action: 'pull',
      cwd: activeGitActionRepoRoot,
      ...(remote ? { remote } : {}),
      ...(branch ? { branch } : {}),
    }, t('rightSidebar.pullChanges'));
  }, [activeGitActionRepoRoot, pushBranch, pushRemote, requiresGitActionRepoSelection, runSidebarGitAction, t]);

  useEffect(() => {
    if (!gitPaneActive || !activeGitActionRepoRoot || runningGitAction) return;
    let cancelled = false;
    const labels: Partial<Record<GitActionKey, string>> = {
      push: t('rightSidebar.pushChanges'),
      pull: t('rightSidebar.pullChanges'),
      commit: t('rightSidebar.commitChanges'),
      'switch-branch': t('rightSidebar.switchBranch'),
      'stage-all': t('rightSidebar.stageAll'),
      'stash-all': t('rightSidebar.stashAll'),
    };
    void (async () => {
      for (const action of ['push', 'pull', 'commit', 'switch-branch', 'stage-all', 'stash-all'] as GitActionKey[]) {
        if (cancelled) return;
        const status = await getGitActionStatus({ cwd: activeGitActionRepoRoot, action }).catch(() => null);
        if (!status?.ok || status.status !== 'running') continue;
        const request = { action, cwd: activeGitActionRepoRoot } as GitActionRequest;
        const label = labels[action] ?? action;
        setRunningGitAction({ action });
        try {
          const result = await waitForGitActionJob(status, request, label);
          if (cancelled || !isCurrentSidebarRoot(rootPath)) return;
          const synced = rootPath
            ? await getGitBundle(rootPath, undefined, { includeNested: true, cacheOnly: true, action: 'git_action_cache_sync', requestSlotId: buildGitBundleRequestSlotId(rootPath) }).catch(() => result.bundle)
            : result.bundle;
          if (synced) applyGitBundle(synced, { reloadDiff: true, cacheOnly: true });
        } catch (error) {
          if (!cancelled) setGitActionError(t('rightSidebar.gitActionFailed', { message: error instanceof Error ? error.message : 'Unknown error' }));
        } finally {
          if (!cancelled) setRunningGitAction(null);
        }
        return;
      }
    })();
    return () => { cancelled = true; };
  }, [activeGitActionRepoRoot, applyGitBundle, gitPaneActive, isCurrentSidebarRoot, rootPath, runningGitAction, t, waitForGitActionJob]);

  const commitActionCompleted = completedGitAction?.action === 'commit';
  const switchBranchActionCompleted = completedGitAction?.action === 'switch-branch';
  const pullActionCompleted = completedGitAction?.action === 'pull';
  const pushActionCompleted = completedGitAction?.action === 'push';
  const effectiveGitQuickActionsOpen = gitPaneActive || gitQuickActionsOpen;

  const branchAuditScopeLabel = branchAuditTargetsAllRepos
    ? t('rightSidebar.changeAuditScopeAll')
    : branchAuditTargetRepos.length === 1
      ? branchAuditTargetRepos[0].label
      : `${branchAuditTargetRepos.length} repos`;
  const branchAuditHasTargets = branchAuditTargetRepos.length > 0;
  const branchAuditReadyToGenerate = branchAuditReadyRepos.length > 0;

  const branchAuditPromptButton = rootPath ? (
    <AuditPromptScopeButton
      open={branchAuditScopeOpen}
      onOpenChange={setBranchAuditScopeOpen}
      showScopePicker
      selectedAll={branchAuditTargetsAllRepos}
      repos={branchAuditScopeRepos}
      selectedRoots={branchAuditTargetRepoRoots}
      onToggleRepo={toggleBranchAuditRepoRoot}
      onGenerate={() => insertBranchAuditScopePrompt(hasBranchAuditRecords ? 'regenerate' : 'generate')}
      disabled={!branchAuditHasTargets}
      generateDisabled={!branchAuditReadyToGenerate}
      inserted={insertedReferenceKey?.startsWith('context:branch-audit-scope:') ?? false}
      buttonLabel={hasBranchAuditRecords ? t('rightSidebar.branchAuditRegenerate') : t('rightSidebar.branchAuditGenerate')}
      insertedLabel={t('rightSidebar.inserted')}
      title={t('rightSidebar.branchAuditGenerateTitle')}
      ariaLabel={t('rightSidebar.branchAuditShort')}
      scopeTitle={t('rightSidebar.changeAuditScopeLabel')}
      scopeLabel={branchAuditScopeLabel}
      allLabel={t('rightSidebar.changeAuditScopeAll')}
      generateLabel={hasBranchAuditRecords ? t('rightSidebar.branchAuditRegenerate') : t('rightSidebar.branchAuditGenerate')}
      onSecondaryAction={() => void openBranchAuditPreviewDiff()}
      secondaryDisabled={!branchAuditReadyToGenerate || branchAuditPreviewLoading}
      secondaryLabel={t('rightSidebar.branchAuditViewDiff')}
      secondaryTitle={t('rightSidebar.branchAuditViewDiffTitle')}
      secondaryLoading={branchAuditPreviewLoading}
      loading={branchAuditDetailsLoadingRoots.size > 0}
      statusTitle={branchAuditDetailsLoadingRoots.size > 0 ? t('rightSidebar.branchCandidatesLoading') : undefined}
      extraContent={(
        <div className="mb-2 space-y-1.5">
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md bg-surface-2 px-2 py-1.5 text-[11px] text-foreground">
            <span className="min-w-0">
              <span className="block font-medium">{t('rightSidebar.includeUncommitted')}</span>
              <span className="block truncate text-[10px] text-muted-foreground">{t('rightSidebar.includeUncommittedHint')}</span>
            </span>
            <input
              type="checkbox"
              checked={branchAuditIncludeUncommitted}
              onChange={(event) => setBranchAuditIncludeUncommitted(event.target.checked)}
              className="h-4 w-4 shrink-0 accent-[rgb(var(--primary-rgb))]"
            />
          </label>
          {branchAuditMissingBaseRepos.length > 0 && (
            <div className="rounded-md bg-[rgb(var(--warning-rgb)_/_0.12)] px-2 py-1.5 text-[10px] text-[color:var(--warning)]">
              {t('rightSidebar.missingBaseReposSkipped', { repositories: branchAuditMissingBaseRepos.map((repo) => repo.label).join(locale === 'zh' ? '、' : ', ') })}
            </div>
          )}
        </div>
      )}
      renderRepoExtra={(repo) => {
        const bundle = gitRepositoryByRoot.get(repo.root);
        const branchOptions: GitPickerOption[] = [];
        const seen = new Set<string>();
        const addBranch = (branch: string | null | undefined, meta?: string) => {
          if (!branch || seen.has(branch)) return;
          seen.add(branch);
          branchOptions.push({ value: branch, label: branch, meta });
        };
        addBranch(branchAuditRepoBranches[repo.root] || bundle?.context?.branch, t('rightSidebar.pushCurrentBranchBadge'));
        for (const branch of bundle?.context?.branches ?? []) addBranch(branch, branch === bundle?.context?.branch ? t('rightSidebar.pushCurrentBranchBadge') : t('rightSidebar.localBranch'));
        for (const branch of bundle?.context?.remoteBranches ?? []) addBranch(branch, t('rightSidebar.remoteBranch'));
        const baseOptions: GitPickerOption[] = [];
        const seenBase = new Set<string>();
        const addBase = (branch: string | null | undefined, meta?: string) => {
          if (!branch || seenBase.has(branch)) return;
          seenBase.add(branch);
          baseOptions.push({ value: branch, label: branch, meta });
        };
        addBase(branchAuditRepoBaseBranches[repo.root], branchAuditRepoBaseBranches[repo.root] ? t('rightSidebar.pushUpstreamBadge') : undefined);
        addBase(bundle?.context?.upstream, bundle?.context?.upstream ? t('rightSidebar.pushUpstreamBadge') : undefined);
        for (const branch of bundle?.context?.remoteBranches ?? []) addBase(branch, 'remote');
        for (const branch of bundle?.context?.branches ?? []) addBase(branch, branch === bundle?.context?.branch ? t('rightSidebar.pushCurrentBranchBadge') : 'local');
        return (
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            <GitTargetPicker
              label={t('rightSidebar.currentBranchLabel')}
              value={branchAuditRepoBranches[repo.root] || bundle?.context?.branch || ''}
              options={branchOptions}
              placeholder={t('rightSidebar.switchBranchPlaceholder')}
              searchPlaceholder={t('rightSidebar.switchBranchSearchPlaceholder')}
              emptyText={t('rightSidebar.switchNoBranches')}
              onChange={(branch) => {
                setBranchAuditRepoBranches((current) => ({
                  ...current,
                  [repo.root]: branch,
                }));
              }}
            />
            <GitTargetPicker
              label={t('rightSidebar.branchAuditBaseLabel')}
              value={branchAuditRepoBaseBranches[repo.root] || ''}
              options={baseOptions}
              placeholder={t('rightSidebar.branchAuditBasePlaceholder')}
              searchPlaceholder={t('rightSidebar.branchAuditBaseSearchPlaceholder')}
              emptyText={t('rightSidebar.branchAuditBaseEmpty')}
              onChange={(branch) => {
                setBranchAuditRepoBaseBranches((current) => ({
                  ...current,
                  [repo.root]: branch,
                }));
              }}
            />
          </div>
        );
      }}
    />
  ) : null;

  const latestChangeAuditTime = formatAuditTimestamp(
    changeAuditRecords.reduce((latest, record) => Math.max(latest, record.injectedAt ?? 0), 0),
    locale,
  );

  const branchAuditModulePanel = rootPath ? (
    <div className="border-b border-border/10 px-1 py-3">
      <button
        type="button"
        onClick={() => setBranchAuditModuleOpen((open) => { const next = !open; writeCache(BRANCH_AUDIT_MODULE_OPEN_STORAGE_KEY, next); return next; })}
        className="group flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left transition hover:bg-surface-2 active:scale-[0.99]"
        aria-expanded={branchAuditModuleOpen}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground group-hover:text-foreground">
          <RiSparkles size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold text-foreground">{t('rightSidebar.branchAuditTitle')}</span>
          <span className="block truncate text-[10px] text-muted-foreground">{branchAuditScopeLabel}</span>
        </span>
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition group-hover:bg-surface-elevated group-hover:text-foreground ${branchAuditModuleOpen ? 'rotate-90' : ''}`}>
          <RiChevronRight size={13} />
        </span>
      </button>
      {branchAuditModuleOpen && (
        <div className="mt-2 rounded-lg border border-border/10 bg-surface/60 p-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0 text-[11px] text-muted-foreground">
              {t('rightSidebar.changeAuditScopeLabel')}: {branchAuditScopeLabel}
            </div>
            {branchAuditPromptButton}
          </div>
          {branchAuditPreviewError && (
            <div className="mb-2 rounded-md bg-surface-2 px-2 py-1.5 text-[11px] text-destructive">
              {branchAuditPreviewError}
            </div>
          )}
          <div className="mt-2 space-y-1.5">
            {branchAuditPreviewEntries.map((entry) => (
              <div
                key={entry.key}
                className={`flex min-w-0 items-start gap-1 rounded-md transition ${
                  selectedBranchAuditHistoryKey === entry.key
                    ? 'bg-primary/15 text-primary'
                    : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                }`}
              >
                <button
                  type="button"
                  onClick={() => openBranchAuditPreviewEntry(entry)}
                  className="min-w-0 flex-1 px-2 py-1.5 text-left active:scale-[0.99]"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{entry.repoLabel}</span>
                    <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted-foreground">{entry.diff.hunks?.length ?? 0} hunk</span>
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="rounded bg-surface px-1.5 py-0.5">{entry.diff.currentBranch ?? 'HEAD'}</span>
                    <span className="text-muted-foreground/60">→</span>
                    <span className="rounded bg-surface px-1.5 py-0.5">{entry.diff.baseRef ?? entry.diff.baseBranch}</span>
                    <span className="rounded bg-surface px-1.5 py-0.5">{t('rightSidebar.branchAuditViewDiff')}</span>
                  </div>
                  {formatAuditTimestamp(entry.createdAt, locale) && (
                    <div className="mt-1 truncate text-[10px] text-muted-foreground/70">
                      {formatAuditTimestamp(entry.createdAt, locale)}
                    </div>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => deleteBranchAuditPreviewEntry(entry.key)}
                  className="mr-1 mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground active:scale-95"
                  title={t('common.delete')}
                  aria-label={t('common.delete')}
                >
                  <RiTrash size={12} />
                </button>
              </div>
            ))}
            {branchAuditHistoryGroups.length > 0 ? branchAuditHistoryGroups.slice(0, Math.max(0, 8 - branchAuditPreviewEntries.length)).map((group) => (
              <div
                key={group.key}
                className={`flex min-w-0 items-start gap-1 rounded-md transition ${
                  selectedBranchAuditHistoryKey === group.key
                    ? 'bg-primary/15 text-primary'
                    : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                }`}
              >
                <button
                  type="button"
                  onClick={() => openBranchAuditHistoryDetail(group.key)}
                  className="min-w-0 flex-1 px-2 py-1.5 text-left active:scale-[0.99]"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{group.repoLabel}</span>
                    <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted-foreground">{group.records.length} hunk</span>
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="rounded bg-surface px-1.5 py-0.5">{group.branchName ?? 'HEAD'}</span>
                    <span className="text-muted-foreground/60">→</span>
                    <span className="rounded bg-surface px-1.5 py-0.5">{group.baseRef}</span>
                    {group.diffFingerprint && <span className="rounded bg-surface px-1.5 py-0.5">{group.diffFingerprint}</span>}
                  </div>
                  {formatAuditTimestamp(group.latestInjectedAt, locale) && (
                    <div className="mt-1 truncate text-[10px] text-muted-foreground/70">
                      {t('rightSidebar.branchAuditGeneratedAt', { time: formatAuditTimestamp(group.latestInjectedAt, locale) ?? '' })}
                    </div>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void handleClearBranchAuditGroup(group)}
                  className="mr-1 mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground active:scale-95"
                  title={t('rightSidebar.branchAuditClearTitle')}
                  aria-label={t('rightSidebar.branchAuditClearTitle')}
                >
                  <RiTrash size={12} />
                </button>
              </div>
            )) : branchAuditPreviewEntries.length === 0 ? (
              <div className="rounded-md bg-surface-2 px-2 py-1.5 text-[11px] text-muted-foreground">
                {t('rightSidebar.branchAuditEmpty')}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  ) : null;

  const gitQuickActionsPanel = hasMountedGitPane && rootPath && gitDetailsLoaded ? (
    <div className={effectiveGitQuickActionsOpen ? 'overflow-visible' : 'overflow-hidden'}>
      {branchAuditModulePanel}
      <button
        type="button"
        onClick={() => {
          if (gitPaneActive) return;
          setGitQuickActionsOpen((open) => {
            const next = !open;
            if (next && activeGitActionRepoRoot && !gitDetailsLoaded && !gitDetailsLoading) void loadGitDetails(activeGitActionRepoRoot);
            return next;
          });
        }}
        aria-expanded={effectiveGitQuickActionsOpen}
        className={`group flex w-full items-center gap-2 px-1 py-1.5 text-left transition ${gitPaneActive ? 'cursor-default' : 'rounded-lg hover:bg-surface-2 active:scale-[0.99]'}`}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground group-hover:text-foreground">
          <RiGitBranch size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
          {t('rightSidebar.gitQuickActions')}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span className={`inline-flex min-w-[4.5rem] items-center justify-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${activeGitActionSummary.staged > 0 ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted-foreground'}`}>
            {gitDetailsLoading && <RiLoader size={10} className="animate-spin" />}
            {activeGitActionSummary.staged > 0 ? t('rightSidebar.stagedCount', { count: activeGitActionSummary.staged }) : t('rightSidebar.noStagedChangesShort')}
          </span>
          {!gitPaneActive && (
            <span className={`flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition group-hover:bg-surface-elevated group-hover:text-foreground ${effectiveGitQuickActionsOpen ? 'rotate-90' : ''}`}>
              <RiChevronRight size={13} />
            </span>
          )}
        </span>
      </button>
      {effectiveGitQuickActionsOpen && (
        <div className="space-y-0">
          {gitActionRepoOptions.length > 1 && (
            <div className="border-b border-border/10 px-1 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold text-foreground">{t('rightSidebar.gitRepositorySectionTitle')}</div>
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{activeGitActionRepoLabel}</div>
                </div>
              </div>
              <GitTargetPicker
                label={t('rightSidebar.gitRepositoryLabel')}
                value={activeGitActionRepoRoot ?? ''}
                options={gitActionRepoOptions}
                placeholder={t('rightSidebar.gitRepositoryPlaceholder')}
                searchPlaceholder={t('rightSidebar.gitRepositorySearchPlaceholder')}
                emptyText={t('rightSidebar.gitRepositoryEmpty')}
                disabled={Boolean(runningGitAction)}
                onChange={(repoRoot) => {
                  selectGitRepoRoot(repoRoot || null);
                }}
              />
              {requiresGitActionRepoSelection && (
                <div className="mt-2 rounded-md bg-[rgb(var(--warning-rgb)_/_0.12)] px-2 py-1.5 text-[11px] text-[color:var(--warning)]">
                  {t('rightSidebar.selectRepositoryForGitActions')}
                </div>
              )}
            </div>
          )}
          <div className="border-b border-border/10 px-1 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-foreground">{t('rightSidebar.branchSectionTitle')}</div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{activeGitActionBranchLabel}</div>
              </div>
              <button
                type="button"
                onClick={() => void handleSwitchBranch()}
                disabled={!canSwitchBranch}
                className={`relative inline-flex h-7 shrink-0 items-center justify-center rounded-md px-2.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 active:scale-95 ${switchBranchActionCompleted ? 'bg-accent/10 text-accent hover:bg-accent/15' : 'bg-surface-2 text-foreground hover:bg-surface-elevated'}`}
                title={t('rightSidebar.switchBranch')}
              >
                <span className={runningGitAction?.action === 'switch-branch' || switchBranchActionCompleted ? 'opacity-0' : ''}>{t('rightSidebar.switchBranch')}</span>
                {runningGitAction?.action === 'switch-branch' && <RiLoader size={12} className="absolute animate-spin" />}
                {switchBranchActionCompleted && runningGitAction?.action !== 'switch-branch' && <span className="absolute">✓</span>}
              </button>
            </div>
            <GitTargetPicker
              label={t('rightSidebar.currentBranchLabel')}
              value={switchBranch}
              options={switchBranchOptions}
              placeholder={t('rightSidebar.switchBranchPlaceholder')}
              searchPlaceholder={t('rightSidebar.switchBranchSearchPlaceholder')}
              emptyText={t('rightSidebar.switchNoBranches')}
              disabled={Boolean(runningGitAction)}
              onChange={setSwitchBranch}
            />
          </div>
          <div className="border-b border-border/10 px-1 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-foreground">{t('rightSidebar.commitSectionTitle')}</div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {requiresGitActionRepoSelection
                    ? t('rightSidebar.selectRepositoryForGitActions')
                    : activeGitActionSummary.staged > 0 ? t('rightSidebar.commitReadyHint', { count: activeGitActionSummary.staged }) : t('rightSidebar.commitNeedsStaged')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleQuickCommit()}
                disabled={Boolean(runningGitAction) || requiresGitActionRepoSelection || activeGitActionSummary.staged === 0 || !commitMessage.trim()}
                className={`relative inline-flex h-7 shrink-0 items-center justify-center rounded-md px-2.5 text-[11px] font-semibold transition active:scale-95 ${commitActionCompleted ? 'bg-accent/10 text-accent disabled:bg-accent/10 disabled:text-accent' : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-surface-2 disabled:text-muted-foreground'} disabled:cursor-not-allowed`}
                title={requiresGitActionRepoSelection ? t('rightSidebar.selectRepositoryForGitActions') : activeGitActionSummary.staged === 0 ? t('rightSidebar.commitNeedsStaged') : t('rightSidebar.commitChanges')}
              >
                <span className={runningGitAction?.action === 'commit' || commitActionCompleted ? 'opacity-0' : ''}>{t('rightSidebar.commitChanges')}</span>
                {runningGitAction?.action === 'commit' && <RiLoader size={12} className="absolute animate-spin" />}
                {commitActionCompleted && runningGitAction?.action !== 'commit' && <span className="absolute">✓</span>}
              </button>
            </div>
            <input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void handleQuickCommit();
                }
              }}
              placeholder={t('rightSidebar.commitMessagePlaceholder')}
              disabled={Boolean(runningGitAction)}
              className="w-full rounded-md border border-border/15 bg-surface-2 px-2.5 py-1.5 text-[12px] text-foreground outline-none transition placeholder:text-muted-foreground/70 focus:border-primary/35 focus:ring-1 focus:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-60"
              maxLength={300}
            />
          </div>
          <div className="border-b border-border/10 px-1 py-3">
            <button
              type="button"
              onClick={() => setRecentCommitsOpen((open) => !open)}
              className="group flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1.5 text-left transition hover:bg-surface-2 active:scale-[0.99]"
              aria-expanded={recentCommitsOpen}
            >
              <span className="min-w-0 text-[11px] font-semibold text-foreground">{t('rightSidebar.recentCommitsTitle')}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                {recentCommitsLoading && <RiLoader size={12} className="animate-spin text-muted-foreground" />}
                <span className={`flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition group-hover:bg-surface-elevated group-hover:text-foreground ${recentCommitsOpen ? 'rotate-90' : ''}`}>
                  <RiChevronRight size={13} />
                </span>
              </span>
            </button>
            {recentCommitsOpen && (
              <div className="mt-2 space-y-2">
                <div className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5 text-muted-foreground focus-within:bg-surface-elevated">
                  <RiSearch size={12} className="shrink-0" />
                  <input
                    value={recentCommitQuery}
                    onChange={(event) => setRecentCommitQuery(event.target.value)}
                    placeholder={t('rightSidebar.recentCommitsSearchPlaceholder')}
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground"
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {recentCommitQuery && (
                    <button
                      type="button"
                      onClick={() => setRecentCommitQuery('')}
                      className="rounded-full p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
                      aria-label={t('rightSidebar.clearSearch')}
                    >
                      <RiCloseLine size={12} />
                    </button>
                  )}
                </div>
                <div className="max-h-56 space-y-1 overflow-y-auto overscroll-contain pr-1" onScroll={handleRecentCommitsScroll}>
                  {recentCommits.length > 0 ? (
                    recentCommits.map((commit) => {
                      const [hash, ...messageParts] = commit.split(/\s+/);
                      const message = messageParts.join(' ') || commit;
                      return (
                        <button
                          key={commit}
                          type="button"
                          onClick={() => void openCommitDiff(commit)}
                          className="flex w-full min-w-0 items-start gap-2 rounded-md bg-surface-2 px-2 py-1.5 text-left font-mono text-[10px] transition hover:bg-surface-elevated active:scale-[0.99]"
                          title={message}
                        >
                          <span className="shrink-0 text-[color:var(--diff-hunk-accent)]">{hash}</span>
                          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={message}>{message}</span>
                          {commitDiffLoading === hash && <RiLoader size={11} className="shrink-0 animate-spin text-muted-foreground" />}
                        </button>
                      );
                    })
                  ) : recentCommitsLoading ? (
                    <div className="rounded-md bg-surface-2 px-2 py-2 text-center text-[11px] text-muted-foreground">
                      {t('common.loading')}
                    </div>
                  ) : (
                    <div className="rounded-md bg-surface-2 px-2 py-1.5 text-[11px] text-muted-foreground">
                      {t('rightSidebar.recentCommitsEmpty')}
                    </div>
                  )}
                  {recentCommitsLoadingMore && (
                    <div className="flex justify-center rounded-md bg-surface-2 px-2 py-2 text-muted-foreground">
                      <RiLoader size={12} className="animate-spin" />
                    </div>
                  )}
                  {recentCommitsHasMore && !recentCommitsLoadingMore && recentCommits.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void loadRecentCommits({ reset: false })}
                      className="w-full rounded-md bg-surface-2 px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
                    >
                      {t('rightSidebar.recentCommitsLoadMore')}
                    </button>
                  )}
                </div>
              </div>
            )}
            {commitDiffError && (
              <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                {commitDiffError}
              </div>
            )}
            {recentCommitsError && (
              <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                {recentCommitsError}
              </div>
            )}
          </div>
          <div className="px-1 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold text-foreground">{t('rightSidebar.pushSectionTitle')}</div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleQuickPull()}
                  disabled={!canPull}
                  className={`relative inline-flex h-7 min-w-[3.25rem] items-center justify-center rounded-md px-2.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 active:scale-95 ${pullActionCompleted ? 'bg-accent/10 text-accent hover:bg-accent/15' : 'bg-surface-2 text-foreground hover:bg-surface-elevated'}`}
                  title={t('rightSidebar.pullChanges')}
                >
                  <span className={runningGitAction?.action === 'pull' || pullActionCompleted ? 'opacity-0' : ''}>{t('rightSidebar.pullChanges')}</span>
                  {runningGitAction?.action === 'pull' && <RiLoader size={12} className="absolute animate-spin" />}
                  {pullActionCompleted && runningGitAction?.action !== 'pull' && <span className="absolute">✓</span>}
                </button>
                <button
                  type="button"
                  onClick={() => void handleQuickPush()}
                  disabled={!canPush}
                  className={`relative inline-flex h-7 min-w-[3.25rem] items-center justify-center rounded-md px-2.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 active:scale-95 ${pushActionCompleted ? 'bg-accent/10 text-accent hover:bg-accent/15' : 'bg-surface-2 text-foreground hover:bg-surface-elevated'}`}
                  title={t('rightSidebar.pushChanges')}
                >
                  <span className={runningGitAction?.action === 'push' || pushActionCompleted ? 'opacity-0' : ''}>{t('rightSidebar.pushChanges')}</span>
                  {runningGitAction?.action === 'push' && <RiLoader size={12} className="absolute animate-spin" />}
                  {pushActionCompleted && runningGitAction?.action !== 'push' && <span className="absolute">✓</span>}
                </button>
              </div>
            </div>
            <div
              className={`mb-2 flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[11px] ${pushSyncInfo.className}`}
              title={activeGitActionContext?.upstream ?? undefined}
            >
              <span className="truncate font-medium">{pushSyncInfo.text}</span>
              <span className="w-[6.5rem] shrink-0 truncate text-right text-[10px] opacity-75">
                {activeGitActionContext?.upstream ?? ''}
              </span>
            </div>
            <div className={`grid gap-1.5 ${showPushRemotePicker ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {showPushRemotePicker && (
                <GitTargetPicker
                  label={t('rightSidebar.pushRemoteLabel')}
                  value={pushRemote}
                  options={pushRemoteOptions}
                  placeholder={t('rightSidebar.pushRemotePlaceholder')}
                  searchPlaceholder={t('rightSidebar.pushRemoteSearchPlaceholder')}
                  emptyText={t('rightSidebar.pushNoRemotes')}
                  disabled={Boolean(runningGitAction)}
                  onChange={setPushRemote}
                />
              )}
              <GitTargetPicker
                label={t('rightSidebar.pushBranchLabel')}
                value={pushBranch}
                options={pushBranchOptions}
                placeholder={t('rightSidebar.pushBranchPlaceholder', { branch: activeGitActionContext?.branch ?? 'HEAD' })}
                searchPlaceholder={t('rightSidebar.pushBranchSearchPlaceholder')}
                emptyText={t('rightSidebar.pushNoBranches')}
                disabled={Boolean(runningGitAction)}
                onChange={setPushBranch}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  ) : null;

  const buildGitActionButtons = useCallback((file: GitChangedFile): GitActionButton[] => {
    const repoRoot = getChangedFileRepoRoot(file, rootPath);
    if (!repoRoot) return [];
    const busyPath = getChangedFileBusyPath(file);
    const buttons: GitActionButton[] = [];
    if (file.canStage) {
      buttons.push({
        key: 'stage-file',
        label: t('rightSidebar.stageFile'),
        onClick: () => void runSidebarGitAction({ action: 'stage-file', cwd: repoRoot, paths: [file.path] }, t('rightSidebar.stageFile'), busyPath),
      });
    }
    if (file.canUnstage) {
      buttons.push({
        key: 'unstage-file',
        label: t('rightSidebar.unstageFile'),
        onClick: () => void runSidebarGitAction({ action: 'unstage-file', cwd: repoRoot, paths: [file.path] }, t('rightSidebar.unstageFile'), busyPath),
      });
    }
    if (file.canStash) {
      buttons.push({
        key: 'stash-file',
        label: t('rightSidebar.stashFile'),
        onClick: () => void runSidebarGitAction({ action: 'stash-file', cwd: repoRoot, paths: [file.path] }, t('rightSidebar.stashFile'), busyPath),
      });
    }
    if (file.canRestoreWorktree) {
      buttons.push({
        key: 'restore-worktree-file',
        label: t('rightSidebar.restoreFile'),
        destructive: true,
        onClick: () => setConfirmGitAction({ kind: 'restore', file, phrase: '' }),
      });
    }
    return buttons;
  }, [rootPath, runSidebarGitAction, t]);

  const closeFilePreview = useCallback(() => {
    if (rightSidebarFilePreviewOpen) {
      onCloseRightSidebarFilePreview?.();
      return;
    }
    setMobileFileSlideIndex(0);
    mobileFileSwiperRef.current?.slideTo(0);
    setMobileFilePreviewOpen(false);
    setLineRange(null);
  }, [onCloseRightSidebarFilePreview, rightSidebarFilePreviewOpen]);

  const fileExplorerNavigation = (
    <div className="sticky top-0 z-10 border-b border-border/15 bg-surface/95 px-2.5 py-1.5 backdrop-blur">
      <div className="flex min-h-9 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <button
          type="button"
          onClick={goToExplorerParent}
          disabled={!explorerParentPath}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 active:scale-95"
          aria-label={t('rightSidebar.parentFolder')}
          title={t('rightSidebar.parentFolder')}
        >
          <RiArrowUp size={14} />
        </button>
        <button
          type="button"
          onClick={goToProjectRoot}
          disabled={!rootPath || explorerRoot === rootPath}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 active:scale-95"
          aria-label={t('rightSidebar.backToProjectRoot')}
          title={t('rightSidebar.backToProjectRoot')}
        >
          <RiHome size={14} />
        </button>
        <button
          type="button"
          onClick={refreshExplorerRoot}
          disabled={!fileTreeRoot}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 active:scale-95"
          aria-label={t('rightSidebar.refreshFiles')}
          title={fileWatchError ? t('rightSidebar.fileWatchUnavailable', { message: fileWatchError }) : t('rightSidebar.refreshFiles')}
        >
          <RiRefresh size={13} />
        </button>
        <button
          type="button"
          onClick={togglePinnedExplorerRoot}
          disabled={!canPinFileTreeRoot}
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-35 active:scale-95 ${fileTreeRootPinned ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
          aria-label={fileTreeRootPinned ? t('rightSidebar.unpinCurrentFolder') : t('rightSidebar.pinCurrentFolder')}
          title={fileTreeRootPinned ? t('rightSidebar.unpinCurrentFolder') : t('rightSidebar.pinCurrentFolder')}
        >
          {fileTreeRootPinned ? <RiPinOff size={13} /> : <RiPin size={13} />}
        </button>
        <button
          type="button"
          onClick={toggleShowHiddenFiles}
          aria-pressed={showHiddenFiles}
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition active:scale-95 ${showHiddenFiles ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
          aria-label={showHiddenFiles ? t('rightSidebar.hideHiddenFiles') : t('rightSidebar.showHiddenFiles')}
          title={showHiddenFiles ? t('rightSidebar.hideHiddenFiles') : t('rightSidebar.showHiddenFiles')}
        >
          {showHiddenFiles ? <RiEye size={13} /> : <RiEyeOff size={13} />}
        </button>
        <div className="mx-1 hidden h-4 w-px shrink-0 bg-border/20 sm:block" />
        <div className="min-w-0 flex-1 basis-full pt-0.5 sm:basis-0 sm:pt-0" title={fileTreeRoot ?? undefined}>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {t('rightSidebar.browsingLocation')}
              </span>
              <span className="truncate text-[12px] font-medium text-foreground">{explorerName}</span>
            </div>
              <button
                type="button"
                onClick={() => fileTreeRoot && insertPathReference(fileTreeRoot, fileTreeRootReferenceKey ?? undefined)}
                disabled={!fileTreeRoot}
                {...(fileTreeRoot && fileTreeRootReferenceKey ? getReferenceLongPressHandlers(getPathReferenceText(fileTreeRoot), fileTreeRootReferenceKey) : {})}
                className={`inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-full px-2 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-35 active:scale-95 ${
                fileTreeRootReferenceKey && (insertedReferenceKey === fileTreeRootReferenceKey || copiedReferenceKey === fileTreeRootReferenceKey)
                  ? 'bg-surface-elevated text-foreground'
                  : 'bg-primary/10 text-primary hover:bg-primary/20'
              }`}
                aria-label={t('rightSidebar.insertCurrentFolder')}
                title={t('rightSidebar.insertCurrentFolder')}
              >
                <RiLink size={12} />
              <span>{fileTreeRootReferenceKey && copiedReferenceKey === fileTreeRootReferenceKey ? t('rightSidebar.copied') : fileTreeRootReferenceKey && insertedReferenceKey === fileTreeRootReferenceKey ? t('rightSidebar.inserted') : t('rightSidebar.insertCurrentFolderShort')}</span>
              </button>
          </div>
          {fileTreeRoot && (
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground/75">
              {fileTreeRoot}
            </div>
          )}
        </div>
        {browsingOutsideProject && (
          <span
            className="hidden shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary sm:inline-flex"
            title={t('rightSidebar.browsingOutsideProjectHint')}
          >
            {t('rightSidebar.browsingOutsideProject')}
          </span>
        )}
      </div>
      {rootPath && (pinnedExplorerRoots.length > 0 || browsingOutsideProject) && (
        <div className="mt-1 flex items-center gap-1 overflow-x-auto pb-0.5 text-[11px]">
          <span className="shrink-0 px-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {t('rightSidebar.pinnedFolders')}
          </span>
          <button
            type="button"
            onClick={goToProjectRoot}
            className={`inline-flex max-w-[9rem] shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium transition active:scale-95 ${fileTreeRoot === rootPath ? 'bg-surface-elevated text-foreground' : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'}`}
            title={rootPath}
          >
            <RiHome size={10} className="shrink-0" />
            <span className="truncate">{rootName}</span>
          </button>
          {pinnedExplorerRoots.map((entry) => {
            const path = entry.path;
            const isFile = entry.kind === 'file';
            const active = isFile ? selectedFilePath === path : fileTreeRoot === path;
            return (
              <span key={path} className={`group inline-flex max-w-[12rem] shrink-0 items-center rounded-full transition ${active ? 'bg-primary/15 text-primary' : 'bg-surface-2 text-foreground hover:bg-surface-elevated'}`} title={path}>
                <button
                  type="button"
                  onClick={() => (isFile ? handleFileSelect(path) : setExplorerRoot(path))}
                  className="inline-flex min-w-0 items-center gap-1 px-2 py-0.5 font-medium active:scale-95"
                >
                  {isFile ? <RiFileText size={10} className="shrink-0" /> : <RiPin size={10} className="shrink-0" />}
                  <span className="truncate">{getPathBasename(path)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => unpinExplorerRoot(path)}
                  className="mr-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
                  aria-label={t('rightSidebar.unpinFolder', { name: getPathBasename(path) })}
                  title={t('rightSidebar.unpinFolder', { name: getPathBasename(path) })}
                >
                  <RiCloseLine size={9} />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );

  const diffRefreshButton = rootPath ? (
    <button
      type="button"
      onClick={() => void refreshGitState()}
      disabled={gitBundleLoading}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 active:scale-95"
      aria-label={t('rightSidebar.refreshGit')}
      title={t('rightSidebar.refreshGit')}
    >
      <RiRefresh size={13} className={gitBundleLoading ? 'animate-spin' : ''} />
    </button>
  ) : null;

  const changeAuditScopeLabel = changeAuditTargetsAllRepos
    ? t('rightSidebar.changeAuditScopeAll')
    : changeAuditTargetRepos.length === 1
      ? (changeAuditTargetRepos[0].relativeRoot === '.' ? rootName : changeAuditTargetRepos[0].relativeRoot || changeAuditTargetRepos[0].name)
      : `${changeAuditTargetRepos.length} repos`;

  const changeAuditButton = rootPath ? (
    <div className="inline-flex h-7 shrink-0 items-center">
      <AuditPromptScopeButton
        open={changeAuditScopeOpen}
        onOpenChange={setChangeAuditScopeOpen}
        showScopePicker={showGitRepoFilter}
        selectedAll={changeAuditTargetsAllRepos}
        repos={changeAuditScopeRepos}
        selectedRoots={changeAuditTargetRepoRoots}
        onToggleRepo={toggleChangeAuditRepoRoot}
        onGenerate={() => insertChangeAuditPrompt()}
        disabled={!rootPath}
        inserted={insertedReferenceKey === changeAuditPromptKey}
        buttonLabel={t('rightSidebar.changeAuditShort')}
        insertedLabel={t('rightSidebar.inserted')}
        title={t('rightSidebar.insertChangeAuditPromptTitle')}
        ariaLabel={t('rightSidebar.insertChangeAuditPrompt')}
        scopeTitle={t('rightSidebar.changeAuditScopeLabel')}
        scopeLabel={changeAuditScopeLabel}
        allLabel={t('rightSidebar.changeAuditScopeAll')}
        generateLabel={t('rightSidebar.changeAuditShort')}
        loading={changeAuditLoading}
        error={Boolean(changeAuditError)}
        statusTitle={changeAuditError
          ?? (changeAuditLoading
            ? t('rightSidebar.changeAuditLoading')
            : changeAuditRecords.length > 0
              ? `${t('rightSidebar.changeAuditLoaded', { count: changeAuditRecords.length })}${latestChangeAuditTime ? ` · ${t('rightSidebar.changeAuditLoadedAt', { time: latestChangeAuditTime })}` : ''}`
              : undefined)}
      />
      <button
        type="button"
        onClick={() => void handleClearLoadedChangeAuditRecords()}
        disabled={changeAuditLoading || changeAuditRecords.length === 0}
        className={`inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none active:scale-95 ${
          changeAuditRecords.length > 0 ? '' : 'invisible'
        }`}
        title={t('rightSidebar.clearChangeAuditTitle')}
        aria-label={t('rightSidebar.clearChangeAudit')}
      >
        <RiTrash size={12} />
      </button>
    </div>
  ) : null;

  const gitSummaryChips = (changedFiles.size > 0 || gitContext?.available || gitBundleLastLoadedAt) ? (
    <div className="flex flex-wrap items-center gap-1 text-[10px] font-medium">
      {gitContext?.available && gitContext.branch && (
        <span className="inline-flex min-w-0 max-w-[8rem] items-center gap-0.5 truncate rounded bg-surface-2 px-1.5 py-0.5 text-muted-foreground" title={gitContext.branch}>
          <RiGitBranch size={10} className="shrink-0" />
          <span className="truncate">{gitContext.branch}</span>
        </span>
      )}
      {changedSummary.modified > 0 && (
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[color:var(--diff-hunk-accent)]">{changedSummary.modified}M</span>
      )}
      {changedSummary.added > 0 && (
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[color:var(--diff-insert-strong)]">+{changedSummary.added}</span>
      )}
      {changedSummary.deleted > 0 && (
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[color:var(--diff-delete-strong)]">-{changedSummary.deleted}</span>
      )}
      {changedSummary.renamed > 0 && (
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-muted-foreground">{changedSummary.renamed}R</span>
      )}
      {changedSummary.copied > 0 && (
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[color:var(--diff-insert-strong)]">{changedSummary.copied}C</span>
      )}
      {changedSummary.untracked > 0 && (
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[color:var(--diff-insert-strong)]">{changedSummary.untracked}U</span>
      )}
      {changedSummary.conflicted > 0 && (
        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">{changedSummary.conflicted}!</span>
      )}
      {changedSummary.other > 0 && (
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-muted-foreground">{changedSummary.other}?</span>
      )}
      {changedSummary.staged > 0 && (
        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-accent">{t('rightSidebar.stagedCountShort', { count: changedSummary.staged })}</span>
      )}
      {gitContext?.available && rootPath && changedFiles.size > 0 && gitRepositories.length <= 1 && (
        <button
          type="button"
          onClick={() => void runSidebarGitAction({ action: 'stage-all', cwd: rootPath }, t('rightSidebar.stageAll'))}
          disabled={Boolean(runningGitAction)}
          className="rounded-full bg-accent/10 px-2 py-0.5 font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
          title={t('rightSidebar.stageAll')}
        >
          {t('rightSidebar.stageAll')}
        </button>
      )}
      {gitContext?.available && rootPath && changedFiles.size > 0 && gitRepositories.length <= 1 && (
        <button
          type="button"
          onClick={() => setConfirmGitAction({ kind: 'stash-all', repoRoot: rootPath, repoLabel: rootName })}
          disabled={Boolean(runningGitAction)}
          className="rounded-full bg-surface-2 px-2 py-0.5 font-medium text-foreground hover:bg-surface-elevated disabled:opacity-50"
          title={t('rightSidebar.stashAll')}
        >
          {t('rightSidebar.stashAll')}
        </button>
      )}
    </div>
  ) : null;

  return (
    <Sidebar
      side="right"
      isOpen={isOpen}
      drawerWidthPx={drawerWidthPx}
      onClose={onClose}
      onOpen={onOpen}
      push={push}
    >
      {getReferenceLongPressHandlers.popoverNode}
      {/* Header — single compact row + tab bar. The header is laid out as a
          fixed-shape column: every conditional block (search, chip row,
          recent refs) reserves a minimum slot so opening/closing them never
          reflows the content below. The toast is absolutely positioned
          inside the header so its appearance doesn't push siblings. */}
      <div className="relative shrink-0 border-b border-border/15 bg-surface px-2 pt-2">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1 px-1">
            <div className="flex min-h-[1.25rem] items-baseline gap-1.5">
              <span className="truncate text-[13px] font-semibold text-foreground" title={rootPath ?? undefined}>
                {rootName}
              </span>
              {(!isMobile || mobileSidebarSettled) && gitContext?.available && gitContext.branch && (
                <span className="inline-flex min-w-0 items-center gap-0.5 truncate text-[11px] text-muted-foreground" title={gitContext.branch}>
                  <RiGitBranch size={10} className="shrink-0" />
                  <span className="max-w-[7rem] truncate">{gitContext.branch}</span>
                </span>
              )}
              {(!isMobile || mobileSidebarSettled) && gitBundleLastLoadedAt && (
                <span
                  className={`truncate text-[10px] ${gitBundleCacheInfo?.stale ? 'text-[color:var(--warning)]' : 'text-muted-foreground/75'}`}
                  title={[
                    `Git data loaded ${formatGitCacheAge(gitBundleCacheInfo?.cacheAgeMs ?? (Date.now() - gitBundleLastLoadedAt))}`,
                    gitBundleCacheInfo?.cached ? 'from server cache' : 'fresh',
                    gitBundleCacheInfo?.stale ? 'stale cache' : null,
                  ].filter(Boolean).join(' · ')}
                >
                  Git {formatGitCacheAge(gitBundleCacheInfo?.cacheAgeMs ?? (Date.now() - gitBundleLastLoadedAt))}
                  {gitBundleCacheInfo?.cached ? ' cached' : ''}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setContextDraftEnabled((enabled) => !enabled);
              setContextDraftCollapsed(false);
            }}
            className={`relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition active:scale-95 ${
              contextDraftEnabled
                ? 'bg-primary/15 text-primary'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            aria-pressed={contextDraftEnabled}
            aria-label={t('rightSidebar.toggleContextDraft')}
            title={t('rightSidebar.toggleContextDraft')}
          >
            <RiPencilLine size={14} />
            {!contextDraftEnabled && contextDraftText.trim() && (
              <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setRightSearchOpen(!searchOpen)}
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition active:scale-95 ${
              searchOpen
                ? 'bg-primary/15 text-primary'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            aria-label={t('rightSidebar.toggleSearch')}
            title={t('common.search')}
          >
            <RiSearch size={14} />
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95 disabled:opacity-50"
            aria-label={t('rightSidebar.uploadFiles')}
            title={t('rightSidebar.uploadFiles')}
          >
            {uploading ? <RiLoader size={14} className="animate-spin" /> : <RiUpload size={14} />}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              if (!files || files.length === 0) return;
              void handleUploadFiles(Array.from(files));
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive active:scale-95"
            aria-label={t('rightSidebar.close')}
          >
            <RiCloseLine size={14} />
          </button>
        </div>

        {searchOpen && (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1.5 text-muted-foreground focus-within:bg-surface-elevated">
              <RiSearch size={12} className="shrink-0" />
              <input
                data-right-search
                type="search"
                value={fileQuery}
                onChange={(event) => setFileQuery(event.target.value)}
                placeholder={searchMode === 'content' ? t('rightSidebar.searchPlaceholderContent') : t('rightSidebar.filterChanges')}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                enterKeyHint="search"
                spellCheck={false}
              />
              {/* Desktop keeps the mode switch compact and inline so it doesn't
                  add a second full-width row. Mobile uses the larger segmented
                  control below where tap targets matter more. */}
              {!isMobile && (
                <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface/70 p-0.5 text-[10px] font-medium">
                  <button
                    type="button"
                    onClick={() => updateSearchMode('name')}
                    aria-pressed={searchMode === 'name'}
                    className={`rounded-full px-2 py-0.5 transition active:scale-95 ${searchMode === 'name' ? 'bg-primary/15 text-primary' : 'text-muted-foreground/80 hover:text-foreground'}`}
                  >
                    {t('rightSidebar.searchModeName')}
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSearchMode('content')}
                    aria-pressed={searchMode === 'content'}
                    className={`rounded-full px-2 py-0.5 transition active:scale-95 ${searchMode === 'content' ? 'bg-primary/15 text-primary' : 'text-muted-foreground/80 hover:text-foreground'}`}
                  >
                    {t('rightSidebar.searchModeContent')}
                  </button>
                </div>
              )}
              {fileQuery && (
                <button
                  type="button"
                  onClick={() => setFileQuery('')}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
                  aria-label={t('rightSidebar.clearSearch')}
                >
                  <RiCloseLine size={12} />
                </button>
              )}
            </div>
            {isMobile && (
            <div className="flex items-center gap-0.5 rounded-full bg-surface-2 p-0.5 text-[11px] font-medium">
              <button
                type="button"
                onClick={() => setSearchMode('name')}
                aria-pressed={searchMode === 'name'}
                className={`flex-1 rounded-full px-2 py-1 transition active:scale-95 ${searchMode === 'name' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t('rightSidebar.searchModeName')}
              </button>
              <button
                type="button"
                onClick={() => setSearchMode('content')}
                aria-pressed={searchMode === 'content'}
                className={`flex-1 rounded-full px-2 py-1 transition active:scale-95 ${searchMode === 'content' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t('rightSidebar.searchModeContent')}
              </button>
            </div>
            )}
          </div>
        )}

        {/* Tab bar — non-Git workspaces drop the Git/Changes tabs. On mobile
            (overlay preview) and wide (side-by-side preview) layouts the file
            browser fills the panel with no tab bar at all; only the medium
            desktop layout keeps a Files/Preview switch. */}
        {gitKnownUnavailable ? (
          !isMobile && !isWide ? (
            <div className="mt-2 grid grid-cols-2 gap-0.5 rounded-md bg-surface-2 p-0.5">
              <button
                type="button"
                onClick={() => setRightTab('files')}
                className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                  effectiveRightTab === 'files'
                    ? 'bg-surface-elevated text-foreground'
                    : 'text-muted-foreground hover:bg-surface-2'
                }`}
              >
                <RiFolder size={12} />
                {t('rightSidebar.tabFiles')}
              </button>
              <button
                type="button"
                onClick={() => setRightTab('file')}
                className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                  effectiveRightTab === 'file'
                    ? 'bg-surface-elevated text-foreground'
                    : 'text-muted-foreground hover:bg-surface-2'
                }`}
              >
                <RiFileText size={12} />
                {t('rightSidebar.tabPreview')}
              </button>
            </div>
          ) : null
        ) : (
          <div className={`mt-2 grid gap-0.5 rounded-md bg-surface-2 p-0.5 ${isMobile ? 'grid-cols-3' : isWide ? 'grid-cols-3' : 'grid-cols-4'}`}>
            <button
              type="button"
              onClick={() => setRightTab('git')}
              className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                effectiveRightTab === 'git'
                  ? 'bg-surface-elevated text-foreground'
                  : 'text-muted-foreground hover:bg-surface-2'
              }`}
            >
              <RiGitBranch size={12} />
              {t('rightSidebar.tabGit')}
              {gitBundleLoading && effectiveRightTab === 'git' ? <RiLoader size={12} className="animate-spin text-muted-foreground" /> : null}
            </button>
            <button
              type="button"
              onClick={() => setRightTab('diff')}
              className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                effectiveRightTab === 'diff'
                  ? 'bg-surface-elevated text-foreground'
                  : 'text-muted-foreground hover:bg-surface-2'
              }`}
            >
              <RiGitCompare size={12} />
              {t('rightSidebar.tabChanges')}
              {gitBundleLoading ? (
                <RiLoader size={12} className="animate-spin text-muted-foreground" />
              ) : changedFiles.size > 0 ? (
                <span className="text-[10px] text-accent">{changedFiles.size}</span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => setRightTab('files')}
              className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                effectiveRightTab === 'files'
                  ? 'bg-surface-elevated text-foreground'
                  : 'text-muted-foreground hover:bg-surface-2'
              }`}
            >
              <RiFolder size={12} />
              {t('rightSidebar.tabFiles')}
            </button>
            {!isMobile && !isWide && (
              <button
                type="button"
                onClick={() => setRightTab('file')}
                className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-medium transition active:scale-[0.98] ${
                  effectiveRightTab === 'file'
                    ? 'bg-surface-elevated text-foreground'
                    : 'text-muted-foreground hover:bg-surface-2'
                }`}
              >
                <RiFileText size={12} />
                {t('rightSidebar.tabPreview')}
              </button>
            )}
          </div>
        )}
        <div className="h-2" />

        {gitActionError && (
          <div className="pointer-events-none absolute right-3 top-10 z-20 max-w-[72%] rounded-lg bg-destructive/95 px-3 py-2 text-[11px] font-medium text-destructive-foreground shadow-md animate-fade-in">
            {gitActionError}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-hidden bg-surface">
        <Pane
          active={gitPaneActive}
          mounted={hasMountedGitPane}
          fallback={(
            <GitChangesLoadingState slow={false} />
          )}
        >
          {commitDiff ? (
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              <UniversalDiffReview
                items={commitDiffReviewItems}
                selectedKey={selectedCommitDiffFileKey}
                onSelect={setSelectedCommitDiffFileKey}
                emptyText={t('rightSidebar.noChanges')}
                mobile={isMobile}
                backLabel={t('rightSidebar.backToChangeList')}
                headerTitle={t('rightSidebar.recentCommitsTitle')}
                headerMeta={`${commitDiff.headRef ?? ''}${commitDiff.commits?.[0] ? ` · ${commitDiff.commits[0]}` : ''}`}
                onClose={() => {
                  setCommitDiff(null);
                  setSelectedCommitDiffFileKey(null);
                }}
                closeLabel={t('common.back')}
                wrap={diffWrap}
                onToggleWrap={isWide ? undefined : toggleDiffWrap}
                wrapTitle={t('rightSidebar.wrapLongLines')}
                wrapOnLabel={t('rightSidebar.wrapOn')}
                wrapOffLabel={t('rightSidebar.wrapOff')}
                desktopLayout={isWide ? 'split' : 'stacked'}
                onInsertDiffReference={insertContextText}
                onReferenceCopied={markReferenceCopied}
                insertedReferenceKey={insertedReferenceKey}
                copiedReferenceKey={copiedReferenceKey}
                onClearAuditRecord={handleClearAuditRecord}
              />
            </div>
          ) : branchAuditDetailOpen ? (
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              <UniversalDiffReview
                items={branchAuditReviewItems}
                selectedKey={selectedBranchAuditFileKey}
                onSelect={setSelectedBranchAuditFileKey}
                emptyText={branchAuditPreviewDiff ? t('rightSidebar.branchAuditDiffEmpty') : t('rightSidebar.branchAuditEmpty')}
                mobile={isMobile}
                backLabel={t('rightSidebar.backToChangeList')}
                headerTitle={branchAuditPreviewDiff ? t('rightSidebar.branchAuditViewDiff') : t('rightSidebar.branchAuditTitle')}
                headerMeta={selectedBranchAuditDetailMeta
                  ? `${selectedBranchAuditDetailMeta.repoLabel} · ${selectedBranchAuditDetailMeta.branchName ?? 'HEAD'} → ${selectedBranchAuditDetailMeta.baseRef}`
                  : undefined}
                onClose={() => {
                  setBranchAuditDetailOpen(false);
                  setBranchAuditPreviewDiff(null);
                }}
                closeLabel={t('common.back')}
                wrap={diffWrap}
                onToggleWrap={isWide ? undefined : toggleDiffWrap}
                wrapTitle={t('rightSidebar.wrapLongLines')}
                wrapOnLabel={t('rightSidebar.wrapOn')}
                wrapOffLabel={t('rightSidebar.wrapOff')}
                desktopLayout={isWide ? 'split' : 'stacked'}
                onInsertDiffReference={insertContextText}
                onReferenceCopied={markReferenceCopied}
                insertedReferenceKey={insertedReferenceKey}
                copiedReferenceKey={copiedReferenceKey}
                onClearAuditRecord={handleClearAuditRecord}
                walkthroughs={selectedBranchWalkthroughs}
                onWalkthroughNavigate={handleBranchWalkthroughNavigate}
                initialDetailScrollTop={branchAuditPreviewDiff && selectedBranchAuditHistoryKey ? branchAuditPreviewScrollTops[selectedBranchAuditHistoryKey] : undefined}
                onDetailScrollPositionChange={handleBranchAuditDetailScrollPositionChange}
                externalSwiperRef={isMobile ? mobileDiffSwiperRef : undefined}
                onMobileSlideChange={isMobile ? setMobileDiffSlideIndex : undefined}
              />
            </div>
          ) : (
          <div className="h-full overflow-y-auto overscroll-contain px-2 py-2">
            {gitQuickActionsPanel ? (
              gitQuickActionsPanel
            ) : gitBundleLoading ? (
              <GitChangesLoadingState slow={gitBundleSlow} />
            ) : gitBundleError ? (
              <GitChangesErrorState message={gitBundleError} onRetry={() => void refreshGitState()} />
            ) : isConfirmedNonGitContext(gitContext) ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {rootPath ? t('rightSidebar.gitUnavailable') : t('fileTree.noWorkingDir')}
              </div>
            ) : gitContext?.available === false ? (
              <GitChangesErrorState message={gitContext.error ?? t('rightSidebar.gitChangesLoadFailed')} onRetry={() => void refreshGitState()} />
            ) : rootPath ? (
              <GitChangesLoadingState slow={gitBundleSlow} />
            ) : (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {rootPath ? t('rightSidebar.gitUnavailable') : t('fileTree.noWorkingDir')}
              </div>
            )}
          </div>
          )}
        </Pane>

        <Pane active={filesPaneActive}>
          {isWide ? (
            <div className="flex h-full min-h-0">
              <div
                ref={fileTreeScrollRef}
                onScroll={handleFileTreeScroll}
                onDragOver={handleFileTreeDragOver}
                onDragEnter={handleFileTreeDragOver}
                onDragLeave={handleFileTreeDragLeave}
                onDrop={handleFileTreeDrop}
                className="shrink-0 overflow-y-auto overscroll-contain bg-surface relative"
                style={{ width: fileTreeWidthPx }}
              >
                {dragOver && (
                  <div className="pointer-events-none absolute left-3 right-3 top-3 z-10 flex justify-center">
                    <div className="rounded-xl bg-surface-elevated px-4 py-2 text-sm font-semibold text-foreground shadow-lg">
                      {t('rightSidebar.dropToUpload')}
                    </div>
                  </div>
                )}
                {fileExplorerNavigation}
                <FileTree
                  rootPath={fileTreeRoot ?? ''}
                  onFileSelect={handleFileSelect}
                  onPathReference={insertPathReference}
                  getReferenceText={getPathReferenceText}
                  onReferenceCopied={markReferenceCopied}
                  insertedReferenceKey={insertedReferenceKey}
                  copiedReferenceKey={copiedReferenceKey}
                  onDirectoryRoot={openDirectoryAsExplorerRoot}
                  onDirectoryPinToggle={togglePinnedDirectory}
                  onFilePinToggle={togglePinnedFile}
                  pinnedPaths={pinnedExplorerRootSet}
                  selectedFilePath={selectedFilePath}
                  query={deferredFileQuery}
                  searchMode={searchMode}
                  onContentMatchSelect={handleContentMatchSelect}
                  onDirectoryDropFiles={(path, files) => handleUploadFiles(files, path)}
                  canOpenInFileBrowser={canOpenInFileBrowser}
                  onOpenInFileBrowser={handleOpenInFileBrowser}
                />
              </div>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t('rightSidebar.resizeFileTree')}
                title={t('rightSidebar.resizeFileTree')}
                className="group relative z-10 w-2 shrink-0 cursor-col-resize touch-none border-l border-border/15 bg-surface"
                onPointerDown={startFileTreeResize}
                onPointerMove={handleFileTreeResizeMove}
                onPointerUp={stopFileTreeResize}
                onPointerCancel={stopFileTreeResize}
                onDoubleClick={() => {
                  setFileTreeWidthPx(DEFAULT_FILE_TREE_WIDTH_PX);
                  writeCache(FILE_TREE_WIDTH_STORAGE_KEY, DEFAULT_FILE_TREE_WIDTH_PX);
                }}
              >
                <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border/20 transition group-hover:bg-primary/45" />
              </div>
              <div className="min-w-0 flex-1 overflow-hidden bg-surface">
                <FilePreview
                  filePath={filesPaneActive ? selectedFilePath : null}
                  onInsertReference={insertPathReference}
                  onInsertText={insertReferenceText}
                  onInsertFeature={insertReferenceText}
                  onReferenceCopied={markReferenceCopied}
                  isMobile={false}
                  lineRange={lineRange}
                  onLineRangeChange={setLineRange}
                  insertedReferenceKey={insertedReferenceKey}
                  copiedReferenceKey={copiedReferenceKey}
                  scrollToLine={scrollToLine}
                  onScrollToLineHandled={() => setScrollToLine(null)}
                  markdownOutlineOpen={markdownOutlineOpen}
                  markdownOutlineCloseSignal={markdownOutlineCloseSignal}
                  onOpenMarkdownOutline={onOpenMarkdownOutline}
                  onCloseMarkdownOutline={onCloseMarkdownOutline}
                  markdownImageLightboxOpen={markdownImageLightboxOpen}
                  markdownImageLightboxCloseSignal={markdownImageLightboxCloseSignal}
                  onOpenMarkdownImageLightbox={onOpenMarkdownImageLightbox}
                  onCloseMarkdownImageLightbox={onCloseMarkdownImageLightbox}
                />
              </div>
            </div>
          ) : isMobile ? (
            <Swiper
              className="h-full min-h-0 w-full"
              slidesPerView={1}
              resistanceRatio={0.45}
              noSwiping
              noSwipingClass="swiper-no-swiping"
              noSwipingSelector=".swiper-no-swiping"
              // Frozen until the sidebar gesture arbiter hands a horizontal
              // drag to this swiper (see gestureArbiter.ts). touchAngle is
              // widened so the mid-gesture handoff isn't misread as vertical.
              allowTouchMove={false}
              touchAngle={75}
              touchStartPreventDefault={false}
              onSwiper={(instance) => {
                mobileFileSwiperRef.current = instance;
                instance.slideTo(mobileFileSlideIndex, 0);
              }}
              onSlideChange={(instance) => {
                setMobileFileSlideIndex(instance.activeIndex);
                if (instance.activeIndex === 0) {
                  setMobileFilePreviewOpen(false);
                  setLineRange(null);
                  onCloseRightSidebarFilePreview?.();
                }
              }}
            >
              <SwiperSlide className="h-full min-h-0">
                <div
                  ref={fileTreeScrollRef}
                  onScroll={handleFileTreeScroll}
                  onDragOver={handleFileTreeDragOver}
                  onDragEnter={handleFileTreeDragOver}
                  onDragLeave={handleFileTreeDragLeave}
                  onDrop={handleFileTreeDrop}
                  className="h-full overflow-y-auto overscroll-contain bg-surface relative"
                >
                  {dragOver && (
                    <div className="pointer-events-none absolute left-3 right-3 top-3 z-10 flex justify-center">
                      <div className="rounded-xl bg-surface-elevated px-4 py-2 text-sm font-semibold text-foreground shadow-lg">
                        {t('rightSidebar.dropToUpload')}
                      </div>
                    </div>
                  )}
                  {fileExplorerNavigation}
                  <FileTree
                    rootPath={fileTreeRoot ?? ''}
                    onFileSelect={handleFileSelect}
                    onPathReference={insertPathReference}
                    getReferenceText={getPathReferenceText}
                    onReferenceCopied={markReferenceCopied}
                    insertedReferenceKey={insertedReferenceKey}
                    copiedReferenceKey={copiedReferenceKey}
                    onDirectoryRoot={openDirectoryAsExplorerRoot}
                    onDirectoryPinToggle={togglePinnedDirectory}
                    onFilePinToggle={togglePinnedFile}
                    pinnedPaths={pinnedExplorerRootSet}
                    selectedFilePath={selectedFilePath}
                    query={deferredFileQuery}
                    searchMode={searchMode}
                    onContentMatchSelect={handleContentMatchSelect}
                    onDirectoryDropFiles={(path, files) => handleUploadFiles(files, path)}
                    canOpenInFileBrowser={canOpenInFileBrowser}
                    onOpenInFileBrowser={handleOpenInFileBrowser}
                  />
                </div>
              </SwiperSlide>
              <SwiperSlide className="h-full min-h-0">
                <div className="h-full overflow-hidden bg-surface">
                  <FilePreview
                    filePath={filesPaneActive && (mobileFilePreviewOpen || mobileFileSlideIndex === 1) ? selectedFilePath : null}
                    onInsertReference={insertPathReference}
                    onInsertText={insertReferenceText}
                    onInsertFeature={insertReferenceText}
                    onReferenceCopied={markReferenceCopied}
                    onClose={closeFilePreview}
                    isMobile
                    lineRange={lineRange}
                    onLineRangeChange={setLineRange}
                    insertedReferenceKey={insertedReferenceKey}
                    copiedReferenceKey={copiedReferenceKey}
                    scrollToLine={scrollToLine}
                    onScrollToLineHandled={() => setScrollToLine(null)}
                    markdownOutlineOpen={markdownOutlineOpen}
                    markdownOutlineCloseSignal={markdownOutlineCloseSignal}
                    onOpenMarkdownOutline={onOpenMarkdownOutline}
                    onCloseMarkdownOutline={onCloseMarkdownOutline}
                    markdownImageLightboxOpen={markdownImageLightboxOpen}
                    markdownImageLightboxCloseSignal={markdownImageLightboxCloseSignal}
                    onOpenMarkdownImageLightbox={onOpenMarkdownImageLightbox}
                    onCloseMarkdownImageLightbox={onCloseMarkdownImageLightbox}
                  />
                </div>
              </SwiperSlide>
            </Swiper>
          ) : (
            <div
              ref={fileTreeScrollRef}
              onScroll={handleFileTreeScroll}
              onDragOver={handleFileTreeDragOver}
              onDragEnter={handleFileTreeDragOver}
              onDragLeave={handleFileTreeDragLeave}
              onDrop={handleFileTreeDrop}
              className="h-full overflow-y-auto overscroll-contain relative"
            >
              {dragOver && (
                <div className="pointer-events-none absolute left-3 right-3 top-3 z-10 flex justify-center">
                  <div className="rounded-xl bg-surface-elevated px-4 py-2 text-sm font-semibold text-foreground shadow-lg">
                    {t('rightSidebar.dropToUpload')}
                  </div>
                </div>
              )}
              {fileExplorerNavigation}
              <FileTree
                rootPath={fileTreeRoot ?? ''}
                onFileSelect={handleFileSelect}
                onPathReference={insertPathReference}
                getReferenceText={getPathReferenceText}
                onReferenceCopied={markReferenceCopied}
                insertedReferenceKey={insertedReferenceKey}
                copiedReferenceKey={copiedReferenceKey}
                onDirectoryRoot={openDirectoryAsExplorerRoot}
                onDirectoryPinToggle={togglePinnedDirectory}
                onFilePinToggle={togglePinnedFile}
                pinnedPaths={pinnedExplorerRootSet}
                selectedFilePath={selectedFilePath}
                query={deferredFileQuery}
                searchMode={searchMode}
                onContentMatchSelect={handleContentMatchSelect}
                onDirectoryDropFiles={(path, files) => handleUploadFiles(files, path)}
                canOpenInFileBrowser={canOpenInFileBrowser}
                onOpenInFileBrowser={handleOpenInFileBrowser}
              />
            </div>
          )}
        </Pane>

        <Pane active={previewPaneActive} mounted={hasMountedPreviewPane}>
          <FilePreview
            filePath={previewPaneActive ? selectedFilePath : null}
            onInsertReference={insertPathReference}
            onInsertText={insertReferenceText}
            onInsertFeature={insertReferenceText}
            onReferenceCopied={markReferenceCopied}
            isMobile={false}
            lineRange={lineRange}
            onLineRangeChange={setLineRange}
            insertedReferenceKey={insertedReferenceKey}
            copiedReferenceKey={copiedReferenceKey}
            scrollToLine={scrollToLine}
            onScrollToLineHandled={() => setScrollToLine(null)}
            markdownOutlineOpen={markdownOutlineOpen}
            markdownOutlineCloseSignal={markdownOutlineCloseSignal}
            onOpenMarkdownOutline={onOpenMarkdownOutline}
            onCloseMarkdownOutline={onCloseMarkdownOutline}
            markdownImageLightboxOpen={markdownImageLightboxOpen}
            markdownImageLightboxCloseSignal={markdownImageLightboxCloseSignal}
            onOpenMarkdownImageLightbox={onOpenMarkdownImageLightbox}
            onCloseMarkdownImageLightbox={onCloseMarkdownImageLightbox}
          />
        </Pane>

        <Pane active={diffPaneActive} mounted={hasMountedDiffPane || diffPaneActive}>
          {() => (isWide ? (
            <DiffReview
              mobile={false}
              desktopLayout="split"
              desktopSidePanel={null}
              desktopListClassName="w-[320px] min-w-[260px] shrink-0 overflow-y-auto overscroll-contain border-r border-border/15 bg-surface"
              backLabel={t('rightSidebar.backToChangeList')}
              groups={filteredChangedFiles.length > 0 ? buildDiffNavigatorGroups() : []}
              mode={diffChangeListMode}
              onModeChange={setDiffChangeMode}
              selectedKey={selectedFilePath}
              scrollToKey={effectiveDiffStreamScrollKey}
              scrollToKeyNonce={diffStreamScrollRequest.nonce}
              compact
              collapsedDirectoryKeys={collapsedDiffDirectories}
              onToggleDirectory={toggleDiffDirectory}
              onSelectFile={(navigatorFile) => {
                const file = Array.from(changedFiles.values()).find((candidate) => getChangedFileSelectionPath(candidate) === navigatorFile.key);
                if (!file) return;
                selectDiffFile(getChangedFileSelectionPath(file));
              }}
              renderLeading={renderChangeNavigatorLeading}
              renderTrailing={(navigatorFile) => {
                const file = Array.from(changedFiles.values()).find((candidate) => getChangedFileSelectionPath(candidate) === navigatorFile.key);
                return file ? renderChangeNavigatorTrailing(file) : null;
              }}
              renderSubtitle={(navigatorFile) => {
                const file = Array.from(changedFiles.values()).find((candidate) => getChangedFileSelectionPath(candidate) === navigatorFile.key);
                return file ? renderChangeNavigatorSubtitle(file) : null;
              }}
              aiContent={showChangeAiMode ? ((controls) => renderChangeWalkthroughPanel(controls)) : undefined}
              emptyContent={(
                gitBundleLoading && changedFiles.size === 0 && gitBundleLastLoadedAt === null ? (
                  <GitChangesLoadingState slow={gitBundleSlow} />
                ) : gitBundleError && changedFiles.size === 0 ? (
                  <GitChangesErrorState message={gitBundleError} onRetry={() => void refreshGitState()} />
                ) : changedFiles.size === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {t('rightSidebar.noChanges')}
                  </div>
                ) : filteredChangedFiles.length === 0 ? (
                  <div className="bg-surface-2 px-3 py-4 text-center text-xs text-muted-foreground">
                    {t('rightSidebar.noMatchingChanges')}
                  </div>
                ) : null
              )}
              renderListHeader={(modeToggle) => rootPath && (
                <div className="px-0 py-0">
                  {gitSummaryChips && (
                    <div className="mb-2">
                      {gitSummaryChips}
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <span className="px-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                      {t('rightSidebar.allChanges')}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground">{filteredChangedFiles.length}/{changedFiles.size}</span>
                    </div>
                  </div>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                    {renderRepoSwitcherButton()}
                    {modeToggle}
                    {renderDiffViewTypeToggle()}
                    {changeAuditButton}
                    {diffRefreshButton}
                  </div>
                  {activeGitRepoSummary && (
                    <div className="mt-2 flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{activeGitRepoSummary.label}</span>
                      {activeGitRepoSummary.branch && <span className="max-w-[7rem] truncate rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">{activeGitRepoSummary.branch}</span>}
                      <button
                        type="button"
                        onClick={() => runRepoGitAction('stage-all', activeGitRepoSummary.root, activeGitRepoSummary.label)}
                        disabled={Boolean(runningGitAction)}
                        className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
                        title={t('rightSidebar.stageAll')}
                      >
                        {t('rightSidebar.stageAll')}
                      </button>
                      <button
                        type="button"
                        onClick={() => runRepoGitAction('stash-all', activeGitRepoSummary.root, activeGitRepoSummary.label)}
                        disabled={Boolean(runningGitAction)}
                        className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-surface-elevated disabled:opacity-50"
                        title={t('rightSidebar.stashAll')}
                      >
                        {t('rightSidebar.stashAll')}
                      </button>
                    </div>
                  )}
                  {!activeGitRepoSummary && showGitRepoFilter && (
                    <div className="mt-2 flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1.5 text-[11px] text-muted-foreground">
                      <RiGitBranch size={12} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{t('rightSidebar.selectRepositoryForDiff')}</span>
                    </div>
                  )}
                </div>
              )}
              files={buildDiffReviewFiles()}
              activePane={diffPaneActive}
              wrap={diffWrap}
              showScrollHint={!diffWrap}
              diffViewType={isWide ? diffViewType : 'unified'}
              inlineMode={diffInlineMode}
              diffOptions={diffOptions}
              reloadKey={diffRefreshKey}
              renderStreamBadge={(status) => <ChangeBadge status={status} />}
              onInsertDiffReference={insertContextText}
              onReferenceCopied={markReferenceCopied}
              insertedReferenceKey={insertedReferenceKey}
              copiedReferenceKey={copiedReferenceKey}
              onClearAuditRecord={handleClearAuditRecord}
              onDetailScroll={syncSelectionFromDiffStream}
            />
          ) : (
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              {rootPath && !isMobile && (
                <div className="shrink-0 border-b border-border/15">
                  <div className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        {t('rightSidebar.allChanges')}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {filteredChangedFiles.length}/{changedFiles.size}
                      </div>
                    </div>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{filteredChangedFiles.length}/{changedFiles.size}</span>
                  </div>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                    {renderRepoSwitcherButton()}
                    {renderDiffChangeModeToggle()}
                    {renderDiffViewTypeToggle()}
                    {changeAuditButton}
                    {diffRefreshButton}
                    <button
                      type="button"
                      onClick={toggleDiffWrap}
                      aria-pressed={diffWrap}
                      title={t('rightSidebar.wrapLongLines')}
                      className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition active:scale-95 ${
                        diffWrap
                          ? 'bg-primary/15 text-primary'
                          : 'bg-surface-2 text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span className="font-mono text-[12px] leading-none">Aa</span>
                      <span>{diffWrap ? t('rightSidebar.wrapOn') : t('rightSidebar.wrapOff')}</span>
                    </button>
                  </div>
                  {activeGitRepoSummary && (
                    <div className="mt-2 flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{activeGitRepoSummary.label}</span>
                      {activeGitRepoSummary.branch && <span className="max-w-[7rem] truncate rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">{activeGitRepoSummary.branch}</span>}
                      <button
                        type="button"
                        onClick={() => runRepoGitAction('stage-all', activeGitRepoSummary.root, activeGitRepoSummary.label)}
                        disabled={Boolean(runningGitAction)}
                        className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
                        title={t('rightSidebar.stageAll')}
                      >
                        {t('rightSidebar.stageAll')}
                      </button>
                      <button
                        type="button"
                        onClick={() => runRepoGitAction('stash-all', activeGitRepoSummary.root, activeGitRepoSummary.label)}
                        disabled={Boolean(runningGitAction)}
                        className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-surface-elevated disabled:opacity-50"
                        title={t('rightSidebar.stashAll')}
                      >
                        {t('rightSidebar.stashAll')}
                      </button>
                    </div>
                  )}
                  {!activeGitRepoSummary && showGitRepoFilter && (
                    <div className="mt-2 flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1.5 text-[11px] text-muted-foreground">
                      <RiGitBranch size={12} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{t('rightSidebar.selectRepositoryForDiff')}</span>
                    </div>
                  )}
                  </div>
                </div>
              )}
              {isMobile ? (
                <DiffReview
                  mobile
                  backLabel={t('rightSidebar.backToChangeList')}
                  externalSwiperRef={mobileDiffSwiperRef}
                  onMobileSlideChange={setMobileDiffSlideIndex}
                  groups={filteredChangedFiles.length > 0 ? buildDiffNavigatorGroups() : []}
                  mode={diffChangeListMode}
                  onModeChange={setDiffChangeMode}
                  selectedKey={selectedFilePath}
                  scrollToKey={effectiveDiffStreamScrollKey}
                  scrollToKeyNonce={diffStreamScrollRequest.nonce}
                  compact={false}
                  collapsedDirectoryKeys={collapsedDiffDirectories}
                  onToggleDirectory={toggleDiffDirectory}
                  onSelectFile={(navigatorFile) => {
                    const file = Array.from(changedFiles.values()).find((candidate) => getChangedFileSelectionPath(candidate) === navigatorFile.key);
                    if (!file) return;
                    selectDiffFile(getChangedFileSelectionPath(file));
                  }}
                  renderLeading={renderChangeNavigatorLeading}
                  renderTrailing={(navigatorFile) => {
                    const file = Array.from(changedFiles.values()).find((candidate) => getChangedFileSelectionPath(candidate) === navigatorFile.key);
                    return file ? renderChangeNavigatorTrailing(file) : null;
                  }}
                  renderSubtitle={(navigatorFile) => {
                    const file = Array.from(changedFiles.values()).find((candidate) => getChangedFileSelectionPath(candidate) === navigatorFile.key);
                    return file ? renderChangeNavigatorSubtitle(file) : null;
                  }}
                  listContainerClassName="termdock-native-select min-h-0 px-2 pb-[calc(env(safe-area-inset-bottom)+4.5rem)]"
                  renderListHeader={(modeToggle) => rootPath && (
                    <div className="px-0 py-0">
                      {gitSummaryChips && (
                        <div className="mb-2">
                          {gitSummaryChips}
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                            {t('rightSidebar.allChanges')}
                          </div>
                        </div>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{filteredChangedFiles.length}/{changedFiles.size}</span>
                      </div>
                      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                        {renderRepoSwitcherButton()}
                        {modeToggle}
                        {changeAuditButton}
                        {diffRefreshButton}
                      </div>
                      {activeGitRepoSummary && (
                        <div className="mt-2 flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{activeGitRepoSummary.label}</span>
                          {activeGitRepoSummary.branch && <span className="max-w-[7rem] truncate rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">{activeGitRepoSummary.branch}</span>}
                        </div>
                      )}
                      {!activeGitRepoSummary && showGitRepoFilter && (
                        <div className="mt-2 flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1.5 text-[11px] text-muted-foreground">
                          <RiGitBranch size={12} className="shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{t('rightSidebar.selectRepositoryForDiff')}</span>
                        </div>
                      )}
                    </div>
                  )}
                  aiContent={showChangeAiMode ? ((controls) => renderChangeWalkthroughPanel(controls)) : undefined}
                  emptyContent={(
                    gitBundleLoading && changedFiles.size === 0 && gitBundleLastLoadedAt === null ? (
                      <GitChangesLoadingState slow={gitBundleSlow} />
                    ) : gitBundleError && changedFiles.size === 0 ? (
                      <GitChangesErrorState message={gitBundleError} onRetry={() => void refreshGitState()} />
                    ) : changedFiles.size === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                        {t('rightSidebar.noChanges')}
                      </div>
                    ) : filteredChangedFiles.length === 0 ? (
                      <div className="bg-surface-2 px-3 py-4 text-center text-xs text-muted-foreground">
                        {t('rightSidebar.noMatchingChanges')}
                      </div>
                    ) : null
                  )}
                  renderMobileDetailHeader={(
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => slideMobileDiffTo(0)}
                        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-xs font-semibold text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                        title={t('rightSidebar.backToChangeList')}
                      >
                        <RiArrowLeft size={14} />
                        {t('rightSidebar.backToChangeList')}
                      </button>
                      <button
                        type="button"
                        onClick={toggleDiffWrap}
                        aria-pressed={diffWrap}
                        title={t('rightSidebar.wrapLongLines')}
                        className={`inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-[11px] font-medium transition active:scale-95 ${
                          diffWrap
                            ? 'bg-primary/15 text-primary'
                            : 'bg-surface-2 text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <span className="font-mono text-[12px] leading-none">Aa</span>
                        <span>{diffWrap ? t('rightSidebar.wrapOn') : t('rightSidebar.wrapOff')}</span>
                      </button>
                    </div>
                  )}
                  detailContainerClassName="termdock-native-select termdock-diff-stream-scroller min-h-0"
                  files={buildDiffReviewFiles()}
                  activePane={diffPaneActive}
                  wrap={diffWrap}
                  showScrollHint={!diffWrap}
                  diffViewType="unified"
                  inlineMode={diffInlineMode}
                  diffOptions={diffOptions}
                  reloadKey={diffRefreshKey}
                  renderStreamBadge={(status) => <ChangeBadge status={status} />}
                  onInsertDiffReference={insertContextText}
                  onReferenceCopied={markReferenceCopied}
                  insertedReferenceKey={insertedReferenceKey}
                  copiedReferenceKey={copiedReferenceKey}
                  onClearAuditRecord={handleClearAuditRecord}
                  onDetailScroll={syncSelectionFromDiffStream}
                />
              ) : (
                <DiffReview
                  mobile={false}
                  desktopLayout="stacked"
                  backLabel={t('rightSidebar.backToChangeList')}
                  groups={filteredChangedFiles.length > 0 ? buildDiffNavigatorGroups() : []}
                  mode={diffChangeListMode}
                  onModeChange={setDiffChangeMode}
                  selectedKey={selectedFilePath}
                  scrollToKey={effectiveDiffStreamScrollKey}
                  scrollToKeyNonce={diffStreamScrollRequest.nonce}
                  compact={false}
                  collapsedDirectoryKeys={collapsedDiffDirectories}
                  onToggleDirectory={toggleDiffDirectory}
                  onSelectFile={(navigatorFile) => {
                    const file = Array.from(changedFiles.values()).find((candidate) => getChangedFileSelectionPath(candidate) === navigatorFile.key);
                    if (!file) return;
                    selectDiffFile(getChangedFileSelectionPath(file));
                  }}
                  renderLeading={renderChangeNavigatorLeading}
                  renderTrailing={(navigatorFile) => {
                    const file = Array.from(changedFiles.values()).find((candidate) => getChangedFileSelectionPath(candidate) === navigatorFile.key);
                    return file ? renderChangeNavigatorTrailing(file) : null;
                  }}
                  renderSubtitle={(navigatorFile) => {
                    const file = Array.from(changedFiles.values()).find((candidate) => getChangedFileSelectionPath(candidate) === navigatorFile.key);
                    return file ? renderChangeNavigatorSubtitle(file) : null;
                  }}
                  aiContent={showChangeAiMode ? ((controls) => renderChangeWalkthroughPanel(controls)) : undefined}
                  emptyContent={(
                    gitBundleLoading && changedFiles.size === 0 && gitBundleLastLoadedAt === null ? (
                      <GitChangesLoadingState slow={gitBundleSlow} />
                    ) : gitBundleError && changedFiles.size === 0 ? (
                      <GitChangesErrorState message={gitBundleError} onRetry={() => void refreshGitState()} />
                    ) : changedFiles.size === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                        {t('rightSidebar.noChanges')}
                      </div>
                    ) : filteredChangedFiles.length === 0 ? (
                      <div className="bg-surface-2 px-3 py-4 text-center text-xs text-muted-foreground">
                        {t('rightSidebar.noMatchingChanges')}
                      </div>
                    ) : null
                  )}
                  renderListHeader={(modeToggle) => rootPath && (
                    <div className="px-0 py-0">
                      {gitSummaryChips && (
                        <div className="mb-2">
                          {gitSummaryChips}
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                            {t('rightSidebar.allChanges')}
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {filteredChangedFiles.length}/{changedFiles.size}
                          </div>
                        </div>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{filteredChangedFiles.length}/{changedFiles.size}</span>
                      </div>
                      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                        {renderRepoSwitcherButton()}
                        {modeToggle}
                        {renderDiffViewTypeToggle()}
                        {changeAuditButton}
                        {diffRefreshButton}
                        <button
                          type="button"
                          onClick={toggleDiffWrap}
                          aria-pressed={diffWrap}
                          title={t('rightSidebar.wrapLongLines')}
                          className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition active:scale-95 ${
                            diffWrap
                              ? 'bg-primary/15 text-primary'
                              : 'bg-surface-2 text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          <span className="font-mono text-[12px] leading-none">Aa</span>
                          <span>{diffWrap ? t('rightSidebar.wrapOn') : t('rightSidebar.wrapOff')}</span>
                        </button>
                      </div>
                      {activeGitRepoSummary && (
                        <div className="mt-2 flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{activeGitRepoSummary.label}</span>
                          {activeGitRepoSummary.branch && <span className="max-w-[7rem] truncate rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">{activeGitRepoSummary.branch}</span>}
                          <button
                            type="button"
                            onClick={() => runRepoGitAction('stage-all', activeGitRepoSummary.root, activeGitRepoSummary.label)}
                            disabled={Boolean(runningGitAction)}
                            className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
                            title={t('rightSidebar.stageAll')}
                          >
                            {t('rightSidebar.stageAll')}
                          </button>
                          <button
                            type="button"
                            onClick={() => runRepoGitAction('stash-all', activeGitRepoSummary.root, activeGitRepoSummary.label)}
                            disabled={Boolean(runningGitAction)}
                            className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-surface-elevated disabled:opacity-50"
                            title={t('rightSidebar.stashAll')}
                          >
                            {t('rightSidebar.stashAll')}
                          </button>
                        </div>
                      )}
                      {!activeGitRepoSummary && showGitRepoFilter && (
                        <div className="mt-2 flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1.5 text-[11px] text-muted-foreground">
                          <RiGitBranch size={12} className="shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{t('rightSidebar.selectRepositoryForDiff')}</span>
                        </div>
                      )}
                    </div>
                  )}
                  files={buildDiffReviewFiles()}
                  activePane={diffPaneActive}
                  wrap={diffWrap}
                  showScrollHint={!diffWrap}
                  diffViewType={isWide ? diffViewType : 'unified'}
                  inlineMode={diffInlineMode}
                  diffOptions={diffOptions}
                  reloadKey={diffRefreshKey}
                  renderStreamBadge={(status) => <ChangeBadge status={status} />}
                  onInsertDiffReference={insertContextText}
                  onReferenceCopied={markReferenceCopied}
                  insertedReferenceKey={insertedReferenceKey}
                  copiedReferenceKey={copiedReferenceKey}
                  onClearAuditRecord={handleClearAuditRecord}
                  onDetailScroll={syncSelectionFromDiffStream}
                />
              )}
            </div>
          ))}
        </Pane>
      </div>
      {contextDraftEnabled && (
        <ContextDraftDock
          value={contextDraftText}
          collapsed={contextDraftCollapsed}
          focusRequest={draftFocusRequest}
          insertError={draftInsertFailed ? t('rightSidebar.contextDraftInsertFailed') : null}
          onChange={(next) => {
            setDraftInsertFailed(false);
            setContextDraftText(next);
          }}
          onCollapsedChange={setContextDraftCollapsed}
          onDisable={() => setContextDraftEnabled(false)}
          onClear={() => setContextDraftText('')}
          onInsert={() => sendContextDraftToTerminal(false)}
          onInsertAndSend={() => sendContextDraftToTerminal(true)}
          labels={{
            title: t('rightSidebar.contextDraftTitle'),
            hint: t('rightSidebar.contextDraftHint'),
            placeholder: t('rightSidebar.contextDraftPlaceholder'),
            collapse: t('rightSidebar.contextDraftCollapse'),
            expand: t('rightSidebar.contextDraftExpand'),
            disable: t('rightSidebar.contextDraftDisable'),
            clear: t('rightSidebar.contextDraftClear'),
            insert: t('rightSidebar.contextDraftInsert'),
            insertAndSend: t('rightSidebar.contextDraftInsertAndSend'),
            inserted: t('rightSidebar.contextDraftInserted'),
            sent: t('rightSidebar.contextDraftSent'),
            send: t('rightSidebar.contextDraftSend'),
            appended: t('rightSidebar.contextDraftAppended'),
            resize: t('rightSidebar.contextDraftResize'),
            characterCount: (count) => t('rightSidebar.contextDraftCharacterCount', { count }),
          }}
        />
      )}
        {renderRepoSwitcher()}
        {confirmGitAction && (
          <div className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm" onClick={() => setConfirmGitAction(null)}>
            <div
              className="fixed inset-x-3 bottom-[max(1.5rem,env(safe-area-inset-bottom,0px))] mx-auto max-w-md rounded-2xl border border-border/20 bg-surface-elevated p-4 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="text-sm font-semibold text-foreground">
                {confirmGitAction.kind === 'restore' ? t('rightSidebar.confirmRestoreTitle') : t('rightSidebar.confirmStashAllTitle')}
              </div>
              <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {confirmGitAction.kind === 'restore'
                  ? t('rightSidebar.confirmRestoreDescription', { path: buildFileReference(confirmGitAction.file.absolutePath, rootPath) })
                  : t('rightSidebar.confirmStashAllDescription')}
              </div>
              {confirmGitAction.kind === 'restore' && (
                <input
                  value={confirmGitAction.phrase}
                  onChange={(event) => setConfirmGitAction({ ...confirmGitAction, phrase: event.target.value })}
                  placeholder={t('rightSidebar.confirmRestorePlaceholder')}
                  className="mt-3 w-full rounded-xl border border-border/20 bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                  autoFocus
                />
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmGitAction(null)}
                  className="rounded-full bg-surface-2 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  disabled={Boolean(runningGitAction) || (confirmGitAction.kind === 'restore' && confirmGitAction.phrase.trim() !== t('rightSidebar.confirmRestorePhrase'))}
                  onClick={() => {
                    if (confirmGitAction.kind === 'restore') {
                      const repoRoot = getChangedFileRepoRoot(confirmGitAction.file, rootPath);
                      if (!repoRoot) return;
                      void runSidebarGitAction({
                        action: 'restore-worktree-file',
                        cwd: repoRoot,
                        paths: [confirmGitAction.file.path],
                        confirm: { acknowledged: true, phrase: confirmGitAction.phrase },
                      }, t('rightSidebar.restoreFile'), getChangedFileBusyPath(confirmGitAction.file));
                    } else {
                      const repoRoot = confirmGitAction.repoRoot ?? rootPath;
                      if (!repoRoot) return;
                      void runSidebarGitAction({ action: 'stash-all', cwd: repoRoot }, t('rightSidebar.stashAll'), `repo:${repoRoot}`);
                    }
                  }}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                    confirmGitAction.kind === 'restore'
                      ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90'
                  }`}
                >
                  {runningGitAction ? t('rightSidebar.gitActionRunning') : t('rightSidebar.confirmAction')}
                </button>
              </div>
            </div>
          </div>
        )}
    </Sidebar>
  );
}
