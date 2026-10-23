import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const components = fileURLToPath(new URL('../', import.meta.url));
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sources(path) : /\.(tsx?|css)$/.test(path) && !/\.(test|browser)\./.test(path) ? [path] : [];
  });
}

it('keeps paired keyboard geometry in the shared layout primitive', () => {
  const violations = sources(components).filter(path => !path.endsWith('/layout/keyboardPanelLayout.ts'))
    .filter(path => /var\(--kb-(?:translate-y|margin-top)\b/.test(readFileSync(path, 'utf8')));
  expect(violations).toEqual([]);
});

it('keeps chat and terminal on the shared layout and focus implementation', () => {
  for (const path of ['chat/SessionChatView.tsx', 'views/TerminalView.tsx', 'MultiTerminalView.tsx']) {
    expect(readFileSync(`${components}/${path}`, 'utf8')).toContain('getKeyboardPanelStyles(');
  }
  const chat = readFileSync(`${components}/chat/SessionChatView.tsx`, 'utf8');
  expect(chat).toContain('style={keyboardLayout.contentStyle}');
  expect(chat).toContain('useKeyboardFocusGuard(input,');
  expect(chat).toContain('inputMasked &&');
});
