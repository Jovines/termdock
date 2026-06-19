/**
 * Shared syntax-highlighting helpers built on `refractor` (Prism core).
 *
 * Both the file preview and the diff viewer use this module so we only ever
 * load one copy of refractor. The full `refractor` build registers ~180
 * languages, but it is loaded lazily via dynamic import so it never weighs on
 * the first paint — Vite splits it into its own chunk that is fetched the first
 * time the user opens a file or a diff.
 *
 * Performance guard rails:
 *   - Highlighting is O(n) over the file text. For very large files / very
 *     long lines we bail out to plain text (`shouldHighlight`) so the sidebar
 *     never blocks the main thread tokenizing a minified bundle.
 */
import type { ReactNode } from 'react';
import { createElement } from 'react';

// Minimal shape of the refractor module we depend on. Matches refractor v2.
export interface RefractorLike {
  highlight: (value: string, language: string) => RefractorNode[];
  registered: (name: string) => boolean;
}

interface RefractorElement {
  type: 'element';
  tagName: string;
  properties: { className?: string[]; [key: string]: unknown };
  children: RefractorNode[];
}

interface RefractorText {
  type: 'text';
  value: string;
}

export type RefractorNode = RefractorElement | RefractorText;

/**
 * Skip highlighting above these limits. Plain text keeps the UI responsive for
 * minified bundles, lock files, generated code, etc.
 */
export const MAX_HIGHLIGHT_BYTES = 512 * 1024; // ~0.5 MB
export const MAX_HIGHLIGHT_LINES = 5000;
export const MAX_HIGHLIGHT_LINE_LENGTH = 2000;

/**
 * Map file extensions to Prism language ids. Only the extension matters — the
 * full refractor build knows the language once we hand it the right id. Keep
 * this list broad; an unknown extension simply renders as plain text.
 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  // Web / JS ecosystem
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', json5: 'json5', jsonc: 'json',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', styl: 'stylus',
  // Backend / systems
  py: 'python', pyw: 'python', rb: 'ruby', php: 'php',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', groovy: 'groovy', clj: 'clojure', cljs: 'clojure',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp', fs: 'fsharp', swift: 'swift', m: 'objectivec', mm: 'objectivec',
  dart: 'dart', lua: 'lua', r: 'r', jl: 'julia', ex: 'elixir', exs: 'elixir',
  erl: 'erlang', hrl: 'erlang', hs: 'haskell', ml: 'ocaml', nim: 'nim',
  pl: 'perl', pm: 'perl', d: 'd', zig: 'clike', v: 'clike',
  // Shell / config / data
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ksh: 'bash',
  ps1: 'powershell', psm1: 'powershell', bat: 'batch', cmd: 'batch',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini',
  conf: 'ini', properties: 'properties', env: 'bash',
  dockerfile: 'docker', makefile: 'makefile', mk: 'makefile',
  cmake: 'cmake', gradle: 'groovy',
  // Query / markup / docs
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  md: 'markdown', markdown: 'markdown', tex: 'latex',
  proto: 'protobuf', diff: 'diff', patch: 'diff',
  // Misc
  vim: 'vim', nginx: 'nginx', apacheconf: 'apacheconf', asm: 'asm6502',
  tf: 'hcl', hcl: 'hcl', sol: 'solidity', wasm: 'wasm', wat: 'wasm',
};

/** Filenames (lowercased, no extension) mapped directly to a language. */
const FILENAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'makefile',
  cmakelists: 'cmake',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
  '.gitconfig': 'ini',
  '.npmrc': 'ini',
};

function getBasename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

/**
 * Resolve a Prism language id from a file path, or `null` when the file type is
 * unknown (caller should render plain text).
 */
