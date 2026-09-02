import { describe, expect, it } from 'vitest';
import { shouldComputeInlineDiff, shouldSyntaxHighlightDiff } from './diffComputationPolicy';

describe('diff computation policy', () => {
  it('keeps normal source diffs eligible for inline and syntax refinement', () => {
    const diff = `@@ -1 +1 @@\n-const value = 1;\n+const value = 2;`;

    expect(shouldComputeInlineDiff(diff)).toBe(true);
    expect(shouldSyntaxHighlightDiff(diff, 'const value = 1;')).toBe(true);
  });

  it('degrades safely for minified lines instead of locking the worker', () => {
    const minified = `+${'identifier+'.repeat(2_500)}`;

    expect(shouldComputeInlineDiff(minified)).toBe(false);
    expect(shouldSyntaxHighlightDiff(minified)).toBe(false);
  });

  it('skips syntax context when the old source itself is pathological', () => {
    const diff = `@@ -1 +1 @@\n-oldValue\n+newValue`;
    const minifiedSource = 'x'.repeat(20_001);

    expect(shouldComputeInlineDiff(diff)).toBe(true);
    expect(shouldSyntaxHighlightDiff(diff, minifiedSource)).toBe(false);
  });

  it('degrades safely when a generated diff exceeds the line budget', () => {
    const generated = Array.from({ length: 8_001 }, (_, index) => `+line${index}`).join('\n');

    expect(shouldComputeInlineDiff(generated)).toBe(false);
    expect(shouldSyntaxHighlightDiff(generated)).toBe(false);
  });

  it('degrades safely when a diff exceeds the byte budget without a pathological line', () => {
    const generated = Array.from({ length: 7_000 }, (_, index) => `+${index}:${'x'.repeat(150)}`).join('\n');

    expect(Math.max(...generated.split('\n').map((line) => line.length))).toBeLessThan(20_000);
    expect(shouldComputeInlineDiff(generated)).toBe(false);
  });

  it('skips syntax context when old source exceeds its line budget', () => {
    const diff = `@@ -1 +1 @@\n-oldValue\n+newValue`;
    const generatedSource = Array.from({ length: 20_001 }, (_, index) => `line${index}`).join('\n');

    expect(shouldComputeInlineDiff(diff)).toBe(true);
    expect(shouldSyntaxHighlightDiff(diff, generatedSource)).toBe(false);
  });
});
