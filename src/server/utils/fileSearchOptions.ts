const MAX_EXCLUDE_PATTERNS = 24;
const MAX_EXCLUDE_PATTERN_LENGTH = 240;

export function normalizeExcludePatterns(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const patterns = values
    .flatMap((entry) => typeof entry === 'string' ? entry.split(/[\n,]/) : [])
    .map((entry) => entry.trim().replace(/^!+/, '').replace(/^\.\//, ''))
    .filter((entry) => entry.length > 0 && entry.length <= MAX_EXCLUDE_PATTERN_LENGTH && !entry.includes('\0'));
  return Array.from(new Set(patterns)).slice(0, MAX_EXCLUDE_PATTERNS);
}

export function appendRipgrepExcludeArgs(args: string[], patterns: string[]): void {
  for (const pattern of patterns) {
    args.push('--glob', `!${pattern}`);
    if (!/[?*{[]/.test(pattern) && !pattern.includes('/')) {
      args.push('--glob', `!**/${pattern}/**`);
    } else if (pattern.endsWith('/')) {
      args.push('--glob', `!${pattern}**`);
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

export function createExcludeMatcher(patterns: string[]): (relativePath: string) => boolean {
  const rules = patterns.map((pattern) => ({
    pattern,
    hasSlash: pattern.includes('/'),
    hasGlob: /[?*{[]/.test(pattern),
    regexp: globToRegExp(pattern.endsWith('/') ? `${pattern}**` : pattern),
  }));
  return (relativePath: string) => {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    const segments = normalized.split('/');
    return rules.some((rule) => {
      if (!rule.hasSlash && !rule.hasGlob) return segments.includes(rule.pattern);
      if (rule.regexp.test(normalized)) return true;
      return !rule.hasSlash && rule.regexp.test(segments.at(-1) ?? normalized);
    });
  };
}
