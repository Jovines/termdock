import { isArchitectureSourcePath } from './model';

/** Accept the explorer's copied file/line references, preserving project boundaries. */
export function relativeScopePath(value: string, rootPath: string): string | null {
  let path = value.trim().replace(/^@/, '');
  if (/^([`"']).*\1$/.test(path)) path = path.slice(1, -1);
  path = path.replace(/\\ /g, ' ').replace(/:\d+(?:-\d+)?$/, '').replace(/\/+$/, '');
  if (/^([`"']).*\1$/.test(path)) path = path.slice(1, -1);
  const root = rootPath.replace(/\/+$/, '');
  if (path.startsWith('/')) {
    if (!path.startsWith(`${root}/`)) return null;
    path = path.slice(root.length + 1);
  }
  path = path.replace(/^\.\//, '');
  return path.length <= 1024 && isArchitectureSourcePath(path) ? path : null;
}

export function parseScopePaths(text: string, rootPath: string): string[] | null {
  // Diff and selected-code references have explicit location headers. Import
  // those locations without mistaking the accompanying code for more paths.
  const headers = [...text.matchAll(/^# (.+?): hunk \d+,/gm)].map(match => match[1]);
  const values = headers.length ? headers : text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const paths = values.map(value => relativeScopePath(value, rootPath));
  if (paths.some(path => path === null)) return null;
  const unique = [...new Set(paths as string[])];
  return unique.length <= 20 ? unique : null;
}
