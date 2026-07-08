import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';

export type DiffFileNavigatorMode = 'list' | 'tree';

export interface DiffNavigatorFile {
  key: string;
  path: string;
  absolutePath?: string | null;
  displayName?: string | null;
  displayDir?: string | null;
  oldPath?: string | null;
  status: string;
  title?: string | null;
}

export interface DiffNavigatorGroup {
  key: string;
  root?: string | null;
  label: string;
  branch?: string | null;
  files: DiffNavigatorFile[];
  header?: ReactNode;
  collapsed?: boolean;
}

interface DiffFileNavigatorProps {
  groups: DiffNavigatorGroup[];
  mode: DiffFileNavigatorMode;
  selectedKey?: string | null;
  compact?: boolean;
  mobile?: boolean;
  rootName?: string;
  activeGroupRoot?: string | null;
  collapsedDirectoryKeys: Set<string>;
  onToggleDirectory: (key: string) => void;
  onSelectFile: (file: DiffNavigatorFile) => void;
  renderLeading: (file: DiffNavigatorFile) => ReactNode;
  renderTrailing?: (file: DiffNavigatorFile) => ReactNode;
  renderSubtitle?: (file: DiffNavigatorFile) => ReactNode;
  getFileTreePath?: (file: DiffNavigatorFile) => string;
}

interface DiffFileTreeDirectory {
  path: string;
  name: string;
  childCount: number;
  directories: DiffFileTreeDirectory[];
  files: DiffNavigatorFile[];
}

export function DiffTreeRowShell({
  selected,
  depth = 0,
  title,
  leading,
  children,
  trailing,
  role,
  tabIndex,
  ariaExpanded,
  onClick,
  onKeyDown,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  dataAttributes,
}: {
  selected?: boolean;
  depth?: number;
  title?: string;
  leading: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  role?: string;
  tabIndex?: number;
  ariaExpanded?: boolean;
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (event: React.PointerEvent<HTMLDivElement>) => void;
  dataAttributes?: Record<string, string>;
}) {
  return (
    <div
      role={role}
      tabIndex={tabIndex}
      aria-expanded={ariaExpanded}
      title={title}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      {...dataAttributes}
      className={`group flex w-full cursor-pointer items-center gap-1 rounded px-2 py-1.5 text-left text-[13px] transition active:scale-[0.99] ${
        selected
          ? 'bg-surface-elevated text-foreground'
          : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
      }`}
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
    >
      <span className="flex w-[14px] shrink-0 items-center justify-center text-muted-foreground/80">
        {leading}
      </span>
      <span className="min-w-0 flex-1">
        {children}
      </span>
      {trailing}
    </div>
  );
}

function getFileTreePath(file: DiffNavigatorFile): string {
  return file.path.replace(/^\/+/, '');
}

function getDisplay(file: DiffNavigatorFile): { name: string; dir: string } {
  if (file.displayName !== undefined || file.displayDir !== undefined) {
    return {
      name: file.displayName || file.path,
      dir: file.displayDir || '',
    };
  }
  const parts = file.path.split('/').filter(Boolean);
  return {
    name: parts.pop() || file.path,
    dir: parts.join('/'),
  };
}