export function resolveLanguage(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const basename = getBasename(filePath).toLowerCase();

  const direct = FILENAME_LANGUAGE[basename];
  if (direct) return direct;

  const dotIndex = basename.lastIndexOf('.');
  // Dotfiles like `.bashrc` have no "extension"; handle via FILENAME_LANGUAGE.
  if (dotIndex <= 0) {
    // Files named exactly like a known extensionless type (e.g. `dockerfile`).
    return EXTENSION_LANGUAGE[basename] ?? null;
  }
  const ext = basename.slice(dotIndex + 1);
  return EXTENSION_LANGUAGE[ext] ?? null;
}

/**
 * Whether content of this size/shape is worth highlighting. Keeps the main
 * thread free for pathological inputs (minified JS, huge data files).
 */
export function shouldHighlight(content: string): boolean {
  if (content.length > MAX_HIGHLIGHT_BYTES) return false;
  let lineCount = 1;
  let lineStart = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10 /* \n */) {
      if (i - lineStart > MAX_HIGHLIGHT_LINE_LENGTH) return false;
      lineCount += 1;
      if (lineCount > MAX_HIGHLIGHT_LINES) return false;
      lineStart = i + 1;
    }
  }
  if (content.length - lineStart > MAX_HIGHLIGHT_LINE_LENGTH) return false;
  return true;
}

// Lazily loaded refractor singleton. Shared by diff + file preview.
let refractorPromise: Promise<RefractorLike> | null = null;

export function loadRefractor(): Promise<RefractorLike> {
  if (!refractorPromise) {
    refractorPromise = import('refractor')
      .then((mod) => ((mod as { default?: RefractorLike }).default ?? mod) as unknown as RefractorLike)
      .catch((err) => {
        // Reset so a later attempt can retry instead of caching the failure.
        refractorPromise = null;
        throw err;
      });
  }
  return refractorPromise;
}

/**
 * Convert refractor AST nodes into React nodes, preserving Prism token classes
 * so the existing `.token` CSS styles them. Output is escaped text — we never
 * use dangerouslySetInnerHTML.
 */
export function refractorNodesToReact(nodes: RefractorNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    if (node.type === 'text') return node.value;
    const className = node.properties?.className;
    return createElement(
      'span',
      { key, className: Array.isArray(className) ? className.join(' ') : undefined },
      refractorNodesToReact(node.children, key),
    );
  });
}

/**
 * Highlight `content` and split the result into per-line React node arrays so
 * callers can keep their own per-line DOM (line numbers, click handlers).
 *
 * The trick: refractor returns a flat AST for the whole document. We walk it
 * once and cut nodes at every `\n`, cloning any open token span across the
 * boundary so multi-line tokens (block comments, template strings) stay styled.
 */
export function highlightToLines(
  refractor: RefractorLike,
  content: string,
  language: string,
): ReactNode[][] {
  if (!refractor.registered(language)) {
    return content.split('\n').map((line) => [line || ' ']);
  }

  const ast = refractor.highlight(content, language);
  const lines: ReactNode[][] = [];
  let current: ReactNode[] = [];
  let lineIndex = 0;
  let tokenSeq = 0;

  const pushLine = () => {
    lines.push(current.length > 0 ? current : [' ']);
    current = [];
    lineIndex += 1;
  };

  const walk = (nodes: RefractorNode[], className: string | undefined) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const segments = node.value.split('\n');
        for (let s = 0; s < segments.length; s += 1) {
          if (s > 0) pushLine();
          const text = segments[s];
          if (text.length === 0) continue;
          if (className) {
            tokenSeq += 1;
            current.push(
              createElement('span', { key: `t-${lineIndex}-${tokenSeq}`, className }, text),
            );
          } else {
            current.push(text);
          }
        }
      } else {
        const nodeClass = Array.isArray(node.properties?.className)
          ? node.properties.className.join(' ')
          : undefined;
        const merged = className ? (nodeClass ? `${className} ${nodeClass}` : className) : nodeClass;
        walk(node.children, merged);
      }
    }
  };

  walk(ast, undefined);
  pushLine(); // flush trailing line
  return lines;
}
