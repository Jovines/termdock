import { afterEach, describe, expect, it, vi } from 'vitest';

const patch = `diff --git a/config.ts b/config.ts
--- a/config.ts
+++ b/config.ts
@@ -1 +1 @@
-  timeout = 1000;
+    timeout = 1500;${'  '}
`;

async function parseInWorker(language: string, whitespace = 'default') {
  vi.resetModules();
  const worker = { onmessage: undefined as undefined | ((event: unknown) => void), postMessage: vi.fn() };
  vi.stubGlobal('self', worker);
  await import('./diffWorker');
  worker.onmessage!({ data: { id: 1, diffContent: patch, inlineMode: 'words', language, whitespace } });
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
