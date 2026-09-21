import { kotlinCommentGapDiff, kotlinCommentGapSource } from './diffSyntaxFixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

const patch = `diff --git a/config.ts b/config.ts
--- a/config.ts
+++ b/config.ts
@@ -1 +1 @@
-  timeout = 1000;
+    timeout = 1500;${'  '}
`;

async function parseInWorker(language: string, whitespace = 'default', diffContent = patch, oldSource?: string) {
  vi.resetModules();
  const worker = { onmessage: undefined as undefined | ((event: unknown) => void), postMessage: vi.fn() };
  vi.stubGlobal('self', worker);
  await import('./diffWorker');
  worker.onmessage!({ data: { id: 1, diffContent, oldSource, inlineMode: 'words', language, whitespace } });
  return worker.postMessage.mock.calls[0][0];
}

afterEach(() => vi.unstubAllGlobals());

describe('diff worker inline rendering', () => {
  it('keeps inline edits when the requested syntax grammar is unavailable', async () => {
    const response = await parseInWorker('not-a-registered-grammar');
    expect(response.ok).toBe(true);
    expect(response.tokens).toHaveLength(1);
    expect(JSON.stringify(response.tokens)).toContain('"type":"edit"');
    expect(JSON.stringify(response.tokens)).toContain('1500');
  });

  it('applies the requested whitespace policy with real syntax tokenization', async () => {
    const response = await parseInWorker('typescript', 'ignore');
    expect(response.ok).toBe(true);
    const editedText: string[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if ('type' in value && value.type === 'edit' && 'children' in value) {
        editedText.push(JSON.stringify(value.children));
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(response.tokens);
    expect(editedText).toHaveLength(2);
    expect(editedText.join('')).toContain('1000');
    expect(editedText.join('')).toContain('1500');
  });
});

// Exercise the playground fixture through the real worker and syntax grammar.
describe('diff worker syntax context', () => {
  it.each([false, true])('keeps later code out of comments (complete source: %s)', async (withSource) => {
    const response = await parseInWorker('kotlin', 'default', kotlinCommentGapDiff, withSource ? kotlinCommentGapSource : undefined);
    expect(response.ok).toBe(true);
    const tokens = response.tokens[0][1];
    for (const side of ['old', 'new']) {
      const line = JSON.stringify(tokens[side][9]);
      expect(line).toContain('keyword');
      expect(line).toContain('fun');
      expect(line).not.toContain('comment');
      expect(JSON.stringify(tokens[side][0])).toContain('keyword');
      expect(JSON.stringify(tokens[side][3])).toContain('comment');
    }
    expect(JSON.stringify(tokens.new[10])).toContain('keyword');
    expect(JSON.stringify(tokens)).toContain('"type":"edit"');
  });

  it('isolates a multiline string whose closing delimiter was omitted', async () => {
    const diff = kotlinCommentGapDiff.replace('/**', 'val description = """');
    const response = await parseInWorker('kotlin', 'default', diff);
    expect(response.ok).toBe(true);
    const tokens = response.tokens[0][1];
    expect(JSON.stringify(tokens.new[9])).toContain('keyword');
    expect(JSON.stringify(tokens.new[9])).not.toContain('string');
  });

  it.each([false, true])('preserves comments across continuous hunks (complete source: %s)', async (withSource) => {
    const diff = `diff --git a/Comment.kt b/Comment.kt
--- a/Comment.kt
+++ b/Comment.kt
@@ -1,2 +1,2 @@
 /**
- * old
+ * new
@@ -3,3 +3,3 @@
- * old ending
+ * new ending
  */
 fun after() = true
`;
    const source = '/**\n * old\n * old ending\n */\nfun after() = true\n';
    const response = await parseInWorker('kotlin', 'default', diff, withSource ? source : undefined);
    expect(response.ok).toBe(true);
    for (const side of ['old', 'new']) {
      const tokens = response.tokens[0][1][side];
      expect(JSON.stringify(tokens[2])).toContain('comment');
      expect(JSON.stringify(tokens[4])).toContain('keyword');
      expect(JSON.stringify(tokens[4])).not.toContain('comment');
    }
  });
});