function buildDiffFileTree(files: DiffNavigatorFile[], getTreePath: (file: DiffNavigatorFile) => string): DiffFileTreeDirectory[] {
  const rootDirectories = new Map<string, DiffFileTreeDirectory>();

  const ensureDirectory = (
    directories: Map<string, DiffFileTreeDirectory>,
    name: string,
    path: string,
    parent: DiffFileTreeDirectory | null,
  ): DiffFileTreeDirectory => {
    const existing = directories.get(name);
    if (existing) return existing;
    const directory: DiffFileTreeDirectory = {
      path,
      name,
      childCount: 0,
      directories: [],
      files: [],
    };
    directories.set(name, directory);
    parent?.directories.push(directory);
    return directory;
  };

  for (const file of files) {
    const parts = getTreePath(file).split('/').filter(Boolean);
    if (parts.length <= 1) continue;
    let currentDirectories = rootDirectories;
    let parent: DiffFileTreeDirectory | null = null;
    let currentPath = '';
    for (const directoryName of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${directoryName}` : directoryName;
      const directory = ensureDirectory(currentDirectories, directoryName, currentPath, parent);
      parent = directory;
      currentDirectories = new Map(directory.directories.map((child) => [child.name, child]));
    }
    parent?.files.push(file);
  }

  const sortDirectory = (directory: DiffFileTreeDirectory): DiffFileTreeDirectory => {
    const directories = directory.directories
      .map(sortDirectory)
      .sort((a, b) => a.name.localeCompare(b.name));
    const filesInDirectory = directory.files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      ...directory,
      directories,
      files: filesInDirectory,
      childCount: directories.reduce((count, child) => count + child.childCount, 0) + filesInDirectory.length,
    };
  };

  return Array.from(rootDirectories.values()).map(sortDirectory).sort((a, b) => a.name.localeCompare(b.name));
}

function renderFileRow(
  file: DiffNavigatorFile,
  props: DiffFileNavigatorProps,
  depth = 0,
) {
  const selected = props.selectedKey === file.key || props.selectedKey === file.path || props.selectedKey === file.absolutePath;
  const display = getDisplay(file);
  return (
    <DiffTreeRowShell
      key={file.key}
      selected={selected}
      role="button"
      tabIndex={0}
      title={file.title ?? file.absolutePath ?? file.path}
      onClick={() => props.onSelectFile(file)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        props.onSelectFile(file);
      }}
      leading={props.renderLeading(file)}
      depth={depth}
      trailing={props.renderTrailing?.(file)}
      dataAttributes={{
        'data-diff-selection-path': file.key,
        'data-diff-file-path': file.path,
        'data-diff-absolute-path': file.absolutePath ?? '',
        'data-diff-status': file.status,
      }}
    >
      <span className="select-text" data-sidebar-gesture-ignore>
        <span className={`block truncate leading-snug ${selected ? 'font-medium' : ''}`}>{display.name}</span>
        {props.mode !== 'tree' && display.dir && <span className="block truncate text-[10px] text-muted-foreground/75">{display.dir}</span>}
        {props.renderSubtitle?.(file)}
      </span>
    </DiffTreeRowShell>
  );
}

function renderDirectory(
  directory: DiffFileTreeDirectory,
  groupKey: string,
  props: DiffFileNavigatorProps,
  depth: number,
): ReactNode {
  const shouldCompressDirectory = Boolean(props.mobile || props.compact);
  let displayDirectory = directory;
  const displayNames = [directory.name];
  if (shouldCompressDirectory) {
    while (displayDirectory.files.length === 0 && displayDirectory.directories.length === 1) {
      displayDirectory = displayDirectory.directories[0];
      displayNames.push(displayDirectory.name);
    }
  }
  const displayName = displayNames.join('/');
  const directoryKey = `${groupKey}:${displayDirectory.path}`;
  const collapsed = props.collapsedDirectoryKeys.has(directoryKey);
  return (
    <div key={directoryKey} className="space-y-px">
      <DiffTreeRowShell
        role="button"
        tabIndex={0}
        onClick={() => props.onToggleDirectory(directoryKey)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          props.onToggleDirectory(directoryKey);
        }}
        ariaExpanded={!collapsed}
        depth={depth}
        title={displayDirectory.path}
        leading={collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        trailing={<span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground/60 transition group-hover:text-muted-foreground">{displayDirectory.childCount}</span>}
      >
        <span className="flex min-w-0 items-center gap-1">
          <Folder size={14} className="shrink-0 text-[color:var(--folder)]" />
          <span className="min-w-0 flex-1 truncate leading-snug">{displayName}</span>
        </span>
      </DiffTreeRowShell>
      {!collapsed && (
        <div className="space-y-px">
          {displayDirectory.directories.map((child) => renderDirectory(child, groupKey, props, depth + 1))}
          {displayDirectory.files.length > 0 && (
            <div className="space-y-px">
              {displayDirectory.files.map((file) => renderFileRow(file, props, depth + 1))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function renderTreeGroup(group: DiffNavigatorGroup, props: DiffFileNavigatorProps) {
  const getTreePath = props.getFileTreePath ?? getFileTreePath;
  const rootFiles = group.files.filter((file) => getTreePath(file).split('/').filter(Boolean).length <= 1);
  const directories = buildDiffFileTree(group.files, getTreePath);
  return (
    <div className="space-y-px">
      {directories.map((directory) => renderDirectory(directory, group.key, props, 0))}
      {rootFiles.length > 0 && (
        <div className="space-y-px">
          {rootFiles.map((file) => renderFileRow(file, props))}
        </div>
      )}
    </div>
  );
}

export function flattenDiffNavigatorTree(files: DiffNavigatorFile[], getTreePath: (file: DiffNavigatorFile) => string = getFileTreePath): DiffNavigatorFile[] {
  const result: DiffNavigatorFile[] = [];
  const visit = (directory: DiffFileTreeDirectory) => {
    for (const child of directory.directories) visit(child);
    result.push(...directory.files);
  };
  for (const directory of buildDiffFileTree(files, getTreePath)) visit(directory);
  const treePaths = new Set(result.map((file) => file.key));
  result.push(...files.filter((file) => !treePaths.has(file.key)));
  return result;
}

export function DiffFileNavigator(props: DiffFileNavigatorProps) {
  return (
    <div className={props.mode === 'tree' ? 'space-y-px pt-1' : 'space-y-2'}>
      {props.groups.map((group) => {
        const showRepoHeader = Boolean(group.header);
        const collapsed = Boolean(group.collapsed);
        return (
          <section key={group.key} className={showRepoHeader ? 'overflow-hidden rounded-lg border border-border/15 bg-surface/60' : ''}>
            {group.header}
            {!collapsed && (
              <div className={props.mode === 'tree' ? (showRepoHeader ? 'space-y-px bg-surface/60 p-1' : 'space-y-px') : showRepoHeader ? 'space-y-px bg-surface/60 p-1.5' : 'space-y-px'}>
                {props.mode === 'tree'
                  ? renderTreeGroup(group, props)
                  : group.files.map((file) => renderFileRow(file, props))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
